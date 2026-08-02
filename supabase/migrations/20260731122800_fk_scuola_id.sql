-- =============================================================================
-- 20260731122800 — Lo SCHEMA difende il tenant: `scuola_id` smette di essere un
--                  uuid libero su 31 tabelle, e la colonna morta viene disarmata
--
-- IL DIFETTO (R103, R100 — audit globale multi-sede del 2026-07-31).
--
-- (1) Su 65 tabelle di `public` con una colonna `scuola_id`, TRENTUNO non avevano
--     nessuna FOREIGN KEY verso le sedi:
--
--       SELECT c.relname FROM pg_class c
--         JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='scuola_id'
--        WHERE c.relkind='r' AND NOT EXISTS (
--              SELECT 1 FROM pg_constraint k
--               WHERE k.contype='f' AND k.conrelid=c.oid AND a.attnum = ANY(k.conkey));
--         → 31 righe (0 orfani: verificato tabella per tabella prima di applicare)
--
--     Su quelle tabelle il database accettava QUALUNQUE uuid, anche uno che non
--     corrisponde a nessuna sede. Una riga così non appartiene a nessun plesso e
--     diventa invisibile a ogni `.in('scuola_id', plessi)` — che è ormai il modo in
--     cui filtrano decine di query del repo. Non è una fuga: è una SPARIZIONE
--     silenziosa, senza errore e senza log. E riguardava tabelle con valore
--     probatorio: `fatture_emesse`, `ricevute_emesse`, `pagamenti_transazioni`,
--     `riconciliazione_movimenti`.
--
--     Le FK erano state messe sul nucleo (alunni, utenti, sections, presenze,
--     registro_orario) e poi omesse via via che il perimetro cresceva, una alla
--     volta, ognuna con una buona ragione per rimandare. Da qui il lock
--     `__tests__/architecture/fk-scuola-id.test.ts`: la regola che mancava.
--
-- (2) Su `alunni` convivono due colonne per lo stesso dato — `codice_fiscale`
--     (14 valori su 30) e `fiscal_code` (ZERO su 30, residuo della doppia
--     nomenclatura italiano/inglese che attraversa lo schema) — ed ENTRAMBE
--     avevano un UNIQUE globale. Due chiavi di deduplica per lo stesso dato, di
--     cui una su una colonna morta, sono la premessa di una futura scrittura sulla
--     colonna sbagliata che non incrocerebbe MAI la deduplica dell'altra: due
--     anagrafiche per lo stesso minore, e il pre-flight cross-sede di
--     `admin/iscrizioni` (che guarda `codice_fiscale`) che non se ne accorge.
--
-- PERCHÉ `schools` E NON `scuole`. Il repo trascina due tabelle delle sedi con gli
-- stessi 4 id. Tutte le FK storiche puntano a `schools`, e da `schools` legge il
-- trigger ETL: usare l'altra qui aggiungerebbe una terza sorgente di verità: è
-- esattamente il meccanismo che ha reso invisibile il difetto del trigger ETL.
-- Le quattro FK che oggi puntano a `scuole` (cassa_* e news_categorie) restano dove
-- sono — unificarle è una migrazione a sé — ma sono CONGELATE nell'allowlist del lock.
--
-- PERCHÉ SENZA `ON DELETE`. Default NO ACTION, come `alunni_scuola_id_fkey` e
-- `pagamenti_scuola_id_fkey`. Non esiste nessuna rotta che cancelli una sede
-- (`admin/schools` espone GET/POST/PATCH, non DELETE) e la direzione sicura è che
-- una sede NON sia cancellabile finché ha dati: un CASCADE su `fatture_emesse` o
-- `ricevute_emesse` cancellerebbe documenti con valore probatorio.
--
-- PERCHÉ ANCHE 10 INDICI. Una FK senza indice sulla colonna referenziante è un
-- rilievo del linter Supabase (`unindexed_foreign_keys`), e su queste tabelle
-- `scuola_id` è già oggi la colonna di filtro più usata. 21 delle 31 avevano già un
-- indice che comincia con `scuola_id`; le altre 10 lo ricevono qui.
--
-- PERCHÉ LA COLONNA `fiscal_code` RESTA (per ora). Expand/contract. Il piano
-- prevedeva il DROP COLUMN «dopo grep di zero usi»: il grep NON dà zero. Sette punti
-- la leggono ancora, tutti come ripiego `codice_fiscale ?? fiscal_code`:
--
--   src/app/api/admin/students/route.ts:381            (elenco colonne della lista)
--   src/app/api/admin/gdpr/erase/route.ts:43,153
--   src/app/api/admin/gdpr/richieste/route.ts:137,143
--   src/app/api/pagamenti/riconciliazione/route.ts:193,220,230
--   src/lib/gdpr/esegui.ts:35,151
--   src/app/(dashboard)/admin/students/page.tsx:26,164,282     ← file di un altro step
--   src/components/features/admin/StudentDetailPanel.tsx:38    ← file di un altro step
--   (+ la scrittura `fiscal_code: null` di src/lib/gdpr/anonimizza.ts:22, che il
--    CHECK accetta ma che dopo il DROP diventerebbe PGRST204 sull'OBLIO)
--
-- Droppare la colonna adesso vorrebbe dire rispondere 42703 al codice ATTUALMENTE
-- deployato — e in `pagamenti/riconciliazione` il ramo di degradazione su 42703
-- butta via anche `codice_fiscale`, spegnendo in SILENZIO l'abbinamento per codice
-- fiscale dell'estratto conto. Esattamente il tipo di guasto muto che questo audit
-- esiste per eliminare.
--
-- Nel frattempo il CHECK neutralizza la colonna in modo RUMOROSO: una scrittura
-- sulla colonna sbagliata FALLISCE invece di riuscire di nascosto scavalcando la
-- deduplica di `codice_fiscale`. Il pericolo di R100 è chiuso oggi; la rimozione
-- della colonna è il passo di contract da eseguire DOPO il deploy che toglie le
-- sette letture qui sopra:
--
--   ALTER TABLE public.alunni DROP CONSTRAINT alunni_fiscal_code_dismessa;
--   ALTER TABLE public.alunni DROP COLUMN fiscal_code;
--
-- (il lock `fk-scuola-id.test.ts` smette da solo di pretendere il CHECK quando la
--  colonna non c'è più: il ramo è già scritto).
--
-- IDEMPOTENTE: ogni ALTER è dentro un `IF NOT EXISTS` su pg_constraint,
-- `CREATE INDEX IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`.
--
-- NB per la CI: il database E2E non è migrato. Qui non nasce nessuna colonna nuova
-- e nessuna colonna sparisce, quindi il codice applicativo non incontra né PGRST204
-- né 42703: là mancheranno solo i vincoli.
-- =============================================================================

-- 1) Le 31 FOREIGN KEY -------------------------------------------------------
DO $$
DECLARE
  t text;
  -- L'elenco è esplicito di proposito: una FK si aggiunge leggendo il nome della
  -- tabella, non lasciando che un ciclo la scopra da solo. Chi rilegge questa
  -- migrazione fra un anno deve vedere QUALI tabelle sono state legate alle sedi.
  tabelle text[] := ARRAY[
    'app_log', 'certificati_competenze', 'conversazioni_sospensioni', 'crediti_famiglia',
    'divise_articoli', 'divise_ordini', 'enrollment_submissions', 'fatture_emesse',
    'fatture_numerazione', 'forms_templates', 'galleria_media_v2', 'gruppi_mensa',
    'mensa_alternative', 'mensa_ticket_movimenti', 'merch_fornitori',
    'merch_ordini_fornitore', 'merch_po_numerazione', 'merch_rettifiche',
    'news_digest_edizioni', 'news_posts', 'pagamenti_transazioni',
    'protocolli_numerazione', 'ricevute_emesse', 'ricevute_numerazione',
    'richieste_cancellazione', 'riconciliazione_import', 'riconciliazione_movimenti',
    'segnalazioni', 'sidi_import_batches', 'sidi_sync_state', 'solleciti'
  ];
BEGIN
  FOREACH t IN ARRAY tabelle LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = format('public.%I', t)::regclass
         AND conname  = t || '_scuola_id_fkey'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (scuola_id) REFERENCES public.schools(id)',
        t, t || '_scuola_id_fkey'
      );
    END IF;
  END LOOP;
END $$;

-- 2) Gli indici mancanti sulle colonne appena vincolate ----------------------
-- Solo le 10 che non avevano già un indice che comincia con `scuola_id`.
CREATE INDEX IF NOT EXISTS idx_app_log_scuola                   ON public.app_log (scuola_id);
CREATE INDEX IF NOT EXISTS idx_certificati_competenze_scuola    ON public.certificati_competenze (scuola_id);
CREATE INDEX IF NOT EXISTS idx_conversazioni_sospensioni_scuola ON public.conversazioni_sospensioni (scuola_id);
CREATE INDEX IF NOT EXISTS idx_crediti_famiglia_scuola          ON public.crediti_famiglia (scuola_id);
CREATE INDEX IF NOT EXISTS idx_enrollment_submissions_scuola    ON public.enrollment_submissions (scuola_id);
CREATE INDEX IF NOT EXISTS idx_mensa_ticket_movimenti_scuola    ON public.mensa_ticket_movimenti (scuola_id);
CREATE INDEX IF NOT EXISTS idx_richieste_cancellazione_scuola   ON public.richieste_cancellazione (scuola_id);
CREATE INDEX IF NOT EXISTS idx_riconciliazione_import_scuola    ON public.riconciliazione_import (scuola_id);
CREATE INDEX IF NOT EXISTS idx_riconciliazione_movimenti_scuola ON public.riconciliazione_movimenti (scuola_id);
CREATE INDEX IF NOT EXISTS idx_sidi_import_batches_scuola       ON public.sidi_import_batches (scuola_id);

-- 3) La colonna morta di `alunni` --------------------------------------------
-- Via il doppione: l'unicità del codice fiscale del minore vive su
-- `alunni_codice_fiscale_key`, che RESTA (impedisce la doppia iscrizione dello
-- stesso bambino in due sedi; il trasferimento, che è un UPDATE di `scuola_id`,
-- continua a funzionare perché non tocca il CF).
ALTER TABLE public.alunni DROP CONSTRAINT IF EXISTS alunni_fiscal_code_key;

-- E la colonna resta, ma disarmata: non è più scrivibile. 30 righe su 30 hanno già
-- `fiscal_code IS NULL`, quindi il vincolo si valida senza bonifica.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.alunni'::regclass AND attname = 'fiscal_code'
       AND attnum > 0 AND NOT attisdropped
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.alunni'::regclass AND conname = 'alunni_fiscal_code_dismessa'
  ) THEN
    ALTER TABLE public.alunni
      ADD CONSTRAINT alunni_fiscal_code_dismessa CHECK (fiscal_code IS NULL);
  END IF;
END $$;

COMMENT ON COLUMN public.alunni.fiscal_code IS
  'DISMESSA (2026-07-31, R100): doppione inglese di `codice_fiscale`, mai valorizzata. Il CHECK alunni_fiscal_code_dismessa ne impedisce la scrittura. DROP COLUMN da eseguire dopo il deploy che toglie le ultime letture (lista alunni del cockpit, StudentDetailPanel).';
