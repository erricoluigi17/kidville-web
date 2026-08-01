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
 * una seconda partita subito dopo. Capacitor, in `WebViewDelegationHandler`
 * (`didFailProvisionalNavigation`), carica `server.errorPath` per QUALUNQUE errore, senza
 * distinguere l'annullamento dall'irraggiungibilità.
 *
 * Dire a una famiglia «non hai rete» quando la rete c'è la manda a controllare il router
 * invece che a riprovare. Un messaggio d'errore che sbaglia diagnosi è peggio di uno generico.
 *
 * Questi lock difendono le TRE condizioni che rendono vivo il filtro. Se ne cade una sola,
 * il codice resta nel repo ma non gira mai:
 *   1. la politica esiste e distingue annullamento da guasto;
 *   2. il file è compilato dal target Xcode (altrimenti non finisce nell'app);
 *   3. lo storyboard instanzia la NOSTRA sottoclasse, che si installa come
 *      `navigationDelegate` (altrimenti l'override non viene mai chiamato).
 *
 * Perché un lock sul sorgente e non un test di comportamento: Swift non gira in vitest.
 * La prova di comportamento vera è stata fatta a mano — compilazione della politica con
 * `swiftc` e sei login consecutivi sul simulatore — ed è riportata nel PRD; questo file
 * serve a impedire che qualcuno la disfi senza accorgersene.
 */

const RADICE = process.cwd();

function leggi(relativo: string): string {
  return fs.readFileSync(path.join(RADICE, relativo), 'utf8');
}

const POLITICA = 'ios/App/App/KVPoliticaErroriNavigazione.swift';
const CONTROLLER = 'ios/App/App/KVBridgeViewController.swift';
const STORYBOARD = 'ios/App/App/Base.lproj/Main.storyboard';
const PBXPROJ = 'ios/App/App.xcodeproj/project.pbxproj';

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

describe('S28 — il filtro è agganciato dove serve', () => {
  const controller = leggi(CONTROLLER);

  it('intercetta didFailProvisionalNavigation, che è il gestore misurato nel log', () => {
    expect(controller).toContain('didFailProvisionalNavigation');
  });

  it('sull’annullamento ESCE senza inoltrare: è l’inoltro che carica errorPath', () => {
    // Ancorato alla FIRMA del metodo, non a un'occorrenza qualunque della parola:
    // un commento in più non deve far fallire il lock per il motivo sbagliato.
    // Niente flag `s`: nel pattern non c'è nessun `.`, e `[^)]*` attraversa già i
    // ritorni a capo. Con `target: ES2017` il flag non compila (TS1501).
    const inizio = controller.search(/func webView\([^)]*didFailProvisionalNavigation/);
    expect(inizio).toBeGreaterThan(-1);
    const corpo = controller.slice(inizio);
    const posizioneIgnora = corpo.indexOf('ignoraAnnullamento');
    const posizioneInoltro = corpo.indexOf('interno.webView');
    expect(posizioneIgnora).toBeGreaterThan(-1);
    expect(posizioneInoltro).toBeGreaterThan(-1);
    // Il `return` dell'annullamento deve venire PRIMA della riga che passa la palla a
    // Capacitor. Invertiti, il filtro è decorativo: errorPath si carica lo stesso.
    expect(posizioneIgnora).toBeLessThan(posizioneInoltro);
  });

  it('si installa davvero come navigationDelegate della WebView', () => {
    expect(controller).toMatch(/navigationDelegate\s*=/);
    expect(controller).toContain('capacitorDidLoad');
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

  it('non scrive nel log l’indirizzo navigato: nel path c’è la credenziale', () => {
    // `src/middleware.ts` lo dichiara: in questo repo il path È una credenziale
    // (`/m/<token>`) e gli id dei minori sono segmenti di rotta. Nel log vanno solo
    // dominio d'errore e codice numerico.
    expect(controller).not.toMatch(/absoluteString|webView\.url|navigationAction\.request\.url/);
  });
});

describe('S28 — senza questi due, il filtro è codice morto', () => {
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
