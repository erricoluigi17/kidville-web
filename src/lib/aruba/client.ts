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
// Solo il TIPO: nessun accoppiamento a runtime fra il client HTTP e le regole
// fiscali. Il vocabolario delle due serie però è uno solo, e sta là.
import type { Sezionale } from '@/lib/fatturazione/sezionale'

export interface ArubaConfig {
  username?: string
  password_ref?: string
  abilitato?: boolean
  ambiente?: string
  fiscal?: Record<string, unknown>
  /**
   * Righe IVA per causale. `natura` è OBBLIGATORIA quando `aliquota` è 0 e VIETATA
   * quando è maggiore di zero: sono i due scarti SDI 00401 e 00400, che lo XSD non
   * intercetta. `riferimento_normativo` è facoltativo per lo schema, ma è ciò che
   * compare sulle fatture vere della cooperativa accanto alla natura N4 — e fino al
   * 2026-08-10 non veniva passato al generatore, quindi spariva proprio sulle righe
   * esenti configurate a mano. La regola è imposta all'ingresso da
   * `admin/settings/aruba:PATCH` e ri-verificata prima di consumare un numero.
   */
  iva?: { causale: string; aliquota: number; natura?: string; riferimento_normativo?: string }[]
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

/* ────────────────────────────────────────────────────────────────────────────
 * L'ultimo numero di una SERIE FISCALE.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * L'etichetta di un numero di fattura: `Asilo 2327/2026`, `FPR 1946/26`.
 *
 * I due sezionali scrivono l'anno in modo DIVERSO — quattro cifre l'uno, due
 * l'altro — ed è così sui documenti già trasmessi allo SdI: non è un refuso da
 * uniformare, è come si chiamano quelle fatture.
 */
const FORMA_NUMERO_SEZIONALE = /^([A-Za-z]+) (\d{1,9}) ?\/ ?(\d{2}|\d{4})$/

/** Quante pagine al massimo si scorrono. 20 × 500 = 10.000 documenti per anno. */
const PAGINE_MAX = 20
/** Quanti documenti per pagina si chiedono ad Aruba. */
const PAGINA_SIZE = 500

/**
 * ─── IL LIMITE DI ARUBA È A RAFFICA, NON A SECCHIO ORARIO ────────────────────
 * Misurato il 2026-09-02, col collaudo di sola lettura: `signin` + **7 GET
 * riuscite** in **4,2 secondi**, e la GET successiva `429`. Un tetto di «~60
 * richieste all'ora», che è quello che questo repo ha creduto fino a oggi, non
 * spiega otto chiamate accettate in quattro secondi e la nona no: quello che si
 * tocca è uno strozzamento sulla FREQUENZA, dentro una finestra breve.
 *
 * Spiega anche l'osservazione che sembrava incoerente — *un `signin`, trenta
 * secondi, un secondo `signin` → `429`*: non era il secchio quasi pieno, erano
 * due richieste troppo vicine.
 *
 * ⚠️ **Questi due numeri sono prudenza, non misura.** Il valore esatto della
 * finestra non è noto e NON si è cercato a tentativi: ogni probe consuma quota
 * e brucia il tentativo successivo, che è precisamente il modo in cui questo
 * lavoro ha perso tre ore. Si è scelto il verso che non fa danni — aspettare
 * più del necessario costa secondi, aspettare meno costa un'ora. Se qualcuno un
 * giorno misurerà la finestra vera, questi due numeri sono il posto da cambiare.
 */
const PAUSA_FRA_PAGINE_MS = 1_100
/** Quanto si aspetta dopo un `429` prima dell'unico ritentativo. */
const PAUSA_DOPO_429_MS = 90_000

const attendi = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Il progressivo dentro un'etichetta, **se e solo se** appartiene a QUESTA serie e
 * a QUEST'ANNO. Altrimenti `null`.
 *
 * ⚠️ QUI STAVA UN DIFETTO CHE VALEVA UN ILLECITO FISCALE, e vale la pena scriverlo.
 * Fino al 2026-08-09 questo pezzo faceva `String(number).replace(/[^\d]/g, '')`:
 * da `Asilo 2327/2026` ricavava `23272026` — ventitré milioni — e da `FPR 1946/26`
 * `194626`. Le due serie finivano nello stesso mucchio, il massimo era un numero
 * senza senso, e il progressivo interno ci si allineava. Nessun test era rosso:
 * l'unico che esisteva passava un numero già nudo.
 *
 * La severità è deliberata. Un'etichetta che non si riconosce vale `null`, non
 * «zero»: contarla come zero sarebbe come dire «questa serie non è mai partita»,
 * ed è esattamente l'affermazione che fa emettere un «1» su una serie che di
 * documenti ne ha duemila.
 */
export function numeroSezionaleDaEtichetta(
  etichetta: unknown,
  sezionale: Sezionale,
  anno: number,
): number | null {
  if (etichetta == null) return null
  const testo = String(etichetta).replace(/\s+/g, ' ').trim()
  const pezzi = FORMA_NUMERO_SEZIONALE.exec(testo)
  if (!pezzi) return null
  if (pezzi[1].toUpperCase() !== sezionale.toUpperCase()) return null

  const annoScritto = pezzi[3]
  const annoAtteso = annoScritto.length === 2 ? String(anno % 100).padStart(2, '0') : String(anno)
  if (annoScritto !== annoAtteso) return null

  const numero = Number(pezzi[2])
  return Number.isInteger(numero) && numero > 0 ? numero : null
}

/**
 * L'etichetta ha la FORMA di un numero di sezionale? (qualunque serie, qualunque anno)
 *
 * È una domanda diversa da quella di `numeroSezionaleDaEtichetta`, e la differenza è
 * tutto il punto del difetto qui sotto: «`Asilo 2327/2026` non appartiene alla serie
 * FPR» è un FATTO sui dati, «`2327` non si capisce» è un GUASTO del nostro parser.
 * La prima risposta si conta come zero senza rimorsi; la seconda no.
 */
function etichettaNellaFormaAttesa(etichetta: unknown): boolean {
  if (etichetta == null) return false
  return FORMA_NUMERO_SEZIONALE.test(String(etichetta).replace(/\s+/g, ' ').trim())
}

/** Quanto di un'etichetta incomprensibile si porta nel log: serve la forma, non l'elenco. */
const CAMPIONE_ETICHETTA_MAX = 40

/**
 * Le etichette dei numeri di fattura contenute in UN elemento dell'elenco.
 *
 * ─── LA FORMA VERA, MISURATA IL 2026-09-02 ──────────────────────────────────
 * `findByUsername` restituisce una PAGINA (Spring Data). I suoi elementi non sono
 * fatture: sono DOCUMENTI, con `filename`, `idSdi`, `docType`, `sender`, `receiver`.
 * Ogni documento porta le proprie fatture in un array annidato, e il numero sta lì:
 *
 *     json.content[i].invoices[j].number  ===  «Asilo 2327/2026»
 *
 * Fino a oggi questo codice leggeva `.number` sul DOCUMENTO, che quel campo non ce
 * l'ha: su 3.311 documenti del 2026 il valore era `undefined` su tutti e 3.311, e
 * l'emissione si fermava — giustamente — perché non sapeva da che numero ripartire.
 * Misura riproducibile: `node scripts/aruba-forma-elenco.mjs` (sola lettura).
 *
 * ⚠️ `invoices` è un ARRAY, e si scorre tutto. Sul campione vero conteneva sempre una
 * fattura sola, ma il tracciato FatturaPA ammette più `FatturaElettronicaBody` nello
 * stesso file: fermarsi a `[0]` sarebbe assumere di nuovo qualcosa che non è stato
 * misurato — ed è esattamente l'errore che ha prodotto questo guasto.
 *
 * ⚠️ La busta ha una chiave `number` a livello alto, ma è il NUMERO DI PAGINA
 * (`number: 0`), non un numero di fattura. Non si legge da lì.
 *
 * Il ramo `elemento.number` resta per gli elementi che SONO già una fattura: un
 * elenco senza involucro è una forma legittima, non un'ipotesi sul provider.
 */
function etichetteDellElemento(elemento: unknown): unknown[] {
  if (elemento == null || typeof elemento !== 'object') return []
  const doc = elemento as { invoices?: unknown; number?: unknown }
  if (Array.isArray(doc.invoices)) {
    return doc.invoices.map((f) => (f && typeof f === 'object' ? (f as { number?: unknown }).number : undefined))
  }
  return [doc.number]
}

/** Una pagina di `findByUsername`: i massimi, quanti documenti e quanti se ne sono CAPITI. */
interface EsitoPagina {
  /**
   * Il massimo trovato in questa pagina, **per ciascuna serie chiesta**.
   *
   * Era un intero solo, ed è diventato una mappa perché la pagina non appartiene
   * a una serie: `findByUsername` non sa cosa sia un sezionale (vedi la testata di
   * `paginaUltimoNumero`). Tenere un intero solo obbligava a riscaricare le stesse
   * pagine una volta per serie — che è il motivo per cui il collaudo prendeva `429`.
   */
  massimi: Map<Sezionale, number>
  ricevuti: number
  /** Etichette nella forma attesa, di QUALUNQUE serie e anno: quante ne abbiamo capite. */
  leggibili: number
  /** La prima etichetta che non si è saputo leggere, troncata. Vuota se non ce ne sono. */
  campione: string
  /**
   * I NOMI delle chiavi del primo elemento ricevuto.
   *
   * Serve solo quando non si capisce nulla, e serve MOLTO: il 2026-09-02 il log diceva
   * «primo valore non riconosciuto: (vuoto)» e basta, il che è vero e inutile — non dice
   * che il campo non esiste né come si chiami quello giusto. Con le chiavi in mano la
   * diagnosi sta in `app_log` e non serve andare a interrogare Aruba.
   *
   * Sono NOMI DI CAMPO, non valori: nessun dato personale. (Gli stessi elementi
   * contengono `receiver.fiscalCode` di genitori reali, che infatti non si tocca.)
   */
  chiaviPrimoElemento: string[]
}

/**
 * Una pagina di `findByUsername`, spogliata dei numeri di TUTTE le serie chieste.
 *
 * ─── LA RICHIESTA NON SA COSA SIA UN SEZIONALE ───────────────────────────────
 * Si guardi la query qui sotto: `username`, `page`, `size`, `startDate`, `endDate`,
 * al più `vatcodeSender`. **Il sezionale non c'è**, e non c'è perché Aruba non lo
 * accetta: la selezione della serie è tutta nostra, e avviene DOPO, in memoria, su
 * `numeroSezionaleDaEtichetta`. Ne segue un fatto che è costato un `429` per non
 * essere stato notato: leggere «Asilo» e leggere «FPR» scaricava **le stesse identiche
 * pagine, due volte**, per filtrarle in modo diverso. Metà delle richieste erano un
 * duplicato esatto — su una serie da 3.311 documenti, sette GET buttate.
 *
 * Perciò le serie si passano INSIEME e si spoglia la pagina una volta sola.
 */
async function paginaUltimoNumero(
  ws: string,
  accessToken: string,
  params: { username: string; anno: number; sezionali: readonly Sezionale[]; vatcodeSender?: string },
  pagina: number,
): Promise<EsitoPagina> {
  const qs = new URLSearchParams({
    username: params.username,
    page: String(pagina),
    size: String(PAGINA_SIZE),
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
  // `content` è la forma vera (pagina Spring); `invoices` in cima resta accettata perché
  // un elenco nudo è una forma legittima. In entrambi i casi gli elementi sono DOCUMENTI:
  // il numero lo estrae `etichetteDellElemento`, che scende dove serve.
  const documenti = (env.content ?? env.invoices ?? []) as unknown[]

  const massimi = new Map<Sezionale, number>(params.sezionali.map((s) => [s, 0]))
  let leggibili = 0
  let campione = ''
  /** Le CHIAVI del primo elemento: la diagnosi del prossimo cambio di forma. */
  let chiaviPrimoElemento: string[] = []
  for (const doc of documenti) {
    if (chiaviPrimoElemento.length === 0 && doc && typeof doc === 'object') {
      chiaviPrimoElemento = Object.keys(doc).sort()
    }
    for (const etichetta of etichetteDellElemento(doc)) {
      if (etichettaNellaFormaAttesa(etichetta)) leggibili++
      else if (campione === '') campione = String(etichetta ?? '(vuoto)').slice(0, CAMPIONE_ETICHETTA_MAX)
      // Una sola etichetta, confrontata con ogni serie chiesta: `numeroSezionaleDaEtichetta`
      // risponde `null` a quelle che non sono sue, ed è la stessa domanda di prima —
      // solo posta a tutte le serie invece che a una, senza riscaricare niente.
      for (const sezionale of params.sezionali) {
        const n = numeroSezionaleDaEtichetta(etichetta, sezionale, params.anno)
        if (n !== null && n > (massimi.get(sezionale) ?? 0)) massimi.set(sezionale, n)
      }
    }
  }
  return { massimi, ricevuti: documenti.length, leggibili, campione, chiaviPrimoElemento }
}

/**
 * `paginaUltimoNumero` con UN solo ritentativo dopo un `429`.
 *
 * Uno, non tre: il limite di Aruba punisce la frequenza, quindi insistere è
 * letteralmente il modo di peggiorare la situazione che si sta cercando di
 * risolvere. Se anche il secondo tentativo trova il muro, si lancia — e chi
 * emette si ferma, che è sempre la risposta giusta quando il progressivo non
 * si è potuto leggere.
 */
async function paginaConRitentativo(
  ws: string,
  accessToken: string,
  params: { username: string; anno: number; sezionali: readonly Sezionale[]; vatcodeSender?: string },
  pagina: number,
): Promise<EsitoPagina> {
  try {
    return await paginaUltimoNumero(ws, accessToken, params, pagina)
  } catch (e) {
    if ((e as { code?: unknown })?.code !== '429') throw e
    logEvento('fattura', 'warn', {
      operazione: 'aruba:findByUsername',
      provider: 'aruba',
      esito: 'limite-richieste',
      anno: params.anno,
      pagina,
      msg:
        `Aruba ha risposto 429 alla pagina ${pagina}: si attende ` +
        `${Math.round(PAUSA_DOPO_429_MS / 1000)}s e si ritenta UNA volta sola`,
    })
    await attendi(PAUSA_DOPO_429_MS)
    return await paginaUltimoNumero(ws, accessToken, params, pagina)
  }
}

/**
 * Ultimo (massimo) numero già emesso su Aruba **per quella serie e quell'anno**:
 * GET /services/invoice/out/findByUsername.
 *
 * ─── PERCHÉ SI SCORRONO LE PAGINE ────────────────────────────────────────────
 * Si chiedeva `page=1&size=500` e si prendeva il massimo di quei 500. Con una
 * serie che di documenti ne ha 2.327 — «Asilo», misurata — quel massimo è il
 * massimo di un pezzo qualunque dell'elenco, non della serie: nessuna garanzia
 * che l'API ordini per numero decrescente, e chiederlo senza saperlo sarebbe
 * inventare il comportamento del provider. Si scorre finché le pagine sono piene,
 * fino a `PAGINE_MAX`.
 *
 * ─── L'ANNO PRECEDENTE, e l'incertezza dichiarata ────────────────────────────
 * Se nell'anno richiesto non risulta NIENTE, si guarda l'anno prima. Il motivo è
 * che non sappiamo — e da questo repo non è verificabile — se le due serie
 * ripartano da 1 a gennaio o proseguano: 2.327 documenti in un anno solo, per una
 * scuola con una trentina di bambini, dicono di no. Nel dubbio si sbaglia nel
 * verso che NON produce un doppione: continuare la serie può lasciare un buco di
 * numerazione (tollerabile, e giustificabile), ricominciare da 1 su una serie
 * viva è un documento con un numero già usato.
 *
 * NON è best-effort e NON degrada: se questa chiamata fallisce, LANCIA. Chi
 * emette non deve poter proseguire «col contatore interno», perché il contatore
 * interno di una serie nata fuori da questo database può benissimo valere 0.
 *
 * ─── E NON DEGRADA NEMMENO QUANDO ARUBA RISPONDE BENE ────────────────────────
 * Fino al 2026-08-09 c'era una terza strada per arrivare a `0`, ed era la peggiore
 * perché non passava da nessun errore: Aruba rispondeva `200` con duemila documenti
 * dentro, NESSUNA etichetta superava `numeroSezionaleDaEtichetta`, e questa funzione
 * restituiva `0` — cioè «la serie non è mai partita» — facendo emettere il numero 1
 * su una serie da 2.327 documenti. Bastava che il campo `number` di `findByUsername`
 * contenesse il progressivo NUDO (`2327`) invece dell'etichetta completa
 * (`Asilo 2327/2026`): una forma che nessuno in questo repo ha mai misurato, e il
 * tracciato di riferimento (`docs/fatturazione/tracciato-di-riferimento.md`) dice
 * proprio che il numero nudo è la forma usata altrove. Un'assunzione sul formato di
 * un provider non può valere un numero di fattura.
 *
 * Ora la distinzione è esplicita e sta in `EsitoPagina.leggibili`: se sono arrivati
 * documenti e NON SE NE È CAPITO NEMMENO UNO — nessuna etichetta nella forma attesa,
 * di nessuna serie e di nessun anno — si LANCIA, come per un 5xx. Se invece le
 * etichette si leggono e semplicemente nessuna è di questa serie, `0` è una risposta
 * vera: quella serie in quell'anno non ha documenti.
 *
 * ─── E IL 2026-09-02 QUESTA GUARDIA HA SPARATO SUL SERIO ─────────────────────
 * Ha fermato un'emissione da Kidville Aversa: 3.311 documenti letti, zero etichette
 * capite. Non era un capriccio di Aruba: il campo `number` non stava dove questo
 * codice lo cercava — sta nelle fatture DENTRO il documento, e la spiegazione per
 * esteso è sulla testata di `etichetteDellElemento`. La guardia ha funzionato
 * esattamente come doveva: ha preferito non emettere niente piuttosto che emettere
 * «FPR 1/26» su una serie da millenovecento documenti. Il difetto era il parser, e
 * il fatto che si sia potuto trovare in due minuti è merito di questo errore
 * esplicito — non del silenzio che c'era prima.
 */
/**
 * ─── PERCHÉ ESISTE LA VERSIONE AL PLURALE ────────────────────────────────────
 * `arubaUltimoNumeroFattura` (qui sotto) è rimasta, e chiama questa con una serie
 * sola: tutto il codice che la usa non ha dovuto cambiare. Ma chiamarla DUE volte,
 * una per serie, scarica due volte le stesse pagine — perché la richiesta ad Aruba
 * non contiene il sezionale, vedi la testata di `paginaUltimoNumero`. Il 2026-09-02
 * il collaudo che leggeva entrambe le serie ha preso `429` esattamente lì: la prima
 * serie era passata, la seconda ha chiesto di nuovo le stesse sette pagine e Aruba
 * ha detto basta.
 *
 * Chi ha bisogno di più di una serie usi QUESTA, e le paghi una volta sola.
 */
export async function arubaUltimiNumeriFattura(
  ambiente: string | undefined,
  accessToken: string,
  params: { username: string; anno: number; sezionali: readonly Sezionale[]; vatcodeSender?: string }
): Promise<Map<Sezionale, number>> {
  const { ws } = arubaBaseUrls(ambiente)
  const elencoSerie = params.sezionali.join('/')

  /**
   * Il ritmo si tiene sull'INTERA chiamata, non per anno né per serie: ad Aruba non
   * importa da quale ciclo `for` del nostro codice esca una richiesta, importa quanto
   * sono vicine fra loro. La prima non aspetta — sarebbe attesa buttata.
   */
  let primaRichiesta = true
  const pagina = async (anno: number, sezionali: readonly Sezionale[], n: number): Promise<EsitoPagina> => {
    if (!primaRichiesta) await attendi(PAUSA_FRA_PAGINE_MS)
    primaRichiesta = false
    return await paginaConRitentativo(ws, accessToken, { ...params, anno, sezionali }, n)
  }

  /**
   * L'errore del formato incomprensibile. `name` a sé perché `get_runtime_errors` di
   * Vercel raggruppa per *error name*: questo non è un guasto di Aruba, è il nostro
   * parser che non riconosce più ciò che Aruba manda, e va visto come categoria
   * propria. `code` non è uno status HTTP — la risposta era `200` — quindi dice cosa
   * è successo, non un numero che non esiste.
   */
  const erroreEtichette = (anno: number, ricevuti: number, campione: string, chiavi: string[]): Error => {
    const err = new Error(
      `Aruba findByUsername: ${ricevuti} documenti nell'anno ${anno} e nessuna etichetta nella forma attesa ` +
        `«${elencoSerie} <numero>/<anno>» (primo valore non riconosciuto: «${campione}»). ` +
        // Le CHIAVI del primo elemento, non i valori: il 2026-09-02 il messaggio diceva
        // solo «(vuoto)», che è vero e inutile — non distingue «il campo è vuoto» da «il
        // campo non esiste più», e la seconda era la risposta giusta. Con l'elenco dei
        // nomi, chi legge il log vede subito dov'è finito il numero.
        (chiavi.length ? `Chiavi del primo elemento: ${chiavi.join(', ')}. ` : '') +
        'Il progressivo NON è stato letto: emettere adesso significherebbe ripartire da 1 su una serie viva.',
    )
    err.name = 'ArubaNumerazioneError'
    Object.assign(err, { code: 'etichette-illeggibili' })
    return err
  }

  const massimiDellAnno = async (anno: number, serie: readonly Sezionale[]): Promise<Map<Sezionale, number>> => {
    const massimi = new Map<Sezionale, number>(serie.map((s) => [s, 0]))
    let ricevutiTotali = 0
    let leggibiliTotali = 0
    let campione = ''
    let chiavi: string[] = []
    /** Vero solo se sono arrivati documenti e non se n'è riconosciuto nemmeno uno. */
    const nessunaEtichettaCapita = () => ricevutiTotali > 0 && leggibiliTotali === 0
    for (let n = 1; n <= PAGINE_MAX; n++) {
      const { massimi: massimiPagina, ricevuti, leggibili, campione: campionePagina, chiaviPrimoElemento } =
        await pagina(anno, serie, n)
      for (const s of serie) {
        const trovato = massimiPagina.get(s) ?? 0
        if (trovato > (massimi.get(s) ?? 0)) massimi.set(s, trovato)
      }
      ricevutiTotali += ricevuti
      leggibiliTotali += leggibili
      if (campione === '' && campionePagina !== '') campione = campionePagina
      if (chiavi.length === 0 && chiaviPrimoElemento.length > 0) chiavi = chiaviPrimoElemento
      if (ricevuti < PAGINA_SIZE) {
        if (nessunaEtichettaCapita()) throw erroreEtichette(anno, ricevutiTotali, campione, chiavi)
        return massimi
      }
      if (n === PAGINE_MAX) {
        // Il tetto è stato toccato: l'elenco continua e noi smettiamo di guardarlo.
        // `warn` e non `error` perché il numero che restituiamo resta un limite
        // INFERIORE valido (il progressivo non torna indietro), ma se questa riga
        // compare la finestra va allargata prima che il massimo vero ci sfugga.
        logEvento('fattura', 'warn', {
          operazione: 'aruba:findByUsername',
          provider: 'aruba',
          esito: 'pagine-troncate',
          anno,
          msg: `Aruba findByUsername: superate ${PAGINE_MAX} pagine da ${PAGINA_SIZE} per le serie ${serie.join('/')}; il massimo letto potrebbe non essere l'ultimo`,
        })
      }
    }
    if (nessunaEtichettaCapita()) throw erroreEtichette(anno, ricevutiTotali, campione, chiavi)
    return massimi
  }

  const massimi = await massimiDellAnno(params.anno, params.sezionali)

  // L'anno prima si guarda SOLO per le serie rimaste a zero, e solo se ce n'è
  // qualcuna: se «Asilo» ha documenti quest'anno e «FPR» no, non ha senso
  // riscaricare il 2025 anche per «Asilo». Il criterio resta quello di prima —
  // «zero in questo anno» — applicato serie per serie invece che al mucchio.
  const senzaDocumenti = params.sezionali.filter((s) => (massimi.get(s) ?? 0) === 0)
  if (senzaDocumenti.length === 0) return massimi

  const precedenti = await massimiDellAnno(params.anno - 1, senzaDocumenti)
  for (const s of senzaDocumenti) massimi.set(s, precedenti.get(s) ?? 0)
  return massimi
}

/**
 * L'ultimo numero di UNA serie. Involucro su `arubaUltimiNumeriFattura`.
 *
 * Resta perché è quello che serve a chi emette una fattura sola, ed è la firma che
 * tutto il resto del repo già usa. ⚠️ Chiamarla due volte per due serie costa il
 * doppio delle richieste ad Aruba **per gli stessi identici dati**: se le serie sono
 * più d'una, si usi la versione al plurale.
 */
export async function arubaUltimoNumeroFattura(
  ambiente: string | undefined,
  accessToken: string,
  params: { username: string; anno: number; sezionale: Sezionale; vatcodeSender?: string }
): Promise<number> {
  const massimi = await arubaUltimiNumeriFattura(ambiente, accessToken, {
    ...params,
    sezionali: [params.sezionale],
  })
  return massimi.get(params.sezionale) ?? 0
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
