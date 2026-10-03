import { logClient, nomeErrore } from '@/lib/logging/client'
import type { ElementoScelto, ElementoVideoScelto, MotivoRifiuto } from '@/lib/native/caricamenti-nativi-tipi'
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
 *
 * ─── DAL 03/10/2026: LA STRADA NATIVA (app 1.2, spec «caricamenti nativi» §7.2) ──────────────────
 *
 * Sull'app 1.2 la scelta non passa più dall'`<input>` del browser: la fa il plugin nostro
 * (`scegliMedia`), che prepara gli elementi PRIMA di rispondere. Le tre righe restano le stesse, con
 * due strade nuove — `selettore-nativo` («Scegli foto e video dalla galleria») e `file-nativo`
 * («Scegli da File») — e un motivo nuovo, `annullato-nativo`: il selettore di sistema chiuso senza
 * scelta, oppure «Annulla» premuto durante la preparazione. Cambia COME si sa che è finita:
 *  · l'evento `cancel` dell'`<input>` non c'entra (il selettore non è l'`<input>`) e il ritorno della
 *    pagina non apre nessun timer da 15 secondi: a dire come è andata è la PROMISE di `scegliMedia`,
 *    come per la fotocamera nativa. Per questo `cancel()` e `ritorno()` guardano solo `selettore-file`;
 *  · i file non sono `File`: arrivano come elementi nativi (`riepilogaElementiNativi`) e la riga dei
 *    file si scrive da un riepilogo (`elementiRicevuti`), senza costruire niente.
 * Sempre MAI il nome: il plugin consegna anche quello (serve a mostrarlo a schermo), e qui non entra.
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

export type StradaSelettore = 'selettore-file' | 'fotocamera-nativa' | 'selettore-nativo' | 'file-nativo'
export type AmbienteSelettore = 'app' | 'web'
export type MotivoChiusura = 'cancel' | 'ritorno-senza-file' | 'annullato-fotocamera' | 'annullato-nativo'
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
 * Quanti posti restano, dato quanti elementi ci sono già: da 0 a `MAX_ELEMENTI_PER_SCELTA`. È il numero
 * che il selettore nativo riceve come `massimoElementi` (e a 0 i pulsanti si spengono: il ponte
 * rifiuta un massimo sotto 1) e che `limitaElementi` applica: una formula sola.
 */
export function postiRimasti(giaScelti: number): number {
  return Math.max(0, MAX_ELEMENTI_PER_SCELTA - Math.max(0, giaScelti))
}

/**
 * Quanti elementi di una nuova scelta entrano, dato quanti ce n'erano già: i primi, finché c'è
 * posto. `scartati` è il numero di quelli rimasti fuori — il solo dato che finisce nel log.
 */
export function limitaElementi<T>(nuovi: readonly T[], giaScelti: number): { tenuti: T[]; scartati: number } {
  const tenuti = nuovi.slice(0, postiRimasti(giaScelti))
  return { tenuti, scartati: nuovi.length - tenuti.length }
}

/* ────────────────────────────────────────────────────────────────────────────
 * L'ELEMENTO CARICABILE: un `File` (web, app 1.0/1.1, ripiego del browser) oppure un video NATIVO
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Il video scelto dal selettore nativo, com'è consegnato dal plugin: già copiato nella cartella
 * persistente del telefono, con lo `sha256` dei byte che partiranno, la durata e la miniatura. NON ha
 * un `File`: i suoi byte non entrano mai in JavaScript (spec §2.2, «Registro dei trasporti»).
 */
export type ElementoVideoNativo = ElementoVideoScelto

/**
 * CIÒ CHE LA GALLERIA PUÒ PORTARE AL PASSO DEI BAMBINI (spec §7.3).
 *
 * Due forme e non una con un campo facoltativo: il compilatore costringe ogni lettura di `f.file.…`
 * a decidere che cosa fare di un video nativo, che un `File` non ce l'ha. Un `File` va SEMPRE in TUS;
 * un video nativo va al plugin (`avviaVideoNativo`, J3): il trasporto lo decide l'ORIGINE
 * dell'elemento, non `scegliTrasporto()`.
 *
 * `preview` è un objectURL (da revocare) per un `File`, e la miniatura JPEG in data URL (niente da
 * revocare) per un nativo — vuota se il sistema non ha saputo farla.
 */
export type ElementoCaricabile =
  | { file: File; preview: string; nativo?: undefined }
  | { file: null; preview: string; nativo: ElementoVideoNativo }

/** Il nome da mostrare a schermo: mai in un log. */
export function nomeElemento(elemento: ElementoCaricabile): string {
  return elemento.file !== null ? elemento.file.name : elemento.nativo.nome
}

/** Gli identificativi dei soli elementi nativi: sono ciò che `scartaScelti` vuole. */
export function idNativi(elementi: readonly ElementoCaricabile[]): string[] {
  return elementi.flatMap((elemento) => (elemento.nativo ? [elemento.nativo.id] : []))
}

/**
 * Le sei ragioni per cui un elemento NON entra, ciascuna con la sua frase di catalogo (`shared`). Le
 * chiavi stanno scritte per esteso, non composte da `mediaRifiuto${motivo}`: il lock
 * `messaggi-chiavi-orfane` cerca il NOME della chiave nel sorgente, e una chiave costruita da un dato
 * gli è invisibile. Il tipo `Record<MotivoRifiuto, …>` fa sì che un motivo nuovo senza la sua frase non
 * compili.
 */
export const CHIAVE_RIFIUTO = {
  'troppo-grande': 'mediaRifiutoTroppoGrande',
  'troppo-lungo': 'mediaRifiutoTroppoLungo',
  'formato-non-supportato': 'mediaRifiutoFormatoNonSupportato',
  illeggibile: 'mediaRifiutoIlleggibile',
  'spazio-insufficiente': 'mediaRifiutoSpazioInsufficiente',
  'icloud-non-disponibile': 'mediaRifiutoIcloudNonDisponibile',
} as const satisfies Record<MotivoRifiuto, string>

/**
 * I nomi con cui i motivi di rifiuto stanno nei `campi` di un log: la chiave di un campo è
 * `^[a-z][a-z0-9_]{0,31}$` (la porta `/api/logs` scarta il resto), quindi i trattini degli slug dei
 * motivi diventano trattini bassi.
 */
export type CampoRifiuto =
  | 'troppo_grande'
  | 'troppo_lungo'
  | 'formato_non_supportato'
  | 'illeggibile'
  | 'spazio_insufficiente'
  | 'icloud_non_disponibile'

const CAMPO_RIFIUTO = {
  'troppo-grande': 'troppo_grande',
  'troppo-lungo': 'troppo_lungo',
  'formato-non-supportato': 'formato_non_supportato',
  illeggibile: 'illeggibile',
  'spazio-insufficiente': 'spazio_insufficiente',
  'icloud-non-disponibile': 'icloud_non_disponibile',
} as const satisfies Record<MotivoRifiuto, CampoRifiuto>

/**
 * Quanti elementi rifiutati per ciascun motivo, TUTTI e sei i motivi anche a zero: sono i `campi` della
 * riga `selettore-nativo-rifiutati` (solo numeri), e una forma fissa si interroga in SQL senza `COALESCE`.
 */
export type ContiRifiuti = Record<CampoRifiuto, number>

export function contaRifiutiPerMotivo(elementi: readonly ElementoScelto[]): ContiRifiuti {
  const conti: ContiRifiuti = {
    troppo_grande: 0,
    troppo_lungo: 0,
    formato_non_supportato: 0,
    illeggibile: 0,
    spazio_insufficiente: 0,
    icloud_non_disponibile: 0,
  }
  for (const elemento of elementi) {
    if (elemento.tipo === 'rifiutato') conti[CAMPO_RIFIUTO[elemento.motivo]]++
  }
  return conti
}

/**
 * La durata di un video come `m:ss` (`52` → `0:52`, `300` → `5:00`). `null` — o un valore che non è un
 * tempo — vale «non si sa»: il chiamante omette la durata invece di scrivere `0:00`. Il tetto è di 5
 * minuti (`MAX_VIDEO_DURATION_SECONDS`), quindi i minuti non diventano mai ore.
 */
export function formattaDurata(secondi: number | null): string | null {
  if (secondi === null || !Number.isFinite(secondi) || secondi < 0) return null
  const totale = Math.round(secondi)
  const minuti = Math.floor(totale / 60)
  const resto = totale % 60
  return `${minuti}:${resto < 10 ? '0' : ''}${resto}`
}

/**
 * Il nome del `File` JPEG di una foto scelta dal selettore nativo: il nome che il sistema ha dato, senza
 * la sua estensione (una HEIC è diventata un JPEG) e con `.jpg`. Solo l'ultimo segmento: un nome non è
 * un percorso. Un nome vuoto vale `foto`. È il nome che finisce a schermo e nella didascalia della foto
 * (come un file del browser), mai in un log.
 */
export function nomeFotoJpeg(nome: string): string {
  const ultimo = nome.split(/[\\/]/).pop() ?? ''
  const base = ultimo.replace(/\.[^.]{1,8}$/, '').trim()
  return `${base === '' ? 'foto' : base}.jpg`
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

/**
 * Il riepilogo di una scelta NATIVA, senza `File` (la riga dei file la scrive `elementiRicevuti`). Conta
 * ciò che il selettore ha CONSEGNATO, rifiutati compresi: «i file sono arrivati» vale anche se il
 * plugin ne ha scartati alcuni (per `origine`, che dice se erano foto o video; `altro` conta in `n` e
 * rende `misto`, come un file di tipo ignoto nel riepilogo del browser).
 *
 * ⚠️ `byteTotali` somma i soli elementi ACCETTATI, e per una foto è il peso DOPO la riduzione del
 * plugin (JPEG ≤ 1920 px): è ciò che la schermata porterà davvero, mentre nel riepilogo del browser
 * sono i byte dell'originale. Dei rifiutati il peso non si conosce.
 */
export function riepilogaElementiNativi(elementi: readonly ElementoScelto[]): RiepilogoFile {
  let nVideo = 0
  let nFoto = 0
  let byteTotali = 0
  for (const elemento of elementi) {
    const tipo = elemento.tipo === 'rifiutato' ? elemento.origine : elemento.tipo
    if (tipo === 'video') nVideo++
    else if (tipo === 'foto') nFoto++
    if (elemento.tipo !== 'rifiutato' && Number.isFinite(elemento.byte) && elemento.byte > 0) byteTotali += elemento.byte
  }
  const n = elementi.length
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
 *  · `apri` — l'insegnante ha toccato il riquadro, «Scatta una foto» o uno dei due pulsanti nativi;
 *  · `fileRicevuti` — i file sono arrivati (dall'`<input>` o dalla fotocamera);
 *    `elementiRicevuti` — gli elementi sono arrivati dal selettore nativo (un riepilogo, senza `File`);
 *  · `cancel` — l'`<input>` ha emesso `cancel`; `annullatoFotocamera` — il foglio nativo è stato
 *    chiuso senza foto e senza errore; `annullatoNativo` — il selettore nativo è stato chiuso senza
 *    scelta, o «Annulla» è stato premuto durante la preparazione;
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
    this.sicuro(() => this.registraRicevuti(files.length, () => riepilogaFile(files)))
  }

  /**
   * Gli elementi del selettore NATIVO sono arrivati: la stessa riga di `fileRicevuti`, da un riepilogo
   * (`riepilogaElementiNativi`) invece che da dei `File`, che il nativo non consegna. Un riepilogo vuoto
   * non scrive niente: una scelta senza elementi è «chiuso senza file», non «ricevuti».
   */
  elementiRicevuti(riepilogo: RiepilogoFile): void {
    this.sicuro(() => this.registraRicevuti(riepilogo.n, () => riepilogo))
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
   * Il selettore NATIVO (galleria o «Scegli da File») è stato chiuso senza scelta, oppure «Annulla» è
   * stato premuto durante la preparazione: `scegliMedia` ha risposto `annullato`. Vale solo per le due
   * strade native, come `annullatoFotocamera` vale solo per la fotocamera.
   */
  annullatoNativo(): void {
    this.sicuro(() => {
      const s = this.sessione
      if (s === null || s.chiusa || (s.strada !== 'selettore-nativo' && s.strada !== 'file-nativo')) return
      this.chiudiSenzaFile(s, 'annullato-nativo', Date.now() - s.apertoIl)
    })
  }

  /**
   * La pagina è tornata in primo piano. Conta solo il PRIMO ritorno dopo l'apertura (i successivi
   * non spostano né il riferimento di `ms_da_ritorno` né il timer). Il timer dei 15 secondi parte
   * solo per il selettore di file: per la fotocamera nativa e per il selettore nativo a dire come è
   * finita è la loro promise, non il ritorno della pagina. (Dove la pagina se ne va e torna davvero —
   * l'attività del selettore su Android — `ms_da_ritorno` misura il tempo di PREPARAZIONE dopo la
   * chiusura del selettore di sistema; dove non succede, come per un foglio che resta nella stessa
   * app, il campo manca e basta.)
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

  /** Scrive «file ricevuti» da un riepilogo che si calcola DOPO aver chiuso la sessione (vedi sotto). */
  private registraRicevuti(n: number, riepiloga: () => RiepilogoFile): void {
    const s = this.sessione
    if (s === null || n === 0) return
    // La sessione si chiude PRIMA di leggere i file: se la lettura lancia, il timer dei 15 secondi
    // non deve poter scrivere `ritorno-senza-file` per file che sono arrivati.
    this.termina()
    const ora = Date.now()
    const dallApertura = ms(ora - s.apertoIl)
    const r = riepiloga()
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
