// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * MODIFICA DI UNA NOTA · LA MIGRAZIONE SU UN POSTGRES VERO.
 * Ciò che si prova: la presa visione si toglie SOLO alle note a cui il testo cambia DAVVERO,
 * confrontato con quello letto dalla funzione sotto il blocco (non con l'elenco `p_ids_azzera`
 * che la route calcola su una lettura che può essere vecchia), nella stessa transazione
 * dell'aggiornamento; una sezione sbagliata non tocca niente. Schema dalla
 * baseline (righe 2050-2080: NOT NULL, CHECK su `categoria`; 3436: il vincolo di unicità
 * di `nota_ricezioni`) più `data_evento`. Solo uuid e testi inventati.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).filter((f) => f.endsWith('_note_modifica.sql'))
if (FILE.length !== 1) throw new Error(`attesa UNA migrazione *_note_modifica.sql, trovate ${FILE.length}`)
const MIGRAZIONE = readFileSync(join(CARTELLA, FILE[0]), 'utf8')

const SEZ = '70000000-0000-4000-8000-000000000001'
const ALTRA_SEZ = '70000000-0000-4000-8000-000000000002'
const N1 = '80000000-0000-4000-8000-000000000001'
const N2 = '80000000-0000-4000-8000-000000000002'
const N3 = '80000000-0000-4000-8000-000000000003'
const GRUPPO = '90000000-0000-4000-8000-000000000001'
const NUOVO_GRUPPO = '90000000-0000-4000-8000-000000000002'
const GENITORE = 'a0000000-0000-4000-8000-000000000001'
const ALUNNO = 'b0000000-0000-4000-8000-000000000001'
const MAESTRA = 'c0000000-0000-4000-8000-000000000001'

type PgErr = { code?: string; message: string }
type Nota = { id: string; categoria: string; testo: string; firmata_il: string | null; firmata_da: string | null; nota_gruppo_id: string | null; data_evento: string | null }
type Esito = { ricezioni_cancellate: number; note: Nota[] }

let db: PGlite

const uuidArr = (xs: string[]) => (xs.length ? `ARRAY[${xs.map((x) => `'${x}'`).join(', ')}]::uuid[]` : `'{}'::uuid[]`)
const testo = (v: string | null | undefined) => (v == null ? 'NULL::text' : `'${v}'::text`)

async function modifica(a: {
  ids: string[]; sezione: string | null; azzera?: string[]
  categoria?: string | null; testo?: string | null; firma?: boolean | null; data?: string | null; gruppo?: string | null
}): Promise<Esito> {
  const { rows } = await db.query<{ r: Esito }>(`
    SELECT public.note_modifica(
      ${uuidArr(a.ids)}, ${a.sezione ? `'${a.sezione}'::uuid` : 'NULL::uuid'}, ${uuidArr(a.azzera ?? [])},
      ${testo(a.categoria)}, ${testo(a.testo)}, ${a.firma == null ? 'NULL::boolean' : String(a.firma)},
      ${a.data ? `'${a.data}'::date` : 'NULL::date'}, ${a.gruppo ? `'${a.gruppo}'::uuid` : 'NULL::uuid'}
    ) AS r`)
  return rows[0].r
}

async function nota(id: string): Promise<Nota> {
  const { rows } = await db.query<Nota>(
    `SELECT id, categoria, testo, firmata_il::text, firmata_da::text, nota_gruppo_id::text, data_evento::text
       FROM public.note_disciplinari WHERE id = '${id}'`,
  )
  return rows[0]
}

async function ricezioni(id: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.nota_ricezioni WHERE nota_id = '${id}'`)
  return rows[0].n
}

async function errore(fn: () => Promise<unknown>): Promise<PgErr> {
  try {
    await fn()
  } catch (e) {
    return e as PgErr
  }
  throw new Error('attesa un\'eccezione dal database')
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

    CREATE TABLE public.note_disciplinari (
      id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
      alunno_id uuid NOT NULL,
      maestra_id uuid NOT NULL,
      categoria character varying(50) NOT NULL,
      testo text NOT NULL,
      richiede_firma boolean DEFAULT false,
      firmata_il timestamp with time zone,
      firmata_da uuid,
      creato_il timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
      section_id uuid,
      nota_gruppo_id uuid,
      oscurata_ad_altri boolean DEFAULT true NOT NULL,
      data_evento date,
      CONSTRAINT note_disciplinari_categoria_check CHECK (((categoria)::text = ANY ((ARRAY['disciplinare'::character varying, 'didattica'::character varying, 'compiti_non_svolti'::character varying])::text[])))
    );
    CREATE TABLE public.nota_ricezioni (
      id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
      nota_id uuid NOT NULL REFERENCES public.note_disciplinari(id) ON DELETE CASCADE,
      alunno_id uuid NOT NULL,
      genitore_id uuid NOT NULL,
      firmato_il timestamp with time zone DEFAULT now(),
      firma jsonb,
      CONSTRAINT nota_ricezioni_nota_id_genitore_id_key UNIQUE (nota_id, genitore_id)
    );
  `)
  await db.exec(MIGRAZIONE)
  await db.exec(MIGRAZIONE) // idempotente
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec(`
    DROP TRIGGER IF EXISTS rompi ON public.note_disciplinari;
    TRUNCATE public.nota_ricezioni, public.note_disciplinari;
    INSERT INTO public.note_disciplinari (id, alunno_id, maestra_id, categoria, testo, richiede_firma, firmata_il, firmata_da, section_id, nota_gruppo_id, data_evento) VALUES
      ('${N1}', '${ALUNNO}', '${MAESTRA}', 'disciplinare', 'testo uno', true, '2026-09-09T12:00:00Z', '${GENITORE}', '${SEZ}', '${GRUPPO}', '2026-09-08'),
      ('${N2}', '${ALUNNO}', '${MAESTRA}', 'disciplinare', 'testo uno', true, '2026-09-09T12:00:00Z', '${GENITORE}', '${SEZ}', '${GRUPPO}', '2026-09-08'),
      ('${N3}', '${ALUNNO}', '${MAESTRA}', 'disciplinare', 'testo tre', true, '2026-09-09T12:00:00Z', '${GENITORE}', '${ALTRA_SEZ}', NULL, '2026-09-08');
    INSERT INTO public.nota_ricezioni (nota_id, alunno_id, genitore_id, firmato_il) VALUES
      ('${N1}', '${ALUNNO}', '${GENITORE}', '2026-09-09T12:00:00Z'),
      ('${N2}', '${ALUNNO}', '${GENITORE}', '2026-09-09T12:00:00Z'),
      ('${N3}', '${ALUNNO}', '${GENITORE}', '2026-09-09T12:00:00Z');
  `)
})

describe('note_modifica', () => {
  it('la sola categoria non tocca firme né prese visione', async () => {
    const e = await modifica({ ids: [N1, N2], sezione: SEZ, categoria: 'didattica' })
    expect(e.ricezioni_cancellate).toBe(0)
    expect(e.note.map((n) => n.categoria).sort()).toEqual(['didattica', 'didattica'])
    expect((await nota(N1)).firmata_il).not.toBeNull()
    expect(await ricezioni(N1)).toBe(1)
    expect(await ricezioni(N2)).toBe(1)
  })

  it('il testo nuovo azzera la firma solo delle note a cui cambia, non di quelle che lo hanno già', async () => {
    await db.exec(`UPDATE public.note_disciplinari SET testo = 'testo nuovo' WHERE id = '${N2}'`)
    const e = await modifica({ ids: [N1, N2], sezione: SEZ, azzera: [N1, N2], testo: 'testo nuovo' })
    expect(e.ricezioni_cancellate).toBe(1)
    expect(await nota(N1)).toMatchObject({ testo: 'testo nuovo', firmata_il: null, firmata_da: null })
    expect(await ricezioni(N1)).toBe(0)
    expect(await nota(N2)).toMatchObject({ testo: 'testo nuovo', firmata_da: GENITORE })
    expect((await nota(N2)).firmata_il).not.toBeNull()
    expect(await ricezioni(N2)).toBe(1)
  })

  // I due casi della seconda revisione: la route ha letto le note PRIMA, e nel frattempo
  // un'altra modifica ha cambiato il testo. Decide il testo letto sotto il blocco.
  it('la route ha letto un testo vecchio («X»), nel DB c\'è «B» firmato: manda «X» senza azzerare → la firma si toglie', async () => {
    await db.exec(`UPDATE public.note_disciplinari SET testo = 'B' WHERE id = '${N1}'`)
    const e = await modifica({ ids: [N1], sezione: SEZ, azzera: [], categoria: 'didattica', testo: 'X' })
    expect(e.ricezioni_cancellate).toBe(1)
    expect(await nota(N1)).toMatchObject({ testo: 'X', categoria: 'didattica', firmata_il: null, firmata_da: null })
    expect(await ricezioni(N1)).toBe(0)
  })

  it('nel DB c\'è già il testo nuovo, la route crede di cambiarlo: la firma resta', async () => {
    await db.exec(`UPDATE public.note_disciplinari SET testo = 'testo nuovo' WHERE id = '${N1}'`)
    const e = await modifica({ ids: [N1], sezione: SEZ, azzera: [N1], testo: 'testo nuovo' })
    expect(e.ricezioni_cancellate).toBe(0)
    expect(await nota(N1)).toMatchObject({ testo: 'testo nuovo', firmata_da: GENITORE })
    expect((await nota(N1)).firmata_il).not.toBeNull()
    expect(await ricezioni(N1)).toBe(1)
  })

  // Il testo si confronta rifilato come lo rifila la route (`String.prototype.trim()`): un a
  // capo in coda o uno spazio indivisibile non sono una modifica.
  it.each([
    ['un a capo e degli spazi in coda', 'testo uno\n  '],
    ['una tabulazione in testa', '\ttesto uno'],
    ['uno spazio indivisibile in coda', 'testo uno\u00A0'],
  ])('%s non tolgono la firma', async (_caso, inviato) => {
    const e = await modifica({ ids: [N1], sezione: SEZ, azzera: [N1], testo: inviato })
    expect(e.ricezioni_cancellate).toBe(0)
    expect((await nota(N1)).firmata_il).not.toBeNull()
    expect(await ricezioni(N1)).toBe(1)
  })

  it('una nota di un\'altra sezione non si tocca, nemmeno se indicata da azzerare', async () => {
    const e = await modifica({ ids: [N3], sezione: SEZ, azzera: [N3], testo: 'intruso' })
    expect(e).toEqual({ ricezioni_cancellate: 0, note: [] })
    expect(await nota(N3)).toMatchObject({ testo: 'testo tre' })
    expect(await ricezioni(N3)).toBe(1)
  })

  // Aggiunto dopo la revisione: senza questo caso, una DELETE che non guardasse `p_ids`
  // (solo il confronto e la sezione) restava verde. `p_ids_azzera` non decide più niente.
  it('una nota che non è fra quelle modificate non perde la presa visione, anche se è «da azzerare»', async () => {
    const e = await modifica({ ids: [N1], sezione: SEZ, azzera: [N2], testo: 'testo nuovo' })
    expect(e.ricezioni_cancellate).toBe(1)
    expect(await ricezioni(N1)).toBe(0)
    expect(await ricezioni(N2)).toBe(1)
    expect(await nota(N2)).toMatchObject({ testo: 'testo uno' })
    expect((await nota(N2)).firmata_il).not.toBeNull()
  })

  it('una categoria che il vincolo della baseline rifiuta (23514): niente tolto, niente cambiato', async () => {
    const e = await errore(() => modifica({ ids: [N1], sezione: SEZ, azzera: [N1], categoria: 'inventata', testo: 'testo nuovo' }))
    expect(e.code).toBe('23514')
    expect(await ricezioni(N1)).toBe(1)
    expect(await nota(N1)).toMatchObject({ testo: 'testo uno', categoria: 'disciplinare' })
    expect((await nota(N1)).firmata_il).not.toBeNull()
  })

  it('la data nuova sposta la nota in un gruppo nuovo', async () => {
    await modifica({ ids: [N1], sezione: SEZ, data: '2026-10-01', gruppo: NUOVO_GRUPPO })
    expect(await nota(N1)).toMatchObject({ data_evento: '2026-10-01', nota_gruppo_id: NUOVO_GRUPPO })
    expect(await nota(N2)).toMatchObject({ data_evento: '2026-09-08', nota_gruppo_id: GRUPPO })
  })

  // Aggiunto all'esecuzione (mutation testing): senza questo caso, una funzione che scrivesse
  // NULL nei campi non passati (testo, categoria, data, gruppo, firma richiesta) restava verde.
  it('i parametri NULL lasciano ogni altro campo com\'era', async () => {
    const richiedeFirma = async (id: string) =>
      (await db.query<{ r: boolean }>(`SELECT richiede_firma AS r FROM public.note_disciplinari WHERE id = '${id}'`)).rows[0].r
    await modifica({ ids: [N1], sezione: SEZ, azzera: [N1], testo: 'solo il testo' })
    expect(await nota(N1)).toMatchObject({ testo: 'solo il testo', categoria: 'disciplinare', data_evento: '2026-09-08', nota_gruppo_id: GRUPPO })
    expect(await richiedeFirma(N1)).toBe(true)
    await modifica({ ids: [N2], sezione: SEZ, categoria: 'didattica' })
    expect(await nota(N2)).toMatchObject({ testo: 'testo uno', categoria: 'didattica', data_evento: '2026-09-08', nota_gruppo_id: GRUPPO })
    await modifica({ ids: [N2], sezione: SEZ, firma: false })
    expect(await richiedeFirma(N2)).toBe(false)
    expect(await richiedeFirma(N1)).toBe(true)
  })

  it('se l\'aggiornamento fallisce, la presa visione NON è stata tolta', async () => {
    await db.exec(`
      CREATE OR REPLACE FUNCTION public.rompi_nota() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.testo = 'rompi' THEN RAISE EXCEPTION 'rotto apposta' USING ERRCODE = 'P0001'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER rompi BEFORE UPDATE ON public.note_disciplinari FOR EACH ROW EXECUTE FUNCTION public.rompi_nota();
    `)
    const e = await errore(() => modifica({ ids: [N1], sezione: SEZ, azzera: [N1], testo: 'rompi' }))
    expect(e.code).toBe('P0001')
    expect(await ricezioni(N1)).toBe(1)
    expect((await nota(N1)).firmata_il).not.toBeNull()
  })

  // La corsa con la firma di un genitore (due connessioni) PGlite non la sa riprodurre: è provata
  // su Postgres 17 locale (senza il blocco resta 1 presa visione sul testo nuovo, con il blocco 0).
  // Qui si fissa la forma che la chiude: FOR UPDATE sulle note, PRIMA della DELETE. Si legge il
  // corpo installato senza i commenti, che nominano FOR UPDATE prima della DELETE anche da soli.
  it('le note si bloccano FOR UPDATE prima di togliere le prese visione', async () => {
    const { rows } = await db.query<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE proname = 'note_modifica'`)
    const corpo = rows[0].src.replace(/--[^\n]*/g, '')
    const blocco = corpo.search(/PERFORM\s+1\s+FROM\s+public\.note_disciplinari\s+WHERE[^;]*\sFOR\s+UPDATE\s*;/)
    const cancella = corpo.indexOf('DELETE FROM public.nota_ricezioni')
    expect(blocco).toBeGreaterThanOrEqual(0)
    expect(cancella).toBeGreaterThan(blocco)
  })

  it('senza note o senza sezione è una richiesta sbagliata: 22023', async () => {
    expect((await errore(() => modifica({ ids: [], sezione: SEZ }))).code).toBe('22023')
    expect((await errore(() => modifica({ ids: [N1], sezione: null }))).code).toBe('22023')
  })

  it('la porta è chiusa ad anon e authenticated, aperta al solo service_role', async () => {
    const firma = `'public.note_modifica(uuid[], uuid, uuid[], text, text, boolean, date, uuid)'`
    const { rows } = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(`
      SELECT has_function_privilege('anon', ${firma}, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', ${firma}, 'EXECUTE') AS auth,
             has_function_privilege('service_role', ${firma}, 'EXECUTE') AS svc`)
    expect(rows[0]).toEqual({ anon: false, auth: false, svc: true })
  })
})
