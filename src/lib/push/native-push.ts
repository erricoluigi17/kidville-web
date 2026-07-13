import crypto from 'node:crypto'
import { externalFetch } from '@/lib/logging/external'
import { logEvento } from '@/lib/logging/logger'
import { descriviErrore } from '@/lib/logging/serialize'

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
}

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

/**
 * Quanto corpo illeggibile ci si porta dietro nel log. Trecento caratteri: quel che basta a
 * riconoscere una pagina HTML di un proxy o il messaggio di un gateway — non un dump.
 */
const CORPO_LOG_MAX = 300

// Cache per-processo dell'access token OAuth (validita' ~1h).
let cachedToken: { value: string; expiresAt: number } | null = null

async function getAccessToken(): Promise<string | null> {
  const nowSec = Math.floor(Date.now() / 1000)
  if (cachedToken && cachedToken.expiresAt - 60 > nowSec) return cachedToken.value

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
  if (!esito.ok || !risposta) return null

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
    return null
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
    return null
  }

  if (!json.access_token) {
    // Un 200 senza token è il fallimento più insidioso: tutto "funziona" e non parte niente.
    // Un percorso d'errore che non logga è un bug — qui non c'era nemmeno un catch.
    logEvento('push', 'error', {
      provider: 'fcm',
      operazione: 'oauth-token',
      msg: 'risposta OAuth 200 ma senza access_token',
    })
    return null
  }
  cachedToken = { value: json.access_token, expiresAt: nowSec + (json.expires_in ?? 3600) }
  return cachedToken.value
}

/**
 * Invia una notifica push nativa via FCM HTTP v1. Ritorna { ok } oppure
 * { ok:false, gone } se il token e' scaduto/non registrato (da rimuovere),
 * oppure { ok:false, error } (incluso 'fcm_non_configurato' quando mancano le
 * credenziali). Non lancia mai.
 */
export async function sendNativePush(
  token: string,
  platform: NativePlatform,
  payload: NativePushPayload
): Promise<{ ok: boolean; gone?: boolean; error?: string }> {
  if (!fcmConfigured()) return { ok: false, error: 'fcm_non_configurato' }
  try {
    const accessToken = await getAccessToken()
    if (!accessToken) return { ok: false, error: 'fcm_auth_fallita' }

    const projectId = process.env.FCM_PROJECT_ID as string
    const message = {
      message: {
        token,
        notification: { title: payload.title, body: payload.body ?? '' },
        data: { url: payload.url ?? '/', ...(payload.tag ? { tag: payload.tag } : {}) },
        // Override per piattaforma: suono di default coerente su iOS/Android.
        ...(platform === 'ios'
          ? { apns: { payload: { aps: { sound: 'default' } } } }
          : { android: { notification: { default_sound: true } } }),
      },
    }

    const esito = await externalFetch(
      'fcm',
      `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      },
      {
        // `push` è in EVENTI_PERSISTITI: in tabella finisce anche il SUCCESSO. Senza, "nessun
        // log" non distinguerebbe "tutte consegnate" da "non è mai partito niente".
        evento: 'push',
        campi: { operazione: 'messages:send', piattaforma: platform },
        // Un token di un'app disinstallata NON è un guasto: è la vita normale. A livello
        // `error` allarmerebbe (ed emetterebbe un Error nativo su console) a ogni genitore
        // che cancella l'app. Resta in tabella a `info`: si conta, non sveglia nessuno.
        gravita: (stato, corpo) => (tokenNonRegistrato(stato, corpo) ? 'info' : 'error'),
      }
    )
    if (esito.ok) return { ok: true }

    // Token non registrato → subscription da rimuovere (come 410/404 web). Il corpo l'ha già
    // letto `externalFetch`: la semantica è identica a prima, la fonte del testo no.
    if (tokenNonRegistrato(esito.stato, esito.corpo)) return { ok: false, gone: true }

    // Il corpo dell'errore NON si butta più via: `fcm_http_400` non dice nulla, il corpo FCM
    // dice esattamente cosa non va ("The registration token is not a valid FCM registration
    // token", "SenderId mismatch"). È già loggato; qui viaggia anche nell'esito, perché chi
    // chiama possa metterlo nel proprio audit invece di un numero.
    return { ok: false, error: `fcm_${esito.stato}: ${esito.corpo.slice(0, 200)}` }
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
    return { ok: false, error: `fcm_eccezione: ${descriviErrore(err).messaggio}` }
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
