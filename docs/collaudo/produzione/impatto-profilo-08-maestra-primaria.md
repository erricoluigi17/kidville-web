# Profilo 08 — maestra, scuola primaria

> **Questo NON è un feedback ricevuto.** È la ricostruzione, provata commit per commit, dei difetti
> che un utente con questo profilo poteva incontrare nell'app fra il 6 e il 20 agosto 2026.

## Come si presentava l'app a questo profilo, giorno per giorno

Chi ha questo profilo entra con un account `educator` a cui sono assegnate una o più classi di
primaria. Le sue schermate sono l'**appello di classe** (`/teacher/primaria/<classe>/appello`), il
**registro** con le firme d'ora, il **prospetto** e le **valutazioni**, il **fascicolo** dell'alunno,
e — insieme alle colleghe dell'infanzia — l'**appello e il prospetto mensile** di `/teacher/attendance`.
Il menù in fondo mostra a lei la voce «Registro» e non «Diario», che è la voce dell'infanzia.

**Dal 6 all'8 agosto, sera.** Sono i primi tre giorni su quindici, ed è la finestra in cui l'app era
messa peggio per questo profilo. L'appello di primaria apriva sulla **data sbagliata** se lo si
apriva fra mezzanotte e le due: la maestra vedeva proposto il giorno prima, e — questo è il punto
che fa danno — segnando e salvando l'appello finiva sul giorno precedente, **sopra righe già
lavorate**. Nel frattempo il registro contava come «assenza avvenuta» un giorno **non ancora
arrivato**, comunicato dalla famiglia in anticipo: il prospetto sommava «A» e ORE per un giorno che
non c'era stato, e il riepilogo del monte ore della classe — il numero con cui si valuta la validità
dell'anno scolastico — si gonfiava con giorni di anticipo. Se una lettura del database falliva,
l'app non lo diceva: rispondeva «Alunno non trovato», oppure spegneva la classe come se alla maestra
**non fosse assegnata nessuna sezione**. E la notifica «Assenza comunicata», l'unico testo che quella
funzione produceva per lei, portava una data scritta `2026-08-09T…Z`.

Sempre in quei giorni, senza che nulla apparisse a schermo, l'app riceveva dal server — e teneva in
memoria nel telefono — il **motivo sanitario scritto dalla famiglia** e la **traccia della firma del
genitore** (indirizzo email, indirizzo IP, dispositivo). In due dei tre punti in cui succedeva,
quegli stessi dati finivano anche nell'**archivio delle scritture del docente**, che si conserva per
anni.

Dall'altra parte della stessa funzione, un genitore che comunicava un'assenza poteva **riscrivere
l'appello già fatto** quella mattina; e se poi la annullava, il registro perdeva **una presenza di un
giorno qualunque del passato**.

**La sera dell'8 agosto** entra in produzione la correzione che chiude tutto questo blocco. Da lì in
poi l'appello apre sul giorno giusto, i conteggi si fermano a ciò che è davvero accaduto, gli errori
di lettura si dichiarano come errori, la notifica scrive `09/08/2026`, e il motivo dell'assenza esce
dal server solo verso chi insegna in quella sezione — non più verso chiunque abbia una scrivania.

**Dal 9 al 14 agosto** le schermate di primaria non cambiano. Resta aperta soltanto la questione
delle **uscite e gite**, dove i rifiuti del server erano frasi italiane scritte a mano: con il
telefono in inglese non avevano una traduzione a cui appoggiarsi.

**Il 15 agosto, notte,** entra la correzione che dà un codice a quei rifiuti e li traduce in
italiano e in inglese; nello stesso rilascio compare nel menù della maestra la voce **«Documenti
firmati»**.

**Dal 15 al 20 agosto** non risulta più nulla, in produzione, che tocchi questo profilo. L'ultimo
rilascio arrivato ai tester è del 17 agosto; il lavoro del 19-20 agosto è rimasto su un ramo di
sviluppo e non è mai stato installato da nessuno.

## I difetti che questo profilo poteva incontrare

| # inv. | Cosa si vedeva a schermo | Gravità | Rotto fino al | Commit | Verificato |
|---|---|---|---|---|---|
| 27 | «Alunno non trovato» quando l'alunno c'era: era la lettura del database ad essere fallita. Nella stessa famiglia di difetti, una classe davvero assegnata poteva sparire come se **non fosse assegnata nessuna sezione**, chiudendo la porta in faccia alla maestra giusta senza lasciare traccia | bloccante | 8 ago 2026 (sera) | `f59854ab` | ✅ `git show --stat --oneline f59854ab` · `git branch --contains f59854ab` → `main` |
| 28 | **Niente, ed è il motivo per cui è grave.** L'app riceveva dal server il motivo sanitario del minore, la nota d'appello e la traccia di firma del genitore (email, IP, dispositivo) senza mostrarli. Succedeva su `primaria/appello`, sulla presa visione della giustifica (`giust-vista`) e sull'appello 0-6; in due casi finiva anche nell'archivio delle scritture del docente | bloccante | 8 ago 2026 (sera) | `f59854ab` | ✅ `git show --stat --oneline f59854ab` · `git branch --contains f59854ab` → `main` |
| 29 | Il registro contava come «passata» un'assenza **futura** — «2 A» e «10 ORE» per un bambino che ne aveva una sola — e fra mezzanotte e le due l'app apriva **il giorno prima**: sull'appello di primaria non era solo una vista sbagliata, era una scrittura sbagliata | fastidioso (con effetto in scrittura sull'appello di primaria) | 8 ago 2026 (sera) | `f59854ab` | ✅ `git show --stat --oneline f59854ab` · `git branch --contains f59854ab` → `main` |
| 30 | Nella notifica «Assenza comunicata» — l'unico testo che quella funzione scriveva per la maestra — la data usciva come `2026-08-09T…Z` invece di `09/08/2026` | cosmetico | 8 ago 2026 (sera) | `f59854ab` | ✅ `git show --stat --oneline f59854ab` · `git branch --contains f59854ab` → `main` |
| 31 | Sulle uscite e le gite, i rifiuti del server erano frasi scritte a mano in italiano, senza un codice a cui agganciare una traduzione: con il telefono in inglese non avevano una versione inglese da mostrare. Con la correzione ognuno ha il suo codice e la sua frase nelle due lingue | fastidioso (**latente**: vedi più sotto) | 15 ago 2026, notte | `0e8480a3` | ✅ `git show --stat --oneline 0e8480a3` · `git branch --contains 0e8480a3` → `main` |
| 33 | Un genitore **che non aveva fatto niente** si vedeva rispondere «questo non è tuo figlio» perché una lettura era fallita, e finiva contato fra i tentativi di accesso abusivo. Il difetto stava nel controllo comune a venti schermate della famiglia | bloccante | 8 ago 2026 (sera) | `f59854ab` | ✅ `git show --stat --oneline f59854ab` · `git branch --contains f59854ab` → `main` |
| 9 (A.1) | **L'appello appena fatto veniva riscritto dal genitore.** Il bambino era stato visto entrare e segnato presente; la comunicazione d'assenza della famiglia gli passava sopra e faceva partire alla maestra un avviso «sarà assente». La riga che restava non era né dell'una né dell'altro, e dall'app non si poteva più aggiustare | bloccante | 7-8 ago 2026 | `f59854ab` | ✅ `git show --stat --oneline f59854ab` · `git branch --contains f59854ab` → `main` |
| 10 (A.1) | **Dal registro spariva una presenza di un giorno passato.** Bastava che un genitore annullasse un'assenza: la cancellazione non guardava di quale giorno si trattasse | bloccante | 7 ago 2026 | `f59854ab` | ✅ `git show --stat --oneline f59854ab` · `git branch --contains f59854ab` → `main` |

I numeri 9 e 10 stanno nella sezione A.1 dell'inventario perché il gesto è del genitore. Sono qui
perché **il danno cade sul registro della maestra**, ed è lei che se ne accorge — o che non se ne
accorge, che è il caso peggiore.

## Quello che era specifico della primaria — e quello che coincide col profilo 07

**Specifico della primaria — la maestra dell'infanzia non poteva vederlo:**

- **L'appello di primaria che apriva sul giorno sbagliato.** È il caso più netto: nella stessa
  notte, nello stesso telefono, la pagina dell'appello 0-6 mostrava l'8 agosto e quella di primaria
  il 7. Le conseguenze erano due, e la seconda non è una svista di schermo: l'assenza comunicata
  dalla famiglia per oggi non compariva nella pagina che la notifica apre, e **salvando, l'appello
  finiva sul giorno prima, sopra righe già lavorate**. Che sia una scrittura e non solo una vista
  si legge nel codice di allora: la data che la pagina calcola è la stessa che rispedisce al server
  quando si salva. Verificato al genitore dello squash, `29da34b4`: la pagina di primaria calcolava
  il giorno con `new Date().toISOString()`, cioè sull'ora di Greenwich, e lo rimandava dentro il
  corpo del salvataggio; la pagina gemella dell'infanzia, nello stesso momento, lo calcolava
  sull'ora locale del dispositivo — ed è il motivo per cui le due schermate mostravano due giorni
  diversi (`f59854ab`).
- **Il monte ore di classe.** Il riquadro «Riepilogo ore assenze» esiste solo nell'appello di
  primaria, e lo alimenta la stessa lettura che contava i giorni futuri: sono state misurate **5,25
  ore perse per un giorno non ancora arrivato** — il numero non è nell'inventario che dichiaro come
  fonte, viene dai banchi di prova scritti con la correzione
  (`__tests__/api/presenze-conteggi-fino-a-oggi.test.ts:8` e
  `__tests__/api/presenze-annunciata-non-e-un-fatto.test.ts:292`, «misurato in produzione: 5,25 ore
  per un appello mai fatto»). Le stesse ore rientravano dalla porta di «oggi»,
  che è il giorno preselezionato dal modulo del genitore. L'infanzia non ha questo numero, e non lo
  usa per dichiarare la validità dell'anno scolastico (`f59854ab`).
- **La presa visione della giustifica.** È il gesto con cui la maestra di primaria dichiara di aver
  letto il motivo scritto dalla famiglia (`giust-vista`), e non esiste all'infanzia. Era una delle
  porte da cui uscivano il testo sanitario e la traccia di firma del genitore, e la schermata di
  quei dati non faceva niente: li riceveva e basta (`f59854ab`).
- **La finestra dell'anno scolastico** proposta nel riepilogo dell'appello di primaria si calcolava
  sull'orologio del dispositivo: a cavallo del 31 agosto, due maestre in due fusi diversi avrebbero
  visto proposto un anno scolastico diverso sulla stessa schermata (`f59854ab`).
- **Le uscite e le gite** (`0e8480a3`): funzione che nel prodotto vive attaccata alla primaria.

**Quello che NON ha niente di specifico della primaria.** Lo scrivo così — come proprietà
verificabile nel codice — e non come «coincide col profilo 07»: il documento del profilo 07 porta in
tabella tre sole righe (27, 29 e il n. 1 nella sua faccia docente), quindi rimandare a lui per i
numeri 30 e 33 significherebbe rimandare a qualcosa che lì non c'è.

- **27**, **30** e **33** vivono in codice comune ai due gradi: la lettura delle sezioni assegnate,
  la formattazione della data di una notifica, il controllo d'accesso della famiglia. Nessuno dei
  tre ha un pezzo di primaria dentro.
- **29** è comune sul prospetto mensile di `/teacher/attendance`, che è una schermata dei due gradi,
  e diverge sull'appello di primaria e sul monte ore, dove smette di essere una vista sbagliata e
  diventa una scrittura sbagliata.
- **9** e **10** riguardano entrambi i gradi: la correzione ha esteso all'appello 0-6 la firma della
  riga che la primaria già aveva.
- **28**, invece, alla primaria pesa **di più**, e va detto al contrario di come suonerebbe un
  «coincide». Delle tre porte, le due che archiviavano quei dati per anni —
  `primaria/appello` e `giust-vista` — sono schermate **che esistono solo alla primaria**. E il
  contenuto: al 7 agosto la misura scritta nel commit dice *0 righe di `presenze` con
  `giustificata_da` su 49*, cioè su un registro 0-6 quelle colonne erano quasi certamente vuote,
  mentre la primaria è l'unico grado in cui la famiglia poteva già scrivere un motivo e firmarlo.

## Cosa questo profilo NON poteva incontrare, e perché lo scrivo

- **La tabella `candidature_sedi` rimasta pubblica per un'ora** (PARTE C.1, notte del 20 agosto).
  È l'unico difetto del 19-20 agosto che è stato vero in produzione, ed è per questo che va nominato
  invece che taciuto. Ma non tocca questo profilo: si tratta della tabella del modulo pubblico
  «Lavora con noi», leggibile dall'esterno con la chiave anonima del sito. Nessuna schermata della
  maestra la mostra e nessuna sua richiesta la interroga. Il rimedio, per giunta, vive su un ramo di
  sviluppo (`ddfe3b0e`, verificato: `git branch --contains ddfe3b0e` **non** restituisce `main`) — è
  il database di produzione ad essere stato corretto, non l'app.
- **Il numero 32 (la barra in fondo), e l'errore era mio.** L'avevo messo in tabella: non ci va,
  perché **non è mai esistito in produzione**. `f59854ab` è uno squash con un solo genitore
  (`git rev-list --parents -n 1 f59854ab` → `f59854ab 29da34b4`), e al genitore la variabile a cui
  la barra si sarebbe disallineata non esiste affatto: `git grep -c "kv-bottomnav-h" 29da34b4` non
  restituisce niente, e `git log -S"kv-bottomnav-h" --all --reverse | head -1` indica proprio
  `f59854ab` come commit che la introduce. Al genitore le due barre sono per giunta **identiche**
  (`h-[60px]` più `border border-white/60` in tutte e due): nessuno scarto fra maestra e genitore,
  e niente a cui disallinearsi. È un difetto **nato e chiuso dentro lo stesso squash**, cioè la
  stessa regola che applico al ramo `feat/candidature-multisede` e che non avevo applicato al mio
  stesso commit. Nel merito, poi, la mia descrizione era sbagliata: il difetto vero era «la barra
  occupa 62 px dove la misura dichiarata ne prevede 60 più il margine», su **entrambe** le barre, e
  non «quella della maestra è 2 px più alta di quella del genitore».
- **Il numero 31, e va detto con precisione.** L'inventario lo descrive come qualcosa che «il docente
  leggeva» nelle schermate uscite/gite. Ho cercato la schermata che manda quelle richieste e non
  l'ho trovata: `grep -rn "api/teacher/uscite" src/` non restituisce nessun chiamante fuori dal file
  della rotta stessa, e il rilascio successivo (`0974424a`, 16 agosto) lo mette per iscritto nel
  codice. Le uscite vere, nel prodotto, nascono dall'agenda della maestra. Quindi: le frasi c'erano
  davvero, erano davvero senza traduzione, sono state davvero corrette il 15 agosto — ma **non ho
  potuto provare che un tester le abbia potute leggere a schermo**, e preferisco dirlo piuttosto che
  lasciarlo intendere.
- **Tutto ciò che sta fuori dall'app** (PARTE B dell'inventario): il lavoro notturno di
  conservazione dei dati, le email, la fatturazione elettronica, i log, le migrazioni, le console di
  Google Play e App Store. Reale e corretto, ma un tester dell'app non poteva vederlo — l'app
  Android è una finestra su `app.kidville.it`, non un programma che gira sul telefono.
- **I difetti del ramo `feat/candidature-multisede`** (PARTE C.2): corretti prima del rilascio, mai
  installati da nessuno. Scriverli qui come cose vissute sarebbe falso.
- **Le schermate della segreteria e della direzione** (sezione A.3, numeri 34-60): fascicoli del
  personale, cancellazione GDPR, impostazioni di sede, candidature, carta intestata. Un account
  `educator` non le apre. Vale anche al contrario di come si legge di solito: la segreteria può
  entrare nelle funzioni docente, la maestra non entra nelle sue.
- **Il modulo di comunicazione dell'assenza dal lato genitore** (numeri 3-8, 12-26 della sezione
  A.1): il pulsante coperto dalla barra, il campo «Motivo» sotto il piede, il calendario che si
  apriva da solo, il certificato firmato per il figlio sbagliato. Sono schermate dell'area famiglia,
  che questo account non apre. Di quella funzione, a questo profilo arrivano solo le conseguenze —
  ed è quello che ho messo in tabella ai numeri 9 e 10.

## Verifiche eseguite

Tutte in sola lettura: nessun `git` di scrittura, nessuna modifica fuori da questo file, nessun
accesso al database.

1. **Fonte.** Letto per intero `docs/collaudo/produzione/00-INVENTARIO-difetti-6-20-agosto.md`.
   Presi solo la PARTE A (sezione A.2 per intero, più i numeri 9 e 10 della A.1) e la PARTE C.1.
2. **Esistenza dei commit.** `git show --stat --oneline <hash> | head -20` su `f59854ab` (8 ago
   2026, 22:54 — 260 file), `0e8480a3` (15 ago 2026, 00:25 — 98 file) e `ddfe3b0e` (20 ago 2026,
   01:27 — 10 file).
3. **Presenza in produzione.** `git branch --contains <hash> | grep -w main`: risponde `main` per
   `f59854ab` e `0e8480a3`; **non** risponde niente per `ddfe3b0e`, che risulta solo su
   `feat/candidature-multisede`. Coerente con quanto dichiara l'inventario.
4. **Corrispondenza fra sintomo e codice**, letta commit per commit e non dedotta dal titolo:
   le colonne chieste al database dall'appello di primaria e dalla presa visione della giustifica
   (n. 28, con l'archivio delle scritture del docente nominato nel codice); la regola dei conteggi
   «si conta ciò che è già accaduto» e il fuso `Europe/Rome` (n. 29); la data della pagina
   dell'appello di primaria, con la misura delle 01:2x dell'8 agosto scritta accanto al rimedio
   (n. 29, parte primaria); la lettura delle sezioni assegnate che, fallendo, si presentava come
   «nessuna sezione» (n. 27); la formattazione della data della notifica (n. 30); il controllo
   comune alle venti schermate della famiglia (n. 33); la scrittura
   condizionata che impedisce di passare sopra l'appello e la cancellazione legata al giorno
   (nn. 9 e 10).
5. **Raggiungibilità delle schermate.** Verificato che l'appello di primaria chiama davvero
   `primaria/appello`, `giust-vista` e il riepilogo del monte ore; che il prospetto mensile di
   `/teacher/attendance` è visibile anche a chi insegna solo alla primaria (voce di menù «comune»),
   mentre Diario e Armadietto sono voci dell'infanzia. Per le uscite/gite, `grep -rn
   "api/teacher/uscite" src/` non trova chiamanti: da qui la nota sul numero 31.
6. **Prova dello squash, sul mio stesso commit.** `f59854ab` ha un solo genitore
   (`git rev-list --parents -n 1 f59854ab` → `f59854ab 29da34b4`). Al genitore `29da34b4` la
   variabile `--kv-bottomnav-h` non esiste (`git grep -c "kv-bottomnav-h" 29da34b4` → vuoto; il
   primo commit che la introduce è `f59854ab` stesso) e le due barre in fondo sono identiche. Da qui
   la rimozione del n. 32 dalla tabella: un difetto nato e chiuso dentro lo stesso squash non è mai
   arrivato a nessun tester.
7. **Confronto col profilo 07 invece di assumerlo.**
   `grep -nE "^\| [0-9]" impatto-profilo-07-maestra-infanzia.md` restituisce **tre** righe: 27, 29 e
   il n. 1. I numeri 30 e 33 lì non ci sono, e il 28 vi è trattato fuori tabella con la conclusione
   opposta a un «coincide». Da qui la riformulazione della sezione delle coincidenze.
8. **Un rilievo emerso durante la verifica, che non è una riga dell'inventario e non lo diventa
   qui**: lo stesso commit `f59854ab` ha corretto una frase inglese rimasta nel piè di pagina
   *italiano* del registro presenze stampabile («Kidville Electronic Register» → «Registro
   Elettronico Kidville»). Lo scrivo per trasparenza sul metodo, non per aggiungere un difetto.
