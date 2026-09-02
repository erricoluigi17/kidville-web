import { writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { IDS, STORAGE, attendiNomeFileVisibile } from './fixtures';

// Flusso pubblico /iscrizione (happy path) + import admin con degrado email
// VISIBILE (provider non configurato). CF/email fissi: il seed ripulisce gli
// artefatti (submission, alunno, parents, account) al run successivo.
const CF_CHILD = 'TSTBNE20A01H501X';
const CF_ADULT = 'TSTDLT80A01H501Y';
const EMAIL_ISCRIZIONE = 'iscrizione.e2e@kidville.test';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function caricaDocumento(page: Page, pngPath: string) {
  await page.locator('input[type="file"]').setInputFiles(pngPath);
  /*
   * L'upload sostituisce il testo del campo file con il nome del file, ed è anche
   * il punto di sincronizzazione: finché il nome non c'è, il valore del campo è
   * vuoto e «Avanti» si ferma su un documento che in realtà è arrivato.
   *
   * ⚠️ NON PIÙ `getByText('documento.png').first()`, e la ragione è misurata.
   * Dal 2026-08-25 il riquadro scrive il nome anche in uno `<span class="sr-only">`
   * (serve: senza, il nome accessibile del campo usciva spezzato). Quello `span`
   * è `clip`-ato ma RESO, quindi per Playwright è «visibile» — 1×1 px bastano — e
   * il vecchio `toBeVisible()` restava VERDE anche cancellando dallo schermo tutte
   * le metà visibili del nome. Non era un'asserzione assente: era un'asserzione
   * che mentiva, ed è stata smascherata rompendo apposta la pagina viva.
   * `attendiNomeFileVisibile` guarda le sole metà `aria-hidden`, cioè ciò che una
   * persona legge davvero; la testata di quella funzione porta la misura.
   */
  await attendiNomeFileVisibile(
    page.locator('input[type="file"]').locator('xpath=ancestor::label[1]'),
    'documento.png',
  );
}

test('happy path: la richiesta pubblica viene inviata', async ({ page }, testInfo) => {
  const pngPath = testInfo.outputPath('documento.png');
  writeFileSync(pngPath, PNG_1PX);

  // LINK "TARGATO" PER PLESSO — `?scuola=<id>`, non `/iscrizione` nudo.
  //
  // Sul database della CI l'elenco pubblico delle sedi è VUOTO per costruzione:
  // il seed crea due sedi col prefisso `e2e00000-…` e `isScuolaE2E`
  // (src/lib/scuole/reali.ts) le esclude da ogni elenco pubblico. Senza sede
  // nell'URL il wizard non ha nulla da far scegliere e `POST /api/iscrizione`
  // risponde `400 «Specificare la scuola per l'iscrizione»` — giustamente: dal
  // 2026-07-31 le sedi del seed sono DUE, e indovinarne una archivierebbe la
  // domanda nel plesso sbagliato in silenzio (run 30765844979).
  //
  // Il POST valida l'id contro TUTTE le sedi, E2E incluse, proprio per questo
  // percorso. La scelta della sede dal wizard — il caso con più plessi REALI,
  // che su questo database non è riproducibile — è coperta dai test di
  // `__tests__/components/EnrollmentWizard-sede.test.tsx`.
  await page.goto(`/iscrizione?scuola=${IDS.SCUOLA}`);
  await expect(page.getByText('Iscrizione Nuovo Alunno').first()).toBeVisible();

  // Passo 1 — bambino (soli campi obbligatori).
  await page.getByPlaceholder('Es. Marco').fill('Tino');
  await page.getByPlaceholder('Es. Rossi').fill('Iscrizione-E2E');
  await page.locator('select').selectOption('M');
  await page.locator('input[type="date"]').fill('2021-05-05');
  await page.getByPlaceholder('Es. RSSMRC99A01H501Z').fill(CF_CHILD);
  // Campi resi obbligatori dal batch anagrafiche (nazione/cittadinanza/civico/provincia residenza).
  await page.getByPlaceholder('Es. Italia', { exact: true }).fill('Italia');
  await page.getByPlaceholder('Es. Italiana', { exact: true }).fill('Italiana');
  await page.getByPlaceholder('Es. 123', { exact: true }).fill('10');
  // 'Es. RM' è placeholder sia di Provincia di Nascita sia di Residenza: la residenza è la seconda.
  await page.getByPlaceholder('Es. RM', { exact: true }).nth(1).fill('NA');
  await caricaDocumento(page, pngPath);
  await page.getByRole('button', { name: 'Avanti' }).click();

  // Passo 2 — adulto di riferimento (email inclusa: serve per le credenziali).
  await expect(page.getByText('Adulto 1 (obbligatorio)')).toBeVisible();
  await page.locator('select').first().selectOption('mother');
  await page.getByPlaceholder('Es. Maria', { exact: true }).fill('Ines');
  await page.getByPlaceholder('Es. Rossi').fill('Iscrizione-E2E');
  await page.getByPlaceholder('Es. RSSMRA75B41F205X').fill(CF_ADULT);
  await page.locator('select').nth(1).selectOption('CI');
  await page.getByPlaceholder('Es. AB1234567').fill('AB1234567');
  await page.getByPlaceholder('Es. maria.rossi@email.it').fill(EMAIL_ISCRIZIONE);
  // Stessi campi obbligatori lato adulto (qui la Provincia di Nascita è 'Es. MI' → 'Es. RM' è univoca).
  await page.getByPlaceholder('Es. Italia', { exact: true }).fill('Italia');
  await page.getByPlaceholder('Es. Italiana', { exact: true }).fill('Italiana');
  await page.getByPlaceholder('Es. 123', { exact: true }).fill('10');
  await page.getByPlaceholder('Es. RM', { exact: true }).fill('NA');
  await caricaDocumento(page, pngPath);
  await page.getByRole('button', { name: 'Avanti' }).click();

  // Consensi → informativa al punto di raccolta. La presa visione è
  // OBBLIGATORIA e va spuntata come la spunterebbe un genitore: senza, il
  // wizard non avanza — ed è il comportamento che si vuole, quindi qui si
  // esegue, non si aggira.
  const presaVisione = page.getByRole('checkbox', { name: /informativa sulla privacy/i });
  await expect(presaVisione).toBeVisible();

  // Prova che l'obbligo sia REALE: senza spunta, «Avanti» non deve portare al
  // riepilogo.
  //
  // ⚠️ NON si può cercare il testo «Riepilogo», e il motivo qui scritto era
  // SBAGLIATO fino al 2026-09-01: diceva «compare anche nell'indicatore dei
  // passi». Il sosia vero è un altro, ed è misurato — il sottotitolo di QUESTO
  // passo, `wizardConsensiSottotitolo` in `messages/it/public.json`, che recita
  // «Un passaggio, poi il riepilogo». `getByText(stringa)` senza
  // `{ exact: true }` cerca per sottostringa e senza distinzione di maiuscole:
  // quel sottotitolo lo soddisfa, quindi l'asserzione è verde anche stando
  // fermi qui.
  //
  // Il commento vecchio proteggeva la riga giusta (questa, negativa) e lasciava
  // scoperta quella positiva più in basso, che infatti diceva il falso: per due
  // settimane, dal 24/08, ha lasciato passare un difetto di prodotto su WebKit
  // e ha mandato la diagnosi sulla pista sbagliata (falliva la riga dopo,
  // accusando «Stai iscrivendo 1 bambino»).
  //
  // L'elemento che esiste SOLO nel riepilogo è il pulsante d'invio: lo stesso
  // locatore serve qui per dire «non ci siamo» e sotto per dire «ci siamo».
  await page.getByRole('button', { name: 'Avanti' }).click();
  await expect(page.getByRole('button', { name: 'Invia richiesta' })).toHaveCount(0);
  await expect(presaVisione).toBeVisible();

  await presaVisione.check();
  await page.getByRole('button', { name: 'Avanti' }).click();

  // Riepilogo → invio.
  await expect(page.getByRole('button', { name: 'Invia richiesta' })).toBeVisible();
  await expect(page.getByText(/Stai iscrivendo 1 bambino/)).toBeVisible();
  await page.getByRole('button', { name: 'Invia richiesta' }).click();

  await expect(page.getByRole('heading', { name: 'Richiesta inviata!' })).toBeVisible({
    timeout: 15_000,
  });
});

// `@solo-chromium`: il progetto `webkit` esclude questo blocco (grepInvert in
// playwright.config.ts). Importare due volte lo stesso codice fiscale nello
// stesso run darebbe un errore di duplicato — un rosso causato dal test
// precedente, non dal prodotto. Il percorso PUBBLICO, invece, su WebKit si
// ripete: è quello che i genitori compilano da Safari.
test.describe('import in segreteria @solo-chromium', () => {
  test.use({ storageState: STORAGE.admin });

  test('l’import mostra il degrado email visibile', async ({ page }) => {
    test.slow();
    await page.goto('/admin/iscrizioni');

    // /admin/iscrizioni ora reindirizza a Modulistica > tab "Moduli ricevuti":
    // il redirect + render può essere lento sotto carico CI → timeout generoso.
    await expect(page.getByText('Modulistica & Onboarding')).toBeVisible({ timeout: 30_000 });
    const richiesta = page.getByText('Tino Iscrizione-E2E').first();
    await expect(richiesta).toBeVisible({ timeout: 20_000 });
    await richiesta.click();

    // L'import esige una classe per bambino: sezione DEDICATA agli iscritti,
    // così non inquina il conteggio di Girasoli (appello docente) né di Tulipani.
    // (l'alunno importato viene ripulito dal seed al run successivo.)
    await page.locator('select').first().selectOption({ label: 'Nuovi Iscritti' });
    await page.getByRole('button', { name: 'Importa nelle anagrafiche' }).click();

    // Esito: import ok + credenziali + degrado email (RESEND non configurato).
    await expect(page.getByText('Iscrizione importata')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Credenziali:/)).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText('Email non inviata: comunicare le credenziali manualmente.')
    ).toBeVisible({ timeout: 15_000 });
  });
});
