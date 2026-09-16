# Fatture dei pagamenti — piano approvato

> Esecuzione con Superpowers: TDD, revisione distinta di requisiti e qualità, verifica prima del completamento. Ogni incarico ha un solo responsabile e una revisione GPT-6 Astra; un rilievo torna a un esecutore diverso. Gli incarichi indipendenti procedono in parallelo entro gli slot disponibili.

## Obiettivo e decisioni dell'utente

- Aprire dentro Kidville il PDF originale Aruba della fattura collegata al pagamento.
- Fattura ordinaria intestata al padre: visibile anche alla madre autorizzata, e viceversa. Vale anche per intestatario terzo.
- Soltanto per fatture emesse a quote separate: ciascun genitore vede la propria. La modalità è quella all'emissione, mai dedotta dalla configurazione corrente.
- Storico: verifica staff correggibile prima dell'attivazione del filtro per sede. Casi esaminati ma irrisolti nascosti ai genitori dopo attivazione.
- Nessuna nuova build store. Nelle app senza Filesystem, comando esplicito «Apri nel browser per salvare», URL firmato valido 300 secondi. Il possessore del collegamento può usarlo fino a scadenza: scelta approvata.
- L'approvazione comprende migrazioni, push, PR, merge e deploy dopo tutti i gate; non autorizza a inventare classificazioni dello storico.

## Contratti e responsabilità

Schema: `fatture_emesse.modalita_emissione` nullable (`ordinaria`, `quote_separate`); null indica storico non classificato. `parent_registry_id` è lo snapshot dell'intestatario. `admin_settings.fatture_visibilita_attiva_il` controlla l'attivazione per sede. Tabella separata `fatture_visibilita_revisioni`: fattura, modalità proposta (`ordinaria`, `quote_separate`, `irrisolta`), intestatario verificato, attore e data. Nessun backfill automatico. Le revisioni sono correggibili durante la preparazione; l'attivazione finalizza gli snapshot verificati in transazione e lascia null gli irrisolti.

Policy condivisa: il gate famiglia/sede precede sempre il filtro. Flag assente di attivazione mantiene il comportamento preparatorio; errori di lettura non concedono accesso. Staff autorizzato nella sede vede tutte le righe; un account staff-genitore fuori sede segue le regole famiglia. Elenco, GET PDF e collegamento esterno riusano la medesima policy. Il fallback PDF legacy valuta il registro totale, non soltanto le righe visibili.

Viewer: modale esistente, caricamento differito di `unpdf` preceduto dai polyfill `core-js`, una pagina alla volta, zoom, testo accessibile, abort/cancel/destroy. Apri e Scarica sono operazioni separate. GET `esterno=1` restituisce JSON no-store con URL firmato dopo gli stessi gate; combinazioni ambigue con download rifiutate. Nessun token/URL o contenuto personale nei log.

## Incarichi

- [x] Schema e protezione snapshot — Sol, critico Astra: PASS; 15/15 test statici e PostgreSQL PGlite, inclusi privilegi e spoof ruolo. RPC successive SECURITY INVOKER, execute solo service_role, GUC locale nella transazione.
- [x] Snapshot nel writer emissione e preflight prima Aruba — Sol, critico Astra: PASS; 67/67 test indipendenti.
- [x] Helper condiviso visibilità — Sol, critico Astra: PASS dopo correzione esecutore distinto; 20/20 test policy + lock errori.
- [x] Integrazione policy su elenco e PDF — Sol, critico Astra: PASS dopo correzioni UUID e verifica esplicita sede fattura/pagamento da esecutore distinto; ultimo riesame indipendente 83 test verdi, incluso conteggio totale per fallback.
- [x] RPC/route revisione e attivazione storico — Sol, critico Astra: RPC PASS dopo correzione attore/sede da esecutore distinto, riesame 33/33; API GET e operazioni PASS, verifica congiunta indipendente 100/100 con lock.
- [x] Interfaccia staff revisione storico — Sol, critici Astra: PASS finale dopo correzioni da esecutori distinti su cambio sede, risposte tardive, refresh 409, replay StrictMode e contrasto. Riesame finale indipendente 13 test persistenti e 12 StrictMode verdi; snapshot/conferma esatti e audit preservati.
- [x] Adattatore compatibilità PDF — Sol, critico Astra: PASS bootstrap; test rendering demandati al viewer e al collaudo reale.
- [x] Viewer interno accessibile — Sol, critico Astra: PASS dopo correzione da esecutore distinto della rejection durante cancellazione; 13/13 test indipendenti viewer+adattatore. Rendering reale ancora nel gate E2E.
- [x] Link temporaneo e salvataggio esterno — Sol, critici Astra: PASS finale endpoint firma e client dopo correzioni da esecutori distinti; native 54 test persistenti e 3 prove critiche indipendenti verdi, incluse cancellazione import Share, cleanup e mutex.
- [x] Integrazione pulsanti — Sol, critico Astra: requisiti PASS; qualità PASS finale dopo correzione feedback salvataggio dentro viewer da esecutore distinto. 14 test persistenti e 4 prove indipendenti verdi; precedenti 66 integrazione verdi.
- [x] Telemetria visualizzazione e passaggio al browser — Sol, critico Astra: PASS, 53 test indipendenti. I collegamenti ai pulsanti saranno verificati nell'integrazione.
- [ ] E2E con fatture presenti — Sol, critico Astra.
- [x] PRD e documentazione — Terra, critico Astra: PASS finale dopo correzione circoscritta da nuovo esecutore delle etichette e dello stato; rollout, visibilità e limiti del collaudo documentati.

## Gate e rollout

Test: ordinaria condivisa, quote proprie/altrui, split impliciti/parziali, bridge fallito, IDOR, multisede, staff-genitore, storico irrisolto, revisioni correggibili, attivazione bloccata con righe non esaminate, schema mancante con zero invii Aruba. E2E Chromium/WebKit con PDF sintetico multipagina e rendering effettivo. Prove app già installate iOS/Android con build di produzione, font reali, zoom, ciclo apertura/chiusura, handoff browser e ritorno. Il solo fallback download non soddisfa il gate viewer.

ESLint zero warning, typecheck, Vitest completo, build, E2E CI, log sui percorsi toccati. Deploy preparatorio e strumenti prima; attivazione filtro solo dopo verifica staff. Dopo rilascio riuscito, pulizia branch secondo AGENTS.md. Non dichiarare superate prove non eseguite.

## Evidenze iniziali

Al 2026-09-16: branch iniziale main, unica modifica preesistente `supabase/.temp/cli-latest` da preservare. Cinque PDF del bucket letti e parsati correttamente; log production iOS/Android segnalano plugin Filesystem assente, ripiego condivisione fallito e timeout. Le quattro suite mirate preesistenti passano 33 test ma non riproducono il guasto client. Conteggio iniziale 324 fatture, 317 con riferimento PDF; da rimisurare prima di applicare migrazioni. Nessuna sessione genitore disponibile nel browser abilitato durante la pianificazione.

Inventario locale per il collaudo: simulatori iOS 26.2, nessun runtime iOS 15 e nessun dispositivo Android collegato. Sul simulatore `B9FA2E7A-979A-41DB-834B-D7A7B0A03916` è già installata Kidville 1.0 build 4, con server `http://localhost:3100` e senza Filesystem: può ospitare il collaudo della build web di produzione senza ricompilare la shell. Questa disponibilità non costituisce una prova sul dispositivo reale o sulla baseline iOS 15.

Ricontrollo read-only durante l'implementazione: 354 fatture, nessuna senza pagamento collegato, nessuna con sede diversa dal pagamento. Sono conteggi correnti, non una garanzia strutturale dello schema.

Inventario Android aggiornato: avviato emulatore già presente `KV-api30` (`emulator-5554`), Kidville già installata con server `http://10.0.2.2:3100`, senza plugin Filesystem. Non è stata ricompilata o reinstallata la shell. La prova delle fatture deve ancora essere eseguita.

Per il collaudo corrente è stato poi chiuso `KV-api30` (WebView 91) e avviato `KV-play-phone` (Android 36.1, WebView 150.0.7871.181). Anche qui Kidville è già installata, punta a `http://10.0.2.2:3100` e non ha Filesystem. Nessuna installazione o modifica del pacchetto nativo.

Preflight rilascio in sola lettura: `supabase migration list --linked` mostra lo storico allineato e soltanto le due nuove migrazioni `20260916120000` e `20260916120100` non applicate. Nessuna migrazione è stata eseguita durante questo controllo.

Successivamente applicate entrambe le migrazioni SOLO al progetto `kidville-web-ci`, mediante CLI isolata in `/private/tmp/kidville-fatture-ci-verifica`. Prerequisiti verificati prima; verifica finale: colonna snapshot presente, entrambe le RPC presenti, zero sedi attivate. Eseguito reload della cache PostgREST. Il collegamento del repository e il database di produzione sono rimasti invariati.

## Verifica integrata intermedia

Prima build di produzione e controllo postbuild PASS (2688 file JavaScript). Primo gate completo Vitest: 1302 file verdi, 7 file rossi; 17810 test verdi e 9 falliti. Rilievi: token del pannello staff, inventari timeout/trasporto, fotografie schema da aggiornare e vincolo FK della sede mancante nella nuova tabella audit. Questi rilievi sono aperti: il gate non è dichiarato superato. ESLint globale zero warning.

Revisione salvataggio nativo: fetch/write/getUri e mutex corretti, ulteriore FAIL su import differito del plugin Share; assegnato nuovo esecutore alla propagazione del segnale nei due helper Share. Pulsanti: requisiti PASS, qualità FAIL perché l'errore di salvataggio dal viewer compareva soltanto nel contenuto sottostante reso inerte dalla modale; correzione ancora da eseguire.

Build web in esecuzione su localhost3100; entrambe le shell native già installate si aprono correttamente e mostrano login. Nessuna sessione utilizzabile presente: richiesto all'utente accesso con account di collaudo o ubicazione della configurazione credenziali, senza password in chat. Nessun PDF reale ancora collaudato nelle app.

Conteggio di produzione in sola lettura del 2026-09-16: 696 domande di iscrizione, 358 fatture. Schema di produzione ancora invariato.

Fallback di altezza iOS15 del viewer: esecutore distinto ha aggiunto `vh` con override `dvh` dentro feature query. Critico Astra PASS su CSS compilato e prove WebKit a 375×667 e 667×375, inclusa simulazione del ramo senza dvh e scorrimento in entrambe le direzioni. Non è una prova su iOS15 reale.

## Preparazione schema applicata

Dopo PASS dedicato del critico sulla FK della nuova tabella audit (19/19 test PostgreSQL), riapplicata la migrazione corretta in CI e applicate in produzione con `supabase db push --linked --yes` soltanto le due versioni previste dal dry-run: `20260916120000` e `20260916120100`. Verifica di produzione: zero sedi attivate, zero revisioni, zero righe audit, zero fatture classificate, FK sede presente. Nessun filtro attivato, nessuna revisione delle fatture eseguita. Cache PostgREST ricaricata.

Fotografie rigenerate dai cataloghi reali di produzione usando i generatori esistenti: 43 policy non-service-role, 74 tabelle con scuola_id tutte con FK, 217 indici unici. Due lock temporali restano rossi alle 11:51 UTC perché i nomi delle migrazioni indicano 12:00/12:01 UTC: occorre ripetere le letture dopo le 12:01, senza falsificare timestamp o contenuti.

Salvataggio nativo: riesame finale Astra PASS, 54 test persistenti e 3 prove critiche indipendenti, inclusa cancellazione durante import Share. Interfaccia staff: correzione token completata; nuovo riesame lifecycle trova FAIL in StrictMode al cambio sede, correzione ancora da eseguire.

E2E aggiunto con PDF sintetici multipagina e incluso in Chromium/WebKit; raccolta e lock configurazione verdi. Entrambi i tentativi locali si fermano al login per refresh token scaduto: rendering del percorso autenticato non ancora dimostrato.

Collaudo renderer isolato: Sol ha costruito un harness soltanto in `/private/tmp/kidville-fatture-renderer-harness`, con import diretti dei componenti reali, CSS applicativo, PDF.js e PDF sintetici multipagina. Critico Astra ha ricompilato e rieseguito indipendentemente: 4/4 PASS Chromium/WebKit, inclusi pixel, testo, pagine, zoom, chiudi/riapri, cambio documento e ripristino delle sei API mancanti simulate. Screenshot WebKit ispezionato. Questo PASS non sostituisce il gate autenticato né la prova nativa con documento Aruba reale. Implementazione dello spec E2E autenticato e raccolta 2 casi su due motori: PASS alla review, esecuzione ancora pending.

Contrasto dei due avvisi salvataggio PDF corretto da nuovo esecutore: `error-strong` su bianco 5,62:1; critico Astra PASS con 42 test indipendenti. Documentazione Terra corretta e riesaminata Astra PASS.

Fotografie dei cataloghi di produzione rigenerate nuovamente dopo le 12:01 UTC, senza modifiche manuali dei timestamp. Typecheck ed ESLint completo verdi. Nuova build/postbuild verdi: 2689 file JavaScript esaminati. Secondo giro completo Vitest in corso. L'inventario timeout resta in microcorrezione dopo il rilievo del critico sul rilevatore ASI; nessuna modifica funzionale del viewer necessaria.

## Gate locali conclusivi

Tutti gli incarichi di implementazione e documentazione hanno PASS dei critici Astra. L'ultimo controllo timeout è stato risolto in modo circoscritto: scanner preesistente invariato, terminatore della costante viewer conforme e prova positiva/mutazione oltre 30 s. Critico Astra esplicito PASS sui controlli statici; root ha poi eseguito l'intera suite fuori sandbox: **1311 file / 17826 test PASS**, nessuno saltato. ESLint completo zero warning, typecheck e build/postbuild PASS. Il solo ultimo cambiamento del viewer è il terminatore della costante, senza differenza di comportamento rispetto alla build verificata.

PR in preparazione per eseguire CI/E2E con le credenziali dell'ambiente isolato. Merge, pubblicazione, verifica pubblicata e pulizia branch restano pendenti: il collaudo nativo del PDF Aruba richiede ancora l'accesso di test chiesto all'utente. Nessuna attivazione del filtro o revisione automatica dello storico.

## Collaudo iOS con PDF Aruba reale — evidenza parziale

Il 2026-09-16, sull'app Kidville già installata (versione 1.0, build 4) in simulatore iPhone 17 Pro con iOS 26.2, collegata alla build web di produzione avviata localmente, è stata aperta dalla UI una fattura Aruba reale con una sessione genitore di collaudo. Non è stata ricompilata o reinstallata la shell nativa.

- La richiesta del documento ha risposto `200` con `application/pdf`; il PDF originale conservato nello storage è risultato coerente con quello ricevuto. Il documento, di una pagina, è stato renderizzato su canvas.
- Sono stati osservati testo leggibile, zoom al 125% e scorrimento orizzontale per ispezionare entrambe le estremità del documento.
- **FAIL parziale:** il pulsante visibile di chiusura non reagisce al tocco nel suo centro, né tramite la relativa etichetta accessibile; reagisce soltanto vicino al bordo inferiore. Il comportamento è compatibile con una sovrapposizione della safe area/status bar e lascia inattiva una parte sostanziale del target touch.

Una correzione della safe area è in corso. Il retest iOS resta pendente e questa evidenza non costituisce un PASS del viewer nativo né dei gate di rilascio. Non sono stati eseguiti il collaudo su dispositivo fisico o baseline iOS 15, il collaudo Android, il salvataggio/apertura nel browser e il ritorno nell'app. Il codice non è stato ancora pubblicato; le migrazioni preparatorie già applicate hanno tutti i flag disattivati. Le evidenze dettagliate, inclusi identificativi, impronte e screenshot del documento reale, restano fuori dal repository pubblico.

## Aggiornamento correzione safe area e rilascio — 2026-09-16

La correzione del viewer estende l'opt-in della modale alla safe area su tutti e quattro i lati e rende coerenti i limiti di altezza `vh`/`dvh`; conserva inoltre la classe letterale richiesta dal lock architetturale. Il critico Astra ha dato PASS finale al codice. Dopo la correzione sono verdi i gate locali: ESLint senza warning, typecheck, Vitest completo (**1.311 file / 17.827 test**), build di produzione con postbuild (**2.689 file JavaScript**) e harness del renderer **4/4** su Chromium/WebKit.

Il retest iOS sul tocco al centro della X è in corso: questi risultati non dichiarano un PASS nativo. Il collaudo Android con app già installata e documento reale è avviato. L'utente ha riferito di avere verificato personalmente nel simulatore che la fattura è visibile e scaricabile e ha autorizzato merge e deploy; la sua verifica manuale è annotata come tale e non è presentata come prova strumentata di ogni interazione. CI E2E autenticata, push, merge, pubblicazione e verifica pubblicata restano pendenti.

## Retest iOS indipendente — PASS limitato al simulatore

Il retest indipendente del PDF Aruba reale nel simulatore iPhone 17 Pro con iOS 26.2 è **PASS**. L'header dell'anteprima risulta sotto la status bar e il target della X è interamente attivo: il tocco al centro geometrico visibile e quello tramite etichetta accessibile hanno entrambi chiuso il viewer al primo tentativo, con ritorno alla schermata Pagamenti entro cinque secondi. Dopo due cicli di chiusura, una terza riapertura ha confermato documento, footer dei comandi e zoom minimo al 75%.

Questo PASS copre il simulatore iOS 26.2, non un dispositivo fisico o la baseline iOS 15. Il collaudo Android resta in corso; ritorno dal browser e CI E2E autenticata restano pendenti. Il push iniziale del branch è riuscito, mentre la correzione safe area deve ancora essere committata; merge, pubblicazione e verifica pubblicata non sono ancora avvenuti.
