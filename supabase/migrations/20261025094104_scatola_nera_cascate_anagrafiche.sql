-- =============================================================================
-- SCATOLA NERA SU CASCATE E ANAGRAFICHE — robustezza, seconda serie, sessione 3
--
-- Problema D4 del rapporto del 20/10 (`docs/analisi-robustezza-2026-10-20.md:486-515`):
-- cancellare un utente, un alunno o un avviso porta via in CASCADE tabelle che la scatola
-- nera della fase 4 non vede, e lo storico delle modifiche della fase 12 non copre le
-- anagrafiche. D7, in parte: la modifica di una nota cancella le prese visione dei genitori
-- (`nota_ricezioni`), fuori dalla scatola.
--
-- ─── COSA FA ─────────────────────────────────────────────────────────────────
--  · `scatola_nera.registra()` rispetta `scatola_nera.senza_storico`, come fa già
--    `registra_modifica()`: una pulizia in blocco DICHIARATA non lascia copie.
--  · Nove figlie in cascata entrano nella scatola delle eliminazioni, con lo stesso
--    trigger e lo stesso divieto di TRUNCATE della fase 4: chat_messages, chat_threads,
--    avvisi, avvisi_risposte, nota_ricezioni, alunni_classi_storico,
--    storici_collegamenti, storici_revisioni, fascicolo_accessi_audit.
--  · Lo storico delle modifiche si allarga ad alunni, parents, utenti,
--    note_disciplinari, certificati_medici. Un UPDATE che cambia SOLO `storico_versione`
--    non si copia, come già `updated_at`: è il «tocco» con cui storici_versione_aggregato
--    segna la nota quando un genitore firma la presa visione, e copierebbe ogni volta il
--    testo intero della nota.
--  · Le due bonifiche che cancellano copie storiche PER PROTEGGERE un dato
--    (`storici_bonifica_chat`, `storici_oblio_alunno`) accendono l'interruttore per le sole
--    proprie DELETE e lo rimettono com'era: una copia di 90 giorni disferebbe la bonifica.
--  · L'oblio (`public.scatola_nera_dimentica`) toglie anche ciò che nomina la persona solo
--    attraverso una conversazione: i messaggi delle sue conversazioni (che la nominano per
--    `thread_id`) e le revisioni di quei messaggi (per `entita_id`), con le conversazioni
--    cancellate (in scatola) o ancora vive. `soggetti_di` legge solo `id` e `*_id`.
--
-- ─── COSA RESTA FUORI, E PERCHÉ ──────────────────────────────────────────────
--  · notifiche, push_subscriptions: effimere (campanella, iscrizioni ai push), con la
--    propria conservazione già dichiarata;
--  · anagrafica_personale, galleria_media_v2, candidature_insegnanti: una retention le
--    svuota per legge, come deciso in fase 4;
--  · utenti_scuole, utenti_sezioni, utenti_sezioni_materie: configurazione d'accesso, si
--    rifà dalla segreteria;
--  · mensa_prenotazioni, mensa_alternative, divise_ordini, armadietto_richieste,
--    task_interni: operative; il valore contabile sta in tabelle già coperte;
--  · storici_generazioni: lavori di stampa che scadono da soli;
--  · registro_destinatari: figlia di alunni non elencata nella specifica (§7); la misura
--    del Passo 0 è nel PRD e la decisione è del titolare;
--  · conversazioni_sospensioni: figlia in CASCADE di chat_threads che gli elenchi del piano
--    non nominano, trovata dalla misura del Passo 0 (25/10). È la prova che una
--    conversazione è stata moderata (policy UGC, `src/lib/alunni/libera-spazio.ts`): se
--    entra lo decide il titolare, e fino ad allora resta fuori, come registro_destinatari;
--  · il registro di protocollo ha la sua migrazione (`*_scatola_nera_protocollo.sql`).
--
-- ─── CORPI DI PARTENZA ───────────────────────────────────────────────────────
-- Le cinque funzioni ridefinite partono da `pg_get_functiondef` letta in produzione il
-- giorno di questa migrazione (Passo 0 del piano
-- `docs/superpowers/plans/2026-10-20-robustezza2-s03-scatola-nera-cascate.md`), uguale ai
-- file 20261009171012, 20261019215733, 20261015183000, 20261019223123. Cambia solo ciò che
-- è scritto sopra.
--
-- ─── FAIL-CLOSED ─────────────────────────────────────────────────────────────
-- Invariato: se la copia non si scrive, fallisce la DELETE o l'UPDATE.
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   select count(*) from pg_trigger where tgname = 'scatola_nera_eliminazioni';   -- 42 + 9 = 51
--   select count(*) from pg_trigger where tgname = 'scatola_nera_modifiche';      -- 13 + 5 = 18
--   select prosrc ~ 'senza_storico' from pg_proc
--    where oid = 'scatola_nera.registra()'::regprocedure;                            -- true
--   select prosrc ~ 'v_collegati' from pg_proc
--    where oid = 'public.scatola_nera_dimentica(uuid[],text,text)'::regprocedure;    -- true
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   do $$ declare t text; begin
--     foreach t in array array['chat_messages','chat_threads','avvisi','avvisi_risposte',
--         'nota_ricezioni','alunni_classi_storico','storici_collegamenti','storici_revisioni',
--         'fascicolo_accessi_audit'] loop
--       execute format('drop trigger if exists scatola_nera_eliminazioni on public.%I', t);
--       execute format('drop trigger if exists scatola_nera_no_truncate on public.%I', t);
--     end loop;
--     foreach t in array array['alunni','parents','utenti','note_disciplinari','certificati_medici'] loop
--       execute format('drop trigger if exists scatola_nera_modifiche on public.%I', t);
--     end loop; end $$;
--   Rieseguire le definizioni di prima: scatola_nera.registra() da
--   20261009171012_scatola_nera_registro_eliminazioni.sql; scatola_nera.registra_modifica() e
--   public.scatola_nera_dimentica da 20261019215733_scatola_nera_modifiche.sql;
--   public.storici_bonifica_chat da 20261015183000_storici_stampe_rettifiche.sql;
--   public.storici_oblio_alunno da 20261019223123_battiti_app_log_che_contano.sql (oppure i
--   corpi di produzione salvati nel Passo 0). Le righe già copiate restano finché non
--   scadono: sono la copia.
-- =============================================================================

-- ── 1. L'interruttore anche sulle eliminazioni ────────────────────────────────
CREATE OR REPLACE FUNCTION scatola_nera.registra()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ruolo   text := COALESCE(NULLIF(current_setting('role', true), 'none'), session_user::text);
  v_utente  uuid;
  v_origine text;
BEGIN
  IF current_setting('scatola_nera.senza_storico', true) = 'on' THEN
    RETURN NULL; -- una pulizia in blocco dichiarata (bonifica, oblio): nessuna copia, di proposito
  END IF;
  BEGIN
    v_utente := NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_utente := NULL; -- claims assenti o non JSON (pg_cron, pannello): nessun utente, non un errore
  END;
  v_origine := left(COALESCE(NULLIF(current_setting('request.path', true), ''),
                             NULLIF(current_setting('application_name', true), ''),
                             'sconosciuta'), 200);

  INSERT INTO scatola_nera.eliminazioni (tabella, riga, soggetti, ruolo, utente, origine)
  SELECT TG_TABLE_NAME, r.riga, scatola_nera.soggetti_di(r.riga), v_ruolo, v_utente, v_origine
    FROM (SELECT to_jsonb(v) AS riga FROM vecchie v) r;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION scatola_nera.registra() FROM PUBLIC, anon, authenticated;
