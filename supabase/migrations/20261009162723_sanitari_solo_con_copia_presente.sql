-- =============================================================================
-- DATI SANITARI: SI TOLGONO DALLA DOMANDA SOLO SE SONO IN SCHEDA — 2026-10-09
--
-- Roadmap di robustezza, fase 4, caso D6-d («dati sanitari tolti anche se
-- l'import non li ha copiati»): correttivo «copia presente».
--
-- ─── IL DIFETTO ──────────────────────────────────────────────────────────────
-- `iscrizioni_sanitari_tick` (migrazione 20260801081423) toglieva allergie e note
-- mediche da OGNI domanda accolta e importata, dando per scontato che a quel punto
-- vivessero in `alunni.allergies` / `alunni.note_mediche`. Non era vero per la
-- re-iscrizione: l'import (a mano e a elenco) che RIUSAVA una scheda esistente
-- scriveva solo classe e retta. Misurato il 2026-10-09: 276 bambini con la domanda
-- svuotata, 148 con la scheda senza nessun dato sanitario, 123 con la scheda piena
-- di dati vecchi. Rimozioni del 23/08–21/09, più vecchie di ogni backup.
-- Il codice dell'import è corretto nella stessa PR (`src/lib/iscrizioni/sanitari.ts`);
-- questa funzione è la rete sotto, e da oggi ha la stessa regola.
--
-- ─── LA REGOLA ───────────────────────────────────────────────────────────────
-- Un bambino perde i dati sanitari dalla domanda solo se esiste la SUA scheda,
-- nella STESSA sede e non anonimizzata, che li contiene: per codice fiscale, o —
-- se la domanda non lo porta — per nome + cognome + data di nascita, come la
-- dedup dell'import. «Contiene» = il testo della domanda, con gli spazi compressi
-- e in minuscolo, è dentro quello della scheda: è la stessa normalizzazione di
-- `normalizzaSanitario` (TS). Se le due non coincidessero su un carattere esotico,
-- l'effetto è uno solo e innocuo: il dato resta nella domanda.
-- Chi non ha la copia resta com'è, e si conta (`n_conservati`): una riga `warn`
-- in app_log a parte, perché è un dato che non è arrivato dove lo legge la cucina.
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   select public.iscrizioni_sanitari_tick();   -- intero: domande riscritte
--   select contesto from app_log where fingerprint = 'cron:iscrizioni-sanitari'
--    order by visto_l_ultima desc limit 1;       -- n_domande, n_conservati
--   select has_function_privilege('anon', 'public.iscrizioni_sanitari_tick()', 'EXECUTE');  -- false
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
-- Ricreare la funzione com'è in 20260801081423_retention_iscrizioni_e_audit.sql
-- (righe «Regola 2»). Non ce n'è motivo: la versione vecchia è quella che perde dati.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.iscrizioni_sanitari_tick()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_domande    int := 0;
  v_conservati int := 0;
BEGIN
  WITH figli AS (
    SELECT e.id, e.scuola_id, x.ord, x.c,
           -- `<> ''` e non «IS NOT NULL»: una stringa vuota non è un dato, e
           -- senza questo il lavoro riscriverebbe ogni notte le stesse domande.
           (COALESCE(btrim(x.c->>'allergies'), '') <> ''
             OR COALESCE(btrim(x.c->>'note_mediche'), '') <> '') AS ha_sanitari
      FROM public.enrollment_submissions e
     CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(e.data->'children') = 'array'
                  THEN e.data->'children' ELSE '[]'::jsonb END
           ) WITH ORDINALITY AS x(c, ord)
     WHERE e.status = 'approved'
       AND e.imported_at IS NOT NULL
  ), decisi AS (
    SELECT f.*,
           CASE WHEN NOT f.ha_sanitari THEN NULL ELSE EXISTS (
             SELECT 1
               FROM public.alunni a
               -- Normalizzazione: spazi compressi PRIMA del btrim (che toglie solo
               -- lo spazio), poi minuscole. Stessa cosa del `trim().replace(/\s+/g,' ')`.
               CROSS JOIN LATERAL (SELECT
                 lower(btrim(regexp_replace(COALESCE(a.allergies, ''), '\s+', ' ', 'g'), ' '))    AS s_all,
                 lower(btrim(regexp_replace(COALESCE(a.note_mediche, ''), '\s+', ' ', 'g'), ' ')) AS s_note,
                 lower(btrim(regexp_replace(COALESCE(f.c->>'allergies', ''), '\s+', ' ', 'g'), ' '))    AS d_all,
                 lower(btrim(regexp_replace(COALESCE(f.c->>'note_mediche', ''), '\s+', ' ', 'g'), ' ')) AS d_note
               ) n
              WHERE a.scuola_id = f.scuola_id
                AND a.anonimizzato_il IS NULL
                AND (
                      (NULLIF(btrim(f.c->>'codice_fiscale'), '') IS NOT NULL
                        AND upper(btrim(a.codice_fiscale)) = upper(btrim(f.c->>'codice_fiscale')))
                   OR (NULLIF(btrim(f.c->>'codice_fiscale'), '') IS NULL
                        AND a.nome = f.c->>'nome'
                        AND a.cognome = f.c->>'cognome'
                        AND a.data_nascita::text = f.c->>'data_nascita')
                    )
                AND (n.d_all = '' OR position(n.d_all IN n.s_all) > 0)
                AND (n.d_note = '' OR position(n.d_note IN n.s_note) > 0)
           ) END AS copia_presente
      FROM figli f
  ), nuove AS (
    SELECT d.id,
           jsonb_agg(
             CASE WHEN d.copia_presente
                  THEN d.c || jsonb_build_object(
                                'allergies', NULL,
                                'note_mediche', NULL,
                                'sanitari_rimossi_il', to_jsonb(now()))
                  ELSE d.c
             END
             ORDER BY d.ord
           ) AS children,
           COALESCE(bool_or(d.copia_presente), false)      AS da_riscrivere,
           count(*) FILTER (WHERE d.copia_presente IS FALSE) AS conservati
      FROM decisi d
     GROUP BY d.id
  ), aggiornate AS (
    UPDATE public.enrollment_submissions e
       SET data = jsonb_set(e.data, '{children}', n.children), updated_at = now()
      FROM nuove n
     WHERE e.id = n.id
       AND n.da_riscrivere
    RETURNING 1
  )
  SELECT (SELECT count(*)::int FROM aggiornate),
         (SELECT COALESCE(sum(conservati), 0)::int FROM nuove)
    INTO v_domande, v_conservati;

  -- Il successo si scrive SEMPRE (regola 5): «nessuna riga» non deve voler dire
  -- insieme «tutto a posto» e «non è mai partito». Solo conteggi.
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES (
    'info', 'gdpr', 'server', 'dati sanitari rimossi dalle domande gia accolte (solo con copia in scheda)',
    'cron:iscrizioni-sanitari',
    jsonb_build_object('esito', 'sanitari-rimossi-da-domanda', 'n_domande', v_domande, 'n_conservati', v_conservati)
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        contesto = excluded.contesto;

  IF v_conservati > 0 THEN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'warn', 'gdpr', 'server', 'dati sanitari rimasti nella domanda: nella scheda del bambino non ci sono',
      'cron:iscrizioni-sanitari-conservati',
      jsonb_build_object('esito', 'sanitari-conservati-nella-domanda', 'n_conservati', v_conservati)
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now(),
          contesto = excluded.contesto;
  END IF;

  RETURN v_domande;
END $$;

REVOKE ALL ON FUNCTION public.iscrizioni_sanitari_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.iscrizioni_sanitari_tick() TO service_role;

COMMENT ON FUNCTION public.iscrizioni_sanitari_tick() IS
  'Toglie allergie e note mediche (art. 9 GDPR) dalle domande GIÀ ACCOLTE e importate, ma SOLO per i bambini la cui scheda (stessa sede, non anonimizzata; per codice fiscale o nome+cognome+data di nascita) contiene già quei dati (dal 2026-10-09: prima li toglieva anche quando la re-iscrizione non li aveva copiati). Gli altri restano nella domanda e si contano in app_log (n_conservati, riga warn a parte).';

NOTIFY pgrst, 'reload schema';
