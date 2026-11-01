// @vitest-environment node

import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RigaDettaglioCassa } from '@/lib/cassa/dettaglio'
import { funzione, funzioneConPermessi, migrazione, senzaCommentiSql } from './sql-da-migrazioni'

// Dal 2026-10-31 le due funzioni hanno una definizione più recente (non contano i movimenti di cassa assorbiti da
// un incasso): si installa quella del file della migrazione del CRM sopra gli originali.
const MIGRAZIONE_CRM = migrazione('_crm_quota_e_settimane.sql')

const uuid = (prefisso: string, n: number) => `${prefisso}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const SEDI = [uuid('a0000000', 1), uuid('a0000000', 2)]
const FUORI = uuid('a0000000', 3)
const CAT_P = [uuid('b0000000', 1), uuid('b0000000', 2)]
const CAT_C = [uuid('c0000000', 1), uuid('c0000000', 2)]
const PAG = [uuid('d0000000', 1), uuid('d0000000', 2), uuid('d0000000', 3), uuid('d0000000', 4)]

interface Grezzo {
  righe: RigaDettaglioCassa[]
  conteggio: number
  totale: number
  contanti: number
  altri: number
}
interface Filtri {
  tipo?: 'entrata' | 'uscita'
  sedi?: string[] | null
  da?: string
  a?: string
  categoria?: string
  senza?: boolean
  metodo?: string
  limite?: number
  offset?: number
}

let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    -- Riproduce anche i GRANT espliciti Supabase: togliere il solo PUBLIC non basta.
    ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
    CREATE TYPE public.incasso_metodo AS ENUM
      ('contanti','bonifico','pos','assegno','altro','credito_famiglia','rettifica','storno');
    CREATE TABLE public.payment_categories (id uuid PRIMARY KEY, nome text);
    CREATE TABLE public.cassa_categorie (id uuid PRIMARY KEY, nome text);
    CREATE TABLE public.pagamenti (id uuid PRIMARY KEY, scuola_id uuid, categoria_id uuid, descrizione text);
    CREATE TABLE public.incassi (
      id uuid PRIMARY KEY, pagamento_id uuid, importo numeric(10,2), data_incasso date,
      metodo public.incasso_metodo, storno_di uuid, stornato_il timestamptz, note text
    );
    CREATE TABLE public.cassa_movimenti (
      id uuid PRIMARY KEY, scuola_id uuid, tipo text, importo numeric(10,2), metodo text, data date,
      categoria_id uuid, descrizione text, note text, allegato_path text, storno_di uuid, stornato_il timestamptz,
      incasso_id uuid
    );
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
  `)
  await db.exec(migrazione('_report_cassa_aggregato.sql'))
  await db.exec(migrazione('_report_cassa_dettaglio.sql'))
  await db.exec(funzioneConPermessi(MIGRAZIONE_CRM, 'report_cassa_aggregato'))
  await db.exec(funzioneConPermessi(MIGRAZIONE_CRM, 'report_cassa_dettaglio'))
  for (const id of CAT_P) await db.query('INSERT INTO public.payment_categories VALUES ($1, $2)', [id, 'Categoria omonima'])
  for (const id of CAT_C) await db.query('INSERT INTO public.cassa_categorie VALUES ($1, $2)', [id, 'Spesa omonima'])
  const pagamenti = [
    [PAG[0], SEDI[0], CAT_P[0], 'Quota attività'],
    [PAG[1], SEDI[1], CAT_P[1], 'Quota attività'],
    [PAG[2], SEDI[0], null, 'Quota senza categoria'],
    [PAG[3], FUORI, CAT_P[0], 'Altra sede'],
  ]
  for (const p of pagamenti) await db.query('INSERT INTO public.pagamenti VALUES ($1, $2, $3, $4)', p)
  // 1.205 incassi e 1.205 uscite reali: il conteggio supera il taglio PostgREST.
  await db.query(`
    INSERT INTO public.incassi
    SELECT ('e0000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
      CASE WHEN n % 3 = 0 THEN $3::uuid WHEN n % 2 = 0 THEN $2::uuid ELSE $1::uuid END,
      1.25, '2026-05-10', CASE WHEN n % 2 = 0 THEN 'bonifico'::public.incasso_metodo ELSE 'contanti'::public.incasso_metodo END,
      NULL, NULL, NULL
    FROM generate_series(1, 1205) n
  `, [PAG[0], PAG[1], PAG[2]])
  await db.query(`
    INSERT INTO public.cassa_movimenti
    SELECT ('f0000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
      CASE WHEN n % 2 = 0 THEN $2::uuid ELSE $1::uuid END,
      'uscita', 2.50, CASE WHEN n % 2 = 0 THEN 'carta' ELSE 'contanti' END, '2026-05-10',
      CASE WHEN n % 3 = 0 THEN NULL WHEN n % 2 = 0 THEN $4::uuid ELSE $3::uuid END,
      'Fornitura', NULL, NULL, NULL, NULL
    FROM generate_series(1, 1205) n
  `, [...SEDI, ...CAT_C])

  const speciali = [
    [uuid('e1000000', 1), PAG[0], 20, '2026-05-11', 'pos', null, '2026-05-12T10:00:00Z', 'Originale annullato'],
    [uuid('e1000000', 2), PAG[0], -20, '2026-05-12', 'storno', uuid('e1000000', 1), null, 'Storno nello stesso periodo'],
    [uuid('e1000000', 3), PAG[0], 40, '2026-04-30', 'contanti', null, '2026-05-12T10:00:00Z', null],
    [uuid('e1000000', 4), PAG[0], -40, '2026-05-12', 'storno', uuid('e1000000', 3), null, null],
    [uuid('e1000000', 5), PAG[0], 100, '2026-05-12', 'credito_famiglia', null, null, null],
    [uuid('e1000000', 6), PAG[0], 100, '2026-05-12', 'rettifica', null, null, null],
    [uuid('e1000000', 7), PAG[0], -100, '2026-05-13', 'storno', uuid('e1000000', 5), null, null],
    [uuid('e1000000', 8), PAG[0], 7, '2026-05-13', 'altro', null, null, null],
    [uuid('e1000000', 9), PAG[0], 9, '2026-05-13', 'assegno', null, null, null],
    [uuid('e1000000', 10), PAG[3], 900, '2026-05-13', 'contanti', null, null, null],
    // Non attribuire il metodo di un originale di un'altra categoria/sede.
    [uuid('e1000000', 11), PAG[1], -10, '2026-05-14', 'storno', uuid('e1000000', 1), null, null],
    [uuid('e1000000', 12), PAG[0], 5, '2026-05-14', 'storno', uuid('e1000000', 2), null, null],
  ]
  for (const i of speciali) await db.query('INSERT INTO public.incassi VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', i)
  await db.query(`INSERT INTO public.cassa_movimenti VALUES
    ($1,$2,'uscita',20,'contanti','2026-05-11',$3,'Acquisto','Nota fittizia','cassa/file.pdf',NULL,'2026-05-12T10:00:00Z'),
    ($4,$2,'uscita',-20,'contanti','2026-05-12',$3,'Annullamento',NULL,NULL,$1,NULL),
    ($5,$6,'uscita',900,'contanti','2026-05-13',$3,NULL,NULL,NULL,NULL,NULL),
    ($7,$2,'entrata',900,'contanti','2026-05-13',$3,NULL,NULL,NULL,NULL,NULL)
  `, [uuid('f1000000', 1), SEDI[0], CAT_C[0], uuid('f1000000', 2), uuid('f1000000', 3), FUORI, uuid('f1000000', 4)])
}, 30_000)

afterAll(async () => { await db?.close() })

async function sql(f: Filtri = {}): Promise<Grezzo> {
  const { rows } = await db.query<{ r: Grezzo }>(
    'SELECT public.report_cassa_dettaglio($1::uuid[],$2::text,$3::date,$4::date,$5::uuid,$6::boolean,$7::text,$8::integer,$9::integer) AS r',
    ['sedi' in f ? f.sedi : SEDI, f.tipo ?? 'entrata', f.da ?? null, f.a ?? null, f.categoria ?? null, f.senza ?? false, f.metodo ?? null, f.limite ?? 50, f.offset ?? 0],
  )
  return rows[0].r
}

describe('report_cassa_dettaglio · SQL reale, pagine e totale del filtro', () => {
  for (const tipo of ['entrata', 'uscita'] as const) {
    it(`${tipo}: oltre 1.205 righe, ordine stabile e somme complete anche fuori dall’ultima pagina`, async () => {
      const prima = await sql({ tipo, da: '2026-05-01', a: '2026-05-31', limite: 100 })
      const seconda = await sql({ tipo, da: '2026-05-01', a: '2026-05-31', limite: 100, offset: 100 })
      const oltre = await sql({ tipo, da: '2026-05-01', a: '2026-05-31', limite: 100, offset: 10_000 })
      expect(prima.conteggio).toBeGreaterThan(1205)
      expect(prima.righe).toHaveLength(100)
      expect(seconda.righe).toHaveLength(100)
      expect(oltre.righe).toEqual([])
      expect(oltre).toMatchObject({ conteggio: prima.conteggio, totale: prima.totale, contanti: prima.contanti, altri: prima.altri })
      expect(prima.totale).toBeCloseTo(prima.contanti + prima.altri, 2)
      expect(new Set([...prima.righe, ...seconda.righe].map((r) => r.id)).size).toBe(200)
      const righe: RigaDettaglioCassa[] = []
      for (let offset = 0; offset < prima.conteggio; offset += 100) {
        righe.push(...(await sql({ tipo, da: '2026-05-01', a: '2026-05-31', limite: 100, offset })).righe)
      }
      expect(righe).toHaveLength(prima.conteggio)
      expect(righe.reduce((somma, r) => somma + r.importo, 0)).toBeCloseTo(prima.totale, 2)
      expect(righe.map((r) => `${r.data}:${r.id}`)).toEqual(righe.map((r) => `${r.data}:${r.id}`).sort().reverse())
    })
  }

  it('entrate: coincide esattamente con l’aggregato sullo stesso periodo/categoria/sedi', async () => {
    for (const f of [{}, { da: '2026-05-01', a: '2026-05-31' }, { sedi: [SEDI[0]], categoria: CAT_P[0] }, { sedi: [SEDI[1]], da: '2026-05-01' }]) {
      const dettaglio = await sql(f)
      const { rows } = await db.query<{ r: { controllo: { entrate: number } } }>(
        'SELECT public.report_cassa_aggregato($1::uuid[],$2::date,$3::date,$4::uuid) AS r',
        ['sedi' in f ? f.sedi : SEDI, 'da' in f ? f.da : null, 'a' in f ? f.a : null, 'categoria' in f ? f.categoria : null],
      )
      expect(dettaglio.totale).toBe(rows[0].r.controllo.entrate)
    }
  })

  it('storno incluso col metodo dell’originale e filtro metodo successivo all’attribuzione', async () => {
    const r = await sql({ metodo: 'pos', da: '2026-05-01', a: '2026-05-31', categoria: CAT_P[0] })
    expect(r).toMatchObject({ conteggio: 2, totale: 0, contanti: 0, altri: 0 })
    expect(r.righe.map((i) => [i.id, i.metodo, i.importo])).toEqual([
      [uuid('e1000000', 2), 'pos', -20], [uuid('e1000000', 1), 'pos', 20],
    ])
    expect(r.righe[0]).toMatchObject({ origine: 'incasso', categoria_nome: 'Categoria omonima', descrizione: 'Quota attività', allegato_path: null, pagamento_id: PAG[0], note: 'Storno nello stesso periodo' })
    expect(r.righe[1].stornato_il).not.toBeNull()
  })

  it('esclude storni di originali fuori periodo/categoria/sedi e i metodi fittizi', async () => {
    const r = await sql({ da: '2026-05-12', a: '2026-05-14', categoria: CAT_P[0], sedi: [SEDI[0]] })
    expect(r.righe.map((i) => i.id)).toEqual([uuid('e1000000', 9), uuid('e1000000', 8)])
    expect(r).toMatchObject({ conteggio: 2, totale: 16 })
    const categoriaDiversa = await sql({ categoria: CAT_P[1], da: '2026-05-01' })
    expect(categoriaDiversa.righe.every((i) => i.id !== uuid('e1000000', 11))).toBe(true)
  })

  it('nullable category: senza categoria significa solo NULL, omonime restano distinte per id', async () => {
    for (const tipo of ['entrata', 'uscita'] as const) {
      const senza = await sql({ tipo, senza: true, limite: 100 })
      expect(senza.conteggio).toBe(401)
      expect(senza.righe.every((r) => r.categoria_id === null && r.categoria_nome === null)).toBe(true)
      const categorie = tipo === 'entrata' ? CAT_P : CAT_C
      for (const categoria of categorie) {
        const r = await sql({ tipo, categoria, limite: 100 })
        expect(r.conteggio).toBeGreaterThan(0)
        expect(r.righe.every((i) => i.categoria_id === categoria)).toBe(true)
      }
    }
  })

  it('uscite: include il contro-movimento negativo, allegato e categoria cassa, pagamento nullo', async () => {
    const r = await sql({ tipo: 'uscita', da: '2026-05-11', a: '2026-05-12' })
    expect(r).toMatchObject({ conteggio: 2, totale: 0, contanti: 0, altri: 0 })
    expect(r.righe[0]).toMatchObject({ id: uuid('f1000000', 2), origine: 'cassa', importo: -20, storno_di: uuid('f1000000', 1), categoria_nome: 'Spesa omonima', pagamento_id: null })
    expect(r.righe[1]).toMatchObject({ allegato_path: 'cassa/file.pdf', note: 'Nota fittizia', pagamento_id: null })
    expect(await sql({ tipo: 'uscita', metodo: 'carta' })).toMatchObject({ conteggio: 602, totale: 1505, contanti: 0, altri: 1505 })
  })

  it('un movimento di cassa assorbito da un incasso non compare nel dettaglio e non entra nel totale', async () => {
    const filtri = { tipo: 'uscita', da: '2026-05-11', a: '2026-05-12' } as const
    const prima = await sql(filtri)
    expect(prima.conteggio).toBe(2)
    await db.exec('BEGIN')
    try {
      await db.query('UPDATE public.cassa_movimenti SET incasso_id = $2 WHERE id = $1', [uuid('f1000000', 1), uuid('e1000000', 1)])
      const dopo = await sql(filtri)
      expect(dopo.conteggio).toBe(1)
      expect(dopo.righe.map((r) => r.id)).toEqual([uuid('f1000000', 2)])
      expect(dopo.totale).toBeCloseTo(prima.totale - 20, 2)
    } finally {
      await db.exec('ROLLBACK')
    }
    expect((await sql(filtri)).conteggio).toBe(2)
  })

  it('le definizioni installate vengono dal file del CRM e leggono i movimenti con `m.incasso_id IS NULL`', () => {
    for (const nome of ['report_cassa_aggregato', 'report_cassa_dettaglio']) {
      const corpo = senzaCommentiSql(funzione(MIGRAZIONE_CRM, nome))
      expect(corpo, nome).toMatch(/from\s+public\.cassa_movimenti\s+m\b/i)
      expect(corpo, nome).toMatch(/\bm\.incasso_id\s+is\s+null/i)
    }
  })

  it('tutti i campi restano presenti e nullable, e il limite non supera cento', async () => {
    const chiavi = ['id', 'origine', 'scuola_id', 'scuola_nome', 'data', 'categoria_id', 'categoria_nome', 'metodo', 'importo', 'descrizione', 'note', 'allegato_path', 'storno_di', 'stornato_il', 'pagamento_id'].sort()
    for (const tipo of ['entrata', 'uscita'] as const) {
      const r = await sql({ tipo, limite: 1000 })
      expect(r.righe).toHaveLength(100)
      for (const i of r.righe) expect(Object.keys(i).sort()).toEqual(chiavi)
    }
  })

  for (const tipo of ['entrata', 'uscita'] as const) {
    for (const sedi of [[], null]) {
      it(`${tipo}: scope ${sedi === null ? 'null' : 'vuoto'} nega e non allarga`, async () => {
        expect(await sql({ tipo, sedi })).toEqual({ righe: [], conteggio: 0, totale: 0, contanti: 0, altri: 0 })
      })
    }
  }

  it('solo service_role può eseguire la RPC anche con i default grant di Supabase', async () => {
    const signature = 'public.report_cassa_dettaglio(uuid[],text,date,date,uuid,boolean,text,integer,integer)'
    for (const ruolo of ['anon', 'authenticated', 'service_role']) {
      const { rows } = await db.query<{ permesso: boolean }>('SELECT has_function_privilege($1, $2, \'EXECUTE\') AS permesso', [ruolo, signature])
      expect(rows[0].permesso).toBe(ruolo === 'service_role')
    }
    await db.exec('SET ROLE service_role')
    try { expect((await sql()).conteggio).toBeGreaterThan(1205) } finally { await db.exec('RESET ROLE') }
    const { rows } = await db.query<{ sicurezza: boolean; config: string[] }>(
      'SELECT prosecdef AS sicurezza, proconfig AS config FROM pg_proc WHERE oid = $1::regprocedure', [signature],
    )
    expect(rows[0].sicurezza).toBe(false)
    expect(rows[0].config).toContain('search_path=public, pg_temp')
  })
})
