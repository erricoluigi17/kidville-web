import { logClient, nomeErrore } from '@/lib/logging/client'
import { mimeBase } from './limiti'

/**
 * IL SELETTORE DI FOTO E VIDEO DELLA GALLERIA: il tetto e le tre tracce.
 *
 * ─── PERCHÉ ESISTE (richiesta del titolare, 2026-10-02, spec video PR 2 §11.1) ─────────
 *
 * Il titolare ha provato dall'iPhone, nell'app: «Scegli file dal dispositivo» → Libreria
 * foto → un video da 73 MB (circa 50 secondi). Il video non è mai arrivato alla pagina:
 * nessuna miniatura, nessun errore, e nessun log — il solo log di quel passaggio era
 * `gallery-file-selezione-rifiutata`, che parla di file ARRIVATI e scartati, mai di file
 * che non sono arrivati. Le ipotesi sono tre e da qui non si distinguono:
 *
 *  · «Aggiungi» non premuto nel selettore multiplo: l'utente tocca il video e chiude;
 *  · conversione di WebKit: iOS trascodifica il video prima di consegnarlo alla pagina, e
 *    per un file grosso ci mette dei minuti senza segni a schermo;
 *  · download da iCloud: il video non è sul telefono e il selettore lo scarica prima.
 *
 * Questo modulo non risolve nessuna delle tre: le RENDE LEGGIBILI. Ogni apertura del
 * selettore finisce con una riga «file ricevuti» o con una riga «chiuso senza file»; un'apertura
 * con la sola riga iniziale è già una risposta (la pagina non ha saputo né l'una né l'altra).
 * L'unica uscita senza nessuna delle due righe è la fotocamera che si rompe: ha il suo log
 * d'errore (`fotocamera-errore`, `fotocamera-permesso-negato`), e dichiararla «chiusa dall'utente»
 * falserebbe proprio il conteggio che si vuole leggere.
 *
 * ─── COME SI LEGGONO LE TRE IPOTESI ──────────────────────────────────────────────────
 *
 *  · «Aggiungi» non premuto → `chiuso-senza-file` e nient'altro;
 *  · conversione di WebKit → `chiuso-senza-file motivo=ritorno-senza-file`, poi
 *    `file-ricevuti tardivo=si` con `ms_da_ritorno` grande;
 *  · download da iCloud → `file-ricevuti` con `ms_da_apertura` grande e `ms_da_ritorno`
 *    piccolo o assente: l'attesa è avvenuta DENTRO il selettore.
 *
 * ─── LE REGOLE DEI LOG, e perché sono queste ─────────────────────────────────────────
 *
 *  1. MAI IL NOME DEL FILE. Un nome di file di galleria contiene spessissimo il nome del
 *     bambino (`IMG_pinco-pallino.mov`): dato personale di un minore, e `app_log` lo terrebbe
 *     trenta giorni, interrogabile in SQL. Escono solo numeri e codici di un elenco chiuso.
 *  2. LIVELLO `warn`. È il più basso che il canale del client spedisce: `info` non arriva
 *     in tabella, e queste righe esistono proprio per starci. Non sono guasti.
 *  3. CIÒ CHE DISTINGUE UN'OCCORRENZA DALL'ALTRA STA NEL MESSAGGIO. L'impronta di `app_log`
 *     tiene i `campi` della PRIMA occorrenza del giorno e butta quelli delle successive: un
 *     codice o una fascia di tempo messi nei campi sarebbero visibili una volta sola. Perciò
 *     `strada`, `ambiente`, `mime`, `attesa`, `tardivo` e `motivo` viaggiano nel messaggio
 *     (elenchi chiusi, nessun testo libero) e i numeri esatti nei campi (che `redact` lascia
 *     passare per TIPO, qualunque sia la chiave).
 *  4. `ms_da_ritorno` ASSENTE, NON `null`. La spec dice «`null` se non c'è stato», ma il tipo dei
 *     campi del client è `string | number | boolean` e un `null` viene scartato da
 *     `campiRidotti` lasciando un `campi_scartati: 1` che sembra un guasto del logger. La chiave
 *     assente fa la stessa cosa dove si legge: `contesto->'campi'->>'ms_da_ritorno'` è NULL.
 *  5. NON LANCIA MAI (regola 9 di AGENTS.md). Il selettore è la funzione che si sta
 *     diagnosticando: un bug dell'osservabilità non può impedire di scegliere un file. Ogni
 *     metodo pubblico passa da `sicuro`, che registra il guasto invece di inghiottirlo.
 */

/**
 * IL TETTO DI UNA SCELTA: 50 elementi (decisione del titolare, spec §2).
 *
 * È il numero di foto e video che la schermata può portare al passo dei bambini. Sta qui, accanto
 * a `limitaElementi`, e non dentro il componente: la funzione che taglia è pura e si prova senza
 * montare niente, e chiunque altro debba parlare del tetto (la pagina, un messaggio) legge lo
 * stesso numero invece di scriverne un secondo. Vale sul TOTALE accumulato — scegliere due volte da
 * 30 non aggira il tetto — e dentro una scelta si tengono i PRIMI, nell'ordine in cui il selettore
 * li ha consegnati.
 */
export const MAX_ELEMENTI_PER_SCELTA = 50

/**
 * QUANTO SI ASPETTANO I FILE DOPO IL RITORNO IN PRIMO PIANO: 15 secondi.
 *
 * Il selettore non sempre avvisa quando si chiude senza file: l'evento `cancel` dell'`<input>`
 * c'è su Safari dalla 15.4 e su Chrome dalla 113, e nelle WebView più vecchie manca. Dove manca,
 * l'unico segno che l'utente è uscito dal selettore è la pagina che torna in primo piano. Da quel
 * momento i file di una scelta normale (qualche foto, un video già sul telefono) arrivano in
 * pochi secondi: se dopo 15 non è arrivato niente si scrive `ritorno-senza-file`, e se i file
 * arrivano comunque la riga dei file porta `tardivo=si` — la firma della conversione di WebKit
 * o del download da iCloud, che è proprio ciò che questa riga serve a separare da «Aggiungi non
 * premuto».
 *
 * Non è un tetto: non interrompe niente e non scarta niente. Decide quale riga si scrive.
 */
export const ATTESA_FILE_DOPO_RITORNO_MS = 15_000

export type StradaSelettore = 'selettore-file' | 'fotocamera-nativa'
export type AmbienteSelettore = 'app' | 'web'
export type MotivoChiusura = 'cancel' | 'ritorno-senza-file' | 'annullato-fotocamera'
export type MimeScelta = 'image' | 'video' | 'misto'
export type FasciaAttesa = '<1s' | '1-5s' | '5-30s' | '30s-2m' | '>2m'

/**
 * La fascia di un'attesa. Intervalli semiaperti: 999 ms è `<1s`, 1000 è `1-5s`, 4999 è `1-5s`,
 * 5000 è `5-30s`, 29999 è `5-30s`, 30000 è `30s-2m`, 119999 è `30s-2m`, 120000 è `>2m`.
 * Un valore non finito o negativo (orologio che torna indietro) è `<1s`: meglio una fascia
 * bassa dichiarata che una `>2m` inventata da un `NaN`.
 */
export function fasciaAttesa(ms: number): FasciaAttesa {
  const v = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (v < 1_000) return '<1s'
  if (v < 5_000) return '1-5s'
  if (v < 30_000) return '5-30s'
  if (v < 120_000) return '30s-2m'
  return '>2m'
}

/**
 * Quanti elementi di una nuova scelta entrano, dato quanti ce n'erano già: i primi, finché c'è
 * posto. `scartati` è il numero di quelli rimasti fuori — il solo dato che finisce nel log.
 */
export function limitaElementi<T>(nuovi: readonly T[], giaScelti: number): { tenuti: T[]; scartati: number } {
  const posti = Math.max(0, MAX_ELEMENTI_PER_SCELTA - Math.max(0, giaScelti))
  const tenuti = nuovi.slice(0, posti)
  return { tenuti, scartati: nuovi.length - tenuti.length }
}

export interface RiepilogoFile {
  n: number
  nVideo: number
  nFoto: number
  byteTotali: number
  mime: MimeScelta
}

/**
 * Il riepilogo di una scelta, dal TIPO MIME dichiarato e mai dal nome (il nome non si legge nemmeno
 * per classificare: è il dato personale che i log non devono mai vedere). Un file di tipo ignoto o
 * vuoto conta in `n` ma né fra i video né fra le foto, e rende `misto` la scelta: il suo numero si
 * ricava per differenza.
 */
export function riepilogaFile(files: readonly File[]): RiepilogoFile {
  let nVideo = 0
  let nFoto = 0
  let byteTotali = 0
  for (const file of files) {
    const tipo = mimeBase(file.type)
    if (tipo.startsWith('video/')) nVideo++
    else if (tipo.startsWith('image/')) nFoto++
    const peso = file.size
    if (typeof peso === 'number' && Number.isFinite(peso) && peso > 0) byteTotali += peso
  }
  const n = files.length
  const mime: MimeScelta = nVideo === n ? 'video' : nFoto === n ? 'image' : 'misto'
  return { n, nVideo, nFoto, byteTotali, mime }
}

/** Millisecondi interi e non negativi: un orologio che torna indietro non scrive un tempo negativo. */
function ms(valore: number): number {
  return Number.isFinite(valore) && valore > 0 ? Math.round(valore) : 0
}

/** Una riga del selettore: livello `warn`, evento `js` (come gli altri log della galleria). */
function scrivi(messaggio: string, campi?: Record<string, number>): void {
  logClient({
    livello: 'warn',
    evento: 'js',
    messaggio,
    ...(campi === undefined ? {} : { campi }),
  })
}

/** Un'apertura del selettore, dal momento in cui parte a quello in cui si chiude. */
interface Sessione {
  strada: StradaSelettore
  apertoIl: number
  /** Il PRIMO ritorno in primo piano dopo l'apertura; `null` finché la pagina non se n'è andata e tornata. */
  ritornoIl: number | null
  /** La riga «chiuso senza file» è già partita: i file che arrivano ora sono `tardivo=si`. */
  chiusa: boolean
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * La macchina a stati delle tre righe. Una sola apertura alla volta: aprire di nuovo sostituisce la
 * precedente (e ne spegne il timer), perché il selettore del sistema è modale e due aperture
 * contemporanee non esistono.
 *
 * Chi la usa le dice cosa succede, e nient'altro:
 *  · `apri` — l'insegnante ha toccato il riquadro o «Scatta una foto»;
 *  · `fileRicevuti` — i file sono arrivati (dall'`<input>` o dalla fotocamera);
 *  · `cancel` — l'`<input>` ha emesso `cancel`; `annullatoFotocamera` — il foglio nativo è stato
 *    chiuso senza foto e senza errore;
 *  · `ritorno` — la pagina è tornata in primo piano; `chiudi` — il componente si smonta.
 */
export class TracciaSelettore {
  private sessione: Sessione | null = null

  /** Il selettore è stato aperto. Registra la riga iniziale e parte il cronometro. */
  apri(strada: StradaSelettore, ambiente: AmbienteSelettore): void {
    this.sicuro(() => {
      this.termina()
      this.sessione = { strada, apertoIl: Date.now(), ritornoIl: null, chiusa: false, timer: null }
      scrivi(`gallery-selettore-aperto strada=${strada} ambiente=${ambiente}`)
    })
  }

  /**
   * I file sono arrivati. Senza un'apertura nostra (un trascinamento sul riquadro, per esempio) non
   * si scrive niente: la riga dice «il selettore ha consegnato», e qui non c'è stato nessun selettore.
   */
  fileRicevuti(files: readonly File[]): void {
    this.sicuro(() => {
      const s = this.sessione
      if (s === null || files.length === 0) return
      // La sessione si chiude PRIMA di leggere i file: se la lettura lancia, il timer dei 15 secondi
      // non deve poter scrivere `ritorno-senza-file` per file che sono arrivati.
      this.termina()
      const ora = Date.now()
      const dallApertura = ms(ora - s.apertoIl)
      const r = riepilogaFile(files)
      const campi: Record<string, number> = {
        n: r.n,
        n_video: r.nVideo,
        n_foto: r.nFoto,
        byte_totali: r.byteTotali,
        ms_da_apertura: dallApertura,
      }
      if (s.ritornoIl !== null) campi.ms_da_ritorno = ms(ora - s.ritornoIl)
      scrivi(
        `gallery-selettore-file-ricevuti mime=${r.mime} attesa=${fasciaAttesa(dallApertura)} tardivo=${s.chiusa ? 'si' : 'no'}`,
        campi,
      )
    })
  }

  /** L'`<input>` ha emesso `cancel`: l'utente ha chiuso il selettore senza scegliere. */
  cancel(): void {
    this.sicuro(() => {
      const s = this.sessione
      if (s === null || s.chiusa || s.strada !== 'selettore-file') return
      this.chiudiSenzaFile(s, 'cancel', Date.now() - s.apertoIl)
    })
  }

  /** Il foglio nativo della fotocamera è stato chiuso senza foto e senza errore. */
  annullatoFotocamera(): void {
    this.sicuro(() => {
      const s = this.sessione
      if (s === null || s.chiusa || s.strada !== 'fotocamera-nativa') return
      this.chiudiSenzaFile(s, 'annullato-fotocamera', Date.now() - s.apertoIl)
    })
  }

  /**
   * La pagina è tornata in primo piano. Conta solo il PRIMO ritorno dopo l'apertura (i successivi
   * non spostano né il riferimento di `ms_da_ritorno` né il timer). Il timer dei 15 secondi parte
   * solo per il selettore di file: per la fotocamera nativa a dire come è finita è la sua promise,
   * non il ritorno della pagina.
   */
  ritorno(): void {
    this.sicuro(() => {
      const s = this.sessione
      if (s === null || s.ritornoIl !== null) return
      s.ritornoIl = Date.now()
      if (s.strada !== 'selettore-file' || s.chiusa) return
      const ritornoIl = s.ritornoIl
      s.timer = setTimeout(() => {
        s.timer = null
        // `ritorno-senza-file` si misura dal RITORNO e non da quando scatta il timer: i 15 secondi sono
        // nostri, non dell'utente, e sommati sposterebbero ogni attesa breve nella fascia sopra.
        this.sicuro(() => {
          if (this.sessione !== s || s.chiusa) return
          this.chiudiSenzaFile(s, 'ritorno-senza-file', ritornoIl - s.apertoIl)
        })
      }, ATTESA_FILE_DOPO_RITORNO_MS)
    })
  }

  /** Il componente si smonta: nessun timer deve sopravvivergli. */
  chiudi(): void {
    this.sicuro(() => this.termina())
  }

  /** Scrive «chiuso senza file». La sessione RESTA aperta: se i file arrivano dopo sono `tardivo=si`. */
  private chiudiSenzaFile(s: Sessione, motivo: MotivoChiusura, durataMs: number): void {
    s.chiusa = true
    if (s.timer !== null) {
      clearTimeout(s.timer)
      s.timer = null
    }
    const dallApertura = ms(durataMs)
    scrivi(`gallery-selettore-chiuso-senza-file motivo=${motivo} attesa=${fasciaAttesa(dallApertura)}`, {
      ms_da_apertura: dallApertura,
    })
  }

  /** Dimentica la sessione e ne spegne il timer. */
  private termina(): void {
    const s = this.sessione
    if (s !== null && s.timer !== null) clearTimeout(s.timer)
    this.sessione = null
  }

  /**
   * Fail-open con traccia: un'eccezione qui dentro non deve arrivare al gestore dell'evento (cioè a
   * «scegli un file»), ma non si inghiotte in silenzio — la regola 6 vale anche per l'osservabilità.
   * Solo il NOME della classe d'errore, mai il testo (`nomeErrore`): il messaggio di un errore su un
   * `File` può nominare il file.
   */
  private sicuro(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      logClient({
        livello: 'warn',
        evento: 'js',
        messaggio: 'gallery-selettore-traccia-fallita',
        campi: { tipo: nomeErrore(err) },
      })
    }
  }
}
