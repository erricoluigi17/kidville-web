import { test, expect } from '@playwright/test';
import { storagePath, SECTION_1A, SCUOLA_GIUGLIANO } from '../config/accounts';
import { apiGet, apiPost, readAppIds, httpOk } from '../lib/harness';

// BUCKET C — coerenza roster/dati primaria (E16/E17/E18) dalla segreteria.
test.describe('BUCKET C — roster/dati primaria', () => {
  test.describe('segreteria', () => {
    test.use({ storageState: storagePath('segreteria') });

    test('E17: /api/admin/sections elenca TEST 1A come primaria', async ({ page }) => {
      const uid = readAppIds()['segreteria'];
      const res = await apiGet(page, `/api/admin/sections?userId=${uid}&scuola_id=${SCUOLA_GIUGLIANO}`);
      expect(httpOk(res.status)).toBeTruthy();
      const sezioni = (res.json ?? []) as Array<{ name: string; school_type: string }>;
      const test1a = sezioni.find((s) => s.name === 'TEST 1A');
      expect(test1a, 'TEST 1A deve comparire tra le sezioni').toBeTruthy();
      expect(test1a?.school_type, 'TEST 1A deve essere di tipo primaria').toBe('primaria');
    });

    test('E16: roster classe TEST 1A conta gli 11 alunni', async ({ page }) => {
      const uid = readAppIds()['segreteria'];
      const res = await apiGet(page, `/api/primaria/classe/${SECTION_1A}?userId=${uid}`);
      expect(httpOk(res.status)).toBeTruthy();
      const alunni = ((res.json as { data?: { alunni?: unknown[] } })?.data?.alunni) ?? [];
      expect(alunni.length, 'TEST 1A deve avere 11 alunni iscritti').toBe(11);
    });

    test('E18: creazione sezione con school_type non valido → 400 (validazione)', async ({ page }) => {
      const uid = readAppIds()['segreteria'];
      // school_type spazzatura: la validazione zod deve rifiutare PRIMA di scrivere.
      const res = await apiPost(page, `/api/admin/sections?userId=${uid}`, {
        name: 'ZZ_TEST_INVALID_DO_NOT_CREATE', school_type: 'xyz_non_valido', scuola_id: SCUOLA_GIUGLIANO,
      });
      expect(res.status, 'school_type non valido deve dare 400 (niente sezione creata)').toBe(400);
    });
  });
});
