# Sessione 13 — Bordo pubblico: cache, firewall, errori, login, build — piano di implementazione

> **Per chi esegue:** sotto-skill obbligatoria `superpowers:subagent-driven-development` (consigliata) oppure `superpowers:executing-plans`; i passi usano le caselle (`- [ ]`).

**Obiettivo:** le porte anonime dell'app reggono il traffico senza raccontare i loro guasti a chi bussa, e la cache
della CDN che il codice già chiede funziona davvero.

**Architettura:** due funzioni piccole decidono cosa vede il chiamante quando qualcosa si rompe:
`rispostaGuastoGiaRegistrato` (in `src/lib/db/guasto.ts`, accanto a `rispostaGuastoDb`) e `rispostaErroreInterno`
(nuova, `src/lib/api/errore-interno.ts`). Rispondono solo con un `codice` tradotto; l'errore intero va nel log. Un
lock nuovo legge l'elenco delle porte anonime da `gate-coverage.test.ts` e vieta `.message` nelle loro risposte. La
cache passa tutta da `intestazioniCachePubblica` (`src/lib/security/cache-pubblica.ts`): anche i comuni ci passano.
La diagnosi del MISS si fa su un'anteprima, cambiando solo quella funzione. Il firewall di Vercel si configura dopo il
merge, in modalità «log» per 7 giorni. I login falliti si contano dai log di Supabase con una ricetta scritta in
`docs/cicd.md`. La build locale prende lo stesso heap della CI.

**Tecnologie:**
- Next.js 16 (route handler, `NextResponse`), Vitest 4, TypeScript stretto.
- Supabase: PostgREST, Storage, log via `query_logs`.
- Vercel: CDN e firewall. La CLI è fissata a `npx vercel@64.7.0`: quella installata è la 59.1.4 e non ha
  `firewall traffic`.
- GitHub CLI (`gh`).

**Specifica:** `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, §7, «Sessione 13 — Bordo
pubblico» (righe 731-771 della specifica aggiornata il 20/10: si cerca il titolo, non il numero). Valgono anche:
- §5, regole comuni (righe 133-197) e «Misure di controllo» (righe 199-208);
- §6, «Apertura e chiusura» e la sezione finale «Per la sessione dopo»;
- §8, «Cosa NON fare», punti 12, 13 e 17.

---

## Scelte e scostamenti dalla specifica

Ogni numero qui sotto è stato misurato il 20/10 sul codice di `main` a `4c6df438`, in sola lettura.

1. **Le route pubbliche che mandano l'errore al chiamante sono 4, con 9 risposte. La specifica dice «3».**
   - Il rapporto (`docs/analisi-robustezza-2026-10-20.md`, S10) cercava una riga alla volta. Elenca 4 punti
     (`iscrizione/route.ts:390,399`, `iscrizione/sedi/route.ts:55`, `forms/submit/route.ts:116`) in 3 file e li
     conta «3».
   - Il lettore del lock (Compito 4) segue le risposte su più righe e le variabili (`const msg = … err.message`).
     Trova:

     | Handler | Risposte | Righe |
     |---|---|---|
     | `iscrizione:POST` | 3 | 390, 399, 432 |
     | `iscrizione/sedi:GET` | 1 | 55 |
     | `forms/submit:POST` | 4 | 83, 116, 158, 203 |
     | `public/forms/[token]/submit:POST` | 1 | 171 |

   - Le porte anonime sono le 23 voci di `PUBBLICHE` in `__tests__/architecture/gate-coverage.test.ts:349-615`.
     Le altre 19 sono già pulite.
2. **Le «~181 righe» delle altre route sono di più.**
   - Con `grep -rnE "json\(.*\.message" src` sono 219 righe in 108 file. Il rapporto ne contava 184 in 101.
   - Con il lettore del lock, su tutto `src/app/api`: 328 risposte in 214 handler di 142 file. Di queste, 9 sono
     sulle porte anonime e 319 sulle route autenticate.
   - Questa sessione ne toglie 4 delle 319, perché tocca quei file per altro: `notes` (2), `parent/competenze`
     (1), `admin/competenze/download` (1). Le altre si sistemano quando una sessione tocca il loro file.
3. **«Le 8 letture dello Storage senza `error»` sono 2 URL firmati e 6 `listBuckets()`.**
   - Il rapporto le chiama «8 letture di URL firmate». Una regex vera, aggiunta al lock
     `errori-postgrest-guardati` (Compito 9), trova esattamente 8 righe:
     - `createSignedUrl` in `parent/competenze/route.ts:47` e `admin/competenze/download/route.ts:45`;
     - `listBuckets()` in `primaria/allegati/route.ts:187`, `primaria/fascicolo/route.ts:176`,
       `lib/cassa/store.ts:22`, `lib/competenze/certificato-store.ts:239`, `lib/primaria/pagella-store.ts:198`,
       `lib/protocolli/store.ts:104`.
   - Il risultato di `createBucket`/`updateBucket` resta ignorato. Il lock non lo vede (non è una destrutturazione)
     e lo si lascia a una sessione futura: lo si scrive nel PRD.
4. **Anche gli altri errori senza codice dei file toccati.** Toccando una route per il `message`, si sistemano anche
   le sue risposte d'errore senza codice: `'Invio fallito'`, `'Errore interno'`, `'URL non disponibile'`,
   `'Internal Server Error'`. L'allowlist `errori-senza-codice` scende di 19 occorrenze e di 2 file.
   - Il 20/10 i tetti erano 1361 occorrenze in 270 file. La sessione 2 viene prima e li porta a **1350 e 264**
     (escono le sei route di `exec_sql`). Questa sessione parte da lì: 1350 → **1331** e 264 → **262**. Il
     Compito 10 rilegge comunque i valori veri prima di scrivere: se un'altra sessione li ha cambiati ancora, si
     parte da quelli e si tolgono gli stessi 19 e 2.
   - La voce dell'invio pubblico era già larga: dichiarava 8 risposte, se ne misurano 7.
5. **`/api/anagrafiche/comuni` passa da `intestazioniCachePubblica`.** Oggi ha le stesse due intestazioni scritte a
   mano (`comuni/route.ts:211-212`, `466-469`). Così una sola diagnosi e una sola correzione valgono per tutte e tre
   le letture pubbliche con cache.
6. **Firewall:**
   - una quarta regola su `/api/public`, sempre in «log». La specifica nomina tre prefissi, ma le porte anonime
     `/api/public/forms/[token]/submit|upload` e `/api/public/cancellazione-account` restavano scoperte;
   - l'eccezione per il Worker `monitor-esterno` copre anche il campanello (`scripts/campanello/lettura.mjs:10`,
     user agent `kidville-campanello`), che legge le stesse due porte.
7. **Il registro del traffico del firewall, sul piano Pro, si legge sulle ultime 24 h.** Per questo i «7 giorni in
   log» sono 7 letture giornaliere, scritte in una issue. Non è una lettura sola alla fine. Le letture maturano dopo
   il merge: la tabella dei 7 giorni e la decisione sul blocco stanno nella sezione finale «Per la sessione dopo».
8. **«In produzione, con una route sola».** Se l'anteprima non si può misurare, la diagnosi va in produzione solo su
   `/api/iscrizione/sedi`, con 2 richieste. Il 20/10 la sfida è scattata alla 24ª richiesta di fila di un client di
   prova. In produzione si misura solo la prova 1, quella che entra con la PR della sessione: dopo il merge questa
   sessione non apre altri rami né altre PR (§5, «Una sessione alla volta»; le sessioni dopo cercano le PR con
   `head:robustezza2/`). Se la prova 1 non basta, S8 resta aperto e la prova successiva la decide il titolare
   (Compito 13, ramo «R»).
9. **Fuori da questa sessione:**
   - `parent/primaria/note:POST` (porta anonima già pulita);
   - Turnstile (§8, punto 17);
   - lo spostamento del login sul server (§8, punto 12).

---

## Mappa dei file

| File | Ruolo |
|---|---|
| `src/lib/db/guasto.ts` | **Modifica.** `rispostaGuastoGiaRegistrato(tipo)`: la risposta di `rispostaGuastoDb` senza la riga di log, quando l'ha già scritta chi chiama. |
| `src/lib/api/errore-interno.ts` | **Crea.** `rispostaErroreInterno(operazione, err)` e `rispostaErroreInternoGiaRegistrato()`: 500 con il solo `codice: 'ERRORE_INTERNO'`. |
| `src/lib/ui/esito-fetch.ts` | **Modifica**, subito dopo `    SCRITTURA_FALLITA: 'erroreScritturaFallita',` e prima di `} as const;` (riga 3380 il 20/10; la sessione 1 aggiunge un codice più in alto e la sposta). `ERRORE_INTERNO: 'erroreInterno'` in `CODICI_ERRORE`. |
| `messages/it/shared.json`, `messages/en/shared.json` | **Modifica**, in coda: la chiave `erroreInterno` dopo l'ultima chiave che c'è davvero. Il 20/10 era `erroreScritturaFallita` (riga 754); la sessione 1 aggiunge dopo di lei `erroreDomandaGiaEsaminata`. |
| `__tests__/architecture/porte-anonime-senza-errori-interni.test.ts` | **Crea.** Il lock: nessuna porta anonima manda `.message`. |
| `src/app/api/iscrizione/route.ts` | **Modifica.** Righe 10, 389-391, 399, 430-433. |
| `src/app/api/iscrizione/sedi/route.ts` | **Modifica.** Righe 8 e 55. |
| `src/app/api/forms/submit/route.ts` | **Modifica.** Righe 15, 83, 116, 158-161, 202-206. |
| `src/app/api/public/forms/[token]/submit/route.ts` | **Modifica.** Riga 12, il 500 della lettura del modello, il 500 dell'invio, il `catch`. |
| `src/app/api/notes/route.ts` | **Modifica.** Il `catch` muto della notifica (riga 155) e i quattro 500. |
| `src/app/api/parent/competenze/route.ts` | **Modifica.** L'URL firmato con `error` (riga 47) e il `catch`. |
| `src/app/api/admin/competenze/download/route.ts` | **Modifica.** L'URL firmato con `error` (righe 45-46) e il `catch`. |
| `src/app/api/primaria/allegati/route.ts`, `src/app/api/primaria/fascicolo/route.ts`, `src/lib/cassa/store.ts`, `src/lib/competenze/certificato-store.ts`, `src/lib/primaria/pagella-store.ts`, `src/lib/protocolli/store.ts` | **Modifica.** `listBuckets()` con `error`. In `protocolli/store.ts`, anche il `catch` muto. Prima di questa sessione la 3 cambia `pathDefinitivi` in `protocolli/store.ts` (sopra `ensureBucket`) e la 10 cambia `persistPagella` in `pagella-store.ts`: le righe si spostano, e le sostituzioni si fanno sul testo citato nel Compito 9. |
| `__tests__/architecture/errori-postgrest-guardati.test.ts` | **Modifica.** Una quinta forma: lo Storage senza `error`. |
| `docs/superpowers/errori-senza-codice-allowlist.json`, `__tests__/architecture/errori-con-codice.test.ts` | **Modifica.** Tetti 1350 → 1331 e 264 → 262: si parte dai valori che lascia la sessione 2 (il 20/10 erano 1361 e 270), riletti dal file al Compito 10. |
| `__tests__/architecture/catch-muti-allowlist.test.ts` | **Modifica.** Tetti dei `catch` con soli commenti 49 → 47 e 37 → 35. Nessuna sessione prima della 13 cambia questi tetti (controllato sui 12 piani il 20/10); il Compito 10 li rilegge comunque dal file. |
| `package.json` | **Modifica** (riga 7). `build` con `--max-old-space-size=6144`, come in CI. |
| `__tests__/architecture/build-heap-come-in-ci.test.ts` | **Crea.** Lock: lo script `build` porta lo stesso heap di `.github/workflows/ci.yml:22`. |
| `src/lib/security/cache-pubblica.ts` | **Modifica.** La correzione della cache, decisa dall'anteprima (Compiti 13-14). |
| `src/app/api/anagrafiche/comuni/route.ts` | **Modifica.** Righe 6, 204-212, 245, 255, 462-471: le intestazioni passano da `intestazioniCachePubblica`. |
| `__tests__/lib/cache-pubblica.test.ts` | **Crea.** Le intestazioni, una per strada. |
| `__tests__/lib/errore-interno.test.ts`, `__tests__/lib/db-guasto-gia-registrato.test.ts` | **Crea.** |
| `__tests__/api/iscrizione-errori-con-codice.test.ts`, `__tests__/api/notes-errori-e-notifica.test.ts`, `__tests__/api/competenze-url-firmato-guasto.test.ts`, `__tests__/lib/storage-elenco-bucket-guasto.test.ts` | **Crea.** |
| `__tests__/api/iscrizione-sedi.test.ts`, `__tests__/api/forms-submit.test.ts`, `__tests__/api/public-forms-submit.test.ts` | **Modifica.** I 500 con il codice. |
| `__tests__/api/iscrizione-model-anonima.test.ts`, `__tests__/api/anagrafiche-comuni.test.ts` | **Modifica solo nel ramo B** (Compito 14). |
| `docs/cicd.md` | **Modifica.** Nuova sezione «Bordo pubblico», prima di `## Cron di produzione (pg_cron, dentro Supabase)`. Le sessioni 4 e 5 cambiano lo stesso file prima di questa: la 4 riscrive «Come si lancia», «Monitor esterno», la tabella dei comandi, la riga `[backup-vecchio]` e il corpo di «Cron di produzione» (non il titolo); la 5 cambia lì dentro il rimando «(passo 6)» in «(passi 9 e 12)». Ci si ancora al titolo, mai al numero di riga, e non si tocca nessuna di quelle parti. |
| `PRD REGISTRO ELETTRONICO.md` | **Modifica.** Voce di changelog in cima. |
| `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` | **Modifica nella propria PR** (Rilascio, passo 4): la riga della sessione 13 nella tabella di stato, trovata con `grep -n "^| 13 |"`, va a «in revisione» col numero della PR. «In produzione» e le misure le scrive la sessione dopo (sezione finale «Per la sessione dopo»). |
| Fotografie e file che nomina il piano della sessione rilasciata per ultima | **Modifica solo nel primo commit** (Compito 1, Passo 4): la chiusura della sessione precedente. |
| Firewall di Vercel (fuori dal repo) | 5 regole, dopo il merge, con l'approvazione esplicita del titolare. |

---

## Passo 0 — misura prima

Tutto in sola lettura. Sul database di produzione si fanno solo `SELECT`. Ogni numero si scrive con giorno, ora UTC e
finestra, nel corpo della PR e poi nel PRD. Mai un indirizzo IP, mai un JA4, mai un nome: solo conteggi, codici,
percorsi e famiglie di user agent.

- [ ] **0.0 La CLI che serve.** La CLI del progetto è collegata in `/Users/lerri/kidville-web/.vercel/project.json`
  (`kidville-web`). Il worktree della sessione non ha `.vercel/`: ogni comando di Vercel porta
  `--cwd /Users/lerri/kidville-web`.
  ```bash
  npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall --help
  npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall traffic --help
  npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall rules add --help
  ```
  Atteso: i sottocomandi `rules`, `traffic`, `diff`, `publish` e `discard`. Se un'opzione usata in questo piano non
  compare nell'aiuto, si usa quella equivalente che l'aiuto mostra, e la differenza si scrive nel corpo della PR.

- [ ] **0.1 Le domande d'iscrizione, contate.** Non servono a una migrazione (non ce n'è), ma vanno nel PRD:
  ```sql
  SELECT count(*) FROM enrollment_submissions;
  ```
  Si annotano il numero e l'ora UTC. Il 20/10 alle 12:32:54 UTC erano 733.

- [ ] **0.2 La cache, prima.** Due richieste di fila in produzione, a due secondi l'una dall'altra, mai di più:
  ```bash
  for i in 1 2; do
    curl -s -o /dev/null -A 'kidville-misura-s13' -D - https://app.kidville.it/api/iscrizione/sedi \
      | grep -iE '^(HTTP/|x-vercel-cache|cache-control|vary|age):'
    sleep 2
  done
  ```
  - Atteso, come il 20/10 alle 13:19: due volte `x-vercel-cache: MISS`, con `cache-control: public, max-age=600` e
    `vary: Cookie`.
  - `s-maxage` non compare: lo consuma la CDN. Che manchi non prova un difetto. La prova è `x-vercel-cache`.

- [ ] **0.3 Le sfide `403` del giorno.**
  ```bash
  npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall traffic list --since 24h --action challenge --dimension path
  npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall traffic list --since 24h --action challenge --dimension user-agent
  ```
  Si annotano:
  - il totale delle sfide nelle 24 h;
  - le 5 voci più frequenti per percorso;
  - le 5 famiglie di user agent più frequenti (per esempio «Safari iOS», «WebView Android», «curl»), mai la
    stringa intera.

- [ ] **0.4 Gli errori di rete dei client, per giorno.** È la query 3 del 05/10 (`docs/roadmap-robustezza.md:488-529`)
  con «Load failed» accanto («Load failed» è il nome che Safari dà allo stesso errore):
  ```sql
  SELECT giorno, extract(isodow FROM giorno) AS giorno_settimana,
    sum(occorrenze) FILTER (WHERE messaggio LIKE '%Failed to fetch%') AS failed_fetch,
    sum(occorrenze) FILTER (WHERE messaggio LIKE '%Load failed%') AS load_failed,
    sum(occorrenze) FILTER (WHERE messaggio LIKE '%SupabaseTimeoutError%') AS timeout_supabase
  FROM app_log WHERE giorno >= current_date - 14 GROUP BY giorno ORDER BY giorno;
  ```
  Si annotano i giorni feriali (`giorno_settimana` da 1 a 5). Il 20/10 i «Failed to fetch» erano tra 41 e 90 per
  giorno feriale.

- [ ] **0.5 Chi chiama davvero `/api/health*`.** Il codice dice: il monitor esterno (`monitor-esterno/worker.mjs:46,74`,
  user agent `kidville-monitor-esterno`) e il campanello (`scripts/campanello/lettura.mjs:10`, `kidville-campanello`,
  usato da `campanello.mjs` e `dopo-deploy.mjs`). Nessun codice dell'app chiama `/api/health`. I log dicono:
  ```bash
  for p in /api/health /api/health/vivo /api/health/qualita; do
    npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall traffic inspect path "$p" --since 24h --group-by user-agent
  done
  ```
  Si annotano, per ogni percorso, le richieste totali e le famiglie di user agent.

- [ ] **0.6 Il volume dei quattro prefissi.** Serve a vedere quanto stanno sotto le soglie del Compito 15:
  ```bash
  npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall traffic list --since 24h --dimension path
  ```
  Si sommano le righe che cominciano con `/api/iscrizione`, `/api/forms`, `/api/public` e `/api/health`.

- [ ] **0.7 I nomi delle chiavi nei log di Supabase.** Le query 2 bis (sezione «Per la sessione dopo», punto 5) e la ricetta T9
  (Compito 15) usano chiavi di `log_attributes`. Prima si leggono quelle che esistono, con `query_logs`, nelle
  ultime 24 h:
  ```sql
  select distinct arrayJoin(mapKeys(log_attributes)) as chiave
  from logs where source = 'edge_logs' order by chiave limit 300
  ```
  ```sql
  select distinct arrayJoin(mapKeys(log_attributes)) as chiave
  from logs where source = 'auth_logs' order by chiave limit 300
  ```
  Su `edge_logs` devono esserci:
  - `request.path`, `request.search`, `response.status_code`;
  - `request.headers.cf_connecting_ip`, `request.headers.x_client_info`;
  - `response.origin_time`, `request.cf.colo`.

  Su `auth_logs`: `path` ed `error_code`. Un nome diverso si annota e lo si usa al posto di quello scritto in
  questo piano.

- [ ] **0.8 I limiti di Auth in produzione (S11a).** I limiti non sono nel repository: `supabase/config.toml:195-207`
  vale solo per il Supabase locale. Il titolare li legge in Supabase → Authentication → Rate Limits e li dà in chat:
  - `email_sent` (per ora);
  - `sms_sent` (per ora);
  - `anonymous_users` (per ora, per IP);
  - `token_refresh` (5 min, per IP);
  - `sign_in_sign_ups` (5 min, per IP);
  - `token_verifications` (5 min, per IP).

  Sono numeri di configurazione, non segreti: vanno nella tabella del Compito 15.

- [ ] **0.9 L'anteprima sarà misurabile?** Le anteprime sono protette: la richiesta anonima riceve un 302 verso
  `vercel.com/sso-api` (`docs/cicd.md`, la frase «302 a `vercel.com/sso-api`»: riga 352 il 20/10; le sessioni 4 e 5
  cambiano lo stesso file, e il numero si sposta). Si controllano due cose.
  - Le variabili dell'ambiente Preview esistono. Si leggono i soli nomi, i valori restano cifrati:
    ```bash
    npx vercel@64.7.0 --cwd /Users/lerri/kidville-web env ls preview
    ```
    Devono comparire `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY`
    (o i nomi che usa `src/lib/supabase/server-client.ts`).
  - Il titolare è disposto a creare un link di condivisione dell'anteprima: Vercel → il deployment del ramo →
    «Share». Il link porta `?_vercel_share=…` e lascia un cookie `_vercel_jwt`.
    - Mai `vercel curl`, `vercel httpstat` o lo strumento che chiede un accesso a un URL di Vercel: creano da soli
      un token di bypass della protezione.
    - Mai spegnere la protezione delle anteprime.

**Soglie che cambiano il piano:**
- 0.2 dà `HIT` alla seconda richiesta: S8 si è risolto da sé. I Compiti 13 e 14 si saltano, e il Compito 15 scrive
  la misura con data e ora. Il Compito 12 resta: è un riordino che non cambia le intestazioni.
- 0.5 mostra un altro chiamante automatico di `/api/health*` con più di una richiesta al minuto. Si chiede al titolare
  chi è. Se è suo, il suo user agent entra nella regola `s13-salute-monitor` (Rilascio, passo 8) prima della
  pubblicazione.
- 0.9: le variabili Preview mancano, oppure il titolare non può creare il link. Si va direttamente alla strada di
  ripiego in produzione (Compito 13, ramo «R»).

---

## Compiti

### Compito 1: prerequisiti, worktree, chiusura della sessione precedente, base verde

**File:**
- Crea: il worktree `/Users/lerri/kidville-web-s13` sul ramo `robustezza2/s13-bordo-pubblico`
- Modifica (solo nel primo commit, e solo quello che chiede il piano della sessione rilasciata per ultima): le
  fotografie in `__tests__/fixtures/`, `__tests__/architecture/soglia-fotografia.ts` e gli altri lock che quel piano
  nomina, la riga di quella sessione nella tabella di stato della specifica, la sua voce nel PRD

- [ ] **Passo 1: prerequisiti.** La sessione 13 non ha sessioni nella colonna «Dopo» della §1: si controlla solo che
  nessun'altra sessione sia aperta (le PR dei rami `-esito`, di soli documenti, non contano), e che specifica e piano
  siano in `main`. Lo «Stato» della tabella non si legge: lo chiude la sessione dopo, e direbbe il falso.
  ```bash
  git -C /Users/lerri/kidville-web fetch origin
  git -C /Users/lerri/kidville-web cat-file -e origin/main:docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md && echo specifica-ok
  git -C /Users/lerri/kidville-web cat-file -e origin/main:docs/superpowers/plans/2026-10-20-robustezza2-s13-bordo-pubblico.md && echo piano-ok
  gh pr list --repo erricoluigi17/kidville-web --state open --search "head:robustezza2/" --json number,headRefName --jq '.[] | select(.headRefName | endswith("-esito") | not) | "\(.number) \(.headRefName)"'
  git -C /Users/lerri/kidville-web worktree list | grep -c 'kidville-web-s13'
  ```
  - Atteso: `specifica-ok`, `piano-ok`; **nessuna riga** dal `gh pr list`; `0` dal `grep -c` (nessun worktree
    `kidville-web-s13` rimasto da un tentativo prima).
  - Se un controllo fallisce, **ci si ferma** e lo si dice al titolare. La §5 vuole una sessione alla volta.

- [ ] **Passo 2: worktree nuovo da `origin/main`.** Mai `git checkout` nel checkout principale: altre sessioni lo
  usano.
  ```bash
  git -C /Users/lerri/kidville-web worktree add /Users/lerri/kidville-web-s13 -b robustezza2/s13-bordo-pubblico origin/main
  ```
  Atteso: `Preparing worktree (new branch 'robustezza2/s13-bordo-pubblico')`.

- [ ] **Passo 3: `.env.local` e dipendenze.** Un worktree nuovo nasce senza `.env.local`. Lo copia il titolare e chi
  esegue non lo apre: `cp /Users/lerri/kidville-web/.env.local /Users/lerri/kidville-web-s13/.env.local`. Poi:
  ```bash
  cd /Users/lerri/kidville-web-s13 && npm ci
  ```
  Atteso: `added N packages`, uscita 0.

- [ ] **Passo 4: chiusura della sessione rilasciata per ultima (§5, «Apertura di una sessione: la chiusura della
  precedente»), prima di ogni codice.** Si trova la PR `robustezza2/` mergiata più di recente, rami `-esito` esclusi:
  ```bash
  gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/" --limit 50 --json number,headRefName,mergedAt --jq 'map(select(.headRefName | endswith("-esito") | not)) | sort_by(.mergedAt) | last | "\(.number) \(.headRefName)"'
  ```
  - Atteso: una riga `<numero> robustezza2/sNN-<nome>`. Se stampa `null null`, nessuna sessione della serie è
    ancora rilasciata: il passo si salta e non si committa niente (con l'ordine 1→14 non succede, la sessione 1 ha
    la scadenza del 31/10).
  - Altrimenti quella sessione si chiude qui, nel **primo commit** di questo ramo:
    1. Si apre il suo piano, `docs/superpowers/plans/2026-10-20-robustezza2-<nome del ramo senza «robustezza2/»>.md`,
       e si legge per intero la sua sezione finale «Per la sessione dopo». Si fa quello che c'è scritto, non quello
       che si presume.
    2. Se quella sessione aveva migrazioni, si rigenera la fotografia delle migrazioni applicate. Si stampa la query:
       ```bash
       cd /Users/lerri/kidville-web-s13 && SCRATCH=$(mktemp -d) && echo "$SCRATCH"
       node __tests__/fixtures/migrazioni-fotografia.mjs --sql
       ```
       La si esegue sul database di produzione con lo strumento `execute_sql` (sola lettura: legge solo
       `supabase_migrations.schema_migrations`), si salva la risposta JSON così com'è in
       `"$SCRATCH"/risposta-migrazioni.json`, poi:
       ```bash
       cd /Users/lerri/kidville-web-s13 && node __tests__/fixtures/migrazioni-fotografia.mjs < "$SCRATCH"/risposta-migrazioni.json
       CI=1 npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts 2>&1 | tail -8
       ```
       Atteso: `migrazioni-complete` verde. `soglia-fotografia` resta rosso sulla prova «nessuna chiave è già
       applicata» finché non si tolgono da `MIGRAZIONI_ATTESE_AL_MERGE` le voci che la sezione elenca: è il segnale
       previsto.
    3. Si fanno le altre voci della sezione nell'ordine in cui sono scritte: le altre fotografie che nomina (ciascuna
       col suo comando), le voci tolte dalle liste «fino alla PR-B», la riga di stato a «in produzione» col commit di
       `main`, lo Stato della voce nel PRD, le misure «dopo» già mature. Una misura non ancora matura non si inventa:
       si scrive nella colonna «Note» di quella riga da quando matura.
    4. Si verifica, e si committa solo se c'è qualcosa:
       ```bash
       cd /Users/lerri/kidville-web-s13 && CI=1 npx vitest run __tests__/architecture 2>&1 | tail -10
       grep -n -A3 "export const MIGRAZIONI_ATTESE_AL_MERGE" __tests__/architecture/soglia-fotografia.ts
       git status --short
       ```
       Atteso: `__tests__/architecture` verde; `MIGRAZIONI_ATTESE_AL_MERGE` senza le voci che la sezione ha fatto
       togliere (se non restano altre sessioni in attesa: `= {}`). Con `git status --short` vuoto non si committa.
       Altrimenti:
       ```bash
       cd /Users/lerri/kidville-web-s13 && git add __tests__/fixtures __tests__/architecture \
         docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md "PRD REGISTRO ELETTRONICO.md"
       git status --short
       ```
       Se il secondo `git status --short` mostra file non aggiunti che la sezione nomina (per esempio `docs/cicd.md`
       o un generatore in `scripts/`), si aggiungono per nome; un file che la sezione non nomina non entra. Poi:
       ```bash
       cd /Users/lerri/kidville-web-s13 && git commit -m "Chiusura della sessione rilasciata per ultima: fotografie, stato in produzione, PRD" \
         -m "Eseguita la sezione «Per la sessione dopo» del suo piano, nel primo commit della sessione 13." \
         -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
       ```

- [ ] **Passo 5: base verde sui file che questa sessione tocca.** `CI=1` serve perché in un worktree nuovo mancano gli
  artefatti di `cap sync`, e senza `CI` il lock `offline-html-nativo` è rosso per quella ragione, non per un guasto.
  ```bash
  cd /Users/lerri/kidville-web-s13 && CI=1 npx vitest run \
    __tests__/api/iscrizione.test.ts __tests__/api/iscrizione-sedi.test.ts __tests__/api/iscrizione-model-anonima.test.ts \
    __tests__/api/forms-submit.test.ts __tests__/api/public-forms-submit.test.ts __tests__/api/note-voti-scope-sede.test.ts \
    __tests__/api/competenze-route.test.ts __tests__/api/anagrafiche-comuni.test.ts __tests__/lib/protocolli-store.test.ts \
    __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/catch-muti-allowlist.test.ts \
    __tests__/architecture/errori-postgrest-guardati.test.ts __tests__/architecture/gate-coverage.test.ts \
    __tests__/architecture/offline-html-nativo.test.ts
  ```
  Atteso: `Test Files  14 passed (14)`.

- [ ] **Passo 6: la build di oggi, col heap che serve su questo Mac.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && NODE_OPTIONS=--max-old-space-size=8192 npm run build
  ```
  Atteso: uscita 0 e la tabella delle rotte. Senza `NODE_OPTIONS`, su questo Mac la build finisce in OOM: è il
  problema S12, che il Compito 11 chiude. Niente da committare in questo passo.

### Compito 2: `rispostaGuastoGiaRegistrato`

**File:**
- Modifica: `src/lib/db/guasto.ts:18-28, 40-53`
- Crea: `__tests__/lib/db-guasto-gia-registrato.test.ts`

Serve dove la riga di log c'è già, scritta una riga sopra con un `esito` più preciso: `logEvento('modulistica',
'error', …)` in `forms/submit`, e `sediReali` in `iscrizione/sedi`. Una seconda riga per lo stesso guasto raddoppierebbe
i conteggi.

- [ ] **Passo 1: il test rosso.** Crea `__tests__/lib/db-guasto-gia-registrato.test.ts`:
  ```ts
  // @vitest-environment node
  import { describe, it, expect, vi, beforeEach } from 'vitest'

  const h = vi.hoisted(() => ({ logErrore: vi.fn() }))

  vi.mock('@/lib/logging/logger', async (importOriginal) => {
    const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
    return { ...vero, logErrore: (...a: unknown[]) => h.logErrore(...a) }
  })

  import { rispostaGuastoDb, rispostaGuastoGiaRegistrato } from '@/lib/db/guasto'

  beforeEach(() => vi.clearAllMocks())

  describe('rispostaGuastoGiaRegistrato — la risposta del guasto, senza una seconda riga di log', () => {
    it('lettura (predefinita): 500 LETTURA_FALLITA, e nessuna riga', async () => {
      const res = rispostaGuastoGiaRegistrato()
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'Lettura dal database non riuscita', codice: 'LETTURA_FALLITA' })
      expect(h.logErrore).not.toHaveBeenCalled()
    })

    it('scrittura: 500 SCRITTURA_FALLITA', async () => {
      const res = rispostaGuastoGiaRegistrato('scrittura')
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'Scrittura sul database non riuscita', codice: 'SCRITTURA_FALLITA' })
      expect(h.logErrore).not.toHaveBeenCalled()
    })

    it('rispostaGuastoDb risponde allo stesso modo, e in più scrive la riga col guasto', async () => {
      const guasto = { code: '57014', message: 'canceling statement due to statement timeout' }
      const res = rispostaGuastoDb('x:GET', 'db:t', guasto)
      expect(await res.json()).toEqual({ error: 'Lettura dal database non riuscita', codice: 'LETTURA_FALLITA' })
      expect(h.logErrore).toHaveBeenCalledWith({ operazione: 'x:GET', stato: 500, evento: 'db:t' }, guasto)
    })
  })
  ```

- [ ] **Passo 2: è rosso.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/lib/db-guasto-gia-registrato.test.ts
  ```
  Atteso: FAIL nei primi due test. Il messaggio contiene `rispostaGuastoGiaRegistrato is not a function`.

- [ ] **Passo 3: il codice.** In `src/lib/db/guasto.ts`, sostituisci le righe 40-53 (tutta `rispostaGuastoDb`) con:
  ```ts
  export function rispostaGuastoDb(
    operazione: string,
    evento: string,
    error: unknown,
    tipo: TipoGuasto = 'lettura',
  ): NextResponse {
    logErrore({ operazione, stato: 500, evento }, error)
    return rispostaGuastoGiaRegistrato(tipo)
  }

  /**
   * La stessa risposta di `rispostaGuastoDb`, per quando la riga di log c'è GIÀ: `sediReali` che logga da sé, un
   * `logEvento('modulistica', 'error', …)` scritto una riga sopra con un `esito` più preciso. Una seconda riga per
   * lo stesso guasto raddoppierebbe i conteggi. (Sessione 13 della seconda serie: le porte anonime non mandano più
   * il testo di PostgREST.)
   */
  export function rispostaGuastoGiaRegistrato(tipo: TipoGuasto = 'lettura'): NextResponse {
    // Due letterali e non una mappa: il lock `errori-con-codice` verifica solo i codici che sa
    // leggere nel sorgente.
    if (tipo === 'scrittura') {
      return NextResponse.json({ error: 'Scrittura sul database non riuscita', codice: 'SCRITTURA_FALLITA' }, { status: 500 })
    }
    return NextResponse.json({ error: 'Lettura dal database non riuscita', codice: 'LETTURA_FALLITA' }, { status: 500 })
  }
  ```
  Nella testata, dopo la riga 28 (`   *     visto.`), aggiungi:
  ```ts
   *   · `rispostaGuastoGiaRegistrato` — la risposta di `rispostaGuastoDb` senza la riga, quando l'ha già scritta
   *     chi chiama (sessione 13).
  ```

- [ ] **Passo 4: è verde.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/lib/db-guasto-gia-registrato.test.ts
  ```
  Atteso: `Test Files  1 passed (1)`, `Tests  3 passed (3)`.

- [ ] **Passo 5: commit.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && git add src/lib/db/guasto.ts __tests__/lib/db-guasto-gia-registrato.test.ts
  git commit -m "Guasto del database: la risposta anche senza una seconda riga di log (rispostaGuastoGiaRegistrato)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Compito 3: `rispostaErroreInterno` e il codice `ERRORE_INTERNO`

**File:**
- Crea: `src/lib/api/errore-interno.ts`, `__tests__/lib/errore-interno.test.ts`
- Modifica: `src/lib/ui/esito-fetch.ts` (dopo `    SCRITTURA_FALLITA: 'erroreScritturaFallita',`; riga 3380 il 20/10),
  `messages/it/shared.json` e `messages/en/shared.json` (in coda, dopo l'ultima chiave che c'è davvero)

- [ ] **Passo 1: il test rosso.** Crea `__tests__/lib/errore-interno.test.ts`:
  ```ts
  // @vitest-environment node
  import { describe, it, expect, vi, beforeEach } from 'vitest'
  import itShared from '../../messages/it/shared.json'
  import enShared from '../../messages/en/shared.json'

  const h = vi.hoisted(() => ({ logErrore: vi.fn() }))

  vi.mock('@/lib/logging/logger', async (importOriginal) => {
    const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
    return { ...vero, logErrore: (...a: unknown[]) => h.logErrore(...a) }
  })

  import { rispostaErroreInterno, rispostaErroreInternoGiaRegistrato } from '@/lib/api/errore-interno'
  import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'

  const FRASE = 'Si è verificato un errore imprevisto. Riprova fra poco.'

  beforeEach(() => vi.clearAllMocks())

  describe('rispostaErroreInterno — al chiamante il codice, al log l’errore intero', () => {
    it('500 con il solo codice: il messaggio dell’eccezione resta nel log', async () => {
      const err = new Error('violates unique constraint: dettaglio interno')
      const res = rispostaErroreInterno('x:POST', err)
      expect(res.status).toBe(500)
      const corpo = await res.json()
      expect(corpo).toEqual({ error: FRASE, codice: 'ERRORE_INTERNO' })
      expect(JSON.stringify(corpo)).not.toContain('dettaglio interno')
      expect(h.logErrore).toHaveBeenCalledWith({ operazione: 'x:POST', stato: 500 }, err)
    })

    it('la variante «già registrato» risponde uguale e non scrive una seconda riga', async () => {
      const res = rispostaErroreInternoGiaRegistrato()
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: FRASE, codice: 'ERRORE_INTERNO' })
      expect(h.logErrore).not.toHaveBeenCalled()
    })

    it('il codice è dichiarato e tradotto, e la frase italiana è quella del catalogo', () => {
      const chiave = (CODICI_ERRORE as Record<string, string>).ERRORE_INTERNO
      expect(chiave).toBe('erroreInterno')
      expect((itShared as Record<string, string>)[chiave]).toBe(FRASE)
      expect((enShared as Record<string, string>)[chiave]).toBeTruthy()
    })
  })
  ```

- [ ] **Passo 2: è rosso.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/lib/errore-interno.test.ts
  ```
  Atteso: FAIL, `Failed to resolve import "@/lib/api/errore-interno"`.

- [ ] **Passo 3: la funzione.** Crea `src/lib/api/errore-interno.ts`:
  ```ts
  import { NextResponse } from 'next/server'
  import { logErrore } from '@/lib/logging/logger'

  /**
   * UN'ECCEZIONE IN UNA ROUTE: al chiamante il codice, al log l'errore intero.
   * (Sessione 13 della seconda serie di robustezza, «bordo pubblico» — 2026-10-20.)
   *
   * PERCHÉ ESISTE. Il 20/10 nove risposte di quattro porte anonime (`/api/iscrizione`, `/api/iscrizione/sedi`,
   * `/api/forms/submit`, `/api/public/forms/[token]/submit`) mandavano a chiunque il `message` dell'errore: il testo
   * di PostgREST o di un'eccezione interna, con nomi di tabelle e di vincoli e a volte `Key (…)=(…)`. Per una
   * famiglia è rumore incomprensibile; per chi bussa alle porte una dopo l'altra è una descrizione dello schema.
   *
   * DUE FORME, come in `src/lib/db/guasto.ts` (che resta la strada per i guasti del database):
   *   · `rispostaErroreInterno(operazione, err)` — nel `catch` di una route: scrive `logErrore` e risponde 500
   *     `ERRORE_INTERNO`;
   *   · `rispostaErroreInternoGiaRegistrato()` — la stessa risposta quando la riga l'ha già scritta chi chiama,
   *     con un `esito` più preciso.
   *
   * Il lock `__tests__/architecture/porte-anonime-senza-errori-interni.test.ts` vieta `.message` nelle risposte
   * delle porte anonime; `errori-con-codice` controlla che `ERRORE_INTERNO` sia dichiarato e tradotto.
   */

  export function rispostaErroreInterno(operazione: string, err: unknown): NextResponse {
    logErrore({ operazione, stato: 500 }, err)
    return rispostaErroreInternoGiaRegistrato()
  }

  export function rispostaErroreInternoGiaRegistrato(): NextResponse {
    // Letterali, non costanti: il lock `errori-con-codice` controlla solo ciò che sa leggere.
    return NextResponse.json(
      { error: 'Si è verificato un errore imprevisto. Riprova fra poco.', codice: 'ERRORE_INTERNO' },
      { status: 500 },
    )
  }
  ```

- [ ] **Passo 4: il codice nel registro dei codici.** In `src/lib/ui/esito-fetch.ts` si cerca la riga
  `    SCRITTURA_FALLITA: 'erroreScritturaFallita',`, seguita da `} as const;` (il 20/10 era la 3380; la sessione 1
  aggiunge `DOMANDA_GIA_ESAMINATA` più in alto e la sposta). Subito dopo quella riga, prima di `} as const;`, aggiungi:
  ```ts
      /**
       * 500 — un'eccezione in una route (`src/lib/api/errore-interno.ts`, sessione 13 della seconda serie di
       * robustezza). Il testo dell'eccezione resta nel log; al client arriva solo questo codice.
       */
      ERRORE_INTERNO: 'erroreInterno',
  ```

- [ ] **Passo 5: le due traduzioni, in coda ai cataloghi.** La chiave nuova va dopo l'ultima chiave che c'è
  **davvero**: il 20/10 era `erroreScritturaFallita`, ma la sessione 1 aggiunge dopo di lei
  `erroreDomandaGiaEsaminata`, e un'altra sessione potrebbe averne aggiunte altre. Niente numero di riga: lo fa uno
  script che appende in coda e controlla di non aver tolto niente. Mai riordinare un catalogo.
  ```bash
  cd /Users/lerri/kidville-web-s13 && node -e '
  const fs = require("fs")
  const voci = {
    "messages/it/shared.json": "Si è verificato un errore imprevisto. Riprova fra poco.",
    "messages/en/shared.json": "An unexpected error occurred. Please try again shortly.",
  }
  for (const [file, frase] of Object.entries(voci)) {
    const testo = fs.readFileSync(file, "utf8")
    const prima = JSON.parse(testo)
    if ("erroreInterno" in prima) throw new Error(file + ": erroreInterno esiste già")
    const fine = testo.lastIndexOf("\n}")
    if (fine < 0 || testo.slice(fine).trim() !== "}") throw new Error(file + ": il file non chiude con una graffa sola")
    const nuovo = testo.slice(0, fine) + ",\n  \"erroreInterno\": " + JSON.stringify(frase) + testo.slice(fine)
    const dopo = JSON.parse(nuovo)
    const chiavi = Object.keys(dopo)
    if (chiavi.at(-1) !== "erroreInterno" || chiavi.length !== Object.keys(prima).length + 1) {
      throw new Error(file + ": la chiave non è finita in coda, o se ne è persa una")
    }
    fs.writeFileSync(file, nuovo)
    console.log(file, "· ultima chiave di prima:", Object.keys(prima).at(-1), "· chiavi:", chiavi.length)
  }
  '
  ```
  Atteso: due righe, una per catalogo, con la stessa ultima chiave di prima (`erroreDomandaGiaEsaminata`, se la
  sessione 1 è in produzione) e lo stesso numero di chiavi.

  Poi la verifica, sui due file:
  ```bash
  cd /Users/lerri/kidville-web-s13 && node -e '
  const it = JSON.parse(require("fs").readFileSync("messages/it/shared.json", "utf8"))
  const en = JSON.parse(require("fs").readFileSync("messages/en/shared.json", "utf8"))
  for (const [nome, cat] of [["it", it], ["en", en]]) {
    if (Object.keys(cat).at(-1) !== "erroreInterno") throw new Error(nome + ": erroreInterno non è in coda")
    for (const c of ["erroreScritturaFallita", "erroreDomandaGiaEsaminata", "erroreInterno"]) {
      if (!(c in cat)) throw new Error(nome + ": manca " + c)
    }
  }
  if (Object.keys(it).join() !== Object.keys(en).join()) throw new Error("it ed en non hanno le stesse chiavi nello stesso ordine")
  console.log("cataloghi ok:", Object.keys(it).length, "chiavi")
  '
  git diff --stat -- messages/it/shared.json messages/en/shared.json
  ```
  - Atteso: `cataloghi ok: N chiavi`, e nel diff 2 righe per file (la virgola sulla riga di prima e la riga nuova).
  - Se manca `erroreDomandaGiaEsaminata`: la sessione 1 non è in produzione, o ha dato alla sua chiave un altro nome.
    Ci si ferma e si controlla nel suo piano (`docs/superpowers/plans/2026-10-20-robustezza2-s01-iscrizioni.md`) la
    chiave che aggiunge: se il nome è un altro, si mette quello nel controllo.

- [ ] **Passo 6: è verde, e i lock sui codici pure.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/lib/errore-interno.test.ts \
    __tests__/architecture/errori-con-codice.test.ts __tests__/lib/ui/esito-fetch-dettaglio.test.ts
  ```
  Atteso: `Test Files  3 passed (3)`. `errori-con-codice` vede il codice nuovo, lo trova dichiarato e tradotto.

- [ ] **Passo 7: commit.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && git add src/lib/api/errore-interno.ts __tests__/lib/errore-interno.test.ts \
    src/lib/ui/esito-fetch.ts messages/it/shared.json messages/en/shared.json
  git commit -m "Errore interno: al chiamante solo il codice ERRORE_INTERNO, l'eccezione nel log" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Compito 4: il lock delle porte anonime

**File:**
- Crea: `__tests__/architecture/porte-anonime-senza-errori-interni.test.ts`

Il lock entra nel commit che lo fa diventare verde (fine del Compito 6). Fino ad allora resta nel worktree, rosso.

- [ ] **Passo 1: il lock.** Crea `__tests__/architecture/porte-anonime-senza-errori-interni.test.ts`:
  ```ts
  // @vitest-environment node
  import fs from 'node:fs'
  import path from 'node:path'
  import { describe, it, expect } from 'vitest'
  import { mascheraSorgente, fineParentesi, riga } from '../fixtures/sorgente'

  /**
   * LOCK · UNA PORTA ANONIMA NON RACCONTA I SUOI GUASTI A CHI BUSSA.
   * (Sessione 13 della seconda serie di robustezza, «bordo pubblico» — 2026-10-20.)
   *
   * Le porte di `PUBBLICHE` in `gate-coverage.test.ts` rispondono a chiunque, senza login. Il 20/10 nove risposte
   * di quattro di loro mandavano al chiamante il `message` dell'errore: il testo di PostgREST (nomi di tabelle e di
   * vincoli, a volte `Key (…)=(…)`) o quello di un'eccezione interna.
   *
   * LA FORMA VIETATA, dentro il corpo del handler di una porta anonima: una risposta costruita a mano
   * (`NextResponse.json(…)`, `Response.json(…)`, `new Response(…)`, `new NextResponse(…)`) i cui argomenti
   * contengono `.message`, direttamente o attraverso una variabile dello stesso handler che lo contiene nel suo
   * inizializzatore (`const msg = err instanceof Error ? err.message : …`).
   *
   * COME SI RIPARA: `rispostaGuastoDb` / `rispostaGuastoGiaRegistrato` (`src/lib/db/guasto.ts`) per un guasto del
   * database, `rispostaErroreInterno` / `rispostaErroreInternoGiaRegistrato` (`src/lib/api/errore-interno.ts`) per
   * un'eccezione. L'errore intero va nel log, dove passa dalla redazione.
   *
   * L'elenco delle porte NON si copia: si legge da `gate-coverage.test.ts`, così una porta anonima nuova entra qui
   * lo stesso giorno in cui entra là.
   *
   * COSA NON VEDE, detto perché nessuno lo creda più largo: una destrutturazione (`const { message } = err`), un
   * `message` passato da una funzione d'aiuto definita fuori dal handler, un oggetto d'errore intero messo nel
   * corpo. Il 20/10 nessuna delle 23 porte usava una di queste forme (controllato a mano).
   *
   * FUORI: le route autenticate. Il 20/10, con questo stesso lettore, 319 risposte in 210 handler. Lì chi legge il
   * messaggio è il personale; si sistemano quando una sessione tocca il loro file.
   */

  const RADICE = process.cwd()
  const GATE = path.join(RADICE, '__tests__', 'architecture', 'gate-coverage.test.ts')

  /** Una risposta HTTP costruita a mano: è lì che un `message` esce verso il chiamante. */
  const RISPOSTA = /\b(?:NextResponse|Response)\s*\.\s*json\s*\(|\bnew\s+(?:Next)?Response\s*\(/g
  /** Il testo di un errore: `error.message`, `(err as Error).message`, `retry.error.message`. */
  const MESSAGGIO = /\.\s*message\b/
  /** `const x =`, `let x: T =` — non `==`, non `=>`. */
  const DICHIARAZIONE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=(?!=|>)/g
  /** Una riga che finisce così continua sotto (`cond ?`, `a ||`, `f(`). */
  const CONTINUA_DOPO = /(\?\?|\|\||&&|[?:,(=+])$/
  /** Una riga che comincia così continua quella sopra (`? a`, `: b`, `.trim()`). */
  const CONTINUA_PRIMA = /^(\?\?|\|\||&&|[?:.])/

  type Porta = { chiave: string; file: string; verbo: string }
  type Fuga = { riga: number; testo: string }

  /** Le porte anonime, lette da `PUBBLICHE` di `gate-coverage.test.ts`. */
  function porteAnonime(): Porta[] {
    const testo = fs.readFileSync(GATE, 'utf8')
    const inizio = testo.indexOf('const PUBBLICHE')
    const fine = testo.indexOf('\n}\n', inizio)
    if (inizio < 0 || fine < 0) return []
    const out: Porta[] = []
    for (const m of testo.slice(inizio, fine).matchAll(/^\s*'([^']+):(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)'\s*:/gm)) {
      out.push({ chiave: `${m[1]}:${m[2]}`, file: `src/app/api/${m[1]}/route.ts`, verbo: m[2] })
    }
    return out
  }

  /** Fine (esclusa) dell'inizializzatore che comincia in `da`, sul testo `struttura`. */
  function fineInizializzatore(strut: string, da: number): number {
    let livello = 0
    for (let k = da; k < strut.length; k++) {
      const c = strut[k]
      if (c === '(' || c === '[' || c === '{') livello++
      else if (c === ')' || c === ']' || c === '}') {
        livello--
        if (livello < 0) return k
      } else if (c === ';' && livello === 0) return k
      else if (c === '\n' && livello === 0) {
        const prima = strut.slice(strut.lastIndexOf('\n', k - 1) + 1, k).trim()
        const dopo = (/^\s*(\S.*)?/.exec(strut.slice(k + 1))?.[1] ?? '').trim()
        if (prima !== '' && !CONTINUA_DOPO.test(prima) && !CONTINUA_PRIMA.test(dopo)) return k
      }
    }
    return strut.length
  }

  /** Le risposte del handler `verbo` che mandano un `message` al chiamante. `null` se il handler non c'è. */
  function fughe(sorgente: string, verbo: string): Fuga[] | null {
    const { struttura } = mascheraSorgente(sorgente)
    const testa = new RegExp(`export\\s+const\\s+${verbo}\\s*=\\s*withRoute\\s*\\(`).exec(struttura)
    if (!testa) return null
    const corpo = testa.index + testa[0].length
    const tratto = struttura.slice(corpo, fineParentesi(struttura, corpo - 1))

    // Le variabili che portano un `message` nel loro valore. Si cerca da DOPO `withRoute(`: il nome del
    // handler (`POST`, `GET`) non è una variabile del corpo.
    const contaminate: string[] = []
    for (const d of tratto.matchAll(DICHIARAZIONE)) {
      const da = (d.index ?? 0) + d[0].length
      if (MESSAGGIO.test(tratto.slice(da, fineInizializzatore(tratto, da)))) contaminate.push(d[1])
    }

    const righe = sorgente.split('\n')
    const out: Fuga[] = []
    for (const r of tratto.matchAll(RISPOSTA)) {
      const apertura = (r.index ?? 0) + r[0].length - 1
      const argomenti = tratto.slice(apertura, fineParentesi(tratto, apertura))
      const viaNome = contaminate.some((n) =>
        new RegExp(`(?<![\\w$.])${n.replace(/\$/g, '\\$')}(?![\\w$])`).test(argomenti),
      )
      if (!MESSAGGIO.test(argomenti) && !viaNome) continue
      const n = riga(struttura, corpo + (r.index ?? 0))
      out.push({ riga: n, testo: (righe[n - 1] ?? '').trim().slice(0, 120) })
    }
    return out
  }

  /** Controllo positivo: le tre forme che il 20/10 stavano davvero nelle porte anonime. */
  const VIETATO = [
    "export const POST = withRoute('x:POST', async (request: Request) => {",
    "  const { error } = await db.from('t').insert({})",
    '  if (error) return NextResponse.json({ error: error.message }, { status: 500 })',
    '  try {',
    '    lavora()',
    '  } catch (err) {',
    '    const msg = err instanceof Error',
    '      ? err.message',
    "      : 'Errore interno'",
    '    return NextResponse.json({ error: msg }, { status: 500 })',
    '  }',
    '  return new Response(JSON.stringify({ error: `guasto: ${error.message}` }), { status: 500 })',
    '})',
  ].join('\n')

  /** Controllo negativo: un commento, una stringa e `messageCount` non sono fughe; il GET sì. */
  const CORRETTO = [
    "export const POST = withRoute('x:POST', async (request: Request) => {",
    '  // NextResponse.json({ error: error.message }) — in un commento non conta',
    "  const { data: dati, error } = await db.from('t').select('id')",
    "  if (error) return rispostaGuastoDb('x:POST', 'db:t', error)",
    "  const testo = 'la stringa .message non è codice'",
    '  return NextResponse.json({ ok: true, nota: testo, quanti: dati.messageCount })',
    '})',
    "export const GET = withRoute('x:GET', async () => {",
    '  try { return NextResponse.json({ ok: true }) } catch (err) {',
    '    return NextResponse.json({ error: (err as Error).message }, { status: 500 })',
    '  }',
    '})',
  ].join('\n')

  const PORTE = porteAnonime()
  const leggi = (p: Porta): string => fs.readFileSync(path.join(RADICE, p.file), 'utf8')

  describe('lock — una porta anonima non manda il `message` di un errore a chi chiama', () => {
    it('legge davvero le porte (non è verde scansionando zero handler)', () => {
      expect(PORTE.length, '`PUBBLICHE` di gate-coverage.test.ts non letto: è cambiata la sua forma?').toBeGreaterThanOrEqual(20)
      const mancanti = PORTE
        .filter((p) => !fs.existsSync(path.join(RADICE, p.file)) || fughe(leggi(p), p.verbo) === null)
        .map((p) => p.chiave)
      expect(mancanti, 'porte senza file o senza `export const VERBO = withRoute(`').toEqual([])
    })

    it('riconosce le forme vietate e lascia passare quelle corrette (controllo positivo)', () => {
      expect(fughe(VIETATO, 'POST')?.map((f) => f.riga)).toEqual([3, 10, 12])
      expect(fughe(CORRETTO, 'POST')).toEqual([])
      expect(fughe(CORRETTO, 'GET')?.map((f) => f.riga)).toEqual([10])
      expect(fughe(CORRETTO, 'PUT')).toBeNull()
    })

    it('nessuna porta anonima manda il `message` di un errore', () => {
      const trovate = PORTE.flatMap((p) =>
        (fughe(leggi(p), p.verbo) ?? []).map((f) => `${p.file}:${f.riga} (${p.chiave}) → ${f.testo}`),
      )
      expect(
        trovate,
        'Una porta anonima risponde con il testo di un errore. Chi la chiama non ha un account: quel testo ' +
          'gli descrive tabelle e vincoli. Usa `rispostaGuastoDb`/`rispostaGuastoGiaRegistrato` ' +
          '(src/lib/db/guasto.ts) o `rispostaErroreInterno` (src/lib/api/errore-interno.ts): al chiamante il ' +
          'codice, al log l’errore intero.',
      ).toEqual([])
    })
  })
  ```

- [ ] **Passo 2: è rosso sulle 9 risposte di oggi.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/architecture/porte-anonime-senza-errori-interni.test.ts
  ```
  Atteso: 2 test verdi e 1 rosso, con queste 9 righe e nessun'altra:
  ```
  src/app/api/iscrizione/route.ts:390 (iscrizione:POST)
  src/app/api/iscrizione/route.ts:399 (iscrizione:POST)
  src/app/api/iscrizione/route.ts:432 (iscrizione:POST)
  src/app/api/iscrizione/sedi/route.ts:55 (iscrizione/sedi:GET)
  src/app/api/public/forms/[token]/submit/route.ts:171 (public/forms/[token]/submit:POST)
  src/app/api/forms/submit/route.ts:83 (forms/submit:POST)
  src/app/api/forms/submit/route.ts:116 (forms/submit:POST)
  src/app/api/forms/submit/route.ts:158 (forms/submit:POST)
  src/app/api/forms/submit/route.ts:203 (forms/submit:POST)
  ```
  Se l'elenco è diverso, ci si ferma: o il codice è cambiato dopo il 20/10, o il lettore sbaglia. Nessun commit.

### Compito 5: `/api/iscrizione` e `/api/iscrizione/sedi`

**File:**
- Modifica: `src/app/api/iscrizione/route.ts:10, 389-391, 399, 430-433`; `src/app/api/iscrizione/sedi/route.ts:8, 55`
- Crea: `__tests__/api/iscrizione-errori-con-codice.test.ts`
- Modifica: `__tests__/api/iscrizione-sedi.test.ts:57, 103-109`

- [ ] **Passo 1: il test rosso dell'iscrizione.** Crea `__tests__/api/iscrizione-errori-con-codice.test.ts`:
  ```ts
  // @vitest-environment node
  import { describe, it, expect, vi, beforeEach } from 'vitest'

  /**
   * `POST /api/iscrizione` è la porta da cui arrivano le domande vere. Un guasto qui rispondeva a un anonimo con
   * il testo di PostgREST, e i due inserimenti falliti non lasciavano nemmeno una riga di log. Il payload è
   * quello minimo di `iscrizione.test.ts`.
   */

  const h = vi.hoisted(() => ({
    modello: {
      schema: {
        version: '1',
        pages: [
          { id: 'bambino', title: 'B', fields: [
            { id: 'nome', type: 'text', label: 'Nome', required: true, validation: { min_length: 2 } },
            { id: 'residence_province', type: 'text', label: 'Provincia', required: true, validation: { pattern: '^[A-Z]{2}$', min_length: 2, max_length: 2 } },
          ] },
          { id: 'adulto', title: 'A', fields: [
            { id: 'residence_province', type: 'text', label: 'Provincia', required: true, validation: { pattern: '^[A-Z]{2}$', min_length: 2, max_length: 2 } },
          ] },
        ],
      },
    } as Record<string, unknown>,
    inserimenti: [] as Array<{ data: unknown; error: unknown }>,
    adminLancia: false,
    logErrore: vi.fn(),
  }))

  vi.mock('@/lib/logging/logger', async (importOriginal) => {
    const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
    return { ...vero, logErrore: (...a: unknown[]) => h.logErrore(...a) }
  })
  vi.mock('@/lib/security/rate-limit', () => ({
    rateLimit: vi.fn().mockReturnValue({ ok: true, remaining: 9, retryAfterMs: 0 }),
    clientIp: vi.fn().mockReturnValue('ip'),
  }))
  vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn().mockResolvedValue(undefined) }))
  vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn().mockResolvedValue([]) }))
  vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => {
      if (h.adminLancia) throw new Error('chiave di servizio assente: dettaglio interno')
      return {
        from: (table: string) => {
          const b: Record<string, unknown> = {}
          if (table === 'schools' || table === 'scuole') {
            // `sediReali` legge le due tabelle con catene diverse: il builder è thenable.
            const risultato =
              table === 'schools'
                ? { data: [{ id: 'scuola-reale', nome: 'Sede di prova' }], error: null }
                : { data: [{ id: 'scuola-reale', attiva: true }], error: null }
            b.select = () => b
            b.order = () => b
            b.in = () => b
            b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(risultato).then(ok, ko)
            return b
          }
          if (table === 'form_models') {
            b.select = () => b
            b.eq = () => b
            b.maybeSingle = async () => ({ data: h.modello, error: null })
            return b
          }
          // enrollment_submissions: un esito per inserimento, in ordine.
          b.insert = () => b
          b.select = () => b
          b.single = async () => h.inserimenti.shift() ?? { data: { id: 'sub-1' }, error: null }
          return b
        },
      }
    },
  }))

  import { POST } from '@/app/api/iscrizione/route'

  const req = (body: unknown) =>
    new Request('http://localhost/api/iscrizione', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest

  const domanda = {
    data: {
      presa_visione_informativa: true,
      children: [{ nome: 'Marco', residence_province: 'MI' }],
      adults: [{ residence_province: 'RM' }],
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    h.inserimenti = []
    h.adminLancia = false
  })

  describe('POST /api/iscrizione — un guasto risponde con un codice, mai con il testo di Postgres', () => {
    it('inserimento rifiutato → 500 SCRITTURA_FALLITA, e la riga di log che prima mancava', async () => {
      const guasto = { code: '23505', message: 'duplicate key value violates unique constraint "enrollment_submissions_pkey"' }
      h.inserimenti = [{ data: null, error: guasto }]
      const res = await POST(req(domanda))
      expect(res.status).toBe(500)
      const corpo = await res.json()
      expect(corpo.codice).toBe('SCRITTURA_FALLITA')
      expect(JSON.stringify(corpo)).not.toContain('duplicate key')
      expect(h.logErrore).toHaveBeenCalledWith(
        expect.objectContaining({ operazione: 'iscrizione:POST', stato: 500, evento: 'db:enrollment_submissions' }),
        guasto,
      )
    })

    it('colonna assente, poi secondo inserimento rifiutato → 500 SCRITTURA_FALLITA', async () => {
      h.inserimenti = [
        { data: null, error: { code: 'PGRST204', message: "Could not find the 'consents_log' column" } },
        { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } },
      ]
      const res = await POST(req(domanda))
      expect(res.status).toBe(500)
      const corpo = await res.json()
      expect(corpo.codice).toBe('SCRITTURA_FALLITA')
      expect(JSON.stringify(corpo)).not.toContain('statement timeout')
    })

    it('eccezione → 500 ERRORE_INTERNO, il messaggio solo nel log', async () => {
      h.adminLancia = true
      const res = await POST(req(domanda))
      expect(res.status).toBe(500)
      const corpo = await res.json()
      expect(corpo.codice).toBe('ERRORE_INTERNO')
      expect(JSON.stringify(corpo)).not.toContain('dettaglio interno')
      expect(h.logErrore).toHaveBeenCalledWith(
        expect.objectContaining({ operazione: 'iscrizione:POST', stato: 500 }),
        expect.any(Error),
      )
    })
  })
  ```

- [ ] **Passo 2: il test delle sedi chiede il codice.** In `__tests__/api/iscrizione-sedi.test.ts`, riga 57:
  ```ts
  type Corpo = { success?: boolean; data?: { id: string; nome: string }[]; error?: string }
  ```
  diventa:
  ```ts
  type Corpo = { success?: boolean; data?: { id: string; nome: string }[]; error?: string; codice?: string }
  ```
  Nel test `errore PostgREST sulla lettura di schools → 500 (non un elenco vuoto silenzioso)`, dopo
  `    expect(json.error).toBeTruthy()` aggiungi:
  ```ts
      // Il testo di Postgres («relation … does not exist») resta nel log di `sediReali`: a un anonimo il codice.
      expect(json.codice).toBe('LETTURA_FALLITA')
      expect(JSON.stringify(json)).not.toContain('relation')
  ```

- [ ] **Passo 3: sono rossi.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/api/iscrizione-errori-con-codice.test.ts __tests__/api/iscrizione-sedi.test.ts
  ```
  Atteso: 3 FAIL in `iscrizione-errori-con-codice` (`expected undefined to be 'SCRITTURA_FALLITA'` /
  `'ERRORE_INTERNO'`) e 1 FAIL in `iscrizione-sedi` (`expected undefined to be 'LETTURA_FALLITA'`).

- [ ] **Passo 4: `iscrizione/route.ts`.**
  1. La riga 10
     ```ts
     import { logErrore, logEvento } from '@/lib/logging/logger'
     ```
     diventa:
     ```ts
     import { logEvento } from '@/lib/logging/logger'
     import { rispostaGuastoDb } from '@/lib/db/guasto'
     import { rispostaErroreInterno } from '@/lib/api/errore-interno'
     ```
  2. Il secondo inserimento (righe 389-391):
     ```ts
             if (retry.error) {
               return NextResponse.json({ error: retry.error.message }, { status: 500 })
             }
     ```
     diventa:
     ```ts
             if (retry.error) {
               return rispostaGuastoDb(OPERAZIONE, 'db:enrollment_submissions', retry.error, 'scrittura')
             }
     ```
  3. Il primo inserimento (riga 399):
     ```ts
           return NextResponse.json({ error: error.message }, { status: 500 })
         }
     ```
     diventa:
     ```ts
           // Una domanda che non entra è il guasto più grave di questa porta: fino al 20/10 non lasciava
           // nemmeno una riga di log, e alla famiglia arrivava il testo di Postgres.
           return rispostaGuastoDb(OPERAZIONE, 'db:enrollment_submissions', error, 'scrittura')
         }
     ```
  4. Il `catch` (righe 430-433):
     ```ts
       } catch (err) {
         logErrore({ operazione: 'iscrizione:POST', stato: 500 }, err)
         const msg = err instanceof Error ? err.message : 'Errore interno'
         return NextResponse.json({ error: msg || 'Errore interno' }, { status: 500 })
       }
     ```
     diventa:
     ```ts
       } catch (err) {
         return rispostaErroreInterno(OPERAZIONE, err)
       }
     ```

- [ ] **Passo 5: `iscrizione/sedi/route.ts`.**
  1. Dopo la riga 8 (`import { intestazioniCachePubblica } from '@/lib/security/cache-pubblica'`) aggiungi:
     ```ts
     import { rispostaGuastoGiaRegistrato } from '@/lib/db/guasto'
     ```
  2. La riga 55
     ```ts
         return NextResponse.json({ error: error.message }, { status: 500 })
     ```
     diventa:
     ```ts
         return rispostaGuastoGiaRegistrato()
     ```

- [ ] **Passo 6: sono verdi, e l'iscrizione di sempre pure.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/api/iscrizione-errori-con-codice.test.ts \
    __tests__/api/iscrizione-sedi.test.ts __tests__/api/iscrizione.test.ts __tests__/api/iscrizione-model-anonima.test.ts
  ```
  Atteso: `Test Files  4 passed (4)`.

- [ ] **Passo 7: il lock ora vede 5 righe, non 9.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/architecture/porte-anonime-senza-errori-interni.test.ts
  ```
  Atteso: rosso con le sole righe di `forms/submit/route.ts` (4) e `public/forms/[token]/submit/route.ts` (1).

- [ ] **Passo 8: commit.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && git add src/app/api/iscrizione/route.ts src/app/api/iscrizione/sedi/route.ts \
    __tests__/api/iscrizione-errori-con-codice.test.ts __tests__/api/iscrizione-sedi.test.ts
  git commit -m "Iscrizione: i guasti rispondono con un codice, e l'inserimento fallito lascia una riga di log" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Compito 6: `/api/forms/submit` e `/api/public/forms/[token]/submit`

**File:**
- Modifica: `src/app/api/forms/submit/route.ts:15, 83, 116, 158-161, 202-206`
- Modifica: `src/app/api/public/forms/[token]/submit/route.ts:12`, il 500 della lettura del modello, il 500 dell'invio, il `catch`
- Modifica: `__tests__/api/forms-submit.test.ts:5-10, 21-39, 62-68` e una `describe` nuova in fondo
- Modifica: `__tests__/api/public-forms-submit.test.ts:4-7, 13-25, 53-57` e tre test nuovi in fondo
- Aggiunge al commit: `__tests__/architecture/porte-anonime-senza-errori-interni.test.ts` (Compito 4)

- [ ] **Passo 1: `forms-submit.test.ts`, il doppio sa guastarsi.**
  1. Sostituisci le righe 5-10 (il blocco `h`) con:
     ```ts
     const h = vi.hoisted(() => ({
       model: null as Record<string, unknown> | null,
       inserts: [] as Record<string, unknown>[],
       insertError: null as unknown,
       sospensione: null as unknown, // NextResponse se sospeso, null altrimenti
       modelError: null as unknown,
       utenteError: null as unknown,
       adminLancia: false,
     }))
     ```
  2. Sostituisci le righe 21-39 (il `vi.mock` di `server-client`) con:
     ```ts
     vi.mock('@/lib/supabase/server-client', () => ({
       createAdminClient: async () => {
         if (h.adminLancia) throw new Error('chiave di servizio assente: dettaglio interno')
         return {
           from: (table: string) => {
             const b: Record<string, unknown> = {}
             b.select = () => b
             b.eq = () => b
             // `utenti`: chi compila ha una sede — è la condizione di TUTTI i 51 utenti
             // in produzione, ed è la prima fonte da cui la compilazione prende la
             // propria `scuola_id` (una riga senza sede non la vedrebbe più nessuno).
             b.maybeSingle = async () => ({
               data: table === 'form_models' ? h.model : table === 'utenti' ? { scuola_id: 'sc-1' } : null,
               error: table === 'form_models' ? h.modelError : table === 'utenti' ? h.utenteError : null,
             })
             b.single = async () => ({ data: { id: 'sub-new' }, error: h.insertError })
             b.insert = (row: Record<string, unknown>) => { h.inserts.push(row); return b }
             return b
           },
         }
       },
     }))
     ```
  3. Sostituisci il `beforeEach` (righe 62-68) con:
     ```ts
     beforeEach(() => {
       vi.clearAllMocks()
       h.model = modelloConConsenso
       h.inserts = []
       h.insertError = null
       h.sospensione = null
       h.modelError = null
       h.utenteError = null
       h.adminLancia = false
     })
     ```
  4. In fondo al file aggiungi:
     ```ts
     describe('POST /api/forms/submit — un guasto risponde con un codice, mai con il testo di Postgres', () => {
       const corpo = {
         modelId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10',
         userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11',
         data: { nome: 'Marco', privacy: true },
       }

       it('modello non letto → 500 LETTURA_FALLITA, nessun inserimento', async () => {
         h.modelError = { code: '57014', message: 'canceling statement due to statement timeout' }
         const res = await POST(req(corpo))
         expect(res.status).toBe(500)
         const json = await res.json()
         expect(json.codice).toBe('LETTURA_FALLITA')
         expect(JSON.stringify(json)).not.toContain('statement timeout')
         expect(h.inserts).toHaveLength(0)
       })

       it('utente non letto → 500 LETTURA_FALLITA', async () => {
         h.utenteError = { code: '57014', message: 'canceling statement due to statement timeout' }
         const res = await POST(req(corpo))
         expect(res.status).toBe(500)
         const json = await res.json()
         expect(json.codice).toBe('LETTURA_FALLITA')
         expect(JSON.stringify(json)).not.toContain('statement timeout')
       })

       it('compilazione non registrata → 500 SCRITTURA_FALLITA', async () => {
         h.insertError = { code: '23505', message: 'duplicate key value violates unique constraint "form_submissions_pkey"' }
         const res = await POST(req(corpo))
         expect(res.status).toBe(500)
         const json = await res.json()
         expect(json.codice).toBe('SCRITTURA_FALLITA')
         expect(JSON.stringify(json)).not.toContain('duplicate key')
       })

       it('eccezione → 500 ERRORE_INTERNO, il messaggio solo nel log', async () => {
         h.adminLancia = true
         const res = await POST(req(corpo))
         expect(res.status).toBe(500)
         const json = await res.json()
         expect(json.codice).toBe('ERRORE_INTERNO')
         expect(JSON.stringify(json)).not.toContain('dettaglio interno')
       })
     })
     ```

- [ ] **Passo 2: `public-forms-submit.test.ts`, la stessa cosa per l'invio anonimo.**
  1. Sostituisci le righe 4-7 con:
     ```ts
     const h = vi.hoisted(() => ({
       model: null as Record<string, unknown> | null,
       inserts: [] as Record<string, unknown>[],
       modelError: null as unknown,
       insertError: null as unknown,
       adminLancia: false,
     }))
     ```
  2. Sostituisci le righe 13-25 con:
     ```ts
     vi.mock('@/lib/supabase/server-client', () => ({
       createAdminClient: async () => {
         if (h.adminLancia) throw new Error('chiave di servizio assente: dettaglio interno')
         return {
           from: () => {
             const b: Record<string, unknown> = {}
             b.select = () => b
             b.eq = () => b
             b.maybeSingle = async () => ({ data: h.model, error: h.modelError })
             b.insert = (row: Record<string, unknown>) => { h.inserts.push(row); return b }
             b.single = async () => ({ data: h.insertError ? null : { id: 'sub-pub' }, error: h.insertError })
             return b
           },
         }
       },
     }))
     ```
  3. Sostituisci il `beforeEach` (righe 53-57) con:
     ```ts
     beforeEach(() => {
       vi.clearAllMocks()
       h.model = pubModel
       h.inserts = []
       h.modelError = null
       h.insertError = null
       h.adminLancia = false
     })
     ```
  4. Dentro la `describe`, dopo il test `201 inserisce completed + consents_log (user_id null)`, aggiungi:
     ```ts
       it('lettura del modello fallita → 500 LETTURA_FALLITA, senza il testo di Postgres', async () => {
         h.modelError = { code: '57014', message: 'canceling statement due to statement timeout' }
         const res = await POST(req({ data: { privacy: true } }), ctx(TOKEN))
         expect(res.status).toBe(500)
         const json = await res.json()
         expect(json.codice).toBe('LETTURA_FALLITA')
         expect(JSON.stringify(json)).not.toContain('statement timeout')
       })

       it('invio non registrato → 500 SCRITTURA_FALLITA', async () => {
         h.insertError = { code: '23505', message: 'duplicate key value violates unique constraint "form_submissions_pkey"' }
         const res = await POST(req({ data: { privacy: true } }), ctx(TOKEN))
         expect(res.status).toBe(500)
         const json = await res.json()
         expect(json.codice).toBe('SCRITTURA_FALLITA')
         expect(JSON.stringify(json)).not.toContain('duplicate key')
       })

       it('eccezione → 500 ERRORE_INTERNO, il messaggio solo nel log', async () => {
         h.adminLancia = true
         const res = await POST(req({ data: { privacy: true } }), ctx(TOKEN))
         expect(res.status).toBe(500)
         const json = await res.json()
         expect(json.codice).toBe('ERRORE_INTERNO')
         expect(JSON.stringify(json)).not.toContain('dettaglio interno')
       })
     ```

- [ ] **Passo 3: sono rossi.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/api/forms-submit.test.ts __tests__/api/public-forms-submit.test.ts
  ```
  Atteso:
  - 4 FAIL nella `describe` nuova di `forms-submit` e 3 FAIL nei test nuovi di `public-forms-submit`, tutti su
    `expected undefined to be '…'`;
  - i test di prima restano verdi.

- [ ] **Passo 4: `forms/submit/route.ts`.**
  1. La riga 15
     ```ts
     import { logErrore, logEvento } from '@/lib/logging/logger'
     ```
     diventa:
     ```ts
     import { logEvento } from '@/lib/logging/logger'
     import { rispostaGuastoGiaRegistrato } from '@/lib/db/guasto'
     import { rispostaErroreInterno } from '@/lib/api/errore-interno'
     ```
  2. La riga 83
     ```ts
           return NextResponse.json({ error: modelRes.error.message }, { status: 500 })
     ```
     diventa:
     ```ts
           return rispostaGuastoGiaRegistrato()
     ```
  3. La riga 116
     ```ts
             return NextResponse.json({ error: erroreUtente.message }, { status: 500 })
     ```
     diventa:
     ```ts
             return rispostaGuastoGiaRegistrato()
     ```
  4. Le righe 158-161
     ```ts
           return NextResponse.json(
             { error: insertErr instanceof Error ? insertErr.message : 'Creazione submission fallita' },
             { status: 500 }
           )
     ```
     diventano:
     ```ts
           return rispostaGuastoGiaRegistrato('scrittura')
     ```
  5. Il `catch` (righe 201-207)
     ```ts
       } catch (err) {
         logErrore({ operazione: 'forms/submit:POST', stato: 500 }, err)
         return NextResponse.json(
           { error: err instanceof Error ? err.message : 'Errore interno' },
           { status: 500 }
         )
       }
     ```
     diventa:
     ```ts
       } catch (err) {
         return rispostaErroreInterno('forms/submit:POST', err)
       }
     ```

- [ ] **Passo 5: `public/forms/[token]/submit/route.ts`.**
  1. La riga 12
     ```ts
     import { logErrore, logEvento } from '@/lib/logging/logger'
     ```
     diventa:
     ```ts
     import { logEvento } from '@/lib/logging/logger'
     import { rispostaGuastoGiaRegistrato } from '@/lib/db/guasto'
     import { rispostaErroreInterno } from '@/lib/api/errore-interno'
     ```
  2. La lettura del modello. La riga `modello-non-letto` è scritta subito sopra:
     ```ts
           return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
     ```
     diventa:
     ```ts
           return rispostaGuastoGiaRegistrato()
     ```
  3. L'invio. Anche qui `compilazione-non-registrata` è già scritta subito sopra:
     ```ts
           return NextResponse.json({ error: 'Invio fallito' }, { status: 500 })
     ```
     diventa:
     ```ts
           return rispostaGuastoGiaRegistrato('scrittura')
     ```
  4. Il `catch`:
     ```ts
       } catch (err) {
         logErrore({ operazione: 'public/forms/[token]/submit:POST', stato: 500 }, err)
         return NextResponse.json(
           { error: err instanceof Error ? err.message : 'Errore interno' },
           { status: 500 }
         )
       }
     ```
     diventa:
     ```ts
       } catch (err) {
         return rispostaErroreInterno('public/forms/[token]/submit:POST', err)
       }
     ```

- [ ] **Passo 6: tutto verde, lock compreso.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/api/forms-submit.test.ts __tests__/api/public-forms-submit.test.ts \
    __tests__/api/public-forms-token-malformato.test.ts __tests__/architecture/porte-anonime-senza-errori-interni.test.ts \
    __tests__/architecture/logging-coverage.test.ts __tests__/architecture/errori-con-codice.test.ts
  ```
  Atteso: `Test Files  6 passed (6)`. Il lock delle porte anonime ora è verde: 0 fughe su 23 porte.

- [ ] **Passo 7: commit.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && git add src/app/api/forms/submit/route.ts 'src/app/api/public/forms/[token]/submit/route.ts' \
    __tests__/api/forms-submit.test.ts __tests__/api/public-forms-submit.test.ts \
    __tests__/architecture/porte-anonime-senza-errori-interni.test.ts
  git commit -m "Moduli pubblici: guasti con codice, e un lock che vieta il message di un errore sulle porte anonime" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Compito 7: `/api/notes` — il `catch` muto e i quattro 500

**File:**
- Modifica: `src/app/api/notes/route.ts:10, 75-78, 82-85, 139-142, 155, 159-162`
- Crea: `__tests__/api/notes-errori-e-notifica.test.ts`

Il lock `logging-coverage` vuole che una route con un `catch` vero nomini `logErrore(` o `logEvento(` nel codice
(`__tests__/architecture/logging-coverage.test.ts:136-142`). Qui le chiamate passano da `rispostaGuastoDb` e
`rispostaErroreInterno`, quindi il `catch` della notifica usa `logEvento` direttamente e non `guastoSecondario`. Se
non lo facesse, il lock segnerebbe `notes/route.ts` come muta.

- [ ] **Passo 1: il test rosso.** Crea `__tests__/api/notes-errori-e-notifica.test.ts`:
  ```ts
  // @vitest-environment node
  import { describe, it, expect, vi, beforeEach } from 'vitest'
  import { NextRequest } from 'next/server'

  /**
   * `/api/notes` — le note disciplinari. Il 20/10 la notifica ai genitori falliva in un `catch { /* non bloccare *\/ }`
   * senza lasciare traccia, e i 500 mandavano `details: error.message` al client.
   */

  const h = vi.hoisted(() => ({
    lettura: { data: [] as unknown[] | null, error: null as unknown },
    scrittura: { data: [{ id: 'n1' }] as unknown[] | null, error: null as unknown },
    notifica: null as unknown,
    adminLancia: false,
    logEvento: vi.fn(),
    logErrore: vi.fn(),
  }))

  vi.mock('@/lib/logging/logger', async (importOriginal) => {
    const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
    return {
      ...vero,
      logEvento: (...a: unknown[]) => h.logEvento(...a),
      logErrore: (...a: unknown[]) => h.logErrore(...a),
    }
  })
  vi.mock('@/lib/auth/require-staff', async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    requireDocente: async () => ({ user: { id: 'ed1', role: 'educator', scuola_id: 'sc-1' } }),
  }))
  vi.mock('@/lib/auth/scope', async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    assertAlunnoInScope: async () => null,
    resolveScuoleAttive: async () => ['sc-1'],
    sezioniVisibili: async () => null,
  }))
  vi.mock('@/lib/primaria/notifiche', () => ({
    enqueueNotifichePerAlunni: async () => {
      if (h.notifica) throw h.notifica
    },
  }))
  vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => {
      if (h.adminLancia) throw new Error('chiave di servizio assente: dettaglio interno')
      return {
        from: () => {
          let esito: unknown = h.lettura
          const b: Record<string, unknown> = {}
          b.select = () => b
          b.in = () => b
          b.eq = () => b
          b.order = () => b
          b.insert = () => { esito = h.scrittura; return b }
          b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(esito).then(ok, ko)
          return b
        },
      }
    },
  }))

  import { GET, POST } from '@/app/api/notes/route'

  const ALUNNO = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
  const nota = { alunnoIds: [ALUNNO], categoria: 'comportamento', testo: 'Testo di prova', richiedeFirma: false }
  const post = (corpo: unknown) =>
    new NextRequest('http://localhost/api/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo),
    })

  beforeEach(() => {
    vi.clearAllMocks()
    h.lettura = { data: [], error: null }
    h.scrittura = { data: [{ id: 'n1' }], error: null }
    h.notifica = null
    h.adminLancia = false
  })

  describe('/api/notes — guasti con codice, notifica non accodata registrata', () => {
    it('POST: nota scritta, notifica ai genitori fallita → 200, e una riga `notifica` a livello error', async () => {
      const guasto = new Error('coda notifiche irraggiungibile')
      h.notifica = guasto
      const res = await POST(post(nota))
      expect(res.status).toBe(200)
      expect(h.logEvento).toHaveBeenCalledWith('notifica', 'error', {
        operazione: 'notes:POST',
        esito: 'notifica-genitori-non-accodata',
      }, guasto)
    })

    it('POST: scrittura fallita → 500 SCRITTURA_FALLITA, senza il testo di Postgres', async () => {
      h.scrittura = { data: null, error: { code: '23503', message: 'insert or update on table "note_disciplinari" violates foreign key constraint' } }
      const res = await POST(post(nota))
      expect(res.status).toBe(500)
      const corpo = await res.json()
      expect(corpo.codice).toBe('SCRITTURA_FALLITA')
      expect(JSON.stringify(corpo)).not.toContain('foreign key')
    })

    it('GET: lettura fallita → 500 LETTURA_FALLITA, senza `details`', async () => {
      h.lettura = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
      const res = await GET(new NextRequest(`http://localhost/api/notes?alunnoId=${ALUNNO}`))
      expect(res.status).toBe(500)
      const corpo = await res.json()
      expect(corpo.codice).toBe('LETTURA_FALLITA')
      expect(corpo.details).toBeUndefined()
      expect(JSON.stringify(corpo)).not.toContain('statement timeout')
    })

    it('eccezione → 500 ERRORE_INTERNO, il messaggio solo nel log', async () => {
      h.adminLancia = true
      const res = await POST(post(nota))
      expect(res.status).toBe(500)
      const corpo = await res.json()
      expect(corpo.codice).toBe('ERRORE_INTERNO')
      expect(JSON.stringify(corpo)).not.toContain('dettaglio interno')
      expect(h.logErrore).toHaveBeenCalledWith(
        expect.objectContaining({ operazione: 'notes:POST', stato: 500 }),
        expect.any(Error),
      )
    })
  })
  ```

- [ ] **Passo 2: è rosso.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/api/notes-errori-e-notifica.test.ts
  ```
  Atteso: 4 FAIL. Il primo per `logEvento` mai chiamato; gli altri per `expected undefined to be '…'`.

- [ ] **Passo 3: il codice.** In `src/app/api/notes/route.ts` (punto e virgola, rientro di 4):
  1. La riga 10
     ```ts
     import { logErrore } from '@/lib/logging/logger';
     ```
     diventa:
     ```ts
     import { logEvento } from '@/lib/logging/logger';
     import { rispostaGuastoDb } from '@/lib/db/guasto';
     import { rispostaErroreInterno } from '@/lib/api/errore-interno';
     ```
  2. Righe 75-78:
     ```ts
             if (error) {
                 logErrore({ operazione: 'notes:GET', stato: 500, evento: 'db' }, error);
                 return NextResponse.json({ error: 'Errore nel recupero delle note', details: error.message }, { status: 500 });
             }
     ```
     diventano:
     ```ts
             // Il testo di PostgREST resta nel log: nella risposta c'era come `details`.
             if (error) return rispostaGuastoDb('notes:GET', 'db:note_disciplinari', error);
     ```
  3. Righe 82-85:
     ```ts
         } catch (error) {
             logErrore({ operazione: 'notes:GET', stato: 500 }, error);
             return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
         }
     ```
     diventano:
     ```ts
         } catch (error) {
             return rispostaErroreInterno('notes:GET', error);
         }
     ```
  4. Righe 139-142:
     ```ts
             if (dbError) {
                 logErrore({ operazione: 'notes:POST', stato: 500, evento: 'db' }, dbError);
                 return NextResponse.json({ error: 'Errore nel salvataggio della nota', details: dbError.message }, { status: 500 });
             }
     ```
     diventano:
     ```ts
             if (dbError) return rispostaGuastoDb('notes:POST', 'db:note_disciplinari', dbError, 'scrittura');
     ```
  5. Riga 155:
     ```ts
             } catch { /* non bloccare */ }
     ```
     diventa:
     ```ts
             } catch (e) {
                 // La nota è scritta: rispondere 500 inviterebbe a scriverla due volte. Ma i genitori non la
                 // vedranno arrivare, e fino al 20/10 nessuno lo sapeva: il catch era muto.
                 logEvento('notifica', 'error', {
                     operazione: 'notes:POST',
                     esito: 'notifica-genitori-non-accodata',
                 }, e);
             }
     ```
  6. Righe 159-162:
     ```ts
         } catch (error) {
             logErrore({ operazione: 'notes:POST', stato: 500 }, error);
             return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
         }
     ```
     diventano:
     ```ts
         } catch (error) {
             return rispostaErroreInterno('notes:POST', error);
         }
     ```

- [ ] **Passo 4: è verde, e i test di prima pure.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/api/notes-errori-e-notifica.test.ts \
    __tests__/api/note-voti-scope-sede.test.ts __tests__/api/p0-gates.test.ts __tests__/architecture/logging-coverage.test.ts
  ```
  Atteso: `Test Files  4 passed (4)`.
  - Se `p0-gates.test.ts` non esiste con quel nome, si trova con
    `grep -rln "api/notes/route" __tests__ | head` e si lancia quello.

- [ ] **Passo 5: commit.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && git add src/app/api/notes/route.ts __tests__/api/notes-errori-e-notifica.test.ts
  git commit -m "Note disciplinari: la notifica ai genitori non accodata lascia una riga, i 500 hanno un codice" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Compito 8: certificati delle competenze — l'URL firmato con `error`

**File:**
- Modifica: `src/app/api/parent/competenze/route.ts:8-9, 47-48, 53-57`
- Modifica: `src/app/api/admin/competenze/download/route.ts:9-10, 45-46, 48-52`
- Crea: `__tests__/api/competenze-url-firmato-guasto.test.ts`

- [ ] **Passo 1: il test rosso.** Crea `__tests__/api/competenze-url-firmato-guasto.test.ts`:
  ```ts
  // @vitest-environment node
  import { describe, it, expect, vi, beforeEach } from 'vitest'

  /**
   * Il link a un certificato delle competenze nasce da `createSignedUrl`, che non lancia: risponde
   * `{ data: null, error }`. Fino al 20/10 il guasto spariva in un `?? null` (genitore) o in un 500 senza codice
   * e senza log (segreteria).
   */

  const h = vi.hoisted(() => ({
    cert: 'c0000000-0000-4000-8000-0000000000c1',
    firma: { data: null as { signedUrl: string } | null, error: null as unknown },
    adminLancia: false,
    logEvento: vi.fn(),
    logErrore: vi.fn(),
  }))

  vi.mock('@/lib/logging/logger', async (importOriginal) => {
    const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
    return {
      ...vero,
      logEvento: (...a: unknown[]) => h.logEvento(...a),
      logErrore: (...a: unknown[]) => h.logErrore(...a),
    }
  })
  vi.mock('@/lib/auth/require-staff', async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    requireStaff: async () => ({ user: { id: 'st1', role: 'admin', scuola_id: 'sc-1' } }),
  }))
  vi.mock('@/lib/auth/require-parent', () => ({
    requireParentOfStudent: async () => ({ user: { id: 'par1' } }),
  }))
  vi.mock('@/lib/auth/scope', async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    assertSezioneInScope: async () => null,
  }))
  vi.mock('@/lib/competenze/certificato-store', () => ({ CERTIFICATI_BUCKET: 'certificati-competenze' }))
  vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => {
      if (h.adminLancia) throw new Error('chiave di servizio assente: dettaglio interno')
      return {
        storage: { from: () => ({ createSignedUrl: async () => h.firma }) },
        from: () => {
          const q: Record<string, unknown> = {}
          q.select = () => q
          q.eq = () => q
          q.in = () => q
          q.order = () => q
          q.maybeSingle = async () => ({ data: { file_url: 'c1.pdf', section_id: 'sez1' }, error: null })
          q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
            Promise.resolve({
              data: [{ id: h.cert, stato: 'firmato', anno_scolastico: '2025/26', file_url: 'c1.pdf' }],
              error: null,
            }).then(ok, ko)
          return q
        },
      }
    },
  }))

  import { GET as GENITORE } from '@/app/api/parent/competenze/route'
  import { GET as SEGRETERIA } from '@/app/api/admin/competenze/download/route'

  const FRASE = 'Si è verificato un errore imprevisto. Riprova fra poco.'
  const guastoFirma = { name: 'StorageApiError', message: 'Object not found', status: 400 }
  const reqGenitore = () => new Request('http://localhost/api/parent/competenze?studentId=al1&userId=par1') as never
  const reqSegreteria = () =>
    new Request(`http://localhost/api/admin/competenze/download?certificatoId=${h.cert}`) as never

  beforeEach(() => {
    vi.clearAllMocks()
    h.firma = { data: null, error: guastoFirma }
    h.adminLancia = false
  })

  describe('certificati delle competenze — l’URL firmato che non si crea lascia una riga', () => {
    it('genitore: il certificato resta in elenco senza link, e il guasto è registrato', async () => {
      const res = await GENITORE(reqGenitore())
      expect(res.status).toBe(200)
      const corpo = await res.json()
      expect(corpo.data).toEqual([{ id: h.cert, anno: '2025/26', stato: 'firmato', downloadUrl: null }])
      expect(h.logEvento).toHaveBeenCalledWith('storage', 'error', {
        operazione: 'parent/competenze:GET',
        esito: 'url-firmato-non-creato',
        entita_id: h.cert,
      }, guastoFirma)
    })

    it('segreteria: 500 ERRORE_INTERNO, e il guasto è registrato', async () => {
      const res = await SEGRETERIA(reqSegreteria())
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: FRASE, codice: 'ERRORE_INTERNO' })
      expect(h.logEvento).toHaveBeenCalledWith('storage', 'error', {
        operazione: 'admin/competenze/download:GET',
        esito: 'url-firmato-non-creato',
        entita_id: h.cert,
      }, guastoFirma)
    })

    it('genitore: un’eccezione risponde ERRORE_INTERNO, il messaggio solo nel log', async () => {
      h.adminLancia = true
      const res = await GENITORE(reqGenitore())
      expect(res.status).toBe(500)
      const corpo = await res.json()
      expect(corpo.codice).toBe('ERRORE_INTERNO')
      expect(JSON.stringify(corpo)).not.toContain('dettaglio interno')
      expect(h.logErrore).toHaveBeenCalledWith(
        expect.objectContaining({ operazione: 'parent/competenze:GET', stato: 500 }),
        expect.any(Error),
      )
    })

    it('segreteria: un’eccezione risponde ERRORE_INTERNO, il messaggio solo nel log', async () => {
      h.adminLancia = true
      const res = await SEGRETERIA(reqSegreteria())
      expect(res.status).toBe(500)
      const corpo = await res.json()
      expect(corpo.codice).toBe('ERRORE_INTERNO')
      expect(JSON.stringify(corpo)).not.toContain('dettaglio interno')
    })
  })
  ```

- [ ] **Passo 2: è rosso.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/api/competenze-url-firmato-guasto.test.ts
  ```
  Atteso: 4 FAIL.
  - Genitore: `logEvento` mai chiamato con `storage`.
  - Segreteria: corpo `{ error: 'URL non disponibile' }`.
  - I due `catch`: `expected undefined to be 'ERRORE_INTERNO'`.

- [ ] **Passo 3: `parent/competenze/route.ts`.**
  1. Le righe 8-9
     ```ts
     import { logErrore } from '@/lib/logging/logger'
     import { rispostaGuastoDb } from '@/lib/db/guasto'
     ```
     diventano:
     ```ts
     import { logEvento } from '@/lib/logging/logger'
     import { rispostaGuastoDb } from '@/lib/db/guasto'
     import { rispostaErroreInterno } from '@/lib/api/errore-interno'
     ```
  2. Le righe 47-48
     ```ts
             const { data: signed } = await supabase.storage.from(CERTIFICATI_BUCKET).createSignedUrl(c.file_url, 600)
             downloadUrl = signed?.signedUrl ?? null
     ```
     diventano:
     ```ts
             const { data: signed, error: erroreFirma } = await supabase.storage.from(CERTIFICATI_BUCKET).createSignedUrl(c.file_url, 600)
             // Un link che non si firma non toglie il certificato dall'elenco: il genitore lo vede senza il pulsante
             // di download, e la riga dice perché. Fino al 20/10 il guasto spariva in questo `?? null`.
             if (erroreFirma) {
               logEvento('storage', 'error', {
                 operazione: 'parent/competenze:GET',
                 esito: 'url-firmato-non-creato',
                 entita_id: c.id,
               }, erroreFirma)
             }
             downloadUrl = signed?.signedUrl ?? null
     ```
  3. Il `catch` (righe 53-57)
     ```ts
       } catch (err) {
         logErrore({ operazione: 'parent/competenze:GET', stato: 500 }, err)
         const msg = err instanceof Error ? err.message : 'Errore interno'
         return NextResponse.json({ error: msg }, { status: 500 })
       }
     ```
     diventa:
     ```ts
       } catch (err) {
         return rispostaErroreInterno('parent/competenze:GET', err)
       }
     ```

- [ ] **Passo 4: `admin/competenze/download/route.ts`.**
  1. Le righe 9-10
     ```ts
     import { logErrore } from '@/lib/logging/logger'
     import { rispostaGuastoDb } from '@/lib/db/guasto'
     ```
     diventano:
     ```ts
     import { logEvento } from '@/lib/logging/logger'
     import { rispostaGuastoDb } from '@/lib/db/guasto'
     import { rispostaErroreInterno, rispostaErroreInternoGiaRegistrato } from '@/lib/api/errore-interno'
     ```
  2. Le righe 45-46
     ```ts
         const { data: signed } = await supabase.storage.from(CERTIFICATI_BUCKET).createSignedUrl(cert.file_url, 600)
         if (!signed?.signedUrl) return NextResponse.json({ error: 'URL non disponibile' }, { status: 500 })
     ```
     diventano:
     ```ts
         const { data: signed, error: erroreFirma } = await supabase.storage.from(CERTIFICATI_BUCKET).createSignedUrl(cert.file_url, 600)
         if (erroreFirma || !signed?.signedUrl) {
           logEvento('storage', 'error', {
             operazione: 'admin/competenze/download:GET',
             esito: 'url-firmato-non-creato',
             entita_id: certificatoId,
           }, erroreFirma)
           return rispostaErroreInternoGiaRegistrato()
         }
     ```
  3. Il `catch` (righe 48-52)
     ```ts
       } catch (err) {
         logErrore({ operazione: 'admin/competenze/download:GET', stato: 500 }, err)
         const msg = err instanceof Error ? err.message : 'Errore interno'
         return NextResponse.json({ error: msg }, { status: 500 })
       }
     ```
     diventa:
     ```ts
       } catch (err) {
         return rispostaErroreInterno('admin/competenze/download:GET', err)
       }
     ```

- [ ] **Passo 5: è verde, e i test di prima pure.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/api/competenze-url-firmato-guasto.test.ts __tests__/api/competenze-route.test.ts
  ```
  Atteso: `Test Files  2 passed (2)`.

- [ ] **Passo 6: commit.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && git add src/app/api/parent/competenze/route.ts src/app/api/admin/competenze/download/route.ts \
    __tests__/api/competenze-url-firmato-guasto.test.ts
  git commit -m "Certificati delle competenze: l'URL firmato non riuscito lascia una riga, i 500 hanno un codice" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Compito 9: `listBuckets()` con `error`, e lo Storage nel lock di PostgREST

**File:**
- Modifica: `__tests__/architecture/errori-postgrest-guardati.test.ts:13-31, 44-55, 92-121`
- Modifica: `src/app/api/primaria/allegati/route.ts:187, 196`, `src/app/api/primaria/fascicolo/route.ts:176-179`,
  `src/lib/cassa/store.ts:22-23`, `src/lib/competenze/certificato-store.ts:239-240`,
  `src/lib/primaria/pagella-store.ts:198-199`, `src/lib/protocolli/store.ts:104-105, 110-112`
- Crea: `__tests__/lib/storage-elenco-bucket-guasto.test.ts`

I numeri di riga sono quelli del 20/10. Prima di questa sessione la 3 cambia `pathDefinitivi` in
`src/lib/protocolli/store.ts` (sopra `ensureBucket`: le righe 104-112 scendono) e la 10 cambia `persistPagella` in
`src/lib/primaria/pagella-store.ts`. Ogni sostituzione qui sotto si fa sul **testo** citato: in `protocolli/store.ts`
la riga `const { data } = await supabase.storage.listBuckets()` dentro `export async function ensureBucket` e il
`catch` col commento `// corsa fra richieste parallele o bucket già esistente: ignorato`; in `pagella-store.ts` la
riga `const { data: buckets } = await supabase.storage.listBuckets()` dentro `export async function persistPagella`.
Mai sul solo numero.

Senza l'elenco dei bucket non si sa se il bucket c'è. Oggi `data` è `null`, `buckets?.some(…)` dà `undefined`, e il
codice crea il bucket alla cieca (o, negli allegati, salta il controllo che lo rende privato). D'ora in poi si logga a
livello `warn` con `esito: 'bucket_non_verificato'`, lo stesso già usato dal `catch` degli allegati e del fascicolo, e
non si crea niente. Se il bucket manca davvero, è il caricamento a valle a fallire, col suo errore e la sua riga.

- [ ] **Passo 1: la quinta forma nel lock (rossa).** In `__tests__/architecture/errori-postgrest-guardati.test.ts`:
  1. Nella testata, la riga 13
     ```ts
      * Quattro forme vietate:
     ```
     diventa
     ```ts
      * Cinque forme vietate:
     ```
     e dopo la riga 18 (`   *   4. \`.catch(() => {})\` — idem.`) aggiungi:
     ```ts
      *   5. `const { data } = await <client>.storage…` — lo Storage col solo `data` (sessione 13 della seconda serie:
      *      il 20/10 erano 8, due URL firmati e sei `listBuckets()`). Lo Storage non è PostgREST, ma non lancia
      *      nemmeno lui: risponde `{ data: null, error }`.
     ```
  2. Le righe 30-31
     ```ts
      *   · lo Storage (`<client>.storage.from(…)`) — non è PostgREST, e ha la sua gestione.
      */
     ```
     diventano:
     ```ts
      *   · il risultato BUTTATO di una chiamata dello Storage (`await s.storage.createBucket(…)` come istruzione): la
      *     forma 2 guarda solo `from`/`rpc`. Lo Storage col solo `data` è invece la forma 5.
      */
     ```
  3. In `FORME`, dopo la riga `  { nome: 'catch-muto', re: /\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/g },` aggiungi:
     ```ts
       {
         nome: 'storage-senza-error',
         re: /(?:const|let)\s*\{\s*(?:data|count)(?:\s*:\s*\w+)?(?:\s*,\s*(?:data|count)(?:\s*:\s*\w+)?)?\s*\}\s*=\s*await\s+\w+\s*\.\s*storage\b/g,
       },
     ```
  4. Il test `riconosce ognuna delle quattro forme, e lascia passare quelle corrette` diventa:
     ```ts
       it('riconosce ognuna delle cinque forme, e lascia passare quelle corrette', () => {
         const rotto = [
           "const { data } = await supabase.from('alunni').select('id')",
           "const { data: righe } = await admin.from('x').select('id')",
           "const { count } = await s.from('x').select('id', { count: 'exact', head: true })",
           "let { data } = await db.rpc('f')",
           "  await supabase.from('x').update({ a: 1 }).eq('id', id)",
           "  await admin.rpc('f', {})",
           'p.then(() => {}, () => {})',
           'p.then(() => undefined, () => undefined)',
           'p.catch(() => {})',
           "const { data } = await supabase.storage.from('b').download('p')",
         ].join('\n')
         expect(violazioni(rotto).map((v) => v.forma)).toEqual([
           'data-senza-error',
           'data-senza-error',
           'data-senza-error',
           'data-senza-error',
           'risultato-buttato',
           'risultato-buttato',
           'then-muto',
           'then-muto',
           'catch-muto',
           'storage-senza-error',
         ])
         const giusto = [
           "const { data, error } = await supabase.from('alunni').select('id')",
           "const { data, error } = await supabase.storage.from('b').download('p')",
           "const { data: buckets, error: erroreElenco } = await supabase.storage.listBuckets()",
           "const { error } = await supabase.from('x').update({ a: 1 })",
           "// const { data } = await supabase.from('x') — un commento non conta",
           "p.catch((err) => logErrore({ operazione: 'x' }, err))",
         ].join('\n')
         expect(violazioni(giusto)).toEqual([])
       })
     ```

- [ ] **Passo 2: il test degli store (rosso).** Crea `__tests__/lib/storage-elenco-bucket-guasto.test.ts`:
  ```ts
  // @vitest-environment node
  import { describe, it, expect, vi, beforeEach } from 'vitest'
  import type { SupabaseClient } from '@supabase/supabase-js'

  /**
   * `listBuckets()` non lancia: risponde `{ data: null, error }`. Fino al 20/10 quel `null` voleva dire «il bucket
   * non c'è», e lo si creava alla cieca senza una riga che dicesse che l'elenco non era arrivato.
   */

  const h = vi.hoisted(() => ({ logEvento: vi.fn() }))

  vi.mock('@/lib/logging/logger', async (importOriginal) => {
    const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
    return { ...vero, logEvento: (...a: unknown[]) => h.logEvento(...a) }
  })

  import { ensureCassaBucket, CASSA_BUCKET } from '@/lib/cassa/store'
  import { ensureBucket, PROTOCOLLO_BUCKET } from '@/lib/protocolli/store'

  function client(elenco: { data: { name: string }[] | null; error: unknown }) {
    const listBuckets = vi.fn(async () => elenco)
    const createBucket = vi.fn(async () => ({ data: null, error: null }))
    return { sb: { storage: { listBuckets, createBucket } } as unknown as SupabaseClient, createBucket }
  }

  beforeEach(() => vi.clearAllMocks())

  describe.each([
    { nome: 'ensureCassaBucket', garantisci: ensureCassaBucket, bucket: CASSA_BUCKET, operazione: 'ensureCassaBucket' },
    { nome: 'ensureBucket dei protocolli', garantisci: ensureBucket, bucket: PROTOCOLLO_BUCKET, operazione: 'protocolli/store:ensureBucket' },
  ])('$nome — l’elenco non riuscito non diventa «bucket assente»', ({ garantisci, bucket, operazione }) => {
    it('elenco in errore: nessuna creazione alla cieca, una riga `warn` col motivo', async () => {
      const guasto = { name: 'StorageApiError', message: 'Gateway Timeout', status: 504 }
      const { sb, createBucket } = client({ data: null, error: guasto })
      await garantisci(sb)
      expect(createBucket).not.toHaveBeenCalled()
      expect(h.logEvento).toHaveBeenCalledWith('storage', 'warn', {
        operazione,
        bucket,
        esito: 'bucket_non_verificato',
      }, guasto)
    })

    it('bucket presente: niente da fare, nessuna riga', async () => {
      const { sb, createBucket } = client({ data: [{ name: bucket }], error: null })
      await garantisci(sb)
      expect(createBucket).not.toHaveBeenCalled()
      expect(h.logEvento).not.toHaveBeenCalled()
    })

    it('bucket assente: lo crea privato', async () => {
      const { sb, createBucket } = client({ data: [{ name: 'altro' }], error: null })
      await garantisci(sb)
      expect(createBucket).toHaveBeenCalledWith(bucket, expect.objectContaining({ public: false }))
    })
  })
  ```

- [ ] **Passo 3: sono rossi.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/architecture/errori-postgrest-guardati.test.ts __tests__/lib/storage-elenco-bucket-guasto.test.ts
  ```
  Atteso:
  - il controllo positivo del lock è verde;
  - il test «nessuna violazione» è rosso, con 6 righe `storage-senza-error`, una per file del Passo 4 (le due
    delle competenze le ha tolte il Compito 8);
  - nel test degli store fallisce il primo caso di ogni gruppo: `createBucket` chiamato, `logEvento` no.

- [ ] **Passo 4: i sei `listBuckets()`.**
  1. `src/app/api/primaria/allegati/route.ts`.
     - La riga 187
       ```ts
             const { data: buckets } = await supabase.storage.listBuckets()
       ```
       diventa:
       ```ts
             const { data: buckets, error: erroreElenco } = await supabase.storage.listBuckets()
       ```
     - La riga 196
       ```ts
             if (!buckets?.some((b) => b.name === BUCKET_ALLEGATI_REGISTRO)) {
       ```
       diventa:
       ```ts
             if (erroreElenco) {
               // Senza l'elenco non si sa se il bucket c'è: crearlo alla cieca, o saltare il passaggio che lo
               // rende privato, sarebbe decidere su un vuoto. L'upload qui sotto ha il suo errore.
               logEvento('storage', 'warn', {
                 operazione,
                 bucket: BUCKET_ALLEGATI_REGISTRO,
                 esito: 'bucket_non_verificato',
               }, erroreElenco)
             } else if (!buckets?.some((b) => b.name === BUCKET_ALLEGATI_REGISTRO)) {
       ```
  2. `src/app/api/primaria/fascicolo/route.ts`, righe 176-179:
     ```ts
           const { data: buckets } = await supabase.storage.listBuckets()
           if (!buckets?.some((b) => b.name === BUCKET)) {
             await supabase.storage.createBucket(BUCKET, { public: false, allowedMimeTypes: ALLOWED, fileSizeLimit: MAX_SIZE })
           }
     ```
     diventano:
     ```ts
           const { data: buckets, error: erroreElenco } = await supabase.storage.listBuckets()
           if (erroreElenco) {
             logEvento('storage', 'warn', {
               operazione: 'primaria/fascicolo:POST',
               bucket: BUCKET,
               esito: 'bucket_non_verificato',
             }, erroreElenco)
           } else if (!buckets?.some((b) => b.name === BUCKET)) {
             await supabase.storage.createBucket(BUCKET, { public: false, allowedMimeTypes: ALLOWED, fileSizeLimit: MAX_SIZE })
           }
     ```
  3. `src/lib/cassa/store.ts`, righe 22-23:
     ```ts
         const { data } = await supabase.storage.listBuckets()
         if (data?.some((b) => b.name === CASSA_BUCKET)) return
     ```
     diventano:
     ```ts
         const { data, error: erroreElenco } = await supabase.storage.listBuckets()
         if (erroreElenco) {
           // Senza l'elenco non si crea alla cieca. Se il bucket manca davvero, a valle
           // `createSignedUploadUrl` fallisce col suo errore, e questa riga dice da dove partire.
           logEvento('storage', 'warn', {
             operazione: 'ensureCassaBucket',
             bucket: CASSA_BUCKET,
             esito: 'bucket_non_verificato',
           }, erroreElenco)
           return
         }
         if (data?.some((b) => b.name === CASSA_BUCKET)) return
     ```
  4. `src/lib/competenze/certificato-store.ts`, righe 239-240:
     ```ts
       const { data: buckets } = await supabase.storage.listBuckets()
       if (!buckets?.some((b: { name: string }) => b.name === CERTIFICATI_BUCKET)) {
     ```
     diventano:
     ```ts
       const { data: buckets, error: erroreElenco } = await supabase.storage.listBuckets()
       if (erroreElenco) {
         // Senza l'elenco non si crea alla cieca: l'upload qui sotto ha il suo errore, e se il bucket manca
         // davvero è lui a fermare l'archiviazione.
         logEvento('storage', 'warn', {
           operazione: 'persistCertificato',
           bucket: CERTIFICATI_BUCKET,
           esito: 'bucket_non_verificato',
           entita_id: certificatoId,
         }, erroreElenco)
       } else if (!buckets?.some((b: { name: string }) => b.name === CERTIFICATI_BUCKET)) {
     ```
  5. `src/lib/primaria/pagella-store.ts`, righe 198-199:
     ```ts
       const { data: buckets } = await supabase.storage.listBuckets()
       if (!buckets?.some((b) => b.name === PAGELLE_BUCKET)) {
     ```
     diventano:
     ```ts
       const { data: buckets, error: erroreElenco } = await supabase.storage.listBuckets()
       if (erroreElenco) {
         // Senza l'elenco non si crea alla cieca: l'upload qui sotto ha il suo errore.
         logEvento('storage', 'warn', {
           operazione: 'persistPagella',
           bucket: PAGELLE_BUCKET,
           esito: 'bucket_non_verificato',
           entita_id: scrutinioId,
         }, erroreElenco)
       } else if (!buckets?.some((b) => b.name === PAGELLE_BUCKET)) {
     ```
  6. `src/lib/protocolli/store.ts`.
     - Le righe 104-105
       ```ts
           const { data } = await supabase.storage.listBuckets()
           if (data?.some((b) => b.name === PROTOCOLLO_BUCKET)) return
       ```
       diventano:
       ```ts
           const { data, error: erroreElenco } = await supabase.storage.listBuckets()
           if (erroreElenco) {
             logEvento('storage', 'warn', {
               operazione: 'protocolli/store:ensureBucket',
               bucket: PROTOCOLLO_BUCKET,
               esito: 'bucket_non_verificato',
             }, erroreElenco)
             return
           }
           if (data?.some((b) => b.name === PROTOCOLLO_BUCKET)) return
       ```
     - Il `catch` muto (righe 110-112)
       ```ts
         } catch {
           // corsa fra richieste parallele o bucket già esistente: ignorato
         }
       ```
       diventa:
       ```ts
         } catch (e) {
           // Caso atteso (corsa fra richieste parallele, bucket già esistente): `info`, non `error`. Ma non
           // muto: un fallimento vero (permessi, quota) qui è l'unico posto dove compare il motivo.
           logEvento('storage', 'info', {
             operazione: 'protocolli/store:ensureBucket',
             bucket: PROTOCOLLO_BUCKET,
             esito: 'creazione-saltata',
           }, e)
         }
       ```

  Tutti e sei i file importano già `logEvento`. Il risultato di `createBucket`/`updateBucket` resta ignorato (vedi le
  Scelte, punto 3).

- [ ] **Passo 5: verdi, e i test vicini pure.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/architecture/errori-postgrest-guardati.test.ts \
    __tests__/lib/storage-elenco-bucket-guasto.test.ts __tests__/lib/protocolli-store.test.ts \
    __tests__/architecture/bucket-storage-dichiarati.test.ts __tests__/architecture/logging-coverage.test.ts
  ```
  Atteso: `Test Files  5 passed (5)`.
  - Poi si cercano i test che importano i quattro file di `src/lib` toccati, e li si lancia:
    ```bash
    cd /Users/lerri/kidville-web-s13 && grep -rlE "lib/(cassa/store|competenze/certificato-store|primaria/pagella-store)|api/primaria/(allegati|fascicolo)" __tests__ | head -20
    ```
  - Atteso: tutti verdi.

- [ ] **Passo 6: commit.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && git add __tests__/architecture/errori-postgrest-guardati.test.ts __tests__/lib/storage-elenco-bucket-guasto.test.ts \
    src/app/api/primaria/allegati/route.ts src/app/api/primaria/fascicolo/route.ts src/lib/cassa/store.ts \
    src/lib/competenze/certificato-store.ts src/lib/primaria/pagella-store.ts src/lib/protocolli/store.ts
  git commit -m "Storage: l'elenco dei bucket non riuscito non diventa «bucket assente», e il lock lo vieta" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Compito 10: i tetti scendono alla misura vera

**File:**
- Modifica: `docs/superpowers/errori-senza-codice-allowlist.json` (con uno script: le voci si cercano per `path`, mai
  per riga)
- Modifica: `__tests__/architecture/errori-con-codice.test.ts`, le costanti `MAX_FILE` e `MAX_OCCORRENZE` (cercate per
  testo: la sessione 2 le ha già cambiate e ha aggiunto i suoi paragrafi 🔻)
- Modifica: `__tests__/architecture/catch-muti-allowlist.test.ts`, le costanti `MAX_SOLO_COMMENTI` e
  `MAX_FILE_SOLO_COMMENTI`

I due lock sono verdi già adesso, perché misurano meno del tetto. Il loro messaggio chiede di abbassare il tetto quando
si bonifica: «Se è SCESO … abbassa il tetto invece di lasciare credito non speso».

- [ ] **Passo 1: i valori veri, letti dai file.** Il piano è scritto sui valori che lascia la sessione 2, ma prima di
  scrivere si leggono quelli che ci sono:
  ```bash
  cd /Users/lerri/kidville-web-s13 && node -e '
  const d = JSON.parse(require("fs").readFileSync("docs/superpowers/errori-senza-codice-allowlist.json", "utf8"))
  console.log("allowlist: file", d.file.length, "· occorrenze", d.totale_occorrenze, "· aggiornato", d.aggiornato)
  const nostri = [
    "src/app/api/admin/competenze/download/route.ts", "src/app/api/forms/submit/route.ts",
    "src/app/api/iscrizione/route.ts", "src/app/api/iscrizione/sedi/route.ts", "src/app/api/notes/route.ts",
    "src/app/api/parent/competenze/route.ts", "src/app/api/public/forms/[token]/submit/route.ts",
  ]
  for (const f of nostri) console.log(f, (d.file.find((v) => v.path === f) || { n: "assente" }).n)
  '
  grep -n "^const MAX_FILE = \|^const MAX_OCCORRENZE = " __tests__/architecture/errori-con-codice.test.ts
  grep -n "^const MAX_SOLO_COMMENTI = \|^const MAX_FILE_SOLO_COMMENTI = " __tests__/architecture/catch-muti-allowlist.test.ts
  ```
  Atteso, dopo la sessione 2 (che toglie le sei route di `exec_sql`: 6 voci e 11 occorrenze):
  - `allowlist: file 264 · occorrenze 1350`;
  - le sette voci, nell'ordine dell'elenco: 3, 7, 7, 2, 4, 1, 8;
  - `const MAX_FILE = 264;` e `const MAX_OCCORRENZE = 1350;`;
  - `const MAX_SOLO_COMMENTI = 49;` e `const MAX_FILE_SOLO_COMMENTI = 37;` (nessuna sessione prima della 13 li
    cambia: controllato sui piani il 20/10).

  Se i numeri sono altri, un'altra sessione ha cambiato ancora l'allowlist o i tetti. Si parte da quelli letti
  (chiamiamoli F, O, C e CF) e si tolgono gli stessi numeri: F − 2, O − 19, C − 2, CF − 2. Nei Passi 3-5 si
  scrivono quei valori al posto di 264/262, 1350/1331, 49/47 e 37/35. Se invece è cambiata una delle sette voci, la
  sessione che l'ha cambiata ha toccato quel file: ci si ferma e si confronta il file con la tabella qui sotto prima
  di scrivere. I valori letti vanno nel corpo della PR.

- [ ] **Passo 2: la misura dopo i Compiti 5-9.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/catch-muti-allowlist.test.ts
  ```
  Atteso: verdi. I numeri attesi per file:

  | File | `n` dichiarato | `n` misurato |
  |---|---|---|
  | `admin/competenze/download/route.ts` | 3 | 1 |
  | `forms/submit/route.ts` | 7 | 3 |
  | `iscrizione/route.ts` | 7 | 4 |
  | `iscrizione/sedi/route.ts` | 2 | 1 |
  | `notes/route.ts` | 4 | 0 (esce) |
  | `parent/competenze/route.ts` | 1 | 0 (esce) |
  | `public/forms/[token]/submit/route.ts` | 8 | 4 |

  - Totale: 1350 − 19 = **1331**, in 264 − 2 = **262** file.
  - `catch` con soli commenti: 49 − 2 = **47**, in 37 − 2 = **35** file. Sono il `catch` della notifica di `notes`
    e quello di `protocolli/store`.
  - Il lock controlla solo che una voce non CRESCA: abbassata al numero della tabella, se il file ne ha di più lo
    dice («dichiarate X, misurate Y»). In quel caso valgono i numeri del lock, e la differenza si scrive nel corpo
    della PR.

- [ ] **Passo 3: l'allowlist.** Uno script, come quello della sessione 2: le voci si cercano per `path`, e ogni numero
  di partenza si controlla prima di cambiarlo.
  ```bash
  cd /Users/lerri/kidville-web-s13 && python3 - <<'PY'
  import datetime, json, pathlib
  p = pathlib.Path('docs/superpowers/errori-senza-codice-allowlist.json')
  d = json.loads(p.read_text(encoding='utf-8'))
  scendono = {  # path: (n di prima, n di dopo)
      'src/app/api/admin/competenze/download/route.ts': (3, 1),
      'src/app/api/forms/submit/route.ts': (7, 3),
      'src/app/api/iscrizione/route.ts': (7, 4),
      'src/app/api/iscrizione/sedi/route.ts': (2, 1),
      'src/app/api/public/forms/[token]/submit/route.ts': (8, 4),
  }
  escono = {'src/app/api/notes/route.ts': 4, 'src/app/api/parent/competenze/route.ts': 1}
  voci = {v['path']: v for v in d['file']}
  for f, (prima, _) in scendono.items():
      assert voci[f]['n'] == prima, (f, voci[f]['n'])
  for f, prima in escono.items():
      assert voci[f]['n'] == prima, (f, voci[f]['n'])
  tolte = sum(prima - dopo for prima, dopo in scendono.values()) + sum(escono.values())
  assert tolte == 19, tolte
  file_prima, occorrenze_prima = len(d['file']), d['totale_occorrenze']
  for f, (_, dopo) in scendono.items():
      voci[f]['n'] = dopo
  d['file'] = [v for v in d['file'] if v['path'] not in escono]
  d['totale_occorrenze'] -= tolte
  assert d['totale_occorrenze'] == sum(v['n'] for v in d['file'])
  assert len(d['file']) == file_prima - 2
  d['aggiornato'] = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')
  p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
  print(file_prima, '→', len(d['file']), '·', occorrenze_prima, '→', d['totale_occorrenze'])
  PY
  git diff --stat docs/superpowers/errori-senza-codice-allowlist.json
  ```
  Atteso: `264 → 262 · 1350 → 1331` (o F → F − 2 e O → O − 19 del Passo 1). Il diff tocca solo le cinque voci che
  scendono, le otto righe delle due voci che escono, `aggiornato` e `totale_occorrenze`. Il 20/10 il file faceva già
  il giro `json.loads` → `json.dumps(indent=2, ensure_ascii=False)` senza cambiare un carattere: se il diff
  riformatta altro, si annulla quel file con lo strumento Edit (mai `git checkout`) e si fanno le stesse modifiche a
  mano.

- [ ] **Passo 4: i tetti di `errori-con-codice`.** La sessione 2 ha lasciato, sopra ciascuna delle due costanti, il suo
  paragrafo 🔻 (`🔻 270 → 264 …` e `🔻 1361 → 1350 …`). Quei paragrafi **restano**: il nuovo si aggiunge sotto,
  sostituendo solo la chiusura del commento e la costante.
  1. In `__tests__/architecture/errori-con-codice.test.ts` le due righe
     ```ts
      */
     const MAX_FILE = 264;
     ```
     diventano:
     ```ts
      *
      * 🔻 264 → 262 il <AAAA-MM-GG di oggi>, branch `robustezza2/s13-bordo-pubblico` (robustezza, seconda serie,
      * sessione 13). Le voci di `notes/route.ts` e di `parent/competenze/route.ts` sono arrivate a ZERO e sono
      * uscite dall'elenco: vedi il paragrafo gemello su `MAX_OCCORRENZE`.
      */
     const MAX_FILE = 262;
     ```
  2. Le due righe
     ```ts
      */
     const MAX_OCCORRENZE = 1350;
     ```
     diventano:
     ```ts
      *
      * 🔻 1350 → 1331 il <AAAA-MM-GG di oggi>, branch `robustezza2/s13-bordo-pubblico` (sessione 13 della seconda
      * serie di robustezza, «bordo pubblico»). Debito PAGATO. Le quattro porte anonime che mandavano il `message`
      * di un errore a chiunque ora rispondono con `LETTURA_FALLITA`/`SCRITTURA_FALLITA`
      * (`rispostaGuastoGiaRegistrato`) o con `ERRORE_INTERNO` (`src/lib/api/errore-interno.ts`). Con loro le
      * altre risposte senza codice dei file toccati: `notes` 4 → 0, `parent/competenze` 1 → 0,
      * `admin/competenze/download` 3 → 1, `forms/submit` 7 → 3, `iscrizione` 7 → 4, `iscrizione/sedi`
      * 2 → 1, `public/forms/[token]/submit` 8 → 4 (la voce era già larga di uno: se ne misuravano 7).
      */
     const MAX_OCCORRENZE = 1331;
     ```
  3. Verifica che i paragrafi della sessione 2 ci siano ancora e che le costanti siano quelle nuove:
     ```bash
     cd /Users/lerri/kidville-web-s13 && grep -n "🔻 270 → 264\|🔻 264 → 262\|^const MAX_FILE = \|🔻 1361 → 1350\|🔻 1350 → 1331\|^const MAX_OCCORRENZE = " __tests__/architecture/errori-con-codice.test.ts
     ```
     Atteso: sei righe, nell'ordine `🔻 270 → 264`, `🔻 264 → 262`, `const MAX_FILE = 262;`, `🔻 1361 → 1350`,
     `🔻 1350 → 1331`, `const MAX_OCCORRENZE = 1331;`. Se la sessione 2 ha scritto i suoi paragrafi con parole
     diverse, le righe 🔻 della 2 si cercano con `grep -n "🔻" … | tail -4`: devono esserci prima delle nuove.

- [ ] **Passo 5: i tetti dei `catch` con soli commenti.** In `__tests__/architecture/catch-muti-allowlist.test.ts`,
  il paragrafo `🔻 52 → 49 e 40 → 37 il 2026-10-19 (fase 11)` resta; le tre righe che lo chiudono
  ```ts
   */
  const MAX_SOLO_COMMENTI = 49;
  const MAX_FILE_SOLO_COMMENTI = 37;
  ```
  diventano:
  ```ts
   *
   * 🔻 49 → 47 e 37 → 35 il <AAAA-MM-GG di oggi> (sessione 13 della seconda serie, «bordo pubblico»): escono
   * `src/app/api/notes/route.ts` (la notifica ai genitori non accodata, `catch { /* non bloccare *\/ }`)
   * e `src/lib/protocolli/store.ts` (`ensureBucket`). Ora loggano: `notifica-genitori-non-accodata` a
   * `error`, `creazione-saltata` a `info`.
   */
  const MAX_SOLO_COMMENTI = 47;
  const MAX_FILE_SOLO_COMMENTI = 35;
  ```

- [ ] **Passo 6: verdi.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/catch-muti-allowlist.test.ts
  ```
  Atteso: `Test Files  2 passed (2)`.

- [ ] **Passo 7: commit.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && git add docs/superpowers/errori-senza-codice-allowlist.json \
    __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/catch-muti-allowlist.test.ts
  git commit -m "Tetti alla misura vera: errori senza codice 1350 → 1331 (264 → 262 file), catch con soli commenti 49 → 47" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```
  Con valori di partenza diversi (Passo 1), il messaggio porta quelli veri.

### Compito 11: la build locale con l'heap della CI (S12)

**File:**
- Crea: `__tests__/architecture/build-heap-come-in-ci.test.ts`
- Modifica: `package.json:7`

- [ ] **Passo 1: il lock rosso.** Crea `__tests__/architecture/build-heap-come-in-ci.test.ts`:
  ```ts
  // @vitest-environment node
  import fs from 'node:fs'
  import path from 'node:path'
  import { describe, it, expect } from 'vitest'

  /**
   * LOCK · `npm run build` HA LO STESSO HEAP DELLA CI (problema S12 della seconda misura, 20/10).
   *
   * La CI imposta `NODE_OPTIONS: '--max-old-space-size=6144'` (`.github/workflows/ci.yml`) e lì la build
   * passa. In locale `npm run build` partiva con l'heap predefinito e finiva in OOM: chi lavorava da un worktree
   * nuovo scopriva il limite alla fine, dopo minuti di compilazione. Lo script ora porta lo stesso valore.
   * Un `NODE_OPTIONS` già impostato da chi lancia viene DOPO, e per Node vince l'ultimo
   * `--max-old-space-size`: `NODE_OPTIONS=--max-old-space-size=8192 npm run build` resta il modo di chiederne
   * di più.
   */

  const RADICE = process.cwd()

  describe('lock — la build locale ha lo stesso heap della CI', () => {
    it('`npm run build` passa a Node lo stesso --max-old-space-size del workflow, e lascia vincere chi lancia', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(RADICE, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
      const ci = fs.readFileSync(path.join(RADICE, '.github', 'workflows', 'ci.yml'), 'utf8')
      const mega = /NODE_OPTIONS:\s*'--max-old-space-size=(\d+)'/.exec(ci)?.[1]
      expect(mega, 'ci.yml non dichiara più NODE_OPTIONS nella forma attesa').toBeTruthy()

      const build = pkg.scripts.build
      const opzione = `--max-old-space-size=${mega}`
      expect(build, 'lo script build non porta l’heap della CI').toContain(opzione)
      expect(build.indexOf('${NODE_OPTIONS:-}')).toBeGreaterThan(build.indexOf(opzione))
      expect(build.trim().endsWith('next build')).toBe(true)
    })
  })
  ```

- [ ] **Passo 2: è rosso.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/architecture/build-heap-come-in-ci.test.ts
  ```
  Atteso: FAIL, `lo script build non porta l’heap della CI`.

- [ ] **Passo 3: lo script.** In `package.json`, la riga 7
  ```json
      "build": "next build",
  ```
  diventa:
  ```json
      "build": "NODE_OPTIONS=\"--max-old-space-size=6144 ${NODE_OPTIONS:-}\" next build",
  ```
  `npm run` usa `sh` sia sul Mac sia su Vercel sia in CI. Su Vercel `${NODE_OPTIONS:-}` è vuoto. In CI vale già
  6144, quindi l'opzione compare due volte con lo stesso valore.

- [ ] **Passo 4: verde, e l'ordine delle opzioni fa quello che dice.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/architecture/build-heap-come-in-ci.test.ts
  NODE_OPTIONS="--max-old-space-size=6144 --max-old-space-size=8192" node -e "console.log(Math.round(require('v8').getHeapStatistics().heap_size_limit/1048576))"
  ```
  Atteso:
  - `Test Files  1 passed (1)`;
  - un numero di poco sopra **8192**: vince l'ultimo valore. Se esce un numero vicino a 6144, l'ordine va invertito,
    nel lock e nello script.

- [ ] **Passo 5: la build senza `NODE_OPTIONS`.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npm run build
  ```
  - Atteso: uscita 0. Se su questo Mac non basta neanche 6144, l'OOM resta, ed è il motivo per cui il gate della
    §5 scrive `NODE_OPTIONS=--max-old-space-size=8192 npm run build`. Lo si annota nella PR.
  - La prova vera è la build di Vercel sull'anteprima (Compito 13), che lancia lo stesso script.

- [ ] **Passo 6: commit.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && git add package.json __tests__/architecture/build-heap-come-in-ci.test.ts
  git commit -m "Build: npm run build con l'heap della CI (6144), chi lancia può chiederne di più" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Compito 12: la cache passa tutta da `intestazioniCachePubblica`

**File:**
- Crea: `__tests__/lib/cache-pubblica.test.ts`
- Modifica: `src/app/api/anagrafiche/comuni/route.ts:6, 204-212, 245, 255, 462-471`

Un riordino: le intestazioni dei comuni non cambiano di un carattere. Dopo, una correzione in
`src/lib/security/cache-pubblica.ts` vale per sedi, modello e comuni insieme.

- [ ] **Passo 1: il test che fissa il comportamento di oggi.** È la rete del riordino, e passa subito. Crea
  `__tests__/lib/cache-pubblica.test.ts`:
  ```ts
  // @vitest-environment node
  import { describe, it, expect } from 'vitest'
  import { intestazioniCachePubblica } from '@/lib/security/cache-pubblica'

  /**
   * Le intestazioni di cache delle tre letture pubbliche: `/api/iscrizione/sedi`, `/api/iscrizione/model`,
   * `/api/anagrafiche/comuni`. Sessione 13: la CDN di Vercel non conservava le risposte (il 20/10 MISS 23 su 23),
   * e la correzione cambia SOLO questa funzione.
   */
  const richiesta = (cookie?: string) =>
    new Request('http://localhost/api/iscrizione/sedi', cookie ? { headers: { cookie } } : undefined)

  describe('intestazioniCachePubblica', () => {
    it('senza sessione: public, con s-maxage', () => {
      expect(intestazioniCachePubblica(richiesta(), 600, 3600)).toEqual({
        'Cache-Control': 'public, max-age=600, s-maxage=600, stale-while-revalidate=3600',
        Vary: 'Cookie',
      })
    })

    it('con il cookie di sessione Supabase: private, nessuna istruzione per una cache condivisa', () => {
      expect(intestazioniCachePubblica(richiesta('sb-progetto-auth-token=valore-finto'), 600, 3600)).toEqual({
        'Cache-Control': 'private, max-age=600, stale-while-revalidate=3600',
        Vary: 'Cookie',
      })
    })

    it('il cookie della protezione delle anteprime (`_vercel_jwt`) non è una sessione: resta public', () => {
      const intestazioni = intestazioniCachePubblica(richiesta('_vercel_jwt=finto'), 600, 3600)
      expect(intestazioni['Cache-Control']).toMatch(/^public, /)
    })
  })
  ```
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/lib/cache-pubblica.test.ts
  ```
  Atteso: `Tests  3 passed (3)`.

- [ ] **Passo 2: i comuni sulla funzione comune.** In `src/app/api/anagrafiche/comuni/route.ts`:
  1. La riga 6
     ```ts
     import { haCookieSessioneNellIntestazione } from '@/lib/auth/session-cookie'
     ```
     diventa:
     ```ts
     import { intestazioniCachePubblica } from '@/lib/security/cache-pubblica'
     ```
  2. Le righe 204-212
     ```ts
     /**
      * Le due intestazioni di cache, e perché sono DUE. La lunga spiegazione sta nella
      * testata: qui basta la regola. `public` = «qualunque proxy può conservarla e
      * riservirla a chiunque»; `private` = «solo la cache del browser di chi ha chiesto».
      * La seconda si usa quando il middleware potrebbe attaccare un `Set-Cookie` di
      * sessione a questa stessa risposta — misurato, non supposto.
      */
     const CACHE_CONDIVISA = 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800'
     const CACHE_PRIVATA = 'private, max-age=86400, stale-while-revalidate=604800'
     ```
     diventano:
     ```ts
     /**
      * Un giorno in cache, una settimana servita stantia mentre si rinnova. Le intestazioni le scrive
      * `intestazioniCachePubblica` (`src/lib/security/cache-pubblica.ts`), la stessa di `/api/iscrizione/sedi` e
      * `/api/iscrizione/model`: `public` senza cookie di sessione, `private` con. La lunga spiegazione del perché sta
      * nella testata. Le due righe stavano qui scritte a mano fino alla sessione 13 della seconda serie: una
      * correzione della cache doveva essere fatta due volte.
      */
     const CACHE_SECONDI = 86_400
     const CACHE_STANTIO = 604_800
     ```
  3. La riga 245
     ```ts
      * `false` è il ramo `CACHE_CONDIVISA`, cioè `public` verso ogni cache condivisa —
     ```
     diventa:
     ```ts
      * `false` è la strada `public` di `intestazioniCachePubblica`, verso ogni cache condivisa —
     ```
  4. La riga 255
     ```ts
      * ramo `catch` PROPRIO qui dentro che scelga `CACHE_PRIVATA`, invece di ereditare
     ```
     diventa:
     ```ts
      * ramo `catch` PROPRIO in `intestazioniCachePubblica` che scelga la strada `private`, invece di ereditare
     ```
  5. Le righe 462-471
     ```ts
       const intestazioni = {
         // La sola intestazione di questa route che dipende da CHI chiama. Vedi la
         // testata: con una sessione in corso il middleware può attaccare qui sopra un
         // `Set-Cookie`, e `public` lo consegnerebbe alla prima cache condivisa.
         'Cache-Control': haCookieSessioneNellIntestazione(request.headers.get('cookie'))
           ? CACHE_PRIVATA
           : CACHE_CONDIVISA,
         Vary: 'Cookie',
         ETag: etag,
       }
     ```
     diventano:
     ```ts
       const intestazioni = {
         // La sola parte di questa route che dipende da CHI chiama. Vedi la testata: con una
         // sessione in corso il middleware può attaccare qui sopra un `Set-Cookie`, e `public`
         // lo consegnerebbe alla prima cache condivisa.
         ...intestazioniCachePubblica(request, CACHE_SECONDI, CACHE_STANTIO),
         ETag: etag,
       }
     ```

- [ ] **Passo 3: i comuni non se ne accorgono.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/api/anagrafiche-comuni.test.ts __tests__/lib/cache-pubblica.test.ts \
    __tests__/api/iscrizione-sedi.test.ts __tests__/api/iscrizione-model-anonima.test.ts && npx tsc --noEmit
  ```
  Atteso: `Test Files  4 passed (4)` e `tsc` senza uscita. I test dei comuni controllano le stringhe intere
  (`CACHE_CONDIVISA`/`CACHE_PRIVATA` in `anagrafiche-comuni.test.ts:254-255`), quindi un carattere diverso sarebbe
  rosso.

- [ ] **Passo 4: commit.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && git add src/app/api/anagrafiche/comuni/route.ts __tests__/lib/cache-pubblica.test.ts
  git commit -m "Comuni: le intestazioni di cache passano da intestazioniCachePubblica (nessun cambiamento)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Compito 13: S8, la prima prova — `Vercel-CDN-Cache-Control` su un'anteprima

**File:**
- Modifica: `src/lib/security/cache-pubblica.ts:20-36`, `__tests__/lib/cache-pubblica.test.ts`

Cosa si sa, prima di provare:
- Il 20/10 la risposta delle sedi arrivava con `cache-control: public, max-age=600` e `vary: Cookie`, senza
  `set-cookie`, e `x-vercel-cache: MISS` due volte di fila dallo stesso nodo (`fra1::dub1`).
- La documentazione di Vercel dice che dal 30/09/2026 una risposta con `Vary: Cookie` non viene conservata. Il motivo
  compare nei Runtime Logs, sezione «Cache» della richiesta (per esempio `vary_key_denied:cookie`).
- Secondo la stessa documentazione, l'ordine di precedenza è `Vercel-CDN-Cache-Control` > `CDN-Cache-Control` >
  `Cache-Control`.

Con questi dati, la prima prova probabilmente non basta. La specifica chiede comunque quest'ordine: si prova, si legge
e si corregge solo quello che l'anteprima ha mostrato.

- [ ] **Passo 1: il test chiede la prova 1 (rosso).** In `__tests__/lib/cache-pubblica.test.ts`, il primo test
  diventa:
  ```ts
    it('senza sessione: public con s-maxage, e la stessa durata dichiarata alla CDN di Vercel', () => {
      expect(intestazioniCachePubblica(richiesta(), 600, 3600)).toEqual({
        'Cache-Control': 'public, max-age=600, s-maxage=600, stale-while-revalidate=3600',
        'Vercel-CDN-Cache-Control': 'max-age=600, stale-while-revalidate=3600',
        Vary: 'Cookie',
      })
    })
  ```
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/lib/cache-pubblica.test.ts
  ```
  Atteso: 1 FAIL, manca `Vercel-CDN-Cache-Control`. Il secondo test resta verde: chiede con `toEqual` che la strada
  con sessione NON porti l'intestazione per la CDN.

- [ ] **Passo 2: la prova 1.** In `src/lib/security/cache-pubblica.ts`, la funzione (righe 20-36) diventa:
  ```ts
  /**
   * Le intestazioni per una risposta pubblica che può restare in cache `secondi` (e `stantio`
   * secondi in più, servita mentre si rinnova).
   *
   * Sessione 13, prova 1 della diagnosi del MISS: sulla strada pubblica la durata si dichiara anche in
   * `Vercel-CDN-Cache-Control`, che per la CDN di Vercel vince su `Cache-Control` e non arriva al browser.
   * La strada con sessione non la porta: lì nessuna cache condivisa deve conservare niente.
   */
  export function intestazioniCachePubblica(
    request: Request,
    secondi: number,
    stantio: number,
  ): Record<string, string> {
    if (haCookieSessioneNellIntestazione(request.headers.get('cookie'))) {
      return {
        'Cache-Control': `private, max-age=${secondi}, stale-while-revalidate=${stantio}`,
        Vary: 'Cookie',
      }
    }
    return {
      'Cache-Control': `public, max-age=${secondi}, s-maxage=${secondi}, stale-while-revalidate=${stantio}`,
      'Vercel-CDN-Cache-Control': `max-age=${secondi}, stale-while-revalidate=${stantio}`,
      Vary: 'Cookie',
    }
  }
  ```

- [ ] **Passo 3: verde, e i test delle tre route pure.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/lib/cache-pubblica.test.ts __tests__/api/iscrizione-sedi.test.ts \
    __tests__/api/iscrizione-model-anonima.test.ts __tests__/api/anagrafiche-comuni.test.ts
  ```
  Atteso: `Test Files  4 passed (4)`.

- [ ] **Passo 4: commit, da solo.** Così il ramo B lo può togliere con un `git revert` pulito.
  ```bash
  cd /Users/lerri/kidville-web-s13 && git add src/lib/security/cache-pubblica.ts __tests__/lib/cache-pubblica.test.ts
  git commit -m "Cache pubblica, prova 1: la durata anche in Vercel-CDN-Cache-Control" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

- [ ] **Passo 5: il gate locale, poi il push.** Il push fa partire la build dell'anteprima su Vercel, che lancia lo
  script `build` del Compito 11.
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx eslint . --max-warnings 0 && npx tsc --noEmit && CI=1 npx vitest run
  git push -u origin robustezza2/s13-bordo-pubblico
  ```
  - Atteso: eslint e tsc senza uscita; vitest `Test Files  N passed (N)`; il push crea il ramo remoto.
  - Si aspetta che il deployment dell'anteprima sia «Ready»:
    ```bash
    npx vercel@64.7.0 --cwd /Users/lerri/kidville-web ls kidville-web -m githubCommitRef=robustezza2/s13-bordo-pubblico
    ```
    Una build rossa su Vercel si legge nei log del deployment: è anche la prova del Compito 11.

- [ ] **Passo 6: il titolare apre l'anteprima.** Gli si chiede in chat il link di condivisione del deployment
  appena costruito: Vercel → Deployments → il deployment del ramo → «Share».
  - Il link resta solo in una variabile della shell: mai in un file, in un commit, nella PR o in una issue.
  - Se il titolare non può, si va al ramo «R» qui sotto.

- [ ] **Passo 7: due richieste di fila per rotta, sull'anteprima.**
  ```bash
  CONDIVISIONE='<link di condivisione dato dal titolare>'
  ANTEPRIMA="${CONDIVISIONE%%\?*}"; ANTEPRIMA="${ANTEPRIMA%/}"
  JAR="$TMPDIR/s13-anteprima.jar"
  curl -s -o /dev/null -L -c "$JAR" -A 'kidville-misura-s13' "$CONDIVISIONE"
  for rotta in /api/iscrizione/sedi /api/iscrizione/model '/api/anagrafiche/comuni?provincia=NA'; do
    for i in 1 2; do
      echo "--- $rotta ($i)"
      curl -s -o /dev/null -b "$JAR" -A 'kidville-misura-s13' -D - "$ANTEPRIMA$rotta" \
        | grep -iE '^(HTTP/|x-vercel-cache|cache-control|vary|age):'
      sleep 2
    done
  done
  rm -f "$JAR"
  ```
  Come si legge:
  - `HTTP/2 302` o `401`: il cookie della condivisione non è stato preso. Si chiede un link nuovo.
  - `HTTP/2 500`: l'anteprima non ha le variabili del database, e un 500 non va in cache per costruzione. Si va al
    ramo «R».
  - `HTTP/2 200` e `x-vercel-cache: HIT` (con `age` > 0) alla seconda richiesta: **la prova 1 basta**. È il ramo A
    del Compito 14.
  - `HTTP/2 200` e `MISS` anche alla seconda: la prova 1 non basta. Il titolare apre Vercel → Logs, filtra il
    deployment e il percorso `/api/iscrizione/sedi`, apre una delle due richieste e legge il motivo nella sezione
    «Cache». Il motivo si scrive nella PR. Poi si va al ramo B del Compito 14.

- [ ] **Ramo «R» — l'anteprima non si può misurare.** La diagnosi si fa dopo il merge, in produzione, su una sola
  route (Scelte, punto 8), e solo sulla prova 1.
  1. La prova 1 resta nella PR della sessione. Non fa danni: aggiunge un'intestazione che la CDN consuma.
  2. Si va avanti col Compito 15 e col Rilascio fino al merge. Al passo 7 del Rilascio si misurano solo
     `/api/iscrizione/sedi` e le sue 2 richieste.
  3. `HIT` alla seconda richiesta: ramo A, fatto. Il paragrafo del ramo A in `docs/cicd.md` lo scrive la chiusura
     della sessione 13 (sezione finale «Per la sessione dopo»), perché la misura arriva dopo il merge.
  4. `MISS`: il titolare apre Vercel → Logs sul deployment di **produzione**, filtra il percorso `/api/iscrizione/sedi`,
     apre una delle due richieste e legge il motivo nella sezione «Cache». Il motivo e le righe `x-vercel-cache` vanno
     in un commento della PR mergiata (`gh pr comment <numero> --body-file -`).
     - **Nessun ramo di prova e nessuna PR dopo il merge.** Un ramo `robustezza2/s13-…` mergiato dopo quello della
       sessione farebbe trovare alla sessione dopo due PR `head:robustezza2/s13-` invece di una, e le farebbe cercare
       un piano che non esiste. Un ramo di prova, se mai servisse durante la sessione, si chiude prima della PR vera
       (Rilascio, passo 3).
     - S8 resta aperto. La prova 2 è scritta per intero nel ramo B del Compito 14: se e quando farla lo decide il
       titolare, col motivo letto davanti. La riga 13 della tabella di stato lo scrive nella colonna «Note» (sezione
       finale «Per la sessione dopo»).

### Compito 14: S8, i tre rami dopo la prova 1

Si esegue **un solo** ramo, quello che la misura del Compito 13 ha indicato.

- [ ] **Ramo A — la prova 1 basta.** Niente altro codice. Si scrivono nel corpo della PR le 6 righe
  `x-vercel-cache` e l'ora UTC della misura. Il Compito 15 scrive il paragrafo del ramo A in `docs/cicd.md`.

- [ ] **Ramo B — la prova 1 non basta: si toglie, e si prova `Vary` senza `Cookie` sulla strada pubblica.**

  Perché è sicuro:
  - La strada con sessione resta `private` con `Vary: Cookie`: nessuna cache condivisa la conserva.
  - Il corpo della strada pubblica è lo stesso per tutti: il test «il CORPO non cambia con la sessione» di
    `anagrafiche-comuni.test.ts` lo controlla per i comuni. Le sedi e il modello non leggono l'identità.
  - Se la CDN servisse la copia pubblica a una richiesta con sessione, il corpo sarebbe lo stesso. Il `Set-Cookie`
    del middleware arriva solo sulle richieste con sessione, che non vengono mai conservate.

  1. Si toglie la prova 1 (il commit del Compito 13, Passo 4):
     ```bash
     cd /Users/lerri/kidville-web-s13 && git revert --no-edit "$(git log --format=%H -1 --grep='Cache pubblica, prova 1')"
     ```
     Atteso: un commit `Revert "Cache pubblica, prova 1: …"`. `cache-pubblica.ts` e il suo test tornano a com'erano
     dopo il Compito 12.
  2. Il test chiede la prova 2 (rosso). In `__tests__/lib/cache-pubblica.test.ts`, il primo test diventa:
     ```ts
       it('senza sessione: public con s-maxage, e SENZA Vary (con Vary: Cookie la CDN di Vercel non conserva)', () => {
         expect(intestazioniCachePubblica(richiesta(), 600, 3600)).toEqual({
           'Cache-Control': 'public, max-age=600, s-maxage=600, stale-while-revalidate=3600',
         })
       })
     ```
     Gli altri due test restano com'erano dopo il Compito 12: la strada con sessione tiene `Vary: Cookie`.
  3. I test delle tre route chiedono lo stesso.
     - In `__tests__/api/iscrizione-sedi.test.ts`, la riga 125
       ```ts
           expect(anonimo.headers.get('Vary')).toBe('Cookie')
       ```
       diventa:
       ```ts
           expect(anonimo.headers.get('Vary')).toBeNull()
       ```
       e dopo
       `    expect(conSessione.headers.get('Cache-Control')).toBe('private, max-age=600, stale-while-revalidate=3600')`
       aggiungi:
       ```ts
           expect(conSessione.headers.get('Vary')).toBe('Cookie')
       ```
     - In `__tests__/api/iscrizione-model-anonima.test.ts`, la riga 127
       ```ts
           expect(res.headers.get('Vary')).toBe('Cookie')
       ```
       diventa:
       ```ts
           expect(res.headers.get('Vary')).toBeNull()
       ```
     - In `__tests__/api/anagrafiche-comuni.test.ts`, la riga 297 (il 304 anonimo)
       ```ts
           expect(secondo.headers.get('Vary')).toBe('Cookie')
       ```
       diventa:
       ```ts
           expect(secondo.headers.get('Vary')).toBeNull()
       ```
       e le righe 414-418
       ```ts
         it('`Vary: Cookie` c’è su ENTRAMBE le strade, 200 e 304', async () => {
           // Senza, una cache che ha già in mano la copia pubblica potrebbe servirla a una
           // richiesta con cookie diversi — e viceversa.
           const anonimo = await GET(req('?provincia=NA'))
           expect(anonimo.headers.get('Vary')).toBe('Cookie')
       ```
       diventano:
       ```ts
         it('`Vary: Cookie` c’è sulla strada con sessione (200 e 304), e NON su quella anonima', async () => {
           // Sessione 13: con `Vary: Cookie` la CDN di Vercel non conserva la risposta (misurato
           // sull'anteprima, `docs/cicd.md`). La strada anonima non lo porta più; quella con
           // sessione è `private` e lo tiene, per la cache del browser.
           const anonimo = await GET(req('?provincia=NA'))
           expect(anonimo.headers.get('Vary')).toBeNull()
       ```
       Il resto di quel test (sessione: `Vary: Cookie`, 304 con sessione: `Vary: Cookie` e `CACHE_PRIVATA`) non
       cambia.
  4. Sono rossi:
     ```bash
     cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/lib/cache-pubblica.test.ts __tests__/api/iscrizione-sedi.test.ts \
       __tests__/api/iscrizione-model-anonima.test.ts __tests__/api/anagrafiche-comuni.test.ts
     ```
     Atteso: 5 FAIL, tutti su `Vary`: 1 in `cache-pubblica`, 1 in sedi, 1 nel modello, 2 nei comuni.
  5. La prova 2. In `src/lib/security/cache-pubblica.ts`:
     - la riga 14 della testata
       ```ts
        *   · `Vary: Cookie` su entrambe le strade;
       ```
       diventa:
       ```ts
        *   · `Vary: Cookie` SOLO sulla strada con sessione. Sulla strada pubblica la CDN di Vercel non conserva una
        *     risposta con `Vary: Cookie` (misurato sull'anteprima nella sessione 13, `docs/cicd.md`), e il corpo è
        *     lo stesso per tutti;
       ```
     - la funzione diventa:
       ```ts
       export function intestazioniCachePubblica(
         request: Request,
         secondi: number,
         stantio: number,
       ): Record<string, string> {
         if (haCookieSessioneNellIntestazione(request.headers.get('cookie'))) {
           return {
             'Cache-Control': `private, max-age=${secondi}, stale-while-revalidate=${stantio}`,
             Vary: 'Cookie',
           }
         }
         // Niente `Vary` sulla strada pubblica: con `Vary: Cookie` la CDN di Vercel non conserva la risposta
         // (`x-vercel-cache: MISS` anche alla seconda richiesta). Il corpo non dipende dalla sessione, e la strada
         // con sessione è `private`: nessuna cache condivisa la conserva.
         return {
           'Cache-Control': `public, max-age=${secondi}, s-maxage=${secondi}, stale-while-revalidate=${stantio}`,
         }
       }
       ```
  6. La testata dei comuni dice il vero. In `src/app/api/anagrafiche/comuni/route.ts`, le righe 160-162
     ```ts
      * conservarla. E `Vary: Cookie` sta su ENTRAMBE le strade, perché una cache che
      * avesse già in mano la copia pubblica non deve poterla servire a una richiesta con
      * cookie diversi.
     ```
     diventano:
     ```ts
      * conservarla. `Vary: Cookie` sta SOLO sulla strada con sessione (sessione 13 della seconda
      * serie): sulla strada pubblica la CDN di Vercel non conserverebbe la risposta, e il corpo è
      * lo stesso per tutti. Il paragrafo qui sotto vale ora per la strada con sessione.
     ```
  7. Verdi:
     ```bash
     cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/lib/cache-pubblica.test.ts __tests__/api/iscrizione-sedi.test.ts \
       __tests__/api/iscrizione-model-anonima.test.ts __tests__/api/anagrafiche-comuni.test.ts
     ```
     Atteso: `Test Files  4 passed (4)`.
  8. Commit e push:
     ```bash
     cd /Users/lerri/kidville-web-s13 && git add src/lib/security/cache-pubblica.ts src/app/api/anagrafiche/comuni/route.ts \
       __tests__/lib/cache-pubblica.test.ts __tests__/api/iscrizione-sedi.test.ts \
       __tests__/api/iscrizione-model-anonima.test.ts __tests__/api/anagrafiche-comuni.test.ts
     git commit -m "Cache pubblica, prova 2: niente Vary sulla strada pubblica (con Vary: Cookie la CDN non conserva)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
     git push
     ```
  9. Si misura di nuovo con il Passo 7 del Compito 13, sul deployment nuovo. Se il link di condivisione valeva per
     il solo deployment di prima, il titolare ne crea uno nuovo.
     - `HIT` alla seconda: il ramo B è confermato.
     - `MISS`: si va al ramo C.

- [ ] **Ramo C — nessuna delle due prove basta.**
  1. Si tolgono le due prove:
     ```bash
     cd /Users/lerri/kidville-web-s13 && git revert --no-edit "$(git log --format=%H -1 --grep='Cache pubblica, prova 2')"
     ```
     La prova 1 è già stata tolta all'inizio del ramo B. Si controlla che `src/lib/security/cache-pubblica.ts` sia
     tornato a com'era dopo il Compito 12:
     ```bash
     cd /Users/lerri/kidville-web-s13 && git diff "$(git log --format=%H -1 --grep='Comuni: le intestazioni di cache')" -- src/lib/security/cache-pubblica.ts
     ```
     Atteso: nessuna uscita.
  2. Il motivo letto nei Runtime Logs e le righe `x-vercel-cache` vanno nella PR e nel paragrafo del ramo C in
     `docs/cicd.md` (Compito 15).
  3. S8 resta aperto: lo dice la colonna «Note» della riga 13 della tabella di stato, scritta nella PR della sessione
     (Rilascio, passo 4). Il prossimo candidato è quello che il motivo nomina:
     - un'intestazione aggiunta dal middleware (`src/middleware.ts`), se nomina un `set-cookie`;
     - le intestazioni di `next.config.ts:117-118`;
     - un'impostazione del progetto su Vercel.

    Questa sessione non lo prova: si scrive e si passa avanti. Il resto della sessione non dipende da S8.
  4. Push:
     ```bash
     cd /Users/lerri/kidville-web-s13 && npx vitest run __tests__/lib/cache-pubblica.test.ts && git push
     ```

### Compito 15: `docs/cicd.md` — cache, firewall, errori, login, build

**File:**
- Modifica: `docs/cicd.md`, prima della riga `## Cron di produzione (pg_cron, dentro Supabase)` (360 il 20/10). Le
  sessioni 4 e 5 cambiano lo stesso file prima di questa: la 4 riscrive «Come si lancia», «Monitor esterno», la
  tabella dei comandi, la riga `[backup-vecchio]` e il corpo della sezione «Cron di produzione», di cui tiene il
  titolo; la 5 cambia lì dentro «(passo 6)» in «(passi 9 e 12)». Il numero di riga si sposta: ci si ancora al titolo,
  e la sezione nuova non tocca il testo di quelle due sessioni.

- [ ] **Passo 1: la sezione.** Prima si controlla l'ancora:
  ```bash
  cd /Users/lerri/kidville-web-s13 && grep -n -B2 "^## Cron di produzione (pg_cron, dentro Supabase)$" docs/cicd.md
  grep -c "^## Bordo pubblico" docs/cicd.md
  ```
  Atteso: tre righe, `---`, una vuota e il titolo; poi `0`. Un titolo diverso (per esempio cambiato da una sessione
  prima) si cerca con `grep -n "^## Cron di produzione" docs/cicd.md` e si usa quello che c'è.

  Subito prima di quel titolo, che è preceduto da `---` e da una riga vuota, inserisci il testo qui sotto seguito da
  `---` e da una riga vuota. I `<…>` si riempiono
  con i numeri del Passo 0 e dei Compiti 13-14. Dei quattro paragrafi «Ramo …» resta solo quello successo. Le righe
  che dicono «in attesa» restano così nella PR: le misure arrivano dopo il merge, e le scrive la chiusura della
  sessione 13 (sezione finale «Per la sessione dopo»).

  ````markdown
  ## Bordo pubblico: cache della CDN, firewall, errori, login, build (sessione 13)

  Le porte anonime dell'app sono le voci di `PUBBLICHE` in `__tests__/architecture/gate-coverage.test.ts` (23 il
  20/10). Sono il modulo d'iscrizione (`/api/iscrizione/*`), i moduli pubblici (`/api/public/*`, `/api/forms/submit`),
  la salute (`/api/health*`) e poche altre. Qui sotto:
  - come si legge la cache della CDN;
  - le regole del firewall di Vercel;
  - cosa risponde una porta anonima quando qualcosa si rompe;
  - come si contano i login falliti;
  - la build.

  ### Cache della CDN (S8)

  - **Chi la chiede.** `src/lib/security/cache-pubblica.ts` (`intestazioniCachePubblica`), usata da:
    - `/api/iscrizione/sedi`: 10 minuti;
    - `/api/iscrizione/model`: 5 minuti;
    - `/api/anagrafiche/comuni`: 24 ore.

    Solo sulla risposta buona, e solo senza il cookie di sessione `sb-*-auth-token`. Con il cookie la risposta è
    `private`.
  - **Come si legge.** Due richieste di fila, e `x-vercel-cache` della seconda. `s-maxage` non arriva al client
    (lo consuma la CDN): che manchi non prova niente.
    ```bash
    for i in 1 2; do
      curl -s -o /dev/null -A 'kidville-misura' -D - https://app.kidville.it/api/iscrizione/sedi \
        | grep -iE '^(x-vercel-cache|cache-control|vary|age):'
      sleep 2
    done
    ```
    - Atteso: `x-vercel-cache: HIT`, con `age` > 0, alla seconda.
    - Mai più di qualche richiesta: il 20/10 la 24ª di fila di un client di prova ha preso una sfida `403`.
    - Mai `vercel curl`: crea da solo un token di bypass della protezione.
    - La cache è per regione e per deployment: dopo ogni deploy la prima richiesta è un `MISS`.
  - **Prima:** il 20/10, `MISS` 23 su 23 alle 12:34 UTC e 2 su 2 alle 13:19; `<data e ora del Passo 0.2>`:
    `<risultato>`.
  - **Ramo A** (se è successo questo). La durata dichiarata anche in `Vercel-CDN-Cache-Control` basta: sull'anteprima
    del `<data>`, `HIT` alla seconda richiesta su tutte e tre le rotte.
  - **Ramo B** (se è successo questo).
    - `Vercel-CDN-Cache-Control` non bastava: motivo nei Runtime Logs `<motivo>`.
    - Sulla strada pubblica non c'è più `Vary`. Dal 30/09/2026 la CDN di Vercel non conserva una risposta con
      `Vary: Cookie`.
    - Sull'anteprima del `<data>`, `HIT` alla seconda richiesta. La strada con sessione resta `private` con
      `Vary: Cookie`.
  - **Ramo C** (se è successo questo).
    - Né `Vercel-CDN-Cache-Control` né l'assenza di `Vary` bastano. Motivo nei Runtime Logs: `<motivo>`. Righe
      `x-vercel-cache`: `<righe>`.
    - Le due prove sono state tolte, e S8 resta aperto.
    - Prossimo candidato: `<middleware / next.config.ts / impostazione del progetto, secondo il motivo>`.
  - **Ramo R** (se è successo questo). L'anteprima non si poteva misurare (`<motivo: nessun link di condivisione, o
    500 senza le variabili del database>`). Entra la sola prova 1 (`Vercel-CDN-Cache-Control`); la misura si fa in
    produzione su `/api/iscrizione/sedi`, dopo il merge. Se la prova 1 non basta, S8 resta aperto e la prova 2 la
    decide il titolare.
  - **Dopo il deploy:** in attesa. Le righe `x-vercel-cache` delle tre rotte, con data e ora UTC, le scrive la
    chiusura della sessione 13.

  ### Firewall di Vercel (T8)

  Cinque regole, create dopo il merge della sessione 13 con l'approvazione esplicita del titolare, tutte in
  modalità «log». In «log» la regola conta e non blocca niente. Chiave del limite: l'IP. Finestra: 60 secondi.

  | Nome | Condizione | Azione | Soglia |
  |---|---|---|---|
  | `s13-salute-monitor` | percorso che inizia con `/api/health` **e** user agent `kidville-monitor-esterno`, **oppure** percorso che inizia con `/api/health` **e** user agent `kidville-campanello` | bypass, **prima** di tutte | nessuna |
  | `s13-iscrizione-limite` | percorso che inizia con `/api/iscrizione` | limite di frequenza, «log» | 60 / 60 s |
  | `s13-forms-limite` | percorso che inizia con `/api/forms` | limite di frequenza, «log» | 120 / 60 s |
  | `s13-public-limite` | percorso che inizia con `/api/public` | limite di frequenza, «log» | 60 / 60 s |
  | `s13-salute-limite` | percorso che inizia con `/api/health` | limite di frequenza, «log» | 30 / 60 s |

  - **Perché le soglie sono queste.**
    - `/api/health` ha già un tetto per istanza di 30/60 s per IP (`src/lib/health/porta.ts:53`).
    - `/api/forms` serve anche la segreteria, che da un ufficio esce con un solo IP.
    - Il `<data>` il volume delle 24 ore era: `/api/iscrizione` `<n>`, `/api/forms` `<n>`, `/api/public` `<n>`,
      `/api/health*` `<n>`.
  - **L'eccezione del monitor.**
    - Copre il Worker `monitor-esterno` e il campanello (`scripts/campanello/lettura.mjs`), che leggono
      `/api/health/vivo` e `/api/health`.
    - Un user agent si può falsificare: l'eccezione vale solo sui percorsi `/api/health*`, che hanno comunque il
      tetto per istanza.
  - **L'app nativa non ha un user agent suo.** `capacitor.config.ts` non usa `appendUserAgent`. In una WebView Android
    l'user agent contiene `; wv)`; in iOS manca `Safari/`. È così che la si riconosce nel registro.
  - **Come si leggono.** Il registro sul piano Pro tiene solo le ultime 24 ore, quindi si legge ogni giorno:
    ```bash
    npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall rules list --json
    npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall traffic inspect rule <id della regola> --since 24h --group-by user-agent
    npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall traffic inspect rule <id della regola> --since 24h --group-by asn
    npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall traffic list --since 24h --action challenge --dimension path
    ```
    Si scrivono conteggi, famiglie di user agent e nomi di ASN. Mai un IP, mai un JA4.
  - **Quando si passa dal «log» al blocco.** Mai prima di 7 letture, e solo su decisione del titolare con i numeri
    davanti (specifica, §8, punto 17). Per ogni regola:
    - 0 eventi in 7 giorni: resta in «log», non c'è niente da fermare;
    - eventi solo da client non-browser o da reti di datacenter, nessuno con l'user agent dell'app nativa: si
      propone il passaggio a 429 (`rate_limit`), non a `deny`;
    - anche un solo evento dall'app nativa o da un browser mobile: si alza la soglia e si fanno altri 7 giorni
      di «log».
  - **Letture:** in attesa. Le regole si pubblicano dopo il merge, e da lì partono 7 letture giornaliere in un'issue.
    Numero dell'issue, giorni, tabella e decisione li scrive la chiusura della sessione 13, dopo il settimo giorno.
  - **Come si spengono.** Dal pannello (Firewall → Rules → l'interruttore della regola), oppure:
    ```bash
    npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall rules disable "<nome>" --yes
    npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall publish --yes
    ```

  ### Errori sulle porte anonime (S10)

  - Una porta anonima non risponde mai con il testo di un errore. Le risposte possibili:
    - un guasto del database: `rispostaGuastoDb` / `rispostaGuastoGiaRegistrato` (`src/lib/db/guasto.ts`),
      `LETTURA_FALLITA` o `SCRITTURA_FALLITA`;
    - un'eccezione: `rispostaErroreInterno` / `rispostaErroreInternoGiaRegistrato`
      (`src/lib/api/errore-interno.ts`), `ERRORE_INTERNO`.

    L'errore intero sta nel log, sotto la sua `operazione`: per esempio `iscrizione:POST` o `forms/submit:POST`.
  - Il lock `__tests__/architecture/porte-anonime-senza-errori-interni.test.ts` legge le porte da `PUBBLICHE` e vieta
    `.message` nelle loro risposte.
  - Le route autenticate non sono coperte. Il 20/10, con lo stesso lettore, avevano 319 risposte con `.message`;
    dopo la sessione 13 ne restano 315. Si sistemano quando una sessione tocca il loro file.

  ### Login falliti (T9) e limiti di Auth (S11a)

  - Il login chiama Auth dal browser (`src/app/auth/login/page.tsx:679`). Niente Turnstile (specifica, §8, punto 17),
    e il login non si sposta sul server (punto 12).
  - Questa è la ricetta per contare i tentativi falliti a ogni misura. Strumento: `query_logs` di Supabase (o il
    Logs Explorer). Finestra: 24 ore di un giorno feriale; per più giorni si ripete un giorno alla volta.
    1. Le chiavi esistono? Una volta per fonte:
       ```sql
       select distinct arrayJoin(mapKeys(log_attributes)) as chiave
       from logs where source = 'edge_logs' order by chiave limit 300
       ```
    2. I login con password, per esito:
       ```sql
       select toString(log_attributes['response.status_code']) as stato, count(*) as n,
              uniq(toString(log_attributes['request.headers.cf_connecting_ip'])) as ip_distinti
       from logs where source = 'edge_logs'
         and toString(log_attributes['request.path']) = '/auth/v1/token'
         and toString(log_attributes['request.search']) like '%grant_type=password%'
       group by stato order by n desc
       ```
       - `200` sono i riusciti, `400` le credenziali sbagliate, `429` il limite di Auth scattato.
       - `ip_distinti` è un conteggio: gli indirizzi non escono dalla query.
    3. Il riscontro sui log di Auth:
       ```sql
       select toString(log_attributes['error_code']) as codice, count(*) as n
       from logs where source = 'auth_logs' and toString(log_attributes['path']) = '/token'
       group by codice order by n desc
       ```
  - Se una chiave ha un altro nome (Passo 0.7 della sessione 13: `<differenze, o «nessuna»>`), si usa quello che
    esiste.
  - **I limiti di Auth in produzione.** Non sono nel repository: `supabase/config.toml` vale solo per il Supabase
    locale. Letti dal titolare in Supabase → Authentication → Rate Limits il `<data>`:

    | Limite | Finestra | Locale (`config.toml`) | Produzione |
    |---|---|---|---|
    | `email_sent` | 1 h | 2 | `<n>` |
    | `sms_sent` | 1 h | 30 | `<n>` |
    | `anonymous_users` | 1 h per IP | 30 | `<n>` |
    | `token_refresh` | 5 min per IP | 150 | `<n>` |
    | `sign_in_sign_ups` | 5 min per IP | 30 | `<n>` |
    | `token_verifications` | 5 min per IP | 30 | `<n>` |

    Si rileggono a ogni misura di controllo. Un valore cambiato si scrive qui, con la data.

  ### Build (S12)

  - `npm run build` passa a Node `--max-old-space-size=6144`, lo stesso valore di `.github/workflows/ci.yml`.
  - Chi ha bisogno di più memoria lancia `NODE_OPTIONS=--max-old-space-size=8192 npm run build`: l'opzione di chi
    lancia viene dopo, e vince.
  - Il lock `__tests__/architecture/build-heap-come-in-ci.test.ts` tiene allineati i due valori.

  ---

  ````

- [ ] **Passo 2: commit.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && git add docs/cicd.md
  git commit -m "cicd.md: bordo pubblico — cache della CDN, firewall in «log», errori con codice, login falliti, build" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

## Migrazione

Nessuna. Questa sessione non tocca lo schema. Le fotografie che rigenera nel primo commit (Compito 1, Passo 4) sono
quelle della sessione rilasciata prima, se quella aveva migrazioni; la sessione dopo, per la 13, non ne rigenera
nessuna (sezione «Per la sessione dopo»).

---

## Log

| Dove | Riga | Livello | Quando |
|---|---|---|---|
| `src/lib/api/errore-interno.ts` · `rispostaErroreInterno` | `logErrore({ operazione, stato: 500 }, err)` | error | un'eccezione nel `catch` di `iscrizione:POST`, `forms/submit:POST`, `public/forms/[token]/submit:POST`, `notes:GET/POST`, `parent/competenze:GET`, `admin/competenze/download:GET` |
| `src/app/api/iscrizione/route.ts` (due inserimenti) | `logErrore({ operazione: 'iscrizione:POST', stato: 500, evento: 'db:enrollment_submissions' }, error)` | error | una domanda che non entra. **Nuova**: prima non c'era nessuna riga |
| `src/app/api/notes/route.ts` | `logErrore({ operazione: 'notes:GET'/'notes:POST', stato: 500, evento: 'db:note_disciplinari' }, error)` | error | lettura o scrittura fallita (prima `evento: 'db'`) |
| `src/app/api/notes/route.ts` | `logEvento('notifica', 'error', { operazione: 'notes:POST', esito: 'notifica-genitori-non-accodata' }, e)` | error | la nota è scritta, la notifica ai genitori no. **Nuova**: prima `catch` muto |
| `src/app/api/parent/competenze/route.ts` | `logEvento('storage', 'error', { operazione: 'parent/competenze:GET', esito: 'url-firmato-non-creato', entita_id }, erroreFirma)` | error | il link al certificato non si firma. **Nuova** |
| `src/app/api/admin/competenze/download/route.ts` | `logEvento('storage', 'error', { operazione: 'admin/competenze/download:GET', esito: 'url-firmato-non-creato', entita_id }, erroreFirma)` | error | idem, lato segreteria. **Nuova** |
| `primaria/allegati`, `primaria/fascicolo`, `cassa/store`, `competenze/certificato-store`, `primaria/pagella-store`, `protocolli/store` | `logEvento('storage', 'warn', { operazione, bucket, esito: 'bucket_non_verificato'[, entita_id] }, erroreElenco)` | warn | `listBuckets()` non risponde. **Nuova** |
| `src/lib/protocolli/store.ts` · `ensureBucket` | `logEvento('storage', 'info', { operazione: 'protocolli/store:ensureBucket', bucket, esito: 'creazione-saltata' }, e)` | info | `createBucket` lancia, di solito per una corsa. **Nuova**: prima `catch` muto |

- Le righe già scritte una riga sopra non si raddoppiano: `modello-non-letto`, `utente-non-letto`,
  `compilazione-non-registrata`, e il guasto di `sediReali`. Per questo esistono le due varianti «già registrato».
- I successi critici di queste route sono già loggati e non cambiano (`compilazione-registrata`).
- Nessun dato personale: solo uuid (`entita_id`), nomi di bucket e codici. La redazione è a lista bianca e
  questa sessione non le aggiunge chiavi.

---

## PRD

- [ ] **Passo 1: la voce.** In cima a `PRD REGISTRO ELETTRONICO.md`, prima della riga 1, inserisci la voce qui sotto
  seguita da una riga vuota. I `<…>` si riempiono con i numeri misurati.
  ```markdown
  ## 🛡️ Changelog — Robustezza, seconda serie, sessione 13: bordo pubblico — cache, firewall, errori, login, build — <AAAA-MM-GG> (branch `robustezza2/s13-bordo-pubblico`)

  **Stato:** 🔄 in revisione (PR #<n>). Nessuna migrazione. Le regole del firewall si creano dopo il merge, in «log» per 7 giorni. «In produzione», cache dopo, letture del firewall e misura di controllo li scrive la sessione che apre dopo (piano, «Per la sessione dopo»). Domande d'iscrizione contate il <data> alle <ora> UTC: **<n>**.

  - **Errori sulle porte anonime (S10).**
    - Il 20/10 nove risposte di quattro porte anonime mandavano a chiunque il testo dell'errore: `iscrizione` (3), `iscrizione/sedi` (1), `forms/submit` (4), `public/forms/[token]/submit` (1). La specifica ne contava 3.
    - Ora rispondono `LETTURA_FALLITA`, `SCRITTURA_FALLITA` o `ERRORE_INTERNO`, con la traduzione in it/en, e l'errore intero va nel log.
    - Funzioni nuove: `rispostaGuastoGiaRegistrato` (`src/lib/db/guasto.ts`) e `rispostaErroreInterno` (`src/lib/api/errore-interno.ts`).
    - Lock nuovo: `porte-anonime-senza-errori-interni`.
    - L'inserimento fallito di una domanda d'iscrizione ora lascia una riga di log; prima non ne lasciava nessuna.
    - Restano 315 risposte con `.message` sulle route autenticate: si sistemano quando una sessione tocca il loro file.
  - **Silenzi chiusi.**
    - La notifica ai genitori di una nota disciplinare non accodata (`notes`, prima `catch` muto).
    - I due URL firmati dei certificati delle competenze.
    - I sei `listBuckets()` senza `error`, che creavano il bucket alla cieca.
    - Il `catch` muto di `protocolli/store`.
    - Il lock `errori-postgrest-guardati` ha una quinta forma: lo Storage col solo `data`.
    - Il risultato di `createBucket`/`updateBucket` resta ignorato: da fare in una sessione futura.
  - **Tetti alla misura vera.** Errori senza codice 1350 → 1331 (264 → 262 file), dai valori lasciati dalla sessione 2 (il 20/10 erano 1361 e 270); `catch` con soli commenti 49 → 47 (37 → 35 file).
  - **Cache della CDN (S8).**
    - Prima: `MISS` <n>/<n> il <data>.
    - Ramo <A/B/C>: <una riga: cosa ha mostrato l'anteprima, cosa è cambiato in `src/lib/security/cache-pubblica.ts`>.
    - I comuni ora passano dalla stessa funzione di sedi e modello.
  - **Firewall (T8).**
    - Cinque regole in «log» (`s13-*`), descritte in `docs/cicd.md`, con l'eccezione per il monitor esterno e il campanello.
    - Prima: sfide `403` <n> nelle 24 ore del <data>.
    - Il blocco si decide dopo 7 letture.
  - **Login (T9, S11a).** Ricetta per contare i login falliti e tabella dei limiti di Auth di produzione in `docs/cicd.md`. Niente Turnstile.
  - **Build (S12).** `npm run build` con `--max-old-space-size=6144` come in CI. Lock `build-heap-come-in-ci`.
  ```

- [ ] **Passo 2: commit.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && git add "PRD REGISTRO ELETTRONICO.md"
  git commit -m "PRD: sessione 13 della seconda serie, bordo pubblico" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

## Rilascio

- [ ] **1. Gate locale, tutto.**
  ```bash
  cd /Users/lerri/kidville-web-s13 && npx eslint . --max-warnings 0 && npx tsc --noEmit && CI=1 npx vitest run \
    && NODE_OPTIONS=--max-old-space-size=8192 npm run build
  ```
  - Atteso: eslint e tsc senza uscita.
  - vitest: `Test Files  N passed (N)`, nessun `failed`.
  - build: uscita 0 con la tabella delle rotte.
  - Una riga rossa ferma il rilascio.

- [ ] **2. Le domande d'iscrizione, contate di nuovo** (`SELECT count(*) FROM enrollment_submissions;`). Il numero e
  l'ora UTC vanno nella voce del PRD, al posto di quelli del Passo 0.1. Poi un commit
  `"PRD: conteggio d'iscrizione al rilascio"`, con la riga Co-Authored-By.

- [ ] **3. Nessun ramo di prova aperto, poi push e PR.** Prima della PR vera si controlla che della sessione 13 esista
  un ramo solo (§5 e U2 bis: la sessione dopo cerca **una** PR `head:robustezza2/s13-`):
  ```bash
  git -C /Users/lerri/kidville-web fetch origin --prune
  git -C /Users/lerri/kidville-web ls-remote --heads origin 'robustezza2/s13-*'
  git -C /Users/lerri/kidville-web worktree list | grep 'kidville-web-s13'
  gh pr list --repo erricoluigi17/kidville-web --state open --search "head:robustezza2/s13-" --json number,headRefName --jq '.[] | "\(.number) \(.headRefName)"'
  ```
  - Atteso: `ls-remote` stampa al più una riga, `refs/heads/robustezza2/s13-bordo-pubblico` (c'è se il Compito 13 ha
    già fatto il push per l'anteprima); `worktree list` una riga sola, `/Users/lerri/kidville-web-s13`; `gh pr list`
    nessuna riga.
  - Un altro ramo `robustezza2/s13-…` (per esempio `robustezza2/s13-cache-prova-2`) si chiude **ora**, prima della PR:
    ```bash
    gh pr close <numero> --repo erricoluigi17/kidville-web --delete-branch
    git -C /Users/lerri/kidville-web push origin --delete <ramo>
    git -C /Users/lerri/kidville-web worktree remove <percorso del suo worktree>
    git -C /Users/lerri/kidville-web branch -D <ramo>
    ```
    La prima riga solo se ha una PR (e allora la seconda non serve più); la terza solo se ha un worktree. Poi si
    rilanciano i quattro comandi di controllo, finché l'atteso torna.

  Poi il push e la PR:
  ```bash
  cd /Users/lerri/kidville-web-s13 && git push -u origin robustezza2/s13-bordo-pubblico
  gh pr create --base main --head robustezza2/s13-bordo-pubblico \
    --title "Robustezza 2, sessione 13: bordo pubblico — errori con codice, cache della CDN, build come in CI" \
    --body-file - <<'EOF'
  ## Cosa cambia

  - **Porte anonime senza errori interni (S10).**
    - Erano 9 risposte in 4 handler (`iscrizione:POST` 3, `iscrizione/sedi:GET` 1, `forms/submit:POST` 4, `public/forms/[token]/submit:POST` 1).
    - Ora rispondono `LETTURA_FALLITA`, `SCRITTURA_FALLITA` o `ERRORE_INTERNO`, e l'errore intero va nel log.
    - Lock nuovo: `porte-anonime-senza-errori-interni`.
  - **Silenzi chiusi.** Il `catch` muto della notifica delle note, i 2 URL firmati delle competenze, i 6 `listBuckets()` senza `error`, il `catch` muto di `protocolli/store`. Il lock `errori-postgrest-guardati` ha una quinta forma, lo Storage.
  - **Tetti alla misura vera.** Errori senza codice 1350 → 1331 (264 → 262 file), dai valori lasciati dalla sessione 2; `catch` con soli commenti 49 → 47.
  - **Cache della CDN (S8).** Ramo <A/B/C/R>. Righe `x-vercel-cache` dell'anteprima: <righe, oppure «nel ramo R si misura dopo il merge»>. Motivo nei Runtime Logs: <motivo, se letto>.
  - **Build (S12).** `npm run build` con l'heap della CI; lock `build-heap-come-in-ci`.
  - **`docs/cicd.md`.** Cache, firewall (5 regole in «log»), errori, ricetta dei login falliti, limiti di Auth.
  - **Specifica.** Riga 13 della tabella di stato a «in revisione».

  ## Misure prima (<data>, UTC)

  - Domande d'iscrizione: <n> alle <ora>.
  - `x-vercel-cache` sulle sedi: <righe>.
  - Sfide `403` nelle 24 ore: <n>; percorsi: <top 5>.
  - «Failed to fetch» / «Load failed» per giorno feriale: <tabella>.
  - Chiamanti di `/api/health*`: <famiglie di user agent e conteggi>.

  ## Fuori da questa PR

  - Le regole del firewall: si creano dopo il merge, con l'approvazione esplicita del titolare, in «log» per 7 giorni.
  - La cache dopo il deploy va in un commento di questa PR; le 7 letture del firewall in un'issue.
  - «In produzione», la cache dopo, la misura di controllo e la tabella del firewall nella specifica, nel PRD e in `docs/cicd.md` li scrive la chiusura della sessione 13, nel primo commit della sessione che apre dopo (sezione «Per la sessione dopo» del piano).
  - Nessuna migrazione.

  ## Gate

  eslint · tsc · vitest (<N> file) · build con 8192: verdi.

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  ```
  Atteso: l'URL della PR. Il suo numero serve al passo 4.

- [ ] **4. La riga di stato «in revisione» e il numero della PR nel PRD, nella PR stessa.** La riga si trova per
  contenuto, mai per numero:
  ```bash
  cd /Users/lerri/kidville-web-s13 && grep -n "^| 13 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
  ```
  Atteso: una riga, oggi
  ```markdown
  | 13 | Bordo pubblico: cache, firewall, errori, login, build | S8, S10, S11, S12 (build) | — | da fare | — | `s13-bordo-pubblico` | T8, T9; misura di controllo a fine sessione |
  ```
  Si sostituisce **quella** riga, trovata col testo, con:
  ```markdown
  | 13 | Bordo pubblico: cache, firewall, errori, login, build | S8, S10, S11, S12 (build) | — | in revisione | #<numero della PR> | `docs/superpowers/plans/2026-10-20-robustezza2-s13-bordo-pubblico.md` | T8, T9; ramo S8 <A/B/C/R><, se B o C o R senza HIT: «S8 aperto: <motivo in poche parole>»>; cache dopo, misura di controllo e 7 letture del firewall: maturano dopo il merge (piano, «Per la sessione dopo») |
  ```
  - Lo Stato si scrive «in revisione», con queste parole. «In produzione», il commit di `main` e le misure li scrive
    **solo** la sessione che apre dopo (§5, «La tabella di stato»).
  - Nella voce del PRD, `PR #<n>` prende il numero vero.
  ```bash
  grep -c "^| 13 | .* | in revisione | #" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
  grep -n "in revisione (PR #" "PRD REGISTRO ELETTRONICO.md" | head -3
  git add docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md "PRD REGISTRO ELETTRONICO.md"
  git commit -m "Sessione 13: riga di stato in revisione, numero della PR nel PRD" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push
  ```
  Atteso: `1`; la voce della sessione 13 fra le righe stampate; il push aggiorna la PR.

- [ ] **5. CI verde su tutti i job.**
  ```bash
  gh pr checks <n> --watch
  ```
  - Atteso: ogni job `pass`.
  - Un E2E `cancelled` non è rosso: con più PR pubblicate di fila, il gruppo `e2e-ci-db` annulla quelli in coda. Si
    rilancia con `gh run rerun <id> --failed`.
  - «CI verde» vuol dire tutti i job, non solo quelli richiesti.

- [ ] **6. Merge a mano del titolare.** Mai auto-merge (specifica, §5). Gli si mostra:
  - il link della PR;
  - l'esito dei job;
  - le righe `x-vercel-cache` dell'anteprima (nel ramo «R» non ci sono: si dice).

  Lui fa il merge. Poi si aspetta che il deployment di produzione sia «Ready»: il workflow `dopo-deploy` del
  campanello lo controlla da sé.

- [ ] **7. Cache, dopo.** In produzione, due richieste di fila per rotta, a due secondi:
  ```bash
  for rotta in /api/iscrizione/sedi /api/iscrizione/model '/api/anagrafiche/comuni?provincia=NA'; do
    for i in 1 2; do
      echo "--- $rotta ($i)"
      curl -s -o /dev/null -A 'kidville-misura-s13' -D - "https://app.kidville.it$rotta" \
        | grep -iE '^(HTTP/|x-vercel-cache|cache-control|vary|age):'
      sleep 2
    done
  done
  ```
  - Atteso: `HIT` alla seconda richiesta di ogni rotta, con `age` > 0.
  - Nel ramo «R» del Compito 13 si misura solo la prima rotta, e si segue quel ramo.
  - Le righe, con data e ora UTC, vanno in un commento della PR mergiata:
    ```bash
    gh pr comment <n> --repo erricoluigi17/kidville-web --body-file - <<'EOF'
    Cache dopo il deploy, <AAAA-MM-GG hh:mm> UTC:
    <righe x-vercel-cache, cache-control, vary e age delle due richieste per rotta>
    EOF
    ```
    Da lì le copia in `docs/cicd.md` e nella tabella di stato la chiusura della sessione 13. Nessun ramo e nessuna PR
    per scriverle (§5).

- [ ] **8. Le regole del firewall, preparate.** Dopo il merge, perché prima va misurato il traffico che la cache
  toglie (specifica, §8, punto 13). Le soglie e i nomi sono quelli del Compito 15. Si preparano, ma **non si
  pubblicano**:
  ```bash
  V='npx vercel@64.7.0 --cwd /Users/lerri/kidville-web'
  eval "$V firewall rules add 's13-salute-monitor' \
    --condition '{\"type\":\"path\",\"op\":\"pre\",\"value\":\"/api/health\"}' \
    --condition '{\"type\":\"user_agent\",\"op\":\"eq\",\"value\":\"kidville-monitor-esterno\"}' \
    --or \
    --condition '{\"type\":\"path\",\"op\":\"pre\",\"value\":\"/api/health\"}' \
    --condition '{\"type\":\"user_agent\",\"op\":\"eq\",\"value\":\"kidville-campanello\"}' \
    --action bypass --description 'Sessione 13: monitor esterno e campanello fuori dai limiti di /api/health' --yes"
  for coppia in 'iscrizione:/api/iscrizione:60' 'forms:/api/forms:120' 'public:/api/public:60' 'salute:/api/health:30'; do
    nome="${coppia%%:*}"; resto="${coppia#*:}"; percorso="${resto%%:*}"; soglia="${resto##*:}"
    eval "$V firewall rules add 's13-$nome-limite' \
      --condition '{\"type\":\"path\",\"op\":\"pre\",\"value\":\"$percorso\"}' \
      --action rate_limit --rate-limit-window 60 --rate-limit-requests $soglia \
      --rate-limit-keys ip --rate-limit-action log \
      --description 'Sessione 13: limite in log per 7 giorni' --yes"
  done
  eval "$V firewall rules reorder 's13-salute-monitor' --first --yes"
  eval "$V firewall diff"
  ```
  - Atteso: `firewall diff` mostra 5 regole nuove, `s13-salute-monitor` in cima, tutte le `-limite` con azione
    `log`.
  - Un'opzione che la CLI rifiuta si sostituisce con quella del suo `--help` (Passo 0.0).
  - Se il titolare preferisce il pannello, le stesse 5 regole le crea lui da Firewall → Rules. Si salta al passo 10.

- [ ] **9. Approvazione esplicita, poi la pubblicazione.** Al titolare si mostrano l'uscita di `firewall diff` e la
  tabella del Compito 15, e gli si chiede: «Pubblico queste 5 regole in modalità log?». Solo dopo un sì esplicito, in
  chat:
  ```bash
  npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall publish --yes
  npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall rules list --expand
  ```
  - Atteso: le 5 regole attive.
  - Si annotano gli id delle regole e l'ora UTC: da qui partono i 7 giorni.
  - Senza un sì: `npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall discard --yes`, e ci si ferma qui.
    L'issue del passo 10 non si apre. Lo si scrive nella PR mergiata, perché la chiusura della sessione 13 lo trovi:
    `gh pr comment <n> --repo erricoluigi17/kidville-web --body "Regole del firewall non pubblicate: manca il sì del titolare."`.

- [ ] **10. L'issue delle letture, e la prima.** Si apre una issue:
  ```bash
  gh issue create --repo erricoluigi17/kidville-web --title "Sessione 13 · firewall in «log»: letture giornaliere" --body "Regole s13-* pubblicate il <data> alle <ora> UTC. Una lettura al giorno per 7 giorni: conteggi, famiglie di user agent, nomi di ASN. Mai IP, mai JA4. Tabella e decisione: piano della sessione 13, sezione «Per la sessione dopo»."
  ```
  Il numero dell'issue va in un commento della PR mergiata (`gh pr comment <n> --repo erricoluigi17/kidville-web --body "Letture del firewall: issue #<numero>, regole pubblicate il <AAAA-MM-GG hh:mm> UTC"`):
  è da lì che la chiusura della sessione 13 la ritrova.

  La prima lettura si fa oggi, con i comandi della sezione «Firewall di Vercel» di `docs/cicd.md`. In un commento
  della issue (`gh issue comment <numero> --body-file -`) si scrivono:
  - per ogni regola, gli eventi oltre soglia, le 5 famiglie di user agent e i 5 ASN più frequenti;
  - le sfide `403` del giorno, totale e 5 percorsi più frequenti;
  - la riga del giorno della query del Passo 0.4 («Failed to fetch», «Load failed»).

  Le altre sei letture, una al giorno (il registro del firewall tiene 24 ore), le fa il titolare o una sessione che
  lui avvia, in sola lettura, con gli stessi comandi e lo stesso formato. Non servono rami né PR: sono commenti
  dell'issue. Tabella, coincidenza con gli errori di rete e decisione sul blocco sono nella sezione «Per la sessione
  dopo», perché maturano al settimo giorno.

- [ ] **11. Pulizia: solo il ramo e il worktree di questa sessione.** Dopo il merge si cancellano il ramo del codice e
  il suo worktree. I rami di altre sessioni con una PR aperta restano.
  ```bash
  git -C /Users/lerri/kidville-web worktree remove /Users/lerri/kidville-web-s13
  git -C /Users/lerri/kidville-web branch -D robustezza2/s13-bordo-pubblico
  git -C /Users/lerri/kidville-web push origin --delete robustezza2/s13-bordo-pubblico
  ```
  - Atteso: `git -C /Users/lerri/kidville-web branch -a --list '*s13*'` non stampa niente. Un ramo di prova non può
    esserci più: si è chiuso al passo 3.

---

## Ritorno indietro

- **Il codice.**
  - Subito: Instant Rollback di Vercel al deployment di produzione precedente. Lo fa il titolare dal pannello
    (Deployments → il deployment precedente → «Instant Rollback»).
  - Poi una PR di revert:
    ```bash
    git -C /Users/lerri/kidville-web fetch origin
    git -C /Users/lerri/kidville-web worktree add /Users/lerri/kidville-web-s13-revert -b revert/s13-bordo-pubblico origin/main
    cd /Users/lerri/kidville-web-s13-revert && git revert --no-edit <sha del merge della sessione 13 su main>
    ```
    Poi gate, PR, CI verde su tutti i job, merge a mano del titolare. Il revert riporta anche i tetti dei lock ai
    valori di prima, che tornano veri insieme al codice di prima.
- **La cache.**
  - Se una risposta sbagliata restasse nella CDN (per esempio un elenco di sedi vecchio), scade da sola: 10 minuti
    le sedi, 5 il modello, 24 ore i comuni.
  - Per farla sparire subito, il titolare svuota la cache dal pannello (Settings → Caches → Purge CDN Cache).
- **Il firewall.**
  - In «log» le regole non bloccano niente, e toglierle non è urgente.
  - Per spegnerne una: dal pannello (Firewall → Rules → l'interruttore), oppure
    `npx vercel@64.7.0 --cwd /Users/lerri/kidville-web firewall rules disable "<nome>" --yes` seguito da
    `firewall publish --yes`. Se `disable` non esiste nell'aiuto, si usa `rules edit … --disabled`.
  - Una regola passata a 429 che ferma l'app nativa si riporta a «log» nello stesso modo, subito, prima di capire
    perché.
- **Il database.** Niente da fare: nessuna migrazione.
- **Il PRD.** Una voce datata che dice cosa è stato tolto e perché.

---

## Per la sessione dopo

Questa sezione la esegue la sessione che apre **dopo** il rilascio della sessione 13, nel suo primo commit, prima di
ogni codice (§5, «Apertura di una sessione: la chiusura della precedente»). Chi la esegue non ha letto il resto di
questo piano: qui c'è tutto. Le query sono in **sola lettura**; i comandi partono dalla radice del worktree della
sessione che chiude. Due misure maturano più tardi (punti 5 e 6): se il giorno non è ancora arrivato si scrive
«matura dal …» e le scrive la prima PR che tocca la specifica dopo quel giorno (§5). La sessione 14, l'ultima, le
raccoglie comunque nel suo ramo `robustezza2/s14-esito`.

**Che cosa ha lasciato la sessione 13.** Nessuna migrazione: niente fotografie da rigenerare per questa sessione
(nemmeno `migrazioni-applicate-snapshot.json`), nessuna voce da togliere da `MIGRAZIONI_ATTESE_AL_MERGE` né da altre
liste. Restano la riga di stato, il PRD, `docs/cicd.md` e le misure. Il numero della PR è nella colonna «PR» della
riga `^| 13 |`; la cache dopo il deploy e il numero dell'issue del firewall sono in due commenti di quella PR.

- [ ] **1. PR, commit di `main` e commenti.**
  ```bash
  N=$(grep "^| 13 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md | awk -F'|' '{print $7}' | tr -dc '0-9')
  echo "PR $N"
  gh pr view "$N" --repo erricoluigi17/kidville-web --json mergeCommit,mergedAt --jq '"\(.mergeCommit.oid[0:8]) \(.mergedAt)"'
  gh pr view "$N" --repo erricoluigi17/kidville-web --comments | tail -80
  ```
  Atteso: il numero della PR; il commit corto e la data del merge; fra i commenti uno che comincia con «Cache dopo il
  deploy» e uno con «Letture del firewall: issue #» (oppure «Regole del firewall non pubblicate»). Se manca il commento
  della cache, la misura si rifà ora, in sola lettura, con due richieste a due secondi per rotta:
  ```bash
  for rotta in /api/iscrizione/sedi /api/iscrizione/model '/api/anagrafiche/comuni?provincia=NA'; do
    for i in 1 2; do
      echo "--- $rotta ($i)"
      curl -s -o /dev/null -A 'kidville-misura-s13' -D - "https://app.kidville.it$rotta" \
        | grep -iE '^(HTTP/|x-vercel-cache|cache-control|vary|age):'
      sleep 2
    done
  done
  ```
  Il ramo S8 della sessione (A, B, C o R) è scritto nella colonna «Note» della riga 13 e nella sezione «Bordo
  pubblico» di `docs/cicd.md`: è il paragrafo «Ramo …» rimasto.

- [ ] **2. La riga di stato a «in produzione».**
  ```bash
  grep -n "^| 13 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
  ```
  Atteso: una riga con Stato «in revisione». Si sostituisce quella riga, trovata col testo, con:
  ```markdown
  | 13 | Bordo pubblico: cache, firewall, errori, login, build | S8, S10, S11, S12 (build) | — | in produzione | #<n> | `docs/superpowers/plans/2026-10-20-robustezza2-s13-bordo-pubblico.md` | in produzione il <data UTC del merge>, `main` `<commit corto>`; ramo S8 <A/B/C/R>, cache dopo del <data e ora UTC>: sedi <HIT/MISS>, modello <HIT/MISS>, comuni <HIT/MISS> alla 2ª<; se non HIT: «S8 aperto: <motivo>»>; T8 in «log» dal <data>, issue #<numero>: matura dal <data di pubblicazione + 7 giorni>; misura di controllo: matura dal <primo giorno feriale intero dopo il merge>; T9 ricetta in `docs/cicd.md` |
  ```
  - Le misure vanno nella colonna «Note», non in «Dopo»: «Dopo» elenca i prerequisiti e resta `—`.
  - Nel ramo R le rotte misurate sono quelle del commento: se c'è solo `/api/iscrizione/sedi`, le altre due si
    scrivono «non misurata».
  - Senza regole pubblicate: «T8 non pubblicato: manca il sì del titolare» al posto della parte sul firewall, e il
    punto 6 si salta.

- [ ] **3. La cache dopo, in `docs/cicd.md`.** Nella sezione `## Bordo pubblico: cache della CDN, firewall, errori,
  login, build (sessione 13)` si cerca la riga che comincia con `- **Dopo il deploy:** in attesa.` e la si sostituisce,
  insieme alla riga che la segue, con:
  ```markdown
  - **Dopo il deploy:** <AAAA-MM-GG hh:mm> UTC, seconda richiesta: sedi `<HIT/MISS>`, modello `<HIT/MISS>`, comuni
    `<HIT/MISS>` (righe nel commento della PR #<n>).
  ```
  Se il paragrafo rimasto è il «Ramo R», gli si aggiunge in fondo:
  «Misura del <data>: `<HIT/MISS>` alla seconda richiesta su `/api/iscrizione/sedi`.» e, con `MISS`, «Motivo nei
  Runtime Logs: <motivo>.» (il motivo è nel commento della PR, se il titolare l'ha letto).
  ```bash
  grep -n "Dopo il deploy:\*\* in attesa\|Letture:\*\* in attesa" docs/cicd.md
  ```
  Atteso dopo la modifica: una riga sola, quella delle letture (la toglie il punto 6).

- [ ] **4. Lo Stato della voce nel PRD.**
  ```bash
  grep -n "Robustezza, seconda serie, sessione 13" "PRD REGISTRO ELETTRONICO.md"
  ```
  Atteso: una riga, il titolo della voce. Due righe sotto c'è `**Stato:** 🔄 in revisione (PR #<n>). …`: si
  sostituisce solo la parte prima di «Domande d'iscrizione contate», che resta com'è, così:
  ```markdown
  **Stato:** ✅ in produzione dal <data UTC del merge> (PR #<n>, `main` `<commit corto>`). Nessuna migrazione. Cache dopo il deploy: sedi <HIT/MISS> alla seconda richiesta. Firewall in «log» dal <data>, letture nell'issue #<numero>; tabella e decisione maturano dal <data>. Domande d'iscrizione contate il …
  ```

- [ ] **5. Misura di controllo (§5, «Misure di controllo»).** Matura dal **primo giorno feriale intero dopo il
  merge**: le 24 ore lette devono essere tutte successive al deploy. Prima di quel giorno si lascia «matura dal …»
  nella riga 13. Le query sono in sola lettura, con lo strumento `query_logs` di Supabase sulle 24 ore di quel giorno.
  - La query 2 bis con il filtro su `/auth/v1/user`. I nomi delle chiavi sono quelli letti dal Passo 0.7 di questo
    piano (`request.cf.colo`, `request.headers.x_client_info`, `request.path`, `response.origin_time`); se una query
    torna vuota, si rileggono con la prima query del Passo 0.7.
    ```sql
    select toString(log_attributes['request.cf.colo']) as colo, count(*) as n,
      round(quantile(0.5)(toFloat64OrZero(toString(log_attributes['response.origin_time']))),0) as p50,
      round(quantile(0.95)(toFloat64OrZero(toString(log_attributes['response.origin_time']))),0) as p95
    from logs where source='edge_logs'
      and toString(log_attributes['request.headers.x_client_info']) like '%createServerClient'
      and toString(log_attributes['request.path']) = '/auth/v1/user'
    group by colo order by n desc limit 8
    ```
  - La stessa query con la finestra dello strumento su 07:55–08:05 UTC dello stesso giorno: è la punta che serve
    alla soglia della sessione 14 (p95 sopra 300 ms, oppure più di 200.000 chiamate nelle 24 ore).
  - La query 4, con `execute_sql`:
    ```sql
    SELECT pg_size_pretty(pg_database_size(current_database())) AS db,
      (SELECT pg_size_pretty(sum((metadata->>'size')::bigint)) FROM storage.objects) AS storage;
    ```
    ```sql
    SELECT bucket_id, count(*) AS oggetti, round(sum((metadata->>'size')::bigint)/1024.0/1024/1024,2) AS gb
    FROM storage.objects GROUP BY bucket_id ORDER BY gb DESC;
    ```
  - Si scrive nella colonna «Note» della riga 13, al posto di «misura di controllo: matura dal …»:
    «misura di controllo del <data>: 2 bis `/auth/v1/user` 24 h <n> chiamate, p50 <n> ms, p95 <n> ms, punta
    07:55–08:05 p95 <n> ms; DB <n> MB, Storage <n> GB (`gallery`+`video_originals` <n> GB)».
  - Se `gallery` + `video_originals` superano **20 GB**, la nota lo dice: è la soglia di T2 (specifica, §4, T2; il
    20/10 erano 13,2 GB). La decisione è del titolare.

- [ ] **6. Firewall: tabella e decisione (T8).** Matura dal **settimo giorno dopo la pubblicazione** delle regole (data
  e ora nel commento «Letture del firewall: issue #…» della PR). Si salta se le regole non sono state pubblicate.
  ```bash
  gh issue view <numero> --repo erricoluigi17/kidville-web --comments | tail -150
  ```
  - Atteso: sette commenti di lettura, uno per giorno. Con meno di sette la misura non è matura: resta «matura dal
    …» nella riga 13, e la scrive la prima PR che tocca la specifica dopo la settima lettura. Le letture mancanti
    non si inventano e non si ricostruiscono: il registro del firewall tiene 24 ore.
  - Con le sette letture si mette in tabella, giorno per giorno:

    | giorno | sfide `403` (tutte) | sfide su `/api/*` | Failed to fetch | Load failed |
    |---|---|---|---|---|

    La conclusione si scrive con i numeri accanto, e tiene separati «osservato» e «causa probabile». Per esempio:
    «nei 7 giorni, i 2 giorni con più sfide sono / non sono quelli con più errori di rete».
  - **Condizionale: la decisione sul blocco la prende il titolare**, non chi esegue. Gli si portano la tabella e, per
    ogni regola, la riga della «Regola di decisione» della sezione «Firewall di Vercel» di `docs/cicd.md`.
    - Un passaggio a 429 si fa solo dopo un suo **sì esplicito**, in chat: `npx vercel@64.7.0 --cwd
      /Users/lerri/kidville-web firewall rules edit "<nome>" …` col valore che la regola di decisione indica, poi
      `firewall diff`, che gli si mostra, poi `firewall publish --yes`.
    - Senza un sì, tutto resta in «log», e la decisione si scrive così: «resta in log».
  - Si scrive:
    - in `docs/cicd.md`, al posto della riga che comincia con `- **Letture:** in attesa.` e della riga che la segue:
      «- **Letture:** issue #<numero> (dal <data> al <data>); sfide `403` <media>/giorno; decisione del <data>:
      <resta in log / 429 su …>.», seguita dalla tabella, rientrata di due spazi sotto la voce;
    - nella colonna «Note» della riga 13, al posto di «T8 in «log» dal <data>, issue #<numero>: matura dal …»:
      «T8: <media> sfide `403`/giorno su 7 letture (issue #<numero>), decisione del <data>: <decisione>»;
    - nella voce del PRD, sotto «**Firewall (T8).**», una riga in più: «    - Dopo 7 letture: <media> sfide `403`
      al giorno; decisione del <data>: <decisione>.».
  - Poi si chiude l'issue:
    `gh issue close <numero> --repo erricoluigi17/kidville-web --comment "Tabella e decisione nella specifica e in docs/cicd.md."`

- [ ] **7. S8 resta aperto? (condizionale).** Solo se il ramo è B, C, oppure R con `MISS`: la colonna «Note» lo dice
  già («S8 aperto: <motivo>»). Qui non si prova niente: la prova 2 è scritta nel ramo B del Compito 14 di questo
  piano, e se farla lo decide il titolare, col motivo letto davanti. Con il ramo A, o R con `HIT`, S8 è chiuso.

- [ ] **8. Che cosa entra nel commit.** Il commit lo fa il passo di chiusura della sessione che apre. Fotografie:
  nessuna. File: la specifica, il PRD e `docs/cicd.md`. `docs/cicd.md` non è nel `git add` generico di quel passo:
  si aggiunge per nome.
  ```bash
  git add docs/cicd.md docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md "PRD REGISTRO ELETTRONICO.md"
  grep -c "^| 13 | .* | in produzione | #" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
  ```
  Atteso: `1`.

---


## Autorevisione

**Copertura della specifica (§7, Sessione 13):**
- «Misura prima»: `x-vercel-cache` (Passo 0.2), sfide `403` (0.3), «Failed to fetch»/«Load failed» per giorno
  feriale (0.4). ✔
- S8, prima la diagnosi.
  - L'ordine `Vercel-CDN-Cache-Control` → `Vary` senza `Cookie` è quello dei Compiti 13 e 14.
  - La lettura è con due richieste e `x-vercel-cache`, mai `vercel curl`.
  - Il titolare apre l'anteprima; il ripiego in produzione su una sola route è il ramo «R».
  - I tre rami, più il ripiego «R», sono scritti per intero. ✔
- S8, coincidenza tra sfide ed errori di rete: matura al settimo giorno, «Per la sessione dopo», punto 6. ✔
- T8.
  - Regole su `/api/iscrizione`, `/api/forms`, `/api/health` (più `/api/public`, Scelte punto 6), scritte in
    `docs/cicd.md`, con l'eccezione per il monitor.
  - «Log» per 7 giorni; il blocco si decide sui numeri.
  - Le applica il titolare o l'agente col suo sì esplicito.
  - Chi chiama `/api/health*` è verificato nel Passo 0.5. ✔
- Funzione col solo `codice` e log intero, sulle porte anonime: Compiti 2, 3, 5, 6. ✔
- Lock che vieta `.message` nelle porte anonime: Compito 4. ✔
- I numeri veri al posto di «3» e «~181»: Scelte, punti 1-2. ✔
- Il `catch` muto di `notes`: Compito 7. ✔
- Le 8 letture dello Storage senza `error`: Compiti 8-9. ✔
- `build` con `--max-old-space-size=6144`: Compito 11. ✔
- T9: ricetta in `docs/cicd.md` con `query_logs`, finestra e filtro (Compito 15); niente Turnstile. ✔
- S11a, i limiti di Auth annotati: Passo 0.8 e Compito 15. ✔
- «Rischio» (una regola che blocca l'app nativa): il «log» e la regola di decisione (Compito 15); l'app nativa
  senza un user agent suo è scritta. ✔
- «Indietro»: sezione Ritorno indietro. ✔
- «Prova»: `HIT` dalla seconda richiesta (Rilascio, passo 7), sfide al giorno (passo 10 e issue), il lock rosso su una
  regressione (Compito 4, controllo positivo). ✔
- «A fine sessione», misura di controllo: query 2 bis con `/auth/v1/user` e query 4 nella tabella di stato
  (colonna «Note» della riga 13), scritte da chi chiude la sessione: «Per la sessione dopo», punto 5. ✔
- §5: un ramo da `main`, un worktree nuovo, CI verde su tutti i job, merge a mano, pulizia solo della sessione,
  chiusura della sessione rilasciata prima nel primo commit (Compito 1, Passo 4), riga di stato «in revisione» nella
  propria PR (Rilascio, passo 4), conteggio delle iscrizioni nel PRD. ✔
- §5, «Riferimenti al codice»: ogni sostituzione nei file che una sessione prima cambia si fa per contenuto
  (`esito-fetch.ts` e cataloghi dopo la 1, allowlist e `errori-con-codice` dopo la 2, `protocolli/store.ts` dopo la 3,
  `pagella-store.ts` dopo la 10, `docs/cicd.md` dopo la 4 e la 5); i tetti si rileggono dal file (Compito 10). ✔
- §5 e §6, «Per la sessione dopo»: nessuna migrazione e nessuna fotografia; riga 13 a «in produzione», PRD,
  `docs/cicd.md`, misura di controllo e firewall con la data da cui maturano. Nessun ramo di soli documenti dopo il
  merge: cache dopo e numero dell'issue stanno in commenti della PR. ✔

**Segnaposto:** i soli `<…>` sono numeri, date, id e link che esistono solo al momento dell'esecuzione (misure,
numero della PR, link di condivisione). Ogni passo che cambia codice mostra il codice intero.

**Coerenza dei nomi:**
- `rispostaGuastoGiaRegistrato(tipo?)` (Compito 2) è usata nei Compiti 5 e 6.
- `rispostaErroreInterno(operazione, err)` e `rispostaErroreInternoGiaRegistrato()` (Compito 3) sono usate nei
  Compiti 5-8.
- Il codice `ERRORE_INTERNO` corrisponde alla chiave `erroreInterno` in entrambi i cataloghi.
- `intestazioniCachePubblica(request, secondi, stantio)` ha la stessa firma nei Compiti 12-14.
- L'`esito` `bucket_non_verificato` è lo stesso già usato dai `catch` di `primaria/allegati` e `primaria/fascicolo`.
- I nomi delle regole `s13-*` sono gli stessi nel Compito 15, nei passi 8-9 del Rilascio e nel punto 6 di «Per la
  sessione dopo».
- Le righe «in attesa» di `docs/cicd.md` (Compito 15) sono le stesse che i punti 3 e 6 di «Per la sessione dopo»
  cercano e sostituiscono.

**Lock trasversali controllati sul codice di oggi:**
- `logging-coverage`: `notes` usa `logEvento` diretto.
- `errori-con-codice`: codice nuovo dichiarato e tradotto; tetti abbassati alla misura.
- `catch-muti-allowlist`: tetti 47/35.
- `errori-postgrest-guardati`: quinta forma, 8 righe tolte.
- `gate-coverage`: le 23 porte non cambiano.
- `zod-coverage`: nessuna route nuova.
- `offline-html-nativo`: si lancia con `CI=1`.
