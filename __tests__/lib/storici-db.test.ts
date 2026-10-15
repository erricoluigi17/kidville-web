import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn() }))
import { leggiTutte } from '@/lib/storici/db'
import { appartieneNelGiorno } from '@/lib/storici/scope'
describe('raccolta storici', () => {
  it('legge oltre il limite PostgREST e propaga gli errori della seconda pagina', async () => {
    const righe = Array.from({ length: 1254 }, (_, id) => ({ id }))
    const query = vi.fn(async (dal: number, al: number) => ({ data: righe.slice(dal, al + 1), error: null }))
    expect(await leggiTutte(query, 'prova')).toHaveLength(1254)
    expect(query).toHaveBeenCalledTimes(3)
    await expect(leggiTutte(async dal => dal ? { data: null, error: { code: 'XX000' } } : { data: righe.slice(0, 500), error: null }, 'prova')).rejects.toThrow('non riuscita')
  })
  it('considera appartenenze semiaperte e mai la classe corrente come prova del passato', () => {
    const a = [{ alunno_id: 'a', scuola_id: 's', section_id: 'c', dal: '2026-09-01', al: '2026-10-01' }]
    expect(appartieneNelGiorno(a, 'a', '2026-09-30', 'c')).toBe(true)
    expect(appartieneNelGiorno(a, 'a', '2026-10-01', 'c')).toBe(false)
    expect(appartieneNelGiorno(a, 'a', '2026-09-30', 'altra')).toBe(false)
  })
})
