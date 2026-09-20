import { test, expect, type Page } from '@playwright/test';
import { STORAGE } from './fixtures';

test.use({ storageState: STORAGE.admin });

// ═════════════════════════════════════════════════════════════════════════════
// IL POPUP DEL MOVIMENTO — le quattro cose che SOLO un browser vero può misurare
//
// ─── 🔴 IL VINCOLO, SCRITTO QUI PERCHÉ NON SI AGGIRA ────────────────────────
//
// In locale il collaudo nel browser NON è praticabile, e non per pigrizia: il
// server di sviluppo legge `.env.local`, che punta al database di PRODUZIONE, e
// il middleware rinvia al login — quattro «verdi» già raccolti così erano la
// schermata di accesso fotografata quattro volte. Per la stessa ragione
// `npm run e2e` e `npm run e2e:seed` stanno in `deny`: un seed lanciato di qui
// scriverebbe fra le famiglie vere.
//
// La copertura vera di questo file è quindi l'E2E **in CI**, sulla sede
// fittizia `e2e00000-…`, contro il progetto Supabase separato della CI.
//
// ⚠️ E un job «verde» non basta a dire che è passato. `playwright.config.ts`
// dichiara `retries: 2` in CI: un job può contenere due fallimenti su tre
// tentativi e risultare «success». Questo file si legge dal PUNTO D'ARRESTO del
// rapporto — quale asserzione ha ceduto, al primo tentativo — non dall'ultima
// riga a schermo.
//
// ─── PERCHÉ QUESTE QUATTRO E NON ALTRE ──────────────────────────────────────
//
// `__tests__/components/MovimentoDialog.test.tsx` copre già, in jsdom, la
// STRUTTURA del popup: le tre fasce, il `max-w-[95%]` unico della sua famiglia,
// il `w-full` che ce la porta davvero, l'unico elemento che scorre. Ma jsdom non
// impagina: `getBoundingClientRect()` risponde zeri, e un test che asserisce una
// classe verifica che l'abbiamo SCRITTA, non che il piede sia raggiungibile.
//
// Le quattro qui sotto sono esattamente ciò che resta fuori da quella rete:
//   1. il popup misura almeno il 90% dello schermo ed è dentro il viewport sui
//      quattro lati (la decisione del titolare: ~95%, resta un popup);
//   2. scorrendo il corpo fino in fondo, «Chiudi» è visibile nel viewport — la
//      tesi che il vecchio tetto d'altezza difendeva per via indiretta, e che
//      nessun test unitario può dimostrare;
//   3. due colonne a 1440, una sola a 390 — un confronto fra RETTANGOLI, non fra
//      nomi di classi;
//   4. sul movimento ROSSO: si cerca il bambino per cognome, si compone sulla
//      sua voce aperta, e «Conferma il pagamento» si accende.
//
// ⚠️ IL QUARTO PASSAGGIO SI FERMA UN ISTANTE PRIMA DI PREMERE, ed è deliberato.
// Premere scriverebbe un incasso, una transazione di famiglia e un documento
// fiscale nel database della CI: stato che resta dietro, che il seed del run
// successivo non ripulisce (ripulisce i pagamenti dei suoi alunni, non le
// transazioni), e che renderebbe il run successivo diverso da questo. Si misura
// che il gate si apra, non che il denaro si muova: quello lo provano i test
// unitari di `conciliazione-registra`, dove `puoConfermare` è il gate UNICO.
//
// ⚠️ TRAPPOLA GIÀ PAGATA IN QUESTO REPO (2026-09-19, due spec insieme, 4 minuti
// × 3 tentativi ciascuno): un click su un bottone `aria-disabled="true"` NON
// fallisce — ATTENDE che diventi cliccabile, e muore nel timeout del test con un
// messaggio che parla del click e mai del campo che mancava. Qui «Conferma il
// pagamento» usa il `disabled` vero, ma la disciplina resta: `toBeEnabled()`
// PRIMA di qualunque click, e mai un click come sonda dello stato.
//
// ─── 🔴 IL RAMO DI DEGRADO, CHE NON È FACOLTATIVO ───────────────────────────
//
// `riconciliazione_import` e `riconciliazione_movimenti` NON sono nel baseline
// (`20260704120000`): le crea `20260710150000_contabilita_riconciliazione.sql`,
// una migrazione successiva. Il database su cui gira il job `e2e` è un progetto
// Supabase separato con `supabase_migrations.schema_migrations` vuoto, e
// `.github/workflows/migrate-ci.yml` è `workflow_dispatch`: si lancia a mano, un
// file per volta. Finché non lo si fa, quelle due tabelle lì non esistono, il
// seed lo dichiara e salta (`seminaRiconciliazione()`), e il pannello mostra
// «Riconciliazione non ancora disponibile».
//
// Questo file riconosce quella condizione DAL PRODOTTO, la DICHIARA nel rapporto
// Playwright e nei log della CI, e verifica ciò che resta vero comunque: che la
// vista si renda senza nessuna eccezione JS. Senza quel ramo, il primo push
// tingerebbe la CI di rosso per una ragione che non è il codice, e chi guarda
// cercherebbe il difetto dove non è.
//
// ⚠️ E il degrado NON si nasconde dietro un `test.skip()`: uno spec saltato
// sparisce dal conteggio e diventa indistinguibile da uno spec mai scritto.
// Resta, con le sue righe, e dice quale metà non ha potuto misurare.
// ═════════════════════════════════════════════════════════════════════════════

const RENDER = 30_000;

/**
 * LE ÀNCORE DEI TRE MOVIMENTI — ricopiate da `RICONCILIAZIONE_E2E` di
 * `scripts/seed-e2e.mjs`.
 *
 * ⚠️ Duplicazione DICHIARATA, non una svista: gli spec Playwright non importano
 * moduli `.mjs` dello stesso repo (è la stessa ragione scritta in testa a
 * `e2e/fixtures.ts` per la password e per la conversazione lunga). Le àncore
 * stanno qui e non in `fixtures.ts` perché le usa questo file soltanto, e
 * `fixtures.ts` è letto da tutta la suite. Se le due copie divergono, questo
 * spec cerca righe che nessuno ha seminato e diventa rosso su un prodotto sano.
 */
const MOVIMENTI = {
  /** Nessun identificativo in causale, nessun suggerimento: il caso da lavorare a mano. */
  rosso: { causale: 'BONIFICO E2E DA ABBINARE A MANO', importo: '€ 150,00' },
  giallo: { causale: 'BONIFICO E2E CON UN SUGGERIMENTO', importo: '€ 90,00' },
  verde: { causale: 'BONIFICO E2E GIA CONFERMATO', importo: '€ 25,00' },
};

/**
 * Il cognome di `IDS.A1` (Aurora Arcobaleno-E2E) e la descrizione della sua voce
 * aperta da 150 € (`IDS.PAG_APERTO`), che è l'importo esatto del movimento rosso.
 * È quella coincidenza a far quadrare la composizione nel quarto passaggio.
 */
const COGNOME_BAMBINO = 'Arcobaleno-E2E';
const DESCRIZIONE_VOCE = 'Retta E2E luglio';

/** Dichiara il degrado dove si vede: nel rapporto Playwright e nei log della CI. */
function dichiaraDegrado(motivo: string) {
  test.info().annotations.push({ type: 'DB E2E senza riconciliazione', description: motivo });
  console.warn(
    `[admin-riconciliazione-popup] ${motivo}. Il popup del movimento non è collaudato in ` +
      'questo run: applica `20260710150000_contabilita_riconciliazione.sql` al DB della CI ' +
      '(.github/workflows/migrate-ci.yml) e rilancia il seed per riaccenderlo.',
  );
}

type StatoRegistro = 'pronto' | 'assente' | 'vuoto';

/**
 * Apre il registro dei movimenti e dice in quale dei tre stati si trova, letto
 * DAL PRODOTTO e non dall'intenzione:
 *  · `pronto`  — la riga rossa del seed è a schermo: si può lavorare;
 *  · `assente` — «Riconciliazione non ancora disponibile»: le tabelle non ci sono;
 *  · `vuoto`   — le tabelle ci sono ma il seed non ha seminato (o la pulizia ha
 *                trovato un errore diverso dallo schema mancante).
 *
 * I tre sono distinti perché hanno rimedi diversi: il secondo è una migrazione
 * da applicare, il terzo è un seed da guardare. «Non si può collaudare» detto una
 * volta sola manderebbe a cercare nel posto sbagliato.
 *
 * L'ascoltatore di `pageerror` si registra PRIMA della navigazione: un'eccezione
 * lanciata durante il primo render è esattamente quella che si perderebbe
 * attaccandosi dopo.
 */
async function apriRegistro(page: Page): Promise<{ stato: StatoRegistro; erroriPagina: string[] }> {
  const erroriPagina: string[] = [];
  page.on('pageerror', (err) => erroriPagina.push(err.message));

  await page.goto('/admin/pagamenti?vista=riconciliazione');
  await expect(page.getByText('Riconciliazione bancaria').first()).toBeVisible({ timeout: RENDER });

  const riga = page.getByRole('button', { name: MOVIMENTI.rosso.causale });
  const assente = page.getByText('Riconciliazione non ancora disponibile');
  const vuoto = page.getByText('Nessun movimento: importa un estratto conto');

  // Si aspetta la PRESENZA di uno dei tre, mai l'assenza di un errore: un
  // `waitFor` su un'assenza è già vero mentre la richiesta è ancora in volo.
  // Il quarto caso — nessuno dei tre — è un registro che esiste, ha righe, e
  // NON ha le nostre: merita un rosso con un messaggio che lo dica.
  await expect(
    riga.or(assente).or(vuoto).first(),
    'il registro non mostra né la riga del seed, né «non disponibile», né lo stato vuoto: ' +
      'su questo database ci sono movimenti che il seed non ha scritto',
  ).toBeVisible({ timeout: RENDER });

  if (await riga.isVisible()) {
    /**
     * PRECONDIZIONE SUL SEME, non una quinta tesi: i tre colori ci sono tutti,
     * con il loro importo. `seminaRiconciliazione()` scrive le tre righe in un
     * `insert` solo, ma il database della CI è persistente e un run precedente
     * potrebbe averne lasciata una a metà. Con la sola riga rossa i quattro test
     * passerebbero lo stesso, e il semaforo del pannello risulterebbe collaudato
     * senza che nessuno abbia mai visto un giallo o un verde.
     */
    for (const m of [MOVIMENTI.rosso, MOVIMENTI.giallo, MOVIMENTI.verde]) {
      const suaRiga = page.getByRole('button', { name: m.causale });
      await expect(
        suaRiga,
        `manca il movimento «${m.causale}»: il seme della riconciliazione è incompleto`,
      ).toHaveCount(1);
      await expect(
        suaRiga,
        `il movimento «${m.causale}» non mostra più ${m.importo}: seed e spec sono divergenti`,
      ).toContainText(m.importo);
    }
    return { stato: 'pronto', erroriPagina };
  }
  if (await assente.isVisible()) return { stato: 'assente', erroriPagina };
  return { stato: 'vuoto', erroriPagina };
}

/**
 * Il preambolo comune ai quattro test: o il registro è pronto, o si dichiara il
 * degrado e si verifica ciò che resta vero — che lo stato vuoto sia uno stato
 * vuoto e non un crash.
 */
async function registroPronto(page: Page): Promise<boolean> {
  const { stato, erroriPagina } = await apriRegistro(page);
  if (stato === 'pronto') return true;

  dichiaraDegrado(
    stato === 'assente'
      ? 'il pannello dichiara «Riconciliazione non ancora disponibile»: le due tabelle non esistono su questo database'
      : 'il registro esiste ma è vuoto: il seed non ha potuto scrivere i tre movimenti (guarda l’avviso «↷ riconciliazione …» nel log del seed)',
  );
  expect(
    erroriPagina,
    'la degradazione deve essere uno stato vuoto reso con grazia, mai un’eccezione JS non catturata',
  ).toEqual([]);
  return false;
}

/** Apre il popup di un movimento cliccando la sua riga, e restituisce il dialogo. */
async function apriMovimento(page: Page, causale: string) {
  const riga = page.getByRole('button', { name: causale });
  // Positiva e PRIMA del click: con due righe che portano la stessa causale il
  // click morirebbe per strict mode, e il messaggio parlerebbe del click invece
  // che del seme che ha prodotto un doppione.
  await expect(riga, `nel registro deve esserci una sola riga «${causale}»`).toHaveCount(1);
  await riga.click();

  const dialogo = page.getByRole('dialog');
  await expect(dialogo).toBeVisible({ timeout: RENDER });
  return dialogo;
}

test('1/4 · a 1440×900 il popup occupa almeno il 90% dello schermo e ci sta dentro su tutti e quattro i lati', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  if (!(await registroPronto(page))) return;

  const dialogo = await apriMovimento(page, MOVIMENTI.rosso.causale);

  // La cifra in testa È il movimento che si è aperto: senza questa riga il
  // riquadro misurato potrebbe essere di un popup qualunque.
  await expect(dialogo.getByRole('heading', { name: MOVIMENTI.rosso.importo })).toBeVisible();

  const schermo = page.viewportSize();
  expect(schermo, 'il viewport è stato appena dichiarato: qui non può essere nullo').not.toBeNull();
  const riquadro = await dialogo.boundingBox();
  expect(riquadro, 'il popup è visibile ma non ha un riquadro: non è impaginato').not.toBeNull();
  if (!schermo || !riquadro) return;

  /**
   * ⚠️ IL 90% È LA SOGLIA, NON LA MISURA. La decisione del titolare è «~95%,
   * margine sottile, resta un popup», e il prodotto la realizza con
   * `max-w-[95%]` + `h-[95dvh]` DENTRO il `p-4` (o la safe-area) del
   * contenitore: il 95% di ciò che resta tolta l'imbottitura, non il 95% dello
   * schermo. A 1440×900 fa ~1338×855. Pretendere qui il 95% esatto vorrebbe dire
   * riscrivere quell'aritmetica in un secondo posto — e il giorno in cui la
   * safe-area cambia su un telefono, i due numeri divergerebbero in silenzio.
   * Il 90% è il confine fra «quasi a tutto schermo» e il `max-w-lg` da 512px da
   * cui questo lavoro è nato: quello lo si vede, e lo si vede su qualunque
   * imbottitura.
   */
  expect(
    riquadro.width,
    'il popup è tornato una card stretta: è il difetto da cui nasce tutto questo lavoro (512px su un monitor da 2560)',
  ).toBeGreaterThanOrEqual(schermo.width * 0.9);
  expect(
    riquadro.height,
    'il popup non arriva più in fondo allo schermo: il tetto in `dvh` è stato tolto o sovrascritto',
  ).toBeGreaterThanOrEqual(schermo.height * 0.9);

  // …e i quattro lati. Un popup largo il 95% ma spostato di 200px è largo
  // uguale e per metà fuori: la larghezza da sola non dice dove sta.
  expect(riquadro.x, 'il popup sborda a sinistra').toBeGreaterThanOrEqual(0);
  expect(riquadro.y, 'il popup sborda in alto').toBeGreaterThanOrEqual(0);
  expect(riquadro.x + riquadro.width, 'il popup sborda a destra').toBeLessThanOrEqual(schermo.width);
  expect(riquadro.y + riquadro.height, 'il popup sborda in basso').toBeLessThanOrEqual(schermo.height);
});

test('2/4 · scorrendo il corpo fino in fondo, «Chiudi» resta dentro il viewport', async ({ page }) => {
  // 390×844 e non 1440×900: è il telefono, cioè l'unico formato in cui il corpo
  // del popup trabocca di sicuro su un movimento da abbinare (causale, pulsante
  // «Componi», ricerca, due gruppi di risultati). Su un monitor grande il
  // contenuto potrebbe entrarci tutto, lo scorrimento sarebbe un non-gesto e
  // l'asserzione che segue sarebbe verde senza aver misurato niente.
  await page.setViewportSize({ width: 390, height: 844 });
  if (!(await registroPronto(page))) return;

  await apriMovimento(page, MOVIMENTI.rosso.causale);

  const corpo = page.getByTestId('movdlg-corpo');
  const scorrimento = await corpo.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return { top: el.scrollTop, visibile: el.clientHeight, contenuto: el.scrollHeight };
  });

  /**
   * ⚠️ LE DUE RIGHE CHE IMPEDISCONO IL VERDE A VUOTO, e vengono prima della tesi.
   * Se il corpo non trabocca, lo `scrollTop` resta 0, non si è scorso niente e
   * «Chiudi è ancora visibile» è vero per il motivo sbagliato — sarebbe la
   * quinta forma di verde falso di `.claude/rules/test.md`, il test che non può
   * fallire. Si dichiara prima che c'era davvero qualcosa da scorrere.
   */
  expect(
    scorrimento.contenuto,
    'il corpo del popup non trabocca: non c’è niente da scorrere, e la tesi qui sotto non sarebbe misurata',
  ).toBeGreaterThan(scorrimento.visibile);
  expect(
    scorrimento.top,
    'il corpo non si è mosso: se a scorrere è la card intera, testa e piede se ne vanno con lei',
  ).toBeGreaterThan(0);

  /**
   * LA TESI. «Chiudi» del PIEDE, non la ✕ della testa: sono due comandi diversi
   * e il prodotto li chiama apposta in due modi («Chiudi» e «Chiudi il
   * movimento»), perché due bottoni con lo stesso nome accessibile nella stessa
   * finestra non si distinguono. `exact` e l'ambito del piede tengono ferme
   * tutt'e due le cose, e anche il terzo omonimo — il «Chiudi» del pannello di
   * composizione, che qui non è aperto ma lo sarà nel quarto test.
   *
   * `ratio: 1` e non il difetto (`> 0`): «visibile nel viewport» significa
   * INTERO. Un bottone di cui sporge una riga di pixel è un bottone che una
   * persona vede a metà e non sa se può premere.
   */
  const chiudi = page.getByTestId('movdlg-piede').getByRole('button', { name: 'Chiudi', exact: true });
  await expect(
    chiudi,
    'scorso il corpo fino in fondo, «Chiudi» deve restare nel viewport: è la via d’uscita del popup',
  ).toBeInViewport({ ratio: 1 });
});

test('3/4 · il popup ha due colonne a 1440 e una sola a 390', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  if (!(await registroPronto(page))) return;

  await apriMovimento(page, MOVIMENTI.rosso.causale);

  /**
   * Il FATTO (ciò che la banca ha mandato) e il LAVORO (suggerimenti,
   * composizione, ricerca). Il primo è l'`<aside>` etichettato «Movimento del
   * …», cioè una `region` di ruolo `complementary`: si cerca per RUOLO e NOME,
   * che è come lo trova anche chi naviga con un lettore di schermo — e se un
   * giorno quell'etichetta sparisse, questo test lo direbbe.
   */
  const fatto = page.getByRole('complementary', { name: /Movimento del/ });
  const lavoro = page.getByTestId('movdlg-lavoro');
  await expect(fatto).toBeVisible();
  await expect(lavoro).toBeVisible();

  /**
   * Il confronto è fra RETTANGOLI, e qui sta il valore di questo test: in jsdom
   * `getBoundingClientRect()` risponde zeri, quindi là l'unica prova possibile è
   * che la classe `lg:grid-cols-[…]` sia scritta — cioè che l'abbiamo scritta,
   * non che il browser la applichi. Un `@media` sbagliato, una variante che un
   * giorno non viene più generata, un `min-w-0` tolto: tutto questo lascia la
   * classe al suo posto e cambia l'impaginazione.
   *
   * `expect.poll` e non una misura secca: dopo un cambio di viewport il layout
   * si riassesta, e leggere i due riquadri nell'istante sbagliato darebbe un
   * rosso intermittente su un prodotto sano.
   */
  const disposizione = async (): Promise<'affiancate' | 'impilate' | 'ignota'> => {
    const a = await fatto.boundingBox();
    const b = await lavoro.boundingBox();
    if (!a || !b) return 'ignota';
    if (b.x >= a.x + a.width) return 'affiancate';
    if (b.y >= a.y + a.height) return 'impilate';
    return 'ignota';
  };

  await expect
    .poll(disposizione, {
      message: 'a 1440 il fatto e il lavoro devono stare affiancati: è il motivo per cui il popup è stato allargato',
      timeout: RENDER,
    })
    .toBe('affiancate');

  await page.setViewportSize({ width: 390, height: 844 });

  /**
   * Sotto `lg` la colonna è una sola, e l'`aside` viene PRIMO — nell'ordine in
   * cui sta scritto, senza `order-*`: un ordine visuale diverso da quello di
   * tabulazione è un difetto di accessibilità (WCAG 1.3.2). Chiedere «impilate»
   * e non solo «non affiancate» è ciò che tiene ferma anche quella scelta: se il
   * lavoro finisse SOPRA il fatto, questa riga diventerebbe `ignota`.
   */
  await expect
    .poll(disposizione, {
      message: 'a 390 le due regioni devono impilarsi, col fatto sopra e il lavoro sotto',
      timeout: RENDER,
    })
    .toBe('impilate');
});

test('4/4 · sul movimento rosso si cerca il bambino, si compone sulla sua voce aperta e «Conferma» si accende', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  if (!(await registroPronto(page))) return;

  await apriMovimento(page, MOVIMENTI.rosso.causale);

  // ── 1 · Il bambino si cerca per COGNOME, dalla rotta che non fa uscire il CF ──
  //
  // La casella cerca fra i pagamenti aperti E fra i bambini (rotta
  // `…/riconciliazione/alunni`, soglia di due caratteri e un respiro di 300 ms):
  // il nome accessibile è rimasto quello con cui è documentata da mesi, e la
  // seconda capacità la dice la descrizione sotto.
  await page
    .getByRole('textbox', { name: 'Cerca un pagamento aperto da abbinare' })
    .fill(COGNOME_BAMBINO);

  // ── 2 · «Componi per questo bambino» ────────────────────────────────────────
  const componi = page.getByRole('button', { name: 'Componi per questo bambino' });
  await expect(
    componi,
    `la ricerca per «${COGNOME_BAMBINO}» deve trovare un solo bambino: con due, il click sarebbe ambiguo`,
  ).toHaveCount(1);
  // ⚠️ `toBeEnabled()` PRIMA del click, sempre: vedi la trappola dichiarata in
  // testa a questo file. Un click su un bottone spento non fallisce, ASPETTA.
  await expect(componi).toBeEnabled();
  await componi.click();

  // ── 3 · Il pannello di composizione, puntato su quel bambino ────────────────
  await expect(page.getByText('Voci aperte della famiglia')).toBeVisible({ timeout: RENDER });

  const conferma = page.getByRole('button', { name: 'Conferma il pagamento' });
  await expect(conferma).toBeVisible();

  /**
   * ⚠️ SPENTO PRIMA, ACCESO DOPO — e la prima metà non è un di più.
   *
   * Un `toBeEnabled()` su un pulsante che era GIÀ acceso non misura la spunta:
   * misura sé stesso, ed è il mock piatto di `.claude/rules/test.md` travestito
   * da asserzione d'interfaccia. Con nessuna voce spuntata la somma delle righe
   * è 0 e l'importo del bonifico è 150,00: `puoConfermare` dice no, e il motivo
   * è a schermo. Questa riga è ciò che rende la prossima una misura.
   */
  await expect(
    conferma,
    'senza nessuna voce spuntata la composizione non quadra: se «Conferma» fosse già acceso qui, l’asserzione finale non misurerebbe la spunta',
  ).toBeDisabled();

  // ── 4 · Si sceglie la voce aperta ───────────────────────────────────────────
  //
  // La casella porta il nome della sua etichetta: descrizione, bambino e residuo.
  // Si cerca per DESCRIZIONE — il residuo è un importo formattato e il nome del
  // bambino cambierebbe forma il giorno in cui la rotta minimizza di più.
  const spunta = page.getByRole('checkbox', { name: new RegExp(DESCRIZIONE_VOCE) });
  await expect(
    spunta,
    `il bambino deve avere una sola voce aperta «${DESCRIZIONE_VOCE}»: è quella che fa quadrare i 150,00 del bonifico`,
  ).toHaveCount(1);
  await spunta.check();

  // ── 5 · IL GATE SI APRE ─────────────────────────────────────────────────────
  //
  // ⚠️ E QUI CI SI FERMA. Premere scriverebbe un incasso vero nel database della
  // CI: vedi la testata. Ciò che si misura è che il gate unico (`puoConfermare`,
  // più il pagante e la sede del documento) si sia aperto — non che il denaro si
  // muova, che è collaudato dove si decide.
  await expect(
    conferma,
    'spuntata la voce da 150,00 la composizione quadra, il pagante è l’unico genitore collegato e la sede è una sola: «Conferma» deve accendersi',
  ).toBeEnabled();
});
