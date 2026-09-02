import { describe, it, expect, vi } from 'vitest'
import { stockDiAlunno } from '@/lib/armadietto/stock'

function admin(rows: unknown[] | null, error: unknown = null) {
  return {
    from: vi.fn(() => ({
      select: () => ({ eq: () => Promise.resolve({ data: rows, error }) }),
    })),
  } as never
}

describe('stockDiAlunno', () => {
  it('somma i carichi e sottrae i consumi', async () => {
    const s = await stockDiAlunno(admin([
      { materiale: 'Pannolini', quantita: 30, portato: true },
      { materiale: 'Pannolini', quantita: 4,  portato: false },
      { materiale: 'Crema',     quantita: 2,  portato: true },
    ]), 'a1')
    expect(s).toEqual({ Pannolini: 26, Crema: 2 })
  })

  it('non scende sotto zero: un consumo senza carico vale 0, non -3', async () => {
    const s = await stockDiAlunno(admin([
      { materiale: 'Cambio', quantita: 3, portato: false },
    ]), 'a1')
    expect(s).toEqual({ Cambio: 0 })
  })

  it('PostgREST non lancia: su errore ritorna null, non un oggetto vuoto', async () => {
    const s = await stockDiAlunno(admin(null, { code: '42P01', message: 'x' }), 'a1')
    expect(s).toBeNull()
  })

  it('nessun movimento → oggetto vuoto, non null', async () => {
    expect(await stockDiAlunno(admin([]), 'a1')).toEqual({})
  })
})
