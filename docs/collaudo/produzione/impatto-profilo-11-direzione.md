# Profilo 11 — Direzione

> **Questo NON è un feedback ricevuto.** È la ricostruzione, provata commit per commit, dei difetti
> che un utente con questo profilo poteva incontrare nell'app fra il 6 e il 20 agosto 2026.

Chi ha questo profilo approva le candidature e le anagrafiche del personale, apre e chiude le
pratiche, esegue le cancellazioni GDPR e vede tutte e tre le sedi. È il profilo che tiene in mano
le due chiavi più pesanti dell'applicazione: **quella che dà a una persona l'accesso all'anagrafica
dei bambini**, e **quella che distrugge i dati di un bambino per sempre**. Fra il 6 e il 20 agosto
tutt'e due si sono aperte nel modo sbagliato.

Due regole che ho seguito e che spiegano perché un difetto è qui e un altro no:

- **conta solo ciò che era in produzione.** L'app Android è una WebView su `app.kidville.it`: ogni
  rilascio web arriva ai tester senza che nessuno aggiorni niente. Perciò per ogni difetto ho
  chiesto a `git` se il commit sta su `main` — che è il ramo che gira in produzione — e ho scritto
  la data e l'ora vere del commit, non quelle di un piano;
- **il lavoro del 19-20 agosto non è arrivato in produzione**, con una sola eccezione (la tabella
  pubblica, PARTE C.1), perché quella migrazione è stata applicata a mano al database vero;
- **le ore che scrivo sono timbri di commit**, non l'istante in cui il rilascio è diventato apribile
  col telefono: fra l'unione in `main` e la pagina servita c'è una build che nessuno ha misurato.
  Ogni guasto qui elencato è quindi durato un po' **più** di quanto scrivo, mai meno.

---

## Come si presentava l'app a questo profilo, giorno per giorno

**Dal 6 all'8 agosto.** Il pannello *Privacy & Diritto all'Oblio* — quello che il prodotto stesso
descrive come «Azione riservata alla Direzione» — c'era già, e non funzionava: il pulsante «Elimina
Alunno (GDPR)» falliva su 28 bambini su 33, e la schermata che chiede di digitare cognome e nome per
confermare una cancellazione irreversibile mostrava quattro righe, di cui una sola parlava di
documenti. Nello stesso periodo, ogni volta che questo profilo apriva un registro delle presenze,
il telefono riceveva — senza mostrarli — il motivo sanitario scritto dal genitore, la nota
dell'appello e la ricevuta della firma elettronica con dentro email, indirizzo IP e modello di
telefono del genitore. La sera dell'**8 agosto alle 22:54** quest'ultima cosa si chiude.

**11 agosto, 10:16.** Arriva «Lavora con noi» e con esso il pannello *Candidature*. In testa alla
schermata c'è scritto, dall'11 agosto e per i primi tre giorni e sedici ore: *«La Direzione le
approva o le rifiuta: approvarne una crea l'account docente e manda le credenziali»*. È esattamente
ciò che faceva: un clic, un account che legge l'anagrafica dei bambini, e la password spedita
all'indirizzo scritto dentro un modulo pubblico e anonimo. Nello stesso clic venivano registrate
come permesso le fasce d'età che il candidato si era spuntato da solo.

**12 agosto, 07:09.** Arrivano l'anagrafica del personale, il modulo pubblico per il personale in
servizio e il pannello *Pratiche*. La porta dei permessi spuntati dal candidato si chiude su questa
strada — ma resta aperta sull'altra, quella delle candidature, per altri tre giorni. Il nuovo
elenco del personale nasce vuoto: nessuna scheda, dodici persone senza fascicolo, e il documento
d'identità chiesto su una faccia sola.

**Dal 12 al 13 agosto è la giornata peggiore per questo profilo.** Nessuna scansione di documento
d'identità del personale si apriva più, in nessuna delle tre sedi, e chi ci provava leggeva una
frase che accusa: *«non esiste, oppure appartiene a un'altra sede»*. Ogni fascicolo rispondeva con
un errore. Il cruscotto delle scadenze dichiarava mancante un documento che era archiviato. E chi
caricava una carta d'identità e chiudeva la pagina la lasciava nel magazzino senza nessuna riga che
la nominasse: invisibile, e quindi non cancellabile su richiesta.

**13 agosto, 02:24.** Si chiude tutto quel blocco insieme: i documenti del personale, «Elimina
Alunno (GDPR)» (che diventa *archivia* e *libera spazio*, reversibile), l'avviso della cancellazione
che finalmente nomina pagelle e certificati medici, e le sette pagine che chiedevano di scegliere
una sede da un menu che non esisteva.

**15 agosto, 02:48.** «Lavora con noi» si apre a cucina, collaboratrici e segreteria, il curriculum
si può finalmente allegare, e viene chiusa la porta che permetteva alla segreteria di una sede di
farsi aprire il curriculum di chi si era proposto a un'altra.

**15 agosto, 12:12.** Compaiono nelle impostazioni i campi della sede — legale rappresentante
compreso — che fino a quel momento un messaggio d'errore chiedeva di compilare in una schermata
dove non c'erano.

**15 agosto, 19:23.** Le credenziali cambiano porta: approvare una candidatura smette di creare
account e di spedire password; approvare l'anagrafica della persona assunta davvero comincia a
spedirle. È la correzione più importante dell'intera finestra per questo profilo.

**16 e 17 agosto.** Gli ultimi due rilasci in produzione riguardano la carta intestata, i
certificati e le iscrizioni: toccano soprattutto la segreteria. **Dopo le 01:35 del 17 agosto non
è più uscito nulla in produzione.**

**19 e 20 agosto.** Nessun codice nuovo in produzione. Ma nella notte fra il 19 e il 20 una
migrazione è stata applicata a mano al database vero, e per poco più di mezz'ora ha lasciato una
tabella aperta a chiunque (§ C.1 qui sotto).

---

## I difetti che questo profilo poteva incontrare

**Il criterio, dichiarato una volta.** La tabella elenca ciò che era in produzione per questo
profilo. Due righe — **n. 51** e **n. 58** — non avevano nessun sintomo a schermo: le tengo lo
stesso, perché riguardano i due poteri che definiscono questo profilo (creare un accesso, custodire
un documento d'identità), e la colonna «Cosa si vedeva a schermo» dice apertamente che non si vedeva
niente. Il criterio vale per tutte e due: nessuna delle due è raccontata come qualcosa che un tester
ha visto.

| # inv. | Cosa si vedeva a schermo | Gravità | Rotto fino al | Commit | Verificato |
|---|---|---|---|---|---|
| 47 | «Approva» su una candidatura da insegnante creava un accesso al registro di 33 bambini e ne spediva la password all'email scritta in un modulo pubblico e anonimo. Approvare invece l'anagrafica della persona assunta davvero non spediva niente, e mostrava la password in un riquadro che avvisava «si vedono una volta sola» — chiuso quello, era persa | bloccante | 15/08 19:23 | `fcc51fc8` chiude · `a9dcc6d8` apre (11/08 10:16) | entrambi su `main`; frasi lette in `messages/it/adminAltro.json` prima e dopo |
| 50 | Le fasce d'età che il candidato si spuntava da solo nel modulo pubblico diventavano il suo permesso: chi spuntava «primaria» otteneva l'elenco delle classi di primaria, cioè i bambini — anche riusando un accesso che esisteva già | bloccante | 12/08 07:09 sulla porta dell'anagrafica · 15/08 19:23 su quella delle candidature | `65e3631c` · `fcc51fc8` | entrambi su `main`; scrittura del campo presente in `a9dcc6d8` e assente dopo `fcc51fc8` |
| 39 | Si confermava una cancellazione irreversibile digitando cognome e nome del bambino e leggendo quattro righe, di cui una sola parlava di documenti: «File personali rimossi». Dentro quel numero se ne andavano pagelle e certificati medici, che nessuna riga nominava. Se il conteggio preventivo falliva, l'avviso tornava vuoto e il pulsante rosso restava premibile. E nell'altro pannello si leggevano i numeri di un bambino diverso da quello che si stava cancellando | bloccante | 13/08 02:24 | `d7af75b6` | su `main`; testo dell'avviso letto in `d7af75b6^`, che non nomina né pagelle né certificati |
| 38 | «Elimina Alunno (GDPR)» falliva su 28 bambini su 33: un errore tecnico e nessuna cancellazione. Il pulsante prometteva una cosa che il sistema non sapeva fare | bloccante | 13/08 02:24 | `d7af75b6` | su `main`; misura «28 su 33» nel messaggio del commit |
| 34 | Nessuna scansione di documento d'identità del personale si apriva più, in nessuna delle tre sedi, e la frase mostrata accusava chi guardava: «non esiste, oppure appartiene a un'altra sede» | bloccante | 13/08 02:24 | `d7af75b6` | su `main`; introdotto con `65e3631c` (12/08 07:09) |
| 35 | Ogni apertura di un fascicolo del personale finiva in errore | bloccante | 13/08 02:24 | `d7af75b6` | su `main` |
| 46 | Sbagliato il caricamento del fronte del documento, si leggeva la frase di un'altra schermata — mai la sola notizia che contava: il documento non è stato archiviato | bloccante | 13/08 02:24 | `d7af75b6` | su `main` |
| 57 | Chi caricava la scansione della propria carta d'identità e chiudeva la pagina la lasciava nel magazzino senza nessuna riga che la nominasse: invisibile a chi deve conservarla, e non cancellabile su richiesta | bloccante | 13/08 02:24 | `65e3631c` · `d7af75b6` | entrambi su `main` |
| 49 | La segreteria di una sede poteva farsi aprire il curriculum di chi si era proposto a un'altra: il pannello, davanti a due candidature che dichiaravano lo stesso curriculum, ne apriva una a caso, e la riga che tiene traccia dell'apertura la attribuiva alla candidatura sbagliata (chi aveva aperto era invece registrato giusto) | bloccante | 15/08 02:48 | `b43a556e` | su `main`; l'indice che chiude la porta è nella migrazione `20260814225302` dentro quel commit |
| 28 | Aprendo il registro, al telefono di questo profilo arrivavano — senza mostrarli — il motivo sanitario scritto dal genitore, la nota dell'appello e la ricevuta della firma con email, indirizzo IP e modello di telefono del genitore | bloccante | 08/08 22:54 | `f59854ab` | su `main`; i test aggiunti verificano che quei campi non escano più |
| *(senza numero d'inventario)* | Una candidatura rimasta a metà diceva «Approvazione rimasta a metà · l'account docente È STATO CREATO» e spegneva sia «Approva» sia «Rifiuta»: da lì non si usciva più. Chiudendo l'operazione, il rilascio del 15/08 ha misurato che nessuna riga vera c'era finita | bloccante | 15/08 19:23 | `fcc51fc8` · `a9dcc6d8` apre | entrambi su `main`; frasi `candSospesaTesto` e `candSospesaAzioniSpente` lette in `fcc51fc8^` |
| 41 | I prestampati firmati dalla Scuola rifiutavano di uscire dicendo «manca il nome del legale rappresentante nelle impostazioni della sede: aggiungilo e riprova» — e nelle impostazioni non c'era niente da aggiungere. Se il nome veniva messo per altra via, il primo salvataggio lo cancellava | bloccante | 15/08 12:12 | `0e0ba538` | su `main`; la frase esiste in `0e0ba538^`, i campi per obbedirle nascono in `0e0ba538` |
| 37 | Sette pagine — contabilità, news, mensa, modulistica, primaria, impostazioni, SIDI — dicevano «Hai più sedi attive. Scegline una sola dal menu in alto», e quel menu non si montava affatto. È il profilo che le sedi le ha davvero tutte e tre | bloccante | 13/08 02:24 | `d7af75b6` | su `main`; comportamento descritto nel commit e nel codice del componente |
| 51 | Niente, a schermo: nessun pulsante la chiamava. Ma la porta che crea un adulto accettava come «ruolo» qualunque parola, e chi ha il profilo di segreteria avrebbe potuto crearsi un amministratore | bloccante (latente) | 12/08 07:09 | `a9dcc6d8` · `65e3631c` | entrambi su `main`; campo libero letto in `a9dcc6d8^`, porta rimossa nel file al 12/08 |
| 58 | Niente, a schermo. Il controllo che verifica la forma del percorso di un documento del personale non veniva **mai** eseguito: dimostrato riscrivendolo perché dicesse sempre «va bene» e vedendo che non cambiava nulla | bloccante (latente) | 13/08 02:24 | `d7af75b6` | su `main`; la dimostrazione è nel messaggio del commit |
| 36 | Il cruscotto delle scadenze dichiarava mancante la scansione di un documento che era archiviato, senza segnalare nessun errore | fastidioso | 13/08 02:24 | `d7af75b6` | su `main` |
| 59 | L'elenco del personale era vuoto — nessuna scheda, dodici persone senza fascicolo — e il documento d'identità veniva chiesto su una faccia sola | fastidioso | 13/08 02:24 | `d7af75b6` | su `main` |
| 60 | Nei moduli di consenso la casella da spuntare si portava dietro, come propria etichetta, l'intero testo dell'informativa: proprio dove la volontà deve essere inequivocabile | fastidioso | 12/08 07:09 | `65e3631c` | su `main`; valeva anche sui due percorsi già in produzione |
| C.1 | Nulla, dentro l'app: fuori, una tabella del database ha risposto a chiunque per poco più di mezz'ora la notte del 20 agosto. Vedi il dettaglio qui sotto | bloccante | 20/08 01:27 | `ddfe3b0e` | **non** su `main`: la migrazione è stata applicata a mano al database di produzione, ed è per questo che il difetto è stato vero |

---

## I tre difetti che avrebbero avuto conseguenze fuori dall'app

### 1. n. 47 — un clic consegnava le chiavi del registro di 33 bambini a uno sconosciuto

Dall'**11 agosto alle 10:16** al **15 agosto alle 19:23** — quattro giorni e nove ore — il pannello
delle candidature funzionava così: arriva una candidatura da un modulo pubblico che chiunque può
compilare senza dire chi è; la Direzione preme «Approva»; il sistema crea un accesso da insegnante
e ne spedisce la password all'indirizzo che c'era scritto nel modulo. Un accesso da insegnante legge
nomi, allergie e note mediche dei bambini.

**La frase in testa al pannello è cambiata a metà strada, e va citata per quello che era in
ciascuno dei due periodi.** Dall'11 agosto alle 10:16 al 15 agosto alle 02:48 diceva: *«approvarne
una crea l'account docente e manda le credenziali»*. Dal 15 agosto alle 02:48 — quando il modulo si
apre anche a cucina, collaboratrici e segreteria — diventa: *«approvarne una da INSEGNANTE crea
l'account docente e manda le credenziali, le altre si chiudono senza creare nessun accesso»*. Questa
seconda forma è stata a schermo **16 ore e 35 minuti** prima che l'operazione cambiasse. E c'è una
coda che va detta: il rilascio delle 19:23 **non ha toccato quella frase**. Dal 15 agosto in poi il
pannello ha continuato a promettere un account e delle credenziali che non produce più — la frase
non ha smesso di comparire, ha smesso di essere vera, ed è ancora così sull'ultimo rilascio in
produzione.

Non c'era nessun controllo dell'identità di chi si era candidato, perché non c'era niente da
controllare: il modulo è anonimo per costruzione, ed è giusto che lo sia. Il difetto è che una
decisione presa su un curriculum — «questa persona mi interessa» — apriva la stessa porta che si
apre a chi è già stato assunto, ha firmato un contratto e ha consegnato un documento d'identità.

E l'operazione gemella faceva l'errore opposto: approvare l'anagrafica della persona assunta
davvero — il momento in cui la Direzione ha in mano il documento — **non spediva niente**, e la
password compariva in un riquadro che avvisava «si vedono una volta sola: prendine nota adesso».
Chiusa quella scheda, l'unica copia esistente era sparita.

La misura che il rilascio ha lasciato agli atti: *«consegnava nello stesso clic le chiavi del
registro di 33 minori»*. Trentatré è il numero di bambini in anagrafica.

La stessa porta aveva un secondo giro di chiave, ed è la riga **n. 50** in tabella: le fasce d'età
che il candidato spuntava da sé nel modulo diventavano il suo permesso. Chi spuntava «primaria»
otteneva l'elenco delle classi di primaria — cioè i bambini — e lo otteneva anche riusando un
accesso che esisteva già.

### 2. n. 39 — si confermava alla cieca la distruzione delle pagelle e dei certificati medici di un bambino

Fino al **13 agosto alle 02:24**, la schermata che esegue una cancellazione GDPR chiedeva di
digitare cognome e nome del bambino per confermare, e prima di quella riga mostrava quattro numeri. Uno
solo parlava di documenti: «File personali rimossi». Dentro quel numero — «file da rimuovere: 3» —
se ne andavano **le pagelle e i certificati medici** del bambino, che nessuna delle quattro righe
nominava. L'operazione è irreversibile.

Due aggravanti, entrambe registrate nel rilascio che le ha chiuse:

- se il conteggio preventivo falliva, **l'avviso tornava vuoto e il pulsante rosso restava
  premibile**: si poteva confermare una distruzione irreversibile davanti a una schermata che non
  diceva niente perché non era riuscita a contare;
- nell'altro pannello che mostra lo stesso avviso, i numeri erano quelli **di un bambino diverso**
  da quello che si stava cancellando.

Accanto, e per tutto il tempo precedente, il pulsante «Elimina Alunno (GDPR)» falliva su 28 bambini
su 33 (**n. 38**): una richiesta di cancellazione di un genitore, che la legge vuole evasa entro
trenta giorni, in cinque casi su sei non si poteva evadere affatto. Dal 13 agosto la strada è
un'altra e più onesta: il bambino si **archivia** — reversibile, anagrafica intatta, perché il suo
nome tiene in piedi i registri che si conservano dieci anni — e i suoi file si liberano a parte.

### 3. PARTE C.1 — per poco più di mezz'ora una tabella del database ha risposto a chiunque

La notte del **20 agosto**, fra le **00:50** e le **01:27**, una tabella nuova è stata creata nel
database di produzione senza la protezione che chiude le tabelle al pubblico. Una tabella creata
senza quella riga non è «non ancora protetta»: è **aperta dal secondo in cui esiste**, a chiunque
usi la chiave pubblica che sta dentro il sito, cioè a chiunque apra il sito.

**Cosa era esposto, con precisione.** La tabella tiene una riga per ogni plesso a cui una
candidatura di «Lavora con noi» è rivolta, e ha sette colonne: l'identificativo interno della
candidatura, quello della sede, lo stato (in valutazione, approvata, rifiutata), la data della
decisione, l'identificativo di chi ha deciso, **il motivo del rifiuto scritto a mano** e la data di
arrivo. Chi lo avesse chiesto le avrebbe avute tutte. La prova conservata nel rilascio ne chiede
due, ed è quella che ha dimostrato il buco: la tabella rispondeva con le righe.

La conseguenza descritta agli atti è che *chiunque poteva contare quante candidature ha ricevuto
ogni plesso*. Va detto anche il resto: se una candidatura era già stata respinta con una nota, in
quella mezz'ora il testo di quella nota era leggibile da fuori.

**Cosa NON era esposto, ed è la parte che tiene.** Nomi, cognomi, email, telefoni e curriculum non
stanno in quella tabella: stanno nella tabella sorella, che era chiusa. La misura fatta quella
notte lo dice senza margini: interrogata con la stessa chiave pubblica, **la tabella sorella ha
risposto vuoto**. Gli identificativi esposti sono codici interni: da soli non dicono chi è la
persona, perché per risolverli serve proprio la tabella che era chiusa. Nessun dato di bambini è
mai stato in quella tabella.

Un secondo pezzo, che riporto per com'è: nello stesso giro la funzione automatica che aggiorna lo
stato di una candidatura era stata scritta con privilegi elevati e senza toglierne l'esecuzione al
pubblico; la correzione, arrivata con lo stesso commit, la toglie esplicitamente. **Questo l'ho
letto nel testo della migrazione, non l'ho provato contro il database** — questo lavoro è in sola
lettura sul repository — quindi lo scrivo come risulta dal codice, non come una misura mia.

**Quanto è durato, senza fingere una precisione che non ho.** Fra il commit che crea la tabella
senza protezione (00:50:56) e quello che gliela accende (01:27:07) passano **36 minuti**, ma sono
due timbri di commit, non due istanti di produzione: questo difetto è stato vero **proprio perché**
la migrazione era stata applicata a mano al database prima di essere committata — il commit che la
introduce dice «applicata in produzione su 18 candidature vere» e «sette invarianti verificati
**dopo** l'applicazione». Alle 00:50:56 la tabella in produzione c'era già da prima. Quindi:
**almeno 36 minuti**; **la misura di chi ha chiuso il buco dice circa un'ora** («era PUBBLICA per
un'ora», «un buco vero che avevo aperto io un'ora prima»); **l'istante esatto in cui la migrazione
è stata applicata al database non è provato** da nessuna delle mie verifiche.

---

## Cosa questo profilo NON poteva incontrare, e perché lo scrivo

Tre cose che stanno nell'inventario e che, misurate, **in produzione non sono mai state vere**.
Le scrivo perché un elenco di difetti gonfiato di uno vale meno di un elenco corto e vero.

1. **n. 44, «tre comandi spenti su tre» sulle pratiche del personale — mai in produzione.** Il
   pannello delle pratiche è nato su `main` il 12 agosto alle 07:09 **già corretto**: nel file
   rilasciato, la frase mostrata dice «Approva e Sposta di sede restano spenti… Resta "Rifiuta", che
   è l'unico modo di chiuderla». Lo stato con tutti e tre i comandi spenti appartiene al lavoro
   della notte precedente, prima dell'unione in `main`. Ciò che questo profilo **poteva** davvero
   incontrare è il gemello sulle candidature: è la riga *(senza numero d'inventario)* in tabella, e
   non porta il numero 44 proprio per non far passare due difetti diversi sotto la stessa etichetta.
   Lì «Approva» e «Rifiuta» si spegnevano entrambi e non restava nessuna uscita. Anche di quello va
   detta la misura: chiudendo l'operazione il 15 agosto è stato verificato che **nessuna riga vera**
   era rimasta in quello stato.
2. **n. 48, «approvare una cuoca avrebbe creato un accesso da insegnante» — pericolo evitato nello
   stesso rilascio.** Il commit che il 15 agosto alle 02:48 apre il modulo a cucina, collaboratrici
   e segreteria porta con sé, nello stesso momento, la strada che approva **senza creare nessun
   accesso**. Il condizionale dell'inventario è esatto: in produzione, premere «Approva» su una
   candidatura non da insegnante non ha mai generato un account.
3. **n. 49, la riapertura del 19-20 agosto — mai in produzione.** La difesa sul curriculum è stata
   indebolita e poi rimessa a posto, ma tutt'e due i commit stanno solo sul ramo di lavoro:
   `git branch --contains` non trova `main` per nessuno dei due. Sull'ultimo commit di produzione la
   difesa è al suo posto, con scritto accanto perché. **In produzione la porta è chiusa dal 15
   agosto alle 02:48 e non si è più riaperta.**

E poi, per confine di profilo: le schermate del genitore e della maestra (righe 1-33 dell'inventario)
e il lavoro di carta della segreteria — carta intestata, certificati protocollati, registro presenze,
sala d'attesa, scheda del genitore, ricevuta di firma (righe 40, 42, 43, 45, 52-56) — appartengono ad
altri profili. Restano fuori anche tutta la **PARTE B** (cron, email, fatturazione, log: reale e
corretta, ma invisibile dentro l'app) e tutta la **PARTE C.2**, cioè il resto del lavoro del 19-20
agosto, che non è mai arrivato in produzione.

---

## Verifiche eseguite

Fonte unica: `docs/collaudo/produzione/00-INVENTARIO-difetti-6-20-agosto.md`. Nessuna scrittura,
nessun `git` che modifichi qualcosa, nessun accesso al database.

- **Ogni commit citato, uno per uno**, con `git show --stat --oneline <hash> | head -20` e
  `git show -s --format='%ci %H'` per data e ora reali:
  `f59854ab` 08/08 22:54 · `a9dcc6d8` 11/08 10:16 · `65e3631c` 12/08 07:09 · `d7af75b6` 13/08 02:24 ·
  `b43a556e` 15/08 02:48 · `0e0ba538` 15/08 12:12 · `fcc51fc8` 15/08 19:23 · `ddfe3b0e` 20/08 01:27 ·
  `aa048978` 20/08 02:48.
- **Presenza in produzione**, con `git branch --contains <hash> | grep -w main`: tutti su `main`
  **tranne** `ddfe3b0e` e `aa048978`. Confermato che l'ultimo commit di `main` è del **17/08 alle
  01:35**, quindi nulla del 19-20 agosto è stato rilasciato per via di codice.
- **Le frasi mostrate a schermo** lette nei file di testo dell'interfaccia prima e dopo la
  correzione (`git show <hash>^:messages/it/adminAltro.json` e `messages/it/prestampatiSegreteria.json`),
  per scrivere ciò che l'utente leggeva davvero e non una parafrasi.
- **La frase in testa al pannello Candidature, rilascio per rilascio**, con
  `for h in a9dcc6d8 65e3631c b43a556e fcc51fc8 b87ee964; do git show $h:messages/it/adminAltro.json | grep -m1 candIntro; done`:
  identica nei primi due, cambiata in `b43a556e` (15/08 02:48), **non toccata** da `fcc51fc8` e
  ancora presente immutata sull'ultimo commit di produzione. È la ragione per cui il documento cita
  due frasi diverse invece di una sola.
- **La schermata di conferma della cancellazione**: `oblioPlaceholderNome` vale `"Cognome Nome"`,
  quindi la conferma chiedeva cognome **e** nome, non il solo cognome.
- **n. 47**: verificato che la creazione dell'accesso e l'invio della password erano nella rotta di
  approvazione già in `a9dcc6d8` e non ci sono più in `fcc51fc8`; e che l'invio dell'email compare
  sulla porta dell'anagrafica proprio in `fcc51fc8`.
- **n. 50**: verificato che il campo dei permessi veniva scritto dalla rotta delle candidature in
  `a9dcc6d8` e in `65e3631c`, e non più dopo `fcc51fc8`.
- **n. 44 e n. 48**: verificato **nel file rilasciato** che la correzione viaggiava già dentro il
  commit che introduce la funzione — è la ragione per cui li ho tolti dalla tabella.
- **n. 49**: cercato in tutti i commit di ramo quale avesse indebolito la difesa
  (`650dbd84`, 20/08 02:06) e quale l'avesse rimessa (`aa048978`, 20/08 02:48); verificato che
  sull'ultimo commit di produzione la difesa è presente.
- **n. 49**: riletto il testo della migrazione che chiude la porta per non attribuire al difetto
  più di quello che era. La riga di sorveglianza registrava correttamente **chi** apriva il
  curriculum; ciò che risultava sbagliato era **quale** candidatura veniva attribuita all'apertura,
  perché fra due righe che dichiaravano lo stesso curriculum ne usciva una a caso.
- **C.1**: confrontata la prima stesura della migrazione (`e8319816`, 20/08 00:50:56) con quella
  corretta (`ddfe3b0e`, 20/08 01:27:07): nella prima la riga che chiude la tabella al pubblico
  **non c'è**; lette le sette colonne della tabella per dire con precisione cosa era esposto; letti
  i due messaggi di commit per la durata — quello che apre dichiara di aver applicato la migrazione
  in produzione **prima** del commit, quello che chiude parla di «un'ora».
