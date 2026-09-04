import * as XLSX from 'xlsx'
import { logEvento } from '@/lib/logging/logger'
import type { Cella, EsitoLettura, FoglioGrezzo, Formato } from './tipi'
import { tabellaDaTesto } from './tabella'

/**
 * DAI BYTE ALLE CELLE — l'unico file di questa cartella che sa che esiste `xlsx`.
 *
 * Tutto il resto lavora su `Cella[][]` e non ha idea se quelle celle vengano da un CSV o
 * da un foglio Excel. È il confine che tiene insieme il modulo: aggiungere domani un
 * formato nuovo si fa qui e basta.
 */

/** Il file non si è potuto aprire: è un difetto del FILE, non un guasto del server. */
export class EstrattoContoIlleggibile extends Error {
    constructor(messaggio: string, opzioni?: { cause?: unknown }) {
        super(messaggio, opzioni)
        this.name = 'EstrattoContoIlleggibile'
    }
}

/** `PK\x03\x04` — un `.xlsx` è uno zip. */
const FIRMA_ZIP = [0x50, 0x4b, 0x03, 0x04]
/** `D0 CF 11 E0 A1 B1 1A E1` — un `.xls` BIFF8 è un contenitore OLE2. */
const FIRMA_OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

const NOME_EXCEL = /\.xlsx?$/i

const combacia = (dati: Uint8Array, firma: number[]): boolean =>
    dati.length >= firma.length && firma.every((b, i) => dati[i] === b)

/**
 * Il formato, dedotto dai BYTE.
 *
 * Il tipo MIME dichiarato dal browser non si guarda: su un upload da telefono arriva
 * `application/octet-stream` praticamente sempre, e su un `.xls` a volte arriva
 * `application/vnd.ms-excel` anche quando dentro c'è tutt'altro.
 *
 * L'UNICA cosa che il nome del file decide è il caso opposto: se finisce in `.xls`/`.xlsx`
 * ma i byte non sono né zip né OLE, si prova comunque con SheetJS — perché alcune banche
 * chiamano `.xls` una **tabella HTML**, e SheetJS la sa leggere.
 */
function formatoDa(dati: Uint8Array, nomeFile?: string): Formato {
    if (combacia(dati, FIRMA_ZIP)) return 'xlsx'
    if (combacia(dati, FIRMA_OLE)) return 'xls'
    if (nomeFile && NOME_EXCEL.test(nomeFile.trim())) return nomeFile.trim().toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'xls'
    return 'csv'
}

const inUint8 = (dati: ArrayBuffer | Uint8Array): Uint8Array =>
    dati instanceof Uint8Array ? dati : new Uint8Array(dati)

/**
 * Il testo di un CSV, con il ripiego dichiarato.
 *
 * `TextDecoder('utf-8')` toglie il BOM da sé — e il BOM va tolto, altrimenti la prima
 * intestazione si chiama `﻿Data` e non combacia con nessun sinonimo: la colonna della
 * data sparisce, e con lei tutti i movimenti.
 *
 * `fatal: true` serve a **sapere** quando il file non è UTF-8, invece di riempirlo di `�`
 * in silenzio. Il ripiego su `windows-1252` è legittimo — gli export bancari italiani lo
 * usano ancora — ma si LOGGA: il giorno in cui la banca cambia codifica, «da quando i
 * testi sono sbagliati?» deve avere una risposta.
 */
function testoCsv(dati: Uint8Array): string {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(dati)
    } catch (errore) {
        logEvento(
            'pagamento',
            'info',
            { esito: 'estratto_conto_latin1', n: dati.length },
            errore,
        )
        return new TextDecoder('windows-1252').decode(dati)
    }
}

/**
 * Una riga PIENA di buchi diventa una riga di celle vuote.
 *
 * `sheet_to_json` restituisce array **sparsi**: dove la cella non esiste (nel file vero è
 * la colonna B della riga d'intestazione) non c'è `undefined`, c'è un buco. E i buchi
 * cambiano il comportamento dei metodi di Array — `.map` li ricopia senza chiamare la
 * funzione, `.every` li salta — cioè si comportano come `undefined` finché qualcuno non
 * prova a leggerne una proprietà. Il confine byte→celle promette una MATRICE: la mantiene.
 */
const densa = (riga: Cella[]): Cella[] => Array.from({ length: riga.length }, (_, i) => riga[i])

function fogliDaWorkbook(dati: Uint8Array): { fogli: FoglioGrezzo[]; date1904: boolean } {
    let wb: XLSX.WorkBook
    try {
        // ⚠️ NIENTE `cellDates`: costruirebbe le Date in ora LOCALE, e in `Europe/Rome` il
        //    6 agosto diventa `2026-08-05T22:00:00.000Z`. Il seriale è un numero e basta.
        // ⚠️ `raw: true` non cambia NULLA su un BIFF8 o un xlsx (verificato sui file veri:
        //    stesse celle, stesso numero di righe) ma cambia tutto sull'HTML-travestito-da-
        //    `.xls`: senza, SheetJS reinterpreta le celle con regole AMERICANE e
        //    `05/09/2026` diventa il 9 maggio, `150,00` diventa quindicimila.
        wb = XLSX.read(dati, { type: 'array', raw: true })
    } catch (errore) {
        throw new EstrattoContoIlleggibile('Il file non si è potuto aprire come foglio di calcolo.', {
            cause: errore,
        })
    }
    const fogli = wb.SheetNames.map((nome) => ({
        nome,
        // `blankrows: true` è deliberato: con `false` gli indici scivolano (la riga 5 del
        // foglio finisce all'indice 4) e ogni riferimento «riga N» mostrato all'operatore
        // indicherebbe una riga diversa da quella che lui vede aprendo il file.
        righe: XLSX.utils
            .sheet_to_json<Cella[]>(wb.Sheets[nome], { header: 1, raw: true, blankrows: true })
            .map(densa),
    }))
    return { fogli, date1904: wb.Workbook?.WBProps?.date1904 === true }
}

/**
 * L'estratto conto letto: il formato, tutti i fogli nell'ordine del file, l'epoca.
 *
 * Non sceglie il foglio e non interpreta niente — quello è mestiere di `interpretaFogli`.
 * Restituire TUTTI i fogli è ciò che permette a quella funzione di cercare `Movimenti`
 * invece di accontentarsi del primo.
 */
export function leggiEstrattoConto(
    dati: ArrayBuffer | Uint8Array,
    opzioni?: { nomeFile?: string },
): EsitoLettura {
    const byte = inUint8(dati)
    const formato = formatoDa(byte, opzioni?.nomeFile)

    if (formato === 'csv') {
        return { formato, date1904: false, fogli: [{ nome: 'CSV', righe: tabellaDaTesto(testoCsv(byte)) }] }
    }

    const { fogli, date1904 } = fogliDaWorkbook(byte)
    return { formato, fogli, date1904 }
}
