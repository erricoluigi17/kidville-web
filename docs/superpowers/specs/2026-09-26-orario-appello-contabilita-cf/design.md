# Piano — Orario attività 0-6 · Appello/ritardi · Contabilità multi-sede + filtro classe · CF omocodici

## Contesto
Quattro richieste del titolare (26/09/2026). **Ogni decisione qui sotto è stata confermata
dall'utente in chat**: niente è dedotto. Si lavora su **un solo branch nuovo** da `main`
(`feat/orario-attivita-appello-contabilita-cf`) e si apre **una sola PR**. Fanno parte del lavoro:
PRD aggiornato, log su ogni percorso toccato (`withRoute`, `logEvento`/`logErrore`, successo
incluso), gate completo, merge, deploy e pulizia dei branch.

---

## 1. Orario delle attività nel diario (nido + infanzia)

**Oggi**
- Nel diario una registrazione di tipo `attivita` contiene un elenco di attività, ciascuna con
  `{tipo, descrizione, partecipazione}` (`dettagli.activities[]`). Nessuna ha un orario.
- L'orario della riga è l'ora del **salvataggio** (`DiaryEventEditor.tsx:651`), ed è l'ora che il
  genitore vede a lato (`parent/diary/page.tsx:243`).

**Decisioni**
- Ogni attività ha un orario **proprio**, con inizio e fine **entrambi facoltativi**.
- Lo scrivono docenti e segreteria. `admin/diary` usa lo stesso `DiaryEventEditor`, quindi la
  segreteria lo ottiene senza lavoro in più.
- Il genitore legge, per ogni attività, «dalle 10:00 alle 11:00». A lato della voce vede l'ora di
  inizio della prima attività, se inserita; altrimenti l'ora del salvataggio, come oggi.

**Implementazione** (nessuna migrazione: nuovi campi dentro il jsonb)
- `ora_inizio`/`ora_fine` (`HH:MM`, opzionali) in ogni voce di `dettagli.activities[]`.
- `src/lib/diary/attivita.ts`: helper puri `orarioAttivita(voce)` e `oraDiLatoAttivita(entry)`.
- `ActivityDetailInline.tsx`: due `<input type="time">` per attività. `DiaryEventEditor.tsx`: i
  campi entrano nel salvataggio e nel ripristino.
- `src/app/api/diary/entries/route.ts`: nello zod `HH:MM` opzionale; se ci sono entrambe, fine ≥
  inizio, altrimenti 422 con `logEvento`.
- `parent/diary/page.tsx`: riga dell'attività con l'orario e ora a lato come da decisione.
  i18n in `messages/*/diario.json`.

---

## 2. Appello e ritardi

**2a. Il genitore non vede l'orario dei «presenti»**
- Nido e infanzia continuano a **salvare** l'ora del tocco, che resta visibile a docenti e segreteria.
- Il genitore vede l'orario d'ingresso **solo se lo stato è `ritardo`**. Punti da toccare:
  - `PresenzeTodayCard.tsx:140-142`;
  - `parent/diary/page.tsx:615-634`, insieme a `api/diary/checkin/route.ts`, che deve restituire
    anche lo stato del giorno.

**2b. Primaria: finestra dell'orario su ritardo e uscita anticipata**
- In `teacher/primaria/[sectionId]/appello/page.tsx`, toccando «ritardo» o «uscita anticipata» si
  apre una finestra con:
  - l'ora attuale precompilata e modificabile;
  - la spunta «giustificato (non conta nelle ore)»;
  - la nota, obbligatoria se la spunta è attiva.
- «Salva» invia la POST esistente. La segreteria usa la stessa pagina (la pagina admin è un
  re-export).
- Nido e infanzia restano come sono.

**2c. Primaria: ore giustificate (es. terapia)**
- **Migrazione**: `presenze.assenza_oraria_giustificata boolean NOT NULL DEFAULT false`, con CHECK:
  vale true solo se lo stato è `ritardo` o `uscita_anticipata` e `note_appello` non è vuota. La nota
  va in `note_appello`, colonna già esistente.
- `api/primaria/appello/route.ts` POST: accetta `assenzaOrariaGiustificata` e `noteAppello` (zod
  con nota obbligatoria se il flag è vero). Aggiungere `logEvento`.
- `src/lib/primaria/oreAssenza.ts`: `calcolaOreAssenza` e `calcolaOreAssenzaPerMateria` escludono le
  righe con il flag. Lo stato e gli orari non cambiano, quindi l'alunno **risulta comunque non
  presente in classe**.
- Consumatori da aggiornare (aggiungono la colonna alla select): `api/primaria/ore-assenza`,
  `api/parent/presenze`.
- Il genitore vede la nota, es. «Ritardo giustificato: terapia», in `parent/primaria/assenze/page.tsx`
  e nella card della home.
- La giustifica firmata dal genitore **resta com'è** e non toglie ore.

---

## 3. Contabilità: più sedi insieme e filtro per classe

**Pagina** (`admin/pagamenti/page.tsx:85-123`)
- `SedeRequired` resta **solo** su **Genera** e **Causali**, che chiedono di scegliere una sede.
- Le altre 7 viste ricevono `scuolaId: string | null` e le sedi effettive da `useSediAttive`.
- Nelle GET si **omette** `scuola_id` quando le sedi sono più di una: mai scrivere
  `"undefined"`/`"null"` nell'URL o nel FormData.
- Aggiornare `e2e/admin-scelta-sede.spec.ts`.

**Regole comuni**
- Colonna o badge **Sede** in ogni elenco quando le sedi selezionate sono più di una.
- Le azioni su una riga ricavano la sede dal server, come già fanno tutte (`assertPagamentoInScope`,
  `assertAlunnoInScope`).
- Le azioni «di sede» senza una riga chiedono la sede in modo esplicito.

**3a. Scadenzario** (con Rette e categorie), `PaymentsDashboard.tsx`
- **KPI**: totale complessivo più ripartizione per sede.
- **Categorie**: `GET /api/admin/settings/categorie` senza `scuola_id` diventa multi-sede (categorie
  globali + `IN` sedi attive) invece di rispondere 400.
- **Badge Aruba**: la configurazione si chiede per ogni sede e si mostra quali sedi non sono
  configurate. Oggi il 400 lo nasconde senza dirlo.
- **Genera rette / Acquisto rapido** con più sedi: chiedono di scegliere la sede.
- **Filtro classe**:
  - selezione **multipla**; le classi omonime restano **separate per sede** («Sezione A —
    Giugliano»);
  - vale in Scadenzario, Rette, categorie ed **export**;
  - nuovo componente `FiltroClassiContabilita`, costruito sul pattern `BarraFiltri`/`multi`, e
    parametro `section_ids` in `api/pagamenti/export`;
  - i dati vengono da `alunni.section_id`.
- **Difetto oggi presente, da correggere**: `GET /api/pagamenti` è troncata a 1000 righe senza
  avviso (`max_rows`). Va paginata sul server con `range` a blocchi fino all'esaurimento, e si
  registra un log se i blocchi sono più di uno.

**3b. Transazioni**
- Se una famiglia paga voci di sedi diverse, la transazione **si divide automaticamente in una per
  sede**, con una ricevuta per sede.
- **Migrazione**: nuova RPC `registra_transazioni_per_sede(jsonb)`. Chiama la RPC esistente una
  volta per sede **dentro un'unica transazione DB**, quindi o vanno tutte o nessuna.
- L'**eccedenza** (credito famiglia) con più sedi va nella sede scelta dall'operatore con un menu.
- Da correggere: oggi le `ricariche_mensa` finiscono nella sede della transazione. Devono andare
  nella sede dell'**alunno**.
- Da aggiungere:
  - il campo `scuola_id` dei figli in `famiglia/route.ts:116`;
  - le colonne Sede e Pagante nel registro.

**3c. Cassa**
- **Lettura unita** delle sedi:
  - `movimenti` GET, `saldo`, `chiusura` GET e `report` passano a `resolveScuoleAttive` +
    `restringiSedi`;
  - saldo e «ultimo svuotamento» si mostrano **per sede** (ciascuna col suo fondo) più il totale;
  - colonna Sede nelle tabelle.
- **Scritture per sede**: uscita/entrata manuale, svuota cassa, categorie e impostazioni hanno un
  selettore di sede nella finestra. Se la sede è una sola, è già preselezionata.
- **Difetto da correggere**: «Uscite del mese» oggi somma le uscite di sempre. Va passato `da`/`a`
  del mese corrente.

**3d. Solleciti e Riconciliazione**
- Si omette `scuola_id` quando le sedi sono più di una.
- Sede visibile nelle righe (`scuola_nome`, `sedeDiRiga`) e nella ricerca manuale del dialogo
  (`PagamentoApertoUi` con la sede).
- **Import dell'estratto conto** (`riconciliazione/route.ts:1726`): `resolveScuolaScrittura` diventa
  `resolveScuoleAttive`, perché il registro è unico per le tre sedi e la sede non tocca nessun dato.
  L'audit si scrive con sede null; resta il ripiego per la CI.

**3e. Fiscale**
- Registro ricevute: `scuola_id` nella select e colonna Sede. La numerazione è già per sede.
- Sede anche nel menu degli alunni.
- **Revisione fatture**: **selettore di sede interno** al sotto-pannello.
- **Export AdE**: file unico con **colonna Sede**.

**3f. Ticket**
- I `ticket_pacchetti` si caricano con la sede dell'**alunno selezionato**.
- La route `morosi` restituisce `scuola_id`/`scuola_nome`, e la sede compare nelle liste.
- **Difetto da correggere**: `GET /api/pagamenti/ticket` deve controllare lo scope per lo staff
  (`assertAlunnoInScope`).

---

## 4. Codici fiscali omocodici

**Regola decisa**: un CF formalmente valido (carattere di controllo giusto) si accetta sempre. Di
conseguenza:
- omocodia coerente con l'anagrafica → nessun avviso;
- differenza di altro tipo → avviso, e «Usa questo»/«Applica» **restano**.

**Interventi**
- Modulo d'iscrizione pubblico: `CF_PATTERN` in `forms/enrollment-template.ts:13` e
  `forms/anagrafica-fields.ts:19` diventa quello con omocodia (`personale-template.ts:111`).
- **Migrazione dati**: il modulo d'iscrizione attivo in produzione (`form_models`
  `f0000000-0000-4000-8000-000000000001`) contiene il vecchio pattern **2 volte**, verificato con
  una SELECT il 26/09.
  - Si fa un `UPDATE … replace()` sul jsonb, **mostrato prima di applicarlo**.
  - La migrazione è idempotente: la condizione `WHERE` controlla che ci sia ancora il vecchio pattern.
- Scheda alunno e genitore (`BadgeCoerenzaCf`/`coerenza.ts`): test con omocodici reali di forma. Si
  corregge solo se oggi segnalano un falso «non coerente».
- Pannello «Codici fiscali da verificare» (`api/admin/anagrafiche/codici-fiscali/route.ts:332`): il
  confronto usa anche `validaCodiceFiscale(attuale).baseSenzaOmocodia`, così un omocodico coerente
  **non compare**.
- Test da aggiungere:
  - omocodico con il pattern d'iscrizione (buco in `forms-validate-fields.test.ts:173`);
  - pannello con un omocodico;
  - badge.

---

## Orchestrazione (come chiesto dall'utente)

Uso il Workflow con queste regole:
- **un esecutore Opus 5.5 per ogni compito piccolo**, con un **critico Opus 5.5 dedicato**;
- se il critico non dà «AAA», un **nuovo** esecutore riceve la correzione, fino a 8 giri;
- il lavoro finisce quando tutti i critici danno OK.

Ogni compito possiede file **disgiunti**. Chi deve aggiungere chiavi i18n lo fa con `Edit`
puntuali, prefisso di chiave dedicato e senza riordinare.

I critici lanciano sempre anche `__tests__/architecture` e `__tests__/a11y` (lezione dei lock
trasversali).

**Ondata 0 — contratti**, a cura dell'orchestratore:
- le 3 migrazioni con timestamp distinti: flag presenze, RPC transazioni, `form_models`;
- tipi condivisi: sede nelle righe, `section_ids`.

**Ondata 1 — compiti indipendenti**, eseguiti in parallelo:

| # | Compito | File posseduti |
|---|---|---|
| D1 | Helper attività + zod del diario | `lib/diary/attivita.ts`, `api/diary/entries` |
| D2 | Editor attività | `ActivityDetailInline`, `DiaryEventEditor` |
| D3 | Diario del genitore (orario attività) | `parent/diary/page.tsx` (parte attività) |
| A1 | Nascondere l'orario dei «presenti» al genitore | `PresenzeTodayCard`, `api/diary/checkin`, `parent/diary` (parte entrata) |
| A2 | Esclusione delle ore giustificate | `lib/primaria/oreAssenza.ts`, `api/primaria/ore-assenza`, `api/parent/presenze` |
| A3 | Flag e nota nella POST dell'appello primaria | `api/primaria/appello` |
| C1 | Pattern CF nel modulo pubblico + test | `forms/enrollment-template`, `forms/anagrafica-fields` |
| C2 | Omocodia nel pannello CF + badge | `codici-fiscali/route`, test |
| K1 | Paginazione di `GET /api/pagamenti` | `api/pagamenti/route.ts` |
| K2 | Categorie multi-sede + `section_ids` nell'export | `settings/categorie`, `pagamenti/export` |
| K3 | Route Cassa in lettura multi-sede + «Uscite del mese» | `api/pagamenti/cassa/*` (GET) |
| K4 | Route transazioni: divisione per sede + sede delle ricariche | `api/pagamenti/transazioni`, `famiglia` |
| K5 | Import riconciliazione + morosi ticket + scope della GET ticket | le tre route |
| K6 | Componente `FiltroClassiContabilita` | file nuovo |

**Ondata 2 — interfacce**, che dipendono dall'ondata 1:

| # | Compito |
|---|---|
| A4 | Finestra ritardo/uscita della primaria |
| A5 | Nota giustificata lato genitore |
| P1 | `page.tsx` + e2e scelta sede |
| P2 | `PaymentsDashboard`: KPI per sede, badge Aruba, sede nelle righe, filtro classe |
| P3 | `TransazioniPanel` |
| P4 | `CassaPanel` e finestre |
| P5 | Solleciti + Riconciliazione |
| P6 | Fiscale + Revisione |
| P7 | `TicketMensaPanel` |

**Ondata 3 — integrazione**, a cura dell'orchestratore:
- gate completo;
- PRD (`PRD REGISTRO ELETTRONICO.md`, changelog datato);
- commit e PR;
- CI verde con **tutti** i job;
- merge (la migrazione la applica l'integrazione), deploy, pulizia dei branch.

## Verifica
- `npx eslint . --max-warnings 0`
- `npx tsc --noEmit`
- `npx vitest run`: si contano i `Test Files N passed` e i lock `architecture`.
- `npm run build`
- E2E Playwright in CI, tutti i job.
- Dopo il deploy:
  - SELECT di controllo sulle colonne e sulla RPC nuove;
  - SELECT su `form_models` per verificare che il vecchio pattern sia sparito;
  - `/api/health` e `app_log` sui nuovi eventi.
