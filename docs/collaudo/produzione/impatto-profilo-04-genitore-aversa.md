# Profilo 04 — genitore, Kidville Aversa

> **Questo NON è un feedback ricevuto.** È la ricostruzione, provata commit per commit, dei difetti
> che un utente con questo profilo poteva incontrare nell'app fra il 6 e il 20 agosto 2026.

## Come si presentava l'app a questo profilo, giorno per giorno

Il profilo è un genitore il cui bambino è iscritto a **Kidville Aversa**, uno dei tre plessi aperti
il 29 luglio 2026. Due fatti misurati delimitano ciò che questa persona poteva vedere, e vanno detti
prima di tutto il resto perché cambiano la lettura di ogni riga che segue.

**Il primo: ad Aversa non c'è la primaria.** Delle 33 sezioni create il 29/07 dall'ordine bracciali
2026/2027, Aversa ne ha **cinque, tutte 0-6** — «Aversa non ha primaria attiva quest'anno» è una
normalizzazione confermata dal titolare e messa a verbale nel PRD. Un genitore di Aversa è quindi
sempre e solo un genitore 0-6: metà dei difetti dell'inventario che riguardano `/parent/primaria/*`
non poteva raggiungerlo, e uno di quelli che riguardano la dashboard 0-6 lo raggiungeva **sempre**.

**Il secondo: ad Aversa, in produzione, non ci sono famiglie reali.** La verifica del 17/08 messa a
PRD lo dice senza giri di parole — «non ci sono famiglie reali su Aversa e Cesa (3 alunni su 3 sono
seed)». Questo profilo corrisponde quindi a un account di collaudo su una sede vera, con un bambino
vero nel database e una sezione vera: tutto ciò che segue è ciò che quell'account incontrava
davvero aprendo l'app, non una supposizione su una famiglia che non esiste.

L'app Android è una WebView su `https://app.kidville.it`, quindi ogni correzione rilasciata sul web
è arrivata al telefono senza aggiornare l'app dallo store. La cronologia, per questo profilo:

- **6 – 8 agosto.** La parte peggiore della finestra. Otto azioni della dashboard — comunicare
  un'assenza, ritirarla, giustificarla, **scrivere alla maestra**, inviare un modulo, chiedere il
  codice di verifica, rispondere a un avviso — rispondevano **500 con il corpo vuoto** a tutti i
  genitori non sospesi. A schermo: si preme, non succede niente, oppure compare un errore che non
  dice niente. E «Comunica un'assenza», il pulsante che la dashboard 0-6 mostrava, era una porta
  murata: il server rispondeva *«Disponibile solo per la scuola primaria»*. Ad Aversa, dove la
  primaria non esiste, **tutti** vedevano quel pulsante e **tutti** prendevano l'errore.
- **8 agosto, dalle 22:54, alla mezzanotte e mezza del 9.** `f59854ab` chiude in un colpo solo le
  otto rotte mute e il pulsante d'invio coperto dalla barra di navigazione (n. 3), e porta in
  produzione il modulo rifatto. Da quel momento resta **un difetto solo**: il campo «Motivo»,
  che su schermi da 640 a 731 px cadeva sotto il piede della schermata, così che toccandolo si
  premeva Invia. Chiuso da `7ef10e87` alle 00:38 del 9 agosto — **1 ora e 44 minuti** dopo.
- **11 agosto.** Sul modulo pubblico d'iscrizione, la schermata in cui si sceglie il plesso smette
  di avere card senza contorno visibile.
- **15 agosto.** Compaiono in app diciassette moduli di carta, otto dei quali per la famiglia. Nella
  stessa giornata due certificati della famiglia si rifiutano di uscire perché manca un dato di
  sede, e nel primo pomeriggio quel campo viene creato.
- **16 agosto.** Il certificato smette di uscire con una testata inventata e con l'indirizzo di
  Aversa stampato due volte.
- **17 – 20 agosto.** Per questo profilo, nessuna novità: il lavoro del 19-20 agosto non è mai
  arrivato in produzione, con l'unica eccezione descritta in fondo — che però non si vedeva a
  schermo.

## I difetti che questo profilo poteva incontrare

| # inv. | Cosa si vedeva a schermo | Gravità | Rotto fino al | Commit | Verificato |
|---|---|---|---|---|---|
| 1 | Premo un pulsante e non succede niente, o compare un errore che non spiega niente. Vale per comunicare un'assenza, ritirarla, giustificarla, **scrivere alla maestra**, inviare un modulo, farsi mandare il codice di verifica, rispondere a un avviso | bloccante | **08/08 22:54** | `f59854ab` | `git show --stat` ok · su `main` · la stringa `"TURBOPACK unreachable"` è in `__tests__/lib/logging-with-route.test.ts:363` come valore reale del collaudo |
| 2 | Il pulsante «Comunica un'assenza» c'è, lo premo, e il sistema risponde che il servizio è **solo per la scuola primaria**. Ad Aversa non c'è primaria: qui l'errore non era probabile, era certo | bloccante | **07/08** | `f59854ab` | `git show --stat` ok · su `main` · «Aversa non ha primaria attiva quest'anno» — `PRD REGISTRO ELETTRONICO.md:8826` |
| 3 | Tocco «Comunica assenza» e mi ritrovo sul Diario: il pulsante d'invio era coperto dalla barra di navigazione | bloccante | **08/08** | `f59854ab` | `git show --stat` ok · su `main` |
| 5 | Tocco il campo «Motivo» dove lo vedo e finisco sul pulsante che invia: su schermi da 640 a 731 px il campo cadeva sotto il piede | bloccante | **09/08 00:38** | `7ef10e87` | `git show --stat` ok · su `main` |
| 14 | Mentre aspetto, il pulsante principale è illeggibile: contrasto **1,20:1** | fastidioso | **08/08** | `f59854ab` | `git show --stat` ok · su `main` |
| 15 | Con l'Alto Contrasto acceso i due campi del modulo sono **bianchi su bianco**; la conferma non viene annunciata; due frasi stanno a 2,51:1 | bloccante (Alto Contrasto) | **07-08/08** | `f59854ab` | `git show --stat` ok · su `main` |
| 16 | Col telefono in inglese leggo **«Value must be … or later»** dentro un'app italiana, in una finestrella di sistema | fastidioso | **08/08** | `f59854ab` | `git show --stat` ok · su `main` |
| 18 | Una data scritta male nel database fa **cadere l'intera schermata**; e la stessa data compare in due formati diversi nella stessa pagina | bloccante | **08/08** | `f59854ab` | `git show --stat` ok · su `main` |
| 20 | «Caricamento…» che non finisce mai, senza messaggio e senza un pulsante per riprovare, quando un pezzo dell'app non si scarica | bloccante | **15/08 00:25** | `0e8480a3` | `git show --stat` ok · su `main` · il componente c'era dal 03/08 e non era montato: `src/components/providers/RootProviders.tsx` **+15 righe** in questo commit |
| 21 | Con due figli, **firmo il certificato del bambino sbagliato**: la scheda Certificati usava sempre il primo figlio | bloccante | **15/08** | `0e8480a3` | `git show --stat` ok · su `main` · nel file precedente il commento diceva testualmente «NB: sempre children[0] — il tab Certificati non ha selettore figlio» |
| 22 | Il certificato che scarico porta una banda verde inventata, la scritta **«KIDVILLE SCHOOLS»**, **l'indirizzo di Aversa stampato due volte** e la firma di un «Dirigente Scolastico» che in una cooperativa non esiste | bloccante | **16/08 11:31** | `0974424a` | `git show --stat` ok · su `main` · vedi la sezione di sede qui sotto |
| 23 | Il certificato protocollato esce di **due pagine**, la seconda con la sola firma e tredici centimetri di bianco | fastidioso | **16/08** | `0974424a` | `git show --stat` ok · su `main` |
| 24 | **Il modulo per autorizzare la gita non compare mai**, nemmeno quando la gita c'è; e la notifica mi porta alla pagina iniziale invece che al modulo | bloccante | **16/08** | `0974424a` | `git show --stat` ok · su `main` · «le uscite vivono in `eventi_agenda` e `DatiUscita` non lo costruiva nessuno in tutto il repo» (messaggio del commit) |
| 26 | Compilo la domanda d'iscrizione, la firmo col codice via email e **non ricevo niente**: nessuna conferma, nessun riepilogo, nessuna idea di cosa succederà | bloccante | **15/08 02:48** | `b43a556e` | `git show --stat` ok · su `main` · `src/lib/email/messaggi/ricevuta-iscrizione.ts` **creato** in questo commit (147 righe) |
| 41 | Chiedo il certificato di iscrizione/frequenza o quello per il Bonus Nido e il sistema risponde che **manca il nome di chi firma per la scuola** | bloccante | **15/08 12:12** | `0e0ba538` | `git show --stat` ok · su `main` · i due modelli della famiglia con `firma: 'legale_rappresentante'` esistono da `0e8480a3` (15/08 00:25) |
| 66 | Sulla schermata dove si sceglie **a quale plesso iscrivere il proprio figlio**, il contorno fra una card e l'altra stava a **1,10:1**: non si vedeva quale sede avevo selezionato | fastidioso | **11/08 10:16** | `a9dcc6d8` | `git show --stat` ok · su `main` · diff su `EnrollmentWizard.tsx`: `border-kidville-line` → `border-kidville-neutral` (1,10:1 → 5,82:1) |

## Quello che era specifico di questa sede — e quello che non lo era

**Va detto subito, perché è la risposta onesta alla domanda che questo documento doveva porsi:
quindici delle sedici righe qui sopra sono le stesse che avrebbe subito un genitore di Giugliano.**
I difetti delle assenze, il «Caricamento…» infinito, il certificato firmato per il figlio sbagliato,
la gita che non compariva, la ricevuta d'iscrizione mai partita: nessuno di questi guardava la sede.
Erano difetti del prodotto, non del plesso. Chi cercasse in questo documento un elenco di sventure
esclusive di Aversa non lo troverebbe, e sarebbe giusto diffidare di chi lo scrivesse.

Le differenze vere fra le sedi sono **tre**, e una di esse capovolge quello che ci si aspetterebbe.

### 1. L'indirizzo sul certificato: ad Aversa era sbagliato da prima, e in un modo diverso

Il certificato che il genitore si genera da solo compone la testata con `buildIntestazioneSede()`,
che scrive `indirizzo — CAP CITTÀ (PROV)` prendendo `indirizzo` e `citta` dalle colonne di `scuole`
e CAP, provincia e codice meccanografico da `scuole.config.anagrafica`. Fino al 16 agosto
`config.anagrafica` conteneva, per tutte e tre le sedi reali, **la sola chiave `email`**: niente CAP,
niente provincia, niente codice meccanografico (misurato in sola lettura il 15/08 e messo a PRD).
La colonna `indirizzo`, invece, non era uguale nei tre plessi. Misura riportata nell'intestazione
della migrazione `20260814224957_anagrafica_sede_per_email.sql`:

| | `scuole.indirizzo` prima del 15/08 |
|---|---|
| Kidville Giugliano | `NULL` |
| Kidville **Aversa** | `Via Dell'Archeologia 54, 81031 Aversa (CE)` |
| Kidville Cesa | `Via Filippo Turati 2, 81030 Cesa (CE)` |

Aversa e Cesa erano state create il 29 luglio con la RPC `provisiona_sede`, che scrive `citta` e
`indirizzo` insieme, e in `indirizzo` era finita **la riga d'indirizzo intera**, CAP e provincia
compresi. Il codice, che di quel campo si aspettava la sola via, ci accodava di nuovo la città. Il
risultato stampato sul certificato di un bambino di Aversa era quindi:

```
Kidville Aversa
Via Dell'Archeologia 54, 81031 Aversa (CE) — Aversa
```

(La colonna `citta` non l'ho rimisurata: il valore «Aversa» viene dalla tabella dei dati di sede
della specifica del 15/08, dove Aversa è l'unica delle tre a non portare una nota di correzione —
per Giugliano la specifica prescrive di correggere `citta` in «Giugliano in Campania», il che dice
che fino a quel giorno era «Giugliano».)

A Giugliano lo stesso codice, sulla stessa schermata, produceva una riga diversa e sbagliata in un
altro modo: `indirizzo` era vuoto, quindi la seconda riga era la sola parola «Giugliano» — un
certificato **senza indirizzo**. Giugliano ha preso l'indirizzo doppio soltanto il 15 agosto, quando
la migrazione ha riempito il campo; ed è in quel momento che il difetto è stato visto, perché è la
sede da cui è stato generato il primo certificato vero. **Ad Aversa quella riga era sbagliata dal 29
luglio: per tutta la finestra di collaudo, fino alla correzione del 16/08 11:31 (`0974424a`), un
genitore di Aversa che scaricava il certificato riceveva un foglio con l'indirizzo del proprio
plesso scritto due volte.** La correzione ha rimesso in `indirizzo` la sola via e ha spostato CAP,
città e provincia nei loro campi, per tutte e tre le sedi insieme.

Il resto della testata — la banda verde, «KIDVILLE SCHOOLS», «Il Dirigente Scolastico» — era invece
scritto nel codice ed era identico ovunque.

### 2. L'anagrafica di sede mancante bloccava i certificati: e li bloccava in tutte e tre le sedi

L'inventario n. 41 raggiungeva davvero il genitore, e non solo la Segreteria: due degli otto moduli
della famiglia — il **certificato di iscrizione/frequenza** e il **certificato per il Bonus Asilo
Nido** — sono dichiarati con `firma: 'legale_rappresentante'`, e il motore **rifiuta** di generarli
se quel nome non è in configurazione, invece di stampare un foglio firmato da nessuno. I due modelli
esistono in app dalle 00:25 del 15 agosto (`0e8480a3`); il campo per scrivere quel nome è nato alle
12:12 dello stesso giorno (`0e0ba538`). In mezzo, un genitore che chiedeva il certificato riceveva
un rifiuto che gli parlava di un'impostazione che non lo riguardava.

**Questa però non era una disparità fra sedi.** La misura del 15/08 dice che in `config.anagrafica`
c'era la sola chiave `email` per **Giugliano, Aversa e Cesa**: nessuna delle tre aveva un legale
rappresentante, nessuna delle tre poteva emettere quei due certificati. Il certificato per il Bonus
Nido richiedeva in più gli estremi dell'autorizzazione al funzionamento, che sono **diversi per ogni
plesso** — e per Aversa non è un provvedimento comunale ma dell'**Ambito socio-sanitario C06**. Anche
questi sono stati compilati per tutte e tre le sedi il 16 agosto. Un genitore di Aversa e uno di
Giugliano hanno atteso lo stesso numero di giorni.

### 3. Il difetto n. 56 è l'unico che ha risparmiato Aversa

Il tetto di 20 caratteri sul codice meccanografico faceva rispondere **400** al salvataggio
dell'anagrafica di sede. La ragione è multi-sede: Giugliano e Cesa hanno **due** codici a testa —
nido/infanzia e primaria sono due plessi distinti per il Ministero — e uniti superano i 20 caratteri.
**Aversa ne ha uno solo**, dieci caratteri: il salvataggio di Aversa non è mai fallito. È un difetto
della Segreteria, non del genitore, e lo cito qui solo perché è l'unica riga dell'inventario in cui
essere ad Aversa era un vantaggio. Corretto in `0974424a`: `z.string().max(20)` → `.max(60)`.

### Il difetto del 20 agosto: reale, per plesso, e invisibile

L'unica cosa del 19-20 agosto arrivata in produzione è la tabella `candidature_sedi`, creata **senza
riga di sicurezza attiva** e quindi leggibile da chiunque con la chiave pubblica che sta nel
JavaScript del sito, la notte del 20 agosto. È il difetto più
multi-sede di tutto l'inventario — quello che si poteva leggere era **quante candidature ha ricevuto
ogni plesso**, Aversa compresa. **Non lo metto in tabella perché a schermo non si vedeva niente**:
nessun genitore, ad Aversa o altrove, poteva accorgersene aprendo l'app. Va detto lo stesso, perché
è vero. Chiuso da `ddfe3b0e` con `alter table … enable row level security`; il commit non è su `main`
— le migrazioni erano state applicate direttamente al database di produzione, ed è per questo che il
buco è esistito.

**Quanto è durato: non lo so con precisione, e lo scrivo invece di arrotondare.** La tabella nasce
con `e8319816` e la protezione arriva con `ddfe3b0e`: fra i due commit passano **36 minuti**
(00:50:56 → 01:27:07 del 20/08). L'autore della correzione scrive «un'ora». **L'istante esatto in
cui la migrazione è stata applicata al database — che è il momento in cui il buco si è davvero
aperto — non è provato da nessun documento**, e il nome del file di migrazione non serve a dedurlo:
lo stesso messaggio di `ddfe3b0e` racconta che quel nome portava un orario di 22 minuti nel futuro.

## Cosa questo profilo NON poteva incontrare, e perché lo scrivo

Un elenco che gonfia si riconosce dal fatto che non esclude mai niente. Queste sono le righe
dell'inventario che ho **tolto**, e la ragione di ciascuna.

- **n. 13 — `/parent/primaria/assenze` bloccata su «Caricamento…» per sempre.** Ad Aversa non c'è
  primaria: quella pagina non aveva nulla da mostrare a questo profilo, e questo profilo non aveva
  ragione di aprirla.
- **n. 19 — chi ha un figlio 0-6 e uno in primaria vedeva due prodotti diversi, con venti divergenze
  di testo.** Per un genitore di Aversa quella combinazione **non è possibile**: i due figli
  sarebbero in due plessi diversi. È la differenza di sede più netta di tutto il documento, ed è una
  differenza in meno, non in più.
- **n. 8 — la barra verde che sparisce e il testo che risale nella fascia della Dynamic Island** e
  **n. 17 — il calendario che si apre da solo**: sono difetti di iPhone. Il collaudo chiuso di cui
  parla questo documento è quello di **Google Play**, su Android.
- **n. 4, 6, 9, 10 e 11 — i difetti delle assenze del 7-8 agosto: reali nel codice, mai capitati a
  nessuno.** Li tenevo in tabella e sbagliavo. Lo stato che era in produzione il 6 agosto
  (`29da34b4`, 06/08 17:52) dice tre cose. **Primo**: il modulo dell'assenza non era la scheda che
  ho descritto — `ComunicaAssenzaCard` **nasce con `f59854ab`**, cioè col commit che ripara. Il
  modulo vero stava in `parent/attendance/page.tsx`, 141 righe, e **non aveva né un link
  all'informativa né un piede appiccicato**: il n. 4 (tocco «Leggi l'informativa» e parte la
  comunicazione) e il n. 6 (il messaggio di rifiuto nato dietro il piede) non avevano la superficie
  su cui verificarsi. **Secondo**: quella rotta aveva il solo `export const POST` — **nessun
  `DELETE`** — quindi il n. 10 (annullo un'assenza e sparisce una presenza passata) non era
  fisicamente raggiungibile. **Terzo**: il n. 9 e il n. 11 richiedono che un genitore *sia riuscito*
  a comunicare un'assenza, e il n. 2 dimostra che non è mai successo — zero notifiche
  `assenza_comunicata` da sempre. Sono difetti che il collaudo ha trovato **dentro il ramo**, fra un
  giro e l'altro dei cinque collaudi, e che sono arrivati in produzione già corretti. Chiamarli
  «incontrati da un tester» sarebbe falso.

- **n. 25 — ogni «Scarica il certificato» ne riemetteva uno nuovo, con l'anno scolastico sbagliato.**
  Difetto vero, corretto il 16/08 con `0974424a`, ma **latente per tutta la finestra**: scattava solo
  fra le 00:00 e le 02:00 del **1° agosto**, quando il server (che contava in UTC) e l'utente (ora
  italiana) stavano in due mesi diversi. Il 1° agosto è **cinque giorni prima** dell'inizio del test
  chiuso: nessun tester poteva incontrarlo. Lo tengo fuori dalla tabella per la stessa ragione per
  cui ne tengo fuori il n. 56 — vero, ma non incontrabile da chi ha usato l'app fra il 6 e il
  20 agosto.
- **n. 7 e n. 12** — una schermata e mezza di vuoto in fondo all'elenco, e un messaggio che diceva di
  aver tolto il motivo senza toglierlo: veri, corretti l'8 agosto, ma cosmetici accanto al resto.
  Li lascio fuori dalla tabella per non allungarla con righe che nessuno avrebbe segnalato.
- **Tutta la PARTE A.2 (docente) e A.3 (segreteria)**, salvo il n. 41, che ho tenuto solo perché il
  suo effetto arrivava fino alla schermata del genitore. Il n. 56 l'ho citato in prosa, non in
  tabella, per la stessa ragione al contrario: tocca la sede, non questo profilo.
- **Tutta la PARTE B** — cron, email di sistema, fatturazione, log, migrazioni, console degli store —
  e **tutta la PARTE C.2**, che è lavoro rimasto su un ramo e mai arrivato in produzione. Attribuirlo
  a un tester sarebbe una dichiarazione falsa.
- **Il difetto n. 2 va letto per intero**: ad Aversa colpiva il 100% dei genitori, non i due terzi
  come nel plesso misurato nell'inventario. Non l'ho spostato di gravità per questo — era già
  bloccante — ma la sede cambia la platea, e mi sembra più onesto dirlo che lasciarlo intendere.

Nessuna riga di questo documento riporta parole attribuite a una persona. Nessuna riga contiene dati
di una famiglia o di un bambino: le sole misure riportate sono conteggi, nomi di sede e codici presi
da file del repository.

## Verifiche eseguite

Tutto in **sola lettura**. Nessun `git commit`, `git add`, `git push`, `git checkout`. Nessuna query
al database: le misure sul contenuto della produzione sono quelle già scritte e datate nel
repository, e sono citate con il file in cui stanno.

**Esistenza dei commit** — `git show --stat --oneline <hash> | head -20` su tutti e otto:
`f59854ab` · `7ef10e87` · `0e8480a3` · `0e0ba538` · `b43a556e` · `0974424a` · `a9dcc6d8` ·
`ddfe3b0e`.

**Presenza in produzione** — `git branch --contains <hash> | grep -w main` sui primi sette: tutti su
`main`. `ddfe3b0e` **non è su `main`** ed è dichiarato come tale nel testo, insieme alla ragione per
cui il suo difetto è stato ugualmente reale (migrazioni applicate direttamente al database).

**Il commit che apre il buco di C.1** — `e8319816` («Le sedi di una candidatura diventano righe…»),
`2026-08-20 00:50:56`. Come `ddfe3b0e`, **non è su `main`**: `git branch --contains e8319816 | grep
-w main` non restituisce niente.

**Lo stato che era in produzione il 6 agosto** — `29da34b4` (06/08 17:52), per stabilire cosa
esisteva davvero all'inizio del test chiuso:

```
git ls-tree -r --name-only 29da34b4 | grep ComunicaAssenzaCard                → vuoto
git show 29da34b4:src/app/api/parent/presenze/comunica-assenza/route.ts \
  | grep -c 'export const DELETE'                                             → 0
```

Verificato in più, per non fermarmi al nome di un file: `git grep -l "comunica-assenza" 29da34b4 --
'src/*'` trova **un chiamante**, `src/app/(dashboard)/parent/attendance/page.tsx` — quindi il modulo
c'era, ma era un altro (141 righe, nessuna `informativa`, nessun `DELETE`, nessun piede appiccicato).
E `git log --diff-filter=A -- '*ComunicaAssenzaCard*'` dà **`f59854ab`**: la scheda descritta
dall'inventario nasce con il commit che la ripara.

**Date dei commit** — `git show -s --format='%ci'`: `f59854ab` 2026-08-08 22:54 · `7ef10e87`
2026-08-09 00:38 · `a9dcc6d8` 2026-08-11 10:16 · `0e8480a3` 2026-08-15 00:25 · `b43a556e` 2026-08-15
02:48 · `0e0ba538` 2026-08-15 12:12 · `0974424a` 2026-08-16 11:31 · `ddfe3b0e` 2026-08-20 01:27.

**Prove lette nel codice**, oltre ai messaggi di commit:

| Cosa | Dove |
|---|---|
| Il certificato del genitore si genera nel browser e compone la testata dai dati della **sua** scuola | `src/app/(dashboard)/parent/modulistica/page.tsx` alla versione `0974424a^`, funzione `generateSelfServiceCertificate` |
| I dati di sede arrivano per-figlio dalla tabella `scuole`, con CAP/provincia/cod. mecc. da `config.anagrafica` | `src/app/api/parent/students/route.ts:30-70` — presente anche alla versione `f59854ab` |
| La composizione `indirizzo — CAP CITTÀ (PROV)` | `src/lib/certificati/self-service.ts`, `buildIntestazioneSede()` |
| `scuole.indirizzo` prima del 15/08, sede per sede | intestazione di `supabase/migrations/20260814224957_anagrafica_sede_per_email.sql` |
| Aversa creata con `citta` e `indirizzo` insieme | `supabase/migrations/20260731123052_provisiona_sede_v2.sql:256-260` |
| I due certificati della famiglia richiedono il legale rappresentante, e il motore **rifiuta** senza | `src/lib/prestampati/modelli/genitore.ts` (`firma: 'legale_rappresentante'`) · `src/lib/prestampati/render.ts`, `componiFirma()` |
| `config.anagrafica` con la sola chiave `email` su tutte e tre le sedi, misurato il 15/08 | `PRD REGISTRO ELETTRONICO.md:1115-1117` |
| Autorizzazione di Aversa emessa da un **Ambito socio-sanitario**, non da un Comune | `docs/superpowers/specs/2026-08-15-carta-intestata-e-modulistica-design.md`, tabella §2.1 |
| Tetto di 20 caratteri sul codice meccanografico, e perché Aversa non lo superava | `src/lib/scuole/anagrafica.ts` (commento su `codice_meccanografico`) · diff `0974424a`: `.max(20)` → `.max(60)` |
| «Aversa non ha primaria attiva quest'anno» | `PRD REGISTRO ELETTRONICO.md:8826` |
| «non ci sono famiglie reali su Aversa e Cesa (3 alunni su 3 sono seed)» | `PRD REGISTRO ELETTRONICO.md:1517` |
| Card di scelta del plesso: contorno da `border-kidville-line` a `border-kidville-neutral` | diff `a9dcc6d8` su `src/components/features/public/EnrollmentWizard.tsx` |
| `ChunkErrorBoundary` esisteva ma non era montato | diff `0e8480a3`: `src/components/providers/RootProviders.tsx` **+15 righe** |
| «sempre `children[0]` — il tab Certificati non ha selettore figlio» | commento nel file alla versione `0e8480a3^`, riga 412 |
| La tabella `candidature_sedi` nata senza riga di sicurezza | `supabase/migrations/20260819231500_candidature_sedi.sql:57-79` |
