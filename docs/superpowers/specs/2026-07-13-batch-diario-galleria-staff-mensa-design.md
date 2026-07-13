# Piano — Batch: Diario scorrevole · Galleria/foto privata · Anagrafica Staff · Mensa segreteria (Kidville)

## Contesto
Quattro problemi indipendenti, un solo branch (`feat/batch-diario-galleria-staff-mensa`, creato da
`main` in worktree — il branch parallelo `feat/logging-strutturato` mergerà dopo). **PRD** aggiornato
nello stesso lavoro. Gate: `npx eslint . --max-warnings 0` · `npx vitest run` · `npm run build` · E2E CI.

1. **Diario 0-6** (docente + cockpit segreteria, componente condiviso `DiaryEventEditor`): la scelta
   dell'evento era una **griglia 3×N di tessere quadrate grandi** che spingeva il contenuto sotto la piega.
2. **Galleria foto/video**: l'upload docente era **sempre rotto**. `alunni.consenso_privacy` (la
   "liberatoria") nasce `false` e **nessuna API poteva impostarla** (il `PATCH` la scartava via zod e non
   era in `allowedFields`) → il server **422-ava ogni foto** con un taggato senza liberatoria, mentre il
   tagging resta obbligatorio: nessuna foto pubblicabile.
3. **Anagrafica, tab Staff**: **sempre vuota**. Interrogava l'endpoint dei **genitori** filtrando su un
   workaround morto (il ruolo scritto in `citizenship`).
4. **Mensa, sportello segreteria**: la Segreteria riceveva **403** su `/api/mensa/prenotazioni` → non
   poteva inserire pasti su chiamata fuori orario né leggere il Report Cucina.

## Decisioni utente
- **Diario**: **card compatte scorrevoli** al posto della griglia di quadrati grandi.
- **Galleria — foto privata (opzione B)**: un alunno **senza liberatoria è taggabile da solo**; la foto
  resta visibile ai soli suoi genitori. Conseguenza accettata: due fratelli entrambi senza liberatoria
  non possono comparire nella stessa foto.
- **Anagrafica**: tab Staff nella **stessa tabella** dell'anagrafica + **scheda staff dedicata**.
- **Sequenziamento/logging**: branch nuovo da `main` in worktree; l'infrastruttura logging
  (`withRoute`/`logger`) vive su `feat/logging-strutturato` → le nuove superfici hanno un'**appendice di
  adeguamento** da applicare alla convergenza (chi mergia per secondo — vedi in fondo).

## Design

### T1 — Diario: riga scorrevole
- La griglia 3×N di tessere-evento quadrate diventa una **riga di card compatte 92px** a scorrimento
  orizzontale (scrollbar nascosta, `snap`, auto-scroll della selezionata).
- **Indicatore di selezione** = **bordo pieno verde DENTRO il bottone** + `aria-pressed` (visibile anche
  in **alto contrasto**, dove il colore da solo non basta).
- **reduced-motion** rispettato: scroll-smooth via CSS, mai forzato via JS.
- Rimosso il componente legacy morto `StudentDiaryRow` (nessun importatore).
- **Contratto E2E bloccato** da un nuovo test componente: `aria-label` = `"Registra <label>"`.

### T2 — Galleria: regola "foto privata" + liberatoria scrivibile + gate
- **Semantica ≤1 taggato**: se la foto ha **un solo taggato**, la liberatoria **non serve** — visibilità
  ristretta ai genitori di quell'alunno (filtro di visibilità tagged esistente). Se ha **più di un
  taggato**, la liberatoria è richiesta a **tutti**; altrimenti **422 coi nomi**. Broadcast invariato e
  ora **riservato alla Direzione anche lato server** (prima solo UI). Applicato in POST e PATCH (sui tag
  effettivi dopo l'update).
- **Toggle "Liberatoria foto/video firmata"** nella scheda alunno dell'anagrafica (checkbox nel blocco
  Dati Medici/Didattici), persistito via `PATCH /api/admin/students` (`consenso_privacy` aggiunto a schema
  zod + `allowedFields`; audit `logScrittura` già presente).
- **Errori parlanti**: 422 chiaro coi nomi; il client mostra l'errore vero del server (prima: generico).
- **MIME video normalizzato** (codec suffix vs allow-list del bucket).
- **Hardening gate**: `GET /api/gallery` mai più anonima (genitore → `requireParentOfStudent` col PROPRIO
  `parentId`; docente/staff → `requireDocente`); PATCH con identità **dal gate** (body `userId` ignorato);
  header `x-user-id` su tutti i call-site (incl. `syncEngine` offline).

### T3 — Anagrafica: tab Staff reale
- La tab e la scheda leggono da `utenti` via `GET /api/admin/staff` — **lettura estesa alla Segreteria**
  (costante `LETTURA`); le **scritture restano Direzione**.
- Righe nella **stessa tabella** dell'anagrafica, colonne dedicate (Email/Ruolo/Sede/Classi, badge
  `labelRuolo`, niente checkbox/bulk); ricerca funzionante; **export CSV** dedicato.
- Nuova scheda `StaffDetailPanel` (dati + classi assegnate; modifica ruolo/sede/sezioni e **"Rigenera
  credenziali" SOLO Direzione**, server **403** come backstop).
- Il workaround `citizenship` è **dismesso in lettura**. Pannello Gestione Staff: errori resi **visibili**
  (prima inghiottiti), azioni nascoste ai non-Direzione.

### T4 — Mensa: sportello segreteria
- `STAFF_FORZA = admin|coordinator|segreteria` su **GET/POST/DELETE** di `/api/mensa/prenotazioni`: la
  Segreteria può **inserire pasti fuori orario** (salta cutoff e vincolo saldo>0; il saldo può andare
  **negativo** → l'alunno compare nei morosi; **origine derivata server-side** = `segreteria`; movimento
  su `mensa_ticket_movimenti` con `saldo_dopo`) e **disdire oltre il cutoff** (anche date passate:
  rettifica con riaccredito, tracciata con `creato_da`/`creato_il`).
- `requireKitchenRead` ora include la Segreteria → il tab **Report Cucina** funziona (flusso: inserisci →
  controlli il report). Il genitore resta vincolato a cutoff + saldo>0.

## Follow-up dichiarati (non in questo batch)
- **Galleria**: bucket storage **pubblico → signed URL**; **DELETE galleria** ancora su identità legacy
  presa dalla query.
- **Mensa**: **atomicità saldo** (read-then-write non transazionale → RPC futura); **controllo errori di
  scrittura** nella DELETE.
- **Staff**: **pruning `section_ids`** al cambio sede.

## Testing
- **T1**: test componente `DiaryEventEditor` — contratto `aria-label "Registra <label>"`, indicatore di
  selezione (`aria-pressed`).
- **T2/T4**: test route-level della catena galleria (422 solo su foto di gruppo, foto privata a 1 taggato,
  gate GET/PATCH) e ticket mensa (prenotazione genitore scala saldo+ledger; blocchi saldo 0/cutoff/non
  legato; multi-data con saldo parziale; disdetta riaccredita; segreteria forza a −1; report con gate reale).
- **T3**: E2E rafforzato (la tab Staff deve mostrare la docente E2E seminata).
- **Gate**: `vitest` **1229 test / 196 file** verdi · `eslint` **0** · `tsc` pulito. Build + E2E in CI al push.

## Appendice logging (da applicare alla convergenza con `feat/logging-strutturato`)
Le nuove superfici nascono su un branch **senza** `withRoute`/`logger`; chi mergia per secondo aggiunge —
**senza mai dati personali** (lista bianca `@/lib/logging/redact`):
- **Galleria** — 422 privacy-lock (foto di gruppo) → `logEvento` con i **soli conteggi** (n. taggati, n.
  senza liberatoria), MAI nomi; pubblicazione ok → `logOk`; errori storage → `logErrore` **col corpo**
  dell'errore (uno status nudo non basta).
- **Mensa** — prenotazione/disdetta → `logOk` con esiti + `saldoDopo` + `origine`; saldo che va negativo
  → `logEvento` livello `info` (forzatura Segreteria, non un errore).
- Route nuove/estese avvolte in `withRoute('gruppo/route:METODO', …)`; ogni `catch` logga; gate e `zod`
  restano nel corpo della route.
