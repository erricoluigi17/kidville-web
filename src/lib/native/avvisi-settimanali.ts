import { Capacitor } from '@capacitor/core'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { isNativeApp, statoPermessoPush } from '@/lib/push/native-register'
import { URL_APP_STORE, URL_PLAY_STORE } from '@/lib/email/tema'

/**
 * GLI AVVISI SETTIMANALI DELL'APP NATIVA (spec 2026-09-24, compito AV1).
 *
 * Due avvisi, ciascuno AL MASSIMO UNA VOLTA A SETTIMANA per installazione:
 *  - `aggiorna-app`: il binario è il vecchio 1.0 — lo si riconosce perché il plugin
 *    `FileTransfer`, arrivato con la 1.1, non c'è. Su quel binario i download ripiegano
 *    (misurato: 1.941 ripieghi e 0 scarichi nativi riusciti in 30 giorni), e l'unico rimedio è
 *    aggiornare dallo store — ma solo quando la 1.1 C'È, sullo store di quella piattaforma
 *    (`APP_1_1_PUBBLICATA`, spento finché non la si vede pubblicata);
 *  - `notifiche-disattivate`: il permesso delle notifiche è `denied` (`statoPermessoPush`, che
 *    usa `checkPermissions` e non fa MAI comparire il dialogo di sistema). Misurato: 26 utenti
 *    in 7 giorni avevano il permesso negato.
 *
 * LA DATA DELL'ULTIMA COMPARSA sta nel `localStorage` dell'installazione, come `kv_push_token`:
 * non è identità, è un orario sul telefono, e resta fuori da `LOCAL_KEYS` di `logout.ts` (chi
 * esce e rientra non deve rivedere l'avviso il giorno stesso).
 *
 * UNO STORAGE CHE NON RISPONDE SPEGNE L'AVVISO, non lo ripete. «Al massimo una volta a
 * settimana» è il vincolo: senza un posto dove scrivere la data, mostrarlo vorrebbe dire
 * mostrarlo a ogni avvio. La data si scrive PRIMA di mostrare: se la scrittura fallisce,
 * l'avviso non compare.
 */

/** Sette giorni: la cadenza massima di ciascun avviso. */
export const INTERVALLO_AVVISO_MS = 7 * 24 * 60 * 60 * 1000

export type AvvisoSettimanale = 'aggiorna-app' | 'notifiche-disattivate'

/** Una chiave per avviso: ciascuno ha la sua settimana. */
export const CHIAVI_ULTIMA_COMPARSA: Readonly<Record<AvvisoSettimanale, string>> = Object.freeze({
  'aggiorna-app': 'kv_avviso_aggiorna_app_ultima',
  'notifiche-disattivate': 'kv_avviso_notifiche_ultima',
})

export type PiattaformaStore = 'ios' | 'android'

/**
 * LA 1.1 È GIÀ SULLO STORE? Un interruttore per piattaforma, e resta SPENTO finché qualcuno non
 * ha VISTO la 1.1 pubblicata sullo store di quella piattaforma: su iOS approvata da Apple e
 * scaricabile dalla scheda dell'App Store, su Android uscita in PRODUZIONE su Google Play (non nel
 * test chiuso, dove la scheda pubblica risponde 404).
 *
 * Perché esiste: il deploy web arriva PRIMA dei binari 1.1 (spec, «Fine»: passo 4 il deploy, passo
 * 6 build, revisione iOS e pubblicazione Android). Senza l'interruttore, dal merge in poi tutti
 * gli utenti 1.0 — cioè tutti — leggerebbero «È disponibile una nuova versione» mentre lo store
 * offre ancora la 1.0 (o una pagina 404), e l'avviso brucerebbe la sua settimana su un
 * aggiornamento che non esiste. Con l'interruttore spento la data NON si scrive: la settimana
 * resta intatta per quando la 1.1 ci sarà davvero.
 *
 * Si accende UNA piattaforma alla volta, con un commit che dice quando la si è vista sullo store,
 * e si aggiorna il test che fotografa questo valore (`__tests__/lib/avvisi-settimanali.test.ts`).
 */
export const APP_1_1_PUBBLICATA: Readonly<Record<PiattaformaStore, boolean>> = Object.freeze({
  ios: false,
  android: false,
})

/** Il plugin arrivato con la 1.1: la sua assenza è la firma del binario 1.0. */
const PLUGIN_APP_1_1 = 'FileTransfer'
/** Il plugin che apre le impostazioni del sistema (`capacitor-native-settings`). */
const PLUGIN_IMPOSTAZIONI = 'NativeSettings'

/**
 * Lo storage illeggibile si dice UNA volta per sessione: la stessa causa (modalità privata,
 * quota) si ripresenterebbe a ogni controllo, e ripeterla non aggiunge niente.
 */
let storageGiaSegnalato = false

function segnalaStorage(operazione: 'lettura' | 'scrittura', e: unknown): void {
  if (storageGiaSegnalato) return
  storageGiaSegnalato = true
  // `warn`: l'app funziona, solo l'avviso resta spento per questa sessione.
  logClient({
    livello: 'warn',
    evento: 'avvio',
    messaggio: `avviso-settimanale-storage-inutilizzabile: ${operazione} (${nomeErrore(e)})`,
  })
}

/**
 * `true` se l'avviso non è comparso negli ultimi sette giorni.
 *
 * - nessuna data, o una data illeggibile (non un numero): mai comparso → `true`;
 * - una data nel FUTURO (orologio del telefono spostato avanti e poi riportato indietro): senza
 *   questo ramo l'avviso resterebbe muto finché l'orologio non la raggiunge, anche per anni.
 *   Si tratta come scaduta, e la comparsa la riscrive con l'ora vera;
 * - storage che lancia: `false` (vedi la testa del file).
 */
export function avvisoScaduto(avviso: AvvisoSettimanale, ora: number = Date.now()): boolean {
  let grezzo: string | null
  try {
    grezzo = window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA[avviso])
  } catch (e) {
    segnalaStorage('lettura', e)
    return false
  }
  if (grezzo === null) return true
  const ultima = Number(grezzo)
  if (!Number.isFinite(ultima)) return true
  if (ultima > ora) return true
  return ora - ultima >= INTERVALLO_AVVISO_MS
}

/** Scrive l'ora della comparsa. `false` se lo storage l'ha rifiutata: l'avviso NON va mostrato. */
export function segnaComparsa(avviso: AvvisoSettimanale, ora: number = Date.now()): boolean {
  try {
    window.localStorage.setItem(CHIAVI_ULTIMA_COMPARSA[avviso], String(ora))
    return true
  } catch (e) {
    segnalaStorage('scrittura', e)
    return false
  }
}

/**
 * `true` se il plugin è registrato nel binario. Un bridge che LANCIA non è un plugin assente:
 * si scrive e si risponde `null`, e chi chiama non mostra niente (nel dubbio non si disturba).
 */
function pluginPresente(nome: string): boolean | null {
  try {
    return Capacitor.isPluginAvailable(nome)
  } catch (e) {
    logClient({
      livello: 'warn',
      evento: 'avvio',
      messaggio: `avviso-settimanale-bridge-illeggibile: ${nome} (${nomeErrore(e)})`,
    })
    return null
  }
}

/** `true` se l'app gira nella shell nativa del binario 1.0 (niente `FileTransfer`). */
export function binarioDaAggiornare(): boolean {
  if (!isNativeApp()) return false
  return pluginPresente(PLUGIN_APP_1_1) === false
}

/**
 * `true` se la 1.1 è pubblicata sullo store della piattaforma corrente (vedi
 * `APP_1_1_PUBBLICATA`). Una piattaforma illeggibile o diversa da iOS/Android vale `false`: nel
 * dubbio non si promette un aggiornamento.
 */
function aggiornamentoPubblicato(pubblicata: Readonly<Record<PiattaformaStore, boolean>>): boolean {
  let piattaforma: string
  try {
    piattaforma = Capacitor.getPlatform()
  } catch (e) {
    logClient({
      livello: 'warn',
      evento: 'avvio',
      messaggio: `avviso-aggiorna-app-piattaforma-illeggibile: ${nomeErrore(e)}`,
    })
    return false
  }
  if (piattaforma !== 'ios' && piattaforma !== 'android') return false
  return pubblicata[piattaforma] === true
}

/**
 * Quale avviso mostrare ADESSO, già segnato come comparso; `null` per nessuno.
 *
 * Uno alla volta, e l'aggiornamento prima: sul binario 1.0 manca anche il plugin delle
 * impostazioni, e l'aggiornamento risolve download e bottone insieme. L'avviso delle notifiche,
 * se è dovuto anch'esso, non viene segnato: comparirà a un avvio successivo, con la sua
 * settimana intatta. Due riquadri insieme sopra la barra di navigazione coprirebbero la pagina.
 *
 * «Aggiorna» parte solo se la 1.1 è davvero sullo store di QUESTA piattaforma
 * (`APP_1_1_PUBBLICATA`), e lo si controlla PRIMA di leggere o scrivere la data: con
 * l'interruttore spento la settimana non si consuma. Finché è spento, un binario 1.0 con le
 * notifiche negate vede l'avviso delle notifiche, col percorso a parole.
 *
 * La data si controlla PRIMA di chiedere il permesso al plugin: in sei giorni su sette non si
 * tocca il bridge.
 *
 * `pubblicata` si passa solo dai test; in produzione vale `APP_1_1_PUBBLICATA`.
 */
export async function avvisoDaMostrare(
  ora: number = Date.now(),
  pubblicata: Readonly<Record<PiattaformaStore, boolean>> = APP_1_1_PUBBLICATA,
): Promise<AvvisoSettimanale | null> {
  if (!isNativeApp()) return null
  if (binarioDaAggiornare() && aggiornamentoPubblicato(pubblicata) && avvisoScaduto('aggiorna-app', ora)) {
    return segnaComparsa('aggiorna-app', ora) ? 'aggiorna-app' : null
  }
  if (!avvisoScaduto('notifiche-disattivate', ora)) return null
  if ((await statoPermessoPush()) !== 'denied') return null
  return segnaComparsa('notifiche-disattivate', ora) ? 'notifiche-disattivate' : null
}

/** `true` se il binario sa aprire le impostazioni (1.1 in su). Sulla 1.0 si mostra il percorso a parole. */
export function impostazioniApribili(): boolean {
  if (!isNativeApp()) return false
  return pluginPresente(PLUGIN_IMPOSTAZIONI) === true
}

export type EsitoImpostazioni = 'aperte' | 'plugin-assente' | 'errore'

/**
 * Apre le impostazioni delle notifiche DELL'APP: su Android la pagina «Notifiche» di Kidville,
 * su iOS la pagina di Kidville nelle Impostazioni (l'unica che Apple supporta ufficialmente;
 * le altre voci del plugin usano schemi non documentati e rischiano il rifiuto in revisione).
 *
 * Il plugin si chiede al bridge PRIMA di importarlo (spec: nessun plugin si chiama senza
 * `isPluginAvailable`). Non lancia mai: l'esito lo decide chi mostra il percorso a parole.
 */
export async function apriImpostazioniNotifiche(): Promise<EsitoImpostazioni> {
  if (!impostazioniApribili()) return 'plugin-assente'
  try {
    const { NativeSettings, AndroidSettings, IOSSettings } = await import('capacitor-native-settings')
    const risposta = await NativeSettings.open({
      optionAndroid: AndroidSettings.AppNotification,
      optionIOS: IOSSettings.App,
    })
    if (risposta?.status === false) {
      logClient({
        livello: 'error',
        evento: 'push',
        messaggio: 'avviso-notifiche-impostazioni-non-aperte: il sistema ha risposto status=false',
      })
      return 'errore'
    }
    return 'aperte'
  } catch (e) {
    logClient({
      livello: 'error',
      evento: 'push',
      messaggio: `avviso-notifiche-impostazioni-non-aperte: ${nomeErrore(e)}`,
    })
    return 'errore'
  }
}

/** La scheda dello store per la piattaforma; `null` fuori da iOS e Android. */
export function urlSchedaStore(piattaforma: string): string | null {
  if (piattaforma === 'ios') return URL_APP_STORE
  if (piattaforma === 'android') return URL_PLAY_STORE
  return null
}

/**
 * Apre la scheda dello store. Una navigazione della pagina, e non `window.open`: nella shell
 * Capacitor una navigazione verso un host esterno viene annullata e consegnata al sistema
 * (`UIApplication.open` su iOS, `Intent.ACTION_VIEW` su Android), che la apre nell'App Store o
 * in Google Play. La pagina resta dov'è. `window.open` su iOS non fa niente.
 */
export function apriSchedaStore(
  apri: (url: string) => void = (url) => window.location.assign(url),
): string | null {
  let piattaforma: string
  try {
    piattaforma = Capacitor.getPlatform()
  } catch (e) {
    logClient({
      livello: 'error',
      evento: 'avvio',
      messaggio: `avviso-aggiorna-app-piattaforma-illeggibile: ${nomeErrore(e)}`,
    })
    return null
  }
  const url = urlSchedaStore(piattaforma)
  if (url) apri(url)
  return url
}
