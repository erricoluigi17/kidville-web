import type { MovimentoCsv } from '../riconciliazione'

/**
 * I TIPI DEL CONFINE, che è tutta l'architettura di questa cartella.
 *
 * Da una parte `byte → matrice di celle` (`lettura.ts`), dall'altra
 * `matrice di celle → movimenti` (`tabella.ts`). In mezzo, `Cella[][]`.
 *
 * NON due interpreti separati per CSV ed Excel: divergerebbero al primo ritocco, e la
 * banca cambia formato senza avvisare. CSV ed Excel differiscono **solo** nel tipo delle
 * celle — l'uno porta stringhe, l'altro numeri e date; tutto il resto (il preambolo,
 * l'intestazione su due righe, i sinonimi delle colonne, gli scarti, l'ordinante) vive
 * scritto una volta sola.
 */

/**
 * Una cella come esce dal lettore.
 *
 * `Date` c'è perché SheetJS può restituirla (e altri fogli possono averla dentro), non
 * perché noi la chiediamo: `lettura.ts` legge senza `cellDates`, di proposito. Ma il tipo
 * la ammette, così `dataDaCella` è costretto a gestirla — ed è lì che sta la regola che
 * impedisce lo slittamento di un giorno.
 */
export type Cella = string | number | boolean | Date | null | undefined

/** Come sono arrivati i byte: dedotto dai BYTE, non dall'estensione. */
export type Formato = 'csv' | 'xls' | 'xlsx'

/** Un foglio come sta nel file: il suo nome e le sue righe, senza interpretazione. */
export interface FoglioGrezzo {
    nome: string
    righe: Cella[][]
}

/** Quello che il lettore consegna all'interprete: TUTTI i fogli, nell'ordine del file. */
export interface EsitoLettura {
    formato: Formato
    fogli: FoglioGrezzo[]
    /**
     * L'epoca del workbook. Excel per Mac contava dal 1904: se è vera, ogni seriale vale
     * 1462 giorni in più. Misurata `false` su tutti i file veri — ma sono tre righe, e
     * senza, un file esportato da un Mac datterebbe ogni movimento quattro anni prima.
     */
    date1904: boolean
}

/**
 * Quello che l'interprete consegna alla route — e i contatori sono la parte che conta.
 *
 * Fino a ieri esisteva solo `scartate`, e ci finiva dentro tutto: sull'estratto annuale
 * l'operatore avrebbe letto «2.221 righe scartate» su un import perfettamente riuscito,
 * perché 2.221 erano le USCITE, che questo modulo non importa per progetto. Un numero che
 * mette in allarme su un esito corretto è un numero che si impara a ignorare.
 */
export interface EsitoInterpretazione {
    movimenti: MovimentoCsv[]
    /** Righe dopo l'intestazione senza data o senza importo leggibile. Le vuote non contano. */
    scartate: number
    /** Righe leggibilissime, con importo ≤ 0: sono addebiti, e non si importano. */
    uscite: number
    /** Righe oltre il tetto: il troncamento smette di essere silenzioso. */
    troncate: number
    /** Movimenti rimasti senza controparte: il campanello che suona se la banca cambia forma. */
    senzaOrdinante: number
    /** Le intestazioni come sono state RISOLTE (già unite, se erano su due righe). */
    intestazioni: string[]
    /** Il nome del foglio scelto: senza, «non trovo le colonne» non dice dove non le ha trovate. */
    foglio: string
}
