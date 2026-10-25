import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => ({ enqueue: vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true) }))
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: h.enqueue }))
vi.mock('@/lib/notifiche/config', () => ({ isNotificaAbilitata: async () => true }))

import { notificaEvento } from '@/lib/notifiche/triggers'

/** La chiave arriva intatta dalla route alla coda (sessione 8 della seconda serie, D12). */

const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

describe('la chiave di deduplica arriva fino alla coda', () => {
  beforeEach(() => vi.clearAllMocks())

  it('notificaEvento la passa a enqueueNotifiche così com’è', async () => {
    const chiave = (uid: string) => `documenti_scadenza:${DOC}:${uid}`
    await notificaEvento({} as never, {
      tipo: 'documenti_scadenza', utenteIds: [U1], titolo: 't', entitaTipo: 'documento', entitaId: DOC,
      bufferMin: 0, chiaveDedup: chiave,
    })
    expect(h.enqueue).toHaveBeenCalledTimes(1)
    expect(h.enqueue.mock.calls[0][1]).toMatchObject({ utenteIds: [U1], chiaveDedup: chiave })
  })

  it('senza chiave non ne inventa una', async () => {
    await notificaEvento({} as never, { tipo: 'diario', utenteIds: [U1], titolo: 't' })
    expect((h.enqueue.mock.calls[0][1] as { chiaveDedup?: unknown }).chiaveDedup).toBeUndefined()
  })

  it('i promemoria dei moduli e dei documenti chiedono una riga sola per chiave', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/notifiche/promemoria/route.ts'), 'utf8')
    expect(route).toMatch(/chiaveDedup:\s*\(uid\)\s*=>\s*`modulo_promemoria:\$\{avviso\.id\}:\$\{uid\}:\$\{oggi\}`/)
    expect(route).toMatch(/chiaveDedup:\s*\(uid\)\s*=>\s*`documenti_scadenza:\$\{doc\.id\}:\$\{uid\}`/)
  })
})
