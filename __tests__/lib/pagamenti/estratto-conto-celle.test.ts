import { describe, it, expect, vi, afterEach } from 'vitest'
import {
    dataDaCella,
    importoDaCella,
    parseData,
    parseImporto,
    serialeExcelAData,
} from '@/lib/pagamenti/estratto-conto/celle'

describe('parseData', () => {
    it('legge le forme italiane e la forma ISO', () => {
        expect(parseData('05/09/2026')).toBe('2026-09-05')
        expect(parseData('05.09.2026')).toBe('2026-09-05')
        expect(parseData('05-09-2026')).toBe('2026-09-05')
        expect(parseData('2026-09-05')).toBe('2026-09-05')
        expect(parseData('5/9/2026')).toBe('2026-09-05')
    })

    it("l'anno a due cifre è quello che scrive la banca: 06/08/26 è il 6 agosto 2026", () => {
        // Il CSV dell'estratto conto scrive SEMPRE l'anno a due cifre. Senza questo
        // ramo ogni riga del file vero è illeggibile: 65 movimenti su 65 scartati.
        expect(parseData('06/08/26')).toBe('2026-08-06')
        expect(parseData('24/07/24')).toBe('2024-07-24')
        expect(parseData('31/12/99')).toBe('1999-12-31')
    })

    it("l'ora in coda non disturba", () => {
        expect(parseData('05/09/2026 12:30')).toBe('2026-09-05')
        expect(parseData('2026-09-05T00:00:00.000Z')).toBe('2026-09-05')
    })

    it('31/02/2026 NON è una data: la verifica è di calendario, non di forma', () => {
        // Oggi passa e produce «2026-02-31»: arriva a Postgres, l'INSERT esplode con
        // 22008 e l'operatore vede una 500 su un errore che è del suo file.
        expect(parseData('31/02/2026')).toBeNull()
        expect(parseData('2026-02-31')).toBeNull()
        expect(parseData('29/02/2026')).toBeNull()
        expect(parseData('31/04/2026')).toBeNull()
        expect(parseData('13/13/2026')).toBeNull()
        expect(parseData('00/09/2026')).toBeNull()
    })

    it('il 29 febbraio di un anno bisestile è una data', () => {
        expect(parseData('29/02/2024')).toBe('2024-02-29')
    })

    it('quello che non è una data resta null', () => {
        expect(parseData('')).toBeNull()
        expect(parseData('Operaz.')).toBeNull()
        expect(parseData('Data')).toBeNull()
        expect(parseData('048')).toBeNull()
    })
})

describe('serialeExcelAData', () => {
    afterEach(() => vi.unstubAllEnvs())

    it('converte il seriale che sta davvero nel file della banca', () => {
        // A5 del file vero: { t:'n', v:46240 }. Il suo testo formattato dice «8/6/26»
        // in ordine AMERICANO: leggerlo sarebbe il 6 agosto letto come 8 giugno.
        expect(serialeExcelAData(46240)).toBe('2026-08-06')
        expect(serialeExcelAData(45497)).toBe('2024-07-24')
        expect(serialeExcelAData(46246)).toBe('2026-08-12')
    })

    it('la parte oraria non sposta il giorno', () => {
        expect(serialeExcelAData(46240.99)).toBe('2026-08-06')
    })

    it('fuori dalla finestra plausibile 1954-2064 non è una data', () => {
        expect(serialeExcelAData(0)).toBeNull()
        expect(serialeExcelAData(1)).toBeNull()
        expect(serialeExcelAData(19999)).toBeNull()
        expect(serialeExcelAData(60001)).toBeNull()
        expect(serialeExcelAData(Number.NaN)).toBeNull()
    })

    it("con l'epoca 1904 il seriale vale 1462 giorni in più", () => {
        expect(serialeExcelAData(44778, true)).toBe('2026-08-06')
    })

    it('il seriale non dipende dal fuso della macchina che esegue l\'import', () => {
        // L'aritmetica è in UTC e i getter devono esserlo: con i getter LOCALI la
        // conversione è giusta a Roma e sbagliata di un giorno a ovest di Greenwich,
        // cioè verde sul portatile di chi la scrive e rossa sul server che la esegue.
        vi.stubEnv('TZ', 'America/New_York')
        expect(serialeExcelAData(46240)).toBe('2026-08-06')
        expect(serialeExcelAData(45497)).toBe('2024-07-24')
        vi.stubEnv('TZ', 'Europe/Rome')
        expect(serialeExcelAData(46240)).toBe('2026-08-06')
        vi.stubEnv('TZ', 'Pacific/Kiritimati')
        expect(serialeExcelAData(46240)).toBe('2026-08-06')
    })
})

describe('dataDaCella', () => {
    afterEach(() => vi.unstubAllEnvs())

    it('dal numero passa per il seriale, dalla stringa per il parser', () => {
        expect(dataDaCella(46240)).toBe('2026-08-06')
        expect(dataDaCella('06/08/26')).toBe('2026-08-06')
        expect(dataDaCella(null)).toBeNull()
        expect(dataDaCella(undefined)).toBeNull()
        expect(dataDaCella(true)).toBeNull()
        expect(dataDaCella('Operaz.')).toBeNull()
    })

    it('una cella Date NON slitta di un giorno — fuso a est di Greenwich', () => {
        // `cellDates:true` costruisce le Date in ora LOCALE: a Roma il 6 agosto
        // diventa 2026-08-05T22:00Z e un `toISOString().slice(0,10)` dà il 5.
        vi.stubEnv('TZ', 'Europe/Rome')
        expect(dataDaCella(new Date(2026, 7, 6, 0, 0, 0))).toBe('2026-08-06')
        expect(dataDaCella(new Date(2026, 7, 6, 23, 59, 59))).toBe('2026-08-06')
    })

    it('una cella Date NON slitta di un giorno — fuso a ovest di Greenwich', () => {
        vi.stubEnv('TZ', 'America/New_York')
        expect(dataDaCella(new Date(2026, 7, 6, 0, 0, 0))).toBe('2026-08-06')
        expect(dataDaCella(new Date(2026, 7, 6, 23, 59, 59))).toBe('2026-08-06')
    })
})

describe('parseImporto', () => {
    it('legge il formato italiano', () => {
        expect(parseImporto('150,00')).toBe(150)
        expect(parseImporto('1.234,56')).toBe(1234.56)
        expect(parseImporto('€ 150,00')).toBe(150)
        expect(parseImporto('-30,00')).toBe(-30)
        expect(parseImporto('+80,00')).toBe(80)
    })

    it('legge il formato inglese, separatore delle migliaia compreso', () => {
        // È la forma del TESTO FORMATTATO dell'.xls (`w`). Senza guardare QUALE
        // separatore viene per ultimo, «1,234.56» diventa 1,23456 — quattro ordini
        // di grandezza sotto, e la riga si riconcilia con la quota di un'altra famiglia.
        expect(parseImporto('1234.56')).toBe(1234.56)
        expect(parseImporto('1,234.56')).toBe(1234.56)
        expect(parseImporto('80.00')).toBe(80)
    })

    it('quello che non è un importo resta null', () => {
        expect(parseImporto('')).toBeNull()
        expect(parseImporto('Caus.')).toBeNull()
        expect(parseImporto('—')).toBeNull()
    })
})

describe('importoDaCella', () => {
    it("dal numero prende il NUMERO, che è il solo dato non ambiguo dell'.xls", () => {
        expect(importoDaCella(1234.56)).toBe(1234.56)
        expect(importoDaCella(80)).toBe(80)
        expect(importoDaCella(321.99)).toBe(321.99)
    })

    it('lo zero è un importo leggibile, non una riga illeggibile', () => {
        // Serve a `interpretaFogli`: 0 è un'USCITA (importo ≤ 0), non uno scarto.
        expect(importoDaCella(0)).toBe(0)
        expect(importoDaCella(-30)).toBe(-30)
    })

    it('dalla stringa passa per il parser, dal resto niente', () => {
        expect(importoDaCella('1.234,56')).toBe(1234.56)
        expect(importoDaCella(null)).toBeNull()
        expect(importoDaCella(undefined)).toBeNull()
        expect(importoDaCella(true)).toBeNull()
        expect(importoDaCella('048')).toBe(48)
    })
})
