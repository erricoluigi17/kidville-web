import { describe, expect, it } from 'vitest'
import {
    FINESTRA_FORNITORI_MS,
    SOGLIA_RIFIUTI_FORNITORE,
    contaEsitiFornitore,
    fornitoreInAffanno,
    valutaFornitore,
    type RigaEsitoFornitore,
} from '@/lib/health/fornitori'

/**
 * EMAIL E PUSH: LA REGOLA, CON NUMERI LETTERALI (sessione 7 della seconda serie di robustezza).
 * `degradato` solo se i rifiuti sono almeno la soglia E più degli invii riusciti.
 */

const MIN = 60_000
const ADESSO = Date.parse('2026-10-20T10:00:00.000Z')

function r(livello: string, stato: number | null, occorrenze: unknown, faMs: number, operazione: string | null = 'emails'): RigaEsitoFornitore {
    return { livello, stato_http: stato, occorrenze, visto_l_ultima: new Date(ADESSO - faMs).toISOString(), operazione }
}

describe('le costanti', () => {
    it('24 ore e 3 rifiuti', () => {
        expect(FINESTRA_FORNITORI_MS).toBe(86_400_000)
        expect(SOGLIA_RIFIUTI_FORNITORE).toBe(3) // soglia
    })
})

describe('contaEsitiFornitore', () => {
    it('riuscito = info 2xx; rifiuto = error; tutto il resto non conta', () => {
        expect(
            contaEsitiFornitore([
                r('info', 200, 4, 30 * MIN),
                r('info', 202, 5, 5 * MIN),
                r('error', 403, 3, 10 * MIN),
                r('error', null, 2, 20 * MIN), // rete: nessuno stato, ma è un rifiuto
                r('warn', 429, 7, MIN), // transitorio, ritentato
                r('info', 404, 6, MIN), // token di un'app disinstallata
                r('info', 302, 1, MIN),
                r('info', 200, 50, MIN, 'oauth-token'), // un gettone ottenuto non consegna niente
            ]),
        ).toEqual({ riusciti: 9, rifiuti: 5, ultimoRiuscito: ADESSO - 5 * MIN })
    })

    it('occorrenze assenti, zero o negative contano come una riga', () => {
        expect(contaEsitiFornitore([r('error', 500, null, MIN), r('error', 500, 0, MIN), r('error', 500, -4, MIN)])).toEqual({
            riusciti: 0,
            rifiuti: 3,
            ultimoRiuscito: null,
        })
    })
})

describe('fornitoreInAffanno', () => {
    it.each([
        [0, 0, false],
        [0, 2, false], // soglia
        [0, 3, true], // soglia
        [3, 3, false],
        [3, 4, true],
        [6, 6, false],
        [5, 6, true],
        [40, 2, false],
        [100, 99, false],
    ])('%i riusciti e %i rifiutati → %s', (riusciti, rifiuti, atteso) => {
        expect(fornitoreInAffanno({ riusciti, rifiuti, ultimoRiuscito: null })).toBe(atteso)
    })
})

describe('valutaFornitore', () => {
    it('nessun invio: ok (una domenica non è un guasto)', () => {
        expect(valutaFornitore('resend', { riusciti: 0, rifiuti: 0, ultimoRiuscito: null }, ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: 'resend: nessun invio nelle ultime 24 h',
        })
    })

    it('solo rifiuti: degradato', () => {
        expect(valutaFornitore('resend', { riusciti: 0, rifiuti: 3, ultimoRiuscito: null }, ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: 'resend nelle ultime 24 h: 0 riusciti, 3 rifiutati, nessuno riuscito',
        })
    })

    it('più rifiuti che riusciti: degradato, con i minuti dall’ultimo riuscito (per difetto)', () => {
        expect(valutaFornitore('fcm', { riusciti: 5, rifiuti: 6, ultimoRiuscito: ADESSO - 125 * MIN - 59_999 }, ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: 'fcm nelle ultime 24 h: 5 riusciti, 6 rifiutati, ultimo riuscito 125 min fa',
        })
    })

    it('qualche rifiuto in mezzo a tanti invii: ok, e il dettaglio lo dice', () => {
        expect(valutaFornitore('web-push', { riusciti: 40, rifiuti: 2, ultimoRiuscito: ADESSO - 2 * MIN }, ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: 'web-push nelle ultime 24 h: 40 riusciti, 2 rifiutati, ultimo riuscito 2 min fa',
        })
    })
})
