import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento }
})

import { enqueueNotifiche } from '@/lib/push/enqueue'

/**
 * LA CHIAVE DI DEDUPLICA (sessione 8 della seconda serie, D12). Chi la passa chiede «al massimo una
 * riga per chiave»: la scrittura è un upsert con `ignoreDuplicates` (ON CONFLICT DO NOTHING) e
 * l'arbitro è l'indice unico `notifiche_chiave_dedup_key`. Sul DB non migrato si ripiega
 * sull'insert di sempre, e lo si dice.
 */

const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const U2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const AVVISO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const chiave = (uid: string) => `modulo_promemoria:${AVVISO}:${uid}:2026-10-21`

function finto(risposte: { upsert?: unknown[]; insert?: unknown[] }) {
  const upsert = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ error: null }))
  const insert = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ error: null }))
  for (const r of risposte.upsert ?? []) upsert.mockResolvedValueOnce(r)
  for (const r of risposte.insert ?? []) insert.mockResolvedValueOnce(r)
  return { client: { from: () => ({ upsert, insert }) } as unknown as SupabaseClient, upsert, insert }
}

describe('enqueueNotifiche — chiave di deduplica', () => {
  beforeEach(() => vi.clearAllMocks())

  it('con la chiave: upsert ON CONFLICT (chiave_dedup) DO NOTHING, una chiave per destinatario', async () => {
    const { client, upsert, insert } = finto({})
    expect(await enqueueNotifiche(client, {
      utenteIds: [U1, U2], tipo: 'modulo_promemoria', titolo: 't', entitaId: AVVISO, chiaveDedup: chiave,
    })).toBe(true)
    expect(insert).not.toHaveBeenCalled()
    expect(upsert).toHaveBeenCalledTimes(1)
    const [righe, opzioni] = upsert.mock.calls[0] as [Array<{ chiave_dedup: string }>, unknown]
    expect(opzioni).toEqual({ onConflict: 'chiave_dedup', ignoreDuplicates: true })
    expect(righe.map((r) => r.chiave_dedup)).toEqual([chiave(U1), chiave(U2)])
  })

  it('senza la chiave: l’insert di sempre, senza la colonna', async () => {
    const { client, upsert, insert } = finto({})
    expect(await enqueueNotifiche(client, { utenteIds: [U1], tipo: 'diario', titolo: 't' })).toBe(true)
    expect(upsert).not.toHaveBeenCalled()
    expect((insert.mock.calls[0] as [Array<Record<string, unknown>>])[0][0]).not.toHaveProperty('chiave_dedup')
  })

  // §5 della specifica: schema nuovo non ancora installato (DB della CI, finestra del merge) = riga
  // `info` che dice perché, solo su questa chiamata. I codici: 42703/PGRST204 colonna assente
  // (`colonnaNuovaAssente`), 42P10 colonna presente ma nessun indice che faccia da arbitro.
  it.each(['42P10', 'PGRST204', '42703'])('DB senza colonna o senza arbitro (%s): ripiega sull’insert e lo dice a livello info', async (code) => {
    const { client, upsert, insert } = finto({ upsert: [{ error: { code, message: 'chiave_dedup' } }] })
    expect(await enqueueNotifiche(client, {
      utenteIds: [U1], tipo: 'modulo_promemoria', titolo: 't', chiaveDedup: chiave,
    })).toBe(true)
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(insert).toHaveBeenCalledTimes(1)
    expect((insert.mock.calls[0] as [Array<Record<string, unknown>>])[0][0]).not.toHaveProperty('chiave_dedup')
    expect(h.logEvento).toHaveBeenCalledWith(
      'notifica', 'info', expect.objectContaining({ esito: 'chiave-dedup-assente' }), expect.objectContaining({ code }),
    )
    expect(h.logEvento).not.toHaveBeenCalledWith('notifica', 'warn', expect.anything(), expect.anything())
  })

  it('un errore vero non ripiega: resta un inserimento fallito, a livello error', async () => {
    const { client, insert } = finto({ upsert: [{ error: { code: '23503', message: 'fk' } }] })
    expect(await enqueueNotifiche(client, {
      utenteIds: [U1], tipo: 'modulo_promemoria', titolo: 't', chiaveDedup: chiave,
    })).toBe(false)
    expect(insert).not.toHaveBeenCalled()
    expect(h.logEvento).toHaveBeenCalledWith(
      'notifica', 'error', expect.objectContaining({ esito: 'insert-fallito' }), expect.objectContaining({ code: '23503' }),
    )
  })
})
