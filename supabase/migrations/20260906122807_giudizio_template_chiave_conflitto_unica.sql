-- =============================================================================
-- giudizio_template: la stessa trappola della mensa, ancora dormiente
--
-- `POST /api/admin/primaria/giudizi` (action `template`) fa
-- `upsert(…, { onConflict: 'scuola_id,dimensione,valore' })`, ma quelle colonne
-- erano coperte solo da `uq_giudizio_template_scuola … WHERE scuola_id IS NOT
-- NULL`: indice PARZIALE, quindi `ON CONFLICT (colonne)` non lo infersce e la
-- chiamata torna `42P10`. Non è mai stato notato perché la tabella ha 9 righe,
-- tutte GLOBALI (`scuola_id IS NULL`): nessuno ha ancora salvato un frammento di
-- giudizio per una sede. La prima che ci prova prende l'errore della mensa.
--
-- `NULLS NOT DISTINCT` unifica i due indici in uno: per le righe globali
-- (`scuola_id` NULL) l'unicità su (dimensione, valore) resta esattamente quella
-- che garantiva `uq_giudizio_template_global`.
--
-- SICUREZZA SUI DATI ESISTENTI: misurato il 2026-09-06 — 9 righe, tutte con
-- `scuola_id IS NULL`, zero duplicati sulla nuova chiave. Nessuna riga toccata.
--
-- Prima si crea il nuovo indice, poi si tolgono i due vecchi: in nessun istante
-- la tabella resta senza presidio. Ogni istruzione è idempotente, quindi una
-- riesecuzione dopo un'interruzione riprende senza danno. I due indici che
-- cadono non sono retti da nessun vincolo (verificato sul catalogo di
-- produzione): per loro `DROP INDEX` è giusto, e nessuna chiave esterna vi si
-- appoggia.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_giudizio_template_chiave
    ON public.giudizio_template (scuola_id, dimensione, valore)
    NULLS NOT DISTINCT;

DROP INDEX IF EXISTS public.uq_giudizio_template_scuola;
DROP INDEX IF EXISTS public.uq_giudizio_template_global;

COMMENT ON INDEX public.uq_giudizio_template_chiave IS
    '2026-09-06: chiave unica dei frammenti di giudizio. NULLS NOT DISTINCT perché i template globali hanno scuola_id NULL e ON CONFLICT deve poterli inferire.';
