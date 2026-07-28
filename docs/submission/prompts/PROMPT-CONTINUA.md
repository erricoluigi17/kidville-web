# 🔁 Super prompt — continuare la submission in una nuova chat

> Autosufficiente. Da incollare in una chat nuova aperta su `/Users/lerri/kidville-web`.
> Aggiornato al **2026-07-28**.

---

```
Riprendiamo la submission di Kidville su App Store e Google Play. Parli SOLO in italiano.

═══════════════════════════════════════════════════════════════════
PRIMA DI RISPONDERE QUALSIASI COSA — leggi in quest'ordine
═══════════════════════════════════════════════════════════════════
1. AGENTS.md e CLAUDE.md            → le regole di progetto, tutte vincolanti
2. La mia memoria persistente su questo progetto, se il tuo harness la espone
   (cerca "submission", "gdpr_oblio", "c2_c3_play_2026" o simili)
3. docs/submission/README.md         → l'indice del dossier e l'ordine dei lavori
4. docs/submission/assets/README.md  → cosa esiste già in grafica Play e perché
5. docs/submission/C3-scheda-testi-grafica.md §2-§3 → il prossimo lavoro (screenshot)

NON rifare la ricerca del dossier A1-A3/C1-C5: è già tutta nei documenti con le fonti.
Se una cosa ti sembra sbagliata, VERIFICALA e dimmelo — ma non ripartire da zero.

═══════════════════════════════════════════════════════════════════
DOVE SIAMO — stato reale, 2026-07-28
═══════════════════════════════════════════════════════════════════
Prodotto: "Kidville", registro elettronico di una scuola dell'infanzia.
Next.js + Supabase, app nativa Capacitor (WebView su https://app.kidville.it).
Bilingue it/en. Tratta dati di MINORI, inclusi dati sanitari.

Titolare: SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA
P.IVA 03394870616 · REA CE 240763 · Via Silvio Pellico 7, 81030 Cesa (CE)

APP STORE — invariato dalla sessione precedente
  ✓ scheda compilata, 12 screenshot, build 1.0(1) su TestFlight (scade 2026-10-24)
  ✓ firma di distribuzione ok, aps-environment = production
  ✗ DSA (operatore commerciale), App Privacy labels, validazione legale di
    /privacy e /termini, conversione account Individual → Organization
    — tutti bloccanti UMANI/legali, non lavoro da agente
  ✗ Due prove su iPhone FISICO (push in production, offline in aereo) — mai fatte

GOOGLE PLAY — C5 in prod, C2 fatto, C3 a metà
  ✅ C5 (cancellazione pubblica + moderazione UGC) — IN PRODUZIONE dal 2026-07-27,
     PR #52 commit 3e8eb79. Sblocca C4 (l'URL di cancellazione ora esiste).
  ✅ C2 (build .aab firmata) — FATTO ma NON pushato, sul branch
     fix/gdpr-oblio-parent-id-space (vedi sotto). Chiave di upload generata fuori dal
     repo, .aab prodotto e verificato con jarsigner.
  🟡 C3 — testi approvati dal titolare; icona 512×512 e feature graphic 1024×500
     pronte in docs/submission/assets/ (v2: STESSA immagine dell'icona iOS, non più
     generate da zero — v1 scartata perché giudicata brutta). Mancano ANCORA:
     8 screenshot telefono 1080×1920 + 4 tablet — MAI FATTI, è il prossimo lavoro.
  ✗ C1 (decisione sull'account Play personale esistente) — lavoro tuo
  ✗ C4 (moduli Data safety/Health apps/IARC in Console) — lavoro tuo, tutto già
     deciso nel documento, ma va compilato a schermo

DECISIONI GIÀ PRESE — non riaprirle
  Le stesse della sessione del 26/07 (D-U-N-S 432360401, sede legale, ragione sociale
  per esteso, account Organizzazione, categoria Istruzione, pubblico 18+, sospensione
  UGC dichiarata) — vedi in fondo a questo prompt se serve il dettaglio completo, o
  docs/submission/README.md. PIÙ, dal 2026-07-28:
  • Icona/feature graphic Play: STESSA immagine dell'icona iOS (mockup con angoli
    arrotondati/ombra dipinti nei pixel). Il titolare l'ha scelta esplicitamente dopo
    aver visto (e scartato) una versione "pulita" fatta da zero. Comporta un
    doppio-arrotondamento quando Play applica la propria maschera — accettato,
    coerente con quanto già in produzione su App Store. NON rifare la versione pulita
    a meno che Play la rifiuti in review.
  • Mascotte su Play: mantenuta ovunque (icona, feature graphic), nonostante C4 §2
    raccomandi il contrario per il rischio di riclassificazione "app per bambini".
    Rischio accettato dal titolare, non riaprire la domanda.
  • versionCode Android: contatore progressivo INDIPENDENTE dal build number iOS
    (commentato in android/app/build.gradle sopra `versionCode 1`).
  • Deroga alla regola "un branch alla volta" di AGENTS.md: il fix GDPR (bug di
    sicurezza) e C2/C3 (submission Play) sono sullo STESSO branch fisico
    (fix/gdpr-oblio-parent-id-space) per scelta esplicita del titolare, pur essendo
    interventi scollegati — non aprirne uno nuovo per continuare C3, resta lì finché
    non si mergia.

═══════════════════════════════════════════════════════════════════
STATO DEL REPO — leggilo con attenzione, non è come l'ultima volta
═══════════════════════════════════════════════════════════════════
Branch: fix/gdpr-oblio-parent-id-space (locale, NON pushato, 5 commit sopra origin/main):
  3f3b783 fix(gdpr): usa il ponte parents.auth_user_id nell'oblio self-service
  5f0c586 fix(gdpr): lo scrub UGC filtrava con l'id sbagliato, canale pubblico bombardabile
  c2d6e95 build(android): C2 — chiave di firma Play fuori dal repo, .aab verificato
  556ae4c docs(submission): C3 (parziale) — icona/feature graphic v1, testi approvati
  644ee3f docs(submission): C3 — v2, riusa l'icona iOS

I primi due commit sono un bug GDPR reale (auto-scoperto durante C5, non annunciato
all'inizio di quella sessione): l'oblio self-service (sia canale in-app sia pubblico)
non anonimizzava MAI davvero un genitore, per uno spazio-id sbagliato
(`parents.id` vs `auth.user.id`). Corretto, testato con TDD, verificato 5/5 PASS da
tester indipendenti su dati di produzione reali (sola lettura). Zero incidenti reali:
la tabella `richieste_cancellazione` aveva 0 righe quando il bug è stato scoperto.
Dettagli completi nel PRD, changelog del 2026-07-27.

Working tree pulito salvo `.vscode/settings.json` (preesistente, non toccarlo).
Ultimo gate verde: eslint 0 · tsc 0 · vitest 390 file/3228 test · build ok
(quel gate copre solo i primi due commit — GDPR; C2/C3 non toccano src/, non serve
rilanciarlo per quelli, ma rilancialo comunque se aggiungi altro codice applicativo).

⚠️ Il branch NON è stato mergiato né pushato: prima di qualunque `git push`/merge,
chiedi conferma esplicita al titolare — l'ultima volta ha scelto esplicitamente di
lasciarlo "in sospeso" per continuare su altro.

⚠️ La password della chiave di firma Play (generata per C2) NON è in questa
conversazione né in git: sta in `~/Documenti/kidville-play/.upload-pw` e in
`android/keystore.properties` (gitignorato) sul disco del titolare. Se non l'ha ancora
spostata nel suo gestore di credenziali, ricordaglielo.

⚠️ Esiste un ramo remoto residuo `origin/feat/dossier-submission` (storia pre-squash
di C5, già confluita in main col commit 3e8eb79) — andrebbe eliminato per la regola 3
di AGENTS.md ("dopo un deploy riuscito, elimina i branch secondari"), ma è un'azione
visibile su un repo condiviso: chiedi prima di farlo, non farlo di tua iniziativa.

═══════════════════════════════════════════════════════════════════
LA CODA DI LAVORO, IN ORDINE
═══════════════════════════════════════════════════════════════════

▸ LAVORO TUO — 1. Screenshot Play (resto di C3), il prossimo passo naturale
  8 screenshot telefono 1080×1920 + 4 tablet. Serve: emulatore Android acceso,
  login come test.inf.genitore1@kidville.test (MAI test.segreteria/test.pri.segreteria/
  test.cuoca — leggono l'anagrafica REALE della sede), dati demo della classe TEST
  Infanzia rinfrescati (`creato_il` retrodatato, finestra di visibilità diario
  10 minuti). Leggi le "quattro trappole" già documentate in
  docs/submission/C3-scheda-testi-grafica.md §3 PRIMA di scrivere un flow Maestro:
  deep link → alert nativo che blocca la navigazione; etichetta breve "MENSA" che
  colpisce anche la bottom-nav dietro l'overlay; waitForAnimationToEnd non aspetta i
  dati; l'aria-label del menu è "Menu · tutte le sezioni", non "MENU". Selettori
  Maestro Android ≠ iOS anche per la stessa trappola.
  ⏰ I dati demo sono datati 2026-07-26, il diario mostra 14 giorni indietro: dopo il
  2026-08-09 le schermate sono vuote. Verifica la data di oggi prima di partire.
  🔴 MAI committare gli screenshot catturati in e2e/*/run/screenshots/ o cartelle
  simili non pensate per lo store: sono catture di collaudo su PRODUZIONE.

▸ LAVORO TUO — 2. Lingua predefinita Play Console → it-IT
  Prima di caricare QUALUNQUE grafica (icona/feature graphic/screenshot) in Play
  Console: Gestisci traduzioni → Cambia lingua predefinita, da en-US a it-IT. Se resta
  en-US, ogni locale non tradotta mostra testo E GRAFICHE in inglese anche a utenti
  italiani. Questo è lavoro a schermo, guidalo tu o fallo fare al titolare.

▸ DA DECIDERE COL TITOLARE — 3. Merge del branch fix/gdpr-oblio-parent-id-space
  È verde, verificato, pronto. Chiedi esplicitamente: revisiona lui il diff? Vuole
  push+PR ora o aspetta che anche gli screenshot siano dentro allo stesso branch?
  Ricorda che due interventi scollegati (fix sicurezza + submission Play) condividono
  lo stesso branch per sua scelta esplicita — occhio alla descrizione della PR quando
  arriva quel momento, deve rendere conto di entrambi separatamente nel corpo.

▸ LAVORO TUO — 4. C1 — account Google Play
  docs/submission/C1-account-play-e-tempi.md. Il titolare ha già un account Play
  personale esistente: va deciso se convertirlo o aprirne uno nuovo come
  organizzazione, e verificato se il gate "12 tester × 14 giorni" (per account creati
  dopo il 13/11/2023) è già scattato.

▸ LAVORO DEL TITOLARE — non farlo tu, guidalo/ricordaglielo
  1. C4 — Compilare in Play Console: Data safety (fonte: A2, NON store-submission.md
     §3 né PrivacyInfo.xcprivacy — si contraddicono, vale A2), Health apps declaration
     (obbligatoria anche solo per closed testing — la maggior parte degli sviluppatori
     la scopre dopo il rigetto), classificazione IARC (dichiarando chat e UGC: non
     abbassa il rating, nasconderla costa l'account), target audience 18+, Families
     Policy NON spuntata, Restrict Minor Access NON attivata.
  2. Ticket Apple di conversione Individual → Organization (prompt pronto in
     docs/submission/prompts/prompt-ticket-apple.md, serve delega scritta di Errico
     Cesario, legale rappresentante — l'utente Luigi Errico è socio con delega, non
     va MAI dichiarato legale rappresentante nelle pratiche Apple/Google).
  3. Consegna del dossier A3 al legale — è la catena più lunga, sblocca sia A2 (Play
     Data safety) sia il Passo 5 del DSA su Apple.
  4. Due prove su iPhone FISICO (invito TestFlight già mandato a lerrico7@icloud.com):
     push in ambiente production, offline in modalità aereo. Non osservabili da
     simulatore, restano aperte da tre changelog.
  5. Password della chiave di firma Play: spostarla dal disco al gestore di
     credenziali (vedi sopra).

═══════════════════════════════════════════════════════════════════
SEQUENZE DA NON INVERTIRE
═══════════════════════════════════════════════════════════════════
• NON caricare nessuna grafica Play prima di aver cambiato la lingua predefinita a it-IT.
• NON compilare il DSA Apple prima che la conversione Individual→Organization sia
  riuscita: il DSA pubblica indirizzo e telefono SULLA SCHEDA, con un account
  Individual è il nominativo personale del titolare.
• NON firmare il Passo 5 del DSA prima del parere del legale (A3).
• NON pushare/mergiare fix/gdpr-oblio-parent-id-space senza conferma esplicita.
• Le App Privacy labels (Apple) e ios/App/App/PrivacyInfo.xcprivacy si toccano
  INSIEME: è la divergenza fra i due che si paga.

═══════════════════════════════════════════════════════════════════
FATTI COSTOSI DA RISCOPRIRE
═══════════════════════════════════════════════════════════════════
• parents.id ≠ auth.user.id, MAI. Il ponte è SEMPRE parents.auth_user_id. Se scrivi
  o leggi codice nuovo che tocca `parents` a partire da un'identità autenticata
  (`requireUser`/`auth.user.id`), usa il bridge — è il refuso che ha reso l'oblio
  self-service inerte per settimane, corretto in due punti indipendenti nella stessa
  sessione (uno in ciascuna direzione dello stesso errore).
• I fake Supabase nei test che ignorano la COLONNA passata a `.eq()` (restituiscono
  sempre la riga configurata a prescindere dal filtro) nascondono esattamente questa
  classe di bug. Se scrivi un test su una query `parents`, il fake deve modellare
  `id` e `auth_user_id` come DUE valori diversi, mai lo stesso uuid riciclato.
• Un sub-agente istruito a generare un segreto reale (password, chiave) e scriverlo
  nel proprio report finale viene bloccato dal classificatore di sicurezza: il report
  finisce in trascrizione, è materializzazione di credenziali. Genera i segreti in
  prima persona con redirect di shell (`comando > file`, mai capturato in output
  visibile), mai stampati, mai passati come argomento di riga di comando.
• `keytool -list -v` va in crash su questa macchina con locale italiana
  (`MissingFormatArgumentException: Format specifier '%2$s'`, bug JDK noto). Aggiungi
  `-J-Duser.language=en -J-Duser.country=US` a QUALUNQUE comando keytool che stampi
  un certificato.
• Per verificare la firma di un `.aab` usa `jarsigner -verify -certs`, NON
  `apksigner` (che verifica APK, non bundle — schema di firma diverso).
• Un `.aab` costruito dopo un `cap sync` senza `CAP_SERVER_URL` si installa, si apre
  e mostra una SCHERMATA MORTA. Verifica SEMPRE col `cat` del
  capacitor.config.json sincronizzato, prima di ogni `bundleRelease`.
• JAVA_HOME va esportato in OGNI shell sulla JBR 21 (Android Studio): il java di
  sistema è JDK 25, Gradle 8.14 dà "Unsupported class file major version 69".
• Tutti gli asset di brand esistenti (`assets/icon-only.png`, `assets/logo.png`,
  `assets/icon-foreground.png`, e ora anche l'icona iOS riusata per Play) sono mockup
  con angoli arrotondati e ombra DIPINTI NEI PIXEL, non nel canale alpha — un resize
  diretto su Play produce un doppio-arrotondamento quando Play applica la propria
  maschera. Il titolare ne è consapevole e ha accettato il compromesso per l'icona
  attuale; non è un bug da correggere di tua iniziativa.
• versionCode 1 si brucia al PRIMO upload, anche solo su Internal testing, e non si
  riusa nemmeno cancellando l'upload.
• Al revisore va SOLO test.inf.genitore1@kidville.test. MAI test.segreteria/test.pri.
  segreteria/test.cuoca: leggono l'anagrafica REALE della sede, famiglie e bambini veri.
• La password degli account TEST non va scritta in nessun file del repo: lock
  `__tests__/architecture/niente-password-nel-repo.test.ts`.
• NON lanciare `npm run e2e`/`npm run e2e:seed` in locale: `.env.local` punta al DB
  di PRODUZIONE.
• Lanciare SEMPRE `npx tsc --noEmit` prima del push: la CI lo fa sui `__tests__`,
  build e vitest locali non lo colgono.
• PostgREST non lancia: ritorna `{ error }`. Un try/catch attorno a `supabase.from(…)`
  non scatta mai.

═══════════════════════════════════════════════════════════════════
COME LAVORARE
═══════════════════════════════════════════════════════════════════
Il branch è già aperto (fix/gdpr-oblio-parent-id-space) — NON crearne uno nuovo per
continuare C3/screenshot, resta lì. PRD aggiornato nello stesso lavoro (stessa voce di
changelog 2026-07-27/28, aggiungi in coda). Logging obbligatorio dove applicabile
(screenshot/grafica non toccano src/, quindi probabilmente non serve). Validazione zod
se scrivi codice. Migrazioni con lo strumento MCP apply_migration + get_advisors a 0
ERROR — non dovrebbero servirne per quello che resta. TDD se scrivi codice applicativo
(gli screenshot/Maestro non sono codice applicativo, ma se tocchi flow esistenti
verificali).

Gate prima di dire "fatto" (solo se hai toccato src/): eslint --max-warnings 0 ·
tsc --noEmit · vitest run · build. NON lanciare npm run e2e in locale.

Prima di push/merge/deploy, chiedi conferma esplicita: l'ultima sessione si è fermata
apposta prima di quel passo.

Se una specifica di questi documenti si rivela sbagliata o impossibile, FERMATI e
dillo invece di aggirarla.

Comincia dicendomi da dove riparti e perché.
```
