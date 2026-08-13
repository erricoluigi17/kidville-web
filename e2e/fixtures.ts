import path from 'node:path';
import type { Page } from '@playwright/test';

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
  A1: 'e2e00000-0000-4000-8000-000000000101', // Aurora Arcobaleno-E2E
  A2: 'e2e00000-0000-4000-8000-000000000102', // Bruno Baleno-E2E
  ADMIN: 'e2e00000-0000-4000-8000-000000000201',
  DOCENTE: 'e2e00000-0000-4000-8000-000000000202',
  GENITORE: 'e2e00000-0000-4000-8000-000000000203',
  SEGRETERIA: 'e2e00000-0000-4000-8000-000000000205',

  // ── Sede 2: quella che l'isolamento deve tenere fuori ────────────────────
  // La sua sezione si chiama «Girasoli» come quella della sede 1: il nome-classe
  // non è una chiave, e questo è il caso che il 2026-07-29 ha reso reale.
  SCUOLA2: 'e2e00000-0000-4000-8000-000000000002',
  SEC2_GIRASOLI: 'e2e00000-0000-4000-8000-000000000021',
  B1: 'e2e00000-0000-4000-8000-000000000105', // Emma Eclissi-E2E (Girasoli, sede 2)
  SEGRETERIA2: 'e2e00000-0000-4000-8000-000000000206',
  DOCENTE2: 'e2e00000-0000-4000-8000-000000000207',
  GENITORE2: 'e2e00000-0000-4000-8000-000000000208',
  AVVISO_S2: 'e2e00000-0000-4000-8000-000000000402',
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
