-- =============================================================================
-- 20260729114316 — A3 · Una sede nuova nasce col REGISTRO ACCESO
-- =============================================================================
-- IL DIFETTO. `public.provisiona_sede` (20260714102000) crea la sede in `schools`
-- e `scuole` con lo stesso id e collega gli admin in `utenti_scuole`, ma NON crea
-- la riga `admin_settings` della nuova sede. Senza quella riga:
--
--   loadGradoContext  (src/lib/auth/require-grado.ts:36-44) legge  matrice = {}
--   requireFunzione   (src/lib/auth/require-grado.ts:64-86) risponde 403
--
-- su TUTTE le funzioni docente della sede. Kidville Aversa e Kidville Cesa
-- sarebbero nate con il registro elettronico spento — e senza un solo errore da
-- nessuna parte a dirlo: le route rispondono 403, che è la risposta di un
-- permesso negato, non di una configurazione mancante.
--
-- LA CORREZIONE. `provisiona_sede` viene riscritta (CREATE OR REPLACE) con firma,
-- SECURITY DEFINER, search_path e grant IDENTICI, e vi si aggiunge la creazione
-- idempotente di `admin_settings`. In più, backfill una-tantum per le sedi già
-- esistenti che non hanno la riga (nessuna, oggi: è la rete di sicurezza per una
-- sede eventualmente provisionata con la versione vecchia della RPC).
--
-- Additiva ed expand: nessuna colonna rimossa, nessuna migrazione esistente
-- modificata, rilanciabile senza effetti (ON CONFLICT DO NOTHING).
-- =============================================================================

-- ── (a) Il default: da dove vengono questi valori ────────────────────────────
-- SCELTA: default ESPLICITO, non «copia dalla sede esistente più vecchia».
--   1. `admin_settings` non ha `created_at` (solo `updated_at`, che cambia a ogni
--      salvataggio): «la sede più vecchia» non è nemmeno definibile in modo
--      affidabile.
--   2. In produzione esiste già una riga con `funzioni_matrice = '{}'` (la sede di
--      collaudo): copiare dalla sede sbagliata propagherebbe ESATTAMENTE il difetto
--      che questa migrazione corregge — una sede nuova col registro spento.
--   3. Un default scritto qui è deterministico, si legge in code review, e vale
--      anche quando non esiste NESSUN'altra sede.
-- I valori riproducono la ripartizione già in uso a Kidville Giugliano: nido e
-- infanzia lavorano su diario/appello/mensa/comunicazione; la primaria aggiunge
-- registro, valutazioni, orario, note e pagelle. La Direzione può poi cambiare
-- tutto da Impostazioni → Funzioni per grado: questo è il punto di partenza.
--
-- ⚠️ GEMELLO TypeScript: `src/lib/scuole/admin-settings-default.ts`, usato dal ramo
-- di fallback di POST /api/admin/schools (il DB E2E non ha questa RPC). Le due
-- copie devono restare allineate: se cambi qui, cambia anche là.
CREATE OR REPLACE FUNCTION public.admin_settings_default_matrice() RETURNS jsonb
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
AS $$
  SELECT '{
    "nido":     {"registro": false, "valutazioni": false, "note": false, "orario": false,
                 "appello": true,  "diario": true,  "gallery": true, "mensa": true,
                 "chat": true, "avvisi": true, "armadietto": true, "modulistica": true,
                 "pagelle": false},
    "infanzia": {"registro": false, "valutazioni": false, "note": false, "orario": false,
                 "appello": true,  "diario": true,  "gallery": true, "mensa": true,
                 "chat": true, "avvisi": true, "armadietto": true, "modulistica": true,
                 "pagelle": false},
    "primaria": {"registro": true,  "valutazioni": true,  "note": true,  "orario": true,
                 "appello": true,  "diario": false, "gallery": true, "mensa": true,
                 "chat": true, "avvisi": true, "armadietto": false, "modulistica": true,
                 "pagelle": true}
  }'::jsonb;
$$;

COMMENT ON FUNCTION public.admin_settings_default_matrice() IS
  'Matrice grado→funzioni con cui nasce una sede nuova (gemella di src/lib/scuole/admin-settings-default.ts).';

-- Costante, non tocca dati: non è SECURITY DEFINER. La si chiude comunque ai ruoli
-- client — nessuna funzione di provisioning ha motivo di stare sulla superficie
-- pubblica di PostgREST.
REVOKE ALL ON FUNCTION public.admin_settings_default_matrice() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_settings_default_matrice() TO service_role;

-- ── (b) provisiona_sede: stessa firma, stessa security, un'INSERT in più ─────
-- Rispetto a 20260714102000 cambia SOLO l'aggiunta del blocco `admin_settings`.
-- Resta atomica (unica funzione plpgsql: se una INSERT fallisce, rollback di
-- tutto) e SECURITY DEFINER con search_path fisso.
CREATE OR REPLACE FUNCTION public.provisiona_sede(
  p_nome text,
  p_citta text,
  p_indirizzo text,
  p_admin_ids uuid[]
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_id    uuid := gen_random_uuid();
  v_admin uuid;
BEGIN
  -- schools per primo: utenti_scuole.scuola_id e admin_settings.scuola_id hanno
  -- entrambe FK → schools(id).
  INSERT INTO public.schools (id, nome, citta, indirizzo)
  VALUES (v_id, p_nome, p_citta, p_indirizzo);

  INSERT INTO public.scuole (id, nome, citta, indirizzo, attiva)
  VALUES (v_id, p_nome, p_citta, p_indirizzo, true);

  -- Il registro elettronico della sede. Senza questa riga i docenti prendono 403
  -- su tutto (vedi l'intestazione). `ON CONFLICT (scuola_id) DO NOTHING`: la PK è
  -- scuola_id, quindi la chiamata resta idempotente e rilanciabile.
  --
  -- solleciti_config = {"enabled": false} — SCELTA ESPLICITA, non una dimenticanza
  -- (vedi anche 20260729114339): una sede appena creata sta ancora importando
  -- anagrafiche e pagamenti, e `retta_auto_enabled` è true per default, quindi le
  -- prime rette nascono con scadenze anche retrodatate. Col cron acceso il primo
  -- giro delle 06:00 manderebbe solleciti di morosità VERI a famiglie vere per
  -- debiti che sono solo un artefatto dell'import: un'email spedita non si
  -- richiama, una spunta in Impostazioni → Solleciti sì.
  -- Cadenza e testi dei 3 livelli NON si scrivono qui: `livelliEffettivi()`
  -- (src/lib/pagamenti/solleciti.ts) li riempie già dai default del codice, e
  -- congelarli nel DB alla data della migrazione li farebbe divergere da quelli
  -- mostrati in Impostazioni.
  -- Tutte le altre colonne di admin_settings hanno un DEFAULT nel DB: non si
  -- replicano qui, così quando il default cambia cambia in un posto solo.
  INSERT INTO public.admin_settings (scuola_id, funzioni_matrice, solleciti_config)
  VALUES (v_id, public.admin_settings_default_matrice(), '{"enabled": false}'::jsonb)
  ON CONFLICT (scuola_id) DO NOTHING;

  IF p_admin_ids IS NOT NULL THEN
    FOREACH v_admin IN ARRAY p_admin_ids LOOP
      INSERT INTO public.utenti_scuole (utente_id, scuola_id)
      VALUES (v_admin, v_id)
      ON CONFLICT DO NOTHING;  -- PK (utente_id, scuola_id): idempotente
    END LOOP;
  END IF;

  RETURN v_id;
END;
$$;

-- ── (c) Superficie ridotta: solo il server (service_role) provisiona ─────────
-- CREATE OR REPLACE conserva i privilegi esistenti; li si riafferma comunque, così
-- il file dice da solo qual è la superficie della funzione (e il lock
-- __tests__/architecture/security-definer-revoke-lock.test.ts lo verifica).
REVOKE ALL ON FUNCTION public.provisiona_sede(text, text, text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.provisiona_sede(text, text, text, uuid[]) TO service_role;

-- ── (d) Backfill: nessuna sede senza il proprio admin_settings ───────────────
-- Rete di sicurezza per una sede eventualmente creata con la RPC vecchia (oggi:
-- nessuna). Idempotente: tocca solo le sedi che la riga non ce l'hanno, e le righe
-- esistenti NON vengono modificate — le personalizzazioni della Direzione restano.
INSERT INTO public.admin_settings (scuola_id, funzioni_matrice, solleciti_config)
SELECT s.id, public.admin_settings_default_matrice(), '{"enabled": false}'::jsonb
FROM public.schools s
WHERE NOT EXISTS (SELECT 1 FROM public.admin_settings a WHERE a.scuola_id = s.id)
ON CONFLICT (scuola_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
