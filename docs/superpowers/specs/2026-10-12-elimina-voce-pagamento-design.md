# Eliminare una voce di pagamento generata per errore — design

**Data:** 2026-10-12 · **Richiesta del titolare:** «Dare la possibilità di eliminare pagamenti generati per errore».

## Il problema

La segreteria non ha modo di togliere una voce sbagliata (un doppione, il bambino sbagliato, una
ricarica di ticket fatta due volte). Il server lo sa fare da tempo — `DELETE /api/pagamenti/[id]`,
con le guardie della fase 7 della robustezza — ma **nessun pulsante dell'interfaccia la chiama**,
tranne «Rateizza», che la usa per togliere la voce originale. In produzione, al 12/10, l'unica
eliminazione registrata in `registro_modifiche` risale all'11/07, e ~449 voci sarebbero oggi
eliminabili (non pagate, senza incassi, senza fattura, non rate). Una voce sbagliata resta quindi
«scaduta» davanti al genitore, nei solleciti e nei KPI.

## Decisioni del titolare (12/10)

| Domanda | Scelta |
|---|---|
| Che errore si corregge | **Voci singole**, una alla volta. L'annullamento di un lotto intero è fuori. |
| Voce con incassi (anche stornati) | **Non si elimina.** La regola della fase 7 resta intatta. |
| Chi | **Admin e segreteria.** La coordinatrice no. |
| Dove | **Dentro la finestra «Modifica».** |
| Voce di una ricarica di ticket mensa | **Si elimina e toglie i ticket di quella ricarica**, in un'operazione sola; si rifiuta se i ticket sono già stati usati. |

## Cosa porta via, e cosa trattiene, l'eliminazione di una voce

Misurato sul catalogo di produzione il 12/10 (FK verso `pagamenti`):

| Tabella | ON DELETE | Effetto |
|---|---|---|
| `incassi`, `fatture_emesse` | RESTRICT | trattengono: la voce non si elimina |
| `pagamenti` (rate), `pagamenti_quote`, `solleciti`, `fatture_coda` | CASCADE | se ne vanno con la voce |
| `ricevute_emesse`, `riconciliazione_movimenti` | SET NULL | restano, scollegate (una ricevuta implica un incasso; un movimento *confermato* pure: le guardie fermano prima) |
| `mensa_ticket_movimenti` | SET NULL | 🔴 **la ricarica resta accreditata** senza debito: 42 voci eliminabili sono ricariche |
| `divise_ordini` | SET NULL | 🔴 **l'ordine resta senza addebito**: 1 voce eliminabile |

Le ultime due righe sono il motivo delle regole 2.2 e 2.3.

## Parte 1 — Interfaccia (`ModificaPagamentoModal`)

Sotto i pulsanti Chiudi / Salva compare una zona separata, bordata di rosso, **«Elimina voce»**.

**Chi la vede.** Solo se il ruolo del cockpit (`useRuoloCockpit()`) è `admin` o `segreteria`. Per
ogni altro ruolo la zona non esiste e la sua lettura non parte.

**Chi decide se è eliminabile: il server.** All'apertura la zona chiama
`GET /api/pagamenti/[id]/eliminabile` (2.4), che applica **le stesse regole** dell'eliminazione.
Il browser non ricalcola niente: nessuna regola scritta due volte.

- In attesa della risposta: la zona mostra solo il titolo.
- `eliminabile: true` → pulsante **«Elimina voce»**.
- `eliminabile: false` → al posto del pulsante una riga grigia con il motivo e la via d'uscita,
  dal `codice` della risposta:

| Codice | Testo |
|---|---|
| `VOCE_RATA` | È una rata di un piano: si elimina il piano intero dalla voce principale. |
| `VOCE_FATTURATA` | Ha una fattura emessa: non si elimina per conservazione fiscale. |
| `VOCE_IN_CODA_FATTURE` | Ha una fattura in coda di emissione: toglila dalla coda prima. |
| `VOCE_CON_INCASSI` | Ha incassi registrati (anche stornati): storna gli incassi e correggi la voce invece di eliminarla. |
| `VOCE_IN_TRANSAZIONE` | Ha incassi di una transazione di famiglia: annulla prima la transazione. |
| `ORDINE_DIVISE_ATTIVO` | È l'addebito di un ordine divise ancora attivo: annulla prima l'ordine. |
| `TICKET_GIA_USATI` | I ticket di questa ricarica sono già stati usati: non si può eliminare. |
| lettura fallita / codice ignoto | Non riesco a controllare la voce: riapri la finestra. |

Mai «eliminabile» per un controllo che non ha potuto guardare.

**Conferma in due passi, nella stessa finestra** (niente finestra sopra la finestra). Il primo clic
trasforma la zona in: «Eliminare "<descrizione>", <importo>? Non si può annullare.», più, dai campi
della risposta:
- `rate > 0` → «Si eliminano anche le sue <n> rate.»
- `ticket > 0` → «Si tolgono anche i <n> ticket mensa di questa ricarica.»

con **[Annulla]** e **[Sì, elimina]**. Mentre la richiesta è in volo i due pulsanti sono
disabilitati.

**Esito.**
- `200` → la finestra si chiude e l'elenco si ricarica (`onDone()`, come dopo un salvataggio).
- Errore → il messaggio del server (`messaggioDaCorpo`) compare nella zona con `role="alert"` e la
  zona torna al primo passo.
- Errore di rete → «Connessione non riuscita: la voce non è stata eliminata.»

Il genitore non riceve notifiche: la voce sparisce dalla sua pagina pagamenti.

## Parte 2 — Server

### 2.1 Le regole, scritte una volta: `src/lib/pagamenti/voce-eliminabile.ts`

Le guardie oggi scritte dentro `DELETE /api/pagamenti/[id]` traslocano in una funzione condivisa —
stesso comportamento, stessi messaggi, stessi log: è un trasloco, non una riscrittura.

```ts
type EsitoEliminabile =
  | { ok: true; famiglia: string[]; voce: VoceLetta; rate: number; ticket: number }
  | { ok: false; stato: 404 | 409 | 500; codice: string; error: string }

controllaVoceEliminabile(supabase, id, { scuoleAttive, perSostituzione }): Promise<EsitoEliminabile>
```

Controlli, in quest'ordine (il primo che rifiuta decide):

1. voce inesistente o fuori dalle sedi attive → 404;
2. `tipo = rata` → 409 `VOCE_RATA`;
3. fattura emessa sulla voce o sulle figlie → 409 `VOCE_FATTURATA` (il testo di oggi);
4. incassi sulla voce o sulle figlie → 409 `VOCE_IN_TRANSAZIONE` o `VOCE_CON_INCASSI` (come oggi);
5. fattura in coda (`STATI_CODA_OCCUPATA`) → 409 `VOCE_IN_CODA_FATTURE`;
6. *solo se non `perSostituzione`*: ordine divise collegato con `stato ≠ annullato` → 409
   `ORDINE_DIVISE_ATTIVO`;
7. *solo se non `perSostituzione`*: ricariche ticket collegate (`mensa_ticket_movimenti`,
   `tipo = ricarica`, somma dei `delta` = `ticket`) con `ticket_mensa.saldo_ticket < ticket` → 409
   `TICKET_GIA_USATI`.

Ogni lettura che fallisce per un guasto → 500 (`rispostaGuastoDb`), **mai** via libera; salta
solo dove lo schema manca davvero sul DB E2E non migrato (codici di tabella/colonna assente), come
oggi.

### 2.2 `DELETE /api/pagamenti/[id]`: solo admin e segreteria

- `requireStaff(request)` → `requireStaff(request, ['admin', 'segreteria'])`. La coordinatrice
  riceve 403 anche chiamando la route a mano.
- `controllaVoceEliminabile(…, { perSostituzione: false })`.
- **Senza ricarica ticket** (`ticket = 0`): `.delete()` come oggi, con la gestione del freno
  RESTRICT (`figlieTrattengono` → 409 `VOCE_CON_CONTABILITA`).
- **Con ricarica ticket** (`ticket > 0`): RPC `elimina_voce_ricarica_ticket` (2.3). Se la RPC non
  esiste (DB non migrato: `PGRST202`/`42883`) → 503 `ELIMINAZIONE_RICARICA_NON_DISPONIBILE` e la
  voce **resta**: mai una voce eliminata coi ticket ancora accreditati.
- Dopo il 200:
  - `verificaRevocaSospensioneMorosita(supabase, [alunno_id])`, come fa già la PATCH quando cambiano
    importo o scadenza; un fallimento → `logEvento('pagamento','error', { esito:
    'revoca_non_verificata' })`, risposta sempre 200;
  - audit `registro_modifiche` `elimina_pagamento` con `vecchio_valore` (com'è oggi), più
    `nuovo_valore: { ticket_tolti }` quando c'è stata una ricarica;
  - `logEvento('pagamento','info', { operazione: 'pagamenti/[id]:DELETE', esito: 'voce-eliminata',
    pagamento_id, tipo, rate, ticket_tolti })` — oggi un'eliminazione riuscita non lascia log.
    Mai descrizione, nomi o importi.

### 2.3 Migrazione: `elimina_voce_ricarica_ticket(p_pagamento_id uuid, p_operatore uuid) → jsonb`

Una sola transazione, modellata su `ricarica_ticket_mensa` e sullo storno di `annulla_transazione`:

1. `pg_advisory_xact_lock` sulla **stessa chiave** di `ricarica_ticket_mensa`
   (`'ricarica_ticket_mensa:' || alunno_id`): una ricarica e un'eliminazione dello stesso bambino
   non si incrociano;
2. legge la voce (`FOR UPDATE`); assente → `{ esito: 'non_trovata' }`;
3. `ticket` = somma dei `delta` dei movimenti `ricarica` con quel `pagamento_id`; zero →
   `{ esito: 'senza_ricarica' }` (la route non avrebbe dovuto chiamarla: 409);
4. `saldo_ticket` del bambino (`FOR UPDATE`) `< ticket` → `{ esito: 'ticket_gia_usati', ticket,
   saldo }`, niente scritto;
5. `varia_saldo_ticket(alunno, -ticket)`;
6. movimento `rettifica`, `delta = -ticket`, `saldo_dopo`, `origine = 'segreteria'`,
   `creato_da = p_operatore`, nota «Storno ricarica (voce eliminata)», `pagamento_id` NULL (la
   voce sta per sparire);
7. `DELETE FROM pagamenti WHERE id = p_pagamento_id` — un incasso arrivato nel frattempo fa
   scattare la FK RESTRICT e **tutta** la transazione torna indietro (la route lo traduce in 409
   `VOCE_CON_CONTABILITA`);
8. `{ esito: 'eliminata', ticket_tolti, saldo_dopo }`.

`SECURITY DEFINER`, `search_path = public`, `REVOKE ALL` + `GRANT EXECUTE … TO service_role`, come
`ricarica_ticket_mensa`. Nome del file con la data di `date -u` (mai un orario tondo, mai nel
futuro). La migrazione **la applica l'integrazione al merge**: non si applica a mano prima.

### 2.4 `GET /api/pagamenti/[id]/eliminabile` (nuova)

`withRoute('pagamenti/[id]/eliminabile:GET')`, `requireStaff(request, ['admin','segreteria'])`,
`parseData(zUuid)`. Chiama `controllaVoceEliminabile(…, { perSostituzione: false })`. Il verdetto,
positivo o negativo, è una risposta **200**; il 404 e il 500 della funzione restano tali:

- eliminabile → 200 `{ eliminabile: true, rate, ticket }`;
- un 409 della funzione → 200 `{ eliminabile: false, codice, error }`;
- 404 / 500 → stessa risposta della funzione (la zona mostra «non riesco a controllare»).

Sola lettura: non scrive e non logga il successo (non è un evento critico); i guasti li logga
`rispostaGuastoDb`.

### 2.5 Rateizza: la sostituzione diventa un'operazione del server

Oggi `RateizzaModal` fa due chiamate dal browser: `POST /api/pagamenti/rate`, poi
`DELETE /api/pagamenti/<originale>`. Se la seconda fallisce, la famiglia ha **voce e piano
insieme** (debito doppio) e resta solo un `logClient`. Con 2.2 succederebbe sempre alla
coordinatrice.

`POST /api/pagamenti/rate` accetta un campo nuovo, `sostituisce_pagamento_id: zUuid.optional()`.
Quando c'è:

1. `controllaVoceEliminabile(…, { perSostituzione: true })` sulla voce originale, più: stesso
   `alunno_id` del piano e `tipo = singolo` — altrimenti 409 `VOCE_NON_SOSTITUIBILE`. Ogni rifiuto
   arriva **prima** di creare il piano. Con `perSostituzione` ricariche ticket e ordini divise non
   bloccano e **i ticket non si tolgono**: il debito continua nel piano;
2. crea padre e rate (codice di oggi);
3. elimina la voce originale con `.delete()`;
4. se il passo 3 fallisce, **elimina il padre appena creato** (le rate vanno in CASCADE) e risponde
   409 `VOCE_CON_CONTABILITA` (freno RESTRICT) o 500. Se fallisce anche la compensazione:
   `logEvento('pagamento','error', { esito: 'compensazione-piano-fallita', padre_id, originale_id })`
   e 500 — l'unico caso che lascia il doppione, e grida;
5. successo: audit `registro_modifiche` `elimina_pagamento` dell'originale con
   `nuovo_valore: { sostituito_da: padre_id }`, e `logEvento('pagamento','info',
   { esito: 'voce-sostituita-da-piano', originale_id, padre_id })`.

La route resta aperta a tutto lo staff (`requireStaff(request)`): la coordinatrice continua a
rateizzare. Effetto visibile: una voce **già pagata in parte** non si rateizza più — oggi lo
faceva e lasciava il doppione. In produzione c'è un solo piano rateale.

`RateizzaModal` manda `sostituisce_pagamento_id` e smette di chiamare la DELETE.

### 2.6 Codici d'errore e testi

Nuovi codici in `CODICI_ERRORE` (`src/lib/ui/esito-fetch.ts`) con le chiavi it/en, aggiunte **in
coda** ai cataloghi: `VOCE_FATTURATA`, `VOCE_RATA`, `VOCE_NON_SOSTITUIBILE`,
`ORDINE_DIVISE_ATTIVO`, `TICKET_GIA_USATI`, `ELIMINAZIONE_RICARICA_NON_DISPONIBILE`. Quelli già
esistenti (`VOCE_CON_INCASSI`, `VOCE_IN_TRANSAZIONE`, `VOCE_IN_CODA_FATTURE`,
`VOCE_CON_CONTABILITA`) restano com'è.

## Parte 3 — Collaudo, PRD, branch

**Test (TDD: rossi prima, verdi dopo).**

- `controllaVoceEliminabile`: i sette controlli nell'ordine; guasto di lettura → 500, mai via
  libera; schema assente → salta come oggi; `perSostituzione` ignora ticket e divise.
- `DELETE /api/pagamenti/[id]`: coordinatrice 403; admin e segreteria 200; i 409 di oggi invariati;
  voce con ricarica → chiama la RPC e non `.delete()`; RPC `ticket_gia_usati` → 409; RPC assente
  → 503 e niente eliminazione; dopo il 200 revoca della sospensione, audit e log `voce-eliminata`.
- `GET /api/pagamenti/[id]/eliminabile`: coordinatrice 403; verdetto vero/falso coi codici; guasto
  → 500.
- `POST /api/pagamenti/rate` con `sostituisce_pagamento_id`: successo (piano creato, originale
  eliminato, audit); originale con incassi / altro alunno / `tipo ≠ singolo` → rifiuto **senza
  insert**; DELETE dell'originale fallita → padre eliminato e risposta d'errore; senza il campo →
  comportamento di oggi.
- Migrazione, su un Postgres vero: `__tests__/lib/elimina-voce-ricarica-ticket-sql.test.ts` con
  PGlite e `__tests__/helpers/schema-soldi-pglite`, come `ricarica-ticket-mensa-sql.test.ts`.
  Casi: eliminata (saldo sceso di `ticket`, una `rettifica`, voce assente); `ticket_gia_usati`
  (niente scritto); `non_trovata`; `senza_ricarica`; incasso presente → la FK fa tornare indietro
  **tutto** (saldo e movimenti invariati). Più un lock in `__tests__/architecture/`, sul modello di
  `ticket-ricarica-una-transazione`: l'advisory lock del bambino viene preso **prima** di leggere il
  saldo, e la DELETE della voce sta nella stessa funzione dello storno dei ticket. Dopo il merge:
  SELECT di verifica in produzione (la funzione esiste, i permessi sono solo `service_role`).
- `ModificaPagamentoModal`: zona assente (e nessuna lettura) per la coordinatrice; i motivi dai
  codici; lettura fallita → «non riesco a controllare»; conferma in due passi con le frasi su rate
  e ticket; 200 → `onDone`; 409 → messaggio con `role="alert"`.
- `RateizzaModal`: manda `sostituisce_pagamento_id` e **non** chiama più la DELETE (il test
  `RateizzaModal-metodi` va aggiornato).
- Lock: `logging-coverage`, `zod-coverage`, cataloghi it/en, fotografie dello schema se la
  migrazione le tocca.

**Gate.** `npx eslint . --max-warnings 0` · `npx tsc --noEmit` · `npx vitest run` ·
`npm run build`; E2E in CI.

**PRD.** Voce di changelog datata 2026-10-12 in `PRD REGISTRO ELETTRONICO.md` e riga di stato
della contabilità aggiornata.

**Branch.** Nuovo branch `feat/elimina-voce-pagamento` da `main`, **dopo** che il deploy della
PR #226 è verde («CI» e «Verifica dopo il deploy» su `main`) e il branch della mensa è cancellato
(AGENTS.md, punto 3).

## Fuori da questo lavoro

- Annullare un lotto intero di generazione.
- Stato «annullata» per le voci con incassi stornati a zero (9 in produzione al 12/10).
- Motivo obbligatorio dell'eliminazione.
- Ricollegare al piano rateale il movimento ticket o l'ordine divise della voce sostituita (oggi
  restano scollegati, come già succede).
