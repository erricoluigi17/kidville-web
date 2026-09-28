import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import type { DBFinto, Riga } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

// =============================================================================
// C2 (revisione 2026-09-28) — l'export NON leggeva a blocchi.
//
// PostgREST taglia ogni risposta a `max_rows` (1000 in `supabase/config.toml`, 1000 nel
// progetto ospitato) e non lo dice: nessun errore, nessun segnale. Misurato in produzione
// il 28/09: 1.150 pagamenti esportabili nelle tre sedi — l'export «tutte le sedi» dello
// Scadenzario ne consegnava 1000, e le 150 mancanti non lasciavano traccia.
//
// Qui il finto client ha lo STESSO tetto (`maxRighe: 1000`): senza `range` ogni lettura
// si ferma a 1000 righe, esattamente come in produzione. Scope VERO, filtri VERI.
// =============================================================================

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as DBFinto,
  logEvento: vi.fn(),
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  h.logEvento.mockImplementation(vero.logEvento)
  return { ...vero, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, [], { maxRighe: 1000 }) }
})

import { GET } from '@/app/api/pagamenti/export/route'

const ADMIN_AB = { id: 'admin-1', role: 'admin', scuola_id: SEDE_A }
const RETTA = { nome: 'Retta', slug: 'retta' }
const uuid = (prefisso: string, i: number) => `${prefisso}-${String(i).padStart(5, '0')}`

/** Una retta: TUTTE con la stessa scadenza nel mese, come in produzione (una al mese per alunno). */
const retta = (id: string, alunnoId: string, sede: string, mese: number, extra: Riga = {}) => {
  const periodo = `2026-${String(mese).padStart(2, '0')}-01`
  return {
    id, alunno_id: alunnoId, scuola_id: sede, descrizione: `Retta ${periodo.slice(0, 7)}`, importo: 250, importo_pagato: 0,
    scadenza: `${periodo.slice(0, 8)}05`, periodo_competenza: periodo, stato: 'da_pagare', tipo: 'singolo',
    fattura_stato: null, categoria_id: 'c-retta', payment_categories: RETTA,
    alunni: { nome: `N${alunnoId}`, cognome: 'Prova', classe_sezione: 'Sez. A', section_id: null, scuola_id: sede },
    ...extra,
  }
}
const alunno = (id: string, sede: string, extra: Riga = {}) => ({
  id, nome: `N${id}`, cognome: 'Prova', classe_sezione: 'Sez. A', section_id: null, scuola_id: sede,
  stato: 'iscritto', gender: 'M', archiviato_il: null, retta_a_carico_di: null, ...extra,
})

async function foglio(res: Response, nome: string) {
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()))
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[nome])
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = {
    schools: [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_B, nome: NOME_SEDE_B }],
    scuole: [{ id: SEDE_A, attiva: true }, { id: SEDE_B, attiva: true }],
    utenti_scuole: [{ utente_id: 'admin-1', scuola_id: SEDE_A }, { utente_id: 'admin-1', scuola_id: SEDE_B }],
    alunni: [],
    pagamenti: [],
    incassi: [],
    parents: [],
    registro_modifiche: [],
  }
  h.requireStaff.mockResolvedValue({ user: ADMIN_AB })
})

describe('export Scadenzario — oltre le 1000 righe (C2)', () => {
  it('1.150 pagamenti in due sedi (la misura del 28/09): escono TUTTI, una volta sola', async () => {
    // 115 alunni × 10 mesi; 1.150 righe con appena 10 scadenze diverse — il caso in cui un
    // ordinamento senza `id` farebbe sovrapporre due blocchi.
    for (let i = 0; i < 115; i++) {
      const sede = i % 2 ? SEDE_B : SEDE_A
      for (let m = 1; m <= 10; m++) h.db.pagamenti.push(retta(uuid(`p${m}`, i), uuid('al', i), sede, m))
    }
    const res = await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario'))
    expect(res.status).toBe(200)
    const righe = await foglio(res, 'Scadenzario')
    expect(righe).toHaveLength(1150)
    const chiavi = new Set(righe.map((r) => `${r.Alunno}|${r.Descrizione}`))
    expect(chiavi.size).toBe(1150)
    // Ancora ordinate per scadenza.
    const scadenze = righe.map((r) => String(r.Scadenza))
    expect(scadenze).toEqual([...scadenze].sort())
    // Nessun tetto toccato: nessun allarme.
    expect(h.logEvento).not.toHaveBeenCalledWith('pagamento', 'error', expect.objectContaining({ esito: 'lettura-troncata' }))
  })

  it('le rette dei paganti oltre le 1000 (120 famiglie × 10 mesi): una riga a zero per OGNUNA', async () => {
    for (let i = 0; i < 120; i++) {
      h.db.alunni.push(alunno(uuid('pag', i), SEDE_A), alunno(uuid('fig', i), SEDE_A, { retta_a_carico_di: uuid('pag', i) }))
      for (let m = 1; m <= 10; m++) h.db.pagamenti.push(retta(uuid(`r${m}`, i), uuid('pag', i), SEDE_A, m))
    }
    const righe = await foglio(await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario')), 'Scadenzario')
    const aZero = righe.filter((r) => String(r.Stato).startsWith('Paga il fratello'))
    expect(aZero).toHaveLength(1200)
    expect(aZero.every((r) => r['Importo €'] === 0)).toBe(true)
    // …e le righe vere dei paganti, anche loro oltre le 1000.
    expect(righe.filter((r) => r['Importo €'] === 250)).toHaveLength(1200)
  })
})

describe('export AdE — oltre le 1000 righe (C2)', () => {
  it('1.100 alunni e 1.100 incassi: nessuno resta fuori da nessuno dei due fogli', async () => {
    for (let i = 0; i < 1100; i++) {
      const sede = i % 2 ? SEDE_B : SEDE_A
      const id = uuid('al', i)
      // Senza intestatario: ogni riga va in «Escluse» (codice fiscale del pagatore mancante),
      // che basta a contarle tutte senza dipendere dall'anagrafica dei genitori.
      h.db.alunni.push(alunno(id, sede, { codice_fiscale: null, opposizione_ade: false, intestatario_fatture: null }))
      h.db.incassi.push({
        id: uuid('inc', i), importo: 100, metodo: 'bonifico', data_incasso: '2026-02-10',
        pagamenti: { alunno_id: id, scuola_id: sede, descrizione: 'Retta', payment_categories: { slug: 'retta' } },
      })
    }
    const res = await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=ade&anno=2026'))
    expect(res.status).toBe(200)
    const escluse = await foglio(res, 'Escluse')
    expect(escluse).toHaveLength(1100)
    expect(new Set(escluse.map((r) => r.Alunno)).size).toBe(1100)
  })
})
