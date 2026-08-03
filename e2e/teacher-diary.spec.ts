import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Diario docente (/teacher/diary, sezione Girasoli): evento merenda + umore.
test.use({ storageState: STORAGE.docente });

// Il salvataggio del diario fa una ventina di viaggi al database in sequenza
// (select+insert per bambino, audit, notifica ai titolari, e per ogni figlio:
// sede, toggle, debounce, inserimento notifiche). Con due bambini in sezione
// sfiora i 5 secondi del timeout di default, e quando il DB E2E rallenta li
// supera: il 2026-07-30 lo stesso commit di `main` è passato alle 10:28 e
// fallito alle 13:40. Aspettare la RISPOSTA invece di una soglia toglie di
// mezzo la gara: il toast si asserisce dopo che il POST è davvero tornato.
async function salvaEAttendi(page: import('@playwright/test').Page, bottone: RegExp) {
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/diary/entries') && r.request().method() === 'POST',
      { timeout: 30_000 },
    ),
    page.getByRole('button', { name: bottone }).click(),
  ]);
  // Se il salvataggio fallisce lato server il toast non comparirebbe comunque:
  // meglio un errore che dice QUALE stato è tornato, che un «elemento non trovato».
  expect(res.status(), `POST /api/diary/entries ha risposto ${res.status()}`).toBeLessThan(300);
  await expect(page.getByText('✅ Salvato con successo!')).toBeVisible();
}

async function mostraTuttiIBambini(page: import('@playwright/test').Page) {
  // Il filtro parte su "Solo presenti": passo a "Tutti" per non dipendere
  // dall'appello, attendendo il refetch degli alunni (il ripristino dello
  // stato salvato usa la lista corrente: senza attesa correrebbe in gara).
  const toggle = page.getByRole('button', { name: 'Solo presenti' });
  if (await toggle.isVisible().catch(() => false)) {
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/diary/students') && r.status() === 200
      ),
      toggle.click(),
    ]);
  }
}

test('diario: salva merenda e umore, con persistenza', async ({ page }) => {
  await page.goto('/teacher/diary');

  // ⏱️ TIMEOUT ESPLICITO, come sulla riga sotto — e non è un modo di far tacere il test.
  //
  // Questa intestazione compare solo dopo che la pagina, che è client-side, ha finito di
  // caricare i suoi dati. Misurato sul trace della CI del 2026-08-03: la navigazione parte
  // a 21:05:36.5, `/api/diary/students` risponde **200** e si chiude a ~21:05:43.2 — cioè
  // **6,7 s** dopo. Con il timeout di default (5 s) l'asserzione scadeva a ~21:05:42.5,
  // mezzo secondo prima che la pagina avesse i dati per disegnarsi.
  //
  // Che NON fosse un guasto lo dicono tre misure sullo stesso trace: tutte e 11 le chiamate
  // API tornano 200; la snapshot finale contiene «Diario del giorno»; e non contiene più
  // «In caricamento…». La pagina si renderizza: il test la guardava troppo presto.
  //
  // Perché proprio qui: la CI esegue l'E2E su `next dev` (compilazione a richiesta, HMR,
  // service worker che registra e chiede `/offline`), quindi il primo ingresso su una rotta
  // paga la compilazione. La riga qui sotto aveva già 15 s per questo motivo: la prima ne
  // aveva 5 per svista, ed è quella che entra per prima nella pagina.
  await expect(page.getByRole('heading', { name: 'Diario del giorno' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('Cosa vuoi registrare?')).toBeVisible({ timeout: 15_000 });
  await mostraTuttiIBambini(page);

  // Evento Merenda: i pannelli per bambino compaiono dopo la scelta del tipo.
  await page.getByRole('button', { name: 'Registra Merenda' }).click();
  await expect(page.getByText('Aurora').first()).toBeVisible();
  // Le quantità sono simboli: ✗ ¼ ½ ¾ ★ (★ = "Tutto!"), prima riga = Aurora.
  await page.getByRole('button', { name: '★' }).first().click();
  await salvaEAttendi(page, /Salva Merenda per tutti/);

  // Umore (tile attiva via diario_config della scuola E2E): Aurora → Felice.
  await page.getByRole('button', { name: 'Registra Umore' }).click();
  await page.getByRole('button', { name: 'Aurora: Felice' }).click();
  await salvaEAttendi(page, /Salva Umore per tutti/);

  // Persistenza: al reload la selezione umore viene ripristinata da Supabase.
  await page.reload();
  await expect(page.getByText('Cosa vuoi registrare?')).toBeVisible({ timeout: 15_000 });
  await mostraTuttiIBambini(page);
  await page.getByRole('button', { name: 'Registra Umore' }).click();
  await expect(page.getByRole('button', { name: 'Aurora: Felice' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});
