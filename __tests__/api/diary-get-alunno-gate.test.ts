import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

/**
 * `GET /api/diary?alunno_id=…` non aveva NESSUN gate (misurato col server vivo
 * il 2026-08-02).
 *
 * Il ramo `classe_id` chiamava `requireDocente`; il ramo `alunno_id`, subito
 * sotto, andava dritto a `parseQuery` e alla query. Il commento diceva «per
 * genitore», ma nessun `require*` verificava che il chiamante fosse un genitore,
 * né che quel bambino fosse suo figlio.
 *
 * Oggi rispondeva 500 soltanto perché `daily_routines` non esiste in produzione
 * — e il 500 portava al chiamante il messaggio INTERNO di PostgREST («Could not
 * find the table 'public.daily_routines' in the schema cache»), che è una mappa
 * dello schema regalata a un anonimo. Il giorno in cui quella tabella esistesse,
 * la stessa chiamata avrebbe restituito il diario di QUALSIASI bambino.
 *
 * Due cose da chiudere, e sono due: il gate, e il dettaglio interno che esce.
 */

const h = vi.hoisted(() => ({
    requireDocente: vi.fn(),
    requireParentOfStudent: vi.fn(),
    risposta: { data: [{ id: 'ev-1', tipo_evento: 'pranzo' }], error: null as null | { message: string; code?: string } },
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: async () => null }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/primaria/notifiche', () => ({ notificaTitolariScrittura: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => {
    const client = () => ({
        from() {
            const b: Record<string, unknown> = {
                then: (res: (v: unknown) => unknown) => res(h.risposta),
            }
            b.select = () => b; b.eq = () => b; b.gte = () => b; b.lte = () => b; b.order = () => b
            b.maybeSingle = () => Promise.resolve({ data: null, error: null })
            return b
        },
    })
    return { createClient: async () => client(), createAdminClient: async () => client() }
})

import { GET } from '@/app/api/diary/route'

const ALUNNO = '22222222-2222-2222-2222-222222222222'
const req = (qs: string) =>
    ({ url: `http://test/api/diary?${qs}`, headers: new Headers(), cookies: { get: () => undefined } }) as never

beforeEach(() => {
    vi.clearAllMocks()
    h.risposta = { data: [{ id: 'ev-1', tipo_evento: 'pranzo' }], error: null }
    h.requireDocente.mockResolvedValue({ user: { id: 'ed-1', role: 'educator', scuola_id: 'sc-1' } })
    h.requireParentOfStudent.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore' } })
})

describe('GET /api/diary?alunno_id= — il ramo del genitore', () => {
    it('anonimo → 401 (era 200/500 senza nessun gate)', async () => {
        h.requireParentOfStudent.mockResolvedValue({
            response: NextResponse.json({ error: 'Non autenticato: userId mancante' }, { status: 401 }),
        })
        const res = await GET(req(`alunno_id=${ALUNNO}`))
        expect(res.status).toBe(401)
        expect(h.requireParentOfStudent).toHaveBeenCalled()
    })

    it('figlio di un ALTRO → 403, e il gate riceve PROPRIO l\'alunno richiesto', async () => {
        h.requireParentOfStudent.mockResolvedValue({
            response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }),
        })
        const res = await GET(req(`alunno_id=${ALUNNO}`))
        expect(res.status).toBe(403)
        expect(h.requireParentOfStudent).toHaveBeenCalledWith(expect.anything(), ALUNNO)
    })

    it('genitore del bambino → 200 con gli eventi', async () => {
        const res = await GET(req(`alunno_id=${ALUNNO}`))
        expect(res.status).toBe(200)
        expect((await res.json()).data).toHaveLength(1)
    })

    it('errore del database → 500 GENERICO: lo schema non si racconta al chiamante', async () => {
        h.risposta = {
            data: null as never,
            error: { message: "Could not find the table 'public.daily_routines' in the schema cache", code: 'PGRST205' },
        }
        const res = await GET(req(`alunno_id=${ALUNNO}`))
        expect(res.status).toBe(500)
        const corpo = JSON.stringify(await res.json())
        expect(corpo).not.toContain('daily_routines')
        expect(corpo).not.toContain('schema cache')
    })
})

describe('GET /api/diary?classe_id= — il ramo del docente', () => {
    it('non autenticato → 403 (gate già presente, non deve regredire)', async () => {
        h.requireDocente.mockResolvedValue({
            response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }),
        })
        const res = await GET(req('classe_id=33333333-3333-3333-3333-333333333333'))
        expect(res.status).toBe(403)
    })

    it("errore del database → 500 generico anche qui: è lo stesso schema, e la regola vale per tutte e due le strade", async () => {
        h.risposta = {
            data: null as never,
            error: { message: "Could not find the table 'public.daily_routines' in the schema cache", code: 'PGRST205' },
        }
        const res = await GET(req('classe_id=33333333-3333-3333-3333-333333333333'))
        expect(res.status).toBe(500)
        expect(JSON.stringify(await res.json())).not.toContain('daily_routines')
    })
})
