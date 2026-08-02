import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SEDE_A } from '../fixtures/sedi'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// X2 (osservabilità) — i guasti silenziosi della catena SIDI.
//
// PostgREST non lancia: ritorna `{ error }`. Nella catena SIDI quel valore non
// veniva letto in tre punti, e ognuno dei tre produce un guasto INVISIBILE —
// esattamente la forma del guasto delle email del 2026-07, dove «nessun log»
// non distingueva «tutto ok» da «non è mai partito niente»:
//
//  · `persistFaseStato`: il flusso parte verso il Ministero ma lo stato non si
//    scrive. L'indicatore resta «non inviato» e la fase successiva è bloccata
//    per sempre, senza una riga che dica perché.
//  · `loadSyncState`: una lettura fallita diventa «non_inviato» — che è la
//    direzione SICURA (blocca l'invio fuori sequenza) ma indistinguibile dal
//    caso vero, e quindi impossibile da diagnosticare.
//  · `applySidiBatch`: il batch resta `parsed` dopo che le anagrafiche sono
//    già state scritte, e la lettura fallita del batch si travestiva da
//    «Batch non trovato» (404), cioè da errore dell'utente.
//
// Un evento critico logga anche il SUCCESSO (AGENTS.md §5): la trasmissione
// all'anagrafe ministeriale è il caso da manuale.
// =============================================================================

const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))

import { loadSyncState, persistFaseStato } from '@/lib/sidi/sync-store'
import { applySidiBatch } from '@/lib/sidi/import-apply'

const BATCH = 'ba7c0000-0000-4000-8000-00000000000a'
const ATTORE = { id: 'd0000000-0000-4000-8000-00000000ad00', role: 'admin', scuola_id: SEDE_A } as never

const errore: ErrorePostgrest = { code: '42703', message: 'column does not exist' }

const logDi = (esito: string) =>
  logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === esito)

const dbBase = (): DBFinto => ({ sidi_sync_state: [], sidi_import_batches: [], alunni: [], parents: [], student_parents: [] })

beforeEach(() => logEvento.mockClear())

describe('persistFaseStato — lo stato del flusso ministeriale non sparisce in silenzio', () => {
  it('upsert fallito ⇒ log `error`, e la chiamata non lancia', async () => {
    const db = dbBase()
    const client = creaFintoSupabase(db, [], { errori: { sidi_sync_state: errore } })

    await expect(persistFaseStato(client, SEDE_A, 'frequentanti', 'inviato', { ok: true })).resolves.toBeUndefined()

    const riga = logDi('stato-non-persistito')
    expect(riga).toBeDefined()
    expect(riga?.[1]).toBe('error')
    expect(riga?.[2]).toMatchObject({ tipo: 'frequentanti', scuola_id: SEDE_A })
  })

  it('upsert riuscito ⇒ log del SUCCESSO con sede e stato', async () => {
    const db = dbBase()
    const scritture: Scrittura[] = []
    const client = creaFintoSupabase(db, [], { scritture })

    await persistFaseStato(client, SEDE_A, 'fase_a', 'inviato', { ok: true })

    expect(scritture[0].valori[0]).toMatchObject({ scuola_id: SEDE_A, fase_a_stato: 'inviato' })
    const riga = logDi('stato-persistito')
    expect(riga).toBeDefined()
    expect(riga?.[1]).toBe('info')
    expect(riga?.[2]).toMatchObject({ tipo: 'fase_a', stato: 'inviato', scuola_id: SEDE_A })
  })
})

describe('loadSyncState — la lettura fallita si vede', () => {
  it('errore di lettura ⇒ stato di default (fail-closed) MA con log `error`', async () => {
    const db = dbBase()
    const client = creaFintoSupabase(db, [], { errori: { sidi_sync_state: errore } })

    const stato = await loadSyncState(client, SEDE_A)

    expect(stato.fase_a_stato).toBe('non_inviato')
    const riga = logDi('stato-non-letto')
    expect(riga).toBeDefined()
    expect(riga?.[1]).toBe('error')
  })
})

describe('applySidiBatch — l\'esito dell\'applicazione è tracciabile', () => {
  it('lettura del batch fallita ⇒ 500 esplicito, non un finto «non trovato»', async () => {
    const db = dbBase()
    const client = creaFintoSupabase(db, [], { errori: { sidi_import_batches: errore } })

    const res = await applySidiBatch(client, BATCH, ATTORE)

    expect(res.status).toBe(500)
    expect(res.error).toMatch(/non riuscita/i)
    expect(logDi('batch-non-letto')?.[1]).toBe('error')
  })

  it('marcatura `applied` fallita ⇒ avviso all\'operatore e log `error` (le anagrafiche sono già scritte)', async () => {
    const db = dbBase()
    db.sidi_import_batches = [{ id: BATCH, scuola_id: SEDE_A, stato: 'parsed', parsed_payload: [] }]
    const client = conUpdateInErrore(creaFintoSupabase(db, []), 'sidi_import_batches', errore)

    const res = await applySidiBatch(client, BATCH, ATTORE)

    expect(res.error).toBeUndefined()
    expect(res.warnings.join(' ')).toMatch(/stato del batch/i)
    expect(logDi('batch-non-marcato')?.[1]).toBe('error')
  })
})

/** Finto client in cui la sola `update()` su una tabella ritorna errore: il
 *  fixture inietta gli errori per TABELLA, e qui serve distinguere la lettura
 *  (che deve riuscire) dalla scrittura finale (che deve fallire). */
function conUpdateInErrore(client: SupabaseClient, tabella: string, err: ErrorePostgrest): SupabaseClient {
  return {
    from: (t: string) => {
      const builder = client.from(t) as unknown as Record<string, unknown>
      if (t !== tabella) return builder
      return new Proxy(builder, {
        get(target, prop, receiver) {
          if (prop === 'update') {
            return () => ({ eq: async () => ({ data: null, error: err }) })
          }
          return Reflect.get(target, prop, receiver)
        },
      })
    },
  } as unknown as SupabaseClient
}
