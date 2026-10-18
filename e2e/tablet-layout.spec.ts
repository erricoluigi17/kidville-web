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
 * Dalla PR 3 ci sono anche la segreteria (`verificaGuscioAdmin`: binario fino a 1279 px, quindi
 * in tutti e due i progetti) e le card degli avvisi che restavano bianche (punto 6).
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
 * LA SEGRETERIA SU IPAD (PR 3). Fra 744 e 1279 px il cockpit ha la topbar desktop e il binario a
 * icone da 88 px (`AdminBinario`); la barra in basso del telefono e la sidebar piena da 256 px
 * (che c'è da 1280) non devono vedersi. Le stesse misure di genitori e docenti: pagina giusta,
 * nessuno scorrimento di lato, contenuto a destra del binario e largo.
 */
async function verificaGuscioAdmin(page: Page, rotta: string) {
  await page.goto(rotta);

  await expect(page, `«${rotta}» è finita altrove`).not.toHaveURL(/\/auth\/login/);
  expect(new URL(page.url()).pathname).toBe(rotta);

  const binario = page.locator('[data-kv-binario-admin]');
  await expect(binario).toBeVisible({ timeout: 20_000 });
  await attendiFineCaricamento(page);

  await expect(page.locator('[data-kv-barra-bassa-admin]'), 'la barra del telefono si vede ancora').toBeHidden();
  await expect(page.locator('[data-kv-sidebar-admin]'), 'la sidebar piena c’è già sotto i 1280 px').toBeHidden();
  await expect(binario.getByRole('link', { name: 'Home' })).toBeVisible();

  const misure = await page.evaluate(() => {
    const nav = document.querySelector('[data-kv-binario-admin]')!.getBoundingClientRect();
    const contenuto = document.querySelector('[data-cockpit-content]')!.getBoundingClientRect();
    return {
      scorrimento: document.documentElement.scrollWidth,
      finestra: window.innerWidth,
      destraBinario: nav.right,
      larghezzaBinario: nav.width,
      sinistraContenuto: contenuto.left,
      larghezzaContenuto: contenuto.width,
    };
  });
  expect(misure.scorrimento, `«${rotta}» scorre di lato: ${JSON.stringify(misure)}`).toBeLessThanOrEqual(misure.finestra + 1);
  expect(misure.larghezzaBinario, 'il binario non è largo 88 px').toBeCloseTo(88, 0);
  expect(misure.sinistraContenuto, `il contenuto di «${rotta}» finisce sotto il binario`).toBeGreaterThanOrEqual(misure.destraBinario - 1);
  expect(misure.larghezzaContenuto, `il contenuto di «${rotta}» è stretto: ${JSON.stringify(misure)}`).toBeGreaterThan(600);

  await attendiPaginaFerma(page);

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
    test(`${rotta}: binario, nessuna barra in basso, nessuno scorrimento di lato`, async ({ page }) => {
      await verificaGuscioAdmin(page, rotta);
    });
  }

  test('«Menu» del binario apre il pannello accanto e porta alla voce scelta', async ({ page }) => {
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
