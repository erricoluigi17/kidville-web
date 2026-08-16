-- =============================================================================
-- 20260816205459 — Le decisioni della segreteria sui casi che il programma non
--                  sa risolvere da solo
--
-- ✅ APPLICATA il 2026-08-16, version 20260816205459
--
-- ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
-- L'import delle iscrizioni si ferma, di proposito, su tutto ciò che non ha una
-- risposta certa dentro i dati: due bambini omonimi in due sezioni diverse, un
-- fratellino che nell'elenco non c'è ancora, un nome scritto in un altro modo.
-- Misurato il 2026-08-16 su Giugliano: 25 domande su 196.
--
-- Alcuni di quei casi non avranno MAI una risposta nei dati, perché la risposta
-- ce l'ha una persona. Il 2026-08-16 il titolare ne ha decise due:
--   · dei due bambini omonimi «è indifferente, uno nella B e uno nella C»;
--   · un fratellino di tre mesi, che nell'elenco non compare, «va nel micronido».
--
-- Questa tabella è il posto dove quelle risposte vivono. Non è una comodità: è
-- la differenza fra una decisione TRACCIATA — con chi l'ha presa e quando — e un
-- `if` nel codice che fa la stessa cosa senza dirlo a nessuno, e che fra sei mesi
-- nessuno saprà più spiegare.
--
-- ─── COSA NON CAMBIA ────────────────────────────────────────────────────────
-- Il programma continua a NON indovinare. Una decisione sulla sola classe lascia
-- che la retta arrivi dal foglio (è il caso degli omonimi: la cifra non era in
-- dubbio, mancava solo la sezione); un bambino che nell'elenco non c'è entra solo
-- se la decisione porta ANCHE come si paga. Senza, resta fra i «da controllare».
--
-- ─── NIENTE NOMI IN QUESTO FILE ─────────────────────────────────────────────
-- Le due decisioni vere NON stanno qui: qui c'è solo la tabella. I nomi dei
-- bambini si scrivono come DATI, nel database, perché questo file vive in un
-- repository pubblico — la stessa ragione per cui l'elenco di classe sta in un
-- bucket privato e non fra i sorgenti.
-- =============================================================================

create table if not exists public.iscrizioni_decisioni (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null references public.enrollment_submissions(id) on delete cascade,
  -- Il bambino, riconosciuto per NOME NORMALIZZATO: il codice fiscale può
  -- mancare, e comunque la decisione la scrive una persona guardando un nome.
  -- La normalizzazione è quella di `src/lib/iscrizioni/import/normalizza.ts`, e
  -- chi legge la ri-applica in ogni caso: una chiave scritta con uno spazio di
  -- troppo non deve far ricadere fra i «da controllare» un caso già risolto.
  bambino_norm   text not null,
  classe         text,
  retta          numeric(10,2),
  -- Il nome del fratello che paga per lui. Se valorizzato, la retta scritta
  -- sull'alunno è 0 E si valorizza `alunni.retta_a_carico_di`: lo zero da solo
  -- varrebbe 150 € (v. `20260816200528_retta_a_carico_di_fratello.sql`).
  a_carico_di    text,
  nota           text,
  decisa_da      uuid references public.utenti(id) on delete set null,
  decisa_il      timestamptz not null default now(),
  constraint iscrizioni_decisioni_una_per_bambino unique (submission_id, bambino_norm),
  -- Una decisione che non decide niente non serve a nessuno.
  constraint iscrizioni_decisioni_non_vuota
    check (classe is not null or retta is not null or a_carico_di is not null)
);

create index if not exists iscrizioni_decisioni_domanda_idx
  on public.iscrizioni_decisioni (submission_id);

alter table public.iscrizioni_decisioni enable row level security;

comment on table public.iscrizioni_decisioni is
  'Le risposte che una persona ha dato ai casi che l''import non sa risolvere: quale sezione, quale retta, chi paga. Contiene nomi di minori: RLS attiva senza policy, solo service_role. Una decisione sulla sola classe lascia che la retta continui ad arrivare dall''elenco; un bambino assente dall''elenco entra solo se la decisione dice anche come si paga.';

comment on column public.iscrizioni_decisioni.a_carico_di is
  'Quando è valorizzato, l''alunno entra con importo_retta_mensile = 0 E retta_a_carico_di puntato al fratello. Lo zero da solo non basta: la generazione delle rette lo sostituirebbe con la retta di default della sede (150 €).';

-- ── COME SI VERIFICA CHE ABBIA FUNZIONATO ────────────────────────────────────
--   select count(*) from information_schema.tables
--    where table_name='iscrizioni_decisioni';                                   -- 1
--   select rowsecurity from pg_tables where tablename='iscrizioni_decisioni';   -- true
--   select count(*) from pg_policies where tablename='iscrizioni_decisioni';    -- 0
--   -- e il vincolo che impedisce una decisione vuota:
--   insert into public.iscrizioni_decisioni (submission_id, bambino_norm)
--   values ('00000000-0000-0000-0000-000000000000', 'X');                       -- deve fallire
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
--   drop table if exists public.iscrizioni_decisioni;

notify pgrst, 'reload schema';
