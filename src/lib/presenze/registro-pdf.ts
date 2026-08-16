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
const X_SX = marchio.sinistra + marchio.larghezza + ARIA
/** Il bordo destro: dove comincia la colonna del piede stampato, meno l'aria. */
const X_DX = piede.sinistra - ARIA
const LARGHEZZA_UTILE = X_DX - X_SX

const Y_TITOLO = 16
const Y_TABELLA = 24
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

const COLONNA_NOME = 38
const COLONNA_RIEPILOGO = 7
const COLONNE_RIEPILOGO = 3
/** Sotto questa larghezza una colonna-giorno non tiene più due caratteri. */
const COLONNA_GIORNO_MINIMA = 5

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

export function buildRegistroPresenzePdf(input: RegistroPresenzeInput): Uint8Array {
  const { giorni, righe, etichette } = input
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })

  const larghezzaGiorno = Math.max(
    COLONNA_GIORNO_MINIMA,
    (LARGHEZZA_UTILE - COLONNA_NOME - COLONNE_RIEPILOGO * COLONNA_RIEPILOGO) /
      Math.max(1, giorni.length)
  )

  // ── Testata: testo, non una banda ────────────────────────────────────────────
  // La banda verde `rect(0, 0, 297, 20)` attraversava ENTRAMBE le colonne vietate della
  // carta girata: copriva il marchio della scuola a sinistra e il piede con la P.IVA a
  // destra. Qui restano il titolo e la riga di contesto, dentro l'area libera.
  doc.setTextColor(...VERDE)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text(etichette.titolo, X_SX, Y_TITOLO, { maxWidth: LARGHEZZA_UTILE })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...GRIGIO)
  doc.text(etichette.meta, X_DX, Y_TITOLO, { align: 'right' })

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
    columnStyles: { 0: { cellWidth: COLONNA_NOME } },
    // I margini SONO le due colonne vietate della carta girata: qui la tabella smette di
    // usare 281 mm di foglio e ne usa 245, che è ciò che la carta lascia libero.
    margin: { left: X_SX, right: LARGHEZZA_FOGLIO - X_DX, bottom: MARGINE_BASSO },
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
    doc.text(etichette.piePagina(p, pagine), (X_SX + X_DX) / 2, RIGA_SERVIZIO, { align: 'center' })
  }

  return new Uint8Array(doc.output('arraybuffer'))
}
