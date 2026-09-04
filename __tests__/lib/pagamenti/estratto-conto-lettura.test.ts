import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as XLSX from 'xlsx'
import { EstrattoContoIlleggibile, leggiEstrattoConto } from '@/lib/pagamenti/estratto-conto/lettura'
import { interpretaFogli } from '@/lib/pagamenti/estratto-conto/tabella'

const spia = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (orig) => {
    const m = await orig<typeof import('@/lib/logging/logger')>()
    return { ...m, logEvento: spia.logEvento }
})

/**
 * ⚠️ NESSUN BINARIO COMMITTATO, NESSUN NOME VERO. Le fixture Excel si generano qui, in
 * memoria, con `XLSX.write`: un `.xls` vero della banca dentro un repository pubblico
 * sarebbe l'anagrafica di duecento famiglie.
 */
function excel(
    fogli: { nome: string; righe: unknown[][] }[],
    bookType: 'biff8' | 'xlsx',
    date1904 = false,
): Uint8Array {
    const wb = XLSX.utils.book_new()
    if (date1904) wb.Workbook = { WBProps: { date1904: true } }
    for (const f of fogli) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(f.righe), f.nome)
    return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType }) as Buffer)
}

/** La forma esatta del foglio della banca: preambolo, riga vuota, intestazione su due righe. */
const RIGHE_BANCA: unknown[][] = [
    ['Rapporto IT 00 X 00000 00000 000000000000 - CONTO DI PROVA'],
    [],
    ['Data', null, 'Descrizione', 'EUR', 'Caus.'],
    ['Operaz.', 'Valuta'],
    [46240, 46240, 'BONIFICO A VOSTRO FAVORE DA  FABBRI GIULIA PER  RETTA TRN 1', 80, '048'],
    [46246, 46246, 'BONIFICO A VOSTRO FAVORE DA  BIANCHI LUCA PER  RETTA TRN 2', 100, '048'],
]

const byte = (s: string) => new TextEncoder().encode(s)

beforeEach(() => spia.logEvento.mockClear())
afterEach(() => vi.unstubAllEnvs())

describe('il formato si deduce dai BYTE, non dall\'estensione', () => {
    it('riconosce csv, xls (OLE) e xlsx (zip)', () => {
        // Il browser manda `application/octet-stream` su quasi tutto: il tipo dichiarato
        // dal client non è un'informazione, è una speranza.
        expect(leggiEstrattoConto(byte('Data;Importo\n05/09/2026;150,00')).formato).toBe('csv')
        expect(leggiEstrattoConto(excel([{ nome: 'Movimenti', righe: RIGHE_BANCA }], 'biff8')).formato).toBe('xls')
        expect(leggiEstrattoConto(excel([{ nome: 'Movimenti', righe: RIGHE_BANCA }], 'xlsx')).formato).toBe('xlsx')
    })

    it("un .xls che in realtà è una tabella HTML si legge lo stesso, e i valori restano TESTO", () => {
        // Alcune banche chiamano `.xls` un file che è HTML. SheetJS lo legge — ma se lo
        // legge «formattato» reinterpreta da sé le celle CON REGOLE AMERICANE: `05/09/2026`
        // diventa il 9 MAGGIO e `150,00` diventa QUINDICIMILA. Leggendolo grezzo restano
        // stringhe, e a interpretarle è il nostro parser italiano.
        const html =
            '<html><body><table>' +
            '<tr><td>Data</td><td>Importo</td><td>Descrizione</td></tr>' +
            '<tr><td>05/09/2026</td><td>150,00</td><td>BONIFICO DA  FABBRI GIULIA PER  RETTA TRN 1</td></tr>' +
            '</table></body></html>'
        const esito = leggiEstrattoConto(byte(html), { nomeFile: 'Conti-16.xls' })
        expect(esito.formato).toBe('xls')
        const r = interpretaFogli(esito.fogli, { date1904: esito.date1904 })
        expect(r.movimenti).toHaveLength(1)
        expect(r.movimenti[0]).toMatchObject({ data_operazione: '2026-09-05', importo: 150 })
    })

    it('la stessa tabella HTML senza nome di file resta un csv', () => {
        const html = '<html><body><table><tr><td>Data</td></tr></table></body></html>'
        expect(leggiEstrattoConto(byte(html)).formato).toBe('csv')
    })
})

describe('la lettura di un foglio Excel', () => {
    it('restituisce TUTTI i fogli, nell\'ordine del workbook', () => {
        const esito = leggiEstrattoConto(
            excel(
                [
                    { nome: 'Movimenti', righe: RIGHE_BANCA },
                    { nome: 'Riscontro La Favorita', righe: [['Totale', 99999]] },
                ],
                'biff8',
            ),
        )
        expect(esito.fogli.map((f) => f.nome)).toEqual(['Movimenti', 'Riscontro La Favorita'])
    })

    it('le righe vuote RESTANO: senza, ogni riferimento «riga N» mentirebbe', () => {
        // Con `blankrows:false` la riga 5 del foglio finisce all'indice 4, e il numero di
        // riga che si mostra all'operatore non è più quello che lui vede nel suo file.
        const esito = leggiEstrattoConto(excel([{ nome: 'Movimenti', righe: RIGHE_BANCA }], 'biff8'))
        const righe = esito.fogli[0].righe
        expect(righe).toHaveLength(6)
        expect(righe[1]).toEqual([])
        expect(righe[3][0]).toBe('Operaz.')
    })

    it('la cella con FORMATO DATA resta un numero: niente `cellDates`', () => {
        // Il file vero ha `{ t:'n', v:46240, w:'8/6/26', z:'m/d/yy' }`. Con `cellDates:true`
        // SheetJS costruisce la Date in ora LOCALE: la cella diventa
        // `2026-08-05T22:00:00.000Z`, cioè — su una macchina che gira in UTC, come i
        // server — il GIORNO PRIMA. Qui il fuso è fissato a UTC apposta: è la condizione
        // in cui il difetto si vede, e quella in cui il codice gira in produzione.
        vi.stubEnv('TZ', 'UTC')
        const wb = XLSX.utils.book_new()
        const ws = XLSX.utils.aoa_to_sheet([
            ['Data', 'Importo', 'Descrizione'],
            [46240, 80, 'BONIFICO DA  FABBRI GIULIA PER  RETTA TRN 1'],
        ])
        // Il formato numerico che rende la cella «una data» agli occhi di SheetJS.
        ws['A2'].z = 'm/d/yy'
        XLSX.utils.book_append_sheet(wb, ws, 'Movimenti')
        const dati = new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }) as Buffer)

        const esito = leggiEstrattoConto(dati)
        expect(typeof esito.fogli[0].righe[1][0]).toBe('number')
        const r = interpretaFogli(esito.fogli, { date1904: esito.date1904 })
        expect(r.movimenti[0].data_operazione).toBe('2026-08-06')
    })

    it('le righe arrivano DENSE: dove la cella non esiste c\'è una cella vuota, non un buco', () => {
        // `sheet_to_json` restituisce array sparsi — la colonna B della riga
        // d'intestazione del file vero è una cella che NON esiste — e i buchi cambiano il
        // comportamento di `.map`/`.every`: si comportano come `undefined` finché qualcuno
        // non ne legge una proprietà, e allora è un TypeError a valle, lontano dalla causa.
        const esito = leggiEstrattoConto(excel([{ nome: 'Movimenti', righe: RIGHE_BANCA }], 'biff8'))
        const intestazione = esito.fogli[0].righe[2]
        expect(intestazione).toHaveLength(5)
        expect(1 in intestazione).toBe(true)
        expect(intestazione.map((c) => typeof c)).toHaveLength(5)
    })

    it('la data arriva come SERIALE, non come Date e non come testo formattato', () => {
        // `cellDates:true` costruirebbe le Date in ora LOCALE (a Roma il 6 agosto diventa
        // 2026-08-05T22:00Z) e il testo formattato `w` è in ordine americano («8/6/26»).
        // Il numero è l'unico dato della cella che non ha un'interpretazione.
        const esito = leggiEstrattoConto(excel([{ nome: 'Movimenti', righe: RIGHE_BANCA }], 'biff8'))
        expect(typeof esito.fogli[0].righe[4][0]).toBe('number')
        expect(esito.fogli[0].righe[4][0]).toBe(46240)
        expect(esito.fogli[0].righe[4][3]).toBe(80)
    })

    it('legge il foglio Movimenti anche quando NON è il primo', () => {
        // ⛔ Con `SheetNames[0]` si importa il foglio di riscontro del commercialista al
        // posto dei movimenti: un esito plausibile e completamente sbagliato.
        const esito = leggiEstrattoConto(
            excel(
                [
                    { nome: 'Riscontro La Favorita', righe: [['Data', 'Importo'], [46240, 999]] },
                    { nome: 'Movimenti', righe: RIGHE_BANCA },
                ],
                'biff8',
            ),
        )
        const r = interpretaFogli(esito.fogli, { date1904: esito.date1904 })
        expect(r.foglio).toBe('Movimenti')
        expect(r.movimenti).toHaveLength(2)
        expect(r.movimenti[0]).toMatchObject({ data_operazione: '2026-08-06', importo: 80, controparte: 'FABBRI GIULIA' })
        expect(r.intestazioni).toEqual(['Data Operaz.', 'Valuta', 'Descrizione', 'EUR', 'Caus.'])
    })

    it("l'epoca 1904 arriva fino al lettore delle date", () => {
        const righe: unknown[][] = [['Data', 'Importo', 'Descrizione'], [44778, 80, 'BONIFICO']]
        const esito = leggiEstrattoConto(excel([{ nome: 'Movimenti', righe }], 'biff8', true))
        expect(esito.date1904).toBe(true)
        const r = interpretaFogli(esito.fogli, { date1904: esito.date1904 })
        expect(r.movimenti[0].data_operazione).toBe('2026-08-06')
    })

    it('accetta un ArrayBuffer come un Uint8Array', () => {
        const u8 = excel([{ nome: 'Movimenti', righe: RIGHE_BANCA }], 'xlsx')
        const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
        expect(leggiEstrattoConto(ab).fogli[0].nome).toBe('Movimenti')
    })

    it('un file che SheetJS non riesce ad aprire diventa EstrattoContoIlleggibile', () => {
        // Firma zip valida, contenuto no: senza una classe dedicata la route non saprebbe
        // distinguere «file illeggibile» da un guasto suo, e risponderebbe 500.
        const finto = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8])
        expect(() => leggiEstrattoConto(finto)).toThrow(EstrattoContoIlleggibile)
    })
})

describe('la lettura di un CSV', () => {
    it('il BOM non finisce dentro la prima intestazione', () => {
        const esito = leggiEstrattoConto(byte('\uFEFFData;Importo\n05/09/2026;150,00'))
        expect(esito.fogli[0].righe[0][0]).toBe('Data')
    })

    it('un CSV UTF-8 valido non ripiega e non logga niente', () => {
        leggiEstrattoConto(byte('Data;Importo;Descrizione\n05/09/2026;150,00;RETTA DI SETTEMBRE'))
        expect(spia.logEvento).not.toHaveBeenCalled()
    })

    it('un CSV in windows-1252 si legge lo stesso, e il ripiego si DICHIARA', () => {
        // Un `catch` muto qui significherebbe: file letto male, nessuno che lo sa. Il
        // ripiego è legittimo, ma dev'essere visibile — altrimenti il giorno in cui la
        // banca cambia codifica nessuno saprà da quando i testi sono sbagliati.
        const dati = new Uint8Array([
            ...byte('Data;Importo;Descrizione\n05/09/2026;150,00;RETTA PERCH'),
            0xe8,
            ...byte(' SETTEMBRE'),
        ])
        const esito = leggiEstrattoConto(dati)
        expect(esito.formato).toBe('csv')
        expect(String(esito.fogli[0].righe[1][2])).toContain('è')
        // Il corpo dell'errore di decodifica viaggia col log: «non è UTF-8» senza dire
        // dove si è rotto è un'informazione che non fa risparmiare un minuto a nessuno.
        expect(spia.logEvento).toHaveBeenCalledWith(
            'pagamento',
            'info',
            expect.objectContaining({ esito: 'estratto_conto_latin1' }),
            expect.anything(),
        )
    })

    it('end-to-end: dai byte del CSV ai movimenti', () => {
        const csv = [
            'Rapporto IT 00 X 00000 00000 000000000000 - CONTO DI PROVA;;;;',
            ';;;;',
            'Data;;Descrizione;EUR;Caus.',
            'Operaz.;Valuta;;;',
            '06/08/26;06/08/26;BONIFICO DA  FABBRI GIULIA PER  RETTA TRN 1;80,00;048',
            '12/08/26;12/08/26;BONIFICO DA  BIANCHI LUCA PER  RETTA TRN 2;100,00;048',
        ].join('\r\n')
        const esito = leggiEstrattoConto(byte(csv), { nomeFile: 'Conti-16.csv' })
        const r = interpretaFogli(esito.fogli, { date1904: esito.date1904 })
        expect(r.movimenti).toHaveLength(2)
        expect(r.movimenti[0]).toMatchObject({ data_operazione: '2026-08-06', importo: 80, controparte: 'FABBRI GIULIA' })
        expect(r.scartate).toBe(0)
    })
})
