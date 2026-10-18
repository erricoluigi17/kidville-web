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
 * Ogni rotta allega la sua schermata al report: è la prova da guardare prima del merge, e il
 * punto di partenza della PR 2 (le schermate su più colonne).
 *
 * `retries: 0` nei due progetti: una misura sbagliata è la stessa anche al terzo tentativo.
 */

const ROTTE_GENITORE = ['/parent', '/parent/diary', '/parent/avvisi', '/parent/mensa', '/parent/pagamenti', '/parent/gallery', '/parent/chat'];
const ROTTE_DOCENTE = ['/teacher', '/teacher/attendance', '/teacher/diary', '/teacher/gallery', '/teacher/chat'];

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

  await test.info().attach(`${rotta.replaceAll('/', '_')}-${larghezza}px`, {
    body: await page.screenshot(),
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

test.describe('il menu del binario', () => {
  test.use({ storageState: STORAGE.genitore });
  test('«Menu» apre il pannello accanto al binario e porta alla voce scelta', async ({ page }) => {
    test.skip(page.viewportSize()!.width >= 1024, 'da 1024 px la sidebar mostra tutte le voci: non c’è un Menu da aprire');
    await page.goto('/parent');
    await expect(page.locator('[data-kv-barra-laterale]')).toBeVisible({ timeout: 20_000 });
    await attendiFineCaricamento(page);
    await page.locator('[data-kv-barra-laterale]').getByRole('button', { name: /Menu/i }).click();
    const pannello = page.getByRole('dialog');
    await expect(pannello).toBeVisible();
    await pannello.getByRole('link', { name: /Mensa/i }).click();
    await expect(page).toHaveURL(/\/parent\/mensa/, { timeout: 15_000 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
