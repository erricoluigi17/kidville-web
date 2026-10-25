import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento }))

import { DURATA_PRESA_CRON_S, prendiPresaCron, rilasciaPresaCron } from '@/lib/cron/presa'

/** La presa con scadenza dei giri del cron (sessione 8 della seconda serie, D12). */

const TOKEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function finto(esito: { data?: unknown; error?: { code?: string; message?: string } } | Error) {
  const rpc = vi.fn<(...a: unknown[]) => Promise<{ data: unknown; error: unknown }>>(async () => {
    if (esito instanceof Error) throw esito
    return { data: esito.data ?? null, error: esito.error ?? null }
  })
  return { db: { rpc } as unknown as SupabaseClient, rpc }
}

describe('presa con scadenza dei giri del cron', () => {
  beforeEach(() => vi.clearAllMocks())

  it('dura più della vita massima della route che protegge', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/pagamenti/fattura/sync/route.ts'), 'utf8')
    const vita = Number(/^export const maxDuration\s*=\s*(\d+)/m.exec(route)![1])
    expect(DURATA_PRESA_CRON_S).toBeGreaterThan(vita)
  })

  it('presa ottenuta: il token, chiesto per DURATA_PRESA_CRON_S secondi, e nessuna riga di log', async () => {
    const { db, rpc } = finto({ data: TOKEN })
    expect(await prendiPresaCron(db, 'fattura-sync')).toEqual({ esito: 'presa', token: TOKEN })
    expect(rpc).toHaveBeenCalledWith('cron_presa_prendi', { p_job: 'fattura-sync', p_durata_s: DURATA_PRESA_CRON_S })
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('null: un altro giro tiene la presa → «altrui», riga info', async () => {
    const { db } = finto({ data: null })
    expect(await prendiPresaCron(db, 'fattura-sync')).toEqual({ esito: 'altrui' })
    expect(h.logEvento).toHaveBeenCalledWith('cron', 'info', { operazione: 'fattura-sync', esito: 'presa-altrui' })
  })

  // §5 della specifica: una RPC nuova non ancora installata (DB della CI, finestra del merge) regge
  // PGRST202/42883 solo su questa chiamata, con una riga `info` che dice perché.
  it.each(['PGRST202', '42883'])('RPC assente (%s, DB non migrato): il giro parte senza presa, riga info', async (code) => {
    const { db } = finto({ error: { code, message: 'cron_presa_prendi' } })
    expect(await prendiPresaCron(db, 'fattura-sync')).toEqual({ esito: 'presa', token: null })
    expect(h.logEvento).toHaveBeenCalledWith(
      'cron', 'info', { operazione: 'fattura-sync', esito: 'presa-senza-rpc' }, expect.objectContaining({ code }),
    )
    expect(h.logEvento).toHaveBeenCalledTimes(1)
  })

  it('altro errore: «guasto», riga error con il corpo dell’errore', async () => {
    const { db } = finto({ error: { code: '57014', message: 'canceling statement due to statement timeout' } })
    expect(await prendiPresaCron(db, 'fattura-sync')).toEqual({ esito: 'guasto' })
    expect(h.logEvento).toHaveBeenCalledWith(
      'cron', 'error', { operazione: 'fattura-sync', esito: 'presa-non-riuscita' }, expect.objectContaining({ code: '57014' }),
    )
  })

  it('eccezione di trasporto: «guasto», riga error', async () => {
    const guasto = new Error('fetch failed')
    const { db } = finto(guasto)
    expect(await prendiPresaCron(db, 'fattura-sync')).toEqual({ esito: 'guasto' })
    expect(h.logEvento).toHaveBeenCalledWith('cron', 'error', { operazione: 'fattura-sync', esito: 'presa-non-eseguita' }, guasto)
  })

  it('rilascio senza token: nessuna chiamata', async () => {
    const { db, rpc } = finto({ data: true })
    await rilasciaPresaCron(db, 'fattura-sync', null)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rilascio col token: chiama cron_presa_rilascia; una presa già scaduta lo dice', async () => {
    const { db, rpc } = finto({ data: false })
    await rilasciaPresaCron(db, 'fattura-sync', TOKEN)
    expect(rpc).toHaveBeenCalledWith('cron_presa_rilascia', { p_job: 'fattura-sync', p_token: TOKEN })
    expect(h.logEvento).toHaveBeenCalledWith('cron', 'warn', { operazione: 'fattura-sync', esito: 'presa-gia-scaduta' })
  })

  it('rilascio fallito: riga error, e non lancia', async () => {
    const { db } = finto({ error: { code: '08006', message: 'connessione persa' } })
    await expect(rilasciaPresaCron(db, 'fattura-sync', TOKEN)).resolves.toBeUndefined()
    expect(h.logEvento).toHaveBeenCalledWith(
      'cron', 'error', { operazione: 'fattura-sync', esito: 'presa-non-rilasciata' }, expect.objectContaining({ code: '08006' }),
    )
  })
})
