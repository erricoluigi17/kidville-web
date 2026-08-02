/**
 * Aruba — client REST reale per la Fatturazione Elettronica (SDI).
 *
 * Integrazione REALE (DL-017): autenticazione OAuth-like (Bearer token),
 * upload del tracciato FatturaPA (base64), polling stato/notifiche SDI.
 * Le credenziali NON transitano mai dal client: username dal config,
 * password risolta lato server da `process.env` via `password_ref` (vault/env).
 *
 * Doc ufficiale: https://fatturazioneelettronica.aruba.it/apidoc/docs_EN.html
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL CORPO DELL'ERRORE DEL PROVIDER NON SI BUTTA VIA (AGENTS.md, regola 3, che nomina
 * «Aruba/SDI» per nome).
 *
 * Fino al 2026-08-02 questo file faceva SEI `fetch` a mano e lanciava
 * `new Error(\`Aruba signin fallita (HTTP ${res.status})\`)`: in `app_log` restava il numero e
 * basta. È, alla lettera, la scena del delitto delle email di credenziali — per mesi nessuna
 * arrivò a un genitore perché Resend rispondeva `403` e il codice registrava soltanto il
 * numero, mentre il corpo diceva «the kidville.it domain is not verified». `401` non distingue
 * una password ruotata da un ambiente sbagliato; `401 {"errorDescription":"Invalid username or
 * password"}` chiude il caso in cinque minuti.
 *
 * Il file è nato a GIUGNO, prima che `src/lib/logging/external.ts` esistesse (luglio), e non
 * era mai stato ricondotto al modulo. Nessun test era rosso, che è la firma della categoria:
 * ora il lock è `__tests__/architecture/provider-esterni-osservati.test.ts` (nessuna chiamata a
 * un host di terze parti fuori da `externalFetch`) e il comportamento è in
 * `__tests__/lib/aruba/client-corpo-provider.test.ts`.
 *
 * DUE CONTRATTI CHE NON CAMBIANO, e vanno letti insieme:
 *  · `externalFetch` NON LANCIA MAI (è il suo contratto: un guasto dell'osservabilità non può
 *    diventare un guasto del prodotto). Queste funzioni invece SÌ, come prima: chi le chiama
 *    (`emissione.ts`, `fattura/sync`) ha già i suoi `try/catch` e i suoi log, e trasformarle in
 *    funzioni che ritornano un esito silenzioso sposterebbe il difetto invece di chiuderlo.
 *  · l'evento di dominio è `fattura`, non il default `esterno`: è in `EVENTI_PERSISTITI`,
 *    quindi anche il SUCCESSO finisce in tabella (regola 5) e una sola query —
 *    `where evento = 'fattura'` — racconta sia gli invii riusciti sia i rifiuti.
 * ─────────────────────────────────────────────────────────────────────────────────
 */
import { externalFetch, type EsitoEsterno } from '@/lib/logging/external'
import { logEvento } from '@/lib/logging/logger'

export interface ArubaConfig {
  username?: string
  password_ref?: string
  abilitato?: boolean
  ambiente?: string
  fiscal?: Record<string, unknown>
  iva?: { causale: string; aliquota: number; natura?: string }[]
}

export interface ArubaCredentials {
  username: string
  password: string
}

export interface ArubaTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number // epoch ms
}

export interface ArubaUploadResult {
  ok: boolean
  uploadFileName?: string
  errorCode: string
  errorDescription?: string
}

export interface ArubaInvoiceStatus {
  stato: number // 1..10 (vedi stato.ts)
  pdfBase64?: string | null
  raw?: unknown
}

/** Base URL per ambiente: DEMO (default) o PRODUCTION. */
export function arubaBaseUrls(ambiente?: string): { auth: string; ws: string } {
  if (ambiente === 'production' || ambiente === 'produzione') {
    return {
      auth: 'https://auth.fatturazioneelettronica.aruba.it',
      ws: 'https://ws.fatturazioneelettronica.aruba.it',
    }
  }
  return {
    auth: 'https://demoauth.fatturazioneelettronica.aruba.it',
    ws: 'https://demows.fatturazioneelettronica.aruba.it',
  }
}

/**
 * Risolve le credenziali lato server. La password viene letta da `process.env`
 * usando il nome indicato in `password_ref` (oppure dal fallback ARUBA_PASSWORD);
 * lo username dal config (o ARUBA_USERNAME). Ritorna null se incompleto.
 */
export function resolveArubaCredentials(config: ArubaConfig): ArubaCredentials | null {
  const username = config.username || process.env.ARUBA_USERNAME
  const password =
    (config.password_ref ? process.env[config.password_ref] : undefined) || process.env.ARUBA_PASSWORD
  if (!username || !password) return null
  return { username, password }
}

/* ────────────────────────────────────────────────────────────────────────────
 * L'osservazione: una sola porta verso il provider.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Quanto corpo di una risposta 2xx ILLEGGIBILE ci si porta nel log.
 *
 * Non è la stessa cosa del corpo d'errore, che `externalFetch` gestisce già: qui si parla di
 * una risposta RIUSCITA che non si è potuta interpretare, e il corpo di una risposta riuscita
 * di Aruba può contenere il PDF della fattura in base64 (`getByFilename` con `includePdf`).
 * Serve la FORMA del guasto («è HTML», «è un array»), non il contenuto: 200 caratteri bastano
 * a riconoscere una pagina di manutenzione e non bastano a versare un documento nei log.
 */
const CORPO_DIAGNOSI_MAX = 200

/**
 * `fetch` verso Aruba, osservato: provider, evento di dominio e operazione parlante.
 *
 * `'aruba'` e `'fattura'` sono scritti PER ESTESO qui e in ogni `logEvento` del file, invece
 * che estratti in due costanti come verrebbe naturale. Non è ripetizione per distrazione: i
 * lock di questo repo scandiscono il SORGENTE, non il grafo dei moduli — `eventi-log.test.ts`
 * cerca `logEvento('<nome>'` col nome LETTERALE, `provider-esterni-osservati.test.ts` cerca il
 * nome del provider. Dietro una costante il vocabolario chiuso degli eventi non vedrebbe
 * queste righe, e un domani quella costante potrebbe diventare un nome fuori elenco senza che
 * nessun test se ne accorga. Una costante che rende invisibile una regola costa più di quanto
 * risparmi.
 */
function chiamaAruba(operazione: string, url: string, init: RequestInit): Promise<EsitoEsterno> {
  // `campi.operazione` sovrascrive il default di `externalFetch` (il pattern del path): sulla
  // riga si legge `aruba:signin` invece di `/auth/signin`, ed è ciò che dice DI COSA si parla.
  return externalFetch('aruba', url, init, { evento: 'fattura', campi: { operazione } })
}

/**
 * L'errore che sale al chiamante, col MOTIVO del provider dentro.
 *
 * `code` (e quindi la colonna `app_log.codice`) è lo status, così `where codice = '401'` si può
 * fare; `name` proprio perché `get_runtime_errors` di Vercel raggruppa per *error name* e gli
 * errori del provider stanno nel loro secchio invece di mescolarsi ai bug veri del codice.
 * Quando una risposta non c'è stata affatto il codice è `rete`: uno `0` nella colonna degli
 * status HTTP sarebbe uno status che non esiste.
 */
function erroreAruba(operazione: string, esito: EsitoEsterno): Error {
  const dettaglio = esito.corpo === '' ? '(nessun corpo nella risposta)' : esito.corpo
  const err = new Error(
    esito.stato === 0
      ? `Aruba ${operazione}: nessuna risposta dal provider — ${dettaglio}`
      : `Aruba ${operazione} fallita (HTTP ${esito.stato}): ${dettaglio}`,
  )
  err.name = 'ArubaHttpError'
  Object.assign(err, { code: esito.stato === 0 ? 'rete' : String(esito.stato) })
  return err
}

/** Cosa NON andava in una risposta 2xx: `null` = andava tutto bene. */
type ProblemaCorpo = 'vuoto' | 'non-json' | 'non-oggetto' | null

interface LetturaCorpo {
  oggetto: Record<string, unknown>
  problema: ProblemaCorpo
  /** Il testo grezzo, troncato: serve solo alla diagnosi, e solo quando `problema` non è null. */
  testo: string
}

/**
 * Interpreta il corpo di una risposta RIUSCITA. Non lancia e non logga: RIPORTA il problema,
 * così chi chiama sa distinguere «corpo vuoto» da «corpo illeggibile» — che è la distinzione
 * che il vecchio `readJson` cancellava con un `catch { return {} }`, restituendo lo stesso
 * oggetto vuoto in tre casi diversi (200 muto, HTML di un proxy, JSON che è un array).
 */
function analizzaCorpo(grezzo: string): LetturaCorpo {
  const testo = grezzo.trim()
  if (testo === '') return { oggetto: {}, problema: 'vuoto', testo: '' }
  const breve = testo.length > CORPO_DIAGNOSI_MAX ? `${testo.slice(0, CORPO_DIAGNOSI_MAX - 1)}…` : testo
  let valore: unknown
  try {
    valore = JSON.parse(testo)
  } catch {
    // Non è un catch muto: il motivo torna al chiamante nel campo `problema`, e da lì va nel
    // log con il corpo. `JSON.parse` non porta informazione oltre «non è JSON».
    return { oggetto: {}, problema: 'non-json', testo: breve }
  }
  if (valore === null || typeof valore !== 'object' || Array.isArray(valore)) {
    return { oggetto: {}, problema: 'non-oggetto', testo: breve }
  }
  return { oggetto: valore as Record<string, unknown>, problema: null, testo: '' }
}

/**
 * Il corpo di una risposta 2xx, letto e — se qualcosa non torna — DICHIARATO.
 *
 * `warn` e non `error`: il chiamante prosegue con i campi mancanti (uno stato SDI `0`, un
 * progressivo `0`), quindi il prodotto non si ferma. Ma non può passare in silenzio: senza
 * questa riga «Aruba ha risposto 200 senza dire niente» e «Aruba ha detto stato 0» sono lo
 * stesso dato per chi legge, e il secondo è un fatto mentre il primo è un guasto.
 */
async function leggiCorpoJson(res: Response | undefined, operazione: string): Promise<Record<string, unknown>> {
  if (!res) return {}
  let grezzo: string
  try {
    grezzo = await res.text()
  } catch (e) {
    logEvento('fattura', 'warn', {
      operazione,
      provider: 'aruba',
      esito: 'corpo-illeggibile',
      msg: `Aruba ${operazione}: risposta 2xx con corpo non leggibile`,
    }, e)
    return {}
  }

  const lettura = analizzaCorpo(grezzo)
  if (lettura.problema === null) return lettura.oggetto

  logEvento('fattura', 'warn', {
    operazione,
    provider: 'aruba',
    // `esito` è in lista bianca: i tre casi restano distinguibili anche nella riga persistita,
    // che è l'unica che si interroga in SQL trenta giorni dopo.
    esito: `corpo-${lettura.problema}`,
    msg:
      lettura.problema === 'vuoto'
        ? `Aruba ${operazione}: risposta 2xx con corpo vuoto`
        : `Aruba ${operazione}: risposta 2xx non interpretabile (${lettura.problema}): ${lettura.testo}`,
  })
  return lettura.oggetto
}

/** L'envelope di Aruba dentro un corpo d'ERRORE già letto da `externalFetch`. */
function envelopeDelRifiuto(corpo: string): Record<string, unknown> {
  const lettura = analizzaCorpo(corpo)
  const env = (lettura.oggetto.value as Record<string, unknown>) ?? lettura.oggetto
  return env
}

/* ────────────────────────────────────────────────────────────────────────────
 * Le sei chiamate.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Autenticazione: POST /auth/signin (grant_type=password). */
export async function arubaSignin(ambiente: string | undefined, creds: ArubaCredentials): Promise<ArubaTokens> {
  const { auth } = arubaBaseUrls(ambiente)
  const body = new URLSearchParams({
    grant_type: 'password',
    username: creds.username,
    password: creds.password,
  }).toString()
  // La PASSWORD è qui dentro: `externalFetch` osserva la RISPOSTA, mai la richiesta. Il test
  // `LA PASSWORD ARUBA NON ESCE MAI` è ciò che impedisce a un domani "comodo" di loggare `init`.
  const esito = await chiamaAruba('aruba:signin', `${auth}/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!esito.ok) throw erroreAruba('signin', esito)
  const json = await leggiCorpoJson(esito.res, 'aruba:signin')
  return {
    accessToken: String(json.access_token ?? ''),
    refreshToken: String(json.refresh_token ?? ''),
    expiresAt: Date.now() + Number(json.expires_in ?? 1700) * 1000,
  }
}

/** Rinnovo token: POST /auth/signin (grant_type=refresh_token). */
export async function arubaRefresh(ambiente: string | undefined, refreshToken: string): Promise<ArubaTokens> {
  const { auth } = arubaBaseUrls(ambiente)
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString()
  const esito = await chiamaAruba('aruba:refresh', `${auth}/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!esito.ok) throw erroreAruba('refresh', esito)
  const json = await leggiCorpoJson(esito.res, 'aruba:refresh')
  return {
    accessToken: String(json.access_token ?? ''),
    refreshToken: String(json.refresh_token ?? refreshToken),
    expiresAt: Date.now() + Number(json.expires_in ?? 1700) * 1000,
  }
}

/**
 * Upload del tracciato FatturaPA (non firmato; Aruba firma CAdES e invia allo SDI).
 *
 * L'UNICA che non lancia su un rifiuto HTTP, ed è deliberato: il chiamante scrive a registro
 * una riga `fatture_emesse` con `sdi_stato: 2` e il motivo. Perché quel motivo sia leggibile,
 * l'envelope si cerca ANCHE nel corpo d'errore — e se il corpo non è JSON (la pagina di
 * manutenzione di un proxy) ci finisce comunque il corpo, non la stringa «500».
 *
 * Su una risposta MANCANTE (rete giù, DNS, TLS) invece si lancia, come faceva il `fetch` prima:
 * una fattura che non è nemmeno partita non deve finire a registro come «scartata da Aruba».
 * La distinzione ha una conseguenza fiscale, non estetica.
 */
export async function arubaUpload(
  ambiente: string | undefined,
  accessToken: string,
  params: { dataFileBase64: string; senderPIVA: string }
): Promise<ArubaUploadResult> {
  const { ws } = arubaBaseUrls(ambiente)
  const esito = await chiamaAruba('aruba:upload', `${ws}/services/invoice/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: JSON.stringify({
      dataFile: params.dataFileBase64,
      senderPIVA: params.senderPIVA,
      skipExtraSchema: false,
    }),
  })
  if (esito.stato === 0) throw erroreAruba('upload', esito)

  if (!esito.ok) {
    const env = envelopeDelRifiuto(esito.corpo)
    return {
      ok: false,
      errorCode: String(env.errorCode ?? esito.stato),
      // Il corpo grezzo come ripiego: è ciò che finisce in `fatture_emesse.sdi_scarto_motivo`
      // e sotto gli occhi della segreteria. «500» non le dice se richiamare o riprovare.
      errorDescription: env.errorDescription
        ? String(env.errorDescription)
        : `HTTP ${esito.stato}: ${esito.corpo === '' ? '(nessun corpo nella risposta)' : esito.corpo}`,
    }
  }

  const json = await leggiCorpoJson(esito.res, 'aruba:upload')
  const env = (json.value as Record<string, unknown>) ?? json
  const errorCode = String(env.errorCode ?? '0000')
  return {
    ok: errorCode === '0000',
    uploadFileName: env.uploadFileName ? String(env.uploadFileName) : undefined,
    errorCode,
    errorDescription: env.errorDescription ? String(env.errorDescription) : undefined,
  }
}

/** Stato di una fattura inviata: GET /services/invoice/out/getByFilename. */
export async function arubaGetByFilename(
  ambiente: string | undefined,
  accessToken: string,
  filename: string,
  opts?: { includePdf?: boolean }
): Promise<ArubaInvoiceStatus> {
  const { ws } = arubaBaseUrls(ambiente)
  const qs = new URLSearchParams({
    filename,
    includePdf: String(opts?.includePdf ?? true),
    includeFile: 'false',
  }).toString()
  const esito = await chiamaAruba('aruba:getByFilename', `${ws}/services/invoice/out/getByFilename?${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!esito.ok) throw erroreAruba('getByFilename', esito)
  const json = await leggiCorpoJson(esito.res, 'aruba:getByFilename')
  const env = (json.value as Record<string, unknown>) ?? json
  const stato = Number(env.status ?? env.stato ?? 0)
  const pdf = (env.pdfFile ?? env.pdf ?? null) as string | null
  return { stato, pdfBase64: pdf, raw: json }
}

/**
 * Ultimo (massimo) numero di fattura EMESSA su Aruba per l'anno indicato:
 * GET /services/invoice/out/findByUsername. Serve ad allineare il progressivo
 * interno ed evitare collisioni con fatture emesse anche fuori dalla web app.
 * Best-effort: il chiamante degrada al contatore locale se questa fallisce.
 * NB il `number` è una stringa: si estrae la parte numerica e si prende il max.
 */
export async function arubaUltimoNumeroFattura(
  ambiente: string | undefined,
  accessToken: string,
  params: { username: string; anno: number; vatcodeSender?: string }
): Promise<number> {
  const { ws } = arubaBaseUrls(ambiente)
  const qs = new URLSearchParams({
    username: params.username,
    page: '1',
    size: '500',
    startDate: `${params.anno}-01-01`,
    endDate: `${params.anno}-12-31`,
  })
  if (params.vatcodeSender) qs.set('vatcodeSender', params.vatcodeSender)
  // `username` (un indirizzo email) sta nella QUERY: `externalFetch` logga solo il `pathname`,
  // mai la query string. È il motivo per cui l'URL intero non finisce mai su una riga.
  const esito = await chiamaAruba(
    'aruba:findByUsername',
    `${ws}/services/invoice/out/findByUsername?${qs.toString()}`,
    { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!esito.ok) throw erroreAruba('findByUsername', esito)
  const json = await leggiCorpoJson(esito.res, 'aruba:findByUsername')
  const env = (json.value as Record<string, unknown>) ?? json
  const invoices = (env.invoices ?? env.content ?? []) as { number?: string | number | null }[]
  let max = 0
  for (const inv of invoices) {
    const n = parseInt(String(inv.number ?? '').replace(/[^\d]/g, ''), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max
}

/** Notifiche SDI relative a una fattura inviata. */
export async function arubaGetNotifications(
  ambiente: string | undefined,
  accessToken: string,
  filename: string
): Promise<unknown> {
  const { ws } = arubaBaseUrls(ambiente)
  const qs = new URLSearchParams({ filename }).toString()
  const esito = await chiamaAruba(
    'aruba:notifiche',
    `${ws}/services/notification/out/getByInvoiceFilename?${qs}`,
    { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!esito.ok) throw erroreAruba('notifiche', esito)
  return leggiCorpoJson(esito.res, 'aruba:notifiche')
}
