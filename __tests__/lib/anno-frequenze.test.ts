import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaDbAnnoPr2 } from '../helpers/schema-anno-pglite'

vi.mock('@/lib/logging/logger', () => ({
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import { logEvento, logErrore } from '@/lib/logging/logger'
import { campiFrequenzaDaAlunno, scriviFrequenza } from '@/lib/anno/frequenze'

/**
 * PR 3 · COMPITO 3.7-1 · gli strumenti della doppia scrittura `alunni` → `frequenze` (fase A, §4.19).
 *
 * Il punto di questo file è la PARITÀ: ogni patch di una tabella di casi si applica a `alunni` (il trigger-specchio
 * `alunni_specchio_frequenza()` di M1, quello che gira in produzione, scrive la frequenza) e il risultato si
 * confronta, colonna per colonna, con `campiFrequenzaDaAlunno(patch)`. Se la tabella TS e la funzione SQL
 * divergono, uno di questi casi diventa rosso.
 *
 * `scriviFrequenza` gira su PGlite attraverso un ADATTATORE minimo (`clienteSu`): traduce in SQL le poche forme di
 * chiamata che la funzione usa (`select … maybeSingle`, `update … select`, `rpc`). Non è un mock che risponde sempre
 * lo stesso: esegue le query vere contro le migrazioni vere (catena M1 → V2 → M3).
 * Date FISSE (2025/26-2027/28); solo uuid finti. `alunni.stato` non c'è nel banco: lo stato viene da `archiviato_il`.
 */

const S1 = '22222222-2222-4222-8222-222222222222'
const S2 = '33333333-3333-4333-8333-333333333333'
const al = (n: number) => `44444444-4444-4444-8444-4444444444${String(n).padStart(2, '0')}`
const UUID_A = '55555555-5555-4555-8555-555555555555'

let db: PGlite
let SEZ_A: string // S1, 2026/27
let SEZ_A2: string // S1, 2026/27
let SEZ_B: string // S1, 2027/28
let AS1: string // anni_sede 2026/27 di S1
let AS1_2728: string // anni_sede 2027/28 di S1
let AS2: string // anni_sede 2026/27 di S2
let GRUPPO: string
const INGRESSO = '2026-09-15' // data_ingresso fissa: il trigger la prenderebbe da `now()`

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}

/* ------------------------------------------------------------------------------------------------ */
/* L'adattatore: supabase-js → SQL, quanto basta a `scriviFrequenza`.                                */
/* ------------------------------------------------------------------------------------------------ */

type Errore = { code: string; message: string } | null
const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`identificatore non ammesso: ${s}`)
  return s
}
const colonne = (s: string) => s.split(',').map((c) => ident(c.trim())).join(', ')

function erroreDa(e: unknown): Errore {
  const x = e as { code?: string; message?: string }
  // PostgREST rende «tabella assente» come PGRST205, non come 42P01
  const code = x.code === '42P01' ? 'PGRST205' : (x.code ?? 'XX000')
  return { code, message: String(x.message ?? '') }
}

// PostgREST rende le `date` come stringhe AAAA-MM-GG, PGlite come Date: l'adattatore le riporta a stringa
const PARSER = { parsers: { 1082: (v: string) => v } }

function clienteSu(pg: PGlite, scritture: { n: number } = { n: 0 }): SupabaseClient {
  const from = (tabella: string) => {
    const t = ident(tabella)
    const st: { op?: 'select' | 'update'; cols: string; set: Record<string, unknown>; filtri: Array<[string, unknown]> } = {
      cols: '*', set: {}, filtri: [],
    }
    const esegui = async (primo: boolean): Promise<{ data: unknown; error: Errore }> => {
      try {
        const params: unknown[] = []
        const p = (v: unknown) => { params.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : v); return `$${params.length}` }
        const dove = st.filtri.map(([c, v]) => `${ident(c)} = ${p(v)}`).join(' AND ')
        if (st.op === 'update') {
          scritture.n++
          const set = Object.entries(st.set).map(([c, v]) => `${ident(c)} = ${p(v)}`).join(', ')
          const r = await pg.query(`UPDATE public.${t} SET ${set} WHERE ${dove} RETURNING ${colonne(st.cols === '*' ? 'id' : st.cols)}`, params, PARSER)
          return { data: r.rows, error: null }
        }
        const r = await pg.query(`SELECT ${st.cols === '*' ? '*' : colonne(st.cols)} FROM public.${t} WHERE ${dove}`, params, PARSER)
        return { data: primo ? (r.rows[0] ?? null) : r.rows, error: null }
      } catch (e) {
        return { data: null, error: erroreDa(e) }
      }
    }
    const b: Record<string, unknown> = {
      select(cols = '*') { if (!st.op) st.op = 'select'; st.cols = cols; return b },
      update(set: Record<string, unknown>) { st.op = 'update'; st.set = set; return b },
      eq(c: string, v: unknown) { st.filtri.push([c, v]); return b },
      maybeSingle: () => esegui(true),
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => esegui(false).then(ok, ko),
    }
    return b
  }
  const rpc = async (nome: string, args: Record<string, unknown>) => {
    try {
      const chiavi = Object.keys(args).map(ident)
      const r = await pg.query(
        `SELECT public.${ident(nome)}(${chiavi.map((k, i) => `${k} => $${i + 1}`).join(', ')}) AS v`,
        chiavi.map((k) => args[k]),
      )
      return { data: (r.rows[0] as { v: unknown }).v, error: null }
    } catch (e) {
      return { data: null, error: erroreDa(e) }
    }
  }
  return { from, rpc } as unknown as SupabaseClient
}

/* ------------------------------------------------------------------------------------------------ */
/* Le righe                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

const COLONNE_FREQ = `
  stato, section_id, data_ingresso::text AS data_ingresso, data_uscita::text AS data_uscita,
  retta_mensile::float8 AS retta_mensile, retta_a_carico_di, retta_split_config, intestatario_fatture,
  giorno_scadenza_pagamenti, gruppo_mensa_id, sospeso, sospeso_causa, sospeso_motivo,
  to_char(sospeso_il AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sospeso_il, sospeso_da, usa_pannolino`

type RigaFreq = Record<string, unknown>
async function frequenza(alunno: string, annoSede = AS1): Promise<RigaFreq | undefined> {
  const r = await db.query<RigaFreq>(
    `SELECT ${COLONNE_FREQ} FROM public.frequenze WHERE alunno_id = $1 AND anno_sede_id = $2`, [alunno, annoSede])
  return r.rows[0]
}
async function tutteLeFrequenze(): Promise<RigaFreq[]> {
  const r = await db.query<RigaFreq>(`SELECT alunno_id, anno_sede_id, ${COLONNE_FREQ} FROM public.frequenze ORDER BY alunno_id, anno_sede_id`)
  return r.rows
}
async function nuovoAlunno(n: number, o: { sede?: string; sezione?: string | null } = {}): Promise<string> {
  await db.query(
    `INSERT INTO public.alunni (id, scuola_id, section_id) VALUES ($1, $2, $3)`,
    [al(n), o.sede ?? S1, o.sezione === undefined ? SEZ_A : o.sezione])
  // `data_ingresso` nasce da `now()` ed entra nel clamp di `data_uscita`: la si fissa, il test non dipende dal giorno
  await db.query(`UPDATE public.frequenze SET data_ingresso = $2 WHERE alunno_id = $1`, [al(n), INGRESSO])
  return al(n)
}
/** Applica una patch a `alunni` (SQL vero): il trigger-specchio scrive la frequenza. */
async function patchAlunno(id: string, patch: Record<string, unknown>): Promise<void> {
  const chiavi = Object.keys(patch).map(ident)
  const set = chiavi.map((c, i) => `${c} = $${i + 2}`).join(', ')
  await db.query(
    `UPDATE public.alunni SET ${set} WHERE id = $1`,
    [id, ...chiavi.map((c) => (patch[c] !== null && typeof patch[c] === 'object' ? JSON.stringify(patch[c]) : patch[c]))])
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [S1, S2], fino: 'M3', completo: true })
  const a2627 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2026`)
  const a2728 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2027`)
  AS1 = await una<string>(`SELECT id FROM public.anni_sede WHERE scuola_id = $1 AND anno_id = $2`, [S1, a2627])
  AS2 = await una<string>(`SELECT id FROM public.anni_sede WHERE scuola_id = $1 AND anno_id = $2`, [S2, a2627])
  AS1_2728 = await una<string>(`SELECT id FROM public.anni_sede WHERE scuola_id = $1 AND anno_id = $2`, [S1, a2728])
  SEZ_A = await una<string>(`INSERT INTO public.sections (scuola_id, name) VALUES ($1, 'Girasoli') RETURNING id`, [S1])
  SEZ_A2 = await una<string>(`INSERT INTO public.sections (scuola_id, name) VALUES ($1, 'Margherite') RETURNING id`, [S1])
  SEZ_B = await una<string>(`INSERT INTO public.sections (scuola_id, name, anno_id) VALUES ($1, 'Nuvole', $2) RETURNING id`, [S1, a2728])
  GRUPPO = await una<string>(`INSERT INTO public.gruppi_mensa (scuola_id, nome) VALUES ($1, 'Gruppo di prova') RETURNING id`, [S1])
}, 120_000)
afterAll(async () => { await db.close() })
beforeEach(async () => {
  vi.mocked(logEvento).mockClear()
  vi.mocked(logErrore).mockClear()
  await db.exec(`
    UPDATE public.anno_regole SET specchio_alunni_attivo = true;
    DELETE FROM public.frequenze;
    DELETE FROM public.alunni;
  `)
})

/* ------------------------------------------------------------------------------------------------ */
/* 1. PARITÀ                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

interface Caso { nome: string; prima?: () => Record<string, unknown>; patch: () => Record<string, unknown> }
const CASI: Caso[] = [
  { nome: 'retta 0 → NULL', patch: () => ({ importo_retta_mensile: 0 }) },
  { nome: 'retta 120.00', patch: () => ({ importo_retta_mensile: 120 }) },
  { nome: 'retta -5 → NULL', patch: () => ({ importo_retta_mensile: -5 }) },
  { nome: 'retta 120 poi 0 → NULL', prima: () => ({ importo_retta_mensile: 120 }), patch: () => ({ importo_retta_mensile: 0 }) },
  { nome: 'archiviato alle 22:30Z = già il 13 a Roma', patch: () => ({ archiviato_il: '2026-10-12T22:30:00Z' }) },
  { nome: 'archiviato a mezzogiorno', patch: () => ({ archiviato_il: '2026-10-12T10:00:00Z' }) },
  {
    nome: 'riattivato (archiviato_il → NULL)',
    prima: () => ({ archiviato_il: '2026-10-12T22:30:00Z' }),
    patch: () => ({ archiviato_il: null }),
  },
  { nome: 'section_id', patch: () => ({ section_id: SEZ_A2 }) },
  { nome: 'section_id → NULL', patch: () => ({ section_id: null }) },
  {
    nome: 'sospeso + causa + motivo + data + autore',
    patch: () => ({
      sospeso: true, sospeso_causa: 'morosita', sospeso_motivo: 'motivo di prova',
      sospeso_il: '2026-10-01T08:00:00Z', sospeso_da: UUID_A,
    }),
  },
  {
    nome: 'sospensione tolta',
    prima: () => ({ sospeso: true, sospeso_causa: 'altro', sospeso_motivo: 'x', sospeso_il: '2026-10-01T08:00:00Z', sospeso_da: UUID_A }),
    patch: () => ({ sospeso: false, sospeso_causa: null, sospeso_motivo: null, sospeso_il: null, sospeso_da: null }),
  },
  { nome: 'usa_pannolino', patch: () => ({ usa_pannolino: true }) },
  { nome: 'gruppo_mensa_id', patch: () => ({ gruppo_mensa_id: GRUPPO }) },
  { nome: 'intestatario_fatture', patch: () => ({ intestatario_fatture: { tipo: 'genitore', id: UUID_A } }) },
  { nome: 'retta_a_carico_di', patch: () => ({ retta_a_carico_di: al(90) }) },
  { nome: 'retta_split_config', patch: () => ({ retta_split_config: { quote: [{ id: UUID_A, perc: 50 }, { id: al(90), perc: 50 }] } }) },
  { nome: 'giorno_scadenza 0 → NULL', patch: () => ({ giorno_scadenza_pagamenti: 0 }) },
  { nome: 'giorno_scadenza 1', patch: () => ({ giorno_scadenza_pagamenti: 1 }) },
  { nome: 'giorno_scadenza 15', patch: () => ({ giorno_scadenza_pagamenti: 15 }) },
  { nome: 'giorno_scadenza 28', patch: () => ({ giorno_scadenza_pagamenti: 28 }) },
  { nome: 'giorno_scadenza 29 → NULL', patch: () => ({ giorno_scadenza_pagamenti: 29 }) },
  { nome: 'giorno_scadenza 31 → NULL', patch: () => ({ giorno_scadenza_pagamenti: 31 }) },
  {
    nome: 'più colonne insieme',
    patch: () => ({ importo_retta_mensile: 95.5, giorno_scadenza_pagamenti: 10, usa_pannolino: true, section_id: SEZ_A2 }),
  },
]

describe('parità: la tabella TS dà gli stessi valori del trigger-specchio', () => {
  beforeEach(async () => {
    await nuovoAlunno(90) // il destinatario di `retta_a_carico_di` deve esistere (FK)
  })

  for (const c of CASI) {
    it(c.nome, async () => {
      const id = await nuovoAlunno(1)
      if (c.prima) await patchAlunno(id, c.prima())
      const prima = (await frequenza(id)) as RigaFreq
      expect(prima).toBeDefined()

      const patch = c.patch()
      await patchAlunno(id, patch) // SQL: il trigger scrive la frequenza
      const dopo = await frequenza(id)

      const tradotti = campiFrequenzaDaAlunno(patch)
      // il valore di ogni colonna, dopo il trigger, è quello della traduzione; le altre non si muovono
      expect(dopo).toEqual({ ...prima, ...tradotti })
    })
  }

  it('la tabella dei casi tocca tutte e 15 le colonne copiate (tranne scuola_id, vedi sotto)', () => {
    const toccate = new Set(CASI.flatMap((c) => Object.keys({ ...c.prima?.(), ...c.patch() })))
    for (const col of [
      'section_id', 'archiviato_il', 'importo_retta_mensile', 'retta_a_carico_di', 'retta_split_config',
      'intestatario_fatture', 'giorno_scadenza_pagamenti', 'gruppo_mensa_id', 'sospeso', 'sospeso_causa',
      'sospeso_motivo', 'sospeso_il', 'sospeso_da', 'usa_pannolino',
    ]) expect(toccate.has(col), col).toBe(true)
  })
})

describe('campiFrequenzaDaAlunno (pura)', () => {
  it('una patch senza colonne copiate dà {}', () => {
    expect(campiFrequenzaDaAlunno({})).toEqual({})
    expect(campiFrequenzaDaAlunno({ nome: 'x', classe_sezione: 'y', stato: 'ritirato' })).toEqual({})
  })
  it('traduce solo le colonne presenti', () => {
    expect(campiFrequenzaDaAlunno({ usa_pannolino: true })).toEqual({ usa_pannolino: true })
    expect(campiFrequenzaDaAlunno({ importo_retta_mensile: 120 })).toEqual({ retta_mensile: 120 })
  })
  it('lo stato viene da archiviato_il, non da alunni.stato', () => {
    expect(campiFrequenzaDaAlunno({ stato: 'ritirato' })).toEqual({})
    expect(campiFrequenzaDaAlunno({ archiviato_il: '2026-10-12T22:30:00Z' })).toEqual({ stato: 'ritirato', data_uscita: '2026-10-13' })
    expect(campiFrequenzaDaAlunno({ archiviato_il: null })).toEqual({ stato: 'iscritto', data_uscita: null })
  })
  it('scuola_id non diventa una colonna della frequenza (la sede della frequenza è quella del suo anno)', () => {
    expect(campiFrequenzaDaAlunno({ scuola_id: S2 })).toEqual({})
  })
  it('accetta anche numeri come stringa (numeric di PostgREST)', () => {
    expect(campiFrequenzaDaAlunno({ importo_retta_mensile: '120.00' })).toEqual({ retta_mensile: 120 })
    expect(campiFrequenzaDaAlunno({ importo_retta_mensile: 'abc' })).toEqual({ retta_mensile: null })
  })
})

/* ------------------------------------------------------------------------------------------------ */
/* 2. scriviFrequenza                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

describe('scriviFrequenza', () => {
  it('scrittura esplicita sull\'anno attivo: ok, nessuna riga in più, nessun valore cambiato (idempotente)', async () => {
    const id = await nuovoAlunno(1)
    const patch = {
      importo_retta_mensile: 120, giorno_scadenza_pagamenti: 15, usa_pannolino: true,
      archiviato_il: '2026-10-12T22:30:00Z', sospeso: true, sospeso_causa: 'altro', sospeso_motivo: 'riservato',
    }
    await patchAlunno(id, patch)
    const prima = await tutteLeFrequenze()
    const scritture = { n: 0 }
    const r = await scriviFrequenza(clienteSu(db, scritture), { alunnoId: id, annoSedeId: AS1, campi: campiFrequenzaDaAlunno(patch) })
    expect(r).toEqual({ ok: true })
    expect(scritture.n).toBe(1)
    expect(await tutteLeFrequenze()).toEqual(prima)
  })

  it('scrive davvero: una colonna diversa dallo specchio arriva alla frequenza', async () => {
    const id = await nuovoAlunno(1)
    // lo specchio è spento: la frequenza resta com'è, e `scriviFrequenza` è l'unica a scrivere
    await db.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = false`)
    await patchAlunno(id, { importo_retta_mensile: 77 })
    expect((await frequenza(id))?.retta_mensile).toBeNull()
    const r = await scriviFrequenza(clienteSu(db), { alunnoId: id, annoSedeId: AS1, campi: campiFrequenzaDaAlunno({ importo_retta_mensile: 77 }) })
    expect(r).toEqual({ ok: true })
    expect((await frequenza(id))?.retta_mensile).toBe(77)
  })

  it('la frequenza non c\'è: non la crea (la crea lo specchio)', async () => {
    await db.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = false`)
    const id = await nuovoAlunno(1)
    expect(await frequenza(id)).toBeUndefined()
    const r = await scriviFrequenza(clienteSu(db), { alunnoId: id, annoSedeId: AS1, campi: { usa_pannolino: true } })
    // niente è stato scritto, e lo dice: chi chiama non deve credere a una frequenza che non c'è
    expect(r).toEqual({ ok: true, saltata: 'nessuna-riga' })
    expect(await frequenza(id)).toBeUndefined()
  })

  it('set vuoto dopo lo scarto di stato/data_uscita (frequenza non `recupero`): nessuna scrittura, e lo dice', async () => {
    const id = await nuovoAlunno(1)
    await db.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = false`)
    await db.query(`UPDATE public.frequenze SET origine = 'segreteria', tipo = 'nuova' WHERE alunno_id = $1`, [id])
    const scritture = { n: 0 }
    const r = await scriviFrequenza(clienteSu(db, scritture), {
      alunnoId: id, annoSedeId: AS1, campi: campiFrequenzaDaAlunno({ archiviato_il: '2026-10-12T22:30:00Z' }),
    })
    expect(r).toEqual({ ok: true, saltata: 'nessuna-modifica' })
    expect(scritture.n).toBe(0)
  })

  it('stato e data_uscita cambiano solo se la frequenza è `recupero`', async () => {
    const id = await nuovoAlunno(1)
    await db.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = false`)
    await db.query(`UPDATE public.frequenze SET origine = 'segreteria', tipo = 'nuova' WHERE alunno_id = $1`, [id])
    const prima = await frequenza(id)
    const r = await scriviFrequenza(clienteSu(db), {
      alunnoId: id, annoSedeId: AS1,
      campi: campiFrequenzaDaAlunno({ archiviato_il: '2026-10-12T22:30:00Z', usa_pannolino: true }),
    })
    expect(r).toEqual({ ok: true })
    const dopo = await frequenza(id)
    expect(dopo?.stato).toBe(prima?.stato)
    expect(dopo?.data_uscita).toBe(prima?.data_uscita)
    expect(dopo?.usa_pannolino).toBe(true)
  })

  it('data_uscita si porta dentro [ingresso, fine] come fa lo specchio', async () => {
    const id = await nuovoAlunno(1)
    await db.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = false`)
    // archiviato PRIMA dell'ingresso (2026-09-15): l'uscita non può precederlo
    const r = await scriviFrequenza(clienteSu(db), {
      alunnoId: id, annoSedeId: AS1, campi: campiFrequenzaDaAlunno({ archiviato_il: '2026-08-01T10:00:00Z' }),
    })
    expect(r).toEqual({ ok: true })
    expect(await frequenza(id)).toMatchObject({ stato: 'ritirato', data_uscita: INGRESSO })
  })

  it('nessun campo: saltata \'nessun-campo\', zero query', async () => {
    const id = await nuovoAlunno(1)
    const scritture = { n: 0 }
    const r = await scriviFrequenza(clienteSu(db, scritture), { alunnoId: id, annoSedeId: AS1, campi: {} })
    expect(r).toEqual({ ok: true, saltata: 'nessun-campo' })
    expect(scritture.n).toBe(0)
  })

  it('anno non attivo (2027/28): saltata \'anno-non-attivo\' e NESSUNA scrittura', async () => {
    const id = await nuovoAlunno(1)
    // una frequenza del 2027/28 esiste: non deve cambiare
    await db.query(
      `INSERT INTO public.frequenze (alunno_id, anno_sede_id, origine, tipo, stato, data_ingresso)
       SELECT $1, id, 'segreteria', 'conferma', 'in_attesa', inizio FROM public.anni_sede WHERE id = $2`, [id, AS1_2728])
    const prima = await tutteLeFrequenze()
    const scritture = { n: 0 }
    const r = await scriviFrequenza(clienteSu(db, scritture), { alunnoId: id, annoSedeId: AS1_2728, campi: { usa_pannolino: true } })
    expect(r).toEqual({ ok: true, saltata: 'anno-non-attivo' })
    expect(scritture.n).toBe(0)
    expect(await tutteLeFrequenze()).toEqual(prima)
  })

  it('anno_sede sconosciuto: saltata \'anno-non-attivo\'', async () => {
    const id = await nuovoAlunno(1)
    const r = await scriviFrequenza(clienteSu(db), { alunnoId: id, annoSedeId: UUID_A, campi: { usa_pannolino: true } })
    expect(r).toEqual({ ok: true, saltata: 'anno-non-attivo' })
  })

  it('fail-open: una sezione del 2027/28 → SEZIONE_DI_ALTRO_ANNO, non lancia, alunni resta com\'è', async () => {
    const id = await nuovoAlunno(1)
    await patchAlunno(id, { section_id: SEZ_B }) // alunni passa; lo specchio fail-open non scrive la frequenza
    expect(await una(`SELECT section_id FROM public.alunni WHERE id = $1`, [id])).toBe(SEZ_B)
    const r = await scriviFrequenza(clienteSu(db), { alunnoId: id, annoSedeId: AS1, campi: campiFrequenzaDaAlunno({ section_id: SEZ_B }) })
    expect(r).toEqual({ ok: false, codice: 'SEZIONE_DI_ALTRO_ANNO' })
    expect(await una(`SELECT section_id FROM public.alunni WHERE id = $1`, [id])).toBe(SEZ_B)
    expect((await frequenza(id))?.section_id).toBe(SEZ_A)
    // il warn porta il codice e nessun valore
    expect(logEvento).toHaveBeenCalledWith('anno-scolastico', 'warn', expect.objectContaining({ error_code: 'SEZIONE_DI_ALTRO_ANNO' }))
    expect(logErrore).not.toHaveBeenCalled()
  })

  it('un errore che non è dell\'anno: SCRITTURA_FALLITA e logErrore, mai un valore nei log', async () => {
    const id = await nuovoAlunno(1)
    const r = await scriviFrequenza(clienteSu(db), {
      alunnoId: id, annoSedeId: AS1,
      campi: { sospeso: true, sospeso_causa: 'non-ammessa', sospeso_motivo: 'testo riservato' }, // viola il CHECK
    })
    expect(r).toEqual({ ok: false, codice: 'SCRITTURA_FALLITA' })
    expect(logErrore).toHaveBeenCalledTimes(1)
    const tutto = JSON.stringify([vi.mocked(logErrore).mock.calls, vi.mocked(logEvento).mock.calls])
    expect(tutto).not.toContain('testo riservato')
    expect(tutto).not.toContain('non-ammessa')
  })

  it('schema indietro (nessuna tabella dell\'anno: PGRST205) → saltata \'schema-indietro\'', async () => {
    const vuoto = new PGlite()
    try {
      const r = await scriviFrequenza(clienteSu(vuoto), { alunnoId: al(1), annoSedeId: AS1, campi: { usa_pannolino: true } })
      expect(r).toEqual({ ok: true, saltata: 'schema-indietro' })
      expect(logErrore).not.toHaveBeenCalled()
    } finally {
      await vuoto.close()
    }
  })

  it('non lancia mai, nemmeno se il client lancia', async () => {
    const rotto = { from: () => { throw new Error('boom') }, rpc: () => { throw new Error('boom') } } as unknown as SupabaseClient
    const r = await scriviFrequenza(rotto, { alunnoId: al(1), annoSedeId: AS1, campi: { usa_pannolino: true } })
    expect(r).toEqual({ ok: false, codice: 'SCRITTURA_FALLITA' })
  })
})

/* ------------------------------------------------------------------------------------------------ */
/* 3. Trasferimento fra due sedi (review focus 4)                                                    */
/* ------------------------------------------------------------------------------------------------ */

describe('trasferimento fra due sedi', () => {
  it('la vecchia frequenza è `trasferito`, la nuova `iscritto`, e l\'indice «una viva per anno» regge', async () => {
    const id = await nuovoAlunno(1)
    await patchAlunno(id, { scuola_id: S2, section_id: null })
    const r = await db.query<{ anno_sede_id: string; stato: string }>(
      `SELECT anno_sede_id, stato FROM public.frequenze WHERE alunno_id = $1 ORDER BY stato`, [id])
    expect(r.rows).toEqual([
      { anno_sede_id: AS2, stato: 'iscritto' },
      { anno_sede_id: AS1, stato: 'trasferito' },
    ])
    // l'indice è parziale (pg_indexes, non pg_constraint): una seconda frequenza viva nello stesso anno non entra
    expect(await una<number>(
      `SELECT count(*)::int FROM pg_indexes WHERE indexname = 'frequenze_una_viva_per_anno'`)).toBe(1)
    await expect(db.query(
      `UPDATE public.frequenze SET stato = 'iscritto' WHERE alunno_id = $1 AND anno_sede_id = $2`, [id, AS1],
    )).rejects.toMatchObject({ code: '23505' })
  })

  it('scriviFrequenza sulla nuova sede scrive la nuova frequenza e lascia stare la trasferita', async () => {
    const id = await nuovoAlunno(1)
    await patchAlunno(id, { scuola_id: S2, section_id: null })
    const vecchia = await frequenza(id, AS1)
    const r = await scriviFrequenza(clienteSu(db), { alunnoId: id, annoSedeId: AS2, campi: { usa_pannolino: true } })
    expect(r).toEqual({ ok: true })
    expect((await frequenza(id, AS2))?.usa_pannolino).toBe(true)
    expect(await frequenza(id, AS1)).toEqual(vecchia)
  })
})
