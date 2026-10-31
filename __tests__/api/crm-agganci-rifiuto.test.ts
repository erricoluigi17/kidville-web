import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

/**
 * CRM della segreteria · Compito 4.2 — l'aggancio del RIFIUTO di una domanda.
 *
 * `PATCH /api/admin/iscrizioni` con `action: 'reject'`: se la domanda era collegata a un bambino del CRM,
 * quel bambino va verificato (`segnalaDomandaRespinta`). Qui si prova SOLO l'aggancio della route (la
 * libreria ha i suoi test in `__tests__/lib/crm/collegamento.test.ts`):
 *   · il rifiuto chiama il CRM, con l'id della domanda, DOPO aver scritto il rifiuto e la sua traccia;
 *   · un rifiuto che non si applica (domanda non più in attesa) NON lo chiama;
 *   · l'importazione (approvazione) NON lo chiama;
 *   · un CRM che lancia non trasforma il rifiuto, già scritto, in un 500.
 * Lo scaffale dei finti è quello di `iscrizioni-rifiuto-solo-in-attesa.test.ts`.
 */

const ID = '5c5c5c5c-5c5c-45c5-85c5-5c5c5c5c5c5c'

const h = vi.hoisted(() => ({
  riga: {} as Record<string, unknown>,
  /** L'ordine in cui le cose sono successe: è «DOPO il rifiuto» la cosa da provare. */
  sequenza: [] as string[],
  respinta: null as unknown as Mock<(...a: unknown[]) => Promise<void>>,
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: vi.fn().mockResolvedValue({ user: { id: 'segreteria-finta', role: 'segreteria', scuola_id: 'sede-finta' } }),
}))
vi.mock('@/lib/audit/scrittura', () => ({
  logScrittura: async () => {
    h.sequenza.push('logScrittura')
  },
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => ({ ok: true }) }))
vi.mock('@/lib/email/send', () => ({
  sendEmail: async () => true,
  sendEmailDetailed: async () => ({ ok: true, error: null }),
  credentialsEmailBody: () => 'x',
}))
vi.mock('@/lib/auth/parent-identity', () => ({
  ensureParentIdentity: async () => ({ ok: true, authUserId: 'auth-x', password: null, createdAuth: false, reason: null, message: '' }),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: async () => ({ creati: 0 }) }))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => ['sede-finta'],
  resolveScuolaScrittura: async () => ({ scuolaId: 'sede-finta' }),
  scuoleDiUtente: async () => ['sede-finta'],
}))
vi.mock('@/lib/logging/logger', async (orig) => {
  const m = await orig<typeof import('@/lib/logging/logger')>()
  return {
    ...m,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
      h.eventi.push({ evento, livello, campi })
    },
  }
})
vi.mock('@/lib/crm/collegamento', () => ({
  segnalaDomandaRespinta: (...a: unknown[]) => h.respinta(...a),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'u' }, error: null }) }) },
    from(table: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.limit = () => b
      b.order = async () => ({ data: [], error: null })
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
      b.maybeSingle = async () =>
        table === 'enrollment_submissions' ? { data: { ...h.riga }, error: null } : { data: null, error: null }
      b.single = async () => ({ data: null, error: null })
      b.update = (patch: Record<string, unknown>) => {
        const filtri: Record<string, unknown> = {}
        const u: Record<string, unknown> = {}
        u.eq = (colonna: string, valore: unknown) => {
          filtri[colonna] = valore
          return u
        }
        u.select = () => u
        const esegui = () => {
          if (!Object.entries(filtri).every(([c, v]) => h.riga[c] === v)) return null
          Object.assign(h.riga, patch)
          h.sequenza.push('rifiuto-scritto')
          return { ...h.riga }
        }
        u.maybeSingle = async () => ({ data: esegui(), error: null })
        return u
      }
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/admin/iscrizioni/route'

const chiama = (action: 'reject' | 'import') =>
  PATCH(
    new Request('http://localhost/api/admin/iscrizioni', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: ID, action }),
    }) as never,
  )

function domandaIn(status: string): Record<string, unknown> {
  return { id: ID, scuola_id: 'sede-finta', status, imported_at: null, consents_log: [], data: { children: [], adults: [] } }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.sequenza = []
  h.eventi = []
  h.respinta = vi.fn(async () => {
    h.sequenza.push('crm')
  })
})

describe('PATCH /api/admin/iscrizioni → segnalaDomandaRespinta', () => {
  it('reject → segnalaDomandaRespinta chiamata con l’id della domanda, DOPO il rifiuto e la sua traccia', async () => {
    h.riga = domandaIn('pending')
    const res = await chiama('reject')
    expect(res.status).toBe(200)
    expect(h.respinta).toHaveBeenCalledTimes(1)
    expect(h.respinta.mock.calls[0][1]).toBe(ID)
    expect(h.sequenza).toEqual(['rifiuto-scritto', 'logScrittura', 'crm'])
  })

  it('un rifiuto che non si applica (domanda già approvata o già respinta) NON chiama il CRM', async () => {
    for (const stato of ['approved', 'rejected']) {
      h.respinta.mockClear()
      h.riga = domandaIn(stato)
      expect((await chiama('reject')).status).toBe(409)
      expect(h.respinta, stato).not.toHaveBeenCalled()
    }
  })

  it('approve (import) → segnalaDomandaRespinta NON è chiamata', async () => {
    h.riga = domandaIn('pending')
    await chiama('import')
    expect(h.respinta).not.toHaveBeenCalled()
  })

  it('un CRM che lancia non trasforma il rifiuto, già scritto, in un errore: 200 e riga di log', async () => {
    h.riga = domandaIn('pending')
    h.respinta = vi.fn(async () => {
      throw Object.assign(new Error('giù'), { code: 'XX000' })
    })
    const res = await chiama('reject')
    expect(res.status).toBe(200)
    expect(h.riga.status).toBe('rejected')
    const riga = h.eventi.find((e) => e.evento === 'crm' && e.campi.esito === 'segnala-respinta-eccezione')
    expect(riga).toMatchObject({ livello: 'error', campi: { entita_id: ID } })
  })
})
