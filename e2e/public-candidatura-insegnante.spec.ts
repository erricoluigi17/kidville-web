import { test, expect } from '@playwright/test';
import { IDS, PERSONALE_E2E, attendiFineCaricamento } from './fixtures';
import itPublic from '../messages/it/public.json';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  `/lavora-con-noi` — il modulo PUBBLICO di candidatura di un'insegnante  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Tre blocchi, e tutti e tre girano: il modulo si apre senza account, il link
 * targato vale solo se l'elenco delle sedi lo conferma, e il percorso vero —
 * compila, scegli DUE posizioni, spunta il consenso obbligatorio, invia, leggi la
 * conferma — arriva fino al 201.
 *
 * ─── DAL 15/08/2026 IL MODULO NON CHIEDE PIÙ LE FASCE ──────────────────────
 *
 * `/lavora-con-noi` non raccoglie più solo candidature da insegnante: la domanda
 * «per quali fasce ti proponi» è sparita e al suo posto c'è «per quali POSIZIONI»
 * — sette caselle, le tre docenti col nome della fascia dentro
 * («Insegnante — Nido (0-3)») più collaboratrice, cuoca, segreteria e altro. Le
 * fasce (`gradi`) non viaggiano più nel payload: le DERIVA il server dalle
 * posizioni, e per una candidatura non docente restano un array vuoto.
 * Qui sotto cambiano di conseguenza le caselle spuntate e le due chiavi del
 * riepilogo (`candRiepilogoPosizioni`, `candRiepilogoNessunaPosizione`), che
 * hanno sostituito `candRiepilogoFasce`/`candRiepilogoNessunaFascia`.
 *
 * ─── ⚠️ QUESTA TESTATA DICEVA ALTRO, E OGGI NON È PIÙ VERO (12/08/2026) ────
 *
 * Fino a questa data il percorso vero era in `test.fixme` e i primi due blocchi
 * collaudavano l'esatto contrario di quello che collaudano adesso: che il modulo
 * **non comincia** e che lo dice («Nessuna sede riceve candidature online»). Non
 * era prudenza, era la misura di allora — e le due cause che la producevano sono
 * state entrambe rimosse:
 *
 * 1. **La tabella non esisteva sul database della CI.** Il progetto Supabase della
 *    CI è separato dalla produzione e non era migrato: `candidature_insegnanti`
 *    non c'era, PostgREST rispondeva `PGRST205`/`42P01` e la rotta traduceva quel
 *    caso in un **503 dichiarato** (`CANDIDATURE_NON_DISPONIBILI`) invece di
 *    fingere un 201. ✅ Il database della CI è stato **migrato il 12/08/2026** con
 *    `candidature_insegnanti`, `codice_belfiore_nascita`, `anagrafica_personale`,
 *    `anagrafica_personale_trigger_invoker` e `caricamenti_personale`.
 *
 * 2. **Non c'era nessuna sede a cui candidarsi.** Il seed creava due sedi
 *    `e2e00000-…` e `isScuolaE2E` (`src/lib/scuole/reali.ts`) le esclude da ogni
 *    elenco pubblico: `GET /api/iscrizione/sedi` rispondeva `{ data: [] }`, il
 *    wizard non dipingeva un passo, e lo stesso predicato avrebbe rifiutato quelle
 *    sedi anche all'invio (`400 SEDE_DA_SPECIFICARE`). ✅ Dal 12/08/2026 il seed
 *    semina il **«Plesso di Collaudo»** (`IDS.SCUOLA_COLLAUDO`): id che non
 *    comincia per `e2e00000` e nome che non contiene «e2e», quindi `sediReali` lo
 *    accetta. È l'unica sede che i moduli pubblici mostrano in CI.
 *
 * La testata è stata riscritta e non ampliata: *un documento che descrive uno
 * stato che non c'è più è peggio di nessun documento*, ed è una lezione scritta in
 * `CLAUDE.md` — questo file l'avrebbe violata restando com'era, per giunta
 * spiegando «come riaccendere» una cosa già accesa.
 *
 * ─── UNA SOLA SEDE IN ELENCO, E SI VEDE ────────────────────────────────────
 * Con un plesso solo `useSediPubbliche` lo decide da sé: il passo «Sede» non
 * esiste (`mostraSede` è falso) e il primo passo è «I tuoi dati». Non è una
 * scorciatoia del banco di prova — è il comportamento del prodotto quando i plessi
 * che ricevono candidature sono uno. Se un domani il seed ne aggiungesse una
 * seconda REALE, le asserzioni qui sotto diventano rosse: è giusto, andrà scelta.
 * La sede si rilegge comunque nel RIEPILOGO, che è dove chi si candida la controlla.
 *
 * ─── I DUE TETTI ───────────────────────────────────────────────────────────
 * `POST /api/iscrizione/insegnanti` ha un tetto di **3 richieste l'ora per IP** e
 * in CI i browser escono da un IP solo: con `retries: 2` il terzo blocco consuma
 * fino a tre gettoni, cioè tutti. Per questo porta `@solo-chromium` — il progetto
 * `webkit` lo salta (`grepInvert` in `playwright.config.ts`) — e per questo i primi
 * due blocchi NON inviano niente. `GET /api/iscrizione/sedi` sta a 30 ogni 10
 * minuti, e qui se ne consumano quattro in tutto.
 */

/**
 * L'indirizzo del terzo blocco. Fisso di proposito (vedi il commento lì) e preso
 * da `PERSONALE_E2E`: è lo stesso che il seed ripulisce a ogni run, e ricopiarlo a
 * mano qui sarebbe la copia che diverge — con l'effetto di lasciare in tabella una
 * riga viva che al run successivo trasforma il 201 del primo invio in un 201 da
 * doppione.
 */
const EMAIL_CANDIDATURA = PERSONALE_E2E.emailCandidatura;

/** Il nome del plesso che il seed rende visibile ai moduli pubblici. */
const SEDE_COLLAUDO = 'Plesso di Collaudo';

/**
 * Le caselle delle POSIZIONI toccate da questo percorso.
 *
 * ⚠️ IL TRATTINO DELLE VOCI DOCENTI È UN EM DASH — «—», U+2014, misurato nel
 * sorgente — e non un trattino corto: `POSIZIONI_OPTIONS` le compone come
 * `Insegnante — <etichetta della fascia>` (`insegnanti-template.ts`), cioè dalle
 * stesse `GRADI_OPTIONS` di prima col prefisso `insegnante_`. Con un trattino
 * qualunque il nome accessibile non combacia e la casella non si trova: il test
 * morirebbe dicendo «elemento non trovato», che è il modo peggiore di segnalare
 * un'etichetta cambiata.
 *
 * Sono ribattute qui e non importate perché nessun file di `e2e/` importa da
 * `src/` (le etichette del template sono cablate in italiano, debito dichiarato
 * lì): il giorno in cui cambiassero, questo blocco diventa rosso — ed è giusto,
 * perché è il testo che una persona legge prima di candidarsi.
 */
const POSIZIONE_DOCENTE = 'Insegnante — Nido (0-3)';
const POSIZIONE_NON_DOCENTE = 'Cuoca / aiuto cucina';
const POSIZIONE_ALTRO = 'Altro (specifica qui sotto)';

/** «Candidatura per la sede X», composta DAL CATALOGO e non ricopiata a mano. */
const rigaSedeDalLink = (sede: string) => itPublic.candSedeDalLinkTitolo.replace('{sede}', sede);
/**
 * Lo stesso testo senza il nome del plesso («Candidatura per la sede»).
 *
 * `getByText` cerca per sottostringa, quindi con questo si afferma che NON esiste
 * nessuna riga di sede-dal-link, qualunque plesso nominasse — che è più forte del
 * negare la sola riga del «Plesso di Collaudo».
 */
const PREFISSO_SEDE_DAL_LINK = itPublic.candSedeDalLinkTitolo.split('{')[0].trim();

test.describe('modulo pubblico di candidatura', () => {
  test('si apre senza account e il modulo comincia', async ({ page }) => {
    await page.goto('/lavora-con-noi');
    await attendiFineCaricamento(page);

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

    // ── L'AFFERMAZIONE POSITIVA VIENE PRIMA ────────────────────────────────
    // L'elenco è arrivato e contiene un plesso, quindi il modulo COMINCIA: con
    // una sede sola non c'è niente da scegliere e il primo passo è «I tuoi dati».
    await expect(page.getByRole('heading', { name: itPublic.candDati, level: 2 })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('#nome')).toBeVisible();
    await expect(page.getByRole('button', { name: itPublic.candAvanti })).toBeVisible();

    // …e solo dopo le negative, che sono le DUE schermate di rinuncia: «l'elenco
    // non è arrivato» e «l'elenco è arrivato ed è vuoto». Sono due cause diverse
    // con due testi diversi — confonderle manderebbe una persona a controllare una
    // connessione che non ha nessun problema — e qui non deve esserci nessuna
    // delle due.
    await expect(page.getByText(itPublic.candSediVuoteTitolo)).toHaveCount(0);
    await expect(page.getByText(itPublic.candSediErroreTitolo)).toHaveCount(0);

    // Nessuna scelta di sede: con un plesso solo l'hook lo decide da sé, e un
    // gruppo di radio con una voce sola sarebbe un passo che non decide niente.
    await expect(page.getByRole('radio')).toHaveCount(0);
  });

  test('il link targato vale solo se l’elenco lo conferma', async ({ page }) => {
    /*
     * ⚠️ QUESTO TEST DICE IL CONTRARIO DI CIÒ CHE SEMBRA OVVIO, ED È IL PUNTO.
     *
     * Su `/iscrizione` il link targato (`?scuola=<uuid>`) È la strada con cui
     * l'E2E entra nel modulo: quel POST valida contro `tutte`, sede di collaudo
     * compresa. Qui no. Dall'11/08/2026 `CandidaturaInsegnanteWizard` chiede
     * SEMPRE l'elenco e lo tratta come l'unica autorità: `?sede=` è un
     * suggerimento che vale solo se l'elenco lo conferma.
     *
     * Le due sedi `e2e00000-…` del seed non sono in elenco (`isScuolaE2E` le
     * esclude), quindi un link che le indica viene ABBANDONATO prima che qualcuno
     * abbia compilato alcunché — ed è la proprietà per cui quel ramo è stato
     * scritto: un volantino vecchio non deve poter far compilare quattro passi per
     * poi incassare un 400 sulla sede. Il giorno in cui qualcuno rimettesse la
     * scorciatoia «col link non chiedo l'elenco», questo test diventerebbe rosso
     * PRIMA che un uuid morto finisca su un volantino stampato.
     *
     * La differenza si osserva sulla riga «Candidatura per la sede X», che il
     * wizard scrive sotto il titolo SOLO quando il link è ancora buono: stesso
     * parametro, due esiti, e a decidere è l'elenco.
     */

    // 1 · il link che l'elenco CONFERMA: la sede si nomina subito, così chi apre
    //     il collegamento sa a quale plesso si sta proponendo senza arrivare al
    //     riepilogo.
    await page.goto(`/lavora-con-noi?sede=${IDS.SCUOLA_COLLAUDO}`);
    await attendiFineCaricamento(page);
    await expect(page.getByText(rigaSedeDalLink(SEDE_COLLAUDO))).toBeVisible({ timeout: 15_000 });

    // 2 · il link che l'elenco SMENTISCE (una sede di collaudo esclusa da ogni
    //     elenco pubblico): il modulo parte lo stesso — l'elenco ha una sede
    //     buona — ma quella riga non c'è, perché quel link non vale più niente.
    await page.goto(`/lavora-con-noi?sede=${IDS.SCUOLA}`);
    await attendiFineCaricamento(page);
    await expect(page.getByRole('heading', { name: itPublic.candDati, level: 2 })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(PREFISSO_SEDE_DAL_LINK)).toHaveCount(0);
  });

  /**
   * ✅ ACCESO IL 12/08/2026 — era in `test.fixme` da quando è nato, per le due
   * cause che la testata di questo file racconta e che oggi non ci sono più
   * (database della CI migrato · «Plesso di Collaudo» nel seed). Il corpo è quello
   * scritto allora, con due aggiunte: la sede si RILEGGE nel riepilogo — con un
   * plesso solo non c'è nulla da scegliere, e senza quella riga il test non
   * direbbe su quale sede sta candidando nessuno — e il blocco porta il tag che lo
   * tiene fuori dal progetto `webkit`.
   *
   * Cosa collauda: il percorso completo di chi si candida — l'elenco delle sedi,
   * i tre passi compilabili, **due posizioni** (il campo è multi-valore, ed è
   * l'informazione con cui la segreteria smista), la casella condizionale che
   * compare e sparisce con «Altro», il consenso OBBLIGATORIO spuntato come lo
   * spunterebbe una persona, il `201` della rotta e il pannello di conferma
   * annunciato.
   *
   * L'indirizzo è FISSO e non generato: l'indice unico
   * `candidature_insegnanti_email_viva` è globale sugli stati vivi, e la rotta
   * traduce il duplicato (`23505`) in **201, come al primo invio** — quindi una
   * seconda esecuzione non diventa rossa per colpa della prima. ✅ E dal 12/08/2026
   * il seed RIPULISCE anche questa tabella (`ripulisciModuliPersonale`, sulle tre
   * email di `PERSONALE_E2E`): ogni run parte da zero, quindi il 201 qui sotto è
   * quello del PRIMO invio e non quello di un doppione.
   */
  test('percorso vero: due posizioni, consenso, 201 e pannello di conferma @solo-chromium', async ({
    page,
  }) => {
    test.slow();

    // La risposta si ascolta PRIMA di premere: `waitForResponse` registrato dopo
    // il click perde le risposte veloci.
    const invio = page.waitForResponse(
      (r) => r.url().includes('/api/iscrizione/insegnanti') && r.request().method() === 'POST',
    );

    await page.goto('/lavora-con-noi');
    await attendiFineCaricamento(page);
    await expect(page.getByRole('heading', { name: itPublic.candTitolo, level: 1 })).toBeVisible();

    // ── Nessun passo «sede» ─────────────────────────────────────────────────
    // In CI il plesso che riceve candidature è UNO — il «Plesso di Collaudo» del
    // seed — e con una sede sola il wizard la decide da sé: il passo di scelta non
    // esiste. Non si scavalca il caso con un `if`: si afferma, così il giorno in
    // cui la CI avrà due sedi reali questo test diventa rosso e chiede di
    // scegliere, invece di spuntare in silenzio «la prima» e archiviare la
    // candidatura in un plesso a caso. La sede si rilegge nel riepilogo.
    await expect(page.getByRole('radio')).toHaveCount(0);

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

    // ── LA CASELLA CHE ESISTE SOLO SE UN'ALTRA È SPUNTATA ───────────────────
    // «Quale posizione» (`posizione_altro`) è la PRIMA logica condizionale di
    // questo modulo: `required: true` con una `condition` su «altro», e la
    // filtrano sia il client sia il server (`campiVisibili`). Si guarda in tutte
    // e due le direzioni — assente prima, presente dopo la spunta — perché la
    // sola asserzione negativa sarebbe vera anche per un campo che il wizard non
    // rende mai, cioè per il difetto opposto.
    await expect(page.locator('#posizione_altro')).toHaveCount(0);
    const altro = page.getByRole('checkbox', { name: POSIZIONE_ALTRO });
    await altro.check();
    await expect(page.locator('#posizione_altro')).toBeVisible();
    // E si torna indietro: questa candidatura non è «altro», e lasciando la
    // casella spuntata resterebbe un campo OBBLIGATORIO vuoto che ferma il passo.
    await altro.uncheck();
    await expect(page.locator('#posizione_altro')).toHaveCount(0);

    // PIÙ DI UNA POSIZIONE, e di due famiglie diverse. È il punto del passo:
    // `posizioni` è una `checkbox` multi-valore (colonna `text[]` con `CHECK` di
    // appartenenza), e un test che ne spunta una sola non distinguerebbe un array
    // da uno scalare. La coppia è scelta: una docente e una NON docente — il caso
    // che prima del 15/08/2026 il modulo non poteva nemmeno esprimere, e quello
    // da cui il server deriva `gradi` (qui: la sola fascia «nido») senza che il
    // client gliela mandi.
    await page.getByRole('checkbox', { name: POSIZIONE_DOCENTE }).check();
    await page.getByRole('checkbox', { name: POSIZIONE_NON_DOCENTE }).check();

    // IL CURRICULUM SI PUÒ ALLEGARE, ed è facoltativo: il campo `cv_path` è reso
    // da questo passo dal 15/08/2026 (prima il wizard lo teneva fuori, perché
    // nessuna rotta di caricamento produceva il prefisso che il server pretende).
    // L'`input[type=file]` è `sr-only` — fuori dalla vista, dentro l'albero di
    // accessibilità — quindi si afferma che è ATTACCATO, non che è visibile; e la
    // nota accanto è ciò che dice a chi non ha il PDF sottomano che può fotografare
    // il foglio invece di abbandonare il modulo.
    await expect(page.locator('#cv_path')).toBeAttached();
    await expect(page.getByText(itPublic.candCvNota)).toBeVisible();

    // Nessun file allegato: si invia lo stesso. È l'unica prova che il curriculum
    // sia davvero facoltativo — e un caricamento vero non si fa qui, perché la
    // rotta di upload sta a 6 caricamenti ogni 10 minuti per IP
    // (`TETTO_UPLOAD_CANDIDATURE`) e in CI i browser escono da un IP solo: con
    // `retries: 2` sarebbe la stessa aritmetica che tiene questo blocco fuori dal
    // progetto `webkit`.
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
    // LA SEDE, PRIMA DELLE POSIZIONI. Il passo di scelta non c'è (plesso unico) e
    // questo è l'unico punto in cui il modulo dichiara DOVE sta mandando la
    // candidatura: senza questa riga il test attraverserebbe tutto senza mai
    // guardare la cosa che una rotta pubblica può sbagliare in silenzio.
    await expect(page.getByText(itPublic.candRiepilogoSede, { exact: true })).toBeVisible();
    await expect(page.getByText(SEDE_COLLAUDO, { exact: true })).toBeVisible();

    // Le due posizioni si RILEGGONO qui: il riepilogo è l'ultimo punto in cui chi
    // si candida può accorgersi che il modulo ha capito un'altra cosa. Le voci
    // sono una per riga (`<li>`), non una stringa unita da virgole, quindi
    // ciascuna etichetta si può cercare intera.
    await expect(page.getByText(itPublic.candRiepilogoPosizioni)).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: POSIZIONE_DOCENTE })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: POSIZIONE_NON_DOCENTE })).toBeVisible();
    await expect(page.getByText(itPublic.candRiepilogoNessunaPosizione)).toHaveCount(0);
    // «Altro» è stato spuntato e poi tolto: non deve comparire fra le posizioni
    // riepilogate, o quello che il server riceve non è quello che si è scelto.
    await expect(page.getByRole('listitem').filter({ hasText: POSIZIONE_ALTRO })).toHaveCount(0);

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
