import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `PATCH /api/admin/parents` — LE COLONNE CHE L'AMBIENTE NON CONOSCE.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ DUE CODICI, NON UNO, e fino all'11 agosto questo ciclo ne guardava uno solo —
 * quello sbagliato. `42703` («column … of relation … does not exist») lo emette
 * POSTGRES, e su un UPDATE arriva raramente: PostgREST valida il corpo contro la
 * propria cache dello schema PRIMA di parlare col database, e quando una chiave lì
 * non è una colonna risponde **`PGRST204`**. Il ramo INSERT lo sapeva già
 * (`colonnaSconosciuta` in `src/lib/anagrafiche/parents.ts`); il ramo UPDATE no.
 *
 * Le due conseguenze, misurate e non dedotte:
 *
 *  1. IN PRODUZIONE. `app_log` porta `route=/api/admin/parents`, `codice=PGRST204`,
 *     `stato_http=400`, «Could not find the 'student_parents' column of 'parents'
 *     in the schema cache», con `admin/parents:PATCH` a 500 accanto — perché la
 *     scheda del genitore rispediva al server il fascicolo intero del GET, embed
 *     compreso. `audit_scritture_docente` (scritto SOLO dopo un update riuscito)
 *     ha 405 righe dal 5 luglio, 255 `update`, e **nessuna** su `genitori`.
 *
 *  2. IN CI. Il DB E2E è un progetto SEPARATO e NON migrato: lì
 *     `codice_belfiore_nascita` non esiste. Averlo aggiunto al corpo del PATCH
 *     senza questo ramo avrebbe reso 500 OGNI salvataggio di genitore — cioè
 *     avrebbe trasformato un campo in più in un'intera funzionalità in meno.
 *
 * Qui il finto PostgREST rifiuta le colonne che non conosce ESATTAMENTE come fa
 * quello vero: una alla volta, col proprio codice.
 */

const h = vi.hoisted(() => ({
    requireStaff: vi.fn(),
    logScrittura: vi.fn(),
    logEvento: vi.fn(),
    /** Le colonne che questo «database» non ha. */
    assenti: new Set<string>(),
    /** Ogni corpo passato a `update()`, in ordine. */
    tentativi: [] as Array<Record<string, unknown>>,
    /** L'ultimo `valoreDopo` finito nell'audit. */
    audit: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({
    logScrittura: (_c: unknown, arg: { valoreDopo?: Record<string, unknown> }) => {
        h.audit = arg.valoreDopo ?? null
        return h.logScrittura(arg)
    },
}))
vi.mock('@/lib/auth/scope', () => ({
    assertParentInScope: async () => null,
    assertAlunnoInScope: async () => null,
    resolveScuoleAttive: async () => ['sc-1'],
}))
vi.mock('@/lib/logging/logger', async (orig) => {
    const m = await orig<typeof import('@/lib/logging/logger')>()
    return { ...m, logEvento: h.logEvento }
})

/**
 * Il finto PostgREST. `PGRST204` è il codice che arriva DAVVERO su una scrittura,
 * e il messaggio è quello vero: la regex che estrae il nome della colonna legge
 * `'x' column`, non `column "x" of relation`.
 */
function makeClient() {
    return {
        from() {
            const b: Record<string, unknown> = {}
            b.select = () => b
            b.eq = () => b
            b.maybeSingle = async () => ({ data: { id: 'p-1', first_name: 'Prima' }, error: null })
            b.update = (row: Record<string, unknown>) => {
                h.tentativi.push({ ...row })
                const col = Object.keys(row).find((k) => h.assenti.has(k))
                return {
                    eq: () => ({
                        select: async () =>
                            col
                                ? {
                                      data: null,
                                      error: {
                                          code: 'PGRST204',
                                          message: `Could not find the '${col}' column of 'parents' in the schema cache`,
                                      },
                                  }
                                : { data: [{ id: 'p-1', ...row }], error: null },
                    }),
                }
            }
            return b
        },
    }
}

vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => makeClient() }))

import * as parents from '@/app/api/admin/parents/route'

const ID = '00000000-0000-4000-8000-000000000001'

const req = (body: unknown) =>
    new Request('http://localhost/api/admin/parents', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })

const CORPO = {
    id: ID,
    first_name: 'Prova',
    last_name: 'Esempio',
    fiscal_code: null,
    codice_belfiore_nascita: 'H501',
}

beforeEach(() => {
    vi.clearAllMocks()
    h.assenti.clear()
    h.tentativi = []
    h.audit = null
    h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
})

describe('PATCH /api/admin/parents · resilienza alle colonne assenti', () => {
    it('col database migrato non ritenta niente e salva al primo colpo', async () => {
        const res = await parents.PATCH(req(CORPO) as never)
        expect(res.status).toBe(200)
        expect(h.tentativi).toHaveLength(1)
        expect(h.tentativi[0]).toHaveProperty('codice_belfiore_nascita', 'H501')
        expect(h.logEvento).not.toHaveBeenCalled()
    })

    it('`codice_belfiore_nascita` assente (il DB E2E della CI) → 200, non 500', async () => {
        // Prima dell'11 agosto il ciclo guardava solo `42703`: qui rispondeva 500,
        // e in CI sarebbe fallito OGNI salvataggio di genitore.
        h.assenti.add('codice_belfiore_nascita')

        const res = await parents.PATCH(req(CORPO) as never)

        expect(res.status).toBe(200)
        expect(h.tentativi).toHaveLength(2)
        expect(h.tentativi[0]).toHaveProperty('codice_belfiore_nascita')
        expect(h.tentativi[1]).not.toHaveProperty('codice_belfiore_nascita')
        // Il resto dell'anagrafica è arrivato lo stesso.
        expect(h.tentativi[1]).toMatchObject({ first_name: 'Prova', last_name: 'Esempio' })
    })

    it('la colonna scartata si LOGGA — e a log va il nome, mai un dato di persona', async () => {
        h.assenti.add('codice_belfiore_nascita')

        await parents.PATCH(req(CORPO) as never)

        expect(h.logEvento).toHaveBeenCalledTimes(1)
        const [evento, livello, campi] = h.logEvento.mock.calls[0] as [string, string, Record<string, unknown>]
        expect(evento).toBe('anagrafica')
        expect(livello).toBe('warn')
        expect(campi).toMatchObject({
            operazione: 'admin/parents:PATCH',
            azione: 'colonna-assente-scartata',
            esito: 'codice_belfiore_nascita',
        })
        expect(JSON.stringify(campi)).not.toContain('Prova')
        expect(JSON.stringify(campi)).not.toContain('H501')
    })

    it('l’audit registra quello che è stato SCRITTO, non quello che era stato chiesto', async () => {
        h.assenti.add('codice_belfiore_nascita')

        await parents.PATCH(req(CORPO) as never)

        expect(h.logScrittura).toHaveBeenCalledTimes(1)
        expect(h.audit).not.toBeNull()
        expect(h.audit).not.toHaveProperty('codice_belfiore_nascita')
        expect(h.audit).toMatchObject({ first_name: 'Prova' })
    })

    it('anche la relazione annidata `student_parents` viene scartata invece di far 500', async () => {
        // Difesa in profondità: la scheda ora manda solo colonne di `parents`, ma la
        // rotta è `.loose()` e accetta qualunque chiave da qualunque chiamante. È
        // esattamente il corpo che in produzione ha prodotto il PGRST204.
        h.assenti.add('student_parents')

        const res = await parents.PATCH(req({ ...CORPO, student_parents: [{ relation_type: 'mother' }] }) as never)

        expect(res.status).toBe(200)
        expect(h.tentativi[0]).toHaveProperty('student_parents')
        expect(h.tentativi[1]).not.toHaveProperty('student_parents')
    })

    it('due colonne assente su due: si scartano una alla volta, come le rifiuta PostgREST', async () => {
        h.assenti.add('codice_belfiore_nascita')
        h.assenti.add('student_parents')

        const res = await parents.PATCH(req({ ...CORPO, student_parents: [] }) as never)

        expect(res.status).toBe(200)
        expect(h.tentativi).toHaveLength(3)
        expect(h.logEvento).toHaveBeenCalledTimes(2)
    })

    it('`42703` continua a funzionare: il vecchio codice non è stato sostituito, è stato affiancato', async () => {
        let primo = true
        // Qui il finto database risponde col codice di POSTGRES, non con quello di
        // PostgREST: è il ramo che esisteva prima, e deve restare verde.
        const client = {
            from() {
                const b: Record<string, unknown> = {}
                b.select = () => b
                b.eq = () => b
                b.maybeSingle = async () => ({ data: null, error: null })
                b.update = (row: Record<string, unknown>) => {
                    h.tentativi.push({ ...row })
                    const fallisce = primo
                    primo = false
                    return {
                        eq: () => ({
                            select: async () =>
                                fallisce
                                    ? {
                                          data: null,
                                          error: {
                                              code: '42703',
                                              message: 'column "codice_belfiore_nascita" of relation "parents" does not exist',
                                          },
                                      }
                                    : { data: [{ id: 'p-1', ...row }], error: null },
                        }),
                    }
                }
                return b
            },
        }
        const mod = await import('@/lib/supabase/server-client')
        const spia = vi.spyOn(mod, 'createAdminClient').mockResolvedValue(client as never)

        const res = await parents.PATCH(req(CORPO) as never)

        expect(res.status).toBe(200)
        expect(h.tentativi).toHaveLength(2)
        expect(h.tentativi[1]).not.toHaveProperty('codice_belfiore_nascita')
        spia.mockRestore()
    })

    it('un errore che NON è una colonna assente resta un 500: non si ritenta all’infinito', async () => {
        const client = {
            from() {
                const b: Record<string, unknown> = {}
                b.select = () => b
                b.eq = () => b
                b.maybeSingle = async () => ({ data: null, error: null })
                b.update = (row: Record<string, unknown>) => {
                    h.tentativi.push({ ...row })
                    return {
                        eq: () => ({
                            select: async () => ({
                                data: null,
                                error: {
                                    code: '23505',
                                    message: 'duplicate key value violates unique constraint "parents_fiscal_code_key"',
                                },
                            }),
                        }),
                    }
                }
                return b
            },
        }
        const mod = await import('@/lib/supabase/server-client')
        const spia = vi.spyOn(mod, 'createAdminClient').mockResolvedValue(client as never)

        const res = await parents.PATCH(req(CORPO) as never)

        expect(res.status).toBe(500)
        // Il messaggio del vincolo arriva INTATTO: è quello che la scheda traduce
        // in «esiste già un genitore con questo codice fiscale».
        expect((await res.json()).error).toContain('parents_fiscal_code_key')
        expect(h.tentativi).toHaveLength(1)
        expect(h.logScrittura).not.toHaveBeenCalled()
        spia.mockRestore()
    })
})
