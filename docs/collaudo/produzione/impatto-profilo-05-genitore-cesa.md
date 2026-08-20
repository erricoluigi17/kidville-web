# Profilo 05 — genitore, Kidville Cesa

> **Questo NON è un feedback ricevuto.** È la ricostruzione, provata commit per commit, dei difetti
> che un utente con questo profilo poteva incontrare nell'app fra il 6 e il 20 agosto 2026.

## Come si presentava l'app a questo profilo, giorno per giorno

Prima del giorno per giorno serve dire **chi è** questo profilo, perché qui la sede non è un
dettaglio anagrafico: cambia che cosa poteva esserci a schermo.

Nella tabella di abbinamento del collaudo chiuso di Google Play
(`docs/collaudo/risultati/credenziali-tester-play-2026-08-05.md`, cartella esclusa da git perché il
repository è pubblico) i tester sono **ventiquattro** e le sedi tre: **ventidue su Giugliano, uno su
Aversa, uno su Cesa**. Gli account con contenuto sono ventuno, perché gli ultimi tre tester
condividono l'account dei primi tre — tutti e sei di Giugliano: diciannove account distinti di
Giugliano per ventidue persone, uno per Aversa, uno per Cesa (`credenziali-tester-play-2026-08-05.md:36`
e righe 41-64). Il profilo 05 è quell'uno di Cesa. L'account abbinato è
`test.cesa.genitore@kidville.test`, creato da `scripts/seed-test-sedi.mjs`, e porta con sé **un solo
bambino**, nella sezione «TEST Infanzia» di Cesa, **fascia 0-6 e non primaria**.

Da qui discendono due fatti che decidono metà di questo documento, e nessuno dei due è un'opinione:

- **A Cesa non c'era nessuna famiglia vera.** Il PRD lo mette fra le smentite verificate:
  *«non ci sono famiglie reali su Aversa e Cesa (3 alunni su 3 sono seed)»*
  (`PRD REGISTRO ELETTRONICO.md:1517`). È anche il motivo per cui
  `scripts/crea-account-tester.mjs:43` fissa `const SEDE = 'Kidville Cesa'` e si **ferma da solo** se
  sulla sede compare un alunno non marcato TEST: un account consegnato a un tester dello store non
  deve poter vedere l'anagrafica di un bambino vero.
- **A Cesa non c'era personale.** *«Aversa e Cesa non hanno personale: nessun docente, nessuna
  segreteria»* (`PRD REGISTRO ELETTRONICO.md:8800`). Diario, appello, avvisi, gite, mensa: a Cesa
  nessuno li scriveva. **L'app di questo profilo era, per costruzione, quasi vuota** — ed è la
  ragione per cui alcuni difetti gravi qui non potevano fare danno, mentre altri si vedevano meglio
  che altrove.

Terzo fatto, che riguarda tutti i profili ma va ripetuto perché fissa le date: l'app Android è una
**WebView su `https://app.kidville.it`** (inventario, fatto n. 1). Ogni correzione arrivava a questo
tester **senza scaricare un nuovo bundle dallo store**. Le date qui sotto sono quindi date di
**deploy in produzione**, cioè di commit su `main`, ed è la convenzione usata anche nella colonna
«Rotto fino al» della tabella.

**6-7 agosto — l'app rispondeva 500 a mani nude.** Otto rotte restituivano *500 con corpo vuoto* a
**ogni genitore non sospeso**, quindi anche a questo: scrivere alla maestra (`chat/messages`),
mandare un modulo (`forms/submit`), chiedere il codice OTP (`forms/send-otp`, `parent/forms/otp`),
rispondere a un avviso (`avvisi/[id]/risposte`), comunicare o annullare un'assenza. Non era un bug
del sorgente: Turbopack compilava il ramo `: null` di un ternario nella stringa
`"TURBOPACK unreachable"`, e per chi non era sospeso la funzione restituiva una stringa al posto di
`null` (`f59854ab`, messaggio righe 484-501). Nello stesso periodo «Comunica un'assenza» era un
vicolo cieco: la dashboard mostrava il pulsante **proprio ai non-primaria**, e la rotta rispondeva
403 «Disponibile solo per la scuola primaria». Il bambino di questo profilo è di infanzia: **il
pulsante c'era, e l'errore era garantito**.

**8 agosto 22:54 (`f59854ab`) e 9 agosto 00:38 (`7ef10e87`) — il grosso della riparazione.** Fino a
lì la schermata dell'assenza era anche fisicamente inutilizzabile su un telefono: il pulsante
d'invio coperto al 100% dalla barra di navigazione, «Leggi l'informativa» che faceva partire l'invio,
il messaggio di rifiuto che nasceva dietro il piede appiccicato, e — dopo la prima correzione — il
campo «Motivo» finito sotto il piede su schermi da 640-731 px.

**Dal 9 al 14 agosto — l'app non cambia per un genitore.** I sei deploy di quei giorni
(`706e4bd3`, `c2a78c50`, `69d45a3e`, `84ebdd4f`, `a9dcc6d8`, `65e3631c`, `d7af75b6`) toccano
fatturazione, bundle Android, anagrafica del personale e moduli pubblici. L'unico che questo profilo
poteva vedere è `a9dcc6d8` (11/08 10:16), e solo **fuori** dall'area riservata: il contorno fra una
sede e l'altra sulla schermata dove si sceglie il plesso. In tutta questa settimana resta però
attivo il difetto più silenzioso: un pezzo di bundle mancante lasciava l'utente su «Caricamento…»
**per sempre**, senza messaggio e senza pulsante.

**15 agosto — l'app raddoppia, e i certificati escono sbagliati.** Alle 00:25 (`0e8480a3`) arrivano
diciassette moduli di carta dentro l'app e il tab «Certificati» del genitore; alle 02:48
(`b43a556e`) parte finalmente la ricevuta d'iscrizione, che fino a quel momento non era mai partita
a nessuno.

**Ma la carta sbagliata non è arrivata il 15 agosto: c'era dal primo giorno del test.**
`git grep -c "KIDVILLE SCHOOLS" 29da34b4 -- 'src/app/(dashboard)/parent/modulistica/page.tsx'` → **2**,
e `29da34b4` è del 6 agosto. La banda verde inventata, la dicitura «KIDVILLE SCHOOLS», l'indirizzo
stampato due volte e la firma di un «Dirigente Scolastico» che in una cooperativa non esiste sono
state lì per **tutta la finestra**, dal 6 agosto alle 11:31 del 16. Il 15 agosto ha aggiunto altre
strade per arrivarci, non il difetto.

Alle 12:12 di quel giorno (`0e0ba538`) compare in Impostazioni il campo «codice meccanografico», con
un tetto di 20 caratteri: per le ventitré ore successive **la sede di Cesa non poteva scrivere la
propria identità nemmeno provandoci**, e la testata del certificato ha continuato a uscire senza il
codice del plesso.

**16 agosto 11:31 (`0974424a`) — la carta vera.** Entra la carta intestata reale, il tetto passa a 60
caratteri e viene scritta l'anagrafica delle tre sedi. Da qui in avanti un certificato di Cesa dice «Kidville Cesa»,
«Via Filippo Turati 2 — 81030 Cesa (CE)» e «Cod. Mecc. CE1AE75008 · CE1E05400Q».

**17-20 agosto — l'app non cambia più.** L'ultimo commit arrivato in produzione è `b87ee964`
(17/08 01:35): `git log main --since=2026-08-14` non mostra nient'altro fino al 20. L'unica cosa
successa dopo, e successa **davvero** in produzione, è la falla della notte del 20 — che però a
schermo non si vedeva, e per questo sta in prosa e non in tabella.

## I difetti che questo profilo poteva incontrare

«Rotto fino al» = data e ora del commit **su `main`**. Sono **timbri di commit, non l'istante in cui
il deploy è diventato servibile**: fra il merge e la pagina che un tester apre c'è una build, quindi
ogni guasto è durato un po' **più** di quanto si legge qui, mai meno. Dove l'inventario indica una
data interna alla PR, la riporto nel testo.

In tabella stanno solo i sintomi **visibili a schermo** a questo profilo. La falla della notte del
20 agosto è vera e sta in produzione, ma a schermo non si vedeva niente: sta in prosa, non qui.

| # inv. | Cosa si vedeva a schermo | Gravità | Rotto fino al | Commit | Verificato |
|---|---|---|---|---|---|
| 1 | Scrivo alla maestra, mando un modulo, chiedo il codice via email, rispondo a un avviso: **premo e non succede niente**. Otto rotte rispondevano 500 con corpo vuoto a tutti i genitori non sospesi | bloccante | 08/08 22:54 | `f59854ab` | `git branch --contains f59854ab` → `main`; msg righe 484-501 (elenco delle otto rotte) |
| 2 | «Comunica un'assenza»: **il pulsante c'era e l'errore era garantito**. La dashboard lo mostrava ai non-primaria, la rotta rispondeva 403 «Disponibile solo per la scuola primaria». Il bambino di questo account è di infanzia | bloccante | 08/08 22:54 (fix interno 07/08) | `f59854ab` | diff: `- return NextResponse.json({ error: 'Disponibile solo per la scuola primaria' }, { status: 403 })`; test aggiunto «NIDO: 201 (era 403 …)» |
| 3 | Tocco «Comunica assenza» e **mi ritrovo sul Diario**: il pulsante d'invio era coperto al 100% dalla barra di navigazione | bloccante | 08/08 22:54 | `f59854ab` | inventario A.1 n.3 (`page.mouse.click(112, 823)` → `/parent/diary`); commit su `main` |
| 5 | Tocco il campo «Motivo» dove lo vedo e **finisco sul pulsante che invia**: su schermi 640-731 px il campo finiva sotto il piede | bloccante | 09/08 00:38 | `7ef10e87` | `git show --stat 7ef10e87` (include `e2e/parent-attendance-tocco.spec.ts`); su `main` |
| 14 | Mentre aspetto, **il pulsante primario è illeggibile**: contrasto 1,20:1 | fastidioso | 08/08 22:54 | `f59854ab` | inventario A.1 n.14 (→ 5,75:1); commit su `main` |
| 15 | Con l'**Alto Contrasto** acceso i due campi erano **bianchi su bianco**; più due frasi a 2,51:1 e il formato `gg/mm/aaaa` che spariva digitando | bloccante (HC) | 08/08 22:54 | `f59854ab` | inventario A.1 n.15; commit su `main`. Vale se il tester aveva acceso l'Alto Contrasto |
| 16 | Col telefono **in inglese** compariva «Value must be … or later» dentro un'app italiana, in una bolla di sistema | fastidioso | 08/08 22:54 | `f59854ab` | inventario A.1 n.16 (la seconda metà, il calendario, è iOS: esclusa) |
| 18 | **La stessa data in due formati nella stessa schermata**, e senza anno nell'elenco storico | bloccante | 08/08 22:54 | `f59854ab` | inventario A.1 n.18. La caduta della schermata richiede una data malformata nel database: non dimostrabile per questo account |
| 20 | **«Caricamento…» per sempre**, senza messaggio e senza pulsante, quando manca un pezzo di bundle. `ChunkErrorBoundary` esisteva dal 03/08 con 11 test verdi e non era importato da nessun file | bloccante | 15/08 00:25 | `0e8480a3` | `git show --stat 0e8480a3 -- src/components/providers/RootProviders.tsx` → 15 righe aggiunte; oggi `RootProviders.tsx:45`; PRD:1472-1480 |
| 22 | Il certificato scaricato portava **una banda verde inventata, «KIDVILLE SCHOOLS», l'indirizzo stampato due volte e la firma di un «Dirigente Scolastico»** che in una cooperativa non esiste | bloccante | 16/08 11:31 | `0974424a` | `git branch --contains 0974424a` → `main`; msg righe 1-8 |
| 23 | Il certificato protocollato usciva di **due pagine**, la seconda con la sola firma e tredici centimetri di vuoto; numero di protocollo stampato due volte | fastidioso | 16/08 11:31 | `0974424a` | inventario A.1 n.23; commit su `main` |
| 24 | **Il modulo di autorizzazione alla gita non compariva mai**, e la notifica apriva `/parent` invece del modulo | bloccante | 16/08 11:31 | `0974424a` | msg riga 316 «Le gite smettono di essere due sistemi: il modulo compare quando la gita esiste»; riga 1850 sui due orari vuoti. **A Cesa nessuno organizzava gite**: il sintomo era invisibile qui |
| 26 | Ho compilato il modulo d'iscrizione, ho firmato col codice, **e non è arrivato niente**: nessuna conferma, nessun riepilogo | bloccante | 15/08 02:48 | `b43a556e` | `src/lib/email/messaggi/ricevuta-iscrizione.ts:16-18`: «387 domande registrate, 381 con un indirizzo email valorizzato»; aggancio in `src/app/api/iscrizione/route.ts:25` introdotto da questo commit |
| 56 | **Il certificato di mio figlio non dice da quale delle tre Kidville viene**, e per Cesa non poteva dirlo nemmeno provandoci: il campo «codice meccanografico» c'era in Impostazioni, ma accettava 20 caratteri — su misura per UN codice — e Cesa ne ha **due**, `CE1AE75008 · CE1E05400Q`, 23 caratteri. Salvare rispondeva `400` | fastidioso lato Segreteria, **visibile in testata** al genitore | 16/08 11:31 (~23 ore in produzione, dalle 12:12 del 15/08) | `0e0ba538` → `0974424a` | `git branch --contains 0e0ba538` → `main`; `git show 0e0ba538:src/lib/scuole/anagrafica.ts` → `z.string().max(20)`; `git show 0e0ba538:…/CampiAnagraficaSede.tsx:66` → il campo c'è; `git show 0974424a:…/anagrafica.ts` → `max(60)`. Il sintomo a schermo — testata senza «Cod. Mecc.» — sta in `src/lib/certificati/self-service.ts:57`, che omette la riga in silenzio |
| 66 | Sulla schermata dove si sceglie **Giugliano, Aversa o Cesa**, il contorno fra una sede e l'altra era a **1,10:1**, cioè non esisteva, e il riempimento bianco su crema aggiunge 1,11:1 | fastidioso | 11/08 10:16 | `a9dcc6d8` | `git show a9dcc6d8^:src/components/features/public/EnrollmentWizard.tsx` riga 654 → `border-kidville-line`; oggi riga 725 → `border-kidville-neutral`, con il commento che misura 1,10:1 → 5,82:1 e nomina «la schermata su cui 375 famiglie hanno scelto il plesso del proprio figlio» |

## Quello che era specifico di questa sede — e quello che non lo era

**Va detto subito, perché è la cosa più onesta di questo documento: tredici delle quindici righe qui
sopra sono le stesse del profilo 01, il genitore di Giugliano.** Le otto rotte a 500, il pulsante
dell'assenza che non funzionava, l'Alto Contrasto, il «Caricamento…» eterno, il certificato con la
carta inventata: nessuna di queste cose guarda la sede. Sono difetti dell'applicazione, e li prendeva
chiunque avesse un account genitore. **Le righe che esistono perché le sedi sono tre sono due: il
n. 66 e il n. 56.**

**1. La schermata dove si sceglie il plesso (n. 66).** È il punto in cui il carattere multi-sede del
prodotto tocca il genitore **prima** che abbia un account. Le card di Giugliano, Aversa e Cesa erano
separate da un bordo `--color-kidville-line` (#EFE7DC) su fondo crema: **1,10:1**, cioè nulla — e con
il riempimento bianco che su crema aggiunge 1,11:1, quel contorno era l'unico indizio di dove finisse
una sede e cominciasse l'altra. Il commento lasciato nel codice dice perché conta: *«questa è la
schermata su cui 375 famiglie hanno scelto il plesso del proprio figlio»*
(`EnrollmentWizard.tsx:715-724`). Per chi cerca Cesa e non Giugliano, un separatore invisibile fra
due card non è cosmesi.

**2. Il campo troppo corto per un plesso doppio (n. 56).** Per il MIM nido/infanzia e primaria sono
**due plessi distinti**, e sia Giugliano sia Cesa ne hanno due a testa. Aversa, con un codice solo
(`CE1A178007`, 10 caratteri), nel campo da 20 ci sarebbe entrata. Cesa no: `CE1AE75008 · CE1E05400Q`
fa 23. Per le circa ventitré ore in cui il campo è stato in produzione col tetto vecchio, **due sedi
su tre non potevano scrivere la propria identità**, e il certificato del genitore continuava a uscire
senza la riga «Cod. Mecc.» — che `buildIntestazioneSede()`
(`src/lib/certificati/self-service.ts:45-58`) omette **in silenzio** quando il campo è vuoto, e lo fa
dal 10/07. Un documento che va a un ente esce senza dire da quale plesso viene, e niente, da nessuna
parte, lo segnala.

### Come questo n. 56 è stato prima gonfiato, poi cancellato per sbaglio, e infine misurato

Questa riga è passata per **due misure sbagliate in senso opposto**, e siccome la seconda l'ha fatta
sparire dal documento vale la pena lasciarne traccia qui.

**La mia, in eccesso.** Nella prima stesura avevo scritto che il `400` colpiva Cesa e non Aversa, e
che perciò il 15 agosto il certificato di Cesa usciva monco mentre quello di Aversa no. Falso:
l'anagrafica di sede non era ancora stata scritta per **nessuna** delle tre (spec del 15/08 — compilati
solo `email`, `legale_rappresentante` e la `denominazione` di Aversa), quindi a schermo la testata
usciva monca in tutte e tre. Il tetto decideva **chi poteva ripararla**, non chi la vedeva rotta.

**La seconda, in difetto, ed è quella che aveva cancellato la riga.** `git branch --contains 3721f884`
— il commit che porta `max(20)` a `max(60)` — non restituisce niente, perché la squash l'ha
riassorbito. Da lì la conclusione: «nato e morto dentro la PR #88, in produzione non è mai esistito».
**È la regola dello squash applicata al contrario.** Quella regola serve a non attribuire alla
produzione un commit che non ci è arrivato; usata per dedurre che *lo stato rotto* non è mai stato
servito, taglia via difetti veri. Che il commit di riparazione non stia su un ramo dice quando il
difetto è stato chiuso **sul ramo**, non che nessuno l'abbia subito.

**La misura che regge**, ed è sui due estremi dello stato rotto, non sul commit che lo chiude:

```
git branch --contains 0e0ba538 | grep -w main                              → main
git show 0e0ba538:src/lib/scuole/anagrafica.ts | grep codice_meccanografico → z.string().max(20)
git show 0e0ba538:…/CampiAnagraficaSede.tsx    | grep meccanografico        → il campo c'è, riga 66
git show 0974424a:src/lib/scuole/anagrafica.ts | grep codice_meccanografico → z.string().max(60)
```

Il campo nell'interfaccia e il tetto da 20 caratteri sono stati **insieme su `main`** dalle 12:12 del
15/08 alle 11:31 del 16/08: **circa ventitré ore servite in produzione**. La lezione, per i prossimi
documenti: la regola dello squash accorcia gli elenchi, e va bene; applicata al contrario li accorcia
**troppo**. La domanda giusta non è «dov'è il commit che ripara», è «quando lo stato rotto era su
`main`».

**Resta vera, e non dipende da nessuna delle due misure**, la correzione alla finestra
dell'inventario: il tetto di 20 caratteri **non è nato il 15 agosto**, c'era dal **10 luglio**
(`125c5de9:src/lib/scuole/anagrafica.ts:8`, su `main`). Il 15 agosto è il giorno in cui è arrivato il
campo che permetteva di andarci a sbattere.

**3. L'indirizzo sporco, che a Cesa aveva la sua forma (sfumatura dentro il n. 22).** Fino al
16 agosto `scuole.indirizzo` conteneva la riga già scritta per esteso, e per Cesa il valore era
letteralmente «Via Filippo Turati 2, 81030 Cesa (CE)» — documentato in
`src/lib/scuole/anagrafica.ts:130-131` e in `__tests__/lib/certificati-self-service.test.ts:193-194`.
Siccome `componiIndirizzoSede()` **aggiunge** CAP, città e provincia a ciò che trova, il certificato
stampava CAP e città due volte. Sul certificato vero misurato quel giorno (Giugliano) la riga uscì
«Via Prima Traversa Antica Giardini 5, 80014 Giugliano in Campania (NA) — Giugliano». A Cesa il
meccanismo è identico e il dato di partenza è identico nella forma: **stesso difetto, altra via**.

### Il difetto della notte del 20: reale, per plesso, e invisibile

L'unica cosa del 19-20 agosto arrivata in produzione è la tabella `candidature_sedi`, creata **senza
riga di sicurezza attiva** e quindi leggibile da chiunque con la chiave pubblica che sta nel
JavaScript del sito. È il difetto più multi-sede di tutto l'inventario: ciò che si poteva leggere era
**quante candidature ha ricevuto ogni plesso**, Cesa compresa — un dato che esiste solo perché le
sedi sono tre, e che in un'installazione a sede unica non ci sarebbe. **Non lo metto in tabella
perché a schermo non si vedeva niente**: nessun genitore, a Cesa o altrove, poteva accorgersene
aprendo l'app. Va detto lo stesso, perché è vero. Chiuso da `ddfe3b0e`, che **non è su `main`** — le
migrazioni erano state applicate direttamente al database di produzione, ed è esattamente per questo
che il buco è esistito davvero. Il messaggio del commit misura l'apertura e la chiusura fra le ~00:50
e le ~01:27 del 20 agosto; anche qui sono timbri, non l'istante esatto in cui la porta si è chiusa
per chi stava leggendo.

### E una specificità in negativo, che vale quanto le altre

A Cesa **non c'erano né famiglie vere né personale**: nessuna maestra faceva l'appello, nessuno
organizzava gite, nessuno scriveva nel diario. Anche là dove un difetto era raggiungibile in teoria,
qui mancava chi lo innescasse dall'altra parte. È una ragione **in più** rispetto a quelle misurate
nella sezione successiva, non un sostituto: dove ho potuto misurare, ho misurato.

## Cosa questo profilo NON poteva incontrare, e perché lo scrivo

Un elenco che comprende tutto non dimostra niente. Queste voci dell'inventario le ho verificate e
**scartate**, una per una, con la ragione:

- **n. 13 — `/parent/primaria/assenze` bloccata su «Caricamento…».** Riguarda la primaria. Il bambino
  di `test.cesa.genitore` è nella sezione «TEST Infanzia» (`scripts/seed-test-sedi.mjs:54`, sezione
  omonima in ogni sede). Nessuna schermata di primaria era raggiungibile da questo account.
- **n. 19 — «un figlio per grado vedeva due prodotti diversi».** Richiede due figli in due gradi.
  Qui i figli sono **uno**: `assicuraLegamiGenitore` crea un solo alunno per account.
- **n. 21 — «con due figli, il genitore firmava il certificato per il bambino sbagliato»
  (`children[0]`).** Stesso motivo: con un figlio solo, `children[0]` **è** il figlio giusto. Il
  difetto era reale e bloccante, ma non poteva colpire questo profilo.
- **n. 17 — il calendario che si apriva da solo — e la seconda metà del n. 16 e del n. 8.** Sono
  misurati su iOS (`_UICalendarDateViewCell`, la fascia della Dynamic Island). Il collaudo chiuso di
  cui parliamo è **Google Play**: l'app di questo profilo era la WebView Android.
- **n. 25 — «Scarica il certificato» che riemetteva bruciando un numero WORM, e l'anno scolastico
  sbagliato.** Scatta solo fra le 00:00 e le 02:00 del **1° agosto**, quando la data UTC e quella di
  Europe/Rome cadono ai due lati del confine di mese: `annoScolasticoCorrente()` fa
  `m >= 8 ? y/y+1 : y-1/y` (`src/lib/anno-scolastico.ts:25-27`). Fra il 6 e il 20 agosto UTC e Roma
  dicono entrambi «agosto». **Fuori finestra.**
- **n. 61 — il codice fiscale di un minore mandato a `api.codicefiscale.it`.** L'inventario lo mette
  fra i difetti «PUBBLICO», ma `git grep fiscalCodeApi a9dcc6d8^ -- src` restituisce **solo**
  `ScrollableAdultForm.tsx`, `ScrollableStudentForm.tsx` e `StudentRegistryForm.tsx`: sono i moduli
  della **Segreteria**. Il modulo pubblico d'iscrizione non chiamava quel servizio. Un genitore non
  poteva innescarlo: poteva soltanto **subirlo**, se era la Segreteria a digitare i dati di suo
  figlio. Non lo conto come difetto incontrato.
- **n. 62-65, 67-71 — riepilogo che non riepiloga, bordi degli errori, curriculum, `<main>` mancante.**
  Sono `/lavora-con-noi`, il modulo per candidarsi a lavorare nella scuola. Un genitore non ci passa.
- **n. 4, 6, 7, 9, 10, 11 — i difetti della schermata dell'assenza.** Li avevo messi in tabella, e li
  tolgo: la schermata su cui vivono **non esisteva** all'inizio del test chiuso. A `29da34b4` (6/08
  17:52, l'ultimo commit prima di `f59854ab`) `git grep -l "ComunicaAssenzaCard" 29da34b4 -- src` non
  trova niente, e `grep -c "export const DELETE"` sulla rotta dà **0** — quindi né l'informativa che
  faceva partire l'invio, né il messaggio dietro il piede, né lo scorrimento a vuoto, né la
  sovrascrittura dell'appello, né l'annullamento che cancellava una presenza passata potevano essere
  incontrati da chi ha aperto l'app fra il 6 e l'8 agosto. Restano il n. 2 (il pulsante c'era e la
  rotta rispondeva 403), il n. 3 e il n. 5, che vivono **dopo** l'arrivo della card. I profili 01, 02
  e 03 escludono gli stessi sei, e hanno ragione.
- **n. 27-33 (docente) e n. 34-55, 57-60 (segreteria e direzione).** Fuori ruolo. Il n. 56 è l'unica
  eccezione, ed è in tabella: il suo effetto **esce** dal pannello della Segreteria e finisce stampato
  in testata sul foglio che il genitore scarica.
- **La falla della notte del 20 agosto (PARTE C.1).** Reale in produzione, e la più multi-sede
  dell'inventario — ma non **incontrabile**: a schermo, aprendo l'app, non se ne vedeva niente. Sta in
  prosa, non in tabella.
- **Tutta la PARTE B e la PARTE C.2.** La prima è reale ma invisibile dentro l'app (cron, log,
  fatturazione, bundle); la seconda è lavoro di branch mai arrivato in produzione. Citarle come
  vissute sarebbe falso.

Una nota di misura sul n. 24 e sul n. 26, per non farli pesare più di quanto pesino: il modulo della
gita a Cesa non poteva comparire perché **a Cesa nessuno organizzava gite**, e la ricevuta
d'iscrizione riguarda chi compila il modulo pubblico, non chi ha già un account nell'app. Restano in
tabella perché il sintomo — «non è arrivato niente» — è esattamente ciò che un genitore di Cesa
avrebbe vissuto se avesse iscritto un figlio in quelle settimane, e 8 delle 11 domande arrivate con
una casella condivisa erano proprio di Cesa (`PRD REGISTRO ELETTRONICO.md:381`).

## Verifiche eseguite

Tutte in sola lettura: nessun `git commit`, `git add`, `git push`, `git checkout`, nessuna scrittura
sul database, nessun file toccato all'infuori di questo.

1. **Presenza in produzione di ogni commit citato** — `git branch --contains <hash> | grep -w main`
   per `f59854ab`, `7ef10e87`, `0e8480a3`, `0974424a`, `b43a556e`, `a9dcc6d8`, `0e0ba538`,
   `125c5de9`: tutti su `main`. Per `ddfe3b0e` il comando dà solo `feat/candidature-multisede`, per
   `3721f884` non dà niente: entrambi sono dichiarati come tali nel documento, e nessuno dei due sta
   in tabella.
2. **Contenuto e data di ogni commit** — `git show --stat --oneline <hash> | head -20` e
   `git show -s --format='%ad %s' --date=format:'%Y-%m-%d %H:%M' <hash>`.
3. **Aritmetica dei tester** — `sed -n '36,38p' docs/collaudo/risultati/credenziali-tester-play-2026-08-05.md`
   → «24 tester · 21 account con contenuto», e le righe 62-64 mostrano che i n. 22-24 condividono
   l'account dei n. 1-3, tutti di Giugliano: 22 tester su Giugliano, 19 account distinti.
4. **Confine della finestra** — `git log main --since=2026-08-06 --until=2026-08-15` e
   `git log main --since=2026-08-14`: l'ultimo commit in produzione è `b87ee964` (17/08 01:35),
   nulla fra il 17 e il 20.
5. **Il difetto n. 56, e perché è FUORI tabella** — `git show 3721f884 -- src/lib/scuole/anagrafica.ts`
   → `max(20)` sostituito da `max(60)`; `git show -s --format=%ad 3721f884` → **16/08 01:35**;
   `git branch --contains 3721f884` → **vuoto**: il commit non è su nessun branch, vive solo nella
   storia schiacciata dalla squash `0974424a`. Il `400` è quindi interno alla lavorazione della PR #88.
   `git show 125c5de9:src/lib/scuole/anagrafica.ts` → il tetto di 20 esisteva **dal 10/07**, non dal
   15/08 (correzione alla finestra dell'inventario). Stato dell'anagrafica misurato il 15/08 —
   compilati solo `email`, `legale_rappresentante` e la `denominazione` di Aversa — da
   `docs/superpowers/specs/2026-08-15-carta-intestata-e-modulistica-design.md:180-183`: nessuna delle
   tre sedi aveva il codice meccanografico, quindi il certificato usciva monco in tutte e tre.
6. **Il meccanismo che resta vero** — lettura di `src/lib/certificati/self-service.ts:45-58`
   (`buildIntestazioneSede`, riga «Cod. Mecc.» omessa **in silenzio** se il campo è vuoto),
   `src/lib/scuole/anagrafica.ts` (`componiIndirizzoSede`, e il valore sporco di Cesa documentato
   alle righe 130-131), `__tests__/lib/certificati-self-service.test.ts:50-62` (testata attesa delle
   tre sedi vere, Cesa compresa).
7. **Il gate primaria/infanzia** — nel diff di `f59854ab`: rimozione di
   `'Disponibile solo per la scuola primaria'` e test nuovo «NIDO: 201 (era 403 …)».
8. **La schermata di scelta del plesso** — `git show a9dcc6d8^:src/components/features/public/EnrollmentWizard.tsx`
   riga 654 (`border-kidville-line`) contro la riga 725 di oggi (`border-kidville-neutral`), più il
   blocco di `src/app/globals.css:866-925` che misura 2,79:1 → 5,82:1 sulla superficie.
9. **Chi è questo profilo** — `docs/collaudo/risultati/credenziali-tester-play-2026-08-05.md`
   (riga 61: un solo tester su Cesa), `scripts/seed-test-sedi.mjs` (un genitore, un bambino, sezione
   «TEST Infanzia»), `scripts/crea-account-tester.mjs:43-44` (`SEDE = 'Kidville Cesa'` con la guardia
   a runtime sugli alunni reali), `PRD REGISTRO ELETTRONICO.md:1517` e `:8800`.
10. **L'esclusione del n. 25** — lettura di `src/lib/anno-scolastico.ts:25-27`.
11. **L'esclusione del n. 61** — `git grep -n "fiscalCodeApi" a9dcc6d8^ -- src`: tre soli chiamanti,
    tutti in `src/components/features/admin/`.

**Nessun dato personale in questo documento**: nessun indirizzo email di tester, nessun nome di
bambino, nessuna password. I codici meccanografici, gli indirizzi delle sedi e la ragione sociale
sono dati istituzionali della cooperativa, già presenti nel repository pubblico.
