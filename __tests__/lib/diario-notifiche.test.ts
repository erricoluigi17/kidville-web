import { describe, it, expect, vi, beforeEach } from 'vitest'
import { enqueueDiarioGenitori } from '@/lib/primaria/notifiche'

// P4/DL-040: la notifica diario al genitore ha buffer 10' (= finestra di modifica)
// con DEBOUNCE: i salvataggi successivi entro 10' rimuovono la notifica pending e
// ne ri-accodano una sola, così il genitore riceve un'unica notifica con lo stato finale.

const h = vi.hoisted(() => ({
  deletes: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
  legami: [{ genitore_id: 'p1', alunno_id: 'a1' }] as Array<Record<string, unknown>>,
}))

function makeClient() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {}
      // delete().eq().eq().is()  → debounce
      b.delete = () => {
        const f: Record<string, unknown> = { table }
        const d: Record<string, unknown> = {}
        d.eq = (col: string, val: unknown) => { f[col] = val; return d }
        d.is = async (col: string, val: unknown) => { f[col] = val; h.deletes.push(f); return { error: null } }
        return d
      }
      // select().in()  → legami
      b.select = () => ({ in: async () => ({ data: h.legami, error: null }) })
      // insert(rows)   → notifiche
      b.insert = async (rows: Record<string, unknown>[]) => { h.inserts.push(...rows); return { error: null } }
      return b
    },
  }
}

beforeEach(() => { h.deletes = []; h.inserts = []; h.legami = [{ genitore_id: 'p1', alunno_id: 'a1' }] })

describe('enqueueDiarioGenitori', () => {
  it('debounce: rimuove le notifiche diario pending del figlio prima di accodare', async () => {
    await enqueueDiarioGenitori(makeClient() as never, { alunnoId: 'a1', nome: 'Sofia' })
    expect(h.deletes).toHaveLength(1)
    expect(h.deletes[0]).toMatchObject({ entita_tipo: 'diario', entita_id: 'a1', push_inviata_il: null })
  })

  it('accoda 1 notifica al genitore con entita_id=alunno e buffer 10′', async () => {
    const before = Date.now()
    await enqueueDiarioGenitori(makeClient() as never, { alunnoId: 'a1', nome: 'Sofia' })
    expect(h.inserts).toHaveLength(1)
    const row = h.inserts[0]
    expect(row).toMatchObject({ utente_id: 'p1', tipo: 'diario', entita_tipo: 'diario', entita_id: 'a1' })
    const programmato = new Date(row.invio_programmato_il as string).getTime()
    expect(programmato).toBeGreaterThanOrEqual(before + 9 * 60_000)
    expect(programmato).toBeLessThanOrEqual(before + 11 * 60_000)
  })

  it('nessun genitore collegato → nessun insert (ma debounce comunque tentato)', async () => {
    h.legami = []
    await enqueueDiarioGenitori(makeClient() as never, { alunnoId: 'a1', nome: 'Sofia' })
    expect(h.inserts).toHaveLength(0)
    expect(h.deletes).toHaveLength(1)
  })
})
