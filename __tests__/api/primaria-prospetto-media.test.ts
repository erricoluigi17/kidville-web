import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

// ── La panoramica del prospetto conta i voti «per dimensioni» col giudizio
// (2026-10-04). Il giudizio sintetico è obbligatorio in ENTRAMBE le modalità:
// è il voto che vede la famiglia. Il database finto APPLICA i filtri della query
// (eq / in / not is null) a righe in memoria: un filtro sbagliato cambia il
// conteggio, invece di restituire comunque le stesse righe.
//
// ── D19 (spec 2026-11-04): un'insegnante (`educator`) vede il prospetto SOLO nelle
// materie che in quella classe le sono assegnate (`utenti_sezioni_materie`), verificato
// dal server col VERO `materie-docente` (non si mocka: si danno righe alla tabella).
// Lo staff vede tutto, senza leggere le assegnazioni. Le insegnanti senza materie in
// una classe non vedono più il prospetto di quella classe: è voluto.

const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  errori: {} as Record<string, { code: string; message?: string }>,
  utente: { id: 'doc-1', role: 'educator' } as { id: string; role: string },
}))

vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, { errori: h.errori }),
  }
})
vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: async () => ({ user: h.utente, response: null }),
}))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: vi.fn().mockResolvedValue(null) }))

import { GET } from '@/app/api/primaria/prospetto/route'

const ALU = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'
const ALU_SENZA_CLASSE = 'a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2'
const SEZ = '5e5e5e5e-5e5e-45e5-85e5-5e5e5e5e5e51'
const SEZ_B = '5e5e5e5e-5e5e-45e5-85e5-5e5e5e5e5e52'
const MAT = '3a73a73a-3a7a-43a7-8a73-a73a73a73a71'
const ITA = '3a73a73a-3a7a-43a7-8a73-a73a73a73a72'

const get = (qs: string) => GET(new NextRequest(`http://localhost/api/primaria/prospetto?${qs}`))
const panoramica = () => get(`alunnoId=${ALU}&userId=doc-1`)

let db: DBFinto

beforeEach(() => {
  h.utente = { id: 'doc-1', role: 'educator' }
  h.tabelle.length = 0
  for (const k of Object.keys(h.errori)) delete h.errori[k]
  db = {
    alunni: [
      { id: ALU, section_id: SEZ },
      { id: ALU_SENZA_CLASSE, section_id: null },
    ],
    sections: [{ id: SEZ, scuola_id: 'sc' }],
    giudizi_sintetici_scala: [
      { scuola_id: 'sc', etichetta: 'Ottimo', valore_numerico: 10 },
      { scuola_id: 'sc', etichetta: 'Discreto', valore_numerico: 7 },
    ],
    materie: [{ id: MAT, nome: 'Matematica', section_id: SEZ, attiva: true }],
    valutazioni: [
      { alunno_id: ALU, materia_id: MAT, modalita: 'sintetico', giudizio_sintetico: 'Ottimo' },
      { alunno_id: ALU, materia_id: MAT, modalita: 'dimensioni', giudizio_sintetico: 'Discreto' },
      { alunno_id: ALU, materia_id: MAT, modalita: 'dimensioni', giudizio_sintetico: null }, // storica
    ],
    // doc-1 insegna Matematica in SEZ. Italiano ce l'ha in un'ALTRA classe: la coppia
    // (classe, materia) è quella che conta, non la materia da sola.
    utenti_sezioni_materie: [
      { utente_id: 'doc-1', section_id: SEZ, materia_id: MAT },
      { utente_id: 'doc-1', section_id: SEZ_B, materia_id: ITA },
    ],
  }
  h.db = db
})

describe('GET /api/primaria/prospetto — panoramica', () => {
  it('conta il voto per dimensioni col giudizio, non quello storico senza', async () => {
    const res = await panoramica()
    expect(res.status).toBe(200)
    const { panoramica: p } = await res.json()
    expect(p).toEqual([{ materiaId: MAT, nome: 'Matematica', media: 8.5, nValutazioni: 2 }])
  })

  it('panoramica: solo le materie assegnate', async () => {
    // La classe ha anche Italiano, con un voto: a doc-1 non è assegnata in SEZ.
    db.materie.push({ id: ITA, nome: 'Italiano', section_id: SEZ, attiva: true })
    db.valutazioni.push({ alunno_id: ALU, materia_id: ITA, modalita: 'sintetico', giudizio_sintetico: 'Ottimo' })

    const res = await panoramica()
    expect(res.status).toBe(200)
    const { panoramica: p } = await res.json()
    expect(p).toEqual([{ materiaId: MAT, nome: 'Matematica', media: 8.5, nValutazioni: 2 }])
  })

  it('educator senza materie: 200 e panoramica vuota, senza leggere materie né voti', async () => {
    db.utenti_sezioni_materie = [{ utente_id: 'doc-1', section_id: SEZ_B, materia_id: ITA }]

    const res = await panoramica()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, panoramica: [] })
    expect(h.tabelle).not.toContain('materie')
    expect(h.tabelle).not.toContain('valutazioni')
  })

  it('staff: tutte le materie, come oggi, senza leggere le assegnazioni', async () => {
    h.utente = { id: 'seg-1', role: 'segreteria' }
    db.utenti_sezioni_materie = []
    db.materie.push({ id: ITA, nome: 'Italiano', section_id: SEZ, attiva: true })
    db.valutazioni.push({ alunno_id: ALU, materia_id: ITA, modalita: 'sintetico', giudizio_sintetico: 'Discreto' })

    const res = await panoramica()
    expect(res.status).toBe(200)
    const { panoramica: p } = await res.json()
    expect(p).toEqual([
      { materiaId: MAT, nome: 'Matematica', media: 8.5, nValutazioni: 2 },
      { materiaId: ITA, nome: 'Italiano', media: 7, nValutazioni: 1 },
    ])
    expect(h.tabelle).not.toContain('utenti_sezioni_materie')
  })

  it('guasto su utenti_sezioni_materie → 500 LETTURA_FALLITA, non una panoramica vuota', async () => {
    h.errori.utenti_sezioni_materie = { code: 'XX000', message: 'guasto finto' }

    const res = await panoramica()
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
    expect(h.tabelle).not.toContain('valutazioni')
  })
})

describe('GET /api/primaria/prospetto — singola materia', () => {
  it('educator sulla sua materia: 200', async () => {
    const res = await get(`alunnoId=${ALU}&materiaId=${MAT}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, media: 8.5 })
  })

  it('educator su una materia non sua → 403 MATERIA_NON_ASSEGNATA, senza leggere i voti', async () => {
    // Italiano doc-1 ce l'ha in SEZ_B, non nella classe dell'alunno.
    db.materie.push({ id: ITA, nome: 'Italiano', section_id: SEZ, attiva: true })
    db.valutazioni.push({ alunno_id: ALU, materia_id: ITA, modalita: 'sintetico', giudizio_sintetico: 'Ottimo' })

    const res = await get(`alunnoId=${ALU}&materiaId=${ITA}`)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: 'MATERIA_NON_ASSEGNATA' })
    expect(h.tabelle).not.toContain('valutazioni')
  })

  it('educator con un alunno senza classe e una materia → 403 (nessuna coppia da verificare)', async () => {
    const res = await get(`alunnoId=${ALU_SENZA_CLASSE}&materiaId=${MAT}`)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: 'MATERIA_NON_ASSEGNATA' })
  })

  it('staff con una materia qualsiasi: 200, senza leggere le assegnazioni', async () => {
    h.utente = { id: 'seg-1', role: 'segreteria' }
    db.utenti_sezioni_materie = []

    const res = await get(`alunnoId=${ALU}&materiaId=${MAT}`)
    expect(res.status).toBe(200)
    expect(h.tabelle).not.toContain('utenti_sezioni_materie')
  })

  it('guasto su utenti_sezioni_materie → 500 LETTURA_FALLITA, non un 403', async () => {
    h.errori.utenti_sezioni_materie = { code: 'XX000', message: 'guasto finto' }

    const res = await get(`alunnoId=${ALU}&materiaId=${MAT}`)
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
    expect(h.tabelle).not.toContain('valutazioni')
  })
})
