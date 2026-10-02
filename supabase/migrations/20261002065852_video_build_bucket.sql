-- ═══════════════════════════════════════════════════════════════════════════════
-- `video_build` — il bucket privato che custodisce FFmpeg: la conversione dei video non
-- dipende più da Internet a runtime.
-- Scritta il 2026-10-02 per la PR 1 «hotfix video». NON applicata da chi l'ha scritta: si
-- applica dopo averla mostrata (vedi «ORDINE DI APPLICAZIONE»).
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── IL GUASTO, misurato il 01-02/10/2026 ────────────────────────────────────
--
-- Dal 2026-09-29 alle 14:20 UTC nessun video si converte. A ogni MicroVM nuova il runner
-- installava `xz` dai mirror di Amazon (circa 76 MB di metadati) e poi scaricava
-- l'archivio di FFmpeg da GitHub: la build giornaliera di BtbN, che BtbN conserva
-- quattordici giorni. Il 29/09 quell'indirizzo ha cominciato a rispondere 404: la build
-- del 15/09 più quattordici giorni. Due download esterni, a runtime, entrambi fuori dal
-- nostro controllo — e uno dei due con la scadenza già scritta nella data del suo nome.
--
-- ─── COSA FA QUESTA MIGRAZIONE ───────────────────────────────────────────────
--
-- Dichiara il bucket in cui i binari stanno nel NOSTRO Storage.
--   · `video_build`, PRIVATO. Dentro, in una cartella col nome della build
--     (`ffmpeg-n9.0.1-30-g9258bacca5/`): `ffmpeg.gz`, `ffprobe.gz` e l'archivio BtbN da
--     cui vengono, come provenienza. Sono i due binari pubblici di FFmpeg (licenza GPL):
--     nessun dato personale, di nessuno.
--   · Tetto 314.572.800 byte (300 MiB). L'oggetto più grosso è l'archivio, 150.157.000
--     byte; ciascuno dei due `.gz` ne pesa circa 67 milioni. Il margine è per la build che
--     verrà, non per altro. Sta sotto il tetto globale dello Storage (2.000.000.000),
--     quindi entra in vigore davvero.
--   · MIME ammessi `application/gzip` (i due `.gz`) e `application/x-xz` (l'archivio). Il
--     limite sui tipi protegge da un caricamento sbagliato dello script, non da un
--     attaccante: qui scrive soltanto chi ha la chiave di servizio.
--
-- ─── NESSUNA POLICY, ed è voluto ─────────────────────────────────────────────
--
-- Questa migrazione non crea nessuna policy su `storage.objects`. Misurato in produzione il
-- 2026-10-02, in sola lettura: la RLS è accesa su `storage.objects` e su `storage.buckets`,
-- e `pg_policies` per `storage.objects` ha ZERO righe. Con la RLS accesa e nessuna policy,
-- `anon` e `authenticated` non leggono e non scrivono niente in nessun bucket, questo
-- compreso. Il runner legge con la chiave di servizio, che salta la RLS, e passa alla
-- MicroVM un indirizzo firmato a scadenza breve. Una policy generica aggiunta un giorno
-- su `storage.objects` aprirebbe anche questo bucket: chi la scrive deve ricordarsene.
--
-- ─── ORDINE DI APPLICAZIONE ──────────────────────────────────────────────────
--
-- Prima si MOSTRA l'SQL, poi si applica (`apply_migration`), poi `get_advisors` deve
-- tornare 0 ERROR. Il bucket nasce VUOTO: i tre oggetti li carica a mano
-- `scripts/ffmpeg-nel-bucket.mjs --carica`, dopo aver verificato le impronte contro
-- `src/lib/media/video/build.ts`, e vanno caricati PRIMA che il codice nuovo li cerchi —
-- altrimenti ogni conversione fallisce con `BUILD_DOWNLOAD_FAILED`. Il bucket vuoto non
-- cambia niente per il codice attuale, che non lo nomina.
--
-- Questa migrazione viaggia dentro una PR: o la applica l'integrazione al merge, o la si
-- applica a mano PRIMA — mai tutte e due, perché si registrerebbe due volte. Se a mano, il
-- file prende la `version` registrata (`git mv`), vanno rigenerate le fotografie di
-- produzione (migrazioni e bucket) e svuotata la mappa `IN_CODA` di
-- `__tests__/architecture/migrazioni-complete.test.ts`.
--
-- ─── COME SI VERIFICA (da eseguire DOPO l'apply) ─────────────────────────────
--
--   SELECT id, public, file_size_limit, allowed_mime_types
--     FROM storage.buckets WHERE id = 'video_build';
--   -- deve dire: privato, 314572800, {application/gzip,application/x-xz}.
--   SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';
--   -- deve restare 0.
--
-- ─── SE VA STORTO ────────────────────────────────────────────────────────────
--
-- Un bucket vuoto è inerte. Se serve toglierlo si fa dalla Storage API (`deleteBucket`),
-- come per i file: dalle tabelle dello Storage, in SQL, non si cancella niente (lock
-- `storage-delete-vietata-in-sql`).
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'video_build', 'video_build', false, 314572800,
  ARRAY['application/gzip', 'application/x-xz']
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Successo osservabile senza far dipendere la migrazione dal logger: se
-- `app_log_registra` non esiste o esplode, l'installazione resta valida.
DO $log$
BEGIN
  IF to_regprocedure('public.app_log_registra(jsonb)') IS NOT NULL THEN
    BEGIN
      PERFORM public.app_log_registra(jsonb_build_array(jsonb_build_object(
        'livello', 'info',
        'evento', 'video-build-bucket-migration',
        'sorgente', 'server',
        'messaggio', 'Bucket privato dei binari FFmpeg dichiarato',
        'fingerprint', 'video-build-bucket-migration-v1',
        'contesto', jsonb_build_object(
          'bucket_privati', 1,
          'limite_byte', 314572800
        )
      )));
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END
$log$;
