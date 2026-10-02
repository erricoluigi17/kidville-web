import { test, expect, type APIResponse } from '@playwright/test';
import { IDS, STORAGE } from './fixtures';
import { clienteDatabaseCi, richiediPipelineVideo } from './helpers/database-ci';
import {
  apriIntentoVideo,
  attendiStatoJob,
  dimensioneOggetto,
  leggiApertura,
  leggiJob,
  nomeVideoUnico,
  ritiraIntentoVideo,
  tokenRinnovoFalso,
  videoFinto,
  type IntentoAperto,
} from './helpers/video-ci';

/**
 * IL RINNOVO DEL CARICAMENTO NATIVO — solo API, sul Supabase vero della CI (PR 2 dei video, 2026-10-02,
 * spec §6.2, §12 e §17; secondario #100).
 *
 * ─── DI COSA SI TRATTA ──────────────────────────────────────────────────────────────────────────
 * L'app 1.2 (PR 3) manderà l'originale con UNA PUT sola dal sistema operativo, anche ad app chiusa, su un
 * URL firmato SENZA upsert. Quando l'URL scade (due ore) o la PUT prende 400/403 non ha nessuna sessione da
 * presentare: il sistema operativo la risveglia, non l'insegnante. Il suo unico documento è il TOKEN DI
 * RINNOVO coniato all'apertura (`kvr_` + 32 byte casuali), che manda nell'intestazione
 * `x-kidville-rinnovo` a `POST /api/video-uploads/rinnovo` — l'unica porta di questa cartella SENZA sessione.
 * Quella porta e quel contratto non esistono ancora nell'app: li prova questo spec, con il client che
 * l'app sarà.
 *
 * ─── COSA SI VERIFICA DAL VIVO, che nessun test unitario può ───────────────────────────────────────
 * Il secondario #100 («da provare dal vivo»): tre comportamenti che dipendono dallo Storage e dal database
 * veri e che un mock restituirebbe verdi anche sbagliati.
 *  1. `createSignedUploadUrl(…, { upsert: false })` + una SECONDA PUT sullo stesso percorso è rifiutata come
 *     DUPLICATO: l'originale già arrivato non si sovrascrive (è la proprietà che regge il token: chi lo rubasse
 *     non può sostituire il file). ⚠️ Lo Storage il rifiuto lo dice a modo suo: HTTP 400 con `statusCode: "409"` e
 *     `error: "Duplicate"` NEL CORPO, non un HTTP 409 (vedi `attendiDuplicato`). Il controllo di merito è doppio:
 *     il rifiuto, e l'originale nello Storage che resta lungo quanto il PRIMO file — una PUT che sovrascrive
 *     risponderebbe 200 e cambierebbe la dimensione;
 *  2. il trigger d'arrivo su `storage.objects` porta il job in coda e REVOCA il token da solo, appena la PUT
 *     finisce: nessun «ho finito» del client in mezzo (qui il client non lo manda mai). Se il trigger non c'è, il
 *     job resta `awaiting_upload` e lo spec lo dice con le sue parole;
 *  3. la risposta VERA di `video_rinnovo_usa`: `arrivato` anche a token revocato (decisione dell'orchestratore,
 *     02/10: la seconda PUT dell'app, rifiutata come duplicato, deve poter sapere «il file c'è»), `da-caricare` con un URL
 *     nuovo finché il file non è arrivato, `annullato` dopo il ritiro — e per tutto il resto un 404 UNIFORME
 *     (`VIDEO_NON_TROVATO`), senza che da fuori si distingua un token mai esistito da uno scaduto.
 *
 * ─── UN CLIENT SENZA SESSIONE, DAVVERO ───────────────────────────────────────────────────────────────
 * Le chiamate al rinnovo e le PUT allo Storage passano da un contesto API SENZA cookie (`playwright.request
 * .newContext` senza `storageState`), non da quello della docente: con la sessione di mezzo un rinnovo che
 * (per un difetto) leggesse l'identità invece del token sarebbe verde. La docente apre l'intento e lo ritira; il
 * resto lo fa chi ha solo il token.
 *
 * ─── PERCHÉ NON SI USA LO SHA-256 PER ALTRO ──────────────────────────────────────────────────────────
 * L'apertura nativa lo pretende (400 senza) e lo spec lo manda giusto (l'impronta dei byte che carica), ma lo
 * verifica il Sandbox, non lo Storage né il trigger: in CI il Sandbox non c'è, e quel controllo lo prova il test
 * unitario del runner. Qui si prova solo che l'apertura lo chieda.
 *
 * ─── ISOLAMENTO ───────────────────────────────────────────────────────────────────────────────────
 * Ogni test annulla il suo intento e toglie i suoi byte (pochi KB) in `afterEach`; nessuno tocca bambini o
 * liberatorie (un bambino solo: «foto privata», nessuna liberatoria richiesta). Sono otto richieste al rinnovo in
 * tutto, contro un tetto di 30 ogni 10 minuti per indirizzo e 20 per token. `retries: 0`, come gli altri spec che
 * scrivono su un database condiviso.
 */
test.describe.configure({ retries: 0 });
test.use({ storageState: STORAGE.docente });

const INTESTAZIONE_RINNOVO = 'x-kidville-rinnovo';

/** Gli intenti che i test di questo file hanno aperto, da ritirare alla fine di ciascuno. */
const aperti: IntentoAperto[] = [];

test.beforeAll(async () => {
  // Il database ha lo schema della PR 2? Se no, una frase che dice cosa applicare invece di un 500 senza spiegazione.
  await richiediPipelineVideo(clienteDatabaseCi());
});

test.afterEach(async ({ request }) => {
  const db = clienteDatabaseCi();
  for (const intento of aperti.splice(0)) await ritiraIntentoVideo(request, db, intento);
});

/** Apre un intento NATIVO (un bambino solo) e lo registra per la pulizia. */
async function apriNativo(request: Parameters<typeof apriIntentoVideo>[0], file: Buffer): Promise<IntentoAperto> {
  const aperto = await leggiApertura(
    await apriIntentoVideo(request, { file, nome: nomeVideoUnico('rinnovo'), tag: [IDS.A1], trasporto: 'put-nativo' }),
  );
  aperti.push(aperto);
  return aperto;
}

/** L'URL e le intestazioni della PUT, riletti dalla risposta d'apertura (o di rinnovo) con il loro tipo. */
function coordinatePut(caricamento: IntentoAperto['job']['caricamento']): { url: string; intestazioni: Record<string, string> } {
  expect(caricamento.protocollo, 'il trasporto nativo risponde con un URL di PUT, non con le coordinate TUS').toBe('put');
  expect(caricamento.metodo).toBe('PUT');
  expect(caricamento.url, 'l\'URL firmato è nella risposta').toBeTruthy();
  expect(new URL(caricamento.url as string).protocol, 'solo https: ci passa il video di un bambino').toBe('https:');
  expect(caricamento.intestazioni).toEqual({ 'content-type': 'video/mp4' });
  return { url: caricamento.url as string, intestazioni: caricamento.intestazioni as Record<string, string> };
}

/**
 * Una PUT su un oggetto che esiste già, con un URL firmato SENZA upsert, dev'essere rifiutata COME DUPLICATO.
 *
 * ⚠️ NON È UN «HTTP 409». Lo Storage risponde con HTTP 400 e mette il 409 NEL CORPO:
 * `{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}`. Il motivo sta in storage-api:
 * `StorageBackendError.userStatusCode` vale 400 per ogni errore che non sia un 500, e il suo gestore degli errori
 * gira senza `respectStatusCode`, quindi lo stato HTTP è `userStatusCode` e il 409 resta solo nel corpo. Il repo lo
 * sa già: le route che interrogano lo Storage leggono `statusCode ?? status` (`video-uploads/route.ts`,
 * `gallery/upload-url/route.ts`) perché anche il «404» di un oggetto assente arriva come HTTP 400.
 *
 * Perciò si accettano 400 e 409 come stato HTTP (se un giorno lo Storage rispettasse il codice, lo spec non
 * cadrebbe) e si PRETENDE il 409 nel corpo: è lui a dire «duplicato» e non, per dire, «firma non valida» — che è
 * un 400 anch'esso e che qui sarebbe un guasto vero. Una PUT che sovrascrivesse risponderebbe 200 e si fermerebbe
 * alla prima asserzione, con la sua frase.
 *
 * Il corpo d'errore dello Storage si cita nei messaggi (i primi 200 caratteri, come per la prima PUT): dice un
 * codice e una frase, e di norma non porta né indirizzi firmati né token.
 */
async function attendiDuplicato(risposta: APIResponse, perche: string): Promise<void> {
  const stato = risposta.status();
  const testo = await risposta.text();
  expect([400, 409], `${perche} — HTTP ${stato}: ${testo.slice(0, 200)}`).toContain(stato);

  let corpo: { statusCode?: unknown; error?: unknown } = {};
  try {
    const letto: unknown = JSON.parse(testo);
    if (letto !== null && typeof letto === 'object') corpo = letto as typeof corpo;
  } catch {
    // Non è JSON (la pagina d'errore di un intermediario, per esempio): lo dicono le due asserzioni qui sotto,
    // col corpo nel messaggio.
    corpo = {};
  }
  expect(String(corpo.statusCode), `il rifiuto dice statusCode "409" nel corpo — ${perche}: ${testo.slice(0, 200)}`).toBe('409');
  expect(corpo.error, `il rifiuto dice error "Duplicate" nel corpo — ${perche}`).toBe('Duplicate');
}

test('rinnovo: PUT sull\'URL firmato → il server vede arrivare il file → `arrivato`; seconda PUT → rifiutata come duplicato (niente upsert); token falso → 404 uniforme', async ({ request, playwright, baseURL }) => {
  test.setTimeout(180_000);
  const db = clienteDatabaseCi();
  // `storageState` VUOTO, scritto: senza, Playwright passa al contesto i default del progetto (`test.use`), cioè i cookie
  // della docente, e un rinnovo che leggesse l'identità invece del token resterebbe verde (secondario #195).
  const anonimo = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  expect((await anonimo.get('/api/me')).status(), 'il contesto «anonimo» ha una sessione').toBe(401);
  try {
    const file = videoFinto(32 * 1024);

    // ── L'APERTURA NATIVA: URL di PUT firmato, token di rinnovo, nessuna firma TUS ──────────────────
    const aperto = await apriNativo(request, file);
    const { url, intestazioni } = coordinatePut(aperto.job.caricamento);
    expect(aperto.job.firma, 'con la PUT non c\'è una firma TUS: l\'URL è già firmato').toBe('');
    expect(aperto.job.needs_upload).toBe(true);
    const token = aperto.job.rinnovo?.token ?? '';
    expect(token, 'il token di rinnovo ha la forma coniata dal server').toMatch(/^kvr_[A-Za-z0-9_-]{43}$/);
    const oreDiVita = (Date.parse(aperto.job.rinnovo?.scadeIl ?? '') - Date.now()) / 3_600_000;
    expect(oreDiVita, 'il token vale 48 ore').toBeGreaterThan(47);
    expect(oreDiVita).toBeLessThan(49);

    const prima = await leggiJob(db, aperto.jobId);
    expect(prima?.status).toBe('awaiting_upload');
    expect(prima?.arrivato_il).toBeNull();

    // ── LA PUT, da chi ha solo l'URL ─────────────────────────────────────────────────────────────
    const primaPut = await anonimo.put(url, { headers: intestazioni, data: file, timeout: 120_000 });
    const corpoPrimaPut = primaPut.ok() ? '' : await primaPut.text();
    expect(primaPut.status(), `la prima PUT sull'URL firmato deve riuscire (${primaPut.status()}) ${corpoPrimaPut.slice(0, 200)}`).toBe(200);

    // ── IL SERVER VEDE ARRIVARE IL FILE DA SOLO (trigger su storage.objects), e il token si revoca ─────
    await attendiStatoJob(
      db,
      aperto.jobId,
      'queued',
      'il trigger d\'arrivo non ha portato il job in coda dopo la PUT: manca il trigger su storage.objects (file B) o è andato in eccezione',
    );
    const arrivato = await leggiJob(db, aperto.jobId);
    expect(arrivato?.source_size, 'la dimensione che il trigger ha letto dall\'oggetto').toBe(file.length);
    expect(arrivato?.source_mime).toBe('video/mp4');
    expect(arrivato?.arrivato_il, 'l\'istante dell\'arrivo è scritto sul job').not.toBeNull();
    expect(arrivato?.rinnovo_token_revocato_il, 'il token si revoca all\'arrivo del file').not.toBeNull();

    // ── IL RINNOVO, DOPO L'ARRIVO: `arrivato`, mai un URL — anche a token revocato ──────────────────
    const dopo = await anonimo.post('/api/video-uploads/rinnovo', { headers: { [INTESTAZIONE_RINNOVO]: token }, timeout: 90_000 });
    expect(dopo.status()).toBe(200);
    const corpoDopo = (await dopo.json()) as Record<string, unknown>;
    expect(corpoDopo).toEqual({ stato: 'arrivato' });
    expect(dopo.headers()['cache-control'] ?? '', 'una risposta che può portare un URL firmato non si mette in cache').toContain('no-store');
    // E si può richiedere ancora: la 1.2 che si vede rifiutare la seconda PUT come duplicato può chiedere più di una
    // volta, e non cambia niente.
    const ancora = await anonimo.post('/api/video-uploads/rinnovo', { headers: { [INTESTAZIONE_RINNOVO]: token } });
    expect(await ancora.json()).toEqual({ stato: 'arrivato' });

    // ── LA SECONDA PUT SULLO STESSO URL: rifiutata come duplicato, e l'originale non cambia ─────────
    // Un file DIVERSO (più lungo): se lo Storage sovrascrivesse, la dimensione cambierebbe e il trigger lo
    // segnerebbe `ORIGINALE_SOSTITUITO`. Il rifiuto del duplicato (HTTP 400, `statusCode: "409"` nel corpo: vedi
    // `attendiDuplicato`) è la proprietà che regge il token rubato.
    const altro = videoFinto(file.length + 4096);
    const secondaPut = await anonimo.put(url, { headers: intestazioni, data: altro, timeout: 120_000 });
    await attendiDuplicato(secondaPut, 'una seconda PUT sullo stesso percorso non sovrascrive: la firma è senza upsert');
    expect(
      await dimensioneOggetto(db, 'video_originals', arrivato?.original_path ?? ''),
      'l\'originale è ancora il PRIMO file',
    ).toBe(file.length);
    expect((await leggiJob(db, aperto.jobId))?.status, 'il job non è stato rifiutato né sostituito').toBe('queued');

    // ── UN TOKEN CHE NESSUNO HA CONIATO, O NON È UN TOKEN, O MANCA: lo stesso 404 ───────────────────
    const casi: Array<[string, Record<string, string>]> = [
      ['mai coniato', { [INTESTAZIONE_RINNOVO]: tokenRinnovoFalso() }],
      ['malformato', { [INTESTAZIONE_RINNOVO]: 'non-un-token' }],
      ['assente', {}],
    ];
    const corpi: string[] = [];
    for (const [descrizione, headers] of casi) {
      const risposta = await anonimo.post('/api/video-uploads/rinnovo', { headers, timeout: 90_000 });
      expect(risposta.status(), `token ${descrizione}: 404 uniforme`).toBe(404);
      const corpo = (await risposta.json()) as { codice?: string };
      expect(corpo.codice, `token ${descrizione}`).toBe('VIDEO_NON_TROVATO');
      corpi.push(JSON.stringify(corpo));
    }
    expect(new Set(corpi).size, 'i tre casi sono indistinguibili da fuori: stesso corpo').toBe(1);
  } finally {
    await anonimo.dispose();
  }
});

test('rinnovo: prima dell\'arrivo risponde `da-caricare` con un URL NUOVO che funziona (la vita del token non si allunga); l\'URL vecchio, dopo, è rifiutato come duplicato', async ({ request, playwright, baseURL }) => {
  test.setTimeout(180_000);
  const db = clienteDatabaseCi();
  // `storageState` VUOTO, scritto: senza, Playwright passa al contesto i default del progetto (`test.use`), cioè i cookie
  // della docente, e un rinnovo che leggesse l'identità invece del token resterebbe verde (secondario #195).
  const anonimo = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  expect((await anonimo.get('/api/me')).status(), 'il contesto «anonimo» ha una sessione').toBe(401);
  try {
    const file = videoFinto(24 * 1024);
    const aperto = await apriNativo(request, file);
    const primo = coordinatePut(aperto.job.caricamento);
    const token = aperto.job.rinnovo?.token ?? '';
    expect(token).toMatch(/^kvr_[A-Za-z0-9_-]{43}$/);

    // ── L'URL è scaduto (o la PUT ha preso 400/403): l'app chiede un indirizzo nuovo con il solo token. ──
    // Si lascia passare più di un secondo, e non è un vezzo: lo Storage firma l'URL con un HMAC il cui contenuto
    // (percorso, `iat`, `exp`) è in SECONDI INTERI e senza identificativo casuale, quindi due firme dello stesso
    // percorso nello stesso secondo sono identiche byte per byte. Fra l'apertura e il rinnovo passano in CI poche
    // centinaia di millisecondi: senza questa pausa «un URL diverso» sarebbe vero un giro su due. Con la pausa
    // l'`iat` cambia di certo, e l'asserzione prova ciò che deve — che il rinnovo FIRMA DI NUOVO invece di
    // restituire l'URL di prima.
    await new Promise((risolvi) => setTimeout(risolvi, 1_100));
    const rinnovo = await anonimo.post('/api/video-uploads/rinnovo', { headers: { [INTESTAZIONE_RINNOVO]: token }, timeout: 90_000 });
    expect(rinnovo.status()).toBe(200);
    const corpo = (await rinnovo.json()) as {
      stato: string;
      caricamento: IntentoAperto['job']['caricamento'];
      scadeIl: string;
    };
    expect(corpo.stato).toBe('da-caricare');
    const nuovo = coordinatePut(corpo.caricamento);
    // Il confronto è fra due booleani e non `expect(nuovo.url).not.toBe(primo.url)`: se cadesse, quel messaggio
    // stamperebbe l'URL firmato (una credenziale di scrittura) nel rapporto della CI.
    expect(nuovo.url !== primo.url, 'un URL firmato di nuovo, non quello di prima').toBe(true);
    expect(
      Math.abs(Date.parse(corpo.scadeIl) - Date.parse(aperto.job.rinnovo?.scadeIl ?? '')),
      'la scadenza è quella del TOKEN, immutata dal rinnovo (non si allunga rinnovando)',
    ).toBeLessThan(1_000);

    // ── L'URL nuovo funziona: il file arriva, il job entra in coda. ──────────────────────────────────
    const put = await anonimo.put(nuovo.url, { headers: nuovo.intestazioni, data: file, timeout: 120_000 });
    expect(put.status(), 'la PUT sull\'URL rinnovato deve riuscire').toBe(200);
    await attendiStatoJob(db, aperto.jobId, 'queued', 'il trigger d\'arrivo non ha portato il job in coda dopo la PUT sull\'URL rinnovato');

    // ── L'URL VECCHIO, a file arrivato: rifiutato come duplicato, come l'altro (esiste già l'oggetto, e niente upsert). ──
    const vecchio = await anonimo.put(primo.url, { headers: primo.intestazioni, data: videoFinto(file.length + 1024), timeout: 120_000 });
    await attendiDuplicato(vecchio, 'anche l\'URL di prima non sovrascrive: l\'originale è già arrivato');

    const dopo = await anonimo.post('/api/video-uploads/rinnovo', { headers: { [INTESTAZIONE_RINNOVO]: token }, timeout: 90_000 });
    expect(await dopo.json()).toEqual({ stato: 'arrivato' });
  } finally {
    await anonimo.dispose();
  }
});

test('rinnovo: un video ritirato dall\'insegnante risponde `annullato`, senza un URL', async ({ request, playwright, baseURL }) => {
  test.setTimeout(120_000);
  // `storageState` VUOTO, scritto: senza, Playwright passa al contesto i default del progetto (`test.use`), cioè i cookie
  // della docente, e un rinnovo che leggesse l'identità invece del token resterebbe verde (secondario #195).
  const anonimo = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  expect((await anonimo.get('/api/me')).status(), 'il contesto «anonimo» ha una sessione').toBe(401);
  try {
    const aperto = await apriNativo(request, videoFinto(16 * 1024));
    const token = aperto.job.rinnovo?.token ?? '';

    // L'insegnante ritira l'invio PRIMA che il file parta (il pulsante «Rimuovi»: legge la revisione di adesso e
    // la annulla con `PATCH … annulla`: la revisione cambia a ogni passo del ciclo, e indovinarla è un 409).
    const stato = await request.get(`/api/video-uploads/${aperto.intentId}`, { timeout: 60_000 });
    expect(stato.status()).toBe(200);
    const { revisione } = (await stato.json()) as { revisione: number };
    const annullo = await request.patch(`/api/video-uploads/${aperto.intentId}`, {
      data: { azione: 'annulla', revisione },
      timeout: 60_000,
    });
    expect(annullo.status(), `PATCH annulla → ${annullo.status()}`).toBe(200);
    expect(((await annullo.json()) as { statoIntent: string }).statoIntent).toBe('cancelled');

    // L'app, che non lo sa, chiede un URL nuovo: le si risponde `annullato` — e non le si dà l'URL.
    const risposta = await anonimo.post('/api/video-uploads/rinnovo', { headers: { [INTESTAZIONE_RINNOVO]: token }, timeout: 90_000 });
    expect(risposta.status()).toBe(200);
    const corpo = (await risposta.json()) as Record<string, unknown>;
    expect(corpo).toEqual({ stato: 'annullato' });
    expect(Object.keys(corpo), 'nessun URL di caricamento per un token revocato').not.toContain('caricamento');
  } finally {
    await anonimo.dispose();
  }
});

test('apertura: il trasporto nativo pretende lo sha256 di ogni file e il TUS non lo ammette (400, e non nasce nessun intento)', async ({ request }) => {
  test.setTimeout(120_000);
  const db = clienteDatabaseCi();
  const file = videoFinto(8 * 1024);

  const intentiPrima = await db.from('video_intents').select('id', { count: 'exact', head: true }).eq('owner_id', IDS.DOCENTE);
  expect(intentiPrima.error).toBeNull();

  const senzaImpronta = await apriIntentoVideo(request, {
    file,
    nome: nomeVideoUnico('senza-sha'),
    tag: [IDS.A1],
    trasporto: 'put-nativo',
    sha256: null,
  });
  expect(senzaImpronta.status(), 'put-nativo senza sha256 è un 400 di validazione').toBe(400);

  const conImprontaInTus = await apriIntentoVideo(request, {
    file,
    nome: nomeVideoUnico('sha-in-tus'),
    tag: [IDS.A1],
    trasporto: 'tus',
    sha256: 'a'.repeat(64),
  });
  expect(conImprontaInTus.status(), 'lo sha256 col TUS è un 400 di validazione').toBe(400);

  const intentiDopo = await db.from('video_intents').select('id', { count: 'exact', head: true }).eq('owner_id', IDS.DOCENTE);
  expect(intentiDopo.count, 'due rifiuti di validazione non aprono niente').toBe(intentiPrima.count);
});
