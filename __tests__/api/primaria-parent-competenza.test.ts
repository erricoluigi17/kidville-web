import { beforeEach, describe, it, expect, vi } from 'vitest'
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
