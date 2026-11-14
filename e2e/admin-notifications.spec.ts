import { test } from '@playwright/test';
import { conNotificaPropria, segnaTutteLette } from './helpers/notifica-propria';
import { IDS, STORAGE } from './fixtures';

// Centro notifiche admin: badge non lette, dropdown, "Segna tutte lette".
// Stessa forma dello spec genitore: ogni tentativo ha la SUA notifica non letta e asserisce solo
// su quella (vedi `helpers/notifica-propria.ts`), perché l'admin riceve notifiche anche da altri
// test in parallelo (candidature, iscrizioni) e il seme è consumabile una volta sola.
test.use({ storageState: STORAGE.admin });

test('badge non lette → dropdown → segna tutte lette', async ({ page }) => {
  await conNotificaPropria(IDS.ADMIN, async (db, id, titolo) => {
    await page.goto('/admin');
    await segnaTutteLette(page, db, id, titolo);
  });
});
