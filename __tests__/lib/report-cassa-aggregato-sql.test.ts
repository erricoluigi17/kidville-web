// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import {
  aggregaEntratePerCategoria,
  aggregaMensile,
  aggregaUscitePerCategoria,
  componiReport,
  differenzeTotali,
  type IncassoReportData,
  type ReportCassa,
  type ReportGrezzo,
} from '@/lib/cassa/report'

/**
 * REPORT DI CASSA · LA FUNZIONE SQL CONTRO LA SEMANTICA DI RIFERIMENTO.
 *
 * Fino al 2026-10-10 la route sommava in JavaScript righe che PostgREST taglia a
 * 1000 (in produzione gli incassi delle sedi erano 1.672). Ora somma
 * `report_cassa_aggregato`. Questo file la esegue su un Postgres vero, su dati
 * CASUALI ma riproducibili (seme fisso): più sedi, categorie globali e di sede,
 * metodi reali e non, storni il cui originale sta dentro o FUORI dal periodo,
 * uscite e loro storni. Per ogni combinazione di filtri il risultato deve essere
 * IDENTICO a quello delle funzioni pure di `src/lib/cassa/report.ts` applicate alle
 * stesse righe, e i totali devono quadrare con il SUM piatto. Più di 1000 incassi:
 * il caso che prima si perdeva. Solo dati finti.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(suffisso: string): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith(suffisso))
  if (!f) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, f), 'utf8')
}
const NUOVA = migrazione('_report_cassa_aggregato.sql')

const SEDI = ['a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003']
const FUORI = 'a0000000-0000-4000-8000-0000000000ff' // una sede che nessun filtro chiede
const CAT_PAG = ['c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000003']
const CAT_CASSA = ['c2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002']
const METODI = ['contanti', 'bonifico', 'pos', 'assegno', 'altro', 'credito_famiglia', 'rettifica']

// Generatore deterministico (mulberry32): stessi dati a ogni giro.
function rng(seme: number) {
  return () => {
    seme |= 0; seme = (seme + 0x6d2b79f5) | 0
    let t = Math.imul(seme ^ (seme >>> 15), 1 | seme)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const uuid = (pref: string, n: number) => `${pref}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

interface Inc { id: string; pagamento: string; sede: string; categoria: string | null; importo: number; metodo: string; storno_di: string | null; data: string }
interface Mov { id: string; sede: string; tipo: string; importo: number; metodo: string; data: string; categoria: string | null }

const caso = rng(20261010)
const pick = <T,>(xs: T[]) => xs[Math.floor(caso() * xs.length)]
const giorno = () => `2026-${String(1 + Math.floor(caso() * 9)).padStart(2, '0')}-${String(1 + Math.floor(caso() * 28)).padStart(2, '0')}`
const euro = () => Math.round((1 + caso() * 300) * 100) / 100

const PAGAMENTI: Array<{ id: string; sede: string; categoria: string | null }> = []
for (let n = 1; n <= 300; n++) {
  PAGAMENTI.push({ id: uuid('b0000000', n), sede: n % 50 === 0 ? FUORI : pick(SEDI), categoria: caso() < 0.1 ? null : pick(CAT_PAG) })
}
const INCASSI: Inc[] = []
for (let n = 1; n <= 1400; n++) {
  const p = pick(PAGAMENTI)
  INCASSI.push({ id: uuid('d0000000', n), pagamento: p.id, sede: p.sede, categoria: p.categoria, importo: euro(), metodo: pick(METODI), storno_di: null, data: giorno() })
}
// Storni: importo negato, metodo 'storno', stesso pagamento; data a caso (anche
// fuori dal periodo dell'originale). Uno storno di uno storno, per scrupolo.
for (let n = 1; n <= 120; n++) {
  const o = pick(INCASSI.filter((i) => i.storno_di === null))
  INCASSI.push({ ...o, id: uuid('d1000000', n), importo: -o.importo, metodo: 'storno', storno_di: o.id, data: giorno() })
}
INCASSI.push({ ...INCASSI[1400], id: uuid('d2000000', 1), importo: 5, storno_di: INCASSI[1400].id })
const MOVIMENTI: Mov[] = []
for (let n = 1; n <= 200; n++) {
  MOVIMENTI.push({ id: uuid('e0000000', n), sede: caso() < 0.05 ? FUORI : pick(SEDI), tipo: caso() < 0.75 ? 'uscita' : 'entrata', importo: caso() < 0.1 ? -euro() : euro(), metodo: pick(['contanti', 'bonifico', 'carta', 'altro']), data: giorno(), categoria: caso() < 0.15 ? null : pick(CAT_CASSA) })
}

let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE TYPE public.incasso_metodo AS ENUM ('contanti','bonifico','pos','assegno','altro','credito_famiglia','storno','rettifica');
    CREATE TABLE public.payment_categories (id uuid PRIMARY KEY, nome text);
    CREATE TABLE public.cassa_categorie (id uuid PRIMARY KEY, nome text);
    CREATE TABLE public.pagamenti (id uuid PRIMARY KEY, scuola_id uuid, categoria_id uuid REFERENCES public.payment_categories(id));
    CREATE TABLE public.incassi (id uuid PRIMARY KEY, pagamento_id uuid NOT NULL REFERENCES public.pagamenti(id),
      importo numeric(10,2) NOT NULL, metodo public.incasso_metodo NOT NULL, storno_di uuid, data_incasso date);
    CREATE TABLE public.cassa_movimenti (id uuid PRIMARY KEY, scuola_id uuid, tipo text NOT NULL, importo numeric(10,2) NOT NULL,
      metodo text, data date, categoria_id uuid REFERENCES public.cassa_categorie(id));
  `)
  await db.exec(NUOVA)
  for (const [i, c] of CAT_PAG.entries()) await db.query('INSERT INTO public.payment_categories VALUES ($1, $2)', [c, `Categoria ${'CAB'[i]}`])
  for (const [i, c] of CAT_CASSA.entries()) await db.query('INSERT INTO public.cassa_categorie VALUES ($1, $2)', [c, `Spesa ${i + 1}`])
  for (const p of PAGAMENTI) await db.query('INSERT INTO public.pagamenti VALUES ($1, $2, $3)', [p.id, p.sede, p.categoria])
  await db.query(
    `INSERT INTO public.incassi SELECT (r->>'id')::uuid, (r->>'pagamento')::uuid, (r->>'importo')::numeric,
       (r->>'metodo')::public.incasso_metodo, NULLIF(r->>'storno_di','')::uuid, (r->>'data')::date
       FROM jsonb_array_elements($1::jsonb) r`, [JSON.stringify(INCASSI)])
  await db.query(
    `INSERT INTO public.cassa_movimenti SELECT (r->>'id')::uuid, (r->>'sede')::uuid, r->>'tipo', (r->>'importo')::numeric,
       r->>'metodo', (r->>'data')::date, NULLIF(r->>'categoria','')::uuid
       FROM jsonb_array_elements($1::jsonb) r`, [JSON.stringify(MOVIMENTI)])
})
afterAll(async () => {
  await db.close()
})

interface Filtri { sedi: string[]; da?: string; a?: string; categoria?: string }

async function sql(f: Filtri): Promise<ReportGrezzo> {
  const r = await db.query<{ r: ReportGrezzo }>(
    'SELECT public.report_cassa_aggregato($1::uuid[], $2::date, $3::date, $4::uuid) AS r',
    [f.sedi, f.da ?? null, f.a ?? null, f.categoria ?? null],
  )
  return r.rows[0].r
}

const nomeCat = (id: string | null) => (id ? `Categoria ${'CAB'[CAT_PAG.indexOf(id)]}` : null)
const nomeCassa = (id: string | null) => (id ? `Spesa ${CAT_CASSA.indexOf(id) + 1}` : null)

/** Le funzioni pure di riferimento sulle stesse righe, per una sede o per tutte. */
function riferimento(f: Filtri, sede: string | null): ReportCassa {
  const nelPeriodo = (d: string) => (!f.da || d >= f.da) && (!f.a || d <= f.a)
  const inc: IncassoReportData[] = INCASSI
    .filter((i) => f.sedi.includes(i.sede) && (sede === null || i.sede === sede) && nelPeriodo(i.data) && (!f.categoria || i.categoria === f.categoria))
    .map((i) => ({ id: i.id, importo: i.importo, metodo: i.metodo, storno_di: i.storno_di, data: i.data, categoria_id: i.categoria, categoria_nome: nomeCat(i.categoria) }))
  const usc = MOVIMENTI
    .filter((m) => m.tipo === 'uscita' && f.sedi.includes(m.sede) && (sede === null || m.sede === sede) && nelPeriodo(m.data))
    .map((m) => ({ importo: m.importo, metodo: m.metodo, data: m.data, categoria_id: m.categoria, categoria_nome: nomeCassa(m.categoria) }))
  return {
    entrate_per_categoria: aggregaEntratePerCategoria(inc),
    uscite_per_categoria: aggregaUscitePerCategoria(usc),
    mensile: aggregaMensile(inc, usc),
  }
}

/** L'ordine delle chiavi di `per_metodo` non è un dato: si confronta ordinato. */
function normalizza(r: ReportCassa) {
  return {
    ...r,
    entrate_per_categoria: r.entrate_per_categoria.map((c) => ({
      ...c,
      per_metodo: Object.fromEntries(Object.entries(c.per_metodo).sort(([x], [y]) => x.localeCompare(y))),
    })),
  }
}

const CASI: Array<[string, Filtri]> = [
  ['tutte le sedi, nessun filtro (più di 1000 incassi)', { sedi: SEDI }],
  ['una sede sola', { sedi: [SEDI[1]] }],
  ['periodo: storni con l’originale fuori dal periodo', { sedi: SEDI, da: '2026-03-01', a: '2026-05-31' }],
  ['solo «da»', { sedi: SEDI, da: '2026-07-01' }],
  ['categoria di pagamento (le uscite non si filtrano)', { sedi: SEDI, categoria: CAT_PAG[0] }],
  ['due sedi, periodo e categoria', { sedi: [SEDI[0], SEDI[2]], da: '2026-02-01', a: '2026-08-15', categoria: CAT_PAG[2] }],
]

describe('report_cassa_aggregato · identico al riferimento, e i totali quadrano', () => {
  it('i dati del test sono quelli che contano: oltre 1000 incassi nelle sedi, storni, metodi non reali', () => {
    expect(INCASSI.filter((i) => SEDI.includes(i.sede)).length).toBeGreaterThan(1000)
    expect(INCASSI.filter((i) => i.storno_di).length).toBeGreaterThan(100)
    expect(INCASSI.some((i) => i.metodo === 'rettifica')).toBe(true)
  })

  for (const [nome, f] of CASI) {
    it(nome, async () => {
      const grezzo = await sql(f)
      const top = componiReport(grezzo, null)
      const perSede = f.sedi.map((s) => componiReport(grezzo, s))

      expect(normalizza(top)).toEqual(normalizza(riferimento(f, null)))
      for (const [i, s] of f.sedi.entries()) {
        expect(normalizza(perSede[i]), `sede ${s}`).toEqual(normalizza(riferimento(f, s)))
      }
      expect(differenzeTotali(grezzo, top, perSede)).toEqual([])
      expect(Number(grezzo.controllo.entrate)).not.toBe(0)
    })
  }

  it('il controllo conta TUTTE le righe: incassi e uscite delle sedi, nessun taglio', async () => {
    const g = await sql({ sedi: SEDI })
    expect(Number(g.controllo.incassi)).toBe(INCASSI.filter((i) => SEDI.includes(i.sede)).length)
    expect(Number(g.controllo.movimenti)).toBe(MOVIMENTI.filter((m) => m.tipo === 'uscita' && SEDI.includes(m.sede)).length)
  })

  it('scope vuoto: niente di niente (lo scope vuoto nega, non allarga)', async () => {
    const g = await sql({ sedi: [] })
    expect(g.entrate).toEqual([])
    expect(g.uscite).toEqual([])
    expect(g.mensile).toEqual([])
    expect(Number(g.controllo.incassi)).toBe(0)
  })

  it('differenzeTotali vede un gruppo che non torna (il controllo non è decorativo)', async () => {
    const g = await sql({ sedi: SEDI })
    const storto: ReportGrezzo = { ...g, controllo: { ...g.controllo, entrate: Number(g.controllo.entrate) + 0.01 } }
    const top = componiReport(storto, null)
    const voci = differenzeTotali(storto, top, SEDI.map((s) => componiReport(storto, s))).map((d) => d.voce)
    expect(voci).toEqual(['entrate:categorie', 'entrate:sedi', 'entrate:mensile'])
  })

  it('i permessi: EXECUTE solo alla service_role', async () => {
    const r = await db.query<{ ruolo: string; puo: boolean }>(`
      SELECT ruolo, has_function_privilege(ruolo, 'public.report_cassa_aggregato(uuid[], date, date, uuid)', 'EXECUTE') AS puo
        FROM unnest(ARRAY['anon','authenticated','service_role']) AS ruolo`)
    expect(Object.fromEntries(r.rows.map((x) => [x.ruolo, x.puo]))).toEqual({ anon: false, authenticated: false, service_role: true })
  })
})
