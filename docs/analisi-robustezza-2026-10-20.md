# Analisi di robustezza di server e database — seconda misura (20/10/2026)

> **Cos'è.** La stessa analisi del 05/10/2026, rifatta con lo stesso metodo e le stesse query, per
> avere una seconda fotografia da mettere accanto alla prima. Le Parti 1–3 sono state scritte **alla
> cieca**: senza aprire `docs/roadmap-robustezza.md`, `docs/prova-ripristino-2026-10.md`, le memorie
> della roadmap né le voci «Robustezza» del PRD. Il confronto con il 05/10 sta **solo** nella Parte 4,
> scritta dopo.
>
> **Regole rispettate.** Produzione in sola lettura (solo `SELECT`, log, advisor, API in `GET`);
> nessuna chiave di servizio aperta, `.env.local` non letto; nel documento solo conteggi, uuid, codici
> d'errore, nomi di tabelle e di file. Il conteggio delle domande d'iscrizione è stato **rifatto**:
> **733** alle 12:32:54 UTC del 20/10.
>
> **Come leggere i numeri.** Ogni numero ha giorno, ora UTC e finestra (tabella nella §4). «Osservato»
> vuol dire misurato oggi o letto nel codice; «causa probabile» vuol dire un'ipotesi che spiega
> l'osservato ma che non è stata dimostrata.

**Indice.** §1 Cosa dice davvero `/api/health` · §2 Problemi e soluzioni (Server S1–S12, Database
D1–D12) · §3 La roadmap (rimando alla specifica) · §4 Fotografia di oggi · §5 Fonti · **Parte 4 — Confronto con
il 05/10**

---

## In breve

- Il sito oggi **sta bene**: `/api/health` è `ok`, il server parla col database in 10 ms (p50) e
  127 ms (p95) su 1,3 milioni di richieste al giorno, il database lavora all'1,5 % di un core e
  il Realtime, che fino ad agosto si mangiava l'80 % del tempo del database, oggi non fa più niente.
- I rischi rimasti non sono di **velocità** ma di **cose che falliscono senza che nessuno lo sappia**
  e di **dati che non si possono riavere**:
  - i cron dicono «riuscito» anche quando il lavoro non è stato fatto (S1); un sollecito di
    pagamento risulta inviato anche se l'email non è partita (S2);
  - non c'è il ripristino al minuto (D2), 13,2 GB di foto e video non hanno nessuna copia (D3),
    cancellare un utente o un alunno trascina via decine di tabelle senza copia (D4);
  - la produzione è l'unico database, e agenti autonomi ci lavorano senza conferma (D1).
- La roadmap (§3, ora una specifica con 14 piani) ha **14 sessioni**, da fare una alla volta. La
  prima ha una scadenza al **31/10** (documenti delle iscrizioni); seguono `exec_sql` con un freno
  sulle istruzioni distruttive, le cascate senza copia, il backup notturno e la prova di ripristino.
  Le 12 decisioni del titolare sono state prese il 20/10: niente ripristino al minuto (T1) e niente
  copia della galleria (T2) per ora, come rischi accettati con una soglia per ridecidere.
- Una correzione fatta durante la scrittura: la cache di `/api/iscrizione/sedi` non manca di
  `s-maxage` come pensavo all'inizio. Il codice lo manda, ma la CDN di Vercel non tiene la risposta
  per un motivo non ancora dimostrato (S8).

---

## 1. Cosa dice davvero `/api/health`

**La risposta di oggi** (20/10, 12:34:12 UTC): `200`, `stato: "ok"`, 177 ms, 9 controlli tutti `ok`,
regione `dub1`, versione `4c6df4380d04`.

**Le tre porte**

| Porta | Cosa controlla | Codice HTTP |
|---|---|---|
| `/api/health/vivo` | solo che il database risponda a una lettura e che Auth risponda | 200 / 503 — è quella che guarda il Worker di Cloudflare ogni 5' |
| `/api/health` | i 9 controlli qui sotto | `ok` e `degraded` → **200**, `down` → **503** (`src/app/api/health/route.ts:34-41`) |
| `/api/health/qualita` | solo il testo della classe degli iscritti | sempre 200 |

**I 9 controlli** (`src/lib/health/controlli.ts`; girano in parallelo, ognuno con un tetto di **2 s**,
`:115`; un solo controllo «giù» porta tutto a `down`, `:1371-1375`)

| Controllo | Cosa fa davvero | Se fallisce |
|---|---|---|
| `db-lettura` | `select id limit 1` su `utenti` e `app_log`, con la chiave di servizio | down |
| `auth` | `getUserById` di un id nullo: un 404 vale «ok» | down |
| `schema-atteso` | **conteggio esatto** di 5 tabelle (`utenti`, `alunni`, `avvisi`, `notifiche`, `pagamenti`), uno dopo l'altro (`:127`, `:677-702`) | down |
| `cron-battito` | cerca in `app_log` il battito dei 17 job della lista `JOB_CRON` (`:178-358`) | degraded |
| `tasso-errore` | errori del server negli ultimi 15': scatta oltre 5 impronte o 25 occorrenze | degraded |
| `config` | 7 variabili d'ambiente (`:512-534`) | — |
| `coda-fatture` | fatture in attesa o sospese da più di 24 h | — |
| `code-arretrate` | 4 conteggi esatti su notifiche e news (`:1311-1365`) | — |
| `regione` | la regione della funzione | — |

**Perché oggi è `ok`.** Database e Auth rispondono (52 e 28 ms); le 5 tabelle ci sono (177 ms per i
5 conteggi: è il controllo più lento); 17 job hanno battuto nella finestra; ci sono 2 impronte d'errore
attive con al più 2 occorrenze, sotto soglia; nessuna fattura in coda, nessun arretrato.

**Cosa NON misura** (ed è il motivo per cui «ok» non vuol dire «tutto funziona»):
- **le scritture** e il percorso con i permessi veri degli utenti: legge solo con la chiave di servizio;
- **Storage, Realtime, email (Resend), notifiche push, Anthropic**: nessun controllo;
- **13 dei 30 job attivi**: fuori dalla lista dei battiti ci sono `storici-stampe` (gira ogni minuto),
  `iscrizioni-sanitari`, `iscrizioni-retention-esito`, `vigilanza-chat-retention`,
  `tetto-frequenza-pulizia`, i job solo SQL e i mensili; `fascicolo-audit-ip-retention` è ancora
  «in attesa del primo battito» (`:428-435`);
- **l'esito delle chiamate HTTP dei cron** (`net._http_response`): oggi 27 timeout in ~6 ore, e la
  salute non lo sa (S1);
- **Auth sotto carico**: fa una sola chiamata.

E c'è un rischio al contrario: i **conteggi esatti** in serie dentro un tetto di 2 s possono far
dire `down` (503) alla salute in un momento di carico, con la diagnosi sbagliata «schema-atteso giù»
(S5). Oggi impiegano 177 ms: il margine c'è, ma `notifiche` ha già 122.796 righe e cresce.

---

## 2. Problemi e soluzioni

Gravità: 🔴 alta · 🟠 media · 🟡 bassa. Per ogni soluzione: cosa significa, cosa fa, quanto costa,
come si torna indietro. ✅ = consigliata. Le fonti ufficiali di ogni soluzione sono nella §5 (il
codice fra parentesi quadre, es. **[S1a]**, rimanda alla riga della §5).

### SERVER

#### S1 🔴 I cron dicono «riuscito» anche quando il lavoro non è stato fatto

**Prove**
- *Osservato (DB, 20/10 12:35 UTC):* 30 job attivi, **16.032** esecuzioni in 7 giorni, **0** non
  riuscite. Ma «riuscito», per pg_cron, vuol dire solo che la funzione SQL è finita: le funzioni
  che chiamano il server con `net.http_post` **accodano** la richiesta e finiscono subito.
- *Osservato (DB, `net._http_response`, 06:38–12:37 UTC):* **647** risposte `200` e **27** richieste
  senza risposta, tutte «Timeout of 5000 ms reached» (07:42 → 12:10). La coda di pg_net cancella la
  richiesta dopo l'invio: **quale** job sia andato in timeout non si sa più.
- *Osservato (DB, `pg_proc`):* delle 20 funzioni che chiamano il server, **16** non passano
  `timeout_milliseconds` e prendono il predefinito installato, **5000 ms**; solo 4 hanno 120–300 s.
  Le route chiamate hanno `maxDuration` 300 s e possono durare più di 5 s (il giro dei solleciti ha
  impiegato 104 s per 238 voci, `src/app/api/pagamenti/solleciti/run/route.ts:22`).
- *Osservato (codice):* nessuno legge `net._http_response`, tranne la retention delle iscrizioni
  (`__tests__/architecture/cron-http-esito-osservato.test.ts:38-43`). `storici_tick` gira **ogni
  minuto**, chiama il server anche quando non c'è lavoro, e avvolge tutto in un solo
  `exception when others then raise warning` (`supabase/migrations/20261019223123_battiti_app_log_che_contano.sql:219-241`):
  se l'aggiornamento di conservazione fallisce, resta un warning nel log di Postgres e basta.
- *Osservato (codice):* 13 job su 30 fuori dalla sorveglianza dei battiti (§1).
- *Causa probabile:* dopo un timeout di pg_net la funzione su Vercel continua e di solito finisce;
  ma il database non lo sa, e un 500 vero è indistinguibile da un timeout.

**Soluzioni**
- **A ✅ Tetto giusto e esito letto.** *Cosa significa:* ogni chiamata dei cron dichiara un tempo
  massimo pari a quello della route (es. 300 s) e un job SQL leggero, ogni 15', guarda le risposte
  di pg_net degli ultimi 15' e scrive in `app_log` un errore per ogni timeout o codice ≥ 400, con il
  percorso. *Cosa fa:* un cron che fallisce diventa un errore visibile in salute (`tasso-errore`)
  in 15 minuti, invece che un battito mancante dopo ore. *Costo:* una migrazione che ridefinisce 16
  funzioni + una funzione nuova; nessun costo di piattaforma. *Indietro:* migrazione inversa con le
  definizioni di oggi (sono nel repo). **[S1a] [S1b]**
- **B Battito per tutti i job.** *Cosa significa:* ogni job, anche quelli solo SQL, scrive a fine
  giro una riga di battito in `app_log`, e la lista dei job sorvegliati in `controlli.ts` si
  genera da `cron.job` invece che a mano. *Cosa fa:* chiude i 13 job ciechi. *Costo:* basso.
  *Indietro:* revert della PR. Va fatta **insieme** ad A.
- **C Coda vera (Supabase Queues / pgmq).** *Cosa significa:* i lavori diventano messaggi in una
  coda nel database, presi e confermati dal server. *Cosa fa:* ritentativi ed esiti per costruzione.
  *Costo:* alto (riscrivere 20 job). *Indietro:* lungo. Non serve oggi. **[S1c]**

#### S2 🔴 Le email partono una volta sola, e i solleciti risultano inviati anche quando non lo sono

**Prove**
- *Osservato (codice):* nel giro dei solleciti la «presa» (`ultimo_sollecito_il`) si scrive
  **prima** dell'email (`src/lib/pagamenti/solleciti-invio.ts:401-406`, scelta consapevole per non
  rispedire) e alla fine la voce è registrata `ok: true` **sempre**
  (`solleciti-invio.ts:485`), anche se tutte le email sono fallite; il giro dopo la scarta per
  «cadenza non trascorsa».
- *Osservato (codice):* `src/lib/email/send.ts:242-273` fa **un solo** tentativo verso Resend; non
  esiste una coda delle email (grep di `coda_email|email_outbox`: nessun risultato). Le push native
  invece ritentano due volte.
- *Osservato (codice):* il giro dei solleciti è sequenziale: 104 s per 238 voci con tetto 300 s
  (`solleciti/run/route.ts:22,28`). Con ~680 voci la funzione verrebbe uccisa a metà.
- *Effetto:* se Resend è giù 5 minuti durante il giro delle 06:00 UTC, **nessuna famiglia** riceve
  il sollecito e il riepilogo del cron dice che è andato tutto bene. Lo stesso vale per ricevute
  d'iscrizione, OTP e credenziali inviate in quei minuti.

**Soluzioni**
- **A ✅ Esito vero + ritentativo breve.** *Cosa significa:* il sollecito è `ok` solo se almeno
  un'email è partita; se nessuna parte, la presa viene annullata (la data torna com'era) così il giro
  dopo ci riprova; `send.ts` ritenta 2 volte (1 s, 3 s) sui 5xx e sui timeout, sempre con la stessa
  `Idempotency-Key` così Resend non manda doppioni. *Costo:* basso, solo codice. *Indietro:* revert.
  **[S2a]**
- **B Coda delle email nel database.** *Cosa significa:* ogni email da spedire diventa una riga
  (`email_coda`) e un job la spedisce con ritentativi ed esito. *Cosa fa:* nessuna email si perde
  per un guasto breve. *Costo:* medio (tabella, job, sorveglianza). *Indietro:* si spegne il job e si
  torna all'invio diretto. Da fare dopo A, se A non basta.
- **C Giro dei solleciti a blocchi.** *Cosa significa:* il giro si ferma a 200 voci e riprende al
  giro dopo (come la coda fatture). *Cosa fa:* toglie il rischio del tetto dei 300 s. *Costo:* basso.

#### S3 🟠 Ogni richiesta rifà da capo «chi sei»: il 42 % del traffico verso il database

**Prove**
- *Osservato (log Supabase, 24 h, 19/10 12:30 → 20/10 12:30 UTC):* delle **1.301.232** richieste del
  server, **146.787** sono `GET /auth/v1/user` (una chiamata di rete ad Auth), **204.976** letture di
  `utenti` e **191.718** di `parents`: insieme **543.481**, il **42 %**. Altre 105.497 su
  `legame_genitori_alunni`.
- *Osservato (codice):* `resolveIdentity` chiama `auth.getUser()` (`src/lib/auth/require-staff.ts:272`)
  e poi 2–3 letture d'identità (`:207-211`, `:479`); altri `getUser` a `:337`, `:706` e in
  `src/lib/auth/profili.ts:103`; nessun `cache()` di React. Il middleware invece verifica il token in
  locale con `getClaims` (`src/middleware.ts:218-268`).
- *Osservato (codice):* il pool di Auth è fisso a 10 connessioni (`controlli.ts:647`); la home del
  genitore chiama ~13 endpoint.
- *Causa probabile:* oggi non fa danni (p50 10 ms), ma nel momento di punta Auth è il collo di
  bottiglia: tutte le API passano da lì.

**Soluzioni**
- **A ✅ Verifica locale del token anche nelle route.** *Cosa significa:* come già fa il middleware,
  le route verificano la firma del token con le chiavi pubbliche in cache (`getClaims`) invece di
  chiedere ad Auth ogni volta; `getUser` resta solo dove serve l'utente «fresco» (cambio password,
  ruoli). *Cosa fa:* toglie ~147.000 chiamate al giorno ad Auth. *Costo:* medio (un punto solo,
  `resolveIdentity`, ma molto usato: va provato bene). *Indietro:* revert. **[S3a]**
- **B ✅ Una sola lettura d'identità per richiesta.** *Cosa significa:* `utenti` e `parents` si
  leggono una volta per richiesta e si ricordano (`cache()` di React per i componenti; un oggetto per
  richiesta per le route). *Cosa fa:* toglie una parte delle ~400.000 letture. *Costo:* basso.
  **[S3b]**
- **C Un endpoint unico per la home del genitore.** *Cosa significa:* 13 chiamate diventano 1.
  *Cosa fa:* divide per 13 il costo d'identità della pagina più vista. *Costo:* alto (tocca tutta la
  home). Da fare solo se A+B non bastano.

#### S4 🟠 Backup e allarmi appesi al cron di GitHub, che parte con ore di ritardo

**Prove**
- *Osservato (GitHub, 13–20/10):* `backup-notturno` è programmato alle **02:23 UTC** ma è partito
  alle **07:04–09:35 UTC** tutte le 8 notti (oggi 07:47–07:56, ieri 07:56–08:03). Le 7 ultime notti
  sono riuscite.
- *Osservato (GitHub, 06–19/10):* il `campanello` è programmato ogni 15' (96 giri al giorno) ma ne
  ha fatti **4–8 al giorno**, con buchi fino a 6,5 ore (19/10: 10:40 → 17:12). Da oggi 11:00 UTC lo
  fa partire il Worker di Cloudflare ogni 15' (7 giri regolari fino alle 12:30).
- *Osservato (codice):* se il Worker non riesce a far partire il campanello (token scaduto, GitHub
  giù) scrive solo `console.error` (`monitor-esterno/worker.mjs:99-111`): il canale d'allarme è uno
  solo, GitHub Actions + email.
- *Causa probabile:* il backup gira quindi **in orario di scuola** (09–11 ora italiana) e si
  sovrappone alla finestra di punta: oggi p95 server→DB **232 ms** in punta contro **33 ms** in
  calma, lunedì **315 ms** (non dimostrato che sia il backup: oggi alle 07:53 c'era anche un deploy).
- *Rischio documentato da GitHub:* i workflow programmati possono essere ritardati o saltati; nei
  repository pubblici si spengono dopo 60 giorni senza attività. **[S4a]**

**Soluzioni**
- **A ✅ Far partire anche il backup dal Worker di Cloudflare.** *Cosa significa:* lo stesso Worker
  che già fa partire il campanello, alle 02:23 UTC fa partire il backup (`workflow_dispatch`); il cron
  di GitHub resta come riserva. *Cosa fa:* backup di notte, puntuale, fuori dall'orario di scuola.
  *Costo:* basso (una riga in `wrangler.toml` e una funzione nel worker; il token esistente ha già il
  permesso «Actions»). *Indietro:* si toglie il cron dal worker. **[S4b]**
- **B ✅ Secondo canale d'allarme dal Worker.** *Cosa significa:* se il dispatch a GitHub fallisce,
  il Worker manda direttamente un'email (o un messaggio) invece di scrivere solo nel suo log.
  *Costo:* basso; serve una chiave d'invio nel Worker. *Indietro:* si toglie la chiamata.
- **C Monitor esterno a pagamento.** *Cosa significa:* un servizio che controlla il sito ogni minuto
  da più paesi e avvisa per SMS. *Costo:* abbonamento. Utile, non necessario se A e B sono fatti.

#### S5 🟠 `/api/health` può dire «giù» per lentezza, e non vede metà dei guasti

**Prove** (dettagli nella §1)
- *Osservato (codice):* 5 conteggi **esatti** in serie dentro un tetto di 2 s, con esito `giu` →
  503 (`controlli.ts:677-702`); altri 4 in `code-arretrate` (`:1311-1365`). Oggi 177 ms; `notifiche`
  ha 122.796 righe.
- *Osservato (codice):* nessun controllo su Storage, email, push, Realtime; `config` guarda 7
  variabili (mancano quelle di push e Anthropic); 13 job fuori dalla lista.
- *Osservato (codice):* ogni chiamata alla salute passa dal limite di frequenza su DB
  (`src/lib/health/porta.ts:78-79`): la salute **scrive** sul database che sta misurando; il commento
  a `porta.ts:50-52` dice ancora che il contatore è per istanza.

**Soluzioni**
- **A ✅ Controllo dello schema senza contare.** *Cosa significa:* per sapere se una tabella c'è,
  basta `select id limit 0` (o il conteggio «stimato»): la risposta non dipende più da quante righe
  ha. *Cosa fa:* toglie il falso «giù» sotto carico. *Costo:* minimo. **[S5a]**
- **B ✅ Tre controlli nuovi, a basso costo.** *Cosa significa:* Storage (elenco di un bucket con
  limite 1), email (l'ultimo invio riuscito di Resend in `app_log` non più vecchio di N ore nelle ore
  di lavoro), job: la lista dei sorvegliati si confronta con `cron.job` e segnala quelli mancanti.
  *Costo:* basso. *Indietro:* revert.
- **C Salute «profonda» separata.** *Cosa significa:* una porta in più che prova davvero a scrivere
  e a mandare un'email di prova ogni ora. *Costo:* medio; utile più avanti.

#### S6 🟠 Letture che si troncano in silenzio a 1000 righe

**Prove**
- *Osservato (codice):* PostgREST restituisce al massimo 1000 righe e non dice di aver tagliato.
  Leggono «tutto» senza paginare: elenco genitori dell'amministrazione
  (`src/app/api/admin/parents/route.ts:115-153`, alunni senza filtro di stato, poi `.in()` con
  centinaia di id che allunga l'URL), presenze in tempo reale (`src/app/api/admin/presenze/realtime/route.ts:49-53`,
  polling ogni 60 s), controllo qualità della salute (`controlli.ts:1044-1077`), task
  (`src/app/api/tasks/route.ts:492-497`), avvisi dello staff (`src/app/api/avvisi/route.ts:390`).
- *Osservato (DB, 12:56 UTC):* alunni **806** (iscritti 790), avvisi al massimo **72** per sede,
  `task_interni` **0**. La soglia è a **+24 %** per l'elenco genitori e **+27 %** per le presenze.
- *Effetto:* il giorno in cui una sede supera i 1000 alunni (storici compresi), la tab «Genitori» e
  il cruscotto presenze perdono famiglie e bambini **senza errore**.

**Soluzioni**
- **A ✅ Leggere a blocchi dove serve tutto.** *Cosa significa:* usare i due aiuti che il progetto
  ha già, oggi confinati ai pagamenti: `leggiABlocchi` (`src/lib/pagamenti/leggi-a-blocchi.ts:98`,
  pagine da 1000 con ordine stabile) e `aBlocchi` / `ID_PER_QUERY` (`src/lib/db/blocchi.ts:22,46`,
  lotti di id per non allungare l'URL dei `.in()`), spostando il primo in `src/lib/db/` e usandoli
  nelle 5 route; filtrare per stato dove ha senso. In più, il `fetch` strumentato dei client
  Supabase segnala con un `warn` ogni risposta che arriva esattamente a 1000 righe. *Costo:* basso.
  *Indietro:* revert. **[S6a]**
- **B ✅ Un lucchetto nei test.** *Cosa significa:* un test d'architettura che segnala le select
  senza `range`/`limit`/blocchi sulle tabelle che crescono. *Costo:* basso.
- **C Alzare «Max rows».** *Cosa significa:* portare il tetto da 1000 a 5000. *Cosa fa:* sposta il
  problema, e rende più pesante ogni lettura sbagliata. ❌ sconsigliata.

#### S7 🟡 Chat e polling: tante query per poco

**Prove**
- *Osservato (codice):* `GET /api/chat/threads` fa ~4 query per conversazione e un **UPDATE dentro
  una GET** (`src/app/api/chat/threads/route.ts:55-148`, `src/lib/chat/delivered.ts:172,230`), ed è
  chiamata da **due** poller ogni 30 s sulla stessa pagina
  (`src/components/features/chat/useConversazioneChat.ts:242-247,674`). Ogni messaggio inviato
  programma un giro di dispatch delle notifiche che tiene viva una funzione 30 s
  (`src/app/api/chat/messages/route.ts:47-110`).
- *Osservato (log, 24 h):* `HEAD chat_messages` **44.142**, `GET chat_messages` **32.137**,
  `chat_threads` **21.644**. *Osservato (DB):* 1.004 conversazioni, al massimo 37 per utente.
- *Osservato (DB):* il Realtime è ormai solo «broadcast» privato (la pubblicazione non ha tabelle,
  `realtime.subscription` = 0); gli errori realtime della chat (288–378 nei giorni feriali) sono
  quasi tutti di trasporto (`trasporto` 1.300, `socket-chiuso-1006` 544 in 7 giorni): rete dei
  telefoni, non il server.

**Soluzioni**
- **A ✅ Un poller solo e conteggi in una query.** *Cosa significa:* la pagina chat usa un solo
  ritmo; i non letti per conversazione si contano in una RPC; la marcatura «consegnato» diventa una
  POST esplicita. *Costo:* medio. **[S7a]**
- **B Dispatch raggruppato.** *Cosa significa:* al massimo un giro di dispatch ogni 30 s per sede,
  non uno per messaggio. *Costo:* basso.

#### S8 🟡 Al bordo di Vercel: sfida «sei un robot?» ai client veloci, e una cache mai usata

**Prove**
- *Osservato (20/10 12:34:34–12:34:41 UTC):* dopo **23** richieste in 7 s a `/api/iscrizione/sedi`
  (e 31 a `/api/health` nei 20 s prima) Vercel ha risposto **403** con `x-vercel-mitigated: challenge`
  e `x-vercel-id` solo `fra1` (la funzione non è stata chiamata); alle 12:41:34 la sfida era ancora
  attiva. Il progetto **non ha** una configurazione firewall propria (API: «config not found»): è la
  protezione automatica della piattaforma.
- *Causa probabile:* una chiamata `fetch` dell'app non può risolvere una sfida; se molte famiglie
  escono dallo stesso indirizzo (rete della scuola) la sfida le bloccherebbe tutte. Non è stato
  osservato su utenti veri.
- *Osservato:* `/api/iscrizione/sedi` arriva al client con `cache-control: public, max-age=600`,
  `vary: Cookie`, nessun `set-cookie`, e `x-vercel-cache` **MISS 23/23** (12:34) e ancora **MISS 2/2**
  a 3 s di distanza (13:19:11–13:19:14 UTC, `age: 0`). La CDN di Vercel non la tiene.
- *Osservato (codice):* il codice **manda già** `s-maxage=600, stale-while-revalidate=…` sulla strada
  senza cookie di sessione (`src/lib/security/cache-pubblica.ts:33`, chiamato da
  `src/app/api/iscrizione/sedi/route.ts:63`, arrivato con la PR #250 e in produzione da stamattina).
  Che il client non veda né `s-maxage` né `stale-while-revalidate` è coerente con Vercel che li
  consuma e li toglie dalla risposta finale **[S8b]**: *la mia prima lettura («manca `s-maxage`») era
  sbagliata*.
- *Causa del MISS: non determinata.* Candidati da verificare uno alla volta: `Vary: Cookie` nella
  chiave di cache, un'intestazione aggiunta dal middleware, la regola di cache della piattaforma per
  le Function. Una misura in più non basta: serve una prova su un'anteprima.

**Soluzioni**
- **A ✅ Capire perché la CDN non tiene la risposta, poi correggere.** *Cosa significa:* su un
  deploy di anteprima provare in ordine (1) `Vercel-CDN-Cache-Control: s-maxage=600` accanto a
  `Cache-Control`, (2) `Vary` senza `Cookie` sulla strada pubblica (che già esclude chi ha un
  cookie di sessione), guardando `x-vercel-cache` alla seconda richiesta. *Cosa fa:* meno funzioni
  e letture del DB per ogni visita al modulo d'iscrizione. *Costo:* minimo. *Come si torna
  indietro:* revert. **[S8b]**
- **B Regola di bypass per i percorsi dell'app nativa.** *Cosa significa:* una regola firewall che
  non sfida le chiamate API autenticate. *Costo:* basso, ma va provata con cura: si tocca la
  protezione. **[S8a]**
- **C Non fare niente oltre A** finché non si vede una sfida a un utente vero (cercare `403` con
  `challenge` nei log di Vercel una volta al mese).

#### S9 🟡 Fornitori senza tetto e route lunghe senza dichiarazione

**Prove**
- *Osservato (codice):* la traduzione della chat usa l'SDK di Anthropic senza `timeout` né
  `maxRetries` e fuori da `externalFetch` (`src/lib/translate/claude.ts:38-45`).
- *Osservato (codice):* 17 route potenzialmente lunghe senza `maxDuration` (PDF credenziali,
  registro presenze, export, pagelle, `gdpr/erase`, `sidi/import`, `chat/translate`…). Oggi le copre
  il predefinito della piattaforma.
- *Osservato (codice):* `src/app/api/news/cron/run/route.ts:294` confronta il segreto dei cron con
  `!==` invece che con `segretoCronValido` (confronto a tempo costante), unica eccezione.

**Soluzioni**
- **A ✅** `timeout` e `maxRetries` espliciti nell'SDK + riga di log come `externalFetch`;
  `maxDuration` dichiarato nelle 17 route; `segretoCronValido` anche nelle news. *Costo:* basso.
  **[S9a] [S9b]**

#### S10 🟡 Errori del database mostrati fuori, e pochi silenzi residui

**Prove**
- *Osservato (codice):* **184** righe in **101** file restituiscono al client `error.message` di
  PostgREST; **3** sono su route **pubbliche** (`src/app/api/iscrizione/route.ts:390,399`,
  `src/app/api/iscrizione/sedi/route.ts:55`, `src/app/api/forms/submit/route.ts:116`): un anonimo
  può leggere nomi di tabelle, colonne e vincoli.
- *Osservato (codice):* catch muto attorno alla notifica della firma di una nota
  (`src/app/api/notes/route.ts:146-155`); 8 letture di URL firmate dello Storage senza guardare
  `error` (es. `src/app/api/parent/competenze/route.ts:47`).
- *Attenuante osservata:* il `fetch` strumentato dei client Supabase registra comunque ogni errore
  4xx in `app_log` (`src/lib/logging/supabase-fetch.ts:654-680`).

**Soluzioni**
- **A ✅** Sulle route pubbliche un messaggio generico + codice d'errore (il dettaglio resta nel
  log); un lucchetto che vieta `error.message` nelle risposte delle route pubbliche; log nel catch
  delle note. *Costo:* basso.

#### S11 🟡 Login e limiti di frequenza

**Prove**
- *Osservato (codice):* il login chiama Auth direttamente dal browser
  (`src/app/auth/login/page.tsx:679`): il server dell'app non vede né frena i tentativi; i limiti di
  Auth in produzione **non sono versionati** (`supabase/config.toml:195-207` vale solo in locale).
- *Osservato (codice):* il limite di frequenza delle route pubbliche scrive sul DB a ogni chiamata e,
  se il DB tarda più di 1 s, ripiega su un contatore **per istanza**
  (`src/lib/security/rate-limit.ts:155,385-395`).

**Soluzioni**
- **A ✅ Annotare i limiti di Auth.** *Cosa significa:* rileggere una volta dal pannello i limiti
  di Auth di produzione e scriverli nel runbook. *Cosa fa:* chi indaga un blocco di login sa che
  soglia c'è. *Costo:* nullo. **[S11a]**
- **B CAPTCHA invisibile al login (Cloudflare Turnstile).** *Cosa significa:* Supabase Auth
  accetta il login solo con un gettone che il browser ottiene da Turnstile, quasi sempre senza far
  fare niente all'utente. *Cosa fa:* ferma i tentativi automatici di indovinare le password.
  *Costo:* gratis (l'account Cloudflare c'è già), ma tocca il login di tutte le famiglie e
  dell'app nativa: va provato su un'anteprima. *Indietro:* si spegne dal pannello Auth.
  Decisione del titolare (T9 nella §3). **[S11b]**
- **C Login da una route del server, con limite per IP e per email.** ❌ sconsigliata: Auth
  limita già per indirizzo vero del browser; passando dal server tutte le famiglie avrebbero
  l'indirizzo di Vercel e il limite di Auth diventerebbe inutile.

#### S12 🟡 Log corti, build fragile, una sola regione

**Prove**
- *Osservato (documenti e codice):* i log di Vercel durano 1 giorno e non c'è un «drain»;
  `app_log` tiene 30 giorni e solo warn/error più una lista di eventi. La build locale va in OOM
  con l'heap predefinito (in CI si usano 6 GB). Funzioni a `dub1` e database a `eu-west-1`: una sola
  regione, nessun piano B (scelta accettata).

**Soluzioni**
- **A ✅** Nessun lavoro ora; un drain dei log solo se un incidente vero lo richiede. **[S12a]**

### DATABASE

#### D1 🔴 La produzione è l'unico database, e chi ha la chiave di servizio può tutto

**Prove**
- *Osservato (configurazione del repo):* non esiste un database di sviluppo; il server locale `:3100`
  e gli agenti lavorano sulla produzione (`CLAUDE.md`, `docs/env.md:34,101`); dal 18/09 le sessioni
  partono senza chiedere conferma, anche per le scritture sul database di produzione e le
  migrazioni (`AGENTS.md`, `CLAUDE.md`, «Permessi»).
- *Osservato (DB, 12:52 UTC):* `public.exec_sql(text)` **esiste**, è `SECURITY DEFINER`, ha come
  proprietario `postgres` ed è eseguibile da `service_role`
  (`supabase/migrations/20260704120000_baseline.sql:272-282`, mai rimossa). Le route che la usavano
  sono sigillate (`src/lib/security/seal.ts:41-47`), ma la funzione resta raggiungibile con
  `POST /rest/v1/rpc/exec_sql`.
- *Osservato (codice):* le protezioni dei registri (WORM) e della scatola nera si spengono con un
  parametro di sessione (`registri.manutenzione`, `scatola_nera.manutenzione`,
  `scatola_nera.senza_storico`): oggi le accendono solo 3 funzioni interne (verificato su `pg_proc`),
  ma chiunque esegua SQL con `exec_sql` può accenderle.
- *Effetto:* un errore di un agente o una chiave di servizio uscita dal suo posto possono cancellare
  o riscrivere dati **senza lasciare copia**; il recupero è il backup di Supabase (fino a ~24 h fa).

**Soluzioni**
- **A ✅ Togliere `exec_sql`.** *Cosa significa:* una migrazione di una riga (`DROP FUNCTION`), dopo
  aver controllato che nessun codice la chiami (oggi solo route sigillate). *Costo:* minimo.
  *Indietro:* la definizione è nel baseline. **[D1b]**
- **B ✅ Un database di sviluppo vero (decisione del titolare).** *Cosa significa:* un secondo
  progetto Supabase (o un «branch») con dati finti, su cui puntano il server locale e gli agenti;
  la produzione si tocca solo da GitHub. *Costo:* ~10 $/mese per un progetto piccolo (la CI ne ha
  già uno). *Indietro:* si ripunta `.env.local`. **[D1a]**
- **C Conferma umana sulle scritture in produzione (decisione del titolare).** *Cosa significa:* gli
  agenti possono leggere la produzione senza chiedere, ma ogni scrittura (SQL che non è `SELECT`,
  migrazioni) torna a chiedere conferma; l'MCP di Supabase in modalità sola lettura per le sessioni
  normali. *Costo:* qualche conferma in più. *Indietro:* si riaccende l'autonomia.

#### D2 🔴 Niente ripristino al minuto: si può perdere fino a un giorno

**Prove**
- *Osservato (CLI Supabase, 20/10 12:38 UTC):* `pitr_enabled: false`; 8 backup fisici giornalieri
  (13/10 → 20/10, ~00:55 UTC), tutti `COMPLETED`. Il dump cifrato su R2 oggi parte fra le 07 e le
  09:30 UTC (S4).
- *Effetto:* un errore scoperto alle 16:00 si ripara tornando al backup delle 00:55: si perdono le
  presenze, il diario, le firme e gli incassi della giornata, salvo le tabelle coperte dalla scatola
  nera.

**Soluzioni**
- **A ✅ Attivare il PITR (decisione del titolare).** *Cosa significa:* Supabase conserva il registro
  di ogni modifica e permette di tornare a un minuto qualunque degli ultimi 7 giorni. L'istanza
  attuale (Small) è quella minima richiesta. *Costo:* componente aggiuntivo a pagamento, **~100 $/mese** per 7 giorni
  (200 per 14, 400 per 28); perdita massima **2 minuti**; con il PITR i backup giornalieri non
  vengono più presi. *Indietro:* si spegne dal pannello. **[D2a]**
- **B Dump più frequenti.** *Cosa significa:* il dump cifrato su R2 ogni 6 ore invece che ogni notte.
  *Cosa fa:* perdita massima 6 ore. *Costo:* basso (minuti di GitHub, spazio R2), ma pesa sul DB
  quattro volte al giorno. *Indietro:* si torna a uno.
- **C Accettare il rischio** e allargare la scatola nera (D4) alle tabelle della giornata (presenze,
  diario, firme): copre gli errori puntuali, non un guasto del database.

#### D3 🔴 13,2 GB di foto e video dei bambini senza nessuna copia

**Prove**
- *Osservato (DB, 12:52 UTC):* bucket `gallery` **6.606** oggetti, **10,7 GB**; `video_originals`
  **81** oggetti, **2,4 GB**: il **66 %** dei 20 GB di Storage.
- *Osservato (codice):* `.github/workflows/backup-notturno.yml:87` esclude proprio questi due bucket
  (`ESCLUDI_BUCKET: gallery video_originals`), per scelta scritta del titolare del 06/10; i backup
  del database **non** contengono i file dello Storage; resta il cestino applicativo di 30 giorni.
- *Effetto:* un bucket cancellato per errore, un bug della retention della galleria o la perdita del
  progetto = foto e video persi per sempre.

**Soluzioni**
- **A ✅ Copia della galleria su R2 (decisione del titolare).** *Cosa significa:* togliere i due bucket
  dall'esclusione; lo specchio già esistente li copia su R2 cifrati. *Costo:* R2 costa 0,015 $/GB-mese
  oltre i 10 GB gratuiti: 13 GB in più sono circa **0,2 $/mese**; la prima copia richiede tempo.
  *Indietro:* si rimette l'esclusione. **[D3a] [D3b]**
- **B Copia dei soli originali video.** Costa meno, protegge meno.
- **C Restare così** e scriverlo alle famiglie nell'informativa.

#### D4 🔴 Cancellare un utente o un alunno trascina via decine di tabelle senza copia

**Prove**
- *Osservato (DB, 12:39 UTC):* 299 chiavi esterne, **101** con `ON DELETE CASCADE`.
  - cancellare un **utente** trascina **12** tabelle (`chat_messages`, `chat_threads`, `avvisi`,
    `avvisi_risposte`, `notifiche`, `anagrafica_personale`…): **nessuna** ha la scatola nera;
  - cancellare un **alunno** ne trascina **19**, di cui **12** senza scatola nera
    (`alunni_classi_storico`, `fascicolo_accessi_audit` — un registro degli accessi —,
    `storici_collegamenti`, `storici_revisioni`, `nota_ricezioni`, `registro_destinatari`…);
  - cancellare una **sede** ne trascina **25** (4 con scatola nera); `auth.users` → `utenti` è in
    cascata: cancellare un account dal pannello Auth porta via tutto il resto.
- *Osservato (codice):* una docente che cancella un proprio avviso cancella anche le **risposte dei
  genitori** (adesioni, autorizzazioni) per cascata (`src/app/api/avvisi/[id]/route.ts:793-832`;
  baseline `:5128`); la scatola nera delle **modifiche** copre 13 tabelle e non `alunni`, `parents`,
  `utenti`, `note_disciplinari`, `certificati_medici`
  (`supabase/migrations/20261019215733_scatola_nera_modifiche.sql:148-155`).
- *Osservato:* la scatola nera c'è già sulle tabelle principali (`schools`, `utenti`, `alunni`,
  `parents`, `sections`, `presenze`, `pagamenti`, `incassi`, `student_parents`) e vieta il `TRUNCATE`.

**Soluzioni**
- **A ✅ Scatola nera sulle figlie che contano.** *Cosa significa:* aggiungere il trigger che già
  esiste alle tabelle figlie con valore legale o umano (risposte agli avvisi, messaggi della chat,
  storico classi, registro accessi, ricevute delle note, anagrafica del personale) e la copia delle
  modifiche ad `alunni`, `parents`, `utenti`. *Costo:* una migrazione; un po' di spazio (90 giorni).
  *Indietro:* `DROP TRIGGER`. 
- **B ✅ Freni (`RESTRICT`) dove la cascata non deve esistere.** *Cosa significa:* un avviso con
  risposte non si cancella: si archivia; un utente con messaggi non si cancella dal pannello Auth.
  *Costo:* medio (le route di cancellazione devono gestire il rifiuto). *Indietro:* migrazione
  inversa. **[D4a]**
- **C Cancellazione logica ovunque** (`eliminato_il` invece del `DELETE`). Costo alto. Non ora.

#### D5 🟠 Il ripristino completo non è mai stato provato, e la ricetta ha un passo sbagliato

**Prove**
- *Osservato (documenti):* `docs/runbook-ripristino.md:210-212` dice che la procedura è stata
  «provata a pezzi, non dall'inizio alla fine»; mancano i file e l'app; la prova va ripetuta ogni 3
  mesi (`:247`) ma nessun promemoria la ricorda.
- *Osservato (codice):* il dump non contiene lo schema `vault` né le impostazioni dei cron
  (`scripts/backup/dump-cifrato.sh:66`); il runbook dice di rimetterle con `ALTER DATABASE … SET`,
  che su questo progetto è **negato** (errore 42501,
  `supabase/migrations/20260712220000_cron_config_vault.sql:4-14`); le sei chiavi del Vault usate dai
  cron non sono elencate da nessuna parte. Impostazioni di Auth e Storage di produzione non sono
  versionate; il bucket `registro-allegati` non è dichiarato in nessuna migrazione.
- *Effetto:* se si perde il progetto, ~25 funzioni dei cron trovano l'indirizzo vuoto ed escono in
  silenzio, e chi segue il runbook prende un errore di permesso.

**Soluzioni**
- **A ✅** Correggere il runbook (Vault, non `ALTER DATABASE`), elencare i nomi delle chiavi del
  Vault (non i valori), dichiarare il bucket mancante in una migrazione, e fare **una** prova
  completa su un progetto usa e getta (database + file + app puntata). *Costo:* mezza giornata + un
  progetto temporaneo. **[D5a]**
- **B** Promemoria trimestrale automatico (una segnalazione aperta dal campanello).

#### D6 🟠 Registro di protocollo: eliminare e rettificare non lascia traccia

**Prove**
- *Osservato (codice):* l'eliminazione passa da una RPC ammessa dal WORM, ma «nessun logScrittura,
  nessuna traccia tecnica» (`src/app/api/admin/protocolli/route.ts:443-470`); la rettifica
  **sovrascrive** il file (`upsert: true`) senza traccia (`src/app/api/admin/protocolli/rettifica/route.ts:179-239`);
  `protocolli` è fuori dalla scatola nera. Sono **decisioni scritte del titolare** (#6, #26).
- *Effetto:* una registrazione eliminata per errore si recupera solo dal dump della notte, e nessun
  log dice quale fosse.

**Soluzioni**
- **A ✅** Tenere la decisione ma mettere `protocolli` e `protocolli_allegati` nella scatola nera
  (copia per 90 giorni, nessun log applicativo) e versionare il file rettificato invece di
  sovrascriverlo. *Costo:* basso. *Decisione del titolare.*

#### D7 🟠 Operazioni a più passi che, se si fermano a metà, perdono qualcosa

**Prove** (tutte *osservate nel codice*)
- Eliminazione del personale: il fascicolo (file e righe) si cancella **prima** dei passi che possono
  fallire (`src/app/api/admin/staff/eliminazione/route.ts:440-468`): se poi fallisce la revoca o la
  cancellazione dell'account, la persona resta senza fascicolo.
- Riapertura dello scrutinio: cancella le pagelle già consegnate alle famiglie, righe e PDF
  (`src/app/api/primaria/scrutinio/riapri/route.ts:185-194`); i PDF tornano solo dal cestino R2
  (30 giorni).
- Modifica di una nota: cancella le prese visione dei genitori (`src/app/api/primaria/note/route.ts:636`),
  e `nota_ricezioni` è fuori dalla scatola nera.
- Compensazioni non atomiche: ordini merchandise (`src/app/api/admin/merch/ordini/route.ts:189-198`),
  doppio insert delle sedi (`src/app/api/admin/schools/route.ts:327`), ultimo passo dell'import
  iscrizioni (`src/app/api/admin/iscrizioni/route.ts:2148`).

**Soluzioni**
- **A ✅** Spostare questi percorsi in **una funzione SQL** che fa tutto in una transazione (o tutto,
  o niente), e cancellare i file **dopo** che il database ha confermato. *Costo:* medio, uno per
  volta. **[D12a]**
- **B** Riapertura dello scrutinio che **archivia** le pagelle invece di cancellarle.

#### D8 🟠 Chiavi che aprono tutto

**Prove**
- *Osservato (file system, solo esistenza):* la copia di lavoro delle chiavi per decifrare i backup
  sta dentro la cartella dell'app (`KIDVILLE-CHIAVI-BACKUP/`, esclusa da git; `docs/runbook-ripristino.md:47-48`),
  cioè dove lavorano agenti autonomi.
- *Osservato (documenti):* la chiave S3 del backup ha pieni poteri su tutto lo Storage
  (`docs/cicd.md:108`: «non esistono chiavi di sola lettura»).
- *Da verificare (memoria del progetto):* una vecchia chiave `sb_secret_` di produzione è nella
  storia git del clone Paperclip, «revoca da confermare».

**Soluzioni**
- **A ✅** Spostare la copia di lavoro delle chiavi fuori dalla cartella dell'app (es. nel
  Portachiavi o su un disco esterno); verificare nel pannello Supabase che la vecchia `sb_secret_`
  sia revocata. *Costo:* nullo. *Decisione/azione del titolare.* **[D8a]**

#### D9 🟠 La conservazione delle iscrizioni può togliere documenti ancora usati (latente)

**Prove**
- *Osservato (codice):* dopo 24 mesi la retention cancella le domande `pending`/`rejected` e i loro
  file (`src/app/api/gdpr/retention-iscrizioni/route.ts:161-344`) senza guardare se la domanda è
  stata importata; l'import copia lo stesso percorso del documento nelle anagrafiche
  (`src/app/api/admin/iscrizioni/route.ts:1532,1841`); il rifiuto non controlla lo stato precedente
  (`:879-883`).
- *Osservato (DB, 12:52 UTC):* oggi **0** domande importate sono in stato `pending` o `rejected`
  (700 approvate e importate, 31 respinte, 2 in attesa): il caso è **latente**.

**Soluzioni**
- **A ✅** La retention salta le domande con `imported_at` e i file ancora citati da `parents`/`alunni`
  (come già fanno `src/lib/gdpr/esegui.ts:2400` e `src/lib/alunni/elimina-definitivo.ts:530`); il
  rifiuto vale solo da `pending`. *Costo:* basso.

#### D10 🟡 Migrazioni direttamente in produzione

**Prove**
- *Osservato:* l'integrazione GitHub di Supabase applica le migrazioni al merge (`docs/cicd.md:7-9`),
  prima di qualunque prova su uno schema identico; se fallisce, nessun allarme dedicato (il codice
  nuovo degrada in silenzio). `.claude/commands/ship-cycle.md:348-350` dice ancora di riapplicarle a
  mano con `apply_migration` dopo il merge (rischio di doppia applicazione).
- *Osservato (DB):* oggi 231 migrazioni registrate, 0 doppie.

**Soluzioni**
- **A ✅** Correggere `ship-cycle.md`; un controllo in salute che confronta l'ultima migrazione del
  repo con l'ultima applicata. **[D10a]** **B** Un database di prova con lo schema di produzione
  (lo stesso di D1-B).

#### D11 🟡 Vincoli e igiene

**Prove** (osservato)
- `enrollment_submissions.status` e `alunni.stato` senza `CHECK` (la retention e gli stati «non più
  iscritto» dipendono dal testo esatto); oggi i valori sono puliti (3 stati e 2 stati).
- L'audit di chi scrive voti e note non blocca la scrittura se fallisce (`src/lib/audit/scrittura.ts:109-134`).
- `cron.job_run_details`: **93.577** righe dal 07/06, 17 MB, mai svuotata.
- `idle_in_transaction_session_timeout` = 0: una transazione lasciata aperta tiene i lock per sempre.
- Advisor: 2 WARN di sicurezza (`pg_net` nello schema `public`; `current_parent_student_ids`
  `SECURITY DEFINER` eseguibile da `authenticated`), 5 WARN di prestazioni (policy permissive
  multiple), 137 indici mai usati.

**Soluzioni**
- **A ✅** `CHECK … NOT VALID` + `VALIDATE`; un job che tiene 14 giorni di `job_run_details`
  (dopo che l'esito di ogni job è conservato altrove: sessione 6 della specifica);
  `idle_in_transaction_session_timeout` a 60 s con `ALTER ROLE` sui ruoli dell'API (`ALTER
  DATABASE` qui dà 42501). *Costo:* basso. **[D11a]**
- **I 2 WARN di sicurezza e i 137 indici si lasciano**, con il motivo scritto: `pg_net` ha i suoi
  oggetti nello schema `net` e ricrearlo perderebbe le richieste in volo dei cron;
  `current_parent_student_ids` è chiamata da **16** righe del baseline, fra cui le policy con cui i
  genitori leggono i figli (`20260704120000_baseline.sql:6845,6852`), e toglierla ad
  `authenticated` spegnerebbe l'app dei genitori; molti indici «mai usati» servono alle
  cancellazioni in cascata e ai freni `RESTRICT`, che sono rare ma senza indice leggono la tabella
  intera.

#### D12 🟡 Concorrenza residua

**Prove** (osservato nel codice)
- Lezione del registro: una cofirma che arriva mentre la lezione viene cancellata va persa (corsa
  dichiarata, `src/app/api/primaria/registro/route.ts:1339-1524`).
- Promemoria: deduplica letta e poi inserita (`src/app/api/notifiche/promemoria/route.ts:224-233,355-358`).
- Sincronizzazione fatture senza lock di sovrapposizione (`src/app/api/pagamenti/fattura/sync/route.ts:97-111`).

**Soluzioni**
- **A ✅** Indice unico sulla deduplica dei promemoria; `pg_advisory_xact_lock` sul giro di sync;
  la corsa del registro resta accettata. **[D12a]**

---

## 3. La roadmap in sessioni

> **Riscritta il 20/10 come specifica.** Dopo il confronto della Parte 4 e le dodici decisioni del
> titolare, la roadmap è passata nel formato superpowers:
> `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` (decisioni, ordine, regole
> comuni, dettaglio di ogni sessione, «Cosa NON fare», tabella di stato) e un piano per sessione in
> `docs/superpowers/plans/2026-10-20-robustezza2-sNN-<nome>.md`. **Lo stato si segue lì, non qui.**

**Ordine.** 1 iscrizioni (entro il 31/10) · 2 `exec_sql` e freno sulle istruzioni distruttive ·
3 scatola nera · 4 backup e allarme · 5 prova di ripristino · 6 esiti dei cron · 7 salute completa ·
8 cron e igiene · 9 email e fornitori · 10 operazioni a più passi (entro metà dicembre) · 11 letture a
blocchi · 12 chat leggera · 13 bordo pubblico · 14 identità, solo sopra una soglia misurata.

**Decisioni (T1–T12).** Niente ripristino al minuto e niente galleria nel backup per ora, come rischi
accettati con una soglia per ridecidere; freno sulle istruzioni distruttive degli agenti; copia
silenziosa del protocollo; firewall prima in «log»; CAPTCHA rinviato. Le opzioni e i costi
presentati al titolare restano nella storia del ramo (commit `e85253c0`).

**Numeri vecchi.** La §2 e la Parte 4 citano le sessioni con la numerazione della prima stesura:
5 → 6, 6 → 7, 7 → 8, 8 → 9, 9 → 10, 10 → 11, 11 → 14, 14 → 5; le altre non cambiano.

---

## 4. Fotografia di oggi — martedì 20/10/2026

Tutte le misure sono state prese in **sola lettura** il 20/10/2026 (martedì, giorno feriale), fra le 12:32 e le 12:42 UTC, salvo dove indicato. «24 h» = da lunedì 19/10 12:30 UTC a martedì 20/10 12:30 UTC (due giorni feriali). Percentili delle 30 richieste: metodo *nearest rank*.

⚠️ **Tre cose da sapere prima di leggere i numeri**
- Oggi ci sono stati **tre deploy di produzione** (≈07:53, ≈09:51 e 12:14 UTC): la finestra di 24 h contiene tre versioni del codice, e la finestra di punta di oggi (07:55–08:05) cade **due minuti dopo** un deploy (avvii a freddo).
- Il **backup notturno** di GitHub è partito alle 07:47 e finito alle 07:56 UTC oggi, alle 07:56–08:03 ieri: in entrambi i giorni **si sovrappone alla finestra di punta**. Per questo la punta è misurata anche lunedì 19/10.
- Durante la misura 6 la protezione automatica di Vercel ha cominciato a rispondere **403 con sfida** al Mac che misurava (dalla 24ª richiesta): è un risultato a sé, vedi S8

| # | Misura | Valore | Giorno · ora UTC · finestra | Come si rimisura |
|---|---|---|---|---|
| 1 | Regione delle funzioni | **dub1** (Dublino). `x-vercel-id: fra1::dub1::…` (ingresso a Francoforte, funzione a Dublino). Deployment `dpl_5sJaxos9WH5sXE7Rs6dFRjhHnYYr` (commit `4c6df438`) → `regions: ["dub1"]`; `functions`: solo `src/app/api/video-uploads/**` → dub1; `crons: []` | 20/10 12:34:11 | `curl -sI https://app.kidville.it/api/health \| grep -i x-vercel-id`; `vercel api "/v13/deployments/<id>?teamId=<team>"` |
| 2a | Server→DB, 24 h feriali | DUB **1.301.232** richieste, p50 **10 ms**, p95 **127 ms**; FRA 4.011 (tutte `POST /auth/v1/token`), p50 96, p95 145; altri colo: 1 richiesta ciascuno | 19/10 12:30 → 20/10 12:30 | query 2 bis su `query_logs` con quella finestra |
| 2b | Server→DB, punta | oggi: DUB 17.711, p50 11, p95 **232**; FRA 44 (p50 98). Lunedì: DUB 17.656, p50 11, p95 **315**; FRA 28 (p50 94) | 20/10 e 19/10, 07:55–08:05 | query 2 bis, finestra di 10' |
| 2c | Server→DB, calma | DUB 24.815, p50 9, p95 **33**; FRA 59 (p50 88) | 20/10 11:10–11:20 | query 2 bis, finestra di 10' |
| 3 | Tutto il traffico verso Supabase per colo | DUB 1.301.468 (10/127); LAX 16.482 (157/207 — copia dello Storage via S3); MXP 9.700 (154/321); FRA 6.927 (53/135); FCO 6.046 (182/355); IAD 76; CMH 48; CDG 30; SJC 22; LHR 18 | 24 h come sopra | query 2 |
| 4 | `/auth/v1/user` dal server | **146.787** chiamate, tutte da DUB, p50 10, p95 201 | 24 h come sopra | query 2 bis + filtro sul path |
| 5 | `/api/health` | `200`, `stato: ok`, `ms: 177`, 9 controlli tutti ok (db-lettura, auth, schema-atteso «5 tabelle», cron-battito «17 job», tasso-errore «2 impronte, ≤2 occorrenze», config «7 variabili», coda-fatture «0 in attesa», code-arretrate, regione dub1). 30 richieste: min **172**, p50 **346**, p95 **434**, max **435** ms | 20/10 12:34:12; serie 12:34:23–12:34:34 | `curl -s …/api/health`; poi 30 × `curl -w '%{time_starttransfer}'` |
| 6 | `/api/iscrizione/sedi` | 23 × `200` poi **7 × `403`** (`x-vercel-mitigated: challenge`, solo `fra1`). Sui 23 riusciti: min 197, p50 **229**, p95 346, max 431 ms; sulle 30: min 90, p50 218, p95 346, max 431. `x-vercel-cache`: **MISS 23/23**; `cache-control: public, max-age=600` visto dal client (il codice manda anche `s-maxage`, che Vercel consuma: vedi S8). Ripetuta alle 13:19: MISS 2/2, `age: 0`, `vary: Cookie`, nessun `set-cookie` | 20/10 12:34:34–12:34:41 e 13:19:11–13:19:14 | 30 × `curl -D -` come sopra |
| 7 | Timeout · Failed to fetch · realtime, per giorno | vedi tabella sotto | 06/10 → 20/10 (20/10 parziale, 12:36) | query 3 |
| 8 | Tempo DB per istruzione e Realtime | Prima voce: la lettura del WAL di Realtime, **49.710,7 s**, 7.416.584 chiamate, 6,7 ms → **79,9 %** del tempo DB **cumulato dal 06/08** (`stats_reset` 2026-08-06 16:51). `realtime.subscription` = **0**; la pubblicazione `supabase_realtime` esiste e ha **0 tabelle**. **Rilettura alle 12:43:27:** la lettura del WAL ha fatto **0** chiamate nuove in 6'19" — il 79,9 % è storico; tutte le istruzioni insieme hanno aggiunto **5,5 s** di tempo DB in 6'10" (≈ **1,5 %** di un core). Le altre voci della top 10: risposte JSON di PostgREST 2.034 s (647.832 chiamate), `set_config` di ogni richiesta 956,9 s (36,9 milioni), elenco dello Storage 730 s, `notifiche_dispatch_tick` 479 s (22,2 ms), lettura `notifiche` 422 s, `news_tick` 336,6 s (31,2 ms), `pg_timezone_names` 326 s (74,3 ms), utenti di Auth 280 s, tipi di dominio 277 s (63,1 ms) | 20/10 12:37:08 e 12:43:27 | query 1; `SELECT count(*) FROM realtime.subscription;` |
| 9 | Backup | Supabase: **8** backup fisici giornalieri (13/10 → 20/10, ~00:55 UTC), tutti `COMPLETED`; **PITR: no**. GitHub `backup-notturno` (DB + file → R2): ultime 7 notti **success**, ma partite fra le **07:04 e le 09:35** UTC invece che alle 02:23 | 20/10 12:38 | `supabase backups list --project-ref uimulkjyekgemjakmepp`; `gh run list --workflow=375883624` |
| 10 | Istanza | **Small**: 2 core ARM condivisi, **2 GB** di RAM, 90 connessioni dirette, 400 dal pooler, IO base 174 MB/s; Postgres 17.6.1.111, `ACTIVE_HEALTHY`. RAM/swap/CPU **usati: non misurato** | 20/10 12:39 | API di gestione `GET /v1/projects/{ref}/billing/addons`; grafici: pannello Supabase → *Observability → Database* («Memory usage», «Swap usage», «CPU usage», «Disk IO budget») |
| 11 | Dimensioni | DB **491 MB**; Storage **20 GB** in 13.597 oggetti | 20/10 12:36:59 | query 4 |
| 12 | Cron | **30** job attivi (31, `news-digest` spento); 7 giorni: **16.032** esecuzioni, **0** non riuscite. Ma `net._http_response` (ultime ~6 h): **647 × 200** e **27 senza risposta** «Timeout of 5000 ms reached» | 20/10 12:35 | le due SELECT della richiesta; più `SELECT status_code, count(*) FROM net._http_response GROUP BY 1` |
| 13 | Domande d'iscrizione | **733** | 20/10 12:32:54 | `SELECT count(*) FROM enrollment_submissions;` |
| 14 | Advisor | security: **0** ERROR, **2** WARN, **68** INFO; performance: **0** ERROR, **5** WARN, **137** INFO | 20/10 12:38 | `get_advisors` security e performance |

**Misura 7 — query 3, per giorno** (`app_log`, 20/10 alle 12:36 UTC; il 20/10 è parziale). In più,
fuori dalla query della richiesta e quindi non confrontabile: «Load failed», il gemello di «Failed to
fetch» su iPhone. I tre messaggi esistono ancora con quel testo nel codice
(`src/lib/logging/supabase-fetch.ts:547`, `src/lib/hooks/use-polling-visibile.ts:45`,
`src/components/features/chat/useChatRealtime.ts:306`): gli zeri sono veri zeri.

| Giorno | | timeout Supabase | Failed to fetch | errori realtime | *(Load failed)* |
|---|---|---|---|---|---|
| 06/10 | mar | 3 | 471 | 252 | 46 |
| 07/10 | mer | 13 | 328 | 374 | 115 |
| 08/10 | gio | — | 191 | 441 | 106 |
| 09/10 | ven | — | 49 | 81 | 22 |
| 10/10 | sab | — | 31 | 29 | 3 |
| 11/10 | dom | — | 10 | 8 | 11 |
| 12/10 | lun | 1 | 257 | 314 | 129 |
| 13/10 | mar | — | 78 | 335 | 49 |
| 14/10 | mer | — | 63 | 378 | 60 |
| 15/10 | gio | — | 90 | 320 | 47 |
| 16/10 | ven | 1 | 58 | 288 | 61 |
| 17/10 | sab | — | 11 | 40 | — |
| 18/10 | dom | — | 18 | 18 | 7 |
| 19/10 | lun | 1 | 57 | 346 | 95 |
| 20/10 | mar | — | 41 | 182 | 79 |

Nei fine settimana (10–11 e 17–18/10) i numeri crollano: gli errori seguono l'uso, non un guasto. Gli errori realtime sono quasi tutti di trasporto (in 7 giorni: `trasporto` 1.300, `socket-chiuso-1006` 544, `socket-chiuso-1000` 41, `altro-Error` 19, `socket-chiuso-1005` 3).

---

## 5. Fonti

### 5.1 Documentazione ufficiale (consultata il 20/10/2026)

Ogni riga è stata aperta e letta; dove la documentazione **non** conferma, è scritto.

| Codice | Fonte | Cosa conferma |
|---|---|---|
| S1a | [Supabase — pg_net](https://supabase.com/docs/guides/database/extensions/pg_net) | `net.http_post` è asincrona: parte dopo il commit e restituisce solo un id; le risposte restano in `net._http_response` per **6 ore**. La pagina indica un timeout predefinito di 2000 ms, ma **la versione installata in produzione ha 5000 ms** (misurato su `pg_proc`, 20/10): vale la misura. |
| S1b | [Supabase Cron — quickstart](https://supabase.com/docs/guides/cron/quickstart) · [Supabase Cron](https://supabase.com/docs/guides/cron) · [debug di pg_cron](https://supabase.com/docs/guides/troubleshooting/pgcron-debugging-guide-n1KTaz) | `cron.job_run_details` non si svuota da sola (esempio ufficiale: job giornaliero che tiene 7 giorni); al massimo 8 job concorrenti, ciascuno sotto i 10 minuti. **Non confermato** dalla documentazione che «succeeded» voglia dire solo «richiesta accodata»: lo si ricava dal fatto che `net.http_post` è asincrona. |
| S1c | [Supabase Queues](https://supabase.com/docs/guides/queues) · [quickstart](https://supabase.com/docs/guides/queues/quickstart) · [pagina prodotto](https://supabase.com/features/queues) | Code durevoli su pgmq, attivabili dalla Dashboard; la pagina prodotto dice ancora «Public Alpha». |
| S2a | [Resend — Idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys) · [rate limit](https://resend.com/docs/api-reference/rate-limit) · [gestione email](https://resend.com/docs/dashboard/emails/manage-emails) | Stessa chiave per 24 h = nessun doppione; 10 richieste/s per team, oltre 429 con `retry-after`. Resend ritenta da solo **solo la consegna** al server del destinatario (fino a 14 h), **non** gli errori della sua API: il ritentativo tocca a noi. |
| S2b | [Next.js — `after()`](https://nextjs.org/docs/app/api-reference/functions/after) · [Vercel Queues](https://vercel.com/docs/queues) | `after()` vive fino al `maxDuration` della route; Vercel Queues è in **Beta**. |
| S3a | [supabase-js — `getClaims`](https://supabase.com/docs/reference/javascript/auth-getclaims) · [Auth lato server in Next.js](https://supabase.com/docs/guides/auth/server-side/nextjs) · [chiavi di firma](https://supabase.com/docs/guides/auth/signing-keys) | `getClaims` verifica il token in locale con le chiavi pubbliche (JWKS in cache) se le chiavi sono asimmetriche; `getUser` chiama sempre Auth. |
| S3b | [React — `cache`](https://react.dev/reference/react/cache) · [Next.js — fetching data](https://nextjs.org/docs/app/getting-started/fetching-data) · [glossario Next.js](https://nextjs.org/docs/app/glossary) | `cache()` vale solo nei Server Components; i Route Handler sono fuori dall'albero React: lì serve un oggetto per richiesta. |
| S4a | [GitHub — eventi che fanno partire un workflow](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) | `schedule` può slittare nei picchi e i job in coda possono essere scartati; nei repository pubblici i workflow programmati si spengono dopo **60 giorni** senza attività. |
| S4b | [Cloudflare — Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) · [limiti dei Workers](https://developers.cloudflare.com/workers/platform/limits/) | Cron in UTC; 5 cron per account sul piano gratuito; la puntualità **non** è documentata (osservata: 7 giri su 7 regolari oggi). |
| S5a | [PostgREST — paginazione e conteggi](https://docs.postgrest.org/en/stable/references/api/pagination_count.html) | `count=exact` rallenta con la dimensione della tabella; `planned`/`estimated` usano le statistiche. |
| S6a | [supabase — select](https://supabase.com/docs/reference/python/select) · [range](https://supabase.com/docs/reference/javascript/range) | Al massimo 1.000 righe per risposta, si cambia nelle impostazioni API; si pagina con `range()`. Il «taglio silenzioso» non è dichiarato con queste parole: PostgREST dice che può rispondere con meno righe di quelle chieste. |
| S7a | [Realtime — Broadcast](https://supabase.com/docs/guides/realtime/broadcast) · [limiti](https://supabase.com/docs/guides/realtime/limits) · [messaggi Realtime](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages) | `realtime.send` e canali privati con RLS su `realtime.messages`; piano Pro: 500 connessioni concorrenti, 5 milioni di messaggi inclusi. |
| S8a | [Vercel — DDoS mitigation](https://vercel.com/docs/vercel-firewall/ddos-mitigation) · [regole WAF](https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules) · [rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting) · [System Bypass Rules](https://vercel.com/docs/vercel-firewall/vercel-waf/system-bypass-rules) | La mitigazione automatica sfida o blocca il traffico che giudica illegittimo; le regole di bypass (Pro) escludono IP o reti dalle mitigazioni di sistema. Il significato dell'intestazione `x-vercel-mitigated` non è documentato. |
| S8b | [Vercel — CDN cache](https://vercel.com/docs/caching/cdn-cache) | Una Function finisce nella cache di Vercel **solo** con `s-maxage` (o `CDN-Cache-Control` / `Vercel-CDN-Cache-Control`); il proxy di Vercel consuma `stale-while-revalidate` e lo toglie dalla risposta al client; `Vary` vale solo insieme a una direttiva di cache. |
| S9a | [SDK TypeScript di Claude](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript) | Predefiniti: timeout **10 minuti**, 2 ritentativi. |
| S9b | [Vercel — durata delle funzioni](https://vercel.com/docs/functions/configuring-functions/duration) | Pro con Fluid Compute: predefinito 300 s, massimo 800 s. |
| S11a | [Supabase Auth — rate limits](https://supabase.com/docs/guides/auth/rate-limits) | Sign-in 30 ogni 5' per IP, `/token` 150 ogni 5', configurabili dal pannello. |
| S11b | [Supabase Auth — CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha) | Protezione CAPTCHA del login con hCaptcha o Cloudflare Turnstile, accesa dal pannello Auth; il client passa il gettone a `signInWithPassword`. |
| S12a | [Vercel — Runtime Logs](https://vercel.com/docs/logs/runtime) · [Drains](https://vercel.com/docs/drains) | Pro: 1 giorno di log (30 con Observability Plus); drain disponibili sul Pro, 0,50 $/GB. |
| D1a | [Supabase Branching](https://supabase.com/docs/guides/deployment/branching) · [costo dei branch](https://supabase.com/docs/guides/platform/manage-your-usage/branching) · [MCP di Supabase](https://supabase.com/docs/guides/getting-started/mcp) | Un branch è un database separato, senza i dati di produzione; costo a ore (da 0,01344 $/h). L'MCP ha la modalità `read_only=true`. |
| D1b | [PostgreSQL — CREATE FUNCTION](https://www.postgresql.org/docs/current/sql-createfunction.html) · [REVOKE](https://www.postgresql.org/docs/current/sql-revoke.html) · [DROP FUNCTION](https://www.postgresql.org/docs/current/sql-dropfunction.html) | `SECURITY DEFINER` esegue con i privilegi del proprietario; come togliere l'esecuzione o la funzione. |
| D2a | [Supabase — backup](https://supabase.com/docs/guides/platform/backups) · [costo del PITR](https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery) | PITR: componente aggiuntivo, richiede almeno l'istanza Small, perdita massima **2 minuti**; ~**100 $/mese** per 7 giorni (200 per 14, 400 per 28); con il PITR i backup giornalieri non si fanno più. |
| D3a | [Supabase — backup](https://supabase.com/docs/guides/platform/backups) · [Storage, chiavi S3](https://supabase.com/docs/guides/storage/s3/authentication) | I backup del database **non** contengono i file dello Storage; le chiavi S3 hanno accesso completo a tutti i bucket. |
| D3b | [R2 — bucket lock](https://developers.cloudflare.com/r2/buckets/bucket-locks/) · [lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) · [prezzi](https://developers.cloudflare.com/r2/pricing/) | 0,015 $/GB-mese, 10 GB gratuiti, uscita gratuita; i lock impediscono cancellazione e sovrascrittura. |
| D4a | [PostgreSQL — vincoli](https://www.postgresql.org/docs/current/ddl-constraints.html) | `RESTRICT` impedisce di cancellare una riga ancora citata; `CASCADE` cancella anche le righe che la citano. |
| D5a | [Supabase — ripristino su un progetto nuovo](https://supabase.com/docs/guides/platform/clone-project) · [Vault](https://supabase.com/docs/guides/database/vault) | Il ripristino su un progetto nuovo copia dati, ruoli e utenti Auth ma **non** Storage, impostazioni di Auth né chiavi API; i segreti del Vault restano cifrati nei backup. |
| D8a | [Supabase — chiavi API](https://supabase.com/docs/guides/api/api-keys) | Una `sb_secret_…` ha i poteri di `service_role`; si ruota creandone una nuova e cancellando la vecchia. |
| D10a | [Supabase — integrazione GitHub](https://supabase.com/docs/guides/deployment/branching/github-integration) | Con «Deploy to production» le migrazioni si applicano al merge; nessun rollback automatico descritto. |
| D11a | [PostgreSQL — parametri del client](https://www.postgresql.org/docs/current/runtime-config-client.html) · [ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html) | `idle_in_transaction_session_timeout` (0 = spento); `CHECK … NOT VALID` + `VALIDATE` senza bloccare le scritture. |
| D12a | [PostgreSQL — lock espliciti](https://www.postgresql.org/docs/current/explicit-locking.html) · [funzioni di amministrazione](https://www.postgresql.org/docs/current/functions-admin.html) · [SELECT … SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html) | Advisory lock di transazione, `SKIP LOCKED` per le code. |

### 5.2 Fonti di misura (tutte in sola lettura)

- **Database:** MCP Supabase (`execute_sql` con sole `SELECT` sul catalogo e conteggi; `query_logs`
  per le finestre di log; `get_advisors`), progetto `uimulkjyekgemjakmepp`.
- **Backup e istanza:** `supabase backups list` (CLI 2.109.0) e API di gestione
  `GET /v1/projects/{ref}` e `GET /v1/projects/{ref}/billing/addons` (token dal Portachiavi, mai
  stampato).
- **Vercel:** `curl` sul dominio di produzione; `vercel api` (`/v6/deployments`, `/v13/deployments/{id}`);
  API del firewall (nessuna configurazione di progetto).
- **GitHub:** `gh workflow list`, `gh run list` per `backup-notturno` e `campanello`.
- **Codice:** worktree pulito di `origin/main` a `4c6df438`; tre controlli in parallelo (server,
  database, debito noto), poi una revisione d'ordine; i numeri di riga sono stati ricontrollati a
  campione.
- **Letture in più, fuori dalla serie delle 12:32–12:42:** due richieste a `/api/iscrizione/sedi`
  con tutte le intestazioni (13:19:11 e 13:19:14 UTC) per capire il MISS della S8; due `SELECT` sul
  catalogo per la Parte 4 (`pg_get_functiondef` di `registra_transazione_contabile` e conteggio
  delle FK in `public`, 13:26 UTC).

---

## Parte 4 — Confronto con il 05/10

Scritta **dopo** le Parti 1–3. Fonte del 05/10: `docs/roadmap-robustezza.md`, sezioni «Fotografia di
partenza» e «Problemi e soluzioni», più la tabella «Stato delle sessioni» per sapere che cosa è stato
fatto nel frattempo. La Parte 3 non è stata ritoccata dopo questa lettura: quello che il confronto
corregge sta nel §P4.5. Più tardi, il 20/10, la Parte 3 è stata sostituita dalla specifica della
seconda serie, che assorbe il §P4.5 (vedi §3).

### P4.1 Le due fotografie

| Misura | 05/10 | 20/10 | Differenza | Confrontabile? |
|---|---|---|---|---|
| Regione delle funzioni | `iad1` (`fra1::iad1`) | `dub1` (`fra1::dub1`) | Washington → Dublino | **sì**: stesso comando |
| Server→DB, 24 h (query 2 bis) | 1.032.711 richieste, colo IAD 99,5 %, p50 **103 ms**, p95 **129 ms** (finestra fino al 05/10 16:35, in parte domenicale) | 1.301.232, colo DUB, p50 **10 ms**, p95 **127 ms** (19/10 12:30 → 20/10 12:30, due giorni feriali) | p50 **−90 %**; p95 **invariato**; volume +26 % | **sì** per mediana e p95; **in parte** per il volume (la finestra del 05/10 comprendeva la domenica sera) |
| Server→DB, punta 07:55–08:05 | non in fotografia; la riga della sessione 1 dice «il p95 nei picchi di job non è migliorato» | p95 **232 ms** oggi, **315 ms** lunedì | — | **no**: il 05/10 non ha un numero; oggi il backup si sovrappone alla punta |
| `/api/health` | `degraded`, 863 ms (una richiesta); p50 **1,06 s** su 30 (16:35) | `ok`, 177 ms; p50 **346 ms** su 30 | p50 **−67 %**; da `degraded` a `ok` | **sì**: stesso metodo (30 richieste di fila) |
| `/api/iscrizione/sedi` | p50 **0,63 s** | p50 **229 ms** (23 riuscite su 30; 7 sfide `403`) | **−64 %** | **sì**, con la riserva delle 7 sfide |
| Timeout Supabase (query 3) | **230** in 7 giorni | **2** in 7 giorni (14–20/10: 16/10 e 19/10) | **−99 %** | **sì**: stessa query; il messaggio esiste ancora (`supabase-fetch.ts:547`) |
| `/auth/v1/user`, 24 h | 117.658 (rimisura di lunedì), p50 **105 ms** | **146.787**, p50 **10 ms**, p95 201 ms | latenza **−90 %**; chiamate **+25 %** | **sì** per la mediana; **in parte** per il conteggio (stessa riserva sulla finestra) |
| Realtime | 42.408 s di tempo DB dal 06/08; **12** sottoscrizioni | 49.710,7 s dal 06/08 (cumulato); **0** chiamate nuove in 6 minuti; **0** sottoscrizioni; pubblicazione con **0** tabelle | il costo si è fermato: la sessione 9a misurava ~14 s/giorno contro ~740 prima | **sì**: stesso `stats_reset` (06/08) |
| Backup | giornalieri, 7 giorni, PITR spento, nessuna copia esterna | 8 giornalieri `COMPLETED`; copia cifrata su R2 riuscita 7 notti su 7 ma partita fra 07:04 e 09:35 UTC; PITR spento | copia esterna: **da nessuna a una** | **sì** |
| Istanza | Small, 1,92 GB; swap **442 MB** (359 alle 16:35); CPU ~4 % | Small, 2 GB; swap e CPU **non misurati** | — | **no**: le metriche dell'istanza chiedono la chiave di servizio, che oggi non è stata aperta. Il «1,5 % di un core» di oggi viene da `pg_stat_statements` ed è un'altra misura |
| Dimensioni | DB **348 MB**, Storage **14 GB** | DB **491 MB**, Storage **20 GB** | DB **+41 %**, Storage **+43 %** in 15 giorni | **sì**: query 4 |
| Galleria (`gallery`) | **4,4 GB** | **10,7 GB** (6.606 oggetti) | **+6,3 GB**, ~0,4 GB al giorno | **sì**: somma delle dimensioni per bucket |
| Cron | 30 job, 0 fallimenti in 7 giorni (29 alle 16:35) | 30 attivi, 0 fallimenti in 7 giorni, **ma** 27 richieste senza risposta in ~6 h in `net._http_response` | i fallimenti di pg_cron restano 0; quelli veri non erano misurati | **sì** per i fallimenti; la lettura di pg_net è **nuova** |
| «Failed to fetch» per giorno feriale | ~**1.100–1.500** | **41–90** (13–20/10) | **−95 %** | **sì**: stessa query; «Load failed» (iPhone) non era contato nemmeno allora |
| Errori realtime della chat per giorno feriale | ~**300** | **288–378** | invariato | **sì**: stesso filtro `chat-realtime-errore%` |
| Domande d'iscrizione | 722 | **733** (contate alle 12:32:54) | +11 | **sì** |
| FK `ON DELETE CASCADE` in `public` | **119** | **101** (39 `RESTRICT`, su 299; rilette alle 13:26) | −18: 22 passate a `RESTRICT`, 4 nuove | **sì**: stesso schema |

### P4.2 I problemi del 05/10, uno per uno

| 05/10 | Oggi | Prova di oggi |
|---|---|---|
| **S1 🔴** Server a Washington, DB in Irlanda | ✅ **risolto** | `fra1::dub1`; 1.301.232 richieste del server da DUB, p50 10 ms. Resta la coda (p95 127 ms come allora, 232–315 in punta): è carico, non distanza |
| **S2 🔴** Se il sito si ferma nessuno avvisa | 🟢 **migliorato** | salute a livelli, `/api/health` `ok` con 9 controlli, `dopo-deploy`, monitor su Cloudflare che dalle 11:00 di oggi fa partire il campanello ogni 15' (7 giri regolari fino alle 12:30). Restano i punti ciechi di oggi: 13 job, Storage, email (S5) e un solo canale d'allarme (S4) |
| **S3 🟠** Ogni chiamata chiede ad Auth «chi sei» | 🟡 **migliorato nel tempo, peggiorato nel numero** | p50 105 → 10 ms; chiamate 117.658 → 146.787 (+25 %), il 42 % del traffico del server insieme alle letture di `utenti` e `parents`. La sessione 10 del 05/10 si è chiusa senza codice, per scelta |
| **S4 🟠** Il Realtime costa più di tutto | ✅ **risolto** | 0 sottoscrizioni, pubblicazione vuota, 0 chiamate nuove alla lettura del WAL; la chat è broadcast privato |
| **S5 🟠** Code e cron fragili | 🟢 **migliorato** | prese con scadenza, `Idempotency-Key` di Resend, `maxDuration` su 11 route. Oggi resta S1 (esiti dei cron non letti), S2 (un solo tentativo, solleciti `ok:true`) e S9 (17 route senza `maxDuration`) |
| **S6 🟠** Errori ignorati, report che mentono | ✅ **risolto** per quella parte | 327 punti → 0 col lock `errori-postgrest-guardati`; report di cassa in SQL. Restano oggi il taglio a 1000 righe su 5 route fuori dai pagamenti (S6) e gli errori del DB mostrati fuori (S10) |
| **S7 🟡** Versioni vecchie dell'app Android | ✅ **risolto** | «Failed to fetch» 1.100–1.500 → 41–90 per giorno feriale |
| **S8 🟡** Niente cache | 🔴 **invariato nei fatti** | la correzione proposta (`s-maxage`) è nel codice dalla PR #250, in produzione da stamattina, ma la CDN non tiene la risposta: MISS 23/23 alle 12:34 e 2/2 alle 13:19, più di 4 ore dopo il deploy |
| **D1 🔴** Paracadute corto e mai provato | 🟢 **migliorato** | copia cifrata su R2 ogni notte, 7/7 riuscite; due prove di ripristino a pezzi il 06/10. PITR ancora spento per scelta del 19/10; la copia esterna parte con 5–7 ore di ritardo (S4) |
| **D2 🔴** 14 GB di file senza backup | 🟠 **migliorato, ma la parte scoperta è raddoppiata** | lo specchio su R2 c'è; esclude `gallery` e `video_originals` (scelta del 06/10). Scoperti allora: 6,9 GB; oggi **13,2 GB**, il 66 % dello Storage |
| **D3 🔴** Un DELETE cancella anni di storia | 🟢 **migliorato** | scatola nera su 42 tabelle, `TRUNCATE` rifiutato, 22 freni `RESTRICT` (CASCADE 119 → 101). Restano 12 figlie di `utenti` e 12 di `alunni` senza copia (D4 di oggi) |
| **D4 🟠** Audit fragile | ✅ **risolto** in gran parte | storico delle modifiche su 13 tabelle, registri in sola aggiunta. Restano fuori `alunni`, `parents`, `utenti` (D4) e l'audit docente non bloccante (D11) |
| **D5 🟠** Soldi e scrutini a metà | ✅ **risolto** | RPC con `FOR UPDATE`, versioni sullo scrutinio, report in SQL. Il residuo che il 05/10 lasciava aperto, `registra_transazione_contabile`, oggi contiene `FOR UPDATE` (`pg_get_functiondef`, 13:26 UTC; non verificato su quale riga) |
| **D6 🟠** Pulizie che cancellano troppo | ✅ **risolto** per i quattro casi | interruttori, «catena ferma», 7 giorni di grazia, «copia presente». Oggi ne emerge un quinto della stessa famiglia: la conservazione delle iscrizioni (D9) |
| **D7 🟠** Tre strade per le migrazioni | 🟢 **migliorato** | `migrate.yml` disarmato; 231 = 231, 0 doppie. Resta l'istruzione di `ship-cycle.md` che dice di riapplicarle a mano (D10) |
| **D8 🟠** Scritture in produzione senza conferma | ⚪ **invariato per scelta** | il titolare ha scelto l'autonomia piena con D1–D3 come rete. Oggi però c'è un dato in più: `exec_sql` è ancora raggiungibile (D1) |
| **D9 🟡** Capacità | ⚪ **non rimisurato** (swap e CPU) | decisione «resta Small» confermata dalle misure indirette: tempo DB +5,5 s in 6 minuti |
| **D10 🟡** Igiene e sicurezza | ✅ **risolto** in gran parte | FK senza indice 95 → 0, `initplan` 0, doppioni 0, password minima 8 e protezione dalle password rubate, tabelle di backup tolte, `GRANT` revocati su `enrollment_submissions` (oggi: nessun privilegio per anon e authenticated), tipi ammessi nei bucket, `CHECK` sui pagamenti. Gli indici «mai usati» passano da 62 a **137**: sono in gran parte i 95 indici nuovi sulle FK, che servono alle cancellazioni e non alle letture |

### P4.3 Problemi nuovi (non c'erano, o non erano stati visti, il 05/10)

- **S1 — i cron «riusciti» che non lo sono**: 27 richieste senza risposta in 6 ore dietro 16.032
  esecuzioni «succeeded». Il 05/10 aveva letto «0 fallimenti» come salute.
- **S2 — solleciti `ok:true` anche se nessuna email parte.** È in parte il prezzo di una correzione
  del 05/10: la sessione 8 ha messo la presa *prima* dell'email per non spedire doppioni. La
  soluzione di oggi la tiene e la annulla solo quando nessun invio riesce.
- **S4 — backup e campanello appesi al cron di GitHub.** Il ritardo era già scritto il 09/10 («6 h
  30 min–7 h dopo le 02:23»), ma non era diventato un problema: oggi si vede che il backup cade
  nell'ora di punta. Il campanello è stato sistemato oggi stesso dal Worker; il backup no.
- **S8 — la sfida `403` di Vercel** ai client veloci, e la cache che non funziona nonostante il codice.
- **S10 — errori del database mostrati fuori**, 3 su route pubbliche.
- **D1 — `exec_sql`**: la porta più larga, non vista il 05/10 (che aveva guardato solo i permessi
  degli agenti).
- **D9 — conservazione delle iscrizioni** che può togliere documenti ancora citati (latente).
- **D12 — concorrenza residua** (promemoria, sync delle fatture, cofirma del registro).
- **Crescita**: la galleria è passata da 4,4 a 10,7 GB in 15 giorni. Non è un difetto, ma cambia il
  peso di D3 e la dimensione del primo specchio su R2.

### P4.4 Dove la prima analisi aveva sbagliato, sovrastimato o sottostimato

1. **Sottostimato il cron di GitHub.** Il 05/10 scriveva «in ritardo di 10-30 minuti»; misurato il
   09/10: giri ogni 3 h 33 min – 7 h 33 min, e il backup 5–7 ore dopo l'orario (corretto allora
   nella tabella di stato, non nella sezione dei problemi).
2. **Sopravvalutata la salute dei cron.** «30 job, 0 fallimenti» misurava pg_cron, non il lavoro
   fatto: `net._http_response` non era stata guardata.
3. **Sopravvalutato l'effetto di Dublino sulla coda.** La mediana è scesa da 103 a 10 ms come
   previsto, ma il p95 sulle 24 ore è rimasto 127–129 ms e in punta sale a 232–315 ms: la coda è
   carico (backup, identità, job), non distanza. La sessione 10 del 05/10 l'aveva già intuito.
4. **Sottostimata la cache.** `s-maxage` era dato per sufficiente; nessuno ha controllato
   `x-vercel-cache` dopo il rilascio.
5. **Sottostimata la crescita dello Storage.** 14 GB erano una fotografia, non un ritmo: 20 GB
   dopo 15 giorni. La decisione del 06/10 di escludere la galleria si basava su 6,9 GB scoperti;
   oggi sono 13,2, e il costo della copia resta di centesimi al mese.
6. **Non visto `exec_sql`.** Il rischio «scritture senza conferma» era stato trattato come una
   questione di permessi degli agenti; la funzione che esegue SQL qualsiasi è rimasta in piedi.
7. **Giusto:** la diagnosi della distanza (S1), del Realtime (S4), dei bundle vecchi (S7) e la
   previsione che gli indici «mai usati» non andassero tolti. Dei cinque problemi 🔴 di allora, uno
   è risolto (S1) e tre sono molto migliorati (S2, D1, D3); il quinto (D2) è migliorato ma la parte
   scoperta è raddoppiata.

### P4.5 Cosa questo confronto corregge della Parte 3 di oggi

> **Assorbito nella specifica** (`docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`):
> ogni punto qui sotto è già dentro la sessione corrispondente. I numeri di sessione sono quelli della
> prima stesura (corrispondenze nella §3).

Queste sono le correzioni che il confronto ha portato alla Parte 3 scritta alla cieca:

- **S3, pool di Auth:** non è più «fisso a 10». Il 19/10 il titolare l'ha portato al 15 % (13
  connessioni su Small), e l'advisor `auth_db_connections_absolute` oggi non compare. Il commento a
  `src/lib/health/controlli.ts:647` è rimasto indietro.
- **Sessione 11 e decisione T10:** i token erano già **ES256** il 05/10, e il middleware li verifica
  già in locale; T10 si riduce a «riverificare». Soprattutto, `getClaims()` sulle letture è stato
  **scartato dal titolare il 12/10** (sessione 10: un account revocato leggerebbe fino a 1 h). La
  sessione 11 va quindi presentata come riapertura di quella decisione, con il numero nuovo:
  146.787 chiamate al giorno, +25 %.
- **D5, «mai provato»:** il ripristino è stato provato **a pezzi** il 06/10 (175/175 tabelle e 54/54
  file uguali sul Mac; clone su un progetto nuovo in ~5,5 minuti). Manca la prova completa con file e
  app, che è quello che la sessione 14 propone.
- **D3 e T2:** la galleria cresce di ~0,4 GB al giorno; il primo specchio va provato prima con un
  giro di prova (già scritto nella sessione 4), e il costo resta di centesimi.
- **S8:** la cache era la soluzione A del 05/10, eseguita nella sessione 12. La sessione 13 di oggi
  ne è il seguito, non un lavoro nuovo.

### P4.6 Verdetto

1. In 15 giorni il **server** è passato da lento e cieco a veloce e sorvegliato: mediana verso il DB −90 %, salute `ok`, «Failed to fetch» −95 %, timeout −99 %.
2. Il **database** ha ora una copia esterna, una scatola nera e i freni dove serve: dei cinque 🔴 del 05/10, uno è risolto e tre molto migliorati.
3. Il rischio più grande che resta è la **perdita di dati**, non la lentezza: niente PITR per scelta, 13,2 GB di foto e video senza copia (raddoppiati in 15 giorni), `exec_sql` aperto, 24 tabelle figlie senza copia.
4. Il secondo è il **falso verde**: cron «riusciti» senza esito, solleciti «inviati» senza email, una cache scritta ma non attiva. La prima roadmap ha insegnato a misurare; questa deve insegnare a leggere gli esiti.
5. La nuova roadmap è più piccola nei rischi e più lunga nel numero (14 sessioni); le due mosse che valgono di più non sono codice ma due decisioni del titolare, T1 e T2. Il titolare le ha rinviate entrambe il 20/10, con una soglia per ridecidere (§4 della specifica).
