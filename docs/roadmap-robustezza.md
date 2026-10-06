# Roadmap di robustezza: server e database

> **Come si usa.** Una sessione = un branch secondario → PR → CI verde → merge a mano → deploy.
> All'inizio di ogni sessione si rilegge questo file, si **rimisura** la riga di partenza (le query
> stanno in fondo) e alla fine si aggiorna la casella di stato con data, PR e numeri «dopo».
> Le regole di sempre restano: PRD aggiornato, log obbligatori, gate verde, `SELECT count(*) FROM
> enrollment_submissions;` prima di ogni migrazione, SQL **mostrato** prima di applicarlo, mai due
> migrazioni rischiose nella stessa finestra di deploy.

Ricerca del 05/10/2026, in sola lettura, su tre fonti:
- misure di produzione: Supabase (SQL, log, advisor, metriche dell'istanza, lista dei backup) e Vercel (API, header);
- tre audit del codice;
- una revisione dell'ordine fatta da un agente architetto.

Vincolo sopra tutti: **nessuna perdita di dati** (in produzione ci sono dati reali di minori,
contabilità e fatture).

Versione da leggere (privata, del titolare): <https://claude.ai/artifact/5BMCukYTJYQ2AScpJARTWH>.
Questo file resta la copia di lavoro: lo stato delle sessioni si aggiorna **qui**.

---

## Stato delle sessioni

| # | Sessione | Stato | PR | Note |
|---|---|---|---|---|
| 0 | Decisioni e interruttori (titolare) | ⬜ da fare | — | PITR? conferme agenti? |
| 1 | Funzioni a Dublino + disarmo `migrate.yml` | 🟡 rilasciata (PR #188) | #188 | misura definitiva a +12 h dal deploy; timeout a ~0 solo su 2-3 giorni feriali. ✅ con i numeri nel primo commit della fase 2 |
| 2 | Paracadute esterno (DB + Storage) e prova di ripristino | 🟡 rilasciata (PR #189, #191, #193) | — | backup notturno cifrato su R2 UE, armato alle 02:23 UTC dal 06/10. Misura PRIMA 05/10: copia esterna = nessuna. DOPO 06/10: DB 20,4 MB + 5.532 file (7,41 GB), 0 mancanti, blocco R2 provato (409 su cancella e sovrascrivi), allarme provato. **Restano**: le due prove di ripristino (Mac e Supabase) e due notti consecutive riuscite; la ✅ finale va nel primo commit della fase 3 |
| 3 | Campanello e salute a livelli | ⬜ da fare | — | |
| 4 | Scatola nera e pulizie sicure | ⬜ da fare | — | |
| 5 | Soldi corretti | ⬜ da fare | — | |
| 6 | Indici | ⬜ da fare | — | |
| 7 | Freni RESTRICT (2 PR) | ⬜ da fare | — | |
| 8 | Code robuste + sonde arretrati | ⬜ da fare | — | |
| 9a | App e tempo reale | ⬜ da fare | — | |
| 9b | Pubblicazione Realtime potata (≥ 2 settimane dopo 9a) | ⬜ da fare | — | |
| 10 | Identità per richiesta (solo se serve) | ⬜ da fare | — | |
| 11 | Errori non ignorati | ⬜ da fare | — | |
| 12 | Pulizia e costi (Small/Medium) | ⬜ da fare | — | |

Dipendenze:
- 0 prima di tutto (eccezione verificata il 05/10: la 1 non usa nessuna decisione della 0);
- **2 prima di qualunque migrazione che cancella o restringe** (4, 7, 12);
- 3 prima di 4-12 (le regressioni devono arrivare come allarme, non dai genitori);
- 6 prima di 7;
- 8 prima delle sonde sulle code;
- 9a almeno due settimane prima di 9b;
- 10 e 12 si decidono con le misure **dopo** la 1, perché la 1 cambia tutti i numeri.

---

## Cosa diceva davvero il «degraded» (05/10)

`/api/health` era `degraded` per **un solo controllo su sette**, `sezione-testo-allineato`: 2 alunni
con il testo della classe diverso dal nome della sezione. È **qualità dei dati**, non salute del
server: DB, cron e configurazione erano ok. Il degrado vero (latenza, backup, cancellazioni) il
controllo di salute **non lo vede**.

---

## Problemi e soluzioni

Legenda: 🔴 alta · 🟠 media · 🟡 bassa · ✅ = consigliata.

### Server

#### S1 🔴 Il server lavora a Washington, il database sta in Irlanda
- **Prove**: Vercel `serverlessFunctionRegion: iad1`, header `x-vercel-id: fra1::iad1`; DB su `eu-west-1`.
  - In 24 ore 293.718 query passano dal colo IAD, con p50 **103 ms** e p95 207 ms ciascuna.
  - Le route video, già in `dub1`, fanno p50 **14 ms**.
  - `POST /api/diary/entries` fa circa 20 viaggi in fila, circa 5 s.
  - `/api/logs` va in timeout (1 s) 230 volte a settimana: log persi.
  - La pubblica `/api/iscrizione/sedi` è andata in timeout 32 volte.
- ✅ **A. Tutte le funzioni a Dublino**: `"regions": ["dub1"]` in cima a `vercel.json`. Ogni domanda al DB passa da ~100 ms a ~5-15 ms. Costo zero; rollback con l'Instant Rollback di Vercel.
- B. Francoforte (`fra1`): più vicina agli utenti, ma ~25 ms a query verso l'Irlanda. Peggio di A, perché le route fanno molte query in fila.
- C. Database negli USA: scartato (GDPR, utenti in Italia).
- Prima di farlo:
  - nessun fornitore deve filtrare per IP (Aruba?), perché gli IP di Vercel dipendono dalla regione;
  - `functionFailoverRegions` solo se il piano Pro lo consente.

#### S2 🔴 Se il sito si ferma, nessuno viene avvisato
- **Prove**:
  - nessun servizio interroga `/api/health`;
  - il 503 per «giù» esiste, ma la qualità dati tiene tutto in `degraded` dal 02/10: un allarme sempre acceso vale come uno spento;
  - nessuna verifica dopo il deploy.
- **Punti ciechi**: login (GoTrue), Storage, Realtime, provider (Resend, FCM, Aruba), arretrati delle code. Nel dettaglio:
  - la push che fallisce tutta risulta comunque «ok» (`src/lib/push/dispatch.ts`, l'esito del battito ignora `fallite`);
  - `tasso-errore` conta le impronte e non le occorrenze: il vecchio guasto delle email («403 domain not verified») resterebbe invisibile;
  - `config` dichiara 7 variabili e ne controlla 6 (`ARUBA_PASSWORD` esclusa, `src/lib/health/controlli.ts`);
  - `/api/logs` è anonimo e può accendere `tasso-errore`.
- ✅ **A. Campanello esterno.** Better Stack (gratis: 10 sonde ogni 3 minuti; avvisi via email, SMS e app; uso commerciale ammesso) o UptimeRobot (gratis: 50 sonde ogni 5 minuti). L'account lo crea il titolare.
- ✅ **B. Salute a livelli**:
  - «vivo» (DB + Auth, 200 o 503): è quello che il campanello sorveglia;
  - «salute» completa, con soglie di latenza;
  - «qualità dati» a parte: non accende l'allarme.
  - In più: tasso d'errore sulle occorrenze e senza i log del browser, correzione 7/6.
- ✅ **C. Verifica dopo ogni deploy** in CI, sull'evento `deployment_status`.
- D. Cron di GitHub come campanello: gratis ma in ritardo di 10-30 minuti. Solo come rinforzo.

#### S3 🟠 Ogni chiamata dell'app chiede ad Auth «chi sei?»
- **Prove**:
  - i token sono **ES256** e il middleware li verifica in locale con `getClaims()`;
  - ma i gate `require*` di ogni route chiamano `getUser()` (`src/lib/auth/require-staff.ts`, `area-guard.ts`, `profili.ts`): **40.483** `/auth/v1/user` in 24 ore, tutte da `supabase-ssr createServerClient`, più 2 query d'identità e nessuna memoria per richiesta;
  - la home `/parent` fa circa 16 fetch;
  - Auth è fisso a **10 connessioni** (advisor `auth_db_connections_absolute`).
- ✅ **A. Prima S1, poi rimisurare**: da Dublino un `getUser` costa ~10-15 ms.
- ✅ **B. Memoria dell'identità per richiesta** nel contesto `AsyncLocalStorage` che esiste già (`src/lib/logging/context.ts`). ⚠️ `cache()` di React **non** memorizza nei route handler.
- C. `getClaims()` nei gate di sola lettura e `getUser()` sulle scritture sensibili. Ma una sessione revocata resterebbe valida in lettura fino alla scadenza del token (1 h, riducibile). Decide il titolare, solo se i numeri lo chiedono.
- ✅ **D. Connessioni di Auth «a percentuale»** (pannello, gratis).

#### S4 🟠 Il tempo reale costa più di tutto il resto
- **Prove**:
  - la query WAL del Realtime `postgres_changes` vale **42.408 s** di tempo DB dal 06/08, 35 volte la seconda voce, con 6,4 M chiamate e un massimo di 10 s;
  - 352.730 righe inserite e cancellate in `realtime.subscription` in 60 giorni;
  - `chat-realtime-errore` circa 300 volte per giorno feriale;
  - canali su tabelle intere senza filtro (`SospensioneBanner.tsx`, `PagamentiSummary.tsx`, `StoricoPagamenti.tsx`), uno anche su `alunni`, che non è pubblicata;
  - pubblicate ma senza ascoltatori: `notifiche`, `armadietto`, `mensa_prenotazioni`.
- ✅ **A. Potare**: un canale per utente; via l'ascolto su `alunni`; i canali su tabelle intere sostituiti con `usePollingVisibile`.
- ✅ **B. Chat su Broadcast dal database**: trigger con `realtime.broadcast_changes()`, canali privati e RLS su `realtime.messages`. È il metodo che Supabase raccomanda per crescere.
- ✅ **C. Togliere tabelle dalla pubblicazione** solo ≥ 2 settimane dopo A e B, quando non ci sono più app vecchie.
- D. Solo polling: più semplice, chat meno immediata.

#### S5 🟠 Code e cron fragili
- **Push**: la presa (`UPDATE … WHERE push_inviata_il IS NULL`) non ha una scadenza: se la funzione muore, quelle notifiche non partono più.
- **Digest**: se tagliato, rispedisce (`src/lib/news/digest.ts`).
- **Solleciti**: `.in()` di 500 id, lettura troncata e `try/catch` intorno a PostgREST (`src/lib/pagamenti/solleciti-invio.ts`).
- **News tick**: senza guardia di stato.
- **Route cron senza `maxDuration`**: 10.
- **Chat**: ogni messaggio lancia un dispatch intero (`src/app/api/chat/messages/route.ts`).
- **Resend**: senza `Idempotency-Key`.
- ✅ **A.** Lo schema della **coda fatture** (presa con scadenza, bidello, advisory lock), riusato.
- ✅ **B.** Idempotenza per destinatario e chiave di idempotenza Resend.
- ✅ **C.** `maxDuration` esplicito e controllo del tempo che resta.

#### S6 🟠 Errori ignorati e report che mentono
- **Prove**:
  - circa 210 `const { data }` senza `error` (circa 106 file API) e circa 43 scritture con l'esito scartato;
  - report di cassa (`src/app/api/pagamenti/cassa/report/route.ts`) e cruscotto admin troncati a 1000 righe in silenzio;
  - postgrest-js ritenta fino a 4 volte senza tetto.
- ✅ **A.** Prima i soldi (D5).
- ✅ **B.** Lucchetto (regola eslint o test di architettura) sui casi nuovi; correzione per area.
- ✅ **C.** Report aggregati in SQL o paginati.

#### S7 🟡 App Android con versioni del sito vecchie di giorni
- **Prove**: «Failed to fetch» circa 1.100-1.500 volte per giorno feriale, soprattutto Android, con bundle di più versioni precedenti in uso; Skew Protection a 12 ore.
- ✅ **A.** Skew Protection per tutta la vita del deploy (Pro lo consente).
- ✅ **B.** Controllo di versione con ricarica forzata al ritorno in primo piano.
- ✅ **C.** Fetch fallito in background registrato come `info`.
- ✅ **D.** Sonda `client:visibilita` a debug: ha già risposto e scrive circa 3.000 righe al giorno.

#### S8 🟡 Niente cache, home con troppe richieste
- ✅ **A.** `s-maxage` su `iscrizione/sedi` e `iscrizione/model` (nessun dato personale).
- B. `/api/parent/home` aggregata: invasiva, si decide dopo S1, S3 e S4 con misure nuove.

### Database (nessuna perdita di dati)

#### D1 🔴 Il paracadute è corto e mai provato
- **Prove**:
  - backup fisici giornalieri (circa 01:00 UTC), **7 giorni**;
  - **PITR spento**: si perdono fino a **24 ore** di dati, e oltre i 7 giorni non si recupera nulla;
  - nessuna copia fuori da Supabase;
  - ripristino **mai provato** (collaudi di agosto: «NON VERIFICATO»);
  - gli agenti scrivono in produzione senza conferma.
- **A. PITR 7 giorni (circa 100 $/mese, richiede almeno Small, che c'è).** Si torna a un minuto preciso: si perdono al massimo circa 2 minuti. Il ripristino ferma il sito qualche minuto.
- **B. Backup esterno notturno (circa 0-1 €/mese)**:
  - workflow GitHub: `pg_dump` 17 di `public`, `auth`, `storage`, `cron` e `supabase_migrations` dal **pooler di sessione** (la connessione diretta è solo IPv6);
  - cifratura **age** (chiave privata offline dal titolare);
  - **Cloudflare R2** in UE (10 GB gratis, uscita gratuita) con **nomi con data e bucket lock** (R2 non ha versioning né Object Lock S3);
  - conservazione: 30 giornaliere più 12 mensili.
- ✅ **C. Entrambi.**
- ✅ **Sempre**:
  - prova di ripristino trimestrale con «Restore to a new project» (conteggi per tabella, 5 file per bucket, tempo cronometrato, poi si distrugge);
  - runbook «cosa fare se…»;
  - la copia ripristinata come banco di prova per le migrazioni rischiose.
- GDPR: R2 nel registro dei trattamenti; scadenza delle copie scritta (l'oblio si compie al più tardi alla scadenza).

#### D2 🔴 I 14 GB di file non hanno backup
- **Prove**:
  - lo Storage **non** è nei backup Supabase;
  - per bucket: form_attachments 4,5 GB, gallery 4,4, video_originals 2,5, chat-allegati 0,9, protocollo 0,7, sensitive_documents 0,3, documenti_personale 0,3, video_build 0,3 (con l'**unica copia** dei binari FFmpeg), fatture 30 MB.
- ✅ **A.** `rclone` **incrementale** sul protocollo S3 di Supabase → R2, cifrato (`rclone crypt`), nello stesso workflow di D1. Incrementale per forza: ricopiare tutto ogni notte farebbe circa 420 GB al mese di uscita (il Pro ne include 250).
- B. Solo i bucket insostituibili: le foto dei bambini resterebbero scoperte.

#### D3 🔴 Un solo DELETE può cancellare anni di storia
- **Prove**: 119 FK `ON DELETE CASCADE` in `public`. Le catene:
  - `scrutinio_periodi`→`scrutini`→pagelle, giudizi, comportamento, firme (route admin senza conferma né audit);
  - `pagamenti`→**incassi**, rate, quote, solleciti, `fatture_coda`;
  - `forms_templates`→compilazioni **firmate**;
  - protocollo cancellato «senza traccia»;
  - `scuole`→tutta la cassa;
  - `auth.users`→`utenti`→13 tabelle;
  - `alunni`→22 tabelle (presenze, pagelle, certificati medici, 104/PEI, ticket);
  - `schools`→25 tabelle.
- ✅ **A. Scatola nera.** Trigger generico come `supa_audit`: ogni riga cancellata delle tabelle preziose va in `registro_eliminazioni` (JSON, autore, transazione), in uno schema non esposto e solo in aggiunta. Scatta anche con le cascate e con SQL o agenti.
  - Scadenza di circa 90 giorni e inclusione nell'oblio (`src/lib/gdpr/account-oblio.ts`).
  - Va misurato il volume di una cascata grande.
- ✅ **B. RESTRICT solo dove c'è valore legale**: pagelle e scrutini, certificati, 104/PEI, moduli firmati, incassi e fatture, cassa.
  - ⚠️ Rompe oblio, eliminazione account (richiesta dagli store) ed eliminazione personale (`api/admin/staff/eliminazione`), che si appoggiano alla cascata.
  - Quindi **due PR**: prima quelle funzioni diventano RPC esplicite, poi i vincoli, provati sulla copia di D1.
  - Prima servono gli indici (D10).
- ✅ **C. Archiviazione solo su due tabelle**: `scrutinio_periodi` (con conferma) e protocollo («annullamento»).
- ✅ **D. Lucchetto sulle migrazioni distruttive**: DROP, TRUNCATE e DELETE solo con il marcatore «distruttiva approvata: motivo».

#### D4 🟠 Audit fragile
L'audit è applicativo e «se va bene»: gli errori di scrittura sono scartati (`registro_modifiche` con
`.then(()=>{},()=>{})`), le tabelle sono modificabili, e SQL e pannello non lasciano traccia.
✅ Scatola nera estesa agli UPDATE di voti, presenze, pagamenti, incassi e scrutini; WORM su
`registro_modifiche` e `audit_scritture_docente`.

#### D5 🟠 Soldi e scrutini: operazioni a metà
- **Casi**:
  - incasso oltre il dovuto con due operatori (`src/app/api/pagamenti/incassi/route.ts`);
  - quote cancellate e reinserite, con `incassi.quota_id` a NULL (`pagamenti/quote/route.ts`);
  - ricarica ticket in 4 scritture (`pagamenti/ticket/route.ts`);
  - scrutinio, vince l'ultimo (`primaria/scrutinio/route.ts`).
- ✅ **A.** RPC transazionali con `SELECT … FOR UPDATE`.
- ✅ **B.** Controllo di versione sullo scrutinio.
- ✅ **C.** Report aggregati in SQL, con totali verificati contro un `SUM`.

#### D6 🟠 Pulizie che possono cancellare troppo
- **Casi**:
  - originali video distrutti dopo 7 giorni di conversione bloccata;
  - allegati del registro a 365 giorni dal caricamento, anche se in uso;
  - «ritirato» che azzera i motivi delle assenze la notte stessa;
  - dati sanitari tolti anche se l'import non li ha copiati.
- ✅ **Correttivi**:
  - interruttore sopra N righe;
  - «non pulire se la catena è ferma»;
  - grazia di 7 giorni per «ritirato»;
  - controllo «copia presente».

#### D7 🟠 Tre strade per le migrazioni
Le tre strade: `apply_migration`, l'integrazione al merge e `migrate.yml`. Quest'ultimo parte a ogni
merge con CLI `latest` e senza dry-run: è un pulsante armato. ✅ Disarmarlo (solo dry-run, o spento),
una sola strada, CLI fissata.

#### D8 🟠 Scritture in produzione senza conferma
È una scelta del titolare dal 18/09; in più il dev locale `:3100` parla col DB di produzione.
- A. Lasciare così, con D1, D2 e D3 come rete.
- B. Conferma solo per DELETE, DROP, TRUNCATE e UPDATE senza WHERE (hook mirato).
- C. Dev locale sul DB della CI.

Decide il titolare (sessione 0).

#### D9 🟡 Capacità
Istanza Small (1,92 GB di RAM, 40% libera, **442 MB di swap usato**), CPU media circa 4%, cache
100%, DB di 348 MB.
- ✅ Restare Small e rimisurare dopo S1, S3 e S4.
- Medium (4 GB, circa 60 $/mese invece di circa 15) solo se lo swap resta alto o le latenze salgono.

#### D10 🟡 Igiene e sicurezza
- **Prestazioni**:
  - 94 FK senza indice (prerequisito di D3-B);
  - 15 `auth_rls_initplan`;
  - 2 indici doppi (`firme_docenti`, `note_disciplinari`);
  - **62 indici «mai usati» da NON togliere**: statistiche dal 06/08, non coprono scrutini e iscrizioni;
  - `app_log` occupa il 44% del DB, con 0% di update HOT;
  - 240 GB di file temporanei di origine ignota: accendere `log_temp_files`.
- **Sicurezza**:
  - protezione dalle password compromesse **spenta**; minimo 6 caratteri;
  - 2 tabelle di backup con dati personali in `public`: `backup_diario_vuote_20260908` e `backup_pulizia_note_20260905`, con RLS senza policy e quindi non esposte. Da eliminare dopo verifica;
  - `GRANT ALL` ad anon e authenticated su `enrollment_submissions`: da revocare;
  - 3 bucket senza lista di tipi;
  - CHECK mancanti su importi e stati dei `pagamenti`.
  - `pg_net` in public: **lasciarlo**.

---

## Le sessioni nel dettaglio

### Sessione 0 — Decisioni e interruttori (titolare, guidato)
- **Decisioni**: PITR sì/no (D1-A); conferme agenti A/B/C (D8).
- **Supabase**:
  - Auth → connessioni a percentuale;
  - protezione dalle password compromesse ON;
  - lunghezza minima 8.
- **Vercel**: Skew Protection → max age pari alla vita del deploy.
- **Account** (solo il titolare può crearli): Better Stack e Cloudflare R2 (bucket in UE).
- **Verifica**: advisor di sicurezza senza i due WARN di Auth.

### Sessione 1 — Funzioni a Dublino
- **File**: `vercel.json` (JSON stretto: un file invalido blocca **ogni** deploy) e `.github/workflows/migrate.yml` (disarmo).
- **Passi**:
  - un passo di CI che valida `vercel.json` contro lo schema;
  - nessun altro lavoro di prestazioni nella stessa PR, perché falserebbe la misura.
- **Prima**: controllare che nessun fornitore filtri per IP.
- **Dopo**:
  - header `::dub1`;
  - query 2 qui sotto: colo DUB ≥ 95% e p50 < 25 ms;
  - timeout di `/api/logs` e `sedi` a circa 0;
  - ms di `/api/health`;
  - durata di POST diary e dei cron.
- **Rollback**: Instant Rollback.
- **Fatto (PR #188, 05/10)**:
  - `"regions": ["dub1"]` in `vercel.json`;
  - `migrate.yml` solo `workflow_dispatch`, solo `--dry-run`, CLI fissata a 2.109.0;
  - due lock: `vercel-json-funzioni-nella-regione-del-db` e `migrate-yml-non-applica-da-solo`. Sono il «passo che valida `vercel.json`», fatto come test del job Unit: offline, senza scaricare lo schema da rete;
  - `docs/cicd.md` corretto (diceva che l'approvazione di `migrate.yml` era la strada delle migrazioni);
  - controllo dei fornitori: passato (nessun IP d'uscita fisso, Supabase aperto a ogni IP, 0 errori 401/403 in 7 giorni).
- **Non incluso**: `functionFailoverRegions` (il piano non è verificato e nessuna misura lo chiede). Il costo del compute per regione non è verificato: guardare l'Usage di ottobre.
- **Da fare a mano dopo il merge**: annullare l'esecuzione di `migrate.yml` ancora in attesa (run 37304105773).
- **Misura definitiva**: a **+12 h** dal deploy (Skew Protection a 12 h: chi ha una pagina vecchia resta su `iad1` fino a 12 h). I timeout di `/api/logs` e `sedi` si leggono su 2-3 giorni feriali.

### Sessione 2 — Paracadute esterno
- **Workflow notturno**:
  - dump del DB e `rclone sync` incrementale → R2 cifrato, con bucket lock;
  - segreti in GitHub: URL del pooler, chiavi S3 dello Storage, chiave pubblica age;
  - la chiave privata age **mai** nel repo né in GitHub.
- **Runbook** in `docs/` e **prima prova di ripristino**: «Restore to a new project», conteggi per tabella contro la produzione, apertura di file, tempo.
- **Rollback**: spegnere il workflow (nessun effetto sulla produzione).
- **Fatto nel codice (05/10, branch `robustezza/fase-2-paracadute-esterno`, in attesa dei passi del titolare)**:
  - `.github/workflows/backup-notturno.yml` (`workflow_dispatch` e, dalla PR #193, `schedule` giornaliero alle 02:23 UTC), `scripts/backup/{dump-cifrato,specchio-storage,ripristina-prova,apri-campioni}.sh`, migrazione del ruolo `backup_lettura` (solo lettura), `docs/runbook-ripristino.md`, sezione «Backup notturno esterno» in `docs/cicd.md`;
  - ambiente GitHub **`backup`** ristretto a `main`, senza revisori: i segreti sono di ambiente (`gh secret set NOME --env backup`), quindi un branch con un workflow modificato non li legge;
  - **cosa è cambiato rispetto al piano**: R2 non ha versioning né Object Lock S3, la protezione sono nomi con data + bucket lock (e il lock vince sul lifecycle: scadenza GDPR automatica); lo specchio dei file ha un **cestino** di 30 giorni (`--backup-dir`, con tetti e rifiuto se la sorgente è vuota o calata sotto il 90%), perché uno specchio «solo aggiunte» violerebbe l'oblio; il ruolo di sola lettura al posto dell'URL `postgres`; la chiave pubblica age sta nel file, non in una variabile (chi modifica una variabile potrebbe sostituirla);
  - **lezione del primo giro dal vivo (05/10)**: `rclone` legge ogni variabile `RCLONE_*` come un'opzione sua (`RCLONE_VERSION` = `--version`); i test con strumenti finti non lo vedono. Per iterare senza aspettare 35 minuti di CI a ogni correzione, il workflow si prova **in locale** con un esecutore che legge il file vero e usa credenziali temporanee (token R2 di 24 ore, chiave S3 da revocare);
  - **scelta del titolare (06/10)**: `gallery` e `video_originals` (foto e video, circa 7,7 GB) **fuori dal backup** per non pagare spazio; `chat-allegati` e `form_attachments` dentro; un lock vieta di escludere i bucket insostituibili. Costo atteso: dentro i 10 GB gratuiti di R2. Il rischio accettato (galleria persa = non recuperabile) sta nel runbook;
  - **trappola scoperta**: «Restore to a new project» copia anche i cron: 28 job attivi e 19 funzioni con `pg_net` chiamano l'app di produzione (`iscrizioni-import-invio` manda mail dalle 08:10 UTC). Si fa di notte, fuori da 08:00–09:00 UTC, e si spegne `pg_cron` appena il progetto nasce. Il progetto temporaneo contiene dati di minori: lo cancella il titolare nel pannello.
  - **giri dal vivo da `main` (06/10)**: `prova` e `completo` verdi alla prima dopo la correzione #191 (specchio: 5.532 oggetti, 7,41 GB, 0 mancanti, 0 differenti, 483 s; dump 20,4 MB in 37 s). Regole su R2 create dal pannello: blocco 30 g su `db/giornalieri/`, 365 g su `db/mensili/`, 30 g su `storage/cestino/`, con scadenze a 31, 366 e 31 g. **Blocco provato sul dump vero**: cancellazione e sovrascrittura rifiutate con HTTP 409 (`ObjectLockedByBucketPolicy`); la regola vale anche per gli oggetti già presenti. **Allarme provato** con `simula_guasto`: segnalazione ed email (Resend 200). Orario armato con la PR #193.
  - **ancora da fare**: prova di ripristino 1 sul Mac (serve il server Postgres 17 in locale), prova 2 «Restore to a new project» di Supabase (di notte), due notti consecutive riuscite, copie offline delle chiavi (titolare), revoca delle credenziali temporanee di prova.

### Sessione 3 — Campanello e salute a livelli
- **File**: `src/lib/health/controlli.ts`, `src/app/api/health/route.ts`, CI.
- **Lavoro**:
  - vivo / salute / qualità dati;
  - tasso d'errore sulle occorrenze, solo log del server;
  - correzione 7/6;
  - smoke test dopo il deploy;
  - monitor collegato;
  - correzione dei 2 alunni (UPDATE mostrato prima).
- **Verifica**: variabile rotta in Preview → allarme ricevuto.
- **Dalla fase 1**:
  - lo smoke test dopo il deploy controlla anche che `x-vercel-id` contenga `::dub1::`, così la regione non regredisce in silenzio (il lock della fase 1 prova il file, non il deploy);
  - tracciare la regione in `app_log` richiede una chiave nuova in `CHIAVI_IN_CHIARO` (`src/lib/logging/redact.ts`), che allarga il canale anonimo di `/api/logs`, oppure una colonna: si decide qui;
  - le soglie di latenza di «salute» si fissano con i valori misurati **dopo** la fase 1 (oggi `/api/health` risponde in 1,06 s end-to-end, 633 ms interni).
- **Dalla fase 2**:
  - il backup notturno non ha nessun allarme se il workflow **non parte affatto** (GitHub disattiva, ritarda o salta un giro): serve un **heartbeat** esterno (Better Stack: il backup lo chiama alla fine; se non lo riceve entro 26 ore, suona);
  - la «salute» può mostrare l'età dell'ultimo backup riuscito (un file minimo, non cifrato e senza dati, tipo `ULTIMO.json` con data e byte; da decidere dove leggerlo senza dare un accesso a R2 all'app).

### Sessione 4 — Scatola nera e pulizie sicure
- **Migrazione**: `registro_eliminazioni` WORM, trigger AFTER DELETE sulle tabelle preziose, scadenza, inclusione nell'oblio.
- **Archiviazione**: `scrutinio_periodi` archiviato invece di cancellato (con conferma); protocollo: annullamento.
- **Lucchetto** sulle migrazioni distruttive.
- **Pulizie**: interruttori sui job di retention (D6).
- **Verifica**: riga cancellata → ripristinata con lo script del runbook.
- **Dalla fase 2**:
  - `registro_eliminazioni` sta in `public` e quindi **entra già nel dump notturno**; il WORM e la scadenza (90 giorni) devono convivere con la copia: nel dump c'è la riga cancellata finché il dump non scade;
  - dopo un ripristino da un dump vecchio vanno **riapplicati gli oblii** avvenuti dopo la data della copia: serve un **registro recuperabile degli oblii** (data, uuid, tipo; mai i dati). Oggi l'elenco è solo nei log.

### Sessione 5 — Soldi corretti
- RPC per incassi, quote e ticket; versione sullo scrutinio; report di cassa e cruscotto aggregati; `error` controllato in `src/app/api/pagamenti/**`.
- **Verifica**: totali = `SUM` SQL; nuovi `incassi.quota_id` NULL = 0.

### Sessione 6 — Indici
- Indici sulle FK interessate da D3-B e dalle query più pesanti, initplan, doppioni. Mai gli indici «non usati». Merge di sera.

### Sessione 7 — Freni RESTRICT (2 PR)
- **PR 1**: `account-oblio`, eliminazione account ed eliminazione personale come RPC esplicite che cancellano in ordine e registrano.
- **PR 2**: vincoli RESTRICT sulle catene legali, provati sulla copia della sessione 2.
- **Verifica**: oblio e cancellazione account verdi; DELETE di un padre con figli rifiutato.
- **Dalla fase 2**: il progetto temporaneo creato per la prova di ripristino viene **distrutto** dal titolare appena finita la prova (contiene dati di minori e ha i cron). Per la PR 2 se ne ricrea uno dal backup del giorno, di notte e con `pg_cron` spento subito.

### Sessione 8 — Code robuste
- Presa con scadenza su push, digest e solleciti; idempotenza; `Idempotency-Key`; `maxDuration`; dispatch chat deduplicato. Poi le sonde sugli arretrati nella «salute».

### Sessione 9a — App e tempo reale
- Versione con ricarica; un canale per utente; via `alunni`; chat su Broadcast; fetch in background → info; sonda visibilità a debug.

### Sessione 9b — Pubblicazione potata
- Dopo almeno 2 settimane senza client vecchi: via dalla pubblicazione `supabase_realtime` le tabelle senza ascoltatori.

### Sessione 10 — Identità per richiesta
- Solo se dopo la sessione 1 `/auth/v1/user` pesa ancora: memoria in AsyncLocalStorage, decisione su getClaims.
- **Dalla fase 1**: oggi (lunedì 05/10) `/auth/v1/user` conta **117.658** chiamate in 24 h, con p50 105 ms da `iad1`; la fotografia ne dava 40.483 perché la finestra era quasi tutta domenica. Il confronto prima/dopo si fa **feriale contro feriale** e con le mediane per colo, mai con il conteggio di un giorno diverso.

### Sessione 11 — Errori non ignorati
- Lucchetto sui nuovi `{ data }` senza `error`, correzioni per area, tetto ai tentativi di postgrest.

### Sessione 12 — Pulizia e costi
- Storico UPDATE, WORM degli audit, `app_log`, DROP delle tabelle di backup, `log_temp_files`, CHECK, GRANT, cache CDN.
- **Dalla fase 2**: i DATI di `public.app_log` (44% del DB) sono esclusi dal dump notturno: se la pulizia di `app_log` ne cambia la forma o la conservazione, si rivede l'esclusione in `scripts/backup/dump-cifrato.sh`. Anche le tabelle di backup con dati personali (`backup_diario_vuote_20260908`, `backup_pulizia_note_20260905`) finiscono nel dump finché esistono: un motivo in più per eliminarle.
- Decisione sulla home aggregata e su Small/Medium.
- **Dalla fase 1**: il 05/10 alle 16:39 UTC l'istanza ha lo swap usato a 359 MB (la fotografia diceva 442), RAM disponibile 731 su 1.835 MB, load 0,16/0,12/0,07. Si rileggono a +24 h dalla fase 1 e **sempre nella stessa fascia oraria**, prima di scegliere Small o Medium.

---

## Fotografia di partenza (05/10/2026, ~08:30 UTC)

| Misura | Valore | Come si rimisura |
|---|---|---|
| Regione funzioni | `iad1` (header `fra1::iad1`) | `curl -sI https://app.kidville.it/api/health \| grep x-vercel-id` |
| Query server→DB | colo IAD 293.718/24h, p50 103 ms, p95 207 ms | query 2 |
| `/api/health` | `degraded`, 863 ms | `curl -s https://app.kidville.it/api/health` |
| Timeout Supabase di `/api/logs` (1 s) | 230 in 7 giorni | query 3 |
| `/auth/v1/user` | 40.483/24h | query 2 (filtro sul path) |
| Realtime | 42.408 s di tempo DB dal 06/08; 12 sottoscrizioni attive | query 1 |
| Backup | giornalieri, 7 giorni, PITR spento | `supabase backups list --project-ref <ref>` |
| Istanza | Small, 1,92 GB, swap usato 442 MB, CPU ~4% | metriche `/customer/v1/privileged/metrics` |
| Dimensioni | DB 348 MB, Storage 14 GB | query 4 |
| Cron | 30 job, 0 fallimenti in 7 giorni | `cron.job_run_details` |
| Fetch falliti client | ~1.100-1.500 per giorno feriale | query 3 |
| Iscrizioni | 722 righe | `SELECT count(*) FROM enrollment_submissions;` |

**Correzione del 05/10, fatta nella fase 1.** Due righe della tabella, «Query server→DB» (293.718/24h) e
`/auth/v1/user` (40.483/24h), erano di una finestra in gran parte **domenicale**. Rimisurate di lunedì
(05/10, 16:35 UTC) danno 1.032.711 e 117.658, con la **stessa mediana** (103 ms). Un conteggio di 24 ore non
si confronta fra giorni diversi: si confrontano le **quote per colo**, le **mediane**, e i conteggi feriale con
feriale. Il traffico del **server** si isola dall'intestazione, non dal colo: la query 2 senza filtro mescola i
browser (MXP, FCO); quella con il filtro qui sotto no.

Fotografia del 05/10 (lunedì), 16:35–16:51 UTC, per la fase 1: server→DB, colo IAD 99,5%, p50 103 ms, p95 129 ms
(DUB 0,2%, p50 12 ms); `/auth/v1/user` 117.658 (p50 105 ms); `/api/health` p50 1,06 s su 30 richieste;
`/api/iscrizione/sedi` p50 0,63 s; swap usato 359 MB; 29 job cron, 0 fallite in 7 giorni.

**Query 2 bis — solo le richieste del server** (log, `query_logs`; si cambiano `iso_timestamp_start` e `iso_timestamp_end`
per misurare a +12 h dal deploy):
```sql
select toString(log_attributes['request.cf.colo']) as colo, count(*) as n,
  round(quantile(0.5)(toFloat64OrZero(toString(log_attributes['response.origin_time']))),0) as p50,
  round(quantile(0.95)(toFloat64OrZero(toString(log_attributes['response.origin_time']))),0) as p95
from logs where source='edge_logs'
  and toString(log_attributes['request.headers.x_client_info']) like '%createServerClient'
group by colo order by n desc limit 8
```

**Query 1 — tempo DB per statement** (Supabase SQL, sola lettura):
```sql
SELECT round(total_exec_time::numeric/1000,1) AS tot_s, calls, round(mean_exec_time::numeric,1) AS media_ms,
       left(regexp_replace(query,'\s+',' ','g'),120) AS q
FROM extensions.pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;
```

**Query 2 — da dove arrivano le richieste a Supabase e quanto aspettano** (log, `query_logs`):
```sql
select toString(log_attributes['request.cf.colo']) as colo, count(*) as n,
  round(quantile(0.5)(toFloat64OrZero(toString(log_attributes['response.origin_time']))),0) as p50,
  round(quantile(0.95)(toFloat64OrZero(toString(log_attributes['response.origin_time']))),0) as p95
from logs where source='edge_logs' group by colo order by n desc limit 10
```

**Query 3 — errori e timeout per giorno** (Supabase SQL):
```sql
SELECT giorno,
  sum(occorrenze) FILTER (WHERE messaggio LIKE '%SupabaseTimeoutError%') AS timeout_supabase,
  sum(occorrenze) FILTER (WHERE messaggio LIKE '%Failed to fetch%') AS failed_fetch,
  sum(occorrenze) FILTER (WHERE messaggio LIKE 'chat-realtime-errore%') AS realtime_err
FROM app_log WHERE giorno >= current_date - 14 GROUP BY giorno ORDER BY giorno;
```

**Query 4 — dimensioni** (Supabase SQL):
```sql
SELECT pg_size_pretty(pg_database_size(current_database())) AS db,
  (SELECT pg_size_pretty(sum((metadata->>'size')::bigint)) FROM storage.objects) AS storage;
```

---

## Fonti

- Vercel: [regioni delle funzioni](https://vercel.com/docs/functions/configuring-functions/region) · [Skew Protection, max age per tutta la vita del deploy](https://vercel.com/changelog/skew-protection-max-age-now-supports-the-full-deployment-lifetime) · [`after()`](https://nextjs.org/docs/app/api-reference/functions/after)
- Supabase: [Backups e PITR](https://supabase.com/docs/guides/platform/backups) · [Restore to a new project](https://supabase.com/docs/guides/platform/clone-project) · [Compute e disco](https://supabase.com/docs/guides/platform/compute-and-disk) · [Realtime: Broadcast consigliato](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes) · [JWT signing keys](https://supabase.com/features/jwt-signing-keys) · [supa_audit](https://supabase.com/blog/audit)
- Backup esterni: [Cloudflare R2, bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/) · [Storage non incluso nei backup, rclone](https://dev.to/superlede/supabase-backups-dont-include-your-storage-files-heres-what-does-14e9)
- Monitor: [Better Stack vs UptimeRobot](https://notifier.so/guides/better-stack-vs-uptimerobot/)
