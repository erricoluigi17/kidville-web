import { test, expect } from '@playwright/test';
import { storagePath } from '../config/accounts';
import { readAppIds, withUser, apiGet, apiPatch, httpOk } from '../lib/harness';

// Verifica de-hardcode + anagrafica sede (2026-07-10):
// 'Girasoli'/'Milano'/'2026/2027' eliminati da avvisi docente, gallery,
// certificati self-service, default API e mappe email→sezione; anagrafica di
// sede (config.anagrafica) salvabile e riletta. Il contenuto testuale dei PDF
// è coperto dagli unit test vitest dei builder (certificati-self-service).

const SEDE_E2E = 'e2e00000-0000-4000-8000-000000000001'; // sede fittizia già in prod: MAI toccare Giugliano

// ─────────────────────────── DOCENTE (docente1 · TEST 1A) ───────────────────────────
test.describe('de-hardcode · docente1 (TEST 1A)', () => {
  test.use({ storageState: storagePath('docente1') });

  test('D1 · API educator-sections: TEST 1A presente, Girasoli assente', async ({ page }) => {
    const uid = readAppIds()['docente1'];
    const r = await apiGet(page, withUser('/api/educator-sections', uid));
    expect(httpOk(r.status), `educator-sections status ${r.status}`).toBeTruthy();
    const sects = (r.json as { sectionNames?: string[] }).sectionNames ?? [];
    expect(sects, 'sectionNames non contiene TEST 1A').toContain('TEST 1A');
    expect(sects, 'sectionNames contiene ancora Girasoli').not.toContain('Girasoli');
  });

  test('D2 · avvisi: il form "Nuovo" propone le classi reali del docente', async ({ page }) => {
    const uid = readAppIds()['docente1'];
    await page.goto(withUser('/teacher/avvisi', uid), { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /nuovo/i }).click();
    // Modale = contenitore che ha sia il titolo sia il selettore di scope.
    const modal = page.locator('div')
      .filter({ has: page.getByRole('heading', { name: /nuovo avviso/i }) })
      .filter({ has: page.getByRole('button', { name: /per classe/i }) })
      .last();
    await modal.getByRole('button', { name: /per classe/i }).click();
    // Le pill arrivano async da /api/educator-sections: attesa esplicita.
    await expect(modal.getByRole('button', { name: 'TEST 1A', exact: true })).toBeVisible({ timeout: 20000 });
    // Scoped al modale: avvisi legacy in lista possono citare classi storiche.
    await expect(modal.getByText('Girasoli')).toHaveCount(0);
  });

  test('D3 · gallery: header con la sezione reale, niente Girasoli', async ({ page }) => {
    const uid = readAppIds()['docente1'];
    await page.goto(withUser('/teacher/gallery', uid), { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/della sezione TEST 1A/)).toBeVisible({ timeout: 35000 });
    await expect(page.getByText('Girasoli')).toHaveCount(0);
  });

  test("D4 · attendance/daily SENZA sezione: 200 e lista vuota (default '')", async ({ page }) => {
    const uid = readAppIds()['docente1'];
    const r = await apiGet(page, withUser('/api/attendance/daily', uid)); // nessun param sezione
    expect(httpOk(r.status), `attendance/daily status ${r.status}`).toBeTruthy();
    expect(Array.isArray(r.json), 'attesa risposta array').toBeTruthy();
    expect((r.json as unknown[]).length, "senza sezione deve degradare a [] (non dati Girasoli)").toBe(0);
  });

  test('D5 · tasks: 200 dopo la rimozione della mappa email→sezione', async ({ page }) => {
    const uid = readAppIds()['docente1'];
    const r = await apiGet(page, `/api/tasks?userId=${uid}`);
    expect(httpOk(r.status), `tasks status ${r.status}`).toBeTruthy();
    expect(Array.isArray(r.json), 'attesa risposta array').toBeTruthy();
  });
});

// ─────────────────────────── GENITORE (genitore1 · Alunno1) ───────────────────────────
test.describe('de-hardcode · genitore1 (Alunno1)', () => {
  test.use({ storageState: storagePath('genitore1') });

  test('D6 · API parent/students: classe reale e città della scuola (per figlio)', async ({ page }) => {
    const uid = readAppIds()['genitore1'];
    const r = await apiGet(page, withUser('/api/parent/students', uid));
    expect(httpOk(r.status), `parent/students status ${r.status}`).toBeTruthy();
    const data = (r.json as { data?: { classe_sezione?: string; scuola_citta?: string | null; scuola_nome?: string | null }[] }).data ?? [];
    expect(data.length, 'nessun figlio restituito').toBeGreaterThan(0);
    expect(data[0].classe_sezione, 'classe_sezione errata').toBe('TEST 1A');
    expect(data[0].scuola_citta, 'scuola_citta mancante/errata').toBe('Giugliano');
    expect(data[0].scuola_nome, 'scuola_nome mancante').toBe('Kidville Giugliano');
  });

  test('D7 · certificato frequenza: download PDF + toast di successo', async ({ page }) => {
    await page.goto('/parent/modulistica', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /certificati self-service/i }).click();
    // Il tab certificati è dietro il gate `isLoading` (5 fetch di fetchData:
    // forms, submissions, medical, students, /api/me). In dev mode la
    // compilazione on-demand delle route può superare i 20s di default → attesa
    // esplicita che lo spinner sparisca prima di cercare il bottone.
    await expect(page.getByText(/Caricamento in corso/)).toHaveCount(0, { timeout: 45000 });
    // La card Frequenza è la prima delle due: primo bottone "Scarica PDF".
    const scarica = page.getByRole('button', { name: /scarica pdf/i }).first();
    await scarica.waitFor({ state: 'visible', timeout: 15000 });
    const downloadPromise = page.waitForEvent('download', { timeout: 25000 });
    await scarica.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename(), 'nome file certificato').toContain('FREQUENZA');
    await expect(page.getByText(/Certificato scaricato con successo/)).toBeVisible({ timeout: 10000 });
  });
});

// ─────────────────────────── SEGRETERIA (coordinator) ───────────────────────────
test.describe('anagrafica sede · segreteria (coordinator)', () => {
  test.use({ storageState: storagePath('segreteria') });

  test('D8 · PATCH anagrafica su sede E2E: salva, normalizza e rilegge', async ({ page }) => {
    const uid = readAppIds()['segreteria'];
    const r = await apiPatch(page, withUser('/api/admin/schools', uid), {
      id: SEDE_E2E,
      anagrafica: { codice_meccanografico: 'na1e000e2e', cap: '80100', provincia: 'na', pec: 'e2e@pec.test' },
    });
    expect(httpOk(r.status), `PATCH schools status ${r.status}`).toBeTruthy();
    const g = await apiGet(page, withUser('/api/admin/schools', uid));
    expect(httpOk(g.status), `GET schools status ${g.status}`).toBeTruthy();
    const sede = (g.json as { id: string; config?: { anagrafica?: Record<string, unknown> } }[]).find(s => s.id === SEDE_E2E);
    expect(sede, 'sede E2E non trovata').toBeTruthy();
    expect(sede?.config?.anagrafica?.codice_meccanografico, 'cod. mecc. non normalizzato/salvato').toBe('NA1E000E2E');
    expect(sede?.config?.anagrafica?.provincia).toBe('NA');
    expect(sede?.config?.anagrafica?.pec).toBe('e2e@pec.test');
  });

  test('D9 · SchoolsPanel: il form Anagrafica si apre e mostra i campi', async ({ page }) => {
    const uid = readAppIds()['segreteria'];
    await page.goto(withUser('/admin/schools', uid), { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/gestione multi-sede/i)).toBeVisible({ timeout: 35000 });
    await page.getByTitle('Anagrafica').first().click();
    await expect(page.getByPlaceholder('Codice meccanografico')).toBeVisible();
    await expect(page.getByPlaceholder('PEC')).toBeVisible();
  });
});
