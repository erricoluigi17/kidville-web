import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Diario docente (/teacher/diary, sezione Girasoli): evento merenda + umore.
test.use({ storageState: STORAGE.docente });

/**
 * IL TETTO DI TEMPO DI QUESTO SPEC, e perché non è «allargare finché passa».
 *
 * Il difetto vero — la pagina che chiedeva `/api/diary/config` quattro volte e
 * `/api/educator-sections` due — È STATO CORRETTO (T11-F3): erano due punti di codice
 * moltiplicati per StrictMode, ora c'è una promise-cache di modulo. Quella era la causa
 * per cui il test cadeva su `main`, e non si tocca più.
 *
 * Quello che resta è il costo dell'AMBIENTE, misurato sul trace della run 30854274465:
 * i due POST di salvataggio impiegano **5,0 s e 3,2 s** — non per lentezza del codice,
 * ma perché la CI esegue l'E2E su `next dev`, dove il primo ingresso su ogni rotta paga
 * la compilazione. Questo spec ne percorre parecchie: carica il diario, apre due tipi di
 * evento, salva due volte attendendo la RISPOSTA di ciascuna, ricarica e riverifica.
 * Il tetto di 30 s scadeva mentre la seconda risposta era ancora in volo.
 *
 * 90 s non nasconde niente: le asserzioni non sono cambiate e nessuna di esse è stata
 * allentata. Se la persistenza si rompe, `aria-pressed` resta `false` DOPO che la
 * risposta è arrivata, e il test cade con il suo messaggio — non per scadenza.
 */
test.setTimeout(90_000);

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

/**
 * Apre un tipo evento e ASPETTA il ripristino da Supabase.
 *
 * Scegliere il tipo evento fa partire una GET a `/api/diary/entries`: è quella
 * che ripopola le selezioni già salvate oggi (ed è quella che, il 2026-08-03,
 * era ancora in volo quando il test è scaduto a 30 s — non perché fosse rotta,
 * ma perché la pagina aveva speso ~14 s in chiamate duplicate prima di
 * arrivarci). Aspettare la RISPOSTA invece di una soglia toglie di mezzo la
 * gara **senza** rendere il test cieco: se la persistenza smette di funzionare,
 * la risposta arriva lo stesso e `aria-pressed` resta `false`. Un timeout più
 * largo avrebbe nascosto il difetto; questo lo lascia visibile.
 */
async function apriEventoEAttendiRipristino(
  page: import('@playwright/test').Page,
  evento: string,
) {
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/diary/entries') && r.request().method() === 'GET',
      { timeout: 30_000 },
    ),
    page.getByRole('button', { name: evento }).click(),
  ]);
  expect(res.status(), `GET /api/diary/entries ha risposto ${res.status()}`).toBeLessThan(300);
}

async function mostraTuttiIBambini(page: import('@playwright/test').Page) {
  // Il filtro parte su "Solo presenti": passo a "Tutti" per non dipendere
  // dall'appello, attendendo il refetch degli alunni (il ripristino dello
  // stato salvato usa la lista corrente: senza attesa correrebbe in gara).
  const toggle = page.getByRole('button', { name: 'Solo presenti' });
  if (await toggle.isVisible().catch(() => false)) {
    const [res] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/diary/students') && r.status() === 200
      ),
      toggle.click(),
    ]);
    // Il CORPO, non solo le intestazioni: il passo dopo sceglie un tipo evento e
    // il ripristino da Supabase parte solo se l'elenco alunni è già nello stato
    // della pagina. Aspettare l'header lascerebbe aperta una gara di millisecondi
    // con l'elenco ancora vuoto — e in quel caso non partirebbe nessuna GET.
    await res.json().catch(() => null);
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
  await apriEventoEAttendiRipristino(page, 'Registra Merenda');
  await expect(page.getByText('Aurora').first()).toBeVisible();
  // Le quantità sono simboli: ✗ ¼ ½ ¾ ★ (★ = "Tutto!"), prima riga = Aurora.
  await page.getByRole('button', { name: '★' }).first().click();
  await salvaEAttendi(page, /Salva Merenda per tutti/);

  // Umore (tile attiva via diario_config della scuola E2E): Aurora → Felice.
  await apriEventoEAttendiRipristino(page, 'Registra Umore');
  await page.getByRole('button', { name: 'Aurora: Felice' }).click();
  await salvaEAttendi(page, /Salva Umore per tutti/);

  // Persistenza: al reload la selezione umore viene ripristinata da Supabase.
  await page.reload();
  await expect(page.getByText('Cosa vuoi registrare?')).toBeVisible({ timeout: 15_000 });
  await mostraTuttiIBambini(page);
  // L'ATTESA È ESPLICITA, non un timeout più largo: si aspetta la risposta che
  // porta i dati salvati, poi si guarda lo stato del pulsante. Se il diario non
  // avesse salvato davvero, la risposta arriverebbe comunque (200, ma vuota) e
  // `aria-pressed` resterebbe `false`: il test continua a misurare la
  // persistenza, non la pazienza.
  await apriEventoEAttendiRipristino(page, 'Registra Umore');
  await expect(page.getByRole('button', { name: 'Aurora: Felice' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});
