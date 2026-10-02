# PR 2 video «server e web» — difetti secondari annotati

> Regola del titolare (02/10/2026): il critico chiude il compito se non trova difetti **bloccanti**
> (non funziona · rischio su dati di minori · perdita di dati · gate rosso · log obbligatori mancanti);
> i difetti secondari si **annotano** qui. Quelli che toccano funzionamento o privacy l'orchestratore li assegna a un
> compito delle ondate successive (colonna «Destino»), e il brief di quel compito li cita.

## Ondata A (critici: T1 g1, T3 g1, T2a g1, T9 g1 — zero bloccanti)

| # | Compito | File | Difetto | Destino |
|---|---|---|---|---|
| 1 | T3 | `src/lib/media/video/outbox/consumo.ts` | Il filtro `tipi` si applica **dopo** il claim (`video_outbox_claim` non filtra per tipo): un consumatore filtrato (il runner) prenderebbe gli eventi altrui, li terrebbe in lease senza consegnarli né fallirli e li porterebbe alla quarantena in ~2 h; un `gallery.auto_publish` potrebbe restare dietro 5 eventi altrui. Oggi nessuno passa `tipi`. | **T2c** (overload `video_outbox_claim(uuid, integer, integer, text[])`) + **T7** (`consumo.ts` lo usa quando `tipi` è definito); spec §8.1 aggiornata |
| 2 | T3 | `src/lib/media/video/outbox/consumo.ts` | Deviazione dichiarata dal «comportamento invariato»: un destinatario che lancia diventa un fallimento con backoff (`DESTINATARIO_ECCEZIONE`, log `error`) invece di un 500 della retention. Coerente con §8.5. | annotato |
| 3 | T3 | `__tests__/architecture/isolamento-sede-coverage.test.ts` | La voce `gdpr/retention-video:<modulo>` descrive ancora `svuotaOutbox`/`ricevutaRetention` come helper della route (ora in `outbox/destinatari.ts`, fuori dal perimetro del lock). Lock verde, testo stantio. | **T13** |
| 4 | T3 | `__tests__/api/gdpr-retention-video.test.ts` | Il lock di famiglia genera un test per `gallery.auto_publish` (scritto dal file A), **rosso per costruzione** finché T7 non registra il destinatario vero. Non si aggira con un destinatario finto. | rosso atteso fino a **T7** |
| 5 | T3 | `src/app/api/gdpr/retention-video/route.ts` | Quando la retention consegnerà anche le pubblicazioni, 25 eventi con lease di 120 s (numeri pensati per ricevute da millisecondi) possono non bastare: lavoro doppio e `LEASE_MISMATCH`. | **T7 + T13** (dimensionare lease e limite) |
| 6 | T3 | `__tests__/lib/video-outbox.test.ts` | Il test «non tiene una copia propria del consumo» legge il testo grezzo della route, commenti compresi: un commento che nomina `video_outbox_claim` & co. lo fa diventare rosso. | avviso a **T13** |
| 7 | T3 | `__tests__/lib/video-outbox.test.ts` | Due test PGlite dipendono dal tempo reale (≈0,3 s su un margine di 5 s). | annotato (osservare la CI) |
| 8 | T3 | PRD | Voce: consumo di `video_outbox` estratto in `src/lib/media/video/outbox/`, la retention lo chiama con gli stessi numeri. | **T16** |
| 9 | T9 | `runner/esegui.ts`, `runner/script.ts` | **Il timeout proporzionale non è cablato**: `scriptConversione` passa a `videoTemporalProgram` solo indici e fps, quindi oggi ogni sonda temporale parte col tetto (900 s) invece dei 120 s di prima: due sonde in serie = 30 min = `TETTO_SANDBOX_MS`, e un ffprobe piantato consuma la MicroVM. | **T6** (passare `durationSeconds`, `width`, `height` del probe) + **T8** (tipo del parametro di `scriptConversione`); **T16 lo verifica prima del rilascio** |
| 10 | T9 | `src/lib/media/video/verify.ts` | `diagnosiVerifica` è pronta ma nessuno la chiama (va scritta con `video_job_diagnosi` alla verifica fallita); utile un log `info` quando `ignoredAudioTracks > 0`. | **T8** |
| 11 | T9 | `src/lib/media/video/temporale.ts` | La copertura terminale è tolta anche in `reduce60` (stessa causa, riprodotta a 120 fps). | spec §10.5 aggiornata; PRD (**T16**) |
| 12 | T9 | `src/lib/media/video/probe.ts` | Fra le tracce audio decodificabili vince la predefinita, poi la prima (conserva il comportamento di oggi). «Decodificabile» = codec riconosciuto da ffprobe. | PRD (**T16**) |
| 13 | T9 | `src/lib/media/video/probe.ts` | Preesistente: `durationSeconds` è il massimo anche sulle tracce audio **ignorate**; una traccia ignorata più lunga porterebbe a `OUTPUT_DURATION_MISMATCH` dopo la conversione. | **T8** (escluderle dal massimo, se semplice) |
| 14 | T9 | `__tests__/lib/video-verify.test.ts` | I 6 casi con ffmpeg vero non sono mai girati sulla build pinnata n9.0.1 (solo su Homebrew 8.1.2): il primo giro vero è la CI. | **T16** (leggere la CI) |
| 15 | T9 | `src/lib/media/video/temporale.ts` | `TERMINAL_COVERAGE_MISMATCH` sparisce dai log, compare `DURATION_LIMIT`: query e runbook da aggiornare. | PRD (**T16**) |
| 16 | T9 | `__tests__/lib/video-probe.test.ts` | Proprietà condivisa T1/T9: chi lo tocca dopo lo rilegga prima di scrivere. | annotato |
| 17 | T9 | `src/lib/media/video/verify.ts` | Voluto dalla spec: una sorgente senza audio con l'ultimo fotogramma tenuto a lungo ora passa (prima veniva scartata). | PRD (**T16**) |
| 18 | T1 | `src/lib/media/video/contratto.ts` | JSDoc di `CODICI_MOSTRATI_VIDEO` con l'esempio «supera i tre minuti». | **T5** (rifinitura) |
| 19 | T1 | `src/lib/media/video/contratto.ts` | `schemaCorpoRunnerVideo` non è `.strict()`: `{jobId}` (refuso) passa come `{}` e il runner fa il giro intero senza dirlo. | **T6** (renderlo `.strict()` → 400, aggiornare il test) |
| 20 | T1 | `src/lib/media/video/contratto.ts` | `put-nativo` accettato anche senza `sha256`. Decisione del titolare: lo `sha256` del nativo è verificato nel Sandbox. | **T5**: obbligatorio con `put-nativo` (spec §6 aggiornata) |
| 21 | T1 | `src/lib/media/video/contratto.ts` | `sha256` è **per file** (`file[i].sha256`), la spec lo scriveva come campo della richiesta. | spec §6 aggiornata; avviso alla PR 3 |
| 22 | T1 | `src/lib/media/video/contratto.ts` | `classi` rifiuta la stringa vuota (min 1), `/api/gallery` no. Oggi nessun client manda classi. | annotato |
| 23 | T1 | `__tests__/lib/video-contratto.test.ts` | `DICHIARATI_IN_ANTICIPO` contiene `PUBBLICAZIONE_NON_RIUSCITA` (T7, TypeScript): nessuna fonte del lock legge il pubblicatore. | **T7** (fonte TS nel lock) → **T16** porta la deroga a zero |
| 24 | T1 | `__tests__/lib/video-contratto.test.ts` | Attrito: ogni codice SQL nuovo di T2b/T2c rende rosso il lock del contratto. | **T2b/T2c** autorizzati a dichiarare i propri codici in `contratto.ts`, `risposte.ts` e nella tabella del test (rileggendo prima di scrivere) |
| 25 | T1 | `__tests__/lib/video-runner-orchestrazione.test.ts` | `toBeLessThanOrEqual(180)` e commento sul vecchio tetto (verde, invecchiato); commento gemello in `runner/esegui.ts:592`. | **T6** |
| 26 | T1 | vari | Commenti e fixture con 180 / «tre minuti» (nessun tetto attivo): `upload/stato.ts`, test tus/archivio (T10); `video-galleria-flusso.ts`, `page.tsx`, test della pagina e di `VideoInLavorazione` (T11); `gallery-carica-media-409.test.ts`, `logging-tetto.test.ts` (T12). | **T10, T11, T12** sui propri file |
| 27 | T1 | `src/lib/media/video/encode.ts` | Il tetto VBV scende da 86,8 a 52,3 Mbit/s (derivato, conto rifatto) ma non misurato su 5 minuti. | **T16** (prova 1080p di 300 s) |
| 28 | T1 | `src/lib/media/video/contratto.ts` | La regola #37 non ha ancora consumatori; limite noto (un job ritentato e poi caduto su un difetto del file legge «problema nostro»). | **T5** (`statoJob()` usa `codiceMostrabileDelJob`), **T10** (#39 News), **T7** |
| 29 | T1 | `supabase/migrations/…sql.mutbak` | Residuo di una mutazione di T2a. | ✅ già assente al controllo dell'orchestratore |
| 30 | T2a | file A, `video_job_diagnosi` | La jsonpath controlla solo i **valori** stringa, non le **chiavi**: un nome di file può entrare come chiave. Oggi lo scrive solo il runner con chiavi fisse. | **T2c** (stesso controllo sulle chiavi + riga nel test) |
| 31 | T2a | file A, `video_rinnovo_usa` | Un token revocato dopo l'arrivo/annullamento risponde lo stato fino alle 48 h invece di `TOKEN_NON_VALIDO`. | ✅ decisione dell'orchestratore (spec §5.3 aggiornata); **T5** e **T15** la seguono |
| 32 | T2a | file A, `video_runner_kick` | `PG_NET_ASSENTE` a livello `info`: in produzione un pg_net sparito si vedrebbe poco. | **T2c**: `error` se l'URL del runner è configurato (l'ambiente doveva avere pg_net), `info` altrimenti (CI, PGlite) |
| 33 | T2a | file A, blocco `$probe$` | Togliere il vincolo «se non contiene 300» riporterebbe a 300 un tetto futuro diverso: va tolto solo se la definizione è quella a 180. | **T2c** |
| 34 | T2a | `__tests__/architecture/soglia-fotografia.ts` | Voce in `MIGRAZIONI_ATTESE_AL_MERGE` (fuori elenco, necessaria). | **T16**: le chiavi seguono il nome se il file si rinomina; si svuota dopo la rigenerazione delle fotografie |
| 35 | T2a | `__tests__/architecture/migrazioni-complete.test.ts` | `IN_CODA` ammette solo file esistenti: una voce per compito. | **T2b, T2c** |
| 36 | T2a | `__tests__/api/gdpr-retention-video.test.ts` | Tolto il ramo video di `/api/gallery`, l'unico scrittore di `gallery.published` è `video_galleria_pubblica`, che passa il letterale a `video_intent_finalize`: il test anti-cecità diventerà rosso, serve una terza forma di raccolta. | **T4** |
| 37 | T2a | file A (testata) | Le RPC esistenti restituiscono `to_jsonb(riga)`, ora con `tag_alunni`, hash del token e `sha256_dichiarato`. | **T5, T6, T7**: mai inoltrarle al client né loggarle |
| 38 | T2a | file A, `video_galleria_intent_apri` | Firma con `p_original_path` in più; codici nuovi da mappare (`NON_AUTOMATICA`, `FILE_URL_NON_VALIDO`, `GIA_SORVEGLIATO`, `URL_ASSENTE`, `POST_FALLITO`, `INTENT_PUBLISHED`, motivi di `RIPROVA_NON_POSSIBILE`); `video_intent_esito_segna` ha un controllo `INVALID_STATE` in più. | **T5, T7** |
| 39 | T2a | file A, `video_runner_ventaglio` | `p_escludi` è un **job**, non un'invocazione; il secondo ciclo calcia anche job già sorvegliati (un'invocazione sprecata). | **T6** |
| 40 | T2a | file A, `video_galleria_pubblica` | Scrive `output_delete_after = now` senza poter verificare da SQL che la copia in galleria esista. | **T7**: chiamarla solo dopo una copia riuscita e verificata (anche il 409 con la stessa dimensione) |
