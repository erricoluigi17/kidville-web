-- =============================================================================
-- CODE ROBUSTE: LA PRESA HA UNA SCADENZA — 2026-10-11
-- Roadmap di robustezza, fase 8
--
-- ─── PERCHÉ ────────────────────────────────────────────────────────────────
-- Il dispatch delle push PRENDE le notifiche prima di spedirle (UPDATE
-- condizionato su `push_inviata_il is null`): niente doppioni fra giri
-- sovrapposti. Ma la presa non scade. Se la Function muore dopo la presa (un
-- timeout, un OOM, un `after()` troncato), quelle notifiche restano marcate e
-- mai spedite: perse, senza una riga che lo dica. La testata di
-- `src/lib/push/dispatch.ts` lo chiama «il prezzo della presa».
--
-- Il digest mensile non ha nessuna presa: due giri sulla stessa edizione (il
-- cron e il bottone «genera») spediscono entrambi, e uno troncato a metà
-- riparte dall'ultimo avanzamento SALVATO, che oggi si salva solo sul 429.
--
-- ─── COSA CAMBIA ───────────────────────────────────────────────────────────
-- 1. `notifiche.push_presa_scade_il`: la presa scrive anche quando scade (il
--    `maxDuration` delle route più un margine). A fine giro le notifiche chiuse
--    si CONFERMANO (colonna di nuovo null); quelle rimesse in coda la perdono
--    insieme a `push_inviata_il`. All'inizio di ogni giro un bidello rimette in
--    coda le prese scadute entro la finestra dei 30 minuti, e lascia marcate
--    (dicendolo) quelle oltre. Indice parziale sulle sole prese aperte: a regime
--    sono zero righe, quindi l'indice è vuoto.
--    `push_inviata_il` resta ciò che sedici file leggono come «non ancora
--    spedita»: non cambia significato.
-- 2. `news_digest_edizioni.presa_scade_il` e `presa_token`: il giro prende
--    l'edizione prima di spedire (scadenza + token), salva l'avanzamento ogni
--    pochi invii e la rilascia a fine giro. Un secondo giro sulla stessa
--    edizione la trova presa e si ferma.
--
-- Solo colonne nullable e un indice: nessun dato toccato, nessuna riscrittura.
--
-- ─── DB DELLA CI (NON MIGRATO) ─────────────────────────────────────────────
-- Il codice degrada: senza le colonne (PGRST204 sull'UPDATE, 42703 sulla
-- SELECT) la presa delle push si fa come prima, senza scadenza, e il digest
-- spedisce senza presa. Una riga `info` lo dice, una volta per giro.
--
-- ─── COME SI VERIFICA ──────────────────────────────────────────────────────
--   select column_name from information_schema.columns
--    where table_schema = 'public'
--      and ((table_name = 'notifiche' and column_name = 'push_presa_scade_il')
--        or (table_name = 'news_digest_edizioni' and column_name in ('presa_scade_il', 'presa_token')));  -- 3 righe
--   select indexname from pg_indexes where indexname = 'idx_notifiche_push_presa_scade_il';                  -- 1 riga
--   -- a regime, nessuna presa aperta da più di 10 minuti:
--   select count(*) from public.notifiche
--    where push_presa_scade_il < now() - interval '10 minutes';                                             -- 0
--
-- ─── ROLLBACK ──────────────────────────────────────────────────────────────
--   drop index if exists public.idx_notifiche_push_presa_scade_il;
--   alter table public.notifiche drop column if exists push_presa_scade_il;
--   alter table public.news_digest_edizioni drop column if exists presa_scade_il,
--     drop column if exists presa_token;
-- Il codice regge l'assenza (è il caso della CI): il rollback non rompe niente.
-- =============================================================================

alter table public.notifiche
  add column if not exists push_presa_scade_il timestamptz;

comment on column public.notifiche.push_presa_scade_il is
  'Fase 8 robustezza: quando scade la presa del dispatch push. Null = nessuna presa aperta (mai presa, confermata o rimessa in coda). Una presa scaduta la rimette in coda il bidello del giro successivo, entro 30 minuti dalla programmazione.';

create index if not exists idx_notifiche_push_presa_scade_il
  on public.notifiche (push_presa_scade_il)
  where push_presa_scade_il is not null;

alter table public.news_digest_edizioni
  add column if not exists presa_scade_il timestamptz,
  add column if not exists presa_token uuid;

comment on column public.news_digest_edizioni.presa_scade_il is
  'Fase 8 robustezza: quando scade la presa del giro che sta spedendo l''edizione. Null = nessun giro in corso.';
comment on column public.news_digest_edizioni.presa_token is
  'Fase 8 robustezza: il token del giro che ha preso l''edizione; avanzamento e rilascio si scrivono solo col proprio token.';

notify pgrst, 'reload schema';
