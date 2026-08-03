import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock del ripiego NATIVO `mobile/www/offline.html`
 * (capacitor.config.ts → `server.errorPath`).
 *
 * Perché serve un test e non basta guardarla: questa pagina compare SOLO nel
 * caso che nessun Service Worker può coprire — app appena installata (o dati
 * cancellati) e dispositivo senza rete. È quindi il pezzo di app che si vede
 * più di rado e si prova quasi mai, ed è esattamente per questo che il difetto
 * ci è rimasto: il pulsante «Riprova» faceva `location.href='https://…'` alla
 * cieca. Senza rete quella navigazione fallisce, la WebView ricarica
 * `errorPath`, e l'utente resta inchiodato su un pulsante che non fa nulla e
 * non spiega niente.
 *
 * Vincolo che questi test difendono: si naviga SOLO dopo aver verificato che
 * l'host risponda; altrimenti si dice all'utente che la rete non c'è ancora.
 *
 * Nota sull'origine: la pagina è servita da `https://localhost` (schema locale
 * di Capacitor), quindi la sonda verso `app.kidville.it` è CROSS-ORIGIN e senza
 * CORS. L'unica risposta leggibile è quella opaca: `ok === false`, `status 0`.
 * Vale come «raggiungibile» il fatto stesso che la promise si risolva — un
 * `if (res.ok)` qui non navigherebbe MAI. Il test 「risposta opaca」 blinda
 * proprio questo.
 *
 * ── FRA QUESTO REPO E CIÒ CHE PARTE C'È UN `cap sync` DIGITATO A MANO ─────────
 *
 * `capacitor.config.ts` e `mobile/www/offline.html` sono SORGENTI. L'app non li
 * legge: legge le copie generate da `npx cap sync` —
 *   · `android/app/src/main/assets/capacitor.config.json` + `assets/public/offline.html`
 *   · `ios/App/App/capacitor.config.json`                 + `App/public/offline.html`
 * — e `cap sync` non è invocato da nessuno script npm né dalla CI: è digitato a
 * mano. La divergenza è quindi lo stato NORMALE, non l'eccezione.
 *
 * ⚠️ QUEI QUATTRO FILE NON SONO NEL REPO, e i due lock che li leggono NON GIRANO
 * IN CI. Sono gitignorati alla nascita da Capacitor — `android/.gitignore:100`
 * («Copied web assets») e `:103` («Generated Config files»), `ios/.gitignore:4`
 * e `:12` — e la CI fa checkout + `npm ci` + `npm run gate`, senza `cap sync`:
 * su un clone pulito quei percorsi non esistono. Nella prima stesura i due test
 * li leggevano e basta, e il risultato era un check obbligatorio ROSSO su ogni
 * PR («Tests 2 failed | 10 passed»): un lock che blocca il rilascio senza
 * misurare niente non è severità, è un lock che verrà cancellato. Ora sono
 * `it.skipIf`, e un terzo test — sempre attivo — dice a voce alta quando sono
 * stati saltati, invece di far sembrare 12 verdi ciò che è 10.
 *
 * ⚠️ E CIÒ CHE SI TROVA SU UNA MACCHINA SINCRONIZZATA È UNA BUILD DI SVILUPPO.
 * Misurato il 2026-08-03 su questa macchina: i due JSON generati contengono
 * `"url": "http://10.0.2.2:3100"` (Android) e `"url": "http://localhost:3100"`
 * (iOS) con `"cleartext": true`, e NON contengono `server.allowNavigation` —
 * che nel TypeScript c'è dal 2026-08-03 (rilievo T14-F2). Due conseguenze, e
 * vanno lette insieme:
 *   · asserire su quei file è asserire sullo stato di lavoro di UNA macchina,
 *     non su ciò che si rilascia. L'unica cosa che se ne ricava è «l'artefatto
 *     che oggi partirebbe da qui dichiara lo stesso errorPath»;
 *   · finché non si rifà `cap sync` con `CAP_SERVER_URL=https://app.kidville.it`,
 *     sull'app COMPILATA il pulsante «Riprova» continua a uscire nel browser di
 *     sistema.
 * Non è un difetto di questi test: è un fatto sullo stato della shell nativa,
 * scritto qui perché chi legge il verde non lo scambi per «rilasciato».
 *
 * Sulla copia della PAGINA, invece, la misura regge: il 2026-08-03 la copia
 * sincronizzata pesa 6668 byte contro i 9151 della sorgente, e tolti i commenti
 * HTML i due file sono identici byte a byte (la differenza è un blocco di note
 * aggiunto dopo l'ultimo sync). Il test verifica ESATTAMENTE quello: la parte che
 * si esegue.
 *
 * ── COSA QUESTO LOCK NON COPRE ───────────────────────────────────────────────
 *
 *  · **Il jsdom non è una WebView.** Le prove di comportamento eseguono lo script
 *    della pagina con `new Function`, una `location` finta e una `fetch` finta:
 *    dimostrano la LOGICA del pulsante, non che su un telefono senza rete quella
 *    pagina compaia. Che compaia dipende da `errorPath` (lockato) e dalla shell
 *    nativa installata, che nessun test qui esegue.
 *  · **L'elenco dei modi di navigare non è esaustivo.** Si pretende un solo punto
 *    fra `location.href =`, `location.assign(`, `location.replace(` e
 *    `window.open(`. Un `<a href>`, un `<form>`, un `<meta http-equiv="refresh">`
 *    porterebbero l'utente altrove senza comparire in quel conteggio. La difesa
 *    che regge davvero è un'altra, ed è strutturale: la pagina deve avere UN SOLO
 *    blocco `<script>`, e quel blocco viene ESEGUITO da queste prove — quindi una
 *    navigazione alla cieca aggiunta lì dentro le manderebbe rosse.
 *  · **Fra `assets/` e il pacchetto installato c'è una compilazione.** Anche con
 *    la shell sincronizzata, «i byte sono uguali» non dice che l'APK sul telefono
 *    contenga quei byte.
 *  · **La prova sul dispositivo non è stata fatta.** Nessuno ha installato una
 *    build, tolto la rete e premuto «Riprova». Finché non accade, ciò che è
 *    dimostrato è la forma del codice e la logica del suo script.
 */

const PERCORSO = path.join(process.cwd(), 'mobile/www/offline.html');
const SORGENTE = fs.readFileSync(PERCORSO, 'utf8');
const URL_APP = 'https://app.kidville.it/';
const PARTENZA = 'https://localhost/offline.html';

/** Le due shell native, con la copia della pagina che ciascuna imbarca. */
const IMBARCATI = [
  {
    piattaforma: 'Android',
    config: 'android/app/src/main/assets/capacitor.config.json',
    pagina: 'android/app/src/main/assets/public/offline.html',
  },
  {
    piattaforma: 'iOS',
    config: 'ios/App/App/capacitor.config.json',
    pagina: 'ios/App/App/public/offline.html',
  },
] as const;

/**
 * `true` se su questa macchina esiste l'output di `npx cap sync`.
 *
 * I quattro percorsi sono gitignorati (vedi la testata): su un clone pulito — cioè in CI, e
 * sulla macchina di chi non ha mai compilato la shell nativa — non ci sono. I due lock che li
 * leggono si saltano, e il terzo test di questo gruppo lo dichiara invece di far finta.
 */
const SHELL_SINCRONIZZATA = IMBARCATI.every(
  ({ config, pagina }) =>
    fs.existsSync(path.join(process.cwd(), config)) && fs.existsSync(path.join(process.cwd(), pagina)),
);

/**
 * Il file senza i commenti HTML. È il confronto giusto fra sorgente e copia
 * imbarcata: una nota aggiunta dopo l'ultimo `cap sync` non deve mandare rosso un
 * lock, ma una riga di markup o di script che cambia sì — quella è la pagina che
 * l'utente vede quando non c'è rete.
 */
function parteEseguibile(relativo: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativo), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
}

const locationVera = window.location;

type LocationFinta = { href: string };

/** Ogni blocco `<script>` della pagina, attributi compresi. */
const BLOCCHI_SCRIPT = /<script\b[^>]*>([\s\S]*?)<\/script>/g;

/**
 * Monta il <body> del file nel jsdom ed esegue i suoi script inline.
 *
 * TUTTI gli script, e devono essere UNO SOLO. Manomissione misurata al terzo giro (M4): un
 * secondo `<script>` prima di `</body>` che appende ai pulsanti un listener con
 * `location.href = 'https://app.kidville.it/'` alla cieca lasciava VERDI tutte e quattro le
 * prove di comportamento — perché `monta` eseguiva solo il PRIMO blocco, e la navigazione alla
 * cieca non passava da nessuna sonda, quindi non c'era niente da abortire e niente che potesse
 * fallire. La pagina reale, invece, esegue tutto.
 *
 * Eseguirli tutti non basta da solo: chi domani aggiunge il terzo script senza aggiornare il
 * ciclo riaprirebbe la porta. Il NUMERO è quindi parte del vincolo, ed è la riga che conta.
 * Si contano anche le aperture con attributi (`<script defer>`, `<script type="module">`):
 * altrimenti basterebbe un attributo per uscire dal conteggio.
 */
function monta(lingua: string): LocationFinta {
  const corpo = SORGENTE.split('<body>')[1].split('</body>')[0];
  document.documentElement.lang = 'it';
  document.body.innerHTML = corpo.replace(BLOCCHI_SCRIPT, '');

  Object.defineProperty(navigator, 'language', { value: lingua, configurable: true });

  const finta: LocationFinta = { href: PARTENZA };
  Object.defineProperty(window, 'location', { value: finta, writable: true, configurable: true });

  const aperture = (SORGENTE.match(/<script\b/gi) ?? []).length;
  const blocchi = [...SORGENTE.matchAll(BLOCCHI_SCRIPT)].map((m) => m[1]);
  expect(
    aperture,
    'più di un <script> nella pagina: il collaudo ne eseguirebbe uno e l’altro resterebbe invisibile a tutta la suite',
  ).toBe(1);
  expect(
    blocchi.length,
    'gli <script> aperti e quelli richiusi non coincidono: c’è un blocco che questo collaudo non esegue',
  ).toBe(aperture);

  for (const script of blocchi) {
    expect(script.trim().length).toBeGreaterThan(0);
    new Function(script)();
  }
  return finta;
}

function stato(): HTMLElement {
  const el = document.getElementById('kv-stato');
  if (!el) throw new Error('manca #kv-stato: la pagina non ha dove dire che la rete non c’è');
  return el;
}

function bottone(lingua: 'it' | 'en'): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`button.${lingua}`);
  if (!el) throw new Error(`manca il pulsante .${lingua}`);
  return el;
}

/** Risposta opaca: è tutto ciò che una fetch `no-cors` può restituire. */
function rispostaOpaca(): Response {
  return { ok: false, status: 0, type: 'opaque' } as Response;
}

describe('ripiego nativo — la sonda prima della navigazione', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Object.defineProperty(window, 'location', {
      value: locationVera,
      writable: true,
      configurable: true,
    });
  });

  it('naviga solo dopo una HEAD andata a buon fine, e la HEAD ha un timeout', async () => {
    const chiamate: Array<[string, RequestInit]> = [];
    vi.stubGlobal('fetch', (u: string, o: RequestInit = {}) => {
      chiamate.push([u, o]);
      return Promise.resolve(rispostaOpaca());
    });

    const finta = monta('it-IT');
    expect(finta.href).toBe(PARTENZA);

    bottone('it').click();
    await vi.waitFor(() => expect(finta.href).toBe(URL_APP));

    expect(chiamate).toHaveLength(1);
    const [url, opzioni] = chiamate[0];
    expect(url.startsWith(URL_APP)).toBe(true);
    expect(opzioni.method).toBe('HEAD');
    // Senza `no-cors` la fetch verso un'origine che non manda header CORS
    // fallisce SEMPRE, anche con la rete perfetta: la pagina non navigherebbe mai.
    expect(opzioni.mode).toBe('no-cors');
    expect(opzioni.cache).toBe('no-store');
    expect(opzioni.signal).toBeDefined();
  });

  it('una risposta OPACA vale come raggiungibile (ok=false, status 0)', async () => {
    // Prova di non-regressione contro l'errore più facile da commettere qui:
    // `if (res.ok) location.href = …`. Cross-origin `res.ok` è sempre false.
    vi.stubGlobal('fetch', () => Promise.resolve(rispostaOpaca()));
    const finta = monta('it-IT');
    bottone('it').click();
    await vi.waitFor(() => expect(finta.href).toBe(URL_APP));
  });

  it('rete ancora assente: NON naviga e lo dice in italiano', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const finta = monta('it-IT');

    bottone('it').click();
    await vi.waitFor(() => expect(stato().textContent).toMatch(/Ancora nessuna connessione/i));

    expect(finta.href).toBe(PARTENZA);
  });

  it('rete ancora assente, sistema in inglese: «Still no connection»', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const finta = monta('en-US');

    expect(document.documentElement.lang).toBe('en');
    bottone('en').click();
    await vi.waitFor(() => expect(stato().textContent).toMatch(/Still no connection/i));

    expect(finta.href).toBe(PARTENZA);
  });

  it('la sonda che non risponde viene abortita: niente attesa infinita', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      (_u: string, o: RequestInit = {}) =>
        new Promise((_risolvi, rifiuta) => {
          o.signal?.addEventListener('abort', () =>
            rifiuta(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );

    const finta = monta('it-IT');
    bottone('it').click();

    // Durante la sonda il pulsante è disabilitato: senza, due tocchi rapidi
    // fanno partire due sonde e la seconda naviga mentre la prima sta fallendo.
    expect(bottone('it').disabled).toBe(true);
    expect(stato().textContent).not.toMatch(/Ancora nessuna connessione/i);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(stato().textContent).toMatch(/Ancora nessuna connessione/i);
    expect(finta.href).toBe(PARTENZA);
    expect(bottone('it').disabled).toBe(false);
  });

  it('senza fetch (WebView antica) prova comunque a navigare: nessun vicolo cieco', async () => {
    vi.stubGlobal('fetch', undefined);
    const finta = monta('it-IT');
    bottone('it').click();
    await vi.waitFor(() => expect(finta.href).toBe(URL_APP));
  });
});

describe('ripiego nativo — lock del sorgente', () => {
  it('il TypeScript dichiara `server.errorPath`, e punta a QUESTO file', async () => {
    // Il presupposto di TUTTO il resto di questo file, e fino al 2026-08-03 non lo verificava
    // nessuno: misurato, togliendo `errorPath: 'offline.html'` da `capacitor.config.ts` i
    // quattro lock dell'offline restavano verdi (40 test su 40) mentre la schermata di
    // ripiego non sarebbe più comparsa in nessun caso — al suo posto la pagina d'errore di
    // sistema della WebView, senza «Riprova», senza testo bilingue, senza niente. Cioè:
    // continuavamo a collaudare con cura un file che l'app non avrebbe mai caricato.
    //
    // Il titolo dice «il TypeScript» e non «l'app» di proposito: questo file è una SORGENTE,
    // l'app legge il JSON generato da `cap sync`. Quel pezzo lo prova il test qui sotto.
    const config = (await import('../../capacitor.config')).default;
    expect(
      config.server?.errorPath,
      'senza `server.errorPath` la WebView mostra la propria schermata d’errore e questo file non viene mai caricato',
    ).toBe('offline.html');

    // E dev'essere QUESTO file: `errorPath` è relativo a `webDir` (Android
    // `Bridge.getErrorUrl()` → `errorPath` dentro l'asset locale; iOS
    // `CAPInstanceConfiguration.errorPathURL`). I due valori insieme devono ricomporre il
    // percorso che il resto del lock legge, altrimenti stiamo collaudando un altro file.
    expect(
      path.join(process.cwd(), config.webDir ?? '', config.server?.errorPath ?? ''),
      'webDir + errorPath non portano al file collaudato qui',
    ).toBe(PERCORSO);
  });

  it.skipIf(!SHELL_SINCRONIZZATA)('anche l’ARTEFATTO che parte dichiara lo stesso errorPath, su entrambe le piattaforme', () => {
    // Il TypeScript non finisce nell'APK né nell'IPA: ci finisce il JSON prodotto da
    // `cap sync`. Misurato (T6): togliendo `errorPath` dai due JSON sincronizzati e
    // cancellando la copia di `offline.html` imbarcata, l'app non avrebbe più nessuna
    // schermata di ripiego — e il lock che guardava solo `capacitor.config.ts` restava verde.
    // Un lock sulla sorgente di un generatore mai eseguito dalla CI collauda un'intenzione.
    for (const { piattaforma, config } of IMBARCATI) {
      const pieno = path.join(process.cwd(), config);
      expect(fs.existsSync(pieno), `${config} non esiste: la shell ${piattaforma} non è sincronizzata`).toBe(true);
      const json = JSON.parse(fs.readFileSync(pieno, 'utf8')) as {
        server?: { errorPath?: string };
        webDir?: string;
      };
      expect(
        json.server?.errorPath,
        `${config}: senza errorPath l’app ${piattaforma} mostra la schermata d’errore di sistema`,
      ).toBe('offline.html');
    }
  });

  it.skipIf(!SHELL_SINCRONIZZATA)('la pagina IMBARCATA è, tolti i commenti, quella collaudata qui', () => {
    // Senza questo controllo il file poteva essere corretto nel repo e vecchio nell'app: è
    // successo davvero, `cap sync` non è in nessuno script npm né nella CI.
    //
    // Il confronto è sulla parte ESEGUIBILE e non byte a byte, ed è una scelta dichiarata:
    // oggi (2026-08-03) la copia sincronizzata pesa 6668 byte contro i 9151 della sorgente, e
    // la differenza è per intero un blocco di commenti HTML aggiunto dopo l'ultimo sync.
    // Pretendere l'identità byte a byte metterebbe un lock ROSSO in un albero condiviso per
    // una nota, e i lock rossi per motivi cosmetici si disattivano — che è il modo in cui i
    // lock muoiono. Quello che conta è che markup e script coincidano: se cambiano, rosso.
    //
    // Ciò che questo NON prova: che l'APK sul telefono contenga questi byte. Fra `assets/` e
    // il pacchetto installato c'è una compilazione, e nessun test qui la esegue.
    const atteso = parteEseguibile('mobile/www/offline.html');
    for (const { piattaforma, pagina } of IMBARCATI) {
      const pieno = path.join(process.cwd(), pagina);
      expect(
        fs.existsSync(pieno),
        `${pagina} non esiste: su ${piattaforma} «Riprova» non ha nessuna pagina da mostrare`,
      ).toBe(true);
      expect(
        parteEseguibile(pagina),
        `${pagina} è diverso dalla sorgente: l’app ${piattaforma} mostra una pagina che questo file non ha mai collaudato — manca un \`npx cap sync\``,
      ).toBe(atteso);
    }
  });

  it('i due lock qui sopra hanno GIRATO, oppure si sa che non hanno collaudato niente', () => {
    // Questo test è sempre attivo, e serve a non far passare 10 verdi per 12. I due lock
    // sull'artefatto leggono file gitignorati (testata): esistono solo su una macchina che ha
    // digitato `npx cap sync`. Le alternative erano tre e sono state pesate:
    //  · lasciarli leggere e basta → check obbligatorio ROSSO su ogni PR, per un file che in
    //    CI non può esistere. È lo stato in cui questo lavoro è arrivato qui, e non è
    //    mergiabile;
    //  · togliere i quattro percorsi dai .gitignore e committarli → oggi committerebbe una
    //    build di SVILUPPO (`server.url: http://10.0.2.2:3100`, `cleartext: true`), cioè
    //    metterebbe nel repo pubblico un artefatto puntato a un server locale e lo
    //    dichiarerebbe «ciò che parte». Richiede prima un `cap sync` di PRODUZIONE, che questa
    //    sessione non può fare senza riscrivere la shell sotto le altre;
    //  · saltarli e DIRLO. È questa.
    // In CI il salto è legittimo e atteso; su una macchina di sviluppo che la shell ce l'ha,
    // il rosso qui significa «cap sync a metà», ed è un'informazione vera.
    expect(
      SHELL_SINCRONIZZATA || !!process.env.CI,
      'artefatti `cap sync` assenti: questi due lock non hanno collaudato niente — esegui `npx cap sync`, oppure sappi che di ciò che parte davvero qui non è stato verificato nulla',
    ).toBeTruthy();
  });

  it('nessuna navigazione alla cieca: un solo punto di navigazione, e passa dalla sonda', () => {
    expect(SORGENTE).not.toMatch(/onclick\s*=\s*["'][^"']*location\.href/i);

    // Il titolo diceva «nessuna navigazione alla cieca» e l'asserzione vietava soltanto
    // l'ATTRIBUTO `onclick`. Misurato (M4): un `addEventListener('click', …)` in un secondo
    // blocco di script, con dentro `location.href = URL` senza nessuna sonda, passava — e con
    // lui passavano anche le quattro prove di comportamento, che eseguivano solo il primo
    // blocco. Ora i blocchi devono essere uno solo (`monta`) e il punto di navigazione uno
    // solo: le prove di comportamento dimostrano che QUEL punto sta dopo la sonda, e qui si
    // dimostra che non ce n'è un altro.
    //
    // Le tre forme sono quelle con cui `location` naviga; `window.open` è aggiunta perché è
    // l'unica altra via che porta l'utente FUORI da questa pagina senza toccare il DOM. Non è
    // un elenco esaustivo della navigazione in un browser (un `<a href>`, un form, un
    // `<meta refresh>` restano possibili): è dichiarato nella testata, e la difesa vera è che
    // ogni script della pagina viene ESEGUITO da queste prove.
    const NAVIGAZIONE = /location\s*\.\s*href\s*=|location\s*\.\s*(?:assign|replace)\s*\(|window\s*\.\s*open\s*\(/g;
    expect(
      (SORGENTE.match(NAVIGAZIONE) ?? []).length,
      'più di un punto di navigazione: uno dei due può non passare dalla sonda',
    ).toBe(1);
  });

  it('nessuna dipendenza esterna: è il ripiego del ripiego', () => {
    // Un font, un CSS o un JS remoto qui sarebbero una richiesta di rete su una
    // pagina che esiste PROPRIO perché la rete non c'è.
    const url = SORGENTE.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
    for (const u of url) expect(u.startsWith('https://app.kidville.it')).toBe(true);
    expect(SORGENTE).not.toMatch(/<link[^>]+href=/i);
    expect(SORGENTE).not.toMatch(/<script[^>]+src=/i);
  });

  it('resta bilingue: i due testi vivono entrambi nel documento', () => {
    expect(SORGENTE).toContain('class="it"');
    expect(SORGENTE).toContain('class="en"');
  });
});
