import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

/**
 * `GET /api/admin/primaria/docenti-materie?sectionId=…` rispondeva **200 a un
 * anonimo** (misurato col server vivo il 2026-08-02).
 *
 * L'handler apriva con `parseQuery` e andava dritto a `createAdminClient()`, che
 * è il client SERVICE-ROLE: la RLS è scavalcata per costruzione, quindi non
 * esisteva nessun altro presidio. Restituiva nome e cognome del personale, le
 * materie e gli id di sezione di QUALUNQUE classe di QUALUNQUE sede — cioè
 * l'organico completo delle tre sedi, senza sessione.
 *
 * POST e DELETE, nello stesso file, avevano già `requireStaff` +
 * `assertSezioneInScope`. Era la «porta accanto»: la regola c'era, mancava su
 * uno dei tre export.
 */

const h = vi.hoisted(() => ({
    requireStaff: vi.fn(),
    assertSezioneInScope: vi.fn(),
    righe: [
        {
            id: 'usm-1', utente_id: 'ed-1', section_id: 'sez-1', materia_id: 'mat-1',
            e_contitolare: false, utenti: { nome: 'N', cognome: 'C' }, materie: { nome: 'Italiano', codice: 'ITA' },
        },
    ],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ assertSezioneInScope: h.assertSezioneInScope }))
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => ({
        from() {
            const b: Record<string, unknown> = {
                then: (res: (v: { data: unknown; error: null }) => unknown) => res({ data: h.righe, error: null }),
            }
            b.select = () => b
            b.eq = () => b
            b.maybeSingle = () => Promise.resolve({ data: null, error: null })
            return b
        },
    }),
}))

import { GET } from '@/app/api/admin/primaria/docenti-materie/route'

const SEZ = '11111111-1111-1111-1111-111111111111'
const req = (qs: string) =>
    ({ url: `http://test/api/admin/primaria/docenti-materie?${qs}`, headers: new Headers(), cookies: { get: () => undefined } }) as never

beforeEach(() => {
    vi.clearAllMocks()
    h.requireStaff.mockResolvedValue({ user: { id: 'st-1', role: 'segreteria', scuola_id: 'sc-1' } })
    h.assertSezioneInScope.mockResolvedValue(null)
})

describe('GET /api/admin/primaria/docenti-materie', () => {
    it('anonimo → 401, e la query non parte nemmeno', async () => {
        h.requireStaff.mockResolvedValue({
            response: NextResponse.json({ error: 'Non autenticato: userId mancante' }, { status: 401 }),
        })
        const res = await GET(req(`sectionId=${SEZ}`))
        expect(res.status).toBe(401)
        expect(h.requireStaff).toHaveBeenCalled()
        // Il gate viene PRIMA dello scope: senza identità non c'è niente da scopare.
        expect(h.assertSezioneInScope).not.toHaveBeenCalled()
    })

    it('sezione di un ALTRO plesso → 403 (il gate di ruolo da solo non bastava)', async () => {
        h.assertSezioneInScope.mockResolvedValue(
            NextResponse.json({ error: 'Accesso negato: classe fuori dal tuo plesso' }, { status: 403 }),
        )
        const res = await GET(req(`sectionId=${SEZ}`))
        expect(res.status).toBe(403)
        expect(h.assertSezioneInScope).toHaveBeenCalled()
    })

    it('staff nel proprio plesso → 200 con le assegnazioni', async () => {
        const res = await GET(req(`sectionId=${SEZ}`))
        expect(res.status).toBe(200)
        const j = await res.json()
        expect(j.success).toBe(true)
        expect(j.data).toHaveLength(1)
        // La sezione controllata è QUELLA richiesta, non un'altra.
        expect(h.assertSezioneInScope).toHaveBeenCalledWith(expect.anything(), expect.anything(), SEZ)
    })
})
