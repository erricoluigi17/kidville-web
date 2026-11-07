import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * Compito 3.5-1 · `POST /api/admin/primaria/scrutinio-periodi` dichiara l'anno del periodo.
 *
 * L'anno si ricava DALL'ETICHETTA che la pagina manda (`annoScolastico`): «2026/27» (`etichetta_breve`) o
 * «2026/2027» (`etichetta`), due forme dello stesso anno. Database finto che applica i filtri; sono finti solo
 * il gate di ruolo e il client admin. `resolveAnnoScrittura` è quello vero. `anno_id` è `anni_scolastici.id`.
 */

const h = vi.hoisted(() => ({
    ruolo: 'segreteria' as string,
    utente: '' as string,
    attive: [] as string[],
    db: {} as Record<string, Record<string, unknown>[]>,
    errori: {} as Record<string, { code: string; message?: string }>,
    scritture: [] as unknown[],
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
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () =>
        creaFintoSupabase(h.db as DBFinto, [], { errori: h.errori, scritture: h.scritture as Scrittura[] }),
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/logging/logger')>()
    return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import { POST } from '@/app/api/admin/primaria/scrutinio-periodi/route'

const SEG = '20000000-0000-4000-8000-000000000001'
// `anni_scolastici.id`
const A2 = 'a2222222-2222-4222-8222-222222222222' // 2026/27, corrente
const A3 = 'a3333333-3333-4333-8333-333333333333' // 2027/28, in_preparazione
const A9 = 'a9999999-9999-4999-8999-999999999999' // 2030/31, di un'altra sede
// `anni_sede.id`
const S2 = 'b2222222-2222-4222-8222-222222222222'
const S3 = 'b3333333-3333-4333-8333-333333333333'
const SB = 'b9999999-9999-4999-8999-999999999999'

const post = (b: unknown) =>
    POST(
        new NextRequest('http://localhost/api/admin/primaria/scrutinio-periodi', {
            method: 'POST',
            body: JSON.stringify(b),
            headers: { 'content-type': 'application/json' },
        }),
    )
const corpo = (over: Riga = {}): Riga => ({ annoScolastico: '2026/27', nome: 'Primo quadrimestre', ...over })

const inserimenti = () =>
    (h.scritture as Scrittura[]).filter((s) => s.tabella === 'scrutinio_periodi' && s.operazione === 'insert')

beforeEach(() => {
    h.ruolo = 'segreteria'
    h.utente = SEG
    h.attive = [SEDE_A]
    h.errori = {}
    h.scritture = []
    h.logEvento.mockClear()
    h.logErrore.mockClear()
    h.db = {
        scrutinio_periodi: [],
        utenti_scuole: [],
        anni_scolastici: [
            { id: A2, etichetta: '2026/2027', etichetta_breve: '2026/27' },
            { id: A3, etichetta: '2027/2028', etichetta_breve: '2027/28' },
            { id: A9, etichetta: '2030/2031', etichetta_breve: '2030/31' },
        ],
        anni_sede: [
            { id: S2, scuola_id: SEDE_A, anno_id: A2, stato: 'corrente', domande_aperte: false },
            { id: S3, scuola_id: SEDE_A, anno_id: A3, stato: 'in_preparazione', domande_aperte: false },
            { id: SB, scuola_id: SEDE_B, anno_id: A9, stato: 'corrente', domande_aperte: false },
        ],
    }
})

describe('POST /api/admin/primaria/scrutinio-periodi · l\'anno', () => {
    it('l\'etichetta «2026/27» del corpo e l\'anno scritto coincidono (a)', async () => {
        const res = await post(corpo())
        expect(res.status).toBe(201)
        expect(inserimenti()).toHaveLength(1)
        expect(inserimenti()[0].valori[0]).toMatchObject({ anno_scolastico: '2026/27', anno_id: A2, scuola_id: SEDE_A })
    })

    it('l\'altra forma, «2027/2028», dà l\'anno 2027/28 (in preparazione: lo staff scrive)', async () => {
        const res = await post(corpo({ annoScolastico: '2027/2028' }))
        expect(res.status).toBe(201)
        expect(inserimenti()[0].valori[0]).toMatchObject({ anno_scolastico: '2027/2028', anno_id: A3 })
    })

    it('«2030/31» è un anno che esiste ma non è di questa sede → 400 ANNO_NON_DELLA_SEDE e 0 scritture', async () => {
        const res = await post(corpo({ annoScolastico: '2030/31' }))
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('ANNO_NON_DELLA_SEDE')
        expect(h.scritture).toEqual([])
    })

    it('un testo che non è nessun anno → 400 ANNO_NON_DELLA_SEDE e 0 scritture', async () => {
        const res = await post(corpo({ annoScolastico: '1999/00' }))
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('ANNO_NON_DELLA_SEDE')
        expect(h.scritture).toEqual([])
    })

    it('con `anni_sede` che risponde PGRST205 la riga NON ha anno_id e la risposta è 2xx (b)', async () => {
        h.errori = { anni_sede: { code: 'PGRST205', message: 'Could not find the table' } }
        const res = await post(corpo())
        expect(res.status).toBe(201)
        expect(inserimenti()[0].valori[0]).not.toHaveProperty('anno_id')
        expect(inserimenti()[0].valori[0]).toMatchObject({ anno_scolastico: '2026/27' })
    })

    it('con `anni_scolastici` che risponde PGRST205 si scrive come prima, senza anno_id', async () => {
        h.errori = { anni_scolastici: { code: 'PGRST205', message: 'Could not find the table' } }
        const res = await post(corpo({ annoScolastico: '2026/2027' }))
        expect(res.status).toBe(201)
        expect(inserimenti()[0].valori[0]).not.toHaveProperty('anno_id')
    })

    it('un guasto vero nel leggere `anni_scolastici` è un 500 e non si scrive', async () => {
        h.errori = { anni_scolastici: { code: '57014', message: 'timeout' } }
        const res = await post(corpo())
        expect(res.status).toBe(500)
        expect(h.scritture).toEqual([])
    })

    it('se l\'insert risponde ANNO_CHIUSO la risposta è 409 ANNO_CHIUSO, senza la rete di withRoute (c)', async () => {
        h.errori = { 'scrutinio_periodi:insert': { code: 'P0001', message: 'ANNO_CHIUSO' } }
        const res = await post(corpo())
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
        const res = await post(corpo())
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('SEDE_DA_SPECIFICARE')
        expect(h.scritture).toEqual([])
    })

    // P48: «2025/2026» è l'anno chiuso di ogni sede. Con la guardia spenta la segretaria che lo digita scrive
    // come oggi (la regola transitoria assegna l'anno): niente anno_id nel payload, un warn la conta.
    describe('anno chiuso digitato a mano (P48)', () => {
        const A1 = 'a1111111-1111-4111-8111-111111111111'
        const S1 = 'b1111111-1111-4111-8111-111111111111'
        const chiuso = () => {
            h.db.anni_scolastici.push({ id: A1, etichetta: '2025/2026', etichetta_breve: '2025/26' })
            h.db.anni_sede.push({ id: S1, scuola_id: SEDE_A, anno_id: A1, stato: 'chiuso', domande_aperte: false })
        }

        it('guardia spenta → 201, nessun anno_id, warn anno-chiuso-osservato', async () => {
            chiuso()
            h.db.anno_regole = [{ guardia_attiva: false }]
            const res = await post(corpo({ annoScolastico: '2025/2026' }))
            expect(res.status).toBe(201)
            expect(inserimenti()[0].valori[0]).not.toHaveProperty('anno_id')
            expect(inserimenti()[0].valori[0]).toMatchObject({ anno_scolastico: '2025/2026' })
            const w = h.logEvento.mock.calls.find((c) => c[2]?.tipo === 'anno-chiuso-osservato')
            expect(w?.[1]).toBe('warn')
            expect(w?.[2]).toMatchObject({ error_code: 'ANNO_CHIUSO', anno_sede_id: S1 })
        })

        it('guardia accesa → 409 ANNO_CHIUSO e 0 scritture', async () => {
            chiuso()
            h.db.anno_regole = [{ guardia_attiva: true }]
            const res = await post(corpo({ annoScolastico: '2025/2026' }))
            expect(res.status).toBe(409)
            expect((await res.json()).codice).toBe('ANNO_CHIUSO')
            expect(h.scritture).toEqual([])
        })
    })
})
