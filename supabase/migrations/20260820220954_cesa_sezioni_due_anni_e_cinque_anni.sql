-- =============================================================================
-- LE CLASSI DI CESA CHE IN ARCHIVIO NON C'ERANO
--
-- ⚠️ QUESTO FILE È STATO RECUPERATO DAL DATABASE IL 2026-08-23, e il motivo per
-- cui mancava merita una riga. La migrazione era stata APPLICATA in produzione il
-- 2026-08-20 senza che il file entrasse nel repo: da quel giorno il database non
-- era più ricostruibile dai suoi file, e nessuno se n'è accorto per tre giorni.
-- Il lock `migrazioni-complete` esisteva già e non l'ha vista, perché confronta i
-- file con una FOTOGRAFIA delle migrazioni applicate, e quella fotografia era
-- ferma al 16 agosto: la migrazione mancava da entrambi i lati del confronto.
-- È emersa nel momento in cui la fotografia è stata rigenerata.
--
-- Il contenuto qui sotto è quello REALE, riletto da
-- `supabase_migrations.schema_migrations`, non riscritto a memoria.
--
-- ─── IL GUASTO CHE QUESTA MIGRAZIONE CHIUDE ─────────────────────────────────
-- `alunni.classe_sezione` si scrive come TESTO, e a risolvere `section_id` è il
-- trigger `sync_alunno_section_id`, che confronta i nomi senza spazi e senza
-- maiuscole. Quando non trova corrispondenza **lascia NULL e non solleva
-- niente**: l'alunno risulta iscritto e non compare in nessun appello.
--
-- Misurato il 2026-08-20 sul foglio di classe vero di Cesa (255 alunni in 13
-- classi) contro le sezioni in archivio: tre classi non avevano un'omonima.
--
--   foglio                archivio                      bambini nel foglio
--   2 ANNI CONCY          —  (c'era la sola «2 ANNI»)          16
--   2 ANNI AMALIA         —  (idem)                            27
--   5 ANNI GIUSY          «5 ANNI»                             23
--
-- I due anni sono DUE classi con due insegnanti, non una: l'archivio ne aveva
-- una sola perché nessuno le aveva ancora divise. Il foglio è la verità, e
-- l'archivio si allinea al foglio.
--
-- ─── PERCHÉ SI RINOMINA INVECE DI CREARE E BUTTARE ──────────────────────────
-- Rinominare conserva l'`id`: docenti assegnati, orario e ogni riga che punta a
-- quella sezione restano attaccati. Creare la nuova e lasciare la vecchia
-- lascerebbe in giro una sezione fantasma che compare in ogni menù a tendina.
--
-- ─── PERCHÉ SI PUÒ FARE SENZA PAURA, MISURATO ───────────────────────────────
-- Le sezioni di Cesa toccate qui hanno **0 alunni, 0 docenti assegnati e 0
-- presenze** (verificato il 2026-08-20). Non si sposta nessun dato reale: si
-- prepara un archivio vuoto a ricevere i bambini del 22 agosto.
--
-- ─── QUELLO CHE NON SI TOCCA ────────────────────────────────────────────────
-- `NIDO 2026/2027` in archivio è già scritto bene. Nel foglio è `NIDO 2026\2027`
-- con la barra ROVESCIA, e a raddrizzarla è il lettore
-- (`src/lib/iscrizioni/import/elenco.ts`, `classeRiscritta`) — dove il nome
-- della classe NASCE, e non al momento del confronto: quel testo finisce in
-- `alunni.classe_sezione` ed è visibile alle famiglie.
--
-- ─── LA SEDE NON È CABLATA ──────────────────────────────────────────────────
-- Si seleziona per nome, non per uuid: lock `migrazioni-senza-sede-cablata`.
-- Tutto idempotente: rieseguirla non fa niente.
-- =============================================================================

DO $$
DECLARE
  v_cesa uuid;
BEGIN
  SELECT id INTO v_cesa FROM public.scuole WHERE nome = 'Kidville Cesa';

  IF v_cesa IS NULL THEN
    RAISE NOTICE 'Kidville Cesa non esiste in questo ambiente: nessuna sezione toccata';
    RETURN;
  END IF;

  -- «5 ANNI» → «5 ANNI GIUSY». Solo se la destinazione non esiste già.
  UPDATE public.sections
     SET name = '5 ANNI GIUSY'
   WHERE scuola_id = v_cesa
     AND name = '5 ANNI'
     AND NOT EXISTS (
       SELECT 1 FROM public.sections s2
        WHERE s2.scuola_id = v_cesa AND s2.name = '5 ANNI GIUSY'
     );

  -- «2 ANNI» → «2 ANNI CONCY»: la sezione che esisteva diventa la prima delle due.
  UPDATE public.sections
     SET name = '2 ANNI CONCY'
   WHERE scuola_id = v_cesa
     AND name = '2 ANNI'
     AND NOT EXISTS (
       SELECT 1 FROM public.sections s2
        WHERE s2.scuola_id = v_cesa AND s2.name = '2 ANNI CONCY'
     );

  -- «2 ANNI AMALIA»: la seconda, che in archivio non c'è mai stata.
  INSERT INTO public.sections (scuola_id, name, school_type)
  SELECT v_cesa, '2 ANNI AMALIA', 'nido'::public.school_type_enum
   WHERE NOT EXISTS (
     SELECT 1 FROM public.sections s2
      WHERE s2.scuola_id = v_cesa AND s2.name = '2 ANNI AMALIA'
   );
END $$;
