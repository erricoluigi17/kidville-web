# Flow Maestro — percorsi utente reali sull'app nativa Kidville

Questi flow guidano l'**app nativa** (`appId` = `it.kidville.app`), non il sito nel browser
del telefono. Sono quelli che usano `tester-opus-mobile-android` e `tester-opus-mobile-ios`
dentro la pipeline `/ship-cycle`.

| Flow | Percorso |
|---|---|
| `android-percorso-genitore.yaml` | login → dashboard → **presenze** → **comunica un'assenza** → verifica in elenco → **annulla** → verifica sparita → **comunicazioni** → tasto Indietro |
| `android-percorso-docente.yaml` | login → dashboard → **appello** → **bacheca** |
| `android-percorso-segreteria.yaml` | login → dashboard (cockpit) → tab **Avvisi** → Indietro → tab **Mensa** → Indietro → **Menu** (bottom-sheet) → **Anagrafica** → Indietro |
| `ios-percorso-genitore.yaml` | login → dashboard → **presenze** → **comunica un'assenza** → verifica in elenco → **annulla** → verifica sparita → **comunicazioni** → ritorno home |
| `ios-percorso-docente.yaml` | login → dashboard → **appello** → **bacheca** |
| `ios-percorso-segreteria.yaml` | login → dashboard (cockpit) → tab **Avvisi** → tab **Mensa** → **Menu** (bottom-sheet) → **Anagrafica** → tab **Home** |

> 🔴 **I due percorsi genitore SCRIVONO su dati veri.** Fanno un POST e poi la DELETE su
> `/api/parent/presenze/comunica-assenza`: una riga in `presenze` per l'alunno dell'account
> TEST, sul database di **produzione**. L'annullamento è parte del percorso, non un extra, e
> l'ultima asserzione — l'elenco che torna vuoto — è la **prova** che la riga è stata disfatta.
> Se un flow muore in mezzo, la comunicazione resta: si annulla a mano da
> *Menu → Assenze e giustifiche → ANNULLA*. Due precondizioni d'ambiente, dichiarate in testa
> ai flow: l'elenco dev'essere vuoto alla partenza, e l'appello di oggi non dev'essere ancora
> registrato per quell'alunno (altrimenti il server risponde 409 e il rosso è corretto).

> **Quale di questi flow è stato davvero eseguito, e quando**, sta nel registro `ESECUZIONI_VERDI`
> del lock (`__tests__/architecture/maestro-flows-selettori.test.ts`) — con data, dispositivo ed
> esito. I flow senza un'esecuzione verde da esibire sono elencati lì accanto, con il motivo: al
> **2026-08-07** sono `android-screenshot-playstore.yaml` e i **due percorsi genitore**, riscritti
> quel giorno e non rieseguiti perché il server di collaudo `:3100` non aveva accesso al database
> (chiave Supabase non registrata, `/api/health` → 503, nessun account supera il login).
> Il tetto del debito è salito da 1 a 3 per questo: torna a 1 quando i due girano su device.

> **Segreteria/Direzione (cockpit `/admin`).** Da questo ciclo il cockpit naviga come genitore e
> docente: una **bottom-nav a pillola** su mobile (Home · Avvisi · Contabilità · Mensa + un
> bottone **`Menu`** che apre un bottom-sheet con le altre sezioni, Anagrafica in evidenza) al
> posto del vecchio **drawer laterale**, ormai rimosso. Il tab `Menu` ha aria-label
> `Menu · tutte le sezioni`. I flow si ancorano ai testi stabili del cockpit ri-skinnato
> (`Dashboard Direzione`, `Mensa & Cucina`, `Anagrafica Generale`) — **tranne `Mensa` e
> `Anagrafica`, che sono ambigui**: vedi «La trappola dei nodi duplicati» qui sotto. Su Android i
> "ritorni" usano il tasto Indietro hardware; su iOS, che non ce l'ha, si tocca un tab della
> bottom-nav (persistente su ogni pagina).

## La cosa da capire prima di tutto

L'app nativa è una **WebView Capacitor** che carica l'app web da `server.url`, valorizzato a
build-time dalla variabile `CAP_SERVER_URL` (`capacitor.config.ts`). Non c'è un bundle statico:
le API sono route Next.js e girano su un server.

**Conseguenza pratica: senza un server raggiungibile l'app mostra una schermata bianca.**
Non è un bug dell'app, è un errore di configurazione della prova.

- Dall'**emulatore Android**, l'host della macchina è **`10.0.2.2`** (non `localhost`).
- Dal **simulatore iOS**, l'host è **`localhost`**.

## Il nome accessibile non è il testo che vedi (la trappola «MENU»)

**Misurato il 2026-07-31, emulatore `KV-play-phone`.** I flow del genitore e del docente si
fermavano al primo passo sulla bottom-nav con `Assertion is false: "MENU" is visible`, e accanto
al selettore c'era un commento che spiegava perché doveva essere così. Il commento era falso, e
**l'app non aveva nessun difetto**: il testo «MENU» non è mai stato nell'albero.

Dump della home genitore: `HOME`, `DIARIO`, `AVVISI`, `CHAT` e — per il quinto tab —
`Menu · tutte le sezioni` `[834,1664][1039,1824]`.

Precisazione, perché conta: «MENU» **non è sempre assente**. In una seconda misura (2026-08-01,
col foglio Menu aperto) un nodo `MENU` compare nella topbar a `[94,63][322,63]` — **alto 0 px**.
Quindi il selettore è inservibile in due modi diversi: o non c'è, o c'è e non si tocca. Un
`assertVisible: "MENU"` può quindi fallire *o* passare a seconda della schermata, che è il peggio
dei casi: un flow che si comporta diversamente senza che nulla sia cambiato nell'app.

La causa **non è la WebView, è ARIA**. Il quinto tab è

```jsx
<button aria-label={t('ariaMenu')}>  <Icon/>  <span>{t('tabMenu')}</span>  </button>
```

e il calcolo del nome accessibile (*accname*, passo 2C) dice che un `aria-label`
**sostituisce** il contenuto dell'elemento. Quindi il nome esposto è l'aria-label, e il testo
dello `<span>` non compare da nessuna parte. I primi quattro tab, che sono `<Link>` **senza**
`aria-label`, prendono il nome dal contenuto — ed è per questo che si toccano per testo.

Due dettagli che facevano sembrare vera la teoria sbagliata:

- «MENU» non è nemmeno la stringa del catalogo: `tabMenu` vale **«Menu»**, la maiuscola è
  `text-transform: uppercase`;
- Chromium applica il `text-transform` **anche al nome accessibile**, per questo il dump mostra
  `HOME` e non `Home`. Siccome il match di Maestro è **case-insensitive**, per il selettore non
  cambia nulla: cambia solo che «MENU» sembrava plausibile.

### La regola

> **Se il nodo ha un `aria-label`, il selettore è l'`aria-label` — non l'etichetta che si legge
> a schermo.** In dubbio: `maestro hierarchy` e si guarda il nome, non la grafica.

Il lock `__tests__/architecture/maestro-flows-selettori.test.ts` la tiene ferma in due modi
diversi: **R4** vieta i selettori già *misurati* come assenti («MENU», «Menu»), **R8** legge il
codice dei tre `BottomNav` e vieta di cercare il testo che un `aria-label` copre — anche per un
tab nuovo, mai misurato. Se un giorno l'`aria-label` sparisce dal bottone, R8 diventa rosso da
solo e chiede di rimisurare.

## La trappola dei nodi duplicati (leggila prima di dare la colpa all'app)

**Misurato il 2026-07-31, emulatore Android.** `android-percorso-segreteria.yaml` faceva
`tapOn: "Mensa"` e **non navigava**. Non era un bug dell'app: nell'albero di accessibilità della
WebView esistevano **due** nodi con testo esattamente `Mensa` —

1. la **tile della griglia «Tutti i moduli»**, in fondo alla dashboard: **fuori viewport,
   schiacciata a `y=1857` con altezza 0**;
2. il **tab vero** della bottom-nav.

**Maestro prende la prima corrispondenza**, non la prima *visibile*. Il tap finiva su un'area
morta. Il tap a coordinate (`point: "68%,93%"`) funzionava al primo colpo: la prova che l'app
era sana. Identica causa sul tap `Anagrafica` dentro il bottom-sheet — la tile omonima resta
nell'albero **dietro** il foglio modale.

### Perché fa perdere mezza giornata

Perché ha **due facce**, e la seconda è peggiore:

- **rumorosa** — il passo successivo va in timeout e il flow fallisce. Fastidiosa ma onesta:
  è così che l'abbiamo trovata.
- **silenziosa** — se il testo atteso dopo il tap **esiste anche nella pagina di partenza**,
  l'asserzione passa lo stesso e il flow dichiara `PASS` **senza essersi mai mosso**. È già
  successo: `android-screenshot-playstore.yaml`, trappola 1, catturava la schermata sbagliata.

Da qui la regola: **dopo un tap "cieco" (a coordinate) servono DUE asserzioni** — una
**positiva** (un testo che esiste solo a destinazione) e una **negativa** (un testo che esiste
solo nella pagina di partenza, che ora non deve più esserci). Con una sola, un tap che non
naviga può ancora passare.

### Vederlo con i propri occhi

```bash
maestro hierarchy | grep -n -i "mensa"     # quante volte compare? con che bounds?
maestro studio                             # e chi tocca Maestro quando gli dici "Mensa"
```

Un nodo con `bounds` di altezza 0 o fuori schermo è un nodo **morto**: se compare prima di
quello buono, il tuo `tapOn` per testo sta toccando lui.

### Le etichette già note come ambigue

| Schermata | Etichetta | L'altro nodo |
|---|---|---|
| `/admin` (cockpit) | `Mensa` | tile della griglia «Tutti i moduli» |
| `/admin` (cockpit) | `Anagrafica` | tile della griglia «Tutti i moduli», dietro il foglio Menu |
| Home genitore | `Diario` · `Avvisi` · `Chat` | scorciatoie della home (es. «DIARIO DI OGGI») |
| Home genitore | `Avvisi` | **misurato 2026-08-07**: due nodi, il tab a `[506,1803][572,1834]` e uno a `[0,0][0,0]` |
| Home genitore | `Comunicazioni` | **misurato 2026-08-07**: due nodi, **entrambi** `[0,0][0,0]` |
| Home genitore | `Comunica un’assenza` | l'azione rapida della home (`home.json → azioneAssenza`, «Comunica\nun’assenza», che l'accname appiattisce): stesso testo del titolo di `/parent/attendance`. Fino al 2026-08-08 erano entrambe «Segnala assenza»: il nome è cambiato, la trappola no — sono state cambiate INSIEME apposta |

**Il 2026-08-07 questa trappola ha prodotto la sua faccia peggiore su un flow committato.**
`android-percorso-genitore.yaml` dichiarava `COMPLETED` la tappa «Comunicazioni» **senza mai
aprirla**: il `tapOn: "Avvisi"` finiva sul nodo a dimensione zero, cioè nell'angolo `(0,0)`, e
`assertVisible: "Comunicazioni"` era soddisfatto da un secondo nodo fantasma della home. Nessun
errore, nessun timeout: solo tre righe `COMPLETED` e uno screenshot che mostrava la home. Di
conseguenza anche la tappa del tasto Indietro collaudava un `back` dalla home alla home.

La correzione, e la regola che ne è nata (R16-R17 del lock):

- **un'asserzione di arrivo non può essere un'etichetta che esiste anche dove si partiva.** Si usa
  un testo della sola pagina di destinazione — per `/parent/avvisi` è il **sottotitolo
  dell'intestazione**, che sta sopra la piega e ha tre facce a seconda dei dati
  (`avvisi.json → sottotitoloDaGestire · sottotitoloOk · sottotitoloCaricamento`): vanno coperte
  **tutte e tre** in un'unica ancora alternata, altrimenti il flow è rosso nei giorni in cui non
  c'è niente da gestire;
  > ⚠️ **Correzione del 2026-08-08.** Fino a ieri qui era scritto di usare
  > «Le prese visione vengono registrate automaticamente.» (`footerRiga2`). Era una prova che
  > **non poteva passare**, per due ragioni indipendenti: sta in fondo alla pagina (`[0,0][0,0]`
  > su Android, assente dall'albero su iOS) **e** `footerRiga1`/`footerRiga2` sono rese nello
  > stesso paragrafo separate da `<br/>`, quindi il nodo porta il testo **unito** e il full-match
  > sulla sola seconda riga fallisce anche in viewport. Il tap atterrava davvero: era
  > l'asserzione ad accusare l'app.
- **e serve la prova NEGATIVA**, un testo che esiste solo sulla pagina di partenza — e che **sulla
  pagina di partenza si vede davvero**: per la home è l'hero «Ecco le novità di oggi 🌈», non
  «Prossimi appuntamenti».
  > ⚠️ **Correzione del 2026-08-08, e va letta perché smentisce il ragionamento scritto qui
  > sotto.** La vecchia versione diceva: «se il tap non è atterrato, il nodo fantasma è ancora lì
  > e l'`assertNotVisible` fallisce; lo stesso nodo che prima rendeva la tappa verde a torto ora
  > la rende rossa a ragione». **Falso, misurato:** un nodo fantasma è fantasma proprio perché è
  > `[0,0][0,0]`, e Maestro non lo considera visibile — `assertNotVisible` su di lui passa
  > **sempre**, anche restando fermi sulla home (`/tmp/kv-and-vacuita.yaml`, 17/17 COMPLETED). La
  > proprietà che doveva far fallire l'asserzione è esattamente quella che la rende vacua. La
  > coppia positiva+negativa resta giusta; il testo scelto no;
- sul **tap**, dove i bounds sono misurati (Android), si aggiunge la guardia dimensionale
  `width`/`height`/`tolerance`: un nodo `0×0` non corrisponde più. Su iOS **non** si mette, perché
  lì i bounds dei nodi fuori schermo non sono mai stati misurati e un numero inventato sarebbe una
  difesa finta.

### La stessa trappola, altra faccia: le CTA sotto la piega

**Misurato il 2026-07-31, flow docente.** Tornando dall'appello, la dashboard resta scrollata
dov'era: la CTA «Apri la bacheca» finisce **fuori dal viewport** e la WebView la proietta a fondo
pagina schiacciata — `[438,1857][643,1857]`, larga 205 px e **alta 0**.

Il punto è che `extendedWaitUntil: visible` **passa lo stesso**, perché il nodo esiste; Maestro
dichiara il tap `COMPLETED`, e il tocco cade su un'area morta. Non è un nodo duplicato: è **un
nodo solo, non toccabile** — e produce lo stesso identico sintomo.

> **Regola:** una CTA che sta sotto la piega si porta prima nel viewport con
> `scrollUntilVisible` (+ `centerElement: true`), e **dopo** il tap si prova di essersi mossi con
> un'asserzione **negativa** sulla pagina di partenza.

Lock: **R7** conosce le CTA già misurate sotto la piega e pretende entrambe le cose.

### Terza faccia: il nodo **coperto** (perché `centerElement: true` non è un vezzo)

**Misurato il 2026-08-01, flow biometria.** `scrollUntilVisible` senza `centerElement` si ferma
appena il nodo **entra** nel viewport — e in fondo al viewport c'è la **bottom-nav flottante**:

```
'PROFILO E DELEGHE'      [254,1727][553,1782]
'Navigazione principale' [31,1664][1047,1824]   ← la pillola, sopra di essa
```

Il tap è risultato `COMPLETED` ed è finito sul tab **«Diario»**: il foglio è rimasto aperto, la
pagina sotto è cambiata, e il flow ha dichiarato che l'app non mostra la sezione biometrica.
**L'app la mostrava**: con `centerElement: true` il passo successivo trova
`SBLOCCO CON FACE ID / IMPRONTA` al primo colpo.

E l'asserzione negativa va scelta con la stessa cura di quella positiva: qui **il selettore stesso
non serve**, perché «PROFILO E DELEGHE» è anche il *titolo* della pagina di destinazione — sarebbe
rossa anche a navigazione riuscita. Si usa l'occhiello del foglio, «TUTTE LE SEZIONI», che esiste
solo mentre il foglio è aperto.

**E l'albero mente sull'area toccabile.** Sulla voce «Avvisi e comunicazioni» del foglio docente
(`[254,1632][580,1672]`) `uiautomator` colloca la bottom-nav a `y≥1664`: sembrerebbero liberi
30 px. Il DOM dice il contrario — `document.elementFromPoint` su quel punto restituisce il
`<a href="/teacher/diary">`, e il **contenitore** della nav parte a `y=1605` device: l'albero
espone il `<nav>` interno, non il suo padding. Il tap si perde anche con `adb shell input tap`,
quindi non è un difetto di Maestro. In pratica: **gli ultimi ~250 px sono zona morta** per
qualunque cosa stia sotto un overlay flottante.

Tre cause diverse, un solo sintomo — «il tap risulta eseguito e non succede niente»:

| Causa | Come si riconosce | Rimedio |
|---|---|---|
| nodo **duplicato** | `maestro hierarchy` mostra due volte lo stesso testo | selettore univoco o tap a coordinate |
| nodo **alto 0** | `bounds` con `y1 == y2`, fuori viewport | `scrollUntilVisible` |
| nodo **coperto** | `bounds` dentro (o **vicini a**) quelli di un overlay: verifica con `document.elementFromPoint` via CDP, non con l'albero | `scrollUntilVisible` **+ `centerElement: true`** |

### E una quarta, che non è di layout: il **contenuto condizionale**

La CTA «Apri la bacheca» esiste solo se `avvisiRecenti.length > 0`
(`src/app/(dashboard)/teacher/page.tsx:242`). Il 2026-08-01 c'era alle 00:27 e non c'era alle
00:45: stessa app, stesso account, dati diversi. Un flow che la dà per scontata fallisce con
«No visible element found» e **sembra una regressione**.

> **Regola:** il percorso principale di un flow passa da ciò che **non dipende dai dati** (il
> foglio «Menu»). Ciò che dipende dai dati si prova in un ramo `runFlow: when:`, e la condizione
> del ramo alternativo guarda la **destinazione** — non la CTA — così i due rami non si
> sovrappongono mai.

### Le tre strade, e quale abbiamo scelto

| Strada | Verdetto |
|---|---|
| `point: "68%,93%"` | **Scelta.** È l'unica variante **misurata** su questa WebView. Fragile ai cambi di layout — per questo va accompagnata dalle due asserzioni di cui sopra, che la fanno fallire **forte** invece che in silenzio. |
| `childOf` la `<nav>` / `rightOf` il tab accanto | Più semantica, ma **non provata** su questo runtime: un selettore mai misurato resta un'ipotesi, e se sbaglia il flow muore con «Element not found». *(La vecchia motivazione diceva che le due bottom-nav — genitore e cockpit — esponevano gli attributi ARIA in modo opposto: **falso**, si comportano allo stesso identico modo. Vedi «Il nome accessibile non è il testo che vedi»; la frase esatta e la misura che la smentisce stanno nel registro `AFFERMAZIONI_SMENTITE` del lock.)* |
| `aria-label` univoco sui 4 tab | **La strada definitiva** — ma tocca `src/`. È una proposta aperta: dando ai tab un `aria-label` tipo `Mensa · sezione` sparirebbe l'ambiguità e i flow tornerebbero a selettori di puro testo, su tutte le piattaforme. |

Geometria del tap, se un giorno la coordinata va rifatta: la bottom-nav ha **5 voci a larghezza
uguale** (`flex-1`) → centri a **10 / 30 / 50 / 70 / 90 %** della larghezza; la pillola è alta
**60 px** ed è agganciata sopra la safe-area, quindi **`y=93%`** ci cade dentro sia su Android
sia su iPhone. Vale **solo sul telefono**: sopra i 1024 px la bottom-nav è `lg:hidden` e c'è la
sidebar.

## Le due piattaforme tagliano la pagina in due modi diversi

**Questa sezione è la conoscenza che è costata due cicli di collaudo.** Fino al 2026-08-07 questo
file descriveva il comportamento **Android** e **taceva su iOS**, e i flow iOS sono stati scritti
col modello Android. Il risultato: due bloccanti, su due piattaforme, per **due cause diverse**
che producono lo **stesso rosso su un'app sana**.

Il fatto, misurato lo stesso giorno su entrambe:

| | Android (WebView Chromium) | iOS (WKWebView) |
|---|---|---|
| Un nodo **fuori dal viewport** | **c'è**, proiettato a `bounds="[0,0][0,0]"` | **non c'è**: l'albero XCUITest espone **solo il viewport** |
| `assertVisible` su quel nodo | fallisce (Maestro non considera visibile un nodo 0×0) | fallisce (l'elemento non esiste) |
| `assertNotVisible` su quel nodo | **passa sempre** → asserzione **vacua** | **passa sempre** → asserzione **vacua** |
| Come lo si vede | `adb shell uiautomator dump` e si leggono i `bounds` | `maestro hierarchy`: il nodo **manca**, e ricompare dopo `- scroll` |

Le misure, per esteso, perché senza numeri questa tabella è un'opinione:

- **Android, home genitore:** `text="PROSSIMI APPUNTAMENTI" bounds="[0,0][0,0]"`. Controprova
  sullo stesso blocco: «NESSUN APPUNTAMENTO IN PROGRAMMA» (identico 0×0) **fallisce**, mentre
  «OGGI A SCUOLA» (`[49,1241][328,1291]`) **passa**.
- **Android, `/parent/attendance`:** `text="ASSENZE GIÀ COMUNICATE" bounds="[0,0][0,0]"` senza
  scroll, `[105,1257][976,1336]` dopo uno swipe.
- **iOS, home genitore:** a scroll zero l'albero contiene **43 nodi di testo**, l'ultimo dei quali
  è «LA GIORNATA DI ALUNNO2» a `[20,860][200,882]` su uno schermo alto **874**. «PROSSIMI
  APPUNTAMENTI»: **0 occorrenze in 3 dump consecutivi**; dopo lo scroll, `[20,630][199,652]`.
- **iOS, `/parent/attendance`:** la *zona* c'è («ASSENZE GIÀ COMUNICATE, zona» `[16,786][386,964]`)
  ma la frase dell'elenco vuoto **non è nell'albero**; dopo `- scroll` compare a
  `[40,715][311,752]`.

**Riprodotto di prima mano il 2026-08-08** (iPhone 17 Pro / iOS 26.2, Maestro 2.6.1), stando
**sulla home**, cioè sulla pagina che quel titolo lo contiene:

```
assertVisible    ".*Prossimi appuntamenti.*"  → FAILED      ← il gate del flow, su un'app sana
assertNotVisible ".*Prossimi appuntamenti.*"  → COMPLETED   ← la prova di "ho lasciato la home"
scrollUntilVisible + centerElement, poi assertVisible → COMPLETED   ← il rimedio
```

La stessa ancora è **falsa in un verso e vacuamente vera nell'altro**: è la firma di questa
classe di difetto, e il modo più rapido per riconoscerla senza leggere un dump.

Il caso peggiore non è il rosso: è il **verde per caso**. Il gate della dashboard iOS
(«Prossimi appuntamenti») è passato **1 volta su 3** — e la volta buona perché, subito dopo il
login, le card asincrone non avevano ancora allungato la pagina e per qualche centinaio di
millisecondi quel titolo era davvero nel viewport. Una finestra che si chiude quando i dati
arrivano: il flow non collaudava l'app, collaudava chi arrivava primo.

> **Le tre regole che ne seguono, e valgono su tutte e due le piattaforme:**
>
> 1. **Un'ancora si sceglie sopra la piega.** Per la home del genitore è l'hero
>    «Ecco le novità di oggi 🌈» (`home.json → heroSottotitolo`, misurato su iOS a
>    `[36,304][183,320]`, 3 dump su 3), non l'ultima sezione della pagina.
> 2. **Se l'ancora sta sotto la piega, prima la si porta nel viewport** con `scrollUntilVisible`
>    (+ `centerElement: true`), e questo vale anche — soprattutto — per le asserzioni
>    **negative**: una prova negativa fatta dove il nodo non si vedrebbe comunque è vera in ogni
>    caso, cioè non è una prova.
> 3. **Dopo aver scrollato per guardare l'elenco, per toccare la CTA che sta sopra bisogna
>    risalire** (`direction: UP`): sotto lo scroll, la CTA è a sua volta fuori viewport.

Lock: **R22** conosce le ancore già misurate fuori dal viewport, vieta di ancorarci
un'asserzione negativa (vacuità) e pretende lo scroll davanti a quella positiva.

### E una regola che nasce dalla stessa giornata: l'ancora che non può essere vera

Il gemello del difetto vacuo è l'asserzione che **non può essere vera su nessuna pagina**:
`assertNotVisible: ".*Tutte le sezioni.*"` combacia sempre con l'`aria-label` del quinto tab,
«Menu · tutte le sezioni», perché il match di Maestro è **full-match ma case-insensitive** e la
bottom-nav sta su **ogni** schermata. Il flow dichiarava `FAILED` con l'app perfettamente sana.

Riprodotto il 2026-08-08 sulla home, foglio Menu **chiuso**, nello stesso istante:

```
assertNotVisible ".*Tutte le sezioni.*"     → FAILED       ← l'ancora di ieri
assertNotVisible ".*Scrivi alle maestre.*"  → COMPLETED    ← la sostituta
```

e col foglio **aperto** la sostituta → `FAILED`. Un'ancora negativa si sceglie così: si guarda
che **morda** quando deve e che **taccia** quando deve. Una sola delle due prove non basta —
è come si è arrivati a scriverne una che non poteva essere vera da nessuna parte. Nell'albero
i due nodi sono `'Menu · tutte le sezioni' [311,779][386,839]` (il tab, sempre) e
`'TUTTE LE SEZIONI' [37,162][123,175]` (l'occhiello, solo a foglio aperto).

E il terzo della famiglia: l'ancora **ingoiata da una voce più lunga dello stesso catalogo**.
`.*Assenza comunicata.*` (`parentServizi.json → attendanceInviataTitolo`) è interamente contenuta
in «Annulla l'assenza comunicata per il {data}» (`attendanceAnnullaAria`), cioè
nell'`aria-label` del bottone ANNULLA di una riga **già in elenco**. Misurato: `COMPLETED` **174 ms
dopo il tap**, con lo screenshot di 76 ms più tardi che mostrava il bottone ancora in «INVIO…» —
il flow dichiarava riuscito un POST ancora in volo.

> **Regola:** un'ancora non può essere una **sottostringa** di un altro testo che può stare a
> schermo nello stesso momento — né di un `aria-label` persistente, né di un'altra voce dello
> stesso catalogo i18n. In dubbio, si ancora la regex (`"Assenze già comunicate"` senza `.*`)
> oppure si sceglie un testo che solo quella schermata produce.

Lock: **R21** (aria-label persistenti) e **R23** (voci omonime dello stesso catalogo).

## Il lock — cosa può fermare, e cosa no

**`__tests__/architecture/maestro-flows-selettori.test.ts`** gira in ogni `vitest run`, **senza
emulatore**: è statico di proposito, perché device, server e credenziali non stanno nel repo e un
controllo che gira solo «quando qualcuno accende un emulatore» non protegge niente.

| Regola | Cosa impedisce |
|---|---|
| **R1** | toccare `Mensa`/`Anagrafica` per solo testo sul cockpit (etichette ambigue) |
| **R2** | che R1 resti verde **cancellando** i passi invece di correggerli |
| **R3** | un tap a coordinate senza prova di essere atterrato **e** di essersi mosso |
| **R4** | che un selettore già **misurato assente** («MENU», «Menu») rientri in un flow |
| **R5** | che un selettore vivo si scolli dal catalogo i18n che lo genera |
| **R6** | che R4 resti verde per cancellazione dei passi |
| **R7** | toccare un nodo noto come non-toccabile (alto 0 / coperto) senza scroll, senza `centerElement` e senza prova di essersi mossi |
| **R8** | cercare un testo che un `aria-label` **copre** — legge i `BottomNav` in `src/` |
| **R9** | che un flow dipenda da un selettore **mai misurato** senza dichiararlo |
| **R10** | che un commento ripeta una **teoria già smentita** da una misura |
| **R21** | un'asserzione **negativa** che cade su un `aria-label` presente su ogni pagina: non può essere vera da nessuna parte |
| **R22** | un'asserzione **negativa** su un nodo misurato **fuori viewport** (è vacua: vera anche stando fermi) e una **positiva** senza lo scroll che ce lo porta |
| **R23** | un'ancora **ingoiata** da una voce più lunga dello stesso catalogo i18n (la conferma dell'invio contro l'`aria-label` del bottone ANNULLA) |

**Cosa NON può fare**, e va detto: non sa se una misura di ieri vale ancora oggi, non vede un
cambio di comportamento della WebView con una nuova versione di Android, non esegue nulla su un
device. R9 in particolare **non impedisce** di aggiungere un selettore inventato: obbliga a
scriverlo nell'elenco dei «non misurati», dove si vede in diff, invece di nasconderlo in un
commento che afferma il falso — che è esattamente com'è andata con «MENU».

## Credenziali — mai dentro un file

I flow leggono le credenziali da variabili d'ambiente. **Non scriverle nei YAML**: questo
repository è stato pubblico fino al 2026-07-26.

La password degli account TEST ha una sola sorgente in tutto il repo — la variabile
**`KV_TEST_PASSWORD`**, la stessa che usano gli script di collaudo
(`e2e/lib/test-password.mjs`). I flow Maestro la ricevono da lì:

```bash
export KV_TEST_PASSWORD='…'                        # gestore di credenziali del titolare
.claude/maestro-flows/esegui.sh ios-percorso-genitore.yaml
```

**I flow si lanciano SEMPRE da `esegui.sh`, mai con `maestro test` a mano.** Non è una
preferenza di stile: Maestro scrive la password **in chiaro** dentro
`~/.maestro/tests/<run>/maestro.log`, e non esiste un modo, lato flow, di impedirglielo.
Verificato il 2026-08-01 con due canarini finti: finisce nel log sia il valore passato
come variabile d'ambiente, sia quello passato con `-e NOME=valore`, e in più Maestro
logga da sé il testo che digita (`Inputting text: <password>`). Qualunque cosa si faccia
con le variabili, quella riga resta.

L'unica difesa è la **bonifica dopo l'esecuzione**, ed è dentro `esegui.sh`: agganciata a
`trap … EXIT INT TERM`, quindi gira anche su flow fallito o Ctrl-C. Maschera per valore
**e per forma**, così copre anche le password già ruotate rimaste nei run vecchi — il
1° agosto 2026 erano 70 file con la password corrente e altre 156 righe con password
storiche, tutte prodotte da esecuzioni lanciate a mano seguendo la versione precedente
di questo file. Lo script si occupa anche di `--device` (con due dispositivi attivi
Maestro aggancia il primo che trova) e del timeout del driver XCUITest.

La bonifica si può lanciare anche da sola, senza eseguire nessun flow — utile dopo aver
recuperato dei log vecchi, o per ripulire lo storico dopo una rotazione della password:

```bash
export KV_TEST_PASSWORD='…'
.claude/maestro-flows/esegui.sh --solo-bonifica
```

**Perché maschera per CLASSE di nome e non per elenco (misurato il 2026-08-02).** Fino a
quel giorno la maschera per forma conosceva un nome solo, `MAESTRO_KV_PASSWORD=`. Ma i
flow non usano quella variabile direttamente: la ri-dichiarano nel proprio blocco `env:`
con un altro nome — `KV_PASSWORD: ${MAESTRO_KV_PASSWORD}`, in tutti e 10 gli YAML — e
Maestro logga anche quella. Conteggio su `~/.maestro/tests` quel giorno: **0 occorrenze**
di `MAESTRO_KV_PASSWORD=` in chiaro e **211 di `KV_PASSWORD=`**. Non si vedeva perché la
maschera per valore prendeva comunque la password del giorno; si sarebbe visto alla
rotazione successiva, sui log di prima, quando non c'è più nessun valore da inseguire.
Era la stessa lezione già scritta nel file — *«una pulizia che insegue UN valore è cieca
su tutti gli altri»* — applicata a metà: corretto l'elenco dei valori, lasciato un elenco
chiuso di nomi. Ora la maschera copre il valore di **qualunque** variabile il cui nome
finisca per `PASSWORD`, `PASSWD`, `PWD`, `SECRET`, `TOKEN`, `KEY`. Guarda `=` e non `:`
di proposito: `pressKey: ENTER` finisce per `KEY`, e serve a capire un flow fallito.

Gli account TEST vivono in **produzione** sulle sezioni "TEST Infanzia" / "TEST 1A"
(sede Kidville Giugliano): la loro password è un segreto vero, non un valore di comodo.
L'elenco degli account sta nel PRD (sezione «Classi di prova»); **la password non sta in
nessun file** — è stata ruotata il 2026-07-26 e vive solo nel gestore di credenziali del
titolare. Il lock `__tests__/architecture/niente-password-nel-repo.test.ts` fallisce se
qualcuno la riscrive in un file tracciato.

## Preparazione

```bash
# Maestro (una tantum)
curl -fsSL "https://get.maestro.mobile.dev" | bash
export PATH="$PATH:$HOME/.maestro/bin"
maestro --version

# Controllo di sintassi — NON serve nessun dispositivo, dura un secondo:
for f in .claude/maestro-flows/*.yaml; do maestro check-syntax "$f"; done
```

> `check-syntax` boccia davvero (un comando inesistente esce con
> `Invalid Command: … at /syntax-checker:<riga>`), quindi un `OK` vale qualcosa. Verifica la
> **grammatica**, non il comportamento: un selettore sbagliato passa il controllo e fallisce
> sul device.

### Android

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"  # Gradle 8.14 vuole la JDK 21

emulator -list-avds
emulator -avd <AVD> -no-snapshot-load -no-boot-anim &
adb wait-for-device

npm run dev &                                     # host, porta 3000
# ⚠️ Questo sync AVVELENA la shell nativa: `capacitor.config.json` è gitignorato,
#    quindi né `git status`, né una revisione, né la CI vedranno che punta a un indirizzo
#    di sviluppo. Dal 2026-08-08 al 2026-08-14 è rimasto così per sei giorni.
#    QUANDO HAI FINITO, rimettila a posto:  npm run rilascio:sync
CAP_SERVER_URL="http://10.0.2.2:3000" npx cap sync android
(cd android && ./gradlew assembleDebug)
adb install -r android/app/build/outputs/apk/debug/app-debug.apk

.claude/maestro-flows/esegui.sh android-percorso-genitore.yaml
```

### iOS (solo Mac con Xcode)

```bash
xcrun simctl list devices available | grep -i iphone
xcrun simctl boot "iPhone 17 Pro"
open -a Simulator

# ⚠️ `next start`, MAI `next dev` — vedi sotto: è la differenza fra tre flow rossi e tre verdi.
npm run build && npx next start -p 3100 &
# ⚠️ Questo sync AVVELENA la shell nativa: `capacitor.config.json` è gitignorato,
#    quindi né `git status`, né una revisione, né la CI vedranno che punta a un indirizzo
#    di sviluppo. Dal 2026-08-08 al 2026-08-14 è rimasto così per sei giorni.
#    QUANDO HAI FINITO, rimettila a posto:  npm run rilascio:sync
CAP_SERVER_URL="http://localhost:3100" npx cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -sdk iphonesimulator -configuration Debug \
  -derivedDataPath ios/DerivedData CODE_SIGNING_ALLOWED=NO build
xcrun simctl install booted ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app

.claude/maestro-flows/esegui.sh ios-percorso-genitore.yaml
```

> 🔴 **Su iOS i flow si collaudano su `next start`.** È una raccomandazione prudenziale, e la
> distinzione conta: i tre flow iOS erano rossi il 31 luglio su dev server e sono verdi il
> 2 agosto su `next start` (segreteria 33/33, genitore 27/27, docente 27/27, due esecuzioni su
> due) — ma nel mezzo il commit `462630c` del 1° agosto ne ha **riscritto i selettori**, e già il
> 1° agosto erano passati verdi. Fra il rosso e il verde sono cambiate due cose: da questi dati
> non si isola una causa sola. Che il dev server sia inadatto è invece **misurato su Android**
> («l'emulatore non idrata `next dev`», PRD 17 luglio).
>
> Quello che il 2 agosto è stato misurato davvero, e che vale per entrambe le piattaforme: **un
> server avviato su una build poi sostituita** serve HTML con chunk che non esistono più → niente
> CSS → React non idrata → i campi restano vuoti e «Accedi» risulta `COMPLETED` senza inviare
> nulla, lasciando a schermo «Please fill out this field». Il flow muore passi dopo, su
> un'asserzione che parla d'altro. Un `next build` non lo ripara: **serve riavviare il server.**

> Capacitor 8 usa Swift Package Manager: si builda con `-project`, **non** con `-workspace`.
> `App.xcworkspace` non esiste.

## Trappole già pagate (non ripagarle)

- **`npm run dev | head -N` ammazza il server** (SIGPIPE). Mai una pipe sul dev server.
- **Al login lascia respirare la pagina ~3 s** prima di digitare: l'hydration di Next svuota
  gli input se scrivi troppo presto. Nei flow lo fa `extendedWaitUntil`.
- **`osascript` è bloccato dal TCC** sul simulatore iOS: usa `xcrun simctl`.
- **`repeat: times: N` rende la prova non dimostrabile.** Maestro AGGREGA le iterazioni in una
  riga sola (`Repeat 6 times... COMPLETED`, con i comandi elencati una volta): il log di un flow
  girato sei volte è **indistinguibile** da quello di un flow girato una volta. Misurato il
  2026-08-02 sulla prova dei sei login (S28), dove contare le esecuzioni *era* la prova. Quando
  il numero di ripetizioni è ciò che si deve dimostrare, si lancia il flow N volte da fuori:
  N log, N esiti, N conteggi.
- **`os.Logger` scrive a livello `info`, e `log stream` di default non lo mostra.** Senza
  `--level info` il comando gira, filtra e produce **zero righe** — che si legge come «il codice
  non ha loggato niente» quando invece è «non stavi guardando». Misurato il 2026-08-02: la prima
  cattura dei sei login sembrava dire che il filtro sugli annullamenti non era mai stato
  agganciato. Il comando giusto è
  `xcrun simctl spawn <UDID> log stream --level info --predicate 'subsystem == "it.kidville.app" AND category == "webview"'`.
- **Con un emulatore Android attivo, i flow iOS vanno lanciati SEMPRE con `maestro --device <UDID-iOS>`.** Senza `--device`, Maestro aggancia il primo dispositivo che trova — di solito l'emulatore Android già avviato — e il flow iOS finisce sul device sbagliato (schermata bianca o passi che non matchano). L'UDID del simulatore booted si legge con `xcrun simctl list devices booted`.
- **La JDK di sistema è la 25**, Gradle 8.14 non la digerisce ("Unsupported class file major
  version 69"): serve la JBR 21 di Android Studio.
- 🔴 **L'emulatore perde il DNS e sembra che l'app rifiuti le credenziali.** Misurato il
  2026-08-01: il login mostrava *«Credenziali non valide»* con la password giusta. Le stesse
  credenziali via API rispondevano `HTTP 200`. Dentro la WebView (CDP → `Runtime.evaluate`):
  `fetch` al server locale `HTTP 200`, `fetch` a Supabase **AbortError dopo 8 s**. Sul device:
  `ping 8.8.8.8` **ok**, `ping google.com` → **`unknown host`**. Il resolver dell'emulatore muore
  quando la rete dell'host cambia dopo l'avvio, e `signInWithPassword` fallisce come un errore
  qualsiasi — la pagina di login mostra lo stesso messaggio per **ogni** errore, incluso quello di
  rete. Rimedio (il toggle aereo non basta):
  ```bash
  adb emu kill
  emulator -avd KV-play-phone -dns-server 8.8.8.8,1.1.1.1 -no-boot-anim &
  adb wait-for-device && adb shell ping -c1 google.com   # deve risolvere
  ```
  Prima di dare la colpa alle credenziali: **`adb shell ping -c1 google.com`**. Costa un secondo.
- I selettori sono **testi italiani della UI reale** (`Accedi`, `Menu`, `Presenze`, `Avvisi`,
  `Appello`, `Bacheca`). Se un'etichetta cambia nel codice, il flow va aggiornato **nello
  stesso lavoro** — un flow che punta a un'etichetta morta è un test che mente.
- **Un'etichetta che compare due volte a schermo non è un selettore.** Maestro prende la prima
  corrispondenza dell'albero, anche se è invisibile o alta 0 px → vedi
  «La trappola dei nodi duplicati» sopra. Nel dubbio, preferisci il **sottotitolo univoco**
  (`Alunni, famiglie e personale`, `Assenze e giustifiche`, `Rette e scadenze`) alla label.

## Rapporto con l'harness Appium esistente

Nel repo c'è già `e2e/primaria-360/native/{android,ios}-smoke.mjs`: guida gli stessi APK/`.app`
via **Appium** (serve un server Appium su `:4723`). Non è sostituito da Maestro: resta utile
come riscontro incrociato quando un risultato non convince.
