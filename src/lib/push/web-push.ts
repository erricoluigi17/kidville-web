import webpush from 'web-push'
import { externalFetch } from '@/lib/logging/external'
import { logEvento } from '@/lib/logging/logger'
import { descriviErrore } from '@/lib/logging/serialize'

// =============================================================================
// Push WEB (VAPID) — l'ULTIMO provider che parlava col mondo esterno senza passare
// da `externalFetch`, e l'unico canale rimasto con il vizio che questo repo ha già
// pagato caro.
//
// COM'ERA. `webpush.sendNotification()` fa la richiesta HTTP per conto suo e, sul
// rifiuto, lancia una `WebPushError` che porta `statusCode`, `headers` **e `body`**
// — il testo con cui il push service dice PERCHÉ («the VAPID key is not authorized
// for this endpoint», «payload too large», «Unauthorized Registration»). Il catch
// qui sotto teneva `err.message`, guardava `statusCode` solo per riconoscere
// 410/404, e del `body` non faceva NIENTE. Nessun log, per giunta: un catch che non
// logga è un bug (AGENTS, regola 6), e uno status senza corpo è il bug (regola 3).
//
// È la forma identica al guasto storico delle email di credenziali: per mesi
// nessuna è arrivata perché Resend rispondeva `403` e il codice registrava il solo
// numero, mentre il corpo diceva «the kidville.it domain is not verified».
//
// COM'È ORA. Si usa `generateRequestDetails()` — l'API che web-push espone proprio
// per chi vuole il proprio client HTTP: fa la cifratura aes128gcm e restituisce
// endpoint, header VAPID e corpo cifrato — e la richiesta la fa `externalFetch`,
// che sul `!ok` LEGGE il corpo, lo mette nel messaggio dell'errore (dove
// `descriviErrore` lo porta in chiaro in `app_log.messaggio`, sanificato) e logga
// anche il SUCCESSO, perché `push` è in `EVENTI_PERSISTITI` (regola 5: senza il
// battito, «nessun log» non distingue «tutte consegnate» da «non è mai partito
// niente»).
//
// Il canale nativo (`native-push.ts`) faceva già così: qui si allinea il gemello.
//
// Contratto verso i chiamanti INVARIATO — `{ ok }` / `{ ok:false, gone }` /
// `{ ok:false, error }`, e non lancia mai: lo usano `push/dispatch` e
// `lib/mensa/notify`, che degradano e non devono morire.
// =============================================================================

let configured = false

/** true se le chiavi VAPID sono presenti (il push web è configurabile). */
export function vapidConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
}

function ensureConfigured(): boolean {
  if (configured) return true
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const priv = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT || 'mailto:info@kidville.it'
  if (!pub || !priv) return false
  webpush.setVapidDetails(subject, pub, priv)
  configured = true
  return true
}

export interface PushSub {
  endpoint: string
  p256dh: string
  auth: string
}

export interface PushPayload {
  title: string
  body?: string
  url?: string
  tag?: string
}

/**
 * Gli status per cui la subscription è morta e va rimossa. `410` (unsubscribed o
 * scaduta) e `404` (endpoint sconosciuto): sono la vita normale di una scuola — un
 * genitore che cambia telefono o svuota il browser — non un guasto. Restano a `info`
 * per non emettere un Error nativo su console a ogni disinstallazione, che
 * inquinerebbe il raggruppamento di `get_runtime_errors`. Stessa scelta, con le
 * stesse ragioni, di `tokenNonRegistrato` in `native-push.ts`.
 */
const SUBSCRIPTION_MORTA = new Set([404, 410])

/** Quanto corpo del provider ci si porta dietro NELL'ESITO (nel log ci pensa `externalFetch`). */
const CORPO_ESITO_MAX = 200

/**
 * Invia una notifica Web Push. Ritorna { ok } oppure { ok:false, gone } se la
 * subscription è scaduta (410/404) e va rimossa. Senza chiavi VAPID degrada
 * senza lanciare: { ok:false, error:'vapid_non_configurato' }.
 */
export async function sendPush(sub: PushSub, payload: PushPayload): Promise<{ ok: boolean; gone?: boolean; error?: string }> {
  if (!ensureConfigured()) {
    // AGENTS, regola 4: configurazione mancante = livello `error`, MAI `info`. E qui
    // non è una nota di preflight: si è arrivati fin qui perché c'era una notifica VERA
    // da consegnare a una famiglia, e non parte. (VAPID non è nemmeno nell'elenco del
    // preflight di `instrumentation.ts`: prima di questa riga, l'assenza delle chiavi
    // non la diceva proprio nessuno.)
    //
    // I nomi delle variabili viaggiano come ERRORE, non come campo: `redact()` è a lista
    // bianca PER CHIAVE, e un campo `mancante` uscirebbe in tabella come
    // `[redatto:str/N]` — cioè una riga che dice «manca una variabile» senza dire quale.
    // Passati così, `descriviErrore` li porta in chiaro in `app_log.messaggio` e il
    // `code` rende la cosa interrogabile in SQL. Stessa forma del preflight.
    logEvento('config', 'error', {
      operazione: 'sendPush',
      provider: 'web-push',
      esito: 'mancante',
    }, {
      message:
        "variabili d'ambiente critiche mancanti: NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY " +
        '(push web non inviabile, notifica lasciata in coda)',
      code: 'config_mancante',
    })
    return { ok: false, error: 'vapid_non_configurato' }
  }

  let dettagli: ReturnType<typeof webpush.generateRequestDetails>
  try {
    dettagli = webpush.generateRequestDetails(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
    )
  } catch (err) {
    // Cifratura impossibile: `p256dh`/`auth` malformati (una riga di
    // `push_subscriptions` scritta da un browser che ha cambiato formato, un
    // troncamento all'inserimento), o un endpoint che non è un URL. Prima questo
    // throw finiva nel catch che non loggava: zero push, zero tracce, e il dispatch
    // continuava a dire «ok».
    logEvento('push', 'error', {
      provider: 'web-push',
      operazione: 'sendPush',
      piattaforma: 'web',
      esito: 'cifratura-fallita',
    }, err)
    // `descriviErrore` e non `(err as Error)?.message`: se qualcuno lancia una stringa
    // o un oggetto, `.message` è `undefined` e l'esito non direbbe niente. Qui il
    // messaggio c'è sempre, ed è già sanificato.
    return { ok: false, error: `web_push_cifratura: ${descriviErrore(err).messaggio}` }
  }

  const esito = await externalFetch(
    'web-push',
    dettagli.endpoint,
    {
      method: dettagli.method,
      headers: intestazioni(dettagli.headers),
      body: corpoBinario(dettagli.body),
    },
    {
      // `push` è in `EVENTI_PERSISTITI`: in tabella finisce anche il SUCCESSO.
      evento: 'push',
      campi: { operazione: 'web-push:send', piattaforma: 'web' },
      gravita: (stato) => (SUBSCRIPTION_MORTA.has(stato) ? 'info' : 'error'),
    },
  )

  if (esito.ok) return { ok: true }
  if (SUBSCRIPTION_MORTA.has(esito.stato)) return { ok: false, gone: true }

  // Il corpo NON si butta più via: `web_push_403` non dice nulla, il corpo del push
  // service dice esattamente cosa non va. È già loggato da `externalFetch`; qui
  // viaggia anche nell'esito, perché chi chiama possa metterlo nel proprio audit
  // invece di un numero. `stato: 0` = la risposta non c'è stata affatto (rete, DNS,
  // TLS) e `corpo` porta il messaggio dell'eccezione.
  return { ok: false, error: `web_push_${esito.stato}: ${esito.corpo.slice(0, CORPO_ESITO_MAX)}` }
}

/**
 * Gli header della richiesta, meno `Content-Length`.
 *
 * `fetch` calcola da sé la lunghezza dal corpo che gli si passa: fornirla anche a
 * mano è nel migliore dei casi un doppione, nel peggiore un valore che diverge dal
 * corpo vero — ed è proprio il genere di disallineamento che un push service
 * rifiuta con un `400` generico, cioè con il messaggio meno diagnostico possibile.
 * I valori si stringificano perché `web-push` mette `TTL` e `Content-Length` come
 * NUMERI, e `HeadersInit` vuole stringhe.
 */
function intestazioni(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const chiave of Object.keys(headers ?? {})) {
      if (chiave.toLowerCase() === 'content-length') continue
      out[chiave] = String(headers[chiave])
    }
  } catch {
    // Un oggetto ostile non deve costare l'invio: al peggio partono meno header e il
    // provider risponde 401 — con il suo corpo, che ora si legge.
  }
  return out
}

/**
 * Il corpo cifrato come `ArrayBuffer`.
 *
 * `new Uint8Array(buffer)` COPIA: un `Buffer` di Node è una vista su un pool
 * condiviso, quindi `body.buffer` conterrebbe anche byte di altri — che finirebbero
 * spediti al push service. La copia è di poche centinaia di byte.
 * `ArrayBuffer` e non `Uint8Array` perché è ciò che il `BodyInit` di questo tsconfig
 * accetta (stessa ragione, e stessa riga, di `external.ts`).
 */
function corpoBinario(body: Buffer | null): ArrayBuffer | undefined {
  if (!body) return undefined
  return new Uint8Array(body).buffer as ArrayBuffer
}
