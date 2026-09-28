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
  logErrore: vi.fn(),
  errori: {} as Record<string, { code: string }>,
  /** K5: un tetto PICCOLO per i test (il vero è 50 blocchi da 1000). `null` = quello vero. */
  tetto: null as { blocco: number; maxBlocchi: number } | null,
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  h.logEvento.mockImplementation(vero.logEvento)
  h.logErrore.mockImplementation(vero.logErrore)
  return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})
// Il modulo VERO, con il tetto iniettato dalle opzioni che già accetta (`blocco`, `maxBlocchi`).
vi.mock('@/lib/pagamenti/leggi-a-blocchi', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/pagamenti/leggi-a-blocchi')>()
  type Args = Parameters<typeof vero.leggiABlocchi>
  return { ...vero, leggiABlocchi: (c: Args[0], o: Args[1]) => vero.leggiABlocchi(c, h.tetto ? { ...o, ...h.tetto } : o) }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, [], { maxRighe: 1000, errori: h.errori }) }
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
  h.tetto = null
  h.errori = {}
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

// =============================================================================
// K7 (seconda revisione 2026-09-28) — L'ORDINE DEI FOGLI AdE. Prima di C2 gli alunni si
// leggevano senza `order` (nessun ordine garantito) e nessuno li riordinava; con la lettura a
// blocchi escono per `id`, cioè per uuid: a caso, per chi legge. Ora sede, cognome, nome e —
// a parità — `id`. Il finto client ORDINA davvero per `id`: gli uuid qui sotto sono scelti
// perché quell'ordine sia diverso da quello atteso.
// =============================================================================
describe('K7 — i fogli AdE escono in un ordine leggibile e stabile', () => {
  it('per sede, cognome, nome e poi id — in entrambi i fogli', async () => {
    const persone: [string, string, string, string][] = [
      // [id, sede, nome, cognome] — in ordine di id
      ['al-1', SEDE_B, 'Anna', 'Bianchi'],
      ['al-2', SEDE_A, 'Zoe', 'Rossi'],
      ['al-3', SEDE_A, 'Ada', 'Rossi'],
      ['al-4', SEDE_A, 'Ugo', 'Bianchi'],
      ['al-5', SEDE_B, 'Anna', 'Bianchi'], // omonima di al-1 nella stessa sede: decide l'id
      ['al-6', SEDE_A, 'Eva', 'de Luca'],   // minuscola: il confronto non la manda in fondo
    ]
    for (const [id, sede, nome, cognome] of persone) {
      h.db.alunni.push(alunno(id, sede, { nome, cognome, codice_fiscale: null, opposizione_ade: false, intestatario_fatture: null }))
      h.db.incassi.push({
        id: `inc-${id}`, importo: 100, metodo: 'bonifico', data_incasso: '2026-02-10',
        pagamenti: { alunno_id: id, scuola_id: sede, descrizione: 'Retta', payment_categories: { slug: 'retta' } },
      })
    }
    const res = await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=ade&anno=2026'))
    expect(res.status).toBe(200)
    // Senza intestatario tutte vanno in «Escluse» (CF del pagatore mancante), una riga ciascuno.
    const escluse = await foglio(res, 'Escluse')
    expect(escluse.map((r) => `${r.Sede}|${r.Alunno}`)).toEqual([
      `${NOME_SEDE_A}|Ugo Bianchi`,
      `${NOME_SEDE_A}|Eva de Luca`,
      `${NOME_SEDE_A}|Ada Rossi`,
      `${NOME_SEDE_A}|Zoe Rossi`,
      `${NOME_SEDE_B}|Anna Bianchi`,
      `${NOME_SEDE_B}|Anna Bianchi`,
    ])
  })

  it('«Da comunicare» segue lo stesso ordine', async () => {
    h.db.parents = [{ id: 'gen-1', first_name: 'G', last_name: 'F', fiscal_code: 'CFPAGATOREPROVA1' }]
    for (const [id, nome, cognome] of [['al-1', 'Zoe', 'Verdi'], ['al-2', 'Ada', 'Verdi'], ['al-3', 'Ugo', 'Alti']]) {
      h.db.alunni.push(alunno(id, SEDE_A, { nome, cognome, codice_fiscale: null, opposizione_ade: false, intestatario_fatture: { adult_id: 'gen-1' } }))
      h.db.incassi.push({
        id: `inc-${id}`, importo: 100, metodo: 'bonifico', data_incasso: '2026-02-10',
        pagamenti: { alunno_id: id, scuola_id: SEDE_A, descrizione: 'Retta', payment_categories: { slug: 'retta' } },
      })
    }
    const res = await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=ade&anno=2026'))
    expect(res.status).toBe(200)
    expect((await foglio(res, 'Da comunicare')).map((r) => r.Alunno)).toEqual(['Ugo Alti', 'Ada Verdi', 'Zoe Verdi'])
  })
})

// =============================================================================
// K5 (seconda revisione 2026-09-28) — AL TETTO DEI BLOCCHI la lettura consegnava le righe
// lette con `troncata: true`, e nessun chiamante lo guardava: l'export usciva 200, incompleto,
// e nel ramo AdE era una comunicazione all'Agenzia delle Entrate con delle spese in meno. Ora
// il tetto è un GUASTO: 500 con `LETTURA_FALLITA`, e UNA sola riga d'errore.
//
// R2 (terza revisione 2026-09-29): quella riga la scriveva `leggiABlocchi` con `logEvento`,
// SENZA `stato`, e alzava la marca anti-doppione: `withRoute` taceva, e per quel 500 nei log non
// c'era nessuna riga con `stato: 500` — fuori dal filtro «dammi i 5xx di ieri». Ora la scrive la
// route, con `logErrore` e `stato: 500`, come `leggiTutte` di `GET /api/pagamenti`.
// Tetto qui: 2 blocchi da 2 righe = 4 righe; la quinta accende la riga di prova.
// =============================================================================
describe('K5 — al tetto dei blocchi l’export è un guasto, non un file incompleto', () => {
  /** Ogni riga d'errore della richiesta: i `logEvento(…, 'error')` (anche quello di `withRoute`) e i `logErrore`. */
  const erroriDiLog = () => [
    ...h.logEvento.mock.calls.filter((c) => c[1] === 'error').map((c) => `${c[0]}:${(c[2] as { esito?: string }).esito ?? '-'}`),
    ...h.logErrore.mock.calls.map((c) => `logErrore:${(c[0] as { evento?: string }).evento}:${(c[0] as { stato?: number }).stato}`),
  ]
  async function atteso500(qs: string, tipo: string) {
    const res = await GET(new NextRequest(`http://localhost/api/pagamenti/export?${qs}`))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    // UNA riga, e porta `stato: 500`; il messaggio dice QUALE lettura e i conteggi (mai dati).
    expect(erroriDiLog()).toEqual(['logErrore:lettura-troncata:500'])
    expect(h.logErrore).toHaveBeenCalledWith(
      { operazione: 'pagamenti/export:GET', stato: 500, evento: 'lettura-troncata' },
      expect.objectContaining({ message: expect.stringContaining(tipo) }),
    )
  }

  it('Scadenzario: 5 righe oltre un tetto di 4 → 500 LETTURA_FALLITA, un log solo', async () => {
    h.tetto = { blocco: 2, maxBlocchi: 2 }
    for (let m = 1; m <= 5; m++) h.db.pagamenti.push(retta(uuid('p', m), 'al-1', SEDE_A, m))
    await atteso500('tipo=scadenzario', 'export-scadenzario')
  })

  it('Scadenzario: esattamente 4 righe (il tetto pieno) → 200, tutte, nessun allarme falso', async () => {
    h.tetto = { blocco: 2, maxBlocchi: 2 }
    for (let m = 1; m <= 4; m++) h.db.pagamenti.push(retta(uuid('p', m), 'al-1', SEDE_A, m))
    const res = await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario'))
    expect(res.status).toBe(200)
    expect(await foglio(res, 'Scadenzario')).toHaveLength(4)
    expect(erroriDiLog()).toEqual([])
  })

  const incasso = (i: number, alunnoId: string) => ({
    id: uuid('inc', i), importo: 100, metodo: 'bonifico', data_incasso: '2026-02-10',
    pagamenti: { alunno_id: alunnoId, scuola_id: SEDE_A, descrizione: `Retta ${i}`, payment_categories: { slug: 'retta' } },
  })

  it('AdE, alunni oltre il tetto → 500 LETTURA_FALLITA (niente comunicazione all’AdE con spese in meno)', async () => {
    h.tetto = { blocco: 2, maxBlocchi: 2 }
    for (let i = 0; i < 5; i++) {
      h.db.alunni.push(alunno(uuid('al', i), SEDE_A, { opposizione_ade: false, intestatario_fatture: null }))
      h.db.incassi.push(incasso(i, uuid('al', i)))
    }
    await atteso500('tipo=ade&anno=2026', 'export-ade-alunni')
  })

  it('AdE, incassi oltre il tetto (alunni sotto) → 500 LETTURA_FALLITA', async () => {
    h.tetto = { blocco: 2, maxBlocchi: 2 }
    h.db.alunni.push(alunno('al-1', SEDE_A, { opposizione_ade: false, intestatario_fatture: null }))
    for (let i = 0; i < 5; i++) h.db.incassi.push(incasso(i, 'al-1'))
    await atteso500('tipo=ade&anno=2026', 'export-ade-incassi')
  })

  // Le righe dei bambini a carico sono un'informazione ACCESSORIA (spec, D14): un loro guasto
  // non fa fallire l'export, che esce senza di esse. Al tetto vale lo stesso — ma TUTTE o
  // nessuna, mai una parte — e il log resta quello solo del tetto.
  it('rette dei paganti oltre il tetto: l’export esce 200 SENZA righe a carico (nessuna, mai una parte), un log solo', async () => {
    h.tetto = { blocco: 2, maxBlocchi: 2 }
    h.db.alunni.push(alunno('pag', SEDE_A), alunno('fig', SEDE_A, { retta_a_carico_di: 'pag' }))
    // Una sola retta «pagato» (la lettura principale, filtrata per stato, sta sotto il tetto);
    // cinque rette del pagante in tutto (la lettura delle rette dei paganti lo supera).
    for (let m = 1; m <= 5; m++) h.db.pagamenti.push(retta(uuid('r', m), 'pag', SEDE_A, m, m === 1 ? { stato: 'pagato' } : {}))
    const res = await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario&stato=pagato'))
    expect(res.status).toBe(200)
    const righe = await foglio(res, 'Scadenzario')
    expect(righe.map((r) => r.Alunno)).toEqual(['Npag Prova'])
    // Qui la risposta è 200: la riga è un `logEvento` error (nessun 5xx da dichiarare), UNA.
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'error', expect.objectContaining({ esito: 'lettura-troncata', tipo: 'export-rette-paganti' }))
    expect(erroriDiLog()).toEqual(['pagamento:lettura-troncata'])
  })

  // Il ramo gemello: un blocco che risponde `{ error }`. Una riga, con `stato: 500`.
  it('Scadenzario: un blocco in errore → 500 LETTURA_FALLITA, una riga sola con stato 500', async () => {
    h.errori = { 'pagamenti:select': { code: '57014' } }
    h.db.pagamenti.push(retta(uuid('p', 1), 'al-1', SEDE_A, 1))
    const res = await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario'))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(erroriDiLog()).toEqual(['logErrore:db:500'])
  })
})
