-- =============================================================================
-- 20260815200244 — I tredici prestampati entrano in `document_type_enum`
--
-- ✅ APPLICATA il 2026-08-15, version 20260815200244.
--
-- ⚠️ QUESTO FILE È STATO RICOSTRUITO IL 2026-08-17, e il motivo è più importante
--    del suo contenuto.
--
--    La migrazione era stata applicata in produzione con `apply_migration` senza
--    che nessuno scrivesse il file corrispondente nel repository: il database
--    aveva la riga, la cartella no. Per due giorni nessun lock l'ha vista,
--    perché `__tests__/fixtures/migrazioni-applicate-snapshot.json` era ferma al
--    2026-08-12 — e una fotografia scaduta non è una prova mancante, è una prova
--    che dice di sì. Il difetto è emerso solo rigenerandola.
--
--    Lo statement qui sotto NON è stato riscritto a mano: è quello vero, ripreso
--    da `supabase_migrations.schema_migrations.statements`. Riscriverlo «come
--    doveva essere» avrebbe prodotto un file plausibile e diverso da ciò che il
--    database ha davvero eseguito, cioè la stessa bugia con una faccia più
--    presentabile.
--
-- ─── COSA FA ────────────────────────────────────────────────────────────────
-- Estende `document_type_enum` ai 13 prestampati che si archiviano nel
-- fascicolo. Prima l'enumerato aveva QUATTRO valori (diagnosi, pei, 104, pdp) e
-- nessuno dei prestampati ci stava dentro: il 100% delle firme del genitore
-- falliva con `22P02` e il PDF restava orfano nel bucket `sensitive_documents`.
--
-- Solo `ADD VALUE`: nessuna riga letta, nessuna riga scritta, nessuna colonna
-- riscritta. Non tocca un solo dato esistente.
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
-- Non esiste: un valore aggiunto a un enum di Postgres non si toglie più.
-- =============================================================================

-- Estende document_type_enum ai 13 prestampati che si archiviano nel fascicolo.
-- Oggi l'enumerato ha 4 valori (diagnosi, pei, 104, pdp) e NESSUNO dei prestampati
-- ci sta dentro: il 100% delle firme del genitore fallisce con 22P02 e il PDF resta
-- orfano nel bucket sensitive_documents. Questa e' la riparazione alla radice.
--
-- Solo ADD VALUE: nessuna riga letta, nessuna riga scritta, nessuna colonna riscritta.
-- Non tocca un solo dato esistente. Un valore aggiunto a un enum non si toglie piu'.

ALTER TYPE document_type_enum ADD VALUE IF NOT EXISTS 'scheda_sanitaria';
ALTER TYPE document_type_enum ADD VALUE IF NOT EXISTS 'autorizzazione_farmaci';
ALTER TYPE document_type_enum ADD VALUE IF NOT EXISTS 'dieta_speciale';
ALTER TYPE document_type_enum ADD VALUE IF NOT EXISTS 'delega_ritiro';
ALTER TYPE document_type_enum ADD VALUE IF NOT EXISTS 'permesso_orario';
ALTER TYPE document_type_enum ADD VALUE IF NOT EXISTS 'autorizzazione_uscita';
ALTER TYPE document_type_enum ADD VALUE IF NOT EXISTS 'certificato_iscrizione_frequenza';
ALTER TYPE document_type_enum ADD VALUE IF NOT EXISTS 'certificato_bonus_nido';
ALTER TYPE document_type_enum ADD VALUE IF NOT EXISTS 'nulla_osta';
ALTER TYPE document_type_enum ADD VALUE IF NOT EXISTS 'verbale_infortunio';
ALTER TYPE document_type_enum ADD VALUE IF NOT EXISTS 'valutazione_infanzia';
ALTER TYPE document_type_enum ADD VALUE IF NOT EXISTS 'certificato_competenze';
ALTER TYPE document_type_enum ADD VALUE IF NOT EXISTS 'registro_presenze';
