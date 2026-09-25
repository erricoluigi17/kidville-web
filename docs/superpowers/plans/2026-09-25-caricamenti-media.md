# Caricamento affidabile di foto e video — piano di implementazione

> Esecuzione con Superpowers: subagent-driven-development, test-driven-development, systematic-debugging e verification-before-completion. Spec: `../specs/2026-09-25-caricamenti-media-design.md`.

**Obiettivo:** caricamenti completabili e riprendibili senza duplicati, con errori visibili e verificati su web/iOS/Android.

**Architettura:** mantenere Storage e runner esistenti; idempotenza transazionale per le foto, coda persistente con identità/sede, riconciliazione del lifecycle video e verifica temporale della conversione.

## Regia e contatore

Massimo **3 cicli completi** di implementazione/revisione/collaudo. Cicli completati: **3**; loop degli agenti concluso. Ogni task ha un esecutore e un critico indipendente; nessun autore approva il proprio lavoro. L'orchestratore verifica anche i verdetti dei critici. Le modifiche che condividono file procedono in sequenza; le attività indipendenti possono procedere in parallelo.

| Task | Modello/effort | Verifica richiesta | Stato |
|---|---|---|---|
| Fotocamera e selezione | Sol/high; critica Astra/xhigh | Errore plist, annullamento, MIME vuoto, gesto alternativo | PASS critica e percorso alternativo nativo |
| Idempotenza foto e migrazione | Astra/xhigh; critica Astra/xhigh indipendente | Replay concorrenti, conflitto, atomicità, permessi, stesso IP | PASS SQL e concorrenza PostgreSQL reale |
| Coda foto e interfaccia | Sol/high e xhigh; critica Astra/xhigh | Lotto 31, risposta persa, ripresa, sede/account | PASS critica finale e recupero WebKit reale |
| Recupero video | Astra/xhigh | Confini TUS/caricato/conferma, firme, stati terminali, isolamento | PASS critica: 166 test su 9 file |
| Verifica temporale video | Astra/xhigh; critica Astra/xhigh | VFR reale, controprove, build pinnata | PASS critica finale; gate CI pinnato ancora richiesto |
| Collaudo web | Orchestratore e Astra/xhigh; critica Astra/xhigh | Docente → genitore con fault injection | PASS foto, lotto 31, VFR audio e MOV smartphone |
| Collaudo iOS | Astra/xhigh; critica Astra/xhigh distinta | Maestro e configurazione legacy con fallback | PASS critica finale; limiti del simulatore dichiarati |
| Collaudo Android | Sol/xhigh; critica Astra/xhigh | Maestro, selezione e riavvio | PASS critica del percorso assistito; limiti nel report |

## Sequenza di ogni task

1. Leggere le regole e i confini di ownership; scrivere ed eseguire una regressione fallente per il difetto.
2. Implementare la correzione minima, con logging e compatibilità previsti dalla spec.
3. Eseguire i test mirati e consegnare diff e prove del rosso/verde.
4. Critico: verificare prima conformità alla spec, poi qualità/sicurezza e validità dei test; restituire difetti riproducibili all'esecutore.
5. Dopo tutti i task, collaudo integrato; i cicli 2–3 correggono soltanto i rilievi residui.

## Gate finale e rilascio

- Tutte le coppie esecutore/critico concluse senza difetti aperti.
- `npx eslint . --max-warnings 0`, `npx tsc --noEmit`, `npx vitest run`, `npm run build`.
- E2E Playwright in CI su database separato; nessun seed locale in produzione.
- Verifica diretta dell'orchestratore e PRD allineato alle prove effettive.
- Migrazioni additive applicate e verificate; nessun dato reale modificato dal collaudo.
- PR, CI, merge, deploy effettivo, prova controllata e log correlati.
- Verifica stato versione iOS senza confondere revisione e disponibilità.
- Pulizia dei branch secondari dopo il rilascio verificato.

## Registro delle prove

I tre agenti disponibili vengono riutilizzati per task sequenziali, senza auto-revisione. Il runtime non consente nuovi agenti oltre questi tre; ogni incarico resta separato, con ownership e consegna esplicite. La coda usa il Sol/high già disponibile; le critiche usano Astra/xhigh.

### Ciclo 1 — prove e ritorni ai rispettivi autori

- Fotocamera: il critico ha riprodotto MOV/M4V respinti e HEIC senza MIME scambiato per MP4. Correzioni test-first; riesame indipendente PASS, 101 test su 7 file ed ESLint verde. Anche bubbling dell'input e letture concluse dopo unmount hanno regressioni dedicate. Collaudo nativo ancora da eseguire.
- Foto server: 524 test mirati iniziali verdi; il critico ha poi riprodotto la perdita della chiave idempotente dopo la purga fisica. Correzione con registro minimale separato, transazionale e privo di contenuti; 2 regressioni rosse poi 11 test SQL verdi. Riesame in corso. PGlite serializza le sessioni: non prova concorrenza PostgreSQL reale.
- Temporale video: 261 test verdi, 14 casi saltati esplicitamente perché il Mac non dispone della build Linux pinnata. Fixture FFmpeg locali VFR e VFR+audio: 150/150 frame accettati; 120→60 fps: 240/120; variante mutilata 150→149 rifiutata. I casi pinnati devono passare in CI prima del merge. Nessun frame/PTS viene salvato nei log applicativi.
- iOS: IPA 1.1/build 5 ispezionata, presenti le tre dichiarazioni fotocamera/libreria. App Store Connect: 1.1 in `WAITING_FOR_REVIEW`, 1.0/build 4 `READY_FOR_SALE`. Verifica da ripetere alla chiusura.
- CI: schema reale della galleria ancora privo di sede/cestino; 5 righe, nessuna senza autore. Allineamento additivo delle dipendenze necessario prima dei nuovi E2E; nessun seed sulla produzione.

Un test non eseguito non è un PASS. Nessun merge/deploy effettuato.


### Ciclo 2 — collaudo integrato e residui

- Schema CI della galleria allineato con sede ricavata dall’autore e cestino; cinque righe preservate, nessuna senza sede. Nessun seed sulla produzione. Lo script di seed ora rifiuta qualunque URL diverso dal progetto CI prima di istanziare il client o chiamare la rete; regressione rossa poi verde.
- Idempotenza PostgreSQL CI reale: otto richieste concorrenti, una pubblicazione e un vincitore; replay dopo purga rifiutato, servizio senza DELETE sul registro. Migrazione finale con FK della sede: 14 prove PGlite verdi e critica indipendente PASS.
- Migrazione produzione applicata con transazione, tetto lock 5 secondi e statement 60 secondi, registrazione della versione nella stessa transazione. Conteggi freschi prima/dopo: 716 `enrollment_submissions`, 3.687 `galleria_media_v2`, registro nuovo vuoto. Fotografie rigenerate dal DB: 193 migrazioni, 231 indici unici, 78 tabelle con sede e nessuna senza FK.
- Web reale Chromium sul DB CI: PUT completata con risposta persa → reload → una sola PUT e POST 201; POST completato con risposta persa → reload → una PUT e POST 201/200. Genitore autorizzato vede l’immagine decodificata; cleanup DELETE 200. Critica PASS limitata a questo percorso. Nuova suite Playwright committabile copre anche replay concorrenti, conflitto e genitore non autorizzato, da eseguire in CI su Chromium/WebKit.
- Recupero video: critica finale PASS, 166 test su nove file, inclusa firma negata dopo smontaggio/cambio identità, originale presente, rinnovo, TUS singolo, stati terminali e News.
- Temporale: 85 test mirati verdi; 14 casi richiedono Linux FFmpeg pinnato in CI. Riproduzioni locali verificano MP4 con timebase 30/60, perdita di frame e difetti audio interni; critica indipendente in corso.
- Coda foto: regressioni per quota, autenticazione, timer, scarto durante PUT e POST, esito incerto e data/ora del prossimo tentativo. La seconda critica ha trovato due residui: ricontrollo dell’ambito dopo la persistenza `publishing` e conservazione dell’incertezza dopo un replay 4xx. Tornano allo stesso esecutore per la correzione finale.
- Build CI locale verde. Suite completa, lotto reale di 31 foto con attesa effettiva e Maestro Android/iOS in corso. Le versioni native di collaudo puntano soltanto al proxy del progetto separato.

Per la ripresa sono stati assegnati esplicitamente Sol/xhigh ai residui foto, Astra/xhigh alle prove temporali e Astra/xhigh alla critica indipendente; gli stessi slot eseguono successivamente task singole di collaudo senza auto-approvazione.

- Prova web reale TUS sul CI: lo Storage rifiutava la POST con `400 Invalid Compact JWS`. Il doppio HTTP dei test sovrascriveva gli header, mentre XMLHttpRequest li concatena. Il rinnovo in `onBeforeRequest` sommava la firma a quella impostata in `headers`. Correzione dell’orchestratore: una sola assegnazione per richiesta, mantenendo il rinnovo; doppio reso fedele a XHR, due regressioni rosse prima della modifica. Nuova prova reale necessaria dopo rebuild.
- Android: primo banco QA su HTTP `10.0.2.2` non era un contesto sicuro e non esponeva `crypto.randomUUID`; l’errore di persistenza era dovuto al banco. Misura DevTools esplicita; ricostruzione QA su localhost con adb reverse, senza modificare le API del browser.


### Ciclo 3 — chiusura del loop

Il loop degli agenti termina dopo questo ciclo. Restano da correggere i due rilievi della coda foto e la quantizzazione dei PTS interni, più il difetto TUS riprodotto dall’orchestratore. I collaudi nativi e le verifiche della CI devono essere conclusi prima del merge; seguirà la prova finale personale dell’orchestratore.

Lotto web reale di 31 foto e NAT condiviso: critica indipendente PASS. Trenta foto pubblicate, trentunesima sospesa con orario visibile; nuova firma automatica 32 ms dopo la scadenza, 31 PUT e 31 POST 201 totali, UUID tutti distinti, coda vuota. L’altro docente ha ottenuto una firma 200 durante il blocco. Cleanup: 31 DELETE 200, cioè cestinamento dei soli media sintetici, non purga fisica degli oggetti.

- Quota condivisa: dopo aver allineato la funzione PostgreSQL del CI, prova autenticata con 31 richieste concorrenti → 30 firme 200 e una 429; un secondo docente sullo stesso IP → 200. La precedente prova di attesa reale aveva esercitato il fallback locale; questa controprova misura anche il contatore distribuito usato in produzione.
- TUS: critica indipendente PASS con 60 test e controprova Chromium/XHR nativo: vecchia configurazione invia due firme concatenate, nuova configurazione una sola su POST/PATCH/HEAD/DELETE, anche dopo rinnovo.

- Per la prova smartphone è stato selezionato un estratto senza persone dei primi due secondi del [campione pubblico iPhone 4 di FFmpeg](https://samples.ffmpeg.org/ffmpeg-bugs/trac/ticket2958/from_iphone4.MOV): stream video copiato senza ricodifica, audio e metadati rimossi. H.264 1280×720, VFR, timebase 1/600. La fixture resta temporanea; non contiene contenuti delle famiglie e non viene inserita nel repository. SHA-256 dell’estratto: `bc4f36b4939df22e5855733cc30d4ee7984285b4d0abf6404f04e69c209062b9`. Prova ancora da eseguire, distinta dalle fixture sintetiche moderne HEVC/HDR.


### Collaudo finale dell’orchestratore

- Coda foto: i due rilievi finali corretti e critica PASS (76 test su sette file più controprove indipendenti). Temporale: quantizzazione dei PTS corretta senza allargare la tolleranza media; critica PASS. Il loop dei tre cicli è concluso.
- Gate locali su `804e9c2c`: ESLint senza warning, TypeScript, 1.534 file Vitest / 22.484 test verdi / 18 casi FFmpeg Linux saltati esplicitamente, build verde. I casi pinnati e Playwright sono in esecuzione nella CI della PR #170.
- Sandbox reale Node 22.22.2: trasferimento video e ripresa senza seconda PUT riusciti, conversione fermata con `BUILD_EXTRACT_FAILED`. Riproduzione isolata: SHA valido, `tar` non trova `xz`. Correzione personale: installazione condizionale dal repository del runtime, prima della build, con `sudo -n`, uscita 23 se fallisce. Due regressioni shell rosse prima del fix; 19 test verdi dopo, quattro controprove indipendenti e nuovo Sandbox reale con estrazione riuscita. Critica PASS limitata alla preparazione; percorso video completo ancora da terminare.

- Percorso video reale VFR+audio sul CI: TUS POST 201/PATCH 204, risposta `caricato` persa, reload senza secondo trasferimento, riconferma, Sandbox `pronto`, reselezione tag obbligatoria, pubblicazione 201 e riproduzione verificata dal genitore; cleanup 200. Un primo errore `SOURCE_DOWNLOAD_FAILED` era del banco: watermark configurato su localhost; corretto il solo helper temporaneo all’asset pubblico di produzione.
- iOS: riprodotta PUT fallita con File ricostruita da IndexedDB; stessa foto integra (26.225 byte JPEG) e stesso percorso trasferiti come ArrayBuffer → 200. WebKit desktop riproduce inoltre `UnknownError: Error preparing Blob/File data to be stored in object store`; ArrayBuffer nello stesso DB → successo. Due regressioni rosse. Le nuove voci foto conservano byte e MIME; le voci Blob legacy restano leggibili. Trasporto delle sole foto tramite byte (tetto 50 MiB), prima della PUT controllo aggiornato dell’ambito; diagnostica della persistenza include il nome tecnico dell’errore. Verifica integrata dopo rebuild ancora necessaria.
- Prima CI Playwright: tre percorsi foto Chromium verdi, tre WebKit rossi sulla persistenza Blob. Quattro casi impaginazione non raggiungevano il video perché altre foto QA lo spostavano oltre le prime quattro card; collaudo aggiornato per includere esplicitamente anche il video presente nella griglia. Nessuna asserzione video rimossa.

- Fixture smartphone MOV: i 54 frame rimangono 54 ma l’encoder arrotonda i PTS alla timebase predefinita 1/framerate, causando `TIMESTAMP_MISMATCH`. Correzione personale nella codifica: `-fps_mode:v passthrough` e `-enc_time_base:v filter`; il filtro continua ad applicare soltanto sopra 60 fps la riduzione esplicita a 60. Verificatore e tolleranze invariati. Nuova regressione MOV sintetica con PTS irregolari su timebase 1/600; nuova prova Sandbox in corso. Riferimento primario: [opzioni FFmpeg della timebase encoder](https://ffmpeg.org/ffmpeg.html#Advanced-options).
- Il limite foto di 50 MiB è verificato anche prima della lettura in memoria per accodare un originale non decodificabile; errore esplicito in UI, selezione conservata, nessuna allocazione integrale del file oltre limite.

- Nuova prova reale smartphone sulla build pinnata: 54 frame in ingresso e 54 in uscita, attestazione temporale `ok:true`, Sandbox `pronto`, risposta `conferma` persa e rientro senza seconda trasmissione, pubblicazione 201, video riprodotto dal genitore, cleanup 200. Il difetto era nella quantizzazione dell’encoder, non nel margine del verificatore.
- Critica finale byte foto PASS: 70 test su sette file e controprove Blob legacy/ArrayBuffer, MIME, cambio ambito durante lettura, limite prima dell’allocazione, selezione conservata.

- Aggiornamento App Store Connect finale del 25/09: versione iOS 1.1 ora `READY_FOR_SALE` (non più in attesa revisione). Percorso alternativo mantenuto per le installazioni precedenti.
- CI precedente: qualità PASS, 1.534 file / 22.500 test verdi; i 16 test FFmpeg saltati sul Mac eseguiti con la build pinnata. Restano due skip preesistenti del controllo HTML nativo. Playwright richiede nuova run dopo le correzioni WebKit e del selettore video.

- Gate locali dopo correzioni root: ESLint senza warning, TypeScript e build verdi; Vitest completo 1.536 file / 22.491 test verdi / 19 skip (17 fixture FFmpeg non disponibili sul Mac più due HTML nativi). Il primo tentativo della suite era limitato dal sandbox (`listen EPERM` dei server di test); riesecuzione con loopback autorizzato completamente verde.

- Verifica finale personale WebKit dopo rebuild: risposta POST persa → una PUT, POST 201/200, un solo media visibile al genitore; risposta PUT persa → una PUT, POST 201, stesso risultato. Entrambi i media sintetici cestinati via API (200).
- La regressione MOV sintetica irregolare verifica il comportamento richiesto, ma sulla FFmpeg locale 8.1.2 passa anche senza le nuove opzioni. La riproduzione rosso/verde del difetto dell’encoder è il campione smartphone sulla build pinnata del Sandbox (54 frame, `TIMESTAMP_MISMATCH` prima e successo dopo). Controprove indipendenti: news/gallery, 120→60 fps con audio, PTS alterati ancora respinti; verificatore invariato.
- Stato Apple confermato anche sul pacchetto associato: versione 1.1 `READY_FOR_SALE`, build 5 `VALID`, non scaduta.
- Preflight produzione aggiornato: 716 iscrizioni, 3.688 media, zero job queued/processing. Docente, genitore e alunno sintetici già presenti nella sola sede E2E; unico destinatario verificato sintetico. Il collaudo post-deploy usa questi record senza seed e cestina solo il media creato.

- iOS finale su simulatore iPhone 16e/iOS 26.2: copia QA della 1.1 priva della sola dichiarazione PhotoAdd, errore esplicito → nuovo tocco sul percorso alternativo → firma 200, una PUT 200 e una pubblicazione 201. API e riavvio confermano una riga per upload_id e coda vuota. Sessione invalidata dal seed CI: foto/tag conservati e ripresa dopo nuova autenticazione. La voce legacy già trasferita durante la diagnosi è riconosciuta senza ritrasferimento. Genitore reale sintetico risolto da `/api/me`, immagini decodificate 480×360. Limiti: nessuna fotocamera fisica sul simulatore; copia QA equivalente al difetto privacy, non binario Store 1.0; screenshot genitore preso prima della fine del loading, verifica pixel successiva via runtime.
- Cleanup nativo: cinque media sintetici (quattro iOS e uno Android) cestinati con DELETE 200 e assenza verificata nella lettura successiva. Ripristinati i binari originali iOS e Android e rimosso il reverse proxy Android; app non riavviate verso produzione.

- Critica indipendente del collaudo iOS: PASS funzionale, nessun nuovo difetto riproducibile. Confermati rete, identità, riavvio, immagini genitore, cestinamento e ripristino; nessuna pretesa di collaudo della fotocamera fisica o di purga fisica dello Storage. Tutte le coppie operative/critiche sono concluse. Il rilascio resta subordinato ai gate della PR #170 sul commit finale.

- Seconda CI Playwright: upload/ripresa e impaginazione superati; un caso WebKit termina sul controllo della card genitore dopo il timeout DOM predefinito di 5 secondi. La cattura è della pagina docente rimasta aperta e non prova lo stato finale del genitore. Il test ora attende esplicitamente la risposta GET reale, richiede esattamente il media pubblicato nel JSON e poi verifica card unica e immagine decodificata entro 30 secondi. Nessun retry né asserzione rimossa; l’assenza del media nella risposta fallisce subito. Nuova CI obbligatoria.

- Controprova personale WebKit con ritardo controllato di 8 secondi sulla GET reale del genitore: vecchia asserzione DOM a 5 secondi rossa; nuova attesa API + media unico + card + pixel verdi. PUT con risposta persa recuperata senza seconda trasmissione, pubblicazione 201 e cleanup 200. Critica indipendente del diff E2E PASS: requisiti funzionali rafforzati, nessun retry; la causa storica non viene dichiarata provata dalla sola cattura docente.
