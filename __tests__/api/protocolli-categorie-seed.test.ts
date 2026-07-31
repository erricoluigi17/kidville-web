import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// W2-M — Titolario protocolli: il seed lazy non ingoia più né l'errore né il
// successo (rilievo R122 dell'audit 2026-07-31).
//
// L'INSERT dei 7 default era chiuso da `.then(() => undefined, () => undefined)`,
// che scarta entrambi gli esiti — e PostgREST NON lancia: ritorna `{ error }`.
// Se il seed falliva (RLS, unique, schema) la route rileggeva, trovava ancora
// vuoto e rispondeva `{ success: true, data: [] }`: quella sede avrebbe visto un
// titolario vuoto PER SEMPRE, e in `app_log` non ci sarebbe stata una riga che
// dicesse perché. Aversa e Cesa hanno 0 categorie: quel ramo deve ancora essere
// percorso per la prima volta.
//
// Il seed è anche l'unico auto-provisioning per sede del progetto: è un evento
// che va visto ANCHE quando funziona (AGENTS.md §5).
// =============================================================================

const ID_ADMIN = 'd0000000-0000-4000-8000-00000000ad00'
const ID_SEGRETERIA = 'd0000000-0000-4000-8000-0000000005e6'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  /** Errore restituito dal solo INSERT su `protocolli_categorie` (null = seed ok). */
  erroreSeed: null as { code?: string; message: string } | null,
  /** Righe che «un'altra transazione» ha scritto mentre il seed falliva. */
  dopoSeedFallito: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: () => {},
  logOk: () => {},
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase: crea } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => {
      const vero = crea(h.db, h.tabelle, { scritture: h.scritture })
      if (!h.erroreSeed) return vero
      // Solo l'INSERT sul titolario fallisce: la lettura deve restare buona,
      // altrimenti si proverebbe il ramo «schema non migrato», non il seed.
      return new Proxy(vero, {
        get: (t, p, r) => {
          if (p !== 'from') return Reflect.get(t, p, r)
          return (tab: string) => {
            const b = (t as SupabaseClient).from(tab) as unknown as Record<string, unknown>
            if (tab !== 'protocolli_categorie') return b
            return new Proxy(b, {
              get: (bt, bp, br) =>
                bp === 'insert'
                  ? () => {
                      h.db.protocolli_categorie = [
                        ...(h.db.protocolli_categorie ?? []),
                        ...h.dopoSeedFallito,
                      ]
                      return {
                        then: (ok: (v: unknown) => unknown) =>
                          Promise.resolve({ data: null, error: h.erroreSeed }).then(ok),
                      }
                    }
                  : Reflect.get(bt, bp, br),
            })
          }
        },
      })
    },
  }
})

import { GET } from '@/app/api/admin/protocolli/categorie/route'

const dbBase = (): DBFinto => ({
  utenti_scuole: [
    { utente_id: ID_ADMIN, scuola_id: SEDE_A },
    { utente_id: ID_ADMIN, scuola_id: SEDE_B },
  ],
  protocolli_categorie: [],
})

function getReq(qs = ''): NextRequest {
  return {
    url: `http://localhost/api/admin/protocolli/categorie${qs ? `?${qs}` : ''}`,
    method: 'GET',
    headers: new Headers(),
    cookies: { get: () => undefined },
  } as unknown as NextRequest
}

const scrittureSu = (tabella: string) => h.scritture.filter((s) => s.tabella === tabella)
/** I log emessi, ridotti a `[gruppo, livello, esito]`: è ciò che si asserisce. */
const logs = () =>
  h.logEvento.mock.calls.map((c) => [c[0], c[1], (c[2] as { esito?: string })?.esito])

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.erroreSeed = null
  h.dopoSeedFallito = []
  h.requireStaff.mockResolvedValue({
    user: { id: ID_SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A },
  })
})

describe('GET /api/admin/protocolli/categorie — seed lazy del titolario', () => {
  it('sede senza titolario: seed riuscito ⇒ 200 con i 7 default nella SUA sede', async () => {
    const res = await GET(getReq())

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(7)
    const seed = scrittureSu('protocolli_categorie')
    expect(seed).toHaveLength(1)
    expect(seed[0].valori).toHaveLength(7)
    expect(new Set(seed[0].valori.map((r) => r.scuola_id))).toEqual(new Set([SEDE_A]))
  })

  it('seed riuscito: è un provisioning, quindi si logga anche il SUCCESSO', async () => {
    await GET(getReq())

    expect(logs()).toContainEqual(['protocolli', 'info', 'seed-eseguito'])
  })

  it('seed FALLITO ⇒ 500 (mai un titolario vuoto silenzioso) e log `error`', async () => {
    h.erroreSeed = { code: '42501', message: 'new row violates row-level security policy' }

    const res = await GET(getReq())

    expect(res.status).toBe(500)
    expect(logs()).toContainEqual(['protocolli', 'error', 'seed-fallito'])
    expect(h.db.protocolli_categorie).toEqual([])
  })

  it('seed in corsa con un\'altra scheda (23505) ⇒ 200 con le righe dell\'altra, log `info`', async () => {
    h.erroreSeed = { code: '23505', message: 'duplicate key value violates unique constraint' }
    h.dopoSeedFallito = [
      { id: 'cat-1', scuola_id: SEDE_A, nome: 'Alunni e famiglie', ordine: 1, attivo: true },
    ]

    const res = await GET(getReq())

    expect(res.status).toBe(200)
    expect((await res.json()).data).toHaveLength(1)
    expect(logs()).toContainEqual(['protocolli', 'info', 'seed-concorrente'])
  })

  it('titolario già popolato ⇒ 200 senza nessuna scrittura', async () => {
    h.db.protocolli_categorie = [
      { id: 'cat-1', scuola_id: SEDE_A, nome: 'Personale', ordine: 2, attivo: true },
    ]

    const res = await GET(getReq())

    expect(res.status).toBe(200)
    expect((await res.json()).data).toHaveLength(1)
    expect(scrittureSu('protocolli_categorie')).toEqual([])
  })

  it('admin multi-sede senza `scuola_id` ⇒ 400 e nessun titolario seminato a caso', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A } })

    const res = await GET(getReq())

    expect(res.status).toBe(400)
    expect(scrittureSu('protocolli_categorie')).toEqual([])
    expect(h.db.protocolli_categorie).toEqual([])
  })
})
