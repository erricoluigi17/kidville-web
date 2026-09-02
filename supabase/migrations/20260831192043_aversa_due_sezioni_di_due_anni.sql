-- =============================================================================
-- AVERSA: LE SEZIONI DI DUE ANNI SONO DUE, E IN ARCHIVIO CE N'ERA UNA
--
-- ─── IL GUASTO CHE QUESTA MIGRAZIONE CHIUDE ─────────────────────────────────
-- `alunni.classe_sezione` si scrive come TESTO, e a risolvere `section_id` è il
-- trigger `sync_alunno_section_id`, che confronta i nomi senza spazi e senza
-- maiuscole. Quando non trova corrispondenza **lascia NULL e non solleva
-- niente**: l'alunno risulta iscritto e non compare in nessun appello.
--
-- È lo stesso guasto già pagato a Cesa il 2026-08-20
-- (`20260820220954_cesa_sezioni_due_anni_e_cinque_anni.sql`), e ad Aversa è
-- costato di più: al 2026-08-31 la sede ha **73 alunni** con
-- `classe_sezione = 'RETTE'` e `section_id = NULL`, creati dal cron fra il 27 e
-- il 31 agosto, e **87 inviti credenziali già spediti** alle loro famiglie. I
-- bambini sono in app e non sono in nessun registro.
--
-- ─── PERCHÉ IL FOGLIO DICEVA «RETTE» ────────────────────────────────────────
-- `elenco_rette_aversa.xlsx` (caricato il 26/08) è **un foglio solo**, chiamato
-- `RETTE`, con due colonne e i nomi delle sezioni scritti **come righe in mezzo
-- ai nomi dei bambini**, precedute da una riga vuota. `leggiElenco` lo legge in
-- Forma A — dove il nome del foglio *è* la classe — e ha quindi scritto
-- `classe = 'RETTE'` su tutte e 117 le righe.
--
-- ─── LE SEI SEZIONI, MISURATE E NON INDOVINATE ──────────────────────────────
-- I confini dei sei blocchi si ricavano dalle righe di intestazione rimaste in
-- `iscrizioni_elenco_righe` (colonna B = «RETTA»), e la prima è la riga 1 del
-- foglio, letta dal file originale nel bucket: dice «MERAVIGLIE».
--
-- Che ogni blocco sia la fascia d'età che dice di essere è **misurato due volte**:
--
--   1. sulle date di nascita dei bambini di ciascun blocco (2026/27);
--   2. sull'export del vecchio registro (2025/26), dove la stessa sede aveva
--      SEI sezioni e ognuna teneva l'anno di nascita **precedente**. Il nome
--      resta attaccato alla fascia d'età, non alla coorte: i bambini salgono,
--      il nome no.
--
--   foglio 2026/27      nati    stessa sezione nel 2025/26   diventa
--   MERAVIGLIE          2025    2024 · 33 bambini            NIDO
--   SEZIONE SOGNI       2024    2023 · 24                    2 ANNI A
--   SEZIONE ABBRACCI    2024    2023 · 21                    2 ANNI B   ← nuova
--   SEZ RACCONTI        2023    2022 · 24                    3 ANNI
--   SEZ SCINTILLE       2022    2021 · 14                    4 ANNI
--   PICCOLI SAPIENTI    2021    2020 ·  8                    5 ANNI
--
-- ⚠️ SI PERDE UNA COSA, E VA SCRITTA QUI PERCHÉ NON SI PERDA DEL TUTTO. La
-- convenzione scelta dal titolare è quella di Giugliano — solo la fascia d'età —
-- e i nomi che le famiglie di Aversa usano da anni (MERAVIGLIE, SOGNI,
-- ABBRACCI, RACCONTI, SCINTILLE, PICCOLI SAPIENTI) restano solo in questo
-- commento e nel PRD. La tabella qui sopra è l'unico posto in cui la
-- corrispondenza è scritta: chi un giorno volesse rimettere i nomi veri riparta
-- da lì, non dall'ordine del foglio, che non è una prova.
--
-- ⚠️ SECONDA COSA DA SAPERE: `2 ANNI B` — 6 bambini, retta uniforme 300, mentre
-- `2 ANNI A` ne ha 21 con rette da 220 a 480 — ha la forma di una **sezione
-- primavera**, che è un servizio autorizzato a sé e non una semplice seconda
-- classe di pari età. Se lo è, il nome andrà rivisto: qui si registra il dubbio,
-- non lo si risolve inventando.
--
-- ─── PERCHÉ SI RINOMINA INVECE DI CREARE E BUTTARE ──────────────────────────
-- Rinominare conserva l'`id`: docenti assegnati, orario e ogni riga che punta a
-- quella sezione restano attaccati. Creare la nuova e lasciare la vecchia
-- lascerebbe in giro una sezione fantasma in ogni menù a tendina — e per via di
-- `alunni_section_id_fkey ON DELETE SET NULL`, cancellarla rimetterebbe a NULL
-- proprio ciò che stiamo riparando.
--
-- ─── PERCHÉ SI PUÒ FARE SENZA PAURA, MISURATO IL 2026-08-31 ─────────────────
-- Le cinque sezioni di Aversa hanno **0 alunni, 0 docenti assegnati e 0 materie
-- assegnate**: `section_id` è NULL su tutti e 73 gli alunni della sede, che è
-- esattamente il guasto. Non si sposta nessun dato reale.
--
-- ─── QUELLO CHE NON SI TOCCA ────────────────────────────────────────────────
-- `NIDO`, `3 ANNI`, `4 ANNI`, `5 ANNI` sono già scritte bene e restano come
-- sono, con il loro `id`. Questa migrazione fa due sole cose.
--
-- Questa migrazione NON tocca `alunni`: la bonifica dei 73 sta in uno script con
-- anteprima (`scripts/riallinea-classi-aversa.mjs`), dove si guarda prima di
-- applicare. Una migrazione descrive lo schema e le sezioni, non bonifica i dati
-- di una sede.
--
-- ─── LA SEDE NON È CABLATA ──────────────────────────────────────────────────
-- Si seleziona per nome, non per uuid: lock `migrazioni-senza-sede-cablata`.
-- Tutto idempotente: rieseguirla non fa niente.
-- =============================================================================

DO $$
DECLARE
  v_aversa uuid;
BEGIN
  SELECT id INTO v_aversa FROM public.scuole WHERE nome = 'Kidville Aversa';

  IF v_aversa IS NULL THEN
    RAISE NOTICE 'Kidville Aversa non esiste in questo ambiente: nessuna sezione toccata';
    RETURN;
  END IF;

  -- «2 ANNI» → «2 ANNI A»: la sezione che esisteva diventa la prima delle due.
  -- Nel foglio è SEZIONE SOGNI, 21 bambini, nati in prevalenza nel 2024.
  UPDATE public.sections
     SET name = '2 ANNI A'
   WHERE scuola_id = v_aversa
     AND name = '2 ANNI'
     AND NOT EXISTS (
       SELECT 1 FROM public.sections s2
        WHERE s2.scuola_id = v_aversa AND s2.name = '2 ANNI A'
     );

  -- «2 ANNI B»: la seconda, che in archivio non c'è mai stata.
  -- Nel foglio è SEZIONE ABBRACCI, 6 bambini, nati in prevalenza nel 2024.
  INSERT INTO public.sections (scuola_id, name, school_type)
  SELECT v_aversa, '2 ANNI B', 'nido'::public.school_type_enum
   WHERE NOT EXISTS (
     SELECT 1 FROM public.sections s2
      WHERE s2.scuola_id = v_aversa AND s2.name = '2 ANNI B'
   );
END $$;
