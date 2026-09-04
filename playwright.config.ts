import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;

/**
 * IL SERVER DELL'ARTEFATTO — `next start`, non `next dev`.
 *
 * Il quinto collaudo (2026-08-08) ha misurato otto rotte che rispondevano 500 con
 * corpo vuoto a tutte le famiglie per un difetto dell'ottimizzatore di Turbopack:
 * esisteva SOLO nel codice compilato. Nessun cancello del gate poteva vederlo —
 * `eslint`, `tsc` e i test girano sul sorgente, `next build` esce 0 perché la
 * build riesce — e nemmeno l'E2E, che gira su `npm run dev`, cioè sull'unica
 * configurazione in cui quel difetto non c'è.
 *
 * Un secondo server, su una porta sua, per uno spec solo (`smoke-artefatto`).
 * Non sostituisce il server di sviluppo per tutta la suite: quella scelta
 * riscriverebbe le condizioni di 40 spec in un lavoro che ne ha altre, e un E2E
 * che diventa rosso per il cambio di server non dice niente sul prodotto.
 */
const PORT_ARTEFATTO = 3101;
const URL_ARTEFATTO = `http://localhost:${PORT_ARTEFATTO}`;

/**
 * Gira in CI, e in locale solo a richiesta (`KV_SMOKE_ARTEFATTO=1`): costruire il
 * prodotto costa qualche minuto, e chi sta iterando su uno spec non deve pagarlo
 * a ogni salvataggio.
 */
const SMOKE_ARTEFATTO = !!process.env.CI || process.env.KV_SMOKE_ARTEFATTO === '1';

/**
 * IL SOTTOINSIEME CHE SI RIPETE SU WEBKIT.
 *
 * L'app iOS di Kidville è una WebView **WebKit** (Capacitor), e fino al
 * 2026-08-04 la suite girava su `chromium` e basta: la piattaforma su cui gira
 * l'app dei genitori non era mai stata toccata da un test automatico
 * (rilievo T13-F2 del collaudo). Le differenze fra i due motori non sono
 * accademiche in QUESTA app — `input[type=date]`, `Intl` sulle date e sugli
 * importi, il layout dei radio del passo «Sede», l'altezza sotto la barra di
 * Safari — e cadono tutte dentro i quattro percorsi qui sotto.
 *
 * NON è tutta la suite, di proposito: ripeterla intera raddoppierebbe il tempo
 * di CI per collaudare due volte le stesse pagine dello staff, che nessuno apre
 * da un iPhone. Sono i quattro percorsi che un genitore fa DAVVERO:
 *  · `auth`               entrare (il punto in cui un guasto blocca tutto);
 *  · `parent-home`        la schermata che vede per prima;
 *  · `parent-pagamenti`   il denaro, con importi e date formattati da `Intl`;
 *  · `public-iscrizione`  il modulo pubblico, che si compila da Safari — non
 *                         dall'app — ed è il più ricco di campi nativi.
 *
 * È una **RegExp** e non un glob perché così il lock
 * `__tests__/architecture/e2e-webkit-installato.test.ts` può APPLICARLA agli
 * spec reali e accorgersi se un giorno non seleziona più niente: un `testMatch`
 * che matcha zero file è un progetto verde in un secondo che non prova nulla.
 */
const SPEC_CRITICI_WEBKIT = /(?:^|[\\/])(?:auth|parent-home|parent-pagamenti|public-iscrizione)\.spec\.ts$/;

/**
 * Ciò che su WebKit NON si ripete. `public-iscrizione.spec.ts` contiene, oltre
 * al percorso pubblico, l'import in segreteria della domanda appena inviata:
 * eseguirlo una seconda volta importerebbe un codice fiscale che il progetto
 * `chromium` ha già importato nello stesso run — l'esito sarebbe un errore di
 * duplicato, cioè un test rosso per il proprio effetto collaterale e non per un
 * difetto del prodotto. Il percorso pubblico (quello che davvero si compila da
 * Safari) resta coperto: crea una seconda domanda che il seed ripulisce al run
 * successivo, come già fa per la prima.
 */
const SENZA_WEBKIT = /@solo-chromium/;

export default defineConfig({
  testDir: './e2e',
  // L'harness one-off del test 360° Primaria ha una sua config isolata: va escluso
  // da questa suite (infanzia), altrimenti i suoi spec/auth verrebbero raccolti qui.
  testIgnore: '**/primaria-360/**',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      /**
       * DUE esclusioni, e la seconda ripete quella globale — non è una svista.
       *
       * `testIgnore` di PROGETTO **sostituisce** quello di config, non ci si
       * somma. Scrivendo qui il solo smoke, la suite `primaria-360` (esclusa in
       * cima, riga `testIgnore`) è RIENTRATA: è un harness one-off con la sua
       * config e i suoi account, e pretende `KV_TEST_PASSWORD` al caricamento —
       * in CI la suite intera è morta prima di eseguire un test.
       * Misurato il 2026-08-08, run 31277207529: «Manca la variabile d'ambiente
       * KV_TEST_PASSWORD … at primaria-360/config/accounts.ts:13», ripetuto per
       * ogni spec.
       *
       * Lo smoke dell'artefatto non gira qui perché questo progetto parla col
       * server di SVILUPPO, cioè l'unica configurazione in cui il difetto che lo
       * smoke cerca non esiste: sarebbero tre righe verdi che al primo sguardo
       * sembrano la prova e non lo sono (run 31276444497: 47·48·49 qui e
       * 65·66·67 su `smoke-artefatto`, gli stessi tre test due volte).
       */
      testIgnore: [
        '**/primaria-360/**',
        /smoke-artefatto\.spec\.ts$/,
        // TERZA esclusione, per la stessa ragione della seconda, e vale la pena
        // dirla per esteso perche' e' la trappola che il crawler esiste per
        // evitare: senza questa riga `contrasto-schermate.spec.ts` girerebbe DUE
        // volte — una nel progetto `contrasto` con `retries: 0`, e una qui con i
        // `retries: 2` ereditati. La seconda e' dove un crawler instabile
        // sparirebbe dentro i ripescaggi, senza che nessuno conti i ripescati.
        /contrasto-schermate\.spec\.ts$/,
      ],
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
    {
      /**
       * CRAWLER DI CONTRASTO — misura il colore vero delle schermate autenticate
       * nelle due modalita'. Progetto suo per una ragione sola, ed e' `retries`.
       *
       * `retries: 0` ESPLICITO, contro i `retries: 2` della config. Un fallimento
       * di contrasto non e' un caso: e' un colore sbagliato, e sara' lo stesso
       * anche al terzo tentativo. Con i ripescaggi accesi un rosso su tre
       * passerebbe per verde e nessuno conta i ripescati — e' successo in questo
       * repo il 24/08 e l'01/09, due job «success» con dentro dei falliti.
       * Il crawler e' scritto per essere deterministico (conta le FIRME, non i
       * nodi, cosi' il numero non dipende dal volume dei dati seminati): se
       * diventasse instabile la risposta e' toglierlo dall'elenco con la ragione
       * scritta, non avvolgerlo in un retry.
       */
      name: 'contrasto',
      testMatch: /contrasto-schermate\.spec\.ts$/,
      retries: 0,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
    {
      // Il motore della WebView iOS. `Desktop Safari` porta con sé
      // `defaultBrowserType: 'webkit'`: è quello che il lock legge per pretendere
      // che il job E2E scarichi anche questo browser (`playwright install … webkit`).
      // Una configurazione a metà — progetto dichiarato, browser non installato —
      // sarebbe verde e non eseguirebbe niente.
      name: 'webkit',
      testMatch: SPEC_CRITICI_WEBKIT,
      grepInvert: SENZA_WEBKIT,
      use: { ...devices['Desktop Safari'] },
      // Gli storageState li scrive il progetto `setup` (una volta sola, su
      // chromium): sono cookie e localStorage in JSON, riusabili da qualunque
      // motore. Senza questa dipendenza gli spec autenticati partirebbero prima
      // che i file esistano e fallirebbero su un redirect al login.
      dependencies: ['setup'],
    },
    ...(SMOKE_ARTEFATTO
      ? [
          {
            // L'unico progetto che parla con `next start`. `baseURL` diverso: è
            // ciò che lo distingue: stessa suite, altro prodotto sotto.
            name: 'smoke-artefatto',
            testMatch: /smoke-artefatto\.spec\.ts$/,
            use: { ...devices['Desktop Chrome'], baseURL: URL_ARTEFATTO },
            // Gli storageState vengono dal progetto `setup`, che fa il login sul
            // server di sviluppo: sono cookie di Supabase, validi per l'host, non
            // per la porta. La sessione vale su entrambi i server.
            dependencies: ['setup'],
          },
        ]
      : []),
  ],
  webServer: [
    ...(SMOKE_ARTEFATTO
      ? [
          {
            // `npm run build` porta con sé `postbuild` → `verifica-artefatto.mjs`,
            // cioè il cancello che cerca il segnaposto di Turbopack nei chunk.
            // Se quello è rosso, il server non parte nemmeno: il difetto si ferma
            // prima, e questo spec è la seconda rete, non la prima.
            command: `npm run build && npm run start -- --port ${PORT_ARTEFATTO}`,
            url: URL_ARTEFATTO,
            reuseExistingServer: !process.env.CI,
            // Il build è la parte lunga: in CI, a freddo, sta sotto i 5 minuti.
            timeout: 600_000,
            env: { KV_LOG_LEVEL: 'silent' },
          },
        ]
      : []),
    {
      command: `npm run dev -- --port ${PORT}`,
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    /**
     * Il logger si spegne da sé sotto vitest (guardia su `process.env.VITEST`, letta al
     * caricamento del modulo), ma Playwright NON è vitest: avvia un vero server Next, in un
     * processo separato, dove quella variabile non esiste. Senza questa riga le 239 route
     * loggherebbero per davvero durante gli E2E, e sono due problemi distinti:
     *
     *  1. RUMORE. Gli spec girano seriali (`workers: 1`) su `next dev` e sono già instabili
     *     sotto carico: quando un E2E è rosso, l'output del server è il primo posto in cui si
     *     guarda — e va tenuto leggibile.
     *  2. SCRITTURE VERE. `KV_LOG_LEVEL=silent` spegne anche la PERSISTENZA su `app_log`
     *     (stessa guardia in `src/lib/logging/app-log.ts`). In locale `.env.local` punta al DB
     *     di PRODUZIONE: una suite E2E che ci scrive dentro righe di log è un incidente, non un
     *     test. In CI il DB è un progetto separato e non migrato — lì `app_log` non esiste
     *     nemmeno, e ogni riga sarebbe un tentativo fallito in più.
     *
     * `'silent'` è il valore ESATTO atteso dalla guardia (confronto stretto, minuscolo):
     * `KV_LOG_LEVEL === 'silent'` in `logger.ts` e in `app-log.ts`. Qualunque altro valore
     * (`'off'`, `'SILENT'`, `'1'`) lascerebbe il logger acceso senza dirlo a nessuno.
     *
     * Playwright FONDE questa mappa sopra `process.env` (`{ ...process.env, ...options.env }`),
     * non la sostituisce: PATH, CI e il resto dell'ambiente restano. E Next non sovrascrive una
     * variabile già presente nel processo con quella di `.env.local`, quindi qui il valore
     * vince — anche se un domani qualcuno mettesse `KV_LOG_LEVEL` nel file.
     */
      env: { KV_LOG_LEVEL: 'silent' },
    },
  ],
});
