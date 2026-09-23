# D1 — Correzione urgente R1 (decisione 24) · v6, allineata al CONTRATTO UNICO v4

Legenda:
- **V** = verificato il 23/09, in sola lettura: codice e git (`HEAD` = `origin/main` = `29bb04c7`), `gh api`, SELECT aggregate in produzione alle **01:14Z** e di nuovo alle **02:32Z**.
- **D** = dedotto, oppure scelta di progetto.

Ciò che D1 condivide con D2-D6 non si ridefinisce qui: si rimanda al contratto v4 con «→ C§n». In caso di conflitto vale il contratto.

---

## Correzioni C0 (23/09/2026) — prevalgono sul resto del documento

Fonte: contratto, sezione «Registro C0» (C0.1 rilievi, C0.2 default del titolare, C0.3 predicato, C0.4 richieste). Per questo componente:
- **Predicato unico (C0 G1)**: `fattura-partita-non-registrata.ts` e il suo gemello SQL usano **esattamente** il testo di contratto C0.3 (ramo `fattura_aruba_id` non NULL: manca la riga con quel file; ramo NULL: nessuna riga non scartata). Sostituisce la forma «nessuna riga viva né col file del pagamento» di §8 e la richiesta 1. Motivo [V]: `emissione.ts:2604` scrive il file della **prima** quota riuscita; l'idempotenza guarda solo le righe vive (`:1458`).
- **Seconda passata (contratto C0.5 n. 7)**: il codice di §8.1 (TS e gemello SQL) è ora scritto nella forma CASE di C0.3, non vale più solo per prevalenza di questo blocco.
- **Test nuovi in §12**: «riga viva di un'altra quota e file del pagamento assente ⇒ vero»; resta «sola riga scartata con lo stesso file ⇒ falso». La parità TS/SQL si prova su PGlite in D1 su tutti i casi.
- **Richieste accolte nel contratto (C0.4)**: «autore sistema» = `creato_da NULL`; prove P0-P7 contro `rif`; S28 con cinque condizioni; uguaglianze nel lock specchio.
- **Rilascio (C0 m8)**: il passo 4 di `ship-cycle.md` non si esegue per PR-D1. **Modelli (C0.2 D5)**: i compiti di D1 che eseguono `supabase db query --linked` o scrivono in produzione girano su sonnet o opus, mai haiku.

## 0. Cosa cambia nella v6

### 0.1 I tre rilievi del critico

| # | Rilievo | Esito | Correzione di D1 | Dove |
|---|---|---|---|---|
| 1 | Il predicato di `PARTITA_NON_REGISTRATA` non è fissato; C§18 dice ancora «P0-P6»; «autore sistema» si può leggere in due modi | **Accolto** | D1 fa del predicato una **fonte unica**. `fattura-partita-non-registrata.ts` esporta anche `PREDICATO_SQL_PARTITA_NON_REGISTRATA` e `CODICI_SDI_SCARTO_REGISTRO`, ricavati da `mapStatoAruba` e mai scritti a mano. Un test su PGlite prova la parità fra TS e SQL, compreso il caso «sola scartata di un altro file». Gli script importano il modulo invece di copiarne il testo. Il resto spetta al contratto | §8.1, §9.1, §12 (test 4); richieste 1, 2 e 5 |
| 2 | Nel lock specchio manca l'uguaglianza `MOTIVO_PARTITA_NON_REGISTRATA === ESITO_VOCE.partita_non_registrata` | **Accolto** (il lock è di D2) | D1 non possiede il lock. La richiesta 4 non è più facoltativa, e chiede di confrontare anche `CODICI_SDI_SCARTO_REGISTRO` con `STATI_SDI_SCARTO` | richiesta 4 |
| 3 | S28 chiede solo «coda sospesa», e gli script di F23 restano senza guardia | **Accolto** | La guardia diventa un'API stabile, `guardiaArubaPerScript()` in `scripts/lib/aruba-lettura.mjs`, che ogni script di F23 può importare quando qualcuno lo tocca. La regola completa va in C§2 S28 come procedura scritta per tutti | §10.6; richiesta 3 |

### 0.2 Difetti della v5 che D1 ha trovato da sé (V)

**(a) La P7 confrontava con `HEAD`, quindi sul branch sarebbe risultata falsa.**
- La PR-D1 modifica due file dentro i percorsi della P7: `src/lib/aruba/emissione.ts` e `src/app/api/pagamenti/fattura/route.ts`.
- Lanciata dal branch, come chiede il §13 passo 3, la P7 avrebbe dato `diff ≠ 0`, uscita 2 e STOP.
- **Correzione.** Il riferimento non è `HEAD` ma `rif`, cioè il deploy di produzione attivo al momento dell'indagine (oggi `29bb04c7`), che deve essere antenato di `HEAD`. H2 si riproduce offline su `rif`.
- Misure (V):
  - `git log -1 29bb04c7 -- <percorsi>` → `9a30ff67 2026-09-16T15:42:11+02:00`;
  - controllo positivo `git diff --quiet 9a30ff67~1 29bb04c7` → 1;
  - `git diff --quiet 9a30ff67 29bb04c7` → 0;
  - `git merge-base --is-ancestor 29bb04c7 HEAD` → 0.

**(b) La finestra della sync era troppo corta.**
- La v5 bloccava i minuti 58-03 e 28-33. Ma la sync (V):
  - ha `maxDuration = 300` (`sync/route.ts:224`);
  - smette di prendere righe nuove solo a `TETTO_TEMPO_MS = 240_000` (`:111`);
  - chiude l'ultima iterazione con un tetto di 30 s per singola richiesta ad Aruba (`:103-108`);
  - parte con pg_cron `*/30` (V, `cron.job` alle 02:32Z).
- Quindi una sync partita alle :00 può chiamare Aruba fino a circa :04:30, e la piattaforma la taglia a :05.
- **Correzione:** si bloccano i minuti **58-59, 00-05, 28-35**, letti dall'orologio del DB, che è quello di pg_cron (§10.2).

**(c) L'orario di lavoro della segreteria era solo una raccomandazione.**
- Prima della PR-A non esistono né coda né cancello: nessuna guardia automatica copriva un'emissione in corso dalla segreteria.
- **Correzione:** nuova guardia fail-closed, «attività dell'app verso Aruba negli ultimi 10'», letta da `app_log` (§10.3).
- V, alle 02:32Z: gli esiti a livello info di `emettiFatturaPagamento:*` e `aruba:*` vengono persistiti. In 3 giorni: 22 `inviata` e 22 `aruba:*`, l'ultimo il 22/09.

**(d) Una citazione di riga imprecisa.** L'aggregato che scrive `scartata` sta a `emissione.ts:2553-2560`, non a 2555-2560 (V; come F34).

### 0.3 Richieste della v5 accolte nel contratto v4

- L'ex richiesta 2 è accolta come **S51** e **F34**:
  - `ritrasmissione` spetta solo a un pagamento con una riga di scarto SdI;
  - col giornale, `scartata` si scrive solo per uno scarto di merito.
- È tolta dalle richieste. D1 resta nel perimetro di S27 e non riscrive i 4 pagamenti storici: con S51 entrano come `prima_emissione`.

### 0.4 Punti del contratto v4 che D1 applica

- **S27, tre ritocchi:**
  - aggregato senza `scartata` sugli stop di numerazione (§5.3);
  - prova git e deploy nell'indagine (P7, §3);
  - `--allinea` legge anche `fatture_coda_invii` se esiste (§4).
- **S28:** guardia automatica e fail-closed, più stretta del contratto (§10). La regola completa va in S28 (richiesta 3).
- **C§15**, riga «`emettiFatturaPagamento:*` (D1)»: esiti e livelli identici.
- **C§18 R1:** sequenza PR-D1 → merge → orfane → PR-D1b; in PR-D1 si rigenera solo `fk-utenti`; contatori scritti solo con P6 falso; niente `/api/health`, niente `migrate-ci`.
- **C§19:** proprietà dei file (elenco in fondo). **C§0**, punti 2, 3 e 5: chi rompe ripara; nessun `apply_migration`, `db push` in scrittura o approvazione di `migrate.yml`; nessun nome file nei `campi`.
- **C§7.3, ultimo punto:** la riga registrata per un'orfana ha la stessa forma della riga che la coda scriverà (`sdi_stato=1`, «Presa in carico», `xml_inviato`, `aruba_filename`, `inviata_il`) (§9.2).
- **C§4:** la rigenerazione di `fk-utenti` in PR-D1 porta `generato_alle` oltre la `VERSION` di D1, e T1 della coda deve superarlo. D1 lo segnala a D2 (§15).

### 0.5 Cosa D1 NON fa

- nessun controllo in `/api/health`;
- nessuna modifica a `fatture_numerazione` (la vecchia), `protocolli`, `ricevute_emesse`;
- nessuna TD04;
- nessuna scrittura sulle tabelle della coda;
- nessun file di D2-D6;
- nessuna riscrittura dei 4 pagamenti `scartata` senza documento.

Fino al rilascio della coda la segreteria continua a emettere (decisione 24).

---

## 1. Consegne e PR

Due PR (→ C§18, C§20 passo 1):
- **PR-D1** `fix/fatture-vincolo-numero-per-sede`.
- **PR-D1b** `chore/fotografie-dopo-d1`: solo fotografie, mini-lock e PRD, dopo il merge e dopo le orfane.

| # | Consegna | File | In produzione |
|---|---|---|---|
| A | Indagine sul salto FPR 2154→2516 (P0-P7) | `scripts/numerazione-serie.mjs` (sola lettura) | dal branch, prima del merge |
| B | Contatori, **solo se P6 è falso** | stesso script, `--allinea` | prima del merge, solo se serve |
| C | Tetto 50 sul salto del pavimento, pavimento nei log, aggregato senza `scartata` sugli stop di numerazione | `src/lib/aruba/emissione.ts` | al deploy |
| D | Migrazione che toglie `UNIQUE (scuola_id, anno, numero)` | `supabase/migrations/<VERSION>_fatture_emesse_senza_vincolo_numero_per_sede.sql` | integrazione Supabase al merge (C F1) |
| E | Messaggio del 23505 distinto per vincolo | `emissione.ts` + `vincolo-registro.ts` | al deploy |
| F | 409 per il pagamento «partito ma non registrato», senza consumare numeri; predicato a fonte unica TS/SQL | `fattura-partita-non-registrata.ts` + `emissione.ts` + route | al deploy |
| G | Registrazione delle orfane: ogni scrittura si mostra, poi si applica | `scripts/fatture-orfane.mjs` | dopo il merge |

---

## 2. Fatti

### 2.1 Il vincolo (V)

- **Il vincolo per sede:** su `fatture_emesse` c'è un solo vincolo `u`, `fatture_emesse_scuola_id_anno_numero_key`, nato nella baseline (`20260704120000_baseline.sql:3168-3172`). Alle 02:32Z compare 1 volta.
- **Le due difese giuste esistono già** (`20260809235620`):
  - `fatture_emesse_sezionale_anno_numero_uidx (sezionale, anno, numero) WHERE sezionale IS NOT NULL` (:121-123);
  - `fatture_emesse_pagamento_quota_uidx`, con `WHERE sdi_stato IS NULL OR sdi_stato NOT IN (2, 4, 9)` (:167-169).
- **Righe senza serie:** con `sezionale IS NULL` le righe sono 0.
- **Dipendenze:** nessuna FK e nessun codice dipendono dal vincolo per sede.

### 2.2 Registro e orfane (V; alle 02:32Z tutto come alle 01:14Z)

- **Registro:** 425 righe in `fatture_emesse`; l'ultima è del 22/09 alle 12:02:19Z. Righe «Trasporto fallito»: 0 (→ C F2).
- **Orfane: 6**, con tutte e due le forme: il gemello del §8.1 e «zero righe».
- **`app_log`:** 6 righe `registro-doppione-rifiutato` a livello error, l'ultima il 22/09 alle 12:11:58Z. Nessuna riga `pavimento-*` né `partita-non-registrata-fermata`.
- **Contatori** di `fatture_numerazione_sezionale`:
  - Asilo 2026 a **2543** (22/09 12:02:13Z);
  - FPR 2026 a **2542** (22/09 12:11:52Z).
- **Massimi a registro:** Asilo 2543, FPR 2540. Le FPR 2541 e 2542 sono orfane.
- **Migrazioni:** l'ultima è `20260920124744`.
- **Tabelle della coda:** `to_regclass` di `fatture_coda_invii`, `fatture_coda_stato` e `aruba_cancello` è NULL per tutte e tre.
- **La CLI** entra come `postgres` con `rolbypassrls = true` (V, 22/09): legge anche le tabelle della coda con RLS FORCE e senza policy (→ C§7).

### 2.3 Numerazione (V, registro più orfane)

Serie FPR:
- …2153, **2154** (17/09 12:35);
- **2516** (18/09 07:45:16Z);
- 2517…2521;
- orfane 2524 e 2525;
- 2526…2540;
- orfane 2541 e 2542.

Serie Asilo:
- …**2515** (17/09 12:43);
- 2516…2518;
- **2523** (18/09 11:31Z);
- 2524 e 2525;
- orfane 2526 e 2527;
- 2528 e **2529**;
- **2541** (21/09 13:22Z);
- 2542 e 2543.

La RPC fa `GREATEST(contatore, p_min) + 1` (`20260809235620:263-269`).

| Salto | Contatore prima | Numero dato | Documento che deve esistere su Aruba |
|---|---|---|---|
| J0, controllo positivo (08/09) | FPR 1952 | 1956 | FPR 1955 (manuale, noto: `emissione.ts:391-393`) |
| J1 (18/09 07:45Z) | FPR 2154 | 2516 | **FPR 2515** |
| J2 (18/09 11:31Z) | Asilo 2518 | 2523 | Asilo 2522 |
| J3 (21/09 08:50Z) | FPR 2521 | 2524 | FPR 2523 |
| J4 (21/09 13:22Z) | Asilo 2529 | 2541 | Asilo 2540 |

Numeri assenti dal registro:
- FPR: 1953-1955, 2155-2515, 2522-2523;
- Asilo: 2519-2522, 2530-2540.

### 2.4 Documenti nati fuori dall'app (aritmetica V, lettura D)

`aruba:findByUsername` registra `ricevuti` e `totale_dichiarato` (`client.ts:1377-1391`).

| Finestra (UTC) | Crescita su Aruba | Dall'app | Fuori app |
|---|---|---|---|
| 10/09 05:30 → 17/09 10:31 | 248 | 244 | 4 |
| F1: 17/09 10:31 → 18/09 07:45 | 22 | 21 | **1** |
| F2: 18/09 09:18 → 13:18 | 8 | 2 | 6 |
| F3: 18/09 13:18 → 21/09 08:36 | 3 | 1 | 2 |
| F4: 21/09 09:19 → 13:06 | 20 | 16 | 4 |
| F5: 21/09 13:06 → 22/09 08:25 | 2 | 2 | 0 |
| F6: 22/09 08:25 → 10:52 | 2 | 2 | 0 |

- D: nella finestra di J1 compare un solo documento fuori app, candidato a essere «FPR 2515».
- D: le FPR 2155-2514 non possono esistere su Aruba.

### 2.5 RPC, cache, contatore (V)

- L'unico chiamante di `prossimo_numero_fattura_sezionale` è `emissione.ts:2175`. In produzione la funzione contiene `GREATEST(…) + 1` e `pg_advisory_xact_lock`.
- La cache è per serie (`:438-440`), e il parser rifiuta le altre serie (`client.ts:946-963`). Dopo l'allocazione la cache sale al numero dato (`:2206`).
- Il contatore si legge con `contatoreARegistro` subito prima della RPC (`:2176`).
- Oggi la guardia ferma solo gli scarti oltre `SCARTO_MASSIMO_PAVIMENTO = 10_000` (`:396`, ramo `:2144-2173`). Quel ramo scrive già `pavimento` e `contatore` numerici; `sezionale` c'è, ma non è in `CHIAVI_IN_CHIARO` (`redact.ts:250-256`) e viene redatto.
- Tre rami fermano per `motivo: 'numerazione'` (`:2134`, `:2165`, `:2198`) senza aver consumato numeri né chiamato l'upload.

### 2.6 Codice e deploy attivi a ogni salto (V)

- **Percorsi della numerazione** (array P):
  - `src/lib/aruba`;
  - `src/lib/fatturazione`;
  - `src/app/api/pagamenti/fattura`;
  - `src/lib/pagamenti/lotto-fatture.ts`;
  - `src/lib/pagamenti/fatturazione-riga.ts`;
  - `supabase/migrations/20260809235620_fatture_numerazione_sezionale.sql`.
- **Deploy di produzione** (`gh api …/deployments`):
  - `9a30ff67` il 16/09 alle 13:42:17Z;
  - `cf5de73b` il 18/09 alle 12:31:38Z;
  - `fb5cb389` il 18/09 alle 13:52Z;
  - fra il 19/09 e il 20/09: `c6ea0e4e`, `18513c4d`, `905bde8e`, `f971a966`, `69ee801a`, `c43d8cf1`, `1aa953f9`;
  - `29bb04c7` il 20/09 alle 20:56:22Z, che è il riferimento `rif` di oggi.
- **Prove su `rif`:**
  - `git log -1 rif -- P` → `9a30ff67`;
  - `git diff --quiet 9a30ff67 rif -- P` → 0;
  - `git diff --quiet 29bb04c7 rif -- P` → 0;
  - controllo positivo `9a30ff67~1 → rif` → 1;
  - `rif` è antenato di `HEAD`.

| Salto | Deploy attivo | File di P identici a `rif` |
|---|---|---|
| J1, J2 (18/09, prima delle 12:31Z) | `9a30ff67` | sì |
| J3, J4 (21/09) | `29bb04c7` = `rif` | sì |

D: il codice che ha prodotto i salti è quello oggi in produzione. Se la causa fosse nostra (H2), si riprodurrebbe offline su `rif`.

### 2.7 Pagamenti `scartata` senza documento (V; = C F34)

- 11 pagamenti `scartata`, tutti `pagato`:
  - 7 hanno una riga in `sdi_stato ∈ (2,4,9)`;
  - **4 non hanno righe** né `fattura_aruba_id`.
- Dei 4, 3 hanno in `app_log` l'esito `numerazione-non-allineabile-*` (`emissione.ts:2034-2041`, poi `motivo:'numerazione'` a :2134).
- La causa è l'aggregato di `:2553-2560`, che scrive `scartata` per qualunque motivo. D1 toglie la causa osservata (S27, §5.3); S51 copre il resto nella PR-A.

### 2.8 Migrazioni

Vale C F1 con la decisione 25. Il passo 4 di `.claude/commands/ship-cycle.md:348-352` («applicale con `apply_migration`») **non si esegue**.

### 2.9 Durata della sync e tracce dell'app (V, NUOVO)

- **pg_cron:** `fatture-sdi-sync` gira `*/30`.
- **La route della sync** (`sync/route.ts`):
  - `maxDuration = 300` (:224);
  - `TETTO_TEMPO_MS = 240_000` (:111);
  - margine di 60 s «per l'ultima iterazione», con un tetto di 30 s per richiesta ad Aruba (:103-108);
  - `TETTO_PER_GIRO = 30` (:97).
  - Gate: solo `x-cron-secret` (:260-261), nessuna chiamata manuale.
- **`app_log`** (`evento='fattura'`, 3 giorni fino alle 02:32Z): gli esiti info si persistono. `emettiFatturaPagamento` `inviata` ×22 (ultimo 22/09 12:02Z); `aruba:*` ×22 più `scorrimento-concluso` ×6. `contesto->'campi'->>'operazione'` porta il prefisso `aruba:` o `emettiFatturaPagamento:`.

---

## 3. (A) Indagine sulla causa del salto

### 3.1 Ipotesi

- **H1 (favorita):** documenti emessi fuori dall'app sulla stessa utenza, col pannello web e numeri scritti a mano. L'app li legge come pavimento.
- **H2:** difetto nostro: parser o cache che mescolano le serie, oppure un chiamante sconosciuto della RPC.
- **H3:** doppioni su Aruba.

### 3.2 Metodo

0. **P7 dallo script** (§3.3): git e gh con argomenti in array, confronto con `rif`, controllo positivo. L'uscita va in `<out>/prova-codice-deploy.txt` (solo sha, istanti e codici d'uscita).
1. **Prove dal DB** (Appendice A). `app_log` si conserva 30 giorni: lo script salva l'estrazione in `--out`, solo numeri.
2. **Prove da Aruba**, in sola lettura:
   - 1 signin e lo scorrimento `findByUsername` del 2026 (2 pagine);
   - con `--xml-fuori-app`, al massimo 20 `getByFilename` sui documenti fuori app di F1-F4, a 5 s l'una dall'altra;
   - nessun upload;
   - la guardia del §10 prima di **ogni** chiamata.
3. **Verifica** con P0-P7 (§3.4), **conclusioni** col §3.5.

### 3.3 `scripts/numerazione-serie.mjs` (funzioni pure in `scripts/lib/numerazione-serie.mjs`)

```
node scripts/numerazione-serie.mjs --out <cartella FUORI dal repo> [--anno 2026] [--xml-fuori-app]
node scripts/numerazione-serie.mjs --out <…> --allinea --serie <Asilo|FPR> --a <N>
```

**Parti comuni ad Aruba** in `scripts/lib/aruba-lettura.mjs` (§10.6):
- signin;
- scorrimento con controllo dell'involucro (`errorCode '0000'`, `size`, `totalElements`), come `client.ts:1141-1166, 1362-1371`;
- `getByFilename` e `openssl cms -verify -noverify`;
- 5000 ms fra due chiamate;
- stop al primo 429;
- rifiuto di un `--out` dentro il repo;
- `guardiaArubaPerScript()` prima di ogni chiamata.

Il modello è `scripts/aruba-campioni.mjs`.

**Altre regole:**
- DB con `supabase db query --linked --agent no -o json [-f file]`, dalla radice.
- Credenziali Aruba da ambiente o da `.env.local`, mai stampate. File in `--out` con permessi 0600.
- **Nessuna shell:** ogni processo figlio (`supabase`, `git`, `gh`, `openssl`) parte con `execFileSync(cmd, args[])`.
- **Parser delle etichette:** una copia in `scripts/lib/numerazione-serie.mjs`, perché `client.ts` si porta dietro logger e `next`. Un test di parità la confronta con `numeroSezionaleDaEtichetta`.

**P7 automatica** (salvo `--allinea`):
1. Deploy di produzione da `gh api repos/erricoluigi17/kidville-web/deployments`, con gli statuses `success` (istante).
2. `rif = deployAttivoAl(deploys, adesso)`. Guardie d'uso (uscita 1, «aggiorna il branch o fai fetch»):
   - `git cat-file -e <rif>^{commit}` deve riuscire;
   - `git merge-base --is-ancestor <rif> HEAD` deve dare 0.
3. `git log -1 --format=%h %cI <rif> -- …P` → `ultimoCommit`, **non vuoto**.
4. Per ogni salto: `git diff --quiet <deployAttivoAl(deploys, istante del salto)> <rif> -- …P` → atteso 0.
5. **Controllo positivo:** `git diff --quiet <ultimoCommit>~1 <rif> -- …P` → atteso **1**.
6. Funzioni pure:
   - `deployAttivoAl(deploys, istante)`: l'ultimo `success` non posteriore all'istante;
   - `argomentiGit(…)`: array di argomenti;
   - `verdettoP7({ salti, deploys, rif, antenato, diff, controlloPositivo, ultimoCommit })`.
7. `HEAD` non compare mai nel confronto: sul branch i percorsi li modifica la PR-D1 stessa (§0.2 a).

**Letture dal DB** (solo numeri, uuid, nomi file e istanti):
- Q1: contatori;
- Q2: registro `(sezionale, numero, sdi_stato, aruba_filename, creato_il)`;
- Q3: orfane con `PREDICATO_SQL_PARTITA_NON_REGISTRATA` (§8.1), `(id, fattura_aruba_id, fattura_emessa_il)`;
- Q4: `app_log` con `scorrimento-concluso`;
- Q5: `app_log` con `inviata` o `registro-*`;
- Q6 (S27): se `to_regclass('public.fatture_coda_invii')` non è nullo, `select sezionale, anno, numero, aruba_filename, creato_il from public.fatture_coda_invii where anno = <anno>`, in ogni stato.

**Dati tenuti da Aruba:**
- `filename`, `creationDate`, `lastUpdate`; `signed` e `unsignedFile` come booleani;
- per fattura: serie, numero, anno, `invoiceDate`, `status`;
- `sender` e `receiver` si scartano prima di salvare.

**Classificazione dei documenti:**
- `app`: il nome file è a registro o nel giornale;
- `orfana`: il nome file è il `fattura_aruba_id` di un'orfana;
- `fuori-app`: tutto il resto;
- delle etichette sconosciute si contano i casi e si stampa la sola forma.

**Uscite** (a terminale solo numeri; il dettaglio in `<out>/numerazione-<anno>-<istante>.json`, 0600):
1. per serie: documenti per origine, massimi (Aruba, registro, giornale), contatore, ultimo numero vero, pavimento − contatore;
2. buchi;
3. documenti fuori app;
4. attribuzione dei salti: per ogni allocazione `n > c+1` si cerca un documento fuori app `n−1` della stessa serie, creato prima. Esito «SPIEGATO da…» o «SALTO NON SPIEGATO»;
5. doppioni;
6. firma dell'altro emittente;
7. pavimento attuale;
8. P7 con `rif`.

**Codici d'uscita:**
- 0 = tutto spiegato e P7 vera;
- 1 = guardia d'uso: `--out`, credenziali, CLI, openssl, git o gh; `rif` non antenato; 429; guardie del §10;
- 2 = salto non spiegato, doppione, etichette illeggibili, oppure P7 falsa.

### 3.4 Criteri di prova

| Id | Criterio | Atteso (D) |
|---|---|---|
| P0 | **Controllo positivo:** J0 «SPIEGATO da FPR 1955»; senza, lo script è rotto | spiegato |
| P1 | J1 spiegato da «FPR 2515/2026» fuori app, creato in F1, unico fuori app di F1 | spiegato |
| P2 | FPR 2155-2514: nessun documento su Aruba | 0 |
| P3 | J2, J3, J4 spiegati da Asilo 2522, FPR 2523, Asilo 2540 fuori app, nelle finestre F2-F4 | spiegati |
| P4 | Documenti fuori app per finestra come al §2.4 (1, 6, 2, 4) | uguali |
| P5 | Nessun doppione | 0 |
| P6 | Ultimo numero vero = contatore (Asilo 2543, FPR 2542) | uguale |
| **P7** | Per J1-J4 il deploy attivo ha i file di P identici a `rif`; controllo positivo a 1; `git log -1 rif` non vuoto; `rif` antenato di `HEAD` | vero (V oggi, §2.6) |

### 3.5 Conclusioni e azioni

| Risultato | Causa | Azioni |
|---|---|---|
| P0-P7 veri | **H1** | Contatori senza scritture (P6 vero); codice del §5; prospetto (§3.6); PRD |
| P0 e P7 veri, qualche «NON SPIEGATO» | **H2** | STOP del §4. Compito nuovo in PR-D1: ricalcolo offline col parser e la chiave di cache di `rif` (`git show <rif>:…`), test rosso, correzione, poi di nuovo il §4 |
| P7 falsa, controllo positivo a 0, o `rif` non antenato | codice o deploy sconosciuti, oppure prova cieca | Stop: si ricostruisce quale codice girava |
| DOPPIONE | H3 | Serie, numero e date al titolare; serve la nota di variazione del commercialista. La coda non si accende finché il titolare non ha deciso |
| P2 falso | un altro emittente ha usato quei numeri | Si aggiorna il prospetto |
| P0 falso | lo script sbaglia | Si corregge lo script |

### 3.6 Prospetto per il commercialista

- Per serie: intervalli dell'app, numeri fuori app con la data, numeri mai usati con l'istante del salto.
- Solo numeri e date, in `<out>/prospetto-numerazione-2026.txt`; il PRD ne riporta un riassunto.
- Come giustificare i buchi lo decide il commercialista.

---

## 4. (B) Contatori (solo se l'indagine lo richiede)

### 4.1 «Ultimo numero vero»

È il massimo della serie fra:
- Aruba, di qualunque origine;
- il registro;
- `fatture_coda_invii`, se esiste, in ogni stato (anche un numero `bruciata` è consumato).

Non può tornare a 2155, e si attende P6 vero: nessuna scrittura (D).

### 4.2 `--allinea --serie S --a N`

1. Guardia del §10, poi rilettura completa (DB, Aruba, Q6).
2. `obiettivo = max(Aruba, registro, giornale se esiste)`.
3. Rifiuto se:
   - `N ≠ obiettivo`;
   - ci sono salti non spiegati o doppioni;
   - `obiettivo < contatore` con un documento, una riga a registro o una riga del giornale sopra `obiettivo`.
4. `contatore == obiettivo` → «nessuna scrittura», uscita 0.
5. Altrimenti:
   - conteggio con una SELECT;
   - «SCRIVO:» con l'istruzione intera (solo numeri);
   - applicazione;
   - rilettura.

### 4.3 L'istruzione, a confronto-e-scambio

```sql
WITH upd AS (
  UPDATE public.fatture_numerazione_sezionale
     SET ultimo_numero = <obiettivo>, aggiornato_il = now()
   WHERE sezionale = '<S>' AND anno = <anno> AND ultimo_numero = <letto>
     AND NOT EXISTS (SELECT 1 FROM public.fatture_emesse f
                      WHERE f.sezionale = '<S>' AND f.anno = <anno> AND f.numero > <obiettivo>)
     /* solo se to_regclass('public.fatture_coda_invii') non è nullo: */
     AND NOT EXISTS (SELECT 1 FROM public.fatture_coda_invii i
                      WHERE i.sezionale = '<S>' AND i.anno = <anno> AND i.numero > <obiettivo>)
  RETURNING ultimo_numero
), audit AS (
  INSERT INTO public.registro_modifiche (utente_id, azione, tabella_interessata, record_id, vecchio_valore, nuovo_valore)
  SELECT NULL, 'allineamento_contatore_fatture', 'fatture_numerazione_sezionale', NULL,
         jsonb_build_object('sezionale','<S>','anno',<anno>,'ultimo_numero',<letto>),
         jsonb_build_object('sezionale','<S>','anno',<anno>,'ultimo_numero',<obiettivo>,
                            'massimo_aruba',<a>,'massimo_registro',<r>,'massimo_giornale',<g|null>,
                            'strumento','scripts/numerazione-serie.mjs')
  FROM upd RETURNING id
)
SELECT (SELECT count(*) FROM upd) AS aggiornate, (SELECT id FROM audit) AS audit_id;
```

- La clausola sul giornale entra solo se la tabella esiste.
- 0 righe aggiornate = qualcuno ha allocato nel frattempo: si rilancia.
- `utente_id` NULL = sistema. `postgres` ha UPDATE e INSERT (V).

### 4.4 Quando

- **Prima del merge**, solo se P6 è falso (→ C§18).
- È anche la via di sblocco della guardia a 50 (§5.1). Dopo il rilascio della coda:
  1. l'admin fa «Sospendi coda»;
  2. la guardia del §10 deve dire ok;
  3. si lancia `--allinea`;
  4. l'admin riprende dalla pagina.
- D: nel frattempo la coda ripete `riprova numerazione_anomala` con la pausa di 15' (→ C§8.2).

---

## 5. (C) `src/lib/aruba/emissione.ts`

### 5.1 Tetto sul salto del pavimento: da 10.000 a 50

- `SCARTO_MASSIMO_PAVIMENTO` (`:396`) = **50** (→ C§18).
- Il commento di `:375-395` si riscrive con le misure: scarto legittimo 3 (J0), al massimo 6 fuori app in 4 ore (F2), salti anomali di 361 e di 11.
- Il ramo resta a `:2144-2173`, con esito `pavimento-fuori-scala` a livello error (→ C§15):
  - più il campo numerico `salto = ultimoAruba − contatore`;
  - più la serie nel `msg`.
- Messaggio all'operatore:
  > «Su Aruba la serie «{S}» risulta arrivata al numero {ultimoAruba}, mentre a registro siamo a {contatore}: emettere adesso salterebbe {salto} numeri, e il salto non si potrebbe più annullare. La fattura non è stata emessa e nessun numero è stato consumato. Avvisa l'amministratore: va controllato su Aruba il documento con quel numero e, se è giusto, allineato il contatore.»
- Aggregato `numerazione_non_allineata` con 503 (`:2571`, `:2591`): il lotto si ferma (`lotto-fatture.ts:399-403`).
- Con il contatore `null` si prosegue come oggi.
- Confine: `salto > 50` ferma, `50` passa.

### 5.2 Il pavimento nei log

- **Avviso nuovo**, prima della RPC, quando `contatore !== null && ultimoAruba > contatore` e il salto è entro il tetto:
  - `logEvento('fattura','warn',{ operazione:'emettiFatturaPagamento:prossimoNumero', esito:'pavimento-sopra-contatore', scuola_id, pagamento_id, anno, pavimento, contatore, salto, msg:'serie {S}: su Aruba {pavimento}, a registro {contatore}: documenti emessi fuori dall'app spingono la serie' })`;
  - esito e livello sono quelli di C§15.
- **Campi numerici in più** `pavimento` e `contatore_prima` su `inviata` (`:2531-2539`) e sulle righe `registro-*` (§7).
- I nomi file stanno solo nel `msg` (→ C§0 punto 5). `provider:'aruba'` resta dove c'è già (è in `CHIAVI_IN_CHIARO`, V).

### 5.3 Aggregato: niente `scartata` sugli stop di numerazione (S27)

```ts
const soloStopDiNumerazione = esiti.length > 0 && esiti.every((e) => !e.ok && e.motivo === 'numerazione')
if (!soloStopDiNumerazione) { /* UPDATE fattura_stato='scartata' come oggi (:2553-2560) */ }
```

- Ritorno invariato (`motivoAgg`, `httpStatus`, `quote`).
- Il commento spiega che allo SdI non è successo niente, quindi il pagamento resta dov'era.
- Perimetro S27: le fermate miste o d'altro tipo restano come oggi fino alla PR-A, dove vale S51 (D3).

---

## 6. (D) Migrazione, applicata dall'integrazione al merge

### 6.1 File

- Nome: `supabase/migrations/<VERSION>_fatture_emesse_senza_vincolo_numero_per_sede.sql`.
- `VERSION` = `date -u +%Y%m%d%H%M%S` all'istante della scrittura: maggiore di `20260920124744` e di ogni `generato_alle` (C F4), mai nel futuro.
- Testata in italiano:
  - il sezionale non ha sede;
  - le 6 collisioni, solo numeri;
  - che cosa resta a proteggere il registro;
  - «la applica l'integrazione Supabase al merge della PR-D1»;
  - nessun dato toccato.
- Nessun UPDATE né DELETE.

### 6.2 SQL

```sql
DO $$
DECLARE v_senza_serie int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='fatture_emesse'
                 AND indexname='fatture_emesse_sezionale_anno_numero_uidx') THEN
    RAISE EXCEPTION 'fatture_emesse: manca fatture_emesse_sezionale_anno_numero_uidx; senza, togliere il vincolo per sede lascerebbe il numero di fattura senza difesa nel database (applicare prima 20260809235620)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='fatture_emesse'
                 AND indexname='fatture_emesse_pagamento_quota_uidx') THEN
    RAISE EXCEPTION 'fatture_emesse: manca fatture_emesse_pagamento_quota_uidx, la difesa per pagamento e quota (applicare prima 20260809235620)';
  END IF;
  SELECT count(*) INTO v_senza_serie FROM public.fatture_emesse WHERE sezionale IS NULL;
  IF v_senza_serie > 0 THEN
    RAISE EXCEPTION 'fatture_emesse: % righe senza sezionale: l''indice per serie è parziale e non le copre, vanno capite prima di togliere il vincolo per sede', v_senza_serie;
  END IF;
END $$;

ALTER TABLE public.fatture_emesse
  DROP CONSTRAINT IF EXISTS fatture_emesse_scuola_id_anno_numero_key;

COMMENT ON INDEX public.fatture_emesse_sezionale_anno_numero_uidx IS
  'Il numero di fattura non si ripete dentro (serie, anno), per tutte le sedi insieme: il soggetto fiscale è uno solo. Dal 2026-09 è l''unica difesa del numero a registro: il vincolo (scuola_id, anno, numero) della baseline confondeva la FPR N con la Asilo N della stessa sede e ha lasciato fuori dal registro fatture già partite.';
```

È idempotente (`IF EXISTS`) e non usa CASCADE.

### 6.3 Le parole che i lock cercano (V)

| Forma | Lock | Presente? | Rimedio |
|---|---|---|---|
| `drop constraint` | `tracce-docente-dichiarate.test.ts:153-158` (soglia = `generato_alle` di `fk-utenti`) | **sì** | si rigenera `fk-utenti-snapshot.json` prima del merge, dopo aver scritto il file; contenuto invariato (56 FK) |
| `unique`, `primary key` | `onconflict-arbitro.test.ts:408-411` | no | nessuno |
| file posteriore allo scatto | `migrazioni-complete.test.ts:244-315` | sì | verde, perché il file è «in coda»; la fotografia si rigenera solo in PR-D1b |
| `policy`, `row level security`, `drop table`, `add column scuola_id`, riga che inizia con `scuola_id uuid` | `toccaLaRls`, `fk-scuola-id` | no, nemmeno nei commenti | nessuno |
| uuid letterale, funzioni, `cron.schedule` | `migrazioni-senza-sede-cablata`, `security-definer-revoke-lock` | no | nessuno |

### 6.4 Fotografie

**PR-D1, prima del merge:** solo `__tests__/fixtures/fk-utenti-snapshot.json` (`fk-utenti-fotografia.mjs:29-35`; `$S` = scratchpad):

```
node __tests__/fixtures/fk-utenti-fotografia.mjs --sql > $S/fk.sql
supabase db query --linked --agent no -o json -f $S/fk.sql > $S/fk.json
node __tests__/fixtures/fk-utenti-fotografia.mjs < $S/fk.json
```

- Nel diff cambiano solo `generato_il` e `generato_alle`; `sha256` e le 56 voci restano uguali.
- Poi `npx vitest run __tests__/architecture/tracce-docente-dichiarate.test.ts` deve dare «Test Files 1 passed».

**PR-D1b, dopo il merge e dopo le orfane:**
- `migrazioni-applicate-snapshot.json` passa da 179 a **184** voci (`20260920001032`, `20260920124742/43/44`, `VERSION`);
- `indici-unici-snapshot.json` perde `fatture_emesse_scuola_id_anno_numero_key`; ogni altra differenza va spiegata;
- mini-lock (test 1b);
- PRD.

### 6.5 DB della CI

Niente `migrate-ci` (decisione 27, C§21): il DB della CI conserva il vincolo. V: nessun file di `e2e/` né `scripts/seed-e2e.mjs` scrive `fatture_emesse`. La migrazione si prova in PGlite sul file vero (test 1).

---

## 7. (E) Il 23505 (`emissione.ts:2478-2519`)

### 7.1 `src/lib/fatturazione/vincolo-registro.ts` (puro, senza import)

```ts
export const INDICE_NUMERO_SERIE = 'fatture_emesse_sezionale_anno_numero_uidx'
export const INDICE_PAGAMENTO_QUOTA = 'fatture_emesse_pagamento_quota_uidx'
export const VINCOLO_NUMERO_PER_SEDE = 'fatture_emesse_scuola_id_anno_numero_key' // tolto dalla migrazione di D1; vive nei DB non migrati (CI)
export type VincoloRegistro = 'pagamento-quota' | 'numero-serie' | 'numero-per-sede' | 'ignoto'
export function vincoloDelRifiuto(err: unknown): { vincolo: VincoloRegistro; nome: string | null } | null
```

- `code !== '23505'` → `null`.
- Il nome del vincolo:
  - da `message`, con `/constraint "([a-z0-9_]+)"/`;
  - altrimenti da `details`, con `/^Key \(([^)]+)\)/`;
  - se non si riconosce → `ignoto`.
- Lo riusa D3 per l'anomalia `doppia_emissione` (→ C§8.5).

### 7.2 Il ramo in `emissione.ts`

**Restano:** `ok:true`, l'aggregato `in_attesa` + `fattura_aruba_id`, il livello error, e `erroreConCausa(msg, errRegistro)` come quarto argomento.

**Cambiano:** esito e messaggio; `pagamento_id` c'è sempre; si aggiungono `pavimento` e `contatore_prima`; il commento di `:2498-2504` smette di dimenticare il vincolo della baseline.

| vincolo | esito (C§15) | `msg` |
|---|---|---|
| pagamento-quota | `registro-doppione-rifiutato` | `DOPPIA EMISSIONE: la fattura {nf} è partita verso Aruba ({file}) ma il registro l'ha RIFIUTATA perché per questo pagamento (quota) esisteva già una fattura viva: allo SdI ci sono due documenti per la stessa retta. Verifica su Aruba e prepara la nota di variazione` |
| numero-serie | `registro-numero-serie-duplicato` | `NUMERO GIÀ A REGISTRO: la fattura {nf} è partita verso Aruba ({file}) ma nella serie {sez} il numero {numero}/{anno} è già di un altro documento a registro. Non è una seconda fattura per lo stesso pagamento: si è ripetuta la NUMERAZIONE. Controlla su Aruba quale dei due lo SdI ha accettato e registra quella rimasta fuori (scripts/fatture-orfane.mjs)` |
| numero-per-sede | `registro-vincolo-per-sede` | `REGISTRO NON SCRITTO per il vecchio vincolo per sede (scuola, anno, numero): la fattura {nf} è partita verso Aruba ({file}) ed è un documento VALIDO; il vincolo l'ha confusa con il documento dell'altra serie che ha lo stesso numero nella stessa sede. NON è una doppia emissione e NON serve una nota di variazione: va solo registrata (scripts/fatture-orfane.mjs)` |
| ignoto | `registro-vincolo-ignoto` | `la fattura {nf} è partita verso Aruba ({file}) ma il registro l'ha rifiutata per un vincolo di unicità non previsto («{nome ?? 'sconosciuto'}»): verifica su Aruba prima di qualunque altra azione, poi registrala` |

- `registro-non-scritto` (errore senza 23505) resta com'è.
- `emissione-idempotenza.test.ts:311-339` usa il nome `…pagamento_quota_uidx` e resta su «DOPPIA» (V).
- `emissione-log.test.ts:223-248` usa un 23505 senza nome: diventa `registro-vincolo-ignoto`, e le sue asserzioni restano vere: livello error, «registro» e nome file nel messaggio (V).

---

## 8. (F) «Partita ma non registrata»: predicato a fonte unica, 409 lato server

### 8.1 `src/lib/pagamenti/fattura-partita-non-registrata.ts`

```ts
import { fatturaViva } from '@/lib/pagamenti/fattura-viva'
import { mapStatoAruba } from '@/lib/aruba/stato'

export const MOTIVO_PARTITA_NON_REGISTRATA = 'partita_non_registrata' as const
// Specchio di ESITO_VOCE.partita_non_registrata (contratto-db.ts, PR-A): l'uguaglianza la prova il lock di D2 (richiesta 4).

/** Codici sdi_stato di scarto, RICAVATI dal predicato canonico, mai scritti a mano. Oggi [2, 4, 9]. */
export const CODICI_SDI_SCARTO_REGISTRO: readonly number[] =
  Array.from({ length: 21 }, (_, c) => c).filter((c) => mapStatoAruba(c).isScarto)

/** Gemello SQL, forma CASE di contratto C0.3 (C0.5 n. 7). Alias obbligato: `p` = public.pagamenti. */
export const PREDICATO_SQL_PARTITA_NON_REGISTRATA =
  `p.fattura_stato = 'in_attesa' AND CASE ` +
  `WHEN p.fattura_aruba_id IS NOT NULL THEN NOT EXISTS (SELECT 1 FROM public.fatture_emesse f ` +
  `WHERE f.pagamento_id = p.id AND f.aruba_filename = p.fattura_aruba_id) ` +
  `ELSE NOT EXISTS (SELECT 1 FROM public.fatture_emesse f ` +
  `WHERE f.pagamento_id = p.id AND (f.sdi_stato IS NULL OR f.sdi_stato <> ALL (ARRAY[${CODICI_SDI_SCARTO_REGISTRO.join(',')}]))) END`

export interface RigaRegistroMinima { sdi_stato: number | null; aruba_filename: string | null }
export function fatturaPartitaNonRegistrata(
  pag: { fattura_stato?: string | null; fattura_aruba_id?: string | null },
  righeRegistro: readonly RigaRegistroMinima[],   // TUTTE le righe del pagamento, in qualunque stato
): boolean {
  if (pag.fattura_stato !== 'in_attesa') return false
  const file = pag.fattura_aruba_id
  // Forma CASE di C0.3: con il file, conta solo la riga di QUEL file; senza, conta una riga viva qualsiasi.
  if (file) return !righeRegistro.some((r) => r.aruba_filename === file)
  return !righeRegistro.some(fatturaViva)
}
```

**(C0.5 n. 7)** Il blocco qui sopra è riscritto nella forma CASE di contratto C0.3: la versione precedente (riga viva qualsiasi ⇒ falso) sbagliava il caso «quota B viva, file della quota A assente», che C0.3 dà **vero** (`emissione.ts:2604` scrive il file della prima quota riuscita [V dal registro C0 G1]).

**Perché non basta «zero righe».**
- L'idempotenza guarda solo le righe vive (`emissione.ts:1458`, `righeEsistenti.filter(fatturaViva)`, V).
- Una ri-emissione dopo uno scarto, con l'INSERT fallito, lascia `in_attesa` più la sola riga scartata. Con «zero righe» il predicato risulterebbe falso e partirebbe un secondo documento.
- Il ramo sul nome file evita il falso positivo opposto: la sync ha scartato proprio quel file, ma l'aggiornamento del pagamento è fallito.

**Parità, e il caso del NULL.**
- In SQL `f.aruba_filename = NULL` vale NULL, e la riga non conta. In TS `file` nullo dà `true`. I due lati coincidono, e il test 4 lo prova anche con `aruba_filename` nullo.
- La lista di scarto coincide col `WHERE` di `fatture_emesse_pagamento_quota_uidx` (`20260809235620:167-169`), e il test lo prova.
- Oggi TS e SQL danno 6 in produzione (V).

**Fonte unica.**
- `scripts/fatture-orfane.mjs` e `scripts/numerazione-serie.mjs` importano il modulo con `scripts/lib/risolvi-ts.mjs`, che è già il meccanismo del repo (V: `anteprima-email.mjs` e altri 4 script). L'import avviene per `await import('@/lib/pagamenti/fattura-partita-non-registrata')`, dopo aver registrato l'hook.
- La catena d'import è pura (V): `fattura-viva` → `aruba/stato` → `logging/serialize` → `./path`.
- Nessuna copia del testo SQL negli script.
- D2 lo porta in `fatture_coda_accoda` (richiesta 1).

### 8.2 In `emissione.ts`

- **Select di `:809`:** si aggiungono `fattura_stato, fattura_aruba_id`, colonne della baseline. Resta una stringa sola (vincolo dichiarato a `:805-807`).
- **Il blocco:** va dopo `righeEsistenti` (`:1367-1393`) e prima di «// 7.» (`:1395`). Prima di quel punto non ci sono chiamate ad Aruba né RPC (V: la prima è `sessione.token`, a `:1401`). Se il predicato è vero:
  - `logEvento('fattura','warn',{ operazione:'emettiFatturaPagamento:idempotenza', esito:'partita-non-registrata-fermata', provider:'aruba', scuola_id, pagamento_id, msg:'pagamento «in attesa» con la fattura partita (file {…}) e nessuna riga viva a registro: emissione fermata prima di allocare il numero' })`;
  - `return { ok:false, motivo: MOTIVO_PARTITA_NON_REGISTRATA, httpStatus:409, messaggio:'La fattura di questo pagamento risulta già partita verso Aruba ({file}) ma non è registrata nell'app: non se ne emette una seconda. Va prima registrata. Nessun numero è stato consumato.' }`.
- Il ritorno arriva **prima** dell'aggregato: `fattura_stato` e `fattura_aruba_id` restano, così la scoperta delle orfane le vede ancora.
- Il motivo `'partita_non_registrata'` entra nell'unione `motivo` di `EsitoEmissione` (`:201-218`).
- Nella PR-A, D3 classifica `errore partita_non_registrata` (→ C§8.2).

### 8.3 Route e i18n (valgono fino al 410 di D4 nella PR-A)

- **`fattura/route.ts`:** costante locale `CODICE_PARTITA_NON_REGISTRATA = 'FATTURA_PARTITA_NON_REGISTRATA'` e un ramo 409 `{ error, codice, data:{motivo} }`, accanto a quelli di `:446-475`.
- **`fattura/lotto/route.ts`:** nella spread di `fallite.push` (`:379-384`) si aggiunge `codice`. `RigaEsito.codice` esiste già (`:148`, V). Il 409 non ferma il lotto (`fermaIlLotto` scatta su 0, 429 e 5xx).
- **`esito-fetch.ts`:** `FATTURA_PARTITA_NON_REGISTRATA: 'erroreFatturaPartitaNonRegistrata'` in `CODICI_ERRORE` (`:72`) e in `CODICI_CON_DETTAGLIO` (`:2811`).
- **Testi:** in `messages/{it,en}/shared.json`.
- **Allowlist `errori-senza-codice`:** non si tocca. È contata per file (V), e una risposta con `codice` non aggiunge debito.

---

## 9. (G) Orfane: `scripts/fatture-orfane.mjs` + `scripts/lib/fatture-orfane.mjs`

**Prerequisito:** la migrazione è in produzione (§13, passo 7). Lo script lo verifica su `pg_constraint`; se il vincolo c'è ancora esce con 1 e non scrive nulla.

```
node scripts/fatture-orfane.mjs --out <cartella FUORI dal repo> [--solo <pagamento_uuid>] [--conserva] [--applica]
```

- **Senza `--applica`** lo script lavora in sola lettura:
  - `guardiaArubaPerScript()` prima di ogni chiamata;
  - 1 signin;
  - N `getByFilename` (`includeFile=true&includePdf=false`) a 5 s l'una dall'altra;
  - lo scorrimento `findByUsername` del 2026.
- **Tutte le letture da Aruba si chiudono prima di qualunque scrittura.**
- **Codici d'uscita:**
  - 0 = niente da fare, oppure tutto registrato;
  - 1 = guardia d'uso;
  - 2 = almeno una voce «DA DECIDERE»;
  - 3 = errore di scrittura.

### 9.1 Flusso

1. **Guardie:**
   - `--out` fuori dal repo;
   - `openssl version`;
   - `select 1`;
   - `guardiaArubaPerScript()`;
   - file a 0600; `.p7m`, `.xml` e `.sql` cancellati in uscita, salvo `--conserva`.
2. **Scoperta dal DB:**
   - pagamenti presi con `PREDICATO_SQL_PARTITA_NON_REGISTRATA`, importato dal modulo, esclusi gli `scuola_id::text LIKE 'e2e00000-%'`;
   - poi, per ognuno, **il predicato TS** `fatturaPartitaNonRegistrata` sulle righe lette: se TS e SQL non coincidono, la voce è «DA DECIDERE: i due predicati non concordano» e l'uscita è 2 (parità controllata anche a ogni lancio);
   - log con esito `registro-doppione-rifiutato`, `registro-non-scritto`, `registro-numero-serie-duplicato`, `registro-vincolo-per-sede` o `registro-vincolo-ignoto`;
   - dai log si ricavano:
     - il nome file, con `^IT[0-9A-Z]{11,16}_[0-9A-Za-z]{5}\.xml(\.p7m)?$`;
     - il numero, con `((?:Asilo|FPR) [0-9]+/[0-9]+)`;
     - il vincolo, da `causa.messaggio`;
     - `utente_id`;
   - pagamenti e log si accoppiano per nome file:
     - un pagamento senza log dà un avviso;
     - un log senza orfana si segnala;
     - più log sullo stesso pagamento → «DA DECIDERE»;
   - se `fatture_coda_invii` esiste e il pagamento ha un invio, la voce è «DA DECIDERE: la registra la coda» (→ C§5.2).
3. **Aruba:**
   - `getByFilename`, con il base64 preso da `file ?? dataFile ?? fileContent`;
   - estrazione con openssl;
   - stato SdI con `codiceStatoAruba` e `mapStatoAruba` (`src/lib/aruba/stato.ts`, via `risolvi-ts.mjs`).
4. **Estrazione dall'XML** (`estraiCampiXml`, tracciato di `fatturapa-xml.ts:483-587`):
   - campi: `ProgressivoInvio`, `TipoDocumento`, `Data`, `Numero`, `ImportoTotaleDocumento`, `ImportoPagamento`, `BolloVirtuale`, `CedentePrestatore/IdCodice`, `CessionarioCommittente` (`CodiceFiscale`, `Nome`, `Cognome`), `DettaglioLinee/Descrizione`;
   - decodifica delle entità;
   - validazione XSD con `__tests__/lib/aruba/valida-xsd.ts` (`xmllint-wasm`);
   - più di un body → rifiuto.
5. **Controlli.** Se uno fallisce, la voce è «DA DECIDERE»:
   - a. `Numero` === `formattaNumeroFattura(sez, numero, anno)` (`sezionale.ts:584`), coerente col log;
   - b. `TD01` e cedente 03394870616;
   - c. `ProgressivoInvio` `^[AF]\d{8}$`, coerente con `progressivoInvioFattura` (`emissione.ts:331-334`);
   - d. `ImportoTotaleDocumento` === `ImportoPagamento`. Se differisce da `pagamenti.importo` è solo un avviso, e vince l'XML (F37);
   - e. XSD valido;
   - f. su Aruba un solo documento per (serie, numero), col nostro nome file. Uno fuori app con lo stesso numero è un DOPPIONE;
   - g. nel DB:
     - zero righe del pagamento (si registrano solo le orfane «pure»);
     - nessuna riga per (sezionale, anno, numero);
     - `in_attesa` con lo stesso nome file;
     - vincolo assente;
     - `fatture_visibilita_attiva_il` nullo, oppure riga con `modalita_emissione`;
   - h. intestatario risolto (§9.2).
6. **Scrittura (`--applica`):**
   - conteggio con una SELECT;
   - per ogni voce pronta, in ordine di `fattura_emessa_il`, si stampa «SCRIVO i/N:» con l'istruzione intera e i dati mascherati:
     - CF come `ABC…(16)`;
     - nome e cognome come «presenti, N caratteri; coincidono con l'anagrafica: sì/no»;
     - XML e causale come `<N byte, sha256 …>`;
   - poi si esegue da `<out>/<pagamento>.sql` (0600) con `supabase db query --linked --agent no -o json -f`;
   - prima si mostra, poi si applica, senza conferma (C§18, decisione 26);
   - `--solo <uuid>` fa la prima voce da sola.
7. **Dopo:**
   - riconteggio con `PREDICATO_SQL_PARTITA_NON_REGISTRATA`, atteso **0** (C§18);
   - la sync (`*/30`) porta avanti `sdi_stato` e `fattura_stato`.

### 9.2 Colonne della riga (stessa forma di C§7.3, ultimo punto)

| Colonna | Valore |
|---|---|
| `pagamento_id`, `scuola_id` | dal pagamento |
| `numero`, `sezionale`, `anno` | da `<Numero>` |
| `progressivo_invio` | da `<ProgressivoInvio>` |
| `importo` | da `<ImportoTotaleDocumento>` |
| `causale` | da `<Descrizione>` decodificata |
| `intestatario` | `{nome, cognome, codice_fiscale}` **dall'XML inviato** (decisione 24) |
| `xml_inviato` | l'XML estratto |
| `aruba_filename` | `pagamenti.fattura_aruba_id` |
| `sdi_stato`, `sdi_stato_label` | 1, «Presa in carico» |
| `inviata_il`, `creato_il` | `pagamenti.fattura_emessa_il` |
| **`creato_da`** | **NULL = «sistema»** (decisione 24; richiesta 2) |
| `quota_adult_id`, `parent_registry_id` | vedi sotto |
| `quota_label` | NULL |
| `modalita_emissione` | `'ordinaria'` |
| `bollo_virtuale` | dall'XML |

- **`creato_da`:** è `uuid` nullabile senza FK (`baseline.sql:1508`), non letto da `src` (l'unico scrittore è `emissione.ts:2293`), assente da `fk-utenti-snapshot.json`. Chi aveva emesso resta nell'audit, come `emessa_da`.
- **`quota_adult_id` e `parent_registry_id`:**
  - (i) `adult` con CF uguale al `parents`;
  - (ii) un solo `parents` con quel CF;
  - (iii) `altro` → NULL;
  - (iv) altrimenti la voce è DA DECIDERE.

### 9.3 L'istruzione (una sola, atomica, idempotente)

```sql
WITH pre AS (
  SELECT p.id FROM public.pagamenti p
  WHERE p.id = '<pag>'::uuid AND p.fattura_stato = 'in_attesa' AND p.fattura_aruba_id = '<file>'
    AND NOT EXISTS (SELECT 1 FROM public.fatture_emesse f WHERE f.pagamento_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM public.fatture_emesse f WHERE f.sezionale = '<sez>' AND f.anno = <anno> AND f.numero = <num>)
    /* solo se la tabella esiste: */ AND NOT EXISTS (SELECT 1 FROM public.fatture_coda_invii i WHERE i.pagamento_id = p.id)
), ins AS (
  INSERT INTO public.fatture_emesse (pagamento_id, scuola_id, numero, sezionale, anno, progressivo_invio, causale, importo,
    intestatario, xml_inviato, aruba_filename, sdi_stato, sdi_stato_label, inviata_il, creato_da, creato_il,
    quota_adult_id, quota_label, parent_registry_id, modalita_emissione, bollo_virtuale)
  SELECT '<pag>'::uuid, '<scuola>'::uuid, <num>, '<sez>', <anno>, '<prog>', $T$<causale>$T$, <importo>,
    jsonb_build_object('nome', $T$<nome>$T$, 'cognome', $T$<cognome>$T$, 'codice_fiscale', '<CF>'),
    $T$<xml>$T$, '<file>', 1, 'Presa in carico', '<ts>'::timestamptz, NULL, '<ts>'::timestamptz,
    <quota|NULL>, NULL, <registry|NULL>, 'ordinaria', <true|false>
  FROM pre
  RETURNING id, pagamento_id, sezionale, anno, numero
), audit AS (
  INSERT INTO public.registro_modifiche (utente_id, azione, tabella_interessata, record_id, vecchio_valore, nuovo_valore)
  SELECT NULL, 'registrazione_fattura_orfana', 'fatture_emesse', ins.id,
    jsonb_build_object('pagamento_id', ins.pagamento_id, 'riga_a_registro', false),
    jsonb_build_object('pagamento_id', ins.pagamento_id, 'sezionale', ins.sezionale, 'anno', ins.anno, 'numero', ins.numero,
      'aruba_filename', '<file>', 'app_log_id', '<log|null>', 'emessa_da', '<utente_log|null>',
      'causa', 'fatture_emesse_scuola_id_anno_numero_key', 'strumento', 'scripts/fatture-orfane.mjs')
  FROM ins RETURNING id
)
SELECT (SELECT count(*) FROM ins) AS registrate, (SELECT id FROM ins) AS fattura_id, (SELECT id FROM audit) AS audit_id;
```

- `$T$` è un tag casuale a ogni esecuzione; si controlla che non compaia nei testi.
- Validazioni:
  - uuid;
  - `sez ∈ {Asilo, FPR}`;
  - interi;
  - importo `^\d+\.\d{2}$`;
  - istanti ISO;
  - nome file;
  - CF `^[A-Z0-9]{11,16}$`.
- Nessun UPDATE di `pagamenti`.
- WORM: una riga sbagliata resta per sempre, per questo si parte dalla lettura a secco e poi da `--solo`.

---

## 10. Guardia degli script che chiamano Aruba (S28, rilievi v5 R1 e v6 R3)

La guardia sta in `scripts/lib/aruba-lettura.mjs`. La usano `numerazione-serie.mjs` (anche con `--allinea`) e `fatture-orfane.mjs`.

- **Quando:** prima del signin e prima di **ogni** chiamata ad Aruba. Una lettura costa circa 2 s, e fra due chiamate passano 5 s.
- **Se fallisce:** uscita 1, i risultati parziali restano in `--out`, nessuna scrittura.
- **Ordine delle guardie:** lettura, coda, circuito, cancello, finestra della sync, attività dell'app.

### 10.1 Stato della coda (fail-closed)

- **Prima lettura, sempre:**

  ```sql
  select extract(minute from now())::int as minuto, now() as adesso,
         to_regclass('public.fatture_coda_stato') is not null as stato,
         to_regclass('public.aruba_cancello') is not null as cancello,
         (select count(*) from public.app_log
           where evento = 'fattura' and creato_il > now() - interval '10 minutes'
             and (contesto->'campi'->>'operazione' like 'aruba:%'
                  or contesto->'campi'->>'operazione' like 'emettiFatturaPagamento:%')) as attivita_app,
         (select max(creato_il) from public.app_log
           where evento = 'fattura' and creato_il > now() - interval '10 minutes'
             and (contesto->'campi'->>'operazione' like 'aruba:%'
                  or contesto->'campi'->>'operazione' like 'emettiFatturaPagamento:%')) as ultima_attivita
  ```

  - nessuna delle due tabelle → «non installata»;
  - una sola delle due → incoerente → blocco.
- **Seconda lettura, se la coda è installata** (una tabella inesistente farebbe fallire la prima):

  ```sql
  select s.sospesa,
         coalesce(c.circuito_fino_a > now(), false) as circuito_aperto, c.circuito_fino_a,
         coalesce(c.prestito_scade_il > now(), false) as cancello_in_uso, c.titolare,
         count(*) over () as righe
  from public.fatture_coda_stato s cross join public.aruba_cancello c
  ```

  - righe ≠ 1 → blocco. La CLI legge le tabelle perché `postgres` ha `BYPASSRLS` (→ C§7.6, C§7.7).
- **`verdettoCodaPerScript({ installata, riga, errore })`**, nell'ordine:
  1. lettura fallita o incoerente → **blocco**;
  2. non installata → prosegue (fino alla PR-A);
  3. `sospesa !== true` → **blocco**: «La coda fatture è attiva: questo script chiama Aruba fuori dal cancello. Un admin sospenda la coda dalla pagina Coda fatture, poi rilancia; a fine lavoro la riprende»;
  4. `circuito_aperto` → **blocco**: «Aruba è in silenzio fino alle {HH:MM Europe/Rome}: ogni tentativo prima di allora riapre l'ora di attesa (decisione 16). Rilancia dopo quell'ora»;
  5. `cancello_in_uso` → **blocco**: «il cancello Aruba è in mano a {coda|sync}: rilancia fra qualche minuto»;
  6. altrimenti prosegue.
- Lo script non scrive mai sulle tabelle della coda.

### 10.2 Finestra della sync (corretta, §0.2 b)

- `minutoInFinestraSync(m)` è vero per **m ∈ {58, 59, 0, 1, 2, 3, 4, 5, 28, 29, 30, 31, 32, 33, 34, 35}**.
- Il minuto viene dall'orologio del DB (`extract(minute from now())`), che è quello di pg_cron.
- Da dove vengono i minuti:
  - pg_cron `*/30`;
  - `maxDuration = 300` (§2.9): una sync partita a :00 o a :30 può chiamare Aruba fino a :05 o :35;
  - 2 minuti di margine prima della partenza.
- Dopo la PR-A la sync prende anche il cancello, e lo copre il punto 5 del §10.1.

### 10.3 Attività dell'app verso Aruba (nuova, fail-closed)

- **Il blocco:** `verdettoAttivitaApp({ n, ultimo, errore, adesso })` blocca se `attivita_app > 0`: «l'app ha parlato con Aruba alle {HH:MM}: riprova dopo le {HH:MM + 10'}». Blocca anche se la lettura fallisce.
- **Cosa copre:** le emissioni della segreteria prima della PR-A, quando non esistono né coda né cancello (decisione 24), e ogni altra traccia `aruba:*`.
- **Limite:** i log arrivano da `after()`, con qualche secondo di ritardo. Un'emissione che parte fra due controlli la vede il controllo successivo, entro circa 5 s più quel ritardo.
- **Costo:** nessuna chiamata in più, perché sta nella prima lettura del §10.1.
- Gli script non scrivono in `app_log`, quindi non si bloccano da soli.

### 10.4 Raccomandazione (non bloccante)

Fuori dall'orario della segreteria: prima delle 08:00 o dopo le 18:30 Europe/Rome.
- Aruba documenta i limiti di frequenza **per IP** (`HANDOFF-aruba-2026-09-02.md:54-56`); lo script gira da un IP diverso da quello di Vercel.
- La portata delle chiavi del TTL non è documentata (`:58`). Gli script non fanno upload.

### 10.5 Al primo 429

- Lo script si ferma e salva i risultati parziali.
- Stampa «Aruba ha risposto 429 alle {HH:MM}. NON riprendere la coda, e non rilanciare script, prima delle {HH:MM + 60'}».
- Esce con 1.
- D: lo script non può aprire il circuito del DB, perché scrivono solo le RPC (C§7). Il rischio residuo è nel §rischi.

### 10.6 API esportata (per gli script di D1 e, quando vengono toccati, per quelli di F23)

```js
export async function guardiaArubaPerScript({ sql /* (testo) => Promise<righe[]>, via execFileSync della CLI */ })
  // → { ok: true, adesso } | { ok: false, codice, messaggio, riprova_dopo? }
  // codice ∈ 'lettura-fallita' | 'coda-incoerente' | 'coda-attiva' | 'circuito-aperto' | 'cancello-in-uso' | 'finestra-sync' | 'attivita-app'
export function verdettoCodaPerScript({ installata, riga, errore })
export function minutoInFinestraSync(minuto)
export function verdettoAttivitaApp({ n, ultimo, errore, adesso })
export function messaggio429(istante)
```

Firma stabile. Gli script di F23 (`scripts/aruba-*.mjs`, `scripts/collaudo/**`) non sono di D1: la guardia va in ognuno nel commit in cui qualcuno lo tocca (richiesta 3).

---

## 11. Osservabilità (→ C§15, riga «emettiFatturaPagamento:* (D1)»)

- **warn:** `pavimento-sopra-contatore`, `partita-non-registrata-fermata`.
- **error:** `pavimento-fuori-scala` (con `salto`), `registro-doppione-rifiutato`, `registro-numero-serie-duplicato`, `registro-vincolo-per-sede`, `registro-vincolo-ignoto`.
- **Campi numerici nuovi:** `pavimento`, `contatore_prima`, `salto`; `pagamento_id` sulle righe `registro-*`. I nomi file stanno solo nel `msg`.
- **Impronta:** `messaggio` entra nell'impronta (`logger.ts:782-784`), quindi uno stop ripetuto con gli stessi numeri fa **una** riga al giorno. Le righe `registro-*` sono una per documento, e sono guasti veri.
- **`/api/health`:** non si tocca.
- **Dopo il rilascio si controlla che:**
  - dopo il merge ci siano 0 righe `registro-vincolo-per-sede`;
  - le orfane contate col predicato SQL siano 0;
  - le righe `pavimento-*` abbiano i loro numeri.
- **Gli script** non scrivono in `app_log`: lasciano traccia in `registro_modifiche`.

---

## 12. Test

Ognuno ha un controllo negativo: si rompe il codice e il test deve diventare rosso.

### Test 1. `__tests__/db/fatture-emesse-senza-vincolo-per-sede.test.ts`

PGlite 0.5.8, sul modello di `fatture-visibilita.test.ts`.

- il file si trova per suffisso ed è uno solo;
- tabella minima con il vincolo e i due indici;
- PRIMA: Asilo 2542 e FPR 2542 nella stessa sede → 23505 per sede;
- DOPO: la coppia entra;
- FPR 2542 in due sedi → 23505 sull'indice per serie;
- due righe vive con lo stesso pagamento e la stessa quota → 23505; una scartata più una viva → entrano;
- una seconda esecuzione non dà errori;
- il DO fa RAISE senza l'indice per serie, e con una riga a `sezionale NULL`;
- controlli testuali (§6.3).

**1b, solo in PR-D1b (mini-lock):**
- `indici-unici-snapshot.json` non ha il vincolo e ha i due indici;
- `migrazioni-applicate-snapshot.json` ha `{VERSION, 'fatture_emesse_senza_vincolo_numero_per_sede'}`;
- negativo: un oggetto sintetico col vincolo risulta «presente».

### Test 2. `__tests__/lib/fatturazione/vincolo-registro.test.ts`

- i 4 vincoli, letti da `message` e da `details`;
- un codice diverso da 23505 → null.

### Test 3. `__tests__/lib/aruba/emissione-registro-rifiutato.test.ts`

- per ogni vincolo: esito, `pagamento_id`, nome file, `pavimento`, `contatore_prima`;
- «DOPPIA» solo sull'indice per quota;
- nessuna «nota di variazione» sui rami per sede e per serie;
- restano verdi `emissione-idempotenza.test.ts:311-339` ed `emissione-log.test.ts:223-248`.

### Test 4. `__tests__/lib/pagamenti/fattura-partita-non-registrata.test.ts`

**a) Tabella di verità del TS:**

| Stato del pagamento | Righe a registro | Esito |
|---|---|---|
| `in_attesa` | nessuna | vero |
| `in_attesa` | solo una scartata con un file diverso | vero |
| `in_attesa` | una scartata con lo stesso file | falso |
| `in_attesa` | una riga viva | falso |
| `in_attesa`, `fattura_aruba_id` nullo | nessuna | vero |
| `in_attesa`, `fattura_aruba_id` nullo | una scartata con `aruba_filename` nullo | vero |
| `in_attesa` | una riga con `sdi_stato` nullo | falso |
| `non_richiesta`, `scartata`, `emessa` | nessuna | falso |

Negativo: con `length > 0` al posto di `some(fatturaViva)` la seconda riga diventa rossa.

**b) Parità TS/SQL su PGlite (NUOVA, rilievo 1):**
- tabelle minime `public.pagamenti(id, fattura_stato, fattura_aruba_id)` e `public.fatture_emesse(pagamento_id, sdi_stato, aruba_filename)`;
- si seminano gli 8 casi e si esegue `select p.id from public.pagamenti p where ${PREDICATO_SQL_PARTITA_NON_REGISTRATA}`;
- l'insieme deve essere uguale a quello del TS, caso per caso;
- negativo: con la forma «zero righe» al posto del predicato, il caso «sola scartata di un altro file» diverge, e il test è rosso.

**c) Lista di scarto:**
- `CODICI_SDI_SCARTO_REGISTRO` è `[2, 4, 9]`;
- è uguale alla lista estratta dal `WHERE` di `fatture_emesse_pagamento_quota_uidx` nel file `20260809235620` (:167-169);
- negativo: una lista scritta a mano `[2, 4]` è rossa contro l'indice.

### Test 5. `__tests__/lib/aruba/emissione-partita-non-registrata.test.ts`

- `in_attesa` senza righe → 409 `partita_non_registrata`, e inoltre:
  - nessuna RPC, nessun signin, nessun upload;
  - 0 INSERT e **0 UPDATE di `pagamenti`**;
  - un warn;
- `in_attesa` con la sola scartata di un altro file → 409;
- negativi:
  - riga viva → risposta idempotente;
  - scartata con lo stesso file → emette;
  - `non_richiesta` senza righe → emette;
  - `scartata` senza righe → emette.

### Test 6. `__tests__/lib/aruba/pavimento-implausibile.test.ts` (modifica)

Il finto registra gli `update` per tabella e sa far fallire la RPC.

- caso 2515 contro 2154:
  - nessuna RPC, nessun upload;
  - esito `numerazione_non_allineata`;
  - un error con `salto` 361 e la frase «Avvisa l'amministratore»;
  - **nessun UPDATE di `pagamenti`**;
- RPC fallita → nessun UPDATE di `pagamenti`;
- confine: 50 passa, 51 si ferma;
- salto 3 → warn con `salto` 3; salto 0 → nessun warn;
- i casi esistenti restano (999.999.999; 2334 contro 2331). Se un'asserzione conta le righe di log, la si aggiorna (C§0 punto 2);
- negativo del §5.3: togliere la condizione fa ricomparire `scartata`;
- `fattura-emissione.test.ts:255-267` (lo scarto di merito scrive `scartata`) resta verde e fa da controllo opposto.

### Test 7. Route

- `__tests__/api/fattura-route.test.ts`: 409 con il codice;
- `__tests__/api/fattura-lotto.test.ts`: `fallite[].codice`, e il lotto prosegue.

### Test 8. `__tests__/lib/fatture-orfane.test.ts`

CF palesemente finti.

**Funzioni pure:** `estraiCampiXml`, `accoppiaOrfane`, `risolviIntestatario` (casi i-iv), `componiInsert`. Si provano:
- le validazioni;
- il tag che collide;
- la stampa senza CF, nomi e XML;
- `creato_da` NULL ed `emessa_da` nell'audit;
- la clausola sul giornale solo se la tabella esiste.

**Casi di scoperta:**
- `fuoriDalRepository`;
- la regex cattura «FPR 2525/2026» per intero;
- una voce con un invio della coda → «DA DECIDERE»;
- **nuovo:** SQL e TS in disaccordo su un caso sintetico → «DA DECIDERE», uscita 2;
- lo script prende il predicato dal modulo: nessun letterale `fattura_stato = 'in_attesa'` in `scripts/**` (controllo testuale).

**In PGlite (WORM e visibilità):**
- prima esecuzione 1+1, seconda 0;
- stato diverso → 0;
- numero occupato → 0;
- vincolo presente → «migrazione non applicata».

### Test 9. `__tests__/lib/numerazione-serie.test.ts`

Importa `scripts/lib/numerazione-serie.mjs` e `scripts/lib/aruba-lettura.mjs`.

**Numerazione:**
- parità del parser; `classifica`, compreso il giornale; `buchi`;
- `attribuisciSalti` con J0-J4 e un «NON SPIEGATO»; `doppioni`;
- `obiettivoContatore`: massimo dei tre, rifiuto di scendere sotto il giornale, rifiuto con un `--a` diverso;
- `componiAllineamento`, a confronto-e-scambio; negativo senza `ultimo_numero = letto`.

**`verdettoCodaPerScript`:**
- non installata → ok;
- una tabella sola → blocco;
- sospesa, circuito chiuso e cancello libero → ok;
- coda attiva → blocco;
- sospesa con circuito aperto → blocco col suo orario; negativo: senza quel controllo passa, e il test è rosso;
- sospesa con circuito scaduto → ok;
- cancello in prestito → blocco;
- errore di lettura → blocco;
- righe ≠ 1 → blocco.

**Finestra della sync (corretta):**
- bloccati :58, :59, :00, :02, :05, :28, :30, :35;
- liberi :06, :27, :36, :57;
- negativo: con la finestra della v5 (58-03 / 28-33) il caso :05 passa, e il test è rosso.

**`verdettoAttivitaApp`:** `n > 0` → blocco con l'orario +10'; `n = 0` → ok; errore → blocco.

**`guardiaArubaPerScript`** con una `sql` finta:
- l'ordine delle guardie;
- una sola lettura quando la coda non è installata;
- nessuna seconda lettura se la prima fallisce.

**Il 429:** il messaggio porta l'orario +60'.

**`verdettoP7`:**
- diff a 0 contro `rif`, controllo positivo a 1, `rif` antenato → vero;
- **controllo positivo a 0 → «prova cieca», falso**;
- `git log -1 rif` vuoto → falso;
- `rif` non antenato di `HEAD` → uscita 1;
- diff diverso → falso;
- **negativo di §0.2 a:** un confronto con `HEAD`, con `emissione.ts` modificato, dà falso, e il test documenta perché il riferimento è `rif`.

**Altro:**
- `deployAttivoAl` sui deploy reali del §2.6: J1 e J2 → `9a30ff67`; J3, J4 e «adesso» → `29bb04c7`;
- `argomentiGit` restituisce un array; negativo: unirli in una stringa fa fallire il controllo positivo;
- `fuoriDalRepository`.

### Test 10. Gate

Comandi:
- `npx eslint . --max-warnings 0`;
- `npx tsc --noEmit`;
- `npx vitest run`, con «Test Files N passed» confrontato col numero di file;
- `npm run build`.

Lock da guardare:
- `migrazioni-complete`, `onconflict-arbitro`, `tracce-docente-dichiarate`, `soglia-fotografia`;
- `rls-per-sede`, `fk-scuola-id`, `migrazioni-senza-sede-cablata`, `security-definer-revoke-lock`;
- `errori-con-codice`, `messaggi-parita-cataloghi`, `logging-coverage`;
- `pii-nei-file-tracciati`, `annullo-riapre-movimento`.

---

## 13. Rilascio (sequenza di C§18 e C§20; qui i passi di D1)

**Prima del merge** (dal branch):
1. `gh pr checks <n>`: `quality` ed `e2e` verdi.
2. `supabase db push --linked --dry-run` elenca **solo** il file di D1; altrimenti STOP.
3. `node scripts/numerazione-serie.mjs --out $S`, con la guardia del §10. La P7 la fa lo script contro `rif`. Atteso:
   - uscita 0;
   - P0-P7 veri;
   - `pavimento − contatore ≤ 50` su entrambe le serie.

   Con P6 falso si passa al §4. Con H2: STOP.
4. Conteggio delle orfane col predicato SQL; stampa del testo della migrazione.
5. **Nessuna emissione negli ultimi 10'** (la stessa lettura del §10.1, con `attivita_app = 0`). Il DROP CONSTRAINT prende un lock esclusivo su `fatture_emesse`, anche se breve (425 righe).
6. Finestra: dopo le 16:00 Europe/Rome, ai minuti :10-:20 o :40-:50, fuori dalla sync (§10.2).

**Merge:** `gh pr merge <n> --squash --delete-branch`.

**Dopo il merge:**

7. Check `Supabase Preview` in `success` sul commit.
8. SELECT di sola lettura:
   - `schema_migrations` contiene `VERSION` con `created_by` NULL;
   - il vincolo è assente;
   - i due indici sono presenti.
9. Deploy Vercel in `success`.
10. **Mai** `apply_migration` né `db push`; `migrate.yml` non si approva (C§0 punto 3).
11. Se il 7 o l'8 falliscono: si corregge con una PR, mai a mano. Il codice resta compatibile, e il 409 protegge le orfane.
12. Orfane, con la guardia del §10:
    - lettura a secco, uscita 0;
    - `--applica --solo <la più vecchia>`;
    - `--applica`;
    - **riconteggio col predicato SQL = 0**: è la precondizione del merge della PR-A (C§18).
13. Dopo il primo giro di `fatture-sdi-sync`: le righe registrate hanno `sdi_stato` aggiornato, e dopo il merge non compare alcun `registro-vincolo-per-sede`.
14. PR-D1b: fotografie, mini-lock, PRD; gate, CI, merge. Nessuna migrazione, quindi nessun vincolo di finestra.
15. Pulizia dei branch. Resoconto al titolare:
    - indagine e prospetto, con P7 e `rif`;
    - contatori;
    - orfane (solo numeri);
    - check Supabase;
    - `migrate.yml` in attesa.

---

## 14. Fasi ed esecutori (un esecutore per file; un critico a fine fase)

**Fase 1, scrittura** (in parallelo, file disgiunti):
- E1: migrazione e test 1;
- E2: `vincolo-registro.ts` e test 2;
- E3: predicato, gemello SQL, lista di scarto e test 4 (con PGlite);
- E4: tutto `emissione.ts` (§5, §7.2, §8.2) e i test 3, 5, 6;
- E5: route, `esito-fetch.ts`, i18n e test 7;
- E6: `aruba-lettura.mjs` (§10, con finestra corretta, attività e API), `numerazione-serie` (Q6, P7 su `rif`) e test 9;
- E7: `fatture-orfane` (predicato dal modulo, parità a ogni lancio) e test 8.

Il critico F1 rompe apposta: il circuito, la finestra a :05, il controllo positivo della P7, il confronto con `HEAD`, il predicato «zero righe».

**Fasi successive:**
- Fase 2: indagine. Critico F2.
- Fase 3: contatori, solo con P6 falso. Critico F3.
- Fase 4: `fk-utenti`, PRD, gate. Critico F4.
- Fase 5: rilascio, passi 1-11.
- Fase 6: orfane, passi 12-13. Il critico F6 riconta e rilegge `registro_modifiche`.
- Fase 7: PR-D1b, passi 14-15.

---

## 15. Cosa D1 espone agli altri componenti

- **D2:**
  - `PREDICATO_SQL_PARTITA_NON_REGISTRATA` e `CODICI_SDI_SCARTO_REGISTRO`, da portare in `fatture_coda_accoda` (richiesta 1);
  - l'uguaglianza per il lock specchio (richiesta 4);
  - la nuova soglia di `fk-utenti` dopo la PR-D1: T1 va oltre (C§4).
- **D3:**
  - `vincoloDelRifiuto`, per `doppia_emissione`;
  - il motivo `partita_non_registrata` (409, prima di qualunque numero);
  - la guardia a 50 col warn sotto soglia, da conservare;
  - l'aggregato di §5.3, che S51 estende.
- **D4:** `fatturaPartitaNonRegistrata(pag, righe)` con **tutte** le righe, e `MOTIVO_PARTITA_NON_REGISTRATA`, nel pre-controllo e in «rimetti».
- **D6:** il mini-lock del test 1b resta verde dopo la PR-B.
- **Script di F23:** `guardiaArubaPerScript()` (§10.6).
- **Tutti:** la sequenza di C§20, passo 1.

---

## 16. PRD (`PRD REGISTRO ELETTRONICO.md`)

**PR-D1:** un blocco in testa ai changelog, «Il vincolo per sede, il salto FPR 2154→2516 e le fatture partite ma non registrate — 2026-09-2x». Solo numeri. Contiene:
- i fatti del §2, compresi §2.6, §2.7 e §2.9;
- P0-P7 con `rif`, e la conclusione;
- prospetto e contatori;
- guardia a 50, log e aggregato;
- la migrazione e chi la applica;
- il 409 e il predicato a fonte unica;
- gli script e le guardie: coda, circuito, cancello, finestra, attività, 429;
- gli advisors non eseguibili (MCP supabase non autenticato, V anche in questa sessione).

Riga P3: «numerazione unica per (sezionale, anno)».

**PR-D1b:** esito delle orfane, `VERSION` e istante del check Supabase.

---

## Appendice A — Query di sola lettura

- **Contatori:** `select sezionale, anno, ultimo_numero, aggiornato_il from public.fatture_numerazione_sezionale`.
- **Orfane:** `select count(*) from public.pagamenti p where <PREDICATO_SQL_PARTITA_NON_REGISTRATA>`, testo esatto in §8.1.
- **Cronologia:** `select sezionale, numero, sdi_stato, creato_il, left(scuola_id::text,8) from public.fatture_emesse where anno=2026 and creato_il >= '2026-09-17' order by creato_il`.
- **Buchi:** `lag(numero) over (partition by sezionale order by numero)`.
- **Scorrimenti:** `select creato_il, contesto->'campi'->>'ricevuti', contesto->'campi'->>'totale_dichiarato' from public.app_log where evento='fattura' and contesto->'campi'->>'esito'='scorrimento-concluso'`.
- **Vincolo:** `select count(*) from pg_constraint where conname='fatture_emesse_scuola_id_anno_numero_key'`.
- **Coda:** `select to_regclass('public.fatture_coda_invii'), to_regclass('public.fatture_coda_stato'), to_regclass('public.aruba_cancello')`.
- **Cron:** `select jobname, schedule from cron.job where jobname like 'fattur%'`.
- **Attività dell'app:** la prima lettura del §10.1.
- **Scartate (§2.7):** conteggi con e senza una riga `sdi_stato in (2,4,9)`, e senza righe; poi `bool_or(esito like 'numerazione-non-allineabile-%')`.
- **Esiti di D1:** `select contesto->'campi'->>'esito', livello, count(*), max(creato_il) from public.app_log where evento='fattura' and (… like 'registro-%' or … like 'pavimento-%' or … = 'partita-non-registrata-fermata') group by 1,2`.
- **RPC:** `position('GREATEST' in pg_get_functiondef('public.prossimo_numero_fattura_sezionale(text,int,int)'::regprocedure))`.
- **Migrazioni:** `select version, name, created_by from supabase_migrations.schema_migrations where version >= '20260905'`.
- **Ruolo della CLI:** `select current_user, (select rolbypassrls from pg_roles where rolname=current_user)`.

## Appendice B — Replica a mano della P7 (zsh, argomenti in array, riferimento `rif`)

```
P=(src/lib/aruba src/lib/fatturazione src/app/api/pagamenti/fattura src/lib/pagamenti/lotto-fatture.ts src/lib/pagamenti/fatturazione-riga.ts supabase/migrations/20260809235620_fatture_numerazione_sezionale.sql)
gh api 'repos/erricoluigi17/kidville-web/deployments?per_page=40' \
  --jq '.[]|select(.environment|test("(?i)production"))|[.sha[0:8],.created_at]|@tsv'   # rif = il più recente (oggi 29bb04c7)
RIF=29bb04c7
git merge-base --is-ancestor $RIF HEAD; echo $?            # atteso 0
git log -1 --format='%h %cI' $RIF -- "${P[@]}"             # atteso 9a30ff67 2026-09-16T15:42:11+02:00 (NON vuoto)
git diff --quiet 9a30ff67~1 $RIF -- "${P[@]}"; echo $?     # CONTROLLO POSITIVO: atteso 1
git diff --quiet 9a30ff67 $RIF -- "${P[@]}"; echo $?       # atteso 0 (J1, J2)
git diff --quiet 29bb04c7 $RIF -- "${P[@]}"; echo $?       # atteso 0 (J3, J4)
```

Due forme vietate:
- `P="…"` con `$P` senza virgolette: in zsh dà 0 su qualunque diff (V, v5);
- `HEAD` al posto di `$RIF` sul branch: i percorsi li modifica la PR-D1 stessa (V, §0.2 a).


## File toccati

| Percorso | Azione | Motivo |
|---|---|---|
| `/Users/lerri/kidville-web/supabase/migrations/<VERSION>_fatture_emesse_senza_vincolo_numero_per_sede.sql` | crea | PR-D1. Il blocco DO fa da guardia: i due indici giusti devono esserci e le righe senza sezionale devono essere 0. Poi DROP CONSTRAINT IF EXISTS fatture_emesse_scuola_id_anno_numero_key e COMMENT ON INDEX. Il testo non contiene la parola 'unique' né righe che iniziano con 'scuola_id uuid'. VERSION è l'istante UTC reale della scrittura, maggiore di 20260920124744 e di ogni generato_alle. La applica l'integrazione Supabase al merge (C F1). |
| `/Users/lerri/kidville-web/__tests__/db/fatture-emesse-senza-vincolo-per-sede.test.ts` | crea | Test su PGlite sul file vero: il difetto prima, la sua scomparsa dopo, i due indici che restano attivi, l'idempotenza, le guardie del DO e i controlli testuali. In PR-D1b si aggiunge il mini-lock «la correzione è in produzione» (test 1b). |
| `/Users/lerri/kidville-web/__tests__/fixtures/fk-utenti-snapshot.json` | rigenera | PR-D1, prima del merge e dopo aver scritto la migrazione: tracce-docente-dichiarate.test.ts:153-158 segnala 'drop constraint'. Il contenuto resta invariato (56 FK, stesso sha256); cambia solo generato_alle, che supera VERSION e alza la soglia di T1 della coda (C§4). |
| `/Users/lerri/kidville-web/__tests__/fixtures/migrazioni-applicate-snapshot.json` | rigenera | Solo in PR-D1b, dopo il merge e dopo le orfane: le voci passano da 179 a 184 (20260920001032, 20260920124742, 20260920124743, 20260920124744 e VERSION). |
| `/Users/lerri/kidville-web/__tests__/fixtures/indici-unici-snapshot.json` | rigenera | Solo in PR-D1b: sparisce fatture_emesse_scuola_id_anno_numero_key; ogni altra differenza va spiegata. |
| `/Users/lerri/kidville-web/src/lib/fatturazione/vincolo-registro.ts` | crea | Modulo puro con vincoloDelRifiuto: classifica un 23505 come pagamento-quota, numero-serie, numero-per-sede o ignoto. D3 lo riusa per l'anomalia doppia_emissione (C§8.5). |
| `/Users/lerri/kidville-web/__tests__/lib/fatturazione/vincolo-registro.test.ts` | crea | Prova i 4 vincoli, letti sia da message sia da details; un codice diverso da 23505 dà null. |
| `/Users/lerri/kidville-web/src/lib/pagamenti/fattura-partita-non-registrata.ts` | crea | È la fonte unica del predicato (rilievo 1). Contiene fatturaPartitaNonRegistrata, MOTIVO_PARTITA_NON_REGISTRATA, CODICI_SDI_SCARTO_REGISTRO (ricavato da mapStatoAruba, oggi [2,4,9]) e PREDICATO_SQL_PARTITA_NON_REGISTRATA (gemello SQL, alias p). Gli script lo importano con risolvi-ts.mjs, D4 lo usa nel pre-controllo, D2 lo porta in fatture_coda_accoda (richiesta 1). |
| `/Users/lerri/kidville-web/__tests__/lib/pagamenti/fattura-partita-non-registrata.test.ts` | crea | Tabella di verità a 8 casi, con controllo negativo. Parità fra TS e SQL su PGlite, con la sola scartata di un altro file e il file nullo; negativo: la forma «zero righe» è rossa. Lista di scarto uguale al WHERE di fatture_emesse_pagamento_quota_uidx (20260809235620:167-169). |
| `/Users/lerri/kidville-web/src/lib/aruba/emissione.ts` | modifica | PR-D1. SCARTO_MASSIMO_PAVIMENTO passa a 50 (:396), con commento. Messaggio nuovo e campo salto (:2144-2173). Warn pavimento-sopra-contatore prima della RPC. pavimento e contatore_prima su inviata (:2531-2539) e sulle righe registro-*. Ramo del 23505 distinto per vincolo, con pagamento_id (:2478-2519). Il select di :809 aggiunge fattura_stato e fattura_aruba_id. 409 partita_non_registrata fra :1393 e :1395; motivo nuovo nell'unione di :201-218. L'aggregato non scrive più scartata quando tutte le quote si fermano per numerazione (:2553-2560, S27). |
| `/Users/lerri/kidville-web/__tests__/lib/aruba/emissione-registro-rifiutato.test.ts` | crea | Prova i quattro rami del 23505: esiti, testi, pagamento_id e campi numerici. 'DOPPIA' compare solo sull'indice per quota. |
| `/Users/lerri/kidville-web/__tests__/lib/aruba/emissione-partita-non-registrata.test.ts` | crea | Il 409 non fa partire né signin, né RPC, né upload, né INSERT, né UPDATE di pagamenti. Copre il caso della sola riga scartata di un altro file, più quattro controlli negativi. |
| `/Users/lerri/kidville-web/__tests__/lib/aruba/pavimento-implausibile.test.ts` | modifica | Il finto ora registra gli update e sa far fallire la RPC. Casi: il reale 2515 contro 2154, fermato senza UPDATE di pagamenti; RPC fallita senza UPDATE; confine 50/51; warn con salto 3; nessun warn con salto 0. Chi rompe ripara (C§0 punto 2). |
| `/Users/lerri/kidville-web/src/app/api/pagamenti/fattura/route.ts` | modifica | Costante locale CODICE_PARTITA_NON_REGISTRATA e ramo 409 con codice, accanto a :446-475. Vale fino al 410 di D4 nella PR-A. |
| `/Users/lerri/kidville-web/src/app/api/pagamenti/fattura/lotto/route.ts` | modifica | Costante locale; codice aggiunto nella spread di fallite.push (:379-384), dato che RigaEsito.codice esiste già a :148. Il 409 non ferma il lotto. |
| `/Users/lerri/kidville-web/__tests__/api/fattura-route.test.ts` | modifica | Aggiunge il caso 409 col codice FATTURA_PARTITA_NON_REGISTRATA. |
| `/Users/lerri/kidville-web/__tests__/api/fattura-lotto.test.ts` | modifica | Sul 409 compare fallite[].codice, e il lotto prosegue. |
| `/Users/lerri/kidville-web/src/lib/ui/esito-fetch.ts` | modifica | FATTURA_PARTITA_NON_REGISTRATA entra in CODICI_ERRORE (:72) e in CODICI_CON_DETTAGLIO (:2811). |
| `/Users/lerri/kidville-web/messages/it/shared.json` | modifica | Chiave erroreFatturaPartitaNonRegistrata. |
| `/Users/lerri/kidville-web/messages/en/shared.json` | modifica | Chiave erroreFatturaPartitaNonRegistrata, per la parità dei cataloghi. |
| `/Users/lerri/kidville-web/scripts/lib/aruba-lettura.mjs` | crea | Sola lettura su Aruba: signin, involucro, getByFilename, openssl, pausa di 5 s, stop al primo 429 con l'orario +60'; processi figli con execFileSync. Esporta l'API stabile guardiaArubaPerScript (rilievo 3), valutata prima di ogni chiamata. Guardie, tutte fail-closed: coda sospesa, circuito chiuso, cancello libero, finestra della sync corretta (58-05 e 28-35, dall'orologio del DB), nessuna attività dell'app verso Aruba negli ultimi 10' letta da app_log. |
| `/Users/lerri/kidville-web/scripts/lib/numerazione-serie.mjs` | crea | Funzioni pure: parser con test di parità, classificazione (anche dal giornale), buchi, attribuzione dei salti, doppioni, obiettivo del contatore, SQL a confronto-e-scambio, prospetto. Per la P7: argomentiGit, deployAttivoAl e verdettoP7, che confronta con rif (il deploy di produzione, antenato di HEAD) e mai con HEAD, col controllo positivo obbligatorio. |
| `/Users/lerri/kidville-web/scripts/numerazione-serie.mjs` | crea | Indagine in sola lettura con P0-P7; la P7 la fa lo script via git e gh contro rif, senza shell. Uscite 0, 1 o 2. --allinea mostra, poi applica, con audit 'sistema'. Legge fatture_coda_invii se esiste (S27). Le orfane si trovano col predicato importato dal modulo TS. |
| `/Users/lerri/kidville-web/__tests__/lib/numerazione-serie.test.ts` | crea | Casi: parità del parser; J0-J4; salto non spiegato; doppioni; obiettivo col giornale; confronto-e-scambio; verdettoCodaPerScript; finestra corretta (:05 e :35 bloccati, :06 e :36 liberi, con negativo sulla finestra della v5); verdettoAttivitaApp; ordine delle guardie; 429; verdettoP7 con prova cieca, rif non antenato e negativo su HEAD; deployAttivoAl sui deploy reali. |
| `/Users/lerri/kidville-web/scripts/lib/fatture-orfane.mjs` | crea | Funzioni pure: estraiCampiXml, accoppiaOrfane (con la parità SQL/TS per voce), risolviIntestatario, componiInsert (creato_da NULL = sistema, emessa_da nell'audit, clausola sul giornale), maschera, fuoriDalRepository. |
| `/Users/lerri/kidville-web/scripts/fatture-orfane.mjs` | crea | Scoperta col PREDICATO_SQL importato via risolvi-ts.mjs, ricontrollato col predicato TS. Tutte le letture da Aruba prima di qualunque scrittura. XSD, controlli a-h, esclusione delle voci con invii della coda. Stampa mascherata, poi applicazione atomica. Solo dopo il merge, con guardiaArubaPerScript. |
| `/Users/lerri/kidville-web/__tests__/lib/fatture-orfane.test.ts` | crea | Funzioni pure e INSERT su PGlite con WORM e visibilità: idempotenza, precondizioni, vincolo per sede riconosciuto. Una voce con un invio della coda, o con SQL e TS in disaccordo, è DA DECIDERE. Nessun letterale del predicato in scripts/**. |
| `/Users/lerri/kidville-web/PRD REGISTRO ELETTRONICO.md` | modifica | PR-D1: changelog (fatti §2 con §2.6, §2.7 e §2.9; P0-P7 con rif; prospetto; contatori; guardia; aggregato; migrazione e chi la applica; 409 e predicato a fonte unica; script e guardie) e riga P3. PR-D1b: esito delle orfane e check Supabase. |

## Rischi

- WORM: una riga registrata male in fatture_emesse è permanente. Mitigazioni: sola lettura di default, controlli a-h, XSD, --solo sulla prima voce, precondizioni dentro la WHERE, solo orfane «pure»; le altre sono DA DECIDERE. Ogni voce su cui il predicato SQL e quello TS non concordano è DA DECIDERE, con uscita 2.
- Fino al merge il difetto resta attivo, perché la segreteria continua a emettere (decisione 24): nascono altre orfane, che lo script registra tutte dopo il merge. Fino al deploy le protegge solo l'interfaccia; il 409 arriva col deploy.
- Causa organizzativa (H1): se confermata, i buchi si ripeteranno finché chi usa il pannello Aruba non numera per serie. Il codice sa solo fermarsi oltre 50 e avvisare sotto soglia.
- La guardia a 50 può fermare una serie in orario di lavoro, senza consumare numeri, e allora serve l'admin con --allinea. Dopo la coda occorrono «Sospendi coda» e la guardia del §10 a ok; nel frattempo la coda ripete riprova numerazione_anomala con pausa di 15' (C§8.2). Prima del merge si verifica pavimento − contatore ≤ 50 su entrambe le serie.
- Buchi fiscali già prodotti (FPR 2155-2514 e i minori): non si riempiono, li giustifica il commercialista col prospetto.
- Possibili doppioni (H3): serve una nota di variazione, e la coda non si accende finché il titolare non ha deciso.
- app_log si conserva 30 giorni: le prove del 16-22/09 spariscono fra il 16 e il 22/10. Lo script le salva in --out; l'uuid di chi aveva emesso le orfane si perde se lo script non gira prima.
- Se l'integrazione Supabase non applicasse la migrazione, lo scoprono i passi 7 e 8 del §13. Si corregge con una PR, mai a mano; il codice è compatibile con entrambi gli stati.
- ship-cycle.md:348-352 indica ancora apply_migration dopo il merge. D1 lo vieta nella procedura ma non modifica quel file, che non è suo.
- Scrivere con supabase db query --linked (postgres, BYPASSRLS) non è mai stato provato: il primo uso è la prima orfana, con --solo.
- Il DB E2E della CI conserva per sempre il vincolo per sede (niente migrate-ci). Oggi non ha effetti (V); un E2E futuro con Asilo N e FPR N nella stessa sede riceverebbe un 23505.
- Finché il contratto non fissa il predicato (richiesta 1), l'accodamento SQL di D2 potrebbe usare «zero righe». Non c'è doppia emissione: il 409 in emettiFatturaPagamento resta l'ultima difesa. Oggi le due forme danno lo stesso 6.
- I 4 pagamenti 'scartata' senza documento restano tali. Con S51 entrano come prima_emissione, in fondo al FIFO; D1 non li riscrive.
- Gli script chiamano Aruba fuori dal cancello (S28). Restano scoperti: un'emissione che parte fra due controlli, entro circa 5 s più il ritardo di after(); limiti per IP (HANDOFF:54-56); portata del TTL non documentata. Mitigazioni: 1 signin, pausa di 5 s, stop al primo 429, nessun upload, guardie di coda, circuito, cancello, finestra e attività.
- La guardia sull'attività dell'app può tenere fermo lo script per decine di minuti durante un lotto lungo o dopo ogni sync. Lo script esce con 1 e l'orario, senza scritture a metà: si rilancia dopo.
- Dopo un 429 dello script il circuito del DB non si apre, perché gli script non scrivono sulla coda. Se un admin riprende la coda prima dei 60' indicati, è la coda a ricevere il 429 e ad aprire il circuito: un'ora di ritardo in più (decisione 16).
- Uno stop di numerazione su un pagamento multi-quota con motivi misti scrive ancora scartata fino alla PR-A, dove vale S51.
- La P7 si fida dell'elenco dei deploy di produzione di GitHub. Un deploy di produzione mancante, con file diversi e in mezzo a due deploy identici, darebbe un «vero» indebito: è molto improbabile, ma non si può escludere. Il controllo positivo e il confronto con rif coprono solo le prove cieche e i codici diversi.
- Il nuovo generato_alle di fk-utenti dopo la PR-D1 alza la soglia che T1 della coda deve superare (C§4): i file della coda datati prima vanno rinominati prima del merge della PR-A.
- Advisors non eseguibili: l'MCP supabase non è autenticato nemmeno in questa sessione. Si ricorre all'analisi del testo; la migrazione non crea tabelle, funzioni né policy.
- Dati personali: XML e SQL delle orfane contengono nomi e CF. Stanno solo in --out, fuori dal repo, con permessi 0600, e si cancellano in uscita; a terminale sono mascherati; sender e receiver di Aruba si scartano prima di salvare.
