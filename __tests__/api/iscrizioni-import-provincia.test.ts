import { describe, it, expect, vi, beforeEach } from 'vitest'

// Bug prod (Postgres 22001 "value too long for type character varying(2)"):
// parents.residence_province / alunni.residence_province sono varchar(2) e l'import
// inviava la provincia PER ESTESO. Il vecchio codice degradava il fallimento a
// `warnings` e marcava comunque l'invio 'approved' → la UI diceva "Importata" ma in
// anagrafiche non c'era NULLA. Questi test bloccano quella regressione:
//  (a) 22001 sull'insert dei parents → success:false E l'invio RESTA pending
//      (l'UPDATE a 'approved' non parte);
//  (b) provincia per esteso riconoscibile ("Caserta") → normalizzata a sigla (CE);
//  (c) import completo → 'approved' (success:true);
//  (d) provincia NON riconoscibile → success:false PRIMA di qualsiasi scrittura.

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  sub: null as Record<string, unknown> | null,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  // Inietta un errore su un insert per tabella (null = nessun errore).
  insertError: null as null | ((table: string) => { code?: string; message?: string } | null),
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
      b.maybeSingle = async () => {
        if (table === 'enrollment_submissions') return { data: h.sub, error: null }
        return { data: null, error: null } // no dedup: forza la creazione
      }
      b.single = async () => {
        if (table === 'enrollment_submissions') return { data: h.sub, error: null }
        return { data: null, error: null }
      }
      b.insert = (row: Record<string, unknown>) => {
        h.inserts.push({ table, row })
        const err = h.insertError ? h.insertError(table) : null
        return {
          select: () => ({
            single: async () =>
              err
                ? { data: null, error: err }
                : { data: { id: `${table}-new`, nome: (row?.nome as string) ?? 'X' }, error: null },
          }),
        }
      }
      b.update = (row: Record<string, unknown>) => {
        h.updates.push({ table, row })
        return { eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'x' }, error: null }) }) }) }
      }
      b.upsert = async () => ({ data: null, error: null })
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

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []
  h.updates = []
  h.insertError = null
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
})

const importa = (body: Record<string, unknown> = {}) =>
  PATCH(req({ id: ID, action: 'import', assignments: { '0': 'Girasoli' }, referenteIndex: 0, ...body }) as never)

describe('iscrizioni import — province + semantica esito', () => {
  it('(a) 22001 sull\'insert parents → success:false e invio NON marcato approved', async () => {
    h.sub = {
      id: ID,
      scuola_id: 'sc-1',
      data: {
        children: [{ nome: 'Bimbo', codice_fiscale: 'CFC1' }],
        adults: [{ first_name: 'Anna', fiscal_code: 'CF1' }], // niente provincia → passa il pre-flight
      },
    }
    h.insertError = (table) =>
      table === 'parents' ? { code: '22001', message: 'value too long for type character varying(2)' } : null

    const res = await importa()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(Array.isArray(json.errors)).toBe(true)
    expect(json.errors.some((e: { dove: string }) => e.dove === 'Adulto 1')).toBe(true)
    // Il cuore del bug: l'invio NON deve passare ad 'approved'.
    expect(h.updates.some((u) => u.row?.status === 'approved')).toBe(false)
  })

  it('(b) provincia per esteso riconoscibile → normalizzata a sigla e import ok', async () => {
    h.sub = {
      id: ID,
      scuola_id: 'sc-1',
      data: {
        children: [{ nome: 'Luca', cognome: 'Rossi', codice_fiscale: 'CFCH1', residence_province: 'Napoli', birth_province: 'Caserta' }],
        adults: [{ first_name: 'Mario', last_name: 'Rossi', fiscal_code: 'CFAD1', residence_province: 'Caserta', birth_province: 'NA' }],
      },
    }
    const res = await importa()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)

    const parentRow = h.inserts.find((i) => i.table === 'parents')?.row
    expect(parentRow?.residence_province).toBe('CE')
    const childRow = h.inserts.find((i) => i.table === 'alunni')?.row
    expect(childRow?.residence_province).toBe('NA')
    expect(childRow?.birth_province).toBe('CE')

    expect(h.updates.some((u) => u.table === 'enrollment_submissions' && u.row?.status === 'approved')).toBe(true)
  })

  it('(c) import completo → approved (success:true)', async () => {
    h.sub = {
      id: ID,
      scuola_id: 'sc-1',
      data: {
        children: [{ nome: 'Bimbo', codice_fiscale: 'CFC1' }],
        adults: [{ first_name: 'Anna', fiscal_code: 'CF1' }],
      },
    }
    const res = await importa()
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(h.updates.some((u) => u.row?.status === 'approved')).toBe(true)
  })

  it('(d) provincia NON riconoscibile → success:false PRIMA di ogni scrittura', async () => {
    h.sub = {
      id: ID,
      scuola_id: 'sc-1',
      data: {
        children: [{ nome: 'Bimbo', codice_fiscale: 'CFC1' }],
        adults: [{ first_name: 'Anna', fiscal_code: 'CF1', residence_province: 'Provincia Inesistente' }],
      },
    }
    const res = await importa()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.errors.some((e: { messaggio: string }) => /provincia di residenza/i.test(e.messaggio))).toBe(true)
    // Nessuna scrittura: il pre-flight blocca prima degli insert.
    expect(h.inserts.length).toBe(0)
    expect(h.updates.some((u) => u.row?.status === 'approved')).toBe(false)
  })
})
