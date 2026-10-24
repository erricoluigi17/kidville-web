import { describe, it, expect, vi, beforeEach } from 'vitest'

// D9, seconda metà: il rifiuto non guardava lo stato precedente. Un clic su «Rifiuta» su una
// domanda GIÀ APPROVATA la rimetteva fra le `rejected`, con `imported_at` valorizzato, e da lì
// il giro di conservazione l'avrebbe cancellata con i suoi allegati, che sono anche i
// documenti dell'anagrafica. Qui si prova che il rifiuto vale solo da `pending`, e che lo
// stabilisce l'UPDATE stesso.

const ID = '5c5c5c5c-5c5c-45c5-85c5-5c5c5c5c5c5c'

const h = vi.hoisted(() => ({
    /** La riga della domanda, mutata DAVVERO dall'UPDATE se i filtri combaciano. */
    riga: {} as Record<string, unknown>,
    filtriUpdate: [] as { colonna: string; valore: unknown }[],
    logScrittura: vi.fn(),
    eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: vi.fn().mockResolvedValue({ user: { id: 'segreteria-finta', role: 'segreteria', scuola_id: 'sede-finta' } }),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => ({ ok: true }) }))
vi.mock('@/lib/email/send', () => ({
    sendEmail: async () => true,
    sendEmailDetailed: async () => ({ ok: true, error: null }),
    credentialsEmailBody: () => 'x',
}))
vi.mock('@/lib/auth/parent-identity', () => ({
    ensureParentIdentity: async () => ({ ok: true, authUserId: 'auth-x', password: null, createdAuth: false, reason: null, message: '' }),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: async () => ({ creati: 0 }) }))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
    resolveScuoleAttive: async () => ['sede-finta'],
    resolveScuolaScrittura: async () => ({ scuolaId: 'sede-finta' }),
    scuoleDiUtente: async () => ['sede-finta'],
}))
vi.mock('@/lib/logging/logger', async (orig) => {
    const m = await orig<typeof import('@/lib/logging/logger')>()
    return {
        ...m,
        logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
            h.eventi.push({ evento, livello, campi })
        },
    }
})

vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => ({
        storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'u' }, error: null }) }) },
        from(table: string) {
            const b: Record<string, unknown> = {}
            b.select = () => b
            b.eq = () => b
            b.in = () => b
            b.limit = () => b
            b.order = async () => ({ data: [], error: null })
            b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
            b.maybeSingle = async () =>
                table === 'enrollment_submissions' ? { data: { ...h.riga }, error: null } : { data: null, error: null }
            b.single = async () => ({ data: null, error: null })
            b.update = (patch: Record<string, unknown>) => {
                const filtri: Record<string, unknown> = {}
                const u: Record<string, unknown> = {}
                u.eq = (colonna: string, valore: unknown) => {
                    filtri[colonna] = valore
                    h.filtriUpdate.push({ colonna, valore })
                    return u
                }
                u.select = () => u
                // Come Postgres: l'UPDATE tocca la riga solo se TUTTI i filtri combaciano.
                const esegui = () => {
                    if (!Object.entries(filtri).every(([c, v]) => h.riga[c] === v)) return null
                    Object.assign(h.riga, patch)
                    return { ...h.riga }
                }
                u.maybeSingle = async () => ({ data: esegui(), error: null })
                u.single = async () => {
                    const riga = esegui()
                    return riga
                        ? { data: riga, error: null }
                        : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
                }
                return u
            }
            return b
        },
    }),
}))

import { PATCH } from '@/app/api/admin/iscrizioni/route'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'

const rifiuta = () =>
    PATCH(
        new Request('http://localhost/api/admin/iscrizioni', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: ID, action: 'reject' }),
        }) as never,
    )

function domandaIn(status: string): Record<string, unknown> {
    return {
        id: ID,
        scuola_id: 'sede-finta',
        status,
        imported_at: status === 'approved' ? '2026-09-01T08:00:00.000Z' : null,
        consents_log: [],
        data: { children: [], adults: [] },
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    h.filtriUpdate = []
    h.eventi = []
})

describe('rifiuto di una domanda — solo da «in attesa»', () => {
    it('una domanda GIÀ APPROVATA ⇒ 409 con codice, e resta approvata', async () => {
        h.riga = domandaIn('approved')
        const res = await rifiuta()
        expect(res.status).toBe(409)
        expect(await res.json()).toMatchObject({ codice: 'DOMANDA_GIA_ESAMINATA' })
        expect(h.riga.status).toBe('approved')
        expect(h.logScrittura).not.toHaveBeenCalled()
        expect(h.eventi.find((e) => e.campi.esito === 'rifiuto-domanda-non-in-attesa')).toMatchObject({
            evento: 'iscrizione',
            livello: 'warn',
            campi: { entita_id: ID },
        })
    })

    it('il doppio clic: una domanda già respinta ⇒ 409, e nessuna seconda traccia', async () => {
        h.riga = domandaIn('rejected')
        const res = await rifiuta()
        expect(res.status).toBe(409)
        expect(h.logScrittura).not.toHaveBeenCalled()
    })

    it("CONTROLLO POSITIVO: una domanda in attesa si respinge, e l'UPDATE porta il filtro sullo stato", async () => {
        h.riga = domandaIn('pending')
        const res = await rifiuta()
        expect(res.status).toBe(200)
        expect(h.riga.status).toBe('rejected')
        expect(h.filtriUpdate).toContainEqual({ colonna: 'status', valore: 'pending' })
        expect(h.logScrittura).toHaveBeenCalledTimes(1)
    })

    it('il codice è dichiarato', () => {
        expect(CODICI_ERRORE.DOMANDA_GIA_ESAMINATA).toBe('erroreDomandaGiaEsaminata')
    })
})
