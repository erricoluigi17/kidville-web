# PR 1 hotfix video — difetti secondari annotati

> Regola del titolare (02/10/2026): il critico chiude il compito se non trova difetti **bloccanti**
> (non funziona · rischio su dati di minori · perdita di dati · gate rosso · log obbligatori mancanti);
> i difetti secondari si **annotano** qui. Tre di quelli trovati toccano funzionamento o privacy e
> l'orchestratore li ha assegnati all'ondata 2 (colonna «Destino»).

## Ondata 1 (critici: T1 g1, T2 g2, T3 g3, T4 g2 — zero bloccanti)

| # | Compito | File | Difetto | Destino |
|---|---|---|---|---|
| 1 | T1 | `__tests__/architecture/fixture-video-reali.test.ts` | Il lock vieta nel workflow solo `github.com/BtbN` e `ARCHIVIO_FFMPEG_URL`: un URL di un altro host nel passo FFmpeg resterebbe verde (mutazione M3b). Oggi il workflow non contiene URL fuori dai commenti. | annotato |
| 2 | T1 | `__tests__/lib/video-runner-preparazione.test.ts` | Testata (righe 30-39) non aggiornata: parla ancora di «un binario preso da Internet». | rifinitura (ondata 2) |
| 3 | T1 | `src/lib/media/video/runner/preparazione.ts` | Commento di `mancanzeDellaBuild` (276-281) parla ancora dello SHA dell'archivio. | rifinitura (ondata 2) |
| 4 | T1 | `scripts/ffmpeg-nel-bucket.mjs` | Refuso «l'script» (riga 16); motivo inesatto del perché `build.ts` si legge come testo (il motivo vero: `.nvmrc` dice 22 e le 22.x prima della 22.18 non importano `.ts`). | rifinitura (ondata 2) |
| 5 | T1 | `__tests__/fixtures/ffmpeg.ts` | `istruzioni()` (72-74) dice ancora che la CI scarica `ARCHIVIO_FFMPEG_URL`. | rifinitura (ondata 2) |
| 6 | T1 | `.github/workflows/ci.yml` | Il commento dichiara la data di firma degli URL prima che esista; i segreti vanno impostati **prima** che la CI giri (chiave di cache nuova). | O2 (firma il 02/10 → scadenza 02/10/2027; segreti prima della PR) |
| 7 | T1 | `src/lib/media/video/runner/esegui.ts` | Dipendenza attesa: finché T5 non firma `KV_URL_FFMPEG`/`KV_URL_FFPROBE` nell'env dell'apparecchio, ogni MicroVM fallirebbe. **T1 da solo non è rilasciabile.** | T5 (ondata 2) |
| 8 | T2 | `src/lib/media/video/runner/diagnosi.ts` | Fughe possibili solo in casi **costruiti** (0 su 158.532 realistici): prima riga parziale di `tail -c 2000` con coordinate ISO 6709; righe di continuazione di un tag su più righe; `com.android.manufacturer`. | **T5**: maschera per valore delle coordinate ISO 6709, scarto della prima riga parziale, `manufacturer` in lista |
| 9 | T2 | `src/lib/media/video/runner/esegui.ts` | `sanificaMessaggio` può allungare il testo (`[email]`, `"[valore]"`) e il suo taglio toglie la **coda**, cioè la riga del 404, in casi limite. | **T5**: la coda si garantisce dopo la sanificazione |
| 10 | T3 | `__tests__/lib/video-job-ritentativi.test.ts` | La terza condizione dell'idempotenza di `video_job_retry` (`next_attempt_at IS NOT NULL`) non ha un test (stato non raggiungibile con le RPC di oggi). | annotato |
| 11 | T3 | `src/lib/gdpr/esegui.ts` | Voce `video_build` del registro: dice che lo legge «soltanto il runner», ma lo legge anche la CI (URL firmati) e lo script di caricamento. Sostanza («nessun dato personale») vera. | rifinitura (ondata 2) |
| 12 | T3 | `__tests__/architecture/bucket-storage-dichiarati.test.ts` | Commento «migrazione NON ancora applicata» (258-261) diventa falso dopo l'O2. | rifinitura (ondata 2) |
| 13 | T4 | `src/lib/media/video/runner/ritentativi.ts` | L'ancora `^` di `RIGHE_DI_CURL` non ha un test che la fissi (mutante equivalente sugli stderr reali). | annotato |
| 14 | T4 | `src/lib/media/video/runner/script.ts` | La pipeline della HEAD (112-114) non ha `pipefail`: un 404/5xx con `Content-Length` esce 0 invece di 24 → originale mancante classificato come `PROBE_COMMAND_FAILED` transitorio; con un 5xx persistente la dimensione letta è quella della pagina d'errore. | **T5**: `pipefail` (o controllo esplicito dell'uscita di curl) + test |
| 15 | T4 | piano (F1) | In F1 aggiungere un originale illeggibile col moov in coda, letto dall'URL firmato, e verificare che l'uscita 25 sia non-ritentabile. | F1 |
