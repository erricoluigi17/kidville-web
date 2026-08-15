-- =============================================================================
-- LE POSIZIONI DELLA CANDIDATURA — e il curriculum che finalmente si allega.
--
-- Il modulo pubblico `/lavora-con-noi` chiedeva una cosa sola su «che lavoro
-- vieni a fare»: le FASCE D'ETÀ (`gradi`, obbligatorie). Dava cioè per scontato
-- che chi si candida sia un'insegnante. Dal 2026-08-15 non è più così: si
-- candidano anche collaboratrici scolastiche, cuoche, segretarie e un «altro»
-- scritto a mano.
--
-- ── PERCHÉ UNA COLONNA NUOVA E NON UN RIUSO DI `gradi` ───────────────────────
--
-- Perché sono due fatti diversi e uno dei due può mancare. `gradi` è
-- `school_type_enum[]`, cioè un elenco chiuso di TRE fasce didattiche: una cuoca
-- non ne ha nessuna, e infilarcela dentro vorrebbe dire allargare l'enum delle
-- fasce con valori che fasce non sono — e con quell'enum ci lavorano `utenti`,
-- `sections` e mezza applicazione.
--
-- `gradi` RESTA e resta popolata: è ciò che `admin/candidature-insegnanti:PATCH`
-- travasa in `utenti.gradi` quando approva. Cambia CHI la scrive — non più il
-- client, ma la route, che la DERIVA dalle posizioni (`gradiDallePosizioni` in
-- `src/lib/forms/insegnanti-template.ts`). Da oggi in quella colonna non entra
-- più un valore che arriva da fuori: il `22P02 invalid input value for enum` che
-- la route pubblica doveva difendere diventa inesprimibile invece che difeso.
--
-- ── ⚠️ `cardinality()` E NON `array_length()`, ED È IL PUNTO DI QUESTA MIGRAZIONE
--
-- Il `CHECK` di `gradi` è `array_length(gradi, 1) >= 1` e NON FA QUELLO CHE DICE:
-- su un array vuoto `array_length` vale NULL, e un CHECK che vale NULL PASSA.
-- Misurato in produzione il 2026-08-10, non dedotto:
--
--     select (array_length('{}'::text[], 1) >= 1);                    --> NULL
--     create temp table t (g text[] not null default '{}'
--                          check (array_length(g, 1) >= 1));
--     insert into t default values;                                   --> 1 riga, `{}`
--
-- Sommato a `not null default '{}'`, quel vincolo lasciava entrare in silenzio
-- una candidatura senza nessuna fascia. `cardinality('{}')` invece vale `0`, e
-- `0 >= 1` è FALSO: il CHECK scatta davvero. La regola qui sotto è la stessa
-- frase di quella, scritta in modo che sia vera.
--
-- Il vincolo di `gradi` NON si corregge qui, e non è una dimenticanza: da oggi
-- `gradi` VUOTO è un valore LEGITTIMO — è ciò che ha una cuoca — e stringerlo
-- respingerebbe esattamente le candidature che questo lavoro esiste per
-- accogliere. Il presidio si è spostato su `posizioni`, dove «almeno una» è vero.
--
-- ── PERCHÉ `text[]` CON UN `CHECK` E NON UN ENUM ─────────────────────────────
--
-- L'elenco delle posizioni è di PRODOTTO e cambierà più spesso dello schema (una
-- fascia nuova, un mestiere nuovo). Un enum obbliga a un `alter type` per ogni
-- voce; un `CHECK` di appartenenza dà la stessa garanzia con un `alter table`, e
-- l'errore che produce (`23514`) non è peggiore del `22P02` dell'enum. Nessuno
-- dei due deve mai arrivare a chi compila: la route filtra con uno `z.enum`
-- costruito su `POSIZIONI_AMMESSE`, e questo CHECK è l'ultima rete.
--
-- ⚠️ CHI AGGIUNGE UNA POSIZIONE la aggiunge in TRE posti, e il terzo è questo
-- file: `POSIZIONI_OPTIONS` (template), il `CHECK` qui sotto, e — se è una
-- fascia — `GRADI_OPTIONS` più l'enum `school_type_enum`. Non è affidato alla
-- buona volontà: `__tests__/lib/insegnanti-template.test.ts` LEGGE questo file e
-- confronta le due liste. Divergere è un test rosso, non una scoperta in
-- produzione.
--
-- ── L'INDICE UNICO SU `cv_path`, che chiude una porta aperta ─────────────────
--
-- Vedi il suo commento più sotto: senza, due candidature possono dichiarare lo
-- stesso curriculum, e il pannello di Segreteria ne risolve UNA A CASO — cioè
-- firma, a chi guarda la sede A, il curriculum di chi si era proposto alla
-- sede B, e attribuisce la lettura alla candidatura sbagliata.
-- =============================================================================

-- ── 1. LE DUE COLONNE ───────────────────────────────────────────────────────
alter table public.candidature_insegnanti
  add column if not exists posizioni       text[] not null default '{}',
  add column if not exists posizione_altro text;

-- ── 2. IL BACKFILL, PRIMA DEI VINCOLI ───────────────────────────────────────
--
-- Le righe già in tabella non hanno posizioni (la colonna nasce adesso) e il
-- vincolo «almeno una» le respingerebbe. Si ricostruiscono dalle fasce, che è
-- l'unica cosa che quelle candidature hanno detto: `{nido}` -> `{insegnante_nido}`.
--
-- MISURATO in produzione il 2026-08-15, prima di scrivere: la tabella contiene
-- UNA riga, `pending`, con `gradi = {nido}`. Il ramo `else` qui sotto — una riga
-- senza nessuna fascia — oggi non tocca niente; c'è perché una candidatura senza
-- fasce ERA esprimibile (vedi il `CHECK` che non scattava, in testa a questo
-- file) e una migrazione che fallisse su una riga del genere lascerebbe lo
-- schema a metà. Quel caso diventa «altro», detto com'è: non si inventa un
-- mestiere che nessuno ha dichiarato.
update public.candidature_insegnanti
   set posizioni = case
         when cardinality(gradi) > 0
           then (select array_agg('insegnante_' || g::text order by g::text) from unnest(gradi) as g)
         else array['altro']::text[]
       end,
       posizione_altro = case
         when cardinality(gradi) > 0 then posizione_altro
         else coalesce(posizione_altro, 'non indicata (candidatura precedente al 2026-08-15)')
       end
 where cardinality(posizioni) = 0;

-- ── 3. I VINCOLI ────────────────────────────────────────────────────────────
--
-- `add constraint if not exists` non esiste in Postgres: il guardiano è la
-- lettura di `pg_constraint`, così la migrazione è rieseguibile.
do $$
begin
  -- Almeno una posizione. Con `cardinality`, non con `array_length`.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.candidature_insegnanti'::regclass
       and conname = 'candidature_insegnanti_posizioni_almeno_una'
  ) then
    alter table public.candidature_insegnanti
      add constraint candidature_insegnanti_posizioni_almeno_una
      check (cardinality(posizioni) >= 1);
  end if;

  -- Appartenenza: l'elenco è chiuso. `<@` è «contenuto in».
  -- ⚠️ Questa lista è la stessa di `POSIZIONI_OPTIONS` in
  -- `src/lib/forms/insegnanti-template.ts`, e un test la confronta leggendo
  -- QUESTO file: le tre voci docenti sono `insegnante_` + i valori di
  -- `school_type_enum` (nido, infanzia, primaria).
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.candidature_insegnanti'::regclass
       and conname = 'candidature_insegnanti_posizioni_note'
  ) then
    alter table public.candidature_insegnanti
      add constraint candidature_insegnanti_posizioni_note
      check (posizioni <@ array[
        'insegnante_nido',
        'insegnante_infanzia',
        'insegnante_primaria',
        'collaboratrice',
        'cuoca',
        'segreteria',
        'altro'
      ]::text[]);
  end if;

  -- Il testo libero è un NOME DI MESTIERE, non un tema: cento caratteri.
  -- Lo stesso numero sta in `CANDIDATURA_LIMITI.maxPosizioneAltro`, che è ciò
  -- che il modulo applica sotto il campo. Qui è l'ultima rete.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.candidature_insegnanti'::regclass
       and conname = 'candidature_insegnanti_posizione_altro_lunghezza'
  ) then
    alter table public.candidature_insegnanti
      add constraint candidature_insegnanti_posizione_altro_lunghezza
      check (posizione_altro is null or length(posizione_altro) <= 100);
  end if;

  -- COERENZA fra la casella e il testo, nei DUE versi.
  --
  -- «altro» spuntato senza testo è una candidatura che non dice che lavoro
  -- cerca — cioè il caso per cui la casella esiste. Testo senza «altro»
  -- spuntato è un residuo: chi compila spunta «Altro», scrive, poi cambia idea
  -- e toglie la spunta. Il modulo lo pulisce (`pulisciNascosti`), ma il modulo
  -- è una delle due porte: questa riga vale anche per l'altra.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.candidature_insegnanti'::regclass
       and conname = 'candidature_insegnanti_posizione_altro_coerente'
  ) then
    alter table public.candidature_insegnanti
      add constraint candidature_insegnanti_posizione_altro_coerente
      check (('altro' = any (posizioni)) = (posizione_altro is not null));
  end if;
end
$$;

-- ── 4. UN CURRICULUM, UNA CANDIDATURA ───────────────────────────────────────
--
-- ⚠️ QUESTO INDICE CHIUDE UNA PORTA CHE FINO A OGGI NON AVEVA CHIAVE, e la
-- porta si apre proprio adesso: fino al 2026-08-15 nessuna rotta di caricamento
-- produceva percorsi `candidature/…`, quindi `cv_path` era sempre NULL
-- (misurato: 0 candidature con curriculum, 0 oggetti sotto quel prefisso). Da
-- oggi si carica davvero.
--
-- Il pannello di Segreteria firma il curriculum così (`assertCurriculumInScope`,
-- src/app/api/admin/candidature-insegnanti/route.ts): cerca la candidatura che
-- dichiara QUEL percorso, fra le sole sedi di chi guarda, e se ne esce una riga
-- firma l'oggetto per dieci minuti.
--
-- ⚠️ LA PRIMA STESURA DI QUESTO COMMENTO DICEVA UNA COSA FALSA, e va scritto
-- invece che corretto in silenzio. Diceva: «due righe con lo stesso percorso
-- farebbero fallire il `maybeSingle()`, che è fail-closed, e il curriculum non
-- si aprirebbe più per nessuna delle due». Misurato nel sorgente installato
-- (`node_modules/@supabase/postgrest-js/dist/index.cjs:471`): `maybeSingle()`
-- sintetizza `PGRST116` SOLO quando `data.length > 1`, e quelle due query hanno
-- `.limit(1)` PRIMA di `.maybeSingle()` — quindi PostgREST non restituisce mai
-- più di una riga e quel ramo è IRRAGGIUNGIBILE.
--
-- Il che rende il difetto peggiore di come era stato descritto, non minore. Con
-- due righe che dichiarano lo stesso `cv_path` non fallisce niente: ne esce UNA
-- A CASO (non c'è nessun `order by`), la firma riesce, e la riga di sorveglianza
-- `curriculum-firmato` — che questo repo dichiara essere il registro di chi ha
-- letto il curriculum di una persona — attribuisce la lettura alla candidatura
-- sbagliata.
--
-- Il percorso d'attacco, per esteso: un URL firmato porta il percorso IN CHIARO,
-- quindi basta un link inoltrato per conoscerlo. Chi lo conosce invia una
-- candidatura ANONIMA sulla propria sede A dichiarando il `cv_path` di una
-- candidatura della sede B. Da quel momento la Segreteria di A, che vede solo A,
-- risolve quel percorso sulla riga appena creata e riceve un URL firmato per il
-- curriculum di una persona che si era proposta a B. Il gate cross-sede non
-- viene forzato: viene AGGIRATO dalla porta pubblica, che è l'unico posto in cui
-- quel valore nasce.
--
-- Con questo indice quel secondo invio non entra affatto. La route pubblica lo
-- riconosce dal NOME del vincolo e risponde con un errore sul campo, non con il
-- `201` che riserva ai doppioni di email.
--
-- E la difesa NON è sola: `assertCurriculumInScope` ha perso il `.limit(1)`
-- nello stesso lavoro, così una collisione arrivata per altra via (una `INSERT`
-- scritta a mano in SQL, che su questo database si può fare senza conferma)
-- diventa un `PGRST116` che il gate tratta come diniego e LOGGA, invece di una
-- firma silenziosa su una riga arbitraria.
--
-- Parziale su `cv_path is not null`: le candidature senza curriculum non si
-- ostacolano a vicenda (in Postgres NULL non collide con NULL nemmeno in un
-- indice unico, ma il predicato lo rende esplicito e tiene l'indice piccolo).
create unique index if not exists candidature_insegnanti_cv_unico
  on public.candidature_insegnanti (cv_path)
  where cv_path is not null;

-- ── 5. COSA SIGNIFICANO, PER CHI LEGGE LO SCHEMA ────────────────────────────
comment on column public.candidature_insegnanti.posizioni is
  'Posizioni per cui la persona si candida (elenco chiuso, almeno una). Le tre voci insegnante_* portano la fascia nel nome ed è da lì che si deriva `gradi`. Le altre (collaboratrice, cuoca, segreteria, altro) NON fanno nascere nessun account all''approvazione: l''account educator legge l''anagrafica dei bambini.';

comment on column public.candidature_insegnanti.posizione_altro is
  'Il mestiere scritto a mano, obbligatorio se e solo se `altro` è fra le posizioni (CHECK di coerenza nei due versi). Max 100 caratteri: è un nome di mestiere, non una presentazione — per quella c''è `note`.';

comment on column public.candidature_insegnanti.gradi is
  'Fasce per cui la persona si candida (nido/infanzia/primaria). DERIVATA dalle posizioni insegnante_* dal 2026-08-15, non più chiesta al modulo: il client non la scrive più. VUOTA è legittimo — è il caso di una cuoca — e per questo il suo CHECK non è stato stretto: «almeno una» vive su `posizioni`. Confluisce in utenti.gradi all''approvazione.';

comment on column public.candidature_insegnanti.cv_path is
  'Percorso nel bucket form_attachments, forma `candidature/<uuid>-cv.<estensione>`, prodotto SOLO da iscrizione/insegnanti/upload:POST — il nome del file scelto dal browser NON sopravvive (su questa porta è `cv-<cognome>.pdf`). Unico per candidatura (indice candidature_insegnanti_cv_unico): senza, due righe possono dichiarare lo stesso percorso e il gate di Segreteria ne risolve UNA A CASO, firmando alla sede A il curriculum di chi si era proposto alla sede B e attribuendo la lettura alla candidatura sbagliata.';
