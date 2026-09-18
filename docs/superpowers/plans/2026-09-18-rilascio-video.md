# Rilascio «Video HEVC e Full HD» — la sequenza, e perché l'ordine non è negoziabile

⚠️ **Questo non è più un merge.** La pagina della Galleria **non ha più la conversione nel
browser**: è stata sostituita dalla pipeline nuova. Finché le migrazioni non sono applicate,
`POST /api/video-uploads` risponde **503**. Mergiare senza applicarle significa che
**un'insegnante non può più caricare un video**: il percorso vecchio non c'è più e il nuovo non
è acceso.

Nessun passo qui sotto va eseguito senza aver **mostrato** cosa si sta per applicare. In
produzione ci sono dati reali di minori, e *mostrare non è chiedere*: non costa niente, ed è
l'ultima cosa fra un errore e le famiglie.

---

## 0 · Prima di toccare qualunque cosa (letture, non chiedono conferma)

```sql
SELECT count(*) FROM enrollment_submissions;            -- quante righe reali ci sono ADESSO
SELECT id, public, file_size_limit FROM storage.buckets ORDER BY id;
SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 15;
```
E il tetto globale dello Storage dal pannello: **se fosse sceso sotto i 2 GB**, la migrazione
della Galleria non entrerebbe in vigore e una `updateBucket` verrebbe respinta **intera**,
`public` compreso.

## 1 · Le variabili d'ambiente, PRIMA delle migrazioni

Su Vercel, produzione **e** preview:

| Variabile | Valore |
|---|---|
| `VIDEO_RUNNER_OWNER_ID` | un uuid **stabile**, mai rigenerato |
| `VIDEO_SANDBOX_REGION` | `dub1` (dove sta lo Storage) |
| `VIDEO_SANDBOX_VCPUS` | `4` |

🔴 **`VIDEO_RUNNER_OWNER_ID` deve restare lo stesso fra un'invocazione e l'altra.** La
durevolezza del runner poggia sul riprendere la propria lease con lo stesso owner, che ridà lo
stesso `fence_epoch` e quindi lo stesso nome di MicroVM da riagganciare. Con un uuid casuale
**ogni conversione lunga ricomincerebbe da capo all'infinito, senza un solo errore nei log.**

## 2 · Le nove migrazioni, in questo ordine

```
20260916190000_video_jobs.sql
20260916190100_video_job_transitions.sql
20260916190200_video_intent_lifecycle.sql
20260917210000_video_job_next.sql
20260917233752_bucket_limite_esplicito_certificati_credenziali_fatture.sql
20260918025900_bucket_limite_esplicito_cassa_chat_pagelle_protocollo_sensitive.sql
20260918104500_bucket_gallery_tetto_video.sql
20260918113000_bucket_news_tetto_video.sql
20260918110000_video_retention_riconciliazione.sql      ← dopo il deploy della sua route
20260918120000_video_runner_tick.sql                     ← dopo il deploy della sua route
```

⚠️ **Le ultime due si applicano DOPO che le loro route sono in produzione.** Applicate prima, il
cron chiamerebbe un 404 e `cron.job_run_details` direbbe **`succeeded` lo stesso**, perché misura
l'accodamento e non l'esito. È già successo l'11/08/2026: tre ore e undici minuti di chiamate a
vuoto lette come riuscite.

Dopo ciascuna: **`get_advisors` a 0 ERROR.**

## 3 · Le quattro cose che l'applicazione rende obbligatorie

1. **Rigenerare `bucket-storage-snapshot.json`** — nascono `video_originals` e `video_processing`.
2. **Registrare i due bucket in `REGISTRO_BUCKET_OBLIO`** (`src/lib/gdpr/esegui.ts`). Senza,
   `gdpr-oblio-completo` diventa rosso — e giustamente: un bucket senza responsabile di oblio è
   un archivio di minori che nessuno sa svuotare. **Queste due mosse sono una sola e non si
   possono separare.**
3. **Rigenerare la fotografia delle migrazioni** e togliere da `IN_CODA` le voci applicate.
4. **Aggiungere i due cron a `JOB_CRON`** (`src/lib/health/controlli.ts`), e **non un minuto
   prima**: `video-retention` con `finestraMs: 40 * MIN`, `video-runner-tick` con `20 * MIN`. Un
   nome in `JOB_CRON` la cui migrazione non è applicata manda `/api/health` in `degradato` dal
   primo deploy e **per sempre** — e un allarme che suona da solo viene spento.

## 4 · Il primo battito, a mano

```sql
SELECT public.video_runner_tick_http();
SELECT public.video_retention_http();
```
E poi **la prova vera**, che non è né la funzione né lo schedule:
```sql
SELECT visto_l_ultima, contesto->'campi'->>'operazione', contesto->'campi'->>'esito'
  FROM public.app_log
 WHERE evento = 'cron'
   AND contesto->'campi'->>'operazione' IN ('video-runner-tick','video-retention')
 ORDER BY visto_l_ultima DESC LIMIT 10;
```

## 5 · Solo DOPO che un video vero è passato: il blocco delle app vecchie

`src/lib/media/interruttore-legacy-video.ts` → `BLOCCO_LEGACY_VIDEO_ATTIVO = true`.

Una riga sola, e l'unicità è dimostrata da due test. **Accenderlo prima che un video vero sia
uscito dalla pipeline lascerebbe i genitori senza nessun modo di caricare.**

---

## Cosa resta NON dimostrato, e si vedrà solo qui

| | Dove si misura |
|---|---|
| `Sandbox.get({name, resume})` riaggancia una MicroVM con una conversione in corso | il primo video lungo vero. **È l'ipotesi su cui poggia l'intera durevolezza** |
| `FOR UPDATE SKIP LOCKED` di `video_job_next` | due client su Postgres vero; PGlite ha una connessione sola |
| `ffprobe` su URL firmato che legge per intervalli un originale da 2 GB | il primo video grande |
| La ripresa TUS dopo la chiusura vera dell'app | dispositivo iOS/Android |
| Il layout reale di `video_originals` per la spazzata degli orfani | il primo giro di retention |
| Quanto dura davvero una conversione, e se cinque minuti di cadenza bastano | i primi giorni |

## Le decisioni che aspettano una persona

1. 🟡 **Il consenso fotografico in copertina.** Lo stesso video allegato al testo non chiede
   niente; in copertina fa scattare il gate, perché `contieneFoto` è vera per qualunque
   copertina valorizzata. Non l'ha scelto nessuno, ed è inchiodato da due test.
2. 🔴 **`allowed_mime_types` a NULL** su `certificati-medici`, `credenziali`, `fatture`:
   accettano qualunque tipo di file. Quali formati possa avere un certificato medico è una
   decisione di prodotto.
3. **Il bucket di lavorazione non ha una scadenza** nello schema: l'uscita di un job concluso
   male resta lì per sempre. Il numero esce dalla riconciliazione, così la decisione parte da
   una misura.
