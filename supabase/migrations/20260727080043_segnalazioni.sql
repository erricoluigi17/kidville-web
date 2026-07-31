-- =============================================================================
-- Segnalazioni UGC (Google Play — User Generated Content policy, answer/9876937)
--
-- Log di moderazione interno alla Direzione: un genitore o un docente segnala un
-- contenuto (messaggio chat, media di galleria, voce di diario) oppure un utente.
-- È una coda di triage, non un dato con valore probatorio verso terzi: un'unica
-- tabella con discriminante `tipo_oggetto` batte l'integrità referenziale, che
-- comunque non potrebbe esistere (`oggetto_id` è polimorfico).
--
-- Nessuna FK verso utenti/parents su segnalante_id/segnalato_id: queste righe
-- devono sopravvivere all'anonimizzazione GDPR del genitore collegato (stesso
-- motivo di richieste_cancellazione). L'oggetto è denormalizzato apposta.
--
-- `motivo`/`note_gestione` sono testo libero → MAI in chiaro nei log (regola 8
-- di AGENTS.md, redazione a lista bianca @/lib/logging/redact).
--
-- Accesso SOLO service-role: RLS abilitata senza policy → nessun accesso via
-- PostgREST anon/authenticated (pattern identico a richieste_cancellazione).
-- =============================================================================

create table if not exists public.segnalazioni (
  id             uuid primary key default gen_random_uuid(),
  scuola_id      uuid,
  segnalante_id  uuid not null,
  segnalato_id   uuid,                -- valorizzato solo se tipo_oggetto = 'utente'
  tipo_oggetto   text not null check (tipo_oggetto in
                   ('messaggio_chat', 'media_galleria', 'voce_diario', 'utente')),
  oggetto_id     uuid,                -- id del contenuto; NULL se tipo_oggetto = 'utente'
  thread_id      uuid,                -- denormalizzato per aprire la conversazione da Direzione
  categoria      text not null check (categoria in
                   ('contenuto_inappropriato', 'molestie_bullismo', 'informazione_falsa', 'spam', 'altro')),
  motivo         text,                -- testo libero opzionale — MAI in chiaro nei log
  stato          text not null default 'aperta'
                 check (stato in ('aperta', 'in_lavorazione', 'chiusa')),
  creata_il      timestamptz not null default now(),
  gestita_il     timestamptz,
  gestita_da     uuid,
  note_gestione  text                 -- testo libero opzionale — MAI in chiaro nei log
);

create index if not exists segnalazioni_stato_idx
  on public.segnalazioni (scuola_id, stato, creata_il desc);

create index if not exists segnalazioni_oggetto_idx
  on public.segnalazioni (tipo_oggetto, oggetto_id);

alter table public.segnalazioni enable row level security;

comment on table public.segnalazioni is
  'Segnalazioni UGC (contenuto/utente) per la moderazione della Direzione (Google Play UGC policy). Discriminante tipo_oggetto, oggetto polimorfico, nessuna FK utente. Solo service-role.';
