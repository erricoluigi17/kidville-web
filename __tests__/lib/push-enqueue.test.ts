import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueueNotifiche } from '@/lib/push/enqueue'

describe('enqueueNotifiche', () => {
  it('inserisce una riga notifiche per utente con buffer', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    const from = vi.fn().mockReturnValue({ insert })
    const supabase = { from } as unknown as SupabaseClient

    await enqueueNotifiche(supabase, {
      utenteIds: ['u1', 'u2'],
      tipo: 'valutazione',
      titolo: 'Nuova valutazione',
      corpo: 'di Matematica',
      link: '/parent',
      entitaTipo: 'valutazione',
      entitaId: 'v-1',
      bufferMin: 10,
    })

    expect(from).toHaveBeenCalledWith('notifiche')
    const rows = insert.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      utente_id: 'u1',
      tipo: 'valutazione',
      titolo: 'Nuova valutazione',
      corpo: 'di Matematica',
      link: '/parent',
      entita_tipo: 'valutazione',
      entita_id: 'v-1',
    })
    const t = new Date(rows[0].invio_programmato_il as string).getTime()
    expect(t).toBeGreaterThan(Date.now() + 9 * 60_000)
  })

  it('bufferMin 0 → invio immediato', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    const from = vi.fn().mockReturnValue({ insert })
    const supabase = { from } as unknown as SupabaseClient

    await enqueueNotifiche(supabase, { utenteIds: ['u1'], tipo: 'x', titolo: 't', bufferMin: 0 })
    const rows = insert.mock.calls[0][0] as Array<Record<string, unknown>>
    const t = new Date(rows[0].invio_programmato_il as string).getTime()
    expect(t).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('utenteIds vuoto → nessun insert', async () => {
    const insert = vi.fn()
    const from = vi.fn().mockReturnValue({ insert })
    const supabase = { from } as unknown as SupabaseClient

    await enqueueNotifiche(supabase, { utenteIds: [], tipo: 'x', titolo: 't' })
    expect(from).not.toHaveBeenCalled()
  })

  it('deduplica gli utenteIds ripetuti', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    const from = vi.fn().mockReturnValue({ insert })
    const supabase = { from } as unknown as SupabaseClient

    await enqueueNotifiche(supabase, { utenteIds: ['u1', 'u1', 'u2'], tipo: 'x', titolo: 't' })
    const rows = insert.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
  })
})
