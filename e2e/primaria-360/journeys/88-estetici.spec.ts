import { test, expect } from '@playwright/test';
import { storagePath, SECTION_1A } from '../config/accounts';
import { readAppIds, withUser } from '../lib/harness';

// FASE 5 — Estetici: pulsante import in verde brand (non blu off-brand),
// input file SIDI con label italiana (niente "Choose File"), e niente più
// "muro di trattini" (—) negli slot orario vuoti (placeholder tenue).

test.describe('FASE 5 — estetici', () => {
  test.describe('segreteria: pulsante verde + label file italiana', () => {
    test.use({ storageState: storagePath('segreteria') });

    test('/admin/tools: il pulsante "Carica file compilato" è verde, non blu', async ({ page }) => {
      const uid = readAppIds()['segreteria'];
      await page.goto(withUser('/admin/tools', uid), { waitUntil: 'domcontentloaded' });
      const label = page.locator('label', { hasText: 'Carica file compilato' });
      await expect(label).toBeVisible({ timeout: 35000 });
      const cls = (await label.getAttribute('class')) ?? '';
      expect(cls, 'pulsante non verde').toContain('bg-kidville-green');
      expect(cls, 'pulsante ancora blu off-brand').not.toContain('bg-kidville-info');
    });

    test('/admin/sidi: input file con label italiana "Scegli file .zip" (input nascosto)', async ({ page }) => {
      const uid = readAppIds()['segreteria'];
      await page.goto(withUser('/admin/sidi', uid), { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('Scegli file .zip')).toBeVisible({ timeout: 35000 });
      // L'input nativo (che mostrerebbe "Choose File" in EN) è nascosto dietro la label.
      await expect(page.locator('input[type="file"][accept=".zip"]')).toHaveClass(/hidden/);
    });
  });

  test.describe('docente: niente muro di trattini nella griglia orario', () => {
    test.use({ storageState: storagePath('docente1') });

    test('/teacher/primaria/[TEST1A]/orario: nessuno slot reso con em-dash "—"', async ({ page }) => {
      const uid = readAppIds()['docente1'];
      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));
      await page.goto(withUser(`/teacher/primaria/${SECTION_1A}/orario`, uid), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1800);
      // Le celle vuote non usano più il trattino lungo "—" (em-dash): 0 occorrenze esatte.
      await expect(page.getByText('—', { exact: true })).toHaveCount(0);
      expect(pageErrors, `pageerror: ${pageErrors.join(' | ')}`).toEqual([]);
    });
  });
});
