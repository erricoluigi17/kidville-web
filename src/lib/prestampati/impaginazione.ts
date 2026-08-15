/**
 * Motore di impaginazione dei prestampati (`docs/prestampati/00-impaginazione.md`).
 *
 * Generalizza la carta intestata di `src/lib/protocolli/documento-pdf.ts` — che ha un
 * solo blocco di corpo — a sezioni, righe-campo, caselle, elenchi, tabelle, riquadri
 * «RISERVATO A…» e PIÙ PAGINE. Le misure non si scelgono qui: si leggono dalla
 * specifica e vivono in un posto solo, perché diciassette moduli impaginati ognuno a
 * modo suo sono diciassette fogli che fra sei mesi non si riconoscono più.
 *
 * Una regola vale per ogni blocco e conviene dirla una volta: **nessun contenuto si
 * perde per strada**. Se un blocco non ci sta dov'è arrivato, va a pagina nuova; se non
 * ci sta nemmeno in una pagina vuota, cede riga per riga — paragrafo, elenco, campi,
 * tabella e riquadro fanno tutti così. Una guardia che esce e butta via i dati sarebbe
 * qui la stessa cosa che il progetto chiama incidente quando succede in un log.
 *
 * ⚠️ **QUESTI BYTE NON SONO UN DOCUMENTO FINITO.** A valle DEVE passare
 * `applicaCartaIntestata()` di `src/lib/carta/`, che stende la carta REALE della scuola
 * sotto ogni pagina e — quando il documento è protocollato — ci apporta anche la
 * segnatura, con l'opzione `{ segnatura }`. **Una chiamata sola, e non due.** Questa riga
 * diceva «e poi `applicaSegnatura()` di `src/lib/protocolli/timbro.ts`, che riscala la
 * prima pagina invece di coprirla»: su un foglio bianco è vero, sulla carta intestata
 * quella funzione dipinge la fascia verde sopra il marchio della scuola e riscala la carta
 * di 0,924, staccando il piede a quattro colonne dal fondo del foglio.
 *
 * Che il passo a valle ci sia davvero non è affidato a questo commento: per un giorno il
 * commento c'era e la chiamata no, e il certificato usciva senza marchio, senza filigrana
 * e senza il piede con la P.IVA e le tre sedi — cioè peggio di prima. Lo verifica il lock
 * in `__tests__/lib/carta-applica.test.ts`, rotta per rotta.
 *
 * ⚠️ **QUESTO MOTORE NON DISEGNA PIÙ LA TESTATA** (2026-08-15). Non c'è più la banda
 * verde, non c'è più il logo, non c'è più il piede predefinito: ce li ha già la carta
 * intestata, e ridisegnarli significava coprirli — la banda cadeva esattamente sopra il
 * marchio della scuola, il piede dentro l'elenco stampato delle tre sedi. Qui si impagina
 * il solo contenuto, dentro la finestra che `CARTA` dichiara: 40 → 266 mm.
 *
 * Si importa `carta/geometria` e non `carta/index`: il primo è una manciata di numeri
 * senza dipendenze, il secondo porterebbe dietro pdf-lib e la lettura da disco di 1,1 MB
 * dentro il grafo di un motore che deve restare leggero.
 *
 * Testato in `__tests__/lib/prestampati-impaginazione.test.ts`.
 */

import { jsPDF } from 'jspdf'
import { CARTA } from '@/lib/carta/geometria'
import type {
  BloccoPrestampato,
  CampoPrestampato,
  CasellaPrestampato,
  DocumentoPrestampato,
  FirmaPrestampato,
  VerificaPrestampato,
} from './tipi'

// ─── Colori (§1) ────────────────────────────────────────────────────────────────
const VERDE: [number, number, number] = [0, 106, 95] // #006A5F
const INCHIOSTRO: [number, number, number] = [45, 45, 45] // #2D2D2D
const GRIGIO: [number, number, number] = [100, 100, 100] // #646464
const FONDO_TABELLA: [number, number, number] = [245, 241, 234] // #F5F1EA

// ─── Misure, in millimetri (§1 e §2) ────────────────────────────────────────────
const CENTRO_PAGINA = 105
// I margini si leggono da `CARTA` e non si riscrivono qui: la segnatura di protocollo si
// allinea al margine destro, e due numeri uguali in due file diversi restano uguali
// finché qualcuno non tocca uno solo dei due.
const MARGINE_SX = CARTA.margineSx // 22
const MARGINE_DX = CARTA.margineDx // 188
const LARGHEZZA_UTILE = MARGINE_DX - MARGINE_SX // 166
const COLONNA_DX = 110
const LARGHEZZA_COLONNA = 78

/**
 * L'intestazione di sede comincia dove finisce l'area del marchio, con l'aria che ci
 * vuole: attaccata al logo della scuola sembrerebbe una sua didascalia.
 */
const Y_INTESTAZIONE = CARTA.contenutoInizio // 40
const PASSO_INTESTAZIONE = 4.5
const Y_PROTOCOLLO = 52
const Y_TITOLO_MIN = 60
const PASSO_TITOLO = 7

const INTERLINEA = 6.2 // corpo 12 pt
const PASSO_CAMPO = 6.5
const SPAZIO_PRIMA_SEZIONE = 10
const SPAZIO_DOPO_FILETTO = 5
const LATO_CASELLA = 3.5
const RIENTRO_ELENCO = 5

/**
 * Spaziatura fra le lettere dei titoletti (§2: «spaziatura lettere +0,4»): 0,4 PUNTI,
 * convertiti qui in millimetri perché jsPDF misura `charSpace` nell'unità del documento.
 *
 * La specifica non porta l'unità su questa riga — è l'unica misura della tabella §2 che
 * non ce l'ha — e la disambiguazione è stata presa qui, con una misura invece che con una
 * preferenza. Non 0,4 mm: PDF.js infila uno spazio nel testo estratto quando la spaziatura
 * supera 0,102 × il corpo — a 10 pt fanno 1,02 pt, cioè 0,36 mm. Con 0,4 mm il titolo di
 * sezione esce «D A T I  D E L L ' A L U N N O / A»: il PDF diventa non cercabile, e
 * soprattutto `suggerisciCampi()` di `src/lib/protocolli/estrai.ts` — che sui documenti
 * protocollati legge proprio quel testo per precompilare la registrazione — smette di
 * riconoscere qualunque riga. Un difetto che nessuno vedrebbe guardando il foglio
 * stampato, che è il modo peggiore di averne uno.
 */
const SPAZIATURA_TITOLI = 0.4 * (25.4 / 72)

const ALTEZZA_RIGA_TABELLA = 7
const INTERLINEA_TABELLA = 4.2
const PADDING_TABELLA = 2

const PADDING_RIQUADRO = 4
/** Dal bordo alto del riquadro alla prima riga-campo: ci sta il titoletto in 9 pt. */
const TESTATA_RIQUADRO = 6

const SPAZIO_SOTTO_TITOLO = 16
const LIMITE_CONTENUTO = CARTA.contenutoFine // 266

/**
 * Testata delle pagine successive alla prima (§2): tutto in 8 pt.
 *
 * Comincia a 40 come l'intestazione della prima pagina, e non più a 14: a 14 le sue
 * quattro righe cadevano DENTRO il marchio stampato sulla carta (12,5→26,8), cioè sopra
 * la parola «Kidville». Costa una ventina di millimetri di contenuto per pagina, ed è il
 * prezzo di avere il marchio della scuola su ogni foglio invece che solo sul primo.
 */
const Y_TESTATA_COMPATTA = CARTA.contenutoInizio // 40
const PASSO_TESTATA_COMPATTA = 4
const SPAZIO_SOTTO_TESTATA_COMPATTA = 6.5

const FIRMA_Y_MIN = 150
const FIRMA_Y_MAX = 240

/**
 * L'aria fra l'ultima riga di contenuto e la linea di firma — e quanto può stringersi.
 *
 * ⚠️ **LA REGOLA CHE MANCAVA, e che è costata un certificato in due pagine.** Fino al
 * 2026-08-15 lo stacco era un `s.y + 12` fisso: se la firma non ci stava, si apriva una
 * pagina nuova, punto. Bastava mezzo millimetro di troppo — misurato: 0,5 mm sul
 * certificato di iscrizione e frequenza protocollato — perché la firma del legale
 * rappresentante finisse da sola su un secondo foglio, con tredici centimetri di vuoto
 * sopra, staccata dal testo che certifica, su un documento diretto all'INPS.
 *
 * Un foglio che finisce due millimetri più in basso non è un motivo per stampare una
 * pagina in più: prima si stringe l'aria fino a `STACCO_FIRMA_MINIMO`, e solo se nemmeno
 * quella basta si cambia pagina. Undici millimetri e mezzo o cinque non li nota nessuno;
 * una firma sola in mezzo al bianco la nota chiunque.
 */
const STACCO_FIRMA = 12
const STACCO_FIRMA_MINIMO = 5
const CENTRO_COLONNA_FIRMA = 152 // colonna destra 128→176, come in documento-pdf.ts
const X_RIQUADRO_FIRMA = 118
const LARGHEZZA_RIQUADRO_FIRMA = MARGINE_DX - X_RIQUADRO_FIRMA // 70
const STACCO_RIQUADRO_FIRMA = 2.5 // dalla linea di scrittura al bordo alto del riquadro

/**
 * L'aria fra il fondo del blocco firma e il bordo alto del riquadro di verifica.
 *
 * Era 6 mm, ed è scesa a 3,5 il 2026-08-15 — non per far passare un test, ma per PAGARE i
 * 2,5 mm che `CARTA.contenutoFine` ha dovuto cedere alla riga di servizio (prima chiudeva
 * a 0,7 mm da «Pagina n di m»). Quei millimetri, dice `carta/geometria.ts`, «si trovano
 * nel motore, non nella geometria della carta»: eccoli.
 *
 * 3,5 mm è la stessa aria che il riquadro di verifica ha DENTRO di sé
 * (`PADDING_VERIFICA` = 3), quindi due cornici restano due cornici anche a occhio. Il
 * numero tocca solo i documenti che hanno **entrambi** i blocchi — i certificati
 * protocollati — e senza di lui il certificato di iscrizione e frequenza con il campo
 * «uso» passava da una pagina a due, con la seconda occupata dalla sola firma.
 */
const DISTANZA_FIRMA_VERIFICA = 3.5

/**
 * Costante di legge, non un testo di prodotto: cambia solo se cambia la norma (§3b).
 * Sta nel codice — a differenza del nome del legale rappresentante, che sta in
 * configurazione — proprio perché è l'unica parte del blocco firma che NON dipende da
 * chi firma. E va da sola: «firma autografa sostituita a mezzo stampa» e «firmato
 * digitalmente» si escludono, mai entrambe (§4.4).
 */
const DICITURA_FIRMA_SOSTITUITA = [
  'Firma autografa sostituita a mezzo stampa',
  "ai sensi dell'art. 3, c. 2 D.Lgs n. 39/93",
]

/** Righe e quota della testata compatta: si compongono una volta e non cambiano più. */
interface TestataCompatta {
  righeSede: string[]
  righeTitolo: string[]
  /** Quota a cui riparte il corpo sulle pagine successive alla prima. */
  quotaCorpo: number
}

/** Stato dell'impaginazione: la pagina corrente la tiene jsPDF, la quota la teniamo qui. */
interface Stato {
  doc: jsPDF
  documento: DocumentoPrestampato
  /** Linea di scrittura corrente (baseline), in millimetri dal bordo alto. */
  y: number
  testata: TestataCompatta
  /** Il riquadro di verifica già misurato, o `null` se il documento non ne ha. */
  verifica: VerificaComposta | null
  /**
   * Fin dove può scendere il contenuto in questo momento. Vale `LIMITE_CONTENUTO` per
   * tutti i blocchi tranne l'ULTIMO, che si ferma prima per lasciare il posto alla firma:
   * così la coda del testo si porta la firma sulla pagina nuova invece di lasciarla lì
   * da sola. Vedi `limitePerUltimoBlocco()`.
   */
  limite: number
  /**
   * Il titolo di sezione che aspetta di sapere dove finirà il suo contenuto.
   *
   * Vedi `disegnaSezione`: un titoletto non si disegna quando arriva, si disegna insieme
   * al blocco che lo segue, così i due non si separano mai.
   */
  sezioneSospesa: string | null
}

/**
 * Come il chiamante intende consegnare questo foglio.
 *
 * Una sola opzione, e riguarda **dove vive il numero di protocollo**. Vedi
 * `protocolloInSegnatura`.
 */
export interface OpzioniStampa {
  /**
   * ⚠️ **UNA SOLA SEDE PER IL NUMERO DI PROTOCOLLO.**
   *
   * Il numero può stare in due posti su questo foglio, e per un giorno ci è stato in
   * tutti e due: la segnatura che `applicaCartaIntestata()` stampa a 34 mm («SCUOLA … ·
   * Prot. n. 0000123/2026 · Uscita · del 15/08/2026 ore 10:24») e la riga di corpo a 52 mm
   * («Prot. n. 0000123/2026 del 15/08/2026»). Diciotto millimetri di distanza, lo stesso
   * numero due volte, sul certificato che va all'INPS e al datore di lavoro.
   *
   * Non è un difetto di una delle due: è un difetto della composizione, e quindi si
   * risolve dove la composizione si decide — nel chiamante. Chi passa `segnatura` a
   * `applicaCartaIntestata()` passa `protocolloInSegnatura: true` qui, e il corpo tace.
   *
   * La segnatura è la sede giusta delle due (art. 55 DPR 445/2000: ente, numero, tipo,
   * data e ora) e sta esattamente nell'aria che la carta lascia sotto il marchio. La riga
   * di corpo del §4.1 resta per i fogli che una segnatura non ce l'hanno.
   *
   * ⚠️ Spegne SOLO la riga di protocollo vera. La dicitura «Copia a uso della famiglia —
   * non protocollata» viaggia nello stesso campo ma non è un numero, nessuna segnatura la
   * ripete, e toglierla vorrebbe dire consegnare una copia che non dice più di esserlo.
   */
  protocolloInSegnatura?: boolean
}

/** Quello che `protocolloInSegnatura` spegne, e quello che non tocca mai. */
const PREFISSO_PROTOCOLLO = 'Prot. n.'

/** Il documento composto, pronto per `applicaCartaIntestata()`. */
export function buildPrestampatoPdf(
  documento: DocumentoPrestampato,
  opzioni: OpzioniStampa = {}
): Uint8Array {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  // Testata compatta e riquadro di verifica si compongono PRIMA di disegnare: le loro
  // altezze decidono quanto contenuto ci sta in una pagina e dove può cadere la firma, e
  // quei numeri servono già al primo salto.
  const s: Stato = {
    doc,
    documento,
    y: 0,
    testata: componiTestataCompatta(doc, documento),
    verifica: documento.verifica ? componiVerifica(doc, documento.verifica) : null,
    limite: LIMITE_CONTENUTO,
    sezioneSospesa: null,
  }
  // Il blocco firma si misura PRIMA di impaginare il corpo, e non è un dettaglio d'ordine:
  // il suo ingombro decide dove l'ultimo blocco di contenuto deve fermarsi.
  const firma = componiBloccoFirma(doc, documento, s.verifica)

  s.y = testataPrimaPagina(doc, documento, opzioni)
  const ultimo = documento.blocchi.length - 1
  documento.blocchi.forEach((blocco, i) => {
    s.limite = i === ultimo ? limitePerUltimoBlocco(s, firma.tetto) : LIMITE_CONTENUTO
    disegnaBlocco(s, blocco)
  })
  s.limite = LIMITE_CONTENUTO
  // Un titolo di sezione senza NIENTE dopo di sé: il documento finisce lì. Si stampa lo
  // stesso — un blocco che sparisce in silenzio è la cosa che questo motore non fa mai —
  // e ci pensa la firma, che viene dopo, a non lasciarlo solo in cima a un foglio.
  scaricaSezione(s, 0)
  disegnaFirma(s, firma)
  // Il riquadro di verifica va in fondo all'ULTIMA pagina, che dopo la firma è quella
  // corrente: si disegna alla quota già misurata e non tocca il flusso.
  if (s.verifica) disegnaVerifica(doc, s.verifica)

  // I piedi si scrivono per ultimi: «Pagina n di m» pretende di sapere quante sono,
  // e prima di aver impaginato tutto non lo sa nessuno.
  disegnaPiedi(doc, documento.piePagina?.trim() ?? '')

  return new Uint8Array(doc.output('arraybuffer'))
}

// ─── Testate ────────────────────────────────────────────────────────────────────

/**
 * Intestazione di sede, protocollo e titolo. Ritorna la quota del corpo.
 *
 * Niente banda verde e niente logo: li porta la carta intestata, e ridisegnarli qui
 * significava stamparci sopra. La banda copriva il marchio della scuola per intero.
 */
function testataPrimaPagina(
  doc: jsPDF,
  d: DocumentoPrestampato,
  opzioni: OpzioniStampa
): number {
  let y = Y_INTESTAZIONE
  if (d.intestazione.length > 0) {
    doc.setTextColor(...GRIGIO)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    for (const riga of d.intestazione) {
      doc.text(riga, CENTRO_PAGINA, y, { align: 'center' })
      y += PASSO_INTESTAZIONE
    }
  }

  // Riga di protocollo (§4.1): a y=52 con l'intestazione consueta di tre righe, più in
  // basso quando la sede ne ha di più. Il massimo non è pignoleria: una sede con cinque
  // righe si stamperebbe il protocollo sopra il proprio indirizzo.
  //
  // …a meno che il numero non viaggi già nella segnatura sulla carta: allora qui tace, e
  // il perché sta tutto in `OpzioniStampa.protocolloInSegnatura`. Il confronto è sul
  // PREFISSO e non sul contenuto del campo: «Copia a uso della famiglia — non
  // protocollata» passa dallo stesso campo, non è un numero, e non si spegne mai.
  const grezzo = d.protocollo?.trim()
  const protocollo =
    opzioni.protocolloInSegnatura && grezzo?.startsWith(PREFISSO_PROTOCOLLO) ? '' : grezzo
  if (protocollo) {
    const yProtocollo = Math.max(y, Y_PROTOCOLLO)
    doc.setTextColor(...INCHIOSTRO)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.text(protocollo, MARGINE_SX, yProtocollo)
    y = yProtocollo + 6
  }

  let yTitolo = Math.max(y, Y_TITOLO_MIN)
  doc.setTextColor(...VERDE)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  // I titoli veri sono lunghi («RICHIESTA DI PERMESSO — ENTRATA POSTICIPATA / USCITA
  // ANTICIPATA»): a 16 pt non ci stanno su una riga e vanno mandati a capo, o escono
  // dai margini senza che nessuno se ne accorga finché non lo stampa una segretaria.
  const righeTitolo = doc.splitTextToSize(d.titolo, LARGHEZZA_UTILE) as string[]
  for (const riga of righeTitolo) {
    doc.text(riga, CENTRO_PAGINA, yTitolo, { align: 'center' })
    yTitolo += PASSO_TITOLO
  }
  yTitolo -= PASSO_TITOLO
  doc.setDrawColor(...VERDE)
  doc.setLineWidth(0.4)
  doc.line(40, yTitolo + 4, 170, yTitolo + 4)

  return yTitolo + SPAZIO_SOTTO_TITOLO
}

/**
 * Le righe della testata delle pagine successive alla prima (§2): niente banda verde, ma
 * l'intestazione della sede PER INTERO in 8 pt e il titolo in corsivo.
 *
 * Per intero, e non solo il nome: la seconda riga è l'indirizzo, la terza il codice
 * meccanografico, e su un modulo che esce verso un ente sono proprio quelle a dire da
 * quale delle tre sedi arriva il foglio che si sta sfogliando. La quota del corpo scende
 * di conseguenza — si calcola qui e non è una costante — perché un'intestazione di cinque
 * righe altrimenti finirebbe sotto il primo capoverso della pagina.
 */
function componiTestataCompatta(doc: jsPDF, d: DocumentoPrestampato): TestataCompatta {
  doc.setFont('helvetica', 'italic')
  doc.setFontSize(8)
  const righeTitolo = doc.splitTextToSize(d.titolo, LARGHEZZA_UTILE) as string[]
  const righeSede = d.intestazione.filter((riga) => riga.trim().length > 0)
  const righe = righeSede.length + righeTitolo.length
  const ultimaBase = Y_TESTATA_COMPATTA + Math.max(righe - 1, 0) * PASSO_TESTATA_COMPATTA
  return { righeSede, righeTitolo, quotaCorpo: ultimaBase + 3 + SPAZIO_SOTTO_TESTATA_COMPATTA }
}

function disegnaTestataCompatta(doc: jsPDF, testata: TestataCompatta): void {
  doc.setTextColor(...GRIGIO)
  doc.setFontSize(8)
  let y = Y_TESTATA_COMPATTA
  doc.setFont('helvetica', 'normal')
  for (const riga of testata.righeSede) {
    doc.text(riga, CENTRO_PAGINA, y, { align: 'center' })
    y += PASSO_TESTATA_COMPATTA
  }
  doc.setFont('helvetica', 'italic')
  for (const riga of testata.righeTitolo) {
    doc.text(riga, CENTRO_PAGINA, y, { align: 'center' })
    y += PASSO_TESTATA_COMPATTA
  }
  doc.setDrawColor(...GRIGIO)
  doc.setLineWidth(0.2)
  const yFiletto = y - PASSO_TESTATA_COMPATTA + 3
  doc.line(MARGINE_SX, yFiletto, MARGINE_DX, yFiletto)
}

/**
 * La riga di servizio: il piede del modello e «Pagina n di m», a 268,5 mm.
 *
 * Stavano a 287, cioè DENTRO il piede a quattro colonne stampato sulla carta
 * (272,1→285,0): ci sarebbero finiti sopra la ragione sociale e i recapiti delle tre
 * sedi. Ora stanno nell'aria fra il contenuto e quel piede, in 7 pt grigio.
 *
 * E il piede predefinito non c'è più. «Documento generato dal registro elettronico
 * Kidville» era ciò che l'app diceva su un foglio che non aveva altro: la carta porta la
 * ragione sociale, la partita IVA e le tre sedi, e lì sotto non c'è più niente da
 * aggiungere. Un modello che ha qualcosa da dire — «Riservato — dati di minori» sulle
 * stampe di sezione — lo passa in `piePagina`, come ha sempre fatto.
 */
function disegnaPiedi(doc: jsPDF, piede: string): void {
  const pagine = doc.getNumberOfPages()
  if (!piede && pagine === 1) return

  for (let p = 1; p <= pagine; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'italic')
    doc.setFontSize(7)
    doc.setTextColor(...GRIGIO)
    if (piede) doc.text(piede, CENTRO_PAGINA, CARTA.rigaServizio, { align: 'center' })
    if (pagine > 1) {
      doc.text(`Pagina ${p} di ${pagine}`, MARGINE_DX, CARTA.rigaServizio, { align: 'right' })
    }
  }
}

// ─── Salti di pagina ────────────────────────────────────────────────────────────

function nuovaPagina(s: Stato): void {
  s.doc.addPage()
  disegnaTestataCompatta(s.doc, s.testata)
  s.y = s.testata.quotaCorpo
}

/**
 * Manda a pagina nuova se `altezza` non ci sta più. Ritorna `true` quando ha cambiato
 * pagina: chi disegna deve riapplicare font e colori, perché la testata compatta li ha
 * cambiati sotto i piedi.
 */
function cambioPagina(s: Stato, altezza: number): boolean {
  if (s.y + altezza <= s.limite) return false
  nuovaPagina(s)
  return true
}

/** Quanto ingombra un titoletto di sezione: l'aria sopra, il filetto, l'aria sotto. */
const ALTEZZA_SEZIONE = SPAZIO_PRIMA_SEZIONE + 2 + SPAZIO_DOPO_FILETTO

/**
 * Salto per BLOCCHI INTERI (§2): se il blocco non ci sta qui ma ci starebbe tutto in una
 * pagina vuota, si va a capo pagina prima di cominciare. Se non ci sta nemmeno lì — un
 * paragrafo lunghissimo, una tabella di cinquanta righe — si torna `false` e il blocco si
 * spezza comunque riga per riga: spezzato è brutto, troncato è un dato che sparisce.
 *
 * ⚠️ **E QUI SI DECIDE ANCHE DOVE VA IL TITOLO DI SEZIONE che aspetta.** È l'unico punto
 * del motore che sa, tutto insieme, quanto è alto il blocco che sta per cominciare e quanto
 * spazio resta: quindi è l'unico che può tenere insieme un titoletto e il suo contenuto.
 * Il titolo entra nel conto (`ALTEZZA_SEZIONE`) e si stampa **dopo** l'eventuale salto —
 * mai prima, o resterebbe sulla pagina che il suo contenuto ha appena lasciato.
 */
function preferisciBloccoIntero(s: Stato, altezza: number): boolean {
  const conTitolo = altezza + (s.sezioneSospesa ? ALTEZZA_SEZIONE : 0)
  const saltato =
    conTitolo > s.limite - s.y && conTitolo <= s.limite - s.testata.quotaCorpo
  if (saltato) nuovaPagina(s)
  scaricaSezione(s, saltato ? 0 : SPAZIO_PRIMA_SEZIONE)
  return saltato
}

/**
 * Stampa il titolo di sezione rimasto in sospeso, se c'è, e lo toglie dalla coda.
 *
 * `ariaSopra` è zero in cima a una pagina nuova: dieci millimetri di stacco sotto la
 * testata compatta sarebbero un buco, non un respiro.
 */
function scaricaSezione(s: Stato, ariaSopra: number): void {
  const titolo = s.sezioneSospesa
  if (titolo === null) return
  s.sezioneSospesa = null

  const { doc } = s
  s.y += ariaSopra
  doc.setTextColor(...VERDE)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.text(titolo.toUpperCase(), MARGINE_SX, s.y, { charSpace: SPAZIATURA_TITOLI })
  doc.setDrawColor(...GRIGIO)
  doc.setLineWidth(0.2)
  doc.line(MARGINE_SX, s.y + 2, MARGINE_DX, s.y + 2)
  s.y += 2 + SPAZIO_DOPO_FILETTO
}

/**
 * Fin dove può scendere l'ULTIMO blocco di contenuto: quanto basta perché la firma stia
 * ancora nella stessa pagina, con l'aria minima.
 *
 * È la metà preventiva della regola (l'altra è la compressione dello stacco in
 * `disegnaFirma`), ed è quella che risparmia i fogli: senza, un elenco che riempie la
 * pagina fino a 266 lascia la firma fuori e apre un secondo foglio per lei sola. Con
 * questo limite la coda dell'elenco scavalca il salto di pagina e la firma le va dietro:
 * la pagina nuova porta contenuto E firma, oppure non nasce affatto.
 *
 * Il minimo garantisce che il blocco abbia comunque una riga di spazio su una pagina
 * vuota: un limite più alto della quota di ripartenza girerebbe a vuoto.
 */
function limitePerUltimoBlocco(s: Stato, tettoFirma: number): number {
  return Math.max(tettoFirma - STACCO_FIRMA_MINIMO, s.testata.quotaCorpo + INTERLINEA)
}

// ─── Blocchi ────────────────────────────────────────────────────────────────────

function disegnaBlocco(s: Stato, blocco: BloccoPrestampato): void {
  switch (blocco.tipo) {
    case 'paragrafo':
      return disegnaParagrafo(s, blocco.testo, blocco.stile ?? 'normale')
    case 'sezione':
      return disegnaSezione(s, blocco.titolo)
    case 'campi':
      return disegnaCampi(s, blocco.campi, blocco.colonne ?? 1)
    case 'caselle':
      return disegnaCaselle(s, blocco.caselle)
    case 'elenco':
      return disegnaElenco(s, blocco.voci)
    case 'tabella':
      return disegnaTabella(s, blocco.intestazioni, blocco.righe, blocco.larghezze, blocco.righeVuote ?? 0)
    case 'riquadro':
      return disegnaRiquadro(s, blocco.titolo, blocco.campi)
    case 'spazio':
      // Lo spazio non provoca mai un salto: uno spazio in cima a una pagina nuova è
      // un buco, e il blocco che segue il salto se lo farà da sé. Un titolo in coda però
      // si scarica prima, o lo spazio finirebbe SOPRA il titoletto invece che sotto.
      scaricaSezione(s, SPAZIO_PRIMA_SEZIONE)
      s.y += Math.max(blocco.mm, 0)
      return
    default: {
      // Esaustività verificata dal compilatore: aggiungere un blocco in `tipi.ts` senza
      // gestirlo qui è un errore di tipo, non un blocco che sparisce dalla stampa.
      const nonGestito: never = blocco
      return nonGestito
    }
  }
}

function disegnaParagrafo(s: Stato, testo: string, stile: 'normale' | 'corsivo' | 'grassetto'): void {
  const { doc } = s
  const applica = () => {
    doc.setFont('helvetica', stile === 'corsivo' ? 'italic' : stile === 'grassetto' ? 'bold' : 'normal')
    doc.setFontSize(12)
    doc.setTextColor(...INCHIOSTRO)
  }
  applica()
  const righe = doc.splitTextToSize(testo, LARGHEZZA_UTILE) as string[]
  preferisciBloccoIntero(s, righe.length * INTERLINEA)
  applica()
  for (const riga of righe) {
    if (cambioPagina(s, INTERLINEA)) applica()
    // Riga per riga e non `doc.text(righe, …)`: la versione ad array usa il
    // `lineHeightFactor` di jsPDF (a 12 pt sono 4,87 mm) e l'interlinea della specifica
    // — 6,2 mm — resterebbe scritta solo nell'avanzamento della quota, cioè da nessuna
    // parte. Due prestampati si riconoscono per questo passo, non per il font.
    doc.text(riga, MARGINE_SX, s.y)
    s.y += INTERLINEA
  }
}

/**
 * Un titoletto di sezione NON SI DISEGNA QUANDO ARRIVA: si mette in coda.
 *
 * ⚠️ **La regola che mancava, e che è costata un titolo orfano con 68 mm di bianco
 * sotto.** Misurato il 2026-08-15 su un certificato di iscrizione e frequenza con un «uso»
 * del tutto ordinario («Da presentare al datore di lavoro per la richiesta del congedo
 * parentale…»): pagina 1 chiudeva con «DATI IDENTIFICATIVI DELLA SCUOLA» e il suo filetto
 * a 197,6 mm, e poi più niente fino a «Pagina 1 di 2». I tre campi — Denominazione, P.IVA,
 * Sede legale — stavano a pagina 2, che il titolo non lo ripete.
 *
 * La versione precedente ci provava, e non poteva funzionare: chiedeva spazio «per sé e
 * per due righe». Ma i blocchi non arrivano a righe — `preferisciBloccoIntero` sposta un
 * blocco INTERO quando non ci sta — quindi il titolo che aveva prenotato tredici
 * millimetri restava lì mentre i suoi tre campi (19,5 mm) traslocavano in massa. Riservare
 * di più sarebbe stato indovinare: l'altezza vera del blocco seguente la conosce solo il
 * blocco seguente, e la conosce dopo aver mandato a capo i propri valori coi font veri.
 *
 * Perciò non si indovina: il titolo aspetta. Lo stampa `preferisciBloccoIntero`, che è
 * l'unico punto in cui altezza del contenuto e spazio residuo si incontrano — e lo stampa
 * **dopo** l'eventuale salto di pagina. Un titolo e il suo contenuto o stanno insieme, o
 * cambiano pagina insieme.
 */
function disegnaSezione(s: Stato, titolo: string): void {
  // Due sezioni di fila senza niente in mezzo: la prima non si perde, si stampa subito e
  // la seconda prende il suo posto in coda.
  scaricaSezione(s, SPAZIO_PRIMA_SEZIONE)
  s.sezioneSospesa = titolo
}

interface CellaCampo {
  etichetta: string
  larghezzaEtichetta: number
  righeValore: string[]
}

/**
 * L'etichetta esce sempre con i due punti, che il modello li abbia scritti o no: così
 * `Cognome` e `Cognome:` danno lo stesso foglio, e nessuno deve ricordarsi la convenzione
 * mentre trascrive diciassette moduli.
 */
function preparaCella(doc: jsPDF, campo: CampoPrestampato, larghezza: number): CellaCampo {
  const grezza = campo.etichetta.trim().replace(/:+$/, '')
  const etichetta = grezza ? `${grezza}:` : ''
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  const larghezzaEtichetta = etichetta ? doc.getTextWidth(etichetta) : 0

  const valore = campo.valore?.trim()
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  const disponibile = Math.max(larghezza - larghezzaEtichetta - 2, 12)
  const righeValore = valore ? (doc.splitTextToSize(valore, disponibile) as string[]) : []
  return { etichetta, larghezzaEtichetta, righeValore }
}

/** Quanto scende una riga-campo: il valore lungo si prende le righe che gli servono. */
function altezzaCella(cella: CellaCampo): number {
  return Math.max(cella.righeValore.length, 1) * PASSO_CAMPO
}

function disegnaCella(doc: jsPDF, cella: CellaCampo, x: number, y: number, larghezza: number): void {
  doc.setTextColor(...GRIGIO)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  if (cella.etichetta) doc.text(cella.etichetta, x, y)

  const xValore = x + (cella.etichetta ? cella.larghezzaEtichetta + 2 : 0)
  if (cella.righeValore.length === 0) {
    // Riga da compilare a penna: filetto 0,2 mm fino a fine colonna (§2).
    doc.setDrawColor(...GRIGIO)
    doc.setLineWidth(0.2)
    doc.line(xValore, y + 1, x + larghezza, y + 1)
    return
  }
  doc.setTextColor(...INCHIOSTRO)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  cella.righeValore.forEach((riga, i) => doc.text(riga, xValore, y + i * PASSO_CAMPO))
}

function disegnaCampi(s: Stato, campi: CampoPrestampato[], colonne: 1 | 2): void {
  const { doc } = s
  const larghezza = colonne === 2 ? LARGHEZZA_COLONNA : LARGHEZZA_UTILE
  const x = [MARGINE_SX, COLONNA_DX]

  // Le altezze si misurano coi font veri, non a stima: un valore lungo che va a capo
  // deve prendersi le righe che gli servono, o si stampa sopra a quello dopo.
  const righe: { celle: CellaCampo[]; altezza: number }[] = []
  for (let i = 0; i < campi.length; i += colonne) {
    const celle = campi.slice(i, i + colonne).map((campo) => preparaCella(doc, campo, larghezza))
    // Anche le righe di continuazione avanzano di 6,5 mm: il passo della specifica vale
    // per tutto il modulo, non solo per la prima riga di ogni campo.
    righe.push({ celle, altezza: Math.max(...celle.map(altezzaCella)) })
  }

  preferisciBloccoIntero(
    s,
    righe.reduce((somma, riga) => somma + riga.altezza, 0)
  )
  for (const riga of righe) {
    cambioPagina(s, riga.altezza)
    riga.celle.forEach((cella, i) => disegnaCella(doc, cella, x[i], s.y, larghezza))
    s.y += riga.altezza
  }
}

function disegnaCasella(doc: jsPDF, x: number, y: number, casella: CasellaPrestampato): void {
  doc.setDrawColor(...GRIGIO)
  doc.setLineWidth(0.3)
  doc.rect(x, y - LATO_CASELLA, LATO_CASELLA, LATO_CASELLA) // base allineata alla riga di scrittura
  if (casella.spuntata) {
    doc.setDrawColor(...VERDE)
    doc.setLineWidth(0.5)
    doc.line(x + 0.7, y - 1.9, x + 1.4, y - 0.9)
    doc.line(x + 1.4, y - 0.9, x + 2.9, y - 2.9)
  }
  doc.setTextColor(...INCHIOSTRO)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(casella.testo, x + LATO_CASELLA + 1.5, y)
}

function disegnaCaselle(s: Stato, caselle: CasellaPrestampato[]): void {
  const { doc } = s
  const applica = () => {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(...INCHIOSTRO)
  }
  applica()

  const larghezzaCasella = (casella: CasellaPrestampato) =>
    LATO_CASELLA + 1.5 + doc.getTextWidth(casella.testo) + 6

  const righe: CasellaPrestampato[][] = []
  let corrente: CasellaPrestampato[] = []
  let occupata = 0
  for (const casella of caselle) {
    const larghezza = larghezzaCasella(casella)
    if (corrente.length > 0 && occupata + larghezza > LARGHEZZA_UTILE) {
      righe.push(corrente)
      corrente = []
      occupata = 0
    }
    corrente.push(casella)
    occupata += larghezza
  }
  if (corrente.length > 0) righe.push(corrente)

  preferisciBloccoIntero(s, righe.length * PASSO_CAMPO)
  applica()
  for (const riga of righe) {
    if (cambioPagina(s, PASSO_CAMPO)) applica()
    let x = MARGINE_SX
    for (const casella of riga) {
      disegnaCasella(doc, x, s.y, casella)
      applica() // `disegnaCasella` lascia dietro di sé colori e spessori suoi
      x += larghezzaCasella(casella)
    }
    s.y += PASSO_CAMPO
  }
}

function disegnaElenco(s: Stato, voci: string[]): void {
  const { doc } = s
  const applica = () => {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(12)
    doc.setTextColor(...INCHIOSTRO)
  }
  applica()
  const preparate = voci.map((voce) => doc.splitTextToSize(voce, LARGHEZZA_UTILE - RIENTRO_ELENCO) as string[])

  preferisciBloccoIntero(
    s,
    preparate.reduce((somma, righe) => somma + righe.length * INTERLINEA, 0)
  )
  applica()
  for (const righe of preparate) {
    // Prima si prova a tenere insieme la singola voce, poi si cede riga per riga.
    if (preferisciBloccoIntero(s, righe.length * INTERLINEA)) applica()
    righe.forEach((riga, i) => {
      if (cambioPagina(s, INTERLINEA)) applica()
      if (i === 0) doc.text('•', MARGINE_SX, s.y)
      doc.text(riga, MARGINE_SX + RIENTRO_ELENCO, s.y)
      s.y += INTERLINEA
    })
  }
}

/** Le larghezze sono proporzioni: la larghezza utile è fissa e la somma la fa il motore. */
function normalizzaLarghezze(larghezze: number[] | undefined, colonne: number): number[] {
  if (colonne <= 0) return []
  const valide = larghezze && larghezze.length === colonne && larghezze.every((l) => l > 0) ? larghezze : null
  if (!valide) return new Array<number>(colonne).fill(LARGHEZZA_UTILE / colonne)
  const somma = valide.reduce((a, l) => a + l, 0)
  return valide.map((l) => (l / somma) * LARGHEZZA_UTILE)
}

interface RigaTabella {
  celle: string[][]
  altezza: number
}

/** Imposta il font della riga, che sia quella di testata o una riga di dati. */
function fontRigaTabella(doc: jsPDF, intestazione: boolean): void {
  doc.setFont('helvetica', intestazione ? 'bold' : 'normal')
  doc.setFontSize(intestazione ? 9 : 9.5)
}

/**
 * Una riga con le sue celle già mandate a capo e la sua altezza vera.
 *
 * L'altezza si misura anche per l'INTESTAZIONE, e non è un dettaglio: il certificato di
 * servizio (n. 47) ha sette colonne su 166 mm, cioè 23 mm l'una, e «ORDINE DI SCUOLA» a
 * 9 pt non ci sta su una riga. Con un'altezza fissa di 7 mm la seconda riga del titolo
 * finirebbe sopra il primo dato, e il difetto si vedrebbe solo su quel modulo lì.
 */
function preparaRigaTabella(
  doc: jsPDF,
  valori: string[],
  larghezze: number[],
  intestazione: boolean
): RigaTabella {
  fontRigaTabella(doc, intestazione)
  const celle = larghezze.map(
    (larghezza, i) => doc.splitTextToSize(valori[i] ?? '', larghezza - PADDING_TABELLA * 2) as string[]
  )
  const linee = Math.max(...celle.map((c) => Math.max(c.length, 1)))
  return { celle, altezza: Math.max(ALTEZZA_RIGA_TABELLA, linee * INTERLINEA_TABELLA + 3) }
}

/**
 * Dentro la tabella `s.y` è il BORDO SUPERIORE della riga, non la linea di scrittura:
 * i fondini e i filetti si disegnano dal bordo, e tenere due convenzioni in una funzione
 * sola è il modo più rapido di sbagliare di 4,6 mm ogni riga.
 */
function disegnaRigaTabella(
  s: Stato,
  riga: RigaTabella,
  larghezze: number[],
  intestazione: boolean
): void {
  const { doc } = s
  if (intestazione) {
    doc.setFillColor(...FONDO_TABELLA)
    doc.rect(MARGINE_SX, s.y, LARGHEZZA_UTILE, riga.altezza, 'F')
  }
  fontRigaTabella(doc, intestazione)
  doc.setTextColor(...(intestazione ? GRIGIO : INCHIOSTRO))
  let x = MARGINE_SX
  riga.celle.forEach((linee, i) => {
    linee.forEach((linea, j) => doc.text(linea, x + PADDING_TABELLA, s.y + 4.5 + j * INTERLINEA_TABELLA))
    x += larghezze[i]
  })
  s.y += riga.altezza
  // Filetto fra una riga e l'altra, nessun bordo verticale (§2).
  doc.setDrawColor(...GRIGIO)
  doc.setLineWidth(0.2)
  doc.line(MARGINE_SX, s.y, MARGINE_DX, s.y)
}

function disegnaTabella(
  s: Stato,
  intestazioni: string[],
  righe: string[][],
  larghezze: number[] | undefined,
  righeVuote: number
): void {
  const { doc } = s
  // Le intestazioni possono mancare (una tabella già titolata dalla sezione che la
  // precede): allora il numero di colonne lo dettano i dati. Uscire qui perché manca la
  // testata butterebbe via righe intere senza lasciare traccia — sul foglio non c'è
  // nemmeno lo spazio bianco a dire che mancano.
  const colonne = intestazioni.length || righe.find((riga) => riga.length > 0)?.length || 0
  if (colonne === 0) return
  const misure = normalizzaLarghezze(larghezze, colonne)

  const testata = intestazioni.length
    ? preparaRigaTabella(
        doc,
        intestazioni.map((titolo) => titolo.toUpperCase()),
        misure,
        true
      )
    : null
  const preparate = righe.map((riga) => preparaRigaTabella(doc, riga, misure, false))
  const vuote = Math.max(Math.trunc(righeVuote), 0)
  const vuota: RigaTabella = { celle: misure.map(() => []), altezza: ALTEZZA_RIGA_TABELLA }

  preferisciBloccoIntero(
    s,
    (testata?.altezza ?? 0) +
      preparate.reduce((somma, riga) => somma + riga.altezza, 0) +
      vuote * ALTEZZA_RIGA_TABELLA
  )
  if (testata) disegnaRigaTabella(s, testata, misure, true)

  // Una tabella lunga si spezza riga per riga, ma le intestazioni si ripetono: una
  // pagina di celle senza il nome delle colonne non si legge (§2).
  for (const riga of preparate) {
    if (cambioPagina(s, riga.altezza) && testata) disegnaRigaTabella(s, testata, misure, true)
    disegnaRigaTabella(s, riga, misure, false)
  }
  // Righe libere in coda: un modulo consegnato deve poter essere completato a penna.
  for (let i = 0; i < vuote; i++) {
    if (cambioPagina(s, vuota.altezza) && testata) disegnaRigaTabella(s, testata, misure, true)
    disegnaRigaTabella(s, vuota, misure, false)
  }

  s.y += 4 // respiro sotto l'ultimo filetto
}

/**
 * Riquadro «RISERVATO A…».
 *
 * Si spezza su più pagine come tutti gli altri blocchi: chiude la cornice a fine pagina,
 * ne riapre una sulla successiva e ripete il titoletto — la stessa disciplina delle
 * intestazioni di tabella. Prima non lo faceva, e un riquadro da più di ~35 campi usciva
 * dal foglio: gli ultimi campi non comparivano affatto nel PDF e quelli appena prima
 * finivano a cavallo del piè di pagina. Fuori dall'inviluppo dei diciassette modelli, sì,
 * ma un motore che perde un campo in silenzio non lo si lascia in giro perché «tanto
 * nessuno ci arriva».
 */
function disegnaRiquadro(s: Stato, titolo: string, campi: CampoPrestampato[]): void {
  const { doc } = s
  const larghezzaInterna = LARGHEZZA_UTILE - PADDING_RIQUADRO * 2
  const celle = campi.map((campo) => preparaCella(doc, campo, larghezzaInterna))
  const altezze = celle.map(altezzaCella)
  const altezza = TESTATA_RIQUADRO + altezze.reduce((somma, a) => somma + a, 0) + PADDING_RIQUADRO

  preferisciBloccoIntero(s, altezza + 4)
  s.y += 4
  // Una cornice non si apre in fondo alla pagina per chiudersi subito sotto: se lì non ci
  // sta nemmeno il primo campo si comincia dalla pagina nuova. Serve ai soli riquadri più
  // alti di una pagina intera — gli altri li ha già spostati `preferisciBloccoIntero`, che
  // però su quelli si arrende e lascia la quota dov'è.
  if (s.y + TESTATA_RIQUADRO + (altezze[0] ?? 0) + PADDING_RIQUADRO > LIMITE_CONTENUTO) nuovaPagina(s)

  const intestazione = (bordoAlto: number) => {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(...GRIGIO)
    doc.text(titolo.toUpperCase(), MARGINE_SX + PADDING_RIQUADRO, bordoAlto + TESTATA_RIQUADRO, {
      charSpace: SPAZIATURA_TITOLI,
    })
  }
  const cornice = (bordoAlto: number, bordoBasso: number) => {
    doc.setDrawColor(...GRIGIO)
    doc.setLineWidth(0.3)
    doc.rect(MARGINE_SX, bordoAlto, LARGHEZZA_UTILE, bordoBasso - bordoAlto)
  }

  let bordoAlto = s.y
  intestazione(bordoAlto)
  // `cursore` è l'ultima linea di scrittura usata: la cella successiva comincia un passo
  // più sotto, e la cornice si chiude un padding sotto l'ultima.
  let cursore = bordoAlto + TESTATA_RIQUADRO
  celle.forEach((cella, i) => {
    if (cursore + altezze[i] + PADDING_RIQUADRO > LIMITE_CONTENUTO) {
      cornice(bordoAlto, cursore + PADDING_RIQUADRO)
      nuovaPagina(s)
      bordoAlto = s.y
      intestazione(bordoAlto)
      cursore = bordoAlto + TESTATA_RIQUADRO
    }
    // Il campo si disegna sempre subito dopo il controllo, mai «al giro dopo»: è ciò che
    // impedisce a un campo altissimo di aprire una cornice vuota dietro l'altra.
    disegnaCella(doc, cella, MARGINE_SX + PADDING_RIQUADRO, cursore + PASSO_CAMPO, larghezzaInterna)
    cursore += altezze[i]
  })
  cornice(bordoAlto, cursore + PADDING_RIQUADRO)
  s.y = cursore + PADDING_RIQUADRO + 2
}

// ─── Firma ──────────────────────────────────────────────────────────────────────

const ALTEZZA_FIRMA_LEGALE = 20
const ALTEZZA_SOLO_LUOGO_DATA = 8

type FirmaGenitore = Extract<FirmaPrestampato, { tipo: 'genitore' }>

/**
 * jsPDF calcola la larghezza per `align: 'center'` SENZA tener conto di `charSpace`, e
 * quindi centra la stringa come se non fosse spaziata: su «IL LEGALE RAPPRESENTANTE», 24
 * caratteri, la qualifica scivolerebbe di un paio di millimetri rispetto al nome che sta
 * sotto — poco, ma visibile proprio perché i due sono incolonnati. Qui il centro si fa a mano.
 */
function testoCentratoSpaziato(doc: jsPDF, testo: string, centro: number, y: number, charSpace: number): void {
  const larghezza = doc.getTextWidth(testo) + charSpace * Math.max(testo.length - 1, 0)
  doc.text(testo, centro - larghezza / 2, y, { charSpace })
}

/**
 * Rete di sicurezza sul riquadro di attestazione (§3a): nel PDF non finiscono MAI email
 * né indirizzo IP — stanno nella ricevuta FEA, che è un altro documento e si scarica a
 * parte. Non è teoria: `buildReceiptPdf()` formatta il firmatario come «Nome <email>», e
 * un chiamante che riusa quella stringa qui infilerebbe l'email in un foglio che la
 * famiglia stampa e consegna a un ente. Meglio toglierla che fidarsi della convenzione.
 *
 * L'IPv6 si riconosce da quattro gruppi in su, non da tre: `10:24:33` è un orario, e una
 * regola più larga cancellerebbe l'istante della firma dal riquadro che serve ad attestarla.
 */
function senzaContattiPersonali(riga: string): string {
  return riga
    .replace(/<[^<>]*@[^<>]*>/g, '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '')
    .replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * Righe e ALTEZZA VERA del riquadro di attestazione della firma elettronica.
 *
 * Si compone prima di decidere dove cade la firma, e non è un giro inutile: l'altezza
 * dipende da quante righe vengono fuori dopo il capo automatico, e un firmatario con due
 * nomi o un metodo scritto per esteso ne producono due in più di quante ne immaginerebbe
 * una costante. Finché l'altezza era stimata a 30 mm, un certificato con firma del
 * genitore E riquadro di verifica poteva farli accavallare di qualche millimetro: la
 * guardia calcolava il tetto su un numero, il disegno usava l'altro.
 */
function componiAttestazione(doc: jsPDF, firma: FirmaGenitore): { righe: string[]; altezza: number } {
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  // Si ripuliscono i CAMPI e poi si compone, non il contrario: ripulendo la riga già
  // composta, un firmatario che fosse solo un'email lascerebbe sul foglio un mozzicone
  // «Firmato da» senza nessuno dopo.
  const firmatario = senzaContattiPersonali(firma.firmatario)
  const metodo = senzaContattiPersonali(firma.metodo)
  const istante = senzaContattiPersonali(firma.istante)
  const riferimento = senzaContattiPersonali(firma.riferimento)
  const righe = [
    firmatario ? `Firmato da ${firmatario}` : '',
    [metodo, istante].filter(Boolean).join(' — '),
    riferimento ? `Riferimento firma: ${riferimento}` : '',
  ]
    .filter((riga) => riga.length > 0)
    .flatMap((riga) => doc.splitTextToSize(riga, LARGHEZZA_RIQUADRO_FIRMA - 6) as string[])

  return { righe, altezza: 4 + righe.length * 4 + 2 }
}

/** Il blocco firma misurato: quanto ingombra, e la quota più bassa a cui può cominciare. */
interface FirmaComposta {
  /** Righe e altezza del riquadro di attestazione, solo per la firma del genitore. */
  attestazione: { righe: string[]; altezza: number } | null
  /** Quanto scende il blocco sotto la propria linea di scrittura. */
  altezza: number
  /** La quota più bassa a cui la linea di firma può cadere. */
  tetto: number
}

/**
 * Misura il blocco firma prima che il corpo venga impaginato.
 *
 * Serve prima perché il suo ingombro decide dove l'ultimo blocco di contenuto deve
 * fermarsi (`limitePerUltimoBlocco`). Per il genitore l'altezza è quella MISURATA del
 * riquadro, non una stima: è l'unico numero che il disegno poi rispetta davvero.
 */
function componiBloccoFirma(
  doc: jsPDF,
  documento: DocumentoPrestampato,
  verifica: VerificaComposta | null
): FirmaComposta {
  const firma = documento.firma
  const attestazione = firma.tipo === 'genitore' ? componiAttestazione(doc, firma) : null
  const altezza = attestazione
    ? STACCO_RIQUADRO_FIRMA + attestazione.altezza
    : firma.tipo === 'legaleRappresentante'
      ? ALTEZZA_FIRMA_LEGALE
      : ALTEZZA_SOLO_LUOGO_DATA

  // Mai sopra y=150, mai sotto y=240 (§2), e mai a cavallo del piè di pagina. Col
  // riquadro di verifica il fondo utile non è più il limite del contenuto ma il bordo
  // alto di quella cornice, sei millimetri più su: è ciò che garantisce che le DUE
  // CORNICI non si tocchino, non solo che l'ultima riga di testo stia più in alto.
  const fondo = verifica ? verifica.yAlto - DISTANZA_FIRMA_VERIFICA : LIMITE_CONTENUTO
  return { attestazione, altezza, tetto: Math.min(FIRMA_Y_MAX, fondo - altezza) }
}

function disegnaFirma(s: Stato, composta: FirmaComposta): void {
  const { doc, documento } = s
  const firma = documento.firma
  const { attestazione, tetto } = composta

  let y = Math.max(s.y + STACCO_FIRMA, FIRMA_Y_MIN)
  if (y > tetto) {
    // Prima di aprire una pagina nuova si stringe l'aria: si prende la quota più bassa
    // che il foglio concede, non il minimo — l'aria che c'è si usa tutta. Una pagina in
    // più costa un foglio E stacca la firma dal testo che sottoscrive; qualche
    // millimetro di stacco in meno non costa niente a nessuno.
    const compressa = Math.max(s.y + STACCO_FIRMA_MINIMO, FIRMA_Y_MIN)
    if (compressa <= tetto) {
      y = tetto
    } else {
      nuovaPagina(s)
      // Sulla pagina nuova il contenuto non pesa più, ma il tetto sì: un'attestazione
      // altissima può costringere la firma sopra y=150, e fra le due regole vince quella
      // che non fa accavallare due cornici — una firma un po' più in alto si legge, due
      // riquadri sovrapposti no.
      y = Math.max(Math.min(FIRMA_Y_MIN, tetto), s.y)
    }
  }
  s.y = y

  doc.setTextColor(...GRIGIO)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text('Luogo e data', MARGINE_SX, y)
  doc.setTextColor(...INCHIOSTRO)
  doc.setFontSize(11)
  doc.text(documento.luogoData, MARGINE_SX, y + 6)

  if (firma.tipo === 'legaleRappresentante') {
    doc.setTextColor(...GRIGIO)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    testoCentratoSpaziato(doc, 'IL LEGALE RAPPRESENTANTE', CENTRO_COLONNA_FIRMA, y, SPAZIATURA_TITOLI)

    // Nome assente: si lascia il vuoto invece di stampare una riga bianca che sembri un
    // nome. Il rifiuto vero sta a monte — un certificato senza legale rappresentante in
    // configurazione non si emette — ma qui almeno il difetto si vede a colpo d'occhio.
    const nome = firma.nome.trim()
    if (nome) {
      doc.setTextColor(...INCHIOSTRO)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(12)
      doc.text(nome, CENTRO_COLONNA_FIRMA, y + 6, { align: 'center' })
    }

    doc.setTextColor(...GRIGIO)
    doc.setFont('helvetica', 'italic')
    doc.setFontSize(8)
    doc.text(DICITURA_FIRMA_SOSTITUITA[0], CENTRO_COLONNA_FIRMA, y + 12, { align: 'center' })
    doc.text(DICITURA_FIRMA_SOSTITUITA[1], CENTRO_COLONNA_FIRMA, y + 15.5, { align: 'center' })
    return
  }

  if (attestazione) {
    doc.setTextColor(...GRIGIO)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.text('Firma del genitore/tutore', CENTRO_COLONNA_FIRMA, y, { align: 'center' })

    // Nessuna riga vuota da firmare a penna: il documento È GIÀ firmato, e il riquadro
    // lo attesta (§3a). Una riga da firmare sotto una firma elettronica dice al genitore
    // che qualcosa manca — e la prima volta che qualcuno la firma davvero, il PDF
    // archiviato smette di coincidere con quello che ha in mano la famiglia.
    doc.setDrawColor(...GRIGIO)
    doc.setLineWidth(0.3)
    doc.rect(X_RIQUADRO_FIRMA, y + STACCO_RIQUADRO_FIRMA, LARGHEZZA_RIQUADRO_FIRMA, attestazione.altezza)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...INCHIOSTRO)
    attestazione.righe.forEach((riga, i) => doc.text(riga, X_RIQUADRO_FIRMA + 3, y + 8 + i * 4))
  }
}

// ─── Riquadro di verifica (§4.3) ────────────────────────────────────────────────

/**
 * Protocollo e indirizzo di verifica, sopra il piede dell'ultima pagina.
 *
 * ⚠️ L'IMPRONTA SHA-256 NON SI STAMPA QUI, e non è una svista: l'impronta si calcola sui
 * byte del PDF, quindi scriverla dentro il PDF cambierebbe i byte di cui è l'impronta —
 * è circolare, e non tornerebbe mai a chi prova a verificarla. `protocolli.impronta_sha256`
 * contiene infatti l'impronta dei byte PRECEDENTI alla banda di segnatura (`applicaSegnatura()`
 * passa dopo). Sul foglio si dichiara che l'impronta è registrata al protocollo e si rimanda
 * alla pagina pubblica, dove chi ha ricevuto il documento confronta il file che ha in mano
 * con quella registrata. È la trappola che chi legge dopo rifarebbe, perché la specifica
 * disegna il riquadro con l'impronta dentro.
 */
const PADDING_VERIFICA = 3
const INTERLINEA_VERIFICA = 3.6

/** Righe, altezza e bordo alto del riquadro di verifica: misurati una volta sola. */
interface VerificaComposta {
  righe: string[]
  altezza: number
  /** Bordo ALTO. Il bordo basso è ancorato a `CARTA.contenutoFine`. */
  yAlto: number
}

/**
 * Il riquadro si àncora col bordo BASSO al fondo dell'area libera e cresce verso l'alto.
 *
 * Prima aveva un bordo alto fisso a 262 e cresceva verso il basso: con tre righe il fondo
 * cadeva a 278,8 mm, cioè dentro il piede a quattro colonne stampato sulla carta
 * (272,1→285,0). E il numero di righe non è noto in anticipo — dipende da quanto è lungo
 * il numero di protocollo dopo il capo automatico — quindi non c'era una costante che
 * potesse essere giusta per tutti i documenti. Ancorare il fondo la rende inutile.
 */
function componiVerifica(doc: jsPDF, verifica: VerificaPrestampato): VerificaComposta {
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  const righe = [
    `Documento emesso dal registro elettronico e registrato al protocollo n. ${verifica.numeroProtocollo} del ${verifica.dataProtocollo}.`,
    `L'impronta SHA-256 di questo documento è registrata nel registro di protocollo.`,
    `Verificabile su ${verifica.indirizzoVerifica} indicando il numero di protocollo.`,
  ].flatMap((riga) => doc.splitTextToSize(riga, LARGHEZZA_UTILE - PADDING_VERIFICA * 2) as string[])

  const altezza = PADDING_VERIFICA * 2 + righe.length * INTERLINEA_VERIFICA
  return { righe, altezza, yAlto: CARTA.contenutoFine - altezza }
}

function disegnaVerifica(doc: jsPDF, verifica: VerificaComposta): void {
  doc.setDrawColor(...GRIGIO)
  doc.setLineWidth(0.2)
  doc.rect(MARGINE_SX, verifica.yAlto, LARGHEZZA_UTILE, verifica.altezza)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...GRIGIO)
  verifica.righe.forEach((riga, i) =>
    doc.text(riga, MARGINE_SX + PADDING_VERIFICA, verifica.yAlto + 5 + i * INTERLINEA_VERIFICA)
  )
}
