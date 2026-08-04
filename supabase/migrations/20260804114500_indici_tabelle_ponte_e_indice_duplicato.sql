-- ═══════════════════════════════════════════════════════════════════════════════
-- Indici sulle due tabelle ponte genitore↔figlio, e un indice duplicato che se ne va
-- Collaudo del 2026-08-03, rilievo T11-F6 (+ una scoperta collaterale su `parents`)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── PRIMA DI TUTTO: OGGI QUESTA MIGRAZIONE NON FA GUADAGNARE NIENTE ─────────
--
-- Misurato in produzione il 2026-08-04, non dedotto:
--     student_parents          →  36 righe,  56 kB,  1 indice (la sola PK)
--     legame_genitori_alunni   →  48 righe,  24 kB,  1 indice (la sola PK)
-- A questi volumi il planner fa comunque una scansione sequenziale, ed è la scelta
-- giusta: una tabella che sta in una pagina si legge tutta più in fretta di quanto
-- costi passare da un indice. Il beneficio misurabile oggi è **zero**, e chi legge
-- questo file fra un anno deve saperlo invece di dedurre che servisse.
--
-- Si applica lo stesso, per tre ragioni che non sono «il rilievo lo chiedeva»:
--   1. il costo è nullo e irreversibile in nessun senso (due btree da una pagina,
--      nessun lock percepibile, si tolgono con due DROP);
--   2. la colonna di filtro è la SECONDA della PK composita, quindi non è coperta:
--      `student_parents_pkey` è `(student_id, parent_id)` e il codice filtra per
--      `parent_id` in 9 punti — fra cui `assertParentInScope` (src/lib/auth/scope.ts:669
--      e :691), che è un gate di SICUREZZA sull'isolamento fra le tre sedi. È la query
--      che si vuole veloce quando le righe cresceranno, non quella che si nota ora;
--   3. l'advisor `unindexed_foreign_keys` le segnala a ogni giro: un avviso che si
--      sa di dover ignorare addestra a ignorare anche i prossimi.
--
-- La soglia oltre la quale questi indici cominciano a servire davvero è dell'ordine
-- delle migliaia di righe. Con 32 alunni in tre sedi, è lontana.
--
-- ─── LA COSA CHE INVECE UN GUADAGNO CE L'HA: UN INDICE DI TROPPO ─────────────
--
-- Trovata cercando altro. `public.parents` ha DUE indici sulla stessa identica
-- colonna:
--     parents_auth_user_id_key   UNIQUE btree (auth_user_id)   ← vincolo, serve
--     idx_parents_auth_user_id          btree (auth_user_id)   ← copia, non serve
-- Il secondo non può fare niente che il primo non faccia già: un indice UNIQUE è un
-- btree e il planner lo usa per le stesse ricerche. Quello che fa, invece, è farsi
-- mantenere a ogni INSERT e UPDATE su `parents`. Questo sì che è un costo attivo
-- oggi, piccolo ma reale, e a differenza degli indici qui sopra si paga a ogni
-- scrittura invece che mai.
--
-- ─── E UNA TERZA COSA, che è la ragione per cui le prime due si notano poco ──
--
-- Le statistiche del planner sono stantie: `pg_class.reltuples` dice 21 righe per
-- `student_parents` (reali: 36), 45 per `legame_genitori_alunni` (reali: 48), 27 per
-- `alunni` (reali: 32). Non è un guasto — l'autovacuum non si sveglia per tabelle
-- così piccole — ma significa che il planner sta decidendo su numeri vecchi. Un
-- ANALYZE costa un istante e rende vere le stime su cui si baserà ogni piano futuro,
-- compresi quelli che useranno gli indici creati qui sopra.
--
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── 1. I due indici sulle tabelle ponte ────────────────────────────────────
-- `IF NOT EXISTS` perché questa migrazione deve poter girare due volte senza
-- rompersi: il DB E2E della CI non è migrato allo stesso passo della produzione.

CREATE INDEX IF NOT EXISTS idx_student_parents_parent_id
  ON public.student_parents (parent_id);

COMMENT ON INDEX public.idx_student_parents_parent_id IS
  'Copre il filtro per parent_id (2ª colonna della PK composita, quindi non coperta da questa). '
  'Usato da assertParentInScope e getFigliDiGenitore. Al 2026-08-04 la tabella ha 36 righe: '
  'il planner sceglie comunque Seq Scan, ed è corretto. Serve alla crescita, non a oggi.';

CREATE INDEX IF NOT EXISTS idx_legame_genitori_alunni_alunno_id
  ON public.legame_genitori_alunni (alunno_id);

COMMENT ON INDEX public.idx_legame_genitori_alunni_alunno_id IS
  'Copre il filtro per alunno_id (2ª colonna della PK composita). '
  'Stessa nota dell''indice gemello: al 2026-08-04 la tabella ha 48 righe.';

-- ─── 2. L'indice duplicato su parents ───────────────────────────────────────
-- Si toglie il NON-UNIQUE e si tiene il UNIQUE: il vincolo di unicità è anche un
-- indice, il contrario non è vero. Togliere quello sbagliato dei due farebbe cadere
-- una garanzia di integrità (un genitore ↔ un utente auth), che è la ragione per cui
-- l'ordine di queste due righe non è indifferente e va letto prima di modificarlo.

DROP INDEX IF EXISTS public.idx_parents_auth_user_id;

-- ─── 3. La FK di app_log che contraddice il progetto di app_log (T03-F5) ────
--
-- La migrazione `20260713090000_app_log.sql` dichiara, in due punti:
--     «Nessun IP grezzo, nessuna FK (né su utente_id né su scuola_id): il log deve
--      sopravvivere all'oblio GDPR e alla cancellazione di una sede.»
--     `scuola_id uuid,  -- SENZA FK: idem, e sopravvive alla chiusura di una sede`
--
-- Misurato oggi in produzione:
--     app_log_scuola_id_fkey  FOREIGN KEY (scuola_id) REFERENCES schools(id)
--
-- La FK c'è, aggiunta il 2026-07-31 dall'audit multi-sede. E **non ha ON DELETE**,
-- quindi vale `NO ACTION`: la cancellazione di una sede con anche una sola riga di
-- log viene RIFIUTATA. Il commento non è soltanto scaduto — descrive una garanzia
-- («il log sopravvive alla chiusura di una sede») che la FK ha trasformato nel suo
-- opposto, e in silenzio.
--
-- Non è un caso di scuola: in produzione le sedi sono quattro, e la quarta è la sede
-- fittizia `e2e00000-…` su cui gira la CI. Il giorno in cui qualcuno provasse a
-- toglierla dal database di produzione — cosa che prima o poi va fatta — si
-- troverebbe davanti un errore di vincolo su una tabella di LOG, senza capire perché.
--
-- Qui non si sceglie fra le due intenzioni: le si tiene entrambe. `ON DELETE SET NULL`
-- conserva l'integrità referenziale finché la sede esiste (una riga di log non può
-- puntare a un plesso inventato) e restituisce al log la sua proprietà di
-- sopravvivere: cancellata la sede, le righe restano e perdono il solo riferimento.
-- È esattamente ciò che entrambi i commenti volevano, separatamente.

ALTER TABLE public.app_log
  DROP CONSTRAINT IF EXISTS app_log_scuola_id_fkey;

ALTER TABLE public.app_log
  ADD CONSTRAINT app_log_scuola_id_fkey
  FOREIGN KEY (scuola_id) REFERENCES public.schools(id)
  ON DELETE SET NULL;

COMMENT ON COLUMN public.app_log.scuola_id IS
  'FK verso schools con ON DELETE SET NULL: il vincolo vale finché la sede esiste, '
  'ma la cancellazione di una sede NON deve poter essere bloccata da una tabella di log. '
  'Il commento della migrazione 20260713090000 dice «SENZA FK»: era vero fino al 2026-07-31.';

-- ─── 4. Statistiche vere per il planner ─────────────────────────────────────

ANALYZE public.student_parents;
ANALYZE public.legame_genitori_alunni;
ANALYZE public.parents;
ANALYZE public.alunni;

-- ═══════════════════════════════════════════════════════════════════════════════
-- COME SI TORNA INDIETRO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Il rilievo T03-F4 del collaudo dice che nessuna delle ultime migrazioni spiega
-- come si annulla. Questa lo spiega, e non per formalità: senza questo blocco, chi
-- deve ripristinare alle tre di notte deve prima leggere e capire tutto il file.
--
--   DROP INDEX IF EXISTS public.idx_student_parents_parent_id;
--   DROP INDEX IF EXISTS public.idx_legame_genitori_alunni_alunno_id;
--   CREATE INDEX IF NOT EXISTS idx_parents_auth_user_id ON public.parents (auth_user_id);
--
-- Nessuna delle tre operazioni tocca un solo dato: sono tutte e tre reversibili
-- senza perdita, e nessuna richiede una finestra di fermo. L'ANALYZE non si annulla
-- (né avrebbe senso: rende le stime più vere, non diverse).
--
-- L'unica cosa da sapere prima di annullare: il DROP dell'indice duplicato su
-- `parents` NON tocca `parents_auth_user_id_key`, che è il vincolo UNIQUE e resta.
-- Ricrearlo serve solo a tornare esattamente allo stato precedente, non a
-- ripristinare una garanzia — quella non è mai stata sua.
-- ═══════════════════════════════════════════════════════════════════════════════
