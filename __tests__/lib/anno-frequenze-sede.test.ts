import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

import { logErrore } from '@/lib/logging/logger'
import { annoAttivoDiSede, ESENTI } from '@/lib/anno/frequenze'

/** PR 3 · COMPITO 3.7-2 · `annoAttivoDiSede`: l'anno attivo di una sede, una volta per richiesta, che non lancia mai. */
const SEDE = '11111111-1111-1111-1111-111111111111'
const ANNO = '22222222-2222-2222-2222-222222222222'

const clienteRpc = (rpc: ReturnType<typeof vi.fn>) => ({ rpc }) as unknown as SupabaseClient

describe('annoAttivoDiSede', () => {
  beforeEach(() => vi.clearAllMocks())

  it('legge anno_attivo con la sede e restituisce l’id', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: ANNO, error: null })
    expect(await annoAttivoDiSede(clienteRpc(rpc), SEDE)).toBe(ANNO)
    expect(rpc).toHaveBeenCalledWith('anno_attivo', { p_scuola: SEDE })
  })

  it('con la cache chiama l’RPC una volta sola per sede, anche quando risponde null', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null })
    const cache = new Map<string, string | null>()
    const c = clienteRpc(rpc)
    expect(await annoAttivoDiSede(c, SEDE, cache)).toBeNull()
    expect(await annoAttivoDiSede(c, SEDE, cache)).toBeNull()
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('schema indietro (PGRST202 / PGRST205): null e nessun errore loggato', async () => {
    for (const code of ['PGRST202', 'PGRST205']) {
      const rpc = vi.fn().mockResolvedValue({ data: null, error: { code, message: 'x' } })
      expect(await annoAttivoDiSede(clienteRpc(rpc), SEDE)).toBeNull()
    }
    expect(logErrore).not.toHaveBeenCalled()
  })

  it('altro errore o eccezione: null, loggato col solo codice, non lancia', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: '57014', message: 'testo che non va nei log' } })
    expect(await annoAttivoDiSede(clienteRpc(rpc), SEDE)).toBeNull()
    expect(logErrore).toHaveBeenCalledTimes(1)
    const lancia = vi.fn().mockRejectedValue(new Error('rete'))
    expect(await annoAttivoDiSede(clienteRpc(lancia), SEDE)).toBeNull()
    expect(logErrore).toHaveBeenCalledTimes(2)
  })

  it('senza sede non chiama niente', async () => {
    const rpc = vi.fn()
    expect(await annoAttivoDiSede(clienteRpc(rpc), null)).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('ESENTI', () => {
  it('ogni voce ha un file e un motivo di almeno 40 caratteri', () => {
    expect(ESENTI.length).toBeGreaterThan(0)
    for (const e of ESENTI) {
      expect(e.file).toMatch(/^src\//)
      expect(e.motivo.length).toBeGreaterThanOrEqual(40)
    }
  })
})
