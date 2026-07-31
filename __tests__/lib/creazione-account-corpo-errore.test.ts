import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// F4 (gemelle) — QUANDO GoTrue RIFIUTA DI CREARE UN ACCOUNT, SI DEVE CAPIRE PERCHÉ.
//
// La famiglia era già stata corretta oggi su `listUsers` (dove `error.message`
// può essere `undefined`: visto in produzione il 31/07 con `banned_until =
// 'infinity'`, timestamp legittimo per Postgres e non serializzabile in JSON,
// che fa fallire l'INTERA pagina). La ricerca però si era fermata lì: i due
// `createUser` — quello di `ensureParentIdentity` e quello del backfill S6 —
// erano rimasti a `error?.message ?? 'errore sconosciuto'` e `?? 'createUser
// failed'`, cioè al numero senza il corpo. E senza NESSUN `logEvento`: chi
// riceve «Creazione account non riuscita: errore sconosciuto» non ha una riga
// da cercare da nessuna parte.
//
// Regola 3 di AGENTS.md: loggare uno status senza il corpo È il bug.
// =============================================================================

const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import { ensureParentIdentity } from '@/lib/auth/parent-identity'
import { backfillParentsAuth } from '@/lib/auth/backfill'

const EMAIL = 'genitore@example.test'
const PARENT = { id: 'p1', auth_user_id: null, emails: [EMAIL], first_name: 'Mario', last_name: 'Rossi' }

/** Errore GoTrue SENZA `message`: la forma che oggi diventa «errore sconosciuto». */
const SENZA_MESSAGGIO = { status: 422, code: 'weak_password', __isAuthError: true }

/** Un vero `Error` con messaggio vuoto: `JSON.stringify` ne fa `{}`, che è
 *  truthy — la trappola che rende inutile la normalizzazione ingenua. */
function erroreOpaco(): Error & { status: number } {
  const e = new Error('') as Error & { status: number }
  e.name = 'AuthApiError'
  e.status = 503
  return e
}

function db(): DBFinto {
  return {
    parents: [{ id: 'p1', auth_user_id: null }],
    student_parents: [],
    utenti: [],
  }
}

/** Finto client + un `auth.admin` che rifiuta la creazione dell'account. */
function adminCheRifiuta(errore: unknown, dati: DBFinto = db()): SupabaseClient {
  const finto = creaFintoSupabase(dati, [])
  return {
    from: (t: string) => (finto as unknown as { from: (t: string) => unknown }).from(t),
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: [] }, error: null }),
        createUser: async () => ({ data: { user: null }, error: errore }),
      },
    },
  } as unknown as SupabaseClient
}

const logDi = (esito: string) =>
  logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === esito)

beforeEach(() => vi.clearAllMocks())

describe('ensureParentIdentity — createUser rifiutato', () => {
  it('errore SENZA message ⇒ il corpo finisce nel messaggio, non «errore sconosciuto»', async () => {
    const r = await ensureParentIdentity(adminCheRifiuta(SENZA_MESSAGGIO), PARENT, {})

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('error')
    expect(r.message).toContain('weak_password')
    expect(r.message).not.toContain('errore sconosciuto')
  })

  it('errore OPACO (Error con message vuoto) ⇒ almeno lo status, mai «{}»', async () => {
    const r = await ensureParentIdentity(adminCheRifiuta(erroreOpaco()), PARENT, {})

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('503')
    expect(r.message).not.toContain('{}')
  })

  it('lascia una riga di log `error` con l errore vero attaccato', async () => {
    await ensureParentIdentity(adminCheRifiuta(SENZA_MESSAGGIO), PARENT, {})

    const riga = logDi('creazione-account-non-riuscita')
    expect(riga).toBeTruthy()
    expect(riga![0]).toBe('auth')
    expect(riga![1]).toBe('error')
    // L'errore del provider viaggia come 4º argomento: è da lì che il logger
    // ricava codice, messaggio e stack per la riga persistita.
    expect(riga![3]).toBe(SENZA_MESSAGGIO)
  })

  it('createUser «riuscito» ma senza utente ⇒ non passa per buono, e si logga', async () => {
    const finto = creaFintoSupabase(db(), [])
    const admin = {
      from: (t: string) => (finto as unknown as { from: (t: string) => unknown }).from(t),
      auth: {
        admin: {
          listUsers: async () => ({ data: { users: [] }, error: null }),
          createUser: async () => ({ data: { user: null }, error: null }),
        },
      },
    } as unknown as SupabaseClient

    const r = await ensureParentIdentity(admin, PARENT, {})
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toMatch(/nessun utente/i)
    expect(logDi('creazione-account-non-riuscita')).toBeTruthy()
  })
})

// ── Il gemello: il backfill S6 ────────────────────────────────────────────────

function adminBackfill(errore: unknown): SupabaseClient {
  return {
    from: (table: string) => {
      if (table === 'schools') {
        // `resolveScuolaId` (deprecata ma ancora usata dal backfill) legge qui.
        return { select: () => ({ limit: async () => ({ data: [], error: null }) }) }
      }
      if (table === 'utenti') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          insert: async () => ({ error: null }),
        }
      }
      return {
        select: () => ({
          is: () => Promise.resolve({ data: [{ id: 'p1', emails: [EMAIL] }], error: null }),
        }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      }
    },
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: [] }, error: null }),
        createUser: async () => ({ data: { user: null }, error: errore }),
      },
    },
  } as unknown as SupabaseClient
}

describe('backfillParentsAuth — createUser rifiutato', () => {
  it('il report porta il corpo dell errore, non «createUser failed»', async () => {
    const r = await backfillParentsAuth(adminBackfill(SENZA_MESSAGGIO), { dryRun: false })

    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].error).toContain('weak_password')
    expect(r.errors[0].error).not.toBe('createUser failed')
  })

  it('e lascia una riga di log: un report letto da nessuno non è osservabilità', async () => {
    await backfillParentsAuth(adminBackfill(SENZA_MESSAGGIO), { dryRun: false })

    const riga = logDi('creazione-account-non-riuscita')
    expect(riga).toBeTruthy()
    expect(riga![1]).toBe('error')
  })
})
