import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fix bug "genitore non salvato": l'helper condiviso deve normalizzare il CF
// vuoto a null (niente violazione UNIQUE), preservare la cittadinanza reale per
// i genitori (col ruolo solo per lo staff), mappare civico/provincia e creare il
// legame student_parents.

const h = vi.hoisted(() => ({
  logScrittura: vi.fn(),
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  upserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  existing: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))

function makeClient() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: h.existing, error: null })
      b.insert = (row: Record<string, unknown>) => {
        h.inserts.push({ table, row })
        return { select: () => ({ single: async () => ({ data: { id: `${table}-new` }, error: null }) }) }
      }
      b.upsert = (row: Record<string, unknown>) => {
        h.upserts.push({ table, row })
        return Promise.resolve({ data: null, error: null })
      }
      return b
    },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = () => makeClient() as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const actor = { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } as any

import { linkOrCreateParent } from '@/lib/anagrafiche/parents'

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []; h.upserts = []; h.existing = null
})

describe('linkOrCreateParent', () => {
  const parentRow = () => h.inserts.find(i => i.table === 'parents')!.row

  it('CF vuoto → null e cittadinanza reale per il genitore', async () => {
    await linkOrCreateParent(client(), actor, {
      studentId: 's1',
      payload: { first_name: 'Anna', last_name: 'Bianchi', role: 'mother', fiscal_code: '', citizenship: 'Italiana' },
    })
    const rec = parentRow()
    expect(rec.fiscal_code).toBeNull()
    expect(rec.citizenship).toBe('Italiana')
  })

  it('ruolo staff → citizenship = ruolo (workaround tab Staff)', async () => {
    await linkOrCreateParent(client(), actor, {
      studentId: null,
      payload: { first_name: 'Ed', last_name: 'Uca', role: 'educator', citizenship: 'Italiana' },
    })
    expect(parentRow().citizenship).toBe('educator')
  })

  it('mappa civico/provincia e crea il legame student_parents', async () => {
    await linkOrCreateParent(client(), actor, {
      studentId: 's1',
      payload: { first_name: 'A', last_name: 'B', role: 'father', address: 'Via Roma', civico: '12', residence_province: 'na', birth_place: 'Napoli' },
    })
    const rec = parentRow()
    expect(rec.residence_address).toBe('Via Roma')
    expect(rec.residence_street_number).toBe('12')
    expect(rec.residence_province).toBe('NA')
    expect(rec.birth_city).toBe('Napoli')
    const link = h.upserts.find(u => u.table === 'student_parents')
    expect(link).toBeTruthy()
    expect(link!.row.student_id).toBe('s1')
    expect(link!.row.is_primary).toBe(true)
  })

  it('dedup per CF esistente: non crea un nuovo genitore', async () => {
    h.existing = { id: 'p-esistente' }
    const out = await linkOrCreateParent(client(), actor, {
      studentId: 's1',
      payload: { first_name: 'A', last_name: 'B', role: 'mother', fiscal_code: 'RSSMRA80A01H501Z' },
    })
    expect(out.created).toBe(false)
    expect(out.parentId).toBe('p-esistente')
    expect(h.inserts.find(i => i.table === 'parents')).toBeUndefined()
  })
})
