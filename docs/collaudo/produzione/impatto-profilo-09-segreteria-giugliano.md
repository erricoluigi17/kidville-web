# Profilo 09 — segreteria, Kidville Giugliano (sede singola)

> **Questo NON è un feedback ricevuto.** È la ricostruzione, provata commit per commit, dei difetti
> che un utente con questo profilo poteva incontrare nell'app fra il 6 e il 20 agosto 2026.

## Come si presentava l'app a questo profilo, giorno per giorno

Chi lavora in segreteria a Giugliano apre l'app per fare sempre le stesse cose: tenere in ordine
l'anagrafica dei bambini e dei genitori, seguire presenze e mensa, guardare pagamenti e morosità,
stampare i moduli, archiviare i documenti del personale, leggere le candidature che arrivano dal sito.
Nella finestra del test chiuso l'app le è cambiata sotto le mani parecchie volte: sulla linea
principale, fra il 6 e il 20 agosto, ci sono **18 commit**, di cui il primo è lo stato di partenza —
quindi **17 cambiamenti**. Di questi, **sette** hanno toccato una schermata che questo profilo usa
tutti i giorni: sono i sette che compaiono nella colonna «Commit» qui sotto, ai quali si aggiunge
`ddfe3b0e`, che in produzione è arrivato senza passare da `main`. L'app Android è una finestra su
`app.kidville.it`, quindi ogni rilascio è arrivato senza scaricare niente dallo store: la schermata
cambiava da sola, fra una sessione e l'altra.

**Dal 6 all'11 agosto — l'anagrafica del genitore non conservava niente.** Aprire la scheda di una
mamma, correggere un numero di telefono o un codice fiscale, premere «Salva»: la schermata non
protestava, ma il dato non entrava. Non era cominciato in agosto — andava avanti **dal 5 luglio**, cioè
da quando quelle schede esistono. Si è chiuso l'11 agosto: rilascio alle 10:16, pagina servita alle
**10:18:07**.

**11 agosto — arrivano le candidature.** Compare la scheda «Candidature» dentro Modulistica. La
segreteria le **legge**, ma i comandi per prenderle in carico sono spenti fin dal primo giorno, con
scritto accanto che decide la Direzione. (È un fatto che conta per capire cosa questo profilo non
poteva rompere: vedi l'ultima sezione.)

**12 agosto, mattina — arriva il modulo del personale.** Alle 07:09 va in produzione
`/anagrafica-personale`: il modulo che la segreteria manda per posta a chi già lavora nella
cooperativa, perché consegni i propri dati e la scansione della carta d'identità. Quel giorno il
modulo chiedeva **una faccia sola** del documento — e la carta d'identità ha la residenza e la firma
sul retro, quindi ogni volta bisognava richiamare la persona. Il pannello dove quelle schede si
leggono era **vuoto**: zero righe, mentre a Giugliano di persone da schedare ce n'erano.

**12 agosto, sera → 13 agosto, notte fonda — il guasto peggiore della finestra.** Vedi la sezione
dedicata più sotto.

**Dal 13 al 15 agosto — due giorni senza rilasci.** L'app resta ferma.

**15 agosto, notte — arrivano i prestampati, e non escono.** Alle 00:25 compaiono diciassette moduli
di carta generabili dallo sportello. Provando a stamparne uno che deve firmare il legale
rappresentante, la schermata rispondeva: *«il suo nome non è indicato nella configurazione della sede:
aggiungilo nelle impostazioni della sede e riprova»*. Nelle impostazioni **non c'era niente da
aggiungere**: quel campo non esisteva in nessuna schermata. Lo stesso valeva per il certificato del
Bonus Asilo Nido, che dipende dagli estremi dell'autorizzazione comunale. Il campo è comparso alle
12:12 dello stesso giorno — ma va anche **compilato**, e non risulta che a Giugliano sia stato fatto
entro il 20 agosto: fino ad allora il rifiuto restava, con la differenza che da mezzogiorno del 15
diceva dove andare.

**15 agosto, pomeriggio — l'anagrafica di sede rifiuta di salvarsi.** Nella nuova schermata
«Impostazioni → Sede & Intestazione» c'è la casella del codice meccanografico. Giugliano ne ha
**due**, e scritti insieme fanno 23 caratteri: il campo ne accettava 20, e il salvataggio rispondeva
un errore secco. Sistemato il 16 agosto alle 11:31.

**16 agosto, mattina — sparisce una linguetta che era finta.** Fino a quel momento in Modulistica
c'era «Template Certificati ODT»: ci si trascinava dentro la carta intestata della scuola, compariva
il segno verde «documento caricato», e **al primo aggiornamento della pagina spariva tutto**. Non
salvava da nessuna parte: mostrava soltanto il nome del file. Nello stesso rilascio se n'è andato il
pannello «Sala d'Attesa», a cui **non si arrivava da mesi** perché non era in nessun elenco.

**Dal 17 al 20 agosto — nessun rilascio che tocchi questo profilo.** L'unica cosa successa in
produzione è nella notte fra il 19 e il 20: per circa un'ora l'elenco delle candidature per plesso è
stato leggibile da chiunque, senza credenziali. Nessun segno a schermo. Chiuso all'01:27 del 20.

## I difetti che questo profilo poteva incontrare

| # inv. | Cosa si vedeva a schermo | Gravità | Rotto fino al | Commit | Verificato |
|---|---|---|---|---|---|
| 40 | La scheda di un genitore non conserva niente: si corregge un dato, si preme «Salva», e alla riapertura c'è di nuovo il valore di prima. Nessun messaggio. Andava avanti dal 5 luglio: in tutto quel tempo **nessun genitore è mai stato aggiornato da questa schermata** | bloccante | **11/08 ore 10:16** (servibile 10:18:07) | `a9dcc6d8` | `git show --stat`; su `main`; changelog nel PRD con le due misure fatte in produzione |
| 59 | Il modulo che la segreteria manda al personale chiede **una faccia sola** della carta d'identità — e sulla carta d'identità residenza e firma stanno sul retro. Il pannello delle schede del personale era vuoto: nessuna riga, mentre le persone da schedare c'erano | fastidioso | **13/08 ore 02:24** (servibile 02:27:01) | `65e3631c` → `d7af75b6` | testata della migrazione `20260812194501`: «`select count(*) from anagrafica_personale;` → 0»; entrambi i commit su `main` |
| 34 | **Nessuna scansione di documento d'identità si apriva più**, in nessuna delle tre sedi. E chi ci provava non leggeva «riprova più tardi»: leggeva *«non esiste, oppure appartiene a un'altra sede»* — cioè la frase riservata a chi tenta di aprire il documento di un'altra scuola | bloccante | **13/08 ore 02:24** (servibile 02:27:01) | `d7af75b6` | su `main`; changelog dedicato nel PRD, con l'ordine dei fatti (migrazione in produzione prima del codice) |
| 35 | Aprire il fascicolo di una persona del personale dava errore, sempre. Non una riga su cento: **tutte** | bloccante | **13/08 ore 02:24** (servibile 02:27:01) | `d7af75b6` | su `main`; il PRD nomina la proiezione che citava la colonna vecchia e produceva «503 su ogni apertura di fascicolo» |
| 36 | Il cruscotto «Scadenze documenti» diceva che la scansione **non c'era**, mentre nell'archivio c'era. Senza errore, senza avviso: solo una casella vuota. Il rischio è telefonare a una persona per un documento che aveva già consegnato | fastidioso | **13/08 ore 02:24** (servibile 02:27:01) | `d7af75b6` | su `main`; PRD: il cruscotto leggeva un campo che la risposta non conteneva più |
| 57 | La scansione di una carta d'identità poteva restare **nell'archivio senza nessuna riga che la nominasse**: invisibile alle scadenze, invisibile alla cancellazione, e non eliminabile se quella persona la chiedeva | bloccante | **13/08 ore 02:24** (servibile 02:27:01) | `65e3631c`, `d7af75b6` | letto il ramo di degrado in `git show 65e3631c:src/app/api/iscrizione/personale/route.ts` (righe 1155-1178): a colonna assente toglie il campo e riprova, e la riga nasce senza il documento |
| 58 | Il controllo che verifica la forma del percorso di un documento **non veniva mai eseguito**. Nessun sintomo a schermo: è la serratura che non scattava | bloccante (latente) | **13/08 ore 02:24** (servibile 02:27:01) | `d7af75b6` | su `main`; il PRD descrive l'ordine nuovo — prima il controllo di forma, poi la ricerca — e la prova con il contatore delle interrogazioni a zero |
| 41 | I prestampati firmati dalla Scuola **rifiutavano di uscire**: «aggiungilo nelle impostazioni della sede», e nelle impostazioni non c'era niente da aggiungere. Il nome del legale rappresentante scritto a mano nell'archivio **veniva cancellato al primo salvataggio**. La schermata dell'anagrafica di sede non compariva in nessun menu: ci si arrivava solo digitando l'indirizzo | bloccante | **15/08 ore 12:12** (servibile 12:13:13) — e il rifiuto **resta** finché i tre nomi e le tre autorizzazioni non vengono compilati sede per sede | `0e8480a3` → `0e0ba538` | entrambi su `main`; changelog dedicato, con la misura del 15/08 sulle quattro righe delle sedi: in configurazione c'era **la sola casella della posta** |
| 56 | Salvare l'anagrafica della sede rispondeva errore. Motivo: il campo del codice meccanografico ne accettava uno solo, e **Giugliano ne ha due** — scritti insieme fanno 23 caratteri contro un tetto di 20 | fastidioso | **16/08 ore 11:31** (servibile 11:33:50) | `0e0ba538` → `0974424a` | letto il campo nel pannello del 15/08 e il tetto nello schema (`max(20)` → `max(60)` in `0974424a`); entrambi su `main` |
| 22 | Il foglio che si consegna a una famiglia o si allega per un ente **non era la carta intestata della scuola**: era una banda verde disegnata dall'app, con l'intestazione ricomposta a video. Fra il 15 e il 16 agosto lo sportello era **una delle due porte** da cui quei certificati uscivano — l'altra è quella della famiglia (vedi la nota sotto la tabella) | bloccante | **16/08 ore 11:31** (servibile 11:33:50) | `0e8480a3` → `0974424a` | letto il disegno della banda in `git show 0e8480a3:src/lib/prestampati/impaginazione.ts` (righe 163-168) e la sua rimozione in `0974424a`; la carta vera (`src/lib/carta/`) **nasce** in `0974424a` |
| 42 | Nella linguetta «Template Certificati ODT» si trascinava dentro la carta intestata della scuola, compariva «documento caricato», e **al primo aggiornamento della pagina non c'era più niente**. Non veniva salvato da nessuna parte: restava solo il nome del file, a video | bloccante | **16/08 ore 11:31** (servibile 11:33:50) | `0974424a` | su `main`; il PRD lo chiama «un mockup, e in modo misurabile», e nomina la segreteria che credeva di aver consegnato la carta al prodotto |
| 43 | Il pannello «Sala d'Attesa» **non si raggiungeva**, da mesi: non stava in nessun elenco e nessun collegamento ci portava. I link vecchi atterravano su un'altra schermata | fastidioso | **16/08 ore 11:31** (servibile 11:33:50) | `0974424a` | su `main`; il PRD misura anche il residuo lasciato dietro (33 frasi rimaste senza schermo) |
| 49 | Un curriculum arrivato a **un'altra sede** poteva essere aperto e firmato dalla segreteria di Giugliano, e la riga di sorveglianza avrebbe attribuito la lettura alla candidatura sbagliata | bloccante (latente) | **15/08 ore 02:48** (servibile 02:50:57) — chiuso nello stesso rilascio che ha reso allegabile il primo curriculum | `b43a556e` | su `main`; il PRD misura, prima della modifica: **0 candidature con curriculum, 0 file archiviati**. Prima di quel rilascio non c'era niente da aprire |
| C.1 | Per circa un'ora, nella notte fra il 19 e il 20 agosto, **chiunque poteva contare quante candidature aveva ricevuto ogni plesso** senza avere un accesso; e la stessa apertura permetteva di **riscrivere lo stato di una candidatura** — cioè la colonna che questo profilo legge per sapere cosa ha già evaso. Nessun segno a schermo | bloccante | **20/08 ore 01:27** | `ddfe3b0e` | il commit **non è su `main`**, ma la chiusura è stata applicata direttamente al database di produzione e verificata; il messaggio riporta la misura fatta con la chiave pubblica e le 18 righe lette dal servizio |

> **Nota al n. 22 — le porte erano due, non una.** In una versione precedente di questo documento
> avevo scritto che fra il 15 e il 16 agosto lo sportello era l'**unica** porta da cui quei
> certificati uscivano. È falso, e l'affermazione era portante, quindi la correggo per esteso: la
> seconda porta è nata nello stesso rilascio ed è quella della famiglia. `git grep -n
> "PrestampatiGenitore" 0e8480a3 -- src/app` la trova già montata in
> `parent/modulistica/page.tsx:847`, e `src/app/api/parent/prestampati/firma/route.ts:56` importa
> `renderPrestampatoGenitore` — cioè lo stesso motore, cioè la stessa banda verde — dietro un
> controllo che verifica che chi chiede sia il genitore di quel bambino. Coerentemente,
> nell'inventario il n. 22 sta in **A.1 — GENITORE** e compare in cinque documenti di profilo
> genitore. **Resta in questa tabella** perché era davvero raggiungibile anche dalla segreteria, e
> perché il foglio che finisce in mano a una famiglia o dentro una pratica per un ente lo consegna
> questo profilo: ma è una porta su due, non l'unica.

> **Come vanno letti gli orari della colonna «Rotto fino al».** Sono timbri di commit, e la pagina
> non diventa servibile nell'istante in cui il commit entra: in mezzo c'è una compilazione. **L'ho
> misurata** — vedi l'ultima sezione — su sei rilasci di produzione: il ritardo va da **1m01s a
> 2m29s**. Gli orari «servibile» che compaiono in colonna sono quelli veri, e ogni guasto è durato
> fino a lì, non fino al timbro.

## Il giorno peggiore: 12 → 13 agosto

Il 12 agosto alle 07:09 entra in produzione tutto il modulo del personale in servizio. Da quel
momento la segreteria di Giugliano ha una schermata nuova da usare — e già nasce zoppa: il modulo
chiede una faccia sola del documento, e il pannello delle schede è vuoto (n. 59).

La sera dello stesso giorno viene applicata al database di produzione la modifica che porta il
documento **a due facce**: la casella che conteneva il percorso della scansione viene rinominata e
sdoppiata. Il codice dell'app, però, era ancora quello della mattina, e continuava a cercare la
casella con il nome vecchio. Da lì in avanti, e fino a notte fonda:

- **nessuna scansione di documento d'identità si apriva più** — non a Giugliano, non ad Aversa, non a
  Cesa (n. 34);
- **ogni** apertura di fascicolo del personale dava errore (n. 35);
- il cruscotto delle scadenze dichiarava mancante una scansione che nell'archivio c'era (n. 36);
- una scansione consegnata in quelle ore poteva restare nell'archivio senza nessuna riga che la
  nominasse — cioè invisibile a chi la deve conservare e non cancellabile su richiesta (n. 57);
- il controllo di forma sul percorso del documento non veniva eseguito (n. 58).

**La parte che va detta per intera è la frase.** Quando il tentativo di aprire una scansione falliva,
la schermata non diceva «c'è un guasto, riprova»: diceva *«non esiste, oppure appartiene a un'altra
sede»* — che è la risposta pensata per chi prova ad aprire il documento di una scuola che non è la
sua. Chi era in segreteria a Giugliano **quella sera**, aprendo il fascicolo di una propria collega,
leggeva la frase di un tentativo abusivo. Sul momento non c'era modo di distinguere le due cose. È il
motivo per cui questo è il guasto peggiore della finestra: non solo non funzionava, ma **dava la colpa
a chi lo stava usando bene**.

Il rilascio che rimette tutto in ordine è del 13 agosto alle 02:24:32, ed è diventato servibile alle
**02:27:01**.

**Sulla durata, e qui ci sono due cose da correggere invece che una.**

*La prima è aritmetica.* Da 19:45:01 a 02:24:32 non fa «circa sei ore e mezza»: fa **6h39m31s**, e
fino alla pagina davvero servita **6h42m00s**. Arrotondare a «sei ore e mezza» toglieva dieci minuti,
e li toglieva **nel verso che fa comodo** a un documento il cui scopo dichiarato è non gonfiare. Il
valore da usare è **6h40**, che è anche quello scritto dal profilo 10.

*La seconda è il fuso, ed è la più grossa.* Il numero `194501` è il timbro impresso sul nome della
migrazione, e **non ho provato in che fuso sia scritto**. Se è ora italiana, l'applicazione è delle
19:45 e il blocco è durato **6h40**. Se è UTC — e in questo repository i timbri delle migrazioni li
genera il database, non l'orologio del portatile — l'applicazione è delle **21:45 locali** e il blocco
è durato **4h40**. Entrambe le letture restano aperte, e **l'incertezza è di due ore, non di un
minuto**: la mia cautela precedente era sulla cosa sbagliata. Questo repository ha già pagato quattro
guasti nati dallo scambio fra UTC ed Europe/Rome, quindi lo scrivo come dubbio dichiarato e non come
dettaglio. Il minuto, invece, ce l'ho: la testata della migrazione dichiara che il nome del file è
stato allineato alla versione registrata dal database.

## Cosa questo profilo NON poteva incontrare, e perché lo scrivo

Il revisore verificherà anche le assenze, quindi le elenco con la ragione.

**Sono di un altro profilo, e la porta è chiusa nel codice.**

- **n. 47 e n. 48 — approvare una candidatura.** «Prendo in considerazione questa candidatura» e la
  creazione dell'accesso che ne seguiva **non sono di questo profilo**: il comando che cambia lo stato
  di una candidatura accetta solo Direzione (`src/app/api/admin/candidature-insegnanti/route.ts:503`,
  ed era già così prima della correzione — verificato su `fcc51fc8^`). Lo stesso vale a schermo: il
  pannello spegne i comandi a chi non è Direzione e ne scrive il motivo, e lo fa **fin dal giorno in
  cui è nato**, l'11 agosto (`git log -S "isDirezione"` → un solo commit, `a9dcc6d8`). Quindi la
  segreteria di Giugliano quelle candidature le vedeva, ma non poteva né approvarle né consegnare
  accessi.
- **n. 38 e n. 39 — «Elimina Alunno (GDPR)» e l'anonimizzazione.** Le tre porte che quei due pannelli
  usano sono riservate alla Direzione (`gdpr/erase/route.ts:63`, `gdpr/candidates/route.ts:23`,
  `gdpr/richieste/route.ts:32` e `:137`), e lo erano da prima della finestra (`7a00240d`). Il 409 su
  28 bambini su 33 la segreteria non poteva vederlo. ⚠️ **Una cosa la vedeva**: la voce «Privacy &
  GDPR» compare nel menu di **tutti** i ruoli di staff, perché quella riga non ha filtro
  (`admin-nav-config.ts:99`, e la regola è a `:143`). Aprendola, i due pannelli chiedevano dati che il
  suo ruolo non può ricevere e restavano vuoti. Non è un difetto dell'inventario e non lo conteggio:
  lo segnalo perché spiega perché n. 38 non è in tabella.
- **n. 37 — «Hai più sedi attive, scegline una».** Riguarda chi ha più di una sede. Questo profilo ne
  ha una sola: quella schermata non gli si presentava. È del profilo 10.
- **n. 50 — le fasce di età scritte da una spunta di un modulo pubblico.** Il comando su cui stava
  quel difetto **è nato già corretto in produzione**: il file
  `src/app/api/admin/pratiche-personale/route.ts` compare per la prima volta in `65e3631c`
  (`git log --diff-filter=A`), che è lo stesso rilascio indicato come correzione. Prima di quel
  momento la porta non esisteva. Nessun tester di nessun profilo poteva incontrarlo. Lo scrivo perché
  su questo il comando dell'anagrafica **sarebbe** stato aperto anche alla segreteria
  (`route.ts:485` ammette `admin`, `coordinator`, `segreteria`): la porta era la sua, il difetto no.
- **n. 51 — `POST /api/admin/adults`.** Nomina questo profilo per esteso, e per questo lo cito:
  l'inventario stesso la dichiara **irraggiungibile** dall'interfaccia. Un difetto a cui nessuna
  schermata porta non è un difetto che un tester incontra.

**Sono stati riparati prima di arrivare in produzione.** Qui la verifica è sempre la stessa: il file
che porta il difetto e il rilascio che lo corregge sono lo stesso commit, quindi la versione rotta non
è mai stata sull'app dei dodici tester.

- **n. 44** (la pratica ferma senza nessuna uscita) — `PratichePersonale.tsx` nasce in `65e3631c`, che
  è anche la correzione.
- **n. 45** (il pannello Sede & Intestazione che riscriveva sopra ciò che si stava digitando) — quel
  pannello nasce in `0e0ba538`; il PRD lo chiama «il difetto che il collaudo ha preso», cioè trovato
  prima del rilascio.
- **n. 46** (premendo «Carica il fronte» si leggeva la frase di un'altra schermata) — la porta di
  caricamento della scansione nasce in `d7af75b6`, che è la correzione.
- **n. 53** (il registro presenze che tagliava i nomi dei bambini a metà parola) — il motore del
  registro (`src/lib/presenze/registro-pdf.ts`) e la sua rotta **nascono in `0974424a`**, che è la
  correzione. In produzione quel registro non è mai uscito con i nomi tagliati.
- **n. 55** (i tre fogli di carta intestata spediti con sopra due righe di conteggio) — **la carta
  intestata vera nasce nello stesso rilascio che ripara i salti di pagina**:
  `git log --diff-filter=A --name-only -- src/lib/carta/` restituisce **un solo commit**, `0974424a`,
  con tutti e sette i percorsi; e `git ls-tree -r 0e8480a3 -- src/lib/carta/` è **vuoto**. Quindi
  nessun foglio con marchio, filigrana e P.IVA è mai uscito verso un fornitore, una famiglia o un ente
  portando sopra due sole righe: prima del 16 agosto quella carta non esisteva. È il difetto che mi
  era stato chiesto di raccontare dal lato di chi consegna il foglio, e la ricostruzione onesta è che
  **non è arrivato allo sportello**. Ciò che allo sportello è arrivato davvero, in quelle stesse ore,
  è il n. 22, che è in tabella.

**Non passano dalle mani di questo profilo.**

- **n. 54** (la ricevuta di firma con email, indirizzo IP e dispositivo stampati sopra) — la ricevuta
  la può scaricare **solo chi ha firmato**: la porta rifiuta chiunque altro, compresa la segreteria
  (`src/app/api/fea/receipt/route.ts`, righe 88-92). È un foglio del genitore.
- **n. 52** (il certificato per il Bonus Nido irrilasciabile alla famiglia sospesa per morosità) — non
  è un difetto vissuto: è un difetto **evitato in partenza**. Il PRD lo scrive al condizionale
  («altrimenti sarebbe diventato irrilasciabile»), e lo sportello dei prestampati nasce il 15 agosto
  già con la regola giusta. Non c'è nessuna finestra in cui una famiglia sospesa si sia vista negare
  quel certificato.
- **n. 60** (la casella di consenso la cui etichetta inglobava l'intera informativa) — sta sui moduli
  pubblici, che li compilano le famiglie e chi si candida, non la segreteria.

**Non li scrivo perché sono fuori perimetro per costruzione**: tutta la PARTE B dell'inventario
(automatismi notturni, posta elettronica, fatturazione, registrazioni tecniche, modifiche al database)
e tutta la PARTE C.2 (il lavoro del 19 e 20 agosto rimasto sul ramo `feat/candidature-multisede` e mai
rilasciato — compresa la riapertura del n. 49 del 19/08, che sull'app dei tester non è mai arrivata).

## Verifiche eseguite

Tutte in sola lettura: nessun `git` che scriva, nessuna modifica al codice, nessuna interrogazione al
database di produzione.

1. **Ogni commit citato**: `git show --stat --oneline <hash> | head -20` — eseguito su `d7af75b6`,
   `a9dcc6d8`, `0e0ba538`, `0974424a`, `65e3631c`, `fcc51fc8`, `b43a556e`, `0e8480a3`, `aa048978`,
   `ddfe3b0e`, `f59854ab`, `7ef10e87`, `b87ee964`.
2. **Ogni commit in produzione**: `git branch --contains <hash> | grep -w main` — verde per tutti,
   **tranne** `aa048978` e `ddfe3b0e`, che risultano **NON su `main`**. Coerente con l'inventario:
   sono del 19-20 agosto. Di questi due, in tabella c'è solo `ddfe3b0e`, come PARTE C.1, perché la
   chiusura del buco è stata applicata direttamente al database di produzione.
3. **Data e ora di ciascun rilascio**: `git show -s --format='%H | %ad | %s' --date=iso-local`, così le
   ore in questo documento sono quelle italiane.
4. **Quanti cambiamenti nella finestra**: `git log --first-parent main --since='2026-08-06 00:00'
   --until='2026-08-21 00:00' --oneline | wc -l` → **18**, di cui il primo è lo stato di partenza:
   **17 cambiamenti**. Sette toccano questo profilo, e sono quelli in tabella.
5. **Il ritardo fra il commit e la pagina davvero servita**, misurato e non stimato — è il punto che
   nella versione precedente avevo lasciato come incognita. Letto dai rilasci di produzione su Vercel
   (progetto `prj_R2nHb4RTOME4iKc8WZEJ3fEneTBr`), confrontando `repoPushedAt` con `ready`:

   | rilascio | commit | pagina servibile | ritardo |
   |---|---|---|---|
   | #81 `a9dcc6d8` | 11/08 10:16:07 | 11/08 10:18:07 | +2m00s |
   | #83 `d7af75b6` | 13/08 02:24:32 | 13/08 02:27:01 | +2m29s |
   | #84 `0e8480a3` | 15/08 00:25:13 | 15/08 00:27:29 | +2m16s |
   | #85 `b43a556e` | 15/08 02:48:42 | 15/08 02:50:57 | +2m15s |
   | #86 `0e0ba538` | 15/08 12:12:12 | 15/08 12:13:13 | +1m01s |
   | #88 `0974424a` | 16/08 11:31:46 | 16/08 11:33:50 | +2m04s |

   Tutti e sei con `target: production`, `readyState: READY` e `app.kidville.it` fra gli alias. **Ogni
   guasto è durato fino all'ora della colonna «servibile», non fino al timbro del commit**: da un
   minuto a due minuti e mezzo in più di quanto dicesse la versione precedente di questo documento.
6. **Chi può fare cosa**, letto nel codice e non dedotto dai nomi: `src/lib/auth/require-staff.ts:277`
   (la segreteria è ammessa per difetto ai pannelli di gestione), e poi le eccezioni una per una —
   `candidature-insegnanti/route.ts:503`, `pratiche-personale/route.ts:485`, `gdpr/erase/route.ts:63`,
   `gdpr/candidates/route.ts:23`, `gdpr/richieste/route.ts:32`, `fea/receipt/route.ts:91`.
7. **Che cosa vede nel menu**: `src/components/features/admin/admin-nav-config.ts`, righe 92-102 e 143.
8. **Quando una schermata è nata**, per distinguere un difetto vissuto da uno riparato prima del
   rilascio: `git log --oneline --diff-filter=A -- <file>` su `PratichePersonale.tsx`,
   `pratiche-personale/route.ts`, `anagrafica-personale/scansione/route.ts`,
   `src/lib/presenze/registro-pdf.ts`, `src/app/api/admin/registro-presenze/pdf/route.ts`,
   `src/app/api/prestampati/genera/route.ts`, `CandidatureInsegnanti.tsx`; e per la carta intestata
   `git log --diff-filter=A --name-only -- src/lib/carta/` (**un solo commit, sette percorsi**) più il
   controllo negativo `git ls-tree -r 0e8480a3 -- src/lib/carta/` (**vuoto**).
9. **La seconda porta dei prestampati**: `git grep -n "PrestampatiGenitore" 0e8480a3 -- src/app` →
   `parent/modulistica/page.tsx:847`; e `git grep -n "renderPrestampatoGenitore" 0e8480a3 --
   src/app/api/parent` → `parent/prestampati/firma/route.ts:56`.
10. **Il tetto sul codice meccanografico**, prima e dopo: `git show 0e0ba538:src/lib/scuole/anagrafica.ts`
    (riga 29, `max(20)`) contro il file di oggi (riga 67, `max(60)`); e il campo a schermo in
    `git show 0e0ba538:src/components/features/admin/settings/CampiAnagraficaSede.tsx`, riga 66.
11. **La banda disegnata dall'app**: `git show 0e8480a3:src/lib/prestampati/impaginazione.ts`,
    righe 163-168, contro la nota in `src/app/api/prestampati/genera/route.ts:497` che ne dichiara la
    rimozione.
12. **Il ramo che perdeva la scansione**: `git show 65e3631c:src/app/api/iscrizione/personale/route.ts`,
    righe 1155-1178.
13. **L'ora della modifica al database del 12 agosto**: testata di
    `supabase/migrations/20260812194501_documento_fronte_retro.sql`, che dichiara l'applicazione in
    produzione quel giorno e porta il timbro `194501`.

**Cosa non sono riuscito a stabilire, e lo dichiaro invece di dedurlo:**

- **In che fuso sia scritto il timbro `194501`** della migrazione del 12 agosto. Non è un dettaglio di
  minuti: è la differenza fra **6h40** e **4h40** di durata del guasto peggiore, e non ho una prova né
  in un senso né nell'altro. È la mia incertezza più grande, ed è quella che riguarda la riga più
  grave del documento.
- **Se a Giugliano i tre valori di sede siano poi stati compilati** (legale rappresentante e
  autorizzazione comunale). Il codice per inserirli c'è dal 15 agosto alle 12:12; se nessuno li
  scrive, il rifiuto dei prestampati resta identico. Non posso verificarlo perché richiederebbe una
  lettura del database di produzione, che questo lavoro non prevede. In tabella l'ho scritto come
  «resta».
- **Se in quelle ore qualcuno abbia davvero aperto un fascicolo del personale a Giugliano.** Il
  guasto è provato; l'uso no. Questo documento dice cosa un utente *poteva* incontrare, non cosa ha
  incontrato — ed è esattamente ciò che gli è stato chiesto di dire.
