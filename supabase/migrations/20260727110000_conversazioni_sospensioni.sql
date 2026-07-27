-- =============================================================================
-- Sospensione conversazione chat (Google Play — UGC 1:1, decisione titolare B)
--
-- Il "blocco" richiesto dalla UGC policy per l'interazione 1:1 (chat
-- genitore↔docente) è implementato come SOSPENSIONE della conversazione, non
-- come blocco silenzioso: l'altra parte vede "conversazione sospesa" e la
-- Direzione viene notificata e può mediare.
--
-- Storico APPEND-ONLY: la sospensione è la parte con vero rischio di
-- contestazione (pattern ripetuti sospendi→riapri→sospendi tra le stesse due
-- persone). Serve uno storico che sopravviva, non un flag sovrascrivibile su
-- chat_threads (il cui last_message_at si aggiorna a ogni messaggio).
-- Riapertura = UPDATE dei soli campi riaperta_* sulla riga attiva, mai un
-- secondo INSERT né un DELETE.
--
-- Unica FK: thread_id → chat_threads(id) ON DELETE CASCADE (stesso pattern di
-- chat_messages.thread_id nella baseline). Nessuna FK su sospesa_da/sospesa_verso:
-- devono sopravvivere all'anonimizzazione GDPR del partecipante.
--
-- `motivo` è testo libero dell'utente → MAI in chiaro nei log (regola 8 AGENTS.md).
--
-- Accesso SOLO service-role: RLS abilitata senza policy.
-- =============================================================================

create table if not exists public.conversazioni_sospensioni (
  id             uuid primary key default gen_random_uuid(),
  thread_id      uuid not null references public.chat_threads(id) on delete cascade,
  sospesa_da     uuid not null,       -- chi ha sospeso
  sospesa_verso  uuid not null,       -- l'altro partecipante, denormalizzato all'insert
  motivo         text,                -- testo libero opzionale — MAI in chiaro nei log
  scuola_id      uuid,
  sospesa_il     timestamptz not null default now(),
  riaperta_il    timestamptz,         -- NULL = sospensione attiva
  riaperta_da    uuid,
  riaperta_tipo  text check (riaperta_tipo in ('sospendente', 'direzione'))
);

-- Al più UNA sospensione attiva per thread: previene la race a livello di indice
-- (il secondo INSERT su un thread già sospeso ritorna 23505).
create unique index if not exists conversazioni_sospensioni_attiva_unica
  on public.conversazioni_sospensioni (thread_id)
  where riaperta_il is null;

create index if not exists conversazioni_sospensioni_thread_storico_idx
  on public.conversazioni_sospensioni (thread_id, sospesa_il desc);

alter table public.conversazioni_sospensioni enable row level security;

comment on table public.conversazioni_sospensioni is
  'Storico append-only delle sospensioni di conversazione chat (UGC 1:1, decisione titolare B). Una sola attiva per thread (indice parziale). Riapertura = UPDATE dei campi riaperta_*. Solo service-role.';
