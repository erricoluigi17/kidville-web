-- ═══════════════════════════════════════════════════════════════════════════════
-- Le funzioni di `public` non si eseguono con la chiave pubblica
-- Collaudo del 2026-08-03, rilievo T04-F1.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- IL FATTO, misurato (non dedotto) sul database di produzione il 2026-08-03:
-- il ruolo `anon` — quello della chiave pubblica, che sta nel bundle servito al
-- browser — poteva eseguire 14 funzioni dello schema `public`: 6 chiamabili via
-- RPC e 8 funzioni di trigger. Lo stesso valeva per `authenticated`.
--
-- ─── LA TRAPPOLA, E PERCHÉ QUESTA MIGRAZIONE REVOCA DA `PUBLIC` ──────────────
--
-- La prima stesura revocava `FROM anon, authenticated`. È stata APPLICATA, ha
-- risposto `success`, e NON HA CAMBIATO NIENTE: la verifica successiva trovava i
-- permessi esattamente dov'erano.
--
-- Il perché sta nell'ACL vera di queste funzioni:
--     {=X/postgres, postgres=X/postgres, service_role=X/postgres}
-- La voce `=X` — senza nessun ruolo prima dell'uguale — è **PUBLIC**. Non è mai
-- esistito un grant esplicito ad `anon` o `authenticated`: quei ruoli ereditano da
-- PUBLIC. Un `REVOKE ... FROM anon` toglie un permesso che non c'è, riesce senza
-- errori, e lascia intatto quello vero.
--
-- Vale la pena scriverlo perché è la stessa forma di guasto che questo collaudo ha
-- trovato ovunque: un'operazione che dichiara successo senza aver fatto niente —
-- la bonifica dei log che contava i file selezionati invece di quelli cambiati, la
-- push marcata «inviata» senza essere partita, `esegui.sh` che non lanciava mai un
-- flow. Qui a smascherarla è stata la rilettura dei permessi DOPO l'applicazione:
-- senza quella, il rilievo sarebbe risultato chiuso restando aperto.
--
-- I grant non li ha scritti nessuno di proposito: arrivano dal dump di baseline
-- (`20260704120000_baseline.sql`), dove `pg_dump` riporta i default di PostgreSQL —
-- `EXECUTE` è concesso a PUBLIC salvo revoca esplicita. È il modo in cui un
-- permesso entra in un database senza che nessuno lo decida.
--
-- ─── LA GRAVITÀ VERA, che è più bassa di come è stata scritta ─────────────────
--
-- Il rilievo diceva «una che scrive su pagamenti/notifiche e chiama net.http_post».
-- È vero che `genera_solleciti()` fa quelle cose. Ma NESSUNA delle funzioni
-- interessate è `SECURITY DEFINER`: girano con i privilegi di CHI CHIAMA, quindi la
-- RLS continua ad applicarsi e un `anon` non guadagna accessi che non abbia già.
-- Il rilievo va corretto su questo punto invece di essere ripetuto: dirlo più grave
-- di com'è non rende il database più sicuro, rende meno credibile il prossimo.
--
-- Resta da chiudere per due ragioni che valgono da sole:
--  · è superficie inutile. `genera_solleciti()` è DEPRECATA — l'ha sostituita
--    `src/app/api/pagamenti/solleciti/run/route.ts` — e nessuna delle sei è mai
--    chiamata con la chiave pubblica;
--  · un permesso che nessuno ha deciso è un permesso che nessuno rivede. Il giorno
--    in cui una di queste diventasse `SECURITY DEFINER`, il grant sarebbe già lì.
--
-- ─── PERCHÉ NON ROMPE NIENTE (verificato PRIMA di applicare) ─────────────────
--
-- Le uniche due invocate dall'applicazione sono `ricalcola_stato_pagamento` e
-- `ricalcola_stato_padre`, da quattro route (`pagamenti/[id]`, `.../sconto`,
-- `pagamenti/incassi`, `.../storno`): tutte e quattro costruiscono il client con
-- `createAdminClient()`, cioè `service_role`, che ha un grant ESPLICITO e non passa
-- da PUBLIC. Le altre quattro non sono chiamate da nessuna parte del codice.
--
-- Le funzioni di TRIGGER restano eseguibili da `service_role`, ed è l'unico ruolo
-- che serve: in questa applicazione NESSUNA scrittura su tabella passa dal client
-- del browser (verificato: `browser-client` è usato solo per auth, realtime e
-- letture). Tutte le scritture passano dalle route API con `createAdminClient()`.
--
-- ─── COSA NON SI TOCCA, ED È IMPORTANTE ──────────────────────────────────────
--
-- `public.current_parent_student_ids()` resta eseguibile da `authenticated`. È
-- `SECURITY DEFINER` ed è usata DENTRO le policy RLS per stabilire quali alunni
-- appartengono al genitore collegato: revocarla chiuderebbe fuori ogni genitore
-- dalla propria area. La sua ACL non ha nessuna voce PUBLIC
-- (`{postgres=X, authenticated=X, service_role=X}`): era già ristretta di proposito.
--
-- ─── COME SI TORNA INDIETRO ──────────────────────────────────────────────────
--
--   GRANT EXECUTE ON FUNCTION public.<nome>(<argomenti>) TO PUBLIC;
--
-- Nessun dato viene modificato: cambia solo chi può eseguire che cosa, ed è
-- interamente reversibile.
--
-- APPLICATA in produzione il 2026-08-03. Verifica dopo l'applicazione:
--   anon/authenticated → nessun EXECUTE su tutte e 14;
--   service_role       → EXECUTE su tutte e 14;
--   authenticated      → EXECUTE su `current_parent_student_ids` (intatto).
-- `get_advisors(security)` → 0 ERROR.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Le 6 chiamabili via RPC ──────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.calc_form_base_score(jsonb, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.calc_manual_delta(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.crea_quote_da_config(uuid, uuid, numeric, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.genera_solleciti() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ricalcola_stato_padre(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ricalcola_stato_pagamento(uuid) FROM PUBLIC;

-- ── Le 8 funzioni di trigger ─────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.fn_form_submission_score() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_updated_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_alunno_section_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.trg_incassi_ricalcola() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.worm_fatture_emesse() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.worm_protocolli() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.worm_protocolli_allegati() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.worm_ricevute_emesse() FROM PUBLIC;

-- `public.current_parent_student_ids()` NON compare qui di proposito: vedi sopra.

NOTIFY pgrst, 'reload schema';
