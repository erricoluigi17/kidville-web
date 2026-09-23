# Scomposizione in fasi e compiti
Ogni fase è un Workflow: compiti in parallelo con file disgiunti, poi un critico.

## Registro C0 · Correzioni dell'ultimo critico della scomposizione (23/09)

Chiude i 16 rilievi della sezione «Ultimo critico della scomposizione» di rilievi-residui.md. [V] = verificato nel codice o nei documenti a HEAD 29bb04c7; [D] = dedotto. Ogni correzione porta la sua sigla C0-n anche nel punto del testo che cambia.

| Sigla | Rilievo | Cosa cambia | Dove |
|---|---|---|---|
| C0-1 | Rossi committati e non dichiarati | L'elenco dei rossi dichiarati delle CONVENZIONI diventa chiuso e completo: si aggiungono i casi di R1-1.4 (fino a R1-F2) e i test di R1-1.7-1.9 (fino a R1-F2). In R2B nessun rosso si committa: R2B-F1a non fa commit, i suoi rossi transitori (tracce-docente-dichiarate.test.ts:100, prova gemella di soglia-fotografia, isolamento-sede-coverage [D]) finiscono in $LAVORO/r2b-rossi-f1a.txt, e il critico di R2B-F1b fa un solo commit a tutto verde | CONVENZIONI; critici di R1-F1a, R1-F1b, R2B-F1a e R2B-F1b |
| C0-2 | tracce-docente.test.ts senza proprietario | Il file va a R2B-1.9, nei file e nella VT (→ 3). Oggi 56/44/12 [V, :114, :120, :130]; con 5 voci (2 pesano, 3 no) diventano 61/46/15 [D] | R2B-1.9 |
| C0-3 | Filtro di vitest per sottostringa | [V] cli-api.BK8pd4xc.js:10869 (`testFile.includes(f)`). Nelle VT a N esatto la cartella si scrive `__tests__/lib/aruba/` con la barra finale. R1-2.1 torna a 32 (28 file oggi [V] + 2 di R1-F1b + 2), R2A-2.5 a 34. Regola aggiunta alle CONVENZIONI | R1-2.1, R2A-2.5, 3.4, 4.8, 5.5, 8.2, CONVENZIONI |
| C0-4 | errori-con-codice in parallelo con la dichiarazione dei codici | Tolto dalla VT di R2A-3.11 e spostato nel critico di R2A-F3, dopo 3.11 e 3.13. R2A-6.9 dichiara che FATTURA_EMISSIONE_SOLO_IN_CODA è uno dei 15 di CHIAVI_MESSAGGIO_CODA (contratto.md:614 e :634 [V, righe rilette dopo C0-19]), messo da 3.13, e aggiunge errori-con-codice alla VT (→ 5) | R2A-3.11, critico di R2A-F3, R2A-6.9 |
| C0-5 | Chiavi i18n: 6.10 dipende da 6.15, e nessun proprietario del catalogo da F3 a F5 | Nuovo compito sequenziale CHIAVI-<fase> (CONVENZIONI), dopo i compiti paralleli e prima del critico, in R2A-F3, F4, F5 e F6b (in F6b dopo 6.15). 6.10 e 6.15 non si passano più chiavi fra loro | CONVENZIONI, critici di R2A-F3, F4, F5, F6b, R2A-6.10, 6.15 |
| C0-6 | Componenti montati altrove | R2A-3.20: fuori dal provider useContatoreCoda restituisce {disponibile:false} senza lanciare e senza fetch, con un caso di test e un controllo negativo; più i 3 test che leggono admin/layout come testo [V]. R2A-5.10: i 4 test che montano la navigazione senza provider [V]. R2A-6.12: importi-euro-italiani [V]. R2A-6.13: schede-alunno-a11y e legami-familiari-ui-cablaggio [V]. Tutti «solo se rossi» e nella VT. Nessuno di questi file è posseduto da un altro compito [V, grep sul piano] | R2A-3.20, 5.10, 6.12, 6.13 |
| C0-7 | Modelli haiku con la CLI sul DB di produzione | R1-9.2, R2A-14.1, 14.3, 14.4, R2V-1.4 e R2V-2.4 passano a sonnet. La regola «Modelli» delle CONVENZIONI ora conta lo strumento: ogni `supabase db query --linked`, ogni script con --applica o --allinea e la sospensione vanno a sonnet o opus. Nessun altro compito haiku tocca il DB [V, scansione del piano] | intestazioni di quei compiti, CONVENZIONI |
| C0-8 | Casi CR1 di rimetti mancanti | R2A-6.2 prova PARTITA_NON_REGISTRATA su rimetti di una voce senza invii con la fixture di R1-1.3 (casi veri 2 e 5, falsi 3 e 4), con due prove di rottura. Aggiunta anche al critico di R2A-F6a. Fonte: d2:1214 e d2:753 [V] | R2A-6.2, critico di R2A-F6a |
| C0-9 | Nome RPC incoerente | «segna_scarto_sdi» diventa fatture_coda_segnala_scarto_sdi (contratto.md:160 e :515 [V, righe rilette dopo C0-19]) | R2A-6.1 |
| C0-10 | S35 e lock 9.9 f | Dichiarato l'ambito del lock, quello di D2§11 punto 7 (d2:1114 [V]): src/lib/aruba/** ne sta fuori per costruzione. La coerenza dei letterali dello strato Aruba la prova tsc, tramite i tipi importati con `import type` [D]. Controllo positivo contro il lock cieco (file scanditi > 0 per glob, letterale finto → rosso) | R2A-9.9 f |
| C0-11 | QUOTA_ORARIA in F4 senza la parte B | Il caso esce da R2A-4.5 (solo prossima e prendi) ed entra in R2A-5.2 (fase F5, con aruba_cancello_prenota) | R2A-4.5, R2A-5.2 |
| C0-12 | Nessun fetch fail-closed negli script di R1 | test/setup.ts:82-113 blocca solo l'host Supabase [V]. R1-1.5, 2.3 e 2.4 fanno `vi.stubGlobal('fetch')` con un finto che lancia su ogni URL non previsto | R1-1.5, 2.3, 2.4 |
| C0-13 | La ricerca di R2A-7.3 non vede l'import dinamico | `grep -rn "lotto-fatture'" src __tests__ e2e` (7 righe oggi [V], compreso tetto-orario-aruba.test.ts:155). Aggiornati anche i FATTI VERIFICATI | R2A-7.3, Note |
| C0-14 | 151 → 160 ambiguo | Si contano i file .test.ts: 150 → 159 (151 voci, una è soglia-fotografia.ts [V]), col comando scritto | R2A-11.3 |
| C0-15 | VT di R2A-10.1 troppo stretta | LOCK-MIGR completo (9) al posto dei 3 lock | R2A-10.1 |
| C0-16 | Arresto d'urgenza mai verificato in produzione | R2A-14.2: to_regprocedure della firma (uuid,text) [D, da contratto.md:509], poi has_function_privilege col current_user della CLI registrato da R1-0.2; se è false, STOP prima di R2V-F1 | R2A-14.2 |

### Seconda passata del critico di C0 (23/09)

[V] = riletto nei file di questa cartella dopo le correzioni; [D] = scelta. Il contratto registra le stesse decisioni in C0.5.

| Sigla | Rilievo | Cosa cambia | Dove |
|---|---|---|---|
| C0-17 | [grave] Default 3 (numero conteso) irrealizzabile nello schema | Meccanica scritta nel contratto (C0.5 n. 1): `invio_ricerca(non_combacia)` porta `da_ritentare`/`incerta` a `bruciata numero_conteso`; `_tentativo_chk` riscritto; `incerta → in_volo` solo con `assente`; `numero_bruciato` rifiuta `numero_conteso`; `chiudi('errore','numero_conteso')` con effetto proprio. Compiti: R2A-3.1/3.2 (CHECK e trigger), R2A-5.1/5.3/5.4 (RPC e test), R2A-5.6 (Tab. C e procedura di D3) | R2A-3.1, 3.2, 5.1, 5.3, 5.4, 5.6 |
| C0-18 | [grave] Default 1-3 non applicati, Q1/Q2 ancora poste coi default opposti | Q1 e Q2 tolte da R1-16.2 e dalle Note: i default sono approvati (contratto C0.2). R2A-4.20 senza ramo «Rimanda» su `numero_conteso`; R2A-6.1 `togli` col default D1 e `richiedi_verifica` senza eccezioni; default D2 in R2A-4.2/4.3; `azioni.togli` in R2A-4.12; E2E E20 ed E21 in R2A-9.14 (13 → 15 test); `numero_conteso` in CODICI_ERRORE e fuori da CODICI_AVVISO_VERIFICA_MANUALE in R2A-1.1 | R1-16.2, Note, R2A-1.1, 4.2, 4.3, 4.12, 4.20, 6.1, 6.2, 9.14 |
| C0-19 | Rimandi [V] vecchi del Registro C0 | C0-4 e C0-9 puntano alle righe di oggi; la frase di R2A-1.1 sui 59 codici è corretta (C§8.2 ne elenca 59, `giornale_non_aperto` compreso [V, conteggio sul testo]) | C0-4, C0-9, R2A-1.1, R2A-6.1 |
| C0-20 | Nomi divergenti | Esito info `scarto-solo-chi-ha-accodato` (contratto C0.1 m3) in R2A-2.3, R2A-6.5, R2A-9.8 e Note; niente `ESITO_LOG_CANCELLO` in R2A-2.3 (C0.1 m6); battito della pulizia con `_fatture_coda_log(…, p_fingerprint)` in R2A-4.2 (C0.1 G4) | R2A-2.3, 4.2, 6.5, 9.8, Note |
| C0-21 | Default 4: la ripresa | Il critico di R2V-F1 analizza, ma **non** chiama mai `fatture_coda_riprendi`: la ripresa è del titolare da admin (contratto C0.2 D4, §9.4) | R2V-F1 |

Correzione di passaggio, non chiesta dal critico: il critico di R2A-F5 diceva «4 test SQL di R2A-F4 + 3 → 7», ma quello di R2A-F4 ne esegue 5 (schema compreso). Ora dice 5 + 3 → 8.

Nessun rilievo respinto.

## R1-F0 · Avvio: branch e cartella di lavoro

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Creare il branch di R1 da main aggiornato, creare la cartella di lavoro fissa $LAVORO fuori dal repo e fotografare in sola lettura i numeri di partenza della produzione.
- **Dipende da:** —
- **Critico (sonnet/high):** Confronta r1-base.json con D1§2.2 e C F2. STOP di R1, con rapporto al direttore prima di R1-F1a, se: le orfane non sono 6; c'è una riga senza sezionale; c'è un doppione (sezionale, anno, numero).
Controlla anche:
- che nessuna query abbia letto colonne personali;
- che $LAVORO stia fuori dal repo, con permessi 700.
Nessun commit: nessun file del repo è stato toccato.

### R1-0.1 · Branch fix/fatture-vincolo-numero-per-sede — sonnet/low

AGENTS.md §1. Dalla radice:
- `git fetch origin`, `git switch main`, `git pull --ff-only`;
- se `git status --short` non è vuoto: STOP e rapporto, niente stash del lavoro di altri;
- poi `git switch -c fix/fatture-vincolo-numero-per-sede`.
Nessun commit, nessun push.

- **File:** —
- **Verifica:** `git branch --show-current` → fix/fatture-vincolo-numero-per-sede; `git rev-parse HEAD` uguale a `git rev-parse origin/main`; `git status --short` vuoto.
- **Perché questo modello:** Cambia lo stato di git: non è una verifica banale, quindi niente haiku (rilievo 9b).

### R1-0.2 · Cartella $LAVORO e fotografia numerica di partenza (sola lettura) — sonnet/medium

$LAVORO è il percorso assoluto fissato dall'orchestratore (note, CONVENZIONI).
1. Controlla che non stia sotto /Users/lerri/kidville-web: se ci sta, STOP. Poi `mkdir -p -m 700 $LAVORO`.
2. Dalla radice, con `supabase db query --linked`, esegui le query dell'Appendice A di D1:
   - contatori di fatture_numerazione_sezionale e massimi a registro 2026 per serie;
   - count del vincolo fatture_emesse_scuola_id_anno_numero_key (atteso 1);
   - ultima version di supabase_migrations.schema_migrations (atteso 20260920124744);
   - to_regclass di fatture_coda_invii, fatture_coda_stato e aruba_cancello (attesi NULL);
   - cron.job con jobname like 'fattur%';
   - current_user e rolbypassrls;
   - orfane col predicato CR1 (testo in R1-1.3) e con la forma D1 v6 (attesi 6 e 6);
   - pagamenti scartata+pagato con e senza una riga sdi_stato in (2,4,9) (attesi 7 e 4).
3. Nell'output solo aggregati, uuid e numeri: mai nomi, CF o testo libero. Salva in $LAVORO/r1-base.json con permessi 0600.

- **File:** `$LAVORO/r1-base.json (fuori dal repo)`
- **Verifica:** `stat -f %Lp $LAVORO` → 700; `stat -f %Lp $LAVORO/r1-base.json` → 600; tutti i campi presenti; ogni scostamento da D1§2.2 spiegato nel resoconto.
- **Perché questo modello:** Query precise sulla produzione, con una lettura critica dei numeri; nessuna scrittura.

## R1-F1a · Migrazione, moduli condivisi, guardia degli script (compiti indipendenti)

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Scrivere in parallelo, senza dipendenze reciproche (rilievo 1h):
- la migrazione col suo test PGlite;
- i moduli puri condivisi (vincolo e predicato CR1, con i 9 casi riusabili);
- la guardia degli script Aruba, con i casi «tabella assente» e «errore di lettura»;
- la libreria pura dell'indagine;
- i test rossi delle route.
- **Dipende da:** R1-F0
- **Critico (opus/xhigh):** Controlla lo stato dei test:
- verdi: 1.1, 1.2, 1.3, 1.5, 1.6;
- rossi: 1.4, solo per asserzioni;
- rosso dichiarato: tracce-docente-dichiarate.

Rompe apposta, su una patch reversibile dei soli file della fase, e ripristina subito dopo. Ogni rottura deve far diventare rosso almeno un test:
- predicato in forma «zero righe» e in forma D1 v6;
- finestra della sync che lascia passare :05;
- guardia che blocca su to_regclass NULL;
- guardia che tratta un 42501 come «non installata»;
- verdettoCodaPerScript senza il controllo del circuito;
- verdettoP7 senza controllo positivo, oppure confrontato con HEAD.

Poi un commit coi soli file della fase: git add per percorso, messaggio che termina con Co-Authored-By. Il messaggio elenca i rossi dichiarati che il commit contiene (C0-1): i casi nuovi di 1.4 e tracce-docente-dichiarate, entrambi nell'elenco chiuso delle CONVENZIONI.

### R1-1.1 · Migrazione senza vincolo per sede, con test PGlite — opus/high

D1§6.1-6.3. Crea supabase/migrations/<VERSION>_fatture_emesse_senza_vincolo_numero_per_sede.sql.
- VERSION = `date -u +%Y%m%d%H%M%S` al momento della scrittura: maggiore di 20260920124744 e di ogni generato_alle in __tests__/fixtures, mai nel futuro. Annotala in $LAVORO/r1-version.txt.
- Contenuto: blocco DO con le tre guardie (indice per serie, indice pagamento-quota, zero righe senza sezionale), `DROP CONSTRAINT IF EXISTS fatture_emesse_scuola_id_anno_numero_key`, COMMENT ON INDEX.
- Testata in italiano: «la applica l'integrazione Supabase al merge della PR-D1», nessun dato toccato. Mai la dicitura «NON APPLICATA».
- Vietati: la parola unique, righe che iniziano con `scuola_id uuid`, policy e RLS, uuid letterali, CASCADE.

Test 1 di D1§12 in __tests__/db/fatture-emesse-senza-vincolo-per-sede.test.ts: `// @vitest-environment node`, modello __tests__/db/fatture-visibilita.test.ts, file della migrazione letto dal disco. Casi:
- prima e dopo;
- indice per serie fra sedi;
- pagamento-quota vivo e scartato;
- doppia esecuzione;
- RAISE delle guardie;
- controlli testuali;
- un controllo negativo.

- **File:** `supabase/migrations/<VERSION>_fatture_emesse_senza_vincolo_numero_per_sede.sql`, `__tests__/db/fatture-emesse-senza-vincolo-per-sede.test.ts`, `$LAVORO/r1-version.txt (fuori dal repo)`
- **Verifica:** VT: __tests__/db/fatture-emesse-senza-vincolo-per-sede.test.ts → 1.
`grep -ci unique <file sql>` → 0.
`grep -cEi 'policy|row level security|cascade|^[[:space:]]*scuola_id[[:space:]]+uuid' <file sql>` → 0.
Rosso dichiarato fino a R1-5.1: tracce-docente-dichiarate, per 'drop constraint'.
- **Perché questo modello:** Migrazione su una tabella fiscale WORM, applicata in produzione dall'integrazione: servono SQL rigoroso e guardie solide.

### R1-1.2 · vincolo-registro.ts con test — sonnet/medium

D1§7.1. Crea src/lib/fatturazione/vincolo-registro.ts, puro e senza import.
- Esporta INDICE_NUMERO_SERIE, INDICE_PAGAMENTO_QUOTA, VINCOLO_NUMERO_PER_SEDE e il tipo VincoloRegistro.
- `vincoloDelRifiuto(err)` ricava il nome del vincolo dal message (la parola constraint seguita dal nome fra virgolette), altrimenti dai details (forma Key seguita dalle colonne fra parentesi).
- Codice diverso da 23505 → null; nome non riconosciuto → ignoto.

Test 2 di D1§12 in __tests__/lib/fatturazione/vincolo-registro.test.ts:
- i 4 vincoli letti sia da message sia da details;
- codice diverso → null;
- un controllo negativo.

- **File:** `src/lib/fatturazione/vincolo-registro.ts`, `__tests__/lib/fatturazione/vincolo-registro.test.ts`
- **Verifica:** VT: __tests__/lib/fatturazione/vincolo-registro.test.ts → 1.
- **Perché questo modello:** Classificatore puro e piccolo, specificato fino alla regex.

### R1-1.3 · Predicato unico «partita non registrata» (CR1), casi condivisi e parità TS/SQL — opus/high

D1§8.1 con CR1. Crea src/lib/pagamenti/fattura-partita-non-registrata.ts.

`fatturaPartitaNonRegistrata(pag, righe)` è vero se fattura_stato è 'in_attesa' e:
- con fattura_aruba_id valorizzato, nessuna riga del pagamento ha aruba_filename uguale a quel file;
- con fattura_aruba_id nullo, nessuna riga è viva (fatturaViva).

Gemello SQL `PREDICATO_SQL_PARTITA_NON_REGISTRATA`, con alias p:
`p.fattura_stato='in_attesa' AND CASE WHEN p.fattura_aruba_id IS NOT NULL THEN NOT EXISTS (riga f del pagamento con f.aruba_filename=p.fattura_aruba_id) ELSE NOT EXISTS (riga f del pagamento con f.sdi_stato IS NULL OR f.sdi_stato NOT IN (lista)) END`.

Altri export:
- CODICI_SDI_SCARTO_REGISTRO, ricavato da mapStatoAruba(c).isScarto per c da 0 a 20;
- MOTIVO_PARTITA_NON_REGISTRATA = 'partita_non_registrata'.

Crea anche __tests__/fixtures/casi-partita-non-registrata.ts, che esporta CASI_PARTITA_NON_REGISTRATA, con dati sintetici e nessun dato personale. R2A-4.4 li riusa per provare, eseguendoli, la parità della funzione SQL della coda (rilievo 11). I 9 casi:
1. file X, nessuna riga → vero;
2. file X, sola scartata col file Y → vero;
3. file X, scartata col file X → falso;
4. file X, viva col file X → falso;
5. file X, viva di un'altra quota e nessuna riga col file X → vero;
6. file nullo, nessuna riga → vero;
7. file nullo, sola scartata con filename nullo → vero;
8. file nullo, riga con sdi_stato nullo → falso;
9. non_richiesta, scartata o emessa senza righe → falso.

Test __tests__/lib/pagamenti/fattura-partita-non-registrata.test.ts:
- tabella di verità sui 9 casi;
- parità TS/SQL su PGlite, caso per caso;
- la lista coincide col WHERE di fatture_emesse_pagamento_quota_uidx (20260809235620:167-169).

Controlli negativi eseguiti come casi: la forma «zero righe» sbaglia i casi 2 e 5; la forma D1 v6 sbaglia il 5; l'unione D2 v4 sbaglia il 3.

- **File:** `src/lib/pagamenti/fattura-partita-non-registrata.ts`, `__tests__/fixtures/casi-partita-non-registrata.ts`, `__tests__/lib/pagamenti/fattura-partita-non-registrata.test.ts`
- **Verifica:** VT: __tests__/lib/pagamenti/fattura-partita-non-registrata.test.ts → 1.
In produzione `select count(*) from public.pagamenti p where <PREDICATO_SQL>` restituisce il valore di r1-base.json (oggi 6).
- **Perché questo modello:** D2 e D4 copiano questo predicato fiscale: un caso sbagliato riapre la doppia emissione.

### R1-1.4 · Test 7: 409 nelle route (rossi) — sonnet/medium

Test 7 di D1§8.3.
- In __tests__/api/fattura-route.test.ts: caso 409 con codice FATTURA_PARTITA_NON_REGISTRATA e data.motivo.
- In __tests__/api/fattura-lotto.test.ts: fallite[].codice sul 409, e il lotto prosegue.
Entrambi mockano emissione.ts (verificato) e restano rossi fino a R1-2.2.

- **File:** `__tests__/api/fattura-route.test.ts`, `__tests__/api/fattura-lotto.test.ts`
- **Verifica:** Ora: VT dei due file → rossi solo sui casi nuovi, per asserzioni.
A fine R1-F2: VT dei due file → 2.
- **Perché questo modello:** Due casi di test su route esistenti, con emissione già mockata.

### R1-1.5 · Guardia degli script Aruba (aruba-lettura.mjs) con test, compresi tabella assente ed errore di lettura — opus/high

D1§10 e §10.6, col rilievo 6. Crea scripts/lib/aruba-lettura.mjs con:
- signin; scorrimento di findByUsername col controllo dell'involucro (client.ts:1141-1166, 1362-1371);
- getByFilename; `openssl cms -verify -noverify`;
- 5000 ms fra due chiamate; stop al primo 429 con messaggio429 (orario + 60');
- rifiuto di un --out dentro il repo;
- processi figli solo con `execFileSync(cmd, args[])`.

API stabile `guardiaArubaPerScript({sql})`, valutata prima di ogni chiamata, in quest'ordine: lettura, coda, circuito, cancello, finestra della sync (minuti 58, 59, 0-5 e 28-35, dall'orologio del DB), attività dell'app negli ultimi 10' (app_log).

Stato della coda, in verdettoCodaPerScript:
- a) to_regclass NULL sia per fatture_coda_stato sia per aruba_cancello → «non installata», prosegue. È il caso di tutto R1;
- b) una sola delle due presente → incoerente → blocco;
- c) seconda lettura fallita con SQLSTATE 42P01 (tabella sparita fra le due letture) → vale «non installata», prosegue con nota;
- d) ogni altro errore (42501, timeout, uscita della CLI diversa da 0 senza SQLSTATE, JSON illeggibile) → blocco;
- e) coda installata: sospesa diversa da true → blocco; circuito aperto → blocco con l'orario; cancello in prestito → blocco; righe diverse da 1 → blocco.
Anche un errore di lettura di app_log blocca.

Test __tests__/lib/aruba-lettura.test.ts: tutti i casi della guardia di D1§12 test 9, più a) che prosegue e d) che blocca.
Finto Aruba fail-closed (C0-12): test/setup.ts:82-113 blocca solo l'host Supabase di produzione [V], e aruba-finto nasce solo in R2A-1.2. Quindi il test fa `vi.stubGlobal('fetch', …)` con un finto che risponde SOLO agli URL previsti dal caso (signin, findByUsername, getByFilename) e LANCIA su qualunque altro URL, Aruba compreso; `vi.unstubAllGlobals()` in afterEach. Un caso lo prova: una chiamata a un URL non previsto fa fallire il test.
Controlli negativi eseguiti:
- una guardia che blocca su to_regclass NULL fa diventare rosso a);
- una guardia che tratta ogni errore come «non installata» fa diventare rosso d);
- la finestra della v5 lascia passare :05 → rosso;
- senza controllo del circuito lo script parte → rosso.

- **File:** `scripts/lib/aruba-lettura.mjs`, `__tests__/lib/aruba-lettura.test.ts`
- **Verifica:** `node --check scripts/lib/aruba-lettura.mjs`; VT: __tests__/lib/aruba-lettura.test.ts → 1.
- **Perché questo modello:** Guardia fail-closed contro i 429 e le sovrapposizioni con la sync: un errore costa un'ora di silenzio da Aruba, oppure blocca per sempre l'indagine e le orfane.

### R1-1.6 · Funzioni pure dell'indagine (numerazione-serie lib) con test — opus/high

Crea scripts/lib/numerazione-serie.mjs, pura e senza import dagli altri moduli di questa fase, con le funzioni di D1§3.3-§4:
- parser delle etichette (copia, con test di parità contro numeroSezionaleDaEtichetta di client.ts);
- classifica (app, orfana, fuori-app, giornale); buchi; attribuisciSalti (J0-J4); doppioni;
- obiettivoContatore: massimo fra Aruba, registro e giornale, coi suoi rifiuti;
- componiAllineamento a confronto-e-scambio (§4.3); prospetto;
- argomentiGit (sempre un array); deployAttivoAl;
- verdettoP7: confronto con rif e mai con HEAD, controllo positivo obbligatorio.

Test __tests__/lib/numerazione-serie.test.ts:
- la parte numerazione e P7 di D1§12 test 9;
- deployAttivoAl sui deploy reali del §2.6.
Negativi: confronto con HEAD; controllo positivo a 0; argomenti git uniti in una stringa.

- **File:** `scripts/lib/numerazione-serie.mjs`, `__tests__/lib/numerazione-serie.test.ts`
- **Verifica:** VT: __tests__/lib/numerazione-serie.test.ts → 1.
- **Perché questo modello:** Logica dell'indagine fiscale e confronto-e-scambio sui contatori.

## R1-F1b · Test rossi dell'emissione e libreria delle orfane

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Scrivere i test in rosso che guidano R1-F2 e la libreria delle orfane. Tutti usano i moduli di R1-F1a, che ormai esistono, così nessun test fallisce per un errore di caricamento.
- **Dipende da:** R1-F1a
- **Critico (opus/xhigh):** Controlla:
- 1.10 verde;
- 1.7, 1.8 e 1.9 rossi solo per AssertionError, senza errori di caricamento.

Rompe su patch reversibile e controlla che 1.10 diventi rosso:
- componiInsert senza la clausola «nessuna riga per il pagamento»;
- maschera che lascia il CF intero.

Poi commit della fase. Rossi dichiarati che il commit contiene (C0-1, elenco chiuso delle CONVENZIONI): 1.7, 1.8, 1.9 (fino a R1-F2), più 1.4 e tracce-docente-dichiarate ereditati da R1-F1a. Il critico di R1-F2 li deve vedere tutti verdi, tranne tracce-docente-dichiarate (fino a R1-5.1).

### R1-1.7 · Test 3: 23505 distinto per vincolo (rosso) — sonnet/high

Crea __tests__/lib/aruba/emissione-registro-rifiutato.test.ts (D1§12 test 3, testi di D1§7.2).

Scenario: un 23505 all'INSERT a registro dopo un upload riuscito, per ciascuno dei 4 vincoli (pagamento-quota, numero-serie, numero-per-sede, ignoto). Per ognuno controlla:
- esito e livello error;
- msg col nome file;
- pagamento_id, pavimento e contatore_prima valorizzati;
- 'DOPPIA' solo sull'indice per quota;
- nessuna 'nota di variazione' sui rami per sede e per serie.

Usa un finto supabase sul modello dei test di __tests__/lib/aruba. Può importare vincoloDelRifiuto (R1-1.2). Resta rosso finché R1-2.1 non cambia emissione.ts, e deve fallire per asserzioni.

- **File:** `__tests__/lib/aruba/emissione-registro-rifiutato.test.ts`
- **Verifica:** Ora: VT del file esce diverso da 0 con «Test Files 1 failed», solo AssertionError, nessun errore di caricamento o SyntaxError.
A fine R1-F2: VT → 1.
- **Perché questo modello:** Test meccanico guidato da una tabella già scritta.

### R1-1.8 · Test 5: 409 partita non registrata (rosso) — sonnet/high

Crea __tests__/lib/aruba/emissione-partita-non-registrata.test.ts (D1§12 test 5, esteso a CR1). Importa MOTIVO_PARTITA_NON_REGISTRATA da @/lib/pagamenti/fattura-partita-non-registrata, già presente.

Caso in_attesa senza righe:
- ok:false, motivo partita_non_registrata, httpStatus 409;
- nessuna RPC, nessun signin, nessun upload;
- 0 INSERT e 0 UPDATE di pagamenti;
- un solo warn partita-non-registrata-fermata.

Altri casi che danno 409: sola scartata di un altro file; riga viva di un'altra quota col file del pagamento assente (CR1).

Negativi:
- riga viva col file → risposta idempotente;
- scartata con lo stesso file → emette;
- non_richiesta o scartata senza righe → emette.

Resta rosso fino a R1-2.1.

- **File:** `__tests__/lib/aruba/emissione-partita-non-registrata.test.ts`
- **Verifica:** Ora fallisce solo per asserzioni.
A fine R1-F2: VT → 1.
- **Perché questo modello:** Test meccanico su casi già enumerati.

### R1-1.9 · Test 6: pavimento a 50 e log (rosso) — sonnet/high

Modifica __tests__/lib/aruba/pavimento-implausibile.test.ts (D1§12 test 6). Il finto registra gli update per tabella e sa far fallire la RPC.

Casi:
- reale 2515 contro 2154: nessuna RPC né upload; esito numerazione_non_allineata; un error pavimento-fuori-scala con salto 361 e la frase 'Avvisa l'amministratore'; nessun UPDATE di pagamenti;
- RPC fallita → nessun UPDATE;
- confine: salto 50 passa, 51 si ferma;
- salto 3 → warn pavimento-sopra-contatore con salto 3; salto 0 → nessun warn;
- il negativo del §5.3.

I casi esistenti restano. Rosso fino a R1-2.1.

- **File:** `__tests__/lib/aruba/pavimento-implausibile.test.ts`
- **Verifica:** Ora rosso solo sui casi nuovi, per asserzioni.
A fine R1-F2: VT → 1.
- **Perché questo modello:** Estende un test esistente con confini già definiti.

### R1-1.10 · Libreria delle orfane (fatture-orfane lib) con test — opus/high

Crea scripts/lib/fatture-orfane.mjs (D1§9):
- estraiCampiXml: tracciato di fatturapa-xml.ts:483-587, entità decodificate, più di un body → rifiuto;
- accoppiaOrfane: parità SQL/TS per voce, con PREDICATO_SQL_PARTITA_NON_REGISTRATA e fatturaPartitaNonRegistrata di R1-1.3; se non concordano → DA DECIDERE;
- risolviIntestatario: casi i-iv;
- componiInsert (§9.3): CTE atomica; tag dollaro casuale, controllato contro i testi; validazioni; creato_da NULL = sistema; in registro_modifiche utente_id NULL, ed emessa_da nell'audit; clausola sul giornale solo se la tabella esiste;
- maschera: CF come ABC…(16), nomi solo come lunghezza;
- fuoriDalRepository.

Test __tests__/lib/fatture-orfane.test.ts:
- funzioni pure, con CF palesemente finti;
- INSERT su PGlite con WORM e visibilità: prima esecuzione 1+1, seconda 0; precondizioni;
- tabella creata col vincolo per sede come nella baseline → «migrazione non applicata»; dopo il file di R1-1.1, letto dal disco → procede;
- testuale: nessun letterale `fattura_stato = 'in_attesa'` in scripts/lib/**.
L'asserzione sulla CLI passa a R1-2.4.

- **File:** `scripts/lib/fatture-orfane.mjs`, `__tests__/lib/fatture-orfane.test.ts`
- **Verifica:** VT: __tests__/lib/fatture-orfane.test.ts → 1, tutto verde.
- **Perché questo modello:** Prepara una scrittura WORM permanente su fatture_emesse, con dati personali da mascherare.

## R1-F2 · emissione.ts, route e CLI testabili

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Implementare:
- 409, tetto 50, log del pavimento, 23505 per vincolo, aggregato;
- codice nelle route;
- le due CLI in forma testabile, con test che provano l'ordine letture → scritture (rilievo 10).
I test rossi di R1-F1 diventano verdi.
- **Dipende da:** R1-F1b
- **Critico (opus/xhigh):** Esegue `npx tsc --noEmit`, che deve dare esito 0 perché l'unione di motivo si chiude fra 2.1 e 2.2.

Rompe su patch reversibile e ripristina subito; i test devono diventare rossi:
- SCARTO_MASSIMO_PAVIMENTO a 10000;
- blocco 409 spostato dopo sessione.token;
- condizione soloStopDiNumerazione tolta;
- ramo pagamento-quota senza 'DOPPIA';
- CLI orfane che scrive prima dell'ultima lettura Aruba;
- CLI che ignora --solo;
- CLI che copia il testo del predicato.

Controlla che nessun nome file finisca nei campi dei log (solo nel msg). Poi commit.

### R1-2.1 · emissione.ts: 409, tetto 50, log del pavimento, 23505, aggregato — opus/xhigh

Modifica src/lib/aruba/emissione.ts. Le righe citate sono quelle di HEAD 29bb04c7: ricontrollale.

D1§5:
- SCARTO_MASSIMO_PAVIMENTO = 50, col commento misurato;
- messaggio all'operatore e campo salto;
- warn pavimento-sopra-contatore prima della RPC;
- pavimento e contatore_prima su inviata e sulle righe registro-*;
- niente scartata quando tutte le quote si fermano con motivo numerazione.

D1§7.2: ramo del 23505 con vincoloDelRifiuto, i 4 esiti coi loro testi, pagamento_id sempre presente.

D1§8.2:
- la select di :809 legge anche fattura_stato e fattura_aruba_id;
- blocco 409 partita_non_registrata fra righeEsistenti e «// 7.», prima di ogni RPC o signin, con fatturaPartitaNonRegistrata(pag, TUTTE le righe);
- il motivo entra nell'unione di EsitoEmissione;
- il ritorno avviene prima dell'aggregato.

Proprietario, in questa fase, di tutti i test esistenti che la modifica rompe (rilievo 2):
- i file di __tests__/lib/aruba, tranne i tre di R1-F1b, che devono diventare verdi senza modifiche (se li ritieni sbagliati, riferisci al critico);
- __tests__/api/fattura-emissione.test.ts e __tests__/api/fattura-emissione-split.test.ts, che chiamano davvero emettiFatturaPagamento (verificato: gli altri test di route lo mockano).

- **File:** `src/lib/aruba/emissione.ts`, `__tests__/lib/aruba/*.test.ts esistenti (solo se rotti; esclusi emissione-registro-rifiutato, emissione-partita-non-registrata, pavimento-implausibile)`, `__tests__/api/fattura-emissione.test.ts`, `__tests__/api/fattura-emissione-split.test.ts`
- **Verifica:** VT: __tests__/lib/aruba/ __tests__/api/fattura-emissione.test.ts __tests__/api/fattura-emissione-split.test.ts → N passed, con N = numero di file .test.ts in __tests__/lib/aruba/ (atteso 30: 28 a HEAD 29bb04c7 [V] più i 2 creati da R1-1.7 e R1-1.8) più 2 = 32. La barra finale è obbligatoria (C0-3): senza, il filtro prende anche __tests__/lib/aruba-lettura.test.ts e misura 33. N si ricava con `ls __tests__/lib/aruba/*.test.ts | wc -l`. In questa fase nessun altro compito scrive in quelle cartelle.
- **Perché questo modello:** Cuore fiscale dell'emissione: ordine rispetto a numero e upload, registro WORM.

### R1-2.2 · Route: 409 con codice, esito-fetch e testi — sonnet/medium

D1§8.3.
- fattura/route.ts: costante locale CODICE_PARTITA_NON_REGISTRATA = 'FATTURA_PARTITA_NON_REGISTRATA' e ramo 409 {error, codice, data:{motivo}} accanto a :446-475. Il confronto sul motivo usa MOTIVO_PARTITA_NON_REGISTRATA importato.
- lotto/route.ts: codice nella spread di fallite.push (:379-384); il 409 non ferma il lotto.
- esito-fetch.ts: FATTURA_PARTITA_NON_REGISTRATA in CODICI_ERRORE (:72) e in CODICI_CON_DETTAGLIO.
- Chiave erroreFatturaPartitaNonRegistrata in messages/it/shared.json e messages/en/shared.json.
L'allowlist errori-senza-codice non si tocca.

- **File:** `src/app/api/pagamenti/fattura/route.ts`, `src/app/api/pagamenti/fattura/lotto/route.ts`, `src/lib/ui/esito-fetch.ts`, `messages/it/shared.json`, `messages/en/shared.json`
- **Verifica:** VT: __tests__/api/fattura-route.test.ts __tests__/api/fattura-lotto.test.ts __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/messaggi-parita-cataloghi.test.ts → 4.
I tipi dell'unione `motivo` li aggiunge R1-2.1: tsc lo lancia il critico.
- **Perché questo modello:** Modifica meccanica di route e cataloghi su un contratto già scritto.

### R1-2.3 · CLI scripts/numerazione-serie.mjs, testabile, con test d'ordine — opus/high

Crea scripts/numerazione-serie.mjs (D1§3.3, §4) in forma testabile.
- `export async function main(argv, deps)`, con deps = {sql, scrivi, aruba, git, gh, guardia, stampa, adesso}.
- In fondo il ramo d'avvio, solo se `import.meta.url === pathToFileURL(process.argv[1]).href`, con deps reali (execFileSync con args[], mai shell).
- Opzioni: --out (fuori dal repo), --anno, --xml-fuori-app, --allinea --serie --a.
- Letture Q1-Q6; Q6 solo se to_regclass('public.fatture_coda_invii') non è nullo.
- Orfane col PREDICATO_SQL importato via scripts/lib/risolvi-ts.mjs (`await import` dopo l'hook).
- P7 automatica contro rif: deploy di produzione da gh api, antenato di HEAD.
- guardiaArubaPerScript prima di ogni chiamata ad Aruba.
- Uscite 0, 1 e 2.
- --allinea: stampa «SCRIVO:» con l'istruzione intera, fa una sola scrittura a confronto-e-scambio (D1§4.3) e rilegge; con 0 righe esce 1 con «rilancia».
- File in --out con permessi 0600; mai CF, nomi, sender o receiver.

Test nuovo __tests__/lib/numerazione-serie-cli.test.ts, con deps finte che registrano l'ordine delle chiamate:
- senza --allinea, zero chiamate a scrivi;
- con --allinea, «SCRIVO:» prima dell'unica scrittura e rilettura dopo;
- 0 righe aggiornate → uscita 1;
- --out dentro il repo → uscita 1 prima di qualunque chiamata;
- guardia prima di ogni chiamata ad Aruba; se nega, uscita 1 senza altre chiamate;
- 429 → stop, parziali salvati;
- git riceve rif e mai HEAD;
- Q6 solo con la tabella presente;
- nessun letterale `fattura_stato = 'in_attesa'` nel file.
Anche qui `vi.stubGlobal('fetch')` con un finto che lancia su qualunque URL (C0-12): le deps sono finte, quindi nessuna fetch vera deve partire; se parte, il test fallisce.
Controllo negativo eseguito: invertendo lettura e scrittura, il test d'ordine diventa rosso.

- **File:** `scripts/numerazione-serie.mjs`, `__tests__/lib/numerazione-serie-cli.test.ts`
- **Verifica:** `node --check scripts/numerazione-serie.mjs`.
VT: __tests__/lib/numerazione-serie-cli.test.ts __tests__/lib/numerazione-serie.test.ts __tests__/lib/aruba-lettura.test.ts → 3.
- **Perché questo modello:** Guida l'indagine fiscale e l'unica scrittura possibile sui contatori.

### R1-2.4 · CLI scripts/fatture-orfane.mjs, testabile, con test d'ordine — opus/high

Crea scripts/fatture-orfane.mjs (D1§9.1) nella stessa forma testabile di R1-2.3: `main(argv, deps)` + avvio guardato.

Guardie:
- --out fuori dal repo; openssl presente; select 1;
- vincolo assente in pg_constraint, altrimenti uscita 1;
- guardiaArubaPerScript.

Flusso:
1. scoperta col PREDICATO_SQL importato via risolvi-ts, più ricontrollo TS per voce;
2. accoppiamento coi log registro-*;
3. voci con un invio della coda (se la tabella esiste) → DA DECIDERE;
4. TUTTE le letture da Aruba prima di qualunque scrittura;
5. controlli a-h, con XSD (__tests__/lib/aruba/valida-xsd.ts);
6. --applica stampa «SCRIVO i/N:», con i dati mascherati, prima di ogni esecuzione da <out>/<pagamento>.sql; --solo fa una voce sola;
7. riconteggio finale.
Uscite 0, 1, 2, 3. File sensibili cancellati in uscita, salvo --conserva.

Test nuovo __tests__/lib/fatture-orfane-cli.test.ts, con deps finte:
- indice dell'ultima chiamata Aruba minore dell'indice della prima scrittura;
- tabella del giornale presente e invio del pagamento → DA DECIDERE, mai scritta;
- --solo <uuid> → esattamente una scrittura, di quel pagamento;
- «SCRIVO i/N:» col CF mascherato prima di ogni scrittura;
- disaccordo SQL/TS → uscita 2, zero scritture;
- vincolo presente → uscita 1, zero scritture;
- --out dentro il repo → uscita 1 prima di ogni chiamata;
- guardia negata → uscita 1, parziali conservati, zero scritture;
- il file importa il modulo del predicato e non contiene il letterale `fattura_stato = 'in_attesa'` (asserzione spostata qui da R1-1.10).
Anche qui `vi.stubGlobal('fetch')` con un finto che lancia su qualunque URL (C0-12): nessuna fetch vera verso Aruba o altrove.
Controllo negativo eseguito: una CLI che scrive dopo la prima lettura Aruba fa diventare rosso il test d'ordine.

- **File:** `scripts/fatture-orfane.mjs`, `__tests__/lib/fatture-orfane-cli.test.ts`
- **Verifica:** `node --check scripts/fatture-orfane.mjs`.
VT: __tests__/lib/fatture-orfane-cli.test.ts __tests__/lib/fatture-orfane.test.ts → 2.
- **Perché questo modello:** Scrive righe WORM permanenti in produzione.

## R1-F3 · Indagine sul salto FPR 2154→2516 (sola lettura)

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Accertare la causa del salto (H1, H2 o H3) con P0-P7, prima di qualunque correzione dei contatori.
- **Dipende da:** R1-F2
- **Critico (opus/max):** Applica la tabella di D1§3.5 e dichiara la causa.
- H2, un doppione o P0 falso → STOP di R1 e rapporto al titolare. Con un doppione la coda non si accende finché il titolare non ha deciso.
- Verifica che pavimento − contatore sia ≤ 50 su entrambe le serie.
- Decide se R1-F4 deve scrivere: solo con P6 falso.
- Verifica che il prospetto stia in $LAVORO e che nulla di sensibile sia uscito dalla cartella.

### R1-3.1 · Esecuzione dell'indagine P0-P7 — opus/max

D1§3.
- Lancia `node scripts/numerazione-serie.mjs --out $LAVORO/indagine-r1 --xml-fuori-app` dalla radice del branch, prima delle 08:00 o dopo le 18:30 Europe/Rome. La guardia blocca comunque.
- Se esce 1 per una guardia (attività dell'app, finestra della sync, coda), riprova dopo l'orario indicato, al massimo 3 volte.
- Riporta: P0-P7, codice d'uscita, rif, pavimento − contatore per serie, documenti fuori app per finestra.
Niente nomi o CF a terminale; nessun upload.

- **File:** `$LAVORO/indagine-r1/ (fuori dal repo)`
- **Verifica:** Uscita 0 con P0-P7 veri (atteso H1), oppure rapporto di STOP motivato.
$LAVORO/indagine-r1/prospetto-numerazione-2026.txt presente.
- **Perché questo modello:** Su questa conclusione fiscale poggiano contatori, prospetto per il commercialista e via libera a R1.

### R1-3.2 · Replica a mano della P7 (controllo indipendente) — sonnet/medium

Appendice B di D1, in zsh:
- percorsi in un array, mai P="…" non quotato;
- rif letto da gh api.
Esegui:
- `git merge-base --is-ancestor $RIF HEAD`;
- `git log -1` su rif, limitato ai percorsi;
- il diff 9a30ff67~1 → rif (controllo positivo);
- i diff 9a30ff67 → rif e 29bb04c7 → rif.

- **File:** —
- **Verifica:** Codici d'uscita 0, 1, 0, 0 come in Appendice B; `git log -1` non vuoto; esito uguale alla P7 di R1-3.1.
- **Perché questo modello:** Solo comandi git in lettura: serve precisione sulla forma degli argomenti.

### R1-3.3 · Controprova dal DB (Appendice A) — sonnet/high

Esegui in sola lettura le query dell'Appendice A di D1 (cronologia, buchi, scorrimenti, scartate, esiti di D1, RPC con GREATEST) e riproduci le tabelle di D1§2.3, §2.4 e §2.7. Solo numeri.

- **File:** —
- **Verifica:** Tabelle §2.3, §2.4 e §2.7 riprodotte; ogni differenza segnalata.
- **Perché questo modello:** Lettura e confronto di aggregati.

## R1-F4 · Contatori (solo se l'indagine lo richiede)

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Allineare i contatori solo se P6 è falso, mostrando ogni scrittura prima di applicarla.
- **Dipende da:** R1-F3
- **Critico (opus/high):** Rilegge contatori e audit (solo id, azione e numeri) e controlla che non ci siano scritture oltre quelle mostrate.

### R1-4.1 · Allineamento condizionale dei contatori — opus/max

Con P6 vero in R1-F3: nessuna scrittura; annota «contatori invariati» in $LAVORO/allinea.txt.

Con P6 falso, per ogni serie da allineare: `node scripts/numerazione-serie.mjs --out $LAVORO/allinea --allinea --serie <S> --a <N>` (D1§4).
- La guardia del §10 deve dare ok.
- Lo script mostra «SCRIVO:» con l'istruzione a confronto-e-scambio, applica e rilegge.
- Con 0 righe aggiornate, rilancia.

- **File:** `$LAVORO/allinea/ (fuori dal repo)`
- **Verifica:** P6 falso: contatore riletto = obiettivo, e una riga 'allineamento_contatore_fatture' in registro_modifiche per serie.
P6 vero: nessuna riga nuova.
- **Perché questo modello:** È l'unica scrittura sulla numerazione fiscale di produzione.

## R1-F5 · Fotografia fk-utenti e PRD

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Riarmare il lock tracce-docente-dichiarate e scrivere il PRD con l'esito dell'indagine.
- **Dipende da:** R1-F4
- **Critico (sonnet/high):** Controlla che il PRD non contenga nomi, CF o nomi file e che i numeri coincidano con R1-F3 e R1-F4. Poi commit.

### R1-5.1 · Rigenerazione di fk-utenti-snapshot.json — sonnet/medium

D1§6.4:
- `node __tests__/fixtures/fk-utenti-fotografia.mjs --sql > $LAVORO/fk.sql`;
- `supabase db query --linked --agent no -o json -f $LAVORO/fk.sql > $LAVORO/fk.json`;
- `node __tests__/fixtures/fk-utenti-fotografia.mjs < $LAVORO/fk.json`.
Nel diff devono cambiare solo generato_il e generato_alle.

- **File:** `__tests__/fixtures/fk-utenti-snapshot.json`, `$LAVORO/fk.sql e fk.json (fuori dal repo)`
- **Verifica:** Diff limitato a generato_il e generato_alle; sha256 e 56 voci invariati.
VT: __tests__/architecture/tracce-docente-dichiarate.test.ts → 1.
- **Perché questo modello:** Rigenerazione con un generatore esistente, più il controllo del diff.

### R1-5.2 · PRD della PR-D1 — sonnet/high

PRD REGISTRO ELETTRONICO.md (D1§16). In testa ai changelog, blocco datato «Il vincolo per sede, il salto FPR 2154→2516 e le fatture partite ma non registrate», con soli numeri:
- fatti di D1§2, compresi §2.6, §2.7 e §2.9;
- P0-P7 con rif e la conclusione di R1-F3; riassunto del prospetto; esito di R1-F4;
- guardia a 50, log, aggregato;
- la migrazione e chi la applica;
- il 409 e il predicato unico CR1;
- script e guardie, compresi tabella assente ed errore di lettura;
- advisors non eseguibili (MCP supabase non autenticato).
Riga P3: «numerazione unica per (sezionale, anno)».

- **File:** `PRD REGISTRO ELETTRONICO.md`
- **Verifica:** `grep -n 2154 'PRD REGISTRO ELETTRONICO.md'` trova il blocco.
VT: __tests__/architecture/pii-nei-file-tracciati.test.ts → 1.
- **Perché questo modello:** Documentazione accurata di dati già misurati.

## R1-F6 · Gate locale PR-D1

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Lint, tipi, tutti i test contati e build verdi prima della PR.
- **Dipende da:** R1-F5
- **Critico (sonnet/high):** Con un gate rosso, attribuisce il file al proprietario (R1-F1a, R1-F1b o R1-F2), che ripara con lo stesso modello, poi rilancia il gate.

Rilegge i lock del test 10 di D1: migrazioni-complete, onconflict-arbitro, tracce-docente-dichiarate, soglia-fotografia, rls-per-sede, fk-scuola-id, migrazioni-senza-sede-cablata, security-definer-revoke-lock, errori-con-codice, messaggi-parita-cataloghi, logging-coverage, pii-nei-file-tracciati, annullo-riapre-movimento.

### R1-6.1 · ESLint — haiku/low

Esegui `npx eslint . --max-warnings 0` dalla radice e riporta l'esito.

- **File:** —
- **Verifica:** Uscita 0.
- **Perché questo modello:** Verifica banale: esegue un comando e riporta l'esito.

### R1-6.2 · Typecheck — haiku/low

Esegui `npx tsc --noEmit` e riporta l'esito.

- **File:** —
- **Verifica:** Uscita 0.
- **Perché questo modello:** Verifica banale.

### R1-6.3 · Vitest con conteggio dei file — haiku/low

Formula GATE-VITEST delle note: N dei file su disco, poi `npx vitest run`, confrontando con «Test Files N passed». In zsh niente PIPESTATUS.

- **File:** —
- **Verifica:** Uscita 0 e «Test Files N passed», con N uguale ai file su disco; ogni differenza spiegata.
- **Perché questo modello:** Confronta due numeri.

### R1-6.4 · Build — haiku/low

Esegui `npm run build` e riporta l'esito.

- **File:** —
- **Verifica:** Uscita 0.
- **Perché questo modello:** Verifica banale.

## R1-F7 · PR-D1, CI e precondizioni

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Aprire la PR-D1 con CI verde e verificare le precondizioni del merge, con un dry-run protetto.
- **Dipende da:** R1-F6
- **Critico (opus/high):** Rilegge $LAVORO/dry-run-d1.txt:
- marcatore di prova a secco presente;
- un solo file elencato;
- nessuna riga di applicazione.
Ricontrolla con una SELECT che schema_migrations sia invariata.

Dà il via libera al merge solo con:
- CI verde;
- dry-run corretto;
- indagine chiusa senza STOP.

### R1-7.1 · PR-D1 e attesa della CI — sonnet/medium

- `git status --short` vuoto: i commit li ha fatti ogni critico. Se c'è un residuo, fermati e riferisci.
- Push del branch e `gh pr create`.
- Titolo e corpo in italiano: sintesi di D1, esito dell'indagine, rischi. Il corpo termina con la riga di attribuzione '🤖 Generated with [Claude Code](https://claude.com/claude-code)'.
- `gh pr checks <n> --watch`: servono quality ed e2e verdi. Se sono rossi, riporta job e file senza forzare nulla.

- **File:** —
- **Verifica:** `gh pr checks <n>` → tutti pass.
- **Perché questo modello:** Procedura git/gh standard.

### R1-7.2 · Precondizioni in sola lettura, col dry-run protetto — sonnet/medium

Dalla radice del branch.

1. SELECT:
   - VERSION (da $LAVORO/r1-version.txt) assente da supabase_migrations.schema_migrations;
   - ultima version = 20260920124744;
   - orfane col PREDICATO_SQL;
   - vincolo presente (1).
2. Dry-run con tre cautele (rilievo 9a):
   - prima `supabase db push --help | grep -c -- '--dry-run'` ≥ 1;
   - poi ESATTAMENTE `supabase db push --linked --dry-run > $LAVORO/dry-run-d1.txt 2>&1`: mai senza --dry-run, mai con --yes, nessun'altra opzione;
   - l'output deve dichiarare la prova a secco ed elencare solo il file di VERSION, altrimenti STOP (D1§13 p.2).
3. Rilettura dell'ultima version: deve essere ancora 20260920124744.

- **File:** `$LAVORO/dry-run-d1.txt (fuori dal repo)`
- **Verifica:** $LAVORO/dry-run-d1.txt con un solo nome di migrazione (VERSION); ultima version invariata; numeri riportati.
- **Perché questo modello:** Il comando tocca la produzione: sbagliare una sola opzione applicherebbe la migrazione scavalcando l'integrazione (decisione 25). Haiku non basta.

## R1-F8 · Merge PR-D1 nella finestra

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Fondere dopo le 16:00, lontano dalla sync e senza emissioni in corso. La migrazione la applica l'integrazione.
- **Dipende da:** R1-F7
- **Critico (sonnet/high):** Controlla l'orario, l'attività dell'app a zero e che il merge sia avvenuto senza azioni manuali sulle migrazioni.

### R1-8.1 · Merge nella finestra — sonnet/medium

Aspetta queste condizioni:
- dopo le 16:00 Europe/Rome;
- minuto dell'orologio del DB (`select now() at time zone 'Europe/Rome'`) fra :10 e :20 oppure fra :40 e :50 (D1§10.2);
- subito prima, con la prima lettura di D1§10.1, attivita_app degli ultimi 10' = 0. Altrimenti aspetta la finestra successiva.

Poi `gh pr merge <n> --squash --delete-branch`.

Mai apply_migration, db push in scrittura, approvazione di migrate.yml o migrate-ci. Il passo 4 di .claude/commands/ship-cycle.md NON si esegue (decisione 25).

- **File:** —
- **Verifica:** `gh pr view <n> --json state,mergedAt` → MERGED, con mergedAt dentro la finestra.
- **Perché questo modello:** Rispetto rigoroso di orari e precondizioni.

## R1-F9 · Verifica in produzione e sorveglianza serale della PR-D1

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Accertare che la migrazione sia applicata e il deploy riuscito, poi sorvegliare le emissioni della segreteria fino a fine orario. Il rilascio può fermare emissioni: 409, pavimento fuori scala, righe registro-* (rilievo 7c).
- **Dipende da:** R1-F8
- **Critico (opus/high):** Se 9.1 o 9.2 falliscono:
- STOP;
- niente orfane;
- correzione solo con una PR, mai a mano (D1§13 p.11); nel frattempo protegge il 409.

Se fallisce il deploy: rapporto al titolare.

Con segnali di 9.5: decide con la tabella di STOP e informa il direttore.

### R1-9.1 · Check Supabase Preview — haiku/low

Con `gh api repos/erricoluigi17/kidville-web/commits/<sha del merge>/check-runs` trova il check «Supabase Preview» e riporta lo stato.

- **File:** —
- **Verifica:** conclusion = success entro circa 40 s dal merge.
- **Perché questo modello:** Lettura di uno stato.

### R1-9.2 · Migrazione, vincolo e indici in produzione — sonnet/low

In sola lettura:
- supabase_migrations.schema_migrations contiene VERSION;
- count del vincolo fatture_emesse_scuola_id_anno_numero_key = 0;
- in pg_indexes ci sono fatture_emesse_sezionale_anno_numero_uidx e fatture_emesse_pagamento_quota_uidx.

- **File:** —
- **Verifica:** VERSION presente, vincolo 0, due indici presenti.
- **Perché questo modello:** Tre SELECT con esito atteso noto, ma lanciate con `supabase db query --linked`, che esegue SQL arbitrario in produzione: sonnet, mai haiku (C0-7, CONVENZIONI «Modelli»).

### R1-9.3 · Deploy Vercel di produzione — haiku/low

Con `gh api repos/erricoluigi17/kidville-web/deployments` più gli statuses, controlla che il deploy di produzione dello sha del merge sia success.

- **File:** —
- **Verifica:** success per lo sha del merge.
- **Perché questo modello:** Lettura di uno stato.

### R1-9.4 · Ritorno su main — sonnet/low

`git switch main && git pull --ff-only`. Nessun'altra operazione.

- **File:** —
- **Verifica:** `git rev-parse HEAD` = `git rev-parse origin/main`, che contiene il merge.
- **Perché questo modello:** Cambia lo stato di git (rilievo 9b).

### R1-9.5 · Sorveglianza serale fino alle 18:30 — sonnet/high

Dal merge fino alle 18:30 Europe/Rome, ogni 15' col tool Monitor, niente sleep. Letture:
- (a) app_log evento='fattura' dopo il merge, per esito e livello: partita-non-registrata-fermata, pavimento-sopra-contatore, pavimento-fuori-scala, registro-doppione-rifiutato, registro-numero-serie-duplicato, registro-vincolo-per-sede, registro-vincolo-ignoto, registro-non-scritto;
- (b) count di inviata dopo il merge: la segreteria continua a emettere (decisione 24);
- (c) orfane col PREDICATO_SQL: non devono crescere rispetto a r1-base.json;
- (d) contatori rispetto ai massimi.
Ogni rilevazione in $LAVORO/sorveglianza-r1.jsonl, solo numeri.

STOP e rapporto immediato se:
- registro-vincolo-per-sede > 0 (la migrazione non ha effetto);
- qualunque registro-* > 0;
- pavimento-fuori-scala > 0: serie ferma, serve l'admin col procedimento di D1§4.4;
- orfane in aumento.
Nessuna scrittura.

- **File:** `$LAVORO/sorveglianza-r1.jsonl (fuori dal repo)`
- **Verifica:** Serie di rilevazioni fino alle 18:30 senza segnali di STOP, oppure STOP segnalato con i numeri.
- **Perché questo modello:** Lettura continua e riconoscimento di segnali fiscali.

## R1-F10 · Registrazione delle orfane (dopo le 18:30)

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Registrare tutte le orfane presenti mostrando ogni scrittura prima di applicarla, e riportarne il conteggio a 0.
- **Dipende da:** R1-F9
- **Critico (opus/high):** Riconta le orfane col predicato e rilegge registro_modifiche (solo id, azione e conteggi). Controlla che nella stampa non siano comparsi CF o nomi in chiaro, e che $LAVORO/orfane non contenga più .p7m, .xml o .sql, salvo --conserva.

### R1-10.1 · Orfane: prima a secco, poi --solo, poi --applica — opus/max

D1§9 e §13 p.12, da main aggiornato, dopo le 18:30: la guardia sull'attività dell'app lo richiede.
1. `node scripts/fatture-orfane.mjs --out $LAVORO/orfane` a secco: uscita 0, elenco e controlli a-h.
2. `--applica --solo <pagamento più vecchio>`: mostra «SCRIVO 1/N» con l'istruzione intera mascherata, poi applica.
3. `--applica` per le restanti.
4. Riconteggio col PREDICATO_SQL = 0.

Autore «sistema»: creato_da NULL e utente_id NULL; emessa_da nell'audit; intestatario preso dall'XML inviato.
Con voci DA DECIDERE (uscita 2): registra solo le pronte, fermati sulle altre e fai rapporto al titolare.

- **File:** `$LAVORO/orfane/ (fuori dal repo)`
- **Verifica:** Riconteggio col predicato = 0; tante righe 'registrazione_fattura_orfana' in registro_modifiche quante le fatture registrate.
- **Perché questo modello:** Scritture WORM permanenti in produzione, con dati personali.

## R1-F11 · Sorveglianza della prima mattina lavorativa e controllo dopo la sync

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Seguire le emissioni vere della segreteria il mattino dopo il merge (rilievo 7c) e controllare che la sync abbia preso in carico le orfane registrate.
- **Dipende da:** R1-F10
- **Critico (opus/high):** Legge le rilevazioni: con STOP decide con la tabella di R1-9.5; senza STOP dà il via libera alla chiusura di R1.

### R1-11.1 · Sorveglianza 08:00-11:00 della prima mattina lavorativa — sonnet/high

Prima mattina lavorativa dopo il merge, 08:00-11:00 Europe/Rome, ogni 15' col Monitor:
- le stesse letture di R1-9.5;
- il conteggio delle 409 lato app (partita-non-registrata-fermata);
- le emissioni riuscite;
- il confronto col giorno precedente.
Stessi criteri di STOP di R1-9.5. Rilevazioni in $LAVORO/sorveglianza-r1.jsonl.

- **File:** `$LAVORO/sorveglianza-r1.jsonl (fuori dal repo)`
- **Verifica:** Rilevazioni dalle 08:00 alle 11:00 senza STOP, oppure STOP segnalato.
- **Perché questo modello:** Riconoscere 409 attesi e fermate anomale durante il lavoro vero.

### R1-11.2 · Controllo dopo il primo giro della sync — sonnet/low

In sola lettura, dopo il primo giro di fatture-sdi-sync (*/30) successivo alle orfane:
- le righe registrate hanno sdi_stato aggiornato;
- in app_log, dopo il merge, 0 righe registro-vincolo-per-sede;
- le righe pavimento-* portano i loro numeri.
Attendi col Monitor.

- **File:** —
- **Verifica:** I tre controlli come attesi, oppure la differenza riportata.
- **Perché questo modello:** Tre SELECT dopo un'attesa.

## R1-F12a · Branch delle fotografie dopo D1

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Creare il branch della PR-D1b prima di ogni altro compito (rilievo 1a).
- **Dipende da:** R1-F10
- **Critico (sonnet/high):** Controlla che il branch parta da un main che contiene il merge della PR-D1. Nessun commit.

### R1-12.1 · Branch chore/fotografie-dopo-d1 — sonnet/low

`git switch main && git pull --ff-only`; status pulito; `git switch -c chore/fotografie-dopo-d1`.

- **File:** —
- **Verifica:** `git branch --show-current` → chore/fotografie-dopo-d1; HEAD = origin/main.
- **Perché questo modello:** Cambia lo stato di git.

## R1-F12b · Fotografie dopo D1

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Rigenerare in parallelo le due fotografie che servono al mini-lock.
- **Dipende da:** R1-F12a
- **Critico (sonnet/high):** Controlla i due diff: solo le novità di D1, e ogni altra differenza spiegata. Poi commit.

### R1-12.2 · Fotografia delle migrazioni applicate — sonnet/medium

Rigenera __tests__/fixtures/migrazioni-applicate-snapshot.json con __tests__/fixtures/migrazioni-fotografia.mjs, con lo schema --sql / query / stdin di fk-utenti. I file temporanei vanno in $LAVORO.

- **File:** `__tests__/fixtures/migrazioni-applicate-snapshot.json`
- **Verifica:** 184 voci, comprese 20260920001032, 20260920124742/43/44 e VERSION.
VT: __tests__/architecture/migrazioni-complete.test.ts → 1.
- **Perché questo modello:** Rigenerazione con un generatore esistente.

### R1-12.3 · Fotografia degli indici unici — sonnet/medium

Rigenera __tests__/fixtures/indici-unici-snapshot.json con __tests__/fixtures/indici-unici-fotografia.mjs. Deve sparire fatture_emesse_scuola_id_anno_numero_key; ogni altra differenza va spiegata.

- **File:** `__tests__/fixtures/indici-unici-snapshot.json`
- **Verifica:** Vincolo assente, i due indici presenti.
VT: __tests__/architecture/onconflict-arbitro.test.ts → 1.
- **Perché questo modello:** Rigenerazione con un generatore esistente.

## R1-F12c · Mini-lock e PRD della PR-D1b

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Armare il mini-lock «la correzione è in produzione» sulle fotografie ormai rigenerate e completare il PRD.
- **Dipende da:** R1-F12b, R1-F11
- **Critico (sonnet/high):** Controlla il mini-lock verde e un suo controllo negativo: rimesso il vincolo nel JSON su patch reversibile, deve diventare rosso. Poi commit.

### R1-12.4 · Mini-lock test 1b — sonnet/medium

In __tests__/db/fatture-emesse-senza-vincolo-per-sede.test.ts aggiungi il test 1b di D1§12:
- indici-unici-snapshot.json non ha il vincolo e ha i due indici;
- migrazioni-applicate-snapshot.json contiene {VERSION, 'fatture_emesse_senza_vincolo_numero_per_sede'};
- negativo: un oggetto sintetico col vincolo risulta «presente».

- **File:** `__tests__/db/fatture-emesse-senza-vincolo-per-sede.test.ts`
- **Verifica:** VT: __tests__/db/fatture-emesse-senza-vincolo-per-sede.test.ts → 1.
- **Perché questo modello:** Test meccanico su fotografie già pronte.

### R1-12.5 · PRD della PR-D1b — sonnet/medium

Nel blocco di D1 del PRD aggiungi, con soli numeri:
- esito delle orfane;
- VERSION;
- istante del check Supabase Preview;
- esito delle sorveglianze serale e mattutina.

- **File:** `PRD REGISTRO ELETTRONICO.md`
- **Verifica:** Il blocco contiene VERSION e «orfane: 0»; VT: __tests__/architecture/pii-nei-file-tracciati.test.ts → 1.
- **Perché questo modello:** Documentazione breve.

## R1-F13 · Gate locale PR-D1b

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Gate completo sul branch delle fotografie.
- **Dipende da:** R1-F12c
- **Critico (sonnet/high):** Con un gate rosso rimanda al proprietario di R1-F12b o R1-F12c.

### R1-13.1 · ESLint — haiku/low

Esegui `npx eslint . --max-warnings 0`.

- **File:** —
- **Verifica:** Uscita 0.
- **Perché questo modello:** Verifica banale.

### R1-13.2 · Typecheck — haiku/low

Esegui `npx tsc --noEmit`.

- **File:** —
- **Verifica:** Uscita 0.
- **Perché questo modello:** Verifica banale.

### R1-13.3 · Vitest con conteggio — haiku/low

Formula GATE-VITEST.

- **File:** —
- **Verifica:** «Test Files N passed», con N uguale ai file su disco.
- **Perché questo modello:** Confronta due numeri.

### R1-13.4 · Build — haiku/low

Esegui `npm run build`.

- **File:** —
- **Verifica:** Uscita 0.
- **Perché questo modello:** Verifica banale.

## R1-F14 · PR-D1b: PR, CI e merge

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Fondere le fotografie di D1.
- **Dipende da:** R1-F13
- **Critico (sonnet/high):** Controlla che il merge non contenga migrazioni e che la CI fosse verde.

### R1-14.1 · PR-D1b fino al merge — sonnet/medium

- Push e `gh pr create`, in italiano, con la riga di attribuzione.
- `gh pr checks --watch`: quality ed e2e verdi.
- Merge con `gh pr merge --squash --delete-branch`. Anche senza migrazione, per prudenza: dopo le 16:00 e lontano da :00 e :30.

- **File:** —
- **Verifica:** PR MERGED, tutti i check pass.
- **Perché questo modello:** Procedura standard.

## R1-F15 · Verifica del deploy della PR-D1b

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Deploy di produzione della PR-D1b in success, prima di qualunque pulizia.
- **Dipende da:** R1-F14
- **Critico (sonnet/high):** Con il deploy fallito: rapporto al titolare e nessuna pulizia.

### R1-15.1 · Deploy della PR-D1b — haiku/low

Con `gh api …/deployments` più gli statuses, controlla che il deploy di produzione dello sha del merge della PR-D1b sia success.

- **File:** —
- **Verifica:** success.
- **Perché questo modello:** Lettura di uno stato.

## R1-F16 · Chiusura di R1

- **Rilascio:** R1-correzione-urgente
- **Obiettivo:** Tenere main come unico branch e consegnare il resoconto al titolare, con le due domande aperte.
- **Dipende da:** R1-F15, R1-F11
- **Critico (sonnet/high):** Controlla che il resoconto non contenga dati personali e che le domande siano chiare e riportino i default.

### R1-16.1 · Pulizia dei branch — sonnet/low

AGENTS.md §3:
- `git switch main && git pull --ff-only`;
- elimina i branch secondari locali (fix/fatture-vincolo-numero-per-sede, chore/fotografie-dopo-d1) con `git branch -D`;
- controlla con `git ls-remote --heads origin` che in remoto ci sia solo main. Se resta un remoto secondario: `git push origin --delete <nome>`, mostrato prima di eseguirlo.

- **File:** —
- **Verifica:** `git branch -a` mostra solo main e origin/main.
- **Perché questo modello:** Cancella branch locali e remoti: niente haiku (rilievo 9b).

### R1-16.2 · Resoconto al titolare — sonnet/medium

Resoconto con soli numeri:
- indagine (causa, P7 e rif); contatori; orfane registrate;
- sorveglianze serale e mattutina;
- check Supabase; migrate.yml non approvato;
- ship-cycle.md:348-352 e .claude/rules/migrazioni.md prescrivono ancora apply_migration, in contrasto con la decisione 25: decide lui se aggiornarli.

Riporta i cinque default del titolare già applicati (contratto C0.2): nessuna domanda Q1/Q2 resta aperta (C0-18). In particolare: numero conteso ⇒ `errore` e numero nuovo, mai «Rimanda»; voce con soli invii `rifiutata`/`bruciata` ⇒ si toglie.

- **File:** —
- **Verifica:** Resoconto consegnato; i cinque default citati come applicati, nessuna domanda aperta.
- **Perché questo modello:** Sintesi chiara per il titolare.

## R2A-F0 · Branch della coda, istante T1 e base di produzione

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Creare il branch nuovo dopo il deploy di R1. Fissare una sola volta T1 e i nomi delle tre migrazioni, così i compiti successivi li conoscono senza dipendere l'uno dall'altro. Salvare i numeri di base.
- **Dipende da:** R1-F16
- **Critico (sonnet/high):** Con orfane o trasporto fallito diversi da 0 ferma R2 e rimanda alla procedura di R1. Controlla anche T1 rispetto alle fotografie su main. Nessun commit.

### R2A-0.1 · Branch feat/coda-fatture-aruba e istante T1 — sonnet/medium

1. `git fetch origin && git switch main && git pull --ff-only`; status pulito; `git switch -c feat/coda-fatture-aruba`.
2. T1 = `date -u +%Y%m%d%H%M%S`. Controlla che T1 sia maggiore:
   - di ogni generato_alle in __tests__/fixtures/*.json, convertito in AAAAMMGGhhmmss UTC;
   - dell'ultima version in supabase/migrations.
3. Ricava T1+60s e T1+120s con `TZ=UTC date -j -v+60S -f %Y%m%d%H%M%S $T1 +%Y%m%d%H%M%S` (e con +120S).
4. Scrivi in $LAVORO/r2-t1.txt i tre istanti e i tre nomi: <T1>_fatture_coda_schema.sql, <T1+60s>_fatture_coda_rpc.sql, <T1+120s>_fatture_coda_cron.sql.
Nessun file nel repo.

- **File:** `$LAVORO/r2-t1.txt (fuori dal repo)`
- **Verifica:** Branch corrente feat/coda-fatture-aruba, HEAD = origin/main.
r2-t1.txt ha 3 istanti distanti 60 s, tutti ≤ adesso e maggiori di ogni generato_alle.
- **Perché questo modello:** Stato git più un confronto di istanti da cui dipende il lock migrazioni-complete.

### R2A-0.2 · Base di produzione per la coda (sola lettura) — sonnet/medium

Salva in $LAVORO/r2-base.json, con permessi 0600:
- ultima version (= VERSION di D1);
- nessuna tabella fatture_coda%;
- orfane col predicato CR1 = 0;
- «Trasporto fallito» = count di righe con aruba_filename e sdi_stato nulli;
- pagamenti scartata+pagato con una riga sdi_stato in (2,4,9): atteso 7, è il riferimento di D-motivo;
- cron.job con jobname e schedule (minuti liberi, F3 corretto).

- **File:** `$LAVORO/r2-base.json (fuori dal repo)`
- **Verifica:** File presente; orfane 0 e trasporto fallito 0, altrimenti STOP.
- **Perché questo modello:** Query aggregate e confronto coi valori attesi.

## R2A-F1 · Fase 0: contratto DB, finto Aruba, spec e moduli indipendenti

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Scrivere il vocabolario condiviso del DB, l'Aruba finto, la spec v5 e i moduli che non dipendono da nulla di nuovo. Le decisioni di questa scomposizione entrano nella spec.
- **Dipende da:** R2A-F0
- **Critico (opus/xhigh):** Controlla:
- i nomi di contratto-db.ts contro D2§7.1, e i conteggi 59 / 14 / 32 (30+2);
- che la spec contenga le decisioni di questa scomposizione, oltre ai cinque default del titolare (contratto C0.2; C0-18).

Rompe su patch reversibile:
- numeroLeggibile: il test di equivalenza deve diventare rosso;
- un codice tolto da CODICI_ESITO_VOCE: il test dei conteggi deve diventare rosso;
- l'Aruba finto deve lanciare su una chiamata imprevista.

Poi commit.

### R2A-1.1 · contratto-db.ts con test (59 codici di voce) — opus/high

Crea src/lib/fatture-coda/contratto-db.ts (D2§7.1; C§4, §5, §8, §13): puro, senza import.

Nomi: fanno fede D2 e D6, mentre D3 e D4 si adeguano (CR10, rilievo 10). Per ogni elenco una mappa al singolare e una tupla al plurale:
- STATO_VOCE/STATI_VOCE, STATO_INVIO/STATI_INVIO;
- INTESTATARIO_ORIGINE/INTESTATARIO_ORIGINI, CAUSALE_MODO/CAUSALE_MODI, AZIONE_RICHIESTA/AZIONI_RICHIESTE, CONSEGNA_ANOMALIA/CONSEGNE_ANOMALIA;
- ESITO_CHIUSURA/ESITI_CHIUSURA (tipo EsitoChiusuraRichiesto), LAVORO/LAVORI, AZIONE_INVIO/AZIONI_INVIO, ESITO_TENTATIVO/ESITI_TENTATIVO;
- TIPO_DOCUMENTO/TIPI_DOCUMENTO, ESITO_RICERCA/ESITI_RICERCA, ESITO_DOPPIONE/ESITI_DOPPIONE, TIPO_AVVISO/TIPI_AVVISO, TIPO_ANOMALIA/TIPI_ANOMALIA;
- RIFIUTO/CODICI_RIFIUTO, ESITO_VOCE/CODICI_ESITO_VOCE, ESITO_INVIO/CODICI_ESITO_INVIO;
- TIPI_DOCUMENTO_SUPPORTATI = [TIPO_DOCUMENTO.TD01].

Conteggi, scritti nel test e nella spec (rilievo 14):
- CODICI_ESITO_VOCE = 59: quelli elencati in C§8.2, `giornale_non_aperto` compreso (CR2) [V, conteggio sul testo]; `numero_conteso` sta in CODICI_ERRORE (C0.2 D3, C0-18);
- CODICI_AVVISO_VERIFICA_MANUALE = 6, senza `numero_conteso` (C§8.6, C0-18); test: `numero_conteso` ∈ CODICI_ERRORE e ∉ CODICI_AVVISO_VERIFICA_MANUALE;
- CODICI_ESITO_INVIO = 14 codici fissi (i 13 di C§8.3 più giornale_non_aperto), più le forme upload_<http> e scarto_<codice> di codiceUpload e codiceScarto;
- RPC_CODA = 32 nomi, ciascuno col suo file: 30 nel file 2 e 2 nel file 3 (fatture_coda_tick_http, fatture_coda_pulizia), rilievo 3.

Altri contenuti:
- costanti di C§4: STATI_SDI_SCARTO=[2,4,9], CHIAVI_RIGA_REGISTRO nell'ordine di C§7.3, MAX_RIGA_REGISTRO_BYTES;
- insiemi, TRANSIZIONI_*, gruppi di codici;
- CODICI_SOLO_DA_CONVERSIONE = guasto_ripetuto, aruba_429_ripetuto, ricerca_non_riuscita;
- CODICI_AVVISO_*, MODO_DA_VERIFICARE, codiceUpload, codiceScarto, CODICI_SCHEMA_ASSENTE.

Tipi v4 di C§13:
- sveglia:boolean in EsitoAccodamento, EsitoRimetti, EsitoRichiediVerifica, EsitoSospendi;
- EsitoTogli = {tolte, rifiutate[{voce_id, code}]}; EsitoRimetti.rifiutate con data_documento? e giorni?;
- EsitoInvioRegistra = {invio_id} | {verificato:true};
- EsitoNumeroBruciato = {invio_id, consegna}; EsitoSegnalaAnomalia = {consegna};
- EsitoChiusura = ritorno di chiudi.

Test __tests__/lib/fatture-coda/contratto-db.test.ts:
- mappa = tupla; nessun duplicato;
- CODICI_ESITO_VOCE = unione dei gruppi, con length === 59;
- i 14 fissi di CODICI_ESITO_INVIO;
- codiceUpload: 200, 429 e 503, lancio su 99;
- STATI_SDI_SCARTO = {c in 0..20 : mapStatoAruba(c).isScarto};
- RPC_CODA: 32 distinti, 30 del file 2 e 2 del file 3.

- **File:** `src/lib/fatture-coda/contratto-db.ts`, `__tests__/lib/fatture-coda/contratto-db.test.ts`
- **Verifica:** VT: __tests__/lib/fatture-coda/contratto-db.test.ts → 1; `npx tsc --noEmit` senza errori che citino contratto-db.ts.
- **Perché questo modello:** Vocabolario di stati e codici fiscali condiviso da SQL, lavoratore, API e UI.

### R2A-1.2 · Aruba finto unico con test — sonnet/xhigh

Crea __tests__/helpers/aruba-finto.ts (D6§8.1; C§17.2).
- installaArubaFinto({orologio?}) con vi.stubGlobal('fetch').
- Solo i 4 host di arubaBaseUrls (client.ts:214-226, importato: in questa fase client.ts non cambia) e i 5 percorsi. Qualunque altra chiamata, o una senza risposta, lancia ArubaFintoImprevisto.
- Metodi: accoda, predefinita, contatori, chiamate, ripristina.
- Risposte pronte: accessoRiuscito, accettata, scartoMerito, doppione0034, troppeRichiesteHtml, erroreServer, corpoIlleggibile, reteCaduta, credenzialiRifiutate, paginaIndice, documentoConFile, documentoSenzaDestinatario.
- Builder xmlFatturaMinimo(d) e p7mConXml(xml, {ber: definita | indefinita, pezzo?}).
- Forme JSON copiate dal client.ts di oggi.
Autotest __tests__/helpers/aruba-finto.test.ts.

- **File:** `__tests__/helpers/aruba-finto.ts`, `__tests__/helpers/aruba-finto.test.ts`
- **Verifica:** VT: __tests__/helpers/aruba-finto.test.ts → 1.
- **Perché questo modello:** Finto meccanico, ma con un costruttore BER a lunghezza indefinita da scrivere con cura.

### R2A-1.3 · Spec v5 della coda — opus/high

Crea docs/superpowers/specs/2026-09-22-coda-fatture-aruba-design.md (proprietario D6).

Contenuto:
1. Il CONTRATTO v4 integrale, più un §0.3 «Cosa cambia nella v5», che raccoglie:
   - le correzioni CR1-CR12 e le richieste accolte;
   - le decisioni di questa scomposizione (note, DECISIONI): NUMERO_SEGNAPOSTO_PROVA solo in src/lib/aruba/confronto-documento.ts; 59 codici di voce; 30+2 RPC; parità CR1 provata eseguendo; cron.schedule letterali; vocabolario-log.ts escluso dal lock specchio come catalogo; T1 fissato in R2A-F0; finestre di sorveglianza serale e mattutina; $LAVORO; circuito di chiudi(aruba_429) con la semantica di D2; «Riprova fattura» come comando di ritrasmissione; firme estese di D3.
2. F3 e F7 corretti; S28 a cinque condizioni; passo 4 di ship-cycle.md non eseguito per PR-D1, PR-A e PR-B.
3. Riassunti di D1-D6.
4. I cinque default del titolare già applicati (contratto C0.2 e C0.5; nessuna domanda aperta, C0-18).
Nessun dato personale.

- **File:** `docs/superpowers/specs/2026-09-22-coda-fatture-aruba-design.md`
- **Verifica:** `grep -c` trova p_solo_verifica, CASE WHEN p.fattura_aruba_id, cron:fatture-coda-pulizia, IS DISTINCT FROM, CodiceRispostaCoda, Riprova fattura, giornale_non_aperto, NUMERO_SEGNAPOSTO_PROVA e 59.
VT: __tests__/architecture/pii-nei-file-tracciati.test.ts → 1.
- **Perché questo modello:** È il riferimento di tutti gli esecutori: deve integrare le correzioni senza contraddizioni.

### R2A-1.4 · Spostamento puro in fatture-dei-pagamenti.ts — sonnet/high

D4§5.5, commit 1. Da riconciliazione/route.ts sposta, invariati, in src/lib/pagamenti/fatture-dei-pagamenti.ts:
- FATTURE_SELECT (:939) e RigaFatturaMovimento (:941);
- numeroLeggibile (:981), con la sua testata;
- la funzione pura di :1009, esportata come fattureDaRighe.
La rotta la importa e non importa più fattura-viva.

Nello stesso compito:
- nel lock annullo-riapre-movimento (:259) la voce CONSUMATORI diventa fatture-dei-pagamenti.ts;
- solo commento di testata di fattura-viva.ts:95-106.

Test __tests__/lib/pagamenti/fatture-dei-pagamenti.test.ts: fattureDaRighe equivalente; numeroLeggibile invariata.

- **File:** `src/lib/pagamenti/fatture-dei-pagamenti.ts`, `src/app/api/pagamenti/riconciliazione/route.ts`, `src/lib/pagamenti/fattura-viva.ts`, `__tests__/architecture/annullo-riapre-movimento.test.ts`, `__tests__/lib/pagamenti/fatture-dei-pagamenti.test.ts`, `__tests__/api/pagamenti-riconciliazione*.test.ts (solo se rossi)`
- **Verifica:** VT: __tests__/api/pagamenti-riconciliazione __tests__/api/riconciliazione-ripresa-trasporto.test.ts __tests__/architecture/annullo-riapre-movimento.test.ts __tests__/lib/pagamenti/fatture-dei-pagamenti.test.ts → 14.
- **Perché questo modello:** Refactor senza cambi di comportamento, protetto dalla suite esistente.

### R2A-1.5 · assertPagamentiInScope — sonnet/medium

D4§5.6. In src/lib/auth/scope.ts aggiungi assertPagamentiInScope(supabase, user, ids):
- una sola scuoleDiUtente; letture a blocchi di 100;
- lettura fallita → scopeNonRisolto;
- id mancante → 404 {error, codice:'PAGAMENTO_NON_TROVATO'} letterale;
- anche una sola riga fuori sede → rifiutoSede('SEDE_NON_ACCESSIBILE'), più il warn pagamenti-fuori-sede col solo n.
Test __tests__/lib/auth/assert-pagamenti-in-scope.test.ts.

- **File:** `src/lib/auth/scope.ts`, `__tests__/lib/auth/assert-pagamenti-in-scope.test.ts`
- **Verifica:** VT: __tests__/lib/auth/assert-pagamenti-in-scope.test.ts __tests__/architecture/isolamento-sede-coverage.test.ts → 2.
- **Perché questo modello:** Gate di perimetro semplice, su un modello esistente.

### R2A-1.6 · ricordaPersonaSullaScheda — sonnet/medium

D3§10. In src/lib/pagamenti/intestatari.ts aggiungi ricordaPersonaSullaScheda(supabase, alunnoId, persona):
- forma {tipo:'altro', dati} di FatturaButton.tsx:394-404;
- fail-open; con logScrittura.
Test __tests__/lib/pagamenti/ricorda-persona-sulla-scheda.test.ts.

- **File:** `src/lib/pagamenti/intestatari.ts`, `__tests__/lib/pagamenti/ricorda-persona-sulla-scheda.test.ts`
- **Verifica:** VT: __tests__/lib/pagamenti/ricorda-persona-sulla-scheda.test.ts → 1.
- **Perché questo modello:** Funzione piccola che replica una PATCH esistente.

### R2A-1.7 · Finto supabase dell'emissione per il test ponte — sonnet/medium

D3§17 n.20. Crea __tests__/helpers/emissione-supabase-finto.ts COPIANDO, senza spostarlo, il finto di __tests__/lib/aruba/emissione-tracciato-reale.test.ts.
Espone:
- creaSupabaseEmissione({scuolaId, pagamentoId, alunnoId, quote, iva, bollo});
- inserite('fatture_emesse') e aggiornate('pagamenti');
- il contatore di prossimo_numero_fattura_sezionale.
Autotest __tests__/helpers/emissione-supabase-finto.test.ts: un documento emesso col finto passa la validazione XSD. Chi cambia emissione.ts più avanti tiene verde questo autotest.

- **File:** `__tests__/helpers/emissione-supabase-finto.ts`, `__tests__/helpers/emissione-supabase-finto.test.ts`
- **Verifica:** VT: __tests__/helpers/emissione-supabase-finto.test.ts → 1.
- **Perché questo modello:** Copia adattata di un finto esistente.

### R2A-1.8 · Catalogo delle notifiche obbligatorie — sonnet/medium

D5§10.2:
- TipoNotifica += obbligatoria?;
- isNotificaAbilitata risponde true per un tipo obbligatorio, prima di ogni lettura;
- NotificheSettings.tsx:53 esclude gli obbligatori;
- 9 tipi fattura_coda_* nel gruppo staff, con obbligatoria:true;
- label e desc in messages/{it,en}/etichette.json, più nav_coda_fatture.
Test: __tests__/lib/notifiche-obbligatorie.test.ts (nuovo) e aggiornamento di __tests__/lib/etichette-i18n.test.tsx.

- **File:** `src/lib/notifiche/tipi.ts`, `src/lib/notifiche/config.ts`, `src/components/features/admin/settings/NotificheSettings.tsx`, `messages/it/etichette.json`, `messages/en/etichette.json`, `__tests__/lib/notifiche-obbligatorie.test.ts`, `__tests__/lib/etichette-i18n.test.tsx`
- **Verifica:** VT: __tests__/lib/notifiche-obbligatorie.test.ts __tests__/lib/etichette-i18n.test.tsx __tests__/architecture/messaggi-parita-cataloghi.test.ts → 3.
- **Perché questo modello:** Estensione meccanica di un catalogo esistente.

## R2A-F2 · Interfacce e strato Aruba, parte 1

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Scrivere:
- l'interprete RPC e il contratto HTTP;
- il vocabolario dei log e l'helper PGlite;
- client.ts parte 1 e il confronto del documento, con NUMERO_SEGNAPOSTO_PROVA;
- ritmo, accesso e le chiavi i18n.
Tutti dipendono solo da R2A-F1.
- **Dipende da:** R2A-F1
- **Critico (opus/xhigh):** Rompe su patch reversibile; i test devono diventare rossi:
- gravita di un 429 portata a error;
- estraiDatiDocumento che prende il CF del cedente;
- livelloLogCoda che dà info a eccezione.

Controlla che client.ts e confronto-documento.ts importino da fatture-coda solo tipi, e che NUMERO_SEGNAPOSTO_PROVA abbia una sola definizione. Poi commit.

### R2A-2.1 · rpc.ts con test — sonnet/high

D2§7.2. Crea src/lib/fatture-coda/rpc.ts.

leggiEsitoRpc<T>(risposta, nome), con 6 rami:
1. non_migrata: warn coda-non-migrata, una volta per processo e per nome;
2. guasto: error rpc-guasta;
3. array → ok;
4. ok:true → ok;
5. rifiuto con un codice di CODICI_RIFIUTO;
6. altro → guasto, con error coda-rifiuto-inatteso.

Anche schemaCodaAssente(err). Nessuna chiamata RPC.
Test __tests__/lib/fatture-coda-rpc.test.ts: i 6 rami e ogni codice di CODICI_SCHEMA_ASSENTE.

- **File:** `src/lib/fatture-coda/rpc.ts`, `__tests__/lib/fatture-coda-rpc.test.ts`
- **Verifica:** VT: __tests__/lib/fatture-coda-rpc.test.ts → 1.
- **Perché questo modello:** Interprete di risposte, deterministico.

### R2A-2.2 · api-contratto.ts con test — opus/high

Crea src/lib/fatture-coda/api-contratto.ts (D4§4; C§12).
- Schemi z.strictObject coi superRefine di D4§4. Enum zod costruiti sulle tuple di contratto-db coi nomi di R2A-1.1: CAUSALE_MODI e non MODI_CAUSALE, AZIONI_RICHIESTE e non AZIONI_VERIFICA, TIPI_DOCUMENTO_SUPPORTATI.
- Tipi VoceInElenco (v4), InvioAperto, FatturaDellaVoce, AzioniVoce, VerificaVoce e le Risposta*.
- CodiceErroreCoda, e CodiceRispostaCoda = CodiceErroreCoda | 'SEDE_NON_ACCESSIBILE' (CR11); CHIAVI_MESSAGGIO_CODA; PERCORSI_CODA senza il giro.
- Commento: con voce= o pagamento= la GET ignora vista e storico, entro 24 mesi (CR11).
- I 4 motivi uguali a codici si prendono da ESITO_VOCE.
Test __tests__/lib/fatture-coda/api-contratto.test.ts: ogni superRefine; forza solo con rimanda.

- **File:** `src/lib/fatture-coda/api-contratto.ts`, `__tests__/lib/fatture-coda/api-contratto.test.ts`
- **Verifica:** VT: __tests__/lib/fatture-coda/api-contratto.test.ts → 1.
- **Perché questo modello:** È il contratto HTTP su cui poggiano route, UI ed E2E.

### R2A-2.3 · vocabolario-log.ts con test — sonnet/xhigh

Crea src/lib/fatture-coda/vocabolario-log.ts (D6§3; C§15). Importa solo da ./contratto-db.
- VOCABOLARIO_LOG_CODA per operazione.
- Mappe con chiavi camelCase: TIPO_GIRO, TIPO_SYNC, ESITO_LOG (nessun ESITO_LOG_CANCELLO: C0.1 m6, C0-20); le tuple si ricavano con Object.values.
- TIPI_GIRO (13), TIPI_GIRO_ANOMALI, TIPI_BATTITO_GIRO (17), ESITO_TIPO_GIRO, LIVELLO_TIPO_GIRO.
- LIVELLO_LOG_CODA piatta; livelloLogCoda(operazione, esito, tipo?).
- TIPI_00404_NON_RISOLTO = [ESITO_RICERCA.assente, .illeggibile, .ambigua].
- Tutti gli esiti già presenti in sync/route.ts col loro livello, più l'info scarto-solo-chi-ha-accodato (CR7, nome di contratto C0.1 m3; C0-20).
Test __tests__/lib/fatture-coda/vocabolario-log.test.ts:
- livelloLogCoda sui 17 tipi;
- lancio su una coppia inesistente;
- nessun esito con due livelli;
- TIPI_00404_NON_RISOLTO ⊆ ESITI_RICERCA.

- **File:** `src/lib/fatture-coda/vocabolario-log.ts`, `__tests__/lib/fatture-coda/vocabolario-log.test.ts`
- **Verifica:** VT: __tests__/lib/fatture-coda/vocabolario-log.test.ts → 1.
- **Perché questo modello:** Catalogo esteso: i livelli decidono tasso-errore e salute (decisione 23).

### R2A-2.4 · Helper PGlite creaDbCoda con autotest — opus/high

Crea __tests__/helpers/fatture-coda-pglite.ts (D2§10.1).

Stub con le colonne reali di G3:
- pagamenti, con l'enum fattura_stato;
- fatture_emesse, coi due indici di G8;
- schools, auth.users, utenti (role GENERATED STORED), utenti_scuole, app_log;
- cron_config(p_nome text); schemi net e cron con le spie;
- ruoli anon, authenticated e service_role BYPASSRLS.

Carica dal disco i file *_fatture_coda_{schema,rpc,cron}.sql PRESENTI, in ordine di version. Opzioni: senzaNet, senzaCron, senzaConfig, senzaFile3, soloStub.

Espone: sql, impostaAdesso, avanza, postInviati, rispondiPost, cronProgrammati, log, avvisi, avvisiDurante, semina (con id espliciti), xmlDiProva, preparaVoceInMano, verificaVocabolari.

Autotest __tests__/helpers/fatture-coda-pglite.test.ts con soloStub.

- **File:** `__tests__/helpers/fatture-coda-pglite.ts`, `__tests__/helpers/fatture-coda-pglite.test.ts`
- **Verifica:** VT: __tests__/helpers/fatture-coda-pglite.test.ts → 1.
- **Perché questo modello:** Gli stub devono replicare lo schema di produzione: ci poggiano tutti i test SQL, il ponte e il cardine.

### R2A-2.5 · client.ts parte 1: esiti, gravità, ganci, includeFile — opus/high

D3§9.1, punti 1, 2, 3 e 5, su src/lib/aruba/client.ts:
- esitoTentativoDi;
- gravita: 429, 5xx e rete a warn;
- params.cancello coi ganci: nessuna pausa propria fra le pagine, nessuna attesa di 90 s; prima e dopo in finally;
- arubaGetByFilename con includeFile e fileBase64.
Solo import type da contratto-db (S35).

Test 3 in __tests__/lib/aruba/lettura-senza-ritentativo.test.ts.

Proprietario in questa fase (rilievo 2) di TUTTI i test esistenti di __tests__/lib/aruba che la modifica rompe (compresi signin-prima-della-rpc, upload-ritmo-e-trasporto, notifiche-motivo-scarto, notifiche-allegato-xml, iva-coerenza, pavimento-implausibile), di __tests__/api/fattura-emissione.test.ts, di fattura-emissione-split.test.ts e dell'autotest emissione-supabase-finto. emissione.ts non cambia in questa fase.

- **File:** `src/lib/aruba/client.ts`, `__tests__/lib/aruba/lettura-senza-ritentativo.test.ts`, `__tests__/lib/aruba/*.test.ts esistenti (solo se rotti)`, `__tests__/api/fattura-emissione.test.ts (solo se rotto)`, `__tests__/api/fattura-emissione-split.test.ts (solo se rotto)`, `__tests__/helpers/emissione-supabase-finto.test.ts (solo se rotto)`
- **Verifica:** VT: __tests__/lib/aruba/ __tests__/api/fattura-emissione.test.ts __tests__/api/fattura-emissione-split.test.ts __tests__/helpers/emissione-supabase-finto.test.ts --exclude '**/confronto-documento.test.ts' --exclude '**/accesso.test.ts' → tutti passed (N = 31 file di aruba + 3 = 34; con la barra finale, C0-3, aruba-lettura.test.ts non entra: senza, N sarebbe 35). Restano esclusi i due file dei compiti paralleli.
- **Perché questo modello:** Tocca le chiamate reali ad Aruba e la gestione dei 429.

### R2A-2.6 · confronto-documento.ts con test, e NUMERO_SEGNAPOSTO_PROVA — opus/high

D3§9.2. Crea src/lib/aruba/confronto-documento.ts, puro:
- contenutoXml: XML in chiaro, base64 anche doppio, lettore BER a lunghezza indefinita e a pezzi, latin1 come ultima risorsa;
- estraiDatiDocumento: Data, Numero e ImportoTotaleDocumento letti dentro DatiGeneraliDocumento; destinatario solo dentro CessionarioCommittente; anno del Numero con la regola ±1 e una sola coppia serie/anno ammessa;
- confrontaDocumentoTrovato, ed esitoRicerca con 5 esiti.

Decisione di questa scomposizione (rilievo 5): qui, e solo qui, si esporta `NUMERO_SEGNAPOSTO_PROVA = 999_999`. Lo importa emissione.ts (R2A-5.5); ritmo.ts non lo definisce e non lo riesporta. Import da fatture-coda solo `import type`.

Test 5 in __tests__/lib/aruba/confronto-documento.test.ts, coi builder p7mConXml di aruba-finto: BER indefinito a pezzi da 1000 byte che tagliano Numero, CF e importo; il CF del cedente non è mai preso come destinatario.

- **File:** `src/lib/aruba/confronto-documento.ts`, `__tests__/lib/aruba/confronto-documento.test.ts`
- **Verifica:** VT: __tests__/lib/aruba/confronto-documento.test.ts → 1; `grep -c 'export const NUMERO_SEGNAPOSTO_PROVA' src/lib/aruba/confronto-documento.ts` → 1.
- **Perché questo modello:** Il confronto decide se un documento conta come inviato (decisioni 15 e 29).

### R2A-2.7 · ritmo.ts con test — sonnet/medium

D3§5. Crea src/lib/fatture-coda/ritmo.ts:
- costanti di C§4;
- riesporta SOGLIA_ORARIA_APP da tetto-orario-aruba.ts:51 e SPAZIATURA_SIGNIN_MS da contratto-db;
- costanti interne di D3§5 SENZA NUMERO_SEGNAPOSTO_PROVA (vive in confronto-documento.ts);
- funzioni pure.
Test __tests__/lib/fatture-coda/ritmo.test.ts.

- **File:** `src/lib/fatture-coda/ritmo.ts`, `__tests__/lib/fatture-coda/ritmo.test.ts`
- **Verifica:** VT: __tests__/lib/fatture-coda/ritmo.test.ts → 1; `grep -c NUMERO_SEGNAPOSTO src/lib/fatture-coda/ritmo.ts` → 0.
- **Perché questo modello:** Costanti e funzioni pure.

### R2A-2.8 · accesso.ts con test — sonnet/medium

D3§9.4. Crea src/lib/aruba/accesso.ts. leggiAccessoAruba restituisce AccessoAruba:
- {ok:true, ambiente, creds, username};
- oppure {ok:false, motivo: aruba-disabilitata | credenziali-mancanti | lettura-fallita}.
Fa la stessa query di emissione.ts:854-883, senza log e senza rete.
Test __tests__/lib/aruba/accesso.test.ts.

- **File:** `src/lib/aruba/accesso.ts`, `__tests__/lib/aruba/accesso.test.ts`
- **Verifica:** VT: __tests__/lib/aruba/accesso.test.ts → 1.
- **Perché questo modello:** Una lettura con tre esiti.

### R2A-2.9 · Chiavi i18n della coda — sonnet/high

D5§5-§9 e §12, .claude/rules/traduzioni.md.

In messages/{it,en}/adminContabilita.json, TUTTE le chiavi coda* (codaStato*, codaInvio*, codaEsito*, codaMotivo*, codaRifiuto*, codaOrigine*, codaAccoda*, codaPagina*), più:
- reconChipInCoda e il filtro «Fatturate, in attesa o in coda»;
- fatBtn_emetti_titolo = «Metti in coda la fattura», e il primario «Metti in coda»;
- il testo dell'avviso `errore numero_conteso` (C§8.6, D5), senza alcun testo di «Rimanda» sul numero conteso (C0-18);
- il testo di CR6 per proposta_da_confermare;
- le chiavi della pastiglia di navigazione e dell'intestazione di Contabilità.

In messages/{it,en}/adminStudents.json, la sezione «Pagamenti e fatture».

Le chiavi reconLotto* NON si toccano. È l'unico compito che scrive queste chiavi fino a R2A-F6b: le chiavi che mancassero più avanti le segnala il loro compito al critico.

- **File:** `messages/it/adminContabilita.json`, `messages/en/adminContabilita.json`, `messages/it/adminStudents.json`, `messages/en/adminStudents.json`
- **Verifica:** VT: __tests__/architecture/messaggi-parita-cataloghi.test.ts __tests__/architecture/messaggi-plurali-e-glossario.test.ts → 2.
- **Perché questo modello:** Testi di interfaccia già definiti nei design.

## R2A-F3 · Schema SQL e moduli di secondo livello

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Scrivere il file 1 SQL col suo test (coppia TDD), il client PGlite, client.ts parte 2 e i moduli che dipendono solo da R2A-F1 e R2A-F2: lavoratore, API, UI di base, salute e oblio.
- **Dipende da:** R2A-F2
- **Critico (opus/xhigh):** Prima, se un compito ha segnalato chiavi mancanti, fa girare CHIAVI-F3 (CONVENZIONI, C0-5). Esegue VT su __tests__/db/fatture-coda-schema.test.ts (atteso 1) e LOCK-MIGR. Poi, a compiti 3.11 e 3.13 entrambi chiusi (C0-4): VT: __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/messaggi-parita-cataloghi.test.ts __tests__/lib/fatture-coda/risposte-api.test.ts → 3.
Rossi attesi e dichiarati, solo per il file 1 e fino al compito soglia di R2A-F4: rls-per-sede, onconflict-arbitro, tracce-docente-dichiarate. Ogni altro rosso va riparato.

Rompe su patch reversibile; i test devono diventare rossi:
- trigger che permette → tolta con un invio;
- lpad nudo in _progressivo;
- verificaFormaInvio senza il controllo della voce;
- tono in_coda fuori da TONI_FATTA.

Poi commit.

### R2A-3.1 · Migrazione 1: schema della coda — opus/max

Crea supabase/migrations/<T1>_fatture_coda_schema.sql, col nome preso da $LAVORO/r2-t1.txt. Contenuto secondo D2§3-§4:
- helper di base (§4.1);
- 8 tabelle coi CHECK nominati: _codice_chk delle voci coi 59 codici, compreso giornale_non_aperto; codici d'invio con giornale_non_aperto (CR2);
- indici; trigger d'invarianza (§4.3);
- RLS ENABLE + FORCE senza policy; REVOKE, poi SELECT a service_role; COMMENT ON TABLE;
- NOTIFY pgrst in fondo.
Testata «Stato: scritta il …; la applica l'integrazione Supabase al merge della PR-A», mai «NON APPLICATA». Solo PG ≤ 17. Orologio unico _fatture_coda_adesso(). Non applicare nulla (decisione 25).

- C0-17: `_tentativo_chk` = `(tentativi = 0) = (stato = 'numerata' OR (stato = 'bruciata' AND esito_codice IS DISTINCT FROM 'numero_conteso'))` e `tentativi > 0 ⇒ tentato_il`; `_fatture_coda_invii_guardia` ammette `da_ritentare`/`incerta` → `bruciata` solo con `numero_conteso` e azzera `consecutivi_429` anche su `bruciata`; `_fatture_coda_voci_guardia` ammette `errore → tolta` con `_fatture_coda_solo_invii_non_consegnati(voce)`; azione `doppione_chiuso_pagamento_chiuso` nel CHECK degli eventi (contratto C0.5).
- **File:** `supabase/migrations/<T1>_fatture_coda_schema.sql`
- **Verifica:** Coppia TDD con 3.2: VT: __tests__/db/fatture-coda-schema.test.ts → 1 a fine fase, lo esegue il critico.
`grep -n 'now()\|clock_timestamp' <file>` li trova solo dentro _fatture_coda_adesso.
`grep -ci 'NON APPLICATA' <file>` → 0.
- **Perché questo modello:** Schema, trigger e RLS di una tabella fiscale: vale per sempre in produzione.

### R2A-3.2 · Test PGlite dello schema — opus/high

Crea __tests__/db/fatture-coda-schema.test.ts (`// @vitest-environment node`) coi casi di D2§10.2 schema e di C§17.1:
- RLS e privilegi;
- ogni coppia di TRANSIZIONI_*;
- specchi di progressivo e numero, anche a 1.000.000, con la prova di rottura su lpad;
- _tag_xml; CHECK di riga_registro e dell'XML;
- anomalia_da_consegnare; _dest_chk; tardiva_autorizzata_il scritta una volta; contatori;
- _codice_chk uguale a CODICI_ESITO_VOCE, con length 59 (rilievo 14).
Usa creaDbCoda, che in questa fase carica solo il file 1.

- C0-17: `bruciata numero_conteso` con `tentativi = 1` entra; `bruciata` con altro codice e `tentativi = 1` ⇒ 23514; `numerata` con `tentativi = 1` ⇒ 23514; `registrata → bruciata` ⇒ 23514; `errore → tolta` con un invio `registrata` ⇒ 23514, con soli `rifiutata`/`bruciata` entra. Ognuno con la prova di rottura sul CHECK vecchio.
- **File:** `__tests__/db/fatture-coda-schema.test.ts`
- **Verifica:** Ora compila e fallisce solo per oggetti mancanti.
A fine fase: VT → 1.
- **Perché questo modello:** Test SQL con prove di rottura su invarianti fiscali.

### R2A-3.3 · supabase-su-pglite.ts con test — opus/high

D6§8.2. Crea __tests__/helpers/supabase-su-pglite.ts, clientSuPglite(db, {sincronizzaOrologio}).
- .rpc: firma letta da pg_proc; notazione per nome; jsonb, uuid[], bigint[], text[]; SET LOCAL ROLE service_role; errori nella forma di PostgREST; PGRST202.
- .from: solo lettura coi filtri elementari; le scritture lanciano; embedding, .or e .filter lanciano 'non supportato'.
Test __tests__/helpers/supabase-su-pglite.test.ts su funzioni create dal test stesso.

- **File:** `__tests__/helpers/supabase-su-pglite.ts`, `__tests__/helpers/supabase-su-pglite.test.ts`
- **Verifica:** VT: __tests__/helpers/supabase-su-pglite.test.ts → 1.
- **Perché questo modello:** Emula PostgREST sopra PGlite, con ruoli e tipi: ci poggiano ponte e cardine.

### R2A-3.4 · client.ts parte 2: indice dell'anno — opus/high

D3§9.1 punto 4:
- refactor scorriAnno, usato da massimiDellAnno;
- arubaIndiceFattureInviate con scadenza, anno ±1 e lancio se l'indice è incompleto;
- nessun timer; log indice-concluso senza nomi file.

Test 4 in __tests__/lib/aruba/indice-fatture-inviate.test.ts. I test di numerazione restano immutati: se diventano rossi si corregge il codice.

Proprietario, in questa fase, dei test esistenti di __tests__/lib/aruba e di quelli che chiamano emettiFatturaPagamento, se li rompe. emissione.ts non cambia in questa fase.

- **File:** `src/lib/aruba/client.ts`, `__tests__/lib/aruba/indice-fatture-inviate.test.ts`, `__tests__/lib/aruba/*.test.ts esistenti (solo se rotti; mai numerazione-sezionale e numerazione-un-passaggio)`, `__tests__/api/fattura-emissione*.test.ts (solo se rotti)`
- **Verifica:** VT: __tests__/lib/aruba/ __tests__/api/fattura-emissione.test.ts __tests__/api/fattura-emissione-split.test.ts __tests__/helpers/emissione-supabase-finto.test.ts --exclude '**/reinvio.test.ts' → tutti passed (barra finale, C0-3).
`git diff --quiet -- __tests__/lib/aruba/numerazione-sezionale.test.ts __tests__/lib/aruba/numerazione-un-passaggio.test.ts` → 0.
- **Perché questo modello:** Refactor di codice critico per la numerazione.

### R2A-3.5 · reinvio.ts con test — opus/high

D3§9.3. Crea src/lib/aruba/reinvio.ts:
- rigaDaRegistrare;
- registraDocumentoArrivato: solo colonne WORM, etichetta 'Presa in carico'; il 23505 si classifica con vincoloDelRifiuto e si restituisce senza segnalarlo;
- assicuraRigaRegistro;
- rispedisciDocumento: stessi byte, esito prima del registro;
- riallineaStatoPagamento.
Test 6 in __tests__/lib/aruba/reinvio.test.ts.

- **File:** `src/lib/aruba/reinvio.ts`, `__tests__/lib/aruba/reinvio.test.ts`
- **Verifica:** VT: __tests__/lib/aruba/reinvio.test.ts → 1.
- **Perché questo modello:** Scritture sul registro WORM e ritrasmissione degli stessi byte.

### R2A-3.6 · cancello.ts con test — opus/high

D3§7.
- Involucri di prendi, rilascia, prenota ed esito; p_limite_ora sempre SOGLIA_ORARIA_APP.
- SessioneArubaCancellata coi membri di D3§7.2: attendi iniettato; ganciRicerca con spaziatura di 5 s fra le ricerche; chiudiPendenti.
- ErroreCancello.
- Nessun tetto con setTimeout o Promise.race (I16).
Test 7 in __tests__/lib/fatture-coda/cancello.test.ts.

- **File:** `src/lib/fatture-coda/cancello.ts`, `__tests__/lib/fatture-coda/cancello.test.ts`
- **Verifica:** VT: __tests__/lib/fatture-coda/cancello.test.ts → 1.
- **Perché questo modello:** Gestisce budget e mutua esclusione verso Aruba.

### R2A-3.7 · coda-db.ts con test — opus/high

D3§8, con CR2 e CR8:
- involucri RPC del lavoratore con .rpc letterale e leggiEsitoRpc;
- invioVerifica(voceId, token, doc) = fatture_coda_invio_registra con p_solo_verifica true;
- verificaFormaInvio(doc, voce: {pagamento_id, scuola_id}), che confronta anche pagamento_id e scuola_id di riga_registro con la voce;
- RIFIUTI_INATTESI_LAVORATORE; chiaveAnomalia.
Test __tests__/lib/fatture-coda/coda-db.test.ts.

- **File:** `src/lib/fatture-coda/coda-db.ts`, `__tests__/lib/fatture-coda/coda-db.test.ts`
- **Verifica:** VT: __tests__/lib/fatture-coda/coda-db.test.ts → 1.
- **Perché questo modello:** Confine fra lavoratore e SQL, con la verifica che impedisce di bruciare numeri.

### R2A-3.8 · stima.ts con test — sonnet/high

D3§6. Crea src/lib/fatture-coda/stima.ts:
- simulaInvii, coi valori predefiniti presi da ritmo.ts;
- prossimoTick: primo minuto ≡ 2 mod 5, secondi a 0, UTC;
- tetto di 10.000 giri.
Test __tests__/lib/fatture-coda/stima.test.ts ai confini: finestra di 60', soglia, sospesa, riapreIl.

- **File:** `src/lib/fatture-coda/stima.ts`, `__tests__/lib/fatture-coda/stima.test.ts`
- **Verifica:** VT: __tests__/lib/fatture-coda/stima.test.ts → 1.
- **Perché questo modello:** Simulazione pura con confini temporali.

### R2A-3.9 · situazione.ts con test — sonnet/medium

D4§5.2: componiSituazione, pura. Test __tests__/lib/fatture-coda/situazione.test.ts.

- **File:** `src/lib/fatture-coda/situazione.ts`, `__tests__/lib/fatture-coda/situazione.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Funzione pura piccola.

### R2A-3.10 · periodo.ts con test — sonnet/medium

D4§5.2: ordinaEtaglia (le 500 più vecchie, più il numero delle restanti), pura. Test __tests__/lib/fatture-coda/periodo.test.ts.

- **File:** `src/lib/fatture-coda/periodo.ts`, `__tests__/lib/fatture-coda/periodo.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Funzione pura piccola.

### R2A-3.11 · risposte-api.ts con test — sonnet/high

D4§5.4 con CR11:
- MAPPA_RIFIUTO_HTTP: Record<CodiceRifiuto, {http; codice: CodiceRispostaCoda}>, con FUORI_SEDE e SEDE_ASSENTE → 403 SEDE_NON_ACCESSIBILE;
- rispostaCoda: switch coi codici letterali, compreso SEDE_NON_ACCESSIBILE, chiuso da never;
- rispostaDaRifiuto, rispostaCodaNonDisponibile, partenzaDa (6 rami), perimetroCoda.
Test __tests__/lib/fatture-coda/risposte-api.test.ts.

- **File:** `src/lib/fatture-coda/risposte-api.ts`, `__tests__/lib/fatture-coda/risposte-api.test.ts`
- **Verifica:** VT: __tests__/lib/fatture-coda/risposte-api.test.ts → 1. NON esegue errori-con-codice (C0-4): quel lock (errori-con-codice.test.ts:543-566) esige che ogni codice usato in src/ sia in CODICI_ERRORE e tradotto, e i 15 codici della coda li dichiara R2A-3.13, che gira in parallelo. Lo esegue il critico di R2A-F3.
- **Perché questo modello:** Mappatura esaustiva e deterministica.

### R2A-3.12 · fattureDeiPagamenti con cintura di sede — sonnet/medium

D4§5.5, dopo lo spostamento di R2A-1.4:
- fattureDeiPagamenti(supabase, ids, sedi): blocchi di 100, filtro .in('scuola_id', sedi);
- documentoDelPagamento.
La riconciliazione resta su fattureDaRighe. Estendi __tests__/lib/pagamenti/fatture-dei-pagamenti.test.ts.

- **File:** `src/lib/pagamenti/fatture-dei-pagamenti.ts`, `__tests__/lib/pagamenti/fatture-dei-pagamenti.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Lettura con filtro, su un modello esistente.

### R2A-3.13 · esito-fetch e testi dei codici HTTP della coda — sonnet/medium

C§12:
- CHIAVI_MESSAGGIO_CODA (con uno spread) in CODICI_ERRORE e CODICI_CON_DETTAGLIO di src/lib/ui/esito-fetch.ts;
- testi dei 15 codici in messages/it/shared.json e messages/en/shared.json.
SEDE_NON_ACCESSIBILE esiste già.

- **File:** `src/lib/ui/esito-fetch.ts`, `messages/it/shared.json`, `messages/en/shared.json`
- **Verifica:** VT: __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/messaggi-parita-cataloghi.test.ts → 2.
- **Perché questo modello:** Estensione di cataloghi.

### R2A-3.14 · Tono in_coda, dal motore alla resa (un solo compito) — sonnet/high

D4§7, D5§8.1 e C§13. Motore e resa stanno in un compito solo, perché il Record dei chip dipende dal tipo del tono e il commit dev'essere unico (C§20).

In fatturazione-riga.ts:
- TonoFatturazione += in_coda, dentro TONI_FATTA;
- FonteFatturazione += coda;
- RigaFatturabile.coda?;
- primo ramo di esitoFatturazione.

In riconciliazione-ui.ts:
- CHIP_FATTURAZIONE.in_coda (labelKey reconChipInCoda, hcClass kv-recon-chip--in-coda, senza variante HC);
- FRASE_FATTURAZIONE.in_coda;
- il filtro.

In MovimentoDialog.tsx solo ICONA_CHIP.in_coda = Send.

Test:
- riconciliazione-ui.test.ts: partizione a 5 toni su 150 combinazioni;
- __tests__/lib/pagamenti/fatturazione-riga-coda.test.ts (nuovo);
- riconciliazione-a11y-css.test.ts.

- **File:** `src/lib/pagamenti/fatturazione-riga.ts`, `src/components/features/admin/pagamenti/riconciliazione-ui.ts`, `src/components/features/admin/pagamenti/MovimentoDialog.tsx`, `__tests__/pagamenti/riconciliazione-ui.test.ts`, `__tests__/lib/pagamenti/fatturazione-riga-coda.test.ts`, `__tests__/pagamenti/riconciliazione-a11y-css.test.ts`, `__tests__/components/MovimentoDialog.test.tsx (solo se rosso)`
- **Verifica:** VT: __tests__/pagamenti/riconciliazione-ui.test.ts __tests__/lib/pagamenti/fatturazione-riga-coda.test.ts __tests__/pagamenti/riconciliazione-a11y-css.test.ts __tests__/architecture/fatturazione-riconciliazione-un-motore-solo.test.ts __tests__/components/MovimentoDialog.test.tsx → 5.
- **Perché questo modello:** Estensione di un motore esistente, protetta da un lock di partizione.

### R2A-3.15 · ui-stati.ts con test — sonnet/medium

D5§2.1. Crea src/lib/fatture-coda/ui-stati.ts:
- Record esaustivi con chiavi calcolate dalle mappe;
- TIPO_NOTIFICA_DI_AVVISO, PERCORSO_CODA_FATTURE, SCHEDA_CODA, CHIAVE_STATO_INVIO;
- CHIAVE_RIFIUTO_PLURALE (CodiceRispostaCoda); MINUTI_SILENZIO_ALLARME;
- linkCoda con soli uuid.
Test __tests__/lib/fatture-coda/ui-stati.test.ts.

- **File:** `src/lib/fatture-coda/ui-stati.ts`, `__tests__/lib/fatture-coda/ui-stati.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Mappe di interfaccia.

### R2A-3.16 · Salute: controllo coda-fatture — sonnet/high

D6§4, PR-A:
- controlloCodaFatture in src/lib/health/controlli.ts, settimo elemento di Promise.all;
- __tests__/api/health.test.ts: montaDb con la rpc fatture_coda_salute ed elenco che comprende coda-fatture;
- __tests__/lib/health/coda-fatture.test.ts: gli 8 casi, con livelloLogCoda.
JOB_CRON NON si tocca.

- **File:** `src/lib/health/controlli.ts`, `__tests__/api/health.test.ts`, `__tests__/lib/health/coda-fatture.test.ts`
- **Verifica:** VT: __tests__/api/health.test.ts __tests__/lib/health/coda-fatture.test.ts → 2.
- **Perché questo modello:** Controllo con confini temporali precisi (decisione 23).

### R2A-3.17 · Oblio GDPR della coda — sonnet/high

D2§8:
- obliaCodaFatture in src/lib/gdpr/esegui.ts, passo 3a-ter dopo :1791;
- makeFake con rpc in __tests__/lib/gdpr-esegui.test.ts;
- nuovo __tests__/lib/gdpr-oblio-coda-fatture.test.ts.

- **File:** `src/lib/gdpr/esegui.ts`, `__tests__/lib/gdpr-esegui.test.ts`, `__tests__/lib/gdpr-oblio-coda-fatture.test.ts`
- **Verifica:** VT: __tests__/lib/gdpr __tests__/api/gdpr __tests__/api/admin-gdpr __tests__/api/chat-gdpr __tests__/lib/audit-senza-dati-personali.test.ts __tests__/lib/libera-spazio-perimetro.test.ts __tests__/architecture/oblio-avviso-dichiarato.test.ts → tutti passed, con N = file trovati riportato (rilievo 15d: anonimizzaAlunno la usano 16 file di test).
- **Perché questo modello:** Inserimento puntuale in un flusso GDPR esistente.

### R2A-3.18 · Àncore CSS per l'alto contrasto — sonnet/medium

D5§13. In src/app/globals.css le regole HC di kv-coda-barra, kv-coda-banner--avviso|errore|ok, kv-nav-contatore e kv-nav-bollino: solo token kidville-*, nessun dark:.

- **File:** `src/app/globals.css`, `__tests__/a11y/alto-contrasto-inchiostri-di-stato.test.ts (solo se rosso)`
- **Verifica:** VT: __tests__/a11y/alto-contrasto-inchiostri-di-stato.test.ts → 1. riconciliazione-a11y-css è di R2A-3.14 e lo lancia il critico.
- **Perché questo modello:** CSS su token esistenti.

### R2A-3.19 · Hook use-coda-fatture con test — sonnet/high

D5§3 e §14: hook di lettura (GET PERCORSI_CODA con polling a 30 s) e di azione, tipizzato su api-contratto. Con la coda assente, disponibile:false.
Test __tests__/components/coda/use-coda-fatture.test.tsx.

- **File:** `src/components/features/admin/pagamenti/coda/use-coda-fatture.ts`, `__tests__/components/coda/use-coda-fatture.test.tsx`
- **Verifica:** VT → 1.
- **Perché questo modello:** Hook React sui tipi del contratto.

### R2A-3.20 · Provider del contatore e layout — sonnet/high

D5§4. Crea coda/contatore-coda.tsx:
- CodaFattureContatoreProvider, con polling a 120 s;
- useContatoreCoda;
- un solo logClient warn per sessione.
Montalo in src/app/(dashboard)/admin/layout.tsx dentro SedeProvider.
Fuori dal provider (C0-6), useContatoreCoda restituisce un valore neutro, {disponibile:false} senza numeri, SENZA lanciare e SENZA fetch: AdminSidebar, AdminMenuSheet e AdminBottomNav sono montati senza provider in quattro test esistenti [V] (contrasto-bordi-superfici-pubbliche, contrasto-cascata, sede-mobile-e-ricarica, Modal-dialogo-modale), e un hook che lancia li farebbe diventare rossi in R2A-5.10.
Test __tests__/components/coda/contatore-coda.test.tsx, con un caso «fuori dal provider»: nessuna eccezione, disponibile:false, fetch mai chiamata (spia su fetch). Controllo negativo eseguito: un hook che lancia fuori dal provider fa diventare rosso quel caso.

- **File:** `src/components/features/admin/pagamenti/coda/contatore-coda.tsx`, `src/app/(dashboard)/admin/layout.tsx`, `__tests__/components/coda/contatore-coda.test.tsx`, `__tests__/architecture/admin-layout-shell.test.ts (solo se rosso)`, `__tests__/a11y/alto-contrasto-inchiostro-ereditato.test.tsx (solo se rosso)`, `__tests__/architecture/guscio-chiaro-dichiara-la-superficie.test.ts (solo se rosso)`, `__tests__/i18n/skip-link-nel-catalogo.test.ts (solo se rosso)`
- **Verifica:** VT: __tests__/components/coda/contatore-coda.test.tsx __tests__/architecture/admin-layout-shell.test.ts __tests__/a11y/alto-contrasto-inchiostro-ereditato.test.tsx __tests__/architecture/guscio-chiaro-dichiara-la-superficie.test.ts __tests__/i18n/skip-link-nel-catalogo.test.ts → 5. Gli ultimi tre leggono admin/layout.tsx come testo [V]: un rosso lì si ripara qui, non in un altro compito (C0-6).
- **Perché questo modello:** Componente di interfaccia.

### R2A-3.21 · annuncio-coda.ts con test — sonnet/low

D5§6: annunci puri per role=status. Test __tests__/lib/fatture-coda-annuncio.test.ts.

- **File:** `src/components/features/admin/pagamenti/coda/annuncio-coda.ts`, `__tests__/lib/fatture-coda-annuncio.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Funzioni di testo pure.

## R2A-F4 · SQL parte A, cron e moduli di terzo livello

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Scrivere:
- il nucleo SQL e il file del cron, coi loro test (compreso il bidello, rilievo 10);
- la dichiarazione delle fotografie;
- emissione.ts parte 1;
- i moduli e i componenti che dipendono da R2A-F3.
- **Dipende da:** R2A-F3
- **Critico (opus/max):** Prima, se un compito ha segnalato chiavi mancanti, fa girare CHIAVI-F4 (CONVENZIONI, C0-5). Esegue VT: __tests__/db/fatture-coda-cron.test.ts __tests__/db/fatture-coda-accoda.test.ts __tests__/db/fatture-coda-ordine.test.ts __tests__/db/fatture-coda-bidello.test.ts __tests__/db/fatture-coda-schema.test.ts → 5.
Poi LOCK-MIGR, tutto verde: il rosso dichiarato di R2A-F3 si chiude qui.

Rompe su patch reversibile; i test devono diventare rossi:
- _partita_non_registrata nella forma unione (il caso 3 diverge);
- conteggio con esito <> 'non_eseguito';
- sveglia senza COALESCE;
- bidello senza i rami 2 e 3;
- cron.schedule col nome in una variabile (controllo positivo di 4.3);
- azioniAmmesse che calcola i 12 giorni.

Poi commit.

### R2A-4.1 · Migrazione 2, parte A: nucleo delle RPC — opus/max

Crea supabase/migrations/<T1+60s>_fatture_coda_rpc.sql, col nome da $LAVORO/r2-t1.txt. Parte A di D2§5.

Helper di §5.1:
- CR5: ogni conteggio di upload con esito IS DISTINCT FROM 'non_eseguito';
- CR1: _fatture_coda_partita_non_registrata = la forma CASE di R1-1.3, con _fatture_coda_stati_scarto_sdi() e nessuna lista letterale;
- _apri_circuito; _in_ordine.

_chiudi_voce e _consegna_chiusura:
- i codici ottenibili solo per conversione → BAD_INPUT;
- errore giornale_non_aperto ammesso coi soli invii bruciata.

_aggiorna_gruppo e trigger _fatture_coda_voci_dopo, con S45 più R11.

_inserisci_voce; _sveglia.

Le 5 RPC della parte A: fatture_coda_accoda (S51), aruba_cancello_prendi, aruba_cancello_rilascia (R4), fatture_coda_bidello (5 rami, cancello per primo), fatture_coda_prossima.

Regole:
- ogni funzione subito seguita da REVOKE/GRANT;
- ordine dei lock di §5.9;
- niente PG18;
- NOTIFY in fondo: le parti B e C vanno prima del NOTIFY;
- nei RETURNS TABLE mai una riga che inizi con scuola_id uuid (usa v_sede o sede_id).

- **File:** `supabase/migrations/<T1+60s>_fatture_coda_rpc.sql`
- **Verifica:** GUARDIA-SQL sul file → nessuna riga.
`grep -c 'GRANT EXECUTE' <file>` → 5.
Coppia TDD con 4.3-4.6: il critico esegue i test a fine fase.
- **Perché questo modello:** Concorrenza, ordine dei lock, un fatto un avviso: nucleo fiscale in SQL.

### R2A-4.2 · Migrazione 3: cron, tick e pulizia — opus/high

Crea supabase/migrations/<T1+120s>_fatture_coda_cron.sql (D2§6):
- _fatture_coda_url_giro;
- fatture_coda_tick_http (timeout 300000);
- fatture_coda_pulizia (24 mesi). Il battito si scrive con `_fatture_coda_log(…, p_fingerprint => 'cron:fatture-coda-pulizia')` (firma di contratto C0.1 G4 e D2: `p_fingerprint text DEFAULT NULL`, letterale nel file 3), evento cron, livello info, campi {operazione:'fatture-coda-pulizia', esito:'ok', n_*}; l'INSERT di 20260807211157_presenze_retention_motivo_assenza.sql:146-158 resta solo il modello della riga (CR4, C0-20).
- Default D2 (C0-18): dopo la cancellazione, l'evento `doppione_chiuso_pagamento_chiuso` (attore NULL) per ogni voce `emessa` `doppione_sdi`/`doppione_sdi_irrisolto` con pagamento non più `pagato`, una volta sola per voce; `n_doppioni_chiusi` nel battito (contratto C0.2 D2, §9.5).

Schedule (rilievo 12): dentro DO … EXCEPTION, ma con il nome SEMPRE letterale come primo argomento:
- `PERFORM cron.schedule('fatture-coda-tick', '2,7,12,17,22,27,32,37,42,47,52,57 * * * *', …)`;
- `PERFORM cron.schedule('fatture-coda-pulizia', '49 3 * * *', …)`;
mai in una variabile, mai via EXECUTE. Più la prima esecuzione della pulizia e cron-non-programmato.

Le 2 RPC del file 3 con REVOKE/GRANT. Testata della PR-A.

- **File:** `supabase/migrations/<T1+120s>_fatture_coda_cron.sql`
- **Verifica:** GUARDIA-SQL → nessuna riga.
`grep -c "cron.schedule('fatture-coda-tick'" <file>` → 1 e `grep -c "cron.schedule('fatture-coda-pulizia'" <file>` → 1.
`grep -c 'cron:fatture-coda-pulizia' <file>` ≥ 1.
`grep -c 'GRANT EXECUTE' <file>` → 2.
- **Perché questo modello:** Migrazione del cron in produzione, con pg_net e pg_cron.

### R2A-4.3 · Test PGlite del cron e della sveglia — opus/high

Crea __tests__/db/fatture-coda-cron.test.ts coi casi di D2§10.2 cron:
- sveglia (0) con prova di rottura sui COALESCE, poi (a) e (b); 10 s / 60 s; fermi; senzaNet; senzaFile3;
- tick senza URL; esito HTTP precedente;
- pulizia col battito dal fingerprint letterale (CR4); schedule idempotente;
- sveglia al rilascio della sync (R4).

Controllo positivo (rilievo 12): la regex di installano() (cron-sorvegliato-e-applicato.test.ts:86-89) corrisponde sul file 3 per entrambi i nomi. Prova di rottura: un testo con cron.schedule(v_nome, …) non corrisponde.

- C0-18 (default D2): pulizia con una voce `doppione_sdi` di pagamento rimborsato ⇒ un evento `doppione_chiuso_pagamento_chiuso` con attore NULL; seconda pulizia ⇒ nessun evento nuovo; pagamento ancora `pagato` ⇒ nessun evento; `n_doppioni_chiusi` nel battito.
- **File:** `__tests__/db/fatture-coda-cron.test.ts`
- **Verifica:** Ora fallisce solo per oggetti mancanti. A fine fase: VT → 1.
- **Perché questo modello:** Test SQL su tempo e concorrenza della sveglia.

### R2A-4.4 · Test PGlite dell'accodamento, con parità CR1 eseguita — opus/high

Crea __tests__/db/fatture-coda-accoda.test.ts.
- Ogni rifiuto nell'ordine di D2§5.7; TD04; TRASPORTO_IN_SOSPESO; idempotenza; gruppo vuoto cancellato; origine_iniziale; sveglia nel ritorno.
- Motivo S51: 3 casi.
- Parità CR1 eseguita (rilievo 11): per ognuno dei 9 CASI_PARTITA_NON_REGISTRATA (__tests__/fixtures/casi-partita-non-registrata.ts, di R1), seminati in PGlite, `_fatture_coda_partita_non_registrata(id)` = atteso = risultato di PREDICATO_SQL_PARTITA_NON_REGISTRATA (importato da @/lib/pagamenti/fattura-partita-non-registrata) eseguito sulle stesse righe.
- PARTITA_NON_REGISTRATA sull'accodamento: in_attesa senza righe → rifiuto; sola scartata di un altro file → rifiuto; viva di un'altra quota e file assente → rifiuto; sola scartata dello stesso file → accodata come ritrasmissione; viva col file → accodata.

- **File:** `__tests__/db/fatture-coda-accoda.test.ts`
- **Verifica:** A fine fase: VT → 1.
- **Perché questo modello:** Precondizioni fiscali dell'accodamento e parità del predicato.

### R2A-4.5 · Test PGlite dell'ordine e della presa — opus/high

Crea __tests__/db/fatture-coda-ordine.test.ts. Gli invii si seminano con db.sql come superuser, rispettando i trigger.
- Livelli 0-3; FIFO per gruppo; data e ordine di selezione; urgente.
- Salto giro = fence.
- Solo funzioni della parte A (prossima, prendi): il caso «QUOTA_ORARIA in testa, senza scavalcare» usa aruba_cancello_prenota, che nasce nella parte B (R2A-5.1, fase F5), e si sposta in R2A-5.2 (C0-11).
- Rifiuti di prendi, con ultimo_giro_il scritto anche sul rifiuto; CEDI_ALLA_SYNC.
- Tentativi di upload con esito NULL contati (CR5).

- **File:** `__tests__/db/fatture-coda-ordine.test.ts`
- **Verifica:** A fine fase: VT → 1.
- **Perché questo modello:** Ordine della decisione 2 e concorrenza della presa.

### R2A-4.6 · Test PGlite del bidello (nella stessa fase del suo codice) — opus/high

Crea __tests__/db/fatture-coda-bidello.test.ts. Il bidello si scrive in 4.1, quindi si prova qui (rilievo 10).
- Voci in_invio con prestito scaduto e invii seminati direttamente (in_volo, incerta con gia_ricevuta_0034 e con upload_5xx, caricata, numerata, da_ritentare).
- I 5 rami di C§9.2, con la prova di rottura senza i rami 2 e 3: la voce resta in_invio.
- Conversioni a e c.
- Consegna di un anomalia_da_consegnare seminata con UPDATE diretto.
- Cancello scaduto liberato.
- Log prestito-scaduto non distinti per voce.

- **File:** `__tests__/db/fatture-coda-bidello.test.ts`
- **Verifica:** A fine fase: VT → 1.
- **Perché questo modello:** Recupero dei prestiti scaduti: esiti fiscali incerti.

### R2A-4.7 · Fotografie nella PR-A: dichiarazione e prove gemelle — opus/high

D6§5. In soglia-fotografia.ts:
- MIGRAZIONI_ATTESE_AL_MERGE con il solo file 1 (nome da $LAVORO/r2-t1.txt) e la ragione;
- posterioriDaRigenerare;
- toccaUnUnico e toccaLeFkUtenti spostati ed esportati.
Porta le tre guardie di F5 su posterioriDaRigenerare. Aggiungi le sei prove gemelle in soglia-fotografia.test.ts.

- **File:** `__tests__/architecture/soglia-fotografia.ts`, `__tests__/architecture/soglia-fotografia.test.ts`, `__tests__/architecture/rls-per-sede.test.ts`, `__tests__/architecture/onconflict-arbitro.test.ts`, `__tests__/architecture/tracce-docente-dichiarate.test.ts`
- **Verifica:** VT: __tests__/architecture/soglia-fotografia.test.ts → 1. Il file 1 esiste da R2A-F3. Le tre guardie, che scandiscono anche i file 2 e 3 scritti in parallelo, le esegue il critico con LOCK-MIGR.
- **Perché questo modello:** Logica dei lock di freschezza: un errore li acceca.

### R2A-4.8 · emissione.ts, parte 1: interfaccia del giornale, esitoTecnico, aggregato S51, livelli — opus/xhigh

D3§9.5.1 e §9.5.3-9.5.6, sopra D1:
- dichiara per intero GiornaleEmissione e ContestoQuota di C§13 (compreso documentoDiProva, che si usa in 5.5); OpzioniEmissione += {giornale?, ritentaLettura?}; solo import type da contratto-db;
- unione completa di EsitoTecnico (§9.5.3), compresi i valori dei rami che implementa R2A-5.5;
- esitiQuote obbligatorio, [] in ogni ritorno anticipato, compreso il 409 di D1;
- aggregato S51 col giornale; livelli col giornale; anno dalla data; cache per utenza;
- export di LABEL_TRASPORTO e motivoTrasporto.
Test 2 in __tests__/lib/aruba/emissione-esito-tecnico.test.ts.

Proprietario in questa fase (rilievo 2), se li rompe, di: tutti i test esistenti di __tests__/lib/aruba, __tests__/api/fattura-emissione.test.ts, fattura-emissione-split.test.ts e l'autotest emissione-supabase-finto.

- **File:** `src/lib/aruba/emissione.ts`, `__tests__/lib/aruba/emissione-esito-tecnico.test.ts`, `__tests__/lib/aruba/*.test.ts esistenti (solo se rotti)`, `__tests__/api/fattura-emissione*.test.ts (solo se rotti)`, `__tests__/helpers/emissione-supabase-finto.test.ts (solo se rotto)`
- **Verifica:** VT: __tests__/lib/aruba/ __tests__/api/fattura-emissione.test.ts __tests__/api/fattura-emissione-split.test.ts __tests__/helpers/emissione-supabase-finto.test.ts → tutti passed (barra finale, C0-3). In questa fase nessun altro compito scrive in __tests__/lib/aruba/.
- **Perché questo modello:** Regola quando il pagamento diventa scartata: effetto fiscale diretto.

### R2A-4.9 · documenti.ts con test — sonnet/high

D3§12, prima parte: documentiDaRisolvere e rigaRegistroPerNumero.
- Solo letture .from, con colonne semplici e filtri elementari: niente embedding, .or o .filter.
- Un errore dà {guasto:true}.
Test __tests__/lib/fatture-coda/documenti.test.ts.

- **File:** `src/lib/fatture-coda/documenti.ts`, `__tests__/lib/fatture-coda/documenti.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Letture tipizzate senza logica fiscale.

### R2A-4.10 · scarti.ts con test — opus/high

D3§15.2:
- ruoliFatturaScartata (S46);
- segnalaScartoSdi, con la RPC letterale;
- riallinea00404: indice con l'anno accanto; al più 3 candidati; UPDATE delle sole colonne WORM, con WHERE sul vecchio filename; tipo preso da ESITO_RICERCA.
Test __tests__/lib/fatture-coda/scarti.test.ts.

- **File:** `src/lib/fatture-coda/scarti.ts`, `__tests__/lib/fatture-coda/scarti.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Scrittura WORM del ricollegamento 00404 (decisione 29).

### R2A-4.11 · precontrollo.ts con lock intestatario (1) — opus/high

D4§5.1:
- motivo partita_non_registrata calcolato con fatturaPartitaNonRegistrata (CR1);
- tipo_invio da STATI_SDI_SCARTO;
- AccessoAruba;
- la proposta non si applica mai senza conferme_proposte uguali;
- CR6: opzione sceltaSalvata.
Nello stesso compito aggiorna __tests__/architecture/intestatario-fattura-un-motore-solo.test.ts: chiamanti lotto-fatture.ts, LottoFatturePanel.tsx e precontrollo.ts.
Test __tests__/lib/fatture-coda/precontrollo.test.ts.

- **File:** `src/lib/fatture-coda/precontrollo.ts`, `__tests__/lib/fatture-coda/precontrollo.test.ts`, `__tests__/architecture/intestatario-fattura-un-motore-solo.test.ts`
- **Verifica:** VT: __tests__/lib/fatture-coda/precontrollo.test.ts __tests__/architecture/intestatario-fattura-un-motore-solo.test.ts → 2.
- **Perché questo modello:** Idoneità fiscale e proposta con conferma obbligatoria (F14).

### R2A-4.12 · stato-coda.ts con test — sonnet/high

D4§5.3:
- componiVoceInElenco nella forma v4;
- azioniAmmesse coi limiti letti solo da ctx.oltreLimite;
- stimeDaPosizioni.
Test __tests__/lib/fatture-coda/stato-coda.test.ts, con la prova di rottura su oltreLimite.

- C0-18 (default D1 e D3): `azioni.togli` vero su `errore` con `solo_invii_non_consegnati=true`, falso con un invio `registrata`, letto solo dal campo di `stato_pagamenti` (prova di rottura); su `errore numero_conteso` `rimetti` vero e `rimanda` falso.
- **File:** `src/lib/fatture-coda/stato-coda.ts`, `__tests__/lib/fatture-coda/stato-coda.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Composizione pura con regole già scritte.

### R2A-4.13 · testi-notifica.ts con test — sonnet/high

D5§10.3. Crea src/lib/fatture-coda/testi-notifica.ts, con testoAvviso esaustivo:
- forma neutra; frase per giornale_non_aperto;
- CR9: {doc} = formattaNumeroFattura dentro un try, col ripiego «una fattura»;
- link costruiti con linkCoda di ui-stati.ts (R2A-3.15);
- orari Europe/Rome.
Test __tests__/lib/fatture-coda/testi-notifica.test.ts: un caso per codice e per TipoAnomalia; fine_gruppo; sonda che vieta «avevi», «tuo» e «tue»; anti-PII; nessun undefined; FPR con l'anno a 2 cifre.

- **File:** `src/lib/fatture-coda/testi-notifica.ts`, `__tests__/lib/fatture-coda/testi-notifica.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Testi esaustivi, in forma meccanica.

### R2A-4.14 · Voce di menu Coda fatture — sonnet/medium

D5§4: in admin-nav-config.ts aggiungi NavItem.contatore? e la voce dopo Contabilità (href PERCORSO_CODA_FATTURE; ruoli admin, coordinator, segreteria). Aggiorna __tests__/ui/admin-nav-config.test.ts.

- **File:** `src/components/features/admin/admin-nav-config.ts`, `__tests__/ui/admin-nav-config.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Configurazione di menu.

### R2A-4.15 · CodaStatoBanner con test — sonnet/high

D5§5.1: sei casi; vince il primo vero; orari assoluti Europe/Rome.
Test __tests__/components/coda/CodaStatoBanner.test.tsx, col silenzio a 15' e 1 s compreso.

- **File:** `src/components/features/admin/pagamenti/coda/CodaStatoBanner.tsx`, `__tests__/components/coda/CodaStatoBanner.test.tsx`
- **Verifica:** VT → 1.
- **Perché questo modello:** Componente di interfaccia.

### R2A-4.16 · CodaVoce con test — sonnet/high

D5§5.3 e §6:
- riga e card, con blocco documenti da invii_aperti[] e fatture[];
- comandi presi solo da azioni;
- slot azioneRitrasmetti (CR3);
- «Togli» con aria-disabled.
Test __tests__/components/coda/CodaVoce.test.tsx.

- **File:** `src/components/features/admin/pagamenti/coda/CodaVoce.tsx`, `__tests__/components/coda/CodaVoce.test.tsx`
- **Verifica:** VT → 1.
- **Perché questo modello:** Componente di interfaccia.

### R2A-4.17 · TogliDallaCodaDialog con test — sonnet/medium

D5§6: conferma, POST togli, rifiuti raggruppati per codice. Test __tests__/components/coda/TogliDallaCodaDialog.test.tsx.

- **File:** `src/components/features/admin/pagamenti/coda/TogliDallaCodaDialog.tsx`, `__tests__/components/coda/TogliDallaCodaDialog.test.tsx`
- **Verifica:** VT → 1.
- **Perché questo modello:** Dialogo semplice.

### R2A-4.18 · RimettiInCodaDialog con test — sonnet/high

D5§6:
- richiesta_id riusato; forza solo per l'admin, con un richiesta_id nuovo; 409 CODA_OLTRE_12_GIORNI;
- voci con azioni.rimetti_serve_forza;
- CR6: testo per proposta_da_confermare;
- nessuna chiamata a /precontrollo dal browser.
Test __tests__/components/coda/RimettiInCodaDialog.test.tsx.

- **File:** `src/components/features/admin/pagamenti/coda/RimettiInCodaDialog.tsx`, `__tests__/components/coda/RimettiInCodaDialog.test.tsx`
- **Verifica:** VT → 1.
- **Perché questo modello:** Dialogo con diversi rami.

### R2A-4.19 · CausaleVoceDialog con test — sonnet/medium

D5§6:
- GET e POST della causale;
- campo vuoto, o uguale alla composta, ⇒ null;
- 409 e 403.
Test __tests__/components/coda/CausaleVoceDialog.test.tsx.

- **File:** `src/components/features/admin/pagamenti/coda/CausaleVoceDialog.tsx`, `__tests__/components/coda/CausaleVoceDialog.test.tsx`
- **Verifica:** VT → 1.
- **Perché questo modello:** Dialogo semplice.

### R2A-4.20 · VerificaEsitoDialog con test — sonnet/high

D5§6:
- azione cerca o rimanda; sveglia;
- rimanda_serve_forza e 409, con «Rimanda comunque» solo per l'admin;
- default D3 (C0-18): una voce `numero_conteso` non arriva mai qui (è `errore`), quindi il dialogo non ha rami né testi per il numero conteso; test: nessuna chiave i18n di numero conteso nel componente;
- nessun «È arrivata».
Test __tests__/components/coda/VerificaEsitoDialog.test.tsx.

- **File:** `src/components/features/admin/pagamenti/coda/VerificaEsitoDialog.tsx`, `__tests__/components/coda/VerificaEsitoDialog.test.tsx`
- **Verifica:** VT → 1.
- **Perché questo modello:** Dialogo con avvisi fiscali.

### R2A-4.21 · SospendiCodaDialog con test — sonnet/medium

D5§6: solo admin; motivo facoltativo; gestione di gia; avvisi_spediti. Test __tests__/components/coda/SospendiCodaDialog.test.tsx.

- **File:** `src/components/features/admin/pagamenti/coda/SospendiCodaDialog.tsx`, `__tests__/components/coda/SospendiCodaDialog.test.tsx`
- **Verifica:** VT → 1.
- **Perché questo modello:** Dialogo semplice.

### R2A-4.22 · FatturaPeriodoDialog con test — sonnet/high

D5§8.4:
- base bonifico o competenza;
- categorie da GET /api/admin/settings/categorie;
- sedi fra le proprie;
- «Controlla» con aria-disabled finché non c'è l'anteprima.
Test __tests__/components/coda/FatturaPeriodoDialog.test.tsx.

- **File:** `src/components/features/admin/pagamenti/coda/FatturaPeriodoDialog.tsx`, `__tests__/components/coda/FatturaPeriodoDialog.test.tsx`
- **Verifica:** VT → 1.
- **Perché questo modello:** Dialogo con filtri.

### R2A-4.23 · AccodaFattureDialog con test — sonnet/xhigh

D5§7:
- fasi selezione, controllo (fette da 50), conferma, invio, fatto;
- spunta obbligatoria per le proposte (F14);
- richiesta_id riusato; i 5 casi di partenza;
- non_valutate con un id nuovo.
Test __tests__/components/coda/AccodaFattureDialog.test.tsx.

- **File:** `src/components/features/admin/pagamenti/coda/AccodaFattureDialog.tsx`, `__tests__/components/coda/AccodaFattureDialog.test.tsx`
- **Verifica:** VT → 1.
- **Perché questo modello:** Flusso condiviso da tutti gli ingressi, con la conferma delle proposte.

## R2A-F5 · SQL parte B, emissione parte 2, lavoratore, route e notifiche

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Scrivere:
- le RPC del lavoratore coi loro test;
- emissione.ts parte 2, con la prova a secco;
- classifica, emetti-voce, risolvi e notifiche;
- la pastiglia del menu, col suo test;
- nove route della coda e il campo coda della riconciliazione.
- **Dipende da:** R2A-F4
- **Critico (opus/max):** Prima, se un compito ha segnalato chiavi mancanti, fa girare CHIAVI-F5 (CONVENZIONI, C0-5). Esegue VT dei 5 test SQL di R2A-F4 (cron, accoda, ordine, bidello, schema) e dei 3 di questa fase → 8; poi LOCK-MIGR.

Rompe su patch reversibile; i test devono diventare rossi:
- p_solo_verifica che scrive;
- chiudi(aruba_429) che allunga un circuito già aperto;
- avvisi_conferma senza controllo del token;
- GET della coda che restituisce la voce oltre i 7 giorni solo con la vista inviate;
- prova a secco saltata;
- classifica che porta un BAD_INPUT a rientro.

Controlla che ogni .rpc delle route abbia p_scuola_ids e, se scrive, anche p_attore. Poi commit.

### R2A-5.1 · Migrazione 2, parte B: RPC del lavoratore — opus/max

Nel file <T1+60s>_fatture_coda_rpc.sql, prima del NOTIFY (D2§5.4-§5.6), le 12 RPC della parte B:
- aruba_cancello_prenota, aruba_cancello_esito;
- fatture_coda_invio_registra con p_solo_verifica boolean DEFAULT false (CR2): con true esegue tutti i controlli di C§7.3, salta NUMERO_GIA_REGISTRATO, non scrive nulla e restituisce {ok, verificato:true};
- numero_bruciato, invio_tenta, invio_esito, invio_ricerca, invio_registrato;
- chiudi: con aruba_429 prende per primo il cancello FOR UPDATE e apre il circuito SOLO se è chiuso, con fino_a = istante del tentativo di upload più recente con esito NULL o http_429 (in mancanza, adesso) + 60';
- segnala_anomalia, avvisi_prendi, avvisi_conferma.
Ognuna col suo REVOKE/GRANT.

- C0-17: `invio_ricerca(non_combacia)` su `da_ritentare` e su `incerta` ⇒ `bruciata numero_conteso` (xml, riga e `consecutivi_429` azzerati); `invio_tenta` su `incerta` solo con ricerca `assente`; `numero_bruciato(…,'numero_conteso')` ⇒ `BAD_INPUT`; `chiudi('errore','numero_conteso')` richiede l'invio conteso ultimo della sua quota, con anomalia intrinseca `numerazione_anomala` (contratto §5.1, §5.2, §9.2).
- **File:** `supabase/migrations/<T1+60s>_fatture_coda_rpc.sql`
- **Verifica:** GUARDIA-SQL → nessuna riga.
`grep -c 'GRANT EXECUTE' <file>` → 17 (5 + 12).
Coppia TDD con 5.2-5.4, verificata dal critico.
- **Perché questo modello:** Giornale dei documenti numerati e circuito 429: concorrenza e fisco.

### R2A-5.2 · Test PGlite del cancello — opus/high

Crea __tests__/db/fatture-coda-cancello.test.ts coi casi di D2§10.2 cancello:
- 65 s, quota, ritmo;
- 12/13 giorni;
- 429 in tutti i rami; circuito ±1 s;
- 401 con un solo avviso al giorno.
In più, CR5: una prenotazione di upload con esito NULL occupa il posto; con limite 2 il terzo tentativo riceve QUOTA_ORARIA.
Spostato da R2A-4.5 (C0-11): la voce in testa che riceve QUOTA_ORARIA resta in testa e nessuna voce successiva la scavalca al giro dopo (usa prossima e prendi della parte A, già verdi).

- **File:** `__tests__/db/fatture-coda-cancello.test.ts`
- **Verifica:** A fine fase: VT → 1.
- **Perché questo modello:** Test del budget verso Aruba.

### R2A-5.3 · Test PGlite del lavoratore — opus/high

Crea __tests__/db/fatture-coda-lavoratore.test.ts coi casi di D2§10.2 lavoratore:
- forma di p_invio, 7 rifiuti; terzo 429 (6 sequenze); 12 giorni; guasti; ricerche; FC001;
- codici ottenibili solo per conversione; gia_a_registro; chiavi monotone.

In più, CR2:
- p_solo_verifica valido → verificato, senza righe nuove;
- ognuno dei 7 rifiuti → BAD_INPUT{campo}, senza righe;
- BAD_INPUT dopo il numero → numero_bruciato più chiudi errore giornale_non_aperto: un solo invio bruciata, voce in errore, prossima non la riprende.

- C0-17: i casi di contratto §17.1 su `numero_conteso` (non_combacia su `da_ritentare` e su `incerta`, `BAD_INPUT` di `numero_bruciato`, `RICERCA_MANCANTE` su `invio_tenta` dopo un non_combacia, `chiudi('emessa')` con la quota contesa ⇒ `INVII_INCOERENTI`, `rimetti` ⇒ al giro dopo un numero nuovo per la sola quota contesa).
- **File:** `__tests__/db/fatture-coda-lavoratore.test.ts`
- **Verifica:** A fine fase: VT → 1.
- **Perché questo modello:** Test del giornale fiscale.

### R2A-5.4 · Test PGlite degli avvisi — opus/high

Crea __tests__/db/fatture-coda-avvisi.test.ts coi casi di C§17.1:
- un fatto, un avviso: casi (a), (b), (c);
- parcheggio, anche consegnato dal bidello; seconda anomalia scartata; INVII_INCOERENTI;
- errore senza anomalia non aggregato;
- fine del gruppo nei 4 casi; R11;
- chiudi con aruba_429: apre il circuito se è chiuso, con fino_a dal tentativo; non fa nulla se è già aperto.

- C0-17: `chiudi('errore','numero_conteso')` ⇒ una riga `errore` non aggregata, con `a_tutti_gli_admin` e `dati.anomalia='numerazione_anomala'`, nessuna riga `anomalia` né `verifica_manuale`.
- **File:** `__tests__/db/fatture-coda-avvisi.test.ts`
- **Verifica:** A fine fase: VT → 1.
- **Perché questo modello:** Regola «un fatto, un avviso» (decisione 20).

### R2A-5.5 · emissione.ts, parte 2: prova a secco e giornale — opus/max

D3§9.5.2 su src/lib/aruba/emissione.ts.
- Prova a secco in TS prima di ensureToken: XML composto con NUMERO_SEGNAPOSTO_PROVA importato da @/lib/aruba/confronto-documento (rilievo 5), poi estraiDatiDocumento. Se fallisce: dato-xml-non-componibile, senza prenotazione né numero.
- documentoDiProva dentro ContestoQuota. La verifica SQL (p_solo_verifica) la fa il giornale.
- Dopo il numero, controllo del documento vero contro il numero prenotato.
- rigaRegistro con satisfies RigaRegistroDelGiornale; baseRow = {...rigaRegistro, xml_inviato}.
- Pausa di ritmo con sessione.attendi.
- Ordine: apriInvio → upload → esitoInvio → INSERT.
- Numero bruciato col lordo della quota.
Test 1 in __tests__/lib/aruba/emissione-giornale.test.ts.

Proprietario in questa fase dei test esistenti che rompe: aruba, emissione in api, autotest del finto.

- **File:** `src/lib/aruba/emissione.ts`, `__tests__/lib/aruba/emissione-giornale.test.ts`, `__tests__/lib/aruba/*.test.ts esistenti (solo se rotti)`, `__tests__/api/fattura-emissione*.test.ts (solo se rotti)`, `__tests__/helpers/emissione-supabase-finto.test.ts (solo se rotto)`
- **Verifica:** VT: __tests__/lib/aruba/ __tests__/api/fattura-emissione.test.ts __tests__/api/fattura-emissione-split.test.ts __tests__/helpers/emissione-supabase-finto.test.ts → tutti passed (barra finale, C0-3).
`grep -c 'NUMERO_SEGNAPOSTO_PROVA = ' src/lib/aruba/emissione.ts` → 0 (lo importa, non lo definisce).
- **Perché questo modello:** Cuore fiscale: numero, XML e ordine rispetto all'upload.

### R2A-5.6 · classifica.ts con test (tabelle v5) — opus/high

D3§11 con CR2:
- prenotazione-negata documento_non_valido → X xml_non_componibile, effetto prosegui, nessun numero;
- fermata-prima-dell-upload per BAD_INPUT dopo il numero → X giornale_non_aperto, effetto ferma;
- un BAD_INPUT non diventa mai G né rientro.
Nomi delle mappe di contratto-db.
Test 8 in __tests__/lib/fatture-coda/classifica.test.ts.

- C0-17: Tabella C di D3 con `numero-conteso` ⇒ X `numero_conteso` in reinvio e verifica; `numero_conteso` fuori dalle gravità D e C di §11.4; al passo 4c conta anche una quota il cui ultimo invio è `bruciata numero_conteso` di un giro precedente; `cerca_poi_invia` con `non_combacia` ⇒ `numero-conteso`, mai upload. Test per ciascun caso, con un altro `incerta` aperto (la voce chiude `da_verificare`) e senza (chiude `errore`).
- **File:** `src/lib/fatture-coda/classifica.ts`, `__tests__/lib/fatture-coda/classifica.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Decide le chiusure: sbagliare fa bruciare numeri o chiudere voci fiscali.

### R2A-5.7 · emetti-voce.ts con test — opus/high

D3§10:
- causale a tre modi;
- emettiFatturaPagamento col giornale e senza ritentativi;
- «ricorda» solo con proposta confermata (INTESTATARIO_ORIGINE.proposta_bonifico e le 5 condizioni di lotto/route.ts:313-318) oppure con persona e ricordaScheda;
- attore del gruppo.
Test 9 in __tests__/lib/fatture-coda/emetti-voce.test.ts. Documenta l'ordine delle chiamate e copre, una per una, le 5 condizioni di fattura-lotto-ricorda-intestatario.test.ts (servono a R2A-6.9).

- **File:** `src/lib/fatture-coda/emetti-voce.ts`, `__tests__/lib/fatture-coda/emetti-voce.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Orchestrazione di un'emissione fiscale con proposta d'intestatario.

### R2A-5.8 · risolvi.ts con test — opus/high

D3§12:
- ricerca a 5 campi con p_invio_id; invio_ricerca anche con esito illeggibile;
- regola dei 12 giorni senza prenotare;
- reinvio solo tramite ctx.giornale.tentaReinvio, tipizzato con un'interfaccia locale GiornaleReinvio: nessun import da giro.ts;
- anomalie parcheggiate subito con ctx.parcheggia;
- AccessoAruba.
Test 10 in __tests__/lib/fatture-coda/risolvi.test.ts.

- **File:** `src/lib/fatture-coda/risolvi.ts`, `__tests__/lib/fatture-coda/risolvi.test.ts`
- **Verifica:** VT → 1; `grep -c "from './giro'" src/lib/fatture-coda/risolvi.ts` → 0.
- **Perché questo modello:** Decide ricerca, registrazione e reinvio dopo un esito incerto.

### R2A-5.9 · notifiche.ts (spedisciAvvisiCoda) con test — opus/high

D5§10.1:
- prendi con la RPC letterale; idempotenza su entita_id;
- destinatari senza doppioni, con leggiAdminReali;
- una enqueueNotifiche per avviso, bufferMin 0, senza scuolaId;
- testi da testoAvviso (R2A-4.13);
- rilettura, poi conferma; non lancia mai.
Test __tests__/lib/fatture-coda-notifiche.test.ts, con l'admin che ha accodato che riceve una sola notifica.

- **File:** `src/lib/fatture-coda/notifiche.ts`, `__tests__/lib/fatture-coda-notifiche.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Outbox con lease, idempotenza e riscontro (F19).

### R2A-5.10 · Pastiglia e bollino nella navigazione, con test proprio — sonnet/medium

D5§4:
- pastiglia kv-nav-contatore e bollino kv-nav-bollino in AdminSidebar e AdminMenuSheet;
- bollino con testo nascosto sul pulsante Menu di AdminBottomNav.

Test nuovo __tests__/ui/admin-nav-contatore-coda.test.tsx (rilievo 10), con useContatoreCoda finto (in_attesa 3, errori 1, da_verificare_tot 2, bollino true):
- pastiglia «3», bollino presente;
- nome accessibile «Coda fatture, 3 in coda, 1 con errori, 2 da verificare»;
- su AdminBottomNav, bollino col testo nascosto;
- con disponibile:false nessun numero, e la voce resta.
Controllo negativo eseguito: togliendo il bollino il test diventa rosso.

I quattro test esistenti che montano questi componenti SENZA CodaFattureContatoreProvider [V] devono restare verdi grazie al valore neutro di R2A-3.20; se diventano rossi, li ripara questo compito (C0-6): __tests__/a11y/contrasto-bordi-superfici-pubbliche.test.tsx (:519, :548, :605), __tests__/a11y/contrasto-cascata.test.tsx (:536, :541), __tests__/components/sede-mobile-e-ricarica.test.tsx (:53, :175), __tests__/components/Modal-dialogo-modale.test.tsx (:84, :363).

- **File:** `src/components/features/admin/AdminSidebar.tsx`, `src/components/features/admin/AdminMenuSheet.tsx`, `src/components/features/admin/AdminBottomNav.tsx`, `__tests__/ui/admin-nav-contatore-coda.test.tsx`, `__tests__/ui/admin-bottom-nav.test.tsx (solo se rosso)`, `__tests__/ui/cambia-profilo-nei-menu.test.tsx (solo se rosso)`, `__tests__/a11y/contrasto-bordi-superfici-pubbliche.test.tsx (solo se rosso)`, `__tests__/a11y/contrasto-cascata.test.tsx (solo se rosso)`, `__tests__/components/sede-mobile-e-ricarica.test.tsx (solo se rosso)`, `__tests__/components/Modal-dialogo-modale.test.tsx (solo se rosso)`
- **Verifica:** VT: __tests__/ui/admin-nav-contatore-coda.test.tsx __tests__/ui/admin-bottom-nav.test.tsx __tests__/ui/cambia-profilo-nei-menu.test.tsx __tests__/a11y/contrasto-bordi-superfici-pubbliche.test.tsx __tests__/a11y/contrasto-cascata.test.tsx __tests__/components/sede-mobile-e-ricarica.test.tsx __tests__/components/Modal-dialogo-modale.test.tsx → 7.
- **Perché questo modello:** Resa di interfaccia con test di componente.

### R2A-5.11 · Route GET/POST /api/pagamenti/fattura/coda — opus/high

D4§6 e §9, C§12, .claude/rules/route-api.md.

GET:
- solo_riepilogo; viste;
- voce= e pagamento= fuori dallo storico, entro 24 mesi;
- stato_pagamenti per i pagamenti della pagina; se fallisce → 500 LETTURA_FALLITA;
- componiVoceInElenco.

POST:
- 422 prima di ogni lettura; assertPagamentiInScope; idempotenza e CODA_RICHIESTA_ALTRUI;
- precontrollo autorevole; RPC accoda letterale;
- `export const maxDuration = 300` (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md).

Coda assente: GET 200 disponibile:false; POST 503.
Test __tests__/api/fattura-coda-accoda.test.ts e __tests__/api/fattura-coda-stato.test.ts.

- **File:** `src/app/api/pagamenti/fattura/coda/route.ts`, `__tests__/api/fattura-coda-accoda.test.ts`, `__tests__/api/fattura-coda-stato.test.ts`
- **Verifica:** VT dei due test → 2.
- **Perché questo modello:** Perimetro fra sedi, idempotenza e la forma v4 usata da tutta la UI.

### R2A-5.12 · Route precontrollo — sonnet/high

C§12: POST /coda/precontrollo con al massimo 50 voci, maxDuration 60, nessuna chiamata ad Aruba né scrittura. Test __tests__/api/fattura-coda-precontrollo.test.ts.

- **File:** `src/app/api/pagamenti/fattura/coda/precontrollo/route.ts`, `__tests__/api/fattura-coda-precontrollo.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Route sottile sopra un modulo già scritto.

### R2A-5.13 · Route periodo — sonnet/high

D4§8: controlli sulle date; pagine da 1000 fino a 5000 righe; senza_competenza; maxDuration 60. Test __tests__/api/fattura-coda-periodo.test.ts, con controllo positivo su 2500 righe.

- **File:** `src/app/api/pagamenti/fattura/coda/periodo/route.ts`, `__tests__/api/fattura-coda-periodo.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Route con paginazione.

### R2A-5.14 · Route situazione — sonnet/medium

D4§11: id fuori sede omessi; stato_pagamenti; stima delle voci in coda. Test __tests__/api/fattura-coda-situazione.test.ts.

- **File:** `src/app/api/pagamenti/fattura/coda/situazione/route.ts`, `__tests__/api/fattura-coda-situazione.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Route sottile.

### R2A-5.15 · Route togli — sonnet/medium

D4§10: fatture_coda_togli letterale; divisione fra fatte e rifiutate. Test __tests__/api/fattura-coda-togli.test.ts.

- **File:** `src/app/api/pagamenti/fattura/coda/togli/route.ts`, `__tests__/api/fattura-coda-togli.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Route sottile.

### R2A-5.16 · Route rimetti — sonnet/high

D4§10 più CR6:
- forza da un non admin → 403 prima di ogni lettura;
- pre-controllo con origine_iniziale e sceltaSalvata; le voci con documento costruito si saltano;
- RPC con p_forza; 409 CODA_OLTRE_12_GIORNI.
maxDuration 300. Test __tests__/api/fattura-coda-rimetti.test.ts.

- **File:** `src/app/api/pagamenti/fattura/coda/rimetti/route.ts`, `__tests__/api/fattura-coda-rimetti.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Route con rami su forza e proposta.

### R2A-5.17 · Route urgente — sonnet/medium

D4§10. Test __tests__/api/fattura-coda-urgente.test.ts.

- **File:** `src/app/api/pagamenti/fattura/coda/urgente/route.ts`, `__tests__/api/fattura-coda-urgente.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Route sottile.

### R2A-5.18 · Route causale — sonnet/medium

D4§10: GET con modificabile preso da azioni.causale; POST; 403 e 409. Test __tests__/api/fattura-coda-causale.test.ts.

- **File:** `src/app/api/pagamenti/fattura/coda/causale/route.ts`, `__tests__/api/fattura-coda-causale.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Route sottile.

### R2A-5.19 · Route verifica — sonnet/medium

D4§10: forza senza admin → 403 prima della RPC; risposta asincrona con prossimo_giro_il. Test __tests__/api/fattura-coda-verifica.test.ts.

- **File:** `src/app/api/pagamenti/fattura/coda/verifica/route.ts`, `__tests__/api/fattura-coda-verifica.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Route sottile.

### R2A-5.20 · Campo coda nella riconciliazione — sonnet/high

D4§7, su riconciliazione/route.ts:
- sediAttive anticipata;
- stato_pagamenti in try/catch, a blocchi di 2000; qualunque errore → coda null, coda_disponibile false e un solo error rpc-guasta;
- perFatturazione copia coda;
- nessun fattura_stato ===.
Crea __tests__/api/riconciliazione-coda.test.ts.

- **File:** `src/app/api/pagamenti/riconciliazione/route.ts`, `__tests__/api/riconciliazione-coda.test.ts`, `__tests__/api/pagamenti-riconciliazione*.test.ts (solo se rossi)`, `__tests__/api/riconciliazione-ripresa-trasporto.test.ts (solo se rosso)`
- **Verifica:** VT: __tests__/api/riconciliazione-coda.test.ts __tests__/api/pagamenti-riconciliazione __tests__/api/riconciliazione-ripresa-trasporto.test.ts → 13.
- **Perché questo modello:** Estensione di una rotta grande, con degradazione pulita.

## R2A-F6a · SQL parte C, giro, sync, FatturaButton, 410

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Chiudere le RPC dello staff e delle letture. Scrivere il lavoratore (porte e giro in un compito solo), la sync col cancello e i suoi test, la route di sospensione, FatturaButton (con la rinomina in MovimentoDialog), FatturaChip e i 410.
Sono i prerequisiti delle pagine di R2A-F6b (rilievo 1c).
- **Dipende da:** R2A-F5
- **Critico (opus/max):** Esegue VT: __tests__/db → tutti i file passed (schema, cron, accoda, ordine, bidello, cancello, lavoratore, avvisi, staff, scarto-sdi, più i 3 di R1 e di prima). Poi LOCK-MIGR.

Rompe su patch reversibile; i test devono diventare rossi:
- togli ammesso con un invio;
- rimetti senza il predicato CR1 sulle voci senza invii (C0-8);
- stato_pagamenti che include un invio caricata;
- sospendi(NULL, …) che richiede un admin;
- giro che richiude in rientro dopo un BAD_INPUT;
- FatturaButton che fa ancora la PATCH;
- sync che scrive error nel caso CR7.

Poi commit.

### R2A-6.1 · Migrazione 2, parte C: staff, letture, oblio — opus/max

Nel file <T1+60s>_fatture_coda_rpc.sql, prima del NOTIFY (D2§5.6-§5.8), le 13 RPC:
- togli (S29 con l'eccezione del default D1: `errore` con invii tutti `rifiutata`/`bruciata` ⇒ `tolta`, via `_fatture_coda_solo_invii_non_consegnati`; C0-18);
- rimetti (forza admin, tardiva_autorizzata_il, predicato CR1 per le voci senza invii);
- urgente, causale;
- richiedi_verifica (solo `da_verificare`: una voce `errore numero_conteso` riceve `STATO_NON_VALIDO`, C0-18);
- sospendi (p_attore NULL = sistema, motivo obbligatorio), riprendi;
- fatture_coda_segnala_scarto_sdi (p_codice_sdi NULL oppure 5 cifre; p_doppione nei 4 valori; un solo avviso). Nome esatto di C S2 e §9 (contratto.md:160 e :515 [V]), lo stesso di D2, di D3 (scarti.ts, segnalaScartoSdi, R2A-4.10) e di RPC_CODA: entra nel GRANT, nel REVOKE e nel lock specchio, quindi niente forme abbreviate (C0-9);
- riepilogo, posizioni(NULL), stato_pagamenti (invii_oltre_limite e il campo additivo solo_invii_non_consegnati, C0-18), salute, oblio.

Conteggio (rilievo 3): nel file 2 esattamente 30 RPC con GRANT. Le altre 2 di RPC_CODA stanno nel file 3; il controllo sull'insieme lo fa il lock specchio (R2A-9.9).

- **File:** `supabase/migrations/<T1+60s>_fatture_coda_rpc.sql`
- **Verifica:** GUARDIA-SQL → nessuna riga.
`grep -c 'GRANT EXECUTE' <file>` → 30.
Coppia TDD con 6.2 e 6.3.
- **Perché questo modello:** Azioni dello staff su voci fiscali: forza, 12 giorni, doppioni SdI.

### R2A-6.2 · Test PGlite dello staff, con l'arresto d'urgenza — opus/high

Crea __tests__/db/fatture-coda-staff.test.ts coi casi di C§17.1 staff, escluso accoda:
- togli; rimetti (forza, tardiva, stesso XML); urgente; causale;
- richiedi_verifica con gli azzeramenti; sospendi e riprendi;
- riepilogo; posizioni(NULL); stato_pagamenti a 12 e 13 giorni per stato;
- salute dopo una rimessa a 3 giorni; oblio; verificaVocabolari.

Arresto d'urgenza (rilievo 13), eseguito col testo ESATTO della procedura di STOP: `select public.fatture_coda_sospendi(NULL, 'arresto d''urgenza durante il rilascio')`, via db.sql come superuser (è il ruolo della CLI). Esito: ok, sospesa true, sospesa_da NULL, avvisi sospesa agli accodanti in attesa, info sospesa con tipo sistema. Poi riprendi da parte di un admin.
Negativi: sospendi(NULL, NULL) e sospendi(NULL, '') → BAD_INPUT; sospendi da un non admin → ATTORE_NON_ADMIN.

Casi CR1 di rimetti (C0-8). D2 chiede PARTITA_NON_REGISTRATA «in 4 casi, anche in rimetti» (d2-schema-rpc-cron.md:1214 [V]), e rimetti usa il predicato comune sulle voci senza invii (d2:753 [V], R2A-6.1). Con la fixture CASI_PARTITA_NON_REGISTRATA di R1-1.3, su una voce in errore SENZA invii:
- casi in cui il predicato è vero (almeno 2 e 5, dove le forme sbagliate divergono) → rimetti rifiuta con PARTITA_NON_REGISTRATA e non scrive nulla;
- casi in cui è falso (almeno 3 e 4) → rimetti non rifiuta per quel motivo;
- una voce CON invii non passa dal predicato.
Prova di rottura eseguita su patch reversibile: rimetti senza la chiamata a _fatture_coda_partita_non_registrata, e rimetti col predicato nella forma unione di D2 v4 (il caso 3 diverge), fanno diventare rosso almeno un caso. Il lock 9.9 a) controlla solo che la funzione sia chiamata: la semantica la prova questo test.

- C0-18: `togli` di una voce `errore` con soli invii `rifiutata`/`bruciata` ⇒ `tolta`, invii a giornale; con un invio `registrata` ⇒ `NUMERO_GIA_ASSEGNATO`; `richiedi_verifica` su `errore numero_conteso` ⇒ `STATO_NON_VALIDO`; `stato_pagamenti.solo_invii_non_consegnati` nei due casi.
- **File:** `__tests__/db/fatture-coda-staff.test.ts`
- **Verifica:** A fine fase: VT → 1.
- **Perché questo modello:** Test SQL su regole fiscali e sull'unica leva di STOP.

### R2A-6.3 · Test PGlite degli scarti SdI — opus/high

Crea __tests__/db/fatture-coda-scarto-sdi.test.ts:
- i 4 valori;
- il caso (d) non_identico con una sola riga;
- non_risolto ripetuto 6 volte; ricollegato;
- uscita da doppioni_aperti;
- p_codice_sdi '0404' → BAD_INPUT;
- voce non emessa invariata;
- doppione ritrasmesso da un nuovo accodamento.

- **File:** `__tests__/db/fatture-coda-scarto-sdi.test.ts`
- **Verifica:** A fine fase: VT → 1.
- **Perché questo modello:** Decisione 29.

### R2A-6.4 · porte.ts e giro.ts in un compito solo, con i loro test — opus/max

D3§13 (I15, I16) con CR2. I due file si importano a vicenda (rilievo 1c): un compito solo.

porte.ts:
- PorteGiro e porteReali;
- attendi è un sonno e mai un tetto; adesso = Date.now;
- avvisi.spedisci = spedisciAvvisiCoda.

giro.ts:
- giornaleDi, unico costruttore di invio_registra e invio_tenta: prenotaInvio chiama prima coda.invioVerifica (p_solo_verifica) e poi prenotaTentativo; un BAD_INPUT della verifica → documento_non_valido, senza numero; un BAD_INPUT dopo il numero → bruciaNumero con ESITO_INVIO.giornale_non_aperto;
- tentaReinvio;
- parcheggia prima di chiudi, anche senza chiusura;
- chiusura con ripiego; log per voce; EsitoGiro;
- nessun setTimeout né Promise.race.

Test:
- __tests__/lib/fatture-coda/giro.test.ts (test 11 coi casi CR2: al giro dopo nessun secondo numero);
- __tests__/lib/fatture-coda/porte.test.ts: porteReali collega i moduli veri e attendi(ms) aspetta ms senza Promise.race (spie).

- **File:** `src/lib/fatture-coda/porte.ts`, `src/lib/fatture-coda/giro.ts`, `__tests__/lib/fatture-coda/giro.test.ts`, `__tests__/lib/fatture-coda/porte.test.ts`
- **Verifica:** VT: __tests__/lib/fatture-coda/giro.test.ts __tests__/lib/fatture-coda/porte.test.ts → 2.
- **Perché questo modello:** È il lavoratore che invia davvero ad Aruba: ritmo, numeri, chiusure.

### R2A-6.5 · Sync col cancello, con i suoi test nuovi ed esistenti (un compito solo) — opus/xhigh

D3§15.1 su sync/route.ts. La route e l'adeguamento dei test esistenti stanno insieme (rilievo 1b).

Route:
- cancello pigro; un 429 ferma la sync;
- 00404 a tre esiti;
- fattura_scartata con ruoliFatturaScartata, escluso chi ha accodato; se la segnalazione manca, a tutto lo staff;
- CR7: lista vuota già prima dell'esclusione → error scarto-senza-destinatari come oggi; lista vuota solo per l'esclusione → info scarto-solo-chi-ha-accodato (C0-20);
- spedisciAvvisiCoda; battito con livelloLogCoda;
- EsitoToken 'errore' → 'lettura-fallita'; nessun letterale di dominio.

Test:
- nuovi: __tests__/api/fattura-sync-cancello.test.ts e __tests__/api/fattura-sync-00404.test.ts, coi casi CR7;
- helper __tests__/helpers/cancello-finto.ts;
- adeguamento degli esistenti: fattura-sync.test.ts, fattura-sync-notifiche.test.ts, fattura-sync-destinatari-sede.test.ts, cron-battito.test.ts, e cron-secret.test.ts se diventa rosso.

- **File:** `src/app/api/pagamenti/fattura/sync/route.ts`, `__tests__/api/fattura-sync-cancello.test.ts`, `__tests__/api/fattura-sync-00404.test.ts`, `__tests__/helpers/cancello-finto.ts`, `__tests__/api/fattura-sync.test.ts`, `__tests__/api/fattura-sync-notifiche.test.ts`, `__tests__/api/fattura-sync-destinatari-sede.test.ts`, `__tests__/api/cron-battito.test.ts`, `__tests__/api/cron-secret.test.ts (solo se rosso)`
- **Verifica:** VT: __tests__/api/fattura-sync __tests__/api/cron-battito.test.ts __tests__/api/cron-secret.test.ts → 7.
- **Perché questo modello:** Scarti SdI, 00404 e cancello condiviso con la coda.

### R2A-6.6 · Route sospensione e isolamento — sonnet/high

D4§10:
- requireStaff(request, ['admin']);
- sospendi o riprendi con p_attore: auth.user.id;
- poi await spedisciAvvisiCoda; se fallisce, warn coda-avvisi-non-spediti.
Aggiungi la voce AMMESSE sospensione:POST in isolamento-sede-coverage, misurata.
Test __tests__/api/fattura-coda-sospensione.test.ts.

- **File:** `src/app/api/pagamenti/fattura/coda/sospensione/route.ts`, `__tests__/api/fattura-coda-sospensione.test.ts`, `__tests__/architecture/isolamento-sede-coverage.test.ts`
- **Verifica:** VT: __tests__/api/fattura-coda-sospensione.test.ts __tests__/architecture/isolamento-sede-coverage.test.ts → 2.
- **Perché questo modello:** Route admin con lock di isolamento.

### R2A-6.7 · FatturaButton in coda, con la rinomina in MovimentoDialog — sonnet/xhigh

D5§8.5 e §12. FatturaButton:
- trigger «Invia fattura» e «Riprova fattura» invariati; modale «Metti in coda la fattura»; primario «Metti in coda»;
- prop coda, con badge; spunta Urgente;
- onEmessa → onAccodata;
- POST singolo a PERCORSI_CODA.accoda;
- via la PATCH /api/admin/students e la POST vecchia.

Verificato: solo MovimentoDialog passa onEmessa. Nello stesso compito, in MovimentoDialog.tsx: rinomina in onAccodata e passa coda={riga.coda}; aggiorna MovimentoDialog.test.tsx (:57, :334). Gli altri montaggi non passano onEmessa, e i loro test mockano FatturaButton (verificato): non cambiano.

Test da aggiornare: FatturaButton.test.tsx, FatturaButton-intestatario.test.tsx, FatturaButton-scarico.test.tsx, motivo-scarto-solo-in-segreteria.test.tsx ed errore-server-tradotto-cockpit.test.tsx, che montano il FatturaButton vero.

- **File:** `src/components/features/admin/pagamenti/FatturaButton.tsx`, `src/components/features/admin/pagamenti/MovimentoDialog.tsx`, `__tests__/components/FatturaButton.test.tsx`, `__tests__/components/FatturaButton-intestatario.test.tsx`, `__tests__/components/FatturaButton-scarico.test.tsx`, `__tests__/components/motivo-scarto-solo-in-segreteria.test.tsx`, `__tests__/features/admin/errore-server-tradotto-cockpit.test.tsx`, `__tests__/components/MovimentoDialog.test.tsx`, `__tests__/components/MovimentoDialog-componi-riapertura.test.tsx (solo se rosso)`, `__tests__/components/StoricoPagamenti-fattura-scarico.test.tsx (solo se rosso)`
- **Verifica:** VT degli 8 file elencati (StoricoPagamenti compreso) → 8.
- **Perché questo modello:** Componente con modale e anteprima, montato in più punti.

### R2A-6.8 · FatturaChip con coda — sonnet/low

D5§8.6: prop coda, con una mappa sugli stati attivi. Aggiorna __tests__/components/FatturaChip.test.tsx.

- **File:** `src/components/features/admin/pagamenti/FatturaChip.tsx`, `__tests__/components/FatturaChip.test.tsx`
- **Verifica:** VT → 1.
- **Perché questo modello:** Modifica piccola.

### R2A-6.9 · 410 sui vecchi POST di emissione e migrazione dei vecchi test — sonnet/high

D4§12.1. POST /api/pagamenti/fattura e POST /lotto → 410 con codice letterale FATTURA_EMISSIONE_SOLO_IN_CODA, più warn emissione-diretta-rifiutata. Il GET del PDF resta. lotto/route.ts si riduce all'handler di rifiuto e non importa più da lotto-fatture.

Il codice FATTURA_EMISSIONE_SOLO_IN_CODA è uno dei 15 di CHIAVI_MESSAGGIO_CODA (C§12, contratto.md:612 [V]): lo dichiarano in CODICI_ERRORE, e lo traducono in messages/{it,en}/shared.json, R2A-3.13, in R2A-F3 (C0-4). Questo compito NON possiede esito-fetch.ts né shared.json: se il codice mancasse, STOP e rapporto al critico, che lo assegna a un compito sequenziale.

Test:
- crea __tests__/api/fattura-emissione-diretta-410.test.ts;
- in fattura-route.test.ts, casi POST → 410;
- prima di eliminare fattura-lotto.test.ts e fattura-lotto-ricorda-intestatario.test.ts, elenca in $LAVORO/asserzioni-lotto.txt le loro asserzioni e controlla che le 5 condizioni siano coperte da emetti-voce.test.ts (R2A-5.7), poi elimina;
- trasforma fattura-intestatario-route.test.ts e fattura-route-quota-estranea.test.ts in test diretti su emettiFatturaPagamento.

- **File:** `src/app/api/pagamenti/fattura/route.ts`, `src/app/api/pagamenti/fattura/lotto/route.ts`, `__tests__/api/fattura-emissione-diretta-410.test.ts`, `__tests__/api/fattura-route.test.ts`, `__tests__/api/fattura-lotto.test.ts`, `__tests__/api/fattura-lotto-ricorda-intestatario.test.ts`, `__tests__/api/fattura-intestatario-route.test.ts`, `__tests__/api/fattura-route-quota-estranea.test.ts`, `$LAVORO/asserzioni-lotto.txt (fuori dal repo)`
- **Verifica:** VT: __tests__/api/fattura-emissione-diretta-410.test.ts __tests__/api/fattura-route.test.ts __tests__/api/fattura-intestatario-route.test.ts __tests__/api/fattura-route-quota-estranea.test.ts __tests__/architecture/errori-con-codice.test.ts → 5 (C0-4).
`test ! -e __tests__/api/fattura-lotto.test.ts`.
- **Perché questo modello:** Rimozione di percorsi, conservando la copertura.

## R2A-F6b · Pagina della coda e ingressi

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Montare la pagina, gli ingressi e la sezione della scheda alunno sopra FatturaButton e FatturaChip già pronti; togliere il vecchio pannello del lotto.
- **Dipende da:** R2A-F6a
- **Critico (sonnet/xhigh):** Prima fa girare CHIAVI-F6b (CONVENZIONI, C0-5), in sequenza dopo 6.10-6.15, con le chiavi segnalate; poi VT: __tests__/components/coda/CodaFatturePanel.test.tsx → 1. Rompe su patch reversibile; i test devono diventare rossi:
- FatturaButton in linea mostrato con fatture[].scartata ma ritrasmetti=false;
- una chiave 941-943 rimossa;
- casella della lista mostrata senza idoneo_multi.

Controlla che LottoFatturePanel non sia più importato da nessun file (`grep -rn LottoFatturePanel src`). Poi commit.

### R2A-6.10 · Pagina Coda fatture e pannello — sonnet/xhigh

D5§5 e §6. Crea src/app/(dashboard)/admin/pagamenti/coda-fatture/page.tsx (client, dentro Suspense, fuori da SedeRequired) e coda/CodaFatturePanel.tsx:
- schede, filtri, deep link voce= e pagamento=, contatori, elenco;
- FatturaButton «Riprova fattura» nello slot di CodaVoce, solo con azioni.ritrasmetti (CR3);
- nessun «Esegui adesso».
Una chiave i18n mancante si elenca nel rapporto (chiave, testo it, testo en): la aggiunge CHIAVI-F6b, che gira in sequenza DOPO tutti i compiti paralleli di questa fase, 6.15 compreso (C0-5). Fino ad allora il test del pannello può fallire solo su quella chiave, e lo si dichiara nel rapporto.
Test __tests__/components/coda/CodaFatturePanel.test.tsx.

- **File:** `src/app/(dashboard)/admin/pagamenti/coda-fatture/page.tsx`, `src/components/features/admin/pagamenti/coda/CodaFatturePanel.tsx`, `__tests__/components/coda/CodaFatturePanel.test.tsx`
- **Verifica:** VT → 1.
- **Perché questo modello:** Pagina di interfaccia ricca, su un contratto fisso.

### R2A-6.11 · TransazioniPanel con situazione — sonnet/medium

D5§8.2: POST situazione e coda passata al FatturaButton. Aggiorna __tests__/components/TransazioniPanel.test.tsx.

- **File:** `src/components/features/admin/pagamenti/TransazioniPanel.tsx`, `__tests__/components/TransazioniPanel.test.tsx`
- **Verifica:** VT → 1.
- **Perché questo modello:** Aggancio a un'API già pronta.

### R2A-6.12 · Lista Pagamenti: selezione multipla — sonnet/high

D5§8.2:
- situazione a fette di TETTO_SITUAZIONE;
- casella solo con idoneo_multi; bersaglio 44×44 sulla card;
- AccodaFattureDialog con origine lista_pagamenti; coda passata al FatturaButton.
Crea PaymentsDashboard-coda-assente.test.tsx.

- **File:** `src/components/features/admin/pagamenti/PaymentsDashboard.tsx`, `src/components/features/admin/pagamenti/PagamentoCardMobile.tsx`, `src/components/features/admin/pagamenti/PagamentoDrawer.tsx`, `__tests__/components/PaymentsDashboard-coda-assente.test.tsx`, `__tests__/components/PagamentoDrawer.test.tsx (solo se rosso)`, `__tests__/components/PagamentoCardMobile.test.tsx (solo se rosso)`, `__tests__/components/pagamenti-contabilita.test.tsx (solo se rosso)`, `__tests__/components/importi-euro-italiani.test.tsx (solo se rosso)`
- **Verifica:** VT dei 4 test più __tests__/components/importi-euro-italiani.test.tsx, che monta PaymentsDashboard (:156) [V] → 5 (C0-6).
- **Perché questo modello:** Ingresso UI su tre componenti collegati.

### R2A-6.13 · Scheda alunno: Pagamenti e fatture — sonnet/high

D5§8.3. Crea PagamentiFattureAlunno.tsx:
- GET /api/pagamenti?alunno_id e POST situazione;
- casella; FatturaChip;
- FatturaButton per qualunque saldato.
Montalo in StudentDetailPanel dopo la riga 1206.
Crea __tests__/components/PagamentiFattureAlunno.test.tsx.

- **File:** `src/components/features/admin/pagamenti/PagamentiFattureAlunno.tsx`, `src/components/features/admin/StudentDetailPanel.tsx`, `__tests__/components/PagamentiFattureAlunno.test.tsx`, `__tests__/components/StudentDetailPanel-*.test.tsx (solo se rossi)`, `__tests__/a11y/schede-alunno-a11y.test.tsx (solo se rosso)`, `__tests__/components/legami-familiari-ui-cablaggio.test.tsx (solo se rosso)`
- **Verifica:** VT: __tests__/components/PagamentiFattureAlunno.test.tsx __tests__/components/StudentDetailPanel __tests__/a11y/schede-alunno-a11y.test.tsx __tests__/components/legami-familiari-ui-cablaggio.test.tsx → 7 (1 + 4 file StudentDetailPanel* a HEAD 29bb04c7 [V] + 2; i due ultimi montano StudentDetailPanel, :269 e :181, C0-6).
- **Perché questo modello:** Sezione di interfaccia nuova.

### R2A-6.14 · Link nell'intestazione di Contabilità, con test proprio — sonnet/low

D5§4: in src/app/(dashboard)/admin/pagamenti/page.tsx (:76-79), link-pillola «Coda fatture ({in_attesa})» e «Fattura tutto il periodo». ContabilitaNav non si tocca.

Test nuovo __tests__/components/pagamenti-intestazione-coda.test.tsx (rilievo 10). Monta la PAGINA, non ContabilitaNav, con mock di next/navigation, di next-intl, di PaymentsDashboard e di useContatoreCoda (in_attesa 4):
- link «Coda fatture (4)» con href PERCORSO_CODA_FATTURE;
- link «Fattura tutto il periodo».
Controllo negativo eseguito: senza contatore, il testo atteso non c'è e il test diventa rosso.

- **File:** `src/app/(dashboard)/admin/pagamenti/page.tsx`, `__tests__/components/pagamenti-intestazione-coda.test.tsx`
- **Verifica:** VT: __tests__/components/pagamenti-intestazione-coda.test.tsx __tests__/components/ContabilitaNav.test.tsx → 2; `git diff --quiet -- src/components/features/admin/pagamenti/ContabilitaNav.tsx`.
- **Perché questo modello:** Modifica piccola, con test di pagina.

### R2A-6.15 · Via LottoFatturePanel (parte D5 del commit congiunto) — sonnet/high

D5§8.1:
- RiconciliazionePanel monta AccodaFattureDialog con origine riconciliazione al posto di LottoFatturePanel (1564-1572) e usa TETTO_VOCI_PER_GESTO invece di TETTO_LOTTO;
- elimina LottoFatturePanel.tsx e RiconciliazioneLottoFatture.test.tsx;
- aggiorna pannello-componi-testi-completi e messaggi-plurali-e-glossario;
- togli dai due adminContabilita.json SOLO le chiavi reconLotto* del pannello, lasciando le 941-943;
- lock intestatario (2): LottoFatturePanel.tsx esce dai chiamanti, altrimenti diventa una voce morta.
I test di RiconciliazionePanel mockano FatturaButton (verificato). Le chiavi mancanti segnalate da 6.10 NON le aggiunge questo compito, che gira in parallelo con 6.10: le aggiunge CHIAVI-F6b, dopo (C0-5).

- **File:** `src/components/features/admin/pagamenti/RiconciliazionePanel.tsx`, `src/components/features/admin/pagamenti/LottoFatturePanel.tsx`, `__tests__/components/RiconciliazioneLottoFatture.test.tsx`, `__tests__/components/RiconciliazionePanel.test.tsx`, `__tests__/components/RiconciliazionePanel-composizione.test.tsx`, `__tests__/components/RiconciliazionePanel-fattura.test.tsx`, `__tests__/components/riconciliazione-avviso-solo-se-visto.test.tsx (solo se rosso)`, `__tests__/architecture/pannello-componi-testi-completi.test.ts`, `__tests__/architecture/messaggi-plurali-e-glossario.test.ts`, `__tests__/architecture/intestatario-fattura-un-motore-solo.test.ts`, `messages/it/adminContabilita.json`, `messages/en/adminContabilita.json`
- **Verifica:** VT: __tests__/components/RiconciliazionePanel __tests__/components/riconciliazione-avviso-solo-se-visto.test.tsx __tests__/architecture/pannello-componi-testi-completi.test.ts __tests__/architecture/messaggi-plurali-e-glossario.test.ts __tests__/architecture/intestatario-fattura-un-motore-solo.test.ts __tests__/architecture/messaggi-parita-cataloghi.test.ts → 8.
- **Perché questo modello:** Sostituzione di interfaccia, sotto lock di testi.

## R2A-F7a · Route del giro, test ponte e pulizie

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Esporre il lavoratore via cron. Provare il documento vero nel giornale vero (gate prima della fase 3). Ridurre lotto-fatture.ts, ora che nessuno ne importa più i vecchi export. Chiudere allowlist e smoke a11y.
- **Dipende da:** R2A-F6b
- **Critico (opus/xhigh):** Il ponte dev'essere verde con le prove di rottura attive, altrimenti la fase 3 non parte.

Rompe la route, prima togliendo after e poi aggiungendo requireStaff: i test devono diventare rossi.

Controlla che nessun file importi un nome uscito da lotto-fatture. Poi commit.

### R2A-7.1 · Route POST /coda/giro — opus/high

D3§14:
- solo x-cron-secret; corpo z.strictObject;
- 202 prima del lavoro, che gira in after() (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md);
- const JOB = 'fatture-coda-tick' ed export const maxDuration = 300, letterali;
- battito con livelloLogCoda;
- nessun requireStaff, nessun next/headers.
Crea __tests__/api/fattura-coda-giro.test.ts e aggiungi i casi 401 in __tests__/api/cron-secret.test.ts.

- **File:** `src/app/api/pagamenti/fattura/coda/giro/route.ts`, `__tests__/api/fattura-coda-giro.test.ts`, `__tests__/api/cron-secret.test.ts`
- **Verifica:** VT: __tests__/api/fattura-coda-giro.test.ts __tests__/api/cron-secret.test.ts __tests__/api/health.test.ts → 3.
- **Perché questo modello:** Punto d'ingresso del cron, con after() di Next 16 e la sicurezza del segreto.

### R2A-7.2 · Test ponte del giornale su PGlite — opus/max

D3§17 n.19 e C§17.6, con CR8 e CR2.

Percorso, tutto vero: emettiFatturaPagamento → giornaleDi → RPC su PGlite:
- invio_registra, prima con p_solo_verifica e poi reale;
- invio_tenta;
- invio_esito.

Prima di invio_registrato, specchia in PGlite la riga del finto (semina.rigaRegistro con gli stessi id).

Casi: IVA 0; IVA 22% con 10,01 €; bollo virtuale; due quote.
Prove di rottura come casi, ognuna → BAD_INPUT:
- xml_inviato dentro riga_registro;
- importo lordo;
- Numero FPR con l'anno a 4 cifre.
clientSuPglite con sincronizzaOrologio:false.

File __tests__/lib/fatture-coda/ponte-giornale-pglite.test.ts.

- **File:** `__tests__/lib/fatture-coda/ponte-giornale-pglite.test.ts`
- **Verifica:** VT: __tests__/lib/fatture-coda/ponte-giornale-pglite.test.ts → 1, prove di rottura comprese.
- **Perché questo modello:** Unica prova del documento fiscale vero prima della produzione (decisione 28).

### R2A-7.3 · lotto-fatture ridotto (parte D4 del commit congiunto) — sonnet/high

D4§12.2, misurato (rilievo 8).

Prima: `grep -c '^export' src/lib/pagamenti/lotto-fatture.ts` → 24.

Togli i 20 export morti, fra cui TETTO_LOTTO e stimaRimanenteMs. Restano i 4 usati da precontrollo: QuotaPerIlLotto, AnteprimaPerIlLotto, quoteTutteFatturabili, prontaPerIlLotto.

La prova che nessuno li usa si cerca SOLO negli import dal modulo (TETTO_LOTTO esiste anche come costante locale in gdpr-retention e scadenze-documenti), statici E dinamici (C0-13): `grep -rn "lotto-fatture'" src __tests__ e2e`. La forma `from '…'` non vede `await import('@/lib/pagamenti/lotto-fatture')` di __tests__/pagamenti/tetto-orario-aruba.test.ts:155 [V], che oggi legge proprio TETTO_LOTTO. Dopo la riduzione il grep deve mostrare solo src/lib/fatture-coda/precontrollo.ts, __tests__/lib/lotto-fatture.test.ts e __tests__/pagamenti/tetto-orario-aruba.test.ts, con soli nomi vivi (in tetto-orario-aruba, niente più TETTO_LOTTO).

Aggiorna lotto-fatture.test.ts e tetto-orario-aruba.test.ts («il gesto non è il ritmo»).

- **File:** `src/lib/pagamenti/lotto-fatture.ts`, `__tests__/lib/lotto-fatture.test.ts`, `__tests__/pagamenti/tetto-orario-aruba.test.ts`
- **Verifica:** `grep -c '^export' src/lib/pagamenti/lotto-fatture.ts` → 4.
Il grep sugli import, statici e dinamici, mostra solo nomi vivi.
VT: __tests__/lib/lotto-fatture.test.ts __tests__/pagamenti/tetto-orario-aruba.test.ts __tests__/lib/fatture-coda/precontrollo.test.ts → 3.
- **Perché questo modello:** Rimozione controllata di export, misurata.

### R2A-7.4 · Smoke a11y di pagina e sezione — sonnet/medium

Aggiungi a __tests__/a11y/smoke.axe.test.tsx la pagina Coda fatture e la sezione «Pagamenti e fatture».

- **File:** `__tests__/a11y/smoke.axe.test.tsx`
- **Verifica:** VT → 1.
- **Perché questo modello:** Estensione di un test esistente.

### R2A-7.5 · Allowlist errori-senza-codice alla misura — sonnet/medium

Misura il debito dopo i 410 e la sync (R2A-F6a) e abbassa docs/superpowers/errori-senza-codice-allowlist.json e MAX_OCCORRENZE di errori-con-codice. Nessuna esenzione nuova: la lista può solo scendere; accanto a ogni numero abbassato scrivi perché è sceso.

- **File:** `docs/superpowers/errori-senza-codice-allowlist.json`, `__tests__/architecture/errori-con-codice.test.ts`
- **Verifica:** VT: __tests__/architecture/errori-con-codice.test.ts → 1, con numeri minori o uguali a prima.
- **Perché questo modello:** Misura e aggiornamento di numeri.

## R2A-F7b · Impianto del cardine

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Preparare l'impianto del test cardine, che passa dalla route vera del giro, ormai pronta (rilievo 1d).
- **Dipende da:** R2A-F7a
- **Critico (opus/xhigh):** Rompe la notifica finta in modo che non consumi l'outbox: l'impianto deve accorgersene. Poi commit.

### R2A-7.6 · Impianto del cardine e prova dei timer — opus/high

D6§6.1. Crea __tests__/helpers/cardine-impianto.ts:
- PGlite creato prima dei timer finti; vi.useFakeTimers più setTimerTickMode('nextTimerAsync');
- vi.mock di server-client, logger, next/server, emetti-voce (finta col giornale vero e xmlDiProva), accesso, require-staff;
- notifiche finta che CONSUMA l'outbox con avvisi_prendi e avvisi_conferma veri;
- pg_cron e pg_net simulati.

Crea __tests__/lib/fatture-coda/cardine-impianto.test.ts: accodamento → sveglia → giro sulla route vera → 2 upload, col tempo reale misurato. Se nextTimerAsync non è stabile, passa a PorteGiro.attendi e segnalalo.

- **File:** `__tests__/helpers/cardine-impianto.ts`, `__tests__/lib/fatture-coda/cardine-impianto.test.ts`
- **Verifica:** VT: __tests__/lib/fatture-coda/cardine-impianto.test.ts → 1; tempo misurato riportato.
- **Perché questo modello:** Orologio unico fra PGlite, timer finti e route: è la base del cardine.

## R2A-F8 · Misura di fine fase 2

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Suite intera verde prima della fase 3: ogni rosso si attribuisce al proprietario e si ripara.
- **Dipende da:** R2A-F7b
- **Critico (opus/high):** Attribuisce ogni rosso al proprietario secondo C§19 (chi rompe ripara). Apre un compito di riparazione con lo stesso modello del compito d'origine e ripete la misura finché i rossi sono zero. Poi commit delle riparazioni. La fase 3 non parte con rossi aperti.

### R2A-8.1 · Misura area D2 — haiku/low

Esegui `npx vitest run __tests__/db __tests__/lib/gdpr-esegui.test.ts __tests__/lib/gdpr-oblio-coda-fatture.test.ts __tests__/lib/fatture-coda-rpc.test.ts __tests__/helpers` ed elenca i file rossi.

- **File:** —
- **Verifica:** Elenco dei rossi, anche vuoto.
- **Perché questo modello:** Esegue e riporta.

### R2A-8.2 · Misura area D3 — haiku/low

Esegui `npx vitest run __tests__/lib/aruba/ __tests__/lib/fatture-coda __tests__/api/fattura-sync __tests__/api/fattura-coda-giro.test.ts __tests__/api/cron-battito.test.ts __tests__/api/cron-secret.test.ts __tests__/api/fattura-emissione` ed elenca i rossi.

- **File:** —
- **Verifica:** Elenco dei rossi.
- **Perché questo modello:** Esegue e riporta.

### R2A-8.3 · Misura area D4 — haiku/low

Esegui `npx vitest run __tests__/api/fattura-coda __tests__/api/pagamenti-riconciliazione __tests__/api/riconciliazione __tests__/api/fattura-route.test.ts __tests__/lib/pagamenti __tests__/lib/auth __tests__/pagamenti __tests__/architecture` ed elenca i rossi.

- **File:** —
- **Verifica:** Elenco dei rossi.
- **Perché questo modello:** Esegue e riporta.

### R2A-8.4 · Misura area D5 — haiku/low

Esegui `npx vitest run __tests__/components __tests__/features __tests__/a11y __tests__/ui __tests__/lib/notifiche-obbligatorie.test.ts __tests__/lib/etichette-i18n.test.tsx __tests__/lib/fatture-coda-notifiche.test.ts` ed elenca i rossi.

- **File:** —
- **Verifica:** Elenco dei rossi.
- **Perché questo modello:** Esegue e riporta.

### R2A-8.5 · Suite intera con conteggio — haiku/low

Formula GATE-VITEST.

- **File:** —
- **Verifica:** «Test Files N passed», con N uguale ai file su disco.
- **Perché questo modello:** Esegue e riporta.

## R2A-F9a · Cardine, lock nuovi e finto degli E2E

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Provare la decisione 0 senza browser, armare i lock nuovi e preparare lo stato finto e l'account segreteria degli E2E.
- **Dipende da:** R2A-F8
- **Critico (opus/max):** Rompe apposta ogni file nuovo del lavoratore e della UI (C§20.7), uno alla volta su patch reversibile: almeno un test o lock deve diventare rosso. Controlla che nessun lock sia cieco, cioè che ognuno abbia un controllo positivo. Poi commit.

### R2A-9.1 · Cardine, scenario 1, e battiti SQL — opus/max

D6§6.2 e §6.5, in __tests__/lib/fatture-coda/coda-senza-browser.test.ts, sopra cardine-impianto.

Scenario: 120 voci più 1 urgente. Asserzioni:
- al più 50 upload in 60'; al più 15 per giro; pause;
- l'urgente prima delle normali;
- fine entro simulaInvii più un tick; prima emissione dalla sveglia;
- la fine di ogni gruppo una volta sola (gruppo_concluso oppure dati.fine_gruppo);
- nessuna anomalia;
- battito col livello di livelloLogCoda;
- nessun requireStaff, cookies o headers; nessuna scrittura via from.

Battito della pulizia con fingerprint 'cron:fatture-coda-pulizia'. Le prove di rottura di D6§6.6 si eseguono davvero.

- **File:** `__tests__/lib/fatture-coda/coda-senza-browser.test.ts`
- **Verifica:** VT → 1; tempo e timeout annotati.
- **Perché questo modello:** È la prova della decisione cardine, con SQL vero.

### R2A-9.2 · Cardine, scenari 2 e 3 — opus/max

D6§6.3-6.4, in __tests__/lib/fatture-coda/coda-senza-browser-verifiche.test.ts.
- Scenario 2: candidato illeggibile per sempre; al più 3 giri persi.
- Scenario 3: upload sempre 429; tre tentativi distanti almeno 60'; poi da_verificare aruba_429_ripetuto; nessun quarto upload.
Prove di rottura: prossima senza il salto giro = fence; contatore dei 429 azzerato sulle pagine.

- **File:** `__tests__/lib/fatture-coda/coda-senza-browser-verifiche.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Prova dei tetti delle decisioni 15, 16 e 17.

### R2A-9.3 · Lock fatture-coda-senza-browser — sonnet/high

D6§7.1: cinque controlli, con controllo positivo e prova di rottura.

- **File:** `__tests__/architecture/fatture-coda-senza-browser.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Lock testuale.

### R2A-9.4 · Lock aruba-solo-dal-cancello — sonnet/high

D6§7.2:
- scansione di src/**, risolvendo alias e percorsi relativi;
- insieme chiuso dei file che importano i simboli di rete;
- emettiFatturaPagamento e creaSessioneAruba importati solo da emetti-voce.ts, con un'eccezione dichiarata e contata per cancello.ts se serve;
- da fatture-coda solo import type.

- **File:** `__tests__/architecture/aruba-solo-dal-cancello.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Lock sugli import.

### R2A-9.5 · Lock soglia-oraria-un-numero-solo — sonnet/medium

D6§7.3.

- **File:** `__tests__/architecture/soglia-oraria-un-numero-solo.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Lock testuale.

### R2A-9.6 · Lock fatture-coda-nessuno-spostamento — sonnet/medium

D6§7.4.

- **File:** `__tests__/architecture/fatture-coda-nessuno-spostamento.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Lock testuale.

### R2A-9.7 · Lock fatture-coda-una-stima-sola — sonnet/medium

D6§7.5. stimaRimanenteMs l'ha già tolta R2A-7.3.

- **File:** `__tests__/architecture/fatture-coda-una-stima-sola.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Lock testuale.

### R2A-9.8 · Lock fatture-coda-log-vocabolario — opus/high

D6§7.6:
- nel TS, esiti presi dal vocabolario e livello uguale a livelloLogCoda;
- nell'SQL, _fatture_coda_log con tre letterali;
- coerenza e controllo positivo, compreso scarto-solo-chi-ha-accodato (C0-20).

- **File:** `__tests__/architecture/fatture-coda-log-vocabolario.test.ts`
- **Verifica:** VT → 1; la prova di rottura (coda-da-verificare a error) lo fa diventare rosso.
- **Perché questo modello:** Analisi di sorgenti TS e SQL: un lock cieco qui nasconde livelli sbagliati.

### R2A-9.9 · Lock contratto-specchio (parità CR1 per esecuzione, non per testo) — opus/high

D2§11, con queste regole:
- a) CR1 non si confronta per testo (rilievo 11). Il lock verifica solo che `_fatture_coda_partita_non_registrata(` sia definita una volta nel file 2, usi `_fatture_coda_stati_scarto_sdi()` e sia chiamata da fatture_coda_accoda e da fatture_coda_rimetti. La parità semantica l'ha provata R2A-4.4 eseguendo i 9 casi.
- b) Uguaglianze D1: MOTIVO_PARTITA_NON_REGISTRATA === ESITO_VOCE.partita_non_registrata; CODICI_SDI_SCARTO_REGISTRO uguale a STATI_SDI_SCARTO.
- c) RPC: 30 GRANT nel file 2 più 2 nel file 3 = RPC_CODA (32), e nessun'altra funzione con GRANT.
- d) Nel file 3, `cron.schedule('fatture-coda-tick'` e `cron.schedule('fatture-coda-pulizia'` letterali (rilievo 12).
- e) Battito col letterale 'cron:fatture-coda-pulizia' (CR4).
- f) Letterali duplicati: vocabolario-log.ts escluso come catalogo, come contratto-db.ts (scelta unica, rilievo 10); in api-contratto.ts le eccezioni contate 'sospesa' e 'in_pausa'; nessuna eccezione per sync/route.ts.
  Ambito dichiarato (C0-10), quello di D2§11 punto 7 (d2-schema-rpc-cron.md:1114 [V]): `src/lib/fatture-coda/**` tranne contratto-db.ts e vocabolario-log.ts, `src/app/api/pagamenti/fattura/coda/**`, `src/app/api/pagamenti/fattura/sync/route.ts`. `src/lib/aruba/**` è FUORI dall'ambito per costruzione: S35 (contratto.md:175 [V]) gli vieta di importare valori da fatture-coda, quindi client.ts, confronto-documento.ts e reinvio.ts scrivono per forza come letterali i valori di ESITO_TENTATIVO ed ESITO_RICERCA. La loro coerenza col contratto non la prova il lock ma il typecheck: quei letterali sono tipizzati con i tipi importati via `import type` da contratto-db (ammesso da S35), per esempio con `satisfies` [D]; un valore che esce dall'unione rompe tsc. Controllo positivo contro il lock cieco: per ogni glob dell'ambito il lock conta i file scanditi e fallisce se sono 0; e un caso esegue il lock su un letterale 'in_coda' finto dentro src/lib/fatture-coda e lo vede rosso.
- g) _codice_chk del file 1 uguale a CODICI_ESITO_VOCE (59).
Prove di rottura di D2§11 eseguite.

- **File:** `__tests__/architecture/fatture-coda-contratto-specchio.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Specchio del vocabolario fiscale fra SQL e TS.

### R2A-9.10 · Lock fatture-coda-api-contratto — sonnet/high

D4§14 punti (a)-(f), con CodiceRispostaCoda.

- **File:** `__tests__/architecture/fatture-coda-api-contratto.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Lock testuale.

### R2A-9.11 · Lock fatture-coda-ui-contratto — sonnet/high

D5§2.2, compreso il divieto di calcolare limiti e azioni nell'interfaccia.

- **File:** `__tests__/architecture/fatture-coda-ui-contratto.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Lock testuale.

### R2A-9.12 · E2E: stato finto e account segreteria — sonnet/high

D6§9. Crea e2e/lib/coda-fatture-finta.ts:
- simula anche GET /api/pagamenti/fattura/anteprima e GET /api/admin/settings/categorie;
- risponde 409 CODA_OLTRE_12_GIORNI.
Aggiungi STORAGE.segreteria in e2e/fixtures.ts e il setup relativo in e2e/auth.setup.ts.

- **File:** `e2e/lib/coda-fatture-finta.ts`, `e2e/fixtures.ts`, `e2e/auth.setup.ts`
- **Verifica:** `npx tsc --noEmit` senza errori nei tre file.
`npx playwright test --list --project=setup` elenca anche «storageState segreteria».
- **Perché questo modello:** Finti Playwright su un contratto tipizzato.

## R2A-F9b · E2E simulati

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Scrivere gli E2E sopra lo stato finto ormai pronto (rilievo 1e).
- **Dipende da:** R2A-F9a
- **Critico (sonnet/xhigh):** Controlla che ogni caso cerchi prima una presenza e poi un'assenza, e che nessuno usi getByText senza limitarlo a una regione. Poi commit.

### R2A-9.13 · E2E ingressi (E1-E6) — sonnet/high

D6§9, casi E1-E6, in e2e/admin-coda-fatture-ingressi.spec.ts.
- Nomi accessibili di D5§12.
- retries 0; serviceWorkers block.
Si esegue solo in CI: in locale l'E2E è vietato.

- **File:** `e2e/admin-coda-fatture-ingressi.spec.ts`
- **Verifica:** PW-LIST sul file → «Total: 6 tests in 1 file».
- **Perché questo modello:** Test E2E meccanici.

### R2A-9.14 · E2E pagina della coda (E7-E21) — sonnet/high

D6§9, casi E7-E18, in e2e/admin-coda-fatture.spec.ts. E19 secondo CR3:
- «Riprova fattura» nella riga di una voce emessa con azioni.ritrasmetti;
- il clic apre il modale «Metti in coda la fattura» con l'anteprima simulata;
- il POST è singolo, sul pagamento della voce;
- con ritrasmetti=false, o su una voce d'altra sede, il comando non c'è.
E20 ed E21, dai default (D6 blocco C0, C0-18):
- E20: «Togli» attivo su una voce `errore` con soli invii `rifiutata`/`bruciata`; `aria-disabled` su una voce `errore` con un invio `registrata`;
- E21: voce `errore numero_conteso` con «Rimetti in coda» visibile e **senza** «Rimanda».
Solo CI.

- **File:** `e2e/admin-coda-fatture.spec.ts`
- **Verifica:** PW-LIST sul file → «Total: 15 tests in 1 file» (13 + E20 + E21, C0-18).
- **Perché questo modello:** Test E2E meccanici.

## R2A-F10a · Controllo di T1 contro le fotografie

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Tenere i nomi delle migrazioni validi contro le fotografie su origin/main PRIMA di scrivere PRD e spec, che li citano (rilievo 1g).
- **Dipende da:** R2A-F9b
- **Critico (opus/high):** Controlla che i tre nomi siano consecutivi di 60 s, non futuri, maggiori di ogni generato_alle su origin/main. Poi commit, se c'è stata una rinomina.

### R2A-10.1 · Controllo di T1 ed eventuale rinomina — opus/high

`git fetch origin`, poi confronta T1 con ogni generato_alle delle fotografie su origin/main (`git show origin/main:<percorso>`).

Se una fotografia è più recente:
- rinomina i 3 file con `git mv`, con un istante REALE preso adesso (T1 nuovo, +60 s, +120 s), mai futuro;
- aggiorna la chiave di MIGRAZIONI_ATTESE_AL_MERGE;
- aggiorna $LAVORO/r2-t1.txt.
Altrimenti nessuna modifica.

- **File:** `supabase/migrations/<T1>_fatture_coda_schema.sql`, `supabase/migrations/<T1+60s>_fatture_coda_rpc.sql`, `supabase/migrations/<T1+120s>_fatture_coda_cron.sql`, `__tests__/architecture/soglia-fotografia.ts`, `$LAVORO/r2-t1.txt (fuori dal repo)`
- **Verifica:** LOCK-MIGR completo → 9 (C0-15): la rinomina cambia la chiave di MIGRAZIONI_ATTESE_AL_MERGE, che rls-per-sede, onconflict-arbitro e tracce-docente-dichiarate leggono tramite posterioriDaRigenerare, quindi i soli tre lock di prima non bastano. VT: __tests__/db/ → tutti passed (i file si leggono per suffisso).
- **Perché questo modello:** Può rinominare migrazioni che l'integrazione applicherà in produzione (rilievo 9c).

## R2A-F10b · PRD e spec finale

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Documentazione della PR-A coi nomi definitivi delle migrazioni.
- **Dipende da:** R2A-F10a
- **Critico (sonnet/high):** Controlla che il PRD non contenga dati personali e che i nomi coincidano con i file su disco. Poi commit.

### R2A-10.2 · PRD della PR-A — sonnet/high

D6§11:
- righe dello schema con «⏳ la applica l'integrazione al merge della PR-A», coi nomi definitivi da $LAVORO/r2-t1.txt; riga Contabilità;
- changelog datato: decisioni 0-29, sequenza, query di D6§10, lock nuovi, limiti dichiarati, gate coi conteggi.

- **File:** `PRD REGISTRO ELETTRONICO.md`
- **Verifica:** `grep -c <T1> 'PRD REGISTRO ELETTRONICO.md'` ≥ 1.
VT: __tests__/architecture/pii-nei-file-tracciati.test.ts → 1.
- **Perché questo modello:** Documentazione accurata.

### R2A-10.3 · Spec finale — sonnet/medium

Aggiorna la spec con:
- una sezione «Limiti dichiarati»;
- una sezione «Default del titolare» (contratto C0.2: i cinque default applicati; C0-18);
- una sezione «Gate» coi conteggi;
- i nomi definitivi delle tre migrazioni.

- **File:** `docs/superpowers/specs/2026-09-22-coda-fatture-aruba-design.md`
- **Verifica:** `grep -c` trova le tre intestazioni «Limiti dichiarati», «Risposte del titolare» e «Gate», e il nome <T1>_fatture_coda_schema.sql (rilievo 10).
VT: __tests__/architecture/pii-nei-file-tracciati.test.ts → 1.
- **Perché questo modello:** Aggiornamento di un documento.

## R2A-F11 · Gate locale PR-A

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Lint, tipi, test contati, build ed elenco E2E verdi.
- **Dipende da:** R2A-F10b
- **Critico (sonnet/high):** Con un gate rosso il proprietario ripara, poi si rilancia il gate.

### R2A-11.1 · ESLint — haiku/low

Esegui `npx eslint . --max-warnings 0`.

- **File:** —
- **Verifica:** Uscita 0.
- **Perché questo modello:** Verifica banale.

### R2A-11.2 · Typecheck — haiku/low

Esegui `npx tsc --noEmit`.

- **File:** —
- **Verifica:** Uscita 0.
- **Perché questo modello:** Verifica banale.

### R2A-11.3 · Vitest con conteggio — haiku/low

Formula GATE-VITEST. __tests__/architecture dev'essere cresciuta dei 9 lock nuovi di R2A-9.3-9.11 (C0-14). Si contano i FILE DI TEST, non le voci della cartella: a HEAD 29bb04c7 le voci sono 151, ma una è soglia-fotografia.ts, che non è un test [V]; i file .test.ts sono 150 e diventano 159. Comando: `ls __tests__/architecture | grep -cE '\.test\.tsx?$'` → 159 (le voci, con `ls __tests__/architecture | wc -l`, passano da 151 a 160). Un numero diverso si spiega file per file prima di proseguire.

- **File:** —
- **Verifica:** «Test Files N passed», con N uguale ai file su disco.
- **Perché questo modello:** Confronta due numeri.

### R2A-11.4 · Build — haiku/low

Esegui `npm run build`.

- **File:** —
- **Verifica:** Uscita 0.
- **Perché questo modello:** Verifica banale.

### R2A-11.5 · Elenco degli E2E — haiku/low

PW-LIST su e2e/admin-coda-fatture.spec.ts e e2e/admin-coda-fatture-ingressi.spec.ts: solo l'elenco.

- **File:** —
- **Verifica:** «Total: 19 tests in 2 files» (--project=chromium --no-deps, rilievo 15b).
- **Perché questo modello:** Verifica banale.

## R2A-F12 · Precondizioni, PR-A e CI

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Aprire la PR-A con la CI tutta verde e le precondizioni di produzione soddisfatte, col dry-run protetto.
- **Dipende da:** R2A-F11
- **Critico (opus/high):** Rilegge $LAVORO/dry-run-pr-a.txt (prova a secco, soli 3 file, nessuna applicazione) e ricontrolla schema_migrations. Dà il via libera al merge solo con CI verde, precondizioni verdi, ponte e cardine verdi nella CI.

### R2A-12.1 · Precondizioni in sola lettura, col dry-run protetto — sonnet/medium

1. SELECT:
   - orfane col predicato CR1 = 0;
   - «Trasporto fallito» = 0. Se è maggiore: rinvio del merge, ed elenco di uuid, serie, numero e anno da verificare sul pannello;
   - motivi attesi (oggi 7), annotati in $LAVORO/r2-base.json per D-motivo;
   - le 3 version assenti da schema_migrations.
2. Dry-run con le stesse cautele di R1-7.2:
   - `supabase db push --help | grep -c -- '--dry-run'` ≥ 1;
   - poi ESATTAMENTE `supabase db push --linked --dry-run > $LAVORO/dry-run-pr-a.txt 2>&1`: mai senza --dry-run, mai --yes;
   - devono comparire i soli 3 file.
3. Rilettura: le 3 version sono ancora assenti.

- **File:** `$LAVORO/dry-run-pr-a.txt (fuori dal repo)`
- **Verifica:** Tutti i valori attesi, altrimenti STOP; $LAVORO/dry-run-pr-a.txt con i soli 3 file.
- **Perché questo modello:** Il comando tocca la produzione (rilievo 9a).

### R2A-12.2 · PR-A e CI — sonnet/medium

- Working tree pulito; push; `gh pr create` in italiano, con sintesi, rischi e riga di attribuzione.
- `gh pr checks --watch`: quality ed e2e verdi, compresi gli E2E nuovi.
- Un rosso lo ripara chi l'ha rotto; si ripete fino al verde.

- **File:** —
- **Verifica:** `gh pr checks <n>` → tutti pass.
- **Perché questo modello:** Procedura standard con attesa.

## R2A-F13 · Merge PR-A

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Fondere nella finestra prevista. Le migrazioni le applica l'integrazione.
- **Dipende da:** R2A-F12
- **Critico (sonnet/high):** Controlla l'orario e l'assenza di emissioni in corso.

### R2A-13.1 · Merge al minuto :43 (o :13) — sonnet/medium

Dopo le 16:00 Europe/Rome, al minuto :43 (oppure :13) dell'orologio del DB. Subito prima: nessuna emissione negli ultimi 10' (lettura attivita_app di D1§10.1).
Poi `gh pr merge <n> --squash --delete-branch`.
Mai apply_migration, db push in scrittura o migrate.yml.

- **File:** —
- **Verifica:** PR MERGED, con mergedAt al minuto previsto.
- **Perché questo modello:** Rispetto di orari e precondizioni.

## R2A-F14 · Verifica in produzione della PR-A

- **Rilascio:** R2-coda-PR-A
- **Obiettivo:** Entro 10': migrazioni, sicurezza, cron, battiti e salute. Se l'integrazione fallisce, rollback immediato.
- **Dipende da:** R2A-F13
- **Critico (opus/high):** Se V1 o V2 falliscono entro 5':
- promuove SUBITO il deploy Vercel precedente;
- poi apre una PR correttiva (CR11);
- mai correzioni a mano.

Con V3-V8 anomali:
- «Sospendi coda», oppure l'arresto d'urgenza mostrato prima di eseguirlo;
- poi analisi.

### R2A-14.1 · V1-V2: integrazione e deploy — sonnet/low

- Check «Supabase Preview» success sul commit di merge.
- Deploy Vercel di produzione READY/success; annota l'istante in $LAVORO/deploy-pr-a.txt.
- Le 3 version presenti in schema_migrations.

- **File:** `$LAVORO/deploy-pr-a.txt (fuori dal repo)`
- **Verifica:** Tutto success entro 5'.
- **Perché questo modello:** Lettura di stati, ma le version in schema_migrations si leggono con `supabase db query --linked` (SQL arbitrario in produzione): sonnet (C0-7).

### R2A-14.2 · V3-V4: RLS e privilegi — sonnet/low

Controlla:
- 8 tabelle con relrowsecurity e relforcerowsecurity; 0 policy;
- role_table_grants: solo SELECT a service_role;
- has_function_privilege: le 32 RPC eseguibili solo da service_role, gli helper da nessuno;
- prosecdef = true;
- la leva di STOP funziona col ruolo REALE della CLI (C0-16): prima il controllo positivo della firma, `select to_regprocedure('public.fatture_coda_sospendi(uuid,text)') is not null` → true; poi `select current_user, has_function_privilege(current_user, 'public.fatture_coda_sospendi(uuid,text)', 'EXECUTE')` → true, con current_user uguale a quello registrato in $LAVORO/r1-base.json da R1-0.2. Se è false, o il ruolo è diverso, l'arresto d'urgenza di R2V NON è disponibile: STOP e rapporto prima di R2V-F1, e l'unica leva resta «Sospendi coda» dalla pagina, da un admin. Solo lettura: la sospensione NON si esegue per provarla (la prova eseguita è quella di R2A-6.2 su PGlite).

- **File:** —
- **Verifica:** Valori come attesi, compreso has_function_privilege sulla sospensione col ruolo della CLI = true.
- **Perché questo modello:** Query di catalogo.

### R2A-14.3 · V5-V6: cron e battito della pulizia — sonnet/low

- cron.job ha 2 righe, coi loro orari.
- In app_log c'è una riga col fingerprint cron:fatture-coda-pulizia ed esito ok.

- **File:** —
- **Verifica:** 2 job e battito presenti.
- **Perché questo modello:** Due SELECT via `supabase db query --linked`, una su app_log (rischio PII: solo count, fingerprint ed esito, mai il contesto): sonnet (C0-7).

### R2A-14.4 · V7-V8: primo tick dopo il deploy READY, e salute — sonnet/low

Aspetta col Monitor il PRIMO tick (minuto ≡ 2 mod 5) successivo all'istante READY di $LAVORO/deploy-pr-a.txt: non quello di :47 per forza (rilievo 15a). Poi controlla:
- battito ok con tipo coda-vuota;
- ultimo_giro_il e ultimo_tick_il aggiornati;
- in /api/health, il solo controllo coda-fatture = ok.
Un tick-esito-http a error PRIMA del READY è atteso e non è uno STOP.

- **File:** —
- **Verifica:** Battito ok e coda-fatture ok, sul primo tick dopo il READY.
- **Perché questo modello:** Lettura di stati dopo un'attesa, con `supabase db query --linked` su app_log e fatture_coda_stato: sonnet (C0-7).

## R2V-F1 · Sorveglianza serale delle prime 3 ore

- **Rilascio:** R2-avvio
- **Obiettivo:** Seguire ogni 15' le prime 3 ore dopo il merge; STOP immediato ai segnali di C§18. La prova della decisione 0 con la segreteria vera si sposta alla mattina (R2V-F2).
- **Dipende da:** R2A-F14
- **Critico (opus/xhigh):** Ai segnali di STOP (C§18, C7 o C8 diversi da 0, D-bruciati diverso da 0):
- chiede a un admin «Sospendi coda»;
- in urgenza mostra, e poi esegue, `select public.fatture_coda_sospendi(NULL,'arresto d''urgenza durante il rilascio')`, provata in R2A-6.2;
- analisi col metodo sistematico; la ripresa (`fatture_coda_riprendi`) la fa **solo il titolare** da admin, mai l'agente né il critico (contratto C0.2 D4, C0-21); il ritorno indietro segue S38.

Senza STOP: via libera al merge della PR-B, senza aspettare la prova della decisione 0 (rilievo 7b).

### R2V-1.1 · Stato della coda — sonnet/high

Ogni 15' per 3 ore, col Monitor, le query di D6§10.4:
- D-voci;
- D-motivo: ritrasmissioni ≤ il valore annotato;
- D-invii;
- D-bruciati = 0;
- D-cancello.
Solo aggregati, in $LAVORO/sorveglianza-r2.jsonl.

- **File:** `$LAVORO/sorveglianza-r2.jsonl (fuori dal repo)`
- **Verifica:** Serie senza segnali di STOP, oppure STOP segnalato.
- **Perché questo modello:** Lettura continua e riconoscimento di anomalie.

### R2V-1.2 · Aruba e ritmo — sonnet/high

Ogni 15':
- D-tentativi per tipo ed esito;
- D-picco ≤ 50 sulla finestra scorrevole di 60';
- aperture del circuito.
Un 429 si confronta con l'uso manuale del pannello.

- **File:** —
- **Verifica:** Picco ≤ 50 e nessun 429, altrimenti STOP.
- **Perché questo modello:** Riconoscimento di picchi e 429.

### R2V-1.3 · Avvisi e coerenza — sonnet/high

Ogni 15':
- D-avvisi, coi conteggi dati ? 'anomalia' e dati ? 'fine_gruppo';
- controlli C1-C8 di D6§10.4, tutti attesi a 0.

- **File:** —
- **Verifica:** C1-C8 a 0.
- **Perché questo modello:** Controlli di coerenza incrociati.

### R2V-1.4 · Log e salute — sonnet/medium

Ogni 15':
- D-log delle 5 operazioni;
- nessun battito del tick assente da oltre 15';
- in /api/health, i soli controlli coda-fatture e cron-battito.

- **File:** —
- **Verifica:** Battiti regolari e coda-fatture ok.
- **Perché questo modello:** Soglie fisse, ma D-log legge app_log con `supabase db query --linked` (SQL arbitrario in produzione, rischio PII): sonnet (C0-7).

## R2B-F0 · Branch della PR-B

- **Rilascio:** R2-coda-PR-B
- **Obiettivo:** Creare il branch nuovo dopo la verifica della PR-A e ripulire quello vecchio.
- **Dipende da:** R2A-F14
- **Critico (sonnet/high):** Controlla che main contenga il merge della PR-A e che non ci siano altri branch.

### R2B-0.1 · Pulizia e branch feat/coda-fatture-pr-b — sonnet/low

- `git switch main && git pull --ff-only`;
- `git branch -D feat/coda-fatture-aruba`: il remoto l'ha già tolto --delete-branch; controlla con `git ls-remote --heads origin`;
- `git switch -c feat/coda-fatture-pr-b`.
Working tree pulito prima e dopo.

- **File:** —
- **Verifica:** Branch corrente feat/coda-fatture-pr-b, HEAD = origin/main; in remoto solo main.
- **Perché questo modello:** Cancella un branch: niente haiku (rilievo 9b).

## R2B-F1a · Le 6 fotografie dalla produzione

- **Rilascio:** R2-coda-PR-B
- **Obiettivo:** Rigenerare in parallelo, in sola lettura, le 6 fotografie. Nessuna migrazione.
- **Dipende da:** R2B-F0
- **Critico (sonnet/high):** Controlla che i diff delle 6 fotografie contengano solo le novità della coda e che ogni altra differenza sia spiegata. NESSUN commit (C0-1): rigenerare le fotografie fa diventare rossi, fino a R2B-F1b, tracce-docente-dichiarate.test.ts:100 («ogni FK verso utenti(id) è CENSITA», fino a R2B-1.9), la prova gemella di soglia-fotografia (fino a R2B-1.7) e, se la fotografia delle tabelle aggiunge le tabelle della coda, isolamento-sede-coverage (fino a R2B-1.11) [D]. Il critico esegue LOCK-MIGR, __tests__/architecture/isolamento-sede-coverage.test.ts e __tests__/lib/personale/tracce-docente.test.ts, scrive l'elenco esatto dei rossi in $LAVORO/r2b-rossi-f1a.txt e lo passa a R2B-F1b. Un rosso fuori da quell'elenco è uno STOP.

### R2B-1.1 · Fotografia migrazioni applicate — sonnet/low

Rigenera con __tests__/fixtures/migrazioni-fotografia.mjs, leggendo l'uso nella sua testata. I file temporanei vanno in $LAVORO.

- **File:** `__tests__/fixtures/migrazioni-applicate-snapshot.json`
- **Verifica:** Le 3 version della coda presenti.
- **Perché questo modello:** Generatore esistente.

### R2B-1.2 · Fotografia policy — sonnet/low

Rigenera pg-policies-snapshot.json con scripts/rls-fotografia.mjs.

- **File:** `__tests__/fixtures/pg-policies-snapshot.json`
- **Verifica:** Tabelle della coda senza policy.
- **Perché questo modello:** Generatore esistente.

### R2B-1.3 · Fotografia indici unici — sonnet/low

Rigenera con __tests__/fixtures/indici-unici-fotografia.mjs.

- **File:** `__tests__/fixtures/indici-unici-snapshot.json`
- **Verifica:** Indici della coda presenti.
- **Perché questo modello:** Generatore esistente.

### R2B-1.4 · Fotografia FK verso utenti — sonnet/low

Rigenera con __tests__/fixtures/fk-utenti-fotografia.mjs.

- **File:** `__tests__/fixtures/fk-utenti-snapshot.json`
- **Verifica:** Le 5 FK della coda presenti.
- **Perché questo modello:** Generatore esistente.

### R2B-1.5 · Fotografia FK verso le sedi — sonnet/low

Rigenera fk-scuola-id-snapshot.json con scripts/fk-sede-fotografia.mjs.

- **File:** `__tests__/fixtures/fk-scuola-id-snapshot.json`
- **Verifica:** Voci della coda presenti.
- **Perché questo modello:** Generatore esistente.

### R2B-1.6 · Fotografia tabelle con sede — sonnet/low

Rigenera tabelle-scuola-id.json con scripts/tabelle-sede-fotografia.mjs.

- **File:** `__tests__/fixtures/tabelle-scuola-id.json`
- **Verifica:** fatture_coda_voci e fatture_coda_invii presenti.
- **Perché questo modello:** Generatore esistente.

## R2B-F1b · Dichiarazione svuotata, JOB_CRON, tracce, isolamento, PRD

- **Rilascio:** R2-coda-PR-B
- **Obiettivo:** Le modifiche che leggono le fotografie ormai rigenerate (rilievo 1f).
- **Dipende da:** R2B-F1a
- **Critico (sonnet/high):** Rompe su patch reversibile; i test devono diventare rossi:
- MIGRAZIONI_ATTESE_AL_MERGE non vuota;
- un nome di JOB_CRON senza route né battito (health.test.ts:648-657).
Poi controlla che ogni rosso di $LAVORO/r2b-rossi-f1a.txt sia verde: LOCK-MIGR; VT: __tests__/architecture/isolamento-sede-coverage.test.ts __tests__/lib/personale/tracce-docente.test.ts __tests__/api/health.test.ts __tests__/architecture/messaggi-parita-cataloghi.test.ts → 4. Poi UN SOLO commit coi file di R2B-F1a e di R2B-F1b (C0-1).

### R2B-1.7 · Dichiarazione svuotata — sonnet/low

In soglia-fotografia.ts, MIGRAZIONI_ATTESE_AL_MERGE = {}: la prova gemella lo impone ora che la fotografia contiene le 3 version.

- **File:** `__tests__/architecture/soglia-fotografia.ts`
- **Verifica:** VT: __tests__/architecture/soglia-fotografia.test.ts __tests__/architecture/rls-per-sede.test.ts __tests__/architecture/onconflict-arbitro.test.ts __tests__/architecture/tracce-docente-dichiarate.test.ts → 4.
- **Perché questo modello:** Modifica di una riga.

### R2B-1.8 · JOB_CRON con controllo positivo — sonnet/low

In controlli.ts (:149) aggiungi a JOB_CRON {nome:'fatture-coda-tick', finestraMs:20*MIN} e {nome:'fatture-coda-pulizia', finestraMs:26*ORA}, con un commento datato.

Controllo positivo (rilievo 12): cron-sorvegliato-e-applicato scarta in silenzio i nomi senza `cron.schedule('<nome>'` letterale. Verifica che il file 3 li contenga entrambi e che la fotografia ne contenga la version (:62-68).

- **File:** `src/lib/health/controlli.ts`
- **Verifica:** VT: __tests__/api/health.test.ts __tests__/architecture/cron-sorvegliato-e-applicato.test.ts → 2.
`grep -c "cron.schedule('fatture-coda-tick'" supabase/migrations/*_fatture_coda_cron.sql` → 1, e lo stesso per 'fatture-coda-pulizia'.
- **Perché questo modello:** Modifica piccola, con un controllo positivo.

### R2B-1.9 · Tracce docente della coda — sonnet/medium

In tracce-docente-voci.ts aggiungi le 5 voci:
- creato_da e attore_id: bloccano e pesano;
- azione_richiesta_da e sospesa_da: set-null;
- destinatario_id: cascade.
Più le chiavi in messages/{it,en}/adminAltro.json.

Aggiorna anche __tests__/lib/personale/tracce-docente.test.ts (C0-2), che fissa i conteggi a HEAD 29bb04c7: TRACCE_DOCENTE 56 (:111 nel titolo del caso, :114 nell'expect), VOCI_CHE_PESANO 44 (:120), leggere 12 (:130) [V]. Con le 5 voci nuove (2 pesano, 3 no) diventano 61, 46 e 15 [D, dal testo qui sopra]. Aggiorna i tre numeri e il commento datato che li spiega («56 misurate da pg_constraint il 2026-09-20»), con la data e la fonte nuove (la fotografia di R2B-1.4). Se i conteggi misurati non tornano 61/46/15, STOP e rapporto: non si adatta il numero al codice.

- **File:** `src/lib/personale/tracce-docente-voci.ts`, `messages/it/adminAltro.json`, `messages/en/adminAltro.json`, `__tests__/lib/personale/tracce-docente.test.ts`
- **Verifica:** VT: __tests__/architecture/tracce-docente-dichiarate.test.ts __tests__/architecture/messaggi-parita-cataloghi.test.ts __tests__/lib/personale/tracce-docente.test.ts → 3.
- **Perché questo modello:** Dichiarazione su un modello esistente.

### R2B-1.10 · NOT_NULL_ATTESE — sonnet/low

In __tests__/architecture/fk-scuola-id.test.ts aggiungi fatture_coda_voci e fatture_coda_invii a NOT_NULL_ATTESE.

- **File:** `__tests__/architecture/fk-scuola-id.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Modifica di una lista.

### R2B-1.11 · Isolamento sulle route della coda — sonnet/medium

Ritocco misurato di isolamento-sede-coverage sugli handler della coda: una soluzione per handler, con un commento datato.

- **File:** `__tests__/architecture/isolamento-sede-coverage.test.ts`
- **Verifica:** VT → 1.
- **Perché questo modello:** Misura e dichiarazione.

### R2B-1.12 · PRD applicata — sonnet/low

PRD: le righe della coda passano a «✅ APPLICATA il …», con V1-V8 in sintesi.

- **File:** `PRD REGISTRO ELETTRONICO.md`
- **Verifica:** Righe aggiornate; VT: __tests__/architecture/pii-nei-file-tracciati.test.ts → 1.
- **Perché questo modello:** Aggiornamento di stato.

## R2B-F2 · Gate locale PR-B

- **Rilascio:** R2-coda-PR-B
- **Obiettivo:** Gate completo della PR-B.
- **Dipende da:** R2B-F1b
- **Critico (sonnet/high):** Con un gate rosso ripara il proprietario di R2B-F1a o R2B-F1b.

### R2B-2.1 · ESLint — haiku/low

Esegui `npx eslint . --max-warnings 0`.

- **File:** —
- **Verifica:** Uscita 0.
- **Perché questo modello:** Verifica banale.

### R2B-2.2 · Typecheck — haiku/low

Esegui `npx tsc --noEmit`.

- **File:** —
- **Verifica:** Uscita 0.
- **Perché questo modello:** Verifica banale.

### R2B-2.3 · Vitest con conteggio — haiku/low

Formula GATE-VITEST.

- **File:** —
- **Verifica:** «Test Files N passed», con N uguale ai file su disco.
- **Perché questo modello:** Confronta due numeri.

### R2B-2.4 · Build — haiku/low

Esegui `npm run build`.

- **File:** —
- **Verifica:** Uscita 0.
- **Perché questo modello:** Verifica banale.

## R2B-F3 · PR-B: PR, CI e merge (stesso giorno)

- **Rilascio:** R2-coda-PR-B
- **Obiettivo:** Fondere la PR-B lo stesso giorno, dopo battiti ok e la sorveglianza serale senza STOP. Non si aspetta la prova della decisione 0 della mattina dopo (rilievo 7b).
- **Dipende da:** R2B-F2, R2V-F1
- **Critico (sonnet/high):** Controlla le precondizioni dei battiti e che R2V-F1 si sia chiusa senza STOP.

### R2B-3.1 · PR-B fino al merge — sonnet/medium

- Push; `gh pr create` in italiano, con la riga di attribuzione; `gh pr checks --watch` verdi.
- Prima del merge: battiti del tick ok negli ultimi 20' e battito della pulizia presente (V6, V7).
- Merge dopo le 16:00, lontano da :00 e :30, con `gh pr merge --squash --delete-branch`.

- **File:** —
- **Verifica:** PR MERGED e check pass.
- **Perché questo modello:** Procedura standard con precondizioni.

## R2B-F4 · Verifica finale della PR-B

- **Rilascio:** R2-coda-PR-B
- **Obiettivo:** Deploy in success e i due job sorvegliati, prima di qualunque pulizia.
- **Dipende da:** R2B-F3
- **Critico (sonnet/high):** Con il deploy fallito o un job muto: rapporto, e nessuna pulizia.

### R2B-4.1 · Verifica finale — haiku/low

- Deploy della PR-B in success.
- Il controllo cron-battito di /api/health non elenca fatture-coda-tick né fatture-coda-pulizia fra i job muti.

- **File:** —
- **Verifica:** Deploy success e job sorvegliati.
- **Perché questo modello:** Lettura di stati.

## R2B-F5 · Pulizia di tutti i branch

- **Rilascio:** R2-coda-PR-B
- **Obiettivo:** Lasciare main come unico branch, solo dopo la verifica.
- **Dipende da:** R2B-F4
- **Critico (sonnet/high):** Controlla che main sia l'unico branch, in locale e in remoto.

### R2B-5.1 · Pulizia dei branch — sonnet/low

- `git switch main && git pull --ff-only`;
- `git branch -D` di ogni branch secondario locale;
- ogni remoto secondario rimasto: `git push origin --delete <nome>`, mostrato prima di eseguirlo (AGENTS.md §3).

- **File:** —
- **Verifica:** `git branch -a` mostra solo main e origin/main.
- **Perché questo modello:** Cancella branch locali e remoti: niente haiku (rilievo 9b).

## R2V-F2 · Sorveglianza della prima mattina lavorativa e decisione 0 in produzione

- **Rilascio:** R2-avvio
- **Obiettivo:** Seguire il primo lavoro vero della segreteria, 08:00-11:00 del primo giorno lavorativo dopo il merge (rilievo 7a): primi accodamenti veri, invii in massa, eventuali 429 in concorrenza col pannello. Provare la decisione 0 in produzione.
- **Dipende da:** R2V-F1
- **Critico (opus/xhigh):** Gli stessi criteri di STOP di R2V-F1, con la stessa leva d'urgenza. Se entro le 11:00 non è arrivato nessun accodamento vero, prolunga la sorveglianza fino al primo, e lo annota.

### R2V-2.1 · Stato della coda, mattina — sonnet/high

08:00-11:00 Europe/Rome, ogni 15': le stesse query di R2V-1.1, in $LAVORO/sorveglianza-r2.jsonl.

- **File:** `$LAVORO/sorveglianza-r2.jsonl (fuori dal repo)`
- **Verifica:** Serie senza STOP, oppure STOP segnalato.
- **Perché questo modello:** Lettura continua durante il lavoro vero.

### R2V-2.2 · Aruba e ritmo, mattina — sonnet/high

08:00-11:00, ogni 15':
- D-tentativi e D-picco ≤ 50;
- circuito;
- confronto di ogni 429 con l'uso manuale del pannello, che consuma lo stesso secchio.

- **File:** —
- **Verifica:** Picco ≤ 50 e nessun 429, altrimenti STOP.
- **Perché questo modello:** Riconoscimento di picchi e 429 con traffico vero.

### R2V-2.3 · Avvisi e coerenza, mattina — sonnet/high

08:00-11:00, ogni 15': D-avvisi e C1-C8.

- **File:** —
- **Verifica:** C1-C8 a 0.
- **Perché questo modello:** Controlli incrociati.

### R2V-2.4 · Log e salute, mattina — sonnet/medium

08:00-11:00, ogni 15':
- D-log;
- battiti del tick regolari;
- in /api/health, coda-fatture e cron-battito, entrambi ormai sorvegliati.

- **File:** —
- **Verifica:** Battiti regolari, coda-fatture ok, nessun job muto.
- **Perché questo modello:** Come R2V-1.4: D-log passa da `supabase db query --linked` su app_log, quindi sonnet (C0-7).

### R2V-2.5 · Decisione 0 in produzione — sonnet/medium

1. Aspetta il primo accodamento vero della segreteria.
2. Chiede al titolare, tramite il direttore, che la persona chiuda il browser.
3. Controlla con D-voci e D-log che i giri successivi emettano, e che arrivi la fine del gruppo (gruppo_concluso, oppure fine_gruppo dentro l'avviso).

- **File:** —
- **Verifica:** Emissioni dopo la chiusura del browser e fine del gruppo registrata.
- **Perché questo modello:** Coordinamento e lettura di risultati.

## R2-FINE · Resoconto al titolare

- **Rilascio:** R2-avvio
- **Obiettivo:** Chiudere il rilascio col resoconto numerico.
- **Dipende da:** R2B-F5, R2V-F2
- **Critico (sonnet/high):** Controlla che il resoconto sia completo, senza dati personali, e che main sia l'unico branch.

### R2-FINE.1 · Resoconto al titolare — sonnet/medium

Solo numeri e codici:
- V1-V8, D-*, C1-C8;
- sorveglianze serale e mattutina;
- decisione 0 provata;
- i cinque default del titolare, come applicati (C0-18).
Ricorda che ship-cycle.md e .claude/rules/migrazioni.md sono in contrasto con la decisione 25, e riporta i limiti dichiarati.

- **File:** —
- **Verifica:** Resoconto consegnato, senza dati personali.
- **Perché questo modello:** Sintesi chiara.

## Note

- CONVENZIONI (valgono per tutti i compiti)
- $LAVORO: percorso assoluto FISSO, fuori dal repo, dato dall'orchestratore a inizio lavoro. Suggerito: /Users/lerri/kidville-lavoro/coda-fatture-aruba. Lo crea R1-0.2 con permessi 700. Tutti gli artefatti fra una fase e l'altra stanno lì (rilievo 15c): r1-base.json, r1-version.txt, indagine-r1/, allinea/, orfane/, fk.sql e fk.json, dry-run-*.txt, sorveglianza-*.jsonl, r2-t1.txt, r2-base.json, deploy-pr-a.txt, asserzioni-lotto.txt. I file con dati personali hanno permessi 0600 e si cancellano in uscita.
- VT: f1 f2 … → N: esegui `npx vitest run f1 f2 …` e leggi la riga «Test Files N passed». N deve essere esatto: un N diverso vuol dire che dei file non sono stati eseguiti (.claude/rules/test.md). --exclude è un'opzione di vitest 4.1.10 (verificata).
- GUARDIA-SQL <file>: `grep -nEi 'unique|primary key|policy|row level security|drop table|add constraint|drop constraint|references[[:space:]]+(public[.])?utenti|NON APPLICATA' <file>` → nessuna riga; `grep -nEi '^[[:space:]]*scuola_id[[:space:]]+uuid' <file>` → nessuna riga. È il riconoscitore completo dei lock: toccaLaRls in soglia-fotografia.ts:173-182, fk-scuola-id.test.ts:302, tracce-docente-dichiarate.test.ts:153-158, onconflict-arbitro.test.ts:408-411 e il MARCATA_NON_APPLICATA di cron-sorvegliato-e-applicato (rilievo 4). Si applica ai file 2 e 3; i compiti SQL lo usano sul proprio file.
- LOCK-MIGR (lo esegue il critico a fine fase, perché scandisce tutte le migrazioni): `npx vitest run __tests__/architecture/rls-per-sede.test.ts __tests__/architecture/onconflict-arbitro.test.ts __tests__/architecture/tracce-docente-dichiarate.test.ts __tests__/architecture/fk-scuola-id.test.ts __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts __tests__/architecture/security-definer-revoke-lock.test.ts __tests__/architecture/migrazioni-senza-sede-cablata.test.ts __tests__/architecture/cron-sorvegliato-e-applicato.test.ts` → 9.
- PW-LIST <spec>: `npx playwright test --list --project=chromium --no-deps <spec>`. Playwright 1.62.1; il progetto setup è una dipendenza e senza --no-deps entrerebbe nel conteggio (rilievo 15b).
- GATE-VITEST: `N=$(find . -path ./node_modules -prune -o \( -name '*.test.ts' -o -name '*.test.tsx' \) -print | grep -v -e '^./e2e/' -e '^./ios/' -e '^./android/' -e '^./.claude/' | wc -l); npx vitest run; echo "exit=$? file_su_disco=$N"`. In zsh niente PIPESTATUS.
- Test Aruba, un proprietario per fase (rilievo 2). In ogni fase di R1 e di R2A un solo compito tocca emissione.ts o client.ts: R1-2.1, R2A-2.5, R2A-3.4, R2A-4.8, R2A-5.5. Quel compito possiede TUTTI i test esistenti di __tests__/lib/aruba che rompe, più __tests__/api/fattura-emissione.test.ts, __tests__/api/fattura-emissione-split.test.ts e __tests__/helpers/emissione-supabase-finto.test.ts. Nella sua verifica esclude con --exclude i soli file nuovi scritti in parallelo nella stessa cartella: confronto-documento e accesso in R2A-F2, reinvio in R2A-F3.
- Coppie codice/test nella stessa fase (TDD «insieme», regola 3). È ammesso solo fra un file SQL e i suoi test PGlite, scritti dal contratto su file disgiunti: il test deve compilare e fallire solo per oggetti mancanti, e il verde lo misura il critico a fine fase. Ogni altra dipendenza sta in una fase successiva; per questo esistono le sottofasi a/b (rilievo 1).
- Rossi dichiarati (elenco CHIUSO, C0-1). Ogni altro rosso a fine fase va riparato prima del commit. Un rosso dichiarato deve fallire solo per AssertionError o per l'oggetto mancante dichiarato, mai per un errore di caricamento; il critico che lo chiude lo vede verde.
  - tracce-docente-dichiarate da R1-F1a a R1-F5 (si chiude con R1-5.1);
  - i casi nuovi di R1-1.4 in fattura-route.test.ts e fattura-lotto.test.ts, da R1-F1a a R1-F2 (si chiudono con R1-2.2);
  - i test di R1-1.7, R1-1.8 e R1-1.9, da R1-F1b a R1-F2 (si chiudono con R1-2.1);
  - le tre guardie di freschezza sul file 1 (rls-per-sede, onconflict-arbitro, tracce-docente-dichiarate) da R2A-F3 a R2A-F4;
  - R2B: nessun rosso si committa. R2B-F1a NON fa commit; i suoi rossi transitori (tracce-docente-dichiarate.test.ts:100 fino a R2B-1.9, la prova gemella di soglia-fotografia fino a R2B-1.7, isolamento-sede-coverage fino a R2B-1.11 se la fotografia delle tabelle lo fa diventare rosso) restano nell'albero di lavoro, e il critico di R2B-F1b fa UN SOLO commit coi file di entrambe le sottofasi, a tutto verde.
- Chiavi i18n mancanti nelle fasi UI (C0-5). In R2A-F3, R2A-F4, R2A-F5 e R2A-F6b nessun compito parallelo scrive messages/{it,en}/adminContabilita.json o adminStudents.json (li scrive solo R2A-2.9, in R2A-F2; in R2A-F6b li tocca anche R2A-6.15, per togliere le reconLotto*). Un compito che trova una chiave mancante NON la inventa: la elenca nel proprio rapporto (chiave, testo it, testo en, file). Dopo i compiti paralleli e PRIMA del critico gira, in sequenza, il compito CHIAVI-<fase> (sonnet/medium): possiede i quattro cataloghi, aggiunge solo le chiavi segnalate, e verifica con VT: __tests__/architecture/messaggi-parita-cataloghi.test.ts __tests__/architecture/messaggi-plurali-e-glossario.test.ts → 2, più i test dei compiti che le avevano segnalate. Se nessuno ha segnalato nulla non tocca nulla. In R2A-F6b gira DOPO R2A-6.15, così i due non scrivono mai insieme lo stesso file.
- Filtri di vitest (C0-3). Il filtro posizionale di vitest confronta per SOTTOSTRINGA (`testFile.includes(f)`, node_modules/vitest/dist/chunks/cli-api.BK8pd4xc.js:10869): `__tests__/lib/aruba` prende anche `__tests__/lib/aruba-lettura.test.ts` (creato da R1-1.5). Per una cartella, nelle VT a N esatto, si scrive SEMPRE la barra finale: `__tests__/lib/aruba/`.
- Commit: uno per fase o sottofase, fatto dal critico dopo l'esito positivo, con git add per percorso e messaggio che termina con 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'. Le PR finiscono con '🤖 Generated with [Claude Code](https://claude.com/claude-code)'. Il critico rompe il codice solo su patch reversibile e la ripristina prima del commit. Chi rompe ripara; un file fuori da file_posseduti che diventa rosso si segnala al critico, che lo assegna secondo C§19.
- Modelli: haiku solo per verifiche in sola lettura con esito atteso noto; ogni operazione che cambia lo stato di git, o che lancia comandi capaci di scrivere in produzione, va a sonnet o opus (rilievo 9). Conta lo STRUMENTO, non l'intenzione (C0-7): `supabase db query --linked` esegue SQL arbitrario in produzione anche quando il compito vuole solo leggere, e sulle tabelle di log può restituire testo personale; quindi ogni compito che lo usa, uno script con --applica o --allinea, e la sospensione della coda vanno a sonnet o opus, mai a haiku. Haiku resta per gate locali (eslint, tsc, vitest, build, elenco E2E) e per letture via `gh api` o /api/health.
- RISPOSTA AI 15 RILIEVI DELL'ULTIMA CRITICA
1. Dipendenze nella stessa fase:
   a) R1-F12a/b/c;
   b) sync e test esistenti in un compito solo (R2A-6.5);
   c) FatturaButton e FatturaChip in R2A-F6a, le pagine in R2A-F6b; porte e giro in un compito solo (R2A-6.4);
   d) impianto in R2A-F7b;
   e) E2E in R2A-F9b;
   f) R2B-F1a/b;
   g) R2A-F10a/b;
   h) R1-F1a/b.
   In più: ritmo prima di stima; ui-stati prima di testi-notifica; tono e chip in un compito solo; lotto-fatture ridotto dopo il 410 e la rimozione del pannello.
2. Test Aruba e fattura-emissione*: un proprietario per fase, con verifiche ristrette tramite --exclude (CONVENZIONI).
3. 30 RPC nel file 2 più 2 nel file 3 = 32: R2A-1.1, 6.1, 9.9.
4. GUARDIA-SQL completa nei 4 compiti SQL, più LOCK-MIGR per ogni critico.
5. NUMERO_SEGNAPOSTO_PROVA definito solo in confronto-documento.ts (strato Aruba, S35); ritmo.ts non lo definisce e non lo riesporta; emissione.ts lo importa.
6. R1-1.5: tabella assente (to_regclass NULL, oppure 42P01 alla seconda lettura) → passa; ogni altro errore → blocca; controlli negativi su entrambi.
7. Finestre del mattino 08:00-11:00: R1-F11 e R2V-F2; sorveglianza serale in R1-9.5; il merge della PR-B dipende solo da R2V-F1.
8. R2A-7.3: 24 export misurati (20 tolti, 4 restano); grep sugli import dal modulo.
9. Dry-run a sonnet, col comando scritto per intero, su file, e letto dal critico; branch a sonnet; T1 a opus.
10. Test propri per navigazione, intestazione, porte, spec e CLI (ordine letture → scritture, --solo, esclusione degli invii); il bidello si prova nella sua stessa fase.
11. Parità CR1 provata eseguendo: fixture di R1 e test R2A-4.4; il lock specchio non confronta testi.
12. cron.schedule coi nomi letterali, controllo positivo in R2A-4.3 e R2B-1.8.
13. Arresto d'urgenza provato su PGlite col testo esatto (R2A-6.2).
14. 59 codici di voce e 14 fissi d'invio, in R2A-1.1 e 3.2.
15. Primo tick dopo il READY; PW-LIST con chromium; $LAVORO; verifica GDPR allargata.
- DOMANDE PER IL TITOLARE (nel resoconto R1-16.2)
- Nessuna domanda aperta (C0-18): Q1 e Q2 sono chiuse dai default approvati del titolare (contratto C0.2). Q1: il numero conteso chiude `errore`, l'invio `bruciata`, e si rifattura con «Rimetti in coda» e numero nuovo; «Rimanda» non esiste. Q2: una voce in `errore` con invii tutti `rifiutata`/`bruciata` si toglie.
- MIGRAZIONI E PRODUZIONE
- Le migrazioni le applica solo l'integrazione GitHub di Supabase al merge. Mai apply_migration, mai db push in scrittura, mai --yes, mai approvare migrate.yml, mai migrate-ci.
- CLI supabase 2.109.0 (verificata): --dry-run esiste; si usa solo nella forma esatta di R1-7.2 e R2A-12.1.
- .claude/commands/ship-cycle.md:348-352 e .claude/rules/migrazioni.md prescrivono ancora apply_migration, in contrasto con la decisione 25: non si seguono, e decide il titolare.
- In produzione solo SELECT di aggregati, uuid, numeri e codici. Scritture ammesse, sempre mostrate prima di eseguirle:
  - --allinea condizionale (R1-4.1);
  - orfane (R1-10.1);
  - arresto d'urgenza (R2V);
  - rollback del deploy (R2A-F14).
- Gli E2E si eseguono solo in CI: .env.local punta alla produzione.
- DECISIONI DI QUESTA SCOMPOSIZIONE (entrano nella spec v5, R2A-1.3)
- T1 e i nomi delle tre migrazioni si fissano una volta sola in R2A-F0 ($LAVORO/r2-t1.txt), così file SQL, dichiarazione delle fotografie e test si scrivono senza dipendere l'uno dall'altro. R2A-F10a li ricontrolla prima della PR.
- NUMERO_SEGNAPOSTO_PROVA vive solo in src/lib/aruba/confronto-documento.ts.
- Nomi di mappe e tuple: fanno fede D2 e D6 (CAUSALE_MODI, AZIONI_RICHIESTE, INTESTATARIO_ORIGINE, TIPI_DOCUMENTO_SUPPORTATI). D3 e D4 si adeguano.
- vocabolario-log.ts è escluso dal lock specchio come catalogo; nessuna eccezione per sync/route.ts.
- risolvi.ts tipizza il giornale con un'interfaccia locale (GiornaleReinvio), per non importare giro.ts.
- Il campo coda arriva in MovimentoDialog già in R2A-6.7, insieme alla rinomina. Verificato: solo MovimentoDialog passa onEmessa, e gli altri test di componente mockano FatturaButton. RegistraIncassoModal e QuickAcquistoModal non cambiano.
- La vecchia coppia «commit congiunto» D5+D4 si divide in due compiti sequenziali, entrambi verdi:
  - R2A-6.15 toglie il pannello e aggiorna il lock intestatario (2);
  - R2A-7.3 riduce lotto-fatture.ts quando nessuno ne importa più i nomi.
- FILE NUOVI FUORI DA C§19 (il proprietario li aggiunge a §19 nel primo commit)
- D1: __tests__/fixtures/casi-partita-non-registrata.ts, __tests__/lib/aruba-lettura.test.ts, __tests__/lib/numerazione-serie-cli.test.ts, __tests__/lib/fatture-orfane-cli.test.ts.
- D2: __tests__/lib/fatture-coda/contratto-db.test.ts, __tests__/helpers/fatture-coda-pglite.test.ts, __tests__/db/fatture-coda-{accoda,ordine,bidello,avvisi,scarto-sdi}.test.ts.
- D3: __tests__/lib/aruba/accesso.test.ts, __tests__/lib/fatture-coda/{coda-db,documenti,scarti,porte}.test.ts, __tests__/lib/pagamenti/ricorda-persona-sulla-scheda.test.ts, __tests__/helpers/emissione-supabase-finto(.test).ts.
- D4: __tests__/lib/fatture-coda/{api-contratto,situazione,periodo,risposte-api}.test.ts, __tests__/lib/pagamenti/fatture-dei-pagamenti.test.ts, __tests__/api/fattura-coda-{precontrollo,togli,rimetti,urgente,causale,verifica,sospensione}.test.ts, fattura-viva.ts (solo commento), annullo-riapre-movimento.test.ts.
- D5: __tests__/lib/fatture-coda/ui-stati.test.ts, __tests__/components/coda/{use-coda-fatture,contatore-coda,CodaStatoBanner,CodaVoce,TogliDallaCodaDialog,CausaleVoceDialog,SospendiCodaDialog}.test.tsx, __tests__/ui/admin-nav-contatore-coda.test.tsx, __tests__/components/pagamenti-intestazione-coda.test.tsx.
- D6: __tests__/lib/fatture-coda/vocabolario-log.test.ts, __tests__/helpers/aruba-finto.test.ts, __tests__/helpers/cardine-impianto.ts, __tests__/lib/fatture-coda/cardine-impianto.test.ts, __tests__/lib/fatture-coda/coda-senza-browser-verifiche.test.ts, e2e/admin-coda-fatture-ingressi.spec.ts.
- FATTI VERIFICATI IN QUESTA SESSIONE (sola lettura, 23/09, HEAD 29bb04c7, working tree pulito)
- lotto-fatture.ts: 24 export. Il modulo lo importano solo RiconciliazionePanel.tsx (TETTO_LOTTO), LottoFatturePanel.tsx, lotto/route.ts, lotto-fatture.test.ts, fattura-lotto.test.ts e RiconciliazioneLottoFatture.test.tsx, più l'import DINAMICO di __tests__/pagamenti/tetto-orario-aruba.test.ts:155 (TETTO_LOTTO), che una ricerca su `from '…'` non vede (C0-13, rimisurato il 23/09 con `grep -rn "lotto-fatture'" src __tests__ e2e`: 7 righe). TETTO_LOTTO esiste anche come costante locale in 4 test gdpr-retention e scadenze.
- __tests__/lib/aruba: 28 file .test.ts. emettiFatturaPagamento lo chiamano davvero __tests__/api/fattura-emissione.test.ts e fattura-emissione-split.test.ts. fattura-route, fattura-intestatario-route, fattura-route-quota-estranea e fattura-lotto lo mockano.
- onEmessa: solo in FatturaButton.tsx, MovimentoDialog.tsx e MovimentoDialog.test.tsx.
- Mockano FatturaButton: MovimentoDialog*, PagamentoDrawer, QuickAcquistoModal*, RegistraIncassoModal, TransazioniPanel, RiconciliazionePanel*, riconciliazione-avviso-solo-se-visto. Montano quello vero: FatturaButton*, motivo-scarto-solo-in-segreteria, errore-server-tradotto-cockpit, StoricoPagamenti-fattura-scarico.
- cron-sorvegliato-e-applicato: legge migrazioni-applicate-snapshot.json (:61-68); installano() usa la regex cron.schedule('<nome>' (:86-89); COPPIE scarta i nomi non installati (:92).
- health.test.ts:648-657: un nome di JOB_CRON richiede const JOB nelle route o 'cron:<nome>' nelle migrazioni.
- vitest 4.1.10 ha --exclude; Playwright 1.62.1 ha i progetti setup, chromium, contrasto, webkit e smoke-artefatto; supabase CLI 2.109.0.
- pagamenti/page.tsx è un componente client; pagamenti-contabilita.test.tsx monta ContabilitaNav, non la pagina.
- __tests__/api ha 12 test della riconciliazione (11 pagamenti-riconciliazione* più riconciliazione-ripresa-trasporto).
- __tests__/architecture: 151 file; test su disco: 1415.
- MCP supabase non autenticato: gli advisors restano non eseguibili.
- SEQUENZA E FINESTRE ORARIE
- R1 per intero, fino a R1-F16, prima di R2A-F0.
  - Merge della PR-D1 dopo le 16:00, ai minuti :10-:20 o :40-:50.
  - Sorveglianza serale fino alle 18:30.
  - Orfane dopo le 18:30.
  - Sorveglianza del mattino dopo, 08:00-11:00.
  - PR-D1b in parallelo col mattino (R1-F12a dipende da R1-F10); la chiusura aspetta entrambi.
- R2A-F8 (misura) si chiude a zero rossi prima di R2A-F9a. Il ponte R2A-7.2 dev'essere verde prima di R2A-F8.
- PR-A: merge a :43 o :13 dopo le 16:00. Poi V1-V8 (V7 sul primo tick dopo il READY) e sorveglianza serale di 3 ore (R2V-F1).
- R2B-F0 parte dopo R2A-F14, in parallelo con R2V-F1.
- Il merge della PR-B (stesso giorno) dipende da R2B-F2 e da R2V-F1 senza STOP, non dalla prova della decisione 0.
- R2V-F2, il primo mattino lavorativo alle 08:00-11:00, prova la decisione 0 con la segreteria vera. Il resoconto finale aspetta la pulizia della PR-B e R2V-F2.
- Nessun gradino di prova: la coda parte con tutto (decisione 28). Lo STOP è «Sospendi coda»; l'arresto d'urgenza è fatture_coda_sospendi(NULL, motivo), provato in R2A-6.2.
- LEGENDA
- C§ = CONTRATTO UNICO v4; Dn§ = design del componente.
- Le correzioni CR1-CR12 valgono sopra C e Dn e sono raccolte nella spec v5 (R2A-1.3). In breve:
  - CR1: predicato unico in forma CASE;
  - CR2: p_solo_verifica e giornale_non_aperto;
  - CR3: «Riprova fattura» in linea;
  - CR4: battito della pulizia letterale;
  - CR5: IS DISTINCT FROM;
  - CR6: rimetti con la scelta salvata;
  - CR7: info scarto-solo-chi-ha-accodato;
  - CR8: riga specchiata nel ponte e verificaFormaInvio con la voce;
  - CR9: formattaNumeroFattura; nessun «Rimanda» su numero conteso (C0.2 D3);
  - CR10: nomi di D2 e D6;
  - CR11: richieste accolte;
  - CR12: F3 e F7 corretti, passo 4 di ship-cycle.md non eseguito.
