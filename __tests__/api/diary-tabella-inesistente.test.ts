import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `/api/diary` — un 500 su una condizione NOTA e PERMANENTE.
 *
 * ─── La misura ──────────────────────────────────────────────────────────────
 * La route legge e scrive `daily_routines`. Quella tabella **non esiste nel
 * database di produzione** e **nessuna migrazione la crea** (verificato il
 * 2026-08-04 su `information_schema.tables`: ci sono `eventi_diario` — il diario
 * vero, servito da `/api/diary/entries` — e nient'altro). In `app_log` risultano
 * 14 chiamate a `diary:GET` chiuse con 500, accompagnate da 14 righe
 * `PGRST205 "Could not find the table 'public.daily_routines' in the schema
 * cache"`, l'ultima il 2026-08-02 alle 15:30. Nessun componente del prodotto
 * chiama questo endpoint: il diario dell'app passa da `/api/diary/entries`.
 *
 * ─── Perché il 500 era la risposta sbagliata ────────────────────────────────
 * Un 500 dichiara «non so cosa è successo». Qui si sa: la funzionalità non
 * esiste in questo ambiente, e non esisterà finché qualcuno non scrive la
 * migrazione. Un 500 su una condizione permanente e conosciuta produce un
 * allarme che nessuno può chiudere, e nasconde i 500 veri in mezzo al rumore.
 *
 * La degradazione va DICHIARATA: 503 + un campo che dice cosa manca, e il nome
 * della tabella soltanto nei LOG — al chiamante non si regala la mappa dello
 * schema (è la fuga già chiusa il 2026-08-02 su questa stessa route).
 *
 * ⚠️ Un errore che NON sia «tabella assente» resta un 500: la degradazione è per
 * la condizione nota, non per tutto ciò che va storto.
 */

const ALUNNO = '22222222-2222-2222-2222-222222222222'
const CLASSE = '33333333-3333-3333-3333-333333333333'

const h = vi.hoisted(() => ({
    requireDocente: vi.fn(),
    requireParentOfStudent: vi.fn(),
    assertSezioneInScope: vi.fn(),
    risposta: { data: null as unknown, error: null as null | { message: string; code?: string } },
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
vi.mock('@/lib/auth/scope', () => ({
    assertAlunnoInScope: async () => null,
    assertSezioneInScope: h.assertSezioneInScope,
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/primaria/notifiche', () => ({ notificaTitolariScrittura: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => {
    const client = () => ({
        from() {
            const b: Record<string, unknown> = {
                then: (res: (v: unknown) => unknown) => res(h.risposta),
            }
            b.select = () => b; b.eq = () => b; b.gte = () => b; b.lte = () => b; b.order = () => b
            b.insert = () => b
            b.maybeSingle = () => Promise.resolve({ data: null, error: null })
            b.single = () => Promise.resolve(h.risposta.error
                ? { data: null, error: h.risposta.error }
                : { data: { id: 'ev-1' }, error: null })
            return b
        },
    })
    return { createClient: async () => client(), createAdminClient: async () => client() }
})

import * as logger from '@/lib/logging/logger'
import { GET, POST } from '@/app/api/diary/route'

const getReq = (qs: string) =>
    ({ url: `http://test/api/diary?${qs}`, headers: new Headers(), cookies: { get: () => undefined } }) as never

const postReq = () =>
    ({
        url: 'http://test/api/diary',
        headers: new Headers({ 'content-type': 'application/json' }),
        cookies: { get: () => undefined },
        json: async () => ({ alunno_id: ALUNNO, classe_id: CLASSE, tipo_evento: 'pranzo' }),
    }) as never

const TABELLA_ASSENTE = {
    code: 'PGRST205',
    message: "Could not find the table 'public.daily_routines' in the schema cache",
}

beforeEach(() => {
    vi.clearAllMocks()
    h.risposta = { data: [{ id: 'ev-1' }], error: null }
    h.requireDocente.mockResolvedValue({ user: { id: 'ed-1', role: 'educator', scuola_id: 'sc-1' } })
    h.requireParentOfStudent.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore' } })
    h.assertSezioneInScope.mockResolvedValue(null)
})

describe('/api/diary — la tabella che non esiste non è un 500', () => {
    it('GET ramo genitore: tabella assente → 503 dichiarato, non 500', async () => {
        h.risposta = { data: null, error: TABELLA_ASSENTE }
        const res = await GET(getReq(`alunno_id=${ALUNNO}`))
        expect(res.status).toBe(503)
        expect((await res.json()).indisponibile).toBe(true)
    })

    it('GET ramo docente: tabella assente → 503 dichiarato, non 500', async () => {
        // Una regola valida per due strade deve vivere in un posto solo: se
        // questa asserzione non ci fosse, la correzione starebbe su un ramo solo.
        h.risposta = { data: null, error: TABELLA_ASSENTE }
        const res = await GET(getReq(`classe_id=${CLASSE}`))
        expect(res.status).toBe(503)
        expect((await res.json()).indisponibile).toBe(true)
    })

    it('POST: tabella assente → 503, e NON un 201 che non ha salvato niente', async () => {
        h.risposta = { data: null, error: TABELLA_ASSENTE }
        const res = await POST(postReq())
        expect(res.status).toBe(503)
        expect((await res.json()).indisponibile).toBe(true)
    })

    it('42P01 (l\'altro codice della stessa condizione) → 503', async () => {
        h.risposta = { data: null, error: { code: '42P01', message: 'relation "daily_routines" does not exist' } }
        expect((await GET(getReq(`alunno_id=${ALUNNO}`))).status).toBe(503)
    })

    it('il 503 non regala il nome della tabella né lo schema al chiamante', async () => {
        h.risposta = { data: null, error: TABELLA_ASSENTE }
        const corpo = JSON.stringify(await (await GET(getReq(`alunno_id=${ALUNNO}`))).json())
        expect(corpo).not.toContain('daily_routines')
        expect(corpo).not.toContain('schema cache')
    })

    it('la degradazione LASCIA TRACCIA: un log che nomina la tabella mancante', async () => {
        // Senza questa riga il 503 sarebbe un silenzio educato: dall'esterno
        // «non disponibile» e «rotta» si assomigliano, e nessuno saprebbe che
        // cosa serve per farla tornare viva.
        const spy = vi.spyOn(logger, 'logEvento')
        h.risposta = { data: null, error: TABELLA_ASSENTE }
        await GET(getReq(`alunno_id=${ALUNNO}`))
        const righe = spy.mock.calls.map((c) => JSON.stringify(c))
        expect(righe.some((r) => r.includes('daily_routines'))).toBe(true)
        spy.mockRestore()
    })

    it('un errore DIVERSO (non «tabella assente») resta 500', async () => {
        // La degradazione vale per la condizione nota. Un JWT scaduto, un
        // timeout, una policy che nega: quelli restano guasti da guardare.
        h.risposta = { data: null, error: { code: 'PGRST301', message: 'JWT expired' } }
        const res = await GET(getReq(`alunno_id=${ALUNNO}`))
        expect(res.status).toBe(500)
    })

    it('senza errore la route funziona ancora: il degrade non ha mangiato il ramo buono', async () => {
        const res = await GET(getReq(`alunno_id=${ALUNNO}`))
        expect(res.status).toBe(200)
        expect((await res.json()).data).toHaveLength(1)
    })
})
