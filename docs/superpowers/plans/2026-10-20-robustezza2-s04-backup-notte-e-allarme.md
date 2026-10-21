# Sessione 4 — Backup alle 02:23, secondo canale d'allarme, bucket, Vault, chiavi — piano di implementazione

> **Per chi esegue:** sotto-skill obbligatoria `superpowers:subagent-driven-development` (consigliata) oppure `superpowers:executing-plans`; i passi usano le caselle (`- [ ]`).

**Obiettivo:** il backup notturno parte alle 02:23 UTC dal Worker di Cloudflare e non più fra le 07:04 e le 09:35;
se non parte, un'email arriva anche quando GitHub tace; i quattro bucket che esistono solo in produzione e i sei
segreti del Vault diventano ricostruibili dai file del repository; le chiavi del backup escono dalla cartella dell'app.

**Architettura:** il Worker `kidville-monitor-esterno` riceve un secondo cron (`23 2 * * *`). A quell'ora lancia
`backup-notturno.yml` con `modalita=completo` e `origine=cloudflare`; se GitHub rifiuta, manda un'email con Resend
(la stessa `mandaEmail` del campanello, più l'intestazione `Idempotency-Key`). Lo `schedule` di GitHub resta come
riserva, con un job `guardia` che annulla il giro se un backup completo è già riuscito nelle ultime 20 ore. Il
campanello conta come automatici anche i giri «(da Cloudflare)». Una migrazione idempotente crea i quattro bucket
mancanti; runbook e `docs/cicd.md` passano dalla ricetta `ALTER DATABASE` (negata, `42501`) a `vault.create_secret`.

**Tecnologie:** Cloudflare Workers (`wrangler@4.148.0`, cron trigger in UTC) · GitHub Actions (`workflow_dispatch`,
`run-name`, `concurrency`, CLI `gh`) · script Node ESM `.mjs` senza dipendenze · API Resend (`Idempotency-Key`) ·
Supabase Postgres (`storage.buckets`, Vault, `app_log`) · Vitest (jsdom) · `tsc --noEmit` · ESLint.

**Specifica:** `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, §7, Sessione 4.

---

## Scelte e scostamenti dalla specifica

Sono decisioni prese leggendo il codice. Chi esegue le applica così; se una non regge, si ferma e lo scrive nella
colonna «Note» della riga 4 della tabella di stato della specifica.

1. **Funzione nuova `lanciaBackup`, non `suonaCampanello`.** `suonaCampanello` (`worker.mjs:65-90`) ripiega su un
   lancio **senza input** quando GitHub risponde 422 «unexpected inputs». Per il backup quel ripiego sarebbe un
   danno: senza `modalita=completo` il workflow fa un giro di **prova** (`default: prova`), cioè un backup finto con
   l'aria di quello vero. Quindi il backup ha una funzione sua, che non ripiega mai.
2. **«Workflow disabled»: si legge lo stato, non il testo dell'errore.** La specifica (§7, sessione 4) distingue i
   due casi: un workflow disattivato per inattività (`disabled_inactivity`) si riattiva con
   `PUT …/actions/workflows/{id}/enable` e si riprova; uno spento a mano (`disabled_manually`) resta spento, perché
   il workflow dichiara in testa che **si spegne** con `gh workflow disable backup-notturno.yml`
   (`backup-notturno.yml:48`) e un Worker che lo riaccendesse ogni notte toglierebbe l'unico interruttore. Il
   piano lo fa così: dopo un rifiuto, `lanciaBackup` chiede lo `state` del workflow e decide su quello; con
   `disabled_manually` non tocca niente e non manda email. Non dipende dal testo esatto dell'errore di GitHub, che
   da qui non si può verificare.
3. **La guardia delle 20 ore annulla il proprio giro invece di «uscire».** Un giro dello `schedule` che salta il
   backup e finisce `success` verrebbe contato dal campanello come backup fatto (`valutaBackup` guarda i successi):
   l'età del backup ringiovanirebbe fino a 7 ore senza nessuna copia nuova. Il job `guardia` fa
   `gh run cancel "$GITHUB_RUN_ID"` e il giro finisce `cancelled`. Per farlo gli serve `actions: write`, e
   soltanto a lui: il lock lo concede solo a quel job e solo per annullare sé stesso.
4. **La guardia vale solo per lo `schedule`.** Il lancio del Worker e i giri a mano non si fermano mai da soli.
   Resta un caso raro, accettato: se lo `schedule` arrivasse puntuale **prima** del Worker, quella notte i backup
   sarebbero due. Sulle 8 notti misurate non è mai successo (partenze fra 07:04 e 09:35).
5. **Il secondo canale scatta in due casi.** Come dice la specifica: (a) il lancio del backup è fallito, al più
   un'email per notte; (b) il campanello non è partito mentre il sito è giù, al più un'email per ora (oggi c'è solo
   il `console.error` di `worker.mjs:110`, che è il rifiuto del **campanello**, non del backup). Un battito
   rifiutato col sito sano non manda email: lo vede già `monitor-esterno-muto`, e un token scaduto lo dice comunque
   l'email delle 02:23.
6. **`Idempotency-Key`.** Come dice la specifica, `allarme.mjs` oggi non la manda (`allarme.mjs:126-150`): diventa
   un parametro facoltativo di `mandaEmail`, usato solo dal Worker; il campanello resta com'è. A una stessa
   chiave con un messaggio diverso Resend risponde `409 invalid_idempotent_request`
   (`src/lib/email/send.ts:97-110`): il testo dell'email è quindi lo stesso per tutta la durata della chiave.
7. **I bucket da dichiarare sono quattro.** Come dice la specifica, le migrazioni **creano** con un `insert` 17
   bucket su 21. Mancano `avvisi_allegati`, `task_allegati` e `form_attachments`, che le migrazioni si limitano ad
   aggiornare con `update` (su un database nuovo un `update` non trova la riga e non fa niente), e
   `registro-allegati`, nato da una `createBucket` della route (`src/app/api/primaria/allegati/route.ts:193-203`).
   La migrazione usa `on conflict (id) do nothing` e mette un bucket per istruzione, perché
   `valoriInsert` del lock (`bucket-storage-dichiarati.test.ts:130-148`) legge solo la prima tupla.
8. **La ricetta sbagliata del Vault sta in `docs/cicd.md`, non nel runbook** (lo dice anche la specifica). Il
   passo 6 dello scenario E (`runbook-ripristino.md:229` al 20/10) dice soltanto «i nomi sono nel manifest». Il
   manifest però elenca `pg_db_role_setting` (`scripts/backup/dump-cifrato.sh:114-116`), che con i segreti nel Vault
   è vuoto. La ricetta `ALTER DATABASE` negata (`42501`) sta in `docs/cicd.md:360-376`. Si correggono tutti e due,
   e un lock lega i nomi letti dalle migrazioni (`cron_config('<nome>')`) a quelli scritti nel runbook.
9. **Chiavi.** La riga `/KIDVILLE-CHIAVI-BACKUP/` di `.gitignore` e il lock che la sorveglia
   (`backup-notturno-sicuro.test.ts:423-471`) **restano**, come rete: la cartella potrebbe tornare dentro l'app,
   o in un worktree. Cambiano solo i commenti, che oggi dicono che la cartella sta dentro l'app.
10. **Fuori perimetro, solo annotato:** il codice usa un bucket `certificati-competenze`
    (`src/lib/competenze/certificato-store.ts:9`, `src/app/api/admin/protocolli/da-documento/route.ts:25`) che nella
    fotografia della produzione non esiste. Questa sessione non lo crea.

---

## Mappa dei file

| File | Ruolo |
|---|---|
| `monitor-esterno/worker.mjs:1-126` | **Modifica.** Testata 20-25 (tre segreti, il backup); costanti dopo la 37; `intestazioniGitHub` usata da `suonaCampanello` (68-79); nuove `lanciaBackup`, `chiaveIdempotenza`, `avvisaPerEmail`, `giroBackup`, `lavoroDelCron`; `giro` (92-113) col secondo canale; `scheduled` (119-123) che instrada per cron. |
| `monitor-esterno/wrangler.toml:1-14` | **Modifica.** Secondo cron `23 2 * * *` (riga 11) e commento sui segreti (righe 1-3). |
| `scripts/campanello/allarme.mjs:93-99, 121-141` | **Modifica.** `giriBackupRiusciti` senza filtro `event=schedule`, `per_page=30`; `mandaEmail` con `chiaveIdempotenza` facoltativa. |
| `scripts/campanello/valuta.mjs:21-22, 102-125` | **Modifica.** `TITOLO_BACKUP_DA_FUORI`, `eGiroBackupAutomatico`; `valutaBackup` filtra con lei. |
| `scripts/campanello/campanello.mjs:30, 97` | **Modifica.** Import e riga di log del backup (riusciti / automatici). |
| `scripts/backup/guardia-notte.mjs` | **Crea.** Decisione pura delle 20 ore + lettura dei giri, fail-open. |
| `.github/workflows/backup-notturno.yml:23-27, 48, 50-67, 97-100` | **Modifica.** Testata, `run-name`, input `origine`, job `guardia`, `backup` con `needs: guardia` e `!cancelled()`. `ESCLUDI_BUCKET` (riga 87) **non** cambia. |
| `supabase/migrations/<V>_bucket_dichiarati_dalla_produzione.sql` | **Crea.** Quattro `insert … on conflict (id) do nothing` e una riga in `app_log`. `<V>` = `date -u +%Y%m%d%H%M%S` al momento della creazione. |
| `__tests__/lib/monitor-esterno.test.ts:1-184` | **Modifica.** `fetchFinto` registra il verbo HTTP e `Idempotency-Key`; prove del backup, del secondo canale, di `scheduled`, di `wrangler.toml`, di `.dev.vars`. |
| `__tests__/lib/backup-guardia-notte.test.ts` | **Crea.** Guardia con numeri letterali; coerenza dei titoli fra workflow, guardia e campanello. |
| `__tests__/lib/campanello-valuta.test.ts:1-14, 144-185` | **Modifica.** I giri del backup portano `event`; prove dei giri «(da Cloudflare)» e di quelli a mano. |
| `__tests__/lib/campanello-esegui.test.ts:59-62, 410-419` | **Modifica.** Fixture con `event: 'schedule'`; URL della lettura dei giri. |
| `__tests__/architecture/backup-notturno-sicuro.test.ts:1-35, 176-238, 300-313, 346-398, 423-471` | **Modifica.** Regole e prove gemelle della guardia; `run-name` ammesso; `persist-credentials` per ogni checkout; lock dei nomi del Vault nel runbook; commento della cartella delle chiavi. |
| `__tests__/architecture/bucket-storage-dichiarati.test.ts:64-75, 282-293, 316-341, 548-571, 1085-1102, 1204-1218` | **Modifica.** `bucketCreatiInMigrazione` e due prove; `IN_ATTESA_DI_UN_LIMITE` vuota; `visibilitaDichiarata` con elenco di istruzioni facoltativo; commenti. |
| `.gitignore:42-46` | **Modifica.** Commento della cartella delle chiavi; `.dev.vars*` e `.wrangler/`. |
| `docs/runbook-ripristino.md:37-55, 179, 229, 238` (righe del 20/10) | **Modifica.** Vault al posto del manifest; nuovo posto delle chiavi con le due caselle; scenario B e passo 6 dello scenario E; lista di controllo. La sessione 3 cambia gli scenari A0 e A0-bis dello stesso file e sposta le righe dopo la 80: ogni sostituzione si fa **per contenuto**, col testo da cercare scritto nel Compito 10, Passo 3. |
| `docs/cicd.md:158-211, 249-294, 305-311, 337, 360-376` | **Modifica.** Backup lanciato dal Worker e guardia; segreti e prova del Worker; quali giri contano; ricetta del Vault. |
| `PRD REGISTRO ELETTRONICO.md:1` | **Modifica.** Voce di changelog in cima. |
| `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` (riga 4 della tabella di stato: la 28 al 20/10, si trova con `grep`, mai col numero) | **Modifica** (in revisione). Nella propria PR: Stato «in revisione», numero della PR, percorso del piano (Rilascio, passo 4). |
| `__tests__/fixtures/migrazioni-applicate-snapshot.json`, la riga di stato e la voce del PRD della sessione rilasciata per ultima, e ciò che elenca il suo «Per la sessione dopo» | **Modifica** nel primo commit (Compito 1, Passo 4: chiusura della precedente). Si salta solo se nessuna sessione `robustezza2/` è ancora rilasciata. |

Letti e **non** toccati, per riferimento: `src/lib/allegati/mime.ts:46-61` (`MIME_ALLEGATI_AMMESSI`,
`DIMENSIONE_MAX_ALLEGATO_BYTE`); `src/lib/primaria/allegati-registro.ts:30-32`;
`src/app/api/primaria/allegati/route.ts:193-203`; le migrazioni `20260731192108_allegati_avvisi_task_bucket_privati.sql`,
`20260801081531_allegati_avvisi_task_mime.sql:60-69`, `20260802191025_form_attachments_tipi_e_limite.sql:56-65`,
`20260916190000_video_jobs.sql:364-372`, `20260712220000_cron_config_vault.sql`,
`20260812194614_bonifica_registro_modifiche_hard_delete.sql:60-105` (modello del log),
`20261019223123_battiti_app_log_che_contano.sql:1-40` (modello di testata e ROLLBACK);
`__tests__/architecture/allegati-mime-dichiarati.test.ts`, `upload-pubblico-con-tetto.test.ts:79-115`,
`migrazioni-complete.test.ts:241-300`, `soglia-fotografia.ts:281-362`, `offline-html-nativo.test.ts:390-395`;
`scripts/backup/dump-cifrato.sh:66, 114-116`.

---

## Passo 0 — misura prima

Si fa **dopo** il controllo dei prerequisiti (Compito 1, Passo 1) e prima di scrivere codice.
Tutto in **sola lettura**. Sul database di produzione solo `SELECT`; mai le colonne `secret` o `decrypted_secret`
del Vault; mai righe di tabelle con dati di famiglie. I numeri vanno nella sezione «Prima» della descrizione della
PR e nella voce del PRD, con data e ora UTC. Dentro ci vanno conteggi, orari, id di bucket, booleani e tipi MIME:
mai nomi, mai indirizzi, mai valori di segreti.

- [ ] **0.1 Iscrizioni** (regola §5 della specifica: si conta, non si copia).
  ```sql
  SELECT now() AT TIME ZONE 'utc' AS alle_utc, count(*) FROM enrollment_submissions;
  ```
  Atteso: un intero, che al 20/10 era 733 (12:32:54 UTC). Si scrive quello letto oggi.

- [ ] **0.2 Partenze degli ultimi 14 giri del backup.**
  ```bash
  gh run list -w backup-notturno.yml -L 14 --json createdAt,updatedAt,event,conclusion,displayTitle \
    --jq '.[] | [.createdAt, .updatedAt, .event, .conclusion, .displayTitle] | @tsv'
  ```
  Atteso: giri `schedule` partiti fra le 07:00 e le 09:40 UTC (rapporto del 20/10: 07:04–09:35 su 8 notti), il
  titolo uguale al nome del workflow (oggi non c'è un `run-name`). Si scrive la tabella delle 14 partenze.

- [ ] **0.3 p95 server→DB nella punta 07:55–08:05 UTC** dell'ultimo giorno feriale, con la query 2 bis di
  `docs/roadmap-robustezza.md:488-497` sui log di Supabase (`query_logs`, la stessa via del rapporto),
  `iso_timestamp_start = <giorno>T07:55:00Z`, `iso_timestamp_end = <giorno>T08:05:00Z`:
  ```sql
  select toString(log_attributes['request.cf.colo']) as colo, count(*) as n,
    round(quantile(0.5)(toFloat64OrZero(toString(log_attributes['response.origin_time']))),0) as p50,
    round(quantile(0.95)(toFloat64OrZero(toString(log_attributes['response.origin_time']))),0) as p95
  from logs where source='edge_logs'
    and toString(log_attributes['request.headers.x_client_info']) like '%createServerClient'
  group by colo order by n desc limit 8
  ```
  Atteso: riga DUB con un p95 dell'ordine di quelli del 20/10 (232 ms) e del 19/10 (315 ms). Si scrive il numero
  di oggi con la finestra.

- [ ] **0.4 Le impostazioni dei quattro bucket** che la migrazione dichiarerà:
  ```sql
  select id, public, file_size_limit, allowed_mime_types
    from storage.buckets
   where id in ('avvisi_allegati', 'form_attachments', 'registro-allegati', 'task_allegati')
   order by id;
  ```
  Atteso (sono i valori che il codice e le migrazioni dichiarano già):

  | id | public | file_size_limit | allowed_mime_types |
  |---|---|---|---|
  | `avvisi_allegati` | false | 10485760 | jpeg, jpg, png, gif, webp, heic, pdf, msword, docx (i nove di `MIME_ALLEGATI_AMMESSI`) |
  | `form_attachments` | false | 8388608 | pdf, jpeg, png, webp, heic |
  | `registro-allegati` | false | 10485760 | pdf, jpeg, jpg, png, webp, gif |
  | `task_allegati` | false | 10485760 | come `avvisi_allegati` |

  Se un valore è diverso, nella migrazione va **quello della produzione**. Se però per `avvisi_allegati` o
  `task_allegati` la produzione è diversa da `src/lib/allegati/mime.ts`, il lock `allegati-mime-dichiarati`
  diventerebbe rosso: ci si **ferma** e lo si scrive nella colonna «Note» della riga 4 della specifica. Non si
  allinea il codice dentro questa sessione.

- [ ] **0.5 Elenco dei bucket contro la fotografia.**
  ```sql
  select id from storage.buckets order by id;
  ```
  Atteso: gli stessi 21 id di `__tests__/fixtures/bucket-storage-snapshot.json`. Se ce n'è uno in più, si rigenera
  la fotografia (`node __tests__/fixtures/bucket-storage-fotografia.mjs --sql`, si esegue la query stampata, poi
  `node __tests__/fixtures/bucket-storage-fotografia.mjs < "$TMPDIR/bucket.json"`), lo si classifica in `RISERVATI`
  e lo si aggiunge alla migrazione con le sue impostazioni lette come al punto 0.4.

- [ ] **0.6 I nomi dei segreti del Vault**, senza i valori:
  ```sql
  select name from vault.secrets order by name;
  ```
  Atteso: sei righe, `app.cron_secret`, `app.fattura_sync_url`, `app.mensa_allergie_url`,
  `app.notifiche_promemoria_url`, `app.push_dispatch_url`, `app.retention_iscrizioni_url`. Se ce n'è un settimo,
  va anche lui nel runbook (Compito 10).

- [ ] **0.7 Impostazioni del database** (perché il manifest non basta):
  ```sql
  select count(*) from pg_db_role_setting;
  ```
  Atteso: 0 righe con `app.*`, perché `ALTER DATABASE … SET` è negato. Si scrive solo il conteggio.

- [ ] **0.8 Stato del workflow e del Worker** (sola lettura):
  ```bash
  gh api 'repos/{owner}/{repo}/actions/workflows/backup-notturno.yml' --jq .state
  cd /Users/lerri/kidville-web/monitor-esterno && npx wrangler@4.148.0 deployments list | head -n 20
  cd /Users/lerri/kidville-web/monitor-esterno && npx wrangler@4.148.0 secret list
  ```
  Atteso: `active`; l'id della versione del Worker oggi in produzione (serve al ritorno indietro); un solo segreto,
  `GITHUB_TOKEN_CAMPANELLO`.

---

## Compiti

### Compito 1: prerequisiti, worktree, dipendenze, chiusura della precedente, base verde

**File:**
- Crea: il worktree `/Users/lerri/kidville-web-s04` sul branch `robustezza2/s04-backup-notte-e-allarme`
- Modifica (Passo 4, solo se una sessione `robustezza2/` è già rilasciata): `__tests__/fixtures/migrazioni-applicate-snapshot.json`,
  la riga di stato e la voce del PRD della sessione rilasciata per ultima, e i file che elenca il suo «Per la sessione dopo»

- [ ] **Passo 1: i prerequisiti (§5 della specifica, «Apertura di una sessione: i prerequisiti»).** Si fa per primo,
  prima del Passo 0. La riga 4 della tabella di stato non ha sessioni nella colonna «Dopo»: resta un solo controllo,
  nessuna PR `robustezza2/` aperta, salvo i rami `-esito`. Non si legge lo «Stato» della tabella.
  ```bash
  gh pr list --repo erricoluigi17/kidville-web --state open --search "head:robustezza2/" --json number,headRefName --jq '.[] | select(.headRefName | endswith("-esito") | not) | "\(.number) \(.headRefName)"'
  ```
  Atteso: nessuna riga. Se esce anche una sola riga, **fermati**: una sessione alla volta, e quella PR va chiusa o
  mergiata prima.

- [ ] **Passo 2: worktree nuovo da `origin/main`.** Mai `git checkout` nel checkout principale: altre sessioni lo usano.
  Il ramo si chiama come il piano senza la data: `robustezza2/s04-backup-notte-e-allarme`.
  ```bash
  git -C /Users/lerri/kidville-web fetch origin
  git -C /Users/lerri/kidville-web worktree add /Users/lerri/kidville-web-s04 -b robustezza2/s04-backup-notte-e-allarme origin/main
  ```
  Atteso: `Preparing worktree (new branch 'robustezza2/s04-backup-notte-e-allarme')`.

- [ ] **Passo 3: `.env.local` e dipendenze.** Un worktree nuovo nasce senza `.env.local`. Lo copia il titolare,
  e chi esegue non lo apre:
  `cp /Users/lerri/kidville-web/.env.local /Users/lerri/kidville-web-s04/.env.local`. Poi:
  ```bash
  cd /Users/lerri/kidville-web-s04 && npm ci
  ```
  Atteso: `added N packages`, uscita 0.

- [ ] **Passo 4: la chiusura della sessione rilasciata per ultima (primo commit, prima di ogni codice).** È la
  regola §5 della specifica, «Apertura di una sessione: la chiusura della precedente». Va fatta **prima** di scrivere
  la migrazione di questa sessione: la fotografia delle migrazioni rigenerata qui deve essere più vecchia della
  version della nuova migrazione, altrimenti `migrazioni-complete` la segnalerebbe come «fotografia scaduta».
  1. Quale sessione è stata rilasciata per ultima:
     ```bash
     gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/" --limit 50 --json number,headRefName,mergedAt --jq 'map(select(.headRefName | endswith("-esito") | not)) | sort_by(.mergedAt) | last | "\(.number) \(.headRefName)"'
     ```
     Atteso: una riga `<numero> robustezza2/sNN-<nome>`. Se stampa `null null`, nessuna sessione `robustezza2/` è
     ancora rilasciata: il Passo 4 si salta e si va al Passo 5.
  2. Il suo piano è `docs/superpowers/plans/2026-10-20-robustezza2-<nome del ramo senza «robustezza2/»>.md` (nel
     worktree, che viene da `main`). Si legge la sua sezione `## Per la sessione dopo` **per intero** e si esegue
     tutto ciò che elenca: fotografie, voci da togliere da `MIGRAZIONI_ATTESE_AL_MERGE` e dalle altre liste, riga di
     stato a «in produzione» col commit di `main`, Stato della sua voce nel PRD, misure «dopo» già mature. Non si
     indovina niente che quella sezione non dica. Il commit di `main` e la data del merge:
     ```bash
     gh pr view <numero> --repo erricoluigi17/kidville-web --json mergeCommit,mergedAt --jq '"\(.mergeCommit.oid) \(.mergedAt)"'
     ```
  3. Se quella PR aveva migrazioni, la fotografia delle migrazioni si rigenera **sempre**, anche se la sezione se ne
     dimenticasse (una volta sola: se il punto 2 l'ha già rigenerata, questo punto si salta):
     ```bash
     gh pr view <numero> --repo erricoluigi17/kidville-web --json files --jq '.files[].path' | grep '^supabase/migrations/'
     ```
     Se stampa almeno un file:
     ```bash
     cd /Users/lerri/kidville-web-s04 && node __tests__/fixtures/migrazioni-fotografia.mjs --sql
     # la query stampata si esegue in produzione con `execute_sql`, SOLA LETTURA;
     # la risposta JSON, così com'è, va in "$TMPDIR/migrazioni.json"
     node __tests__/fixtures/migrazioni-fotografia.mjs < "$TMPDIR/migrazioni.json"
     CI=1 npx vitest run __tests__/architecture/migrazioni-complete.test.ts
     ```
     Atteso: la riga di riepilogo dello script e `Test Files  1 passed (1)`.
  4. Tutti i lock delle fotografie:
     ```bash
     cd /Users/lerri/kidville-web-s04 && CI=1 npx vitest run __tests__/architecture
     ```
     Atteso: verde. Se una fotografia che la sezione non nomina è rossa (`indici-unici`, `fk-utenti`, `pg-policies`,
     `fk-scuola-id`, `candidature-schema`, `bucket-storage`), si rigenera con la ricetta scritta nel suo messaggio
     d'errore (query in sola lettura) e lo si scrive nella voce del PRD di questa sessione: è una dimenticanza del
     piano precedente, non un guasto.
  5. Commit, con i soli file cambiati da questo passo (`git status --short` li elenca):
     ```bash
     cd /Users/lerri/kidville-web-s04 && git status --short
     git add <i file elencati da git status>
     git commit -m "Robustezza 2, sessione 4 · chiusura della sessione rilasciata per ultima: fotografie, stato e PRD" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
     ```

- [ ] **Passo 5: base verde sui file che questa sessione tocca.** `CI=1` serve perché in un worktree nuovo gli
  artefatti di `cap sync` mancano, e il lock `offline-html-nativo` (`offline-html-nativo.test.ts:390-395`) senza
  `CI` è rosso per quella ragione, non per un guasto.
  ```bash
  cd /Users/lerri/kidville-web-s04 && CI=1 npx vitest run \
    __tests__/lib/monitor-esterno.test.ts __tests__/lib/campanello-valuta.test.ts __tests__/lib/campanello-esegui.test.ts \
    __tests__/architecture/backup-notturno-sicuro.test.ts __tests__/architecture/bucket-storage-dichiarati.test.ts \
    __tests__/architecture/allegati-mime-dichiarati.test.ts __tests__/architecture/upload-pubblico-con-tetto.test.ts \
    __tests__/architecture/migrazioni-complete.test.ts
  ```
  Atteso: `Test Files  8 passed (8)`.

### Compito 2: `mandaEmail` con la chiave d'idempotenza di Resend

**File:**
- Modifica: `scripts/campanello/allarme.mjs:121-141`
- Test: `__tests__/lib/monitor-esterno.test.ts:14, 25-39, 46`

- [ ] **Passo 1: il `fetch` finto registra il verbo HTTP e chiave, e la prova rossa.** In `__tests__/lib/monitor-esterno.test.ts`
  sostituisci la riga 14 con:
  ```ts
  import { TITOLO_DA_FUORI, mandaEmail } from '../../scripts/campanello/allarme.mjs'
  ```
  Sostituisci `fetchFinto` (righe 25-39) con:
  ```ts
  function fetchFinto(per: Record<string, Risposta[]>) {
      const chiamate: { url: string; verbo?: string; corpo?: string; auth?: string; idem?: string }[] = []
      const indice: Record<string, number> = {}
      const impl = vi.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
          chiamate.push({
              url,
              verbo: init?.method,
              corpo: init?.body,
              auth: init?.headers?.Authorization,
              idem: init?.headers?.['Idempotency-Key'],
          })
          const seq = per[url]
          if (!seq) throw new Error(`fetch finto: URL non previsto ${url}`)
          const i = Math.min(indice[url] ?? 0, seq.length - 1)
          indice[url] = (indice[url] ?? 0) + 1
          const r = seq[i]
          if (r instanceof Error) throw r
          return { status: r.status, text: async () => r.testo ?? '' }
      })
      return { impl: impl as unknown as typeof fetch, chiamate, a: (u: string) => chiamate.filter((c) => c.url === u) }
  }
  ```
  Subito dopo `const SUL_BATTITO = …` (riga 46) aggiungi:
  ```ts
  const RESEND = 'https://api.resend.com/emails'
  const ACCETTATA = { status: 200, testo: '{"id":"e1"}' }
  type Segreti = { chiaveResend?: string; destinatari?: string }
  const SEGRETI: Segreti = { chiaveResend: 're_prova', destinatari: 'a@esempio.test,b@esempio.test' }
  ```
  In fondo al file aggiungi:
  ```ts
  describe('mandaEmail e la chiave di Resend', () => {
      const base = {
          chiaveResend: 're_prova',
          destinatari: 'a@esempio.test',
          oggetto: 'o',
          introHtml: 'i',
          link: 'https://esempio.test/giri',
          quando: 'q',
      }

      it('con la chiave manda Idempotency-Key; senza chiave non la manda (il campanello resta com\'è)', async () => {
          const f = fetchFinto({ [RESEND]: [ACCETTATA] })

          await mandaEmail({ ...base, chiaveIdempotenza: 'kidville-backup-non-partito-2026-10-21', fetchImpl: f.impl })
          await mandaEmail({ ...base, fetchImpl: f.impl })

          expect(f.a(RESEND).map((c) => c.idem)).toEqual(['kidville-backup-non-partito-2026-10-21', undefined])
      })
  })
  ```

- [ ] **Passo 2: rosso.**
  ```bash
  CI=1 npx vitest run __tests__/lib/monitor-esterno.test.ts -t "chiave di Resend"
  ```
  Atteso: FAIL, `expected [ undefined, undefined ] to deeply equal [ 'kidville-backup-non-partito-2026-10-21', undefined ]`.

- [ ] **Passo 3: codice.** In `scripts/campanello/allarme.mjs` sostituisci il commento e la firma (righe 121-126):
  ```js
  /**
   * L'email di allarme via Resend. NON lancia sul rifiuto del provider: restituisce `{ ok, stato, corpo }`
   * perché chi chiama deve poter far fallire il giro DOPO aver aperto la segnalazione, non prima.
   * Configurazione mancante = `ok: false` con la ragione (mai una nota a piè di pagina).
   * `chiaveIdempotenza` (facoltativa): l'intestazione `Idempotency-Key`. Per 24 ore la stessa chiave non
   * rispedisce, e Resend risponde come la prima volta, con lo stesso id. SOLO codici e date, mai un indirizzo.
   * Dentro una chiave il messaggio non deve cambiare: a una stessa chiave con un testo diverso Resend
   * risponde 409 `invalid_idempotent_request`.
   */
  export async function mandaEmail({ chiaveResend, destinatari, oggetto, introHtml, link, quando, chiaveIdempotenza = '', fetchImpl = fetch }) {
  ```
  e la riga delle intestazioni (riga 141) con:
  ```js
              headers: {
                  Authorization: `Bearer ${chiaveResend}`,
                  'Content-Type': 'application/json',
                  ...(chiaveIdempotenza ? { 'Idempotency-Key': chiaveIdempotenza } : {}),
              },
  ```

- [ ] **Passo 4: verde, campanello compreso.**
  ```bash
  CI=1 npx vitest run __tests__/lib/monitor-esterno.test.ts __tests__/lib/campanello-esegui.test.ts
  ```
  Atteso: `Test Files  2 passed (2)`.

- [ ] **Passo 5: commit.**
  ```bash
  git add scripts/campanello/allarme.mjs __tests__/lib/monitor-esterno.test.ts
  git commit -m "Robustezza 2, sessione 4: mandaEmail accetta la chiave d'idempotenza di Resend" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Compito 3: il Worker lancia il backup e, se non parte, manda l'email

**File:**
- Modifica: `monitor-esterno/worker.mjs:26-37, 60-90` (import, costanti, intestazioni) e aggiunte prima di `function attendi` (riga 115)
- Test: `__tests__/lib/monitor-esterno.test.ts`

- [ ] **Passo 1: prove rosse.** Nell'import da `../../monitor-esterno/worker.mjs` (righe 4-13) aggiungi
  `LINK_GIRI_BACKUP`, `WORKFLOW_BACKUP`, `chiaveIdempotenza` e `giroBackup`:
  ```ts
  import {
      LINK_GIRI_BACKUP,
      MINUTI_BATTITO,
      ORIGINE,
      REPO,
      URL_VIVO,
      WORKFLOW,
      WORKFLOW_BACKUP,
      chiaveIdempotenza,
      giro,
      giroBackup,
      leggiVivo,
      suonaCampanello,
  } from '../../monitor-esterno/worker.mjs'
  ```
  Dopo le costanti aggiunte nel Compito 2 aggiungi:
  ```ts
  const WF_BACKUP = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_BACKUP}`
  const DISPATCH_BACKUP = `${WF_BACKUP}/dispatches`
  const ABILITA_BACKUP = `${WF_BACKUP}/enable`
  const NOTTE = new Date('2026-10-21T02:23:00Z')
  const TOKEN = 'ghtok-di-prova'
  const SPENTO = { status: 422, testo: '{"message":"Cannot trigger a \'workflow_dispatch\' on a disabled workflow"}' }
  const CREDENZIALI = { status: 401, testo: '{"message":"Bad credentials"}' }
  /** Il mittente del campanello, letto dal suo sorgente: il Worker deve usare lo stesso. */
  const MITTENTE_CAMPANELLO = /const MITTENTE = '([^']+)'/.exec(
      readFileSync(join(process.cwd(), 'scripts/campanello/allarme.mjs'), 'utf8'),
  )?.[1]

  async function unGiroBackup(f: ReturnType<typeof fetchFinto>, token = TOKEN, segreti: Segreti = SEGRETI) {
      const log = vi.fn()
      const errore = vi.spyOn(console, 'error').mockImplementation(() => {})
      const esito = await giroBackup({ quando: NOTTE, token, segreti, fetchImpl: f.impl, log })
      const righeErrore = errore.mock.calls.map((c) => String(c[0]))
      errore.mockRestore()
      return { esito, righe: log.mock.calls.map((c) => String(c[0])), righeErrore }
  }
  ```
  In fondo al file aggiungi:
  ```ts
  describe('il backup delle 02:23 (giroBackup)', () => {
      it('lancia backup-notturno.yml su main con modalita=completo e origine=cloudflare, e lo scrive', async () => {
          const f = fetchFinto({ [DISPATCH_BACKUP]: [PARTITO] })

          const { esito, righe, righeErrore } = await unGiroBackup(f)

          expect(esito.lancio).toEqual({ ok: true, esito: 'partito', http: 204, corpo: '' })
          expect(JSON.parse(f.a(DISPATCH_BACKUP)[0].corpo!)).toEqual({
              ref: 'main',
              inputs: { modalita: 'completo', origine: 'cloudflare' },
          })
          expect(f.a(DISPATCH_BACKUP)[0].verbo).toBe('POST')
          expect(f.a(DISPATCH_BACKUP)[0].auth).toBe(`Bearer ${TOKEN}`)
          expect(righe.join(' ')).toContain('monitor-backup: esito=partito')
          expect(righeErrore).toEqual([])
          expect(f.a(RESEND)).toHaveLength(0)
      })

      it('workflow spento da GitHub per inattività: lo riattiva e riprova UNA volta, senza email', async () => {
          const f = fetchFinto({
              [DISPATCH_BACKUP]: [SPENTO, PARTITO],
              [WF_BACKUP]: [{ status: 200, testo: '{"id":7,"state":"disabled_inactivity"}' }],
              [ABILITA_BACKUP]: [{ status: 204 }],
          })

          const { esito, righe } = await unGiroBackup(f)

          expect(esito.lancio.esito).toBe('riattivato-e-partito')
          expect(f.a(ABILITA_BACKUP).map((c) => c.verbo)).toEqual(['PUT'])
          expect(f.a(DISPATCH_BACKUP)).toHaveLength(2)
          expect(righe.join(' ')).toContain('esito=riattivato-e-partito')
          expect(f.a(RESEND)).toHaveLength(0)
      })

      it('workflow spento A MANO: NON lo riaccende, non manda email, lo scrive', async () => {
          const f = fetchFinto({
              [DISPATCH_BACKUP]: [SPENTO],
              [WF_BACKUP]: [{ status: 200, testo: '{"id":7,"state":"disabled_manually"}' }],
          })

          const { esito, righe } = await unGiroBackup(f)

          expect(esito.lancio.esito).toBe('spento-a-mano')
          expect(f.a(ABILITA_BACKUP)).toHaveLength(0)
          expect(f.a(RESEND)).toHaveLength(0)
          expect(righe.join(' ')).toContain('esito=spento-a-mano')
      })

      it('GitHub rifiuta (401): console.error col corpo, email con la chiave della notte e il mittente del campanello', async () => {
          const f = fetchFinto({ [DISPATCH_BACKUP]: [CREDENZIALI], [WF_BACKUP]: [CREDENZIALI], [RESEND]: [ACCETTATA] })

          const { esito, righe, righeErrore } = await unGiroBackup(f)

          expect(esito.lancio.esito).toBe('fallito')
          expect(righeErrore.join(' ')).toMatch(/monitor-backup: esito=fallito.*401.*Bad credentials/)
          expect(righeErrore.join(' ')).not.toContain(TOKEN)
          const [email] = f.a(RESEND)
          expect(email.idem).toBe('kidville-backup-non-partito-2026-10-21')
          expect(email.auth).toBe('Bearer re_prova')
          const corpo = JSON.parse(email.corpo!)
          expect(MITTENTE_CAMPANELLO).toBeTruthy()
          expect(corpo.from).toBe(MITTENTE_CAMPANELLO)
          expect(corpo.subject).toBe('Backup notturno NON partito')
          expect(corpo.to).toEqual(['a@esempio.test', 'b@esempio.test'])
          expect(corpo.html).toContain('Bad credentials')
          expect(corpo.html).toContain(LINK_GIRI_BACKUP)
          expect(corpo.html).not.toContain(TOKEN)
          expect(righe.join(' ')).toContain('monitor-email: esito=accettata chiave=kidville-backup-non-partito-2026-10-21')
      })

      it('422 «unexpected inputs» (workflow su main senza `origine`): NON riprova senza input, e avvisa', async () => {
          const f = fetchFinto({
              [DISPATCH_BACKUP]: [{ status: 422, testo: '{"message":"Unexpected inputs provided: [\\"origine\\"]"}' }],
              [WF_BACKUP]: [{ status: 200, testo: '{"id":7,"state":"active"}' }],
              [RESEND]: [ACCETTATA],
          })

          const { esito } = await unGiroBackup(f)

          expect(esito.lancio.esito).toBe('fallito')
          expect(f.a(DISPATCH_BACKUP)).toHaveLength(1)
          expect(f.a(RESEND)).toHaveLength(1)
      })

      it('senza token non chiama GitHub, lo dice e manda l\'email', async () => {
          const f = fetchFinto({ [RESEND]: [ACCETTATA] })

          const { esito, righeErrore } = await unGiroBackup(f, '')

          expect(f.a(DISPATCH_BACKUP)).toHaveLength(0)
          expect(esito.lancio.http).toBe(0)
          expect(righeErrore.join(' ')).toContain('manca GITHUB_TOKEN_CAMPANELLO')
          expect(f.a(RESEND)).toHaveLength(1)
      })

      it('senza i segreti di Resend lo scrive in console.error e va avanti', async () => {
          const f = fetchFinto({ [DISPATCH_BACKUP]: [{ status: 500, testo: 'boom' }], [WF_BACKUP]: [{ status: 500, testo: 'boom' }] })

          const { esito, righeErrore } = await unGiroBackup(f, TOKEN, {})

          expect(esito.email?.ok).toBe(false)
          expect(righeErrore.join(' ')).toContain('mancano RESEND_API_KEY o SENTINELLA_DESTINATARI')
          expect(f.a(RESEND)).toHaveLength(0)
      })

      it('Resend rifiuta: il corpo del rifiuto finisce nel log (un 403 senza corpo non dice perché)', async () => {
          const f = fetchFinto({
              [DISPATCH_BACKUP]: [CREDENZIALI],
              [WF_BACKUP]: [CREDENZIALI],
              [RESEND]: [{ status: 403, testo: '{"message":"The domain is not verified"}' }],
          })

          const { righeErrore } = await unGiroBackup(f)

          expect(righeErrore.join(' ')).toMatch(/monitor-email: esito=non-spedita.*403.*domain is not verified/)
      })

      it('la rete cade: esito fallito, col motivo', async () => {
          const f = fetchFinto({ [DISPATCH_BACKUP]: [new Error('timeout')], [RESEND]: [ACCETTATA] })

          const { esito } = await unGiroBackup(f)

          expect(esito.lancio).toMatchObject({ ok: false, esito: 'fallito', http: null })
          expect(esito.lancio.corpo).toContain('timeout')
      })
  })

  describe('chiaveIdempotenza', () => {
      it('una per notte per il backup, una per ora per il sito giù; solo caratteri che Resend accetta', () => {
          expect(chiaveIdempotenza('backup', new Date('2026-10-21T02:23:00Z'))).toBe('kidville-backup-non-partito-2026-10-21')
          expect(chiaveIdempotenza('vivo', new Date('2026-10-19T10:05:00Z'))).toBe('kidville-vivo-giu-2026-10-19T10')
          expect(chiaveIdempotenza('vivo', new Date('2026-10-19T10:55:00Z'))).toBe('kidville-vivo-giu-2026-10-19T10')
          expect(chiaveIdempotenza('vivo', new Date('2026-10-19T11:00:00Z'))).toBe('kidville-vivo-giu-2026-10-19T11')
          for (const k of [chiaveIdempotenza('backup', NOTTE), chiaveIdempotenza('vivo', NOTTE)]) {
              expect(k).toMatch(/^[A-Za-z0-9:_.-]{1,256}$/)
          }
      })
  })
  ```

- [ ] **Passo 2: rosso.**
  ```bash
  CI=1 npx vitest run __tests__/lib/monitor-esterno.test.ts
  ```
  Atteso: FAIL nei due nuovi `describe` (`giroBackup is not a function`, `chiaveIdempotenza is not a function`);
  le prove già esistenti restano verdi.

- [ ] **Passo 3: codice.** In `monitor-esterno/worker.mjs`, subito dopo la testata (dopo la riga 25) aggiungi:
  ```js
  import { escapeHtml, mandaEmail } from '../scripts/campanello/allarme.mjs'
  ```
  Dopo `export const MINUTI_BATTITO = 15` (riga 37) aggiungi:
  ```js
  /** Il backup notturno, che alle 02:23 UTC lancia questo Worker (lo `schedule` di GitHub arrivava fra le 07:04 e le 09:35). */
  export const WORKFLOW_BACKUP = 'backup-notturno.yml'
  /** Il cron di Cloudflare del backup: IDENTICO alla seconda voce di `crons` in `wrangler.toml` (un test li lega). */
  export const CRON_BACKUP = '23 2 * * *'
  /** Dove portano le email del Worker: l'elenco dei giri, non un giro (quello, appunto, non è partito). */
  export const LINK_GIRI_BACKUP = `https://github.com/${REPO}/actions/workflows/${WORKFLOW_BACKUP}`
  export const LINK_GIRI_CAMPANELLO = `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`

  /** Le intestazioni di ogni chiamata a GitHub. Il token sta solo qui: non finisce mai in un log. */
  function intestazioniGitHub(token) {
      return {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'kidville-monitor-esterno',
          'Content-Type': 'application/json',
      }
  }
  ```
  In `suonaCampanello` sostituisci il blocco `headers: { … }` (righe 70-76) con:
  ```js
              headers: intestazioniGitHub(token),
  ```
  Subito prima di `function attendi(ms)` (riga 115) aggiungi:
  ```js
  /**
   * Fa partire il backup notturno con `modalita=completo` e `origine=cloudflare`. Il `run-name` del
   * workflow lo traduce nel titolo «Backup notturno completo (da Cloudflare)», che il campanello e la
   * guardia delle 20 ore riconoscono. Restituisce `{ ok, esito, http, corpo }` e non lancia mai.
   *   esito = 'partito' | 'riattivato-e-partito' | 'spento-a-mano' | 'fallito'
   *
   * Se GitHub rifiuta, si chiede lo STATO del workflow invece di indovinarlo dal testo dell'errore:
   *   · `disabled_inactivity` (GitHub spegne da solo i workflow programmati di un repository fermo da
   *     60 giorni) → lo riattiva e riprova UNA volta;
   *   · `disabled_manually` → NON lo riaccende: è l'interruttore del titolare, scritto in testa al
   *     workflow (`gh workflow disable backup-notturno.yml`).
   * NIENTE ripiego «senza input» come per il campanello: senza `modalita=completo` il workflow farebbe
   * un giro di PROVA, cioè un backup finto con l'aria di quello vero.
   */
  export async function lanciaBackup({ token, fetchImpl = fetch }) {
      if (!token) return { ok: false, esito: 'fallito', http: 0, corpo: 'manca GITHUB_TOKEN_CAMPANELLO: il backup NON parte' }
      const base = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_BACKUP}`
      const chiama = async (url, verbo, corpo) => {
          const res = await fetchImpl(url, {
              method: verbo,
              headers: intestazioniGitHub(token),
              ...(corpo ? { body: JSON.stringify(corpo) } : {}),
              signal: AbortSignal.timeout(TEMPO_MAX_RICHIESTA_MS),
          })
          return { http: res.status, testo: await res.text() }
      }
      const lancia = () => chiama(`${base}/dispatches`, 'POST', { ref: 'main', inputs: { modalita: 'completo', origine: ORIGINE } })
      try {
          const primo = await lancia()
          if (primo.http === 204) return { ok: true, esito: 'partito', http: 204, corpo: '' }
          // Il corpo del rifiuto si tiene sempre: «Bad credentials» dice che il token è scaduto.
          const corpo = primo.testo.slice(0, 300)
          const stato = await chiama(base, 'GET')
          const statoWorkflow = stato.http === 200 ? (/"state"\s*:\s*"([a-z_]+)"/.exec(stato.testo)?.[1] ?? '') : ''
          if (statoWorkflow === 'disabled_manually') return { ok: false, esito: 'spento-a-mano', http: primo.http, corpo }
          if (statoWorkflow !== 'disabled_inactivity') return { ok: false, esito: 'fallito', http: primo.http, corpo }
          const riattiva = await chiama(`${base}/enable`, 'PUT')
          if (riattiva.http !== 204) {
              return {
                  ok: false,
                  esito: 'fallito',
                  http: riattiva.http,
                  corpo: `workflow spento per inattività e riattivazione rifiutata: ${riattiva.testo.slice(0, 250)}`,
              }
          }
          const secondo = await lancia()
          return secondo.http === 204
              ? { ok: true, esito: 'riattivato-e-partito', http: 204, corpo: '' }
              : { ok: false, esito: 'fallito', http: secondo.http, corpo: `riattivato, ma il lancio è stato rifiutato: ${secondo.testo.slice(0, 250)}` }
      } catch (err) {
          return { ok: false, esito: 'fallito', http: null, corpo: err instanceof Error ? err.name + ': ' + err.message : String(err) }
      }
  }

  /**
   * La chiave d'idempotenza di Resend per un'email del Worker: SOLO codici e date, mai un indirizzo.
   *   · 'backup' → una per notte (`kidville-backup-non-partito-AAAA-MM-GG`);
   *   · 'vivo'   → una per ora (`kidville-vivo-giu-AAAA-MM-GGTHH`): il cron gira ogni 5 minuti, e un
   *     sito giù per un'ora deve fare UNA email, non dodici.
   */
  export function chiaveIdempotenza(tipo, quando) {
      const iso = quando.toISOString()
      return tipo === 'backup' ? `kidville-backup-non-partito-${iso.slice(0, 10)}` : `kidville-vivo-giu-${iso.slice(0, 13)}`
  }

  /**
   * IL SECONDO CANALE (T12): un'email via Resend quando il Worker non riesce a far partire un workflow.
   * È il caso in cui il primo canale tace per definizione: è GitHub che rifiuta o non risponde, e la
   * segnalazione e l'email del campanello partono proprio da GitHub. Stesso mittente e stessa
   * impaginazione del campanello: è la sua `mandaEmail`. Non lancia mai; scrive sempre UNA riga:
   *   · `esito=accettata` — Resend ha l'email con questa chiave: spedita adesso, o già spedita dentro la
   *     finestra della chiave (in quel caso l'id nella risposta è lo stesso della prima volta);
   *   · `esito=non-spedita` — con lo stato e il corpo del rifiuto, oppure con «mancano RESEND_API_KEY o
   *     SENTINELLA_DESTINATARI» se i segreti del Worker non ci sono. Livello error: è un incidente.
   */
  export async function avvisaPerEmail({ segreti = {}, chiave, oggetto, introHtml, link, quando, fetchImpl = fetch, log = (r) => console.log(r) }) {
      const esito = await mandaEmail({
          chiaveResend: segreti.chiaveResend,
          destinatari: segreti.destinatari,
          oggetto,
          introHtml,
          link,
          quando,
          chiaveIdempotenza: chiave,
          fetchImpl,
      })
      if (esito.ok) {
          log(`monitor-email: esito=accettata chiave=${chiave} HTTP ${esito.stato} ${String(esito.corpo).slice(0, 120)}`)
      } else {
          console.error(`monitor-email: esito=non-spedita chiave=${chiave} HTTP ${esito.stato} ${String(esito.corpo).slice(0, 300)}`)
      }
      return esito
  }

  /**
   * Il giro delle 02:23 UTC: lancia il backup; se non parte (e non è spento a mano) lo scrive in
   * `console.error` col corpo di GitHub e manda l'email. `quando` = l'ora PROGRAMMATA del cron.
   * Restituisce `{ lancio, email }`; `email` = null quando non serve.
   */
  export async function giroBackup({ quando, token, segreti = {}, fetchImpl = fetch, log = (r) => console.log(r) }) {
      const lancio = await lanciaBackup({ token, fetchImpl })
      if (lancio.ok) {
          log(`monitor-backup: esito=${lancio.esito} workflow=${WORKFLOW_BACKUP} HTTP ${lancio.http}`)
          return { lancio, email: null }
      }
      if (lancio.esito === 'spento-a-mano') {
          // L'interruttore del titolare si rispetta e si dice, senza un'email ogni notte. Se nessuno lo
          // riaccende, dopo 30 ore il campanello apre `[backup-vecchio]`, ed è giusto.
          log(`monitor-backup: esito=spento-a-mano workflow=${WORKFLOW_BACKUP}: spento con «gh workflow disable», il Worker non lo riaccende`)
          return { lancio, email: null }
      }
      // Il corpo del rifiuto va nel log intero (senza il token, che non è nel corpo): è il «perché».
      console.error(`monitor-backup: esito=fallito workflow=${WORKFLOW_BACKUP} HTTP ${lancio.http ?? '-'} ${lancio.corpo}`)
      const iso = quando.toISOString()
      const email = await avvisaPerEmail({
          segreti,
          chiave: chiaveIdempotenza('backup', quando),
          oggetto: 'Backup notturno NON partito',
          introHtml:
              'Il monitor esterno non è riuscito a far partire il backup notturno di database e file. ' +
              `GitHub ha risposto: <code>HTTP ${escapeHtml(String(lancio.http ?? '-'))} ${escapeHtml(lancio.corpo)}</code>. ` +
              'Finché un giro non riesce, l’ultima copia buona è quella di ieri o più vecchia; lo schedule di ' +
              'GitHub può ancora farlo partire in mattinata. Cosa fare: <code>docs/runbook-ripristino.md</code>, scenario B.',
          link: LINK_GIRI_BACKUP,
          quando: `${iso.slice(0, 10)} alle ${iso.slice(11, 16)} UTC`,
          fetchImpl,
          log,
      })
      return { lancio, email }
  }
  ```

- [ ] **Passo 4: verde.**
  ```bash
  CI=1 npx vitest run __tests__/lib/monitor-esterno.test.ts
  ```
  Atteso: `Test Files  1 passed (1)`, tutte le prove verdi, comprese le otto prove del campanello già esistenti.

- [ ] **Passo 5: commit.**
  ```bash
  git add monitor-esterno/worker.mjs __tests__/lib/monitor-esterno.test.ts
  git commit -m "Robustezza 2, sessione 4: il Worker lancia il backup notturno e, se non parte, manda l'email" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Compito 4: il secondo canale quando il sito è giù e il campanello non parte

**File:**
- Modifica: `monitor-esterno/worker.mjs:92-113` (`giro`)
- Test: `__tests__/lib/monitor-esterno.test.ts:48-56` (`unGiro`)

- [ ] **Passo 1: prove rosse.** Sostituisci `unGiro` (righe 48-56) con:
  ```ts
  async function unGiro(f: ReturnType<typeof fetchFinto>, quando: Date, token = 'tok', segreti: Segreti = {}) {
      const dormi = vi.fn(async () => {})
      const log = vi.fn()
      const errore = vi.spyOn(console, 'error').mockImplementation(() => {})
      const esito = await giro({ quando, token, segreti, fetchImpl: f.impl, dormi, log })
      const righeErrore = errore.mock.calls.map((c) => String(c[0]))
      errore.mockRestore()
      return { esito, dormi, log, righeErrore }
  }
  ```
  In fondo al file aggiungi:
  ```ts
  describe('il secondo canale quando il sito è giù', () => {
      it('sito giù E campanello rifiutato: parte l\'email, con la chiave dell\'ora', async () => {
          const f = fetchFinto({ [URL_VIVO]: [GIU], [DISPATCH]: [CREDENZIALI], [RESEND]: [ACCETTATA] })

          const { esito, log } = await unGiro(f, FUORI_BATTITO, 'tok', SEGRETI)

          expect(esito.suonato).toBe(false)
          expect(f.a(RESEND)).toHaveLength(1)
          expect(f.a(RESEND)[0].idem).toBe('kidville-vivo-giu-2026-10-19T10')
          expect(JSON.parse(f.a(RESEND)[0].corpo!).subject).toBe('Sito giù e campanello NON partito')
          expect(esito.email?.ok).toBe(true)
          expect(log.mock.calls.map((c) => String(c[0])).join(' ')).toContain('monitor-email: esito=accettata')
      })

      it('dentro la stessa ora il testo non cambia anche se cambia il guasto (stessa chiave, messaggio diverso = 409)', async () => {
          const f = fetchFinto({
              [URL_VIVO]: [GIU, GIU, { status: 502, testo: 'Bad gateway' }],
              [DISPATCH]: [CREDENZIALI],
              [RESEND]: [ACCETTATA],
          })

          await unGiro(f, FUORI_BATTITO, 'tok', SEGRETI)
          await unGiro(f, new Date('2026-10-19T10:40:00Z'), 'tok', SEGRETI)

          const [prima, seconda] = f.a(RESEND)
          expect(seconda.idem).toBe(prima.idem)
          expect(seconda.corpo).toBe(prima.corpo)
      })

      it('battito rifiutato col sito sano: nessuna email (lo vede `monitor-esterno-muto`)', async () => {
          const f = fetchFinto({ [URL_VIVO]: [OK], [DISPATCH]: [CREDENZIALI] })

          const { esito } = await unGiro(f, SUL_BATTITO, 'tok', SEGRETI)

          expect(esito.suonato).toBe(false)
          expect(esito.email).toBeNull()
          expect(f.a(RESEND)).toHaveLength(0)
      })

      it('sito giù e campanello partito: nessuna email dal Worker (l\'allarme lo manda il campanello)', async () => {
          const f = fetchFinto({ [URL_VIVO]: [GIU], [DISPATCH]: [PARTITO] })

          const { esito } = await unGiro(f, FUORI_BATTITO, 'tok', SEGRETI)

          expect(esito.suonato).toBe(true)
          expect(esito.email).toBeNull()
          expect(f.a(RESEND)).toHaveLength(0)
      })
  })
  ```

- [ ] **Passo 2: rosso.**
  ```bash
  CI=1 npx vitest run __tests__/lib/monitor-esterno.test.ts -t "secondo canale"
  ```
  Atteso: FAIL. Nella prima prova `expected [] to have a length of 1`; in quelle col battito
  `expected undefined to be null`.

- [ ] **Passo 3: codice.** In `monitor-esterno/worker.mjs` sostituisci il commento e il corpo di `giro` (righe 92-113) con:
  ```js
  /**
   * Un giro. `quando` = l'ora PROGRAMMATA del cron (non quella effettiva): il battito cade sui quarti
   * d'ora anche se Cloudflare parte con qualche secondo di ritardo.
   * Restituisce `{ vivo, battito, suonato, esito, email }` e scrive UNA riga di log (due se parte
   * l'email del secondo canale).
   */
  export async function giro({ quando, token, segreti = {}, fetchImpl = fetch, dormi = attendi, log = (r) => console.log(r) }) {
      const vivo = await leggiVivo({ fetchImpl, dormi })
      const battito = quando.getUTCMinutes() % MINUTI_BATTITO === 0
      if (vivo.ok && !battito) {
          log(`monitor: vivo ok, nessun giro del campanello`)
          return { vivo, battito, suonato: false, esito: null, email: null }
      }
      const esito = await suonaCampanello({ token, fetchImpl })
      const perche = vivo.ok ? 'battito' : `vivo NON ok (HTTP ${vivo.http ?? 'nessuna risposta'}: ${vivo.motivo})`
      if (esito.ok) {
          log(`monitor: ${perche} → campanello partito`)
          return { vivo, battito, suonato: true, esito, email: null }
      }
      // Il corpo del rifiuto va nel log intero (senza il token, che non è nel corpo): è il «perché».
      console.error(`monitor: ${perche} → campanello NON partito: HTTP ${esito.http ?? '-'} ${esito.corpo}`)
      // Un battito rifiutato col sito sano NON manda email: lo vede il campanello stesso
      // (`monitor-esterno-muto`), e un token scaduto lo dice comunque l'email del backup delle 02:23.
      if (vivo.ok) return { vivo, battito, suonato: false, esito, email: null }
      // IL SECONDO CANALE (T12): sito giù E campanello fermo = l'allarme normale non arriverà.
      // Un'email per ora (la chiave di Resend), con un testo che dentro l'ora NON cambia: a una stessa
      // chiave con un messaggio diverso Resend risponde 409. Il guasto preciso è nella riga qui sopra.
      const iso = quando.toISOString()
      const email = await avvisaPerEmail({
          segreti,
          chiave: chiaveIdempotenza('vivo', quando),
          oggetto: 'Sito giù e campanello NON partito',
          introHtml:
              'Il monitor esterno vede il sito giù e non riesce a far partire il campanello di GitHub: la ' +
              'segnalazione e l’email normali NON arriveranno. Il motivo esatto è nei log del Worker ' +
              '<code>kidville-monitor-esterno</code> (pannello Cloudflare → Workers → Logs).',
          link: LINK_GIRI_CAMPANELLO,
          quando: `dalle ${iso.slice(11, 13)}:00 UTC del ${iso.slice(0, 10)}`,
          fetchImpl,
          log,
      })
      return { vivo, battito, suonato: false, esito, email }
  }
  ```

- [ ] **Passo 4: verde.**
  ```bash
  CI=1 npx vitest run __tests__/lib/monitor-esterno.test.ts
  ```
  Atteso: `Test Files  1 passed (1)`. Le due prove già esistenti con 401 e senza token restano verdi: ora scrivono
  anche `monitor-email: esito=non-spedita … mancano RESEND_API_KEY…`, che non contiene il token.

- [ ] **Passo 5: commit.**
  ```bash
  git add monitor-esterno/worker.mjs __tests__/lib/monitor-esterno.test.ts
  git commit -m "Robustezza 2, sessione 4: sito giù e campanello fermo, il Worker scrive per email" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Compito 5: `scheduled` per cron, `wrangler.toml` con il secondo cron, segreti della prova fuori da git

**File:**
- Modifica: `monitor-esterno/worker.mjs:20-25, 119-123`, `monitor-esterno/wrangler.toml:1-14`, `.gitignore` (dopo la riga 46)
- Test: `__tests__/lib/monitor-esterno.test.ts:1-14, 175-183`

- [ ] **Passo 1: prove rosse.** Sostituisci gli import in cima al test (righe 1-14) con:
  ```ts
  import { describe, it, expect, vi } from 'vitest'
  import { execFileSync } from 'node:child_process'
  import { readFileSync } from 'node:fs'
  import { join } from 'node:path'
  import worker, {
      CRON_BACKUP,
      LINK_GIRI_BACKUP,
      MINUTI_BATTITO,
      ORIGINE,
      REPO,
      URL_VIVO,
      WORKFLOW,
      WORKFLOW_BACKUP,
      chiaveIdempotenza,
      giro,
      giroBackup,
      lavoroDelCron,
      leggiVivo,
      suonaCampanello,
  } from '../../monitor-esterno/worker.mjs'
  import { TITOLO_DA_FUORI, mandaEmail } from '../../scripts/campanello/allarme.mjs'
  ```
  Sostituisci il `describe('wrangler.toml', …)` (righe 175-183) con:
  ```ts
  describe('wrangler.toml', () => {
      const toml = readFileSync(join(process.cwd(), 'monitor-esterno/wrangler.toml'), 'utf8')

      it('due cron (ogni 5 minuti; alle 02:23 il backup), nessun indirizzo pubblico, nessun segreto nel file', () => {
          expect(toml).toMatch(/^crons\s*=\s*\["\*\/5 \* \* \* \*", "23 2 \* \* \*"\]\s*$/m)
          expect(toml).toContain(`"${CRON_BACKUP}"`)
          expect(toml).toMatch(/^workers_dev\s*=\s*false\s*$/m)
          expect(toml).not.toMatch(/github_pat_|ghp_|re_[A-Za-z0-9]{6,}|\[vars\]|RESEND_API_KEY\s*=|SENTINELLA_DESTINATARI\s*=/)
      })

      it('il Worker lancia il backup alla stessa ora dello schedule di riserva', () => {
          const yml = readFileSync(join(process.cwd(), '.github/workflows/backup-notturno.yml'), 'utf8')
          expect(yml).toContain(`- cron: '${CRON_BACKUP}'`)
      })
  })

  describe('scheduled: ogni cron fa il suo lavoro', () => {
      async function scatta(cron: string, scheduledTime: number, f: ReturnType<typeof fetchFinto>) {
          const promesse: Promise<unknown>[] = []
          vi.stubGlobal('fetch', f.impl)
          const silenzio = vi.spyOn(console, 'log').mockImplementation(() => {})
          const errore = vi.spyOn(console, 'error').mockImplementation(() => {})
          try {
              await worker.scheduled(
                  { cron, scheduledTime },
                  { GITHUB_TOKEN_CAMPANELLO: TOKEN },
                  { waitUntil: (p: Promise<unknown>) => promesse.push(p) },
              )
              await Promise.all(promesse)
          } finally {
              vi.unstubAllGlobals()
              silenzio.mockRestore()
              errore.mockRestore()
          }
          return promesse.length
      }

      it('lavoroDelCron: «23 2 * * *» è il backup, tutto il resto è il monitor', () => {
          expect(CRON_BACKUP).toBe('23 2 * * *')
          expect(lavoroDelCron(CRON_BACKUP)).toBe('backup')
          expect(lavoroDelCron('*/5 * * * *')).toBe('monitor')
          expect(lavoroDelCron('')).toBe('monitor')
      })

      it('il cron delle 02:23 lancia il backup e non legge il vivo', async () => {
          const f = fetchFinto({ [DISPATCH_BACKUP]: [PARTITO] })

          expect(await scatta(CRON_BACKUP, Date.parse('2026-10-21T02:23:00Z'), f)).toBe(1)

          expect(f.a(DISPATCH_BACKUP)).toHaveLength(1)
          expect(f.a(URL_VIVO)).toHaveLength(0)
      })

      it('il cron dei 5 minuti legge il vivo e non lancia il backup', async () => {
          const f = fetchFinto({ [URL_VIVO]: [OK] })

          expect(await scatta('*/5 * * * *', FUORI_BATTITO.getTime(), f)).toBe(1)

          expect(f.a(URL_VIVO)).toHaveLength(1)
          expect(f.a(DISPATCH_BACKUP)).toHaveLength(0)
      })
  })

  describe('i segreti della prova in locale non vanno online', () => {
      it('git ignora `.dev.vars` e `.wrangler/` del Worker', () => {
          for (const f of ['monitor-esterno/.dev.vars', 'monitor-esterno/.wrangler/tmp/prova.js']) {
              let ignorato = true
              try {
                  execFileSync('git', ['check-ignore', '-q', f], { cwd: process.cwd() })
              } catch {
                  ignorato = false
              }
              expect(ignorato, `${f} NON è ignorato da git`).toBe(true)
          }
      })
  })
  ```

- [ ] **Passo 2: rosso.**
  ```bash
  CI=1 npx vitest run __tests__/lib/monitor-esterno.test.ts
  ```
  Atteso: FAIL su `wrangler.toml` (la regex dei due cron), su `lavoroDelCron is not a function`, sul cron delle
  02:23 (oggi `scheduled` chiama sempre `giro`: `fetch finto: URL non previsto …/api/health/vivo`) e su
  `monitor-esterno/.dev.vars NON è ignorato da git`.

- [ ] **Passo 3: codice.** In `monitor-esterno/worker.mjs` sostituisci le righe 20-25 della testata con:
  ```js
  // IL BACKUP NOTTURNO (robustezza, seconda serie, sessione 4). Alle 02:23 UTC un secondo cron fa partire
  // `backup-notturno.yml` con `modalita=completo` e `origine=cloudflare`: lo `schedule` di GitHub
  // arrivava fra le 07:04 e le 09:35, sopra la punta delle scuole. Se il lancio non riesce, il Worker
  // manda un'email (Resend). È il SECONDO CANALE: quando è GitHub a rifiutare, l'allarme del campanello
  // non può partire. Vale anche quando il sito è giù e il campanello non parte.
  //
  // I SEGRETI sono tre, nei segreti del Worker e mai in `wrangler.toml` (il repository è pubblico):
  //   · `GITHUB_TOKEN_CAMPANELLO`: token GitHub a grana fine, limitato a QUESTO repository e al solo
  //     permesso «Actions: read and write». Scade (la data sta in `docs/cicd.md`): se scade, il battito
  //     si ferma (il campanello lo dice da solo) e il backup delle 02:23 non parte (lo dice l'email);
  //   · `RESEND_API_KEY` e `SENTINELLA_DESTINATARI`: gli stessi del campanello. Se mancano, il Worker lo
  //     scrive in `console.error` e va avanti: il lancio del backup non dipende dall'email.
  //
  // Si prova con `__tests__/lib/monitor-esterno.test.ts` (numeri letterali, fetch finto). Si pubblica
  // con `npx wrangler@4.148.0 deploy` da questa cartella; si spegne con `npx wrangler@4.148.0 delete`.
  // Importa `scripts/campanello/allarme.mjs` (la stessa email del campanello): `wrangler` lo impacchetta.
  ```
  Sostituisci l'oggetto `worker` (righe 119-123) con:
  ```js
  /** Quale lavoro fa un cron di Cloudflare: il backup alle 02:23, il monitor tutti gli altri. */
  export function lavoroDelCron(cron) {
      return cron === CRON_BACKUP ? 'backup' : 'monitor'
  }

  const worker = {
      async scheduled(controller, env, ctx) {
          const quando = new Date(controller.scheduledTime)
          const token = env.GITHUB_TOKEN_CAMPANELLO
          const segreti = { chiaveResend: env.RESEND_API_KEY, destinatari: env.SENTINELLA_DESTINATARI }
          if (lavoroDelCron(controller.cron) === 'backup') {
              ctx.waitUntil(giroBackup({ quando, token, segreti }))
          } else {
              ctx.waitUntil(giro({ quando, token, segreti }))
          }
      },
  }
  ```
  Sostituisci l'intero `monitor-esterno/wrangler.toml` con:
  ```toml
  # Il monitor esterno su Cloudflare: vedi `worker.mjs` (cosa fa) e `docs/cicd.md` (come si gestisce).
  # Nessun indirizzo pubblico: il Worker ha solo i cron. I segreti stanno nei segreti del Worker
  # (`npx wrangler@4.148.0 secret put GITHUB_TOKEN_CAMPANELLO`, e lo stesso per RESEND_API_KEY e
  # SENTINELLA_DESTINATARI), MAI in questo file: il repository è pubblico.
  name = "kidville-monitor-esterno"
  main = "worker.mjs"
  compatibility_date = "2026-10-01"
  workers_dev = false
  preview_urls = false

  [triggers]
  # Ogni 5 minuti: il vivo e il battito del campanello. Alle 02:23 UTC: il backup notturno.
  # Il secondo deve restare IDENTICO a `CRON_BACKUP` in worker.mjs: è così che `scheduled` li distingue.
  crons = ["*/5 * * * *", "23 2 * * *"]

  [observability]
  enabled = true
  ```
  In `.gitignore`, subito dopo la riga `/KIDVILLE-CHIAVI-BACKUP/` (riga 46), aggiungi:
  ```gitignore

  # Il Worker del monitor esterno (`monitor-esterno/`): `.dev.vars` contiene i segreti della prova in
  # locale (`wrangler dev`), `.wrangler/` la sua cache. MAI nel repository, che è pubblico.
  .dev.vars*
  .wrangler/
  ```

- [ ] **Passo 4: verde, e il pacchetto del Worker si costruisce.**
  ```bash
  CI=1 npx vitest run __tests__/lib/monitor-esterno.test.ts
  cd monitor-esterno && npx wrangler@4.148.0 deploy --dry-run --outdir "$TMPDIR/monitor-prova" && cd ..
  ```
  Atteso: `Test Files  1 passed (1)`. Poi `--dry-run: exiting now.` senza errori di risoluzione
  dell'import `../scripts/campanello/allarme.mjs`. Il `--dry-run` non pubblica niente.

- [ ] **Passo 5: commit.**
  ```bash
  git add monitor-esterno/worker.mjs monitor-esterno/wrangler.toml .gitignore __tests__/lib/monitor-esterno.test.ts
  git commit -m "Robustezza 2, sessione 4: secondo cron alle 02:23 e scheduled per cron; .dev.vars fuori da git" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Compito 6: il campanello conta i giri «(da Cloudflare)»

**File:**
- Modifica: `scripts/campanello/valuta.mjs:21-22, 102-109`, `scripts/campanello/allarme.mjs:93-99`, `scripts/campanello/campanello.mjs:30, 97`
- Test: `__tests__/lib/campanello-valuta.test.ts:1-14, 144-185`, `__tests__/lib/campanello-esegui.test.ts:61, 410-419`

- [ ] **Passo 1: prove rosse.** In `__tests__/lib/campanello-valuta.test.ts` sostituisci l'import da `valuta.mjs`
  (righe 2-13) con:
  ```ts
  import {
      MINUTI_ALLARME_MONITOR_ESTERNO,
      ORE_ALLARME_BACKUP,
      PROMEMORIA_DOPO_MS,
      REGIONE_ATTESA,
      TITOLO_BACKUP_DA_FUORI,
      chiaveDaTitolo,
      eGiroBackupAutomatico,
      riconcilia,
      valutaBackup,
      valutaDopoDeploy,
      valutaMonitorEsterno,
      valutaSalute,
      valutaVivo,
  } from '../../scripts/campanello/valuta.mjs'
  ```
  Nel `describe('valutaBackup', …)` sostituisci la riga del `giro` (riga 145) con:
  ```ts
      const giro = (oreFa: number) => ({ event: 'schedule', conclusion: 'success', updated_at: new Date(ADESSO - oreFa * ORA).toISOString() })
      const daFuori = (oreFa: number) => ({
          event: 'workflow_dispatch',
          display_title: 'Backup notturno completo (da Cloudflare)',
          conclusion: 'success',
          updated_at: new Date(ADESSO - oreFa * ORA).toISOString(),
      })
      const aMano = (oreFa: number) => ({
          event: 'workflow_dispatch',
          display_title: 'Backup notturno completo',
          conclusion: 'success',
          updated_at: new Date(ADESSO - oreFa * ORA).toISOString(),
      })
  ```
  e prima della chiusura del `describe` (riga 185) aggiungi:
  ```ts
      it('il lancio delle 02:23 dal Worker conta come giro automatico (lo dice il titolo)', () => {
          expect(valutaBackup({ giri: [daFuori(5)], adesso: ADESSO })).toBeNull()
      })

      it('un giro lanciato a mano NON conta, nemmeno se completo e recente', () => {
          expect(valutaBackup({ giri: [aMano(1)], adesso: ADESSO })?.chiave).toBe('backup-vecchio')
      })

      it('fra un giro a mano di un\'ora fa e uno automatico, decide quello automatico', () => {
          expect(valutaBackup({ giri: [aMano(1), daFuori(20)], adesso: ADESSO })).toBeNull()
          expect(valutaBackup({ giri: [aMano(1), giro(31)], adesso: ADESSO })?.titolo).toContain('31 ore')
      })
  ```
  Subito dopo quel `describe` aggiungi:
  ```ts
  describe('eGiroBackupAutomatico', () => {
      it('lo schedule sì; il Worker solo come workflow_dispatch col titolo esatto; il resto no', () => {
          expect(TITOLO_BACKUP_DA_FUORI).toBe('Backup notturno completo (da Cloudflare)')
          expect(eGiroBackupAutomatico({ event: 'schedule', conclusion: 'success' })).toBe(true)
          expect(eGiroBackupAutomatico({ event: 'workflow_dispatch', display_title: TITOLO_BACKUP_DA_FUORI, conclusion: 'success' })).toBe(true)
          expect(eGiroBackupAutomatico({ event: 'workflow_dispatch', display_title: 'Backup notturno prova (da Cloudflare)', conclusion: 'success' })).toBe(false)
          expect(eGiroBackupAutomatico({ event: 'push', display_title: TITOLO_BACKUP_DA_FUORI, conclusion: 'success' })).toBe(false)
          expect(eGiroBackupAutomatico({ event: 'schedule', conclusion: 'cancelled' })).toBe(false)
          expect(eGiroBackupAutomatico(null)).toBe(false)
      })
  })
  ```
  In `__tests__/lib/campanello-esegui.test.ts` sostituisci la riga 61 con:
  ```ts
              return opzioni.giri ?? [{ event: 'schedule', conclusion: 'success', updated_at: new Date(ADESSO - 5 * ORA).toISOString() }]
  ```
  e la prova delle righe 410-419 con:
  ```ts
      it('legge i giri RIUSCITI del backup, automatici e no: quali contano lo decide valutaBackup', async () => {
          const f = fetchFinto({
              'https://api.github.com/repos/o/r/actions/workflows/backup-notturno.yml/runs?status=success&per_page=30': [
                  { status: 200, corpo: { workflow_runs: [{ conclusion: 'success', updated_at: 'x' }] } },
              ],
          })
          const gh = creaGitHub({ repo: 'o/r', token: 't', fetchImpl: f.impl })

          expect(await gh.giriBackupRiusciti()).toHaveLength(1)
      })
  ```

- [ ] **Passo 2: rosso.**
  ```bash
  CI=1 npx vitest run __tests__/lib/campanello-valuta.test.ts __tests__/lib/campanello-esegui.test.ts
  ```
  Atteso: FAIL su `eGiroBackupAutomatico is not a function`, sul giro a mano (oggi conta: `expected undefined to be
  'backup-vecchio'`) e su `fetch finto: URL non previsto …runs?event=schedule&status=success&per_page=5`.

- [ ] **Passo 3: codice.** In `scripts/campanello/valuta.mjs` sostituisci le righe 21-22 del commento di
  `ORE_ALLARME_BACKUP`:
  ```js
   *  Si guarda solo `event = schedule`: un giro lanciato a mano può essere in modalità `prova` (scrive
   *  sotto `prove/` e non è un backup), e dall'API dei giri non si distingue dal `completo`. */
  ```
  con:
  ```js
   *  Contano solo i giri AUTOMATICI (`eGiroBackupAutomatico`): lo `schedule` di GitHub e il lancio delle
   *  02:23 del monitor esterno, riconosciuto dal titolo. Un giro lanciato a mano non conta, nemmeno se
   *  `completo`: la copia che conta è quella che parte da sola. */
  ```
  Sostituisci il commento di `valutaBackup`, la sua firma e la riga `const ultimo` (righe 102-109) con:
  ```js
  /** Il titolo che `backup-notturno.yml` (`run-name`) dà al lancio delle 02:23 del monitor esterno:
   *  `modalita=completo` + `origine=cloudflare`. `backup-guardia-notte.test.ts` lo lega al `run-name`. */
  export const TITOLO_BACKUP_DA_FUORI = 'Backup notturno completo (da Cloudflare)'

  /**
   * Un giro AUTOMATICO e riuscito del backup: lo `schedule` di GitHub, oppure il lancio delle 02:23 del
   * Worker di Cloudflare (un `workflow_dispatch` col titolo esatto). Un giro a mano NON conta, nemmeno se
   * `completo`: un giro a mano che riesce non dice niente sul giro di stanotte.
   */
  export function eGiroBackupAutomatico(g) {
      if (!g || g.conclusion !== 'success') return false
      if (g.event === 'schedule') return true
      return g.event === 'workflow_dispatch' && g.display_title === TITOLO_BACKUP_DA_FUORI
  }

  /**
   * IL BACKUP. `giri` = i giri RIUSCITI di `backup-notturno.yml`, dal più recente
   * (`GET …/runs?status=success`), automatici e no: quali contano lo decide `eGiroBackupAutomatico`.
   * Nessun giro automatico, o il più recente più vecchio di `ORE_ALLARME_BACKUP` ore → `backup-vecchio`.
   * @returns {Incidente | null}
   */
  export function valutaBackup({ giri, adesso }) {
      const ultimo = (giri ?? []).find((g) => eGiroBackupAutomatico(g) && Number.isFinite(Date.parse(g.updated_at)))
  ```
  In `scripts/campanello/allarme.mjs` sostituisci `giriBackupRiusciti` (righe 93-99) con:
  ```js
          /**
           * I giri RIUSCITI del backup, dal più recente: lo `schedule`, il lancio delle 02:23 del monitor
           * esterno e quelli a mano. Quali contano lo decide `eGiroBackupAutomatico` (valuta.mjs): qui non si
           * filtra per evento, perché il lancio del Worker è un `workflow_dispatch` come quelli a mano.
           */
          async giriBackupRiusciti() {
              const r = await chiama(
                  'GET',
                  `/repos/${repo}/actions/workflows/backup-notturno.yml/runs?status=success&per_page=30`,
              )
              return r?.workflow_runs ?? []
          },
  ```
  In `scripts/campanello/campanello.mjs` sostituisci la riga 30 (l'import da `./valuta.mjs`) con:
  ```js
  import { eGiroBackupAutomatico, riconcilia, valutaBackup, valutaMonitorEsterno, valutaSalute, valutaVivo } from './valuta.mjs'
  ```
  e la riga 97 con:
  ```js
              log(`backup: ${giri.length} giri riusciti letti, ${giri.filter(eGiroBackupAutomatico).length} automatici → ${incBackup ? 'INCIDENTE' : 'ok'}`)
  ```

- [ ] **Passo 4: verde.**
  ```bash
  CI=1 npx vitest run __tests__/lib/campanello-valuta.test.ts __tests__/lib/campanello-esegui.test.ts __tests__/lib/monitor-esterno.test.ts
  ```
  Atteso: `Test Files  3 passed (3)`.

- [ ] **Passo 5: commit.**
  ```bash
  git add scripts/campanello/valuta.mjs scripts/campanello/allarme.mjs scripts/campanello/campanello.mjs __tests__/lib/campanello-valuta.test.ts __tests__/lib/campanello-esegui.test.ts
  git commit -m "Robustezza 2, sessione 4: il campanello conta come automatico il backup lanciato da Cloudflare" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Compito 7: la guardia delle 20 ore

**File:**
- Crea: `scripts/backup/guardia-notte.mjs`
- Test: `__tests__/lib/backup-guardia-notte.test.ts`

- [ ] **Passo 1: la prova rossa.** Crea `__tests__/lib/backup-guardia-notte.test.ts`:
  ```ts
  import { describe, it, expect, vi } from 'vitest'
  import {
      ORE_GUARDIA,
      TITOLO_COMPLETO,
      WORKFLOW,
      decidi,
      eCompletoRiuscito,
      esegui,
  } from '../../scripts/backup/guardia-notte.mjs'

  /**
   * LA GUARDIA DELLE 20 ORE del backup notturno (`scripts/backup/guardia-notte.mjs`), con numeri
   * letterali e un GitHub finto. Ogni caso è una notte vera: il Worker ha fatto il backup alle 02:23
   * e lo `schedule` di GitHub, arrivato alle 07:30, deve annullarsi; il Worker ha fallito, e lo
   * `schedule` deve partire. Un guasto della guardia stessa deve far PARTIRE il backup, mai fermarlo.
   */

  const ADESSO = Date.parse('2026-10-21T07:30:00Z')
  const ID_CORRENTE = 9000
  const DA_FUORI = 'Backup notturno completo (da Cloudflare)'
  /** Il lancio delle 02:23 dal Worker, finito alle 02:41. */
  const dalWorker = (extra: Record<string, unknown> = {}) => ({
      id: 101,
      event: 'workflow_dispatch',
      display_title: DA_FUORI,
      conclusion: 'success',
      updated_at: '2026-10-21T02:41:00Z',
      ...extra,
  })
  const URL_GIRI = 'https://api.github.com/repos/o/r/actions/workflows/backup-notturno.yml/runs?status=success&per_page=30'

  function githubFinto(risposta: { status: number; testo: string } | Error) {
      const chiamate: { url: string; auth?: string }[] = []
      const impl = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
          chiamate.push({ url, auth: init?.headers?.Authorization })
          if (risposta instanceof Error) throw risposta
          return { status: risposta.status, text: async () => risposta.testo }
      })
      return { impl: impl as unknown as typeof fetch, chiamate }
  }

  describe('eCompletoRiuscito', () => {
      it('vale il lancio del Worker, lo schedule (anche di prima del run-name) e un completo a mano', () => {
          expect(eCompletoRiuscito(dalWorker(), ID_CORRENTE)).toBe(true)
          expect(eCompletoRiuscito(dalWorker({ event: 'schedule', display_title: 'Backup notturno (database e file → R2)' }), ID_CORRENTE)).toBe(true)
          expect(eCompletoRiuscito(dalWorker({ display_title: TITOLO_COMPLETO }), ID_CORRENTE)).toBe(true)
      })

      it('non vale un giro di prova, fallito o annullato, né il giro corrente', () => {
          expect(eCompletoRiuscito(dalWorker({ display_title: 'Backup notturno prova' }), ID_CORRENTE)).toBe(false)
          expect(eCompletoRiuscito(dalWorker({ conclusion: 'failure' }), ID_CORRENTE)).toBe(false)
          expect(eCompletoRiuscito(dalWorker({ conclusion: 'cancelled' }), ID_CORRENTE)).toBe(false)
          expect(eCompletoRiuscito(dalWorker({ id: ID_CORRENTE }), String(ID_CORRENTE))).toBe(false)
          expect(eCompletoRiuscito(null, ID_CORRENTE)).toBe(false)
      })
  })

  describe('decidi', () => {
      it('il Worker ha fatto il backup (finito alle 02:41): lo schedule delle 07:30 si annulla', () => {
          const d = decidi({ giri: [dalWorker()], adesso: ADESSO, idCorrente: ID_CORRENTE })

          expect(d.salta).toBe(true)
          expect(d.perche).toContain('4.8 ore')
      })

      // NUMERI LETTERALI: 20 ore esatte contano ancora, 20 ore e un minuto no.
      it('esattamente 20 ore fa conta ancora; 20 ore e 1 minuto no', () => {
          expect(decidi({ giri: [dalWorker({ updated_at: '2026-10-20T11:30:00Z' })], adesso: ADESSO, idCorrente: ID_CORRENTE }).salta).toBe(true)
          expect(decidi({ giri: [dalWorker({ updated_at: '2026-10-20T11:29:00Z' })], adesso: ADESSO, idCorrente: ID_CORRENTE }).salta).toBe(false)
      })

      it('il Worker ha fallito stanotte e l\'ultimo completo è di ieri alle 02:41: lo schedule PARTE', () => {
          const giri = [dalWorker({ conclusion: 'failure' }), dalWorker({ id: 100, updated_at: '2026-10-20T02:41:00Z' })]

          expect(decidi({ giri, adesso: ADESSO, idCorrente: ID_CORRENTE }).salta).toBe(false)
      })

      it('una data illeggibile o nel futuro non conta come «già fatto»', () => {
          expect(decidi({ giri: [dalWorker({ updated_at: 'boh' })], adesso: ADESSO, idCorrente: ID_CORRENTE }).salta).toBe(false)
          expect(decidi({ giri: [dalWorker({ updated_at: '2026-10-21T09:00:00Z' })], adesso: ADESSO, idCorrente: ID_CORRENTE }).salta).toBe(false)
      })

      it('nessun giro: il backup parte', () => {
          expect(decidi({ giri: [], adesso: ADESSO, idCorrente: ID_CORRENTE }).salta).toBe(false)
      })

      it('la finestra sta sopra il ritardo peggiore dello schedule (7 h 12 min) e sotto le 24 ore', () => {
          // 02:23 → 09:35 è il ritardo peggiore misurato (rapporto del 20/10). Sotto, uno schedule in
          // ritardo farebbe un secondo backup; a 24 ore o più, la notte dopo verrebbe saltata.
          expect(ORE_GUARDIA).toBeGreaterThanOrEqual(8)
          expect(ORE_GUARDIA).toBeLessThanOrEqual(23)
      })
  })

  describe('esegui (fail-open: un guasto della guardia fa PARTIRE il backup)', () => {
      async function unaGuardia(risposta: { status: number; testo: string } | Error, token = 't') {
          const g = githubFinto(risposta)
          const log = vi.fn()
          const d = await esegui({ repo: 'o/r', token, idCorrente: ID_CORRENTE, adesso: ADESSO, fetchImpl: g.impl, log })
          return { d, g, righe: log.mock.calls.map((c) => String(c[0])).join(' ') }
      }

      it('legge i giri riusciti del backup col token del giro, e decide', async () => {
          const { d, g, righe } = await unaGuardia({ status: 200, testo: JSON.stringify({ workflow_runs: [dalWorker()] }) })

          expect(WORKFLOW).toBe('backup-notturno.yml')
          expect(g.chiamate.map((c) => c.url)).toEqual([URL_GIRI])
          expect(g.chiamate[0].auth).toBe('Bearer t')
          expect(d.salta).toBe(true)
          expect(righe).toContain('guardia: esito=salta giri_letti=1')
      })

      it('GitHub risponde 403: il backup parte, e il corpo del rifiuto è nel log', async () => {
          const { d, righe } = await unaGuardia({ status: 403, testo: '{"message":"Resource not accessible by integration"}' })

          expect(d.salta).toBe(false)
          expect(righe).toMatch(/esito=non-verificabile.*403.*Resource not accessible/)
      })

      it('senza token non chiama GitHub e il backup parte', async () => {
          const { d, g } = await unaGuardia({ status: 200, testo: '{}' }, '')

          expect(g.chiamate).toHaveLength(0)
          expect(d.salta).toBe(false)
      })

      it('una risposta senza workflow_runs, o non JSON: il backup parte', async () => {
          expect((await unaGuardia({ status: 200, testo: '{}' })).d.salta).toBe(false)
          expect((await unaGuardia({ status: 200, testo: '<html>' })).d.salta).toBe(false)
      })

      it('la rete cade: il backup parte', async () => {
          const { d, righe } = await unaGuardia(new Error('timeout'))

          expect(d.salta).toBe(false)
          expect(righe).toContain('timeout')
      })
  })
  ```

- [ ] **Passo 2: rosso.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-guardia-notte.test.ts
  ```
  Atteso: FAIL, `Failed to load url ../../scripts/backup/guardia-notte.mjs` (il file non esiste). Controlla che il
  riepilogo dica `Test Files  1 failed (1)`: un percorso sbagliato farebbe uscire vitest con 0 senza eseguire niente.

- [ ] **Passo 3: codice.** Crea `scripts/backup/guardia-notte.mjs`:
  ```js
  // LA GUARDIA DELLE 20 ORE del backup notturno. La chiama il job `guardia` di
  // `.github/workflows/backup-notturno.yml`, SOLO sui giri dello `schedule` di GitHub.
  //
  // Robustezza, seconda serie, sessione 4 (S4). Il backup lo lancia alle 02:23 UTC il monitor esterno
  // (Worker di Cloudflare, `origine=cloudflare`). Lo `schedule` di GitHub resta come riserva, ma arriva
  // fra le 07:00 e le 09:35 UTC (8 notti misurate, rapporto del 20/10): senza guardia farebbe un secondo
  // backup completo nella stessa mattina, nella punta delle scuole.
  //
  // Regola: se un backup COMPLETO è riuscito nelle ultime 20 ore, questo giro si annulla (lo annulla il
  // passo dopo del workflow, con `gh run cancel`). 20 ore stanno sopra il ritardo peggiore dello schedule
  // (7 h 12 min) e sotto la distanza fra due notti (24 h): la notte dopo non viene mai saltata.
  //
  // FAIL-OPEN: se non riesce a leggere i giri (rete, token, risposta strana) il backup PARTE. Due copie in
  // una notte costano qualche centesimo; nessuna copia costa i dati.
  //
  // Nessun segreto: usa il token che GitHub dà a ogni giro. Non stampa nomi né dati: solo numeri di giro,
  // ore e l'esito.

  import { appendFileSync } from 'node:fs'
  import { pathToFileURL } from 'node:url'

  export const WORKFLOW = 'backup-notturno.yml'
  export const ORE_GUARDIA = 20
  /** Il titolo (`run-name`) di un giro completo: «Backup notturno completo», con o senza « (da Cloudflare)». */
  export const TITOLO_COMPLETO = 'Backup notturno completo'
  const ORA_MS = 3_600_000
  const TEMPO_MAX_MS = 15_000

  /**
   * Vale come «backup completo riuscito» un giro riuscito, che non è QUESTO giro, ed è completo: un giro
   * dello `schedule` (sempre completo) o un giro il cui titolo dice «completo» (il Worker, o il titolare
   * a mano). Un giro di `prova` non vale: scrive solo sotto `prove/`.
   */
  export function eCompletoRiuscito(g, idCorrente) {
      if (!g || g.conclusion !== 'success') return false
      if (String(g.id) === String(idCorrente)) return false
      if (g.event === 'schedule') return true
      return typeof g.display_title === 'string' && g.display_title.startsWith(TITOLO_COMPLETO)
  }

  /** La decisione, pura: `{ salta, perche }`. `adesso` in millisecondi. */
  export function decidi({ giri, adesso, idCorrente }) {
      for (const g of giri ?? []) {
          if (!eCompletoRiuscito(g, idCorrente)) continue
          const fine = Date.parse(g.updated_at)
          if (!Number.isFinite(fine) || fine > adesso) continue
          const ore = (adesso - fine) / ORA_MS
          if (ore <= ORE_GUARDIA) {
              return { salta: true, perche: `backup completo già riuscito ${ore.toFixed(1)} ore fa (giro ${g.id}): questo giro dello schedule si annulla` }
          }
      }
      return { salta: false, perche: `nessun backup completo riuscito nelle ultime ${ORE_GUARDIA} ore: il backup parte` }
  }

  /** Legge i giri riusciti e decide. Non lancia mai: un guasto qui = il backup parte. */
  export async function esegui({ repo, token, idCorrente, adesso = Date.now(), fetchImpl = fetch, log = (r) => console.log(r) }) {
      try {
          if (!repo || !token) throw new Error('mancano GITHUB_REPOSITORY o GH_TOKEN')
          const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/runs?status=success&per_page=30`, {
              headers: {
                  Authorization: `Bearer ${token}`,
                  Accept: 'application/vnd.github+json',
                  'X-GitHub-Api-Version': '2022-11-28',
                  'User-Agent': 'kidville-guardia-backup',
              },
              signal: AbortSignal.timeout(TEMPO_MAX_MS),
          })
          const testo = await res.text()
          if (res.status !== 200) throw new Error(`GitHub ha risposto HTTP ${res.status}: ${testo.slice(0, 300)}`)
          const giri = JSON.parse(testo)?.workflow_runs
          if (!Array.isArray(giri)) throw new Error('risposta senza workflow_runs')
          const d = decidi({ giri, adesso, idCorrente })
          log(`guardia: esito=${d.salta ? 'salta' : 'parte'} giri_letti=${giri.length} · ${d.perche}`)
          return d
      } catch (err) {
          const motivo = err instanceof Error ? err.message : String(err)
          log(`::warning::guardia: esito=non-verificabile, il backup parte comunque: ${motivo}`)
          return { salta: false, perche: `non verificabile: ${motivo}` }
      }
  }

  async function main() {
      const d = await esegui({ repo: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN, idCorrente: process.env.GITHUB_RUN_ID })
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `salta=${d.salta ? 'true' : 'false'}\n`)
  }

  if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
      main().catch((err) => {
          console.log(`::warning::guardia caduta, il backup parte comunque: ${err instanceof Error ? err.message : String(err)}`)
      })
  }
  ```

- [ ] **Passo 4: verde.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-guardia-notte.test.ts
  ```
  Atteso: `Test Files  1 passed (1)`.

- [ ] **Passo 5: commit.**
  ```bash
  git add scripts/backup/guardia-notte.mjs __tests__/lib/backup-guardia-notte.test.ts
  git commit -m "Robustezza 2, sessione 4: guardia delle 20 ore per lo schedule del backup (fail-open)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Compito 8: il workflow (titolo, `origine`, guardia) e il suo lock

**File:**
- Modifica: `.github/workflows/backup-notturno.yml:23-27, 48, 50-51, 66, 97-100`
- Modifica: `__tests__/architecture/backup-notturno-sicuro.test.ts:17-35, 176-192, 194-221, 232, 308-313, 346-398`
- Test: `__tests__/lib/backup-guardia-notte.test.ts` (prova di coerenza dei titoli)

- [ ] **Passo 1: il lock prima del workflow.** In `__tests__/architecture/backup-notturno-sicuro.test.ts`:

  Nella testata (righe 21 e 34-35) sostituisci la riga `PERMESSI` con:
  ```ts
   *  PERMESSI  `contents: read` e basta; solo il job `avviso` può avere in più `issues: write`, e solo il
   *            job `guardia` `actions: write` (serve ad annullare SÉ STESSO, e a nient'altro).
  ```
  e dopo la riga `ALLARME … poi manda l'email.` aggiungi:
  ```ts
   *  GUARDIA   gira solo sullo `schedule`, senza segreti, con ogni passo `continue-on-error`; può
   *            annullare solo il proprio giro (`gh run cancel "$GITHUB_RUN_ID"`); il backup ne dipende
   *            con `!cancelled()`, così parte anche quando la guardia è saltata.
  ```
  Sostituisci il ciclo dei job e dei permessi (righe 176-192) con:
  ```ts
      for (const atteso of ['guardia', 'backup', 'guasto_simulato', 'avviso']) {
          if (!job.includes(atteso)) v.push(`manca il job ${atteso}`)
      }
      for (const nome of job) {
          const b = blocco(c, nome) ?? ''
          if (!/^\s{4}timeout-minutes:\s*\d+/m.test(b)) v.push(`job ${nome}: manca timeout-minutes`)
          if (!/^\s{4}runs-on:\s*ubuntu-24\.04\s*$/m.test(b)) v.push(`job ${nome}: runs-on deve essere ubuntu-24.04 (fissato, non latest)`)
          const perm = /^\s{4}permissions:\s*\n((?:\s{6}\S.*\n?)+)/m.exec(b)
          const dichiarati = perm ? perm[1].trim().split('\n').map((x) => x.trim()).sort() : []
          if (nome === 'avviso') {
              if (dichiarati.join('|') !== 'contents: read|issues: write') {
                  v.push('permessi: avviso deve avere esattamente `contents: read` e `issues: write`')
              }
          } else if (nome === 'guardia') {
              if (dichiarati.join('|') !== 'actions: write|contents: read') {
                  v.push('permessi: guardia deve avere esattamente `actions: write` (per annullare SÉ STESSA) e `contents: read`')
              }
          } else if (perm) {
              v.push(`permessi: il job ${nome} non deve dichiarare permessi propri`)
          }
      }
  ```
  Subito dopo `if (!/exit 1/.test(guasto)) …` (riga 209) aggiungi:
  ```ts

      // ── LA GUARDIA DELLE 20 ORE ────────────────────────────────────────────
      // Gira SOLO sullo schedule (il lancio delle 02:23 dal Worker e i giri a mano non si fermano mai da
      // soli), può annullare SOLO il giro in cui sta, non tocca segreti e non può fallire: un suo guasto non
      // deve né fermare il backup né far suonare l'avviso del backup (`failure()` vede tutti gli antenati).
      const guardia = blocco(c, 'guardia') ?? ''
      if (!/^\s{4}if:\s*\$\{\{\s*github\.event_name\s*==\s*'schedule'\s*\}\}\s*$/m.test(guardia)) {
          v.push("guardia: deve girare solo sullo schedule (`if: ${{ github.event_name == 'schedule' }}`)")
      }
      if (/secrets\./.test(guardia)) v.push('guardia: nessun segreto nel job guardia')
      if (/^\s{4}environment:/m.test(guardia)) v.push('guardia: non deve stare in un ambiente')
      if (!/node scripts\/backup\/guardia-notte\.mjs/.test(guardia)) v.push('guardia: deve passare da scripts/backup/guardia-notte.mjs')
      for (const m of guardia.matchAll(/\bgh[ \t]+([a-z-]+)[ \t]+([a-z-]+)/g)) {
          if (`${m[1]} ${m[2]}` !== 'run cancel') v.push(`guardia: comando gh non ammesso: gh ${m[1]} ${m[2]}`)
      }
      for (const riga of guardia.split('\n')) {
          if (/\bgh[ \t]+run[ \t]+cancel\b/.test(riga) && !/gh run cancel "\$GITHUB_RUN_ID"/.test(riga)) {
              v.push('guardia: può annullare solo SÉ STESSA (`gh run cancel "$GITHUB_RUN_ID"`)')
          }
      }
      const passiGuardia = (guardia.match(/^\s{6}- /gm) ?? []).length
      const tolleranti = (guardia.match(/^\s{8}continue-on-error:\s*true\s*$/gm) ?? []).length
      if (passiGuardia === 0 || tolleranti !== passiGuardia) {
          v.push('guardia: ogni passo deve avere continue-on-error: true (una guardia rotta non ferma il backup)')
      }
      if (!/^\s{4}needs:\s*guardia\s*$/m.test(backup)) v.push('backup: deve dipendere dalla guardia (`needs: guardia`)')
      if (!/^\s{4}if:\s*\$\{\{\s*!cancelled\(\)\s*&&/m.test(backup)) {
          v.push('backup: deve partire con `!cancelled() && …` (con la guardia saltata il backup parte lo stesso)')
      }
  ```
  Sostituisci la riga 220 (`if (!/persist-credentials:\s*false/.test(c)) …`) con:
  ```ts
      // Ogni checkout, non uno qualunque: con la guardia i checkout sono due.
      const checkout = (c.match(/uses:\s*actions\/checkout@v4/g) ?? []).length
      const chiusi = (c.match(/persist-credentials:\s*false/g) ?? []).length
      if (chiusi === 0 || chiusi < checkout) v.push('checkout: manca persist-credentials: false')
  ```
  Sostituisci la riga 232 con:
  ```ts
          if (/inputs\./.test(riga) && !/^\s*(MODALITA|SIMULATO|if|run-name)\s*:/.test(riga)) {
  ```
  Nella prova del file (righe 310-312) aggiungi lo script della guardia:
  ```ts
          for (const s of ['dump-cifrato.sh', 'specchio-storage.sh', 'guardia-notte.mjs']) {
  ```
  In `MUTAZIONI`, prima della chiusura `]` (riga 398), aggiungi:
  ```ts
          ['guardia anche sui giri a mano', (s) => s.replace("    if: ${{ github.event_name == 'schedule' }}", '    if: ${{ always() }}'), /guardia: deve girare solo sullo schedule/],
          ['guardia con contents: write', (s) => s.replace('      actions: write\n      contents: read', '      actions: write\n      contents: write'), /guardia deve avere esattamente/],
          ['guardia senza permessi propri', (s) => s.replace('    permissions:\n      actions: write\n      contents: read\n', ''), /guardia deve avere esattamente/],
          ['guardia che annulla un altro giro', (s) => s.replace('gh run cancel "$GITHUB_RUN_ID"', 'gh run cancel "$ALTRO_GIRO"'), /può annullare solo SÉ STESSA/],
          ['guardia che spegne il workflow', (s) => s.replace('          if gh run cancel', '          gh workflow disable backup-notturno.yml\n          if gh run cancel'), /comando gh non ammesso: gh workflow disable/],
          ['guardia con un segreto', (s) => s.replace('        run: node scripts/backup/guardia-notte.mjs', '          ALTRO: ${{ secrets.BACKUP_DB_URL }}\n        run: node scripts/backup/guardia-notte.mjs'), /nessun segreto nel job guardia/],
          ['guardia che può fallire', (s) => s.replace('        id: cerca\n        continue-on-error: true\n', '        id: cerca\n'), /ogni passo deve avere continue-on-error/],
          ['backup senza la guardia', (s) => s.replace('    needs: guardia\n', ''), /deve dipendere dalla guardia/],
          ['backup senza !cancelled()', (s) => s.replace('    if: ${{ !cancelled() && !inputs.simula_guasto }}', '    if: ${{ !inputs.simula_guasto }}'), /deve partire con `!cancelled\(\)/],
  ```

- [ ] **Passo 2: rosso.**
  ```bash
  CI=1 npx vitest run __tests__/architecture/backup-notturno-sicuro.test.ts
  ```
  Atteso: FAIL su «rispetta tutte le regole» (`manca il job guardia`, `guardia: deve girare solo sullo schedule`,
  `backup: deve dipendere dalla guardia`, …) e sulle nove nuove mutazioni con `la mutazione non ha cambiato niente`. «Il file esiste»
  resta verde: `guardia-notte.mjs` c'è dal Compito 7.

- [ ] **Passo 3: il workflow.** In `.github/workflows/backup-notturno.yml` sostituisci le righe 23-27 della testata con:
  ```yaml
  # OGNI NOTTE. Alle 02:23 UTC (dopo il backup fisico di Supabase delle 01:00 e prima dei cron
  # dell'app delle 03:30) lo lancia il MONITOR ESTERNO, il Worker di Cloudflare
  # `monitor-esterno/worker.mjs`, con `modalita=completo` e `origine=cloudflare`: il cron di
  # Cloudflare è puntuale, quello di GitHub no (8 notti misurate, partenze fra 07:04 e 09:35 UTC).
  # Lo `schedule` qui sotto resta come RISERVA, alla stessa ora: se il Worker ha già fatto il backup,
  # la guardia delle 20 ore annulla il giro. Schedule armato il 2026-10-06; Worker dalla sessione 4
  # della seconda serie di robustezza.
  ```
  Sostituisci la riga 48 (`# COME SI SPEGNE. …`) con:
  ```yaml
  # COME SI SPEGNE. `gh workflow disable backup-notturno.yml`. Nessun effetto sulla produzione. Il
  # Worker delle 02:23 legge lo stato `disabled_manually` e NON lo riaccende (riattiva soltanto lo
  # spegnimento automatico di GitHub per inattività, `disabled_inactivity`).
  ```
  Fra la riga `# ───…` che chiude la testata (riga 49) e `on:` (riga 51) inserisci:
  ```yaml
  # Il titolo di ogni giro. «Backup notturno completo (da Cloudflare)» è il lancio delle 02:23 UTC del
  # monitor esterno: lo riconoscono il campanello (`valutaBackup`) e la guardia delle 20 ore qui sotto.
  run-name: Backup notturno ${{ inputs.modalita || 'completo' }}${{ inputs.origine == 'cloudflare' && ' (da Cloudflare)' || '' }}

  ```
  Dopo l'input `simula_guasto` (dopo la riga 66, `default: false`) aggiungi:
  ```yaml
        origine:
          description: "Chi lancia il giro: vuoto = a mano; cloudflare = il monitor esterno delle 02:23 UTC (cambia solo il titolo del giro)"
          type: string
          default: ""
  ```
  Sostituisci le righe 97-100 (`jobs:`, `  backup:`, `name:`, `if:`) con:
  ```yaml
  jobs:
    # LA GUARDIA DELLE 20 ORE (robustezza, seconda serie, sessione 4). Il backup lo lancia alle 02:23
    # UTC il monitor esterno; lo `schedule` qui sopra resta come riserva, ma GitHub lo fa arrivare fra
    # le 07:00 e le 09:35. Se un backup completo è già riuscito nelle ultime 20 ore, il giro dello
    # schedule ANNULLA SÉ STESSO: niente secondo backup nella punta delle scuole, e il giro risulta
    # «cancelled», non «success» (il campanello conta solo i successi veri). Ogni passo ha
    # `continue-on-error`: una guardia rotta non ferma il backup e non fa suonare l'avviso.
    guardia:
      name: Guardia delle 20 ore (solo sui giri dello schedule)
      if: ${{ github.event_name == 'schedule' }}
      runs-on: ubuntu-24.04
      timeout-minutes: 5
      permissions:
        actions: write
        contents: read
      steps:
        - uses: actions/checkout@v4
          continue-on-error: true
          with:
            persist-credentials: false
            sparse-checkout: scripts/backup

        - name: Cerca un backup completo riuscito nelle ultime 20 ore
          id: cerca
          continue-on-error: true
          env:
            GH_TOKEN: ${{ github.token }}
          run: node scripts/backup/guardia-notte.mjs

        - name: Annulla questo giro (il backup di stanotte c'è già)
          if: ${{ steps.cerca.outputs.salta == 'true' }}
          continue-on-error: true
          env:
            GH_TOKEN: ${{ github.token }}
          run: |
            set -uo pipefail
            if gh run cancel "$GITHUB_RUN_ID" --repo "$GITHUB_REPOSITORY"; then
              echo "::notice::giro annullato dalla guardia: un backup completo è già riuscito nelle ultime 20 ore"
              sleep 120
            fi
            echo "::warning::l'annullamento non è arrivato: il backup parte comunque (meglio due copie che nessuna)"

    backup:
      name: Dump del database e specchio dei file
      needs: guardia
      # `!cancelled()` e non il `success()` implicito: con la guardia SALTATA (giro a mano o lanciato dal
      # Worker) il backup deve partire lo stesso; con il giro annullato dalla guardia, non parte.
      if: ${{ !cancelled() && !inputs.simula_guasto }}
  ```
  `ESCLUDI_BUCKET` (riga 87) **non** si tocca (T2).

- [ ] **Passo 4: verde il lock.**
  ```bash
  CI=1 npx vitest run __tests__/architecture/backup-notturno-sicuro.test.ts
  ```
  Atteso: `Test Files  1 passed (1)`, con «controllo positivo: la base passa» e tutte le mutazioni rosse come
  devono. Se una mutazione vecchia segnala `la mutazione non ha cambiato niente`, il testo che sostituisce è
  cambiato: si corregge il workflow, non la mutazione.

- [ ] **Passo 5: la prova di coerenza dei titoli (rossa, poi verde).** In `__tests__/lib/backup-guardia-notte.test.ts`
  aggiungi in cima, dopo il primo import:
  ```ts
  import { readFileSync } from 'node:fs'
  import { join } from 'node:path'
  import { TITOLO_BACKUP_DA_FUORI } from '../../scripts/campanello/valuta.mjs'
  import { TITOLO_DA_FUORI } from '../../scripts/campanello/allarme.mjs'
  ```
  e in fondo al file:
  ```ts
  describe('i titoli che legano il workflow, la guardia e il campanello', () => {
      it('il run-name produce «Backup notturno completo» e, dal Worker, « (da Cloudflare)»', () => {
          const yml = readFileSync(join(process.cwd(), '.github/workflows/backup-notturno.yml'), 'utf8')
          expect(yml).toContain(
              "run-name: Backup notturno ${{ inputs.modalita || 'completo' }}${{ inputs.origine == 'cloudflare' && ' (da Cloudflare)' || '' }}",
          )
          expect(TITOLO_COMPLETO).toBe('Backup notturno completo')
          expect(TITOLO_BACKUP_DA_FUORI).toBe(`${TITOLO_COMPLETO} ${TITOLO_DA_FUORI}`)
          expect(DA_FUORI).toBe(TITOLO_BACKUP_DA_FUORI)
      })
  })
  ```
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-guardia-notte.test.ts __tests__/lib/monitor-esterno.test.ts __tests__/lib/campanello-valuta.test.ts
  ```
  Atteso: `Test Files  3 passed (3)`. Per vederla rossa una volta, cambia a mano `' (da Cloudflare)'` in
  `' (Cloudflare)'` nel `run-name`, rilancia (FAIL su `toContain`), poi rimetti il testo giusto.

- [ ] **Passo 6: commit.**
  ```bash
  git add .github/workflows/backup-notturno.yml __tests__/architecture/backup-notturno-sicuro.test.ts __tests__/lib/backup-guardia-notte.test.ts
  git commit -m "Robustezza 2, sessione 4: backup-notturno.yml con run-name, input origine e guardia delle 20 ore; lock aggiornato" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Compito 9: i quattro bucket creati da una migrazione

**File:**
- Crea: `supabase/migrations/<V>_bucket_dichiarati_dalla_produzione.sql`
- Modifica: `__tests__/architecture/bucket-storage-dichiarati.test.ts:64-75, 282-293, 316-341, 548-571, 1085-1102, 1204-1218`

- [ ] **Passo 1: le prove rosse.** In `__tests__/architecture/bucket-storage-dichiarati.test.ts` cambia la firma di
  `visibilitaDichiarata` (riga 329) e il suo ciclo (riga 331):
  ```ts
  function visibilitaDichiarata(
    bucket: string,
    statement: { file: string; sql: string }[] = statementDelBucket(bucket),
  ): { pubblico: boolean; file: string } | null {
    let ultima: { pubblico: boolean; file: string } | null = null
    for (const s of statement) {
  ```
  Subito dopo la fine di `visibilitaDichiarata` (riga 341) aggiungi:
  ```ts

  /**
   * Gli id dei bucket che una migrazione CREA: `insert into storage.buckets (…) values (…), (…)`.
   * Tutte le tuple, non solo la prima (`20260916190000_video_jobs.sql` ne crea due in un'istruzione).
   * Un `update` non crea niente: su un database nuovo non trova la riga e non fa nulla. È il motivo per
   * cui `avvisi_allegati`, `task_allegati` e `form_attachments` erano «dichiarati» ma non ricostruibili.
   */
  function bucketCreatiInMigrazione(statement: { file: string; sql: string }[] = STATEMENT): Set<string> {
    const creati = new Set<string>()
    for (const s of statement) {
      const m = s.sql.match(/insert\s+into\s+storage\.buckets\s*\([^)]*\)\s*values([\s\S]*?)(?:\bon\s+conflict\b|$)/i)
      if (!m) continue
      for (const t of m[1].matchAll(/\(\s*'([a-z0-9_-]+)'/gi)) creati.add(t[1])
    }
    return creati
  }
  ```
  Dopo la prova «nessun bucket sfugge alla classificazione» (riga 1218) aggiungi:
  ```ts

      it('ogni bucket della produzione è CREATO da una migrazione (si ricostruisce da zero)', () => {
        // Scenario E del runbook: progetto perso, schema rifatto dai file. Un bucket che esiste solo in
        // produzione, su un progetto nuovo non c'è, e i suoi file ricaricati dallo specchio non hanno
        // dove andare. Fino alla sessione 4 della seconda serie erano quattro.
        const creati = bucketCreatiInMigrazione()
        const mancanti = foto.bucket.map((b) => b.id).filter((id) => !creati.has(id))
        expect(
          mancanti,
          `Questi bucket esistono in produzione ma nessuna migrazione li CREA (un \`update\` non basta):\n` +
            `  ${mancanti.join('\n  ')}\n` +
            'Scrivi una migrazione `insert into storage.buckets (…) values (…) on conflict (id) do nothing`, ' +
            'un bucket per istruzione, con le impostazioni lette dalla produzione.',
        ).toEqual([])
      })

      it('il lettore dei bucket creati legge tutte le tuple e non scambia un update per una creazione (sanity)', () => {
        const creati = bucketCreatiInMigrazione()
        expect(creati.has('video_processing'), 'seconda tupla di un INSERT a due').toBe(true)
        expect(creati.has('storici-stampe'), '`values(` senza spazio').toBe(true)
        expect(creati.size).toBeGreaterThan(15)
        const finte = [
          { file: 'a.sql', sql: "update storage.buckets set public = false where id = 'avvisi_allegati'" },
          { file: 'b.sql', sql: "insert into storage.buckets (id, name) values ('uno', 'uno'), ('due', 'due') on conflict (id) do nothing" },
        ]
        expect([...bucketCreatiInMigrazione(finte)].sort()).toEqual(['due', 'uno'])
      })
  ```

- [ ] **Passo 2: rosso.**
  ```bash
  CI=1 npx vitest run __tests__/architecture/bucket-storage-dichiarati.test.ts -t "CREATO da una migrazione"
  ```
  Atteso: FAIL, con `mancanti` = `avvisi_allegati`, `form_attachments`, `registro-allegati`, `task_allegati`. Se
  l'elenco è diverso, ci si ferma: o la fotografia è cambiata (Passo 0.5) o il lettore sbaglia.

- [ ] **Passo 3: la migrazione.** Prendi la version adesso, mai un orario tondo o futuro:
  ```bash
  V=$(date -u +%Y%m%d%H%M%S); echo "$V"
  ```
  Controlla che `$V` sia maggiore di `generato_alle` in `__tests__/fixtures/migrazioni-applicate-snapshot.json` e
  dell'ultima migrazione di `ls supabase/migrations | tail -n 1`. Poi crea
  `supabase/migrations/${V}_bucket_dichiarati_dalla_produzione.sql`, con i valori **letti al Passo 0.4** (sotto ci
  sono quelli attesi; se la produzione ne ha di diversi, valgono quelli della produzione):
  ```sql
  -- =============================================================================
  -- I BUCKET CHE ESISTEVANO SOLO IN PRODUZIONE, ADESSO CREATI DA UNA MIGRAZIONE
  --
  -- Robustezza, seconda serie, sessione 4 (D5 in parte). Una ricostruzione da zero (scenario E del
  -- runbook: progetto Supabase perso) rifà lo schema dai file di `supabase/migrations/`. Al 20/10 le
  -- migrazioni creavano 17 bucket su 21. Ne mancavano quattro: `avvisi_allegati`, `task_allegati` e
  -- `form_attachments` erano nati dalla console (le migrazioni li AGGIORNAVANO soltanto, e un `update`
  -- su una riga che non c'è non fa niente); `registro-allegati` era nato da una `createBucket` della
  -- route `src/app/api/primaria/allegati/route.ts`. Su un progetto nuovo i loro file, ricaricati dallo
  -- specchio, non avrebbero avuto dove andare.
  --
  -- Le impostazioni sono quelle LETTE DALLA PRODUZIONE al Passo 0 della sessione, con
  --   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id in (…)
  -- e coincidono con quelle che il repo già dichiara: `src/lib/allegati/mime.ts` per avvisi e task,
  -- `20260802191025_form_attachments_tipi_e_limite.sql`, `src/lib/primaria/allegati-registro.ts`.
  --
  -- `on conflict (id) do nothing`: in produzione i quattro bucket ci sono già e NON si toccano (zero
  -- righe). La migrazione cambia qualcosa solo su un database nuovo. Con `do update` un errore di
  -- lettura al Passo 0 finirebbe in produzione; così resta, al più, su un ambiente ricostruito.
  -- Un bucket per istruzione: il lock `bucket-storage-dichiarati` legge la PRIMA tupla di ogni INSERT.
  --
  -- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
  --   In produzione, dopo il merge: una riga in `app_log` con fingerprint
  --   `sql:bucket-dichiarati-dalla-produzione`, esito `bucket-dichiarati` e `n_nuovi` = 0.
  --   Nel repo: `__tests__/architecture/bucket-storage-dichiarati.test.ts`, prova «ogni bucket della
  --   produzione è CREATO da una migrazione».
  --
  -- ─── ROLLBACK ────────────────────────────────────────────────────────────────
  --   In produzione non c'è niente da annullare: la migrazione non vi cambia nessuna riga.
  --   Su un ambiente ricostruito, un bucket nato da qui e ancora VUOTO si toglie dal pannello
  --   (Storage → bucket → Delete) o con l'API dello Storage; un bucket con dei file NON si toglie.
  --   Il file resta nel repo anche dopo un revert: è applicato, e toglierlo farebbe diventare rosso
  --   `migrazioni-complete` («applicata in produzione ma senza file»).
  -- =============================================================================

  begin;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'avvisi_allegati', 'avvisi_allegati', false, 10485760,
    array['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
          'application/pdf', 'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document']::text[]
  )
  on conflict (id) do nothing;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'task_allegati', 'task_allegati', false, 10485760,
    array['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
          'application/pdf', 'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document']::text[]
  )
  on conflict (id) do nothing;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'form_attachments', 'form_attachments', false, 8388608,
    array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']::text[]
  )
  on conflict (id) do nothing;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'registro-allegati', 'registro-allegati', false, 10485760,
    array['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']::text[]
  )
  on conflict (id) do nothing;

  do $$
  declare
    v_nuovi integer;
  begin
    -- I bucket nati in QUESTA transazione hanno `created_at` = now(), l'istante della transazione.
    -- In produzione deve dire 0. Il conteggio si scrive SEMPRE, anche quando è zero: «nessun log» non
    -- distingue «non c'era niente da creare» da «la migrazione non è mai partita».
    -- `sorgente` = 'server' (il vincolo ammette solo 'server' | 'client'); chi distingue i lavori SQL è
    -- il prefisso `sql:` del fingerprint. Il log si scrive solo se `app_log` c'è (sul DB della CI no).
    select count(*) into v_nuovi from storage.buckets where created_at = now();
    if to_regclass('public.app_log') is not null then
      insert into public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
      values (
        'info',
        'storage',
        'server',
        'bucket dichiarati dalla produzione: creati solo quelli che mancavano',
        'sql:bucket-dichiarati-dalla-produzione',
        jsonb_build_object(
          'esito', 'bucket-dichiarati',
          'n_nuovi', v_nuovi,
          'n_dichiarati', 4,
          'operazione', 'migrazione/bucket_dichiarati_dalla_produzione'
        )
      )
      on conflict (fingerprint, giorno) do update
        set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
    end if;
  end $$;

  commit;
  ```

- [ ] **Passo 4: la nuova prova è verde, l'attesa diventa una voce morta.**
  ```bash
  CI=1 npx vitest run __tests__/architecture/bucket-storage-dichiarati.test.ts
  ```
  Atteso: verdi le due prove nuove; FAIL su «`IN_ATTESA_DI_UN_LIMITE` non contiene voci morte», con
  `registro-allegati`. È voluto: l'attesa è finita.

- [ ] **Passo 5: si chiude l'attesa e si aggiornano i commenti.** Sostituisci `IN_ATTESA_DI_UN_LIMITE` (righe 555-571) con:
  ```ts
  const IN_ATTESA_DI_UN_LIMITE: Record<string, string | undefined> = {
    // ─── VUOTA DALLA SESSIONE 4 DELLA SECONDA SERIE ─────────────────────────────
    // L'unica voce, `registro-allegati` (riaperta il 2026-09-25: il tetto viveva solo nella
    // `createBucket` della route), è morta come doveva: la migrazione
    // `*_bucket_dichiarati_dalla_produzione.sql` crea il bucket con 10485760 byte, letti dalla
    // produzione. Il meccanismo resta per il prossimo bucket nato fuori da una migrazione.
  }
  ```
  Nel commento di `registro-allegati` in `RISERVATI` (righe 286-292) sostituisci il pezzo da `⚠️ NATO DA UNA ROUTE`
  a `dichiarato in \`IN_ATTESA_DI_UN_LIMITE\`.` con:
  ```ts
    // Nato il 2026-09-23 da una `createBucket` della route `src/app/api/primaria/allegati/route.ts`
    // (privato). Per due giorni è rimasto fuori da questo elenco perché la fotografia dello Storage non
    // era stata rigenerata. Dalla sessione 4 della seconda serie lo CREA anche una migrazione
    // (`*_bucket_dichiarati_dalla_produzione.sql`), con le impostazioni lette dalla produzione.
  ```
  Nella testata (righe 64-67) sostituisci da `PERCHÉ LA VISIBILITÀ SI GUARDA IN DUE POSTI. Otto bucket` a
  `traccia in nessun file. Quindi:` con:
  ```ts
  // PERCHÉ LA VISIBILITÀ SI GUARDA IN DUE POSTI. Fino alla sessione 4 della seconda serie quattro bucket
  // su ventuno non erano CREATI da nessuna migrazione (tre nati dalla console, uno da una route); ora lo
  // sono tutti, e la prova «ogni bucket della produzione è CREATO da una migrazione» lo pretende. Resta
  // vero che un bucket riaperto dalla console non lascia traccia in nessun file. Quindi:
  ```
  Nella prova «la migrazione che ha chiuso gli allegati è ancora nel repo e dice `false`» (righe 1085-1102)
  sostituisci la riga del `for` e quella di `visibilitaDichiarata` con:
  ```ts
        // Dalla sessione 4 della seconda serie i due bucket sono anche CREATI (privati) da un INSERT più
        // recente: senza il filtro sul file, questa prova leggerebbe quello e smetterebbe di collaudare il
        // ramo UPDATE del parser, che è la ragione per cui esiste.
        const CHIUSURA = '20260731192108_allegati_avvisi_task_bucket_privati.sql'
        for (const bucket of ['avvisi_allegati', 'task_allegati']) {
          const dichiarata = visibilitaDichiarata(bucket, statementDelBucket(bucket).filter((s) => s.file === CHIUSURA))
  ```

- [ ] **Passo 6: verde tutto ciò che legge le migrazioni.**
  ```bash
  CI=1 npx vitest run __tests__/architecture
  ```
  Atteso: `__tests__/architecture` verde; in particolare `bucket-storage-dichiarati`, `allegati-mime-dichiarati`
  (avvisi e task: i nove tipi di `MIME_ALLEGATI_AMMESSI`, 10485760), `upload-pubblico-con-tetto` (legge solo la
  forma `=`, invariata) e `migrazioni-complete` (file in coda, posteriore alla fotografia).

- [ ] **Passo 7: commit.**
  ```bash
  git add supabase/migrations/*_bucket_dichiarati_dalla_produzione.sql __tests__/architecture/bucket-storage-dichiarati.test.ts
  git commit -m "Robustezza 2, sessione 4: i quattro bucket solo di produzione creati da una migrazione idempotente" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Compito 10: Vault, chiavi e documenti

**File:**
- Modifica: `docs/runbook-ripristino.md:37-55, 179, 229, 238` (righe del 20/10: le sostituzioni si fanno per contenuto, Passo 3), `docs/cicd.md:170-171, 196-203, 249-294, 305-311, 337, 360-376` (righe del 20/10, ogni punto del Passo 4 dice il testo da cercare)
- Modifica: `.gitignore:42-46`, `__tests__/architecture/backup-notturno-sicuro.test.ts:2-4, 423-430` e un `describe` nuovo in fondo

- [ ] **Passo 1: la prova rossa dei nomi del Vault.** In `__tests__/architecture/backup-notturno-sicuro.test.ts` la
  riga 3 diventa:
  ```ts
  import { existsSync, readdirSync, readFileSync } from 'node:fs'
  ```
  In fondo al file aggiungi:
  ```ts
  describe('LOCK · il runbook sa rimettere i segreti del Vault che i cron leggono', () => {
      /**
       * I cron leggono indirizzi e segreto con `cron_config('<nome>')`, che guarda il Vault. Il dump non
       * porta il Vault, e `ALTER DATABASE … SET` è negato (42501): su un progetto nuovo (scenario E) i nomi
       * li deve dare il runbook. Un nome nuovo in una migrazione che il runbook non elenca è un cron che,
       * dopo un disastro, resta muto senza dirlo.
       */
      const MIGRAZIONI = join(RADICE, 'supabase', 'migrations')
      const RUNBOOK = readFileSync(join(RADICE, 'docs', 'runbook-ripristino.md'), 'utf8')
      const nomi = new Set<string>()
      for (const f of readdirSync(MIGRAZIONI).filter((x) => x.endsWith('.sql'))) {
          for (const m of readFileSync(join(MIGRAZIONI, f), 'utf8').matchAll(/cron_config\(\s*'([a-z0-9_.]+)'\s*\)/gi)) {
              nomi.add(m[1])
          }
      }

      it('i nomi letti dalle migrazioni sono plausibili (sanity)', () => {
          expect(nomi.size).toBeGreaterThanOrEqual(6)
          expect(nomi.has('app.cron_secret')).toBe(true)
      })

      it('ogni nome è nel runbook, con la ricetta del Vault; la ricetta ALTER DATABASE non c\'è più', () => {
          const mancanti = [...nomi].filter((n) => !RUNBOOK.includes('`' + n + '`'))
          expect(mancanti, 'nomi letti dai cron ma assenti da docs/runbook-ripristino.md').toEqual([])
          expect(RUNBOOK).toContain('vault.create_secret')
          expect(RUNBOOK).not.toMatch(/ALTER DATABASE[^\n]*SET app\./i)
          expect(DOC).not.toMatch(/ALTER DATABASE[^\n]*SET app\./i)
      })
  })
  ```

- [ ] **Passo 2: rosso.**
  ```bash
  CI=1 npx vitest run __tests__/architecture/backup-notturno-sicuro.test.ts -t "Vault"
  ```
  Atteso: FAIL, `mancanti` = i cinque URL (`app.cron_secret` c'è già, nella riga «impostazioni del database»), manca `vault.create_secret`, e
  `docs/cicd.md` contiene ancora `ALTER DATABASE postgres SET app.push_dispatch_url` (righe 364-370).

- [ ] **Passo 3: il runbook.** In `docs/runbook-ripristino.md`. Ogni sostituzione si fa **per contenuto**: la
  sessione 3 riscrive gli scenari A0 e A0-bis dello stesso file e allunga i loro blocchi, spostando tutto ciò che
  viene dopo, quindi i numeri di riga qui sotto (letti il 20/10) servono solo a orientarsi. Se un testo da cercare non si
  trova identico, ci si ferma e lo si scrive nella colonna «Note» della riga 4: non si sostituisce «a occhio».

  Nell'elenco **Cosa NON c'è nel dump** (era la riga 39), cerca:
  ```markdown
  - le **impostazioni del database** (`app.cron_secret`, gli URL dei cron…): i loro **nomi** stanno nel manifest, i valori in Vercel (`CRON_SECRET`) e nel passaggio «Cron di produzione» di `docs/cicd.md`;
  ```
  e sostituiscila con:
  ```markdown
  - i **segreti dei cron** (`app.cron_secret` e i cinque URL): stanno nel **Vault** di Supabase, che il dump non copia. Si rimettono con `vault.create_secret`, un nome alla volta (scenario E, passo 6). Il manifest **non** li elenca: legge `pg_db_role_setting`, che è vuoto da quando i segreti sono nel Vault;
  ```
  Subito sotto (era la riga 40), cerca:
  ```markdown
  - le **password dei ruoli** (anche `backup_lettura`) e lo schema `vault`;
  ```
  e sostituiscila con:
  ```markdown
  - le **password dei ruoli** (anche `backup_lettura`);
  ```
  Nella tabella di **Cosa serve per ripristinare, e dove sta** (erano le righe 47-48), cerca le due righe:
  ```markdown
  | **Chiave privata age** | offline, 2 supporti (titolare). Copia di lavoro nella cartella `KIDVILLE-CHIAVI-BACKUP/` dell'app: **ignorata da git** (un lock lo verifica) ma **non è una copia offline** | i dump non si aprono più, per nessuno |
  | **Password e salt di rclone crypt** | offline, 2 supporti (titolare); in GitHub solo per il backup; copia di lavoro in `KIDVILLE-CHIAVI-BACKUP/` (ignorata da git) | i file dello specchio non si aprono più |
  ```
  e sostituiscile con:
  ```markdown
  | **Chiave privata age** | offline, 2 supporti (titolare). Copia di lavoro in `~/KIDVILLE-CHIAVI-BACKUP/`, **fuori** dalla cartella dell'app e da ogni checkout git (vedi sotto) | i dump non si aprono più, per nessuno |
  | **Password e salt di rclone crypt** | offline, 2 supporti (titolare); in GitHub solo per il backup; copia di lavoro in `~/KIDVILLE-CHIAVI-BACKUP/` | i file dello specchio non si aprono più |
  ```
  Dopo il riquadro ⚠️ che chiude quella sezione (era la riga 55), cioè subito dopo la riga
  ```markdown
  > si cancella subito dopo.
  ```
  e prima del titolo `## Collegarsi a R2 (sul Mac, con il token di LETTURA)`, aggiungi:
  ```markdown

  ### Dove sta la copia di lavoro delle chiavi

  Dalla sessione 4 della seconda serie di robustezza la copia di lavoro (chiave privata `age`, password e salt di
  `rclone crypt`) **non** sta più nella cartella dell'app: sta in `~/KIDVILLE-CHIAVI-BACKUP/`, nella cartella personale
  del titolare, fuori da ogni checkout git. Dentro l'app la proteggeva solo `.gitignore`: un `git clean -x` l'avrebbe
  cancellata, e ogni worktree nuovo ne era una copia possibile. La regola di `.gitignore` e il suo lock restano, come
  rete. Le copie **offline** restano due, su due supporti. Questo documento non contiene e non conterrà mai le chiavi.

  - [ ] Cartella spostata fuori dall'app dal titolare, il gg/mm. Nella cartella dell'app
        `ls KIDVILLE-CHIAVI-BACKUP` risponde «No such file or directory».
  - [ ] Revoca della vecchia `sb_secret_` (finita nella storia git di un clone dell'app, rapporto del 20/10, D8)
        confermata dal titolare nel pannello di Supabase (Project Settings → API Keys), il gg/mm.
  ```
  Nello **Scenario B** («Il backup di stanotte è fallito»), passo 3 (era la riga 179), cerca:
  ```markdown
  3. Se il workflow **non parte proprio** (nessuna email, nessun giro): lo vede il campanello (`campanello.yml`, fase 3), che apre `[backup-vecchio]` quando l'ultimo giro automatico riuscito ha più di 30 ore. Si guarda anche a mano con `gh run list --workflow backup-notturno.yml --event schedule`.
  ```
  e sostituiscila con:
  ```markdown
  3. Se il workflow **non parte proprio**: alle 02:23 UTC lo lancia il monitor esterno (Worker di Cloudflare), che in
     quel caso manda subito l'email «Backup notturno NON partito» con la risposta di GitHub. I casi noti:
     - `401 Bad credentials`: il token `GITHUB_TOKEN_CAMPANELLO` è scaduto o revocato → `docs/cicd.md`, «Monitor esterno»;
     - nessuna email e nessun giro: il Worker non è partito (pannello Cloudflare → Workers → `kidville-monitor-esterno` → Logs);
     - `esito=spento-a-mano` nei log del Worker: qualcuno ha spento il workflow; si riaccende con
       `gh workflow enable backup-notturno.yml`.
     Dopo 30 ore senza un giro automatico riuscito il campanello apre `[backup-vecchio]`. A mano:
     `gh run list --workflow backup-notturno.yml --limit 14`. I giri automatici sono «Backup notturno completo (da
     Cloudflare)» e quelli dello `schedule`; uno `schedule` «cancelled» è la guardia delle 20 ore, non un guasto.
  ```
  Nello **Scenario E** («Il progetto Supabase è perso o bloccato»), passo 6 (era la riga 229), cerca:
  ```markdown
  6. Rimetti le **impostazioni del database** (i nomi sono nel manifest) e le **password dei ruoli**.
  ```
  e sostituiscila con:
  ````markdown
  6. Rimetti i **segreti dei cron nel Vault** e le **password dei ruoli**. Il dump non porta lo schema `vault`, e
     `ALTER DATABASE … SET` è negato (`42501`). Dal SQL editor del **nuovo** progetto, una riga per nome, con il
     valore scritto solo lì (mai in un file, in una chat o nel repository):
     ```sql
     select vault.create_secret('<valore>', '<nome>');
     ```
     | Nome | Valore |
     |---|---|
     | `app.cron_secret` | lo stesso di `CRON_SECRET` su Vercel |
     | `app.push_dispatch_url` | `https://<dominio-prod>/api/push/dispatch` (molti cron ne usano solo l'origine) |
     | `app.notifiche_promemoria_url` | `https://<dominio-prod>/api/notifiche/promemoria` |
     | `app.retention_iscrizioni_url` | `https://<dominio-prod>/api/gdpr/retention-iscrizioni` |
     | `app.fattura_sync_url` | `https://<dominio-prod>/api/pagamenti/fattura/sync` |
     | `app.mensa_allergie_url` | `https://<dominio-prod>/api/mensa/allergie-check` |

     Controllo, senza leggere i valori: `select name from vault.secrets order by name;` → sei righe. L'elenco è
     sorvegliato dal lock `backup-notturno-sicuro`: ogni `cron_config('<nome>')` delle migrazioni deve stare qui.
  ````
  In **Dopo QUALSIASI ripristino — lista di controllo** (era la riga 238), cerca:
  ```markdown
  - [ ] Impostazioni del database e password dei ruoli rimesse.
  ```
  e sostituiscila con:
  ```markdown
  - [ ] I sei segreti dei cron rimessi nel Vault (`select name from vault.secrets order by name;` → sei righe) e le password dei ruoli rimesse.
  ```

- [ ] **Passo 4: `docs/cicd.md`.**

  Righe 170-171, la frase «Le impostazioni **del database** (`app.cron_secret` e simili) non sono nel dump: i loro
  nomi sono nel manifest, i valori vanno rimessi a mano dopo un ripristino.» diventa:
  ```markdown
  `auth`. I segreti dei cron (`app.cron_secret` e i cinque URL) stanno nel **Vault**, che il dump non copia: dopo un
  ripristino si rimettono con `vault.create_secret`, un nome alla volta (vedi «Cron di produzione» e lo scenario E del
  runbook).
  ```
  Il punto «**Come si lancia.**» (righe 196-201) diventa:
  ```markdown
  - **Come si lancia.** `gh workflow run backup-notturno.yml -f modalita=prova` (dump vero su `prove/`, specchio su
    tre file sintetici: prova anche il cestino e la cifratura) e poi `-f modalita=completo`.
    `-f simula_guasto=true` fa fallire apposta il giro per vedere arrivare l'allarme (segnalazione + email).
    **Ogni notte alle 02:23 UTC** lo lancia il **monitor esterno** (Worker di Cloudflare, cron puntuale) con
    `modalita=completo` e `origine=cloudflare`: il giro si chiama «Backup notturno completo (da Cloudflare)». Lo
    `schedule` di GitHub (stessa ora, ma arriva fra le 07:00 e le 09:35) resta come **riserva**: il job `guardia` lo
    annulla da sé se un backup completo è riuscito nelle ultime 20 ore, e il giro risulta «cancelled».
    Per fermarlo: `gh workflow disable backup-notturno.yml`. Il Worker legge lo stato `disabled_manually` e **non** lo
    riaccende; riattiva soltanto `disabled_inactivity`, lo spegnimento automatico di GitHub dopo 60 giorni senza attività.
  ```
  Nel punto «**Se fallisce**» (righe 202-203) la frase «Se il workflow non parte affatto non c'è nessun allarme: lo
  copre la fase 3 (heartbeat esterno).» diventa:
  ```markdown
  Se il workflow **non parte**, il Worker manda subito l'email «Backup notturno NON partito» (il secondo canale:
  Resend, senza passare da GitHub); dopo 30 ore senza un giro automatico riuscito il campanello apre `[backup-vecchio]`.
  ```
  Nella sezione «Monitor esterno», dopo il punto 3 dell'elenco numerato (riga 261), quello che finisce con «il suo
  `cron` non rispetta.», aggiungi:
  ```markdown
  4. alle **02:23 UTC** (secondo cron) fa partire `backup-notturno.yml`; se GitHub rifiuta, manda l'email «Backup
     notturno NON partito». Se il sito è giù **e** il campanello non parte, manda l'email «Sito giù e campanello NON
     partito», una per ora. È il **secondo canale**: quando è GitHub a rifiutare, l'allarme del campanello non parte.
  ```
  Il paragrafo «**Il segreto** è uno solo …» (righe 271-274) diventa:
  ```markdown
  **I segreti** sono tre, nei segreti del Worker (mai nel repository, che è pubblico): `GITHUB_TOKEN_CAMPANELLO`, un
  token GitHub **a grana fine** limitato a `kidville-web` e al solo permesso **Actions: read and write**, più
  `RESEND_API_KEY` e `SENTINELLA_DESTINATARI`, gli stessi del campanello. Li mette il titolare:
  `pbpaste | npx wrangler@4.148.0 secret put <NOME>`. Se mancano quelli di Resend, il Worker lo scrive in
  `console.error` e va avanti. Il token scade: la data è scritta qui sotto e in `00 CONTESTO/04_scadenze.md` del brain.
  Alla scadenza si genera un token nuovo con gli stessi limiti e lo si rimette con
  `pbpaste | npx wrangler@4.148.0 secret put GITHUB_TOKEN_CAMPANELLO`.
  ```
  In fondo alla tabella dei comandi (righe 287-291), subito dopo la riga che comincia con `| spegnere |`, aggiungi due righe:
  ```markdown
  | mettere i segreti dell'email (lo fa il titolare) | `pbpaste \| npx wrangler@4.148.0 secret put RESEND_API_KEY`, poi lo stesso per `SENTINELLA_DESTINATARI` |
  | provare l'email del secondo canale | in locale, vedi «Prova del secondo canale» qui sotto |
  ```
  La riga «Il monitor non vede il backup: quello lo guarda `campanello.yml`.» (righe 293-294) diventa:
  ````markdown
  Il monitor lancia il backup ma non ne guarda l'esito: l'età dell'ultimo giro riuscito la guarda `campanello.yml`.

  **Prova del secondo canale (in locale, la fa il titolare).** Dopo le 03:00 UTC, perché la chiave d'idempotenza è
  una per giorno UTC e la prova non deve consumare quella della notte. Nella cartella `monitor-esterno/` il titolare
  crea `.dev.vars` (ignorato da git) con tre righe: `GITHUB_TOKEN_CAMPANELLO=finto-per-la-prova`, `RESEND_API_KEY=` e
  `SENTINELLA_DESTINATARI=` con i valori del campanello. Poi:
  ```bash
  git check-ignore -q .dev.vars && echo "ignorato: ok"
  npx wrangler@4.148.0 dev --test-scheduled
  # in un secondo terminale:
  curl -s "http://localhost:8787/__scheduled?cron=23+2+*+*+*"
  # dopo: Ctrl-C su wrangler dev, poi
  rm .dev.vars
  ```
  Atteso nei log di `wrangler dev`: `monitor-backup: esito=fallito … HTTP 401 {"message":"Bad credentials"…}` e
  `monitor-email: esito=accettata chiave=kidville-backup-non-partito-<oggi> HTTP 200`; l'email arriva ai destinatari.
  ````
  Nella sezione del campanello (righe 308-310) la frase da «Perché solo `schedule`:» a «non si distingue da
  `completo`.» diventa:
  ```markdown
  Quali giri contano: lo `schedule` e il lancio delle 02:23 del monitor esterno («Backup notturno completo (da
  Cloudflare)»). Un giro lanciato a mano no, nemmeno se completo: la copia che conta è quella che parte da sola.
  ```
  Nella riga della tabella delle segnalazioni che comincia con «| `[backup-vecchio]` |» (era la 337), la colonna «Cosa
  vuol dire», oggi «l'ultimo giro **automatico** del backup è più vecchio di 30 ore, o non c'è», diventa:
  ```markdown
  l'ultimo giro **automatico** riuscito del backup (lo `schedule` o «Backup notturno completo (da Cloudflare)») è più vecchio di 30 ore, o non c'è
  ```
  La sezione «Cron di produzione» (righe 360-376), dal paragrafo «Le schedulazioni …» fino al blocco SQL compreso,
  diventa:
  ````markdown
  Le schedulazioni **non** usano Vercel Cron: girano in Postgres (`pg_cron` + `pg_net`) e chiamano gli endpoint
  applicativi via `net.http_post`. Indirizzi e segreto li leggono con `public.cron_config('<nome>')`, che guarda
  **prima il Vault** di Supabase e poi le impostazioni del database. In produzione stanno nel **Vault**:
  `ALTER DATABASE … SET` su Supabase è negato (`42501`), e la vecchia ricetta con i GUC non funziona più.

  Su un progetto nuovo si rimettono dal SQL editor, una riga per nome, con il valore scritto solo lì:

  ```sql
  select vault.create_secret('<valore>', '<nome>');
  ```

  L'elenco dei sei nomi e dei loro valori è nello scenario E di `docs/runbook-ripristino.md` (passo 6). Si controlla
  senza leggere i valori con `select name from vault.secrets order by name;`.
  ````

- [ ] **Passo 5: `.gitignore` e il commento del lock delle chiavi.** In `.gitignore` sostituisci le righe 42-45 del commento con:
  ```gitignore
  # chiavi del BACKUP esterno (chiave privata age, password di cifratura dei file): MAI nel repository,
  # che è PUBBLICO. Dalla sessione 4 della seconda serie di robustezza la cartella sta FUORI dall'app
  # (il percorso è nel runbook): questa riga resta come rete, se mai venisse ricopiata qui o in un
  # worktree. Il lock `backup-notturno-sicuro` verifica che esista e che nessun file tracciato
  # contenga una chiave age privata.
  ```
  In `__tests__/architecture/backup-notturno-sicuro.test.ts` sostituisci il commento delle righe 424-430 con:
  ```ts
      /**
       * La cartella delle chiavi (`KIDVILLE-CHIAVI-BACKUP/`: chiave privata age e password di cifratura dei
       * file) NON sta più dentro la cartella dell'app: dalla sessione 4 della seconda serie il titolare la
       * tiene fuori da ogni checkout (il percorso è nel runbook), perché un `git clean -x` l'avrebbe
       * cancellata e ogni worktree ne era una copia possibile. La regola di `.gitignore` e questo lock
       * RESTANO come rete: se la cartella venisse ricopiata dentro l'app, resterebbe comunque fuori da git.
       * Il repository è PUBBLICO, e basterebbe una riga cancellata per sbaglio. git stesso conferma che i
       * file dentro sono ignorati (anche quando la cartella non esiste, come in CI).
       */
  ```

- [ ] **Passo 6: verde.**
  ```bash
  CI=1 npx vitest run __tests__/architecture/backup-notturno-sicuro.test.ts __tests__/lib/monitor-esterno.test.ts
  ```
  Atteso: `Test Files  2 passed (2)`.

- [ ] **Passo 7: commit.**
  ```bash
  git add docs/runbook-ripristino.md docs/cicd.md .gitignore __tests__/architecture/backup-notturno-sicuro.test.ts
  git commit -m "Robustezza 2, sessione 4: Vault al posto di ALTER DATABASE, chiavi fuori dall'app, documenti del backup dal Worker" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

## Migrazione

- **File:** `supabase/migrations/<V>_bucket_dichiarati_dalla_produzione.sql` (Compito 9). `<V>` si prende con
  `date -u +%Y%m%d%H%M%S` **nel momento in cui il file si crea**, dopo il commit di chiusura della precedente
  (Compito 1, Passo 4). Deve essere maggiore di
  `generato_alle` della fotografia delle migrazioni e dell'ultima migrazione applicata. Mai un orario tondo, mai
  un orario futuro: una version nel futuro tiene rossa la fotografia anche dopo averla rigenerata.
- **Cosa fa:** quattro `insert into storage.buckets … on conflict (id) do nothing` (`avvisi_allegati`,
  `task_allegati`, `form_attachments`, `registro-allegati`), un bucket per istruzione, e una riga in `app_log`.
  Tutto in `begin; … commit;`, come `20260812194614_bonifica_registro_modifiche_hard_delete.sql`.
- **Effetto in produzione:** nessuna riga cambia (`n_nuovi` = 0). Su un database nuovo crea i bucket che mancano.
- **Non tocca** indici unici, FK verso `utenti` o RLS: nessuna voce in `MIGRAZIONI_ATTESE_AL_MERGE`
  (`soglia-fotografia.ts:251`). Nel testo SQL non compaiono le parole che i riconoscitori cercano
  (`soglia-fotografia.ts:281-362`).
- **Prima del merge:** si ricontano le iscrizioni (Passo 0.1, con data e ora UTC) e si scrive il numero nella voce
  del PRD. La migrazione si **mostra** nella descrizione della PR, per intero. Mostrare non è chiedere.
- **Chi la applica:** l'integrazione GitHub di Supabase, al merge, con la version del file. **Mai** applicarla a mano
  con `apply_migration`: nascerebbero due righe con due version diverse.
- **Dopo il merge (sola lettura):**
  ```sql
  select version, name from supabase_migrations.schema_migrations where name = 'bucket_dichiarati_dalla_produzione';
  select livello, contesto->>'esito' as esito, contesto->>'n_nuovi' as n_nuovi, occorrenze
    from app_log where fingerprint = 'sql:bucket-dichiarati-dalla-produzione';
  select id, public, file_size_limit, allowed_mime_types from storage.buckets
   where id in ('avvisi_allegati', 'form_attachments', 'registro-allegati', 'task_allegati') order by id;
  ```
  Atteso: una riga con la version del file; `info`, `bucket-dichiarati`, `0`; le quattro righe identiche al Passo 0.4.
- **Fotografie:** quella dei bucket non cambia (i quattro bucket c'erano già). Quella delle migrazioni la
  rigenera la sessione che apre dopo, nel suo primo commit, seguendo la sezione «Per la sessione dopo» di questo
  piano. Fino ad allora `migrazioni-complete` vede il file come «in coda» ed è verde.
- **Ritorno indietro:** sezione ROLLBACK nella testata del file. In produzione non c'è niente da annullare, e il
  file resta nel repo.

---

## Log

| Dove | Riga | Livello | Quando |
|---|---|---|---|
| Worker, `giroBackup` | `monitor-backup: esito=partito workflow=backup-notturno.yml HTTP 204` | `console.log` | ogni notte, anche quando va bene (regola 5: si logga il successo) |
| Worker, `giroBackup` | `monitor-backup: esito=riattivato-e-partito …` | `console.log` | workflow spento da GitHub per inattività |
| Worker, `giroBackup` | `monitor-backup: esito=spento-a-mano …: spento con «gh workflow disable», il Worker non lo riaccende` | `console.log` | interruttore del titolare |
| Worker, `giroBackup` | `monitor-backup: esito=fallito workflow=… HTTP <stato> <corpo di GitHub, 300 caratteri>` | `console.error` | rifiuto o rete; il corpo non si butta mai |
| Worker, `avvisaPerEmail` | `monitor-email: esito=accettata chiave=<chiave> HTTP 200 {"id":"…"}` | `console.log` | email accettata da Resend (stesso id = già spedita in quella finestra) |
| Worker, `avvisaPerEmail` | `monitor-email: esito=non-spedita chiave=<chiave> HTTP <stato> <corpo>` oppure `… mancano RESEND_API_KEY o SENTINELLA_DESTINATARI …` | `console.error` | rifiuto di Resend o segreti mancanti (regola 4: configurazione mancante = error) |
| Worker, `giro` | le righe di oggi (`monitor: …`), invariate | come oggi | — |
| Workflow, guardia | `guardia: esito=salta|parte giri_letti=N · <perché>` | stdout del giro | ogni schedule |
| Workflow, guardia | `::warning::guardia: esito=non-verificabile, il backup parte comunque: <motivo con stato e corpo>` | annotazione | GitHub non risponde |
| Workflow, guardia | `::notice::giro annullato dalla guardia …` / `::warning::l'annullamento non è arrivato …` | annotazione | annullamento riuscito o mancato |
| Campanello | `backup: N giri riusciti letti, M automatici → ok|INCIDENTE` | stdout del giro | ogni giro |
| Migrazione | riga `app_log` `sql:bucket-dichiarati-dalla-produzione`, `esito` `bucket-dichiarati`, `n_nuovi`, `n_dichiarati`, `operazione` | `info` | una volta, al merge |

Nessuna di queste righe contiene un nome, un indirizzo email, un segreto o un dato di famiglie. I destinatari non
si loggano mai (`mandaEmail` non li scrive), il token sta solo nelle intestazioni, i corpi di GitHub e Resend non
portano segreti. Il Worker non ha `@/lib/logging/logger` e tiene lo stile `console.*` di oggi; `no-console` vale
solo per `src/`. In `src/` questa sessione non tocca niente.

---

## PRD

- [ ] **Passo 1: la voce in cima a `PRD REGISTRO ELETTRONICO.md`** (prima della riga 1), coi numeri del Passo 0:
  ```markdown
  ## 🛡️ Changelog — Robustezza, seconda serie, sessione 4: il backup parte alle 02:23 dal Worker, secondo canale d'allarme, bucket e Vault ricostruibili, chiavi fuori dall'app — <AAAA-MM-GG> (branch `robustezza2/s04-backup-notte-e-allarme`)

  **Stato:** 🔄 in revisione (PR #<n>). Una migrazione, `<V>_bucket_dichiarati_dalla_produzione`, applicata dall'integrazione al merge: in produzione non cambia nessuna riga. `enrollment_submissions`: <N> righe, contate il <AAAA-MM-GG> alle <hh:mm:ss> UTC, prima della migrazione.

  - **Backup alle 02:23 (S4).** Il Worker `kidville-monitor-esterno` ha un secondo cron, `23 2 * * *`, e lancia `backup-notturno.yml` con `modalita=completo` e `origine=cloudflare` (titolo «Backup notturno completo (da Cloudflare)»). Prima: 14 giri dello `schedule` partiti fra le <hh:mm> e le <hh:mm> UTC. Se GitHub ha spento il workflow per inattività il Worker lo riattiva; se l'ha spento il titolare, no.
  - **Guardia delle 20 ore.** Lo `schedule` di GitHub resta come riserva: se un backup completo è riuscito nelle ultime 20 ore, il giro annulla sé stesso e finisce `cancelled` (mai un `success` finto). Fail-open: se la guardia non legge i giri, il backup parte.
  - **Secondo canale (T12).** Se il backup non parte, il Worker manda l'email «Backup notturno NON partito» con Resend, una per notte (`Idempotency-Key`). Se il sito è giù e il campanello non parte, «Sito giù e campanello NON partito», una per ora. Segreti nuovi del Worker: `RESEND_API_KEY`, `SENTINELLA_DESTINATARI`.
  - **Campanello.** Conta come automatico anche il giro «(da Cloudflare)»; un giro a mano continua a non contare.
  - **Bucket (D5, in parte).** Le migrazioni creavano 17 bucket su 21: `avvisi_allegati`, `task_allegati`, `form_attachments` e `registro-allegati` ora nascono anche da una migrazione, con le impostazioni lette dalla produzione. Un lock pretende che ogni bucket della produzione sia creato da una migrazione.
  - **Vault (D5, in parte).** Runbook (scenario E, passo 6) e `docs/cicd.md` passano da `ALTER DATABASE … SET` (negato, 42501) a `vault.create_secret`, coi sei nomi. Un lock lega i nomi letti dalle migrazioni a quelli del runbook.
  - **Chiavi (D8, in parte · T5).** Il runbook dice dove sta la copia di lavoro, fuori dall'app, con le caselle dello spostamento e della revoca della vecchia `sb_secret_`, che spuntano il titolare. La regola di `.gitignore` e il suo lock restano come rete.
  - **T2.** `ESCLUDI_BUCKET` invariato: galleria e video originali restano fuori dal backup.
  - **Prima / dopo.** p95 server→DB in punta (07:55–08:05 UTC): prima <n> ms (<giorno>), al 20/10 232 ms e al 19/10 315 ms; dopo: matura dopo tre notti dal deploy del Worker, e lo scrive la sessione che apre dopo (sezione «Per la sessione dopo» del piano).
  - **Logging.** `monitor-backup: esito=…` e `monitor-email: esito=…` nel Worker, anche sul successo; `guardia: esito=…` nel workflow; riga `app_log` `sql:bucket-dichiarati-dalla-produzione` dalla migrazione.
  ```
  I segnaposto fra `<…>` si riempiono coi numeri misurati: conteggi, orari, numeri di PR. Mai nomi né indirizzi.

- [ ] **Passo 2: commit.**
  ```bash
  git add "PRD REGISTRO ELETTRONICO.md"
  git commit -m "Robustezza 2, sessione 4: PRD" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

## Rilascio

- [ ] **1. Gate locale**, tutti verdi (mai `npm run e2e`, che in locale è vietato):
  ```bash
  cd /Users/lerri/kidville-web-s04
  npx eslint . --max-warnings 0
  npx tsc --noEmit
  CI=1 npx vitest run
  NODE_OPTIONS=--max-old-space-size=8192 npm run build
  ```
  Atteso: 0 problemi; nessun errore di tipo; tutti i file di test passati; `✓ Compiled successfully`. Il limite
  di memoria serve perché la build locale di default va in OOM.

- [ ] **2. Le iscrizioni contate di nuovo**, subito prima di aprire la PR (Passo 0.1), e il numero nella voce del PRD.

- [ ] **3. PR.**
  ```bash
  git push -u origin robustezza2/s04-backup-notte-e-allarme
  gh pr create --base main --head robustezza2/s04-backup-notte-e-allarme \
    --title "Robustezza 2, sessione 4: backup alle 02:23 dal Worker, secondo canale, bucket, Vault, chiavi" \
    --body "$(cat <<'EOF'
  ## Cosa cambia
  - Il Worker `kidville-monitor-esterno` lancia `backup-notturno.yml` alle 02:23 UTC (`modalita=completo`, `origine=cloudflare`); se non parte manda un'email (Resend, `Idempotency-Key`).
  - `backup-notturno.yml`: `run-name`, input `origine`, job `guardia` (annulla lo schedule se un completo è riuscito nelle ultime 20 ore). `ESCLUDI_BUCKET` invariato.
  - Il campanello conta i giri «(da Cloudflare)».
  - Migrazione idempotente: i quattro bucket che esistevano solo in produzione.
  - Runbook e cicd: Vault al posto di `ALTER DATABASE`; chiavi fuori dall'app.

  ## Prima (Passo 0)
  (partenze dei 14 giri, p95 in punta, valori dei quattro bucket, sei nomi del Vault, conteggio delle iscrizioni con data e ora UTC)

  ## La migrazione (mostrata, non chiesta)
  (il testo integrale del file `supabase/migrations/<V>_bucket_dichiarati_dalla_produzione.sql`)

  ## Ordine del rilascio
  1. merge (a mano, dal titolare): l'integrazione applica la migrazione;
  2. solo DOPO il merge: segreti del Worker e `npx wrangler@4.148.0 deploy` (prima del merge `main` non conosce `origine` e il lancio prenderebbe 422);
  3. la mattina dopo il deploy, il primo giro «(da Cloudflare)» si annota in un commento di questa PR.

  La misura «dopo» (tre notti dal Worker, p95 in punta) matura più tardi: la scrive la sessione che apre dopo, dalla sezione «Per la sessione dopo» del piano.

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  )"
  ```
  Le due parti fra parentesi si sostituiscono coi numeri veri e col testo della migrazione prima di lanciare il comando.

- [ ] **4. La riga 4 della tabella di stato, «in revisione»** (§5 della specifica: nella propria PR mai «in
  produzione»). La riga si trova per contenuto, mai col numero:
  ```bash
  cd /Users/lerri/kidville-web-s04
  grep -n "^| 4 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
  gh pr view robustezza2/s04-backup-notte-e-allarme --json number --jq .number
  ```
  Atteso: una sola riga che comincia con `| 4 | Backup alle 02:23`, e il numero della PR appena aperta. In quella riga
  si cambiano tre colonne e si lasciano le altre come sono (la colonna «Note» può avere annotazioni di questa
  sessione, che restano): «Stato» → `in revisione`, «PR» → `#<numero>`, «Piano» →
  `docs/superpowers/plans/2026-10-20-robustezza2-s04-backup-notte-e-allarme.md`. Con le «Note» di oggi diventa:
  ```markdown
  | 4 | Backup alle 02:23, secondo canale d'allarme, bucket, Vault, chiavi | S4, D5 (in parte), D8 (in parte) | — | in revisione | #<numero> | `docs/superpowers/plans/2026-10-20-robustezza2-s04-backup-notte-e-allarme.md` | T2, T5, T12 |
  ```
  Nella voce del PRD, `PR #<n>` diventa lo stesso numero. Poi:
  ```bash
  git add docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md "PRD REGISTRO ELETTRONICO.md"
  git commit -m "Robustezza 2, sessione 4: riga di stato in revisione" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push
  ```

- [ ] **5. CI verde su tutti i job** (`gh pr checks --watch`). Un E2E «cancelled» per il gruppo `e2e-ci-db` non è
  rosso: si rilancia, una PR alla volta. `DB migrate (CI)` non gira sulla PR: `.github/workflows/migrate-ci.yml`
  parte solo a mano (`workflow_dispatch`). Se il titolare lo lancia, sul DB della CI la migrazione può creare i quattro
  bucket (`n_nuovi` fino a 4): è atteso.

- [ ] **6. Merge a mano, lo fa il titolare.** Niente auto-merge.

- [ ] **7. Controlli dopo il merge**, in sola lettura: le tre `SELECT` della sezione «Migrazione».

- [ ] **8. I segreti del Worker, li mette il titolare** (i valori non passano mai dalla chat):
  ```bash
  cd /Users/lerri/kidville-web/monitor-esterno
  git -C /Users/lerri/kidville-web pull --ff-only   # solo se il checkout principale è su main e pulito; altrimenti un worktree di origin/main
  pbpaste | npx wrangler@4.148.0 secret put RESEND_API_KEY
  pbpaste | npx wrangler@4.148.0 secret put SENTINELLA_DESTINATARI
  npx wrangler@4.148.0 secret list
  ```
  Atteso: tre nomi, `GITHUB_TOKEN_CAMPANELLO`, `RESEND_API_KEY`, `SENTINELLA_DESTINATARI`.

- [ ] **9. Pubblicazione del Worker** da una copia di `main` che contiene il merge (come in `docs/cicd.md`, dalla
  cartella `monitor-esterno/`):
  ```bash
  npx wrangler@4.148.0 deploy
  date -u +%FT%TZ
  ```
  Atteso: `Deployed kidville-monitor-esterno triggers` con **due** righe `schedule:`, `*/5 * * * *` e `23 2 * * *`;
  l'ora UTC del deploy serve a contare le tre notti. Se `deploy` rifiuta il secondo cron (ad esempio per il numero di
  cron ammessi sull'account), ci si ferma: il backup resta allo `schedule` com'è oggi, e lo si scrive nel commento
  del passo 12 (la colonna «Note» la aggiorna la sessione che apre dopo; nessun ramo di soli documenti).

- [ ] **10. Prova del secondo canale** in locale, la fa il titolare dopo le 03:00 UTC: ricetta «Prova del secondo
  canale» in `docs/cicd.md`. Atteso: l'email «Backup notturno NON partito» arriva; `.dev.vars` cancellato alla fine.
  L'esito (arrivata sì/no, data e ora UTC, mai l'indirizzo) va nel commento del passo 12.

- [ ] **11. Pulizia** (AGENTS.md, punto 3), dopo un deploy riuscito, subito dopo il passo 9 (non aspetta la
  notte): il branch di questa sessione, locale e remoto, e il suo worktree. I branch di altre sessioni ancora aperte
  non si toccano: non sono residui.
  ```bash
  git -C /Users/lerri/kidville-web worktree remove /Users/lerri/kidville-web-s04
  git -C /Users/lerri/kidville-web branch -D robustezza2/s04-backup-notte-e-allarme
  git -C /Users/lerri/kidville-web push origin --delete robustezza2/s04-backup-notte-e-allarme
  ```

- [ ] **12. La prima notte, in sola lettura, e un commento nella PR.** La mattina dopo il deploy del Worker:
  ```bash
  gh run list -w backup-notturno.yml -L 6 --json databaseId,createdAt,event,conclusion,displayTitle \
    --jq '.[] | [.createdAt, .event, .conclusion, .displayTitle, .databaseId] | @tsv'
  ```
  Atteso: un giro «Backup notturno completo (da Cloudflare)», `workflow_dispatch`, `createdAt` fra 02:23 e 02:35 UTC,
  `success`; lo `schedule`, se GitHub lo fa partire, «Backup notturno completo», `cancelled`. Se il giro delle 02:23
  manca e l'email «Backup notturno NON partito» non è arrivata, il Worker non lancia: si guarda il pannello
  (Workers → `kidville-monitor-esterno` → Logs) e, se non si capisce, si va al «Ritorno indietro». Poi si scrive
  quello che si è visto in un commento della PR mergiata, che resta leggibile dalla sessione dopo (`gh pr view
  <numero> --comments`) senza aprire un ramo di soli documenti:
  ```bash
  gh pr comment <numero> --body "Dopo il rilascio (sessione 4) · Worker pubblicato il <AAAA-MM-GGThh:mm:ssZ> con due cron · prima notte: giro (da Cloudflare) <databaseId> partito alle <hh:mm:ss> UTC, <conclusion> · schedule: <cancelled|non partito> · email di prova del secondo canale: <arrivata il AAAA-MM-GG alle hh:mm UTC | non fatta>"
  ```
  Solo numeri, orari ed esiti: mai indirizzi email o segreti. Le tre notti e il p95 «dopo» **non** si aspettano qui:
  maturano più tardi e li scrive la sessione che apre dopo (sezione «Per la sessione dopo»).

---

## Ritorno indietro

L'ordine conta: **prima il Worker, poi il codice.** Se torna indietro solo il workflow, il Worker nuovo lancia con
`origine` un workflow che non la dichiara più: 422 ogni notte, e un'email ogni notte.

- [ ] **1. Il Worker alla versione precedente**, ripubblicato dal commit di `main` prima del merge (il suo id è nel
  Passo 0.8):
  ```bash
  git -C /Users/lerri/kidville-web fetch origin
  git -C /Users/lerri/kidville-web worktree add "$TMPDIR/kv-monitor-indietro" <sha di main prima del merge>
  cd "$TMPDIR/kv-monitor-indietro/monitor-esterno" && npx wrangler@4.148.0 deploy
  git -C /Users/lerri/kidville-web worktree remove "$TMPDIR/kv-monitor-indietro"
  ```
  Atteso: una sola riga `schedule: */5 * * * *`. I segreti `RESEND_API_KEY` e `SENTINELLA_DESTINATARI` possono
  restare (non li legge più nessuno) oppure il titolare li toglie con
  `npx wrangler@4.148.0 secret delete RESEND_API_KEY` e lo stesso per l'altro.

- [ ] **2. Il codice**, con una PR di revert che **tiene** migrazione, lock dei bucket, `.gitignore` e runbook (sono
  veri comunque):
  ```bash
  git -C /Users/lerri/kidville-web worktree add /Users/lerri/kidville-web-s04-indietro -b revert/robustezza2-s04 origin/main
  cd /Users/lerri/kidville-web-s04-indietro
  git revert --no-commit <sha del merge>          # se il merge è uno squash, come le PR recenti; con un merge commit: -m 1
  git restore --source=<sha del merge> --staged --worktree -- \
    supabase/migrations/<V>_bucket_dichiarati_dalla_produzione.sql \
    __tests__/architecture/bucket-storage-dichiarati.test.ts \
    docs/runbook-ripristino.md .gitignore
  ```
  In `docs/cicd.md`, tornato alla versione precedente, si rimette la sezione «Cron di produzione» col Vault
  (Compito 10, Passo 4) e si aggiunge una riga in «Monitor esterno»: il lancio del backup dal Worker è stato
  ritirato il <gg/mm>, e il backup torna allo `schedule` di GitHub. Il lock del Vault in `backup-notturno-sicuro`
  torna indietro col resto del file: lo si rimette insieme a quella sezione. Poi gate, PR, CI verde su tutti i job,
  merge a mano.

- [ ] **3. La migrazione:** in produzione niente da fare (non ha cambiato righe). Il file resta: è applicato.

- [ ] **4. PRD:** una voce «ritirata il <gg/mm>» con il motivo, e la riga 4 della specifica (`grep -n "^| 4 |"`,
  mai col numero di riga) rimessa a «da fare», nella stessa PR di revert.

---

## Per la sessione dopo

La esegue, nel suo **primo commit**, la sessione che si apre dopo questa, qualunque numero abbia (§5 della specifica,
«Apertura di una sessione: la chiusura della precedente»). Chi la esegue non ha letto questo piano: qui c'è tutto.
Letture in produzione solo con `SELECT`; i comandi si lanciano dalla radice del worktree della sessione che chiude.

**I dati di partenza** (sola lettura):
```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s04-" --json number,mergedAt,mergeCommit --jq '.[] | "\(.number) \(.mergedAt) \(.mergeCommit.oid)"'
gh pr view <numero> --repo erricoluigi17/kidville-web --comments
```
Atteso: una riga con numero della PR, data del merge e commit di `main`; fra i commenti quello che comincia con «Dopo il
rilascio (sessione 4)» (Rilascio, passo 12), con l'ora del deploy del Worker, la prima notte e l'email di prova. Se il
commento manca, l'ora del deploy si legge con
`cd /Users/lerri/kidville-web/monitor-esterno && npx wrangler@4.148.0 deployments list | head -n 20` (la prima
versione con data successiva al merge).

- [ ] **1. Fotografie.**
  - **Migrazioni**, sempre: questa sessione ha una migrazione, `<V>_bucket_dichiarati_dalla_produzione`. Prima si
    controlla che sia applicata con la version del file:
    ```bash
    ls supabase/migrations/ | grep '_bucket_dichiarati_dalla_produzione\.sql$'
    ```
    ```sql
    select version, name from supabase_migrations.schema_migrations where name = 'bucket_dichiarati_dalla_produzione';
    ```
    Atteso: lo stesso `<V>` nel nome del file e nella riga, e una riga sola (due righe = qualcuno l'ha riapplicata a
    mano: ci si ferma). Poi:
    ```bash
    node __tests__/fixtures/migrazioni-fotografia.mjs --sql
    # la query stampata si esegue in produzione con `execute_sql`, SOLA LETTURA;
    # la risposta JSON, così com'è, va in "$TMPDIR/migrazioni.json"
    node __tests__/fixtures/migrazioni-fotografia.mjs < "$TMPDIR/migrazioni.json"
    CI=1 npx vitest run __tests__/architecture/migrazioni-complete.test.ts
    ```
    Atteso: `Test Files  1 passed (1)`; cambia `__tests__/fixtures/migrazioni-applicate-snapshot.json`.
  - **Bucket** (`__tests__/fixtures/bucket-storage-snapshot.json`), solo se la migrazione ne ha creati in produzione. Di
    regola no: i quattro bucket c'erano già. Si controlla:
    ```sql
    select contesto->>'n_nuovi' as n_nuovi from app_log where fingerprint = 'sql:bucket-dichiarati-dalla-produzione';
    select count(*) from storage.buckets;
    ```
    ```bash
    node -e "console.log(require('./__tests__/fixtures/bucket-storage-snapshot.json').bucket.length)"
    ```
    Se `n_nuovi` è `0` e i due conteggi sono uguali (21 il 20/10), la fotografia **non** si rigenera. Altrimenti:
    ```bash
    node __tests__/fixtures/bucket-storage-fotografia.mjs --sql
    # la query stampata si esegue in produzione con `execute_sql`, SOLA LETTURA; la risposta in "$TMPDIR/bucket.json"
    node __tests__/fixtures/bucket-storage-fotografia.mjs < "$TMPDIR/bucket.json"
    CI=1 npx vitest run __tests__/architecture/bucket-storage-dichiarati.test.ts
    ```
    Atteso: `Test Files  1 passed (1)`.
  - **Nessun'altra fotografia**: la migrazione non tocca indici unici, policy, chiavi esterne, tabelle per sede né lo
    schema delle candidature.

- [ ] **2. Liste da svuotare.** Nessuna. Questa sessione non aggiunge voci a `MIGRAZIONI_ATTESE_AL_MERGE`
  (`__tests__/architecture/soglia-fotografia.ts`) né ad altre liste temporanee; `IN_ATTESA_DI_UN_LIMITE` di
  `__tests__/architecture/bucket-storage-dichiarati.test.ts` l'ha svuotata questa sessione stessa, e resta vuota.

- [ ] **3. Riga di stato.** La riga si trova con
  `grep -n "^| 4 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`. «Stato» →
  `✅ in produzione il <gg/mm del merge> (main <primi 8 caratteri del commit>)`; «PR» e «Piano» restano come li ha
  scritti questa sessione; «Note» → `T2, T5, T12` più le misure del punto 4 già mature, e per ciascuna non ancora
  matura «<misura>: matura dal <gg/mm>».

- [ ] **4. Misure «dopo»**, in sola lettura, con giorno e ora UTC. Una misura non ancora matura al momento della
  chiusura si scrive in «Note» come «matura dal <gg/mm>», e la scrive, con le stesse query, la prima PR che tocca la
  specifica dopo quel giorno.
  - **Tre notti dal Worker.** Matura dalla mattina dopo la **terza** notte successiva al deploy del Worker (l'ora del
    deploy è nel commento della PR). Si leggono i giri da quel giorno:
    ```bash
    gh run list -w backup-notturno.yml --created ">=<AAAA-MM-GG del deploy>" -L 30 --json createdAt,event,conclusion,displayTitle \
      --jq '.[] | [.createdAt, .event, .conclusion, .displayTitle] | @tsv'
    ```
    Atteso per ciascuna delle prime tre notti: un giro «Backup notturno completo (da Cloudflare)»,
    `workflow_dispatch`, `createdAt` fra 02:23 e 02:35 UTC, `success`; lo `schedule`, se è partito, «Backup notturno
    completo», `cancelled`. Si scrivono le tre date e ore UTC. Una notte senza il giro «(da Cloudflare)» si scrive
    com'è, con l'esito dello `schedule` di quella notte.
  - **p95 server→DB nella punta.** Matura dal primo giorno feriale dopo la terza notte. È la query 2 bis del Passo
    0.3, sui log di Supabase (`query_logs`), con `iso_timestamp_start = <giorno>T07:55:00Z` e
    `iso_timestamp_end = <giorno>T08:05:00Z`, dove `<giorno>` è l'**ultimo** giorno feriale che i log hanno ancora:
    ```sql
    select toString(log_attributes['request.cf.colo']) as colo, count(*) as n,
      round(quantile(0.5)(toFloat64OrZero(toString(log_attributes['response.origin_time']))),0) as p50,
      round(quantile(0.95)(toFloat64OrZero(toString(log_attributes['response.origin_time']))),0) as p95
    from logs where source='edge_logs'
      and toString(log_attributes['request.headers.x_client_info']) like '%createServerClient'
    group by colo order by n desc limit 8
    ```
    Si scrive il p95 della riga DUB, col giorno, accanto al «prima» della voce del PRD, a 232 ms (20/10) e 315 ms
    (19/10). «Osservato» e «causa probabile» separati: un p95 più basso non dimostra da solo che il merito sia
    dell'orario del backup.
  - **Email di prova del secondo canale.** Già nel commento della PR (Rilascio, passo 10): si riporta l'esito. Se è
    «non fatta», in «Note» si scrive «email di prova del secondo canale: da fare».

- [ ] **5. PRD.** Nella voce «Changelog — Robustezza, seconda serie, sessione 4: …» lo **Stato** passa da
  `🔄 in revisione (PR #<n>)` a `✅ in produzione il <gg/mm> (main <primi 8 caratteri del commit>)`; il punto
  **Prima / dopo** riceve le misure del punto 4 già mature, ciascuna con giorno e ora UTC.

- [ ] **6. Cose condizionali.**
  - Le due caselle del runbook sotto `### Dove sta la copia di lavoro delle chiavi` («Cartella spostata fuori
    dall'app…», «Revoca della vecchia `sb_secret_`…») si spuntano **solo col sì del titolare**, con la data che dà
    lui. Mai cercando o leggendo la cartella delle chiavi. Senza il suo sì restano vuote, e in «Note» della riga 4 si
    scrive «T5: spostamento e revoca da confermare».
  - Se il commento della PR dice che `wrangler deploy` ha rifiutato il secondo cron (Rilascio, passo 9), in «Note» si
    scrive «backup dal Worker non attivo: <motivo>»: le tre notti non maturano e la riga resta comunque «in
    produzione» per il resto (bucket, Vault, chiavi, guardia).

- [ ] **7. Solo per la sessione 5: il prerequisito concreto.** Non è un compito di chiusura: lo controlla la sessione
  5 (prova di ripristino) nei suoi prerequisiti, e non aspetta le tre notti (T11: la prova si fa subito dopo questa
  sessione). Oltre alla PR mergiata e alla migrazione applicata, servono:
  - i quattro bucket in produzione:
    ```sql
    select count(*) from storage.buckets
     where id in ('avvisi_allegati', 'form_attachments', 'registro-allegati', 'task_allegati');
    ```
    Atteso: `4`.
  - **almeno un giro `backup-notturno` completo riuscito, creato dopo il merge di questa sessione.** Questa sessione
    ha cambiato la forma del workflow (job `guardia`, `backup` con `needs: guardia` e `!cancelled()`): la prova di
    ripristino deve aprire una copia fatta dal workflow di oggi, non da quello di prima. Va bene il giro delle 02:23
    «(da Cloudflare)», lo `schedule` o un giro lanciato a mano con
    `gh workflow run backup-notturno.yml -f modalita=completo`.
    ```bash
    MERGE="$(gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s04-" --json mergedAt --jq '.[0].mergedAt')"
    gh run list -w backup-notturno.yml -L 30 --json databaseId,createdAt,conclusion,displayTitle \
      | jq -r --arg m "$MERGE" '.[] | select(.conclusion == "success" and (.displayTitle | startswith("Backup notturno completo")) and .createdAt > $m) | "\(.createdAt) \(.databaseId) \(.displayTitle)"'
    ```
    Atteso: almeno una riga. Nessuna riga: la sessione 5 non parte (si aspetta la notte, o si lancia un completo a
    mano e si aspetta che finisca `success`).

---

## Autorevisione

**Copertura della specifica (§7, Sessione 4).**

| Richiesta | Dove |
|---|---|
| misura prima: partenze degli ultimi 14 giri e p95 in punta | Passo 0.2, 0.3 |
| `wrangler.toml` con il secondo cron `23 2 * * *` | Compito 5 |
| `lanciaBackup` accanto a `suonaCampanello`, senza il ripiego «senza input»; `disabled_inactivity` riattivato, `disabled_manually` no | Compito 3; scelte 1 e 2 |
| `backup-notturno.yml`: input `origine`, `run-name`, guardia delle 20 ore che **annulla** il giro (`actions: write` solo lì) | Compiti 7 e 8; scelta 3 |
| il campanello conta anche i giri «(da Cloudflare)» | Compito 6 |
| migrazione idempotente dei 4 bucket, impostazioni lette dalla produzione | Passo 0.4, Compito 9, «Migrazione» |
| ricetta del Vault in `docs/cicd.md` e nel runbook con `vault.create_secret` e i nomi; lock nomi ↔ `cron_config('…')` | Compito 10, Passi 1-4 |
| T2: `ESCLUDI_BUCKET` invariato | Mappa dei file; Compito 8, Passo 3 (la riga non si tocca) |
| T12: email con Resend nei due casi, al più una per notte e una per ora; `Idempotency-Key` facoltativa usata solo dal Worker; segreti messi dal titolare, mai in `wrangler.toml` | Compiti 2, 3, 4, 5; Rilascio, passo 8 |
| T5: nuovo percorso delle chiavi e casella della revoca; `.gitignore` e il suo lock restano | Compito 10, Passi 3 e 5; «Per la sessione dopo», punto 6 |
| rischio: due giri nella stessa notte; Worker pubblicato solo dopo il merge | scelta 4; Rilascio, passi 6-9 |
| indietro: `wrangler deploy` della versione precedente, revert | «Ritorno indietro» |
| prova: tre notti fra 02:23 e 02:35 «(da Cloudflare)», p95 rimisurato, email di prova | Rilascio, passi 10 e 12; «Per la sessione dopo», punto 4 |
| §5: prerequisiti, chiusura della precedente, riga «in revisione» nella propria PR, merge a mano, iscrizioni contate, log, PRD | Compito 1; Rilascio, passi 2, 4, 6; «Log»; «PRD» |
| T11: la sessione 5 parte subito dopo, con un prerequisito verificabile | «Per la sessione dopo», punto 7 |

**Segnaposto.** I valori fra `<…>` sono misure o numeri che il piano non può conoscere (version della migrazione,
numero della PR, orari delle notti): ogni passo dice da quale comando arrivano e dove si scrivono.

**Nomi coerenti fra i compiti.** Worker: `lanciaBackup`, `chiaveIdempotenza`, `avvisaPerEmail`, `giroBackup`, `giro`,
`lavoroDelCron`. Campanello: `mandaEmail` (parametro `chiaveIdempotenza`), `TITOLO_BACKUP_DA_FUORI`,
`eGiroBackupAutomatico`, `valutaBackup`. Guardia: `TITOLO_COMPLETO`, `eCompletoRiuscito`, `decidi`, `esegui`. Lock dei
bucket: `bucketCreatiInMigrazione`, `visibilitaDichiarata`, `IN_ATTESA_DI_UN_LIMITE`. Fingerprint della migrazione:
`sql:bucket-dichiarati-dalla-produzione`, `esito` `bucket-dichiarati`. Ramo: `robustezza2/s04-backup-notte-e-allarme`.
