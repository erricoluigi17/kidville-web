-- =============================================================================
-- L'ANNO SCOLASTICO — LE INVARIANTI
-- Specifica: docs/superpowers/specs/2026-11-06-anno-scolastico-design.md, §4.17
--
-- Ogni query restituisce le righe che violano una regola. Il risultato giusto è
-- ZERO RIGHE, sempre. Sono di sola lettura: si possono lanciare in produzione.
--
-- Questo file è il riferimento. Nel database le stesse regole vivono in
-- public.anno_invarianti() (PR 1, Compito 1.5), che le conta per tabella, e il
-- controllo di salute notturno le rilancia: un'invariante che nessuno rilancia
-- è una fotografia, non una prova. Se cambia una, cambiano tutte e due nella
-- stessa PR.
--
-- Restituiscono solo uuid, date e conteggi: mai un nome, mai un codice fiscale.
-- Le invarianti 7 e 8 usano le funzioni di visibilità delle PR 4.3 e 4.4: prima
-- di quelle PR non si possono lanciare.
-- =============================================================================


-- 1. Nessun giorno senza anno, nessun giorno in due anni --------------------
--    Per ogni sede, dal primo giorno del primo anno all'ultimo giorno dell'ultimo.
SELECT s.scuola_id, g::date AS giorno, count(a.id) AS anni
FROM (SELECT scuola_id, min(inizio) AS da, max(fine) AS a
        FROM public.anni_sede GROUP BY scuola_id) s
CROSS JOIN LATERAL generate_series(s.da, s.a, interval '1 day') g
LEFT JOIN public.anni_sede a
       ON a.scuola_id = s.scuola_id AND g::date <@ a.periodo
GROUP BY s.scuola_id, g::date
HAVING count(a.id) <> 1;


-- 2. Nessuna presenza fuori dal suo anno ------------------------------------
SELECT p.id, p.data, a.inizio, a.fine
FROM public.presenze p
JOIN public.anni_sede a ON a.scuola_id = p.scuola_id AND a.anno_id = p.anno_id
WHERE NOT (p.data <@ a.periodo);

--    La stessa regola su ogni tabella in modo «data» del registro: la sede e la
--    data si trovano come dice anno_tabelle (via_sede, colonna_data). Una riga del
--    risultato = una tabella con righe fuori anno, e quante sono.
SELECT t.tabella, public.anno_righe_fuori_periodo(t.tabella) AS righe
FROM public.anno_tabelle t
WHERE t.modo = 'data'
  AND public.anno_righe_fuori_periodo(t.tabella) > 0;


-- 3. Nessuna doppia frequenza viva per lo stesso bambino nello stesso anno ---
--    (anche fra sedi diverse: un trasferito ha una frequenza «trasferito» e una viva)
SELECT f.alunno_id, f.anno_id, count(*) AS frequenze_vive
FROM public.frequenze f
WHERE f.stato IN ('in_attesa', 'iscritto')
GROUP BY f.alunno_id, f.anno_id
HAVING count(*) > 1;


-- 4. Nessun «iscritto» senza moduli o senza quota ---------------------------
--    Ricalcolato dalla verità, non dai flag moduli_completi / quota_saldata: un
--    flag sbagliato è proprio quello che l'invariante deve trovare. Le frequenze
--    del recupero (origine = 'recupero') sono escluse qui e contate sotto.
SELECT f.id AS frequenza_id,
       mancano.moduli_mancanti,
       (q.id IS NULL OR q.stato <> 'pagato') AS quota_non_saldata
FROM public.frequenze f
LEFT JOIN public.pagamenti q ON q.id = f.quota_pagamento_id
CROSS JOIN LATERAL (
  SELECT count(*) AS moduli_mancanti
  FROM public.moduli_richiesti m
  WHERE m.anno_sede_id = f.anno_sede_id
    AND m.lista = f.tipo
    AND NOT EXISTS (SELECT 1 FROM public.frequenze_moduli fm
                     WHERE fm.frequenza_id = f.id AND fm.modulo_id = m.id)
) mancano
WHERE f.stato = 'iscritto'
  AND f.origine <> 'recupero'
  AND (mancano.moduli_mancanti > 0 OR q.id IS NULL OR q.stato <> 'pagato');

--    4-bis. I flag dicono la verità (vale anche per chi non è «iscritto»).
SELECT f.id AS frequenza_id
FROM public.frequenze f
LEFT JOIN public.pagamenti q ON q.id = f.quota_pagamento_id
WHERE f.quota_saldata IS DISTINCT FROM (q.id IS NOT NULL AND q.stato = 'pagato');

--    Conteggio, non violazione: quante frequenze si reggono sul recupero.
--    SELECT count(*) FROM public.frequenze WHERE origine = 'recupero';


-- 5. Nessuna competenza fuori dal periodo del suo anno ----------------------
SELECT p.id, p.periodo_competenza, a.inizio, a.fine
FROM public.pagamenti p
JOIN public.anni_sede a ON a.scuola_id = p.scuola_id AND a.anno_id = p.anno_id
WHERE p.periodo_competenza IS NOT NULL
  AND NOT (p.periodo_competenza <@ a.periodo);


-- 6. Nessuna modifica di un anno chiuso senza la sua correzione --------------
--    Ogni «com'era» della scatola nera su una riga di un anno in_chiusura o
--    chiuso, scritto dopo il cambio di stato, deve avere un uso di gettone nella
--    stessa transazione, sulla stessa tabella e sulla stessa riga.
--    public.anno_sede_della_riga(tabella, prima) legge la sede e l'anno dal JSON
--    della riga com'era (colonne scuola_id/anno_id, o via_sede del registro).
SELECT m.id AS modifica_id, m.tabella, m.riga_id, m.modificata_il
FROM scatola_nera.modifiche m
JOIN public.anno_tabelle t ON t.tabella = m.tabella
JOIN public.anni_sede a ON a.id = public.anno_sede_della_riga(m.tabella, m.prima)
JOIN LATERAL (
  SELECT min(st.dal) AS dal
  FROM public.anni_sede_stati st
  WHERE st.anno_sede_id = a.id AND st.stato IN ('in_chiusura', 'chiuso')
) chiusura ON chiusura.dal IS NOT NULL
WHERE m.modificata_il >= chiusura.dal
  AND NOT EXISTS (
    SELECT 1 FROM public.correzioni_anno_chiuso c
    WHERE c.transazione = m.transazione
      AND c.tabella = m.tabella
      AND c.riga_id = m.riga_id
      AND c.usata_il IS NOT NULL
  );


-- 7. Nessun genitore vede la classe di un figlio che non è più attivo -------
--    (PR 4.4) Ogni cosa che un genitore vede porta con sé il figlio che gliela
--    fa vedere; quel figlio deve avere una frequenza attiva.
SELECT v.genitore_id, v.oggetto, v.oggetto_id, v.alunno_id
FROM public.visibilita_genitori_motivata() v
WHERE NOT EXISTS (
  SELECT 1 FROM public.frequenze f
  JOIN public.anni_sede a ON a.id = f.anno_sede_id
  WHERE f.alunno_id = v.alunno_id
    AND f.anno_sede_id = public.anno_attivo(a.scuola_id)
    AND f.stato IN ('in_attesa', 'iscritto')
    AND f.data_ingresso <= public.giorno_roma(now())
    AND (f.data_uscita IS NULL OR f.data_uscita >= public.giorno_roma(now()))
);


-- 8. Nessun docente vede una sezione di un anno non ancora passato ----------
--    (PR 4.3)
SELECT u.id AS utente_id, v.section_id, a.stato
FROM public.utenti u
CROSS JOIN LATERAL public.sezioni_visibili_docente(u.id) v
JOIN public.sections s ON s.id = v.section_id
JOIN public.anni_sede a ON a.scuola_id = s.scuola_id AND a.anno_id = s.anno_id
WHERE u.ruolo = 'educator'
  AND a.stato IN ('in_preparazione', 'iscrizioni_aperte');


-- 9. Nessuna riga nuova con una sezione di un altro anno --------------------
--    Solo le righe create dopo l'attivazione dei controlli rigidi (PR 2): le
--    vecchie in contrasto stanno nel rapporto di riconciliazione, contate.
SELECT p.id
FROM public.presenze p
JOIN public.sections s ON s.id = p.section_id
WHERE s.anno_id <> p.anno_id
  AND p.created_at >= (SELECT controlli_rigidi_dal FROM public.anno_regole);
--    E lo stesso per ogni tabella del registro con section_id:
SELECT t.tabella, public.anno_righe_sezione_altro_anno(t.tabella) AS righe
FROM public.anno_tabelle t
WHERE public.anno_righe_sezione_altro_anno(t.tabella) > 0;


-- 10. Il registro e lo schema dicono la stessa cosa -------------------------
--     10a. Una tabella del registro senza colonna anno_id, o senza il trigger.
SELECT t.tabella, 'senza colonna anno_id' AS difetto
FROM public.anno_tabelle t
WHERE to_regclass('public.' || t.tabella) IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                   WHERE c.table_schema = 'public' AND c.table_name = t.tabella
                     AND c.column_name = 'anno_id')
UNION ALL
SELECT t.tabella, 'senza trigger anno_assegna_e_verifica'
FROM public.anno_tabelle t
WHERE to_regclass('public.' || t.tabella) IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pg_trigger tg
                   JOIN pg_proc pr ON pr.oid = tg.tgfoid
                   WHERE tg.tgrelid = to_regclass('public.' || t.tabella)
                     AND pr.proname = 'anno_assegna_e_verifica'
                     AND NOT tg.tgisinternal)
UNION ALL
--     10b. Una tabella con anno_id che il registro non conosce.
SELECT c.table_name, 'anno_id fuori dal registro'
FROM information_schema.columns c
WHERE c.table_schema = 'public' AND c.column_name = 'anno_id'
  AND c.table_name NOT IN (SELECT tabella FROM public.anno_tabelle)
  AND c.table_name NOT IN ('anni_sede');   -- anni_sede È il calendario
--     10c. In produzione (PR 2 in poi) nessuna riga senza anno: si conta con
--          public.anno_righe_senza_anno(tabella) per ogni tabella del registro.


-- 11. Durante la transizione (PR 3 → PR 5): la scheda alunno e la frequenza
--     dell'anno attivo dicono la stessa cosa ------------------------------------
SELECT al.id AS alunno_id
FROM public.alunni al
JOIN public.frequenze f
  ON f.alunno_id = al.id
 AND f.anno_sede_id = public.anno_attivo(al.scuola_id)
WHERE al.section_id IS DISTINCT FROM f.section_id
   OR (al.stato = 'iscritto') IS DISTINCT FROM (f.stato IN ('in_attesa', 'iscritto'))
   OR COALESCE(NULLIF(al.importo_retta_mensile, 0), -1)
      IS DISTINCT FROM COALESCE(f.retta_mensile, -1)
   OR al.retta_a_carico_di IS DISTINCT FROM f.retta_a_carico_di;
--     11-bis. Nomi e uuid delle classi destinatarie dicono la stessa cosa
--     (galleria, avvisi): public.anno_target_divergenti() li conta per tabella.


-- =============================================================================
-- CONSERVAZIONE (si lancia due volte: prima e dopo il riempimento della PR 2)
-- Righe ed euro devono tornare al centesimo. Il rapporto completo, per tabella e
-- per sede, sta in public.riconciliazione_anno.
-- =============================================================================
SELECT 'pagamenti' AS tabella, count(*) AS righe,
       sum(importo) AS euro_importo, sum(importo_pagato) AS euro_pagati
FROM public.pagamenti
UNION ALL
SELECT 'incassi', count(*), sum(importo), NULL FROM public.incassi
UNION ALL
SELECT 'enrollment_submissions', count(*), NULL, NULL FROM public.enrollment_submissions;
