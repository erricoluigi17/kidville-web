import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto, Riga, Scrittura, ErrorePostgrest } from '../fixtures/finto-supabase'
import { creaFintoSupabase } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// Compito 4.3.7 · l'import delle iscrizioni risolve il nome della classe sulle sezioni dell'anno ATTIVO.
//
// Due sezioni omonime di anni diversi (la «4 ANNI A» di oggi e la «4 Anni A» del 2027/28, creata in anticipo):
// l'alunno deve finire col nome di quella di oggi. La futura è messa PRIMA nell'elenco, così senza il filtro vincerebbe.
// Con lo schema dell'anno indietro (la CI) nessun filtro e nessun errore.
// =============================================================================

const A2 = 'a2222222-2222-4222-8222-222222222222'
const A3 = 'a3333333-3333-4333-8333-333333333333'
const S2 = 'b2222222-2222-4222-8222-aaaaaaaaaaaa'
const S3 = 'b3333333-3333-4333-8333-aaaaaaaaaaaa'
const DOMANDA = 'f0000000-0000-4000-8000-000000000001'
const OGGI = '4 ANNI A'
const DOMANI = '4 Anni A' // stesso testo normalizzato, maiuscole diverse
const GREZZO = { codice_fiscale: 'RSSMRA20A01H501X', data_nascita: '2020-01-01' }

const h = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ ...h, EVENTI_PERSISTITI: new Set(['iscrizione', 'anagrafica']) }))

import { alunnoDiRiferimento } from '@/lib/iscrizioni/import/esegui'

const assegnazione = (classe: string) =>
  ({ nome: 'Mario', cognome: 'Rossi', classe, retta: 150 }) as Parameters<typeof alunnoDiRiferimento>[2]

const dbBase = (): DBFinto => ({
  anni_sede: [
    { id: S2, scuola_id: SEDE_A, anno_id: A2, stato: 'corrente', domande_aperte: false },
    { id: S3, scuola_id: SEDE_A, anno_id: A3, stato: 'in_preparazione', domande_aperte: false },
  ],
  sections: [
    { id: 's-futura', scuola_id: SEDE_A, name: DOMANI, anno_id: A3 },
    { id: 's-attiva', scuola_id: SEDE_A, name: OGGI, anno_id: A2 },
  ],
  alunni: [],
})

let scritture: Scrittura[]
const client = (db: DBFinto, errori?: Record<string, ErrorePostgrest>) => {
  scritture = []
  return creaFintoSupabase(db, [], {
    scritture,
    errori,
    rpc: { iscrizioni_segna_creato: () => ({ data: null, error: null }), anno_attivo: () => ({ data: S2, error: null }) },
  })
}
const scritto = () => {
  const s = scritture.filter((x) => x.tabella === 'alunni')
  expect(s.length).toBeGreaterThan(0)
  return s[s.length - 1].valori[0] as Riga
}

beforeEach(() => vi.clearAllMocks())

describe('alunnoDiRiferimento · il nome canonico viene dall\'anno attivo', () => {
  it('con due omonime di anni diversi scrive il nome di quella ATTIVA, non della futura', async () => {
    await alunnoDiRiferimento(client(dbBase()), GREZZO, assegnazione('4 anni  a'), SEDE_A, DOMANDA)
    expect(scritto().classe_sezione).toBe(OGGI)
  })

  it('con lo schema dell\'anno indietro: nessun filtro e nessun errore', async () => {
    const db = dbBase()
    db.sections = db.sections.map((s) => {
      const c = { ...s }
      delete c.anno_id
      return c
    })
    const esito = await alunnoDiRiferimento(
      client(db, { anni_sede: { code: 'PGRST205', message: 'no table' } }), GREZZO, assegnazione('4 anni  a'), SEDE_A, DOMANDA,
    )
    expect(esito).not.toHaveProperty('errore')
    // senza filtro vince la prima omonima trovata: l'importante è che scriva un nome canonico, non il grezzo
    expect([OGGI, DOMANI]).toContain(scritto().classe_sezione)
  })
})
