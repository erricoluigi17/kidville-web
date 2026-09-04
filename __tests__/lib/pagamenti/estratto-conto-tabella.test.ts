import { describe, it, expect } from 'vitest'
import {
    MAX_RIGHE,
    interpretaFogli,
    normIntestazione,
    separatore,
    tabellaDaTesto,
    trovaIntestazione,
} from '@/lib/pagamenti/estratto-conto/tabella'
import type { Cella } from '@/lib/pagamenti/estratto-conto/tipi'

/**
 * ⚠️ NOMI INVENTATI, IBAN INVENTATO. Le righe qui sotto hanno la FORMA esatta del file
 * che la banca esporta — preambolo, riga di soli separatori, intestazione spezzata su due
 * righe, anno a due cifre, ordine delle colonne — ma il contenuto è di fantasia.
 * Il repository è pubblico: mai un nome vero, mai un conto vero.
 */

/** La riga di preambolo: l'intestazione del rapporto, che NON è un'intestazione di tabella. */
const PREAMBOLO = 'Rapporto IT 00 X 00000 00000 000000000000 - CONTO DI PROVA;;;;'

const causale = (n: number) =>
    `BONIFICO A VOSTRO FAVORE BONIFICO SEPA DA  FABBRI GIULIA PER  RETTA NUMERO ${n} TRN 00000000000${String(n).padStart(5, '0')}`

/** Il file della banca: due righe di intestazione, e sessantacinque movimenti. */
function csvDellaBanca(quante = 65): string {
    const righe = [PREAMBOLO, ';;;;', 'Data;;Descrizione;EUR;Caus.', 'Operaz.;Valuta;;;']
    for (let i = 0; i < quante; i++) {
        const giorno = String((i % 28) + 1).padStart(2, '0')
        righe.push(`${giorno}/08/26;${giorno}/08/26;${causale(i)};${150 + i},00;048`)
    }
    return righe.join('\r\n')
}

const daCsv = (testo: string) => interpretaFogli([{ nome: 'Movimenti', righe: tabellaDaTesto(testo) }])

describe('il CSV vero della banca', () => {
    it('dà 65 movimenti su 65, non 0', () => {
        // ⛔ È IL TEST CHE È IL PUNTO DI TUTTO IL LOTTO. Sul file vero il lettore di ieri
        // restituiva ZERO movimenti su sessantacinque, e senza dire niente: prendeva la
        // riga 0 (il preambolo) per intestazione, non trovava né data né importo, e
        // dichiarava tutto scartato. Passa solo con ENTRAMBE le correzioni —
        // l'intestazione su due righe E l'anno a due cifre.
        const r = daCsv(csvDellaBanca())
        expect(r.movimenti).toHaveLength(65)
        expect(r.scartate).toBe(0)
        expect(r.uscite).toBe(0)
        expect(r.troncate).toBe(0)
        expect(r.movimenti[0]).toMatchObject({ data_operazione: '2026-08-01', importo: 150 })
        expect(r.movimenti[64]).toMatchObject({ data_operazione: '2026-08-09', importo: 214 })
    })

    it("l'intestazione spezzata su due righe si ricompone colonna per colonna", () => {
        const r = daCsv(csvDellaBanca(1))
        expect(r.intestazioni).toEqual(['Data Operaz.', 'Valuta', 'Descrizione', 'EUR', 'Caus.'])
    })

    it('il preambolo NON finisce fra le righe scartate', () => {
        // Due righe prima dell'intestazione (il rapporto e la riga di soli separatori):
        // contarle come scarti direbbe all'operatore che il suo file ha due difetti.
        const r = daCsv(csvDellaBanca(3))
        expect(r.movimenti).toHaveLength(3)
        expect(r.scartate).toBe(0)
    })

    it('la causale è la descrizione INTERA, e la controparte esce da lì', () => {
        const r = daCsv(csvDellaBanca(1))
        expect(r.movimenti[0].causale).toBe(causale(0))
        expect(r.movimenti[0].controparte).toBe('FABBRI GIULIA')
        expect(r.senzaOrdinante).toBe(0)
    })

    it("la colonna «Caus.» porta il codice ABI 048, non la causale, e non le viene scambiata", () => {
        const r = daCsv(csvDellaBanca(1))
        expect(r.movimenti[0].causale).not.toBe('048')
        expect(r.movimenti[0].causale).toContain('BONIFICO')
    })

    it('«EUR» è riconosciuta come colonna dell\'importo', () => {
        // Senza `EUR` fra i sinonimi l'indice dell'importo resta -1 e il file dà zero
        // movimenti ANCHE dopo aver trovato l'intestazione giusta.
        const r = daCsv(csvDellaBanca(1))
        expect(r.movimenti[0].importo).toBe(150)
    })
})

describe('quale colonna della data si prende', () => {
    it('prende Data Operaz., non Data Valuta', () => {
        // ⛔ Le due date differiscono su 797 righe su 9.000, e la data entra
        // nell'impronta anti-doppio-import: sbagliare colonna è un errore PERMANENTE.
        // Con la passata «esatta su tutti i sinonimi, poi includes su tutti» vinceva
        // `valuta`, perché `data operaz` non era in lista e `data valuta` sì.
        const csv = [
            PREAMBOLO,
            ';;;;',
            'Data;;Descrizione;EUR;Caus.',
            'Operaz.;Valuta;;;',
            '06/08/26;10/08/26;BONIFICO DA  FABBRI GIULIA PER  RETTA TRN 1;80,00;048',
        ].join('\n')
        const r = daCsv(csv)
        expect(r.movimenti).toHaveLength(1)
        expect(r.movimenti[0].data_operazione).toBe('2026-08-06')
    })

    it('con la VALUTA PRIMA dell\'operazione, vince lo stesso Data Operazione', () => {
        // ⛔ È QUI che serve la forma ordinata, e non la lista. Sul file della banca
        // l'ordine delle colonne salva capra e cavoli: `data operaz` sta in lista prima
        // di `data valuta`, e anche la ricerca di ieri — tutte le uguaglianze, poi tutti
        // i contenimenti — trova per prima la colonna giusta perché è la prima colonna.
        // Basta invertire le due colonne perché quella ricerca prenda la VALUTA: scandisce
        // le intestazioni nell'ordine del file, e `data valuta` è un'uguaglianza esatta
        // tanto quanto `data operazione`. Iterare sui SINONIMI in ordine di preferenza —
        // e per ciascuno prima l'uguaglianza, poi il contenimento — è l'unica forma che
        // dà lo stesso risultato qualunque sia l'ordine delle colonne nel file.
        const csv = [
            'Data Valuta;Data Operazione;Importo;Descrizione',
            '10/08/26;06/08/26;80,00;BONIFICO DA  FABBRI GIULIA PER  RETTA TRN 1',
        ].join('\n')
        const r = daCsv(csv)
        expect(r.movimenti).toHaveLength(1)
        expect(r.movimenti[0].data_operazione).toBe('2026-08-06')
    })

    it('quando c\'è solo la valuta, si usa quella', () => {
        const csv = ['Data Valuta;Importo;Descrizione', '10/08/26;80,00;BONIFICO'].join('\n')
        const r = daCsv(csv)
        expect(r.movimenti[0].data_operazione).toBe('2026-08-10')
    })
})

describe('separatore', () => {
    it('si conta sulle prime righe, non si indovina dalla prima', () => {
        // La prima riga di un estratto conto è il preambolo, e può non avere separatori
        // affatto: dedurre da lei sceglieva la virgola su un file punto-e-virgola,
        // e il file diventava una colonna sola.
        const righe = ['ESTRATTO CONTO DI PROVA', 'Data;Importo;Descrizione', '05/09/2026;150,00;BONIFICO']
        expect(separatore(righe)).toBe(';')
    })

    it('riconosce virgola, tabulazione e barra verticale', () => {
        expect(separatore(['date,amount,description', '2026-09-05,150.00,BONIFICO'])).toBe(',')
        expect(separatore(['Data\tImporto\tCausale', '05/09/2026\t150,00\tBONIFICO'])).toBe('\t')
        expect(separatore(['Data|Importo|Causale', '05/09/2026|150,00|BONIFICO'])).toBe('|')
    })

    it('un punto e virgola nella PROSA del preambolo non trasforma un file a virgole', () => {
        // La regola di ieri guardava solo `righe[0]`: un «;» dentro la frase del
        // preambolo bastava a scegliere il separatore sbagliato, e il file intero
        // diventava una colonna sola — cioè zero movimenti, con la faccia di un file vuoto.
        const csv = [
            'Estratto conto; periodo 01/08/2026 - 31/08/2026',
            'date,amount,description',
            '2026-08-06,80.00,BONIFICO DA  FABBRI GIULIA PER  RETTA TRN 1',
            '2026-08-12,100.00,BONIFICO DA  BIANCHI LUCA PER  RETTA TRN 2',
        ].join('\n')
        const r = daCsv(csv)
        expect(r.movimenti).toHaveLength(2)
        expect(r.movimenti[0]).toMatchObject({ data_operazione: '2026-08-06', importo: 80 })
    })

    it('la virgola dentro le virgolette non conta come separatore', () => {
        const righe = ['Data;Importo;Descrizione', '05/09/2026;150,00;"Retta, settembre, saldo"']
        expect(separatore(righe)).toBe(';')
    })
})

describe('normIntestazione', () => {
    it('minuscolo, accenti, BOM, punteggiatura di coda, spazi collassati', () => {
        // Il BOM con l'escape, non col carattere: scritto letterale sarebbe invisibile qui
        // dentro, e un editor che lo normalizzasse renderebbe questa riga una tautologia.
        //
        // ⚠️ Il BOM in TESTA passerebbe anche senza lo strip esplicito: in JS `\uFEFF` è
        // uno spazio per `\s` e per `trim()`. Misurato togliendo la riga: verde lo stesso.
        // A rendere quella riga necessaria è il BOM in MEZZO a un'intestazione, dove la
        // strada dello spazio dà `da ta` — che non combacia con nessun sinonimo, e la
        // colonna sparisce. Le due asserzioni non sono un doppione: la prima documenta,
        // la seconda è quella che tiene in vita la riga.
        expect(normIntestazione('\uFEFFData')).toBe('data')
        expect(normIntestazione('Da\uFEFFta')).toBe('data')
        expect(normIntestazione('Caus.')).toBe('caus')
        expect(normIntestazione('  Data   Operaz.  ')).toBe('data operaz')
        expect(normIntestazione('Valut\u00E0')).toBe('valuta')
        expect(normIntestazione('Valuta\u0300')).toBe('valuta')
        expect(normIntestazione('Importo (EUR):')).toBe('importo (eur)')
    })
})

describe('trovaIntestazione', () => {
    const righe = (t: string): Cella[][] => tabellaDaTesto(t)

    it('salta il preambolo e la riga di soli separatori', () => {
        const t = trovaIntestazione(righe(csvDellaBanca(2)))
        expect(t).not.toBeNull()
        expect(t?.riga).toBe(2)
        expect(t?.primaRigaDati).toBe(4)
        expect(t?.indici).toMatchObject({ data: 0, importo: 3, causale: 2 })
    })

    it('con una sola riga di intestazione i dati cominciano subito dopo', () => {
        const t = trovaIntestazione(righe('Data;Importo;Descrizione\n05/09/2026;150,00;BONIFICO'))
        expect(t?.riga).toBe(0)
        expect(t?.primaRigaDati).toBe(1)
        expect(t?.intestazioni).toEqual(['Data', 'Importo', 'Descrizione'])
    })

    it('una riga di dati NON viene scambiata per la continuazione di un\'intestazione', () => {
        // La riga sotto l'intestazione porta una data leggibile e un importo leggibile:
        // è un movimento, e mangiarsela costerebbe una riga a ogni import.
        const t = trovaIntestazione(righe('Data;Importo;Descrizione\n05/09/2026;150,00;BONIFICO'))
        expect(t?.primaRigaDati).toBe(1)
    })

    it('senza data o senza importo non è un\'intestazione', () => {
        expect(trovaIntestazione(righe('foo;bar\n1;2'))).toBeNull()
        expect(trovaIntestazione(righe('Data;Descrizione\n05/09/2026;BONIFICO'))).toBeNull()
    })

    it('il mapping esplicito prevale sui sinonimi', () => {
        const t = trovaIntestazione(righe('colA;colB\n05/09/2026;99,50'), { data: 'colA', importo: 'colB' })
        expect(t?.indici).toMatchObject({ data: 0, importo: 1 })
    })
})

describe('i contatori di interpretaFogli', () => {
    it('le uscite si contano a parte dalle righe illeggibili', () => {
        // Sull'estratto annuale le uscite sono 2.221: farle finire fra gli scarti
        // significa dire all'operatore che 2.221 righe sono andate perse su un import
        // riuscito. Un numero che allarma a torto è un numero che si impara a ignorare.
        const csv = [
            'Data;Importo;Descrizione',
            '05/09/2026;150,00;BONIFICO DA  FABBRI GIULIA PER  RETTA TRN 1',
            '06/09/2026;-30,00;PAGAMENTO POS',
            '07/09/2026;0,00;GIROCONTO',
            'non-una-data;abc;RIGA ROTTA',
            ';;',
        ].join('\n')
        const r = daCsv(csv)
        expect(r.movimenti).toHaveLength(1)
        expect(r.uscite).toBe(2)
        expect(r.scartate).toBe(1)
    })

    it('senza colonna Ordinante la controparte arriva dalla descrizione', () => {
        const csv = [
            'Data;Importo;Descrizione',
            '05/09/2026;150,00;BONIFICO DA  FABBRI GIULIA PER  RETTA TRN 1',
            '06/09/2026;150,00;ACCREDITI VARI RIMBORSO',
        ].join('\n')
        const r = daCsv(csv)
        expect(r.movimenti[0].controparte).toBe('FABBRI GIULIA')
        expect(r.movimenti[1].controparte).toBe('')
        expect(r.senzaOrdinante).toBe(1)
    })

    it('con la colonna Ordinante, la colonna vince sulla descrizione', () => {
        const csv = [
            'Data;Importo;Descrizione;Ordinante',
            '05/09/2026;150,00;BONIFICO DA  FABBRI GIULIA PER  RETTA TRN 1;BIANCHI LUCA',
        ].join('\n')
        const r = daCsv(csv)
        expect(r.movimenti[0].controparte).toBe('BIANCHI LUCA')
    })

    it('la colonna Ordinante vince ANCHE quando è vuota: non si ripiega sulla descrizione', () => {
        // Se la banca pubblica una colonna Ordinante e su una riga la lascia in bianco,
        // quel bianco È un'informazione: dice che quel movimento un ordinante non ce l'ha.
        // Dedurne uno dalla descrizione sovrascriverebbe un dato DICHIARATO con una
        // supposizione — e spegnerebbe `senzaOrdinante` proprio sulle righe per cui esiste.
        const csv = [
            'Data;Importo;Descrizione;Ordinante',
            '05/09/2026;150,00;BONIFICO DA  FABBRI GIULIA PER  RETTA TRN 1;',
        ].join('\n')
        const r = daCsv(csv)
        expect(r.movimenti).toHaveLength(1)
        expect(r.movimenti[0].controparte).toBe('')
        expect(r.senzaOrdinante).toBe(1)
    })

    it('oltre il tetto si DICHIARA il troncamento, non si tronca in silenzio', () => {
        // Il tetto di ieri era 2.000 e l'estratto annuale ne ha 9.004: l'import
        // avrebbe perso 7.004 righe senza che niente lo dicesse.
        expect(MAX_RIGHE).toBe(20000)
        const righe: Cella[][] = [['Data', 'Importo', 'Descrizione']]
        for (let i = 0; i < MAX_RIGHE + 3; i++) righe.push([46240, 10, 'BONIFICO DA  FABBRI GIULIA PER  RETTA TRN 1'])
        const r = interpretaFogli([{ nome: 'Movimenti', righe }])
        expect(r.movimenti).toHaveLength(MAX_RIGHE)
        expect(r.troncate).toBe(3)
    })
})

describe('la scelta del foglio', () => {
    const intestazione: Cella[] = ['Data', 'Importo', 'Descrizione']
    const movimento = (importo: number): Cella[] => [46240, importo, 'BONIFICO DA  FABBRI GIULIA PER  RETTA TRN 1']

    it('sceglie il foglio che si chiama Movimenti, non il primo che capita', () => {
        // ⛔ `Conti-15.xls` ha i fogli ["Movimenti", "Riscontro La Favorita"], ma
        // l'ordine non è garantito: prendere `SheetNames[0]` importa il foglio di
        // riscontro del commercialista al posto dei movimenti.
        const r = interpretaFogli([
            { nome: 'Riscontro La Favorita', righe: [intestazione, movimento(999)] },
            { nome: 'Movimenti', righe: [intestazione, movimento(150)] },
        ])
        expect(r.foglio).toBe('Movimenti')
        expect(r.movimenti[0].importo).toBe(150)
    })

    it('se il foglio Movimenti non risolve un\'intestazione, si prende il primo che la risolve', () => {
        const r = interpretaFogli([
            { nome: 'Movimenti', righe: [['una nota per gli umani']] },
            { nome: 'Estratto', righe: [intestazione, movimento(150)] },
        ])
        expect(r.foglio).toBe('Estratto')
        expect(r.movimenti).toHaveLength(1)
    })

    it('se nessun foglio ha un\'intestazione, restituisce il primo con le sue colonne', () => {
        // Senza le intestazioni, «non trovo le colonne» è un messaggio che non dice
        // all'operatore che cosa il lettore ha visto al posto loro.
        const r = interpretaFogli([
            { nome: 'Foglio1', righe: [['Colonna A', 'Colonna B'], ['x', 'y']] },
        ])
        expect(r.foglio).toBe('Foglio1')
        expect(r.movimenti).toHaveLength(0)
        expect(r.intestazioni).toEqual(['Colonna A', 'Colonna B'])
        expect(r.scartate).toBe(2)
    })
})

describe('regressione: il formato di ieri si legge esattamente come prima', () => {
    it('intestazione su una riga, separatore ; e importi italiani', () => {
        const csv = [
            'Data;Entrate;Descrizione;Ordinante',
            '05/09/2026;150,00;BONIFICO RETTA SETTEMBRE FABBRI GIULIA;PERLINI CARLO',
            '06/09/2026;-30,00;PAGAMENTO POS;—',
            '07/09/2026;1.234,56;SALDO GITA;BIANCHI',
        ].join('\n')
        const r = daCsv(csv)
        expect(r.movimenti).toHaveLength(2)
        expect(r.movimenti[0]).toMatchObject({
            data_operazione: '2026-09-05',
            importo: 150,
            causale: 'BONIFICO RETTA SETTEMBRE FABBRI GIULIA',
            controparte: 'PERLINI CARLO',
        })
        expect(r.movimenti[1].importo).toBe(1234.56)
        expect(r.uscite).toBe(1)
        expect(r.scartate).toBe(0)
    })

    it('separatore , con virgolette e date ISO', () => {
        const csv = 'date,amount,description\n2026-09-05,"150.00","Retta, settembre — Perlini"\n'
        const r = daCsv(csv)
        expect(r.movimenti).toHaveLength(1)
        expect(r.movimenti[0].causale).toContain('Retta, settembre')
    })

    it('senza colonne riconoscibili → nessun movimento', () => {
        expect(daCsv('foo;bar\n1;2\n').movimenti).toHaveLength(0)
    })
})
