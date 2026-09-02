import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';

// Deve restare allineato a scripts/seed-e2e.mjs (UUID fissi, credenziali).

/**
 * La password dei 4 account del seed E2E arriva dall'AMBIENTE, mai dal repo.
 * Copia TypeScript di `e2e/lib/e2e-password.mjs` (la testata di quel file spiega
 * perché un letterale qui è costato due sedi di produzione); la duplicazione è la
 * stessa già adottata in `e2e/primaria-360/config/accounts.ts`, perché gli spec
 * Playwright non importano moduli `.mjs` dello stesso repo.
 *
 * Fail-closed: senza variabile si fallisce SUBITO, con il messaggio che dice cosa
 * esportare — invece di sbattere più avanti contro un login che non riesce.
 */
function requireE2EPassword(): string {
  const valore = (process.env.KV_E2E_PASSWORD || '').trim();
  if (!valore) {
    throw new Error(
      "Manca la variabile d'ambiente KV_E2E_PASSWORD: è la password dei 4 account del seed E2E " +
        '(*.e2e@kidville.test) e NON è scritta nel repo. In locale prendila dal gestore di credenziali ' +
        "del titolare ed esportala prima di rilanciare:  export KV_E2E_PASSWORD='…'  — in CI arriva " +
        'dal secret GitHub CI_E2E_PASSWORD.',
    );
  }
  return valore;
}

export const PASSWORD = requireE2EPassword();

export const EMAILS = {
  admin: 'admin.e2e@kidville.test',
  docente: 'docente.e2e@kidville.test',
  genitore: 'genitore.e2e@kidville.test',
  doppio: 'doppio.e2e@kidville.test',
  // Sede 1: la segreteria (il ruolo che allo sportello vede l'anagrafica, e che
  // dal 2026-07-30 è limitato alla SOLA propria sede).
  segreteria: 'segreteria.e2e@kidville.test',
  // Sede 2 (`isolamento-sedi.spec.ts`): personale e famiglia propri.
  segreteria2: 'segreteria2.e2e@kidville.test',
  docente2: 'docente2.e2e@kidville.test',
  genitore2: 'genitore2.e2e@kidville.test',
};

/**
 * Le identità dei due moduli pubblici del PERSONALE.
 *
 * ⚠️ RICOPIATE da `PERSONALE_E2E` di `scripts/seed-e2e.mjs`, e devono restare
 * allineate: quel file è `.mjs` e gli spec Playwright non importano moduli `.mjs`
 * dello stesso repo (è la stessa duplicazione dichiarata in cima a questo file per
 * la password). Se qui e là divergono, il seed ripulisce indirizzi che nessuno usa
 * e gli spec partono da uno stato sporco: le due rotte traducono il doppione in
 * **201, come al primo invio**, quindi il test resterebbe verde per il motivo
 * sbagliato — senza che nessuna riga nuova nasca.
 */
export const PERSONALE_E2E = {
  /** `/anagrafica-personale`: la pratica che il percorso felice invia. */
  emailPratica: 'anagrafica.e2e@kidville.test',
  /** `/anagrafica-personale`: la pratica che il cockpit approva (spec separato). */
  emailApprovazione: 'approvazione.e2e@kidville.test',
  /** `/lavora-con-noi`: la candidatura del percorso vero. */
  emailCandidatura: 'candidatura.e2e@kidville.test',
};

export const IDS = {
  SCUOLA: 'e2e00000-0000-4000-8000-000000000001',
  /**
   * LA SEDE CHE I MODULI PUBBLICI VEDONO — e l'unica.
   *
   * ⚠️ Ricopiata da `IDS.SCUOLA_COLLAUDO` di `scripts/seed-e2e.mjs` (stessa
   * duplicazione, stessa ragione: non si importa un `.mjs`). Nome «Plesso di
   * Collaudo», città «Testville».
   *
   * Esiste perché `isScuolaE2E` (`src/lib/scuole/reali.ts`) esclude da ogni elenco
   * pubblico le sedi il cui id comincia per `e2e00000` o il cui nome contiene
   * «e2e» — cioè `SCUOLA` e `SCUOLA2` qui sopra. Senza una terza sede che il
   * predicato NON riconosce, `GET /api/iscrizione/sedi` risponde `{data: []}` e i
   * moduli pubblici del personale non cominciano nemmeno.
   */
  SCUOLA_COLLAUDO: 'c0110a0d-0000-4000-8000-000000000001',
  SEC_GIRASOLI: 'e2e00000-0000-4000-8000-000000000011',
  /**
   * La sezione dei figli del PROFILO DOPPIO, sede 1 — e la sua omonima nella
   * sede 2 (`SEC2_MARGHERITE`). Nessun docente vi è assegnato: è il punto.
   * Vedi il blocco dei legami in `scripts/seed-e2e.mjs`.
   */
  SEC_MARGHERITE: 'e2e00000-0000-4000-8000-000000000014',
  A1: 'e2e00000-0000-4000-8000-000000000101', // Aurora Arcobaleno-E2E
  A2: 'e2e00000-0000-4000-8000-000000000102', // Bruno Baleno-E2E
  A3: 'e2e00000-0000-4000-8000-000000000103', // Clara Cometa-E2E (Tulipani = LA classe del DOPPIO)
  /** Fiore Fiocco-E2E — figlio del profilo doppio, sede 1, sezione che lui NON insegna. */
  A5: 'e2e00000-0000-4000-8000-000000000106',
  ADMIN: 'e2e00000-0000-4000-8000-000000000201',
  DOCENTE: 'e2e00000-0000-4000-8000-000000000202',
  GENITORE: 'e2e00000-0000-4000-8000-000000000203',
  /** Duccio Doppio-E2E — `utenti.ruolo = 'educator'` PIÙ il ponte `parents.auth_user_id`. */
  DOPPIO: 'e2e00000-0000-4000-8000-000000000204',
  SEGRETERIA: 'e2e00000-0000-4000-8000-000000000205',

  // ── Sede 2: quella che l'isolamento deve tenere fuori ────────────────────
  // La sua sezione si chiama «Girasoli» come quella della sede 1: il nome-classe
  // non è una chiave, e questo è il caso che il 2026-07-29 ha reso reale.
  SCUOLA2: 'e2e00000-0000-4000-8000-000000000002',
  SEC2_GIRASOLI: 'e2e00000-0000-4000-8000-000000000021',
  /** «Margherite» della sede 2: OMONIMA di `SEC_MARGHERITE`, come lo è «Girasoli». */
  SEC2_MARGHERITE: 'e2e00000-0000-4000-8000-000000000022',
  B1: 'e2e00000-0000-4000-8000-000000000105', // Emma Eclissi-E2E (Girasoli, sede 2)
  /** Gigi Girandola-E2E — figlio del profilo doppio, ALTRA SEDE. */
  B2: 'e2e00000-0000-4000-8000-000000000107',
  SEGRETERIA2: 'e2e00000-0000-4000-8000-000000000206',
  DOCENTE2: 'e2e00000-0000-4000-8000-000000000207',
  GENITORE2: 'e2e00000-0000-4000-8000-000000000208',
  AVVISO_S2: 'e2e00000-0000-4000-8000-000000000402',
};

/**
 * Le ÀNCORE seminate per il profilo doppio: didascalie di galleria, primi piatti
 * della mensa, nota di diario.
 *
 * ⚠️ RICOPIATE da `DOPPIO_PROFILO_E2E` di `scripts/seed-e2e.mjs`, stessa
 * duplicazione dichiarata in cima a questo file (gli spec Playwright non
 * importano moduli `.mjs` del repo). Se qui e là divergono, lo spec cerca frasi
 * che nessuno ha scritto e diventa rosso su un prodotto sano.
 *
 * Sono dato del SEED e non testo di catalogo, di proposito: un'asserzione su una
 * frase dei `messages/` diventa rossa alla prima riscrittura editoriale — in
 * questo repo è già successo due volte (i puntini `...` → `…`, l'apostrofo
 * dritto → tipografico), e ogni volta il rosso accusava il prodotto.
 */
export const DOPPIO_PROFILO_E2E = {
  /** Didascalia del media taggato su `A5` (sede 1). */
  fotoSede1: 'Foto E2E · Margherite della sede 1',
  /** Didascalia del media taggato su `B2` (sede 2). */
  fotoSede2: 'Foto E2E · Margherite della sede 2',
  /** Primo piatto dell'override mensa di OGGI nella sede 1. */
  primoSede1: 'Pasta E2E della sede 1',
  /** Primo piatto dell'override mensa di OGGI nella sede 2. */
  primoSede2: 'Riso E2E della sede 2',
  /** Nota di diario di `A5`. */
  notaDiarioA5: 'Nota E2E per il genitore-docente',
};

/**
 * I NOMI delle sedi del seed, come li mostra il cockpit.
 *
 * ⚠️ Ricopiati da `scripts/seed-e2e.mjs` (stessa duplicazione dichiarata in cima
 * a questo file: gli spec Playwright non importano moduli `.mjs` del repo). Gli
 * uuid qui sopra bastano per il DATO; il NOME serve quando lo spec deve toccare
 * ciò che l'utente tocca — i bottoni dell'avviso «Seleziona una sede», che
 * portano il nome della sede e nient'altro (`SedeNotice`, `sede-context.tsx`).
 */
export const NOMI_SEDI = {
  /** `IDS.SCUOLA` — la sede principale del seed. */
  scuola: 'Kidville E2E',
  /** `IDS.SCUOLA_COLLAUDO` — la sede che i moduli pubblici vedono. */
  collaudo: 'Plesso di Collaudo',
};

export const STORAGE = {
  /**
   * L'admin CON LA SUA SEDE DICHIARATA (cookie `sedi_attive` = `IDS.SCUOLA`).
   *
   * È lo stato in cui l'admin vero lavora quasi sempre — il perché, con la
   * misura, sta in `auth.setup.ts`. Da qui il cockpit ha una sede corrente,
   * quindi le pagine sotto `SedeRequired` (contabilità, news, mensa,
   * modulistica, primaria, impostazioni) mostrano i propri pannelli.
   */
  admin: path.join(__dirname, '.auth', 'admin.json'),
  /**
   * Lo stesso admin, ma SENZA sede dichiarata: cioè «Tutte le sedi», che è
   * l'altro stato legittimo del selettore (cookie vuoto = nessun filtro).
   *
   * Serve agli spec che leggono dati di PIÙ plessi con una sola richiesta — le
   * pratiche e le candidature dei moduli pubblici nascono sul «Plesso di
   * Collaudo» (`IDS.SCUOLA_COLLAUDO`), non sulla sede principale, e
   * `resolveScuoleAttive` scopa le letture con quel cookie: da `STORAGE.admin`
   * quelle righe sarebbero legittimamente fuori scope. Non è una scorciatoia:
   * è la stessa cosa che fa una Segreteria che vuole vedere la posta di tutti i
   * plessi insieme.
   */
  adminTutteLeSedi: path.join(__dirname, '.auth', 'admin-tutte-le-sedi.json'),
  docente: path.join(__dirname, '.auth', 'docente.json'),
  genitore: path.join(__dirname, '.auth', 'genitore.json'),
  /**
   * IL PROFILO DOPPIO IN VESTE DI GENITORE — cookie `kv-active-role=genitore`.
   *
   * Non è «un quinto account»: è LO STESSO utente di `STORAGE.doppioDocente`,
   * con l'altra veste. `utenti.ruolo` è `educator` e il ponte
   * `parents.auth_user_id` esiste, quindi `eFamiglia` è vero e
   * `agisceComeGenitore` dipende SOLO da quale bottone si è premuto sul picker
   * del login. I due stati esistono per poter fare la stessa domanda al server
   * due volte, cambiando una cosa sola.
   *
   * In produzione (misura del 2026-09-01) sono cinque persone: insegnanti che
   * sono anche genitori di un bambino della scuola.
   */
  doppioGenitore: path.join(__dirname, '.auth', 'doppio-genitore.json'),
  /**
   * Lo stesso utente in veste di DOCENTE — cookie `kv-active-role=educator`.
   *
   * Serve al controllo di non-regressione: la veste di famiglia non deve aver
   * allargato NIENTE sul mestiere. Senza questo stato, «in veste docente resta
   * 403» si potrebbe solo raccontare.
   */
  doppioDocente: path.join(__dirname, '.auth', 'doppio-docente.json'),
};

// Login dalla UI reale (/auth/login): sessione Supabase via cookie, niente header.
export async function login(page: Page, email: string, password: string = PASSWORD) {
  await page.goto('/auth/login');
  await attendiFineCaricamento(page);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Accedi' }).click();
}

/**
 * Attende che l'overlay di caricamento globale abbia finito di coprire la pagina.
 *
 * ─── DA DOVE VIENE, 2026-08-04 ─────────────────────────────────────────────
 * Nata per convivere con l'inertizzazione del `GlobalLoader` (rilievo T09-F1),
 * che poi è stata RITIRATA — la ragione per esteso è nel commento di
 * `src/components/providers/GlobalLoader.tsx`: rendeva inerte ogni pagina per
 * almeno `MIN_VISIBLE_MS`, e `fill()` «riusciva» senza scrivere niente.
 *
 * Resta qui perché è giusta anche senza quella correzione: un utente vero il
 * loader lo VEDE e non digita sotto un pannello opaco, e un test che scrive alla
 * cieca durante una transizione misura qualcosa che nessuno farà mai. Toglie
 * inoltre una fragilità latente — l'overlay intercetta i click, quindi un test
 * che clicca mentre è a schermo dipende da quanto è veloce la macchina della CI.
 *
 * Tolleranza: se l'overlay non compare affatto (navigazione veloce, il caso
 * normale) la condizione è già vera e si prosegue subito.
 */
export async function attendiFineCaricamento(page: Page) {
  await page
    .locator('[data-visible="true"][role="status"]')
    .waitFor({ state: 'hidden', timeout: 10_000 })
    .catch((errore) => {
      // Se l'elemento non c'è mai stato la condizione è già vera e non si passa di
      // qui: qui ci si arriva solo per TIMEOUT, cioè con l'overlay ancora a schermo
      // dopo 10 secondi. Non si fa fallire il test — non è questo il suo oggetto — ma
      // non si tace nemmeno: un'attesa che si arrende in silenzio è il motivo per cui
      // `parent-news.spec.ts` è sembrato capriccioso per giorni, mentre il difetto era
      // altrove e ben visibile. Chi legge i log della CI ora lo vede.
      console.warn(
        '[attendiFineCaricamento] overlay del loader ancora visibile dopo 10 s — proseguo:',
        errore instanceof Error ? errore.message.split('\n')[0] : String(errore),
      );
    });
}


/**
 * IL NOME DEL FILE COME SI LEGGE A SCHERMO — e non come lo sente chi ascolta.
 *
 * ─── PERCHÉ NON BASTA PIÙ CERCARE IL NOME NEL RIQUADRO ─────────────────────
 *
 * Dal 2026-08-25 `FileField` (`src/components/features/forms/FieldRenderer.tsx`)
 * scrive il nome del file TRE volte nello stesso riquadro:
 *
 *   <span title="documento.png">                    ← la riga del nome
 *     <span class="sr-only">documento.png</span>    ← per chi ascolta, intero
 *     <span aria-hidden>documen</span>              ← la radice, che si accorcia
 *     <span aria-hidden>…</span>                    ← i puntini, quando serve
 *     <span aria-hidden>to.png</span>               ← la coda, che non si accorcia
 *   </span>
 *
 * Lo `sr-only` è la riparazione di un difetto vero (spezzare il nome in due
 * `<span>` lo spezzava anche nel nome accessibile: «cv-di-pr ova.pdf»), ma è
 * `clip`-ato, non `display:none` — quindi finisce in `textContent`, in
 * `innerText` E dentro `toBeVisible()`, che per Playwright è vero già con una
 * scatola di 1×1 px.
 *
 * ⚠️ MISURATO IL 2026-08-25, ed è il motivo per cui questa funzione esiste.
 * Sulla pagina viva di `/iscrizione`, con le rotte intercettate, CANCELLANDO
 * tutte le metà visibili (`label span[aria-hidden]`) e lasciando il solo
 * `sr-only`, restavano VERDI tutte e tre le forme che i due spec pubblici
 * usavano o che erano state proposte per sostituirle:
 *     getByText('documento.png').first() → toBeVisible()     VERDE
 *     riquadro → toContainText('documento.png')              VERDE
 *     riquadro → toContainText(…, { useInnerText: true })    VERDE
 * Cioè: l'asserzione «il riquadro mostra il nome del file» sopravviveva alla
 * sparizione completa del nome dallo schermo. Il segnale non è ASSENTE — è
 * FALSO, e un segnale falso si smaschera in un modo solo: rompendo apposta e
 * guardando se il guardiano cade.
 *
 * ─── COSA GUARDA QUESTA FUNZIONE ───────────────────────────────────────────
 *
 * Solo le metà `aria-hidden`, cioè esattamente ciò che una persona LEGGE, e
 * pretende che rimesse insieme facciano il nome intero — che è l'invariante
 * dichiarata da `spezzaNomeFile` («RADICE + CODA è sempre il nome, byte per
 * byte»). I puntini si tolgono per NODO e non con una sostituzione sulla
 * stringa: sono un nodo loro, e un nome che contenesse «…» non va mutilato.
 */
export async function attendiNomeFileVisibile(riquadro: Locator, nome: string) {
  // `span[title] >` esclude «Sostituisci», che è `aria-hidden` ma è figlio della
  // <label>, non della riga del nome. Senza il titolo (nessun file) la riga non
  // esiste affatto e la lista è vuota: il messaggio dice «'' invece di …».
  const metaVisibili = riquadro.locator('span[title] > span[aria-hidden="true"]');
  await expect
    .poll(async () => (await metaVisibili.allTextContents()).filter((t) => t !== '…').join(''), {
      message: `il riquadro non MOSTRA «${nome}»: a schermo le due metà del nome non lo compongono (la copia \`sr-only\`, che c'è comunque, non conta)`,
      timeout: 20_000,
    })
    .toBe(nome);
}
