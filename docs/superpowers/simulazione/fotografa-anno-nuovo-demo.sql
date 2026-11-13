-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- LA FOTOGRAFIA DELL'ANNO NUOVO DI DEMO (serve a `azzera-anno-nuovo-demo.sql`)
--
-- È SOLA LETTURA: una `SELECT`, niente da cancellare, niente da confermare. Si esegue UNA volta, PRIMA che gli agenti di collaudo
-- tocchino la Demo (cioè prima di aprire le iscrizioni dell'anno nuovo, di cambiare il listino, di confermare un bambino).
--
-- COME SI USA. Sostituisci <DEMO> con l'uuid della sede di Demo (una volta sola, nel testo qui sotto) ed esegui. La query restituisce
-- UNA riga con tre colonne:
--   · sede_di_prova   deve dire `true`: la sede comincia per `e2e00000` oppure è l'unica in `anno_regole.sedi_simulazione`;
--   · anni_candidati  deve dire `1`: l'anno nuovo è l'unico anno della sede `in_preparazione` o `iscrizioni_aperte`;
--   · fotografia      un testo JSON: COPIALO TUTTO (è il punto ② di `azzera-anno-nuovo-demo.sql`, al posto di <FOTOGRAFIA>). Se
--                     `anni_candidati` non è 1 la colonna è vuota: non si parte.
-- Annota anche l'ORA in cui l'hai eseguita, con il fuso (per esempio 2026-11-20 09:00:00+01): è la PARTENZA (punto ③).
--
-- CHE COSA CONTIENE: lo stato e le «domande aperte» dell'anno nuovo, le righe di listino, di moduli richiesti e di posti autorizzati
-- (con i loro uuid, uguali a come sono ora), e i conteggi di partenza (frequenze, voci di pagamento, sezioni, domande). Nessun nome,
-- nessun codice fiscale, nessun dato di un bambino: sono configurazione e numeri.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

WITH sede AS (
  -- ① DA COMPILARE · l'uuid della sede di Demo (sostituisci <DEMO>).
  SELECT '<DEMO>'::uuid AS id
), candidati AS (
  SELECT a.id, a.anno_id, a.scuola_id, a.stato, a.domande_aperte, y.etichetta_breve
    FROM public.anni_sede a
    JOIN public.anni_scolastici y ON y.id = a.anno_id
   WHERE a.scuola_id = (SELECT id FROM sede)
     AND a.stato IN ('in_preparazione', 'iscrizioni_aperte')
)
SELECT
  ((SELECT id::text FROM sede) LIKE 'e2e00000%'
    OR EXISTS (SELECT 1 FROM public.anno_regole g
                WHERE cardinality(g.sedi_simulazione) = 1 AND g.sedi_simulazione[1] = (SELECT id FROM sede))) AS sede_di_prova,
  (SELECT count(*) FROM candidati) AS anni_candidati,
  CASE WHEN (SELECT count(*) FROM candidati) = 1 THEN
    (SELECT jsonb_build_object(
        'versione', 1,
        'etichetta', c.etichetta_breve,
        'stato', c.stato,
        'domande_aperte', c.domande_aperte,
        'listino', (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id), '[]'::jsonb) FROM public.listino_voci l WHERE l.anno_sede_id = c.id),
        'moduli',  (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]'::jsonb) FROM public.moduli_richiesti m WHERE m.anno_sede_id = c.id),
        'posti',   (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb) FROM public.posti_autorizzati p WHERE p.anno_sede_id = c.id),
        'conteggi', jsonb_build_object(
          'frequenze', (SELECT count(*) FROM public.frequenze f WHERE f.anno_sede_id = c.id),
          'pagamenti', (SELECT count(*) FROM public.pagamenti g WHERE g.scuola_id = c.scuola_id AND g.anno_id = c.anno_id),
          'sezioni',   (SELECT count(*) FROM public.sections s WHERE s.scuola_id = c.scuola_id AND s.anno_id = c.anno_id),
          'domande',   (SELECT count(*) FROM public.enrollment_submissions e WHERE e.scuola_id = c.scuola_id AND e.anno_id = c.anno_id)))
       FROM candidati c)::text
  END AS fotografia;
