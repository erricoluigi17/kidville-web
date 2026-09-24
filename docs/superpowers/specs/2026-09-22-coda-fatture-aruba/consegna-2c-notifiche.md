# Coda fatture Aruba — consegna 2c: le notifiche (decisioni 12 e 21 sul nucleo)

Piano esecutivo **unico** della consegna 2c. L'ha scritto un solo autore, prima degli esecutori in parallelo
(lezione 1 di `HANDOFF.md:84`). Prevale sui cinque rapporti dei lettori da cui nasce (infrastruttura delle
notifiche, eventi della coda, scarti SdI, riallineamento del design D5, infrastruttura e documenti) e sulla bozza
precedente di questo stesso file. Struttura: `consegna-2b-rifiniture.md`, più corta. **Rivisto al giro 1 del
critico** (§8): via il compito SDI, la push allo staff ristretta alla coda (compito DISPATCH), §0 rimisurato
dopo il primo uso vero della coda. **Riallineato alla correzione dei 65 s** (PR #164, in produzione dalle 15:37 del
24/09, §9): DOC passo A ridotto a ciò che la correzione non ha scritto (la #164 in produzione e tre frasi false), le
prove su PGlite con la sua migrazione sotto, le citazioni rilette.

- Richiesta del titolare: «correggi tutto e poi vai avanti fino al deploy». La 2c è il punto 1 «in ordine di
  valore» di `HANDOFF.md:53`. Le decisioni sono definitive (`/Users/lerri/.claude/plans/voglio-velocizzare-la-fatturazione-generic-marshmallow.md`):
  **21** (`:66-69`), **12** (`:45`), **6** (`:37-39`). Qui non si discutono. Sulle domande aperte dei lettori ha
  deciso la sessione principale (§1.3); le scelte valgono fino alla risposta del titolare.
- È la consegna **più piccola** che le soddisfa sul nucleo com'è: nessuna tabella, nessuna route e nessun codice
  d'esito nuovi; il motore (`src/lib/fatture-coda/giro.ts`) e la route della sync non si toccano. Una migrazione di
  sole colonne e una funzione, che **non** accende le guardie delle fotografie: niente `MIGRAZIONI_ATTESE_AL_MERGE`,
  niente PR-B.
- Branch `feat/coda-fatture-notifiche-2c`, aperto da `main` (`52d8e7a7`, lo squash della #164) dopo il deploy della
  #164 e la pulizia dei branch (AGENTS.md, punti 1 e 3: alle 15:43 esistono solo `main` e questo, §0 «Albero»). Il
  suo **primo commit** è DOC passo A (§4.1: la #164 in produzione e le frasi false che non ha toccato) più questo
  piano, che oggi sta fuori dal repo.
- I numeri di riga sono di `52d8e7a7`, che ha lo stesso albero della testa della #164 (`2bcb2734`: `git diff`
  vuoto), ricontrollati il 24/09 fra le 15:10 e le 15:45. Per i file che la #164 non tocca coincidono con quelli di
  `02eb9836`. Chi esegue li rilegge e modifica per **stringa**, mai per numero.

## Riepilogo

| | |
|---|---|
| Compiti | 7: DOC (passi A e B), SQL, TESTI, PUSH, DISPATCH, INVIO, ROTTE |
| Onde | 0: DOC A · 1: SQL, TESTI, PUSH · 2: INVIO e DISPATCH, poi ROTTE · 3: DOC B |
| File | 26 più questo piano (24 nella stesura, più i due della mensa del giro 2, §2.3). Nuovi: la migrazione, `avvisi-testi.ts`, `avvisi.ts` e 3 file di test |
| Migrazione | `supabase/migrations/<T>_fatture_coda_avvisi.sql`, con `<T>` dopo `20260924103451` (la correzione dei 65 s): quattro colonne-segno (`fatture_coda.avviso_errore_presa`, `avviso_fine_presa`; `fatture_coda_stato.avviso_pausa_fino_a`, `avviso_sospesa_il`), la linea di partenza e `fatture_coda_avvisi_prendi(p_limite)` |
| Tipi nuovi | `fattura_coda_fine`, `fattura_coda_errori`, `fattura_coda_da_verificare`, `fattura_coda_pausa`, `fattura_coda_sospesa`, `fattura_coda_ripresa`: fuori dal catalogo, accodati senza sede, non si spengono |
| Tipo esistente | `fattura_scartata`: **invariato** (staff della sede, con l'interruttore); allo staff iscritto arriva anche in push |
| Push allo staff | `PushOptIn` nella pagina «Coda fatture» (web e app); il dispatch porta allo staff **solo** i sei tipi della coda e `fattura_scartata` |
| File di test | 1442 → **1445** |

---

## 0. Stato misurato (solo letture, 24/09/2026, Roma: fra le 06:39 e le 10:40, e fra le 15:09 e le 15:45 per il riallineo alla #164)

⚠️ I fatti datati restano, le righe al presente invecchiano: ogni riga dice quando è stata letta. Al giro 1 questa
tabella diceva «0 voci», e alle 09:56 la coda ha cominciato a lavorare davvero; al riallineo la #164 aveva già
scritto in PRD e HANDOFF quasi tutto ciò che DOC passo A doveva scrivere, e durante il riallineo è andata in
produzione (15:36–15:37): le righe della #164, dei run, delle migrazioni e dell'albero sono state rilette dopo
(15:43–15:44) (§4.1, §9).

| Cosa | Valore | Come |
|---|---|---|
| PR #163 (2b) | MERGED 04:38:05Z (06:38:05), `02eb9836`; deploy Vercel di produzione `success` 04:39:58Z (**06:39:58**) | `gh pr view 163`, `gh api …/deployments/6630315575/statuses` (riga di `vercel[bot]`) |
| **PR #164** (la correzione dei 65 s) | **MERGED** 13:36:06Z (**15:36:06**), `52d8e7a7`, squash di `2bcb2734` (stesso albero: `git diff` vuoto); CI della testa (`36003275694`) `quality` ed `e2e` verdi alle 15:31 (il giro prima era caduto su un test instabile fuori dalla coda, corretto in `2bcb2734`: PRD, voce della correzione, punto 7b); deploy di produzione `6639076586` `success` 13:37:13Z (**15:37:13**). **Verificata alle 15:44** (solo `SELECT`, i controlli del suo §5.2): `20260924103451` in `schema_migrations`, nessun nome doppio; `md5` dei corpi di `fatture_coda_prendi` `2ec5384d4fe689b6a86255e10e348263` (2557 caratteri) e di `fatture_coda_rilascia` `0037c8fb96ea2e7cef01506e84505f91` (1607) uguali al file, una riga per funzione, definer, `search_path=public, pg_temp`, `anon`/`auth` falsi, `sr` vero, argomenti invariati; `ultimo_accesso_il` `timestamp with time zone`, nulla ammessa, ancora vuota (nessun giro con voci dopo il deploy); 0 righe di `app_log` con `stato_http` 429 dopo il deploy. Porta: la migrazione `20260924103451_fatture_coda_distanza_accessi.sql` (colonna `fatture_coda_stato.ultimo_accesso_il`; `CREATE OR REPLACE` di `fatture_coda_prendi`, che non consegna voci entro 65 s dall'ultimo accesso, `:80-83`, e lo timbra quando ne consegna, `:114-118`, e di `fatture_coda_rilascia`, che lo timbra alla fine del giro, `:147-152`; firme e privilegi invariati); `giro.ts` (l'attesa del residuo, al più 66 s, prima del bidello, `:346-358`; la finestra della sync `:59–:05` e `:29–:35`, `:221`; i log `attesa-accesso` e `accesso-non-letto`); `stato.ts` («Inviata» → 3); PRD e HANDOFF (la 2b in produzione, le prime fatture vere, i due 429, il rilievo (g) chiuso). Dei 24 file di §2.3 tocca solo PRD, HANDOFF, `nucleo.md` e il test su PGlite; `giro.ts` e `giro.test.ts` sono fra quelli che la 2c non tocca (§2.4) | `gh pr view 164`, `git diff --stat 02eb9836 2bcb2734` |
| Run «DB migrate (prod)» | della #164, `36006773356`: **in attesa** (creato 13:36:09Z, ancora così alle 15:44), non approvato: lo annullerà il run del merge della 2c. Della 2b, `35956482220`: **annullato** alle 13:36:12Z (**15:36:12**) dal run della #164; della 2a, `35920312716`: **annullato** alle 04:38:09Z (06:38:09) dal run della 2b (`migrate.yml:31-35`: parte a ogni push su `main` che tocca `supabase/migrations/**`; `:64-66`: `concurrency: db-migrate-prod`, `cancel-in-progress: true`). HANDOFF `:13`, `:14` e il PRD `:2119`, `:2231` dicono ancora che quei due «restano in attesa»: la #164 non li ha toccati, li corregge DOC passo A | `gh run list --workflow "DB migrate (prod)"` |
| Migrazioni da `20260923000000` | in produzione alle 15:44: `…071958`, `…102831` (nucleo), `…191725` (2a), `20260924010455` (2b), **`20260924103451`** (la correzione, applicata dall'integrazione al merge della #164; alle 15:10 non c'era ancora); nessun nome doppio | `supabase_migrations.schema_migrations` |
| `fatture_coda_chiudi` | 1 riga; `md5(prosrc)` `4869df98d72fe9c07cc4f296cb469fb2`, 2765 caratteri, **uguale** al corpo `AS $$ … $$` del file della 2b (md5 con node); definer; `search_path=public, pg_temp`; `anon`/`auth` falsi, `sr` vero; argomenti invariati; 0 emesse con un messaggio (ricontrollato alle 09:18) | `pg_proc`, `has_function_privilege` |
| D14 | eseguita dalla sessione principale il 24/09 alle 06:40:42, con l'`UPDATE` di `consegna-2b-rifiniture.md` §6.5b mostrato prima: **13** righe; al giro di `video-retention` delle 06:43 i 13 sono stati inviati, 0 in quarantena. Alle 09:18 `video_outbox`: `non_inviati` 0, `quarantena` 0 | dato della sessione principale; `SELECT` di §6.5c |
| `fatture_coda` (alle 15:10) | **23 voci, tutte `emessa`**, in 19 gruppi: 13 urgenti (il pulsante «Fattura», un gruppo ciascuna) e 10 in 6 gruppi; 0 in coda, 0 in errore, 0 tolte. Non sospesa; `pausa_motivo` `aruba-429` con `pausa_fino_a` 13:39:33, **scaduta**; `ultimo_giro_il` 15:07:02 (il tick delle 15:07); nessun lavoratore. **0 trigger utente** su `fatture_coda` e `fatture_coda_stato`; nessuna funzione `fatture_coda_avvisi%`. Colonne: `fatture_coda` 23; `fatture_coda_stato` 9 alle 15:10 (quelle del nucleo), **10** dalla #164 (più `ultimo_accesso_il`, misurato alle 15:44); con la 2c 12 e 25 (misurato su PGlite, §0.1). Alle 15:44: le stesse 23 voci, 0 in coda o in invio, `ultimo_giro_il` 15:42:01 | conteggi, `pg_trigger`, `pg_proc`, `information_schema.columns` |
| Il primo giorno vero (24/09) | accodamenti fra le 09:56:42 e le 12:53:11; `voce-emessa` **23**, fra le 09:57:03 e le 13:42:49; giri con emesse: 09:57:31 (4, 48,3 s), cinque da 1 fra le 10:09:56 e le 12:39:29, 11:13:21 (10, 81,2 s: il tick delle 11:12, a pausa finita), 13:42:49 (4: il tick delle 13:42, idem). **Due 429 sul `signin`**, alle 10:09:59,5 e alle 12:39:33,3 (una riga `aruba:signin` `error` con `stato_http` 429 e 2 occorrenze), ciascuno con `voce-aruba_429` (`warn`) e `giro-concluso` con `riprova` 1 e `pausa_minuti` 60: la coda di tutte le sedi è rimasta ferma dalle 10:09:59 alle 11:09:59 e dalle 12:39:33 alle 13:39:33. Tutte e due le volte un secondo pulsante ha svegliato un giro che ha fatto il `signin` circa 41 e 19,5 s dopo quello del giro precedente (HANDOFF `:17`): è il rilievo (g), che la #164 chiude | `app_log` (`visto_la_prima`, `visto_l_ultima`, `occorrenze`, campi numerici), `fatture_coda`, `fatture_coda_stato` |
| `notifiche` | vincoli `notifiche_pkey` e `notifiche_utente_id_fkey` (FK `cascade`, `__tests__/fixtures/fk-utenti-snapshot.json:158-160`), **l'unica FK fra `notifiche` e `utenti`** in tutti e due i versi; nessun CHECK su `tipo`; nessun indice unico oltre la chiave; 0 righe `fattura_coda%` (ricontrollato fra le 15:10 e le 15:30); 0 pendenti scadute | `pg_constraint`, `pg_indexes`, conteggi |
| Notifiche allo staff, ultimi 30 giorni | **3.267** su **7** destinatari (admin 1.734 su 2, segreteria 1.533 su 5; 0 al coordinator e alla cuoca), 16 tipi, circa 15 al giorno a testa. I primi: `candidatura_ricevuta` 992, `onboarding_completato` 953, `iscrizione_ricevuta` 615, `credenziali` 209, `avviso_risposta` 176, `pratica_personale_ricevuta` 77, `assenza_comunicata` 73, `fattura_scartata` 61. **1.236** sono di tipi il cui corpo interpola un nome: `onboarding_completato` (`parent/onboarding/route.ts:379`), `credenziali` (`admin/regenerate-credentials/route.ts:371`), `assenza_comunicata` (`parent/presenze/comunica-assenza/route.ts:733-735`), `allergie_aggiornate` 1 (`admin/students/route.ts:1385`); alla cuoca andrebbe `mensa_allergia`, col nome e gli allergeni (`src/lib/mensa/notify.ts:113`, destinatari `:64`) | conteggi per ruolo e per tipo |
| Cron | `notifiche-dispatch` `*/5 * * * *`, `fatture-coda-tick` `7,12,17,22,27,37,42,47,52,57 * * * *`, `fatture-sdi-sync` `*/30 * * * *`: tutti attivi (ricontrollato fra le 15:10 e le 15:30: la #164 non cambia i minuti del cron, solo la finestra del giro, T6) | `cron.job` |
| PostgREST | event trigger `pgrst_ddl_watch` (`ddl_command_end`) e `pgrst_drop_watch` attivi: la cache dello schema si ricarica a ogni DDL. Il `NOTIFY pgrst` in fondo alla migrazione della #164 (`:188`) alla 2c non serve: il nucleo ha creato nove RPC senza, e il primo giro del cron, 8 s dopo il deploy, ha dato `niente-da-fare` (HANDOFF `:11`), cioè `fatture_coda_prendi` trovata e chiamata (un `PGRST202` avrebbe dato `prendi-fallita` ed esito `errore`, `giro.ts:399-405`) | `pg_event_trigger` |
| Staff | 13 (4 admin, 1 coordinator, 8 segreteria), 6 con la sede primaria di collaudo, più **1 cuoca**, che vive nell'area admin (`active-role.ts:25`, `:49`); **0 su 14 con una `push_subscription`** (ricontrollato fra le 15:10 e le 15:30); **0 su 14 con anche il profilo genitore** (ponte `parents`, `profili.ts:12-18`) | conteggi su `utenti`, `push_subscriptions`, `parents` |
| Admin delle sedi reali | **2** (primaria o ponte `utenti_scuole` su una delle 3 sedi che non sono di collaudo; 5 righe in `schools`, 2 di collaudo), nessuno con la primaria di collaudo | idem |
| Scarti SdI | 22 fatture in stato 2, 4 o 9, tutte con `creato_da` e con `sezionale`; `fattura_scartata`: 61 notifiche su 21 fatture a 7 destinatari, e **in 21 fatture su 21 l'ha ricevuta anche chi l'aveva emessa** (ricontrollato alle 10:36; 22, 61 e 21 invariati fra le 15:10 e le 15:30); interruttore spento in 0 righe di `admin_settings` su 4 | conteggi |
| `fatture_emesse` | **457** fra le 15:10 e le 15:30 (434 alle 10:40, più le 23 della coda), tutte negli ultimi 30 giorni: la coda sarà dell'ordine di qualche migliaio di voci l'anno | conteggio |
| File di test | **1442** (ricontrollato fra le 15:10 e le 15:30: la #164 non ne aggiunge) | `find` con le esclusioni di `vitest.config.ts:22` |
| Albero | alle 15:43 l'albero di lavoro è su **`feat/coda-fatture-notifiche-2c` = `main` = `origin/main` = `52d8e7a7`**, pulito; `fix/coda-fatture-distanza-signin` non c'è più, né in locale né sul remoto; nessuna PR aperta, nessuna PR di documenti della #164; questo piano sta fuori dal repo, in `/Users/lerri/kidville-lavoro/coda-fatture-aruba/piano-2c/`. (Alle 15:10 l'albero era sulla #164, `2bcb2734`, e il branch della 2c non esisteva) | `git branch -a`, `git status`, `git rev-parse`, `gh pr list` |

La push oggi **non arriva a nessuno dello staff**. `src/app/(dashboard)/admin/layout.tsx` non monta nessuna
registrazione, mentre `parent/layout.tsx:39-42` e `teacher/layout.tsx:40-43` montano `NativePushAutoRegister`;
l'unico pulsante web-push è `PushOptIn` in `StoricoPagamenti.tsx:218`, area genitore. Il meccanismo dei 5 minuti
c'è: `notifiche-dispatch` legge le 500 pendenti più vecchie **senza filtro di tipo né di ruolo**
(`src/app/api/push/dispatch/route.ts:145-151`) e apre `link` (`:223`). Senza i compiti PUSH e DISPATCH (§4.6,
§4.7) la metà «push» della decisione 21 resterebbe falsa col gate verde. Ma iscrivere una persona le porta **tutte**
le sue notifiche, per quel `select` senza filtro: per lo staff vuol dire le 3.267 della tabella, nomi compresi, sulla
schermata di blocco. Per questo DISPATCH esiste (T13).

### 0.1 Le prove fatte su questo piano (24/09, in scratchpad: nessun file del repo toccato)

Prima stesura (fino alle 09:54):
- **Tipi.** Copie dei file di codice di §4 controllate con `tsc` e la `tsconfig.json` del repo contro i moduli veri
  (1151 file): 0 errori; un errore messo apposta in `avvisi-testi.ts` viene visto.
- **SQL.** PGlite 0.5.8 con nucleo, 2a e 2b veri prima: scenari A–I e i cinque controlli negativi di §4.2,
  seconda esecuzione senza errori, firma e privilegi. I riconoscitori **veri** di `soglia-fotografia.ts`
  (importati, non copiati) danno `false` su tutte e tre le guardie.
- **Contratto SQL → testi.** L'uscita vera della funzione, passata a `zFattiCoda` e a `componiAvvisi` di §4.3, dà
  gli avvisi del passo 3 di §4.2; la seconda chiamata ne dà zero; pausa e sospensione vanno anche agli admin, mai
  a chi ha sospeso.
- **Vitest su copie.** Verdi i 7 casi INVIO di §4.4 e i due file delle route della coda (35 test, compresi i casi
  nuovi di §4.5). Ogni gruppo, rotto di proposito, diventa rosso e torna verde (§6.3).

Giro 1 del critico (10:25–10:55), sui file **come sono ora** in §4:
- **SQL** con le fini prima degli errori (§4.2): scenari A–I, controlli negativi, seconda esecuzione, firma e
  privilegi come sopra; riconoscitori veri tutti `false`, `MIGRAZIONI_ATTESE_AL_MERGE` `{}`. Il contratto SQL →
  testi rifatto con la funzione e i testi nuovi: stessi avvisi, seconda e terza chiamata a zero.
- **Testi** (§4.3) eseguiti: `quando(…, 'dopo le')` → «dopo le 23:45», «domani dopo le 00:30», «mar 22/09 dopo le
  10:00», `null` su `'boh'`; la pausa vera del 24/09 (`pausa_fino_a` 09:09:59Z, adesso 08:09:59Z) → «… ripartono
  da sole dopo le 11:09.»; tutte le altre frasi di §3.1 come prima.
- **Tipi.** `tsc` sulle copie di `avvisi-testi.ts`, `avvisi.ts`, la route del dispatch, le due route della coda,
  `PushOptIn` e la pagina: 0 errori; un errore messo apposta nel dispatch viene visto (`TS2322`).
- **INVIO** col `warn`: 7 verdi; con la versione `info` di prima il caso 1 diventa rosso.
- **DISPATCH** (§4.7) su copie: `push-dispatch` 18 (13 di oggi più i 5 nuovi), `cron-battito` 29, `cron-secret` 8,
  contro la route modificata: **55 verdi**. Sei rotture (§6.3), ciascuna rossa; copia rimessa, `shasum` uguale.
- **Lock `isolamento-sede-coverage`** sulla route del dispatch, con la sua `scoperte()` vera (importata con `jiti`,
  `describe` finti): la route di oggi `[]`; col ruolo nella stessa lettura (`utenti(role, ruolo)`) `[]`; con una
  `.from('utenti')` separata `handler-senza-scope`, e `elenco-senza-sede` se la chiave è `[...subsByUser.keys()]`.

Riallineo alla #164 (15:10–15:45), con l'albero a `2bcb2734` (lo stesso di `52d8e7a7`, il `main` di adesso); nessun file del repo
toccato:
- **SQL.** `node` con PGlite 0.5.8 del repo: nucleo, 2a, 2b e **la correzione del 24/09** veri, poi il blocco di
  §4.2 estratto dal piano (`cmp` uguale al file del giro 1). Gli scenari scritti come al giro 1 cadono in **A, B e
  G**: la seconda presa trova `prendi` chiusa per i 65 s (timbrati dalla presa e dal rilascio) e restituisce `[]`.
  Con `dimenticaAccesso()` fra una presa e l'altra, il helper della correzione, A–I, i cinque controlli negativi,
  la seconda esecuzione nell'ordine nucleo → 2a → 2b → 24/09 → 2c (dopo la quale `prendi` rifiuta ancora entro
  65 s), firma e privilegi sono tutti come attesi. La funzione della 2c non dipende dalla correzione: caricata
  senza, dà gli stessi fatti. Colonne di `fatture_coda_stato`: 9 → 10 → 12; di `fatture_coda`: 23 → 23 → 25.
- **Vitest su una copia** del test su PGlite com'è nella #164 (71 verdi), col passo 1 di §4.2 applicato per
  stringa: **88 verdi** (71 più i 17 della 2c: guardie, A–I con E in due casi, il contratto, i cinque controlli
  negativi). Tre rotture dello SQL, ciascuna rossa: il segno dell'errore (A, H, il contratto), `bool_and` (A, G),
  gli errori prima delle fini (guardie); copia rimessa, `shasum` uguale.
- **Riconoscitori veri** (`soglia-fotografia.ts` con `jiti`): tutti `false`; `MIGRAZIONI_ATTESE_AL_MERGE` `{}`;
  nessun `interval '… seconds'` nello SQL della 2c (il lock G6 della correzione legge solo il suo file).
- **Contratto SQL → testi** con la correzione sotto: gli stessi tre avvisi, la seconda e la terza chiamata a
  zero, pausa e sospensione agli stessi destinatari.
- **Tipi.** `tsc` sulle copie di §4 (`avvisi-testi.ts`, `avvisi.ts`, il dispatch, le due route, `PushOptIn`, la
  pagina) contro l'albero della #164: 0 errori.

---

## 1. Perimetro

### 1.1 Le decisioni del titolare, e dove finiscono

| Decisione | Cosa chiede | Come la soddisfa la 2c | Compito |
|---|---|---|---|
| 21 — fine del gruppo | a chi ha accodato | `fattura_coda_fine` quando un gruppo non ha più voci `in_coda`/`in_invio`, anche per il gruppo di una voce sola | SQL, TESTI, INVIO, ROTTE |
| 21 — errori | a chi ha accodato | `fattura_coda_errori`; dentro l'avviso di fine se il gruppo finisce nella stessa chiamata | SQL, TESTI, INVIO, ROTTE |
| 21 — scarti | a chi ha accodato | scarto **SdI**: `fattura_scartata` allo staff della sede, **com'è**: chi ha accodato ci sta sempre (S4) e lo riceve già (21 su 21, §0); la push glielo porta (DISPATCH). Scarto **Aruba** nel merito: è l'errore `scarto_aruba` della coda (`giro.ts:253-257`) | DISPATCH / come «errori» |
| 21 — «Da verificare» | a chi ha accodato **e** a ogni admin | categoria (T9) nell'avviso di chi ha accodato, più `fattura_coda_da_verificare` agli admin delle sedi reali | SQL, TESTI, INVIO |
| 21 — anomalie | agli admin | `partita_non_registrata` (T9) in `fattura_coda_da_verificare` | TESTI |
| 21 — pausa per 429 | a chi ha accodato | `fattura_coda_pausa` a chi ha voci `in_coda`/`in_invio` **e agli admin**, una volta per pausa | SQL, TESTI, INVIO, ROTTE |
| 21 — campanella immediata, push entro 5' | | `bufferMin: 0` e nessun `scuolaId`; la riga nasce alla fine del giro che ha visto il fatto (o subito, per la sospensione); campanella al polling di 60 s (`AdminNotificationsPanel.tsx:107`), push al `notifiche-dispatch` successivo a chi dello staff ha iscritto il dispositivo dal pulsante della «Coda fatture» (T13) | INVIO, PUSH, DISPATCH |
| 21 — mai nomi | | testi solo da conteggi, categorie e orari; la RPC non restituisce il messaggio d'esito; lo scarto SdI porta solo il numero e l'etichetta dello stato (`sync/route.ts:901`); allo staff la push porta **solo** questi tipi, mai le altre notifiche dello staff coi nomi (T13) | SQL, TESTI, DISPATCH |
| 12 — solo l'admin sospende | | **già nel nucleo**: `requireStaff(request, ['admin'])` (`sospensione/route.ts:23`), provato da `fattura-coda-sospensione.test.ts:41-52` | nessuno |
| 12 — sospensione e ripresa notificate | | `fattura_coda_sospesa` / `fattura_coda_ripresa` agli admin e a chi ha voci in attesa, **meno chi ha premuto** | SQL, TESTI, ROTTE |
| 6 — tutta la segreteria vede tutta la coda | | ogni avviso porta a `/admin/coda-fatture`, che vedono admin, coordinator e segreteria (`admin-nav-config.ts:62`, `:130`); nei testi solo conteggi e orari, nessun dato di una voce (6b: degli altri si vede solo il tipo) | TESTI |

### 1.2 Fuori, e perché

- **Outbox e consegna «almeno una volta»** (`contratto.md` §7.5, §14): una tabella nuova accende `toccaLaRls` e
  `toccaUnUnico` (`__tests__/architecture/soglia-fotografia.ts:192-195`, `:267-276`) e vuole la PR-B delle
  fotografie. Qui la consegna è «al più una volta», dichiarata (T5).
- **Il catalogo delle notifiche obbligatorie** (R2A-1.8, `scomposizione.md:1171`): S2.
- **Anomalie di sistema** agli admin (tetto non misurato, `rilascia`/`chiudi` fallite, credenziali; dalla #164
  anche l'ultimo accesso non letto): nel nucleo vivono solo nei log (`giro.ts:365`, `:384-388`, `:439-452`,
  `:600`; `accesso-non-letto` a `:311` e `:315`) e in `/api/health`, non nello stato della coda. Domanda in §7.2.
- **Sospensione «sistema»** (default D4, `…marshmallow.md:94`): il nucleo rifiuta un attore nullo
  (`20260923102831_fatture_coda_nucleo.sql:652`).
- **Link con parametri, numero di fattura nei testi della coda, causa per codice**: la pagina non legge parametri
  (`coda-fatture/page.tsx:16-29`), una voce del nucleo non ha numero, e il motivo si legge aprendo la coda.
- **La route delle azioni**: una «Togli» che chiude un gruppo si avvisa al tick dopo (T6).
- **Lo scarto SdI a chi ha emesso senza interruttore, e la serie nel numero** (la S4 della prima stesura, tolta al
  giro 1): oggi non cambierebbero chi riceve niente (21 su 21, interruttore spento in 0 sedi su 4, §0) e
  toccavano la route della sync e `destinatari.ts`. Domanda 3 di §7.2. Resta fuori anche il testo «che avevi messo
  in coda» (un join fra `fatture_emesse` e `fatture_coda`). La #164 insegna alla sync la dicitura «Inviata» (→ 3,
  in attesa, `src/lib/aruba/stato.ts`), ma `fattura_scartata` parte da `isScarto` (2, 4 e 9,
  `sync/route.ts:145-159`, `:870`), e per lo scarto non cambia niente.
- **La push di tutti i tipi allo staff, e l'iscrizione automatica nell'area admin** (`NativePushAutoRegister` nel
  layout): la prima porterebbe sul telefono le notifiche dello staff coi nomi, la seconda iscriverebbe anche la
  cuoca (T13). Domanda 6 di §7.2.
- **La correzione delle sveglie ravvicinate** (rilievo (g) di HANDOFF, §0): l'ha fatta la #164, non la 2c.
  `fatture_coda_prendi` non consegna voci entro 65 s dall'ultimo accesso della coda ad Aruba, e il giro aspetta il
  residuo invece di rinunciare (§0, riga della #164). La 2c non tocca `giro.ts` né le due funzioni che la #164
  ridefinisce (`prendi` e `rilascia`), e non legge `ultimo_accesso_il`. Resta suo avvisare la conseguenza dei 429
  che la #164 non toglie, la pausa (§7.1 punto 4).
- **Traduzione dei testi**: le notifiche salvate sono in italiano per tutti (`src/lib/notifiche/tipi.ts:7-11`).
- **La prova con due connessioni vere** del lucchetto: PGlite ha una connessione sola
  (`fatture-coda-nucleo.test.ts:20-28`).

### 1.3 Le decisioni della sessione principale sulle domande dei lettori

Valgono fino alla risposta del titolare (§7.2).

| # | Domanda | Decisione | Perché |
|---|---|---|---|
| S1 | Push allo staff | **inclusa, solo per la coda** (compiti PUSH e DISPATCH, T13; rivista al giro 1) | 0 dello staff su 14, cuoca compresa, hanno una `push_subscription` (§0): senza iscrizione «la push arriva entro 5 minuti» della decisione 21 è falsa. Ma il dispatch spedisce ogni riga pendente senza guardare tipo né ruolo (`dispatch/route.ts:145-151`): iscrivere una persona le porta **tutte** le sue notifiche. Misurate il 24/09: 3.267 allo staff in 30 giorni su 7 destinatari, circa 15 al giorno a testa, e 1.236 di tipi il cui corpo interpola un nome (§0). Accenderle tutte, e alla cuoca, non l'ha deciso nessuno: la scelta reversibile è che allo staff la push porti **solo** i sei tipi della coda e `fattura_scartata`, e il resto resti nella campanella com'è oggi. Allargarla è la domanda 6 di §7.2 (togliere un filtro); restringerla dopo, a nomi già comparsi sui telefoni, non si potrebbe |
| S2 | I sei tipi: nel catalogo come «obbligatoria», o fuori | **fuori dal catalogo**, accodati senza `scuolaId` (T7) | La preferenza era «obbligatoria, e dirlo nel pannello Impostazioni come per gli altri obbligatori, se il meccanismo esiste». Non esiste: `TipoNotifica` ha solo `label`, `gruppo`, `descrizione` e `sicurezza` (`tipi.ts:16-24`); il pannello dà un interruttore a ogni voce (`NotificheSettings.tsx:52-63`) e salva la mappa intera (`:44-46`); nessun tipo oggi è obbligatorio. Costruirlo è R2A-1.8 del piano completo (`scomposizione.md:1171`: tre file di codice, due cataloghi, due test). Fuori dal catalogo nessun interruttore mente, perché senza sede il gate non si applica (`config.ts:36`) |
| S3 | Destinatari | fine ed errori → `creato_da`; «da verificare» (`esito_incerto`, `trasporto_da_verificare`) e anomalie (`partita_non_registrata`) → `creato_da` più ogni admin delle sedi reali; pausa per 429 → chi ha voci in coda più gli admin; sospensione e ripresa → gli admin più chi ha voci in coda, **meno chi ha premuto**; dopo «Rimetti» sempre `creato_da`; la fine anche per il gruppo di una voce sola | La pausa e la sospensione fermano le fatture di tutte le sedi (utenza Aruba unica, decisione 6), e solo l'admin può riprendere (decisione 12). «Rimetti» non cambia `creato_da` (nucleo `:617-628`). Il pulsante «Fattura» accoda in background: l'avviso dice che la fattura è partita |
| S4 | Scarti SdI | `fattura_scartata` resta **com'è** (staff della sede, con l'interruttore); allo staff iscritto la porta anche la push (DISPATCH). Rivista al giro 1: via l'invio senza interruttore a chi ha emesso e la serie nel numero | La decisione 21 («scarti» a chi ha accodato) è già soddisfatta. Chi accoda passa `assertPagamentoInScope` (`src/lib/auth/scope.ts:782-808`): la sede del pagamento sta fra le sue (`scuoleDiUtente`, `:53-78`, la primaria, e per l'admin anche il ponte), e `staffScuola` (`src/lib/notifiche/destinatari.ts:204-282`) prende primaria **e** ponte: chi ha accodato è sempre fra i destinatari. Misurato: 21 fatture scartate su 21 hanno avvisato chi le aveva emesse; interruttore spento in 0 sedi su 4 (§0). Il resto tocca la route della sync e `destinatari.ts` per un effetto che oggi è zero: domanda 3 di §7.2 |
| S5 | Idempotenza | segno atomico nello **stato**: colonne più una RPC che prende e segna, purché non accenda le guardie delle fotografie; consegna **al più una volta**, con la perdita registrata (T1–T5) | Verificato col codice dei lock (§5) e coi riconoscitori veri (§0.1) |

### 1.4 Decisioni tecniche di questo piano

| # | Decisione | Perché |
|---|---|---|
| T1 | I fatti si ricavano dallo **stato**, in SQL, e si segnano come avvisati **nella stessa transazione** (`fatture_coda_avvisi_prendi`), non dentro il giro | Il bidello restituisce solo un intero (`giro.ts:363-374`, nucleo `:518-543`): le voci che chiude non le conosce nessuno. Un gruppo finisce anche con una «Togli» (nucleo `:571-582`), fuori dal giro. Due giri (cron e sveglia) passano dal bidello insieme, prima del testimone (`giro.ts:363` contro `:398`; dalla #164 anche dopo la stessa attesa, `:346-358`, se partono insieme). Una scansione segnata atomicamente vede i tre casi, e «due giri non avvisano due volte» si prova su PGlite con lo SQL vero |
| T2 | Il segno sta in **quattro colonne** (`ADD COLUMN`), non in una tabella | Nessuna delle tre guardie si accende (`toccaLaRls`, `toccaUnUnico`, `toccaLeFkUtenti` su `senzaCommenti`, `soglia-fotografia.ts:192-211`, `:267-276`, `:304-359`): `MIGRAZIONI_ATTESE_AL_MERGE` resta `{}` (`:162`) e non serve la PR-B. Provato coi riconoscitori veri sullo SQL di §4.2 (§0.1) |
| T3 | Il segno è il **valore del fatto**, non un orario: la `presa_il` del tentativo avvisato (errori e fine), la `pausa_fino_a` della pausa avvisata, la `sospesa_il` della sospensione avvisata | Ogni errore ed emessa nascono da una presa (`prendi` scrive `presa_il`: dalla #164 la definizione in vigore è `20260924103451_fatture_coda_distanza_accessi.sql:102`, nel nucleo era `:359`; `chiudi` e il bidello non la toccano, 2b `:73-91`, nucleo `:529-540`); «Rimetti» la azzera (nucleo `:624`): un tentativo nuovo è un fatto nuovo. Un `now()` sarebbe l'inizio della transazione e, dopo un'attesa sul lucchetto, più vecchio della chiusura che segna; e una scrittura di manutenzione su `aggiornato_il` (come il blocco DO della 2b, `:116-124`) riavviserebbe tutto |
| T4 | **Linea di partenza** nella migrazione: i fatti già accaduti si segnano come avvisati quando la colonna nasce, e solo allora | Senza, il primo giro dopo il deploy spedirebbe ogni errore e ogni gruppo finito della storia. Un gruppo ancora in corso resta da avvisare. Rieseguita, la migrazione non segna niente, e un fatto nuovo non perde l'avviso |
| T5 | Consegna **al più una volta**, dichiarata | La RPC segna, poi il TS spedisce: se l'inserimento in `notifiche` fallisce l'avviso è perso, e lo registra `enqueueNotifiche` (`error` `insert-fallito`, `src/lib/push/enqueue.ts:96-101`). «Esattamente una volta» vorrebbe l'outbox (T2) o i testi composti in SQL |
| T6 | Chiamano gli avvisi **la route del giro**, dopo il battito, in ogni esito tranne l'eccezione, entro 280 s dall'inizio; e **la route della sospensione**, dopo la RPC riuscita. Non `giro.ts`, non la route delle azioni | Il motore resta com'è. Oltre 280 s (`LIMITE_AVVISI_MS`, 20 s prima del muro dei 300 di `giro/route.ts:30`) gli avvisi si rinviano: i fatti restano **non segnati** e li prende il giro dopo. Una «Togli» che chiude un gruppo si avvisa al tick successivo (al più 10 minuti: i tick saltano :02 e :32). Riverificato dopo la #164: la finestra della sync del giro è ora `:59–:05` e `:29–:35` (`giro.ts:221`), ma i minuti del cron non cambiano (`7,12,…,57`, `api.ts:35`, `cron.job`) e nessuno cade nella finestra; l'attesa della distanza (al più 66 s) di un tick delle :57 o delle :27 finisce entro il minuto 58 o 28, fuori; e sta dentro gli stessi 300 s (`giro.ts:346-358`), quindi i 280 s restano il limite giusto |
| T7 | Sei tipi `fattura_coda_*` **fuori** da `TIPI_NOTIFICA`, accodati **senza `scuolaId`**: non si spengono | S2. Senza sede nessun interruttore (`src/lib/notifiche/config.ts:36`); la campanella non usa il catalogo (nessun `TIPI_NOTIFICA` in `AdminNotificationsPanel.tsx` né in `NotificationsPanel.tsx`), e il dispatch nemmeno. Un test tiene i tipi fuori. È diverso da D5 §10.2, e §1.5 lo dice |
| T8 | **Una** `enqueueNotifiche` **per destinatario**, `bufferMin: 0` | `creato_da` non ha FK (nucleo `:96-97`): un accodante cancellato farebbe fallire sulla FK di `notifiche` l'INSERT **intera** di una chiamata (`enqueue.ts:86`), e con più destinatari li perderebbe tutti. `bufferMin: 0` è il «subito» della decisione 21 |
| T9 | Tre **categorie** del codice d'esito: «da verificare» = `esito_incerto`, `trasporto_da_verificare`; «anomalia» = `partita_non_registrata`; ogni altro codice = «da correggere» | Il nucleo non ha lo stato `da_verificare` (CHECK a nucleo `:108-109`): un esito incerto è `errore/esito_incerto` (`giro.ts:260-265`, bidello nucleo `:532`), il 409 «Trasporto fallito» è `trasporto_da_verificare` (`giro.ts:274`), il 409 di R1 è `partita_non_registrata` (`:129`). Nessun codice nuovo: il lock `coda-fatture-esiti-i18n` resta com'è |
| T10 | Destinatari come S3. Gli admin sono quelli delle **sedi reali** (`sediReali` + `staffScuola(sede, ['admin'])`); un admin che ha accodato riceve ogni fatto **una volta**: le sue voci non contano nel suo `fattura_coda_da_verificare`, e pausa, sospensione e ripresa vanno all'unione senza doppioni | Decisioni 12 e 21; `contratto.md:450-456` e `:664` («un admin che ha anche accodato riceve una notifica»). `staffScuola` è l'unica lettura ammessa dal lock `destinatari-con-ponte` (`:52-59`); misurati 2 admin reali e 0 di collaudo sulle sedi reali (§0) |
| T11 | Testi **in italiano**, da conteggi, categorie e orari Europe/Rome (`quandoRelativo`, `src/lib/i18n/quando-relativo.ts:55-68`); nessun numero di fattura, nessuna causa per codice, nessun uuid | Decisione 21, «mai nomi»: nessuna stringa del database entra in un testo della coda, solo numeri e istanti formattati. Le frasi sono quelle di §3.1 |
| T12 | — (tolta al giro 1: lo scarto SdI resta com'è, S4) | Il numero resta libero perché T13–T15 sono citate altrove |
| T13 | Push allo staff: `PushOptIn` nella pagina «Coda fatture» con testi propri, **sul web e nell'app** (in una shell nativa `supported` è vero da subito e «attiva» chiama `registerNativePush`, `PushOptIn.tsx:24`, `:43-47`); nel dispatch, a chi ha un ruolo di staff (admin, coordinator, segreteria, cuoca) **solo** `TIPI_AVVISO_CODA` e `fattura_scartata`; le altre sue notifiche si marcano come per chi non ha dispositivi (la regola di `dispatch/route.ts:257-285`) e si contano (`escluse_staff`). Il ruolo arriva **nella stessa lettura**, come relazione incorporata `utenti(role, ruolo)` (unica FK fra le due tabelle, §0) | S1. Niente `NativePushAutoRegister` nel layout admin: iscriverebbe anche la cuoca (`admin/layout.tsx:28` → `requireArea('admin')`; `active-role.ts:25`, `:49`) e chiederebbe il permesso di sistema a chiunque apra l'area admin nell'app; il pulsante basta, ed è nella pagina da cui la segreteria segue la coda, non in Impostazioni → Notifiche (il pannello degli interruttori per sede: questi avvisi non ne hanno). Il ruolo nella stessa lettura e non in una `.from('utenti')` a parte: una query sola, nessun ramo d'errore nuovo (una seconda lettura fallita fermerebbe con un 500 anche la push dei genitori, `dispatch/route.ts:175-180`); legge solo il ruolo del destinatario di ciascuna riga già scelta, nessun dato di sede. Il lock `isolamento-sede-coverage` guarda le `.from()`, non le relazioni incorporate: §5 lo dice, con le due varianti misurate. Oggi nessuno dello staff è anche genitore (0 su 14, §0), quindi il filtro per ruolo non toglie la push a nessun genitore |
| T14 | Il **puro** separato dall'**I/O**: `avvisi-testi.ts` (schema zod dei fatti, categorie, testi) e `avvisi.ts` (RPC, admin, invio, log) | Il test su PGlite passa l'uscita **vera** della funzione allo schema e ai testi **veri** (contratto SQL → testi) senza finti; i testi si provano senza I/O |
| T15 | Il **primo commit del branch della 2c** (DOC passo A) scrive la #164 in produzione e corregge le frasi false su 2a e 2b che la #164 non ha toccato (§4.1), coi fatti già misurati | Prima della #164 era: la 2b in produzione nel primo commit, per avere un giro di CI in meno di una PR di soli documenti. La 2b l'ha scritta la #164 (verificato a `52d8e7a7`, §9); la #164 no, e la PR di documenti che il suo piano prevedeva (§5.1, punto 5) non c'è: il branch della 2c è già aperto, e per AGENTS.md, punto 1, si continua su quello. Stessa ragione di prima, un giro di CI in meno; nessun segnaposto, perché i fatti della #164 sono già misurati (§0) |

### 1.5 Il design delle notifiche riallineato al nucleo

`nucleo.md:3-5` prevale su contratto e design per il nucleo. Per le notifiche il riallineamento è questo; lo
scrive DOC passo B in `nucleo.md` §6, con un rimando in testa a `contratto.md` §14 e a `d5` §10 (§4.8).

| Design (dove) | Nel nucleo | Nella 2c |
|---|---|---|
| Outbox `fatture_coda_avvisi`, `avvisi_prendi/conferma`, `chiave_dedup`, 10 tentativi (`contratto.md:397`, `:658-667`; `d5:398-419`) | non esiste | quattro colonne-segno e `fatture_coda_avvisi_prendi` (T1–T5) |
| Stato `da_verificare`, codici P/R/M, `verifica_manuale` (`contratto.md:452-453`) | `errore` con `esito_incerto` o `trasporto_da_verificare` | categoria «da verificare» (T9) |
| Sei `TipoAnomalia` (`contratto.md:461-470`) | solo il 409 `partita_non_registrata` | categoria «anomalia»; il resto ai log e a `/api/health` |
| `gruppo_concluso` dal trigger su `fatture_coda_gruppi` (`contratto.md:450`) | `fatture_coda.gruppo_id` (nucleo `:77`) | gruppo senza voci `in_coda`/`in_invio`, calcolato dalla RPC |
| Errori aggregati per gruppo; la fine «attaccata» all'avviso in attesa (S45, `contratto.md:660`) | — | errori dei gruppi aperti aggregati per accodante a ogni chiamata; quelli di un gruppo che finisce nella stessa chiamata stanno dentro l'avviso di fine |
| `pausa_429` da `aruba_cancello_esito`, a chi ha voci in coda (`contratto.md:455`) | `rilascia` con motivo `aruba-429` (`giro.ts:279-283`, `:562-563`) | la RPC legge `pausa_motivo` e `pausa_fino_a`; a chi ha voci in coda **e agli admin** (S3) |
| `sospesa`/`ripresa` dall'SQL, anche «sistema», a chi ha voci in attesa meno l'attore (`contratto.md:456`) | `fatture_coda_sospendi`, attore obbligatorio (nucleo `:642-670`) | confronto di `sospesa_il` col segno; niente «sistema»; **anche agli admin**, meno chi ha premuto (S3) |
| `scarto_sdi` dall'outbox e `fattura_scartata` meno l'accodante (S46, `contratto.md:676`) | `fattura_scartata` a tutto lo staff della sede, con l'interruttore; chi ha accodato ci sta sempre | invariato (S4); allo staff iscritto anche in push (T13) |
| Nove tipi a catalogo `obbligatoria`, 18 etichette (`d5:421-425`, `contratto.md:672`) | catalogo senza obbligatori | sei tipi fuori catalogo, senza `scuolaId` (T7, S2) |
| `linkCoda({scheda, voce, gruppo})` (`d5:471-481`) | la pagina non legge parametri | link unico `/admin/coda-fatture` |
| `{doc}` e `testoAvviso` con la causa per codice (`d5:427-459`) | la voce non ha numero | conteggi, categorie e orari (T11) |
| `leggiAdminReali` con `isUtenteCollaudo` (`d5:407-411`) | — | `sediReali` + `staffScuola(['admin'])` (T10) |
| Chiamanti: il lavoratore nel `finally`, la sync, la route `sospensione` (`contratto.md:670`) | il lavoratore non si tocca | la route del giro dopo il battito, la route della sospensione (T6); la sync resta com'è (S4) |
| — (la push allo staff non era trattata) | nessuna registrazione nell'area admin; il dispatch spedisce ogni tipo a chiunque sia iscritto | il pulsante della «Coda fatture» e, nel dispatch, allo staff solo la coda e gli scarti (T13) |

---

## 2. Compiti, onde e proprietà dei file

### 2.1 I sette compiti

| Sigla | Onda | Cosa fa |
|---|---|---|
| **DOC** | 0 e 3 | Passo A (onda 0, primo commit del branch): la #164 in produzione e le frasi false su 2a e 2b che la #164 non ha toccato (§4.1), e questo piano copiato nel repo. Passo B (onda 3): la voce della 2c e il riallineamento del design |
| **SQL** | 1 | La migrazione (colonne, linea di partenza, funzione) e le prove su PGlite, compreso il contratto SQL → testi |
| **TESTI** | 1 | `avvisi-testi.ts`: tipi, categorie, schema dei fatti, testi e destinatari (puro) |
| **PUSH** | 1 | Il pulsante della push nella pagina «Coda fatture»: la pagina, una prop di `PushOptIn`, due chiavi it/en |
| **DISPATCH** | 2 | Allo staff la push porta solo i tipi della coda e lo scarto SdI: la route `push/dispatch` e il suo test |
| **INVIO** | 2 | `avvisi.ts`: la RPC, gli admin reali, l'invio per destinatario, i log |
| **ROTTE** | 2 | Gli avvisi nella route del giro e in quella della sospensione; il testo di una voce e di un commento del lock `isolamento-sede-coverage` |

### 2.2 Ordine

0. **Onda 0 — DOC passo A.** Primo commit del branch, già aperto da `main` (`52d8e7a7`, §6.5 punto 1): le modifiche
   di §4.1, scritte per intero (nessun segnaposto, nessuna rimisura), e questo piano copiato in
   `docs/superpowers/specs/2026-09-22-coda-fatture-aruba/consegna-2c-notifiche.md`.
1. **Onda 1, insieme: SQL, TESTI, PUSH.** Nessuno tocca un file di un altro. Una sola attesa, in un verso: il
   **passo 3 di SQL** (il caso «contratto») parte dopo il **passo 2 di TESTI**:
   `grep -c "export function componiAvvisi" src/lib/fatture-coda/avvisi-testi.ts` → `1`.
2. **Onda 2: INVIO e DISPATCH insieme, poi ROTTE.** INVIO e DISPATCH partono quando TESTI ha finito (DISPATCH
   importa `TIPI_AVVISO_CODA`: `grep -c "export const TIPI_AVVISO_CODA" src/lib/fatture-coda/avvisi-testi.ts` →
   `1`). ROTTE parte dopo il **passo 2 di INVIO**:
   `grep -c "export async function spedisciAvvisiCoda" src/lib/fatture-coda/avvisi.ts` → `1` (i test delle
   route sostituiscono il modulo con `vi.mock`, ma `tsc` e la risoluzione del percorso vogliono il file).
3. **Onda 3: DOC passo B**, col diff reale e il nome vero della migrazione.
4. Gate (§6.1), critico, rilascio (§6.5).

Nessuna finestra rossa fuori dal proprio compito: il test su PGlite è rosso solo dentro SQL, fra il passo 1 e il 2,
e `push-dispatch` solo dentro DISPATCH, fra il passo 1 e il 2 (`cron-battito` e `cron-secret` restano verdi: non
cambiano, e la route cambia solo al passo 2).

### 2.3 Proprietà dei file — ogni file ha UN solo proprietario

| Compito | File | Azione |
|---|---|---|
| DOC | `PRD REGISTRO ELETTRONICO.md` | modifica (passo A e passo B) |
| DOC | `docs/superpowers/specs/2026-09-22-coda-fatture-aruba/HANDOFF.md` | modifica (passo A e passo B) |
| DOC | `docs/superpowers/specs/2026-09-22-coda-fatture-aruba/nucleo.md` | modifica (passo B) |
| DOC | `docs/superpowers/specs/2026-09-22-coda-fatture-aruba/contratto.md` | modifica (passo B, un blocco) |
| DOC | `docs/superpowers/specs/2026-09-22-coda-fatture-aruba/d5-interfaccia-notifiche.md` | modifica (passo B, un blocco) |
| DOC | `docs/superpowers/specs/2026-09-22-coda-fatture-aruba/scomposizione.md` | modifica (passo B, tre righe) |
| SQL | `supabase/migrations/<T>_fatture_coda_avvisi.sql` | **crea** |
| SQL | `__tests__/db/fatture-coda-nucleo.test.ts` | modifica |
| TESTI | `src/lib/fatture-coda/avvisi-testi.ts` | **crea** |
| TESTI | `__tests__/lib/fatture-coda/avvisi-testi.test.ts` | **crea** |
| PUSH | `src/app/(dashboard)/admin/coda-fatture/page.tsx` | modifica |
| PUSH | `src/components/features/parent/pagamenti/PushOptIn.tsx` | modifica (una prop facoltativa) |
| PUSH | `messages/it/adminContabilita.json` | modifica (+2 chiavi) |
| PUSH | `messages/en/adminContabilita.json` | modifica (+2 chiavi) |
| PUSH | `__tests__/pages/admin-coda-fatture-push.test.tsx` | **crea** |
| DISPATCH | `src/app/api/push/dispatch/route.ts` | modifica |
| DISPATCH | `__tests__/api/push-dispatch.test.ts` | modifica (un `describe` in fondo, un import) |
| DISPATCH | `src/lib/mensa/notify.ts` | modifica (**aggiunto al giro 2 di verifica**: via il `sendPush` diretto di `inviaNotifiche`, l'allerta allergie) |
| DISPATCH | `__tests__/lib/mensa-destinatari-allerta.test.ts` | modifica (**aggiunto al giro 2**: `sendPush` osservabile, un `describe` in fondo, +38 righe) |
| INVIO | `src/lib/fatture-coda/avvisi.ts` | **crea** |
| INVIO | `__tests__/lib/fatture-coda/avvisi.test.ts` | **crea** |
| ROTTE | `src/app/api/pagamenti/fattura/coda/giro/route.ts` | modifica |
| ROTTE | `src/app/api/pagamenti/fattura/coda/sospensione/route.ts` | modifica |
| ROTTE | `__tests__/api/fattura-coda-giro.test.ts` | modifica |
| ROTTE | `__tests__/api/fattura-coda-sospensione.test.ts` | modifica |
| ROTTE | `__tests__/architecture/isolamento-sede-coverage.test.ts` | modifica (solo il testo della voce `coda/sospensione:POST` e del commento su `coda/giro:POST`) |

Totale: **26 file** più questo piano (24 nella stesura, più i due della mensa aggiunti al giro 2 di verifica: vedi
sotto). Nuovi: una migrazione, due moduli, tre file di test.

**I due file della mensa (giro 2).** Il piano non li assegnava a nessuno: li ha toccati il correttore di DISPATCH,
e ne è il proprietario da allora. `inviaNotifiche` (`src/lib/mensa/notify.ts`), usata solo dall'allerta allergie,
dopo l'insert in `notifiche` leggeva le `push_subscriptions` dei destinatari e chiamava `sendPush` su ognuna, senza
guardare il ruolo: segreteria, admin, coordinator e cuoca compresi. Con il pulsante della «Coda fatture» lo staff
può avere un dispositivo web, e titolo e corpo dell'allerta (nome del bambino e allergeni) sarebbero arrivati sulla
sua schermata di blocco scavalcando il filtro di §4.7: la garanzia T13 («allo staff la push porta solo i sei tipi
della coda e `fattura_scartata`») sarebbe stata falsa. Ora la riga nasce pendente e basta; la porta il dispatch,
entro 5 minuti, ai docenti (web e app nativa) e non allo staff. Era anche un doppione: il dispatch rispediva la stessa
riga, rimasta pendente, a chi l'aveva già ricevuta (`dispatch/route.ts` a `HEAD`, `:146-149`: prende ogni riga con
`push_inviata_il` nullo). `notificaSaldoBasso` (ai genitori) conserva il suo `sendPush`:
non è staff e il diff non la tocca. Effetto e domanda: §7.1 punto 20, §7.2 domanda 7.

### 2.4 File che nessuno tocca

- `src/lib/fatture-coda/giro.ts` e `__tests__/lib/fatture-coda/giro.test.ts`: il motore non cambia (la #164 li ha
  appena cambiati per la distanza fra gli accessi: la 2c non ci entra). Il finto `CodaFinta` risponde `PGRST202` a
  ogni RPC sconosciuta (`giro.test.ts:230-231`): una chiamata agli avvisi finita per sbaglio nel giro si vedrebbe.
- In `__tests__/db/fatture-coda-nucleo.test.ts`, che è di SQL, le parti della #164: il helper `dimenticaAccesso`
  e i suoi vicini (`:278-294`), i casi N1–N9 (`:716-843`), i sette test adattati e i quattro controlli negativi
  della correzione (`:1459-1510`). SQL aggiunge accanto; le sole righe esistenti che riscrive sono la testata
  (`:3-12`), il commento della seconda esecuzione (`:414-415`) e l'elenco delle funzioni (`:380-390`), per
  aggiungervi la 2c.
- `src/lib/push/enqueue.ts`, `src/lib/notifiche/{triggers,config,tipi}.ts`, `NotificheSettings.tsx`,
  `messages/*/etichette.json`: nessun tipo a catalogo (T7).
- `…/fattura/coda/route.ts`, `…/coda/azioni/route.ts` (T6); `src/app/api/pagamenti/fattura/sync/route.ts`,
  `src/lib/notifiche/destinatari.ts` e i loro test (S4).
- `src/app/(dashboard)/admin/layout.tsx` e `src/components/providers/NativePushAutoRegister.tsx` (T13): il lock
  `admin-layout-shell` (`:35-38`, `data-kv-shell` una volta) e i due che leggono i layout (`skip-link-nel-catalogo`
  `:79-85`, `guscio-chiaro-dichiara-la-superficie` `:366-370`) restano fuori dal compito.
- `__tests__/api/cron-battito.test.ts` e `cron-secret.test.ts`: importano la route del dispatch e si lanciano
  (§4.7), non si modificano.
- `__tests__/architecture/soglia-fotografia.ts` (`MIGRAZIONI_ATTESE_AL_MERGE` resta `{}`), le fotografie di
  `__tests__/fixtures/`, `docs/superpowers/catch-muti-allowlist.json`, le migrazioni del nucleo, della 2a, della 2b
  e della correzione del 24/09 (`20260924103451_fatture_coda_distanza_accessi.sql`).
- `__tests__/lib/fatture-coda/api.test.ts`: si lancia (il cron `fatture-coda-tick` pianificato una volta,
  `:258-273`), non si modifica.

### 2.5 Regole per chi esegue in parallelo

Valgono quelle di `consegna-2b-rifiniture.md` §2.5: solo i propri file; niente `git` che cambi stato, niente
`npm install`, niente scritture in produzione; il `vitest` mirato del compito controllando **`Test Files N
passed`**; `npx eslint <i propri file> --max-warnings 0`; `npx tsc --noEmit` letto filtrando i propri percorsi;
«rompi il codice» con copia in scratchpad, test rosso, `cp` indietro e `shasum -a 256` uguale; test rossi
**prima** del codice; nei test solo uuid palesemente finti e nessun nome di persona.

---

## 3. Il contratto (lo scrivono TESTI e SQL; gli altri lo usano per nome)

### 3.1 Tipi, destinatari e testi

`w` = `quando(istante, adesso)`: «alle HH:MM» oggi, «domani alle HH:MM», «mar 22/09 alle HH:MM» negli altri giorni
(Europe/Rome, `quandoRelativo` su date civili). Istante illeggibile → «di recente» (accodamento), «fra poco»
(pausa), «poco fa» (sospensione). Misurati eseguendo il modulo di §4.3 il 24/09: adesso `2026-09-24T21:30:00Z` →
`21:45Z` «alle 23:45», `22:30Z` «domani alle 00:30», `2026-09-22T08:00:00Z` «mar 22/09 alle 10:00».
`w'` = `quando(istante, adesso, 'dopo le')`, la stessa cosa con «dopo le»: «dopo le 23:45», «domani dopo le 00:30».
Solo per la pausa: `pausa_fino_a` è la fine della pausa, e le fatture ripartono col primo giro che la segue — un
tick (`MINUTI_TICK_CODA`, `src/lib/fatture-coda/api.ts:35`) o la sveglia di un accodamento — perché `prendi` non dà
niente finché la pausa dura (dalla #164 `20260924103451_fatture_coda_distanza_accessi.sql:69-71`; nel nucleo
`:332-334`). Il 24/09 la prima pausa finiva alle 11:09:59 e il primo tick era alle 11:12, la seconda alle 13:39:33
e il tick alle 13:42 (§0): «alle 11:09» sarebbe stato falso, «dopo le 11:09» è vero. I 65 s della #164 non
spostano niente qui: l'ultimo accesso è quello del giro che ha preso il 429, un'ora prima.

| `tipo` | Quando | A chi | Titolo | Corpo |
|---|---|---|---|---|
| `fattura_coda_fine` | un gruppo di **una** voce, emessa | chi ha accodato | Fattura inviata | La fattura messa in coda `w` è stata inviata. |
| `fattura_coda_fine` | un gruppo di una voce, da correggere | chi ha accodato | Fattura non inviata | La fattura messa in coda `w` non è partita: apri la coda per vedere il motivo, correggi e premi «Rimetti in coda». |
| `fattura_coda_fine` | un gruppo di una voce, da verificare | chi ha accodato | Fattura da verificare | Della fattura messa in coda `w` non si sa se è arrivata ad Aruba: controlla sul pannello Aruba prima di rimetterla in coda. |
| `fattura_coda_fine` | un gruppo di una voce, anomalia | chi ha accodato | Fattura da verificare | La fattura messa in coda `w` risulta partita ma non è a registro: va verificata prima di riprovare. |
| `fattura_coda_fine` | ogni altro gruppo | chi ha accodato | Fatture in coda: finito | Il gruppo messo in coda `w`: `e` inviata/inviate su `v`. + frasi degli errori **senza** sostantivo + «1 tolta dalla coda.» / «`t` tolte dalla coda.» |
| `fattura_coda_errori` | errori nuovi di gruppi non finiti, per accodante | chi ha accodato | «Fattura non inviata» / «`n` fatture non inviate»; se nessuno è da correggere «Fattura da verificare» / «`n` fatture da verificare» | frasi degli errori **con** sostantivo + «Le altre fatture in coda continuano da sole.» |
| `fattura_coda_da_verificare` | errori nuovi da verificare o anomalie, di voci che l'admin non ha accodato | ogni admin delle sedi reali | «Fattura da verificare» / «`n` fatture da verificare» | frasi degli errori con sostantivo (solo quelle due categorie) |
| `fattura_coda_pausa` | pausa per 429 non ancora avvisata | chi ha voci `in_coda`/`in_invio` ∪ admin, senza doppioni | Invio fatture in pausa | Aruba ha chiesto di rallentare: le fatture in coda ripartono da sole `w'`. |
| `fattura_coda_sospesa` | sospensione non ancora avvisata | chi ha voci `in_coda`/`in_invio` ∪ admin, meno chi ha sospeso (`da`) e l'attore della route | Coda fatture sospesa | Un amministratore ha sospeso l’invio `w`: le fatture restano in coda, nello stesso ordine, e ripartono alla ripresa. |
| `fattura_coda_ripresa` | ripresa non ancora avvisata | chi ha voci `in_coda`/`in_invio` ∪ admin, meno l'attore della route | Coda fatture ripresa | L’invio delle fatture è ripreso: partono da sole, nell’ordine della coda. |
| `fattura_scartata` (esistente, **invariato**) | la sync vede la transizione a scarto | staff della sede, **con** `scuolaId` (`sync/route.ts:877-906`); chi ha accodato ci sta sempre (S4) | Fattura scartata dallo SDI | Fattura n. `numero`: `etichetta dello stato`. Verifica i dati e reinvia. (`:901`) — allo staff iscritto arriva anche in push (T13) |

**Frasi degli errori** (`X` = `n` da solo nel riepilogo di un gruppo, «`n` fattura/fatture» altrove):

| Categoria | n = 1 | n > 1 |
|---|---|---|
| da correggere | `X` non è partita: apri la coda per vedere il motivo, correggi e premi «Rimetti in coda». | `X` non sono partite: apri la coda per vedere i motivi, correggi e premi «Rimetti in coda». |
| da verificare | Di `X` non si sa se è arrivata ad Aruba: controlla sul pannello Aruba prima di rimetterla in coda. | Di `X` non si sa se sono arrivate ad Aruba: controlla sul pannello Aruba prima di rimetterle in coda. |
| anomalia | `X` risulta partita ma non è a registro: va verificata prima di riprovare. | `X` risultano partite ma non sono a registro: vanno verificate prima di riprovare. |

Esempio stampato dal modulo (gruppo di 10, adesso come sopra, accodato `2026-09-24T08:05:00Z`): «Il gruppo messo in
coda alle 10:05: 7 inviate su 10. 1 non è partita: apri la coda per vedere il motivo, correggi e premi «Rimetti
in coda». Di 1 non si sa se è arrivata ad Aruba: controlla sul pannello Aruba prima di rimetterla in coda. 1
risulta partita ma non è a registro: va verificata prima di riprovare.»

Link di **ogni** avviso `fattura_coda_*`: `/admin/coda-fatture`; `fattura_scartata` resta su `/admin/pagamenti`.
`entitaTipo`/`entitaId`: `'fattura_coda_gruppo'` e `gruppo_id` per la fine, `null` negli altri; `'fattura'` e
l'id della fattura per lo scarto (com'è). Un avviso senza destinatari non si spedisce.

### 3.2 Nomi e firme che attraversano i compiti

- **SQL**: `public.fatture_coda_avvisi_prendi(p_limite integer DEFAULT 200) RETURNS jsonb`, e la risposta
  `{ errori: [{gruppo_id, creato_da, codice}], fini: [{gruppo_id, creato_da, accodata_il, voci, emesse, tolte,
  errori: {<codice>: n}}], pausa: {fino_a} | null, sospensione: {evento: 'sospesa'|'ripresa', il, da} | null,
  in_attesa: [uuid] }`. Colonne: `fatture_coda.avviso_errore_presa`, `fatture_coda.avviso_fine_presa`,
  `fatture_coda_stato.avviso_pausa_fino_a`, `fatture_coda_stato.avviso_sospesa_il`, tutte `timestamptz`.
- **TESTI** (`src/lib/fatture-coda/avvisi-testi.ts`): `LINK_CODA_FATTURE`, `TIPI_AVVISO_CODA`, `type
  TipoAvvisoCoda`, `CODICI_DA_VERIFICARE`, `CODICI_ANOMALIA`, `type Categoria`, `categoria(codice)`,
  `zFattiCoda`, `type FattiCoda`, `interface AvvisoCoda`, `interface ContestoAvvisi { adesso; admin; attore? }`,
  `quando(istante, adesso, prima: 'alle' | 'dopo le' = 'alle')`, `componiAvvisi(fatti, contesto): AvvisoCoda[]`.
- **INVIO** (`src/lib/fatture-coda/avvisi.ts`): `OPERAZIONE_AVVISI = 'fatture-coda/avvisi'`, `LIMITE_AVVISI_MS`,
  `ERRORI_PER_CHIAMATA = 200`, `type EsitoAvvisiCodice`, `interface EsitoAvvisi { esito; avvisi; tentate }`,
  `spedisciAvvisiCoda(sb, { operazione, attore?, inizioMs? }): Promise<EsitoAvvisi>` — **non lancia mai**.
- **DISPATCH** (nella route `push/dispatch`, di modulo e privati): `RUOLI_PUSH_SOLO_CODA` (admin, coordinator,
  segreteria, cuoca), `TIPI_PUSH_STAFF` (= `TIPI_AVVISO_CODA` più `fattura_scartata`),
  `destinatarioDelloStaff(n)`; il campo numerico `escluse_staff` nel battito `ok` e nella risposta.
- **PUSH**: `PushOptIn` accetta `etichette?: { attiva: string; attive: string }`; chiavi piatte
  `adminContabilita.codaFatturePushAttiva` e `codaFatturePushAttive` (piatte come T15 della 2b: il finto globale di
  next-intl risolve solo quelle, `test/setup.ts:162-165`).

### 3.3 Log (AGENTS.md, regola 5: anche il successo)

Gli avvisi della coda scrivono tutti `logEvento('fattura', …)` (evento persistito, `src/lib/logging/logger.ts:188-189`),
`operazione: 'fatture-coda/avvisi'`, `azione` = l'`operazione` del chiamante (`fatture-coda-tick`,
`coda-sospensione:sospendi`, `coda-sospensione:riprendi`), solo chiavi in lista bianca o numeri e booleani
(`redact.ts:250-256`, `:583`). **Una riga per chiamata**, sempre:

| `esito` | Livello | Quando |
|---|---|---|
| `avvisi-spediti` | info, `distingui: ['azione']` | c'erano fatti; porta `avvisi`, `tentate`, `admin`, `errori`, `fini`, `pausa`, `sospesa`, `ripresa` (conteggi e booleani) |
| `avvisi-nessuno` | info | nessun fatto nuovo |
| `avvisi-rinviati` | info | oltre `LIMITE_AVVISI_MS`, con `ms` |
| `avvisi-non-disponibili` | **warn** | `codaAssente(error)` (`api.ts:236-242`): DB E2E, o il codice prima della migrazione. `warn` e non `info` (giro 1): in produzione è la migrazione che manca, gli avvisi tacerebbero a ogni tick col battito del giro verde (AGENTS.md, regola 4), e le POST della coda sullo stesso caso scrivono già `warn` `coda-assente` (`sospensione/route.ts:34-35`, `coda/azioni/route.ts:63`, `:115`). Persistito, una riga al giorno |
| `avvisi-non-letti` | error | ogni altro errore della RPC |
| `avvisi-illeggibili` | error | la risposta non passa `zFattiCoda`: i fatti sono **già segnati**, gli avvisi persi |
| `avvisi-eccezione` | error | qualunque eccezione |

In più: `warn` `admin-non-risolti` (sedi non lette, o nessun admin), `error` `avviso-non-accodato` (eccezione di
un invio, con `tipo`). Mai il messaggio d'esito, mai un nome: nei fatti non c'è.

DISPATCH non aggiunge righe: il battito `info` `ok` di `push-dispatch` (evento `cron`, persistito) e la risposta
portano un numero in più, `escluse_staff` (le notifiche dello staff che la push non ha portato per scelta: senza,
«non spedita apposta» e «nessun dispositivo» si leggerebbero uguali). Una lettura fallita resta la `query-fallita`
di sempre: il ruolo arriva nella stessa lettura delle notifiche. La sync non cambia (S4).

---

## 4. I compiti

### 4.1 DOC, passo A — la #164 in produzione, e le frasi che non ha toccato (onda 0, primo commit del branch)

**Riallineato alla #164** (§9). La correzione dei 65 s ha scritto in PRD e HANDOFF quasi tutto ciò che questo passo
doveva scrivere sulla 2b; letti i due file a `52d8e7a7` (lo squash della #164, stesso albero di `2bcb2734`):
- HANDOFF: l'intestazione (`:3`, «Stato aggiornato al **24/09/2026 13:15**»); la riga «Consegna 2b» (`:14`: #163,
  merge e deploy, `md5` di `fatture_coda_chiudi` uguale al file, D14 fatta, coi 13 ripresi e inviati alle 06:43) e
  la riga nuova «Correzione del 24/09» (`:15`); il paragrafo «Le prime fatture vere, il 24/09» (`:17`), al posto di
  «Misurato al 24/09 alle 03:18» con le sue «0 voci»; l'introduzione di §3 (`:41`: «(a) lo chiude la consegna 2b
  (PR #163, in produzione dal 24/09 alle 06:39…)», e il settimo rilievo); il rilievo (g) (`:49`), **già chiuso**
  dalla correzione.
- PRD: la riga Contabilità (`:78`, «✅ **Consegna 2b** ([#163](…), in produzione dal 24/09 alle 06:39…»); il titolo
  della voce della 2b (`:1940`, «✅ IN PRODUZIONE — PR [#163](…), merge 24/09 06:38 (`02eb9836`)»); il suo
  «Verificato il 24/09» (`:2116-2120`); la voce della correzione (`:1791-1936`), coi due 429 e il primo giorno vero
  della coda.

Via, quindi: la rimisura e i due segnaposto; il rilievo (g) e la riga `0.` in cima al «Da fare» (la #164 ha chiuso
(g), e una riga «da correggere prima di tutto» sarebbe falsa); il segno «🔧 consegna 2c» sul punto 1 del «Da fare»,
che DOC passo B riscrive per intero (§4.8).

Restano due cose, tutte coi fatti già misurati (solo `SELECT` e `gh`, 24/09 fra le 15:09 e le 15:44: §0), senza
segnaposto:
- **(a) tre frasi false da prima della #164**, che la #164 non ha toccato: il run `35920312716` in HANDOFF `:13` e
  nel PRD `:2231`, e «data e numero li registra la PR di documenti» nel PRD `:2090`;
- **(b) la #164 in produzione**, che non ha scritto nessuno: il piano della correzione la affidava a una PR di
  documenti (`correzione-distanza-signin.md` §5.1, punto 5), ma alle 15:43 non ce n'è nessuna e il branch della 2c è
  già aperto da `main`; per AGENTS.md, punto 1, si continua su quello, come T15 aveva deciso per la 2b. Da qui
  diventano false anche le due frasi su `35956482220` (HANDOFF `:14`, PRD `:2119`): il run della #164 l'ha annullato.
  Se la sessione principale preferisce una PR a parte, (b) si toglie da qui e (a) non cambia.

Edit su sottostringhe uniche (`grep -c` = 1 ciascuna a `52d8e7a7`), con `grep -c` prima di ognuna: se una dà 0
perché qualcuno l'ha già scritta, si salta, e il messaggio del commit lo dice. Il primo commit porta anche questo
piano, copiato in `docs/superpowers/specs/2026-09-22-coda-fatture-aruba/consegna-2c-notifiche.md` (oggi sta fuori
dal repo, §0).

**HANDOFF.md**
- `:3` (b): «Stato aggiornato al **24/09/2026 13:15** (produzione letta con sole `SELECT` alle 13:14).» → «Stato
  aggiornato al **24/09/2026 15:44** (produzione letta con sole `SELECT` alle 15:44).»
- `:13`, riga «Consegna 2a» (a): «Il run «DB migrate (prod)» `35920312716` resta in attesa: **non si approva**.» →
  «Il run «DB migrate (prod)» `35920312716` non è stato approvato: l'ha annullato il 24/09 alle 06:38:09 il run
  della 2b (`migrate.yml:64-66`, `cancel-in-progress`).» È falsa dalle 06:38:09 (`gh run view 35920312716`:
  `cancelled`, 04:38:09Z), e l'intestazione del file la datava alle 13:15.
- `:14`, riga «Consegna 2b» (b): «Il run «DB migrate (prod)» `35956482220` resta in attesa: **non si approva**.» →
  «Il run «DB migrate (prod)» `35956482220` non è stato approvato: l'ha annullato il 24/09 alle 15:36:12 il run
  della #164 (`migrate.yml:64-66`).»
- `:15`, riga «Correzione del 24/09» (b), in testa: «| **Correzione del 24/09** | — | — | Branch
  `fix/coda-fatture-distanza-signin`.» → «| **Correzione del 24/09** | #164 | 24/09 15:36 (`52d8e7a7`), deploy
  15:37:13 | Branch `fix/coda-fatture-distanza-signin`.»; e in fondo alla stessa riga «Piano:
  `correzione-distanza-signin.md`. Lo stato di produzione lo registra la PR di documenti dopo il deploy |» → «Piano:
  `correzione-distanza-signin.md`. La migrazione l'ha applicata l'integrazione al merge, e l'hanno verificata sole
  letture (24/09, 15:44): `md5` dei corpi di `fatture_coda_prendi` (`2ec5384d4fe689b6a86255e10e348263`) e di
  `fatture_coda_rilascia` (`0037c8fb96ea2e7cef01506e84505f91`) in produzione uguali al file, una riga per funzione,
  definer, `search_path=public, pg_temp`, EXECUTE al solo `service_role`, argomenti invariati; `fatture_coda_stato`
  con 10 colonne; nessun nome doppio. Il run «DB migrate (prod)» `36006773356` resta in attesa: **non si approva**. |»
- `:17` (b), subito prima di «Restano da guardare dal vivo il chip sulle righe e la stima col giorno.»: «**Alle
  15:44** le 4 voci urgenti sono partite col tick delle 13:42 (23 emesse nel giorno, 0 in coda), e la correzione è in
  produzione dalle 15:37 (§1): da allora nessun giro ha preso voci (`ultimo_accesso_il` ancora vuoto), e nessun 429.»
- `:49`, rilievo (g) (b): «(branch `fix/coda-fatture-distanza-signin`, piano `correzione-distanza-signin.md`):» →
  «(PR #164, in produzione dal 24/09 alle 15:37; piano `correzione-distanza-signin.md`):».

**PRD** (`PRD REGISTRO ELETTRONICO.md`)
- `:78`, riga Contabilità (b): «🔧 **Correzione del 24/09** (branch `fix/coda-fatture-distanza-signin`; lo stato di
  produzione lo registra la PR di documenti dopo il deploy)» → «✅ **Correzione del 24/09**
  ([#164](https://github.com/erricoluigi17/kidville-web/pull/164), in produzione dal 24/09 alle 15:37, migrazione
  `20260924103451` applicata dall'integrazione)».
- `:1791`, titolo della voce della correzione (b), nel formato di quello della 2b (`:1940`): «— 2026-09-24 (branch
  `fix/coda-fatture-distanza-signin`; stato di produzione: lo registra la PR di documenti dopo il deploy)» → «—
  2026-09-24 (branch `fix/coda-fatture-distanza-signin`, ✅ IN PRODUZIONE — PR
  [#164](https://github.com/erricoluigi17/kidville-web/pull/164), merge 24/09 15:36 (`52d8e7a7`))».
- in fondo alla stessa voce (b), dopo «e la coda riparte da sola.» (`:1936`) e prima di `---` (`:1938`), sul modello
  del «Verificato» della 2b (`:2116-2120`): «**Verificato il 24/09** (solo `SELECT`, alle 15:44). Deploy
  `6639076586` `success` alle 15:37:13. La migrazione `20260924103451` è presente in `schema_migrations`, applicata
  dall'integrazione al merge; nessun nome doppio. Gli `md5` dei corpi in produzione sono uguali al file:
  `fatture_coda_prendi` `2ec5384d4fe689b6a86255e10e348263` (2557 caratteri), `fatture_coda_rilascia`
  `0037c8fb96ea2e7cef01506e84505f91` (1607); una riga per funzione, definer, `search_path=public, pg_temp`,
  `anon`/`auth` falsi, `sr` vero, argomenti invariati; `ultimo_accesso_il` `timestamp with time zone`, nulla
  ammessa. Il run «DB migrate (prod)» `36006773356` resta in attesa e **non si approva**; ha annullato
  `35956482220`. La pausa delle 12:39:33 era finita prima del deploy: le 4 voci urgenti sono partite col tick delle
  13:42. Dal deploy alle 15:44 nessun giro ha preso voci (`ultimo_accesso_il` vuoto) e nessun 429: la prova vera
  resta la prossima mattina di pulsanti ravvicinati.»
- `:2090`, voce della 2b, il paragrafo di D14 (a): «cancellazione, e data e numero li registra la PR di
  documenti.» → «cancellazione: ripresi **13** il 24/09 alle 06:40:42 e inviati al giro delle 06:43 (vedi
  «Verificato il 24/09» in fondo alla voce).» La PR di documenti della 2b non c'è stata: data e numero li ha scritti
  la #164, 26 righe sotto.
- `:2119`, «Verificato il 24/09» della 2b (b): «(prod)» `35956482220` resta in attesa e **non è stato approvato**.»
  → «(prod)» `35956482220` non è stato approvato: l'ha annullato il 24/09 alle 15:36:12 il run della #164.»
- `:2231`, in fondo al «Verificato il 24/09» della voce della 2a (a): «Il run «DB migrate (prod)» `35920312716` resta
  in attesa e non si approva.» → «Il run «DB migrate (prod)» `35920312716` non è stato approvato: l'ha annullato il
  24/09 alle 06:38:09 il run della 2b (`migrate.yml:64-66`).»

Fuori dal repo, per la sessione principale: la nota di memoria `coda_fatture_aruba_2026_09_22.md` dice ancora che
HANDOFF e PRD sulla 2b «li registra il primo commit della 2c» (li ha registrati la #164) e che la correzione sta sul
suo branch (è in produzione: `52d8e7a7`, deploy 15:37:13). Solo version, numeri di run, `md5`, conteggi e orari: la
regola P3 di `pii-nei-file-tracciati.test.ts:185-215` vale su PRD, HANDOFF e piano. **Log**: nessuno.

### 4.2 SQL — la migrazione e le prove su PGlite

**Il nome.** `supabase/migrations/<T>_fatture_coda_avvisi.sql`, `T=$(date -u +%Y%m%d%H%M%S)` quando si scrive il
file: maggiore di `20260924103451` (la correzione dei 65 s, applicata in produzione al merge della #164 e ultima
alle 15:44, §0) e di ogni `generato_alle` delle fotografie (l'ultima,
`tabelle-scuola-id`, 2026-09-23T13:57:10Z), mai nel futuro, version unica (`migrazioni-complete.test.ts:190-223`,
`:244-271`, `:273-315`); nessun altro file finisce con `_fatture_coda_avvisi.sql` (verificato: 0). Nessuna delle
parole che accendono le guardie — `policy`, `unique`, `primary key`, `row level security`, `drop table`,
`add`/`drop constraint`, `references utenti`, `add column scuola_id`, una riga che comincia con `scuola_id uuid` —
**nemmeno nei commenti dentro `$$`**, che `senzaCommenti` non toglie (`soglia-fotografia.ts:304-359`). Nessun uuid
di sede. Nessun `cron.schedule` (`api.test.ts:258-273`).

**Il testo completo.** Riprovato il 24/09 alle 10:39, dopo il giro 1 (le fini **prima** degli errori), su PGlite
0.5.8 con le tre migrazioni vere prima (nucleo, 2a, 2b): scenari A–I e controlli negativi di questo paragrafo tutti
come attesi, seconda esecuzione senza errori, firma `p_limite integer → jsonb`, definer, `search_path=public,
pg_temp`, `anon` senza EXECUTE e `service_role` con; i riconoscitori veri di `soglia-fotografia.ts` tutti `false`.
**Riprovato al riallineo** (24/09, 15:10–15:35) con le **quattro** migrazioni vere prima — nucleo, 2a, 2b e la
correzione del 24/09 —: stessi esiti, con `dimenticaAccesso()` fra una presa e l'altra (passo 1 qui sotto, §0.1).
Il blocco qui sotto è, byte per byte, il file provato le due volte (`cmp`): la #164 non chiede di cambiarne un
byte. Non gli serve nemmeno il `NOTIFY pgrst` che chiude la migrazione della #164: in produzione la cache di
PostgREST si ricarica da sé a ogni DDL (`pgrst_ddl_watch`, §0).

```sql
-- ═══════════════════════════════════════════════════════════════════════════════
-- CODA FATTURE — GLI AVVISI (consegna 2c: decisioni 12 e 21 del titolare)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Fonte: docs/superpowers/specs/2026-09-22-coda-fatture-aruba/consegna-2c-notifiche.md,
-- compito SQL.
--
-- Chi ha accodato riceve la fine del gruppo, gli errori, i «da verificare» e la pausa
-- per 429; gli admin ogni «da verificare» e le anomalie; sospensione e ripresa vanno a
-- chi ha fatture in attesa. I TESTI li scrive il codice (src/lib/fatture-coda/
-- avvisi-testi.ts): questa funzione dice solo QUALI fatti sono nuovi, li segna come
-- avvisati nella stessa transazione e li restituisce senza un dato personale: uuid,
-- codici d'esito, conteggi, istanti. Mai il messaggio d'esito della voce.
--
-- ─── PERCHÉ DALLO STATO, E NON DAL GIRO ──────────────────────────────────────
-- Il bidello restituisce solo un numero; un gruppo può finire con una «Togli»; due
-- giri (cron e sveglia) passano dal bidello insieme. Una scansione dello stato,
-- segnata in modo atomico, vede i tre casi senza toccare il motore.
--
-- ─── IL SEGNO È IL VALORE DEL FATTO, NON UN ORARIO ──────────────────────────
--   · avviso_errore_presa, avviso_fine_presa: la `presa_il` del tentativo avvisato.
--     Ogni errore e ogni emessa nascono da una presa, e «Rimetti» la azzera: un nuovo
--     tentativo è un fatto nuovo e si riavvisa; una scrittura che cambia solo
--     `aggiornato_il` no.
--   · avviso_pausa_fino_a: la `pausa_fino_a` avvisata (una volta per pausa).
--   · avviso_sospesa_il: la `sospesa_il` avvisata; torna NULL quando si avvisa la ripresa.
--
-- ─── AL PIÙ UNA VOLTA ────────────────────────────────────────────────────────
-- Segnare e spedire non stanno nella stessa transazione: se dopo questa funzione
-- l'inserimento in `notifiche` fallisce, l'avviso è perso, e lo registra
-- `enqueueNotifiche` a livello error. È voluto: mai due volte lo stesso avviso.
--
-- Nessuna tabella, nessun indice, nessun vincolo: quattro colonne, la linea di
-- partenza e una funzione. La applica l'integrazione Supabase al merge, con la
-- version di questo file. MAI a mano.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ── Le colonne, e la linea di partenza ──────────────────────────────────────
-- I fatti già accaduti quando la colonna nasce si segnano come avvisati: il primo
-- giro dopo il deploy non spedisce notizie vecchie. Un gruppo ancora in corso resta
-- da avvisare, e lo sarà quando finisce. Ogni ramo agisce SOLO se aggiunge davvero
-- la colonna: rieseguito non segna niente, e un fatto nuovo non perde il suo avviso.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'fatture_coda'
       AND column_name = 'avviso_errore_presa'
  ) THEN
    ALTER TABLE public.fatture_coda ADD COLUMN avviso_errore_presa timestamptz;
    UPDATE public.fatture_coda SET avviso_errore_presa = presa_il WHERE stato = 'errore';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'fatture_coda'
       AND column_name = 'avviso_fine_presa'
  ) THEN
    ALTER TABLE public.fatture_coda ADD COLUMN avviso_fine_presa timestamptz;
    UPDATE public.fatture_coda v
       SET avviso_fine_presa = v.presa_il
     WHERE v.stato IN ('emessa', 'errore')
       AND NOT EXISTS (
         SELECT 1 FROM public.fatture_coda a
          WHERE a.gruppo_id = v.gruppo_id AND a.stato IN ('in_coda', 'in_invio'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'fatture_coda_stato'
       AND column_name = 'avviso_pausa_fino_a'
  ) THEN
    ALTER TABLE public.fatture_coda_stato ADD COLUMN avviso_pausa_fino_a timestamptz;
    UPDATE public.fatture_coda_stato SET avviso_pausa_fino_a = pausa_fino_a WHERE id = 1;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'fatture_coda_stato'
       AND column_name = 'avviso_sospesa_il'
  ) THEN
    ALTER TABLE public.fatture_coda_stato ADD COLUMN avviso_sospesa_il timestamptz;
    UPDATE public.fatture_coda_stato SET avviso_sospesa_il = sospesa_il WHERE id = 1;
  END IF;
END $$;


-- ── fatture_coda_avvisi_prendi ──────────────────────────────────────────────
-- I fatti nuovi da avvisare, segnati come avvisati nella stessa transazione:
--   · fini: i gruppi senza più voci in coda o in invio con almeno una chiusura non
--     ancora avvisata come fine, al più 100 per chiamata, coi conteggi per codice;
--   · errori: le voci in errore il cui tentativo non è ancora stato avvisato (dal
--     giro o dal bidello), al più p_limite (1..500) per chiamata;
--   · pausa: la pausa per 429 in corso non ancora avvisata;
--   · sospensione: la sospensione o la ripresa non ancora avvisata;
--   · in_attesa: chi ha voci in coda o in invio (solo se c'è pausa o sospensione).
CREATE OR REPLACE FUNCTION public.fatture_coda_avvisi_prendi(p_limite integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limite    integer := least(greatest(COALESCE(p_limite, 200), 1), 500);
  v_errori    jsonb;
  v_fini      jsonb;
  v_stato     public.fatture_coda_stato%ROWTYPE;
  v_pausa     jsonb;
  v_sosp      jsonb;
  v_in_attesa jsonb := '[]'::jsonb;
BEGIN
  -- Un lucchetto suo, non quello del lavoratore: due chiamate insieme si mettono in
  -- fila, e la seconda trova già segnato ciò che la prima ha preso.
  PERFORM pg_advisory_xact_lock(hashtext('fatture_coda_avvisi'));

  -- 1. I gruppi finiti: nessuna voce in coda o in invio, e almeno una chiusura
  --    (emessa o errore) non ancora avvisata come fine. Un gruppo di sole tolte non
  --    esce, e una «Togli» dopo la fine non lo riapre.
  --    PRIMA degli errori, di proposito: ogni istruzione di questa funzione vede la
  --    propria fotografia, e un altro giro può chiudere una voce fra l'una e l'altra.
  --    In quest'ordine l'errore dell'ultima voce di un gruppo, chiuso proprio lì in
  --    mezzo, esce adesso come errore e la fine arriva alla chiamata dopo: la stessa
  --    sequenza di quando l'errore precede di un giro la fine. Nell'ordine opposto la
  --    fine lo conterebbe già, e la chiamata dopo lo riannuncerebbe come errore.
  WITH finiti AS (
    SELECT c.gruppo_id
      FROM public.fatture_coda c
     GROUP BY c.gruppo_id
    HAVING bool_and(c.stato NOT IN ('in_coda', 'in_invio'))
       AND bool_or(c.stato IN ('emessa', 'errore') AND c.avviso_fine_presa IS DISTINCT FROM c.presa_il)
     ORDER BY min(c.accodata_il), c.gruppo_id
     LIMIT 100
  ),
  segnati AS (
    UPDATE public.fatture_coda c
       SET avviso_fine_presa = c.presa_il
      FROM finiti f
     WHERE c.gruppo_id = f.gruppo_id
       AND c.stato IN ('emessa', 'errore')
    RETURNING c.gruppo_id
  ),
  per_codice AS (
    SELECT c.gruppo_id, COALESCE(c.esito_codice, 'errore') AS codice, count(*)::integer AS n
      FROM public.fatture_coda c
      JOIN finiti f ON f.gruppo_id = c.gruppo_id
     WHERE c.stato = 'errore'
     GROUP BY c.gruppo_id, COALESCE(c.esito_codice, 'errore')
  ),
  conti AS (
    SELECT c.gruppo_id,
           (array_agg(c.creato_da ORDER BY c.accodata_il, c.id))[1] AS creato_da,
           min(c.accodata_il) AS accodata_il,
           count(*)::integer AS voci,
           (count(*) FILTER (WHERE c.stato = 'emessa'))::integer AS emesse,
           (count(*) FILTER (WHERE c.stato = 'tolta'))::integer AS tolte
      FROM public.fatture_coda c
      JOIN finiti f ON f.gruppo_id = c.gruppo_id
     GROUP BY c.gruppo_id
  )
  SELECT COALESCE(
           jsonb_agg(jsonb_build_object(
             'gruppo_id',   k.gruppo_id,
             'creato_da',   k.creato_da,
             'accodata_il', k.accodata_il,
             'voci',        k.voci,
             'emesse',      k.emesse,
             'tolte',       k.tolte,
             'errori',      COALESCE(
                              (SELECT jsonb_object_agg(p.codice, p.n)
                                 FROM per_codice p
                                WHERE p.gruppo_id = k.gruppo_id),
                              '{}'::jsonb)
           ) ORDER BY k.accodata_il, k.gruppo_id),
           '[]'::jsonb)
    INTO v_fini
    FROM conti k;

  -- 2. Gli errori il cui tentativo non è ancora stato avvisato (giro o bidello). Lo
  --    stato si ripete nella UPDATE: una «Rimetti» arrivata nel frattempo la esclude.
  WITH nuovi AS (
    SELECT c.id
      FROM public.fatture_coda c
     WHERE c.stato = 'errore'
       AND c.avviso_errore_presa IS DISTINCT FROM c.presa_il
     ORDER BY c.aggiornato_il, c.id
     LIMIT v_limite
  ),
  segnati AS (
    UPDATE public.fatture_coda c
       SET avviso_errore_presa = c.presa_il
      FROM nuovi n
     WHERE c.id = n.id
       AND c.stato = 'errore'
       AND c.avviso_errore_presa IS DISTINCT FROM c.presa_il
    RETURNING c.gruppo_id, c.creato_da, c.esito_codice
  )
  SELECT COALESCE(
           jsonb_agg(jsonb_build_object(
             'gruppo_id', s.gruppo_id,
             'creato_da', s.creato_da,
             'codice',    COALESCE(s.esito_codice, 'errore')
           ) ORDER BY s.gruppo_id, s.creato_da),
           '[]'::jsonb)
    INTO v_errori
    FROM segnati s;

  -- 3. Pausa per 429 e sospensione: la riga unica, letta e segnata insieme.
  SELECT * INTO v_stato FROM public.fatture_coda_stato WHERE id = 1 FOR UPDATE;
  IF FOUND THEN
    IF v_stato.pausa_motivo = 'aruba-429'
       AND v_stato.pausa_fino_a > now()
       AND v_stato.avviso_pausa_fino_a IS DISTINCT FROM v_stato.pausa_fino_a THEN
      v_pausa := jsonb_build_object('fino_a', v_stato.pausa_fino_a);
    END IF;

    IF v_stato.sospesa AND v_stato.avviso_sospesa_il IS DISTINCT FROM v_stato.sospesa_il THEN
      v_sosp := jsonb_build_object('evento', 'sospesa', 'il', v_stato.sospesa_il, 'da', v_stato.sospesa_da);
    ELSIF NOT v_stato.sospesa AND v_stato.avviso_sospesa_il IS NOT NULL THEN
      v_sosp := jsonb_build_object('evento', 'ripresa', 'il', NULL::timestamptz, 'da', NULL::uuid);
    END IF;

    IF v_pausa IS NOT NULL OR v_sosp IS NOT NULL THEN
      UPDATE public.fatture_coda_stato
         SET avviso_pausa_fino_a = CASE WHEN v_pausa IS NULL THEN avviso_pausa_fino_a ELSE pausa_fino_a END,
             avviso_sospesa_il   = CASE WHEN v_sosp IS NULL THEN avviso_sospesa_il
                                        WHEN sospesa THEN sospesa_il
                                        ELSE NULL END
       WHERE id = 1;

      -- A chi scrivere: chi ha fatture in coda o in invio.
      SELECT COALESCE(jsonb_agg(a.creato_da ORDER BY a.creato_da), '[]'::jsonb)
        INTO v_in_attesa
        FROM (SELECT DISTINCT c.creato_da
                FROM public.fatture_coda c
               WHERE c.stato IN ('in_coda', 'in_invio')) a;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'errori',      v_errori,
    'fini',        v_fini,
    'pausa',       v_pausa,
    'sospensione', v_sosp,
    'in_attesa',   v_in_attesa
  );
END $$;


-- ── Proprietà e privilegi ───────────────────────────────────────────────────
-- Come le altre RPC della coda (nucleo, righe 763-791): di `postgres`, REVOKE per nome
-- da PUBLIC, anon e authenticated, EXECUTE al solo service role.
ALTER FUNCTION public.fatture_coda_avvisi_prendi(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fatture_coda_avvisi_prendi(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fatture_coda_avvisi_prendi(integer) TO service_role;

COMMENT ON FUNCTION public.fatture_coda_avvisi_prendi(integer) IS
  'Consegna 2c della coda fatture: i fatti nuovi da avvisare (errori, gruppi finiti, pausa per 429, sospensione e ripresa), segnati come avvisati nella stessa transazione. Solo uuid, codici, conteggi e istanti. La chiamano le route del giro e della sospensione tramite src/lib/fatture-coda/avvisi.ts.';
```

Nota per chi rilegge: il DO della linea di partenza scrive `SET avviso_errore_presa = presa_il` (senza alias) e
`SET avviso_fine_presa = v.presa_il` (alias `v`), la funzione `… = c.presa_il`: stringhe diverse di proposito, così
i controlli negativi del passo 1 colpiscono l'una o l'altra. Il `WHERE` della UPDATE degli errori ripete stato e
segno: su una riga cambiata da un'altra transazione Postgres rivaluta il `WHERE` sulla versione nuova, e una voce
appena rimessa in coda non esce come errore con codice vuoto. **Le fini prima degli errori** (giro 1): la funzione
è `VOLATILE` (il default: non dichiara `STABLE`), e in READ COMMITTED ogni sua istruzione prende una fotografia nuova;
un attore concorrente può chiudere in errore l'ultima voce aperta di un gruppo fra le due istruzioni. Prima della
#164 bastava un secondo giro: il 24/09 ha preso il lavoratore 0,3 s dopo il primo, proprio quando la route del primo
chiamerebbe gli avvisi. Dopo, un giro che prende voci sta a 65 s dal rilascio del precedente (`giro.ts:346-358`), e
restano la route della sospensione, che chiama gli avvisi mentre un giro chiude le sue voci, e il bidello di un giro
che parte mentre li chiama la route di un giro senza voci (dopo un giro con voci anche il bidello aspetta i 65 s,
perché l'attesa viene prima). Con gli errori prima, la fine l'avrebbe già contata
e la chiamata dopo l'avrebbe riannunciata come `fattura_coda_errori` («… continuano da sole») **dopo** il «finito»;
con le fini prima, quell'errore esce adesso come errore e la fine alla chiamata dopo, cioè la sequenza di sempre
quando un errore precede la fine di un giro. Senza concorrenza l'ordine non cambia niente: gli scenari A–I danno
le stesse risposte nei due ordini. La funzione dice **chi ha voci in attesa**: gli admin
li aggiunge il TS (§4.3), perché la lettura che le guardie accettano è `staffScuola`. `prendi` restituisce `SETOF
fatture_coda` (dalla #164 la definizione in vigore è `20260924103451_fatture_coda_distanza_accessi.sql:44`,
`:120-124`; nel nucleo `:307`, `:370-374`): le colonne nuove escono anche lì, e il giro legge solo i campi di
`VoceCoda` (`giro.ts:153-161`); le GET della coda elencano le colonne (`coda/route.ts:171`, `:181`). La funzione
non legge `ultimo_accesso_il` e non tocca `prendi` né `rilascia`: caricata senza la #164 dà gli stessi fatti (§0.1).

**Passi (rosso prima), in `__tests__/db/fatture-coda-nucleo.test.ts`** (righe di `52d8e7a7`: il file l'ha appena
cambiato la #164, e ora carica anche la sua migrazione)
1. **Rosso.**
   - Accanto alle costanti della correzione (`:54-57`): `SUFFISSO_AVVISI = '_fatture_coda_avvisi.sql'`,
     `TROVATI_AVVISI`, `NOME_AVVISI`, `AVVISI`, stesso schema; nel `beforeEach` (`:310-317`), dopo `DISTANZA_ACCESSI`
     (`:316`): `if (AVVISI) await db.exec(AVVISI)`; nella seconda esecuzione (`:413-418`) si riesegue anche `AVVISI`,
     dopo `DISTANZA_ACCESSI`, e il commento `:414-415` dice «nucleo → 2a → 2b → 24/09 → 2c»; la testata (`:3-12`)
     cita la quinta migrazione.
   - «Forma dello schema» (`:380-390`): fra `fatture_coda_accoda` e `fatture_coda_bidello` la riga
     `['fatture_coda_avvisi_prendi', 'p_limite integer', 'jsonb']` (l'ordine è `ORDER BY p.proname`); il ciclo `:391-398`
     controlla già definer, `search_path`, `service_role` sì, `anon`/`authenticated`/PUBLIC no.
   - Helper `avvisiPresi(limite = 200)` = `SELECT public.fatture_coda_avvisi_prendi($1::int) AS r` → `rows[0].r`,
     accanto a `secondiDallAccesso` (`:288-294`).
   - ⚠️ **Fra una presa e l'altra, `dimenticaAccesso()`** (`:278-281`), come fanno i test della correzione (per
     esempio `:625`, `:1089`): dalla #164 `prendi` non consegna voci entro 65 s dall'ultimo accesso, che timbrano
     sia `prendi` quando consegna sia `rilascia` per un token che aveva voci. Senza, la seconda presa di A, B e G
     restituisce `[]` e il caso cade con un `TypeError` su `undefined` che non dice perché (misurato, §0.1). Una
     presa sola (C, D, E, H, I, il contratto) non ne ha bisogno.
   - Nuovo `describe('fatture_coda_avvisi_prendi — consegna 2c')`, con questi casi (uuid e testi finti del file):
     - **guardie**: un solo file, version > `NOME_ACCESSI.slice(0, 14)` (la migrazione della correzione) e non nel
       futuro (come N8, `:822-828`); `toccaLaRls`, `toccaUnUnico`, `toccaLeFkUtenti` falsi (come N9, `:830-842`);
       `senzaCommenti(AVVISI)` senza `scuola_id` e senza `esito_messaggio|causale_manuale|intestatario_scelto`;
       contiene la riga del `REVOKE` per nome; contiene `pausa_motivo = 'aruba-429'`, e `giro.ts` contiene
       `motivo: 'aruba-429' }` (il letterale di `pausaDaiSegnali`, `:280`: se diverge la pausa non si avvisa più);
       `AVVISI.indexOf('WITH finiti AS')` minore di `AVVISI.indexOf('WITH nuovi AS')`, tutti e due presenti (le fini
       prima degli errori: la concorrenza non si prova su PGlite, l'ordine sì).
     - **A · «due giri non avvisano due volte»**: due pagamenti in un gruppo; `prendi(TOKEN_A, 1)` (la voce presa ha
       `avviso_errore_presa: null`), `chiudi(errore, 'scarto_aruba', 'Messaggio finto')` → `errori` =
       `[{ gruppo_id, creato_da: SEGRETERIA, codice: 'scarto_aruba' }]`, `fini` `[]` (l'altra è in coda); la seconda
       chiamata è tutta vuota (`{ errori: [], fini: [], pausa: null, sospensione: null, in_attesa: [] }`); poi
       `rilascia`, **`dimenticaAccesso()`**, `prendi(TOKEN_B, 1)`, `chiudi(emessa)` → `errori` `[]`, `fini` una sola,
       `{ voci: 2, emesse: 1, tolte: 0, errori: { scarto_aruba: 1 } }`; la chiamata dopo ancora vuota.
     - **B · «Rimetti, poi di nuovo errore: si riavvisa»**: errore `esito_incerto` avvisato; `rimetti` → nessun fatto;
       `rilascia`, **`dimenticaAccesso()`** (dopo «Rimetti» resta il timbro della presa, N6), nuova presa,
       `chiudi(errore, 'scarto_aruba')` → di nuovo in `errori` e di nuovo in `fini`.
     - **C · tolte**: un gruppo tolto tutto non dà fine; un altro finito (emessa ed errore, una presa da 2) si
       avvisa, poi «Togli» sull'errore → nessun fatto nuovo.
     - **D · bidello**: prestito scaduto a mano (come `:1068-1071`), `bidello()` → `errori`
       `[{ codice: 'esito_incerto' }]` e la fine del gruppo con `{ esito_incerto: 1 }`.
     - **E · pausa**: `chiudi(riprova, 'aruba_429')`, `rilascia(TOKEN_A, 60, 'aruba-429')` → `pausa.fino_a` stringa,
       `in_attesa` `[SEGRETERIA]`; seconda chiamata `pausa: null`. Su un database nuovo `rilascia(TOKEN_A, 15,
       'esito-incerto')` → `pausa: null`.
     - **F · sospensione**: una voce in coda; `sospendi(true)` → `{ evento: 'sospesa', da: ADMIN }` e `in_attesa`
       `[SEGRETERIA]`; `sospendi(true)` di nuovo → `null` (nucleo `:661-663`); `sospendi(false)` →
       `{ evento: 'ripresa', il: null, da: null }`; poi `null`.
     - **G · linea di partenza**: database senza `AVVISI` (`db.close()`, `new PGlite()`, `preparaDatabase()`, nucleo,
       2a, 2b **e la correzione del 24/09**); un errore in un gruppo finito, un gruppo in corso con un'emessa e una in
       coda, una pausa 429, una sospensione; `db.exec(AVVISI)` → tutto vuoto; `sospendi(false)` → `ripresa` (è un
       fatto nuovo); pausa scaduta a mano (`UPDATE … SET pausa_fino_a = now() - interval '1 second'`), si chiude la
       voce in coda → `fini` = il gruppo in corso, `{ voci: 2, emesse: 2 }`; un errore nuovo, poi **di nuovo**
       `db.exec(AVVISI)` → l'errore nuovo esce ancora. **`dimenticaAccesso()` prima di ognuna delle tre prese dopo la
       prima.**
     - **H · limite**: sette errori in un gruppo (una presa da 7); `avvisiPresi(5)` → 5 errori e la fine
       `{ non_saldato: 7 }`; poi 2 errori e nessuna fine.
     - **I · niente dati personali**: voce con `causale_manuale` e `intestatario_scelto`, chiusa con `'Messaggio finto'`
       → `JSON.stringify` della risposta senza `Messaggio finto`, `Causale finta`, `99999999-9999`; chiavi esatte:
       `['codice', 'creato_da', 'gruppo_id']` e `['accodata_il', 'creato_da', 'emesse', 'errori', 'gruppo_id',
       'tolte', 'voci']`.
   - Nel `describe('controlli negativi …')` (`:1354`), dopo i quattro della correzione: ciascuno su un database nuovo
     con nucleo, 2a, 2b e la correzione del 24/09 (`conMigrazione` `:1355-1360`, poi gli `exec`, come `conAccessi`
     `:1461-1468`) e la versione rotta — prima dei dati, o dopo per i due della linea di partenza —, con
     `expect(rotta).not.toBe(AVVISI)` e il caso che **diventa** vero:
     - `AVVISI.replace('SET avviso_errore_presa = c.presa_il', 'SET avviso_errore_presa = NULL')` → la seconda
       chiamata restituisce ancora l'errore;
     - `AVVISI.replace(/HAVING bool_and\(c\.stato NOT IN \('in_coda', 'in_invio'\)\)\s+AND /, 'HAVING ')` → un gruppo con
       una voce in coda esce fra le fini;
     - `AVVISI.replace("v_stato.pausa_motivo = 'aruba-429'", 'v_stato.pausa_motivo IS NOT NULL')` → la pausa da 15
       minuti per esito incerto si avvisa;
     - `AVVISI.replace("UPDATE public.fatture_coda SET avviso_errore_presa = presa_il WHERE stato = 'errore';", '')` →
       l'errore di prima della migrazione esce alla prima chiamata;
     - `AVVISI.replace(/\s+AND NOT EXISTS \(\s*SELECT 1 FROM public\.fatture_coda a[\s\S]*?\)\);/, ';')` → il gruppo in
       corso alla migrazione, finito con una «Togli» sulla voce **in coda**, non si avvisa più (con la migrazione
       giusta esce `{ voci: 2, emesse: 1, tolte: 1 }`). ⚠️ La «Togli» va sulla voce `in_coda`: su una `in_invio` non
       fa niente (nucleo `:579`) e la prova non discriminerebbe.
   Rossi oggi: il file non c'è. I 71 test di oggi restano verdi con `AVVISI` caricata nel `beforeEach`: 88 in tutto
   sulla copia provata (§0.1).
2. **Verde**: il file di sopra, col `T` vero.
3. **Contratto SQL → testi** (dopo il passo 2 di TESTI, §2.2): un caso che importa `zFattiCoda` e `componiAvvisi` da
   `@/lib/fatture-coda/avvisi-testi`. Due voci di SEGRETERIA in un gruppo (una emessa, una `esito_incerto` con
   `'Messaggio finto'`) e una di ADMIN chiusa `partita_non_registrata`: `zFattiCoda.parse(await avvisiPresi())` passa;
   `componiAvvisi(fatti, { adesso: new Date(), admin: [ADMIN] })` dà **tre** avvisi: una `fattura_coda_fine` a
   SEGRETERIA («Fatture in coda: finito», «1 inviata su 2»), una ad ADMIN («Fattura da verificare»), e una
   `fattura_coda_da_verificare` ad ADMIN con **1** (la sua voce non conta); nessun titolo né corpo contiene
   `Messaggio finto` o un uuid. Una seconda `avvisiPresi()` composta allo stesso modo dà **`[]`**: due chiamate non
   avvisano due volte nemmeno a testi composti. Poi `rilascia(…, 60, 'aruba-429')`, una voce di SEGRETERIA in coda e
   `sospendi(true)` da ADMIN: con `admin: [ADMIN, ALTRO_ADMIN]` e `attore: ADMIN` la pausa va a SEGRETERIA, ADMIN e
   ALTRO_ADMIN, la sospensione a SEGRETERIA e ALTRO_ADMIN (misurato al giro 1 e di nuovo al riallineo, con la
   correzione sotto, §0.1). Una presa sola: niente `dimenticaAccesso()`.

**Log**: la migrazione non ne scrive; li scrive INVIO.

**Verifica**: `npx vitest run __tests__/db/fatture-coda-nucleo.test.ts __tests__/architecture/security-definer-revoke-lock.test.ts __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts __tests__/architecture/onconflict-arbitro.test.ts __tests__/architecture/rls-per-sede.test.ts __tests__/architecture/tracce-docente-dichiarate.test.ts __tests__/architecture/fk-scuola-id.test.ts __tests__/architecture/migrazioni-senza-sede-cablata.test.ts __tests__/architecture/pii-nei-file-tracciati.test.ts __tests__/lib/insegnanti-template.test.ts __tests__/lib/fatture-coda/api.test.ts`
→ **`Test Files 12 passed`**. Non si applica a mano: la applica l'integrazione al merge (§6.4).

### 4.3 TESTI — `src/lib/fatture-coda/avvisi-testi.ts`

**Passi**
1. **Rosso**: `__tests__/lib/fatture-coda/avvisi-testi.test.ts` (`// @vitest-environment node`), con adesso
   `2026-09-24T21:30:00Z` e accodamento `2026-09-24T08:05:00Z` («alle 10:05»):
   1. `categoria`: `esito_incerto` e `trasporto_da_verificare` → «da verificare»; `partita_non_registrata` → «anomalia»;
      `scarto_aruba`, `non_saldato`, un codice ignoto → «da correggere»; ogni voce di `CODICI_ESITO_CODA` (importato da
      `giro.ts`) ha una categoria, e `CODICI_DA_VERIFICARE`, `CODICI_ANOMALIA` ne sono sottoinsiemi **a runtime**: con lo
      spread di un `Set` (`giro.ts:149`) il tipo degli elementi è `string`, e il `satisfies` non controlla niente.
   2. `quando`: «alle 23:45», «domani alle 00:30», «mar 22/09 alle 10:00», `null` su `'boh'` (§3.1); con `'dopo le'`
      «dopo le 23:45», «domani dopo le 00:30», «mar 22/09 dopo le 10:00», `null` su `'boh'`.
   3. Fine di un gruppo di una voce: i quattro titoli e corpi di §3.1, **esatti**.
   4. Fine di un gruppo di dieci (`emesse: 7`, `errori: { scarto_aruba: 1, esito_incerto: 1, partita_non_registrata: 1 }`):
      il corpo esatto di §3.1; di tre con `emesse: 1, tolte: 2`: «Il gruppo messo in coda alle 10:05: 1 inviata su 3.
      2 tolte dalla coda.»; di dodici con `emesse: 5, tolte: 1, errori: { non_saldato: 3, trasporto_da_verificare: 2,
      esito_incerto: 1 }`: «… 5 inviate su 12. 3 non sono partite: … Di 3 non si sa se sono arrivate ad Aruba: … 1 tolta
      dalla coda.».
   5. Errori **ripiegati**: gli errori di un gruppo presente in `fini` non danno `fattura_coda_errori`; due errori dello
      stesso accodante in due gruppi aperti danno **un** avviso con 2 («2 fatture non inviate»).
   6. Titoli di `fattura_coda_errori`: 1 da correggere «Fattura non inviata» e corpo «1 fattura non è partita: … Le altre
      fatture in coda continuano da sole.»; tre fra da verificare e anomalia «3 fatture da verificare»; misti
      «3 fatture non inviate».
   7. Admin: errori di U1 (`esito_incerto`), di ADMIN_A (`partita_non_registrata`) e di U2 (`non_saldato`), admin
      `[ADMIN_A, ADMIN_B, ADMIN_A]` → ADMIN_A **una** `fattura_coda_da_verificare` con 1, ADMIN_B una con 2
      («2 fatture da verificare»); nessun avviso admin se gli errori sono tutti da correggere o se `admin` è vuoto.
   8. Pausa: destinatari `in_attesa` ∪ `admin` **senza doppioni** (`in_attesa [U1, U1, A1]`, admin `[A1, A2]` →
      `[U1, A1, A2]`); corpo «Aruba ha chiesto di rallentare: le fatture in coda ripartono da sole domani dopo le
      00:30.» (**dopo le**, non «alle»: giro 1, §3.1); `in_attesa` e `admin` vuoti → nessun avviso; `in_attesa` vuoto
      e un admin → l'avviso al solo admin.
   9. Sospensione: `sospesa` va a `in_attesa` ∪ `admin` meno `da` **e** meno `attore` (`in_attesa [U1, A1]`, admin
      `[A1, A2]`, `da` e `attore` A1 → `[U1, A2]`), corpo con «alle 21:10» per `il` `19:10Z`; `ripresa` meno il solo
      `attore` (`in_attesa [U1]`, admin `[A1, A2]`, attore A2 → `[U1, A1]`); nessuno rimasto → nessun avviso.
   10. **Sonda anti-PII**: codici `'SENTINELLA-PII'` e istanti illeggibili → nessun titolo né corpo contiene
       `SENTINELLA`, un uuid (`/[0-9a-f]{8}-[0-9a-f]{4}-/i`), `undefined`, `NaN` o `null`.
   11. Ogni `tipo` è in `TIPI_AVVISO_CODA`; **nessuno** è una chiave di `TIPI_NOTIFICA` (`@/lib/notifiche/tipi`: T7);
       `LINK_CODA_FATTURE === CODA_FATTURE_HREF` (`@/components/features/admin/admin-nav-config`, `:168`).
   12. `zFattiCoda`: accetta un campione; rifiuta un conteggio negativo, un `evento` ignoto, `in_attesa` assente.
2. **Verde**: il file qui sotto (quello eseguito il 24/09, §0.1).

```ts
import { z } from 'zod'
import { zUuid } from '@/lib/validation/common'
import { quandoRelativo } from '@/lib/i18n/quando-relativo'
import type { CODICI_ESITO_CODA } from '@/lib/fatture-coda/giro'

/**
 * ─── GLI AVVISI DELLA CODA FATTURE: COSA DICONO E A CHI (consegna 2c) ──────────────
 *
 * Puro, senza I/O. Riceve i fatti che `fatture_coda_avvisi_prendi` ha appena segnato come
 * avvisati e compone le notifiche (spec: consegna-2c-notifiche.md §3). MAI UN NOME
 * (decisione 21): ogni testo nasce da conteggi, dalla categoria di un codice d'esito e da
 * orari Europe/Rome; nessuna stringa del database entra in una frase. Il messaggio d'esito
 * della voce, che può nominare un intestatario, qui non arriva: la RPC non lo restituisce.
 * In italiano, come tutte le notifiche salvate (`src/lib/notifiche/tipi.ts:7-11`).
 */

type CodiceEsitoCoda = (typeof CODICI_ESITO_CODA)[number]

/** Dove porta ogni avviso. È `CODA_FATTURE_HREF` (`admin-nav-config.ts`): un test li lega. */
export const LINK_CODA_FATTURE = '/admin/coda-fatture'

/**
 * I valori di `notifiche.tipo`. FUORI da `TIPI_NOTIFICA`, di proposito: il catalogo non sa dire
 * «obbligatoria» (ogni sua voce è un interruttore del pannello), e questi avvisi si accodano
 * senza sede, quindi nessun interruttore li spegnerebbe davvero.
 */
export const TIPI_AVVISO_CODA = [
  'fattura_coda_fine',
  'fattura_coda_errori',
  'fattura_coda_da_verificare',
  'fattura_coda_pausa',
  'fattura_coda_sospesa',
  'fattura_coda_ripresa',
] as const
export type TipoAvvisoCoda = (typeof TIPI_AVVISO_CODA)[number]

/** «Da verificare» nel nucleo: non si sa se la fattura è arrivata ad Aruba (`giro.ts`, `classificaEsito` e bidello). */
export const CODICI_DA_VERIFICARE = ['esito_incerto', 'trasporto_da_verificare'] as const satisfies readonly CodiceEsitoCoda[]
/** L'anomalia del nucleo: partita su Aruba e assente dal registro (il 409 di R1). */
export const CODICI_ANOMALIA = ['partita_non_registrata'] as const satisfies readonly CodiceEsitoCoda[]

export type Categoria = 'da_correggere' | 'da_verificare' | 'anomalia'

export function categoria(codice: string): Categoria {
  if ((CODICI_DA_VERIFICARE as readonly string[]).includes(codice)) return 'da_verificare'
  if ((CODICI_ANOMALIA as readonly string[]).includes(codice)) return 'anomalia'
  return 'da_correggere'
}

const zConteggio = z.number().int().min(0)

/** La risposta di `fatture_coda_avvisi_prendi`: solo uuid, codici, conteggi e istanti. */
export const zFattiCoda = z.object({
  errori: z.array(z.object({ gruppo_id: zUuid, creato_da: zUuid, codice: z.string().min(1).max(100) })),
  fini: z.array(
    z.object({
      gruppo_id: zUuid,
      creato_da: zUuid,
      accodata_il: z.string(),
      voci: zConteggio,
      emesse: zConteggio,
      tolte: zConteggio,
      errori: z.record(z.string(), zConteggio),
    }),
  ),
  pausa: z.object({ fino_a: z.string() }).nullable(),
  sospensione: z
    .object({ evento: z.enum(['sospesa', 'ripresa']), il: z.string().nullable(), da: zUuid.nullable() })
    .nullable(),
  in_attesa: z.array(zUuid),
})
export type FattiCoda = z.infer<typeof zFattiCoda>
type GruppoFinito = FattiCoda['fini'][number]

export interface AvvisoCoda {
  tipo: TipoAvvisoCoda
  destinatari: string[]
  titolo: string
  corpo: string
  entitaTipo: 'fattura_coda_gruppo' | null
  entitaId: string | null
}

export interface ContestoAvvisi {
  adesso: Date
  /**
   * Gli admin delle sedi reali. Ricevono i «da verificare» e le anomalie delle voci altrui, la
   * pausa, la sospensione e la ripresa (decisioni 12 e 21). Vuoto se non si sono potuti leggere.
   */
  admin: readonly string[]
  /** Chi ha appena sospeso o ripreso dalla route: non riceve l'avviso del proprio gesto. */
  attore?: string | null
}

interface Conteggi {
  daCorreggere: number
  daVerificare: number
  anomalie: number
}

const zero = (): Conteggi => ({ daCorreggere: 0, daVerificare: 0, anomalie: 0 })

function aggiungi(c: Conteggi, codice: string, n = 1): void {
  const k = categoria(codice)
  if (k === 'da_verificare') c.daVerificare += n
  else if (k === 'anomalia') c.anomalie += n
  else c.daCorreggere += n
}

/**
 * «alle 14:30», «domani alle 00:03», «ven 25/09 alle 08:00» (Europe/Rome); con `'dopo le'`
 * «dopo le 11:09», «domani dopo le 00:30». Istante illeggibile → `null`.
 */
export function quando(
  istante: string | null | undefined,
  adesso: Date,
  prima: 'alle' | 'dopo le' = 'alle',
): string | null {
  const q = quandoRelativo(istante, adesso, 'it')
  if (!q) return null
  if (q.giorno === 'oggi') return `${prima} ${q.ora}`
  if (q.giorno === 'domani') return `domani ${prima} ${q.ora}`
  return `${q.data} ${prima} ${q.ora}`
}

/** Le frasi degli errori: col sostantivo («1 fattura») o senza («1», dentro il riepilogo di un gruppo). */
function frasiErrori(c: Conteggi, conNome: boolean): string[] {
  const chi = (n: number) => (conNome ? `${n} ${n === 1 ? 'fattura' : 'fatture'}` : `${n}`)
  const frasi: string[] = []
  if (c.daCorreggere > 0) {
    const n = c.daCorreggere
    frasi.push(
      n === 1
        ? `${chi(n)} non è partita: apri la coda per vedere il motivo, correggi e premi «Rimetti in coda».`
        : `${chi(n)} non sono partite: apri la coda per vedere i motivi, correggi e premi «Rimetti in coda».`,
    )
  }
  if (c.daVerificare > 0) {
    const n = c.daVerificare
    frasi.push(
      n === 1
        ? `Di ${chi(n)} non si sa se è arrivata ad Aruba: controlla sul pannello Aruba prima di rimetterla in coda.`
        : `Di ${chi(n)} non si sa se sono arrivate ad Aruba: controlla sul pannello Aruba prima di rimetterle in coda.`,
    )
  }
  if (c.anomalie > 0) {
    const n = c.anomalie
    frasi.push(
      n === 1
        ? `${chi(n)} risulta partita ma non è a registro: va verificata prima di riprovare.`
        : `${chi(n)} risultano partite ma non sono a registro: vanno verificate prima di riprovare.`,
    )
  }
  return frasi
}

function avvisoFine(g: GruppoFinito, adesso: Date): AvvisoCoda {
  const c = zero()
  for (const [codice, n] of Object.entries(g.errori)) aggiungi(c, codice, n)
  const errori = c.daCorreggere + c.daVerificare + c.anomalie
  const w = quando(g.accodata_il, adesso) ?? 'di recente'
  let titolo: string
  let corpo: string
  if (g.voci === 1 && g.emesse === 1) {
    titolo = 'Fattura inviata'
    corpo = `La fattura messa in coda ${w} è stata inviata.`
  } else if (g.voci === 1 && errori === 1 && c.daCorreggere === 1) {
    titolo = 'Fattura non inviata'
    corpo = `La fattura messa in coda ${w} non è partita: apri la coda per vedere il motivo, correggi e premi «Rimetti in coda».`
  } else if (g.voci === 1 && errori === 1 && c.daVerificare === 1) {
    titolo = 'Fattura da verificare'
    corpo = `Della fattura messa in coda ${w} non si sa se è arrivata ad Aruba: controlla sul pannello Aruba prima di rimetterla in coda.`
  } else if (g.voci === 1 && errori === 1) {
    titolo = 'Fattura da verificare'
    corpo = `La fattura messa in coda ${w} risulta partita ma non è a registro: va verificata prima di riprovare.`
  } else {
    titolo = 'Fatture in coda: finito'
    corpo = [
      `Il gruppo messo in coda ${w}: ${g.emesse} ${g.emesse === 1 ? 'inviata' : 'inviate'} su ${g.voci}.`,
      ...frasiErrori(c, false),
      ...(g.tolte > 0 ? [g.tolte === 1 ? '1 tolta dalla coda.' : `${g.tolte} tolte dalla coda.`] : []),
    ].join(' ')
  }
  return { tipo: 'fattura_coda_fine', destinatari: [g.creato_da], titolo, corpo, entitaTipo: 'fattura_coda_gruppo', entitaId: g.gruppo_id }
}

function avvisoErrori(utente: string, c: Conteggi): AvvisoCoda {
  const n = c.daCorreggere + c.daVerificare + c.anomalie
  const titolo =
    c.daCorreggere === 0
      ? n === 1 ? 'Fattura da verificare' : `${n} fatture da verificare`
      : n === 1 ? 'Fattura non inviata' : `${n} fatture non inviate`
  const corpo = [...frasiErrori(c, true), 'Le altre fatture in coda continuano da sole.'].join(' ')
  return { tipo: 'fattura_coda_errori', destinatari: [utente], titolo, corpo, entitaTipo: null, entitaId: null }
}

function avvisoAdmin(admin: string, c: Conteggi): AvvisoCoda {
  const n = c.daVerificare + c.anomalie
  return {
    tipo: 'fattura_coda_da_verificare',
    destinatari: [admin],
    titolo: n === 1 ? 'Fattura da verificare' : `${n} fatture da verificare`,
    corpo: frasiErrori({ daCorreggere: 0, daVerificare: c.daVerificare, anomalie: c.anomalie }, true).join(' '),
    entitaTipo: null,
    entitaId: null,
  }
}

/** Gli avvisi di una chiamata. Un avviso senza destinatari non esce. */
export function componiAvvisi(fatti: FattiCoda, ctx: ContestoAvvisi): AvvisoCoda[] {
  const avvisi: AvvisoCoda[] = []
  const finiti = new Set(fatti.fini.map((g) => g.gruppo_id))

  for (const g of fatti.fini) avvisi.push(avvisoFine(g, ctx.adesso))

  // Gli errori di un gruppo finito in questa chiamata stanno già nel suo avviso di fine.
  const perAccodante = new Map<string, Conteggi>()
  for (const e of fatti.errori) {
    if (finiti.has(e.gruppo_id)) continue
    const c = perAccodante.get(e.creato_da) ?? zero()
    aggiungi(c, e.codice)
    perAccodante.set(e.creato_da, c)
  }
  for (const [utente, c] of perAccodante) avvisi.push(avvisoErrori(utente, c))

  // Agli admin ogni «da verificare» e ogni anomalia, UNA volta: le voci che hanno accodato
  // loro le hanno già nel proprio avviso.
  const admin = [...new Set(ctx.admin)]
  for (const a of admin) {
    const c = zero()
    for (const e of fatti.errori) {
      if (e.creato_da !== a && categoria(e.codice) !== 'da_correggere') aggiungi(c, e.codice)
    }
    if (c.daVerificare + c.anomalie > 0) avvisi.push(avvisoAdmin(a, c))
  }

  // Pausa, sospensione e ripresa fermano o fanno ripartire le fatture di TUTTE le sedi: a chi
  // ha fatture in attesa e agli admin (decisioni 12 e 21), ciascuno una volta sola.
  const inAttesaEAdmin = [...new Set([...fatti.in_attesa, ...admin])]
  if (fatti.pausa) {
    avvisi.push({
      tipo: 'fattura_coda_pausa',
      destinatari: inAttesaEAdmin,
      titolo: 'Invio fatture in pausa',
      // «dopo le», non «alle»: `pausa_fino_a` è la fine della pausa, e le fatture ripartono
      // col primo giro che la segue (un tick del cron, o la sveglia di un accodamento).
      corpo: `Aruba ha chiesto di rallentare: le fatture in coda ripartono da sole ${quando(fatti.pausa.fino_a, ctx.adesso, 'dopo le') ?? 'fra poco'}.`,
      entitaTipo: null,
      entitaId: null,
    })
  }
  if (fatti.sospensione) {
    const s = fatti.sospensione
    // Chi ha premuto non riceve l'avviso del proprio gesto: `da` per la sospensione (lo scrive
    // la riga di stato), l'attore della route per entrambe.
    const esclusi = new Set([s.da, ctx.attore].filter((x): x is string => typeof x === 'string'))
    const destinatari = inAttesaEAdmin.filter((u) => !esclusi.has(u))
    avvisi.push(
      s.evento === 'sospesa'
        ? {
            tipo: 'fattura_coda_sospesa',
            destinatari,
            titolo: 'Coda fatture sospesa',
            corpo: `Un amministratore ha sospeso l’invio ${quando(s.il, ctx.adesso) ?? 'poco fa'}: le fatture restano in coda, nello stesso ordine, e ripartono alla ripresa.`,
            entitaTipo: null,
            entitaId: null,
          }
        : {
            tipo: 'fattura_coda_ripresa',
            destinatari,
            titolo: 'Coda fatture ripresa',
            corpo: 'L’invio delle fatture è ripreso: partono da sole, nell’ordine della coda.',
            entitaTipo: null,
            entitaId: null,
          },
    )
  }
  return avvisi.filter((a) => a.destinatari.length > 0)
}
```
`import type` di `CODICI_ESITO_CODA` non carica `giro.ts` a runtime (solo il tipo): il modulo resta puro, e lo importa
anche il test su PGlite.

**Log**: nessuno (puro). **Verifica**: `npx vitest run __tests__/lib/fatture-coda/avvisi-testi.test.ts __tests__/architecture/date-con-timezone.test.ts __tests__/architecture/date-senza-fuso.test.ts __tests__/architecture/catch-muti-allowlist.test.ts __tests__/architecture/coda-fatture-esiti-i18n.test.ts`
→ **`Test Files 5 passed`**.

### 4.4 INVIO — `src/lib/fatture-coda/avvisi.ts`

**Passi**
1. **Rosso**: `__tests__/lib/fatture-coda/avvisi.test.ts` (`// @vitest-environment node`), con `enqueueNotifiche`,
   `sediReali`, `staffScuola` e `logEvento` sostituiti (`vi.mock` come `stato-righe.test.ts:15-21`) e un client finto
   `{ rpc: vi.fn() }`:
   1. `PGRST202` e `42883` → nessun invio, **`warn`** `avvisi-non-disponibili` (giro 1: con `info` il caso è rosso,
      misurato), esito `non-disponibili`; `XX000` → `error`
      `avvisi-non-letti`; risposta malformata → `error` `avvisi-illeggibili`; la RPC che **lancia** → `error`
      `avvisi-eccezione`, e la promessa si risolve.
   2. `inizioMs` più vecchio di `LIMITE_AVVISI_MS` → la RPC **non** è chiamata, `info` `avvisi-rinviati`.
   3. Nessun fatto → `info` `avvisi-nessuno`, nessuna lettura di sedi, nessun invio.
   4. Una fine di U1, un errore `esito_incerto` di U2, admin `[A1, A2]`: `enqueueNotifiche` chiamata **una volta per
      destinatario** (`utenteIds` di lunghezza 1), nell'ordine fine a U1, errori a U2, `fattura_coda_da_verificare` ad
      A1 e ad A2; sempre `bufferMin: 0`, `link: '/admin/coda-fatture'`, e **senza** la chiave `scuolaId`
      (`expect(arg).not.toHaveProperty('scuolaId')`); esito `{ esito: 'spediti', avvisi: 4, tentate: 4 }`; `info`
      `avvisi-spediti` con `{ avvisi: 4, tentate: 4, admin: 2, errori: 1, fini: 1, pausa: false }`, e nessun valore
      stringa diverso da `operazione`, `esito`, `azione`.
   5. Solo errori da correggere → `sediReali` **non** chiamata. Solo una pausa, con `in_attesa [U1]` → `sediReali`
      chiamata una volta, e la pausa va a U1, A1, A2.
   6. `sediReali` con `error` → `warn` `admin-non-risolti`, e l'avviso a chi ha accodato parte lo stesso.
   7. Una ripresa con `in_attesa [U1, U2]`, `attore: A1`, e un `enqueueNotifiche` che lancia per il primo destinatario
      → gli altri partono (U2 e A2, mai A1), `tentate: 3`, `error` `avviso-non-accodato` col `tipo`
      `fattura_coda_ripresa`.
2. **Verde** (il file eseguito il 24/09, §0.1; al giro 1 cambia solo il livello di `avvisi-non-disponibili`):

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { enqueueNotifiche } from '@/lib/push/enqueue'
import { staffScuola } from '@/lib/notifiche/destinatari'
import { sediReali } from '@/lib/scuole/reali'
import { codaAssente } from '@/lib/fatture-coda/api'
import { MAX_DURATION_BLOCCO_S } from '@/lib/pagamenti/lotto-fatture'
import { LINK_CODA_FATTURE, categoria, componiAvvisi, zFattiCoda } from '@/lib/fatture-coda/avvisi-testi'

/**
 * ─── GLI AVVISI DELLA CODA FATTURE: PRENDERLI E SPEDIRLI (consegna 2c) ─────────────
 *
 * Prende i fatti nuovi con `fatture_coda_avvisi_prendi` (che li segna come avvisati nella
 * stessa transazione), compone i testi con `avvisi-testi.ts` e accoda una notifica per
 * destinatario: campanella al prossimo polling, push al prossimo `notifiche-dispatch`.
 * NON LANCIA MAI: la chiamano la route del giro, a giro finito, e quella della sospensione,
 * a stato già scritto — il loro esito non dipende da qui. Al più una volta: un inserimento
 * fallito dopo la RPC è un avviso perso, e lo registra `enqueueNotifiche`.
 */

export const OPERAZIONE_AVVISI = 'fatture-coda/avvisi'
/** Oltre questo tempo dall'inizio della route del giro gli avvisi aspettano il giro dopo (restano da avvisare). */
export const LIMITE_AVVISI_MS = MAX_DURATION_BLOCCO_S * 1_000 - 20_000
/** Quanti errori al più per chiamata (la funzione ne accetta da 1 a 500). */
export const ERRORI_PER_CHIAMATA = 200

export type EsitoAvvisiCodice =
  | 'spediti'
  | 'nessuno'
  | 'rinviati'
  | 'non-disponibili'
  | 'non-letti'
  | 'illeggibili'
  | 'eccezione'

export interface EsitoAvvisi {
  esito: EsitoAvvisiCodice
  avvisi: number
  /** Inserimenti tentati, uno per destinatario (l'esito di ciascuno lo registra `enqueueNotifiche`). */
  tentate: number
}

const esito = (e: EsitoAvvisiCodice, avvisi = 0, tentate = 0): EsitoAvvisi => ({ esito: e, avvisi, tentate })

export async function spedisciAvvisiCoda(
  sb: SupabaseClient,
  opzioni: { operazione: string; attore?: string | null; inizioMs?: number },
): Promise<EsitoAvvisi> {
  const base = { operazione: OPERAZIONE_AVVISI, azione: opzioni.operazione }
  try {
    if (opzioni.inizioMs !== undefined && Date.now() - opzioni.inizioMs > LIMITE_AVVISI_MS) {
      logEvento('fattura', 'info', { ...base, esito: 'avvisi-rinviati', ms: Date.now() - opzioni.inizioMs })
      return esito('rinviati')
    }

    const { data, error } = await sb.rpc('fatture_coda_avvisi_prendi', { p_limite: ERRORI_PER_CHIAMATA })
    if (error) {
      if (codaAssente(error)) {
        // `warn`, come le POST della coda sullo stesso caso (`coda-assente`): in produzione è
        // la migrazione che manca, e gli avvisi tacerebbero a ogni tick col battito verde.
        logEvento('fattura', 'warn', { ...base, esito: 'avvisi-non-disponibili' }, error)
        return esito('non-disponibili')
      }
      logEvento('fattura', 'error', { ...base, esito: 'avvisi-non-letti' }, error)
      return esito('non-letti')
    }

    const letti = zFattiCoda.safeParse(data)
    if (!letti.success) {
      // I fatti sono GIÀ segnati come avvisati: questo è un avviso perso, e va gridato.
      logEvento('fattura', 'error', { ...base, esito: 'avvisi-illeggibili' }, letti.error)
      return esito('illeggibili')
    }
    const fatti = letti.data
    if (fatti.errori.length === 0 && fatti.fini.length === 0 && !fatti.pausa && !fatti.sospensione) {
      logEvento('fattura', 'info', { ...base, esito: 'avvisi-nessuno' })
      return esito('nessuno')
    }

    // Gli admin servono per i «da verificare», le anomalie, la pausa, la sospensione e la
    // ripresa; per i soli errori da correggere no, e la lettura non si fa.
    const servonoAdmin =
      fatti.pausa !== null ||
      fatti.sospensione !== null ||
      fatti.errori.some((e) => categoria(e.codice) !== 'da_correggere')
    const admin = servonoAdmin ? await adminReali(sb) : []
    const avvisi = componiAvvisi(fatti, { adesso: new Date(), admin, attore: opzioni.attore ?? null })

    let tentate = 0
    for (const a of avvisi) {
      for (const utente of a.destinatari) {
        tentate++
        try {
          // Uno per destinatario: `creato_da` non ha FK, e un accodante cancellato farebbe
          // fallire sulla FK di `notifiche` l'INSERT intera di una chiamata con più utenti.
          await enqueueNotifiche(sb, {
            utenteIds: [utente],
            tipo: a.tipo,
            titolo: a.titolo,
            corpo: a.corpo,
            link: LINK_CODA_FATTURE,
            entitaTipo: a.entitaTipo,
            entitaId: a.entitaId,
            bufferMin: 0,
            // Nessuno `scuolaId`, di proposito: senza sede nessun interruttore (decisione 21).
          })
        } catch (err) {
          logEvento('fattura', 'error', { ...base, esito: 'avviso-non-accodato', tipo: a.tipo }, err)
        }
      }
    }

    logEvento(
      'fattura',
      'info',
      {
        ...base,
        esito: 'avvisi-spediti',
        avvisi: avvisi.length,
        tentate,
        admin: admin.length,
        errori: fatti.errori.length,
        fini: fatti.fini.length,
        pausa: fatti.pausa !== null,
        sospesa: fatti.sospensione?.evento === 'sospesa',
        ripresa: fatti.sospensione?.evento === 'ripresa',
      },
      undefined,
      { distingui: ['azione'] },
    )
    return esito('spediti', avvisi.length, tentate)
  } catch (err) {
    logEvento('fattura', 'error', { ...base, esito: 'avvisi-eccezione' }, err)
    return esito('eccezione')
  }
}

/**
 * Gli admin delle sedi REALI: `sediReali` esclude la sede di collaudo, `staffScuola` unisce sede
 * primaria e ponte `utenti_scuole` (l'unica lettura ammessa dal lock `destinatari-con-ponte`) e
 * registra da sé i propri guasti. Vuoto ⇒ gli avvisi agli admin di questa chiamata sono persi,
 * e lo dice il `warn`.
 */
async function adminReali(sb: SupabaseClient): Promise<string[]> {
  const sedi = await sediReali(sb, OPERAZIONE_AVVISI)
  const ids = new Set<string>()
  for (const s of sedi.reali) for (const id of await staffScuola(sb, s.id, ['admin'])) ids.add(id)
  if (ids.size === 0) {
    logEvento('fattura', 'warn', { operazione: OPERAZIONE_AVVISI, esito: 'admin-non-risolti' }, sedi.error ?? undefined)
  }
  return [...ids]
}
```

**Verifica**: `npx vitest run __tests__/lib/fatture-coda/avvisi.test.ts __tests__/lib/fatture-coda/avvisi-testi.test.ts __tests__/architecture/eventi-log.test.ts __tests__/architecture/destinatari-con-ponte.test.ts __tests__/architecture/catch-muti-allowlist.test.ts __tests__/architecture/messaggio-errore-nei-log.test.ts`
→ **`Test Files 6 passed`**.

### 4.5 ROTTE — il giro e la sospensione

**Passi**
1. **Rosso.**
   - `__tests__/api/fattura-coda-giro.test.ts`: `avvisi: vi.fn()` in `h` (`:15-19`),
     `vi.mock('@/lib/fatture-coda/avvisi', () => ({ spedisciAvvisiCoda: h.avvisi }))`, nel `beforeEach` (`:46-52`)
     una `mockImplementation` che registra `battiti().length` al momento della chiamata e risolve
     `{ esito: 'nessuno', avvisi: 0, tentate: 0 }`. Casi nuovi:
     `it.each(['finestra-sync', 'quota-oraria', 'niente-da-fare', 'eseguito', 'errore'])` → una chiamata, col client
     del giro (`toBe(CLIENT_FINTO)`) e `{ operazione: 'fatture-coda-tick', inizioMs: expect.any(Number) }`, **dopo** il
     battito (registrato `1`), stato della risposta invariato (200, o 500 per `errore`); nessuna chiamata sui due 401
     (`:59-84`) né quando il giro lancia (`:167-179`); con `{ esito: 'non-letti' }` la risposta resta
     `{ ok: true, esito: 'niente-da-fare', emesse: 0, errori: 0, riprova: 0 }` (`:105`).
   - `__tests__/api/fattura-coda-sospensione.test.ts`: `avvisi: vi.fn()` in `h` (`:9`), lo stesso `vi.mock`, risolta nel
     `beforeEach` (`:34-38`). Casi nuovi: sospendi → una chiamata con `(client, { operazione:
     'coda-sospensione:sospendi', attore: ADMIN })`, dopo la RPC (`invocationCallOrder` di `h.rpc` minore); riprendi →
     `coda-sospensione:riprendi`, e la sveglia resta (`:75`); nessuna chiamata su 400, 403 (`:46-58`), 503 e 500
     (`:79-94`).
2. **Verde** (provato su copie il 24/09 con i test esistenti più i casi nuovi: 35 verdi).
   - `src/app/api/pagamenti/fattura/coda/giro/route.ts`: `import type { SupabaseClient } from '@supabase/supabase-js'` e
     `import { spedisciAvvisiCoda } from '@/lib/fatture-coda/avvisi'`; a `:98-101`:
     ```ts
     let giro: EsitoGiro
     let supabase: SupabaseClient
     try {
       supabase = await createAdminClient()
       giro = await eseguiGiroCoda(supabase)
     } catch (err) {
     ```
     (il ramo `catch` resta com'è); dopo `battito(giro.esito, t0, giro)` (`:112`):
     ```ts
     // Consegna 2c — gli avvisi della coda (decisioni 12 e 21), dopo il battito e in OGNI esito del
     // giro: anche con «niente da fare» il bidello può aver chiuso una voce, una «Togli» può aver
     // finito un gruppo, un admin può aver sospeso. Non lancia e non cambia la risposta; oltre
     // `LIMITE_AVVISI_MS` rinvia al giro dopo, e i fatti restano da avvisare.
     await spedisciAvvisiCoda(supabase, { operazione: JOB, inizioMs: t0 })
     ```
   - `src/app/api/pagamenti/fattura/coda/sospensione/route.ts`: l'import, e fra il log (`:54-58`) e la sveglia (`:60`):
     ```ts
     // Consegna 2c (decisione 12): sospensione e ripresa si avvisano agli admin e a chi ha fatture
     // in attesa, meno chi ha premuto. Non lancia e non cambia la risposta: lo stato è già scritto.
     await spedisciAvvisiCoda(sb, { operazione, attore: auth.user.id })
     ```
3. `__tests__/architecture/isolamento-sede-coverage.test.ts`, solo testo:
   - voce `'pagamenti/fattura/coda/sospensione:POST'` (`:1305`), prima dell'apice di chiusura: «. Dalla consegna 2c,
     dopo la RPC riuscita, la route chiama `spedisciAvvisiCoda` (`src/lib/fatture-coda/avvisi.ts`, fuori da questo
     audit), che legge la coda di TUTTE le sedi e avvisa gli admin e chi ha fatture in attesa: nei testi solo
     conteggi e orari, nessun dato di una voce»;
   - il commento su `coda/giro:POST` (`:1293-1295`, giro 1), che dice «nel proprio file non ha query — il
     lavoratore di tutte le sedi vive in `src/lib/fatture-coda/giro.ts`, che questo lock non audita.»: dopo quella
     frase, tre righe di commento: «// Dalla consegna 2c la route chiama anche `spedisciAvvisiCoda`
     (`src/lib/fatture-coda/avvisi.ts`, fuori da questo audit per la stessa ragione), che legge la coda e gli admin
     di tutte le sedi reali: negli avvisi solo conteggi, categorie e orari.»
   Nessuna voce nuova, nessun numero cambia: i file delle route non hanno `.from()`/`.rpc()` nuove (`:1263-1264`,
   `:1293-1295`), e `coda/giro:POST` resta fuori. La voce della sync (`:1281`) non si tocca più (S4).

**Verifica**: `npx vitest run __tests__/api/fattura-coda-giro.test.ts __tests__/api/fattura-coda-sospensione.test.ts __tests__/architecture/isolamento-sede-coverage.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/api/zod-coverage.test.ts __tests__/architecture/gate-coverage.test.ts`
→ **`Test Files 6 passed`**.

### 4.6 PUSH — il pulsante della push nella «Coda fatture» (onda 1)

Al giro 1 il compito perde il layout admin e `NativePushAutoRegister` (T13): il pulsante basta, sul web e nell'app,
e non iscrive la cuoca né chiede il permesso a chi apre l'area admin. Il `select` senza filtro del dispatch lo
tratta DISPATCH (§4.7): senza, questo pulsante porterebbe sul telefono tutte le notifiche dello staff.

**Passi**
1. **Rosso**: `__tests__/pages/admin-coda-fatture-push.test.tsx`:
   - `PushOptIn` con `etichette={{ attiva: 'A', attive: 'B' }}`, `navigator.serviceWorker = { getRegistration: async
     () => undefined }` e `window.PushManager` finti, `isNativeApp` falso (`vi.mock('@/lib/push/native-register')`) →
     `findByRole('button', { name: 'A' })`; senza `etichette` → «Attiva promemoria pagamenti» (`pagamenti.json:49`,
     piatta). Con `isNativeApp` vero il pulsante c'è subito, senza service worker (`PushOptIn.tsx:24`).
   - La pagina: `useSessionIdentity` finto (`{ userId, role: 'segreteria', ready: true }`, come
     `admin-staff-tab-scadenze.test.tsx:46-48`), `CodaFatturePanel` sostituito, gli stessi finti del browser → il
     pulsante «Attiva le notifiche della coda su questo dispositivo».
2. **Verde** (i file sorgente controllati con `tsc` il 24/09, §0.1):
   - `PushOptIn.tsx:9`: `interface Props { userId: string; etichette?: { attiva: string; attive: string } }`, con un
     docblock sulla prop («i testi del pulsante per chi non è un genitore, consegna 2c»); `:20` destruttura `etichette`;
     `:104`: `{subscribed ? (etichette?.attive ?? t('promemoriaAttivi')) : (etichette?.attiva ?? t('attivaPromemoria'))}`.
     Nient'altro: per i genitori non cambia un byte a schermo.
   - `messages/{it,en}/adminContabilita.json`, due righe **prima** di `"codaFatture": {` (`:1174` in entrambi), senza
     riordinare niente: it `"codaFatturePushAttiva": "Attiva le notifiche della coda su questo dispositivo"`,
     `"codaFatturePushAttive": "Notifiche della coda attive su questo dispositivo"`; en `"Turn on queue
     notifications on this device"`, `"Queue notifications on for this device"`. «della coda» al giro 1: allo staff
     la push porta solo quelle (T13), e il pulsante non deve promettere le altre. Nessuna delle parole vietate da
     `messaggi-plurali-e-glossario` (`:971-993`: inglesi nel catalogo it, italiane nell'en).
   - `coda-fatture/page.tsx`: import di `PushOptIn`; a `PageHeader` (`:21-26`, che ha `actions`,
     `src/components/ui/cockpit.tsx:69-84`):
     ```tsx
     actions={
       userId ? (
         // Consegna 2c: gli avvisi della coda arrivano sul telefono, a PC spento, solo se questo
         // dispositivo è iscritto alla push — sul web e nell'app, dallo stesso pulsante. Allo staff
         // la push porta solo gli avvisi della coda e gli scarti SdI (il filtro sta nel dispatch).
         <PushOptIn
           userId={userId}
           etichette={{ attiva: t('codaFatturePushAttiva'), attive: t('codaFatturePushAttive') }}
         />
       ) : undefined
     }
     ```

**Log**: nessuno nuovo; `PushOptIn` logga già i fallimenti (`PushOptIn.tsx:67`; nell'app `registerNativePush` logga
ogni ramo, `native-register.ts:132-231`). **Verifica**: `npx vitest run __tests__/pages/admin-coda-fatture-push.test.tsx __tests__/architecture/messaggi-parita-cataloghi.test.ts __tests__/architecture/messaggi-plurali-e-glossario.test.ts __tests__/architecture/messaggi-chiavi-orfane.test.ts __tests__/architecture/catch-muti-allowlist.test.ts`
→ **`Test Files 5 passed`**.

### 4.7 DISPATCH — allo staff la push porta solo la coda e gli scarti (onda 2)

Nato al giro 1 (rilievo 1): il pulsante di PUSH iscrive la **persona**, e il dispatch spedisce ogni sua riga pendente
senza guardare tipo né ruolo (`src/app/api/push/dispatch/route.ts:145-151`). Parte quando TESTI ha finito (§2.2):
importa `TIPI_AVVISO_CODA`, così l'elenco è uno solo.

**Passi**
1. **Rosso**: in `__tests__/api/push-dispatch.test.ts`, l'import `import { TIPI_AVVISO_CODA } from
   '@/lib/fatture-coda/avvisi-testi'` e, in fondo al file, `describe('POST /api/push/dispatch — lo staff riceve in
   push solo la coda fatture (consegna 2c)')`, col finto del file (code FIFO per tabella e registro delle chiamate,
   `:3-28`), righe `{ id, utente_id, tipo, titolo: 'titolo-<id>', corpo: null, link, utenti }` e subscription web
   `{ id, utente_id, endpoint, p256dh: 'p', auth: 'a', platform: 'web' }`. Utenti e sedi palesemente finti:
   1. **la lettura chiede tipo e ruolo nella stessa query**: l'argomento del `select` su `notifiche` contiene `tipo`
      e `utenti(role, ruolo)`. È il caso che tiene in piedi gli altri: il finto restituisce le righe con `utenti`
      qualunque cosa chieda il `select`, e senza questo controllo resterebbero verdi anche togliendo la relazione
      dalla lettura (misurato, §6.3).
   2. segreteria con un dispositivo web, sue `onboarding_completato`, `fattura_coda_fine` e `fattura_scartata`, più un
      tipo qualunque a un genitore con un dispositivo (`utenti: { role: 'genitore', ruolo: 'genitore' }`) → i titoli
      spediti da `sendPush` sono **esattamente** quelli della coda, dello scarto e del genitore; gli id nell'`in`
      dell'UPDATE su `notifiche` sono **tutti e quattro**; `body.data` e il battito `info` `ok` con `{ inviate: 3,
      notifiche: 4, escluse_staff: 1 }`.
   3. la cuoca (`utenti: { role: 'cuoca', ruolo: 'cuoca' }`) con un dispositivo nativo (`platform: 'android'`, FCM
      configurato): la sua `mensa_allergia` → `sendNativePush` mai chiamata, la riga marcata, `escluse_staff: 1`.
   4. ogni tipo di `TIPI_AVVISO_CODA` a un admin con un dispositivo → `sendPush` chiamata `TIPI_AVVISO_CODA.length`
      volte, `escluse_staff: 0`.
   5. un'`onboarding_completato` a una segreteria **senza** dispositivi → marcata come sempre, `escluse_staff: 0`: si
      contano le push non portate, non le righe.
   Rossi oggi: il `select` non chiede `tipo` né la relazione, la segreteria riceve `onboarding_completato`,
   `escluse_staff` non c'è.
2. **Verde**, `src/app/api/push/dispatch/route.ts` (il testo provato su copie il 24/09: i 5 casi nuovi, i 13 di oggi,
   `cron-battito` 29 e `cron-secret` 8 contro la route modificata, **55 verdi**; `tsc` 0 errori, §0.1):
   - dopo `import { segretoCronValido } from '@/lib/security/segreto-cron'` (`:9`):
     `import { TIPI_AVVISO_CODA } from '@/lib/fatture-coda/avvisi-testi'`;
   - dopo `const JOB = 'push-dispatch'` (`:47`), una riga vuota e:
     ```ts
     /**
      * ALLO STAFF LA PUSH PORTA SOLO GLI AVVISI DELLA CODA FATTURE E LO SCARTO SDI (consegna 2c
      * della coda fatture; decisione 21 del titolare: la push entro 5 minuti, e mai un nome).
      *
      * Fino alla 2c nessuno dello staff aveva un dispositivo iscritto. Il pulsante della «Coda
      * fatture» iscrive la PERSONA, non un tipo: senza questo filtro le porterebbe anche tutte le
      * altre notifiche dello staff — misurate il 24/09: 3.267 in 30 giorni su 7 destinatari, più di
      * un terzo di tipi che mettono nel corpo il nome di una persona (un genitore, un bambino, chi ha
      * ricevuto le credenziali: `onboarding_completato`, `credenziali`, `assenza_comunicata`,
      * `allergie_aggiornate`) — sulla schermata di blocco, e gli avvisi della coda ci annegherebbero
      * dentro. Quelle restano nella campanella, com'erano.
      * La cuoca sta nell'elenco per la stessa ragione: vive nell'area admin. Allargarlo è una
      * decisione del titolare (docs/superpowers/specs/2026-09-22-coda-fatture-aruba/
      * consegna-2c-notifiche.md, §7.2).
      */
     const RUOLI_PUSH_SOLO_CODA = new Set(['admin', 'coordinator', 'segreteria', 'cuoca'])
     const TIPI_PUSH_STAFF = new Set<string>([...TIPI_AVVISO_CODA, 'fattura_scartata'])

     /**
      * Il destinatario è dello staff? Lo dice la relazione incorporata `utenti(role, ruolo)` della
      * stessa lettura (una FK sola, `notifiche_utente_id_fkey`): un oggetto, un array per prudenza.
      * Schema doppio `role`/`ruolo`, come `staffScuola`. Riga senza utente → non è staff.
      * Nella stessa lettura e non in una `.from('utenti')` a parte: una seconda query fallita
      * fermerebbe con un 500 anche la push dei genitori. Il lock `isolamento-sede-coverage` guarda
      * le `.from()`, non le relazioni incorporate: qui passa il solo ruolo del destinatario di
      * ciascuna riga, nessun dato di sede.
      */
     function destinatarioDelloStaff(n: { utenti?: unknown }): boolean {
       const u: unknown = Array.isArray(n.utenti) ? n.utenti[0] : n.utenti
       if (!u || typeof u !== 'object') return false
       const { role, ruolo } = u as { role?: unknown; ruolo?: unknown }
       return RUOLI_PUSH_SOLO_CODA.has(String(role ?? '')) || RUOLI_PUSH_SOLO_CODA.has(String(ruolo ?? ''))
     }
     ```
   - `:147`: `.select('id, utente_id, titolo, corpo, link')` → `.select('id, utente_id, tipo, titolo, corpo, link,
     utenti(role, ruolo)')`: il ruolo viaggia con la riga (T13), nessuna lettura in più e nessun ramo d'errore nuovo;
   - dopo `let rimandate = 0` (`:217`):
     ```ts
     // Notifiche dello staff che la push NON porta per scelta (vedi `TIPI_PUSH_STAFF`): marcate
     // come quelle di chi non ha dispositivi, e contate — «non spedita apposta» non è muto.
     let escluseStaff = 0
     ```
   - nel ciclo, subito dopo `const userSubs = subsByUser.get(n.utente_id) || []` (`:222`):
     ```ts
     // Allo staff solo gli avvisi della coda e lo scarto SdI (consegna 2c): il resto resta
     // nella campanella. Niente da spedire e niente da riprovare, come senza dispositivi.
     if (userSubs.length > 0 && destinatarioDelloStaff(n) && !TIPI_PUSH_STAFF.has(n.tipo)) {
       escluseStaff++
       inviateIds.push(n.id)
       continue
     }
     ```
   - nel battito `ok` (`:367-377`) e nella risposta (`:378-387`), dopo `subs_rimosse: toRemove.length,`:
     `escluse_staff: escluseStaff,`.
   La marcatura delle escluse è quella di chi non ha dispositivi (`:257-285`): niente da spedire, niente da
   riprovare. Senza, resterebbero pendenti per sempre e intaserebbero la `.limit(500)` delle più vecchie (`:151`,
   `:275-280`). Per chi non è dello staff non cambia niente: `destinatarioDelloStaff` è falso e il ciclo è quello di
   oggi (i 13 casi di oggi, che non hanno `utenti` nelle righe, restano verdi).

**Log**: nessuna riga nuova; `escluse_staff` nel battito `ok` (§3.3). **Verifica**: `npx vitest run __tests__/api/push-dispatch.test.ts __tests__/api/cron-battito.test.ts __tests__/api/cron-secret.test.ts __tests__/architecture/isolamento-sede-coverage.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/api/zod-coverage.test.ts __tests__/architecture/eventi-log.test.ts __tests__/architecture/catch-muti-allowlist.test.ts`
→ **`Test Files 8 passed`**.

### 4.8 DOC, passo B — la voce della 2c e il riallineamento (onda 3)

Legge il diff reale e il nome vero della migrazione (`<T>` qui sotto è quello del file). Edit su sottostringhe uniche.
Le righe sono di `52d8e7a7`: DOC passo A ne aggiunge qualcuna (il «Verificato» della #164 nel PRD, una frase in
HANDOFF `:17`), e si cerca per stringa.

- **PRD**:
  - voce nuova **in cima** alle voci della coda, prima del titolo della voce della correzione del 24/09 (`:1791`,
    «## Changelog — Coda fatture Aruba — correzione urgente del 24/09…»; la 2b ora è sotto, a `:1940`), chiusa da `---`:
    `## Changelog — Coda fatture Aruba — consegna 2c: le notifiche — <data del commit> (branch
    \`feat/coda-fatture-notifiche-2c\`; stato di produzione: lo registra il primo commit del branch che segue il
    deploy)`. Mai «non ancora in produzione» né «PR da aprire». Paragrafi: la migrazione (nome, applicata
    dall'integrazione, mai a mano; nessuna scrittura in produzione; il piano); decisione 21 (tipi, destinatari, tempi,
    mai nomi); decisione 12; lo scarto SdI com'è (chi ha accodato lo riceve già, S4); la push allo staff, solo per la
    coda e gli scarti, coi numeri di §0 che spiegano perché (T13); «due giri non avvisano due volte» (il segno, T3),
    le fini prima degli errori, e «al più una volta» (T5); i log (§3.3); le scelte di §1.3 in attesa del titolare;
    «Fuori, e perché» (§1.2); «Verifica dopo il merge» (§6.4).
  - `:78`: «⏳ **Consegna 2c** (notifiche) e il resto del piano completo» → «🔧 **Consegna 2c** (branch
    `feat/coda-fatture-notifiche-2c`; lo stato di produzione lo registra il primo commit del branch che segue il
    deploy): a chi ha accodato la fine del gruppo, gli errori, i «da verificare» e la pausa per 429; agli admin i «da
    verificare», le fatture partite e non a registro, la pausa, la sospensione e la ripresa; campanella subito, push
    entro 5 minuti anche allo staff — dal pulsante della «Coda fatture», e solo per gli avvisi della coda e gli scarti
    SdI —, mai nomi. ⏳ Il resto del piano completo» (il seguito della frase, «(fra cui la verifica automatica…»,
    resta).
  - `:86`, «Centro Notifiche», prima del `|` finale: « 🔧 Dalla consegna 2c della coda fatture (branch
    `feat/coda-fatture-notifiche-2c`): sei tipi `fattura_coda_*` allo staff, fuori dal pannello degli interruttori (non
    si spengono). La push anche allo staff, dal pulsante della pagina «Coda fatture» (web e app): porta solo quei sei
    tipi e `fattura_scartata`; le altre notifiche dello staff — e quelle della cuoca — restano nella campanella
    (filtro nel dispatch, `escluse_staff` nel suo battito).»
- **HANDOFF.md**:
  - in §1, dopo la riga «Correzione del 24/09» (`:15`, che segue ora quella della 2b): «| **Consegna 2c** | — | — | Branch `feat/coda-fatture-notifiche-2c`. Le
    notifiche della coda (decisioni 12 e 21) … Migrazione `<T>_fatture_coda_avvisi.sql`. Piano:
    `consegna-2c-notifiche.md`. Lo stato di produzione (PR, merge, deploy, migrazione verificata) lo registra il primo
    commit del branch che segue il deploy |»;
  - «Come si usa oggi», punto 3 (`:22`), in fondo: «Dalla consegna 2c gli avvisi arrivano da soli: nella campanella e, sul
    dispositivo iscritto dal pulsante «Attiva le notifiche della coda» della pagina (sul web o nell'app), come push.
    Allo staff la push porta solo gli avvisi della coda e gli scarti SdI.»;
  - §3, punto 1 del «Da fare» (`:53`), sostituito per intero: oggi è «1. **Notifiche**: fine gruppo, errori, scarti
    SdI, pausa 429. Campanella più push, mai nomi; gli admin ricevono anomalie e «Da verificare» (decisioni 20–21).»
    (DOC passo A non lo tocca più) e diventa «1. **Notifiche** — 🔧 fatte nel nucleo dalla consegna 2c (branch
    `feat/coda-fatture-notifiche-2c`, piano `consegna-2c-notifiche.md`; lo stato di produzione lo registra il primo
    commit del branch che segue il deploy). Restano al piano completo: l'outbox con la consegna almeno una volta, le
    anomalie di sistema come notifica, i link con parametri, il numero della fattura nei testi della coda, la
    sospensione «sistema», il catalogo con «obbligatoria» (R2A-1.8). Restano al titolare (piano §7.2): lo scarto SdI
    senza interruttore e con la serie, e la push di tutti i tipi allo staff e alla cuoca.»
- **nucleo.md**: `:31` toglie «notifiche» da «Fuori dal nucleo» e aggiunge «(le notifiche sono entrate con la consegna
  2c, §6)»; la route del giro (`:151-156`) e la sospensione (`:183-185`) prendono una riga «dopo il battito / dopo la RPC
  riuscita, gli avvisi (§6)»; in fondo al file, dopo §5 (`:219`), la §6 nuova «Notifiche (consegna 2c)»: colonne, funzione, tipi,
  destinatari (§1.3, S3), testi (rimando a questo piano, §3), lo scarto SdI com'è (S4), la push allo staff e il suo
  filtro (T13), tempi, limiti (al più una volta, 200 errori e 100 gruppi per chiamata, niente anomalie di sistema,
  niente sospensione «sistema»). È la sezione che **prevale** per il nucleo.
- **contratto.md**, subito sotto il titolo di §14 (`:658`), e **d5-interfaccia-notifiche.md**, subito sotto il titolo di
  §10 (`:396`): «> **Riallineamento 2c (24/09).** Per il nucleo valgono `nucleo.md` §6 e `consegna-2c-notifiche.md`
  §1.5: niente outbox, tipi fuori catalogo, segni sulle voci e sulla riga di stato, scarto SdI allo staff della sede
  com'era. Questa sezione resta il riferimento del piano completo.»
- **scomposizione.md**, sotto i titoli di R2A-4.13 (`:1840`) e R2A-5.9 (`:2106`): «> Sostituito per il nucleo dalla
  consegna 2c (`consegna-2c-notifiche.md`).»; sotto R2A-1.8 (`:1171`), il catalogo delle obbligatorie, che la 2c **non**
  fa: «> Non fatto dalla consegna 2c: i sei tipi della coda stanno fuori dal catalogo (`consegna-2c-notifiche.md`, S2).
  Resta al piano completo.» (giro 1: la prima stesura lo dava per sostituito, e il §3 di HANDOFF lo elenca fra ciò che
  resta).
- ⚠️ Niente dati personali (P3 di `pii-nei-file-tracciati.test.ts:185-215`): i nomi di colonna non vanno mai accanto a
  un valore; nessun uuid di sede. **Log**: nessuno.

---

## 5. Lock e fotografie

| Meccanismo | In questa PR |
|---|---|
| `MIGRAZIONI_ATTESE_AL_MERGE` (`soglia-fotografia.ts:162`) | **resta `{}`**: la migrazione non accende `toccaLaRls` (`:267-276`), `toccaUnUnico` (`:192-195`), `toccaLeFkUtenti` (`:208-211`), che girano su `senzaCommenti` (`:304-359`: i corpi `$$` e le stringhe restano). Lo prova il caso «guardie» di §4.2, e i riconoscitori veri lo hanno già detto (§0.1); una voce aggiunta farebbe rossa la prova «nessuna voce morta» (`soglia-fotografia.test.ts:293-304`) |
| `rls-per-sede`, `onconflict-arbitro`, `tracce-docente-dichiarate` | accettano un file posteriore alle fotografie che i loro riconoscitori non vedono: nessuna azione |
| Fotografie in `__tests__/fixtures/` | nessuna rigenerata: la migrazione è «in coda» e legittima (`migrazioni-complete.test.ts:244-271`, version posteriore all'ultima della fotografia; `:273-315`, posteriore alla soglia; nessuna voce `IN_CODA`) |
| `fk-scuola-id` | nessuna colonna `scuola_id` nuova |
| `migrazioni-senza-sede-cablata` | nessun uuid di sede |
| `security-definer-revoke-lock` (`:413-441`) | `REVOKE … FROM PUBLIC, anon, authenticated` per nome nel file |
| `api.test.ts:258-273` | `fatture-coda-tick` pianificato una volta sola: nessun `cron.schedule` |
| `fatture-coda-nucleo.test.ts:350-399` | l'elenco delle `fatture_coda_%` prende una riga (§4.2 passo 1): da 9 a 10 funzioni, misurato su PGlite con la correzione sotto (§0.1) |
| lock G6 della #164 (`giro.test.ts`, «LOCK: la distanza fra gli accessi è UNA») | legge il solo file `…_fatture_coda_distanza_accessi.sql` e ne vuole uno: la 2c non lo tocca, e nel suo SQL non c'è nessun `interval '… seconds'` (misurato: 0) |
| `isolamento-sede-coverage` | audita i file delle route, non `src/lib` (`:1263-1264`, `:1293-1295`): nelle route della coda nessuna `.from()`/`.rpc()` nuova (gli avvisi stanno in `src/lib`); cambia solo il testo della voce `coda/sospensione:POST` (`:1304-1305`) e del commento su `coda/giro:POST` (`:1293-1295`). **La route del dispatch** (DISPATCH) legge il ruolo come relazione incorporata `utenti(role, ruolo)` dentro la `.from('notifiche')`: il lock guarda le `.from()` e le loro catene, non le relazioni incorporate. Misurato con la sua `scoperte()` vera (§0.1): la route modificata dà `[]`; una `.from('utenti')` separata darebbe `handler-senza-scope` (o `elenco-senza-sede`, con una chiave che non passa da `DA_QUERY`, `:642`), cioè una voce in `AMMESSE` e `handlerEsentati` +1 — il numero per cui il lock dice «fermati» (`:1862-1867`). Non è un'esenzione nascosta: la relazione legge il solo ruolo del destinatario di ciascuna riga già scelta, attraverso l'unica FK fra le due tabelle, e nessun dato di sede; la scelta ha la sua ragione anche senza il lock (una lettura sola, nessun ramo d'errore nuovo, T13), ed è scritta nel commento della route |
| `destinatari-con-ponte` (`:44`, `:52-59`) | gli admin si trovano con `staffScuola`; nessuna lettura nuova di `utenti` per `scuola_id` |
| `eventi-log` (`:342-356`) | i `logEvento(…, 'info')` nuovi sono di `fattura` (INVIO), persistito (`logger.ts:188-189`); il battito `cron` del dispatch prende solo un numero |
| `catch-muti-allowlist`, `messaggio-errore-nei-log` | ogni `catch` registra; l'errore va come quarto argomento, mai il suo `.message` in un testo |
| `date-con-timezone`, `date-senza-fuso` | nessun `Intl.DateTimeFormat` né `toLocale*` nuovi: gli orari passano da `quandoRelativo` (`intlDateTime` con `Europe/Rome`, `src/i18n/config.ts:60-64`) |
| `logging-coverage`, `zod-coverage`, `gate-coverage` | nessuna route né ingresso nuovi |
| `coda-fatture-esiti-i18n` | `CODICI_ESITO_CODA` invariato |
| `messaggi-parita-cataloghi`, `messaggi-plurali-e-glossario` (`:971-993`), `messaggi-chiavi-orfane` | +2 chiavi per lingua in `adminContabilita` (non sotto tutela, `:54-71`); nessuna parola inglese vietata nel catalogo it né italiana nell'en |
| `admin-layout-shell` (`:35-38`), `skip-link-nel-catalogo` (`:79-85`), `guscio-chiaro-dichiara-la-superficie` (`:366-370`) | leggono i layout: il layout admin **non si tocca più** (giro 1, T13), e nessuno dei tre entra nelle verifiche |
| test che importano la route del dispatch (`push-dispatch`, `cron-battito`, `cron-secret`) | le righe dei loro finti non hanno `utenti`: `destinatarioDelloStaff` è falso e il ciclo è quello di oggi; il finto di `cron-battito` restituisce `null` per le tabelle non configurate (`:49-55`), e la relazione non aggiunge letture. 55 verdi contro la route modificata (§0.1) |
| `pii-nei-file-tracciati` | PRD, HANDOFF e questo piano: solo conteggi, version, md5, orari |

Nessun lock si spegne, si allenta o si abbassa.

---

## 6. Gate, checklist, rotture, dopo il merge, rilascio

### 6.1 Gate (a tutti i compiti finiti; in zsh niente pipe prima di `$?`)

```sh
L=<scratchpad>
npx eslint . --max-warnings 0 > "$L/eslint.log" 2>&1; echo "eslint exit=$?"
npx tsc --noEmit > "$L/tsc.log" 2>&1; echo "tsc exit=$?"
npx vitest run > "$L/vitest.log" 2>&1; echo "vitest exit=$?"; grep -E "Test Files|Tests " "$L/vitest.log"
npm run build > "$L/build.log" 2>&1; echo "build exit=$?"
```
Atteso: tutti `exit=0`; **`Test Files 1445 passed`** (1442 più `avvisi-testi`, `avvisi`, `admin-coda-fatture-push`;
`push-dispatch` cresce di 5 casi, non di un file). In CI i job sono due, `quality` ed `e2e` (`.github/workflows/ci.yml:19`, `:100`):
«verde» solo con entrambi, e contando i retry dell'e2e (`playwright.config.ts:117`).

### 6.2 Checklist del critico

1. `git status --porcelain` = i 26 file di §2.3 più questo piano (dal giro 2 anche i due della mensa). Nient'altro.
2. `git diff --stat src/lib/fatture-coda/giro.ts __tests__/lib/fatture-coda/giro.test.ts src/lib/push src/lib/notifiche src/app/api/pagamenti/fattura/sync "src/app/(dashboard)/admin/layout.tsx" src/components/providers`
   → vuoto (S4, T13, §2.4); `git diff --stat main -- supabase/migrations` → il solo file nuovo (le migrazioni del
   nucleo, della 2a, della 2b e della #164 non si toccano); in `fatture-coda-nucleo.test.ts` il diff delle righe
   della #164 (N1–N9, i quattro controlli negativi, `dimenticaAccesso`) mostra solo aggiunte attorno.
3. Migrazione: nome e timestamp di §4.2; `diff` col blocco SQL di §4.2 vuoto; nessuna parola-guardia; `REVOKE`
   presente; nessun `esito_messaggio` nel file; `WITH finiti AS` prima di `WITH nuovi AS`.
4. `grep -rn "fattura_coda_" src/lib/notifiche messages` → vuoto (T7).
5. `grep -n "scuolaId" src/lib/fatture-coda/avvisi.ts` → solo il commento; `grep -c "utenteIds: \[utente\]"` → `1`.
6. Nessun testo di §3.1 compone una stringa letta dal database: in `avvisi-testi.ts` le sole interpolazioni sono numeri
   e il risultato di `quando`; la pausa usa `quando(…, 'dopo le')`.
7. Route: gli avvisi dopo `battito(` e fuori dal `try`; nella sospensione dopo il log e prima di `svegliaCoda`.
8. DISPATCH: `grep -c "utenti(role, ruolo)" src/app/api/push/dispatch/route.ts` → `1`; `grep -c "from('utenti')"
   src/app/api/push/dispatch/route.ts` → `0`; `TIPI_PUSH_STAFF` è `[...TIPI_AVVISO_CODA, 'fattura_scartata']` e
   nient'altro; le escluse finiscono in `inviateIds`; il ciclo per chi non è dello staff è identico a prima (`git diff`).
9. PUSH: `PushOptIn` identico per i genitori (senza `etichette`); le due chiavi prima di `"codaFatture": {` e nello
   stesso punto in it ed en; nessun riordino (`git diff` mostra solo `+`); il layout admin fuori dal diff.
10. PRD e HANDOFF dicono il vero: le modifiche di §4.1 fatte (`grep -c` → `0` su «`35920312716` resta in attesa»,
    su «`35956482220` resta in attesa», su «lo registra la PR di documenti dopo il deploy» e su «data e numero li
    registra la PR di documenti» nei due file); **ogni run «DB migrate (prod)» che i due file dicono «in attesa» lo
    è davvero** (per ciascun numero, `gh run view <numero> --json status` → `waiting`: oggi solo `36006773356`, e
    fino al merge della 2c); nessuna riga `0.` in cima al «Da fare» né un secondo rilievo (g) (lo ha già scritto,
    chiuso, la #164); sulla 2c nessun «non ancora in produzione» né «PR da aprire»; la
    regex P3 passata a mano su PRD, HANDOFF e questo piano non trova niente.
11. Numeri dei lock come §5.

### 6.3 Rompi il codice (copia in scratchpad → modifica → test rosso → `cp` indietro → `shasum` uguale)

| Rottura | Deve diventare rosso |
|---|---|
| SQL: `SET avviso_errore_presa = NULL` nella funzione | `fatture-coda-nucleo` A (e il controllo negativo) |
| SQL: via `bool_and(…) AND` | `fatture-coda-nucleo` A (la fine a gruppo aperto) |
| SQL: `pausa_motivo IS NOT NULL` | `fatture-coda-nucleo` E (la pausa da 15 minuti) |
| SQL: via la linea di partenza degli errori | `fatture-coda-nucleo` G |
| SQL: via il `NOT EXISTS` della linea di partenza delle fini | `fatture-coda-nucleo` G e il controllo negativo |
| SQL: `esito_messaggio` aggiunto all'uscita degli errori | `fatture-coda-nucleo` I (chiavi esatte) e «guardie» |
| SQL: `'aruba-429'` scritto diverso da `giro.ts:248` | `fatture-coda-nucleo` «guardie» |
| SQL: gli errori prima delle fini (l'ordine della prima stesura) | `fatture-coda-nucleo` «guardie» (l'ordine dei due `WITH`; misurato: vero sul testo nuovo, falso su quello di prima) |
| TESTI: `categoria` senza `trasporto_da_verificare` | `avvisi-testi` 1 |
| TESTI: `'inviate'` sempre al plurale | `avvisi-testi` 4 («1 inviata su 3») |
| TESTI: `quando` senza il ramo `domani` | `avvisi-testi` 2 e 8 |
| TESTI: la pausa con «alle» invece di «dopo le» | `avvisi-testi` 8 |
| TESTI: gli errori di un gruppo finito anche in `fattura_coda_errori` | `avvisi-testi` 5 |
| TESTI: l'admin conta anche le proprie voci | `avvisi-testi` 7 |
| TESTI: la pausa ai soli `in_attesa` | `avvisi-testi` 8 |
| TESTI: la sospesa non esclude `da`, o gli admin non escludono `attore` | `avvisi-testi` 9 |
| TESTI: un corpo che interpola `e.codice` | `avvisi-testi` 10 (sonda) |
| TESTI: un tipo aggiunto a `TIPI_NOTIFICA` | `avvisi-testi` 11 |
| INVIO: `scuolaId` passato a `enqueueNotifiche` | `avvisi` 4 |
| INVIO: una sola chiamata con tutti i destinatari | `avvisi` 4 e 7 |
| INVIO: `bufferMin` tolto o diverso da 0 | `avvisi` 4 |
| INVIO: `servonoAdmin` sui soli errori (pausa e sospensione senza admin) | `avvisi` 5 e 7 (misurato) |
| INVIO: via il `try` intorno all'invio | `avvisi` 7 |
| INVIO: `adminReali` sempre | `avvisi` 5 |
| INVIO: il limite di tempo ignorato | `avvisi` 2 |
| INVIO: via il `try` esterno | `avvisi` 1 (la RPC che lancia) |
| INVIO: `avvisi-non-disponibili` a `info` | `avvisi` 1 (misurato) |
| ROTTE: gli avvisi prima del battito | `fattura-coda-giro` («dopo il battito») |
| ROTTE: gli avvisi nel ramo `catch` del giro | `fattura-coda-giro` («il giro lancia») |
| ROTTE: la sospensione senza `attore` | `fattura-coda-sospensione` |
| ROTTE: gli avvisi prima del controllo d'errore della RPC | `fattura-coda-sospensione` (503 e 500) |
| DISPATCH: via il filtro (`if (false)`) | `push-dispatch` 2 e 3 (misurato: 2 rossi) |
| DISPATCH: `fattura_scartata` fuori da `TIPI_PUSH_STAFF` | `push-dispatch` 2 (misurato) |
| DISPATCH: la cuoca fuori da `RUOLI_PUSH_SOLO_CODA` | `push-dispatch` 3 (misurato) |
| DISPATCH: le escluse non marcate (via `inviateIds.push`) | `push-dispatch` 2 e 3 (misurato: 2 rossi) |
| DISPATCH: via `utenti(role, ruolo)` dal `select` | `push-dispatch` 1 (misurato; è il caso che tiene gli altri, §4.7) |
| DISPATCH: contate anche senza dispositivi | `push-dispatch` 5 (misurato) |
| DISPATCH (giro 2): il `sendPush` diretto rimesso in `inviaNotifiche` della mensa (il file di `HEAD`) | `mensa-destinatari-allerta`, il `describe` «la push la porta SOLO il dispatch» (misurato il 24/09 con un config vitest in scratchpad che dirotta `@/lib/mensa/notify` sulla copia: 1 rosso su 7, `sendPush` chiamata 3 volte; stesso config sulla copia attuale: 7 verdi; `shasum` del file invariato) |
| PUSH: `PushOptIn` ignora `etichette` | `admin-coda-fatture-push` |
| PUSH: via `actions` dalla pagina | `admin-coda-fatture-push` |

Al riallineo, con la correzione caricata nel test, tre righe SQL rifatte sulla copia (§0.1): il segno dell'errore → A
(e H e il contratto) rossi; via `bool_and` → A e G rossi; gli errori prima delle fini → «guardie» rossa. Tolto
`dimenticaAccesso()`, A, B e G cadono per la distanza e non per il codice della 2c: se uno di loro diventa rosso
con un `TypeError` su `undefined`, prima di cercare il difetto nello SQL si guarda la presa.

### 6.4 Dopo il merge (solo `SELECT`, dalla radice del repo)

La migrazione la applica l'integrazione. **Non si approva** il run «DB migrate (prod)» che nascerà (annullerà
`36006773356`, quello della #164, `migrate.yml:64-66`), e non si applica niente a mano.
```sh
supabase db query --linked "select version, name from supabase_migrations.schema_migrations where version >= '20260924103451' order by version"
supabase db query --linked "select name, count(*) from supabase_migrations.schema_migrations group by name having count(*) > 1"
supabase db query --linked "select p.proname, md5(p.prosrc), length(p.prosrc), p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth, has_function_privilege('service_role', p.oid, 'EXECUTE') as sr, pg_get_function_identity_arguments(p.oid) as args from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'fatture_coda_avvisi_prendi'"
supabase db query --linked "select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' and column_name in ('avviso_errore_presa', 'avviso_fine_presa', 'avviso_pausa_fino_a', 'avviso_sospesa_il') order by 1, 2"
supabase db query --linked "select count(*) filter (where stato = 'errore' and avviso_errore_presa is distinct from presa_il) as errori_da_avvisare, count(*) as voci from public.fatture_coda"
supabase db query --linked "select tipo, count(*), count(push_inviata_il) from public.notifiche where tipo like 'fattura_coda%' group by tipo"
supabase db query --linked "select contesto->'campi'->>'esito' as esito, livello, sum(occorrenze) from public.app_log where evento = 'fattura' and contesto->'campi'->>'operazione' = 'fatture-coda/avvisi' and giorno >= current_date - 1 group by 1, 2"
supabase db query --linked "select coalesce(u.ruolo, u.role::text) as ruolo, count(distinct ps.utente_id) from public.push_subscriptions ps join public.utenti u on u.id = ps.utente_id where coalesce(u.ruolo, u.role::text) in ('admin', 'coordinator', 'segreteria', 'cuoca') group by 1"
```
Atteso: due righe, `20260924103451` (la #164) e quella della 2c con la version del **file**; nessun nome doppio; **una** riga per la funzione, `md5`
uguale al corpo `AS $$ … $$` del file (node), definer, `search_path=public, pg_temp`, `anon`/`auth` falsi, `sr` vero,
`p_limite integer`; quattro colonne `timestamp with time zone`; `errori_da_avvisare` 0 subito dopo (linea di partenza) o
ai soli errori nati fra migrazione e primo giro; `app_log` con `avvisi-nessuno` o `avvisi-spediti` a ogni tick, **mai**
`avvisi-non-disponibili` (`warn`) dopo il deploy. `escluse_staff` non si misura da `app_log`: il battito `ok` del
dispatch è una riga al giorno col `contesto` della **prima** occorrenza, che di solito è il ramo senza pendenti
(`dispatch/route.ts:159-166`, senza quel campo); il numero di un giro sta nella sua risposta. Se la funzione manca si indaga l'integrazione, mai a mano. La prova dal vivo è la prima
fattura vera: la segreteria (o il titolare) attiva la push dal pulsante della «Coda fatture», il conteggio delle
iscrizioni dello staff sale sopra 0, e sul telefono arrivano «Fattura inviata» o «Fatture in coda: finito» — mai
«Onboarding genitore completato», che resta nella campanella.

### 6.5 Rilascio (sessione principale)

1. **Fatto prima del riallineo**: la #164 mergiata (15:36:06), in produzione (15:37:13) e verificata con sole letture
   (15:44, i controlli del suo §5.2: §0); i branch puliti; `feat/coda-fatture-notifiche-2c` aperto da `main`
   (`52d8e7a7`). **Da fare**: il primo commit, cioè DOC passo A (§4.1, con la #164 in produzione) e questo piano
   copiato nel repo. Se nel frattempo qualcuno ha già scritto la #164 in produzione, le sue frasi si saltano (§4.1).
2. Onde 1–3, gate di §6.1, critico; un commit (in italiano, con le righe di attribuzione), push, PR.
3. CI della PR: `quality` ed `e2e` verdi, retry contati. Merge (squash), lontano dai minuti :00 e :30 (decisione 26,
   `…marshmallow.md:86`; la stessa riga dice «dopo le 16:00», e la 2a e la 2b sono uscite alle 23:06 e alle 06:38:
   l'orario lo sceglie la sessione principale).
4. Deploy `READY` (`gh api repos/erricoluigi17/kidville-web/deployments?sha=<merge completo>` e i suoi `statuses`: conta
   la riga di `vercel[bot]`), poi §6.4. Il run «DB migrate (prod)» non si approva.
5. Pulizia dei branch locali e remoti (AGENTS.md, punto 3). Lo stato di produzione della 2c lo registra il primo commit
   del branch successivo (così lo annunciano i testi di DOC passo B, e così fa questo piano con la #164), o una PR
   di documenti: lo sceglie la sessione principale, e i testi di passo B si adeguano prima del merge.

---

## 7. Rischi e domande

### 7.1 Rischi residui

1. **Al più una volta** (T5): un inserimento fallito dopo la RPC, o un'invocazione uccisa fra la RPC e gli invii, è un
   avviso perso. Il primo lo registra `enqueueNotifiche` (`error`); il secondo solo l'assenza della riga
   `avvisi-spediti` dopo il battito. Il margine è di 20 s (T6); un giro al limite finisce verso i 290 s
   (`lotto-fatture.ts:101-124`), e allora gli avvisi aspettano il tick dopo. L'attesa della #164 non sposta il limite:
   il budget del blocco si conta dall'inizio dell'invocazione, attesa compresa (`giro.ts:346-349`, G9 di
   `giro.test.ts`).
2. **La push arriva solo a chi si iscrive**, dal pulsante della «Coda fatture», dispositivo per dispositivo, sul web e
   nell'app: niente iscrizione automatica nell'area admin (T13). Su iPhone il web-push vuole la pagina aggiunta alla
   schermata Home. Oggi 0 dello staff iscritti (§0): finché nessuno lo fa resta la campanella, e §6.4 lo misura.
   `PushOptIn` non guarda l'esito della `POST /api/push/subscribe` (`PushOptIn.tsx:57-62`): una sottoscrizione
   rifiutata mostra «attive». È preesistente; §6.4 conta quelle vere. Che cosa porta la push allo staff: punto 17.
3. **Tempi**: la riga nasce alla fine del giro che ha visto il fatto (un blocco dura da pochi secondi a circa 5
   minuti; dalla #164 un giro che parte entro 65 s dall'ultimo accesso della coda ad Aruba aspetta prima il residuo,
   fino a 66 s, dentro gli stessi 300 s); la campanella la mostra al polling di 60 s, solo a pagina visibile; la
   push al `notifiche-dispatch` successivo (ogni 5 minuti; oltre 500 pendenti, dopo). «Entro 5 minuti» vale dalla fine del giro. Lo scarto SdI si
   scopre solo alla sync (`fatture-sdi-sync` ogni 30 minuti).
4. **Rumore**: un lotto con errori di dato può dare un `fattura_coda_errori` a ogni giro con lavoro (circa 4 l'ora a
   50 l'ora); il pulsante «Fattura» dà un «Fattura inviata» per clic (gruppo di una voce, S3: il 24/09 i clic sono
   stati 13, cioè 13 avvisi); un admin riceve ogni pausa e ogni sospensione anche senza voci proprie (S3). **Le
   pause**: il 24/09, primo giorno vero, sono state **due** (10:09:59 e 12:39:33), tutte e due da un secondo pulsante
   che ha svegliato un giro meno di un minuto dopo il `signin` del precedente, con un'ora di fermo per tutte le sedi
   ciascuna (§0). La #164 chiude quel caso; restano i 429 che toglie solo il cancello condiviso (HANDOFF `:55`: le
   ricerche del giro contro quelle della sync, le route dirette), e la pausa resta di 60 minuti anche per un 429 sul
   `signin`. Con la 2c ogni pausa manda un «Invio fatture in pausa» a chi ha voci in coda e a ogni admin (oggi 2
   admin reali), **uno** per pausa (il segno `avviso_pausa_fino_a`). Dopo la #164 le pause dovrebbero essere rare:
   l'avviso di pausa può non vedersi dal vivo per giorni, e la sua prova resta quella su PGlite (scenario E e
   contratto, §4.2). Domande 1 e 2 di §7.2.
5. **«Rimetti» conserva `gruppo_id` e `creato_da`** (nucleo `:617-628`): avvisato resta chi aveva accodato, non chi ha
   premuto; e un gruppo può «finire» due volte, con due avvisi, il secondo coi conteggi aggiornati.
6. **Un gruppo chiuso da una «Togli»** si avvisa al tick successivo (fino a 10 minuti, i tick saltano :02 e :32;
   riverificato con la finestra nuova della #164, T6).
7. **Concorrenza** non provata su PGlite (una connessione): la reggono il lucchetto proprio, la ripetizione di stato e
   segno nel `WHERE` della UPDATE degli errori, e l'ordine delle istruzioni (§4.2). Ogni istruzione della funzione ha
   la sua fotografia: un attore concorrente può chiudere una voce fra le fini e gli errori. Dalla #164 non è più un
   secondo giro con voci (sta a 65 s dal rilascio del primo), ma resta la route della sospensione che chiama gli
   avvisi mentre un giro chiude le sue voci, e il bidello di un giro partito mentre la route di un giro senza voci li
   chiama (§4.2, nota). Con le fini **prima** (giro 1), l'errore dell'ultima voce di un gruppo chiuso in quel momento
   esce come errore e la fine arriva alla chiamata dopo; nell'ordine della prima stesura sarebbe stato contato nella fine e riannunciato dopo come
   `fattura_coda_errori`. Resta vero che un errore annunciato da solo ricompare nel riepilogo della fine del suo gruppo:
   è la regola di sempre (§3.1). Una «Rimetti» a cavallo della scansione può far arrivare un «finito» appena prima
   che il gruppo riparta. Se un giro prende la **ripresa** nei millisecondi fra la RPC della
   route e la sua chiamata agli avvisi, anche chi l'ha premuta la riceve: la ripresa azzera `sospesa_da` (nucleo
   `:658-660`) e il giro non conosce l'attore. La sospensione no: `da` resta nella riga.
8. **Il segno dipende da `presa_il`**: un errore o un'emessa nati senza presa non si avviserebbero mai. Oggi non esistono
   (T3); una funzione futura che chiude voci senza presa deve scrivere `presa_il` o rivedere il segno.
9. **Linea di partenza**: gli errori e i gruppi finiti prima della migrazione non si avvisano mai; un gruppo in corso sì,
   quando finisce. Un fatto nato fra l'applicazione della migrazione e il deploy del codice si avvisa al primo giro dopo.
   Se il codice arriva prima della migrazione, fino ad allora `avvisi-non-disponibili` (`warn`) a ogni tick.
10. **Oltre 200 errori in una chiamata** (solo dopo ore di avvisi falliti o rinviati): gli errori rimasti di un gruppo
    già annunciato come finito arrivano poi anche come «N fatture non inviate» (caso H di §4.2).
11. **Un accodante cancellato** (nessuna FK, nucleo `:96-97`): il suo inserimento fallisce sulla FK di `notifiche`
    (`error` di `enqueueNotifiche`), gli altri no (T8). Un accodante che ha cambiato ruolo riceve un avviso senza dati
    che apre una pagina che non vede.
12. **Admin non letti** (`sediReali` o `staffScuola` in errore): gli avvisi agli admin di quella chiamata si perdono, col
    `warn`; quelli a chi ha accodato partono. Un admin di collaudo collegato di nuovo a una sede reale per il ponte li
    riceverebbe (oggi 0, §0; è successo il 29/07, `reali.ts:38-48`): i testi non hanno dati.
13. **Volume della scansione**: raggruppa l'intera `fatture_coda` a ogni tick; al ritmo di oggi (457 fatture in 30 giorni, 23 voci della coda nel primo giorno)
    sono migliaia di righe l'anno, nessun indice serve. Senza pulizia (decisione 22, 24 mesi, non ancora fatta) va
    rimisurato fra un anno.
14. **Scarti SdI** (S4): restano com'erano, allo staff della sede e sotto l'interruttore (oggi spento in 0 sedi su 4);
    chi ha accodato ci sta sempre (21 su 21). Se una sede spegnesse `fattura_scartata`, o chi ha emesso cambiasse
    sede prima dello scarto, chi ha accodato non lo riceverebbe: domanda 3. Le fatture emesse dal pannello Aruba non
    stanno in `fatture_emesse`: la sync non le vede e non le avvisa (i 13 invii esterni di `HANDOFF.md:28`). Resta un
    rischio preesistente, non introdotto: due giri di sync sovrapposti potrebbero avvisare due volte, perché l'UPDATE
    è solo per id (`sync/route.ts:825-834`).
15. **Il filtro del dispatch sta nel giro più delicato delle push** (DISPATCH): una svista toglierebbe la push anche ai
    genitori. La tengono i 13 casi di oggi e `cron-battito`, che non hanno `utenti` nelle righe e restano verdi, e il
    caso 2 nuovo, che vuole la push del genitore accanto a quella esclusa della segreteria (§4.7).
16. **Esecuzione in parallelo**: un test può cadere per un file altrui a metà modifica; le tre attese di §2.2 hanno il
    loro `grep`, e si controllano.
17. **Allo staff la push porta solo la coda e gli scarti** (T13, giro 1). Chi dello staff è anche genitore (oggi 0 su
    14, §0) non riceverebbe in push le notifiche da genitore, perché il filtro guarda il ruolo della riga `utenti`; un
    tipo nuovo per lo staff resta nella campanella finché non entra in `TIPI_PUSH_STAFF`. La cuoca, se arrivasse alla
    pagina (non è nel suo menu: `admin-nav-config.ts:62`, `:130`) e si iscrivesse, non riceverebbe niente in push.
    Allargare è la domanda 6; l'allerta allergie, che dal giro 2 non ha più un invio diretto, è il punto 20 e la
    domanda 7.
18. **La #164 in produzione la scrive DOC passo A**, non una PR di documenti (§4.1, T15): il suo piano ne prevedeva
    una, e alle 15:43 non c'era, col branch della 2c già aperto. Se la sessione principale la facesse lo stesso,
    toccherebbe le stesse righe (PRD `:78`, `:1791`, `:2119`; HANDOFF `:3`, `:14`, `:15`, `:17`, `:49`): passo A la
    salta frase per frase (`grep -c` prima di ognuna), e passo B lavora per stringa. Le frasi scritte alle 15:44 sono
    datate: «resta in attesa» su `36006773356` lo resterà fino al merge della 2c, che lo annulla, e lo registra il
    primo commit del branch dopo (§6.5 punto 5).
19. **Il test su PGlite adesso porta anche la #164**: SQL aggiunge casi nello stesso file di N1–N9. Un caso della 2c
    con due prese senza `dimenticaAccesso()` cade per la distanza, non per il codice della 2c (§4.2, §6.3), e un
    esecutore che lo «aggiustasse» toccando le funzioni della correzione romperebbe il 429 del 24/09: le migrazioni
    della #164 e le sue righe del test restano fuori dal diff (§6.2 punto 2).
20. **L'allerta allergie della mensa non va più in push dall'invio diretto** (giro 2, §2.3). Oggi l'effetto pratico è
    nullo: 0 dello staff iscritti alla push (§0), e ai docenti la riga arriva lo stesso dal dispatch, entro 5 minuti,
    sul web e nell'app; sul web perdono solo la prima copia immediata, a cui il dispatch aggiungeva il doppione. Ma alla
    cucina (cuoca, segreteria, admin, coordinator) l'allerta **non arriverà in push nemmeno quando qualcuno si
    iscriverà** dal pulsante della «Coda fatture»: resta nella campanella, perché il filtro di §4.7 la esclude. È una
    scelta di riservatezza (nome e allergeni di un minore sulla schermata di blocco), non una svista: domanda 7.

### 7.2 Domande al titolare (fino alla risposta valgono le scelte di §1.3)

1. **Sospensione, ripresa e pausa**: vanno agli admin e a chi ha fatture in attesa, meno chi ha premuto (S3). Il design
   diceva solo chi ha fatture in attesa (`contratto.md:455-456`). Va bene così? Da sapere prima di rispondere: il
   24/09, primo giorno vero, le pause per 429 sono state due, un'ora ciascuna per tutte le sedi, tutte e due da
   pulsanti ravvicinati (§0); la #164 chiude quel caso, e restano i 429 che toglie solo il cancello condiviso (§7.1
   punto 4). Con la 2c ogni pausa manda un avviso a ogni admin, uno per pausa.
2. **Il pulsante «Fattura»**: un avviso «Fattura inviata» per ogni clic (S3; il 24/09 sarebbero stati 13). Tenerlo, o
   avvisare i gruppi di una voce solo quando qualcosa va storto?
3. **Scarti SdI**: oggi arrivano a tutto lo staff della sede, quindi anche a chi ha accodato (21 su 21), ma una sede può
   spegnerli dalle Impostazioni (S4). Devono arrivare a chi ha emesso **anche** a interruttore spento? E il numero nel
   testo deve dire la serie («FPR 7/26» invece di «n. 7»)? Nessuna delle due cambia qualcosa oggi; la 2c le lascia
   fuori.
4. **Anomalie di sistema** (tetto non misurato, pausa persa, credenziali rifiutate, e dalla #164 l'ultimo accesso non
   letto): agli admin anche come notifica, o bastano log e `/api/health`?
5. **Il pannello Impostazioni** non elenca i sei tipi (non si spengono, S2). Vanno mostrati, come voci senza interruttore
   (R2A-1.8)?
6. **La push dello staff** (S1, T13): per ora porta solo gli avvisi della coda e gli scarti SdI. Deve portare anche le
   altre notifiche dello staff — circa 15 al giorno a testa, fra cui registrazioni dei genitori e credenziali col
   nome, iscrizioni, candidature (§0) — e quelle della cuoca, compresa l'allerta allergie col nome del bambino? E
   nell'app l'iscrizione deve partire da sola, come per genitori e docenti, invece che dal pulsante?
7. **Le allerte allergie alla cucina, in push** (§2.3, §7.1 punto 20): dalla 2c alla cuoca e al resto dello staff
   restano nella campanella, anche a push attiva. Devono arrivare in push? Se sì, come, visto che portano il nome del
   bambino e gli allergeni sulla schermata di blocco: per esempio un testo senza dati («Allergia nel menu di domani:
   apri la cucina») e i dettagli solo dentro l'app, oppure i dati pieni accettati per la sola cucina. Fino alla
   risposta vale la campanella.

---

## 8. Giro 1 del critico (24/09, esito CORREGGERE)

Ogni prova è stata rifatta prima di decidere (sole letture in produzione, copie in scratchpad, §0.1).

| # | Rilievo | Esito | Prova rifatta | Cosa cambia nel piano |
|---|---|---|---|---|
| 1 | La push allo staff porta **tutti** i tipi, e anche alla cuoca | **accolto**: la strada (b), in un'altra forma | `dispatch/route.ts:145-151` senza filtro; `admin/layout.tsx:28` e `active-role.ts:25`, `:49`; 3.267 notifiche allo staff in 30 giorni su 7 destinatari, 1.236 di tipi con un nome nel corpo, 0 iscritti su 14 (§0) | S1 e T13 riscritte coi numeri; compito **DISPATCH** (§4.7): allo staff solo `TIPI_AVVISO_CODA` e `fattura_scartata`, il ruolo nella stessa lettura, le escluse marcate e contate. PUSH senza layout né `NativePushAutoRegister`: il pulsante basta anche nell'app (`PushOptIn.tsx:24`, `:43-47`), e la cuoca non viene iscritta. §7.1 punti 15 e 17, domanda 6 |
| 2 | §0 superato dal primo uso vero; «0 voci» in HANDOFF; due sveglie ravvicinate → `429` → un'ora di pausa | **accolto** | `fatture_coda` e `fatture_coda_stato` alle 10:35; in `app_log` tre `giro-concluso` coi loro campi, due `signin` a 42 s, `voce-aruba_429` (§0) | §0 rimisurato, e rimisura obbligatoria prima del commit; in DOC passo A il paragrafo di `HANDOFF.md:16` riscritto, il rilievo (g) in HANDOFF §3 e la riga `0.` in cima al «Da fare», il PRD senza «0 voci»; §7.1 punto 4 e domanda 1 |
| 3 | `avvisi-non-disponibili` a `info` | **accolto** | `sospensione/route.ts:34-35`, `coda/azioni/route.ts:63`, `:115`: `warn` `coda-assente` | `warn` in §3.3, nel codice di §4.4 e nel caso 1 (con `info` il caso è rosso, misurato) |
| 4 | Doppio avviso raro fra i passi 1 e 2 della funzione | **accolto, con un'altra correzione** | la funzione è `VOLATILE` (il default) e gira in READ COMMITTED: ogni istruzione ha la sua fotografia; il 24/09 un secondo giro ha preso il lavoratore 0,3 s dopo il primo | **le fini prima degli errori**: la corsa dà la sequenza di sempre (errore, poi fine), senza SQL in più; scenari A–I identici nei due ordini; l'ordine controllato nel caso «guardie»; §4.2 e §7.1 punto 7 |
| 5 | SDI non è la consegna minima | **accolto**: via il compito SDI | `scope.ts:782-808`, `:53-78`; `destinatari.ts:204-282`; 21 su 21 ricontrollato; interruttore spento 0 su 4 | da 27 a 24 file (DISPATCH ne aggiunge 2), da 1446 a 1445 file di test; S4 riscritta, T12 vuota; la sync e `destinatari.ts` fuori dal diff (§6.2 punto 2); domanda 3 |
| 6 | «ripartono da sole alle 11:09» è impreciso | **accolto** | nucleo `:332-334`; `MINUTI_TICK_CODA` (`api.ts:35`): il primo tick dopo le 11:09:59 è alle 11:12 | «dopo le HH:MM»: `quando(…, 'dopo le')`, casi 2 e 8 di `avvisi-testi`; la frase vera del 24/09 stampata dal modulo |
| 7 | `admin-layout-shell` fuori dalla verifica di PUSH; il commento `:1293-1295` | **prima metà superata, seconda accolta** | `admin-layout-shell.test.ts:35-38`; `isolamento-sede-coverage.test.ts:1293-1295` | il layout non si tocca più (rilievo 1), e con lui i tre lock che lo leggono; ROTTE aggiorna anche il commento su `coda/giro:POST` |

Trovato rileggendo, fuori dai rilievi: DOC passo B dava R2A-1.8 (il catalogo delle notifiche obbligatorie) per
«sostituito» dalla 2c, che invece lo lascia fuori (S2), mentre lo stesso passo lo elenca fra ciò che resta. Ora dice
«non fatto».

### Rilievi del critico respinti

Nessuno. Tre proposte non sono adottate **nella forma suggerita**, e la ragione è questa:
- Rilievo 1, «il layout non monta `NativePushAutoRegister` per la cuoca»: il layout non lo monta per nessuno. Per
  escludere la sola cuoca il layout avrebbe dovuto sapere il ruolo attivo: `requireArea` restituisce `void`
  (`area-guard.ts:84-90`), e il `role` di `useSessionIdentity` viene da `localStorage` e può mancare
  (`use-session-identity.ts:43-57`). Il pulsante fa già la registrazione nativa.
- Rilievo 1, strada (b), «serve il ruolo del destinatario»: arriva nella stessa lettura (`utenti(role, ruolo)`), non
  da una seconda query, che sarebbe un ramo d'errore nuovo capace di fermare anche la push dei genitori, e che nel
  lock `isolamento-sede-coverage` vale `handler-senza-scope` (misurato, §5).
- Rilievo 4, «nel passo 2 segnare anche `avviso_errore_presa` e restituire quegli errori»: invertire i due passi
  toglie la sequenza sbagliata senza una scrittura né un'uscita in più della funzione, e lascia intatti i controlli
  negativi (le stringhe che colpiscono restano quelle).

---

## 9. Riallineo alla correzione dei 65 s (#164) — 24/09, 15:09–15:50

Chiesto dalla sessione principale dopo la correzione urgente (PR #164, branch `fix/coda-fatture-distanza-signin`,
testa `2bcb2734`). Durante il riallineo la #164 è andata in `main` (`52d8e7a7`, 15:36) e in produzione (15:37), e il
branch della 2c è stato aperto: le righe di §0 che ne parlano sono state rilette dopo (15:43–15:44). Ogni punto è
verificato sul codice (`git diff 02eb9836 2bcb2734`; `git diff 2bcb2734 52d8e7a7` vuoto), con sole letture in
produzione e prove in scratchpad (§0.1); nessun file del repo toccato, nessun `git` che cambi stato.

| # | Cosa cambia nel piano | Prova |
|---|---|---|
| 1 | **DOC passo A** (§4.1; §2.1, §2.2, T15, §6.5 punto 1) ridotto a ciò che la #164 non ha scritto: (a) tre frasi false di prima (il run `35920312716` «resta in attesa» in HANDOFF `:13` e nel PRD `:2231`; «data e numero li registra la PR di documenti» nel PRD `:2090`) e (b) la #164 in produzione (HANDOFF `:3`, `:14`, `:15`, `:17`, `:49`; PRD `:78`, `:1791`, un «Verificato» nuovo, `:2119`), coi fatti delle 15:44. Via la rimisura coi due segnaposto, il rilievo (g) e la riga `0.` del «Da fare», il segno «🔧 consegna 2c» sul punto 1 (lo mette passo B), la nota di memoria da portare a IN PRODUZIONE (lo dice già). Il piano entra nel repo col primo commit | PRD e HANDOFF letti a `52d8e7a7`: la #164 ha scritto la 2b in produzione (HANDOFF `:3`, `:14`, `:41`; PRD `:78`, `:1940`, `:2116-2120`), le prime fatture vere e i due 429 (HANDOFF `:17`; PRD `:1791-1936`), (g) chiuso (HANDOFF `:49`); `grep -c` = 1 su ogni sottostringa di §4.1; `gh run list`: `35920312716` annullato alle 04:38:09Z, `35956482220` alle 13:36:12Z, `36006773356` in attesa |
| 2 | La #164 in produzione la scrive passo A, non la PR di documenti che il suo piano prevedeva (T15, §7.1 punto 18); §6.2 punto 10 controlla con `gh run view` ogni run che PRD e HANDOFF dicono «in attesa»; §6.5 punto 1 dice cosa è già fatto (merge, deploy, verifica, branch) e cosa resta | `correzione-distanza-signin.md` §5.1 punto 5; alle 15:43 nessuna PR aperta e il branch della 2c già aperto da `main`; i fatti della #164 misurati alle 15:44 (§0), quindi nessun segnaposto |
| 3 | **SQL** (§4.2): `<T>` dopo `20260924103451`; il test carica nucleo, 2a, 2b, correzione e 2c; `dimenticaAccesso()` fra una presa e l'altra in A, B e G; i controlli negativi con la correzione sotto; le guardie sul modello di N8–N9, con `NOME_ACCESSI`; le righe del test rilette (`:3-12`, `:54-57`, `:278-294`, `:310-317`, `:380-398`, `:413-418`, `:822-842`, `:1068-1071`, `:1354-1360`, `:1461-1468`). Lo SQL non cambia di un byte | fase 1 della prova: senza `dimenticaAccesso()` A, B e G rossi, con tutto verde; la copia del test dà 88 verdi; tre rotture rosse (§0.1, §6.3) |
| 4 | Colonne di `fatture_coda_stato`: 9 fino al merge della #164, 10 in produzione da allora (misurato alle 15:44), 12 con la 2c; di `fatture_coda` 23 → 25 (§0) | `information_schema.columns`, in produzione e su PGlite |
| 5 | Citazioni riallineate (righe di `52d8e7a7`): `giro.ts` (`:129`, `:149`, `:153-161`, `:221`, `:253-257`, `:260-265`, `:274`, `:279-283`, `:280`, `:346-358`, `:363-374`, `:365`, `:384-388`, `:398`, `:439-452`, `:562-563`, `:600`); `giro.test.ts` (`:230-231`); `prendi` (ora `20260924103451_fatture_coda_distanza_accessi.sql:44`, `:69-71`, `:102`, `:120-124`); HANDOFF (`:13`, `:15`, `:22`, `:28`, `:53`, `:55`, `:84`); PRD (`:1791`, `:2090`, `:2231`); `nucleo.md` (`:151-156`, `:183-185`, `:219`); il test su PGlite (`:20-28`, `:350-399`). Le righe di §8 restano quelle di `02eb9836`: sono la storia del giro 1 | letture a `2bcb2734` e `52d8e7a7` (stesso albero) |
| 6 | **La 2c non tocca `giro.ts`**: resta vero, e ora vale anche per `giro.test.ts`, per le due funzioni che la #164 ridefinisce e per le sue righe del test (§2.4, §6.2 punto 2). `tsc` sulle copie di §4 contro l'albero della #164: 0 errori | `tsc -p` (§0.1) |
| 7 | **T6 e i tick**: la finestra della sync del giro è ora `:59–:05` e `:29–:35`, ma il cron resta `7,12,…,57`: nessun tick nella finestra, saltano ancora :02 e :32, «al più 10 minuti» resta; l'attesa di un tick finisce al minuto 58 o 28, fuori; i 280 s di `LIMITE_AVVISI_MS` restano giusti, perché l'attesa sta nel budget | `giro.ts:221`, `:346-358`; `api.ts:35`; `cron.job` |
| 8 | **§0**: la #164 (mergiata alle 15:36:06, deploy 15:37:13, verificata alle 15:44), i run (`36006773356` in attesa, `35956482220` annullato), le migrazioni (`20260924103451` applicata), la coda (23 voci, tutte emesse), il primo giorno vero coi due 429 e le due pause, `pgrst_ddl_watch` (alla 2c non serve il `NOTIFY pgrst` della #164), `fatture_emesse` 457, 0 su 14 dello staff iscritti alla push, l'albero (`feat/coda-fatture-notifiche-2c` = `main` = `52d8e7a7`) | `gh`, `git`, `app_log`, `fatture_coda`, `fatture_coda_stato`, `pg_event_trigger`, `pg_proc`, conteggi |
| 9 | §1.2: «La correzione delle sveglie ravvicinate» l'ha fatta la #164; fra le anomalie di sistema anche `accesso-non-letto`. §3.1: la seconda pausa e il tick delle 13:42 | come sopra |
| 10 | **Concorrenza** (§4.2, nota; §7.1 punto 7): l'esempio dei due giri a 0,3 s è di prima della #164; dopo, la corsa resta con la route della sospensione e col bidello di un giro partito accanto a un giro senza voci. L'ordine «fini prima degli errori» resta, e la guardia lo tiene | `giro.ts:346-358`; la rottura «ordine» rossa sulla copia |
| 11 | §7.1 punti 1, 3, 4 (le pause dopo la #164, i 13 clic del 24/09), 6, 13 e 14; punti nuovi 18 (la #164 in produzione la scrive passo A, non una PR di documenti) e 19 (`dimenticaAccesso()` e le righe della #164 nel test); §7.2 domande 1, 2 e 4 | — |

**Non cambia**: lo SQL (byte per byte il file del giro 1), `avvisi-testi.ts`, `avvisi.ts`, le route, il dispatch,
PUSH, i testi e i destinatari, i 24 file più il piano, i 1445 file di test attesi. La 2c non dipende dalla correzione
(la sua funzione, caricata senza, dà gli stessi fatti), ma il branch parte da un `main` che la contiene.
