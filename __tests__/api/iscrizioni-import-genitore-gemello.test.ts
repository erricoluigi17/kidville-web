import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { creaFintoSupabase } from '../fixtures/finto-supabase'

/**
 * IMPORT MASSIVO — IL GENITORE GEMELLO SI RIUSA, NON SI DUPLICA.
 *
 * Il 2026-09-14, fra le sette coppie di alunni doppi sanate a mano, una aveva anche
 * la scheda GENITORE doppia: nata dalla seconda domanda della famiglia, con un refuso
 * nel codice fiscale dell'adulto. La deduplica dei genitori cercava solo il codice
 * identico, quindi il refuso creava una seconda scheda per la stessa persona — e una
 * sorella risultava collegata a entrambe.
 *
 * Qui si prova `parentDiRiferimento`, cioè CHE COSA finisce nel database: una scheda
 * gemella UNICA si riusa (niente INSERT, niente `iscrizioni_segna_creato`, perché una
 * scheda riusata non va disfatta se l'invito fallisce); più di una, o una lettura
 * fallita, lasciano il comportamento di prima.
 *
 * ⚠️ DATI DI PROVA: nomi convenzionali e codici col catastale `Z999`, di nessuno.
 */

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ ...log, EVENTI_PERSISTITI: new Set(['iscrizione', 'anagrafica']) }))

import { parentDiRiferimento } from '@/lib/iscrizioni/import/esegui'

const SEDE = 'a1a1a1a1-0000-4000-8000-000000000001'
const DOMANDA = 'f0f0f0f0-0000-4000-8000-000000000010'
const GENITORE = 'd4d4d4d4-0000-4000-8000-000000000005'
const ALTRO_GENITORE = 'd4d4d4d4-0000-4000-8000-000000000077'

/** Valido: donna, 10 giugno 1985, catastale Z999. */
const CF_ADULTO = 'XQQYKV85H50Z999J'
/** Lo stesso codice col carattere di controllo sbagliato. */
const CF_REFUSO = 'XQQYKV85H50Z999K'

const scheda = (over: Record<string, unknown> = {}) => ({
  id: GENITORE,
  first_name: 'Anna',
  last_name: 'Bianchi',
  birth_date: '1985-06-10',
  fiscal_code: CF_ADULTO,
  auth_user_id: null,
  emails: ['anna@example.test'],
  anonimizzato_il: null,
  ...over,
})

const dallaDomanda = (over: Record<string, unknown> = {}) => ({
  first_name: 'anna ',
  last_name: 'BIANCHI',
  birth_date: '1985-06-10',
  fiscal_code: CF_REFUSO,
  email: 'anna@example.test',
  ruolo: 'madre',
  ...over,
})

let scritture: Scrittura[]
let segnati: Record<string, unknown>[]
const client = (db: DBFinto, errori?: Record<string, { code: string; message?: string }>) => {
  scritture = []
  segnati = []
  return creaFintoSupabase(db, [], {
    scritture,
    errori,
    rpc: {
      iscrizioni_segna_creato: (args) => {
        segnati.push(args)
        return { data: null, error: null }
      },
    },
  })
}

const eventi = (esito: string) =>
  log.logEvento.mock.calls.filter((c) => (c[2] as Record<string, unknown> | undefined)?.esito === esito)

beforeEach(() => vi.clearAllMocks())

describe('parentDiRiferimento — il genitore gemello', () => {
  it('UNA scheda con lo stesso nome e la stessa data, codice diverso ⇒ si riusa: nessun INSERT, nulla da disfare', async () => {
    const esito = await parentDiRiferimento(client({ parents: [scheda()] }), dallaDomanda(), DOMANDA, { scuolaId: SEDE, indice: 0 })

    expect(esito).toEqual({ id: GENITORE, creato: false })
    expect(scritture.filter((s) => s.tabella === 'parents')).toEqual([])
    // Una scheda RIUSATA è di una famiglia già in archivio: se l'invito fallisce,
    // `iscrizioni_annulla` non deve cancellarla. Per questo non si segna.
    expect(segnati).toEqual([])

    const [riga] = eventi('genitore-abbinato-per-anagrafica')
    expect(riga?.[0]).toBe('iscrizione')
    expect(riga?.[1]).toBe('warn')
    expect(riga?.[2]).toMatchObject({ entita: 'genitore', indice: 1, sede_id: SEDE, entita_id: DOMANDA, genitore_esistente_id: GENITORE })
    const scritto = JSON.stringify(riga?.[2])
    for (const dato of ['Anna', 'Bianchi', 'BIANCHI', CF_ADULTO, CF_REFUSO, '1985-06-10', 'anna@example.test']) {
      expect(scritto).not.toContain(dato)
    }
  })

  it('stesso codice fiscale ⇒ il riuso di sempre, senza avvisi di gemello', async () => {
    const esito = await parentDiRiferimento(
      client({ parents: [scheda()] }),
      dallaDomanda({ fiscal_code: CF_ADULTO }),
      DOMANDA,
      { scuolaId: SEDE, indice: 0 },
    )
    expect(esito).toEqual({ id: GENITORE, creato: false })
    expect(eventi('genitore-abbinato-per-anagrafica')).toEqual([])
  })

  it('PIÙ schede gemelle ⇒ si crea come prima (non si sceglie), e lo si scrive nel log', async () => {
    const esito = await parentDiRiferimento(
      client({ parents: [scheda(), scheda({ id: ALTRO_GENITORE, fiscal_code: null })] }),
      dallaDomanda(),
      DOMANDA,
      { scuolaId: SEDE, indice: 1 },
    )
    expect(esito).toMatchObject({ creato: true })
    expect(scritture.filter((s) => s.tabella === 'parents' && s.operazione === 'insert')).toHaveLength(1)
    const [riga] = eventi('possibile-doppione')
    expect(riga?.[1]).toBe('warn')
    expect(riga?.[2]).toMatchObject({ entita: 'genitore', indice: 2, n: 2 })
  })

  it('nessuna scheda gemella ⇒ si crea come prima', async () => {
    const esito = await parentDiRiferimento(
      client({ parents: [scheda({ first_name: 'Anita' })] }),
      dallaDomanda(),
      DOMANDA,
      { scuolaId: SEDE, indice: 0 },
    )
    expect(esito).toMatchObject({ creato: true })
    expect(segnati).toHaveLength(1)
  })

  it('la ricerca del gemello fallisce ⇒ si crea come prima: non sapere non è bocciare (ma resta nel log)', async () => {
    // Solo la SECONDA lettura di `parents` cade: la prima (per codice) deve riuscire,
    // altrimenti la funzione si fermerebbe prima di arrivare al gemello.
    let letture = 0
    const db: DBFinto = { parents: [scheda()] }
    const base = client(db)
    const conGuasto = new Proxy(base, {
      get(bersaglio, chiave, ricevitore) {
        if (chiave !== 'from') return Reflect.get(bersaglio, chiave, ricevitore)
        return (tabella: string) => {
          if (tabella === 'parents' && ++letture === 2) {
            return creaFintoSupabase(db, [], { errori: { parents: { code: '08006', message: 'boom' } } }).from('parents')
          }
          return bersaglio.from(tabella)
        }
      },
    })

    const esito = await parentDiRiferimento(conGuasto, dallaDomanda(), DOMANDA, { scuolaId: SEDE, indice: 0 })
    expect(esito).toMatchObject({ creato: true })
    const [riga] = eventi('gemello-non-verificabile')
    expect(riga?.[1]).toBe('error')
  })
})
