# Non iscritti: elenco separato ed eliminazione definitiva — design

**Data:** 2026-10-08 · **Branch:** `feat/elimina-non-iscritti` · **Richiesta del titolare, approvata in brainstorming**

## 1. Il problema, misurato

Tre segnalazioni del titolare, verificate in produzione con sole `SELECT` il 2026-10-08:

- **Caso A — un adulto inserito come bambino.** Una scheda `alunni` con data di nascita del 1980, già
  archiviata (`ritirato`), collegata alla scheda `parents` della stessa persona — quella vera, con
  account e 2 figli iscritti. Nessun pagamento, voto, diario: solo 1 riga in `student_parents` e 1 in
  `legame_genitori_alunni`.
- **Caso B — un doppione.** Due schede con stesso nome e data di nascita e codice fiscale diverso
  (refuso di un carattere, la stessa famiglia di difetto sanata il 2026-09-14). La buona è iscritta con
  sezione, genitori, pagamenti e diario; il doppione è archiviato e ha solo 1 presenza.
- **L'elenco «Alunni» mostra anche chi non frequenta**: `GET /api/admin/students` senza filtri, e
  `page.tsx` filtra solo a mano (tendina «Stato»).

**Perché oggi non si riesce a eliminare:** nell'applicazione **non esiste una cancellazione vera**.
Esistono «Archivia» (`stato = 'ritirato'`), «Libera spazio» (foto, video, chat; solo Direzione) e
l'oblio GDPR (`admin/gdpr/erase`: solo Direzione, dal pannello Impostazioni, nominativo da
riscrivere, **anonimizza** e la riga resta). La vecchia `DELETE /api/admin/students` è stata tolta il
2026-08-12: scriveva l'audit *prima* di cancellare, la `DELETE` falliva con `23503` (FK senza
`CASCADE`) e l'audit restava a dichiarare cancellato un bambino iscritto, con dentro una copia delle sue
note mediche (lock `registro-modifiche-senza-hard-delete`).

Numeri al 2026-10-08 (sedi vere): 16 schede `ritirato` (4 già anonimizzate), 2 `iscritto` senza
sezione. 6 schede non iscritte hanno pagamenti; di queste, 5 hanno un incasso registrato, 2 una
fattura e un bonifico abbinato, 1 una ricevuta. In `alunni` vale sempre
`section_id IS NULL ⇔ classe_sezione vuota` (misurato).

## 2. Decisioni del titolare

| Domanda | Decisione |
|---|---|
| Cosa fa «Elimina» se ci sono pagamenti? | **Lo sceglie la segreteria** nella finestra: «Cancella anche i pagamenti» (solo se cancellabili) · «Anonimizza e tieni la contabilità» · Annulla |
| Iscritti senza sezione | Nella linguetta dei non iscritti, **gruppo a parte** con «Assegna sezione» |
| Chi elimina | **Segreteria e Direzione**, nelle proprie sedi |
| Conferma | **Niente nominativo da riscrivere**: anteprima con i numeri, poi un bottone |
| Genitori | **Mai toccati**: si toglie solo il legame |
| Registro della primaria (voti, pagelle, scrutini, note, certificati delle competenze) | **Né cancellato né anonimizzato** — da nessuna porta, **oblio GDPR compreso** (art. 17 §3 lett. b: dati che la legge obbliga a conservare) |
| Pagamenti cancellabili | Solo senza ricevuta, fattura, bonifico abbinato **né incasso registrato** (decisione di design, segnalata al titolare in revisione) |

## 3. Cosa vede la segreteria

### 3.1 Linguetta «Alunni»
Solo chi **frequenta**: `stato ∈ STATI_CHE_FREQUENTANO` (`iscritto`, `sospeso`) **e** `section_id`
non nullo. Contatori, ricerca, filtro classe ed export CSV seguono. La tendina «Stato» perde
`ritirato` (resta Tutti / Iscritto / Sospeso); l'opzione «Non assegnata» del filtro classe sparisce
(quei bambini non sono più qui).

### 3.2 Linguetta «Non iscritti» (oggi «Non più iscritti», stessa `id` `archiviati`)
Due tabelle, una sopra l'altra, ciascuna con il suo titolo e il suo conteggio:

1. **Ritirati** — `stato ∈ STATI_NON_PIU_ISCRITTO`. Azioni attuali invariate (Riattiva, Libera
   spazio solo Direzione) + **Elimina definitivamente**.
2. **Iscritti senza sezione** — `stato ∉ STATI_NON_PIU_ISCRITTO` e `section_id IS NULL`. Azioni:
   **Assegna sezione** (tendina con le sezioni **della sede del bambino**; riusa
   `PATCH /api/admin/students { ids: [id], classe_sezione }`, poi rilegge: il bambino passa fra gli
   Alunni) + **Elimina definitivamente**.

Le schede con `anonimizzato_il` non compaiono: per chi usa l'app sono eliminate. Il numero sulla
pillola è la somma delle righe arrivate nei due gruppi (stessa regola di oggi: righe arrivate, non
`X-Total-Count`).

### 3.3 Finestra «Elimina definitivamente» (`EliminaDefinitivoDialog`)
1. All'apertura chiama l'**anteprima** e mostra i numeri: presenze, diario, legami con genitori (con
   la frase «i genitori non vengono toccati»), documenti/pagelle/certificati, foto, chat, pagamenti.
2. Le scelte dipendono da cosa c'è:
   - **nessun pagamento e nessun registro della primaria** → un bottone rosso «Elimina
     definitivamente»;
   - **pagamenti presenti** → «Cancella anche i pagamenti» (spento, con il motivo scritto accanto, se
     un pagamento ha ricevuta, fattura, bonifico abbinato o incasso registrato) · «Anonimizza e tieni
     la contabilità» · Annulla;
   - **registro della primaria presente** (valutazioni, pagelle, scrutini, note disciplinari,
     certificati delle competenze) → **nessuna scelta**: la finestra spiega che il registro va
     conservato e che la scheda resta fra i ritirati, e offre solo «Chiudi». Questa condizione vince
     sulle altre: con registro e pagamenti insieme, non si offre niente.
3. Esito: successo → la riga sparisce e l'elenco si rilegge; rifiuto/guasto → il messaggio del server
   (tradotto dal `codice`), la finestra resta aperta.

Ruoli: il comando compare a `admin`, `coordinator`, `segreteria` (cortesia; il gate è sul server).

## 4. Come funziona sotto

### 4.1 Elenchi — `GET /api/admin/students?elenco=…`
Nuovo parametro zod `elenco: z.enum(['frequentanti', 'non_iscritti']).optional()`.
- assente → **comportamento identico a oggi** (lo usano pagamenti, sezioni, generatori di categoria);
- `frequentanti` → `.in('stato', STATI_CHE_FREQUENTANO).not('section_id', 'is', null)`;
- `non_iscritti` → `.or('stato.in.(…STATI_NON_PIU_ISCRITTO),section_id.is.null')` +
  `.is('anonimizzato_il', null)` (colonna in baseline: c'è anche sul DB E2E).

La proiezione aggiunge `section_id`, già presente. La UI divide i due gruppi con
`eNonPiuIscritto(stato)`.

### 4.2 Route `POST /api/admin/students/elimina`
Corpo: `{ alunno_id: uuid, mode: 'dryrun' | 'execute', scelta?: 'elimina' | 'elimina_con_pagamenti' | 'anonimizza' }`
(`scelta` obbligatoria in `execute`). Ordine:

1. `requireStaff(request, [...RUOLI_ELIMINA_DEFINITIVO])` — nuova costante `['admin','coordinator','segreteria']`
   in `src/lib/alunni/archiviazione.ts`, letta da server **e** client.
2. `parseBody` → lettura della scheda (errore PostgREST ≠ 404) → `assertAlunnoInScope`.
3. **Ammissibilità**: non anonimizzata **e** (`eNonPiuIscritto(stato)` **o** `section_id` nullo).
   Altrimenti `409 ALUNNO_ANCORA_FREQUENTANTE`.
4. **Conteggi** (sole `SELECT`, lib nuova `src/lib/alunni/elimina-definitivo.ts`,
   `contaPerEliminazione`): le voci di `contaCosaDistrugge` + pagamenti, pagamenti bloccati (ricevuta ·
   fattura · riconciliazione · incasso), registro primaria (via `leggiRegistroPrimaria`, §4.4). Una
   lettura fallita → `null`, mai `0`, e l'`execute` si ferma (`500 ELIMINAZIONE_NON_MISURATA`).
5. `dryrun` → `{ dryrun: true, conteggi, scelte: { elimina, elimina_con_pagamenti, anonimizza }, motivi }`.
   Con registro primaria presente **tutte e tre** le scelte sono `false` e il motivo è
   `REGISTRO_PRIMARIA`.
6. `execute`, `scelta` non disponibile → `409` con il codice del motivo
   (`REGISTRO_PRIMARIA_DA_CONSERVARE` vince su tutti, poi `ALUNNO_ELIMINAZIONE_HA_PAGAMENTI`, `ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI`). I nomi definitivi dei codici sono quelli del piano (Task 4).
7. `execute` + `elimina` / `elimina_con_pagamenti`:
   a. **file prima** — con le funzioni dell'oblio, nessuna copia (`gdpr-erase-canale-unico`):
      `obliaFotoAlunno`, `obliaFotoNewsAlunno`, `obliaIntentiVideoAlunno`, `obliaPagelleAlunno`,
      `obliaCertificatiMediciAlunno`, `obliaFascicoloAlunno`, `obliaAllegatiChat` (thread del bambino),
      rimozione verificata di `alunni.documento_path` (`rimuoviEVerifica`). Le foto di gruppo si
      **sganciano**, non si cancellano. Un solo file non uscito o un inventario illeggibile →
      **stop prima del DB**, `502 ELIMINAZIONE_FILE_RESTANTI` con i numeri;
   b. **DB in una transazione** — `supabase.rpc('elimina_alunno_definitivo', { p_alunno, p_con_pagamenti })`;
   c. **solo dopo il successo**: `bonificaAuditScritture(supabase, [alunno_id], op)` e poi
      `logScrittura({ entitaTipo: 'alunno_eliminato', azione: 'delete', entitaId, scuolaId,
      valoreDopo: { scelta, conteggi } })` — uuid e numeri, **mai** la riga. `logEvento` di successo.
8. `execute` + `anonimizza` (ammessa solo senza registro primaria, ricontrollato qui):
   `anonimizzaAlunno(...)` sul solo bambino (stessa funzione dell'oblio),
   `logScrittura({ entitaTipo: 'alunno_anonimizzato', … })`, log di successo. I genitori no: un
   genitore rimasto senza figli resta nella linguetta Genitori.

Ogni risposta d'errore ha un `codice` in `CODICI_ERRORE` tradotto in `messages/{it,en}/shared.json`.

### 4.3 Migrazione — `supabase/migrations/<UTC>_alunni_elimina_definitivo.sql`
`public.elimina_alunno_definitivo(p_alunno uuid, p_con_pagamenti boolean) RETURNS jsonb`,
`SECURITY DEFINER`, `SET search_path = public, pg_temp`, owner `postgres`, `REVOKE ALL … FROM
PUBLIC`, `… FROM anon, authenticated`, `GRANT EXECUTE … TO service_role`, `NOTIFY pgrst`.
Modello: `iscrizioni_rinvia` / `iscrizioni_annulla` (già cancellano da `alunni`).

Il corpo **ricontrolla tutto** (la route non è l'unica difesa) e risponde `{ ok, code, … }`:
1. `SELECT … FOR UPDATE` della scheda; assente → `{ok:false, code:'non_trovato'}`.
2. Ammissibilità come in 4.2.3, con `public.stati_alunno_non_piu_iscritto()` (mai `<> 'iscritto'`).
3. Registro primaria presente → `registro_primaria`.
4. Pagamenti presenti e `p_con_pagamenti = false` → `ha_pagamenti`; con `true` e un pagamento con
   ricevuta/fattura/riconciliazione/incasso, quote di un altro alunno appese, o una voce in
   `fatture_coda` non `tolta` (in coda, in invio verso SDI, emessa, in errore) → `pagamenti_non_cancellabili`.
   Le righe di `pagamenti` del bambino si bloccano `FOR UPDATE` prima del controllo: un incasso
   scritto in parallelo o finisce prima (e il controllo lo vede) o fallisce.
5. Cancellazioni, nell'ordine: `solleciti` (per `alunno_id`), `pagamenti` (se ammessi; le figlie
   vanno in `CASCADE`), `eventi_diario`, `legame_genitori_alunni`, `armadietto`, `ticket_mensa`,
   `forms_submissions` (`student_id`), `backup_diario_vuote_20260908` **solo se esiste**
   (`to_regclass`, SQL dinamico: la tabella non ha migrazione), tag del bambino tolto da
   `galleria_media.tag_alunni` (tabella storica, oggi vuota), infine `DELETE FROM alunni` (il resto è
   `CASCADE`; `retta_a_carico_di` dei fratelli va a `NULL` da sé).
6. `{ ok: true, code: 'eliminato', righe: { … conteggi per tabella } }`.

Se ne vanno con la scheda anche le righe in `CASCADE` di registri di accesso legati al bambino
(`fascicolo_accessi_audit`): la traccia dell'eliminazione resta nel registro delle scritture.

Restano **di proposito**: `ricevute_emesse` e `fatture_emesse` (WORM / `RESTRICT`: il caso che le
tocca è già bloccato al punto 4), `chat_vigilanza_accessi` (registro di accountability, solo uuid),
`enrollment_submissions` (non collegata per id; vive in Iscrizioni).

### 4.4 Il registro della primaria: una regola, tre porte
L'elenco delle tabelle che fanno «registro della primaria» — `valutazioni`, `pagelle`,
`scrutinio_giudizi`, `scrutinio_comportamento`, `note_disciplinari`, `certificati_competenze` — vive
in **una** costante TS, `TABELLE_REGISTRO_PRIMARIA` in `src/lib/alunni/registro-primaria.ts`, con
`leggiRegistroPrimaria(supabase, alunnoId) → { ok: true, presente } | { ok: false, errore }` (e `alunniConRegistroPrimaria` per un elenco)
(una lettura fallita non è mai «assente»). La usano:

1. la nuova route `admin/students/elimina` (§4.2);
2. **l'oblio GDPR** `admin/gdpr/erase`: subito dopo il controllo di stato, in `dryrun` **e** in
   `execute`, registro presente → `409 REGISTRO_PRIMARIA` con `logEvento('gdpr','warn',
   { esito: 'oblio-rifiutato-registro-primaria' })`; lettura fallita → `500` (mai procedere);
3. **l'elenco dei candidati all'oblio** `admin/gdpr/candidates`: ogni candidato porta
   `registro_primaria: boolean`, e `OblioPanel` mostra la riga con il motivo e il comando spento —
   il bambino **non sparisce** dall'elenco in silenzio.

La funzione SQL (§4.3, punto 3) ripete lo stesso elenco: un test legge la migrazione dal disco e
pretende che le tabelle controllate in SQL siano **esattamente** quelle della costante TS.

Vincoli di forma (lock): niente `DELETE FROM storage.objects`; nessun uuid di sede; nel corpo e nei
commenti evitare le parole che accendono le guardie di freschezza (`unique`, `primary key`, `policy`,
`references utenti`, `drop table`, `add/drop constraint`) — la migrazione è di sole funzioni e non
deve richiedere una PR-B.

## 5. Gestione degli errori e osservabilità
- `withRoute('admin/students/elimina:POST', …)`; `logErrore` su ogni ramo di guasto; `logEvento`
  `warn` su ogni rifiuto (con `tipo` = codice); `logEvento` `info` sul **successo**, con soli numeri.
- RPC assente (`PGRST202`, DB E2E non migrato) → `503 ELIMINAZIONE_NON_DISPONIBILE`, livello `error`.
- File rimossi ma DB rifiutato (corsa: nel frattempo è arrivato un pagamento) → risposta con il codice
  della RPC e un log `warn` che dice «file già rimossi, scheda intatta»: è un esito onesto, la scheda
  resta eliminabile al prossimo tentativo.
- Client: `logClient` su ogni fetch fallita, nessun dato personale.

## 6. Test
- **SQL su Postgres vero** (PGlite, migrazione riletta dal disco, come `servizi-mensili-sql.test.ts`):
  rifiuta un frequentante; rifiuta con pagamenti senza flag; rifiuta pagamenti con incasso/ricevuta;
  rifiuta registro primaria; elimina il caso A (legami via, `parents` intatto); elimina il caso B
  (presenza in `CASCADE`); tutto-o-niente (un errore a metà non lascia righe cancellate).
- **Route**: gate ruolo (segreteria ammessa, educator 403), scope di sede, `dryrun` senza scritture,
  stop sui file restanti **prima** della RPC, audit scritto **solo dopo** il successo, anonimizza →
  `anonimizzaAlunno`, codici d'errore.
- **Elenco**: `elenco=frequentanti` / `non_iscritti` applicano i filtri; senza parametro nulla cambia.
- **Oblio GDPR**: `erase` rifiuta `409 REGISTRO_PRIMARIA` in `dryrun` ed `execute` senza alcuna
  scrittura; lettura del registro fallita → `500`; `candidates` porta il flag; `OblioPanel` spegne il
  comando con il motivo. La costante TS e l'elenco in SQL coincidono (lock).
- **UI**: le due tabelle; «Assegna sezione» chiama la PATCH e rilegge; la finestra mostra le scelte
  giuste per ciascun caso e il motivo del bottone spento; la pagina Alunni non mostra ritirati né
  senza sezione.
- Lock aggiornati in modo dichiarato: conteggi di `isolamento-sede-coverage`, nuovi codici in
  `errori-con-codice`, testo di `registro-modifiche-senza-hard-delete` (la causa del 2026-08-12 è
  rimossa: audit dopo, transazione unica, niente copia della riga).

## 7. Fuori perimetro
- Eliminare schede **genitore** rimaste senza figli.
- Aprire «Libera spazio» alla segreteria.
- La sanatoria dei due casi: la fa la segreteria dalla nuova linguetta dopo il rilascio (prima prova
  sul campo).

## 8. Definizione di fatto
Gate verdi (`eslint --max-warnings 0`, `tsc --noEmit`, `vitest run`, `build`, E2E in CI), PRD
aggiornato con voce di changelog datata, log presenti su ogni ramo nuovo, migrazione applicata
dall'integrazione al merge e verificata con `has_function_privilege`, fotografia delle migrazioni
rigenerata.
