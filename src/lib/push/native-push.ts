import crypto from 'node:crypto'
import { externalFetch } from '@/lib/logging/external'
import { logEvento } from '@/lib/logging/logger'
import { descriviErrore } from '@/lib/logging/serialize'
import { CANALE_ANDROID_NOTIFICHE } from './canale-android'

// =============================================================================
// Push NATIVE (Capacitor iOS/Android) via Firebase Cloud Messaging HTTP v1.
//
// GATED sulle credenziali service-account Firebase (FCM_PROJECT_ID /
// FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY). Senza credenziali NON lancia: degrada
// come web-push.ts (pattern M2) restituendo { ok:false, error:'fcm_non_configurato' }.
// Il token nativo viene comunque registrato lato subscribe, cosi' che appena FCM
// sara' configurato le nuove notifiche partiranno.
//
// Copertura: Android (token FCM) e iOS (token FCM, con la APNs Auth Key caricata
// dentro Firebase — vedi docs/mobile.md). L'egress reale e' subordinato a un
// progetto Firebase accreditato: la verifica live e' a carico del committente.
// =============================================================================

export type NativePlatform = 'ios' | 'android'

/** true se le credenziali FCM sono presenti (la push nativa e' inviabile). */
export function fcmConfigured(): boolean {
  return Boolean(
    process.env.FCM_PROJECT_ID &&
      process.env.FCM_CLIENT_EMAIL &&
      process.env.FCM_PRIVATE_KEY
  )
}

export interface NativePushPayload {
  title: string
  body?: string
  url?: string
  tag?: string
  /**
   * Il numero sull'icona dell'app su iOS: le notifiche NON LETTE del destinatario, calcolate da
   * chi chiama. Finisce in `apns.payload.aps.badge`. Assente → il badge non si tocca (APNs lascia
   * quello che c'era). `0` è un valore vero: azzera il numero. Un valore non intero o negativo
   * si scarta, invece di mandare ad APNs un payload che rifiuterebbe.
   */
  badge?: number
}

/**
 * L'esito di un invio a UN dispositivo. Tre forme, e chi chiama deve distinguerle tutte:
 *
 * - `ok: true` — consegnata a FCM (eventualmente dopo uno o due ritentativi).
 * - `ok: false, gone: true` — DEFINITIVO: il token non esiste più (app disinstallata, token
 *   ruotato). La subscription va rimossa, come prima.
 * - `ok: false, ritentabile` — un rifiuto con il suo `error` (il corpo di FCM, mai il solo
 *   status). `ritentabile: true` dice che il guasto è transitorio (5xx, timeout, rete, `429`,
 *   anche dell'endpoint OAuth) e che la notifica ha senso riprovarla più tardi: i ritentativi
 *   IMMEDIATI qui dentro sono già stati spesi. `ritentabile: false` è un rifiuto che riprovare
 *   non cambia (payload rifiutato, `SenderId mismatch`, credenziali rotte: chiave PEM
 *   malformata, OAuth `400`/`401`/`403` come `invalid_grant`, `200` senza `access_token`) — ma NON è `gone`:
 *   la subscription è sana, cancellarla sarebbe il danno sopra il guasto.
 */
export interface EsitoNativePush {
  ok: boolean
  gone?: boolean
  error?: string
  /** Solo su `ok: false` e non `gone`: vedi sopra. */
  ritentabile?: boolean
  /** Quante chiamate a `messages:send` sono state fatte (0 se non si è arrivati alla rete). */
  tentativi?: number
  /**
   * Solo su un `429` con un `Retry-After` più lungo di quanto si aspetta qui dentro
   * (`ATTESA_MAX_MS`): quanti millisecondi FCM chiede di aspettare prima di riprovare.
   */
  ritentaDopoMs?: number
}

/** Opzioni del singolo invio. */
export interface OpzioniNativePush {
  /**
   * Quanti ritentativi IMMEDIATI al massimo (0, 1 o 2; predefinito 2). Esiste per chi ha un
   * budget di tempo suo — un giro di dispatch con molti dispositivi — e preferisce lasciare la
   * notifica in coda piuttosto che aspettare qui.
   */
  maxRitentativi?: number
}

/**
 * Le attese prima di ciascun ritentativo immediato, in millisecondi: 1 s prima del primo, 3 s
 * prima del secondo. Due ritentativi al massimo (spec 24/09: «1–2 ritentativi immediati»).
 * Misurato su 7 giorni: lo 0,14% degli invii falliva con `500` o per timeout, e nessuno veniva
 * mai ritentato — la notifica era persa.
 */
export const ATTESE_RITENTATIVO_MS: readonly number[] = [1_000, 3_000]

/**
 * Il massimo che si aspetta QUI DENTRO su un `429` con `Retry-After`. Oltre, non si blocca il
 * giro di dispatch: si restituisce `ritentabile` con `ritentaDopoMs` e decide chi chiama.
 */
export const ATTESA_MAX_MS = 10_000

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

/**
 * Quanto corpo illeggibile ci si porta dietro nel log. Trecento caratteri: quel che basta a
 * riconoscere una pagina HTML di un proxy o il messaggio di un gateway — non un dump.
 */
const CORPO_LOG_MAX = 300

// Cache per-processo dell'access token OAuth (validita' ~1h).
let cachedToken: { value: string; expiresAt: number } | null = null

/**
 * L'esito della richiesta del token OAuth: il token, oppure PERCHÉ non c'è.
 *
 * Prima era `string | null`, e il `null` non diceva niente: `sendNativePush` restituiva sempre
 * `ritentabile: true`, anche quando Google aveva risposto `400 invalid_grant` (chiave revocata,
 * service account disabilitato). Nello stesso file la chiave PEM malformata andava a `false`:
 * due guasti di credenziali, due classificazioni opposte — e la coda del chiamante avrebbe
 * tenuto e ritentato per mezz'ora notifiche che nessun ritentativo può consegnare.
 *
 * `ritentabile` segue la stessa regola dell'invio (`erroreRitentabile`): vero per nessuna
 * risposta, `429` e `5xx` dell'endpoint OAuth, e per un corpo di `200` che non si è potuto
 * leggere o che JSON non è (connessione caduta, pagina di un gateway o di un proxy: roba di
 * rete, non delle nostre credenziali); falso per `400`/`401`/`403` e per un `200` senza
 * `access_token`, che riprovare non cambia.
 */
type EsitoToken = { token: string } | { token?: undefined; ritentabile: boolean }

async function getAccessToken(): Promise<EsitoToken> {
  const nowSec = Math.floor(Date.now() / 1000)
  if (cachedToken && cachedToken.expiresAt - 60 > nowSec) return { token: cachedToken.value }

  const clientEmail = process.env.FCM_CLIENT_EMAIL as string
  // Negli env la private key ha spesso i newline "escaped" (\n): normalizziamo.
  const privateKey = String(process.env.FCM_PRIVATE_KEY).replace(/\\n/g, '\n')

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const claim = Buffer.from(
    JSON.stringify({
      iss: clientEmail,
      scope: FCM_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    })
  ).toString('base64url')
  const signingInput = `${header}.${claim}`
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(privateKey)
    .toString('base64url')
  const assertion = `${signingInput}.${signature}`

  // Il rifiuto di Google diceva soltanto lo status ("OAuth token FCM fallito: 400") — cioè
  // nulla: è il corpo a distinguere una chiave revocata da un clock sfasato da un service
  // account senza permessi. Ora lo legge e lo logga `externalFetch`, che non lo butta via.
  const esito = await externalFetch(
    'fcm',
    OAUTH_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    },
    { evento: 'push', campi: { operazione: 'oauth-token' } }
  )
  const risposta = esito.res
  // Il rifiuto (col corpo di Google) l'ha già loggato `externalFetch`: qui si decide solo se
  // riprovare ha senso. `400 invalid_grant` no; `503` o nessuna risposta sì.
  if (!esito.ok || !risposta) return { ritentabile: erroreRitentabile(esito.stato) }

  // PRIMA il testo, POI il parse — e non `risposta.json()` diretto. La differenza è tutta nel
  // log: `json()` lancia un SyntaxError che del corpo si porta dietro sì e no trenta caratteri,
  // mentre così il corpo VERO resta in mano nostra e finisce nel messaggio dell'errore. È la
  // regola 3 di AGENTS applicata a un 200: il corpo di un provider non si butta MAI via.
  let testo: string
  try {
    testo = await risposta.text()
  } catch (err) {
    // Lo stream si è interrotto dopo gli header (connessione caduta, proxy che chiude): un 200
    // di cui non si è potuto leggere il corpo non è un 200 buono, ed è un percorso d'errore —
    // quindi si logga (regola 6), invece di lasciar risalire l'eccezione a un catch muto.
    logEvento(
      'push',
      'error',
      { provider: 'fcm', operazione: 'oauth-token', esito: 'corpo-illeggibile' },
      err,
    )
    // Uno stream interrotto è un guasto di rete, non delle credenziali: riprovare può riuscire.
    return { ritentabile: true }
  }

  let json: { access_token?: string; expires_in?: number }
  try {
    json = JSON.parse(testo) as { access_token?: string; expires_in?: number }
  } catch (err) {
    // 200 con un corpo che JSON NON è: fra noi e Google possono esserci un proxy aziendale, un
    // captive portal, la pagina d'errore HTML di un gateway — tutta roba che risponde 200. Prima
    // `json()` lanciava e l'eccezione risaliva MUTA fino al catch finale di `sendNativePush`,
    // che la inghiottiva: zero push, zero righe.
    //
    // Il corpo diventa il MESSAGGIO dell'errore, non un campo dei `campi`, per la stessa ragione
    // scritta in `external.ts`: `redact()` è a lista bianca PER CHIAVE, e un campo `corpo` in
    // tabella uscirebbe come `[redatto:str/N]` — illeggibile proprio nel canale che dura 30
    // giorni. Passato come errore, `descriviErrore` lo porta in chiaro (e sanificato) nella
    // colonna `app_log.messaggio`. Il `name` proprio perché Vercel raggruppa per *error name*.
    const errore = new Error(`OAuth 200 ma il corpo non è JSON: ${testo.slice(0, CORPO_LOG_MAX)}`)
    errore.name = 'FcmCorpoNonJson'
    errore.cause = err
    logEvento(
      'push',
      'error',
      { provider: 'fcm', operazione: 'oauth-token', esito: 'corpo-non-json' },
      errore,
    )
    // Un 200 non JSON viene da ciò che sta FRA noi e Google (proxy, gateway, captive portal),
    // non dalla chiave: è transitorio quanto un 5xx.
    return { ritentabile: true }
  }

  if (!json.access_token) {
    // Un 200 senza token è il fallimento più insidioso: tutto "funziona" e non parte niente.
    // Un percorso d'errore che non logga è un bug — qui non c'era nemmeno un catch.
    logEvento('push', 'error', {
      provider: 'fcm',
      operazione: 'oauth-token',
      msg: 'risposta OAuth 200 ma senza access_token',
    })
    // Google ha letto la richiesta e ha risposto: la stessa richiesta avrà la stessa risposta.
    return { ritentabile: false }
  }
  cachedToken = { value: json.access_token, expiresAt: nowSec + (json.expires_in ?? 3600) }
  return { token: cachedToken.value }
}

/**
 * Invia una notifica push nativa via FCM HTTP v1 a UN dispositivo. Non lancia mai.
 *
 * Esiti: vedi `EsitoNativePush`. In breve: `ok`; `gone` (token morto, da rimuovere); oppure un
 * rifiuto con `error` (sempre col corpo di FCM) e `ritentabile`, che dice a chi chiama se la
 * notifica vale la pena di tenerla in coda.
 *
 * I RITENTATIVI IMMEDIATI. Su `5xx`, timeout o rete giù (`stato: 0`) e `429` si riprova fino a
 * due volte, aspettando 1 s e poi 3 s (`ATTESE_RITENTATIVO_MS`). Sul `429` l'attesa è il
 * `Retry-After` di FCM, se è più lungo; se supera `ATTESA_MAX_MS` non si aspetta affatto e la
 * decisione torna a chi chiama (`ritentaDopoMs`). Tutto il resto — `400`, `401`, `403` — non si
 * ritenta: la stessa richiesta avrebbe la stessa risposta.
 *
 * I LOG. Ogni chiamata ha la sua riga (la scrive `externalFetch`, col corpo): `info` sul
 * successo e sul token morto, `warn` su un rifiuto transitorio — che da solo NON è ancora un
 * guasto, perché il ritentativo può ripararlo —, `error` su un rifiuto definitivo. Quando i
 * ritentativi finiscono senza successo, UNA riga `error` in più lo dice (`ritentativi-esauriti`
 * o `retry-after-oltre-il-tetto`), col corpo dell'ultimo rifiuto; e un successo arrivato dopo
 * un ritentativo ha la sua riga `riuscita-dopo-ritentativo`, perché si possa contare quante
 * notifiche i ritentativi hanno salvato.
 */
export async function sendNativePush(
  token: string,
  platform: NativePlatform,
  payload: NativePushPayload,
  opzioni?: OpzioniNativePush,
): Promise<EsitoNativePush> {
  if (!fcmConfigured()) {
    return { ok: false, error: 'fcm_non_configurato', ritentabile: false, tentativi: 0 }
  }
  let tentativi = 0
  try {
    const oauth = await getAccessToken()
    // Il perché l'ha già loggato `getAccessToken` (col corpo di Google). Se ritentare ha senso lo
    // dice lui: un `5xx`/timeout dell'endpoint OAuth sì, una chiave rifiutata (`400
    // invalid_grant`, `401`, `403`) no — come la chiave PEM malformata del catch qui sotto. In
    // nessuno dei due casi la subscription c'entra: non è `gone`.
    if (oauth.token === undefined) {
      return { ok: false, error: 'fcm_auth_fallita', ritentabile: oauth.ritentabile, tentativi: 0 }
    }
    const accessToken = oauth.token

    const projectId = process.env.FCM_PROJECT_ID as string
    const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`
    const init: RequestInit = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messaggioFcm(token, platform, payload)),
    }
    const maxRitentativi = ritentativiAmmessi(opzioni?.maxRitentativi)

    for (;;) {
      tentativi++
      const esito = await externalFetch('fcm', url, init, {
        // `push` è in EVENTI_PERSISTITI: in tabella finisce anche il SUCCESSO. Senza, "nessun
        // log" non distinguerebbe "tutte consegnate" da "non è mai partito niente".
        evento: 'push',
        campi: { operazione: 'messages:send', piattaforma: platform, tentativo: tentativi },
        // Un token di un'app disinstallata NON è un guasto: è la vita normale, resta a `info`.
        // Un rifiuto transitorio è `warn`: il guasto vero, se c'è, lo dice la riga finale.
        gravita: (stato, corpo) =>
          tokenNonRegistrato(stato, corpo) ? 'info' : erroreRitentabile(stato) ? 'warn' : 'error',
      })

      if (esito.ok) {
        if (tentativi > 1) {
          logEvento('push', 'info', {
            provider: 'fcm',
            operazione: 'messages:send',
            piattaforma: platform,
            esito: 'riuscita-dopo-ritentativo',
            tentativi,
          })
        }
        return { ok: true, tentativi }
      }

      // Token non registrato → subscription da rimuovere (come 410/404 web). DEFINITIVO.
      if (tokenNonRegistrato(esito.stato, esito.corpo)) return { ok: false, gone: true, tentativi }

      // Il corpo dell'errore NON si butta via: `fcm_400` non dice nulla, il corpo FCM dice
      // esattamente cosa non va ("SenderId mismatch", "Internal error"). È già loggato; qui
      // viaggia anche nell'esito, perché chi chiama possa metterlo nel proprio audit.
      const error = `fcm_${esito.stato}: ${esito.corpo.slice(0, 200)}`
      if (!erroreRitentabile(esito.stato)) return { ok: false, error, ritentabile: false, tentativi }

      const attesa = attesaPrimaDelRitentativo(esito.stato, esito.retryAfter, tentativi)
      const oltreIlTetto = attesa > ATTESA_MAX_MS
      if (tentativi > maxRitentativi || oltreIlTetto) {
        logEvento(
          'push',
          'error',
          {
            provider: 'fcm',
            operazione: 'messages:send',
            piattaforma: platform,
            esito: oltreIlTetto ? 'retry-after-oltre-il-tetto' : 'ritentativi-esauriti',
            // Come in `externalFetch`: `stato: 0` (nessuna risposta) non è uno status HTTP e
            // sporcherebbe `app_log.stato_http`, dove `>= 500` conta i guasti del provider.
            ...(esito.stato > 0 ? { stato: esito.stato } : {}),
            tentativi,
            ...(oltreIlTetto ? { attesa_ms: attesa } : {}),
          },
          erroreFcm(esito.stato, esito.corpo, esito.codice),
        )
        return {
          ok: false,
          error,
          ritentabile: true,
          tentativi,
          ...(oltreIlTetto ? { ritentaDopoMs: attesa } : {}),
        }
      }
      await attendi(attesa)
    }
  } catch (err) {
    /*
     * UN CATCH CHE NON LOGGA È UN BUG (AGENTS, regola 6) — e questo era il peggiore di tutti,
     * proprio nel file riscritto per eliminare i guasti muti dei provider.
     *
     * COME CI SI ARRIVA, davvero: `FCM_PRIVATE_KEY` presente ma con un PEM malformato (i `\n`
     * non normalizzati, una chiave troncata dall'incolla, un BEGIN/END sbagliato). Allora
     * `fcmConfigured()` è true — la variabile c'è —, ma `crypto.createSign(…).sign(privateKey)`
     * LANCIA dentro `getAccessToken()`. L'eccezione risaliva fin qui e moriva in silenzio.
     *
     * PERCHÉ ERA UN GUASTO CIECO, non solo una riga mancante: l'esito `{ ok:false, error }` che
     * si restituisce non è né `ok` né `gone`, e in `push/dispatch` quei due sono gli unici rami
     * che producono qualcosa. Nessuna riga, nessun contatore — e il battito del cron continuava
     * a dire `esito:'ok'` con `native_inviate: 0`. Zero push consegnate, zero tracce: è il guasto
     * delle email di credenziali, riprodotto tale e quale (403 letto e buttato via).
     *
     * `logEvento` e non `logErrore`: `push` è in `EVENTI_PERSISTITI` (la riga finisce in tabella
     * e si interroga insieme a tutte le altre push), e `logErrore` alzerebbe la marca
     * `erroreLoggato` sul contesto — che spegnerebbe la riga di esito di `withRoute` per il 5xx
     * di una route che qui invece NON sta fallendo: il dispatch degrada e risponde 200.
     * L'errore VERO (con il suo stack: dice se ha lanciato la firma RS256 o altro) va comunque
     * in `app_log.stack` e su console come Error nativo.
     */
    logEvento(
      'push',
      'error',
      {
        provider: 'fcm',
        operazione: 'send-native-push',
        piattaforma: platform,
        esito: 'eccezione',
      },
      err,
    )
    // `descriviErrore` e non `(err as Error)?.message`: se qualcuno lancia una stringa o un
    // oggetto PostgREST, `.message` è `undefined` e l'esito diceva soltanto 'fcm_error' — cioè
    // di nuovo niente. Qui il messaggio c'è sempre, ed è già sanificato (mai un'email in chiaro).
    // Non ritentabile: il caso vero è la NOSTRA chiave malformata, e riprovare non la ripara.
    return {
      ok: false,
      error: `fcm_eccezione: ${descriviErrore(err).messaggio}`,
      ritentabile: false,
      tentativi,
    }
  }
}

/**
 * Il token non è più valido: la subscription va rimossa. Due forme, entrambe di FCM:
 * `404` (token sconosciuto) e `400` con `UNREGISTERED`/`INVALID_ARGUMENT` nel corpo — che è
 * anche il motivo per cui il corpo, su questo ramo, andava letto comunque.
 */
function tokenNonRegistrato(stato: number, corpo: string): boolean {
  if (stato === 404) return true
  return stato === 400 && /UNREGISTERED|INVALID_ARGUMENT/i.test(corpo)
}

/**
 * Il messaggio FCM HTTP v1 per UN dispositivo.
 *
 * iOS: suono di default e, se chi chiama lo passa, il BADGE (le notifiche non lette). Android:
 * suono di default e il canale `kidville_notifiche`, quello che il client crea all'avvio; su un
 * telefono che non l'ha ancora creato Android ripiega da solo sul canale di riserva.
 */
function messaggioFcm(token: string, platform: NativePlatform, payload: NativePushPayload) {
  const badge = badgeValido(payload.badge)
  return {
    message: {
      token,
      notification: { title: payload.title, body: payload.body ?? '' },
      data: { url: payload.url ?? '/', ...(payload.tag ? { tag: payload.tag } : {}) },
      ...(platform === 'ios'
        ? { apns: { payload: { aps: { sound: 'default', ...(badge !== undefined ? { badge } : {}) } } } }
        : {
            android: {
              notification: { default_sound: true, channel_id: CANALE_ANDROID_NOTIFICHE },
            },
          }),
    },
  }
}

/** Un badge si manda solo se è un intero non negativo: APNs rifiuterebbe il resto. */
function badgeValido(badge: unknown): number | undefined {
  return typeof badge === 'number' && Number.isInteger(badge) && badge >= 0 ? badge : undefined
}

/**
 * Transitorio: `5xx` (FCM `INTERNAL`/`UNAVAILABLE`), `429` (quota) e `0` — nessuna risposta:
 * timeout del tetto di `externalFetch`, rete giù, DNS.
 */
function erroreRitentabile(stato: number): boolean {
  return stato === 0 || stato === 429 || (stato >= 500 && stato <= 599)
}

/** Quanti ritentativi immediati: intero fra 0 e `ATTESE_RITENTATIVO_MS.length` (predefinito: tutti). */
function ritentativiAmmessi(richiesti: number | undefined): number {
  const max = ATTESE_RITENTATIVO_MS.length
  if (typeof richiesti !== 'number' || !Number.isFinite(richiesti)) return max
  return Math.min(max, Math.max(0, Math.floor(richiesti)))
}

/**
 * L'attesa prima del prossimo ritentativo: 1 s, poi 3 s. Su un `429` con `Retry-After` si
 * aspetta quanto chiede FCM, se è di più (mai di meno della scaletta).
 */
function attesaPrimaDelRitentativo(stato: number, retryAfter: string | undefined, fatti: number): number {
  const scaletta = ATTESE_RITENTATIVO_MS[Math.min(fatti, ATTESE_RITENTATIVO_MS.length) - 1]
  if (stato !== 429) return scaletta
  const chiesta = msDaRetryAfter(retryAfter)
  return chiesta === undefined ? scaletta : Math.max(scaletta, chiesta)
}

/** `Retry-After` è in secondi (`120`) oppure una data HTTP. Illeggibile → `undefined`. */
function msDaRetryAfter(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  if (/^\d+$/.test(v)) return Number(v) * 1_000
  const quando = Date.parse(v)
  return Number.isFinite(quando) ? Math.max(0, quando - Date.now()) : undefined
}

function attendi(ms: number): Promise<void> {
  return new Promise((risolvi) => setTimeout(risolvi, ms))
}

/**
 * L'ultimo rifiuto come Error VERO, per la riga finale: il corpo diventa il messaggio (colonna
 * `app_log.messaggio`, in chiaro e sanificato), lo status il `code`. Stesso schema di
 * `erroreHttp` in `external.ts`, con un nome suo perché Vercel raggruppa per *error name*.
 *
 * SENZA RISPOSTA (`stato: 0`) IL CODICE NON È '0'. Uno `0` in `app_log.codice` è indistinguibile
 * da uno status e mescola i timeout con rete giù e DNS: la riga `error` finale dei timeout — l'unica
 * a quel livello — sfuggiva a `where codice = 'timeout'`, mentre le righe `warn` dei singoli
 * tentativi ci finivano. Si usa il codice che `externalFetch` ha già scritto sulla riga del
 * tentativo (`'timeout'`, `ECONNREFUSED`…) e, se l'eccezione non ne aveva uno, `'nessuna-risposta'`.
 */
function erroreFcm(stato: number, corpo: string, codiceRete: string | undefined): Error {
  const err = new Error(corpo === '' ? `FCM ${stato === 0 ? 'nessuna risposta' : `HTTP ${stato}`}` : corpo)
  err.name = 'FcmRitentativiEsauriti'
  Object.assign(err, { code: stato === 0 ? (codiceRete ?? 'nessuna-risposta') : String(stato) })
  return err
}
