-- =============================================================================
-- ANAGRAFICA DEL PERSONALE IN SERVIZIO — modulo pubblico `/anagrafica-personale`
--
-- Due tabelle, e la ragione va letta prima del DDL perché è la decisione che
-- regge tutto il resto.
--
--   `pratiche_personale`    — ciò che entra dal modulo. Dato NON fidato, scritto
--                             da chiunque abbia il link, che vive fino alla
--                             decisione e poi 90 giorni. NON è un account.
--   `anagrafica_personale`  — ciò che la Segreteria ha riconosciuto. Dato fidato,
--                             1:1 con `utenti`, che vive quanto il rapporto di
--                             lavoro ed è la sorgente dell'allarme di scadenza.
--
-- PERCHÉ NON COLONNE NUOVE SU `utenti`. Tre misure, non tre opinioni:
--  1. `utenti` è la tabella del GATE: `loadAppUser` (src/lib/auth/require-staff.ts)
--     la interroga a OGNI richiesta autenticata. Metterci codice fiscale,
--     residenza e documento significa farli attraversare il percorso caldo
--     dell'autenticazione, e trasformare ogni `select('*')` su `utenti` — ce ne
--     sono — in una fuga di dati che prima non poteva accadere.
--  2. `utenti` ha già tre colonne GENERATE (`first_name`, `last_name`, `role`)
--     che fanno fallire l'INSERT se scritte. Allargarla allarga anche
--     `COLONNE_RIMOVIBILI` di `staff-identity.ts`, cioè l'insieme delle colonne
--     che il degrado su un DB non migrato può togliere: oggi sono tre e innocue,
--     `codice_fiscale` non lo sarebbe.
--  3. `utenti` NON può avere «RLS abilitata senza policy»: la usano le sessioni.
--     Queste due tabelle sì, ed è il loro trattamento.
--
-- PERCHÉ NON LA SOLA PRATICA, con travaso. L'allarme di scadenza deve funzionare
-- per tutta la durata del rapporto, e non può avere come sorgente una riga che un
-- cron di conservazione cancella.
--
-- PERCHÉ NON LA SOLA ANAGRAFICA 1:1. Chi compila può non avere ancora un
-- `utenti.id` — e senza quello la 1:1 non ha chiave. La pratica esiste proprio
-- per lo spazio in cui la persona non è ancora un account.
--
-- ⚠️ IL MODULO CHE ALIMENTA `pratiche_personale` È PUBBLICO E ANONIMO, per
-- decisione del titolare dell'11/08/2026, e chiede il codice fiscale e la
-- scansione di un documento d'identità. Non è un dettaglio da dedurre leggendo le
-- route: è la premessa di ogni riga qui sotto. Da lì discendono, e non sono
-- ornamenti, la RLS senza policy, il bucket separato, la retention a 90 giorni
-- delle pratiche non approvate, e il fatto che questa tabella non tocchi MAI
-- `utenti.ruolo` né `utenti.scuola_id`.
-- =============================================================================

-- ── 1. La pratica ────────────────────────────────────────────────────────────

create table if not exists public.pratiche_personale (
  id                      uuid primary key default gen_random_uuid(),
  scuola_id               uuid not null references public.schools(id),

  -- `in_approvazione` non è uno stato di comodo: è il CLAIM ATOMICO che chiude la
  -- corsa fra due clic su «Approva» (o due schede aperte). Senza, due account.
  stato                   text not null default 'pending'
                          check (stato in ('pending','in_approvazione','approvata','rifiutata')),

  -- identità
  nome                    text not null,
  cognome                 text not null,
  -- `varchar(1)` e non `char(1)` per la stessa disciplina applicata sotto al
  -- codice fiscale: in questo schema nessuna colonna di testo impagina.
  gender                  varchar(1) check (gender is null or gender in ('M','F')),
  birth_date              date,
  birth_place             text,
  birth_province          varchar(2),
  birth_nation            text,
  codice_belfiore_nascita varchar(4) check (codice_belfiore_nascita is null
                                            or codice_belfiore_nascita ~ '^[A-Z][0-9]{3}$'),

  -- ⚠️ `varchar(16)` E NON `character(16)`. `alunni.codice_fiscale` è `char(16)` e
  -- IMPAGINA CON SPAZI: un codice di 14 caratteri rientra dal database lungo 16, e
  -- ogni `length() = 16` scritto sopra quella colonna mente. È il difetto che ha
  -- reso invisibile metà del problema dei codici fiscali (vedi
  -- 20260810094625_codice_belfiore_nascita.sql). Non si ripete qui.
  --
  -- Il pattern ammette l'OMOCODIA (`[0-9LMNPQRSTUV]` nelle sette posizioni
  -- numeriche): un codice omocodico è valido, e rifiutarlo respingerebbe una
  -- persona vera. È lo stesso `FORMA_CF` di src/lib/fiscale/tabelle.ts, ristretto
  -- alle maiuscole perché la route normalizza prima di scrivere. Il CHECK è
  -- l'ultima rete e guarda solo la FORMA: il carattere di controllo lo verifica
  -- `validaCodiceFiscale`, che è l'unica cosa capace di distinguere un codice
  -- vero da sedici caratteri ben disposti.
  fiscal_code             varchar(16) check (fiscal_code is null or fiscal_code ~
                            '^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$'),
  citizenship             text,

  -- residenza
  address                 text,
  residence_street_number text,
  residence_city          text,
  residence_province      varchar(2),
  zip_code                varchar(5) check (zip_code is null or zip_code ~ '^[0-9]{5}$'),

  -- domicilio, solo se diverso dalla residenza (facoltativo per intero)
  domicilio_address       text,
  domicilio_street_number text,
  domicilio_city          text,
  domicilio_province      varchar(2),
  domicilio_zip_code      varchar(5) check (domicilio_zip_code is null
                                            or domicilio_zip_code ~ '^[0-9]{5}$'),

  -- recapiti. `email` è la chiave con cui l'approvazione decide se AGGIORNARE
  -- un'anagrafica esistente o aprire un'utenza nuova: senza, approvare sarebbe
  -- indovinare.
  email                   text not null,
  telefono                text,

  -- documento d'identità
  document_type           text check (document_type is null or document_type in ('CI','PP','DL')),
  document_number         text,
  -- ⚠️ `> '1990-01-01'` e NON `>= current_date`. Un CHECK sul futuro rifiuterebbe
  -- esattamente le righe per cui l'allarme di scadenza esiste: il documento GIÀ
  -- SCADUTO dev'essere registrabile, altrimenti la Segreteria non può nemmeno
  -- annotare il problema che deve risolvere. Il limite inferiore serve solo a
  -- fermare le date sbagliate di due secoli.
  document_expiry         date check (document_expiry is null
                                      or document_expiry > date '1990-01-01'),
  documento_path          text check (documento_path is null or length(documento_path) <= 200),

  -- professione
  titolo_studio           text,
  titolo_dettaglio        text,
  -- ⚠️ `cardinality(gradi) >= 1`, MAI `array_length(gradi, 1) >= 1`. Su un array
  -- vuoto `array_length` vale NULL, e UN CHECK CHE VALE NULL PASSA: misurato in
  -- produzione il 2026-08-10 e scritto per esteso in
  -- src/lib/forms/insegnanti-template.ts. `candidature_insegnanti` porta ancora la
  -- forma sbagliata e la sua tabella accetta zero fasce in silenzio; qui il CHECK
  -- morde davvero. La route passa comunque `gradi` esplicito: la difesa doppia
  -- costa zero.
  gradi                   public.school_type_enum[] not null default '{}'
                          check (cardinality(gradi) >= 1),

  -- Contatto d'emergenza: sono i dati di un TERZO, che non sta compilando nulla e
  -- non ha ricevuto nessuna informativa. Facoltativi per intero (art. 14 GDPR), e
  -- il modulo dice a chi compila perché servono.
  emergenza_nome          text,
  emergenza_telefono      text,
  emergenza_relazione     text,

  -- Prova dell'informativa, stessa forma di `enrollment_submissions.consents_log`:
  -- il TESTO del consenso si congela qui, così fra due anni si sa a quale
  -- formulazione la persona ha risposto.
  consents_log            jsonb,

  creata_il               timestamptz not null default now(),
  aggiornata_il           timestamptz not null default now(),
  evasa_il                timestamptz,
  evasa_da                uuid references public.utenti(id),
  utente_id               uuid references public.utenti(id),
  motivo_rifiuto          text
);

-- DEDUP: una sola pratica VIVA per email. Il secondo invio prende 23505.
--
-- ⚠️ COME LA ROUTE PUBBLICA DEVE TRADURLO: NON con un 409. Questo modulo è
-- anonimo, e un 409 direbbe a chiunque digiti l'email di una maestra se quella
-- persona lavora qui. È un oracolo di enumerazione sul lavoro di qualcuno, e
-- nessuno lo cercherebbe apposta: lo si troverebbe per caso. Quindi il modulo
-- risponde 201 come al primo invio — che non è una bugia, perché la pratica
-- esiste davvero ed è davvero in valutazione — e il duplicato si registra in
-- `app_log` con esito `duplicata`, dove lo vede solo chi ha accesso ai log.
--
-- Parziale di proposito: chi è stato rifiutato può ripresentarsi.
create unique index if not exists pratiche_personale_email_viva
  on public.pratiche_personale (lower(email))
  where stato in ('pending','in_approvazione');

create index if not exists pratiche_personale_stato_idx
  on public.pratiche_personale (stato, creata_il desc);

create index if not exists pratiche_personale_scuola_idx
  on public.pratiche_personale (scuola_id, creata_il desc);

-- RLS ABILITATA SENZA POLICY = solo service-role, come `candidature_insegnanti`.
-- Qui la tabella contiene codici fiscali, residenze e il percorso della scansione
-- di un documento d'identità: non deve essere leggibile da nessuna sessione
-- autenticata, nemmeno da una docente.
alter table public.pratiche_personale enable row level security;

comment on table public.pratiche_personale is
  'Anagrafiche del personale in servizio inviate dal modulo pubblico /anagrafica-personale. NON è un account e NON è l''anagrafica: entrambi nascono solo all''approvazione della Segreteria. Il modulo è ANONIMO per decisione del titolare (11/08/2026), quindi ogni riga qui è un dato NON fidato finché un essere umano non la riconosce. Solo service_role: RLS abilitata senza policy. Le pratiche non approvate si cancellano a 90 giorni, scansione compresa.';

comment on column public.pratiche_personale.stato is
  'pending -> in_approvazione (claim atomico, chiude la corsa del doppio clic) -> approvata | rifiutata.';

comment on column public.pratiche_personale.email is
  'Chiave con cui l''approvazione decide se AGGIORNARE l''anagrafica di chi ha già un account o aprirne uno nuovo. Normalizzata minuscola dalla route prima di scrivere: l''indice unico è su lower(email).';

comment on column public.pratiche_personale.gradi is
  'Fasce su cui la persona lavora (nido/infanzia/primaria). Confluisce in utenti.gradi all''approvazione, e SOLO se non è vuoto: scriverci un array vuoto cancellerebbe le fasce di una docente in servizio, e le fasce decidono quali funzioni vede.';

comment on column public.pratiche_personale.documento_path is
  'Percorso nel bucket privato documenti_personale. All''approvazione l''oggetto NON si copia: l''anagrafica punta allo stesso file e questa colonna torna NULL. Un oggetto, un proprietario — è ciò che impedisce alla retention della pratica di cancellare il file che l''anagrafica sta ancora usando.';

-- ── 2. L'anagrafica definitiva ───────────────────────────────────────────────

create table if not exists public.anagrafica_personale (
  -- PK = `utente_id`, senza un `id` proprio: la 1:1 è vera PER COSTRUZIONE, e non
  -- esiste lo stato «due anagrafiche per la stessa persona», che è il difetto che
  -- nessun controllo applicativo chiude davvero.
  utente_id               uuid primary key references public.utenti(id) on delete cascade,

  gender                  varchar(1) check (gender is null or gender in ('M','F')),
  birth_date              date,
  birth_place             text,
  birth_province          varchar(2),
  birth_nation            text,
  codice_belfiore_nascita varchar(4) check (codice_belfiore_nascita is null
                                            or codice_belfiore_nascita ~ '^[A-Z][0-9]{3}$'),
  fiscal_code             varchar(16) check (fiscal_code is null or fiscal_code ~
                            '^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$'),
  citizenship             text,

  address                 text,
  residence_street_number text,
  residence_city          text,
  residence_province      varchar(2),
  zip_code                varchar(5) check (zip_code is null or zip_code ~ '^[0-9]{5}$'),

  domicilio_address       text,
  domicilio_street_number text,
  domicilio_city          text,
  domicilio_province      varchar(2),
  domicilio_zip_code      varchar(5) check (domicilio_zip_code is null
                                            or domicilio_zip_code ~ '^[0-9]{5}$'),

  document_type           text check (document_type is null or document_type in ('CI','PP','DL')),
  document_number         text,
  document_expiry         date check (document_expiry is null
                                      or document_expiry > date '1990-01-01'),
  documento_path          text,

  titolo_studio           text,
  titolo_dettaglio        text,

  emergenza_nome          text,
  emergenza_telefono      text,
  emergenza_relazione     text,

  -- Idempotenza dell'allarme: la soglia più bassa già annunciata (90, 60, 30, 7,
  -- oppure 0 = scaduto) e quando. Senza queste due colonne il cron rimanderebbe
  -- lo stesso avviso ogni notte, e un allarme quotidiano si impara a ignorare.
  scadenza_soglia_avvisata smallint check (scadenza_soglia_avvisata is null
                                           or scadenza_soglia_avvisata in (90,60,30,7,0)),
  scadenza_avvisata_il     timestamptz,

  -- Cessazione del rapporto: è la data da cui contano i due termini di
  -- conservazione (12 mesi per la scansione, 10 anni per il fascicolo). Nullable:
  -- finché è NULL il rapporto è in corso e non si cancella niente.
  cessato_il              date,

  origine_pratica_id      uuid references public.pratiche_personale(id) on delete set null,
  creata_il               timestamptz not null default now(),
  aggiornata_il           timestamptz not null default now(),
  aggiornata_da           uuid references public.utenti(id)
);

-- L'indice che il cron delle scadenze percorre ogni notte. Parziale: le righe
-- senza scadenza non gli servono, e sono tante quante le anagrafiche incomplete.
create index if not exists anagrafica_personale_scadenza_idx
  on public.anagrafica_personale (document_expiry)
  where document_expiry is not null;

alter table public.anagrafica_personale enable row level security;

comment on table public.anagrafica_personale is
  'Anagrafica del personale in servizio, 1:1 con utenti (PK = utente_id). Ci si scrive SOLO approvando una pratica o dal pannello della Segreteria, mai dal modulo pubblico. NON contiene nome, cognome, email, cellulare, ruolo, gradi né scuola_id: quelli vivono in utenti e restano lì — due verità sulla stessa persona divergono al primo aggiornamento. NON è la prova che la persona sia in servizio: utenti.attivo non è letto da nessun gate. Solo service_role: RLS abilitata senza policy.';

comment on column public.anagrafica_personale.utente_id is
  'Chiave primaria E chiave esterna: la 1:1 è vera per costruzione, non per disciplina applicativa. `on delete cascade` perché un''anagrafica senza il suo utente non ha nessun significato.';

comment on column public.anagrafica_personale.scadenza_soglia_avvisata is
  'La soglia più bassa già annunciata (90/60/30/7/0). Il cron avvisa solo se la soglia SCENDE, così ogni preavviso parte una volta sola; a scadenza superata (0) risollecita una volta a settimana. Azzerata dal trigger quando document_expiry cambia.';

comment on column public.anagrafica_personale.cessato_il is
  'Data di cessazione del rapporto. NULL = rapporto in corso. Da qui contano i due termini di conservazione: 12 mesi per la scansione del documento (che esce prima, con un update a NULL), 10 anni per il fascicolo.';

-- ── 3. Il trigger che azzera il promemoria ───────────────────────────────────
--
-- PERCHÉ UN TRIGGER E NON DUE RIGHE NELLE ROUTE. I punti che scrivono
-- `document_expiry` sono almeno tre: l'approvazione di una pratica, la correzione
-- allo sportello, e domani l'aggiornamento che la docente farà da sé. Un
-- azzeramento dimenticato in UNO SOLO significa che quella persona non riceverà
-- mai più un promemoria — e il guasto è silenzioso: non c'è nessun errore, c'è
-- solo un'email che non parte. Una regola valida per tre strade vive in un posto
-- solo.
create or replace function public.anagrafica_personale_tocca()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.document_expiry is distinct from old.document_expiry then
    new.scadenza_soglia_avvisata := null;
    new.scadenza_avvisata_il := null;
  end if;
  new.aggiornata_il := now();
  return new;
end;
$$;

-- ⚠️ QUESTE TRE RIGHE SONO STATE AGGIUNTE DOPO, il 2026-08-12, e va detto invece
-- che nascosto.
--
-- Il fatto: questa funzione è nata `SECURITY DEFINER` senza revocarne l'EXECUTE,
-- e in Supabase `anon`/`authenticated` ricevono l'EXECUTE per GRANT esplicito —
-- `REVOKE ... FROM PUBLIC` non li tocca. Se n'è accorto `get_advisors(security)`
-- un minuto dopo l'applicazione, e la migrazione successiva
-- (`20260811205733_anagrafica_personale_trigger_invoker.sql`) ha chiuso tutto in
-- produzione: `security invoker` + revoca a `public`, `anon`, `authenticated`.
-- Misurato il 12/08 su produzione: `has_function_privilege` risponde `false` per
-- entrambi i ruoli, e la funzione è `prosecdef = false`.
--
-- Perché allora toccare questo file, che è già applicato. Per due ragioni, e
-- nessuna delle due è «far tacere il lock»:
--
--  1. su una RICOSTRUZIONE DA ZERO a partire dai file — disaster recovery, nuovo
--     ambiente, database di collaudo — fra questa migrazione e la successiva la
--     funzione resterebbe eseguibile via `/rest/v1/rpc/`. È una finestra breve, ma
--     è una finestra che il repo apre da solo ogni volta che qualcuno ricostruisce;
--  2. `__tests__/architecture/security-definer-revoke-lock.test.ts` legge le
--     migrazioni UN FILE ALLA VOLTA, per una ragione giusta: fra due migrazioni
--     c'è un intervallo reale in cui la porta è aperta. MISURATO il 12/08: una
--     migrazione nuova di sole revoche NON rende verde il lock — l'ho eseguita.
--     Quindi «aggiungere una migrazione» non è un'alternativa a questo blocco:
--     è un'altra cosa, che non chiude né la finestra (1) né il lock.
--
-- Il rischio reale di sfruttamento resta nullo — Postgres rifiuta una funzione
-- trigger invocata fuori da un trigger («trigger functions can only be called as
-- triggers») — ed è esattamente l'argomento che la migrazione 205733 rifiuta di
-- accettare: è un argomento sul fatto che l'attacco fallisca oggi, non sul fatto
-- che la porta sia chiusa.
revoke all on function public.anagrafica_personale_tocca() from public;
revoke all on function public.anagrafica_personale_tocca() from anon;
revoke all on function public.anagrafica_personale_tocca() from authenticated;

drop trigger if exists anagrafica_personale_tocca_trg on public.anagrafica_personale;
create trigger anagrafica_personale_tocca_trg
  before update on public.anagrafica_personale
  for each row execute function public.anagrafica_personale_tocca();

comment on function public.anagrafica_personale_tocca() is
  'BEFORE UPDATE su anagrafica_personale: aggiorna aggiornata_il e, se document_expiry cambia, azzera lo stato del promemoria di scadenza. Sta qui e non nelle route perché i punti che scrivono quella colonna sono tre, e un azzeramento dimenticato in uno solo produce una persona che non riceve più nessun avviso, senza nessun errore da nessuna parte.';

-- ── 4. Il bucket delle scansioni ─────────────────────────────────────────────
--
-- PERCHÉ UN BUCKET SEPARATO e non `form_attachments`. Quel bucket custodisce i
-- documenti allegati alle domande d'iscrizione, cioè carte d'identità di genitori
-- e fotografie di minori: due popolazioni diverse, due basi giuridiche diverse,
-- due termini di conservazione diversi. Tenerli insieme significherebbe che il
-- risolutore di percorso di un modulo può, sbagliando, firmare l'oggetto
-- dell'altro. Separati, quel fallimento è impossibile per costruzione: un
-- percorso `documenti/…` non si risolve MAI a una riga di iscrizione, e viceversa.
--
-- `file_size_limit` = 4 MB e non 8: è il tetto VERO della piattaforma
-- (src/lib/upload/limite-piattaforma.ts, LIMITE_UPLOAD_MB). Sopra quella soglia la
-- richiesta muore contro un 413 FUNCTION_PAYLOAD_TOO_LARGE che non è nostro e non
-- risponde nemmeno in JSON — 41 tentativi falliti in un giorno sul modulo
-- pubblico d'iscrizione, il 31/07/2026, prima che qualcuno lo misurasse. Un
-- bucket che dichiara 8 MB promette ciò che la funzione non lascia arrivare.
--
-- I cinque tipi sono esattamente `MIME_ALLEGATO_PUBBLICO`
-- (src/lib/upload/allegati-pubblici.ts). `image/heic` è in elenco di proposito: è
-- ciò che produce un iPhone fotografando una carta d'identità, cioè il modo in cui
-- questo allegato arriverà quasi sempre.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documenti_personale',
  'documenti_personale',
  false,
  4194304,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do update
  set public = false,
      file_size_limit = 4194304,
      allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];

-- ── 5. L'indice su utenti(lower(email)) ──────────────────────────────────────
--
-- L'approvazione cerca `lower(utenti.email)` per decidere se aggiornare
-- un'anagrafica o aprire un'utenza: senza indice è una scansione, e con l'indice è
-- anche una ricerca ESATTA invece che dipendente dalle maiuscole.
--
-- ⚠️ NON UNIQUE, e la ragione è un debito dichiarato invece che rotto alla cieca.
-- `staff-identity.ts` chiede da sempre l'unicità su `lower(email)`.
--
-- MISURATO l'11/08/2026, prima di applicare questa migrazione:
--     select lower(email), count(*) from public.utenti group by 1 having count(*) > 1;
--     → ZERO righe.
-- Quindi la promozione a UNIQUE oggi RIUSCIREBBE. Non si fa qui lo stesso, e la
-- ragione non è la fattibilità: è il perimetro. Un indice unico cambia il
-- comportamento di ogni scrittura su `utenti`, comprese quelle che questo lavoro
-- non tocca — un percorso che oggi inserisce e domani prende `23505` è un guasto
-- nuovo introdotto da una migrazione che parlava d'altro. La promozione resta a una
-- migrazione sua, che possa essere collaudata per ciò che è; chi la scriverà rifaccia
-- il conteggio qui sopra, perché fra allora e oggi qualcuno può essersi iscritto.
create index if not exists utenti_email_lower_idx on public.utenti (lower(email));
