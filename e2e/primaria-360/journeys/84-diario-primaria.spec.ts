import { test, expect } from '@playwright/test';
import { storagePath, SCUOLA_GIUGLIANO, BASE_URL } from '../config/accounts';
import { readAppIds, apiGet, apiPatch, withUser, httpOk } from '../lib/harness';

// FASE 1 — Diario 0-6 configurabile per la primaria (E24).
// Il diario 0-6 è NASCOSTO di default alla primaria (fail-closed); l'admin può
// attivarlo esplicitamente per la primaria dal toggle diario_config.diario_primaria_visibile.
// docente1 è su TEST 1A (school_type = primaria): con toggle OFF/assente il diario 0-6
// non compare (empty-state → Registro), con toggle ON ricompare.
//
// NB: muta config PER-SCUOLA (stato condiviso) → eseguire con --workers=1
// (ogni ripetizione ripristina il toggle allo stato di default fail-closed=false nel finally).

const setToggle = async (page: import('@playwright/test').Page, value: boolean) => {
  const r = await apiPatch(page, '/api/admin/settings', {
    scuola_id: SCUOLA_GIUGLIANO,
    diario_config: { diario_primaria_visibile: value },
  });
  expect(httpOk(r.status), `PATCH settings status ${r.status}`).toBeTruthy();
};

test.describe('FASE 1 — diario 0-6 configurabile in primaria', () => {
  test.describe('educator-sections espone school_type', () => {
    test.use({ storageState: storagePath('docente1') });

    test('GET /api/educator-sections restituisce sections[].school_type con la primaria', async ({ page }) => {
      const uid = readAppIds()['docente1'];
      const r = await apiGet(page, withUser('/api/educator-sections', uid));
      expect(httpOk(r.status), `status ${r.status}`).toBeTruthy();
      const body = r.json as { sectionNames?: string[]; sections?: { name: string; school_type: string | null }[] };
      // sectionNames resta invariato (backward-compatible) + nuovo campo sections.
      expect(Array.isArray(body.sectionNames)).toBeTruthy();
      expect(Array.isArray(body.sections), 'manca il campo sections[]').toBeTruthy();
      expect(body.sections!.length, 'nessuna sezione per docente1').toBeGreaterThan(0);
      // docente1 è su TEST 1A (primaria) → almeno una sezione ha school_type primaria.
      expect(body.sections!.some((s) => s.school_type === 'primaria'), 'nessuna sezione primaria').toBeTruthy();
    });
  });

  test.describe('toggle admin pilota la visibilità su /teacher/diary', () => {
    test.use({ storageState: storagePath('docente1') });

    test('toggle OFF → empty-state primaria (niente nanna/bagno); toggle ON → diario visibile', async ({ page, playwright }) => {
      const uid = readAppIds()['docente1'];
      // Contesto API con la sessione segreteria per scrivere la config.
      const seg = await playwright.request.newContext({ baseURL: BASE_URL, storageState: storagePath('segreteria') });
      const patchSeg = async (value: boolean) => {
        const r = await seg.patch('/api/admin/settings', {
          data: { scuola_id: SCUOLA_GIUGLIANO, diario_config: { diario_primaria_visibile: value } },
        });
        expect(r.ok(), `PATCH segreteria status ${r.status()}`).toBeTruthy();
      };

      try {
        // 1) Config GET riflette il toggle (via sessione segreteria, stessa scuola).
        await patchSeg(false);
        const confOff = await seg.get('/api/diary/config');
        expect(((await confOff.json()) as { diario_primaria_visibile?: boolean }).diario_primaria_visibile).toBe(false);

        // 2) Frontend docente1: /teacher/diary mostra l'empty-state primaria, niente diario 0-6.
        await page.goto(withUser('/teacher/diary', uid), { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(/non è attivo per la primaria|usa il Registro/i)).toBeVisible({ timeout: 35000 });
        // Nessun pulsante da nido (Nanna/Bagno) raggiungibile.
        await expect(page.getByRole('button', { name: /nanna|bagno/i })).toHaveCount(0);

        // 3) toggle ON → il diario torna visibile per la primaria.
        await patchSeg(true);
        const confOn = await seg.get('/api/diary/config');
        expect(((await confOn.json()) as { diario_primaria_visibile?: boolean }).diario_primaria_visibile).toBe(true);

        await page.goto(withUser('/teacher/diary', uid), { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        await expect(page.getByText(/non è attivo per la primaria/i)).toHaveCount(0);
        await expect(page.getByRole('heading', { name: /Diario del giorno/i })).toBeVisible({ timeout: 35000 });
      } finally {
        // Ripristina lo stato di default (fail-closed): diario 0-6 nascosto alla primaria.
        await patchSeg(false).catch(() => {});
        await seg.dispose();
      }
    });
  });
});
