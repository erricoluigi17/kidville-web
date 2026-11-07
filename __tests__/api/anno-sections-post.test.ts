import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * Compito 3.5-1 · `POST /api/admin/sections` dichiara l'anno della sezione.
 *
 * Il database è il finto che applica i filtri ed esegue le scritture. Sono finti soltanto il gate di ruolo e
 * il client admin. `resolveAnnoScrittura` è quello VERO. L'orologio non si congela: gli stati sono scritti
 * nelle righe di `anni_sede`. `anno_id` è `anni_scolastici.id` (`a2…` = il `corrente`), non `anni_sede.id`.
 * La rete di `withRoute` (3.4) qui non scatta: il finto non passa dal fetch strumentato, quindi la
 * traduzione di `ANNO_CHIUSO` in 409 è quella ESPLICITA della route.
 */

const h = vi.hoisted(() => ({
    ruolo: 'segreteria' as string,
    utente: '' as string,
    attive: [] as string[],
    db: {} as Record<string, Record<string, unknown>[]>,
    errori: {} as Record<string, { code: string; message?: string }>,
    scritture: [] as unknown[],
    conHeader: [] as Array<Record<string, string>>,
    logEvento: vi.fn(),
    logErrore: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: (_req: unknown, ammessi: string[] = ['admin', 'coordinator', 'segreteria']) => {
        if (!ammessi.includes(h.ruolo)) return Promise.resolve({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
        return Promise.resolve({ user: { id: h.utente, role: h.ruolo, scuola_id: h.attive[0] ?? null } })
    },
}))
vi.mock('@/lib/auth/scope', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/auth/scope')>()
    return { ...vero, resolveScuoleAttive: async () => [...h.attive] }
})
vi.mock('@/lib/supabase/server-client', () => {
    const nuovo = () => creaFintoSupabase(h.db as DBFinto, [], { errori: h.errori, scritture: h.scritture as Scrittura[] })
    return {
        createAdminClient: async () => nuovo(),
        createAdminClientConHeader: async (header: Record<string, string>) => {
            h.conHeader.push(header)
            return nuovo()
        },
    }
})
// Il finto genera id che non sono uuid: i gettoni (veri: `conGettone` li valida) si creano qui.
const GETTONE = 'f1111111-1111-4111-8111-111111111111'
vi.mock('@/lib/anno/gettone', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/anno/gettone')>()
    return { ...vero, creaGettoni: async () => [GETTONE] }
})
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => undefined) }))
vi.mock('@/lib/logging/logger', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/logging/logger')>()
    return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import { POST, PATCH } from '@/app/api/admin/sections/route'

const SEG = '20000000-0000-4000-8000-000000000001'
// `anni_scolastici.id`
const A1 = 'a1111111-1111-4111-8111-111111111111' // chiuso
const A2 = 'a2222222-2222-4222-8222-222222222222' // corrente
const A3 = 'a3333333-3333-4333-8333-333333333333' // in_preparazione
const A9 = 'a9999999-9999-4999-8999-999999999999' // di un'altra sede
// `anni_sede.id`
const S1 = 'b1111111-1111-4111-8111-111111111111'
const S2 = 'b2222222-2222-4222-8222-222222222222'
const S3 = 'b3333333-3333-4333-8333-333333333333'
const SB = 'b9999999-9999-4999-8999-999999999999'

const anniSede = (): Riga[] => [
    { id: S1, scuola_id: SEDE_A, anno_id: A1, stato: 'chiuso', domande_aperte: false },
    { id: S2, scuola_id: SEDE_A, anno_id: A2, stato: 'corrente', domande_aperte: false },
    { id: S3, scuola_id: SEDE_A, anno_id: A3, stato: 'in_preparazione', domande_aperte: false },
    { id: SB, scuola_id: SEDE_B, anno_id: A9, stato: 'corrente', domande_aperte: false },
]

const post = (b: unknown) =>
    POST(
        new NextRequest('http://localhost/api/admin/sections', {
            method: 'POST',
            body: JSON.stringify(b),
            headers: { 'content-type': 'application/json' },
        }),
    )

const insertSezioni = () =>
    (h.scritture as Scrittura[]).filter((s) => s.tabella === 'sections' && s.operazione === 'insert')

beforeEach(() => {
    h.ruolo = 'segreteria'
    h.utente = SEG
    h.attive = [SEDE_A]
    h.errori = {}
    h.scritture = []
    h.conHeader = []
    h.logEvento.mockClear()
    h.logErrore.mockClear()
    h.db = {
        sections: [],
        anni_sede: anniSede(),
        utenti_scuole: [],
        correzioni_anno_chiuso: [],
    }
})

describe('POST /api/admin/sections · l\'anno', () => {
    it('una sezione nasce con l\'anno del `corrente` (a)', async () => {
        const res = await post({ name: 'Sezione A' })
        expect(res.status).toBe(201)
        expect(insertSezioni()).toHaveLength(1)
        expect(insertSezioni()[0].valori[0]).toMatchObject({ name: 'Sezione A', scuola_id: SEDE_A, anno_id: A2 })
    })

    it('con `anni_sede` che risponde PGRST205 la riga NON ha anno_id e la risposta è 2xx (b)', async () => {
        h.errori = { anni_sede: { code: 'PGRST205', message: 'Could not find the table' } }
        const res = await post({ name: 'Sezione A' })
        expect(res.status).toBe(201)
        expect(insertSezioni()).toHaveLength(1)
        expect(insertSezioni()[0].valori[0]).not.toHaveProperty('anno_id')
    })

    it('se l\'insert risponde ANNO_CHIUSO la risposta è 409 ANNO_CHIUSO, senza la rete di withRoute (c)', async () => {
        h.errori = { 'sections:insert': { code: 'P0001', message: 'ANNO_CHIUSO' } }
        const res = await post({ name: 'Sezione A' })
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('ANNO_CHIUSO')
    })

    it('due sedi nel cookie e nessuna indicata → 400 e 0 scritture (d)', async () => {
        h.ruolo = 'admin'
        h.attive = [SEDE_A, SEDE_B]
        h.db.utenti_scuole = [
            { utente_id: SEG, scuola_id: SEDE_A },
            { utente_id: SEG, scuola_id: SEDE_B },
        ]
        const res = await post({ name: 'Sezione A' })
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('SEDE_DA_SPECIFICARE')
        expect(h.scritture).toEqual([])
    })

    it('un `anno_id` dichiarato dell\'anno in preparazione viene scritto così com\'è', async () => {
        const res = await post({ name: 'Sezione A', anno_id: A3 })
        expect(res.status).toBe(201)
        expect(insertSezioni()[0].valori[0]).toMatchObject({ anno_id: A3 })
    })

    it('un `anno_id` dichiarato di un\'altra sede → 400 ANNO_NON_DELLA_SEDE e 0 scritture', async () => {
        const res = await post({ name: 'Sezione A', anno_id: A9 })
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('ANNO_NON_DELLA_SEDE')
        expect(h.scritture).toEqual([])
    })

    it('un `anno_id` che non è un uuid → 400 dallo schema', async () => {
        const res = await post({ name: 'Sezione A', anno_id: 'non-un-uuid' })
        expect(res.status).toBe(400)
        expect(h.scritture).toEqual([])
    })

    it('il 23505 sul nome resta 409 NOME_DUPLICATO (regressione)', async () => {
        h.errori = { 'sections:insert': { code: '23505', message: 'duplicate key' } }
        const res = await post({ name: 'Sezione A' })
        expect(res.status).toBe(409)
        expect((await res.json()).error).toMatch(/Esiste già una classe/)
    })

    it('stesso nome in un altro anno → 201: «Sezione A» può stare nel 2026/27 e nel 2027/28', async () => {
        h.db.sections = [{ id: 'c1000000-0000-4000-8000-000000000001', name: 'Sezione A', scuola_id: SEDE_A, anno_id: A3 }]
        const res = await post({ name: 'Sezione A' }) // il corrente, A2
        expect(res.status).toBe(201)
        expect(insertSezioni()[0].valori[0]).toMatchObject({ anno_id: A2 })
    })

    it('stesso nome nello stesso anno → 409 NOME_DUPLICATO e 0 scritture', async () => {
        h.db.sections = [{ id: 'c1000000-0000-4000-8000-000000000001', name: 'Sezione A', scuola_id: SEDE_A, anno_id: A2 }]
        const res = await post({ name: 'Sezione A' })
        expect(res.status).toBe(409)
        expect((await res.json()).error).toMatch(/Esiste già una classe/)
        expect(h.scritture).toEqual([])
    })

    it('sul database senza lo schema dell\'anno il controllo dei nomi resta quello di oggi (per sede)', async () => {
        h.errori = { anni_sede: { code: 'PGRST205', message: 'Could not find the table' } }
        h.db.sections = [{ id: 'c1000000-0000-4000-8000-000000000001', name: 'Sezione A', scuola_id: SEDE_A }]
        const res = await post({ name: 'Sezione A' })
        expect(res.status).toBe(409)
        expect(h.scritture).toEqual([])
    })

    it('un anno `in_chiusura` (agosto): la scrittura passa dal client con il gettone nell\'header', async () => {
        h.db.anni_sede = anniSede().map((r) => (r.id === S2 ? { ...r, stato: 'in_chiusura' } : r))
        const res = await post({ name: 'Sezione A', anno_id: A2 })
        expect(res.status).toBe(201)
        expect(h.conHeader).toHaveLength(1)
        expect(h.conHeader[0]['x-kidville-correzione']).toBe(GETTONE)
    })
})

describe('PATCH /api/admin/sections · la rinomina guarda lo stesso anno', () => {
    const ID = 'c1000000-0000-4000-8000-0000000000aa'
    const patch = (b: unknown) =>
        PATCH(
            new NextRequest('http://localhost/api/admin/sections', {
                method: 'PATCH',
                body: JSON.stringify(b),
                headers: { 'content-type': 'application/json' },
            }),
        )

    it('rinomina con un nome usato in un altro anno → 200', async () => {
        h.db.sections = [
            { id: ID, name: 'Sezione B', scuola_id: SEDE_A, anno_id: A3 },
            { id: 'c1000000-0000-4000-8000-0000000000bb', name: 'Sezione A', scuola_id: SEDE_A, anno_id: A2 },
        ]
        const res = await patch({ id: ID, name: 'Sezione A' })
        expect(res.status).toBe(200)
    })

    it('rinomina con un nome usato nello stesso anno → 409 NOME_DUPLICATO', async () => {
        h.db.sections = [
            { id: ID, name: 'Sezione B', scuola_id: SEDE_A, anno_id: A2 },
            { id: 'c1000000-0000-4000-8000-0000000000bb', name: 'Sezione A', scuola_id: SEDE_A, anno_id: A2 },
        ]
        const res = await patch({ id: ID, name: 'Sezione A' })
        expect(res.status).toBe(409)
        expect((await res.json()).error).toMatch(/Esiste già una classe/)
    })

    it('con lo schema indietro (la sezione non ha anno_id) il controllo resta per sede', async () => {
        h.db.sections = [
            { id: ID, name: 'Sezione B', scuola_id: SEDE_A },
            { id: 'c1000000-0000-4000-8000-0000000000bb', name: 'Sezione A', scuola_id: SEDE_A },
        ]
        const res = await patch({ id: ID, name: 'Sezione A' })
        expect(res.status).toBe(409)
    })
})
