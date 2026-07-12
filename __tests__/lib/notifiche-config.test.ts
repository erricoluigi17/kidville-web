import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isNotificaAbilitata, invalidateNotificheConfigCache } from '@/lib/notifiche/config'

// Toggle notifiche per tipo (admin_settings.notifiche_config): chiave assente =
// attiva; FAIL-OPEN su scuola ignota/colonna mancante/errore; cache 60s per
// scuola; gli alias (nota_firma) seguono il toggle del tipo canonico.

const h = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  selects: 0,
  fail: false,
}))

function makeClient() {
  return {
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              h.selects += 1
              if (h.fail) throw new Error('boom')
              if (table !== 'admin_settings') return { data: null, error: null }
              return { data: h.config === null ? null : { notifiche_config: h.config }, error: null }
            },
          }),
        }),
      }
    },
  }
}

beforeEach(() => {
  h.config = null
  h.selects = 0
  h.fail = false
  invalidateNotificheConfigCache()
})

describe('isNotificaAbilitata', () => {
  it('toggle assente → attiva (default on)', async () => {
    h.config = { toggles: {} }
    expect(await isNotificaAbilitata(makeClient() as never, 'avviso', 's1')).toBe(true)
  })

  it('riga admin_settings assente → attiva', async () => {
    h.config = null
    expect(await isNotificaAbilitata(makeClient() as never, 'avviso', 's1')).toBe(true)
  })

  it('toggle false → disattivata; true → attiva', async () => {
    h.config = { toggles: { avviso: false, chat_genitore: true } }
    expect(await isNotificaAbilitata(makeClient() as never, 'avviso', 's1')).toBe(false)
    expect(await isNotificaAbilitata(makeClient() as never, 'chat_genitore', 's1')).toBe(true)
  })

  it('scuolaId assente → attiva senza interrogare il DB (fail-open)', async () => {
    expect(await isNotificaAbilitata(makeClient() as never, 'avviso', null)).toBe(true)
    expect(h.selects).toBe(0)
  })

  it('errore di lettura (es. colonna mancante su DB E2E) → attiva (fail-open)', async () => {
    h.fail = true
    expect(await isNotificaAbilitata(makeClient() as never, 'avviso', 's1')).toBe(true)
  })

  it('alias nota_firma segue il toggle di nota', async () => {
    h.config = { toggles: { nota: false } }
    expect(await isNotificaAbilitata(makeClient() as never, 'nota_firma', 's1')).toBe(false)
  })

  it('cache: seconda chiamata entro il TTL non ri-interroga; invalidate ri-interroga', async () => {
    h.config = { toggles: { avviso: false } }
    const client = makeClient() as never
    await isNotificaAbilitata(client, 'avviso', 's1')
    await isNotificaAbilitata(client, 'diario', 's1')
    expect(h.selects).toBe(1)
    invalidateNotificheConfigCache()
    await isNotificaAbilitata(client, 'avviso', 's1')
    expect(h.selects).toBe(2)
  })

  it('cache separata per scuola', async () => {
    h.config = { toggles: {} }
    const client = makeClient() as never
    await isNotificaAbilitata(client, 'avviso', 's1')
    await isNotificaAbilitata(client, 'avviso', 's2')
    expect(h.selects).toBe(2)
  })
})
