-- ═══════════════════════════════════════════════════════════════════════════════
-- Galleria: un genitore vede le foto della SUA sede, non di tutte
-- Collaudo privacy del 2026-07-31, rilievo W3.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- IL DIFETTO. L'unica policy di lettura di `galleria_media_v2` era
--     (is_broadcast = true) OR (tag_students && figli_del_genitore)
-- cioè: «le foto in cui c'è mio figlio, PIÙ tutte le foto istituzionali».
-- Nessun `scuola_id`. Con una sede sola era corretta; con tre significa che una
-- foto di gruppo di Cesa è leggibile dal genitore di Giugliano.
--
-- La route `GET /api/gallery` il filtro di sede ce l'ha (ed è nuovo, del
-- 2026-07-31), ma è l'UNICO strato che lo applica: chi leggesse la tabella con
-- la chiave anon, o via realtime, scavalcherebbe la route.
--
-- PERCHÉ ORA. `galleria_media_v2` ha ZERO righe: nessun genitore perde l'accesso
-- a niente, perché non c'è niente. Dopo la prima foto di un bambino la stessa
-- modifica andrebbe pesata riga per riga.
--
-- LA FORMA. Si AGGIUNGE una condizione, non se ne toglie: il rischio di sbagliare
-- è «i genitori non vedono» (fastidioso, reversibile), mai «vedono troppo».
--
-- NON BASTA DA SOLA. Il file della foto vive nello storage, non nel database:
-- il bucket `gallery` era `public: true` ed è stato chiuso lo stesso giorno
-- (`src/lib/gallery/storage.ts`, link firmati a 10 minuti). Le due cose vanno
-- insieme: la policy decide chi vede la RIGA, il bucket chi vede il FILE.
--
-- APPLICATA in produzione il 2026-07-31 come `20260731170007`, con l'approvazione
-- esplicita del titolare (la migrazione era stata bloccata dal classificatore di
-- sicurezza perché l'autorizzazione «pre-lancio» di CLAUDE.md è decaduta: in
-- produzione ci sono i dati di 152 minori dal 16 luglio).
-- ═══════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "parent read galleria figli (parents space)" ON public.galleria_media_v2;

CREATE POLICY "parent read galleria figli (parents space)"
  ON public.galleria_media_v2 FOR SELECT TO authenticated
  USING (
    -- La foto sta in una sede in cui questo genitore ha un figlio.
    EXISTS (
      SELECT 1 FROM public.alunni a
       WHERE a.id = ANY (ARRAY(SELECT current_parent_student_ids()))
         AND a.scuola_id = galleria_media_v2.scuola_id
    )
    -- …e resta vero tutto ciò che valeva prima.
    AND (
      is_broadcast = true
      OR tag_students && ARRAY(SELECT current_parent_student_ids())
    )
  );

COMMENT ON POLICY "parent read galleria figli (parents space)" ON public.galleria_media_v2 IS
  'Il genitore vede le foto broadcast e quelle in cui è taggato un suo figlio, MA solo nelle sedi in cui ha un figlio (vincolo aggiunto il 2026-07-31: senza, una foto istituzionale di un plesso era leggibile dai genitori di tutti gli altri).';

NOTIFY pgrst, 'reload schema';
