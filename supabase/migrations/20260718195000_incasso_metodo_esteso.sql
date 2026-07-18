-- =============================================================================
-- CONTABILITÀ v2 · estensione enum incasso_metodo (slice S2, pre-requisito)
--
--   L'enum `incasso_metodo` valeva (contanti|bonifico|pos|assegno|altro). La
--   contabilità v2 introduce l'utilizzo del «credito famiglia» come metodo di
--   incasso (RPC utilizza_credito_famiglia) e — per le slice successive S3/S4 —
--   gli incassi di rettifica/storno tracciati.
--
--   In Postgres un valore enum AGGIUNTO non è usabile nella STESSA transazione:
--   per questo l'estensione vive in un file/transazione DEDICATO, applicato
--   PRIMA delle migrazioni che usano i nuovi valori (regole S2a e transazioni
--   S2b). ADD VALUE IF NOT EXISTS → idempotente e ri-applicabile.
--
--   Puramente additivo: nessun valore rimosso o rinominato, nessun dato toccato.
-- =============================================================================

ALTER TYPE public.incasso_metodo ADD VALUE IF NOT EXISTS 'credito_famiglia';
ALTER TYPE public.incasso_metodo ADD VALUE IF NOT EXISTS 'storno';
ALTER TYPE public.incasso_metodo ADD VALUE IF NOT EXISTS 'rettifica';
-- Il refresh del cache PostgREST avviene nelle migrazioni successive (regole/transazioni).
