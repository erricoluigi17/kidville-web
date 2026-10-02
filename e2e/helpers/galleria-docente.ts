import { expect, type Locator, type Page, type Response } from '@playwright/test';

/**
 * LA PAGINA GALLERIA DELL'INSEGNANTE, COME LA USA UN'INSEGNANTE — per gli spec video della PR 2.
 *
 * ⚠️ Niente di questo file conosce uno stato interno della pagina: i selettori sono i nomi che un
 * lettore di schermo legge (ruolo e nome accessibile) e le frasi del catalogo italiano, le stesse che
 * `e2e/gallery-caricamento.spec.ts` usa per le foto. Una frase del catalogo che cambia rende rosso lo
 * spec nel punto in cui la nomina, non in una sua copia: sono tutte QUI.
 */

/** I due bambini della Girasoli del seed: il nome come lo mostra il tagger (nome + cognome). */
export const AURORA = /Aurora Arcobaleno-E2E/;
export const BRUNO = /Bruno Baleno-E2E/;

/**
 * LE FRASI DEL CATALOGO CHE GLI SPEC LEGGONO, in UN posto.
 *
 * Sono prosa di `messages/it/*.json`: una riscrittura editoriale le cambia, e uno spec rosso per una virgola accusa
 * un prodotto sano (è già successo due volte in questo repo: i puntini `...` → `…`, l'apostrofo). Per questo qui stanno
 * i FRAMMENTI, non le frasi intere, e ognuno dice da quale chiave viene: chi rinomina una chiave sa subito che cosa si
 * rompe, e lo corregge in una riga sola.
 */
export const FRASI = {
  /** `teacherServizi.galleryVideoFaseInCoda` — la scheda di un video arrivato e non ancora preso dal runner. */
  schedaInCoda: 'In attesa di essere preparato',
  /** `teacherServizi.galleryVideoFaseInterrotto` — la scheda di un caricamento fermo che riprende da solo. */
  schedaInterrotta: 'Caricamento interrotto',
  /** `teacherServizi.galleryVideoRiprendi` — il pulsante acceleratore sulla scheda interrotta. */
  riprendi: 'Riprendi',
  /** `shared.gallerySoloGenitori` — l'etichetta del bambino senza liberatoria nel tagger. */
  soloGenitori: 'Solo genitori',
  /** Il 422 del Privacy Lock parla di «liberatoria foto» (prosa del server, `cancelli-destinatari.ts`). */
  liberatoria: 'liberatoria',
} as const;

/** `POST /api/video-uploads` (l'apertura): la riconosce la route e il metodo, non l'URL intero. */
const eAperturaVideo = (r: Response): boolean =>
  new URL(r.url()).pathname === '/api/video-uploads' && r.request().method() === 'POST';

/** Una richiesta a un'API di questa pagina, per percorso e metodo (la query non conta). */
const eRispostaDi = (percorso: string, metodo = 'GET') => (r: Response): boolean =>
  new URL(r.url()).pathname === percorso && r.request().method() === metodo;

/**
 * Apre la galleria e ATTENDE CHE SIA PRONTA A INVIARE un video, non soltanto caricata.
 *
 * ─── PERCHÉ TRE RISPOSTE E NON UN SELETTORE ──────────────────────────────────────────────
 * «Invia» di un video dipende da tre cose che la pagina ricava da altrettante richieste, e se si preme
 * prima che siano arrivate non fallisce con un errore leggibile: risponde col messaggio generico di un
 * invio non partito.
 *  · `/api/me` — dice la sede del profilo (`sedeVideo`): senza sede un video non parte («SEDE_DA_SPECIFICARE»);
 *  · `/api/diary/students` — i bambini della sezione, che il tagger mostra;
 *  · `GET /api/video-uploads` — l'ELENCO dei video del server. La pagina lo chiede soltanto DOPO aver
 *    aperto l'archivio locale dei caricamenti (IndexedDB) e saputo la sede: la sua risposta è quindi la
 *    prova che `avviaVideo` troverà l'archivio. Se risponde 500 o 503 il database della CI non ha lo
 *    schema della PR 2, e lo spec lo dice qui invece di sbattere due minuti dopo contro un invio muto.
 *
 * Le tre attese partono PRIMA della navigazione: una risposta arrivata durante `goto` non si recupera.
 * Tetti di due minuti: la prima richiesta a ogni route compila la route (`next dev`).
 */
export async function apriGalleriaPronta(page: Page): Promise<void> {
  const tetto = { timeout: 120_000 };
  const profilo = page.waitForResponse(eRispostaDi('/api/me'), tetto);
  const studenti = page.waitForResponse(eRispostaDi('/api/diary/students'), tetto);
  const elenco = page.waitForResponse(eRispostaDi('/api/video-uploads'), tetto);

  await page.goto('/teacher/gallery');

  const [rProfilo, rStudenti, rElenco] = await Promise.all([profilo, studenti, elenco]);
  expect(rProfilo.ok(), `GET /api/me → ${rProfilo.status()}`).toBe(true);
  expect(rStudenti.ok(), `GET /api/diary/students → ${rStudenti.status()}`).toBe(true);
  expect(
    rElenco.status(),
    `GET /api/video-uploads → ${rElenco.status()}: con 500/503 il database della CI non ha la pipeline video della PR 2`,
  ).toBe(200);
  await expect(page.getByRole('button', { name: 'Carica', exact: true })).toBeVisible({ timeout: 60_000 });
}

/**
 * Sceglie UN video e arriva al passo dei bambini: «Carica» → il file nel selettore → «Modifica Tag · 1 file».
 *
 * Il file passa dall'`<input type="file">` vero della pagina con il tipo dichiarato (`video/mp4`):
 * `classificaFileGalleria` non guarda i byte quando il tipo c'è, e la durata la chiede la pagina al browser
 * (un file che non è un filmato la dà `null`, che il server ammette: la misura vera la farebbe ffprobe).
 */
export async function scegliVideo(page: Page, video: { nome: string; buffer: Buffer; mime?: string }): Promise<void> {
  await page.getByRole('button', { name: 'Carica', exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: video.nome,
    mimeType: video.mime ?? 'video/mp4',
    buffer: video.buffer,
  });
  await page.getByRole('button', { name: /Modifica Tag.*1 file/i }).click();
  await expect(page.getByRole('heading', { name: /Configura Tag e Privacy/ })).toBeVisible({ timeout: 30_000 });
}

/** Il bottone «Pubblica 1 file» del passo dei bambini (un video solo: il conteggio è nel suo nome). */
export function bottonePubblica(page: Page): Locator {
  return page.getByRole('button', { name: 'Pubblica 1 file', exact: true });
}

/**
 * Preme «Pubblica» e attende la risposta dell'APERTURA (`POST /api/video-uploads`).
 *
 * La pagina misura prima la durata del file con un `<video>` (fino a 4 secondi di attesa, poi «non lo so»):
 * l'attesa della risposta ha un tetto più largo di quello. Restituisce la risposta, che il chiamante legge
 * (201 con l'intento, 422 con i nomi): è lei, e non lo schermo, la prova di ciò che il server ha deciso.
 */
export async function pubblicaEAttendiApertura(page: Page): Promise<Response> {
  const [risposta] = await Promise.all([
    page.waitForResponse(eAperturaVideo, { timeout: 120_000 }),
    bottonePubblica(page).click(),
  ]);
  return risposta;
}

/**
 * La scheda di UN video nella sezione «Video in preparazione» della pagina, riconosciuta dal NOME del file.
 *
 * Il nome è quello che l'insegnante ha scelto e che la scheda mostra (resta sullo schermo di chi ha scelto il
 * file, e non va in nessun log); è unico a ogni giro. Una scheda per posizione sarebbe la scheda sbagliata il
 * giorno in cui un altro video è in lavorazione sullo stesso account.
 */
export function schedaVideo(page: Page, nome: string): Locator {
  return page.locator('section li').filter({ hasText: nome });
}

/** Le richieste che la pagina manda al TUS dello Storage (creazione, blocchi, ripresa): per contarle. */
export interface RichiestaTus {
  metodo: string;
}

/**
 * Comincia a contare le richieste verso `/storage/v1/upload/resumable`. Restituisce l'ELENCO VIVO: si legge
 * quando serve. Si chiama PRIMA di premere «Pubblica»: una richiesta partita prima non si conta.
 *
 * Conta le richieste vere (`page.on('request')`), non quelle intercettate da una `route`: un'intercettazione
 * potrebbe sostituire la risposta e lasciare comunque partire la richiesta, e un conteggio «zero» deve
 * voler dire che non è partito nulla.
 */
export function osservaTus(page: Page): RichiestaTus[] {
  const viste: RichiestaTus[] = [];
  page.on('request', (richiesta) => {
    if (richiesta.url().includes('/storage/v1/upload/resumable')) viste.push({ metodo: richiesta.method() });
  });
  return viste;
}
