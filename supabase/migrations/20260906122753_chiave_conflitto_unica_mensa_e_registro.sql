-- =============================================================================
-- Menu mensa: UNA chiave di conflitto, e un indice che ON CONFLICT sa inferire
--
-- Fino a oggi l'unicità era espressa da due indici PARZIALI per tabella — uno
-- `WHERE menu_config_id IS NULL` (menu unico), uno `WHERE menu_config_id IS NOT
-- NULL` (multi-menu). La garanzia era giusta; il modo di esprimerla no.
-- `ON CONFLICT (colonne)` NON infersce un indice parziale: Postgres pretende un
-- `WHERE` che implichi il predicato, e PostgREST non ha modo di mandarlo (il
-- parametro è `on_conflict=<colonne>` e basta). Risultato: `42P10` su OGNI
-- salvataggio del builder menu, in ogni sede, in entrambi i rami, da quando gli
-- indici parziali esistono. Nove tentativi a Cesa il 2026-09-05, tutti falliti;
-- il menu vero di Giugliano («menu nido», 2026-07-06) non ha mai avuto una riga.
--
-- LA GARANZIA NON CAMBIA. `NULLS NOT DISTINCT` (PostgreSQL 15+; in produzione
-- gira 17.6, misurato) fa considerare uguali due `NULL`: l'indice combinato,
-- ristretto alle righe con `menu_config_id IS NULL`, È l'indice parziale di prima.
-- Nessuna coppia che era vietata diventa lecita, e viceversa.
--
-- SICUREZZA SUI DATI ESISTENTI: verificato prima di applicare, il 2026-09-06 —
-- 20 righe in `mensa_menu_rotazione`, 5 in `mensa_menu_override`, ZERO duplicati
-- sulle nuove chiavi (`GROUP BY … HAVING count(*) > 1` tratta i `NULL` come
-- uguali, cioè misura esattamente la semantica di `NULLS NOT DISTINCT`).
-- Nessun backfill, nessuna riga toccata.
--
-- Prima si creano i nuovi indici, poi si tolgono i vecchi: in nessun istante la
-- tabella resta senza presidio. Ogni istruzione è idempotente, quindi una
-- riesecuzione dopo un'interruzione riprende senza danno.
--
-- Il DB E2E della CI è un progetto separato e non migrato: là questi indici non
-- esistono e un upsert col nuovo elenco tornerebbe `42P10`. Oggi nessuno spec
-- Playwright salva il menu, quindi non scatta; se un domani ne nascerà uno, la
-- route risponde con `MENU_NON_SALVATO` e lascia `42P10` nel log — un ripiego di
-- chiave che non scatta mai è un ripiego che nessuno vede rompersi.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uidx_mensa_rot_chiave
    ON public.mensa_menu_rotazione (scuola_id, menu_config_id, settimana, giorno_settimana)
    NULLS NOT DISTINCT;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_mensa_ovr_chiave
    ON public.mensa_menu_override (scuola_id, menu_config_id, data)
    NULLS NOT DISTINCT;

DROP INDEX IF EXISTS public.uidx_mensa_rot_legacy;
DROP INDEX IF EXISTS public.uidx_mensa_rot_menu;
DROP INDEX IF EXISTS public.uidx_mensa_ovr_legacy;
DROP INDEX IF EXISTS public.uidx_mensa_ovr_menu;

-- ─── E la stessa cura al registro, perché è lo stesso difetto ────────────────
-- Trovato dalla revisione di qualità del Task 3 (2026-09-06). `unique_registro_orario`
-- copre `(scuola_id, classe_sezione, data, ora_lezione)` e NON è parziale, quindi
-- `ON CONFLICT` lo infersce e `42P10` non scatta — ma `registro_orario.scuola_id`
-- ammette NULL, e senza `NULLS NOT DISTINCT` due `NULL` sono DIVERSI: una riga di
-- registro senza sede non troverebbe mai sé stessa, e ogni salvataggio ne
-- INSERIREBBE una nuova invece di aggiornarla. Duplicati silenziosi al posto di un
-- errore rumoroso: peggio del difetto che questo lavoro chiude.
-- Oggi non morde — misurato il 2026-09-06: 14 righe, ZERO con `scuola_id IS NULL`,
-- ZERO duplicati sulla chiave — ed è per questo che si fa adesso, mentre non costa
-- niente, e non il giorno in cui morderà.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_registro_orario_chiave
    ON public.registro_orario (scuola_id, classe_sezione, data, ora_lezione)
    NULLS NOT DISTINCT;

-- 🔴 `ALTER TABLE … DROP CONSTRAINT`, NON `DROP INDEX`. Verificato sul catalogo di
-- produzione il 2026-09-06: `unique_registro_orario` ha `contype = 'u'` — nasce da un
-- `ADD CONSTRAINT`, e l'indice omonimo è quello che il vincolo si porta dietro.
-- Postgres RIFIUTA `DROP INDEX` su un indice che regge un vincolo, e `IF EXISTS` non
-- salva perché l'indice c'è: la migrazione si sarebbe fermata QUI, dopo aver già
-- creato l'indice nuovo e droppato i quattro della mensa. A metà, in produzione.
-- Gli altri sei indici che questa migrazione lascia cadere non sono retti da nessun
-- vincolo (verificato nella stessa query): per loro `DROP INDEX` è giusto. E nessuna
-- chiave esterna si appoggia a questi indici — le tre FK che puntano a
-- `registro_orario` usano la sua chiave primaria — quindi nessun `CASCADE` serve.
ALTER TABLE public.registro_orario DROP CONSTRAINT IF EXISTS unique_registro_orario;

COMMENT ON INDEX public.uidx_registro_orario_chiave IS
    '2026-09-06: sostituisce unique_registro_orario. Stesse colonne, più NULLS NOT DISTINCT: scuola_id è nullable, e senza questo una riga senza sede si duplicherebbe a ogni salvataggio invece di aggiornarsi.';

COMMENT ON INDEX public.uidx_mensa_rot_chiave IS
    '2026-09-06: chiave unica di rotazione. NULLS NOT DISTINCT perché il menu unico ha menu_config_id NULL e ON CONFLICT deve poterla inferire (i due indici parziali di prima davano 42P10).';
COMMENT ON INDEX public.uidx_mensa_ovr_chiave IS
    '2026-09-06: chiave unica delle variazioni di menu. Stessa ragione dell''indice di rotazione.';
