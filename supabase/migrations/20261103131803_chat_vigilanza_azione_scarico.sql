-- ════════════════════════════════════════════════════════════════════════════
-- VIGILANZA CHAT — il registro ammette anche l'azione «scarico»
-- ════════════════════════════════════════════════════════════════════════════
-- Scritta il 2026-11-03 (foto della chat a tutto schermo, compito 5).
--
-- ─── PERCHE ─────────────────────────────────────────────────────────────────
-- La scheda «Tutti» della pagina Messaggi della segreteria e la supervisione
-- silenziosa delle conversazioni genitore-insegnante: i due interlocutori non
-- vedono niente, e `chat_vigilanza_accessi` e l'UNICO contrappeso (decisione del
-- titolare, 2026-09-09). Dal 2026-11-03 la supervisione puo anche SCARICARE una
-- foto della conversazione, e portarsi via un file e piu grave che leggerlo: lo
-- scarico deve lasciare la sua riga, e deve lasciarla PRIMA che il file parta
-- (`admin/chat/messages/scarico:POST` scrive la riga e solo dopo firma
-- l'indirizzo; se la riga non si scrive il file non esce).
--
-- Il vincolo sulla colonna `azione` ammetteva soltanto `lettura` e `ricerca`:
-- senza questa migrazione la riga `scarico` verrebbe rifiutata (23514) e la
-- route risponderebbe sempre 503. La riga porta thread, operatore, sede e ora:
-- niente colonne nuove, il thread basta (scelta del 2026-11-03).
--
-- ─── COSA FA ────────────────────────────────────────────────────────────────
-- Toglie e rimette il CHECK di `azione` con un valore in piu. Il nome del
-- vincolo e quello letto in produzione il 2026-11-03 con la sola SELECT su
-- `pg_constraint`: `chat_vigilanza_accessi_azione_check`, definizione
-- `CHECK ((azione = ANY (ARRAY['lettura'::text, 'ricerca'::text])))`. L'altro
-- CHECK della tabella, `chat_vigilanza_accessi_esito_check` (`ok`,
-- `fuori-scope`), non si tocca. Le righe esistenti (`lettura`, `ricerca`)
-- restano valide: non si riscrive niente.
--
-- NESSUN `GRANT`: le scritture restano gli INSERT del service_role e il
-- registro resta in sola aggiunta (migrazione `..._sola_aggiunta`).
--
-- IDEMPOTENTE: `DROP CONSTRAINT IF EXISTS` poi `ADD CONSTRAINT`, ripetibile; il
-- `COMMENT` si riscrive uguale.
--
-- La applica l'integrazione GitHub di Supabase al merge, con la version del
-- file: mai a mano.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.chat_vigilanza_accessi
  DROP CONSTRAINT IF EXISTS chat_vigilanza_accessi_azione_check;

ALTER TABLE public.chat_vigilanza_accessi
  ADD CONSTRAINT chat_vigilanza_accessi_azione_check
  CHECK (azione IN ('lettura', 'ricerca', 'scarico'));

COMMENT ON TABLE public.chat_vigilanza_accessi IS
  'Registro in SOLA AGGIUNTA delle letture di vigilanza sulle conversazioni genitore-insegnante. Scritto da admin/chat/messages:GET, admin/chat/messages/scarico:POST e admin/chat/ricerca:GET; letto solo dalla Direzione (admin, coordinator). service_role ha SOLO select+insert: UPDATE/DELETE/TRUNCATE sono stati REVOCATI, non semplicemente non concessi. Nessuna FK: deve sopravvivere all''oblio GDPR e alla cancellazione del thread.';

COMMENT ON COLUMN public.chat_vigilanza_accessi.azione IS
  '«lettura» = ha aperto una conversazione; «ricerca» = ha cercato una parola in tutte le conversazioni della sede; «scarico» = ha scaricato una foto di una conversazione dalla supervisione (la riga e scritta PRIMA che il file parta).';
