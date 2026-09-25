'use client'

import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
import type { PushNotificationsPlugin } from '@capacitor/push-notifications'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { CANALE_ANDROID_NOTIFICHE } from '@/lib/push/canale-android'
import commonIt from '../../../messages/it/common.json'
import commonEn from '../../../messages/en/common.json'

// Registrazione push NATIVA (Capacitor iOS/Android) lato client. Su web tutte le
// funzioni sono no-op: la push web resta gestita dal service worker (PushOptIn).
// L'identità è dalla sessione (cookie condiviso con la WebView); l'eventuale
// `userId` viaggia come header x-user-id di fallback legacy (identità
// localStorage del genitore) — il server preferisce comunque la sessione.

/** true se l'app gira nella shell nativa Capacitor. Su web/SSR → false. */
export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

/**
 * IL PLUGIN SI CHIEDE AL BRIDGE PRIMA DI CHIAMARLO (spec 2026-09-24: «nessun plugin si chiama senza
 * `isPluginAvailable`»). Un binario senza il plugin risponde `false` qui, invece di far esplodere
 * la prima chiamata con un `UNIMPLEMENTED` che arriva nei log come «plugin non utilizzabile» e non
 * dice che manca proprio.
 *
 * TRE RISPOSTE, NON DUE (giro 7 del critico, 2026-09-25). Un bridge che LANCIA non è un plugin
 * assente: con un booleano solo, `registerNativePush` scriveva «non disponibile nel binario» —
 * un difetto di build che non c'era — e `statoPermessoPush` spegneva l'avviso senza traccia.
 * Ora il bridge rotto lascia la sua riga qui, una sola, e chi chiama sa distinguere i due casi.
 */
function pluginPushDisponibile(): 'si' | 'assente' | 'bridge-illeggibile' {
  try {
    return Capacitor.isPluginAvailable('PushNotifications') ? 'si' : 'assente'
  } catch (e) {
    // `warn`: la push su questo avvio non parte, ma è il bridge che non risponde, non il binario.
    logClient({
      livello: 'warn',
      evento: 'push',
      messaggio: `push-nativa-bridge-illeggibile: ${nomeErrore(e)}`,
    })
    return 'bridge-illeggibile'
  }
}

/**
 * UN IMPORT SOLO DEL MODULO PER SESSIONE. L'automatica all'accesso e «attiva» in PushOptIn possono
 * partire insieme: con la promise condivisa le due chiamate ricevono lo stesso modulo, invece di due
 * caricamenti in volo. Se l'import fallisce la promise si scarta, e il prossimo tentativo riprova.
 *
 * ⚠️ SI TIENE IL MODULO, MAI IL PLUGIN (regressione della #166, 2026-09-25). La versione precedente
 * teneva `import(…).then((m) => m.PushNotifications)`: una promise che si RISOLVE con il plugin. Ma
 * il plugin di Capacitor è un `Proxy` che risponde a OGNI proprietà con un metodo del bridge, `then`
 * compreso: la promise lo prende per un «thenable», chiama `PushNotifications.then(risolvi, rifiuta)`,
 * e il bridge risponde `"PushNotifications.then()" is not implemented on ios|android` — un rifiuto che
 * nessuno aspetta, mentre la promise di partenza resta appesa per sempre. Registrazione del token,
 * canale Android e `statoPermessoPush()` (quindi l'avviso settimanale) non arrivavano mai alla fine.
 * Il namespace del modulo non ha un `then`: attraversa `await` intatto, e il plugin si prende DOPO
 * (`const { PushNotifications } = await caricaModuloPush()`). Lock:
 * `__tests__/architecture/plugin-capacitor-mai-risolto-da-promise.test.ts`.
 */
type ModuloPush = typeof import('@capacitor/push-notifications')

let moduloPush: Promise<ModuloPush> | null = null

function caricaModuloPush(): Promise<ModuloPush> {
  if (!moduloPush) {
    moduloPush = import('@capacitor/push-notifications').catch((e: unknown) => {
      moduloPush = null
      throw e
    })
  }
  return moduloPush
}

// Ultimo token nativo registrato in questa sessione (per la disattivazione).
let lastToken: string | null = null

/**
 * IL TOKEN SOPRAVVIVE ALLA SESSIONE JS, E DEVE.
 *
 * `lastToken` è stato di MODULO, e nella WebView Capacitor il modulo muore a ogni
 * navigazione dura — `doLogout()` finisce con `window.location.href`, e l'app che
 * riparte da un boot a freddo comincia con `lastToken = null`. Finché la
 * disattivazione guardava solo la variabile, «esci» su un'app appena aperta non
 * aveva NIENTE da cancellare: la `DELETE` non partiva, la riga in
 * `push_subscriptions` restava, e le notifiche sui bambini continuavano ad
 * arrivare su un telefono che nessuno stava più usando.
 *
 * Il token FCM/APNs è per INSTALLAZIONE, non per utente: non è un dato personale
 * di un minore, è l'indirizzo del dispositivo — lo stesso che viaggia già in
 * chiaro verso `/api/push/subscribe` e vive in `push_subscriptions.endpoint`.
 * Tenerne una copia locale è ciò che rende la disattivazione possibile dopo un
 * riavvio; la chiave sta FUORI da `LOCAL_KEYS` di `logout.ts` perché non è
 * identità, e va tolta solo quando il server conferma di aver rimosso la riga.
 */
const TOKEN_KEY = 'kv_push_token'

function ricordaToken(token: string): void {
  lastToken = token
  // Vedi `generazioneToken`: dice a una DELETE in volo che questo token è arrivato DOPO di lei.
  generazioneToken = generazione
  try {
    window.localStorage.setItem(TOKEN_KEY, token)
  } catch (e) {
    // Storage negato (modalità privata, quota): la registrazione è comunque
    // riuscita, ma la disattivazione dopo un riavvio non avrà più l'indirizzo del
    // dispositivo. È esattamente il difetto che questa chiave chiude, quindi si
    // grida invece di tacere.
    logClient({
      livello: 'warn',
      evento: 'push',
      messaggio: `push-token-non-persistito: ${nomeErrore(e)}`,
    })
  }
}

/** Il token da disattivare: quello di questa sessione, o quello del riavvio precedente. */
function tokenDaDisattivare(): string | null {
  if (lastToken) return lastToken
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    // Storage illeggibile: non c'è niente da fare e non c'è niente da dire che
    // `ricordaToken` non abbia già detto quando ha provato a scriverlo.
    return null
  }
}

function dimenticaToken(): void {
  lastToken = null
  try {
    window.localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Idem: la copia locale è un ripiego, non la fonte di verità (che è il DB).
  }
}

/**
 * IL RIFIUTO SI REGISTRA UNA VOLTA PER INSTALLAZIONE, NON A OGNI AVVIO (2026-09-24).
 *
 * Misurato su 7 giorni: 26 utenti con il permesso negato ricadevano in `push-nativa-permesso-negato`
 * a OGNI apertura dell'app — la stessa scelta, ripetuta come se fosse una notizia, in mezzo ai guasti
 * veri. Il flag locale dice «questo rifiuto è già in `app_log`». Si toglie quando il permesso torna
 * `granted`: un nuovo rifiuto dopo un ripensamento è un fatto nuovo, e si riscrive.
 *
 * Il flag non è un dato personale: è un booleano sull'installazione, come `kv_push_token`, e come lui
 * sta fuori da `LOCAL_KEYS` di `logout.ts` (il permesso è del telefono, non di chi ha fatto l'accesso).
 */
const RIFIUTO_REGISTRATO_KEY = 'kv_push_rifiuto_registrato'

function rifiutoGiaRegistrato(): boolean {
  try {
    return window.localStorage.getItem(RIFIUTO_REGISTRATO_KEY) === '1'
  } catch {
    // Storage illeggibile: meglio una riga ripetuta che un rifiuto mai scritto. La riga che segue
    // porta `ricordato: false`, cioè dice da sé perché potrebbe ripetersi.
    return false
  }
}

/** Segna il rifiuto come già scritto. `false` se lo storage non l'ha accettato. */
function segnaRifiutoRegistrato(): boolean {
  try {
    window.localStorage.setItem(RIFIUTO_REGISTRATO_KEY, '1')
    return true
  } catch {
    // Non si logga a parte: l'esito finisce nel campo `ricordato` della riga del rifiuto.
    return false
  }
}

function dimenticaRifiuto(): void {
  try {
    window.localStorage.removeItem(RIFIUTO_REGISTRATO_KEY)
  } catch (e) {
    // Il flag resta acceso, e il prossimo rifiuto VERO non verrebbe scritto in `app_log`: il danno
    // è una riga persa, quindi la riga la si scrive qui. Il permesso vero lo restituisce comunque
    // `statoPermessoPush()`, che non dipende da questo flag.
    logClient({
      livello: 'warn',
      evento: 'push',
      messaggio: `push-nativa-flag-rifiuto-non-rimosso: ${nomeErrore(e)}`,
    })
  }
}

/** Lo stato del permesso delle notifiche, come lo vede chi deve decidere cosa mostrare. */
export type StatoPermessoPush = 'granted' | 'denied' | 'prompt' | 'non-nativo' | 'non-disponibile'

/**
 * `prompt-with-rationale` è la forma Android di «si può ancora chiedere»: per chi legge è `prompt`.
 * Un valore che il plugin non ha mai dichiarato non si indovina: `non-disponibile`.
 */
function normalizzaPermesso(receive: unknown): 'granted' | 'denied' | 'prompt' | 'non-disponibile' {
  if (receive === 'granted' || receive === 'denied' || receive === 'prompt') return receive
  if (receive === 'prompt-with-rationale') return 'prompt'
  return 'non-disponibile'
}

/**
 * Lo stato del permesso SENZA chiederlo (`checkPermissions`, mai `requestPermissions`): serve a chi
 * deve mostrare «Notifiche disattivate — Apri Impostazioni» e non può permettersi di far comparire
 * il dialogo di sistema per saperlo.
 *
 * - `non-nativo`: sito nel browser (la push web è un'altra strada, PushOptIn);
 * - `non-disponibile`: shell nativa senza il plugin, o bridge che non risponde.
 */
export async function statoPermessoPush(): Promise<StatoPermessoPush> {
  if (!isNativeApp()) return 'non-nativo'
  if (pluginPushDisponibile() !== 'si') return 'non-disponibile'
  try {
    const { PushNotifications } = await caricaModuloPush()
    const perm = await PushNotifications.checkPermissions()
    return normalizzaPermesso(perm.receive)
  } catch (e) {
    // `warn`: chi chiama riceve `non-disponibile` e non mostra niente — nessuna funzione si spegne
    // per questo, ma un plugin che non sa dire il proprio permesso è un'anomalia da vedere.
    logClient({
      livello: 'warn',
      evento: 'push',
      messaggio: `push-nativa-stato-permesso-illeggibile: ${nomeErrore(e)}`,
    })
    return 'non-disponibile'
  }
}

/**
 * Quanto si aspetta un esito da APNs/FCM prima di dichiarare la registrazione persa.
 *
 * SENZA QUESTO NUMERO LA PROMISE NON SI RISOLVE MAI. `PushNotifications.register()` non
 * restituisce l'esito: lo consegna a uno di due listener, `registration` o
 * `registrationError`. Se il sistema non chiama né l'uno né l'altro — capita su iOS quando
 * la registrazione APNs resta appesa senza errore — questa funzione resta sospesa per
 * sempre, e siccome il chiamante marca il tentativo come «fatto» non ci sarà un secondo
 * tentativo né una riga che lo dica. Venti secondi: molto oltre il tempo reale (meno di
 * uno), abbastanza da non dichiarare perso un dispositivo lento su rete mobile.
 *
 * Questo numero copre SOLO l'attesa del sistema: quando il token arriva il timer si ferma
 * (`fermaTimerAttesa`) e da lì il limite lo danno `TETTO_RICHIESTA_SUBSCRIBE_MS` e i ritentativi.
 */
const ATTESA_REGISTRAZIONE_MS = 20_000

/**
 * LE ATTESE FRA UN TENTATIVO E L'ALTRO DI `POST /api/push/subscribe` (2026-09-24).
 *
 * La registrazione del token parte al primo accesso, cioè spesso a rete appena accesa o su un
 * deploy in corso: un solo errore di rete o un 5xx lasciava il telefono fuori da
 * `push_subscriptions` fino al prossimo avvio, e per chi non chiude mai l'app significa giorni
 * senza notifiche. Tre tentativi in tutto, attese crescenti: 2 s, poi 8 s. Si ritenta SOLO ciò che
 * può guarire da sé (rete, 5xx): un 4xx è una risposta, e ripeterla non la cambia.
 */
export const ATTESE_RITENTATIVO_SUBSCRIBE_MS = [2_000, 8_000] as const

/**
 * IL TETTO DI OGNI SINGOLA RICHIESTA A `/api/push/subscribe`, POST e DELETE (giri 3 e 4 del
 * critico, 2026-09-25).
 *
 * `fetch` non ha un timeout suo: una rete mobile che accetta la connessione e poi tace (nella
 * WebView capita) non produce né un errore di rete né un 5xx. Senza tetto non scattava nessun
 * ritentativo e `registerNativePush` non si risolveva più — e siccome il timer dei 20 s si ferma
 * quando arriva il token (`fermaTimerAttesa`), non c'era più niente a chiuderla: in PushOptIn il
 * bottone restava in attesa per sempre. Con il tetto la scadenza diventa un errore di rete come gli
 * altri, cioè ritentabile, e il tempo totale ha un limite: 3 × 15 s + 2 s + 8 s = 55 s al peggio.
 *
 * La DELETE ha lo stesso tetto per la stessa ragione: `registerNativePush` la ATTENDE quando il
 * permesso è negato (`gestisciRifiuto`), e la attendono anche «disattiva» in PushOptIn e `doLogout`.
 * Una rete che tace li avrebbe tenuti fermi per sempre.
 *
 * 15 s e non meno: è il tetto per chiamata di Supabase lato server (`TETTO_MS_DEFAULT` in
 * `supabase-fetch.ts`). Un tetto cliente più corto taglierebbe la risposta mentre la route sta
 * ancora per darla, e l'errore vero del server diventerebbe un generico «nessuna risposta».
 *
 * Scritto a mano (`AbortController` + `setTimeout`, in `fetchConTetto`) e non con `conTetto`: il
 * binario iOS parte da iOS 15, dove `AbortSignal.timeout` non esiste e `conTetto` restituisce
 * l'`init` senza tetto — cioè esattamente sui telefoni dove serve di più, il ripiego sarebbe
 * «nessun tetto». Dichiarato in `PRIMITIVE_DI_TETTO` di `__tests__/lib/logging-tetto.test.ts`.
 */
export const TETTO_RICHIESTA_SUBSCRIBE_MS = 15_000

type Esito = { ok: boolean; error?: string }

/**
 * LA DISATTIVAZIONE FERMA I RITENTATIVI (giro 5 del critico, 2026-09-25).
 *
 * I ritentativi di `inviaToken` tengono aperta una finestra fino a 55 s. Se in quella finestra il
 * genitore preme «disattiva», esce, o il permesso risulta negato, `unregisterNativePush` cancella la
 * riga e la copia locale del token — e un ciclo che si risvegliasse dopo rifarebbe il POST con la
 * sessione ancora valida: la riga tornerebbe, senza più un token locale con cui cancellarla, e il
 * telefono riceverebbe notifiche con l'interruttore su «disattivato». Il contatore sale a ogni
 * disattivazione; `inviaToken` lo legge all'ingresso e prima di ogni POST, e se è cambiato si ferma.
 */
let generazione = 0

/**
 * LA DELETE IN VOLO, E LA GENERAZIONE IN CUI È STATO RICORDATO L'ULTIMO TOKEN (giro 6 del critico).
 *
 * Una riattivazione può partire mentre la DELETE di «disattiva» è ancora in volo (fino a 15 s). Due
 * cose non devono succedere:
 *  - il suo POST non deve arrivare al server PRIMA della DELETE: il token FCM di un'installazione è
 *    di solito lo stesso, e una DELETE elaborata dopo il POST cancellerebbe la riga appena riscritta.
 *    `inviaToken` aspetta quindi `disattivazioniInVolo` prima del primo POST;
 *  - la conferma della DELETE non deve cancellare la copia locale del token che la riattivazione ha
 *    appena ricordato: senza quella copia il logout di dopo non avrebbe più niente da cancellare.
 *    `dimenticaToken` scatta solo se il token ricordato è di una generazione PRECEDENTE alla
 *    disattivazione (`generazioneToken`).
 */
const disattivazioniInVolo = new Set<Promise<void>>()
let generazioneToken = 0

/** L'esito di un invio superato da una disattivazione: non è un guasto, è la scelta dell'utente. */
const ESITO_DISATTIVATO: Esito = Object.freeze({ ok: false, error: 'unregistered' })

function aspetta(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Com'è finita una richiesta con tetto: la risposta, oppure l'errore e se era la NOSTRA scadenza. */
type EsitoRichiesta =
  | { res: Response; errore: null; causa: null }
  | { res: null; errore: unknown; causa: string }

/**
 * Una `fetch` a una nostra route con il tetto di `TETTO_RICHIESTA_SUBSCRIBE_MS`. Non lancia mai:
 * restituisce la risposta o l'errore, con la `causa` già pronta per il log.
 *
 * `scaduto` distingue la nostra scadenza da un abort di altra origine: il nome dell'errore che
 * arriva non è affidabile (con `abort()` senza motivo, o su WebView vecchie, è un generico
 * `AbortError`). Il timer si ripulisce nel `finally`: una risposta arrivata in tempo non lascia
 * niente di armato. Senza `AbortController` (WebView antichissime) si parte senza tetto invece di
 * non partire.
 *
 * La `fetch` parte nello stesso giro della chiamata (nessun `await` prima): un token ruotato arriva
 * al server nello stesso giro in cui il sistema lo consegna.
 */
async function fetchConTetto(url: string, init: RequestInit): Promise<EsitoRichiesta> {
  const controllore = typeof AbortController === 'function' ? new AbortController() : null
  let scaduto = false
  const tetto = controllore
    ? setTimeout(() => {
        scaduto = true
        controllore.abort()
      }, TETTO_RICHIESTA_SUBSCRIBE_MS)
    : null
  try {
    const res = await fetch(url, { ...init, ...(controllore ? { signal: controllore.signal } : {}) })
    return { res, errore: null, causa: null }
  } catch (e) {
    return {
      res: null,
      errore: e,
      causa: scaduto ? `nessuna risposta entro ${TETTO_RICHIESTA_SUBSCRIBE_MS} ms` : nomeErrore(e),
    }
  } finally {
    if (tetto !== null) clearTimeout(tetto)
  }
}

/**
 * Invia il token al server, con i ritentativi. `warn` al PRIMO fallimento ritentabile (l'esito vero
 * arriva dopo), `error` solo quando i tentativi sono finiti o il server ha risposto con un rifiuto
 * vero (4xx).
 *
 * IL SUCCESSO NON SI LOGGA DA QUI, e non è una deroga alla regola 5 di AGENTS.md. Il successo di
 * questa operazione **è** una riga in `push_subscriptions`: una traccia durevole e interrogabile,
 * più forte di un log — è esattamente quella che il 2026-08-04 ha detto, contandola a zero, che
 * nessun iPhone si era mai registrato. Dal client `info` non passa: una riga di successo
 * significherebbe spedirla come `warn`, un successo travestito da anomalia.
 */
async function inviaToken(token: string, userId: string | null, generazioneIniziale: number): Promise<Esito> {
  const tentativiTotali = ATTESE_RITENTATIVO_SUBSCRIBE_MS.length + 1
  // Vedi `generazione`: una disattivazione arrivata durante i ritentativi chiude il ciclo. La
  // generazione è quella dell'ascoltatore che ha ricevuto il token, non quella di adesso.
  // Le DELETE ancora in volo passano PRIMA (vedi `disattivazioniInVolo`); non rifiutano mai.
  if (disattivazioniInVolo.size > 0) await Promise.all([...disattivazioniInVolo])
  for (let tentativo = 0; ; tentativo++) {
    // Controllo PRIMA di ogni POST, cioè anche dopo ogni `aspetta(...)`. Nessun log: è una scelta.
    if (generazione !== generazioneIniziale) return ESITO_DISATTIVATO
    // Ogni tentativo ha il SUO tetto (vedi `TETTO_RICHIESTA_SUBSCRIBE_MS`).
    const esito = await fetchConTetto('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}) },
      body: JSON.stringify({ token, platform: Capacitor.getPlatform() }),
    })
    if (generazione !== generazioneIniziale) {
      // La POST era già in volo quando è arrivata la disattivazione: la sua risposta non vale più
      // come esito. Se il server l'ha accettata, la riga può essere tornata dopo la DELETE — e la
      // copia locale del token non c'è più. Non si può cancellarla da qui senza rischiare di
      // togliere quella di una riattivazione partita nel frattempo: si lascia la traccia.
      if (esito.res?.ok) {
        logClient({
          livello: 'warn',
          evento: 'push',
          messaggio: 'push-nativa-registrata-dopo-disattivazione: POST in volo accettata dopo la DELETE',
        })
      }
      return ESITO_DISATTIVATO
    }
    if (esito.res?.ok) return { ok: true }
    const stato = esito.res?.status

    const ritentabile = esito.res === null || (stato !== undefined && stato >= 500)
    if (!ritentabile) {
      // Lo STATO è il dato che distingue una sessione scaduta (401) da un corpo rifiutato (400):
      // senza, «subscribe_failed» non dice niente a nessuno.
      logClient({
        livello: 'error',
        evento: 'push',
        messaggio: 'push-nativa-non-registrata: il server ha rifiutato il token',
        stato,
        campi: { tentativi: tentativo + 1 },
      })
      return { ok: false, error: 'subscribe_failed' }
    }

    const causa = esito.causa ?? `http ${stato}`
    if (tentativo + 1 >= tentativiTotali) {
      logClient({
        livello: 'error',
        evento: 'push',
        messaggio: `push-nativa-non-registrata: ritentativi esauriti (${causa})`,
        ...(stato !== undefined ? { stato } : {}),
        campi: { tentativi: tentativiTotali },
      })
      return { ok: false, error: 'subscribe_failed' }
    }
    if (tentativo === 0) {
      // Lo stato HTTP va in `campi`, MAI in `stato` (giro 5 del critico): `logClient` applica
      // `livelloEvento` a ogni `stato` fra 400 e 599, e con un 503 il `warn` dichiarato uscirebbe
      // `error` — il primo fallimento conterebbe per `controlloTassoErrore` di /api/health come un
      // guasto finito. I `campi` la politica dei livelli non li guarda.
      logClient({
        livello: 'warn',
        evento: 'push',
        messaggio: `push-nativa-registrazione-ritento: ${causa}`,
        campi: {
          tentativi_previsti: tentativiTotali,
          ...(stato !== undefined ? { stato_http: stato } : {}),
        },
      })
    }
    await aspetta(ATTESE_RITENTATIVO_SUBSCRIBE_MS[tentativo])
  }
}

/**
 * GLI ASCOLTATORI DELLA REGISTRAZIONE: UNA COPPIA SOLA PER SESSIONE (2026-09-15, 2026-09-24).
 *
 * Prima ogni `registerNativePush` agganciava la sua coppia `registration`/`registrationError`: con
 * l'automatica all'accesso più «attiva» in PushOptIn erano due coppie, e ogni rotazione del token
 * partiva DUE volte verso `/api/push/subscribe`. Ora la guardia è di modulo: si aggancia una volta,
 * e le chiamate successive si mettono in coda sull'esito (`inAttesa`).
 *
 * Si tolgono in `unregisterNativePush` e, se l'aggancio fallisce, in `scartaAscoltatori`; ognuna
 * con la sua `remove()`, mai con `removeAllListeners()`, che spegne anche il tocco sulle notifiche
 * agganciato da `setupNativeShell`.
 *
 * ⚠️ NON si tolgono all'esito della registrazione. Su Android `onNewToken` emette `registration`
 * anche ad app aperta, quando FCM ruota il token: senza l'ascoltatore il token nuovo non
 * arriverebbe più a `/api/push/subscribe`, e le notifiche smetterebbero di arrivare in silenzio.
 */
let ascoltatoriRegistrazione: Array<Promise<PluginListenerHandle>> | null = null

/**
 * Chi aspetta l'esito della registrazione in corso, col SUO timer di `ATTESA_REGISTRAZIONE_MS`:
 * ognuno riceve il primo esito che arriva. Il timer è `null` quando il sistema ha già consegnato il
 * token (vedi `fermaTimerAttesa`).
 */
const inAttesa = new Map<(r: Esito) => void, ReturnType<typeof setTimeout> | null>()

/** Il fallback legacy dell'identità: quello dell'ultima chiamata vale anche per i token ruotati. */
let ultimoUserId: string | null = null

function consegnaEsito(r: Esito): void {
  for (const risolvi of [...inAttesa.keys()]) risolvi(r)
}

/**
 * IL TIMER MISURA APNs/FCM, NON IL NOSTRO SERVER (giro 2 del critico, 2026-09-25).
 *
 * I 20 s di `ATTESA_REGISTRAZIONE_MS` sono l'attesa del SISTEMA: token o errore. Quando il token
 * arriva quell'attesa è finita, e da lì in poi l'esito lo decide `inviaToken` — che coi ritentativi
 * spende già 10 s di sole attese (2 s + 8 s) più tre fetch. Finché il timer restava acceso, un POST
 * lento o un 504 del deploy bastavano a far scattare «nessun token e nessun errore» con il token in
 * mano, e PushOptIn lasciava l'interruttore spento anche se il terzo POST andava a buon fine un
 * attimo dopo. Si fermano i timer, NON si tolgono le attese: l'esito vero arriva da `consegnaEsito`.
 */
function fermaTimerAttesa(): void {
  for (const [risolvi, timer] of inAttesa) {
    if (timer !== null) {
      clearTimeout(timer)
      inAttesa.set(risolvi, null)
    }
  }
}

/**
 * OGNI COPPIA DI ASCOLTATORI APPARTIENE ALLA SUA GENERAZIONE (giro 6 del critico, 2026-09-25).
 *
 * `unregisterNativePush` sale di generazione e riapre la guardia SUBITO, ma le maniglie si tolgono
 * solo dopo la DELETE (fino a 15 s) e le `remove()` sul bridge. In quella finestra il sistema può
 * ancora consegnare un token — FCM che lo ruota, o il `register()` appena chiesto — e un ascoltatore
 * disattivato che lo ricordasse e lo spedisse riscriverebbe la riga dopo «disattiva» o dopo il
 * logout. Un ascoltatore di una generazione superata non ferma timer, non ricorda, non invia e non
 * consegna esiti: se nel frattempo è partita una riattivazione, se ne occupa la SUA coppia.
 */
function agganciaAscoltatori(PushNotifications: PushNotificationsPlugin): Array<Promise<PluginListenerHandle>> {
  if (ascoltatoriRegistrazione) return ascoltatoriRegistrazione
  const gen = generazione
  ascoltatoriRegistrazione = [
    PushNotifications.addListener('registration', (token) => {
      if (generazione !== gen) return
      fermaTimerAttesa()
      ricordaToken(token.value)
      void inviaToken(token.value, ultimoUserId, gen).then((r) => {
        // Un invio superato da una disattivazione non consegna niente: chi aspettava quel giro l'ha
        // già chiuso `unregisterNativePush`, e chi aspetta ORA è una riattivazione partita dopo,
        // che deve ricevere l'esito del SUO token, non «disattivato» né il successo di un altro.
        if (r !== ESITO_DISATTIVATO) consegnaEsito(r)
      })
    }),
    PushNotifications.addListener('registrationError', (err) => {
      if (generazione !== gen) return
      // Il messaggio del sistema è l'unica cosa che spiega un fallimento APNs
      // (`aps-environment` sbagliato, dispositivo senza rete, profilo non abilitato):
      // buttarlo via è il difetto descritto dalla regola 3, applicata a un provider
      // che qui è il sistema operativo. `warn`: il sistema può ancora consegnare un token dopo.
      const dettaglio = String((err as { error?: string })?.error ?? 'registration_error')
      logClient({
        livello: 'warn',
        evento: 'push',
        messaggio: `push-nativa-registrazione-fallita: ${dettaglio}`,
      })
      consegnaEsito({ ok: false, error: dettaglio })
    }),
  ]
  return ascoltatoriRegistrazione
}

/**
 * UN AGGANCIO FALLITO NON SI TIENE (giro 3 del critico, 2026-09-25).
 *
 * La guardia di `agganciaAscoltatori` conserva le PROMISE di `addListener`. Se una rifiuta (bridge o
 * plugin rotto) e la guardia la conservasse, ogni `registerNativePush` successivo della sessione
 * riprenderebbe la stessa promise rifiutata: `register()` non partirebbe mai più, e nessun nuovo
 * tentativo — nemmeno quello al ritorno in primo piano — potrebbe guarire fino al riavvio dell'app.
 * È lo stesso trattamento dell'import del modulo in `caricaModuloPush`.
 *
 * La guardia si riapre SUBITO (in modo sincrono, prima che chi aspetta riceva l'esito), e solo se è
 * ancora quella fallita: una coppia nuova agganciata nel frattempo non si tocca. Le maniglie che ce
 * l'hanno fatta si tolgono, altrimenti al tentativo dopo sarebbero due ascoltatori `registration`
 * e ogni rotazione del token partirebbe due volte. Toglie SOLO chi ha riaperto la guardia: con due
 * chiamate in attesa sulla stessa coppia, la seconda non ritoglie le stesse maniglie.
 */
function scartaAscoltatori(falliti: Array<Promise<PluginListenerHandle>>): void {
  if (ascoltatoriRegistrazione !== falliti) return
  ascoltatoriRegistrazione = null
  void Promise.allSettled(falliti).then(async (esiti) => {
    for (const esito of esiti) {
      if (esito.status !== 'fulfilled') continue
      try {
        await esito.value.remove()
      } catch (e) {
        // `warn`: il tentativo dopo aggancia comunque; il danno possibile è un doppio invio del
        // token alla prossima rotazione, non una funzione spenta.
        logClient({
          livello: 'warn',
          evento: 'push',
          messaggio: `push-nativa-ascoltatore-non-rimosso: ${nomeErrore(e)}`,
        })
      }
    }
  })
}

/**
 * Il nome del canale nella lingua della pagina; italiano se la pagina non la dichiara. Nessun
 * try/catch: si arriva qui solo dentro la shell nativa (dopo `isNativeApp()`), dove `document`
 * esiste sempre.
 */
function nomeCanale(): string {
  const lingua = document.documentElement.lang
  if (lingua && lingua.toLowerCase().startsWith('en')) return commonEn.canaleNotificheAndroid
  return commonIt.canaleNotificheAndroid
}

/**
 * IL CANALE ANDROID SI CREA DA QUI, PRIMA DI `register()` (2026-09-24).
 *
 * Misurato: il canale non veniva mai creato, e ogni notifica finiva in «Miscellaneous», con
 * l'importanza predefinita — niente banner, contenuto nascosto a schermo bloccato. `createChannel`
 * è idempotente (con lo stesso id Android aggiorna solo nome e descrizione), quindi si chiama a ogni
 * registrazione senza danni. L'id è quello che il server scrive in `channel_id` (`canale-android.ts`).
 *
 * - importanza 4 = alta: suono e banner in testa allo schermo;
 * - visibilità 1 = pubblica: il contenuto si legge anche a schermo bloccato (decisione del titolare);
 * - vibrazione accesa; suono non indicato = quello predefinito del sistema.
 *
 * Un fallimento NON ferma la registrazione: le notifiche arrivano lo stesso, solo nel canale di
 * riserva. Ma è un `error`, perché quello è esattamente il difetto che questo codice chiude.
 *
 * TRANNE SU ANDROID 7 E 7.1 (API 24-25, giro 3 del critico). `minSdkVersion` è 24, e prima di
 * Android 8 i canali non esistono: il plugin risponde `call.unavailable()` (codice `UNAVAILABLE`,
 * messaggio «not available»). Lì le notifiche non finiscono in «Miscellaneous» — non c'è nessun
 * canale in cui finire — e un `error` a ogni avvio per un difetto che non c'è si mescolerebbe ai
 * guasti veri. Si scrive un `warn` UNA volta per installazione (serve a sapere quanti telefoni
 * sono così vecchi, non a ripeterlo), e la registrazione va avanti.
 */
const CANALE_NON_PREVISTO_KEY = 'kv_push_canale_non_previsto'

/** Il rifiuto che il plugin dà sotto Android 8: `PluginCall.unavailable()`. */
function canaleNonPrevisto(e: unknown): boolean {
  const errore = e as { code?: unknown; message?: unknown } | null
  return errore?.code === 'UNAVAILABLE' || errore?.message === 'not available'
}

function segnalaCanaleNonPrevisto(): void {
  // Storage negato: si scrive la riga lo stesso, con `ricordato: false` — meglio ripeterla a ogni
  // avvio su pochi telefoni che perdere l'unica traccia di quanti sono.
  let ricordato: boolean
  try {
    if (window.localStorage.getItem(CANALE_NON_PREVISTO_KEY) === '1') return
    window.localStorage.setItem(CANALE_NON_PREVISTO_KEY, '1')
    ricordato = true
  } catch {
    ricordato = false
  }
  logClient({
    livello: 'warn',
    evento: 'push',
    messaggio: 'push-nativa-canale-non-previsto: Android senza canali di notifica (API < 26)',
    campi: { ricordato },
  })
}

async function creaCanaleAndroid(PushNotifications: PushNotificationsPlugin): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') return
  try {
    await PushNotifications.createChannel({
      id: CANALE_ANDROID_NOTIFICHE,
      name: nomeCanale(),
      importance: 4,
      visibility: 1,
      vibration: true,
    })
  } catch (e) {
    if (canaleNonPrevisto(e)) {
      segnalaCanaleNonPrevisto()
      return
    }
    logClient({
      livello: 'error',
      evento: 'push',
      messaggio: `push-nativa-canale-non-creato: ${nomeErrore(e)}`,
    })
  }
}

/**
 * Il permesso è stato negato: si scrive UNA volta per installazione (vedi `RIFIUTO_REGISTRATO_KEY`)
 * e si cancella la registrazione del token sul server, per la stessa via di «disattiva» in PushOptIn.
 * Un dispositivo che ha detto no non deve restare in `push_subscriptions`: il dispatch gli
 * manderebbe notifiche che il sistema butta, e il conteggio dei «raggiunti» mentirebbe.
 */
async function gestisciRifiuto(stato: string): Promise<void> {
  if (!rifiutoGiaRegistrato()) {
    const ricordato = segnaRifiutoRegistrato()
    // `warn` e non `error`: è una scelta legittima dell'utente, non un guasto — ma spegne una
    // funzione intera, ed è la prima spiegazione da escludere quando le notifiche «non arrivano».
    logClient({
      livello: 'warn',
      evento: 'push',
      messaggio: `push-nativa-permesso-negato: ${stato}`,
      campi: { ricordato },
    })
  }
  await unregisterNativePush()
}

/**
 * Controlla il permesso (e lo chiede solo se si può ancora chiedere), crea il canale Android,
 * registra la push nativa e invia il token a /api/push/subscribe con la piattaforma. No-op (con
 * esito) su web.
 *
 * `checkPermissions` PRIMA di `requestPermissions`: con il permesso già negato non si chiede più
 * niente e si esce subito, senza rifare ogni volta la strada del dialogo.
 *
 * OGNI ESITO LASCIA UNA TRACCIA (regole 5 e 6 di AGENTS.md): il 2026-08-04 in `push_subscriptions`
 * non esisteva NESSUNA riga `ios`, e del tentativo non era rimasta traccia da nessuna parte.
 *
 * Il token NON entra nei log: è l'indirizzo del dispositivo, e a chi legge basta sapere se il token
 * c'è stato e se il server l'ha accettato.
 */
export async function registerNativePush(userId?: string | null): Promise<Esito> {
  if (!isNativeApp()) return { ok: false, error: 'not_native' }
  const disponibilita = pluginPushDisponibile()
  // Bridge che lancia: la riga l'ha già scritta `pluginPushDisponibile`, e NON è un difetto di build.
  if (disponibilita === 'bridge-illeggibile') return { ok: false, error: 'plugin_unavailable' }
  if (disponibilita === 'assente') {
    // Una shell nativa senza il plugin push è un difetto di build, non una scelta: `error`.
    logClient({
      livello: 'error',
      evento: 'push',
      messaggio: 'push-nativa-plugin-assente: PushNotifications non disponibile nel binario',
    })
    return { ok: false, error: 'plugin_unavailable' }
  }
  try {
    const { PushNotifications } = await caricaModuloPush()

    // SOLO `denied` è un rifiuto (giro 2 del critico, 2026-09-25). Prima ogni stato diverso da
    // `granted` finiva in `gestisciRifiuto`: un valore mai dichiarato dal plugin diventava
    // «permesso-negato» e cancellava il token, e un dialogo chiuso senza scegliere accendeva il flag
    // «una volta per installazione» — così il `denied` vero, arrivato dopo, non veniva mai scritto.
    let grezzo: unknown = (await PushNotifications.checkPermissions()).receive
    let permesso = normalizzaPermesso(grezzo)
    if (permesso === 'prompt') {
      grezzo = (await PushNotifications.requestPermissions()).receive
      permesso = normalizzaPermesso(grezzo)
    }
    if (permesso === 'non-disponibile') {
      // Un'anomalia del plugin, non una scelta dell'utente: niente flag, niente DELETE del token.
      // Il valore grezzo è una parola del bridge (mai un dato personale), accorciato per sicurezza.
      logClient({
        livello: 'error',
        evento: 'push',
        messaggio: `push-nativa-permesso-illeggibile: ${String(grezzo).slice(0, 40)}`,
      })
      return { ok: false, error: 'plugin_error' }
    }
    if (permesso === 'denied') {
      await gestisciRifiuto(permesso)
      return { ok: false, error: 'permission_denied' }
    }
    if (permesso === 'prompt') {
      // Qui si arriva solo DOPO `requestPermissions`. Dialogo chiuso senza scegliere: non è un
      // rifiuto. Il flag resta spento e il token al suo posto; al prossimo avvio si chiede di nuovo,
      // com'è giusto. `warn` perché la funzione resta spenta fino ad allora — e senza riga «non
      // arriva niente» non avrebbe spiegazione.
      logClient({
        livello: 'warn',
        evento: 'push',
        messaggio: 'push-nativa-permesso-rimandato: dialogo chiuso senza scelta',
      })
      return { ok: false, error: 'permission_denied' }
    }
    dimenticaRifiuto()

    await creaCanaleAndroid(PushNotifications)

    if (userId) ultimoUserId = userId

    return await new Promise<Esito>((resolve) => {
      // L'attesa si mette in coda PRIMA di agganciare gli ascoltatori e di chiamare `register()`:
      // un token consegnato subito non deve trovare la coda vuota.
      const risolvi = (r: Esito) => {
        if (!inAttesa.has(risolvi)) return
        const timer = inAttesa.get(risolvi)
        inAttesa.delete(risolvi)
        if (timer) clearTimeout(timer)
        resolve(r)
      }
      const scaduta = setTimeout(() => {
        // `warn`: l'esito può ancora arrivare dopo (il token consegnato in ritardo passa comunque
        // dall'ascoltatore, che resta agganciato e lo manda al server).
        logClient({
          livello: 'warn',
          evento: 'push',
          messaggio: `push-nativa-senza-esito: nessun token e nessun errore entro ${ATTESA_REGISTRAZIONE_MS} ms`,
        })
        risolvi({ ok: false, error: 'registration_timeout' })
      }, ATTESA_REGISTRAZIONE_MS)
      inAttesa.set(risolvi, scaduta)

      const ascoltatori = agganciaAscoltatori(PushNotifications)
      void Promise.all(ascoltatori).then(
        () =>
          PushNotifications.register().catch((e: unknown) => {
            logClient({
              livello: 'error',
              evento: 'push',
              messaggio: `push-nativa-register-fallita: ${nomeErrore(e)}`,
            })
            risolvi({ ok: false, error: 'plugin_error' })
          }),
        (e: unknown) => {
          // La guardia si riapre PRIMA dell'esito: chi riprova appena lo riceve deve riagganciare.
          scartaAscoltatori(ascoltatori)
          logClient({
            livello: 'error',
            evento: 'push',
            messaggio: `push-nativa-ascoltatori-non-agganciati: ${nomeErrore(e)}`,
          })
          risolvi({ ok: false, error: 'plugin_error' })
        },
      )
    })
  } catch (e) {
    logClient({
      livello: 'error',
      evento: 'push',
      messaggio: `push-nativa-plugin-non-utilizzabile: ${nomeErrore(e)}`,
    })
    return { ok: false, error: 'plugin_error' }
  }
}

/**
 * Disattiva la push nativa di QUESTO dispositivo: rimuove la riga lato server e
 * gli ascoltatori della registrazione — solo quelli, non il tocco sulle notifiche
 * (vedi `ascoltatoriRegistrazione`). La chiamano l'opt-in (il genitore che spegne i
 * promemoria), il LOGOUT (`doLogout`) e il permesso negato (`gestisciRifiuto`).
 *
 * ⚠️ `DELETE /api/push/subscribe` passa da `requireUser`: senza sessione risponde
 * 401 e il token resta registrato. Va quindi chiamata PRIMA di `auth.signOut()`.
 *
 * L'esito NON si butta via (regola 6 di AGENTS.md, e regola 3 sul corpo delle
 * risposte altrui). Il token locale si dimentica SOLO se il server ha confermato: se la
 * `DELETE` fallisce, la copia resta e il prossimo tentativo avrà ancora
 * l'indirizzo da cancellare.
 */
export async function unregisterNativePush(): Promise<void> {
  if (!isNativeApp()) return
  // LA DISATTIVAZIONE VALE DAL PRIMO ISTANTE (giro 6 del critico): tutto ciò che la rende effettiva
  // lato client avviene QUI, in modo sincrono, prima della DELETE — che può durare fino a 15 s.
  //  - la generazione sale: un `inviaToken` che si risveglia da un'attesa non rifà il POST, e gli
  //    ascoltatori agganciati finora diventano inerti (vedi `agganciaAscoltatori`);
  //  - la guardia si riapre: una riattivazione partita durante la DELETE aggancia una coppia NUOVA,
  //    invece di riprendersi quella che sta per essere tolta;
  //  - chi aspettava un esito lo riceve ora, invece di scadere con un «senza esito» che
  //    racconterebbe un guasto mai avvenuto — e una riattivazione arrivata dopo non lo riceve.
  generazione++
  const generazioneDisattivazione = generazione
  const maniglie = ascoltatoriRegistrazione ?? []
  ascoltatoriRegistrazione = null
  consegnaEsito(ESITO_DISATTIVATO)
  // La DELETE si fa aspettare dai POST di una riattivazione (vedi `disattivazioniInVolo`) SOLO finché
  // è in volo: si libera appena finita, bene o male, e non aspetta le `remove()` sul bridge.
  let fineDelete: () => void = () => undefined
  const deleteInVolo = new Promise<void>((r) => {
    fineDelete = r
  })
  disattivazioniInVolo.add(deleteInVolo)
  const liberaPost = () => {
    disattivazioniInVolo.delete(deleteInVolo)
    fineDelete()
  }
  try {
    const token = tokenDaDisattivare()
    if (token) {
      // Con il tetto (vedi `TETTO_RICHIESTA_SUBSCRIBE_MS`): chi aspetta questa DELETE — il
      // permesso negato dentro `registerNativePush`, «disattiva», il logout — non resta fermo su
      // una rete che tace.
      const { res, causa } = await fetchConTetto(
        `/api/push/subscribe?endpoint=${encodeURIComponent(token)}`,
        { method: 'DELETE' },
      )
      if (res === null) {
        logClient({
          livello: 'error',
          evento: 'push',
          messaggio: `push-token-non-rimosso: ${causa}`,
        })
      } else if (!res.ok) {
        logClient({
          livello: 'error',
          evento: 'push',
          messaggio: 'push-token-non-rimosso: il server ha rifiutato la disattivazione',
          stato: res.status,
        })
      }
      // Solo il token ricordato PRIMA di questa disattivazione: quello di una riattivazione partita
      // durante la DELETE è la copia che servirà al prossimo logout (vedi `generazioneToken`).
      if (res?.ok && generazioneToken < generazioneDisattivazione) dimenticaToken()
    }
    liberaPost()
    // Non `removeAllListeners()`: spegneva anche il tocco sulle notifiche. Si tolgono le maniglie
    // agganciate da `registerNativePush`, ognuna con la sua `remove()`. Fino a qui sono rimaste
    // agganciate ma inerti: la generazione è già cambiata.
    await Promise.all(maniglie.map(async (maniglia) => (await maniglia).remove()))
  } catch (e) {
    // best-effort: la disattivazione non deve mai lanciare — ma non deve nemmeno
    // sparire. Qui ci si arriva col plugin rotto: un ascoltatore della registrazione
    // che non si toglie resta agganciato. È inerte (la sua generazione è superata), ma
    // resta un ascoltatore in più sul bridge per tutta la sessione.
    logClient({
      livello: 'error',
      evento: 'push',
      messaggio: `push-disattivazione-fallita: ${nomeErrore(e)}`,
    })
  } finally {
    // Idempotente: copre anche l'eccezione arrivata prima della fine della DELETE.
    liberaPost()
  }
}
