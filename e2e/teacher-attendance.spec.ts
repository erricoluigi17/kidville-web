import { test, expect } from '@playwright/test';
import { IDS, STORAGE } from './fixtures';

// Appello docente (/teacher/attendance, sezione Girasoli): registrazione + rettifica + persistenza.
test.use({ storageState: STORAGE.docente });

// La CI E2E gira su `next dev` (playwright.config webServer): la pagina appello è il
// PRIMO test a colpire /teacher/attendance + /api/diary/students + /api/attendance/*,
// che compilano a FREDDO. Sotto carico runner questo cold-compile può superare i 30s
// (la pagina resta su "Caricamento alunni da anagrafica…"; i fetch hanno .catch, non
// si impiantano → è solo lentezza di compile). Timeout molto generosi + test-timeout
// esplicito accomodano il cold-compile senza cambiare cosa si asserisce.
const RENDER = 60_000;
const AZIONE = 20_000;

test('appello: registra, rettifica assente→presente e persiste al reload', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/teacher/attendance');

  await expect(page.getByRole('heading', { name: 'Appello' })).toBeVisible({ timeout: RENDER });
  await expect(page.getByText('Aurora')).toBeVisible({ timeout: RENDER });
  await expect(page.getByText('Bruno')).toBeVisible({ timeout: RENDER });

  // Aurora presente: i 3 bottoni NON spariscono. Il bottone selezionato passa ad
  // aria-pressed="true" e compaiono le azioni di uscita.
  await page.locator(`#btn-presente-${IDS.A1}`).click();
  await expect(page.locator(`#btn-presente-${IDS.A1}`)).toHaveAttribute('aria-pressed', 'true', { timeout: AZIONE });
  await expect(page.locator(`#btn-checkout-${IDS.A1}`)).toBeVisible({ timeout: AZIONE });

  // Bruno assente: i bottoni restano tutti visibili; assente è attivo, presente non lo è.
  await page.locator(`#btn-assente-${IDS.A2}`).click();
  await expect(page.locator(`#btn-assente-${IDS.A2}`)).toHaveAttribute('aria-pressed', 'true', { timeout: AZIONE });
  await expect(page.locator(`#btn-presente-${IDS.A2}`)).toHaveAttribute('aria-pressed', 'false', { timeout: AZIONE });

  // Sezione completa: 2/2 registrati.
  await expect(page.getByText('Completo')).toBeVisible({ timeout: AZIONE });

  // Rettifica: Bruno da assente a presente, direttamente sul bottone (nessun reset intermedio).
  await page.locator(`#btn-presente-${IDS.A2}`).click();
  await expect(page.locator(`#btn-presente-${IDS.A2}`)).toHaveAttribute('aria-pressed', 'true', { timeout: AZIONE });
  await expect(page.locator(`#btn-assente-${IDS.A2}`)).toHaveAttribute('aria-pressed', 'false', { timeout: AZIONE });
  await expect(page.locator(`#btn-checkout-${IDS.A2}`)).toBeVisible({ timeout: AZIONE });

  // Persistenza reale (upsert su presenze): al reload gli stati, rettifica inclusa, restano.
  await page.reload();
  await expect(page.locator(`#btn-presente-${IDS.A1}`)).toHaveAttribute('aria-pressed', 'true', { timeout: RENDER });
  await expect(page.locator(`#btn-checkout-${IDS.A1}`)).toBeVisible({ timeout: AZIONE });
  await expect(page.locator(`#btn-presente-${IDS.A2}`)).toHaveAttribute('aria-pressed', 'true', { timeout: AZIONE });
  await expect(page.getByText('Completo')).toBeVisible({ timeout: AZIONE });
});

/**
 * La RETTIFICA DELL'ORARIO — l'ora d'ingresso si corregge, e persiste.
 *
 * Fino al 2026-09-07 nel nido e nell'infanzia l'orario era testo in sola lettura: il
 * registro scriveva l'ora del TOCCO e non c'era modo di dire che il bambino era
 * arrivato alle 09:40 e non alle 10:15.
 *
 * ⚠️ Il caso che conta davvero è l'ULTIMO: si corregge l'ingresso di un bambino che ha
 * ANCHE l'orario d'uscita, e si verifica che l'uscita non sia sparita. La strada corta
 * (riusare `handleSetStato`, cioè la POST) l'avrebbe azzerata — la POST è un upsert
 * della riga intera. È il difetto che questo test esiste per impedire.
 */
test('appello: l\'ora d\'ingresso si corregge, e non cancella quella d\'uscita', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/teacher/attendance');

  await expect(page.getByRole('heading', { name: 'Appello' })).toBeVisible({ timeout: RENDER });
  await expect(page.getByText('Aurora')).toBeVisible({ timeout: RENDER });

  // Presente → l'orario d'ingresso nasce (l'ora del tocco) e diventa un comando.
  await page.locator(`#btn-presente-${IDS.A1}`).click();
  const chipEntrata = page.locator(`#btn-orario-entrata-${IDS.A1}`);
  await expect(chipEntrata).toBeVisible({ timeout: AZIONE });

  // Si tocca: al suo posto compare il campo ora, pre-riempito con l'ora ITALIANA.
  await chipEntrata.click();
  const campo = page.locator(`#input-orario-entrata-${IDS.A1}`);
  await expect(campo).toBeVisible({ timeout: AZIONE });
  await campo.fill('09:10');
  await page.locator(`#btn-salva-orario-entrata-${IDS.A1}`).click();
  await expect(chipEntrata).toContainText('09:10', { timeout: AZIONE });

  // Persistenza vera (PATCH su presenze): al reload l'ora corretta è ancora lì.
  await page.reload();
  await expect(page.locator(`#btn-orario-entrata-${IDS.A1}`)).toContainText('09:10', { timeout: RENDER });

  // ── E ORA IL CASO CHE VALE IL TEST ──────────────────────────────────────────
  // Uscita anticipata: il bambino ha ENTRAMBI gli orari.
  // Si aspetta la scrittura dell'uscita PRIMA di ricaricare, o il reload la perderebbe in volo.
  const uscitaSalvata = page.waitForResponse(
    (r) => r.url().includes('/api/attendance/daily') && r.request().method() !== 'GET' && r.ok(),
    { timeout: AZIONE },
  );
  await page.locator(`#btn-uscita-${IDS.A1}`).click();
  await uscitaSalvata;
  const chipUscita = page.locator(`#btn-orario-uscita-${IDS.A1}`);
  await expect(chipUscita).toBeVisible({ timeout: AZIONE });
  // ⚠️ Il chip compare PRIMA che l'ora d'uscita arrivi: per un attimo dice «Uscita: non registrato»,
  // e poi può mostrare un'ora OTTIMISTICA (quella locale) che il server sostituisce con la sua.
  // Fotografare il testo appena il chip è visibile, o appena ha un'ora, memorizzava un valore
  // provvisorio e il confronto finale cadeva (2 rossi su 3 sulla CI di `main` del 2026-11-13).
  // Si ricarica la pagina: dopo il reload l'ora è QUELLA DEL DATABASE, non può più cambiare, ed è
  // il valore che il resto del test deve ritrovare identico.
  await page.reload();
  const chipUscitaDb = page.locator(`#btn-orario-uscita-${IDS.A1}`);
  await expect(chipUscitaDb).toHaveText(/Uscita:\s*\d{2}:\d{2}/, { timeout: RENDER });
  const uscitaPrima = (await chipUscitaDb.textContent()) ?? '';

  // Si corregge l'INGRESSO. L'uscita non deve muoversi di un minuto.
  await page.locator(`#btn-orario-entrata-${IDS.A1}`).click();
  await page.locator(`#input-orario-entrata-${IDS.A1}`).fill('08:35');
  await page.locator(`#btn-salva-orario-entrata-${IDS.A1}`).click();
  await expect(page.locator(`#btn-orario-entrata-${IDS.A1}`)).toContainText('08:35', { timeout: AZIONE });
  await expect(chipUscitaDb).toHaveText(uscitaPrima, { timeout: AZIONE });

  // E resta vero dopo un giro dal database.
  await page.reload();
  await expect(page.locator(`#btn-orario-entrata-${IDS.A1}`)).toContainText('08:35', { timeout: RENDER });
  await expect(page.locator(`#btn-orario-uscita-${IDS.A1}`)).toHaveText(uscitaPrima, { timeout: AZIONE });
});

/**
 * SUL TELEFONO UN TESTO LUNGO NON SPINGE I BOTTONI FUORI DALLO SCHERMO.
 *
 * Il 2026-11-05 una maestra di Giugliano ha aperto l'appello dall'iPhone e ha trovato soltanto i
 * nomi: Presente / Ritardo / Assente non c'erano più. Un genitore aveva scritto un motivo d'assenza
 * di 194 caratteri, e la riga del motivo è un `truncate` (`white-space: nowrap`). L'elenco era una
 * griglia senza colonne dichiarate sotto `lg:`: la sua colonna `auto` si è allargata quanto il
 * motivo su una riga sola (~1.200 px), e con lei tutte le 26 righe. I bottoni sono finiti oltre il
 * bordo, tagliati dall'`overflow-hidden` della pagina. Ora la colonna è `grid-cols-1`
 * (`minmax(0, 1fr)`, vedi `GRIGLIA_BAMBINI` in `src/lib/ui/larghezza-pagina.ts`).
 *
 * Nel DB della CI nessun genitore ha scritto un motivo così lungo: la riga si aggiunge dal browser,
 * con le stesse classi della riga del motivo (`StudentAttendanceRow`). Inserimento e misura stanno
 * nello STESSO `evaluate`, così React non può togliere la riga fra i due e far passare il test
 * senza testo lungo. E si verifica che la riga sia davvero troncata (`scrollWidth > clientWidth`):
 * se il testo non c'è, o non è lungo, il test è rosso. Non scrive niente sul database.
 */
test('appello: sul telefono un motivo lungo non spinge i bottoni fuori dallo schermo', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/teacher/attendance');

  await expect(page.getByRole('heading', { name: 'Appello' })).toBeVisible({ timeout: RENDER });
  await expect(page.locator(`#btn-presente-${IDS.A1}`)).toBeVisible({ timeout: RENDER });

  const misura = await page.evaluate((idBottone) => {
    const riga = document.getElementById(idBottone)?.closest('.kv-appello-row');
    const nome = riga?.querySelector('h3');
    if (!riga || !nome?.parentElement) return null;
    const motivo = document.createElement('p');
    motivo.className = 'mt-1 font-maven text-xs text-kidville-warn-strong bg-kidville-warn-soft rounded-xl px-2 py-1 truncate';
    motivo.textContent = 'Giustificata dal genitore: ' + 'parola '.repeat(30);
    nome.parentElement.appendChild(motivo);
    const larghezzaSchermo = document.documentElement.clientWidth;
    const bottoni = Array.from(document.querySelectorAll<HTMLElement>('[id^="btn-presente-"]')).map((b) => {
      const r = b.getBoundingClientRect();
      return { id: b.id, destra: Math.round(r.right) };
    });
    const esito = {
      larghezzaSchermo,
      larghezzaRiga: Math.round(riga.getBoundingClientRect().width),
      motivoTroncato: motivo.scrollWidth > motivo.clientWidth,
      bottoni,
    };
    motivo.remove();
    return esito;
  }, `btn-presente-${IDS.A1}`);

  expect(misura, 'la riga di Aurora con il suo bottone Presente').not.toBeNull();
  expect(misura!.bottoni.length).toBeGreaterThan(0);
  for (const b of misura!.bottoni) {
    expect(b.destra, `${b.id} dentro lo schermo`).toBeLessThanOrEqual(misura!.larghezzaSchermo);
  }
  expect(misura!.larghezzaRiga, 'la riga non è più larga dello schermo').toBeLessThanOrEqual(misura!.larghezzaSchermo);
  // Ultimo di proposito: senza la correzione il motivo ci sta intero su una riga larga 1.200 px,
  // e il messaggio giusto è quello sui bottoni qui sopra.
  expect(misura!.motivoTroncato, 'il motivo lungo è nella riga e ci sta troncato').toBe(true);
});
