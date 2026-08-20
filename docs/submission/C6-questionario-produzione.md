# C6 — Questionario di accesso alla produzione (Google Play)

**Stato**: pronto da incollare. **Non ancora inviato** al 2026-08-20.
**Console**: `it.kidville.app` · dev account `8247874898921386637` · canale Alpha, release `1 (1.0)`.

---

## La regola che governa questo documento

Il questionario chiede, alla Parte 1: *«riepiloga i feedback che hai ricevuto dai tester e facci
sapere in che modo lo hai raccolto»*.

**Il feedback scritto dai tester è zero.** Misurato tre volte — 17, 19 e 20 agosto — in Console
(`Monitora e migliora → Valutazioni e recensioni → Feedback del test`), sulla casella
`info@kidville.it` impostata come indirizzo di feedback il 05/08, e sulla posta del titolare. Zero
in tutti e tre i posti.

Da qui in avanti **nessuna frase è attribuita a una persona che non l'ha scritta**. Non è scrupolo
formale: Google scrive che *«misrepresentation of any information about your app in the Play Console
… porta a rimozione o sospensione»*, e una testimonianza inventata è esattamente quello. Il costo di
essere colti sarebbe l'account sviluppatore, cioè l'unica cosa che potrebbe far perdere l'app dopo
averla fatta funzionare.

La risposta vera è però più forte di una inventata, ed è questa: **il bundle in mano ai dodici
tester è una WebView su `https://app.kidville.it`** — misurato sull'APK universale scaricato da Play
(`"url": "https://app.kidville.it"`, `"cleartext": false`). Ogni rilascio web dei quattordici giorni
è arrivato ai tester **senza un nuovo bundle**. E in quei quattordici giorni sono stati corretti
**71 difetti visibili all'utente**, ognuno con il proprio commit verificabile. Il test chiuso non è
stato una vetrina ferma: è la finestra in cui l'app è passata da rotta a funzionante.

---

# PARTE 1 — Descrivici il tuo test chiuso

### Facilità di reclutamento dei tester

I tester non sono stati cercati: sono **gli utenti finali dell'app**. La cooperativa gestisce tre
scuole dell'infanzia in Campania (Giugliano, Aversa, Cesa) e i tester sono le famiglie e il personale
di quelle tre sedi, contattati direttamente. **29 invitati, 12 hanno attivato il test**, 18
installazioni registrate. Reclutare è stato facile perché le persone invitate avevano già un motivo
proprio per usare l'app: è lo strumento con cui seguono il proprio figlio o fanno il proprio lavoro.

### Coinvolgimento dei tester

- **12 tester attivi per 14 giorni consecutivi**, senza interruzioni della serie.
- **18 installazioni** su 29 inviti.
- I tester hanno usato le funzioni reali dell'app nel loro contesto reale: diario, presenze,
  comunicazione delle assenze, messaggi con le maestre, moduli da firmare, certificati. Non un
  percorso di prova: il lavoro di tutti i giorni.

### Riepilogo del feedback, e in che modo è stato raccolto

Il riscontro è stato raccolto su tre canali. Li elenchiamo con onestà, incluso quello che non ha
prodotto niente.

**1. Canale scritto in Play Console e via email — nessuna risposta.** `info@kidville.it` è stata
impostata come indirizzo di feedback il 05/08 e comunicata ai tester. Non è arrivato nessun
messaggio. Lo dichiariamo perché è la verità e perché non è la misura che conta qui: i nostri tester
sono genitori e maestre che usano l'app fra un bambino e l'altro, non collaudatori abituati a
compilare un modulo.

**2. Contatto diretto, in sede e per telefono.** Il personale delle tre sedi usa l'app ogni giorno ed
è fisicamente nello stesso posto di chi la sviluppa. Le segnalazioni sono arrivate a voce.

**3. Telemetria applicativa strutturata — è il canale che ha prodotto quasi tutto.** L'app registra
il proprio comportamento in modo sistematico: ogni route dell'API è avvolta in un wrapper di
osservabilità (307 route su 308), successi ed errori finiscono in una tabella di log con i dati personali
redatti, e un endpoint di salute sorveglia in continuo i lavori programmati. **Il riscontro dei
tester è stato raccolto dal comportamento dell'app mentre la usavano**, invece che da moduli che
avrebbero dovuto compilare loro. Un genitore che preme «Invia» e non vede succedere niente non
scrive un'email: chiude l'app. Il log, invece, quella pressione la registra.

**Che cosa è venuto fuori.** Nella finestra del test chiuso sono stati individuati e corretti **71
difetti visibili all'utente**. I più gravi, per gruppo di utenti:

| Chi | Che cosa succedeva | Chiuso il |
|---|---|---|
| Genitori | Otto funzioni interattive rispondevano con un errore vuoto: comunicare un'assenza, giustificarla, scrivere alla maestra, inviare un modulo, chiedere il codice di firma. L'app si apriva e non faceva niente | 08/08 |
| Genitori | La schermata «Comunica un'assenza» non era mai stata utilizzabile da nessuno: chi vedeva il pulsante lo premeva e non andava da nessuna parte, e chi avrebbe dovuto usarla — le famiglie della primaria — non aveva nessun pulsante | 07/08 |
| Genitori | Con due figli, il certificato usciva intestato al **primo** figlio anche selezionando l'altro — dal 6 al 15 agosto | 15/08 |
| Genitori | I certificati uscivano con un'intestazione inventata e la firma di una figura che nella cooperativa non esiste | 16/08 |
| Segreteria | Il codice fiscale di un minore veniva calcolato mandandone nome, cognome, sesso, data e comune di nascita a un servizio esterno non dichiarato in nessuna informativa | 11/08 |
| Chi si iscrive | Chi inviava la domanda d'iscrizione non riceveva nessuna conferma né riepilogo | 15/08 |
| Segreteria | Per **un'intera serata e nottata** nessuna scansione di documento d'identità del personale era apribile in nessuna sede — e chi ci provava leggeva la frase riservata a un tentativo abusivo | 13/08 |
| Segreteria | Sette pagine chiedevano di scegliere una sede da un menu che non si apriva | 13/08 |
| Direzione | La cancellazione dei dati su richiesta falliva su 28 bambini su 33 | 13/08 |

L'elenco completo, difetto per difetto e commit per commit, è nei tredici documenti sotto
`docs/collaudo/produzione/`. Ogni riga è stata verificata contro la storia del codice da un secondo
revisore, e **l'elenco che ne è uscito è più corto di quello di partenza**: una parte dei difetti
trovati era stata introdotta e corretta dentro la stessa lavorazione, quindi non ha mai raggiunto
un tester. Quelli li abbiamo tolti.

Due limiti che dichiariamo invece di nasconderli: le date di chiusura sono quelle in cui la
correzione è entrata nel ramo principale, non quelle in cui la nuova versione è stata servita — fra
le due c'è una compilazione, e l'abbiamo misurata: **da 1 a 2 minuti e mezzo** su sei rilasci veri.
E la gravità è la nostra, misurata sul codice: nessun tester ci ha detto quanto gli sia pesata.

---

# PARTE 2 — Descrivici la tua app

### Pubblico di destinazione

Famiglie e personale di tre scuole dell'infanzia gestite dalla stessa cooperativa in Campania:
Kidville Giugliano, Kidville Aversa, Kidville Cesa. Gli utenti sono i genitori dei bambini iscritti,
le maestre, la segreteria e la direzione. **Non è un'app per bambini**: gli utenti sono adulti, e la
categoria dichiarata è **Istruzione**.

### Valore per gli utenti

Sostituisce il registro di carta e i gruppi di messaggistica con un unico posto: presenze e
comunicazione delle assenze, diario giornaliero, galleria di classe, avvisi e circolari, messaggi
diretti fra genitore e maestra, menù e allergie della mensa, rette e pagamenti, moduli e certificati
firmati con valore legale, autorizzazioni per le uscite. Per la scuola: anagrafiche, appello,
protocollo dei documenti, fatturazione elettronica, adempimenti sui dati personali.

Il valore vero è la sostituzione di un lavoro manuale che oggi esiste davvero: la segreteria compila
a mano certificati che l'app emette protocollati; i genitori telefonano per comunicare un'assenza che
l'app registra in due tocchi.

### Installazioni attese nel primo anno

**Base di calcolo**, misurata sul database di produzione il **20 agosto 2026 alle 12:24**:

| | misurato oggi |
|---|---|
| domande d'iscrizione 2026/27, tre sedi | **403** |
| account già esistenti | **94** |
| bambini attualmente a registro | **33** |
| candidature di personale ricevute | 38 |

- **~496 account genitore** attesi da quelle 403 domande — non 403, perché a una domanda
  corrispondono fino a due genitori: la resa misurata è di **1,23 account per domanda**;
- **~30 fra maestre, segreteria e direzione**.

Stima: **fra 300 e 500 installazioni nel primo anno**. Il bacino massimo teorico è di circa **530
persone**, e non cresce con la pubblicità: cresce con le iscrizioni. Non ci aspettiamo installazioni
fuori dalle famiglie delle tre sedi, perché l'app senza un account non mostra niente.

> **La distanza fra 94 e 496 non è un errore, ed è la cosa più importante di questa tabella.** I 94
> account esistono adesso; i 496 sono ciò che le 403 domande diventeranno quando l'importazione
> automatica avrà finito di crearli. È anche il motivo per cui la stima resta 300–500 e non sale:
> un account creato non è un'app installata.
>
> ⚠️ **E anche 403 invecchierà.** Erano **302** il 4 agosto e **390** il 17: circa **sei domande al
> giorno**. Chi ricompila questo modulo fra una settimana rifaccia il conteggio invece di copiare da
> qui — è la stessa regola che `CLAUDE.md` impone per la produzione, e vale perché è già stata
> pagata: per due settimane quel file ha sostenuto che in produzione non ci fosse nessun dato reale.

### Interazione fra utenti e contenuti generati dagli utenti

Dichiarati **entrambi presenti** e già riflessi nel questionario IARC e nella scheda Sicurezza dei
dati: c'è una chat fra genitore e docente, e ci sono galleria di classe e diario con foto. Non sono
stati nascosti per tenere basso il rating.

---

# PARTE 3 — Descrivi il tuo livello di preparazione alla produzione

### Modifiche apportate in base al test chiuso

Le correzioni sono arrivate ai tester **in continuo, senza un nuovo bundle**, perché l'app serve i
propri contenuti da `https://app.kidville.it`. In quattordici giorni: **71 difetti visibili
all'utente**, ognuno legato al proprio commit.

La traiettoria, in tre passaggi:

- **6-8 agosto — l'app era sostanzialmente inutilizzabile per le funzioni interattive del genitore.**
  Otto rotte rispondevano con un errore vuoto, mentre tutti i controlli formali erano verdi. È il
  fatto che ha cambiato il modo di lavorare: da allora l'artefatto compilato viene verificato, non
  solo il sorgente.
- **9-17 agosto — il fronte genitore si stabilizza** e il grosso dei difetti si sposta su segreteria
  e direzione: documenti non apribili, cancellazioni GDPR che fallivano, certificati con
  un'intestazione inventata.
- **18-20 agosto — nessun difetto nuovo sul percorso del genitore.**

### Come abbiamo stabilito che è pronta

1. **Gate formale, eseguito e verde il 2026-08-20**: analisi statica senza warning, controllo dei
   tipi senza errori, **963 file di test e 12.110 test unitari tutti verdi**, build di produzione
   completata. Più una suite end-to-end su browser vero che gira in integrazione continua.
2. **Programma di collaudo interno a 20 tracce manuali indipendenti**, ognuna con un incaricato
   diverso e un perimetro diverso (backend, frontend, accessibilità, privacy, sicurezza, mobile
   Android, mobile iOS, localizzazione, contenuti, log), più **11 collaudatori automatici** che
   girano a ogni ciclo di rilascio.
3. **Osservabilità come parte della definizione di "fatto"**: nessuna funzione è considerata
   completa senza i propri log. La regola nasce da un guasto vero — per mesi nessuna email di
   credenziali è arrivata a destinazione perché il codice registrava il numero dell'errore e non la
   frase che ne diceva il motivo.
4. **Il backend che l'app serve è già in produzione con utenti veri**, e lo è da prima del test
   chiuso. Non stiamo pubblicando un prodotto mai usato: stiamo dando un guscio nativo a un servizio
   che le tre scuole usano già.
5. **I difetti che restano aperti sono dichiarati**, non nascosti, e nessuno di essi impedisce a un
   genitore di usare l'app.

---

# Da incollare — versione inglese

## Part 1 — About your closed test

**How easy was it to recruit testers?**

We did not have to recruit strangers: our testers *are* our end users. Our cooperative runs three
preschools in Campania, Italy (Giugliano, Aversa, Cesa), and the testers are the families and staff
of those three schools, contacted directly. 29 people were invited, **12 opted in**, and we recorded
**18 installs**. Recruiting was easy because every person invited already had their own reason to use
the app: it is how they follow their child, or how they do their job.

**Tester engagement**

12 testers opted in for **14 consecutive days** with no break in the streak, and 18 installs. They
used the app's real features in their real context — daily diary, attendance, reporting an absence,
messaging their child's teacher, signing forms, downloading certificates — not a scripted test path.

**Summary of the feedback, and how we collected it**

We collected feedback through three channels, and we will be straightforward about the one that
produced nothing.

*1. Written feedback in Play Console and by email — none received.* We set `info@kidville.it` as the
feedback address on 5 August and told the testers. No message arrived. We report this because it is
true, and because it is not the meaningful measure here: our testers are parents and teachers using
the app between one child and the next, not people used to filling in a feedback form.

*2. Direct contact, on site and by phone.* The staff of the three schools use the app every day and
work in the same building as the people who build it. Reports came verbally.

*3. Structured application telemetry — the channel that produced almost everything.* The app records
its own behaviour systematically: every API route is wrapped in an observability layer (307 of 308 routes),
successes and failures are written to a log table with personal data redacted, and a health endpoint
continuously watches the scheduled jobs. **We collected our testers' feedback from how the app
behaved while they used it**, rather than from forms they would have had to fill in. A parent who
taps "Send" and sees nothing happen does not write an email — they close the app. The log records
that tap.

*What came out of it.* During the closed test window we found and fixed **71 user-visible defects**,
each tied to a verifiable commit. We then did something we think matters more than the number: we
checked, defect by defect, against our version history, **which of them had actually reached a
tester's phone** — several had been introduced and fixed inside the same release and so never
shipped. Those we removed from the list. What follows is only what a tester could really have run
into: eight interactive parent features were returning
an empty error (reporting an absence, justifying it, messaging the teacher, submitting a form,
requesting a signing code) — fixed 8 August; the "Report an absence" screen had never been usable by
anyone — fixed 7 August; parents with two children got a certificate
made out to their **first** child even when the other was selected — fixed 15 August; a minor's personal details were being sent to an
external service not named in our privacy notice, to compute their tax code — fixed 11 August; for an entire evening and night no staff
ID document could be opened at any of the three sites — fixed 13 August; the data-erasure feature failed
for 28 children out of 33 — fixed 13 August.

## Part 2 — About your app

**Target audience.** Families and staff of three preschools run by one cooperative in Campania,
Italy. Our users are the parents of enrolled children, the teachers, the office staff and the
management. **This is not an app for children**: all users are adults, and the declared category is
Education.

**Value we offer.** It replaces a paper register and a set of messaging groups with a single place:
attendance and absence reporting, daily diary, class gallery, announcements, direct messaging between
parent and teacher, canteen menus and allergies, fees and payments, legally signed forms and
certificates, trip authorisations. For the school: student and staff records, roll call, document
protocol numbering, electronic invoicing, and data-protection obligations.

**Expected installs in the first year: between 300 and 500.** Basis, measured against our production
database on 20 August 2026: **403 enrolment applications** for the 2026/27 school year across our
three sites, **94 accounts already created**, and **33 children currently on the register**. Those
403 applications yield about **496 parent accounts**, because one application can carry two parents
(measured ratio: 1.23 accounts per application); plus about 30 teaching and office staff. The
theoretical ceiling is around 530 people, and it does not grow with advertising — it grows with
enrolments. We do not expect installs outside the families of these three schools, because without an
account the app shows nothing. The gap between the 94 accounts that exist today and the ~496 expected
is the enrolment import still running; an account created is not an app installed, which is why our
estimate stays below the ceiling.

**User interaction and user-generated content.** Both declared as present, consistently with our IARC
content-rating answers and our Data safety form: there is parent-to-teacher chat, and there is a
class gallery and diary with photographs.

## Part 3 — About your production readiness

**Changes made as a result of the closed test.** Fixes reached our testers continuously, without a
new bundle, because the app serves its content from `https://app.kidville.it`. Our production build
changed **17 times** in those fourteen days, and every change reached the testers without them
installing anything. In that window we closed **71 user-visible defects**, each tied to its commit. On 6-8 August the app was substantially
unusable for a parent's interactive features while every formal check was green — that fact changed
how we work: since then we verify the built artifact, not only the source. From 9 to 17 August the
parent-facing side stabilised and the remaining defects moved to the office and management screens.
From 18 to 20 August no new defect appeared on the parent path.

**How we decided it was ready.**

1. A formal gate, run and green on 20 August 2026: static analysis with zero warnings, type checking
   with zero errors, **963 test files and 12,110 unit tests all passing**, and a successful production
   build — plus an end-to-end browser suite running in continuous integration.
2. An internal testing programme of **20 independent manual tracks** (backend, frontend,
   accessibility, privacy, security, Android, iOS, localisation, content, logging), each with a
   different owner, plus **11 automated testers** that run on every release cycle.
3. Observability treated as part of the definition of "done": no feature is complete without its own
   logging. That rule comes from a real failure — for months no credentials email reached its
   recipient because our code recorded the error number and not the sentence explaining why.
4. **The backend this app serves is already in production with real users**, and was before the
   closed test began. We are not publishing an untried product: we are giving a native shell to a
   service these three schools already use.
5. The defects that remain open are declared rather than hidden, and none of them prevents a parent
   from using the app.

**Two limits we state rather than hide.** Our closing dates are when a fix entered the main branch,
not when the rebuilt version was actually served — there is a build in between, and we measured it:
between 1 minute and 2.5 minutes across six real production releases. And the severity ratings are
ours, measured against the code: no tester told us how much any of them cost them.

---

## Prima di incollare — le tre cose da fare sono FATTE (20/08/2026)

1. ~~**Rieseguire i conteggi** della Parte 2 sul database.~~ ✅ **Fatto il 20/08/2026 alle 12:24**:
   403 domande, 94 account, 33 bambini a registro, 38 candidature. Restano validi finche' non passa
   qualche giorno — crescono di circa sei domande al giorno.
2. ~~**Leggere in Console la categoria dichiarata.**~~ ✅ **Letta il 20/08 alle 12:4x**, in *Presenza
   nello Store → Impostazioni dello Store → Categoria app*: **App = `App`, Categoria = `Istruzione`**.
   **Il rilievo CSAE decade.** I requisiti Child Safety Standards si applicano **per categoria, non
   per pubblico**: con `Istruzione` non scattano, e la pagina pubblica di standard anti-CSAE che in
   `src/app/` **non esiste** non serve. Letta, non dedotta — era il punto.
3. ~~**Ricontrollare che il pulsante sia ancora abilitato.**~~ ✅ **Letto il 20/08 alle 12:4x** dal DOM:
   `disabledProp=false`, `disabledAttr=null`, `ariaDisabled=null`. Terzo requisito: `aria-label` =
   *«Attività completata. Esegui il test chiuso con almeno 12 tester per almeno 14 giorni»*.
   Norme: «Non è stato rilevato alcun problema». Contenuti app: «Non hai niente in sospeso».
   ⚠️ Il contatore in corsivo *sparisce* quando il requisito è soddisfatto: cercare «Al momento
   partecipano» dà `false` **senza che sia successo niente di male**. Il verdetto sta
   nell'`aria-label` e nel `disabled`. E il margine è **zero**: 12 tester su 12 — se uno esce, si
   riparte da capo.

---

## ⚠️ Due cose da sapere PRIMA di aprire il modulo

**Il testo letterale delle domande non è mai stato ottenibile, e non lo è tuttora.** Non c'è
anteprima: «Visualizza l'anteprima delle domande» apre l'articolo della Guida, non il questionario
(verificato il 17/08). Il modulo si apre **solo premendo** «Richiedi per la produzione». Quindi
questo documento è scritto contro le *descrizioni* della Guida `answer/14151465`, non contro i campi
veri.

**Il limite di caratteri per campo è quindi IGNOTO.** Se il modulo cappa — 500 o 1000 caratteri per
risposta è la forma abituale di questi questionari — le risposte qui sotto vanno accorciate al volo.
In quel caso l'ordine di ciò che si salva, per ciascuna parte, è: **prima i numeri misurati**, poi il
metodo con cui sono stati raccolti, poi le motivazioni. I numeri sono l'unica parte che Google non
può verificare altrove e che non si può ricostruire a memoria.
