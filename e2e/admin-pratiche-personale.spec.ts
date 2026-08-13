import { test, expect, type APIRequestContext } from '@playwright/test';
import { IDS, PERSONALE_E2E, STORAGE, attendiFineCaricamento } from './fixtures';
import itAdmin from '../messages/it/adminAltro.json';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  L'APPROVAZIONE DI UN'ANAGRAFICA DEL PERSONALE, dal cockpit di Segreteria ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `/admin/modulistica?tab=personale` → si trova la pratica, si apre, si approva.
 * È il gesto che trasforma un modulo pubblico in anagrafica vera e — se quella
 * persona non ha ancora un accesso — glielo apre: la metà del percorso che
 * `public-anagrafica-personale.spec.ts` non tocca.
 *
 * ─── LA PRATICA SE LA CREA QUESTO SPEC, ED È UNA DECISIONE ─────────────────
 * Non si riusa quella dello spec pubblico. L'ordine dei file di Playwright non è
 * garantito: contarci significherebbe scrivere un test che passa o fallisce a
 * seconda di come la suite viene raccolta, e che davanti a un rosso non dice se il
 * difetto è qui o nell'altro file. La pratica nasce da un POST vero
 * (`/api/iscrizione/personale`), cioè dalla stessa porta da cui arriva in
 * produzione — non da un INSERT che scavalcherebbe le difese della rotta.
 *
 * L'indirizzo è `PERSONALE_E2E.emailApprovazione`, DIVERSO da quello del percorso
 * pubblico: l'indice `pratiche_personale_email_viva` è unico sugli stati vivi, e
 * due spec che usassero la stessa email si contenderebbero la stessa riga — il
 * secondo invio riceverebbe **201 con l'id del primo** (la rotta traduce così il
 * doppione), e questo test approverebbe la pratica dell'altro spec.
 *
 * ─── IL TETTO ──────────────────────────────────────────────────────────────
 * `POST /api/iscrizione/personale` ammette 20 invii l'ora per IP e in CI i browser
 * escono da un IP solo: con `retries: 2` questo blocco ne consuma fino a 3. Porta
 * `@solo-chromium` perché il progetto `webkit` non lo ripeta (`grepInvert` in
 * `playwright.config.ts`); questo file non rientra comunque in
 * `SPEC_CRITICI_WEBKIT`, che nomina quattro percorsi e non questo.
 */

/** L'anagrafica che verrà approvata. Vedi il commento sul codice fiscale. */
const NOME = 'Rita';
const COGNOME = 'Approvazione-E2E';

/**
 * ⚠️ CARATTERE DI CONTROLLO VALIDO, altrimenti la rotta BLOCCA con un 400 sul
 * campo (`validaCodiceFiscale` verifica il checksum, ed è l'unico dei due controlli
 * sul codice fiscale che ferma l'invio).
 *
 * Ricavato il 12/08/2026 da `calcolaCodiceFiscale` (`@/lib/fiscale/calcolo`) sui
 * dati qui sotto — Rita · Approvazione-E2E · F · 1979-03-04 · F839 (NAPOLI) — con
 * un test usa-e-getta: si scrive un `expect(calcolaCodiceFiscale({…})).toBe('X')`,
 * si legge il valore dal fallimento e si cancella il file. Chi cambia uno di quei
 * cinque dati rifaccia il conto: un codice ricopiato a memoria è un 400 che
 * sembrerà un difetto del cockpit.
 */
const CODICE_FISCALE = 'PPRRTI79C44F839B';

/** Il nome del plesso che il seed rende visibile ai moduli pubblici. */
const SEDE_COLLAUDO = 'Plesso di Collaudo';

/** Le scansioni: un PDF minimo costruito qui, mai un file su disco. Vale per entrambe le facce. */
const PDF_MINIMO = Buffer.from(
  '%PDF-1.4\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/MediaBox[0 0 99 99]/Parent 2 0 R>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8',
);

/**
 * La scadenza del documento, CALCOLATA: una data fissa nel futuro invecchia, e
 * sotto i 90 giorni la riga d'elenco cambia badge («Scade fra N giorni»). Il test
 * diventerebbe rosso da solo, un giorno, senza che nessuno abbia toccato il
 * prodotto. Cinque anni stanno oltre ogni soglia e oltre il minimo della tabella
 * (`document_expiry > 1990-01-01`).
 */
const SCADENZA_ISO = `${new Date().getFullYear() + 5}-12-31`;

/**
 * Carica UNA faccia del documento e restituisce il percorso che la rotta le assegna.
 *
 * Il percorso nel bucket lo decide il server (`documenti/<uuid>/<uuid>.<ext>`): due
 * chiamate danno due percorsi DIVERSI anche a parità di contenuto, ed è ciò che rende
 * questa funzione riusabile per il fronte e per il retro.
 */
async function caricaFaccia(request: APIRequestContext, faccia: string): Promise<string> {
  const upload = await request.post('/api/iscrizione/personale/upload', {
    // Il modulo manda anche `folder`; la rotta lo IGNORA di proposito (il percorso
    // nel bucket lo decide lei, ed è la ragione per cui un anonimo non può
    // scegliere dove finisce il file). Qui si manda il solo campo che conta.
    multipart: {
      file: { name: `documento-${faccia}.pdf`, mimeType: 'application/pdf', buffer: PDF_MINIMO },
    },
  });
  expect(upload.status(), `la scansione «${faccia}» non è stata accettata`).toBe(200);
  const percorso = ((await upload.json()) as { path?: unknown }).path;
  expect(typeof percorso, `la rotta di caricamento non ha restituito un percorso per «${faccia}»`)
    .toBe('string');
  return String(percorso);
}

/**
 * Manda una pratica dalla PORTA PUBBLICA e restituisce il suo id.
 *
 * TRE richieste, e l'ordine non è invertibile: le scansioni vanno caricate PRIMA,
 * perché l'invio non porta file ma PERCORSI, e la rotta accetta solo un percorso che
 * trova nel registro dei caricamenti (`caricamenti_personale`). Un percorso inventato
 * — la forma è pubblica, sta in questo repository — prende un 400 sul campo del
 * documento.
 *
 * ─── DUE FACCE, E SONO DUE CARICAMENTI SEPARATI ────────────────────────────
 * Dal 12/08/2026 il documento d'identità è fronte E retro: la migrazione
 * `20260812194501` ha rinominato `documento_path` in `documento_fronte_path` e ha
 * aggiunto `documento_retro_path`, e `PERSONALE_FIELDS` li dichiara ENTRAMBI
 * `required: true`. Questo spec mandava ancora il nome vecchio e nessuno dei due
 * nuovi: `validatePage` (`src/lib/forms/validate-fields.ts`) risponde «Campo
 * obbligatorio» su un campo `required` vuoto, quindi il POST prendeva **400** dove
 * questa funzione pretende 201 — cioè l'unico collaudo end-to-end dell'approvazione
 * sarebbe andato in rosso in CI, e non per un difetto del prodotto.
 *
 * ⚠️ I DUE PERCORSI DEVONO ESSERE DIVERSI, e non è una raffinatezza del test: la
 * rotta rifiuta due facce uguali (`documento-facce-uguali`) perché allegare due volte
 * la stessa foto è il modo più facile di «finire» il modulo lasciando la Segreteria
 * senza il retro e senza nessuna riga che lo dica. Due caricamenti separati bastano:
 * il percorso lo costruisce il server con due uuid nuovi ogni volta.
 *
 * ⚠️ IL TETTO DEI CARICAMENTI. `POST …/upload` ammette 30 richieste ogni 10 minuti per
 * IP — `TETTO_UPLOAD_PERSONALE`, che dal 13/08/2026 è il contatore di questa porta e non
 * più il numero condiviso con le due porte delle famiglie (tornate a 20).
 * In CI i browser escono da un IP solo: qui se ne consumano 2 per tentativo, cioè
 * fino a 6 con `retries: 2`. Restano dentro anche sommandoci lo spec pubblico, che ne
 * usa 2 per tentativo sulla stessa finestra.
 */
async function inviaPratica(request: APIRequestContext): Promise<string> {
  const frontePath = await caricaFaccia(request, 'fronte');
  const retroPath = await caricaFaccia(request, 'retro');
  expect(retroPath, 'le due facce hanno lo stesso percorso: la rotta le rifiuterebbe')
    .not.toBe(frontePath);

  const creazione = await request.post('/api/iscrizione/personale', {
    data: {
      // ⚠️ LA SEDE SI DICHIARA. `scuola_id` è obbligatorio e la rotta lo valida
      // contro `sediReali`: è l'unica sede della CI che quel predicato accetta.
      scuola_id: IDS.SCUOLA_COLLAUDO,
      data: {
        nome: NOME,
        cognome: COGNOME,
        gender: 'F',
        birth_date: '1979-03-04',
        // Il codice catastale è OBBLIGATORIO: senza, il codice fiscale non è
        // verificabile da nessuno. Comune e provincia per esteso sono facoltativi
        // e si mandano perché il cockpit possa leggersi senza risolvere `F839`.
        codice_belfiore_nascita: 'F839',
        birth_place: 'NAPOLI',
        birth_province: 'NA',
        birth_nation: 'Italia',
        fiscal_code: CODICE_FISCALE,
        citizenship: 'Italiana',
        address: 'Via Roma',
        residence_street_number: '12',
        residence_city: 'Giugliano in Campania',
        residence_province: 'NA',
        zip_code: '80014',
        email: PERSONALE_E2E.emailApprovazione,
        telefono: '+39 333 7654321',
        document_type: 'CI',
        document_number: 'CD7654321',
        document_expiry: SCADENZA_ISO,
        // I due campi si chiamano come le due COLONNE: in questo repo
        // `PERSONALE_FIELDS[].id` è il nome della colonna di destinazione, ed è la
        // ragione per cui la migrazione ha rinominato invece di affiancare.
        documento_fronte_path: frontePath,
        documento_retro_path: retroPath,
        titolo_studio: 'laurea_magistrale',
        gradi: ['infanzia'],
        // Le tre prese visione sono OBBLIGATORIE: senza, la rotta risponde 400 con
        // `consensi: [...]`. Non sono consensi al trattamento — fra datore e
        // dipendente non sarebbero liberi — ma la prova che l'informativa è stata
        // data al punto di raccolta (art. 13).
        presa_visione_informativa_personale: true,
        dichiarazione_veridicita: true,
        presa_visione_copia_documento: true,
      },
      // L'esca, VUOTA: piena vale come «chi ha mandato la richiesta non stava
      // guardando il modulo» e la rotta risponde 400 senza dire perché.
      sito_web: '',
    },
  });
  expect(creazione.status(), 'la pratica non è stata registrata').toBe(201);
  const id = ((await creazione.json()) as { id?: unknown }).id;
  expect(typeof id).toBe('string');
  return String(id);
}

test.describe('cockpit delle anagrafiche del personale @solo-chromium', () => {
  /*
   * `adminTutteLeSedi` e non `admin`: la pratica nasce sul «Plesso di Collaudo»
   * (è la sede che i moduli pubblici vedono), mentre `STORAGE.admin` dichiara la
   * sede principale nel cookie `sedi_attive` — e `resolveScuoleAttive` scopa
   * ogni lettura di questa route con quel cookie. Da lì la pratica sarebbe fuori
   * scope, legittimamente. Qui serve lo stato «Tutte le sedi», che è quello di
   * una Segreteria che guarda la posta di tutti i plessi. Vedi `auth.setup.ts`.
   */
  test.use({ storageState: STORAGE.adminTutteLeSedi });

  test('la Segreteria trova la pratica, la approva e l’anagrafica risulta registrata', async ({
    page,
    request,
  }) => {
    test.slow();

    const idPratica = await inviaPratica(request);

    // `?tab=personale` è un collegamento profondo SUPPORTATO: la pagina legge
    // `tab` e apre la linguetta giusta (`admin/modulistica/page.tsx`), ed è
    // l'indirizzo che la notifica di ogni nuovo invio manda alla Segreteria. Se
    // quella parola sparisse dall'elenco riconosciuto, ogni avviso aprirebbe
    // «Moduli inviabili» — la linguetta sbagliata, senza nessun errore.
    await page.goto('/admin/modulistica?tab=personale');
    await attendiFineCaricamento(page);
    await expect(page.getByText(itAdmin.pratIntro)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(itAdmin.pratListaHeader)).toBeVisible({ timeout: 30_000 });

    // Il nome in tabella è un COLLEGAMENTO vero (`?tab=personale&pratica=<id>`),
    // non una riga cliccabile: si apre col clic, si raggiunge da tastiera e si
    // può incollare in chat.
    //
    // ⚠️ Si cerca per `href`, cioè per ID, e non per nome: al secondo tentativo di
    // un run (`retries: 2`) può esistere una pratica OMONIMA — quella del
    // tentativo precedente, se era arrivato fino all'approvazione — e due
    // collegamenti con lo stesso nome farebbero fallire il locator in modalità
    // stretta, oppure, peggio, aprirebbero la pratica sbagliata. L'id è l'unica
    // chiave che identifica la riga appena creata.
    const riga = page.locator(`a[href*="pratica=${idPratica}"]`);
    await expect(riga).toBeVisible({ timeout: 20_000 });
    await expect(riga).toHaveText(`${NOME} ${COGNOME}`);
    await riga.click();

    // Il pannello è un `role="dialog" aria-modal="true"`: da qui in poi ciò che
    // sta fuori è escluso dall'albero di accessibilità, ed è la ragione per cui
    // errori ed esiti vivono DENTRO.
    const pannello = page.getByRole('dialog');
    // `.first()`: la sede si legge sotto il titolo del pannello e ricomparirà nel
    // riquadro di conferma («…sulla sede X»). Qui interessa che ci sia, e che sia
    // quella giusta — non quante volte è scritta.
    await expect(pannello.getByText(SEDE_COLLAUDO).first()).toBeVisible({ timeout: 20_000 });
    await expect(pannello.getByText(CODICE_FISCALE)).toBeVisible();

    await pannello.getByRole('button', { name: itAdmin.pratApprova, exact: true }).click();

    // La conferma NOMINA ciò che sta per succedere — la persona, la sede e l'email
    // con cui l'accesso verrà aperto. È l'unica difesa fra un modulo anonimo e la
    // riscrittura dell'anagrafica di una collega, quindi si pretende che ci sia
    // PRIMA di premere «Confermo».
    await expect(pannello.getByText(itAdmin.pratConfermaApprovaTitolo)).toBeVisible();
    // `.first()`: l'email compare due volte a pannello aperto — nella riga
    // «Contatti» del dettaglio e dentro la conferma, che dichiara con quale
    // indirizzo verrà aperto l'accesso.
    await expect(pannello.getByText(PERSONALE_E2E.emailApprovazione).first()).toBeVisible();

    // La risposta si ascolta PRIMA di premere: registrata dopo il click,
    // `waitForResponse` perde le risposte veloci. Il confronto è sul percorso INTERO e
    // sul METODO: subito dopo l'approvazione la pagina rilegge l'elenco e la scheda con
    // due GET sullo STESSO percorso, e un `includes` prenderebbe la prima che passa.
    const approvazione = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/admin/pratiche-personale' &&
        r.request().method() === 'PATCH',
    );
    await pannello.getByRole('button', { name: itAdmin.pratConferma, exact: true }).click();

    // «Anagrafica registrata» e non «presa in carico»: il secondo è il titolo che
    // compare quando l'approvazione resta a metà (`in_approvazione`), ed è
    // esattamente l'esito che questo test NON deve accettare.
    await expect(pannello.getByText(itAdmin.pratEsitoApprovata)).toBeVisible({ timeout: 30_000 });
    await expect(pannello.getByText(itAdmin.pratEsitoPresaInCarico)).toHaveCount(0);

    // ── L'APPROVAZIONE DICHIARA IL RILASCIO, FACCIA PER FACCIA ──────────────
    //
    // Dal 12/08/2026 l'approvazione risponde `documentiRilasciati: {fronte, retro}` —
    // DUE booleani e non uno, perché il travaso di una faccia può riuscire e quello
    // dell'altra no, e il pannello deve poter nascondere un pulsante e tenere l'altro
    // (che è l'unica strada rimasta verso l'unica copia raggiungibile di quel file). La
    // rotta conta apposta `documento_rilasciato_a_meta`: è lo stato in cui una scansione
    // resta nel bucket senza che nessuna riga la nomini più.
    //
    // Non si pretende `true`, ed è una scelta sullo stato del database della CI. Quel
    // progetto è separato dalla produzione e si migra A MANO (`migrate-ci.yml`,
    // `workflow_dispatch`): finché la migrazione `20260812194501` non ci è passata,
    // `pratiche_personale` non ha le due colonne, l'INSERT del modulo pubblico degrada e
    // la pratica nasce SENZA percorsi — quindi all'approvazione non c'è niente da
    // travasare e `{fronte: false, retro: false}` è la risposta onesta. Pretendere `true`
    // farebbe di questo blocco una misura dello stato di migrazione del DB della CI
    // travestita da collaudo del prodotto: rossa, e per la ragione sbagliata.
    const corpoApprovazione = (await (await approvazione).json()) as {
      documentiRilasciati?: { fronte?: unknown; retro?: unknown };
    };
    const rilasciati = corpoApprovazione.documentiRilasciati;
    // LA CHIAVE DEVE ESSERCI, e non è una formalità: il pannello legge
    // `documentiRilasciati?.fronte !== false`, quindi un oggetto ASSENTE non vale come
    // rifiuto ma come rilascio. Se la rotta smettesse di mandarlo, la pagina si
    // comporterebbe come se le scansioni fossero passate al fascicolo e nessun `false`
    // resterebbe a smentirla — un difetto che nessuna schermata mostra. QUESTA è la
    // promessa del prodotto che questo blocco collauda.
    expect(typeof rilasciati?.fronte, 'la risposta non dichiara il rilascio del fronte').toBe(
      'boolean',
    );
    expect(typeof rilasciati?.retro, 'la risposta non dichiara il rilascio del retro').toBe(
      'boolean',
    );

    // ⚠️ QUI C'ERA `expect(rilasciati.retro).toBe(rilasciati.fronte)`, chiamata
    // «l'invariante che il prodotto promette». IL PRODOTTO NON LA PROMETTE, ed è scritto
    // nella rotta: `pratiche-personale/route.ts` calcola apposta
    // `documento_rilasciato_a_meta: fronte !== retro`, e il commento accanto descrive lo
    // stato disallineato come la conseguenza NORMALE di un DB a cui manchi UNA sola delle
    // due colonne — «ogni faccia risponde per sé», perché azzerarle insieme cancellerebbe
    // il riferimento al file non travasato. Una rotta che conta un caso non lo vieta.
    //
    // In pratica quell'uguaglianza è vera perché il rinomino e i due `add column` stanno
    // nella STESSA transazione di `20260812194501` (`begin;` … `commit;`, verificato): un
    // database ha entrambe le colonne o nessuna. Cioè era vera per lo stato dello schema,
    // non per una promessa del codice — esattamente il genere di misura sullo stato di
    // migrazione della CI travestita da collaudo del prodotto che il commento due righe
    // sopra dichiara di voler evitare pretendendo `true`.
    //
    // La difesa vera sul travaso a metà non è un'asserzione di uguaglianza: è
    // `documento_rilasciato_a_meta` in `app_log`, che quel caso lo CONTA invece di
    // negarlo, ed è ciò che permetterà di accorgersene su un DB reale disallineato.

    // ── L'EFFETTO, non il messaggio ─────────────────────────────────────────
    // Il riquadro d'esito è una schermata: la prova è la riga. Si rilegge dal
    // server la stessa pratica, per id, e si pretende lo stato che l'approvazione
    // deve aver scritto — sulla sede giusta, che è l'errore che questo prodotto
    // teme di più (archiviare nel plesso sbagliato in silenzio).
    const dopo = await request.get(`/api/admin/pratiche-personale?id=${idPratica}`);
    expect(dopo.status()).toBe(200);
    const corpo = (await dopo.json()) as {
      data?: { stato?: string; scuola_id?: string; email?: string };
    };
    expect(corpo.data?.stato).toBe('approvata');
    expect(corpo.data?.scuola_id).toBe(IDS.SCUOLA_COLLAUDO);
    expect(corpo.data?.email).toBe(PERSONALE_E2E.emailApprovazione);
  });
});
