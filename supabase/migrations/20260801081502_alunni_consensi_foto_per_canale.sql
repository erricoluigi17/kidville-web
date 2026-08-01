-- =============================================================================
-- S23 · privacy F4 — I consensi fotografici arrivano a destinazione.
--
-- IL DIFETTO. Il modulo pubblico d'iscrizione chiede TRE consensi fotografici
-- distinti — galleria riservata, sito web, canali social — perché il consenso
-- alla pubblicazione è granulare per canale (provv. Garante 725 del 27/11/2025),
-- e il testo che le famiglie leggono lo dice a chiare lettere. Ma solo il primo
-- aveva una colonna dove atterrare (`alunni.consenso_privacy`): gli altri due,
-- risposti da 141 famiglie, venivano congelati in `enrollment_submissions.
-- consents_log` e poi dimenticati. Nessuna colonna, nessun lettore.
--
-- Non è un dato che manca: è un dato RACCOLTO e poi ignorato. Una famiglia che
-- aveva negato la pubblicazione sui social credeva di averla negata, e nel
-- sistema il suo «no» era indistinguibile dal «sì» della famiglia accanto.
--
-- COSA FA QUESTA MIGRAZIONE.
--  1. Due colonne per bambino, una per canale, `default false` — perché un
--     consenso che non risulta NON è un consenso, mai il contrario.
--  2. Il BACKFILL dalle domande già approvate: i consensi che le famiglie hanno
--     già dato vengono onorati retroattivamente. Aggancio per codice fiscale del
--     minore, e SOLO in salita (mai da `true` a `false`): questa migrazione non
--     può togliere un consenso a nessuno.
--
-- ⚠️ NON APPLICATA da chi l'ha scritta. Va mostrata e approvata dal titolare
--    prima di toccare il database di produzione (regola del 2026-07-31: in
--    produzione ci sono dati reali di minori).
-- ⚠️ Il DB E2E della CI non è migrato: il codice che scrive queste colonne
--    degrada su `PGRST204` (INSERT) e chi le legge tratta il `42703` come
--    «consenso non verificabile» e BLOCCA — vedi `src/lib/news/consenso-foto.ts`.
-- =============================================================================

alter table public.alunni
  add column if not exists consenso_foto_sito boolean not null default false,
  add column if not exists consenso_foto_social boolean not null default false;

comment on column public.alunni.consenso_foto_sito is
  'Consenso alla pubblicazione di fotografie sul SITO WEB della Scuola (canale pubblico, senza login: bucket `news`). Distinto da `consenso_privacy`, che vale per la sola galleria riservata alle famiglie della sezione. Origine: `consenso_foto_sito` del modulo d''iscrizione.';

comment on column public.alunni.consenso_foto_social is
  'Consenso alla pubblicazione di fotografie sui CANALI SOCIAL della Scuola. Distinto dagli altri due: la pubblicazione avviene fuori dai sistemi della Scuola. Origine: `consenso_foto_social` del modulo d''iscrizione.';

comment on column public.alunni.consenso_privacy is
  'Consenso alla pubblicazione di fotografie e video nella GALLERIA RISERVATA alle famiglie della sezione (dentro l''app, dietro login). Origine: `consenso_foto_galleria` del modulo d''iscrizione. Non copre il sito né i social: quelli sono `consenso_foto_sito` e `consenso_foto_social`.';

-- ── Backfill: onorare i consensi già raccolti ────────────────────────────────
-- Solo dalle domande APPROVATE (quelle da cui l'anagrafica è stata creata), e
-- solo dalla PROVA (`consents_log`), mai dal payload grezzo `data`: `data` è ciò
-- che il client ha mandato, `consents_log` è ciò che il server ha verificato e
-- congelato al momento dell'invio.
--
-- L'aggancio è il codice fiscale del minore, normalizzato in maiuscolo: è la
-- stessa chiave con cui l'import fa la deduplica. Nessun uuid di sede compare
-- qui — la sede si deduce dalla domanda, non si scrive a mano.
update public.alunni a
set consenso_foto_sito = true
where a.consenso_foto_sito is distinct from true
  and a.codice_fiscale is not null
  and exists (
    select 1
    from public.enrollment_submissions es
    cross join lateral jsonb_array_elements(coalesce(es.data -> 'children', '[]'::jsonb)) as c
    where es.status = 'approved'
      and es.scuola_id = a.scuola_id
      and upper(trim(c ->> 'codice_fiscale')) = upper(trim(a.codice_fiscale))
      and exists (
        select 1
        from jsonb_array_elements(coalesce(es.consents_log -> 'blocchi', '[]'::jsonb)) as b
        where b ->> 'field_id' = 'consenso_foto_sito'
          and (b ->> 'accepted')::boolean is true
      )
  );

update public.alunni a
set consenso_foto_social = true
where a.consenso_foto_social is distinct from true
  and a.codice_fiscale is not null
  and exists (
    select 1
    from public.enrollment_submissions es
    cross join lateral jsonb_array_elements(coalesce(es.data -> 'children', '[]'::jsonb)) as c
    where es.status = 'approved'
      and es.scuola_id = a.scuola_id
      and upper(trim(c ->> 'codice_fiscale')) = upper(trim(a.codice_fiscale))
      and exists (
        select 1
        from jsonb_array_elements(coalesce(es.consents_log -> 'blocchi', '[]'::jsonb)) as b
        where b ->> 'field_id' = 'consenso_foto_social'
          and (b ->> 'accepted')::boolean is true
      )
  );
