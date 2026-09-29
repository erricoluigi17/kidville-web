import { Capacitor } from '@capacitor/core'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { isNativeApp, statoPermessoPush } from '@/lib/push/native-register'
import { appDaAggiornare } from '@/lib/native/aggiornamento-app'

/**
 * GLI AVVISI SETTIMANALI DELL'APP NATIVA (spec 2026-09-24, compito AV1).
 *
 * Ne resta uno, AL MASSIMO UNA VOLTA A SETTIMANA per installazione:
 *  - `notifiche-disattivate`: il permesso delle notifiche è `denied` (`statoPermessoPush`, che
 *    usa `checkPermissions` e non fa MAI comparire il dialogo di sistema). Misurato: 26 utenti
 *    in 7 giorni avevano il permesso negato.
 *
 * L'avviso `aggiorna-app` che stava qui (binario 1.0 riconosciuto dall'assenza di `FileTransfer`,
 * una volta a settimana, spento dall'interruttore `APP_1_1_PUBBLICATA`) è diventato il 2026-09-29
 * un pop-up a ogni apertura, deciso dalla VERSIONE del binario: `@/lib/native/aggiornamento-app`
 * e `AvvisoAggiornamentoApp`. Qui resta la sua precedenza: su un binario da aggiornare l'avviso
 * delle notifiche tace e non consuma la sua settimana.
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

export type AvvisoSettimanale = 'notifiche-disattivate'

/**
 * Una chiave per avviso: ciascuno ha la sua settimana. (`kv_avviso_aggiorna_app_ultima`, la
 * settimana del vecchio avviso «aggiorna», può restare nel `localStorage` dei telefoni che la
 * scrissero: non la legge più nessuno, e non è identità.)
 */
export const CHIAVI_ULTIMA_COMPARSA: Readonly<Record<AvvisoSettimanale, string>> = Object.freeze({
  'notifiche-disattivate': 'kv_avviso_notifiche_ultima',
})

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

/**
 * Quale avviso mostrare ADESSO, già segnato come comparso; `null` per nessuno.
 *
 * Uno alla volta, e l'aggiornamento prima: su un binario sotto la versione minima dello store
 * (`appDaAggiornare`) compare il pop-up «Aggiorna l'app», e l'aggiornamento porta anche il bottone
 * delle impostazioni. L'avviso delle notifiche allora non viene segnato: comparirà al primo avvio
 * dopo l'aggiornamento, con la sua settimana intatta.
 *
 * La data si controlla PRIMA di chiedere versione e permesso al bridge: in sei giorni su sette non
 * lo si tocca.
 */
export async function avvisoDaMostrare(ora: number = Date.now()): Promise<AvvisoSettimanale | null> {
  if (!isNativeApp()) return null
  if (!avvisoScaduto('notifiche-disattivate', ora)) return null
  if ((await appDaAggiornare()) !== null) return null
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
