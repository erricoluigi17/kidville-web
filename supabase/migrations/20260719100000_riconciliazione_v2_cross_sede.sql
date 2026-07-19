-- Riconciliazione v2 — estratto conto UNICO cross-sede + dedup globale.
--
-- Perché: il conto corrente è uno solo per tutte le sedi. Finora ogni movimento
-- era legato a UNA sede fin dal caricamento (scuola_id NOT NULL) e la dedup era
-- per-sede (UNIQUE(scuola_id, hash_movimento)). Ora l'estratto conto è un
-- registro cumulativo condiviso: il movimento nasce SENZA sede e la sede si
-- determina alla CONFERMA, dal pagamento abbinato. La lista è globale (tutte le
-- segreterie la vedono) e la dedup è globale sull'hash (lo stesso accredito non
-- entra due volte anche se il file viene ricaricato da operatori diversi).
--
-- Sicuro: in produzione le due tabelle sono vuote (0 movimenti, 0 import), quindi
-- nessuna riga da bonificare prima dei nuovi vincoli.
--
-- Degradazione E2E CI (DB non migrato): scuola_id resta NOT NULL sul progetto CI,
-- quindi l'import lato codice inserisce scuola_id = NULL e degrada su 23502
-- (not-null violation) reimpostando la sede risolta dell'operatore. Vecchi flussi
-- invariati.

-- 1. La sede non è più obbligatoria al caricamento (viene impostata alla conferma).
alter table public.riconciliazione_movimenti alter column scuola_id drop not null;
alter table public.riconciliazione_import    alter column scuola_id drop not null;

-- 2. Dedup GLOBALE sull'hash (non più per-sede).
alter table public.riconciliazione_movimenti
  drop constraint if exists riconciliazione_movimenti_scuola_id_hash_movimento_key;
create unique index if not exists riconciliazione_movimenti_hash_uidx
  on public.riconciliazione_movimenti (hash_movimento);

-- 3. Indici per la coda globale (stato/data) e per l'abbinamento (pagamento).
drop index if exists public.riconciliazione_movimenti_stato_idx;
create index if not exists riconciliazione_movimenti_coda_idx
  on public.riconciliazione_movimenti (stato, data_operazione desc);
create index if not exists riconciliazione_movimenti_pagamento_idx
  on public.riconciliazione_movimenti (pagamento_id);

-- 4. L'import è cumulativo e cross-sede: si ordina per data di caricamento.
drop index if exists public.riconciliazione_import_scuola_idx;
create index if not exists riconciliazione_import_caricato_idx
  on public.riconciliazione_import (caricato_il desc);
