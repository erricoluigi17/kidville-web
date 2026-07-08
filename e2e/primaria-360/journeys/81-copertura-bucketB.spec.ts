import { test, expect } from '@playwright/test';
import { storagePath } from '../config/accounts';
import { ALUNNI } from '../config/data';
import { apiGet, readAppIds, httpOk } from '../lib/harness';

// BUCKET B — verifica dei gravi funzionali (E6-E15) su 3 personas reali.
// Backend (asserzioni API), frontend (visita pagina), debugging (no 5xx / no
// pageerror / no hydration), grafica (sezione reale visibile, no skeleton perenne).

function collectErrors(page: import('@playwright/test').Page) {
  const errors: string[] = [];
  const server5xx: number[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 160)}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && /hydrat/i.test(m.text())) errors.push(`hydration: ${m.text().slice(0, 160)}`);
  });
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 500) server5xx.push(r.status());
  });
  return { errors, server5xx };
}

test.describe('BUCKET B — gravi funzionali', () => {
  test.describe('docente1 (educator TEST 1A)', () => {
    test.use({ storageState: storagePath('docente1') });

    test('E6/E7/E9/E10: sezione reale, certificati aperti al docente, niente Girasoli/hydration', async ({ page }) => {
      const uid = readAppIds()['docente1'];

      // E6/E7: sezione derivata (educator-sections) → TEST 1A, mai Girasoli.
      const secs = await apiGet(page, `/api/educator-sections?userId=${uid}`);
      expect(httpOk(secs.status)).toBeTruthy();
      const secStr = JSON.stringify(secs.json ?? {});
      expect(secStr, 'la sezione del docente deve essere TEST 1A').toContain('TEST 1A');
      expect(secStr, 'niente Girasoli hardcoded').not.toContain('Girasoli');

      // E9: certificati medici accessibili al DOCENTE (era 403 requireStaff).
      const med = await apiGet(page, `/api/teacher/medical-certificates?class_name=${encodeURIComponent('TEST 1A')}`);
      expect(med.status, 'certificati medici: il docente non deve prendere 403').not.toBe(403);
      expect(httpOk(med.status)).toBeTruthy();

      // E10: gallery/attendance senza hydration error, sezione reale a schermo.
      const { errors, server5xx } = collectErrors(page);
      await page.goto(`/teacher/attendance?userId=${uid}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('TEST 1A').first()).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(1200);
      await page.goto(`/teacher/gallery?userId=${uid}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      expect(errors, `errori runtime docente: ${errors.join(' | ')}`).toEqual([]);
      expect(server5xx, `5xx docente: ${server5xx.join(',')}`).toEqual([]);
    });
  });

  test.describe('genitore1 (madre Alunno1)', () => {
    test.use({ storageState: storagePath('genitore1') });

    test('E8/E11/E12: submissions/locker senza 500, avvisi/locker senza 5xx', async ({ page }) => {
      const uid = readAppIds()['genitore1'];

      // E12: submissions GET non deve più dare 500.
      const sub = await apiGet(page, `/api/parent/submissions?userId=${uid}`);
      expect(sub.status, 'submissions non deve dare 500').not.toBe(500);
      expect(httpOk(sub.status)).toBeTruthy();

      // E11: locker del PROPRIO figlio → 200 (niente 400 da alunno_id=null).
      const lock = await apiGet(page, `/api/locker/inventory?alunno_id=${ALUNNI[1]}&mode=stock`);
      expect(lock.status, 'locker inventory figlio proprio → 200').toBe(200);
      // locker/requests non deve dare 500 (tabella non migrata su prod → degrada a []).
      const lockReq = await apiGet(page, `/api/locker/requests?alunno_id=${ALUNNI[1]}`);
      expect(lockReq.status, 'locker/requests non deve dare 500').not.toBe(500);

      // E8/E11: pagine genitore senza 5xx né pageerror.
      const { errors, server5xx } = collectErrors(page);
      for (const path of ['/parent/locker', '/parent/avvisi', '/parent/modulistica']) {
        await page.goto(`${path}?userId=${uid}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(1500);
      }
      expect(errors, `errori runtime genitore: ${errors.join(' | ')}`).toEqual([]);
      expect(server5xx, `5xx genitore: ${server5xx.join(',')}`).toEqual([]);
    });
  });

  test.describe('segreteria (dashboard direzione)', () => {
    test.use({ storageState: storagePath('segreteria') });

    test('E15: dashboard KPI popolata (niente skeleton perenne)', async ({ page }) => {
      const uid = readAppIds()['segreteria'];
      const dash = await apiGet(page, `/api/admin/dashboard?userId=${uid}`);
      expect(httpOk(dash.status)).toBeTruthy();

      const { server5xx } = collectErrors(page);
      await page.goto(`/admin?userId=${uid}`, { waitUntil: 'domcontentloaded' });
      // KPI reali a schermo: l'etichetta "Alunni iscritti" appare solo quando i dati
      // sono caricati (non durante lo skeleton). Timeout ampio: sotto carico parallelo
      // la dashboard aggrega più query (studenti/pagamenti/iscrizioni/mensa/presenze).
      await expect(page.getByText('Alunni iscritti').first()).toBeVisible({ timeout: 35000 });
      expect(server5xx, `5xx admin: ${server5xx.join(',')}`).toEqual([]);
    });
  });
});
