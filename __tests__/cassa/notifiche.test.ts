import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// ── Notifiche cassa: adminDellaSede a 3 fallback (P10) + label metodo (P1) ────
// Isoliamo il modulo dai suoi vicini pesanti (triggers/saldo/config): qui si
// collauda SOLO la selezione dei destinatari e il corpo della notifica.

const h = vi.hoisted(() => ({
  logEvento: vi.fn(),
  notificaEvento: vi.fn(),
}))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: () => {},
  logOk: () => {},
}))
vi.mock('@/lib/notifiche/triggers', () => ({
  notificaEvento: (...a: unknown[]) => h.notificaEvento(...a),
}))
vi.mock('@/lib/settings/module-config', () => ({
  getModuleConfig: async () => ({}),
}))
vi.mock('@/lib/cassa/saldo', () => ({
  caricaSaldoCassa: async () => ({ disponibile: false }),
}))

import { adminDellaSede, notificaUscitaNonAdmin } from '@/lib/cassa/notifiche'

type Ris = { data: unknown; error: unknown }

/** Query-builder thenable: ogni metodo torna se stesso, l'await risolve il risultato. */
function thenable(result: Ris) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'order']) b[m] = () => b
  b.then = (resolve: (v: unknown) => unknown) => resolve(result)
  return b
}

function supa(utenti: Ris, utentiScuole: Ris): SupabaseClient {
  return {
    from: (table: string) => thenable(table === 'utenti' ? utenti : utentiScuole),
  } as unknown as SupabaseClient
}

const SC = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529'
const ALTRA = 'e2e00000-0000-4000-8000-000000000001'

beforeEach(() => vi.clearAllMocks())

describe('adminDellaSede — 3 livelli di fallback (P10)', () => {
  it('livello 1: mappatura utenti_scuole presente → SOLO gli admin di quella sede', async () => {
    const out = await adminDellaSede(
      supa(
        { data: [{ id: 'a1', scuola_id: SC }, { id: 'a2', scuola_id: ALTRA }], error: null },
        { data: [{ utente_id: 'a1' }], error: null },
      ),
      SC,
    )
    expect(out).toEqual(['a1'])
    // Non è un fail-open: nessun log info di degrado.
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('livello 2: utenti_scuole vuota → fallback intermedio su utenti.scuola_id = sede', async () => {
    const out = await adminDellaSede(
      supa(
        { data: [{ id: 'a1', scuola_id: SC }, { id: 'a2', scuola_id: ALTRA }], error: null },
        { data: [], error: null },
      ),
      SC,
    )
    // a1 ha scuola_id = SC, a2 no → solo a1. NON deve cadere sul fail-open a tutti.
    expect(out).toEqual(['a1'])
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('livello 3: utenti_scuole vuota E nessun match su utenti.scuola_id → fail-open a tutti + log info', async () => {
    const out = await adminDellaSede(
      supa(
        { data: [{ id: 'a1', scuola_id: null }, { id: 'a2', scuola_id: null }], error: null },
        { data: [], error: null },
      ),
      SC,
    )
    expect(out).toEqual(['a1', 'a2'])
    // Il fail-open a TUTTI gli admin va tracciato (osservabilità del degrado).
    expect(h.logEvento).toHaveBeenCalledWith('cassa', 'info', expect.objectContaining({ operazione: 'adminDellaSede' }))
  })

  it('utenti_scuole illeggibile (errore) → fail-open a tutti gli admin + log info', async () => {
    const out = await adminDellaSede(
      supa(
        { data: [{ id: 'a1', scuola_id: null }, { id: 'a2', scuola_id: null }], error: null },
        { data: null, error: { code: '42P01', message: 'relation does not exist' } },
      ),
      SC,
    )
    expect(out).toEqual(['a1', 'a2'])
    expect(h.logEvento).toHaveBeenCalledWith('cassa', 'info', expect.objectContaining({ operazione: 'adminDellaSede' }))
  })

  it('nessun admin → lista vuota (nessuna notifica)', async () => {
    const out = await adminDellaSede(supa({ data: [], error: null }, { data: [], error: null }), SC)
    expect(out).toEqual([])
  })

  it('errore nella lettura degli admin → lista vuota + log warn', async () => {
    const out = await adminDellaSede(
      supa({ data: null, error: { code: 'XX', message: 'boom' } }, { data: [], error: null }),
      SC,
    )
    expect(out).toEqual([])
    expect(h.logEvento).toHaveBeenCalledWith('cassa', 'warn', expect.objectContaining({ operazione: 'adminDellaSede' }), expect.anything())
  })
})

describe('notificaUscitaNonAdmin — corpo con label metodo (P1)', () => {
  it("il corpo usa la label capitalizzata del metodo, non la chiave grezza", async () => {
    await notificaUscitaNonAdmin(
      supa({ data: [{ id: 'a1', scuola_id: SC }], error: null }, { data: [{ utente_id: 'a1' }], error: null }),
      { scuolaId: SC, movimentoId: 'm1', importo: 12.5, metodo: 'pos' },
    )
    expect(h.notificaEvento).toHaveBeenCalledTimes(1)
    const arg = h.notificaEvento.mock.calls[0][1] as { corpo: string }
    expect(arg.corpo).toContain('POS')
    expect(arg.corpo).not.toContain('(pos)')
  })
})
