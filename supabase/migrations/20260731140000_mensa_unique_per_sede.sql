-- =============================================================================
-- Configurazione mensa: unicità PER SEDE (audit multi-sede 2026-07-31, R44)
--
-- Fino a oggi `mensa_menu_config` e `mensa_class_menu_assignment` avevano il solo
-- indice della chiave primaria. Con una sede sola non si notava; con tre, nulla
-- impedisce che la stessa sede abbia due menu «Standard» — indistinguibili nella
-- tendina — o che la stessa classe risulti assegnata a DUE menu a partire dalla
-- stessa data. In quest'ultimo caso `resolveMenuConfigId`
-- (src/lib/mensa/server.ts) ordina per `attivo_dal DESC` e prende `.limit(1)`: il
-- menu che finisce in tavola — e quindi gli ALLERGENI dichiarati per quel giorno —
-- lo decide l'ordine di lettura di Postgres. È una scelta a caso su un dato di
-- sicurezza alimentare.
--
-- SCELTA DELLA CHIAVE su `mensa_class_menu_assignment`.
-- Il rilievo R44 proponeva `(scuola_id, classe, menu_config_id)`. Non regge, in
-- entrambe le direzioni:
--   · NON chiude l'ambiguità reale — due menu DIVERSI assegnati alla stessa classe
--     dalla stessa data restano ammessi, ed è esattamente il caso che rende
--     nondeterministico `resolveMenuConfigId`;
--   · VIETA un uso legittimo — «menu invernale» dal 1° ottobre, «menu estivo» dal
--     1° aprile, «menu invernale» di nuovo dall'ottobre successivo: la terza riga
--     sarebbe rifiutata perché ripete la coppia (classe, menu).
-- La chiave giusta è quella su cui il codice risolve davvero:
-- `(scuola_id, classe, attivo_dal)`. La deviazione è dichiarata nel rapporto dello
-- step W2-J.
--
-- SICUREZZA SUI DATI ESISTENTI: verificato via MCP prima di applicare —
-- 1 riga in `mensa_menu_config` (nessun duplicato di nome per sede),
-- 0 righe in `mensa_class_menu_assignment`. Nessun backfill, nessuna perdita.
-- Indici UNIQUE e non vincoli: stesso effetto, e restano rimovibili senza
-- riscrivere la tabella.
--
-- Il DB E2E della CI non è migrato: l'app degrada da sé, perché un vincolo in più
-- non cambia nessuna lettura. Lato scrittura le route mappano `23505` su 409 con
-- un messaggio leggibile (`vincoloDuplicato` in src/lib/mensa/scope.ts); dove il
-- vincolo non esiste, quel ramo semplicemente non scatta.
-- =============================================================================

-- Due menu con lo stesso nome nella stessa sede sono indistinguibili per chi li
-- sceglie. In sedi DIVERSE l'omonimia resta lecita (ed è la norma: ogni plesso ha
-- il suo «Standard»).
CREATE UNIQUE INDEX IF NOT EXISTS uidx_mensa_menu_config_sede_nome
    ON public.mensa_menu_config (scuola_id, nome);

-- Una classe, una data d'inizio, un solo menu: è la chiave su cui
-- `resolveMenuConfigId` fa `ORDER BY attivo_dal DESC LIMIT 1`.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_mensa_class_assign_sede_classe_dal
    ON public.mensa_class_menu_assignment (scuola_id, classe, attivo_dal);

COMMENT ON INDEX public.uidx_mensa_menu_config_sede_nome IS
    'R44 (2026-07-31): il nome del menu è univoco DENTRO la sede, non fra le sedi.';
COMMENT ON INDEX public.uidx_mensa_class_assign_sede_classe_dal IS
    'R44 (2026-07-31): una sola assegnazione per (sede, classe, data d''inizio) — è la chiave su cui resolveMenuConfigId prende .limit(1).';
