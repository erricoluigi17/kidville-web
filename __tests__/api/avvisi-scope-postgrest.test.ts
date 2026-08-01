import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// S11 — «non è tuo», «non esiste» e «non ho potuto leggere» sono TRE risposte.
//
// Rilievo log F2 del collaudo del 2026-07-31, misurato in produzione:
//
//   GET /api/avvisi/00000000-0000-4000-8000-000000000999   (uuid inesistente)
//     → 403 «Accesso negato: avviso fuori dal tuo plesso»
//     → in `app_log`: NIENTE.
//
// `assertAvvisoInScope` non guardava il valore di ritorno di PostgREST — che non
// lancia, ritorna `{ error }` (AGENTS.md §7). Perciò un guasto di lettura, un id
// inesistente e un vero tentativo cross-sede uscivano con LA STESSA risposta e
// nessuna riga di log. Due danni, non uno:
//
//  · chi riceve il 403 non sa se ha sbagliato lui o se il database non risponde;
//  · il contatore `*-fuori-sede` — nato come SEGNALE DI SICUREZZA — per gli
//    avvisi non esisteva affatto, cioè per l'entità che si porta dietro gli
//    allegati appena resi privati.
//
// La lezione è già scritta in `src/lib/auth/scope.ts` (`scopeNonRisolto`): un
// diniego per GUASTO non è un diniego per SCOPE. Qui la si applica agli avvisi e
// ai promemoria (`tasks/[id]:PUT` rispondeva 404 su un errore di lettura,
// `:DELETE` rispondeva 403).
//
// Il contratto messo alla prova:
//  · guasto di lettura → 500 + `error|auth|scope-*-non-risolto`, e MAI un warn
//    di sicurezza (i contatori non si sporcano coi guasti);
//  · id inesistente → 404, e nemmeno lì un warn di sicurezza;
//  · riga di un'altra sede → 403 + `warn|auth|*-fuori-sede` persistito;
//  · l'asserzione che conta è sulla MUTAZIONE: in nessuno dei tre casi la riga
//    dev'essere toccata. Uno status giusto con l'UPDATE già partito sarebbe un
//    falso verde;
//  · accanto a ogni diniego c'è il CONTROLLO POSITIVO: sulla propria sede si
//    legge, si aggiorna e si cancella ancora. Un gate che nega a tutti passerebbe
//    un test fatto di soli 403.
//  · il messaggio grezzo di PostgREST (nomi di colonna e di vincolo) non torna
//    più al client: sta nel log, dove serve.
// =============================================================================

const SEDE_MIA = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_ALTRUI = 'bbbbbbbb-0000-4000-8000-00000000000b'
const AVVISO_ID = 'cccccccc-0000-4000-8000-00000000000c'
const TASK_ID = 'dddddddd-0000-4000-8000-00000000000d'

interface Mutazione {
    tabella: string
    tipo: 'update' | 'delete'
    id: unknown
    valori: Record<string, unknown> | null
}

const h = vi.hoisted(() => ({
    requireDocente: vi.fn(),
    scuoleDiUtente: vi.fn(),
    verificaTargetAvvisoDocente: vi.fn(),
    /** Ogni `logEvento`: è qui che si misura il segnale di sicurezza. */
    eventi: [] as { evento: string; livello: string; campi: Record<string, unknown>; err?: unknown }[],
    /** Ogni `logErrore`: il corpo del guasto deve finire QUI, non nella risposta. */
    errori: [] as { contesto: Record<string, unknown>; err: unknown }[],
    /** Ogni UPDATE/DELETE davvero eseguita: la prova che conta. */
    mutazioni: [] as Mutazione[],
    avviso: null as Record<string, unknown> | null,
    task: null as Record<string, unknown> | null,
    /** Guasto di LETTURA di PostgREST (che non lancia: ritorna `{ error }`). */
    erroreLettura: null as { code: string; message: string } | null,
    /** Guasto di SCRITTURA: serve per il messaggio grezzo rigirato al client. */
    erroreScrittura: null as { code: string; message: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: (...a: unknown[]) => h.requireDocente(...a) }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: (...a: unknown[]) => h.scuoleDiUtente(...a) }))
vi.mock('@/lib/avvisi/target-gate', () => ({
    verificaTargetAvvisoDocente: (...a: unknown[]) => h.verificaTargetAvvisoDocente(...a),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/allegati/storage', () => ({
    firmaAllegatiAvvisi: async (_c: unknown, righe: unknown[]) => righe,
    normalizzaAllegatoAvviso: (v: unknown) => v,
    firmaAllegatiTask: async (_c: unknown, riga: unknown) => riga,
    normalizzaAllegatiTask: (v: unknown) => v,
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
    ...(await orig<typeof import('@/lib/logging/logger')>()),
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>, err?: unknown) => {
        h.eventi.push({ evento, livello, campi, err })
    },
    logErrore: (contesto: Record<string, unknown>, err: unknown) => {
        h.errori.push({ contesto, err })
    },
}))

// Finto PostgREST: restituisce `{ data, error }` come quello vero — un guasto
// non lancia, e il codice che non guarda `error` non se ne accorge.
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => ({
        from(tabella: string) {
            const st = {
                tipo: 'select' as 'select' | 'update' | 'delete',
                filtri: {} as Record<string, unknown>,
                valori: null as Record<string, unknown> | null,
            }
            const riga = () => (tabella === 'avvisi' ? h.avviso : tabella === 'task_interni' ? h.task : null)
            const esegui = () => {
                if (st.tipo === 'select') {
                    if (h.erroreLettura && (tabella === 'avvisi' || tabella === 'task_interni')) {
                        return { data: null, error: h.erroreLettura }
                    }
                    if (tabella === 'utenti') {
                        return { data: { first_name: 'A', last_name: 'B', role: 'educator' }, error: null }
                    }
                    return { data: riga(), error: null }
                }
                h.mutazioni.push({ tabella, tipo: st.tipo, id: st.filtri.id, valori: st.valori })
                if (h.erroreScrittura) return { data: null, error: h.erroreScrittura }
                return { data: { ...(riga() ?? {}), ...(st.valori ?? {}) }, error: null }
            }
            const b: Record<string, unknown> = {}
            b.select = () => b
            b.eq = (c: string, v: unknown) => { st.filtri[c] = v; return b }
            b.update = (v: Record<string, unknown>) => { st.tipo = 'update'; st.valori = v; return b }
            b.delete = () => { st.tipo = 'delete'; return b }
            b.single = async () => esegui()
            b.maybeSingle = async () => esegui()
            b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
                Promise.resolve(esegui()).then(onF, onR)
            return b
        },
    }),
}))

import { GET as AVVISO_GET, PUT as AVVISO_PUT, DELETE as AVVISO_DELETE } from '@/app/api/avvisi/[id]/route'
import { PUT as TASK_PUT, DELETE as TASK_DELETE } from '@/app/api/tasks/[id]/route'

const req = (base: string, body?: unknown, method = 'GET') => ({
    url: `http://test${base}`,
    method,
    headers: new Headers(),
    nextUrl: { searchParams: new URLSearchParams() },
    cookies: { get: () => undefined },
    json: async () => body ?? {},
}) as never

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

/** Le righe `auth` che il diniego ha lasciato, per tipo. */
const tipiAuth = (livello: string) =>
    h.eventi.filter((e) => e.evento === 'auth' && e.livello === livello).map((e) => e.campi.tipo)

beforeEach(() => {
    vi.clearAllMocks()
    h.eventi = []
    h.errori = []
    h.mutazioni = []
    h.erroreLettura = null
    h.erroreScrittura = null
    h.requireDocente.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_MIA } })
    h.scuoleDiUtente.mockResolvedValue([SEDE_MIA])
    h.verificaTargetAvvisoDocente.mockResolvedValue(null)
    h.avviso = {
        id: AVVISO_ID,
        author_id: 'aut-1',
        titolo: 'Uscita al parco',
        contenuto: 'Dettagli',
        scuola_id: SEDE_MIA,
        created_at: '2026-07-31T10:00:00Z',
    }
    h.task = {
        id: TASK_ID,
        author_id: 'aut-1',
        titolo: 'TEST promemoria',
        contenuto: null,
        completato: false,
        target_class: null,
        assigned_to: null,
        created_at: '2026-07-31T10:00:00Z',
        scuola_id: SEDE_MIA,
    }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/avvisi/[id]
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/avvisi/[id] — i tre dinieghi sono distinguibili', () => {
    it('guasto di lettura → 500 «Verifica di scope non riuscita» + error|auth, MAI un warn di sicurezza', async () => {
        h.erroreLettura = { code: '08006', message: 'connection failure' }
        const res = await AVVISO_GET(req(`/api/avvisi/${AVVISO_ID}`), ctx(AVVISO_ID))

        expect(res.status).toBe(500)
        expect((await res.json()).error).toBe('Verifica di scope non riuscita')
        expect(tipiAuth('error')).toContain('scope-avviso-non-risolto')
        // Il contatore di sicurezza NON si sporca coi guasti: se si riempisse di
        // database che non rispondono, il giorno del tentativo vero non si
        // distinguerebbe dal rumore.
        expect(tipiAuth('warn')).not.toContain('avviso-fuori-sede')
    })

    it('id inesistente → 404 «Avviso non trovato», e nemmeno qui un warn di sicurezza', async () => {
        h.avviso = null
        const res = await AVVISO_GET(req(`/api/avvisi/${AVVISO_ID}`), ctx(AVVISO_ID))

        expect(res.status).toBe(404)
        expect((await res.json()).error).toBe('Avviso non trovato')
        expect(tipiAuth('warn')).not.toContain('avviso-fuori-sede')
        expect(tipiAuth('error')).not.toContain('scope-avviso-non-risolto')
    })

    it('avviso di un\'altra sede → 403 CON la riga warn|auth|avviso-fuori-sede', async () => {
        h.avviso = { ...(h.avviso as Record<string, unknown>), scuola_id: SEDE_ALTRUI }
        const res = await AVVISO_GET(req(`/api/avvisi/${AVVISO_ID}`), ctx(AVVISO_ID))

        expect(res.status).toBe(403)
        expect(tipiAuth('warn')).toContain('avviso-fuori-sede')
        // Nessun dato dell'avviso nella riga: solo uuid utente, ruolo, azione.
        const riga = h.eventi.find((e) => e.campi.tipo === 'avviso-fuori-sede')!
        expect(riga.campi).toMatchObject({ utente: 'seg-1', ruolo: 'segreteria' })
        expect(JSON.stringify(riga.campi)).not.toContain('Uscita al parco')
    })

    it('CONTROLLO POSITIVO: il proprio avviso si legge ancora, senza righe di scope', async () => {
        const res = await AVVISO_GET(req(`/api/avvisi/${AVVISO_ID}`), ctx(AVVISO_ID))

        expect(res.status).toBe(200)
        expect((await res.json()).titolo).toBe('Uscita al parco')
        expect(h.eventi.filter((e) => e.evento === 'auth')).toHaveLength(0)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// PUT / DELETE /api/avvisi/[id] — l'asserzione è sulla MUTAZIONE
// ─────────────────────────────────────────────────────────────────────────────

const bodyAvviso = { titolo: 'TEST titolo', contenuto: 'TEST contenuto' }

describe('PUT/DELETE /api/avvisi/[id] — nessuna riga toccata quando si nega', () => {
    it('guasto di lettura sul PUT → 500 e NESSUN update', async () => {
        h.erroreLettura = { code: '08006', message: 'connection failure' }
        const res = await AVVISO_PUT(req(`/api/avvisi/${AVVISO_ID}`, bodyAvviso, 'PUT'), ctx(AVVISO_ID))

        expect(res.status).toBe(500)
        expect(h.mutazioni).toHaveLength(0)
        expect(tipiAuth('error')).toContain('scope-avviso-non-risolto')
    })

    it('avviso inesistente sul PUT → 404 e NESSUN update', async () => {
        h.avviso = null
        const res = await AVVISO_PUT(req(`/api/avvisi/${AVVISO_ID}`, bodyAvviso, 'PUT'), ctx(AVVISO_ID))

        expect(res.status).toBe(404)
        expect(h.mutazioni).toHaveLength(0)
    })

    it('avviso di un\'altra sede sul PUT → 403, warn emesso e NESSUN update', async () => {
        h.avviso = { ...(h.avviso as Record<string, unknown>), scuola_id: SEDE_ALTRUI }
        const res = await AVVISO_PUT(req(`/api/avvisi/${AVVISO_ID}`, bodyAvviso, 'PUT'), ctx(AVVISO_ID))

        expect(res.status).toBe(403)
        expect(tipiAuth('warn')).toContain('avviso-fuori-sede')
        expect(h.mutazioni).toHaveLength(0)
    })

    it('CONTROLLO POSITIVO: sul proprio avviso l\'update avviene davvero', async () => {
        const res = await AVVISO_PUT(req(`/api/avvisi/${AVVISO_ID}`, bodyAvviso, 'PUT'), ctx(AVVISO_ID))

        expect(res.status).toBe(200)
        expect(h.mutazioni).toHaveLength(1)
        expect(h.mutazioni[0]).toMatchObject({ tabella: 'avvisi', tipo: 'update', id: AVVISO_ID })
        expect(h.mutazioni[0].valori).toMatchObject({ titolo: 'TEST titolo' })
    })

    it('guasto di lettura sul DELETE → 500 e NESSUNA cancellazione', async () => {
        h.erroreLettura = { code: '08006', message: 'connection failure' }
        const res = await AVVISO_DELETE(req(`/api/avvisi/${AVVISO_ID}`, undefined, 'DELETE'), ctx(AVVISO_ID))

        expect(res.status).toBe(500)
        expect(h.mutazioni).toHaveLength(0)
    })

    it('avviso inesistente sul DELETE → 404 e NESSUNA cancellazione', async () => {
        h.avviso = null
        const res = await AVVISO_DELETE(req(`/api/avvisi/${AVVISO_ID}`, undefined, 'DELETE'), ctx(AVVISO_ID))

        expect(res.status).toBe(404)
        expect(h.mutazioni).toHaveLength(0)
    })

    it('CONTROLLO POSITIVO: il proprio avviso si cancella ancora', async () => {
        const res = await AVVISO_DELETE(req(`/api/avvisi/${AVVISO_ID}`, undefined, 'DELETE'), ctx(AVVISO_ID))

        expect(res.status).toBe(200)
        // Dal 2026-08-01 (S35) la cancellazione si porta via anche le notifiche
        // già consegnate in campanella: la riga di `avvisi` resta l'unica che
        // interessa QUI, e sulle notifiche c'è un file di prove dedicato
        // (`avvisi-orfani-cancellazione.test.ts`). Un `toHaveLength(1)` secco
        // trasformerebbe questo test in un lucchetto contro quel lavoro.
        const suAvvisi = h.mutazioni.filter((m) => m.tabella === 'avvisi')
        expect(suAvvisi).toHaveLength(1)
        expect(suAvvisi[0]).toMatchObject({ tabella: 'avvisi', tipo: 'delete', id: AVVISO_ID })
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// PUT / DELETE /api/tasks/[id] — lo stesso difetto, sulla route gemella
// ─────────────────────────────────────────────────────────────────────────────

const bodyTask = { titolo: 'TEST promemoria' }

describe('PUT /api/tasks/[id] — un guasto di lettura non è un «non trovato»', () => {
    it('guasto di lettura → 500 (non 404) e NESSUN update', async () => {
        h.erroreLettura = { code: '08006', message: 'connection failure' }
        const res = await TASK_PUT(req(`/api/tasks/${TASK_ID}`, bodyTask, 'PUT'), ctx(TASK_ID))

        expect(res.status).toBe(500)
        expect(tipiAuth('error')).toContain('scope-task-non-risolto')
        expect(h.mutazioni).toHaveLength(0)
    })

    it('promemoria inesistente → 404 e nessun warn di sicurezza', async () => {
        h.task = null
        const res = await TASK_PUT(req(`/api/tasks/${TASK_ID}`, bodyTask, 'PUT'), ctx(TASK_ID))

        expect(res.status).toBe(404)
        expect(tipiAuth('warn')).not.toContain('task-fuori-sede')
        expect(h.mutazioni).toHaveLength(0)
    })

    it('promemoria di un\'altra sede → 403 CON warn|auth|task-fuori-sede e NESSUN update', async () => {
        h.task = { ...(h.task as Record<string, unknown>), scuola_id: SEDE_ALTRUI }
        const res = await TASK_PUT(req(`/api/tasks/${TASK_ID}`, bodyTask, 'PUT'), ctx(TASK_ID))

        expect(res.status).toBe(403)
        expect(tipiAuth('warn')).toContain('task-fuori-sede')
        expect(h.mutazioni).toHaveLength(0)
    })

    it('CONTROLLO POSITIVO: sul proprio promemoria l\'update avviene davvero', async () => {
        const res = await TASK_PUT(req(`/api/tasks/${TASK_ID}`, bodyTask, 'PUT'), ctx(TASK_ID))

        expect(res.status).toBe(200)
        expect(h.mutazioni).toHaveLength(1)
        expect(h.mutazioni[0]).toMatchObject({ tabella: 'task_interni', tipo: 'update', id: TASK_ID })
        expect(h.mutazioni[0].valori).toMatchObject({ titolo: 'TEST promemoria' })
    })

    it('errore in SCRITTURA: 500 generico al client, messaggio del database solo nel log', async () => {
        h.erroreScrittura = { code: '22001', message: 'value too long for type character varying(255)' }
        const res = await TASK_PUT(req(`/api/tasks/${TASK_ID}`, bodyTask, 'PUT'), ctx(TASK_ID))

        expect(res.status).toBe(500)
        const corpo = JSON.stringify(await res.json())
        expect(corpo).not.toContain('character varying')
        // CONTROLLO POSITIVO: il corpo del guasto non è stato buttato via.
        expect(JSON.stringify(h.errori)).toContain('character varying')
    })
})

describe('DELETE /api/tasks/[id] — «non ho potuto leggere» non è «non è tuo»', () => {
    it('guasto di lettura → 500 (non 403) e NESSUNA cancellazione', async () => {
        h.erroreLettura = { code: '08006', message: 'connection failure' }
        const res = await TASK_DELETE(req(`/api/tasks/${TASK_ID}`, undefined, 'DELETE'), ctx(TASK_ID))

        expect(res.status).toBe(500)
        expect(tipiAuth('error')).toContain('scope-task-non-risolto')
        expect(tipiAuth('warn')).not.toContain('task-fuori-sede')
        expect(h.mutazioni).toHaveLength(0)
    })

    it('promemoria inesistente → 404 (non 403) e NESSUNA cancellazione', async () => {
        h.task = null
        const res = await TASK_DELETE(req(`/api/tasks/${TASK_ID}`, undefined, 'DELETE'), ctx(TASK_ID))

        expect(res.status).toBe(404)
        expect(tipiAuth('warn')).not.toContain('task-fuori-sede')
        expect(h.mutazioni).toHaveLength(0)
    })

    it('promemoria di un\'altra sede → 403 CON warn e NESSUNA cancellazione', async () => {
        h.task = { ...(h.task as Record<string, unknown>), scuola_id: SEDE_ALTRUI }
        const res = await TASK_DELETE(req(`/api/tasks/${TASK_ID}`, undefined, 'DELETE'), ctx(TASK_ID))

        expect(res.status).toBe(403)
        expect(tipiAuth('warn')).toContain('task-fuori-sede')
        expect(h.mutazioni).toHaveLength(0)
    })

    it('CONTROLLO POSITIVO: il proprio promemoria si cancella ancora', async () => {
        const res = await TASK_DELETE(req(`/api/tasks/${TASK_ID}`, undefined, 'DELETE'), ctx(TASK_ID))

        expect(res.status).toBe(200)
        expect(h.mutazioni).toHaveLength(1)
        expect(h.mutazioni[0]).toMatchObject({ tabella: 'task_interni', tipo: 'delete', id: TASK_ID })
    })

    it('errore in SCRITTURA: 500 generico al client, messaggio del database solo nel log', async () => {
        h.erroreScrittura = { code: '23503', message: 'violates foreign key constraint "task_interni_author_id_fkey"' }
        const res = await TASK_DELETE(req(`/api/tasks/${TASK_ID}`, undefined, 'DELETE'), ctx(TASK_ID))

        expect(res.status).toBe(500)
        const corpo = JSON.stringify(await res.json())
        expect(corpo).not.toContain('foreign key')
        expect(JSON.stringify(h.errori)).toContain('foreign key')
    })
})
