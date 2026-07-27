-- =============================================================================
-- Accettazioni consensi (gate Termini — Google Play UGC + art. 1341 c.c. / A3 lacuna E)
--
-- Prova append-only dell'accettazione di privacy e Termini di servizio: data +
-- versione del testo accettato, mai sovrascritta. È esattamente la prova
-- richiesta dall'art. 1341 c.c. per la clausola di limitazione di responsabilità;
-- un jsonb aggiornato in-place (parents.consensi_gdpr, che resta il flag veloce)
-- non basta come prova in un'eventuale contestazione.
--
-- data + versione sono scritte SERVER-SIDE, mai dal client (un client datato o
-- malevolo potrebbe spedire una versione arbitraria svuotando il valore probatorio).
--
-- Nessuna FK su parent_id: deve sopravvivere all'anonimizzazione GDPR del genitore.
-- Append-only per convenzione applicativa: nessun UPDATE/DELETE nel codice.
--
-- Accesso SOLO service-role: RLS abilitata senza policy.
-- =============================================================================

create table if not exists public.consensi_accettazioni (
  id            uuid primary key default gen_random_uuid(),
  parent_id     uuid not null,        -- niente FK: deve sopravvivere all'anonimizzazione del genitore
  tipo          text not null check (tipo in ('privacy', 'termini')),
  versione      text not null,
  accettato_il  timestamptz not null default now(),
  ip            text,
  user_agent    text
);

create index if not exists consensi_accettazioni_parent_tipo_idx
  on public.consensi_accettazioni (parent_id, tipo, accettato_il desc);

alter table public.consensi_accettazioni enable row level security;

comment on table public.consensi_accettazioni is
  'Prova append-only dell''accettazione di privacy/Termini (data + versione, server-side). Art. 1341 c.c. + gate UGC Google Play. Nessuna FK parent_id. Solo service-role.';
