import { describe, it, expect, vi, beforeEach } from 'vitest'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { controparteThread, genitoriDiClassi, staffScuola } from '@/lib/notifiche/destinatari'
import { invalidateNotificheConfigCache } from '@/lib/notifiche/config'

// notificaEvento: toggle → destinatari (utenteIds + genitori degli alunni) →
// debounce (delete pending stesso tipo+entita_id) → enqueue. Sempre best-effort.

const h = vi.hoisted(() => ({
  toggles: {} as Record<string, boolean>,
  inserts: [] as Array<Record<string, unknown>>,
  deletes: [] as Array<Record<string, unknown>>,
  legami: [{ genitore_id: 'p1' }, { genitore_id: 'p2' }] as Array<Record<string, unknown>>,
  alunniClasse: [{ id: 'a1' }, { id: 'a2' }] as Array<Record<string, unknown>>,
  thread: { teacher_id: 't1', parent_id: 'p1' } as Record<string, unknown> | null,
  utenti: [
    { id: 'u1', role: 'admin', ruolo: null },
    { id: 'u2', role: null, ruolo: 'cuoca' },
    { id: 'u3', role: 'educator', ruolo: null },
  ] as Array<Record<string, unknown>>,
}))

function makeClient() {
  return {
    from(table: string) {
      const filtri: Record<string, unknown> = {}
      const rowsFor = () => {
        if (table === 'legame_genitori_alunni') return h.legami
        if (table === 'alunni') return h.alunniClasse
        if (table === 'utenti') return h.utenti
        return []
      }
      const chain: Record<string, unknown> = {
        eq: (col: string, val: unknown) => { filtri[col] = val; return chain },
        in: (col: string, val: unknown) => { filtri[col] = val; return chain },
        is: (col: string, val: unknown) => { filtri[col] = val; h.deletes.push({ table, ...filtri }); return Promise.resolve({ error: null }) },
        maybeSingle: async () => {
          if (table === 'admin_settings') return { data: { notifiche_config: { toggles: h.toggles } }, error: null }
          if (table === 'chat_threads') return { data: h.thread, error: null }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => void) => resolve({ data: rowsFor(), error: null }),
      }
      return {
        select: () => chain,
        delete: () => chain,
        insert: async (rows: Record<string, unknown>[]) => { h.inserts.push(...rows); return { error: null } },
      }
    },
  }
}

beforeEach(() => {
  h.toggles = {}
  h.inserts = []
  h.deletes = []
  h.thread = { teacher_id: 't1', parent_id: 'p1' }
  invalidateNotificheConfigCache()
})

describe('notificaEvento', () => {
  it('toggle off → nessun insert e nessun debounce', async () => {
    h.toggles = { chat_genitore: false }
    await notificaEvento(makeClient() as never, {
      tipo: 'chat_genitore', scuolaId: 's1', utenteIds: ['p1'], titolo: 'T', entitaId: 'th1', debounce: true,
    })
    expect(h.inserts).toHaveLength(0)
    expect(h.deletes).toHaveLength(0)
  })

  it('somma utenteIds e genitori degli alunni, deduplicati', async () => {
    await notificaEvento(makeClient() as never, {
      tipo: 'avviso', scuolaId: 's1', utenteIds: ['p1', 'x1'], alunnoIds: ['a1'], titolo: 'T',
    })
    const destinatari = h.inserts.map((r) => r.utente_id).sort()
    expect(destinatari).toEqual(['p1', 'p2', 'x1'])
  })

  it('debounce: elimina le pending con stesso tipo+entita_id prima di accodare', async () => {
    await notificaEvento(makeClient() as never, {
      tipo: 'chat_docente', scuolaId: 's1', utenteIds: ['t1'], titolo: 'T', entitaId: 'th1', debounce: true, bufferMin: 0,
    })
    expect(h.deletes).toHaveLength(1)
    expect(h.deletes[0]).toMatchObject({ tipo: 'chat_docente', entita_id: 'th1', push_inviata_il: null })
    expect(h.inserts).toHaveLength(1)
  })

  it('nessun destinatario → nessun insert', async () => {
    h.legami = []
    await notificaEvento(makeClient() as never, { tipo: 'avviso', scuolaId: 's1', alunnoIds: ['a1'], titolo: 'T' })
    expect(h.inserts).toHaveLength(0)
    h.legami = [{ genitore_id: 'p1' }, { genitore_id: 'p2' }]
  })
})

describe('destinatari', () => {
  it('controparteThread: dal docente → genitore e viceversa', async () => {
    expect(await controparteThread(makeClient() as never, 'th1', 't1')).toEqual({ utenteId: 'p1', versoGenitore: true })
    expect(await controparteThread(makeClient() as never, 'th1', 'p1')).toEqual({ utenteId: 't1', versoGenitore: false })
    expect(await controparteThread(makeClient() as never, 'th1', 'estraneo')).toBeNull()
  })

  it('genitoriDiClassi: alunni delle classi → genitori distinti', async () => {
    const out = await genitoriDiClassi(makeClient() as never, 's1', ['1A'])
    expect(out.sort()).toEqual(['p1', 'p2'])
  })

  it('staffScuola: filtra per role O ruolo (schema legacy doppio)', async () => {
    const out = await staffScuola(makeClient() as never, 's1', ['admin', 'cuoca'])
    expect(out.sort()).toEqual(['u1', 'u2'])
  })
})
