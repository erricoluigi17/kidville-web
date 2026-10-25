# Roadmap di robustezza, seconda serie — specifica

Approvata dal titolare il 20 ottobre 2026, in modalità piano, dopo un brainstorming con dodici
decisioni (T1–T12). Viene dalla seconda analisi di robustezza,
`docs/analisi-robustezza-2026-10-20.md`, che prende la misura del 20/10 e la confronta con quella del
05/10. Questa specifica **sostituisce la §3 di quel rapporto**, che resta solo come riassunto, e
assorbe le correzioni della §P4.5.

È anche la **copia di lavoro** della serie: la tabella di stato qui sotto si aggiorna a ogni
rilascio, nello stesso modo in cui `docs/roadmap-robustezza.md` ha accompagnato la prima serie.

Ogni sessione ha il suo piano, in `docs/superpowers/plans/2026-10-20-robustezza2-sNN-<nome>.md`.
Un piano si esegue con `superpowers:subagent-driven-development` (consigliata) oppure con
`superpowers:executing-plans`, **una sessione alla volta**, in un worktree nuovo da `origin/main`.

**Nessuna sessione è stata avviata il 20/10.** La specifica e i piani sono arrivati con la PR #254,
che contiene solo documenti.

---

## 1. Tabella di stato

| # | Sessione | Problemi | Dopo | Stato | PR | Piano | Note |
|---|---|---|---|---|---|---|---|
| 1 | Iscrizioni: documenti mai persi, stati vincolati | D9, D11 (CHECK, audit docente) | — | in produzione | #266 | `docs/superpowers/plans/2026-10-20-robustezza2-s01-iscrizioni.md` | **entro il 31/10** (giro dell'1/11, 04:41 UTC): rispettata. T6. Lotto 1 (con 2, 4, 11). In produzione il 25/10/2026 (merge 09:17 UTC), `main` `cdcb5347`; misura dopo del 25/10/2026, 09:28–09:30 UTC: version `20261024235116` una riga nel registro, 2 vincoli convalidati, 2 righe `vincolo-convalidato` in `app_log`; 734 domande (approved 700, pending 3, rejected 31), alunni iscritto 791 · ritirato 16; guardia del 31/10 a 0; domande pending/rejected con allegati citati 0 (0 allegati); `/api/health` alle 09:30 UTC (versione `cdcb5347f279`) con `audit-docente` `ok`. Battito dell'1/11: matura dal 01/11 dopo le 04:41 UTC |
| 2 | Via `exec_sql` e freno sulle istruzioni distruttive | D1, D10 (istruzioni) | — | in produzione | #266 | `docs/superpowers/plans/2026-10-20-robustezza2-s02-sql-arbitrario-e-freno.md` | T3; aggiunte al freno: A sì, B sì, C sì, D sì (decise il 25/10/2026 dall'assistente in assenza del titolare, da confermare; si tolgono una per una con la tabella del Compito 1, passo 5). Lotto 1. In produzione il 25/10/2026 (merge 09:17 UTC), `main` `cdcb5347`; **freno NON visto fermare il 25/10/2026** (09:27 UTC, CLI 2.1.259: `EXPLAIN DELETE FROM public.app_log WHERE false` è passata, nessuna riga `FRENO SQL` nel registro; la sessione della prova aveva per cartella di progetto un checkout fermo a `b558e714`, prima del merge, senza il freno registrato: la prova di legge resta da fare in una sessione aperta su `main` aggiornato); misura dopo del 25/10/2026, 09:28–09:31 UTC: `exec_sql` assente, una riga `20261025013356` nel registro, `404 PGRST202`, advisor 0 ERROR (2 WARN, 68 INFO, come prima). `app_log` a 7 giorni: matura dal 01/11 dopo le 09:17 UTC |
| 3 | Scatola nera su cascate, anagrafiche e protocollo | D4, D6, D7 (ricevute delle note) | 2 | da fare | — | `s03-scatola-nera-cascate` | T4; crescita del DB da misurare prima |
| 4 | Backup alle 02:23, secondo canale d'allarme, bucket, Vault, chiavi | S4, D5 (in parte), D8 (in parte) | — | ✅ in produzione il 25/10 (main cdcb5347) | #266 | `docs/superpowers/plans/2026-10-20-robustezza2-s04-backup-notte-e-allarme.md` | T2, T5, T12. Lotto 1. Misure del 25/10/2026, 09:28–09:31 UTC: version `20261025021715` una riga nel registro, `n_nuovi` 0, 21 bucket in produzione come nella fotografia (non rigenerata), i quattro bucket presenti; su `main` `backup-notturno.yml` ha lo `schedule` `23 2 * * *`, la guardia delle 20 ore e `backup` con `needs: guardia` e `!cancelled()`; `monitor-esterno/wrangler.toml` dichiara `*/5 * * * *` e `23 2 * * *`. In attesa del titolare: pubblicare il Worker e incollare i segreti Resend (non verificato da qui). Tre notti dal Worker: matura dalla mattina dopo la terza notte dal deploy del Worker. p95 server→DB nella punta: matura dal primo giorno feriale dopo quella terza notte. Email di prova del secondo canale: da fare. T5: spostamento e revoca da confermare |
| 5 | Prova di ripristino completa | D5, D8 (verifica) | 4 | da fare | — | `s05-prova-ripristino` | T1, T11; mezza giornata del titolare |
| 6 | Esiti dei cron: si osserva, non si cambia | S1 (osservazione) | 2 | da fare | — | `s06-esiti-cron` | dà il «prima» alla 8 |
| 7 | La salute vede tutto, senza falsi «giù» | S1 (sorveglianza), S5, D10 (allarme migrazioni) | 6 | da fare | — | `s07-salute-completa` | misura di controllo a fine sessione |
| 8 | Correggere i cron e l'igiene del database | S1 (comportamento), D11 (igiene), D12, S12 (`app_log`) | 6, 7 | da fare | — | `s08-cron-e-igiene` | T7 |
| 9 | Email e fornitori senza successi finti | S2, S9 | 7 | da fare | — | `s09-email-e-fornitori` | solo codice |
| 10 | Operazioni a più passi senza perdite | D7 | 3 | da fare | — | `s10-operazioni-a-piu-passi` | **entro metà dicembre** |
| 11 | Letture che non si troncano | S6 | — | in produzione | #266 | `docs/superpowers/plans/2026-10-20-robustezza2-s11-letture-a-blocchi.md` | anticipata nel lotto 1: `student_parents` 1096 legami > 1000 (misura del 24/10). `max_rows` del progetto ospitato da confermare dal pannello (in attesa del titolare). Nessun revert in `main`; commit `cdcb5347`. Prova dell'elenco genitori: non registrata, in attesa del titolare. Misura a 7 giorni: matura dal 01/11 dopo le 12:00 UTC (7 giorni dal merge delle 09:17 UTC; vale l'ora più tarda scritta nella voce del PRD) |
| 12 | Chat leggera | S7 | — | da fare | — | `s12-chat-leggera` | — |
| 13 | Bordo pubblico: cache, firewall, errori, login, build | S8, S10, S11, S12 (build) | — | da fare | — | `s13-bordo-pubblico` | T8, T9; misura di controllo a fine sessione |
| 14 | Identità, **condizionale** | S3 | 7 | da fare | — | `s14-identita-condizionale` | T10: si procede solo sopra la soglia |

I codici dei problemi (S1–S12 per il server, D1–D12 per il database) sono quelli della §2 del
rapporto del 20/10. La colonna «Dopo» elenca le sessioni che devono essere **in produzione** prima di
aprire questa.

---

## 2. Le decisioni del titolare (20/10)

| Codice | Scelta | Dove pesa |
|---|---|---|
| T1 PITR | **no, per ora** | rischio accettato (§4); la protezione principale contro un errore di giornata è la scatola nera della sessione 3 |
| T2 galleria nel backup | **no, resta com'è** | rischio accettato (§4); `ESCLUDI_BUCKET` in `.github/workflows/backup-notturno.yml` non si tocca |
| T3 agenti in produzione | **freno sui distruttivi** | sessione 2 |
| T4 registro di protocollo | **copia silenziosa**: `protocolli` e `protocolli_allegati` nella scatola nera, file rettificato conservato in versioni. Le decisioni #6 e #26 («nessuna traccia applicativa») restano | sessione 3 |
| T5 chiavi dei backup | **le sposta il titolare** fuori dalla cartella dell'app e conferma nel pannello la revoca della vecchia `sb_secret_` | sessione 4 (solo il runbook) |
| T6 audit docente | **non bloccante, con allarme** | sessione 1 |
| T7 conservazione dei log | **errori in `app_log` per 90 giorni** | sessione 8 |
| T8 firewall di Vercel | **sì, prima in modalità «log»** per 7 giorni, con un'eccezione per il Worker | sessione 13 |
| T9 CAPTCHA al login | **rinviato** | la sessione 13 scrive solo come si contano i tentativi |
| T10 identità | **solo se una misura lo chiede** | sessione 14, condizionale |
| T11 prova di ripristino | **subito dopo il backup**, mezza giornata del titolare | sessione 5 |
| T12 chiave di Resend nel Worker | **la incolla il titolare** con `wrangler secret put` | sessione 4 |

Le decisioni non si riaprono dentro un piano. Se una misura dice che una decisione va rivista, il
piano si ferma e lo scrive nella tabella di stato, nella colonna «Note».

---

## 3. Ordine, dipendenze, scadenze

**Dipendenze:** 2 → 3, 4 → 5, 6 → 7 → 8, 7 → 9, 3 → 10, 7 → 14. Le sessioni 1, 11, 12 e 13 non
dipendono da nessuna.

**Perché quest'ordine.**
- **La 1 prima di tutto**, perché è l'unica con una data: il giro mensile della conservazione delle
  iscrizioni parte l'1/11 alle 04:41 UTC. Oggi il caso è latente (0 domande importate in
  `pending`/`rejected` il 20/10), ma il rifiuto non controlla lo stato precedente: basta un clic per
  renderlo vero.
- **2 → 3.** La 3 insegna alla scatola nera a rispettare `scatola_nera.senza_storico`, che serve alle
  pulizie in blocco. È sicuro solo quando nessun ruolo dell'app può più accenderlo con `exec_sql`.
- **2 → 6.** La 6 aggiunge funzioni `SECURITY DEFINER` (l'involucro dei cron): devono nascere sotto il
  lock della 2, che vieta le funzioni con un argomento `sql text`.
- **4 → 5.** La prova di ripristino usa la ricetta del Vault, i bucket dichiarati e il nuovo percorso
  delle chiavi che la 4 scrive. Va fatta subito dopo, finché la 4 è fresca (T11).
- **6 → 7 → 8: prima si guarda, poi si tocca.** La 6 registra gli esiti veri senza cambiare il
  comportamento e dà il «prima»; la 7 li porta in `/api/health`; solo la 8 cambia timeout, pulizie e
  `storici_tick`, quando un peggioramento ha già un allarme. `cron.job_run_details` si svuota solo
  nella 8: prima, i job mensili ci perderebbero l'unica traccia.
- **7 → 9.** Un'email che fallisce deve arrivare a un allarme, non solo a un log.
- **7 → 14.** La salute completa e i controlli sugli errori (`tasso-errore`, righe di `app_log`) sono il
  segnale con cui si vede una regressione di un cambio d'identità. Il controllo `auth` esistente usa
  `getUserById`: non vede la verifica locale, quindi non basta.
- **3 → 10.** Le righe sono già al sicuro nella scatola nera; nella 10 si mettono al sicuro i file.
- **La prova di ripristino sale dal 14° al 5° posto:** senza PITR (T1) la copia esterna è la rete
  principale, e una rete mai provata intera non è una rete.
- **La 14 è in fondo e condizionale** (T10): `getClaims()` sulle letture è stato scartato dal
  titolare il 12/10, e oggi la latenza dell'identità è scesa a p50 10 ms.

**Scadenze.**
- **Sessione 1 entro il 31/10.** Se il 31/10 non è in produzione, quel giorno si rifà questa lettura,
  che deve dare 0:
  ```sql
  select count(*) from enrollment_submissions
  where imported_at is not null and status in ('pending','rejected');
  ```
  Se dà più di 0, il titolare spegne il giro dell'1/11 dal pannello di pg_cron prima delle 04:41 UTC.
  La lettura non vede una domanda rimasta `pending` con `imported_at` vuoto dopo un import fallito
  all'ultimo passo, quando le anagrafiche citano già i suoi file: il Passo 0 della sessione 1 conta
  anche questo caso, per percorso.
- **Sessione 10 entro metà dicembre:** a gennaio si riaprono gli scrutini del primo quadrimestre.

**Prerequisito di tutta la serie:** la PR #254, che porta questa specifica e i piani, va unita in
`main` prima di aprire la sessione 1. Altrimenti il ramo della sessione nasce senza i piani e il PRD
va in conflitto sulla prima riga.

**Si anticipa** la 11 se `select count(*) from student_parents;` o `select count(*) from alunni;`
(tutti gli stati: 806 il 20/10, letti prima dall'elenco genitori) supera già 1000: in quel caso
l'elenco genitori dell'amministrazione è già troncato oggi.

---

## 4. Rischi accettati, e quando ridecidere

- **Niente PITR (T1).** Un errore scoperto nel pomeriggio si ripara dal backup della notte
  (~00:55 UTC), salvo le tabelle coperte dalla scatola nera, che conserva le righe eliminate e
  modificate per 90 giorni.
  - **Si ridecide** dopo il primo incidente che chieda un ripristino, e comunque a settembre 2027.
- **Galleria e video originali senza copia (T2).** Il 20/10 i due bucket pesano 13,2 GB e crescono
  di ~0,4 GB al giorno. Resta solo il cestino di 30 giorni; la conservazione della galleria ha già un
  tetto per giro.
  - **Si ridecide** quando i due bucket superano 20 GB, misurati con la query 4 a ogni misura di
    controllo (§5).

---

## 5. Regole comuni

Valgono per ogni sessione e ogni piano le ripete.

- **Una sessione alla volta.** Ramo `robustezza2/sNN-<nome>` da `main`, in un worktree nuovo → PR →
  CI verde su **tutti** i job → **merge a mano del titolare** → deploy → una `SELECT` che conferma la
  migrazione applicata dall'integrazione. Il ramo dopo nasce solo dopo il rilascio e la pulizia dei
  rami (`AGENTS.md`, punti 1 e 3).
- **Il merge lo fa il titolare, a mano.** È una regola di questa serie, decisa il 20/10: vale anche
  dove `CLAUDE.md` concede l'autonomia piena sul merge. Mai auto-merge.
- **Pulizia:** dopo il rilascio si cancellano il ramo e il worktree della sessione; i rami di altre
  sessioni con una PR ancora aperta restano.
- **Codice che regge il momento del merge.** Migrazione e deploy partono insieme e il DB della CI non
  è migrato. Il codice che legge una colonna o una tabella nuova regge `42703`, `42P01` e `PGRST205`
  col modello `CODICI_NON_INSTALLATO` di `src/lib/health/controlli.ts:1285`. Il codice che chiama una
  RPC nuova regge `PGRST202` e `42883` **solo su quella chiamata**, con un insieme locale sul modello
  di `RPC_ASSENTE` (`src/app/api/avvisi/[id]/risposte/route.ts:71`) e una riga di log `info` che dice
  perché. `src/lib/db/tolleranza-schema.ts` **non** si allarga: lì `PGRST202` è di proposito un
  guasto, perché fuori dalla finestra del merge una RPC che manca è schema a metà.
- **La tabella di stato (§1), in due tempi.** Nella propria PR la sessione scrive Stato
  «in revisione» (sempre queste parole), numero della PR e percorso del piano. «In produzione», il
  commit di `main` e la misura «dopo» con data e ora UTC li scrive la sessione che apre dopo, nella
  sua «chiusura della precedente» (qui sotto). Una misura che matura più tardi (i 7 giorni del
  firewall, le notti del backup, le 24 h di un cron) entra nella prima PR che tocca la specifica dopo
  quel giorno. Solo l'ultima sessione, la 14, usa un ramo di soli documenti `robustezza2/s14-esito`, con la sua PR e lo stesso merge a mano. Le altre non aprono rami di soli documenti. Un ramo di revert si chiama `revert/sNN-<nome>`, fuori dal prefisso `robustezza2/`: le sessioni dopo cercano le PR con `head:robustezza2/` e la chiusura della precedente cerca un piano con quel nome.
- **Apertura di una sessione: i prerequisiti.** Per ogni sessione della colonna «Dopo» si
  verificano due fatti, non lo «Stato» della tabella (che la chiude la sessione successiva): la sua
  PR è mergiata in `main` (`gh pr list --state merged --search "head:robustezza2/sNN-"`) e, se aveva
  migrazioni, le loro version sono in `supabase_migrations.schema_migrations`. Poi: nessuna PR
  `robustezza2/` aperta, salvo i rami `-esito`.
- **Apertura di una sessione: la chiusura della precedente («PR-B»).** Il primo commit di ogni
  sessione chiude quella **rilasciata per ultima**, qualunque numero abbia (la PR `robustezza2/`
  mergiata più di recente; con l'ordine 1→14 è di solito quella col numero prima). Si fa quello che
  il suo piano elenca nella sezione finale «Per la sessione dopo», che ogni piano ha: fotografie
  rigenerate dalla produzione (`migrazioni-applicate-snapshot.json` sempre, e le altre che quel
  piano nomina: indici unici, policy, chiavi esterne, bucket), voci tolte da
  `MIGRAZIONI_ATTESE_AL_MERGE` e dalle altre liste «fino alla PR-B», riga di stato a «in produzione»,
  Stato della sua voce nel PRD, misura «dopo» se è già matura. Si legge quella sezione, non si
  indovina: un piano non presume cosa ha lasciato la sessione prima.
- **Riferimenti al codice.** Un piano cita righe lette il 20/10; le sessioni prima possono averle
  spostate. Ogni sostituzione si fa per **contenuto** (il testo da cercare, il nome della funzione o
  del test), mai solo per numero di riga; una riga della tabella di stato si trova con
  `grep "^| N |"`, mai con `sed -n Np`.
- **Corpi delle funzioni presi dalla produzione.** Chi ridefinisce una funzione parte da
  `pg_get_functiondef` letta in produzione, non dal file del repo: altrimenti riporta in vita versioni
  vecchie.
- **Come si torna indietro.** Codice: Instant Rollback di Vercel subito, poi una PR di revert.
  Migrazioni: la sezione «ROLLBACK» nell'intestazione, sul modello di
  `supabase/migrations/20261019223123_battiti_app_log_che_contano.sql`. Diventa una migrazione nuova
  **solo** dentro una PR di revert, mai applicata a mano.
- **Log e PRD.** Ogni sessione porta i suoi log con `esito` (`AGENTS.md`, «Logging obbligatorio»), le
  scritture in `app_log` delle migrazioni con `ON CONFLICT`, e una voce datata nel changelog di
  `PRD REGISTRO ELETTRONICO.md`.
- **Gate:** `npx eslint . --max-warnings 0` · `npx tsc --noEmit` · `npx vitest run` ·
  `NODE_OPTIONS=--max-old-space-size=8192 npm run build`. In un worktree nuovo il lock
  `offline-html-nativo` è rosso finché non c'è `cap sync`: si rilancia con `CI=1`.
- **Mai `npm run e2e` né `e2e:seed` in locale**: l'E2E gira in CI.
- **Prima di ogni migrazione** si conta `SELECT count(*) FROM enrollment_submissions;` e il numero va
  nel PRD con data e ora UTC.
- **Mai una stima al posto di una misura.** Ogni numero porta giorno, ora UTC e finestra; «osservato»
  e «causa probabile» si scrivono separati.
- **Repository pubblico, dati di minori.** Nei piani, nei test e nei commit solo conteggi, uuid,
  codici d'errore, nomi di tabelle e di file.

### Misure di controllo

Alla **fine delle sessioni 7 e 13** si rifanno due misure della §4 del rapporto, in sola lettura, e
si scrivono nella tabella di stato:
- **query 2 bis** su `query_logs`, 24 h feriali, con il filtro sul percorso `/auth/v1/user`: serve
  alla soglia della 14;
- **query 4** (dimensioni del DB e somma per bucket dello Storage): serve alla soglia di T2.

A fine serie si rifà la **terza fotografia completa**, con le stesse 14 misure della §4 del rapporto
e lo stesso metodo.

---

## 6. Formato di ogni piano

Modello di stile: `docs/superpowers/plans/2026-10-18-ipad-tablet-pr1.md`. Regole della skill
`writing-plans`, in italiano:

- **Intestazione:** titolo «… — piano di implementazione», poi la riga «Per chi esegue: sotto-skill
  obbligatoria `superpowers:subagent-driven-development` (consigliata) oppure
  `superpowers:executing-plans`; i passi usano le caselle (`- [ ]`)». Seguono **Obiettivo** (una
  frase), **Architettura** (2-3 frasi), **Tecnologie** e il rimando a questa specifica.
- **Mappa dei file** prima dei compiti: tabella file → ruolo, con percorsi e righe **letti davvero**.
- **Compiti** `### Compito N` con **File:** (Crea / Modifica `percorso:righe` / Test) e passi da 2-5
  minuti in TDD: test rosso col codice → eseguirlo e vederlo fallire (comando, esito atteso) → codice
  minimo per intero → test verde → commit col comando.
- **Nessun segnaposto:** niente parti rimandate a dopo, niente «gestire i casi limite», niente
  rimandi a un altro compito al posto del codice, niente «scrivere i test» senza il codice. Ogni passo che cambia codice mostra il codice; ogni comando dice l'esito
  atteso; ogni funzione citata è definita in un compito.
- **Sei parti fisse**, con questi titoli:
  1. **Passo 0 — misura «prima»:** la query esatta, in sola lettura, e la soglia che cambia il piano.
  2. **Migrazione:** guardie per la CI, `NOT VALID` dove serve, sezione ROLLBACK. Se la sessione non
     ha migrazioni, la parte lo dice in una riga.
  3. **Log** con `esito`.
  4. **PRD.**
  5. **Rilascio:** gate, CI, merge a mano del titolare, `SELECT` dopo il merge, misura «dopo» con
     data e ora UTC.
  6. **Ritorno indietro.**
- **Apertura e chiusura** (§5): il Compito 1 verifica i prerequisiti della colonna «Dopo» (PR
  mergiata e migrazioni applicate) e chiude la sessione rilasciata per ultima leggendo il suo «Per la
  sessione dopo». In fondo al piano, la sezione **«Per la sessione dopo»** elenca, senza lasciare
  niente da indovinare: le fotografie da rigenerare e con quale generatore; le voci da togliere da
  `MIGRAZIONI_ATTESE_AL_MERGE` e dalle altre liste «fino alla PR-B»; la riga di stato (`grep "^| N |"`)
  da portare a «in produzione»; le `SELECT` della misura «dopo» e da quando sono mature; lo Stato
  della voce nel PRD. Una sessione senza migrazioni lo dice e lascia solo riga di stato, PRD e misura.
- **Autorevisione** finale contro questa specifica: copertura, segnaposto, nomi coerenti fra i
  compiti.

---

## 7. Le sessioni una per una

Ogni sessione dice: da dove viene («Era», il numero nella §3 del rapporto), obiettivo, misura prima,
cosa si tocca, decisioni, rischio, ritorno indietro, prova. I percorsi e le righe sono quelli letti il
20/10: il piano li rilegge prima di scrivere i compiti.

### Sessione 1 — Iscrizioni: documenti mai persi, stati vincolati (era 1)

- **Obiettivo:** la conservazione delle iscrizioni non può togliere un documento ancora citato da
  un'anagrafica; una domanda già approvata non si può respingere.
- **Misura prima:** i valori distinti di `enrollment_submissions.status` e di `alunni.stato`, con il
  conteggio per valore (il 20/10: 3 stati e 2 stati); la lettura della guardia del 31/10 (§3).
- **Cosa si tocca:**
  - il giro di `src/app/api/gdpr/retention-iscrizioni/route.ts` (righe 183-432; il punto da toccare
    è 298-301) legge prima i percorsi citati da anagrafiche e fascicolo. Un percorso citato **esce
    dall'elenco dei file da togliere**; la riga scaduta si chiude comunque e i citati si contano in
    `n_file_citati`. Non va fra gli «incerti»: in `rimozione-verificata` gli incerti trattengono la
    domanda e il giro risponderebbe `500` ogni mese. Se la lettura dei citati fallisce non si toglie
    niente;
  - `src/app/api/admin/iscrizioni/route.ts` (l'`UPDATE` alle righe 879-883, il ramo del rifiuto fino
    alla 931) aggiunge `.eq('status','pending')`: zero righe → `409` con `codice`.
  - Migrazione con `CHECK … NOT VALID` e poi `VALIDATE` su `enrollment_submissions.status` e
    `alunni.stato`, con i valori misurati prima e coerenti col lock `stati-alunno-anche-in-sql`.
    Per `alunni.stato` valgono i 3 valori della tendina (`STATI_TENDINA`, `sospeso` compreso), anche
    se il 20/10 in produzione se ne vedono 2.
- **T6, audit docente non bloccante con allarme.** `src/lib/audit/scrittura.ts:109-147` già oggi non
  blocca la scrittura e registra un `error` con `esito: 'audit-non-registrato'`; lo stesso esito lo
  scrivono anche `src/lib/primaria/fascicolo-rbac.ts:177` e `src/lib/fea/audit.ts:60`. Manca
  l'allarme: un solo fallimento non supera le soglie di `tasso-errore` (`controlloTassoErrore`,
  `src/lib/health/controlli.ts:926-965`). La
  sessione aggiunge in `controlli.ts` un controllo dedicato, `audit-docente`, che porta la salute a
  `degradato` (mai `giu`) alla **prima** occorrenza di `audit-non-registrato` nelle ultime 24 h, così
  il campanello apre una segnalazione. Il piano legge prima come `app_log` conserva l'esito di una
  riga e scrive la query su quella colonna.
- **Rischio:** un valore imprevisto fa fallire la `VALIDATE` al merge e ferma l'integrazione: per
  questo si misura prima e si separa `NOT VALID`.
- **Indietro:** `DROP CONSTRAINT` in una migrazione inversa; revert.
- **Prova:** due vincoli convalidati in `pg_constraint`; un test con una domanda importata
  `pending`/`rejected` che cita un documento → il documento resta; il giro dell'1/11 lascia in
  `app_log` la riga `info` con `esito: 'retention-iscrizioni'` e il conteggio dei citati saltati; rifiutare una domanda approvata → `409`; un test con
  numeri letterali in cui un solo `audit-non-registrato` porta il segnale a `degradato`.

### Sessione 2 — Via `exec_sql` e freno sulle istruzioni distruttive (era 2)

- **Obiettivo:** nessun ruolo dell'app può più eseguire SQL qualsiasi né accendere
  `registri.manutenzione`, `scatola_nera.manutenzione`, `scatola_nera.senza_storico`; un agente non
  può più lanciare da solo un'istruzione distruttiva in produzione.
- **Misura prima:** le chiamate di `exec_sql` in `pg_stat_user_functions` e, perché con
  `track_functions = none` quella vista resta vuota, anche in `pg_stat_statements` per ruolo e nei log
  dell'API.
- **Cosa si tocca, parte 1 (`exec_sql`):**
  - migrazione `DROP FUNCTION IF EXISTS public.exec_sql(text)`: è definita solo nel baseline e
    nessun cron la usa;
  - si eliminano le 6 route sigillate che la chiamano (`src/app/api/admin/apply-migration`,
    `apply-enrollment-migration`, `apply-forms-migration`, `apply-fase4-migration`,
    `apply-mensa-multi-menu-migration`, `setup-registro`). `apply-enrollment-migration` la **ricrea**
    (`route.ts:45-90`). `src/lib/security/seal.ts` è generico (`sealDangerous`) e non ha voci da
    togliere;
  - si eliminano i 6 script che la usano: `scripts/apply_pagamenti_migrations.mjs`,
    `scripts/apply_settings_hub_migration.mjs`, `scripts/apply_segreteria_migrations.mjs`,
    `scripts/apply-enrollment-migration.mjs`, `scripts/backfill_presenze_scuola.mjs` e `seed_sql.mjs`
    nella radice. Gli altri 4 `scripts/apply_*` passano da `DATABASE_URL` e `pg`, non da `exec_sql`:
    restano, fuori perimetro;
  - un lock nuovo vieta `rpc('exec_sql'` in `src/` e `scripts/` e le funzioni `SECURITY DEFINER` con
    un argomento `sql text` nelle migrazioni nuove;
  - si allineano i 5 test che diventano rossi e la lista `docs/superpowers/errori-senza-codice-allowlist.json`;
    in `security-definer-revoke-lock` la voce `exec_sql` di `AMMESSE` **resta**, perché il baseline
    crea ancora la funzione;
  - `.claude/commands/ship-cycle.md` (righe 347-350, e le stesse istruzioni alle 171-172 e 322),
    `.claude/agents/esecutore-opus.md`, `.claude/rules/migrazioni.md`, `README.md`, `AGENTS.md` e
    `CLAUDE.md` dicono «la migrazione la applica l'integrazione al merge; il merge lo fa il titolare».
- **Cosa si tocca, parte 2 (T3, il freno):**
  - il freno nasce dall'idea di `.claude/hooks/supabase_sql_gate.sh`, che oggi esiste ma **non è
    registrato** (la storia è in `docs/storia-permessi-e-conferme.md:230-279`). Si **riscrive** in
    Python con la sola libreria standard, `.claude/hooks/supabase_sql_freno.py`, e il `.sh` si
    cancella: il vecchio rispondeva `allow`/`ask`, cercava le parole chiave anche dentro stringhe e
    commenti e non si poteva provare in automatico;
  - hook `PreToolUse` su tutti gli strumenti SQL di Supabase ammessi in `.claude/settings.json`
    (`mcp__supabase__execute_sql`, `mcp__supabase__apply_migration` e gli equivalenti del connettore
    `mcp__claude_ai_Supabase__*`);
  - risponde **`deny`**, non `ask`: un `ask` passerebbe da `.claude/hooks/auto_allow_permission.py`,
    che lo approverebbe in automatico;
  - ferma `DELETE`, `DROP`, `TRUNCATE`, `UPDATE` senza `WHERE`, `ALTER … DROP` e **ogni**
    `apply_migration`, perché le migrazioni le applica l'integrazione al merge;
  - ferma anche, come aggiunta da confermare col titolare all'apertura della sessione: `set_config` o
    `SET` di `registri.manutenzione` e `scatola_nera.*`, `session_replication_role`,
    `DISABLE TRIGGER`, e ogni istruzione che non sa leggere;
  - lascia passare `SELECT`, `INSERT`, `UPDATE` con `WHERE`, `CREATE`, `EXPLAIN`;
  - il messaggio di rifiuto dice di **mostrare l'istruzione al titolare**, che la esegue dall'editor
    SQL del pannello;
  - registrazione in `.claude/settings.json`; via di fuga per una sessione
    `KIDVILLE_FRENO_SQL_SPENTO=1`;
  - riquadro datato nella sezione «Permessi» di `CLAUDE.md` e in
    `docs/storia-permessi-e-conferme.md`;
  - test dello script con istruzioni letterali, una per ogni caso fermato e una per ogni caso lasciato
    passare (commenti, maiuscole, più istruzioni nella stessa stringa).
- **Fuori perimetro, scritto nel piano:** SQL lanciato con `psql` dentro `Bash`. Il freno copre solo
  gli strumenti MCP. Se `python3` manca o l'hook va oltre il suo tempo, la chiamata passa: la CLI
  installata non ha ancora un modo per bloccare in quel caso.
- **Rischio:** uno script del titolare fuori dal repo smette di funzionare (`PGRST202`): è l'effetto
  voluto. Un falso positivo del freno ferma una lettura: per questo i test coprono i casi lasciati
  passare.
- **Indietro:** revert. La migrazione inversa ricrea la definizione del baseline, solo su richiesta
  del titolare. Il freno si spegne con la via di fuga o togliendo la registrazione.
- **Prova:** `select to_regprocedure('public.exec_sql(text)')` → `NULL`;
  `POST /rest/v1/rpc/exec_sql` → `404 PGRST202`; advisor ancora a 0 ERROR; in una sessione nuova,
  dopo il riavvio, un `DELETE` via MCP viene rifiutato e una `SELECT` passa (*una configurazione mai
  vista passare non è configurata*).

### Sessione 3 — Scatola nera su cascate, anagrafiche e protocollo (era 3)

- **Obiettivo:** ogni riga portata via in cascata da `utenti`, `alunni`, `avvisi`, ogni modifica di
  un'anagrafica e ogni eliminazione o modifica del protocollo resta recuperabile per 90 giorni.
- **Misura prima:** l'elenco esatto delle figlie in cascata (`pg_constraint`, `confdeltype='c'`) e
  `n_tup_del`/`n_tup_upd` con le dimensioni in `pg_stat_user_tables`, per stimare la crescita sui
  491 MB del 20/10.
- **Cosa si tocca:**
  - una migrazione riusa il ciclo di
    `supabase/migrations/20261009171012_scatola_nera_registro_eliminazioni.sql:200-232` sulle 9
    figlie che contano: `chat_messages`, `chat_threads`, `avvisi`, `avvisi_risposte`,
    `nota_ricezioni`, `alunni_classi_storico`, `storici_collegamenti`, `storici_revisioni`,
    `fascicolo_accessi_audit`. Restano fuori, con il motivo scritto, le tabelle effimere (per esempio
    `notifiche`, `push_subscriptions`) e `registro_destinatari`, di cui il Passo 0 misura la crescita:
    decide il titolare;
  - il ciclo di `supabase/migrations/20261019215733_scatola_nera_modifiche.sql:148` si allarga ad
    `alunni`, `parents`, `utenti`, `note_disciplinari`, `certificati_medici`. Un `UPDATE` che cambia
    solo `storico_versione` non si copia, altrimenti ogni presa visione firmata copierebbe la nota
    intera;
  - `scatola_nera.registra()` impara a rispettare `scatola_nera.senza_storico` come già fa la
    funzione delle modifiche, e le pulizie in blocco lo accendono nella propria transazione;
  - la cancellazione di un avviso (`src/app/api/avvisi/[id]/route.ts:793-832`) registra quante
    risposte porta via;
  - l'informativa (`src/app/privacy/page.tsx`) lo dice;
  - l'oblio (`src/lib/gdpr/scatola-nera.ts`) toglie anche le copie nuove. `scatola_nera.soggetti_di`
    legge solo `id` e `*_id`: una figlia che nomina la persona solo per `thread_id` va trattata a
    parte.
- **T4, protocollo con copia silenziosa:**
  - `protocolli` e `protocolli_allegati` entrano nella scatola nera, sia per le eliminazioni sia per
    le modifiche;
  - la rettifica (`src/app/api/admin/protocolli/rettifica/route.ts:179-239`) copia il documento
    originale di prima in `<sede>/<anno>/<numero>-versioni/` **prima** del caricamento: l'`upsert`
    resta, ma non sovrascrive più senza copia. Se la copia fallisce la rettifica si ferma con `500` e
    non cambia niente. Le versioni non scadono: un giro di pulizia lascerebbe un battito in
    `app_log`, cioè la traccia che le decisioni #6 e #26 vietano;
  - **nessun log applicativo nuovo** sul protocollo: le decisioni #6 e #26 restano. La copia sta solo
    nel database e nello Storage.
- **Rischio:** crescita del DB; un `INSERT` in più per ogni `DELETE` sulle tabelle calde; oblio
  incompleto.
- **Indietro:** migrazione inversa con `DROP TRIGGER IF EXISTS`; nessun dato si perde.
- **Prova:** i trigger delle eliminazioni passano da 42 a 53 (9 figlie + 2 del protocollo), quelli
  delle modifiche da 13 a 20; entro una settimana
  `select tabella, count(*) from scatola_nera.eliminazioni group by 1` mostra le tabelle nuove; la
  dimensione del DB resta nella stima; una rettifica di prova lascia il documento di prima nel
  percorso di versioni.

### Sessione 4 — Backup alle 02:23, secondo canale d'allarme, bucket, Vault, chiavi (era 4)

- **Obiettivo:** il backup parte di notte; se salta, l'allarme arriva anche quando GitHub tace; quello
  che serve al ripristino è versionato.
- **Misura prima:** gli orari di partenza degli ultimi 14 giri (`gh run list -w backup-notturno.yml`)
  e il p95 server→DB nella punta 07:55–08:05 (il 20/10: 232 ms; il 19/10: 315 ms).
- **Cosa si tocca:**
  - `monitor-esterno/wrangler.toml` riceve un secondo cron `23 2 * * *`;
  - `monitor-esterno/worker.mjs` riceve una funzione nuova, `lanciaBackup`, accanto a
    `suonaCampanello` (riga 65) e chiamata da `giro` (riga 97), che lancia `backup-notturno.yml` con
    `origine=cloudflare`. Non riusa `suonaCampanello`: il suo ripiego «senza input» farebbe un giro di
    prova spacciato per backup. Se GitHub risponde che il workflow è disattivato per inattività
    (`disabled_inactivity`) lo riattiva (`PUT …/actions/workflows/{id}/enable`) e riprova; uno
    spento a mano (`disabled_manually`) resta spento, perché è l'interruttore documentato;
  - `.github/workflows/backup-notturno.yml` riceve l'input `origine`, un `run-name` e una guardia
    «completo già riuscito nelle ultime 20 h», così lo `schedule` di GitHub che arriva tardi non fa
    un secondo giro. La guardia **annulla** il proprio giro (`gh run cancel`, con `actions: write`)
    invece di uscire: un giro uscito finirebbe in `success` e il campanello lo conterebbe come backup
    fatto;
  - `scripts/campanello/valuta.mjs:103-125` conta anche i giri «(da Cloudflare)»;
  - una migrazione idempotente dichiara i 4 bucket che oggi esistono solo in produzione:
    `avvisi_allegati`, `task_allegati`, `form_attachments`, `registro-allegati`. Gli altri 17 su 21
    sono già creati da un `insert` nelle migrazioni. Le impostazioni si leggono dalla produzione;
  - la ricetta del Vault: quella sbagliata, con `ALTER DATABASE SET` (42501), sta in
    `docs/cicd.md:367-369`; il runbook (`docs/runbook-ripristino.md`, scenario E alle righe 208-232 e
    lista di controllo alle 234-241) dice solo «i nomi sono nel manifest». Entrambi diventano
    `vault.create_secret` con l'elenco dei **nomi** delle chiavi, e un lock lega quei nomi a quelli
    letti dai cron con `cron_config('…')`.
- **T2:** `ESCLUDI_BUCKET` (riga 87 del workflow) **non cambia**. Galleria e video originali restano
  fuori.
- **T12, secondo canale:** il Worker manda un'email con Resend sul modello di
  `scripts/campanello/allarme.mjs:120-148` (stesso mittente), in due casi: il lancio del backup è
  fallito (al più un'email per notte) e il campanello non è partito mentre il sito è giù (al più una
  per ora; oggi c'è solo il `console.error` della riga 110). `allarme.mjs` non manda una
  `Idempotency-Key`: la si aggiunge come parametro facoltativo, usato solo dal Worker. Le due variabili, `RESEND_API_KEY` e
  `SENTINELLA_DESTINATARI`, le incolla il titolare come segreti del Worker:
  `npx wrangler@4.148.0 secret put RESEND_API_KEY` e
  `npx wrangler@4.148.0 secret put SENTINELLA_DESTINATARI`. Mai in `wrangler.toml`: il repository è
  pubblico. Se mancano, il Worker lo scrive in `console.error` e non si ferma.
- **T5, chiavi:** il runbook riceve il nuovo percorso delle chiavi, `~/KIDVILLE-CHIAVI-BACKUP/`, fuori dalla cartella dell'app
  (oggi `KIDVILLE-CHIAVI-BACKUP/` è esclusa solo da `.gitignore:46`: un `git clean -x` la
  cancellerebbe), e una casella «revoca della vecchia `sb_secret_` confermata dal titolare nel
  pannello, il gg/mm». Lo spostamento lo fa il titolare: il piano non legge e non tocca le chiavi.
  La regola di `.gitignore` e il suo lock restano, come rete.
- **Rischio:** due giri nella stessa notte se lo `schedule` di GitHub arriva prima del Worker (raro);
  due segreti in più da custodire. Il Worker si pubblica solo dopo il merge, altrimenti GitHub
  rifiuta l'input nuovo con `422`.
- **Indietro:** `npx wrangler@4.148.0 deploy` della versione precedente; revert.
- **Prova:** per 3 notti `gh run list -w backup-notturno.yml` mostra partenze fra 02:23 e 02:35 UTC
  «(da Cloudflare)»; il p95 server→DB in punta rimisurato contro 232 / 315 ms; un lancio volutamente
  fallito fa arrivare l'email di prova.

### Sessione 5 — Prova di ripristino completa (era 14)

- **Obiettivo:** misurare quanto serve a rimettere in piedi DB + file + app partendo da R2, e scrivere
  la ricetta che funziona.
- **Da dove parte:** la prova a pezzi del 06/10 (`docs/prova-ripristino-2026-10.md`,
  `scripts/backup/ripristina-prova.sh`): 175/175 tabelle e 54/54 file uguali, clone su un progetto
  nuovo in ~5,5 minuti. Manca la prova intera, con file e app.
- **T11:** mezza giornata del titolare, con la chiave `age` e la password di `rclone crypt` portate
  dai supporti offline. L'agente prepara script, ordine e controlli; le chiavi le usa solo il titolare.
- **T1:** **niente capitolo PITR.**
- **Cosa si tocca:** uno script nuovo, `scripts/backup/ripristina-progetto.sh`, fa la prova
  completa. `scripts/backup/ripristina-prova.sh` resta com'è: serve allo scenario A e alla prova
  trimestrale, ed è legato a 17 test. L'ordine:
  1. pg_cron spento **per primo** sul progetto temporaneo;
  2. schema e dati;
  3. `auth` e `storage`;
  4. Vault e bucket, con la ricetta della sessione 4;
  5. i file con `rclone copy --size-only`, **mai** `sync`: un `sync` puntato per errore sulla
     produzione cancellerebbe galleria e video, che nello specchio non ci sono, e lo specchio
     `crypt` ha le date sfasate. Le righe di `storage.objects` non si caricano dal dump, altrimenti
     rclone non copierebbe i file;
  6. un deploy di anteprima puntato al progetto temporaneo.

  Le impostazioni di Auth e Storage, senza segreti, si esportano in `docs/impostazioni-supabase/`
  (quelle di Auth solo esportate, non applicate). La pubblicazione Realtime, che il dump non porta,
  si ripubblica da un elenco versionato. `docs/runbook-ripristino.md` riceve i tempi misurati e
  perde tre errori: `read -rsp` (non funziona in zsh), la chiave scritta in un file dentro il
  repository, «specchio dei file 14 GB» (sono ~6,8 GB senza galleria e video). Rimettere i job di
  pg_cron in un disastro vero resta fuori dalla prova, scritto nel runbook come passo mai provato.
- **Rischio:** un progetto temporaneo con i cron accesi chiamerebbe la produzione (per questo pg_cron
  si spegne per primo); i dati veri finiscono in un secondo progetto, che il titolare **cancella a
  fine prova**.
- **Indietro:** non serve: la produzione non si tocca.
- **Prova:** conteggi per tabella uguali al manifest; stesso numero di oggetti per bucket copiato;
  un login di prova sull'anteprima; il tempo di ripristino misurato, scritto nel runbook.

### Sessione 6 — Esiti dei cron: si osserva, non si cambia (era 5)

- **Obiettivo:** l'esito vero di ognuno dei 30 job, HTTP o SQL, a comportamento invariato.
- **Misura prima:** le righe di `net._http_response` delle ultime ~6 h con `timed_out` o
  `status_code >= 400` (il 20/10: 27 senza risposta); l'elenco delle funzioni che chiamano
  `net.http_post`, preso da `pg_proc`.
- **Cosa si tocca:**
  - due tabelle: `cron_chiamate` (job, numero della richiesta, codice HTTP, timeout, errore) e
    `cron_ultimo_esito` (una riga per job, che non scade e quindi copre anche i mensili);
  - una funzione involucro `cron_http_post(job, url, body, params, headers, timeout_milliseconds)`:
    gli argomenti di `net.http_post` più il nome del job, così nei corpi cambia un pezzo solo e i
    valori predefiniti restano quelli di pg_net. Conserva il numero della richiesta. È la forma che
    il lock `cron-http-esito-osservato` oggi pretende solo da `iscrizioni_retention_http`,
    generalizzata; il lock va riscritto, perché oggi riconosce solo i corpi fra `$$` e
    `pg_get_functiondef` usa `$function$`;
  - le funzioni che chiamano il server passano dall'involucro **ognuna con il timeout che ha oggi**:
    5000 ms per la maggior parte, 120000 per `iscrizioni_retention_http`, 300000 per
    `fatture_sdi_sync_tick`, `fatture_coda_tick_http` e `storici_tick`. Nel repo sono 20, fra cui
    `genera_solleciti` (deprecata e senza job: resta fuori) e `video_runner_kick` (un trigger, non un
    job); una esiste solo in produzione. L'elenco vero si prende da `pg_proc`, i corpi da
    `pg_get_functiondef`;
  - un job `cron-esiti` ogni 10 minuti legge `net._http_response` (che dura ~6 h) e
    `cron.job_run_details` (che copre anche i job solo SQL) e scrive in `app_log` un `error`
    `cron-http:<job>` per 4xx/5xx/rete, e un `info` a parte per i timeout del client pg_net, che non
    fermano la route.
- **Rischio:** un corpo copiato dal repo invece che dalla produzione.
- **Indietro:** migrazione inversa che rimette le definizioni; `cron-esiti` spento.
- **Prova:** dopo 24 h `cron_chiamate` copre tutti i job e attribuisce i timeout di ogni 6 ore a un
  job per nome; `cron_ultimo_esito` ha una riga per ogni job di `cron.job` (circa 32 con
  `cron-esiti`).

### Sessione 7 — La salute vede tutto, senza falsi «giù» (era 6)

- **Obiettivo:** `/api/health` sorveglia ogni job, Storage, email, push e allineamento delle
  migrazioni, e non risponde più `503` per lentezza, salvo `db-lettura` e `auth` (vedi l'eccezione
  qui sotto).
- **Misura prima:** 30 richieste di fila a `/api/health` (il 20/10: p50 346 ms, p95 434 ms), che
  lasciano 30 tracce: non di più.
- **Cosa si tocca:**
  - in `src/lib/health/controlli.ts` il controllo dello schema (righe 677-702) passa da un ciclo in
    serie con `count:'exact'` a `Promise.all` senza conteggio, e da `HEAD` a `GET`: con postgrest-js
    2.112 una `HEAD` che riceve 404 senza corpo esce come 204 senza errore, quindi oggi una tabella
    assente non si vede. Lento diventa `degradato`; `giu` (503) resta solo per una tabella che manca o
    non si legge;
  - un controllo `cron-esiti` legge una RPC di sola lettura (nomi e date) sulle tabelle della 6, e
    sorveglia lui i job mensili e quelli di sola SQL: `app_log` tiene 30 giorni
    (`controlli.ts:389-396`), quindi un battito mensile lì non si vede. In `JOB_CRON` entrano solo
    `fascicolo-audit-ip-retention` e `cron-esiti`, ognuno dopo il suo primo esito `ok`;
  - controlli nuovi, tutti al massimo `degradato`, mai `giu`: `storage` (una `list` con limite 1),
    `email` (ultimi esiti di Resend letti da `app_log`, senza chiamare Resend), `push`
    (configurazione + battito), `migrazioni` (ultima versione del repo, fissata alla build, contro
    `max(version)` letto da una RPC);
  - `controlloConfig` guarda tutte le variabili critiche;
  - `src/lib/health/porta.ts:53,79`: il tetto per IP torna in memoria, così la salute non scrive più
    sul DB che misura;
  - il commento del pool di Auth (`src/lib/health/controlli.ts:645-658`, «fisso a 10» alla 647) è
    vecchio: dal 19/10 il pool è al 15 % (13 connessioni su Small, dal rapporto del 20/10). Il Passo 0
    lo rilegge dall'advisor prima di correggerlo;
  - la RPC nuova regge `PGRST202`/`42883` con un insieme locale (§5), e il contatore di email e push
    esclude le righe del gettone OAuth di FCM, che altrimenti conterebbero come invii riusciti.
- Il Realtime non ha una sonda (costerebbe un socket): lo misura la 12.
- **Rischio:** un allarme che suona da solo.
- **Eccezione all'obiettivo, voluta:** `db-lettura` e `auth` restano `giu` anche quando superano il
  tetto di 2 s. Sono gli stessi due controlli di `eseguiVivo` (`src/lib/health/controlli.ts:1413`),
  cioè di `/api/health/vivo`, che risponde 200 su `degradato`: se il loro timeout scendesse a
  `degradato`, un database appeso risponderebbe 200 e il Worker `monitor-esterno` non suonerebbe più.
  Il «niente 503 per lentezza» vale per tutti gli altri controlli.
- **Indietro:** Instant Rollback e revert; le RPC lasciate in piedi sono innocue.
- **Prova:** 30 richieste con p95 ≤ 434 ms e 0 risposte `503` per lentezza in 7 giorni (un `503` di
  `db-lettura` o `auth` si conta a parte e si legge; la seconda misura arriva dopo la
  chiusura della sessione: entra con la regola della §5); nel corpo tanti job quanti
  `select count(*) from cron.job where active` (31 dopo la sessione 6), mai un numero fisso; per ogni
  controllo nuovo un test con numeri letterali che lo costringe a dire «no».
- **A fine sessione:** misura di controllo (§5).

### Sessione 8 — Correggere i cron e l'igiene del database (era 7)

- **Obiettivo:** niente timeout finti, niente chiamate a vuoto ogni minuto, tabelle di servizio con un
  tetto.
- **Misura prima:** i timeout al giorno in `cron_chiamate` (attesi ~108); le chiamate al giorno a
  `/api/admin/storici/cron` (attese ~1.440); le righe di `cron.job_run_details` (il 20/10: 93.577);
  la durata massima di `idle in transaction` in `pg_stat_activity` su più letture.
- **Cosa si tocca:**
  - il timeout passato all'involucro diventa il `maxDuration` della route (lock
    `cron-max-duration`). `video_runner_kick` è un trigger che parte a ogni caricamento video: a
    300 s occuperebbe un posto di pg_net per ogni caricamento, quindi su quello decide il titolare;
  - `storici_tick` non chiama il server se `storici_generazioni` non ha lavoro, e il suo
    `exception when others then raise warning` scrive in `app_log`;
  - un job tiene 14 giorni di `cron.job_run_details`;
  - `ALTER ROLE service_role, authenticated, anon SET idle_in_transaction_session_timeout = '60s'`:
    non `ALTER DATABASE`, che dà 42501; non su `postgres` né sul ruolo del backup. Se il ruolo che
    applica le migrazioni non ha il permesso, la migrazione lo scrive in `app_log` come `error` e
    prosegue. Le sessioni `idle in transaction` di oggi potrebbero essere di `authenticator`,
    `postgres` o del backup: il Passo 0 lo misura, e su quei ruoli decide il titolare;
  - promemoria (`src/app/api/notifiche/promemoria/route.ts`): una colonna nuova,
    `notifiche.chiave_dedup`, con indice unico e `on conflict do nothing`. Un indice sulle colonne di
    oggi è impossibile, perché il promemoria ripetuto ogni N giorni è un doppione legittimo;
  - sync delle fatture (`src/app/api/pagamenti/fattura/sync/route.ts`): presa con scadenza sul
    modello di `supabase/migrations/20261010230945_code_robuste_prese_con_scadenza.sql`.
- **T7:** `app_log_purge` (`supabase/migrations/20260713090000_app_log.sql:226-251`, ma il corpo si
  prende da `pg_get_functiondef` in produzione) tiene le righe `error` per 90 giorni; gli altri
  livelli restano come oggi. L'informativa dice «log tecnici: 30 giorni»: riceve una versione nuova,
  che il titolare rilegge.
- **Rischio:** i 60 s interrompono una transazione legittima; timeout lunghi tengono aperte più
  richieste pg_net (col filtro di `storici_tick` il problema scompare); `app_log` cresce (misurarla
  prima e dopo).
- **Indietro:** migrazione inversa (timeout a 5000, `ALTER ROLE … RESET`, job nuovi tolti, purge come
  prima).
- **Prova:** timeout in `cron_chiamate` da ~108 al giorno a 0; chiamate a `/api/admin/storici/cron`
  da ~1.440 al giorno a qualche decina; `cron.job_run_details` stabile intorno a 14 volte le righe di
  un giorno (±15 %); `pg_roles.rolconfig` dei tre ruoli contiene
  `idle_in_transaction_session_timeout=60s` (sono ruoli senza login: `SET ROLE` non applica le loro
  impostazioni, quindi `show` non lo prova); la riga `error` più vecchia
  di `app_log` ha fra 80 e 90 giorni, una volta passati.

### Sessione 9 — Email e fornitori senza successi finti (era 8)

- **Obiettivo:** un sollecito conta come inviato solo se un'email è partita; un fallimento lascia la
  voce al giro dopo.
- **Misura prima:** le voci con la cadenza avanzata e nessun destinatario raggiunto nell'ultimo giro;
  gli esiti di Resend in `app_log` degli ultimi 7 giorni.
- **Cosa si tocca:**
  - `src/lib/pagamenti/solleciti-invio.ts:401-406`: se nessun destinatario è stato raggiunto, la
    presa si annulla (`update … set ultimo_sollecito_il = <precedente> where … and
    ultimo_sollecito_il = <presa>`), esito `ok:false`, log `error`; riga 485: esito con i conteggi
    inviate/tentate; il registro dei solleciti si scrive anche quando l'invio fallisce;
  - `src/lib/email/send.ts:242-287`: al massimo 3 tentativi, rispettando `Retry-After` (tetto 10 s),
    con la **stessa** `Idempotency-Key`: il 429 sempre, 5xx e rete solo se la chiave c'è. Li chiede
    solo il giro automatico; il bottone manuale resta senza ritentativi. Il giro **non** si
    parallelizza;
  - `src/app/api/pagamenti/solleciti/run/route.ts:212`: il battito riporta inviate/fallite/rinviate;
  - `src/lib/translate/claude.ts:38-45`: `timeout` esplicito e `fetch` da `externalFetch`;
  - `src/app/api/news/cron/run/route.ts:294`: `segretoCronValido`;
  - `maxDuration` sulle 20 route lunghe (19 a 300 s, `chat/translate` a 60 s), col lock
    `cron-max-duration` allargato. Lo allarga anche la sessione 8: la 9 parte dal lock come la 8 l'ha
    lasciato.
- **Rischio:** l'annullamento della presa potrebbe far rispedire un'email partita la cui ricevuta si è
  persa: per questo si annulla solo quando **nessun** invio è riuscito, e un esito incerto (scadenza
  senza risposta, `409 concurrent_idempotent_requests`) non la annulla: il sollecito slitta di una
  cadenza invece di rischiare due invii. I ritentativi stanno dentro il tetto del giro (240 s).
- **Cambia per le famiglie:** se nessuna email parte, non parte nemmeno la push del sollecito e il
  livello non sale; oggi una voce senza indirizzi riceve la sola push. Il registro scritto anche sui
  fallimenti si legge con un filtro sui livelli recapitati, altrimenti il livello salirebbe senza
  email. Il Passo 0 conta i casi di oggi; decide il titolare.
- **Indietro:** revert; solo codice.
- **Prova:** in produzione 0 voci con la cadenza avanzata e tutti i destinatari non raggiunti; test
  con un Resend finto che risponde 429, 500 o cade la rete.

### Sessione 10 — Operazioni a più passi senza perdite (era 9)

- **Obiettivo:** nessun passo irreversibile (file cancellati) prima dei passi che possono fallire.
- **Scadenza:** in produzione **entro metà dicembre**, prima della riapertura degli scrutini di
  gennaio.
- **Misura prima:** quante eliminazioni del personale, riaperture di scrutinio e modifiche di note
  negli ultimi 90 giorni, per sapere quanto spesso il percorso gira davvero. `app_log` tiene 30
  giorni: i 90 si leggono da `audit_scritture_docente`.
- **Cosa si tocca:**
  - eliminazione del personale (`src/app/api/admin/staff/eliminazione/route.ts:440-468` e
    `src/lib/personale/cancella-fascicolo.ts`): prima i permessi, poi pratica, anagrafica e `utenti`
    in una RPC sola (`personale_elimina_dipendente`), poi l'account di accesso, infine i file in un
    prefisso di cestino. Il giro `cestino-registro-retention` oggi lavora per righe e non conosce il bucket del
    personale: riceve un passo nuovo, con lo stesso termine del cestino del registro;
  - riapertura dello scrutinio (`src/app/api/primaria/scrutinio/riapri/route.ts:160-199`, il passo 2
    alle 185-194): le pagelle consegnate vanno in `ritirate/<scrutinio>/` e la riga si marca
    ritirata. Le colonne nuove sono due, `pagelle.ritirata_il` e `pagelle.file_ritirati`, perché il
    vincolo su (scrutinio, alunno) tiene una riga sola per alunno; ripiego `42703` in CI. Toccano
    anche l'eliminazione della pagella (ritira la riga invece di cancellarla), l'oblio (toglie anche
    le copie ritirate) e gli storici (esportano tutte le versioni);
  - modifica di una nota (la `PATCH` di `src/app/api/primaria/note/route.ts:569-701`; la `DELETE`
    alle 704-730 resta fuori): la presa visione si toglie solo se cambia il testo, dentro una RPC
    transazionale (`note_modifica`). Data, categoria e «firma richiesta» non la tolgono più;
  - compensazioni di merchandise e sedi: un test ciascuna, oppure un rinvio motivato nel PRD.
- **Decisioni del titolare:** il piano ne elenca dieci in fondo (fra cui: account senza profilo se
  la cancellazione su Auth fallisce, informativa che non nomina cestino del personale e pagelle
  ritirate, pagelle ritirate senza un termine di conservazione). Si mostrano al titolare alla fine
  del Compito 1, prima di qualunque codice.
- **Rischio:** cambia il comportamento della riapertura a ridosso del primo quadrimestre.
- **Indietro:** revert; le colonne nuove restano inerti. Il codice di prima non svuota il cestino del
  personale e non rimette `ritirata_il` a vuoto: il piano dà i conteggi e l'`UPDATE` da mostrare al
  titolare.
- **Prova:** test col secondo o terzo passo che fallisce → nessun file cancellato; oggetti in
  `ritirate/` dopo la prima riapertura vera.

### Sessione 11 — Letture che non si troncano (era 10)

- **Obiettivo:** nessun elenco restituisce in silenzio solo le prime 1000 righe.
- **Misura prima:** `select count(*) from student_parents;` e i conteggi delle altre tabelle lette
  dalle route qui sotto; se uno supera già 1000, la sessione si anticipa (§3).
- **Cosa si tocca:**
  - `src/lib/logging/supabase-fetch.ts`: una `GET` che riceve almeno 1000 righe, con totale ignoto o
    più grande e senza un `limit` più grande delle righe arrivate, ha toccato `max_rows`
    (`supabase/config.toml:18`) → `warn` `max-rows-raggiunto` con la route. La regola «`Content-Range`
    che finisce a 999» scatterebbe su ogni prima pagina letta a blocchi;
  - `leggiABlocchi` esce dai pagamenti verso `src/lib/db/`, accanto ad `aBlocchi`, e si riusa, con
    un'opzione `chiave` per l'ordine: `student_parents` non ha `id`, la sua chiave è
    `(student_id, parent_id)`;
  - si sistemano `src/app/api/admin/parents/route.ts:114-163`,
    `src/app/api/admin/presenze/realtime/route.ts:48-64` (gli iscritti e anche le presenze di oggi,
    il cui `.limit(5000)` `max_rows` ignora), il controllo del testo di classe in
    `src/lib/health/controlli.ts:1044-1077`, `src/app/api/tasks/route.ts:492-506` e
    `src/app/api/avvisi/route.ts:385-421`;
  - un lock sui file toccati.
- **Rischio:** più richieste per pagina; con un ordine non stabile, righe doppie o mancanti (per
  questo ogni lettura a blocchi ordina per una chiave unica).
- **Indietro:** revert.
- **Prova:** nei 7 giorni dopo, `max-rows-raggiunto` va a 0 sulle letture toccate dalla sessione
  (le altre, se compaiono, sono il prossimo lavoro e vanno nelle «Note»); il totale dell'elenco genitori coincide
  col `count(distinct …)` SQL delle stesse sedi.

### Sessione 12 — Chat leggera (era 12)

- **Obiettivo:** l'elenco delle conversazioni costa poche query, non ~4 per conversazione ogni 30 s.
- **Misura prima:** le richieste al DB per una `GET` dell'elenco (il 20/10: ~150 con 37
  conversazioni); gli errori `chat-realtime-errore%` per giorno feriale (288–378).
- **Cosa si tocca:**
  - `src/app/api/chat/threads/route.ts:43-176` (la `GET`): una RPC di riepilogo con ripiego sul
    percorso attuale. Su `PGRST202`/`42883` il ripiego scrive una riga `info` (§5); su ogni altro
    guasto della RPC, o una risposta di forma inattesa, ripiega lo stesso con una riga `error`, così
    la lista non si svuota mai. L'`UPDATE` di `delivered_at` (`marcaConsegnati`) esce dalla `GET` e
    diventa una richiesta esplicita, `POST /api/chat/threads/consegnati`;
  - `src/components/features/chat/useConversazioneChat.ts:242-247,674`: un poller solo;
  - `src/app/api/chat/messages/route.ts:110-198` (`programmaDispatchChat`): un solo dispatch
    programmato per finestra di 30 s, per conversazione e per istanza (non per sede);
  - `src/components/features/chat/useChatRealtime.ts:301-310`: un `1006` seguito da riconnessione
    riuscita non si scrive (lato client non c'è un `info` persistito); se dopo 60 s il canale è ancora
    giù, resta il `warn` di oggi.
- **Decisioni del titolare, chieste al Compito 1:** la route nuova entra fra le esenti del lock
  `isolamento-sede-coverage` (uno in più del numero lasciato dalla sessione 2, che lo porta a 107: un
  numero che di solito cala solo); la finestra per
  conversazione invece che per sede; il `1006` rientrato non scritto. Il piano è scritto per il sì.
- **Effetto visibile:** i messaggi nati prima della colonna `delivered_at` non ricevono più la doppia
  spunta all'apertura dell'elenco.
- Non dipende più dalla sessione d'identità: le due misure restano separabili perché la 14 è in fondo
  e condizionale.
- **Rischio:** contatori dei non letti sbagliati; notifiche della chat in ritardo.
- **Indietro:** revert; la RPC è innocua.
- **Prova:** richieste al DB per una `GET` da ~150 a ≤ 5; gli errori realtime separati fra
  interruzioni vere e riconnessioni.

### Sessione 13 — Bordo pubblico: cache, firewall, errori, login, build (era 13)

- **Obiettivo:** le route pubbliche reggono il traffico senza mostrare errori interni, e la cache che
  il codice già chiede funziona davvero.
- **Misura prima:** `x-vercel-cache` su `/api/iscrizione/sedi` per due richieste di fila (il 20/10:
  MISS 23/23 alle 12:34 e 2/2 alle 13:19); le sfide `403` del giorno; i «Failed to fetch» e «Load
  failed» per giorno feriale.
- **Cosa si tocca:**
  - **S8, prima la diagnosi.** Il codice manda già `s-maxage` (`src/lib/security/cache-pubblica.ts`,
    usato da `src/app/api/iscrizione/sedi/route.ts:63`) e la CDN lo consuma, quindi il client non lo
    vede: l'assenza non prova un difetto, la prova è `x-vercel-cache`. Su un'anteprima si prova
    nell'ordine: `Vercel-CDN-Cache-Control`, poi `Vary` senza `Cookie`. Si corregge solo quello che
    l'anteprima ha mostrato. Causa probabile, segnalata dall'agente che ha scritto il piano e non
    ritrovata da me nella documentazione: una risposta con `Vary: Cookie` non viene conservata; in
    quel caso vince il secondo tentativo. Le anteprime sono protette: per misurarle serve un link di
    condivisione creato dal titolare, altrimenti la diagnosi si fa in produzione su
    `/api/iscrizione/sedi` sola. Poi si misura se i «Failed to fetch»/«Load failed» coincidono con le
    sfide `403`;
  - **T8, firewall:** regole di limite di frequenza su `/api/iscrizione/*`, `/api/forms/*`,
    `/api/public/*` e `/api/health*`, scritte in `docs/cicd.md`, con un'eccezione, solo su
    `/api/health*`, per chi chiama la salute dall'esterno (il Worker `monitor-esterno` e il
    campanello, user agent `kidville-campanello`). Si accendono in modalità **«log» per 7 giorni**;
    il registro del firewall su Pro tiene 24 ore, quindi sono 7 letture giornaliere. Il blocco si
    decide solo con quei numeri. Le regole le applica il titolare dal pannello, oppure l'agente con la sua
    approvazione esplicita;
  - una funzione che risponde al client solo con un `codice` e registra l'errore intero, subito sui
    4 handler anonimi (9 risposte), con un lock che vieta `error.message` nelle porte anonime; le
    altre (219 righe in 108 file, quasi tutte su route autenticate) si sistemano quando una sessione
    **successiva alla 13** tocca il loro file, con la funzione che la 13 introduce; le sessioni prima
    della 13 non le toccano;
  - il catch muto di `src/app/api/notes/route.ts:146-155` e gli accessi allo Storage senza `error`
    (2 `createSignedUrl` e 6 `listBuckets()`);
  - `build` in `package.json` con `NODE_OPTIONS=--max-old-space-size=6144`, come in CI.
- **T9:** **niente Turnstile.** La sessione scrive in `docs/cicd.md` solo la ricetta per contare i
  tentativi di login falliti dai log di Auth (`query_logs`, finestra e filtro), da rifare alla
  prossima misura.
- **Rischio:** una regola firewall che blocca l'app nativa: per questo prima in «log».
- **Indietro:** revert; regole disattivabili dal pannello.
- **Prova:** `x-vercel-cache: HIT` dalla seconda richiesta; sfide al giorno nel registro del firewall;
  il lock diventa rosso su una regressione.
- **A fine sessione:** misura di controllo (§5).

### Sessione 14 — Identità, condizionale (era 11)

- **Obiettivo:** abbassare il costo dell'identità **solo se** una misura dice che serve.
- **Passo 0, la soglia (T10).** In un giorno feriale, con la query 2 bis e il filtro su
  `/auth/v1/user`, si misurano il p95 nella punta 07:55–08:05 UTC e le chiamate nelle 24 h. Si
  procede **solo se** il p95 in punta supera **300 ms** **oppure** le chiamate superano **200.000**
  nelle 24 h. Il 20/10: p95 sulle 24 h 201 ms, 146.787 chiamate. Sotto la soglia il piano si chiude
  con «non serve», la misura con data e ora UTC, e una riga nella tabella di stato.
- **Va scritto che riapre una scelta del titolare.** Il 12/10 (sessione 10 della prima serie)
  `getClaims()` sulle letture è stato scartato: un account revocato leggerebbe fino a 1 h. Procedere
  vuol dire riaprire quella decisione con il numero nuovo, e chiederla di nuovo al titolare prima del
  primo compito.
- **Se si procede:**
  - verificare che il token sia firmato `ES256`: lo era già il 05/10, e il middleware lo verifica già
    in locale (`src/middleware.ts`: cache delle chiavi alle righe 207-283, `getClaims` alle 375-408);
    se non lo fosse, `getClaims()` non darebbe niente in più;
  - `getClaims()` **solo sulle letture**, in `src/lib/auth/require-staff.ts:272` e
    `src/lib/auth/profili.ts:103`; la cache delle chiavi esce dal middleware in un modulo condiviso,
    che gira sia su Edge sia su Node;
  - `getUser()` resta su scritture, operazioni distruttive, `src/app/api/me/route.ts:41` e, anche in
    `GET`, su `require-staff.ts:337` (la pagina del modulo da firmare con OTP) e `:706` (cambio
    password e PDF firmati);
  - `risolviDaAuthUid` (righe 207-211) si ricorda per la durata della richiesta nel contesto di
    `src/lib/logging/context.ts`, aperto da `withRoute`: **non** con `cache()` di React, che nelle
    route non ricorda niente.
- **Rischio:** un account disattivato resta valido sulle letture fino alla scadenza del token;
  regressioni di autorizzazione, coperte dai test delle API e dall'E2E in CI.
- **Indietro:** Instant Rollback e revert.
- **Prova:** `/auth/v1/user` sotto 30.000 al giorno; letture di `utenti` + `parents` sotto 150.000
  (il 20/10: 396.694); p95 in punta contro i numeri del passo 0. I due tetti potrebbero non essere
  raggiungibili (`/api/me` resta su `getUser()`, e la memoria per richiesta toglie solo le letture
  doppie): si misurano e si riportano, senza aggiungere codice per inseguirli.

---

## 8. Cosa NON fare

Viene dalla §3.5 del rapporto, con i numeri delle sessioni aggiornati a questa serie.

1. **Non alzare l'istanza.** Il DB lavora all'1,5 % di un core; in calma il p95 è 33 ms. Il p95 sale
   solo in punta, quando il backup si sovrappone (sessione 4), e per il carico d'identità
   (sessione 14).
2. **Non ottimizzare la lettura del WAL del Realtime.** Il 79,9 % è un cumulato dal 06/08; il 20/10
   fa 0 chiamate.
3. **Non allargare il pool di Auth né `TETTO_CONTROLLO_MS`.** Le cause sono il numero di chiamate e il
   ciclo in serie, non i limiti.
4. **Non riapplicare migrazioni a mano.** Il 20/10: 231 = 231; manca solo l'allarme (sessione 7).
5. **Non eliminare i 137 indici «mai usati»** (D11): molti servono alle cascate e ai freni `RESTRICT`.
6. **Non togliere `current_parent_student_ids` ad `authenticated`** (D11): spegnerebbe l'app dei
   genitori.
7. **Non fondere le 5 policy permissive e non aggiungere policy alle 68 tabelle senza.** Con la CPU
   all'1,5 % il guadagno è nullo, e «negato a tutti» è la scelta voluta.
8. **Non spostare `pg_net` fuori da `public`** (D11).
9. **Non alzare `max_rows` sopra 1000** per risolvere S6: il muro si sposta e resta silenzioso.
10. **Non parallelizzare il giro dei solleciti e non costruire una coda email generale.** 238 voci in
    104 s sono già vicine al limite d'invio di Resend; ritentativi e annullamento della presa bastano
    (S2-B resta un'opzione per dopo).
11. **Non svuotare `cron.job_run_details` e non allungare i timeout di pg_net prima della sessione 6**
    (si fa nella 8).
12. **Non portare il login su una route del server** (S11-C).
13. **Non spegnere la protezione automatica di Vercel** per la sfida vista durante la misura: era un
    client di prova. Prima la cache, poi la misura delle sfide vere.
14. **Non usare `ALTER DATABASE SET`** (42501): `ALTER ROLE` per i timeout, il Vault per la
    configurazione dei cron.
15. **Non usare `cache()` di React per l'identità nelle route API**: fuori dai componenti server non
    ricorda niente **[S3b]**.

E tre divieti che vengono dalle decisioni di questa serie:

16. **Non aggiungere la galleria al backup** e non accendere il PITR dentro un piano (T1, T2): si
    ridecide alle soglie della §4.
17. **Non accendere Turnstile** (T9) e **non mettere in blocco** una regola firewall prima dei 7 giorni
    in «log» (T8).
18. **Non rispondere `ask` dal freno della sessione 2**: verrebbe approvato in automatico.
