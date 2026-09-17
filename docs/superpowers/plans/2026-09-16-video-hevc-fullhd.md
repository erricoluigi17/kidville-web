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
- [x] V02 Schema job/intent/outbox e bucket — PASS critico dopo correzione da nuovo esecutore: scope/revision immutabili e vincoli SQL NULL-safe (12 test)
- [ ] V03 Profilo e argomenti FFmpeg, HDR/rotazione/audio
- [ ] V04 RPC atomiche claim/lease/ready/cancel/finalize
- [ ] V05 Verifica output e fixture video reali
- [ ] V06 Runner Sandbox e workflow durevole
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
