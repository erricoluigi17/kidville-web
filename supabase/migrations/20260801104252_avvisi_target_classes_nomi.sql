-- ═══════════════════════════════════════════════════════════════════════════════
-- Due avvisi che non sono mai arrivati a nessuno
-- Trovato il 2026-08-01 indagando il rilievo S29 del collaudo del 31 luglio.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- IN DUE RIGHE, PER CHI DEVE APPROVARLA
--   COSA FA. In due avvisi, sostituisce il codice interno della classe col NOME
--   della classe. Sono gli unici due in tutto il programma ad avere il codice.
--   COSA NON FA. Non tocca il testo degli avvisi, non ne cancella nessuno, non
--   crea né toglie notifiche, non cambia i permessi. Cambia un solo campo, in due
--   righe su dieci.
--   SE VA STORTO. Il caso peggiore è che i due avvisi restino invisibili come sono
--   oggi: non si può perdere niente, perché oggi non arrivano già a nessuno.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- IL FATTO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- «A chi è indirizzato un avviso» si scrive in `avvisi.target_classes`, e la
-- consegna confronta quel valore con la classe scritta sulla scheda del bambino
-- (`alunni.classe_sezione`), che è un NOME: «TEST Infanzia», «2 ANNI».
--
-- Due avvisi — «Gita al parco di Villa Comunale» (24 luglio) e «Laboratorio di
-- lettura in giardino» (21 luglio) — hanno lì dentro il CODICE INTERNO della
-- sezione invece del nome. Il confronto non trova niente, e l'avviso non compare
-- a nessuno. Misurato in sola lettura il 2026-08-01:
--
--     sezione «TEST Infanzia» di Giugliano → 10 alunni, 10 genitori agganciati
--     destinatari raggiunti da quei due avvisi →  0
--
-- Nessun errore, nessuna riga rossa: gli avvisi risultano pubblicati, e il
-- silenzio è dalla parte delle famiglie, dove nessuno lo collega alla
-- pubblicazione. Sono l'unico caso in tutto il database: gli altri otto avvisi
-- hanno il nome e raggiungono i loro destinatari.
--
-- DA DOVE VENGONO. Non dal programma di oggi: il modulo manda i nomi, e dal 30
-- luglio `POST /api/avvisi` rifiuta con 400 ogni destinatario che non sia una
-- classe di quella sede. Le due righe sono anteriori (21 e 24 luglio) e portano
-- tutte e tre lo stesso microsecondo in `created_at` di un terzo avviso: sono
-- state inserite da uno script di popolamento, non dall'interfaccia. Quello
-- script non sta in questo repository e non è stato ritrovato.
--
-- La strada da cui potevano ancora rientrare — la MODIFICA di un avviso, che il
-- controllo di sede non l'aveva mai avuto — è stata chiusa lo stesso giorno
-- (`src/app/api/avvisi/[id]/route.ts`, lock in
-- `__tests__/api/avvisi-put-classi-per-sede.test.ts`). Questa migrazione ripara i
-- due dati già scritti; il codice impedisce che se ne creino altri.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- COSA FA, PRECISAMENTE
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Per ogni voce di `target_classes` che è il codice di una sezione, la sostituisce
-- col nome di QUELLA sezione, e solo se la sezione appartiene alla STESSA SEDE
-- dell'avviso. Il vincolo di sede non è prudenza formale: i nomi di classe si
-- ripetono fra i tre plessi («2 ANNI» esiste a Giugliano e ad Aversa), e tradurre
-- un codice guardando l'elenco di tutte le sedi potrebbe consegnare un avviso alle
-- famiglie del plesso sbagliato — che è il difetto opposto, e peggiore.
--
-- Le voci che sono già nomi non vengono toccate. Una voce che non corrisponde a
-- nessuna sezione della sede resta com'è: preferisce lasciare visibile un dato
-- sbagliato piuttosto che indovinare a chi andasse mandato l'avviso.
-- ═══════════════════════════════════════════════════════════════════════════════

do $$
declare
  n_prima  integer;
  n_dopo   integer;
begin
  -- Quante voci-codice ci sono, prima di toccare niente.
  select count(*) into n_prima
  from public.avvisi a
  cross join lateral unnest(coalesce(a.target_classes, '{}')) as voce
  join public.sections s
    on s.id::text = voce
   and s.scuola_id = a.scuola_id;

  update public.avvisi a
     set target_classes = tradotte.nuove
    from (
      select a2.id,
             array_agg(
               coalesce(s.name, voce)
               order by ord
             ) as nuove
        from public.avvisi a2
        cross join lateral unnest(coalesce(a2.target_classes, '{}'))
             with ordinality as t(voce, ord)
        left join public.sections s
               on s.id::text = t.voce
              and s.scuola_id = a2.scuola_id
       group by a2.id
      having bool_or(s.id is not null)   -- solo le righe che hanno almeno un codice
    ) as tradotte
   where a.id = tradotte.id;

  -- Quante ne restano: deve essere ZERO, e se non lo è va detto.
  select count(*) into n_dopo
  from public.avvisi a
  cross join lateral unnest(coalesce(a.target_classes, '{}')) as voce
  join public.sections s
    on s.id::text = voce
   and s.scuola_id = a.scuola_id;

  raise notice 'avvisi · destinatari tradotti da codice a nome: % (residui: %)',
    n_prima - n_dopo, n_dopo;
end $$;
