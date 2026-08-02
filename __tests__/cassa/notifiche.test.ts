import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { SupabaseClient } from '@supabase/supabase-js'

// ── Notifiche cassa: adminDellaSede a 2 livelli + label metodo (P1) ──────────
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

const SC = SEDE_A
const ALTRA = SEDE_B

beforeEach(() => vi.clearAllMocks())

describe('adminDellaSede — ponte, colonna, e poi si nega', () => {
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

  // AUDIT 2026-07-31 (R62): il terzo livello — «nessuna mappatura ⇒ TUTTI gli
  // admin del sistema» — è stato rimosso. Con una sede sola «meglio una notifica
  // in più» era difendibile; con tre plessi significa la cassa di Aversa
  // annunciata all'amministratore di Giugliano, e il livello `info` NON viene
  // persistito, quindi il degrado non lasciava nemmeno una riga interrogabile.
  it('nessuna mappatura né per ponte né per colonna → [] + warn (era: tutti gli admin)', async () => {
    const out = await adminDellaSede(
      supa(
        { data: [{ id: 'a1', scuola_id: null }, { id: 'a2', scuola_id: null }], error: null },
        { data: [], error: null },
      ),
      SC,
    )
    expect(out).toEqual([])
    expect(h.logEvento).toHaveBeenCalledWith(
      'cassa', 'warn', expect.objectContaining({ operazione: 'adminDellaSede', esito: 'nessun-destinatario' }),
    )
  })

  it('utenti_scuole illeggibile e nessun admin sulla colonna → [] + warn', async () => {
    const out = await adminDellaSede(
      supa(
        { data: [{ id: 'a1', scuola_id: null }, { id: 'a2', scuola_id: null }], error: null },
        { data: null, error: { code: '42P01', message: 'relation does not exist' } },
      ),
      SC,
    )
    expect(out).toEqual([])
    expect(h.logEvento).toHaveBeenCalledWith(
      'cassa', 'warn',
      expect.objectContaining({ operazione: 'adminDellaSede', esito: 'utenti-scuole-non-letta' }),
      expect.anything(),
    )
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

  // L'importo nel corpo passa da `formatEuro`. Prima era formattato a mano con
  // `toLocaleString('it-IT', { minimumFractionDigits: 2 })`, che per i numeri a
  // quattro cifre NON raggruppa (it-IT ha `minimumGroupingDigits = 2`): 1234,50
  // arrivava all'admin come «1234,50 €» mentre il pannello Cassa, a un clic di
  // distanza, mostrava «€ 1.234,50».
  it('l\'importo nel corpo è in formato it-IT completo, migliaia comprese', async () => {
    await notificaUscitaNonAdmin(
      supa({ data: [{ id: 'a1', scuola_id: SC }], error: null }, { data: [{ utente_id: 'a1' }], error: null }),
      { scuolaId: SC, movimentoId: 'm1', importo: 1234.5, metodo: 'contanti' },
    )
    const arg = h.notificaEvento.mock.calls[0][1] as { corpo: string }
    expect(arg.corpo).toContain('€ 1.234,50')
    expect(arg.corpo).not.toContain('1234,50')
  })
})
