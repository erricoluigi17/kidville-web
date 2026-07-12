import { describe, it, expect, vi, beforeEach } from 'vitest'
import { enqueueNotifiche } from '@/lib/push/enqueue'
import { enqueueNotifichePerAlunni } from '@/lib/primaria/notifiche'
import { invalidateNotificheConfigCache } from '@/lib/notifiche/config'

// Gate dei toggle notifiche nel punto di strozzatura (enqueueNotifiche) e nei
// helper di dominio: toggle off → nessun insert; toggle assente/on → insert;
// senza scuolaId → insert (fail-open, comportamento storico).

const h = vi.hoisted(() => ({
  toggles: {} as Record<string, boolean>,
  inserts: [] as Array<Record<string, unknown>>,
  legami: [{ genitore_id: 'p1', alunno_id: 'a1' }] as Array<Record<string, unknown>>,
}))

function makeClient() {
  return {
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              if (table === 'admin_settings') return { data: { notifiche_config: { toggles: h.toggles } }, error: null }
              if (table === 'alunni') return { data: { scuola_id: 's1' }, error: null }
              return { data: null, error: null }
            },
          }),
          in: async () => ({ data: table === 'legame_genitori_alunni' ? h.legami : [], error: null }),
        }),
        insert: async (rows: Record<string, unknown>[]) => { h.inserts.push(...rows); return { error: null } },
      }
    },
  }
}

beforeEach(() => {
  h.toggles = {}
  h.inserts = []
  invalidateNotificheConfigCache()
})

describe('enqueueNotifiche — gate toggle', () => {
  it('toggle off per la scuola → nessun insert', async () => {
    h.toggles = { avviso: false }
    await enqueueNotifiche(makeClient() as never, { utenteIds: ['u1'], tipo: 'avviso', titolo: 'T', scuolaId: 's1' })
    expect(h.inserts).toHaveLength(0)
  })

  it('toggle assente → insert', async () => {
    await enqueueNotifiche(makeClient() as never, { utenteIds: ['u1'], tipo: 'avviso', titolo: 'T', scuolaId: 's1' })
    expect(h.inserts).toHaveLength(1)
  })

  it('senza scuolaId → insert (comportamento storico, fail-open)', async () => {
    h.toggles = { avviso: false }
    await enqueueNotifiche(makeClient() as never, { utenteIds: ['u1'], tipo: 'avviso', titolo: 'T' })
    expect(h.inserts).toHaveLength(1)
  })
})

describe('enqueueNotifichePerAlunni — gate toggle', () => {
  it('risolve la scuola dal primo alunno e rispetta il toggle off', async () => {
    h.toggles = { valutazione: false }
    await enqueueNotifichePerAlunni(makeClient() as never, { alunnoIds: ['a1'], tipo: 'valutazione', titolo: 'T' })
    expect(h.inserts).toHaveLength(0)
  })

  it('toggle on → notifica ai genitori', async () => {
    h.toggles = { valutazione: true }
    await enqueueNotifichePerAlunni(makeClient() as never, { alunnoIds: ['a1'], tipo: 'valutazione', titolo: 'T' })
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0]).toMatchObject({ utente_id: 'p1', tipo: 'valutazione' })
  })

  it('alias nota_firma segue il toggle di nota', async () => {
    h.toggles = { nota: false }
    await enqueueNotifichePerAlunni(makeClient() as never, { alunnoIds: ['a1'], tipo: 'nota_firma', titolo: 'T' })
    expect(h.inserts).toHaveLength(0)
  })
})
