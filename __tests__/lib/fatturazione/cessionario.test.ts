import { describe, it, expect } from 'vitest'
import {
    validaCessionario,
    cessionarioCompleto,
    codiceFiscaleIntestatarioValido,
    messaggioCessionarioIncompleto,
} from '@/lib/fatturazione/cessionario'

/**
 * IL GATE SULL'INTESTATARIO — il gemello che mancava.
 *
 * Sul CEDENTE il controllo esisteva ed era fail-closed. Sul CESSIONARIO l'unica
 * verifica era «il codice fiscale c'è»: indirizzo, CAP e comune entravano nell'XML
 * anche vuoti, e l'invio partiva DOPO che il numero era già stato allocato. Numero
 * bruciato più scarto SDI, che si corregge solo con una nota di variazione.
 *
 * ⚠️ Tutti i codici fiscali di questo file sono SINTETICI (repo pubblico, e sono
 * dati di famiglie): forme costruite a mano, non appartenenti a nessuno.
 */

/** Un'anagrafica completa e valida, da cui partire e su cui togliere un pezzo alla volta. */
const COMPLETA = {
    codice_fiscale: 'RSSMRA80A01H501U',
    nome: 'Mario',
    cognome: 'Rossi',
    indirizzo: 'Via Roma 1',
    cap: '81030',
    comune: 'Cesa',
}

describe('validaCessionario — o l\'anagrafica è emettibile, o si dice cosa manca', () => {
    it('un\'anagrafica completa non ha errori', () => {
        expect(validaCessionario(COMPLETA)).toEqual({})
        expect(cessionarioCompleto(COMPLETA)).toBe(true)
    })

    it('LA RESIDENZA VUOTA È IL DIFETTO: indirizzo, CAP e comune sono obbligatori', () => {
        // Misurato col validatore XSD di questo repo: questi tre vuoti producono tre
        // violazioni di `pattern` su `Indirizzo`, `CAP` e `Comune`. Prima passavano.
        const errori = validaCessionario({ ...COMPLETA, indirizzo: '', cap: '', comune: '' })
        expect(errori).toEqual({ indirizzo: 'mancante', cap: 'mancante', comune: 'mancante' })
        expect(cessionarioCompleto({ ...COMPLETA, cap: '   ' })).toBe(false)
    })

    it('nome e cognome sono elementi NON facoltativi del tracciato', () => {
        expect(validaCessionario({ ...COMPLETA, nome: '', cognome: null })).toEqual({
            nome: 'mancante',
            cognome: 'mancante',
        })
    })

    it('il CAP deve essere di 5 cifre: «8103» e «CE» non sono CAP', () => {
        expect(validaCessionario({ ...COMPLETA, cap: '8103' }).cap).toBe('formato')
        expect(validaCessionario({ ...COMPLETA, cap: 'CE' }).cap).toBe('formato')
    })

    it('la provincia NON è fra i campi: è facoltativa per il tracciato e si omette', () => {
        // Il cedente la pretende (nazione sempre IT, e lo scarto si scoprirebbe solo
        // per PEC); il cessionario no, e imporla bloccherebbe famiglie senza motivo.
        expect(Object.keys(validaCessionario(COMPLETA))).not.toContain('provincia')
    })
})

describe('il CODICE FISCALE dell\'intestatario: «c\'è» non basta', () => {
    it('LA MISURA DEL 2026-08-10: quattordici caratteri passano lo XSD e li scarta lo SDI', () => {
        // In produzione, su 22 righe `parents` con un `fiscal_code` valorizzato, VENTI
        // hanno la forma `XXXX99X99X999X` — quattordici caratteri, quattro lettere
        // iniziali invece di sei — e una ne ha due. Il `pattern` dello XSD
        // (`[A-Za-z0-9]{11,16}`) le accetta tutte: il documento sarebbe formalmente
        // valido e verrebbe scartato a valle (00301/00302), a numero già consumato.
        expect(validaCessionario({ ...COMPLETA, codice_fiscale: 'RSSM80A01H501U' }).codice_fiscale).toBe('formato')
        expect(validaCessionario({ ...COMPLETA, codice_fiscale: 'XY' }).codice_fiscale).toBe('formato')
        expect(validaCessionario({ ...COMPLETA, codice_fiscale: '' }).codice_fiscale).toBe('mancante')
    })

    it('L\'OMOCODIA NON SI RIFIUTA: le lettere al posto delle cifre sono codici VERI', () => {
        // Una regex `[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]` — quella che verrebbe
        // naturale — rifiuterebbe un codice fiscale legittimo e bloccherebbe
        // l'emissione a una famiglia che non ha nessuna colpa. `L M N P Q R S T U V`
        // sono le sostituzioni dell'Agenzia per le cifre da 0 a 9.
        expect(codiceFiscaleIntestatarioValido('RSSMRALMALHRLMU')).toBe(false) // 15: resta storto
        expect(codiceFiscaleIntestatarioValido('RSSMRAUMAMHRLMU')).toBe(false)
        expect(codiceFiscaleIntestatarioValido('RSSMRALMA0MH50MU')).toBe(true) // 16, con omocodia
        expect(validaCessionario({ ...COMPLETA, codice_fiscale: 'RSSMRALMA0MH50MU' })).toEqual({})
    })

    it('minuscole e spazi non sono un difetto dell\'anagrafica', () => {
        expect(codiceFiscaleIntestatarioValido(' rssmra80a01h501u ')).toBe(true)
    })

    it('un ente con 11 cifre resta ammesso: il tracciato lo prevede', () => {
        expect(codiceFiscaleIntestatarioValido('03394870616')).toBe(true)
        expect(codiceFiscaleIntestatarioValido('0339487061')).toBe(false)
    })
})

describe('il messaggio che legge la segreteria', () => {
    it('nomina i campi da correggere e dice che nessun numero è stato consumato', () => {
        const errori = validaCessionario({ ...COMPLETA, cap: '', codice_fiscale: 'XY' })
        const msg = messaggioCessionarioIncompleto(errori, 'Mario Rossi')
        expect(msg).toContain('codice fiscale (formato)')
        expect(msg).toContain('CAP')
        expect(msg).toContain('Nessun numero è stato consumato')
        // Il nome sta nel messaggio per chi opera — non nei log, dove entrano solo
        // uuid e conteggi.
        expect(msg).toContain('Mario Rossi')
    })
})
