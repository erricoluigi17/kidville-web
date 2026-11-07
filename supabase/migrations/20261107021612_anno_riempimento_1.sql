-- Anno scolastico · PR 2 · F1 · il riempimento.
--
-- Dà un anno a ogni riga del registro che non lo ha, crea le frequenze (una per alunno, origine `recupero`), il
-- listino 2026/27, il 2027/28 `in_preparazione` con la copia della configurazione, e traduce i nomi di classe in
-- uuid. Solo chiamate: la logica sta in M1 (`anno_riempi`), provata dai test su PGlite.
--
-- UN FILE SOLO (non tre): il banco di misura (`__tests__/db/anno-banco-riempimento.test.ts`) ha dato 8,7 s in PGlite
-- per tutto il riempimento sul seme di dimensioni vere (65.000 `eventi_diario`, 31.000 `presenze`, 20.000
-- `chat_messages`…), sotto la soglia dei 15 s (produzione ≈ PGlite × 4, da tenere sotto il minuto). Se fallisce,
-- tutto torna indietro e l'app lavora come prima; si può rilanciare (tocca solo righe con `anno_id` NULL).
--
-- Interruttori che `anno_riempi()` accende e spegne da sola, SOLO dentro questa transazione (`set_config(…, true)`),
-- e che il corpo della PR mostra al titolare:
--   · `scatola_nera.senza_storico` = on  → la scatola nera non copia il «com'era» di ogni riga toccata;
--   · `anno_scolastico.riempimento` = on → il trigger dell'anno rimette `storico_versione` e `updated_at`.
-- `registri.manutenzione` NON si accende: nessun trigger di queste tabelle lo legge.
--
-- Nessun uuid di sede, nessuna lettura di `schools.operativa`, nessuna tabella data per scontata (`to_regclass`).

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '10min';

-- La fotografia PRIMA, come prima istruzione: conteggi, euro e casi ambigui per tabella, sede e anno.
SELECT public.anno_fotografa('prima');

-- Il riempimento.
SELECT public.anno_riempi();

-- La fotografia DOPO: `anno_riconciliazione_differenze()` deve essere vuota (dopo − prima − nuove = 0).
SELECT public.anno_fotografa('dopo');
