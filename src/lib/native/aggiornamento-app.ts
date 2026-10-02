import { Capacitor } from '@capacitor/core'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { isNativeApp } from '@/lib/push/native-register'
import { URL_APP_STORE, URL_PLAY_STORE } from '@/lib/email/tema'
import { conTettoDiTempo } from '@/lib/auth/errore-accesso'
import { areeDeiProfili, type ConRuolo } from '@/lib/auth/active-role'
import { leggiProfili } from '@/lib/auth/use-profili'
import { isPublicPath } from '@/lib/auth/middleware-rules'

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
 *
 * DUE MINIME, E LA SECONDA È PER IL PERSONALE (spec 2026-10-02, PR 2 «video», compito T14).
 * `VERSIONE_MINIMA_STORE` vale per tutti. `VERSIONE_MINIMA_PERSONALE` vale SOLO per chi lavora con
 * l'app — chi può aprire l'area docente, dove si caricano i video — ed è la via con cui la 1.2
 * (l'invio dei video in background, PR 3) arriverà a loro senza disturbare le famiglie, che non la
 * usano. Nasce SPENTA: con `null` questo modulo si comporta esattamente come prima, e non fa nemmeno
 * una richiesta in più. Il ruolo si chiede solo a chi sta FRA le due minime (sotto quella del
 * personale, ma non sotto quella dello store): sotto la minima dello store il pop-up compare per
 * chiunque senza chiedere chi sia, come sempre.
 */

export type PiattaformaStore = 'ios' | 'android'

/** Una versione minima per piattaforma. `null` spegne il controllo su quella piattaforma. */
export type VersioniMinime = Readonly<Record<PiattaformaStore, string | null>>

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
export const VERSIONE_MINIMA_STORE: VersioniMinime = Object.freeze({
  ios: '1.1',
  android: '1.1',
})

/**
 * LA VERSIONE MINIMA PER IL PERSONALE, PER PIATTAFORMA. Sotto questa il pop-up compare SOLO a chi
 * lavora con l'app: docenti, Direzione, segreteria (`haProfiloDelPersonale`). Le famiglie non la
 * vedono mai: per loro vale `VERSIONE_MINIMA_STORE`, e basta.
 *
 * NASCE SPENTA (`null` su entrambe le piattaforme): è costruita prima della 1.2 perché il deploy
 * web non debba aspettare l'app. Si ACCENDE come l'altra, e alle stesse condizioni: SOLO DOPO AVER
 * VISTO la 1.2 pubblicata sullo store di quella piattaforma (iOS scaricabile dalla scheda, Android
 * uscita in PRODUZIONE su Google Play e non nel test chiuso). Poi si scrive `'1.2'` per quella
 * piattaforma, si aggiorna il test che fotografa questo valore
 * (`__tests__/lib/aggiornamento-app.test.ts`) e nel commit si scrive quando l'ha vista sullo store.
 * Niente build e niente altro codice.
 *
 * Una minima del personale PIÙ BASSA di quella dello store non cambia niente: chi è sotto la seconda
 * è già sotto la prima, e per lui il pop-up compare comunque.
 */
export const VERSIONE_MINIMA_PERSONALE: VersioniMinime = Object.freeze({
  ios: null,
  android: null,
})

/** Oltre questo tempo un `getInfo` senza risposta vale «versione illeggibile». */
export const TIMEOUT_VERSIONE_MS = 3000

/**
 * Oltre questo tempo la lettura del ruolo (`GET /api/me`, già in corso per i menu) vale «ruolo
 * illeggibile» e il pop-up resta spento: uno che compare con ritardo, mentre si sta già usando
 * l'app, disturba più di uno che non compare.
 */
export const TIMEOUT_RUOLO_MS = 5000

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
 * Fra questi profili c'è un ruolo che lavora con l'app? Cioè uno che può aprire l'area docente
 * (`educator`, `admin`, `coordinator`, `segreteria`): è la matrice che decide chi apre `/teacher`
 * (`AREE_PER_RUOLO` in `@/lib/auth/active-role`) e quindi chi carica i video, e si chiede a lei
 * invece di tenere una terza lista di ruoli da allineare a mano. La cuoca (solo l'area `admin`) e il
 * genitore no; un ruolo che la matrice non conosce non apre nessuna area, quindi non conta: nel
 * dubbio non si disturba.
 *
 * Sui ruoli REALI della persona (i `profili` di `/api/me`), non sulla veste che indossa adesso: chi è
 * docente e anche genitore di un bambino della scuola ha un solo telefono e un solo binario, e il
 * binario vecchio gli serve da docente anche quando in questo momento guarda l'app da genitore.
 */
export function haProfiloDelPersonale(profili: readonly ConRuolo[]): boolean {
  return areeDeiProfili(profili).includes('teacher')
}

function ruoloIllegibile(motivo: string): false {
  // `warn`: l'app funziona, solo il pop-up per il personale resta spento per questa sessione.
  logClient({
    livello: 'warn',
    evento: 'avvio',
    messaggio: `avviso-aggiorna-app-ruolo-illeggibile: ${motivo}`,
  })
  return false
}

/**
 * Chi sta usando l'app lavora con l'app? `true` solo se lo si SA. Non lancia mai e non aspetta oltre
 * `TIMEOUT_RUOLO_MS`: una lettura che rifiuta o che resta appesa vale `false`, con una riga di log.
 *
 * I profili si leggono da dove li leggono già i menu e la barra (`leggiProfili`: UNA `GET /api/me`
 * per sessione, condivisa — per chi è già dentro non costa una richiesta in più). `null` = non lo so
 * (rete giù, risposta illeggibile): vale `false` anche lui, e la riga di log l'ha già scritta chi ha
 * fatto la richiesta (`profili-non-letti` in `use-profili.ts`): qui non si ripete.
 *
 * SU UNA PAGINA PUBBLICA (l'accesso, i moduli) NON SI CHIEDE NIENTE. È dove si apre l'app chi non è
 * ancora dentro (il middleware manda al login chi non ha la sessione, e chi è dentro non parte da
 * una pagina pubblica): lì non c'è un ruolo da leggere, e la `GET /api/me` risponderebbe 401
 * scrivendo un `profili-non-letti` per un fatto previsto. Quella riga deve restare il segnale di un
 * `/api/me` che NON risponde a chi è già dentro, non essere sommersa dai telefoni che si aprono
 * sulla schermata di accesso. Chi parte da lì non ha ancora un ruolo: nel dubbio non si disturba.
 */
async function utenteDelPersonale(): Promise<boolean> {
  if (isPublicPath(window.location.pathname)) return false
  try {
    const esito = await conTettoDiTempo(leggiProfili(), TIMEOUT_RUOLO_MS)
    if (esito.scaduto) return ruoloIllegibile('timeout')
    return esito.valore !== null && haProfiloDelPersonale(esito.valore)
  } catch (e) {
    return ruoloIllegibile(nomeErrore(e))
  }
}

/**
 * Il binario installato è sotto la versione minima che lo riguarda? Restituisce piattaforma e
 * versione installata, oppure `null` (aggiornato, web, piattaforma senza minima, versione o ruolo
 * illeggibili, o un genitore su un binario che solo il personale deve aggiornare). Non lancia mai.
 *
 * LE DUE MINIME, IN ORDINE:
 *  1. sotto quella dello store, `minime`: per TUTTI, senza chiedere chi sia;
 *  2. sotto quella del personale, `minimePersonale`: solo se chi usa l'app lavora con l'app
 *     (`utenteDelPersonale`). Il ruolo si chiede qui e non prima: con la minima del personale
 *     spenta, o con un binario già alla pari, non parte nessuna richiesta.
 *
 * `minime` e `minimePersonale` si passano solo dai test; in produzione valgono
 * `VERSIONE_MINIMA_STORE` e `VERSIONE_MINIMA_PERSONALE`. (Anche `avvisoDaMostrare` lo chiama senza
 * argomenti: dove compare il pop-up, l'avviso settimanale delle notifiche tace, per il personale
 * come per tutti gli altri.)
 */
export async function appDaAggiornare(
  minime: VersioniMinime = VERSIONE_MINIMA_STORE,
  minimePersonale: VersioniMinime = VERSIONE_MINIMA_PERSONALE,
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
  const minimaDelPersonale = minimePersonale[piattaforma]
  // Entrambe spente: il bridge non si tocca.
  if (minima === null && minimaDelPersonale === null) return null

  let versione: string | 'timeout'
  try {
    // Il plugin si chiede al bridge PRIMA di importarlo (spec 2026-09-24).
    if (!Capacitor.isPluginAvailable('App')) return versioneIllegibile('plugin-assente')
    versione = await leggiVersione()
  } catch (e) {
    return versioneIllegibile(nomeErrore(e))
  }
  if (versione === 'timeout') return versioneIllegibile('timeout')

  if (minima !== null) {
    const confronto = confrontaVersioni(versione, minima)
    if (confronto === null) return versioneIllegibile('formato')
    if (confronto < 0) return { piattaforma, versione }
  }

  if (minimaDelPersonale === null) return null
  const confrontoPersonale = confrontaVersioni(versione, minimaDelPersonale)
  if (confrontoPersonale === null) return versioneIllegibile('formato')
  if (confrontoPersonale >= 0) return null
  return (await utenteDelPersonale()) ? { piattaforma, versione } : null
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
