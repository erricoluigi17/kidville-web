# Profilo 06 — genitore che iscrive un figlio per la prima volta

> **Questo NON è un feedback ricevuto.** È la ricostruzione, provata commit per commit, dei difetti
> che un utente con questo profilo poteva incontrare nell'app fra il 6 e il 20 agosto 2026.

Il percorso di questo profilo è **uno solo**: `/iscrizione`, il modulo pubblico. Si apre senza
account — `src/lib/auth/middleware-rules.ts:19` lo elenca fra i prefissi pubblici, insieme a
`/onboarding`, che ci reindirizza — quindi un tester del canale chiuso ci arrivava dentro l'app,
prima e senza fare login. L'app Android è una WebView su `https://app.kidville.it`: le date qui
sotto sono le date in cui il rimedio è andato in produzione, non quelle di un aggiornamento da
scaricare.

Si compila in cinque tratti: si sceglie il **plesso**, si scrivono i dati del **bambino** (compreso
il codice fiscale, che si digita a mano), si scrivono i dati di uno o più **adulti**, si spuntano i
**consensi**, si invia. Il modulo raccoglie codici fiscali di minori, allergie e note mediche.
Alla fine compare a schermo una schermata di conferma con i coriandoli.

---

## Come si presentava il percorso d'iscrizione, giorno per giorno

**Dal 6 all'11 agosto, mattina.** Il modulo funzionava — arrivavano fra le tredici e le diciannove
domande al giorno — ma **non sapeva dire niente a chi lo stava compilando**.

*Sul ritmo, perché il numero che gira è sbagliato:* nel sorgente c'è scritto «≈9 invii l'ora»
(`EnrollmentWizard.tsx:493` alla vigilia della finestra), ed è un commento, non una misura. I conti
non tornano: 387 domande da quando il modulo è online (16/07) al 15/08 sono trenta giorni, cioè
**~13 al giorno — circa una ogni due ore**. Il riscontro incrociato dà lo stesso ordine di
grandezza: 227 domande al 31/07 e 302 al 04/08 sono **~19 al giorno**. A nove all'ora, nei soli sei
giorni fra il 6 e l'11 agosto ne sarebbero arrivate più di mille, cioè più del totale. Uso il ritmo
vero.

Al primo passo si sceglieva la sede fra tre riquadri bianchi su fondo crema. Il filo che separava
un plesso dall'altro era dipinto con `--color-kidville-line` (#EFE7DC): sul crema della pagina fa
**1,10:1**, cioè non si vede. Il riempimento non aiutava, perché bianco su crema aggiunge 1,11:1.
Chi guardava lo schermo vedeva tre nomi di città uno sotto l'altro, senza un contorno che dicesse
dove finiva una scelta e cominciava l'altra. (`aba85e31`, 29/07 14:54, l'aveva disegnata così;
`a9dcc6d8`, 11/08, l'ha cambiata.)

*Quante famiglie l'abbiano vista davvero, senza gonfiarlo:* **non 375**. Quel numero, che sta in un
commento del sorgente, è il totale delle domande, e il passo della sede **non esisteva prima del
29/07 14:54**. Al 31/07 le domande erano già 227 su 387: la maggior parte di chi ha compilato il
modulo questa schermata non l'ha mai vista. Il conto che regge è un **minimo**: fra il 31/07 e il
15/08 sono arrivate 160 domande, e tutte hanno attraversato quel passo. Ancora meno di quante
potrebbero sembrare, perché la schermata compare solo a due condizioni —
`mostraSede = !sedeDaLink && sedi.length > 1` — cioè se i plessi reali sono più d'uno **e** se il
link non porta già la sede scritta dentro (`/iscrizione?scuola=…`), che è la scorciatoia che la
Segreteria può diffondere.

Ai passi dei dati, sbagliare non si vedeva. Il componente che disegna i campi aveva **una sola
veste**, `FIELD_BASE`, uguale per un campo giusto e per uno sbagliato: bordo
`border-kidville-green/15` in tutti e due i casi. Compariva solo una riga rossa piccola sotto il
campo. Chi usava uno screen reader lo sapeva (`aria-invalid` c'era); chi guardava lo schermo si
trovava un modulo che rifiutava di andare avanti senza mostrare **quale** fosse la casella da
correggere. Quella veste unica stava lì dal **30 maggio 2026**, cioè dal giorno in cui il modulo
d'iscrizione è nato.

E un campo vuoto sembrava già compilato. Il testo del suggerimento («Es. …») e il testo scritto dal
genitore correvano a **1,01:1** l'uno dall'altro — due colori indistinguibili. Con l'**Alto
Contrasto** acceso, il comando c'era anche su questa pagina, andava peggio: tutti e due neri pieni,
**1,00:1**, lo stesso identico inchiostro. Nella modalità pensata per chi ci vede peggio, un campo
obbligatorio ancora vuoto aveva l'aspetto di uno già riempito.

Sui consensi, infine, il bersaglio era sbagliato due volte. Il collegamento «Leggi l'informativa
completa» era un testo alto 16 px **dentro** la casella di spunta: chi lo mancava col pollice
colpiva un bersaglio alto centinaia di pixel che **spuntava il consenso**. E quando lo si prendeva,
era un collegamento con `target="_blank"`: nella WebView una scheda nuova non esiste, quindi il
sistema consegnava l'indirizzo al browser di fuori — il genitore che stava leggendo come vengono
trattati i dati di suo figlio si ritrovava fuori dall'app.

**11 agosto, ore 10:16** (`a9dcc6d8`). In un colpo solo: il contorno fra le sedi passa a 5,82:1
(`border-kidville-neutral`), i campi sbagliati prendono una veste propria (bordo rosso #E53935 a
1,5 px, che non torna verde nemmeno quando ci si scrive dentro), il suggerimento prende un
inchiostro suo (`--color-kidville-hint` #65716C, e #595959 in Alto Contrasto). **Ma solo l'Alto
Contrasto si chiude davvero**: là il suggerimento e il testo scritto passano da 1,00:1 a 3,00:1,
mentre **in luce normale si va da 1,01:1 a 1,28:1**, come dichiara il sorgente stesso accanto al
token (`globals.css`, blocco di `--color-kidville-hint`). A occhio nudo, di giorno, un campo vuoto e
uno pieno restano **quasi** indistinguibili: a distinguerli resta soprattutto il corsivo del
suggerimento. Il difetto è mitigato, non chiuso, e il collegamento all'informativa esce dalla casella diventando un bersaglio alto 44 px
che resta dentro l'app.

**12 agosto, ore 07:09** (`65e3631c`). Restava il pezzo grosso del consenso: la casella si portava
dentro **tutto il corpo dell'informativa**. Misurato: il nome della casella era lungo 564, 292 e 379
caratteri, e l'area cliccabile era 328×373 px — **toccare il testo dell'informativa per rileggerlo
spuntava il consenso**. Su un modulo dove la volontà del genitore dev'essere inequivocabile, e dove
due dei consensi riguardano fotografie e video del bambino. Da quel giorno il titolo resta la
casella, il corpo esce e diventa testo che si può leggere e toccare senza spuntare niente.

**Fino al 15 agosto, ore 00:25** (`0e8480a3`). Se durante la compilazione usciva una versione nuova
del sito — ed è successo più volte in questi quindici giorni, perché ogni rilascio arriva alla
WebView senza aggiornare l'app — un pezzo di programma poteva non arrivare più. In quel caso la
pagina restava su **«Caricamento…» per sempre**: nessun messaggio, nessun pulsante, niente da
premere. Il pannello che avrebbe dovuto dirlo esisteva **dal 4 agosto** (`d244eea7`, 04/08 16:45),
con **dieci** test verdi, e **non era montato da nessuna parte**: i test lo costruivano da soli e passavano mentre l'app non lo
disegnava mai.

**Fino al 15 agosto, ore 02:48** (`b43a556e`). E per tutto il tempo, chi arrivava in fondo, spuntava
i consensi e premeva Invia **non riceveva niente**. A schermo compariva la conferma con i coriandoli;
nella casella di posta, nessuna ricevuta, nessun riepilogo, nessun riferimento da tenere. La riga
c'era nel database, ma il genitore non aveva **nessuna prova** di aver mandato la domanda di suo
figlio. Il conto, misurato quel giorno: **387 domande registrate, 381 con un indirizzo valido** —
cioè 381 ricevute che si potevano mandare e non sono partite. Da quel commit la ricevuta parte
subito dopo l'invio, con un riferimento leggibile (`ISC-` più otto caratteri), il nome del bambino e
l'ora, e ogni esito — compreso quello buono — lascia una riga nei log.

*Non un difetto, ma un cambio del percorso che cade in questa finestra e va detto per completezza:*
il **17 agosto alle 01:06** (`4907219e`) il modulo ha cominciato a pretendere che **ogni genitore
metta la propria casella di posta**, con un avviso mostrato prima di compilare il secondo adulto.
Prima due genitori potevano indicare lo stesso indirizzo.

---

## I difetti che questo profilo poteva incontrare

| # inv. | Cosa si vedeva a schermo | Gravità | Rotto fino al | Commit | Verificato |
|---|---|---|---|---|---|
| 64 | **Il modulo non andava avanti e non diceva quale campo fosse sbagliato.** Un campo con l'errore aveva lo stesso identico bordo di uno giusto: unico segnale, una riga rossa piccola sotto. Chi usava lo screen reader lo sapeva, chi guardava lo schermo no. Sul modulo d'iscrizione la veste unica dei campi stava lì **dal 30/05/2026** | bloccante (per chi vede) | **11/08 10:16** | `a9dcc6d8` | sì · su `main` · sorgente prima/dopo letto |
| 65 | **Un campo vuoto sembrava già compilato**: il testo del suggerimento e quello scritto dal genitore erano a 1,01:1, cioè indistinguibili — e con l'Alto Contrasto acceso a **1,00:1**, lo stesso nero. Un campo obbligatorio ancora da riempire aveva l'aspetto di uno pieno | fastidioso | **11/08 10:16 in Alto Contrasto (1,00:1 → 3,00:1); in luce normale solo MITIGATO** (1,01:1 → 1,28:1, resta il corsivo a distinguerli) | `a9dcc6d8` | sì · su `main` · regola CSS prima/dopo letta |
| 66 | **Sulla schermata dove si sceglie il plesso del figlio**, il contorno fra una sede e l'altra era a **1,10:1**: a occhio non esisteva, e il riempimento aggiungeva 1,11:1. Tre nomi di città senza un confine che dicesse dove finiva una scelta. Almeno **160 famiglie** hanno scelto qui il plesso del figlio (→ 5,82:1) | fastidioso | **11/08 10:16** — esiste dal 29/07 14:54 (`aba85e31`) | `a9dcc6d8` | sì · su `main` · diff della schermata letto |
| 60 | **Toccare il testo dell'informativa per rileggerlo spuntava il consenso.** La casella si portava dentro tutto il corpo dell'informativa: area cliccabile 328×373 px, nome della casella lungo 564 caratteri. Due di quei consensi riguardano fotografie e video del bambino | fastidioso | **12/08 07:09** | `65e3631c` | sì · su `main` · componente condiviso, il passo «consensi» del modulo lo usa |
| 20 | **«Caricamento…» per sempre**, senza messaggio e senza un pulsante da premere, quando durante la compilazione usciva una versione nuova del sito e un pezzo di programma non arrivava. Il pannello che avrebbe dovuto parlare esisteva dal **04/08** (`d244eea7`), con dieci test verdi, e **non era montato da nessuna parte** | bloccante | **15/08 00:25** | `0e8480a3` | sì · su `main` · montato nel guscio comune a tutte le pagine |
| 26 | **Domanda inviata, e poi niente.** A schermo la conferma; nella posta nessuna ricevuta, nessun riepilogo, nessun riferimento da conservare. Chi ha iscritto un figlio non aveva nessuna prova di averlo fatto. **387 domande registrate, 381 con un indirizzo valido = 381 ricevute mai partite** | bloccante | **15/08 02:48** | `b43a556e` | sì · su `main` · la route pubblica non spediva alcuna email prima di questo commit |

Dettaglio dello stesso commit `a9dcc6d8`, senza numero d'inventario proprio ma sulla stessa card dei
consensi: fino all'11/08 il collegamento «Leggi l'informativa completa» era un bersaglio alto 16 px
**dentro** la casella di spunta (mancarlo spuntava il consenso), ed era un `target="_blank"`, che in
una WebView porta il genitore **fuori dall'app** proprio mentre sta leggendo come vengono trattati i
dati di suo figlio.

---

## Cosa questo profilo NON poteva incontrare, e perché lo scrivo

**Il n. 61 — il codice fiscale di un minore mandato a un fornitore terzo — NON stava sul modulo
pubblico d'iscrizione.** Me l'aspettavo qui, l'ho cercato, e i fatti dicono di no. La chiamata a
`api.codicefiscale.it` viveva in `src/lib/utils/fiscalCodeApi.ts`, e alla vigilia della finestra
(commit del 05/08) la importavano **tre soli file**, tutti sotto
`src/components/features/admin/`: `ScrollableAdultForm`, `ScrollableStudentForm` e
`StudentRegistryForm`. I primi due arrivano a schermo solo attraverso `FamilyRegistryManager`, che a
sua volta è usato solo da `/admin/students/new` — una pagina della Segreteria. Il terzo non era usato
da nessuno. Il modulo pubblico (`EnrollmentWizard`) non importava quel file e non lo importa oggi;
lì il codice fiscale è un **campo di testo che il genitore digita**, con un controllo di forma sui 16
caratteri. Cercando `codicefiscale.it` in tutto `src/` alla stessa data si trovano due sole
occorrenze, entrambe dentro quel file. Quindi: il difetto è reale e grave, ma il dato del bambino
partiva dal browser **della segreteria**, non da quello del genitore che compilava l'iscrizione.
Attribuirlo a questo profilo sarebbe una dichiarazione falsa, e la scrivo qui invece di ometterla in
silenzio. *(Riscontro indipendente eseguito dopo la prima stesura:
`git grep -l -E "fiscalCodeApi|codicefiscale\.it" a9dcc6d8^ -- 'src/*'` dà **quattro** percorsi —
i tre file `admin/` più il modulo che contiene la chiamata — e l'inventario ha spostato il n. 61
nella sezione A.3, Segreteria.)*

**La firma con codice OTP non fa parte di `/iscrizione`.** Nel modulo pubblico non c'è: cercando
`otp` e `firma` nel sorgente del wizard non compare nulla, e la spedizione del codice
(`/api/forms/send-otp`) serve la modulistica **dentro** l'app, che richiede un account. Sul modulo
pubblico la volontà si esprime con le caselle dei consensi. Il n. 26 resta vero e resta di questo
profilo — ho mandato la domanda e non è arrivato niente — ma il passo che lo precede è la spunta,
non la firma. *(L'inventario ha tolto «e firmava con l'OTP» dalla riga.)*

**La PARTE C.1 (`candidature_sedi` pubblica per un'ora, la notte del 20 agosto) non tocca questo
profilo.** Quella tabella è agganciata a `candidature_insegnanti` con una chiave esterna: contiene i
plessi a cui è rivolta una **candidatura di lavoro** arrivata da `/lavora-con-noi`. Una domanda
d'iscrizione non ci mette piede. Il commit che la chiude, `ddfe3b0e`, non è su `main`.

**Tutto il lavoro del 19-20 agosto è fuori.** `git branch --contains` su `ddfe3b0e` e `aa048978`
risponde solo `feat/candidature-multisede`: non è mai arrivato in produzione, quindi nessun tester
poteva vederlo.

**Il resto della sezione A.4 riguarda `/lavora-con-noi`, non `/iscrizione`** (n. 62, 63, 67, 68, 69,
70, 71): il riepilogo che non riepilogava, «Modifica» di sola andata, il curriculum che non si
poteva allegare, il 500 all'invio, i rilievi sulle card e sul landmark. Sono difetti del modulo con
cui ci si candida a lavorare alla Scuola, aperto al pubblico l'11 agosto. Un genitore che iscrive un
figlio non ci passa.

**E non ho messo qui i difetti dell'area riservata** (n. 1-25, 27-59). Questo profilo, per
definizione, non ha ancora un account: compila il modulo pubblico e aspetta che la Segreteria lo
importi. Comunicare un'assenza, il registro, i certificati, la gita, la chat con la maestra sono
schermate che vede il genitore **già iscritto**, cioè un altro profilo.

---

## Verifiche eseguite

Tutte in sola lettura. Nessun `git add`, `git commit`, `git push`, `git checkout`. Nessuna scrittura
sul database.

1. **Fonte.** Letto per intero `docs/collaudo/produzione/00-INVENTARIO-difetti-6-20-agosto.md`.
2. **Esistenza e data di ogni commit citato** — `git show --stat --oneline <hash> | head -20` su
   `a9dcc6d8` (11/08 10:16), `65e3631c` (12/08 07:09), `0e8480a3` (15/08 00:25), `b43a556e`
   (15/08 02:48), più `aba85e31` (29/07 14:54) e `4907219e` (17/08 01:06) citati nel racconto.
3. **Presenza in produzione** — `git branch --contains <hash> | grep -w main` su ognuno: tutti
   rispondono `main`. Controprova su `ddfe3b0e` e `aa048978` (19-20/08): **non** rispondono `main`.
   Verificato anche che i quattro commit stanno sulla linea `--first-parent` di `main`, cioè sono
   rilasci veri e non commit interni a un ramo.
4. **Che il percorso sia raggiungibile senza account** — `src/lib/auth/middleware-rules.ts` elenca
   `/iscrizione`, `/api/iscrizione` e `/onboarding` fra i prefissi pubblici;
   `src/app/onboarding/page.tsx` reindirizza a `/iscrizione`.
5. **n. 66** — letto il diff di `EnrollmentWizard.tsx` in `a9dcc6d8`: la classe della card di sede
   passa da `border-kidville-line` a `border-kidville-neutral`. Token verificati in `globals.css`
   (`line` #EFE7DC, `cream` #FEF1E4, `neutral` #8A958F). Origine della schermata risalita con
   `git log -S` fino a `aba85e31` (29/07 14:54). Letta la condizione che la fa comparire nel diff di
   quel commit: `mostraSede = !sedeDaLink && sedi.length > 1`, cioè più plessi reali **e** nessuna
   sede già scritta nel link.
6. **n. 64** — letto `FieldRenderer.tsx` a `a9dcc6d8^`: esisteva **una sola** costante `FIELD_BASE`,
   nessuna variante d'errore. Nascita della costante risalita con `git log -S "export const
   FIELD_BASE"` → `a3db8ce7`, **30/05/2026** (il file `FieldRenderer.tsx` è più vecchio di due
   giorni: `--diff-filter=A` dà `ce4184a8`, 28/05, che è la nascita del *file*, non della veste dei
   campi — nella prima stesura di questo documento avevo dichiarato il filtro sbagliato).
   Verificato che il modulo d'iscrizione passa davvero l'errore al componente: tre chiamate a
   `FieldRenderer` con `error={resolveError(errors, f.id)}`.
7. **n. 65** — letto il diff di `globals.css` in `a9dcc6d8`: nuovo token
   `--color-kidville-hint: #65716C` e, nella regola dell'Alto Contrasto, `color: #000000` che
   diventa `color: #595959`. Verificato che la regola è agganciata a `.kv-public` e che
   `EnrollmentWizard.tsx:516` porta proprio quella classe, quindi la pagina è raggiunta dalla regola.
   Verificato che il comando dell'Alto Contrasto è su questa pagina dal 03/08 (`fc7c94a8`). Letti
   **tutti e due** i numeri del rimedio, non solo quello favorevole: il blocco del token in
   `globals.css` dichiara «1,28:1 col valore #006A5F (era 1,01:1)» per la luce normale, e la regola
   `[data-contrast="high"]` porta 1,00:1 a 3,00:1. Chiuso in Alto Contrasto, mitigato di giorno.
8. **n. 60** — letto il diff di `FieldRenderer.tsx` in `65e3631c`: il corpo dell'informativa esce
   dalla `<label>` e viene puntato con `aria-describedby`. Verificato che il modulo d'iscrizione
   rende i consensi con quel componente (passo `consensi`, `CONSENSI_FIELDS.map(... <FieldRenderer`)
   e che i suoi quattro consensi hanno un `text` lungo (`enrollment-template.ts`).
9. **n. 20** — letto il diff di `RootProviders.tsx` in `0e8480a3`: `<ChunkErrorBoundary />` viene
   montato lì. Verificato che `RootProviders` è usato da `src/app/layout.tsx`, cioè dal guscio
   comune a **tutte** le pagine, `/iscrizione` compresa (che non ha un `layout.tsx` proprio).
   Nascita del componente misurata, non ripresa dal commento:
   `git log --diff-filter=A --format="%h %ci" -- src/components/providers/ChunkErrorBoundary.tsx` →
   `d244eea7`, **2026-08-04 16:45**, non il 3 agosto. Test contati sul file, non stimati:
   `git show 0e8480a3:__tests__/components/ChunkErrorBoundary.test.tsx | grep -cE "^\s*(it|test)\("`
   → **10**, non undici.
10. **n. 26** — letto il diff di `src/app/api/iscrizione/route.ts` in `b43a556e`: prima nessun invio
    di email, dopo `inviaRicevutaIscrizione` su entrambe le strade di salvataggio. Verificato che il
    file del messaggio `src/lib/email/messaggi/ricevuta-iscrizione.ts` **nasce** con questo commit
    (`git log --follow`).
11. **n. 61, esclusione** — `git grep -l "fiscalCodeApi"` al commit del 05/08 e a `a9dcc6d8^`: tre
    file, tutti in `components/features/admin/`. Risalita dei consumatori fino a
    `/admin/students/new`. `git grep "codicefiscale.it"` su tutto `src/`: due occorrenze, entrambe
    nel file rimosso. Cercati `fiscalCode`/`codice fiscale` nel wizard pubblico, nel suo template e
    nella sua route: solo un campo di testo con controllo di forma.
12. **OTP, esclusione** — cercati `otp` e `firma` in `EnrollmentWizard.tsx`: zero occorrenze.
    `messaggioCodiceVerifica` è usato solo da `/api/forms/send-otp` e `otp-ticket.ts`, che servono
    la modulistica interna.
13. **PARTE C.1, esclusione** — letta la migrazione `20260819231500_candidature_sedi.sql`: chiave
    esterna verso `candidature_insegnanti`, cioè le candidature di lavoro.
14. **Ritmo degli invii e platea della schermata di sede** — i due numeri che avevo ripreso dai
    commenti del sorgente («≈9 invii l'ora», `EnrollmentWizard.tsx:493`, e «375 famiglie») sono
    **commenti, non misure**, e non reggono l'aritmetica: 387 domande in trenta giorni fanno ~13 al
    giorno, e il passo della sede esiste solo dal 29/07 14:54 mentre al 31/07 le domande erano già
    227. Rifatti i conti sui soli dati documentati (227 al 31/07, 302 al 04/08, 387 al 15/08) e
    sostituiti con un ritmo vero e con un **minimo** verificabile (160 domande dopo il 31/07).

15. **Che non mi sfuggisse nient'altro** — elencati con `git log --first-parent main` tutti i commit
    fra il 05/08 e il 21/08 che toccano un file del percorso d'iscrizione: sette in tutto. I quattro
    della tabella, più `f59854ab` (solo `globals.css`, per «Comunica un'assenza»), `d7af75b6` (il
    nome del pulsante «Scatta foto» su un altro modulo) e `4907219e` (l'email diversa per ogni
    genitore, citato nel racconto).

Nessun nome di bambino, nessun codice fiscale, nessun indirizzo compare in questo documento: solo
conteggi, colori e rapporti di contrasto.
