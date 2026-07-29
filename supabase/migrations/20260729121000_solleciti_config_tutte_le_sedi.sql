-- =============================================================================
-- 20260729121000 — A4 · I solleciti non sono più una cosa della sola Giugliano
-- =============================================================================
-- IL DIFETTO. 20260718400000_pagamenti_solleciti_cron.sql accende la
-- schedulazione dei solleciti per UNA sede sola, per uuid cablato:
--
--   UPDATE public.admin_settings SET solleciti_config = … || '{"enabled": true}'
--    WHERE scuola_id = 'd53b0fbc-…'   -- Kidville Giugliano
--
-- Il cron (`pagamenti-solleciti-run`, 06:00 UTC) è invece globale: bussa alla
-- route, che seleziona le sedi con `solleciti_config.enabled`. Risultato: una
-- sede NUOVA — Aversa, Cesa — non eredita nulla, e il suo `solleciti_config`
-- resta `'{}'`: né acceso né spento, semplicemente non deciso. Una configurazione
-- che dipende da un uuid scritto a mano in una migrazione è un difetto che si
-- ripresenta a ogni sede.
--
-- LA CORREZIONE, in due punti:
--
--  1. SEDI FUTURE — il default entra nel provisioning: `provisiona_sede` crea la
--     riga `admin_settings` con `solleciti_config = {"enabled": false}`
--     (20260729120000). Nessun uuid, nessuna migrazione da ricordarsi.
--
--  2. SEDI PRESENTI — questa migrazione lavora per INSIEME, su tutte le sedi
--     esistenti, senza nominarne nessuna.
--
-- PERCHÉ SPENTI DI DEFAULT, ed è una scelta, non un effetto collaterale.
-- I solleciti mandano email di morosità a famiglie vere. Una sede appena creata
-- sta ancora importando anagrafiche e pagamenti, e `retta_auto_enabled` è true per
-- default: le prime rette nascono con scadenze anche retrodatate. Accendere il
-- cron al momento del provisioning significa, al primo giro delle 06:00, spedire
-- solleciti per debiti che sono solo un artefatto dell'import — a Giugliano il
-- primo livello scatta a 1 giorno dalla scadenza, quindi partirebbero subito e
-- tutti insieme. Un'email spedita non si richiama; una spunta in
-- Impostazioni → Solleciti («Cron attivo») si mette in due secondi, quando i dati
-- sono verificati. È anche la posizione già presa dal codice:
-- `DEFAULT_SOLLECITI_CONFIG.enabled = false` (src/lib/pagamenti/solleciti.ts) e
-- il commento di POST /api/pagamenti/solleciti/run («SOLO per le scuole con
-- solleciti_config.enabled — default off»).
--
-- ⚠️ CONSEGUENZA OPERATIVA: Kidville Aversa e Kidville Cesa nascono con i solleciti
-- automatici SPENTI. Vanno accesi a mano da Impostazioni → Solleciti quando
-- anagrafiche e pagamenti della sede sono stati verificati.
--
-- Additiva e idempotente: nessuna riga esistente perde configurazione, e chi ha
-- già deciso (Giugliano: enabled = true) non viene toccato.
-- =============================================================================

-- Merge NON distruttivo su TUTTE le sedi che non hanno ancora deciso: la chiave
-- `enabled` viene resa esplicita a false. `jsonb_build_object(...) || existing`
-- mette il default SOTTO — se per qualunque motivo la chiave ci fosse, vincerebbe
-- comunque quella esistente — e il WHERE la esclude già: due difese, nessun
-- rischio di spegnere una sede che era stata accesa.
-- Cadenza e testi dei livelli NON si scrivono: `livelliEffettivi()` li riempie dai
-- default del codice, che sono anche quelli mostrati in Impostazioni. Duplicarli in
-- tabella li congelerebbe a oggi e li farebbe divergere dal codice al primo ritocco.
UPDATE public.admin_settings
   SET solleciti_config = jsonb_build_object('enabled', false) || COALESCE(solleciti_config, '{}'::jsonb)
 WHERE NOT (COALESCE(solleciti_config, '{}'::jsonb) ? 'enabled');

NOTIFY pgrst, 'reload schema';
