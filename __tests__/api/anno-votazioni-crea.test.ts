import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { dataCivile } from '@/i18n/config'
import { addGiorni } from '@/lib/format/data'

/**
 * Compito 3.5-1 · `POST /api/admin/votazioni` dichiara l'anno della votazione.
 *
 * Come `votazioni-admin-crea.test.ts`: database finto che applica i filtri ed esegue le scritture, sono
 * finti solo il gate di ruolo e le sedi attive. `resolveAnnoScrittura` è quello vero. L'orologio non si
 * congela (la scadenza si calcola da `dataCivile()`). `anno_id` è `anni_scolastici.id` (`a2…` = `corrente`).
 * La rete di `withRoute` (3.4) qui non scatta: il 409 di `ANNO_CHIUSO` è la traduzione esplicita della route.
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

import { POST } from '@/app/api/admin/votazioni/route'

const uuid = (prefisso: string, n: number) => `${prefisso}-0000-4000-8000-${String(n).padStart(12, '0')}`

const SEG = uuid('20000000', 1)
const C_1 = uuid('c1000000', 1)
const G_1 = uuid('a0000000', 1)
const AL_1 = uuid('b0000000', 1)

// `anni_scolastici.id`
const A2 = 'a2222222-2222-4222-8222-222222222222' // corrente
const A3 = 'a3333333-3333-4333-8333-333333333333' // in_preparazione
const A9 = 'a9999999-9999-4999-8999-999999999999' // di un'altra sede
// `anni_sede.id`
const S2 = 'b2222222-2222-4222-8222-222222222222'
const S3 = 'b3333333-3333-4333-8333-333333333333'
const SB = 'b9999999-9999-4999-8999-999999999999'

const FUTURO = `${addGiorni(dataCivile(), 2)}T18:00`

function corpo(over: Riga = {}): Riga {
    return {
        titolo: 'Elezione di prova',
        scadenza: FUTURO,
        sectionIds: [C_1],
        rappresentanteIstituto: true,
        candidatiIstituto: [G_1],
        ...over,
    }
}
const post = (b: unknown) =>
    POST(
        new NextRequest('http://localhost/api/admin/votazioni', {
            method: 'POST',
            body: JSON.stringify(b),
            headers: { 'content-type': 'application/json' },
        }),
    )

const inserimenti = (tabella: string) =>
    (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella && s.operazione === 'insert')

beforeEach(() => {
    h.ruolo = 'segreteria'
    h.utente = SEG
    h.attive = [SEDE_A]
    h.errori = {}
    h.scritture = []
    h.logEvento.mockClear()
    h.logErrore.mockClear()
    h.db = {
        votazioni: [],
        votazioni_classi: [],
        votazioni_candidati: [],
        votazioni_voti: [],
        audit_scritture_docente: [],
        utenti_scuole: [],
        anni_sede: [
            { id: S2, scuola_id: SEDE_A, anno_id: A2, stato: 'corrente', domande_aperte: false },
            { id: S3, scuola_id: SEDE_A, anno_id: A3, stato: 'in_preparazione', domande_aperte: false },
            { id: SB, scuola_id: SEDE_B, anno_id: A9, stato: 'corrente', domande_aperte: false },
        ],
        sections: [{ id: C_1, scuola_id: SEDE_A, name: '2 ANNI', school_type: 'infanzia' }],
        alunni: [{ id: AL_1, scuola_id: SEDE_A, section_id: C_1, stato: 'iscritto', archiviato_il: null }],
        student_parents: [],
        parents: [],
        legame_genitori_alunni: [{ alunno_id: AL_1, genitore_id: G_1 }],
        utenti: [{ id: G_1, cognome: 'Alfa', nome: 'Anna', ruolo: 'genitore', attivo: true, scuola_id: SEDE_A }],
    }
})

describe('POST /api/admin/votazioni · l\'anno', () => {
    it('una votazione nasce con l\'anno del `corrente` (a)', async () => {
        const res = await post(corpo())
        expect(res.status).toBe(201)
        expect(inserimenti('votazioni')).toHaveLength(1)
        expect(inserimenti('votazioni')[0].valori[0]).toMatchObject({ scuola_id: SEDE_A, anno_id: A2 })
    })

    it('le figlie (classi e candidati) non scrivono anno_id: sono in modo `madre`', async () => {
        const res = await post(corpo())
        expect(res.status).toBe(201)
        expect(inserimenti('votazioni_classi')).toHaveLength(1)
        expect(inserimenti('votazioni_candidati')).toHaveLength(1)
        expect(inserimenti('votazioni_classi')[0].valori[0]).not.toHaveProperty('anno_id')
        expect(inserimenti('votazioni_candidati')[0].valori[0]).not.toHaveProperty('anno_id')
    })

    it('con `anni_sede` che risponde PGRST205 la riga NON ha anno_id e la risposta è 2xx (b)', async () => {
        h.errori = { anni_sede: { code: 'PGRST205', message: 'Could not find the table' } }
        const res = await post(corpo())
        expect(res.status).toBe(201)
        expect(inserimenti('votazioni')).toHaveLength(1)
        expect(inserimenti('votazioni')[0].valori[0]).not.toHaveProperty('anno_id')
    })

    it('se l\'insert risponde ANNO_CHIUSO la risposta è 409 ANNO_CHIUSO, senza la rete di withRoute (c)', async () => {
        h.errori = { 'votazioni:insert': { code: 'P0001', message: 'ANNO_CHIUSO' } }
        const res = await post(corpo())
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('ANNO_CHIUSO')
        expect(inserimenti('votazioni_classi')).toHaveLength(0)
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

    it('un `annoId` dichiarato dell\'anno in preparazione viene scritto così com\'è', async () => {
        const res = await post(corpo({ annoId: A3 }))
        expect(res.status).toBe(201)
        expect(inserimenti('votazioni')[0].valori[0]).toMatchObject({ anno_id: A3 })
    })

    it('un `annoId` di un\'altra sede → 400 ANNO_NON_DELLA_SEDE e 0 scritture', async () => {
        const res = await post(corpo({ annoId: A9 }))
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('ANNO_NON_DELLA_SEDE')
        expect(h.scritture).toEqual([])
    })
})
