import { test, expect } from '@playwright/test';
import { IDS, PERSONALE_E2E, STORAGE, attendiFineCaricamento } from './fixtures';
import itPublic from '../messages/it/public.json';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  `/anagrafica-personale` — il modulo PUBBLICO di chi già lavora qui      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Sei passi (sede · dati · residenza · documento · consensi · riepilogo), nessun
 * account, e in fondo una riga in `pratiche_personale` che la Segreteria dovrà
 * approvare. Fino al 12/08/2026 non lo copriva NESSUN test E2E: il modulo è stato
 * rilasciato con la sola prova dei test unitari, cioè con la garanzia che i pezzi
 * funzionino e nessuna che il percorso si possa fare.
 *
 * ─── PERCHÉ ADESSO SI PUÒ COLLAUDARE (12/08/2026) ──────────────────────────
 * Servivano due cose, e mancavano entrambe:
 *  a. le tabelle (`pratiche_personale`, `caricamenti_personale`, …) sul database
 *     della CI, che è un progetto separato dalla produzione e non è migrato —
 *     senza, la rotta risponde un **503 dichiarato** (`PRATICHE_NON_DISPONIBILI`);
 *  b. una sede che `sediReali` ACCETTI. Le due sedi del seed cominciano per
 *     `e2e00000-` e `isScuolaE2E` le toglie da ogni elenco pubblico: l'elenco
 *     restava vuoto e il wizard non dipingeva nemmeno il primo passo.
 * Il seed adesso semina il **«Plesso di Collaudo»** (`IDS.SCUOLA_COLLAUDO`), che
 * il predicato non riconosce: è l'unica sede che questi moduli mostrano in CI.
 *
 * ─── I DUE TETTI, per chi tocca questo file ────────────────────────────────
 * `POST /api/iscrizione/personale` ammette **20 invii l'ora per IP** e in CI tutti
 * i browser escono da un IP solo; `POST …/upload` sta a 20 ogni 10 minuti. Con
 * `retries: 2` il percorso qui sotto ne consuma fino a 3 per gettone. Ogni blocco
 * che SCRIVE porta `@solo-chromium`, così il progetto `webkit` non lo ripete
 * (`grepInvert` in `playwright.config.ts`) — e questo file non rientra comunque in
 * `SPEC_CRITICI_WEBKIT`, che nomina quattro percorsi e non questo.
 */

/**
 * L'identità della maestra che compila. FISSA e non generata: l'indice unico
 * `pratiche_personale_email_viva` è globale sugli stati vivi e la rotta traduce il
 * doppione in **201, come al primo invio** — con un'email a caso quel ramo non si
 * verificherebbe mai. Il seed ripulisce ESATTAMENTE questi indirizzi
 * (`PERSONALE_E2E`), quindi ogni run parte pulito.
 */
const NOME = 'Ines';
const COGNOME = 'Anagrafica-E2E';

/**
 * ⚠️ IL CARATTERE DI CONTROLLO DEVE TORNARE: la rotta passa il codice a
 * `validaCodiceFiscale` e un checksum sbagliato è un **400 che blocca l'invio**
 * (`fiscal_code: «L'ultima lettera del codice fiscale non torna»`).
 *
 * Questo non è inventato: è il valore che `calcolaCodiceFiscale`
 * (`@/lib/fiscale/calcolo`) restituisce per l'anagrafica compilata qui sotto —
 * Ines · Anagrafica-E2E · F · 1985-06-12 · F839 (NAPOLI). Verificato il 12/08/2026
 * anche con `verificaCoerenza`, che non ha nulla da eccepire: così il badge del
 * modulo tace, e un badge giallo di lato non può essere scambiato per la causa di
 * un eventuale rosso. Chi cambia uno di quei cinque dati RICALCOLI il codice — il
 * modo è scritto nel commento gemello di `admin-pratiche-personale.spec.ts`.
 */
const CODICE_FISCALE = 'NGRNSI85H52F839K';

/** La provincia e il comune di nascita, come si leggono NELLE DUE TENDINE. */
const PROVINCIA_NASCITA = 'Napoli (NA)';
const COMUNE_NASCITA = 'NAPOLI';

/** Il nome del plesso che il seed rende visibile ai moduli pubblici. */
const SEDE_COLLAUDO = 'Plesso di Collaudo';

/**
 * La scansione del documento: un PDF minimo costruito QUI, non un file su disco.
 *
 * Un file nel repo sarebbe un allegato in più da mantenere e da spiegare; e il
 * contenuto non conta, perché `verificaAllegatoPubblico` guarda il tipo DICHIARATO
 * e l'estensione — non ispeziona i byte. Resta un PDF vero e proprio per non
 * dipendere da quel dettaglio il giorno in cui qualcuno aggiungesse lo sniffing.
 */
const PDF_MINIMO = Buffer.from(
  '%PDF-1.4\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/MediaBox[0 0 99 99]/Parent 2 0 R>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8',
);
const NOME_FILE = 'documento.pdf';

/**
 * La scadenza del documento, CALCOLATA e non cablata.
 *
 * Una data fissa nel futuro invecchia: sotto i 90 giorni il modulo accende
 * l'avviso di scadenza, e sotto lo zero cambia colore e testo — cioè il test
 * diventerebbe rosso da solo, un giorno, senza che nessuno abbia toccato il
 * prodotto. È la trappola già pagata il 12/08/2026 su un banco di prova con le
 * date scritte a mano. Cinque anni sono ben oltre la soglia più larga (90 giorni)
 * e ben oltre il minimo che la tabella pretende (`> 1990-01-01`).
 */
const SCADENZA_DOCUMENTO = `31/12/${new Date().getFullYear() + 5}`;

/**
 * L'id della pratica appena inviata, letto dal corpo del 201.
 *
 * Serve al secondo blocco per PROVARE L'EFFETTO: la rotta risponde 201 anche a un
 * doppione (di proposito: un 409 direbbe a chiunque digiti l'email di una maestra
 * che quella persona ha già consegnato l'anagrafica), quindi la sola conferma a
 * schermo non distingue «è nata una riga» da «ne esisteva già una». L'unico modo
 * onesto è andare a guardare la riga.
 */
let idPratica: string | null = null;

test.describe('modulo pubblico dell’anagrafica del personale @solo-chromium', () => {
  test('percorso felice: sei passi, invio e conferma', async ({ page }) => {
    test.slow();

    // La risposta si ascolta PRIMA di premere: `waitForResponse` registrato dopo
    // il click perde le risposte veloci.
    //
    // ⚠️ IL CONFRONTO È SUL PERCORSO INTERO, non `includes`: in questo percorso
    // parte PRIMA un'altra POST — quella della scansione, su
    // `/api/iscrizione/personale/upload` — che un `includes('/api/iscrizione/
    // personale')` intercetterebbe per prima. Il test leggerebbe il 200
    // dell'upload al posto del 201 dell'invio, cioè misurerebbe l'allegato
    // credendo di misurare la pratica.
    const invio = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/iscrizione/personale' &&
        r.request().method() === 'POST',
    );

    await page.goto('/anagrafica-personale');
    await attendiFineCaricamento(page);

    // NESSUN LOGIN. `/anagrafica-personale` è in `PUBLIC_PREFIXES`
    // (`src/lib/auth/middleware-rules.ts`) e questo blocco gira senza
    // `storageState`: se un giorno quella riga sparisse, il middleware porterebbe a
    // `/auth/login` e a scoprirlo sarebbe una maestra a cui è stato appena mandato
    // il link.
    await expect(page).toHaveURL(/\/anagrafica-personale$/);
    await expect(page.getByRole('heading', { name: itPublic.persTitolo, level: 1 })).toBeVisible();

    // ── Passo 1 · «La tua sede» ─────────────────────────────────────────────
    // Qui il passo c'è SEMPRE — anche con un plesso solo, ed è una decisione del
    // modulo (non esiste nessun `?sede=`): chi consegna il proprio documento
    // d'identità deve leggere il nome della sede a cui lo sta consegnando.
    // Il radio si cerca per `id` e non per nome accessibile: la card ripete la
    // città ricavata dal nome («Plesso di Collaudo» → «di Collaudo»), quindi il
    // nome accessibile è la somma dei due e non è ciò che il test vuole fissare.
    const sede = page.locator(`#pers-sede-${IDS.SCUOLA_COLLAUDO}`);
    await expect(sede).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(SEDE_COLLAUDO, { exact: true })).toBeVisible();
    // Con una sede sola l'hook la sceglie da sé: `check()` è il gesto della
    // persona ed è idempotente. L'asserzione che segue vale in entrambi i casi.
    await sede.check();
    await expect(sede).toBeChecked();
    // …e non si sta scegliendo fra le sedi del seed: quelle `e2e00000-…` sono
    // escluse da ogni elenco pubblico, ed è la proprietà che tiene i moduli
    // anonimi lontani da un plesso che in produzione ESISTE.
    await expect(page.locator(`#pers-sede-${IDS.SCUOLA}`)).toHaveCount(0);
    await page.getByRole('button', { name: itPublic.persAvanti }).click();

    // ── Passo 2 · «I tuoi dati» ─────────────────────────────────────────────
    // Selettori per `id`: nel template gli `id` dei campi SONO i nomi delle
    // colonne di destinazione, e le etichette portano l'asterisco
    // dell'obbligatorietà — «Nome» come nome accessibile pescherebbe anche
    // «Cognome», che lo contiene.
    await expect(page.getByRole('heading', { name: itPublic.persDati, level: 2 })).toBeVisible();
    await page.locator('#nome').fill(NOME);
    await page.locator('#cognome').fill(COGNOME);
    await page.locator('#gender').selectOption('F');
    await page.locator('#birth_date').fill('1985-06-12');

    // IL LUOGO DI NASCITA È UNA TENDINA A CASCATA, non una casella di testo: è la
    // scelta che produce `codice_belfiore_nascita`, cioè i quattro caratteri senza
    // i quali il codice fiscale non è verificabile da nessuno. Il comune resta
    // SPENTO finché la provincia non è scelta — per questo l'ordine non è
    // invertibile.
    const provincia = page.locator('#pers-nascita-provincia');
    await provincia.fill('Napoli');
    await page.getByRole('option', { name: PROVINCIA_NASCITA, exact: true }).click();
    const comune = page.locator('#pers-nascita-comune');
    await comune.fill(COMUNE_NASCITA);
    await page.getByRole('option', { name: COMUNE_NASCITA, exact: true }).click();
    await expect(comune).toHaveValue(COMUNE_NASCITA);

    await page.locator('#fiscal_code').fill(CODICE_FISCALE);
    await page.locator('#citizenship').fill('Italiana');
    await page.locator('#titolo_studio').selectOption('laurea_magistrale');
    // `gradi` è multi-valore (colonna `school_type_enum[]`) e ne serve almeno una:
    // il CHECK in tabella è `cardinality(gradi) >= 1`.
    await page.getByRole('checkbox', { name: 'Infanzia (3-6)' }).check();
    await page.getByRole('button', { name: itPublic.persAvanti }).click();

    // ── Passo 3 · «Residenza e recapiti» ────────────────────────────────────
    await expect(page.getByRole('heading', { name: itPublic.persResidenza, level: 2 })).toBeVisible();
    await page.locator('#address').fill('Via Roma');
    await page.locator('#residence_street_number').fill('12');
    await page.locator('#residence_city').fill('Giugliano in Campania');
    await page.locator('#residence_province').fill('NA');
    await page.locator('#zip_code').fill('80014');
    await page.locator('#email').fill(PERSONALE_E2E.emailPratica);
    await page.locator('#telefono').fill('+39 333 1234567');
    await page.getByRole('button', { name: itPublic.persAvanti }).click();

    // ── Passo 4 · «Documento d'identità» ────────────────────────────────────
    await expect(page.getByRole('heading', { name: itPublic.persDocumento, level: 2 })).toBeVisible();
    await page.locator('#document_type').selectOption('CI');
    await page.locator('#document_number').fill('AB1234567');
    // La scadenza è MASCHERATA in gg/mm/aaaa (non è un `input[type=date]`): è la
    // forma in cui la data sta scritta sul documento, ed è l'unica in cui giorno e
    // mese scambiati non producono una data valida e sbagliata.
    await page.locator('#pers-documento-scadenza').fill(SCADENZA_DOCUMENTO);

    // La scansione passa dalla rotta di caricamento e finisce nel bucket privato
    // `documenti_personale`: l'invio manda solo il PERCORSO, e la rotta lo
    // riconosce perché lo trova nel registro dei caricamenti. Un percorso
    // inventato prende 400 sul campo del documento.
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: NOME_FILE, mimeType: 'application/pdf', buffer: PDF_MINIMO });
    // Il caricamento sostituisce il testo del campo col NOME del file: è la sola
    // conferma che la scansione sia arrivata (il percorso nel bucket non si stampa
    // mai a schermo, di proposito).
    await expect(page.getByText(NOME_FILE).first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: itPublic.persAvanti }).click();

    // ── Passo 5 · «Informativa e dichiarazioni» ─────────────────────────────
    // TRE prese visione, tutte obbligatorie, e nessun consenso al trattamento: fra
    // datore e dipendente il consenso non sarebbe libero (art. 7 §4), quindi qui
    // ciò che si raccoglie è la prova dell'informativa.
    await expect(
      page.getByRole('heading', { name: itPublic.persConsensiTitolo, level: 2 }),
    ).toBeVisible();
    const informativa = page.locator('#presa_visione_informativa_personale');
    const veridicita = page.locator('#dichiarazione_veridicita');
    const copiaDocumento = page.locator('#presa_visione_copia_documento');
    await expect(informativa).toBeVisible();
    await expect(veridicita).toBeVisible();
    await expect(copiaDocumento).toBeVisible();

    // L'obbligo si prova PRIMA di soddisfarlo: senza spunte «Avanti» non porta al
    // riepilogo. NB: non si cerca la parola «Riepilogo», che compare anche
    // nell'indicatore dei passi e renderebbe l'asserzione vera per il motivo
    // sbagliato. L'elemento che esiste SOLO nel riepilogo è il pulsante d'invio.
    await page.getByRole('button', { name: itPublic.persAvanti }).click();
    await expect(page.getByRole('button', { name: itPublic.persInvia })).toHaveCount(0);

    await informativa.check();
    await veridicita.check();
    await copiaDocumento.check();
    await page.getByRole('button', { name: itPublic.persAvanti }).click();

    // ── Passo 6 · Riepilogo ─────────────────────────────────────────────────
    // È l'ultima schermata prima di un invio irreversibile, e il suo unico compito
    // è farsi ricontrollare: si rileggono la SEDE (il plesso a cui si sta
    // consegnando un documento d'identità) e il codice fiscale.
    const invia = page.getByRole('button', { name: itPublic.persInvia });
    await expect(invia).toBeVisible();
    await expect(page.getByText(itPublic.persRiepilogoSede, { exact: true })).toBeVisible();
    await expect(page.getByText(SEDE_COLLAUDO, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(CODICE_FISCALE, { exact: true })).toBeVisible();
    await invia.click();

    // IL 201, non «una risposta qualunque»: il 503 del database non migrato, il
    // 400 sulla sede e il 429 del tetto sono risposte oneste della rotta, e questo
    // test non deve accettarne nessuna.
    const risposta = await invio;
    expect(risposta.status()).toBe(201);
    const corpo = (await risposta.json()) as { id?: unknown };
    expect(typeof corpo.id).toBe('string');
    idPratica = String(corpo.id);

    // La conferma è il momento più importante del modulo, e va ANNUNCIATA: è un
    // `role="status"` con dentro l'`h2` che riceve il fuoco. Si pretende
    // l'intestazione, cioè ciò che uno screen reader legge.
    await expect(page.getByRole('heading', { name: itPublic.persInviata })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(itPublic.persInviataCorpo)).toBeVisible();
  });
});

/**
 * ─── L'EFFETTO, NON IL MESSAGGIO ───────────────────────────────────────────
 *
 * La conferma a schermo da sola non prova niente: la rotta risponde **201 anche a
 * un doppione**, quindi «Anagrafica inviata!» comparirebbe identica anche se
 * nessuna riga nuova fosse nata. Qui si va a guardare la riga vera, con la sola
 * chiave che la identifica — l'`id` che il 201 ha restituito — e si controlla
 * quello che un invio riuscito deve aver scritto: l'email di chi ha compilato, la
 * SEDE (il difetto che questo prodotto teme di più è archiviare nel plesso
 * sbagliato in silenzio) e lo stato `pending`, che è ciò che la Segreteria dovrà
 * evadere.
 *
 * Si passa dall'API e non dal cockpit di proposito: il percorso a schermo — trova,
 * apri, approva — è collaudato da `admin-pratiche-personale.spec.ts`, e ripeterlo
 * qui costerebbe due minuti di CI per collaudare due volte la stessa pagina.
 */
test.describe('la pratica inviata esiste davvero @solo-chromium', () => {
  test.use({ storageState: STORAGE.admin });

  test('la riga è in tabella, sulla sede giusta e in attesa', async ({ request }) => {
    expect(
      idPratica,
      'Il percorso pubblico non ha restituito nessun id: senza, qui non c’è niente da verificare.',
    ).not.toBeNull();

    const res = await request.get(`/api/admin/pratiche-personale?id=${idPratica}`);
    expect(res.status()).toBe(200);
    const corpo = (await res.json()) as {
      data?: { email?: string; scuola_id?: string; stato?: string; nome?: string; cognome?: string };
    };
    expect(corpo.data?.email).toBe(PERSONALE_E2E.emailPratica);
    expect(corpo.data?.scuola_id).toBe(IDS.SCUOLA_COLLAUDO);
    expect(corpo.data?.stato).toBe('pending');
    expect(corpo.data?.nome).toBe(NOME);
    expect(corpo.data?.cognome).toBe(COGNOME);
  });
});
