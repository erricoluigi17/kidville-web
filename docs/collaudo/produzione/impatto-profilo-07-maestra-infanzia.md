# Profilo 07 — maestra, sezione infanzia (3-6)

> **Questo NON è un feedback ricevuto.** È la ricostruzione, provata commit per commit, dei difetti
> che un utente con questo profilo poteva incontrare nell'app fra il 6 e il 20 agosto 2026.

## Come si presentava l'app a questo profilo, giorno per giorno

Questo profilo apre l'app per fare l'appello, scrivere il diario, caricare le foto in galleria,
leggere e rispondere ai messaggi dei genitori, annunciare un'uscita o una gita dall'agenda e
guardare il prospetto mensile delle assenze. Nel menu del docente le voci del suo grado sono
appello/presenze, diario, mensa, foto, bacheca, news, attività, armadietto, moduli e messaggi: il
*registro con le valutazioni* non le compare, perché è della primaria
(`src/components/features/teacher/TeacherBottomNav.tsx`, campo `grado`). Non ha nessuna voce di
segreteria, contabilità o GDPR.

L'app Android è una WebView su `https://app.kidville.it` e la produzione gira `main`: ogni
rilascio web è arrivato ai tester senza scaricare un nuovo pacchetto dallo store. Perciò il calendario
di questo profilo coincide con i commit entrati in `main`, e sono soltanto tre a toccare le sue
schermate.

**6 → 8 agosto, ore 22:54 — la finestra in cui quasi tutto quello che si rompeva era suo.**
Sono i tre giorni in cui l'appello del mattino poteva dire *«Alunno non trovato»* per un bambino che
c'era (n. 27), il prospetto mensile poteva sommare assenze non ancora avvenute (n. 29) e —
soprattutto — la risposta scritta a una mamma spariva dal riquadro senza comparire nella
conversazione e senza un messaggio d'errore (n. 1, faccia docente). Per tutto il periodo, e fino al
15 agosto, mancava inoltre la rete che avverte quando un pezzo del programma non arriva: la
schermata restava su «Caricamento…» senza niente da toccare (n. 20).

**8 agosto 22:54 — `f59854ab`.** Un solo rilascio chiude tutti e quattro. Nello stesso momento la
funzione «Comunica un'assenza» viene aperta per la prima volta anche a nido e infanzia: da qui in
avanti questo profilo può ricevere l'avviso *«sarà assente»* e leggere, sotto il nome del bambino,
il motivo scritto dalla famiglia — che fino a quel giorno veniva raccolto e non era mostrato su
nessuna schermata del personale 0-6 (`src/components/features/teacher/StudentAttendanceRow.tsx`,
`f59854ab`; non è una riga numerata dell'inventario, la annoto perché è il contesto di n. 28).

**9 → 14 agosto — nessun rilascio tocca le sue schermate.** Sette commit entrano in `main` in questi
giorni, e nessuno riguarda l'area del docente. Restano aperte due cose: il «Caricamento…» senza
uscita quando un pezzo del programma non arriva (n. 20, chiuso il 15), e il modulo di
autorizzazione alla gita che non raggiungeva nessuna famiglia (più sotto, chiuso il 16) — la seconda
lei non poteva nemmeno vederla.

**15 agosto 00:25 — `0e8480a3`.** Nel suo menu compare una voce nuova, «Documenti — Moduli firmati e
certificati dei tuoi bambini» (`TeacherBottomNav.tsx`, `messages/it/teacherNav.json`).

**16 agosto 11:31 — `0974424a`.** L'agenda del docente prende finalmente i campi «Orario partenza» e
«Rientro previsto», e l'esportazione del registro mensile in PDF smette di essere generata dentro il
telefono e passa al server.

**17 → 20 agosto — nulla.** L'ultimo commit in produzione è del 17 agosto (`b87ee964`); tutto il
lavoro del 19-20 agosto vive su un branch e non è mai arrivato ai tester.

## I difetti che questo profilo poteva incontrare

Sono i difetti **visibili sullo schermo di questo profilo**. I n. 9 e 28, che si vedono soltanto
guardando cosa viaggia dietro la schermata, stanno nella sezione successiva; i n. 30, 31, 32 e 33
stanno nell'ultima, con la prova del perché. Il n. 29 compare qui **per metà**: la spiegazione, e
la correzione a quello che avevo scritto prima, sono subito sotto la tabella.

| # inv. | Cosa si vedeva a schermo | Gravità | Rotto fino al | Commit | Verificato |
|---|---|---|---|---|---|
| 27 | Faccio l'appello e sotto un bambino della mia sezione leggo **«Alunno non trovato»** — ma il bambino c'è, e stamattina è entrato. Non era vero: era il database che non aveva risposto, e la presenza non veniva salvata. Stessa forma sull'altra porta: il permesso che dice quali sono le mie sezioni, quando non si riusciva a leggerlo, veniva letto come **«questa maestra non ha nessuna sezione»**, e mi si chiudeva la porta sui miei bambini | bloccante | **08/08/2026, ore 22:54** | `f59854ab` | `git show --stat --oneline f59854ab` ✔ · `git branch --contains f59854ab \| grep -w main` → `main` ✔ |
| 29 (metà) | Nel prospetto del mese un bambino con **una sola assenza già avvenuta** risultava con «2 A» e «10 ore»: venivano contate anche le assenze annunciate per giorni che non erano ancora arrivati, e gli stessi numeri finivano nel PDF che si stampa e si firma | fastidioso | **08/08/2026, ore 22:54** | `f59854ab` | idem ✔ · schermata: `MonthlyAttendanceTable` importata a riga 10 e resa a riga 695 della pagina 0-6 |
| 20 | Apro l'app, o passo da una schermata all'altra, e resto su **«Caricamento…» per sempre**: nessun messaggio, nessun bottone, niente da toccare. Bastava che un pezzo del programma non arrivasse — la rete che cade a metà, la WebView che sospende la richiesta, oppure **un rilascio che sostituisce i file mentre la pagina è già aperta**. Il pannello che avrebbe dovuto dirlo, e offrire il bottone «ricarica», esisteva dal 3 agosto con 11 test verdi e non era montato da nessuna parte | bloccante | **15/08/2026, ore 00:25** | `0e8480a3` | `git show --stat --oneline 0e8480a3` ✔ · `git branch --contains 0e8480a3 \| grep -w main` → `main` ✔ |
| 1 (faccia docente) | Rispondo al messaggio di una mamma, tocco «Invia», **il testo sparisce dal riquadro e non compare nella conversazione**. Nessun errore, nessun avviso: sembra solo che non sia successo niente. Riscrivo, e succede di nuovo | bloccante | **08/08/2026, ore 22:54** | `f59854ab` | idem ✔ |

**Sul n. 20 — perché una maestra era esposta esattamente come un genitore.** Non è una schermata:
è una rete di sicurezza **globale**. Il pannello che dice «manca un pezzo del programma, ricarica»
(`ChunkErrorBoundary`) si monta dentro `RootProviders`, e `src/app/layout.tsx:91` avvolge in
`RootProviders` **l'intera applicazione** — non esiste un layout separato per l'area del docente.
Quindi non c'è nessuna superficie di questo profilo che ne fosse coperta, e nessuna che ne fosse
esclusa: nella finestra del collaudo non era coperta **nessuna delle due aree**, perché il
componente non era montato affatto. Verificato risalendo all'ultimo rilascio prima della
correzione: `git grep -n "ChunkErrorBoundary" d7af75b6 -- src` restituisce due sole righe, la
definizione del componente e una **citazione dentro un commento** di `global-error.tsx`; nessun
`import`, nessun uso. Lo dichiara anche il commento lasciato accanto alla riparazione: *«Dal
2026-08-03 al 2026-08-14 questo componente è esistito, con 11 test verdi, senza essere montato da
nessuna parte»* (`src/components/providers/RootProviders.tsx`).

E per questo profilo la causa più probabile non è la rete che cade: è **il rilascio che arriva
mentre la pagina è aperta**. L'app è una WebView che raccoglie ogni pubblicazione del sito senza
scaricare un nuovo pacchetto dallo store, e fra il 6 agosto e la riparazione stessa in produzione
sono entrati **dodici** rilasci
(`git log main --since=2026-08-06 --until="2026-08-15 01:00" --oneline | wc -l` → 12). Una maestra
che teneva l'app aperta durante l'appello del mattino stava esattamente nella condizione descritta.

⚠️ **Sul n. 29 — correzione a una versione precedente di questo documento.** Avevo attribuito a
questa riga anche una seconda metà: *«apro l'appello prima delle due di notte e mi trovo davanti il
registro di ieri»*. **È falsa per questo profilo, e la ritiro.** La pagina dell'appello 0-6 non
calcola mai la data in UTC: la calcola con l'orologio **locale** — `toISO(new Date())` costruito su
`getFullYear()/getMonth()/getDate()`, `src/app/(dashboard)/teacher/attendance/page.tsx:68-69` e
`210` — e la manda al server sempre, sia quando legge (riga 250, `?data=${selectedDate}`) sia quando
salva (riga 352, `data: selectedDate` nel corpo). Il ripiego in UTC che stava dentro la rotta non
veniva quindi mai raggiunto da questa schermata, né prima né dopo la correzione. Il difetto delle
due di notte era vero, ma su **altre** schermate: il cruscotto della segreteria e della Direzione
(`src/app/api/admin/presenze/realtime/route.ts`) e l'appello della **primaria**
(`src/app/(dashboard)/teacher/primaria/[sectionId]/appello/page.tsx`) — i due file che in
`f59854ab` guadagnano `oggiFiscaleISO` sul percorso del registro d'aula. Una maestra dell'infanzia
non ha né l'uno né l'altro.

**Sul n. 1 — perché è qui, e non solo nella lista del genitore.** L'inventario lo descrive dal lato
della famiglia («otto rotte rispondevano 500 a tutti i genitori non sospesi», fra cui *scrivere alla
maestra*). Il controllo che si rompeva, però, non guarda il ruolo di chi manda: gira su **chiunque
sia autenticato**. Su una maestra non trova nessun figlio, quindi prende il ramo «nessun figlio
sospeso» — ed è esattamente il ramo che il compilatore aveva trasformato nella stringa
`"TURBOPACK unreachable"`. Il codice lo dice per esteso in
`src/lib/pagamenti/sospensione.ts` (funzione `assertGenitoreNonSospeso`), e la schermata della chat
del docente manda il messaggio proprio a quella porta
(`src/app/(dashboard)/teacher/chat/page.tsx`, `handleSendMessage` → `POST /api/chat/messages`).
Il silenzio è del client: quel gestore reagisce solo a una risposta buona e a un 403, e per il 500
non ha nessun ramo; il riquadro di scrittura intanto si era già svuotato
(`src/components/features/chat/ChatInput.tsx`, `setText('')` subito dopo l'invio). Da qui
«ho scritto e non è successo niente», senza una parola sullo schermo.

## I difetti che questo profilo subiva senza poterli vedere

**n. 28 — cosa arrivava, e cosa non si vedeva.**
Ogni volta che questo profilo salvava una casella dell'appello, la risposta del server non conteneva
le sei colonne che servono alla riga: le conteneva **tutte e venticinque**. Fra quelle, tre che sullo
schermo non compaiono da nessuna parte:

- `giustificazione_testo` — il motivo dell'assenza scritto dalla famiglia, cioè un dato di salute di
  un minore;
- `giustificazione_firma` — la registrazione della firma elettronica del genitore, con dentro la sua
  **email, il suo indirizzo IP e il suo user-agent**;
- `note_appello` — la nota interna sul bambino.

Arrivavano dentro l'app, si fermavano nella memoria della pagina, e nessuna di esse veniva disegnata:
la riga del bambino mostrava soltanto presente/assente e gli orari. **Non era visibile, ma era
nell'app**: bastava avere in mano il dispositivo su cui la maestra era entrata per leggerle. La
correzione non ha tolto il motivo dal prodotto — anzi, dal 9 agosto lo mostra sotto il nome del
bambino, che è la finalità dichiarata alla famiglia — ha tolto **la firma, l'IP e la nota** dall'eco
di un salvataggio dove nessuno le guardava (`src/app/api/attendance/daily/route.ts`, costanti
`COLONNE_ESITO` e `COLONNE_APPELLO`, `f59854ab`).

Due precisazioni che l'onestà impone, e che restringono la portata per **questo** profilo:

1. L'inventario dice «su tre rotte, e in due finiva anche in `audit_scritture_docente`, conservato
   per anni». Quelle due sono `primaria/appello` e `primaria/presenze/giust-vista`: sono schermate
   **della primaria**, che una maestra dell'infanzia non ha. Alla sezione 3-6 arrivava soltanto la
   terza, `attendance/daily` — dove il dato viaggiava ma non veniva archiviato per anni.
2. In quella finestra le tre colonne, su un registro 0-6, erano quasi certamente **vuote**: la
   misura fatta in produzione il 7 agosto e scritta nel commit dice *0 righe di `presenze` con
   `giustificata_da` su 49*, e `note_appello` il modulo dell'appello 0-6 non lo scrive né lo legge.
   Il canale era aperto; il contenuto non era ancora entrato.

**n. 9 — l'appello riscritto da fuori.**
Il meccanismo, per come è documentato nel codice, è questo: quando un genitore comunicava un'assenza,
la scrittura non chiedeva permesso a nessuno. Se la maestra aveva **già fatto l'appello** di quel
giorno, la riga veniva riportata a «assente» lasciando intatti il segno di chi l'aveva compilata e
l'orario d'ingresso. Dal lato di questo profilo: **un bambino che ho appena visto entrare e che ho
segnato presente risulta assente**, e sul telefono arriva un avviso che dice che sarà assente. E non
si poteva rimettere a posto parlandone con la famiglia: quella riga risultava «già registrata»,
quindi il genitore non poteva più annullarla e non la vedeva nemmeno nel proprio elenco
(`src/app/api/parent/presenze/comunica-assenza/route.ts`, `f59854ab`).

**Il fatto misurato, che va detto insieme al meccanismo**: in produzione questo non è mai potuto
accadere. Fino al pomeriggio dell'8 agosto la funzione del genitore era chiusa a chiave — rispondeva
«disponibile solo per la scuola primaria» a chi non era primaria, e chi era primaria non aveva
nessun pulsante (n. 2). La prova sta nella stessa misura citata sopra: *zero* avvisi
`assenza_comunicata` emessi da sempre, *zero* righe con `giustificata_da` su 49. L'apertura della
funzione a nido e infanzia e la difesa dell'appello **sono arrivate in produzione nello stesso
rilascio**, `f59854ab` dell'8 agosto alle 22:54. Quindi: difetto reale nel codice, mai capitato a una
maestra.

**n. 33 — se e come questo profilo se ne accorgeva: non se ne accorgeva.**
Il rifiuto sbagliato («questo non è tuo figlio») nasceva nel controllo di parentela e veniva
disegnato **nell'app del genitore**. Nell'app della maestra non esiste nessuna schermata che mostri i
dinieghi ricevuti da un altro utente, e il contatore di sicurezza che si accendeva contro la famiglia
innocente vive in una tabella di log, non nell'interfaccia. Se ne poteva accorgere solo per via
indiretta e non dimostrabile: una mamma che le dice a voce «l'app non mi fa aprire il diario di mio
figlio».

Quello che invece **la toccava davvero** è il gemello dello stesso difetto, nello stesso file: il
controllo che stabilisce quali sezioni sono sue. Quando quella lettura falliva, l'elenco tornava
vuoto e veniva interpretato come «nessuna sezione assegnata» — cioè un guasto travestito da diniego,
su tutte le schermate che prima di mostrare qualcosa devono stabilire di quali bambini è
responsabile: diario, galleria, chat, mensa, moduli, presenze. È la seconda metà del n. 27, ed è la
faccia che questo profilo vedeva davvero.

**Quanto è largo quel perimetro, e da dove viene il numero.** In una versione precedente avevo
scritto «venti percorsi»: quel venti è il numero delle rotte servite dal gate `require-parent`, cioè
il conto del lato **genitore**, e non è il conto giusto qui. Il perimetro del docente l'ho misurato
invece di ereditarlo:
`grep -rl "assertAlunnoInScope\|assertSezioneInScope\|assertClasseNomeInScope\|sezioniVisibili\|sezioniDiUtente" src/app`
→ **82 file**. Non tutti si accendono per ogni gesto, e non pretendo che siano 82 schermate; è il
numero dei punti dell'applicazione che chiedono «di chi è responsabile questa maestra», cioè
l'insieme dentro cui quel guasto poteva presentarsi. Correggendo, il numero cresce: lo dico perché
la versione precedente **sottostimava**.

⚠️ **Un residuo, verificato nel codice di oggi e dichiarato perché il revisore possa controllarlo**:
il rilascio dell'8 agosto ha dato a questo guasto **una traccia** (una riga di errore che dice
*perché* la lettura è fallita), ma non ha cambiato l'esito — la funzione restituisce ancora l'elenco
vuoto, quindi una lettura fallita produce ancora il diniego alla maestra giusta
(`src/lib/sezioni/docenti.ts`, `sezioniDiUtente`). Ciò che è finito è il silenzio, non il sintomo.

**Il modulo della gita che non arrivava a nessuno** *(n. 24 dell'inventario, che lo colloca fra i
difetti del GENITORE — lo scrivo qui perché ne esiste una faccia che riguarda questo profilo, e non
lo conto nella tabella).* Fino al 16 agosto questo profilo poteva annunciare un'uscita dall'agenda,
leggere che era stata salvata, e **nessuna famiglia riceveva il modulo di autorizzazione**. La
ragione: il modulo pretendeva l'orario di partenza e quello di rientro, e la scheda dell'agenda del
docente — l'unica schermata da cui nascono le uscite — quei due campi non li aveva affatto. Sono
stati aggiunti il 16 agosto con `0974424a`
(`src/components/features/teacher/TeacherAgendaCard.tsx`; la diagnosi, con la misura, sta in
`src/app/api/parent/prestampati/banco-famiglia.ts`). Dal lato della maestra non c'era niente da
vedere: aveva premuto «Salva» e l'app aveva detto di sì.

## Cosa questo profilo NON poteva incontrare, e perché lo scrivo

**n. 30 — la data scritta all'americana nell'avviso al docente.** L'avviso in questione è quello che
arriva quando un genitore comunica un'assenza, ed è l'unico testo che quella funzione produce per il
docente. Prima del 9 agosto **non ne è mai partito nessuno**: la misura in produzione del 7 agosto
citata nel commit dice *zero avvisi `assenza_comunicata` emessi da sempre*. Dal 9 agosto in poi
la data era già corretta, perché la riparazione viaggiava nello stesso rilascio che apriva la
funzione. Non c'è nessun giorno, fra il 6 e il 20 agosto, in cui una maestra abbia potuto leggere
`2026-08-09T…Z` sul proprio telefono. Vale identico per l'indirizzo a cui portava quell'avviso, che
per tutti puntava a una pagina della primaria: il commit lo dice a chiare lettere — *«finché la route
rifiutava nido e infanzia il difetto era invisibile»* (`f59854ab`).

**n. 31 — i dodici messaggi d'errore muti di uscite/gite.** Sono reali e sono stati pagati il 15
agosto (`0e8480a3`: *«12 risposte d'errore senza codice tornano a 3»*), ma **nell'app non c'è
nessuna schermata da cui provocarli**. La porta che li produce non è chiamata da nessun punto
dell'interfaccia: lo dice il repository stesso, con la misura in mano — *«`grep -rn "api/teacher/uscite"
src/` dà **zero** chiamanti»* (`src/app/api/parent/prestampati/banco-famiglia.ts`) — e l'ho
riverificato: nel menu del docente non esiste una voce «uscite» o «gite», e le uscite vere nascono
dalla scheda agenda, che parla con un'altra porta. Un tester di questo profilo non aveva modo di
arrivarci.

**n. 32 — la barra in fondo disallineata di 2 px.** L'inventario stesso la marca *(latente)*, e il
commento lasciato nel codice dice perché: *«oggi nessuna schermata docente si appoggia a quella
variabile, quindi non si vedeva niente»* (`src/components/features/teacher/TeacherBottomNav.tsx`,
`f59854ab`). Non c'era nulla da vedere.

**Il resto della sezione A.1, e le sezioni A.3 e A.4.** La A.1 descrive per la gran parte le
schermate dell'**app del genitore** — il modulo «Comunica un'assenza», il certificato da firmare, il
riepilogo dell'iscrizione: un account docente non le apre. La A.3 descrive i pannelli di
**segreteria e Direzione** — fascicoli del personale, GDPR, contabilità, carta intestata,
candidature: questo profilo non li ha nel menu e le porte relative lo respingono. La A.4 è il
**sito pubblico** (`/lavora-con-noi`, `/iscrizione`), che si compila prima di avere un account.

Da quella sezione ho però tirato fuori **quattro** righe, e nessuna delle quattro perché «sembrava
attinente»: ognuna ha una prova nel codice.

- **n. 1** — il guasto colpiva letteralmente il pulsante «Invia» della maestra, perché il controllo
  che si rompeva gira su chiunque sia autenticato.
- **n. 9** — è l'appello di questo profilo a essere riscritto da fuori.
- **n. 20** — non è una schermata del genitore: è una rete montata sull'intera applicazione,
  `src/app/layout.tsx:91`. Classificarla come «roba del genitore» sarebbe stato l'errore più grosso
  di questo documento, e in una versione precedente lo era.
- **n. 24** — la causa stava su una schermata del docente, l'agenda.

La lezione, e vale più delle quattro righe: **la sezione dell'inventario dice chi ha segnalato il
difetto, non chi lo subisce.** Ogni riga va riportata al codice prima di escluderla.

**La PARTE C.1 — la tabella delle candidature rimasta pubblica per un'ora la notte del 20 agosto.**
È l'unico difetto del 19-20 agosto che sia stato vero in produzione, ma non tocca questo profilo in
nessun modo: riguarda un archivio del modulo pubblico «Lavora con noi», leggibile dall'esterno con la
chiave anonima del sito, e non compare su nessuna schermata dell'app del docente. Ho verificato
anche la posizione del commit che la chiude: `git branch --contains ddfe3b0e | grep -w main` non
restituisce nulla — quel lavoro sta su `feat/candidature-multisede` e in produzione è arrivato
soltanto come modifica applicata direttamente al database.

## Verifiche eseguite

Tutte in sola lettura. Nessun `git add`, `git commit`, `git push`, `git checkout`. Nessuna scrittura
sul database, nessun `npm install`. L'unico file scritto è questo.

| Comando | Esito |
|---|---|
| `git show --stat --oneline f59854ab \| head -20` | commit reale, PR #74, 260 file, 8 agosto 2026 ore 22:54 |
| `git branch --contains f59854ab \| grep -w main` | `main` ✔ — in produzione |
| `git show --stat --oneline 0e8480a3 \| head -20` | commit reale, PR #84, 15 agosto 2026 ore 00:25 |
| `git branch --contains 0e8480a3 \| grep -w main` | `main` ✔ — in produzione |
| `git show --stat --oneline 0974424a \| head -20` | commit reale, PR #88, 16 agosto 2026 ore 11:31 |
| `git branch --contains 0974424a \| grep -w main` | `main` ✔ — in produzione |
| `git branch --contains ddfe3b0e \| grep -w main` | **nessuna riga** — PARTE C.1 non è su `main` |
| `git log main --since=2026-08-05 --until=2026-08-21` | 20 commit in produzione nella finestra; solo 3 toccano le schermate di questo profilo |
| `git log -1 --format="%h %ci" main` | `b87ee964`, 17 agosto 2026 — nessun rilascio dal 18 al 20 |
| `git log main --since=2026-08-06 --until="2026-08-15 01:00" --oneline \| wc -l` | `12` — i rilasci entrati mentre il n. 20 era aperto |
| `git grep -n "ChunkErrorBoundary" d7af75b6 -- src` | 2 righe: la definizione e una citazione in un commento — **nessun `import`**, quindi non montato |
| `git grep -n "ChunkErrorBoundary" HEAD -- src` | montato in `RootProviders.tsx:45`; `src/app/layout.tsx:91` avvolge tutta l'app |
| `grep -rl "assertAlunnoInScope\|assertSezioneInScope\|assertClasseNomeInScope\|sezioniVisibili\|sezioniDiUtente" src/app \| wc -l` | `82` — provenienza del perimetro del docente (R3) |

Letture di codice a supporto delle singole righe:

- n. 20 — `src/components/providers/RootProviders.tsx` (righe 40-45), `src/app/layout.tsx:91`,
  `src/components/providers/ChunkErrorBoundary.tsx`
- n. 29, ritiro della metà «mezzanotte-due» — `sed -n '68,70p;208,212p;248,252p;349,353p'
  "src/app/(dashboard)/teacher/attendance/page.tsx"` (orologio locale, e data sempre inviata al
  server), più l'elenco dei file che in `f59854ab` adottano `oggiFiscaleISO`
- n. 27 · n. 28 · n. 29 — `git show --format="" f59854ab -- src/app/api/attendance/daily/route.ts`,
  `… -- src/lib/sezioni/docenti.ts`, `… -- src/app/api/attendance/monthly/route.ts`,
  `… -- src/components/features/teacher/attendance/MonthlyAttendanceTable.tsx`
- n. 1 (faccia docente) — `src/lib/pagamenti/sospensione.ts`,
  `src/app/(dashboard)/teacher/chat/page.tsx`, `src/components/features/chat/ChatInput.tsx`
- n. 9 · n. 30 — `git show --format="" f59854ab -- src/app/api/parent/presenze/comunica-assenza/route.ts`
- n. 31 — `grep -rn "teacher/uscite" src/`, `src/components/features/teacher/TeacherBottomNav.tsx`
- n. 32 — `git show --format="" f59854ab -- src/components/features/teacher/TeacherBottomNav.tsx`
- n. 33 — `src/lib/auth/require-parent.ts`, `src/lib/auth/scope.ts` (`assertAlunnoInScope`),
  `src/lib/sezioni/docenti.ts` (`sezioniDiUtente`)
- n. 24 (faccia docente) — `git log -S"orario_inizio" -- src/components/features/teacher/TeacherAgendaCard.tsx`,
  `src/app/api/parent/prestampati/banco-famiglia.ts`

Nessun dato personale, nessun nome di famiglia o di bambino, nessun segreto compare in questo
documento: solo conteggi già pubblicati nei messaggi di commit di questo repository.
