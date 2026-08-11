import { test, expect } from '@playwright/test';
import { IDS } from './fixtures';
import itPublic from '../messages/it/public.json';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  `/lavora-con-noi` — il modulo PUBBLICO di candidatura di un'insegnante  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ─── COSA C'È QUI DENTRO, E PERCHÉ NON È QUELLO CHE CI SI ASPETTA ───────────
 *
 * Il percorso vero di questa pagina — apri, compila i passi, scegli PIÙ DI UNA
 * fascia, spunta il consenso obbligatorio, invia, leggi la conferma — sta nel
 * terzo blocco di questo file ed è in `test.fixme`: **oggi non può girare**, e
 * la ragione è misurata, non prudenziale. Il primo e il secondo blocco girano
 * da subito e collaudano l'unica cosa che su questo database è vera: che il
 * modulo NON comincia, e che lo dice.
 *
 * Un collaudo scritto per accettare due esiti opposti «per prudenza» — 201
 * oppure 503, conferma oppure errore — non prova niente ed è peggio di un
 * collaudo assente, perché sembra coprire. Quindi qui i due esiti stanno in due
 * test diversi, e quello che non può essere verde è dichiarato spento.
 *
 * ─── PERCHÉ IL PERCORSO VERO NON PUÒ GIRARE (due cause, non una) ────────────
 *
 * 1. **La tabella non esiste sul database della CI.** Il progetto Supabase della
 *    CI è separato dalla produzione e non è migrato: `candidature_insegnanti`
 *    non c'è, PostgREST risponde `PGRST205`/`42P01` e la rotta traduce quel caso
 *    in un **503 DICHIARATO** (`CANDIDATURE_NON_DISPONIBILI`,
 *    `src/app/api/iscrizione/insegnanti/route.ts`) invece di fingere un 201. La
 *    rotta si comporta bene; è il collaudo del percorso felice a non avere un
 *    posto dove atterrare.
 *
 * 2. **Nessuna sede a cui candidarsi.** E questa, da sola, ferma il modulo PRIMA
 *    dell'invio. Il seed crea due sedi `e2e00000-…` (`scripts/seed-e2e.mjs`), e
 *    `isScuolaE2E` (`src/lib/scuole/reali.ts`) le esclude da ogni elenco
 *    pubblico: `GET /api/iscrizione/sedi` risponde `{ data: [] }`. Con l'elenco
 *    vuoto il wizard non dipinge nessun passo — dice «Nessuna sede riceve
 *    candidature online» — ed è la stessa esclusione che `POST
 *    /api/iscrizione/insegnanti` applica a `scuola_id` (valida contro `reali`,
 *    non contro `tutte`, a differenza della rotta sorella `/api/iscrizione`).
 *    Cioè: **anche a migrazione fatta, quel POST rifiuterebbe la sede di
 *    collaudo con `400 SEDE_DA_SPECIFICARE`.**
 *
 * ─── COSA SERVE PER RIACCENDERLO ───────────────────────────────────────────
 *
 * Due gesti, e vanno detti tutti e due perché fermarsi al primo lascerebbe qui
 * un test che si riaccende per fallire:
 *
 *  a. lanciare a mano il workflow **«DB migrate (CI)»**
 *     (`.github/workflows/migrate-ci.yml`, `workflow_dispatch`) con
 *     `20260810094610_candidature_insegnanti.sql` — è idempotente, la sua testata
 *     lo dichiara file per file;
 *  b. dare alla CI una sede che `sediReali` ACCETTI. Oggi non ne esiste
 *     nessuna: o il seed ne crea una che `isScuolaE2E` non riconosce (il
 *     database della CI è separato dalla produzione, quindi non apre niente
 *     là), oppure la rotta impara a indicare la sede di collaudo per altra
 *     via — che è esattamente ciò che il commento della rotta si riserva di
 *     fare («Quando la CI sarà migrata, la sede di collaudo si indicherà per
 *     altra via»).
 *
 * Fatti entrambi: togliere il `.fixme` dal terzo blocco. Nient'altro.
 *
 * ─── NOTA SUI DUE TETTI, per chi riaccenderà il terzo blocco ────────────────
 * `POST /api/iscrizione/insegnanti` ha un tetto di **3 richieste l'ora per IP**
 * e in CI i browser escono da un IP solo: con `retries: 2` un test che invia
 * consuma fino a tre gettoni: il quarto tentativo della giornata prenderebbe
 * 429. `GET /api/iscrizione/sedi` sta a 30 ogni 10 minuti, e i due test attivi
 * qui sotto ne consumano uno ciascuno.
 */

/** L'indirizzo del terzo blocco. Fisso di proposito: vedi il commento lì. */
const EMAIL_CANDIDATURA = 'candidatura.e2e@kidville.test';

test.describe('modulo pubblico di candidatura', () => {
  test('si apre senza account e dichiara che non si può cominciare', async ({ page }) => {
    await page.goto('/lavora-con-noi');

    // NESSUN LOGIN. `/lavora-con-noi` è in `PUBLIC_PREFIXES`
    // (`src/lib/auth/middleware-rules.ts`) e questo test gira senza
    // `storageState`: se un giorno quella riga sparisse, il middleware
    // porterebbe a `/auth/login` e la sola persona che se ne accorgerebbe
    // sarebbe chi ha in mano il volantino.
    await expect(page).toHaveURL(/\/lavora-con-noi$/);

    // L'`h1` della pagina, che è anche il punto da cui ricomincia chi naviga per
    // intestazioni.
    await expect(page.getByRole('heading', { name: itPublic.candTitolo, level: 1 })).toBeVisible();
    await expect(page.getByText(itPublic.candSottotitolo)).toBeVisible();

    // ── LO STATO CHE OGGI SI PUÒ COLLAUDARE DAVVERO ────────────────────────
    // Elenco ARRIVATO e VUOTO (le due sedi del seed sono escluse dall'elenco
    // pubblico): il modulo non comincia, e la frase distingue «non riusciamo a
    // caricare le sedi» da «nessuna sede riceve candidature». Sono due cause
    // diverse e due testi diversi: pretendere quello giusto è metà del valore di
    // questo test, perché la confusione fra i due manderebbe una persona a
    // controllare una connessione che non ha nessun problema.
    const pannello = page.getByRole('alert').filter({ hasText: itPublic.candSediVuoteTitolo });
    await expect(pannello).toBeVisible({ timeout: 15_000 });
    await expect(pannello).toContainText(itPublic.candSediVuoteCorpo);
    await expect(page.getByText(itPublic.candSediErroreTitolo)).toHaveCount(0);

    // NIENTE «Riprova» su questo ramo: ricaricare darebbe la stessa risposta, e
    // un pulsante che ripete la stessa risposta insegna a non fidarsi dei
    // pulsanti. È una scelta esplicita del wizard, quindi si collauda.
    await expect(page.getByRole('button', { name: itPublic.candSediRiprova })).toHaveCount(0);

    // E non c'è nessun modulo da compilare: né passi, né comandi, né sede da
    // scegliere. Un modulo che si lascia compilare e poi non si può inviare è
    // precisamente il difetto che questa schermata esiste per evitare.
    await expect(page.getByRole('button', { name: itPublic.candAvanti })).toHaveCount(0);
    await expect(page.getByRole('button', { name: itPublic.candInvia })).toHaveCount(0);
    await expect(page.getByRole('radio')).toHaveCount(0);
    await expect(page.locator('#nome')).toHaveCount(0);
  });

  test('il link targato con la sede di collaudo non scavalca l’elenco', async ({ page }) => {
    /*
     * ⚠️ QUESTO TEST DICE IL CONTRARIO DI CIÒ CHE SEMBRA OVVIO, ED È IL PUNTO.
     *
     * Su `/iscrizione` il link targato (`?scuola=<uuid>`) È la strada con cui
     * l'E2E entra nel modulo: quel POST valida contro `tutte`, sede di collaudo
     * compresa. Qui no. Dall'11/08/2026 `CandidaturaInsegnanteWizard` chiede
     * SEMPRE l'elenco e lo tratta come l'unica autorità: `?sede=` è un
     * suggerimento che vale solo se l'elenco lo conferma. L'elenco della CI è
     * vuoto, quindi il link è SMENTITO e si finisce sulla stessa schermata del
     * test qui sopra.
     *
     * Non è un difetto: è la proprietà per cui quel ramo è stato scritto — un
     * volantino vecchio non deve poter far compilare quattro passi per poi
     * incassare un 400 sulla sede. Il collaudo la blocca in questa direzione:
     * il giorno in cui qualcuno rimettesse la scorciatoia «col link non chiedo
     * l'elenco», questo test diventerebbe rosso PRIMA che un uuid morto arrivi
     * su un volantino stampato.
     */
    await page.goto(`/lavora-con-noi?sede=${IDS.SCUOLA}`);

    await expect(page.getByRole('heading', { name: itPublic.candTitolo, level: 1 })).toBeVisible();
    await expect(
      page.getByRole('alert').filter({ hasText: itPublic.candSediVuoteTitolo }),
    ).toBeVisible({ timeout: 15_000 });

    // Nessun passo dipinto: né la scelta della sede, né il primo passo
    // compilabile. Col link il wizard NON parte, perché la sede indicata non è
    // fra quelle che ricevono candidature.
    await expect(page.getByText(itPublic.candSede, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: itPublic.candAvanti })).toHaveCount(0);
    await expect(page.locator('#nome')).toHaveCount(0);
  });

  /**
   * ⛔ SPENTO — vedi la testata di questo file, sezione «cosa serve per
   * riaccenderlo». Non toccare il corpo: è il percorso vero, scritto per essere
   * eseguito il giorno in cui (a) il workflow «DB migrate (CI)» avrà creato
   * `candidature_insegnanti` sul database della CI e (b) la CI avrà una sede che
   * `sediReali` accetta. Allora si toglie il `.fixme` e basta.
   *
   * Cosa collauda: il percorso completo di chi si candida — l'elenco delle sedi,
   * i tre passi compilabili, **due fasce d'età** (il campo è multi-valore, ed è
   * l'informazione con cui la segreteria smista), il consenso OBBLIGATORIO
   * spuntato come lo spunterebbe una persona, il `201` della rotta e il pannello
   * di conferma annunciato.
   *
   * L'indirizzo è FISSO e non generato: l'indice unico
   * `candidature_insegnanti_email_viva` è globale sugli stati vivi, e la rotta
   * traduce il duplicato (`23505`) in **201, come al primo invio** — quindi una
   * seconda esecuzione non diventa rossa per colpa della prima. Il seed NON
   * ripulisce questa tabella: chi riaccende il test decida se aggiungercelo,
   * sapendo che senza pulizia la riga resta una sola e le successive sono
   * duplicati serviti come 201.
   */
  test.fixme('percorso vero: due fasce, consenso, 201 e pannello di conferma', async ({ page }) => {
    test.slow();

    // La risposta si ascolta PRIMA di premere: `waitForResponse` registrato dopo
    // il click perde le risposte veloci.
    const invio = page.waitForResponse(
      (r) => r.url().includes('/api/iscrizione/insegnanti') && r.request().method() === 'POST',
    );

    await page.goto('/lavora-con-noi');
    await expect(page.getByRole('heading', { name: itPublic.candTitolo, level: 1 })).toBeVisible();

    // ── Passo «sede», se c'è ────────────────────────────────────────────────
    // Con UNA sola sede il wizard la decide da sé e il passo non esiste; con più
    // d'una si sceglie. Il test non pretende di sapere quante ne avrà la CI: si
    // comporta come una persona davanti allo schermo che ha di fronte.
    const sedi = page.getByRole('radio');
    if ((await sedi.count()) > 0) {
      await sedi.first().check();
      await page.getByRole('button', { name: itPublic.candAvanti }).click();
    }

    // ── Passo «I tuoi dati» ─────────────────────────────────────────────────
    // Selettori per `id`: nel template gli `id` dei campi SONO i nomi delle
    // colonne di destinazione (`insegnanti-template.ts`), e le etichette portano
    // l'asterisco dell'obbligatorietà — «Nome» come nome accessibile pescherebbe
    // anche «Cognome», che lo contiene.
    await expect(page.getByText(itPublic.candDati, { exact: true })).toBeVisible();
    await page.locator('#nome').fill('Ines');
    await page.locator('#cognome').fill('Candidatura-E2E');
    await page.locator('#email').fill(EMAIL_CANDIDATURA);
    await page.getByRole('button', { name: itPublic.candAvanti }).click();

    // ── Passo «Il tuo profilo» ──────────────────────────────────────────────
    await expect(page.getByText(itPublic.candProfilo, { exact: true })).toBeVisible();
    await page.locator('#titolo_studio').selectOption('laurea_magistrale');

    // PIÙ DI UNA FASCIA. È il punto del passo: `gradi` è una `checkbox`
    // multi-valore (colonna `school_type_enum[]`), e un test che ne spunta una
    // sola non distinguerebbe un array da uno scalare. Le etichette sono quelle
    // di `GRADI_OPTIONS`, cablate in italiano nel template (debito dichiarato lì).
    await page.getByRole('checkbox', { name: 'Nido (0-3)' }).check();
    await page.getByRole('checkbox', { name: 'Infanzia (3-6)' }).check();
    await page.getByRole('button', { name: itPublic.candAvanti }).click();

    // ── Passo «Consensi e informativa» ──────────────────────────────────────
    // La presa visione (art. 13) è OBBLIGATORIA: senza, il wizard non avanza. Si
    // prova che l'obbligo sia REALE prima di soddisfarlo — e si guarda il
    // pulsante d'invio, non la parola «Riepilogo», che compare anche
    // nell'indicatore dei passi e renderebbe l'asserzione vera per il motivo
    // sbagliato.
    const presaVisione = page.getByRole('checkbox', { name: /informativa sulla privacy/i });
    await expect(presaVisione).toBeVisible();
    await page.getByRole('button', { name: itPublic.candAvanti }).click();
    await expect(page.getByRole('button', { name: itPublic.candInvia })).toHaveCount(0);

    // Il consenso FACOLTATIVO alla conservazione resta spento: dev'essere
    // possibile candidarsi senza darlo, ed è l'unica prova che sia libero.
    await presaVisione.check();
    await page.getByRole('button', { name: itPublic.candAvanti }).click();

    // ── Riepilogo ───────────────────────────────────────────────────────────
    // Le due fasce si RILEGGONO qui: il riepilogo è l'ultimo punto in cui chi si
    // candida può accorgersi che il modulo ha capito un'altra cosa.
    await expect(page.getByText(itPublic.candRiepilogoFasce)).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Nido (0-3)' })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Infanzia (3-6)' })).toBeVisible();
    await expect(page.getByText(itPublic.candRiepilogoNessunaFascia)).toHaveCount(0);

    await page.getByRole('button', { name: itPublic.candInvia }).click();

    // IL 201, non «una risposta qualunque». Il 503 dichiarato del database non
    // migrato e il 400 sulla sede sono risposte oneste della rotta, e questo test
    // NON deve accettarle: è la differenza fra collaudare l'invio e collaudare
    // che qualcosa sia successo.
    expect((await invio).status()).toBe(201);

    // La conferma è il momento più importante del modulo, e va ANNUNCIATA: è un
    // `role="status"` con dentro l'`h2` che riceve il fuoco. Si pretende
    // l'intestazione, cioè ciò che uno screen reader legge.
    await expect(page.getByRole('heading', { name: itPublic.candInviata })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(itPublic.candInviataCorpo)).toBeVisible();
  });
});
