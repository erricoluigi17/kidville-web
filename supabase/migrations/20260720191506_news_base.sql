-- =============================================================================
-- SEZIONE «NEWS» · schema base
--
--   Canale editoriale interno (blog rich-text, comunicati brevi, post Instagram
--   embeddati, digest mensile) visibile ai soli utenti autenticati. 5 tabelle:
--     · news_categorie          — clone strutturale di cassa_categorie
--                                 (globali is_sistema=true + personalizzate di sede)
--     · news_posts              — i contenuti (articolo/breve/instagram), workflow
--                                 bozza→proposta→programmata→pubblicata→nascosta,
--                                 target per sede/grado/classi, ricerca full-text IT
--     · news_media              — media associati (immagine/video/youtube/vimeo)
--     · news_visualizzazioni    — viste per (post, famiglia): stat solo staff
--     · news_digest_edizioni    — archivio del digest mensile per sede
--
--   RLS abilitata su tutte e 5. Le MUTAZIONI passano SOLO dalle route service-role
--   (createAdminClient + gate applicativo requireStaff/requireDocente + zod):
--   NESSUNA policy INSERT/UPDATE/DELETE per `authenticated`. Le sole policy
--   `authenticated` sono SELECT difensive (defense-in-depth) su categorie/posts/
--   edizioni; il feed genitore reale è server-derived e fail-closed nelle route.
--
--   Additivo/idempotente (IF NOT EXISTS / ON CONFLICT DO NOTHING). Il DB E2E della
--   CI NON è migrato: tabelle/colonne assenti → PGRST205/42P01/42703/PGRST204 → il
--   codice degrada a {disponibile:false}/liste vuote (src/lib/news/schema-assente.ts).
--
--   NB: FK di sede su `public.scuole` (registro multi-sede, come cassa_categorie).
--   `news_posts.scuola_id`/`news_digest_edizioni.scuola_id` sono soft-reference
--   (come alunni.scuola_id): nessun FK, per non irrigidire i flussi cross-sede.
-- =============================================================================

-- ── 1) news_categorie ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.news_categorie (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id   uuid REFERENCES public.scuole(id) ON DELETE CASCADE,   -- NULL = globale
  nome        text NOT NULL,
  slug        text NOT NULL,
  colore      text,
  icona       text,
  ordine      int  NOT NULL DEFAULT 99,
  is_sistema  boolean NOT NULL DEFAULT false,
  attivo      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS news_categorie_slug_uniq
  ON public.news_categorie (COALESCE(scuola_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);

ALTER TABLE public.news_categorie ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service news_categorie" ON public.news_categorie;
CREATE POLICY "service news_categorie" ON public.news_categorie
  TO service_role USING (true) WITH CHECK (true);
-- SELECT difensiva: qualunque autenticato vede le categorie ATTIVE (lista chiusa,
-- nessun dato sensibile). Le mutazioni restano service-role.
DROP POLICY IF EXISTS "auth read news_categorie" ON public.news_categorie;
CREATE POLICY "auth read news_categorie" ON public.news_categorie
  FOR SELECT TO authenticated USING (attivo = true);
GRANT ALL ON public.news_categorie TO service_role;

-- ── 2) news_posts ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.news_posts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo                text NOT NULL CHECK (tipo IN ('articolo','breve','instagram')),
  stato               text NOT NULL DEFAULT 'bozza' CHECK (stato IN ('bozza','proposta','programmata','pubblicata','nascosta')),
  titolo              text NOT NULL,
  contenuto_json      jsonb,
  contenuto_html      text,
  contenuto_testo     text,
  search_tsv          tsvector GENERATED ALWAYS AS
                        (to_tsvector('italian', coalesce(titolo,'') || ' ' || coalesce(contenuto_testo,''))) STORED,
  categoria_id        uuid REFERENCES public.news_categorie(id) ON DELETE SET NULL,
  programmata_il      timestamptz,
  pubblicata_il       timestamptz,
  pinned              boolean NOT NULL DEFAULT false,
  target_scope        text NOT NULL DEFAULT 'globale' CHECK (target_scope IN ('globale','grado','classi')),
  target_gradi        public.school_type_enum[],
  target_classes      text[],
  copertina_url       text,
  instagram_url       text,
  instagram_shortcode text,
  ig_check_falliti    int NOT NULL DEFAULT 0,
  ig_check_il         timestamptz,
  nascosta_motivo     text,
  invia_notifica      boolean NOT NULL DEFAULT true,
  notifica_inviata_il timestamptz,
  approvata_da        uuid,
  approvata_il        timestamptz,
  scuola_id           uuid,                 -- NULL = tutte le sedi (riservato admin)
  author_id           uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_posts_scuola_stato_data
  ON public.news_posts (scuola_id, stato, pubblicata_il DESC);
CREATE INDEX IF NOT EXISTS news_posts_programmata
  ON public.news_posts (programmata_il) WHERE stato = 'programmata';
CREATE INDEX IF NOT EXISTS news_posts_pinned
  ON public.news_posts (pinned) WHERE pinned;
CREATE INDEX IF NOT EXISTS news_posts_ig_check
  ON public.news_posts (ig_check_il) WHERE tipo = 'instagram' AND stato = 'pubblicata';
CREATE INDEX IF NOT EXISTS news_posts_search
  ON public.news_posts USING GIN (search_tsv);

ALTER TABLE public.news_posts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service news_posts" ON public.news_posts;
CREATE POLICY "service news_posts" ON public.news_posts
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.news_posts TO service_role;

-- SELECT difensiva `authenticated` (defense-in-depth: il feed reale è server-derived
-- nelle route service-role). Staff/docente/cuoca (ruolo ≠ 'genitore'): post della
-- propria sede o globali, in qualunque stato. Genitore: SOLO pubblicati che
-- targettizzano un proprio figlio (sede + grado/classe), FAIL-CLOSED.
DROP POLICY IF EXISTS "auth read news_posts" ON public.news_posts;
CREATE POLICY "auth read news_posts" ON public.news_posts
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.utenti u
      WHERE u.id = auth.uid()
        AND u.ruolo <> 'genitore'
        AND (
          news_posts.scuola_id IS NULL
          OR news_posts.scuola_id = u.scuola_id
          OR news_posts.scuola_id IN (SELECT us.scuola_id FROM public.utenti_scuole us WHERE us.utente_id = auth.uid())
        )
    )
    OR (
      news_posts.stato = 'pubblicata'
      AND EXISTS (
        SELECT 1 FROM public.alunni a
        WHERE a.id IN (
          SELECT public.current_parent_student_ids()
          UNION
          SELECT lga.alunno_id FROM public.legame_genitori_alunni lga WHERE lga.genitore_id = auth.uid()
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

-- ── 3) news_media ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.news_media (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    uuid NOT NULL REFERENCES public.news_posts(id) ON DELETE CASCADE,
  tipo       text CHECK (tipo IN ('immagine','video','youtube','vimeo')),
  url        text NOT NULL,
  poster_url text,
  ordine     int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS news_media_post ON public.news_media (post_id, ordine);

ALTER TABLE public.news_media ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service news_media" ON public.news_media;
CREATE POLICY "service news_media" ON public.news_media
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.news_media TO service_role;

-- ── 4) news_visualizzazioni ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.news_visualizzazioni (
  post_id              uuid REFERENCES public.news_posts(id) ON DELETE CASCADE,
  utente_id            uuid,
  prima_visualizzazione timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, utente_id)
);

ALTER TABLE public.news_visualizzazioni ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service news_visualizzazioni" ON public.news_visualizzazioni;
CREATE POLICY "service news_visualizzazioni" ON public.news_visualizzazioni
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.news_visualizzazioni TO service_role;

-- ── 5) news_digest_edizioni ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.news_digest_edizioni (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id         uuid NOT NULL,
  anno              int NOT NULL,
  mese              int NOT NULL,
  titolo            text,
  post_ids          uuid[],
  html              text,
  generata_il       timestamptz NOT NULL DEFAULT now(),
  inviata_il        timestamptz,
  destinatari_count int NOT NULL DEFAULT 0,
  errori_count      int NOT NULL DEFAULT 0,
  UNIQUE (scuola_id, anno, mese)
);

ALTER TABLE public.news_digest_edizioni ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service news_digest_edizioni" ON public.news_digest_edizioni;
CREATE POLICY "service news_digest_edizioni" ON public.news_digest_edizioni
  TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.news_digest_edizioni TO service_role;

-- SELECT difensiva: staff vede le edizioni della propria sede (anche non inviate);
-- genitore vede solo quelle INVIATE delle sedi dei propri figli.
DROP POLICY IF EXISTS "auth read news_digest_edizioni" ON public.news_digest_edizioni;
CREATE POLICY "auth read news_digest_edizioni" ON public.news_digest_edizioni
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.utenti u
      WHERE u.id = auth.uid()
        AND u.ruolo <> 'genitore'
        AND (
          news_digest_edizioni.scuola_id = u.scuola_id
          OR news_digest_edizioni.scuola_id IN (SELECT us.scuola_id FROM public.utenti_scuole us WHERE us.utente_id = auth.uid())
        )
    )
    OR (
      news_digest_edizioni.inviata_il IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.alunni a
        WHERE a.id IN (
          SELECT public.current_parent_student_ids()
          UNION
          SELECT lga.alunno_id FROM public.legame_genitori_alunni lga WHERE lga.genitore_id = auth.uid()
        )
        AND a.scuola_id = news_digest_edizioni.scuola_id
      )
    )
  );

-- ── 6) Seed categorie globali di sistema (idempotente) ───────────────────────
INSERT INTO public.news_categorie (nome, slug, ordine, is_sistema)
SELECT v.nome, v.slug, v.ordine, true
FROM (VALUES
  ('Vita di scuola',       'vita-di-scuola',      1),
  ('Eventi e feste',       'eventi-e-feste',      2),
  ('Comunicati',           'comunicati',          3),
  ('Dal nostro Instagram', 'dal-nostro-instagram',4),
  ('Menu e cucina',        'menu-e-cucina',       5)
) AS v(nome, slug, ordine)
ON CONFLICT (COALESCE(scuola_id, '00000000-0000-0000-0000-000000000000'::uuid), slug) DO NOTHING;

NOTIFY pgrst, 'reload schema';
