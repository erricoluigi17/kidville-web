# Sessione 5 — Prova di ripristino completa — piano di implementazione

> **Per chi esegue:** sotto-skill obbligatoria `superpowers:subagent-driven-development` (consigliata) oppure `superpowers:executing-plans`; i passi usano le caselle (`- [ ]`).

**Obiettivo:** misurare quanto serve a rimettere in piedi database, file e app partendo **solo** dalle copie di R2, su
un progetto Supabase temporaneo, e scrivere nel runbook la ricetta che ha funzionato, con i tempi.

**Architettura:** l'agente prepara in codice uno script a fasi (`scripts/backup/ripristina-progetto.sh`) che il
titolare lancia una fase alla volta sul suo Mac, con le chiavi che solo lui porta; ogni fase controlla che la
precedente sia riuscita, scrive una riga in un registro e stampa solo numeri e nomi di tabelle e di bucket. Due script
piccoli completano la preparazione: uno esporta le impostazioni di Auth e Storage senza segreti, l'altro controlla che
l'anteprima di Vercel non abbia nessuna chiave dei fornitori. La mezza giornata del titolare (parte B) usa gli script
nell'ordine fissato dalla specifica; il compito 13 scrive i tempi misurati nel runbook, nella specifica e nel PRD.

**Tecnologie:** bash 3.2 (Mac) · `age` · `pg_restore`/`psql` 17 · `rclone` (remote `crypt` su R2, S3 di Supabase) ·
`jq` · Management API di Supabase (solo dal titolare) · Vercel CLI (solo dal titolare) · Vitest (`node`, programmi
finti nel `PATH`).

**Specifica:** `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, §7, Sessione 5 (righe
456-490 della specifica aggiornata il 20/10), con T1 e T11 (§2), l'ordine 4 → 5 (§3), le regole comuni (§5) e i
divieti (§8).

---

## Scelte e scostamenti dalla specifica

Sono decisioni prese leggendo il codice. Chi esegue le applica così; se una non regge, si ferma e lo scrive nella
colonna «Note» della riga 5 della tabella di stato della specifica.

1. **Uno script nuovo, non `ripristina-prova.sh` allargato.** Come dice la specifica: la prova completa la fa uno
   script nuovo, `scripts/backup/ripristina-progetto.sh`, e `ripristina-prova.sh` resta com'è. Quello script serve già
   a tre cose che restano: lo scenario A (righe giuste da un dump), il passo «verifica la copia sul Mac» dello
   scenario E, e la prova trimestrale; il suo comportamento è bloccato da 17 prove
   (`__tests__/lib/backup-ripristina-prova.test.ts`). La prova completa lavora su un altro bersaglio (un progetto
   Supabase, non un Postgres usa-e-getta) e ha passi a mano in mezzo, quindi è a fasi. `ripristina-prova.sh` è il
   primo passo della giornata.
2. **`rclone copy --size-only`, mai `rclone sync`.** Come dice la specifica (passo 5 dell'ordine). Un `sync` puntato per
   sbaglio sulla produzione cancellerebbe `gallery` e `video_originals`, che nello specchio non ci sono (T2). Su un
   progetto vuoto `copy` e `sync` fanno la stessa cosa. `--size-only` perché lo specchio è un `crypt` senza impronte e
   le sue date non coincidono mai al secondo (`scripts/backup/specchio-storage.sh:78`, `FINESTRA_DATE=2s`): così una
   copia interrotta si riprende senza ricopiare tutto.
3. **I dati di `storage.objects` non si caricano dal dump.** Sono l'indice dei file. Se ci fossero già, rclone li
   vedrebbe come presenti (la lista S3 di Supabase legge quella tabella) e non copierebbe niente. Le righe nascono con i
   file, nella fase `file`. Di `storage` si caricano solo i dati di `storage.buckets`.
4. **pg_cron non si spegne: non si installa mai.** La prova del 06/10 ha clonato un progetto con `pg_cron` acceso
   (`docs/prova-ripristino-2026-10.md:75-77`). Qui il progetto è nuovo: la fase 1 verifica che `pg_cron` e `pg_net`
   siano **assenti** prima di ogni dato, la fase 2 non li crea mai, e la fase 4 lo ricontrolla. I dati di `cron.job`
   non entrano.
5. **La pubblicazione Realtime.** La specifica la chiede: «si ripubblica da un elenco versionato». Il dump è fatto
   con `-n` (sei schemi) e le pubblicazioni non stanno in uno schema: dopo un ripristino il Realtime della chat
   resterebbe muto. L'elenco delle tabelle si legge dalla produzione (Passo 0), si versiona in
   `docs/impostazioni-supabase/realtime.txt` e la fase 5 lo ripubblica.
6. **Le impostazioni di Auth si esportano e basta.** La specifica chiede di esportarle senza segreti; il login di prova
   con email e password funziona con quelle predefinite. Dello Storage invece si **applica** al progetto temporaneo il
   limite dei file (`fileSizeLimit`), perché senza i file grandi di `video_build` verrebbero rifiutati.
7. **Un progetto Vercel a parte, solo anteprima.** L'anteprima gira su dati veri: un progetto `kidville-prova-ripristino`
   creato e cancellato dal titolare, non collegato a Git, con la protezione di Vercel accesa e **nessuna** chiave dei
   fornitori (controllo automatico con `variabili-anteprima.sh`).
8. **Il Vault della prova ha indirizzi che non portano da nessuna parte.** I cinque URL finiscono in
   `https://ripristino-prova.invalid/…` (RFC 2606: `.invalid` non si risolve mai) e il segreto dei cron è nuovo. In un
   disastro vero si usa la stessa fase e i valori veri si mettono **alla fine**, con `vault.update_secret`, prima di
   riaccendere i cron.
9. **Rimettere i job di pg_cron non è coperto.** Né la specifica né questo piano lo provano: le definizioni stanno
   nelle migrazioni (`cron.schedule`) e nei dati di `cron.job` del dump. Il runbook lo scrive come passo **mai
   provato**.
10. **Nessun capitolo sul ripristino al minuto** (T1).

---

## Mappa dei file

| File | Ruolo |
|---|---|
| `scripts/backup/ripristina-progetto.sh` | **Crea.** La prova completa in otto fasi: `cron-spento`, `schema-e-dati`, `auth-e-storage`, `conteggi`, `vault-bucket-realtime`, `file`, `login`, `riepilogo`; `--a-secco`; registro delle fasi; guardie contro la produzione. |
| `scripts/backup/impostazioni-senza-segreti.sh` | **Crea.** Dallo stdin (risposta di `/config/auth` o `/config/storage`) a un JSON ordinato senza segreti, con `_omesse`. |
| `scripts/backup/variabili-anteprima.sh` | **Crea.** Dai **nomi** delle variabili dell'anteprima: obbligatorie presenti, vietate assenti. |
| `__tests__/lib/backup-ripristina-progetto.test.ts` | **Crea.** Programmi finti (`psql`, `pg_restore`, `age`, `rclone`, `apri-campioni`), prove di ogni fase, prove gemelle, marcatori dei conteggi, runbook. |
| `__tests__/lib/backup-impostazioni-senza-segreti.test.ts` | **Crea.** Lista bianca; risposta sbagliata; chiave in un campo ammesso; lock sui file versionati (compito 13). |
| `__tests__/lib/backup-variabili-anteprima.test.ts` | **Crea.** Obbligatorie e vietate; lock: ogni `process.env.X` di `src/` è classificata. |
| `docs/impostazioni-supabase/realtime.txt` | **Crea** (compito 9, dalla produzione in sola lettura). Una tabella per riga. |
| `docs/impostazioni-supabase/auth.json`, `docs/impostazioni-supabase/storage.json` | **Crea** il titolare al passo B0.3; li versiona il compito 13. |
| `docs/runbook-ripristino.md` | **Modifica.** Righe lette il 20/10: 28 (specchio «14 GB»), 37-41 (cosa non c'è nel dump), 57-77 (collegarsi a R2: `read -rsp` vale solo in bash), 208-232 (scenario E, riscritto), 234-241 (lista di controllo), 245-271 (prova sul Mac: la chiave in `./chiave-temporanea.txt` dentro il repository). La sessione 3 riscrive gli scenari A0 e A0-bis, la sessione 4 tocca 37-55, 179, 229, 238: i numeri si spostano, i blocchi si trovano per titolo o per testo. Il compito 11 corregge anche il rimando «(scenario E, passo 6)» scritto dalla sessione 4. |
| `docs/cicd.md` | **Modifica** (compito 11). Solo il rimando «(passo 6)» allo scenario E, scritto dalla sessione 4 nella sezione «Cron di produzione»: diventa «(passi 9 e 12)». |
| `__tests__/fixtures/migrazioni-applicate-snapshot.json`, la riga di stato e la voce del PRD della sessione rilasciata per ultima, e i file che elenca il suo «Per la sessione dopo» | **Modifica** nel primo commit (compito 1, Passo 4: chiusura della precedente). |
| `__tests__/fixtures/bucket-storage-snapshot.json` | **Modifica se cambia** (compito 1): 21 bucket letti il 20/10, forma `{ bucket: [{ id, pubblico }] }`; la fase 5 la usa come attesa. |
| `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` (riga 5 della tabella di stato: la 29 al 20/10, si trova con `grep`, mai col numero) | **Modifica.** Nella propria PR: Stato «in revisione», numero della PR, percorso del piano (compito 12); risultati della giornata nelle «Note» (compito 13). |
| `PRD REGISTRO ELETTRONICO.md:1` | **Modifica.** Voce di changelog in cima (compito 12), aggiornata col risultato (compito 13). Modello: righe 1-24. |

Letti e **non** toccati, per riferimento:
- `scripts/backup/ripristina-prova.sh:1-143` — modello di stile; `PIPESTATUS` alle righe 103-109; marcatori `#@CONTEGGI` alle 116-118; giudizio `jq` alle 122-127.
- `scripts/backup/dump-cifrato.sh` — `SCHEMI` alla riga 66, `ESCLUSE` alla 70, marcatori alle 107-109.
- `scripts/backup/specchio-storage.sh` — `FINESTRA_DATE` alla riga 78, riga `RISULTATO oggetti_specchio=… byte_specchio=…` alla 215.
- `scripts/backup/apri-campioni.sh:35-47, 131` — `SORGENTE`, `SPECCHIO`, `ESCLUDI_BUCKET` e riga `RISULTATO`.
- `.github/workflows/backup-notturno.yml:109-129` (righe del 20/10: la sessione 4 aggiunge `run-name`, l'input `origine` e il job `guardia` prima di quelle righe, e le sposta; si trovano cercando `RCLONE_CONFIG_SB_`) — configurazione rclone: `SB` con `provider Other`, regione `eu-west-1`, `force_path_style`; l'endpoint di produzione `uimulkjyekgemjakmepp` nella riga `RCLONE_CONFIG_SB_ENDPOINT` (la 121 al 20/10).
- `__tests__/lib/backup-ripristina-prova.test.ts:55-123, 245-310` — programmi finti, prove gemelle, marcatori.
- `__tests__/fixtures/migrazioni-fotografia.mjs:19-29` e `__tests__/fixtures/bucket-storage-fotografia.mjs:24-30` — come si rigenerano le fotografie.
- `supabase/migrations/20260712220000_cron_config_vault.sql:24-45` — `cron_config` legge `vault.decrypted_secrets`; la funzione è di `postgres` ed è concessa solo a `service_role`.
- Le sei chiavi lette dalle migrazioni con `cron_config('…')`, contate il 20/10 su 20 file: `app.cron_secret` (25), `app.push_dispatch_url` (18), `app.notifiche_promemoria_url` (18), `app.retention_iscrizioni_url` (14), `app.fattura_sync_url` (3), `app.mensa_allergie_url` (1).
- `docs/prova-ripristino-2026-10.md:7-38, 40-95` — le due prove del 06/10 e le trappole (141, `LC_ALL`, `42501` su `cron.job`, nome del progetto nel titolo della scheda).
- `vercel.json:1-9` — solo `regions: ["dub1"]`, **nessun** cron.
- `.gitignore:46, 57-58` (righe del 20/10: la sessione 4 riscrive il commento sopra `/KIDVILLE-CHIAVI-BACKUP/` e aggiunge `.dev.vars*` e `.wrangler/`; si cercano le due righe per contenuto) — `/KIDVILLE-CHIAVI-BACKUP/` e `.vercel` esclusi.
- `src/lib/auth/require-staff.ts:304` e `src/app/api/me/route.ts:149` — l'identità da header vale finché `ALLOW_HEADER_IDENTITY !== 'false'`: nell'anteprima va messa a `false`.
- `src/lib/allegati/sigillo.ts:59` e `src/lib/auth/otp-ticket.ts:21` — `OTP_TICKET_SECRET` ripiega sulla chiave di servizio.
- `docs/superpowers/plans/2026-10-20-robustezza2-s04-backup-notte-e-allarme.md`, «Compito 10: Vault, chiavi e documenti» — il piano della sessione 4: chiavi in `~/KIDVILLE-CHIAVI-BACKUP/`, tabella dei sei nomi del Vault nel passo 6 dello scenario E, rimandi «(scenario E, passo 6)» nel runbook e «(passo 6)» in `docs/cicd.md`, lock `backup-notturno-sicuro` sui nomi nel runbook. E la sua sezione «Per la sessione dopo», punto 7: il prerequisito concreto di questa sessione.

---

## Passo 0 — misura prima

Lo fa l'agente, **dopo i prerequisiti** (compito 1, Passo 1) e prima del Passo 2 del compito 1, in sola lettura. Ogni
numero va nel PRD (compito 12) con giorno e ora UTC.

- [ ] **0.1 Quello che la sessione 4 ha lasciato in `main`.** Che la sua PR sia mergiata e la migrazione applicata lo
  dicono i prerequisiti (compito 1, Passo 1), non lo «Stato» della tabella. Qui si controlla il contenuto su cui questa
  sessione costruisce:
  ```bash
  git -C /Users/lerri/kidville-web fetch origin
  git -C /Users/lerri/kidville-web show origin/main:docs/runbook-ripristino.md | grep -c 'vault.create_secret'
  git -C /Users/lerri/kidville-web show origin/main:docs/runbook-ripristino.md | grep -c 'KIDVILLE-CHIAVI-BACKUP/`, \*\*fuori\*\*'
  ```
  Atteso: i due conteggi sono almeno 1.

- [ ] **0.2 L'ultimo backup completo è buono.**
  ```bash
  gh run list --workflow backup-notturno.yml --limit 8 --json databaseId,conclusion,createdAt,displayTitle \
    --jq '.[] | "\(.createdAt) \(.conclusion) \(.databaseId) \(.displayTitle)"'
  ```
  Atteso: il giro «completo» più recente con `success` ha meno di 30 ore.

- [ ] **0.3 Quanto pesa lo specchio.** Con il `databaseId` di quel giro:
  ```bash
  gh run view <databaseId> --log | grep -o 'RISULTATO oggetti_specchio=[0-9]* byte_specchio=[0-9]*' | tail -n 1
  ```
  Ore stimate per la copia a 20 Mbit/s in salita: `echo "scale=1; <byte_specchio> * 8 / 20000000 / 3600" | bc`.
  (Il 20/10 lo Storage pesava 20 GB, di cui 13,2 di galleria e video esclusi: lo specchio dovrebbe stare intorno ai 7 GB,
  cioè circa 50 minuti. Il numero buono è quello misurato qui.)

- [ ] **0.4 Le letture in produzione** (strumento MCP `execute_sql`, solo `SELECT`):
  ```sql
  SELECT count(*) FROM enrollment_submissions;
  select max(version) from supabase_migrations.schema_migrations;
  select extname, extnamespace::regnamespace::text as schema from pg_extension order by 1;
  select name from vault.secrets order by 1;
  select schemaname || '.' || tablename as tabella from pg_publication_tables where pubname = 'supabase_realtime' order by 1;
  select bucket_id, count(*) as oggetti from storage.objects group by 1 order by 1;
  select count(*) filter (where active) as attivi, count(*) as tutti from cron.job;
  ```
  Della terza lettura si tengono i nomi delle estensioni nello schema `public` **tranne** `pg_net` e `pg_cron`: sono il
  valore di `ESTENSIONI_IN_PUBLIC` (passo B5 e runbook). Della quinta si tiene l'elenco intero per il compito 9. La
  quarta legge solo i **nomi** del Vault, mai `decrypted_secrets`.

**Soglie che cambiano il piano:**
- 0.1 non soddisfatto → **ci si ferma**: la sessione 5 dipende dalla 4 (ricetta del Vault, bucket dichiarati, chiavi).
- 0.2: ultimo completo riuscito più vecchio di 30 ore, o due notti fallite di fila → **ci si ferma** e si passa allo
  scenario B del runbook.
- 0.3: più di 3 ore stimate → il titolare tiene libera la giornata intera; il progetto temporaneo si cancella **lo
  stesso giorno** comunque, anche a copia incompiuta (allora la prova dei file si scrive «parziale», con i conteggi).
- 0.4: i nomi del Vault diversi dalle sei chiavi lette dalle migrazioni → si scrive nella colonna «Note» della riga 5;
  la fase 5 crea i nomi letti dalle migrazioni (lo verifica una prova del compito 5).

---

## Migrazione

Nessuna migrazione: la produzione non si tocca.

---

## Compiti

### Compito 1: prerequisiti, worktree, chiusura della precedente, fotografie

**File:**
- Crea: il worktree `/Users/lerri/kidville-web-s05` sul branch `robustezza2/s05-prova-ripristino`
- Modifica (Passo 4, primo commit): `__tests__/fixtures/migrazioni-applicate-snapshot.json`, la riga di stato e la voce
  del PRD della sessione rilasciata per ultima, e i file che elenca il suo «Per la sessione dopo»
- Modifica se cambia (Passo 5): `__tests__/fixtures/bucket-storage-snapshot.json`

- [ ] **Passo 1: i prerequisiti (§5 della specifica, «Apertura di una sessione: i prerequisiti»).** Si fa per primo,
  prima del Passo 0. La riga 5 della tabella di stato ha la sessione 4 nella colonna «Dopo»: si verificano fatti, mai
  il testo dello «Stato» (che la sessione 4 non porta a «in produzione» da sola).
  1. La PR della sessione 4 è mergiata:
     ```bash
     gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s04-" --json number,mergedAt --jq '.[] | "\(.number) \(.mergedAt)"'
     ```
     Atteso: una riga.
  2. La sua migrazione è applicata. La version è nel nome del file in `main`:
     ```bash
     git -C /Users/lerri/kidville-web fetch origin
     git -C /Users/lerri/kidville-web ls-tree --name-only origin/main supabase/migrations/ | grep '_bucket_dichiarati_dalla_produzione\.sql$'
     ```
     Atteso: un file `supabase/migrations/<V>_bucket_dichiarati_dalla_produzione.sql`. Poi, in sola lettura
     (`execute_sql`), con quel `<V>`:
     ```sql
     SELECT version FROM supabase_migrations.schema_migrations WHERE version IN ('<V>');
     ```
     Atteso: una riga.
  3. Il prerequisito concreto che la sessione 4 dichiara nel suo «Per la sessione dopo» (punto 7): i quattro bucket in
     produzione e almeno un giro `backup-notturno` completo riuscito, creato dopo il merge della sessione 4 (la prova
     deve aprire una copia fatta dal workflow con la guardia, non da quello di prima). Non si aspettano le tre notti
     (T11: la prova si fa subito dopo la sessione 4).
     ```sql
     select count(*) from storage.buckets
      where id in ('avvisi_allegati', 'form_attachments', 'registro-allegati', 'task_allegati');
     ```
     ```bash
     MERGE="$(gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s04-" --json mergedAt --jq '.[0].mergedAt')"
     gh run list -w backup-notturno.yml -L 30 --json databaseId,createdAt,conclusion,displayTitle \
       | jq -r --arg m "$MERGE" '.[] | select(.conclusion == "success" and (.displayTitle | startswith("Backup notturno completo")) and .createdAt > $m) | "\(.createdAt) \(.databaseId) \(.displayTitle)"'
     ```
     Atteso: `4`, e almeno una riga. Nessuna riga: si aspetta il giro delle 02:23 o si lancia un completo a mano
     (`gh workflow run backup-notturno.yml -f modalita=completo`) e si aspetta che finisca `success`.
  4. Nessuna PR `robustezza2/` aperta, salvo i rami `-esito`:
     ```bash
     gh pr list --repo erricoluigi17/kidville-web --state open --search "head:robustezza2/" --json number,headRefName --jq '.[] | select(.headRefName | endswith("-esito") | not) | "\(.number) \(.headRefName)"'
     ```
     Atteso: nessuna riga.

  Se un controllo fallisce: **fermati**, e non si apre il ramo.

- [ ] **Passo 2: il ramo e il worktree**, dopo il Passo 0 superato. Il ramo si chiama come il piano senza la data.
  ```bash
  cd /Users/lerri/kidville-web
  git fetch origin
  git worktree add -b robustezza2/s05-prova-ripristino /Users/lerri/kidville-web-s05 origin/main
  cd /Users/lerri/kidville-web-s05
  npm ci
  ```
  Atteso: `npm ci` finisce senza errori. Il worktree non ha `.env.local` e **non deve averlo**: da qui partirà
  l'anteprima della prova.

- [ ] **Passo 3: base verde.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-ripristina-prova.test.ts __tests__/architecture/backup-notturno-sicuro.test.ts
  ```
  Atteso: `Test Files  2 passed (2)`.

- [ ] **Passo 4: la chiusura della sessione rilasciata per ultima (primo commit, prima di ogni codice).** È la regola
  §5 della specifica, «Apertura di una sessione: la chiusura della precedente». Di solito è la sessione 4, ma non lo si
  presume: lo dice GitHub.
  1. Quale sessione è stata rilasciata per ultima:
     ```bash
     gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/" --limit 50 --json number,headRefName,mergedAt --jq 'map(select(.headRefName | endswith("-esito") | not)) | sort_by(.mergedAt) | last | "\(.number) \(.headRefName)"'
     ```
     Atteso: una riga `<numero> robustezza2/sNN-<nome>` (se stampa `null null`, nessuna sessione è rilasciata e il
     Passo 4 si salta; qui non può succedere, perché il Passo 1 ha trovato la sessione 4).
  2. Il suo piano è `docs/superpowers/plans/2026-10-20-robustezza2-<nome del ramo senza «robustezza2/»>.md` (nel
     worktree). Si legge la sua sezione `## Per la sessione dopo` **per intero** e si esegue tutto ciò che elenca:
     fotografie, voci da togliere da `MIGRAZIONI_ATTESE_AL_MERGE` e dalle altre liste, riga di stato a «in produzione»
     col commit di `main`, Stato della sua voce nel PRD, misure «dopo» già mature, cose condizionali. Non si indovina
     niente che quella sezione non dica. Il commit di `main` e la data del merge:
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
     cd /Users/lerri/kidville-web-s05 && node __tests__/fixtures/migrazioni-fotografia.mjs --sql
     # la query stampata si esegue in produzione con `execute_sql`, SOLA LETTURA;
     # la risposta JSON, così com'è, va in "$TMPDIR/migrazioni.json"
     node __tests__/fixtures/migrazioni-fotografia.mjs < "$TMPDIR/migrazioni.json"
     CI=1 npx vitest run __tests__/architecture/migrazioni-complete.test.ts
     ```
     Atteso: la riga di riepilogo dello script e `Test Files  1 passed (1)`.
  4. Tutti i lock delle fotografie:
     ```bash
     cd /Users/lerri/kidville-web-s05 && CI=1 npx vitest run __tests__/architecture
     ```
     Atteso: verde. Se una fotografia che la sezione non nomina è rossa, si rigenera con la ricetta scritta nel suo
     messaggio d'errore (query in sola lettura) e lo si scrive nella voce del PRD di questa sessione.
  5. Commit, con i soli file cambiati da questo passo (`git status --short` li elenca):
     ```bash
     cd /Users/lerri/kidville-web-s05 && git status --short
     git add <i file elencati da git status>
     git commit -m "Robustezza 2, sessione 5 · chiusura della sessione rilasciata per ultima: fotografie, stato e PRD" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
     ```

- [ ] **Passo 5: la fotografia dei bucket, di oggi.** La fase 5 la usa come attesa (`FOTOGRAFIA_BUCKET`): deve dire i
  bucket della produzione di oggi, anche se il Passo 4 non l'ha toccata. Si salta solo se il Passo 4 l'ha già
  rigenerata oggi.
  ```bash
  cd /Users/lerri/kidville-web-s05 && node __tests__/fixtures/bucket-storage-fotografia.mjs --sql
  # la query stampata si esegue in produzione con `execute_sql`, SOLA LETTURA; la risposta in "$TMPDIR/bucket.json"
  node __tests__/fixtures/bucket-storage-fotografia.mjs < "$TMPDIR/bucket.json"
  CI=1 npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/bucket-storage-dichiarati.test.ts
  ```
  Atteso: `Test Files  2 passed (2)`. Se `git status --short` mostra cambiata `__tests__/fixtures/bucket-storage-snapshot.json`:
  ```bash
  git add __tests__/fixtures/bucket-storage-snapshot.json
  git commit -m "Robustezza 2, sessione 5: fotografia dei bucket rigenerata dalla produzione" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Compito 2: lo scheletro dello script, le guardie, il registro, la fase `cron-spento`

**File:**
- Crea: `scripts/backup/ripristina-progetto.sh`
- Test: `__tests__/lib/backup-ripristina-progetto.test.ts`

- [ ] **Passo 1: la prova rossa.** Crea `__tests__/lib/backup-ripristina-progetto.test.ts`:
  ```ts
  // @vitest-environment node
  import { describe, it, expect, beforeEach, afterEach } from 'vitest'
  import { spawnSync } from 'node:child_process'
  import {
      chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
  } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'

  /**
   * `scripts/backup/ripristina-progetto.sh` — la prova di ripristino COMPLETA, da R2 a un progetto Supabase
   * TEMPORANEO, una fase alla volta (seconda serie di robustezza, sessione 5).
   *
   * Qui Postgres, pg_restore, age e rclone sono FINTI: si provano l'ordine delle fasi, le guardie e il giudizio
   * dello script, non Supabase. Supabase lo prova il titolare nella sua mezza giornata.
   *
   * ─── COSA NON DEVE SUCCEDERE ────────────────────────────────────────────────
   *  · lavorare sulla produzione (riferimento, stringa di connessione, endpoint S3);
   *  · caricare un dato prima di aver visto pg_cron e pg_net assenti;
   *  · scrivere il dump decifrato su disco, o stampare righe, valori, nomi di file, la password del database o il
   *    segreto dei cron;
   *  · scambiare il 141 di age (pg_restore ha smesso di leggere) per una chiave sbagliata, o il contrario;
   *  · cancellare file con rclone (sync, delete, purge, move).
   */

  const SCRIPT = join(process.cwd(), 'scripts', 'backup', 'ripristina-progetto.sh')
  const REF = 'abcdefghijklmnopqrst'
  const PROD = 'uimulkjyekgemjakmepp'
  const PASSWORD = 'PASSWORD-FINTA-DEL-DB-TEMP'
  const MARCATORE = 'PLAINTEXT-MARKER-DEL-DUMP-DECIFRATO'
  const SEGRETO = 'ab'.repeat(32)
  const FOTOGRAFIA = join(process.cwd(), '__tests__', 'fixtures', 'bucket-storage-snapshot.json')

  let radice: string
  let finti: string
  let log: string

  function scrivi(nome: string, corpo: string) {
      const p = join(finti, nome)
      writeFileSync(p, corpo)
      chmodSync(p, 0o755)
  }

  function leggi(nome: string): string {
      const p = join(log, nome)
      return existsSync(p) ? readFileSync(p, 'utf8') : ''
  }

  function registro(): string {
      const p = join(radice, 'registro.txt')
      return existsSync(p) ? readFileSync(p, 'utf8') : ''
  }

  /** Scrive nel registro le fasi indicate come riuscite, nell'ordine dato. */
  function segna(...fasi: string[]) {
      const righe = fasi.map((f, i) =>
          `FASE nome=${f} esito=ok secondi=10 inizio=${1000 + i * 100} fine=${1010 + i * 100} inizio_utc=2026-11-03T08:00:00Z`)
      writeFileSync(join(radice, 'registro.txt'), righe.join('\n') + '\n', { flag: 'a' })
  }

  const MANIFEST_RIGA1 = {
      versione: 'PostgreSQL 17.6',
      estensioni: { plpgsql: '1.0', pgcrypto: '1.3', pg_trgm: '1.6', pg_cron: '1.6', pg_net: '0.14' },
      ruoli: ['postgres', 'anon', 'authenticated', 'service_role', 'backup_lettura'],
      impostazioni_database_nomi: [],
      conteggi: {
          'public.alunni': 789,
          'public.utenti': 956,
          'auth.users': 956,
          'auth.schema_migrations': 60,
          'storage.buckets': 21,
          'storage.objects': 9000,
          'storage.migrations': 40,
          'supabase_migrations.schema_migrations': 232,
          'public.app_log': 122486,
          'cron.job': 29,
      },
  }
  const MANIFEST_RIGA2 = {
      giorno: '2026-11-03T0055Z',
      dump: { byte: 5000000 },
      dati_esclusi: ['public.app_log', 'auth.sessions', 'cron.job_run_details'],
  }
  const CONTEGGI_UGUALI: Record<string, number> = {
      'public.alunni': 789,
      'public.utenti': 956,
      'auth.users': 956,
      'auth.schema_migrations': 75,
      'storage.buckets': 21,
      'storage.objects': 0,
      'storage.migrations': 44,
      'supabase_migrations.schema_migrations': 232,
      'public.app_log': 0,
  }

  // L'indice del dump come lo stampa `pg_restore -l`: «id; tableoid oid TIPO SCHEMA NOME PROPRIETARIO».
  const TOC = [
      '5002; 0 17001 TABLE DATA auth identities supabase_auth_admin',
      '5003; 0 17002 TABLE DATA auth schema_migrations supabase_auth_admin',
      '5004; 0 17005 TABLE DATA auth users supabase_auth_admin',
      '5010; 0 17010 TABLE DATA cron job supabase_admin',
      '5020; 0 17020 TABLE DATA public alunni postgres',
      '5030; 0 17030 TABLE DATA storage buckets supabase_storage_admin',
      '5031; 0 17031 TABLE DATA storage objects supabase_storage_admin',
      '5032; 0 17032 TABLE DATA storage migrations supabase_storage_admin',
      '5040; 0 17040 SEQUENCE SET auth refresh_tokens_id_seq supabase_auth_admin',
      '6001; 2606 17101 CONSTRAINT public alunni alunni_pkey postgres',
      '6002; 2620 17102 TRIGGER public alunni trg_alunni postgres',
      '6003; 2620 17103 TRIGGER storage objects trg_video_originale_arrivato postgres',
      '6004; 3256 17104 POLICY auth users pol_finta postgres',
      '6005; 2620 17105 TRIGGER cron job trg_finto postgres',
  ].join('\n')

  function bucketDellaFotografia(): string {
      const f = JSON.parse(readFileSync(FOTOGRAFIA, 'utf8')) as { bucket: { id: string; pubblico: boolean }[] }
      return f.bucket.map((b) => `${b.id}:${b.pubblico}`).join(' ')
  }

  function creaFinti() {
      scrivi('psql', `#!/bin/bash
  printf '%s\\n' "$@" >> "$FAKE_LOG/psql.args"
  sql=""; prev=""; stdin_script=0
  for a in "$@"; do
    [ "$prev" = "-c" ] && sql="$a"
    [ "$prev" = "-f" ] && [ "$a" = "-" ] && stdin_script=1
    prev="$a"
  done
  if [ "$stdin_script" = 1 ]; then
    n=$(wc -c | tr -d ' ')
    echo "script_da_stdin byte=$n prima=$sql" >> "$FAKE_LOG/psql.script"
    exit 0
  fi
  [ -z "$sql" ] && sql="$(cat)"
  printf '%s\\n' "$sql" >> "$FAKE_LOG/psql.sql"
  case "$sql" in
    *@estensioni-vietate*) echo "\${FAKE_CRON:-0}" ;;
    *@tabelle-public*) echo "\${FAKE_TABELLE_PUBLIC:-0}" ;;
    *@ruoli-presenti*) printf '%s\\n' postgres anon authenticated service_role ;;
    *@estensioni-disponibili*) printf '%s\\n' plpgsql pgcrypto pg_trgm pg_cron pg_net ;;
    *@prova-replica*) echo "\${FAKE_REPLICA:-replica}" ;;
    *json_object_agg*) echo "$FAKE_CONTEGGI" ;;
    *@vault-crea*) if [ -n "\${FAKE_VAULT_ERRORE:-}" ]; then echo "ERROR: LINE 1: $sql" >&2; exit 3; fi ;;
    *@vault-verifica*) echo "\${FAKE_VAULT:-6|true|true}" ;;
    *@bucket-presenti*) printf '%s\\n' $FAKE_BUCKET ;;
    *@realtime-aggiungi*) : ;;
    *@realtime*) echo "\${FAKE_REALTIME:-2}" ;;
    *@login*) echo "\${FAKE_LOGIN:-1|3}" ;;
  esac
  exit 0
  `)
      scrivi('pg_restore', `#!/bin/bash
  lista=""; uscita=""; prev=""; elenco=0
  for a in "$@"; do
    [ "$prev" = "-L" ] && lista="$a"
    [ "$prev" = "-f" ] && uscita="$a"
    [ "$a" = "-l" ] && elenco=1
    prev="$a"
  done
  { echo "== chiamata"; printf '%s\\n' "$@"; } >> "$FAKE_LOG/pg_restore.args"
  if [ "$elenco" = 1 ]; then
    printf '%s\\n' "$FAKE_TOC" > "$uscita"
    exit 0
  fi
  if [ -n "$lista" ]; then
    { echo "== $(basename "$lista")"; cat "$lista"; } >> "$FAKE_LOG/liste.txt"
  fi
  echo "pg_restore: error: could not execute query: ERROR: x DETTAGLIO-RISERVATO-CON-UN-VALORE" >&2
  if [ "$uscita" = "-" ]; then cat; else cat > /dev/null; fi
  exit 1
  `)
      // Il finto «age -d -i CHIAVE FILE»: per il manifest il JSONL, per il dump 2 MB con un marcatore. Due MB non
      // stanno nel buffer della pipe: se pg_restore smette di leggere (con -l), age muore di SIGPIPE, cioè 141.
      scrivi('age', `#!/bin/bash
  if [ -n "\${FAKE_AGE_ESCE:-}" ]; then echo "age: error: no identity matched any of the recipients" >&2; exit "$FAKE_AGE_ESCE"; fi
  file="\${@: -1}"
  case "$file" in
    *manifest*) printf '%s\\n%s\\n' "$FAKE_MANIFEST_1" "$FAKE_MANIFEST_2" ;;
    *) echo "${MARCATORE}"; head -c 2000000 /dev/zero | tr '\\0' 'B' ;;
  esac
  `)
      scrivi('rclone', `#!/bin/bash
  printf '%s\\n' "$*" >> "$FAKE_LOG/rclone.chiamate"
  case "$1" in
    copy)
      if [ -n "\${FAKE_COPIA_ESCE:-}" ]; then
        echo "ERROR : iscrizioni/NOME-FAMIGLIA-RISERVATO.pdf: Failed to copy" >&2
        exit "$FAKE_COPIA_ESCE"
      fi
      exit 0 ;;
    lsf) for c in $FAKE_CARTELLE; do echo "$c/"; done ;;
    size)
      dove="\${@: -1}"
      for coppia in $FAKE_CONTI; do
        if [ "\${coppia%=*}" = "$dove" ]; then
          n="\${coppia##*=}"
          echo "{\\"count\\":$n,\\"bytes\\":$((n * 1000))}"
          exit 0
        fi
      done
      echo "directory not found" >&2
      exit 3 ;;
    *) echo "comando inatteso: $1" >&2; exit 9 ;;
  esac
  `)
      scrivi('apri-campioni-finto.sh', `#!/bin/bash
  echo "SORGENTE=$SORGENTE SPECCHIO=$SPECCHIO ESCLUDI_BUCKET=$ESCLUDI_BUCKET" >> "$FAKE_LOG/campioni.env"
  echo "RISULTATO provati=10 identici=10 diversi=0 firma_errata=0 non_leggibili=0 firma_non_verificabile=0"
  exit "\${FAKE_CAMPIONI_ESCE:-0}"
  `)
  }

  function esegui(fase: string, extra: Record<string, string> = {}, script = SCRIPT) {
      const chiave = join(radice, 'chiave-temporanea.txt')
      writeFileSync(chiave, 'AGE-SECRET-KEY-FINTA-NON-REALE\n')
      writeFileSync(join(radice, 'x.dump.age'), 'age-encryption.org/v1\n')
      writeFileSync(join(radice, 'x.manifest.jsonl.age'), 'age-encryption.org/v1\n')
      writeFileSync(join(radice, 'realtime.txt'), '# tabelle finte\npublic.chat_messages\npublic.chat_threads\n')
      const r = spawnSync('bash', fase ? [script, fase] : [script], {
          encoding: 'utf8',
          // ambiente PULITO: niente variabili del job di CI né del terminale di chi lancia i test
          env: {
              NODE_ENV: 'test',
              PATH: `${finti}:${process.env.PATH}`,
              HOME: process.env.HOME ?? '/tmp',
              TMPDIR: radice,
              FAKE_LOG: log,
              PROGETTO_TEMP_REF: REF,
              DB_TEMP_URL: `postgresql://postgres.${REF}:${PASSWORD}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
              REGISTRO_FASI: join(radice, 'registro.txt'),
              DUMP_FILE: join(radice, 'x.dump.age'),
              MANIFEST_FILE: join(radice, 'x.manifest.jsonl.age'),
              AGE_KEY_FILE: chiave,
              SEGRETO_CRON_PROVA: SEGRETO,
              FOTOGRAFIA_BUCKET: FOTOGRAFIA,
              ELENCO_REALTIME: join(radice, 'realtime.txt'),
              APRI_CAMPIONI: join(finti, 'apri-campioni-finto.sh'),
              RCLONE_CONFIG_TEMP_ENDPOINT: `https://${REF}.storage.supabase.co/storage/v1/s3`,
              RCLONE_CONFIG_CRIPTO_PASSWORD: 'password-offuscata-finta',
              FAKE_MANIFEST_1: JSON.stringify(MANIFEST_RIGA1),
              FAKE_MANIFEST_2: JSON.stringify(MANIFEST_RIGA2),
              FAKE_TOC: TOC,
              FAKE_CONTEGGI: JSON.stringify(CONTEGGI_UGUALI),
              FAKE_BUCKET: bucketDellaFotografia(),
              FAKE_CARTELLE: 'avvisi_allegati protocollo',
              FAKE_CONTI: 'CRIPTO:corrente/avvisi_allegati=3 TEMP:avvisi_allegati=3 CRIPTO:corrente/protocollo=2 TEMP:protocollo=2',
              ...extra,
          },
      })
      return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
  }

  beforeEach(() => {
      radice = mkdtempSync(join(tmpdir(), 'ripristino-progetto-test-'))
      finti = join(radice, 'finti')
      log = join(radice, 'log')
      mkdirSync(finti)
      mkdirSync(log)
      creaFinti()
  })
  afterEach(() => rmSync(radice, { recursive: true, force: true }))

  describe('ripristina-progetto.sh · forma e ordine', () => {
      it('esiste e la sintassi è valida per bash', () => {
          expect(existsSync(SCRIPT)).toBe(true)
          const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })
          expect(r.status, r.stderr).toBe(0)
      })

      it('--a-secco stampa le otto fasi nell\'ordine della specifica e non chiama niente', () => {
          const r = esegui('--a-secco', { PROGETTO_TEMP_REF: '' })
          expect(r.status, r.err).toBe(0)
          const fasi = [...r.out.matchAll(/^PASSO (\d) (\S+) — /gm)].map((m) => `${m[1]} ${m[2]}`)
          expect(fasi).toEqual([
              '1 cron-spento', '2 schema-e-dati', '3 auth-e-storage', '4 conteggi',
              '5 vault-bucket-realtime', '6 file', '7 login', '8 riepilogo',
          ])
          expect(readdirSync(log)).toEqual([])
      })

      it('senza fase, o con una fase sconosciuta, rifiuta', () => {
          for (const f of ['', 'boh']) {
              const r = esegui(f)
              expect(r.status, f).not.toBe(0)
              expect(r.err).toMatch(/fase sconosciuta/)
          }
      })
  })

  describe('ripristina-progetto.sh · mai sulla produzione', () => {
      it('rifiuta il riferimento della produzione e uno malformato, senza chiamare psql', () => {
          for (const ref of [PROD, 'ABC', '', 'abcdefghijklmnopqrs1']) {
              const r = esegui('cron-spento', { PROGETTO_TEMP_REF: ref })
              expect(r.status, ref).not.toBe(0)
              expect(r.err).toMatch(/PROGETTO_TEMP_REF/)
          }
          expect(leggi('psql.args')).toBe('')
      })

      it('rifiuta una stringa di connessione che punta alla produzione o a un altro progetto, senza stampare la password', () => {
          const allaProduzione = esegui('cron-spento', {
              DB_TEMP_URL: `postgresql://postgres.${PROD}:${PASSWORD}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
          })
          expect(allaProduzione.status).not.toBe(0)
          expect(allaProduzione.err).toMatch(/PRODUZIONE/)
          const aUnAltro = esegui('cron-spento', {
              DB_TEMP_URL: `postgresql://postgres.zzzzzzzzzzzzzzzzzzzz:${PASSWORD}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
          })
          expect(aUnAltro.status).not.toBe(0)
          expect(aUnAltro.err).toContain(REF)
          expect(leggi('psql.args')).toBe('')
          expect(allaProduzione.out + allaProduzione.err + aUnAltro.out + aUnAltro.err).not.toContain(PASSWORD)
      })

      it('PROD_REF dello script è il progetto della sorgente dello specchio notturno', () => {
          const yml = readFileSync(join(process.cwd(), '.github', 'workflows', 'backup-notturno.yml'), 'utf8')
          const prod = /https:\/\/([a-z]{20})\.storage\.supabase\.co/.exec(yml)![1]
          const script = readFileSync(SCRIPT, 'utf8')
          expect(/^PROD_REF="([a-z]{20})"$/m.exec(script)![1]).toBe(prod)
          expect(prod).toBe(PROD)
      })
  })

  describe('ripristina-progetto.sh · fase 1, cron-spento', () => {
      it('pg_cron e pg_net assenti, public vuoto → riuscita, e il registro lo scrive', () => {
          const r = esegui('cron-spento')
          expect(r.status, r.err).toBe(0)
          expect(r.out).toMatch(/^RISULTATO fase=cron-spento pg_cron=assente pg_net=assente tabelle_public=0$/m)
          expect(registro()).toMatch(
              /^FASE nome=cron-spento esito=ok secondi=\d+ inizio=\d+ fine=\d+ inizio_utc=\d{4}-\d\d-\d\dT[\d:]{8}Z$/m)
      })

      it('pg_cron o pg_net installati → fallita, dice dove spegnerli, e il registro scrive «errore»', () => {
          const r = esegui('cron-spento', { FAKE_CRON: '1' })
          expect(r.status).not.toBe(0)
          expect(r.err).toMatch(/Database → Extensions/)
          expect(registro()).toMatch(/^FASE nome=cron-spento esito=errore /m)
      })

      it('lo schema public ha già tabelle → fallita: serve un progetto nuovo', () => {
          const r = esegui('cron-spento', { FAKE_TABELLE_PUBLIC: '12' })
          expect(r.status).not.toBe(0)
          expect(r.err).toMatch(/progetto NUOVO/)
      })

      it('la password del database non compare mai', () => {
          const r = esegui('cron-spento', { FAKE_CRON: '1' })
          expect(r.out + r.err).not.toContain(PASSWORD)
      })
  })

  describe('ripristina-progetto.sh · una fase non parte se la precedente non è riuscita', () => {
      it('schema-e-dati senza cron-spento riuscita → rifiutata, anche con PROSEGUI_COMUNQUE=1', () => {
          const casi: Record<string, string>[] = [{}, { PROSEGUI_COMUNQUE: '1' }]
          for (const extra of casi) {
              const r = esegui('schema-e-dati', extra)
              expect(r.status).not.toBe(0)
              expect(r.err).toMatch(/cron-spento/)
          }
          expect(leggi('pg_restore.args')).toBe('')
          expect(registro()).toBe('')
      })

      it('una cron-spento fallita non vale come riuscita', () => {
          esegui('cron-spento', { FAKE_CRON: '1' })
          const r = esegui('schema-e-dati')
          expect(r.status).not.toBe(0)
          expect(r.err).toMatch(/cron-spento/)
      })
  })

  describe('ripristina-progetto.sh · pulizia', () => {
      it('non lascia cartelle di lavoro, né dopo un successo né dopo un errore', () => {
          esegui('cron-spento')
          esegui('cron-spento', { FAKE_CRON: '1' })
          expect(readdirSync(radice).filter((n) => n.startsWith('ripristino-progetto.'))).toEqual([])
      })
  })
  ```

- [ ] **Passo 2: rossa.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-ripristina-progetto.test.ts
  ```
  Atteso: `FAIL`, `Test Files  1 failed (1)`; la prima prova dice che lo script non esiste, le altre escono con 127.

- [ ] **Passo 3: lo scheletro.** Crea `scripts/backup/ripristina-progetto.sh`:
  ```bash
  #!/usr/bin/env bash
  # Prova di ripristino COMPLETA, da R2 a un progetto Supabase TEMPORANEO, una fase alla volta.
  #
  # Seconda serie di robustezza, sessione 5 (D5, D8). La prova del 06/10 ha ripristinato il database sul Mac e ha
  # clonato il progetto dal pannello; mancavano i file e l'app. Qui si rimette in piedi tutto partendo SOLO dalle
  # copie di R2, nell'ordine della specifica:
  #   1 cron-spento            pg_cron e pg_net assenti, schema public vuoto: PRIMA di ogni dato
  #   2 schema-e-dati          ruoli, estensioni, schema e dati di public, scatola_nera, supabase_migrations
  #   3 auth-e-storage         dati di auth e dei bucket (in replica), poi vincoli, indici, trigger, policy
  #   4 conteggi               righe per tabella contro il manifest; pg_cron ancora assente
  #   5 vault-bucket-realtime  le sei chiavi del Vault con URL che non portano da nessuna parte, i bucket contro
  #                            la fotografia, la pubblicazione Realtime
  #   6 file                   copia dallo specchio cifrato, oggetti per bucket, campioni aperti
  #   7 login                  una sessione in auth.sessions dopo il login sull'anteprima
  #   8 riepilogo              tempi per fase e totale
  #
  # COME SI USA (i passi completi: runbook, scenario E; piano della sessione 5, parte B)
  #   bash scripts/backup/ripristina-progetto.sh --a-secco     # l'ordine, senza toccare niente
  #   bash scripts/backup/ripristina-progetto.sh <fase>
  # Ogni fase scrive una riga nel registro e non parte se la precedente non è riuscita. PROSEGUI_COMUNQUE=1 lo
  # permette, ma MAI subito dopo cron-spento.
  #
  # VARIABILI
  #   PROGETTO_TEMP_REF   riferimento (20 lettere) del progetto TEMPORANEO; mai quello della produzione
  #   DB_TEMP_URL         stringa di connessione al progetto temporaneo (Session pooler), digitata con read -rs
  #   DUMP_FILE, MANIFEST_FILE, AGE_KEY_FILE   come in ripristina-prova.sh
  #   PG_BIN              cartella con psql e pg_restore 17 (default: nel PATH)
  #   ESTENSIONI_IN_PUBLIC   estensioni che in produzione stanno nello schema public (Passo 0 del piano)
  #   SEGRETO_CRON_PROVA  64 cifre esadecimali generate per la prova, mai quello della produzione
  #   RCLONE_CONFIG_TEMP_*   il remote S3 del progetto temporaneo; RCLONE_CONFIG_CRIPTO_* lo specchio cifrato
  #   ESCLUDI_BUCKET      bucket fuori dal backup (default «gallery video_originals», come il workflow)
  #   REGISTRO_FASI       file del registro (default nella cartella temporanea, uno per progetto)
  #   TIENI_ERRORI        cartella ESISTENTE dove copiare i messaggi di pg_restore, psql e rclone (li legge solo
  #                       il titolare: possono citare valori e nomi di file)
  #   FOTOGRAFIA_BUCKET, ELENCO_REALTIME, APRI_CAMPIONI   percorsi (default nel repository)
  #
  # COSA NON FA, MAI
  #   · non lavora sulla produzione: rifiuta il suo riferimento in PROGETTO_TEMP_REF, in DB_TEMP_URL e
  #     nell'endpoint del remote TEMP:;
  #   · non scrive il dump decifrato su disco: va da age a pg_restore (e a psql) in pipe;
  #   · non stampa righe, valori, nomi di file né i messaggi di pg_restore, psql e rclone: solo numeri, nomi di
  #     tabella e di bucket;
  #   · non installa pg_cron né pg_net, e di rclone usa solo copy, size e lsf: non cancella niente.
  #
  # Compatibile con bash 3.2 (il Mac).

  set -euo pipefail

  PROD_REF="uimulkjyekgemjakmepp"
  FASI="cron-spento schema-e-dati auth-e-storage conteggi vault-bucket-realtime file login riepilogo"
  CHIAVI_VAULT="app.cron_secret app.push_dispatch_url app.notifiche_promemoria_url app.mensa_allergie_url app.fattura_sync_url app.retention_iscrizioni_url"
  URL_FINTO="https://ripristino-prova.invalid"
  RADICE_REPO="$(cd "$(dirname "$0")/../.." && pwd)"

  errore() {
    echo "ERRORE: $*" >&2
    exit 1
  }

  descrizione() {
    case "$1" in
      cron-spento) echo "pg_cron e pg_net assenti e schema public vuoto, PRIMA di ogni dato" ;;
      schema-e-dati) echo "ruoli, estensioni, schema e dati di public, scatola_nera, supabase_migrations" ;;
      auth-e-storage) echo "dati di auth e dei bucket in replica, poi vincoli, indici, trigger e policy" ;;
      conteggi) echo "righe per tabella contro il manifest, pg_cron ancora assente" ;;
      vault-bucket-realtime) echo "sei chiavi del Vault con URL finti, bucket contro la fotografia, Realtime" ;;
      file) echo "copia dallo specchio cifrato, oggetti per bucket, campioni aperti" ;;
      login) echo "una sessione in auth.sessions dopo il login sull'anteprima" ;;
      riepilogo) echo "tempi per fase e totale, dal registro" ;;
    esac
  }

  if [ "${1:-}" = "--a-secco" ]; then
    n=0
    for f in $FASI; do
      n=$((n + 1))
      echo "PASSO $n $f — $(descrizione "$f")"
    done
    exit 0
  fi

  FASE="${1:-}"
  case " $FASI " in
    *" ${FASE:-nessuna} "*) ;;
    *) errore "fase sconosciuta: una di «$FASI», oppure --a-secco" ;;
  esac

  REF="${PROGETTO_TEMP_REF:-}"
  [ "$REF" != "$PROD_REF" ] || errore "PROGETTO_TEMP_REF è la PRODUZIONE: questo script lavora solo su un progetto temporaneo"
  printf '%s' "$REF" | grep -Eq '^[a-z]{20}$' \
    || errore "PROGETTO_TEMP_REF deve essere il riferimento (20 lettere minuscole) del progetto temporaneo"

  REGISTRO="${REGISTRO_FASI:-${TMPDIR:-/tmp}/ripristino-progetto-$REF.registro}"
  FOTOGRAFIA_BUCKET="${FOTOGRAFIA_BUCKET:-$RADICE_REPO/__tests__/fixtures/bucket-storage-snapshot.json}"
  ELENCO_REALTIME="${ELENCO_REALTIME:-$RADICE_REPO/docs/impostazioni-supabase/realtime.txt}"
  APRI_CAMPIONI="${APRI_CAMPIONI:-$RADICE_REPO/scripts/backup/apri-campioni.sh}"
  if [ -n "${PG_BIN:-}" ]; then PATH="$PG_BIN:$PATH"; fi
  command -v jq >/dev/null 2>&1 || errore "manca jq nel PATH"

  # ── l'ordine: una fase parte solo se la precedente è riuscita ─────────────────
  precedente() {
    local prima="" f
    for f in $FASI; do
      if [ "$f" = "$1" ]; then
        echo "$prima"
        return 0
      fi
      prima="$f"
    done
  }

  ultimo_esito() {
    [ -f "$REGISTRO" ] || return 0
    { grep "^FASE nome=$1 " "$REGISTRO" || true; } | tail -n 1 | sed -n 's/.* esito=\([a-z]*\) .*/\1/p'
  }

  if [ "$FASE" != "riepilogo" ]; then
    PREC="$(precedente "$FASE")"
    if [ -n "$PREC" ] && [ "$(ultimo_esito "$PREC")" != "ok" ]; then
      if [ "${PROSEGUI_COMUNQUE:-}" = "1" ] && [ "$PREC" != "cron-spento" ]; then
        echo "ATTENZIONE: la fase «$PREC» non risulta riuscita; si prosegue perché PROSEGUI_COMUNQUE=1" >&2
      else
        errore "prima va fatta, e deve riuscire, la fase «$PREC» (registro: $REGISTRO)"
      fi
    fi
  fi

  # ── la cartella di lavoro e il registro, scritto all'uscita qualunque sia l'esito ─
  W="$(mktemp -d "${TMPDIR:-/tmp}/ripristino-progetto.XXXXXX")"
  INIZIO_EPOCH="$(date +%s)"
  INIZIO_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ESITO="errore"
  EXTRA=""

  chiudi() {
    local fine e
    fine="$(date +%s)"
    if [ "$FASE" != "riepilogo" ]; then
      echo "FASE nome=$FASE esito=$ESITO secondi=$((fine - INIZIO_EPOCH)) inizio=$INIZIO_EPOCH fine=$fine inizio_utc=$INIZIO_UTC$EXTRA" >> "$REGISTRO"
    fi
    if [ -n "${TIENI_ERRORI:-}" ] && [ -d "$TIENI_ERRORI" ]; then
      for e in "$W"/*.err; do
        if [ -f "$e" ]; then cp "$e" "$TIENI_ERRORI"/; fi
      done
    fi
    rm -rf "$W"
  }
  trap chiudi EXIT

  # ── il database del progetto temporaneo ──────────────────────────────────────
  Q() {
    psql "$DB_TEMP_URL" -X -A -t -q -v ON_ERROR_STOP=1 "$@"
  }

  richiedi_db() {
    local u="${DB_TEMP_URL:-}"
    [ -n "$u" ] || errore "manca DB_TEMP_URL: la stringa di connessione (Session pooler) del progetto TEMPORANEO, digitata con read -rs"
    case "$u" in *"$PROD_REF"*) errore "DB_TEMP_URL punta alla PRODUZIONE: fermo" ;; esac
    case "$u" in *"$REF"*) ;; *) errore "DB_TEMP_URL non contiene il riferimento del progetto temporaneo ($REF)" ;; esac
    command -v psql >/dev/null 2>&1 || errore "manca psql nel PATH (vedi PG_BIN)"
  }

  # ── aiuti per il dump ────────────────────────────────────────────────────────

  # ── le fasi ──────────────────────────────────────────────────────────────────
  controlla_cron_assente() {
    local n
    n="$(Q -c "/* @estensioni-vietate */ select count(*) from pg_extension where extname in ('pg_cron', 'pg_net');")"
    [ "$n" = "0" ] || errore "pg_cron o pg_net sono INSTALLATI sul progetto temporaneo: spegnili dal pannello (Database → Extensions) prima di qualunque dato"
  }

  controlla_public_vuoto() {
    local n
    n="$(Q -c "/* @tabelle-public */ select count(*) from pg_tables where schemaname = 'public';")"
    [ "$n" = "0" ] || errore "lo schema public del progetto temporaneo ha già $n tabelle: serve un progetto NUOVO e vuoto"
  }

  fase_cron_spento() {
    richiedi_db
    controlla_cron_assente
    controlla_public_vuoto
    echo "RISULTATO fase=cron-spento pg_cron=assente pg_net=assente tabelle_public=0"
  }

  # ── smistamento ──────────────────────────────────────────────────────────────
  case "$FASE" in
    cron-spento) fase_cron_spento ;;
    *) errore "la fase «$FASE» non è ancora nello script" ;;
  esac
  ESITO="ok"
  ```

- [ ] **Passo 4: verde.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-ripristina-progetto.test.ts
  ```
  Atteso: `Test Files  1 passed (1)`, `Tests  13 passed (13)`.

- [ ] **Passo 5: commit.**
  ```bash
  git add scripts/backup/ripristina-progetto.sh __tests__/lib/backup-ripristina-progetto.test.ts
  git commit -m "Ripristino completo: scheletro a fasi, guardie contro la produzione, registro e fase cron-spento" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Compito 3: le fasi `schema-e-dati` e `auth-e-storage`

**File:**
- Modifica: `scripts/backup/ripristina-progetto.sh` (blocco «aiuti per il dump», due funzioni prima di «smistamento», due righe nel `case`)
- Test: `__tests__/lib/backup-ripristina-progetto.test.ts` (in fondo)

- [ ] **Passo 1: la prova rossa.** In fondo al file di prova aggiungi:
  ```ts
  function chiamatePgRestore(): string[][] {
      return leggi('pg_restore.args').split('== chiamata\n').filter(Boolean).map((b) => b.trim().split('\n'))
  }

  function tuttiIFile(dir: string): string[] {
      const t: string[] = []
      for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name)
          if (e.isDirectory()) t.push(...tuttiIFile(p))
          else t.push(p)
      }
      return t
  }

  function nienteInChiaro(r: { out: string; err: string }) {
      for (const f of tuttiIFile(radice)) {
          if (f.startsWith(finti)) continue
          expect(readFileSync(f, 'utf8'), `in chiaro dentro ${f}`).not.toContain(MARCATORE)
      }
      expect(r.out + r.err).not.toContain(MARCATORE)
      expect(r.out + r.err).not.toContain('DETTAGLIO-RISERVATO-CON-UN-VALORE')
      expect(r.out + r.err).not.toContain(PASSWORD)
      expect(r.out + r.err).not.toContain('AGE-SECRET-KEY')
  }

  function mutato(da: RegExp, a: string): string {
      const originale = readFileSync(SCRIPT, 'utf8')
      const nuovo = originale.replace(da, a)
      expect(nuovo, `la mutazione ${da} non ha cambiato lo script`).not.toBe(originale)
      const p = join(radice, 'mutato.sh')
      writeFileSync(p, nuovo)
      return p
  }

  describe('ripristina-progetto.sh · fase 2, schema-e-dati', () => {
      it('crea i ruoli mancanti e le estensioni (mai pg_cron né pg_net), poi schema e dati dei tre schemi dell\'app', () => {
          segna('cron-spento')
          const r = esegui('schema-e-dati', { ESTENSIONI_IN_PUBLIC: 'pg_trgm' })
          expect(r.status, r.err).toBe(0)
          const sql = leggi('psql.sql')
          expect(sql).toContain('create role "backup_lettura" nologin;')
          expect(sql).not.toMatch(/create role "(postgres|anon|authenticated|service_role)"/)
          expect(sql).toContain('create extension if not exists "pgcrypto" with schema extensions;')
          expect(sql).toContain('create extension if not exists "pg_trgm" with schema public;')
          expect(sql).not.toMatch(/create extension[^;]*pg_(cron|net)/)
          const [chiamata] = chiamatePgRestore()
          expect(chiamata).toEqual([
              '--no-owner', '--section=pre-data', '--section=data',
              '-n', 'public', '-n', 'scatola_nera', '-n', 'supabase_migrations',
              '-d', expect.stringContaining(REF),
          ])
          expect(r.out).toMatch(/^RISULTATO fase=schema-e-dati ruoli_creati=1 estensioni=2 errori_pg_restore=1 secondi_ripristino=\d+$/m)
          expect(registro()).toMatch(/^FASE nome=schema-e-dati esito=ok .* errori_pg_restore=1$/m)
      })

      it('se nel frattempo pg_cron è comparso, o public non è vuoto, non carica niente', () => {
          segna('cron-spento')
          expect(esegui('schema-e-dati', { FAKE_CRON: '1' }).status).not.toBe(0)
          expect(esegui('schema-e-dati', { FAKE_TABELLE_PUBLIC: '3' }).status).not.toBe(0)
          expect(leggi('pg_restore.args')).toBe('')
      })

      it('chiave age sbagliata → fallita con un messaggio chiaro, e niente pg_restore', () => {
          segna('cron-spento')
          const r = esegui('schema-e-dati', { FAKE_AGE_ESCE: '1' })
          expect(r.status).not.toBe(0)
          expect(r.err).toMatch(/chiave sbagliata/)
          expect(leggi('pg_restore.args')).toBe('')
          expect(registro()).toMatch(/^FASE nome=schema-e-dati esito=errore /m)
      })

      it('il dump decifrato non tocca il disco, e messaggi, password e chiave non si stampano', () => {
          segna('cron-spento')
          const r = esegui('schema-e-dati')
          expect(r.status, r.err).toBe(0)
          nienteInChiaro(r)
      })

      it('con TIENI_ERRORI i messaggi di pg_restore finiscono SOLO nella cartella indicata', () => {
          segna('cron-spento')
          const tieni = join(radice, 'tenuti')
          mkdirSync(tieni)
          const r = esegui('schema-e-dati', { TIENI_ERRORI: tieni })
          expect(r.out + r.err).not.toContain('DETTAGLIO-RISERVATO-CON-UN-VALORE')
          expect(readFileSync(join(tieni, 'schema-e-dati.err'), 'utf8')).toContain('DETTAGLIO-RISERVATO-CON-UN-VALORE')
      })
  })

  describe('ripristina-progetto.sh · fase 3, auth-e-storage', () => {
      it('carica in replica SOLO i dati di auth e dei bucket, nell\'ordine del dump; poi vincoli e indici; poi trigger e policy di auth e storage', () => {
          segna('cron-spento', 'schema-e-dati')
          const r = esegui('auth-e-storage')
          expect(r.status, r.err).toBe(0)

          const chiamate = chiamatePgRestore()
          expect(chiamate.map((c) => c.find((a) => ['-l', '-L', '--section=post-data'].includes(a)))).toEqual([
              '-l', '-L', '--section=post-data', '-L',
          ])
          // i dati passano da psql, nella stessa sessione del «set session_replication_role = replica»
          expect(chiamate[1][chiamate[1].indexOf('-f') + 1]).toBe('-')
          const script = /^script_da_stdin byte=(\d+) prima=(.*)$/m.exec(leggi('psql.script'))
          expect(script).not.toBeNull()
          expect(Number(script![1])).toBeGreaterThan(1000)
          expect(script![2]).toBe('set session_replication_role = replica')
          expect(chiamate[2].join(' ')).toContain('--section=post-data -n public -n scatola_nera -n supabase_migrations')

          const liste = leggi('liste.txt').split(/^== /m).filter(Boolean)
          expect(liste[0]).toMatch(/^lista-dati\.txt\n/)
          expect(liste[1]).toMatch(/^lista-trigger\.txt\n/)
          const id = (blocco: string) => blocco.split('\n').slice(1).filter(Boolean).map((l) => l.split(';')[0])
          expect(id(liste[0])).toEqual(['5002', '5004', '5030', '5040'])
          expect(id(liste[1])).toEqual(['6003', '6004'])

          expect(r.out).toMatch(/^RISULTATO fase=auth-e-storage voci_dati=4 voci_trigger=2 replica=si errori=3 secondi_ripristino=\d+$/m)
      })

      it('se il ruolo non può mettersi in replica lo dice, e prosegue (i conteggi diranno se manca qualcosa)', () => {
          segna('cron-spento', 'schema-e-dati')
          const r = esegui('auth-e-storage', { FAKE_REPLICA: 'origin' })
          expect(r.status, r.err).toBe(0)
          expect(r.err).toMatch(/ATTENZIONE: .*session_replication_role/)
          expect(r.out).toMatch(/ replica=no /)
      })

      it('il 141 di age (pg_restore smette di leggere dopo l\'indice) NON è una chiave sbagliata', () => {
          segna('cron-spento', 'schema-e-dati')
          const r = esegui('auth-e-storage')
          expect(r.status, r.err).toBe(0)
          expect(r.err).not.toMatch(/chiave sbagliata/)
      })

      it('una chiave sbagliata invece ferma la fase', () => {
          segna('cron-spento', 'schema-e-dati')
          const r = esegui('auth-e-storage', { FAKE_AGE_ESCE: '1' })
          expect(r.status).not.toBe(0)
          expect(r.err).toMatch(/chiave sbagliata/)
      })

      it('senza schema-e-dati riuscita si ferma; con PROSEGUI_COMUNQUE=1 prosegue avvisando', () => {
          segna('cron-spento')
          expect(esegui('auth-e-storage').status).not.toBe(0)
          const r = esegui('auth-e-storage', { PROSEGUI_COMUNQUE: '1' })
          expect(r.status, r.err).toBe(0)
          expect(r.err).toMatch(/ATTENZIONE: la fase «schema-e-dati» non risulta riuscita/)
      })

      it('il dump decifrato non tocca il disco nemmeno passando da psql', () => {
          segna('cron-spento', 'schema-e-dati')
          const r = esegui('auth-e-storage')
          expect(r.status, r.err).toBe(0)
          nienteInChiaro(r)
      })
  })

  describe('PROVE GEMELLE · se si toglie una guardia, il comportamento sbagliato appare davvero', () => {
      it('senza la tolleranza del 141, la lettura dell\'indice sembrerebbe una chiave sbagliata', () => {
          segna('cron-spento', 'schema-e-dati')
          const p = mutato(/0 \| 141\)/, '0)')
          const r = esegui('auth-e-storage', {}, p)
          expect(r.status).not.toBe(0)
          expect(r.err).toMatch(/chiave sbagliata/)
      })

      it('senza il silenzio sui messaggi di pg_restore, un valore di riga finirebbe nel terminale', () => {
          segna('cron-spento')
          const p = mutato(/pg_restore "\$@" 2>> "\$err"/, 'pg_restore "$@"')
          const r = esegui('schema-e-dati', {}, p)
          expect(r.out + r.err).toContain('DETTAGLIO-RISERVATO-CON-UN-VALORE')
      })
  })
  ```

- [ ] **Passo 2: rossa.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-ripristina-progetto.test.ts
  ```
  Atteso: `FAIL`, le prove delle fasi 2 e 3 e le due gemelle falliscono con «la fase … non è ancora nello script»
  (la gemella del 141 fallisce già sulla mutazione: il testo `0 | 141)` non c'è).

- [ ] **Passo 3: gli aiuti per il dump.** Subito sotto la riga `# ── aiuti per il dump ──…` aggiungi:
  ```bash
  richiedi_dump() {
    local v valore
    for v in DUMP_FILE AGE_KEY_FILE; do
      eval "valore=\${$v:-}"
      { [ -n "$valore" ] && [ -f "$valore" ]; } || errore "$v non è un file esistente"
    done
    for v in age pg_restore psql; do
      command -v "$v" >/dev/null 2>&1 || errore "manca lo strumento «$v» nel PATH (vedi PG_BIN)"
    done
  }

  leggi_manifest() {
    { [ -n "${MANIFEST_FILE:-}" ] && [ -f "$MANIFEST_FILE" ]; } || errore "MANIFEST_FILE non è un file esistente"
    { [ -n "${AGE_KEY_FILE:-}" ] && [ -f "$AGE_KEY_FILE" ]; } || errore "AGE_KEY_FILE non è un file esistente"
    age -d -i "$AGE_KEY_FILE" "$MANIFEST_FILE" > "$W/manifest.jsonl" 2>> "$W/age.err" \
      || errore "age non riesce a decifrare il manifest (chiave sbagliata o file danneggiato)"
    META="$(sed -n 1p "$W/manifest.jsonl")"
    RIGA2="$(sed -n 2p "$W/manifest.jsonl")"
    printf '%s' "$META" | jq -e '.conteggi' >/dev/null 2>&1 || errore "il manifest non contiene i conteggi per tabella"
  }

  # age può uscire con 141 (SIGPIPE) quando pg_restore smette di leggere prima della fine: con -l legge solo
  # l'indice, con una lista si ferma dopo l'ultima voce. Non è un errore. Un altro codice vuol dire chiave
  # sbagliata o file danneggiato.
  controlla_age() {
    case "${ST[0]}" in
      0 | 141) ;;
      *) errore "age non riesce a decifrare il dump (codice ${ST[0]}): chiave sbagliata o file danneggiato" ;;
    esac
  }

  # ripristina <file-err> <argomenti di pg_restore…>: dal dump cifrato a pg_restore, mai su disco. I messaggi di
  # pg_restore possono citare il valore di una riga: vanno nel file, mai sul terminale.
  ripristina() {
    local err="$1"
    shift
    set +e
    age -d -i "$AGE_KEY_FILE" "$DUMP_FILE" 2>> "$W/age.err" | pg_restore "$@" 2>> "$err"
    ST=("${PIPESTATUS[@]}")
    set -e
    controlla_age
  }

  # ripristina_in_replica <file-err> <argomenti di pg_restore…>: come ripristina, ma pg_restore scrive l'SQL e
  # psql lo esegue nella STESSA sessione di un «set session_replication_role = replica». Così chiavi esterne e
  # trigger della piattaforma non scattano durante il caricamento (auth.identities viene prima di auth.users
  # nel dump). Un PGOPTIONS non basterebbe: il pooler di sessione può non inoltrarlo.
  ripristina_in_replica() {
    local err="$1"
    shift
    set +e
    age -d -i "$AGE_KEY_FILE" "$DUMP_FILE" 2>> "$W/age.err" \
      | pg_restore "$@" -f - 2>> "$err" \
      | psql "$DB_TEMP_URL" -X -q -v ON_ERROR_STOP=0 -c "set session_replication_role = replica" -f - > /dev/null 2>> "$err"
    ST=("${PIPESTATUS[@]}")
    set -e
    controlla_age
  }
  ```

- [ ] **Passo 4: le due fasi.** Subito **prima** della riga `# ── smistamento ──…` aggiungi:
  ```bash
  fase_schema_e_dati() {
    richiedi_db
    richiedi_dump
    leggi_manifest
    controlla_cron_assente
    controlla_public_vuoto

    # I ruoli del progetto che il progetto nuovo non ha (per esempio backup_lettura): segnaposto senza login,
    # perché il dump li cita nei GRANT. La password, se serve, la rimette il titolare a mano.
    local presenti r ruoli=0
    presenti="$(Q -c "/* @ruoli-presenti */ select rolname from pg_roles;")"
    for r in $(printf '%s' "$META" | jq -r '.ruoli[]?'); do
      case "$r" in '' | *[!a-z0-9_]*) continue ;; esac
      if ! grep -qx "$r" <<< "$presenti"; then
        Q -c "create role \"$r\" nologin;" > /dev/null
        ruoli=$((ruoli + 1))
      fi
    done

    # Le estensioni del manifest, tranne quelle che il progetto ha già e quelle che NON devono esserci:
    # pg_cron e pg_net, perché nessuna chiamata deve partire da questo database.
    local disponibili e schema estensioni=0
    disponibili="$(Q -c "/* @estensioni-disponibili */ select name from pg_available_extensions;")"
    for e in $(printf '%s' "$META" | jq -r '.estensioni // {} | keys[]'); do
      case "$e" in plpgsql | pg_cron | pg_net | supabase_vault | pg_stat_statements | pg_graphql | pgsodium | supabase_wrappers) continue ;; esac
      case "$e" in '' | *[!a-z0-9_-]*) continue ;; esac
      if ! grep -qx "$e" <<< "$disponibili"; then
        echo "ATTENZIONE: l'estensione $e non è disponibile sul progetto temporaneo" >&2
        continue
      fi
      schema="extensions"
      case " ${ESTENSIONI_IN_PUBLIC:-} " in *" $e "*) schema="public" ;; esac
      Q -c "create extension if not exists \"$e\" with schema $schema;" > /dev/null
      estensioni=$((estensioni + 1))
    done

    # Schema e dati, SENZA vincoli, indici e trigger (sono post-data: arrivano nella fase 3, dopo auth).
    local prima=$SECONDS n_err
    : > "$W/schema-e-dati.err"
    ripristina "$W/schema-e-dati.err" --no-owner --section=pre-data --section=data \
      -n public -n scatola_nera -n supabase_migrations -d "$DB_TEMP_URL"
    n_err="$(grep -c '^pg_restore: error' "$W/schema-e-dati.err" || true)"
    echo "RISULTATO fase=schema-e-dati ruoli_creati=$ruoli estensioni=$estensioni errori_pg_restore=$n_err secondi_ripristino=$((SECONDS - prima))"
    EXTRA=" errori_pg_restore=$n_err"
  }

  fase_auth_e_storage() {
    richiedi_db
    richiedi_dump
    local n_dati n_trigger replica n_err prima=$SECONDS
    : > "$W/indice.err"
    ripristina "$W/indice.err" -l -f "$W/indice.txt"
    [ -s "$W/indice.txt" ] || errore "pg_restore non ha letto l'indice del dump"

    # I DATI di auth (tranne le sue migrazioni: il progetto nuovo ha le proprie) e quelli dei bucket. MAI i dati
    # di storage.objects: sono l'indice dei file, e se ci fossero già rclone vedrebbe i file come presenti e non
    # copierebbe niente. Le righe nascono con i file, nella fase «file». Si tiene l'ordine del dump: da una pipe
    # pg_restore non può tornare indietro.
    grep -E '^[0-9]+; [0-9]+ [0-9]+ ((TABLE DATA|SEQUENCE SET) auth |TABLE DATA storage buckets )' "$W/indice.txt" \
      | grep -v ' TABLE DATA auth schema_migrations ' > "$W/lista-dati.txt" || true
    grep -E '^[0-9]+; [0-9]+ [0-9]+ (TRIGGER|POLICY) (auth|storage) ' "$W/indice.txt" > "$W/lista-trigger.txt" || true
    n_dati="$(wc -l < "$W/lista-dati.txt" | tr -d ' ')"
    n_trigger="$(wc -l < "$W/lista-trigger.txt" | tr -d ' ')"
    [ "$n_dati" -gt 0 ] || errore "nell'indice del dump non ci sono dati di auth: non è il dump giusto"

    replica="$(Q -c "set session_replication_role = replica" -c "/* @prova-replica */ show session_replication_role;" 2>> "$W/replica.err" || true)"
    if [ "$replica" = "replica" ]; then
      replica="si"
    else
      replica="no"
      echo "ATTENZIONE: il ruolo non può impostare session_replication_role: i dati di auth si caricano con chiavi esterne e trigger accesi, e auth.identities può restare vuota (lo dirà la fase conteggi)" >&2
    fi

    : > "$W/auth-e-storage.err"
    ripristina_in_replica "$W/auth-e-storage.err" --no-owner -L "$W/lista-dati.txt"
    ripristina "$W/auth-e-storage.err" --no-owner --section=post-data \
      -n public -n scatola_nera -n supabase_migrations -d "$DB_TEMP_URL"
    if [ "$n_trigger" -gt 0 ]; then
      ripristina "$W/auth-e-storage.err" --no-owner -L "$W/lista-trigger.txt" -d "$DB_TEMP_URL"
    fi
    n_err="$(grep -Ec '^pg_restore: error|ERROR:' "$W/auth-e-storage.err" || true)"
    echo "RISULTATO fase=auth-e-storage voci_dati=$n_dati voci_trigger=$n_trigger replica=$replica errori=$n_err secondi_ripristino=$((SECONDS - prima))"
    EXTRA=" errori=$n_err"
  }
  ```
  Nel `case` dello smistamento, prima della riga `*) errore …`, aggiungi:
  ```bash
    schema-e-dati) fase_schema_e_dati ;;
    auth-e-storage) fase_auth_e_storage ;;
  ```

- [ ] **Passo 5: verde.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-ripristina-progetto.test.ts
  ```
  Atteso: `Test Files  1 passed (1)`, `Tests  26 passed (26)`.

- [ ] **Passo 6: commit.**
  ```bash
  git add scripts/backup/ripristina-progetto.sh __tests__/lib/backup-ripristina-progetto.test.ts
  git commit -m "Ripristino completo: schema e dati dell'app, poi auth e bucket in replica, vincoli, trigger e policy" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Compito 4: la fase `conteggi`

**File:**
- Modifica: `scripts/backup/ripristina-progetto.sh` (blocco `#@CONTEGGI` prima di «le fasi», una funzione, una riga nel `case`)
- Test: `__tests__/lib/backup-ripristina-progetto.test.ts` (in fondo)

- [ ] **Passo 1: la prova rossa.** In fondo al file di prova aggiungi:
  ```ts
  describe('ripristina-progetto.sh · fase 4, conteggi', () => {
      const prima = ['cron-spento', 'schema-e-dati', 'auth-e-storage']

      it('righe uguali al manifest → riuscita; le tabelle della piattaforma si saltano e si contano', () => {
          segna(...prima)
          const r = esegui('conteggi')
          expect(r.status, r.err).toBe(0)
          expect(r.out).toMatch(/^RISULTATO fase=conteggi tabelle_confrontate=5 uguali=5 diverse=0 saltate_piattaforma=4 realtime_tabelle=2$/m)
      })

      it('una tabella con meno righe → fallita, e dice QUALE (solo il nome)', () => {
          segna(...prima)
          const r = esegui('conteggi', { FAKE_CONTEGGI: JSON.stringify({ ...CONTEGGI_UGUALI, 'public.alunni': 700 }) })
          expect(r.status).not.toBe(0)
          expect(r.out).toMatch(/tabelle_confrontate=5 uguali=4 diverse=1/)
          expect(r.err).toContain('public.alunni')
      })

      it('una tabella che non c\'è → fallita', () => {
          segna(...prima)
          const senza = Object.fromEntries(Object.entries(CONTEGGI_UGUALI).filter(([k]) => k !== 'public.utenti'))
          const r = esegui('conteggi', { FAKE_CONTEGGI: JSON.stringify(senza) })
          expect(r.status).not.toBe(0)
          expect(r.err).toContain('public.utenti')
      })

      it('una tabella ESCLUSA dal backup con righe → fallita (quei dati non dovevano esserci)', () => {
          segna(...prima)
          const r = esegui('conteggi', { FAKE_CONTEGGI: JSON.stringify({ ...CONTEGGI_UGUALI, 'auth.sessions': 4 }) })
          expect(r.status).not.toBe(0)
          expect(r.err).toContain('auth.sessions (doveva essere vuota)')
      })

      it('se pg_cron è ricomparso, i conteggi non bastano: fallita', () => {
          segna(...prima)
          expect(esegui('conteggi', { FAKE_CRON: '1' }).status).not.toBe(0)
      })

      it('PROVA GEMELLA: senza il salto delle tabelle della piattaforma, una prova giusta sembrerebbe sbagliata', () => {
          segna(...prima)
          const p = mutato(/def piattaforma: [^;]*;/, 'def piattaforma: false;')
          const r = esegui('conteggi', {}, p)
          expect(r.status).not.toBe(0)
          expect(r.err).toContain('storage.objects')
      })

      it('conta le righe con la STESSA query del dump (testo identico fra i marcatori)', () => {
          const fra = (file: string) => {
              const t = readFileSync(join(process.cwd(), 'scripts', 'backup', file), 'utf8')
              const m = /#@CONTEGGI-INIZIO\n([\s\S]*?)#@CONTEGGI-FINE/.exec(t)
              expect(m, `i marcatori #@CONTEGGI mancano in ${file}`).not.toBeNull()
              return m![1].trim()
          }
          expect(fra('ripristina-progetto.sh')).toBe(fra('dump-cifrato.sh'))
      })
  })
  ```

- [ ] **Passo 2: rossa.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-ripristina-progetto.test.ts -t "conteggi"
  ```
  Atteso: `FAIL`: «la fase «conteggi» non è ancora nello script»; i marcatori mancano; la gemella non trova `def piattaforma`.

- [ ] **Passo 3: il codice.** Subito **prima** della riga `# ── le fasi ──…` aggiungi (il testo fra i marcatori è
  copiato da `scripts/backup/dump-cifrato.sh:107-109`, fra i marcatori `#@CONTEGGI-INIZIO` e `#@CONTEGGI-FINE`,
  carattere per carattere):
  ```bash
  # ── i conteggi, con la STESSA query del dump ─────────────────────────────────
  #@CONTEGGI-INIZIO
  SQL_CONTEGGI="(SELECT json_object_agg(schemaname || '.' || tablename, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename), false, true, '')))[1]::text::bigint) FROM pg_tables WHERE schemaname IN ('public','auth','storage','cron','supabase_migrations','scatola_nera'))"
  #@CONTEGGI-FINE

  ```
  Subito **prima** della riga `# ── smistamento ──…` aggiungi:
  ```bash
  fase_conteggi() {
    richiedi_db
    leggi_manifest
    controlla_cron_assente
    local ripristinati esc giudizio n_confr n_diverse n_uguali saltate realtime
    ripristinati="$(Q -c "select $SQL_CONTEGGI;")"
    [ -n "$ripristinati" ] || errore "non riesco a contare le righe del progetto temporaneo"
    esc="$(printf '%s' "$RIGA2" | jq -c '.dati_esclusi // []')"
    # Le tabelle della PIATTAFORMA non si confrontano: pg_cron non c'è (cron.*), le migrazioni di auth e di storage
    # sono quelle del progetto nuovo, gli oggetti dello Storage li conta la fase «file».
    giudizio="$(printf '%s' "$META" | jq -c --argjson r "$ripristinati" --argjson esc "$esc" '
      def piattaforma: startswith("cron.") or . == "auth.schema_migrations" or (startswith("storage.") and . != "storage.buckets");
      .conteggi as $m
      | [ $m | keys[] | select(. as $t | ($esc | index($t)) | not) ] as $candidate
      | [ $candidate[] | select(piattaforma | not) ] as $da_confrontare
      | { da_confrontare: ($da_confrontare | length),
          saltate: ([ $candidate[] | select(piattaforma) ] | length),
          diverse: [ $da_confrontare[] | select(($r[.] // -1) != $m[.]) ],
          escluse_non_vuote: [ $esc[] | select(($r[.] // 0) != 0) ] }')"
    n_confr="$(printf '%s' "$giudizio" | jq -r '.da_confrontare')"
    saltate="$(printf '%s' "$giudizio" | jq -r '.saltate')"
    n_diverse=$(( $(printf '%s' "$giudizio" | jq -r '.diverse | length') + $(printf '%s' "$giudizio" | jq -r '.escluse_non_vuote | length') ))
    n_uguali=$(( n_confr - $(printf '%s' "$giudizio" | jq -r '.diverse | length') ))
    realtime="$(Q -c "/* @realtime */ select count(*) from pg_publication_tables where pubname = 'supabase_realtime';")"
    echo "RISULTATO fase=conteggi tabelle_confrontate=$n_confr uguali=$n_uguali diverse=$n_diverse saltate_piattaforma=$saltate realtime_tabelle=$realtime"
    if [ "$n_diverse" -ne 0 ]; then
      echo "TABELLE DIVERSE (solo i nomi):" >&2
      printf '%s' "$giudizio" | jq -r '(.diverse[]?), (.escluse_non_vuote[]? | . + " (doveva essere vuota)")' | sed 's/^/  /' >&2
    fi
    [ "$n_diverse" -eq 0 ] || errore "il progetto temporaneo NON coincide con il manifest: $n_diverse tabelle diverse"
    EXTRA=" tabelle=$n_confr"
  }
  ```
  Nel `case`, prima di `*) errore …`:
  ```bash
    conteggi) fase_conteggi ;;
  ```

- [ ] **Passo 4: verde.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-ripristina-progetto.test.ts
  ```
  Atteso: `Test Files  1 passed (1)`, `Tests  33 passed (33)`.

- [ ] **Passo 5: commit.**
  ```bash
  git add scripts/backup/ripristina-progetto.sh __tests__/lib/backup-ripristina-progetto.test.ts
  git commit -m "Ripristino completo: conteggi contro il manifest, con la stessa query del dump" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Compito 5: la fase `vault-bucket-realtime`

**File:**
- Modifica: `scripts/backup/ripristina-progetto.sh` (due funzioni prima di «smistamento», una riga nel `case`)
- Test: `__tests__/lib/backup-ripristina-progetto.test.ts` (in fondo)

- [ ] **Passo 1: la prova rossa.** In fondo al file di prova aggiungi:
  ```ts
  describe('ripristina-progetto.sh · fase 5, vault-bucket-realtime', () => {
      const prima = ['cron-spento', 'schema-e-dati', 'auth-e-storage', 'conteggi']
      const nBucket = bucketDellaFotografia().split(' ').length

      it('crea le sei chiavi dal flusso (mai negli argomenti), con URL in .invalid; bucket e Realtime coincidono', () => {
          segna(...prima)
          const r = esegui('vault-bucket-realtime')
          expect(r.status, r.err).toBe(0)
          expect(r.out).toMatch(new RegExp(
              `^RISULTATO fase=vault-bucket-realtime chiavi_vault=6 bucket=${nBucket} bucket_diversi=0 realtime_tabelle=2$`, 'm'))
          const sql = leggi('psql.sql')
          expect(sql.match(/select vault\.create_secret\(/g)).toHaveLength(6)
          expect(sql).toContain(`select vault.create_secret('${SEGRETO}', 'app.cron_secret')`)
          expect(sql).toContain("select vault.create_secret('https://ripristino-prova.invalid/push_dispatch_url', 'app.push_dispatch_url')")
          expect(sql).toContain('alter publication supabase_realtime add table public.chat_messages;')
          expect(leggi('psql.args')).not.toContain(SEGRETO)
          expect(r.out + r.err).not.toContain(SEGRETO)
      })

      it('nessun URL del Vault porta a un indirizzo vero', () => {
          segna(...prima)
          esegui('vault-bucket-realtime')
          const urls = [...leggi('psql.sql').matchAll(/create_secret\('(https?:[^']+)'/g)].map((m) => m[1])
          expect(urls).toHaveLength(5)
          for (const u of urls) expect(new URL(u).hostname).toBe('ripristino-prova.invalid')
      })

      it('le chiavi sono esattamente quelle che le migrazioni leggono con cron_config', () => {
          const dir = join(process.cwd(), 'supabase', 'migrations')
          const lette = new Set<string>()
          for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
              for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/cron_config\('(app\.[a-z_]+)'\)/g)) lette.add(m[1])
          }
          const chiavi = /^CHIAVI_VAULT="([^"]+)"$/m.exec(readFileSync(SCRIPT, 'utf8'))![1].split(' ')
          expect([...chiavi].sort()).toEqual([...lette].sort())
          expect(lette.size).toBeGreaterThanOrEqual(6)
      })

      it('un segreto mancante o malformato ferma la fase prima di toccare il Vault', () => {
          segna(...prima)
          for (const s of ['', 'corto', 'AB'.repeat(32)]) {
              const r = esegui('vault-bucket-realtime', { SEGRETO_CRON_PROVA: s })
              expect(r.status, s).not.toBe(0)
              expect(r.err).toMatch(/SEGRETO_CRON_PROVA/)
          }
          expect(leggi('psql.sql')).not.toContain('@vault-crea')
      })

      it('se il Vault rifiuta le chiavi, l\'errore di psql (che cita l\'istruzione col segreto) non si stampa', () => {
          segna(...prima)
          const r = esegui('vault-bucket-realtime', { FAKE_VAULT_ERRORE: '1' })
          expect(r.status).not.toBe(0)
          expect(r.out + r.err).not.toContain(SEGRETO)
      })

      it('un Vault che non risponde come atteso → fallita', () => {
          segna(...prima)
          expect(esegui('vault-bucket-realtime', { FAKE_VAULT: '6|false|true' }).status).not.toBe(0)
      })

      it('un bucket mancante o con la visibilità cambiata → fallita, e dice quale', () => {
          segna(...prima)
          const senza = bucketDellaFotografia().split(' ').filter((b) => !b.startsWith('registro-allegati:')).join(' ')
          const r1 = esegui('vault-bucket-realtime', { FAKE_BUCKET: senza })
          expect(r1.status).not.toBe(0)
          expect(r1.err).toContain('registro-allegati')
          const aperto = bucketDellaFotografia().replace('pagelle:false', 'pagelle:true')
          const r2 = esegui('vault-bucket-realtime', { FAKE_BUCKET: aperto })
          expect(r2.status).not.toBe(0)
          expect(r2.err).toContain('pagelle:true')
      })

      it('Realtime con un numero diverso di tabelle → fallita; una riga malformata nell\'elenco → fallita prima di scrivere', () => {
          segna(...prima)
          expect(esegui('vault-bucket-realtime', { FAKE_REALTIME: '1' }).status).not.toBe(0)
          const elenco = join(radice, 'realtime-rotto.txt')
          writeFileSync(elenco, 'public.chat_messages; drop table x\n')
          const r = esegui('vault-bucket-realtime', { ELENCO_REALTIME: elenco })
          expect(r.status).not.toBe(0)
          expect(leggi('psql.sql')).not.toContain('drop table')
      })
  })
  ```

- [ ] **Passo 2: rossa.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-ripristina-progetto.test.ts -t "vault-bucket-realtime"
  ```
  Atteso: `FAIL`: «la fase «vault-bucket-realtime» non è ancora nello script». La prova sui nomi delle chiavi passa già
  (la costante c'è dallo scheletro): se fallisce, una migrazione nuova legge una chiave che `CHIAVI_VAULT` non ha, e va
  aggiunta.

- [ ] **Passo 3: il codice.** Subito **prima** della riga `# ── smistamento ──…` aggiungi:
  ```bash
  lista_sql() {
    local out="" x
    for x in "$@"; do out="$out${out:+, }'$x'"; done
    printf '%s' "$out"
  }

  fase_vault_bucket_realtime() {
    richiedi_db
    local s="${SEGRETO_CRON_PROVA:-}" k v n_chiavi verifica
    printf '%s' "$s" | grep -Eq '^[0-9a-f]{64}$' \
      || errore "SEGRETO_CRON_PROVA deve essere 64 cifre esadecimali minuscole (openssl rand -hex 32), mai quello della produzione"
    [ -f "$FOTOGRAFIA_BUCKET" ] || errore "manca la fotografia dei bucket ($FOTOGRAFIA_BUCKET)"
    [ -f "$ELENCO_REALTIME" ] || errore "manca l'elenco delle tabelle del Realtime ($ELENCO_REALTIME)"
    local invalide attese_rt
    invalide="$(grep -Ev '^(#|$)' "$ELENCO_REALTIME" | grep -Evc '^[a-z_]+\.[a-z0-9_]+$' || true)"
    [ "$invalide" = "0" ] || errore "$ELENCO_REALTIME ha $invalide righe che non sono «schema.tabella»"
    attese_rt="$(grep -Evc '^(#|$)' "$ELENCO_REALTIME" || true)"
    [ "$attese_rt" -gt 0 ] || errore "l'elenco delle tabelle del Realtime è vuoto"
    n_chiavi="$(echo $CHIAVI_VAULT | wc -w | tr -d ' ')"

    # 1. Il Vault, con la ricetta della sessione 4 (vault.create_secret). Il segreto passa dallo stdin, mai dagli
    #    argomenti (si vedono con ps); un errore di psql cita l'istruzione, quindi va nel file. Gli URL finiscono
    #    in .invalid (RFC 2606): non portano da nessuna parte. In un disastro vero i valori veri si mettono alla
    #    fine, con vault.update_secret (runbook, scenario E).
    {
      echo "/* @vault-crea */"
      for k in $CHIAVI_VAULT; do
        if [ "$k" = "app.cron_secret" ]; then v="$s"; else v="$URL_FINTO/${k#app.}"; fi
        printf "select vault.create_secret('%s', '%s') where not exists (select 1 from vault.secrets where name = '%s');\n" "$v" "$k" "$k"
      done
    } | Q > /dev/null 2>> "$W/vault.err" \
      || errore "il Vault del progetto temporaneo non accetta le chiavi (dettagli solo con TIENI_ERRORI)"
    verifica="$(Q -c "/* @vault-verifica */ select (select count(*) from vault.decrypted_secrets where name in ($(lista_sql $CHIAVI_VAULT))) || '|' || (public.cron_config('app.push_dispatch_url') like '$URL_FINTO/%') || '|' || (length(public.cron_config('app.cron_secret')) = 64);" 2>> "$W/vault.err")" \
      || errore "non riesco a rileggere il Vault del progetto temporaneo"
    [ "$verifica" = "$n_chiavi|true|true" ] \
      || errore "il Vault del progetto temporaneo non risponde come atteso ($verifica invece di $n_chiavi|true|true)"

    # 2. I bucket, contro la fotografia versionata (id e visibilità).
    local attesi presenti diversi n_bucket
    attesi="$(jq -r '.bucket[] | "\(.id):\(.pubblico)"' "$FOTOGRAFIA_BUCKET" | LC_ALL=C sort)"
    presenti="$(Q -c "/* @bucket-presenti */ select id || ':' || public from storage.buckets;" | LC_ALL=C sort)"
    diversi="$(diff <(printf '%s\n' "$attesi") <(printf '%s\n' "$presenti") | grep -c '^[<>]' || true)"
    n_bucket="$(printf '%s\n' "$presenti" | grep -c . || true)"
    if [ "$diversi" -ne 0 ]; then
      echo "BUCKET DIVERSI dalla fotografia (< atteso, > presente):" >&2
      diff <(printf '%s\n' "$attesi") <(printf '%s\n' "$presenti") | grep '^[<>]' | sed 's/^/  /' >&2 || true
      errore "i bucket del progetto temporaneo non coincidono con la fotografia: $diversi righe diverse"
    fi

    # 3. La pubblicazione Realtime. Il dump non la contiene: le pubblicazioni non stanno in uno schema.
    local t presenti_rt
    {
      echo "/* @realtime-aggiungi */"
      grep -Ev '^(#|$)' "$ELENCO_REALTIME" | while IFS= read -r t; do
        printf "do \$\$ begin if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname || '.' || tablename = '%s') then alter publication supabase_realtime add table %s; end if; end \$\$;\n" "$t" "$t"
      done
    } | Q > /dev/null 2>> "$W/realtime.err" \
      || errore "la pubblicazione Realtime non accetta le tabelle dell'elenco"
    presenti_rt="$(Q -c "/* @realtime */ select count(*) from pg_publication_tables where pubname = 'supabase_realtime';")"
    [ "$presenti_rt" = "$attese_rt" ] || errore "pubblicazione Realtime: $presenti_rt tabelle invece di $attese_rt"

    echo "RISULTATO fase=vault-bucket-realtime chiavi_vault=$n_chiavi bucket=$n_bucket bucket_diversi=0 realtime_tabelle=$presenti_rt"
    EXTRA=" bucket=$n_bucket"
  }
  ```
  Nel `case`, prima di `*) errore …`:
  ```bash
    vault-bucket-realtime) fase_vault_bucket_realtime ;;
  ```

- [ ] **Passo 4: verde.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-ripristina-progetto.test.ts
  ```
  Atteso: `Test Files  1 passed (1)`, `Tests  41 passed (41)`.

- [ ] **Passo 5: commit.**
  ```bash
  git add scripts/backup/ripristina-progetto.sh __tests__/lib/backup-ripristina-progetto.test.ts
  git commit -m "Ripristino completo: Vault con indirizzi .invalid, bucket contro la fotografia, pubblicazione Realtime" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Compito 6: la fase `file`

**File:**
- Modifica: `scripts/backup/ripristina-progetto.sh` (due funzioni prima di «smistamento», una riga nel `case`)
- Test: `__tests__/lib/backup-ripristina-progetto.test.ts` (in fondo)

- [ ] **Passo 1: la prova rossa.** In fondo al file di prova aggiungi:
  ```ts
  describe('ripristina-progetto.sh · fase 6, file', () => {
      const prima = ['cron-spento', 'schema-e-dati', 'auth-e-storage', 'conteggi', 'vault-bucket-realtime']

      it('copia (mai sync) dallo specchio al progetto, per dimensione, senza i bucket esclusi; conta per bucket; apre i campioni', () => {
          segna(...prima)
          const r = esegui('file')
          expect(r.status, r.err).toBe(0)
          const copia = leggi('rclone.chiamate').split('\n').find((l) => l.startsWith('copy '))!
          expect(copia).toMatch(/^copy CRIPTO:corrente TEMP: --size-only /)
          expect(copia).toContain('--exclude /gallery/** --exclude /video_originals/**')
          expect(r.out).toMatch(/^BUCKET nome=avvisi_allegati specchio=3 progetto=3$/m)
          expect(r.out).toMatch(/^BUCKET nome=protocollo specchio=2 progetto=2$/m)
          expect(r.out).toMatch(/^RISULTATO fase=file bucket=2 bucket_diversi=0 oggetti_specchio=5 oggetti_progetto=5 byte_progetto=5000 errori_copia=0 secondi_copia=\d+$/m)
          expect(leggi('campioni.env')).toBe('SORGENTE=TEMP: SPECCHIO=CRIPTO:corrente ESCLUDI_BUCKET=gallery video_originals\n')
          expect(r.out).toMatch(/^RISULTATO provati=10 identici=10 /m)
      })

      it('non parte se il remote TEMP: punta alla produzione o a un altro progetto, o se lo specchio non è configurato', () => {
          segna(...prima)
          const casi: Record<string, string>[] = [
              { RCLONE_CONFIG_TEMP_ENDPOINT: `https://${PROD}.storage.supabase.co/storage/v1/s3` },
              { RCLONE_CONFIG_TEMP_ENDPOINT: 'https://zzzzzzzzzzzzzzzzzzzz.storage.supabase.co/storage/v1/s3' },
              { RCLONE_CONFIG_TEMP_ENDPOINT: '' },
              { RCLONE_CONFIG_CRIPTO_PASSWORD: '' },
          ]
          for (const extra of casi) {
              expect(esegui('file', extra).status, JSON.stringify(extra)).not.toBe(0)
          }
          expect(leggi('rclone.chiamate')).toBe('')
      })

      it('un bucket con meno oggetti dello specchio → fallita, e i campioni non si aprono', () => {
          segna(...prima)
          const r = esegui('file', {
              FAKE_CONTI: 'CRIPTO:corrente/avvisi_allegati=3 TEMP:avvisi_allegati=3 CRIPTO:corrente/protocollo=2 TEMP:protocollo=1',
          })
          expect(r.status).not.toBe(0)
          expect(r.out).toMatch(/^BUCKET nome=protocollo specchio=2 progetto=1$/m)
          expect(leggi('campioni.env')).toBe('')
      })

      it('un bucket che nel progetto non c\'è conta 0 → fallita', () => {
          segna(...prima)
          const r = esegui('file', { FAKE_CONTI: 'CRIPTO:corrente/avvisi_allegati=3 TEMP:avvisi_allegati=3 CRIPTO:corrente/protocollo=2' })
          expect(r.status).not.toBe(0)
          expect(r.out).toMatch(/^BUCKET nome=protocollo specchio=2 progetto=0$/m)
      })

      it('un errore di copia ferma la fase, e il nome del file (può dire di chi è) non si stampa', () => {
          segna(...prima)
          const r = esegui('file', { FAKE_COPIA_ESCE: '1' })
          expect(r.status).not.toBe(0)
          expect(r.out).toMatch(/ errori_copia=1 /)
          expect(r.out + r.err).not.toContain('NOME-FAMIGLIA-RISERVATO')
      })

      it('campioni diversi dallo specchio → fallita', () => {
          segna(...prima)
          expect(esegui('file', { FAKE_CAMPIONI_ESCE: '1' }).status).not.toBe(0)
      })

      it('la fase dei file non ha bisogno della stringa di connessione del database', () => {
          segna(...prima)
          expect(esegui('file', { DB_TEMP_URL: '' }).status).toBe(0)
      })

      it('lo script non usa MAI un comando di rclone che cancella o sposta', () => {
          const codice = readFileSync(SCRIPT, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
          expect(codice).not.toMatch(/\brclone\s+(sync|delete|deletefile|purge|move|moveto|rmdir|rmdirs|cleanup|dedupe)\b/)
          expect(codice).toMatch(/\brclone copy CRIPTO:corrente TEMP: /)
      })
  })
  ```

- [ ] **Passo 2: rossa.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-ripristina-progetto.test.ts -t "fase 6"
  ```
  Atteso: `FAIL`: «la fase «file» non è ancora nello script»; l'ultima prova non trova `rclone copy CRIPTO:corrente TEMP:`.

- [ ] **Passo 3: il codice.** Subito **prima** della riga `# ── smistamento ──…` aggiungi:
  ```bash
  conta() { # conta <remote:percorso> → «oggetti byte»; «0 0» se il percorso non c'è
    local j
    j="$(rclone size --json "$1" < /dev/null 2>> "$W/rclone.err" || true)"
    [ -n "$j" ] || j='{}'
    printf '%s' "$j" | jq -r '"\(.count // 0) \(.bytes // 0)"'
  }

  fase_file() {
    command -v rclone >/dev/null 2>&1 || errore "manca rclone nel PATH"
    local ep="${RCLONE_CONFIG_TEMP_ENDPOINT:-}"
    case "$ep" in *"$PROD_REF"*) errore "il remote TEMP: punta alla PRODUZIONE: fermo" ;; esac
    [ "$ep" = "https://$REF.storage.supabase.co/storage/v1/s3" ] \
      || errore "RCLONE_CONFIG_TEMP_ENDPOINT deve essere https://$REF.storage.supabase.co/storage/v1/s3"
    [ -n "${RCLONE_CONFIG_CRIPTO_PASSWORD:-}" ] || errore "il remote cifrato CRIPTO: non è configurato (runbook, «Collegarsi a R2»)"
    [ -f "$APRI_CAMPIONI" ] || errore "manca $APRI_CAMPIONI"

    local escludi="${ESCLUDI_BUCKET-gallery video_originals}" b filtri
    filtri=()
    for b in $escludi; do
      case "$b" in '' | *[!a-z0-9_-]*) errore "ESCLUDI_BUCKET: «$b» non è un nome di bucket valido" ;; esac
      filtri+=(--exclude "/$b/**")
    done

    # COPIA, non sync: un sync puntato per sbaglio sulla produzione cancellerebbe galleria e video, che nello
    # specchio non ci sono. Per DIMENSIONE: lo specchio è un crypt senza impronte e le sue date non coincidono mai
    # al secondo (specchio-storage.sh, FINESTRA_DATE); così una copia interrotta si riprende senza ricopiare tutto.
    # Il log di rclone cita i nomi dei file (possono dire di chi sono): resta nel file, mai sul terminale.
    local prima=$SECONDS st secondi_copia errori_copia
    set +e
    rclone copy CRIPTO:corrente TEMP: --size-only --s3-no-check-bucket --transfers 8 --checkers 16 \
      ${filtri[@]+"${filtri[@]}"} --log-level ERROR --stats 0 > "$W/copia.err" 2>&1
    st=$?
    set -e
    secondi_copia=$((SECONDS - prima))
    errori_copia="$(grep -c 'ERROR' "$W/copia.err" || true)"

    # Oggetti per bucket: specchio contro progetto.
    rclone lsf CRIPTO:corrente --dirs-only < /dev/null > "$W/cartelle.txt" 2>> "$W/rclone.err" \
      || errore "non riesco a elencare le cartelle dello specchio"
    local riga n_bucket=0 diversi=0 tot_s=0 tot_p=0 byte_p=0 cs cp_
    while IFS= read -r riga; do
      b="${riga%/}"
      [ -n "$b" ] || continue
      case "$b" in *[!a-z0-9_-]*) continue ;; esac
      case " $escludi " in *" $b "*) continue ;; esac
      cs="$(conta "CRIPTO:corrente/$b")"
      cp_="$(conta "TEMP:$b")"
      echo "BUCKET nome=$b specchio=${cs% *} progetto=${cp_% *}"
      n_bucket=$((n_bucket + 1))
      tot_s=$((tot_s + ${cs% *}))
      tot_p=$((tot_p + ${cp_% *}))
      byte_p=$((byte_p + ${cp_#* }))
      [ "${cs% *}" = "${cp_% *}" ] || diversi=$((diversi + 1))
    done < "$W/cartelle.txt"

    echo "RISULTATO fase=file bucket=$n_bucket bucket_diversi=$diversi oggetti_specchio=$tot_s oggetti_progetto=$tot_p byte_progetto=$byte_p errori_copia=$errori_copia secondi_copia=$secondi_copia"
    [ "$st" -eq 0 ] || errore "rclone copy è uscito con $st ($errori_copia righe di errore; i nomi dei file solo con TIENI_ERRORI)"
    [ "$n_bucket" -gt 0 ] || errore "lo specchio non ha cartelle: è il remote giusto?"
    [ "$diversi" -eq 0 ] || errore "$diversi bucket hanno un numero di oggetti diverso dallo specchio"

    # I campioni: per bucket alcuni file del progetto aperti e confrontati con lo specchio (impronta e firma dei
    # primi byte), senza mostrarli.
    SORGENTE="TEMP:" SPECCHIO="CRIPTO:corrente" ESCLUDI_BUCKET="$escludi" bash "$APRI_CAMPIONI" 2>> "$W/campioni.err" \
      || errore "i campioni aperti non coincidono con lo specchio (apri-campioni.sh)"
    EXTRA=" oggetti=$tot_p"
  }
  ```
  Nel `case`, prima di `*) errore …`:
  ```bash
    file) fase_file ;;
  ```

- [ ] **Passo 4: verde.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-ripristina-progetto.test.ts
  ```
  Atteso: `Test Files  1 passed (1)`, `Tests  49 passed (49)`.

- [ ] **Passo 5: commit.**
  ```bash
  git add scripts/backup/ripristina-progetto.sh __tests__/lib/backup-ripristina-progetto.test.ts
  git commit -m "Ripristino completo: copia dei file per dimensione (mai sync), oggetti per bucket, campioni aperti" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Compito 7: le fasi `login` e `riepilogo`, e il giro intero

**File:**
- Modifica: `scripts/backup/ripristina-progetto.sh` (tre funzioni prima di «smistamento»; il `case` intero)
- Test: `__tests__/lib/backup-ripristina-progetto.test.ts` (in fondo)

- [ ] **Passo 1: la prova rossa.** In fondo al file di prova aggiungi:
  ```ts
  describe('ripristina-progetto.sh · fase 7, login', () => {
      const prima = ['cron-spento', 'schema-e-dati', 'auth-e-storage', 'conteggi', 'vault-bucket-realtime', 'file']

      it('almeno una sessione in auth.sessions → riuscita', () => {
          segna(...prima)
          const r = esegui('login')
          expect(r.status, r.err).toBe(0)
          expect(r.out).toMatch(/^RISULTATO fase=login sessioni=1 righe_app_log=3$/m)
      })

      it('nessuna sessione → fallita: il login non è arrivato al progetto temporaneo', () => {
          segna(...prima)
          const r = esegui('login', { FAKE_LOGIN: '0|0' })
          expect(r.status).not.toBe(0)
          expect(r.err).toMatch(/progetto temporaneo/)
      })
  })

  describe('ripristina-progetto.sh · fase 8, riepilogo', () => {
      it('somma i tempi dell\'ultima riuscita di ogni fase e misura l\'orologio dalla prima all\'ultima', () => {
          writeFileSync(join(radice, 'registro.txt'), [
              'FASE nome=cron-spento esito=ok secondi=5 inizio=1000 fine=1005 inizio_utc=2026-11-03T08:00:00Z',
              'FASE nome=schema-e-dati esito=errore secondi=50 inizio=1010 fine=1060 inizio_utc=2026-11-03T08:00:10Z',
              'FASE nome=schema-e-dati esito=ok secondi=120 inizio=1100 fine=1220 inizio_utc=2026-11-03T08:01:40Z errori_pg_restore=5',
              'FASE nome=auth-e-storage esito=ok secondi=60 inizio=1300 fine=1360 inizio_utc=2026-11-03T08:03:20Z errori=2',
              'FASE nome=conteggi esito=ok secondi=10 inizio=1400 fine=1410 inizio_utc=2026-11-03T08:05:00Z tabelle=180',
              'FASE nome=vault-bucket-realtime esito=ok secondi=5 inizio=1500 fine=1505 inizio_utc=2026-11-03T08:06:40Z bucket=21',
              'FASE nome=file esito=ok secondi=3000 inizio=1600 fine=4600 inizio_utc=2026-11-03T08:08:20Z oggetti=5',
              'FASE nome=login esito=ok secondi=2 inizio=6000 fine=6002 inizio_utc=2026-11-03T09:23:20Z sessioni=1',
          ].join('\n') + '\n')
          const r = esegui('riepilogo')
          expect(r.status, r.err).toBe(0)
          expect(r.out).toMatch(/^TEMPO fase=schema-e-dati secondi=120$/m)
          expect(r.out).toMatch(/^RISULTATO fase=riepilogo fasi_ok=7 secondi_fasi=3202 orologio=5002 inizio_utc=2026-11-03T08:00:00Z$/m)
      })

      it('una fase mai riuscita → la dice mancante, e il riepilogo fallisce', () => {
          segna('cron-spento', 'schema-e-dati')
          const r = esegui('riepilogo')
          expect(r.status).not.toBe(0)
          expect(r.out).toMatch(/^TEMPO fase=login esito=mancante$/m)
      })

      it('il riepilogo non scrive nel registro', () => {
          segna('cron-spento')
          const prima = registro()
          esegui('riepilogo')
          expect(registro()).toBe(prima)
      })
  })

  describe('ripristina-progetto.sh · il giro intero, nell\'ordine', () => {
      it('le otto fasi una dopo l\'altra riescono, e il registro ha sette righe «ok» nell\'ordine giusto', () => {
          const sette = ['cron-spento', 'schema-e-dati', 'auth-e-storage', 'conteggi', 'vault-bucket-realtime', 'file', 'login']
          for (const f of sette) {
              const r = esegui(f)
              expect(r.status, `${f}: ${r.err}`).toBe(0)
          }
          const r = esegui('riepilogo')
          expect(r.status, r.err).toBe(0)
          expect(r.out).toMatch(/ fasi_ok=7 /)
          expect([...registro().matchAll(/^FASE nome=(\S+) esito=ok /gm)].map((m) => m[1])).toEqual(sette)
          expect(readdirSync(radice).filter((n) => n.startsWith('ripristino-progetto.'))).toEqual([])
      })
  })
  ```

- [ ] **Passo 2: rossa.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-ripristina-progetto.test.ts -t "login|riepilogo|giro intero"
  ```
  Atteso: `FAIL`: «la fase «login» non è ancora nello script» e lo stesso per `riepilogo`.

- [ ] **Passo 3: il codice.** Subito **prima** della riga `# ── smistamento ──…` aggiungi:
  ```bash
  fase_login() {
    richiedi_db
    local r sessioni righe
    r="$(Q -c "/* @login */ select (select count(*) from auth.sessions) || '|' || (select count(*) from public.app_log);")"
    sessioni="${r%%|*}"
    righe="${r##*|}"
    case "$sessioni" in '' | *[!0-9]*) errore "risposta inattesa dal progetto temporaneo" ;; esac
    echo "RISULTATO fase=login sessioni=$sessioni righe_app_log=$righe"
    [ "$sessioni" -ge 1 ] || errore "nessuna sessione in auth.sessions: il login sull'anteprima non è arrivato al progetto temporaneo"
    EXTRA=" sessioni=$sessioni"
  }

  campo() { # campo <nome> <riga del registro>
    printf '%s\n' "$2" | sed -n "s/.* $1=\([^ ]*\).*/\1/p"
  }

  fase_riepilogo() {
    [ -f "$REGISTRO" ] || errore "nessun registro in $REGISTRO: non è stata lanciata nessuna fase"
    local f riga s ok=0 attese=0 somma=0 primo="" ultimo="" utc="" orologio=0
    for f in $FASI; do
      if [ "$f" = "riepilogo" ]; then continue; fi
      attese=$((attese + 1))
      riga="$( { grep "^FASE nome=$f esito=ok " "$REGISTRO" || true; } | tail -n 1)"
      if [ -z "$riga" ]; then
        echo "TEMPO fase=$f esito=mancante"
        continue
      fi
      s="$(campo secondi "$riga")"
      echo "TEMPO fase=$f secondi=$s"
      ok=$((ok + 1))
      somma=$((somma + s))
      if [ -z "$primo" ]; then
        primo="$(campo inizio "$riga")"
        utc="$(campo inizio_utc "$riga")"
      fi
      ultimo="$(campo fine "$riga")"
    done
    if [ -n "$primo" ]; then orologio=$((ultimo - primo)); fi
    echo "RISULTATO fase=riepilogo fasi_ok=$ok secondi_fasi=$somma orologio=$orologio inizio_utc=${utc:-nessuno}"
    [ "$ok" -eq "$attese" ] || errore "fasi riuscite: $ok su $attese"
  }
  ```
  Poi sostituisci **tutto** il blocco dello smistamento (dalla riga `case "$FASE" in` fino a `ESITO="ok"` compreso) con:
  ```bash
  case "$FASE" in
    cron-spento) fase_cron_spento ;;
    schema-e-dati) fase_schema_e_dati ;;
    auth-e-storage) fase_auth_e_storage ;;
    conteggi) fase_conteggi ;;
    vault-bucket-realtime) fase_vault_bucket_realtime ;;
    file) fase_file ;;
    login) fase_login ;;
    riepilogo) fase_riepilogo ;;
  esac
  ESITO="ok"
  ```

- [ ] **Passo 4: verde, e il file intero.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-ripristina-progetto.test.ts
  bash -n scripts/backup/ripristina-progetto.sh && bash scripts/backup/ripristina-progetto.sh --a-secco
  ```
  Atteso: `Tests  55 passed (55)`; poi le otto righe `PASSO 1 cron-spento — …` … `PASSO 8 riepilogo — …`.

- [ ] **Passo 5: commit.**
  ```bash
  git add scripts/backup/ripristina-progetto.sh __tests__/lib/backup-ripristina-progetto.test.ts
  git commit -m "Ripristino completo: login sull'anteprima, riepilogo dei tempi, giro intero provato con i finti" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Compito 8: le impostazioni di Auth e Storage, senza segreti

**File:**
- Crea: `scripts/backup/impostazioni-senza-segreti.sh`
- Test: `__tests__/lib/backup-impostazioni-senza-segreti.test.ts`

- [ ] **Passo 1: la prova rossa.** Crea `__tests__/lib/backup-impostazioni-senza-segreti.test.ts`:
  ```ts
  // @vitest-environment node
  import { describe, it, expect } from 'vitest'
  import { spawnSync } from 'node:child_process'
  import { join } from 'node:path'

  /**
   * `scripts/backup/impostazioni-senza-segreti.sh` — le impostazioni di Auth e di Storage di un progetto Supabase,
   * da versionare in `docs/impostazioni-supabase/` (seconda serie di robustezza, sessione 5).
   *
   * Un ripristino su un progetto nuovo NON copia queste impostazioni (analisi del 20/10, D5). Il repository è
   * PUBBLICO: passa solo ciò che è in una lista bianca. Ogni altra stringa sparisce, e resta il suo NOME.
   */

  const SCRIPT = join(process.cwd(), 'scripts', 'backup', 'impostazioni-senza-segreti.sh')

  function esegui(tipo: string, ingresso: unknown) {
      const r = spawnSync('bash', [SCRIPT, tipo], {
          encoding: 'utf8',
          input: typeof ingresso === 'string' ? ingresso : JSON.stringify(ingresso),
          env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp' },
      })
      return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
  }

  const AUTH = {
      site_url: 'https://app.esempio.invalid',
      uri_allow_list: 'https://app.esempio.invalid/**',
      jwt_exp: 3600,
      disable_signup: true,
      mailer_autoconfirm: false,
      mailer_subjects_invite: 'Sei stato invitato',
      mailer_templates_invite_content: '<p>{{ .ConfirmationURL }}</p>',
      smtp_host: 'smtp.esempio.invalid',
      smtp_port: '587',
      smtp_user: 'utente-smtp',
      smtp_pass: 'SEGRETO-FINTO-SMTP',
      smtp_admin_email: 'mittente@esempio.invalid',
      external_google_secret: 'SEGRETO-FINTO-GOOGLE',
      hook_custom_access_token_secrets: 'v1,whsec_SEGRETOFINTO',
      sms_twilio_auth_token: 'SEGRETO-FINTO-TWILIO',
      rate_limit_email_sent: 30,
      annidato: { chiave: 'SEGRETO-FINTO-ANNIDATO', numero: 7, elenco: ['SEGRETO-FINTO-IN-ELENCO', 3] },
  }

  describe('impostazioni-senza-segreti.sh', () => {
      it('auth: passano numeri, booleani e le poche stringhe ammesse; ogni altra stringa sparisce e resta il suo nome', () => {
          const r = esegui('auth', AUTH)
          expect(r.status, r.err).toBe(0)
          const j = JSON.parse(r.out)
          expect(j.site_url).toBe(AUTH.site_url)
          expect(j.jwt_exp).toBe(3600)
          expect(j.disable_signup).toBe(true)
          expect(j.mailer_subjects_invite).toBe(AUTH.mailer_subjects_invite)
          expect(j.smtp_port).toBe('587')
          expect(j.annidato).toEqual({ numero: 7, elenco: [3] })
          expect(j._tipo).toBe('auth')
          expect(j._omesse).toEqual([
              'annidato.chiave', 'annidato.elenco.0', 'external_google_secret', 'hook_custom_access_token_secrets',
              'sms_twilio_auth_token', 'smtp_admin_email', 'smtp_pass', 'smtp_user',
          ])
          expect(r.out).not.toMatch(/SEGRETO-FINTO|whsec_|utente-smtp|mittente@/)
      })

      it('storage: il limite dei file e le funzioni accese passano, le stringhe no', () => {
          const r = esegui('storage', {
              fileSizeLimit: 524288000,
              features: { imageTransformation: { enabled: true }, s3Protocol: { enabled: true } },
              external: { upstreamTarget: 'main' },
          })
          expect(r.status, r.err).toBe(0)
          const j = JSON.parse(r.out)
          expect(j.fileSizeLimit).toBe(524288000)
          expect(j.features.s3Protocol.enabled).toBe(true)
          expect(j.external).toEqual({})
          expect(j._omesse).toEqual(['external.upstreamTarget'])
      })

      it('l\'uscita è ordinata: lo stesso ingresso in un altro ordine dà lo stesso file', () => {
          const rovesciato = Object.fromEntries(Object.entries(AUTH).reverse())
          expect(esegui('auth', rovesciato).out).toBe(esegui('auth', AUTH).out)
      })

      it('una risposta che non è la configurazione (token scaduto, errore, altro progetto) → nessuna uscita', () => {
          const casi: [string, unknown][] = [
              ['auth', { message: 'Unauthorized' }],
              ['storage', { site_url: 'x' }],
              ['auth', 'non è json'],
              ['altro', AUTH],
          ]
          for (const [tipo, ingresso] of casi) {
              const r = esegui(tipo, ingresso)
              expect(r.status, `${tipo} ${JSON.stringify(ingresso)}`).not.toBe(0)
              expect(r.out).toBe('')
          }
      })

      it('una chiave finita in un campo ammesso ferma tutto, senza stamparla', () => {
          const r = esegui('auth', { ...AUTH, site_url: 'sbp_0123456789abcdef0123456789abcdef' })
          expect(r.status).not.toBe(0)
          expect(r.out).toBe('')
          expect(r.err).not.toContain('sbp_0123')
      })
  })
  ```

- [ ] **Passo 2: rossa.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-impostazioni-senza-segreti.test.ts
  ```
  Atteso: `FAIL`, `Tests  4 failed | 1 passed` (la prova «nessuna uscita» passa già: lo script non c'è ed esce 127).

- [ ] **Passo 3: il codice.** Crea `scripts/backup/impostazioni-senza-segreti.sh`:
  ```bash
  #!/usr/bin/env bash
  # Le impostazioni di Auth o di Storage di un progetto Supabase, SENZA SEGRETI, da versionare in docs/.
  #
  # Seconda serie di robustezza, sessione 5. Un ripristino su un progetto nuovo NON copia le impostazioni di
  # Auth né di Storage (docs/analisi-robustezza-2026-10-20.md, D5): se non sono scritte da qualche parte, il
  # giorno del disastro si rifanno a memoria. Lo script legge sullo stdin la risposta della Management API
  # (GET /v1/projects/{ref}/config/auth oppure …/config/storage) e stampa un JSON ordinato in cui passano SOLO:
  #   · numeri, booleani e null, a qualunque profondità;
  #   · le stringhe di poche chiavi che non sono segreti: URL del sito e dei redirect, oggetti e testi delle
  #     email, host e porta SMTP, nome del mittente, fornitore del CAPTCHA, caratteri richiesti nelle password.
  # Ogni altra stringa (chiavi, segreti, password, token, indirizzi) sparisce, e il suo NOME finisce in
  # «_omesse»: chi ripristina sa che cosa rimettere a mano, senza che il valore passi dal repository.
  #
  # Uso (lo lancia il titolare, con il suo token personale digitato con read -rs):
  #   curl -sS "https://api.supabase.com/v1/projects/<ref>/config/auth" -H "Authorization: Bearer $SUPABASE_PAT" \
  #     | bash scripts/backup/impostazioni-senza-segreti.sh auth > docs/impostazioni-supabase/auth.json
  #
  # Compatibile con bash 3.2 (il Mac).

  set -euo pipefail

  errore() {
    echo "ERRORE: $*" >&2
    exit 1
  }

  TIPO="${1:-}"
  case "$TIPO" in
    auth) SENTINELLA="site_url" ;;
    storage) SENTINELLA="fileSizeLimit" ;;
    *) errore "uso: impostazioni-senza-segreti.sh auth|storage, con il JSON della Management API sullo stdin" ;;
  esac
  command -v jq >/dev/null 2>&1 || errore "manca jq nel PATH"

  INGRESSO="$(cat)"
  printf '%s' "$INGRESSO" | jq -e --arg s "$SENTINELLA" 'type == "object" and has($s)' > /dev/null 2>&1 \
    || errore "lo stdin non è la risposta di /config/$TIPO (manca «$SENTINELLA»): token scaduto o progetto sbagliato?"

  USCITA="$(printf '%s' "$INGRESSO" | jq -S --arg tipo "$TIPO" '
    def ammessa: test("^(site_url|uri_allow_list|password_required_characters|smtp_host|smtp_port|smtp_sender_name|security_captcha_provider|mailer_subjects_[a-z_]+|mailer_templates_[a-z_]+_content)$");
    def pulisci:
      if type == "object" then with_entries(select((.value | type) != "string" or (.key | ammessa)) | .value |= pulisci)
      elif type == "array" then map(select(type != "string") | pulisci)
      else . end;
    def percorsi_testo: [ paths(type == "string") | map(tostring) | join(".") ];
    pulisci as $tenuto
    | ($tenuto | percorsi_testo) as $rimasti
    | $tenuto + {
        _tipo: $tipo,
        _omesse: ((percorsi_testo - $rimasti) | sort),
        _come_si_rigenera: ("curl -sS https://api.supabase.com/v1/projects/<ref>/config/" + $tipo + " -H \"Authorization: Bearer $SUPABASE_PAT\" | bash scripts/backup/impostazioni-senza-segreti.sh " + $tipo)
      }')"

  # Rete sotto la lista bianca: un valore AMMESSO che ha la forma di una chiave ferma tutto.
  SOSPETTE="$(printf '%s' "$USCITA" | jq '[ paths(type == "string") as $p | select(($p[0] | tostring | startswith("_")) | not) | getpath($p) | select(test("sb_secret_|sbp_|eyJ[A-Za-z0-9_-]{10,}|whsec_|re_[A-Za-z0-9]{16,}")) ] | length')"
  [ "$SOSPETTE" = "0" ] || errore "$SOSPETTE valori fra quelli ammessi hanno la forma di una chiave: non scrivo niente"

  printf '%s\n' "$USCITA"
  ```

- [ ] **Passo 4: verde.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-impostazioni-senza-segreti.test.ts
  ```
  Atteso: `Tests  5 passed (5)`.

- [ ] **Passo 5: commit.**
  ```bash
  git add scripts/backup/impostazioni-senza-segreti.sh __tests__/lib/backup-impostazioni-senza-segreti.test.ts
  git commit -m "Ripristino completo: impostazioni di Auth e Storage esportabili senza segreti" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Compito 9: l'elenco versionato del Realtime

**File:**
- Crea: `docs/impostazioni-supabase/realtime.txt`
- Test: `__tests__/lib/backup-ripristina-progetto.test.ts` (in fondo)

- [ ] **Passo 1: la prova rossa.** In fondo al file di prova aggiungi:
  ```ts
  describe('l\'elenco versionato del Realtime', () => {
      it('esiste, ha solo righe «schema.tabella», senza doppioni, e almeno una tabella', () => {
          const p = join(process.cwd(), 'docs', 'impostazioni-supabase', 'realtime.txt')
          expect(existsSync(p)).toBe(true)
          const righe = readFileSync(p, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
          expect(righe.length).toBeGreaterThan(0)
          for (const l of righe) expect(l).toMatch(/^[a-z_]+\.[a-z0-9_]+$/)
          expect(new Set(righe).size).toBe(righe.length)
      })
  })
  ```

- [ ] **Passo 2: rossa.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-ripristina-progetto.test.ts -t "Realtime"
  ```
  Atteso: `FAIL` su `existsSync`.

- [ ] **Passo 3: il file.** Rileggi in produzione (sola lettura, `execute_sql`):
  ```sql
  select schemaname || '.' || tablename as tabella from pg_publication_tables where pubname = 'supabase_realtime' order by 1;
  ```
  Crea `docs/impostazioni-supabase/realtime.txt` con queste quattro righe di testa e poi **una riga per ogni tabella
  restituita**, nello stesso ordine e senza altro (l'elenco deve coincidere con quello del Passo 0.4; se è cambiato, vale
  il nuovo e la differenza va nel PRD):
  ```text
  # Tabelle nella pubblicazione supabase_realtime della PRODUZIONE, rilette con
  #   select schemaname || '.' || tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1;
  # Il dump non le porta (le pubblicazioni non stanno in uno schema): dopo un ripristino le ripubblica la fase
  # «vault-bucket-realtime» di scripts/backup/ripristina-progetto.sh. Si rilegge dopo ogni migrazione che tocca la pubblicazione.
  ```
  Aggiungi in testa, come quinta riga, `# Letto il AAAA-MM-GG alle hh:mm UTC.` con la data e l'ora della lettura.

- [ ] **Passo 4: verde.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-ripristina-progetto.test.ts
  ```
  Atteso: `Tests  56 passed (56)`.

- [ ] **Passo 5: commit.**
  ```bash
  git add docs/impostazioni-supabase/realtime.txt __tests__/lib/backup-ripristina-progetto.test.ts
  git commit -m "Ripristino completo: elenco versionato delle tabelle del Realtime" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Compito 10: le variabili dell'anteprima, e il lock che le classifica tutte

**File:**
- Crea: `scripts/backup/variabili-anteprima.sh`
- Test: `__tests__/lib/backup-variabili-anteprima.test.ts`

- [ ] **Passo 1: la prova rossa.** Crea `__tests__/lib/backup-variabili-anteprima.test.ts`:
  ```ts
  // @vitest-environment node
  import { describe, it, expect } from 'vitest'
  import { spawnSync } from 'node:child_process'
  import { readdirSync, readFileSync } from 'node:fs'
  import { join } from 'node:path'

  /**
   * `scripts/backup/variabili-anteprima.sh` — i NOMI delle variabili dell'anteprima della prova di ripristino.
   *
   * L'anteprima gira sui dati VERI copiati nel progetto temporaneo. Deve avere quello che serve a partire e
   * NIENTE che parli con le famiglie (email, notifiche push), con lo Stato (SDI, SIDI) o con un fornitore a
   * pagamento. Il lock qui sotto obbliga a classificare ogni variabile nuova letta in `src/`.
   */

  const SCRIPT = join(process.cwd(), 'scripts', 'backup', 'variabili-anteprima.sh')

  function esegui(nomi: string[]) {
      const r = spawnSync('bash', [SCRIPT], {
          encoding: 'utf8',
          input: nomi.join('\n') + '\n',
          env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp' },
      })
      return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
  }

  function lista(nome: 'OBBLIGATORIE' | 'VIETATE'): string[] {
      const m = new RegExp(`^${nome}="([^"]+)"$`, 'm').exec(readFileSync(SCRIPT, 'utf8'))
      expect(m, `${nome} manca nello script`).not.toBeNull()
      return m![1].split(' ')
  }

  describe('variabili-anteprima.sh', () => {
      it('le obbligatorie ci sono e nessuna vietata → riuscita', () => {
          const r = esegui(lista('OBBLIGATORIE'))
          expect(r.status, r.err).toBe(0)
          expect(r.out).toMatch(/^RISULTATO obbligatorie=7\/7 vietate_presenti=0$/m)
      })

      it('ne manca una → fallita, e dice quale', () => {
          const r = esegui(lista('OBBLIGATORIE').filter((v) => v !== 'ALLOW_HEADER_IDENTITY'))
          expect(r.status).not.toBe(0)
          expect(r.err).toContain('ALLOW_HEADER_IDENTITY')
      })

      it('c\'è una chiave di un fornitore → fallita, e dice quale', () => {
          for (const v of ['RESEND_API_KEY', 'FCM_PRIVATE_KEY', 'VAPID_PRIVATE_KEY', 'ARUBA_PASSWORD', 'SIDI_PASSWORD']) {
              const r = esegui([...lista('OBBLIGATORIE'), v])
              expect(r.status, v).not.toBe(0)
              expect(r.err).toContain(v)
          }
      })

      it('regge l\'uscita di «vercel env ls» filtrata (righe vuote, \\r, intestazioni)', () => {
          const r = esegui(['', 'name', ...lista('OBBLIGATORIE').map((v) => `${v}\r`), 'Vercel CLI 59.1.4'])
          expect(r.status, r.err).toBe(0)
      })
  })

  describe('LOCK · ogni variabile d\'ambiente letta in src/ è classificata per l\'anteprima della prova di ripristino', () => {
      // Una variabile nuova di un fornitore che parla con le famiglie (un SMS, un'altra email) va fra le VIETATE
      // dello script prima della prossima prova; una che non parla con nessuno va fra le NEUTRE qui sotto.
      const NEUTRE = [
          'NODE_ENV', 'NEXT_RUNTIME', 'VITEST', 'VERCEL_ENV', 'VERCEL_REGION', 'VERCEL_GIT_COMMIT_SHA',
          'NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_CARICAMENTI_NATIVI', 'NEXT_PUBLIC_VERSIONE_BUNDLE',
          'PARENT_READS_USE_SESSION', 'KV_LOG_LEVEL',
      ]

      function sorgenti(dir: string): string[] {
          const t: string[] = []
          for (const e of readdirSync(dir, { withFileTypes: true })) {
              const p = join(dir, e.name)
              if (e.isDirectory()) t.push(...sorgenti(p))
              else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) t.push(p)
          }
          return t
      }

      it('nessuna variabile senza classe (le righe di commento non contano)', () => {
          const lette = new Set<string>()
          for (const f of sorgenti(join(process.cwd(), 'src'))) {
              const codice = readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
              for (const m of codice.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) lette.add(m[1])
          }
          expect(lette.size).toBeGreaterThan(20)
          const classificate = new Set([...lista('OBBLIGATORIE'), ...lista('VIETATE'), ...NEUTRE])
          expect([...lette].filter((v) => !classificate.has(v)).sort()).toEqual([])
      })

      it('nessuna variabile è insieme obbligatoria e vietata', () => {
          const vietate = new Set(lista('VIETATE'))
          expect(lista('OBBLIGATORIE').filter((v) => vietate.has(v))).toEqual([])
      })
  })
  ```

- [ ] **Passo 2: rossa.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-variabili-anteprima.test.ts
  ```
  Atteso: `FAIL`: `ENOENT` sullo script in `lista()`.

- [ ] **Passo 3: il codice.** Crea `scripts/backup/variabili-anteprima.sh`:
  ```bash
  #!/usr/bin/env bash
  # I NOMI delle variabili d'ambiente dell'anteprima del progetto Vercel della prova di ripristino.
  #
  # Seconda serie di robustezza, sessione 5. L'anteprima gira sui dati VERI copiati nel progetto temporaneo:
  # deve avere quello che serve a partire e NIENTE che parli con le famiglie (email, notifiche push), con lo
  # Stato (SDI, SIDI) o con un fornitore a pagamento. Legge i nomi sullo stdin (uno per riga, mai i valori):
  #   · esce con errore se manca una variabile OBBLIGATORIA;
  #   · esce con errore se c'è una variabile VIETATA.
  # ALLOW_HEADER_IDENTITY è obbligatoria perché il suo valore DEVE essere «false»: senza, l'app accetta
  # l'identità da un header (src/lib/auth/require-staff.ts:304).
  #
  # Uso (lo lancia il titolare, dalla cartella collegata al progetto Vercel della prova):
  #   vercel env ls preview 2>/dev/null | awk '$1 ~ /^[A-Z][A-Z0-9_]*$/ {print $1}' \
  #     | bash scripts/backup/variabili-anteprima.sh
  #
  # Compatibile con bash 3.2 (il Mac).

  set -euo pipefail

  OBBLIGATORIE="NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY ALLOW_HEADER_IDENTITY CRON_SECRET LOG_HASH_SALT OTP_TICKET_SECRET"
  VIETATE="RESEND_API_KEY OTP_FROM_EMAIL FCM_PROJECT_ID FCM_CLIENT_EMAIL FCM_PRIVATE_KEY VAPID_PRIVATE_KEY NEXT_PUBLIC_VAPID_PUBLIC_KEY VAPID_SUBJECT ARUBA_USERNAME ARUBA_PASSWORD SIDI_USERNAME SIDI_PASSWORD SIDI_CODICE_MECCANOGRAFICO ANTHROPIC_API_KEY"

  NOMI="$(tr -d '\r' | grep -E '^[A-Z][A-Z0-9_]*$' | LC_ALL=C sort -u || true)"
  MANCANTI=""
  PRESENTI_VIETATE=""
  for v in $OBBLIGATORIE; do
    if ! grep -qx "$v" <<< "$NOMI"; then MANCANTI="$MANCANTI $v"; fi
  done
  for v in $VIETATE; do
    if grep -qx "$v" <<< "$NOMI"; then PRESENTI_VIETATE="$PRESENTI_VIETATE $v"; fi
  done

  N_OBBL="$(echo $OBBLIGATORIE | wc -w | tr -d ' ')"
  N_MANC="$(echo $MANCANTI | wc -w | tr -d ' ')"
  N_VIET="$(echo $PRESENTI_VIETATE | wc -w | tr -d ' ')"
  echo "RISULTATO obbligatorie=$((N_OBBL - N_MANC))/$N_OBBL vietate_presenti=$N_VIET"
  if [ -n "$MANCANTI" ]; then echo "MANCANO:$MANCANTI" >&2; fi
  if [ -n "$PRESENTI_VIETATE" ]; then
    echo "VIETATE PRESENTI (toglile con «vercel env rm NOME preview»):$PRESENTI_VIETATE" >&2
  fi
  if [ -n "$MANCANTI" ] || [ -n "$PRESENTI_VIETATE" ]; then
    echo "ERRORE: l'anteprima non è pronta" >&2
    exit 1
  fi
  echo "OK: l'anteprima ha le $N_OBBL variabili che servono e nessuna chiave di un fornitore."
  ```

- [ ] **Passo 4: verde.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-variabili-anteprima.test.ts
  ```
  Atteso: `Tests  6 passed (6)`. Se il lock elenca una variabile nuova (arrivata con le sessioni già rilasciate), classificala:
  fra le `VIETATE` dello script se parla con un servizio esterno, fra le `NEUTRE` del test altrimenti, e scrivilo nel
  messaggio di commit.

- [ ] **Passo 5: commit.**
  ```bash
  git add scripts/backup/variabili-anteprima.sh __tests__/lib/backup-variabili-anteprima.test.ts
  git commit -m "Ripristino completo: l'anteprima della prova senza chiavi dei fornitori, e ogni variabile di src classificata" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Compito 11: il runbook

**File:**
- Modifica: `docs/runbook-ripristino.md` (sezione «Collegarsi a R2»; «Cosa NON c'è nel dump», compreso il rimando «(scenario E, passo 6)» della sessione 4; scenario E intero; lista di controllo; «Provare il ripristino della NOSTRA copia»)
- Modifica: `docs/cicd.md` (sezione «Cron di produzione»: il rimando «(passo 6)» della sessione 4)
- Test: `__tests__/lib/backup-ripristina-progetto.test.ts` (in fondo)

- [ ] **Passo 1: la prova rossa.** In fondo al file di prova aggiungi:
  ```ts
  describe('il runbook (scenario E) segue lo script', () => {
      const RUNBOOK = readFileSync(join(process.cwd(), 'docs', 'runbook-ripristino.md'), 'utf8')
      const E = RUNBOOK.slice(RUNBOOK.indexOf('## Scenario E'), RUNBOOK.indexOf('## Dopo QUALSIASI ripristino'))

      it('scrive il comando di ogni fase, nell\'ordine dello script', () => {
          const fasi = /^FASI="([^"]+)"$/m.exec(readFileSync(SCRIPT, 'utf8'))![1].split(' ')
          const posizioni = fasi.map((f) => E.indexOf(`bash scripts/backup/ripristina-progetto.sh ${f}`))
          expect(fasi.filter((_, i) => posizioni[i] < 0)).toEqual([])
          expect([...posizioni].sort((a, b) => a - b)).toEqual(posizioni)
      })

      it('non sincronizza i file e non tiene la chiave age nella cartella del repository', () => {
          expect(E).not.toMatch(/rclone sync/)
          expect(RUNBOOK).not.toContain('chiave-temporanea.txt')
      })

      it('dice di lavorare in bash, e mette i valori veri del Vault solo alla fine', () => {
          expect(RUNBOOK).toMatch(/in zsh[^\n]*read -rsp/)
          expect(E).toContain('vault.update_secret')
          expect(E.indexOf('vault.update_secret')).toBeGreaterThan(E.indexOf('ripristina-progetto.sh login'))
      })

      it('i rimandi al Vault scritti dalla sessione 4 puntano ai passi 9 e 12 dello scenario E riscritto', () => {
          const CICD = readFileSync(join(process.cwd(), 'docs', 'cicd.md'), 'utf8')
          expect(RUNBOOK).not.toContain('(scenario E, passo 6)')
          expect(RUNBOOK).toContain('(scenario E, passi 9 e 12)')
          expect(CICD).not.toContain('`docs/runbook-ripristino.md` (passo 6)')
          expect(CICD).toContain('`docs/runbook-ripristino.md` (passi 9 e 12)')
          expect(E).toMatch(/^9\. \*\*Fase 5 — Vault/m)
          expect(E).toMatch(/^12\. \*\*I valori veri del Vault\*\*/m)
      })
  })
  ```

- [ ] **Passo 2: rossa.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-ripristina-progetto.test.ts -t "runbook"
  ```
  Atteso: `FAIL` su tutte e quattro (lo scenario E non nomina lo script, contiene `rclone sync CRIPTO:corrente SB_NUOVO:`
  e `./chiave-temporanea.txt`; runbook e `docs/cicd.md` rimandano ancora al «passo 6»).

- [ ] **Passo 3: «Collegarsi a R2».** Sotto il titolo `## Collegarsi a R2 (sul Mac, con il token di LETTURA)`, la riga
  «Le credenziali si digitano a mano nel terminale: non si incollano in chat e non si salvano.» diventa:
  ```markdown
  Le credenziali si digitano a mano nel terminale: non si incollano in chat e non si salvano. Si lavora **in bash**
  (`bash`, poi Invio): in zsh, la shell predefinita del Mac, `read -rsp` non chiede niente e fallisce («no coprocess»).
  ```

- [ ] **Passo 4: «Cosa NON c'è nel dump».** In fondo all'elenco puntato che segue `**Cosa NON c'è nel dump**`
  (dopo la riga sulle chiavi API e le impostazioni di Auth, come l'ha lasciata la sessione 4) aggiungi:
  ```markdown
  - la **pubblicazione Realtime** (le pubblicazioni non stanno in uno schema): l'elenco delle tabelle è in
    `docs/impostazioni-supabase/realtime.txt`, e la ripubblica la fase 5 dello scenario E;
  - le **impostazioni di Auth e di Storage**: senza segreti in `docs/impostazioni-supabase/auth.json` e `storage.json`,
    con in `_omesse` i nomi dei valori da rimettere a mano.
  ```

- [ ] **Passo 5: lo scenario E.** Sostituisci tutto il blocco da `## Scenario E — «Il progetto Supabase è perso o
  bloccato» (il disastro)` fino alla riga prima di `## Dopo QUALSIASI ripristino — lista di controllo` con il testo qui
  sotto. Nel passo 4 del testo, al posto di `export ESTENSIONI_IN_PUBLIC=""` scrivi fra le virgolette i nomi misurati
  al Passo 0.4 (separati da uno spazio; vuoto se nessuno), e nella riga che lo segue la data della misura. La tabella
  del passo 12 è quella che la sessione 4 ha scritto nel suo passo 6: se nel runbook i valori sono diversi da questi,
  tieni quelli del runbook.
  ````markdown
  ## Scenario E — «Il progetto Supabase è perso o bloccato» (il disastro)

  > 🟠 **Ricetta della prova completa (seconda serie di robustezza, sessione 5).** Stato: **scritta e provata con i
  > programmi finti dei test; la prova da capo a fondo con i dati veri non è ancora stata fatta.** Fino ad allora vale
  > ciò che hanno provato le due prove a pezzi del 06/10 (`docs/prova-ripristino-2026-10.md`).

  Si rimette in piedi tutto partendo **solo** dalle copie di R2: database, file, app. Lo script
  `scripts/backup/ripristina-progetto.sh` fa **una fase alla volta**, nell'ordine qui sotto, e non passa alla fase dopo
  se quella prima non è riuscita (il registro sta in `$REGISTRO_FASI`). `bash scripts/backup/ripristina-progetto.sh
  --a-secco` stampa l'ordine senza toccare niente. Stampa solo numeri e nomi di tabelle e di bucket: mai righe, valori
  o nomi di file. Se una fase fallisce, `TIENI_ERRORI=<cartella>` conserva i messaggi completi: li legge solo il titolare.

  **Resta a mano:** creare il progetto; il limite dei file e le chiavi S3 dello Storage; le impostazioni di Auth
  (`docs/impostazioni-supabase/auth.json` più i valori elencati in `_omesse`); i valori veri del Vault (passo 12); le
  variabili di Vercel; riaccendere i cron (passo 15).

  1. **Respira.** Le copie sono al sicuro in R2; l'app è ferma ma i dati non sono persi.
  2. **Terminale in bash, nella cartella del repository**, con una cartella di lavoro **fuori** dal repository:
     ```bash
     bash
     LAVORO="$(mktemp -d)"; chmod 700 "$LAVORO"
     export REGISTRO_FASI="$LAVORO/registro.txt"
     export PG_BIN="$(brew --prefix postgresql@17)/bin"; export PATH="$PG_BIN:$PATH"
     ```
  3. **Collegati a R2 e allo specchio** (sezione «Collegarsi a R2»), scarica l'ultima copia e **verificala sul Mac**
     prima di toccare il progetto nuovo. La chiave privata `age` si legge dal supporto offline, senza copiarla:
     ```bash
     ULTIMO="$(rclone lsf R2:kidville-backup/db/giornalieri/ --files-only | grep '\.dump\.age$' | sort | tail -n 1)"
     STAMPA="${ULTIMO%.dump.age}"; echo "copia del $STAMPA"
     rclone copyto "R2:kidville-backup/db/giornalieri/$STAMPA.dump.age" "$LAVORO/dump.age"
     rclone copyto "R2:kidville-backup/db/giornalieri/$STAMPA.manifest.jsonl.age" "$LAVORO/manifest.age"
     export DUMP_FILE="$LAVORO/dump.age" MANIFEST_FILE="$LAVORO/manifest.age"
     read -rp "Percorso del file della chiave privata age sul supporto offline: " AGE_KEY_FILE; export AGE_KEY_FILE
     bash scripts/backup/ripristina-prova.sh
     ```
     Riuscito se l'ultima riga è `OK: il ripristino coincide con il manifest su N tabelle.`
  4. **Il progetto nuovo.** Pannello Supabase → New project: stessa organizzazione, regione **West EU (Ireland),
     `eu-west-1`**, password del database generata e salvata nel gestore delle password. Appena è pronto,
     **Database → Extensions**: `pg_cron` e `pg_net` devono essere **spenti** (su un progetto nuovo lo sono).
     ```bash
     read -rp "Riferimento del progetto nuovo (20 lettere, dall'indirizzo del pannello): " PROGETTO_TEMP_REF; export PROGETTO_TEMP_REF
     read -rsp "Stringa di connessione (Connect → Session pooler, con la password): " DB_TEMP_URL; echo; export DB_TEMP_URL
     export ESTENSIONI_IN_PUBLIC=""
     bash scripts/backup/ripristina-progetto.sh --a-secco
     ```
     `ESTENSIONI_IN_PUBLIC`: le estensioni che in produzione stanno nello schema `public` (oltre a `pg_net`), misurate
     il AAAA-MM-GG.
  5. **Fase 1 — pg_cron assente, per primo.**
     `bash scripts/backup/ripristina-progetto.sh cron-spento` → `RISULTATO fase=cron-spento pg_cron=assente
     pg_net=assente tabelle_public=0`. Se dice che sono installati: spegnili dal pannello del **nuovo** progetto
     (controlla il nome nel titolo della scheda **prima** di cliccare: spegnerli in produzione sarebbe un incidente) e
     rilancia. Lo script non li installa mai: da questo database non parte nessuna chiamata finché il passo 15 non lo
     decide.
  6. **Fase 2 — schema e dati.** `bash scripts/backup/ripristina-progetto.sh schema-e-dati` → `RISULTATO
     fase=schema-e-dati ruoli_creati=… estensioni=… errori_pg_restore=…`. Qualche errore di `pg_restore` è normale
     (schemi ed estensioni che il progetto ha già): decidono i conteggi della fase 4. Se la fase si interrompe a metà
     **non** si rilancia sullo stesso progetto: lo si cancella e se ne crea uno nuovo (la fase 1 rifiuta uno schema
     `public` già pieno).
  7. **Fase 3 — `auth` e `storage`.** `bash scripts/backup/ripristina-progetto.sh auth-e-storage` → `replica=si`.
     Carica i dati di `auth` e dei bucket con chiavi esterne e trigger fermi (`session_replication_role = replica`
     nella stessa sessione di `psql`), poi vincoli, indici, trigger e policy dell'app, poi trigger e policy di `auth` e
     `storage`. **Non** carica `storage.objects`: quelle righe nascono con i file al passo 10.
  8. **Fase 4 — conteggi.** `bash scripts/backup/ripristina-progetto.sh conteggi` → `diverse=0`. Si confrontano col
     manifest tutte le tabelle tranne quelle della piattaforma (`cron.*`, le migrazioni di `auth` e `storage`, gli
     oggetti dello Storage che conta il passo 10); le tabelle i cui dati il backup esclude devono essere vuote.
  9. **Fase 5 — Vault, bucket, Realtime.**
     ```bash
     export SEGRETO_CRON_PROVA="$(openssl rand -hex 32)"
     bash scripts/backup/ripristina-progetto.sh vault-bucket-realtime
     ```
     Crea i sei segreti dei cron con `vault.create_secret`, con indirizzi che finiscono in `.invalid` e quindi non
     portano da nessuna parte (i valori veri: passo 12); confronta i bucket con
     `__tests__/fixtures/bucket-storage-snapshot.json`; ripubblica nel Realtime le tabelle di
     `docs/impostazioni-supabase/realtime.txt`.
  10. **Lo Storage e i file.**
      - Il limite dei file del progetto, come in produzione, con un token personale di Supabase (Account → Access
        Tokens, scadenza più breve possibile) digitato a mano:
        ```bash
        read -rsp "Token personale Supabase: " SUPABASE_PAT; echo
        LIMITE="$(jq -r '.fileSizeLimit' docs/impostazioni-supabase/storage.json)"
        curl -sS -o /dev/null -w '%{http_code}\n' -X PATCH "https://api.supabase.com/v1/projects/$PROGETTO_TEMP_REF/config/storage" \
          -H "Authorization: Bearer $SUPABASE_PAT" -H "Content-Type: application/json" -d "{\"fileSizeLimit\": $LIMITE}"
        ```
        Riuscito se stampa `200`.
      - Le chiavi S3 del progetto nuovo (pannello → Storage → S3 Configuration → New access key) nel remote `TEMP:`:
        ```bash
        export RCLONE_CONFIG_TEMP_TYPE=s3 RCLONE_CONFIG_TEMP_PROVIDER=Other RCLONE_CONFIG_TEMP_REGION=eu-west-1 RCLONE_CONFIG_TEMP_FORCE_PATH_STYLE=true
        export RCLONE_CONFIG_TEMP_ENDPOINT="https://$PROGETTO_TEMP_REF.storage.supabase.co/storage/v1/s3"
        read -rsp "Access key ID (S3 del progetto nuovo): " RCLONE_CONFIG_TEMP_ACCESS_KEY_ID; echo; export RCLONE_CONFIG_TEMP_ACCESS_KEY_ID
        read -rsp "Secret (S3 del progetto nuovo): " RCLONE_CONFIG_TEMP_SECRET_ACCESS_KEY; echo; export RCLONE_CONFIG_TEMP_SECRET_ACCESS_KEY
        rclone lsf TEMP: --dirs-only | wc -l
        ```
        Riuscito se il numero è quello dei bucket della fotografia.
      - **Fase 6:** `bash scripts/backup/ripristina-progetto.sh file`. È la parte lunga. **Copia, non sincronizza**: un
        `sync` di rclone puntato per sbaglio sulla produzione cancellerebbe galleria e video, che nello specchio non ci
        sono. Confronta per **dimensione**: lo specchio è un `crypt` senza impronte e le sue date non coincidono mai al
        secondo (la trappola della `FINESTRA_DATE` di `specchio-storage.sh`); così, se la copia si interrompe, si
        rilancia la fase e riparte da dove era. Riuscito: `bucket_diversi=0`, poi la riga `RISULTATO provati=…
        diversi=0` dei campioni aperti.
  11. **L'app e il login.** In un disastro vero: in Vercel, progetto di **produzione**, cambia
      `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` con quelli del
      progetto nuovo e rilancia il deploy di produzione. Nella prova: un progetto Vercel a parte e solo un'anteprima
      (piano della sessione 5, parte B). Poi un login vero e la **fase 7:**
      `bash scripts/backup/ripristina-progetto.sh login` → `sessioni=1` o più.
  12. **I valori veri del Vault** (solo in un disastro vero, e solo adesso). La fase 5 ha messo indirizzi finti. Dal SQL
      editor del **nuovo** progetto, una riga per nome, con il valore scritto solo lì (mai in un file, in una chat o
      nel repository):
      ```sql
      select vault.update_secret(id, '<valore>') from vault.secrets where name = '<nome>';
      ```
      Se la fase 5 non è stata usata, il segreto si crea invece con `select vault.create_secret('<valore>', '<nome>');`.
      | Nome | Valore |
      |---|---|
      | `app.cron_secret` | lo stesso di `CRON_SECRET` su Vercel |
      | `app.push_dispatch_url` | `https://<dominio-prod>/api/push/dispatch` (molti cron ne usano solo l'origine) |
      | `app.notifiche_promemoria_url` | `https://<dominio-prod>/api/notifiche/promemoria` |
      | `app.retention_iscrizioni_url` | `https://<dominio-prod>/api/gdpr/retention-iscrizioni` |
      | `app.fattura_sync_url` | `https://<dominio-prod>/api/pagamenti/fattura/sync` |
      | `app.mensa_allergie_url` | `https://<dominio-prod>/api/mensa/allergie-check` |

      Controllo, senza leggere i valori: `select name from vault.secrets order by name;` → sei righe.
  13. **Fase 8 — i tempi.** `bash scripts/backup/ripristina-progetto.sh riepilogo` → una riga `TEMPO` per fase e
      `RISULTATO fase=riepilogo fasi_ok=7 secondi_fasi=… orologio=…`.
  14. **Riapplica gli oblii** avvenuti dopo la data della copia (scenario A, passo 5), prima di riaprire l'app.
  15. **Riaccendi i cron, per ultimi.** Database → Extensions: `pg_net`, poi `pg_cron`. **Passo mai provato:** i job
      non sono nel progetto nuovo (lo script non carica `cron.job`). Le definizioni stanno nelle migrazioni
      (`grep -l 'cron.schedule' supabase/migrations/*.sql`) e nei dati di `cron.job` del dump; si rimettono un job alla
      volta, con il titolare, controllando ogni volta che il segreto e l'indirizzo siano quelli veri.
  16. **Pulizia.** Password dei ruoli (anche `backup_lettura`) e segreto `BACKUP_DB_URL`; il token personale di
      Supabase si revoca; `rm -rf "$LAVORO"` e `unset DB_TEMP_URL SUPABASE_PAT SEGRETO_CRON_PROVA AGE_KEY_FILE`.

  ### Tempi misurati (prova completa)

  | Passo | Chi | Tempo |
  |---|---|---|
  | verifica della copia sul Mac (`ripristina-prova.sh`) | titolare | — |
  | creazione del progetto temporaneo | titolare | — |
  | fase 1 `cron-spento` | script | — |
  | fase 2 `schema-e-dati` | script | — |
  | fase 3 `auth-e-storage` | script | — |
  | fase 4 `conteggi` | script | — |
  | fase 5 `vault-bucket-realtime` | script | — |
  | fase 6 `file` (copia e campioni) | script | — |
  | anteprima su Vercel (variabili, build, deploy) | titolare | — |
  | fase 7 `login` | titolare + script | — |
  | **orologio dalla fase 1 alla fase 7** | | — |
  ````

- [ ] **Passo 6: i due rimandi della sessione 4 al vecchio passo 6.** Lo scenario E riscritto al Passo 5 ha
  rinumerato i passi: i segreti del Vault ora li crea la fase 5 dello script (passo **9**, con indirizzi finti) e i
  valori veri si mettono alla fine (passo **12**, con la tabella dei sei nomi). La sessione 4 aveva scritto due rimandi
  al suo «passo 6», che adesso porterebbero al passo «Fase 2 — schema e dati». Si correggono per contenuto:
  - in `docs/runbook-ripristino.md`, nell'elenco **Cosa NON c'è nel dump**, nella riga che comincia con
    `- i **segreti dei cron** (`, cerca
    ```markdown
    un nome alla volta (scenario E, passo 6).
    ```
    e sostituisci con
    ```markdown
    un nome alla volta (scenario E, passi 9 e 12).
    ```
  - in `docs/cicd.md`, nella sezione «Cron di produzione», cerca
    ```markdown
    L'elenco dei sei nomi e dei loro valori è nello scenario E di `docs/runbook-ripristino.md` (passo 6). Si controlla
    ```
    e sostituisci con
    ```markdown
    L'elenco dei sei nomi e dei loro valori è nello scenario E di `docs/runbook-ripristino.md` (passi 9 e 12). Si controlla
    ```
  Prima di sostituire, controlla che i numeri siano ancora quelli: nel runbook appena riscritto
  `grep -nE '^9\. \*\*Fase 5 — Vault|^12\. \*\*I valori veri del Vault' docs/runbook-ripristino.md` deve dare due righe.
  Se un testo da cercare non si trova identico (la sessione 4 l'ha scritto diverso), si cerca `passo 6` nei due file
  e si corregge ogni rimando allo scenario E con la stessa regola; non si toccano altri «passo 6».

- [ ] **Passo 7: la lista di controllo.** In `## Dopo QUALSIASI ripristino — lista di controllo`, dopo la prima casella
  (`pg_cron` spento) aggiungi:
  ```markdown
  - [ ] Tabelle del Realtime ripubblicate (`docs/impostazioni-supabase/realtime.txt`; la fase 5 lo controlla).
  - [ ] Impostazioni di Auth e limite dei file dello Storage rimessi (`docs/impostazioni-supabase/`), con i valori di `_omesse` scritti a mano.
  ```

- [ ] **Passo 8: la prova sul Mac.** In `## Provare il ripristino della NOSTRA copia (sul Mac)` sostituisci i tre
  blocchi di comandi (da ```` ```bash ```` con `# 1. scarica un dump` fino al blocco `# 3. pulizia` compreso) con:
  ````markdown
  ```bash
  # 0. in bash, con una cartella di lavoro FUORI dal repository
  bash
  LAVORO="$(mktemp -d)"; chmod 700 "$LAVORO"
  # 1. scarica un dump e il suo manifest (collegati a R2 come sopra)
  rclone copyto R2:kidville-backup/db/giornalieri/<AAAA-MM-GGThhmmZ>.dump.age "$LAVORO/dump.age"
  rclone copyto R2:kidville-backup/db/giornalieri/<AAAA-MM-GGThhmmZ>.manifest.jsonl.age "$LAVORO/manifest.age"
  ```
  ```bash
  # 2. la chiave privata si legge dal supporto offline, senza copiarla
  read -rp "Percorso del file della chiave privata age: " AGE_KEY_FILE
  DUMP_FILE="$LAVORO/dump.age" MANIFEST_FILE="$LAVORO/manifest.age" AGE_KEY_FILE="$AGE_KEY_FILE" \
    PG_BIN="$(brew --prefix postgresql@17)/bin" bash scripts/backup/ripristina-prova.sh
  ```
  ```bash
  # 3. pulizia
  rm -rf "$LAVORO"; unset AGE_KEY_FILE
  ```
  Mai una copia della chiave nella cartella del repository: un file come `chiave.txt` non è in `.gitignore`, e un
  `git add -A` lo pubblicherebbe in un repository pubblico.
  ````

- [ ] **Passo 9: verde, anche il lock della sessione 4.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-ripristina-progetto.test.ts __tests__/architecture/backup-notturno-sicuro.test.ts
  ```
  Atteso: `Test Files  2 passed (2)`. Il lock della sessione 4 vuole ogni nome di `cron_config` fra apici inversi e
  `vault.create_secret` nel runbook, e nessun `ALTER DATABASE … SET app.`: la tabella del passo 12 li soddisfa.

- [ ] **Passo 10: commit.**
  ```bash
  git add docs/runbook-ripristino.md docs/cicd.md __tests__/lib/backup-ripristina-progetto.test.ts
  git commit -m "Runbook: scenario E riscritto sulle otto fasi dello script, chiave age mai nel repository, bash al posto di zsh" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Compito 12: PRD, tabella di stato, gate, PR in bozza

**File:**
- Modifica: `PRD REGISTRO ELETTRONICO.md:1` (voce nuova in cima)
- Modifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` (riga 5 della tabella di stato, trovata con `grep`)

- [ ] **Passo 1: la voce del PRD.** In cima a `PRD REGISTRO ELETTRONICO.md`, prima della prima voce esistente:
  ```markdown
  ## 🛡️ Changelog — Robustezza 2, sessione 5: prova di ripristino completa (script e ricetta) — AAAA-MM-GG (branch `robustezza2/s05-prova-ripristino`)

  **Stato:** 🟡 script e ricetta pronti; **la prova con i dati veri è da fare** (mezza giornata del titolare, parte B del piano `docs/superpowers/plans/2026-10-20-robustezza2-s05-prova-ripristino.md`). Nessun codice in `src/`, nessuna migrazione, niente da applicare al merge.

  - **Prima** (Passo 0, con giorno e ora UTC di ogni lettura): domande d'iscrizione contate; ultima migrazione applicata; ultimo backup completo riuscito e specchio (`oggetti_specchio`, `byte_specchio`); estensioni nello schema `public`; nomi del Vault (solo i nomi); tabelle del Realtime; job di `pg_cron` attivi su totali.
  - **Cosa c'è.** `scripts/backup/ripristina-progetto.sh`: otto fasi (`cron-spento`, `schema-e-dati`, `auth-e-storage`, `conteggi`, `vault-bucket-realtime`, `file`, `login`, `riepilogo`), ognuna parte solo se la precedente è riuscita, registro con `esito` e tempi, `--a-secco`. `scripts/backup/impostazioni-senza-segreti.sh` (Auth e Storage in lista bianca). `scripts/backup/variabili-anteprima.sh` (l'anteprima senza chiavi dei fornitori, con un lock su ogni `process.env` di `src/`). `docs/impostazioni-supabase/realtime.txt`. Runbook, scenario E riscritto sulle otto fasi.
  - **Le scelte.** Uno script nuovo (`ripristina-prova.sh` resta); `rclone copy --size-only`, mai `sync`; `storage.objects` non si carica dal dump; `pg_cron` e `pg_net` non si installano; il Vault della prova ha indirizzi `.invalid`.
  - **Perché nessuna famiglia riceve niente dal secondo progetto.** `pg_cron` e `pg_net` assenti (controllati prima di ogni dato e dopo); indirizzi del Vault in `.invalid`; anteprima senza `RESEND_*`, `FCM_*`, `VAPID_*`, `ARUBA_*`, `SIDI_*`, `ANTHROPIC_*` e con `ALLOW_HEADER_IDENTITY=false`; nessun cron in `vercel.json`, e solo un'anteprima, mai un deploy di produzione; protezione di Vercel accesa; l'SMTP predefinito di Supabase scrive solo ai membri dell'organizzazione.
  - **Logging.** Nessun codice in `src/`. Gli script stampano solo righe `RISULTATO`, `BUCKET`, `TEMPO` con numeri e nomi di tabella e di bucket; il registro delle fasi scrive `esito=ok|errore`. Nessuna scrittura in `app_log`: la produzione non si tocca.
  ```
  Nella riga **Prima** scrivi i numeri veri del Passo 0, ciascuno con giorno e ora UTC; nella testata la data del giorno.

- [ ] **Passo 2: la tabella di stato, «in revisione».** §5 della specifica: nella propria PR la riga dice «in
  revisione» (sempre queste parole) e mai «in produzione». La riga si trova per contenuto, mai col numero:
  ```bash
  grep -n "^| 5 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
  ```
  Atteso: una sola riga, che comincia con `| 5 | Prova di ripristino completa`. In quella riga «Stato» → `in revisione`
  e «Piano» → `docs/superpowers/plans/2026-10-20-robustezza2-s05-prova-ripristino.md`; «PR» si riempie al Passo 5,
  appena GitHub dà il numero; le altre colonne restano come sono. Con le «Note» di oggi diventa:
  ```markdown
  | 5 | Prova di ripristino completa | D5, D8 (verifica) | 4 | in revisione | — | `docs/superpowers/plans/2026-10-20-robustezza2-s05-prova-ripristino.md` | T1, T11; mezza giornata del titolare |
  ```

- [ ] **Passo 3: i gate.**
  ```bash
  npx eslint . --max-warnings 0
  npx tsc --noEmit
  CI=1 npx vitest run
  NODE_OPTIONS=--max-old-space-size=8192 npm run build
  ```
  Atteso: ESLint `0 problems`; `tsc` senza uscita; Vitest tutti verdi (senza `CI=1` il lock `offline-html-nativo` è
  rosso in un worktree nuovo); build `✓ Compiled successfully`.

- [ ] **Passo 4: commit e push.**
  ```bash
  git add "PRD REGISTRO ELETTRONICO.md" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
  git commit -m "PRD e stato: sessione 5, script e ricetta della prova di ripristino completa" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push -u origin robustezza2/s05-prova-ripristino
  ```

- [ ] **Passo 5: PR in bozza.**
  ```bash
  gh pr create --draft --base main --head robustezza2/s05-prova-ripristino \
    --title "Robustezza 2, sessione 5: prova di ripristino completa" \
    --body "$(cat <<'EOF'
  Seconda serie di robustezza, sessione 5 (D5, D8). Piano: `docs/superpowers/plans/2026-10-20-robustezza2-s05-prova-ripristino.md`.

  - `scripts/backup/ripristina-progetto.sh`: la prova completa in otto fasi, da R2 a un progetto Supabase temporaneo.
  - `scripts/backup/impostazioni-senza-segreti.sh`, `scripts/backup/variabili-anteprima.sh`, `docs/impostazioni-supabase/realtime.txt`.
  - Runbook: scenario E riscritto sulle otto fasi.

  Nessun codice in `src/`, nessuna migrazione. **Resta in bozza** finché il titolare non ha fatto la mezza giornata (parte B del piano): i tempi misurati entrano in questa stessa PR.

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  )"
  ```
  Poi il numero della PR nella riga 5 (colonna «PR» → `#<numero>`, la riga trovata di nuovo con
  `grep -n "^| 5 |"`):
  ```bash
  gh pr view robustezza2/s05-prova-ripristino --json number --jq .number
  git add docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
  git commit -m "Robustezza 2, sessione 5: numero della PR nella riga di stato" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push
  ```
  Poi, fino a che **tutti** i job sono `pass`:
  ```bash
  gh pr checks <numero>
  ```
  Un E2E «cancelled» per la coda del gruppo `e2e-ci-db` si rilancia, non è rosso.

---

## Parte B — la mezza giornata del titolare

Tutto si fa **sul Mac del titolare**, nel worktree `/Users/lerri/kidville-web-s05`, in **un solo terminale in bash**
(più una seconda scheda per Vercel). Le chiavi (`age`, password e salt di `rclone crypt`), i token e le password non
passano mai in chat: in chat il titolare incolla solo le righe `RISULTATO`, `BUCKET`, `TEMPO` ed `ERRORE`. Il tempo di
ogni passo si scrive accanto alla casella.

**Se una fase fallisce:** non si prosegue. Il titolare incolla in chat le righe `RISULTATO` ed `ERRORE`; l'agente
legge. Se serve correggere lo script, la giornata finisce: si va al passo B20 (si cancella tutto) e si riprova un altro
giorno. Il progetto temporaneo **non resta mai acceso di notte**.

- [ ] **B0.1 — la data** (titolare, il giorno prima, 5 min). Una mattina libera; i due supporti offline a portata di
  mano. *Riuscito:* data scritta nella PR.
- [ ] **B0.2 — la linea** (titolare, 2 min). `networkQuality -s` → «Uplink capacity». Ore per la copia:
  `byte_specchio × 8 / (uplink in Mbit/s × 1.000.000) / 3600`. *Riuscito:* sotto le 3 ore, oppure giornata intera libera.
- [ ] **B0.3 — le impostazioni senza segreti** (titolare, 10 min):
  ```bash
  bash
  cd /Users/lerri/kidville-web-s05
  read -rsp "Token personale Supabase (Account → Access Tokens, scadenza più breve possibile): " SUPABASE_PAT; echo
  mkdir -p docs/impostazioni-supabase
  curl -sS "https://api.supabase.com/v1/projects/uimulkjyekgemjakmepp/config/auth" -H "Authorization: Bearer $SUPABASE_PAT" \
    | bash scripts/backup/impostazioni-senza-segreti.sh auth > docs/impostazioni-supabase/auth.json
  curl -sS "https://api.supabase.com/v1/projects/uimulkjyekgemjakmepp/config/storage" -H "Authorization: Bearer $SUPABASE_PAT" \
    | bash scripts/backup/impostazioni-senza-segreti.sh storage > docs/impostazioni-supabase/storage.json
  jq '._omesse | length' docs/impostazioni-supabase/auth.json
  jq '.fileSizeLimit' docs/impostazioni-supabase/storage.json
  unset SUPABASE_PAT; exit
  ```
  Sono due **letture** (`GET`) della produzione. *Riuscito:* un numero e un numero, nessun `ERRORE`.
- [ ] **B0.4 — controllo dei due file** (agente, 5 min). Li legge con `Read`: ogni stringa è sotto una chiave della lista
  bianca o in `_omesse`/`_tipo`/`_come_si_rigenera`; nessun valore che somigli a una chiave. *Riuscito:* lo scrive in
  chat. Non li committa ancora (compito 13).

Il giorno della prova:

- [ ] **B1 — il terminale** (titolare, 2 min):
  ```bash
  bash
  cd /Users/lerri/kidville-web-s05
  caffeinate -dims -w $$ &
  LAVORO="$(mktemp -d)"; chmod 700 "$LAVORO"
  export REGISTRO_FASI="$LAVORO/registro.txt"
  export PG_BIN="$(brew --prefix postgresql@17)/bin"; export PATH="$PG_BIN:$PATH"
  ls -a | grep -E '^(\.env|KIDVILLE-CHIAVI-BACKUP$)'; date -u +%FT%TZ
  ```
  *Riuscito:* `ls … | grep` non stampa niente (nessun `.env*` e nessuna cartella delle chiavi nel worktree:
  `vercel deploy` di B16 carica questa cartella); l'ora UTC è l'inizio della giornata.
- [ ] **B2 — R2 e specchio** (titolare, 5 min): i comandi della sezione «Collegarsi a R2» del runbook (token di
  **lettura**, password e salt di `rclone crypt` dal supporto offline). *Riuscito:*
  `rclone lsf CRIPTO:corrente --dirs-only | wc -l` stampa il numero di bucket dello specchio, e
  `rclone lsf R2:kidville-backup/db/giornalieri/ | tail -n 2` mostra i file della notte.
- [ ] **B3 — verifica della copia sul Mac** (titolare, 10 min): il passo 3 dello scenario E del runbook (download,
  `AGE_KEY_FILE` letto dal supporto, `ripristina-prova.sh`). *Riuscito:* `OK: il ripristino coincide con il manifest su
  N tabelle.`; il tempo è `secondi_totali` della riga `RISULTATO`.
- [ ] **B4 — il progetto temporaneo** (titolare, 5 min). Pannello Supabase → New project: nome
  `kidville-prova-ripristino-AAAAMMGG`, stessa organizzazione, regione `eu-west-1`, password generata nel gestore delle
  password. Quando è pronto: **Database → Extensions** → `pg_cron` e `pg_net` spenti; consigliato **Database →
  Network Restrictions** → solo l'indirizzo attuale. `date -u +%FT%TZ`. *Riuscito:* progetto «healthy», estensioni
  spente; ora scritta.
- [ ] **B5 — le variabili della prova** (titolare, 2 min): il blocco del passo 4 dello scenario E
  (`PROGETTO_TEMP_REF`, `DB_TEMP_URL` con `read -rsp`, `ESTENSIONI_IN_PUBLIC`, `--a-secco`). *Riuscito:* otto righe
  `PASSO`.
- [ ] **B6 — fase 1** (titolare, 1 min): `bash scripts/backup/ripristina-progetto.sh cron-spento`. *Riuscito:*
  `RISULTATO fase=cron-spento pg_cron=assente pg_net=assente tabelle_public=0`.
- [ ] **B7 — fase 2** (titolare, 5-15 min): `bash scripts/backup/ripristina-progetto.sh schema-e-dati`. *Riuscito:*
  riga `RISULTATO fase=schema-e-dati …` ed esito 0. Il numero di `errori_pg_restore` si annota (il 06/10 in locale
  erano 5).
- [ ] **B8 — fase 3** (titolare, 5-10 min): `bash scripts/backup/ripristina-progetto.sh auth-e-storage`. *Riuscito:*
  `replica=si`, esito 0. Con `replica=no` si prosegue: la fase 4 dirà se `auth.identities` è rimasta indietro.
- [ ] **B9 — fase 4** (titolare, 1 min): `bash scripts/backup/ripristina-progetto.sh conteggi`. *Riuscito:*
  `diverse=0`. Se no: ci si ferma (vedi sopra).
- [ ] **B10 — fase 5** (titolare, 2 min):
  ```bash
  export SEGRETO_CRON_PROVA="$(openssl rand -hex 32)"
  bash scripts/backup/ripristina-progetto.sh vault-bucket-realtime
  ```
  *Riuscito:* `chiavi_vault=6 bucket=21 bucket_diversi=0` e `realtime_tabelle` uguale alle righe di `realtime.txt`.
- [ ] **B11 — il limite dei file** (titolare, 3 min): il primo blocco del passo 10 dello scenario E (token personale,
  `PATCH /config/storage`). *Riuscito:* `200`.
- [ ] **B12 — le chiavi S3 del progetto temporaneo** (titolare, 3 min): il secondo blocco del passo 10. *Riuscito:* il
  numero di bucket della fotografia (21).
- [ ] **B13 — fase 6, i file** (titolare, 45-120 min): `bash scripts/backup/ripristina-progetto.sh file`. Mentre
  copia si fanno B14-B16 nella seconda scheda. Se la rete cade, si rilancia la stessa fase: riparte da dove era.
  *Riuscito:* `bucket_diversi=0`, `errori_copia=0`, poi `RISULTATO provati=… diversi=0 firma_errata=0 non_leggibili=0`.
- [ ] **B14 — il progetto Vercel della prova** (titolare, 10 min), nella **seconda scheda**:
  ```bash
  bash
  cd /Users/lerri/kidville-web-s05
  read -rp "Riferimento del progetto temporaneo: " PROGETTO_TEMP_REF
  vercel project add kidville-prova-ripristino
  vercel link --yes --project kidville-prova-ripristino
  vercel git disconnect --yes
  printf 'https://%s.supabase.co' "$PROGETTO_TEMP_REF" | vercel env add NEXT_PUBLIC_SUPABASE_URL preview
  # copia dal pannello del progetto TEMPORANEO (Project Settings → API Keys) la chiave pubblica, dello stesso tipo della produzione:
  pbpaste | vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY preview
  # copia la chiave segreta (service_role) dello stesso pannello:
  pbpaste | vercel env add SUPABASE_SERVICE_ROLE_KEY preview
  pbcopy < /dev/null
  printf 'false' | vercel env add ALLOW_HEADER_IDENTITY preview
  openssl rand -hex 32 | tr -d '\n' | vercel env add CRON_SECRET preview
  openssl rand -hex 32 | tr -d '\n' | vercel env add LOG_HASH_SALT preview
  openssl rand -hex 32 | tr -d '\n' | vercel env add OTP_TICKET_SECRET preview
  ```
  `vercel git disconnect` può rispondere che non c'è niente da scollegare: va bene. Se `vercel env add` chiede il ramo
  Git e non accetta il valore dalla pipe, si rilancia senza pipe e si incolla il valore quando lo chiede. Nessun valore
  della produzione: le chiavi sono quelle del progetto temporaneo, i segreti sono nuovi. *Riuscito:* sette «Added
  Environment Variable».
- [ ] **B15 — nessuna chiave dei fornitori** (titolare, 1 min):
  ```bash
  vercel env ls preview 2>/dev/null | awk '$1 ~ /^[A-Z][A-Z0-9_]*$/ {print $1}' | bash scripts/backup/variabili-anteprima.sh
  ```
  *Riuscito:* `RISULTATO obbligatorie=7/7 vietate_presenti=0`.
- [ ] **B16 — l'anteprima, protetta** (titolare, 5-10 min):
  ```bash
  URL_ANTEPRIMA="$(vercel deploy --yes 2>/dev/null)"; echo "$URL_ANTEPRIMA"
  curl -s -o /dev/null -w '%{http_code}\n' "$URL_ANTEPRIMA/"
  ```
  *Riuscito:* un indirizzo `https://kidville-prova-ripristino-….vercel.app` e `401` (protezione di Vercel). **Se il
  codice non è `401`:** `vercel remove "$URL_ANTEPRIMA" --yes` subito, poi Settings → Deployment Protection → Vercel
  Authentication acceso, e si rifà B16.
- [ ] **B17 — il login** (titolare, 5 min). Nel browser in cui è collegato a Vercel apre `URL_ANTEPRIMA`, entra con il
  **suo** account e la sua password come in produzione, apre una pagina con dati (per esempio l'elenco di una
  sezione). **Non salva, non invia, non firma, non paga niente.** *Riuscito:* la pagina mostra i dati; `date -u +%FT%TZ`.
- [ ] **B18 — fase 7** (titolare, 1 min), nel primo terminale: `bash scripts/backup/ripristina-progetto.sh login`.
  *Riuscito:* `sessioni=1` o più.
- [ ] **B19 — fase 8** (titolare, 1 min): `bash scripts/backup/ripristina-progetto.sh riepilogo`, poi incolla in chat
  **tutte** le righe `RISULTATO`, `BUCKET` e `TEMPO` della giornata, con i tempi di B3, B4 e B14-B16. *Riuscito:*
  `fasi_ok=7`.
- [ ] **B20 — si cancella tutto** (titolare, 10 min), **anche se la prova è fallita a metà**:
  ```bash
  vercel project rm kidville-prova-ripristino
  rm -rf .vercel
  ```
  Pannello Supabase → il progetto **`kidville-prova-ripristino-…`** (controlla il nome nel titolo della scheda) →
  Project Settings → General → Delete project. Poi, con il token personale ancora valido:
  ```bash
  curl -sS https://api.supabase.com/v1/projects -H "Authorization: Bearer $SUPABASE_PAT" | jq -r '.[].name'
  ```
  *Riuscito:* l'elenco non contiene `kidville-prova-ripristino-…`. Poi Account → Access Tokens → revoca del token, e:
  ```bash
  rm -rf "$LAVORO"
  unset DB_TEMP_URL SUPABASE_PAT SEGRETO_CRON_PROVA AGE_KEY_FILE RCLONE_CONFIG_CRIPTO_PASSWORD RCLONE_CONFIG_CRIPTO_PASSWORD2 \
    RCLONE_CONFIG_R2_ACCESS_KEY_ID RCLONE_CONFIG_R2_SECRET_ACCESS_KEY RCLONE_CONFIG_TEMP_ACCESS_KEY_ID RCLONE_CONFIG_TEMP_SECRET_ACCESS_KEY
  pbcopy < /dev/null
  exit
  ```
  Si chiude anche la seconda scheda e si espelle il supporto offline.
- [ ] **B21 — verifica** (agente, 5 min):
  ```bash
  vercel project ls 2>/dev/null | grep -c kidville-prova-ripristino
  ls -a /Users/lerri/kidville-web-s05 | grep -c '^\.vercel$'
  git -C /Users/lerri/kidville-web-s05 status --short
  ```
  *Riuscito:* `0`, `0`, e fra i file nuovi solo `docs/impostazioni-supabase/auth.json` e `storage.json`; il titolare ha
  confermato in chat la cancellazione del progetto Supabase e la revoca del token.

Tempo atteso della giornata, da B1 a B21: **2,5-3,5 ore**, di cui la copia dei file è la parte più lunga.

---

### Compito 13: i risultati nel runbook, nella specifica e nel PRD; il lock delle impostazioni

**File:**
- Crea (dal titolare al B0.3): `docs/impostazioni-supabase/auth.json`, `docs/impostazioni-supabase/storage.json`
- Modifica: `docs/runbook-ripristino.md` (riquadro e tabella dei tempi dello scenario E; riga 28 «14 GB»)
- Modifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` (riga 5, trovata con `grep`), `PRD REGISTRO ELETTRONICO.md:1`
- Test: `__tests__/lib/backup-impostazioni-senza-segreti.test.ts` (in fondo)

- [ ] **Passo 1: il lock delle impostazioni versionate.** In fondo a
  `__tests__/lib/backup-impostazioni-senza-segreti.test.ts` aggiungi (e aggiungi `existsSync, readFileSync` all'import
  da `node:fs`):
  ```ts
  describe('LOCK · le impostazioni versionate in docs/impostazioni-supabase/ non contengono segreti', () => {
      const AMMESSE = /^(site_url|uri_allow_list|password_required_characters|smtp_host|smtp_port|smtp_sender_name|security_captcha_provider|mailer_subjects_[a-z_]+|mailer_templates_[a-z_]+_content)$/

      /** I percorsi delle stringhe che NON stanno sotto una chiave ammessa (le chiavi «_…» di primo livello sono dello script). */
      function fuoriPosto(v: unknown, chiave = '', livello = 0): string[] {
          if (typeof v === 'string') return AMMESSE.test(chiave) ? [] : [chiave || '(elenco)']
          if (Array.isArray(v)) return v.flatMap((x) => fuoriPosto(x, '', livello + 1))
          if (v && typeof v === 'object') {
              return Object.entries(v)
                  .filter(([k]) => !(livello === 0 && k.startsWith('_')))
                  .flatMap(([k, x]) => fuoriPosto(x, k, livello + 1))
          }
          return []
      }

      it('PROVA GEMELLA: il controllo vede una stringa fuori posto', () => {
          expect(fuoriPosto({ site_url: 'x', smtp_pass: 'y', annidato: { token: 'z' } })).toEqual(['smtp_pass', 'token'])
      })

      for (const [tipo, sentinella] of [['auth', 'site_url'], ['storage', 'fileSizeLimit']] as const) {
          it(`${tipo}.json esiste, è del tipo giusto e ogni stringa sta sotto una chiave ammessa`, () => {
              const p = join(process.cwd(), 'docs', 'impostazioni-supabase', `${tipo}.json`)
              expect(existsSync(p)).toBe(true)
              const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
              expect(j._tipo).toBe(tipo)
              expect(sentinella in j).toBe(true)
              expect(Array.isArray(j._omesse)).toBe(true)
              expect(fuoriPosto(j)).toEqual([])
          })
      }
  })
  ```

- [ ] **Passo 2: verde subito, e la gemella dimostra che vede.**
  ```bash
  CI=1 npx vitest run __tests__/lib/backup-impostazioni-senza-segreti.test.ts
  ```
  Atteso: `Tests  8 passed (8)`. I due file ci sono già (B0.3). Se il lock è rosso, il file **non** si committa: si
  scrive in chat quale chiave è fuori posto e la si aggiunge a `_omesse` rigenerando il file al B0.3.

- [ ] **Passo 3: il runbook.** Nello scenario E:
  - il riquadro 🟠 diventa ✅:
    ```markdown
    > ✅ **Ricetta della prova completa, provata da capo a fondo il GG/MM/AAAA** (seconda serie di robustezza,
    > sessione 5): copia del AAAA-MM-GGThhmmZ, N tabelle uguali al manifest, M oggetti in K bucket, login
    > sull'anteprima riuscito. Orologio dalla fase 1 alla fase 7: H h MM min. Progetto temporaneo e progetto Vercel
    > cancellati il GG/MM/AAAA.
    ```
    con i numeri delle righe `RISULTATO` incollate al B19; se una parte è fallita o è rimasta parziale, il riquadro
    resta 🟠 e dice quale, con il motivo osservato.
  - nella tabella «Tempi misurati» ogni `—` diventa il tempo misurato (in minuti, dai `TEMPO` e dalle ore annotate);
  - nella riga 28 della tabella «Cosa c'è, dove, per quanto», «Specchio dei file (14 GB)» diventa il peso misurato
    (`byte_progetto` della fase 6, in GB, con la data).
  - Ogni passo in cui la giornata ha trovato qualcosa di diverso dal testo (un comando che ha chiesto altro, un errore
    atteso, un tempo) si corregge nel passo stesso.

- [ ] **Passo 4: la specifica.** Riga 5 della tabella di stato (`grep -n "^| 5 |"`): «Stato» **resta** `in revisione`
  (§5: «in produzione» lo scrive la sessione che apre dopo, dalla sezione «Per la sessione dopo» di questo piano);
  «Note» → `T1, T11; provata il GG/MM: orologio H h MM min, N tabelle, M oggetti; progetto temporaneo cancellato`
  (oppure `prova parziale il GG/MM: <cosa non è riuscito>`).

- [ ] **Passo 5: il PRD.** Nella voce del compito 12: «Stato» → `✅ prova completa riuscita il GG/MM` (oppure 🟠 con
  ciò che non è riuscito); aggiungi un punto **Dopo** con le righe `RISULTATO` della giornata (solo numeri) e i tempi,
  con giorno e ora UTC di inizio (`inizio_utc` del riepilogo).

- [ ] **Passo 6: gate, commit, PR pronta.**
  ```bash
  npx eslint . --max-warnings 0
  npx tsc --noEmit
  CI=1 npx vitest run
  git add docs/impostazioni-supabase/auth.json docs/impostazioni-supabase/storage.json docs/runbook-ripristino.md \
    docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md "PRD REGISTRO ELETTRONICO.md" \
    __tests__/lib/backup-impostazioni-senza-segreti.test.ts
  git commit -m "Prova di ripristino completa: tempi e numeri nel runbook, impostazioni di Auth e Storage versionate senza segreti" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push
  gh pr ready <numero>
  ```
  Atteso: gate verdi; poi `gh pr checks <numero>` finché tutti i job sono `pass`.

---

## Log

- Nessun codice in `src/`: nessun log applicativo nuovo, nessuna route, nessuna scrittura in `app_log`. La produzione
  non si tocca e il progetto temporaneo si cancella.
- Il «log» della prova sono le righe degli script, fatte apposta per finire in un PR pubblico: `RISULTATO fase=…`,
  `BUCKET nome=… specchio=… progetto=…`, `TEMPO fase=… secondi=…`. Solo numeri, nomi di tabella e di bucket.
- **`esito` per ogni fase**: il registro scrive `FASE nome=… esito=ok|errore secondi=… inizio=… fine=… inizio_utc=…`
  all'uscita, qualunque sia l'esito (trappola `EXIT`). Un errore non resta mai senza riga.
- **Configurazione mancante = errore**: ogni variabile che manca (`DB_TEMP_URL`, `SEGRETO_CRON_PROVA`, remote `TEMP:` e
  `CRIPTO:`, file del dump e della chiave) ferma lo script con `ERRORE:` e codice 1, mai con un avviso.
- **I messaggi dei programmi esterni** (`pg_restore`, `psql`, `rclone`, `age`) non si buttano: vanno nei file `.err`
  della cartella di lavoro e si contano; con `TIENI_ERRORI` si conservano per il titolare. Non vanno sul terminale
  perché citano valori di righe e nomi di file (dati di minori).

---

## PRD

Una voce di changelog in cima a `PRD REGISTRO ELETTRONICO.md`: scritta al compito 12 (stato 🟡, i numeri del Passo 0),
aggiornata al compito 13 (stato ✅ o 🟠, i numeri della giornata). Nessuna tabella di stato del PRD cambia: non ci sono
funzionalità nuove dell'app.

---

## Rilascio

1. Passo 0 superato → compiti 1-12 → gate verdi (ESLint, `tsc --noEmit`, Vitest con `CI=1`, build con
   `NODE_OPTIONS=--max-old-space-size=8192`) → PR in **bozza**, CI verde su **tutti** i job.
2. Parte B (mezza giornata del titolare) → compito 13 → PR pronta, CI verde su tutti i job.
3. **Merge a mano del titolare.** Niente da applicare al merge: nessuna migrazione.
4. Dopo il merge, in produzione, in sola lettura e con giorno e ora UTC:
   ```sql
   select max(version) from supabase_migrations.schema_migrations;
   SELECT count(*) FROM enrollment_submissions;
   ```
   Atteso: `max(version)` uguale al Passo 0.4 (nessuna migrazione è partita con questa PR). I due numeri, con giorno e
   ora UTC, vanno in un commento della PR mergiata, che la sessione dopo legge senza bisogno di un ramo di soli
   documenti:
   ```bash
   gh pr comment <numero> --body "Dopo il merge (sessione 5) · <AAAA-MM-GGThh:mm:ssZ> · max(version) = <V> (uguale al Passo 0.4: sì/no) · enrollment_submissions = <N> · deploy di main su Vercel: <riuscito|fallito>"
   ```
   La misura «dopo» vera è la giornata stessa: è già nel runbook, nelle «Note» della riga 5 e nel PRD, dentro questa PR.
5. Deploy di `main` riuscito su Vercel (cambiano solo script, prove e documenti). Nessun file si tocca dopo il merge:
   la riga 5 a «in produzione» e lo Stato del PRD li scrive la sessione che apre dopo, dalla sezione «Per la sessione
   dopo» di questo piano.
6. Pulizia dei rami (`AGENTS.md`, punto 3):
   ```bash
   cd /Users/lerri/kidville-web
   git worktree remove /Users/lerri/kidville-web-s05
   git branch -D robustezza2/s05-prova-ripristino
   git push origin --delete robustezza2/s05-prova-ripristino
   ```

---

## Ritorno indietro

- **Il codice:** una PR di revert. Gli script non girano da soli (nessun workflow li lancia) e non toccano la
  produzione: toglierli non cambia niente in esercizio.
- **I dati copiati:** il vero «ritorno indietro» di questa sessione è cancellare il secondo progetto. Se il passo B20
  non è stato fatto per intero, lo si fa per primo: progetto Supabase `kidville-prova-ripristino-…`, progetto Vercel
  `kidville-prova-ripristino`, cartella `$LAVORO`, token personale di Supabase.
- **Un'anteprima rimasta raggiungibile senza protezione:** `vercel remove <url> --yes` subito, poi il progetto Vercel.
- **R2 non si tocca:** il token è di sola lettura e lo script usa solo `copy` verso `TEMP:`, `size` e `lsf`.
- **Se per un errore si è scritto in produzione** (le guardie su riferimento, stringa di connessione ed endpoint sono
  fatte per impedirlo): ci si ferma e si segue lo scenario A0 o A del runbook.

---

## Per la sessione dopo

La esegue, nel suo **primo commit**, la sessione che si apre dopo questa, qualunque numero abbia (§5 della specifica,
«Apertura di una sessione: la chiusura della precedente»). Chi la esegue non ha letto questo piano: qui c'è tutto.
**Questa sessione non ha migrazioni**: niente fotografie da rigenerare per lei, niente voci da togliere da
`MIGRAZIONI_ATTESE_AL_MERGE` (`__tests__/architecture/soglia-fotografia.ts`) né da altre liste. Restano riga di stato,
PRD e misura.

**I dati di partenza** (sola lettura):
```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s05-" --json number,mergedAt,mergeCommit --jq '.[] | "\(.number) \(.mergedAt) \(.mergeCommit.oid)"'
gh pr view <numero> --repo erricoluigi17/kidville-web --comments
```
Atteso: una riga con numero della PR, data del merge e commit di `main`; fra i commenti quello che comincia con «Dopo il
merge (sessione 5)» (Rilascio, punto 4), con `max(version)` e il conteggio delle iscrizioni del giorno del merge.

- [ ] **1. Fotografie.** Nessuna. La fotografia dei bucket l'ha rigenerata questa sessione stessa (compito 1, Passo 5)
  ed è già in `main`; migrazioni nuove non ce ne sono.

- [ ] **2. Liste da svuotare.** Nessuna.

- [ ] **3. Riga di stato.** La riga si trova con
  `grep -n "^| 5 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`. «Stato» →
  `✅ in produzione il <gg/mm del merge> (main <primi 8 caratteri del commit>)`; «PR», «Piano» e «Note» restano come le
  ha scritte questa sessione (le «Note» hanno già l'esito della giornata: «provata il …» oppure «prova parziale il …»).

- [ ] **4. Misura «dopo».** La misura vera è la giornata del titolare, già scritta nel runbook, nelle «Note» e nel PRD
  da questa PR: non matura più niente. Si riportano nella voce del PRD i due numeri del commento «Dopo il merge
  (sessione 5)»: `max(version)` (atteso: uguale al Passo 0.4 di questa sessione, scritto nella riga **Prima** della sua
  voce del PRD) e il conteggio delle iscrizioni, con giorno e ora UTC. Se il commento manca, si rifanno le due letture
  oggi e si scrive che sono di oggi, non del giorno del merge:
  ```sql
  select max(version) from supabase_migrations.schema_migrations;
  SELECT count(*) FROM enrollment_submissions;
  ```
  E un controllo di sicurezza, in sola lettura, perché la prova ha messo dati veri in un secondo progetto:
  ```bash
  vercel project ls 2>/dev/null | grep -c kidville-prova-ripristino
  ```
  Atteso: `0`. Se è più di `0`, ci si ferma e lo si dice al titolare prima di ogni altra cosa: il progetto della prova
  va cancellato (piano di questa sessione, passo B20).

- [ ] **5. PRD.** Nella voce «Changelog — Robustezza 2, sessione 5: prova di ripristino completa (script e ricetta)» lo
  **Stato** riceve in coda `· ✅ in produzione il <gg/mm> (main <primi 8 caratteri del commit>)`, e un punto **Dopo il
  merge** con i due numeri del punto 4.

- [ ] **6. Cose condizionali.** Se le «Note» della riga 5 dicono «prova parziale», la riga va lo stesso a «in
  produzione» (script e ricetta sono in `main`) e le «Note» restano come sono: se e quando rifare la giornata lo decide
  il titolare, non la sessione che chiude.

---

## Autorevisione

**Copertura della specifica (§7, Sessione 5).**

| Richiesta | Dove |
|---|---|
| pg_cron spento **per primo** sul progetto temporaneo | fase `cron-spento` (compito 2) e ricontrollo nelle fasi 2 e 4; B4, B6 |
| schema e dati | fase `schema-e-dati` (compito 3); B7 |
| `auth` e `storage` | fase `auth-e-storage` (compito 3); B8 |
| Vault e bucket con la ricetta della sessione 4 | fase `vault-bucket-realtime` (compito 5, `vault.create_secret`, fotografia dei bucket); B10 |
| i file con `rclone copy --size-only`, mai `sync`; le righe di `storage.objects` non dal dump | fase `file` (compito 6, scelte 2 e 3); B11-B13 |
| deploy di anteprima puntato al progetto temporaneo | B14-B17, controllato da `variabili-anteprima.sh` (compito 10) |
| impostazioni di Auth e Storage senza segreti in `docs/` | compito 8, B0.3, lock al compito 13 |
| il runbook riceve i tempi misurati | compito 11 (tabella) e compito 13 (valori) |
| il runbook perde tre errori: `read -rsp` in zsh, la chiave in un file del repository, «specchio dei file 14 GB» | compito 11, Passi 3 e 8; compito 13, Passo 3 |
| la pubblicazione Realtime si ripubblica da un elenco versionato | compito 9 (`realtime.txt`), fase 5 (compito 5); scelta 5 |
| rimettere i job di pg_cron: fuori dalla prova, nel runbook come passo mai provato | compito 11, scenario E passo 15; scelta 9 |
| `ripristina-prova.sh` resta com'è (scenario A, prova trimestrale) | scelta 1; compito 11, scenario E passo 3 |
| prova: conteggi uguali al manifest | fase `conteggi` (compito 4) |
| prova: stesso numero di oggetti per bucket | fase `file`, righe `BUCKET` (compito 6) |
| prova: un login di prova sull'anteprima | B17 e fase `login` (compito 7) |
| prova: il tempo di ripristino misurato | registro, fase `riepilogo` (compito 7), B19, compito 13 |
| T1: niente capitolo sul ripristino al minuto | scelta 10; nessun compito |
| T11: mezza giornata del titolare, chiavi solo sue | parte B; le chiavi si leggono dal supporto, mai copiate né in chat |
| rischio: cron che chiamano la produzione; dati veri in un secondo progetto | scelte 4 e 8; B20 cancella tutto, anche a prova fallita |
| §5: prerequisiti (PR della sessione 4 mergiata, sua migrazione applicata, prerequisito concreto del suo «Per la sessione dopo»), nessuna PR `robustezza2/` aperta | compito 1, Passo 1 |
| §5: chiusura della sessione rilasciata per ultima, primo commit | compito 1, Passo 4 |
| §5: riga «in revisione» nella propria PR; «in produzione» la scrive la sessione dopo | compito 12, Passi 2 e 5; compito 13, Passo 4; «Per la sessione dopo» |
| i rimandi della sessione 4 al vecchio passo 6 dello scenario E | compito 11, Passo 6 |
| §5: gate, merge a mano, PRD, conteggio delle iscrizioni | compiti 12-13, Rilascio, Passo 0.4 |

**Segnaposto.** Nessun passo rimanda a dopo: i valori che il piano non può conoscere (i numeri del Passo 0, l'elenco del
Realtime, i tempi della giornata) dicono da quale comando arrivano e dove si scrivono.

**Nomi coerenti fra i compiti.** Fasi: `cron-spento`, `schema-e-dati`, `auth-e-storage`, `conteggi`,
`vault-bucket-realtime`, `file`, `login`, `riepilogo` (costante `FASI`, `--a-secco`, prove, runbook, parte B). Funzioni:
`fase_cron_spento`, `fase_schema_e_dati`, `fase_auth_e_storage`, `fase_conteggi`, `fase_vault_bucket_realtime`,
`fase_file`, `fase_login`, `fase_riepilogo`; aiuti `richiedi_db`, `richiedi_dump`, `leggi_manifest`, `controlla_age`,
`ripristina`, `ripristina_in_replica`, `controlla_cron_assente`, `controlla_public_vuoto`, `lista_sql`, `conta`, `campo`.
Variabili: `PROGETTO_TEMP_REF`, `DB_TEMP_URL`, `REGISTRO_FASI`, `SEGRETO_CRON_PROVA`, `ESTENSIONI_IN_PUBLIC`,
`ESCLUDI_BUCKET`, `TIENI_ERRORI`, `FOTOGRAFIA_BUCKET`, `ELENCO_REALTIME`, `APRI_CAMPIONI`, `PROSEGUI_COMUNQUE`. Variabili
dei finti: `FAKE_CRON`, `FAKE_TABELLE_PUBLIC`, `FAKE_REPLICA`, `FAKE_CONTEGGI`, `FAKE_VAULT`, `FAKE_VAULT_ERRORE`,
`FAKE_BUCKET`, `FAKE_REALTIME`, `FAKE_LOGIN`, `FAKE_TOC`, `FAKE_AGE_ESCE`, `FAKE_COPIA_ESCE`, `FAKE_CAMPIONI_ESCE`,
`FAKE_CARTELLE`, `FAKE_CONTI`.

**Conteggio delle prove di `backup-ripristina-progetto.test.ts`.** Compito 2: 13 · compito 3: +13 = 26 · compito 4: +7
= 33 · compito 5: +8 = 41 · compito 6: +8 = 49 · compito 7: +6 = 55 · compito 9: +1 = 56 · compito 11: +4 = 60.
