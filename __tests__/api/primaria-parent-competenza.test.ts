import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'

const h = vi.hoisted(() => ({ db: {} as DBFinto, schemaVecchio: false, selezioni: [] as string[] }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: async () => ({ user: { id: 'genitore', role: 'genitore' } }) }))
vi.mock('@/lib/logging/logger', async originale => ({ ...await originale<Record<string, unknown>>(), logErrore: vi.fn(), logEvento: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => {
  const db = creaFintoSupabase(h.db)
  const from = db.from.bind(db)
  db.from = ((nome: string) => {
    const q = from(nome)
    const select = q.select.bind(q)
    q.select = ((colonne: string) => {
      h.selezioni.push(colonne)
      if (h.schemaVecchio && colonne.includes('data_evento')) {
        const senza: Record<string, unknown> = {}
        for (const metodo of ['eq', 'lte', 'order']) senza[metodo] = () => senza
        senza.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { code: '42703', message: 'column data_evento does not exist' } }).then(resolve)
        return senza
      }
      return select(colonne)
    }) as typeof q.select
    return q
  }) as typeof db.from
  return db
} }))

import { GET as note } from '@/app/api/parent/primaria/note/route'
import { GET as valutazioni } from '@/app/api/parent/primaria/valutazioni/route'
const ALUNNO = '11111111-1111-4111-8111-111111111111'
const req = () => new NextRequest(`http://test/api/parent/primaria/note?studentId=${ALUNNO}`)

beforeEach(() => {
  h.schemaVecchio = false
  h.selezioni = []
  h.db = {
    alunni: [{ id: ALUNNO, section_id: 'classe', scuola_id: 'sede' }],
    admin_settings: [],
    materie: [{ id: 'materia', section_id: 'classe', nome: 'Materia fittizia', attiva: true, ordine: 0 }],
    valutazioni: [{ id: 'voto', alunno_id: ALUNNO, materia_id: 'materia', tipo: 'orale', modalita: 'sintetico', giudizio_sintetico: 'Buono', giudizio_testo: null, argomento: 'Argomento fittizio', creato_il: '2020-04-03T10:00:00Z', data_evento: '2020-04-02', annotazione_numerica: 9 }],
    note_disciplinari: [{ id: 'nota', alunno_id: ALUNNO, categoria: 'didattica', testo: 'Testo fittizio', richiede_firma: true, firmata_il: null, creato_il: '2020-04-03T10:00:00Z', data_evento: '2020-04-02', firmata_da: 'dato-riservato' }],
    giustifiche_didattiche: [],
  }
})

describe('competenza visibile alle famiglie senza ulteriori dati privati', () => {
  it('le API parent conservano data_evento chiedendo solo colonne esplicite', async () => {
    const n = await (await note(req())).json()
    const v = await (await valutazioni(req())).json()
    expect(n.data[0].data_evento).toBe('2020-04-02')
    expect(v.data[0].valutazioni[0].data_evento).toBe('2020-04-02')
    expect(h.selezioni.filter(c => c.includes('data_evento'))).toEqual(expect.arrayContaining([
      'id, categoria, testo, richiede_firma, firmata_il, creato_il, data_evento',
      'id, materia_id, tipo, modalita, giudizio_sintetico, giudizio_testo, creato_il, argomento, data_evento',
    ]))
  })
  it('lo schema precedente resta leggibile con fallback esplicito alle colonne storiche', async () => {
    h.schemaVecchio = true
    const n = await note(req())
    const v = await valutazioni(req())
    expect(n.status).toBe(200)
    expect(v.status).toBe(200)
    expect((await n.json()).data).toHaveLength(1)
    expect((await v.json()).data[0].valutazioni).toHaveLength(1)
    expect(h.selezioni.filter(c => c.includes('data_evento'))).toHaveLength(2)
    expect(h.selezioni.filter(c => c.includes('creato_il') && !c.includes('data_evento')).length).toBeGreaterThanOrEqual(2)
  })
})

// Spec D18: il genitore legge i voti nell'ordine della DATA DELLA PROVA, ma il ritardo di visibilità resta
// calcolato sul momento del SALVATAGGIO (`creato_il`): la finestra in cui la docente può correggere non si sposta
// perché la prova è di tre settimane fa.
describe('voti del genitore: in ordine di data della prova, la soglia resta sul salvataggio', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-04T10:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const voto = (id: string, creatoIl: string, dataEvento?: string) => ({
    id, alunno_id: ALUNNO, materia_id: 'materia', tipo: 'orale', modalita: 'sintetico', giudizio_sintetico: 'Buono',
    giudizio_testo: null, argomento: 'Argomento fittizio', creato_il: creatoIl, ...(dataEvento && { data_evento: dataEvento }),
  })

  it('A creata ieri con data di tre settimane fa, B creata tre giorni fa con data di tre giorni fa: [B, A]; C dentro la soglia non compare', async () => {
    h.db.valutazioni = [
      voto('A', '2026-11-03T10:00:00Z', '2026-10-14'),
      voto('B', '2026-11-01T10:00:00Z', '2026-11-01'),
      // Salvata 5 minuti fa (il ritardo predefinito è 10): la famiglia non la vede ancora, qualunque sia la data della prova.
      voto('C', '2026-11-04T09:55:00Z', '2026-10-01'),
    ]
    const res = await valutazioni(req())
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toHaveLength(1)
    expect(data[0].valutazioni.map((v: { id: string }) => v.id)).toEqual(['B', 'A'])
  })

  it('con lo schema precedente (senza data_evento) l’ordine resta quello del salvataggio', async () => {
    h.schemaVecchio = true
    h.db.valutazioni = [
      voto('V1', '2026-10-20T10:00:00Z'),
      voto('V2', '2026-11-02T10:00:00Z'),
    ]
    const res = await valutazioni(req())
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data[0].valutazioni.map((v: { id: string }) => v.id)).toEqual(['V2', 'V1'])
  })
})
