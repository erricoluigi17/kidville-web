-- =============================================================================
-- ARCHIVIARE INVECE DI CANCELLARE — il ciclo di vita che mancava all'alunno
--
-- ✅ APPLICATA il 2026-08-12, version `20260812194517`.
--    Verificato DOPO: le sei colonne ci sono tutte, il CHECK sul motivo c'è, e
--    `get_advisors(security)` → 0 ERROR senza WARN nuovi.
--    Nome file allineato alla versione registrata in
--    `supabase_migrations.schema_migrations`.
--
-- IL PERCHÉ — misurato in produzione il 2026-08-12
--    Il pulsante «Elimina Alunno (GDPR)» falliva. Non a volte: quasi sempre.
--        11:17:24, 11:17:53, 11:18:07 UTC — tre tentativi, ruolo admin,
--        alunno 96399f3e-… → PostgREST 23503 su `valutazioni_alunno_id_fkey` → 409.
--    `alunni` ha 28 foreign key entranti; 21 hanno `ON DELETE CASCADE` e SETTE no:
--        valutazioni · pagamenti · legame_genitori_alunni · eventi_diario ·
--        armadietto · ticket_mensa · note_disciplinari
--    Sui dati veri: 33 alunni, di cui 28 con pagamenti, 28 con legami, 18 con ticket
--    mensa, 11 con voci di diario, 6 con valutazioni, 5 con note.
--        → 28 alunni su 33 NON ERANO CANCELLABILI. Il bottone era una promessa
--          che il database non poteva mantenere.
--
-- E LA CANCELLAZIONE NON È LA RISPOSTA GIUSTA, nemmeno aggiungendo i cascade.
--    Registri didattici e pagamenti si conservano dieci anni. Ma il nome del bambino
--    esiste in UN POSTO SOLO — `alunni.nome`/`cognome` — e tutto il resto punta a un
--    `alunno_id`. Quindi cancellare (o anonimizzare) l'anagrafica rende illeggibili
--    in un colpo solo i registri di OGNI anno, passati compresi.
--    Da qui il modello a due tempi, deciso dal titolare il 2026-08-12:
--       1. ARCHIVIA  — l'anagrafica resta INTATTA (nome, cognome, codice fiscale),
--                      così registri e pagamenti restano leggibili. Il bambino esce
--                      dagli elenchi operativi. È REVERSIBILE.
--       2. LIBERA SPAZIO — da quell'elenco, e solo da lì: se ne vanno foto, video e
--                      messaggi. Restano pagamenti, presenze, voti, pagelle, note,
--                      diario e certificati medici.
--    Nessuna foreign key viene toccata da questo lavoro. Non servono.
--
-- LA LEVA VERA NON È LO STATO — ed è la misura che ha riscritto il piano.
--    `from('alunni')` compare 181 volte in 117 file; `.eq('stato','iscritto')`
--    dodici. Contare sullo stato avrebbe lasciato cieca l'app in un centinaio di
--    punti. La leva è lo SGANCIAMENTO DALLA CLASSE: `section_id` e `classe_sezione`
--    a NULL fanno sparire il bambino da tutte le query per sezione — che sono la
--    maggioranza — con un UPDATE solo. Da qui le due colonne che ricordano da dove
--    veniva, senza le quali il ritorno fra gli iscritti sarebbe un indovinello.
-- =============================================================================

begin;

alter table public.alunni
  add column archiviato_il            timestamptz,
  add column archiviato_da            uuid,
  add column archiviato_motivo        varchar(30),
  add column archiviato_section_id    uuid,
  add column archiviato_classe_sezione varchar(50),
  add column spazio_liberato_il       timestamptz;

-- Insieme CHIUSO, mai testo libero.
-- Un campo libero sulla scheda di un minore è una PII nuova che nessuna lista bianca
-- sorveglia: finirebbe nei log, negli export e nell'audit senza che nessuno l'abbia
-- deciso. Quattro voci coprono i casi reali; la quinta è «altro» e non chiede di
-- spiegarsi.
alter table public.alunni
  add constraint alunni_archiviato_motivo_check
    check (archiviato_motivo is null
           or archiviato_motivo in ('ritiro', 'fine_ciclo', 'trasferimento', 'altro'));

-- ⚠️ NESSUN CHECK SU `alunni.stato`.
--    Verificato prima di scrivere: non ne esiste uno, e i valori usati dalle tendine
--    sono 'iscritto' | 'ritirato' | 'sospeso' (`StudentDetailPanel.tsx:638-641`).
--    Aggiungerne uno adesso significherebbe scommettere che nessuna riga storica
--    porti un valore fuori elenco — e una migrazione che fallisce a metà su una
--    tabella di 33 minori non è il modo di scoprirlo.

comment on column public.alunni.archiviato_il is
  'Quando l''alunno è stato spostato fra i «non più iscritti». NULL = è fra gli '
  'iscritti. Insieme a `stato` = ''ritirato'': lo stato dice COSA, questa dice QUANDO. '
  'L''archiviazione NON anonimizza: nome, cognome e codice fiscale restano intatti, ed '
  'è il punto di tutto il modello — i registri e i pagamenti devono restare leggibili '
  'per dieci anni.';

comment on column public.alunni.archiviato_da is
  'Chi ha archiviato (`utenti.id`). Nessuna FK, per la stessa ragione di `sospeso_da`: '
  'la traccia deve sopravvivere alla cancellazione dell''account che l''ha lasciata.';

comment on column public.alunni.archiviato_motivo is
  'Insieme chiuso: ritiro | fine_ciclo | trasferimento | altro. Mai testo libero — '
  'vedi il CHECK e la ragione scritta accanto.';

comment on column public.alunni.archiviato_section_id is
  'La sezione da cui il bambino è stato sganciato, ricordata per il ritorno. '
  'All''archiviazione `alunni.section_id` va a NULL: è QUELLO che lo fa sparire dagli '
  'elenchi per sezione, non lo stato.';

comment on column public.alunni.archiviato_classe_sezione is
  'Il nome della classe al momento dell''archiviazione, per il ritorno e per l''elenco '
  '(«Era in: 3 ANNI»). ⚠️ Può essere STANTIO: la classe può essere stata rinominata o '
  'cancellata nel frattempo. Chi riattiva deve verificare che esista ancora e, se non '
  'esiste, riattivare SENZA classe dicendolo — mai indovinare una sezione, perché un '
  'bambino nella sezione sbagliata è invisibile a chi lo cerca in quella giusta.';

comment on column public.alunni.spazio_liberato_il is
  'Quando sono stati cancellati foto, video e messaggi. NULL = non è mai stato fatto. '
  'Si scrive SOLO se ogni file è uscito davvero dal bucket: se anche uno solo resta, '
  'la colonna non si valorizza e l''operazione resta ripetibile. Un timestamp che '
  'dichiara un lavoro non finito è peggio di nessun timestamp.';

commit;

-- =============================================================================
-- COSA QUESTA MIGRAZIONE NON FA
--
--   • NON tocca nessuna delle 28 foreign key di `alunni`. Il modello a due tempi
--     esiste proprio per non doverle toccare: aggiungere `ON DELETE CASCADE` a
--     `pagamenti` significherebbe cancellare scritture contabili — e su quelle righe
--     ci sono `fattura_aruba_id`, `fattura_pdf_path`, `fattura_emessa_il`.
--
--   • NON accende RLS e non crea policy: `alunni` ha già `relrowsecurity = true` e le
--     route admin girano col service_role. La fotografia RLS non va rigenerata.
--
--   • NON crea indici. Gli archiviati si leggono da `/admin/students?stato=ritirato`,
--     che filtra già per sede su una tabella di 33 righe: un indice qui sarebbe
--     manutenzione senza un guadagno misurabile. Quando gli archiviati saranno
--     centinaia, l'indice giusto sarà `(scuola_id, stato)` — non `(archiviato_il)`.
-- =============================================================================
