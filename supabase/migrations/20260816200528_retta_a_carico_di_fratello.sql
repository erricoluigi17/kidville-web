-- =============================================================================
-- 20260816200528 — La retta a carico di un fratello, e lo zero che valeva 150 €
--
-- ✅ APPLICATA il 2026-08-16, version 20260816200528
--
-- ─── IL FATTO, MISURATO IL 2026-08-16 ───────────────────────────────────────
-- Nell'elenco di classe che la segreteria prepara per le iscrizioni 2026/27,
-- 36 righe su 338 (sede di Giugliano) non hanno una cifra accanto al nome ma un
-- rimando: «vedi fratello», «vedi sor micronido», «VEDI SORELA». Significa una
-- cosa precisa, confermata dal titolare: la cifra scritta accanto a UN figlio è
-- la retta di TUTTA la famiglia, e gli altri figli non pagano nulla.
--
-- ─── PERCHÉ NON BASTAVA SCRIVERE ZERO ───────────────────────────────────────
-- «Non paga nulla» sembrava scriversi `alunni.importo_retta_mensile = 0`.
-- Non è così, e il perché sta dentro la funzione che genera le rette mensili:
--
--     COALESCE(NULLIF(al.importo_retta_mensile, 0), s.retta_default_importo, 150)
--
-- `NULLIF(…, 0)` **annulla lo zero**, e al suo posto entra il default della
-- sede. Misurato lo stesso giorno su `admin_settings`: per tutte e tre le sedi
-- vale **150,00 €** (`rette_config` NULL ovunque, `retta_auto_enabled` true
-- ovunque). Scrivere zero avrebbe generato 150 € al mese, per dieci mesi, a
-- ciascuno dei bambini che non devono pagare niente — senza un errore, senza un
-- log, senza che nessuno se ne accorgesse fino alla prima telefonata.
--
-- La stessa formula vive in due strade: qui in SQL e nel gemello TypeScript
-- dell'anteprima (`src/app/api/pagamenti/genera-rette/route.ts:52-55`, che fa
-- `personalizzato > 0 ? personalizzato : rettaDefault`). Entrambe cambiano in
-- questo stesso lavoro: se cambiasse una sola, l'anteprima mostrerebbe rette che
-- la conferma non genera, ed è il tipo di divergenza che qui è già costata ore.
--
-- ─── PERCHÉ LA FUNZIONE SI MODIFICA E NON SI RICOPIA ────────────────────────
-- Il corpo di `genera_rette_mensili` sono 180 righe che questo file NON
-- ricopia. Ricopiarle significherebbe portarsi dietro una seconda versione della
-- funzione più delicata del prodotto — quella che decide quanto paga ogni
-- famiglia — e sperare che le due restino d'accordo per sempre.
--
-- Si aggiunge una riga sola, ancorata a una stringa che nel corpo compare
-- ESATTAMENTE una volta (verificato il 2026-08-16 sia sul file
-- `20260731115341_genera_rette_per_sede.sql` sia su `pg_get_functiondef` in
-- produzione: coincidevano). Se l'ancora un giorno non ci fosse più, o se dopo
-- la sostituzione il filtro non risultasse presente, questa migrazione **muore
-- rumorosamente** invece di lasciare il database in uno stato che sembra a
-- posto: è tutto il senso dei due `RAISE EXCEPTION` qui sotto.
-- =============================================================================

-- ── 1. La colonna ────────────────────────────────────────────────────────────

alter table public.alunni
  add column if not exists retta_a_carico_di uuid
    references public.alunni(id) on delete set null;

create index if not exists alunni_retta_a_carico_di_idx
  on public.alunni (retta_a_carico_di)
  where retta_a_carico_di is not null;

comment on column public.alunni.retta_a_carico_di is
  'Quando è valorizzata, la retta mensile di questo alunno è a carico del fratello indicato e NON gli si genera nessuna retta. Esiste perché «non paga» non si può scrivere con importo_retta_mensile = 0: la generazione fa COALESCE(NULLIF(importo,0), retta_default_importo, 150), quindi lo zero diventa la retta di default della sede — 150 € al 2026-08-16 su tutte e tre le sedi. Chi la valorizza mette anche importo_retta_mensile a 0: l''alunno è escluso a monte dalla generazione, e lo zero resta come segno leggibile nella sua scheda.';

-- ── 2. La generazione delle rette la rispetta ────────────────────────────────

do $$
declare
  v_def text;
  v_ancora constant text := 'AND al.scuola_id = p_scuola_id';
  v_nuovo constant text :=
    'AND al.scuola_id = p_scuola_id' || chr(10) ||
    '      -- RETTA A CARICO DI UN FRATELLO: la cifra del foglio è la retta di tutta' || chr(10) ||
    '      -- la famiglia, scritta su un figlio solo. Gli altri non pagano nulla, e' || chr(10) ||
    '      -- «nulla» NON si scrive con importo 0 — il COALESCE qui sopra lo' || chr(10) ||
    '      -- trasformerebbe nella retta di default della sede (150 €).' || chr(10) ||
    '      AND al.retta_a_carico_di IS NULL';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'genera_rette_mensili'
     and pg_get_function_identity_arguments(p.oid) = 'p_periodo date, p_scuola_id uuid';

  if v_def is null then
    raise exception 'genera_rette_mensili(date, uuid) non trovata: la migrazione 20260731115341 non è applicata su questo database';
  end if;

  -- Già fatto: la migrazione è idempotente e non tocca niente.
  if position('retta_a_carico_di' in v_def) > 0 then
    raise notice 'genera_rette_mensili contiene già il filtro: niente da fare';
    return;
  end if;

  -- L'ancora deve esserci UNA volta sola. Zero o due significa che il corpo è
  -- cambiato sotto i piedi, e a quel punto va guardato da una persona.
  if (length(v_def) - length(replace(v_def, v_ancora, ''))) / length(v_ancora) <> 1 then
    raise exception 'genera_rette_mensili: l''ancora «%» non compare esattamente una volta — il corpo della funzione è cambiato, la sostituzione va rifatta a mano', v_ancora;
  end if;

  v_def := replace(v_def, v_ancora, v_nuovo);
  execute v_def;

  -- Non ci si fida della replace: si rilegge dal catalogo.
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'genera_rette_mensili'
     and pg_get_function_identity_arguments(p.oid) = 'p_periodo date, p_scuola_id uuid';

  if position('retta_a_carico_di IS NULL' in v_def) = 0 then
    raise exception 'genera_rette_mensili: il filtro non risulta applicato dopo la sostituzione';
  end if;
end $$;

comment on function public.genera_rette_mensili(date, uuid) is
  'Genera le rette del mese per UNA sede. Dal 2026-08-16 salta gli alunni con retta_a_carico_di valorizzato: sono i figli la cui retta è scritta, nell''elenco della segreteria, sul nome di un fratello. Lo stesso filtro vive nell''anteprima TypeScript (src/app/api/pagamenti/genera-rette/route.ts): le due strade cambiano insieme, altrimenti l''anteprima promette rette che la conferma non genera.';

-- ── COME SI VERIFICA CHE ABBIA FUNZIONATO ────────────────────────────────────
--   select count(*) from information_schema.columns
--    where table_name='alunni' and column_name='retta_a_carico_di';              -- 1
--   select position('retta_a_carico_di IS NULL' in pg_get_functiondef(oid)) > 0
--     from pg_proc where proname='genera_rette_mensili';                         -- true
--   -- e la prova che conta: un alunno con retta_a_carico_di NON prende la retta
--   select count(*) from public.alunni where retta_a_carico_di is not null;      -- 0 oggi
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
--   Riapplicare `20260731115341_genera_rette_per_sede.sql` (ricrea la funzione
--   senza il filtro), poi:
--     alter table public.alunni drop column if exists retta_a_carico_di;

notify pgrst, 'reload schema';
