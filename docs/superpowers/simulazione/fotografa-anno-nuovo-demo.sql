-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- LA FOTOGRAFIA DELL'ANNO NUOVO DI DEMO (serve a `azzera-anno-nuovo-demo.sql`)
--
-- È SOLA LETTURA: una `SELECT`, niente da cancellare, niente da confermare. Si esegue UNA volta, PRIMA che gli agenti di collaudo
-- tocchino la Demo (cioè prima di aprire le iscrizioni dell'anno nuovo, di cambiare il listino, di confermare un bambino).
--
-- COME SI USA. Sostituisci <DEMO> con l'uuid della sede di Demo (una volta sola, nel testo qui sotto) ed esegui. La query restituisce
-- UNA riga con tre colonne:
--   · sede_di_prova   dice `true`: la sede comincia per `e2e00000` oppure è l'unica in `anno_regole.sedi_simulazione`. Altrimenti la query si FERMA con
--                     FOTOGRAFIA_SEDE_NON_DI_PROVA e non esce niente;
--   · anni_candidati  deve dire `1`: l'anno nuovo è l'unico anno della sede `in_preparazione` o `iscrizioni_aperte`;
--   · fotografia      un testo JSON: COPIALO TUTTO (è il punto ② di `azzera-anno-nuovo-demo.sql`, al posto di <FOTOGRAFIA>). Se
--                     `anni_candidati` non è 1 la colonna è vuota: non si parte.
-- L'ISTANTE in cui l'hai eseguita sta dentro la fotografia (`scattata_il`, versione 2): è la PARTENZA, e non devi annotarla né scriverla.
-- Una fotografia della versione 1 (senza `scattata_il`) lo script la rifiuta con AZZERA_FOTOGRAFIA: si rifà.
--
-- CHE COSA CONTIENE: le frequenze dell'anno corrente (uuid, stato, data d'ingresso e di uscita, codice del «no»), le quattro date dei due anni (inizio, fine, ultimo giorno aperto, «prepara il successivo dal»), lo stato e le «domande aperte» dell'anno nuovo, le righe di listino, di moduli richiesti e di posti autorizzati
-- (con i loro uuid, uguali a come sono ora), e i conteggi di partenza (frequenze, voci di pagamento, sezioni, domande). Nessun nome,
-- nessun codice fiscale, nessun dato di un bambino: sono configurazione e numeri.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

WITH sede AS (
  -- ① DA COMPILARE · l'uuid della sede di Demo (sostituisci <DEMO>).
  SELECT '<DEMO>'::uuid AS id
), candidati AS (
  SELECT a.id, a.anno_id, a.scuola_id, a.stato, a.domande_aperte, a.inizio, a.fine, a.ultimo_giorno_aperto, a.prepara_successivo_dal, y.etichetta_breve
    FROM public.anni_sede a
    JOIN public.anni_scolastici y ON y.id = a.anno_id
   WHERE a.scuola_id = (SELECT id FROM sede)
     AND a.stato IN ('in_preparazione', 'iscrizioni_aperte')
)
SELECT
  -- LA GUARDIA. Una sede che non è di prova (non comincia per `e2e00000` e non è l'unica in `anno_regole.sedi_simulazione`) FERMA la query con
  -- FOTOGRAFIA_SEDE_NON_DI_PROVA e non esce nessuna riga: la fotografia porta uuid e date di ogni frequenza, e di una sede vera non devono uscire.
  -- (Una SELECT non ha RAISE: l'errore è il cast di quel testo a boolean, e il codice sta nel messaggio. Il testo viene da una sottoquery per non
  -- farlo valutare al planner anche quando la sede è di prova.)
  CASE WHEN ((SELECT id::text FROM sede) LIKE 'e2e00000%'
    OR EXISTS (SELECT 1 FROM public.anno_regole g
                WHERE cardinality(g.sedi_simulazione) = 1 AND g.sedi_simulazione[1] = (SELECT id FROM sede))) THEN true
    ELSE (SELECT 'FOTOGRAFIA_SEDE_NON_DI_PROVA: la sede non comincia per e2e00000 e non è l''unica in anno_regole.sedi_simulazione; la fotografia è solo per la Demo' FROM sede)::boolean
  END AS sede_di_prova,
  (SELECT count(*) FROM candidati) AS anni_candidati,
  CASE WHEN (SELECT count(*) FROM candidati) = 1 THEN
    (SELECT jsonb_build_object(
        'versione', 2,
        -- L'ISTANTE dello scatto: è la PARTENZA di `azzera-anno-nuovo-demo.sql` (ciò che è nato prima non si tocca). Non si scrive a mano.
        'scattata_il', now(),
        'etichetta', c.etichetta_breve,
        'stato', c.stato,
        'domande_aperte', c.domande_aperte,
        -- Le DATE dell'anno nuovo (confine d'inizio e di fine, ultimo giorno aperto, «prepara il successivo dal»): il collaudo può spostare un
        -- confine con `sposta_confine_anno`; l'azzeramento le rimette com'erano.
        'date', jsonb_build_object('inizio', c.inizio, 'fine', c.fine, 'ultimo_giorno_aperto', c.ultimo_giorno_aperto, 'prepara_successivo_dal', c.prepara_successivo_dal),
        'listino', (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id), '[]'::jsonb) FROM public.listino_voci l WHERE l.anno_sede_id = c.id),
        'moduli',  (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]'::jsonb) FROM public.moduli_richiesti m WHERE m.anno_sede_id = c.id),
        'posti',   (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb) FROM public.posti_autorizzati p WHERE p.anno_sede_id = c.id),
        -- L'anno di PARTENZA (quello `corrente`): per ogni sua frequenza solo uuid, stato, date (ingresso e uscita) e il codice del «no». L'INGRESSO lo script non lo rimette: sta qui perché il titolare possa rimetterlo a mano. Il passaggio confermato
        -- fa uscire chi non ha risposto e chi ha detto «no»: l'azzeramento li rimette com'erano. Niente nomi, niente testo libero.
        'partenza', (SELECT jsonb_build_object(
            'etichetta', y.etichetta_breve,
            'stato', p.stato,
            'date', jsonb_build_object('inizio', p.inizio, 'fine', p.fine, 'ultimo_giorno_aperto', p.ultimo_giorno_aperto, 'prepara_successivo_dal', p.prepara_successivo_dal),
            'frequenze', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                                'id', f.id, 'stato', f.stato, 'data_ingresso', f.data_ingresso, 'data_uscita', f.data_uscita,
                                'non_rinnova_il', f.non_rinnova_il, 'non_rinnova_motivo', f.non_rinnova_motivo) ORDER BY f.id), '[]'::jsonb)
                            FROM public.frequenze f WHERE f.anno_sede_id = p.id))
                       FROM public.anni_sede p JOIN public.anni_scolastici y ON y.id = p.anno_id
                      WHERE p.scuola_id = c.scuola_id AND p.stato = 'corrente' LIMIT 1),
        'conteggi', jsonb_build_object(
          'frequenze', (SELECT count(*) FROM public.frequenze f WHERE f.anno_sede_id = c.id),
          'pagamenti', (SELECT count(*) FROM public.pagamenti g WHERE g.scuola_id = c.scuola_id AND g.anno_id = c.anno_id),
          'sezioni',   (SELECT count(*) FROM public.sections s WHERE s.scuola_id = c.scuola_id AND s.anno_id = c.anno_id),
          'domande',   (SELECT count(*) FROM public.enrollment_submissions e WHERE e.scuola_id = c.scuola_id AND e.anno_id = c.anno_id)))
       FROM candidati c)::text
  END AS fotografia;
