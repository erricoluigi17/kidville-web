import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../../fixtures/finto-supabase'

/**
 * COMPITO 4.5.4-bis · le news e il digest non raggiungono la famiglia di un bambino «in arrivo».
 *
 * `caricaFigliConTarget` parte dai figli attivi per la funzione SQL `figli_attivi`; dove la funzione non c'è (la CI, lo schema
 * indietro) riparte dai figli COLLEGATI. Un bambino la cui domanda è per l'anno dopo è collegato, ha una sede e nessuna classe:
 * senza un filtro sullo stato, un post «per tutta la sede» arriverebbe a una famiglia che non è ancora a scuola.
 * Il database finto filtra davvero; solo uuid finti.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const GEN = '99999999-9999-4999-8999-999999999991'
const FIGLIO = '11111111-1111-4111-8111-111111111111'
const ARRIVO = '11111111-1111-4111-8111-111111111119'
const SEZ = '55555555-5555-4555-8555-555555555551'

const h = vi.hoisted(() => ({ collegati: [] as string[] }))
vi.mock('@/lib/anagrafiche/legami', () => ({ getFigliDiGenitore: async () => h.collegati }))

import { caricaFigliConTarget, postVisibileAiFigli } from '@/lib/news/target'

const schemaIndietro = () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })

let db: DBFinto
beforeEach(() => {
  db = {
    alunni: [
      { id: FIGLIO, scuola_id: SEDE, classe_sezione: 'Girasoli', section_id: SEZ, stato: 'iscritto', sections: { school_type: 'infanzia' } },
      { id: ARRIVO, scuola_id: SEDE, classe_sezione: null, section_id: null, stato: 'in_arrivo', sections: null },
    ],
  } as DBFinto
})

const carica = () => caricaFigliConTarget(creaFintoSupabase(db, [], { rpc: { figli_attivi: schemaIndietro } }) as never, GEN)

describe('caricaFigliConTarget · schema indietro', () => {
  it('il bambino in arrivo non è fra i figli del target: un post della sede non arriva a una famiglia che ha solo lui', async () => {
    h.collegati = [ARRIVO]
    const figli = await carica()
    expect(figli).toEqual([])
    expect(postVisibileAiFigli({ scuola_id: SEDE, target_scope: 'globale', target_gradi: null, target_classes: null }, figli)).toBe(false)
  })

  it('con un fratello che frequenta resta solo il fratello', async () => {
    h.collegati = [FIGLIO, ARRIVO]
    const figli = await carica()
    expect(figli).toHaveLength(1)
    expect(figli[0]).toMatchObject({ scuola_id: SEDE, classe_sezione: 'Girasoli', section_id: SEZ })
  })
})
