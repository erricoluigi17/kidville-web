import { describe, expect, it } from 'vitest'
import {
    caricaFasceEffettive,
    fasceDellaSettimana,
    lunediDi,
    settimanaDiRiferimento,
    settimanaModificabile,
    settimaneDelPeriodo,
} from '@/lib/crm/settimane'
import type { FasciaRow, SettimanaRow } from '@/lib/crm/tipi'
import { creaFintoSupabase, type DBFinto } from '../../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../../fixtures/sedi'

/**
 * LE SETTIMANE DI DISPONIBILITÀ · «una settimana mai toccata è uguale all'ultima registrata prima di lei».
 *
 * Tutto lavora su GIORNI CIVILI (`YYYY-MM-DD`) e non conosce l'orologio: nessun test dipende dalla data
 * in cui gira. Calendario di riferimento (verificato): lunedì 2026-10-19 e 2026-10-26; la domenica 25/10/2026
 * finisce l'ora legale (alle 3 di notte), quella del 29/3/2026 comincia.
 */

const P = '30000000-0000-4000-8000-000000000001'
const Q = '30000000-0000-4000-8000-000000000002'

function testata(o: Partial<SettimanaRow> & Pick<SettimanaRow, 'id' | 'settimana'>): SettimanaRow {
    return { scuola_id: SEDE_A, utente_id: P, aggiornata_da: null, aggiornata_il: '2026-10-01T00:00:00Z', ...o }
}
function fascia(o: Partial<FasciaRow> & Pick<FasciaRow, 'id' | 'settimana_id'>): FasciaRow {
    return {
        scuola_id: SEDE_A,
        giorno_settimana: 1,
        ora_inizio: '09:00:00',
        ora_fine: '12:00:00',
        durata_slot_min: 45,
        ...o,
    }
}

/** La persona P: 2026-10-05 → lunedì 9–12; 2026-10-19 → mercoledì 14–17. */
const SETTIMANE_P = [testata({ id: 's-1', settimana: '2026-10-05' }), testata({ id: 's-2', settimana: '2026-10-19' })]
const FASCE_P = [
    fascia({ id: 'f-1', settimana_id: 's-1', giorno_settimana: 1, ora_inizio: '09:00:00', ora_fine: '12:00:00' }),
    fascia({ id: 'f-2', settimana_id: 's-2', giorno_settimana: 3, ora_inizio: '14:00:00', ora_fine: '17:00:00' }),
]

const effettiva = (utenteId: string | null, settimana: string, giornoSettimana: number, oraInizio: string, oraFine: string) => ({
    utenteId,
    settimana,
    giornoSettimana,
    oraInizio,
    oraFine,
    durataSlotMin: 45,
})

describe('lunediDi', () => {
    it('la domenica del cambio dell’ora (25/10/2026) appartiene alla settimana del 19', () => {
        // Review Focus 5: è la prova che il lunedì non passa da una `Date` locale.
        expect(lunediDi('2026-10-25')).toBe('2026-10-19')
    })

    it('un lunedì è il lunedì di sé stesso; il giorno prima è della settimana prima', () => {
        expect(lunediDi('2026-10-26')).toBe('2026-10-26')
        expect(lunediDi('2026-10-25')).not.toBe('2026-10-26')
    })

    it.each([
        ['2026-10-24', '2026-10-19', 'sabato prima del cambio dell’ora'],
        ['2026-10-27', '2026-10-26', 'martedì dopo il cambio dell’ora'],
        ['2026-11-01', '2026-10-26', 'domenica a cavallo del mese'],
        ['2026-03-29', '2026-03-23', 'domenica del cambio dell’ora di primavera'],
        ['2026-03-30', '2026-03-30', 'lunedì dopo il cambio di primavera'],
        ['2026-01-01', '2025-12-29', 'a cavallo dell’anno'],
        ['2024-02-29', '2024-02-26', 'giorno bisestile'],
    ])('%s → %s (%s)', (ymd, atteso) => {
        expect(lunediDi(ymd)).toBe(atteso)
    })

    it('non dipende dal fuso del processo (su Vercel è UTC, sul Mac è Roma)', () => {
        const prima = process.env.TZ
        try {
            for (const tz of ['UTC', 'Europe/Rome', 'America/Los_Angeles', 'Pacific/Auckland', 'Pacific/Kiritimati']) {
                process.env.TZ = tz
                expect(lunediDi('2026-10-25'), tz).toBe('2026-10-19')
                expect(lunediDi('2026-03-29'), tz).toBe('2026-03-23')
                expect(lunediDi('2026-10-26'), tz).toBe('2026-10-26')
            }
        } finally {
            if (prima === undefined) delete process.env.TZ
            else process.env.TZ = prima
        }
    })

    it('una data senza forma o inesistente torna com’è: la valida chi chiama', () => {
        expect(lunediDi('ieri')).toBe('ieri')
        expect(lunediDi('2026-02-30')).toBe('2026-02-30')
        expect(lunediDi('')).toBe('')
    })
})

describe('settimanaModificabile', () => {
    it('la settimana in corso e le future sì, le passate no', () => {
        expect(settimanaModificabile('2026-10-26', '2026-10-31')).toBe(true)
        expect(settimanaModificabile('2026-10-19', '2026-10-31')).toBe(false)
        expect(settimanaModificabile('2026-11-02', '2026-10-31')).toBe(true)
    })

    it('il lunedì della settimana in corso è ancora modificabile, in qualunque giorno di quella settimana sia oggi', () => {
        expect(settimanaModificabile('2026-10-26', '2026-10-26')).toBe(true)
        expect(settimanaModificabile('2026-10-26', '2026-11-01')).toBe(true) // domenica
        expect(settimanaModificabile('2026-10-26', '2026-11-02')).toBe(false) // il lunedì dopo: è passata
    })

    it('la domenica del cambio dell’ora la settimana in corso è ancora quella del 19', () => {
        expect(settimanaModificabile('2026-10-19', '2026-10-25')).toBe(true)
        expect(settimanaModificabile('2026-10-12', '2026-10-25')).toBe(false)
    })
})

describe('settimaneDelPeriodo', () => {
    it('i lunedì delle settimane che toccano dal…al, estremi compresi', () => {
        expect(settimaneDelPeriodo('2026-10-21', '2026-10-27')).toEqual(['2026-10-19', '2026-10-26'])
        expect(settimaneDelPeriodo('2026-10-26', '2026-11-01')).toEqual(['2026-10-26'])
        expect(settimaneDelPeriodo('2026-10-25', '2026-10-26')).toEqual(['2026-10-19', '2026-10-26'])
    })

    it('un intervallo al contrario o una data senza forma → nessuna settimana', () => {
        expect(settimaneDelPeriodo('2026-10-27', '2026-10-21')).toEqual([])
        expect(settimaneDelPeriodo('2026-10-27', 'boh')).toEqual([])
    })
})

describe('settimanaDiRiferimento', () => {
    it('la più recente non successiva, di quel proprietario', () => {
        expect(settimanaDiRiferimento(SETTIMANE_P, P, '2026-10-12')?.id).toBe('s-1')
        expect(settimanaDiRiferimento(SETTIMANE_P, P, '2026-10-19')?.id).toBe('s-2')
        expect(settimanaDiRiferimento(SETTIMANE_P, P, '2026-12-28')?.id).toBe('s-2')
    })

    it('l’ordine dell’elenco non conta', () => {
        expect(settimanaDiRiferimento([...SETTIMANE_P].reverse(), P, '2026-10-26')?.id).toBe('s-2')
    })

    it('prima della prima registrata non c’è niente', () => {
        expect(settimanaDiRiferimento(SETTIMANE_P, P, '2026-09-28')).toBeNull()
        expect(settimanaDiRiferimento([], P, '2026-10-12')).toBeNull()
    })

    it('un altro proprietario non conta; la sede è il proprietario nullo', () => {
        const conSede = [...SETTIMANE_P, testata({ id: 's-sede', utente_id: null, settimana: '2026-10-12' })]
        expect(settimanaDiRiferimento(conSede, Q, '2026-10-26')).toBeNull()
        expect(settimanaDiRiferimento(conSede, null, '2026-10-26')?.id).toBe('s-sede')
        expect(settimanaDiRiferimento(conSede, null, '2026-10-05')).toBeNull()
        expect(settimanaDiRiferimento(conSede, P, '2026-10-12')?.id).toBe('s-1')
    })
})

describe('fasceDellaSettimana', () => {
    const per = (settimana: string, utenteId: string | null = P) =>
        fasceDellaSettimana(SETTIMANE_P, FASCE_P, settimana).find((x) => x.utenteId === utenteId)

    it('una settimana mai toccata è uguale alla precedente registrata', () => {
        expect(per('2026-10-12')).toEqual({
            utenteId: P,
            origine: 'ereditata',
            daSettimana: '2026-10-05',
            fasce: [effettiva(P, '2026-10-12', 1, '09:00', '12:00')],
        })
    })

    it('una settimana registrata porta le proprie fasce e dice di essere sua', () => {
        expect(per('2026-10-19')).toEqual({
            utenteId: P,
            origine: 'registrata',
            daSettimana: '2026-10-19',
            fasce: [effettiva(P, '2026-10-19', 3, '14:00', '17:00')],
        })
    })

    it('la modifica di W si vede da W+1 e non da W−1', () => {
        expect(per('2026-10-26')?.fasce.map((f) => f.giornoSettimana)).toEqual([3]) // dopo: mercoledì
        expect(per('2026-10-12')?.fasce.map((f) => f.giornoSettimana)).toEqual([1]) // prima: lunedì
        // …e la fascia ereditata porta la settimana in cui VALE, non quella da cui eredita.
        expect(per('2026-10-26')?.fasce[0].settimana).toBe('2026-10-26')
        expect(per('2026-10-26')?.daSettimana).toBe('2026-10-19')
    })

    it('un giorno qualunque della settimana vale come il suo lunedì', () => {
        expect(per('2026-10-25')).toEqual(per('2026-10-19')) // domenica del cambio dell’ora
        expect(per('2026-10-18')).toEqual(per('2026-10-12'))
    })

    it('una testata senza fasce è una settimana volutamente vuota, e vuote restano le successive', () => {
        const settimane = [...SETTIMANE_P, testata({ id: 's-3', settimana: '2026-11-02' })]
        const perV = (w: string) => fasceDellaSettimana(settimane, FASCE_P, w).find((x) => x.utenteId === P)
        expect(perV('2026-11-02')).toEqual({ utenteId: P, origine: 'registrata', daSettimana: '2026-11-02', fasce: [] })
        expect(perV('2026-11-16')).toEqual({ utenteId: P, origine: 'ereditata', daSettimana: '2026-11-02', fasce: [] })
        // La settimana prima di quella vuota non è toccata.
        expect(perV('2026-10-26')?.fasce).toHaveLength(1)
    })

    it('prima della prima settimana registrata: origine nessuna', () => {
        expect(per('2026-09-28')).toEqual({ utenteId: P, origine: 'nessuna', daSettimana: null, fasce: [] })
    })

    it('sede e persona sono proprietari separati', () => {
        const settimane = [...SETTIMANE_P, testata({ id: 's-sede', utente_id: null, settimana: '2026-10-12' })]
        const fasce = [...FASCE_P, fascia({ id: 'f-sede', settimana_id: 's-sede', giorno_settimana: 2, ora_inizio: '10:00:00', ora_fine: '11:00:00' })]
        const r = fasceDellaSettimana(settimane, fasce, '2026-10-26')

        expect(r.map((x) => x.utenteId)).toEqual([null, P]) // la sede per prima
        expect(r.find((x) => x.utenteId === null)).toEqual({
            utenteId: null,
            origine: 'ereditata',
            daSettimana: '2026-10-12',
            fasce: [effettiva(null, '2026-10-26', 2, '10:00', '11:00')],
        })
        // La persona non prende le fasce della sede, né viceversa.
        expect(r.find((x) => x.utenteId === P)?.fasce.map((f) => f.giornoSettimana)).toEqual([3])
        // E la sede, prima della sua prima settimana, non ha niente, mentre la persona sì.
        const prima = fasceDellaSettimana(settimane, fasce, '2026-10-05')
        expect(prima.find((x) => x.utenteId === null)?.origine).toBe('nessuna')
        expect(prima.find((x) => x.utenteId === P)?.origine).toBe('registrata')
    })

    it('se si dicono i proprietari, escono tutti e solo quelli, anche vuoti e nell’ordine detto', () => {
        const r = fasceDellaSettimana(SETTIMANE_P, FASCE_P, '2026-10-26', [null, Q, P])
        expect(r.map((x) => [x.utenteId, x.origine])).toEqual([
            [null, 'nessuna'],
            [Q, 'nessuna'],
            [P, 'ereditata'],
        ])
        // Una persona che ha delle settimane ma non è nell'elenco (non è più della sede) non esce.
        expect(fasceDellaSettimana(SETTIMANE_P, FASCE_P, '2026-10-26', [null]).map((x) => x.utenteId)).toEqual([null])
    })

    it('le fasce escono per giorno e per ora, qualunque sia l’ordine in cui arrivano', () => {
        const fasce = [
            fascia({ id: 'a', settimana_id: 's-1', giorno_settimana: 3, ora_inizio: '15:00:00', ora_fine: '16:00:00' }),
            fascia({ id: 'b', settimana_id: 's-1', giorno_settimana: 1, ora_inizio: '14:00:00', ora_fine: '15:00:00' }),
            fascia({ id: 'c', settimana_id: 's-1', giorno_settimana: 1, ora_inizio: '09:00:00', ora_fine: '10:00:00' }),
        ]
        const r = fasceDellaSettimana([SETTIMANE_P[0]], fasce, '2026-10-05')[0]
        expect(r.fasce.map((f) => [f.giornoSettimana, f.oraInizio])).toEqual([
            [1, '09:00'],
            [1, '14:00'],
            [3, '15:00'],
        ])
    })

    it('le fasce di un’altra settimana non entrano', () => {
        // s-2 ha il mercoledì; chiedendo la settimana del 12 (che eredita da s-1) il mercoledì non c'è.
        expect(per('2026-10-12')?.fasce.some((f) => f.giornoSettimana === 3)).toBe(false)
    })
})

describe('caricaFasceEffettive', () => {
    const SEDE_ALTRA = { scuola_id: SEDE_B }
    function db(): DBFinto {
        // Le righe tipizzate (SettimanaRow/FasciaRow) non hanno la firma d'indice del finto: si adattano qui.
        const righe = {
            crm_settimane: [
                ...SETTIMANE_P,
                testata({ id: 's-sede', utente_id: null, settimana: '2026-10-12' }),
                // una settimana FUTURA rispetto al periodo chiesto: non deve entrare
                testata({ id: 's-futura', settimana: '2026-11-09' }),
                // un'altra sede, con le stesse date: non deve entrare
                testata({ id: 's-b', ...SEDE_ALTRA, settimana: '2026-10-19' }),
            ],
            crm_fasce: [
                ...FASCE_P,
                fascia({ id: 'f-sede', settimana_id: 's-sede', giorno_settimana: 2, ora_inizio: '10:00:00', ora_fine: '11:00:00' }),
                fascia({ id: 'f-futura', settimana_id: 's-futura', giorno_settimana: 5, ora_inizio: '08:00:00', ora_fine: '09:00:00' }),
                fascia({ id: 'f-b', settimana_id: 's-b', ...SEDE_ALTRA, giorno_settimana: 4, ora_inizio: '08:00:00', ora_fine: '09:00:00' }),
                // una riga INCOERENTE: punta a una testata di SEDE_A (s-2) ma dichiara SEDE_B. La ferma il filtro per
                // sede sulla lettura delle fasce (stessa query), non la sola lista delle testate.
                fascia({ id: 'f-incoerente', settimana_id: 's-2', ...SEDE_ALTRA, giorno_settimana: 6, ora_inizio: '08:00:00', ora_fine: '09:00:00' }),
            ],
        }
        return righe as unknown as DBFinto
    }

    it('le fasce di ogni settimana che tocca il periodo: registrate ed ereditate, ciascuna nella sua settimana', async () => {
        const supabase = creaFintoSupabase(db())
        const r = await caricaFasceEffettive(supabase, SEDE_A, '2026-10-21', '2026-10-27')
        const chiavi = r.map((f) => `${f.utenteId ?? 'sede'}|${f.settimana}|${f.giornoSettimana}`).sort()
        expect(chiavi).toEqual(
            [
                `${P}|2026-10-19|3`, // registrata
                `${P}|2026-10-26|3`, // ereditata dal 19
                'sede|2026-10-19|2', // ereditata dal 12
                'sede|2026-10-26|2', // ereditata dal 12
            ].sort(),
        )
    })

    it('legge in due colpi, entrambi di quella sede: prima le testate, poi le fasce', async () => {
        const lette: string[] = []
        await caricaFasceEffettive(creaFintoSupabase(db(), lette), SEDE_A, '2026-10-21', '2026-10-27')
        expect(lette).toEqual(['crm_settimane', 'crm_fasce'])
    })

    it('la sede dichiarata è l’unica che si legge: le testate e le fasce di un’altra non tornano', async () => {
        const r = await caricaFasceEffettive(creaFintoSupabase(db()), SEDE_B, '2026-10-19', '2026-10-25')
        expect(r).toEqual([effettiva(P, '2026-10-19', 4, '08:00', '09:00')])
    })

    it('una fascia che dichiara un’altra sede non entra, anche se punta a una testata di questa', async () => {
        const r = await caricaFasceEffettive(creaFintoSupabase(db()), SEDE_A, '2026-10-19', '2026-10-25')
        expect(r.some((f) => f.giornoSettimana === 6)).toBe(false)
    })

    it('una settimana registrata dopo il periodo non lo cambia', async () => {
        const r = await caricaFasceEffettive(creaFintoSupabase(db()), SEDE_A, '2026-10-26', '2026-11-01')
        expect(r.some((f) => f.giornoSettimana === 5)).toBe(false)
        expect(r.some((f) => f.settimana === '2026-11-09')).toBe(false)
    })

    it('nessuna testata → nessuna lettura delle fasce', async () => {
        const lette: string[] = []
        const r = await caricaFasceEffettive(creaFintoSupabase({ crm_settimane: [], crm_fasce: [] }, lette), SEDE_A, '2026-10-21', '2026-10-27')
        expect(r).toEqual([])
        expect(lette).toEqual(['crm_settimane'])
    })

    it('un periodo senza senso non legge niente', async () => {
        const lette: string[] = []
        expect(await caricaFasceEffettive(creaFintoSupabase(db(), lette), SEDE_A, '2026-10-27', '2026-10-21')).toEqual([])
        expect(lette).toEqual([])
    })

    it('l’errore del database LANCIA (il chiamante lo passa a rispostaErroreDb), non diventa «nessuna fascia»', async () => {
        const supabase = creaFintoSupabase(db(), [], { errori: { 'crm_settimane:select': { code: 'PGRST205' } } })
        await expect(caricaFasceEffettive(supabase, SEDE_A, '2026-10-21', '2026-10-27')).rejects.toMatchObject({ code: 'PGRST205' })

        const supabase2 = creaFintoSupabase(db(), [], { errori: { 'crm_fasce:select': { code: '08006' } } })
        await expect(caricaFasceEffettive(supabase2, SEDE_A, '2026-10-21', '2026-10-27')).rejects.toMatchObject({ code: '08006' })
    })
})
