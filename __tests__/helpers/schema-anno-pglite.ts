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
    classe_sezione text,
    -- 1.5: una colonna che alunni e frequenze hanno con lo stesso nome (l'invariante 11 la confronta)
    usa_pannolino boolean NOT NULL DEFAULT false
  );
  -- 1.5: gli insegnanti delle copie del passaggio d'anno puntano agli utenti (qui solo la chiave).
  CREATE TABLE public.utenti (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.avvisi (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid,
    target_classes text[],
    -- 1.4a: le due colonne da cui il registro ricava l'anno (come in produzione)
    giorno_competenza date,
    created_at timestamptz DEFAULT now()
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

  -- ── Compito 1.3: le tabelle verso cui puntano le frequenze e il listino, con le colonne vere ──
  CREATE TABLE public.gruppi_mensa (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid NOT NULL,
    nome text NOT NULL,
    attivo boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.enrollment_submissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.payment_categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid,
    nome text NOT NULL,
    slug text,
    attivo boolean NOT NULL DEFAULT true
  );
  -- \`stato\` è il CHECK che in produzione c'è dal 2026-10-19; \`importo_pagato\` e \`stato\` sono le due
  -- colonne che il trigger sulle voci guarda.
  CREATE TABLE public.pagamenti (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alunno_id uuid,
    scuola_id uuid,
    descrizione text NOT NULL,
    importo numeric(10,2) NOT NULL,
    scadenza date NOT NULL,
    stato varchar(20) DEFAULT 'da_pagare'
      CHECK (stato IN ('da_pagare', 'parziale', 'pagato', 'scaduto')),
    categoria_id uuid REFERENCES public.payment_categories(id),
    importo_pagato numeric(10,2) NOT NULL DEFAULT 0,
    periodo_competenza date,
    creato_il timestamptz DEFAULT now(),
    -- 1.4b: le colonne d'incasso che la guardia lascia passare senza gettone (nomi veri di produzione)
    data_incasso date,
    fattura_id uuid,
    fattura_stato text,
    ultimo_sollecito_il timestamptz,
    aggiornato_il timestamptz
  );

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

  -- ── Compito 1.4a: alcune tabelle del registro, con i nomi veri delle colonne di produzione ──
  -- Una per ogni modo: \`presenze\` e \`valutazioni\` (data, via scuola_id / alunno_id), \`chat_messages\`
  -- (data, via thread → alunno), \`pagamenti\` (dichiarato, sopra), \`utenti_sezioni\` (madre). Il resto
  -- del registro NON c'è: la migrazione lo salta con to_regclass, come sul DB della CI.
  CREATE TABLE public.presenze (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alunno_id uuid,
    scuola_id uuid NOT NULL,
    section_id uuid,
    data date NOT NULL,
    created_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.valutazioni (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alunno_id uuid,
    section_id uuid,
    data_evento date,
    creato_il timestamptz DEFAULT now()
  );
  CREATE TABLE public.chat_threads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id uuid,
    parent_id uuid,
    student_id uuid,
    created_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.chat_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id uuid NOT NULL REFERENCES public.chat_threads(id) ON DELETE CASCADE,
    created_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.utenti_sezioni (
    utente_id uuid NOT NULL,
    section_id uuid NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
    creato_il timestamptz DEFAULT now(),
    PRIMARY KEY (utente_id, section_id)
  );

  -- ── Compito 1.4b: la scatola nera, solo le colonne che servono a provare la \`transazione\` ──
  CREATE SCHEMA scatola_nera;
  CREATE TABLE scatola_nera.modifiche (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    modificata_il  timestamptz NOT NULL DEFAULT clock_timestamp(),
    transazione    bigint      NOT NULL DEFAULT txid_current(),
    tabella        text        NOT NULL,
    riga_id        text        NOT NULL,
    prima          jsonb       NOT NULL,
    cambiate       text[]      NOT NULL,
    ruolo          text        NOT NULL
  );

  -- Il browser scrive \`presenze\` (e la chat, e syncEngine) sotto RLS: una policy aperta, come
  -- quelle vere, perché il test del trigger come \`authenticated\` (R13) abbia qualcosa da attraversare.
  ALTER TABLE public.presenze ENABLE ROW LEVEL SECURITY;
  CREATE POLICY presenze_aperta ON public.presenze FOR ALL TO authenticated USING (true) WITH CHECK (true);
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

/**
 * Riporta gli anni di TUTTE le sedi a un calendario fisso, indipendente dal giorno in cui gira il test:
 * sotto il 2026 `chiuso`, 2026/27 `corrente`, dal 2027 in su `in_preparazione`. La migrazione dà alle sedi
 * che già c'erano gli stati di OGGI (dal 01/08/2027 il 2026/27 sarebbe `in_chiusura`, dal 01/09/2027 il
 * 2027/28 sarebbe `corrente`). Va chiamata dopo `anni_sede_crea_per_sede(sede, '2026-11-06')`, che completa
 * gli anni mancanti.
 *
 * DUE UPDATE, non uno: l'indice unico `anni_sede_un_corrente_per_sede` non è differibile, e con un
 * UPDATE solo il 2026/27 diventa `corrente` mentre un altro anno lo è ancora (23505). Prima si porta
 * fuori da `corrente` ogni anno che non è il 2026/27, poi si accende lui.
 */
export async function fissaCalendarioAnni(db: PGlite): Promise<void> {
  await db.exec(`
    UPDATE public.anni_sede s
       SET inizio = y.inizio_predefinito, fine = y.fine_predefinita,
           stato = CASE WHEN y.anno_inizio < 2026 THEN 'chiuso' ELSE 'in_preparazione' END,
           ultimo_giorno_aperto = make_date(y.anno_inizio + 1, 7, 31),
           prepara_successivo_dal = y.inizio_predefinito
      FROM public.anni_scolastici y
     WHERE y.id = s.anno_id AND y.anno_inizio <> 2026;
    UPDATE public.anni_sede s
       SET inizio = y.inizio_predefinito, fine = y.fine_predefinita, stato = 'corrente',
           ultimo_giorno_aperto = make_date(y.anno_inizio + 1, 7, 31),
           prepara_successivo_dal = y.inizio_predefinito
      FROM public.anni_scolastici y
     WHERE y.id = s.anno_id AND y.anno_inizio = 2026;
  `)
}

/**
 * Dà alla sede gli anni del calendario di prova (2025/26 e 2026/27, creati con `p_oggi` fisso) e riporta
 * tutto a stati fissi. Prima mette fuori da `corrente` gli anni che la migrazione ha già creato per OGGI:
 * dal 01/09/2028 il 2028/29 sarebbe `corrente` e la creazione del 2026/27 `corrente` urterebbe
 * `anni_sede_un_corrente_per_sede` (indice non differibile).
 */
export async function creaAnniFissi(db: PGlite, sedi: string[]): Promise<void> {
  await db.exec(`UPDATE public.anni_sede SET stato = 'in_preparazione' WHERE stato = 'corrente'`)
  for (const sede of sedi) await db.query(`SELECT public.anni_sede_crea_per_sede($1, DATE '2026-11-06')`, [sede])
  await fissaCalendarioAnni(db)
}
