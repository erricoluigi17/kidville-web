import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import type { DBFinto, Riga } from '../fixtures/finto-supabase'
import { ID_PER_QUERY } from '@/lib/db/blocchi'
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
  /** R8: ogni `.in(colonna, lista)` della richiesta, con la lunghezza della lista. */
  registroIn: [] as { tabella: string; colonna: string; n: number }[],
  /**
   * Q6: ogni lettura (una `from()` = una query: `leggiABlocchi` ne costruisce una NUOVA per
   * blocco), con la lunghezza delle sue liste `.in()` e il suo `range`.
   */
  letture: [] as { tabella: string; inN: Record<string, number>; range: [number, number] | null }[],
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
  return {
    createAdminClient: async () => {
      const c = creaFintoSupabase(h.db, [], { maxRighe: 1000, errori: h.errori })
      // R8: si registra ogni `.in()` — il finto client filtra davvero, ma non ha un URL da far
      // sforare: la lunghezza delle liste la si guarda qui.
      const from = c.from.bind(c)
      Object.assign(c, {
        from: (t: string) => {
          const q = from(t) as unknown as Record<string, unknown>
          const lettura = { tabella: t, inN: {} as Record<string, number>, range: null as [number, number] | null }
          h.letture.push(lettura)
          const inVero = q.in as (colonna: string, v: unknown[]) => unknown
          q.in = (colonna: string, v: unknown[]) => {
            h.registroIn.push({ tabella: t, colonna, n: v.length })
            lettura.inN[colonna] = v.length
            return inVero(colonna, v)
          }
          const rangeVero = q.range as (da: number, a: number) => unknown
          q.range = (da: number, a: number) => { lettura.range = [da, a]; return rangeVero(da, a) }
          return q
        },
      })
      return c
    },
  }
})

import { GET } from '@/app/api/pagamenti/export/route'
import { rigaEvento } from '@/lib/logging/logger'

/** Ogni riga d'errore della richiesta: i `logEvento(…, 'error')` (anche quello di `withRoute`) e i `logErrore`. */
const erroriDiLog = () => [
  ...h.logEvento.mock.calls.filter((c) => c[1] === 'error').map((c) => `${c[0]}:${(c[2] as { esito?: string }).esito ?? '-'}`),
  ...h.logErrore.mock.calls.map((c) => `logErrore:${(c[0] as { evento?: string }).evento}:${(c[0] as { stato?: number }).stato}`),
]
/**
 * Q2 (quarta revisione 2026-09-29) — LA FORMA del tetto, in tutti e quattro i casi dell'export
 * (e nel prefisso di `leggiTutte` di `GET /api/pagamenti`): il MESSAGGIO della riga — la colonna
 * `app_log.messaggio` — comincia con `lettura-troncata: <tipo> oltre <soglia> righe (<n> lette in
 * <b> blocchi)`. Una ricerca sola, `messaggio like 'lettura-troncata:%'`, le trova tutte; la
 * colonna `stato_http` distingue il 500 (Scadenzario, AdE) dal 200 (rette dei paganti).
 */
const FORMA_TETTO = /^lettura-troncata: (export-scadenzario|export-rette-paganti|export-ade-alunni|export-ade-incassi) oltre \d+ righe \(\d+ lette in \d+ blocchi\)/

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
  h.registroIn = []
  h.letture = []
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
    // Nessun tetto toccato: nessun allarme, in NESSUNA delle due forme (Q9, quarta revisione: qui
    // si cercava solo un `logEvento` «lettura-troncata», che per lo Scadenzario dal 29/09 non può
    // più esistere — il suo tetto è un `logErrore` — e l'asserzione era vera per costruzione).
    expect(erroriDiLog()).toEqual([])
  })

  // Q6 (quarta revisione 2026-09-29): con gli id a pezzi di `ID_PER_QUERY` (R8) il caso di prima
  // — 120 famiglie × 10 mesi — non portava più NESSUNA lettura delle rette oltre le 1000: un pezzo
  // ha 100 id, cioè 50 paganti, cioè 500 righe. Togliendo il `range` a quella lettura il test
  // restava verde. Qui 21 mesi: il primo pezzo (50 paganti) ha 1.050 rette, il secondo 210.
  it('le rette dei paganti oltre le 1000 in UN pezzo di id (60 famiglie × 21 mesi): una riga a zero per OGNUNA', async () => {
    const FAMIGLIE = 60
    const MESI = 21
    /** Da settembre 2025 a maggio 2027: 21 periodi distinti, e scadenze che si ordinano. */
    const periodo = (m: number) => new Date(Date.UTC(2025, 8 + m, 1)).toISOString().slice(0, 10)
    for (let i = 0; i < FAMIGLIE; i++) {
      h.db.alunni.push(alunno(uuid('pag', i), SEDE_A), alunno(uuid('fig', i), SEDE_A, { retta_a_carico_di: uuid('pag', i) }))
      for (let m = 0; m < MESI; m++) {
        const p = periodo(m)
        h.db.pagamenti.push(retta(uuid(`r${m}`, i), uuid('pag', i), SEDE_A, 1, {
          periodo_competenza: p, scadenza: `${p.slice(0, 8)}05`, descrizione: `Retta ${p.slice(0, 7)}`,
        }))
      }
    }
    const righe = await foglio(await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario')), 'Scadenzario')
    const aZero = righe.filter((r) => String(r.Stato).startsWith('Paga il fratello'))
    expect(aZero).toHaveLength(FAMIGLIE * MESI)
    expect(aZero.every((r) => r['Importo €'] === 0)).toBe(true)
    // Ogni bambino ha TUTTI i suoi mesi (le 50 righe oltre le prime 1000 del pezzo sono di qualcuno).
    expect(new Set(aZero.map((r) => `${r.Alunno}|${r.Descrizione}`)).size).toBe(FAMIGLIE * MESI)
    // …e le righe vere dei paganti, anche loro oltre le 1000.
    expect(righe.filter((r) => r['Importo €'] === 250)).toHaveLength(FAMIGLIE * MESI)
    // La prova che è la PAGINAZIONE delle rette ad averle portate: una lettura ristretta a un pezzo
    // di id (≤ ID_PER_QUERY) ha chiesto il secondo blocco di `range`, cioè il primo era pieno.
    const rette = h.letture.filter((l) => l.tabella === 'pagamenti' && l.inN.alunno_id != null)
    expect(Math.max(...rette.map((l) => l.inN.alunno_id))).toBeLessThanOrEqual(ID_PER_QUERY)
    expect(rette.filter((l) => l.range?.[0] === 1000).map((l) => l.inN.alunno_id)).toEqual([ID_PER_QUERY])
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
    // Q2: la forma esatta (tetto di prova: 2 blocchi da 2 → 4 righe lette in 3 letture, la
    // terza è la riga di prova). È il messaggio che finisce in `app_log.messaggio`.
    const err = h.logErrore.mock.calls[0][1] as Error
    expect(err.message).toMatch(FORMA_TETTO)
    expect(err.message).toBe(`lettura-troncata: ${tipo} oltre 4 righe (4 lette in 3 blocchi), rifiutata per intero`)
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
    expect(erroriDiLog()).toEqual(['pagamento:lettura-troncata'])
    // Q2: tipo e conteggi come CAMPI (qui `logEvento` lo permette), e lo stesso messaggio dei 500.
    const chiamata = h.logEvento.mock.calls.find((c) => c[1] === 'error')!
    expect(chiamata).toEqual(['pagamento', 'error', {
      operazione: 'pagamenti/export:GET', esito: 'lettura-troncata', tipo: 'export-rette-paganti', n: 4, blocchi: 3, oltre: 4,
      msg: 'lettura-troncata: export-rette-paganti oltre 4 righe (4 lette in 3 blocchi): l’export esce senza le righe dei bambini a carico (nessuna, mai una parte)',
    }])
    // La riga che finirebbe in `app_log` (la persistenza è muta sotto vitest: la si compone con la
    // stessa funzione): messaggio nella forma comune, nessuno `stato_http` (è un 200), e tipo e
    // conteggi in chiaro nei campi — `tipo` è nella lista bianca di `redact`, i numeri passano.
    const riga = rigaEvento(...(chiamata as Parameters<typeof rigaEvento>))!
    expect(riga.messaggio).toMatch(FORMA_TETTO)
    expect(riga.statoHttp).toBeUndefined()
    expect(riga.contestoExtra?.campi).toMatchObject({ esito: 'lettura-troncata', tipo: 'export-rette-paganti', n: 4, blocchi: 3, oltre: 4 })
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

// =============================================================================
// R8 (terza revisione 2026-09-29) — LE LISTE DI ID A BLOCCHI. `.in('alunno_id', ids)` sulle
// rette dei paganti passava la lista INTERA nell'URL: due id per famiglia, e oltre un centinaio
// di famiglie la richiesta sfora il limite dei proxy (414, `@/lib/db/blocchi`). Ora a blocchi di
// `ID_PER_QUERY`, ciascuno letto a sua volta a blocchi di `range`; e tutto-o-niente fra i blocchi.
// =============================================================================
describe('R8 — gli id delle rette dei paganti a blocchi', () => {
  const famiglie = (n: number, retta_: (i: number) => Riga | null) => {
    for (let i = 0; i < n; i++) {
      h.db.alunni.push(alunno(uuid('pag', i), SEDE_A), alunno(uuid('fig', i), SEDE_A, { retta_a_carico_di: uuid('pag', i) }))
      const r = retta_(i)
      if (r) h.db.pagamenti.push(r)
    }
  }

  it('80 famiglie (160 id): nessun `.in(alunno_id)` oltre il blocco, e le righe a carico ci sono TUTTE', async () => {
    famiglie(80, (i) => retta(uuid('r', i), uuid('pag', i), SEDE_A, 10))
    const res = await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario'))
    expect(res.status).toBe(200)
    const righe = await foglio(res, 'Scadenzario')
    const aZero = righe.filter((r) => String(r.Stato).startsWith('Paga il fratello'))
    expect(new Set(aZero.map((r) => r.Alunno)).size).toBe(80)
    const inAlunno = h.registroIn.filter((x) => x.tabella === 'pagamenti' && x.colonna === 'alunno_id')
    expect(inAlunno.length).toBeGreaterThanOrEqual(2)
    expect(Math.max(...inAlunno.map((x) => x.n))).toBeLessThanOrEqual(ID_PER_QUERY)
  })

  it('un blocco di id al tetto: NESSUNA riga a carico, nemmeno quelle del blocco andato bene', async () => {
    h.tetto = { blocco: 2, maxBlocchi: 2 }
    // 60 famiglie = 120 id: il primo blocco (famiglie 0–49) ha UNA retta, il secondo (50–59)
    // ne ha 10 — oltre il tetto di 4. La lettura principale, filtrata per stato, sta sotto.
    famiglie(60, (i) => (i === 0
      ? retta(uuid('r', i), uuid('pag', i), SEDE_A, 10, { stato: 'pagato' })
      : i >= 50 ? retta(uuid('r', i), uuid('pag', i), SEDE_A, 10) : null))
    const res = await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario&stato=pagato'))
    expect(res.status).toBe(200)
    const righe = await foglio(res, 'Scadenzario')
    expect(righe.map((r) => r.Alunno)).toEqual([`N${uuid('pag', 0)} Prova`])
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'error', expect.objectContaining({ esito: 'lettura-troncata', tipo: 'export-rette-paganti' }))
  })
})
