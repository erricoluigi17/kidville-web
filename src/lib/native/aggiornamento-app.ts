import { Capacitor } from '@capacitor/core'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { isNativeApp } from '@/lib/push/native-register'
import { URL_APP_STORE, URL_PLAY_STORE } from '@/lib/email/tema'
import { conTettoDiTempo } from '@/lib/auth/errore-accesso'

/**
 * CHI DEVE AGGIORNARE L'APP (spec 2026-09-29, pop-up «Aggiorna l'app»).
 *
 * Si decide dalla VERSIONE del binario installato (`App.getInfo().version`, cioè
 * `CFBundleShortVersionString` su iOS e `versionName` su Android) contro una versione minima per
 * piattaforma. `@capacitor/app` c'è nel binario fin dalla 1.0 (luglio 2026, `CapacitorApp` in
 * `ios/App/CapApp-SPM/Package.swift` e `:capacitor-app` su Android), e i log di produzione portano
 * già `versione_app` `1.0+4` (iOS) e `1.0+1` (Android): la lettura funziona anche sui telefoni che
 * devono aggiornare.
 *
 * Prima del 2026-09-29 il binario vecchio si riconosceva dall'ASSENZA di un plugin arrivato con la
 * 1.1 (`FileTransfer`): valeva per un solo salto di versione. Con la minima, per la prossima
 * release basta alzare un numero.
 *
 * NEL DUBBIO NON SI DISTURBA. Una versione illeggibile, un plugin assente, un `getInfo` che rifiuta
 * o che resta appeso (su iOS un metodo che il binario non ha lascia la promise appesa in silenzio)
 * rispondono `null`, con una riga di log: mai un pop-up che promette un aggiornamento a chi l'ha
 * già fatto.
 */

export type PiattaformaStore = 'ios' | 'android'

/**
 * LA VERSIONE MINIMA, PER PIATTAFORMA. Sotto questa, il pop-up chiede di aggiornare.
 *
 * Si alza SOLO DOPO AVER VISTO la versione nuova pubblicata sullo store di quella piattaforma: su
 * iOS scaricabile dalla scheda dell'App Store, su Android uscita in PRODUZIONE su Google Play (non
 * nel test chiuso, dove la scheda pubblica risponde 404). Il deploy web arriva ai telefoni PRIMA
 * che Apple e Google pubblichino il binario: alzarla prima vorrebbe dire mandare tutti su una
 * scheda che offre ancora la versione vecchia. `null` spegne il pop-up su quella piattaforma.
 *
 * 1.1 verificata il 2026-09-29 su entrambi gli store: `itunes.apple.com/lookup?id=6794883055&country=it`
 * risponde `version 1.1` (rilascio 2026-09-25T19:51Z); la scheda Google Play di `it.kidville.app`
 * risponde `1.1`. Chi la alza aggiorna anche il test che fotografa questo valore
 * (`__tests__/lib/aggiornamento-app.test.ts`) e scrive nel commit quando l'ha vista sullo store.
 */
export const VERSIONE_MINIMA_STORE: Readonly<Record<PiattaformaStore, string | null>> = Object.freeze({
  ios: '1.1',
  android: '1.1',
})

/** Oltre questo tempo un `getInfo` senza risposta vale «versione illeggibile». */
export const TIMEOUT_VERSIONE_MS = 3000

const SEGMENTO = /^\d+$/

/**
 * Confronto numerico segmento per segmento: `-1` se `a` è più vecchia, `0` se uguale, `1` se più
 * nuova. `1.10` è più nuova di `1.9`, `1.1.0` vale `1.1`. `null` se una delle due non è fatta di soli
 * numeri separati da punti.
 */
export function confrontaVersioni(a: string, b: string): -1 | 0 | 1 | null {
  const pa = a.split('.')
  const pb = b.split('.')
  if (![...pa, ...pb].every((s) => SEGMENTO.test(s))) return null
  const lunghezza = Math.max(pa.length, pb.length)
  for (let i = 0; i < lunghezza; i++) {
    const x = Number(pa[i] ?? '0')
    const y = Number(pb[i] ?? '0')
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

function versioneIllegibile(motivo: string): null {
  // `warn`: l'app funziona, solo il pop-up resta spento per questa sessione.
  logClient({
    livello: 'warn',
    evento: 'avvio',
    messaggio: `avviso-aggiorna-app-versione-illeggibile: ${motivo}`,
  })
  return null
}

/**
 * Legge la versione del binario. Restituisce il RISULTATO di `getInfo`, mai il plugin: un plugin
 * Capacitor dentro una promise la lascia appesa (`App.then()` is not implemented — #166 → #168,
 * lock `plugin-capacitor-mai-risolto-da-promise`).
 */
async function leggiVersione(): Promise<string | 'timeout'> {
  const { App } = await import('@capacitor/app')
  // Il tetto è quello già condiviso del repo (lock `logging-tetto`): il bridge non accetta un
  // `AbortSignal`, quindi la chiamata non si annulla, si ABBANDONA.
  const esito = await conTettoDiTempo(App.getInfo(), TIMEOUT_VERSIONE_MS)
  return esito.scaduto ? 'timeout' : esito.valore.version
}

/**
 * Il binario installato è sotto la versione minima della sua piattaforma? Restituisce piattaforma
 * e versione installata, oppure `null` (aggiornato, web, piattaforma senza minima, o versione
 * illeggibile). Non lancia mai.
 *
 * `minime` si passa solo dai test; in produzione vale `VERSIONE_MINIMA_STORE`.
 */
export async function appDaAggiornare(
  minime: Readonly<Record<PiattaformaStore, string | null>> = VERSIONE_MINIMA_STORE,
): Promise<{ piattaforma: PiattaformaStore; versione: string } | null> {
  if (!isNativeApp()) return null
  let piattaforma: string
  try {
    piattaforma = Capacitor.getPlatform()
  } catch (e) {
    return versioneIllegibile(nomeErrore(e))
  }
  if (piattaforma !== 'ios' && piattaforma !== 'android') return null
  const minima = minime[piattaforma]
  if (minima === null) return null

  let versione: string | 'timeout'
  try {
    // Il plugin si chiede al bridge PRIMA di importarlo (spec 2026-09-24).
    if (!Capacitor.isPluginAvailable('App')) return versioneIllegibile('plugin-assente')
    versione = await leggiVersione()
  } catch (e) {
    return versioneIllegibile(nomeErrore(e))
  }
  if (versione === 'timeout') return versioneIllegibile('timeout')

  const confronto = confrontaVersioni(versione, minima)
  if (confronto === null) return versioneIllegibile('formato')
  return confronto < 0 ? { piattaforma, versione } : null
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
