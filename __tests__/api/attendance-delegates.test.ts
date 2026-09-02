import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * GET /api/attendance/delegates — i delegati autorizzati al ritiro.
 *
 * Due invarianti, entrambe scoperte dal logging strutturato appena messo in produzione:
 *
 *  1. NON si interroga più la tabella `delegati`, che NON ESISTE (DB ripulito il 2026-07-04).
 *     La sonda ripiegava in silenzio su `delegates` — la route funzionava, quindi nessun utente
 *     se ne lamentava — ma produceva una riga `livello=error` in `app_log` a OGNI chiamata:
 *     rumore ricorrente nel canale che serve a trovare i guasti veri.
 *
 *  2. Un errore di lettura NON passa più in silenzio. PostgREST non lancia: ritorna `{ error }`,
 *     e prima quell'errore veniva scartato dalla destrutturazione → la route rispondeva `[]`,
 *     cioè «nessun delegato» quando in realtà si era rotta. L'elenco vuoto resta (al ritiro è la
 *     direzione sicura: nessuno autorizzato), ma ora il guasto è registrato.
 */

const h = vi.hoisted(() => ({
    tabelleInterrogate: [] as string[],
    errore: null as { code: string; message: string } | null,
    righe: [] as Record<string, unknown>[],
    logErrore: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireDocente: vi.fn(async () => ({ response: null, user: { id: 'u-1', role: 'educator' } })),
    getRequestUserId: vi.fn(() => 'u-1'),
}))

vi.mock('@/lib/auth/scope', () => ({
    assertClasseNomeInScope: vi.fn(async () => null),
    // Il gemello per UUID: da quando la classe si identifica con `section_id`
    // (2026-09-02) `risolviSezione` sceglie fra i due gate.
    assertSezioneInScope: vi.fn(async () => null),
    // Scope di sede sulla query (l'isolamento vero è verificato in
    // `attendance-scope-sede.test.ts`, con un finto client che filtra davvero).
    resolveScuoleAttive: vi.fn(async () => ['sc-1']),
}))

vi.mock('@/lib/logging/logger', async (originale) => ({
    ...(await originale<typeof import('@/lib/logging/logger')>()),
    logErrore: h.logErrore,
}))

/** Finto client Supabase: registra QUALE tabella viene interrogata, e non lancia mai (come PostgREST). */
function client() {
    return {
        from: (tabella: string) => {
            h.tabelleInterrogate.push(tabella)
            // Thenable invece di terminare su `.eq()`: la query dei delegati ora
            // filtra anche `.in('alunni.scuola_id', …)`, e un mock che chiude la
            // catena al primo filtro direbbe «rotto» per un difetto suo.
            const query: Record<string, unknown> = {}
            query.select = () => query
            query.eq = () => query
            query.in = () => query
            query.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
                // `sections` risponde SEMPRE, e non con `h.righe`: è la
                // traduzione nome→uuid che la route fa prima di leggere i
                // delegati. Un mock piatto che le desse la stessa risposta di
                // `delegates` farebbe uscire la route con l'elenco vuoto —
                // cioè proverebbe il vuoto invece del comportamento, e
                // `h.errore` (che vuole descrivere un guasto sui DELEGATI)
                // finirebbe per descrivere un guasto sulle sezioni.
                if (tabella === 'sections') {
                    return Promise.resolve({ data: [{ id: 'sec-1' }], error: null }).then(ok, ko)
                }
                return Promise.resolve({ data: h.errore ? null : h.righe, error: h.errore }).then(ok, ko)
            }
            return query
        },
    }
}

vi.mock('@/lib/supabase/server-client', () => ({
    createClient: vi.fn(async () => client()),
    createAdminClient: vi.fn(async () => client()),
}))

import { GET } from '@/app/api/attendance/delegates/route'

const req = () => new Request('http://localhost/api/attendance/delegates?sezione=Girasoli')

beforeEach(() => {
    h.tabelleInterrogate = []
    h.errore = null
    h.righe = []
    h.logErrore.mockClear()
})

describe('GET /api/attendance/delegates', () => {
    it('NON interroga la tabella `delegati`: non esiste, e sondarla scriveva un errore a ogni chiamata', async () => {
        await GET(req() as never)
        expect(h.tabelleInterrogate).not.toContain('delegati')
        expect(h.tabelleInterrogate).toContain('delegates')
    })

    it('mappa i delegati nel formato atteso dal frontend', async () => {
        h.righe = [{ id: 'd-1', student_id: 'a-1', first_name: 'A', last_name: 'B', document_number: 'X' }]
        const res = await GET(req() as never)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual([
            { id: 'd-1', alunno_id: 'a-1', nome: 'A B', relazione: 'Delegato', foto_url: null },
        ])
    })

    it("un errore di lettura NON è più muto: si logga, e l'elenco vuoto è fail-closed (nessuno autorizzato)", async () => {
        h.errore = { code: '42501', message: 'permission denied for table delegates' }
        const res = await GET(req() as never)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual([])
        expect(h.logErrore).toHaveBeenCalledTimes(1)
        const [campi, err] = h.logErrore.mock.calls[0] as [{ operazione: string; evento?: string }, unknown]
        expect(campi.operazione).toBe('attendance/delegates:GET')
        expect(err).toEqual(h.errore) // l'errore VERO, non un riassunto: code/details/hint sopravvivono
    })
})
