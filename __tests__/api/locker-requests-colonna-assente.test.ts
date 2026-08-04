import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `GET/PATCH /api/locker/requests` — la tolleranza d'ambiente non deve
 * inghiottire una COLONNA mancante.
 *
 * IL DIFETTO. `tabellaMancante()` qui era una copia con un regex sul MESSAGGIO:
 *
 *     error.code === '42P01' || /does not exist|schema cache|could not find/i.test(message)
 *
 * `42703` di PostgREST è «column "…" does not exist»: cadeva dentro quel regex e
 * veniva trattato come «tabella assente». In questa route la tolleranza fa
 * ritornare un ELENCO VUOTO — quindi una migrazione applicata a metà su un
 * database vivo diventava «nessuna richiesta armadietto». Il genitore vedeva zero
 * righe, e nessuno poteva sapere perché.
 *
 * ⚠️ MISURATO il 2026-08-04: `locker_requests` NON ESISTE nel database di
 * produzione (le tabelle vere sono `armadietto` e `locker_config`). Il ramo
 * tollerato è quindi quello che gira SEMPRE in produzione — motivo in più perché
 * non debba coprire anche i guasti veri.
 *
 * Test di COMPORTAMENTO, non di nome: si guardano lo stato della risposta e il
 * suo corpo, non se una certa funzione è stata chiamata.
 */

const ALUNNO = '11111111-1111-1111-1111-111111111111'
type ErrDb = { code?: string; message?: string } | null

const h = vi.hoisted(() => ({
    requireParentOfStudent: vi.fn(),
    requireDocente: vi.fn(),
    /** Esito della SELECT su `locker_requests` (il thenable della catena). */
    elenco: { data: null as unknown, error: null as { code?: string; message?: string } | null },
    /** Esito della `maybeSingle()` con cui la PATCH carica la riga. */
    riga: { data: null as unknown, error: null as { code?: string; message?: string } | null },
    /** Esito della `single()` in coda alla UPDATE della PATCH. */
    aggiornata: { data: null as unknown, error: null as { code?: string; message?: string } | null },
}))

vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({
    assertAlunnoInScope: async () => null,
    assertClasseNomeInScope: async () => null,
    scuoleDiUtente: async () => ['sc-1'],
}))
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => ({
        from: (tabella: string) => {
            const b: Record<string, unknown> = {}
            for (const m of ['select', 'eq', 'in', 'order']) b[m] = () => b
            b.update = () => { b.__update = true; return b }
            b.maybeSingle = async () => h.riga
            b.single = async () => h.aggiornata
            b.then = (res: (v: unknown) => unknown) =>
                res(tabella === 'locker_requests' ? h.elenco : { data: [{ id: ALUNNO }], error: null })
            return b
        },
    }),
}))

import { GET, PATCH } from '@/app/api/locker/requests/route'

const getReq = (qs: string) =>
    ({ url: `http://test/api/locker/requests?${qs}`, headers: new Headers(), cookies: { get: () => undefined } }) as never

const patchReq = () =>
    new Request('http://test/api/locker/requests', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: '22222222-2222-2222-2222-222222222222', stato: 'acknowledged' }),
    }) as never

const errore = (code: string, message: string): ErrDb => ({ code, message })

beforeEach(() => {
    vi.clearAllMocks()
    h.requireParentOfStudent.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore' } })
    h.requireDocente.mockResolvedValue({ user: { id: 'ed-1', role: 'educator', scuola_id: 'sc-1' } })
    h.elenco = { data: [], error: null }
    h.riga = { data: { id: 'req-1', alunno_id: ALUNNO }, error: null }
    h.aggiornata = { data: { id: 'req-1', stato: 'acknowledged' }, error: null }
})

describe('GET /api/locker/requests — tabella assente vs colonna assente', () => {
    it('42P01 (tabella assente) → 200 con elenco vuoto: tolleranza d\'ambiente', async () => {
        h.elenco = { data: null, error: errore('42P01', 'relation "locker_requests" does not exist') }
        const res = await GET(getReq(`alunno_id=${ALUNNO}`))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual([])
    })

    it('PGRST205 (tabella fuori dalla schema cache) → 200 con elenco vuoto', async () => {
        h.elenco = {
            data: null,
            error: errore('PGRST205', "Could not find the table 'public.locker_requests' in the schema cache"),
        }
        const res = await GET(getReq(`alunno_id=${ALUNNO}`))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual([])
    })

    it('42703 (COLONNA assente) → 500, NON un elenco vuoto', async () => {
        // Il cuore del difetto: «zero richieste armadietto» non è una risposta
        // accettabile a una migrazione applicata a metà.
        h.elenco = { data: null, error: errore('42703', 'column locker_requests.reminder_inviato_il does not exist') }
        const res = await GET(getReq(`alunno_id=${ALUNNO}`))
        expect(res.status).toBe(500)
        expect(await res.json()).not.toEqual([])
    })

    it('il 500 non racconta lo schema al chiamante (né tabella né colonna)', async () => {
        h.elenco = { data: null, error: errore('42703', 'column locker_requests.reminder_inviato_il does not exist') }
        const res = await GET(getReq(`alunno_id=${ALUNNO}`))
        const corpo = JSON.stringify(await res.json())
        expect(corpo).not.toContain('locker_requests')
        expect(corpo).not.toContain('reminder_inviato_il')
    })

    it('ramo docente (classe_sezione): 42703 → 500, 42P01 → elenco vuoto', async () => {
        // Due strade nella stessa route: la correzione vale per tutte e due o
        // per nessuna. È la forma con cui questo difetto è sopravvissuto finora.
        h.elenco = { data: null, error: errore('42703', 'column x does not exist') }
        expect((await GET(getReq('classe_sezione=Rossi'))).status).toBe(500)

        h.elenco = { data: null, error: errore('42P01', 'relation does not exist') }
        const ok = await GET(getReq('classe_sezione=Rossi'))
        expect(ok.status).toBe(200)
        expect(await ok.json()).toEqual([])
    })
})

describe('PATCH /api/locker/requests — tabella assente vs colonna assente', () => {
    it('42P01 sulla lettura della riga → degrada dichiarato (ok/degraded)', async () => {
        h.riga = { data: null, error: errore('42P01', 'relation "locker_requests" does not exist') }
        const res = await PATCH(patchReq())
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, degraded: true })
    })

    it('42703 sulla lettura della riga → 500, NON un «fatto» che non ha fatto niente', async () => {
        // `{ ok: true }` su una colonna mancante è la bugia peggiore: chi ha
        // chiesto il cambio di stato crede che sia avvenuto.
        h.riga = { data: null, error: errore('42703', 'column stato does not exist') }
        const res = await PATCH(patchReq())
        expect(res.status).toBe(500)
        expect(await res.json()).not.toEqual({ ok: true, degraded: true })
    })

    it('42703 sulla UPDATE → 500 (il secondo punto della stessa route)', async () => {
        h.aggiornata = { data: null, error: errore('42703', 'column preso_in_carico_il does not exist') }
        const res = await PATCH(patchReq())
        expect(res.status).toBe(500)
        expect(await res.json()).not.toEqual({ ok: true, degraded: true })
    })

    it('42P01 sulla UPDATE → degrada dichiarato', async () => {
        h.aggiornata = { data: null, error: errore('42P01', 'relation "locker_requests" does not exist') }
        const res = await PATCH(patchReq())
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, degraded: true })
    })

    it('il 500 della PATCH non racconta lo schema al chiamante', async () => {
        h.aggiornata = { data: null, error: errore('42703', 'column preso_in_carico_il does not exist') }
        const corpo = JSON.stringify(await (await PATCH(patchReq())).json())
        expect(corpo).not.toContain('preso_in_carico_il')
        expect(corpo).not.toContain('locker_requests')
    })
})
