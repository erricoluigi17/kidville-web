# 🔁 Super prompt — continuare la submission in una nuova chat

> Autosufficiente. Da incollare in una chat nuova aperta su `/Users/lerri/kidville-web`.
> Aggiornato al **2026-07-26, sera**.

---

```
Riprendiamo la submission di Kidville su App Store e Google Play. Parli SOLO in italiano.

═══════════════════════════════════════════════════════════════════
PRIMA DI RISPONDERE QUALSIASI COSA — leggi in quest'ordine
═══════════════════════════════════════════════════════════════════
1. AGENTS.md e CLAUDE.md            → le regole di progetto, tutte vincolanti
2. docs/submission/README.md         → l'indice del dossier e l'ordine dei lavori
3. docs/submission/A1b-duns-richiesta.md   → D-U-N-S e conversione account Apple
4. docs/submission/C1..C5            → tutta la partita Google Play
Gli altri (A1, A2, A3) leggili quando tocchi quel pezzo, non prima.

NON rifare la ricerca: è stata fatta con 11 agenti, 3 dei quali avversariali, ed è
tutta dentro quei documenti con le fonti. Se una cosa ti sembra sbagliata, VERIFICALA
e dimmelo — ma non ripartire da zero.

═══════════════════════════════════════════════════════════════════
DOVE SIAMO — stato reale, non desiderato
═══════════════════════════════════════════════════════════════════
Prodotto: "Kidville", registro elettronico di una scuola dell'infanzia.
Next.js + Supabase, app nativa Capacitor (WebView su https://app.kidville.it).
Bilingue it/en. Tratta dati di MINORI, inclusi dati sanitari.

Titolare: SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA
P.IVA 03394870616 · REA CE 240763 · Via Silvio Pellico 7, 81030 Cesa (CE)
Tre sedi operative (Cesa, Aversa, Giugliano) sotto un'unica P.IVA.
Sito pubblico www.kidville.it (mostra ragione sociale, P.IVA e REA).

APP STORE — avanti
  ✓ scheda compilata, 12 screenshot, build 1.0(1) su TestFlight (scade 2026-10-24)
  ✓ firma di distribuzione ok, aps-environment = production
  ✗ DSA (operatore commerciale) da compilare
  ✗ App Privacy labels da compilare
  ✗ validazione legale di /privacy e /termini
  ✗ conversione account Individual → Organization

GOOGLE PLAY — scheda vuota, nulla di fatto

DECISIONI GIÀ PRESE — non riaprirle, sono del titolare
  • D-U-N-S ottenuto: 432360401. ESISTEVA GIÀ, attesa zero. Vale per ENTRAMBI gli store.
    ⚠️ NON aprirne un secondo su D&B: i duplicati bloccano la verifica ovunque.
  • Recapito pubblico: info@kidville.it — già sostituito in /privacy, /termini, /assistenza
    al posto di una Gmail personale. ⚠️ Va verificato che la casella sia presidiata.
  • Sede da usare ovunque: Via Silvio Pellico 7 (sede LEGALE).
    Mai Via Filippo Turati 2, che è operativa.
  • Ragione sociale sempre PER ESTESO: "SOCIETA' COOPERATIVA", mai "Soc. Coop."
    Apple e Google rifiutano abbreviazioni e nomi commerciali.
  • Account: ORGANIZZAZIONE su entrambi gli store, mai personale.
  • Categoria Play: Istruzione. MAI "Social" (farebbe scattare Child Safety Standards).
  • Pubblico Play: solo 18+.
  • Blocco UGC: sospensione conversazione + notifica alla Direzione, DICHIARATA.
    Spec completa in C5.

VINCOLO DI PERSONE — importante, non aggirarlo
  Il legale rappresentante della cooperativa è ERRICO CESARIO.
  L'utente (Luigi Errico) è SOCIO e agisce su DELEGA SCRITTA.
  Nelle pratiche Apple/Google NON va dichiarato legale rappresentante: la visura lo
  smentirebbe. Va dichiarata la situazione vera, con Errico Cesario come reference.

═══════════════════════════════════════════════════════════════════
STATO DEL REPO
═══════════════════════════════════════════════════════════════════
Branch: feat/dossier-submission  (creato perché il lavoro stava per finire su main)
Non committato: PRD, le 3 pagine legali (sostituzione email), docs/submission/ (nuovo)
Ultimo gate verde DOPO la modifica al codice:
  eslint 0 · tsc 0 · vitest 365 file / 3041 test · build ok
Da allora sono cambiati solo file .md.
Niente è stato committato: chiedi prima di farlo.

═══════════════════════════════════════════════════════════════════
LA CODA DI LAVORO, IN ORDINE
═══════════════════════════════════════════════════════════════════

▸ LAVORO TUO — 1. C5, ed è il vero blocco
  docs/submission/C5-sviluppo-obbligatorio.md, spec completa e già approvata.
  Prompt dedicato pronto: docs/submission/prompts/prompt-c5-sviluppo.md
  Tre cose: pagina pubblica /cancellazione-account · segnalazione contenuti e utenti ·
  sospensione conversazione con notifica alla Direzione · gate dei Termini non saltabile.
  È l'unica parte che non corre in parallelo a nient'altro.
  ⚠️ Il gate dei Termini chiude anche la lacuna E di A3: oggi i Termini non li accetta
  nessuno, quindi la clausola di limitazione di responsabilità non produce effetto.

▸ LAVORO TUO — 2. Build .aab firmato (C2, ~1 ora)
  ⚠️ PRIMA chiudi il buco: in android/.gitignore le regole *.jks e *.keystore sono
  COMMENTATE e il .gitignore di radice non le ha. Un keytool nel posto ovvio + git add
  committa la chiave di upload senza un avviso.
  Poi: keystore fuori dal repo, keystore.properties gitignorato, signingConfig che legge
  da env-poi-file, e la sequenza di build del documento.

▸ LAVORO TUO — 3. Grafica e scheda Play (C3)
  8 screenshot a 1080×1920 (gli screenshot iOS NON si riusano: rapporto d'aspetto fuori
  norma), icona 512×512 CON alpha, immagine in evidenza 1024×500 SENZA alpha.
  ⚠️ Leggi C4 §2 PRIMA di disegnare: l'app si chiama "Kid"ville e ha una mascotte cartoon,
  e Google può riclassificarla come app per bambini in base alla grafica. Niente mascotte,
  niente volti di bambini, screenshot dell'interfaccia gestionale.
  ⏰ SCADENZA REALE: i dati demo del diario scadono il 2026-08-09 (finestra di 14 giorni).
  Dopo quella data le schermate escono vuote e vanno riseminati retrodatando creato_il.

▸ DA VERIFICARE — account Google Play già esistente come PERSONALE
  L'utente ha già un account Play, di tipo personale. Serve sapere:
  (a) la data di creazione — se dopo il 13/11/2023 scatta il gate 12 tester × 14 giorni;
  (b) se in Console compare già la richiesta di production access;
  (c) se convenga convertirlo in organizzazione o aprirne uno nuovo come ente.
  ⚠️ La conversione richiede comunque D-U-N-S + verifica del sito + 72 ore di attesa, e
  NON è documentato che un gate già scattato venga annullato. Va deciso con l'utente.

▸ LAVORO DELL'UTENTE — non farlo tu, ricordaglielo
  1. Ticket Apple di conversione Individual → Organization.
     Prompt pronto: docs/submission/prompts/prompt-ticket-apple.md
     Serve la delega scritta di Errico Cesario.
  2. Consegnare A3 al legale. È la catena più lunga e sta su ENTRAMBI gli store.
  3. Google Account ISTITUZIONALE della cooperativa (non una casella personale):
     solo il proprietario può completare la verifica d'identità.
  4. DNS/Search Console di kidville.it — è dell'agenzia ma l'utente ha accesso.
  5. Due prove su iPhone FISICO: push in ambiente production, offline in modalità aereo.
     Non sono osservabili da simulatore.

═══════════════════════════════════════════════════════════════════
SEQUENZE DA NON INVERTIRE
═══════════════════════════════════════════════════════════════════
• NON compilare il DSA prima che la conversione Apple sia riuscita: oggi l'account è a
  nome di persona fisica, e il DSA pubblica indirizzo e telefono SULLA SCHEDA. Si possono
  solo sostituire, mai togliere.
• NON firmare il Passo 5 del DSA (certificazione di conformità al diritto UE) prima del
  parere del legale: è una dichiarazione sostanziale resa per iscritto a un terzo.
• NON caricare l'URL di cancellazione su Play prima che la pagina esista (C5 parte 1).
• Le App Privacy labels e ios/App/App/PrivacyInfo.xcprivacy si toccano INSIEME: è la
  divergenza fra i due che si paga.

═══════════════════════════════════════════════════════════════════
FATTI COSTOSI DA RISCOPRIRE
═══════════════════════════════════════════════════════════════════
• Un .aab costruito dopo un cap sync senza CAP_SERVER_URL si installa, si apre e mostra
  una SCHERMATA MORTA. Il file è gitignorato: invisibile in git, nel gate e in un build
  che riesce. Verificare col cat del JSON dopo ogni sync, prima di ogni upload.
• JAVA_HOME va esportato in OGNI shell sulla JBR 21: il java di sistema è JDK 25 e
  Gradle 8.14 dà "Unsupported class file major version 69".
• versionCode 1 si brucia al PRIMO upload, anche solo su Internal testing, e non si
  riusa nemmeno cancellando l'upload.
• Al revisore va SOLO test.inf.genitore1@kidville.test. MAI test.segreteria, test.pri.
  segreteria o test.cuoca: leggono l'anagrafica REALE della sede, famiglie e bambini veri.
• La password degli account TEST non va scritta in nessun file del repo: c'è un lock
  (__tests__/architecture/niente-password-nel-repo.test.ts) che fa fallire il gate.
• NON lanciare npm run e2e in locale: .env.local punta al DB di PRODUZIONE.
• Lanciare SEMPRE npx tsc --noEmit prima del push: la CI lo fa sui __tests__, e build e
  vitest locali non lo colgono.
• Le 51 immagini in e2e/collaudo-giornata/run/screenshots/ sembrano riusabili per gli
  store: sono catture di PRODUZIONE con anagrafica reale. Mai.
• PostgREST non lancia: ritorna { error }. Un try/catch attorno a supabase.from(…) non
  scatta mai.
• docs/store-submission.md contiene due errori GIÀ CORRETTI ma da non reintrodurre:
  /assistenza NON è un URL valido di cancellazione account, e la mappa dei dati valida
  è docs/submission/A2, non la §3 di quel file.

═══════════════════════════════════════════════════════════════════
COME LAVORARE
═══════════════════════════════════════════════════════════════════
Branch secondario, mai main. PRD aggiornato nello stesso lavoro. Logging obbligatorio
(withRoute su ogni route, niente console.* in src/, catch che loggano, redazione a lista
bianca). Validazione zod. Migrazioni con lo strumento MCP apply_migration + get_advisors
a 0 ERROR. i18n su ENTRAMBE le lingue. TDD.

Gate prima di dire "fatto": eslint --max-warnings 0 · tsc --noEmit · vitest run · build.

Non committare e non pushare senza che te lo chieda l'utente.
Se una specifica di questi documenti si rivela sbagliata o impossibile, FERMATI e dillo
invece di aggirarla.

Comincia dicendomi da dove riparti e perché.
```
