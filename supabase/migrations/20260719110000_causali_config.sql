-- Modelli di causale del bonifico personalizzabili PER CATEGORIA di pagamento.
--
-- Perché: la causale consigliata era un formato fisso. La segreteria vuole poterla
-- personalizzare per ogni tipologia (Rette, Iscrizione, Mensa, Divisa, Materiale,
-- Gita) più un modello «predefinito». I modelli vivono in un JSONB per-scuola su
-- `admin_settings`, indicizzato per SLUG di categoria (chiave stabile):
--   { "default": "{descrizione} - per il minore {nome_completo} - {codice_fiscale} - {sede}",
--     "retta": "…", "mensa": "…", … }
--
-- Additivo e sicuro. Sul DB E2E della CI (non migrato) la colonna manca → il codice
-- degrada (PGRST204/42703) e ricade sul modello predefinito.
alter table public.admin_settings
  add column if not exists causali_config jsonb not null default '{}'::jsonb;
