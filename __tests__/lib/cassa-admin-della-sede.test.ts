import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// CASSA · `adminDellaSede` — il terzo livello di fallback notificava TUTTI.
//
// Audit 2026-07-31 (F6, R62). I livelli erano tre: (1) ponte `utenti_scuole`,
// (2) colonna `utenti.scuola_id`, (3) «nessuna mappatura ⇒ tutti gli admin del
// sistema», con un log `info` — cioè il livello che NON viene persistito
// (`EVENTI_PERSISTITI` copre i warn/error). Con una sede sola «una notifica in
// più» era una scelta difendibile; con tre plessi significa la cassa di un
// plesso annunciata all'amministratore di un altro, e senza traccia in tabella.
//
// Zero destinatari con un avviso è onesto. «Tutti» è una decisione di
// visibilità presa da un ramo di ripiego.
// =============================================================================

const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import { adminDellaSede } from '@/lib/cassa/notifiche'

function dbBase(): DBFinto {
  return {
    utenti: [
      { id: 'admin-a', ruolo: 'admin', scuola_id: SEDE_A },
      { id: 'admin-b', ruolo: 'admin', scuola_id: SEDE_B },
      { id: 'segr-a', ruolo: 'segreteria', scuola_id: SEDE_A },
    ],
    utenti_scuole: [{ utente_id: 'admin-a', scuola_id: SEDE_B }],
  }
}

const logDi = (esito: string) =>
  logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === esito)

beforeEach(() => logEvento.mockClear())

describe('adminDellaSede — i tre livelli, senza il fail-open finale', () => {
  it('livello 1: il ponte `utenti_scuole` ha la precedenza', async () => {
    const ids = await adminDellaSede(creaFintoSupabase(dbBase()), SEDE_B)
    expect(ids).toEqual(['admin-a'])
  })

  it('livello 2: senza ponte, la colonna `utenti.scuola_id`', async () => {
    const db = dbBase()
    db.utenti_scuole = []
    const ids = await adminDellaSede(creaFintoSupabase(db), SEDE_A)
    expect(ids).toEqual(['admin-a'])
  })

  it('nessuna mappatura ⇒ [] E un warn PERSISTITO, non «tutti gli admin»', async () => {
    const db = dbBase()
    db.utenti_scuole = []
    db.utenti = [
      { id: 'admin-a', ruolo: 'admin', scuola_id: SEDE_A },
      { id: 'admin-b', ruolo: 'admin', scuola_id: SEDE_B },
    ]
    // Una terza sede, su cui nessun admin è mappato in nessuno dei due modi.
    const ids = await adminDellaSede(creaFintoSupabase(db), 'cccccccc-0000-4000-8000-00000000000c')

    expect(ids).toEqual([])
    const riga = logDi('nessun-destinatario')
    expect(riga).toBeDefined()
    expect(riga?.[0]).toBe('cassa')
    expect(riga?.[1]).toBe('warn')
  })

  it('ponte illeggibile e nessun admin sulla colonna ⇒ [] + warn (stesso ramo)', async () => {
    const db = dbBase()
    const ids = await adminDellaSede(
      creaFintoSupabase(db, [], { errori: { utenti_scuole: { code: '42P01' } } }),
      'cccccccc-0000-4000-8000-00000000000c',
    )
    expect(ids).toEqual([])
    expect(logDi('utenti-scuole-non-letta')?.[1]).toBe('warn')
  })

  it('ponte illeggibile ma la colonna copre la sede ⇒ si usa la colonna', async () => {
    const ids = await adminDellaSede(
      creaFintoSupabase(dbBase(), [], { errori: { utenti_scuole: { code: '42P01' } } }),
      SEDE_A,
    )
    expect(ids).toEqual(['admin-a'])
  })
})
