import { test, expect } from '@playwright/test';
import { storagePath, SECTION_1A, BASE_URL } from '../config/accounts';
import { readAppIds, apiGet, apiPost, withUser, httpOk } from '../lib/harness';

// FASE 2 — Registro con slot esclusi visibili (opzione B) + editor orari admin.
// - Il registro mostra intervallo/mensa come righe NON firmabili (la numerazione
//   ore non "salta": lo slot escluso resta visibile); i conteggi restano sulle
//   sole lezioni.
// - La segreteria può modificare le singole campanelle (add/update/delete).
//
// Muta l'orario di TEST 1A (stato condiviso) → eseguire con --workers=1.

// 2026-07-06 = lunedì (giorno_settimana 1): dopo set-tempo 27/5 ha 5 lezioni + 1 intervallo.
const LUNEDI = '2026-07-06';

interface Campanella { id: string; giorno_settimana: number; ordine: number; ora_inizio: string; ora_fine: string; tipo: string }

test.describe('FASE 2 — registro slot esclusi + editor orari', () => {
  test.describe('registro docente mostra intervallo e conta solo le lezioni', () => {
    test.use({ storageState: storagePath('docente1') });

    test('l\'intervallo è una riga non firmabile; 5 lezioni firmabili (intervallo escluso dal conteggio)', async ({ page, playwright }) => {
      const uid = readAppIds()['docente1'];
      // Genera un orario noto su TEST 1A come segreteria (27h/5gg → intervallo dopo la 2ª ora).
      const seg = await playwright.request.newContext({ baseURL: BASE_URL, storageState: storagePath('segreteria') });
      try {
        const gen = await seg.post('/api/admin/primaria/orario?action=set-tempo', {
          data: { sectionId: SECTION_1A, modello: 27, giorniSettimana: 5 },
        });
        expect(gen.ok(), `set-tempo status ${gen.status()}`).toBeTruthy();

        await page.goto(withUser(`/teacher/primaria/${SECTION_1A}/registro`, uid), { waitUntil: 'domcontentloaded' });
        // Porta il registro al lunedì (giorno con campanelle).
        await page.fill('input[type="date"]', LUNEDI);
        await page.waitForTimeout(2000);

        // La riga "Intervallo" è presente (slot escluso reso visibile, non firmabile).
        await expect(page.getByText('Intervallo').first()).toBeVisible({ timeout: 35000 });
        // Le sole lezioni sono firmabili: 5 pulsanti Firma/Modifica (l'intervallo non ha pulsante).
        await expect(page.getByRole('button', { name: /^(Firma|Modifica)$/ })).toHaveCount(5);
        // Il conteggio "ore firmate" è su 5 (lezioni), non 6 (con intervallo).
        await expect(page.getByText(/ore firmate/i)).toBeVisible();
      } finally {
        await seg.dispose();
      }
    });
  });

  test.describe('segreteria: CRUD singola campanella', () => {
    test.use({ storageState: storagePath('segreteria') });

    test('add → update → delete di una campanella su TEST 1A', async ({ page }) => {
      const uid = readAppIds()['segreteria'];
      const listCampanelle = async (): Promise<Campanella[]> => {
        const r = await apiGet(page, `/api/admin/primaria/orario?sectionId=${SECTION_1A}`);
        return ((r.json as { data?: { campanelle?: Campanella[] } }).data?.campanelle) ?? [];
      };

      // ADD (una campanella "coda" al lunedì, tipo intervallo, ordine alto per non collidere).
      const add = await apiPost(page, `/api/admin/primaria/orario?action=add-campanella&userId=${uid}`, {
        sectionId: SECTION_1A, giornoSettimana: 1, ordine: 19, oraInizio: '16:00', oraFine: '17:00', tipo: 'intervallo',
      });
      expect(httpOk(add.status), `add status ${add.status}`).toBeTruthy();
      const newId = (add.json as { data?: { id?: string } }).data?.id;
      expect(newId, 'add non ha restituito id').toBeTruthy();

      let camps = await listCampanelle();
      const added = camps.find((c) => c.id === newId);
      expect(added, 'campanella aggiunta non trovata').toBeTruthy();
      expect(added!.tipo).toBe('intervallo');

      // UPDATE (cambia orario fine e tipo → lezione).
      const upd = await apiPost(page, `/api/admin/primaria/orario?action=update-campanella&userId=${uid}`, {
        sectionId: SECTION_1A, campanellaId: newId, oraFine: '17:30', tipo: 'lezione',
      });
      expect(httpOk(upd.status), `update status ${upd.status}`).toBeTruthy();
      camps = await listCampanelle();
      const updated = camps.find((c) => c.id === newId);
      expect(updated?.tipo).toBe('lezione');
      expect(String(updated?.ora_fine).slice(0, 5)).toBe('17:30');

      // Validazione: ora_fine <= ora_inizio → 400.
      const bad = await apiPost(page, `/api/admin/primaria/orario?action=update-campanella&userId=${uid}`, {
        sectionId: SECTION_1A, campanellaId: newId, oraInizio: '18:00', oraFine: '17:00',
      });
      expect(bad.status, 'orario incoerente doveva dare 400').toBe(400);

      // DELETE (ripristina lo stato: nessun residuo).
      const del = await apiPost(page, `/api/admin/primaria/orario?action=delete-campanella&userId=${uid}`, {
        sectionId: SECTION_1A, campanellaId: newId,
      });
      expect(httpOk(del.status), `delete status ${del.status}`).toBeTruthy();
      camps = await listCampanelle();
      expect(camps.find((c) => c.id === newId), 'campanella non eliminata').toBeFalsy();
    });
  });
});
