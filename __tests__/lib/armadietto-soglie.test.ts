import { describe, it, expect, vi } from 'vitest'
import { soglieMateriali } from '@/lib/armadietto/soglie'

function admin(rows: unknown[] | null, error: unknown = null) {
  return {
    from: vi.fn(() => {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'in']) qb[m] = () => qb
      qb.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error }).then(res)
      return qb
    }),
  } as never
}

describe('soglieMateriali', () => {
  it('locker_config vuota → le soglie di MATERIALI_DEFAULT', async () => {
    const s = await soglieMateriali(admin([]), 'sec1')
    expect(s.Pannolini).toEqual({ allerta: 5, emergenza: 2 })
    expect(s.Cambio).toEqual({ allerta: 2, emergenza: 1 })
  })

  it('locker_config popolata → vincono le sue righe, non i default', async () => {
    const s = await soglieMateriali(admin([
      { nome: 'Pannolini', livello_allerta: 12, livello_emergenza: 6, attivo: true },
    ]), 'sec1')
    expect(s.Pannolini).toEqual({ allerta: 12, emergenza: 6 })
    // e i default NON si mescolano: una sezione configurata traccia solo cio'
    // che ha configurato, altrimenti togliere un materiale non lo toglierebbe
    expect(s.Cambio).toBeUndefined()
  })

  it('lettura fallita → default, e lascia un warn', async () => {
    const s = await soglieMateriali(admin(null, { code: 'PGRST205', message: 'x' }), 'sec1')
    expect(s.Pannolini).toEqual({ allerta: 5, emergenza: 2 })
  })

  it('senza sezione → default', async () => {
    const s = await soglieMateriali(admin([]), null)
    expect(Object.keys(s)).toHaveLength(4)
  })
})
