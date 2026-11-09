import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaDbAnnoPr2, SCHEMA_ISCRIZIONE_ANNO } from '../helpers/schema-anno-pglite'

vi.mock('@/lib/logging/logger', () => ({
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import { campiFrequenzaDaAlunno, scriviFrequenza } from '@/lib/anno/frequenze'

/**
 * COMPITO 4.5.1 · ARCHIVIARE UN BAMBINO VALE PER OGNI ORIGINE DELLA FREQUENZA (fase B accesa, PGlite vero).
 *
 * Fino alla 4.4 ogni frequenza è `origine = 'recupero'`, e `scriviFrequenza` scrive stato e uscita solo per quelle. Dal 4.5.5 ne
 * nascono di `domanda`, `conferma`, `segreteria`: se il ritiro non le chiudesse, la frequenza resterebbe viva e lo specchio
 * `alunni_riallinea_da_frequenze` («viva → iscritto, archiviato_il NULL») rimetterebbe fra gli iscritti il bambino appena archiviato,
 * alla scrittura successiva di QUALUNQUE colonna della frequenza (una retta, una sezione).
 *
 * Il percorso è quello delle route in fase B (`scriviAlunnoEFrequenza`): PRIMA la frequenza, POI `alunni`. Qui i due passi si fanno a
 * mano, con il client reale di `scriviFrequenza` adattato su PGlite. Date FISSE, solo uuid finti.
 * `alunni.stato` (col CHECK di produzione) lo porta `SCHEMA_ISCRIZIONE_ANNO`.
 */

const S1 = '22222222-2222-4222-8222-222222222222'
const AL = '11111111-1111-4111-8111-111111111111'
const INGRESSO = '2026-09-15'
const RITIRO = '2026-10-12T10:00:00Z' // il 12 ottobre a Roma

let db: PGlite
let AS1: string // anni_sede 2026/27 di S1 (corrente)

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}

/* ── L'adattatore supabase-js → SQL, quanto basta a `scriviFrequenza` (lo stesso di anno-frequenze.test.ts) ── */
type Errore = { code: string; message: string } | null
const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`identificatore non ammesso: ${s}`)
  return s
}
const colonne = (s: string) => s.split(',').map((c) => ident(c.trim())).join(', ')
const erroreDa = (e: unknown): Errore => {
  const x = e as { code?: string; message?: string }
  return { code: x.code === '42P01' ? 'PGRST205' : (x.code ?? 'XX000'), message: String(x.message ?? '') }
}
const PARSER = { parsers: { 1082: (v: string) => v } } // le `date` come stringhe AAAA-MM-GG, come PostgREST

function cliente(pg: PGlite): SupabaseClient {
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
        chiavi.map((k) => args[k]))
      return { data: (r.rows[0] as { v: unknown }).v, error: null }
    } catch (e) {
      return { data: null, error: erroreDa(e) }
    }
  }
  return { from, rpc } as unknown as SupabaseClient
}

/* ── Le righe ── */
const frequenza = () => una<Record<string, unknown>>(
  `SELECT jsonb_build_object('stato', stato, 'data_uscita', data_uscita::text, 'retta_mensile', retta_mensile::float8, 'origine', origine)
     FROM public.frequenze WHERE alunno_id = $1 AND anno_sede_id = $2`, [AL, AS1])
const alunno = () => una<Record<string, unknown>>(
  `SELECT jsonb_build_object('stato', stato, 'archiviato_il', archiviato_il) FROM public.alunni WHERE id = $1`, [AL])

/** Un bambino la cui frequenza dell'anno attivo nasce da una DOMANDA (non dal recupero): viva, `in_attesa` (nessuna quota pagata). */
async function bambinoDaDomanda(): Promise<void> {
  await db.query(`INSERT INTO public.alunni (id, scuola_id, stato) VALUES ($1, $2, 'iscritto')`, [AL, S1])
  await db.query(`UPDATE public.frequenze SET data_ingresso = $2 WHERE alunno_id = $1`, [AL, INGRESSO])
  // il trigger declassa l'`iscritto` che non ha la quota a `in_attesa` (R25); `tipo` è obbligatorio fuori dal recupero
  await db.query(`UPDATE public.frequenze SET origine = 'domanda', tipo = 'nuova' WHERE alunno_id = $1`, [AL])
}

/** Quello che fa la route in fase B per archiviare: PRIMA la frequenza, POI `alunni`. */
async function archivia(): Promise<void> {
  const r = await scriviFrequenza(cliente(db), { alunnoId: AL, annoSedeId: AS1, campi: campiFrequenzaDaAlunno({ archiviato_il: RITIRO }) })
  expect(r).toMatchObject({ ok: true })
  await db.query(`UPDATE public.alunni SET archiviato_il = $2, stato = 'ritirato' WHERE id = $1`, [AL, RITIRO])
}
/** Quello che fa la route per riattivare. */
async function riattiva(): Promise<void> {
  const r = await scriviFrequenza(cliente(db), { alunnoId: AL, annoSedeId: AS1, campi: campiFrequenzaDaAlunno({ archiviato_il: null }) })
  expect(r).toMatchObject({ ok: true })
  await db.query(`UPDATE public.alunni SET archiviato_il = NULL, stato = 'iscritto' WHERE id = $1`, [AL])
}
/** Una scrittura qualunque della frequenza (il cambio di retta): fa scattare lo specchio `frequenze → alunni`. */
async function cambiaRetta(importo: number): Promise<void> {
  const r = await scriviFrequenza(cliente(db), { alunnoId: AL, annoSedeId: AS1, campi: campiFrequenzaDaAlunno({ importo_retta_mensile: importo }) })
  expect(r).toMatchObject({ ok: true })
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [S1], fino: 'M43', completo: true, codaPrima: SCHEMA_ISCRIZIONE_ANNO })
  const a2627 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2026`)
  AS1 = await una<string>(`SELECT id FROM public.anni_sede WHERE scuola_id = $1 AND anno_id = $2`, [S1, a2627])
}, 120_000)
afterAll(async () => { await db.close() })
beforeEach(async () => {
  await db.exec(`DELETE FROM public.frequenze; DELETE FROM public.pagamenti; DELETE FROM public.alunni;`)
})

describe('fase B · archiviare un bambino con frequenza di origine domanda', () => {
  it('il banco è in fase B (lo specchio frequenze → alunni è acceso) e la frequenza nasce non-recupero e viva', async () => {
    expect(await una<boolean>(`SELECT specchio_frequenze_attivo FROM public.anno_regole`)).toBe(true)
    await bambinoDaDomanda()
    expect(await frequenza()).toMatchObject({ origine: 'domanda', stato: 'in_attesa', data_uscita: null })
  })

  it('archiviare: dopo una seconda scrittura (cambio di retta) la frequenza è ancora `ritirato` e `alunni.archiviato_il` è ancora valorizzato', async () => {
    await bambinoDaDomanda()
    await archivia()
    await cambiaRetta(480) // lo specchio rilegge la frequenza: se fosse ancora viva, azzererebbe archiviato_il

    expect(await frequenza()).toMatchObject({ stato: 'ritirato', data_uscita: '2026-10-12', retta_mensile: 480 })
    const a = await alunno()
    expect(a.archiviato_il, 'alunni.archiviato_il dopo la seconda scrittura').not.toBeNull()
    expect(a.stato).toBe('ritirato')
  })

  it('riaprirlo con moduli o quota mancanti dà `in_attesa`', async () => {
    await bambinoDaDomanda()
    await archivia()
    await riattiva()
    expect(await frequenza()).toMatchObject({ stato: 'in_attesa', data_uscita: null })
    await cambiaRetta(500)
    const a = await alunno()
    expect(a.archiviato_il).toBeNull()
    expect(a.stato).toBe('iscritto')
  })

  it('riaprirlo con moduli e quota a posto dà `iscritto` (lo decide il trigger, non il codice)', async () => {
    await bambinoDaDomanda()
    await archivia()
    // la quota è pagata mentre il bambino è fuori; la frequenza resta ritirata, il trigger ricalcola solo i flag
    const quota = await una<string>(
      `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, stato, importo_pagato)
       VALUES ($1, $2, 'Iscrizione', 100, DATE '2026-09-30', 'pagato', 100) RETURNING id`, [AL, S1])
    await db.query(`UPDATE public.frequenze SET quota_pagamento_id = $2 WHERE alunno_id = $1`, [AL, quota])
    expect(await frequenza()).toMatchObject({ stato: 'ritirato' })

    await riattiva()
    expect(await frequenza()).toMatchObject({ stato: 'iscritto', data_uscita: null })
    expect((await alunno()).archiviato_il).toBeNull()
  })

  it('una patch senza `archiviato_il` non cambia lo stato (né della viva né della chiusa)', async () => {
    await bambinoDaDomanda()
    await cambiaRetta(450)
    expect(await frequenza()).toMatchObject({ stato: 'in_attesa', data_uscita: null, retta_mensile: 450 })
    await archivia()
    await cambiaRetta(460)
    expect(await frequenza()).toMatchObject({ stato: 'ritirato', data_uscita: '2026-10-12', retta_mensile: 460 })
  })
})
