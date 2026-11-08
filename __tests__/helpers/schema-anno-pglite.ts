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

  -- PR 4.4: \`auth.uid()\` come su Supabase, legge il \`sub\` delle claim. I wrapper \`*_miei()\` la chiamano.
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
    SELECT coalesce(
      NULLIF(current_setting('request.jwt.claim.sub', true), ''),
      NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    )::uuid
  $f$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

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
  -- Assegnazioni per materia (baseline): dicono QUALI materie, non se la classe è del docente (conta utenti_sezioni).
  CREATE TABLE public.utenti_sezioni_materie (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    utente_id uuid NOT NULL,
    section_id uuid NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
    materia_id uuid NOT NULL,
    e_contitolare boolean DEFAULT false NOT NULL,
    creato_il timestamptz DEFAULT now()
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

/**
 * PR 2: le tabelle che la PR 2 tocca e che la PR 1 non conosce, con le colonne che leggono il registro e la
 * regola transitoria. Va passato a `creaDbAnno({ codaPrima })` PRIMA della migrazione della PR 1, così le
 * tabelle ricevono `anno_id` e il trigger generico. I test della PR 1 NON lo passano.
 * Più i due trigger finti di produzione che muovono `storico_versione` e `updated_at` a ogni UPDATE
 * (`storici_prima_mutazione`, `set_updated_at`), per provare l'interruttore del riempimento.
 */
export const SCHEMA_PR2 = `
  CREATE TABLE public.crm_bambini (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid NOT NULL,
    anno_ingresso text NOT NULL DEFAULT 'in_corso',
    quota_anno integer,
    creata_il timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.votazioni (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid NOT NULL,
    creata_il timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.scrutinio_periodi (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid NOT NULL,
    anno_scolastico text,
    creato_il timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.certificati_competenze (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid NOT NULL,
    anno_scolastico text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.iscrizioni_elenco_caricamenti (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid NOT NULL,
    caricato_il timestamptz NOT NULL DEFAULT now()
  );

  ALTER TABLE public.enrollment_submissions ADD COLUMN storico_versione integer NOT NULL DEFAULT 0;
  CREATE FUNCTION public.storici_prima_mutazione() RETURNS trigger LANGUAGE plpgsql AS $f$
  BEGIN NEW.storico_versione := OLD.storico_versione + 1; RETURN NEW; END $f$;
  CREATE TRIGGER storici_prima_mutazione BEFORE UPDATE ON public.enrollment_submissions
    FOR EACH ROW EXECUTE FUNCTION public.storici_prima_mutazione();
  CREATE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $f$
  BEGIN NEW.updated_at := OLD.updated_at + interval '1 second'; RETURN NEW; END $f$;
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.enrollment_submissions
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

  -- il browser scrive la domanda sotto RLS: una policy aperta, perché il test come authenticated (R13)
  -- abbia qualcosa da attraversare
  ALTER TABLE public.enrollment_submissions ENABLE ROW LEVEL SECURITY;
  CREATE POLICY enrollment_aperta ON public.enrollment_submissions FOR ALL TO authenticated USING (true) WITH CHECK (true);
`

/**
 * PR 2, compito 2.2: le tabelle del riempimento. Va passato DOPO `SCHEMA_PR2` (usa le sue funzioni finte
 * `storici_prima_mutazione` e `set_updated_at`) e PRIMA della migrazione della PR 1. Aggiunge le colonne di
 * `alunni` che la frequenza copia, le tabelle grandi (`eventi_diario`…), i trigger finti di bookkeeping
 * (`storico_versione`, `updated_at`) e una scatola nera finta che CONTA le righe (e rispetta l'interruttore
 * `scatola_nera.senza_storico` come la vera). Solo dati finti.
 */
export const SCHEMA_PR2_RIEMPIMENTO = `
  ALTER TABLE public.alunni
    ADD COLUMN archiviato_il timestamptz,
    ADD COLUMN importo_retta_mensile numeric(10,2) DEFAULT 0,
    ADD COLUMN retta_a_carico_di uuid,
    ADD COLUMN retta_split_config jsonb,
    ADD COLUMN intestatario_fatture jsonb,
    ADD COLUMN giorno_scadenza_pagamenti integer,
    ADD COLUMN gruppo_mensa_id uuid,
    ADD COLUMN sospeso boolean NOT NULL DEFAULT false,
    ADD COLUMN sospeso_causa text,
    ADD COLUMN sospeso_motivo text,
    ADD COLUMN sospeso_il timestamptz,
    ADD COLUMN sospeso_da uuid;

  CREATE TABLE public.admin_settings (
    scuola_id uuid PRIMARY KEY,
    retta_default_importo numeric(10,2) DEFAULT 150
  );
  CREATE TABLE public.alunni_classi_storico (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alunno_id uuid NOT NULL,
    scuola_id uuid,
    dal date NOT NULL,
    al date
  );
  CREATE TABLE public.eventi_diario (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alunno_id uuid,
    orario_inizio timestamptz NOT NULL,
    creato_il timestamptz DEFAULT now(),
    storico_versione integer NOT NULL DEFAULT 0
  );
  CREATE TABLE public.mensa_prenotazioni (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid NOT NULL,
    data date NOT NULL,
    creato_il timestamptz DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.galleria_media_v2 (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid,
    giorno_competenza date,
    created_at timestamptz DEFAULT now(),
    target_classes text[],
    politica_operazione jsonb
  );
  CREATE TABLE public.gallery_photo_uploads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    media_id uuid NOT NULL REFERENCES public.galleria_media_v2(id) ON DELETE CASCADE
  );
  CREATE TABLE public.video_intents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid,
    giorno_competenza date,
    created_at timestamptz DEFAULT now(),
    classi_destinatarie text[]
  );
  CREATE TABLE public.avvisi_risposte (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    avviso_id uuid NOT NULL REFERENCES public.avvisi(id) ON DELETE CASCADE,
    parent_id uuid NOT NULL DEFAULT gen_random_uuid(),
    student_id uuid NOT NULL DEFAULT gen_random_uuid()
  );
  CREATE TABLE public.iscrizioni_decisioni (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id uuid NOT NULL REFERENCES public.enrollment_submissions(id) ON DELETE CASCADE,
    decisa_il timestamptz DEFAULT now()
  );
  CREATE TABLE public.news_posts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid NOT NULL,
    target_classes text[]
  );
  CREATE TABLE public.forms_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid NOT NULL,
    target_classes text[] DEFAULT '{}'
  );
  CREATE TABLE public.mensa_class_menu_assignment (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scuola_id uuid NOT NULL,
    classe text NOT NULL,
    attivo_dal date NOT NULL DEFAULT DATE '2026-09-01'
  );
  INSERT INTO public.payment_categories (scuola_id, nome, slug) VALUES (NULL, 'Retta', 'retta');
  ALTER TABLE public.crm_bambini ADD COLUMN quota_pagamento_id uuid;
  ALTER TABLE public.presenze ADD COLUMN stato text;

  -- il bookkeeping di produzione: la versione di concorrenza e la data di modifica si muovono a OGNI UPDATE
  ALTER TABLE public.presenze ADD COLUMN storico_versione integer NOT NULL DEFAULT 0;
  CREATE TRIGGER storici_prima_mutazione BEFORE UPDATE ON public.presenze
    FOR EACH ROW EXECUTE FUNCTION public.storici_prima_mutazione();
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.mensa_prenotazioni
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

  -- la scatola nera finta: copia il «com'era» di ogni riga toccata, salvo l'interruttore del riempimento
  CREATE FUNCTION scatola_nera.registra_modifica() RETURNS trigger LANGUAGE plpgsql AS $f$
  BEGIN
    IF current_setting('scatola_nera.senza_storico', true) = 'on' THEN RETURN NULL; END IF;
    INSERT INTO scatola_nera.modifiche (tabella, riga_id, prima, cambiate, ruolo)
    SELECT TG_TABLE_NAME, v.id::text, to_jsonb(v), ARRAY[]::text[], current_user FROM vecchie v;
    RETURN NULL;
  END $f$;
  -- madre e figlia con l'aggregato VERO di produzione (20261015183200_storici_versioni): quando si aggiorna una
  -- ricezione, un AFTER fa \`UPDATE note_disciplinari SET storico_versione = storico_versione\`, che alza la
  -- versione della nota. Nomi di colonna e di trigger come in produzione (il nome decide l'ordine dei BEFORE).
  CREATE TABLE public.note_disciplinari (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alunno_id uuid,
    data_evento date,
    creato_il timestamptz DEFAULT now(),
    storico_versione bigint NOT NULL DEFAULT 0
  );
  CREATE TABLE public.nota_ricezioni (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nota_id uuid NOT NULL REFERENCES public.note_disciplinari(id) ON DELETE CASCADE,
    firmato_il timestamptz,
    storico_versione bigint NOT NULL DEFAULT 0
  );
  CREATE TRIGGER storici_prima_mutazione BEFORE UPDATE ON public.note_disciplinari
    FOR EACH ROW EXECUTE FUNCTION public.storici_prima_mutazione();
  CREATE TRIGGER storici_prima_mutazione BEFORE UPDATE ON public.nota_ricezioni
    FOR EACH ROW EXECUTE FUNCTION public.storici_prima_mutazione();
  CREATE FUNCTION public.storici_versione_aggregato() RETURNS trigger LANGUAGE plpgsql AS $f$
  DECLARE vecchia jsonb; nuova jsonb; chiave uuid;
  BEGIN
    IF TG_OP <> 'INSERT' THEN vecchia := to_jsonb(OLD); END IF;
    IF TG_OP <> 'DELETE' THEN nuova := to_jsonb(NEW); END IF;
    IF TG_TABLE_NAME = 'nota_ricezioni' THEN
      FOR chiave IN SELECT DISTINCT x::uuid FROM (VALUES (vecchia->>'nota_id'), (nuova->>'nota_id')) v(x) WHERE x IS NOT NULL LOOP
        UPDATE public.note_disciplinari SET storico_versione = storico_versione WHERE id = chiave;
      END LOOP;
    END IF;
    RETURN NULL;
  END $f$;
  CREATE TRIGGER storici_versione_aggregato AFTER INSERT OR UPDATE OR DELETE ON public.nota_ricezioni
    FOR EACH ROW EXECUTE FUNCTION public.storici_versione_aggregato();

  CREATE TRIGGER scatola_nera_modifiche AFTER UPDATE ON public.presenze
    REFERENCING OLD TABLE AS vecchie FOR EACH STATEMENT EXECUTE FUNCTION scatola_nera.registra_modifica();
  CREATE TRIGGER scatola_nera_modifiche AFTER UPDATE ON public.pagamenti
    REFERENCING OLD TABLE AS vecchie FOR EACH STATEMENT EXECUTE FUNCTION scatola_nera.registra_modifica();
`

/** Le migrazioni della PR 2, trovate per suffisso come `fileMigrazioneAnno` (la version è l'istante di creazione). */
const SUFFISSI_PR2 = {
  M1: '_anno_strumenti.sql',
  // F2 e F3 (le tre tabelle grandi) si sono fuse in F1: il banco ha dato meno di 15 s (compito 2.2).
  F1: '_anno_riempimento_1.sql',
  V1: '_anno_vincoli_1.sql',
  // Correzione del 07/11: `gallery_photo_uploads` esce dal registro. Sta FRA V1 e V2 (la sua version è scelta apposta).
  FOTO: '_anno_foto_anti_doppione_fuori_registro.sql',
  V2: '_anno_vincoli_2.sql',
  // PR 3: la regola di scrittura (gettoni, osservazione, esenzioni, oblio). Dopo V2.
  M3: '_anno_scrittura.sql',
  // PR 4.2: il conteggio selettivo per sede, la regola della scadenza e le impostazioni di sede. Dopo M3.
  M42: '_anno_impostazioni_sede.sql',
  // PR 4.3: sezioni e docenti per anno, fase B dello specchio. Dopo M42 (i compiti successivi aggiungono sezioni in coda al file).
  M43: '_anno_sezioni_docenti_fase_b.sql',
  // PR 4.4: le funzioni di visibilità del genitore (inerti: nessuna policy). Dopo M43 (i compiti successivi aggiungono sezioni in coda al file).
  M44a: '_anno_visibilita_genitore_funzioni.sql',
} as const

/**
 * PR 4.4 · Le tre tabelle dei legami genitore-figlio, con le chiavi e l'indice veri di produzione e le sole colonne che
 * contano. NON stanno in `SCHEMA_BASE`, perché le funzioni le trovano con `to_regclass` e il banco senza va provato: chi
 * le vuole le esegue dopo `creaDbAnnoPr2`.
 */
export const SCHEMA_LEGAMI_GENITORE = `
  CREATE TABLE public.legame_genitori_alunni (
    genitore_id uuid NOT NULL,
    alunno_id uuid NOT NULL,
    PRIMARY KEY (genitore_id, alunno_id)
  );
  CREATE TABLE public.parents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id uuid UNIQUE
  );
  CREATE TABLE public.student_parents (
    student_id uuid NOT NULL,
    parent_id uuid NOT NULL,
    PRIMARY KEY (student_id, parent_id)
  );
  CREATE INDEX idx_student_parents_parent_id ON public.student_parents (parent_id);
`

/**
 * PR 4.4 · La galleria e lo storico delle classi: le colonne che la visibilità del genitore legge, con i tipi, i default e
 * gli indici veri di produzione. Va nella `codaPrima` di `creaDbAnnoPr2`, così il registro li trova come in produzione:
 * `anno_id`, `target_section_ids` e i trigger li aggiungono le migrazioni. Non si passa insieme a `completo`, che ha una sua
 * galleria più povera. Chi prova la funzione senza queste tabelle semplicemente non la passa.
 */
export const SCHEMA_GALLERIA_GENITORE = `
  CREATE TABLE public.galleria_media_v2 (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    scuola_id uuid,
    tag_students uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    is_broadcast boolean DEFAULT false,
    target_classes text[],
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    giorno_competenza date,
    politica_operazione jsonb,
    eliminato_il timestamptz
  );
  CREATE INDEX idx_galleria_v2_tag_students ON public.galleria_media_v2 USING gin (tag_students);
  CREATE INDEX idx_galleria_v2_sede_created_attive ON public.galleria_media_v2 (scuola_id, created_at DESC)
    WHERE eliminato_il IS NULL;
  CREATE TABLE public.alunni_classi_storico (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alunno_id uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
    scuola_id uuid NOT NULL REFERENCES public.schools(id),
    section_id uuid NOT NULL,
    section_nome text NOT NULL DEFAULT '',
    dal date NOT NULL,
    al date,
    fonte text NOT NULL CHECK (fonte IN ('attuale', 'presenza', 'staff', 'trasferimento')),
    CHECK (al IS NULL OR al >= dal),
    UNIQUE (alunno_id, scuola_id, section_id, dal, fonte)
  );
  CREATE INDEX alunni_classi_storico_alunno ON public.alunni_classi_storico (alunno_id);
`

/**
 * PR 4.4 · Le colonne che avvisi, chat e voci leggono e che il banco minimo non ha, con i tipi e i vincoli veri di
 * produzione. `scadenza_avviso` è `NOT NULL` come lì. Si esegue dopo `creaDbAnnoPr2`, come `SCHEMA_LEGAMI_GENITORE`: i test
 * che non la passano restano sul banco di prima.
 */
export const SCHEMA_AVVISI_CHAT_VOCI_GENITORE = `
  ALTER TABLE public.avvisi
    ADD COLUMN target_scope character varying(20) DEFAULT 'globale' NOT NULL,
    ADD COLUMN scadenza date,
    ADD COLUMN scadenza_avviso timestamptz NOT NULL;
  ALTER TABLE public.utenti
    ADD COLUMN ruolo character varying(50),
    ADD COLUMN archiviato_il timestamptz;
  ALTER TABLE public.pagamenti
    ADD COLUMN visibile_dal date,
    ADD COLUMN parent_payment_id uuid REFERENCES public.pagamenti(id) ON DELETE CASCADE;
`

/**
 * 4.2.M · `student_documents` nella forma minima del baseline (l'enum ridotto ai valori che servono). NON sta in
 * `SCHEMA_BASE`, per non cambiare il registro che i test vecchi si aspettano; chi vuole che il registro la veda (e la
 * guardia dell'anno la guardi) la passa nella `codaPrima` di `creaDbAnnoPr2`.
 */
export const SCHEMA_STUDENT_DOCUMENTS = `
  CREATE TYPE public.document_type_enum AS ENUM ('diagnosi', 'pei', '104', 'pdp', 'scheda_sanitaria');
  CREATE TABLE public.student_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    student_id uuid NOT NULL,
    document_type public.document_type_enum NOT NULL,
    file_url text NOT NULL,
    expiry_date date,
    created_at timestamptz DEFAULT now()
  );
`

export async function applicaPr2(db: PGlite, quale: keyof typeof SUFFISSI_PR2): Promise<void> {
  const suffisso = SUFFISSI_PR2[quale]
  // La sezione M della migrazione 4.2 aggiorna `student_documents`: se il banco non l'ha, la crea nuda (senza registro).
  if (quale === 'M42') {
    const c = await db.query<{ t: string | null }>(`SELECT to_regclass('public.student_documents')::text t`)
    if (!c.rows[0].t) await db.exec(SCHEMA_STUDENT_DOCUMENTS)
  }
  const f = readdirSync(CARTELLA).find((x) => x.endsWith(suffisso))
  if (!f) throw new Error(`manca supabase/migrations/*${suffisso}`)
  await db.exec(readFileSync(join(CARTELLA, f), 'utf8'))
}

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
 * Riporta gli STATI e le date degli anni esistenti a quelli di sempre: sotto il 2026 `chiuso`, 2026/27
 * `corrente`, dal 2027 in su `in_preparazione`. NON crea né toglie anni: da sola non rende il calendario
 * indipendente da oggi (dal 01/09/2028 la migrazione ha creato anche il 2028/29, dal 01/09/2029 manca il
 * 2027/28). Per quello c'è `creaAnniFissi`, che la chiama dopo aver ricreato il calendario.
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
 * Dà alle sedi il calendario di prova, SEMPRE lo stesso qualunque sia il giorno in cui gira il test:
 * 2025/26 `chiuso` e 2026/27 `corrente` (anno attivo); il 2027/28 `in_preparazione` lo aggiunge, quando serve,
 * il test che lo vuole (anno-confine, F2, dbB) e `fissaCalendarioAnni` lo tiene in quello stato.
 *
 * Svuota prima il calendario che la migrazione ha creato per OGGI (come fa `sedeVuota` in
 * `anno-calendario.test.ts`) e lo ricrea con la data fissa: aggiustarlo non basta. Dal 01/09/2028 la
 * migrazione ha già creato anche il 2028/29 (che un test sul «nessun anno successivo» troverebbe), e dal
 * 01/09/2029 manca il 2027/28, per cui `anni_sede_crea_per_sede` urterebbe `CALENDARIO_NON_CONTINUO`.
 * Va chiamata PRIMA di creare righe che puntano agli anni (sezioni, presenze…) e con TUTTE le sedi del db.
 */
export async function creaAnniFissi(db: PGlite, sedi: string[]): Promise<void> {
  await db.exec('DELETE FROM public.anni_sede_stati; DELETE FROM public.anni_sede; DELETE FROM public.anni_scolastici;')
  for (const sede of sedi) await db.query(`SELECT public.anni_sede_crea_per_sede($1, DATE '2026-11-06')`, [sede])
  await fissaCalendarioAnni(db)
}

export interface OpzioniDbPr2 {
  sedi: string[]
  /** Fin dove si applica la catena M1 → F1 → V1 → FOTO → V2 → M3 → M42 → M43 → M44a. */
  fino: keyof typeof SUFFISSI_PR2
  /** Con `SCHEMA_PR2` e `SCHEMA_PR2_RIEMPIMENTO` (le tabelle grandi); senza, solo il banco minimo della PR 1. */
  completo?: boolean
  /** SQL eseguito PRIMA della migrazione della PR 1 (dopo gli schemi della PR 2): tabelle che il registro deve trovare. */
  codaPrima?: string
  dopoM1?: (db: PGlite) => Promise<void>
  dopoF1?: (db: PGlite) => Promise<void>
  dopoV1?: (db: PGlite) => Promise<void>
}

/**
 * Un PGlite con la CATENA della PR 2 applicata fino a `fino`, nell'ordine di produzione. Il calendario è quello
 * fisso di `creaAnniFissi` (2025/26 chiuso, 2026/27 attivo; il 2027/28 lo crea F1). I ganci `dopoM1/F1/V1` servono ai
 * test per scrivere righe «come oggi» fra un file e l'altro (stragglers, righe non riempibili).
 */
export async function creaDbAnnoPr2(o: OpzioniDbPr2): Promise<PGlite> {
  const db = await creaDbAnno({
    sediPrimaDellaMigrazione: o.sedi,
    codaPrima: (o.completo ? SCHEMA_PR2 + SCHEMA_PR2_RIEMPIMENTO : '') + (o.codaPrima ?? ''),
  })
  await creaAnniFissi(db, o.sedi)
  const ordine: Array<keyof typeof SUFFISSI_PR2> = ['M1', 'F1', 'V1', 'FOTO', 'V2', 'M3', 'M42', 'M43', 'M44a']
  const gancio = { M1: o.dopoM1, F1: o.dopoF1, V1: o.dopoV1, FOTO: undefined, V2: undefined, M3: undefined, M42: undefined, M43: undefined, M44a: undefined } as const
  for (const passo of ordine) {
    await applicaPr2(db, passo)
    await gancio[passo]?.(db)
    if (passo === o.fino) break
  }
  return db
}
