import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))

import { applySidiRecords } from '@/lib/sidi/import-apply'
import type { SidiDomandaRecord } from '@/lib/sidi/zip-parser'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'

interface Opts {
  alunniByNumero?: Record<string, { id: string }>
  alunniByCF?: Record<string, { id: string }>
  parentsByCF?: Record<string, { id: string }>
}
function makeSupabase(opts: Opts) {
  const captures = { inserts: [] as { table: string; row: Record<string, unknown> }[], updates: [] as { table: string; payload: Record<string, unknown> }[], upserts: [] as { table: string; payload: Record<string, unknown> }[] }
  const client = {
    from(table: string) {
      const filters: [string, unknown][] = []
      const q: Record<string, unknown> = {}
      q.select = () => q
      q.eq = (col: string, val: unknown) => { filters.push([col, val]); return q }
      q.maybeSingle = async () => {
        if (table === 'alunni') {
          const num = filters.find((f) => f[0] === 'numero_domanda_sidi')?.[1] as string | undefined
          if (num !== undefined) return { data: opts.alunniByNumero?.[num] ?? null, error: null }
          const cf = filters.find((f) => f[0] === 'codice_fiscale' || f[0] === 'fiscal_code')?.[1] as string | undefined
          if (cf !== undefined) return { data: opts.alunniByCF?.[cf] ?? null, error: null }
          return { data: null, error: null }
        }
        if (table === 'parents') {
          const cf = filters.find((f) => f[0] === 'fiscal_code')?.[1] as string | undefined
          return { data: opts.parentsByCF?.[cf ?? ''] ?? null, error: null }
        }
        return { data: null, error: null }
      }
      q.insert = (row: Record<string, unknown>) => { captures.inserts.push({ table, row }); return { select: () => ({ single: async () => ({ data: { id: `${table}-new` }, error: null }) }) } }
      q.update = (payload: Record<string, unknown>) => { captures.updates.push({ table, payload }); return { eq: async () => ({ data: null, error: null }) } }
      q.upsert = async (payload: Record<string, unknown>) => { captures.upserts.push({ table, payload }); return { data: null, error: null } }
      return q
    },
  }
  return { client: client as unknown as SupabaseClient, captures }
}

const rec = (over: Partial<SidiDomandaRecord> = {}): SidiDomandaRecord => ({
  numero_domanda: '123',
  alunno: { nome: 'Marco', cognome: 'Rossi', codice_fiscale: 'CFAL1' },
  genitori: [],
  classe_richiesta: null,
  ...over,
})
const attore: AppUser = { id: 'seg1', role: 'segreteria', scuola_id: 'sc1' }

beforeEach(() => vi.clearAllMocks())

describe('applySidiRecords', () => {
  it('match su numero domanda: aggiorna, NON crea un alunno', async () => {
    const { client, captures } = makeSupabase({ alunniByNumero: { '123': { id: 'al-x' } } })
    const res = await applySidiRecords(client, [rec()], 'sc1', attore)
    expect(res.matched).toBe(1)
    expect(res.creati).toBe(0)
    expect(captures.inserts.filter((i) => i.table === 'alunni')).toHaveLength(0)
  })

  it('fallback su CF: stampa numero_domanda_sidi sull alunno esistente', async () => {
    const { client, captures } = makeSupabase({ alunniByCF: { CFAL1: { id: 'al-cf' } } })
    const res = await applySidiRecords(client, [rec()], 'sc1', attore)
    expect(res.aggiornati).toBe(1)
    const upd = captures.updates.find((u) => u.table === 'alunni')
    expect(upd?.payload.numero_domanda_sidi).toBe('123')
    expect(captures.inserts.filter((i) => i.table === 'alunni')).toHaveLength(0)
  })

  it('nessun match: crea il nuovo alunno con numero_domanda_sidi', async () => {
    const { client, captures } = makeSupabase({})
    const res = await applySidiRecords(client, [rec()], 'sc1', attore)
    expect(res.creati).toBe(1)
    const ins = captures.inserts.find((i) => i.table === 'alunni')
    expect(ins?.row.numero_domanda_sidi).toBe('123')
    expect(ins?.row.stato).toBe('iscritto')
  })

  it('genitore con CF già presente → linka, non crea parent', async () => {
    const { client, captures } = makeSupabase({ alunniByNumero: { '123': { id: 'al-x' } }, parentsByCF: { PCF1: { id: 'par-1' } } })
    await applySidiRecords(client, [rec({ genitori: [{ codice_fiscale: 'PCF1', nome: 'Luigi', relazione: 'padre' }] })], 'sc1', attore)
    expect(captures.inserts.filter((i) => i.table === 'parents')).toHaveLength(0)
    const link = captures.upserts.find((u) => u.table === 'student_parents')
    expect(link?.payload.parent_id).toBe('par-1')
  })

  it('idempotente: ri-applicare lo stesso batch non crea duplicati', async () => {
    const { client, captures } = makeSupabase({ alunniByNumero: { '123': { id: 'al-x' } } })
    await applySidiRecords(client, [rec()], 'sc1', attore)
    await applySidiRecords(client, [rec()], 'sc1', attore)
    expect(captures.inserts.filter((i) => i.table === 'alunni')).toHaveLength(0)
  })
})
