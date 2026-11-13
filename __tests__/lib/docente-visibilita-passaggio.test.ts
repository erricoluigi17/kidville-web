import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'

/**
 * DOPO IL PASSAGGIO, CHE COSA VEDE UN DOCENTE (PR 4.8.3).
 *
 *  · il docente della sezione VECCHIA (anno `in_chiusura`/`chiuso`) la vede in sola lettura: anagrafica e fascicolo restano
 *    consultabili (`sezioniAnagraficaVisibili`);
 *  · ma non ha in RUBRICA le famiglie di quella classe: la rubrica serve a iniziare una chat, cioè a scrivere, e un bambino
 *    uscito dal passaggio o già passato alla classe nuova non è più «suo». La rubrica guarda le FREQUENZE vive, come il POST
 *    della chat e come `figli_attivi` per le famiglie, non la riga di `alunni`, che dopo il passaggio può essere ancora vecchia;
 *  · i selettori che decidono una scrittura (`soloScrivibili`) mostrano solo le sezioni dell'anno attivo.
 *
 * Client finti, nessun database. Le funzioni SQL vere sono provate in `__tests__/db/`.
 */

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return { ...reale, logEvento: h.logEvento }
})

import { rubricaDiOperatore } from '@/lib/chat/rubrica'
import { sezioniAnagraficaVisibili } from '@/lib/anagrafiche/docente/visibilita'
import { nomiSezioniDiUtente, sezioniVisibiliDiUtente } from '@/lib/sezioni/docenti'

const SEDE = '20000000-0000-4000-8000-000000000002'
const SEZ_VECCHIA = '30000000-0000-4000-8000-000000000003'
const SEZ_NUOVA = '30000000-0000-4000-8000-000000000004'
const DOC_VECCHIO = 'd0000000-0000-4000-8000-0000000000d1'
const DOC_NUOVO = 'd0000000-0000-4000-8000-0000000000d2'
const GEN_CONTINUA = 'e0000000-0000-4000-8000-0000000000e1'
const GEN_USCITO = 'e0000000-0000-4000-8000-0000000000e2'
const GEN_STALE = 'e0000000-0000-4000-8000-0000000000e3'
const CONTINUA = 'a0000000-0000-4000-8000-0000000000a1'
const USCITO = 'a0000000-0000-4000-8000-0000000000a2'
/** Continua, ma la sua riga di `alunni` porta ancora la sezione VECCHIA (specchio non ancora allineato). */
const STALE = 'a0000000-0000-4000-8000-0000000000a3'

const VISIBILI_VECCHIO = [{ section_id: SEZ_VECCHIA, sola_lettura: true }]
const VISIBILI_NUOVO = [{ section_id: SEZ_NUOVA, sola_lettura: false }]

/** Le sole frequenze vive nell'anno attivo: l'uscito non ne ha. */
const FREQUENZE_VIVE = [
  { alunno_id: CONTINUA, frequenza_id: 'f0000000-0000-4000-8000-0000000000f1', section_id: SEZ_NUOVA, scuola_id: SEDE },
  { alunno_id: STALE, frequenza_id: 'f0000000-0000-4000-8000-0000000000f3', section_id: SEZ_NUOVA, scuola_id: SEDE },
]

const db = (): DBFinto => ({
  sections: [
    { id: SEZ_VECCHIA, scuola_id: SEDE, name: '3 ANNI A' },
    { id: SEZ_NUOVA, scuola_id: SEDE, name: '4 ANNI A' },
  ],
  utenti_sezioni: [
    { utente_id: DOC_VECCHIO, section_id: SEZ_VECCHIA },
    { utente_id: DOC_NUOVO, section_id: SEZ_NUOVA },
  ],
  utenti: [
    { id: DOC_VECCHIO, ruolo: 'educator', attivo: true, scuola_id: SEDE },
    { id: DOC_NUOVO, ruolo: 'educator', attivo: true, scuola_id: SEDE },
    { id: GEN_CONTINUA, ruolo: 'genitore', attivo: true, scuola_id: SEDE },
    { id: GEN_USCITO, ruolo: 'genitore', attivo: true, scuola_id: SEDE },
    { id: GEN_STALE, ruolo: 'genitore', attivo: true, scuola_id: SEDE },
  ],
  alunni: [
    { id: CONTINUA, nome: 'A', cognome: 'B', classe_sezione: '4 ANNI A', section_id: SEZ_NUOVA, scuola_id: SEDE, stato: 'iscritto' },
    { id: USCITO, nome: 'C', cognome: 'D', classe_sezione: '3 ANNI A', section_id: SEZ_VECCHIA, scuola_id: SEDE, stato: 'iscritto' },
    { id: STALE, nome: 'E', cognome: 'F', classe_sezione: '3 ANNI A', section_id: SEZ_VECCHIA, scuola_id: SEDE, stato: 'iscritto' },
  ],
  legame_genitori_alunni: [
    { genitore_id: GEN_CONTINUA, alunno_id: CONTINUA },
    { genitore_id: GEN_USCITO, alunno_id: USCITO },
    { genitore_id: GEN_STALE, alunno_id: STALE },
  ],
  student_parents: [],
  parents: [],
})

type Rpc = Record<string, (a: Record<string, unknown>) => unknown>
function client(rpc: Rpc = {}): SupabaseClient {
  return creaFintoSupabase(db(), [], {
    rpc: {
      sezioni_visibili_docente: (a: Record<string, unknown>) => ({
        data: a.p_utente === DOC_VECCHIO ? VISIBILI_VECCHIO : VISIBILI_NUOVO,
        error: null,
      }),
      frequenze_attive: (a: Record<string, unknown>) => ({
        data: FREQUENZE_VIVE.filter((f) => (a.p_alunni as string[]).includes(f.alunno_id)),
        error: null,
      }),
      ...rpc,
    } as never,
  }) as SupabaseClient
}

const docente = (id: string) => ({ id, role: 'educator', scuola_id: SEDE }) as never
const alunniInRubrica = async (supabase: SupabaseClient, id: string) =>
  (await rubricaDiOperatore(supabase, docente(id))).voci.map((v) => v.alunno.id).sort()

beforeEach(() => vi.clearAllMocks())

describe('la rubrica del docente guarda le frequenze vive', () => {
  it('il docente della classe nuova ha la famiglia di chi continua', async () => {
    expect(await alunniInRubrica(client(), DOC_NUOVO)).toEqual([CONTINUA])
  })

  it('il docente della sezione vecchia (sola lettura) non ha in rubrica né chi è uscito né chi è passato alla classe nuova', async () => {
    const r = await rubricaDiOperatore(client(), docente(DOC_VECCHIO))
    expect(r.voci).toEqual([])
    expect(r.errore).toBeNull()
  })

  it('schema indietro (CI): come oggi, cioè per `alunni.section_id`, e una riga `info`', async () => {
    const supabase = client({ frequenze_attive: () => ({ data: null, error: { code: 'PGRST202', message: 'assente' } }) })
    expect(await alunniInRubrica(supabase, DOC_VECCHIO)).toEqual([STALE, USCITO].sort())
    expect(h.logEvento.mock.calls.some((c) => c[1] === 'info' && (c[2] as { esito?: string }).esito === 'schema-indietro')).toBe(true)
    expect(h.logEvento.mock.calls.some((c) => c[1] === 'error')).toBe(false)
  })

  it('un guasto della funzione NON apre la lista larga: rubrica vuota con l’errore, e una riga `error`', async () => {
    const supabase = client({ frequenze_attive: () => ({ data: null, error: { code: 'XX000', message: 'boom' } }) })
    const r = await rubricaDiOperatore(supabase, docente(DOC_VECCHIO))
    expect(r.voci).toEqual([])
    expect(r.errore).toMatchObject({ code: 'XX000' })
    expect(h.logEvento.mock.calls.some((c) => c[1] === 'error')).toBe(true)
  })
})

describe('il docente della sezione vecchia la vede, in sola lettura', () => {
  it('l’anagrafica: la sezione vecchia è fra le visibili, quella nuova no', async () => {
    const r = await sezioniAnagraficaVisibili(client(), docente(DOC_VECCHIO))
    expect(r).toEqual({ esito: 'sezioni', sezioni: [SEZ_VECCHIA] })
  })

  it('i selettori che decidono una scrittura mostrano solo le sezioni dell’anno attivo', async () => {
    const supabase = client()
    expect(await sezioniVisibiliDiUtente(supabase, DOC_VECCHIO, { soloScrivibili: true })).toEqual([])
    expect(await nomiSezioniDiUtente(supabase, DOC_VECCHIO, { soloScrivibili: true })).toEqual([])
    expect(await nomiSezioniDiUtente(supabase, DOC_NUOVO, { soloScrivibili: true })).toEqual(['4 ANNI A'])
    // In lettura la vecchia c'è, marcata sola lettura.
    expect(await sezioniVisibiliDiUtente(supabase, DOC_VECCHIO)).toEqual([{ sectionId: SEZ_VECCHIA, solaLettura: true }])
  })
})
