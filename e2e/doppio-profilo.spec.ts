import { test, expect } from '@playwright/test';
import { DOPPIO_PROFILO_E2E, IDS, STORAGE } from './fixtures';

/* ═══════════════════════════════════════════════════════════════════════════
 * IL PROFILO DOPPIO — l'insegnante che è anche genitore di un bambino iscritto.
 *
 * ─── PERCHÉ QUESTO FILE ESISTE, E PERCHÉ PRIMA NON POTEVA ──────────────────
 *
 * Il doppio profilo era già nel seed, ma il suo unico figlio (`A3`, Clara) stava
 * in `SEC_TULIPANI`, cioè **nella sezione che lui stesso insegna**. Conseguenza:
 * qualunque asserzione sul doppio profilo era verde perché il DOCENTE vede la
 * propria classe, non perché il GENITORE vede suo figlio — e restava verde anche
 * con il gate della famiglia completamente rotto. Un test che non può fallire non
 * è un test.
 *
 * Il seed ora produce i due casi che in produzione esistono davvero (misurati il
 * 2026-09-01: **cinque** persone con riga `utenti` da personale e ponte
 * `parents.auth_user_id`; **sei** dei loro legami cadono fuori dalle sezioni che
 * insegnano e **uno** è in un'altra sede):
 *
 *   · `A5` — sezione «Margherite» della SUA sede, che lui non insegna;
 *   · `B2` — sezione «Margherite» dell'ALTRA sede, dove non ha né sezioni né
 *            `utenti_scuole`.
 *
 * ─── QUALI TEST DIVENTANO ROSSI COL CODICE DI IERI ─────────────────────────
 *
 * (Ricostruito leggendo `conRuoloAttivo` in `src/lib/auth/require-staff.ts` e
 * `risolviRuoloAttivo` in `src/lib/auth/active-role.ts`, non l'intenzione del
 * piano: il piano dava per scontato che la veste di genitore bastasse a mostrare
 * la differenza, e non basta.)
 *
 * Prima della correzione del 2026-09-01 `requireParentOfStudent` biforcava sul
 * ruolo ATTIVO (`auth.user.role === 'genitore'`) e non sul LEGAME. ⚠️ Ma il ruolo
 * attivo di chi ha due profili è quello del cookie `kv-active-role`, quindi
 * **nella veste di genitore anche il codice vecchio rispondeva 200**: entrava nel
 * ramo di famiglia, trovava il legame e apriva. I test del primo blocco qui sotto
 * sono verdi con entrambe le versioni, e non sono loro la prova.
 *
 * La differenza si vede dove la veste NON è `genitore`, cioè:
 *  · in veste di DOCENTE (terzo blocco);
 *  · SENZA veste dichiarata (secondo blocco) — cookie assente, estraneo o
 *    scaduto: `risolviRuoloAttivo` non decide e si ricade su `utenti.ruolo`, che
 *    per queste persone è `educator`. È lo stato in cui le cinque persone vere si
 *    trovavano: nell'app non esiste ancora un comando per cambiare veste, quindi
 *    la sola via era uscire e rientrare scegliendo «Genitore».
 *
 * In quei due stati il codice vecchio saltava il ramo di famiglia, finiva su
 * `assertAlunnoInScope` — che confronta `utenti_sezioni`, cioè le classi che
 * INSEGNA — e rispondeva `403 «Alunno non nella tua classe»` sul registro del
 * figlio. È il criterio con cui questo file va giudicato: **il secondo e il terzo
 * blocco devono essere ROSSI con 403 sul codice precedente.** Il primo blocco
 * misura un'altra cosa (che la veste di famiglia continui a funzionare, e con
 * quali dati), e va tenuto per quella.
 *
 * ─── LE REGOLE DI SCRITTURA (le stesse di `isolamento-sedi.spec.ts`) ───────
 *
 *  · niente asserzioni-fantoccio: si asserisce lo stato ESATTO e il CONTENUTO,
 *    mai «non è 403». Sulla galleria in particolare: `status() === 200` è verde
 *    anche su `{media: [], total: 0}`, che è il difetto peggiore di quella rotta
 *    perché a schermo somiglia a «non ci sono ancora foto»;
 *  · ogni asserzione NEGATIVA è preceduta da una POSITIVA sulla stessa vista;
 *  · le àncore sono DATO DEL SEED (`DOPPIO_PROFILO_E2E`), mai frasi di catalogo:
 *    in questo repo due riscritture editoriali — i puntini `...` → `…` e
 *    l'apostrofo dritto → tipografico — hanno reso rossi degli spec su un
 *    prodotto sano.
 * ═══════════════════════════════════════════════════════════════════════════ */

// La CI E2E gira su `next dev`: queste pagine compilano a freddo e sotto carico
// runner superano i 30s. Timeout generosi, semantica invariata.
const RENDER = 60_000;
const AZIONE = 20_000;

/**
 * Oggi NEL FUSO DELL'ISTITUTO, come lo calcola `scripts/seed-e2e.mjs`.
 *
 * ⚠️ NON `new Date().toISOString().slice(0,10)`. Il runner di Playwright è un
 * processo Node, e in CI gira in UTC: fra la mezzanotte e le due italiane
 * quell'espressione restituisce IERI, mentre il seed ha scritto il menu di OGGI
 * con `Intl` su `Europe/Rome`. Il `timezoneId: 'Europe/Rome'` di
 * `playwright.config.ts` vale per il BROWSER, non per questo file. È la trappola
 * che il 2026-08-09 ha reso rosso `admin-dashboard.spec.ts` tre volte di fila su
 * un prodotto sano: un banco di prova che vive in un altro fuso dal prodotto
 * misura un altro prodotto.
 */
function oggiRoma(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
}

/** Una voce di diario come la restituisce `GET /api/diary/entries?alunno_id=`. */
interface VoceDiario {
  id: string;
  tipo_evento: string;
  note: string | null;
}

/** Una riga di galleria come la restituisce `GET /api/gallery?studentId=`. */
interface MediaGalleria {
  id: string;
  caption: string | null;
}

/** Il menu di un giorno come lo restituisce `GET /api/mensa/menu`. */
interface GiornoMensa {
  data: string;
  portate: { primo?: string } | null;
}

// ═════════════════════════════════════════════════════════════════════════════
// VESTE DI GENITORE — cookie `kv-active-role=genitore`, scritto dal picker del
// login (non a mano: vedi il commento in `auth.setup.ts`).
// ═════════════════════════════════════════════════════════════════════════════
test.describe('profilo doppio, veste di GENITORE', () => {
  test.use({ storageState: STORAGE.doppioGenitore });

  // ── 1. Il diario del figlio FUORI SEZIONE ─────────────────────────────────
  test('il diario del figlio fuori dalle sue sezioni si apre e ha contenuto', async ({ page }) => {
    test.setTimeout(150_000);

    // (a) La rotta, con lo stato ESATTO. Con la biforcazione sul ruolo attivo —
    //     quella in vigore fino al 2026-09-01 — qui arrivava 403 «Alunno non
    //     nella tua classe», perché `assertAlunnoInScope` confronta
    //     `utenti_sezioni`, cioè le classi che INSEGNA, che col figlio non
    //     c'entrano niente.
    const risposta = await page.request.get(`/api/diary/entries?alunno_id=${IDS.A5}`);
    expect(risposta.status()).toBe(200);

    // E il CONTENUTO, non solo lo stato: un 200 con l'elenco vuoto sarebbe
    // indistinguibile da «il diario di oggi non ha voci», e il seed una voce
    // gliela mette apposta.
    const voci = (await risposta.json()) as VoceDiario[];
    expect(voci.map((v) => v.note)).toContain(DOPPIO_PROFILO_E2E.notaDiarioA5);

    // (b) E la pagina che quella rotta alimenta. `?id=` è il parametro con cui
    //     `useParentIdentity` sceglie il figlio attivo (`getCurrentStudentId`),
    //     e viene RIVALIDATO contro `/api/parent/students`: se il legame non ci
    //     fosse, la pagina ripiegherebbe sull'altro figlio e questa asserzione
    //     misurerebbe il bambino sbagliato.
    await page.goto(`/parent/diary?id=${IDS.A5}`);
    await expect(page.getByRole('heading', { name: 'Il mio diario' })).toBeVisible({ timeout: RENDER });
    await expect(page.getByText(DOPPIO_PROFILO_E2E.notaDiarioA5)).toBeVisible({ timeout: RENDER });
  });

  // ── 2. La galleria del figlio dell'ALTRA SEDE ─────────────────────────────
  test('la galleria del figlio dell’altra sede ha contenuto, non è una lista vuota', async ({ page }) => {
    test.setTimeout(150_000);

    const risposta = await page.request.get(`/api/gallery?studentId=${IDS.B2}&limit=12&offset=0`);
    expect(risposta.status()).toBe(200);

    const corpo = (await risposta.json()) as { media: MediaGalleria[]; total: number };
    const didascalie = corpo.media.map((m) => m.caption);

    // POSITIVO per primo: c'è la foto del PROPRIO figlio, quella della sede 2.
    expect(didascalie).toContain(DOPPIO_PROFILO_E2E.fotoSede2);
    expect(corpo.total).toBeGreaterThan(0);

    // NEGATIVO dopo: non esce la foto dell'ALTRO figlio, che sta nell'altra sede
    // e non è taggato qui.
    //
    // ⚠️ QUESTA RIGA NON PROVA L'ISOLAMENTO PER SEDE, e va detto invece di
    // lasciarlo credere. I due media del seed sono TAGGATI sul singolo bambino e
    // nessuno dei due è `is_broadcast`: a tenerli separati basta il filtro sui
    // tag. Una sonda vera dell'isolamento vorrebbe un media `is_broadcast` nella
    // sede 1 — e sarebbe un FALSO ROSSO in CI, perché là
    // `galleria_media_v2.scuola_id` non esiste (migrazione post-baseline) e la
    // rotta degrada legittimamente a «nessun filtro di sede». L'isolamento della
    // galleria si misura dove è misurabile: nei test unitari di `gallery-scope`.
    expect(didascalie).not.toContain(DOPPIO_PROFILO_E2E.fotoSede1);

    // E la pagina la disegna davvero.
    await page.goto(`/parent/gallery?id=${IDS.B2}`);
    // La didascalia esiste nel DOM SOLO dentro una tile della griglia: lo stato
    // vuoto non la contiene. È questo che la rende un'asserzione sul CONTENUTO e
    // non sull'impaginazione — non che la didascalia sia leggibile (sta nel velo
    // che compare al passaggio del mouse, e Playwright considera visibile anche
    // ciò che ha `opacity: 0`).
    await expect(page.getByText(DOPPIO_PROFILO_E2E.fotoSede2).first()).toBeVisible({ timeout: RENDER });
  });

  // ── 3. La mensa segue la sede del FIGLIO ──────────────────────────────────
  test('la mensa del figlio dell’altra sede mostra il menu della SUA sede', async ({ page }) => {
    const oggi = oggiRoma();

    const risposta = await page.request.get(
      `/api/mensa/menu?alunno_id=${IDS.B2}&from=${oggi}&to=${oggi}`,
    );
    expect(risposta.status()).toBe(200);
    const corpo = (await risposta.json()) as { success: boolean; data: GiornoMensa[] };
    const primo = corpo.data.find((g) => g.data === oggi)?.portate?.primo;

    // Il genitore-docente ha `utenti.scuola_id` = sede 1 e il figlio sta nella
    // sede 2: due primi DIVERSI nello stesso giorno sono l'unico modo di vedere
    // dalla RISPOSTA quale delle due sedi ha deciso il menu. Con lo stato da solo
    // le due implementazioni sono indistinguibili — rispondono entrambe 200.
    expect(primo).toBe(DOPPIO_PROFILO_E2E.primoSede2);
    expect(primo).not.toBe(DOPPIO_PROFILO_E2E.primoSede1);

    // Specularità: l'altro figlio, stessa richiesta, l'altro menu. Senza questo
    // verso, un server che rispondesse sempre «sede 2» passerebbe la riga sopra.
    const rispostaA5 = await page.request.get(
      `/api/mensa/menu?alunno_id=${IDS.A5}&from=${oggi}&to=${oggi}`,
    );
    expect(rispostaA5.status()).toBe(200);
    const corpoA5 = (await rispostaA5.json()) as { data: GiornoMensa[] };
    expect(corpoA5.data.find((g) => g.data === oggi)?.portate?.primo)
      .toBe(DOPPIO_PROFILO_E2E.primoSede1);

    // ⚠️ NIENTE ASSERZIONE SULLA PAGINA `/parent/mensa`, e non è una dimenticanza.
    // `MensaCalendar` chiede la settimana di `lunediDella(new Date())` calcolata
    // con `toISOString()`, cioè in UTC: fra la mezzanotte e le due italiane di un
    // LUNEDÌ la settimana mostrata è quella precedente, e il menu di oggi non è a
    // schermo. Sarebbe un rosso di calendario su un prodotto che, lato server, ha
    // appena risposto giusto. La sede del menu è comunque una decisione del
    // SERVER, e qui è misurata dove viene presa.
  });

  // ── 6. La veste di famiglia non ha allargato NIENTE ───────────────────────
  test('un bambino che non è suo figlio resta 403 anche in veste di genitore', async ({ page }) => {
    // POSITIVO prima del negativo, con la STESSA sessione: se il 403 qui sotto
    // arrivasse perché la sessione è scaduta, questa riga cadrebbe per prima e si
    // saprebbe subito che il test non sta misurando ciò che dice.
    const suo = await page.request.get(`/api/diary/entries?alunno_id=${IDS.A5}`);
    expect(suo.status()).toBe(200);

    // `A1` (Aurora) è nella sezione «Girasoli» della sede 1: non è sua figlia e
    // non è in una sezione che insegna. In veste di famiglia il rifiuto è
    // definitivo — è il tentativo che `alunno-non-della-famiglia` conta.
    const altrui = await page.request.get(`/api/diary/entries?alunno_id=${IDS.A1}`);
    expect(altrui.status()).toBe(403);
    expect(await altrui.text()).not.toContain('Arcobaleno');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SENZA VESTE DICHIARATA — il caso in cui le cinque persone vere si trovavano.
//
// Stessa sessione del blocco precedente, meno il cookie `kv-active-role`. Non è
// uno stato inventato per far fallire qualcosa: è quello di chi ha due profili e
// (a) non ha ancora scelto, (b) ha il cookie scaduto — dura 180 giorni — oppure
// (c) ha reinstallato l'app. Con due ruoli e nessuna scelta valida
// `risolviRuoloAttivo` restituisce `null` e si ricade su `utenti.ruolo`, che per
// queste persone è `educator`.
//
// È lo stato normale, non l'eccezione, finché nell'app non esiste un comando per
// cambiare veste (vedi i `test.fixme` in fondo): l'unico modo di indossare quella
// di genitore è uscire e rientrare.
//
// 🔴 QUESTO BLOCCO È LA PROVA CHE IL BANCO SA FALLIRE. Col codice precedente al
// 2026-09-01 — biforcazione sul ruolo attivo — qui arrivava
// `403 «Alunno non nella tua classe»` sul registro del proprio figlio.
// ═════════════════════════════════════════════════════════════════════════════
test.describe('profilo doppio, NESSUNA veste dichiarata', () => {
  test.use({ storageState: STORAGE.doppioGenitore });

  test.beforeEach(async ({ context }) => {
    // Si toglie SOLO il ruolo attivo: la sessione Supabase resta, altrimenti si
    // collauderebbe la pagina di login. Stessa tecnica di
    // `admin-scelta-sede.spec.ts`, che al suo admin toglie `sedi_attive`.
    await context.clearCookies({ name: 'kv-active-role' });
  });

  test('il diario del proprio figlio si apre lo stesso: la famiglia non dipende dal cookie', async ({ page }) => {
    // Figlio nella SUA sede ma in una sezione che non insegna — i sei casi reali.
    const inSede = await page.request.get(`/api/diary/entries?alunno_id=${IDS.A5}`);
    expect(inSede.status()).toBe(200);
    const voci = (await inSede.json()) as VoceDiario[];
    expect(voci.map((v) => v.note)).toContain(DOPPIO_PROFILO_E2E.notaDiarioA5);

    // Figlio in un ALTRO plesso — il caso reale, uno solo, ed è il più lontano
    // da qualunque scope di lavoro: `assertAlunnoInScope` lo negava per la SEDE
    // prima ancora che per la sezione.
    const altraSede = await page.request.get(`/api/diary/entries?alunno_id=${IDS.B2}`);
    expect(altraSede.status()).toBe(200);
  });

  test('e i bambini che non sono suoi figli restano fuori, come sempre', async ({ page }) => {
    // La controprova che il rimedio non è «apri a tutti». `A1` è nella sezione
    // «Girasoli» della sua stessa sede: non è sua figlia e non è una sua classe.
    const altrui = await page.request.get(`/api/diary/entries?alunno_id=${IDS.A1}`);
    expect(altrui.status()).toBe(403);

    // E la propria sezione continua ad aprirsi: il mestiere è intatto.
    const suaClasse = await page.request.get(`/api/diary/entries?alunno_id=${IDS.A3}`);
    expect(suaClasse.status()).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// VESTE DI DOCENTE — stessa identità, altro cookie. Cambia UNA cosa sola.
//
// 🔴 Anche questo blocco è ROSSO col codice precedente, per la stessa ragione:
// `auth.user.role` vale `educator`, la biforcazione sul ruolo attivo non entrava
// nel ramo di famiglia e il diario del figlio finiva su `assertAlunnoInScope`.
// ═════════════════════════════════════════════════════════════════════════════
test.describe('profilo doppio, veste di DOCENTE', () => {
  test.use({ storageState: STORAGE.doppioDocente });

  test('il figlio resta accessibile anche in veste di lavoro (la famiglia è del DATABASE)', async ({ page }) => {
    // `eFamiglia` legge i ruoli REALI, `agisceComeGenitore` il cookie: i due
    // danno risposte diverse sulla stessa persona, ed è il punto della
    // biforcazione. Qui la veste dice «docente» e il legame dice «è tuo figlio»:
    // vince il legame, in entrambe le sedi.
    const inSede = await page.request.get(`/api/diary/entries?alunno_id=${IDS.A5}`);
    expect(inSede.status()).toBe(200);

    const altraSede = await page.request.get(`/api/diary/entries?alunno_id=${IDS.B2}`);
    expect(altraSede.status()).toBe(200);

    // E la galleria del figlio dell'altra sede NON si svuota. È il difetto che
    // stava esattamente qui: il gate concedeva il permesso (legame) e poi
    // `gallery:GET` intersecava la sede del bambino con quelle SELEZIONATE
    // dall'operatore — insiemi disgiunti, `plessi = []`, **200 con `media: []`**.
    // Nessun errore, nessun log: solo una galleria vuota che sembra normale.
    const galleria = await page.request.get(`/api/gallery?studentId=${IDS.B2}&limit=12&offset=0`);
    expect(galleria.status()).toBe(200);
    const corpo = (await galleria.json()) as { media: MediaGalleria[]; total: number };
    expect(corpo.media.map((m) => m.caption)).toContain(DOPPIO_PROFILO_E2E.fotoSede2);
  });

  test('il mestiere non si è allargato: un bambino di un’altra sezione resta 403', async ({ page }) => {
    // POSITIVO sulla stessa sessione: la propria sezione si apre.
    // `A3` (Clara) è in «Tulipani», che è la sezione del doppio in
    // `utenti_sezioni` — e NON è più sua figlia: il legame è stato tolto dal seed
    // proprio perché rendeva questo test incapace di fallire.
    const suaClasse = await page.request.get(`/api/diary/entries?alunno_id=${IDS.A3}`);
    expect(suaClasse.status()).toBe(200);

    // NEGATIVO: «Girasoli» non è una sua sezione, e il ponte `parents` non gli
    // concede niente su un bambino che non è suo figlio.
    const altraSezione = await page.request.get(`/api/diary/entries?alunno_id=${IDS.A1}`);
    expect(altraSezione.status()).toBe(403);

    // E l'altra sede, che è il confine più largo.
    const altraSede = await page.request.get(`/api/diary/entries?alunno_id=${IDS.B1}`);
    expect(altraSede.status()).toBe(403);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * LO SWITCH DI PROFILO — scritto ora, spento finché la UI non esiste.
 *
 * ─── STATO MISURATO IL 2026-09-01 ──────────────────────────────────────────
 *
 * `grep -rn "Cambia profilo\|Passa a Docente\|Passa a Genitore\|cambiaProfilo"`
 * su `src/` e `messages/` non trova NIENTE: l'unico modo di scegliere una veste
 * è il picker del login (`role-routing.spec.ts`), e cambiarla dopo richiede di
 * uscire e rientrare. La rotta che scrive il cookie esiste già
 * (`POST /api/auth/active-role`, che valida il ruolo contro quelli reali): manca
 * il comando dentro l'app.
 *
 * ─── PERCHÉ SONO `test.fixme` E NON ASSERZIONI ─────────────────────────────
 *
 * Il test 7 in particolare — «l'educator puro non vede “Cambia profilo”» — se
 * scritto come `toHaveCount(0)` sarebbe VERDE oggi, e verde per il motivo
 * peggiore: non esiste nessuna voce di menu da non trovare. Diventerebbe una
 * guardia che dorme, e il giorno in cui la voce comparisse per tutti e 617 gli
 * utenti con un ruolo solo, nessuno lo saprebbe. Un'asserzione negativa su una
 * UI che non c'è non è un controllo: è un placebo.
 *
 * ─── I SELETTORI ATTESI (dichiarati, non inventati a caso) ─────────────────
 *
 * Sono nomi ACCESSIBILI, coerenti con il resto del repo (il picker del login è
 * `getByRole('group', { name: 'Scelta del ruolo' })` con bottoni «Docente» e
 * «Genitore»). Chi implementerà la UI li rispetti, o cambi queste tre righe:
 *
 *   · comando nel menu     `page.getByRole('button', { name: 'Cambia profilo' })`
 *   · voce «vai a docente»  `page.getByRole('menuitem', { name: 'Passa a Docente' })`
 *   · voce «vai a genitore» `page.getByRole('menuitem', { name: 'Passa a Genitore' })`
 *   · chip in AppBar        `page.getByTestId('chip-ruolo-attivo')`
 *
 * Il requisito che nessun selettore può esprimere, e che va tenuto: lo switch
 * NON deve passare da `/auth/login`. Rifare il login funzionerebbe e sarebbe
 * inaccettabile — è ciò che queste persone fanno oggi, ed è il motivo per cui la
 * funzione va scritta.
 * ═══════════════════════════════════════════════════════════════════════════ */
test.describe('switch di profilo senza rifare il login', () => {
  test.use({ storageState: STORAGE.doppioGenitore });

  test.fixme('da /parent si passa a Docente senza passare dal login', async ({ page }) => {
    await page.goto('/parent');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: RENDER });

    // Nessun passaggio da `/auth/login`: si sorveglia la navigazione, non solo
    // l'URL finale. Un redirect al login seguito da un ritorno automatico
    // lascerebbe l'URL giusto e il difetto in piedi.
    const passaggiDalLogin: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && frame.url().includes('/auth/login')) {
        passaggiDalLogin.push(frame.url());
      }
    });

    await page.getByRole('button', { name: 'Cambia profilo' }).click();
    await page.getByRole('menuitem', { name: 'Passa a Docente' }).click();

    await page.waitForURL('**/teacher', { timeout: AZIONE });
    expect(passaggiDalLogin).toEqual([]);
    await expect(page.getByTestId('chip-ruolo-attivo')).toHaveText('Docente', { timeout: AZIONE });
  });

  test.fixme('e si torna a Genitore', async ({ page }) => {
    await page.goto('/parent');
    await page.getByRole('button', { name: 'Cambia profilo' }).click();
    await page.getByRole('menuitem', { name: 'Passa a Docente' }).click();
    await page.waitForURL('**/teacher', { timeout: AZIONE });

    await page.getByRole('button', { name: 'Cambia profilo' }).click();
    await page.getByRole('menuitem', { name: 'Passa a Genitore' }).click();
    await page.waitForURL('**/parent', { timeout: AZIONE });
    await expect(page.getByTestId('chip-ruolo-attivo')).toHaveText('Genitore', { timeout: AZIONE });
  });
});

test.describe('controllo negativo: l’educator PURO non ha nessuna veste da cambiare', () => {
  test.use({ storageState: STORAGE.docente });

  test.fixme('nessuna affordance morta per chi ha un ruolo solo', async ({ page }) => {
    await page.goto('/teacher');
    // POSITIVO prima: la pagina ha caricato davvero e il menu si apre. Senza,
    // il `toHaveCount(0)` qui sotto sarebbe verde anche su una pagina bianca —
    // che è esattamente il modo in cui questo controllo diventerebbe un placebo.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: RENDER });
    await expect(page.getByTestId('chip-ruolo-attivo')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cambia profilo' })).toHaveCount(0);
  });
});
