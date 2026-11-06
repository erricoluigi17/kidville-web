import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'

/**
 * SCHEMA MINIMO DELL'ANNO SCOLASTICO PER PGLITE.
 *
 * Una base di poche tabelle (ruoli, schema `extensions`, `schools`) sopra cui si applica l'INTERA
 * migrazione `*_anno_scolastico_schema.sql`, letta dal disco: se in produzione cambia, cambia anche
 * qui. Le tabelle che servono ai compiti dopo (sections, alunni, presenze…) le aggiungono i
 * compiti stessi in `SCHEMA_BASE`, PRIMA della migrazione: i test dei compiti precedenti devono
 * restare verdi dopo ogni estensione.
 *
 * Solo dati finti: gli uuid dei test sono inventati (`2222…`, `3333…`), mai di una sede vera.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')

/** Il file della migrazione, trovato per suffisso (la version è l'istante in cui fu creato). */
export function fileMigrazioneAnno(): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith('_anno_scolastico_schema.sql'))
  if (!f) throw new Error('manca supabase/migrations/*_anno_scolastico_schema.sql')
  return join(CARTELLA, f)
}

/**
 * Le tabelle che la migrazione trova già in produzione. `schools` ha le sue colonne vere,
 * `operativa` compresa: nel DB della CI manca, e la migrazione non deve leggerla.
 */
export const SCHEMA_BASE = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;

  CREATE SCHEMA extensions;

  -- Come su Supabase: ogni oggetto nuovo di \`public\` nasce con i privilegi aperti ad anon e
  -- authenticated. Senza, in PGlite quei ruoli non hanno mai niente e un REVOKE mancante nella
  -- migrazione passerebbe inosservato (il test di sicurezza sarebbe verde anche senza il codice).
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

  CREATE TABLE public.schools (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome text NOT NULL,
    indirizzo text,
    citta text,
    creato_il timestamptz DEFAULT now(),
    operativa boolean NOT NULL DEFAULT true
  );

  -- ── Compito 1.2: le sezioni, come sono oggi in produzione ──
  CREATE TYPE public.school_type_enum AS ENUM ('nido', 'infanzia', 'primaria');

  CREATE TABLE public.sections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    name varchar(50) NOT NULL,
    school_type public.school_type_enum NOT NULL DEFAULT 'infanzia',
    created_at timestamptz DEFAULT now()
  );
  -- I due indici unici di oggi: la migrazione li deve rifare davvero, con lo stesso nome.
  CREATE UNIQUE INDEX sections_nome_per_sede ON public.sections (scuola_id, name);
  CREATE UNIQUE INDEX sections_forma_normalizzata_per_sede
    ON public.sections (scuola_id, lower(replace(name, ' ', '')));

  -- Solo le colonne che leggono le due funzioni (in produzione ce ne sono molte di più).
  CREATE TABLE public.alunni (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid,
    section_id uuid,
    classe_sezione text
  );
  CREATE TABLE public.avvisi (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid,
    target_classes text[]
  );
  CREATE TABLE public.app_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    giorno date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
    livello text NOT NULL,
    evento text NOT NULL,
    sorgente text NOT NULL DEFAULT 'server',
    messaggio text NOT NULL,
    scuola_id uuid,
    fingerprint text NOT NULL,
    occorrenze int NOT NULL DEFAULT 1,
    visto_l_ultima timestamptz NOT NULL DEFAULT now(),
    contesto jsonb NOT NULL DEFAULT '{}'::jsonb
  );
  CREATE UNIQUE INDEX app_log_impronta_giorno_key ON public.app_log (fingerprint, giorno);

  -- Le due funzioni di oggi sono FINTE (\`RETURN NEW\`): la migrazione le sostituisce con
  -- CREATE OR REPLACE, e i test provano la versione della migrazione. I trigger sono quelli veri.
  CREATE FUNCTION public.sync_alunno_section_id() RETURNS trigger LANGUAGE plpgsql AS $f$
  BEGIN RETURN NEW; END $f$;
  CREATE TRIGGER trg_alunni_sync_section
    BEFORE INSERT OR UPDATE OF classe_sezione, section_id, scuola_id ON public.alunni
    FOR EACH ROW EXECUTE FUNCTION public.sync_alunno_section_id();

  CREATE FUNCTION public.propaga_rinomina_sezione() RETURNS trigger LANGUAGE plpgsql AS $f$
  BEGIN RETURN NULL; END $f$;
  CREATE TRIGGER trg_sections_propaga_rinomina
    AFTER UPDATE OF name ON public.sections
    FOR EACH ROW WHEN (NEW.name IS DISTINCT FROM OLD.name)
    EXECUTE FUNCTION public.propaga_rinomina_sezione();
`

export interface OpzioniDbAnno {
  /** Sedi già presenti PRIMA della migrazione, come in produzione: la migrazione dà loro gli anni. */
  sediPrimaDellaMigrazione?: string[]
  /** SQL eseguito PRIMA della migrazione (dopo le sedi): righe che in produzione esistono già, come le sezioni. */
  codaPrima?: string
  /** SQL accodato alla migrazione NELLO STESSO exec, cioè nella stessa transazione (come fa una sezione successiva). */
  codaDopo?: string
}

/** Un PGlite con `btree_gist`, la base e l'intera migrazione dell'anno scolastico. */
export async function creaDbAnno(opzioni: OpzioniDbAnno = {}): Promise<PGlite> {
  const db = new PGlite({ extensions: { btree_gist } })
  await db.exec(SCHEMA_BASE)
  for (const id of opzioni.sediPrimaDellaMigrazione ?? []) {
    await db.query('INSERT INTO public.schools (id, nome) VALUES ($1, $2)', [id, 'Sede di prova'])
  }
  if (opzioni.codaPrima) await db.exec(opzioni.codaPrima)
  await db.exec(readFileSync(fileMigrazioneAnno(), 'utf8') + '\n' + (opzioni.codaDopo ?? ''))
  return db
}
