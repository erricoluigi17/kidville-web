// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { TABELLE_REGISTRO_PRIMARIA } from '@/lib/alunni/registro-primaria'

/**
 * ELIMINAZIONE DEFINITIVA DI UN ALUNNO · LA MIGRAZIONE PROVATA SU UN POSTGRES VERO.
 *
 * Ciò che la migrazione consegna sono regole che solo il database può far
 * rispettare: l'ordine delle cancellazioni contro le FK senza CASCADE, il
 * «tutto o niente» di una transazione, i permessi sulla funzione. Un finto
 * client direbbe «sì» a tutto.
 *
 * Lo schema qui sotto è un MINIMO: colonne e FK riprendono la produzione
 * (lette in sola lettura il 2026-10-08 da `pg_constraint`), il resto è tolto.
 * Il file della migrazione è LETTO DAL DISCO e applicato DUE volte.
 *
 * Solo dati finti: uuid inventati, nessuna anagrafica.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).find((f) => f.endsWith('_alunni_elimina_definitivo.sql'))
if (!FILE) throw new Error('migrazione *_alunni_elimina_definitivo.sql non trovata')
const MIGRAZIONE = readFileSync(join(CARTELLA, FILE), 'utf8')

const SEDE = 'a0000000-0000-4000-8000-000000000001'
const SEZ = 'c0000000-0000-4000-8000-000000000001'
const ADULTO = '10000000-0000-4000-8000-000000000001' // ritirato, legato al genitore che è lui stesso
const DOPPIONE = '10000000-0000-4000-8000-000000000002' // ritirato, una presenza
const ISCRITTO = '10000000-0000-4000-8000-000000000003' // frequenta: intoccabile
const SENZA_SEZ = '10000000-0000-4000-8000-000000000004' // iscritto ma senza sezione
const FRATELLO = '10000000-0000-4000-8000-000000000005'
const GENITORE = '20000000-0000-4000-8000-000000000001'

let db: PGlite

type PgErr = { code?: string; message: string }

async function elimina(alunno: string, conPagamenti = false): Promise<{ ok: boolean; code: string; righe?: Record<string, number> }> {
  const { rows } = await db.query<{ r: { ok: boolean; code: string; righe?: Record<string, number> } }>(
    `SELECT public.elimina_alunno_definitivo('${alunno}', ${conPagamenti}) AS r`,
  )
  return rows[0].r
}

async function numero(sql: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT (${sql})::int AS n`)
  return rows[0].n
}

async function schemaMinimo(conn: PGlite) {
  await conn.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

    CREATE FUNCTION public.stati_alunno_non_piu_iscritto() RETURNS text[]
      LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['ritirato']::text[] $$;

    CREATE TABLE public.alunni (
      id uuid PRIMARY KEY,
      scuola_id uuid,
      stato varchar,
      section_id uuid,
      classe_sezione varchar,
      anonimizzato_il timestamptz,
      retta_a_carico_di uuid REFERENCES public.alunni(id) ON DELETE SET NULL
    );
    CREATE TABLE public.parents (id uuid PRIMARY KEY);
    CREATE TABLE public.student_parents (
      student_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE,
      parent_id uuid REFERENCES public.parents(id)
    );
    CREATE TABLE public.legame_genitori_alunni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid REFERENCES public.alunni(id),
      parent_id uuid
    );
    CREATE TABLE public.presenze (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE);
    CREATE TABLE public.eventi_diario (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id));
    CREATE TABLE public.armadietto (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id));
    CREATE TABLE public.ticket_mensa (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id));
    CREATE TABLE public.forms_submissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid);
    CREATE TABLE public.galleria_media (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tag_alunni uuid[]);

    CREATE TABLE public.valutazioni (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id));
    CREATE TABLE public.pagelle (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE);
    CREATE TABLE public.scrutinio_giudizi (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE);
    CREATE TABLE public.scrutinio_comportamento (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE);
    CREATE TABLE public.note_disciplinari (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id));
    CREATE TABLE public.certificati_competenze (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE);

    CREATE TABLE public.pagamenti (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid REFERENCES public.alunni(id),
      parent_payment_id uuid REFERENCES public.pagamenti(id) ON DELETE CASCADE
    );
    CREATE TABLE public.incassi (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid REFERENCES public.pagamenti(id) ON DELETE CASCADE);
    CREATE TABLE public.ricevute_emesse (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid, pagamento_id uuid REFERENCES public.pagamenti(id) ON DELETE SET NULL);
    CREATE TABLE public.fatture_emesse (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid REFERENCES public.pagamenti(id) ON DELETE RESTRICT);
    CREATE TABLE public.riconciliazione_movimenti (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid REFERENCES public.pagamenti(id) ON DELETE SET NULL);
    CREATE TABLE public.solleciti (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid, pagamento_id uuid REFERENCES public.pagamenti(id) ON DELETE CASCADE);
  `)
}

beforeAll(async () => {
  db = new PGlite()
  await schemaMinimo(db)
  await db.exec(MIGRAZIONE)
  await db.exec(MIGRAZIONE) // la seconda volta è la prova dell'idempotenza
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec(`
    TRUNCATE public.solleciti, public.riconciliazione_movimenti, public.fatture_emesse, public.ricevute_emesse,
             public.incassi, public.pagamenti, public.valutazioni, public.pagelle, public.scrutinio_giudizi,
             public.scrutinio_comportamento, public.note_disciplinari, public.certificati_competenze,
             public.galleria_media, public.forms_submissions, public.ticket_mensa, public.armadietto,
             public.eventi_diario, public.presenze, public.legame_genitori_alunni, public.student_parents,
             public.parents, public.alunni CASCADE;

    INSERT INTO public.alunni (id, scuola_id, stato, section_id, classe_sezione) VALUES
      ('${ADULTO}',    '${SEDE}', 'ritirato', NULL,     NULL),
      ('${DOPPIONE}',  '${SEDE}', 'ritirato', NULL,     NULL),
      ('${ISCRITTO}',  '${SEDE}', 'iscritto', '${SEZ}', 'SEZIONE A'),
      ('${SENZA_SEZ}', '${SEDE}', 'iscritto', NULL,     NULL),
      ('${FRATELLO}',  '${SEDE}', 'iscritto', '${SEZ}', 'SEZIONE A');
    INSERT INTO public.parents (id) VALUES ('${GENITORE}');
    INSERT INTO public.student_parents (student_id, parent_id) VALUES ('${ADULTO}', '${GENITORE}'), ('${ISCRITTO}', '${GENITORE}');
    INSERT INTO public.legame_genitori_alunni (alunno_id, parent_id) VALUES ('${ADULTO}', '${GENITORE}');
    INSERT INTO public.presenze (alunno_id) VALUES ('${DOPPIONE}');
  `)
})

describe('elimina_alunno_definitivo — chi si può eliminare', () => {
  it('rifiuta chi FREQUENTA (iscritto con sezione) e non tocca niente', async () => {
    expect(await elimina(ISCRITTO)).toMatchObject({ ok: false, code: 'frequentante' })
    expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${ISCRITTO}'`)).toBe(1)
  })

  it('uno stato VUOTO con la sezione vale «frequenta»: il NULL non apre la porta', async () => {
    // `alunni.stato` è nullable (DEFAULT 'iscritto'): per `eNonPiuIscritto` un
    // NULL non è un ritiro. In SQL `NULL = any(…)` dà NULL, e un `if not (…)`
    // costruito sopra non scatterebbe — cioè lascerebbe passare chi frequenta.
    await db.exec(`UPDATE public.alunni SET stato = NULL WHERE id = '${FRATELLO}'`)
    expect(await elimina(FRATELLO)).toMatchObject({ ok: false, code: 'frequentante' })
    expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${FRATELLO}'`)).toBe(1)
  })

  it('risponde «non_trovato» su un id che non esiste', async () => {
    expect(await elimina('99999999-0000-4000-8000-000000000099')).toMatchObject({ ok: false, code: 'non_trovato' })
  })

  it('rifiuta una scheda già anonimizzata', async () => {
    await db.exec(`UPDATE public.alunni SET anonimizzato_il = now() WHERE id = '${DOPPIONE}'`)
    expect(await elimina(DOPPIONE)).toMatchObject({ ok: false, code: 'gia_anonimizzato' })
  })

  it('caso A — l’adulto inserito come bambino: via la scheda e i due legami, il GENITORE resta intatto', async () => {
    expect(await elimina(ADULTO)).toMatchObject({ ok: true, code: 'eliminato' })
    expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${ADULTO}'`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.legame_genitori_alunni WHERE alunno_id = '${ADULTO}'`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.student_parents WHERE student_id = '${ADULTO}'`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.parents WHERE id = '${GENITORE}'`)).toBe(1)
    // e il figlio vero di quel genitore resta collegato
    expect(await numero(`SELECT count(*) FROM public.student_parents WHERE student_id = '${ISCRITTO}'`)).toBe(1)
  })

  it('caso B — il doppione: la presenza se ne va in cascata', async () => {
    expect(await elimina(DOPPIONE)).toMatchObject({ ok: true, code: 'eliminato' })
    expect(await numero(`SELECT count(*) FROM public.presenze WHERE alunno_id = '${DOPPIONE}'`)).toBe(0)
  })

  it('un iscritto SENZA sezione si può eliminare', async () => {
    expect(await elimina(SENZA_SEZ)).toMatchObject({ ok: true, code: 'eliminato' })
  })

  it('porta via diario, armadietto, ticket, moduli e il tag nella galleria storica', async () => {
    await db.exec(`
      INSERT INTO public.eventi_diario (alunno_id) VALUES ('${DOPPIONE}');
      INSERT INTO public.armadietto (alunno_id) VALUES ('${DOPPIONE}');
      INSERT INTO public.ticket_mensa (alunno_id) VALUES ('${DOPPIONE}');
      INSERT INTO public.forms_submissions (student_id) VALUES ('${DOPPIONE}');
      INSERT INTO public.galleria_media (tag_alunni) VALUES (ARRAY['${DOPPIONE}', '${ISCRITTO}']::uuid[]);
    `)
    const r = await elimina(DOPPIONE)
    expect(r).toMatchObject({ ok: true, code: 'eliminato' })
    expect(r.righe).toMatchObject({ diario: 1, armadietto: 1, ticket_mensa: 1, moduli: 1, tag_galleria: 1 })
    expect(await numero(`SELECT count(*) FROM public.eventi_diario`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.galleria_media WHERE '${DOPPIONE}' = ANY(tag_alunni)`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.galleria_media WHERE '${ISCRITTO}' = ANY(tag_alunni)`)).toBe(1)
  })

  it('il fratello che aveva la retta a carico di questa scheda la perde (SET NULL), non sparisce', async () => {
    await db.exec(`UPDATE public.alunni SET retta_a_carico_di = '${DOPPIONE}' WHERE id = '${FRATELLO}'`)
    expect(await elimina(DOPPIONE)).toMatchObject({ ok: true })
    expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${FRATELLO}' AND retta_a_carico_di IS NULL`)).toBe(1)
  })
})

describe('elimina_alunno_definitivo — il registro della primaria', () => {
  for (const tabella of TABELLE_REGISTRO_PRIMARIA) {
    it(`una riga in ${tabella} blocca TUTTO, anche con i pagamenti ammessi`, async () => {
      await db.exec(`INSERT INTO public.${tabella} (alunno_id) VALUES ('${DOPPIONE}')`)
      expect(await elimina(DOPPIONE, true)).toMatchObject({ ok: false, code: 'registro_primaria' })
      expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${DOPPIONE}'`)).toBe(1)
    })
  }

  it('le tabelle controllate in SQL sono ESATTAMENTE quelle di TABELLE_REGISTRO_PRIMARIA', () => {
    const blocco = /-- registro-primaria:inizio([\s\S]*?)-- registro-primaria:fine/.exec(MIGRAZIONE)
    expect(blocco, 'marcatori -- registro-primaria:inizio/fine assenti nella migrazione').not.toBeNull()
    const inSql = [...blocco![1].matchAll(/from public\.(\w+)/gi)].map((m) => m[1]).sort()
    expect(inSql).toEqual([...TABELLE_REGISTRO_PRIMARIA].sort())
  })
})

describe('elimina_alunno_definitivo — i pagamenti', () => {
  async function pagamento(alunno: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(`INSERT INTO public.pagamenti (alunno_id) VALUES ('${alunno}') RETURNING id`)
    return rows[0].id
  }

  it('con pagamenti e senza permesso: rifiuta «ha_pagamenti» e non tocca niente', async () => {
    await pagamento(DOPPIONE)
    expect(await elimina(DOPPIONE)).toMatchObject({ ok: false, code: 'ha_pagamenti' })
    expect(await numero(`SELECT count(*) FROM public.pagamenti`)).toBe(1)
  })

  it('con permesso e pagamenti puliti: via pagamenti e solleciti, poi la scheda', async () => {
    const p = await pagamento(DOPPIONE)
    await db.exec(`INSERT INTO public.solleciti (alunno_id, pagamento_id) VALUES ('${DOPPIONE}', '${p}')`)
    const r = await elimina(DOPPIONE, true)
    expect(r).toMatchObject({ ok: true, code: 'eliminato' })
    expect(r.righe).toMatchObject({ pagamenti: 1 })
    expect(await numero(`SELECT count(*) FROM public.pagamenti`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.solleciti`)).toBe(0)
  })

  const BLOCCHI: [string, (p: string) => string][] = [
    ['incasso registrato', (p) => `INSERT INTO public.incassi (pagamento_id) VALUES ('${p}')`],
    ['ricevuta emessa', (p) => `INSERT INTO public.ricevute_emesse (alunno_id, pagamento_id) VALUES ('${DOPPIONE}', '${p}')`],
    ['fattura emessa', (p) => `INSERT INTO public.fatture_emesse (pagamento_id) VALUES ('${p}')`],
    ['bonifico abbinato', (p) => `INSERT INTO public.riconciliazione_movimenti (pagamento_id) VALUES ('${p}')`],
    ['quota di un fratello appesa', (p) => `INSERT INTO public.pagamenti (alunno_id, parent_payment_id) VALUES ('${FRATELLO}', '${p}')`],
  ]
  for (const [nome, sql] of BLOCCHI) {
    it(`${nome}: «pagamenti_non_cancellabili» anche col permesso, e niente si muove`, async () => {
      const p = await pagamento(DOPPIONE)
      await db.exec(sql(p))
      expect(await elimina(DOPPIONE, true)).toMatchObject({ ok: false, code: 'pagamenti_non_cancellabili' })
      expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${DOPPIONE}'`)).toBe(1)
      expect(await numero(`SELECT count(*) FROM public.pagamenti WHERE alunno_id = '${DOPPIONE}'`)).toBe(1)
    })
  }

  it('una ricevuta emessa SENZA pagamento basta a bloccare', async () => {
    await db.exec(`INSERT INTO public.ricevute_emesse (alunno_id) VALUES ('${DOPPIONE}')`)
    expect(await elimina(DOPPIONE, true)).toMatchObject({ ok: false, code: 'pagamenti_non_cancellabili' })
  })
})

describe('elimina_alunno_definitivo — tutto o niente, e chi può chiamarla', () => {
  it('un errore all’ultimo passo annulla anche le cancellazioni già fatte', async () => {
    // Una FK senza CASCADE che la funzione NON conosce: la DELETE finale fallisce.
    await db.exec(`
      CREATE TABLE IF NOT EXISTS public.tabella_estranea (id serial PRIMARY KEY, alunno_id uuid REFERENCES public.alunni(id));
      INSERT INTO public.tabella_estranea (alunno_id) VALUES ('${DOPPIONE}');
      INSERT INTO public.eventi_diario (alunno_id) VALUES ('${DOPPIONE}');
    `)
    let err: PgErr | null = null
    try {
      await elimina(DOPPIONE)
    } catch (e) {
      err = e as PgErr
    }
    expect(err?.code).toBe('23503')
    expect(await numero(`SELECT count(*) FROM public.eventi_diario WHERE alunno_id = '${DOPPIONE}'`)).toBe(1)
    expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${DOPPIONE}'`)).toBe(1)
    await db.exec(`DROP TABLE public.tabella_estranea`)
  })

  it('la porta è chiusa ad anon e authenticated, aperta al solo service_role', async () => {
    const firma = `'public.elimina_alunno_definitivo(uuid, boolean)'`
    const { rows } = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(`
      SELECT has_function_privilege('anon', ${firma}, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', ${firma}, 'EXECUTE') AS auth,
             has_function_privilege('service_role', ${firma}, 'EXECUTE') AS svc`)
    expect(rows[0]).toEqual({ anon: false, auth: false, svc: true })
  })

  it('la migrazione non cancella mai da storage.objects', () => {
    expect(MIGRAZIONE.toLowerCase()).not.toContain('storage.objects')
  })
})
