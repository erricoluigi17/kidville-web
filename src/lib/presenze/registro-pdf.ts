/**
 * Il registro presenze mensile in PDF — l'unico foglio ORIZZONTALE dell'app.
 *
 * ─── PERCHÉ NON È PIÙ NEL BROWSER (2026-08-16) ─────────────────────────────────
 *
 * Fino a ieri questo PDF nasceva dentro `MonthlyAttendanceTable.tsx`, cioè in un
 * componente client, con `jspdf-autotable` importato a richiesta. Sulla carta intestata
 * non poteva restarci: l'asset della carta pesa 1,1 MB, e importarlo da un componente
 * client vorrebbe dire 1,1 MB scaricati da ogni telefono e da ogni tablet della scuola.
 * L'alternativa scartata — servire l'asset da una rotta e comporre nel browser —
 * scaricherebbe quegli stessi 1,1 MB a ogni stampa e lascerebbe un sesto motore fuori dal
 * motore comune.
 *
 * ─── SULL'ORIZZONTALE LE FASCE VIETATE SONO DUE COLONNE, NON DUE FASCE ─────────
 *
 * La carta è un A4 verticale: su un foglio 297×210 ci sta solo girata di 90°. Il marchio
 * della scuola non è quindi «i primi 27 mm dall'alto» ma una **colonna** sul bordo
 * sinistro (12,5 → 27,05 mm), e il piede a quattro colonne una colonna sul bordo destro
 * (272,1 → 285,1). Chi leggesse `CARTA.brandFine` — che è una quota verticale — su questo
 * foglio impaginerebbe benissimo una pagina che non esiste: è già successo, e la «R» di
 * «REGISTRO PRESENZE» finiva esattamente sulle lettere di «PRIMARIA ·».
 *
 * Perciò qui non si legge `CARTA` a mano: si chiede a `fasceVietate(larghezza, altezza)`,
 * che sa dove il giro porta le due fasce. Fra le due restano **245 mm** — non i 281 che
 * questa tabella usava — e le colonne dei giorni si stringono di conseguenza.
 *
 * ⚠️ **Questi byte non sono un documento finito**: la carta la stende la rotta
 * (`src/app/api/admin/registro-presenze/pdf/route.ts`) con `applicaCartaIntestata()`. Chi
 * impagina legge solo i numeri della geometria, che non porta con sé pdf-lib né l'asset.
 *
 * ─── LE ETICHETTE ARRIVANO DA FUORI ────────────────────────────────────────────
 *
 * Nessuna stringa utente è scritta qui dentro: le porta il chiamante, tradotte, dal
 * namespace `teacherPresenze`. È la stessa scelta che il componente faceva prima, e resta
 * l'unico modo di avere lo stesso foglio in italiano e in inglese.
 *
 * Testato in `__tests__/lib/presenze-registro-pdf.test.ts`.
 */

import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { fasceVietate } from '@/lib/carta/geometria'

/** Lo stato di una cella: gli stessi quattro di `presenze.stato`. */
export type StatoCella = 'presente' | 'assente' | 'ritardo' | 'uscita_anticipata'

export interface RigaRegistro {
  cognome: string
  nome: string
  /** Giorno ISO (`YYYY-MM-DD`) → stato. I giorni senza riga non ci sono. */
  giorni: Record<string, StatoCella>
  /** I conteggi, calcolati a monte con la regola dei FATTI del registro. */
  riepilogo: { presenze: number; assenze: number; ritardi: number }
}

export interface EtichetteRegistro {
  titolo: string
  meta: string
  studente: string
  abbrevP: string
  abbrevA: string
  abbrevR: string
  /** Stato → lettera da stampare nella cella (localizzata: R/U diventano L/E in inglese). */
  simboli: Record<string, string>
  /** I sette nomi dei giorni, indicizzati come `getUTCDay()` (0 = domenica). */
  giorni: string[]
  piePagina: (n: number, tot: number) => string
}

export interface RegistroPresenzeInput {
  /** I giorni del mese, in ISO `YYYY-MM-DD`, in ordine. */
  giorni: string[]
  righe: RigaRegistro[]
  etichette: EtichetteRegistro
}

const LARGHEZZA_FOGLIO = 297
const ALTEZZA_FOGLIO = 210

/**
 * L'aria fra il contenuto e le due colonne stampate sulla carta. Quattro millimetri: meno
 * si legge come un errore di stampa, di più costa una colonna di giorni.
 */
const ARIA = 4

const { marchio, piede } = fasceVietate(LARGHEZZA_FOGLIO, ALTEZZA_FOGLIO)
/** Il bordo sinistro del contenuto: dove finisce la colonna del marchio, più l'aria. */
export const X_SX = marchio.sinistra + marchio.larghezza + ARIA
/** Il bordo destro: dove comincia la colonna del piede stampato, meno l'aria. */
export const X_DX = piede.sinistra - ARIA
export const LARGHEZZA_UTILE = X_DX - X_SX

const CORPO_TITOLO = 15
const CORPO_META = 9
const Y_TITOLO = 16
/** Dove la riga di contesto va a capo quando accanto al titolo non ci sta. */
const Y_META_SOTTO = 21
/** L'aria minima fra la fine del titolo e l'inizio della riga di contesto. */
const ARIA_TESTATA = 6
export const Y_TABELLA = 24
/**
 * La riga di servizio, in fondo al foglio orizzontale: la LINEA DI SCRITTURA di
 * «Pagina n di m». Esportata perché il lock la misura invece di ricopiarla — un test che
 * riscrive il numero che sorveglia non sorveglia niente.
 */
export const RIGA_SERVIZIO = 201
const MARGINE_BASSO = ALTEZZA_FOGLIO - RIGA_SERVIZIO + 4
/**
 * Dove la tabella ha l'obbligo di aver finito: è il margine basso che si passa ad
 * autoTable, letto dall'altra parte. **Sotto questa quota il motore non disegna nulla**, e
 * ci sono due ragioni, non una: sotto c'è la riga di servizio, e sotto ancora c'è la carta
 * intestata della scuola con la sua filigrana.
 */
export const FONDO_TABELLA = ALTEZZA_FOGLIO - MARGINE_BASSO

/**
 * La colonna del nome, e perché è 42 e non 38.
 *
 * ⚠️ **W9 l'aveva stretta a 38 mm, e la stretta si pagava in nomi tagliati.** 42 mm era il
 * valore del vecchio `NAME_COL` del componente browser; passando alla carta intestata
 * questa colonna ha ceduto quattro millimetri insieme al resto, con `overflow: 'hidden'`,
 * cioè un troncamento netto a metà parola, senza puntini e senza avviso. Misurato a 9 pt
 * grassetto, un cognome composto con un nome doppio supera i 40 mm utili: il registro
 * usciva con «Di Girolamo Alessandr».
 *
 * È un documento che serve a **una cosa sola**: dire quale bambino era presente. E i
 * quattro millimetri non erano nemmeno necessari — con 42 la colonna-giorno resta a 5,61
 * mm su 31 giorni, sopra il minimo che questo file stesso dichiara qui sotto.
 */
export const COLONNA_NOME = 42
const COLONNA_RIEPILOGO = 7
const COLONNE_RIEPILOGO = 3
/** Sotto questa larghezza una colonna-giorno non tiene più due caratteri. */
export const COLONNA_GIORNO_MINIMA = 5

/**
 * Quanto resta a ciascun giorno del mese, con la colonna del nome e le tre del riepilogo
 * già tolte. Esportata perché il lock rifà il conto invece di ricopiarne il risultato: chi
 * domani stringe di nuovo la colonna del nome — o allarga il riepilogo — vede subito se
 * l'ha pagata la griglia dei giorni.
 */
export function larghezzaColonnaGiorno(numeroGiorni: number): number {
  return Math.max(
    COLONNA_GIORNO_MINIMA,
    (LARGHEZZA_UTILE - COLONNA_NOME - COLONNE_RIEPILOGO * COLONNA_RIEPILOGO) /
      Math.max(1, numeroGiorni)
  )
}

const VERDE: [number, number, number] = [0, 106, 95]
const GRIGIO: [number, number, number] = [100, 100, 100]
const BIANCO: [number, number, number] = [255, 255, 255]
const GRIGIO_CHIARO: [number, number, number] = [230, 230, 230]

const COLORE_STATO: Record<StatoCella, [number, number, number]> = {
  presente: [200, 230, 201],
  assente: [255, 205, 210],
  ritardo: [255, 236, 179],
  uscita_anticipata: [187, 222, 251],
}
const INCHIOSTRO_STATO: Record<StatoCella, [number, number, number]> = {
  presente: [27, 94, 32],
  assente: [183, 28, 28],
  ritardo: [230, 119, 0],
  uscita_anticipata: [80, 80, 80],
}

/**
 * Il giorno della settimana di una data ISO, ancorato a UTC.
 *
 * `new Date('2026-05-01')` letto con `getDay()` dipende dal fuso del PROCESSO: su Vercel
 * gira in UTC, in locale no, e un sabato può diventare un venerdì. Qui la data è una
 * stringa, non un istante: si legge con `getUTCDay()` e non cambia mai lettura.
 */
function giornoSettimana(iso: string): number {
  const [anno, mese, giorno] = iso.split('-').map(Number)
  return new Date(Date.UTC(anno, (mese ?? 1) - 1, giorno ?? 1)).getUTCDay()
}

function numeroDelGiorno(iso: string): string {
  return String(Number(iso.slice(8, 10)))
}

/**
 * Un testo che sta dentro una larghezza data, col taglio DICHIARATO se serve tagliare.
 *
 * `maxWidth` di jsPDF non taglia: manda a capo, e una riga in più in testa a questo foglio
 * finisce dentro la tabella. Qui il testo si accorcia con i puntini di sospensione, che è
 * l'unico modo onesto di dire «qui manca qualcosa» — a differenza di `overflow: 'hidden'`,
 * che taglia a metà parola e sembra il nome vero.
 */
function accorcia(doc: jsPDF, testo: string, larghezzaMax: number): string {
  if (larghezzaMax <= 0) return ''
  if (doc.getTextWidth(testo) <= larghezzaMax) return testo
  let taglio = testo
  while (taglio.length > 0 && doc.getTextWidth(`${taglio}...`) > larghezzaMax) {
    taglio = taglio.slice(0, -1)
  }
  return `${taglio.trimEnd()}...`
}

export function buildRegistroPresenzePdf(input: RegistroPresenzeInput): Uint8Array {
  const { giorni, righe, etichette } = input
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })

  const larghezzaGiorno = larghezzaColonnaGiorno(giorni.length)

  /**
   * ── Testata: testo, non una banda, e SU OGNI FOGLIO ──────────────────────────
   *
   * La banda verde `rect(0, 0, 297, 20)` attraversava ENTRAMBE le colonne vietate della
   * carta girata: copriva il marchio della scuola a sinistra e il piede con la P.IVA a
   * destra. Qui restano il titolo e la riga di contesto, dentro l'area libera.
   *
   * ⚠️ **E si ridisegnano a ogni pagina, non una volta sola (2026-08-16).** Titolo e meta
   * si stampavano prima di `autoTable`, quindi vivevano solo sul primo foglio: dalla
   * seconda pagina restava una griglia di lettere senza nome, senza mese e senza classe.
   * Non è un caso limite — la tabella tiene 23 righe per pagina e la sezione più numerosa
   * in produzione ne ha 33, quindi **ogni registro vero è a due fogli**, che si stampano,
   * si firmano e si archiviano: due fogli spillati si separano, e il secondo diventa
   * illeggibile per chiunque non fosse presente alla stampa.
   *
   * ⚠️ **E la riga di contesto non ha più licenza di crescere verso sinistra.** Il titolo
   * aveva `maxWidth`, la meta no: con un nome di sezione lungo — e nessuno lo vincola —
   * la meta finiva stampata SOPRA il titolo, entrambi illeggibili. Misurato: il titolo
   * andava da 31,0 a 132,2 mm e la meta cominciava a 66,7. Ora lo spazio si misura, e se
   * sulla riga del titolo non ci sta, la meta va a capo sotto — mai addosso.
   */
  const disegnaTestata = (): void => {
    doc.setTextColor(...VERDE)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(CORPO_TITOLO)
    const titolo = accorcia(doc, etichette.titolo, LARGHEZZA_UTILE)
    doc.text(titolo, X_SX, Y_TITOLO)
    const larghezzaTitolo = doc.getTextWidth(titolo)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(CORPO_META)
    doc.setTextColor(...GRIGIO)
    const accantoAlTitolo = LARGHEZZA_UTILE - larghezzaTitolo - ARIA_TESTATA
    const staSullaRiga = doc.getTextWidth(etichette.meta) <= accantoAlTitolo
    const larghezzaMeta = staSullaRiga ? accantoAlTitolo : LARGHEZZA_UTILE
    doc.text(
      accorcia(doc, etichette.meta, larghezzaMeta),
      X_DX,
      staSullaRiga ? Y_TITOLO : Y_META_SOTTO,
      { align: 'right' }
    )
  }

  const intestazioniGiorni = giorni.map((iso) => {
    const dow = giornoSettimana(iso)
    const festivo = dow === 0 || dow === 6
    return {
      content: `${(etichette.giorni[dow] ?? ' ')[0]}\n${numeroDelGiorno(iso)}`,
      styles: {
        halign: 'center' as const,
        fontSize: 7,
        cellWidth: larghezzaGiorno,
        fillColor: festivo ? GRIGIO_CHIARO : VERDE,
        textColor: festivo ? GRIGIO : BIANCO,
      },
    }
  })

  const testata = [
    [
      {
        content: etichette.studente,
        styles: { halign: 'left' as const, fontSize: 8, cellWidth: COLONNA_NOME },
      },
      ...intestazioniGiorni,
      ...(
        [
          [etichette.abbrevP, [46, 125, 50]],
          [etichette.abbrevA, [183, 28, 28]],
          [etichette.abbrevR, [230, 119, 0]],
        ] as const
      ).map(([etichetta, fondo]) => ({
        content: etichetta,
        styles: {
          halign: 'center' as const,
          fontSize: 8,
          cellWidth: COLONNA_RIEPILOGO,
          fillColor: fondo as unknown as [number, number, number],
          textColor: BIANCO,
        },
      })),
    ],
  ]

  const corpo = righe.map((riga) => [
    {
      content: `${riga.cognome} ${riga.nome}`,
      styles: { fontSize: 9, fontStyle: 'bold' as const },
    },
    ...giorni.map((iso) => {
      const stato = riga.giorni[iso]
      const festivo = giornoSettimana(iso) === 0 || giornoSettimana(iso) === 6
      return {
        content: stato ? (etichette.simboli[stato] ?? '') : '',
        styles: {
          halign: 'center' as const,
          fontSize: 8,
          fontStyle: 'bold' as const,
          fillColor: stato ? COLORE_STATO[stato] : festivo ? ([240, 240, 240] as [number, number, number]) : undefined,
          textColor: stato ? INCHIOSTRO_STATO[stato] : ([80, 80, 80] as [number, number, number]),
        },
      }
    }),
    ...(
      [
        [riga.riepilogo.presenze, [46, 125, 50]],
        [riga.riepilogo.assenze, [183, 28, 28]],
        [riga.riepilogo.ritardi, [230, 119, 0]],
      ] as const
    ).map(([valore, colore]) => ({
      content: String(valore),
      styles: {
        halign: 'center' as const,
        fontSize: 10,
        fontStyle: 'bold' as const,
        textColor: colore as unknown as [number, number, number],
      },
    })),
  ])

  autoTable(doc, {
    startY: Y_TABELLA,
    head: testata,
    body: corpo,
    theme: 'grid',
    styles: {
      cellPadding: { top: 1.5, bottom: 1.5, left: 1, right: 1 },
      lineColor: [200, 200, 200],
      lineWidth: 0.2,
      minCellHeight: 7,
      overflow: 'hidden',
    },
    headStyles: {
      fillColor: VERDE,
      textColor: BIANCO,
      fontStyle: 'bold',
      fontSize: 8,
      minCellHeight: 10,
    },
    alternateRowStyles: { fillColor: [252, 250, 248] },
    // `linebreak` e non `ellipsize`: su un registro di scuola un nome tagliato — anche coi
    // puntini — è un bambino identificato a metà. Se il cognome composto non ci sta, va a
    // capo dentro la sua cella e la riga si alza di qualche decimo: costa una riga in meno
    // per pagina, non un nome.
    columnStyles: { 0: { cellWidth: COLONNA_NOME, overflow: 'linebreak' } },
    // I margini SONO le due colonne vietate della carta girata: qui la tabella smette di
    // usare 281 mm di foglio e ne usa 245, che è ciò che la carta lascia libero.
    //
    // ⚠️ `top` DEVE valere quanto `startY`: senza, dalla seconda pagina autoTable riparte
    // dal margine di default (~14 mm) e la prima riga finisce addosso alla testata che il
    // gancio qui sotto ha appena ristampato.
    margin: { top: Y_TABELLA, left: X_SX, right: LARGHEZZA_FOGLIO - X_DX, bottom: MARGINE_BASSO },
    // Il gancio è libero perché il piede si stampa in una passata finale: qui ci va la
    // testata, che è l'unica cosa che deve comparire su OGNI foglio.
    didDrawPage: disegnaTestata,
  })

  // ─── Il piede di servizio, in UNA passata sola e alla fine ───────────────────
  //
  // ⚠️ **QUI C'ERA UNA BANDA BIANCA CHE MANGIAVA LA CARTA (riparata il 2026-08-16).**
  //
  // Il piede si scriveva due volte: una dentro `didDrawPage`, che non può conoscere il
  // totale delle pagine mentre lo stampa, e una qui col totale vero. Per non ritrovarsi
  // due testi sovrapposti, questa seconda passata copriva la prima con un rettangolo
  // BIANCO OPACO di 237 × 6 mm — e su carta intestata quel rettangolo non copriva una riga
  // di testo: copriva la CARTA. Misurato a 200 dpi sul documento composto, il grigio della
  // filigrana mascotte (#F4F4F4, valore 244) diventava 255 puro fra 196,9 e 202,9 mm, con
  // le sagome del nastro «KIDVILLE» tagliate da un bordo orizzontale netto. E non era un
  // caso limite: la tabella tiene 23 righe per pagina, la sezione più numerosa ne ha 33,
  // quindi OGNI registro vero è a due pagine e portava la banda.
  //
  // Si toglie la CAUSA, non il sintomo: il gancio non scrive più niente, il piede si
  // stampa solo qui, e non c'è più niente da coprire. Sotto le due pagine non si scrive
  // affatto — come negli altri quattro motori di questo lavoro: il numero di pagina di una
  // pagina sola è rumore su un documento di scuola.
  const pagine = doc.getNumberOfPages()
  if (pagine < 2) return new Uint8Array(doc.output('arraybuffer'))
  for (let p = 1; p <= pagine; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'italic')
    doc.setFontSize(7)
    doc.setTextColor(...GRIGIO)
    // A destra, come negli altri quattro motori: era l'unico centrato, e l'unico che
    // scriveva qualcosa ACCANTO al numero di pagina. Quel qualcosa era «Registro
    // Elettronico Kidville» — il nome del prodotto su un foglio la cui carta porta già
    // ragione sociale, P.IVA e le tre sedi. La spec lo dice due volte: nel piede l'app non
    // scrive nulla. Ora la stringa `pdfPiePagina` è «Pagina {n} di {tot}» e basta.
    doc.text(etichette.piePagina(p, pagine), X_DX, RIGA_SERVIZIO, { align: 'right' })
  }

  return new Uint8Array(doc.output('arraybuffer'))
}
