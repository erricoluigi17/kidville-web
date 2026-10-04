import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── La panoramica del prospetto conta i voti «per dimensioni» col giudizio
// (2026-10-04). Il giudizio sintetico è obbligatorio in ENTRAMBE le modalità:
// è il voto che vede la famiglia. Il database finto APPLICA i filtri della query
// (eq / in / not is null) a righe in memoria: un filtro sbagliato cambia il
// conteggio, invece di restituire comunque le stesse righe.

const h = vi.hoisted(() => {
  type Riga = Record<string, unknown>
  const tabelle: Record<string, Riga[]> = {}
  function makeClient() {
    return {
      from(table: string) {
        let righe = [...(tabelle[table] ?? [])]
        const qb: Record<string, unknown> = {}
        qb.select = () => qb
        qb.order = () => qb
        qb.eq = (col: string, v: unknown) => { righe = righe.filter((r) => r[col] === v); return qb }
        qb.in = (col: string, vs: unknown[]) => { righe = righe.filter((r) => vs.includes(r[col])); return qb }
        qb.not = (col: string, op: string, v: unknown) => {
          if (op === 'is' && v === null) righe = righe.filter((r) => r[col] !== null && r[col] !== undefined)
          return qb
        }
        qb.maybeSingle = () => Promise.resolve({ data: righe[0] ?? null, error: null })
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve({ data: righe, error: null }).then(res, rej)
        return qb
      },
    }
  }
  return { tabelle, makeClient }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockImplementation(async () => h.makeClient()),
}))
vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: vi.fn().mockResolvedValue({ user: { id: 'doc-1', role: 'educator' }, response: null }),
}))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: vi.fn().mockResolvedValue(null) }))

import { GET } from '@/app/api/primaria/prospetto/route'
import { NextRequest } from 'next/server'

const ALU = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'
const SEZ = 'se'
const MAT = 'ma'

beforeEach(() => {
  h.tabelle.alunni = [{ id: ALU, section_id: SEZ }]
  h.tabelle.sections = [{ id: SEZ, scuola_id: 'sc' }]
  h.tabelle.giudizi_sintetici_scala = [
    { scuola_id: 'sc', etichetta: 'Ottimo', valore_numerico: 10 },
    { scuola_id: 'sc', etichetta: 'Discreto', valore_numerico: 7 },
  ]
  h.tabelle.materie = [{ id: MAT, nome: 'Matematica', section_id: SEZ, attiva: true }]
  h.tabelle.valutazioni = [
    { alunno_id: ALU, materia_id: MAT, modalita: 'sintetico', giudizio_sintetico: 'Ottimo' },
    { alunno_id: ALU, materia_id: MAT, modalita: 'dimensioni', giudizio_sintetico: 'Discreto' },
    { alunno_id: ALU, materia_id: MAT, modalita: 'dimensioni', giudizio_sintetico: null }, // storica
  ]
})

describe('GET /api/primaria/prospetto — panoramica', () => {
  it('conta il voto per dimensioni col giudizio, non quello storico senza', async () => {
    const res = await GET(new NextRequest(`http://localhost/api/primaria/prospetto?alunnoId=${ALU}&userId=doc-1`))
    expect(res.status).toBe(200)
    const { panoramica } = await res.json()
    expect(panoramica).toEqual([{ materiaId: MAT, nome: 'Matematica', media: 8.5, nValutazioni: 2 }])
  })
})
