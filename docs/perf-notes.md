# Note perf — M9 (piano "app 100%")

Decisioni prese in M9.4–M9.6 e loro razionale, per chi riprende in mano il tema.

## Fatte

- **jsPDF/xlsx on-demand (M9.4)**: `await import()` negli handler dei 4 siti
  client (admin/modulistica, parent/modulistica, teacher scrutinio,
  ImportExportClient). Le librerie sono fuori dal bundle iniziale delle pagine.
  Rimosso anche `import 'jspdf-autotable'` in admin/modulistica: mai usato.
- **Loghi/mascotte su next/image (M9.5)**: login, parent home (logo+mascotte),
  teacher home. `width/height` intrinseci in scala + `priority` (eager come gli
  `<img>` sostituiti); resa verificata al pixel coi bounding box in dev.
  I media utente (gallery, chat, avatar, allegati task, foto delegato) restano
  `<img>` con disable motivato: URL runtime da storage, l'optimizer Next non
  aggiunge valore e `remotePatterns` andrebbe mantenuto allineato al bucket.
- **/api/me dedup**: da 6-8 round-trip Supabase a 1 `getUser` + 2 query
  parallele (lock nel test `dedup M9`).

## Skip documentati

- **LazyMotion (framer-motion)**: SKIP da piano (M9.4) — rischio behavior-diff
  sulle animazioni, che sono vincolo assoluto del redesign.
- **React.memo su righe-lista (M9.6)**: SKIP motivato.
  - Righe appello (`StudentAttendanceRow`): il memo sarebbe un no-op senza
    rendere stabile `handleSetStato` (ricreata a ogni render). Stabilizzarla
    con `useCallback` richiede di rivedere l'optimistic update + rollback
    (oggi legge lo snapshot di `records` alla chiamata): refactor a rischio
    stale-closure su un flusso coperto dagli E2E dell'appello.
  - Lista alunni admin (`StudentTable`): righe inline con closure di
    ordinamento/selezione ricreate a ogni render; stesso problema.
  - In entrambi i casi le liste reali sono piccole (10–30 righe) e non esiste
    una misura di profiler che mostri render sprecati percepibili: il criterio
    del piano era "SOLO su righe-lista misurabili", quindi niente memo alla
    cieca. Se in futuro si misura un problema (classi molto numerose), la
    strada è: `useCallback` con functional setState (mai leggere `records`
    direttamente nel corpo) + `React.memo` sulla riga.
