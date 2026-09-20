import { describe, it, expect, vi, beforeEach } from 'vitest'

/* ═══════════════════════════════════════════════════════════════════════════════
 * `/api/me` È LA SECONDA COPIA DELLO SMISTAMENTO, E SENZA DI LEI SI CICLA
 *
 * I profili si calcolano in DUE posti: `getProfiliForAuthUid`
 * (`src/lib/auth/profili.ts`) e questa route, che li riscrive a mano per
 * togliere 6-8 round-trip. Filtrando l'archiviato solo nel primo, si costruisce
 * un giro senza uscita — ricostruito riga per riga il 2026-09-20:
 *
 *   requireArea → profili vuoti → `/auth/login` → `signInWithPassword` RIESCE
 *   (GoTrue non sa niente di `archiviato_il`, e il cookie di sessione viene
 *   scritto) → `/api/me` → `profs = []` → `login/page.tsx` ripiega su `me.role`,
 *   che la riga `utenti` porta ANCORA → `router.replace('/teacher')` →
 *   requireArea → login. Senza un messaggio, e senza che l'utente possa fare nulla.
 *
 * Il 200 con `role` valorizzato è il pezzo che chiude l'anello. Per questo il
 * test non si limita a chiedere «403?»: verifica che la route NON risponda 200
 * con un ruolo dentro.
 *
 * ⚠️ PROVA PER ROTTURA (2026-09-20): tolto il ramo `if (staffArchiviato &&
 * !parent)` dalla route → 2 test rossi.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({
  sessionUid: 'u-1' as string | null,
  utenti: null as Record<string, unknown> | null,
  parentsByAuth: null as Record<string, unknown> | null,
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
            return { data: col === 'auth_user_id' ? h.parentsByAuth : null, error: null }
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

const ARCHIVIATA = {
  id: 'u-1',
  nome: 'X',
  cognome: 'Y',
  ruolo: 'educator',
  role: 'educator',
  archiviato_il: '2026-09-20T10:00:00Z',
}

const richiesta = () => new Request('http://localhost/api/me')

beforeEach(() => {
  h.sessionUid = 'u-1'
  h.utenti = null
  h.parentsByAuth = null
})

describe('archiviata senza ponte genitore', () => {
  it('risponde 403 con il codice, NON 200 con un ruolo dentro', async () => {
    h.utenti = { ...ARCHIVIATA }
    const res = await GET(richiesta())
    expect(res.status).toBe(403)
    const corpo = await res.json()
    expect(corpo.codice).toBe('ACCOUNT_ARCHIVIATO')
    // L'anello si chiude proprio qui: un `role` nel corpo rimanda all'area.
    expect(corpo.role).toBeUndefined()
  })

  it('NON risponde 401: un 401 manda a rifare l’accesso, e rifarlo riesce', async () => {
    // ⚠️ Questo test è nato debole e va detto: chiedeva solo `profili === undefined`,
    // e restava verde anche togliendo il ramo — perché senza di esso la route cade
    // comunque su un 401 «Utente non trovato», che non porta profili. Ma il 401 È
    // l'anello: rimanda al login, il login RIESCE, e si ricomincia. La differenza
    // fra 401 e 403 è tutta la correzione, quindi è quella che si asserisce.
    h.utenti = { ...ARCHIVIATA }
    const res = await GET(richiesta())
    expect(res.status).not.toBe(401)
    expect(res.status).toBe(403)
    const corpo = await res.json()
    expect(corpo.profili).toBeUndefined()
  })
})

describe('archiviata CON ponte genitore — non è un errore, è una veste in meno', () => {
  it('risponde 200, ruolo genitore, e un solo profilo', async () => {
    h.utenti = { ...ARCHIVIATA }
    h.parentsByAuth = { id: 'p-1', first_name: 'X', last_name: 'Y' }
    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.role).toBe('genitore')
    expect(corpo.profili).toEqual([{ ruolo: 'genitore', area: 'parent' }])
  })
})

describe('il controllo negativo', () => {
  it('non archiviata: 200, ruolo educator, profilo docente', async () => {
    h.utenti = { ...ARCHIVIATA, archiviato_il: null }
    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.role).toBe('educator')
    expect(corpo.profili).toEqual([{ ruolo: 'educator', area: 'teacher' }])
  })
})
