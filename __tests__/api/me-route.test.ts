import { describe, it, expect, vi, beforeEach } from 'vitest'

// P0 (DL-035): /api/me restituisce SOLO il profilo dell'utente corrente
// (gated, service-role server-side), senza segreti — sostituisce le letture
// anon dirette di `utenti` (gallery docente, modulistica genitore).
// M4B.1: espone anche `profili: [{ ruolo, area }]` (doppio profilo da `utenti`
// + ponte `parents.auth_user_id`) e non 401-a i genitori reali (solo `parents`).

// M9 (dedup M4B): la route non usa più resolveIdentity/getSessionProfili —
// 1 getUser + 2 query parallele in sessione, header legacy solo senza sessione.
// getRequestUserId è la funzione REALE (pura): l'header si testa dalla Request.
const h = vi.hoisted(() => ({
  sessionUid: 'u-1' as string | null,
  utenti: null as Record<string, unknown> | null, // riga `utenti` (per id o auth uid)
  parentsById: null as Record<string, unknown> | null, // riga `parents` .eq('id', …)
  parentsByAuth: null as Record<string, unknown> | null, // riga `parents` .eq('auth_user_id', …)
  dbQueries: 0, // contatore round-trip DB (from() = 1 query in questa route)
  getUserCalls: 0, // contatore chiamate auth.getUser
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      h.dbQueries++
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
      getUser: async () => {
        h.getUserCalls++
        return { data: { user: h.sessionUid ? { id: h.sessionUid } : null } }
      },
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
  h.sessionUid = 'u-1'
  h.utenti = { ...rigaEducator }
  h.parentsById = null
  h.parentsByAuth = null
  h.dbQueries = 0
  h.getUserCalls = 0
})

describe('GET /api/me', () => {
  it('401 senza identità (né sessione né header)', async () => {
    h.sessionUid = null
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
    h.sessionUid = 'auth-9'
    h.utenti = null
    h.parentsByAuth = { id: 'p-1', nome: 'Luca', auth_user_id: 'auth-9' }
    const res = await GET(new Request('http://localhost/api/me'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.role).toBe('genitore')
    expect(j.nome).toBe('Luca')
    expect(j.auth_user_id).toBeUndefined()
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

  it('dedup M9: percorso sessione = 1 getUser + 2 query DB (erano 6-8)', async () => {
    h.parentsByAuth = { id: 'p-7' } // caso peggiore: doppio profilo
    const res = await GET(new Request('http://localhost/api/me'))
    expect(res.status).toBe(200)
    expect(h.getUserCalls).toBe(1)
    expect(h.dbQueries).toBe(2)
  })

  it('percorso legacy senza sessione: profilo singolo dal ruolo della riga', async () => {
    h.sessionUid = null
    vi.stubEnv('ALLOW_HEADER_IDENTITY', 'true')
    try {
      const res = await GET(
        new Request('http://localhost/api/me', { headers: { 'x-user-id': 'u-1' } })
      )
      expect(res.status).toBe(200)
      const j = await res.json()
      expect(j.profili).toEqual([{ ruolo: 'educator', area: 'teacher' }])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('percorso legacy sigillato (ALLOW_HEADER_IDENTITY=false): header ignorato → 401', async () => {
    h.sessionUid = null
    vi.stubEnv('ALLOW_HEADER_IDENTITY', 'false')
    try {
      const res = await GET(
        new Request('http://localhost/api/me', { headers: { 'x-user-id': 'u-1' } })
      )
      expect(res.status).toBe(401)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
