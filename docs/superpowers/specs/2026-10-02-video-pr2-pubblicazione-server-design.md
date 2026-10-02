# Video, PR 2 «server e web» — spec

**Data:** 02/10/2026 · **Branch:** `feat/video-pubblicazione-server` · **Prima:** PR 1 «hotfix» (#179 `a59f6de5`,
in produzione dal 02/10 alle 09:40 UTC) · **Dopo:** PR 3 «app 1.2» (invio nativo in background).

Questa spec nasce dal progetto d'implementazione dell'architetto (sola lettura, 01/10), dalle risposte del titolare
(02/10) e dalle misure di T0 (02/10). Dove il progetto e le decisioni divergono **vincono le decisioni** (§2).
I numeri di riga citati sono indicativi: chi implementa li ritrova nel codice prima di toccarlo.

---

## 1. Obiettivo

**R1.** I bambini si scelgono **una volta, prima** dell'invio, e non si richiedono più. Il video esce **da solo**
quando è pronto, anche a pagina o app chiusa.

Oggi i bambini scelti vivono solo nella memoria della pagina (`use-video-galleria.ts`): il server non li conosce,
la pubblicazione la fa il browser quando il job è `ready`, e se la pagina non c'è il video resta convertito e mai
pubblicato (11 casi misurati). Al rientro la pagina richiede i bambini (`chiedeTag`). Questa PR sposta destinatari e
pubblicazione sul server, fa partire la conversione appena il file arriva e chiude il percorso legacy.

---

## 2. Decisioni del titolare (vincolanti)

| Tema | Decisione |
|---|---|
| Liberatoria (DL-041) | Alla scelta dei bambini **blocca come oggi** (422 con i nomi). Se viene tolta fra l'invio e la pubblicazione il video **esce comunque**, e un **avviso** (solo numeri, mai nomi) va all'insegnante e ad **admin, coordinamento e segreteria** della sede, via centro notifiche + push. |
| Bambino trasferito o cancellato | **Si pubblica senza di lui** e l'insegnante viene avvisata (solo il numero). Se non resta **nessun destinatario**: **non si pubblica** e parte la notifica «non pubblicato». |
| Autore disattivato o senza più la sede | **Si pubblica comunque**. |
| Pubblicazione fallita in modo definitivo | **Notifica + pulsante «Riprova»**. |
| Esiti | L'insegnante riceve una notifica (centro + push) sia per «pubblicato» sia per «fallito/non pubblicato». |
| Limiti | Durata **5 minuti** (300 s) · peso **2 GB** (già così) · uscita **Full HD 1080p** (già così) · watermark invariato · **50 elementi** per scelta. |
| Conservazione | Un convertito non pubblicato si tiene **7 giorni**. |
| Flusso vecchio | Gli invii del flusso vecchio ancora in volo al rilascio si **scartano**: **niente** transizione e **niente** `video_intent_destinatari_legacy`. Gli intenti galleria senza bambini si revocano e la scheda dice «questo video va ricaricato». Gli **11** convertiti mai pubblicati li toglie la **purga**, non una mano. |
| Notifica ai genitori | Titolo **«Nuovi contenuti in galleria»** per foto **e** video, corpo **senza nome di file**. |
| Didascalia | **Nessuna** per i contenuti **nuovi**, foto e video. Le esistenti (4.195) **non si toccano**. ⇒ niente colonna `didascalia` sugli intenti. |
| Costo | Conversione entro **50 $/mese**. Se la misura lo supera, si avvisa il titolare **prima** del rilascio. |
| Nativo (preparato qui per la PR 3) | **PUT senza upsert**, **`sha256` dichiarato** all'apertura e **verificato nel Sandbox**, token di rinnovo. |
| Bloccante | Non funziona · rischio su dati di minori · perdita di dati · gate rosso · log obbligatori mancanti. Ogni altro residuo è una miglioria: si annota e si procede fino al deploy. |

---

## 3. Fatti misurati in T0 (02/10/2026)

- **PR 1 in `main`** (#179, #180): conversioni di nuovo `ready`; il primo video vero è stato convertito al primo
  tentativo. Semantica della PR 1: un job finisce `failed` **solo** a tentativi esauriti (4) o per un guasto non
  ritentabile; `rejected` è un file difettoso. ⇒ **«fallimento definitivo» = `status IN ('failed','rejected')`**
  (`cancelled` non si notifica: l'ha chiesto qualcuno).
- **DB della CI** (`kidville-web-ci`, eu-west-3, sola lettura): `postgres` ha `TRIGGER` su `storage.objects`
  (proprietario `supabase_storage_admin`, come in produzione) e `BYPASSRLS`. **Non ci sono `pg_net` né `pg_cron`.**
  Le migrazioni della PR 1 **non** sono applicate (manca `video_job_retry`; bucket video 2 su 3).
  ⇒ `video_runner_kick` degrada a nessun effetto (con log) se `net.http_post` non esiste; per l'E2E si applicano al DB
  della CI con `migrate-ci.yml` le due migrazioni della PR 1 e le tre di questa PR (tutte idempotenti).
- **Immagine `vercel/sandbox/node:24` in `dub1`** (Sandbox di prova, 2 vCPU, creato in 2,1 s e fermato): **Ubuntu
  26.04.1 LTS**, x86_64, utente `ubuntu` con `sudo` senza password, disco 64 GB. Presenti `gzip`, `sha256sum`, `tar`,
  `node`, `apt-get`. **Assenti `curl`, `wget`, `xz`, `dnf`.** Lo script di conversione usa `curl` (10 occorrenze in
  `runner/script.ts`), e così la provvista della PR 1. ⇒ lo snapshot deve contenere `curl`, installato **una volta,
  alla costruzione** dello snapshot (dall'orchestratore), mai a runtime (§10).
- **Limiti del Sandbox** (README di `@vercel/sandbox` 3.3.0): sul piano Pro fino a **8 vCPU**, 2048 MB per vCPU,
  durata massima 24 h. Il limite di Sandbox **concorrenti** non è documentato: si misura in T16 aprendone 3 insieme.
- **Falso scarto del 28/09** (job `72fff674…`, misurato nel Sandbox, solo numeri): PTS video identici fotogramma per
  fotogramma (264/264); ultimo campione 3,035 ms nella sorgente contro 33,333 ms nell'uscita ⇒ copertura terminale
  8,724060 s contro 8,754358 s (Δ 30,3 ms), tolleranza attuale 3,036 ms ⇒ `TERMINAL_COVERAGE_MISMATCH`. Le due
  timeline (43 KB ciascuna, solo `stream_index`, `best_effort_timestamp`, `duration`, `time_base`, frame rate)
  diventano la fixture di regressione di T9.
- **Produzione** (01/10, solo conteggi): `video_processing` 87 oggetti, 2.571 MiB, di cui 39 uscite di video già
  pubblicati (copie doppie), 26 orfani, 11 di job annullati, 11 `ready` mai pubblicati. 2 originali «risorti» (file
  ricomparso dopo il timbro di cancellazione). Nessun oggetto di `video_originals` con dimensione diversa da quella
  dichiarata; la riga di `storage.objects` nasce **a caricamento finito** (mediana 42 s dopo il job).

---

## 4. Il percorso

```
[passo bambini] → POST /api/video-uploads {file, destinatari, trasporto, sha256?}
   gate: requireDocente → rate limit → zod → resolveScuolaScrittura → cancelli della galleria (403/400/422 come oggi)
   RPC video_galleria_intent_apri (intento confirmed + pubblicazione_automatica + job + token se put-nativo)
   ← coordinate TUS (web, app 1.0/1.1)  |  URL PUT firmato senza upsert + token di rinnovo (app 1.2, PR 3)
byte → Storage video_originals
   ├─ trigger su storage.objects → job queued → video_runner_kick(job) [pg_net]
   ├─ web: PATCH caricato (idempotente: rete di sicurezza + calcio al runner)
   └─ rete: video_arrivi_recupera() a ogni giro di cron
POST /api/video/runner {job_id} → sorveglianza esclusiva → presa con tetto → Sandbox (snapshot | ripiego)
   → verifiche → video_job_ready (+ outbox gallery.auto_publish nella stessa transazione)
   → consumo dell'outbox → pubblicaVideoGalleria():
        riverifiche → copia deterministica in gallery → RPC video_galleria_pubblica (insert + finalize atomici)
        → video_intent_esito_segna('pubblicato') → SOLO se segnato: genitori, esito all'insegnante, avvisi
fallimento definitivo (failed/rejected, pubblicazione fallita da oltre 60', nessun destinatario)
   → video_intent_esito_segna('fallito') → SOLO se segnato: notifica «non pubblicato» (+ «Riprova» se possibile)
GET /api/video-uploads?canale=gallery&scuolaId=… → elenco (in corso, falliti, pubblicati di recente)
```

---

## 5. Modello dati e migrazioni

Tre file con timestamp **provvisori** successivi a quelli della PR 1 (`20261002065952`). In T16 si rinominano
all'istante vero e si applicano con `supabase db push --linked` (version = file, come nella PR 1), **prima** del
merge. Tutti **idempotenti** (`IF NOT EXISTS`, `CREATE OR REPLACE`, blocchi `DO` con guardia), perché girano anche con
`migrate-ci.yml` e in PGlite.

| File provvisorio | Compito |
|---|---|
| `supabase/migrations/20261002150000_video_pubblicazione_automatica.sql` | T2a |
| `supabase/migrations/20261002150100_video_arrivo_originale.sql` | T2b |
| `supabase/migrations/20261002150200_video_conservazione_uscite.sql` | T2c |

**Regole comuni a ogni RPC:** `SECURITY DEFINER`, `SET search_path = pg_catalog` (nomi qualificati), `REVOKE … FROM
PUBLIC, anon, authenticated` e `GRANT EXECUTE … TO service_role`; ordine dei lock sempre **intento → job**;
`clock_timestamp()` dopo i lock; log su `_video_job_transition_log` come le RPC esistenti. **Le funzioni esistenti non
cambiano firma**: le nuove si aggiungono accanto, e il codice vecchio deve continuare a girare nei minuti fra
l'applicazione della migrazione e il deploy. Chi sostituisce un corpo (`CREATE OR REPLACE`) parte dalla
**definizione più recente** fra tutte le migrazioni (anche quelle della PR 1) e il diff dei corpi deve mostrare
**solo** le modifiche dichiarate.

### 5.1 `video_intents`, colonne nuove (file A)

| Colonna | Tipo / vincolo |
|---|---|
| `pubblicazione_automatica` | `boolean NOT NULL DEFAULT false`; CHECK: se vera, `channel = 'gallery' AND requested_action = 'publish'` |
| `tag_alunni` | `uuid[] NOT NULL DEFAULT '{}'`; CHECK `cardinality ≤ 200` |
| `broadcast` | `boolean NOT NULL DEFAULT false`; CHECK: se vero, `cardinality(tag_alunni) = 0` |
| `classi_destinatarie` | stesso tipo di `galleria_media_v2.target_classes` (verificarlo); CHECK `cardinality ≤ 20` |
| `n_tag` | `integer NOT NULL DEFAULT 0`: sopravvive alla minimizzazione, serve all'elenco e agli avvisi |
| `trasporto` | `text NOT NULL DEFAULT 'tus'`; CHECK `IN ('tus','put-nativo')` |
| `esito_notificato`, `esito_notificato_il` | `text` CHECK `IN ('pubblicato','fallito')`, `timestamptz`; CHECK di coppia. È la marca «una volta sola». |
| `pubblicazione_errore` | `text`, ≤ 80 caratteri (solo un codice) |
| `minimizzato_il` | `timestamptz` |

Indici: `(owner_id, channel, updated_at DESC)` per l'elenco; parziale `WHERE pubblicazione_automatica AND
esito_notificato IS NULL` per la scansione degli esiti. **Nessuna didascalia** (§2).

### 5.2 `video_jobs`, colonne nuove (file A)

| Colonna | Vincolo |
|---|---|
| `byte_dichiarati`, `mime_dichiarato`, `durata_dichiarata_s` | 1..2e9; ≤ 255 caratteri; (0, 300] |
| `sha256_dichiarato` | `bytea`, CHECK `octet_length = 32`; facoltativo, lo usa `put-nativo` (§10.4) |
| `arrivato_il`, `sorgente_etag` | scritti dal trigger d'arrivo |
| `rinnovo_token_hash` (`bytea`, CHECK `octet_length = 32`), `rinnovo_token_scade_il`, `rinnovo_token_revocato_il` | indice UNIQUE parziale sull'hash `WHERE rinnovo_token_hash IS NOT NULL`; CHECK hash ⇔ scadenza |
| `output_delete_after`, `output_deleted_at` | CHECK: se c'è `deleted` c'è `after`. Indice parziale `WHERE output_deleted_at IS NULL AND output_delete_after IS NOT NULL` |
| `sorvegliato_da` (uuid), `sorvegliato_fino_a` | CHECK di coppia |
| `diagnosi_verifica` | `jsonb`; CHECK oggetto e `octet_length(diagnosi_verifica::text) ≤ 2048`. Solo numeri ed enumerati. |
| `video_jobs_probe_chk` (esistente) | si toglie e si ricrea con **300** (le righe esistenti sono ≤ 180) |

Più un indice parziale `(status, updated_at) WHERE status IN ('failed','rejected')` per la scansione degli esiti.

### 5.3 RPC del file A — `video_pubblicazione_automatica`

| RPC | Cosa fa |
|---|---|
| `video_job_ready` (REPLACE) | Tetto a **300**. Per le News scrive `output_delete_after = v_now + 7 giorni`. Se l'intento è `pubblicazione_automatica` e `confirmed`, inserisce nella stessa transazione l'evento `gallery.auto_publish` `{intent_id, job_id}` in `video_outbox`; un `unique_violation` vale «già accodato». Tutto il resto identico. |
| `video_galleria_intent_apri(owner, scuola, chiave, byte, mime, durata, tag[], broadcast, classi[], trasporto, sha256, token_hash, token_scade)` (firma esatta decisa da T2a e scritta qui) | Chiama `video_intent_open` (**nessuna copia** della sua logica), poi scrive i destinatari e `n_tag`, **conferma** l'intento con `pubblicazione_automatica = true`, scrive i dichiarati (e `sha256_dichiarato`) e il token sul job. **Ripetizione** con la stessa chiave: destinatari e trasporto identici → stesso intento; per `put-nativo` con job in `awaiting_upload` **ruota** il token. Valori diversi → `IDEMPOTENCY_CONFLICT`. |
| `video_rinnovo_usa(p_hash bytea)` | Cerca il job per hash e risponde con lo stato: `da-caricare` (con percorso, mime, byte), `arrivato` o `annullato`. Revoca il token quando lo stato è terminale. Token sconosciuto o scaduto → `{ok:false, code:'TOKEN_NON_VALIDO'}`. **Token revocato** (decisione dell'orchestratore, 02/10, per tenere insieme §6.2 e §12): `TOKEN_NON_VALIDO` finché il job aspetta ancora il file; dopo l'arrivo o l'annullamento risponde lo **stato** (`arrivato`/`annullato`) fino alla scadenza delle 48 h, così la 1.2 che riceve un 409 sulla seconda PUT sa che il file c'è. Non restituisce **mai** un URL a un token revocato. |
| `video_galleria_pubblica(intent, revisione, owner, scuola, file_url, tag_effettivi uuid[])` | Sotto lock dell'intento verifica che `tag_effettivi ⊆ tag_alunni` (altrimenti `TAG_NON_DELL_INTENTO`) e che `tag_effettivi` non sia vuoto salvo `broadcast`. Inserisce `galleria_media_v2` con `upload_id = intent_id` (`ON CONFLICT (uploaded_by, scuola_id, upload_id) DO NOTHING`, indice esistente), **`caption` NULL**, e chiama `video_intent_finalize`. Se il finalize rifiuta, un `RAISE` in un sottoblocco annulla l'insert e la RPC risponde col codice (la compensazione di `gallery/route.ts` non serve più). Se va bene scrive `output_delete_after = now` sui job e minimizza l'intento (`tag_alunni = '{}'`). Restituisce `created` (vero solo al vincitore), `media_id`, `n_tag`. **Non** scrive `esito_notificato`. |
| `video_intent_esito_segna(intent, esito)` | `UPDATE … SET esito_notificato = p_esito, esito_notificato_il = now() WHERE id = p_intent AND esito_notificato IS NULL RETURNING` → `{segnato}` vero **una sola volta**. È l'**unica** marca delle notifiche (§8.4). |
| `video_intent_pubblicazione_fallita(intent, codice)` | `confirmed` → `action_required`, scrive `pubblicazione_errore`. |
| `video_intent_pubblicazione_riprova(intent, owner)` | Il «Riprova» (§2): solo l'autore, solo intenti `action_required` con `pubblicazione_automatica`, tutti i job `ready`, uscite non ancora cancellate, entro i 7 giorni. Riporta l'intento a `confirmed`, azzera `pubblicazione_errore` ed `esito_notificato`, accoda `gallery.auto_publish`. Altrimenti `RIPROVA_NON_POSSIBILE`. |
| `video_job_sorveglianza_prendi(job, invocazione, secondi)` / `video_job_sorveglianza_rilascia(job, invocazione)` | Lease di sorveglianza per job (§9) |
| `video_job_prendi(job, owner, lease_s, tetto)` / `video_job_prossimo(owner, lease_s, tetto)` | `CAPACITA_PIENA` se i `processing` con lease viva sono ≥ tetto, altrimenti **delegano** a `video_job_claim` / `video_job_next` della PR 1 (nessuna copia della disciplina dei tentativi). |
| `video_job_diagnosi(job, fence, owner, diagnosi jsonb)` | Scrive `diagnosi_verifica` se fence e owner coincidono |
| `video_runner_kick(job)` | Come `video_runner_tick_http` (`20260918120000`): origine da `cron_config`, `net.http_post` con `{job_id}` e `x-cron-secret`. Guardia `to_regprocedure('net.http_post(…)')`: se manca (CI, PGlite) **nessun effetto** e una riga di log; se manca l'URL una riga `error`. |
| `video_runner_ventaglio(tetto, escludi)` | Chiama `video_runner_kick` per i job che hanno bisogno di sorveglianza: `processing` non sorvegliati, più quelli in coda fino ai posti liberi |
| `video_job_retry` (REPLACE **solo se serve**, secondario #23) | A tentativi esauriti delega a `video_job_fail` **scrivendo anche** `last_error_code` col codice dell'ultimo tentativo. |

### 5.4 File B — `video_arrivo_originale`

- Funzione `video_originale_arrivato()` (`SECURITY DEFINER`, tutto dentro `BEGIN … EXCEPTION WHEN OTHERS → log
  'error' → RETURN NEW`), con il corpo condiviso in una funzione interna usata anche dalla scansione:
  1. cerca il job per percorso;
  2. job `cancelled` o già timbrato e **non** `ready`: riarma la cancellazione (`original_deleted_at = NULL`,
     `original_delete_after = now`) e logga `originale-risorto`;
  3. job in `awaiting_upload`: se la dimensione è diversa da `byte_dichiarati` → `rejected ORIGINALE_DIVERSO` (con
     `original_delete_after = now` e `fence + 1`). Altrimenti `video_job_uploaded(job, owner, size, mime_dichiarato
     oppure il mimetype normalizzato)`, scrive `arrivato_il` e `sorgente_etag`, revoca il token e chiama
     `video_runner_kick`;
  4. job in `queued`, `processing` o `ready` con eTag cambiato → `rejected ORIGINALE_SOSTITUITO` e log `error`.
- `CREATE OR REPLACE TRIGGER trg_video_originale_arrivato AFTER INSERT OR UPDATE OF metadata ON storage.objects FOR
  EACH ROW WHEN (NEW.bucket_id = 'video_originals')`, dentro un `DO` con guardia su `to_regclass('storage.objects')` e
  sul privilegio: se manca, logga e **non fallisce** (CI, PGlite).
- **Interruttore d'emergenza:** il trigger non si può togliere né disabilitare (`postgres` non è proprietario di
  `storage.objects`): lo si neutralizza riscrivendo il **corpo** della funzione (`CREATE OR REPLACE`). La spec del
  file lo dice in testa, con l'istruzione pronta.
- `video_arrivi_recupera(p_limite)`: job in `awaiting_upload` il cui oggetto esiste, **dal più recente** (i candidati
  sempre irrisolti non bloccano i nuovi). Applica la stessa logica (corpo interno condiviso) e logga
  `video-arrivo-recuperato-dal-giro` come `warn` (vuol dire che il trigger non l'ha visto).
- Un job già in coda **senza** `sorgente_etag` (accodato dal PATCH prima del trigger) **registra** l'eTag al primo
  evento (`video-originale-riferimento`, info), così una sostituzione successiva si vede. Gli eventi SQL hanno il
  prefisso `video-`. Per la PR 3: con `ORIGINALE_SOSTITUITO` il rinnovo risponde `arrivato` (il file c'è), e l'esito
  all'insegnante arriva dalla scansione degli esiti.
- `video_job_uploaded` chiamata due volte (trigger + `PATCH caricato` del web) deve restare **idempotente**:
  verificarlo, e provarlo in PGlite.

### 5.5 File C — `video_conservazione_uscite`

| Funzione | Cosa fa |
|---|---|
| `video_retention_scadenze` (REPLACE) | Aggiunge la rete delle uscite: ogni job concluso (`failed`, `rejected`, `cancelled`) o di intento `published`, con `output_path` e senza `output_delete_after`, riceve `= v_now`. Un `UPDATE` che non tocca `status`. Copre le 39 + 11 attuali. |
| `video_retention_uscita_rimossa(job)` | Timbro dopo la rimozione del file, rileggendo sotto lock (stessa forma di `video_retention_originale_rimosso`) |
| `video_intent_scadi_non_pubblicato(p_giorni, p_limite)` | Intenti galleria `confirmed` o `action_required` con tutti i job `ready` e `verified_at ≤ now − p_giorni`: chiama **`video_intent_revoke`** (che già spegne i `ready` e fissa la scadenza degli originali), poi `output_delete_after = now`. Si chiama con **7** (`GIORNI_CONVERTITO_NON_PUBBLICATO`). |
| `video_galleria_flusso_vecchio_revoca(p_limite)` | Intenti galleria **non terminali** con `pubblicazione_automatica = false` (il flusso vecchio, che dopo questa PR nessuno può più pubblicare): `video_intent_revoke` e `output_delete_after = now`. Restituisce il conteggio. Toglie al primo giro gli 11 vecchi e ogni invio vecchio rimasto in volo. |
| `video_intenti_minimizza(p_giorni, p_limite)` | Intenti conclusi da oltre 7 giorni: `tag_alunni = '{}'`, `minimizzato_il` (resta `n_tag`) |
| `video_intent_oblio_alunno(p_alunno)` | `array_remove` su tutti gli intenti. Se un intento non pubblicato resta senza tag e non è broadcast → `video_intent_revoke`. |
| `video_riconciliazione` (REPLACE) | Conteggi nuovi: `uscite_da_togliere`, `uscite_senza_scadenza`, `pubblicazioni_in_attesa`, `esiti_da_notificare`, `arrivi_mancati`, `flusso_vecchio_in_volo` |

### 5.6 RLS, lock e fotografie

- Nessuna policy nuova: le tabelle restano `FORCE RLS` senza policy. Dopo l'applicazione `get_advisors` a 0 ERROR.
- Lock:
  - `__tests__/architecture/migrazioni-complete.test.ts`: i **tre** nomi in `IN_CODA` (T2a li mette tutti e tre);
  - `video-originale-mai-senza-scadenza`: eccezioni dichiarate, solo se servono;
  - **nuovo** `video-uscita-mai-senza-scadenza.test.ts`: ogni chiusura o pubblicazione tocca `output_delete_after`;
  - **nuovo** `trigger-storage-fail-open.test.ts`: clausola `WHEN` sul bucket, `EXCEPTION WHEN OTHERS … RETURN NEW`,
    `search_path`, nessuna `DELETE`.
- Dopo l'applicazione in produzione (T16): fotografie `migrazioni-applicate-snapshot.json` e
  `indici-unici-snapshot.json` rigenerate, `IN_CODA` svuotata.

---

## 6. API

Tutte avvolte in `withRoute`, validate con zod (`parseBody`, `parseData`, `parseQuery`), senza PII nei log. La
regione `dub1` vale già per `src/app/api/video-uploads/**` (`vercel.json`).

| Route | Gate e sede | Ingresso → uscita | Tetto |
|---|---|---|---|
| `POST /api/video-uploads` (esteso) | `requireDocente` → `resolveScuolaScrittura` **nel corpo dell'handler** → `cancelliDestinatariGalleria` (modulo nuovo condiviso con `/api/gallery`, T4) | Campi nuovi: `destinatari:{tagAlunni, broadcast, classi}`, `trasporto: 'tus' \| 'put-nativo'` (predefinito `tus`), `sha256` **per file** (`file[i].sha256`, hex 64: ammesso solo con `put-nativo` e **obbligatorio** con `put-nativo`). **Canale galleria senza `destinatari` → 409 `VIDEO_APP_DA_AGGIORNARE`** (client vecchio) + log `apertura-flusso-vecchio-rifiutata`. Con `destinatari`: solo galleria, un file, `azione: 'publish'`, almeno un tag **oppure** broadcast (`DESTINATARI_MANCANTI` 400). Errori **identici** a `/api/gallery`, prodotti dallo stesso modulo `cancelliDestinatariGalleria` (T4): 403 `TAG_FUORI_SEDE` (l'unico con un `codice`), 403 broadcast non consentito, 400 broadcast con tag, **422 liberatoria mancante con `nomi` e `ids`, stesso testo di oggi**. Questi ultimi tre oggi **non** hanno un campo `codice` e restano così (i nomi `BROADCAST_NON_CONSENTITO`, `BROADCAST_CON_TAG`, `LIBERATORIA_MANCANTE` sono solo etichette di questa spec; il debito «errori senza codice» è dichiarato in testa a `cancelli-destinatari.ts`). Uscita: `tus` come oggi, oppure `{protocollo:'put', url, metodo:'PUT', intestazioni:{'content-type'}}` (URL firmato **senza upsert**) + `rinnovo:{token, scadeIl}`. Le News restano come oggi (nessun destinatario). | 30/10' per utente (invariato) |
| `GET /api/video-uploads` (nuovo) | `requireDocente`, `scuoleDiUtente` + `.in('scuola_id', sedi)` (o la sede richiesta, solo se è fra le proprie), `owner_id = utente` | `?canale=gallery&scuolaId=…` → `{voci:[VoceVideo]}` (§6.1): intenti non terminali più quelli terminali degli ultimi 7 giorni, al massimo **50**, per `updated_at` decrescente. | 120/10' per utente |
| `POST /api/video-uploads/[id]/firma` (nuovo; `[id]` = intento) | `requireDocente` → `leggiIntento` + `sedeAncoraPropria` (`cancello.ts`) | `{jobId}` → nuova firma TUS per il percorso del job, **solo** se il job è in `awaiting_upload`. Sostituisce la «riapertura per firmare» (190 aperture per 44 job). | 60/10' per utente |
| `PATCH /api/video-uploads/[id]` | come oggi | Restano `caricato` (che ora chiama anche `video_runner_kick`), `conferma`, `annulla`, `annulla-job`. Nuova azione **`riprova-pubblicazione`** → `video_intent_pubblicazione_riprova` (409 `RIPROVA_NON_POSSIBILE`). **Nessuna** azione `destinatari`. | — |
| `POST /api/video-uploads/rinnovo` (nuovo, segmento statico) | **Nessuna sessione.** Gate = token nell'intestazione `x-kidville-rinnovo`, letto **prima** del corpo (lock `corpo-letto-dopo-il-gate`). Voci motivate in `gate-coverage` e in `isolamento-sede`; rispetta `upload-pubblico-con-tetto`. | → `{stato:'da-caricare', caricamento:{…}, scadeIl}` \| `{stato:'arrivato'}` \| `{stato:'annullato'}`. **404 uniforme** (`VIDEO_NON_TROVATO`) per token assente, sconosciuto, scaduto o revocato. | 30/10' per IP + 20/10' per hash del token |
| `POST /api/video/runner` | segreto del cron o `requireStaff` | Corpo letto **dopo** il gate con `request.text()` + `parseData` (il corpo vuoto è ammesso: `parseBody` risponderebbe 400): `{job_id?: uuid}` | — |
| `POST /api/gallery` | — | Con `video_intent_id` → **409 `VIDEO_APP_DA_AGGIORNARE`** + log `pubblicazione-video-legacy-rifiutata`; il ramo video si toglie. Per le **foto**: `caption` sempre `NULL` alla creazione (§2) e notifica ai genitori col testo nuovo (§8.4). La modifica esplicita della didascalia (`PATCH`) resta com'è. | — |

### 6.1 `VoceVideo` (contratto, T1)

`{intentId, jobId, fase, codice, creatoIl, aggiornatoIl, trasporto, byte, durataS, nBambini, broadcast, mediaId,
pubblicazioneAutomatica, riprovaPossibile}` con `fase ∈ 'da-caricare' | 'in-coda' | 'in-conversione' | 'in-riprova' |
'pronto' | 'pubblicato' | 'non-pubblicato' | 'fallito' | 'annullato' | 'da-ricaricare'` (`da-ricaricare` = **ogni**
intento galleria del flusso vecchio non pubblicato: dopo il rilascio nessuno lo pubblica più. «Questo video va
ricaricato»). `riprovaPossibile` è falso quando l'errore è `NESSUN_DESTINATARIO` (riprovare darebbe lo stesso rifiuto). `codice` è un codice **mostrabile** del contratto. Per un
job `failed` con `attempt > 1` (dunque ritentato, dunque un guasto **nostro**) il codice mostrato è sempre quello del
guasto nostro esaurito, qualunque fosse l'ultimo codice tecnico (secondario #37).

### 6.2 Il token di rinnovo

- **Forma:** `kvr_` + 32 byte casuali in base64url. Si conserva solo lo SHA-256 (indice unico). Vale **48 h**
  (`ORE_UPLOAD_ABBANDONATO`). Modulo `src/lib/media/video/token-rinnovo.ts` (genera, calcola l'hash, confronta).
- **Revoca:** all'arrivo del file, all'annullamento, quando il job lascia `awaiting_upload` e a ogni rotazione. Il
  rinnovo **non** allunga la vita del token. Viaggia solo nell'intestazione, mai nell'URL; **mai nei log** (redazione
  e lock dedicato).
- **Indovinarlo:** 256 bit, 404 uniforme, tetto per IP. **Rubarlo:** si ottiene al massimo un URL di caricamento per
  **quel** percorso finché l'originale non è arrivato; niente upsert (una seconda PUT prende 409, e la 1.2 tratta il
  409 come «chiedi il rinnovo», che risponde `arrivato`); il trigger rifiuta dimensioni diverse; una sovrascrittura
  successiva diventa `ORIGINALE_SOSTITUITO`; lo `sha256` dichiarato e verificato nel Sandbox rende impossibile
  sostituire il contenuto.

---

## 7. Notifiche e testi

| Destinatari | Tipo | Quando | Testo (italiano, nessun nome, nessun nome di file) |
|---|---|---|---|
| Genitori dei bambini taggati (o della classe/sede per broadcast, come oggi) | `galleria` (esistente) | Pubblicazione riuscita (foto **e** video) | Titolo **«Nuovi contenuti in galleria»**, corpo «Ci sono nuovi contenuti nella galleria.» Helper estratto da `gallery/route.ts`, stesso `entitaId = uploaded_by`, `bufferMin 30`, debounce per destinatario della #131. |
| Chi ha caricato | `video_esito` (nuovo, gruppo `docente`, `bufferMin 0`, `entitaId = intento`) | pubblicato · pubblicato senza N bambini · non pubblicato (nessun destinatario) · pubblicazione fallita (con «Riprova») · conversione fallita | «Il tuo video è stato pubblicato in galleria.» · «… N bambini non sono più nella sede e non lo vedranno.» · «Il video non è stato pubblicato: nessuno dei bambini scelti è ancora nella sede.» · «Non siamo riusciti a pubblicare il video: apri la galleria e premi «Riprova».» · testo della PR 1 per il guasto nostro / per il file. Link `/teacher/gallery` (o `/admin/gallery` per Direzione e segreteria, se è da lì che caricano). |
| Chi ha caricato + `admin`, `coordinator`, `segreteria` della sede | `video_liberatoria_revocata` (nuovo, `staff`, `sicurezza: true`) | Pubblicato con N bambini che hanno perso la liberatoria | «Un video è stato pubblicato in galleria con N bambini senza liberatoria fotografica.» |

- I due tipi nuovi entrano in `TIPI_NOTIFICA` (`src/lib/notifiche/tipi.ts`), in **entrambi** gli `etichette.json`
  (it/en: la chiave i18n vince sul catalogo) e in `TIPI_PUSH_STAFF` (`src/lib/push/dispatch.ts`, «mai un nome»).
- L'etichetta del tipo `galleria` diventa «Nuovi contenuti in galleria» (tipi.ts ed etichette it/en).

---

## 8. Pubblicazione lato server

### 8.1 Dove gira

Libreria `pubblicaVideoGalleria(supabase, intentId)` in `src/lib/gallery/pubblicazione-video-automatica.ts`, chiamata
**solo** dal destinatario dell'outbox `gallery.auto_publish`. Il registro dei destinatari esce da `retention-video` in
`src/lib/media/video/outbox/` (T3) ed è **unico**; i consumatori si dividono i tipi **nel claim** (overload
`video_outbox_claim(uuid, integer, integer, text[])` con `event_type = ANY(p_tipi)`, file C — filtrare dopo il claim
terrebbe in lease gli eventi altrui fino alla quarantena):

- il **runner** consuma **solo** `gallery.auto_publish` (subito dopo il `ready` e a ogni giro, al massimo 5 eventi);
- la **retention** (ogni 10') consuma **tutti gli altri** tipi, con i numeri di oggi (25 eventi, lease 120 s, pensati per
  ricevute da millisecondi). **Decisione dell'orchestratore (02/10, dopo l'ondata B):** la retention **non** pubblica
  video, così una raffica di pubblicazioni non sfora la sua lease. Se il runner è fermo non si converte niente, quindi
  una terza rete per le sole pubblicazioni non aggiungerebbe nulla: il giro del runner ogni 5' è la rete.

Il claim con lease impedisce il doppio lavoro; l'idempotenza della RPC impedisce i doppioni. I file si toccano solo dalla
Storage API.

### 8.2 Riverifiche al momento della pubblicazione (TypeScript, prima della copia)

1. **Autore**: se è disattivato o non ha più la sede **si pubblica comunque** (log `info` `autore-non-attivo`).
2. **Bambini nel perimetro** (`assertTagStudentsInScope` con la sede dell'intento, o l'equivalente che restituisce
   l'elenco): chi è uscito (trasferito, cancellato, oblio) si **toglie** → `tag_effettivi`. Se non resta nessuno e
   l'intento non è broadcast → **non si pubblica**: `video_intent_pubblicazione_fallita(intent, 'NESSUN_DESTINATARIO')`
   e notifica «non pubblicato».
3. **Liberatoria** (`alunniSenzaConsenso`, `src/lib/gallery/privacy.ts`): chi l'ha persa **resta** fra i destinatari
   (decisione del titolare), si pubblica e parte l'avviso `video_liberatoria_revocata` col solo numero.

### 8.3 Copia e RPC

Percorso deterministico `uploads/<owner>/v-<intentId>.mp4` nel bucket della galleria (oggi casuale, in
`src/lib/gallery/video-pubblicazione.ts`). Un 409 «esiste già» con dimensione uguale vale come riuscita. Poi
`video_galleria_pubblica(…, tag_effettivi)`. Se la RPC fallisce in modo definitivo, la copia orfana la toglie la
spazzata di `retention-galleria` (24 h).

### 8.4 Notifiche: una sola marca

Dopo la RPC (con `created` vero **o falso**) si chiama `video_intent_esito_segna(intent, 'pubblicato')`; **solo se
`segnato` è vero** partono: genitori, esito all'insegnante, eventuale avviso liberatoria. Così un processo che muore
fra la RPC e le notifiche le recupera al giro dopo (la RPC risponde `created:false`, la marca no), e nessuna notifica
parte due volte.

### 8.5 Fallimenti

- **Pubblicazione:** backoff dell'outbox. Se l'evento ha più di **60 minuti**: `video_intent_pubblicazione_fallita`
  (`PUBBLICAZIONE_NON_RIUSCITA`), marca `fallito`, notifica con «Riprova», evento chiuso.
- **Conversione** (`failed`/`rejected`, §3): scansione degli intenti `pubblicazione_automatica` con un job definitivo
  e `esito_notificato IS NULL` → marca `fallito` → notifica. Gira subito dopo `fallisci` nel runner e a ogni giro di
  runner e retention.

---

## 9. Avvio immediato e concorrenza

- **Avvio:** il trigger d'arrivo e il `PATCH caricato` chiamano `video_runner_kick(job)`. Il cron ogni 5' resta la
  rete e **non si tocca**. Il giro **senza** `job_id` fa, in ordine: `video_arrivi_recupera`, poi
  `video_runner_ventaglio(tetto, sé stesso)`, poi al massimo 5 eventi `gallery.auto_publish`, poi la scansione degli
  esiti, e infine sorveglia un job. Il tetto di sorveglianza diventa `240 s − tempo già speso`.
- **Sorveglianza esclusiva:** lease di **270 s** (`TETTO_INVOCAZIONE_MS` 240 s più margine). Chi non la ottiene
  risponde `gia-sorvegliato` (esito tranquillo). Toglie il falso `OUTPUT_CONFLICT` di due invocazioni che riagganciano
  lo stesso Sandbox (`riprendiUnJobMio`). Il `lease_owner` stabile (`VIDEO_RUNNER_OWNER_ID`) resta.
- **Testimone** (T6, accettato): un'invocazione che esce `in-corso` rilascia la sorveglianza e rifà il ventaglio, così
  il job passa subito a un'altra invocazione invece di aspettare il tick (con i calci la fase non coincide più con il
  cron, e circa un passaggio su cinque troverebbe la lease di conversione scaduta). Nessuna amplificazione: il ventaglio
  calcia solo job non sorvegliati e solo fino ai posti liberi.
- **Tetto parallelo:** `VIDEO_CONVERSIONI_PARALLELE`, predefinito **3** (picco misurato: 8 video in 15', p90 2). Si
  passa a `video_job_prossimo` / `video_job_prendi`; il limite reale dei Sandbox concorrenti si misura in T16.
- **Secondario #33:** un'eccezione dell'SDK del Sandbox dentro `esegui`/`avvia` si classifica `infra-transitoria` e
  passa da `riprova` (con attesa e tetto dei tentativi), invece di lasciare il job `processing` fino alla scadenza
  della lease.
- **Secondario #23:** il runner passa da `riprova` anche all'ultimo tentativo (la RPC delega a `video_job_fail`
  scrivendo `last_error_code`), oppure si corregge il commento della colonna: T6 sceglie e lo scrive.
- **Battito di salute:** `ESITI_BATTITO` (`src/lib/health/controlli.ts`) riconosce come vivo il battito di
  `video-runner-tick` con `coda-vuota`, `in-corso`, `pronto`, `in-riprova`, `gia-sorvegliato`, `capacita-piena`.
  Chiude il falso allarme noto di `/api/health`.

---

## 10. Ambiente pronto (snapshot), ripiego e verifiche nel Sandbox

### 10.1 Snapshot (percorso principale)

- Nuovo `runner/ambiente.ts`, variabile **`VIDEO_SANDBOX_SNAPSHOT_ID`**. In `macchinaVercel().apri`:
  1. `Sandbox.get` (riaggancio, come oggi);
  2. `Sandbox.create({source:{type:'snapshot', snapshotId}, name, region:'dub1', resources, timeout,
     persistent:false})`;
  3. se lo snapshot manca, è scaduto o non è in `dub1` → **ripiego** (§10.2) + log `config` `error`
     `ambiente-pronto-assente`.
- Lo snapshot (Ubuntu 26.04 da `vercel/sandbox/node:24`) contiene `curl` + `ca-certificates` (installati una volta con
  `apt-get` alla costruzione) e i binari in **`/opt/kv-ffmpeg`**. A ogni avvio lo script verifica con `sha256sum` i
  **binari** (costanti in `src/lib/media/video/build.ts` e nel lock `fixture-video-reali`, le stesse della PR 1); se
  l'impronta non torna si ripiega **nella stessa MicroVM** con la provvista dal bucket (curl c'è) e si grida.
  L'inventario (`mancanzeDellaBuild`) resta.
- `scripts/video-sandbox-ambiente.mjs` (eseguito dall'orchestratore, credenziali della CLI Vercel): crea il Sandbox in
  `dub1` da `node:24`, installa `curl`, fa la provvista dal bucket con lo **stesso** script del runtime, verifica
  impronte e inventario, chiama `snapshot({expiration: 0})`, stampa id e impronte (mai URL né chiavi). Documentato in
  `docs/env.md` con `VIDEO_CONVERSIONI_PARALLELE`.

### 10.2 Ripiego

Il percorso della PR 1 **invariato** (`runtime: 'node22'`, Amazon Linux con `curl`, provvista dal bucket con doppia
impronta), già provato in produzione. Rischio dichiarato: il ripiego dipende dal runtime deprecato; se Vercel lo
togliesse **e** lo snapshot mancasse, ogni apertura fallirebbe con un log `error` e il battito lo mostrerebbe.

### 10.3 Misure obbligatorie (T16, Sandbox vero, fixture sintetiche)

4K HLG 10 bit 60 fps di 60 s (da estrapolare a 300 s) · 1080p di 300 s · avvio da snapshot contro ripiego · 3 Sandbox
insieme · **costo mensile stimato** (≤ 50 $, altrimenti meno parallelismo o meno vCPU, oppure avviso al titolare).
Decidono `TETTO_SANDBOX_MS` (2,5 volte il peggio misurato), le vCPU (8 per ingressi > 1080p o HDR solo se la misura
lo giustifica) e se spostare `scale` prima della catena HDR→SDR.

### 10.4 `sha256` dichiarato (per la PR 3)

Se il job ha `sha256_dichiarato`, lo script nel Sandbox calcola lo SHA-256 dell'originale scaricato **prima** di
convertire; se diverso esce con un codice d'uscita nuovo mappato su `ORIGINALE_DIVERSO`, classe `file` (mai
ritentato). Senza `sha256_dichiarato` (web, TUS) il passo si salta.

### 10.5 Verifiche senza falsi scarti (T9, moduli puri)

| Controllo | Oggi | Dopo | Cosa resta protetto |
|---|---|---|---|
| Copertura terminale (`temporale.ts`) | confronta anche la durata dell'**ultimo campione**, che il muxer non conserva (unico falso scarto misurato) | si toglie in `preserve` (l'uguaglianza dei PTS fotogramma per fotogramma prova già la timeline) **e anche in `reduce60`** (T9: stessa causa, riprodotta a 120 fps con ffmpeg vero); in `reduce60` restano l'arco (±1/60 s) e la griglia a 60 Hz. Il motivo nei log diventa `DURATION_LIMIT` | frame persi, accelerazioni, troncamenti |
| Durata (`verify.ts`) | tolleranza di un frame + padding AAC | `max(1 frame, ultimo campione della sorgente)` + AAC, **solo** se conteggio e PTS coincidono | troncamento: un frame mancante fa già fallire il conteggio |
| Tetti interni | 180 s e 180 000 frame cablati | da `MAX_VIDEO_DURATION_SECONDS` (300), passato nelle opzioni | file ostili |
| Sonda temporale | timeout 120 s, buffer 32 MiB | timeout proporzionale a durata e risoluzione (tarato in T16), buffer 64 MiB | sonda fail-closed |
| Audio (`probe.ts`) | lo stream `default` con codec sconosciuto → `UNKNOWN_AUDIO_CODEC` | **prima traccia audio decodificabile**; le altre ignorate e contate | uscita con una sola traccia AAC |
| Diagnosi | solo il codice | `video_job_diagnosi` con i numeri (frame, coperture, ultimo campione, tolleranze, fps) | — |

Fixture di regressione: le due timeline del falso scarto del 28/09 (§3) in `__tests__/fixtures/video/` — il test
deve essere **rosso** col controllo di oggi e verde dopo; le controprove (frame persi, accelerazione, audio spostato)
restano rosse.

---

## 11. Client web (galleria dell'insegnante)

- **Flusso** (`src/app/(dashboard)/teacher/gallery/page.tsx`): il passo dei bambini resta; «Invia» manda **subito**
  la POST di ogni video (il server deve sapere dei bambini); un 422 resta **nel passo dei bambini** con i nomi e
  **zero** richieste TUS; offline: messaggio in linea e file conservato; **nessun `alert()`** nel ramo di invio
  (compreso `galleryCodaEsito`): banner in linea con `aria-live` su un elemento **sempre montato** (secondario #36).
  Al massimo **50** elementi per scelta.
- **Libreria** (`src/lib/media/video/upload/*`, T10): `accodaCaricamentoVideo` scrive solo la riga e la sorgente
  viva; il deposito locale parte **in background** e non è atteso; prima si controlla la quota
  (`navigator.storage.estimate`); `scriviByte` riceve un `AbortSignal` e a caricamento finito si annulla il deposito
  ancora in corso; un `AbortController` per job, così «Rimuovi» ferma davvero il trasferimento. **TUS uno alla volta:**
  la libreria garantisce la serie solo nella ripresa; nel client della galleria (T11) i trasferimenti di una scelta
  partono **in serie** (ora che l'accodamento non aspetta più la copia, partirebbero tutti insieme).
- **Ripresa automatica:** `usePollingVisibile` (coalizza `visibilitychange` e `appStateChange`) più `online`, più un
  backoff (5, 15, 30, 60 s) finché ci sono righe interrotte e la pagina è visibile; la firma si rinnova con `/firma`,
  mai riaprendo l'intento.
- **Elenco dal server:** polling ogni 10 s solo con voci attive e pagina visibile, fuso con le righe locali per
  avanzamento e ripresa. Chi carica da un altro dispositivo vede «In caricamento da un altro dispositivo». «Riprova»
  sulle pubblicazioni fallite (`riprovaPossibile`). Le righe locali del flusso vecchio → «Questo video va ricaricato».
- **Testi veritieri:** TUS: «Il caricamento continua finché l'app è aperta; se la chiudi riprende da solo quando la
  riapri». Il testo `galleryVideoAvviato` («Puoi chiudere l'app») è falso con TUS e si corregge; così
  `erroreVideoAppDaAggiornare` se dice «ripartono da soli».
- **Trasporto:** interfaccia `TrasportoVideo` in `src/lib/media/video/trasporto/` con il solo `trasportoTus`;
  `scegliTrasporto()` risponde `put-nativo` solo se un trasporto registrato (PR 3) dice di essere disponibile. In questa
  PR **non** c'è alcun ramo nativo mezzo fatto.

### 11.1 Il selettore: cosa apre il riquadro grande, e i suoi log (richiesta del titolare, 02/10)

**Perché.** Il titolare ha provato dall'iPhone, nell'app: «Scegli file dal dispositivo» → Libreria foto → un video
di 73 MB (circa 50 s). Il video non è mai arrivato alla pagina: nessuna miniatura, nessun errore. Quel passaggio oggi
non lascia log (`MediaUploader` registra solo le selezioni rifiutate, `gallery-file-selezione-rifiutata`). Le ipotesi da
distinguere sono tre: **«Aggiungi» non premuto** nel selettore multiplo · **conversione di WebKit** lenta o senza segni a
schermo · **download da iCloud**.

**Il riquadro grande nell'app.** Nell'app (`fotocameraNativaDisponibile()`) il riquadro grande di `MediaUploader` apre
il **selettore con foto e video** (l'`<input type="file" accept="image/*,video/*" multiple>`), non più la fotocamera
nativa (che mostra solo foto, una alla volta). **«Scatta una foto»** (la fotocamera nativa di oggi, `useImagePicker`)
diventa l'opzione **secondaria**, al posto del link «Scegli file dal dispositivo». Il testo del riquadro nell'app parla
di scegliere foto e video (non di trascinare). Sul web non cambia niente: il riquadro apre già l'input.

**I log, con `logClient`** (livello `warn`: il client spedisce solo `warn` ed `error`). **Mai il nome del file** (può
contenere il nome di un bambino): solo numeri e codici. L'impronta di `app_log` conserva i `campi` della **prima**
occorrenza del giorno, quindi ciò che deve distinguere un'occorrenza dall'altra sta nel **messaggio** (codici e fasce di
tempo), e i numeri esatti nei `campi`. Fasce di tempo: `<1s`, `1-5s`, `5-30s`, `30s-2m`, `>2m`.

1. **Selettore aperto** — `gallery-selettore-aperto strada=<selettore-file|fotocamera-nativa> ambiente=<app|web>`.
2. **File ricevuti** — `gallery-selettore-file-ricevuti mime=<image|video|misto> attesa=<fascia> tardivo=<si|no>`, con
   `campi` `{n, n_video, n_foto, byte_totali, ms_da_apertura, ms_da_ritorno}` (`ms_da_ritorno` = dal ritorno della pagina
   in primo piano, `null` se non c'è stato; `tardivo=si` se il log del punto 3 era già partito).
3. **Selettore chiuso senza file** — `gallery-selettore-chiuso-senza-file motivo=<cancel|ritorno-senza-file|annullato-fotocamera> attesa=<fascia>`,
   con `campi` `{ms_da_apertura}`. L'evento `cancel` dell'input dove il telefono lo supporta; altrimenti, quando la
   pagina torna visibile, un timer di **15 s** (costante documentata): se nel frattempo non è arrivato niente, si
   registra `ritorno-senza-file`. Se i file arrivano **dopo**, il punto 2 parte con `tardivo=si` (è la firma della
   conversione di WebKit o del download: il tempo si legge in `ms_da_ritorno` e `ms_da_apertura`).

Come si leggono le tre ipotesi: «Aggiungi» non premuto → punto 3 e nient'altro; conversione di WebKit → punto 3, poi
punto 2 `tardivo=si` con `ms_da_ritorno` grande; download da iCloud → punto 2 con `ms_da_apertura` grande e
`ms_da_ritorno` piccolo (l'attesa avviene dentro il selettore).

**Test:** uno per ciascuno dei tre casi, ognuno provato rompendo il codice (rosso osservato). Più un test che nessun
campo e nessun messaggio contenga il nome del file.

---

## 12. Contratto con la PR 3

1. Apertura: POST come §6 con `trasporto:'put-nativo'`, `chiaveIdempotenza` UUID v4 generata all'«Invia», `sha256`.
   In risposta URL PUT senza upsert e token.
2. PUT nativa in background: 2xx → fatto (il server lo vede da solo); 409 → rinnovo, che risponde `arrivato`; 400/403
   di firma o URL scaduto → rinnovo e ripetizione; 413 → fallito; rete → backoff.
3. Rinnovo: `POST /api/video-uploads/rinnovo` con `x-kidville-rinnovo`; `annullato` → fermarsi e cancellare la copia.
4. Pubblicazione e notifiche: tutte lato server. Stato: `GET /api/video-uploads` in primo piano.
5. Persistenza: token e URL in Keychain/Keystore, esclusi dai backup; si salva la risposta **più recente** (la
   ripetizione ruota il token); le aperture si serializzano. Rischio: una PUT da 2 GB non riprende a metà.

---

## 13. Canale News

**Cambia** (solo attraverso il codice condiviso): limite a 5' (testo `videoNota` in `adminComunicazioni.json`, it/en);
partenza senza copia preventiva (`NewsVideoAllegati` si adegua alla nuova API di accodamento); trigger d'arrivo e
avvio immediato; concorrenza, ambiente e verifiche del runner; conservazione delle uscite (verifica + 7 giorni, più la
spazzata degli orfani); `news/upload` rifiuta sempre i video; al rientro un job `failed` mostra il **codice vero**
(`VIDEO_GUASTO_NOSTRO` quando ritentato), non `VIDEO_RIPROVA` (secondario #39).
**Non cambia:** intenti `attach_private` con `conferma` esplicita dell'editor; nessun destinatario; nessuna
pubblicazione automatica; nessuna notifica d'esito; la ripresa resta quella al montaggio.

---

## 14. Chiusura del legacy (inventario, T12)

| File | Intervento |
|---|---|
| `src/app/api/gallery/upload/route.ts` | ogni `video/*` → `rifiutoLegacyVideo` (409), senza condizioni; via lo sniff |
| `src/app/api/gallery/upload-url/route.ts` | ogni `video/*` → 409; via lo sniff e `testa_b64`. I tipi video restano nello `z.enum`, così i client vecchi ricevono il 409 e non un 400 |
| `src/app/api/news/upload/route.ts` | ogni `video/*` → 409; via lo sniff |
| `src/lib/media/blocco-legacy-video.ts` | resta: `eVideoLegacy(mime)` + `rifiutoLegacyVideo` |
| `src/lib/media/interruttore-legacy-video.ts`, `codec-sniff.ts`, `video-mediarecorder.ts`, `integrita-video.ts` | **da eliminare** (prima `grep -rn` di ogni importatore) |
| `src/lib/media/processing.ts` | restano solo le esportazioni delle immagini |
| `src/lib/gallery/carica-media.ts` | via lo sniff e il motivo `formato`; resta `app-da-aggiornare` |
| `src/lib/ui/esito-fetch.ts` | via `VIDEO_NON_CONVERTIBILE` |
| `messages/{it,en}/shared.json`, `teacherServizi.json` | via `erroreVideoNonConvertibile` e `galleryAlertVideoNonConvertibile` se restano orfane (lock `messaggi-chiavi-orfane`) |

Test: da cancellare `video-conversione-orchestrazione`, `integrita-video`, `codec-sniff`, `processing-strict` (tutti
casi video); da riscrivere `video-legacy-blocco` (sempre bloccato, le immagini passano),
`interruttore-legacy-video` → `blocco-legacy-video` (ogni route di upload passa dal modulo), `gallery-upload-hevc`
(→ 409), `gallery-upload-url`, `gallery-carica-media*`, `gallery-video-pubblicazione` (→ 409). Inventari: togliere la
voce di `video-mediarecorder.ts` da `logging-tetto`, commento ed eventuale tetto in `catch-muti-allowlist`,
`errori-senza-codice-allowlist.json` **solo in discesa**. Mai abbassare la soglia di un lock senza scrivere accanto
perché scende.

---

## 15. Purga e GDPR (T13)

Passi aggiunti a `src/app/api/gdpr/retention-video/route.ts`; la regola «prima il file, poi la riga» resta, per riga;
righe trattenute ⇒ 500 — **in fondo al giro** (T13, accettato): un file che lo Storage non rilascia non deve fermare,
giro dopo giro, la minimizzazione degli identificativi dei minori e la coda. Le uscite datate nel giro escono al giro
dopo (~10').

1. `video_galleria_flusso_vecchio_revoca` (§5.5) — conteggio nel battito.
2. `video_intent_scadi_non_pubblicato(7)`.
3. Uscite scadute: `rimuoviEVerifica('video_processing')`, poi `video_retention_uscita_rimossa`.
4. Spazzata degli orfani **anche** su `video_processing`, con 24 h di grazia, più gli originali «risorti» (riga
   timbrata ma file presente: si toglie il file).
5. `video_intenti_minimizza(7)`.
6. Consumo dell'outbox per **tutti i tipi tranne** `gallery.auto_publish` (che consuma solo il runner, §8.1) con
   l'overload filtrato, e scansione degli esiti di conversione (marca + notifica, §8.5).
7. Contatori nuovi nel battito; si toglie il «BUCO DICHIARATO».

**Registro GDPR** (`src/lib/gdpr/esegui.ts`): `video_processing` passa da `escluso` (lacuna aperta) a coperto, con le
regole e la finestra residua scritte. **Oblio:** `anonimizzaAlunno` chiama `video_intent_oblio_alunno`; `tag_alunni`
è un luogo nuovo con identificativi di minori e ha la sua **prova di mutazione**.

---

## 16. Logging

Server (canali `galleria`, `news`, `cron`, `config`, `notifica`, `storage`, `rpc`; solo uuid, conteggi e codici):

- route: `intento-aperto` (`n_tag`, `broadcast`, `trasporto`), `apertura-flusso-vecchio-rifiutata`,
  `liberatoria-mancante`, `elenco-letto`, `firma-rinnovata` / `firma-negata`, `rinnovo-emesso` / `-arrivato` /
  `-annullato` / `-negato` (motivo come enumerato, **mai il token**), `pubblicazione-riprovata`;
- runner: `gia-sorvegliato`, `capacita-piena`, `ambiente-pronto` / `ambiente-pronto-assente`;
- pubblicazione: `pubblicazione-automatica-riuscita` / `-fallita`, `pubblicato-senza-liberatoria`,
  `pubblicato-senza-bambini-usciti`, `non-pubblicato-nessun-destinatario`, `esito-docente-accodato`,
  `pubblicazione-video-legacy-rifiutata`;
- conservazione: `uscite-rimosse` / `uscite-trattenute`, `originali-risorti-rimossi`, `non-pubblicati-scaduti`,
  `flusso-vecchio-revocato`, `intenti-minimizzati`;
- SQL: `video-originale-arrivato` / `-risorto` / `-diverso` / `-sostituito`, `video-arrivo-trigger-eccezione`,
  `video-runner-kick`.

Client (solo `warn` ed `error`): `video-ripresa-automatica` (job, motivo), `video-deposito-saltato-spazio`,
`video-upload-annullato-in-volo`, e i tre del selettore di §11.1 (`gallery-selettore-aperto`,
`gallery-selettore-file-ricevuti`, `gallery-selettore-chiuso-senza-file`). Successo loggato per gli eventi critici
(pubblicazione, notifiche, cron).

---

## 17. Test e lock trasversali

- **PGlite** (migrazioni lette dal disco come in `__tests__/lib/video-intents.test.ts`): apertura con destinatari e
  idempotenza; token (ruota, usa, revoca); pubblica (vincitore unico, annullamento sul rifiuto del finalize,
  minimizzazione, `tag_effettivi ⊄ tag_alunni` rifiutato); esito segnato una volta; riprova; trigger con uno schema
  `storage` finto (arrivo, risorto, dimensione diversa, sostituzione, eccezione = insert riuscito); tetto parallelo,
  sorveglianza, scadenza dei non pubblicati, flusso vecchio revocato, oblio, rete delle uscite, riconciliazione.
- **API:** POST con 422 identico a `/api/gallery`, 403 di sede, `DESTINATARI_MANCANTI`, 409 senza destinatari,
  `put-nativo`; GET con isolamento per proprietario e sede; firma; rinnovo (404 uniforme, `arrivato`, `annullato`,
  token mai nei log); runner con corpo vuoto e con `job_id`; riprova.
- **Librerie:** pubblicatore (riverifiche, bambino uscito → senza di lui, nessuno → non pubblicato, liberatoria persa →
  pubblica e avvisa, copia con 409 = ok, notifiche solo se segnato), esiti, outbox col tipo nuovo, verifiche (fixture
  del 28/09 + fixture ffmpeg pinnate), deposito in background con `abort`, ripresa automatica, pop-up per ruolo.
- **E2E in CI** (DB della CI dopo `migrate-ci` delle 2 + 3 migrazioni): invio con bambini prima (422 con i nomi e
  **zero** richieste `/upload/resumable`, poi l'invio vero e l'elenco che diventa `in-coda`); ripresa automatica
  (`setOffline` a metà, completamento **senza clic**); rinnovo (PUT sull'URL firmato → `arrivato`, token falso → 404,
  seconda PUT → 409); **destinatari**: con la conversione simulata dal service role, solo i genitori dei bambini
  taggati vedono il video e ricevono la notifica, gli altri no. Il seed riceve un bambino **senza** liberatoria.
- **Ogni critico** lancia anche `npx vitest run __tests__/architecture __tests__/a11y
  __tests__/api/zod-coverage.test.ts`, i test che importano i file toccati, `tsc --noEmit`, `eslint` sui file toccati
  e almeno una mutazione vista rossa. Alla fine un giro d'integrazione con la suite intera prima del gate.

---

## 18. Compiti e ondate

Esecutori Sonnet, critici Opus (regola del titolare dal 02/10: il critico passa se non ci sono bloccanti; i secondari
si annotano in `docs/superpowers/plans/2026-10-02-video-pr2-difetti-secondari.md` e nel PRD). Al massimo 3 giri per
compito; un bloccante ancora aperto al terzo giro ferma il lavoro e si scrive al titolare.

| # | Compito | File (esclusivi) | Accettazione |
|---|---|---|---|
| T1 | Contratto e limiti a 300 | `src/lib/media/video/limiti.ts`, `contratto.ts`, `encode.ts` (VBV dal massimo), `src/app/api/video-uploads/risposte.ts`, `src/lib/ui/esito-fetch.ts` (solo aggiunte), `messages/{it,en}/shared.json` e `adminComunicazioni.json`, test di contratto, encode e probe | codici nuovi (`ORIGINALE_DIVERSO`, `ORIGINALE_SOSTITUITO`, `CAPACITA_PIENA`, `TOKEN_NON_VALIDO`, `DESTINATARI_MANCANTI`, `NESSUN_DESTINATARIO`, `PUBBLICAZIONE_NON_RIUSCITA`, `RIPROVA_NON_POSSIBILE`, `TAG_NON_DELL_INTENTO`, …); schemi zod dell'apertura estesa, dell'unione tus/put, del rinnovo, di `VoceVideo`; regola #37; nessun 180 residuo in `src/lib/media` fuori da `temporale.ts` (T9); testi «5 minuti» |
| T3 | Estrazione della coda outbox | `src/lib/media/video/outbox/*`, `retention-video/route.ts` (solo l'estrazione), `gdpr-retention-video.test.ts` | comportamento invariato: la suite della retention identica e verde |
| T2a | Migrazione A + PGlite | file A, `__tests__/lib/video-pubblicazione-automatica-rpc.test.ts`, test di schema e transizioni (300), `IN_CODA` (i tre nomi), lock delle uscite | ogni RPC di §5.3 provata anche sui rami di rifiuto |
| T4 | Cancelli condivisi della galleria, notifica ai genitori, chiusura del ramo video di `/api/gallery` | `src/lib/gallery/cancelli-destinatari.ts` (nuovo), `src/lib/gallery/notifica-genitori.ts` (nuovo), `src/app/api/gallery/route.ts`, `src/lib/gallery/video-pubblicazione.ts` (percorso deterministico), chiavi proprie in `errori-senza-codice-allowlist.json`, test `gallery-*` | test di privacy e scope invariati; `video_intent_id` → 409; foto con `caption` NULL e testo nuovo |
| T9 | Verifiche senza falsi scarti | `temporale.ts`, `verify.ts`, `probe.ts`, `__tests__/fixtures/video/*`, `__tests__/fixtures/ffmpeg.ts`, test | fixture del 28/09 rossa prima e verde dopo; controprove rosse |
| T10 | Libreria di caricamento | `src/lib/media/video/upload/*`, `src/components/features/admin/news/NewsVideoAllegati.tsx`, test, `e2e/video-archivio.spec.ts` | la prima PATCH TUS parte prima che il deposito finisca; `abort` ferma copia e trasferimento; #39 |
| T12 | Legacy e codice morto (§14) | file del §14, chiavi proprie in `errori-senza-codice-allowlist.json` | `grep` sui moduli tolti a zero; lock aggiornati e non indeboliti |
| T2b | Trigger d'arrivo | file B, test PGlite con lo schema `storage` finto, lock `trigger-storage-fail-open` | un'eccezione nel trigger lascia l'insert riuscito; risorto riarmato; `video_job_uploaded` idempotente |
| T2c | SQL della conservazione | file C, `video-retention-rpc.test.ts` | riconciliazione in sola lettura; uscite dei pubblicati con scadenza; flusso vecchio revocato |
| T5 | Route video-uploads | `video-uploads/route.ts`, `[id]/route.ts`, `[id]/firma/route.ts`, `rinnovo/route.ts`, `cancello.ts`, `src/lib/media/video/token-rinnovo.ts`, voci nei lock gate/isolamento/upload pubblico/corpo dopo il gate, test | 422 **identico** a `/api/gallery`; 404 uniforme; zod e logging coverage verdi |
| T6 | Runner: `job_id`, sorveglianza, tetto, ventaglio, salute, #23, #33 | `runner/esegui.ts`, `index.ts`, `porte.ts`, `adattatori.ts` (parte coda), `src/app/api/video/runner/route.ts`, `src/lib/health/controlli.ts`, test del runner | due invocazioni sullo stesso job: una sola sorveglia; tetto rispettato; `/api/health` senza falso allarme |
| T7 | Pubblicazione automatica ed esiti | `src/lib/gallery/pubblicazione-video-automatica.ts`, `src/lib/media/video/esiti.ts`, `src/lib/notifiche/tipi.ts`, `messages/{it,en}/etichette.json`, `src/lib/push/dispatch.ts`, `outbox/destinatari.ts`, due righe in `runner/index.ts` | notifiche solo con la marca; avviso senza nomi; fallito dopo 60'; bambino uscito e nessun destinatario come §8.2 |
| T13 | Conservazione e GDPR | `retention-video/route.ts` (passi), `src/lib/gdpr/esegui.ts`, oblio, test | righe trattenute ⇒ 500; registro coerente con la fotografia dello Storage |
| T8 | Ambiente pronto + sha256 | `runner/adattatori.ts` (parte macchina), `runner/ambiente.ts`, `preparazione.ts`, `script.ts`, `build.ts`, `ritentativi.ts` (codice d'uscita nuovo), `scripts/video-sandbox-ambiente.mjs`, `docs/env.md`, test | ripiego provato con snapshot assente; impronte nel lock; sha256 diverso → `ORIGINALE_DIVERSO` non ritentato |
| T11 | Client galleria + selettore (§11.1) | `src/components/features/gallery/**` (video e `MediaUploader.tsx`), `src/app/(dashboard)/teacher/gallery/page.tsx`, `src/lib/gallery/video-galleria-flusso.ts`, `src/lib/media/video/trasporto/*`, `src/lib/native/use-image-picker.ts` e `camera.ts` (solo se servono ai log della fotocamera), `messages/{it,en}/teacherServizi.json` e `shared.json` (chiavi del selettore), test | nessun `alert` nel ramo di invio; 422 nel passo dei bambini; ripresa senza clic; «Riprova»; «va ricaricato»; 50 elementi; #36; **§11.1**: nell'app il riquadro grande apre il selettore foto e video e «Scatta una foto» è secondaria; i tre log (aperto, ricevuti, chiuso senza file) con un test ciascuno visto rosso rompendo il codice; mai il nome del file nei log |
| T14 | Pop-up 1.2 per il personale, **spento** (`null`) | `aggiornamento-app.ts`, `AvvisoAggiornamentoApp.tsx`, test | con `null` nessun effetto; con `'1.2'` compare solo al personale sotto la 1.2 |
| T15 | E2E | 3 spec + destinatari, `scripts/seed-e2e.mjs`, `playwright.config.ts` | verde senza ritentativi |
| T16 | Orchestratore | misure, snapshot e variabili, collaudo reale sul DB della CI, PRD, gate intero, PR, migrazioni, merge, verifiche, fotografie | §19 |

**Ondate:** 1) T1 ∥ T3 · 2) T2a ∥ T4 ∥ T9 ∥ T10 ∥ T12 · 3) T2b ∥ T2c ∥ T5 ∥ T6 · 4) T7 ∥ T13 ∥ T8 ∥ T11 ∥ T14 ·
5) T15, poi T16. **File condivisi in serie:** `shared.json` (T1 → T12 → T14 → T11); `teacherServizi.json` (T12 → T11);
runner (T6 → T7, T8 su file diversi); retention (T3 → T13); `errori-senza-codice-allowlist.json` (T4 e T12 su chiavi
diverse, rileggendo prima di scrivere; poi T5).

---

## 19. Rilascio (T16)

1. Prima del merge: misure (§10.3) e costo; snapshot creato e `VIDEO_SANDBOX_SNAPSHOT_ID` +
   `VIDEO_CONVERSIONI_PARALLELE` su Production e Preview (**mostrati prima**); le 2 + 3 migrazioni sul DB della CI con
   `migrate-ci.yml`; E2E verde; collaudo reale sul DB della CI con il Sandbox; **collaudo sul simulatore iPhone** del
   selettore di §11.1 (riquadro grande → selettore foto e video, «Scatta una foto» secondaria, i tre log visti partire).
   Il PRD della PR ha la voce del selettore e dei suoi log.
2. `SELECT count(*) FROM enrollment_submissions;` poi le tre migrazioni in produzione, **mostrate prima**, rinominate
   all'istante vero e applicate con `supabase db push --linked`; `get_advisors` a 0 ERROR.
3. Merge a mano in un orario tranquillo; deploy collegato al commit; `migrate.yml` approvato solo dopo aver visto
   «Remote database is up to date».
4. Verifiche in sola lettura: `video-originale-arrivato`, battiti del runner, `pubblicazione-automatica-riuscita`,
   contatori della purga, `video_processing` che scende verso le sole uscite vive, `video_riconciliazione` con gli zeri
   attesi, intenti del flusso vecchio revocati.
5. Fotografie, PRD con l'esito, pulizia dei branch, memoria.

---

## 20. Rischi

- **Trigger su uno schema gestito:** non si toglie, si neutralizza riscrivendo il corpo; la scansione a ogni giro è la
  rete se un aggiornamento di `storage-api` cambiasse il comportamento.
- **Pubblicazione senza ultimo sguardo**, anche a liberatoria revocata: decisione del titolare.
- **4K HDR a 5 minuti:** tempi, costo, `TETTO_SANDBOX_MS` (misure di T16).
- **Ripiego sul runtime deprecato** `node22` (§10.2).
- **Ordine migrazione/codice:** le migrazioni vanno prima del codice; le funzioni vecchie non cambiano firma.
- **Client col JS vecchio non ricaricato:** riceve 409 `VIDEO_APP_DA_AGGIORNARE` e un messaggio.
- **iOS con le app 1.0/1.1:** il TUS si ferma in background; riprende da solo alla riapertura.
- **Nuovo archivio di identificativi di minori** (`tag_alunni`): minimizzato a 7 giorni, coperto dall'oblio con
  prova di mutazione.
- **PUT singola da 2 GB** (PR 3).

---

## 21. Secondari della PR 1 assegnati qui

| # | Dove | Compito |
|---|---|---|
| 23 | `last_error_code` a tentativi esauriti | T6 (+ T2a se serve la REPLACE di `video_job_retry`) |
| 33 | eccezione dell'SDK non classificata | T6 |
| 36 | `aria-live` su un paragrafo montato a condizione | T11 |
| 37 | messaggio «file illeggibile» per un guasto nostro esaurito | T1 (regola), T5 (elenco), T7 (notifica) |
| 39 | `VIDEO_RIPROVA` al rientro nelle News | T10 |
