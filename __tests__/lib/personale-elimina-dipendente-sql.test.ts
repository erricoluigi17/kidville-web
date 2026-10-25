// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * ELIMINAZIONE DI UN MEMBRO DEL PERSONALE · LA MIGRAZIONE SU UN POSTGRES VERO.
 *
 * Ciò che conta lo può far rispettare solo il database: il «tutto o niente» quando una chiave
 * senza cascata trattiene il profilo, l'ordine dei DELETE, i permessi, il registro dei
 * caricamenti STACCATO invece che cancellato in cascata, la pratica cancellata solo se è del
 * dipendente. Lo schema è un MINIMO con le chiavi della produzione (Passo 7 del Compito 2 del
 * piano della sessione 10; `caricamenti_personale` con i due proprietari e il vincolo «uno solo»
 * di `20260812194501`). Il file della migrazione è LETTO DAL DISCO e applicato DUE volte. Solo
 * uuid e percorsi inventati.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).filter((f) => f.endsWith('_personale_elimina_dipendente.sql'))
if (FILE.length !== 1) throw new Error(`attesa UNA migrazione *_personale_elimina_dipendente.sql, trovate ${FILE.length}`)
const MIGRAZIONE = readFileSync(join(CARTELLA, FILE[0]), 'utf8')

const DIPENDENTE = '30000000-0000-4000-8000-000000000001'
const COLLEGA = '30000000-0000-4000-8000-000000000002'
const PRATICA = '40000000-0000-4000-8000-000000000001'
const PRATICA_COLLEGA = '40000000-0000-4000-8000-000000000002'
const FRONTE = `documenti/${PRATICA}/a0000000-0000-4000-8000-000000000001.jpg`
const RETRO = `documenti/${PRATICA}/a0000000-0000-4000-8000-000000000002.jpg`
const RINNOVO = `documenti/${DIPENDENTE}/a0000000-0000-4000-8000-000000000003.pdf`
const DEL_COLLEGA = `documenti/${PRATICA_COLLEGA}/a0000000-0000-4000-8000-000000000004.jpg`
const SOSPESO_ALTRUI = 'documenti/50000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-000000000005.jpg'

type PgErr = { code?: string; message: string }
type Conteggi = {
  pratiche_cancellate: number
  anagrafiche_cancellate: number
  profili_cancellati: number
  percorsi_staccati: string[]
}

const RUOLI = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
`
const TABELLE = `
  CREATE TABLE public.utenti (id uuid PRIMARY KEY, ruolo text);
  CREATE TABLE public.pratiche_personale (
    id uuid PRIMARY KEY,
    utente_id uuid REFERENCES public.utenti(id),
    evasa_da uuid REFERENCES public.utenti(id)
  );
  CREATE TABLE public.anagrafica_personale (
    utente_id uuid PRIMARY KEY REFERENCES public.utenti(id) ON DELETE CASCADE,
    origine_pratica_id uuid REFERENCES public.pratiche_personale(id) ON DELETE SET NULL,
    aggiornata_da uuid REFERENCES public.utenti(id)
  );
  CREATE TABLE public.caricamenti_personale (
    percorso text PRIMARY KEY CHECK (percorso LIKE 'documenti/%' AND length(percorso) <= 200),
    caricato_il timestamptz NOT NULL DEFAULT now(),
    pratica_id uuid REFERENCES public.pratiche_personale(id) ON DELETE CASCADE,
    anagrafica_utente_id uuid REFERENCES public.anagrafica_personale(utente_id) ON DELETE CASCADE,
    CONSTRAINT caricamenti_personale_un_solo_proprietario CHECK (num_nonnulls(pratica_id, anagrafica_utente_id) <= 1)
  );
  CREATE TABLE public.presenze (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    registrato_da uuid REFERENCES public.utenti(id)
  );
`
/** La funzione di prima, ridotta all'osso: alla migrazione serve solo che esista, per il commento. */
const FUNZIONE_DI_PRIMA = `
  CREATE FUNCTION public.personale_cancella_fascicolo(p_utente_id uuid, p_pratica_id uuid DEFAULT NULL)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
`

let db: PGlite

async function numero(sql: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT (${sql})::int AS n`)
  return rows[0].n
}

async function elimina(utente: string | null, pratica: string | null): Promise<Conteggi> {
  const u = utente ? `'${utente}'::uuid` : 'NULL::uuid'
  const p = pratica ? `'${pratica}'::uuid` : 'NULL::uuid'
  const { rows } = await db.query<{ r: Conteggi }>(`SELECT public.personale_elimina_dipendente(${u}, ${p}) AS r`)
  return rows[0].r
}

async function errore(fn: () => Promise<unknown>): Promise<PgErr> {
  try {
    await fn()
  } catch (e) {
    return e as PgErr
  }
  throw new Error('attesa un\'eccezione dal database')
}

/** `caricamenti` = righe ancora attaccate a lui; `registro` = righe che nominano i suoi tre file. */
async function impronta() {
  return {
    pratica: await numero(`SELECT count(*) FROM public.pratiche_personale WHERE id = '${PRATICA}'`),
    caricamenti: await numero(
      `SELECT count(*) FROM public.caricamenti_personale WHERE pratica_id = '${PRATICA}' OR anagrafica_utente_id = '${DIPENDENTE}'`,
    ),
    registro: await numero(
      `SELECT count(*) FROM public.caricamenti_personale WHERE percorso IN ('${FRONTE}', '${RETRO}', '${RINNOVO}')`,
    ),
    anagrafica: await numero(`SELECT count(*) FROM public.anagrafica_personale WHERE utente_id = '${DIPENDENTE}'`),
    profilo: await numero(`SELECT count(*) FROM public.utenti WHERE id = '${DIPENDENTE}'`),
  }
}

/** Le righe senza proprietario: quelle che la spazzata dei caricamenti in sospeso raccoglie. */
async function sospesi(): Promise<string[]> {
  const { rows } = await db.query<{ percorso: string }>(
    `SELECT percorso FROM public.caricamenti_personale WHERE pratica_id IS NULL AND anagrafica_utente_id IS NULL ORDER BY percorso`,
  )
  return rows.map((r) => r.percorso)
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(RUOLI + TABELLE + FUNZIONE_DI_PRIMA)
  await db.exec(MIGRAZIONE)
  await db.exec(MIGRAZIONE) // la seconda volta è la prova dell'idempotenza
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec(`
    TRUNCATE public.presenze, public.caricamenti_personale, public.anagrafica_personale,
             public.pratiche_personale, public.utenti CASCADE;
    INSERT INTO public.utenti (id, ruolo) VALUES ('${DIPENDENTE}', 'docente'), ('${COLLEGA}', 'segreteria');
    INSERT INTO public.pratiche_personale (id, utente_id) VALUES ('${PRATICA}', '${DIPENDENTE}');
    INSERT INTO public.anagrafica_personale (utente_id, origine_pratica_id, aggiornata_da)
      VALUES ('${DIPENDENTE}', '${PRATICA}', '${DIPENDENTE}');
    INSERT INTO public.caricamenti_personale (percorso, pratica_id, anagrafica_utente_id) VALUES
      ('${FRONTE}', '${PRATICA}', NULL), ('${RETRO}', '${PRATICA}', NULL), ('${RINNOVO}', NULL, '${DIPENDENTE}');
  `)
})

describe('personale_elimina_dipendente — tutto o niente', () => {
  it('cancella pratica, fascicolo e profilo, STACCA il registro e ne ritorna i percorsi', async () => {
    expect(await elimina(DIPENDENTE, PRATICA)).toEqual({
      pratiche_cancellate: 1,
      anagrafiche_cancellate: 1,
      profili_cancellati: 1,
      percorsi_staccati: [FRONTE, RETRO, RINNOVO].sort(),
    })
    // Le righe NON sono sparite in cascata: senza proprietario, i file restano nominati.
    expect(await impronta()).toEqual({ pratica: 0, caricamenti: 0, registro: 3, anagrafica: 0, profilo: 0 })
    expect(await sospesi()).toEqual([FRONTE, RETRO, RINNOVO].sort())
    expect(await numero(`SELECT count(*) FROM public.utenti WHERE id = '${COLLEGA}'`)).toBe(1)
  })

  it('una riga già in sospeso di qualcun altro non si tocca e non si ritorna', async () => {
    await db.exec(`INSERT INTO public.caricamenti_personale (percorso, caricato_il) VALUES ('${SOSPESO_ALTRUI}', '2026-01-01')`)
    expect((await elimina(DIPENDENTE, PRATICA)).percorsi_staccati).not.toContain(SOSPESO_ALTRUI)
    expect(await numero(
      `SELECT count(*) FROM public.caricamenti_personale WHERE percorso = '${SOSPESO_ALTRUI}' AND caricato_il = '2026-01-01'`,
    )).toBe(1)
  })

  it('la pratica di un altro: non la cancella e non ne stacca i caricamenti', async () => {
    // La pratica del dipendente gli è legata solo come origine del fascicolo (utente_id NULL),
    // così il profilo si può cancellare e la chiamata va fino in fondo.
    await db.exec(`
      UPDATE public.pratiche_personale SET utente_id = NULL WHERE id = '${PRATICA}';
      INSERT INTO public.pratiche_personale (id, utente_id) VALUES ('${PRATICA_COLLEGA}', '${COLLEGA}');
      INSERT INTO public.caricamenti_personale (percorso, pratica_id) VALUES ('${DEL_COLLEGA}', '${PRATICA_COLLEGA}');
    `)
    expect(await elimina(DIPENDENTE, PRATICA_COLLEGA)).toEqual({
      pratiche_cancellate: 0,
      anagrafiche_cancellate: 1,
      profili_cancellati: 1,
      percorsi_staccati: [RINNOVO],
    })
    expect(await numero(`SELECT count(*) FROM public.pratiche_personale WHERE id = '${PRATICA_COLLEGA}'`)).toBe(1)
    expect(await numero(
      `SELECT count(*) FROM public.caricamenti_personale WHERE percorso = '${DEL_COLLEGA}' AND pratica_id = '${PRATICA_COLLEGA}'`,
    )).toBe(1)
    // Nemmeno la sua: non l'ha nominata nessuno.
    expect(await numero(`SELECT count(*) FROM public.caricamenti_personale WHERE pratica_id = '${PRATICA}'`)).toBe(2)
  })

  it('la pratica d\'origine del fascicolo si cancella anche se non porta il suo utente_id', async () => {
    await db.exec(`UPDATE public.pratiche_personale SET utente_id = NULL WHERE id = '${PRATICA}'`)
    expect((await elimina(DIPENDENTE, PRATICA)).pratiche_cancellate).toBe(1)
    expect(await impronta()).toEqual({ pratica: 0, caricamenti: 0, registro: 3, anagrafica: 0, profilo: 0 })
  })

  it('la pratica sua si cancella anche se il fascicolo non la nomina come origine', async () => {
    await db.exec(`UPDATE public.anagrafica_personale SET origine_pratica_id = NULL`)
    expect((await elimina(DIPENDENTE, PRATICA)).pratiche_cancellate).toBe(1)
    expect(await impronta()).toEqual({ pratica: 0, caricamenti: 0, registro: 3, anagrafica: 0, profilo: 0 })
  })

  it.each([
    ['una presenza registrata da lui', `INSERT INTO public.presenze (registrato_da) VALUES ('${DIPENDENTE}')`],
    ['una pratica di un collega evasa da lui', `INSERT INTO public.pratiche_personale (id, utente_id, evasa_da) VALUES ('${PRATICA_COLLEGA}', '${COLLEGA}', '${DIPENDENTE}')`],
    ['il fascicolo di un collega aggiornato da lui', `INSERT INTO public.anagrafica_personale (utente_id, aggiornata_da) VALUES ('${COLLEGA}', '${DIPENDENTE}')`],
  ])('%s trattiene il profilo: 23503, e NIENTE è cancellato', async (_caso, sql) => {
    await db.exec(sql)
    const e = await errore(() => elimina(DIPENDENTE, PRATICA))
    expect(e.code).toBe('23503')
    // Anche il distacco è annullato: le righe sono ancora attaccate a lui.
    expect(await impronta()).toEqual({ pratica: 1, caricamenti: 3, registro: 3, anagrafica: 1, profilo: 1 })
    expect(await sospesi()).toEqual([])
  })

  it('la seconda chiamata trova zero righe e lo dice', async () => {
    await elimina(DIPENDENTE, PRATICA)
    expect(await elimina(DIPENDENTE, PRATICA)).toEqual({
      pratiche_cancellate: 0,
      anagrafiche_cancellate: 0,
      profili_cancellati: 0,
      percorsi_staccati: [],
    })
  })

  it('senza pratica cancella fascicolo e profilo', async () => {
    await db.exec(`DELETE FROM public.caricamenti_personale; DELETE FROM public.anagrafica_personale; DELETE FROM public.pratiche_personale;`)
    await db.exec(`INSERT INTO public.anagrafica_personale (utente_id) VALUES ('${DIPENDENTE}')`)
    expect(await elimina(DIPENDENTE, null)).toEqual({
      pratiche_cancellate: 0,
      anagrafiche_cancellate: 1,
      profili_cancellati: 1,
      percorsi_staccati: [],
    })
  })

  // Aggiunto all'esecuzione (mutation testing): negli altri casi fascicoli e profili cancellati
  // sono sempre uguali, e un RETURN che scambiasse i due conteggi restava verde.
  it('un profilo senza fascicolo (account creato a mano): i conteggi lo distinguono', async () => {
    await db.exec(`DELETE FROM public.caricamenti_personale; DELETE FROM public.anagrafica_personale; DELETE FROM public.pratiche_personale;`)
    expect(await elimina(DIPENDENTE, null)).toEqual({
      pratiche_cancellate: 0,
      anagrafiche_cancellate: 0,
      profili_cancellati: 1,
      percorsi_staccati: [],
    })
    expect(await impronta()).toEqual({ pratica: 0, caricamenti: 0, registro: 0, anagrafica: 0, profilo: 0 })
  })

  // La corsa con un caricamento reclamato mentre la funzione gira (due connessioni) PGlite non la
  // sa riprodurre: è provata su Postgres 17 locale (senza il blocco la riga reclamata sparisce in
  // cascata e il suo percorso non torna; con il blocco torna e la riga resta in sospeso). Qui si
  // fissa la forma: fascicolo e pratica FOR UPDATE prima del distacco. Corpo senza commenti.
  it('fascicolo e pratica si bloccano FOR UPDATE prima di staccare il registro', async () => {
    const { rows } = await db.query<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE proname = 'personale_elimina_dipendente'`)
    const corpo = rows[0].src.replace(/--[^\n]*/g, '')
    const fascicolo = corpo.search(/FROM\s+public\.anagrafica_personale\s+a\s+WHERE[^;]*\sFOR\s+UPDATE\s*;/)
    const pratica = corpo.search(/FROM\s+public\.pratiche_personale\s+p\s+WHERE[^;]*\sFOR\s+UPDATE\s*;/)
    const distacco = corpo.indexOf('UPDATE public.caricamenti_personale')
    expect(fascicolo).toBeGreaterThanOrEqual(0)
    expect(pratica).toBeGreaterThanOrEqual(0)
    expect(distacco).toBeGreaterThan(Math.max(fascicolo, pratica))
  })

  it('un utente nullo è una richiesta sbagliata: 22023', async () => {
    expect((await errore(() => elimina(null, null))).code).toBe('22023')
  })

  it('la porta è chiusa ad anon e authenticated, aperta al solo service_role', async () => {
    const firma = `'public.personale_elimina_dipendente(uuid, uuid)'`
    const { rows } = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(`
      SELECT has_function_privilege('anon', ${firma}, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', ${firma}, 'EXECUTE') AS auth,
             has_function_privilege('service_role', ${firma}, 'EXECUTE') AS svc`)
    expect(rows[0]).toEqual({ anon: false, auth: false, svc: true })
  })

  it('il commento della funzione di prima: file nel cestino DOPO, e la cascata sul registro resta detta', async () => {
    const { rows } = await db.query<{ c: string }>(
      `SELECT obj_description('public.personale_cancella_fascicolo(uuid, uuid)'::regprocedure, 'pg_proc') AS c`,
    )
    expect(rows[0].c).toContain('cestino')
    expect(rows[0].c).not.toContain('PRIMA di chiamarla')
    // Lei NON stacca il registro: l'avvertenza sulla cascata non si toglie.
    expect(rows[0].c).toContain('cascata su caricamenti_personale')
  })

  it('su un database senza la funzione di prima la migrazione non si ferma', async () => {
    const vuoto = new PGlite()
    try {
      await vuoto.exec(RUOLI + TABELLE)
      await expect(vuoto.exec(MIGRAZIONE)).resolves.toBeDefined()
      const { rows } = await vuoto.query<{ f: string | null }>(
        `SELECT to_regprocedure('public.personale_elimina_dipendente(uuid, uuid)')::text AS f`,
      )
      expect(rows[0].f).not.toBeNull()
    } finally {
      await vuoto.close()
    }
  })

  it('la migrazione non tocca lo Storage', () => {
    expect(MIGRAZIONE.toLowerCase()).not.toContain('storage.objects')
  })
})
