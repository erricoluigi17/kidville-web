import { describe, expect, it } from 'vitest'
import {
    MINUTI_CRON_ESITI_FERMO,
    finestraDaCadenza,
    finestraDaIntervallo,
    leggiRigheCronEsiti,
    valutaCronEsiti,
    type RigaCronEsito,
} from '@/lib/health/cron-esiti'

/**
 * GLI ESITI DEI CRON, LA DECISIONE (sessione 7 della seconda serie di robustezza).
 * Numeri letterali: se qualcuno allarga una finestra o cambia la regola, questi test lo vedono.
 */

const MIN = 60_000
const ADESSO = Date.parse('2026-10-20T10:00:00.000Z')

function riga(
    job: string,
    cadenza: string,
    esito: RigaCronEsito['esito'],
    vistoFaMin: number | null,
    vivoFaMin: number | null,
): RigaCronEsito {
    return {
        job,
        cadenza,
        esito,
        vistoIl: vistoFaMin === null ? null : ADESSO - vistoFaMin * MIN,
        vivoIl: vivoFaMin === null ? null : ADESSO - vivoFaMin * MIN,
    }
}

const OGNI_MINUTO = riga('storici-stampe', '* * * * *', 'ok', 1, 1)

describe('finestraDaCadenza — quanto silenzio è ancora normale', () => {
    it.each([
        ['* * * * *', 31],
        ['*/5 * * * *', 35],
        ['*/10 * * * *', 40],
        ['1,6,11,16,21,26,31,36,41,46,51,56 * * * *', 35],
        ['3,13,23,33,43,53 * * * *', 40],
        ['7,12,17,22,27,37,42,47,52,57 * * * *', 40],
        ['4,14,24,34,44,54 * * * *', 40],
        ['*/30 * * * *', 120],
        ['2,32 * * * *', 120],
        ['27 * * * *', 180],
        ['0 6 * * *', 1560],
        ['10,20,30,40,50 8 * * *', 1520],
        ['17 4 * * 0', 10200],
        ['11 5 * * 1', 10200],
        ['35 4 1 * *', 44760],
        ['30 seconds', 30.5],
    ])('«%s» → %s minuti', (cadenza, minuti) => {
        expect(finestraDaCadenza(cadenza)).toBe(minuti * MIN)
    })

    it.each([
        ['0 0 1 1 *', 'un mese preciso'],
        ['0 9 * * 1-5', 'un intervallo di giorni della settimana'],
        ['0 8 31 * *', 'un giorno che non tutti i mesi hanno'],
        ['0 8 1 * 1', 'giorno del mese E della settimana'],
        ['@daily', 'una scorciatoia'],
        ['61 * * * *', 'un minuto che non esiste'],
        ['0 25 * * *', 'un’ora che non esiste'],
        ['*/0 * * * *', 'un passo nullo'],
        ['0 6 * *', 'quattro campi'],
        ['', 'niente'],
    ])('«%s» (%s) → nessuna finestra', (cadenza) => {
        expect(finestraDaCadenza(cadenza)).toBeNull()
    })

    it('finestraDaIntervallo: la cadenza più il triplo, con un margine fra 30 minuti e 2 ore', () => {
        expect(finestraDaIntervallo(1)).toBe(31 * MIN)
        expect(finestraDaIntervallo(10)).toBe(40 * MIN)
        expect(finestraDaIntervallo(15)).toBe(60 * MIN)
        expect(finestraDaIntervallo(40)).toBe(160 * MIN)
        expect(finestraDaIntervallo(1440)).toBe(1560 * MIN)
    })
})

describe('valutaCronEsiti — la regola', () => {
    it('nessun job letto: degradato, perché un cron.job vuoto non è «tutto bene»', () => {
        expect(valutaCronEsiti([], ADESSO)).toEqual({ esito: 'degradato', dettaglio: 'nessun job attivo letto da cron.job' })
    })

    it('nessuna data in nessuna riga: cron-esiti non ha mai scritto', () => {
        expect(valutaCronEsiti([riga('a', '* * * * *', null, null, null), riga('b', '0 6 * * *', null, null, null)], ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; nessun esito registrato: cron-esiti non ha mai scritto',
        })
    })

    it('la data più fresca ha più di 30 minuti: cron-esiti è fermo, e lo dice', () => {
        expect(MINUTI_CRON_ESITI_FERMO).toBe(30)
        expect(
            valutaCronEsiti([riga('storici-stampe', '* * * * *', 'ok', 31, 31), riga('notifiche-promemoria', '0 6 * * *', 'ok', 240, 240)], ADESSO),
        ).toEqual({ esito: 'degradato', dettaglio: '2 job attivi; cron-esiti fermo da 31 min' })
    })

    it('trenta minuti esatti non sono ancora «fermo»', () => {
        expect(valutaCronEsiti([riga('storici-stampe', '* * * * *', 'ok', 30, 30)], ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: '1 job attivi',
        })
    })

    it('tutti dentro la finestra, mensili compresi: ok, con il numero dei job attivi', () => {
        const mensile = riga('notifiche-retention', '35 4 1 * *', 'ok', 27 * 24 * 60, 27 * 24 * 60)
        expect(valutaCronEsiti([OGNI_MINUTO, riga('notifiche-promemoria', '0 6 * * *', 'ok', 240, 240), mensile], ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: '3 job attivi',
        })
    })

    it('un giornaliero: 1560 minuti senza esito buono sono ancora dentro, 1561 no', () => {
        expect(valutaCronEsiti([OGNI_MINUTO, riga('notifiche-promemoria', '0 6 * * *', 'fallito', 240, 1560)], ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: '2 job attivi; ultimo esito fallito, ancora nella finestra: notifiche-promemoria',
        })
        expect(valutaCronEsiti([OGNI_MINUTO, riga('notifiche-promemoria', '0 6 * * *', 'fallito', 240, 1561)], ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: notifiche-promemoria',
        })
    })

    it('un timeout del client con la route viva conta come vivo, e si dice', () => {
        expect(valutaCronEsiti([OGNI_MINUTO, riga('push-dispatch', '*/5 * * * *', 'timeout', 2, 2)], ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: '2 job attivi; timeout del client, vivi: push-dispatch',
        })
    })

    it('un job nuovo, mai partito, è «in attesa», non un allarme', () => {
        expect(valutaCronEsiti([OGNI_MINUTO, riga('nuovo', '0 6 * * *', null, null, null)], ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: '2 job attivi; in attesa del primo esito: nuovo',
        })
    })

    it('un job partito e MAI riuscito è un allarme subito', () => {
        expect(valutaCronEsiti([OGNI_MINUTO, riga('mai-ok', '*/10 * * * *', 'fallito', 3, null)], ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: mai-ok',
        })
    })

    it('una cadenza che non si sa leggere si dice, senza allarme', () => {
        expect(valutaCronEsiti([OGNI_MINUTO, riga('strano', '0 9 * * 1-5', 'ok', 3, 3)], ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: '2 job attivi; cadenza non letta: strano',
        })
    })

    it('il dettaglio completo, nell’ordine: prima ciò che suona, poi ciò che si annota', () => {
        expect(
            valutaCronEsiti(
                [
                    OGNI_MINUTO,
                    riga('notifiche-promemoria', '0 6 * * *', 'fallito', 240, 27 * 60),
                    riga('fattura-sync', '*/30 * * * *', 'fallito', 5, 50),
                    riga('push-dispatch', '*/5 * * * *', 'timeout', 2, 2),
                    riga('nuovo', '0 6 * * *', null, null, null),
                    riga('strano', '0 9 * * 1-5', 'ok', 3, 3),
                ],
                ADESSO,
            ),
        ).toEqual({
            esito: 'degradato',
            dettaglio:
                '6 job attivi; senza un esito buono entro la finestra: notifiche-promemoria; ' +
                'ultimo esito fallito, ancora nella finestra: fattura-sync; timeout del client, vivi: push-dispatch; ' +
                'in attesa del primo esito: nuovo; cadenza non letta: strano',
        })
    })
})

describe('leggiRigheCronEsiti — la risposta della RPC', () => {
    it('legge le righe e converte le date', () => {
        expect(
            leggiRigheCronEsiti([
                { job: 'storici-stampe', cadenza: '* * * * *', esito: 'ok', visto_il: '2026-10-20T09:59:00+00:00', vivo_il: '2026-10-20T09:59:00+00:00' },
                { job: 'nuovo', cadenza: '0 6 * * *', esito: null, visto_il: null, vivo_il: null },
            ]),
        ).toEqual([
            { job: 'storici-stampe', cadenza: '* * * * *', esito: 'ok', vistoIl: ADESSO - MIN, vivoIl: ADESSO - MIN },
            { job: 'nuovo', cadenza: '0 6 * * *', esito: null, vistoIl: null, vivoIl: null },
        ])
    })

    it.each([
        ['non un elenco', { job: 'x' }],
        ['un job vuoto', [{ job: '', cadenza: '* * * * *', esito: 'ok', visto_il: null, vivo_il: null }]],
        ['un esito sconosciuto', [{ job: 'x', cadenza: '* * * * *', esito: 'succeeded', visto_il: null, vivo_il: null }]],
        ['una data illeggibile', [{ job: 'x', cadenza: '* * * * *', esito: 'ok', visto_il: 'ieri', vivo_il: null }]],
        ['una cadenza che non è testo', [{ job: 'x', cadenza: 5, esito: 'ok', visto_il: null, vivo_il: null }]],
        ['una riga nulla', [null]],
    ])('%s → illeggibile', (_caso, data) => {
        expect(leggiRigheCronEsiti(data)).toBeNull()
    })
})
