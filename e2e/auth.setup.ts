import { test as setup } from '@playwright/test';
import { EMAILS, IDS, STORAGE, login } from './fixtures';

// Progetto "setup": login UI per i 3 ruoli → storageState riusati dagli spec.

/**
 * IL COOKIE CHE SEPARA L'ADMIN DALL'AVVISO «SELEZIONA UNA SEDE».
 *
 * ─── LA MISURA, NON L'OPINIONE (2026-08-12) ─────────────────────────────────
 *
 * In produzione NON ESISTE un admin mono-sede: i due admin veri hanno TRE sedi
 * ciascuno (Giugliano, Aversa, Cesa). Per loro `sedeCorrente` è `null` finché
 * non ne dichiarano una, e ogni pagina sotto `SedeRequired` — contabilità,
 * news, mensa, modulistica, primaria, impostazioni, SIDI — mostra `SedeNotice`
 * al posto dei propri pannelli. Ciò che li separa da quell'avviso è UNA COSA
 * SOLA: il cookie `sedi_attive`, che il `SedeSelector` scrive quando scelgono
 * una sede e che dura **un anno** (`sede-context.tsx` → `writeCookie`). Cioè:
 * l'admin vero lavora quasi sempre CON quel cookie, non senza.
 *
 * L'admin del seed E2E ha due sedi (`utenti.scuola_id` = Kidville E2E, più il
 * ponte `utenti_scuole` verso il «Plesso di Collaudo» che serve ai moduli
 * pubblici): senza questa riga il suo `storageState` riproduce lo stato che
 * l'utente vero incontra solo al primo accesso da un browser nuovo — e sei spec
 * (4 di contabilità, 2 di news) diventano rossi accusando pannelli che sono
 * sani, mentre il prodotto sta facendo esattamente ciò per cui è scritto.
 *
 * ⚠️ NON È UNA SCORCIATOIA PER FAR PASSARE QUEI SEI SPEC. Toglierla non
 * «semplifica il setup»: riporta il banco di prova a una configurazione che in
 * produzione non esiste (un admin con una sede sola), cioè fa collaudare un
 * caso irreale. Il primo schermo SENZA questo cookie — quello che i due admin
 * veri vedono a ogni browser nuovo, a ogni pulizia dei cookie, a ogni
 * reinstallazione dell'app — ha uno spec suo: `e2e/admin-scelta-sede.spec.ts`,
 * che il cookie se lo toglie apposta.
 *
 * Il formato è quello che scrive il prodotto: uuid separati da virgola, `path=/`
 * (deve viaggiare anche su `/api/*`, dove il server lo ri-valida contro
 * `scuoleDiUtente`), `SameSite=Lax`, un anno di durata.
 */
const ANNO_IN_SECONDI = 31_536_000;

setup('storageState admin', async ({ page }) => {
  await login(page, EMAILS.admin);
  await page.waitForURL('**/admin');

  // PRIMA lo stato «Tutte le sedi» (cookie assente = nessun filtro), che è
  // l'altro stato legittimo del selettore e serve agli spec che leggono la posta
  // di più plessi insieme: le pratiche e le candidature dei moduli pubblici
  // nascono sul «Plesso di Collaudo», e `resolveScuoleAttive` scopa le letture
  // proprio con questo cookie. Vedi `STORAGE.adminTutteLeSedi` in `fixtures.ts`.
  await page.context().storageState({ path: STORAGE.adminTutteLeSedi });

  // POI la sede dichiarata: l'ordine non è invertibile — un cookie aggiunto dopo
  // il salvataggio non finirebbe nel file.
  await page.context().addCookies([
    {
      name: 'sedi_attive',
      value: IDS.SCUOLA,
      // Dall'URL corrente, non cablato: lo stesso setup vale per `localhost` e
      // per qualunque host la CI decida di usare domani.
      domain: new URL(page.url()).hostname,
      path: '/',
      sameSite: 'Lax',
      expires: Math.floor(Date.now() / 1000) + ANNO_IN_SECONDI,
    },
  ]);
  await page.context().storageState({ path: STORAGE.admin });
});

setup('storageState docente', async ({ page }) => {
  await login(page, EMAILS.docente);
  await page.waitForURL('**/teacher');
  await page.context().storageState({ path: STORAGE.docente });
});

setup('storageState genitore', async ({ page }) => {
  await login(page, EMAILS.genitore);
  await page.waitForURL('**/parent');
  await page.context().storageState({ path: STORAGE.genitore });
});
