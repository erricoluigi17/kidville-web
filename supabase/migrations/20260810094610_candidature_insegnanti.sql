-- =============================================================================
-- Candidature spontanee di personale docente — modulo pubblico «Lavora con noi».
--
-- PERCHÉ UNA TABELLA SEPARATA, e non una riga `utenti` con `attivo = false`:
-- `utenti.attivo` NON è letto da nessun gate di questa applicazione — né da
-- `loadAppUser` (src/lib/auth/require-staff.ts) né da `getProfiliForAuthUid`
-- (src/lib/auth/profili.ts). Una candidata salvata in `utenti` con `attivo=false`
-- avrebbe accesso PIENO all'area docente, e quindi all'anagrafica dei bambini.
-- Non è un'ipotesi: è ciò che quei due file fanno oggi. Finché non leggono
-- `attivo`, nessuna candidatura può vivere in `utenti`.
--
-- NIENTE CODICE FISCALE qui: serve all'assunzione, non alla candidatura
-- (minimizzazione, art. 5.1.c GDPR). Chi viene assunto lo fornisce dopo.
-- =============================================================================

create table if not exists public.candidature_insegnanti (
  id                 uuid primary key default gen_random_uuid(),
  scuola_id          uuid not null references public.schools(id),

  -- `in_approvazione` non è uno stato "di comodo": è il CLAIM ATOMICO che chiude
  -- la corsa fra due clic su «Approva» (o due schede aperte). Senza, due account.
  stato              text not null default 'pending'
                     check (stato in ('pending','in_approvazione','approvata','rifiutata')),

  nome               text not null,
  cognome            text not null,
  email              text not null,
  telefono           text,
  residence_city     text,
  residence_province varchar(2),

  -- Multi-valore per costruzione: `utenti.gradi` lo è già, e una maestra può
  -- lavorare su nido e infanzia insieme. Almeno una fascia, sempre.
  gradi              public.school_type_enum[] not null default '{}'
                     check (array_length(gradi, 1) >= 1),

  titolo_studio      text,
  titolo_dettaglio   text,
  anni_esperienza    smallint check (anni_esperienza is null
                                     or (anni_esperienza >= 0 and anni_esperienza <= 60)),
  disponibilita      text,
  note               text,
  cv_path            text,

  -- Prova dell'informativa, stessa forma di `enrollment_submissions.consents_log`:
  -- il TESTO del consenso si congela qui, così fra due anni si sa a quale
  -- formulazione la persona ha risposto.
  consents_log       jsonb,

  creata_il          timestamptz not null default now(),
  aggiornata_il      timestamptz not null default now(),
  evasa_il           timestamptz,
  evasa_da           uuid references public.utenti(id),
  utente_id          uuid references public.utenti(id),
  motivo_rifiuto     text
);

-- DEDUP: una sola candidatura VIVA per email. Il secondo invio prende 23505, e il
-- doppione non nasce.
--
-- ⚠️ COME LA ROUTE PUBBLICA DEVE TRADURLO, e la prima stesura di questo commento
-- diceva la cosa sbagliata: NON con un 409 «l'abbiamo già ricevuta».
-- Il modulo di /lavora-con-noi è anonimo: chiunque potrebbe digitare l'email di una
-- maestra e leggere dalla risposta se quella persona ha una candidatura aperta presso
-- questa scuola. È un oracolo di enumerazione su un dato che riguarda il lavoro di
-- qualcuno, e nessuno lo cercherebbe apposta: lo si troverebbe per caso.
-- Quindi il modulo PUBBLICO risponde 201 come al primo invio — che non è una bugia,
-- perché la candidatura esiste davvero ed è davvero in valutazione — e il duplicato
-- si registra in `app_log` con esito `duplicata`, dove lo vede solo chi ha accesso ai
-- log. Il 409 esplicito (`CANDIDATURA_GIA_INVIATA`) resta al cockpit AUTENTICATO,
-- dove chi guarda ha già titolo per sapere chi si è candidato.
--
-- Parziale di proposito: chi è stato rifiutato può ricandidarsi l'anno dopo.
create unique index if not exists candidature_insegnanti_email_viva
  on public.candidature_insegnanti (lower(email))
  where stato in ('pending','in_approvazione');

create index if not exists candidature_insegnanti_stato_idx
  on public.candidature_insegnanti (stato, creata_il desc);

create index if not exists candidature_insegnanti_scuola_idx
  on public.candidature_insegnanti (scuola_id, creata_il desc);

-- RLS ABILITATA SENZA POLICY = solo service-role, come `richieste_cancellazione`.
-- La tabella contiene contatti e curriculum di persone che si candidano: non deve
-- essere leggibile da nessuna sessione autenticata, nemmeno da un docente.
alter table public.candidature_insegnanti enable row level security;

comment on table public.candidature_insegnanti is
  'Candidature spontanee di personale docente dal modulo pubblico /lavora-con-noi. NON è un account: l''account (utenti, ruolo educator) nasce solo all''approvazione della Direzione. Tabella separata perché utenti.attivo non è letto da nessun gate. Solo service_role: RLS abilitata senza policy.';

comment on column public.candidature_insegnanti.stato is
  'pending -> in_approvazione (claim atomico, chiude la corsa del doppio clic) -> approvata | rifiutata.';

comment on column public.candidature_insegnanti.gradi is
  'Fasce per cui la persona si candida (nido/infanzia/primaria). Confluisce in utenti.gradi all''approvazione.';
