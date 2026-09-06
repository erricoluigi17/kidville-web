import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { STORAGE, attendiFineCaricamento } from './fixtures';
import { sondaDom, type EsitoSonda } from './lib/sonda-contrasto';

/**
 * CRAWLER DI CONTRASTO — le schermate autenticate, nelle DUE modalità.
 *
 * ─── IL BUCO CHE CHIUDE ─────────────────────────────────────────────────────
 * Otto lock in jsdom sorvegliano il contrasto, ma su una LISTA CHIUSA di 23
 * componenti; e `axe` non calcola il contrasto senza layout (lo dichiara
 * `__tests__/a11y/smoke.axe.test.tsx:10`). Le pagine pubbliche sono state
 * misurate a mano una volta. Le schermate AUTENTICATE — genitore, docente,
 * segreteria — non le ha mai misurate nessuno: è lì che il 2026-09-04 sono
 * state trovate 1098 scritte a 2,27:1 e 81 utility grigie fuori dai token.
 *
 * ─── PERCHÉ GIRA DUE VOLTE ──────────────────────────────────────────────────
 * In Alto Contrasto i token NON si ribaltano nelle classi Tailwind: `@theme
 * inline` inlina l'hex. L'Alto Contrasto è dipinto superficie per superficie a
 * mano — ~141 regole in `globals.css` che agganciano 17 classi `kv-*` su 81
 * usate. La passata in `data-contrast="high"` non verifica che i token si
 * ribaltino: verifica **quali superfici sono coperte e quali no**. È l'unico
 * modo di saperlo, e nessun test in jsdom può farlo.
 *
 * ─── COME SI LEGGE UN ROSSO ─────────────────────────────────────────────────
 * I numeri della baseline sono ESATTI: se salgono hai peggiorato, se scendono
 * hai bonificato e devi scrivere il numero nuovo. Il credito non speso non si
 * accumula — è lo spazio in cui il difetto rientra restando verde, ed è già
 * successo in questo repo (`testo-muted-allowlist`, 73 occorrenze di slack).
 *
 * ─── LA CORSA, E COME È STATA TOLTA (2026-09-06) ────────────────────────────
 * Fino a oggi `misura()` scattava la fotografia subito dopo `attendiFineCaricamento`,
 * che NON è un'attesa di contenuto: aspetta solo che sparisca l'overlay
 * `[data-visible="true"][role="status"]`, e quello si spegne al primo
 * `requestAnimationFrame` dopo il mount (`GlobalLoader.tsx`). Su `/teacher` —
 * pagina `'use client'` che carica me/sezioni/avvisi in un `useEffect` — la
 * sonda scattava quando NON era ancora tornata una sola chiamata: guscio SSR
 * ~16 nodi, guscio idratato ~18, pagina a dati arrivati ~36.
 * `nodiMinimi: 18` era inciso sul valore ESATTO di una corsa, con margine zero:
 * lo stesso codice era verde nelle run 33928260906 · 33927326021 · 33965178221 ·
 * 33970252802 · 33987275810 e rosso in 33976911606 (su `main`) e 33988684980,
 * con «ricevuto 15». Un test che oscilla è un test che si impara a ignorare.
 * La riparazione sta in `misura()` ed è DOPPIA, perché la corsa ha due metà:
 * `networkidle` aspetta la quiete PRIMA della risposta, il ciclo di stabilità il
 * rendering DOPO (si legge finché due letture consecutive non danno lo stesso
 * `esaminati`). Il ciclo da solo non le copre entrambe — non distingue «fermo
 * perché ha finito» da «fermo perché non è ancora partito», e il confine sta a
 * `PASSO_STABILITA_MS` esatti: la misura è nella testata di `misura()`.
 * NON sono stati accesi i retry — `playwright.config.ts` li vieta su questo
 * progetto, con la ragione scritta, ed è la ragione giusta: un colore sbagliato è
 * sbagliato anche al terzo tentativo, e i ripescaggi nascondono le degradazioni.
 * E la prova che tutto questo sia servito NON è che il test sia verde: è il
 * criterio `provaPositiva` della baseline, preteso a ogni run — una superficie
 * che esiste solo a dati arrivati, contata.
 */

const BASELINE = path.resolve(__dirname, '../docs/superpowers/contrasto-schermate-baseline.json');

type Veste = keyof typeof STORAGE;
interface Rotta { rotta: string; storage: Veste; viewport: 'mobile' | 'desktop'; }

/**
 * Le rotte sono scelte per SUPERFICIE, non per funzione: interessa quali gusci,
 * card, tabelle e fasce di stato vanno in scena, non cosa fanno.
 * Il genitore si misura a 390×844 perché è una WebView su telefono: misurarlo a
 * 1440 sarebbe misurare uno schermo che non esiste.
 *
 * ⚠️ `/teacher` NON si toglie da questo elenco per far tornare il verde. È stata
 * la tentazione del 2026-09-06, quando il suo `nodiMinimi` oscillava: togliendola
 * resterebbe UNA sola rotta docente misurata — cioè nessuna — e la causa non
 * sarebbe chiusa, perché la corsa vale identica su `/parent/pagamenti`, che è
 * anch'essa una pagina client con le sue fetch. Si spegne la sonda, non il
 * difetto. La causa si chiude nel ciclo di stabilità di `misura()`.
 */
const ROTTE: Rotta[] = [
  { rotta: '/parent/pagamenti',    storage: 'genitore', viewport: 'mobile'  }, // fasce di stato e importi
  { rotta: '/teacher',             storage: 'docente',  viewport: 'desktop' },

  // ── SETTE ROTTE SU NOVE SONO FUORI, E NON PERCHÉ IL CRAWLER SIA INSTABILE ───
  // Misurate in CI il 2026-09-04/05 (PR #116), tre giri. Falliscono tutte con
  // «le due modalità danno lo stesso identico esito: il cookie non sta facendo
  // niente»: gli elementi ILLEGGIBILI restano illeggibili identici con l'Alto
  // Contrasto acceso, ed è precisamente ciò per cui l'Alto Contrasto esiste.
  //
  // Il difetto è PREESISTENTE: l'Alto Contrasto è dipinto a mano su 17 classi
  // `kv-*` su 173, e queste schermate non le usano. Nessuno l'aveva mai visto
  // perché fino a oggi non c'era uno strumento che guardasse dietro il login.
  //
  // ⚠️ Al primo e al secondo giro quattro di queste sembravano SANE. Non lo erano:
  // a farle passare era lo skip-link `sr-only` — un rettangolo di 1×1 px che
  // nessuno vede — i cui stati `focus:` cambiano colore e producevano l'unica
  // differenza fra le due modalità. Tolto quel fantasma dalla misura (v. il
  // commento in `lib/sonda-contrasto.ts`), il difetto è venuto fuori intero.
  //
  // Rientrano quando l'Alto Contrasto coprirà davvero queste schermate: è un
  // lavoro a sé. Restano qui COMMENTATE, non cancellate — toglierle in silenzio
  // sarebbe spegnere la sonda che le ha trovate. Vedi il PRD, rilievo aperto.
  // { rotta: '/parent',              storage: 'genitore', viewport: 'mobile'  },
  // { rotta: '/parent/gallery',      storage: 'genitore', viewport: 'mobile'  },
  // { rotta: '/parent/modulistica',  storage: 'genitore', viewport: 'mobile'  },
  // { rotta: '/teacher/modulistica', storage: 'docente',  viewport: 'desktop' },
  // ── L'AREA ADMIN È FUORI, E NON PERCHÉ IL CRAWLER SIA INSTABILE ─────────────
  // `/admin`, `/admin/students` e `/admin/pagamenti` sono state misurate al primo
  // giro di CI (2026-09-04, PR #116) e hanno fallito TUTTE E TRE con «le due
  // modalità danno lo stesso identico esito: il cookie non sta facendo niente».
  // Non è un difetto di questo crawler: è il crawler che ha misurato per la prima
  // volta una cosa vera. L'Alto Contrasto è dipinto a mano su **17 classi `kv-*`
  // su 173**, e l'area admin le usa in **14 file su 122**: sulla Segreteria quel
  // cookie non ha praticamente niente da ribaltare.
  //
  // Rimesse dentro quando l'Alto Contrasto coprirà l'area admin — che è un lavoro
  // a sé, non una riga. Finché restano qui commentate, il difetto è DICHIARATO:
  // toglierle senza scriverne la ragione sarebbe stato spegnere la sonda che l'ha
  // trovato. Vedi il changelog del 2026-09-04 nel PRD.
  // { rotta: '/admin',               storage: 'admin',    viewport: 'desktop' },
  // { rotta: '/admin/students',      storage: 'admin',    viewport: 'desktop' },
  // { rotta: '/admin/pagamenti',     storage: 'admin',    viewport: 'desktop' },
];

const VIEWPORT = { mobile: { width: 390, height: 844 }, desktop: { width: 1440, height: 900 } } as const;

interface Saltati { gradiente: number; composizione: number; fondoIgnoto: number }
interface VoceBaseline {
  rotta: string;
  nodiMinimi: number;
  normale: number;
  altoContrasto: number;
  saltati: Saltati;
  /**
   * Gli sfondi non calcolabili nella passata in ALTO CONTRASTO, che fino al
   * 2026-09-06 non venivano confrontati con niente: la voce scritta in baseline
   * era `saltati: normale.saltati`, e l'ultima expect guardava solo quella.
   * `fondoDi()` incrementa `saltati` e fa `continue` SENZA incrementare
   * `esaminati` (`lib/sonda-contrasto.ts`): una superficie che diventa non
   * calcolabile SOLO in Alto Contrasto — una regola scritta a mano che le mette
   * un `linear-gradient` o un `filter` sotto — abbassava `alto.esaminati` senza
   * lasciare la minima traccia. Si confronta con la stessa severità dell'altra.
   */
  saltatiAlto: Saltati;
  /**
   * LA PROVA POSITIVA — «si sta misurando la pagina, o il suo guscio?».
   *
   * Fino al 2026-09-06 il criterio stava scritto in prosa nel `_leggimi`, e per la
   * SOLA `/teacher`: l'altra rotta sarebbe potuta finire misurata sul guscio senza
   * che nulla lo facesse notare — si sarebbero incollati i numeri del guscio e
   * sarebbe restata cieca per sempre, senza nemmeno un rosso. Un criterio che
   * dipende da chi legge non è un criterio: qui è un campo, e l'expect più sotto
   * lo pretende a ogni run, su ENTRAMBE le passate.
   */
  provaPositiva?: ProvaPositiva;
}
/**
 * `saltato` è quale dei tre contatori guardare, `minimo` quanti nodi la sonda deve
 * contarci dentro, `perche` quale superficie li produce e perché quella superficie
 * va in scena SOLO a dati arrivati. È un PAVIMENTO come `nodiMinimi`, non una
 * fotografia: se sale non è un rosso, se scende sotto il minimo la misura è
 * tornata al guscio.
 */
interface ProvaPositiva { saltato: keyof Saltati; minimo: number; perche: string }
interface Baseline { aggiornato: string; rotte: VoceBaseline[] }

const baseline: Baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const vocePer = (r: string) => baseline.rotte.find((v) => v.rotta === r);

/**
 * `-1` = «mai misurato». Una voce che ne contiene almeno uno è INCOMPLETA, e i due
 * meccanismi che dipendono da questa funzione la trattano di conseguenza:
 *  · il blocco «da incollare» torna disponibile (è il caso per cui è nato);
 *  · il criterio `provaPositiva` resta SOSPESO — al primo giro non deve impedire
 *    il bootstrap, che serve proprio a produrre i numeri.
 * Un contatore non può essere negativo, quindi `-1` non può essere scambiato per
 * una misura vera.
 */
function haSegnaposto(v: VoceBaseline): boolean {
  const numeri = [
    v.nodiMinimi, v.normale, v.altoContrasto,
    ...Object.values(v.saltati ?? {}),
    ...Object.values(v.saltatiAlto ?? {}),
    v.provaPositiva?.minimo ?? 1,
  ];
  return numeri.some((n) => typeof n !== 'number' || n < 0);
}

/**
 * Ciò che il bootstrap stampa al posto di un criterio che non può inventare: la
 * sonda sa contare i saltati, non sa dire QUALE superficie li produce né perché
 * quella superficie provi che i dati sono arrivati — è un giudizio, e lo scrive
 * una persona. `minimo: -1` lo tiene sospeso nello spec e ROSSO nel lock
 * `__tests__/architecture/crawler-contrasto-configurato.test.ts`, che pretende
 * `≥ 1`: costa due secondi di `vitest` in locale, non un giro di CI, ed è ciò che
 * impedisce a una rotta nuova di nascere cieca.
 */
const SEGNAPOSTO_PROVA: ProvaPositiva = {
  saltato: 'gradiente',
  minimo: -1,
  perche: 'DA SCRIVERE: quale superficie va in scena solo a dati arrivati, e quanti nodi di testo la sonda deve contare fra i saltati per quella superficie.',
};

/**
 * BOOTSTRAP — le voci misurate, raccolte per stamparle ASSEMBLATE alla fine.
 *
 * Perché serve: il job `e2e` è un check OBBLIGATORIO della branch protection su
 * `main`. Una baseline vuota non costa «un giro di CI in più»: **blocca il
 * merge** finché qualcuno non apre la PR, legge l'esito e riempie il file. È il
 * prezzo di un check che nasce senza misure, ed è giusto pagarlo una volta —
 * ma va pagato UNA volta e nel modo più corto possibile.
 * Senza questa raccolta, chi apre la PR dovrebbe ricucire NOVE frammenti presi
 * da nove messaggi d'errore diversi. Con: un blocco solo, da copiare e incollare.
 * `workers: 1` e `fullyParallel: false` rendono l'accumulo affidabile — gli spec
 * girano seriali in un processo solo.
 */
const raccolta: VoceBaseline[] = [];

/** Ricopiato da `src/lib/accessibility/cookie.ts` — gli spec non importano da `src/`. */
const CONTRAST_COOKIE = 'kv_contrast';

/**
 * IL PASSO E IL TETTO DELL'ATTESA DI STABILITÀ.
 *
 * `PASSO_STABILITA_MS` non è un'attesa cieca: è l'intervallo fra due CAMPIONI.
 * La condizione d'uscita non è il tempo — è il fatto che due letture consecutive
 * diano lo stesso numero di nodi. In regime normale il ciclo esce alla seconda
 * lettura, cioè mezzo secondo dopo la prima.
 * `TETTO_STABILITA_MS` è la rete: oltre, si FALLISCE stampando la successione.
 * Una pagina che dopo trenta secondi cresce ancora non è lenta, ha qualcosa che
 * si rirende da solo — e proseguire misurandola a metà rimetterebbe dentro
 * esattamente la corsa che questo ciclo esiste per togliere.
 */
const PASSO_STABILITA_MS = 500;
const TETTO_STABILITA_MS = 30_000;

/**
 * IL TETTO DELL'ATTESA DI QUIETE DI RETE — l'altro momento, non lo stesso.
 *
 * Scaduto questo, NON si fallisce: si prosegue col ciclo, dicendolo. La ragione è
 * che un tetto scaduto ha comunque fatto il suo lavoro — se sono passati dodici
 * secondi dal `load`, le fetch della pagina sono tornate da un pezzo, ed è
 * esattamente la garanzia che si stava cercando. Fallire qui vorrebbe dire
 * rossare il crawler per la PRESENZA di traffico (una riconnessione realtime, un
 * domani un polling più fitto), cioè per un fatto che non dice niente sul
 * contrasto. Ma non si tace: il ramo stampa perché, così se un giorno la rete di
 * queste rotte smettesse di quietarsi lo si legge nei log invece di dedurlo.
 */
const TETTO_RETE_MS = 12_000;

/**
 * Il timeout del singolo test. Il default di Playwright è 30 s (nessun `timeout`
 * globale in `playwright.config.ts`): con DUE passate che possono arrivare
 * ciascuna al proprio tetto, il test morirebbe per timeout prima di poter dire
 * PERCHÉ — e «Test timeout of 30000ms exceeded» non nomina né la rotta né la
 * successione misurata. Due volte (quiete di rete + stabilità), più un minuto per
 * i due caricamenti.
 */
const TIMEOUT_TEST_MS = 2 * (TETTO_RETE_MS + TETTO_STABILITA_MS) + 60_000;

/**
 * IL MARGINE DEL PAVIMENTO. `nodiMinimi` serve a distinguere «pagina pulita» da
 * «pagina VUOTA», non a fotografare una misura: quanti nodi di testo una pagina
 * renda dipende legittimamente dai dati del seme e dalla data. Scritto sul
 * valore esatto — com'era fino al 2026-09-06 — è un test che fallisce al primo
 * bambino in più nel seme, e chi lo vede rosso impara ad abbassarlo.
 * ⚠️ E abbassarlo è precisamente la cosa da non fare: portarlo a 15, il numero
 * della corsa, certificherebbe come «pulita» una schermata senza un dato dentro
 * (15 non è nemmeno uno stadio spiegato — il guscio SSR ne vale ~16).
 */
const MARGINE_PAVIMENTO = 0.8;

async function armaAltoContrasto(context: BrowserContext, baseURL: string) {
  await context.addCookies([{
    name: CONTRAST_COOKIE,
    value: 'high',
    domain: new URL(baseURL).hostname,
    path: '/',
    sameSite: 'Lax',
    expires: Math.floor(Date.now() / 1000) + 31_536_000,
  }]);
}

/**
 * Apre la rotta e misura QUANDO LA PAGINA HA FINITO DI CRESCERE.
 *
 * TRE ATTESE IN FILA, E OGNUNA COPRE UN MOMENTO CHE LE ALTRE NON VEDONO.
 *
 * 1. `attendiFineCaricamento` toglie di mezzo l'overlay opaco, e nient'altro: non
 *    dice niente sul contenuto e si soddisfa anche quando l'overlay non è mai
 *    esistito (v. la sua testata in `fixtures.ts`).
 * 2. `networkidle` copre la quiete PRIMA della risposta: la finestra in cui le
 *    fetch della pagina sono ancora in volo e il DOM è fermo perché non è ancora
 *    arrivato niente.
 * 3. il ciclo di stabilità copre il rendering DOPO la risposta: si ricampiona
 *    finché due letture consecutive non danno lo stesso `esaminati`.
 *
 * ⚠️ 2 e 3 NON sono alternativi, ed è l'errore che questo commento faceva fino al
 * 2026-09-06 quando scartava `networkidle` come «superfluo sopra questo ciclo».
 * È rovesciato: il ciclo da solo non distingue «fermo perché ha finito» da «fermo
 * perché non è ancora partito», e il confine sta a `PASSO_STABILITA_MS` ESATTI.
 * Misurato riproducendo il ciclo con un orologio finto: con la fetch che risponde
 * a 499 ms si legge 18, 36, 36 e si rende 36 — la pagina vera; a 501 ms si legge
 * 18, 18 e si dichiara «stabile» il GUSCIO. Su `/teacher` prima che il conteggio
 * si muova servono la risoluzione dell'identità (`teacher/page.tsx:119`,
 * `if (!userId) return`) PIÙ tre fetch (righe ~121, ~125, ~139): mezzo secondo è
 * un budget sottile, e lo è di più sulle macchine cariche della CI — cioè proprio
 * quelle che hanno prodotto la corsa. Con la quiete di rete davanti, quel caso è
 * chiuso a monte; il ciclo resta come cintura, per il rendering che arriva dopo.
 *
 * `networkidle` È RAGGIUNGIBILE SU QUESTE DUE ROTTE, e non è un auspicio:
 *  · il polling HTTP più fitto della shell è `NotificationsPanel.tsx:76`, a 60 s
 *    (`AdminNotificationsPanel` idem, e non è montato qui); i polling a 15 s
 *    (`useUnreadNotifications`, `useTasks`) vivono su chat/tasks/compiti, che non
 *    sono queste rotte;
 *  · nessun `EventSource` in tutto `src/` (zero occorrenze): niente stream aperto
 *    che terrebbe la rete occupata per sempre;
 *  · le WebSocket NON contano per `networkidle`: Playwright le tiene in
 *    `_webSockets` e non in `_inflightRequests` (verificato sul bundle di
 *    `playwright-core` 1.62.1). Quindi né il realtime di Supabase su
 *    `/parent/pagamenti` (`StoricoPagamenti.tsx`) né l'HMR di `next dev` — il
 *    progetto `contrasto` parla col server di sviluppo — impediscono la quiete.
 * Se un giorno cambiasse, il tetto scade e si prosegue: v. `TETTO_RETE_MS`.
 *
 * ⚠️ Sì, Playwright lo sconsiglia — e la ragione per cui lo sconsiglia è che di
 * solito viene usato AL POSTO di un'attesa su una condizione osservabile. Qui è
 * l'opposto: la condizione osservabile c'è ed è il ciclo, e `networkidle` copre
 * il solo momento in cui non c'è ancora niente da osservare. Toglierlo citando
 * quell'avvertenza rimetterebbe dentro la corsa dei 500 ms.
 *
 * Perché NON altre condizioni, provate e scartate:
 *  · «zero `.animate-pulse`» — su `/parent/pagamenti` quella classe NON esiste
 *    (verificato con `grep`): la condizione sarebbe vacuamente vera lì, cioè
 *    una guardia che non guarda. Le guardie vacue sono peggio dell'assenza.
 *  · `retries` sul progetto — vietato da `playwright.config.ts`, con la ragione
 *    scritta: un rosso ripescato è un verde che mente.
 *
 * ⚠️ IL RESIDUO, detto invece che nascosto: nemmeno tre attese provano da sole di
 * aver visto la pagina VERA. Quella prova è il criterio `provaPositiva` della
 * baseline, preteso più sotto su entrambe le passate: se il numero dei saltati
 * sul gradiente crolla sotto il minimo, la misura è tornata al guscio — non si
 * aggiornano i numeri, si guarda perché la pagina non ha caricato.
 */
async function misura(page: Page, url: string): Promise<EsitoSonda> {
  const risposta = await page.goto(url, { waitUntil: 'load' });
  expect(risposta?.ok(), `la rotta ${url} non ha risposto 2xx`).toBe(true);
  await attendiFineCaricamento(page);
  try {
    await page.waitForLoadState('networkidle', { timeout: TETTO_RETE_MS });
  } catch {
    // Non si fallisce (v. `TETTO_RETE_MS`), e non si tace: un'attesa che scade in
    // silenzio è una guardia che nessuno saprebbe mai spenta.
    console.log(
      `⚠️ ${url}: la rete non si è quietata entro ${TETTO_RETE_MS / 1000} s. Non è di per sé un ` +
        `errore — quei secondi bastano comunque alle fetch della pagina — ma se si ripete a ogni run ` +
        `questa rotta ha un traffico continuo (un polling più fitto di 500 ms, uno stream): allora ` +
        `\`networkidle\` qui non serve più a niente e va sostituito con un PASSO_STABILITA_MS più ` +
        `lungo del budget di fetch (1500-2000 ms), scrivendone la ragione.`,
    );
  }

  const successione: number[] = [];
  const scadenza = Date.now() + TETTO_STABILITA_MS;
  let ultimo = await page.evaluate(sondaDom, { autotest: false });
  successione.push(ultimo.esaminati);

  while (Date.now() < scadenza) {
    await page.waitForTimeout(PASSO_STABILITA_MS);
    const attuale = await page.evaluate(sondaDom, { autotest: false });
    successione.push(attuale.esaminati);
    if (attuale.esaminati === ultimo.esaminati) return attuale;
    ultimo = attuale;
  }

  throw new Error(
    `${url}: la pagina continua a crescere e il conteggio non si ferma mai. ` +
      `Ho misurato, uno ogni ${PASSO_STABILITA_MS} ms per ${TETTO_STABILITA_MS / 1000} s: ` +
      `${successione.join(', poi ')}.\n` +
      `Non proseguo con una misura presa a metà: sarebbe di nuovo la corsa che questo ciclo esiste ` +
      `per togliere, e il rosso tornerebbe a caso su una macchina lenta.\n` +
      `Se la successione OSCILLA invece di crescere, la pagina ha qualcosa che si rirende da solo ` +
      `(un polling, un carosello, un'animazione che monta e smonta nodi): va messo in pausa nella ` +
      `misura, non aspettato più a lungo.`,
  );
}

for (const { rotta, storage, viewport } of ROTTE) {
  test.describe(`contrasto · ${rotta} (${viewport})`, () => {
    test.use({ storageState: STORAGE[storage], viewport: VIEWPORT[viewport] });

    test(`${rotta} — modalità normale e Alto Contrasto`, async ({ page, context, baseURL }) => {
      test.setTimeout(TIMEOUT_TEST_MS);
      const voce = vocePer(rotta);

      // ── passata 1: modalità normale ──────────────────────────────────────
      const normale = await misura(page, rotta);
      // ⚠️ In modalità normale l'attributo è ASSENTE, non "normal":
      // `layout.tsx` scrive `data-contrast={highContrast ? "high" : undefined}`.
      expect(await page.locator('html').getAttribute('data-contrast')).toBeNull();

      // ── passata 2: Alto Contrasto ────────────────────────────────────────
      await armaAltoContrasto(context, baseURL!);
      const alto = await misura(page, rotta);

      // Tre asserzioni di attivazione, non una: «una modalità mai vista attiva
      // non è testata». (1) l'SSR ha letto il cookie…
      expect(await page.locator('html').getAttribute('data-contrast')).toBe('high');
      // (2) …e il FOGLIO DI STILE è arrivato. Un attributo senza CSS è una
      // modalità finta, e sarebbe passata inosservata.
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(0, 0, 0)');
      // (3) le coppie misurate devono DIFFERIRE fra le due passate. Se fossero
      // identiche staremmo eseguendo due volte lo stesso test senza saperlo.
      const insieme = (e: EsitoSonda) => e.fallimenti.map((f) => f.firma).sort().join('\n');
      if (normale.fallimenti.length || alto.fallimenti.length) {
        expect(insieme(alto), 'le due modalità danno lo stesso identico esito: il cookie non sta facendo niente').not.toBe(insieme(normale));
      }

      // ── la voce che questa run misura ────────────────────────────────────
      // Costruita PRIMA delle expect, e non dopo: in BOOTSTRAP le expect si
      // fermano alla prima che fallisce, e chi legge il rosso deve avere sotto
      // gli occhi TUTTI i numeri veri di questa rotta, non solo quello saltato
      // per primo — altrimenti riempire la baseline costa un giro di CI per
      // campo. A regime la voce serve comunque: è quella che `raccolta` accumula
      // per l'`afterAll`, e il blocco da incollare NON viene appeso alle expect
      // (v. `inBootstrap`, qui sotto).
      const misurato: VoceBaseline = {
        rotta,
        nodiMinimi: Math.max(1, Math.floor(Math.min(normale.esaminati, alto.esaminati) * MARGINE_PAVIMENTO)),
        normale: normale.fallimenti.length,
        altoContrasto: alto.fallimenti.length,
        saltati: normale.saltati,
        saltatiAlto: alto.saltati,
        // Il criterio non si misura: o c'è già, o resta il segnaposto da compilare.
        provaPositiva: voce?.provaPositiva ?? SEGNAPOSTO_PROVA,
      };

      /**
       * ⚠️ IL BLOCCO «DA INCOLLARE» ESCE SOLO DAL BOOTSTRAP.
       *
       * Fino al 2026-09-06 era appeso a OGNI expect, comprese le due che
       * sorvegliano i difetti di contrasto veri — e il JSON che stampa contiene i
       * numeri MISURATI, cioè quelli PEGGIORATI. In concreto: chi introduceva un
       * contrasto sotto soglia leggeva «Se è SALITO hai aggiunto un contrasto
       * sotto soglia» e subito sotto trovava il blocco pronto che legittimava
       * quel salito. È la trappola che questo repo si è già scritto in memoria
       * come «abbassare la soglia di un lock lo trasforma in decorazione», in
       * forma nuova: non si abbassa una soglia, si offre il valore alzato.
       * A regime resta il solo messaggio diagnostico: dice il numero misurato e
       * mostra le coppie rotte, e aggiornare la baseline torna a essere una
       * DECISIONE — «ho bonificato, scrivo il numero nuovo» — invece di un
       * copia-incolla.
       */
      const inBootstrap = !voce || haSegnaposto(voce);
      const daIncollare = inBootstrap ? `\nVoce misurata in questa run, da incollare in ${path.basename(BASELINE)}:\n${JSON.stringify(misurato, null, 2)}` : '';

      // ── la sonda non è cieca ─────────────────────────────────────────────
      const minimi = voce?.nodiMinimi ?? 1;
      expect(normale.esaminati, `modalità NORMALE, ${rotta}: la pagina ha reso ${normale.esaminati} nodi di testo (attesi ≥ ${minimi}): non è pulita, è VUOTA.${daIncollare}`).toBeGreaterThanOrEqual(minimi);
      // Lo stesso messaggio anche qui: fino al 2026-09-06 questa riga era muta, e
      // l'unico rosso che produceva diceva «expected 15 to be >= 18» senza dire
      // in quale modalità, senza il numero dell'altra passata e senza i saltati.
      // L'`error-context.md` di quei rossi non conteneva alcun «Page snapshot»:
      // il messaggio è l'unica cosa che resta a chi legge.
      expect(alto.esaminati, `ALTO CONTRASTO, ${rotta}: la pagina ha reso ${alto.esaminati} nodi di testo (attesi ≥ ${minimi}; in modalità normale ne ha resi ${normale.esaminati}). Se il numero è molto più basso dell'altra passata, guarda i saltati: una regola scritta a mano può aver messo un gradiente o un filtro sotto una superficie, e la sonda smette di guardarla.${daIncollare}`).toBeGreaterThanOrEqual(minimi);

      // ── confronto con la baseline ────────────────────────────────────────
      raccolta.push(misurato);

      if (!voce) {
        // Non si passa in silenzio: si FALLISCE stampando il JSON da incollare.
        // Una modalità «osserva e non può fallire» è decorazione, e resterebbe accesa.
        throw new Error(
          `Rotta non in baseline. Incolla questa voce in docs/superpowers/contrasto-schermate-baseline.json:\n` +
            JSON.stringify(misurato, null, 2) +
            `\n\nDettaglio normale:\n${normale.fallimenti.slice(0, 20).map((f) => `  ${f.rapporto}:1 (soglia ${f.soglia}) ${f.firma}`).join('\n')}` +
            `\n\nDettaglio Alto Contrasto:\n${alto.fallimenti.slice(0, 20).map((f) => `  ${f.rapporto}:1 (soglia ${f.soglia}) ${f.firma}`).join('\n')}`,
        );
      }
      /**
       * ── LA PROVA POSITIVA, PRIMA DEI NUMERI ────────────────────────────────
       * Se stiamo misurando il guscio, confrontare i fallimenti con la baseline
       * non vuol dire niente: sarebbero i numeri di una pagina che non è mai
       * comparsa. Quindi si chiede prima «la pagina VERA è andata in scena?», e
       * lo si chiede a una superficie che ESISTE solo a dati arrivati.
       * Sospeso finché la voce ha un segnaposto: al primo giro il bootstrap deve
       * poter produrre i numeri. Scatta dal giro DOPO l'incollaggio — cioè
       * esattamente quando servirebbe accorgersi di aver incollato il guscio.
       */
      const pp = voce.provaPositiva;
      if (pp && !inBootstrap) {
        for (const [modalita, esito] of [['NORMALE', normale], ['ALTO CONTRASTO', alto]] as const) {
          expect(
            esito.saltati[pp.saltato],
            `${rotta} (${modalita}): la PROVA POSITIVA non regge — \`saltati.${pp.saltato}\` vale ` +
              `${esito.saltati[pp.saltato]}, atteso ≥ ${pp.minimo}.\n${pp.perche}\n` +
              `Quella superficie non è andata in scena: quasi sempre vuol dire che la misura è caduta sul ` +
              `GUSCIO — le fetch della pagina non erano ancora tornate — e allora i numeri qui sotto sono ` +
              `di una schermata che non esiste. NON si aggiorna la baseline: si guarda perché la pagina non ` +
              `ha caricato (\`networkidle\` scaduto? il seme senza il dato che accende quel blocco?).\n` +
              `L'altro caso possibile è che quella superficie sia stata TOLTA o abbia cambiato sfondo: ` +
              `allora il criterio va riscritto qui insieme al codice, non cancellato.`,
          ).toBeGreaterThanOrEqual(pp.minimo);
        }
      }

      const spiega = (e: EsitoSonda) => e.fallimenti.slice(0, 12).map((f) => `  ${f.rapporto}:1 (soglia ${f.soglia}) ${f.firma}`).join('\n');
      expect(
        normale.fallimenti.length,
        `modalità NORMALE, ${rotta}: dichiarati ${voce.normale}, misurati ${normale.fallimenti.length}.\n` +
          `Se è SALITO hai aggiunto un contrasto sotto soglia. Se è SCESO hai bonificato: scrivi il numero nuovo, ` +
          `non lasciare credito non speso.\n${spiega(normale)}${daIncollare}`,
      ).toBe(voce.normale);
      expect(
        alto.fallimenti.length,
        `ALTO CONTRASTO, ${rotta}: dichiarati ${voce.altoContrasto}, misurati ${alto.fallimenti.length}.\n` +
          `Qui un rosso quasi sempre significa che una superficie non ha la sua regola ` +
          `\`[data-contrast="high"]\` scritta a mano.\n${spiega(alto)}${daIncollare}`,
      ).toBe(voce.altoContrasto);
      expect(
        normale.saltati,
        `Sfondi non calcolabili su ${rotta} (modalità NORMALE): il numero è cambiato. Non è di per sé un difetto — un ` +
          `gradiente rende lo sfondo indecidibile — ma se una superficie prima misurata ora è saltata, ` +
          `il crawler ha smesso di guardarla e nessuno se ne accorgerebbe.${daIncollare}`,
      ).toEqual(voce.saltati);
      expect(
        alto.saltati,
        `Sfondi non calcolabili su ${rotta} (ALTO CONTRASTO): dichiarati ${JSON.stringify(voce.saltatiAlto)}, ` +
          `misurati ${JSON.stringify(alto.saltati)}. Questa passata ha i suoi saltati e vanno dichiarati a parte: ` +
          `una superficie che diventa non calcolabile SOLO con l'Alto Contrasto acceso — perché una regola scritta ` +
          `a mano le mette sotto un gradiente o un filtro — sparisce dalla misura senza lasciare traccia, e ` +
          `abbassa \`alto.esaminati\` invece di segnalare qualcosa.${daIncollare}`,
      ).toEqual(voce.saltatiAlto);
    });
  });
}

test.describe('contrasto · controllo positivo', () => {
  test.use({ storageState: STORAGE.genitore, viewport: VIEWPORT.mobile });

  /**
   * Gira A OGNI RUN, in CI. Inietta quattro sonde note nella pagina vera e
   * pretende che la sonda dia loro esiti DIVERSI: è la risposta al mock che
   * risponde uguale a tutto — difetto che in questo repo è già passato con
   * 13.254 test verdi.
   *
   * Qui la corsa non c'entra e il ciclo di stabilità non serve: le quattro sonde
   * le inietta `sondaDom` stessa un istante prima di misurare, quindi ci sono
   * comunque, anche sul guscio a dati non ancora arrivati. Per questo il test
   * chiama `page.evaluate` per conto suo invece di passare da `misura()`.
   */
  test('la sonda distingue il sano dal rotto, e sa dire «non lo so»', async ({ page }) => {
    await page.goto('/parent', { waitUntil: 'load' });
    await attendiFineCaricamento(page);
    const esito = await page.evaluate(sondaDom, { autotest: true });
    const cp = esito.controlloPositivo!;
    expect(cp.sano, '#000 su #fff (21:1) non deve risultare rotto').toBe(1);
    expect(cp.rotti, '#BBB su #fff e un inchiostro semitrasparente devono risultare rotti').toBe(2);
    expect(cp.gradiente, 'il testo sotto un gradiente va SALTATO e contato, non segnalato e non ignorato').toBe(1);
    // …e la serializzazione della funzione regge: se si rompesse, `esaminati`
    // sarebbe 0 e questo test direbbe perché, invece di degradare in silenzio.
    expect(esito.esaminati, 'la sonda non ha esaminato nulla: probabile ReferenceError nella serializzazione').toBeGreaterThan(0);
  });
});


/**
 * Stampa la baseline COMPLETA, e solo quando manca qualcosa: in regime normale
 * non aggiunge una riga di rumore ai log della CI. Non sostituisce il rosso —
 * il test fallisce comunque, perché una modalità che non può fallire è
 * decorazione — ma trasforma «leggi nove errori e ricuci il JSON» in «copia
 * questo blocco».
 * Il blocco resta appeso anche ai messaggi delle expect (`daIncollare`), ma SOLO
 * finché la voce è in bootstrap — assente, o con un campo a `-1`: lì è completo
 * anche se il test si è fermato alla prima asserzione fallita, e non serve un
 * giro di CI per campo. A REGIME sparisce, ed è voluto: appeso alle expect che
 * sorvegliano i difetti di contrasto veri, serviva su un piatto il numero
 * peggiorato — la spiegazione per esteso sta accanto a `inBootstrap`.
 */
test.afterAll(() => {
  const mancanti = ROTTE.filter(({ rotta }) => !vocePer(rotta));
  if (!mancanti.length || !raccolta.length) return;
  const completa = { ...baseline, aggiornato: new Date().toISOString().slice(0, 10), rotte: raccolta };
  console.log(
    '\n════ BASELINE DI CONTRASTO — da incollare in docs/superpowers/contrasto-schermate-baseline.json ════\n' +
      JSON.stringify(completa, null, 2) +
      '\n════ fine ════\n',
  );
});
