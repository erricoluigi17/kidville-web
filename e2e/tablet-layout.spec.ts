import { test, expect, type Page } from '@playwright/test';
import { STORAGE, attendiFineCaricamento } from './fixtures';

/**
 * IL TABLET — genitori e docenti su iPad (progetti `tablet-verticale` e `tablet-orizzontale` di
 * `playwright.config.ts`: iPad mini a 768 px e iPad Pro 11" a 1194 px, WebKit come la WebView
 * dell'app iOS).
 *
 * Fino al 18/10/2026 su iPad ogni schermata era una striscia da telefono (430/460 px) in mezzo
 * allo schermo, con la barra in basso centrata. Da 744 px ora c'è una navigazione laterale —
 * binario a icone sotto i 1024 px, sidebar sopra — e una colonna da 720 px. Questo spec prova le
 * quattro cose che un difetto romperebbe senza che nessun test unitario lo veda, perché
 * dipendono dal motore vero e dalle misure vere:
 *
 *   1. la pagina è QUELLA in esame e non il login (un PASS sulla schermata di accesso è peggio
 *      di un rosso: è già successo, memoria `collaudo_browser_locale_bloccato`);
 *   2. c'è UNA navigazione, quella laterale nel formato giusto, e la barra in basso non c'è;
 *   3. nessuno scorrimento orizzontale del documento. Conta doppio su iPad: in modalità desktop
 *      (quella che la WebView sceglie da sola sul tablet) iPadOS rimpicciolisce le pagine che
 *      sbordano, e tutto il testo diventa minuscolo;
 *   4. il contenuto non finisce sotto il binario ed è largo davvero (> 600 px).
 *
 * Ogni rotta allega la sua schermata al report: è la prova da guardare prima del merge.
 *
 * Dalla PR 2 si misura anche il punto 5: le schermate a elenco hanno il numero di colonne giusto
 * per il formato (`COLONNE_ATTESE`). Si conta sul motore vero, dalle tracce di
 * `grid-template-columns`: una classe giusta che il CSS non applica (un `lg:` mai generato, una
 * regola sovrascritta) qui diventa rossa, mentre un test unitario la vedrebbe verde.
 *
 * Dalla PR 3 ci sono anche la segreteria (`verificaGuscioAdmin`) e le card degli avvisi che
 * restavano bianche (punto 6).
 *
 * Dal 18/10 sera, su richiesta del titolare che usa un iPad 11" in orizzontale e ci vedeva «il menu
 * del telefono» e «le scritte tagliate»: anche la segreteria ha la sidebar piena da 1024 px (prima
 * da 1280), quindi binario a 768 e sidebar a 1194 per TUTTI i ruoli; e il punto 7, nessuna scritta
 * tagliata nella barra in alto e nella navigazione (`verificaScritteIntere`).
 *
 * `retries: 0` nei due progetti: una misura sbagliata è la stessa anche al terzo tentativo.
 */

/**
 * LA PAGINA FERMA, PRIMA DELLA SCHERMATA. `attendiFineCaricamento` non basta per una fotografia:
 * aspetta che sparisca `[data-visible="true"]`, e appena l'attributo diventa "false" il selettore
 * non trova più niente, mentre il velo del caricatore sfuma ancora per 280 ms
 * (`PageLoader.module.css`). Il primo giro di CI della PR #239 ha allegato al report 10 schermate
 * su 24 col velo addosso: a 768 px pieno, a 1194 px a metà. E molte delle altre avevano ancora gli
 * scheletri al posto dei dati. Le asserzioni erano verdi, ma quelle schermate non provavano niente.
 *
 * Qui si aspetta il velo SPARITO (attributo "false" E opacità 0). È un'asserzione: un caricatore
 * rimasto acceso fa fallire il test. Poi si aspetta la rete ferma, con un tetto: una pagina che
 * interroga il server di continuo non deve bloccare il test, ma non lo si tace.
 */
async function attendiPaginaFerma(page: Page) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[role="status"][data-visible]')].every(
        (el) => el.getAttribute('data-visible') === 'false' && Number(getComputedStyle(el).opacity) === 0,
      ),
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch((errore) => {
    console.warn(
      `[tablet-layout] rete non ferma dopo 8 s su ${page.url()}: schermata scattata lo stesso —`,
      errore instanceof Error ? errore.message.split('\n')[0] : String(errore),
    );
  });
}

/** Il bollino «N» di `next dev` (la CI gira in dev): in produzione non c'è, e copre «Esci». */
const SENZA_INDICATORE_DEV = 'nextjs-portal { display: none !important; }';

const ROTTE_GENITORE = ['/parent', '/parent/diary', '/parent/avvisi', '/parent/mensa', '/parent/pagamenti', '/parent/gallery', '/parent/news', '/parent/chat'];
const ROTTE_DOCENTE = ['/teacher', '/teacher/attendance', '/teacher/diary', '/teacher/gallery', '/teacher/chat'];
const ROTTE_SEGRETERIA = ['/admin', '/admin/students', '/admin/pagamenti', '/admin/avvisi', '/admin/mensa', '/admin/impostazioni'];

/**
 * Quante colonne ha il primo `[data-kv-colonne]` della pagina: sul binario (768 px) e con la
 * sidebar (1194 px). Gli elenchi passano a due colonne da 1024 px (`DUE_COLONNE` in
 * `src/lib/ui/larghezza-pagina.ts`); le gallerie hanno 3 colonne sul binario e 4 con la sidebar
 * (`colonneGalleria`). Le rotte assenti non hanno un elenco da misurare con i dati E2E: il diario
 * (cronologia, resta in una colonna), le chat, e il feed delle news, che nel DB della CI è vuoto.
 */
const COLONNE_ATTESE: Record<string, { binario: number; sidebar: number }> = {
  '/parent': { binario: 1, sidebar: 2 },
  '/parent/avvisi': { binario: 1, sidebar: 2 },
  '/parent/mensa': { binario: 1, sidebar: 2 },
  '/parent/pagamenti': { binario: 1, sidebar: 2 },
  '/parent/gallery': { binario: 3, sidebar: 4 },
  '/teacher': { binario: 1, sidebar: 2 },
  '/teacher/attendance': { binario: 1, sidebar: 2 },
  '/teacher/gallery': { binario: 3, sidebar: 4 },
};

/**
 * 7. NESSUNA SCRITTA TAGLIATA nella barra in alto e nella navigazione. Il titolare, su un iPad 11"
 * in orizzontale, leggeva il testo d'esempio della ricerca della segreteria fermo a «…codice
 * fiscale.» e, in verticale, a «Cerca alı»: nessun test lo vedeva, perché in jsdom le misure non
 * esistono.
 *
 * Per ogni nodo di testo visibile dei `contenitori` si confronta la sua estensione VERA (un `Range`
 * misura il testo intero anche dove l'antenato lo nasconde) con ogni antenato che taglia
 * (`overflow` diverso da `visible`); in più, un blocco che taglia e ha `scrollWidth` oltre la sua
 * larghezza è un `truncate` coi puntini. Non contano i testi per i lettori di schermo (`sr-only`:
 * larghi 1 px, con `clip`) né quelli spenti (opacità 0, `visibility: hidden`).
 *
 * Il testo d'esempio di un campo non è un nodo di testo: lo si misura col `canvas`, nel font del
 * campo, contro la larghezza utile (senza i padding). Lo si esige da 1024 px; sotto (iPad mini in
 * verticale) il campo può non bastare e finisce coi puntini (`text-ellipsis`): la misura va
 * comunque negli allegati del test, per sapere quanto manca.
 */
async function verificaScritteIntere(page: Page, rotta: string, contenitori: string[]) {
  await page.evaluate(async () => {
    await document.fonts.ready; // il `canvas` misura nel font vero, non in quello di riserva
  });
  const esito = await page.evaluate((selettori) => {
    const tagliate: string[] = [];
    const segnaposti: { testo: string; larghezzaTesto: number; larghezzaUtile: number }[] = [];
    let testiMisurati = 0;
    const ctx = document.createElement('canvas').getContext('2d')!;
    for (const sel of selettori) {
      for (const radice of document.querySelectorAll<HTMLElement>(sel)) {
        if (radice.getClientRects().length === 0) continue; // `display: none` (es. la topbar del telefono)
        const walker = document.createTreeWalker(radice, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const testo = n.textContent?.trim();
          if (!testo) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          const r = range.getBoundingClientRect();
          if (r.width === 0) continue;
          let nascosto = false;
          let tagliataDa: string | null = null;
          for (let el = n.parentElement; el; el = el.parentElement) {
            const s = getComputedStyle(el);
            const b = el.getBoundingClientRect();
            if (s.visibility === 'hidden' || s.opacity === '0' || b.width <= 1 || s.clipPath !== 'none' || (s.clip && s.clip !== 'auto')) {
              nascosto = true;
              break;
            }
            if (!tagliataDa && s.display !== 'inline' && s.overflowX !== 'visible') {
              if (r.right > b.right + 1 || r.left < b.left - 1) tagliataDa = `<${el.tagName.toLowerCase()}> largo ${Math.round(b.width)} px`;
              else if (el === n.parentElement && el.scrollWidth > el.clientWidth + 1) tagliataDa = `puntini in <${el.tagName.toLowerCase()}>`;
            }
            if (el === radice) break;
          }
          if (nascosto) continue;
          testiMisurati++;
          if (tagliataDa) tagliate.push(`«${testo}» (${Math.round(r.width)} px, ${tagliataDa})`);
        }
        for (const campo of radice.querySelectorAll<HTMLInputElement>('input[placeholder]')) {
          if (campo.getClientRects().length === 0 || !campo.placeholder) continue;
          const s = getComputedStyle(campo);
          ctx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
          segnaposti.push({
            testo: campo.placeholder,
            larghezzaTesto: Math.ceil(ctx.measureText(campo.placeholder).width),
            larghezzaUtile: Math.floor(campo.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)),
          });
        }
      }
    }
    return { tagliate, segnaposti, testiMisurati };
  }, contenitori);

  const larghezza = page.viewportSize()!.width;
  // Si esige una PRESENZA: zero testi misurati vuol dire selettori sbagliati, non barre perfette.
  expect(esito.testiMisurati, `«${rotta}»: nessun testo trovato in ${contenitori.join(', ')}`).toBeGreaterThan(3);
  expect(esito.tagliate, `«${rotta}» a ${larghezza} px: scritte tagliate nella barra in alto o nel menu`).toEqual([]);
  await test.info().attach(`testi-d-esempio${rotta.replaceAll('/', '_')}-${larghezza}px`, {
    body: JSON.stringify(esito.segnaposti, null, 2),
    contentType: 'application/json',
  });
  if (larghezza >= 1024) {
    for (const c of esito.segnaposti) {
      expect(c.larghezzaTesto, `«${rotta}» a ${larghezza} px: il testo d'esempio «${c.testo}» non sta nel campo`).toBeLessThanOrEqual(c.larghezzaUtile);
    }
  }
}

async function verificaGuscioTablet(page: Page, rotta: string) {
  await page.goto(rotta);

  // 1. PRIMA di tutto: la pagina è quella giusta.
  await expect(page, `«${rotta}» è finita altrove`).not.toHaveURL(/\/auth\/login/);
  expect(new URL(page.url()).pathname).toBe(rotta);

  // 2. Si aspetta una PRESENZA: la navigazione laterale compare solo dopo l'idratazione, quindi è
  //    anche il segnale che la pagina è viva.
  const barra = page.locator('[data-kv-barra-laterale]');
  await expect(barra).toBeVisible({ timeout: 20_000 });
  await attendiFineCaricamento(page);

  const larghezza = page.viewportSize()!.width;
  await expect(barra).toHaveAttribute('data-formato', larghezza >= 1024 ? 'sidebar' : 'binario');
  await expect(page.locator('[data-kv-barra-bassa]'), 'la barra del telefono è ancora nel DOM').toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Navigazione principale' })).toHaveCount(1);

  // 3 e 4. Le misure.
  const misure = await page.evaluate(() => {
    const binario = document.querySelector('[data-kv-barra-laterale]')!.getBoundingClientRect();
    const figli = [...document.querySelectorAll('#content > *')].map((e) => e.getBoundingClientRect());
    return {
      scorrimento: document.documentElement.scrollWidth,
      finestra: window.innerWidth,
      destraBinario: binario.right,
      sinistraContenuto: Math.min(...figli.map((r) => r.left)),
      larghezzaContenuto: Math.max(...figli.map((r) => r.width)),
    };
  });
  expect(misure.scorrimento, `«${rotta}» scorre di lato: ${JSON.stringify(misure)}`).toBeLessThanOrEqual(misure.finestra + 1);
  expect(misure.sinistraContenuto, `il contenuto di «${rotta}» finisce sotto il binario`).toBeGreaterThanOrEqual(misure.destraBinario - 1);
  expect(misure.larghezzaContenuto, `il contenuto di «${rotta}» è ancora una striscia da telefono`).toBeGreaterThan(600);

  await attendiPaginaFerma(page);

  // 5. Le colonne. Si aspetta una PRESENZA (il numero giusto, dopo che l'elenco è arrivato), non
  //    un'assenza: senza `[data-kv-colonne]` la misura vale 0 e il test è rosso, non verde.
  const attese = COLONNE_ATTESE[rotta];
  if (attese) {
    const formato = larghezza >= 1024 ? 'sidebar' : 'binario';
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const el = document.querySelector('[data-kv-colonne]');
            if (!el) return 0;
            const tracce = getComputedStyle(el).gridTemplateColumns;
            return tracce === 'none' ? 1 : tracce.split(' ').length;
          }),
        { message: `«${rotta}» a ${larghezza} px (${formato}): colonne dell'elenco`, timeout: 15_000 },
      )
      .toBe(attese[formato]);
  }

  // 6. Le card degli avvisi arrivano TUTTE a opacità 1. Nelle schermate WebKit di #239 e #240 due
  //    per giro restavano bianche, in posizioni diverse: framer-motion ne animava l'opacità e
  //    `transition-all` gliela contendeva. Si aspetta una PRESENZA (almeno una card, e nessuna
  //    sotto 1); se resta rosso, il messaggio dice quali e con quale stile in linea.
  if (rotta === '/parent/avvisi') await attendiCardAvvisoVisibili(page);

  await verificaScritteIntere(page, rotta, ['header.kv-appbar', '[data-kv-barra-laterale]']);

  await test.info().attach(`${rotta.replaceAll('/', '_')}-${larghezza}px`, {
    body: await page.screenshot({ style: SENZA_INDICATORE_DEV }),
    contentType: 'image/png',
  });
}

async function attendiCardAvvisoVisibili(page: Page) {
  const stato = () =>
    page.evaluate(() => {
      const card = [...document.querySelectorAll<HTMLElement>('[data-kv-avviso]')];
      const spente = card
        .map((el, i) => ({
          i,
          opacita: getComputedStyle(el).opacity,
          inLinea: el.style.opacity,
          animazioni: el.getAnimations().length,
        }))
        .filter((c) => c.opacita !== '1');
      return { card: card.length, spente };
    });
  await expect
    .poll(async () => {
      const s = await stato();
      return s.card > 0 && s.spente.length === 0 ? 'tutte visibili' : JSON.stringify(s);
    }, { message: 'card degli avvisi rimaste a opacità < 1', timeout: 5_000 })
    .toBe('tutte visibili');
}

/**
 * LA SEGRETERIA SU IPAD. Da 744 px il cockpit ha la topbar desktop; sotto i 1024 px (iPad in
 * verticale) il binario a icone da 88 px (`AdminBinario`), da 1024 (iPad in orizzontale, iPad 13"
 * in verticale) la sidebar piena da 256 px, come genitori e docenti. La PR 3 (#241) teneva il
 * binario fino a 1279: il titolare, sull'11" in orizzontale, ci ha visto «il menu del telefono».
 * In nessun formato la barra in basso del telefono. Le stesse misure di genitori e docenti: pagina
 * giusta, nessuno scorrimento di lato, contenuto a destra della navigazione e largo.
 */
async function verificaGuscioAdmin(page: Page, rotta: string) {
  await page.goto(rotta);

  await expect(page, `«${rotta}» è finita altrove`).not.toHaveURL(/\/auth\/login/);
  expect(new URL(page.url()).pathname).toBe(rotta);

  const conSidebar = page.viewportSize()!.width >= 1024;
  const selNav = conSidebar ? '[data-kv-sidebar-admin]' : '[data-kv-binario-admin]';
  const nav = page.locator(selNav);
  await expect(nav).toBeVisible({ timeout: 20_000 });
  await attendiFineCaricamento(page);

  await expect(page.locator('[data-kv-barra-bassa-admin]'), 'la barra del telefono si vede ancora').toBeHidden();
  if (conSidebar) {
    await expect(page.locator('[data-kv-binario-admin]'), 'in orizzontale c’è ancora il binario a icone').toBeHidden();
    // La sidebar piena ha tutte le voci, non i cinque tab del binario.
    expect(await nav.getByRole('link').count(), 'la sidebar non ha le voci del menu').toBeGreaterThan(8);
  } else {
    await expect(page.locator('[data-kv-sidebar-admin]'), 'la sidebar piena c’è già sotto i 1024 px').toBeHidden();
    await expect(nav.getByRole('link', { name: 'Home' })).toBeVisible();
  }

  const misure = await page.evaluate((sel) => {
    const nav = document.querySelector(sel)!.getBoundingClientRect();
    const contenuto = document.querySelector('[data-cockpit-content]')!.getBoundingClientRect();
    return {
      scorrimento: document.documentElement.scrollWidth,
      finestra: window.innerWidth,
      destraBinario: nav.right,
      larghezzaBinario: nav.width,
      sinistraContenuto: contenuto.left,
      larghezzaContenuto: contenuto.width,
    };
  }, selNav);
  expect(misure.scorrimento, `«${rotta}» scorre di lato: ${JSON.stringify(misure)}`).toBeLessThanOrEqual(misure.finestra + 1);
  expect(misure.larghezzaBinario, conSidebar ? 'la sidebar non è larga 256 px' : 'il binario non è largo 88 px').toBeCloseTo(conSidebar ? 256 : 88, 0);
  expect(misure.sinistraContenuto, `il contenuto di «${rotta}» finisce sotto la navigazione`).toBeGreaterThanOrEqual(misure.destraBinario - 1);
  expect(misure.larghezzaContenuto, `il contenuto di «${rotta}» è stretto: ${JSON.stringify(misure)}`).toBeGreaterThan(600);

  await attendiPaginaFerma(page);

  await verificaScritteIntere(page, rotta, ['[data-kv-topbar-admin]', selNav]);

  await test.info().attach(`${rotta.replaceAll('/', '_')}-${page.viewportSize()!.width}px`, {
    body: await page.screenshot({ style: SENZA_INDICATORE_DEV }),
    contentType: 'image/png',
  });
}

test.describe('genitore su iPad', () => {
  test.use({ storageState: STORAGE.genitore });
  for (const rotta of ROTTE_GENITORE) {
    test(`${rotta}: navigazione laterale, colonna larga, nessuno scorrimento di lato`, async ({ page }) => {
      await verificaGuscioTablet(page, rotta);
    });
  }
});

test.describe('docente su iPad', () => {
  test.use({ storageState: STORAGE.docente });
  for (const rotta of ROTTE_DOCENTE) {
    test(`${rotta}: navigazione laterale, colonna larga, nessuno scorrimento di lato`, async ({ page }) => {
      await verificaGuscioTablet(page, rotta);
    });
  }
});

test.describe('segreteria su iPad', () => {
  test.use({ storageState: STORAGE.admin });
  for (const rotta of ROTTE_SEGRETERIA) {
    test(`${rotta}: binario in verticale, sidebar in orizzontale, nessuna scritta tagliata`, async ({ page }) => {
      await verificaGuscioAdmin(page, rotta);
    });
  }

  test('«Menu» del binario apre il pannello accanto e porta alla voce scelta', async ({ page }) => {
    test.skip(page.viewportSize()!.width >= 1024, 'da 1024 px c’è la sidebar con tutte le voci: non c’è un Menu da aprire');
    await page.goto('/admin');
    const binario = page.locator('[data-kv-binario-admin]');
    await expect(binario).toBeVisible({ timeout: 20_000 });
    await attendiFineCaricamento(page);
    await attendiPaginaFerma(page);

    await binario.getByRole('button', { name: /menu/i }).click();
    const pannello = page.locator('[data-kv-menu-admin="pannello"]').getByRole('dialog');
    await expect(pannello).toBeVisible();
    // Il pannello parte DOPO il binario e sotto la topbar: non copre la navigazione.
    const box = (await pannello.boundingBox())!;
    expect(box.x, 'il pannello copre il binario').toBeGreaterThanOrEqual(87);
    expect(box.y, 'il pannello copre la topbar').toBeGreaterThanOrEqual(63);
    await test.info().attach(`menu-binario-admin-${page.viewportSize()!.width}px`, {
      body: await page.screenshot({ style: SENZA_INDICATORE_DEV }),
      contentType: 'image/png',
    });

    await pannello.getByRole('link', { name: /impostazioni/i }).click();
    await expect(page).toHaveURL(/\/admin\/impostazioni/, { timeout: 15_000 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(binario.getByRole('button', { name: /menu/i })).toHaveAttribute('aria-current', 'true');
  });
});

test.describe('il menu del binario', () => {
  test.use({ storageState: STORAGE.genitore });
  test('«Menu» apre il pannello accanto al binario e porta alla voce scelta', async ({ page }) => {
    test.skip(page.viewportSize()!.width >= 1024, 'da 1024 px la sidebar mostra tutte le voci: non c’è un Menu da aprire');
    await page.goto('/parent');
    await expect(page.locator('[data-kv-barra-laterale]')).toBeVisible({ timeout: 20_000 });
    await attendiFineCaricamento(page);
    await attendiPaginaFerma(page);
    await page.locator('[data-kv-barra-laterale]').getByRole('button', { name: /Menu/i }).click();
    const pannello = page.getByRole('dialog');
    await expect(pannello).toBeVisible();
    // La schermata del pannello aperto, a molla ferma: `toBeVisible` è vero già al primo fotogramma.
    await expect
      .poll(() =>
        pannello.evaluate((el) => {
          const s = getComputedStyle(el);
          return s.opacity === '1' && (s.transform === 'none' || s.transform === 'matrix(1, 0, 0, 1, 0, 0)');
        }),
      )
      .toBe(true);
    await test.info().attach(`menu-binario-${page.viewportSize()!.width}px`, {
      body: await page.screenshot({ style: SENZA_INDICATORE_DEV }),
      contentType: 'image/png',
    });
    await pannello.getByRole('link', { name: /Mensa/i }).click();
    await expect(page).toHaveURL(/\/parent\/mensa/, { timeout: 15_000 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
