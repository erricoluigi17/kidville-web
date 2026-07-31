-- =============================================================================
-- Canale della richiesta di cancellazione account (C5 §1 — Google Play).
--
-- Oltre al percorso IN-APP esistente (/parent/profilo, genitore autenticato), la
-- User Data policy di Google richiede un percorso WEB pubblico senza login
-- (/cancellazione-account, verifica via magic-link email). La colonna distingue
-- le due provenienze: 'pubblico_email' è una prova d'identità più debole
-- (solo possesso della casella), e la Direzione lo vede prima di anonimizzare.
--
-- Additiva (expand): default 'in_app' → le righe esistenti restano invariate.
-- Nessuna PII: solo un discriminante testuale vincolato.
-- =============================================================================

alter table public.richieste_cancellazione
  add column if not exists canale text not null default 'in_app'
  check (canale in ('in_app', 'pubblico_email'));

comment on column public.richieste_cancellazione.canale is
  'Provenienza della richiesta: in_app (genitore autenticato) | pubblico_email (pagina pubblica /cancellazione-account, verifica via magic-link).';
