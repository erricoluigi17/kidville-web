import { describe, it, expect, vi, beforeEach } from 'vitest'

// A5 — IDOR sull'invio + alunno archiviato nella sede sbagliata, in silenzio.
//
// L'import caricava `enrollment_submissions` PER ID, senza alcun filtro di scope.
// Poi passava `sub.scuola_id` come "preferita" a `resolveScuolaScrittura`: per una
// segreteria quella sede NON è accessibile (`scuoleDiUtente` torna solo
// `utenti.scuola_id`), quindi si cadeva su `accessibili.length === 1` e il bambino
// finiva nella sede DELL'OPERATORE. Con una sola sede il bug era invisibile; con
// Giugliano+Aversa+Cesa una segreteria che apre una domanda di Aversa si porta il
// bambino a Giugliano, senza il minimo errore.
//
// Qui si blocca: domanda fuori dalle sedi accessibili → 403 e ZERO scritture.

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  scuoleDiUtente: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
  sub: null as Record<string, unknown> | null,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  upserts: [] as { table: string; payload: Record<string, unknown> }[],
  sezioni: [] as { name: string }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/email/send', () => ({
  sendEmail: async () => true,
  sendEmailDetailed: async () => ({ ok: true, error: null }),
  credentialsEmailBody: () => 'x',
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => ({ ok: true }) }))
vi.mock('@/lib/auth/parent-identity', () => ({
  ensureParentIdentity: async () => ({ ok: true, authUserId: 'auth-x', password: null, createdAuth: false, reason: null, message: '' }),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: async () => ({ creati: 0 }) }))

// `restringiSedi` resta VERA: `?scuola_id=` deve intersecare davvero le sedi
// attive, e un finto che dicesse sempre di sì non proverebbe nessun diniego.
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => ['sc-giugliano'],
  resolveScuolaScrittura: (...a: unknown[]) => h.resolveScuolaScrittura(...a),
  scuoleDiUtente: (...a: unknown[]) => h.scuoleDiUtente(...a),
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
      // Le letture "a lista" (es. sections) si attendono direttamente sul builder.
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(table === 'sections' ? { data: h.sezioni, error: null } : { data: [], error: null }).then(res)
      b.maybeSingle = async () => {
        if (table === 'enrollment_submissions') return { data: h.sub, error: null }
        return { data: null, error: null }
      }
      b.single = async () => ({ data: null, error: null })
      b.insert = (row: Record<string, unknown>) => {
        h.inserts.push({ table, row })
        return { select: () => ({ single: async () => ({ data: { id: `${table}-new`, nome: row?.nome ?? 'X' }, error: null }) }) }
      }
      b.update = (row: Record<string, unknown>) => {
        h.updates.push({ table, row })
        return { eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'x', scuola_id: h.sub?.scuola_id, data: h.sub?.data }, error: null }) }) }) }
      }
      b.upsert = async (payload: Record<string, unknown>) => {
        h.upserts.push({ table, payload })
        return { data: null, error: null }
      }
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/admin/iscrizioni/route'

const ID = '5b5b5b5b-5b5b-45b5-85b5-5b5b5b5b5b5b'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/iscrizioni', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const importa = (body: Record<string, unknown> = {}) =>
  PATCH(req({ id: ID, action: 'import', assignments: { '0': '3 ANNI' }, referenteIndex: 0, ...body }) as never)

const rifiuta = () => PATCH(req({ id: ID, action: 'reject' }) as never)

const scritture = () => h.inserts.length + h.updates.length + h.upserts.length

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []
  h.updates = []
  h.upserts = []
  h.eventi = []
  h.sezioni = [{ name: '3 ANNI' }]
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-giugliano' } })
  h.scuoleDiUtente.mockResolvedValue(['sc-giugliano'])
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: 'sc-giugliano' })
  h.sub = {
    id: ID,
    scuola_id: 'sc-aversa', // domanda di UN'ALTRA sede
    data: {
      children: [{ nome: 'Bimbo', codice_fiscale: 'CFC1' }],
      adults: [{ first_name: 'Anna', fiscal_code: 'CF1', email: 'ref@example.test' }],
    },
  }
})

describe('import iscrizioni — gate di scope sulla sede dell\'invio', () => {
  it('import di una domanda di un\'altra sede → 403 e ZERO scritture', async () => {
    const res = await importa()
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error).toMatch(/altra sede/i)
    expect(scritture()).toBe(0)
  })

  it('reject di una domanda di un\'altra sede → 403 e nessun update', async () => {
    const res = await rifiuta()
    expect(res.status).toBe(403)
    expect(h.updates).toHaveLength(0)
  })

  it('domanda della PROPRIA sede → l\'import prosegue', async () => {
    h.sub = { ...(h.sub as Record<string, unknown>), scuola_id: 'sc-giugliano' }
    const res = await importa()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
  })

  it('admin multi-sede: la domanda di Aversa è accessibile → nessun 403', async () => {
    h.scuoleDiUtente.mockResolvedValue(['sc-giugliano', 'sc-aversa'])
    h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: 'sc-aversa' })
    h.sezioni = [{ name: '3 ANNI' }]
    const res = await importa()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
  })

  it('sede accessibile ma di scrittura DIVERSA da quella dell\'invio → warn, non blocca', async () => {
    h.scuoleDiUtente.mockResolvedValue(['sc-giugliano', 'sc-aversa'])
    h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: 'sc-giugliano' }) // ≠ sc-aversa
    const res = await importa()
    expect(res.status).toBe(200)
    const warn = h.eventi.find((e) => e.campi?.esito === 'import-sede-diversa-da-invio')
    expect(warn).toBeDefined()
    expect(warn?.evento).toBe('multi_sede')
    expect(warn?.livello).toBe('warn')
  })

  it('invio storico SENZA scuola_id → nessun blocco (comportamento invariato)', async () => {
    h.sub = { id: ID, scuola_id: null, data: (h.sub as { data: unknown }).data }
    const res = await importa()
    expect(res.status).toBe(200)
  })

  it('il log del 403 non contiene dati personali (solo uuid/esito)', async () => {
    await importa()
    const negato = h.eventi.find((e) => e.campi?.esito === 'invio-di-altra-sede')
    expect(negato).toBeDefined()
    const chiavi = Object.keys(negato?.campi ?? {})
    expect(chiavi).not.toContain('nome')
    expect(chiavi).not.toContain('email')
  })
})
