# Profilo 12 — persona che si candida da «Lavora con noi»

> **Questo NON è un feedback ricevuto.** È la ricostruzione, provata commit per commit, dei difetti
> che un utente con questo profilo poteva incontrare nell'app fra il 6 e il 20 agosto 2026.

## Come si presentava il percorso di candidatura, giorno per giorno

**Dal 6 all'11 agosto, fino alle 10:16 — il modulo non esisteva.** Chi cercava lavoro alla Kidville non
aveva nessun percorso dentro l'app: `/lavora-con-noi` compare per la prima volta, su qualunque ramo
del repository, con `a9dcc6d8` (11/08, 10:16). Lo dice anche il Service Worker che serve la pagina
`/offline`, con la sua nota datata: *«2026-08-11 — nasce `/lavora-con-noi`, il modulo pubblico di
candidatura delle insegnanti»*. Nei primi cinque giorni della finestra questo profilo, dentro il
prodotto, semplicemente non ha una porta.

**Il modulo non si trovava navigando.** Nessuna schermata dell'app portava a `/lavora-con-noi`:
l'unico collegamento dentro il prodotto è quello che la segreteria copia da Modulistica → «Moduli
inviabili». Una candidata ci arriva da un link ricevuto — e lo apre nella stessa WebView
`app.kidville.it` con cui l'app mostra tutto il resto.

**Dall'11 al 15 agosto — un modulo per sole maestre, muto dopo l'invio.** Cinque passi: Sede, I tuoi
dati, Il tuo profilo, Consensi e informativa, Riepilogo. Il sottotitolo diceva, testualmente,
«Proponi la tua candidatura **come insegnante**», e il terzo passo si presentava come «Titolo di
studio, esperienza e **fasce d'età**». Lì stava la domanda obbligatoria «Per quali fasce ti proponi»
con tre sole caselle — Nido (0-3), Infanzia (3-6), Primaria (6-11) — e senza almeno una spunta non
si andava avanti. Una collaboratrice scolastica, una cuoca, un'impiegata di segreteria non avevano
nessuna risposta vera da dare: o dichiaravano una fascia d'insegnamento che non le riguardava, o si
fermavano lì. Del curriculum, nessuna traccia a schermo: il campo esisteva nel modello dei campi
come «Curriculum (facoltativo)», ma il modulo lo teneva esplicitamente fuori
(`IDS_NON_RESI = new Set(['cv_path'])`), perché la rotta che avrebbe dovuto ricevere il file non era
ancora stata scritta. Premuto «Invia candidatura», nella casella di posta non arrivava niente.

**Il 15 agosto, alle 02:48 — il modulo diventa di tutti.** Le tre fasce diventano un elenco solo di
sette posizioni, che comprende Collaboratrice scolastica, Cuoca / aiuto cucina, Segreteria /
amministrazione e un «Altro» scritto a mano; nasce la rotta di caricamento del curriculum e il campo
compare davvero, con la sua nota («Va bene un PDF oppure una foto del curriculum»); e la ricezione
della candidatura genera finalmente un'email di conferma. Il sottotitolo perde la parola
«insegnante».

**Il 15 agosto, alle 19:23 — «accolta» smette di significare «ecco una password».** Fino a quel
momento, approvare una candidatura creava un account `educator` e ne spediva la password
all'indirizzo scritto nel modulo pubblico.

**Dal 16 al 20 agosto — percorso stabile.** L'ultimo commit arrivato in produzione è `b87ee964`
(17/08, 01:35): dopo quello, e per tutto il 18, 19 e 20 agosto, nell'app non cambia una riga.
L'unica cosa del 20 agosto che ha toccato davvero la produzione non si vedeva a schermo: una tabella
nuova, aperta a chiunque per trentasette minuti nel database vero.

## I difetti che questo profilo poteva incontrare

Tutte le finestre partono dall'**11/08 10:16**, che è il momento in cui il modulo è arrivato in
produzione: prima di quell'ora non c'era niente da incontrare.

| # inv. | Cosa si vedeva a schermo | Gravità | Rotto fino al | Commit | Verificato |
|---|---|---|---|---|---|
| **68** | «Proponi la tua candidatura **come insegnante**»: per andare avanti bisognava spuntare almeno una fra Nido, Infanzia e Primaria. Chi si proponeva come collaboratrice, cuoca o segreteria non aveva una risposta vera e non poteva concludere il modulo. E il curriculum non si poteva allegare: nessuna casella, nessun pulsante, in nessuno dei cinque passi | bloccante | **15/08 02:48** | `b43a556e` | `git show --stat` ok · `git branch --contains` → **main** |
| **26** (stessa mancanza, versione candidature) | Premuto «Invia candidatura», la schermata diceva che era andata e nella casella di posta non arrivava niente: nessuna conferma, nessun riepilogo, nessun numero a cui riferirsi. L'unica email che il sistema sapeva scrivere a chi si era candidato era il rifiuto («Esito della tua candidatura») o la password in caso di approvazione | bloccante | **15/08 02:48** | `b43a556e` (assenza provata su `a9dcc6d8`) | `git show --stat` ok · `git branch --contains` → **main** |
| **47** | «La candidatura è stata accolta» voleva dire: nella casella di chi si era proposto arrivava un'email intitolata «Le tue credenziali di accesso — Kidville» con dentro una password. Quella password apriva il registro dove ci sono nome, cognome, allergie e note mediche di 33 bambini — consegnata a un indirizzo email arrivato da un modulo pubblico e anonimo, senza che nessuno avesse visto un documento della persona | bloccante | **15/08 19:23** | `fcc51fc8` | `git show --stat` ok · `git branch --contains` → **main** |
| **20** (elencato sotto GENITORE, ma globale) | Aprendo il link della candidatura poco dopo un aggiornamento del sito, la pagina restava su «Caricamento…» per sempre: nessun messaggio, nessun pulsante per riprovare. Il pezzo di codice che avrebbe dovuto dire «ricarica la pagina» esisteva dal 3 agosto, con undici test verdi, e non era richiamato da nessun file | bloccante | **15/08 00:25** | `0e8480a3` | `git show --stat` ok · `git branch --contains` → **main** · vale anche qui perché sta nel guscio comune (`src/app/layout.tsx` → `RootProviders`), sotto cui `/lavora-con-noi` sta direttamente |
| **C.1** | Non si vedeva a schermo, ma riguarda proprio chi si era candidato: per **37 minuti** (20/08, ~00:50 → 01:27) la tabella che lega ogni candidatura al plesso è stata **leggibile da chiunque**, con la chiave pubblica che sta nel JavaScript di ogni visitatore del sito. `GET /rest/v1/candidature_sedi` rispondeva con le righe vere — 18 — quindi chiunque poteva contare quante candidature aveva ricevuto ogni plesso. Nello stesso giro la funzione del trigger era invocabile da chiunque per **riscrivere lo stato di una candidatura** | bloccante | **20/08 ~01:27** | `ddfe3b0e` | `git show --stat` ok · `git branch --contains` → **NON in main**. Conta lo stesso, e solo per questo: la migrazione è stata applicata **direttamente al database di produzione**, quindi il buco è esistito nei dati veri anche se il codice del modulo non è mai stato pubblicato |

### Un rilievo emerso dalla verifica, che nell'inventario non c'è

Lo scrivo separato perché non viene dalla fonte, ma dal controllo dei suoi commit, e un revisore ha
diritto di sapere da dove arriva.

Quando il 15 agosto alle 19:23 (`fcc51fc8`) l'approvazione ha smesso di creare account e di spedire
password, **il testo a schermo non è stato aggiornato**. Il riquadro «Dopo l'invio» del modulo
continua a dire: *«Non serve nessun account: se la candidatura viene accolta, le credenziali di
accesso arrivano via email all'indirizzo che hai scritto qui»*. Quella frase è ancora identica su
`main` oggi (`messages/it/public.json`, chiave `candContestoCredenziali`) e **non è testo morto**:
il wizard la rende, riga 1907 di `CandidaturaInsegnanteWizard.tsx` su `main`. Dal 15/08 19:23 in
avanti — cioè da oltre quattro giorni alla data di questa misura, e ancora adesso — il modulo
promette a chi si candida un'email che il sistema non manda più: chi viene scelto lo sente dalla
scuola, non da un automatismo. È il difetto n. 47 rovesciato: non più una password di troppo, ma
un'attesa che non finisce. **È l'unica voce di questo documento che al 20 agosto non è ancora
chiusa.**

## Il lavoro del 19-20 agosto che NON è mai arrivato in produzione

È la parte in cui è più facile sbagliare, perché è tutta e solo su «Lavora con noi» e sembra
raccontabile. **Non lo è**: `git branch --contains` dà `NON IN MAIN` su **ogni** commit del ramo
`feat/candidature-multisede`, e l'ultimo commit arrivato in produzione è `b87ee964` del
**17/08 01:35**.

⚠️ **Il numero di quei commit invecchia mentre lo si scrive, e va misurato, non ricordato.**
`git rev-list main..HEAD | wc -l` ha dato **25** alla prima stesura, **26** un'ora dopo
(`e11940af`, 20/08 11:16) e **27** alla riscrittura (`7535db7a`, 20/08 11:27): il ramo
è vivo e riceve commit mentre questo documento viene riletto. Il conteggio invecchia, la conclusione
no — nessuno di quei commit è su `main`, e su `main` non è arrivato niente dopo `b87ee964`. Chi
rilegge questo file esegua di nuovo il comando invece di fidarsi del numero. Elenco esplicito di ciò
che ho scartato (con i due arrivati dopo, in fondo):

| Commit | Cosa avrebbe cambiato per chi si candida | Perché è scartato |
|---|---|---|
| `11e22e07`, `f53ef032`, `f67d7580` | Specifica e piano del modulo a più sedi | NON in main |
| `f4bba369` | Il marchio Kidville nella riga di testa del modulo pubblico | NON in main |
| `b1490452`, `27df3bd1`, `842072dd`, `8c6bcb71` | La candidatura (curriculum in allegato compreso) recapitata anche alla casella del plesso | NON in main |
| `c2978384`, `8c379291` | Informativa privacy riscritta e versione alzata | NON in main |
| `e8319816`, `492329d8`, `ddfe3b0e` | **Scegliere più sedi con le caselle** invece di un plesso solo, e il riepilogo che le nomina tutte | NON in main — *(la sola migrazione di `ddfe3b0e`/`e8319816` ha toccato la produzione: è il difetto C.1 qui sopra, e nient'altro)* |
| `650dbd84`, `95525658`, `b24294ab` | Il pannello della segreteria che vede solo le candidature rivolte alla propria sede | NON in main |
| `aa048978` | **La riapertura del n. 49** (il curriculum di un'altra sede) del 19-20/08, più sei altri difetti | NON in main — e la versione precedente del n. 49 non era incontrabile comunque: vedi le esclusioni |
| `b17b67be`, `88422e6d`, `84a91ef5`, `c111d6a4`, `60ccc389`, `360c8523`, `fb2c0a7d`, `f9642774` | Verifica avversariale, correzioni del pannello, formattazione dei plurali, rifiuto per singolo plesso | NON in main |
| `e11940af`, `7535db7a` | Conferma firmata da una sede sola, «Altro (specifica qui sotto)», tetto cablato, pannello e pulsanti | NON in main — **arrivati dopo la prima stesura di questo documento**, ed è il motivo per cui il conteggio qui sopra si misura invece di ricordarlo |

## Cosa questo profilo NON poteva incontrare, e perché lo scrivo

Nell'inventario la sezione A.4 assegna a questo profilo dieci voci, dalla 62 alla 71. **Di quelle
dieci ne resta in piedi una sola**, la 68, ed è in tabella qui sopra. Le altre nove le smonto una
per una, e con loro tre voci vicine che riguardano lo stesso percorso — la n. 61 di A.4 e le n. 48 e
n. 49 di A.3 — perché è l'unica parte di questo documento che un revisore non può controllare
guardando l'app: deve fidarsi di come ho contato. La n. 49 la smonto **contro me stesso**: era in
tabella nella prima stesura.

**Cinque** (n. 62, 63, 67, 70, 71) cadono per una ragione sola, verificabile in un comando:
`/lavora-con-noi` è nato su `main` con `a9dcc6d8` l'11/08 alle 10:16, e quei cinque difetti sono
stati aperti e chiusi **dentro quello stesso commit**, cioè sul ramo, prima della pubblicazione. La
colonna «Finestra» dell'inventario li data `10/08 → 11/08`: quel 10 agosto è un giorno di sviluppo,
non un giorno di produzione.

**Due** (n. 64 e n. 65) cadono per la ragione **opposta**, e la distinzione conta: in produzione
c'erano davvero, e a lungo — ma su un'altra schermata, il modulo d'iscrizione delle famiglie, che è
preesistente. Non sono difetti mai esistiti: sono difetti di qualcun altro. Chi si candidava non li
ha incontrati perché `/lavora-con-noi` è nato dopo la correzione, non perché la correzione fosse
inutile.

**Le ultime due** (n. 66 e n. 69) cadono per ragioni proprie, più sotto.

Le prove, una per una, stanno nel codice pubblicato:

- **n. 62 — «Controlla e invia» che non riepilogava.** Il commento in testa al modulo, nella
  versione andata in produzione, lo dichiara al passato: *«Fino al 2026-08-11 l'ultimo passo diceva
  "Controlla e invia la candidatura" e mostrava DUE fatti su tredici campi compilabili»*. La prima
  versione visibile a un utente conteneva già la riga di rilettura dell'email: *«Controlla che
  l'indirizzo email qui sopra sia scritto giusto: è l'unico modo con cui la Direzione può
  risponderti»*. Un tester non ha potuto perdere una candidatura per un refuso mai riletto: la
  rilettura c'era dal primo minuto.
- **n. 63 — «Modifica» di sola andata**, **n. 70 — il modulo che sembrava un portale
  amministrativo**: stessa finestra, stesso commit, stessa pagina non ancora esistente.
- **n. 64 (bordo identico su campo sbagliato) e n. 65 (segnaposto e valore a 1,00:1 in Alto
  Contrasto)**: vivevano in `FieldRenderer.tsx`, che il modulo d'iscrizione delle famiglie usava già
  prima (`git show a9dcc6d8~1:src/components/features/public/EnrollmentWizard.tsx` lo importa). Su
  `/lavora-con-noi` no: quando il modulo è nato, il componente era già corretto — la correzione
  viaggiava nello stesso squash che lo pubblicava. Chi ha sofferto quei due è chi compilava
  l'iscrizione, non chi si candidava.
- **n. 66 — il contorno fra una sede e l'altra a 1,10:1**: è la schermata dove *375 famiglie hanno
  scelto il plesso del figlio*, cioè il modulo d'iscrizione. Preesistente lì, mai visibile qui.
- **n. 61 — il codice fiscale di un minore mandato a un fornitore esterno**: riguarda un bambino e
  il modulo d'iscrizione. Chi si candida per lavorare non inserisce il codice fiscale di nessun
  minore.
- **n. 67 — il selettore che offriva `.doc` e `.docx`**: nella versione pubblicata non c'era nessun
  selettore di file da nessuna parte (`cv_path` era fuori dai campi resi), quindi non c'era nemmeno
  la lista di estensioni sbagliata. È un difetto reale del ramo, non della produzione.
- **n. 71 — i quattro rilievi di accessibilità**: il test che li congela si intitola *«I quattro
  rilievi minori del collaudo visivo dell'11/08/2026»* ed è dentro `a9dcc6d8`. Il collaudo che li ha
  trovati ha guardato la pagina prima che fosse pubblicata.
- **n. 69 — il 500 all'invio per colonne mancanti**: è un rosso della CI dentro `b43a556e`,
  introdotto e chiuso nello stesso commit. Sul database di produzione le colonne nuove c'erano
  (migrazione `20260814225302` applicata prima).
- **n. 49 — il curriculum di una sede aperto dalla segreteria di un'altra**: l'avevo messo in
  tabella, e **era sbagliato**. Il difetto è reale (il controllo prendeva una riga a caso quando due
  candidature portavano lo stesso percorso di file, `b43a556e`), ma fra l'11 e il 15 agosto **in
  produzione non esisteva un solo curriculum da far uscire**: la rotta che li riceve
  (`git log --all --diff-filter=A -- src/app/api/iscrizione/insegnanti/upload/route.ts` → solo
  `b43a556e`) e la funzione che ne convalida il percorso
  (`… -- src/lib/candidature/percorso-cv.ts` → `b43a556e`) sono nate **con la correzione stessa**.
  Niente CV in produzione, nessuna fuga fra sedi. È lo stesso ragionamento con cui scarto il n. 67 —
  e me n'ero accorto per il selettore di file, non per il file: applicato a metà è un errore mio, non
  dell'inventario.
- **n. 48 — approvare una cuoca creando un account `educator`**: la possibilità di candidarsi come
  cuoca e la regola che glielo impedisce sono nate insieme, in `b43a556e`. Prima non esisteva
  nessuna cuoca da approvare, perché nessuna cuoca poteva candidarsi (è il n. 68).

Scrivo tutto questo invece di tacerlo perché il documento serve a un revisore che deve poter
distinguere tre cose che si somigliano e non sono la stessa: un difetto **sofferto** da questo
profilo, un difetto **corretto prima** che qualcuno potesse incontrarlo, e un difetto **vero ma di
un'altra schermata**. Delle dodici voci smontate qui, **otto** sono della seconda specie (n. 62, 63,
70, 67, 71, 69, 49, 48) e **quattro** della terza (n. 64, 65, 66, 61). Presentarne una qualunque come vissuta sarebbe la stessa dichiarazione falsa che questo
documento esiste per evitare — e la n. 49 dimostra che il rischio non è teorico: ce l'avevo messa
io.

Restano fuori, per la ragione opposta — non toccano questo profilo — tutta la **PARTE B**
(cron, fatturazione, log, bundle nativo, console degli store) e tutta la **PARTE C.2**.

## Verifiche eseguite

Tutte in sola lettura: nessun `git commit`, `add`, `push` o `checkout`; nessuna riga scritta fuori
da questo file; nessun accesso al database.

1. `git show --stat --oneline <hash> | head -20` su tutti i commit citati: `a9dcc6d8`, `b43a556e`,
   `fcc51fc8`, `0e8480a3`, `65e3631c`, `0974424a`, `aa048978`, `ddfe3b0e`.
2. `git branch --contains <hash> | grep -w main` su ognuno. In `main`: `a9dcc6d8`, `b43a556e`,
   `fcc51fc8`, `0e8480a3`, `65e3631c`, `0974424a`. **Non** in `main`: `aa048978`, `ddfe3b0e`.
3. Controllo esaustivo del ramo: `git rev-list main..HEAD`, verificato commit per commit con
   `git branch --contains` → **tutti** `NON IN MAIN`. Il conteggio è passato da 25 a 26 a **27**
   nell'arco della stesura, perché il ramo riceve commit adesso: si riesegue, non si cita.
4. Nascita del percorso: `git log --all --diff-filter=A -- src/app/lavora-con-noi/page.tsx` e
   `-- src/components/features/public/CandidaturaInsegnanteWizard.tsx` → **solo** `a9dcc6d8`.
   Riscontro indipendente in `public/sw.js`, nota datata `2026-08-11`.
5. Ultimo commit in produzione: `git log main -6` → `b87ee964`, 17/08 01:35. Niente su `main` dal
   18 al 20 agosto.
6. Campo curriculum non reso a schermo: `git show a9dcc6d8:src/components/.../CandidaturaInsegnanteWizard.tsx`
   → `IDS_NON_RESI = new Set(['cv_path'])`; `git show b43a556e:…` → `IDS_NON_RESI` vuoto.
   Rotta di caricamento: `git diff --name-status a9dcc6d8 b43a556e -- src/` →
   `A src/app/api/iscrizione/insegnanti/upload/route.ts`.
7. Assenza di curriculum in produzione (è ciò che smonta il n. 49):
   `git log --all --diff-filter=A -- src/app/api/iscrizione/insegnanti/upload/route.ts` → **solo**
   `b43a556e`; `git log --all --diff-filter=A -- src/lib/candidature/percorso-cv.ts` → **`b43a556e`**.
8. Fasce obbligatorie: `git show a9dcc6d8:src/lib/forms/insegnanti-template.ts` → campo `gradi`,
   `type: 'checkbox'`, `required: true`, tre opzioni. `git show b43a556e:…` → `POSIZIONI_OPTIONS`
   con sette voci, fra cui `collaboratrice`, `cuoca`, `segreteria`, `altro`.
9. Nessuna conferma d'invio: `git show a9dcc6d8:src/app/api/iscrizione/insegnanti/route.ts` → nessun
   invio di email; `git show b43a556e:…` → `import { messaggioConfermaCandidatura }` e
   `sendEmailDetailed`. Prima apparizione di `src/lib/email/messaggi/conferma-candidatura.ts` su
   ogni ramo: `b43a556e`.
10. Credenziali all'approvazione: `git show a9dcc6d8:src/app/api/admin/candidature-insegnanti/route.ts`
   → `ruolo: 'educator'` e `subject: 'Le tue credenziali di accesso — Kidville'`; le sole due email
   possibili verso chi si candidava erano quella e `'Esito della tua candidatura — Kidville'`.
11. Guscio comune: `git grep -n "RootProviders" main -- src/app/layout.tsx` e
    `git grep -n "ChunkErrorBoundary" main -- src/` → montato nel layout radice, sotto cui
    `/lavora-con-noi` sta direttamente.
12. Buco di un'ora: `git log -1 --format='%B' ddfe3b0e` — misura riportata con la chiave `anon`,
    `GET /rest/v1/candidature_sedi` che risponde con le righe, 18 righe lette dal service-role,
    `SECURITY DEFINER` senza `REVOKE`, e chiusura in produzione.
13. Promessa rimasta a schermo: `messages/it/public.json`, chiave `candContestoCredenziali`,
    invariata da `a9dcc6d8` fino a `main` di oggi, mentre `fcc51fc8` toglieva l'invio; e la chiave è
    effettivamente resa —
    `git show main:src/components/features/public/CandidaturaInsegnanteWizard.tsx | grep -n candContestoCredenziali`
    → **riga 1907**.

Nessun dato personale in questo file: nessun nome, nessun indirizzo, nessun codice fiscale. Gli
unici numeri sono conteggi.
