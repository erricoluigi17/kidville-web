# Video HEVC e Full HD — piano approvato e registro di esecuzione

Approvato dall'utente il 16 settembre 2026. Branch: `codex/video-hevc-fullhd`.

## Requisiti

- Galleria e News; video comuni, legacy e professionali, HEVC incluso.
- Originali fino a 2.000.000.000 byte e 180 secondi inclusi; nessun taglio automatico.
- MP4 H.264 CRF 18, yuv420p, AAC, faststart; Full HD orizzontale/verticale senza upscale; fino a 60 fps; HDR convertito in SDR.
- Upload TUS diretto a Supabase privato; FFmpeg/ffprobe su Vercel Sandbox Dublino, coordinamento durevole.
- Dopo upload completo il telefono può chiudere l'app. Pubblicazione solo pronta e già confermata, con riverifica dei permessi correnti.
- Originali riusciti: sette giorni dalla verifica dell'output. Falliti/abbandonati: TTL separato sette giorni.
- Watermark solo Galleria. News: allegati sotto il testo, bozza privata automatica al primo video; consenso foto attuale invariato, video esenti.
- 26 video/giorno come volume atteso; costi da misurare su campioni, non stimati senza benchmark.
- Output senza vecchio tetto 50 MiB. Storage video fino a 2 GB; immagini mantengono i limiti applicativi.
- Legacy video: 409 CLIENT_UPDATE_REQUIRED; code conservate e adottate dal nuovo client. Nessun 2xx equivale implicitamente a pubblicazione.

## Contratti di coordinamento

Moduli nuovi sotto `src/lib/media/video/`; route `/api/video-uploads` e `/api/video-uploads/[id]` con azioni esplicite e validazione zod.

`video_jobs`: UUID, owner_id, scuola_id (null solo ambito globale News esplicito), channel gallery/news, idempotency_key, intent_id; status awaiting_upload/queued/processing/ready/rejected/failed/cancelled; original_bucket/path, source_size/mime, output_bucket/path/size, probe_json; attempt, fence_epoch, lease_owner/expires_at, error_code, verified_at, original_delete_after/deleted_at, created_at/updated_at. Unico owner/channel/idempotency_key. RLS service-role.

`video_intents`: UUID, owner_id, scuola_id, channel, target_id, revision, expected_target_version, requested_action, payload tipizzato validato al bordo, confirmed_at, revoked_at, status pending/confirmed/published/action_required/cancelled/superseded, published_at, created_at/updated_at. Un intent News può avere più job; una Galleria collega un solo job. Pubblicazione target + conclusione intent + outbox atomica. Modifiche, ritiro e delete revocano la revisione precedente.

`video_outbox`: evento univoco per intent/revision/type; payload minimo, tentativi, lease e data invio. Nessun dato personale nei log.

Bucket `video_originals` e `video_processing`: privati, originali e output per tentativo con percorsi UUID. Copia finale nel bucket del dominio soltanto tramite finalizer autorizzato; per News rispettare il namespace `uploads/<owner>/<file>` e le regole di promozione esistenti.

Le transizioni worker richiedono fence_epoch e lease validi. Cancel e pubblicazione hanno un solo vincitore. I target pubblicati non sono cancellati dal semplice cancel-job.

## Microtask e revisione

Ogni microtask ha un esecutore Sol e un critico Astra distinto. Un FAIL passa a un nuovo esecutore. Gli esecutori possiedono solo i file assegnati, non committano e non modificano il PRD condiviso: il coordinatore integra i loro riscontri.

- [x] V01 Probe e matrice formati — PASS dopo correzione da nuovo esecutore, 71 test e 14 regressioni indipendenti
- [x] V02 Schema job/intent/outbox e bucket — PASS critico dopo correzione da nuovo esecutore: scope/revision immutabili e vincoli SQL NULL-safe (12 test). ⚠️ Manca la policy di scrittura su `storage.objects` per `video_originals`: senza, un upload TUS col token di sessione prende 403 al primo byte. Da aggiungere in V04-bis.
- [x] V03 Profilo e argomenti FFmpeg, HDR/rotazione/audio — PASS critico, 21/21 test, con transcodifica MJPEG reale e watermark misurato col filtro `bbox`
- [~] V04 RPC atomiche claim/lease/ready/cancel/finalize — sei RPC su sette, con le due correzioni di concorrenza del critico applicate e verificate. **Manca `finalize`**, nessuna RPC scrive `video_outbox`, nessuna RPC sugli intent (confirm/supersede/revoke). Il critico non ha mai riemesso il verdetto: va rifatto passare
- [~] V05 Verifica output e fixture video reali — logica completa con le due correzioni del critico applicate. **Mancano le fixture reali**: `video-verify.test.ts` non esegue mai ffmpeg, e i due casi reali di `video-encode.test.ts` sono `it.runIf` che si saltano in silenzio. Critico da rifare passare
- [ ] V06 Runner Sandbox e orchestrazione durevole — **senza il pacchetto `workflow`**, vedi la nota qui sotto
- [ ] V07 Init/upload-complete/stato/conferma/cancel API
- [ ] V08 Pubblicazione Galleria e gate correnti
- [ ] V09 Allegati/revisioni/pubblicazione News
- [ ] V10 Uploader TUS e stato comune
- [ ] V11 Integrazione interfaccia Galleria
- [ ] V12 Integrazione interfaccia News e autosave bozza
- [ ] V13 Blocco legacy e adozione coda Dexie
- [ ] V14 Retention, riconciliazione e notifiche
- [ ] V15 Collaudi unitari/integrati/codec/browser/iOS/Android e benchmark
- [ ] V16 PRD, migrazioni CI/produzione, configurazione, rilascio e pulizia branch

## Gate

ESLint zero warning; Vitest completo; build; Playwright CI; iOS e Android; logging verificato. Prima del rilascio tutti i critici PASS. Nessuna migrazione distruttiva e nessuna riconversione automatica dei video storici senza originale.

## Stato iniziale verificato

Main `9a30ff67`: PR #148 mergeata, CI/unit/E2E verdi, produzione Vercel Ready. Unica modifica locale preesistente: `supabase/.temp/cli-latest`, esclusa dall'intervento. Vercel Pro attivo; produzione Supabase eu-west-1; bucket gallery/news/news_bozze a 52.428.800 byte prima dell'intervento.

Configurazione globale Storage portata a 2.000.000.000 byte il 16 settembre, prima in CI e poi produzione, con GET di verifica. Entitlement dell'organizzazione verificato: massimo configurabile 536.870.912.000 byte; nessun cambio di abbonamento. Migrazione schema non ancora applicata. Revisioni intent: UUID nuova e numero revisione crescente; nessun aggiornamento in place della revisione già referenziata dall'outbox.

## Ripresa del 2026-09-17 — che cosa è stato messo in salvo e che cosa è stato rimandato

Il lavoro si era interrotto il 16/09 alle 21:01 per esaurimento dei limiti d'uso, con V04 e V05 in
correzione e V06 appena avviata. Niente era committato: tutto viveva nell'albero di lavoro.

**Messo in salvo** (branch `codex/video-hevc-fullhd`): V01–V05, 138 test video verdi, gate completo
verde — `eslint --max-warnings 0`, `tsc --noEmit`, 17.973 test su 17.973, `next build`.

**Rimandato, con il motivo:**

- **Il 2 GB sui bucket di dominio** `gallery`/`news`/`news_bozze` è uscito dalla migrazione. Non
  abilitava niente finché il finalizer non esiste, e toglieva l'ultima delle tre reti di sicurezza.
  Torna in V08 **insieme** alla riscrittura del lock `bucket-storage-dichiarati` nella forma a tre
  asserzioni: il bucket è il tetto dell'OGGETTO e sale, `TETTO_GALLERIA_BYTE` è il tetto di ciò che
  il BROWSER spedisce da sé e resta 50 MiB. Un `<=` senza le uguaglianze accanto rende il lock
  decorativo.
- **`vercel.json`** non è stato committato. Dichiarava `src/app/api/video-uploads/**` su una cartella
  inesistente, e un pattern `functions` senza match fa fallire la build su Vercel: avrebbe bloccato
  ogni deploy, compreso un hotfix su tutt'altro. Torna in V07 con la route, e si collauda su un
  **preview deploy** — l'unico posto dove quella validazione si può misurare.
- **Le due migrazioni restano non applicate** e sono dichiarate in `IN_CODA`
  (`__tests__/architecture/migrazioni-complete.test.ts`) con il promemoria di ciò che va fatto il
  giorno dell'applicazione: rigenerare `bucket-storage-snapshot.json` e registrare i due bucket nuovi
  in `REGISTRO_BUCKET_OBLIO`.

**Il pacchetto `workflow@5.0.0-beta.53` è stato rimosso**, e V06 va riscritta senza. Era stato
installato in anticipo sul runner e non orchestrava niente (`npm run build` stampava «0 workflows»);
portava 571 pacchetti in `dependencies` di produzione, fra cui `@nestjs/core`, `@nuxt/kit` e l'intero
`@aws-sdk/*`, perché è multi-framework; generava due route pubbliche per le quali il matcher del
middleware era stato modificato in modo che **nessun lock del repo le sorvegliasse**; e rendeva
`next.config.ts` una config phase-based, tanto che il lock di sicurezza `header-sicurezza.test.ts` era
stato adattato a eseguire un generatore che scrive dentro `src/`. Dopo la rimozione i pacchetti nuovi
sono 54, tutti di `@vercel/sandbox`.

**Al suo posto**: le RPC di V04 sono già un protocollo di coda completo (claim con lease, heartbeat,
`fence_epoch`, cancel che vince alzando il fence), il repo usa già `pg_cron` in otto migrazioni e
`pg_net` per le chiamate HTTP da SQL, e `video_outbox` aspetta solo uno scrittore. La conversione non
sta comunque dentro una richiesta sola — qui le route più pesanti dichiarano `maxDuration = 300` e una
transcodifica di 180 s Full HD a CRF 18 su 2 vCPU lo supera — quindi il disegno è «Sandbox detached
più sorveglianza a battiti» in entrambi i casi, e un cron lo regge quanto un orchestratore durevole.

**Trovato strada facendo, fuori dal perimetro del video e già vero in produzione:** i bucket che non
dichiarano un `file_size_limit` proprio sono passati da 50 MiB a 2 GB di soffitto quando il tetto
globale è stato alzato il 16/09. Misurati il 17/09: tre su sedici — `certificati-medici`,
`credenziali`, `fatture`. Serve una migrazione che li pinni, insieme alla rimozione del `return` che
in `bucket-storage-dichiarati.test.ts` fa saltare il controllo quando il limite è `null`. E il matcher
del middleware resta un meccanismo di esenzione che nessun lock guarda: `prefissi-pubblici` sorveglia
`PUBLIC_PREFIXES`, non il matcher.

## V03-bis — l'uscita può sfondare i 2 GB, e se ne accorge solo dopo aver pagato la conversione

Misurato il 2026-09-17 con gli argomenti veri di `buildVideoEncodeArgs`, canale `gallery`, ffmpeg
limitato a 2 thread: un ingresso 1080p30 di 180 s a 94,5 Mbit/s (2,13 GB) ha prodotto un'uscita di
**2.073.793.213 byte** — sopra il tetto di 2.000.000.000.

Il job fallirebbe **dopo** aver pagato la conversione: `video_jobs_output_chk` e `video_job_ready`
(`20260916190100_video_job_transitions.sql:408-410`) tagliano a 2 GB, e `verifyVideoOutput` risponde
`OUTPUT_TOO_LARGE`. Nel campione misurato quei byte sono costati **709 secondi di wall e 1.452
secondi di CPU** su due thread.

La causa è in `src/lib/media/video/encode.ts:284-316`: `-crf 18` è un obiettivo di **qualità senza
tetto di bitrate** — non c'è `-maxrate`, non c'è `-bufsize`. Su una sorgente già molto densa, x264
spende quanto serve per tenere la qualità richiesta, e nessuno lo ferma.

Il campione era rumore sintetico, quindi patologico: un video di telefono non ci arriva. Ma il buco è
reale e si chiude prima, non dopo: un tetto VBV ricavato dal budget di 2 GB diviso la durata che il
probe ha già misurato. Va in una V03-bis, con la sua regressione.

## V06 — il dimensionamento è una scelta, non un vincolo

Dalla stessa sessione di misura, sulla stessa sorgente: 2 thread danno 261 s di wall e 572 s di CPU;
16 thread danno 49 s di wall e 722 s di CPU. Aggiungere core costa **quasi niente in CPU-secondi** e
restituisce quasi tutto in tempo d'attesa, perché la fatturazione è a `GB × ore` e il tempo si
accorcia. Vercel Sandbox su Pro arriva a 8 vCPU.

Scalato su `dub1` con una banda dichiarata 1,5×–2,5× per il valore del singolo core: a **2 vCPU** il
caso tipico sta fra 392 e 653 secondi, a **4 vCPU** fra 212 e 353 — **1,85 volte più veloce a costo
praticamente identico** (+8 %). Resta comunque fuori dai 300 s di una singola invocazione, quindi la
scelta architetturale non cambia; cambia quanto aspetta un genitore.

## V06 — perché il Sandbox basta da solo

La ragione per cui l'orchestratore esterno non serve, misurata e non dedotta: **Vercel Sandbox è esso
stesso durevole**. Sessione fino a 24 ore su Pro, `runCommand({ detached: true })` ritorna subito, e
`Sandbox.get({ name })` riaggancia una MicroVM viva **da un altro processo o dopo un riavvio dello
script** — è la documentazione del pacchetto a dirlo. Il coordinatore non deve *contenere* la
conversione: deve solo *sorvegliarla*.

Manca un pezzo solo, e sono venti righe: `video_job_claim` vuole un `p_job_id`
(`20260916190100:161-165`), non pesca da sé. Serve una RPC `video_job_next` che legga la coda con
`FOR UPDATE SKIP LOCKED` — l'indice parziale `video_jobs_coda_idx`
(`20260916190000_video_jobs.sql:288`) è già lì per questo.

Il nome del Sandbox deve essere **deterministico e contenere `fence_epoch`**: così una doppia
partenza diventa innocua a livello di piattaforma, senza toccare lo schema, e si aggiunge alle tre
guardie che il database ha già (`LEASE_ACTIVE`, `FENCE_MISMATCH`, `OUTPUT_CONFLICT`).
