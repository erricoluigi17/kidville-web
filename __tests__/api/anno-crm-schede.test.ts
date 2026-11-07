import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * Compito 3.5-2 · il CRM dichiara l'anno del bambino.
 *
 * `crm_bambini` è in modo `dichiarato` e ogni bambino ha il suo `anno_ingresso`: `in_corso` (e
 * `non_indicato`) scrivono l'anno `corrente`, `prossimo` scrive l'anno che comincia il giorno dopo la
 * fine del `corrente` (trovato con `anno_di`, mai con un `dichiarato`). Due route: `POST /schede` (la
 * famiglia con i suoi bambini) e `POST /schede/[id]/bambini` (un bambino in più).
 *
 * Database finto che applica filtri e scritture (e un `anno_di` che legge `inizio`/`fine` di `anni_sede`);
 * sono finti solo il gate di ruolo e il logger. `anno_id` è `anni_scolastici.id` (`a2…` = `corrente`,
 * `a3…` = `in_preparazione`). Nessun orologio congelato. Dati finti: nessuna famiglia vera.
 */

const h = vi.hoisted(() => ({
    ruolo: 'segreteria' as string,
    db: {} as Record<string, Record<string, unknown>[]>,
    errori: {} as Record<string, unknown>,
    scritture: [] as unknown[],
    logEvento: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: (_req: unknown, ammessi: string[] = ['admin', 'coordinator', 'segreteria']) => {
        if (!ammessi.includes(h.ruolo)) return Promise.resolve({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
        return Promise.resolve({ user: { id: USER, role: h.ruolo, scuola_id: SEDE_A } })
    },
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/logging/logger')>()
    return {
        ...vero,
        logEvento: (...a: Parameters<typeof vero.logEvento>) => {
            h.logEvento(...a)
            return vero.logEvento(...a)
        },
    }
})
// Ogni client scrive nell'accumulatore comune MARCANDO la scrittura con l'header del gettone che porta.
vi.mock('@/lib/supabase/server-client', () => {
    const anno_di = ({ p_scuola, p_giorno }: Riga) => {
        const riga = (h.db.anni_sede as Riga[]).find(
            (r) => r.scuola_id === p_scuola && String(r.inizio) <= String(p_giorno) && String(p_giorno) <= String(r.fine),
        )
        return { data: riga ? riga.anno_id : null, error: null }
    }
    const nuovo = (header: string | null) => {
        const mio = [] as Scrittura[]
        mio.push = (...s: Scrittura[]) => {
            for (const x of s) (h.scritture as unknown[]).push({ ...x, header })
            return mio.length
        }
        return creaFintoSupabase(h.db as DBFinto, [], {
            errori: h.errori as Record<string, ErrorePostgrest>,
            scritture: mio,
            rpc: { anno_di },
        })
    }
    return {
        createAdminClient: async () => nuovo(null),
        createAdminClientConHeader: async (hd: Record<string, string>) => nuovo(hd['x-kidville-correzione'] ?? null),
    }
})

import { POST as POST_SCHEDA } from '@/app/api/admin/crm/schede/route'
import { POST as POST_BAMBINO } from '@/app/api/admin/crm/schede/[id]/bambini/route'

const USER = '20000000-0000-4000-8000-0000000000aa'
const SCHEDA = '30000000-0000-4000-8000-000000000001'

// `anni_scolastici.id`
const A2 = 'a2222222-2222-4222-8222-222222222222' // corrente 2026/27
const A3 = 'a3333333-3333-4333-8333-333333333333' // in_preparazione 2027/28
// `anni_sede.id`
const S2 = 'b2222222-2222-4222-8222-222222222222'
const S3 = 'b3333333-3333-4333-8333-333333333333'

const richiesta = (percorso: string, corpo: unknown) =>
    new NextRequest(`http://localhost${percorso}`, {
        method: 'POST',
        body: JSON.stringify(corpo),
        headers: { 'content-type': 'application/json' },
    })
const postScheda = (bambini: { nome: string; annoIngresso: string }[], extra: Record<string, unknown> = {}) =>
    POST_SCHEDA(
        richiesta('/api/admin/crm/schede', {
            genitoreNome: 'Famiglia Prova',
            telefono1: '333 000 0009',
            origine: 'telefonata',
            bambini,
            ...extra,
        }),
    )
const postBambino = (annoIngresso: string) =>
    POST_BAMBINO(richiesta(`/api/admin/crm/schede/${SCHEDA}/bambini`, { nome: 'Bimbo Prova', annoIngresso }), {
        params: Promise.resolve({ id: SCHEDA }),
    })

const inserimenti = (tabella: string) =>
    (h.scritture as Array<Scrittura & { header: string | null }>).filter((s) => s.tabella === tabella && s.operazione === 'insert')
const bambiniScritti = () => inserimenti('crm_bambini').flatMap((s) => s.valori)

const anniSede = (): Riga[] => [
    { id: S2, scuola_id: SEDE_A, anno_id: A2, stato: 'corrente', domande_aperte: false, inizio: '2026-09-01', fine: '2027-08-31' },
    { id: S3, scuola_id: SEDE_A, anno_id: A3, stato: 'in_preparazione', domande_aperte: false, inizio: '2027-09-01', fine: '2028-08-31' },
]

beforeEach(() => {
    h.ruolo = 'segreteria'
    h.errori = {}
    h.scritture = []
    h.logEvento.mockClear()
    h.db = {
        utenti: [{ id: USER, ruolo: 'segreteria', scuola_id: SEDE_A }],
        utenti_scuole: [],
        crm_schede: [{ id: SCHEDA, scuola_id: SEDE_A, creata_il: '2026-10-01T09:00:00.000Z', telefoni_norm: ['3330000001'], email_norm: [] }],
        crm_bambini: [],
        crm_eventi: [],
        anni_sede: anniSede(),
    }
})

describe('POST /api/admin/crm/schede · l\'anno dei bambini', () => {
    it('un bambino `in_corso` nasce con l\'anno del `corrente` (a)', async () => {
        const res = await postScheda([{ nome: 'Bimbo Prova', annoIngresso: 'in_corso' }])
        expect(res.status).toBe(201)
        expect(bambiniScritti()).toHaveLength(1)
        expect(bambiniScritti()[0]).toMatchObject({ scuola_id: SEDE_A, anno_id: A2, anno_ingresso: 'in_corso' })
    })

    it('`non_indicato` vale come `in_corso`: l\'anno del `corrente`', async () => {
        const res = await postScheda([{ nome: 'Bimbo Prova', annoIngresso: 'non_indicato' }])
        expect(res.status).toBe(201)
        expect(bambiniScritti()[0]).toMatchObject({ anno_id: A2, anno_ingresso: 'non_indicato' })
    })

    it('`prossimo` nasce con l\'anno 2027/28 (il giorno dopo la fine del `corrente`), con il ruolo segreteria', async () => {
        h.ruolo = 'segreteria'
        const res = await postScheda([{ nome: 'Bimbo Prova', annoIngresso: 'prossimo' }])
        expect(res.status).toBe(201)
        expect(bambiniScritti()[0]).toMatchObject({ anno_id: A3, anno_ingresso: 'prossimo' })
    })

    it('una famiglia con un bambino per tipo scrive due anni diversi nello STESSO insert', async () => {
        const res = await postScheda([
            { nome: 'Bimbo Uno', annoIngresso: 'in_corso' },
            { nome: 'Bimbo Due', annoIngresso: 'prossimo' },
        ])
        expect(res.status).toBe(201)
        expect(inserimenti('crm_bambini')).toHaveLength(1)
        expect(bambiniScritti().map((b) => b.anno_id)).toEqual([A2, A3])
    })

    it('la richiesta di scrittura passa dal client col gettone se c\'è (qui il `corrente` non ne ha: nessun header)', async () => {
        const res = await postScheda([{ nome: 'Bimbo Prova', annoIngresso: 'in_corso' }])
        expect(res.status).toBe(201)
        expect(inserimenti('crm_bambini')[0].header).toBeNull()
    })

    it('con `anni_sede` che risponde PGRST205 i bambini NON hanno anno_id e la risposta è 201 (b), per tutti e due i tipi', async () => {
        h.errori = { anni_sede: { code: 'PGRST205', message: 'Could not find the table' } }
        const res = await postScheda([
            { nome: 'Bimbo Uno', annoIngresso: 'in_corso' },
            { nome: 'Bimbo Due', annoIngresso: 'prossimo' },
        ])
        expect(res.status).toBe(201)
        expect(bambiniScritti()).toHaveLength(2)
        for (const b of bambiniScritti()) expect(b).not.toHaveProperty('anno_id')
    })

    it('se l\'insert dei bambini risponde ANNO_CHIUSO la risposta è 409 ANNO_CHIUSO e la scheda non resta orfana (c)', async () => {
        h.errori = { 'crm_bambini:insert': { code: 'P0001', message: 'ANNO_CHIUSO' } }
        const res = await postScheda([{ nome: 'Bimbo Prova', annoIngresso: 'in_corso' }])
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('ANNO_CHIUSO')
        expect((h.scritture as Scrittura[]).filter((s) => s.tabella === 'crm_schede' && s.operazione === 'delete')).toHaveLength(1)
    })

    it('due sedi e nessuna indicata → 400 e 0 scritture (d)', async () => {
        h.ruolo = 'admin'
        h.db.utenti_scuole = [
            { utente_id: USER, scuola_id: SEDE_A },
            { utente_id: USER, scuola_id: SEDE_B },
        ]
        const res = await postScheda([{ nome: 'Bimbo Prova', annoIngresso: 'in_corso' }])
        expect(res.status).toBe(400)
        expect(h.scritture).toEqual([])
    })

    it.each(['in_corso', 'prossimo'])('senza un `corrente` (agosto) un bambino `%s` → 400 ANNO_DA_SPECIFICARE e 0 scritture: la scheda non nasce', async (tipo) => {
        h.db.anni_sede = [
            { id: S3, scuola_id: SEDE_A, anno_id: A3, stato: 'in_preparazione', domande_aperte: false, inizio: '2027-09-01', fine: '2028-08-31' },
        ]
        const res = await postScheda([{ nome: 'Bimbo Prova', annoIngresso: tipo }])
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('ANNO_DA_SPECIFICARE')
        expect(h.scritture).toEqual([])
    })
})

describe('POST /api/admin/crm/schede/[id]/bambini · l\'anno del bambino', () => {
    it('un bambino `in_corso` nasce con l\'anno del `corrente` (a)', async () => {
        const res = await postBambino('in_corso')
        expect(res.status).toBe(201)
        expect(bambiniScritti()[0]).toMatchObject({ scuola_id: SEDE_A, scheda_id: SCHEDA, anno_id: A2, anno_ingresso: 'in_corso' })
    })

    it('`prossimo` nasce con l\'anno 2027/28, con il ruolo segreteria', async () => {
        const res = await postBambino('prossimo')
        expect(res.status).toBe(201)
        expect(bambiniScritti()[0]).toMatchObject({ anno_id: A3, anno_ingresso: 'prossimo' })
    })

    it('con `anni_sede` che risponde PGRST205 la riga NON ha anno_id e la risposta è 201 (b)', async () => {
        h.errori = { anni_sede: { code: 'PGRST205' } }
        const res = await postBambino('prossimo')
        expect(res.status).toBe(201)
        expect(bambiniScritti()[0]).not.toHaveProperty('anno_id')
    })

    it('se l\'insert risponde ANNO_CHIUSO la risposta è 409 ANNO_CHIUSO (c)', async () => {
        h.errori = { 'crm_bambini:insert': { code: 'P0001', message: 'ANNO_CHIUSO' } }
        const res = await postBambino('in_corso')
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('ANNO_CHIUSO')
    })

    it.each(['in_corso', 'prossimo'])('senza un `corrente` un bambino `%s` → 400 ANNO_DA_SPECIFICARE e 0 scritture', async (tipo) => {
        h.db.anni_sede = [
            { id: S3, scuola_id: SEDE_A, anno_id: A3, stato: 'in_preparazione', domande_aperte: false, inizio: '2027-09-01', fine: '2028-08-31' },
        ]
        const res = await postBambino(tipo)
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('ANNO_DA_SPECIFICARE')
        expect(h.scritture).toEqual([])
    })
})
