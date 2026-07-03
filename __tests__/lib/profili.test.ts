import { describe, it, expect, vi, beforeEach } from 'vitest'

// M4B.1 — derivazione dei profili disponibili da auth.uid(): riga `utenti`
// (staff/genitore-demo, id == auth.uid) + riga `parents` via ponte
// `parents.auth_user_id`. Doppio profilo = entrambe; dedup sul ruolo genitore.

const h = vi.hoisted(() => ({
  utenti: null as Record<string, unknown> | null,
  parentsByAuth: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({
          data: table === 'utenti' ? h.utenti : h.parentsByAuth,
          error: null,
        }),
      }
      return b
    },
  }),
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}))

import { areaDiRuolo, getProfiliForAuthUid } from '@/lib/auth/profili'

beforeEach(() => {
  h.utenti = null
  h.parentsByAuth = null
})

describe('areaDiRuolo — area "casa" di ogni ruolo', () => {
  it('staff di gestione → admin (cuoca inclusa: report in /admin/mensa/cucina)', () => {
    expect(areaDiRuolo('admin')).toBe('admin')
    expect(areaDiRuolo('coordinator')).toBe('admin')
    expect(areaDiRuolo('segreteria')).toBe('admin')
    expect(areaDiRuolo('cuoca')).toBe('admin')
  })

  it('educator → teacher, genitore → parent, ignoto → parent (area meno privilegiata)', () => {
    expect(areaDiRuolo('educator')).toBe('teacher')
    expect(areaDiRuolo('genitore')).toBe('parent')
    expect(areaDiRuolo('ruolo-ignoto')).toBe('parent')
  })
})

describe('getProfiliForAuthUid', () => {
  it('solo staff: un profilo con area del ruolo', async () => {
    h.utenti = { id: 'u-1', ruolo: 'educator' }
    expect(await getProfiliForAuthUid('u-1')).toEqual([{ ruolo: 'educator', area: 'teacher' }])
  })

  it('solo genitore reale (ponte): un profilo genitore/parent', async () => {
    h.parentsByAuth = { id: 'p-1' }
    expect(await getProfiliForAuthUid('auth-9')).toEqual([{ ruolo: 'genitore', area: 'parent' }])
  })

  it('doppio profilo: utenti educator + ponte parents', async () => {
    h.utenti = { id: 'u-1', ruolo: 'educator' }
    h.parentsByAuth = { id: 'p-1' }
    expect(await getProfiliForAuthUid('u-1')).toEqual([
      { ruolo: 'educator', area: 'teacher' },
      { ruolo: 'genitore', area: 'parent' },
    ])
  })

  it('dedup: genitore-demo in utenti + ponte parents = UN profilo genitore', async () => {
    h.utenti = { id: 'u-2', ruolo: 'genitore' }
    h.parentsByAuth = { id: 'p-2' }
    expect(await getProfiliForAuthUid('u-2')).toEqual([{ ruolo: 'genitore', area: 'parent' }])
  })

  it('nessuna riga: nessun profilo', async () => {
    expect(await getProfiliForAuthUid('sconosciuto')).toEqual([])
  })

  it('preferisce `role` a `ruolo` quando entrambi presenti', async () => {
    h.utenti = { id: 'u-3', role: 'segreteria', ruolo: 'educator' }
    expect(await getProfiliForAuthUid('u-3')).toEqual([{ ruolo: 'segreteria', area: 'admin' }])
  })
})
