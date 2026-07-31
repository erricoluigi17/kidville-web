import { test, expect, type Page } from '@playwright/test';
import { EMAILS, IDS, login } from './fixtures';

// ─────────────────────────────────────────────────────────────────────────────
// ISOLAMENTO FRA SEDI — la prova che la suite E2E non poteva fare
//
// Fino al 2026-07-31 il seed creava UNA sola scuola. Nessuno spec poteva
// accorgersi di una perdita di dati fra plessi: non perché l'isolamento fosse
// dimostrato, ma perché non esisteva una seconda sede da cui far entrare
// qualcosa. Il gate era verde per costruzione — ed è precisamente il modo in cui
// il 2026-07-29, aperte Kidville Aversa e Kidville Cesa, si sono attivate falle
// che dormivano da mesi con 3424 test verdi.
//
// Il seed (`scripts/seed-e2e.mjs`) semina ora due sedi, e la sezione della sede 2
// si chiama «Girasoli» come quella della sede 1: il nome-classe è la chiave con
// cui mezzo prodotto risolve una sezione, e con più plessi non identifica più
// niente. Tre percorsi REALI, dal browser, sui tre modi in cui un dato può
// attraversare il confine:
//
//   1. LETTURA MIRATA   — la segreteria della sede 1 cerca (e poi chiama per
//      uuid) l'alunna della sede 2: né in elenco né per URL diretto.
//   2. LETTURA PER NOME — le due maestre chiedono al server la stessa identica
//      stringa («Girasoli») e devono ricevere due elenchi DISGIUNTI.
//   3. SCRITTURA        — un avviso pubblicato nella sede 1, con la classe
//      «Girasoli» come destinataria, non deve comparire nella sede 2 (né alla
//      maestra né alla famiglia, che ha un figlio in una classe omonima).
//
// REGOLE DI SCRITTURA DI QUESTO FILE (audit 2026-07-31, §3 del piano):
//  · niente asserzioni-fantoccio: si asserisce lo stato ESATTO e l'insieme
//    ESATTO degli id, mai «non è 403»;
//  · ogni asserzione NEGATIVA è preceduta da una POSITIVA sulla stessa vista.
//    `toHaveCount(0)` su una pagina che non ha caricato è verde per il motivo
//    sbagliato, ed è così che nascono i falsi verdi.
//
// Nessuno `storageState`: ogni test fa il login del proprio utente dalla UI
// reale, perché il progetto `setup` conserva solo le tre sessioni storiche.
// ─────────────────────────────────────────────────────────────────────────────

// La CI E2E gira su `next dev`: queste pagine compilano a freddo e sotto carico
// runner superano i 30s. Timeout generosi, semantica invariata.
const RENDER = 60_000;
const AZIONE = 20_000;

/** Login dalla UI + attesa dell'area di atterraggio del ruolo. */
async function entra(page: Page, email: string, area: 'admin' | 'teacher' | 'parent') {
  await login(page, email);
  await page.waitForURL(`**/${area}`, { timeout: RENDER });
}

// ── 1. La segreteria della sede 1 non trova l'alunna della sede 2 ────────────
test('la segreteria della sede 1 non trova l’alunna della sede 2 (elenco e URL diretto)', async ({ page }) => {
  test.setTimeout(180_000);
  await entra(page, EMAILS.segreteria, 'admin');

  await page.goto('/admin/students');
  await expect(page.getByText('Totale (tutti gli stati)').first()).toBeVisible({ timeout: RENDER });

  const ricerca = page.getByPlaceholder('Cerca per nome, cognome o codice fiscale...');

  // POSITIVO: l'anagrafica della PROPRIA sede si vede. Senza questo, il
  // controllo negativo qui sotto passerebbe anche con la lista vuota per un
  // errore di caricamento.
  await ricerca.fill('Arcobaleno');
  await expect(page.getByText('Arcobaleno-E2E').first()).toBeVisible({ timeout: AZIONE });

  // NEGATIVO: la bambina dell'altro plesso non è in elenco. La ricerca è
  // client-side sulla lista già ricevuta: se il server l'avesse mandata, qui si
  // vedrebbe.
  await ricerca.fill('Eclissi');
  await expect(page.getByText('Nessun alunno trovato').first()).toBeVisible({ timeout: AZIONE });
  await expect(page.getByText('Eclissi-E2E')).toHaveCount(0);

  // URL DIRETTO: conoscere l'uuid non basta. La scheda è il fascicolo completo
  // (codice fiscale, note mediche, genitori con documento e recapiti): è
  // l'insieme di dati personali più ampio che una sola rotta espone.
  await page.goto(`/admin/students/${IDS.B1}`);
  await expect(page.getByText('Anagrafica non disponibile').first()).toBeVisible({ timeout: RENDER });
  await expect(page.getByText("L'alunno non esiste o non appartiene ai tuoi plessi.").first()).toBeVisible();
  await expect(page.getByText('Eclissi-E2E')).toHaveCount(0);

  // E la rotta che alimenta quella scheda, chiamata con la STESSA sessione:
  // stato esatto e nessun dato della minore nel corpo. 403 (non 404) è ciò che
  // risponde `assertAlunnoInScope` oggi: qui si fotografa il comportamento
  // reale, non quello desiderato — se un domani diventerà un 404 per non fare
  // da oracolo d'esistenza, questa riga va cambiata di proposito.
  const risposta = await page.request.get(`/api/admin/students/${IDS.B1}`);
  expect(risposta.status()).toBe(403);
  expect(await risposta.text()).not.toContain('Eclissi');
});

// ── 2. Il nome-classe non porta oltre il confine ─────────────────────────────
test('la maestra della sede 1 sulla classe «Girasoli» vede SOLO i suoi alunni', async ({ page }) => {
  test.setTimeout(180_000);
  await entra(page, EMAILS.docente, 'teacher');

  await page.goto('/teacher/attendance');
  await expect(page.getByRole('heading', { name: 'Appello' })).toBeVisible({ timeout: RENDER });
  await expect(page.getByText('Aurora Arcobaleno-E2E').first()).toBeVisible({ timeout: RENDER });
  await expect(page.getByText('Bruno Baleno-E2E').first()).toBeVisible({ timeout: AZIONE });
  // La bambina della classe OMONIMA dell'altra sede non è nel suo appello.
  await expect(page.getByText('Eclissi-E2E')).toHaveCount(0);

  // La stessa domanda al server, con l'insieme ESATTO degli id. «Ci sono i miei»
  // sarebbe verde anche con dentro i bambini dell'altra sede: è la forma di
  // asserzione che il 2026-07-30 ha prodotto due falsi verdi.
  const risposta = await page.request.get('/api/diary/students?sezione=Girasoli');
  expect(risposta.status()).toBe(200);
  const ids = ((await risposta.json()) as { id: string }[]).map((a) => a.id).sort();
  expect(ids).toEqual([IDS.A1, IDS.A2].sort());
});

test('la maestra della sede 2 sulla classe omonima vede SOLO la sua alunna', async ({ page }) => {
  test.setTimeout(180_000);
  await entra(page, EMAILS.docente2, 'teacher');

  // Specularità: senza questo verso, un server che rispondesse sempre «gli
  // alunni della sede 1» passerebbe il test precedente.
  const risposta = await page.request.get('/api/diary/students?sezione=Girasoli');
  expect(risposta.status()).toBe(200);
  const ids = ((await risposta.json()) as { id: string }[]).map((a) => a.id);
  expect(ids).toEqual([IDS.B1]);

  await page.goto('/teacher/attendance');
  await expect(page.getByRole('heading', { name: 'Appello' })).toBeVisible({ timeout: RENDER });
  await expect(page.getByText('Emma Eclissi-E2E').first()).toBeVisible({ timeout: RENDER });
  await expect(page.getByText('Arcobaleno-E2E')).toHaveCount(0);
  await expect(page.getByText('Baleno-E2E')).toHaveCount(0);
});

// ── 3. Una scrittura della sede 1 non arriva nella sede 2 ────────────────────
test('un avviso pubblicato nella sede 1 non compare nella sede 2', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const TITOLO_SEDE_1 = 'Isolamento E2E: avviso della sede 1';
  const ANCORA_SEDE_2 = 'Avviso E2E sede 2: assemblea';

  // (a) La sede 1 pubblica DAVVERO, dalla bacheca docente. Come educator il
  //     modulo è in modalità ristretta e la propria classe («Girasoli», da
  //     utenti_sezioni) è già selezionata: l'avviso nasce con la stessa classe
  //     destinataria che esiste anche nell'altra sede.
  await entra(page, EMAILS.docente, 'teacher');
  await page.goto('/teacher/avvisi');
  await expect(page.getByRole('heading', { name: 'Bacheca' })).toBeVisible({ timeout: RENDER });

  await page.getByRole('button', { name: 'Nuovo' }).click();
  await expect(page.getByText('📢 Nuovo Avviso').first()).toBeVisible({ timeout: AZIONE });
  await page.getByPlaceholder('Es. Gita al parco').fill(TITOLO_SEDE_1);
  await page
    .getByPlaceholder("Scrivi il testo dell'avviso...")
    .fill('Contenuto della sede 1: non deve uscire dal plesso.');
  await page.getByRole('button', { name: 'Pubblica Avviso' }).click();

  // POSITIVO: la pubblicazione è riuscita. Se il POST fosse stato respinto (per
  // esempio con «Specificare la sede»), tutto il resto del test sarebbe verde
  // per il motivo sbagliato — non c'è niente da non vedere.
  await expect(page.getByText(TITOLO_SEDE_1).first()).toBeVisible({ timeout: RENDER });

  // (b) La bacheca della sede 2, con la sua sessione.
  const contestoDocente2 = await browser.newContext();
  const paginaDocente2 = await contestoDocente2.newPage();
  try {
    await entra(paginaDocente2, EMAILS.docente2, 'teacher');
    await paginaDocente2.goto('/teacher/avvisi');
    await expect(paginaDocente2.getByRole('heading', { name: 'Bacheca' })).toBeVisible({ timeout: RENDER });
    // POSITIVO: la bacheca ha caricato e mostra l'avviso della PROPRIA sede.
    await expect(paginaDocente2.getByText(ANCORA_SEDE_2).first()).toBeVisible({ timeout: RENDER });
    // NEGATIVO: quello della sede 1 no.
    await expect(paginaDocente2.getByText(TITOLO_SEDE_1)).toHaveCount(0);

    // Anche sui dati grezzi della rotta, non solo su ciò che la pagina disegna.
    const risposta = await paginaDocente2.request.get('/api/avvisi');
    expect(risposta.status()).toBe(200);
    const titoli = ((await risposta.json()) as { titolo: string }[]).map((a) => a.titolo);
    expect(titoli).toContain(ANCORA_SEDE_2);
    expect(titoli).not.toContain(TITOLO_SEDE_1);
  } finally {
    await contestoDocente2.close();
  }

  // (c) La famiglia della sede 2. È il verso più insidioso: il feed del genitore
  //     seleziona gli avvisi per NOME della classe dei figli, ed Emma sta in una
  //     «Girasoli» — la stessa stringa a cui è indirizzato l'avviso della sede 1.
  const contestoGenitore2 = await browser.newContext();
  const paginaGenitore2 = await contestoGenitore2.newPage();
  try {
    await entra(paginaGenitore2, EMAILS.genitore2, 'parent');
    await paginaGenitore2.goto('/parent/avvisi');
    await expect(paginaGenitore2.getByText(ANCORA_SEDE_2).first()).toBeVisible({ timeout: RENDER });
    await expect(paginaGenitore2.getByText(TITOLO_SEDE_1)).toHaveCount(0);
  } finally {
    await contestoGenitore2.close();
  }
});
