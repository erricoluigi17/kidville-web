import { describe, it, expect, vi, beforeEach } from 'vitest'

// P0 (DL-035): /api/me restituisce SOLO il profilo dell'utente corrente
// (gated, service-role server-side), senza segreti — sostituisce le letture
// anon dirette di `utenti` (gallery docente, modulistica genitore).
// M4B.1: espone anche `profili: [{ ruolo, area }]` (doppio profilo da `utenti`
// + ponte `parents.auth_user_id`) e non 401-a i genitori reali (solo `parents`).

const h = vi.hoisted(() => ({
  identity: { userId: 'u-1', source: 'session' } as { userId: string | null; source: string | null },
  sessionUid: 'u-1' as string | null,
  utenti: null as Record<string, unknown> | null, // riga `utenti` (per id o auth uid)
  parentsById: null as Record<string, unknown> | null, // riga `parents` .eq('id', …)
  parentsByAuth: null as Record<string, unknown> | null, // riga `parents` .eq('auth_user_id', …)
}))

vi.mock('@/lib/auth/require-staff', () => ({
  resolveIdentity: vi.fn(async () => h.identity),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      let col = ''
      const b = {
        select: () => b,
        eq: (c: string) => {
          col = c
          return b
        },
        maybeSingle: async () => {
          if (table === 'utenti') return { data: h.utenti, error: null }
          if (table === 'parents') {
            return { data: col === 'auth_user_id' ? h.parentsByAuth : h.parentsById, error: null }
          }
          return { data: null, error: null }
        },
      }
      return b
    },
  }),
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: h.sessionUid ? { id: h.sessionUid } : null } }),
    },
  }),
}))

import { GET } from '@/app/api/me/route'

const rigaEducator = {
  id: 'u-1',
  nome: 'Anna',
  cognome: 'Verdi',
  ruolo: 'educator',
  password_segreta: 'SECRET',
  email: 'a@b.it',
}

beforeEach(() => {
  h.identity = { userId: 'u-1', source: 'session' }
  h.sessionUid = 'u-1'
  h.utenti = { ...rigaEducator }
  h.parentsById = null
  h.parentsByAuth = null
})

describe('GET /api/me', () => {
  it('401 senza identità', async () => {
    h.identity = { userId: null, source: null }
    const res = await GET(new Request('http://localhost/api/me'))
    expect(res.status).toBe(401)
  })

  it('401 se nessuna riga in utenti né in parents', async () => {
    h.utenti = null
    const res = await GET(new Request('http://localhost/api/me'))
    expect(res.status).toBe(401)
  })

  it('200 ritorna il profilo con ruolo (role sempre al top-level)', async () => {
    const res = await GET(new Request('http://localhost/api/me'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.role).toBe('educator')
    expect(j.nome).toBe('Anna')
  })

  it('non espone password_segreta né auth_user_id', async () => {
    h.utenti = { ...rigaEducator, auth_user_id: 'u-1' }
    const res = await GET(new Request('http://localhost/api/me'))
    const j = await res.json()
    expect(j.password_segreta).toBeUndefined()
    expect(j.auth_user_id).toBeUndefined()
  })

  it('staff singolo: profili = [{ educator, teacher }]', async () => {
    const res = await GET(new Request('http://localhost/api/me'))
    const j = await res.json()
    expect(j.profili).toEqual([{ ruolo: 'educator', area: 'teacher' }])
  })

  it('genitore reale (solo parents + ponte): 200 con profilo genitore', async () => {
    h.identity = { userId: 'p-1', source: 'session' }
    h.sessionUid = 'auth-9'
    h.utenti = null
    h.parentsById = { id: 'p-1', nome: 'Luca', auth_user_id: 'auth-9' }
    h.parentsByAuth = { id: 'p-1' }
    const res = await GET(new Request('http://localhost/api/me'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.role).toBe('genitore')
    expect(j.profili).toEqual([{ ruolo: 'genitore', area: 'parent' }])
  })

  it('doppio profilo (utenti educator + ponte parents): 2 profili', async () => {
    h.parentsByAuth = { id: 'p-7' }
    const res = await GET(new Request('http://localhost/api/me'))
    const j = await res.json()
    expect(j.profili).toEqual([
      { ruolo: 'educator', area: 'teacher' },
      { ruolo: 'genitore', area: 'parent' },
    ])
  })

  it('percorso legacy senza sessione: profilo singolo dal ruolo della riga', async () => {
    h.identity = { userId: 'u-1', source: 'header' }
    h.sessionUid = null
    const res = await GET(new Request('http://localhost/api/me'))
    const j = await res.json()
    expect(j.profili).toEqual([{ ruolo: 'educator', area: 'teacher' }])
  })
})
