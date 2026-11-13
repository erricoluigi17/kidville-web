import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'

/**
 * DOPO IL PASSAGGIO, «ATTIVO» VUOL DIRE LA STESSA COSA DAPPERTUTTO (PR 4.8.3).
 *
 * Prima il gate dei genitori (`verificaAlunnoAttivo`) guardava solo `alunni` (sezione, stato, archiviazione), mentre l'elenco
 * dei figli, la galleria e gli avvisi guardavano `figli_attivi`, cioè la frequenza viva nell'anno attivo della sede. Dopo il
 * passaggio le due risposte divergono: il bambino che NON continua ha ancora la riga `alunni` con classe e stato «iscritto» (la
 * segreteria la archivia dopo), quindi il gate lo dava «attivo» mentre `figli_attivi` non lo elenca più.
 *
 * Il client è finto: la funzione SQL `frequenze_attive` (che sta sotto `figli_attivi`) è emulata da UNA tabella di frequenze,
 * la stessa per i due lati del confronto. La funzione vera è provata su Postgres in `__tests__/db/anno-visibilita-genitore.test.ts`.
 */

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return { ...reale, logEvento: h.logEvento }
})

import { verificaAlunnoAttivo } from '@/lib/alunni/attivo'
import { esitoFiglioAttivo } from '@/lib/anno/visibilita-genitore'

const GENITORE = '10000000-0000-4000-8000-000000000001'
const SEDE = '20000000-0000-4000-8000-000000000002'
const SEZ_VECCHIA = '30000000-0000-4000-8000-000000000003'
const SEZ_NUOVA = '30000000-0000-4000-8000-000000000004'
const CONTINUA = 'a0000000-0000-4000-8000-0000000000a1'
const USCITO = 'a0000000-0000-4000-8000-0000000000a2'
const ARCHIVIATO = 'a0000000-0000-4000-8000-0000000000a3'

type Frequenza = { alunno_id: string; frequenza_id: string; section_id: string; scuola_id: string }

/** Le sole frequenze VIVE nell'anno attivo (dopo il passaggio): l'uscito non ne ha. */
const FREQUENZE_VIVE: Frequenza[] = [
  { alunno_id: CONTINUA, frequenza_id: 'f0000000-0000-4000-8000-0000000000f1', section_id: SEZ_NUOVA, scuola_id: SEDE },
]

const db = (): DBFinto => ({
  alunni: [
    { id: CONTINUA, scuola_id: SEDE, section_id: SEZ_NUOVA, stato: 'iscritto', archiviato_il: null },
    // ⚠️ La riga di `alunni` dell'uscito è ancora «normale»: classe vecchia, stato iscritto, non archiviata.
    { id: USCITO, scuola_id: SEDE, section_id: SEZ_VECCHIA, stato: 'iscritto', archiviato_il: null },
    { id: ARCHIVIATO, scuola_id: SEDE, section_id: null, stato: 'ritirato', archiviato_il: '2026-06-30T10:00:00Z' },
  ],
  legame_genitori_alunni: [
    { genitore_id: GENITORE, alunno_id: CONTINUA },
    { genitore_id: GENITORE, alunno_id: USCITO },
  ],
})

/** Una sola fonte per le due funzioni, come in SQL: `figli_attivi` è `frequenze_attive` sui figli collegati. */
function client(opzioni: { rpc?: Record<string, (a: Record<string, unknown>) => unknown> } = {}) {
  const chiamate: Array<{ nome: string; args: Record<string, unknown> }> = []
  const frequenzeAttive = (args: Record<string, unknown>) => {
    chiamate.push({ nome: 'frequenze_attive', args })
    const ids = args.p_alunni as string[]
    return { data: FREQUENZE_VIVE.filter((f) => ids.includes(f.alunno_id)), error: null }
  }
  const supabase = creaFintoSupabase(db(), [], {
    rpc: {
      frequenze_attive: frequenzeAttive,
      figli_attivi: () => ({ data: FREQUENZE_VIVE, error: null }),
      ...(opzioni.rpc ?? {}),
    } as never,
  }) as SupabaseClient
  return { supabase, chiamate }
}

beforeEach(() => vi.clearAllMocks())

describe('verificaAlunnoAttivo dopo il passaggio', () => {
  it('un bambino uscito dal passaggio non è attivo, anche se la sua riga di `alunni` è ancora normale', async () => {
    const { supabase } = client()
    expect(await verificaAlunnoAttivo(supabase, USCITO)).toBe('nascosto')
  })

  it('un bambino che continua lo è', async () => {
    const { supabase, chiamate } = client()
    expect(await verificaAlunnoAttivo(supabase, CONTINUA)).toBe('attivo')
    // La domanda alla funzione è per UN bambino, mai per un parametro del client.
    expect(chiamate).toEqual([{ nome: 'frequenze_attive', args: { p_alunni: [CONTINUA] } }])
  })

  it('un archiviato è nascosto già da `alunni`: la funzione non si chiama nemmeno (una lettura in meno)', async () => {
    const { supabase, chiamate } = client()
    expect(await verificaAlunnoAttivo(supabase, ARCHIVIATO)).toBe('nascosto')
    expect(chiamate).toEqual([])
  })

  it('concorda con `figli_attivi` per ogni figlio del genitore, sulla stessa tabella di frequenze', async () => {
    const { supabase } = client()
    for (const figlio of [CONTINUA, USCITO]) {
      const lato = await esitoFiglioAttivo(supabase, GENITORE, figlio)
      const gate = await verificaAlunnoAttivo(supabase, figlio)
      expect(gate === 'attivo').toBe(lato === 'attivo')
    }
  })
})

describe('verificaAlunnoAttivo con lo schema dell’anno indietro (DB della CI)', () => {
  it.each(['PGRST202', '42883'])('funzione assente (%s): come oggi, e una riga `info`', async (code) => {
    const { supabase } = client({ rpc: { frequenze_attive: () => ({ data: null, error: { code, message: 'funzione assente' } }) } })
    // Come oggi: decide solo `alunni`, quindi l'uscito risulta ancora attivo.
    expect(await verificaAlunnoAttivo(supabase, USCITO)).toBe('attivo')
    const righe = h.logEvento.mock.calls.map((c) => ({ canale: c[0], livello: c[1], campi: c[2] }))
    expect(righe.some((r) => r.livello === 'info' && (r.campi as { esito?: string }).esito === 'schema-indietro')).toBe(true)
    expect(righe.some((r) => r.livello === 'error')).toBe(false)
  })

  it('un guasto della funzione (non lo schema) è `non-letto` con una riga `error`: mai un `nascosto` inventato', async () => {
    const { supabase } = client({ rpc: { frequenze_attive: () => ({ data: null, error: { code: 'XX000', message: 'boom' } }) } })
    expect(await verificaAlunnoAttivo(supabase, USCITO)).toBe('non-letto')
    expect(h.logEvento.mock.calls.some((c) => c[1] === 'error')).toBe(true)
  })

  it('la funzione che LANCIA (rete) è `non-letto`, non un’eccezione', async () => {
    const { supabase } = client({ rpc: { frequenze_attive: () => { throw new Error('rete') } } })
    expect(await verificaAlunnoAttivo(supabase, CONTINUA)).toBe('non-letto')
  })
})
