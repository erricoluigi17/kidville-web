import { describe, it, expect } from 'vitest'
import { percheAbbinato } from '@/lib/pagamenti/motivo-abbinamento'
import { codiceVoce } from '@/lib/pagamenti/codice-voce'

/**
 * PERCHÉ LA MACCHINA HA CHIUSO QUESTA RIGA — la ricostruzione, e i suoi limiti.
 *
 * ⚠️ IL FATTO CHE QUESTI TEST BLOCCANO PER PRIMO: il motivo **non è salvato da
 * nessuna parte**. `valutaCertezza` lo calcola e la fase automatica lo butta (lo
 * usa solo per l'aggregato delle rinunce). Qui si ricostruisce dai fatti che
 * restano — la causale e la voce — e ogni test dice quale delle due cose sta
 * misurando: una ricostruzione ESATTA, o un'onesta dichiarazione di ignoranza.
 *
 * Il codice voce si calcola con `codiceVoce()` invece di scriverlo a mano: un
 * letterale qui sarebbe un secondo generatore di codici, e il giorno in cui la
 * mescola cambiasse questi test resterebbero verdi su codici che non esistono
 * più. (Il lock `codice-voce-congelato` vieta proprio la seconda copia.)
 */

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const ALTRO_PID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
/** Un CF sintetico: repository PUBBLICO, mai un dato vero di una famiglia. */
const CF = 'RSSMRA10A01H501U'

describe('percheAbbinato — l’identificativo che ha agganciato', () => {
    it('riconosce il CODICE VOCE di QUESTA voce, e lo restituisce in forma canonica', () => {
        const codice = codiceVoce(PID)
        const esito = percheAbbinato({
            causale: `RETTA OTTOBRE ${codice}`,
            controparte: 'MARIO ROSSI',
            pagamentoId: PID,
            cfAlunno: null,
            composita: false,
        })
        expect(esito.motivi).toEqual(['codice_voce', 'residuo_esatto'])
        expect(esito.codice).toBe(codice)
    })

    it('🔴 NON dice «codice voce» se in causale c’è il codice di un’ALTRA voce', () => {
        // È il caso del bonifico che nomina la voce di un fratello mentre viene
        // chiuso su un'altra: dire «codice voce» lì sarebbe un perché FALSO
        // proprio nel caso in cui l'operatrice ne ha più bisogno.
        const esito = percheAbbinato({
            causale: `RETTA ${codiceVoce(ALTRO_PID)}`,
            controparte: '',
            pagamentoId: PID,
            cfAlunno: null,
            composita: false,
        })
        expect(esito.motivi).toEqual(['non_ricostruito', 'residuo_esatto'])
        expect(esito.codice).toBeNull()
    })

    it('riconosce il CODICE FISCALE dell’alunno della voce, e non lo restituisce', () => {
        const esito = percheAbbinato({
            causale: `PAGAMENTO RETTA ${CF}`,
            controparte: '',
            pagamentoId: PID,
            cfAlunno: CF,
            composita: false,
        })
        expect(esito.motivi).toEqual(['codice_fiscale', 'residuo_esatto'])
        // Il CF è un dato di un minore: entra nel confronto e non esce mai.
        expect(JSON.stringify(esito)).not.toContain(CF)
    })

    it('il CF di un ALTRO bambino in causale non aggancia questa voce', () => {
        const esito = percheAbbinato({
            causale: 'PAGAMENTO RETTA VRDLGU11B02H501X',
            controparte: '',
            pagamentoId: PID,
            cfAlunno: CF,
            composita: false,
        })
        expect(esito.motivi).toEqual(['non_ricostruito', 'residuo_esatto'])
    })

    it('li nomina TUTTI E DUE quando in causale ci sono entrambi', () => {
        const codice = codiceVoce(PID)
        const esito = percheAbbinato({
            causale: `${CF} RETTA ${codice}`,
            controparte: '',
            pagamentoId: PID,
            cfAlunno: CF,
            composita: false,
        })
        expect(esito.motivi).toEqual(['codice_voce', 'codice_fiscale', 'residuo_esatto'])
    })

    it('guarda anche la CONTROPARTE, non solo la causale', () => {
        // Gli export bancari a volte mettono il codice nel campo dell'ordinante.
        const codice = codiceVoce(PID)
        const esito = percheAbbinato({
            causale: 'BONIFICO',
            controparte: `MARIO ROSSI ${codice}`,
            pagamentoId: PID,
            cfAlunno: null,
            composita: false,
        })
        expect(esito.motivi).toEqual(['codice_voce', 'residuo_esatto'])
    })

    it('il confronto sul CF è insensibile al maiuscolo del dato di database', () => {
        const esito = percheAbbinato({
            causale: `RETTA ${CF}`,
            controparte: '',
            pagamentoId: PID,
            cfAlunno: CF.toLowerCase(),
            composita: false,
        })
        expect(esito.motivi).toEqual(['codice_fiscale', 'residuo_esatto'])
    })
})

describe('percheAbbinato — la quadratura è un’INVARIANTE, non una misura', () => {
    it('una voce sola ⇒ «residuo esatto»; più voci ⇒ «somma esatta»', () => {
        const codice = codiceVoce(PID)
        const sing = percheAbbinato({ causale: codice, controparte: '', pagamentoId: PID, cfAlunno: null, composita: false })
        const comp = percheAbbinato({ causale: codice, controparte: '', pagamentoId: PID, cfAlunno: null, composita: true })
        expect(sing.motivi.at(-1)).toBe('residuo_esatto')
        expect(comp.motivi.at(-1)).toBe('somma_esatta')
    })

    it('🔴 la quadratura si dice ANCHE quando l’identificativo non si ricostruisce', () => {
        // Non si ricalcola niente: sulla riga che la macchina ha chiuso, una sola
        // combinazione quadrava al centesimo — è la regola di `valutaCertezza`, e
        // resta vera anche quando oggi il CF è stato corretto o la voce ricreata.
        // Tacerla per prudenza toglierebbe l'unica cosa che ancora sappiamo.
        const esito = percheAbbinato({
            causale: 'BONIFICO SENZA NIENTE DI RICONOSCIBILE',
            controparte: '',
            pagamentoId: PID,
            cfAlunno: CF,
            composita: true,
        })
        expect(esito.motivi).toEqual(['non_ricostruito', 'somma_esatta'])
    })
})

describe('percheAbbinato — gli ingressi storti non fanno cadere niente', () => {
    it('causale, controparte e pagamento assenti: «non ricostruito», mai un’eccezione', () => {
        const esito = percheAbbinato({
            causale: null,
            controparte: null,
            pagamentoId: null,
            cfAlunno: null,
            composita: false,
        })
        expect(esito.motivi).toEqual(['non_ricostruito', 'residuo_esatto'])
        expect(esito.codice).toBeNull()
    })

    it('un `pagamentoId` vuoto non produce un codice vuoto che aggancia tutto', () => {
        // `codiceVoce('')` torna `''`, e una stringa vuota è «contenuta» in
        // qualunque elenco se il confronto è fatto male: la guardia è che il
        // codice atteso sia non vuoto PRIMA di cercarlo.
        const esito = percheAbbinato({
            causale: 'QUALUNQUE COSA',
            controparte: '',
            pagamentoId: '',
            cfAlunno: null,
            composita: false,
        })
        expect(esito.motivi).toContain('non_ricostruito')
        expect(esito.codice).toBeNull()
    })
})
