import { describe, it, expect } from 'vitest'
import { estraiOrdinante } from '@/lib/pagamenti/estratto-conto/ordinante'

/**
 * ⚠️ NOMI INVENTATI. Le descrizioni qui sotto hanno la FORMA delle causali della banca
 * (misurata su 9.000 righe reali) ma i nomi sono segnaposto — FABBRI GIULIA, BIANCHI LUCA —
 * come nel resto della suite. Il repository è pubblico: mai un ordinante vero.
 *
 * La forma vera è: `BONIFICO A VOSTRO FAVORE … DA  <nome> PER  <causale> TRN <numero>`.
 * I marcatori che chiudono il nome sono, misurati: `PER` (8.360 righe su 9.000),
 * `TRN` (6.826), `SPESE` (2.082), `COMM` (2.026). `DA ` apre in 6.825.
 */
describe('estraiOrdinante', () => {
    it('prende il nome fra DA e PER', () => {
        expect(
            estraiOrdinante('BONIFICO A VOSTRO FAVORE BONIFICO SEPA DA  FABBRI GIULIA PER  RETTA SETTEMBRE TRN 0000000000000001'),
        ).toBe('FABBRI GIULIA')
    })

    it('riconosce anche COMM, SPESE e TRN come marcatori di chiusura', () => {
        expect(estraiOrdinante('BONIFICO DA  FABBRI GIULIA COMM 1,50')).toBe('FABBRI GIULIA')
        expect(estraiOrdinante('BONIFICO DA  FABBRI GIULIA SPESE 0,50')).toBe('FABBRI GIULIA')
        expect(estraiOrdinante('BONIFICO DA  FABBRI GIULIA TRN 0000000000000001')).toBe('FABBRI GIULIA')
    })

    it('PERLINI non è PER — il marcatore vuole il confine di parola', () => {
        // 16 righe su 9.000 portano un cognome che comincia per PER. Il caso che fa
        // davvero danno è il cointestato: senza `\b` il marcatore scatta dentro
        // «PERLINI» e il secondo nome viene TRONCATO VIA senza che nulla lo dica.
        expect(estraiOrdinante('BONIFICO DA  FABBRI GIULIA, PERLINI CARLO PER  RETTA TRN 1')).toBe(
            'FABBRI GIULIA, PERLINI CARLO',
        )
        expect(estraiOrdinante('BONIFICO DA  PERLINI CARLO PER  RETTA SETTEMBRE TRN 1')).toBe('PERLINI CARLO')
    })

    it('il DA deve stare da solo: una parola che FINISCE per DA non apre niente', () => {
        // Senza l'ancora `(?:^|\s)` la coda «…DA» di una parola qualunque apre la
        // cattura, e la riga restituisce un ordinante che nella causale non c'è.
        expect(estraiOrdinante('PAGAMENTO CANONE AZIENDA FABBRI GIULIA PER  NOLEGGIO TRN 7')).toBe('')
        // `ADDEBITO SEPA DD PER MANDATO …` è una forma vera (211 righe su 9.000):
        // non ha ordinante, e non deve inventarne uno.
        expect(estraiOrdinante('ADDEBITO SEPA DD PER MANDATO FABBRI GIULIA SPESE 2,00')).toBe('')
    })

    it("un «da» minuscolo non ruba il match al DA vero", () => {
        // Con il flag `i` la cattura partirebbe dal primo «da» e restituirebbe
        // «ordine permanente DA  FABBRI GIULIA»: mezza causale spacciata per un nome.
        expect(estraiOrdinante('ACCREDITO da ordine permanente DA  FABBRI GIULIA PER  RETTA')).toBe('FABBRI GIULIA')
    })

    it('la virgola resta dentro il nome: i cointestati sono una controparte sola', () => {
        expect(estraiOrdinante('BONIFICO DA  FABBRI GIULIA, BIANCHI LUCA PER  RETTA TRN 1')).toBe('FABBRI GIULIA, BIANCHI LUCA')
    })

    it('il doppio spazio interno si collassa, non separa', () => {
        expect(estraiOrdinante('BONIFICO DA  FABBRI  GIULIA PER  RETTA TRN 1')).toBe('FABBRI GIULIA')
    })

    it('non corregge il maiuscolo, non riordina, non ricuce gli spazi spuri dentro le parole', () => {
        // Riscrivere un nome è correggere in silenzio un dato che va mostrato com'è.
        expect(estraiOrdinante('BONIFICO DA  Perli ni Tommaso PER  RETTA')).toBe('Perli ni Tommaso')
    })

    it('senza marcatore di chiusura non estrae niente: mezza causale non è un nome', () => {
        expect(estraiOrdinante('BONIFICO DA  FABBRI GIULIA')).toBe('')
        // Le descrizioni della banca arrivano imbottite di spazi in coda: un ramo
        // «oppure fino a fine stringa» qui salverebbe l'intera causale come nome.
        expect(estraiOrdinante('BONIFICO ISTANTANEO DA  FABBRI GIULIA RIMBORSO SPESA CONDOMINIALE   ')).toBe('')
    })

    it('le operazioni senza ordinante danno stringa vuota', () => {
        expect(estraiOrdinante('STORNO DI OPERAZIONE')).toBe('')
        expect(estraiOrdinante('COMPETENZE (INTERESSI/ONERI)')).toBe('')
        expect(estraiOrdinante('ACCREDITI VARI RIMBORSO')).toBe('')
        expect(estraiOrdinante('IMPOSTA BOLLO CONTO CORRENTE')).toBe('')
        expect(estraiOrdinante('')).toBe('')
    })

    it('oltre 120 caratteri non è un nome: si preferisce il vuoto al falso', () => {
        const lungo = 'A'.repeat(121)
        expect(estraiOrdinante(`BONIFICO DA  ${lungo} PER  RETTA`)).toBe('')
        const limite = 'B'.repeat(120)
        expect(estraiOrdinante(`BONIFICO DA  ${limite} PER  RETTA`)).toBe(limite)
    })

    it('due chiamate di fila danno lo stesso risultato — la regex NON ha il flag g', () => {
        // Con `g` su una regex a livello di modulo `lastIndex` sopravvive alla chiamata
        // e salterebbe una riga su due: 3.400 ordinanti persi su 6.825.
        const riga = 'BONIFICO DA  FABBRI GIULIA PER  RETTA TRN 1'
        expect(estraiOrdinante(riga)).toBe('FABBRI GIULIA')
        expect(estraiOrdinante(riga)).toBe('FABBRI GIULIA')
        expect(estraiOrdinante('BONIFICO DA  BIANCHI LUCA PER  RETTA TRN 2')).toBe('BIANCHI LUCA')
        expect(estraiOrdinante(riga)).toBe('FABBRI GIULIA')
    })
})
