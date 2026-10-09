import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto, Riga, Scrittura } from '../fixtures/finto-supabase'
import { creaFintoSupabase } from '../fixtures/finto-supabase'

/**
 * L'IMPORT A ELENCO PORTA I DATI SANITARI ANCHE SULLA SCHEDA CHE ESISTE GIÀ.
 *
 * Fino al 2026-10-09 il ramo «esiste già in sede» di `alunnoDiRiferimento`
 * scriveva solo classe, retta e consensi foto; poi il job notturno toglieva
 * allergie e note mediche dalla domanda. Il dato della famiglia non arrivava
 * mai dove lo legge la cucina. La regola sta in `@/lib/iscrizioni/sanitari`:
 * riempi il vuoto, non sovrascrivere, aggiungi in coda ciò che è diverso.
 *
 * Solo dati finti.
 */

const SEDE = 'd53b0fbc-0000-4000-8000-00000000000a'
const SEC = 'c4a00000-0000-4000-8000-00000000004a'
const DOMANDA = 'f0000000-0000-4000-8000-000000000002'
const CF = 'RSSMRA20A01H501X'

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({
  ...log,
  EVENTI_PERSISTITI: new Set(['iscrizione', 'anagrafica']),
}))

import { alunnoDiRiferimento } from '@/lib/iscrizioni/import/esegui'

const assegnazione = { nome: 'Mario', cognome: 'Rossi', classe: '4 ANNI A', retta: 150 } as Parameters<
  typeof alunnoDiRiferimento
>[2]

let scritture: Scrittura[]
const importa = async (scheda: Riga, grezzo: Riga) => {
  const db: DBFinto = {
    sections: [{ id: SEC, scuola_id: SEDE, name: '4 ANNI A' }],
    alunni: [{ id: 'esistente', scuola_id: SEDE, codice_fiscale: CF, ...scheda }],
  }
  scritture = []
  const client = creaFintoSupabase(db, [], {
    scritture,
    rpc: { iscrizioni_segna_creato: () => ({ data: null, error: null }) },
  })
  const esito = await alunnoDiRiferimento(client, { codice_fiscale: CF, ...grezzo }, assegnazione, SEDE, DOMANDA)
  const s = scritture.filter((x) => x.tabella === 'alunni')
  expect(s.length, 'nessuna scrittura su `alunni`').toBe(1)
  return { esito, patch: s[0].valori[0] as Riga }
}

beforeEach(() => vi.clearAllMocks())

describe('import a elenco — scheda già esistente', () => {
  it('scheda vuota: allergie e note della domanda entrano nella stessa patch di classe e retta', async () => {
    const { esito, patch } = await importa({ allergies: null, note_mediche: null }, { allergies: 'Kiwi', note_mediche: 'Asma' })
    expect(esito).toEqual({ id: 'esistente' })
    expect(patch).toMatchObject({ classe_sezione: '4 ANNI A', importo_retta_mensile: 150, allergies: 'Kiwi', note_mediche: 'Asma' })
  })

  it('la scheda contiene già i dati: la patch non li nomina nemmeno', async () => {
    const { patch } = await importa({ allergies: 'kiwi e fragole', note_mediche: 'Asma' }, { allergies: 'KIWI', note_mediche: 'asma' })
    expect('allergies' in patch).toBe(false)
    expect('note_mediche' in patch).toBe(false)
  })

  it('la scheda dice altro: niente sovrascrittura, la dichiarazione nuova va in coda', async () => {
    const { patch } = await importa({ allergies: 'Arachidi' }, { allergies: 'nessuna' })
    expect(String(patch.allergies)).toMatch(/^Arachidi\nDalla domanda di iscrizione del \d{2}\/\d{2}\/\d{4}: nessuna$/)
  })
})
