import { test, expect, type Page } from '@playwright/test';
import { storagePath, SECTION_1A } from '../config/accounts';
import { readAppIds, withUser, apiGet, httpOk } from '../lib/harness';

// Verifica delle fix del giro diagnostico 360° (2026-07-09):
// F1 mensa data-binding · F2 armadietto de-hardcode · F3 KPI iscritti (=23) ·
// F4 perClasse (dati) · F5/F6 bottom-nav mutua esclusività · F7 spinner settings ·
// F8 plurale note · F9 diario fail-closed primaria · F10 avatar overflow · F11 asse Y incassi.

// Quante voci del bottom-nav risultano "attive" (label verde #006A5F = rgb(0,106,95)).
async function activeMainTabs(page: Page): Promise<string[]> {
  await page.locator('nav[aria-label="Navigazione principale"]').first().waitFor({ state: 'visible', timeout: 20000 });
  return page.locator('nav[aria-label="Navigazione principale"]').first().evaluate((nav) => {
    const ACTIVE = 'rgb(0, 106, 95)';
    return Array.from((nav as HTMLElement).children).flatMap((tab) => {
      const label = tab.querySelector('span:last-child') as HTMLElement | null;
      if (label && getComputedStyle(label).color === ACTIVE) return [label.textContent?.trim() ?? ''];
      return [];
    });
  });
}

// ─────────────────────────── DOCENTE (docente1 · TEST 1A) ───────────────────────────
test.describe('360 fix · docente1 (TEST 1A)', () => {
  test.use({ storageState: storagePath('docente1') });

  test('F2 · armadietto usa la sezione reale del docente (non più Girasoli)', async ({ page }) => {
    const uid = readAppIds()['docente1'];
    // Backend: educator-sections espone la sezione reale.
    const r = await apiGet(page, withUser('/api/educator-sections', uid));
    expect(httpOk(r.status), `educator-sections status ${r.status}`).toBeTruthy();
    const sects = (r.json as { sectionNames?: string[] }).sectionNames ?? [];
    expect(sects, 'sectionNames vuoto per docente1').toContain('TEST 1A');
    // UI: header con la sezione reale, nessuna traccia di 'Girasoli'.
    await page.goto(withUser('/teacher/locker', uid), { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Sezione\s+TEST 1A/)).toBeVisible({ timeout: 35000 });
    await expect(page.getByText('Girasoli')).toHaveCount(0);
  });

  test('F5 · bottom-nav docente: una sola voce attiva per rotta', async ({ page }) => {
    const uid = readAppIds()['docente1'];
    const cases: [string, string][] = [
      ['/teacher/primaria', 'Registro'],
      ['/teacher/gallery', 'Foto'],
      ['/teacher/chat', 'Messaggi'],
      ['/teacher/tasks', 'Menu'],
    ];
    for (const [route, expected] of cases) {
      await page.goto(withUser(route, uid), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(700);
      const active = await activeMainTabs(page);
      expect(active, `rotta ${route}: attese 1 voce attiva, trovate ${active.length} (${active.join(',')})`).toHaveLength(1);
      expect(active[0], `rotta ${route}: voce attiva errata`).toBe(expected);
    }
  });

  test('F7 · impostazioni armadietto: nessuno spinner permanente', async ({ page }) => {
    const uid = readAppIds()['docente1'];
    await page.goto(withUser('/teacher/settings/locker', uid), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2800);
    await expect(page.getByText('Caricamento...')).toHaveCount(0);
  });

  test('F9 · diario 0-6 fail-closed per la primaria (empty-state, niente nido)', async ({ page }) => {
    const uid = readAppIds()['docente1'];
    await page.goto(withUser('/teacher/diary', uid), { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/non è attivo per la primaria|usa il Registro/i)).toBeVisible({ timeout: 35000 });
    await expect(page.getByRole('button', { name: /nanna|bagno/i })).toHaveCount(0);
  });

  test('F10 · avatar classe: testo contenuto nel badge (no overflow)', async ({ page }) => {
    const uid = readAppIds()['docente1'];
    await page.goto(withUser('/teacher/primaria', uid), { waitUntil: 'domcontentloaded' });
    const badge = page.locator(`a[href*="/teacher/primaria/"] > div`).first();
    await badge.waitFor({ state: 'visible', timeout: 35000 });
    const fits = await badge.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1);
    expect(fits, 'il nome classe trabocca dal badge quadrato').toBeTruthy();
  });
});

// ─────────────────────────── GENITORE (genitore1 · Alunno1) ───────────────────────────
test.describe('360 fix · genitore1 (Alunno1)', () => {
  test.use({ storageState: storagePath('genitore1') });

  test('F1 · mensa: saldo numerico + banner cutoff (data-binding ok)', async ({ page }) => {
    await page.goto('/parent/mensa', { waitUntil: 'domcontentloaded' });
    // Badge ticket: il valore prima di "ticket" è un numero (non "—").
    const badge = page.locator('div:has(> span:text-is("ticket"))').first();
    await badge.waitFor({ state: 'visible', timeout: 35000 });
    await expect(badge).toContainText(/\d/);
    await expect(badge).not.toContainText('—');
    // Banner cutoff presente (cutoffOra correttamente letto dal payload).
    await expect(page.getByText(/Prenota o disdici entro le/i)).toBeVisible({ timeout: 10000 });
  });

  test('F6 · bottom-nav genitore: una sola voce attiva per rotta', async ({ page }) => {
    const cases: [string, string][] = [
      ['/parent/primaria', 'Scuola'],
      ['/parent/primaria/note', 'Scuola'],
      ['/parent/avvisi', 'Avvisi'],
      ['/parent/mensa', 'Menu'],
    ];
    for (const [route, expected] of cases) {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      // Attende che il tab atteso sia reso: per le rotte primaria significa attendere
      // la risoluzione async di isPrimaria (useChildSchoolType → /api/parent/primaria).
      const nav = page.locator('nav[aria-label="Navigazione principale"]').first();
      await nav.getByText(expected, { exact: true }).waitFor({ state: 'visible', timeout: 20000 });
      await page.waitForTimeout(300);
      const active = await activeMainTabs(page);
      expect(active, `rotta ${route}: attese 1 voce attiva, trovate ${active.length} (${active.join(',')})`).toHaveLength(1);
      expect(active[0], `rotta ${route}: voce attiva errata`).toBe(expected);
    }
  });

  test('F8 · note: pluralizzazione corretta (4 note in attesa)', async ({ page }) => {
    await page.goto('/parent/primaria/note', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/\d+ note in attesa di firma/)).toBeVisible({ timeout: 35000 });
    // Nessun "N nota in attesa" con N>1 (concordanza rotta).
    await expect(page.getByText(/[2-9]\d* nota in attesa/)).toHaveCount(0);
  });
});

// ─────────────────────────── DIREZIONE/SEGRETERIA (dashboard) ───────────────────────────
test.describe('360 fix · segreteria (dashboard direzione)', () => {
  test.use({ storageState: storagePath('segreteria') });

  test('F3/F4 · KPI iscritti = 23 e distribuzione per classe reale', async ({ page }) => {
    const r = await apiGet(page, '/api/admin/dashboard');
    expect(httpOk(r.status), `dashboard status ${r.status}`).toBeTruthy();
    const d = r.json as { studenti?: { iscritti?: number; perClasse?: { classe: string; count: number }[] } };
    expect(d.studenti?.iscritti, 'KPI iscritti diverso da 23').toBe(23);
    const perClasse = d.studenti?.perClasse ?? [];
    const test1a = perClasse.find((p) => p.classe === 'TEST 1A');
    const infanzia = perClasse.find((p) => p.classe === 'TEST Infanzia');
    expect(test1a?.count, 'conteggio TEST 1A errato').toBe(11);
    expect(infanzia?.count, 'conteggio TEST Infanzia errato').toBe(10);
  });

  test('F11 · grafico incassi: asse Y senza formato "k" misto', async ({ page }) => {
    const uid = readAppIds()['segreteria'];
    await page.goto(withUser('/admin', uid), { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Incassi/i).first()).toBeVisible({ timeout: 35000 });
    await page.waitForTimeout(1500);
    // Nessun tick dell'asse in formato "1k/2k" (vecchio formatter misto).
    const kTicks = await page.locator('svg text').evaluateAll((els) =>
      els.map((e) => e.textContent?.trim() ?? '').filter((t) => /^\d+k$/.test(t)),
    );
    expect(kTicks, `tick 'k' ancora presenti: ${kTicks.join(',')}`).toEqual([]);
  });
});
