import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EsitoAzione } from '@/lib/crm/tipi'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../../fixtures/finto-supabase'
import { SEDE_A } from '../../fixtures/sedi'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))

vi.mock('@/lib/logging/logger', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/logging/logger')>()
    return { ...vero, logEvento: h.logEvento }
})

import { pianificaAzione, prossimaAzione, scadenzaRoma, type PassoCatena } from '@/lib/crm/follow-up'

/**
 * LA CATENA DEI FOLLOW-UP · dopo una visita (o un'assenza) il CRM propone UN richiamo, e dopo ogni
 * richiamo il successivo. Ogni passo si riprova una volta sola e poi la catena va avanti: con un rinvio
 * infinito al giorno dopo, la lista «da richiamare» non si svuoterebbe mai.
 *
 * `oggi` è sempre un giorno CIVILE di Roma (`YYYY-MM-DD`): le funzioni qui sono pure e non guardano
 * l'orologio, quindi nessun test dipende dalla data in cui gira.
 */

const OGGI = '2026-10-20'

describe('prossimaAzione · una riga della tabella per test', () => {
    it('visita_svolta → follow_up_1 a giornoVisita + 2', () => {
        expect(prossimaAzione({ da: 'visita_svolta', oggi: OGGI, giornoVisita: '2026-10-20' })).toEqual({
            tipo: 'follow_up_1',
            giorno: '2026-10-22',
        })
    })

    it('non_presentato → recupero domani', () => {
        expect(prossimaAzione({ da: 'non_presentato', oggi: OGGI })).toEqual({ tipo: 'recupero', giorno: '2026-10-21' })
    })

    it.each<[PassoCatena, EsitoAzione, string | null, string | null]>([
        // da, esito, tipo atteso, giorno atteso (con OGGI = 2026-10-20)
        ['follow_up_1', 'ci_pensa', 'follow_up_2', '2026-10-23'],
        ['follow_up_1', 'non_risponde', 'riprova_1', '2026-10-21'],
        ['riprova_1', 'ci_pensa', 'follow_up_2', '2026-10-23'],
        ['riprova_1', 'non_risponde', 'follow_up_2', '2026-10-23'],
        ['follow_up_2', 'ci_pensa', 'ultimatum', '2026-10-23'],
        ['follow_up_2', 'non_risponde', 'riprova_2', '2026-10-21'],
        ['riprova_2', 'ci_pensa', 'ultimatum', '2026-10-23'],
        ['riprova_2', 'non_risponde', 'ultimatum', '2026-10-23'],
        ['recupero', 'ci_pensa', 'richiamare', '2026-10-23'],
        ['recupero', 'non_risponde', 'richiamare', '2026-10-21'],
    ])('%s con esito %s → %s il %s', (da, esito, tipo, giorno) => {
        expect(prossimaAzione({ da, esito, oggi: OGGI })).toEqual({ tipo, giorno })
    })

    it('ultimatum e richiamare chiudono la catena, qualunque sia l’esito', () => {
        for (const da of ['ultimatum', 'richiamare'] as const) {
            for (const esito of ['ci_pensa', 'non_risponde', 'vuole_iscriversi', 'non_interessato'] as const) {
                expect(prossimaAzione({ da, esito, oggi: OGGI }), `${da}/${esito}`).toBeNull()
            }
        }
    })

    it('vuole_iscriversi e non_interessato chiudono la catena da qualunque passo', () => {
        for (const da of ['follow_up_1', 'riprova_1', 'follow_up_2', 'riprova_2', 'recupero'] as const) {
            expect(prossimaAzione({ da, esito: 'vuole_iscriversi', oggi: OGGI }), `${da}/vuole_iscriversi`).toBeNull()
            expect(prossimaAzione({ da, esito: 'non_interessato', oggi: OGGI }), `${da}/non_interessato`).toBeNull()
        }
    })

    it('un richiamo senza esito non inventa il passo dopo', () => {
        expect(prossimaAzione({ da: 'follow_up_1', oggi: OGGI })).toBeNull()
    })

    it('ogni passo si riprova UNA volta sola: dalla riprova non si torna a riprovare', () => {
        // la catena da follow_up_1 con «non risponde» sempre: riprova_1 → follow_up_2 → riprova_2 → ultimatum → fine
        const passi: string[] = []
        let da: PassoCatena = 'follow_up_1'
        for (let i = 0; i < 10; i++) {
            const p = prossimaAzione({ da, esito: 'non_risponde', oggi: OGGI })
            if (!p) break
            passi.push(p.tipo)
            da = p.tipo
        }
        expect(passi).toEqual(['riprova_1', 'follow_up_2', 'riprova_2', 'ultimatum'])
    })

    it('visita del 2026-10-23 → follow_up_1 il 2026-10-25', () => {
        expect(prossimaAzione({ da: 'visita_svolta', oggi: '2026-10-23', giornoVisita: '2026-10-23' })).toEqual({
            tipo: 'follow_up_1',
            giorno: '2026-10-25',
        })
    })

    it('visita di dieci giorni fa → follow_up_1 domani, non nel passato', () => {
        expect(prossimaAzione({ da: 'visita_svolta', oggi: '2026-10-23', giornoVisita: '2026-10-13' })).toEqual({
            tipo: 'follow_up_1',
            giorno: '2026-10-24',
        })
    })

    it('visita svolta ieri → il giorno di domani, non quello di dopodomani', () => {
        // ieri + 2 = domani: coincide con oggi + 1, il tetto minimo
        expect(prossimaAzione({ da: 'visita_svolta', oggi: '2026-10-23', giornoVisita: '2026-10-22' })).toEqual({
            tipo: 'follow_up_1',
            giorno: '2026-10-24',
        })
    })

    it('visita senza giorno indicato: si conta da oggi', () => {
        expect(prossimaAzione({ da: 'visita_svolta', oggi: '2026-10-23' })).toEqual({ tipo: 'follow_up_1', giorno: '2026-10-25' })
    })

    it('i giorni passano il confine di mese e di anno', () => {
        expect(prossimaAzione({ da: 'follow_up_1', esito: 'ci_pensa', oggi: '2026-10-30' })?.giorno).toBe('2026-11-02')
        expect(prossimaAzione({ da: 'non_presentato', oggi: '2026-12-31' })?.giorno).toBe('2027-01-01')
        expect(prossimaAzione({ da: 'follow_up_2', esito: 'ci_pensa', oggi: '2028-02-27' })?.giorno).toBe('2028-03-01')
    })
})

describe('scadenzaRoma · le 10:30 di Roma, come istante UTC', () => {
    it('scadenzaRoma("2026-10-25") === "2026-10-25T09:30:00.000Z"', () => {
        // il 25 ottobre 2026 è l'ultima domenica del mese: alle 03:00 l'ora legale finisce (UTC+1)
        expect(scadenzaRoma('2026-10-25')).toBe('2026-10-25T09:30:00.000Z')
    })

    it('scadenzaRoma("2026-10-24") === "2026-10-24T08:30:00.000Z"', () => {
        // il giorno prima c'è ancora l'ora legale (UTC+2)
        expect(scadenzaRoma('2026-10-24')).toBe('2026-10-24T08:30:00.000Z')
    })

    it('anche nel cambio di primavera: 28 marzo 2026 (UTC+1) e 29 marzo (UTC+2)', () => {
        expect(scadenzaRoma('2026-03-28')).toBe('2026-03-28T09:30:00.000Z')
        expect(scadenzaRoma('2026-03-29')).toBe('2026-03-29T08:30:00.000Z')
    })

    it('un’altra ora si passa come secondo argomento', () => {
        expect(scadenzaRoma('2026-10-24', '09:00')).toBe('2026-10-24T07:00:00.000Z')
    })

    it('un giorno che non esiste è un errore di chi chiama, non una data inventata', () => {
        expect(() => scadenzaRoma('2026-02-30')).toThrow(RangeError)
        expect(() => scadenzaRoma('domani')).toThrow(RangeError)
    })
})

describe('pianificaAzione', () => {
    const SCHEDA = '10000000-0000-4000-8000-000000000001'
    const RESP = '20000000-0000-4000-8000-00000000000a'
    const APP = '30000000-0000-4000-8000-000000000001'
    const dati = {
        schedaId: SCHEDA,
        scuolaId: SEDE_A,
        tipo: 'follow_up_1' as const,
        giorno: '2026-10-25',
        responsabile: RESP,
        appuntamentoId: APP,
        autore: RESP,
    }

    beforeEach(() => h.logEvento.mockClear())

    it('inserisce l’azione alle 10:30 di Roma e scrive l’evento azione_pianificata', async () => {
        const db: DBFinto = { crm_azioni: [], crm_eventi: [] }
        const scritture: Scrittura[] = []
        const r = await pianificaAzione(creaFintoSupabase(db, [], { scritture }), dati)

        expect(r).toEqual({ id: expect.any(String) })
        expect(db.crm_azioni).toHaveLength(1)
        expect(db.crm_azioni[0]).toMatchObject({
            id: r?.id,
            scuola_id: SEDE_A,
            scheda_id: SCHEDA,
            tipo: 'follow_up_1',
            scadenza: '2026-10-25T09:30:00.000Z',
            responsabile: RESP,
            appuntamento_id: APP,
        })
        expect(db.crm_eventi).toHaveLength(1)
        expect(db.crm_eventi[0]).toMatchObject({
            scheda_id: SCHEDA,
            scuola_id: SEDE_A,
            tipo: 'azione_pianificata',
            autore: RESP,
            autore_via: 'segreteria',
        })
    })

    it('senza autore (la catena automatica) l’evento è del sistema; appuntamentoId è facoltativo', async () => {
        const db: DBFinto = { crm_azioni: [], crm_eventi: [] }
        const { appuntamentoId: _scartato, ...senzaApp } = dati
        void _scartato
        const r = await pianificaAzione(creaFintoSupabase(db), { ...senzaApp, autore: null })
        expect(r).not.toBeNull()
        expect(db.crm_azioni[0]).toMatchObject({ appuntamento_id: null })
        expect(db.crm_eventi[0]).toMatchObject({ autore: null, autore_via: 'sistema' })
    })

    it('pianificaAzione: insert fallito → null, nessuna eccezione, nessun evento', async () => {
        const db: DBFinto = { crm_azioni: [], crm_eventi: [] }
        const supabase = creaFintoSupabase(db, [], { errori: { 'crm_azioni:insert': { code: '23503', message: 'chiave non trovata' } } })

        await expect(pianificaAzione(supabase, dati)).resolves.toBeNull()

        expect(db.crm_azioni).toHaveLength(0)
        expect(db.crm_eventi).toHaveLength(0)
        expect(h.logEvento).toHaveBeenCalledWith('crm', 'error', expect.objectContaining({ esito: 'azione-non-pianificata' }), expect.anything())
    })

    it('un giorno impossibile → null e nessuna scrittura (la scadenza non si inventa)', async () => {
        const db: DBFinto = { crm_azioni: [], crm_eventi: [] }
        await expect(pianificaAzione(creaFintoSupabase(db), { ...dati, giorno: '2026-02-30' })).resolves.toBeNull()
        expect(db.crm_azioni).toHaveLength(0)
        expect(h.logEvento).toHaveBeenCalledWith('crm', 'error', expect.objectContaining({ esito: 'azione-non-pianificata' }), expect.anything())
    })

    it('se solo lo storico fallisce l’azione resta pianificata', async () => {
        const db: DBFinto = { crm_azioni: [], crm_eventi: [] }
        const supabase = creaFintoSupabase(db, [], { errori: { 'crm_eventi:insert': { code: '23503', message: 'x' } } })
        const r = await pianificaAzione(supabase, dati)
        expect(r).not.toBeNull()
        expect(db.crm_azioni).toHaveLength(1)
    })
})
