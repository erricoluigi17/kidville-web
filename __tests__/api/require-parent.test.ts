import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Helper di sicurezza condiviso per le route genitore (fix IDOR test 360°). ──
// requireParentOfStudent = requireUser (identità legata alla sessione) + verifica
// del legame genitore↔alunno (genitoreHasFiglio). Chiude IDOR + auth-bypass.

const m = vi.hoisted(() => ({ requireUser: vi.fn(), genitoreHasFiglio: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: vi.fn().mockResolvedValue({}) }))
vi.mock('@/lib/auth/require-staff', () => ({ requireUser: m.requireUser }))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: m.genitoreHasFiglio }))

import { requireParentOfStudent } from '@/lib/auth/require-parent'

const req = () => new Request('http://localhost/api/parent/x?studentId=s1')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('requireParentOfStudent', () => {
  it('401 se non autenticato (requireUser risponde 401)', async () => {
    m.requireUser.mockResolvedValue({ response: new Response(null, { status: 401 }) })
    const r = await requireParentOfStudent(req(), 's1')
    expect(r.response?.status).toBe(401)
    expect(m.genitoreHasFiglio).not.toHaveBeenCalled()
  })

  it('403 se il genitore NON è collegato all\'alunno (IDOR bloccato)', async () => {
    m.requireUser.mockResolvedValue({ user: { id: 'g1', role: 'genitore' }, response: null })
    m.genitoreHasFiglio.mockResolvedValue(false)
    const r = await requireParentOfStudent(req(), 's1')
    expect(r.response?.status).toBe(403)
    expect(m.genitoreHasFiglio).toHaveBeenCalledWith(expect.anything(), 'g1', 's1')
  })

  it('ok quando il genitore è collegato al proprio figlio', async () => {
    m.requireUser.mockResolvedValue({ user: { id: 'g1', role: 'genitore' }, response: null })
    m.genitoreHasFiglio.mockResolvedValue(true)
    const r = await requireParentOfStudent(req(), 's1')
    expect(r.response).toBeUndefined()
    expect(r.user?.id).toBe('g1')
  })

  it('lo staff passa senza verifica del legame', async () => {
    m.requireUser.mockResolvedValue({ user: { id: 'a1', role: 'segreteria' }, response: null })
    const r = await requireParentOfStudent(req(), 's1')
    expect(r.response).toBeUndefined()
    expect(m.genitoreHasFiglio).not.toHaveBeenCalled()
  })
})
