-- =============================================================================
-- L'ETICHETTA DI SELEZIONE INTERNA SULLE CANDIDATURE
--
-- ─── PERCHÉ UNA COLONNA NUOVA, E NON `stato` ────────────────────────────────
--
-- `candidature_insegnanti.stato` NON è un campo che si scrive: dal 2026-08-19 è
-- un AGGREGATO, ricalcolato dal trigger `candidature_ricalcola_stato()` a partire
-- dalle righe di `candidature_sedi`. Un'etichetta scritta lì verrebbe sovrascritta
-- alla prima decisione di una qualunque sede, senza errore e senza log: la
-- Direzione vedrebbe l'etichetta sparire e nessuno saprebbe dire quando.
--
-- E `stato` oggi non distingue niente: misurato il 2026-09-05 sulla produzione,
--     select count(*), count(*) filter (where stato='pending') from candidature_insegnanti;
-- → 461 candidature, di cui 460 `pending` e 1 `rifiutata`. È esattamente il buco
-- che questa colonna riempie: la selezione vive oggi fuori dalla piattaforma.
--
-- ─── PERCHÉ UN VOCABOLARIO CHIUSO, IN DATABASE ──────────────────────────────
--
-- Un `text` libero diventa in tre settimane «già chiamata», «gia chiamata»,
-- «Già chiamata» e «chiamata»: quattro etichette che sono la stessa, e un filtro
-- che ne trova un quarto. Il CHECK è il posto in cui il vocabolario è vero anche
-- per chi scrive da `psql` — lo schema `zod` della rotta difende la porta HTTP,
-- non la tabella.
--
-- ⚠️ IL CHECK AMMETTE `NULL`: «senza etichetta» è lo stato normale di 461 righe
-- su 461, e un CHECK che non lo ammettesse renderebbe la migrazione stessa
-- inapplicabile.
--
-- ─── QUESTA COLONNA NON MANDA NESSUNA EMAIL ─────────────────────────────────
--
-- È una nota di selezione INTERNA, e non deve mai raggiungere la persona che si
-- è candidata: «non idonea» scritto per la segreteria e spedito alla candidata
-- sono due fatti diversi. I tre punti di invio del flusso candidature restano
-- quelli di prima (conferma alla ricezione, copia con CV alla sede, esito solo
-- con `action:'rifiuta'` e casella spuntata): nessuno di essi legge questa
-- colonna, e il lock `__tests__/architecture/etichetta-candidatura-senza-email.test.ts`
-- rende rossa la suite se il modulo della rotta che la scrive arriva — anche
-- transitivamente — a un percorso di invio.
--
-- ─── L'INDICE ───────────────────────────────────────────────────────────────
--
-- PARZIALE su `etichetta is not null`: le righe etichettate sono e resteranno la
-- minoranza (oggi zero), e un indice pieno indicizzerebbe 461 NULL per servire
-- un filtro che i NULL non li cerca mai.
-- =============================================================================

alter table public.candidature_insegnanti
  add column if not exists etichetta text,
  add column if not exists etichetta_aggiornata_il timestamptz,
  -- Stessa forma di `evasa_da`, che è la colonna gemella di questa tabella:
  -- `references utenti(id)` senza `on delete`, così cancellare un'utenza che ha
  -- etichettato viene RIFIUTATO invece di lasciare l'etichetta senza autore.
  add column if not exists etichetta_aggiornata_da uuid references public.utenti(id);

alter table public.candidature_insegnanti
  drop constraint if exists candidature_insegnanti_etichetta_check;

alter table public.candidature_insegnanti
  add constraint candidature_insegnanti_etichetta_check
  check (
    etichetta is null
    or etichetta in ('gia_chiamata', 'non_idonea', 'da_richiamare', 'in_valutazione', 'assunta')
  );

create index if not exists idx_candidature_insegnanti_etichetta
  on public.candidature_insegnanti (etichetta)
  where etichetta is not null;

comment on column public.candidature_insegnanti.etichetta is
  'Etichetta di selezione INTERNA (gia_chiamata | non_idonea | da_richiamare | in_valutazione | assunta). '
  'Non esce mai verso la persona candidata: nessun percorso di invio email la legge. '
  'Non è `stato`, che è l''aggregato ricalcolato dal trigger sulle righe di candidature_sedi.';

comment on column public.candidature_insegnanti.etichetta_aggiornata_il is
  'Quando l''etichetta è stata scritta l''ultima volta. NULL = mai etichettata.';

comment on column public.candidature_insegnanti.etichetta_aggiornata_da is
  'Chi l''ha scritta (utenti.id). Serve a rispondere a «chi l''ha marcata non idonea», '
  'che su una selezione del personale è la domanda che si fa davvero.';
