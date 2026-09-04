/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Correggere l'email in anagrafica non cambiava l'indirizzo con cui si entra.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * È QUI CHE LA DIVERGENZA NASCE. L'account viene creato con l'indirizzo che c'è
 * in quel momento; poi la Segreteria corregge un refuso — o la famiglia cambia
 * casella — e questa rotta scriveva `parents.emails` e basta. Non esisteva, in
 * tutto il repo, un solo `updateUserById({ email })`.
 *
 * Da lì in avanti l'anagrafica dice una cosa e il login ne vuole un'altra, e la
 * cosa non si vede da nessuna parte: le credenziali partono verso l'indirizzo
 * dell'anagrafica (quindi ARRIVANO), la password viene scritta sull'account, e
 * la famiglia legge «credenziali non valide». Misurato il 2026-09-04: 4
 * anagrafiche così, nessuna delle quali era mai entrata.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
    requireStaff: vi.fn(),
    allinea: vi.fn(),
    parentPrima: { id: 'p1', auth_user_id: 'auth-1', emails: ['vecchio@x.it'] } as Record<string, unknown> | null,
    updates: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', async (importActual) => {
    const actual = await importActual<typeof import('@/lib/auth/scope')>()
    return { ...actual, assertParentInScope: async () => null }
})
vi.mock('@/lib/auth/indirizzo-accesso', async (importActual) => {
    const actual = await importActual<typeof import('@/lib/auth/indirizzo-accesso')>()
    return { ...actual, allineaIndirizzoAccesso: h.allinea }
})
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: async () => {} }))
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => ({
        from: () => ({
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.parentPrima, error: null }) }) }),
            update: (vals: Record<string, unknown>) => ({
                eq: () => ({ select: async () => { h.updates.push(vals); return { data: [{ id: 'p1' }], error: null } } }),
            }),
        }),
    }),
}))

const { PATCH } = await import('@/app/api/admin/parents/route')

const req = (body: unknown) =>
    new Request('http://x/api/admin/parents', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }) as never

beforeEach(() => {
    h.updates = []
    h.allinea.mockClear()
    h.requireStaff.mockResolvedValue({ response: null, user: { id: 'u1', ruolo: 'segreteria', scuola_id: 's1' } })
    h.allinea.mockResolvedValue({ stato: 'gia-allineato' })
    h.parentPrima = { id: 'p1', auth_user_id: 'auth-1', emails: ['vecchio@x.it'] }
})

describe('PATCH /api/admin/parents — l’indirizzo di accesso segue l’anagrafica', () => {
    it('corretta l’email in anagrafica, l’account si sposta con lei', async () => {
        h.allinea.mockResolvedValue({ stato: 'allineato', da: 'vecchio@x.it', a: 'nuovo@x.it', copiaApplicativaIndietro: false })

        const res = await PATCH(req({ id: '11111111-1111-4111-8111-111111111111', emails: ['nuovo@x.it'] }))

        expect(res.status).toBe(200)
        expect(h.allinea).toHaveBeenCalledWith(expect.anything(), 'auth-1', 'nuovo@x.it')
        // Chi ha salvato deve sapere che ha appena cambiato il login di una
        // famiglia: è la differenza fra una correzione e un effetto collaterale.
        expect(String((await res.json()).indirizzoSpostato ?? '')).toContain('nuovo@x.it')
    })

    it('un salvataggio che non tocca le email non tocca l’account', async () => {
        await PATCH(req({ id: '11111111-1111-4111-8111-111111111111', phone: '333' }))
        expect(h.allinea).not.toHaveBeenCalled()
    })

    it('un genitore SENZA account non fa scattare niente', async () => {
        h.parentPrima = { id: 'p1', auth_user_id: null, emails: ['vecchio@x.it'] }
        await PATCH(req({ id: '11111111-1111-4111-8111-111111111111', emails: ['nuovo@x.it'] }))
        expect(h.allinea).not.toHaveBeenCalled()
    })

    it('se l’allineamento non riesce il salvataggio dell’anagrafica RESTA valido, ma lo dichiara', async () => {
        // L'anagrafica è il dato che la Segreteria stava correggendo: perderlo
        // perché GoTrue non ha risposto sarebbe il rimedio peggiore del male. Ma
        // tacere che il login è rimasto indietro rifarebbe il difetto di sempre.
        h.allinea.mockResolvedValue({ stato: 'in-uso-da-altri' })

        const res = await PATCH(req({ id: '11111111-1111-4111-8111-111111111111', emails: ['nuovo@x.it'] }))

        expect(res.status).toBe(200)
        expect(h.updates, 'l’anagrafica è stata salvata comunque').toHaveLength(1)
        expect(String((await res.json()).avvisoIndirizzo ?? '')).toMatch(/accesso/i)
    })
})
