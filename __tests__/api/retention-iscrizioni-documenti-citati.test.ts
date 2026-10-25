// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DBFinto, ErrorePostgrest } from '../fixtures/finto-supabase'

/**
 * D9 (rapporto di robustezza del 2026-10-20): la conservazione delle iscrizioni cancellava i
 * documenti di una domanda IMPORTATA e poi respinta, o rimasta in attesa, anche se l'import li
 * aveva copiati nell'anagrafica del bambino e del genitore. Stesso file, due righe: uscendo
 * dalla domanda usciva anche dall'anagrafica.
 *
 * Il database è il finto del repo, che applica davvero i filtri e la DELETE. Lo Storage è
 * sostituito: qui conta QUALI percorsi la route chiede di togliere, non come lo Storage
 * risponde. Quello lo provano `retention-iscrizioni-file-prima.test.ts` e
 * `__tests__/lib/storage`.
 */

const CRON_SECRET = 'segreto-di-prova-non-usato-altrove'

const h = vi.hoisted(() => ({
    db: {} as Record<string, Record<string, unknown>[]>,
    errori: {} as Record<string, { code: string; message: string }>,
    /** I percorsi che la route ha chiesto di togliere dal bucket, chiamata per chiamata. */
    rimossi: [] as string[][],
    /** I percorsi che lo Storage finto dichiara «non verificabili»: trattengono la loro domanda. */
    incerti: [] as string[],
    eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/logging/logger', () => ({
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
        h.eventi.push({ evento, livello, campi })
    },
    logErrore: () => {},
    logOk: () => {},
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: vi.fn().mockResolvedValue({ user: { id: 'staff' }, response: null }),
}))

vi.mock('@/lib/supabase/server-client', async () => {
    const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
    return {
        createAdminClient: async () =>
            creaFintoSupabase(h.db as DBFinto, [], { errori: h.errori as Record<string, ErrorePostgrest> }),
    }
})

vi.mock('@/lib/storage/rimozione-verificata', async (orig) => {
    const m = await orig<typeof import('@/lib/storage/rimozione-verificata')>()
    return {
        ...m,
        rimuoviEVerifica: async (_s: unknown, _bucket: string, percorsi: string[]) => {
            h.rimossi.push([...percorsi])
            return {
                rimossi: percorsi.filter((p) => !h.incerti.includes(p)),
                giaAssenti: [],
                ancoraPresenti: [],
                incerti: percorsi.filter((p) => h.incerti.includes(p)),
                erroreRimozione: false,
            }
        },
    }
})

import { POST } from '@/app/api/gdpr/retention-iscrizioni/route'

/** Oltre i 24 mesi da qualunque data in cui questo test girerà. */
const VECCHIA = '2024-01-15T08:00:00.000Z'
const DOC_MINORE = 'iscrizioni/prova-finta/11111111-1111-4111-8111-111111111111-documento-minore.pdf'
const DOC_ADULTO = 'iscrizioni/prova-finta/22222222-2222-4222-8222-222222222222-documento-adulto.pdf'

/** Una domanda scaduta, già importata e poi respinta, oppure rimasta in attesa: il caso D9. */
function domanda(id: string, status: 'pending' | 'rejected') {
    return {
        id,
        status,
        created_at: VECCHIA,
        imported_at: VECCHIA,
        raccolta_senza_informativa: false,
        data: { children: [{ documento_path: DOC_MINORE }], adults: [{ documento_path: DOC_ADULTO }] },
    }
}

function dbIniziale(): Record<string, Record<string, unknown>[]> {
    return {
        enrollment_submissions: [domanda('domanda-finta-1', 'rejected')],
        alunni: [],
        parents: [],
        student_documents: [],
    }
}

const chiama = () =>
    POST(
        new Request('http://localhost/api/gdpr/retention-iscrizioni', {
            method: 'POST',
            headers: { 'x-cron-secret': CRON_SECRET },
        }),
    )

const tuttiRimossi = () => h.rimossi.flat()
const battito = () => h.eventi.find((e) => e.livello === 'info' && e.campi.esito === 'retention-iscrizioni')

beforeEach(() => {
    vi.clearAllMocks()
    h.db = dbIniziale()
    h.errori = {}
    h.rimossi = []
    h.incerti = []
    h.eventi = []
    process.env.CRON_SECRET = CRON_SECRET
})

// Mai un percorso nei log, in nessuno dei casi: è il documento d'identità di un minore, e un
// `msg` passa solo dalla sanificazione del testo, non dalla lista bianca. Solo conteggi e codici.
afterEach(() => {
    const scritto = JSON.stringify(h.eventi, (_k, v: unknown) => (v instanceof Set ? [...v] : v))
    expect(scritto, 'un percorso di allegato è finito in un evento di log').not.toContain('prova-finta')
})

describe("retention iscrizioni · un allegato citato da un'anagrafica non esce", () => {
    it('CONTROLLO POSITIVO: nessuno cita gli allegati ⇒ escono tutti e due e la domanda si chiude', async () => {
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ ok: true, domande: 1, file: 2, file_citati: 0 })
        expect(tuttiRimossi().sort()).toEqual([DOC_ADULTO, DOC_MINORE].sort())
        expect(h.db.enrollment_submissions).toEqual([])
        expect(battito()?.campi).toMatchObject({ n_domande: 1, n_file: 2, n_file_citati: 0 })
    })

    it("domanda importata e poi RESPINTA, documento copiato nell'alunno ⇒ il documento RESTA", async () => {
        h.db.alunni = [{ id: 'alunno-finto-1', documento_path: DOC_MINORE }]
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ ok: true, domande: 1, file: 1, file_citati: 1 })
        expect(tuttiRimossi()).not.toContain(DOC_MINORE)
        expect(tuttiRimossi()).toContain(DOC_ADULTO)
        expect(h.db.enrollment_submissions, "la riga scaduta si chiude: il file ora è dell'anagrafica").toEqual([])
        expect(battito()?.campi).toMatchObject({ n_domande: 1, n_file: 1, n_file_citati: 1 })
    })

    it('domanda rimasta IN ATTESA, documento copiato nel genitore ⇒ il documento RESTA', async () => {
        h.db.enrollment_submissions = [domanda('domanda-finta-2', 'pending')]
        h.db.parents = [{ id: 'genitore-finto-1', documento_path: DOC_ADULTO }]
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(tuttiRimossi()).not.toContain(DOC_ADULTO)
        expect(tuttiRimossi()).toContain(DOC_MINORE)
    })

    it('un documento del fascicolo NEL CESTINO lo nomina ancora ⇒ resta', async () => {
        h.db.student_documents = [
            { id: 'fascicolo-finto-1', storage_path: DOC_MINORE, file_url: null, eliminato_il: VECCHIA },
        ]
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(tuttiRimossi()).not.toContain(DOC_MINORE)
    })

    it('tutti e due citati ⇒ nessuna chiamata allo Storage, e la domanda si chiude', async () => {
        h.db.alunni = [{ id: 'alunno-finto-1', documento_path: DOC_MINORE }]
        h.db.parents = [{ id: 'genitore-finto-1', documento_path: DOC_ADULTO }]
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ ok: true, domande: 1, file: 0, file_citati: 2 })
        expect(h.rimossi).toEqual([])
        expect(h.db.enrollment_submissions).toEqual([])
    })
})

/** Un percorso inventato nella forma dell'upload, riconoscibile dal numero. */
const docN = (n: number) => `iscrizioni/prova-finta/${String(n).padStart(8, '0')}-0000-4000-8000-000000000000-documento.pdf`

/** Una domanda scaduta con i SUOI documenti: un minore e, se c'è, un adulto. */
function domandaCon(id: string, minore: string, adulto?: string) {
    return {
        ...domanda(id, 'rejected'),
        data: { children: [{ documento_path: minore }], adults: adulto ? [{ documento_path: adulto }] : [] },
    }
}

const idRimasti = () => h.db.enrollment_submissions.map((r) => r.id).sort()

/**
 * IL LOTTO HA PIÙ DI UNA DOMANDA. I casi qui sopra ne hanno una sola, e una route che chiedesse le
 * citazioni dei soli allegati della PRIMA domanda passerebbe tutti quei casi.
 */
describe('retention iscrizioni · un lotto di più domande', () => {
    it('due domande scadute: il documento citato della SECONDA resta', async () => {
        h.db.enrollment_submissions = [
            domandaCon('domanda-finta-1', docN(1), docN(2)),
            domandaCon('domanda-finta-2', docN(3), docN(4)),
        ]
        h.db.alunni = [{ id: 'alunno-finto-2', documento_path: docN(3) }]
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ ok: true, domande: 2, file: 3, file_citati: 1 })
        expect(tuttiRimossi(), "il documento copiato nell'alunno della seconda domanda").not.toContain(docN(3))
        expect(tuttiRimossi().sort()).toEqual([docN(1), docN(2), docN(4)].sort())
        expect(h.db.enrollment_submissions).toEqual([])
    })

    it('un documento CONDIVISO da due domande e citato resta; le due domande si chiudono', async () => {
        // Lo stesso genitore in due domande (due figli): il suo documento è uno, e l'anagrafica lo nomina.
        h.db.enrollment_submissions = [
            domandaCon('domanda-finta-1', docN(1), docN(9)),
            domandaCon('domanda-finta-2', docN(2), docN(9)),
        ]
        h.db.parents = [{ id: 'genitore-finto-1', documento_path: docN(9) }]
        const res = await chiama()
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ ok: true, domande: 2, file: 2, file_citati: 1 })
        expect(tuttiRimossi()).not.toContain(docN(9))
        expect(tuttiRimossi().sort()).toEqual([docN(1), docN(2)].sort())
        expect(h.db.enrollment_submissions).toEqual([])
        expect(battito()?.campi).toMatchObject({ n_domande: 2, n_domande_trattenute: 0, n_file_citati: 1 })
    })

    it('lotto misto: i citati restano, la domanda con un file non verificabile resta, le altre si chiudono', async () => {
        h.db.enrollment_submissions = [
            // A: un documento citato dall'alunno, l'altro esce ⇒ si chiude.
            domandaCon('domanda-finta-a', docN(11), docN(12)),
            // B: un file che lo Storage non sa verificare, l'altro citato dal genitore ⇒ trattenuta.
            domandaCon('domanda-finta-b', docN(21), docN(22)),
            // C: nessuno lo cita ⇒ si chiude.
            domandaCon('domanda-finta-c', docN(31)),
        ]
        h.db.alunni = [{ id: 'alunno-finto-a', documento_path: docN(11) }]
        h.db.parents = [{ id: 'genitore-finto-b', documento_path: docN(22) }]
        h.incerti = [docN(21)]

        const res = await chiama()
        expect(res.status, 'una domanda trattenuta è un giro non finito').toBe(500)
        expect(await res.json()).toMatchObject({
            ok: false,
            motivo: 'verifica-non-riuscita',
            domande: 2,
            domande_trattenute: 1,
            file: 2,
            file_bloccanti: 1,
        })
        const chiesti = tuttiRimossi()
        expect(chiesti).not.toContain(docN(11))
        expect(chiesti).not.toContain(docN(22))
        expect(chiesti.sort()).toEqual([docN(12), docN(21), docN(31)].sort())
        expect(idRimasti(), 'resta SOLO la domanda trattenuta').toEqual(['domanda-finta-b'])
        expect(battito()?.campi).toMatchObject({
            n_domande: 2,
            n_domande_trattenute: 1,
            n_file: 2,
            n_file_bloccanti: 1,
            n_file_citati: 2,
        })
    })
})

describe('retention iscrizioni · «non so chi lo cita» non è «nessuno»', () => {
    it('lettura delle citazioni fallita ⇒ 500, nessun file, nessuna riga, nessun battito', async () => {
        h.errori = { 'parents:select': { code: '57014', message: 'canceling statement due to statement timeout' } }
        const res = await chiama()
        expect(res.status).toBe(500)
        expect(await res.json()).toMatchObject({ ok: false, motivo: 'citazioni-non-lette', domande: 0 })
        expect(h.rimossi).toEqual([])
        expect(h.db.enrollment_submissions).toHaveLength(1)
        const errore = h.eventi.find((e) => e.evento === 'cron' && e.livello === 'error')
        expect(errore?.campi).toMatchObject({ esito: 'citazioni-non-lette', n_domande: 1, n_file: 2 })
        expect(battito(), 'nessun battito «fatto» su un giro che non ha fatto niente').toBeUndefined()
    })
})
