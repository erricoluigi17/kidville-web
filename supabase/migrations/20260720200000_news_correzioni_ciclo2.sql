-- =============================================================================
-- SEZIONE «NEWS» · correzioni ciclo 2 (collaudo /ship-cycle)
--
-- Additiva/idempotente. Chiude i rilievi di performance advisor introdotti dallo
-- schema news e aggiunge la retention del tracciamento di lettura (GDPR):
--
--   1) auth_rls_initplan (WARN) — le 2 SELECT difensive `authenticated` su
--      news_posts e news_digest_edizioni ri-valutano auth.uid() PER RIGA. Logica
--      INVARIATA rispetto a 20260720191506_news_base.sql: ogni `auth.uid()` è
--      avvolto in `(select auth.uid())` (init-plan una sola volta per query).
--   2) unindexed_foreign_keys (INFO) — indice di copertura su news_posts.categoria_id
--      (il feed filtra per categoria) e news_categorie.scuola_id (FK a scuole).
--   3) news-retention — job pg_cron settimanale che cancella le viste
--      news_visualizzazioni più vecchie di 12 mesi (dato puramente statistico:
--      niente conservazione a tempo indefinito di un tracciamento comportamentale
--      di famiglie di minori). In DO…EXCEPTION per il DB E2E della CI senza pg_cron.
--
-- Le 4 «unused_index» residue (news_posts_programmata/pinned/ig_check/search) NON
-- si toccano: sono indici legittimi ancora senza traffico (feature non live).
-- =============================================================================

-- ── 1) auth_rls_initplan — news_posts ────────────────────────────────────────
DROP POLICY IF EXISTS "auth read news_posts" ON public.news_posts;
CREATE POLICY "auth read news_posts" ON public.news_posts
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.utenti u
      WHERE u.id = (select auth.uid())
        AND u.ruolo <> 'genitore'
        AND (
          news_posts.scuola_id IS NULL
          OR news_posts.scuola_id = u.scuola_id
          OR news_posts.scuola_id IN (SELECT us.scuola_id FROM public.utenti_scuole us WHERE us.utente_id = (select auth.uid()))
        )
    )
    OR (
      news_posts.stato = 'pubblicata'
      AND EXISTS (
        SELECT 1 FROM public.alunni a
        WHERE a.id IN (
          SELECT public.current_parent_student_ids()
          UNION
          SELECT lga.alunno_id FROM public.legame_genitori_alunni lga WHERE lga.genitore_id = (select auth.uid())
        )
        AND (news_posts.scuola_id IS NULL OR news_posts.scuola_id = a.scuola_id)
        AND (
          news_posts.target_scope = 'globale'
          OR (news_posts.target_scope = 'classi' AND a.classe_sezione = ANY (news_posts.target_classes))
          OR (news_posts.target_scope = 'grado' AND EXISTS (
            SELECT 1 FROM public.sections s WHERE s.id = a.section_id AND s.school_type = ANY (news_posts.target_gradi)
          ))
        )
      )
    )
  );

-- ── 1) auth_rls_initplan — news_digest_edizioni ──────────────────────────────
DROP POLICY IF EXISTS "auth read news_digest_edizioni" ON public.news_digest_edizioni;
CREATE POLICY "auth read news_digest_edizioni" ON public.news_digest_edizioni
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.utenti u
      WHERE u.id = (select auth.uid())
        AND u.ruolo <> 'genitore'
        AND (
          news_digest_edizioni.scuola_id = u.scuola_id
          OR news_digest_edizioni.scuola_id IN (SELECT us.scuola_id FROM public.utenti_scuole us WHERE us.utente_id = (select auth.uid()))
        )
    )
    OR (
      news_digest_edizioni.inviata_il IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.alunni a
        WHERE a.id IN (
          SELECT public.current_parent_student_ids()
          UNION
          SELECT lga.alunno_id FROM public.legame_genitori_alunni lga WHERE lga.genitore_id = (select auth.uid())
        )
        AND a.scuola_id = news_digest_edizioni.scuola_id
      )
    )
  );

-- ── 2) unindexed_foreign_keys ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS news_posts_categoria ON public.news_posts (categoria_id);
CREATE INDEX IF NOT EXISTS news_categorie_scuola ON public.news_categorie (scuola_id);

-- ── 3) news-retention — purge del tracciamento di lettura oltre 12 mesi ───────
-- Il dato ha finalità solo statistica; oltre i 12 mesi si cancella. Protetto per
-- il DB E2E della CI (pg_cron non esiste). Idempotente (unschedule-se-presente).
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'news-retention';
  PERFORM cron.schedule(
    'news-retention',
    '17 4 * * 0',
    $cron$ DELETE FROM public.news_visualizzazioni WHERE prima_visualizzazione < now() - interval '12 months'; $cron$
  );
EXCEPTION WHEN OTHERS THEN null;
END $$;

NOTIFY pgrst, 'reload schema';
