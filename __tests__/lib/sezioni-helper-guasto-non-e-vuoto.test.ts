import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'

/**
 * `src/lib/sezioni/docenti.ts` — GLI ALTRI QUATTRO LETTORI CHE BUTTAVANO VIA
 * `{ error }`.
 *
 * `docentiDiSezione` è stata corretta (ha il suo lock in
 * `docenti-sezione-guasto-non-e-vuoto.test.ts`); le altre quattro funzioni
 * esportate dallo stesso file no:
 *
 *     export async function sezioniDiUtente(…) {
 *       const { data } = await supabase.from('utenti_sezioni')…
 *       return (data ?? []).map(r => r.section_id)
 *     }
 *
 * **PostgREST non lancia** (AGENTS.md, regola 7): una lettura negata dalla RLS,
 * una tabella che il DB E2E non ha, un pool esaurito escono da qui come `[]` —
 * cioè come «questo docente non ha nessuna sezione». Indistinguibili, e a valle
 * la differenza pesa: `sezioniDiUtente` alimenta `assertAlunnoInScope`, cioè il
 * GATE che decide se un educator può leggere il fascicolo di un minore. Un
 * guasto che si traveste da «nessuna sezione» chiude la porta in faccia al
 * docente giusto e non lascia una riga per dirlo.
 *
 * Il ramo legittimo — nessun legame — deve restare MUTO: un logger loquace
 * acceca quanto uno muto, ed è la stessa regola già scritta per la funzione
 * gemella.
 */

const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import {
  sezioniDiUtente,
  nomiSezioniDiUtente,
  sezioniDiUtentePerGrado,
  materieDiDocenteInSezione,
} from '@/lib/sezioni/docenti'

const UTENTE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SEZIONE = '11111111-1111-4111-8111-111111111111'
const MATERIA = '22222222-2222-4222-8222-222222222222'

function dbBase(): DBFinto {
  return {
    utenti_sezioni: [{ utente_id: UTENTE, section_id: SEZIONE }],
    sections: [{ id: SEZIONE, name: '1 A', school_type: 'primaria' }],
    utenti_sezioni_materie: [{ utente_id: UTENTE, section_id: SEZIONE, materia_id: MATERIA }],
  }
}

/** Le righe `error` emesse, col loro `esito`. */
const erroriLoggati = (): string[] =>
  logEvento.mock.calls
    .filter((c) => c[1] === 'error' || c[1] === 'warn')
    .map((c) => (c[2] as { esito?: string })?.esito ?? '')

let db: DBFinto

beforeEach(() => {
  vi.clearAllMocks()
  db = dbBase()
})

describe('il percorso felice resta muto', () => {
  it('sezioniDiUtente restituisce le sezioni, senza una riga di log', async () => {
    const c = creaFintoSupabase(db)
    expect(await sezioniDiUtente(c, UTENTE)).toEqual([SEZIONE])
    expect(logEvento).not.toHaveBeenCalled()
  })

  it('nessun legame ⇒ [] e nessun log: è una condizione legittima', async () => {
    const c = creaFintoSupabase({ ...db, utenti_sezioni: [] })
    expect(await sezioniDiUtente(c, UTENTE)).toEqual([])
    expect(logEvento).not.toHaveBeenCalled()
  })
})

describe('una lettura fallita NON è «nessuna sezione»', () => {
  it('sezioniDiUtente: [] MA con una riga di log che dice il codice', async () => {
    const c = creaFintoSupabase(db, [], {
      errori: { utenti_sezioni: { code: '42501', message: 'permission denied' } },
    })
    expect(await sezioniDiUtente(c, UTENTE)).toEqual([])
    expect(erroriLoggati().join(' ')).toContain('sezioni-non-lette')
    expect(JSON.stringify(logEvento.mock.calls)).toContain('42501')
  })

  it('nomiSezioniDiUtente: idem, e non fa passare il vuoto per un dato', async () => {
    const c = creaFintoSupabase(db, [], {
      errori: { utenti_sezioni: { code: '42P01', message: 'relation does not exist' } },
    })
    expect(await nomiSezioniDiUtente(c, UTENTE)).toEqual([])
    expect(erroriLoggati().join(' ')).toContain('sezioni-non-lette')
  })

  it('sezioniDiUtentePerGrado: l’errore sulla lettura di `sections` lascia una riga', async () => {
    const c = creaFintoSupabase(db, [], {
      errori: { sections: { code: '42703', message: 'column does not exist' } },
    })
    expect(await sezioniDiUtentePerGrado(c, UTENTE, 'primaria')).toEqual([])
    expect(erroriLoggati().join(' ')).toContain('sezioni-non-lette')
  })

  it('materieDiDocenteInSezione: [] con la riga, mai «non insegna niente» in silenzio', async () => {
    const c = creaFintoSupabase(db, [], {
      errori: { utenti_sezioni_materie: { code: '42501', message: 'permission denied' } },
    })
    expect(await materieDiDocenteInSezione(c, UTENTE, SEZIONE)).toEqual([])
    expect(erroriLoggati().join(' ')).toContain('materie-non-lette')
  })
})

describe('mai dati personali in queste righe', () => {
  it('solo uuid, esiti ed enumerati', async () => {
    const c = creaFintoSupabase(db, [], {
      errori: { utenti_sezioni: { code: '42501', message: 'permission denied' } },
    })
    await sezioniDiUtente(c, UTENTE)
    const testo = JSON.stringify(logEvento.mock.calls)
    expect(testo).not.toMatch(/@/)
    expect(testo).not.toMatch(/nome|cognome/i)
  })
})
