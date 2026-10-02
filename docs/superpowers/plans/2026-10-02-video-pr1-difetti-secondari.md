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

## Ondata 2 (regola nuova: OK al primo critico senza bloccanti)

### R — rifiniture documentali (critico g1: OK, zero bloccanti)

| # | File | Difetto | Destino |
|---|---|---|---|
| 16 | `src/lib/media/video/runner/preparazione.ts` | Il commento di `mancanzeDellaBuild` (riga ~289) attribuisce alla «testata di `build.ts`» una frase che sta nel commento di `FILTRI_RICHIESTI` (`build.ts:127-128`). C'era già prima. | annotato |
| 17 | `src/lib/media/video/build.ts` | Righe 127-128: «(il collaudo oggi, il runner domani)» è superata: il runner verifica già l'inventario (`mancanzeDellaBuild` → `BUILD_INCOMPLETE`). | annotato |
| 18 | `__tests__/lib/video-runner-preparazione-shell.test.ts` | Righe 32-34: dicono ancora che la prova con `curl`/`sha256sum`/`gzip` veri «si fa … prima del merge (F1)». F1 è fatta (02/10, P1 in 8,3 s). | annotato |
| 19 | `docs/superpowers/specs/2026-09-16-video-build-verificata.md` | Riga 64: la misura del percorso nuovo è scritta al futuro; esiste (F1 P1: 8,3 s su un tetto di 120 s). | annotato |
| 20 | `src/lib/gdpr/esegui.ts` | Voce `video_build`: «lo scrive soltanto `scripts/ffmpeg-nel-bucket.mjs`». Il 02/10 F1 ci ha scritto clip sintetiche, poi tolte (conteggio 0 verificato). Ogni prova futura usi solo clip generate e le tolga. | annotato |
| 21 | `__tests__/architecture/fixture-video-reali.test.ts` | Nessun test custodisce la prosa del compito; rimettere `ARCHIVIO_FFMPEG_URL` nel messaggio di `istruzioni()` resterebbe verde. Guardia proposta: `not.toContain('ARCHIVIO_FFMPEG_URL')` e `not.toContain('github.com/BtbN')` sul file della fixture senza commenti. | annotato |

### T5 — integrazione nel runner (critico g1: OK, zero bloccanti; 10 mutazioni tutte rosse)

| # | File | Difetto | Destino |
|---|---|---|---|
| 22 | `src/lib/media/video/runner/esegui.ts` | `riprova()` con risposta `ok` e job non `queued` logga sempre `conversione-fallita` con `tentativi_esauriti: true`, anche quando la RPC ha delegato perché il job era GIÀ `failed`/`rejected` (passo 4). Solo il racconto del log. | annotato |
| 23 | `src/lib/media/video/runner/esegui.ts` | A tentativi esauriti il runner chiama `video_job_fail` direttamente (lettera di §4.6): `last_error_code` resta quello del ritentativo precedente, mentre il commento della colonna dice «o con cui ha esaurito i tentativi». | PR 2 (chiamare `riprova` anche all'ultimo giro, o correggere il commento) |
| 24 | `src/lib/media/video/runner/esegui.ts` | Ogni codice di `riprova` diverso da `RPC_ERROR` (anche `BAD_INPUT`) vale come verdetto del DB → `lease-persa`. Oggi irraggiungibile (argomenti sempre validi). | annotato |
| 25 | `src/lib/media/video/runner/esegui.ts` | `build-pronta` si scrive solo con apparecchio uscito 0 e inventario completo; con la provvista riuscita e la HEAD/ffprobe fallite (24/25) non compare. | annotato |
| 26 | `src/lib/media/video/runner/esegui.ts` | `ritentato: attempt > 1` vale anche per un job ripreso dopo una lease scaduta, senza `video_job_retry`. | annotato |
| 27 | `src/lib/media/video/runner/esegui.ts` | Se il DB ha scritto il retry ma la risposta si è persa (`RPC_ERROR`), il ripiego su `video_job_fail` riceve `INVALID_STATE`: log `fallimento-non-scritto` e battito `fallito`, mentre il job ripartirà. Innocuo, racconto sbagliato. | annotato |
| 28 | `src/lib/media/video/runner/codici.ts` | Oltre alla testata, aggiornati i JSDoc di tre codici (dicevano «non si riprova», «tar»). Elenco identico (10). | annotato |
| 29 | `src/lib/media/video/runner/ritentativi.ts` | Il commento di `RIGHE_DI_CURL` descrive la HEAD senza `pipefail`, cioè il comportamento PRIMA della correzione #14. | rifinitura |
| 30 | `__tests__/lib/video-runner-ritentativi.test.ts` | Il caso a riga ~628 («una HEAD con un 404 … esce 0, non 24») racconta il comportamento precedente alla #14 (resta verde: funzioni pure su stringhe). | rifinitura |
| 31 | `src/lib/media/video/runner/diagnosi.ts` | La maschera per valore copre le coordinate ISO 6709 in gradi decimali (iPhone, Android), non le forme gradi-primi (`+4051.108+01416.086/`) senza il nome del tag. Solo casi costruiti. | annotato |
| 32 | `src/lib/media/video/runner/script.ts` | Raccomandazione: rifare F1 con gli script nuovi (originale tolto dopo la firma → 24; diario > 2000 byte). | **fatto**: F2/F1-bis verdi (P7' → 24, P8 diario lungo), vedi il piano §F2 |
| 33 | `src/lib/media/video/runner/esegui.ts` | Preesistente, fuori spec: un'eccezione dell'SDK del Sandbox dentro `esegui`/`avvia` non è classificata; il job resta `processing` e si riprende alla scadenza della lease con `attempt+1`, senza attesa né tetto. | **PR 2** |

### T6 — contratto e messaggio chiaro (critico g1: OK, zero bloccanti; 6 mutazioni tutte rosse)

| # | File | Difetto | Destino |
|---|---|---|---|
| 34 | brief dell'orchestratore (workflow dell'ondata 2) | Il comando di verifica di T6 nominava `__tests__/lib/news-video-flusso.test.ts`, che non esiste (il file vero è in `__tests__/components/`): vitest usciva verde con 7 file su 8. Il piano non lo contiene; il critico ha rieseguito col percorso vero (8/8, 265 verdi). | chiuso (errore del brief, non del codice) |
| 35 | `src/components/features/gallery/use-video-galleria.ts` | Deviazione dalla formula letterale di §4.10, dichiarata e provata: il messaggio di ritentativo compare solo nelle fasi in-coda/conversione (non su una scheda «annullato») e anche al rientro (`segui`), non solo nel polling. | **ratificata** (spec §4.10) |
| 36 | `src/components/features/gallery/VideoInLavorazione.tsx` | `aria-live` su un paragrafo montato a condizione: VoiceOver spesso non annuncia una regione viva che entra nel DOM già piena (le insegnanti dell'incidente erano su iOS). Forma robusta: paragrafo sempre montato. | PR 2 (client riscritto) |
| 37 | `src/lib/media/video/contratto.ts` | `PROBE_COMMAND_FAILED` (uscita 25 con errore di rete) ed `ENCODE_FAILED` (scrittura degli argomenti) sono guasti NOSTRI ritentati, ma a tentativi esauriti l'insegnante legge «file illeggibile»/«conversione non riuscita» invece di «problema nostro». Durante i ritentativi il messaggio è giusto. | **PR 2** (esiti all'insegnante) |
| 38 | `src/lib/media/video/contratto.ts` | Un bundle vecchio (scheda o WebView non ricaricata) che riceve `VIDEO_GUASTO_NOSTRO` scarta lo stato (enum chiuso): la scheda non si aggiorna e ogni 5 s registra `video-galleria-job-fuori-contratto` fino al ricaricamento. Transitorio, nessun dato perso. | annotato + PRD |
| 39 | `src/components/features/admin/news/NewsVideoAllegati.tsx` | Preesistente: al rientro un job `failed` mostra `VIDEO_RIPROVA` invece del codice vero (ora `VIDEO_GUASTO_NOSTRO`). | PR 2 |
| 40 | `src/lib/ui/esito-fetch.ts` | Il commento dice «QUATTORDICI codici» e «sessantadue interni»: ora sono 15 e 76. | annotato |
