# Inventario dei difetti corretti fra il 6 e il 20 agosto 2026

**Fonte unica** per i dodici documenti `impatto-profilo-NN-*.md`. Ogni riga ha un commit a supporto.

## Tre fatti che decidono cosa un tester poteva vedere

1. **L'app Android è una WebView su `https://app.kidville.it`.** Misurato sull'APK universale
   scaricato da Play il 17/08: `"url": "https://app.kidville.it"`, `"cleartext": false`. Il sospetto
   che puntasse a `10.0.2.2:3100` è **caduto** — quel valore stava solo nel ramo *debug*.
   Conseguenza: ogni deploy web è arrivato ai dodici tester senza un nuovo bundle.
2. **La produzione gira `main`.** Tutti i commit fino a `b87ee964` (17/08) sono su `main`. Tutto il
   lavoro del **19-20 agosto è solo su `feat/candidature-multisede` e NON è in produzione** — con
   **una sola eccezione**, la RLS mancante (§C.1), perché quelle migrazioni sono state applicate
   direttamente al database di produzione.
3. **I report in `docs/collaudo/risultati/` sono del 3-5 agosto**, quindi *precedono* la finestra.
   Non aggiungono difetti: sono il metodo che ha prodotto i cicli di correzione del 7-8 agosto.

## ⚠️ La regola che vale per OGNI riga: lo squash

Aggiunta il 2026-08-20, dopo che **cinque agenti indipendenti** l'hanno scoperta da soli.

I commit su `main` sono **squash merge**: `git rev-list --parents -n 1 <hash>` dà **un solo
genitore**.

E la produzione è cambiata **17 volte**, non di continuo. Misurato il 2026-08-20:

```
git log --first-parent main --since=2026-08-06 --until=2026-08-21   →  18 commit
```

diciotto commit, di cui il primo (`29da34b4`, **6/08 17:52**) è lo stato di partenza: quindi
**diciassette cambiamenti**. Il primo dopo il 6 agosto è **l'8 alle 22:54** (`f59854ab`), l'ultimo è
il **17 agosto all'01:35** (`b87ee964`). Fra il 6 e l'8 i tester hanno usato **una sola versione**, e
**dal 18 al 20 agosto la produzione non è più cambiata**.

⚠️ Il numero «16» che circolava fra i primi documenti di profilo è sbagliato: contarli è un comando,
non un ricordo.

Conseguenza, e non è un dettaglio: **un difetto introdotto e corretto dentro la stessa lavorazione
in produzione non è mai esistito.** Le date della colonna «Finestra» qui sotto vengono dai messaggi
di commit e descrivono spesso il *lavoro*, non la *produzione*. Prima di scrivere che un tester ha
incontrato qualcosa, si stabilisce quando la forma difettosa è arrivata su `main` e quando ne è
uscita — con `git show <hash>^:<file>`, non con la prosa del commit.

Questo **accorcia** l'elenco. È il motivo per cui l'elenco è difendibile.

## ⚠️ La seconda regola: fra il commit e la pagina servita c'è una build

Aggiunta il 2026-08-20, su rilievo di un revisore, e vale per **ogni** riga di **ogni** documento.

Le ore della colonna «Finestra» sono **timbri di commit git**, non l'istante in cui il deploy è
diventato servibile su `app.kidville.it`. Fra il merge su `main` e la pagina che un tester apre col
telefono c'è una build di Vercel, e nessuno di questi documenti l'ha misurata.

Conseguenza, e va nella direzione scomoda: **ogni guasto è durato un po' PIÙ di quanto scritto**, e
ogni chiusura è anticipata.

🔻 **Non è più un'incognita: è stata misurata il 2026-08-20.** Sei rilasci di produzione letti da
Vercel (`repoPushedAt` contro `ready`, tutti `target: production`, `READY`, alias
`app.kidville.it`): il ritardo va da **1 minuto e 1 secondo a 2 minuti e 29 secondi**. Quindi lo
scarto è reale ma piccolo, e non cambia nessuna conclusione di questi documenti — cambia solo che
adesso lo sappiamo invece di dichiararlo ignoto. La misura completa sta in
`impatto-profilo-09-segreteria-giugliano.md`.

Un secondo caso della stessa famiglia: i timbri delle **migrazioni** (`20260812194501`) non dicono
il fuso. Se sono UTC, un'applicazione «delle 19:45» è in realtà delle 21:45 italiane, e la finestra
di un guasto si accorcia di due ore. Le due letture restano entrambe possibili: l'incertezza è di
**due ore, non di un minuto**.

## Cosa è ammesso in un documento di profilo

Ammesso: sintomi della **PARTE A**, visibili a schermo dentro l'app.
**Escluso**: tutta la **PARTE B** (cron, email, fatturazione, log, migrazioni, console degli store) —
reale, corretto, ma invisibile a un tester dell'app. Ed esclusa la **PARTE C.2**, che è lavoro di
branch mai arrivato in produzione.

---

# PARTE A — Difetti visibili a un tester dell'app Android

## A.1 — GENITORE

| # | Sintomo utente | Grav. | Finestra | Commit |
|---|---|---|---|---|
| 1 | Premo un pulsante e non succede niente, o compare un errore generico. **Otto rotte rispondevano 500 con corpo vuoto a TUTTI i genitori non sospesi**: comunicare un'assenza (POST e DELETE), giustificarla, **scrivere alla maestra**, inviare un modulo, chiedere l'OTP, rispondere a un avviso. Turbopack compilava il ramo `: null` di un ternario nella stringa `"TURBOPACK unreachable"`. Il sorgente era corretto: il difetto era nell'artefatto | bloccante | ≥29/07 → **08/08 22:54** | `f59854ab` |
| 2 | **«Comunica un'assenza» non era mai stata utilizzabile da nessuno.** La dashboard mostrava il pulsante solo ai non-primaria e la route rispondeva 403 «Disponibile solo per la scuola primaria»: chi vedeva il pulsante prendeva un errore garantito (20 famiglie su 32); i 12 di primaria non avevano nessun pulsante. Prova: 0 notifiche `assenza_comunicata` da sempre | bloccante | sempre → **07/08** | `f59854ab` |
| 3 | Tocco «Comunica assenza» e mi ritrovo sul Diario. Il pulsante d'invio era coperto al 100% dalla barra di navigazione. Misurato: `page.mouse.click(112, 823)` → `/parent/diary` | bloccante | ≤06/08 → **08/08** | `f59854ab` |
| 4 | Tocco «Leggi l'informativa» e **parte la comunicazione dell'assenza**. Su WebView 390×731 `elementFromPoint` sul centro del link restituiva il PULSANTE. Riprodotto con `adb shell input tap` | bloccante | ≤07/08 → **08/08** | `f59854ab` |
| 5 | Tocco il campo «Motivo» dove lo vedo e finisco sul pulsante che invia. Su telefoni 640-731 px il campo finiva sotto il piede. La leva era la **testata**, alta ~360 px su un modulo di due campi (→ 109 px) | bloccante | 08/08 → **09/08 00:38** | `7ef10e87` |
| 6 | Premo Invia, la schermata non cambia di un pixel, ripremo. Il messaggio di rifiuto nasceva **dietro** il piede appiccicato. Chi usa lo screen reader lo sentiva, chi vede no | bloccante | 07/08 → **08/08** | `f59854ab` |
| 7 | Dopo l'elenco delle assenze la pagina continua a scorrere su una schermata e mezza di nulla. Documento 2147 px, contenuto fino a 754 | fastidioso | 08/08 → **08/08** | `f59854ab` |
| 8 | Apro la tastiera sul «Motivo» e la barra verde sparisce, il testo risale nella fascia della Dynamic Island | fastidioso | ≤07/08 → **08/08** | `f59854ab` |
| 9 | **Comunicando un'assenza il genitore sovrascriveva l'appello già fatto dalla maestra** quel giorno. Trovato da tre tester per tre strade diverse | bloccante | ≤07/08 → **07-08/08** | `f59854ab` |
| 10 | Annullando un'assenza si cancellava dal registro **una presenza di qualunque giorno passato** (il DELETE non guardava la data) | bloccante | ≤07/08 → **07/08** | `f59854ab` |
| 11 | Ricomunicando lo stesso giorno, il motivo — dato sanitario del minore — veniva sovrascritto in silenzio; mandando il campo vuoto veniva azzerato. Su due porte gemelle | bloccante | ≤07/08 → **08/08** | `f59854ab` |
| 12 | L'app diceva di aver tolto il motivo e non lo toglieva | fastidioso | 07/08 → **08/08** | `f59854ab` |
| 13 | `/parent/primaria/assenze` restava su «Caricamento…» per sempre; e un errore di lettura si mostrava come **«nessuna assenza»** | bloccante | ≤07/08 → **08/08** | `f59854ab` |
| 14 | Il pulsante primario, mentre si aspetta, era illeggibile: **contrasto 1,20:1** (→ 5,75:1) | fastidioso | ≤07/08 → **08/08** | `f59854ab` |
| 15 | Con l'Alto Contrasto acceso i due campi erano **bianchi su bianco**. Più: conferma non annunciata, due frasi a 2,51:1 (→ 6,46:1), il formato `gg/mm/aaaa` che spariva digitando | bloccante (HC) | ≤07/08 → **07-08/08** | `f59854ab` |
| 16 | Con il telefono in inglese si leggeva **«Value must be … or later» dentro un'app italiana**, in una bolla di sistema. E su iOS il calendario lasciava scegliere ieri malgrado `min` | fastidioso | ≤07/08 → **08/08** | `f59854ab` |
| 17 | Il calendario iOS **si apriva da solo** appena la schermata prendeva il fuoco (2.759 righe `_UICalendarDateViewCell`) | fastidioso | ciclo 2 → **07/08** | `f59854ab` |
| 18 | Una data malformata dal database faceva **cadere l'intera schermata**. Più: la stessa data in due formati nella stessa schermata, e senza anno nell'elenco storico | bloccante | ≤07/08 → **08/08** | `f59854ab` |
| 19 | Chi ha **un figlio per grado** vedeva due prodotti diversi: 20 divergenze su 16 coppie di stringhe fra 0-6 e primaria, e solo una delle due diceva fino a quando si può ritirare un'assenza | fastidioso | ≤07/08 → **08/08** | `f59854ab` |
| 20 | Un chunk mancante lasciava l'utente su **«Caricamento…» per sempre**, senza messaggio e senza bottone. `ChunkErrorBoundary` esisteva dal 03/08 con 11 test verdi e **non era importato da nessun file** | bloccante | 03/08 → **15/08 00:25** | `0e8480a3` |
| 21 | **Con due figli, il genitore firmava il certificato per il bambino sbagliato**: il tab «Certificati» usava sempre `children[0]` | bloccante | ≤14/08 → **15/08** | `0e8480a3` |
| 22 | Il certificato scaricato portava **una banda verde inventata, «KIDVILLE SCHOOLS», l'indirizzo stampato due volte e la firma di un «Dirigente Scolastico» che in una cooperativa non esiste** | bloccante | 15/08 → **16/08 11:31** | `0974424a` |
| 23 | Il certificato protocollato usciva di **due pagine**, la seconda con la sola firma e tredici centimetri di vuoto; il numero di protocollo stampato due volte a 18 mm | fastidioso | 15-16/08 → **16/08** | `0974424a` |
| 24 | **Il modulo di autorizzazione alla gita non compariva mai**, nemmeno quando la gita c'era; e quando usciva aveva «Orario partenza» e «Rientro previsto» vuoti. La notifica apriva `/parent` invece del modulo | bloccante | ≤15/08 → **16/08** | `0974424a` |
| 25 | Ogni «Scarica il certificato» fra le 00:00 e le 02:00 del 1° agosto **riemetteva invece di riusare** — un numero WORM bruciato a ogni clic — e stampava l'**anno scolastico sbagliato** | bloccante | preesist. → **16/08** | `0974424a` |
| 26 | Chi compilava e inviava il modulo pubblico d'iscrizione **non riceveva niente**: nessuna conferma, nessun riepilogo. 387 domande registrate, 381 con email valida = 381 ricevute mai partite | bloccante | preesist. → **15/08 02:48** | `b43a556e` |

> Il canale del n. 26 è email, ma il **sintomo** — «ho mandato la domanda e non è arrivato niente» —
> un genitore-tester lo vive dentro l'app. Ammesso, purché descritto così.
>
> 🔻 **CORRETTO il 2026-08-20**: la formulazione originale diceva «e firmava con l'OTP». **Falso.**
> Il wizard pubblico non ha nessuna firma OTP — `grep -nE "otp|OTP|firma"` su `EnrollmentWizard.tsx`
> al commit precedente dà **zero**, e `src/app/api/forms/send-otp/route.ts` importa `requireUser`:
> per firmare serve un account, che chi si iscrive non ha ancora.

## A.2 — DOCENTE

| # | Sintomo utente | Grav. | Finestra | Commit |
|---|---|---|---|---|
| 27 | L'app diceva alla maestra **«Alunno non trovato»** quando era la lettura del database ad essere fallita. Una delle quattro negava l'accesso al docente giusto travestendo un guasto da «nessuna sezione assegnata» | bloccante | ≤07/08 → **08/08** | `f59854ab` |
| 28 | Al browser del docente (e di segreteria e Direzione) arrivavano **il motivo sanitario del minore, la nota d'appello e `giustificazione_firma` con email, IP e user-agent** del genitore. `select *` su tre rotte; in due finiva anche in `audit_scritture_docente`, conservato per anni | bloccante | ≤07/08 → **07-08/08** | `f59854ab` |
| 29 | Il registro contava come «passata» un'assenza **futura**, e il cruscotto interrogava il giorno sbagliato fra mezzanotte e le 02:00 (UTC invece di Europe/Rome) | fastidioso | ≤07/08 → **08/08** | `f59854ab` |
| 30 | La data nell'unica notifica prodotta per il docente era **ISO grezza** (`2026-08-09T…Z`) | cosmetico | ≤07/08 → **07/08** | `f59854ab` |
| 31 | Nelle schermate uscite/gite il docente leggeva **12 messaggi d'errore che in app inglese restavano muti** (frasi italiane nude, senza codice) | fastidioso | preesist. → **15/08** | `0e8480a3` |
| 32 | La barra dei docenti era **disallineata di 2 px** rispetto a quella dei genitori (latente) | cosmetico | 08/08 → **08/08** | `f59854ab` |
| 33 | **Un genitore innocente veniva accusato**: `require-parent` trasformava un guasto di lettura in un 403 «questo non è tuo figlio» e accendeva il contatore IDOR contro una famiglia che non aveva fatto niente. Gate di 20 rotte | bloccante | ≤07/08 → **08/08** | `f59854ab` |

## A.3 — SEGRETERIA / DIREZIONE

| # | Sintomo utente | Grav. | Finestra | Commit |
|---|---|---|---|---|
| 34 | **Nessuna scansione di documento d'identità del personale era più apribile, in nessuna delle tre sedi**, e chi ci provava leggeva «non esiste, oppure appartiene a un'altra sede» — la risposta di un tentativo abusivo. Nessun test era rosso: i finti tenevano in vita la colonna vecchia | bloccante | **12/08 → 13/08 02:24** | `d7af75b6` |
| 35 | **503 su ogni apertura di fascicolo del personale** | bloccante | 12/08 → 13/08 | `d7af75b6` |
| 36 | Il cruscotto Scadenze diceva che la scansione non c'era, **mentre nel bucket c'era** — con `ok: true` e nessun errore | fastidioso | 12/08 → 13/08 | `d7af75b6` |
| 37 | **Sette pagine mostravano «Hai più sedi attive. Scegline una sola dal menu in alto» — e quel menu non si montava affatto.** Un guasto di rete diventava un'istruzione impossibile su contabilità, news, mensa, modulistica, primaria, impostazioni e SIDI, senza una riga di log. E la potatura del cookie cancellava la sede già scelta | bloccante | preesist. → **13/08** | `d7af75b6` |
| 38 | **«Elimina Alunno (GDPR)» falliva su 28 bambini su 33** con un 409 tecnico. Tre tentativi veri il 12/08 → `23503`. Il bottone era una promessa che il database non poteva mantenere | bloccante | preesist. → **13/08** | `d7af75b6` |
| 39 | Si confermava un'anonimizzazione **irreversibile** leggendo «file da rimuovere: 3» — dentro c'erano **pagelle e certificati medici** che nessuna riga nominava. Se il dry-run falliva l'avviso tornava muto e **il bottone rosso restava attivo**. E nell'altro pannello si leggevano i numeri **di un bambino diverso** | bloccante | preesist. → **13/08** | `d7af75b6` |
| 40 | **La scheda del genitore non salvava niente.** Ogni «Salva» falliva. Prova: 255 `update` riusciti dal 5 luglio e **zero** con `entita_tipo='genitori'` | bloccante | dal 05/07 → **11/08 10:16** | `a9dcc6d8` |
| 41 | I prestampati firmati dalla Scuola rifiutavano di uscire dicendo «aggiungilo nelle impostazioni della sede» — **e nelle impostazioni non c'era niente da aggiungere**. Peggio: `legale_rappresentante` veniva **cancellata al primo salvataggio**. E `/admin/schools` non era in nessun menu | bloccante | 14/08 → **15/08 12:12** | `0e0ba538` |
| 42 | La segreteria trascinava la carta intestata nel tab «Template Certificati ODT», leggeva «📄 documento.odt caricato», e **al primo aggiornamento spariva tutto**: i tre `onChange` salvavano solo il nome del file in uno `useState` | bloccante | preesist. → **16/08** | `0974424a` |
| 43 | Il pannello **«Sala d'Attesa» era irraggiungibile da mesi** | fastidioso | mesi → **16/08** | `0974424a` |
| 44 | Una pratica del personale ferma in `in_approvazione` **non aveva nessuna uscita**: tre comandi spenti su tre, mentre il server accettava «rifiuta» | bloccante | 12/08 → **12/08 07:09** | `65e3631c` |
| 45 | Il pannello Sede & Intestazione **riscriveva sopra ciò che si stava digitando** | bloccante | 15/08 → 15/08 | `0e0ba538` |
| 46 | Premendo «Carica il fronte» e incappando in un 503 si leggeva **la frase di un'altra schermata**. In nessun caso la sola notizia che contava: il documento non è stato archiviato | bloccante | 13/08 → **13/08** | `d7af75b6` |
| 47 | **«Prendo in considerazione questa candidatura» consegnava nello stesso clic le chiavi del registro di 33 minori**: creava un account `educator` e ne spediva la password a un indirizzo arrivato da un modulo pubblico anonimo. Mentre approvare l'anagrafica vera **non spediva niente** e mostrava la password in un riquadro che chiudendosi se la portava via | bloccante | 11/08 → **15/08 19:23** | `fcc51fc8` |
| 48 | Approvare **una cuoca** avrebbe creato un account `educator` che legge l'anagrafica dei bambini | bloccante | 15/08 → **15/08** | `b43a556e` |
| 49 | La Segreteria di una sede poteva farsi firmare **il curriculum di chi si era proposto a un'altra** | bloccante | preesist. → **15/08 02:48**; riaperta 19/08 → **20/08** | `b43a556e`, `aa048978` |
| 50 | **Una spunta sbagliata su un modulo pubblico e anonimo dava a qualcuno l'elenco delle classi di primaria — cioè i bambini.** `utenti.gradi` è uno scope di autorizzazione, e arrivava da una casella del form, applicata anche a un account preesistente. Misurato: HTTP 200 e in tabella `["primaria"]` | bloccante | 12/08 → **12/08** | `65e3631c` |
| 51 | `POST /api/admin/adults`: irraggiungibile, rotta (lasciava account orfani), e **pericolosa** — `role` era `z.string()` libero sotto `requireStaff`: la segreteria si sarebbe potuta creare un `admin` | bloccante (latente) | mesi → **11-12/08** | `a9dcc6d8`, `65e3631c` |
| 52 | Il certificato per il Bonus Nido era **irrilasciabile proprio alla famiglia sospesa per morosità** — che è quella che lo chiede | fastidioso | preesist. → **15/08** | `0e8480a3` |
| 53 | Il registro presenze **tagliava i nomi dei bambini a metà parola**, senza puntini e senza avviso, su un documento che serve a dire chi era presente | bloccante | 15-16/08 → **16/08** | `0974424a` |
| 54 | La ricevuta di firma stampava sul foglio **l'email del firmatario, il suo IP e l'intero User-Agent**; e l'istante della firma usciva in ISO UTC, due ore fuori | bloccante | preesist. → **16/08** | `0974424a` |
| 55 | Tre fogli di carta intestata — marchio, filigrana, P.IVA, le tre sedi — **spediti a un fornitore, consegnati a una famiglia, allegati a un ente, con sopra due righe di conteggio**. Sul certificato protocollato la pagina della firma non portava una parola dell'atto. Più: registro senza intestazione dalla pagina 2, banda bianca che cancellava la filigrana, titolo che cadeva sulle lettere, indirizzo stampato sopra la parola «Kidville» | bloccante | 15-16/08 → **16/08 11:31** | `0974424a` |
| 56 | Salvare l'anagrafica di sede **rispondeva 400**: il tetto di 20 caratteri sul codice meccanografico era tarato su UN codice, e Giugliano e Cesa ne hanno due (23 caratteri) | fastidioso | 15/08 → **16/08** | `0974424a` |
| 57 | Chi caricava la scansione della propria carta d'identità e chiudeva la pagina **lasciava la foto nel bucket senza nome e senza nessuna riga che la nominasse**: invisibile alla conservazione e non cancellabile su richiesta | bloccante | 12/08 → **12/08**, 13/08 | `65e3631c`, `d7af75b6` |
| 58 | Il gate di forma sul percorso del documento **non veniva mai eseguito** | bloccante | 12/08 → **13/08** | `d7af75b6` |
| 59 | `/anagrafica-personale` chiedeva **una sola faccia** del documento, e la tabella era vuota: 0 righe, 12 `educator` senza scheda | fastidioso | 12/08 → **13/08** | `d7af75b6` |
| 60 | Le caselle di consenso avevano **la label che inglobava l'intero corpo dell'informativa** — anche sui due wizard già in produzione, proprio dove la volontà dev'essere inequivocabile | fastidioso | preesist. → **12/08** | `65e3631c` |

## A.4 — PUBBLICO

> 🔻 **CORRETTO il 2026-08-20, dopo la revisione.** Questa sezione aveva un'intestazione unica —
> «`/lavora-con-noi`, `/iscrizione`» — come se fosse una superficie sola. **Non lo è**, e l'errore ha
> fatto arrivare due profili a conclusioni opposte sugli stessi numeri prima che il revisore
> stabilisse che avevano ragione entrambi.
>
> **`/lavora-con-noi` non esisteva in produzione prima dell'11/08 alle 10:16.**
> `git log --all --diff-filter=A --follow -- src/app/lavora-con-noi/page.tsx` dà **una sola riga**,
> `a9dcc6d8`, e lo stesso vale per il wizard, le rotte e la prima migrazione. Riscontro indipendente
> in `public/sw.js:174`. Quindi i n. **62, 63, 67, 70, 71** sono nati e morti dentro il commit che ha
> pubblicato il modulo: **in produzione non ci sono mai stati.**
>
> I n. **64 e 65** invece sono veri, ma su **`/iscrizione`**: vivono in `FieldRenderer`, il componente
> condiviso, dal 30/05, e sono stati corretti nello stesso squash che pubblicava «Lavora con noi» —
> che perciò è nato già sano. Il n. **66** non è nemmeno condiviso: sta in `EnrollmentWizard.tsx`.
>
> Le finestre «10/08 → 11/08» scritte qui sotto sono **giorni di sviluppo**, non di produzione.

| # | Sintomo utente | Grav. | Finestra | Commit |
|---|---|---|---|---|
| ~~61~~ | 🔻 **SPOSTATO IN A.3 — SEGRETERIA.** Il codice fiscale di un MINORE veniva mandato a un fornitore esterno non dichiarato in nessuna informativa — ma **non dal modulo pubblico**: `git grep -l -E "fiscalCodeApi\|codicefiscale\.it" a9dcc6d8^ -- 'src/*'` dà quattro percorsi, tre dei quali sono moduli di `admin/` e il quarto è la libreria stessa. La catena a schermo porta a `/admin/students/new`, cioè alla **segreteria**. Sul modulo pubblico il codice fiscale è un campo che si digita. Verificato indipendentemente da tre agenti | bloccante | preesist. → **11/08 10:16** | `a9dcc6d8` |
| 62 | **Il riepilogo finale non riepilogava**: l'ultimo passo si chiamava «Controlla e invia» e mostrava due fatti su tredici campi. L'email non veniva mai riletta: un refuso e la candidatura è persa senza che nessuno lo sappia | bloccante | 10/08 → **11/08** | `a9dcc6d8` |
| 63 | «Modifica» dal riepilogo era **un viaggio di sola andata**: correggere un carattere costava quattro pressioni e la riattraversata di profilo e consensi | fastidioso | 11/08 → **11/08** | `a9dcc6d8` |
| 64 | Un campo sbagliato aveva **lo stesso identico bordo** di uno giusto: l'errore lo sapeva solo lo screen reader | bloccante (per chi vede) | 10/08 → **11/08** | `a9dcc6d8` |
| 65 | Un campo vuoto sembrava pieno: segnaposto e valore alla stessa luminosità, **1,00:1** in Alto Contrasto | fastidioso | 10/08 → **11/08** | `a9dcc6d8` |
| 66 | Sulla schermata dove **375 famiglie hanno scelto il plesso del proprio figlio**, il contorno fra una sede e l'altra era a 1,10:1 — cioè non esisteva (→ 5,82:1) | fastidioso | preesist. → **11/08** | `a9dcc6d8` |
| 67 | Il selettore del curriculum offriva `.doc` e `.docx` che il server avrebbe **rifiutato dopo** la compilazione | fastidioso | 10/08 → **10-11/08** | `a9dcc6d8` |
| 68 | **Il curriculum non si poteva allegare**, e il modulo aveva tre caselle obbligatorie sulle fasce d'età: **collaboratrici, cucina e segreteria non potevano candidarsi** | bloccante | 10/08 → **15/08 02:48** | `b43a556e` |
| 69 | Inviare la candidatura **rispondeva 500** quando il database non aveva ancora le colonne nuove: il degrado ritentava una volta sola e le colonne mancanti erano due | bloccante | 15/08 → **15/08** | `b43a556e` |
| 70 | «Una scuola per bambini che sembrava un portale amministrativo»: il giallo Kidville non compariva **nemmeno una volta**; due linguaggi di scelta diversi nello stesso modulo; l'icona del passo col token del *successo*, che non era un successo | cosmetico | 10/08 → **11/08** | `a9dcc6d8` |
| 71 | Quattro rilievi di accessibilità su `/lavora-con-noi`: contorno delle card a 2,79:1 (sotto WCAG 1.4.11), **due** anelli di fuoco dove ne basta uno, **nessun `<main>`** su tutti e 5 i passi, il comando Alto Contrasto come bersaglio più piccolo | fastidioso | ≤10/08 → **11/08** | `a9dcc6d8` |

---

# PARTE C.1 — L'unico difetto del 19-20 agosto che è stato vero in produzione

| Sintomo | Grav. | Finestra | Commit |
|---|---|---|---|
| **La tabella `candidature_sedi` è stata PUBBLICA per un'ora.** Creata senza `enable row level security`. Misurato con la chiave `anon` — quella che sta nel bundle JavaScript di chiunque apra il sito: `GET /rest/v1/candidature_sedi` rispondeva con le righe. **Chiunque poteva contare quante candidature ha ricevuto ogni plesso.** Nello stesso giro la funzione del trigger era `SECURITY DEFINER` senza `REVOKE`, quindi invocabile via RPC da chiunque per riscrivere lo stato di una candidatura | bloccante | **20/08 ~00:50 → ~01:27** | `ddfe3b0e` |

---

# PARTE B e C.2 — ESCLUSE dai documenti di profilo

**PARTE B** (reale, corretta, ma invisibile dentro l'app): conservazione e cron GDPR; log e
osservabilità (testo libero del genitore in chiaro in `app_log`, riaperto tre volte in un ciclo);
fatturazione elettronica Aruba (numerazione che sarebbe collidita al primo documento su due serie da
2.327 e 1.946); import iscrizioni 2026/27 (14 bambini a 150 €/mese per dieci mesi; un genitore su due
senza accesso); shell nativa e bundle (`ios/App/App/capacitor.config.json` su `localhost:3100` per sei
giorni); PII in file tracciati di un repo pubblico; banchi di prova e CI.

**PARTE C.2**: i difetti del branch `feat/candidature-multisede`, corretti prima del rilascio e mai
arrivati in produzione. Citarli come vissuti da un tester sarebbe falso.
