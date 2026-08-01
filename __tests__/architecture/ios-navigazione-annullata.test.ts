import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * S28 — «annullare non è essere offline» (rilievo mobile-ios F3 del collaudo 2026-07-31).
 *
 * Dopo un login ANDATO A BUON FINE, 1 volta su 6, l'app mostrava la schermata
 * «KIDVILLE NON È RAGGIUNGIBILE — controlla la connessione e riprova» con il server
 * perfettamente raggiungibile. Nel log di WebKit:
 *
 *   FrameLoader::checkLoadCompleteForThisFrame: Failed provisional load
 *   (isTimeout = 0, isCancellation = 1, errorCode = -999)
 *
 * `-999` è `NSURLErrorCancelled`. La navigazione non era fallita: era stata ANNULLATA da
 * una seconda partita subito dopo. Capacitor, in `WebViewDelegationHandler`, carica
 * `server.errorPath` per QUALUNQUE errore, senza distinguere l'annullamento
 * dall'irraggiungibilità.
 *
 * Dire a una famiglia «non hai rete» quando la rete c'è la manda a controllare il router
 * invece che a riprovare. Un messaggio d'errore che sbaglia diagnosi è peggio di uno generico.
 *
 * **La correzione del 31/07 copriva un gestore su due.** `WKNavigationDelegate` ne ha due:
 * `didFailProvisionalNavigation` (la pagina non era ancora cominciata ad arrivare) e
 * `didFail` (navigazione già accettata). Capacitor carica `errorPath` in ENTRAMBI —
 * `node_modules/@capacitor/ios/Capacitor/Capacitor/WebViewDelegationHandler.swift`,
 * righe 131-155 — quindi filtrarne uno solo lasciava in piedi metà del difetto.
 *
 * Questi lock difendono le condizioni che rendono vivo il filtro. Se ne cade una sola,
 * il codice resta nel repo ma non gira mai:
 *   1. la politica esiste e distingue annullamento da guasto;
 *   2. ENTRAMBI i gestori passano dalla stessa decisione (una sola, non due copie);
 *   3. il filtro è trattenuto da un riferimento forte e installato come
 *      `navigationDelegate` (`navigationDelegate` è `weak`: senza il riferimento forte
 *      l'oggetto muore e l'override non viene mai chiamato);
 *   4. il file è compilato dal target Xcode e lo storyboard instanzia la nostra sottoclasse.
 *
 * **Che cosa è stato provato davvero, e come.** Swift non gira in vitest: questi sono grep
 * sul sorgente e dicono che il codice C'È, non che FUNZIONA. La prova di comportamento sta
 * in `ios/prove/filtro-annullamenti/esegui.sh`: compila i DUE FILE DI PRODUZIONE con un
 * delegato finto al posto di quello di Capacitor e misura SE VIENE CHIAMATO — rosso col
 * difetto rimesso, verde dopo. Eseguita il 2026-08-01: 3 rosse su 10 prima, 10 verdi dopo.
 *
 * **Che cosa NON è stato provato** (non abbellirlo, e non riscriverlo come se lo fosse):
 * i sei login consecutivi sull'app vera nel simulatore non sono stati eseguiti, né in questa
 * sessione né in quella del 31/07 — la versione precedente di questo commento affermava che
 * la prova era «riportata nel PRD»: non lo era. Il comando che la eseguirebbe:
 *
 *   npx cap sync ios
 *   xcrun simctl boot 'iPhone 17'
 *   xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator \
 *     -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath /tmp/kv-ios build
 *   xcrun simctl install booted /tmp/kv-ios/Build/Products/Debug-iphonesimulator/App.app
 *   xcrun simctl spawn booted log stream \
 *     --predicate 'subsystem == "it.kidville.app" AND category == "webview"'
 *   # poi sei login consecutivi: nel log deve comparire «navigazione annullata in …»
 *   # e MAI la schermata offline.
 */

const RADICE = process.cwd();

function leggi(relativo: string): string {
  return fs.readFileSync(path.join(RADICE, relativo), 'utf8');
}

/**
 * Il corpo `{…}` della prima funzione la cui firma corrisponde a `firma`, contando le
 * graffe. Serve per non confondere «la riga c'è nel file» con «la riga c'è DENTRO quel
 * metodo»: è la differenza fra un lock e un grep di cortesia.
 */
function corpoDi(sorgente: string, firma: RegExp): string {
  const inizio = sorgente.search(firma);
  if (inizio < 0) throw new Error(`firma non trovata nel sorgente: ${firma}`);
  const apertura = sorgente.indexOf('{', inizio);
  if (apertura < 0) throw new Error(`corpo non trovato dopo: ${firma}`);
  let profondita = 0;
  for (let i = apertura; i < sorgente.length; i += 1) {
    if (sorgente[i] === '{') profondita += 1;
    else if (sorgente[i] === '}') {
      profondita -= 1;
      if (profondita === 0) return sorgente.slice(apertura + 1, i);
    }
  }
  throw new Error(`graffa mai chiusa dopo: ${firma}`);
}

const POLITICA = 'ios/App/App/KVPoliticaErroriNavigazione.swift';
const CONTROLLER = 'ios/App/App/KVBridgeViewController.swift';
const STORYBOARD = 'ios/App/App/Base.lproj/Main.storyboard';
const PBXPROJ = 'ios/App/App.xcodeproj/project.pbxproj';
const PROVA = 'ios/prove/filtro-annullamenti/esegui.sh';

describe('S28 — la politica sugli errori di navigazione', () => {
  const sorgente = leggi(POLITICA);

  it('conosce NSURLErrorCancelled (-999) per nome E per numero', () => {
    // Il nome da solo non basta: chi legge il log del simulatore vede «-999», e deve
    // ritrovare quel numero nel codice. Il numero da solo non basta: senza il nome
    // sembra una costante magica.
    expect(sorgente).toContain('NSURLErrorCancelled');
    expect(sorgente).toContain('-999');
  });

  it('copre anche l’annullamento deciso da noi (WKError 102)', () => {
    // `decidePolicyFor` di Capacitor annulla le navigazioni verso l'esterno e le apre in
    // Safari: WebKit riporta `frameLoadInterrupted`. Anche quello è un annullamento, e
    // mostrare «non sei raggiungibile» dopo aver toccato un link esterno è lo stesso difetto.
    expect(sorgente).toContain('WKErrorDomain');
    expect(sorgente).toContain('102');
  });

  it('è una decisione a due esiti, non un interruttore che spegne tutto', () => {
    // Il rischio speculare del difetto: ingoiare OGNI errore e non mostrare più la
    // schermata offline nemmeno quando la rete manca davvero.
    expect(sorgente).toMatch(/case\s+mostraSchermataOffline/);
    expect(sorgente).toMatch(/case\s+ignoraAnnullamento/);
  });

  it('non dipende da WebKit né da Capacitor: resta verificabile da sola', () => {
    // Vincolo deliberato: la decisione si compila con `swiftc` senza SDK, quindi si può
    // provare rosso→verde in isolamento. Se qualcuno ci importa dentro WebKit, la prova
    // di validità smette di essere eseguibile.
    expect(sorgente).not.toMatch(/^import\s+(WebKit|Capacitor)/m);
  });
});

describe('S28 — il filtro copre ENTRAMBI i gestori di fallimento', () => {
  const controller = leggi(CONTROLLER);

  // `WKNavigationDelegate` ha due gestori di fallimento e Capacitor carica `errorPath` in
  // tutti e due. La prima correzione ne trattava uno solo: la schermata «non raggiungibile»
  // continuava a comparire quando l'annullamento arrivava a navigazione già cominciata.
  // Attenzione al nome: `didFail` è un prefisso di `didFailProvisionalNavigation`, quindi
  // i due si distinguono solo con l'etichetta del parametro che segue.
  const GESTORI = [
    {
      nome: 'didFailProvisionalNavigation',
      firma: /func webView\([^)]*didFailProvisionalNavigation navigation:/,
      inoltro: /interno\.webView\?\([^)]*didFailProvisionalNavigation:/,
    },
    {
      nome: 'didFail (navigazione già cominciata)',
      firma: /func webView\([^)]*didFail navigation:/,
      inoltro: /interno\.webView\?\([^)]*didFail:/,
    },
  ] as const;

  /**
   * Il nome della funzione che consulta la politica, ricavato dal sorgente invece che
   * cablato: così rinominarla non fa fallire il lock per il motivo sbagliato, ma
   * cancellarla sì.
   */
  function nomeDellaDecisione(): string {
    const dovePolitica = controller.indexOf('KVPoliticaErroriNavigazione.esito');
    expect(dovePolitica).toBeGreaterThan(-1);
    const dichiarazioni = [...controller.slice(0, dovePolitica).matchAll(/func\s+([A-Za-z0-9_]+)\s*\(/g)];
    const ultima = dichiarazioni[dichiarazioni.length - 1];
    expect(ultima).toBeDefined();
    return ultima![1];
  }

  it('la decisione è scritta UNA volta sola: due copie divergono, ed è così che è nato il buco', () => {
    const consultazioni = controller.split('KVPoliticaErroriNavigazione.esito').length - 1;
    expect(consultazioni).toBe(1);
  });

  it.each(GESTORI)('$nome: l’inoltro a Capacitor passa dalla decisione, non la scavalca', ({ firma, inoltro }) => {
    const corpo = corpoDi(controller, firma);
    const decisione = nomeDellaDecisione();

    // Controllo POSITIVO: l'inoltro esiste davvero (senza, il lock passerebbe anche su un
    // metodo vuoto che non mostra MAI la schermata offline — il difetto speculare).
    const dovInoltro = corpo.search(inoltro);
    expect(dovInoltro).toBeGreaterThan(-1);

    // E deve stare DENTRO la chiamata alla decisione: è quella che decide se eseguirlo.
    const dovDecisione = corpo.indexOf(`${decisione}(`);
    expect(dovDecisione).toBeGreaterThan(-1);
    expect(dovDecisione).toBeLessThan(dovInoltro);
  });

  it('sull’annullamento la decisione ESCE: è l’inoltro che carica errorPath', () => {
    const decisione = nomeDellaDecisione();
    const corpo = corpoDi(controller, new RegExp(`func\\s+${decisione}\\s*\\(`));

    const dovIgnora = corpo.indexOf('ignoraAnnullamento');
    const dovReturn = corpo.search(/\breturn\b/);
    // La richiamata che passa la palla a Capacitor, ricavata dal sorgente: è l'unica cosa
    // invocata senza argomenti dentro questo corpo.
    const richiamata = corpo.match(/\b([A-Za-z0-9_]+)\(\)/);
    expect(richiamata).not.toBeNull();
    const dovInoltro = corpo.indexOf(richiamata![0]);

    expect(dovIgnora).toBeGreaterThan(-1);
    // Ordine obbligato: riconosco l'annullamento → esco → (solo altrimenti) inoltro.
    // Invertiti, il filtro è decorativo: errorPath si carica lo stesso.
    expect(dovIgnora).toBeLessThan(dovReturn);
    expect(dovReturn).toBeLessThan(dovInoltro);
  });

  it('inoltra tutto il resto a Capacitor invece di reimplementarlo', () => {
    // Senza `forwardingTarget` + `responds(to:)` il proxy tronca i metodi che non
    // conosce: sparirebbero le decisioni di policy, la sfida TLS, il riavvio dopo il
    // crash del processo web.
    expect(controller).toContain('forwardingTarget');
    expect(controller).toContain('responds(to');
  });

  it('registra entrambi gli esiti, non solo il guasto', () => {
    // AGENTS.md regola 5: con i soli errori, «nessun log» non distingue «tutto ok» da
    // «non è mai partito niente». Qui serve poter dire quante navigazioni sono state
    // ignorate e quante schermate offline sono state mostrate davvero.
    expect(controller).toMatch(/\.info\(/);
    expect(controller).toMatch(/\.error\(/);
  });

  it('nel log dice ANCHE quale dei due gestori ha parlato', () => {
    // Con un messaggio identico nei due rami, dal log non si capisce se l'annullamento è
    // arrivato prima o dopo il commit della navigazione — cioè non si capisce se il
    // gemello aggiunto in S28 sta servendo a qualcosa.
    const decisione = nomeDellaDecisione();
    const corpo = corpoDi(controller, new RegExp(`func\\s+${decisione}\\s*\\(`));
    expect(corpo).toMatch(/\(gestore, privacy: \.public\)/);
    for (const atteso of ['"didFailProvisionalNavigation"', '"didFail"']) {
      expect(controller).toContain(atteso);
    }
  });

  it('non scrive nel log l’indirizzo navigato: nel path c’è la credenziale', () => {
    // `src/middleware.ts` lo dichiara: in questo repo il path È una credenziale
    // (`/m/<token>`) e gli id dei minori sono segmenti di rotta. Nel log vanno solo
    // dominio d'errore e codice numerico.
    expect(controller).not.toMatch(/absoluteString|webView\.url|navigationAction\.request\.url/);
  });
});

describe('S28 — senza questi, il filtro è codice morto', () => {
  const controller = leggi(CONTROLLER);

  it('si installa come navigationDelegate PROPRIO col filtro, e dentro capacitorDidLoad', () => {
    // Prima questo lock erano due grep slegati (`navigationDelegate =` da una parte,
    // `capacitorDidLoad` dall'altra): sarebbe passato anche assegnando come delegato un
    // oggetto qualsiasi, in un punto qualsiasi del file. Qui si segue l'oggetto.
    const corpo = corpoDi(controller, /override func capacitorDidLoad\s*\(/);

    const costruzione = corpo.match(/let\s+([A-Za-z0-9_]+)\s*=\s*KVDelegatoNavigazioneFiltrante\(/);
    expect(costruzione).not.toBeNull();
    const filtro = costruzione![1];

    // È QUELL'oggetto a diventare il delegato, non un altro.
    expect(corpo).toMatch(new RegExp(`navigationDelegate\\s*=\\s*${filtro}\\b`));
  });

  it('trattiene il filtro con un riferimento forte: navigationDelegate è weak', () => {
    // Senza una proprietà che lo trattenga, l'oggetto viene deallocato appena
    // `capacitorDidLoad` finisce, `navigationDelegate` torna nil e la WebView smette di
    // navigare — con il gate verde e nessun test rosso.
    const corpo = corpoDi(controller, /override func capacitorDidLoad\s*\(/);
    const costruzione = corpo.match(/let\s+([A-Za-z0-9_]+)\s*=\s*KVDelegatoNavigazioneFiltrante\(/);
    const filtro = costruzione![1];

    const memorizzazione = corpo.match(new RegExp(`(?:self\\.)?([A-Za-z0-9_]+)\\s*=\\s*${filtro}\\s*$`, 'm'));
    expect(memorizzazione).not.toBeNull();
    const proprieta = memorizzazione![1];
    expect(proprieta).not.toBe('navigationDelegate');

    // …e quella proprietà è dichiarata sulla classe, non è una variabile locale.
    expect(controller).toMatch(
      new RegExp(`(?:private\\s+)?var\\s+${proprieta}\\s*:\\s*KVDelegatoNavigazioneFiltrante\\?`),
    );
  });

  it('lo storyboard instanzia la sottoclasse Kidville, non CAPBridgeViewController', () => {
    const storyboard = leggi(STORYBOARD);
    expect(storyboard).toContain('KVBridgeViewController');
    expect(storyboard).not.toMatch(/customClass="CAPBridgeViewController"/);
  });

  it('i due file Swift sono compilati dal target App', () => {
    const pbx = leggi(PBXPROJ);
    const sorgenti = pbx.split('/* Begin PBXSourcesBuildPhase section */')[1] ?? '';
    expect(sorgenti).toContain('KVPoliticaErroriNavigazione.swift in Sources');
    expect(sorgenti).toContain('KVBridgeViewController.swift in Sources');
  });
});

describe('S28 — la prova di comportamento esiste ed è eseguibile', () => {
  // Il commento in cima a questo file cita una prova. Se il file citato sparisce o smette
  // di compilare i sorgenti veri, il commento torna a dire il falso — che è esattamente il
  // difetto corretto in S28.
  it('lo script c’è, è eseguibile e compila i file di produzione (non una loro copia)', () => {
    const percorso = path.join(RADICE, PROVA);
    expect(fs.existsSync(percorso)).toBe(true);
    // Il bit di esecuzione: uno script citato in un commento ma non lanciabile è la stessa
    // promessa a vuoto che questo step ha corretto.
    expect(() => fs.accessSync(percorso, fs.constants.X_OK)).not.toThrow();

    const script = leggi(PROVA);
    expect(script).toContain('KVPoliticaErroriNavigazione.swift');
    expect(script).toContain('KVBridgeViewController.swift');
  });

  it('la prova misura la conseguenza (Capacitor chiamato o no), non la presenza di una stringa', () => {
    const prova = leggi('ios/prove/filtro-annullamenti/main.swift');
    // I due annullamenti, su entrambi i gestori…
    expect(prova).toContain('didFail: nil, withError: annullataDaAltraNavigazione');
    expect(prova).toContain('didFailProvisionalNavigation: nil, withError: annullataDaAltraNavigazione');
    // …e i controlli POSITIVI: senza rete la schermata offline deve ancora comparire.
    expect(prova).toContain('reteAssente');
    expect(prova).toContain('serverIrraggiungibile');
  });
});
