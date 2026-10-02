# PR 1 — Hotfix video: FFmpeg nel nostro bucket, ritentativi, diagnosi leggibile

> Spec del 2026-10-02. Piano approvato dal titolare (tre PR in sequenza: **questa** → server e web →
> app 1.2). Branch `fix/video-ffmpeg-bucket`. Riferimento vincolante per esecutori e critici: le
> decisioni qui sotto **non si rimettono in discussione**; se una misura le contraddice, si porta la
> misura all'orchestratore invece di cambiarle.

## 1. Il guasto (misurato il 01-02/10/2026)

- Dal **29/09/2026 alle 14:20 UTC** nessun video si converte: **17 job su 17** presi dal runner sono
  `failed / BUILD_DOWNLOAD_FAILED / attempt=1`. Dopo quell'ora hanno tentato 7 insegnanti, tutte iOS,
  nessuna riuscita. Il 30/09 e il 01/10: 0 video pubblicati, 131 foto.
- Il runner (`/api/video/runner`, chiamato da `pg_cron` ogni 5') apre una MicroVM Vercel Sandbox
  (runtime `node22`, Amazon Linux 2023) e a **ogni** MicroVM nuova: `sudo dnf install xz` (≈76 MB di
  metadati dai mirror Amazon) → `curl` dell'archivio da `src/lib/media/video/build.ts:29-30` (release
  BtbN `autobuild-2026-09-15-13-18`) → sha256 → tar. **Quell'URL risponde 404**: BtbN conserva le build
  giornaliere 14 giorni (15/09 + 14 = 29/09). Sono **due download esterni a runtime**, entrambi punti di
  rottura fuori dal nostro controllo.
- **La causa era invisibile**: `app_log.messaggio` tronca a 500 caratteri e il runner salvava
  l'INIZIO dello stderr (l'output di dnf). La riga del 404 stava in coda ed è andata persa. `video_jobs`
  non ha colonne di dettaglio. È la violazione esatta della regola 3 di `AGENTS.md` («il corpo
  dell'errore non si butta MAI via»).
- `video_job_fail` rende il job definitivo al primo colpo: nessun ritentativo, anche quando il guasto è
  nostro e non del video.

## 2. Decisioni

### Del titolare (vincolanti)
1. FFmpeg **non dipende più da download esterni a runtime** (né GitHub né mirror di pacchetti).
2. Log con la **coda** dell'errore (regola 3 di AGENTS.md).
3. **Ritentativo automatico solo quando il guasto è nostro** (infrastruttura, non il file):
   **3 ritentativi dopo il primo tentativo = 4 tentativi in tutto**, attese ≈ **5', 10', 15'**, entro
   un'ora; poi «fallito».
4. **Messaggio chiaro all'insegnante** quando il guasto è nostro: mentre si ritenta e dopo il fallimento
   definitivo.
5. **Nessun allarme attivo.** **Nessun recupero** dei job già falliti (gli originali scadono da soli).
6. PR **separata e piccola**, rilasciata per prima. Bambini salvati sul server, pubblicazione automatica,
   invio nativo, chiusura del legacy, purga: **PR successive** — non anticiparle, non bloccarle.

### Tecniche (dell'orchestratore, con motivo)
| # | Decisione | Motivo |
|---|---|---|
| D1 | `TENTATIVI_MASSIMI_GUASTO_NOSTRO = 4`, `ATTESE_FRA_TENTATIVI_S = [300, 600, 900]` | risposta del titolare: «3 ritentativi dopo il primo» |
| D2 | CI: cache dei binari come fonte primaria; ripiego su URL firmati (365 giorni) verso `video_build`, conservati nei segreti `CI_FFMPEG_GZ_URL` e `CI_FFPROBE_GZ_URL` | il DB della CI può avere un tetto di file di 50 MB; i binari sono pubblici (GPL), nessun dato personale |
| D3 | uscita 25 (ffprobe sull'URL) ritentata **solo** se lo stderr mostra un errore di rete/HTTP; uscite 32 e 33 non ritentabili | non ritentare un file illeggibile |
| D4 | testo finale senza «abbiamo riprovato» | è vero anche per i 17 job già falliti |
| D5 | nel job si salva **solo** `last_error_code`; la coda ripulita va in `app_log` (30 giorni) | lo stderr di ffmpeg può contenere `com.apple.quicktime.location.ISO6709` (GPS di dove sono stati ripresi i bambini); `video_jobs` non ha conservazione |
| D6 | il messaggio di ritentativo vale anche per le **News** | stessa pipeline |
| D7 | il runtime `node22` **resta** in questa PR | si cambia nella PR 2 (snapshot su `node:24`) |
| D8 | nel bucket: `ffmpeg.gz`, `ffprobe.gz` + l'archivio originale come provenienza | gzip c'è su Amazon Linux 2023 e su Ubuntu; niente `xz` |
| D9 | migrazioni applicate **a mano prima del merge** (mostrate prima), poi `git mv` dei file alla version registrata | i binari vanno caricati nel bucket prima che il codice nuovo li cerchi; memoria «migrazione in PR applicata dall'integrazione» |
| D10 | i 17 job già falliti mostreranno il testo «problema nostro, ricaricalo» | coerente con la decisione 5 |
| D11 | i falsi scarti `OUTPUT_FPS_INVALID` **non** si toccano qui | sono nella PR 2 (compito T9), con il fixture misurato il 02/10 |

## 3. I binari recuperati (T0, fatto il 02/10/2026)

Recuperati con un workflow usa e getta dalla cache della CI (chiave
`ffmpeg-btbn-adb2d107287cdace0c5d00dd986cd3674c1e86776501640bff3b5cf7d2cf2e71`, ref `main`); artefatto
cancellato; **verificati in locale** con strumenti diversi da quelli del workflow.

| File | Byte | SHA-256 |
|---|---|---|
| archivio BtbN `ffmpeg-n9.0.1-30-g9258bacca5-linux64-gpl-9.0.tar.xz` | 150.157.000 | `adb2d107287cdace0c5d00dd986cd3674c1e86776501640bff3b5cf7d2cf2e71` |
| `ffmpeg` (binario) | — | `341447cfff51ff528cf530eb111542306cffc1f1f6a51726e6327b655d6860be` |
| `ffprobe` (binario) | — | `09c3b0595ea6dd648e0cf1b462d97303792b31cb81c0359b65d072c0d7254063` |
| `ffmpeg.gz` (`gzip -9 -n`, prodotto in CI) | 67.302.445 | `f019aabcb3940d3ddf61554cc96086eb95f98a1978877196b9e6320b52a2a790` |
| `ffprobe.gz` (`gzip -9 -n`, prodotto in CI) | 67.191.515 | `a3cb017c28ce55d622e3328fc4003acf7daa1b05ca63ca7b826f97807f3333a9` |

Versione: `ffmpeg version n9.0.1-30-g9258bacca5-20260915`. Inventario: `mancanzeDellaBuild = []`
(8 filtri, 7 decoder, 5 encoder richiesti; 562/554/227 presenti). ⚠️ I `.gz` canonici sono quelli
prodotti in CI: rigenerarli su macOS cambierebbe lo SHA.

## 4. Progetto

### 4.1 Bucket `video_build` (migrazione `…_video_build_bucket.sql`)
`INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES ('video_build',
'video_build', false, 314572800, ARRAY['application/gzip','application/x-xz']) ON CONFLICT (id) DO UPDATE
SET public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types =
EXCLUDED.allowed_mime_types;` più un blocco `DO` che registra il successo come le migrazioni video
esistenti. **Nessuna policy**: `storage.objects` non ne ha, quindi il bucket lo legge solo la chiave di
servizio. Il nome contiene `_video_` perché il lock del contratto legge quei file.

### 4.2 Costanti in `src/lib/media/video/build.ts`
Restano `ARCHIVIO_FFMPEG_URL`, `ARCHIVIO_FFMPEG_SHA256`, `RADICE_ARCHIVIO_FFMPEG` come **provenienza**
(il runner non li usa più). Si aggiungono, **con questi nomi e valori esatti**:
```ts
export const BUCKET_BUILD_VIDEO = 'video_build'
export const CARTELLA_BUILD_NEL_BUCKET = 'ffmpeg-n9.0.1-30-g9258bacca5'
export const PERCORSO_FFMPEG_GZ = `${CARTELLA_BUILD_NEL_BUCKET}/ffmpeg.gz`
export const PERCORSO_FFPROBE_GZ = `${CARTELLA_BUILD_NEL_BUCKET}/ffprobe.gz`
export const PERCORSO_ARCHIVIO_ORIGINALE = `${CARTELLA_BUILD_NEL_BUCKET}/ffmpeg-n9.0.1-30-g9258bacca5-linux64-gpl-9.0.tar.xz`
export const FFMPEG_GZ_SHA256 = 'f019aabcb3940d3ddf61554cc96086eb95f98a1978877196b9e6320b52a2a790'
export const FFPROBE_GZ_SHA256 = 'a3cb017c28ce55d622e3328fc4003acf7daa1b05ca63ca7b826f97807f3333a9'
export const FFMPEG_SHA256 = '341447cfff51ff528cf530eb111542306cffc1f1f6a51726e6327b655d6860be'
export const FFPROBE_SHA256 = '09c3b0595ea6dd648e0cf1b462d97303792b31cb81c0359b65d072c0d7254063'
```
La testata del file (righe 1-26) va riscritta: «non si scarica più da Internet; la catena è archivio
`adb2…` → binari estratti → `.gz` nel nostro bucket privato; il runner verifica due impronte».

### 4.3 Script di preparazione (`src/lib/media/video/runner/preparazione.ts`)
- `FFMPEG = /tmp/kv-ffmpeg/ffmpeg`, `FFPROBE = /tmp/kv-ffmpeg/ffprobe`.
- Si esportano `ENV_URL_FFMPEG = 'KV_URL_FFMPEG'` e `ENV_URL_FFPROBE = 'KV_URL_FFPROBE'`.
- Le uscite 21 (download), 22 (impronta), 23 (estrazione) e `codiceDaUscitaPreparazione` restano.
- `scriptPreparazioneBuild()` diventa, nell'ordine (e lo script **non contiene** `https?://`, `dnf`,
  `sudo`, `xz`, `tar `):
```sh
set -eu
: "${KV_URL_FFMPEG:?}" "${KV_URL_FFPROBE:?}"
mkdir -p /tmp/kv-ffmpeg
curl -fsS --retry 3 --retry-all-errors --connect-timeout 10 --max-time 60 -o /tmp/kv-ffmpeg/ffmpeg.gz "$KV_URL_FFMPEG" || exit 21
curl -fsS --retry 3 --retry-all-errors --connect-timeout 10 --max-time 60 -o /tmp/kv-ffmpeg/ffprobe.gz "$KV_URL_FFPROBE" || exit 21
printf '%s  %s\n%s  %s\n' '<FFMPEG_GZ_SHA256>' /tmp/kv-ffmpeg/ffmpeg.gz '<FFPROBE_GZ_SHA256>' /tmp/kv-ffmpeg/ffprobe.gz | sha256sum -c - >&2 || exit 22
gzip -dc /tmp/kv-ffmpeg/ffmpeg.gz > /tmp/kv-ffmpeg/ffmpeg || exit 23
gzip -dc /tmp/kv-ffmpeg/ffprobe.gz > /tmp/kv-ffmpeg/ffprobe || exit 23
printf '%s  %s\n%s  %s\n' '<FFMPEG_SHA256>' /tmp/kv-ffmpeg/ffmpeg '<FFPROBE_SHA256>' /tmp/kv-ffmpeg/ffprobe | sha256sum -c - >&2 || exit 22
rm -f /tmp/kv-ffmpeg/*.gz
chmod 0755 /tmp/kv-ffmpeg/ffmpeg /tmp/kv-ffmpeg/ffprobe || exit 23
test -x /tmp/kv-ffmpeg/ffmpeg && test -x /tmp/kv-ffmpeg/ffprobe || exit 23
```
  (i `<…>` sono le costanti di 4.2 interpolate). Il `>&2` porta la riga `FAILED` di sha256sum nella
  diagnosi. Il commento «non si riprova» va riscritto: il job adesso si ritenta riscaricando e
  riverificando, e **non esegue mai un binario non verificato**.

### 4.4 Firma dei binari (runner)
- Gli URL di lettura dei due `.gz` (`urlLettura(BUCKET_BUILD_VIDEO, …, SECONDI_FIRMA_BUILD = 900)`) si
  firmano in `apparecchiaEAvvia` (oggi `esegui.ts:297-307`) **solo quando la MicroVM è nuova**: firmare a
  ogni tick metterebbe un punto di rottura nuovo sui riagganci delle conversioni lunghe.
- Gli URL entrano **solo** nell'`env` dell'apparecchio (preparazione). **Mai** nell'`env` di `avvia`
  (oggi 352-363), **mai** negli `args`.
- `urlLettura` (`adattatori.ts:155-167`) restituisce anche `stato` (`error.status`) e `codiceStorage`
  (`error.code`, es. `NoSuchKey`) di `StorageApiError`.

### 4.5 Classi di guasto e ritentativi (nuovo `src/lib/media/video/runner/ritentativi.ts`, funzioni pure, nessun import dell'SDK)
```ts
export const TENTATIVI_MASSIMI_GUASTO_NOSTRO = 4
export const ATTESE_FRA_TENTATIVI_S = [300, 600, 900] as const
export const CADENZA_CRON_RUNNER_S = 300
export const FINESTRA_TENTATIVI_S = 3600
export type ClasseGuasto = 'file' | 'non-ritentabile' | 'infra-transitoria' | 'infra-permanente'
// httpDallaDiagnosi(stderr) → numero|null (riconosce `returned error: 404`, `HTTP/1.1 503`, ecc.)
// classeDelDownload(http, codiceStorage?) · classeDaUscitaApparecchio(uscita, diagnosi)
// classeDaUscitaConversione(uscita, diagnosi) · decidiRitentativo(attempt, classe)
```
Invarianti (provate nei test): `ATTESE.length === TENTATIVI - 1`; attese monotone crescenti;
`somma(ATTESE) + TENTATIVI × CADENZA ≤ FINESTRA` (1800 + 1200 = 3000 ≤ 3600); `CADENZA` uguale allo
schedule `1,6,…,56` di `20260918120000_video_runner_tick.sql`; `file` e `non-ritentabile` non si
ritentano mai.

| Punto (oggi in `esegui.ts`) | Codice | Classe |
|---|---|---|
| firma dell'originale (223-225) | `SOURCE_DOWNLOAD_FAILED` | permanente se stato 404/400, altrimenti transitoria |
| firma dell'uscita (226-229) | `OUTPUT_UPLOAD_FAILED` | transitoria |
| apertura della MicroVM (245-250) | `SANDBOX_UNAVAILABLE` | transitoria |
| **nuovo**: firma della build | `BUILD_DOWNLOAD_FAILED` | permanente se `NoSuchKey`/4xx, altrimenti transitoria |
| uscita 21 | `BUILD_DOWNLOAD_FAILED` | HTTP dallo stderr: 4xx permanente; 5xx, `000`, timeout transitoria |
| uscita 22 / 23 | `BUILD_HASH_MISMATCH` / `BUILD_EXTRACT_FAILED` | permanente |
| uscita 24 (HEAD dell'originale) | `SOURCE_DOWNLOAD_FAILED` | 404 permanente, altrimenti transitoria |
| uscita 25 (ffprobe sull'URL) | `PROBE_COMMAND_FAILED` | transitoria **solo** se lo stderr mostra errore di rete/HTTP (D3); altrimenti non ritentabile |
| altre uscite dell'apparecchio (1, 127, 137…) | `BUILD_DOWNLOAD_FAILED` | transitoria (fallire chiusi) |
| inventario (322-325) | `BUILD_INCOMPLETE` | permanente |
| probe e verifiche del file (327-332, 336-342, 378-379, 389-397) e `ENCODE_FAILED` di geometria | codici attuali | **file** (rifiutato, invariato) |
| scrittura degli argomenti (344-350) | `ENCODE_FAILED` | transitoria (guasto della MicroVM) |
| uscite 31 / 34 della conversione | `SOURCE_DOWNLOAD_FAILED` / `OUTPUT_UPLOAD_FAILED` | transitoria (404 permanente) |
| uscita 32, ignota / 33 | `ENCODE_FAILED` / `PROBE_COMMAND_FAILED` | non ritentabile (D3) |

Entrambe le classi `infra-*` si ritentano (la permanente logga a livello **error** con causa leggibile).

### 4.6 Integrazione nel runner (`esegui.ts`, `porte.ts`, `adattatori.ts`, `index.ts`, route)
- `fallisci` (oggi 493-514) diventa `chiudiPerGuasto(d, job, { codice, classe, diagnosi, causa?, http? })`,
  con la classe dichiarata a ogni punto della tabella: `file` → ramo di oggi con `rifiutato=true`;
  `non-ritentabile` → ramo di oggi con `rifiutato=false`; `infra-*` → `decidiRitentativo(job.attempt)` →
  `d.coda.riprova(…)` oppure, a tentativi esauriti, fallimento con `tentativi_esauriti`.
- `CodaVideo.riprova(p: { jobId; fenceEpoch; leaseOwner; codice; tentativiMassimi; attesaSecondi })` →
  `rpc('video_job_retry', {p_job_id, p_fence_epoch, p_lease_owner, p_error_code, p_tentativi_massimi,
  p_attesa_secondi})` tramite `esitoRpc('retry', …)`.
- Esito di `riprova`: `ok` + job `queued` → `{ esito: 'in-riprova', jobId, codice, tentativo, attesaS }`;
  `ok` + `failed` → il DB ha delegato al fallimento, si logga come definitivo; **solo** `RPC_ERROR`
  (trasporto, o RPC assente perché la migrazione non è applicata) → **ripiego** su `video_job_fail` +
  riga `riprova-non-scritta`; un verdetto del DB (`FENCE_MISMATCH`, `LEASE_*`, `INVALID_STATE`) → il job
  non è più nostro: nessun fallimento, `lease-persa`. (Senza il ripiego, una RPC mancante lascerebbe il
  job `processing` e una MicroVM ripartirebbe ogni 5' per 7 giorni.)
- `EsitoRunnerVideo` riceve `in-riprova`. La route del runner scrive il battito a livello **warn** per
  `in-riprova` e risponde 200 `{ ok: true, esito: 'in-riprova' }`.
- `runner/codici.ts`: la testata «VA FUSO… E NON L'HA FATTO» è superata (la fusione è in
  `contratto.ts:186-202`): riscriverla rimandando a `ritentativi.ts`; l'elenco dei codici non cambia.
- `Sandbox.create({ runtime: 'node22' })` **resta** (D7), con un commento che rimanda alla PR 2.

### 4.7 Migrazione dei ritentativi (`…_video_job_ritentativi.sql`)
- `ALTER TABLE public.video_jobs ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz, ADD COLUMN IF NOT
  EXISTS last_error_code text`; CHECK su `last_error_code` (`^[A-Z][A-Z0-9_]{0,79}$`) in un `DO`
  idempotente; **nessun** CHECK che leghi `next_attempt_at` allo stato (lo romperebbero
  `video_job_cancel`, `video_intent_supersede/revoke`, `video_retention_scadenze`); `COMMENT` sulle colonne.
- `public.video_job_retry(p_job_id uuid, p_fence_epoch bigint, p_lease_owner uuid, p_error_code text,
  p_tentativi_massimi int, p_attesa_secondi int)`: `SECURITY DEFINER`, `SET search_path = pg_catalog`,
  lock intent → job come `video_job_fail` (`20260916190100_video_job_transitions.sql:544-671`). Ordine:
  1. `BAD_INPUT` (massimo 1..10, attesa 1..86400, codice nel formato);
  2. `NOT_FOUND` / `INTENT_CHANGED_RETRY` / `FENCE_MISMATCH`;
  3. idempotenza: `status='queued' AND last_error_code = p_error_code AND next_attempt_at IS NOT NULL` → `ok`;
  4. `status IN ('failed','rejected')` → delega a `video_job_fail(…, false)`;
  5. `status <> 'processing'` → `INVALID_STATE`; poi `LEASE_MISMATCH` / `LEASE_EXPIRED`;
  6. `attempt >= p_tentativi_massimi` → `UPDATE … SET last_error_code = p_error_code` (stato invariato)
     e `RETURN public.video_job_fail(p_job_id, p_fence_epoch, p_lease_owner, p_error_code, false)`;
  7. altrimenti `UPDATE … SET status='queued', next_attempt_at = now + p_attesa_secondi * interval '1
     second', last_error_code = p_error_code, lease_owner = NULL, lease_expires_at = NULL, updated_at =
     now` (`original_delete_after` **invariato**) + log `_video_job_transition_log('video-job-retry','warn',…)`;
  8. `REVOKE … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role`.
- `video_job_next`: `CREATE OR REPLACE` copiato **identico** da `20260917210000_video_job_next.sql:133-222`;
  cambia solo il WHERE: `(j.status='queued' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= v_now))
  OR (j.status='processing' AND …)` e il commento. (Senza il filtro un job in attesa più vecchio verrebbe
  scelto, `claim` lo rifiuterebbe e `next` — che non scorre la coda — bloccherebbe **tutta** la coda.)
- `video_job_claim`: copia identica da `20260916190100_video_job_transitions.sql:161-284` con due sole
  modifiche: guardia `IF v_job.status='queued' AND v_job.next_attempt_at > v_now THEN … 'RETRY_NOT_DUE'`
  prima di `INVALID_STATE`, e `next_attempt_at = NULL` nell'UPDATE.
- Blocco `DO` che registra il successo. Il `diff` fra i corpi copiati e gli originali deve mostrare
  **solo** le modifiche dichiarate.

### 4.8 Diagnosi leggibile (nuovo `src/lib/media/video/runner/diagnosi.ts`)
`codaDiagnostica(testo, max)`: toglie gli URL (riusa `senzaUrl` di `script.ts:342-344`), i JWT `eyJ…`,
`token=…`, `signature`, `apikey`; toglie i blocchi `Metadata:` di ffmpeg e le righe con `location`,
`ISO6709`, `creation_time`, `creationdate`, `com.apple.*`, `make`, `model`, `software`, `title`,
`comment`, `artist`; dei segmenti separati da `\r` (progresso) tiene l'ultimo; restituisce le **ultime**
`max` battute, con `…` davanti se ha tagliato. `erroreDiagnostico` (oggi `esegui.ts:539-545`) usa
`codaDiagnostica(diagnosi, MESSAGGIO_MAX - 1)` con `MESSAGGIO_MAX` da `src/lib/logging/serialize.ts:31`.

### 4.9 Log
| Evento (`galleria` o `news`, campi in lista bianca) | Livello | Quando |
|---|---|---|
| `esito:'build-pronta'`, `ms` | info | provvista riuscita (battito del percorso che si era rotto) |
| `esito:'conversione-da-riprovare'`, `error_code`, `tipo` (classe), `tentativi_massimi`, `attesa_s`, `http`; errore con la **coda** della diagnosi; `distingui:['job_id','attempt']` | warn (transitoria) / **error** (permanente) | ogni ritentativo |
| `esito:'conversione-fallita'` + `tipo`, `tentativi_esauriti: true` | error | fallimento definitivo |
| `esito:'riprova-non-scritta'` / `'riprova-rifiutata'` | error / warn | ripiego / verdetto del DB |
| `esito:'video-convertito'` + `ritentato: attempt > 1` | info | successo dopo un ritentativo |
| battito `video-runner-tick` `esito:'in-riprova'` | warn | route del runner |
| SQL `video-job-retry` | warn | RPC |
`loggaEsito` (oggi `esegui.ts:560-578`) accetta `opzioni` (`distingui`): con la deduplica per giorno di
`app_log` i casi dopo il primo non devono sparire.

### 4.10 Client (messaggio chiaro)
- `src/lib/media/video/contratto.ts`: `RETRY_NOT_DUE` nella sezione RPC (108-185) → `VIDEO_RIPROVA`;
  `VIDEO_GUASTO_NOSTRO` in `CODICI_MOSTRATI_VIDEO` (256-293) e in `CHIAVI_MESSAGGIO_VIDEO` (309-325) con
  chiave `erroreVideoGuastoNostro`; nella mappa (438-457) `BUILD_DOWNLOAD_FAILED`, `BUILD_HASH_MISMATCH`,
  `BUILD_EXTRACT_FAILED`, `BUILD_INCOMPLETE`, `SANDBOX_UNAVAILABLE`, `SOURCE_DOWNLOAD_FAILED`,
  `OUTPUT_UPLOAD_FAILED` → `VIDEO_GUASTO_NOSTRO`; `PROBE_COMMAND_FAILED`, `ENCODE_FAILED`,
  `CONVERSION_TIMEOUT` invariati (commenti aggiornati); in `schemaStatoJobVideo` (678-704)
  `riprovaAutomatica: z.boolean().default(false)` (vietata fuori da `queued`/`processing`); funzione pura
  `riprovaAutomaticaInCorso(stato, attempt)` = `(queued && attempt >= 1) || (processing && attempt >= 2)`
  (solo `video_job_uploaded` mette in `queued`, e con attempt 0).
- `src/app/api/video-uploads/[id]/route.ts`: `COLONNE_JOB` (88) e `RigaJob` (100-107) con `attempt`;
  `statoJob` (191-205) calcola `riprovaAutomatica`. `risposte.ts`: `STATO_HTTP_VIDEO` (66-177)
  `RETRY_NOT_DUE: 409`; `rispostaVideo` gestisce `VIDEO_GUASTO_NOSTRO`.
- `src/components/features/gallery/use-video-galleria.ts:282`: messaggio = `fase==='fallito' ?
  frase(job.codice) : job.riprovaAutomatica ? t('galleryVideoRiprovaAutomatica') : null`.
  `VideoInLavorazione.tsx` (174-178) mostra già il messaggio sulle fasi non fallite: aggiungere
  `aria-live="polite"` a quel paragrafo.
  *Ratificato dall'orchestratore il 02/10 (difetto secondario #35):* il messaggio di ritentativo
  compare solo nelle fasi in coda / in conversione — non su una scheda già «annullata» con il job
  ancora `queued` — e vale anche al rientro nella pagina (`segui`), non solo nel polling.
- News (D6): `adminComunicazioni.videoStatoRiprovaAutomatica`, campo `riprova` in `Allegato` e in
  `testoFase` di `src/components/features/admin/news/NewsVideoAllegati.tsx:508-523`.
- Testi (apostrofo tipografico ’; inglese senza contrazioni):
  - `teacherServizi.galleryVideoRiprovaAutomatica` — IT «Il problema è nostro, non del video: lo stiamo
    riprovando in automatico. Non serve caricarlo di nuovo, e puoi chiudere l’app.» — EN «The problem is
    on our side, not with the video: we are retrying automatically. There is no need to upload it again,
    and you can close the app.»
  - `shared.erroreVideoGuastoNostro` — IT «Non siamo riusciti a preparare questo video per un problema
    nostro, non del filmato. Caricalo di nuovo più tardi: se non va ancora, avvisa la segreteria.» — EN
    «We could not prepare this video because of a problem on our side, not with the clip. Please upload
    it again later: if it still does not work, let the office know.»
  - `adminComunicazioni.videoStatoRiprovaAutomatica` — IT «Problema nostro, non del video: riproviamo in
    automatico.» — EN «A problem on our side, not with the video: retrying automatically.»

### 4.11 CI e strumenti
- `.github/workflows/ci.yml` (oggi 31-81): `actions/cache@v4` con `path: ~/.cache/kidville-ffmpeg-bin`,
  `key: ffmpeg-bin-<FFMPEG_SHA256>-<FFPROBE_SHA256>`; se la cache manca, `curl -fsS` dei due `.gz` dagli
  URL nei segreti `CI_FFMPEG_GZ_URL` / `CI_FFPROBE_GZ_URL` (dichiarati **solo** in quel passo); poi sha
  dei `.gz`, `gzip -dc`, sha dei binari, `chmod`, controllo `zscale` (resta), `KIDVILLE_VIDEO_FFMPEG_DIR`.
  Fuori dai commenti **nessun** indirizzo BtbN. Il commento dice la data di scadenza degli URL firmati
  (365 giorni dalla firma) e come rinnovarli.
- `scripts/ffmpeg-nel-bucket.mjs` (Node puro + `@supabase/supabase-js` del repo): legge da **stdin** il
  JSON di `supabase projects api-keys --project-ref uimulkjyekgemjakmepp -o json` e sceglie la chiave di
  servizio. Modalità `--carica --cartella <dir>`: rifiuta di caricare se gli SHA locali non sono quelli di
  `build.ts`; carica con `upsert:false` e `contentType` `application/gzip` (`application/x-xz` per
  l'archivio); poi `createSignedUrl` + download + SHA da capo a fondo; stampa solo nomi, byte e OK/KO.
  Modalità `--firma-ci ffmpeg|ffprobe`: scrive **un solo** URL firmato a 365 giorni su stdout **solo se
  stdout non è un terminale** (per `| gh secret set CI_FFMPEG_GZ_URL`), altrimenti esce 2 con un messaggio.
  Mai chiavi o URL nei log.
- Lock `__tests__/architecture/fixture-video-reali.test.ts`: «un numero, tre posti» diventa «le impronte,
  tre posti»: `impronteIn(BUILD)` e `impronteIn(SPEC)` = insieme dei 5 SHA (tutti distinti);
  `impronteIn(WORKFLOW)` = i **4** SHA che la CI verifica; la spec della build contiene
  `ARCHIVIO_FFMPEG_URL` (provenienza); il workflow senza commenti **non** contiene `github.com/BtbN` e
  contiene `BUCKET_BUILD_VIDEO`/i due percorsi o i segreti; resta il controllo «niente `/latest/`»; lo
  script di preparazione ha almeno 2 `sha256sum -c -` con `gzip -dc` fra i due.
- Spec della build `docs/superpowers/specs/2026-09-16-video-build-verificata.md`: sezione «Dal 2026-10-02:
  la build vive nel nostro Storage» (bucket, percorsi, 5 SHA, come è stata ricavata, procedura per
  cambiare build).
- `__tests__/architecture/provider-esterni-osservati.test.ts:171-178`: `github.com` resta fra gli host
  «non chiamati» (il letterale di provenienza è ancora in `build.ts`); testo riscritto: «nessuno lo
  scarica più; è la provenienza»; via la nota «QUESTA VOCE HA UNA SCADENZA».
- Lock `video-originale-mai-senza-scadenza` (116-121): `video_job_retry` in
  `SENZA_SCADENZA_GIUSTIFICATE` con la ragione «processing → queued: non conclude; la scadenza la scrive
  `video_job_fail` quando i tentativi finiscono».
- Dopo l'applicazione: `bucket-storage-dichiarati` (`RISERVATI` += `video_build`, con commento) e
  `src/lib/gdpr/esegui.ts:310-437` (`video_build: { stato: 'escluso', motivo: «nessun dato personale:
  solo i due binari pubblici di FFmpeg e l'archivio di provenienza» }`), insieme alle fotografie rigenerate.

## 5. Test
- **Nuovi**: `__tests__/lib/video-runner-ritentativi.test.ts` (tabella uscite 0, 1, 21-25, 31-34, 126,
  127, 137, 255 → classe; HTTP 400/403/404 → permanente, 500/503/`000`/null → transitoria; invarianti di
  4.5; cadenza letta dalla migrazione del tick) · `__tests__/lib/video-runner-diagnosi.test.ts` (l'inizio
  dnf reale delle 17 righe seguito da `curl: (22) The requested URL returned error: 404` conserva il 404;
  URL, JWT e metadati iPhone spariscono; lunghezza ≤ max) · `__tests__/lib/video-job-ritentativi.test.ts`
  (PGlite: rimessa in coda; `next` salta i non dovuti e prende un dovuto più recente; dovuto →
  `attempt+1`, `next_attempt_at` azzerato; esauriti → `failed` con `original_delete_after = now+7d`;
  FENCE/LEASE/INVALID_STATE; idempotenza; BAD_INPUT; `claim` → `RETRY_NOT_DUE`; cancel, supersede,
  revoke di un job in attesa; `video_retention_scadenze`(b) su un job in attesa; `anon`/`authenticated`
  senza EXECUTE).
- **Da aggiornare**: `video-runner-preparazione.test.ts` (77-111), `video-runner-preparazione-shell.test.ts`
  (comandi finti: `sudo` e `dnf` non devono mai comparire), `video-runner-orchestrazione.test.ts` (doppio
  dell'archivio 270-279, coda finta 240-268 con `riprova`, asserzione 354-361), `__tests__/api/video-runner-tick.test.ts`
  (157-188), `__tests__/lib/video-contratto.test.ts` (229-255, 538), `__tests__/api/video-uploads-id.test.ts`,
  `VideoInLavorazione.test.tsx`, `video-galleria-recupero.test.tsx`, `teacher-gallery-video.test.tsx`,
  `gallery-video-flusso.test.ts`, i test delle News video; i lock di 4.11; `migrazioni-complete`.
- **Ogni critico**: `npx vitest run __tests__/architecture __tests__/a11y __tests__/lib/video-contratto.test.ts
  __tests__/lib/gdpr-oblio-completo.test.ts __tests__/lib/logging-tetto.test.ts __tests__/api/zod-coverage.test.ts`
  + i test dei file toccati + `npx tsc --noEmit` + `npx eslint <file toccati> --max-warnings 0` + **almeno una
  mutazione** (rompere il codice e vedere il test diventare rosso), leggendo la riga `Test Files N passed`.
- **Sandbox vero (F1, orchestratore, prima del merge)**: MicroVM `node22` in `dub1`, script generato dal
  sorgente del branch, URL firmati di sola lettura verso `video_build` di produzione: uscita 0,
  `mancanzeDellaBuild = []`, una clip HDR generata dentro il Sandbox convertita con `buildVideoEncodeArgs`.

## 6. Verifica in produzione (senza dati sintetici: gli account E2E sono bannati di proposito)
1. Prima del merge (O2): `get_advisors` 0 ERROR; `storage.buckets`/`storage.objects` (dimensioni, MIME);
   `has_function_privilege('anon'|'authenticated', 'public.video_job_retry(uuid,bigint,uuid,text,integer,integer)',
   'EXECUTE') = false`; download firmato con SHA uguale a `build.ts`; F1.
2. Dopo il deploy: deploy collegato al commit; `SELECT public.video_runner_tick_http();`;
   `cron.job_run_details` e `net._http_response` 200; battito `video-runner-tick` in `app_log`.
3. Al primo video vero di un'insegnante: `SELECT status, attempt, error_code, last_error_code,
   next_attempt_at FROM video_jobs ORDER BY created_at DESC LIMIT 5`; in `app_log` `build-pronta` e
   `video-convertito`, nessun `conversione-da-riprovare`.

## 7. Rischi
- Egress Supabase: ≈134 MB per MicroVM nuova (i due `.gz`); a 26 video/giorno ≈ 105 GB/mese sui 250
  inclusi (condivisi con la visione dei genitori). La PR 2 lo azzera con lo snapshot.
- Se Vercel toglie `node22`, ogni job fallisce con `SANDBOX_UNAVAILABLE` (i ritentativi non bastano): la
  PR 2 passa a `node:24`.
- Una lease ripresa conta come tentativo. `video_riconciliazione.in_coda_in_ritardo` conterà i job in
  attesa (solo conteggio).
- Fuori scopo, annotati: i falsi scarti FPS (PR 2/T9); il falso allarme `/api/health` su
  `video-runner-tick` (PR 2/T6).
