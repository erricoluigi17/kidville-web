// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { funzione, funzioneConPermessi, migrazione, senzaCommentiSql } from './sql-da-migrazioni'

// Solo dati sintetici. Eseguiamo l'intera migrazione su Postgres, inclusi FK,
// trigger e permessi: nessun mock delle query o copia della funzione SQL.
const directory = join(process.cwd(), 'supabase/migrations')
const migrationFile = readdirSync(directory).find((file) => file.endsWith('_cassa_provenienza_conteggio.sql'))
const migration = migrationFile ? readFileSync(join(directory, migrationFile), 'utf8') : ''
// Dal 2026-10-31 il conteggio ha una definizione più recente (non conta i movimenti di cassa assorbiti da un
// incasso): si installa quella del file della migrazione del CRM sopra l'originale, che porta anche i trigger.
const MIGRAZIONE_CRM = migrazione('_crm_quota_e_settimane.sql')
const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const SEDI = [uuid('a0000000', 1), uuid('a0000000', 2)]
const FUORI = uuid('a0000000', 3)
const GLOBALE = uuid('b0000000', 1)
const LOCALE = uuid('b0000000', 2)
const INATTIVA = uuid('b0000000', 3)
const ALTRA_SEDE = uuid('b0000000', 4)
const STORICO = uuid('e0000000', 1)

interface Totali { entrate: number; uscite: number; prelievi: number; rettifiche: number; netto: number }
interface Riga extends Totali { scuola_id: string; cassa_categoria_id: string | null; cassa_nome: string | null }
interface Conteggio { righe: Riga[]; totali: Totali }
interface Incasso { id: string; pagamento: string; scuola: string; categoria: string | null; data: string; metodo: string; importo: number; storno: string | null }
interface Movimento { id: string; scuola: string; categoria: string | null; tipo: string; metodo: string; importo: number; data: string; storno: string | null }

const incassi: Incasso[] = Array.from({ length: 1301 }, (_, n) => ({
  id: uuid('d0000000', n + 1), pagamento: uuid('c0000000', n % 3 + 1),
  scuola: n % 3 === 2 ? FUORI : SEDI[n % 3], categoria: n % 3 === 0 ? GLOBALE : n % 3 === 1 ? null : ALTRA_SEDE,
  data: n % 2 ? '2026-10-01' : '2026-10-31', metodo: ['contanti', 'bonifico', 'pos', 'altro', 'credito_famiglia', 'rettifica'][n % 6],
  importo: (n % 27 + 1) / 10, storno: null,
}))
// Più di 1000 incassi CONTANTI nello scope, non soltanto righe escluse dal filtro.
for (let n = 1; n <= 1100; n++) incassi.push({ id: uuid('d1000000', n), pagamento: uuid('c0000000', 1), scuola: SEDI[0], categoria: GLOBALE, data: '2026-10-10', metodo: 'contanti', importo: 1.23, storno: null })
const originaleFuoriPeriodo: Incasso = { id: uuid('d2000000', 1), pagamento: uuid('c0000000', 4), scuola: SEDI[0], categoria: LOCALE, data: '2026-09-01', metodo: 'contanti', importo: 75, storno: null }
incassi.push(originaleFuoriPeriodo)
// Il pagamento dello storno ha categoria differente: prevale l'originale.
incassi.push({ ...originaleFuoriPeriodo, id: uuid('d2000000', 2), pagamento: uuid('c0000000', 1), categoria: GLOBALE, data: '2026-10-01', metodo: 'storno', importo: -75, storno: originaleFuoriPeriodo.id })
for (const [n, metodo] of ['altro', 'credito_famiglia', 'rettifica', 'pos'].entries()) {
  const original: Incasso = { ...originaleFuoriPeriodo, id: uuid('d3000000', n * 2 + 1), metodo, importo: 500 }
  incassi.push(original, { ...original, id: uuid('d3000000', n * 2 + 2), data: '2026-10-15', metodo: 'storno', importo: -500, storno: original.id })
}
// Metodo degradato dello storno: la sua etichetta non deve decidere il cash.
incassi.push({ ...originaleFuoriPeriodo, id: uuid('d2000000', 3), data: '2026-10-31', metodo: 'altro', importo: -5, storno: originaleFuoriPeriodo.id })
// Uno storno malformato verso una sede esterna non deve contaminare lo scope.
const originalOtherSchool = incassi.find((i) => i.scuola === FUORI && i.metodo === 'contanti') ?? { ...originaleFuoriPeriodo, id: uuid('d2000000', 4), pagamento: uuid('c0000000', 3), scuola: FUORI, categoria: ALTRA_SEDE }
if (!incassi.includes(originalOtherSchool)) incassi.push(originalOtherSchool)
incassi.push({ ...originaleFuoriPeriodo, id: uuid('d2000000', 5), metodo: 'storno', importo: -999, data: '2026-10-15', storno: originalOtherSchool.id })
incassi.push({ ...originaleFuoriPeriodo, id: uuid('d2000000', 6), metodo: 'storno', importo: 75, data: '2026-10-15', storno: uuid('d2000000', 2) })

const movimenti: Movimento[] = [{ id: STORICO, scuola: SEDI[0], categoria: null, tipo: 'uscita', metodo: 'contanti', importo: 12, data: '2026-10-01', storno: null }]
for (let n = 1; n <= 1250; n++) movimenti.push({
  id: uuid('e1000000', n), scuola: n % 3 === 2 ? FUORI : SEDI[n % 3], categoria: n % 3 === 0 ? GLOBALE : n % 3 === 1 ? null : ALTRA_SEDE,
  tipo: ['entrata', 'uscita', 'prelievo', 'rettifica'][n % 4], metodo: n % 5 ? 'contanti' : 'altro',
  importo: n % 4 === 3 ? -0.25 : (n % 20 + 1) / 10, data: n % 2 ? '2026-10-01' : '2026-10-31', storno: null,
})
movimenti.push({ id: uuid('e2000000', 1), scuola: SEDI[0], categoria: LOCALE, tipo: 'uscita', metodo: 'contanti', importo: 40, data: '2026-09-01', storno: null })
movimenti.push({ id: uuid('e2000000', 2), scuola: SEDI[0], categoria: LOCALE, tipo: 'uscita', metodo: 'contanti', importo: -40, data: '2026-10-01', storno: uuid('e2000000', 1) })
// Rettifica/prelievo da chiusura: non hanno provenienza assegnata.
movimenti.push({ id: uuid('e3000000', 1), scuola: SEDI[1], categoria: null, tipo: 'prelievo', metodo: 'contanti', importo: 200, data: '2026-10-15', storno: null })
movimenti.push({ id: uuid('e3000000', 2), scuola: SEDI[1], categoria: null, tipo: 'rettifica', metodo: 'contanti', importo: 3.5, data: '2026-10-15', storno: null })

let db: PGlite
beforeAll(async () => {
  expect(migrationFile, 'La migrazione deve esistere').toBeDefined()
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE TYPE public.incasso_metodo AS ENUM ('contanti','bonifico','pos','assegno','altro','credito_famiglia','storno','rettifica');
    CREATE TABLE public.payment_categories (id uuid PRIMARY KEY, scuola_id uuid, nome text NOT NULL, attivo boolean NOT NULL DEFAULT true);
    CREATE TABLE public.pagamenti (id uuid PRIMARY KEY, scuola_id uuid, categoria_id uuid REFERENCES public.payment_categories(id));
    CREATE TABLE public.incassi (id uuid PRIMARY KEY, pagamento_id uuid NOT NULL REFERENCES public.pagamenti(id), importo numeric(10,2), data_incasso date, metodo public.incasso_metodo, storno_di uuid REFERENCES public.incassi(id));
    CREATE TABLE public.cassa_movimenti (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scuola_id uuid NOT NULL, tipo text NOT NULL,
      importo numeric(10,2), metodo text DEFAULT 'contanti', data date DEFAULT CURRENT_DATE, storno_di uuid REFERENCES public.cassa_movimenti(id),
      stornato_il timestamptz, storno_motivo text, chiusura_id uuid, incasso_id uuid);
  `)
  await db.query('INSERT INTO public.cassa_movimenti(id, scuola_id, tipo, importo, data) VALUES ($1,$2,\'uscita\',12,\'2026-10-01\')', [STORICO, SEDI[0]])
  await db.exec(migration)
  await db.exec(funzioneConPermessi(MIGRAZIONE_CRM, 'conteggio_cassa_provenienza'))
  await db.query(`INSERT INTO public.payment_categories VALUES ($1,NULL,'Globale',true),($2,$3,'Locale',true),($4,$3,'Inattiva',false),($5,$6,'Altra sede',true)`, [GLOBALE, LOCALE, SEDI[0], INATTIVA, ALTRA_SEDE, FUORI])
  await db.query('INSERT INTO public.pagamenti VALUES ($1,$2,$3),($4,$5,NULL),($6,$7,$8),($9,$2,$10)', [uuid('c0000000', 1), SEDI[0], GLOBALE, uuid('c0000000', 2), SEDI[1], uuid('c0000000', 3), FUORI, ALTRA_SEDE, uuid('c0000000', 4), LOCALE])
  await db.query(`INSERT INTO public.incassi SELECT (r->>'id')::uuid,(r->>'pagamento')::uuid,(r->>'importo')::numeric,(r->>'data')::date,(r->>'metodo')::public.incasso_metodo,(r->>'storno')::uuid FROM jsonb_array_elements($1::jsonb) r`, [JSON.stringify(incassi)])
  await db.query(`INSERT INTO public.cassa_movimenti(id,scuola_id,cassa_categoria_id,tipo,metodo,importo,data,storno_di)
    SELECT (r->>'id')::uuid,(r->>'scuola')::uuid,(r->>'categoria')::uuid,r->>'tipo',r->>'metodo',(r->>'importo')::numeric,(r->>'data')::date,(r->>'storno')::uuid
    FROM jsonb_array_elements($1::jsonb) r`, [JSON.stringify(movimenti.filter((m) => m.id !== STORICO))])
})
afterAll(async () => { await db?.close() })

const empty = (): Totali => ({ entrate: 0, uscite: 0, prelievi: 0, rettifiche: 0, netto: 0 })
const round = (n: number) => Math.round(n * 100) / 100
function riferimento(sedi: string[], da?: string, a?: string): Conteggio {
  const rows = new Map<string, Riga>()
  const inPeriod = (data: string) => (!da || data >= da) && (!a || data <= a)
  const add = (sede: string, categoria: string | null, voce: keyof Totali, importo: number) => {
    const key = `${sede}:${categoria}`
    const row = rows.get(key) ?? { scuola_id: sede, cassa_categoria_id: categoria, cassa_nome: categoria === GLOBALE ? 'Globale' : categoria === LOCALE ? 'Locale' : categoria === ALTRA_SEDE ? 'Altra sede' : null, ...empty() }
    row[voce] = round(row[voce] + importo)
    rows.set(key, row)
  }
  const originalById = new Map(incassi.map((i) => [i.id, i]))
  for (const i of incassi) {
    if (!sedi.includes(i.scuola) || !inPeriod(i.data)) continue
    const origin = i.storno ? originalById.get(i.storno) : i
    if (!origin || origin.storno || origin.scuola !== i.scuola || origin.metodo !== 'contanti') continue
    add(i.scuola, origin.categoria, 'entrate', i.importo)
  }
  for (const m of movimenti) {
    if (!sedi.includes(m.scuola) || !inPeriod(m.data) || m.metodo !== 'contanti') continue
    add(m.scuola, m.categoria, ({ entrata: 'entrate', uscita: 'uscite', prelievo: 'prelievi', rettifica: 'rettifiche' } as const)[m.tipo as 'entrata'], m.importo)
  }
  const totali = empty()
  for (const row of rows.values()) {
    row.netto = round(row.entrate - row.uscite - row.prelievi + row.rettifiche)
    for (const k of Object.keys(totali) as (keyof Totali)[]) totali[k] = round(totali[k] + row[k])
  }
  return { righe: [...rows.values()].sort((x, y) => `${x.scuola_id}:${x.cassa_categoria_id ?? ''}`.localeCompare(`${y.scuola_id}:${y.cassa_categoria_id ?? ''}`)), totali }
}
async function conteggio(sedi: string[] | null, da?: string, a?: string): Promise<Conteggio> {
  const result = await db.query<{ r: Conteggio }>('SELECT public.conteggio_cassa_provenienza($1::uuid[],$2::date,$3::date) AS r', [sedi, da ?? null, a ?? null])
  expect(result.rows).toHaveLength(1)
  return result.rows[0].r
}
async function temporaneo(run: () => Promise<void>) {
  await db.exec('BEGIN')
  try { await run() } finally { await db.exec('ROLLBACK') }
}
async function movimento(categoria: string | null, scuola = SEDI[0], extra?: { storno?: string; tipo?: string }) {
  return db.query<{ id: string; scuola_id: string; cassa_categoria_id: string | null }>(`INSERT INTO public.cassa_movimenti(scuola_id,tipo,importo,cassa_categoria_id,storno_di)
    VALUES ($1,$2,1,$3,$4) RETURNING id,scuola_id,cassa_categoria_id`, [scuola, extra?.tipo ?? 'uscita', categoria, extra?.storno ?? null])
}

describe('conteggio cassa per provenienza · contanti e scope reali in SQL', () => {
  it('fixture oltre 1000 incassi cash e 1000 movimenti: nessun taglio PostgREST', async () => {
    expect(incassi.filter((i) => SEDI.includes(i.scuola) && i.metodo === 'contanti').length).toBeGreaterThan(1000)
    expect(movimenti.length).toBeGreaterThan(1000)
    expect(await conteggio([...SEDI, FUORI])).toEqual(riferimento([...SEDI, FUORI]))
  })
  for (const [nome, sedi, da, a] of [
    ['periodo inclusivo, storni originali fuori periodo', SEDI, '2026-10-01', '2026-10-31'],
    ['una sede e un solo giorno', [SEDI[0]], '2026-10-01', '2026-10-01'],
    ['solo inizio', SEDI, '2026-10-15', undefined],
    ['solo fine', SEDI, undefined, '2026-10-01'],
  ] as const) it(nome, async () => { expect(await conteggio([...sedi], da, a)).toEqual(riferimento([...sedi], da, a)) })

  it('storno nel periodo sottrae dalla cassa originale anche se il pagamento dello storno ha altra categoria', async () => {
    const result = await conteggio([SEDI[0]], '2026-10-01', '2026-10-31')
    expect(result.righe.find((r) => r.cassa_categoria_id === LOCALE)).toMatchObject({ entrate: -80, uscite: -40, netto: -40 })
  })
  it('scope vuoto/NULL e intervallo invertito negano senza allargare', async () => {
    const expected = { righe: [], totali: empty() }
    expect(await conteggio([])).toEqual(expected)
    expect(await conteggio(null)).toEqual(expected)
    expect(await conteggio(SEDI, '2026-11-01', '2026-10-01')).toEqual(expected)
  })
  it('storico resta generale e le categorie senza movimenti hanno comunque gli incassi cash', async () => {
    const old = await db.query<{ cassa_categoria_id: string | null }>('SELECT cassa_categoria_id FROM public.cassa_movimenti WHERE id=$1', [STORICO])
    expect(old.rows[0].cassa_categoria_id).toBeNull()
    expect((await conteggio([SEDI[0]], '2026-09-01', '2026-09-01')).righe).toEqual([expect.objectContaining({ cassa_categoria_id: LOCALE, cassa_nome: 'Locale', entrate: 75 })])
    // Il 10 ottobre non esiste alcun movimento manuale: resta la sola entrata
    // automatica, attribuita alla sua categoria di pagamento.
    expect((await conteggio([SEDI[0]], '2026-10-10', '2026-10-10')).righe).toEqual([
      { scuola_id: SEDI[0], cassa_categoria_id: GLOBALE, cassa_nome: 'Globale', entrate: 1353, uscite: 0, prelievi: 0, rettifiche: 0, netto: 1353 },
    ])
  })
  it('totali quadrano per sede e provenienza e non includono fondi iniziali', async () => {
    const result = await conteggio(SEDI, '2026-10-01', '2026-10-31')
    expect(result.righe.some((r) => r.cassa_categoria_id === null && r.cassa_nome === null)).toBe(true)
    for (const key of Object.keys(result.totali) as (keyof Totali)[]) expect(round(result.righe.reduce((s, r) => s + r[key], 0))).toBe(result.totali[key])
    expect(result.totali.netto).toBe(round(result.totali.entrate - result.totali.uscite - result.totali.prelievi + result.totali.rettifiche))
  })
  it('un movimento assorbito da un incasso non si conta: l’entrata del CRM e il suo incasso sono lo stesso denaro', async () => temporaneo(async () => {
    const giorno = '2026-10-20' // nessun dato della fixture cade in questo giorno
    expect((await conteggio([SEDI[0]], giorno, giorno)).totali).toEqual(empty())
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO public.cassa_movimenti(scuola_id,tipo,importo,metodo,data,cassa_categoria_id) VALUES ($1,'entrata',33.3,'contanti',$2,$3) RETURNING id`,
      [SEDI[0], giorno, GLOBALE],
    )
    // L'entrata di cassa da sola: il giorno vale 33,30.
    expect((await conteggio([SEDI[0]], giorno, giorno)).totali).toMatchObject({ entrate: 33.3, netto: 33.3 })
    // Poi nasce l'incasso in contanti (lo stesso denaro) e l'entrata si aggancia: il giorno vale 33,30 UNA volta,
    // non due — l'entrata sparisce dal conto e resta l'incasso.
    await db.query(`INSERT INTO public.incassi VALUES ($1,$2,33.3,$3,'contanti',NULL)`, [uuid('d9000000', 1), uuid('c0000000', 1), giorno])
    await db.query('UPDATE public.cassa_movimenti SET incasso_id = $2 WHERE id = $1', [rows[0].id, uuid('d9000000', 1)])
    const dopo = await conteggio([SEDI[0]], giorno, giorno)
    expect(dopo.totali).toMatchObject({ entrate: 33.3, netto: 33.3 })
    expect(dopo.righe).toEqual([expect.objectContaining({ cassa_categoria_id: GLOBALE, entrate: 33.3 })])
  }))
  it('la definizione installata viene dal file del CRM e legge i movimenti con `m.incasso_id IS NULL`', () => {
    const corpo = senzaCommentiSql(funzione(MIGRAZIONE_CRM, 'conteggio_cassa_provenienza'))
    expect(corpo).toMatch(/from\s+public\.cassa_movimenti\s+m\b/i)
    expect(corpo).toMatch(/\bm\.incasso_id\s+is\s+null/i)
  })
  it('STABLE e invoker: EXECUTE concesso solo a service_role', async () => {
    const permissions = await db.query<{ ruolo: string; puo: boolean }>(`SELECT ruolo,has_function_privilege(ruolo,'public.conteggio_cassa_provenienza(uuid[],date,date)','EXECUTE') AS puo FROM unnest(ARRAY['anon','authenticated','service_role']) ruolo`)
    expect(Object.fromEntries(permissions.rows.map((r) => [r.ruolo, r.puo]))).toEqual({ anon: false, authenticated: false, service_role: true })
    const metadata = await db.query<{ provolatile: string; prosecdef: boolean }>(`SELECT provolatile,prosecdef FROM pg_proc WHERE oid='public.conteggio_cassa_provenienza(uuid[],date,date)'::regprocedure`)
    expect(metadata.rows[0]).toEqual({ provolatile: 's', prosecdef: false })
  })
  for (const ruolo of ['anon', 'authenticated']) it(`${ruolo} non può eseguire la RPC neppure con scope noto`, async () => temporaneo(async () => {
    await db.exec(`SET LOCAL ROLE ${ruolo}`)
    await expect(conteggio(SEDI)).rejects.toMatchObject({ code: '42501' })
  }))
})

describe('provenienza movimenti · vincoli di sede, attività e storno', () => {
  it('consente generale, categoria globale e categoria attiva della sede', async () => temporaneo(async () => {
    for (const categoria of [null, GLOBALE, LOCALE]) expect((await movimento(categoria)).rows[0].cassa_categoria_id).toBe(categoria)
  }))
  for (const [nome, categoria] of [['altra sede', ALTRA_SEDE], ['inattiva', INATTIVA], ['inesistente', uuid('b0000000', 999)]] as const) {
    it(`nega INSERT categoria ${nome}`, async () => { await expect(movimento(categoria)).rejects.toMatchObject({ code: '23514' }) })
    it(`nega UPDATE categoria ${nome}`, async () => { await expect(db.query('UPDATE public.cassa_movimenti SET cassa_categoria_id=$1 WHERE id=$2', [categoria, STORICO])).rejects.toMatchObject({ code: '23514' }) })
  }
  it('nega cambio sede movimento quando la fonte è locale', async () => temporaneo(async () => {
    const row = (await movimento(LOCALE)).rows[0]
    await expect(db.query('UPDATE public.cassa_movimenti SET scuola_id=$1 WHERE id=$2', [SEDI[1], row.id])).rejects.toMatchObject({ code: '23514' })
  }))
  it('attività sconosciuta in uno schema legacy non autorizza nuove attribuzioni', async () => temporaneo(async () => {
    await db.exec('ALTER TABLE public.payment_categories ALTER COLUMN attivo DROP NOT NULL')
    await db.query('UPDATE public.payment_categories SET attivo=NULL WHERE id=$1', [LOCALE])
    await expect(movimento(LOCALE)).rejects.toMatchObject({ code: '23514' })
  }))
  it('storno eredita sede/fonte, anche dopo disattivazione; marcatura originale continua a funzionare', async () => temporaneo(async () => {
    const original = (await movimento(LOCALE)).rows[0]
    await db.query('UPDATE public.payment_categories SET attivo=false WHERE id=$1', [LOCALE])
    const storno = (await movimento(ALTRA_SEDE, SEDI[1], { storno: original.id })).rows[0]
    expect(storno).toMatchObject({ scuola_id: SEDI[0], cassa_categoria_id: LOCALE })
    await db.query(`UPDATE public.cassa_movimenti SET stornato_il=now(),storno_motivo='Motivo sintetico' WHERE id=$1`, [original.id])
    await db.query('UPDATE public.cassa_movimenti SET cassa_categoria_id=cassa_categoria_id WHERE id=$1', [original.id])
    expect((await conteggio([SEDI[0]])).righe.find((r) => r.cassa_categoria_id === LOCALE)?.cassa_nome).toBe('Locale')
  }))
  it('storno di storico rimane generale; riferimento inesistente viene rifiutato', async () => temporaneo(async () => {
    expect((await movimento(GLOBALE, SEDI[1], { storno: STORICO })).rows[0]).toMatchObject({ scuola_id: SEDI[0], cassa_categoria_id: null })
    await expect(movimento(null, SEDI[0], { storno: uuid('e0000000', 999) })).rejects.toMatchObject({ code: '23503' })
  }))
  it('non consente di spostare la categoria usata su una sede incompatibile', async () => {
    await expect(db.query('UPDATE public.payment_categories SET scuola_id=$1 WHERE id=$2', [SEDI[1], GLOBALE])).rejects.toMatchObject({ code: '23514' })
  })
  it('consente di rendere globale una categoria locale e restringere una globale compatibile', async () => temporaneo(async () => {
    await db.query('UPDATE public.payment_categories SET scuola_id=NULL WHERE id=$1', [LOCALE])
    await db.query('UPDATE public.payment_categories SET scuola_id=$1 WHERE id=$2', [SEDI[0], LOCALE])
  }))
  it('DELETE RESTRICT protegge la fonte anche quando nessun pagamento usa la categoria', async () => temporaneo(async () => {
    const soloCassa = uuid('b0000000', 500)
    await db.query("INSERT INTO public.payment_categories VALUES ($1,NULL,'Solo cassa',true)", [soloCassa])
    await movimento(soloCassa)
    await expect(db.query('DELETE FROM public.payment_categories WHERE id=$1', [soloCassa])).rejects.toMatchObject({ code: expect.stringMatching(/23503|23001/) })
  }))
  it('la provenienza originale non può cambiare lasciando lo storno in un’altra cassa', async () => temporaneo(async () => {
    const original = (await movimento(LOCALE)).rows[0]
    const storno = (await movimento(null, SEDI[0], { storno: original.id })).rows[0]
    expect(storno.cassa_categoria_id).toBe(LOCALE)
    await expect(db.query('UPDATE public.cassa_movimenti SET cassa_categoria_id=$1 WHERE id=$2', [GLOBALE, original.id])).rejects.toMatchObject({ code: '23514' })
  }))
})
