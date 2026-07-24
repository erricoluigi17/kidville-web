-- =============================================================================
-- Richieste di cancellazione account (App Store Guideline 5.1.1(v) + GDPR art. 17)
--
-- Il genitore avvia in-app la richiesta di cancellazione del proprio account
-- (pagina "Profilo e deleghe"); la Direzione la evade dal pannello Privacy &
-- Diritto all'Oblio, anonimizzando il genitore e i figli NON iscritti.
--
-- Nessuna PII qui dentro: solo parent_id (uuid), stato, timestamp e conteggi.
-- Accesso SOLO service-role (le route usano createAdminClient + gate applicativo
-- requireUser / requireStaff): RLS abilitata senza policy → nessun accesso via
-- PostgREST anon/authenticated.
-- =============================================================================

create table if not exists public.richieste_cancellazione (
  id             uuid primary key default gen_random_uuid(),
  parent_id      uuid not null,
  scuola_id      uuid,
  stato          text not null default 'pending'
                 check (stato in ('pending', 'evasa', 'revocata', 'rifiutata')),
  creata_il      timestamptz not null default now(),
  aggiornata_il  timestamptz not null default now(),
  evasa_il       timestamptz,
  evasa_da       uuid,
  esito          jsonb          -- conteggi dell'anonimizzazione (nessuna PII)
);

-- Una sola richiesta "pending" per genitore (l'INSERT doppio ritorna 23505).
create unique index if not exists richieste_cancellazione_pending_unica
  on public.richieste_cancellazione (parent_id)
  where stato = 'pending';

create index if not exists richieste_cancellazione_stato_idx
  on public.richieste_cancellazione (stato, creata_il desc);

alter table public.richieste_cancellazione enable row level security;

comment on table public.richieste_cancellazione is
  'Richieste self-service di cancellazione account genitore (App Store 5.1.1(v) + GDPR art. 17). Evase dalla Direzione via anonimizzazione. Solo service-role.';
