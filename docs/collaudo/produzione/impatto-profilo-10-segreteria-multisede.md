# Profilo 10 — segreteria su più sedi

> **Questo NON è un feedback ricevuto.** È la ricostruzione, provata commit per commit, dei difetti
> che un utente con questo profilo poteva incontrare nell'app fra il 6 e il 20 agosto 2026.

## Come si presentava l'app a questo profilo, giorno per giorno

**Prima di tutto: chi è, davvero, questo profilo dentro l'app.** «Segreteria che lavora su più sedi»
descrive il mestiere, non il ruolo tecnico. Nell'app un account con ruolo `segreteria` **non può
essere multi-sede**: `scuoleDiUtente` (`src/lib/auth/scope.ts:59`) taglia corto — `if (user.role !==
'admin') return own` — e restituisce la sola `utenti.scuola_id`. Le righe nel ponte `utenti_scuole`
esisterebbero anche, ma non verrebbero lette. Chi svolge il lavoro di segreteria sui tre plessi lo fa
quindi da un account di **Direzione (`admin`)**, ed è l'unico tipo di account a cui il selettore di
sede compaia. È anche il motivo per cui questo profilo è piccolo: il PRD annota che, dei 57 utenti di
produzione, **una sola sede in più ce l'aveva soltanto l'admin del titolare**, e che l'account
`test.multisede.admin@kidville.test` è stato creato il 31/07 proprio perché quel ramo non era
altrimenti collaudabile senza usare le credenziali di una persona vera.

**Come arrivavano le correzioni.** L'app Android è una WebView su `https://app.kidville.it`: ogni
deploy web raggiungeva i tester **senza un nuovo bundle**. Le date qui sotto non sono date di rilascio
su Play, sono i minuti in cui lo schermo cambiava da solo, anche a app già installata.

| Quando | Cosa cambiava sotto le mani di questo profilo |
|---|---|
| **6 → 11 agosto** | La settimana più silenziosa e la peggiore. Aperti e non ancora toccati: la scheda del genitore che non salvava niente (n. 40, aperta dal **5 luglio**), «Elimina Alunno (GDPR)» che falliva sulla stragrande maggioranza dei bambini (n. 38), il riquadro di conferma dell'anonimizzazione che contava i file senza nominarli (n. 39), la carta intestata che spariva al primo aggiornamento (n. 42), la «Sala d'Attesa» irraggiungibile (n. 43), la ricevuta di firma con email, IP e User-Agent stampati sul foglio (n. 54), le caselle di consenso con la label che inglobava l'informativa (n. 60). E, sopra tutto, il n. 37. |
| **11 agosto, 10:16** (`a9dcc6d8`) | La scheda del genitore comincia finalmente a salvare. Chiusa anche la rotta di creazione adulti che accettava un `role` libero (n. 51, prima metà). |
| **12 agosto, 07:09** (`65e3631c`) | La spunta del modulo pubblico smette di regalare lo scope `primaria` (n. 50); le caselle di consenso vengono separate dall'informativa (n. 60). |
| **12 agosto (ora non provata) → 13 agosto, 02:24** | **Le ore peggiori della finestra.** In giornata, il 12/08, una migrazione rinomina in produzione la colonna che teneva il percorso della scansione del documento. Da quel momento **nessuna scansione di documento d'identità del personale è più apribile in nessuna delle tre sedi** (n. 34), ogni fascicolo del personale risponde 503 (n. 35), il cruscotto Scadenze dichiara assenti scansioni che nell'archivio ci sono (n. 36). **L'istante di apertura non lo so**, e non lo scrivo: l'unica cosa che avrei da mostrare è il nome del file di migrazione, che dice quando quel file è stato *scritto*, non quando è stato *applicato*. Provata è solo la chiusura: **13/08 alle 02:24**. |
| **13 agosto, 02:24** (`d7af75b6`) | Il rilascio che cambia la giornata di questo profilo: chiuso il n. 37 — e con lui 34, 35, 36, 38, 39, 57, 59. |
| **15 agosto, 00:25 → 19:23** (`0e8480a3`, `b43a556e`, `0e0ba538`, `fcc51fc8`) | Quattro rilasci in diciannove ore: il certificato Bonus Nido torna rilasciabile alla famiglia sospesa (n. 52); il curriculum di chi si è candidato a un altro plesso smette di essere firmabile dalla Segreteria sbagliata (n. 49); **nasce** la schermata «Sede & Intestazione» che il messaggio d'errore prometteva da giorni (n. 41); «Prendo in considerazione questa candidatura» smette di consegnare le chiavi del registro (n. 47, 48). |
| **16 agosto, 11:31** (`0974424a`) | L'ultimo rilascio che questo profilo vede: la ricevuta di firma senza IP e User-Agent (n. 54), il tab dei template che finalmente conserva ciò che si carica (n. 42), la «Sala d'Attesa» tolta di mezzo (n. 43), il codice meccanografico a due valori accettato in scrittura (n. 56). |
| **17 → 20 agosto** | In produzione, per questo profilo, **non cambia più niente di visibile**. Tutto il lavoro del 19-20 agosto vive su `feat/candidature-multisede` e non è mai stato in produzione. L'unica cosa che è stata vera in produzione in quelle ore è invisibile dentro l'app: vedi l'ultima sezione. |

## Le sette pagine che chiedevano di usare un menu che non c'era

Questo è il difetto che definisce il profilo, ed è l'unico che **non poteva capitare a chi lavora su
una sede sola nello stesso modo**. Vale la pena raccontarlo per intero, perché il sintomo sembra una
sciocchezza e non lo è.

Con più plessi attivi, sette pagine della Direzione pretendono che se ne indichi **uno solo** prima
di aprirsi: **contabilità, news, mensa, modulistica, primaria, impostazioni e SIDI**. È il
comportamento normale, non un difetto: ci scrivi dentro, e una scrittura senza sede dichiarata
finisce nel plesso sbagliato in silenzio. Quando le sedi attive sono più d'una, quelle pagine
mostrano un riquadro che dice *«Hai più sedi attive. Scegli qui sotto su quale vuoi lavorare»* con i
bottoni delle sedi sotto. Tutto giusto.

**Il difetto era in cosa succedeva quando l'elenco dei plessi non arrivava.** Il caricatore delle
sedi era scritto così: `try { … if (res.ok) { list = … } } finally { setSedi(list) }`. Nessun ramo
d'errore, nessun log. Se `GET /api/admin/sedi` rispondeva male, o la rete della WebView cadeva per un
istante, `list` restava vuota — e *vuota* voleva dire due cose opposte allo stesso tempo: «non ho
saputo quali sedi hai» e «non ne hai nessuna». Il codice le confondeva, e da lì partiva una catena di
tre bugie:

1. senza sedi, nessuna sede è «quella corrente», quindi tutte e sette le pagine mostravano il
   riquadro di scelta;
2. il riquadro, in quel ramo, non scriveva la frase con i bottoni: scriveva **«Hai più sedi attive.
   Scegline *una sola* dal menu in alto»** — e i bottoni li disegnava solo se le sedi conosciute erano
   più d'una, cioè lì non ce n'era nemmeno uno;
3. **quel menu non si montava affatto.** Il selettore di sede della barra in alto ha una guardia
   secca — `if (sedi.length <= 1) return null` — e con l'elenco vuoto non compariva né sul telefono
   né sul desktop.

Tre frasi, tutte e tre false, e nessuna eseguibile: chi le leggeva poteva solo ricaricare la pagina
alla cieca, senza sapere se stava sbagliando qualcosa. E **non restava traccia da nessuna parte**: un
guasto di rete non produceva una riga di log, quindi non c'era neppure modo di scoprire dopo che era
successo. A due passi, nella stessa barra, un'altra chiamata alla stessa identica rotta il suo errore
lo scriveva: due chiamate alla stessa API, una che parla e una muta.

**E c'era il colpo di coda.** Nello stesso punto, il codice «potava» dal cookie `sedi_attive` le sedi
non più accessibili — una cosa sensata su un elenco attendibile. Su un elenco vuoto per errore
significava **cancellare la sede che l'utente aveva scelto**. Chi lavorava da settimane su un plesso
solo, dopo un secondo di rete storta, si ritrovava l'avviso di scelta al posto della sua sede: il
guasto gli aveva cambiato le preferenze.

**Cosa si poteva fare lo stesso, e cosa no.** Le pagine che *non* pretendono una sede sola —
avvisi, staff, protocolli, elenco alunni e le altre — restavano aperte e funzionanti, perché lì lo
scope può essere «tutte le sedi». Misurato, non dedotto: su quelle quattro pagine, nella versione
precedente alla correzione, le occorrenze di `useSede`, `sedeCorrente` e `SedeRequired` sono **zero**
(comando in fondo). Il blocco era chirurgico e cadeva esattamente sulle sette pagine dove si
**scrive**: registrare un incasso, pubblicare una news,
chiudere il menù della mensa, mandare o ricevere un modulo, toccare i registri della primaria,
cambiare l'anagrafica di sede, trasmettere al SIDI. Cioè: si poteva guardare tutto e non si poteva
concludere niente.

Chiuso il **13 agosto alle 02:24** (`d7af75b6`). Da lì l'app distingue i tre casi: una sede sola →
si apre; più sedi → si sceglie, con i bottoni; **elenco non arrivato → lo dice** («Non è stato
possibile leggere le tue sedi… non è detto che tu non ne abbia»), lo scrive nei log con lo stato
HTTP, offre un **«Riprova»** che riprova davvero — e la sede già scelta **non viene più buttata via**.

## I difetti che questo profilo poteva incontrare

Gravità e finestre sono quelle dell'inventario. «Rotto fino al» è il momento in cui il deploy web ha
raggiunto l'app, senza bisogno di aggiornare nulla su Play.

| # inv. | Cosa si vedeva a schermo | Gravità | Rotto fino al | Commit | Verificato |
|---|---|---|---|---|---|
| **37** | **Sette pagine — contabilità, news, mensa, modulistica, primaria, impostazioni, SIDI — dicevano «Hai più sedi attive. Scegline una sola dal menu in alto», e quel menu non c'era.** Nessun bottone, nessuna spiegazione, nessun modo di obbedire. E la sede su cui si stava lavorando spariva da sola | bloccante | 13/08 02:24 | `d7af75b6` | ✅ su `main` |
| **34** | Aprivo la scansione della carta d'identità di una maestra e leggevo **«non esiste, oppure appartiene a un'altra sede»**. Non era vero né l'uno né l'altro: era rotta la lettura. Su tutte e tre le sedi, per nessuno funzionava | bloccante | 13/08 02:24 | `d7af75b6` | ✅ su `main` |
| **35** | **Errore 503 a ogni apertura di un fascicolo del personale** | bloccante | 13/08 02:24 | `d7af75b6` | ✅ su `main` |
| **36** | Il cruscotto Scadenze diceva che la scansione del documento non c'era, **mentre nell'archivio c'era**. Nessun errore a schermo: solo il dato sbagliato | fastidioso | 13/08 02:24 | `d7af75b6` | ✅ su `main` |
| **57** | Chi caricava la scansione della propria carta d'identità e chiudeva la pagina **lasciava la foto nell'archivio senza nome e senza nessuna riga che la nominasse**: invisibile, e non cancellabile su richiesta | bloccante | 12/08 07:09 e 13/08 02:24 | `65e3631c`, `d7af75b6` | ✅ entrambi su `main` |
| **59** | La scheda dell'anagrafica del personale chiedeva **una faccia sola** del documento, e l'elenco era vuoto: nessuna scheda per dodici persone in servizio | fastidioso | 13/08 02:24 | `d7af75b6` | ✅ su `main` |
| **38** | **«Elimina Alunno (GDPR)» falliva su 28 bambini su 33**, con un errore tecnico. Il bottone prometteva una cosa che non poteva mantenere | bloccante | 13/08 02:24 | `d7af75b6` | ✅ su `main` |
| **39** | Si confermava un'anonimizzazione **irreversibile** leggendo «file da rimuovere: 3»: dentro c'erano pagelle e certificati medici che nessuna riga nominava. Se il controllo preventivo falliva l'avviso restava muto e **il bottone rosso restava premibile**. E nell'altro pannello si leggevano i numeri **di un bambino diverso** | bloccante | 13/08 02:24 | `d7af75b6` | ✅ su `main` |
| **40** | **La scheda del genitore non salvava niente.** Ogni «Salva» falliva, dal 5 luglio | bloccante | 11/08 10:16 | `a9dcc6d8` | ✅ su `main` |
| **51** | Creare un adulto dal pannello era irraggiungibile e lasciava account a metà — e il campo del ruolo era **testo libero**: dal pannello di segreteria ci si sarebbe potuti creare un `admin` | bloccante (latente) | 11/08 10:16 e 12/08 07:09 | `a9dcc6d8`, `65e3631c` | ✅ entrambi su `main` |
| **50** | **Una spunta sbagliata su un modulo pubblico e anonimo dava a qualcuno l'elenco delle classi di primaria** — cioè i bambini. La casella arrivava dal form e veniva applicata anche a un account che esisteva già | bloccante | 12/08 07:09 | `65e3631c` | ✅ su `main` |
| **60** | Le caselle di consenso avevano **la label che inglobava l'intero testo dell'informativa**, anche sui due percorsi già in produzione: proprio dove la volontà dev'essere inequivocabile | fastidioso | 12/08 07:09 | `65e3631c` | ✅ su `main` |
| **47** | **«Prendo in considerazione questa candidatura» consegnava nello stesso clic le chiavi del registro di 33 minori**: creava un account da educatrice e ne spediva la password a un indirizzo arrivato da un modulo pubblico anonimo. Mentre approvare l'anagrafica vera **non spediva niente**, e mostrava la password in un riquadro che chiudendosi se la portava via | bloccante | 15/08 19:23 | `fcc51fc8` | ✅ su `main` |
| **49** | La Segreteria di una sede poteva farsi firmare **il curriculum di chi si era proposto a un'altra** | bloccante | 15/08 02:48 | `b43a556e` | ✅ su `main` |
| **41** | I prestampati firmati dalla Scuola rifiutavano di uscire dicendo «aggiungilo nelle impostazioni della sede» — **e nelle impostazioni non c'era niente da aggiungere**. Peggio: il nome del legale rappresentante **veniva cancellato al primo salvataggio**. E la schermata dove si compila non era in nessun menu | bloccante | 15/08 12:12 | `0e0ba538` | ✅ su `main` |
| **52** | Il certificato per il Bonus Nido era **irrilasciabile proprio alla famiglia sospesa per morosità**, che è quella che lo chiede | fastidioso | 15/08 00:25 | `0e8480a3` | ✅ su `main` |
| **42** | Trascinavo la carta intestata nel tab dei template, leggevo «documento caricato», e **al primo aggiornamento della pagina era sparito tutto** | bloccante | 16/08 11:31 | `0974424a` | ✅ su `main` |
| **43** | Il pannello **«Sala d'Attesa» era irraggiungibile da mesi** | fastidioso | 16/08 11:31 | `0974424a` | ✅ su `main` |
| **54** | La ricevuta di firma stampava sul foglio **l'email di chi aveva firmato, il suo indirizzo IP e l'intero identificativo del suo browser**; e l'ora della firma usciva due ore indietro | bloccante | 16/08 11:31 | `0974424a` | ✅ su `main` |
| **56** | Salvare l'anagrafica di sede **rispondeva «dati non validi»**: il limite di 20 caratteri sul codice meccanografico era tarato su un codice solo | fastidioso | 16/08 11:31 | `0974424a` | ✅ su `main` |

Un difetto elencato fra quelli del docente lo vedeva anche questa scrivania e va nominato: il **n.
28** — al browser della maestra «e di segreteria e Direzione» arrivavano il motivo sanitario del
minore, la nota d'appello e i dati tecnici della firma del genitore, e in due casi finivano anche nel
registro di sorveglianza, conservato per anni. Chiuso il 7-8 agosto con `f59854ab` (verificato su
`main`).

## Dove il multi-sede peggiorava un difetto che la sede singola subiva più lieve

**n. 37 — lo stesso schermo, due significati diversi.** Anche una segreteria di sede singola finiva
sul riquadro impossibile quando l'elenco non arrivava: senza sedi conosciute, nessuna pagina sa su
quale plesso sta lavorando, e la guardia scatta per tutti. Ma la frase *«Hai più sedi attive»*
atterrava in modo opposto sulle due scrivanie. Su una sede sola è **palesemente assurda** — «ne ho
una, di che parla?» — e si legge subito come un guasto dell'app. Su tre sedi è **la frase che si
legge ogni giorno**: è il testo del funzionamento normale. Chi ha davvero tre plessi non aveva modo
di distinguere un guasto di rete dalla routine, e passava il tempo a cercare un menu che, in quel
momento, era l'unica cosa che non poteva esistere. Il difetto era identico; la possibilità di
accorgersene, no.

**n. 37, seconda metà — solo chi ha una scelta può perderla.** La potatura del cookie faceva danno
solo a chi ci aveva scritto qualcosa dentro. Una segreteria di sede singola ha il cookie vuoto (che
vuol dire «tutte», cioè la sua), e non aveva niente da perdere. Una Direzione che lavorava «solo su
Aversa» aveva quell'unica sede memorizzata, e un secondo di rete storta gliela cancellava: tornata la
rete, invece della sua sede si ritrovava l'ambiguità. Questa metà del difetto **è esclusivamente di
questo profilo**.

**n. 34 — «appartiene a un'altra sede» detto a chi le sedi ce le ha tutte.** Su una scrivania di sede
singola quella frase è una spiegazione: *quel documento è di un altro plesso, non è affar tuo*.
Sgradevole ma coerente. Su una scrivania che gestisce Giugliano, Aversa e Cesa la stessa frase è
**incomprensibile**: le sedi sono tutte sue, non esiste «un'altra». L'unica lettura che restava era
la peggiore — «sto guardando dove non dovrei» — cioè la risposta di un tentativo abusivo data a chi
stava facendo il proprio lavoro. E, non secondario: chi ha tre plessi ha tre archivi del personale,
quindi tre volte le occasioni di sbatterci contro nella stessa mattina.

**n. 56 — due sedi su tre, non «un caso limite».** Il campo del codice meccanografico accettava al
massimo 20 caratteri. Aversa ha un codice solo, dieci caratteri: passava. **Giugliano e Cesa ne hanno
due a testa** — nido/infanzia e primaria — che scritti in un campo solo fanno 23 caratteri: il
salvataggio rispondeva «dati non validi». Per una segreteria di sede singola questo difetto o non
esisteva (Aversa) o era un singolo campo bloccato; per chi tiene i tre plessi era **la stessa
schermata che funziona su uno e rifiuta gli altri due**, senza che nulla lasciasse capire perché. E
la conseguenza non finiva lì: quel valore è la terza riga della testata, quindi il certificato usciva
senza.

**n. 41 — tre volte lo stesso vuoto.** L'anagrafica di sede è per sede. La schermata dove compilarla
non era in nessun menu, e il campo del legale rappresentante veniva cancellato al primo salvataggio.
Per una sede singola è un dato mancante; per questo profilo sono **tre legali rappresentanti e tre
autorizzazioni comunali diverse**, una per plesso, tutte irrecuperabili nello stesso modo — e tre
volte il messaggio che rimandava a una schermata inesistente.

**n. 49 — il difetto è cross-sede per definizione.** «Farsi firmare il curriculum di chi si era
proposto a un'altra sede» presuppone che le sedi siano più d'una. Una segreteria di sede singola era
la potenziale *vittima* del difetto — il curriculum arrivato a lei poteva finire sotto gli occhi di
un altro plesso; questo profilo era, senza saperlo, la scrivania da cui il confine si attraversava.

**n. 39 — il rumore di fondo del multi-plesso.** Il pannello dell'anonimizzazione che mostrava «i
numeri di un bambino diverso» pesa diversamente su chi ha 33 bambini in una sede sola e su chi ne ha
tre elenchi da tenere distinti: qui la domanda «di chi sono questi tre file che sto per cancellare
per sempre» ha tre risposte possibili invece di una.

*(In questo punto avevo messo anche il n. 55 — la carta intestata con le tre sedi stampate sopra. Ce
l'ho tolto: vedi le esclusioni.)*

**Dove i due profili coincidono, e lo dico senza girarci intorno:** i numeri **35, 36, 38, 40, 42,
43, 47, 50, 51, 52, 54, 57, 59, 60** colpivano allo stesso identico modo la segreteria di una sede
sola. Sono quattordici su venti. Il profilo 10 non aggiunge nulla lì: aggiunge il 37
(che è quasi tutto suo), e cambia il *significato* di 34, 39, 41, 49 e 56.

## Cosa questo profilo NON poteva incontrare, e perché lo scrivo

**La PARTE C.1 — la tabella `candidature_sedi` pubblica per un'ora — no. Non poteva accorgersene, e
la risposta onesta è questa.** Fra le **00:50 e le 01:27 circa del 20 agosto** la tabella
`candidature_sedi` è esistita in produzione senza protezione a livello di riga: chiunque, con la
chiave pubblica che sta dentro il JavaScript del sito, poteva chiedere l'elenco e **contare quante
candidature ha ricevuto ogni plesso**. Nello stesso giro, la funzione del trigger era invocabile da
chiunque per riscrivere lo stato di una candidatura. Chiuso e verificato in produzione lo stesso
giorno (`ddfe3b0e`).

Perché non era visibile a questo profilo, per tre ragioni indipendenti:
1. **non c'era niente da vedere.** Non era una schermata, non era un errore, non era un rallentamento:
   era un indirizzo del database che rispondeva a chi glielo chiedeva da fuori. Dentro l'app, ogni
   pannello si comportava esattamente come il giorno prima;
2. **il codice che usa quella tabella non era in produzione.** `ddfe3b0e` **non è su `main`**
   (verificato: `git branch --contains ddfe3b0e | grep -w main` non restituisce nulla). In
   produzione girava ancora il modulo a sede unica: la funzione «più sedi spuntate» non compariva da
   nessuna parte. Solo le migrazioni erano state applicate a mano al database — ed è esattamente per
   questo che il buco è stato reale mentre il resto no;
3. **l'orario.** Trentasette minuti fra la mezzanotte e l'una e mezza di notte.

Lo scrivo lo stesso perché **i dati esposti erano suoi**: «quante candidature ha ricevuto ogni
plesso» è precisamente l'informazione che questa scrivania amministra. Il fatto che sia stato chiuso
in trentasette minuti non lo rende meno vero — lo rende solo invisibile a chi lo subiva.

**Sette numeri li avevo messi in tabella, e ce li ho tolti: nessuno dei sette è mai esistito in
produzione nella forma in cui li avevo descritti.** È lo stesso errore ripetuto sette volte —
attribuire a un utente il difetto di una schermata che, in quel momento, non era ancora sul suo
telefono. In tutti e sette i casi la prova è la stessa e si legge in una riga: il file che contiene
il difetto **nasce nel commit che lo corregge**. Un difetto trovato dal collaudo interno prima del
rilascio è un difetto vero, ma non è un difetto che qualcuno abbia subìto.

- **n. 46** («caricando il fronte di un documento leggevo la frase di un'altra schermata»): la rotta
  che quel pulsante chiama **nasce dentro `d7af75b6`** — `git log --diff-filter=A --
  src/app/api/admin/anagrafica-personale/scansione/route.ts` restituisce `d7af75b6`, e a `d7af75b6^`
  `git grep -il "fronte" -- 'messages/**'` non trova **nulla**: la parola «fronte» non era in nessun
  catalogo di testi. Il pulsante «Carica il fronte» non c'era. Il PRD la chiama, testualmente, «la
  porta **nuova**». Il difetto è reale ed è stato corretto — ma è stato corretto *prima* di
  esistere per un utente.
- **n. 45** («il pannello Sede & Intestazione riscriveva sopra ciò che stavo digitando»): il pannello
  **nasce in `0e0ba538`**, cioè nel commit che avevo indicato come sua correzione
  (`git log --diff-filter=A -- …/settings/AnagraficaSedeSettings.tsx` → `0e0ba538`). Una schermata
  che compare il 15/08 alle 12:12 non può aver dato fastidio a nessuno prima delle 12:12. Era un
  difetto della prima stesura, trovato dal collaudo interno e chiuso nello stesso rilascio.
- **n. 58** («il controllo sulla forma del percorso del documento non veniva mai eseguito»): non è un
  sintomo, è la descrizione di un meccanismo — non c'è nessuna schermata da cui accorgersene, e il
  modulo che lo contiene (`src/lib/personale/percorso-documento.ts`) è **creato da `d7af75b6`**. È un
  difetto latente di superficie d'attacco, che appartiene a un audit di sicurezza, non al racconto di
  cosa vedeva una persona.
- **n. 44** («la pratica ferma in approvazione non aveva nessuna uscita»): il pannello Pratiche
  **nasce in `65e3631c`**, cioè nel commit che gli dà l'uscita —
  `git log --all --diff-filter=A -- 'src/components/features/admin/*PratichePersonale*'
  'src/app/api/admin/pratiche-personale/route.ts'` → `65e3631c`. I tre comandi spenti su tre sono un
  difetto del lavoro pre-merge: nessuna pratica di nessuno è mai rimasta bloccata in produzione,
  perché in produzione le pratiche non c'erano ancora.
- **n. 48** («approvare una cuoca avrebbe creato un account che legge l'anagrafica dei bambini»): il
  condizionale era già un indizio, e la misura lo conferma —
  `git show a9dcc6d8:src/lib/forms/insegnanti-template.ts | grep -c cuoca` → **0**, contro **4** in
  `b43a556e`. Prima del 15/08 il modulo pubblico era per sole maestre: **non c'era nessuna cuoca da
  approvare**, quindi nessuna Segreteria poteva trovarsi davanti quel bottone. Il difetto e la
  possibilità di commetterlo sono nati e morti nello stesso rilascio.
- **n. 53 e n. 55** (nomi tagliati a metà sul registro presenze; i tre fogli di carta intestata con
  sopra due righe di conteggio): `git log --diff-filter=A --name-only -- src/lib/carta/` →
  **`0974424a` per tutti e sette i file**, cioè il motore che disegna marchio, filigrana e
  intestazione nasce nel commit che lo corregge. **Nessun foglio con la carta intestata delle tre
  sedi è mai uscito da questa app con sopra due righe di conteggio**, e nessun registro presenze è
  mai stato stampato coi nomi troncati: prima del 16/08 quei fogli non esistevano affatto. È
  l'esclusione che mi dispiace di più, perché era la riga più forte della sezione sul multi-sede —
  ed è esattamente il motivo per cui va tolta.

**La riapertura del n. 49 il 19-20 agosto: non è mai stata in produzione.** L'inventario segnala il
n. 49 come riaperto il 19/08 e richiuso il 20/08 con `aa048978`. Quel commit **non è su `main`**
(verificato). In produzione ha continuato a valere la correzione del 15 agosto (`b43a556e`, su
`main`). Contarla come qualcosa che un tester ha vissuto sarebbe falso.

**Tutta la PARTE A.1 (genitore) — no.** Le venticinque voci sull'app del genitore — «Comunica
un'assenza», il certificato firmato per il figlio sbagliato, il modulo della gita, la ricevuta
d'iscrizione mai arrivata — vivono dietro un accesso da genitore. Un account di Direzione non ha
figli collegati e non apre quelle schermate. Nessuna di quelle righe appartiene a questo documento.

**Quasi tutta la PARTE A.2 (docente) — no.** Le schermate del registro di classe, dell'appello e del
diario si aprono col ruolo docente. L'unica eccezione è il n. 28, che l'inventario attribuisce
esplicitamente anche a segreteria e Direzione, ed è citato sopra.

**Tutta la PARTE B — no, per definizione.** Cron della conservazione, email transazionali,
fatturazione elettronica, log e osservabilità, import delle iscrizioni, configurazione della shell
nativa, console degli store: sono difetti reali e corretti, ma **non producono niente sullo schermo di
un'app**. L'inventario li esclude e non li ho riportati.

**Tutta la PARTE C.2 — no.** I difetti del branch `feat/candidature-multisede` sono stati trovati e
corretti **prima** del rilascio. Non sono mai arrivati su un telefono.

**Infine, una precisazione sul perimetro reale del profilo.** In produzione, durante la finestra, gli
account che vedevano più di una sede erano l'admin del titolare e l'account di collaudo
`test.multisede.admin@kidville.test`, quest'ultimo **di solo accesso**, senza bambini né genitori
collegati. Un tester del canale chiuso che avesse ricevuto quell'account avrebbe visto il selettore e
i sette blocchi del n. 37, ma non i pannelli che dipendono dai dati di una sede popolata. Il difetto
n. 37 è comunque riproducibile da lì, perché scatta **prima** dei dati: sul caricamento dell'elenco
dei plessi.

## Verifiche eseguite

Tutte in sola lettura. Nessun `git commit`, `git add`, `git push`, `git checkout`; nessuna modifica
fuori da questo file; nessun accesso al database.

**Presenza dei commit** — `git show --stat --oneline <hash> | head -20` su:
`d7af75b6` · `a9dcc6d8` · `0e0ba538` · `0974424a` · `65e3631c` · `fcc51fc8` · `b43a556e` ·
`0e8480a3` · `f59854ab` · `aa048978` · `ddfe3b0e`. Tutti esistenti.

**Presenza in produzione** — `git branch --contains <hash> | grep -w main` su tutti gli undici:

| Commit | Data | Su `main` |
|---|---|---|
| `a9dcc6d8` | 11/08 10:16 | ✅ |
| `65e3631c` | 12/08 07:09 | ✅ |
| `d7af75b6` | 13/08 02:24 | ✅ |
| `0e8480a3` | 15/08 00:25 | ✅ |
| `b43a556e` | 15/08 02:48 | ✅ |
| `0e0ba538` | 15/08 12:12 | ✅ |
| `fcc51fc8` | 15/08 19:23 | ✅ |
| `0974424a` | 16/08 11:31 | ✅ |
| `f59854ab` | (n. 28) | ✅ |
| `ddfe3b0e` | 20/08 01:27 | ❌ **non su `main`** — solo le migrazioni sono state applicate a mano in produzione |
| `aa048978` | 20/08 02:48 | ❌ **non su `main`** — mai in produzione |

**Verifiche sul codice, per il n. 37** (lettura diretta delle due versioni, prima e dopo `d7af75b6`):
- `git show d7af75b6^:src/lib/context/sede-context.tsx` — il caricatore delle sedi senza ramo
  d'errore e senza log (`try`/`finally`, `void run()`), e la potatura del cookie eseguita anche su
  elenco vuoto;
- `git show d7af75b6^:src/components/ui/cockpit.tsx` — la guardia del selettore di sede:
  `if (sedi.length <= 1) return null`;
- `git show d7af75b6^:messages/it/shared.json` — la frase esatta, con «una sola» in grassetto nel
  catalogo dei testi: *«Hai più sedi attive. Scegline una sola dal menu in alto»*;
- `git show d7af75b6:messages/it/shared.json` — le tre stringhe nuove: *«Non è stato possibile
  leggere le tue sedi»*, il corpo, e *«Riprova»*;
- `git show d7af75b6:__tests__/components/sede-contesto-errore.test.tsx` — i tre casi (una sede / due
  sedi / errore) e il caso che chiude il colpo di coda: *«il guasto NON cancella la sede che l'utente
  aveva già scelto»*;
- `git grep -n "SedeRequired" d7af75b6^ -- 'src/**/*.tsx'` — l'elenco delle pagine sotto la guardia
  prima della correzione: impostazioni, mensa, mensa/cucina, news, pagamenti, primaria, SIDI, più
  modulistica via `SedeNotice` diretto.

**Verifica sul perimetro del profilo** — `src/lib/auth/scope.ts:59`: `if (user.role !== 'admin')
return own`, cioè il ponte multi-plesso è concesso ai soli `admin`. Confermato dal PRD
(`PRD REGISTRO ELETTRONICO.md`, righe 11068-11078), che aggiunge: *«un `segreteria` multi-sede
avrebbe le righe in `utenti_scuole` e continuerebbe a vedere una sede sola»*.

**Verifica sulla finestra del n. 34/35/36** — provata è **solo la chiusura**: `d7af75b6`, 13/08 alle
02:24, su `main`. L'apertura è del 12/08 secondo l'inventario, ma **l'ora non è provata e non la
scrivo**. Il nome del file `20260812194501_documento_fronte_retro.sql` non è una prova: dice quando
il file è stato *scritto*, non quando è stato *applicato* — `apply_migration` registra la propria
`version` con l'ora del server e la si riallinea poi a mano. Due indizi lo confermano: le tre
migrazioni vicine (`…194501`, `…194517`, `…194614`) distano 16 secondi e poi altri 57, che è la firma di file
creati in blocco e non di tre applicazioni distinte in produzione; e
`git log --diff-filter=A -- supabase/migrations/20260812194501_...` restituisce **`d7af75b6`**, cioè
il file è arrivato su `main` *insieme* alla correzione, non prima.

**Verifica su ciò che restava usabile durante il n. 37** — per ciascuna di `avvisi`, `staff`,
`protocolli`, `students`:
`git show "d7af75b6^:src/app/(dashboard)/admin/<pagina>/page.tsx" | grep -cE "useSede|sedeCorrente|SedeRequired"`
→ **0** su tutte e quattro. Nessuna guardia di sede, quindi nessun blocco.

**Verifica su ciò che ho tolto dalla tabella** — sette numeri, sette risposte:
- `git log --diff-filter=A -- src/app/api/admin/anagrafica-personale/scansione/route.ts` → `d7af75b6`
  (n. 46: la rotta nasce nel commit che la «correggeva»);
- `git grep -il "fronte" d7af75b6^ -- 'messages/**'` → **nessun risultato** (n. 46: il pulsante
  «Carica il fronte» non esisteva in nessuna lingua);
- `git log --diff-filter=A -- src/components/features/admin/settings/AnagraficaSedeSettings.tsx` →
  `0e0ba538` (n. 45: il pannello nasce nel commit che lo «correggeva»);
- `git log --diff-filter=A -- src/lib/personale/percorso-documento.ts` → `d7af75b6` (n. 58: il gate
  nasce lì, e non ha comunque nessuna schermata);
- `git log --all --diff-filter=A -- 'src/components/features/admin/*PratichePersonale*' 'src/app/api/admin/pratiche-personale/route.ts'`
  → `65e3631c` (n. 44: il pannello nasce nel commit che gli dà l'uscita);
- `git show a9dcc6d8:src/lib/forms/insegnanti-template.ts | grep -c cuoca` → **0**, e lo stesso
  comando su `b43a556e` → **4** (n. 48: prima del 15/08 nessuna cuoca poteva candidarsi);
- `git log --diff-filter=A --name-only -- src/lib/carta/` → **`0974424a`, tutti e sette i file**
  (n. 53 e n. 55: il motore della carta intestata nasce nel commit che lo corregge).

**Verifica sul n. 56** — dentro `0974424a`: lo schema di prima era
`codice_meccanografico: z.string().max(20).nullish()`, e i tre valori veri sono
`NA1A079004 · NA1E094004` (Giugliano, 23 caratteri), `CE1A178007` (Aversa, 10),
`CE1AE75008 · CE1E05400Q` (Cesa, 23). Il commit stesso annota: *«per due sedi su tre NON si
poteva»*.
