# PR 1 — Hotfix video FFmpeg: piano d'implementazione

> **Per gli agenti:** ogni compito si esegue con un ciclo **esecutore (Sonnet 5.5) → critico (Opus 5.5)**.
> **Regola del titolare dal 02/10/2026:** il critico **chiude il compito se non trova difetti bloccanti**
> (non serve più la tripla A); i difetti secondari si **annotano** in
> `docs/superpowers/plans/2026-10-02-video-pr1-difetti-secondari.md`. Solo con un bloccante un esecutore
> **nuovo** riceve il brief di correzione, al massimo **3 giri**; dopo, ci si ferma e si scrive al titolare.
> Spec vincolante: `docs/superpowers/specs/2026-10-02-video-pr1-hotfix-ffmpeg-design.md`.

**Obiettivo:** la conversione dei video riparte e non dipende più da download esterni a runtime; i guasti
nostri si ritentano da soli (4 tentativi in un'ora); l'insegnante legge un messaggio chiaro; il log
conserva la coda dell'errore.

**Architettura:** binari FFmpeg identici (SHA verificati) nel bucket privato `video_build`; il runner li
scarica con URL firmati e due impronte; classificazione dei guasti in TypeScript puro; RPC
`video_job_retry` che rimette in coda con attesa o delega a `video_job_fail`.

**Stack:** Next.js 16 su Vercel, Supabase (Postgres + Storage), Vercel Sandbox (`node22`), vitest + PGlite.

---

## Regole per tutti gli esecutori
- Branch già attivo: `fix/video-ffmpeg-bucket`. **Niente git**, niente `npm install`, **niente suite intera**
  (la lancia l'orchestratore una volta, sull'albero fermo): solo i test mirati del compito.
- Si legge con `Read` (così scattano le regole di `.claude/rules/`), si cerca con grep, output lunghi
  passati da `head`/`tail`.
- **Verifica, non ricopiare alla cieca**: se una misura contraddice la spec, fermati e scrivilo nei
  dubbi del rapporto invece di deviare.
- Logging come da `AGENTS.md` (mai `console.*` in `src/`, mai PII, successo loggato per gli eventi
  critici, nessun `catch` muto). Commenti e testi in italiano, nello stile dei file intorno.
- Tocca **solo** i file del tuo compito. Un rosso in un file non tuo: rilancia quel file da solo e
  attribuiscilo con gli `mtime` prima di indagare.

## Regole per tutti i critici
- Rilancia i comandi di accettazione e: `npx vitest run __tests__/architecture __tests__/a11y
  __tests__/lib/video-contratto.test.ts __tests__/lib/gdpr-oblio-completo.test.ts
  __tests__/lib/logging-tetto.test.ts __tests__/api/zod-coverage.test.ts` + i test che importano i file
  toccati + `npx tsc --noEmit` + `npx eslint <file toccati> --max-warnings 0`. Leggi la riga
  `Test Files N passed` (un file inesistente esce 0 senza eseguire niente).
- **Almeno una mutazione**: rompi il codice del compito e verifica che un test diventi rosso. Prima
  `cp <file> <file>.bak-critico`, dopo `cp` indietro e `cmp` per provare il ripristino. **Mai** `git
  checkout`/`git stash`/`git restore` (cancellano il lavoro degli altri compiti in volo).
- Verdetto **OK** se non c'è nessun difetto bloccante: il **funzionamento** va verificato con severità
  (criteri di accettazione provati, test che falliscono quando il codice è rotto, nessuna regressione
  nei lock, logging e privacy a posto, fedeltà alla spec). Ogni altro rilievo è **secondario** e si
  elenca per l'annotazione. Con un bloccante: verdetto **BLOCCANTE** e brief di correzione
  **eseguibile da un esecutore nuovo senza contesto**.
- **Bloccante** (decisione del titolare): non funziona · rischio su dati di minori · perdita di dati ·
  gate rosso · log obbligatori mancanti. Tutto il resto è una miglioria.
- Rossi attesi fino all'O2 (fotografie della produzione): **solo** le asserzioni di
  `bucket-storage-dichiarati` e `migrazioni-complete` che confrontano con
  `__tests__/fixtures/*-snapshot.json`; vanno elencate una per una, non sono un difetto del compito.

## Ondata 1 (in parallelo)

### T1 — La build nel nostro bucket (costanti, preparazione, CI, lock, script di caricamento)
**File:** `src/lib/media/video/build.ts` · `src/lib/media/video/runner/preparazione.ts` ·
`__tests__/lib/video-runner-preparazione.test.ts` · `__tests__/lib/video-runner-preparazione-shell.test.ts` ·
`__tests__/lib/video-runner-orchestrazione.test.ts` (solo l'asserzione sul vecchio `tar `, oggi ~354-361) ·
`.github/workflows/ci.yml` · `__tests__/architecture/fixture-video-reali.test.ts` ·
`__tests__/architecture/provider-esterni-osservati.test.ts` ·
`docs/superpowers/specs/2026-09-16-video-build-verificata.md` · `scripts/ffmpeg-nel-bucket.mjs` (nuovo).
**Spec:** §3, §4.2, §4.3, §4.11.
**Accettazione:**
- `build.ts` ha le 9 costanti di §4.2 con nomi e valori esatti; testata riscritta.
- `scriptPreparazioneBuild()` non contiene `https?://`, `dnf`, `sudo`, `xz`, `tar `; contiene
  `"$KV_URL_FFMPEG"`, `"$KV_URL_FFPROBE"` e i 4 SHA; l'ordine curl → sha(gz) → `gzip -dc` → sha(bin) →
  `chmod` è provato da un test; il test di shell (comandi finti) copre le uscite 21/22/23 e la variabile
  mancante, e `sudo`/`dnf` non compaiono mai. Mutazione: invertire sha(gz) e `gzip -dc` → rosso.
- `ci.yml`: cache `ffmpeg-bin-<sha>-<sha>` + ripiego sui segreti `CI_FFMPEG_GZ_URL`/`CI_FFPROBE_GZ_URL`
  (solo in quel passo), 4 SHA verificati, `zscale`, `KIDVILLE_VIDEO_FFMPEG_DIR`; nessun indirizzo BtbN
  fuori dai commenti.
- Lock `fixture-video-reali` e `provider-esterni-osservati` riscritti come in §4.11, verdi, e rossi se
  si rimette un URL esterno nello script o nel workflow (prova di mutazione).
- `scripts/ffmpeg-nel-bucket.mjs`: modalità `--carica --cartella <dir>` e `--firma-ci ffmpeg|ffprobe`
  come in §4.11; `node --check` passa; non stampa mai chiavi né URL (lo URL solo su stdout non-TTY).
**Test:** `npx vitest run __tests__/lib/video-runner-preparazione.test.ts
__tests__/lib/video-runner-preparazione-shell.test.ts __tests__/lib/video-runner-orchestrazione.test.ts
__tests__/architecture/fixture-video-reali.test.ts __tests__/architecture/provider-esterni-osservati.test.ts`

### T2 — Diagnosi leggibile
**File:** `src/lib/media/video/runner/diagnosi.ts` (nuovo) · `__tests__/lib/video-runner-diagnosi.test.ts` (nuovo).
**Spec:** §4.8, §5.
**Accettazione:** `codaDiagnostica(testo, max)` pura, senza import dell'SDK; il caso reale «inizio dnf
(`Amazon Linux 2023 repository … 76 MB`, `Dependencies resolved.` …) seguito da `curl: (22) The requested
URL returned error: 404`» conserva il 404; spariscono URL, JWT, `token=`, `signature`, `apikey`, blocchi
`Metadata:`, `location`/`ISO6709`/`creation_time`/`com.apple.*`/`make`/`model`/`software`/`title`/
`comment`/`artist`; progresso `\r` → ultimo segmento; lunghezza ≤ max con `…` davanti se taglia.
Mutazione: `.slice(0, max)` al posto della coda → rosso.
**Test:** `npx vitest run __tests__/lib/video-runner-diagnosi.test.ts`

### T3 — Migrazioni: bucket e ritentativi
**File:** `supabase/migrations/20261002120000_video_build_bucket.sql` (nuovo) ·
`supabase/migrations/20261002120100_video_job_ritentativi.sql` (nuovo) ·
`__tests__/lib/video-job-ritentativi.test.ts` (nuovo) ·
`__tests__/architecture/video-originale-mai-senza-scadenza.test.ts` ·
`__tests__/architecture/migrazioni-complete.test.ts` (solo `IN_CODA`) ·
`__tests__/architecture/bucket-storage-dichiarati.test.ts` (solo `RISERVATI` += `video_build`, con commento) ·
`src/lib/gdpr/esegui.ts` (solo la voce `video_build` del registro, se il test dell'oblio la pretende).
**Spec:** §4.1, §4.7, §4.11 (lock della scadenza), §5.
**Accettazione:** i casi PGlite di §5 tutti verdi (rimessa in coda; `next` salta i non dovuti e prende un
dovuto più recente; dovuto → `attempt+1` e `next_attempt_at` azzerato; esauriti → `failed` con
`original_delete_after = now + 7 giorni`; FENCE/LEASE/INVALID_STATE; idempotenza; BAD_INPUT; `claim` →
`RETRY_NOT_DUE`; cancel, supersede, revoke di un job in attesa; `video_retention_scadenze`(b) su un job
in attesa; `anon`/`authenticated` senza EXECUTE). Il `diff` dei corpi di `video_job_next`/`video_job_claim`
rispetto agli originali mostra **solo** le modifiche dichiarate (il critico lo esegue e lo riporta).
Migrazioni idempotenti (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DO` con guardia). Le due migrazioni in
`IN_CODA` con la ragione.
**Test:** `npx vitest run __tests__/lib/video-job-ritentativi.test.ts __tests__/lib/video-job-next.test.ts
__tests__/lib/video-transitions.test.ts __tests__/lib/video-intents.test.ts __tests__/lib/video-retention-rpc.test.ts
__tests__/architecture/video-originale-mai-senza-scadenza.test.ts` (i nomi esatti dei test PGlite video
esistenti si verificano con `ls __tests__/lib | grep video`).

### T4 — Classi di guasto e ritentativi (logica pura)
**File:** `src/lib/media/video/runner/ritentativi.ts` (nuovo) · `__tests__/lib/video-runner-ritentativi.test.ts` (nuovo).
**Spec:** §4.5, §5.
**Accettazione:** costanti esatte di §4.5; tabella uscite → classe (0, 1, 21-25, 31-34, 126, 127, 137,
255); HTTP 400/403/404 → permanente, 500/503/`000`/null → transitoria; `ATTESE.length === TENTATIVI - 1`;
attese monotone; `somma + TENTATIVI × CADENZA ≤ FINESTRA`; `CADENZA` letta dallo schedule del cron nella
migrazione `20260918120000_video_runner_tick.sql`; `file`/`non-ritentabile` mai ritentati; uscita 25
ritentata solo con errore di rete/HTTP nello stderr. Mutazione: cambiare un'attesa così che la somma
superi la finestra → rosso.
**Test:** `npx vitest run __tests__/lib/video-runner-ritentativi.test.ts`

## O2 — Orchestratore (dopo l'ondata 1)
1. Mostrare l'SQL delle due migrazioni; `SELECT count(*) FROM enrollment_submissions`; controllare che non
   siano già applicate (`list_migrations`).
2. `apply_migration` ×2 → `git mv` dei file alla version registrata (memoria «migrazione in PR applicata
   dall'integrazione») → `get_advisors` 0 ERROR → `has_function_privilege` falso per anon/authenticated.
3. `supabase projects api-keys … | node scripts/ffmpeg-nel-bucket.mjs --carica --cartella <scratchpad>/ffmpeg`
   → verifica SQL su `storage.objects` (bucket `video_build`: 3 oggetti, byte giusti).
4. Segreti CI: `… --firma-ci ffmpeg | gh secret set CI_FFMPEG_GZ_URL`, idem ffprobe.
5. Rigenerare le fotografie (migrazioni, bucket) e svuotare `IN_CODA`.

## F1 — Sandbox vero (orchestratore)
MicroVM `node22` in `dub1`; lo script di preparazione **generato dal sorgente del branch**; URL firmati di
sola lettura su `video_build`: uscita 0, inventario senza mancanze, una clip HDR generata nel Sandbox
convertita con `buildVideoEncodeArgs`.

## Ondata 2 (in parallelo)

### T5 — Integrazione nel runner
**File:** `src/lib/media/video/runner/porte.ts` · `adattatori.ts` · `esegui.ts` · `index.ts` ·
`codici.ts` (solo testata) · `src/app/api/video/runner/route.ts` ·
`__tests__/lib/video-runner-orchestrazione.test.ts` · `__tests__/api/video-runner-tick.test.ts` (+ test
del battito se toccati).
**Spec:** §4.4, §4.6, §4.8 (uso in `erroreDiagnostico`), §4.9.
**Accettazione:** `urlLettura` chiamata 4 volte con una MicroVM nuova e 2 al riaggancio; URL della build
mai in `avvia` né negli args; `chiudiPerGuasto` con la classe a ogni punto della tabella; esito
`in-riprova`; ripiego su `video_job_fail` **solo** per `RPC_ERROR`; verdetti del DB → `lease-persa`; log
di §4.9 con `distingui`; battito `warn` per `in-riprova`; `Sandbox.create({ runtime: 'node22' })`
invariato con commento.
**Test:** `npx vitest run __tests__/lib/video-runner-orchestrazione.test.ts __tests__/api/video-runner-tick.test.ts
__tests__/lib/video-runner-diagnosi.test.ts __tests__/lib/video-runner-ritentativi.test.ts` + i test che
importano `esegui.ts`/`adattatori.ts` (grep).

### T6 — Contratto e messaggio chiaro (galleria e News)
**File:** `src/lib/media/video/contratto.ts` · `src/app/api/video-uploads/risposte.ts` ·
`src/app/api/video-uploads/[id]/route.ts` · `src/components/features/gallery/use-video-galleria.ts` ·
`src/components/features/gallery/VideoInLavorazione.tsx` ·
`src/components/features/admin/news/NewsVideoAllegati.tsx` · `messages/it|en/{shared,teacherServizi,adminComunicazioni}.json`
· i test relativi.
**Spec:** §4.10.
**Accettazione:** codici e mappe come §4.10; `RETRY_NOT_DUE` identico alla migrazione; `riprovaAutomatica`
calcolata dalla route e mostrata dalla scheda con `aria-live="polite"`; testi esatti it/en; lock di
parità dei cataloghi verdi; test di componente che provano **presenza** del messaggio in ritentativo e
**assenza** fuori da `queued`/`processing`.
**Test:** `npx vitest run __tests__/lib/video-contratto.test.ts __tests__/api/video-uploads-id.test.ts
__tests__/components/VideoInLavorazione.test.tsx __tests__/components/video-galleria-recupero.test.tsx
__tests__/pages/teacher-gallery-video.test.tsx __tests__/lib/gallery-video-flusso.test.ts` + i test delle
News video (grep `NewsVideoAllegati`).

### T9 — PRD
**File:** `PRD REGISTRO ELETTRONICO.md`. Voce di changelog datata 2026-10-02 in cima, tabelle di stato:
causa misurata (404 BtbN + log che teneva l'inizio), binari nel nostro bucket con le impronte, ritentativi
(4 in un'ora), messaggio, decisioni del titolare, rischi residui, PR successive annunciate.

## Chiusura (orchestratore)
Gate intero sull'albero fermo (`npx eslint . --max-warnings 0`, `npx tsc --noEmit`, `npx vitest run`
leggendo `Test Files N passed`, `npm run build`) → commit → push → PR → CI completa (E2E senza retry) →
merge → deploy → verifiche di §6 della spec → pulizia dei branch → memoria aggiornata.
