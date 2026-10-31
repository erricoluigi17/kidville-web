import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

/**
 * CRM della segreteria · Compito 4.2 — l'aggancio della CONSERVAZIONE delle domande.
 *
 * `POST /api/gdpr/retention-iscrizioni` cancella le domande scadute (dopo i loro allegati). Le schede del
 * CRM collegate a quelle domande devono lasciare nello storico «collegamento tolto, domanda cancellata», e
 * devono farlo PRIMA del `delete` (poi il database azzera `domanda_id` da solo). Qui si prova SOLO
 * l'aggancio della route; la libreria ha i suoi test in `__tests__/lib/crm/collegamento.test.ts`.
 *   · la libreria è chiamata PRIMA del delete, con gli stessi id;
 *   · se non c'è niente da cancellare non è chiamata;
 *   · un CRM che lancia NON ferma la conservazione: la cancellazione avviene lo stesso (è un obbligo di legge).
 * Lo scaffale dei finti è quello di `retention-iscrizioni-file-prima.test.ts`.
 */

const CRON_SECRET = 'segreto-di-prova-non-usato-altrove'

const h = vi.hoisted(() => ({
  sequenza: [] as { tipo: 'remove' | 'delete' | 'crm'; valore: unknown }[],
  scadute: [] as Record<string, unknown>[],
  ancoraNelBucket: new Set<string>(),
  /** Cosa risponde `storage.remove()`; se nullo, "tutti usciti". */
  removeRisposta: null as { data: unknown[] | null; error: unknown } | null,
  erroreDelete: null as unknown,
  cancellate: null as unknown as Mock<(...a: unknown[]) => Promise<void>>,
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
    h.eventi.push({ evento, livello, campi })
  },
  logErrore: () => {},
  logOk: () => {},
}))
vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: vi.fn().mockResolvedValue({ user: { id: 'staff' }, response: null }),
}))
vi.mock('@/lib/crm/collegamento', () => ({
  segnalaDomandeCancellate: (...a: unknown[]) => h.cancellate(...a),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'in', 'lt', 'eq', 'order', 'limit']) qb[m] = () => qb
      qb.delete = () => ({
        in: (_c: string, ids: unknown) => {
          h.sequenza.push({ tipo: 'delete', valore: ids })
          return Promise.resolve({ error: h.erroreDelete })
        },
      })
      qb.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: h.scadute, error: null }).then(res)
      return qb
    },
    storage: {
      from: () => ({
        remove: (percorsi: string[]) => {
          h.sequenza.push({ tipo: 'remove', valore: percorsi })
          return Promise.resolve(h.removeRisposta ?? { data: percorsi.map((p) => ({ name: p })), error: null })
        },
        list: (cartella: string, opzioni?: { search?: string }) => {
          const nome = opzioni?.search ?? ''
          const completo = cartella ? `${cartella}/${nome}` : nome
          return Promise.resolve({ data: h.ancoraNelBucket.has(completo) ? [{ name: nome }] : [], error: null })
        },
      }),
    },
  }),
}))

import { POST } from '@/app/api/gdpr/retention-iscrizioni/route'

const chiama = () =>
  POST(
    new Request('http://localhost/api/gdpr/retention-iscrizioni', {
      method: 'POST',
      headers: { 'x-cron-secret': CRON_SECRET },
    }),
  )

const domandaConAllegati = (id: string) => ({
  id,
  data: { children: [{ documento_path: `${id}/minore.pdf` }], adults: [{ documento_path: `${id}/adulto.pdf` }] },
})

beforeEach(() => {
  vi.clearAllMocks()
  h.sequenza = []
  h.scadute = []
  h.ancoraNelBucket = new Set()
  h.removeRisposta = null
  h.erroreDelete = null
  h.eventi = []
  h.cancellate = vi.fn(async (_db: unknown, ids: unknown) => {
    h.sequenza.push({ tipo: 'crm', valore: ids })
  })
  process.env.CRON_SECRET = CRON_SECRET
})

describe('POST /api/gdpr/retention-iscrizioni → segnalaDomandeCancellate', () => {
  it('la conservazione chiama segnalaDomandeCancellate prima del delete, con gli stessi id', async () => {
    h.scadute = ['d1', 'd2', 'd3'].map(domandaConAllegati)
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(h.cancellate).toHaveBeenCalledTimes(1)
    expect(h.sequenza.map((c) => c.tipo)).toEqual(['remove', 'crm', 'delete'])
    const crm = h.sequenza.find((c) => c.tipo === 'crm')!.valore
    const cancellati = h.sequenza.find((c) => c.tipo === 'delete')!.valore
    expect(crm).toEqual(['d1', 'd2', 'd3'])
    expect(crm).toEqual(cancellati)
  })

  it('una domanda che resta (allegato ancora nell’archivio) NON viene segnalata come cancellata', async () => {
    h.scadute = ['d1', 'd2'].map(domandaConAllegati)
    h.ancoraNelBucket = new Set(['d2/minore.pdf'])
    // `remove()` non conferma nessun percorso; lo Storage, interrogato, dice che uno di d2 c'è ancora:
    // d2 è trattenuta (la sua riga resta), d1 si chiude.
    h.removeRisposta = { data: [], error: null }
    await chiama()
    const crm = h.sequenza.find((c) => c.tipo === 'crm')
    const cancellati = h.sequenza.find((c) => c.tipo === 'delete')
    expect(cancellati?.valore).toEqual(['d1'])
    expect(crm?.valore, 'il CRM riceve gli stessi id del delete, non quelli delle domande trattenute').toEqual(['d1'])
  })

  it('niente da cancellare → il CRM non è nemmeno chiamato', async () => {
    h.scadute = []
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(h.cancellate).not.toHaveBeenCalled()
  })

  it('un CRM che lancia NON ferma la conservazione: le righe si cancellano lo stesso, e c’è la riga di log', async () => {
    h.scadute = ['d1'].map(domandaConAllegati)
    h.cancellate = vi.fn(async () => {
      throw Object.assign(new Error('giù'), { code: 'XX000' })
    })
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(h.sequenza.filter((c) => c.tipo === 'delete').flatMap((c) => c.valore as string[])).toEqual(['d1'])
    const riga = h.eventi.find((e) => e.evento === 'crm' && e.campi.esito === 'segnala-cancellate-eccezione')
    expect(riga).toMatchObject({ livello: 'error', campi: { n_domande: 1 } })
  })
})
