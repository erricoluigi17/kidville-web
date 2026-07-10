import { test, expect } from '@playwright/test';
import { storagePath } from '../config/accounts';
import { readAppIds, withUser } from '../lib/harness';

// FASE 3 — Minori testuali: "Task" → "Attività" (testo visibile) e tab con
// affordance di scroll orizzontale (niente troncamento).

test.describe('FASE 3 — minori testuali (tasks)', () => {
  test.use({ storageState: storagePath('docente1') });

  test('/teacher/tasks: header "Attività", niente "Task" visibile, tab scrollabili', async ({ page }) => {
    const uid = readAppIds()['docente1'];
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));

    await page.goto(withUser('/teacher/tasks', uid), { waitUntil: 'domcontentloaded' });

    // Titolo tradotto.
    await expect(page.getByRole('heading', { name: 'Attività', exact: true })).toBeVisible({ timeout: 35000 });

    // Nessun refuso "Task" nel testo visibile (etichette/empty-state/loading tradotti).
    const body = (await page.textContent('body')) ?? '';
    expect(body).not.toContain('Tutti i Task');
    expect(body).not.toMatch(/Nessun task attivo/i);
    expect(body).not.toMatch(/Caricamento task/i);

    // La tab-bar è dentro un contenitore con overflow-x-auto (scroll orizzontale).
    const tabBar = page.locator('div.overflow-x-auto').filter({ has: page.getByRole('button', { name: 'Assegnati a me' }) });
    await expect(tabBar).toHaveCount(1);

    expect(pageErrors, `pageerror: ${pageErrors.join(' | ')}`).toEqual([]);
  });
});
