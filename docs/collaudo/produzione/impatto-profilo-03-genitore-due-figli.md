# Profilo 03 — genitore con due figli (infanzia + primaria)

> **Questo NON è un feedback ricevuto.** È la ricostruzione, provata commit per commit, dei difetti
> che un utente con questo profilo poteva incontrare nell'app fra il 6 e il 20 agosto 2026.

Fonte: `docs/collaudo/produzione/00-INVENTARIO-difetti-6-20-agosto.md`. Ambito: **PARTE A** e
**PARTE C.1**, come da mandato. Ogni riga porta il commit che l'ha chiusa, verificato presente e
verificato su `main`. Dove il difetto è **specifico del multi-figlio** l'ho riaperto nell'albero
per misurare da quando era davvero davanti all'utente, invece di riportare la data in cui è stato
trovato: le due cose non coincidono quasi mai, e in due casi la differenza è di nove giorni.

---

## Come si presentava l'app a questo profilo, giorno per giorno

L'app Android è una finestra su `https://app.kidville.it`: ogni rilascio del sito arrivava ai
tester senza scaricare niente. Quindi «com'era l'app quel giorno» si legge da quale commit stava
su `main`. Fra il 6 e il 20 agosto la produzione è cambiata **diciassette volte** — misurato:
`git log --first-parent main --since=2026-08-06 --until=2026-08-21` restituisce **18** commit, di
cui il primo (`29da34b4`, 06/08 17:52) è lo stato di partenza. L'ultimo è `b87ee964`, **17/08
01:35**: dal 18 al 20 agosto la produzione non è più cambiata.

Questo profilo ha **due figli in due gradi diversi**, e l'app lo sa: in cima a ogni schermata c'è
il **selettore del figlio**, una fila di pastiglie con le iniziali che *compare soltanto da due
figli in su* (`ChildSwitcher.tsx`, «Si nasconde se c'è meno di 2 figli»). Toccarne una scrive la
scelta e **ricarica l'intera app** (`window.location.reload()`). Ed è la leva che comanda tutto:
il menu, le voci del piede, e dove porta la stessa piastrella.

**Dal 6 agosto alle 22:54 dell'8 agosto** — in produzione `29da34b4`. È il periodo peggiore per
questo profilo, e non per un difetto solo.
Con il figlio dell'**infanzia** attivo il menu mostra Diario, Armadietto, Presenze; la piastrella
«Segnala assenza» porta a `/parent/attendance`, che ha un modulo vero con giorno e «Motivo».
Toccando «Comunica assenza» il server risponde **500 con la pagina vuota**: non un messaggio, non
un errore leggibile, niente. Insieme a quel pulsante ne cadono altri sette, fra cui **scrivere
alla maestra**, mandare un modulo e farsi mandare il codice via email.
Poi si tocca la pastiglia dell'altro figlio, l'app si ricarica, e il prodotto cambia: spariscono
Diario e Armadietto, arrivano Registro, Lezioni, Compiti, Note, Pagelle, la linguetta in basso
non si chiama più «Diario» ma «Scuola». La **stessa piastrella «Segnala assenza»** ora porta a
`/parent/primaria/assenze` — dove **non c'è nessun modo di comunicare un'assenza**. E quella
schermata, quando l'identità non si risolve, resta su «Caricamento…» **senza fine**; quando la
lettura fallisce dice **«nessuna assenza»**, che è la stessa faccia di «tuo figlio non è mai
mancato».

**Dalle 22:54 dell'8 agosto alle 00:38 del 9** — `f59854ab`, un'ora e quarantaquattro minuti, di
notte. «Comunica un'assenza» funziona su entrambi i gradi per la prima volta, le due schermate
gemelle sono state riallineate — ma sulla schermata rifatta il campo **«Motivo» finisce sotto il
piede appiccicato**: si tocca dove lo si vede e si preme il pulsante che invia.

**Dal 9 al 15 agosto** — le assenze reggono su entrambi i figli. Resta aperto ciò che questo
profilo incontra in Modulistica: la linguetta **«Certificati»** consegna sempre il certificato del
**primo figlio dell'elenco**, qualunque figlio sia selezionato in cima; e il foglio che ne esce
porta una banda verde inventata, «KIDVILLE SCHOOLS» e la firma di un «Dirigente Scolastico».
Resta aperto anche il caso in cui un pezzo del programma non arriva: **«Caricamento…» per sempre**,
senza messaggio e senza un pulsante per riprovare — e questo profilo ricarica l'app da capo ogni
volta che cambia figlio.

**Dalle 00:25 del 15 alle 11:31 del 16 agosto** — `0e8480a3`. Arriva il **selettore del figlio
dentro la scheda Certificati** (con due figli non ne preseleziona nessuno: bisogna scegliere), e
arriva il pannello che parla quando un pezzo non si carica. Nella stessa finestra il **modulo di
autorizzazione alla gita non compare mai**, per nessuno dei due figli, nemmeno quando la gita c'è.

**Dalle 11:31 del 16 al 20 agosto** — `0974424a`. Il certificato esce sulla carta intestata vera,
con «IL LEGALE RAPPRESENTANTE», numero di protocollo e copia nel fascicolo del bambino, e
riscaricarlo restituisce lo stesso foglio invece di bruciarne un altro. Il modulo della gita
compare quando la gita esiste, con destinazione, data e orari veri. **Dal 17 agosto in poi la
produzione non cambia più** per questo profilo: il lavoro del 19-20 agosto è tutto su un branch.

---

## I difetti che questo profilo poteva incontrare

| # inv. | Cosa si vedeva a schermo | Gravità | Rotto fino al | Commit | Verificato |
|---|---|---|---|---|---|
| 1 | Premo «Comunica assenza», «Invia» o «Manda il messaggio alla maestra» e la pagina resta bianca. Otto comandi del genitore rispondevano **500 con la pagina vuota**: comunicare un'assenza e annullarla, giustificarla, **scrivere alla maestra**, mandare un modulo, chiedere il codice via email, rispondere a un avviso | bloccante | **08/08 22:54** | `f59854ab` | commit su `main`; il ternario guasto è vivo a `29da34b4:src/lib/pagamenti/sospensione.ts:66`, e il gate è presente a `29da34b4` in `chat/messages`, `presenze/giustifica`, `parent/submissions`, `forms/send-otp` |
| 2 | **«Comunica un'assenza» non era utilizzabile per nessuno dei due figli.** Dal figlio dell'infanzia il pulsante c'era e portava a un errore garantito; dal figlio di primaria la stessa piastrella portava a una schermata che quel modulo non ce l'ha | bloccante | **08/08 22:54** | `f59854ab` | `29da34b4:src/app/api/parent/presenze/comunica-assenza/route.ts:56` risponde 403 «Disponibile solo per la scuola primaria»; `29da34b4:src/app/(dashboard)/parent/page.tsx:64` instrada `isPrimaria ? /parent/primaria/assenze : /parent/attendance`; `ComunicaAssenzaCard.tsx` **non esiste** a `29da34b4` |
| 19 | **Lo stesso comando, due prodotti diversi.** Cambiando figlio si ricaricava tutta l'app e cambiava il menu, il nome della linguetta in basso, e dove portava la piastrella «Segnala assenza»: da una parte un modulo con giorno e «Motivo», dall'altra una schermata che l'assenza non la manda | fastidioso | **08/08 22:54** | `f59854ab` | `29da34b4:src/components/features/parent/BottomNav.tsx:79,90,136-138` |
| 13 | La schermata delle assenze del figlio di primaria restava su **«Caricamento…» senza fine**; e quando la lettura falliva diceva **«nessuna assenza»** | bloccante | **08/08 22:54** | `f59854ab` | `29da34b4:src/app/(dashboard)/parent/primaria/assenze/page.tsx:62-69`: `if (!ready \|\| !parentId \|\| !studentId) return` con `loading` iniziale a `true`, e `.then(d => { if (d.success) … })` senza nessun ramo d'errore |
| 18 | Nell'elenco delle assenze del figlio di primaria la data usciva **senza anno**; e una data malformata dal database **portava via l'intera schermata**, non una cella | bloccante | **08/08 22:54** | `f59854ab` | `29da34b4:src/app/(dashboard)/parent/primaria/assenze/page.tsx:159`: `.format(new Date(p.data))` con formato `{weekday, day, month}` — nessun anno, e `.format` lancia su data non valida |
| 3 | Tocco il pulsante che invia l'assenza e mi ritrovo sul Diario: era a filo della barra di navigazione | bloccante | **08/08 22:54** | `f59854ab` | a `29da34b4:src/app/(dashboard)/parent/attendance/page.tsx:77` l'unica difesa è `pb-24` — esattamente il rimedio che il ciclo di correzione ha poi **misurato insufficiente** sulla schermata gemella (`page.mouse.click(112, 823)` → `/parent/diary`) |
| 5 | Tocco il campo «Motivo» dove lo vedo e finisco sul pulsante che invia: il campo era finito sotto il piede appiccicato | bloccante | **09/08 00:38** | `7ef10e87` | commit su `main`; in produzione dalle 22:54 dell'8 alle 00:38 del 9 — **1 ora e 44 minuti, di notte** |
| 21 | **Con due figli, il certificato usciva intestato al bambino sbagliato.** La linguetta «Certificati» lavorava sempre sul primo figlio dell'elenco, anche con l'altro figlio scelto nel selettore in cima — su un foglio che poi va al datore di lavoro o all'INPS | bloccante | **15/08 00:25** | `0e8480a3` | `29da34b4:src/app/(dashboard)/parent/modulistica/page.tsx:412-414`: `// NB: sempre children[0] — il tab Certificati non ha selettore figlio` / `const currentStudent = children[0];` |
| 20 | Un pezzo del programma non arriva e la schermata resta su **«Caricamento…» per sempre**, senza messaggio e senza un pulsante per riprovare | bloccante | **15/08 00:25** | `0e8480a3` | `ChunkErrorBoundary` è montato in `src/components/providers/RootProviders.tsx` **solo da** `0e8480a3`; il commento nel file data l'assenza dal 03/08 al 14/08 |
| 26 | Mandata la domanda d'iscrizione e firmata col codice via email, **non arrivava niente**: nessuna conferma, nessun riepilogo, nessun modo di sapere che era arrivata | bloccante | **15/08 02:48** | `b43a556e` | `sendEmailDetailed`, `risolviContestoSede` e `messaggioRicevutaIscrizione` sono **aggiunti** da `b43a556e` a `src/app/api/iscrizione/route.ts`; il commento aggiunto dice «oggi nessuna ricevuta partiva affatto» |
| 22 | Il certificato scaricato portava una **banda verde inventata**, **«KIDVILLE SCHOOLS»** al posto della ragione sociale e la firma di un **«Dirigente Scolastico»** che in una cooperativa non esiste — sotto la dicitura «Firma digitale apposta ai sensi dell'art. 21 CAD», che non era vera | bloccante | **16/08 11:31** | `0974424a` | quelle righe sono **già a** `29da34b4:src/app/(dashboard)/parent/modulistica/page.tsx`: `doc.rect(0,0,210,40,'F')`, `doc.text('KIDVILLE SCHOOLS', 20, 25)`, `doc.text('Il Dirigente Scolastico', 130, 180)` |
| 24 | **Il modulo di autorizzazione alla gita non compariva mai**, per nessuno dei due figli, nemmeno quando la gita c'era; e la notifica apriva la home invece del modulo | bloccante | **16/08 11:31** | `0974424a` | commit su `main`; il modulo n. 10 nasce con `0e8480a3` (15/08 00:25) e `datiUscitaDaEvento()`, che è ciò che lo accende, arriva con `0974424a` |

---

## I difetti che questo profilo subiva PIÙ degli altri

**1. Il certificato al bambino sbagliato (n. 21) è un difetto che esiste solo qui.** Con un figlio
solo, `children[0]` è il figlio giusto per definizione. Con due, la scheda «Certificati» ignorava
il selettore che sta in cima alla stessa schermata e che *mostra il nome dell'altro bambino mentre
si preme «Scarica PDF»*. Due dettagli lo rendono peggiore di come suona. Il primo: sulla **stessa
pagina**, la linguetta «Certificati medici» aveva già il suo elenco a tendina dei figli, con tanto
di avviso «seleziona il figlio» se non ne sceglievi uno (`modulisticaSelezionaIlFiglio`) — quindi
in una linguetta l'app chiedeva quale bambino, e in quella accanto decideva da sé. Il secondo: il
certificato di frequenza nomina il bambino **e la sua sezione** (`buildCertificatoBody`), perciò
un genitore con un figlio all'infanzia e uno alla primaria riceveva un foglio la cui sezione
apparteneva visibilmente all'altro grado — sbagliato in modo evidente per chi legge con
attenzione, e invisibile per chi lo inoltra senza aprirlo.
Una precisazione che va detta perché il documento sia onesto: fino al 14 agosto quella scheda
**scaricava** soltanto. La **firma** dei prestampati (scheda sanitaria, autorizzazione ai farmaci,
richiesta di dieta) è nata con `0e8480a3`, cioè **con lo stesso commit che ha aggiunto il
selettore**. Quindi «firmare le allergie di un figlio sul fascicolo dell'altro» non è mai stato
possibile in produzione: era il rischio che la correzione ha evitato. Ciò che **è** stato in
produzione, dal 6 al 15 agosto, è il certificato intestato al figlio sbagliato.

**2. Il selettore del figlio era l'unico elemento che non partecipava all'Alto Contrasto — dal
6 agosto alle 22:54 dell'8 (`f59854ab`).** È un rilievo della stessa famiglia di contrasto chiusa da
quel commit (righe 14-15 dell'inventario), ma è l'unico membro che *solo* un genitore con più figli
poteva incontrare, perché con un figlio il selettore non si disegna affatto. Fino a quel momento i
colori della pastiglia erano scritti a mano dentro lo `style` del componente —
`background:'#006A5F'`, `color:'#FDC400'` — e uno stile scritto lì batte qualunque foglio di stile:
né la rete che corregge la coppia verde-giallo né il ribaltamento dell'Alto Contrasto lo
raggiungevano. **4,05:1**, identico con l'Alto Contrasto acceso: era l'unico posto della schermata
che dice **di quale bambino** si sta parlando, ed era l'unico che restava com'era quando l'utente
chiedeva più contrasto.

⚠️ **Questa misura non è mia: era già nel repo prima che io la leggessi.** Il numero, la frase
«l'unico elemento della schermata che non partecipa affatto al ribaltamento» e «l'unico posto della
schermata che dice DI QUALE bambino» stanno **alla lettera** nell'intestazione del lock
`__tests__/a11y/contrasto-skip-link-e-selettore-figlio.test.tsx` (punto «T20»), committato l'8
agosto con `f59854ab`. Il mio contributo è solo la constatazione che quel rilievo è **esclusivo di
questo profilo**. La riparazione si legge in
`git show f59854ab -- src/components/features/parent/ChildSwitcher.tsx`: lo `style` inline lascia il
posto a `bg-kidville-green` + `text-kidville-yellow-ink` (#FFDA5C su #006A5F = 4,78:1), e il
commento aggiunto porta la data: «⚠️ I COLORI NON STANNO PIÙ NELLO `style` INLINE (2026-08-08)».
Lo stato rotto è a `29da34b4:src/components/features/parent/ChildSwitcher.tsx:82`.

**3. Il difetto n. 1 blocca i due figli insieme, e per una ragione di progetto.** Il gate che
cadeva si chiama `assertGenitoreNonSospeso` e nega l'accesso «se **ALMENO UN** figlio del genitore
è sospeso». Non è un difetto — è la regola voluta — ma dice che in questa famiglia i due bambini
non sono due conti separati: quando quel gate sbagliava, sbagliava **una volta per tutta la
famiglia**, e i comandi cadevano su entrambi i figli nello stesso istante. Nella pratica: due
maestre a cui non si può scrivere, due assenze che non si possono comunicare, due moduli che non
si possono mandare, e nessun messaggio d'errore da nessuna delle due parti.
Verificato in `src/lib/pagamenti/sospensione.ts:140-141`.

**4. Ogni cambio di figlio è un riavvio dell'app, e i difetti del primo disegno si pagano due
volte.** `ChildSwitcher.onSelect` fa `window.location.reload()`. Chi ha un figlio solo apre l'app
la mattina e basta; chi ne ha due la fa ripartire da capo ogni volta che vuole guardare l'altro
bambino. Tutto ciò che si rompe al primo disegno — «Caricamento…» che non finisce (n. 13),
«Caricamento…» senza uscita quando manca un pezzo (n. 20) — questo profilo lo incontra **una volta
per figlio**, non una volta al giorno.

**5. Tutto ciò che è per-sezione, qui è doppio.** Due figli in due gradi diversi stanno in due
sezioni diverse, con due maestre e due calendari. Il modulo della gita (n. 24) compare «solo se
esiste un'uscita pubblicata **per la sezione di quel bambino**»: finché è rimasto spento, sono
rimaste scoperte due gite invece di una. Vale allo stesso modo per la domanda d'iscrizione senza
ricevuta (n. 26): due bambini iscritti per il 2026/27 sono **due domande mandate e due silenzi**,
non uno.

---

## Cosa questo profilo NON poteva incontrare, e perché lo scrivo

Lo scrivo perché il documento serve a un revisore che deve poter fidarsi delle righe di sopra, e
un elenco che gonfia si smonta dalla riga più debole. Ho tolto queste, e ognuna è stata tolta
dopo una verifica, non per prudenza.

**I difetti nati e chiusi dentro il ciclo di correzione, mai arrivati sul telefono di nessuno.**
La PR #74 è entrata in `main` come **un solo commit**, `f59854ab`, alle 22:54 dell'8 agosto: tutti
gli stati intermedi dei cinque collaudi sono rimasti nell'albero di lavoro. Verificato a
`29da34b4`, cioè ciò che stava in produzione il 6 agosto: **non esiste** il pulsante «Annulla» di
un'assenza (nessun `export const DELETE` in `comunica-assenza/route.ts`), **non esiste** l'elenco
«Assenze già comunicate» (la chiave `attendanceElencoNota` non c'è in `parentServizi.json`), e
**non esiste** il file `ComunicaAssenzaCard.tsx`. Quindi cadono, per questo profilo e per tutti:
il n. 10 (annullando un'assenza si cancellava una presenza di un giorno passato), il n. 12
(l'app diceva di aver tolto il motivo e non lo toglieva), e il n. 6 (il messaggio di rifiuto dietro
il piede) nella forma misurata sulla card della primaria.
Cade con loro **la coda della riga n. 19**, e la tolgo dalla tabella invece di difenderla: «solo una
delle due schermate diceva fino a quando si può ritirare un'assenza» non è mai stato vero in
produzione, perché **non lo diceva nessuna delle due**. La frase «Puoi annullarle finché
l'insegnante non registra l'appello» è **aggiunta** da `f59854ab` a `messages/it/parentPrimaria.json`
e a `parentServizi.json`; a `29da34b4` non esiste in nessun file (`git grep -i "registra l.appello"
29da34b4 -- src` → vuoto). E non c'era comunque niente da ritirare: a `29da34b4` in
`comunica-assenza/route.ts` non esiste nessun `export const DELETE`. Era la venticinquesima
divergenza da albero di lavoro rientrata dalla finestra — proprio nel paragrafo in cui dichiaravo di
averle espunte.
Vale in parte anche per il n. 19, ed è la precisazione che tengo a fare: **il numero «20 divergenze
su 16 coppie» è una misura presa il 7 agosto sull'albero di lavoro**, sulle due schermate gemelle
mentre venivano riallineate — quelle venti divergenze non sono mai state in produzione. Ciò che
questo profilo **ha** visto, dal 6 all'8 agosto, è la divergenza più grossa e più vecchia, ed è
quella che ho messo in tabella: due menu diversi, e la stessa piastrella che porta a un modulo da
una parte e a nessun modulo dall'altra.

**Il n. 25 — il certificato che riemette invece di riusare, bruciando un numero di protocollo, con
l'anno scolastico sbagliato.** Doppio motivo per escluderlo, e nessuno dei due è un'opinione. Primo:
il difetto si manifesta **solo fra le 00:00 e le 02:00 del 1° agosto**, quando il server è ancora
al 31 luglio in UTC mentre l'Italia è già al 1° agosto — una finestra di due ore che sta **cinque
giorni prima** dell'inizio del collaudo (`src/lib/anno-scolastico.ts`, commento del 16/08). Secondo:
fino al 16 agosto il certificato della famiglia **non aveva nessun protocollo da bruciare** — «il
foglio nasceva in jsPDF nel browser, si scaricava e spariva» — e la porta che emette col numero di
protocollo, `POST /api/parent/prestampati`, arriva con `0974424a`, cioè con la correzione stessa.

**Tutta la PARTE A.2 e A.3** — docente, segreteria, Direzione. Un genitore non ha quelle schermate.
Cade anche il n. 52, che riguarda un certificato che **la segreteria** non riusciva a rilasciare.

**La PARTE C.1 — la tabella `candidature_sedi` pubblica per un'ora, il 20 agosto fra le 00:50 e
l'01:27.** È l'unico difetto del 19-20 agosto che è stato vero in produzione, ed è per questo che il
mandato lo tiene in campo. Ma riguarda le **candidature di lavoro** raccolte da `/lavora-con-noi`:
ciò che era leggibile è il conteggio delle candidature per plesso, e ciò che era invocabile è la
funzione che ne riscrive lo stato. Nessun dato di questo profilo, nessuna schermata di questo
profilo, e nessun sintomo visibile dentro l'app del genitore. Va inoltre detto per intero: il
commit che la richiude, `ddfe3b0e`, **non è su `main`** — `git branch --contains` non lo trova. Sta
su `feat/candidature-multisede`. La correzione è arrivata in produzione perché **le migrazioni sono
state applicate direttamente al database**, non perché il codice sia stato rilasciato. È
esattamente ciò che dichiara il §2 dell'inventario, e l'ho verificato invece di riportarlo.

**I difetti n. 4, 7, 8, 9, 11, 14, 15, 16, 17.** Riguardano schermate che questo profilo aveva, e
alcuni erano quasi certamente davanti a lui — ma la loro finestra reale in produzione dipende da
quale onda del ciclo li ha introdotti, e per questi non sono riuscito a stabilirlo con la stessa
certezza delle righe di sopra. Li lascio fuori: non perché siano falsi, ma perché non posso
provarne la data d'inizio con una riga di codice. Restano nell'inventario, che è la fonte, e chi
volesse potrà datarli con lo stesso metodo.

---

## Verifiche eseguite

**Presenza dei commit** — `git show --stat --oneline <hash> | head -20` su tutti e otto gli hash
citati: `f59854ab`, `7ef10e87`, `b43a556e`, `0e8480a3`, `0974424a`, `29da34b4`, `ddfe3b0e`,
`a9dcc6d8`. Tutti esistono.

**Presenza in produzione** — `git branch --contains <hash> | grep -w main`:

| Commit | Data e ora | Su `main` |
|---|---|---|
| `29da34b4` | 2026-08-06 17:52 | sì |
| `f59854ab` | 2026-08-08 22:54 | sì |
| `7ef10e87` | 2026-08-09 00:38 | sì |
| `0e8480a3` | 2026-08-15 00:25 | sì |
| `b43a556e` | 2026-08-15 02:48 | sì |
| `0974424a` | 2026-08-16 11:31 | sì |
| `ddfe3b0e` | 2026-08-20 01:27 | **NO** — su `feat/candidature-multisede` |

**Stato della produzione all'inizio della finestra** — `git log --first-parent main` mostra che fra
`29da34b4` (06/08 17:52) e `f59854ab` (08/08 22:54) non c'è nessun altro commit: `29da34b4` **è**
ciò che i tester avevano davanti dal 6 agosto fino alla sera dell'8. Tutte le righe con «Rotto fino
al 08/08 22:54» sono state riverificate leggendo i file **a quel commit**, non nell'albero di oggi.

**Letture puntuali nell'albero storico** (`git show 29da34b4:<file>`):
`src/lib/pagamenti/sospensione.ts` · `src/app/api/parent/presenze/comunica-assenza/route.ts` ·
`src/app/(dashboard)/parent/page.tsx` · `src/app/(dashboard)/parent/attendance/page.tsx` ·
`src/app/(dashboard)/parent/primaria/assenze/page.tsx` ·
`src/app/(dashboard)/parent/modulistica/page.tsx` ·
`src/components/features/parent/BottomNav.tsx` · `src/components/features/parent/ChildSwitcher.tsx` ·
`src/components/features/parent/PrimariaParentView.tsx` · `src/lib/certificati/self-service.ts` ·
`messages/it/parentServizi.json` · `messages/it/parentPrimaria.json`.

**Esistenza di file a `29da34b4`** — `git ls-tree -r --name-only`: `ComunicaAssenzaCard.tsx`
assente; `PrimariaParentView.tsx` presente **ma importato da nessun file di `src/`**
(`git grep -l PrimariaParentView 29da34b4 -- src` restituisce solo sé stesso), quindi il comando
«Comunica assenza» che contiene non era raggiungibile.

**Diff mirati** — `git show <hash> -- <file>` su
`src/app/(dashboard)/parent/modulistica/page.tsx` (n. 21),
`src/components/providers/RootProviders.tsx` (n. 20),
`src/app/api/iscrizione/route.ts` (n. 26),
`messages/it/parentPrimaria.json` (n. 19, e da lì l'espunzione della sua coda),
`src/components/features/parent/ChildSwitcher.tsx` (contrasto del selettore),
`supabase/migrations/20260819231500_candidature_sedi.sql` (PARTE C.1).

**Riverifiche dopo il primo respingimento** (tre rilievi, tutti e tre confermati veri prima di
correggere):
`git grep -i "registra l.appello" 29da34b4 -- src` → **vuoto**, quindi in produzione nessuna delle
due schermate diceva entro quando si ritira un'assenza: coda del n. 19 espunta ·
`git show f59854ab -- src/components/features/parent/ChildSwitcher.tsx` → lo `style` inline
sostituito da `bg-kidville-green` + `text-kidville-yellow-ink`, con la data 2026-08-08 scritta nel
commento aggiunto: il rilievo di contrasto ha una finestra, e la misura era già nel repo ·
`git log --first-parent main --since=2026-08-06 --until=2026-08-21 | wc -l` → **18** commit, cioè
**17** cambiamenti dopo lo stato di partenza, non dodici.

**Vincoli rispettati** — nessun `git commit`, `git add`, `git push`, `git checkout`. Nessun file
modificato all'infuori di questo. Nessun accesso al database. Nessun dato personale: il documento
cita percorsi, righe di codice, numeri e codici, mai nomi di famiglie o di bambini.
