import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';
import itAdminStudents from '../messages/it/adminStudents.json';
import itShared from '../messages/it/shared.json';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  IL CODICE FISCALE NELLE ANAGRAFICHE — dalla tendina, non dalla penna    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ─── PERCHÉ UN FILE NUOVO E NON DENTRO `admin-students.spec.ts` ─────────────
 *
 * `admin-students.spec.ts` ha un test solo e un oggetto dichiarato in testa:
 * «lista, ricerca e tab funzionano» sulla pagina `/admin/students`. Ciò che si
 * collauda qui è un'altra cosa e vive su DUE schermate: la scheda di una nuova
 * anagrafica (`/admin/students/new`, dove il codice fiscale si compone da sé) e
 * la linguetta «Codici fiscali» della lista (dove si legge chi, in archivio, ha
 * un codice che non torna). Metterle là dentro significherebbe che, quando una
 * delle due diventa rossa, il nome del test rosso parla di ricerca e di tab.
 *
 * C'è anche una ragione pratica: quel file porta una storia sui selettori per
 * segnaposto (il commit che ha trasformato `...` in `…` e ha accecato quattro
 * spec in un colpo) e il suo unico test è il presidio di quella storia.
 * Aggiungerci sessanta righe di altro argomento rende ambiguo sia il diff sia
 * il fallimento.
 *
 * ─── I SELETTORI: NIENTE SEGNAPOSTO PER LE TENDINE ─────────────────────────
 *
 * Le due tendine nuove (`LuogoNascitaFields` → `Combobox`) NON sono campi di
 * testo del prodotto: hanno un `role="combobox"` e un'etichetta vera
 * (`<label htmlFor>`), e si cercano per RUOLO e NOME ACCESSIBILE. Non per
 * segnaposto — il lock `__tests__/architecture/e2e-selettori-placeholder.test.ts`
 * pretende che ogni `getByPlaceholder()` degli spec corrisponda a un segnaposto
 * che esiste davvero nei cataloghi, e un selettore per segnaposto su un campo
 * che ha un'etichetta è comunque il selettore sbagliato: cercare per nome
 * accessibile è anche la prova che quel nome ESISTA, che su questa scheda è
 * esattamente la correzione dell'11/08/2026 (nove violazioni axe di tipo
 * `label`/`select-name` misurate e ora rosse per sempre in
 * `__tests__/a11y/schede-alunno-a11y.test.tsx`).
 *
 * Le stringhe d'interfaccia arrivano dai CATALOGHI, non ribattute a mano: sono
 * piene di apostrofi tipografici ed ellissi, e una copia a mano diverge al primo
 * ritocco redazionale — è la stessa lezione del lock qui sopra.
 *
 * ─── QUESTO SPEC NON SALVA NIENTE ──────────────────────────────────────────
 *
 * Si compila la scheda e si legge il campo, poi si esce. «Salva» non si preme:
 * ciò che si collauda è il CALCOLO, che è puro e sincrono e vive nel browser —
 * premere Salva aggiungerebbe una scrittura in anagrafica che non prova niente
 * di più. In CI il database è quello di collaudo, ma `.env.local` in locale
 * punta alla PRODUZIONE: uno spec che non scrive è uno spec che nessuno può
 * eseguire nel posto sbagliato.
 */

test.use({ storageState: STORAGE.admin });

test('il codice fiscale si compone da sé da provincia, comune e data', async ({ page }) => {
  test.slow();

  await page.goto('/admin/students/new');
  await expect(
    page.getByRole('heading', { name: itAdminStudents.sFormCompilazioneAlunno }),
  ).toBeVisible({ timeout: 20_000 });

  // ── I dati che il codice fiscale consuma, tranne il luogo ────────────────
  // `id` unici della scheda alunno (prefisso `alunno-`): `FamilyRegistryManager`
  // ne monta UNA sola, mentre delle schede adulto ne monta N — che restano
  // montate e NASCOSTE nelle altre linguette. Per il ruolo non è un problema
  // (un elemento `display:none` è fuori dall'albero di accessibilità e i
  // selettori per ruolo non lo vedono), ma per gli `id` non c'è nemmeno la
  // domanda.
  await page.locator('#alunno-nome').fill('Iris');
  await page.locator('#alunno-cognome').fill('Collaudo');
  await page.getByRole('combobox', { name: itAdminStudents.campoSesso }).selectOption('F');
  // Campo MASCHERATO in formato italiano (gg/mm/aaaa), non un `input[type=date]`:
  // il valore ISO lo produce lui.
  await page.locator('#alunno-data-nascita').fill('05/05/2021');

  // ── E FINCHÉ MANCA IL COMUNE, NESSUN SUGGERIMENTO ───────────────────────
  // È metà del valore di questo test: senza codice catastale il calcolo NON
  // indovina. «Napoli» scritto a mano non è `F839`, ed è la ragione per cui i
  // tre campi liberi sono diventati una tendina a cascata. Un campo vuoto qui è
  // il comportamento giusto; un codice qui sarebbe un codice costruito su un
  // comune indovinato, e resterebbe scritto per tutta la vita della scheda.
  const codiceFiscale = page.locator('#alunno-codice-fiscale');
  await expect(codiceFiscale).toHaveValue('');
  await expect(page.getByText(itAdminStudents.cfAutocalcolato)).toHaveCount(0);

  // ── La cascata: provincia → comune ──────────────────────────────────────
  const provincia = page.getByRole('combobox', { name: itShared.anagProvinciaEtichetta });
  await provincia.fill('Napoli');
  await page.getByRole('option', { name: 'Napoli (NA)', exact: true }).click();

  const comune = page.getByRole('combobox', { name: itShared.anagComuneEtichetta });
  // L'elenco arriva da `GET /api/anagrafiche/comuni?provincia=NA` (i 13.656
  // comuni stanno SOLO sul server: lock `dataset-comuni-fuori-dal-bundle`),
  // quindi qui si aspetta una risposta di rete, non un render.
  await expect(comune).toBeEnabled({ timeout: 20_000 });
  await comune.fill('Giugliano');
  const voce = page.getByRole('option', { name: 'GIUGLIANO IN CAMPANIA', exact: true });
  await expect(voce).toBeVisible({ timeout: 20_000 });
  await voce.click();

  // ── L'esito: il codice c'è, ed è dichiarato come calcolato ──────────────
  // Il valore atteso NON è scritto qui. Un codice fiscale con checksum valida in
  // un repository PUBBLICO è un dato che non ha ragione di esistere in un file
  // di test: si pretende la FORMA (6 lettere, 2 cifre d'anno, mese, giorno —
  // +40 per le femmine —, 4 del catastale, carattere di controllo), che è ciò
  // che il calcolo promette. Il valore esatto, carattere per carattere, è già
  // misurato dai test unitari di `src/lib/fiscale/calcolo.ts`.
  await expect(codiceFiscale).toHaveValue(/^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/, {
    timeout: 15_000,
  });
  // La nota accanto all'etichetta: dice all'operatore che quel codice è un
  // SUGGERIMENTO, non un dato letto da un tesserino. Senza, un campo che si
  // riempie da solo sembra un dato certo.
  await expect(page.getByText(itAdminStudents.cfAutocalcolato)).toBeVisible();

  // Nessun «Salva»: vedi la testata. La scheda si abbandona così com'è.
});

test('la linguetta «Codici fiscali» risponde e offre i tre stati', async ({ page }) => {
  await page.goto('/admin/students');
  await expect(page.getByText(itAdminStudents.listTitolo)).toBeVisible({ timeout: 20_000 });

  // La linguetta porta anche una pillola col numero azionabile: il nome
  // accessibile del pulsante è «Codici fiscali» seguito da quel numero, quindi
  // il confronto resta per sottostringa (nessun `exact`).
  await page.getByRole('button', { name: itAdminStudents.cfTab }).click();

  // ── «Risponde» vuol dire: la lettura è riuscita ─────────────────────────
  // La linguetta ha una sorgente sua (`GET /api/admin/anagrafiche/codici-fiscali`)
  // e tre fasi. Il pannello d'errore va escluso ESPLICITAMENTE: senza,
  // un'asserzione sul solo titolo lascerebbe passare la schermata di guasto, che
  // il titolo non ce l'ha ma la pagina sì.
  // `getByRole('heading')` e non `getByText`: il titolo del pannello e l'etichetta
  // per lo screen reader del campo di ricerca («Cerca fra i codici fiscali da
  // verificare») contengono **la stessa frase**, e Playwright in modo rigoroso
  // fallisce con «resolved to 2 elements» invece di dire cosa non va — misurato in
  // CI l'11/08/2026, tre tentativi rossi di fila su una schermata che funzionava.
  // Il ruolo distingue le due cose e dice anche ciò che ci interessa davvero: che
  // sia il TITOLO a essere lì, non una qualunque occorrenza di quelle parole.
  await expect(page.getByRole('heading', { name: itAdminStudents.cfTitolo })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(itAdminStudents.cfErroreTitolo)).toHaveCount(0);
  await expect(page.getByText(itAdminStudents.cfCaricamento)).toHaveCount(0);

  // ── I TRE STATI ─────────────────────────────────────────────────────────
  // Sono la distinzione su cui è costruita tutta la linguetta: «incoerente» (il
  // codice c'è e non torna), «non verificabile» (manca il codice catastale, e
  // non si può dire né sì né no), «da compilare» (non c'è nessun codice).
  // Confonderli è precisamente il difetto contro cui il pannello esiste — «manca»
  // non è «sbagliato» — quindi si pretende che il filtro li offra tutti e tre, e
  // li si esercita uno per uno: `selectOption` fallisce se l'opzione non c'è, e
  // in più prova che la scelta non rompa il pannello.
  const filtroStato = page.getByRole('combobox', { name: itAdminStudents.cfFiltroStato });
  await expect(filtroStato.locator('option')).toHaveText([
    itAdminStudents.cfStatoTutti,
    itAdminStudents.cfStatoIncoerente,
    itAdminStudents.cfStatoNonVerificabile,
    itAdminStudents.cfStatoDaCompilare,
  ]);

  for (const stato of ['incoerente', 'non-verificabile', 'da-compilare']) {
    await filtroStato.selectOption(stato);
    await expect(filtroStato).toHaveValue(stato);
    // Con l'archivio di collaudo l'elenco filtrato può essere vuoto: è un esito
    // legittimo, e il pannello lo dice con la propria frase invece di sparire.
    // Ciò che NON deve succedere è che la linguetta si smonti o vada in errore.
    // Per ruolo, e non per testo: vedi la nota qui sopra — la stessa frase compare
    // anche nell'etichetta nascosta del campo di ricerca.
    await expect(page.getByRole('heading', { name: itAdminStudents.cfTitolo })).toBeVisible();
    await expect(page.getByText(itAdminStudents.cfErroreTitolo)).toHaveCount(0);
  }

  await filtroStato.selectOption('tutti');
  await expect(filtroStato).toHaveValue('tutti');
});
