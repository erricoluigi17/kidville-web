import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// ── Helper di sicurezza condiviso per le route genitore (fix IDOR test 360°). ──
// requireParentOfStudent = requireUser (identità legata alla sessione) + il gate
// che spetta al ruolo: `genitoreHasFiglio` per il genitore, `assertAlunnoInScope`
// (plesso + sezione assegnata) per chiunque altro.
//
// ⚠️ Fino al 2026-07-31 qui c'era un test intitolato «lo staff passa senza
// verifica del legame», che asseriva `genitoreHasFiglio` non chiamato e
// `response` undefined: metteva a contratto la falla invece di smentirla. Con
// `createAdminClient()` (service-role, RLS scavalcata) quel «passa» valeva per
// docenti e segreterie di ALTRE sedi e perfino per la cuoca, su venti route di
// dati di minori. Un test che ratifica un difetto è peggio di un test assente:
// il difetto assente si trova, quello ratificato no.
//
// Qui si prova la COMPOSIZIONE (chi viene chiamato, con quali argomenti, e che
// il diniego venga propagato). Il comportamento vero — con i filtri applicati
// davvero su un finto database — sta in `require-parent-scope-staff.test.ts`.

const m = vi.hoisted(() => ({
  requireUser: vi.fn(),
  genitoreHasFiglio: vi.fn(),
  assertAlunnoInScope: vi.fn(),
}))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: vi.fn().mockResolvedValue({}) }))
vi.mock('@/lib/auth/require-staff', () => ({ requireUser: m.requireUser }))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: m.genitoreHasFiglio }))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: m.assertAlunnoInScope }))

import { requireParentOfStudent } from '@/lib/auth/require-parent'

const ALUNNO = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const req = () => new Request(`http://localhost/api/parent/x?studentId=${ALUNNO}`)

beforeEach(() => {
  vi.clearAllMocks()
  m.assertAlunnoInScope.mockResolvedValue(null)
})

describe('requireParentOfStudent', () => {
  it('401 se non autenticato (requireUser risponde 401)', async () => {
    m.requireUser.mockResolvedValue({ response: new Response(null, { status: 401 }) })
    const r = await requireParentOfStudent(req(), ALUNNO)
    expect(r.response?.status).toBe(401)
    expect(m.genitoreHasFiglio).not.toHaveBeenCalled()
    expect(m.assertAlunnoInScope).not.toHaveBeenCalled()
  })

  it('403 se il genitore NON è collegato all\'alunno (IDOR bloccato)', async () => {
    m.requireUser.mockResolvedValue({ user: { id: 'g1', role: 'genitore' }, response: null })
    m.genitoreHasFiglio.mockResolvedValue(false)
    const r = await requireParentOfStudent(req(), ALUNNO)
    expect(r.response?.status).toBe(403)
    expect(m.genitoreHasFiglio).toHaveBeenCalledWith(expect.anything(), 'g1', ALUNNO)
  })

  it('ok quando il genitore è collegato al proprio figlio (e la sede non si applica)', async () => {
    m.requireUser.mockResolvedValue({ user: { id: 'g1', role: 'genitore' }, response: null })
    m.genitoreHasFiglio.mockResolvedValue(true)
    const r = await requireParentOfStudent(req(), ALUNNO)
    expect(r.response).toBeUndefined()
    expect(r.user?.id).toBe('g1')
    // Due fratelli possono essere iscritti in due plessi: allo scope di FAMIGLIA
    // il filtro di sede non si applica, e applicarlo sarebbe perfino sbagliato.
    expect(m.assertAlunnoInScope).not.toHaveBeenCalled()
  })

  it('lo staff passa dal gate di SEDE/SEZIONE, non dal legame di famiglia', async () => {
    m.requireUser.mockResolvedValue({ user: { id: 'a1', role: 'segreteria' }, response: null })
    const r = await requireParentOfStudent(req(), ALUNNO)
    expect(r.response).toBeUndefined()
    expect(m.genitoreHasFiglio).not.toHaveBeenCalled()
    expect(m.assertAlunnoInScope).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'a1', role: 'segreteria' }),
      ALUNNO,
    )
  })

  it('il diniego dello scope viene propagato tale e quale (403 dell\'alunno fuori plesso)', async () => {
    m.requireUser.mockResolvedValue({ user: { id: 'ed1', role: 'educator' }, response: null })
    m.assertAlunnoInScope.mockResolvedValue(
      NextResponse.json({ error: 'Accesso negato: alunno fuori dal tuo plesso' }, { status: 403 }),
    )
    const r = await requireParentOfStudent(req(), ALUNNO)
    expect(r.response?.status).toBe(403)
    expect(r.user).toBeUndefined()
  })

  it('la cuoca non è un\'eccezione: passa dallo stesso gate di tutti gli altri', async () => {
    m.requireUser.mockResolvedValue({ user: { id: 'c1', role: 'cuoca' }, response: null })
    m.assertAlunnoInScope.mockResolvedValue(
      NextResponse.json({ error: 'Alunno non nella tua classe' }, { status: 403 }),
    )
    const r = await requireParentOfStudent(req(), ALUNNO)
    expect(r.response?.status).toBe(403)
    expect(m.assertAlunnoInScope).toHaveBeenCalled()
  })
})
