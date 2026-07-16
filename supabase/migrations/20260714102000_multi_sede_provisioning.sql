-- 20260714102000 — Multi-sede: provisioning reale (D1).
--
-- Contesto. `schools` è il tenant REALE: tutte le FK scuola_id (alunni, sections,
-- utenti, avvisi, …) puntano a schools(id). `scuole` è un registry ANAGRAFICO
-- scollegato (config della carta intestata) — NON si elimina. Finora la UI
-- «Gestione Multi-Sede» scriveva SOLO su `scuole`: la sede nasceva fantasma,
-- invisibile al SedeSelector (che legge schools via /api/admin/sedi ∩ utenti_scuole).
--
-- Questa migrazione (a) riconcilia i due registri sullo STESSO id, e (b) introduce
-- una RPC di provisioning che crea la sede in ENTRAMBI + collega gli admin.
-- Additiva, idempotente e rilanciabile (expand): nessuna colonna rimossa.

-- ── (a) Riconciliazione idempotente scuole ↔ schools (stesso id, due direzioni) ──
-- Le sedi nate solo nel registry `scuole` ottengono il loro tenant `schools`…
INSERT INTO public.schools (id, nome, citta, indirizzo)
SELECT s.id, s.nome, s.citta, s.indirizzo
FROM public.scuole s
WHERE NOT EXISTS (SELECT 1 FROM public.schools sc WHERE sc.id = s.id);

-- …e i tenant `schools` senza riga anagrafica ottengono il loro record `scuole`.
INSERT INTO public.scuole (id, nome, citta, indirizzo, attiva)
SELECT sc.id, sc.nome, sc.citta, sc.indirizzo, true
FROM public.schools sc
WHERE NOT EXISTS (SELECT 1 FROM public.scuole s WHERE s.id = sc.id);

-- ── (b) RPC di provisioning ──────────────────────────────────────────────────
-- Crea la sede in schools E scuole con lo STESSO id e collega tutti gli admin
-- passati (utenti_scuole). Atomica (una singola funzione plpgsql): se una INSERT
-- fallisce, l'intera chiamata fa rollback. SECURITY DEFINER + search_path fisso
-- (pattern 20260706210352_db_hardening): la superficie è ridotta a service_role.
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
  -- schools per primo: utenti_scuole.scuola_id ha FK → schools(id).
  INSERT INTO public.schools (id, nome, citta, indirizzo)
  VALUES (v_id, p_nome, p_citta, p_indirizzo);

  INSERT INTO public.scuole (id, nome, citta, indirizzo, attiva)
  VALUES (v_id, p_nome, p_citta, p_indirizzo, true);

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
REVOKE ALL ON FUNCTION public.provisiona_sede(text, text, text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.provisiona_sede(text, text, text, uuid[]) TO service_role;
