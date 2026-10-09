import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Riga } from '../fixtures/finto-supabase'

// =============================================================================
// L'OBLIO DI UN BAMBINO SVUOTA ANCHE LA SCATOLA NERA (2026-10-09).
//
// Ogni riga cancellata dalle tabelle preziose resta 90 giorni in
// `scatola_nera.eliminazioni`: senza questo passo, chi chiede di essere
// dimenticato resterebbe leggibile lì. Si chiama per ULTIMO (i passi prima
// cancellano righe anche loro), con il solo uuid del bambino; un rifiuto è un
// oblio non completo. La funzione SQL è provata su Postgres in
// `scatola-nera-sql.test.ts`: qui si prova che l'oblio la chiama, e come.
// =============================================================================

const spie = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ ...spie, EVENTI_PERSISTITI: new Set(['gdpr']) }))

import { anonimizzaAlunno } from '@/lib/gdpr/esegui'

const AT = '2026-10-09T09:00:00Z'
const BIMBO = 'aaaaaaaa-0000-4000-8000-00000000000a'
const RPC_OBLIO_VIDEO = {
  video_intent_oblio_alunno: async () => ({ data: { ok: true, intenti: 0, revocati: 0 }, error: null }),
}

const db = (): DBFinto => ({ presenze: [] })

beforeEach(() => vi.clearAllMocks())

describe('anonimizzaAlunno — la scatola nera', () => {
  it('chiama `scatola_nera_dimentica` UNA volta, col solo uuid del bambino, e ne riporta le righe', async () => {
    const chiamate: Riga[] = []
    const client = creaFintoSupabase(db(), [], {
      rpc: {
        ...RPC_OBLIO_VIDEO,
        scatola_nera_dimentica: (args) => {
          chiamate.push(args)
          return { data: 7, error: null }
        },
      },
    })

    const r = await anonimizzaAlunno(client, { id: BIMBO }, AT, 'admin/gdpr/erase:POST')

    expect(chiamate).toEqual([{ p_soggetti: [BIMBO], p_tipo: 'alunno', p_canale: 'admin/gdpr/erase:POST' }])
    expect(r.scatolaNeraDimenticate).toBe(7)
    expect(r.lettureFallite).toBe(0)
    const successo = spie.logEvento.mock.calls.find((c) => (c[2] as { esito?: string }).esito === 'scatola-nera-dimenticata')
    expect(successo?.[2]).toMatchObject({ n: 7, entita_tipo: 'alunno' })
    expect(JSON.stringify(spie.logEvento.mock.calls), 'l’uuid del bambino è finito nei log').not.toContain(BIMBO)
  })

  it('una scatola che rifiuta: una lettura fallita in più, e un errore nel log', async () => {
    const client = creaFintoSupabase(db(), [], {
      rpc: {
        ...RPC_OBLIO_VIDEO,
        scatola_nera_dimentica: () => ({ data: null, error: { code: '57014', message: 'tempo scaduto' } }),
      },
    })

    const r = await anonimizzaAlunno(client, { id: BIMBO }, AT, 'test')

    expect(r.lettureFallite).toBe(1)
    expect(r.scatolaNeraDimenticate).toBe(0)
    const errore = spie.logEvento.mock.calls.find((c) => (c[2] as { esito?: string }).esito === 'scatola-nera-non-dimenticata')
    expect(errore?.[1]).toBe('error')
  })
})
