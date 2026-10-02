# Suite E2E Playwright (M8)

## Come si lancia

```bash
npm run e2e          # seed automatico (globalSetup) + dev server porta 3100 + suite
npm run e2e:seed     # solo il seed, a mano
npx playwright show-report   # report HTML dell'ultimo run
```

Prerequisiti una tantum:

- `.env.local` con `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` (il seed usa la service-role; i test usano sessioni vere,
  `ALLOW_HEADER_IDENTITY=false` resta rispettato).
- `export KV_E2E_PASSWORD='…'` — la password dei 4 account `*.e2e@kidville.test`.
  **Non è nel repo** e non ha default: senza, `npm run e2e:seed` esce con `exit 1` e la
  suite fallisce all'import di `e2e/fixtures.ts`. In CI arriva dal secret GitHub
  `CI_E2E_PASSWORD` (job `e2e` di `.github/workflows/ci.yml`). Il seed la **rimposta** a
  ogni esecuzione, quindi per ruotarla basta cambiare il secret e rilanciare.
  Perché sta fuori dal repo: il 2026-07-29 il provisioning di Kidville Aversa e Kidville
  Cesa ha collegato `admin.e2e@kidville.test` (ruolo `admin`) a due sedi **vere**, e quel
  letterale committato è stato per due giorni una credenziale di Direzione valida in
  produzione, in un repository pubblico. Vedi `e2e/lib/e2e-password.mjs`.
- `npx playwright install chromium`.

Architettura: `playwright.config.ts` avvia `next dev --port 3100` (`webServer`),
il progetto `setup` fa login UI per i 3 ruoli e salva gli storageState in
`e2e/.auth/*.json` (gitignorati); gli spec riusano quelle sessioni.

## Cosa semina `scripts/seed-e2e.mjs`

**Due** scuole dedicate, con UUID fissi prefisso `e2e00000-…`: i dati demo/reali delle
altre scuole NON vengono toccati.

### Sede 1 — "Kidville E2E" (`e2e00000-…-0001`)

| Entità | Dettaglio |
| --- | --- |
| Sezioni | `Girasoli` + `Tulipani` + `Nuovi Iscritti` (infanzia). Il nome Girasoli è obbligato: appello e diario docente sono agganciati a quel nome. |
| Alunni | Aurora Arcobaleno-E2E, Bruno Baleno-E2E (Girasoli); Clara Cometa-E2E, Dino Delfino-E2E (Tulipani) — tutti `iscritto`. |
| Utenti Auth | `admin.e2e@kidville.test` (admin), `docente.e2e@kidville.test` (educator, sezione Girasoli), `genitore.e2e@kidville.test` (genitore di Aurora), `doppio.e2e@kidville.test` (educator Tulipani **+** bridge `parents.auth_user_id` ⇒ picker multi-profilo), `segreteria.e2e@kidville.test` (segreteria). Password comune: dalla variabile d'ambiente **`KV_E2E_PASSWORD`** (vedi sotto), mai scritta nel repo. |
| Config scuola | `admin_settings`: `diario_config.routine_attive` include `umore`; `avvisi_config.ruoli_pubblicazione = ['admin','teacher']`. |
| Dati di contorno | 1 avviso adesione (classe Girasoli), 1 evento agenda futuro (Girasoli, visibile ai genitori), presenze di oggi SOLO per Tulipani (Girasoli = "appello mancante"), 2 pagamenti di Aurora (aperto+pagato), armadietto Aurora con stock 1 (bottone "Avvisa"), diario di oggi di Aurora (umore + attività), 1 notifica non letta per l'admin, 1 form model + submission `completed` non gestita. |

### Sede 2 — "Kidville E2E Due" (`e2e00000-…-0002`)

Esiste dal 2026-07-31 (audit multi-sede, rilievo R132). Fino ad allora il seed creava una
sola scuola: **nessuno spec poteva accorgersi di una perdita di dati fra sedi**, non perché
l'isolamento fosse dimostrato ma perché non c'era un confine da attraversare. È la sede su
cui gira `e2e/isolamento-sedi.spec.ts`.

| Entità | Dettaglio |
| --- | --- |
| Sezione | `Girasoli` — **omonima** di quella della sede 1, ed è il punto: il nome-classe non è una chiave (a DB l'unicità è `(scuola_id, name)`), ed è l'ambiguità che il 2026-07-29 ha attivato le falle dormienti. |
| Alunni | Emma Eclissi-E2E (Girasoli), `iscritto`. |
| Utenti Auth | `segreteria2.e2e@kidville.test` (segreteria), `docente2.e2e@kidville.test` (educator, la Girasoli della sede 2), `genitore2.e2e@kidville.test` (genitore di Emma). Nessun ponte `utenti_scuole`: ogni account ha UNA sede, come in produzione per segreteria ed educator. |
| Config scuola | Identica a quella della sede 1 (di proposito: una configurazione diversa renderebbe verde un test d'isolamento per il motivo sbagliato). |
| Dati di contorno | 1 avviso `presa_visione` con `target_classes: ['Girasoli']` — l'**ancora** delle asserzioni negative: distingue «l'avviso dell'altra sede non c'è» da «la pagina non ha caricato niente». |
| Chat | 1 conversazione `docente2` ↔ `genitore2` su Emma (`IDS.THREAD_LUNGO`) con **60 messaggi**: id fissi `e2e00000-…-0000000c00NN`, testo sintetico «Messaggio lungo NN», mittente alternato, istanti al microsecondo a un minuto l'uno dall'altro — tranne il 10 e l'11, **identici**, sul confine della finestra degli ultimi 50. Tutti letti (lo spec gira su chromium e webkit sulle stesse righe), nessun `delivered_at` (colonna assente sul DB della CI). È la premessa di `e2e/chat-precedenti.spec.ts`; i perché per esteso stanno accanto al dato, in `CHAT_LUNGA_E2E`. |

Entrambe le sedi restano **fuori dagli elenchi pubblici**: `isScuolaE2E`
(`src/lib/scuole/reali.ts`) le riconosce dal prefisso `e2e00000` e da «e2e» nel nome,
quindi il selettore di sede del wizard `/iscrizione` non le mostra.

## Idempotenza e reset

Il seed è upsert su UUID fissi e **azzera i soli dati E2E mutabili** a ogni run:
presenze/diario/agenda/notifiche/pagamenti/armadietto/chat degli utenti-alunni E2E di
**entrambe** le sedi (per la chat: i thread di `genitore` e di `genitore2`, con i loro
messaggi — la conversazione lunga si cancella e si riscrive da zero), risposte agli avvisi seminati, avvisi creati dai docenti E2E nei
test (prima le risposte, poi gli avvisi: c'è una FK), e gli artefatti del flusso pubblico
d'iscrizione (submission con CF `TSTBNE20A01H501X`, anagrafiche e account
`iscrizione.e2e@kidville.test` creati dall'import admin). Eseguibile N volte.

Dal 2026-10-02 il reset comprende anche **i video** degli utenti E2E (`ripulisciVideoE2E` nel seed): gli intenti
di `video_intents` dei run precedenti con i loro job, l'outbox, la riga di galleria del video pubblicato
(`galleria_media_v2.upload_id` = intento) e gli oggetti nello Storage (`video_originals`, `video_processing`, la copia
`uploads/<utente>/v-<intento>.mp4` in `gallery`). Non usa `must()`: su un database senza la pipeline video avvisa e
prosegue. E riscrive `consenso_privacy = false` per Aurora e Bruno (vedi sotto: uno spec lo accende e lo spegne).

## Gli spec dei video (PR 2 «server e web», dal 2026-10-02)

Quattro spec scrivono davvero sul database e sullo Storage della CI. Girano **solo in CI** (`CI` impostata) e rifiutano di
partire contro un progetto che non sia quello della CI (`e2e/helpers/database-ci.ts`, stessa guardia dell'host del seed):
la chiave di servizio che usano per simulare e rileggere lo stato scavalca ogni RLS, e `.env.local` punta alla produzione.

| Spec | Progetti | Cosa prova | Cosa lascia dietro |
| --- | --- | --- | --- |
| `video-invio-bambini-prima` | chromium + webkit | «Pubblica» con un bambino senza liberatoria → **422 col suo nome nel passo dei bambini, zero richieste a `/storage/v1/upload/resumable`, nessun intento in tabella**; tolto il bambino → apertura 201, **TUS vero**, scheda «In attesa di essere preparato», job `queued`, originale lungo quanto il file, elenco del server `in-coda` | l'intento è annullato e i byte tolti; le due liberatorie tornano al valore di prima (`afterEach`) |
| `video-ripresa-automatica` | chromium | file di 13 MiB (3 blocchi TUS): al secondo blocco `context.setOffline(true)` + abort, la scheda dice «Caricamento interrotto», poi `setOffline(false)` e **nessun clic** → arriva in coda, **una sola sessione, un solo PATCH a offset 0, ripresa dal secondo blocco** | intento annullato, originale (13 MiB) tolto |
| `video-rinnovo-token` | chromium (solo API) | apertura `put-nativo` (con `sha256`) → PUT sull'URL firmato → il **trigger d'arrivo** porta il job in coda e revoca il token → `POST /api/video-uploads/rinnovo` risponde `arrivato`; **seconda PUT rifiutata come duplicato** (HTTP 400 con `statusCode "409"` nel corpo; niente upsert); token falso/malformato/assente → **404 uniforme**; rinnovo prima dell'arrivo → URL nuovo; dopo il ritiro → `annullato` | intenti annullati e byte tolti |
| `video-destinatari` | chromium | intento con [Aurora] → conversione **simulata** col service role (`video_job_claim` + uscita + `video_job_ready`) → un giro del runner come staff → il video è in galleria, **lo vede e ne ha l'avviso solo il genitore di Aurora**; il genitore di un bambino non taggato della stessa sede (il profilo doppio, in veste di genitore) no; l'insegnante riceve `video_esito` | la riga di galleria va nel **cestino** (`DELETE /api/gallery`), la copia e l'uscita si tolgono; resta l'intento `published` (il seed lo toglie al run dopo) |

**Prerequisiti sul database della CI** (non sono nel seed, che non crea tabelle): le migrazioni della PR 1
(`*_video_build_bucket.sql`, `*_video_job_ritentativi.sql`) e le tre della PR 2 (`*_video_pubblicazione_automatica.sql`,
`*_video_arrivo_originale.sql`, `*_video_conservazione_uscite.sql`) vanno applicate **prima** della suite con il workflow
«DB migrate (CI)» (`migrate-ci.yml`, a mano), insieme a quelle del 18/09 senza `pg_cron`. Sul database della CI **non ci
sono `pg_net` né `pg_cron`**: il runner non parte da solo, e l'arrivo di un originale lo vedono il trigger su `storage.objects`
e il `PATCH caricato` del web. Un database senza lo schema fa fermare ogni spec con una frase che dice cosa applicare
(`richiediPipelineVideo`), invece di un 500 che sembra un difetto del codice.

**`VIDEO_RUNNER_OWNER_ID`** è impostata dal `webServer` di `playwright.config.ts` (un uuid finto, `e2e00000-…`): senza,
`POST /api/video/runner` risponde 503 `CONFIGURAZIONE_ASSENTE` e non pubblica niente. L'identità con cui `video-destinatari`
simula la conversione è un'altra (`LAVORATORE_SIMULATO`, in `e2e/helpers/video-ci.ts`): devono restare diverse.

**La liberatoria che cambia.** Il tagger della pagina non lascia mettere nello stesso video un bambino senza liberatoria
insieme ad altri, quindi dalla pagina il 422 si raggiunge solo se il dato cambia mentre l'insegnante sceglie. Lo spec accende
la liberatoria di Aurora e Bruno, apre la pagina, la toglie a Bruno dopo aver scelto i due bambini e prima di premere
«Pubblica». Non si aggiunge nessun bambino alla Girasoli (il suo conteggio è esatto per altri spec) né una docente nuova (un
nono account cambierebbe gli elenchi di personale): gli spec sono seriali (`workers: 1`) e `afterEach` rimette il valore.

**Spec a `retries: 0`**, tutti e quattro: scrivono su un database condiviso e un ripescaggio partirebbe da uno stato sporcato
dal primo tentativo. Non ripetono i controlli di `gallery-caricamento` (le foto): i video hanno la loro pipeline.

## Note e gotcha

- **`utenti.role` live è colonna generata** da `ruolo`: il seed scrive solo `ruolo`.
- Genitore runtime = riga `utenti` con `ruolo='genitore'` (id == auth uid) — è ciò che
  usano legami/chat/pagamenti; il bridge `parents.auth_user_id` esiste comunque (per
  /api/me e per il profilo doppio).
- Le presenze sono seminate con la data **UTC** di oggi (come le legge
  `/api/admin/presenze/realtime`): tra le 00:00 e le 02:00 ora italiana il giorno UTC
  differisce da quello locale e la card presenze può risultare vuota.
- Il test `public-iscrizione` crea una richiesta reale e la importa: gli artefatti
  restano fino al seed successivo, marcati E2E (CF/email fissi di test).
- `isolamento-sedi.spec.ts` **non** usa gli `storageState` del progetto `setup` (che
  conserva le tre sessioni storiche): fa il login dei propri utenti dalla UI. Costa
  qualche secondo in più ed è il motivo per cui i suoi test hanno `setTimeout` espliciti.
- Le sue asserzioni negative sono sempre precedute da una positiva sulla stessa vista:
  `toHaveCount(0)` su una pagina che non ha caricato è verde per il motivo sbagliato. È
  la stessa disciplina che il 2026-07-30 è mancata e ha prodotto due falsi verdi.
