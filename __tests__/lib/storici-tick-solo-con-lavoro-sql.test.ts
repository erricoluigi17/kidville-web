// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * STORICI_TICK · IL SERVER SI CHIAMA SOLO SE LA CODA HA LAVORO (sessione 8, seconda serie).
 *
 * Il job `storici-stampe` gira ogni minuto e ogni minuto chiamava `/api/admin/storici/cron`:
 * ~1.440 chiamate al giorno per una coda quasi sempre vuota. Da qui la chiamata parte solo se
 * `storici_generazioni` ha una riga che la route prenderebbe (stessa condizione di
 * `riprendiGenerazioni` e `pulisciGenerazioniScadute`, `src/lib/storici/generazioni.ts`).
 *
 * Schema MINIMO: solo le colonne che la funzione legge. `cron_http_post` è finto ma ha la firma
 * vera della sessione 6 — `(job, url, body, params, headers, timeout_milliseconds)`, con gli stessi
 * nomi e gli stessi predefiniti — e registra job, percorso (ricavato dall'URL come fa l'involucro
 * vero), timeout e segreto invece di chiamare. `cron_config` è il Vault finto: URL e segreto si
 * leggono da lì, solo quando c'è lavoro. In fondo, il controllo negativo: la funzione del 19/10,
 * letta dal suo file, chiama anche a coda vuota. Se non lo facesse, questo test non misurerebbe
 * niente.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(suffisso: string): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith(suffisso))
  if (!f) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, f), 'utf8')
}
const NUOVA = migrazione('_storici_tick_solo_con_lavoro.sql')

/** La funzione del 19/10, che chiamava il server ogni minuto. */
function tickDel19(): string {
  const testo = readFileSync(join(CARTELLA, '20261019223123_battiti_app_log_che_contano.sql'), 'utf8')
  const inizio = testo.indexOf('CREATE OR REPLACE FUNCTION public.storici_tick()')
  const fine = testo.indexOf('end $$;', inizio)
  if (inizio < 0 || fine < 0) throw new Error('storici_tick del 19/10 non trovata')
  return testo.slice(inizio, fine + 'end $$;'.length)
}

let db: PGlite

async function schema(): Promise<void> {
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;

    CREATE TABLE public.app_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      creato_il timestamptz NOT NULL DEFAULT now(),
      giorno date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
      livello text NOT NULL CHECK (livello IN ('info','warn','error')),
      evento text NOT NULL,
      sorgente text NOT NULL DEFAULT 'server',
      messaggio text NOT NULL,
      fingerprint text NOT NULL,
      occorrenze int NOT NULL DEFAULT 1,
      visto_l_ultima timestamptz NOT NULL DEFAULT now(),
      contesto jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE UNIQUE INDEX app_log_impronta_giorno_key ON public.app_log (fingerprint, giorno);

    CREATE TABLE public.alunni (id uuid PRIMARY KEY, stato text, stato_cambiato_il timestamptz);
    CREATE FUNCTION public.alunno_uscita_consolidata(text, timestamptz) RETURNS boolean
      LANGUAGE sql IMMUTABLE AS 'SELECT false';
    CREATE TABLE public.storici_revisioni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid,
      modulo text NOT NULL,
      giorno_competenza date NOT NULL,
      contenuto jsonb NOT NULL
    );
    CREATE TABLE public.storici_generazioni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      stato text NOT NULL,
      preso_il timestamptz,
      creato_il timestamptz NOT NULL DEFAULT now(),
      scade_il timestamptz NOT NULL DEFAULT now() + interval '24 hours'
    );

    -- L'involucro finto della sessione 6, con la sua firma vera: registra la chiamata invece di
    -- farla. Il percorso si ricava dall'URL come nell'involucro vero (senza query né frammento).
    CREATE TABLE public.chiamate_finte (job text, percorso text, timeout_ms integer, segreto text);
    CREATE TABLE public.guasto_finto (attivo boolean);
    CREATE FUNCTION public.cron_http_post(
      job text,
      url text,
      body jsonb DEFAULT '{}'::jsonb,
      params jsonb DEFAULT '{}'::jsonb,
      headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds integer DEFAULT 5000
    ) RETURNS bigint LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM public.guasto_finto) THEN
        RAISE EXCEPTION 'pg_net finto: coda piena' USING ERRCODE = 'XX000';
      END IF;
      INSERT INTO public.chiamate_finte VALUES (
        cron_http_post.job,
        substring(cron_http_post.url FROM '^https?://[^/]+(/[^?#]*)'),
        cron_http_post.timeout_milliseconds,
        cron_http_post.headers->>'x-cron-secret'
      );
      RETURN 1;
    END $$;

    -- Per il controllo negativo: la funzione del 19/10 chiamava net.http_post direttamente.
    CREATE SCHEMA net;
    CREATE FUNCTION net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer)
    RETURNS bigint LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO public.chiamate_finte VALUES ('net-diretto', url, timeout_milliseconds, headers->>'x-cron-secret');
      RETURN 1;
    END $$;
    CREATE FUNCTION public.cron_config(k text) RETURNS text LANGUAGE sql AS $$
      SELECT CASE k WHEN 'app.push_dispatch_url' THEN 'https://esempio.test/api/push/dispatch'
                    WHEN 'app.cron_secret' THEN 'segreto-finto' END
    $$;
  `)
}

async function tick(): Promise<void> {
  await db.exec('SELECT public.storici_tick()')
}

async function chiamate(): Promise<{ job: string; percorso: string; timeout_ms: number }[]> {
  return (await db.query<{ job: string; percorso: string; timeout_ms: number }>(
    'SELECT job, percorso, timeout_ms FROM public.chiamate_finte',
  )).rows
}

/** Un lavoro di stampa: presa di `presoSecondiFa` secondi fa (null = mai presa), scadenza fra `scadeFraSecondi`. */
async function lavoro(stato: string, presoSecondiFa: number | null, scadeFraSecondi: number): Promise<void> {
  await db.query(
    `INSERT INTO public.storici_generazioni (stato, preso_il, scade_il)
     VALUES ($1,
             CASE WHEN $2::int IS NULL THEN NULL ELSE now() - make_interval(secs => $2::int) END,
             now() + make_interval(secs => $3::int))`,
    [stato, presoSecondiFa, scadeFraSecondi],
  )
}

const ATTESA = [{ job: 'storici-stampe', percorso: '/api/admin/storici/cron', timeout_ms: 300000 }]

beforeAll(async () => {
  db = new PGlite()
  await schema()
  await db.exec(NUOVA)
  await db.exec(NUOVA) // la seconda volta è la prova dell'idempotenza
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec(`TRUNCATE public.chiamate_finte, public.guasto_finto, public.storici_generazioni,
                          public.storici_revisioni, public.app_log`)
})

describe('storici_tick chiama il server solo se la coda ha lavoro', () => {
  it('coda vuota: nessuna chiamata, e la conservazione delle copie gira lo stesso', async () => {
    await db.query(
      `INSERT INTO public.storici_revisioni (modulo, giorno_competenza, contenuto)
       VALUES ('presenze', current_date - 400, '{"giustificazione_testo":"motivo finto","note_appello":"nota finta"}')`,
    )
    await tick()
    expect(await chiamate()).toEqual([])
    const { rows } = await db.query<{ g: string | null; n: string | null }>(
      `SELECT contenuto->>'giustificazione_testo' AS g, contenuto->>'note_appello' AS n FROM public.storici_revisioni`,
    )
    expect(rows).toEqual([{ g: null, n: null }])
  })

  it('un lavoro in coda mai preso: una chiamata, col timeout della route', async () => {
    await lavoro('in_coda', null, 3600)
    await tick()
    expect(await chiamate()).toEqual(ATTESA)
  })

  it('la chiamata porta il segreto letto dal Vault', async () => {
    await lavoro('in_coda', null, 3600)
    await tick()
    const { rows } = await db.query<{ segreto: string | null }>('SELECT segreto FROM public.chiamate_finte')
    expect(rows).toEqual([{ segreto: 'segreto-finto' }])
  })

  it('configurazione mancante: niente a coda vuota; con lavoro, nessuna chiamata e una riga error', async () => {
    await db.exec('BEGIN')
    try {
      await db.exec(`CREATE OR REPLACE FUNCTION public.cron_config(k text) RETURNS text
                       LANGUAGE sql AS 'SELECT NULL::text'`)
      const configurazione = async () => (await db.query<{ livello: string; campi: Record<string, unknown> }>(
        `SELECT livello, contesto->'campi' AS campi FROM public.app_log
          WHERE fingerprint = 'storici-cron-config-assente'`,
      )).rows
      await tick()
      expect(await configurazione()).toEqual([])
      await lavoro('in_coda', null, 3600)
      await tick()
      expect(await chiamate()).toEqual([])
      expect(await configurazione()).toEqual([{
        livello: 'error',
        campi: { operazione: 'storici-stampe', esito: 'configurazione-assente' },
      }])
    } finally {
      await db.exec('ROLLBACK')
    }
  })

  it('un lavoro in corso con la presa viva: nessuna chiamata (un altro giro ci sta lavorando)', async () => {
    await lavoro('in_corso', 10, 3600)
    await tick()
    expect(await chiamate()).toEqual([])
  })

  it('un lavoro in corso con la presa scaduta da più di 330 s: una chiamata', async () => {
    await lavoro('in_corso', 400, 3600)
    await tick()
    expect(await chiamate()).toEqual(ATTESA)
  })

  it('un lavoro scaduto da pulire: una chiamata', async () => {
    await lavoro('completato', null, -60)
    await tick()
    expect(await chiamate()).toEqual(ATTESA)
  })

  it('un lavoro completato e non scaduto, o scaduto ma in pulizia: nessuna chiamata', async () => {
    await lavoro('completato', null, 3600)
    await lavoro('completato', 10, -60)
    await tick()
    expect(await chiamate()).toEqual([])
  })

  it('la chiamata che fallisce non ferma il giro, e conta in app_log', async () => {
    await db.exec('INSERT INTO public.guasto_finto VALUES (true)')
    await lavoro('in_coda', null, 3600)
    await tick()
    await tick()
    const { rows } = await db.query<{ livello: string; occorrenze: number; campi: Record<string, unknown> }>(
      `SELECT livello, occorrenze, contesto->'campi' AS campi FROM public.app_log
        WHERE fingerprint = 'cron:storici-stampe:chiamata-fallita'`,
    )
    expect(rows).toEqual([{
      livello: 'error',
      occorrenze: 2,
      campi: { operazione: 'storici-stampe', esito: 'chiamata-fallita', sqlstate: 'XX000' },
    }])
  })

  it('i 330 secondi del SQL sono la presa della coda in `generazioni.ts`', () => {
    const ts = readFileSync(join(process.cwd(), 'src/lib/storici/generazioni.ts'), 'utf8')
    const ms = Number(/const DURATA_LEASE_MS = ([\d_]+)/.exec(ts)![1].replace(/_/g, ''))
    const s = Number(/interval '(\d+) seconds'/.exec(NUOVA)![1])
    expect(s * 1000).toBe(ms)
  })

  it('CONTROLLO NEGATIVO: la funzione del 19/10 chiamava il server anche a coda vuota', async () => {
    await db.exec('BEGIN')
    try {
      await db.exec(tickDel19())
      await tick()
      expect((await chiamate()).map((c) => c.job)).toEqual(['net-diretto'])
    } finally {
      await db.exec('ROLLBACK')
    }
  })
})
