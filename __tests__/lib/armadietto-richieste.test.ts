import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  stock: vi.fn(),
  soglie: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  vive: { current: [] as unknown[] },
}))

vi.mock('@/lib/armadietto/stock', () => ({ stockDiAlunno: h.stock }))
vi.mock('@/lib/armadietto/soglie', () => ({ soglieMateriali: h.soglie }))

function admin() {
  return {
    from: vi.fn((t: string) => {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'neq', 'order']) qb[m] = () => qb
      qb.maybeSingle = () => Promise.resolve({
        data: { section_id: 'sec1', scuola_id: 'sc1' }, error: null,
      })
      qb.upsert = (...a: unknown[]) => { h.upsert(t, ...a); return { select: () => Promise.resolve({ data: [], error: null }) } }
      qb.update = (...a: unknown[]) => { h.update(t, ...a); return qb }
      qb.then = (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: h.vive.current, error: null }).then(r)
      return qb
    }),
  } as never
}

import { riconciliaRichieste } from '@/lib/armadietto/richieste'

beforeEach(() => {
  vi.clearAllMocks()
  h.vive.current = []
  h.soglie.mockResolvedValue({ Pannolini: { allerta: 5, emergenza: 2 } })
})

describe('riconciliaRichieste', () => {
  it('apre GIALLO quando lo stock tocca la soglia di allerta', async () => {
    h.stock.mockResolvedValue({ Pannolini: 5 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.upsert).toHaveBeenCalledWith('armadietto_richieste',
      expect.objectContaining({ materiale: 'Pannolini', livello: 'giallo', quantita_residua: 5, stato: 'aperta' }),
      expect.anything())
  })

  it('apre ROSSO alla soglia di emergenza', async () => {
    h.stock.mockResolvedValue({ Pannolini: 2 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.upsert).toHaveBeenCalledWith('armadietto_richieste',
      expect.objectContaining({ livello: 'rosso' }), expect.anything())
  })

  it('sopra soglia non apre niente', async () => {
    h.stock.mockResolvedValue({ Pannolini: 6 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it('chiude quando il carico riporta lo stock sopra soglia', async () => {
    h.vive.current = [{ id: 'r1', materiale: 'Pannolini', livello: 'rosso', stato: 'aperta' }]
    h.stock.mockResolvedValue({ Pannolini: 32 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.update).toHaveBeenCalledWith('armadietto_richieste',
      expect.objectContaining({ stato: 'evasa' }))
  })

  it('promuove giallo → rosso', async () => {
    h.vive.current = [{ id: 'r1', materiale: 'Pannolini', livello: 'giallo', stato: 'aperta' }]
    h.stock.mockResolvedValue({ Pannolini: 1 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.update).toHaveBeenCalledWith('armadietto_richieste',
      expect.objectContaining({ livello: 'rosso' }))
  })

  it('NON declassa rosso → giallo: un allarme dato non si ritira', async () => {
    h.vive.current = [{ id: 'r1', materiale: 'Pannolini', livello: 'rosso', stato: 'aperta' }]
    h.stock.mockResolvedValue({ Pannolini: 4 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    const arg = h.update.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined
    expect(arg?.livello).not.toBe('giallo')
  })

  it('non riapre una presa_in_carico finche resta sotto soglia', async () => {
    h.vive.current = [{ id: 'r1', materiale: 'Pannolini', livello: 'rosso', stato: 'presa_in_carico' }]
    h.stock.mockResolvedValue({ Pannolini: 2 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it('stock illeggibile → non fa NIENTE, non chiude a vuoto', async () => {
    h.vive.current = [{ id: 'r1', materiale: 'Pannolini', livello: 'rosso', stato: 'aperta' }]
    h.stock.mockResolvedValue(null)
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.update).not.toHaveBeenCalled()
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it('materiale senza soglia configurata: nessuna richiesta', async () => {
    h.stock.mockResolvedValue({ Sconosciuto: 0 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.upsert).not.toHaveBeenCalled()
  })
})
