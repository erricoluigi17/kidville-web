import { describe, it, expect } from 'vitest'
import {
  alunnoSospeso,
  assertAlunnoNonSospeso,
  assertGenitoreNonSospeso,
} from '@/lib/pagamenti/sospensione'

// Fake supabase minimale: programma le risposte per (tabella).
function fakeSupabase(responses: Record<string, unknown>) {
  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        maybeSingle: async () => ({ data: responses[table] ?? null, error: null }),
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: responses[table] ?? [], error: null }),
      }
      return builder
    },
  } as never
}

describe('alunnoSospeso', () => {
  it('true se la riga alunno ha sospeso=true', async () => {
    expect(await alunnoSospeso(fakeSupabase({ alunni: { sospeso: true } }), 'a1')).toBe(true)
  })
  it('false se sospeso=false o riga assente', async () => {
    expect(await alunnoSospeso(fakeSupabase({ alunni: { sospeso: false } }), 'a1')).toBe(false)
    expect(await alunnoSospeso(fakeSupabase({}), 'a1')).toBe(false)
  })
})

describe('assertAlunnoNonSospeso', () => {
  it('null se non sospeso', async () => {
    expect(await assertAlunnoNonSospeso(fakeSupabase({ alunni: { sospeso: false } }), 'a1')).toBeNull()
  })
  it('403 con motivo account_sospeso se sospeso', async () => {
    const res = await assertAlunnoNonSospeso(fakeSupabase({ alunni: { sospeso: true } }), 'a1')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    const body = await res!.json()
    expect(body.motivo).toBe('account_sospeso')
  })
})

describe('assertGenitoreNonSospeso', () => {
  // Contabilità v2: i figli si risolvono via unione legami (legame_genitori_alunni
  // → alunno_id) e lo stato sospeso si legge da `alunni` (query separata).
  it('null se nessun figlio sospeso', async () => {
    const sb = fakeSupabase({
      legame_genitori_alunni: [{ alunno_id: 'a1' }, { alunno_id: 'a2' }],
      alunni: [{ id: 'a1', sospeso: false }, { id: 'a2', sospeso: false }],
    })
    expect(await assertGenitoreNonSospeso(sb, 'g1')).toBeNull()
  })
  it('403 se almeno un figlio è sospeso', async () => {
    const sb = fakeSupabase({
      legame_genitori_alunni: [{ alunno_id: 'a1' }, { alunno_id: 'a2' }],
      alunni: [{ id: 'a1', sospeso: false }, { id: 'a2', sospeso: true }],
    })
    const res = await assertGenitoreNonSospeso(sb, 'g1')
    expect(res!.status).toBe(403)
  })
})
