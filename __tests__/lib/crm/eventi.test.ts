import { beforeEach, describe, expect, it, vi } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../../fixtures/finto-supabase'
import { SEDE_A } from '../../fixtures/sedi'

const h = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn() }))

vi.mock('@/lib/logging/logger', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/logging/logger')>()
    return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import { registraEvento } from '@/lib/crm/eventi'

/**
 * Lo storico di una scheda è anche l'unica prova che il CRM lavora: se non si può scrivere, lo si
 * dice (livello error); se si è scritto, lo si dice lo stesso (info, persistito). E nel log non
 * entra MAI il testo della nota né i dati dell'evento: sono parole di famiglie e di bambini.
 */

const SCHEDA = '10000000-0000-4000-8000-000000000001'
const AUTORE = '20000000-0000-4000-8000-00000000000a'

beforeEach(() => {
    h.logEvento.mockClear()
    h.logErrore.mockClear()
})

describe('registraEvento', () => {
    it('insert riuscito → true e un logEvento crm info senza testo né dati personali', async () => {
        const db: DBFinto = { crm_eventi: [] }
        const scritture: Scrittura[] = []
        const supabase = creaFintoSupabase(db, [], { scritture })

        const ok = await registraEvento(supabase, {
            schedaId: SCHEDA,
            scuolaId: SEDE_A,
            tipo: 'nota',
            autore: AUTORE,
            autoreVia: 'segreteria',
            dati: { telefonata_con: 'Famiglia Prova', durata_min: 5 },
            testo: 'La famiglia Prova preferisce essere richiamata dopo le 17.',
        })

        expect(ok).toBe(true)
        expect(db.crm_eventi).toHaveLength(1)
        expect(db.crm_eventi[0]).toMatchObject({
            scheda_id: SCHEDA,
            scuola_id: SEDE_A,
            tipo: 'nota',
            autore: AUTORE,
            autore_via: 'segreteria',
            dati: { telefonata_con: 'Famiglia Prova', durata_min: 5 },
            testo: 'La famiglia Prova preferisce essere richiamata dopo le 17.',
        })

        // il battito di successo: una sola riga, crm/info, con i soli campi tecnici
        const info = h.logEvento.mock.calls.filter((c) => c[0] === 'crm' && c[1] === 'info')
        expect(info).toHaveLength(1)
        expect(info[0][2]).toEqual({
            esito: 'evento-registrato',
            tipo: 'nota',
            scuola_id: SEDE_A,
            entita_id: SCHEDA,
        })
        // nessun dato personale in nessuna riga di log
        const tutto = JSON.stringify([...h.logEvento.mock.calls, ...h.logErrore.mock.calls])
        expect(tutto).not.toContain('Famiglia Prova')
        expect(tutto).not.toContain('richiamata')
    })

    it('senza autore (il sistema) e senza dati né testo: dati vuoti, testo nullo', async () => {
        const db: DBFinto = { crm_eventi: [] }
        const ok = await registraEvento(creaFintoSupabase(db), {
            schedaId: SCHEDA,
            scuolaId: SEDE_A,
            tipo: 'azione_pianificata',
            autore: null,
            autoreVia: 'sistema',
        })
        expect(ok).toBe(true)
        expect(db.crm_eventi[0]).toMatchObject({ autore: null, autore_via: 'sistema', dati: {}, testo: null })
    })

    it('insert fallito → false, nessuna eccezione, logEvento crm error', async () => {
        const db: DBFinto = { crm_eventi: [] }
        const supabase = creaFintoSupabase(db, [], { errori: { 'crm_eventi:insert': { code: '23503', message: 'chiave non trovata' } } })

        await expect(
            registraEvento(supabase, { schedaId: SCHEDA, scuolaId: SEDE_A, tipo: 'creata', autore: AUTORE, autoreVia: 'segreteria' }),
        ).resolves.toBe(false)

        expect(db.crm_eventi).toHaveLength(0)
        const errori = h.logEvento.mock.calls.filter((c) => c[0] === 'crm' && c[1] === 'error')
        expect(errori).toHaveLength(1)
        expect(errori[0][2]).toMatchObject({ esito: 'evento-non-registrato', tipo: 'creata', scuola_id: SEDE_A, entita_id: SCHEDA })
        // e nessun «evento-registrato»: un fallimento non deve contare come battito
        expect(h.logEvento.mock.calls.some((c) => c[1] === 'info')).toBe(false)
    })

    it('un’eccezione dal client (rete) → false, nessuna eccezione, logEvento crm error', async () => {
        const supabase = {
            from: () => {
                throw new Error('rete assente')
            },
        } as never
        await expect(
            registraEvento(supabase, { schedaId: SCHEDA, scuolaId: SEDE_A, tipo: 'creata', autore: null, autoreVia: 'sistema' }),
        ).resolves.toBe(false)
        expect(h.logEvento.mock.calls.some((c) => c[0] === 'crm' && c[1] === 'error')).toBe(true)
    })
})
