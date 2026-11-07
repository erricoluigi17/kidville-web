import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

/**
 * Anno scolastico · PR 3, compito 3.8 — i pagamenti non cambiano payload (Ruling D3).
 *
 * L'anno di una voce lo ricava il database: da `periodo_competenza`, altrimenti da `scadenza`, altrimenti
 * (rete della PR 2) da `creato_il`. Qui si DIMOSTRA, route per route, che ogni riga mandata a `insert` su
 * `pagamenti` porta almeno una delle due date: si legge dalle scritture del finto, non dalla forma del codice.
 * Sono coperte le quattro route TypeScript che scrivono `pagamenti`: la voce manuale (`pagamenti`), `genera`
 * (singole, padre e rate), `rate` (padre e rate) e `admin/merch/ordini`. Servizi, genera-rette e quota del CRM
 * scrivono dentro funzioni SQL: non passano da qui.
 *
 * E una voce manuale per un anno chiuso (il database risponde `ANNO_CHIUSO`) dà 409, non 500.
 *
 * ⚠️ L'orologio NON si congela: nessuna data dipende da «oggi».
 */

const h = vi.hoisted(() => ({
    db: {} as Record<string, Record<string, unknown>[]>,
    errori: {} as Record<string, { code: string; message: string }>,
    scritture: [] as unknown[],
    /** Un guasto su UNA categoria di righe di `pagamenti` (es. solo le figlie): guarda il CONTENUTO dell'insert. */
    guasto: null as null | { colpisce: (r: Record<string, unknown>) => boolean; errore: { code: string; message: string } },
    tabelleLette: [] as string[],
    logEvento: vi.fn(),
    logErrore: vi.fn(),
}))

const SEG = '20000000-0000-4000-8000-000000000001'
const AL_1 = 'b0000000-0000-4000-8000-000000000001'
const AL_2 = 'b0000000-0000-4000-8000-000000000002'

vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: () => Promise.resolve({ user: { id: SEG, role: 'segreteria', scuola_id: SEDE_A } }),
}))
vi.mock('@/lib/auth/scope', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/auth/scope')>()
    return {
        ...vero,
        assertAlunnoInScope: async () => null,
        resolveScuoleAttive: async () => [SEDE_A],
        scuoleDiUtente: async () => [SEDE_A],
    }
})
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: async () => {} }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => {} }))
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => {
        const c = creaFintoSupabase(h.db as DBFinto, h.tabelleLette, { errori: h.errori, scritture: h.scritture as Scrittura[] })
        if (!h.guasto) return c
        const g = h.guasto
        return new Proxy(c, {
            get(t, prop, rec) {
                const v = Reflect.get(t, prop, rec)
                if (prop !== 'from') return v
                return (tabella: string) => {
                    const q = (v as (x: string) => object)(tabella)
                    if (tabella !== 'pagamenti') return q
                    return new Proxy(q, {
                        get(qt, qp, qr) {
                            const m = Reflect.get(qt, qp, qr)
                            if (qp !== 'insert') return m
                            return (valori: Record<string, unknown> | Record<string, unknown>[], ...resto: unknown[]) => {
                                const righe = Array.isArray(valori) ? valori : [valori]
                                if (!righe.some(g.colpisce)) return (m as (...a: unknown[]) => unknown)(valori, ...resto)
                                const r = { data: null, error: { details: null, hint: null, ...g.errore }, count: null, status: 409, statusText: 'Conflict' }
                                const f: Record<string, unknown> = {}
                                f.select = () => f
                                f.single = async () => r
                                f.maybeSingle = async () => r
                                f.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(r).then(ok, ko)
                                return f
                            }
                        },
                    })
                }
            },
        })
    },
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
    const vero = await importActual<typeof import('@/lib/logging/logger')>()
    return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import { POST as POST_MANUALE } from '@/app/api/pagamenti/route'
import { POST as POST_GENERA } from '@/app/api/pagamenti/genera/route'
import { POST as POST_RATE } from '@/app/api/pagamenti/rate/route'
import { POST as POST_MERCH } from '@/app/api/admin/merch/ordini/route'

const CHIUSO = { code: 'P0001', message: 'ANNO_CHIUSO' }
const GUASTO = { code: '23503', message: 'violates foreign key' }
const ART = 'c0000000-0000-4000-8000-000000000001'

const post = (url: string, corpo: unknown) =>
    new NextRequest(`http://localhost${url}`, {
        method: 'POST',
        body: JSON.stringify(corpo),
        headers: { 'content-type': 'application/json' },
    })

/** Le righe che le route hanno mandato a `insert` su `pagamenti`, una per una. */
const righeInserite = (): Riga[] =>
    (h.scritture as Scrittura[])
        .filter((s) => s.tabella === 'pagamenti' && s.operazione === 'insert')
        .flatMap((s) => s.valori)

const haUnaData = (r: Riga): boolean => Boolean(r.scadenza) || Boolean(r.periodo_competenza)

/** Il controllo del compito: ogni riga ha `scadenza` OPPURE `periodo_competenza`, e ce n'è almeno `attese`. */
function ognunaHaUnaData(attese: number) {
    const righe = righeInserite()
    expect(righe).toHaveLength(attese)
    const senza = righe.filter((r) => !haUnaData(r))
    expect(senza).toEqual([])
}

beforeEach(() => {
    vi.clearAllMocks()
    h.errori = {}
    h.guasto = null
    h.scritture = []
    h.tabelleLette = []
    h.db = {
        alunni: [
            { id: AL_1, scuola_id: SEDE_A, classe_sezione: '3 ANNI', section_id: 'sez-1', stato: 'iscritto' },
            { id: AL_2, scuola_id: SEDE_A, classe_sezione: '3 ANNI', section_id: 'sez-1', stato: 'iscritto' },
        ],
        pagamenti: [],
        registro_modifiche: [],
        divise_articoli: [
            { id: ART, nome: 'Polo', prezzo: 18, taglie: ['M'], attivo: true, scuola_id: SEDE_A },
        ],
        payment_categories: [{ id: 'd0000000-0000-4000-8000-000000000001', slug: 'divisa', scuola_id: null }],
        divise_ordini: [],
        divise_ordini_righe: [],
    }
})

describe('il controllo del test non è decorazione', () => {
    it('una riga senza date NON passa', () => {
        expect(haUnaData({ importo: 10 })).toBe(false)
        expect(haUnaData({ importo: 10, scadenza: null, periodo_competenza: '' })).toBe(false)
        expect(haUnaData({ importo: 10, scadenza: '2026-10-30' })).toBe(true)
        expect(haUnaData({ importo: 10, periodo_competenza: '2026-10' })).toBe(true)
    })
})

describe('pagamenti · voce manuale', () => {
    const corpo = (over: Record<string, unknown> = {}) => ({
        alunno_id: AL_1,
        descrizione: 'Gita',
        importo: 25,
        scadenza: '2026-10-30',
        ...over,
    })

    it('la riga inserita porta la scadenza', async () => {
        const res = await POST_MANUALE(post('/api/pagamenti', corpo()))
        expect(res.status).toBe(201)
        ognunaHaUnaData(1)
    })

    it('scadenza e periodo_competenza insieme: la riga le porta entrambe', async () => {
        const res = await POST_MANUALE(post('/api/pagamenti', corpo({ periodo_competenza: '2026-10' })))
        expect(res.status).toBe(201)
        expect(righeInserite()[0]).toMatchObject({ scadenza: '2026-10-30', periodo_competenza: '2026-10' })
    })

    it('anno chiuso: l’insert risponde ANNO_CHIUSO → 409 con il codice, non 500', async () => {
        h.errori = { 'pagamenti:insert': { code: 'P0001', message: 'ANNO_CHIUSO' } }
        const res = await POST_MANUALE(post('/api/pagamenti', corpo({ periodo_competenza: '2024-10', scadenza: '2024-10-30' })))
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('ANNO_CHIUSO')
        expect(h.db.pagamenti).toHaveLength(0)
    })

    it('un guasto qualunque resta 500', async () => {
        h.errori = { 'pagamenti:insert': { code: '23503', message: 'violates foreign key' } }
        const res = await POST_MANUALE(post('/api/pagamenti', corpo()))
        expect(res.status).toBe(500)
    })
})

describe('pagamenti/genera', () => {
    it('voci singole: ogni riga ha la scadenza', async () => {
        const res = await POST_GENERA(
            post('/api/pagamenti/genera', {
                descrizione: 'Gita al museo',
                importo: 10,
                scadenza: '2026-10-30',
                alunno_ids: [AL_1, AL_2],
            }),
        )
        expect(res.status).toBe(201)
        ognunaHaUnaData(2)
    })

    it('piano rateale: il padre e ogni rata, per ogni alunno, hanno la scadenza', async () => {
        const res = await POST_GENERA(
            post('/api/pagamenti/genera', {
                descrizione: 'Corso',
                alunno_ids: [AL_1, AL_2],
                rate: [
                    { importo: 60, scadenza: '2026-10-31' },
                    { importo: 40, scadenza: '2026-11-30' },
                ],
            }),
        )
        expect(res.status).toBe(201)
        // 2 alunni × (1 padre + 2 rate)
        ognunaHaUnaData(6)
        expect(righeInserite().filter((r) => r.tipo === 'padre').map((r) => r.scadenza)).toEqual(['2026-11-30', '2026-11-30'])
    })
})

describe('pagamenti/genera · anno chiuso', () => {
    const singole = { descrizione: 'Gita', importo: 10, scadenza: '2024-10-30', alunno_ids: [AL_1, AL_2] }
    const piano = {
        descrizione: 'Corso',
        alunno_ids: [AL_1],
        rate: [
            { importo: 60, scadenza: '2024-10-31' },
            { importo: 40, scadenza: '2024-11-30' },
        ],
    }
    const url = '/api/pagamenti/genera'

    it('voci singole: ANNO_CHIUSO → 409', async () => {
        h.errori = { 'pagamenti:insert': CHIUSO }
        const res = await POST_GENERA(post(url, singole))
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('ANNO_CHIUSO')
    })
    it('voci singole: altro errore → 500', async () => {
        h.errori = { 'pagamenti:insert': GUASTO }
        expect((await POST_GENERA(post(url, singole))).status).toBe(500)
    })
    it('piano rateale, errore sul padre: 409', async () => {
        h.guasto = { colpisce: (r) => r.tipo === 'padre', errore: CHIUSO }
        const res = await POST_GENERA(post(url, piano))
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('ANNO_CHIUSO')
    })
    it('piano rateale, errore sulle figlie: 409 e il padre non resta orfano', async () => {
        h.guasto = { colpisce: (r) => r.tipo === 'rata', errore: CHIUSO }
        const res = await POST_GENERA(post(url, piano))
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('ANNO_CHIUSO')
        expect(h.db.pagamenti).toHaveLength(0)
    })
    it('piano rateale, altro errore sul padre o sulle figlie: non è un 409', async () => {
        h.guasto = { colpisce: (r) => r.tipo === 'padre', errore: GUASTO }
        expect((await POST_GENERA(post(url, piano))).status).not.toBe(409)
        h.guasto = { colpisce: (r) => r.tipo === 'rata', errore: GUASTO }
        expect((await POST_GENERA(post(url, piano))).status).not.toBe(409)
    })
    it('una rata con scadenza vuota → 400, nessuna scrittura', async () => {
        const res = await POST_GENERA(
            post(url, { ...piano, rate: [{ importo: 60, scadenza: '' }, { importo: 40, scadenza: '2024-11-30' }] }),
        )
        expect(res.status).toBe(400)
        expect(righeInserite()).toHaveLength(0)
    })
})

describe('pagamenti/rate · anno chiuso', () => {
    const piano = {
        alunno_id: AL_1,
        descrizione: 'Corso di nuoto',
        importo_totale: 100,
        rate: [
            { importo: 60, scadenza: '2024-10-31' },
            { importo: 40, scadenza: '2024-11-30' },
        ],
    }
    const url = '/api/pagamenti/rate'

    it('errore sul padre: 409', async () => {
        h.guasto = { colpisce: (r) => r.tipo === 'padre', errore: CHIUSO }
        const res = await POST_RATE(post(url, piano))
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('ANNO_CHIUSO')
    })
    it('errore sulle figlie: 409 e il padre viene tolto', async () => {
        h.guasto = { colpisce: (r) => r.tipo === 'rata', errore: CHIUSO }
        const res = await POST_RATE(post(url, piano))
        expect(res.status).toBe(409)
        expect((await res.json()).codice).toBe('ANNO_CHIUSO')
        expect(h.db.pagamenti).toHaveLength(0)
    })
    it('altro errore sul padre o sulle figlie: resta 500', async () => {
        h.guasto = { colpisce: (r) => r.tipo === 'padre', errore: GUASTO }
        expect((await POST_RATE(post(url, piano))).status).toBe(500)
        h.guasto = { colpisce: (r) => r.tipo === 'rata', errore: GUASTO }
        expect((await POST_RATE(post(url, piano))).status).toBe(500)
    })
})

describe('pagamenti/rate', () => {
    it('il padre e ogni rata hanno la scadenza', async () => {
        const res = await POST_RATE(
            post('/api/pagamenti/rate', {
                alunno_id: AL_1,
                descrizione: 'Corso di nuoto',
                importo_totale: 100,
                rate: [
                    { importo: 50, scadenza: '2026-10-31' },
                    { importo: 30, scadenza: '2026-11-30' },
                    { importo: 20, scadenza: '2026-12-31' },
                ],
            }),
        )
        expect(res.status).toBe(201)
        ognunaHaUnaData(4)
    })
})

describe('admin/merch/ordini', () => {
    it('l’addebito dell’ordine ha la scadenza', async () => {
        const res = await POST_MERCH(
            post('/api/admin/merch/ordini', { alunno_id: AL_1, righe: [{ articolo_id: ART, taglia: 'M', quantita: 2 }] }) as unknown as Request,
        )
        expect(res.status).toBe(201)
        ognunaHaUnaData(1)
    })
})
