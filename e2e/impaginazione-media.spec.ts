import { test, expect, type Locator, type Page } from '@playwright/test';
import { STORAGE, IDS, attendiFineCaricamento } from './fixtures';
import { sondaImpaginazione, type EsitoImpaginazione } from './lib/sonda-impaginazione';

/**
 * CRAWLER DI IMPAGINAZIONE — le due gallerie a 390×844, misurate in pixel veri.
 *
 * ─── IL BUCO CHE CHIUDE ─────────────────────────────────────────────────────
 * Il 2026-09-11, in `__tests__/`, non esisteva UNA SOLA asserzione su `grid-cols`,
 * `aspect-square`, `object-cover` o `<video>`: i test girano in jsdom, che non ha
 * layout — `getBoundingClientRect` restituisce zeri — quindi nessuno di loro
 * poteva vedere le tre cose che sono arrivate in produzione col gate verde:
 *  · tre pillole da ~486 px dentro una colonna da 358, con `justify-center`:
 *    l'eccesso si divideva fra i due lati, ~48 px tagliati a sinistra e ~48 a
 *    destra — cioè metà del primo comando e metà dell'ultimo;
 *  · il pulsante «Elimina» del visore che cadeva ~80 px sotto il bordo inferiore,
 *    in un contenitore che non scorreva: irraggiungibile, non «scomodo»;
 *  · un video verticale allargato alla colonna e guarnito di due fasce nere,
 *    perché `w-full` senza rapporto d'aspetto fa decidere l'altezza al file.
 * Nessuna di queste è un difetto di logica: sono tre rettangoli nel posto
 * sbagliato, e si vedono solo aprendo un browser vero alla larghezza vera.
 *
 * ─── ⚠️ LA PRIMA VERSIONE DI QUESTO CRAWLER ERA VERDE SULLE PILLOLE ─────────
 * Va letto prima del resto, perché è la ragione della forma che questo file ha
 * oggi. Misurato il 2026-09-12 in Chromium e in WebKit, eseguendo la sonda estratta
 * dal file su una pagina che riproduce la struttura del visore:
 *
 *   1. la sonda non girava affatto: leggeva `TOLLERANZA` dal modulo, e
 *      `page.evaluate` serializza la funzione → `ReferenceError` sui due motori.
 *      Per questo la tolleranza oggi ARRIVA COME ARGOMENTO;
 *   2. corretto quello, restava VERDE con mezza pillola fuori schermo. Il
 *      contenitore del visore è `absolute inset-0 overflow-y-auto` dentro un
 *      `fixed inset-0`: il CSS gli porta l'asse X ad `auto` (un asse `visible`
 *      accanto a un asse che non lo è computa ad `auto`), quindi RITAGLIA, e il suo
 *      rettangolo coincide col viewport. La prima pillola, `−48 … 78` di suo,
 *      usciva dal ritaglio come `0 … 78`: dentro i bordi. E la pagina non scorreva,
 *      perché tutto sta in un `fixed`: `scrollWidth` = `clientWidth` = 390.
 *
 * L'unico testimone era `scrollWidth` **dello scorrimento** — 438 contro 390 — e
 * nessuno lo leggeva. Da lì le due misure in più (2b e 2c qui sotto). La sonda vive
 * in `e2e/lib/sonda-impaginazione.ts` e `__tests__/architecture/sonda-impaginazione.test.ts`
 * la esegue in locale su quelle geometrie: se un giorno smettesse di vederle, è
 * rosso in vitest, non in un giro di CI.
 *
 * ─── LE CINQUE MISURE ───────────────────────────────────────────────────────
 *  1  la pagina non scorre di lato (`scrollWidth <= clientWidth`);
 *  2a niente sporge dai 390 px del telefono;
 *  2b nessun contenitore SCORRE DI LATO senza averlo chiesto — cioè nessuno sta
 *     nascondendo comandi a destra di un bordo che non si vede;
 *  2c nessun COMANDO è tagliato dal proprio contenitore (l'unica che vede lo
 *     sfondamento a SINISTRA: in LTR `scrollWidth` cresce solo a destra);
 *  3  il visore scorre e il suo ultimo comando è raggiungibile;
 *  4  il `<video>` dichiara il rapporto d'aspetto o un tetto d'altezza.
 * Le misure 1, 2a, 2b e 2c girano DUE volte: sulla griglia e col visore aperto.
 *
 * ─── PERCHÉ WEBKIT, E PERCHÉ 390×844 ────────────────────────────────────────
 * L'app dei genitori è una WebView WebKit (Capacitor) su un telefono. Misurare
 * queste due schermate a 1440 px sarebbe misurare uno schermo che nessuno usa, e
 * misurarle su Chromium soltanto lascerebbe fuori proprio il motore su cui girano:
 * `svh`, `env(safe-area-inset-*)` e l'altezza sotto la barra di Safari si
 * comportano diversamente lì, e sono esattamente le unità con cui il visore è
 * stato riparato. Lo spec è quindi nella regex `SPEC_CRITICI_WEBKIT` di
 * `playwright.config.ts` — dove il lock `e2e-webkit-installato.test.ts` APPLICA
 * quella regex agli spec reali, così la riga non può smettere di selezionare
 * niente in silenzio.
 *
 * ─── PERCHÉ NON SCREENSHOT DI REGRESSIONE ───────────────────────────────────
 * È la tentazione ovvia («una foto e si vede tutto») e va scartata per scritto,
 * così nessuno ci torna:
 *  · servirebbero baseline BINARIE per motore e per versione. Questo spec gira su
 *    due progetti (chromium e webkit): due serie di immagini, e un `npm i` che
 *    alza Playwright — cioè che porta un WebKit nuovo con un antialiasing diverso
 *    — le invalida IN BLOCCO;
 *  · il primo fallimento sarebbe quindi un aggiornamento di browser e non un
 *    difetto, e la risposta imparata sarebbe `--update-snapshots`: le immagini si
 *    riscriverebbero senza che nessuno le guardi, e il giorno in cui il pulsante
 *    torna fuori schermo la baseline lo assorbirebbe insieme all'antialiasing;
 *  · e un rosso dice «due immagini differiscono», non COSA è rotto. `scrollWidth
 *    438 > 390` dice quanto e dove, e si legge dal log senza scaricare artefatti.
 * Una soglia numerica è deterministica e nomina il difetto. Le immagini no.
 *
 * ─── COSA NON FINISCE MAI NEL RAPPORTO, E NON È UN DETTAGLIO ────────────────
 * Questo spec stampa la FIRMA degli elementi fuori posto, e la firma è composta
 * SOLO da: nome del tag, `data-testid`, classi CSS, numeri. Mai `textContent`,
 * mai `alt`, mai `title`, mai `aria-label`, mai `src`. Le ragioni sono due e
 * valgono entrambe:
 *  · il nome accessibile di una card di galleria è `etichettaCard()`, cioè
 *    «Foto: <didascalia>» — e la didascalia di una foto in questo prodotto è il
 *    nome del file, che spesso contiene il nome di un bambino;
 *  · il `src` di un media è un URL FIRMATO a tempo sul bucket privato: è una
 *    credenziale, e i log della CI di un repository pubblico si leggono da fuori.
 * Classi e `data-testid` sono codice, e stanno già nel repo.
 */

/**
 * `retries: 0`, dichiarato nello SPEC e non nel progetto.
 *
 * La ragione è la stessa scritta per il crawler di contrasto in
 * `playwright.config.ts`: un overflow non è un caso. Un elemento larga 486 px in
 * una colonna da 358 è larga 486 px anche al terzo tentativo, e un pulsante fuori
 * dal viewport non ci rientra riprovando. Con i ripescaggi accesi un rosso su tre
 * passerebbe per verde e nessuno conta i ripescati — è successo in questo repo il
 * 24/08 e l'01/09, due job «success» con dentro dei falliti.
 *
 * ⚠️ Sta QUI e non nel progetto `webkit` perché quel progetto esegue anche altri
 * quattro spec (login, home, pagamenti, iscrizione) che sui `retries: 2` della
 * config contano: togliere i ripescaggi a loro sarebbe un cambiamento di un altro
 * lavoro, deciso di nascosto in questo. `test.describe.configure` a livello di
 * file vale in OGNI progetto che raccoglie questo spec, che è precisamente la
 * proprietà che serve.
 */
test.describe.configure({ retries: 0 });

/** iPhone 13/14/15 in verticale: la misura su cui la galleria è stata riparata. */
const IPHONE = { width: 390, height: 844 } as const;

/**
 * Un pixel di tolleranza, e non più.
 *
 * `getBoundingClientRect` restituisce frazioni (un `gap-3` su tre colonne non è
 * un intero), e lo zoom di un dispositivo sposta i bordi di qualche centesimo.
 * Un pixel assorbe l'arrotondamento; due comincerebbero ad assorbire i difetti.
 *
 * ⚠️ Viaggia dentro le OPZIONI della sonda, non come chiusura: vedi il punto 1
 * della testata. `page.evaluate(sonda, { tolleranza: TOLLERANZA })`.
 */
const TOLLERANZA = 1;

/* ────────────────────────────────────────────────────────────────────────────────
 * I PAVIMENTI — la parte che impedisce a questo crawler di essere VERDE SUL VUOTO.
 *
 * ⚠️ È il rischio principale di tutto lo spec, e va detto prima di leggerlo.
 * `MediaGrid` condiziona all'URL FIRMATO sia la miniatura (`item.file_url ?`) sia
 * il `<video>` del visore (`!urlVisore ?`): quando la firma non riesce, al posto
 * dei media compare un segnaposto «anteprima non disponibile» — e un crawler che
 * cerca overflow su tre segnaposti quadrati non trova niente, per sempre, con
 * l'aria di funzionare. Fino al 2026-09-11 il seed inseriva media il cui file NON
 * ESISTE nel bucket (lo dice un commento in `scripts/seed-e2e.mjs`), e
 * `ensureBuckets` non creava affatto il bucket `gallery`: su quel seed queste
 * misure erano tutte vacuamente vere.
 *
 * Perciò le prime asserzioni di ogni test non sono le misure: sono le PREMESSE.
 * Sono PAVIMENTI (`>=`), non fotografie: se il seed cresce non è un rosso, se
 * scende sotto il minimo il crawler non ha niente da misurare e lo dice invece di
 * dichiarare successo.
 * ──────────────────────────────────────────────────────────────────────────────── */

/** Le tre righe che il seed mette nella Girasoli della sede 1 (foto, foto verticale, video). */
const CARD_MINIME = 3;
/** Quante card si aprono al massimo: il costo cresce linearmente, la prova no. */
const CARD_ISPEZIONATE = 4;
/**
 * Elementi con area visibile che il crawler deve trovare su una schermata vera.
 * Il guscio SSR da solo ne vale poche decine: sotto questo numero si sta misurando
 * una pagina che non ha caricato.
 */
const ELEMENTI_MINIMI = 40;
/**
 * A visore aperto: almeno UN contenitore che scorre in orizzontale e almeno UN
 * comando confrontato col proprio ritaglio.
 *
 * Sono i pavimenti delle due misure NUOVE, e senza di loro sarebbero verdi per
 * costruzione — che è esattamente il difetto da cui nascono. Il contenitore è
 * `visore-scorrimento` (`overflow-y-auto` porta l'asse X ad `auto`: misurato sui
 * due motori); i comandi sono Scarica/Condividi/Segnala lato genitore (la pagina
 * passa `showActions`), Elimina lato docente (che non lo passa). Se uno dei due
 * scende a zero non è «il visore è pulito»: è che il visore non è in scena, o che
 * la sonda non lo vede più.
 *
 * ⚠️ Il pavimento sui comandi è raggiungibile perché questa misura gira DOPO la
 * 3c, che ha già portato in vista l'ultimo comando con `scrollIntoView`: la sonda
 * conta solo i comandi in scena verticalmente, e in una colonna più alta della
 * finestra a scorrimento zero potrebbero essere tutti sotto la piega. Invertire le
 * due misure renderebbe questo pavimento un rosso intermittente.
 */
const CONTENITORI_VISORE_MINIMI = 1;
const COMANDI_VISORE_MINIMI = 1;

/**
 * ECCEZIONI — vuota, e la baseline dichiarata è ZERO su tutte e tre le misure.
 *
 * Il crawler di contrasto confronta un CONTEGGIO con una baseline positiva, perché
 * scopa nove schermate intere di un prodotto che nessuno aveva mai misurato: là un
 * numero è l'unico modo di dichiarare un debito preesistente senza spegnere la
 * sonda. Qui lo scopo sono DUE schermate, ed è lo scopo del lavoro che le ha
 * appena riparate: l'unica baseline onesta è zero. Un numero positivo qui
 * significherebbe «un comando tagliato a metà va bene, purché resti uno solo».
 *
 * Se la CI trovasse qualcosa che appartiene a un altro lavoro, la strada è
 * aggiungerlo QUI con la sua firma, la misura che lo ha visto e la sua ragione —
 * mai alzare un numero, mai allargare la tolleranza. Il messaggio del rosso stampa
 * le firme con i bordi misurati: un giro di CI basta a triagare.
 *
 * ⚠️ Un carosello VOLONTARIO non va messo qui: la sonda lo riconosce da sola,
 * perché lo scorrimento orizzontale è dichiarato nel suo `className`
 * (`overflow-x-auto`, `overflow-auto`, `snap-x`, `kv-table-scroll`) — come il
 * selettore figlio e le tabelle larghe. Questa lista serve al debito, non al
 * progetto: ci va solo ciò che è rotto e che non si ripara in questo lavoro.
 */
const ECCEZIONI: { firma: string; misura: 'sporge' | 'nasconde' | 'taglia'; perche: string }[] = [];

const esentate = (firma: string, misura: 'sporge' | 'nasconde' | 'taglia'): boolean =>
    ECCEZIONI.some((e) => e.firma === firma && e.misura === misura);

/** Il tempo del singolo test: due caricamenti, quattro aperture, i cicli di quiete. */
const TIMEOUT_TEST_MS = 120_000;

/**
 * Misura QUANDO LA PAGINA HA FINITO DI MUOVERSI, non appena è caricata.
 *
 * Le card di `MediaGrid` entrano con `framer-motion` (`initial: scale 0.95`,
 * `delay: idx * 0.04`): per ~0,35 s i rettangoli sono più piccoli del vero, e una
 * fotografia scattata lì misurerebbe un'impaginazione che non esiste — verde
 * oggi, rossa sulla prossima macchina lenta. Si ricampiona finché due letture
 * consecutive non concordano su TUTTI i contatori: è lo stesso ciclo che ha chiuso
 * la corsa dei 500 ms nel crawler di contrasto, con la differenza che qui i valori
 * sorvegliati sono geometrici e non un conteggio di nodi.
 *
 * ⚠️ Nella chiave ci sono anche i contatori delle misure nuove. Se ci fossero solo
 * `esaminati` e `totaleFuori`, una pillola che entra in scena mezzo secondo dopo
 * (il pulsante Elimina arriva con `puoEliminare`, che dipende da una risposta)
 * troverebbe la sonda già «stabile» e non sarebbe misurata da nessuno.
 */
async function misura(page: Page, dove: string): Promise<EsitoImpaginazione> {
    const PASSO_MS = 250;
    const TETTO_MS = 15_000;
    const scadenza = Date.now() + TETTO_MS;
    const chiave = (e: EsitoImpaginazione) =>
        `${e.esaminati}/${e.contenitori}/${e.comandi}/${e.totaleFuori}/${e.totaleNascosti}/${e.totaleTagliati}`;
    const storia: string[] = [];
    let ultimo = await page.evaluate(sondaImpaginazione, { tolleranza: TOLLERANZA });
    storia.push(chiave(ultimo));

    while (Date.now() < scadenza) {
        await page.waitForTimeout(PASSO_MS);
        const attuale = await page.evaluate(sondaImpaginazione, { tolleranza: TOLLERANZA });
        storia.push(chiave(attuale));
        if (chiave(attuale) === chiave(ultimo)) return attuale;
        ultimo = attuale;
    }

    throw new Error(
        `${dove}: l'impaginazione non si ferma mai. Letture ogni ${PASSO_MS} ms per ` +
            `${TETTO_MS / 1000} s (elementi/contenitori/comandi/fuori/nascosti/tagliati): ${storia.join(' → ')}.\n` +
            "Non proseguo con una misura presa a metà: sarebbe la corsa che questo ciclo esiste per " +
            'togliere. Se i numeri OSCILLANO invece di crescere, la schermata ha qualcosa che si ' +
            'rirende da solo (un carosello, un polling, un’animazione che monta e smonta nodi): va ' +
            'messo in pausa nella misura, non aspettato più a lungo.',
    );
}

/* ────────────────────────────────────────────────────────────────────────────────
 * I TRE RACCONTI DI UN ROSSO.
 *
 * Un messaggio che dice «expected 1 to be 0» costa un giro di CI e un artefatto da
 * scaricare. Questi tre dicono che cosa è rotto, di quanto, e che mossa si fa —
 * perché la mossa sbagliata (alzare la tolleranza) è sempre la più a portata di
 * mano di chi trova il rosso alle sette di sera.
 * ──────────────────────────────────────────────────────────────────────────────── */

function raccontaFuori(dove: string, e: EsitoImpaginazione): string {
    const righe = e.fuori.map((f) => `  · ${f.firma}  [${f.sinistra} … ${f.destra}]`).join('\n');
    return (
        `${dove}: ${e.totaleFuori} element${e.totaleFuori === 1 ? 'o' : 'i'} sporgono dai ` +
        `${e.larghezzaVista} px del telefono (tolleranza ${TOLLERANZA} px). I bordi sono in ` +
        `pixel dal lato sinistro della finestra: un valore negativo è tagliato a SINISTRA, uno ` +
        `sopra ${e.larghezzaVista} è tagliato a DESTRA.\n${righe}\n` +
        'Non si alza una soglia e non si allarga la tolleranza: un comando tagliato a metà non è ' +
        'un comando. Se una riga di pillole non ci sta, `flex-wrap` costa una riga in più; non ' +
        'andare a capo costa il comando.'
    );
}

function raccontaNascosti(dove: string, e: EsitoImpaginazione): string {
    const righe = e.nascosti
        .map((n) => `  · ${n.firma}  scrollWidth ${n.scrollWidth} > clientWidth ${n.clientWidth}  (overflow-x: ${n.overflowX})`)
        .join('\n');
    return (
        `${dove}: ${e.totaleNascosti} contenitor${e.totaleNascosti === 1 ? 'e' : 'i'} SCORRONO DI ` +
        `LATO senza averlo chiesto, cioè stanno nascondendo qualcosa a destra di un bordo che non ` +
        `si vede.\n${righe}\n` +
        'Nessuno ha scritto `overflow-x` su questi nodi: ce l’ha messo il CSS, perché un asse ' +
        '`visible` accanto a un asse che non lo è computa ad `auto`. Chi ha scritto ' +
        '`overflow-y-auto` chiedeva di scorrere in GIÙ. Il rimedio è far stare il contenuto ' +
        '(`flex-wrap`, `min-w-0`, un `truncate` sul testo lungo), NON aggiungere `overflow-x-auto` ' +
        'per far tacere questa misura: uno scorrimento laterale dentro un visore a tutto schermo ' +
        'non lo trova nessuno, e ciò che sfonda a sinistra non si raggiunge nemmeno scorrendo. ' +
        'Se invece è un carosello VOLUTO, lo si dichiara nel `className` (`overflow-x-auto`) e la ' +
        'sonda lo esenta da sola.'
    );
}

function raccontaTagliati(dove: string, e: EsitoImpaginazione): string {
    const righe = e.tagliati
        .map(
            (t) =>
                `  · ${t.firma}  vero [${t.sinistraGrezza} … ${t.destraGrezza}] → visibile ` +
                `[${t.sinistraVista} … ${t.destraVista}]  tagliato da ${t.da}`,
        )
        .join('\n');
    return (
        `${dove}: ${e.totaleTagliati} comand${e.totaleTagliati === 1 ? 'o' : 'i'} ${
            e.totaleTagliati === 1 ? 'è' : 'sono'
        } tagliati dal proprio contenitore.\n${righe}\n` +
        'È la misura che vede lo sfondamento a SINISTRA, e nessun’altra lo vede: in LTR l’area ' +
        'scorribile cresce solo a destra, quindi un pulsante che comincia a −48 px non compare in ' +
        'nessun `scrollWidth`. Metà pulsante è mezzo bersaglio per un pollice: si fa stare il ' +
        'contenuto, non si sposta la soglia.'
    );
}

/** Apre la card `i` della griglia e attende che il visore sia in scena. */
async function apriVisore(page: Page, i: number): Promise<void> {
    await page.getByTestId('griglia-media').locator('[role="button"]').nth(i).click();
    await expect(page.getByTestId('visore-colonna')).toBeVisible();
}

async function chiudiVisore(page: Page): Promise<void> {
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('visore-colonna')).toBeHidden();
}

interface Contenuto { video: number; immagini: number; firmate: number }

/** Che cosa il visore sta mostrando davvero — conteggi, mai indirizzi. */
async function contenutoDelVisore(colonna: Locator): Promise<Contenuto> {
    return colonna.evaluate((col) => {
        const video = col.querySelectorAll('video').length;
        const img = Array.from(col.querySelectorAll('img'));
        // SOLO un booleano per immagine: il `src` è un URL firmato sul bucket
        // privato, cioè una credenziale, e non esce da questa funzione.
        const firmate = img.filter((el) => {
            const src = el.getAttribute('src') ?? '';
            return src.includes('/object/sign/') && src.includes('gallery/');
        }).length;
        return { video, immagini: img.length, firmate };
    });
}

/** Le tre misure geometriche, applicate a una schermata qualunque. */
function pretendiImpaginazioneSana(dove: string, e: EsitoImpaginazione): void {
    expect(
        e.scrollWidth,
        `${dove}: la pagina SCORRE DI LATO — scrollWidth ${e.scrollWidth} contro clientWidth ` +
            `${e.clientWidth}. Su un telefono lo scorrimento orizzontale non è un inconveniente: ` +
            'è la pagina che si sposta sotto il dito mentre si prova a scorrere in verticale.',
    ).toBeLessThanOrEqual(e.clientWidth + TOLLERANZA);

    expect(
        e.fuori.filter((f) => !esentate(f.firma, 'sporge')),
        raccontaFuori(dove, e),
    ).toEqual([]);

    expect(
        e.nascosti.filter((n) => !esentate(n.firma, 'nasconde')),
        raccontaNascosti(dove, e),
    ).toEqual([]);

    expect(
        e.tagliati.filter((t) => !esentate(t.firma, 'taglia')),
        raccontaTagliati(dove, e),
    ).toEqual([]);
}

for (const caso of [
    {
        nome: 'genitore',
        // `?id=` esplicito: senza, la pagina sceglie il primo figlio e la misura
        // dipenderebbe dall'ordine con cui il database restituisce i legami.
        rotta: `/parent/gallery?id=${IDS.A1}`,
        storage: 'genitore' as const,
    },
    {
        // La sezione la sceglie la pagina da sola (`sections[0]`), e la docente E2E
        // ne ha ESATTAMENTE una (Girasoli, sede 1): nessuna interazione da simulare,
        // nessun ordine da cui dipendere.
        nome: 'docente',
        rotta: '/teacher/gallery',
        storage: 'docente' as const,
    },
]) {
    test.describe(`impaginazione media · ${caso.nome} (390×844)`, () => {
        test.use({
            storageState: STORAGE[caso.storage],
            /**
             * Solo il viewport, NON `devices['iPhone 13']`.
             *
             * Quel device porterebbe `isMobile: true`, il touch e uno user-agent di
             * iPhone: cambierebbe quali rami del prodotto girano (e su Chromium
             * anche la scrollbar), mescolando due misure in una. Ciò che questo
             * spec misura è una proprietà del LAYOUT a 390 px di larghezza, e il
             * motore giusto lo dà il progetto Playwright (`webkit`), non lo
             * user-agent.
             */
            viewport: IPHONE,
        });

        test(`${caso.rotta} — niente sporge né si nasconde, il visore scorre, il video dichiara il rapporto`, async ({ page }) => {
            test.setTimeout(TIMEOUT_TEST_MS);

            const risposta = await page.goto(caso.rotta, { waitUntil: 'load' });
            expect(risposta?.ok(), `la rotta ${caso.rotta} non ha risposto 2xx`).toBe(true);
            await attendiFineCaricamento(page);

            // ── LE PREMESSE — senza queste, tutto il resto è vero e vuoto ─────
            const griglia = page.getByTestId('griglia-media');
            await expect(
                griglia,
                `${caso.rotta}: la griglia dei media non è in scena. Se al suo posto c'è lo stato ` +
                    'vuoto, il seed non ha seminato nessun media per questa vista e OGNI misura di ' +
                    'questo spec sarebbe vacuamente vera — un crawler verde sul vuoto. Si guarda ' +
                    '`scripts/seed-e2e.mjs` (bucket `gallery` + i tre file + le righe su Girasoli), ' +
                    'non questo file.',
            ).toBeVisible({ timeout: 30_000 });

            const card = griglia.locator('[role="button"]');
            await expect(card.first()).toBeVisible();
            const quante = await card.count();
            expect(
                quante,
                `${caso.rotta}: solo ${quante} card in griglia (pavimento ${CARD_MINIME}). Il seed ne ` +
                    'mette tre — una foto quadrata, una foto VERTICALE e un video — e servono tutte ' +
                    'e tre: la verticale è ciò che prova che l’altezza non sfonda, il video è ' +
                    'l’unico caso in cui esiste un `<video>` da misurare.',
            ).toBeGreaterThanOrEqual(CARD_MINIME);

            // ── 1 · 2a · 2b · 2c sulla griglia ──────────────────────────────────
            const grigliaMisurata = await misura(page, `${caso.rotta} (griglia)`);
            expect(
                grigliaMisurata.esaminati,
                `${caso.rotta}: il crawler ha esaminato solo ${grigliaMisurata.esaminati} elementi ` +
                    `(pavimento ${ELEMENTI_MINIMI}): sta misurando un guscio, non la schermata.`,
            ).toBeGreaterThanOrEqual(ELEMENTI_MINIMI);

            pretendiImpaginazioneSana(`${caso.rotta} (griglia)`, grigliaMisurata);

            // ── 3 e 4 · il visore, card per card ────────────────────────────────
            let videoVisti = 0;
            let immaginiFirmate = 0;
            const daAprire = Math.min(quante, CARD_ISPEZIONATE);

            for (let i = 0; i < daAprire; i++) {
                await apriVisore(page, i);
                const colonna = page.getByTestId('visore-colonna');
                const dentro = await contenutoDelVisore(colonna);
                videoVisti += dentro.video;
                immaginiFirmate += dentro.firmate;

                // 3a. Lo scroller è uno scroller. Era il difetto: il contenitore non
                // scorreva affatto, quindi ciò che stava sotto il bordo non esisteva.
                const scorrimento = page.getByTestId('visore-scorrimento');
                const geometria = await scorrimento.evaluate((el) => {
                    const st = getComputedStyle(el);
                    return {
                        overflowY: st.overflowY,
                        scrollHeight: el.scrollHeight,
                        clientHeight: el.clientHeight,
                    };
                });
                expect(
                    ['auto', 'scroll'],
                    `${caso.rotta}, card ${i}: il contenitore del visore ha overflow-y ` +
                        `«${geometria.overflowY}»: non può scorrere. Tutto ciò che cade sotto il ` +
                        'bordo inferiore è irraggiungibile — era il difetto del pulsante Elimina, ' +
                        'che finiva ~80 px sotto lo schermo.',
                ).toContain(geometria.overflowY);

                // 3b. E se il contenuto è più alto della vista, scorre DAVVERO.
                // Il ramo si esercita di sicuro lato docente, dove la colonna porta
                // anche l'elenco dei bambini taggati. Lato genitore la colonna può
                // starci: non è un difetto, ed è il motivo per cui il ramo è
                // condizionato invece di essere pretesa.
                if (geometria.scrollHeight > geometria.clientHeight + TOLLERANZA) {
                    const mosso = await scorrimento.evaluate((el) => {
                        const prima = el.scrollTop;
                        el.scrollTop = el.scrollHeight;
                        const dopo = el.scrollTop;
                        el.scrollTop = prima;
                        return dopo !== prima;
                    });
                    expect(
                        mosso,
                        `${caso.rotta}, card ${i}: il contenuto del visore è più alto della vista ` +
                            `(${geometria.scrollHeight} contro ${geometria.clientHeight}) ma ` +
                            '`scrollTop` non si muove: lo scorrimento è bloccato da qualcosa (un ' +
                            '`overflow: hidden` su un antenato, un `overscroll` sbagliato, un ' +
                            'gestore che annulla il gesto).',
                    ).toBe(true);
                }

                // 3c. L'ULTIMO comando della colonna è raggiungibile. `behavior:
                // 'instant'` esplicito: con lo scorrimento morbido il rettangolo si
                // leggerebbe a metà animazione, ed è una corsa che si presenta solo
                // sulle macchine lente della CI.
                const ultimo = await colonna.evaluate((col) => {
                    const firma = (el: Element): string => {
                        const testid = el.getAttribute('data-testid');
                        const classi = (el.getAttribute('class') ?? '')
                            .split(/\s+/)
                            .filter(Boolean)
                            .slice(0, 4)
                            .join('.');
                        return (
                            el.tagName.toLowerCase() +
                            (testid ? `[data-testid="${testid}"]` : '') +
                            (classi ? `.${classi}` : '')
                        );
                    };
                    const comandi = Array.from(
                        col.querySelectorAll('button, [role="button"], a[href], input, select, textarea'),
                    ).filter((el) => {
                        const r = el.getBoundingClientRect();
                        return r.width >= 2 && r.height >= 2;
                    });
                    if (comandi.length === 0) return { quanti: 0, firma: '', alto: 0, basso: 0, vista: window.innerHeight };
                    const el = comandi[comandi.length - 1];
                    el.scrollIntoView({ block: 'nearest', behavior: 'instant' as ScrollBehavior });
                    const r = el.getBoundingClientRect();
                    return {
                        quanti: comandi.length,
                        firma: firma(el),
                        alto: Math.round(r.top),
                        basso: Math.round(r.bottom),
                        vista: window.innerHeight,
                    };
                });

                expect(
                    ultimo.quanti,
                    `${caso.rotta}, card ${i}: nel visore non c'è nessun comando visibile. Lato ` +
                        'genitore ci sono Scarica, Condividi e Segnala; lato docente i tag e ' +
                        'Elimina. Zero comandi significa che la colonna non ha reso i suoi ' +
                        'pulsanti — e allora questa misura non prova niente.',
                ).toBeGreaterThan(0);

                expect(
                    ultimo.basso,
                    `${caso.rotta}, card ${i}: l'ultimo comando del visore (${ultimo.firma}) resta ` +
                        `fuori dallo schermo anche dopo averlo portato in vista: il suo bordo ` +
                        `inferiore è a ${ultimo.basso} px su una finestra alta ${ultimo.vista}. ` +
                        'È il difetto per cui il pulsante Elimina cadeva ~80 px sotto il bordo: ' +
                        'non «scomodo», irraggiungibile.',
                ).toBeLessThanOrEqual(ultimo.vista + TOLLERANZA);

                expect(
                    ultimo.alto,
                    `${caso.rotta}, card ${i}: l'ultimo comando del visore (${ultimo.firma}) finisce ` +
                        `sopra il bordo alto della finestra (${ultimo.alto} px). Su iPhone lassù c'è ` +
                        'la Dynamic Island: si usa `pt-[max(1rem,env(safe-area-inset-top))]`, come ' +
                        'già fa l’involucro del visore.',
                ).toBeGreaterThanOrEqual(-TOLLERANZA);

                // 4. Il video dichiara il rapporto, o dove si ferma.
                if (dentro.video > 0) {
                    const v = await colonna.locator('video').first().evaluate((el) => {
                        const st = getComputedStyle(el);
                        return { aspectRatio: st.aspectRatio, objectFit: st.objectFit, maxHeight: st.maxHeight };
                    });
                    const dichiarato =
                        v.aspectRatio !== 'auto' || (v.objectFit === 'contain' && v.maxHeight !== 'none');
                    expect(
                        dichiarato,
                        `${caso.rotta}, card ${i}: il <video> del visore non dichiara né un rapporto ` +
                            `d'aspetto (aspect-ratio: ${v.aspectRatio}) né un tetto d'altezza con ` +
                            `object-fit (object-fit: ${v.objectFit}, max-height: ${v.maxHeight}). ` +
                            "Senza uno dei due l'altezza la decide il file girato col telefono: un " +
                            '9:16 a larghezza 390 è alto 693 px, e i comandi finiscono fuori campo. ' +
                            '⚠️ `svh` e non `vh`: su Safari iOS `vh` è il viewport GRANDE, quello ' +
                            "senza la barra degli indirizzi, quindi `70vh` vale più del 70% di ciò " +
                            'che si vede.',
                    ).toBe(true);
                }

                // ── 1 · 2a · 2b · 2c ANCHE a visore aperto: è LÌ che stavano le
                // tre pillole, ed è l'unico posto dove 2b e 2c hanno qualcosa da
                // dire — il contenitore che ritaglia è il visore stesso.
                const dentroIlVisore = `${caso.rotta} (visore, card ${i})`;
                const visoreMisurato = await misura(page, dentroIlVisore);

                // I PAVIMENTI DEL VISORE. Senza questi tre numeri, le misure qui
                // sotto sarebbero vere anche su un visore che rende UN GUSCIO: la
                // firma non riuscita, il ramo `!urlVisore` col segnaposto, un errore
                // che svuota la colonna. Non ci sarebbe niente che sporge perché non
                // ci sarebbe niente.
                expect(
                    visoreMisurato.esaminati,
                    `${dentroIlVisore}: solo ${visoreMisurato.esaminati} elementi esaminati ` +
                        `(pavimento ${ELEMENTI_MINIMI}): sta misurando un guscio, non il visore.`,
                ).toBeGreaterThanOrEqual(ELEMENTI_MINIMI);
                expect(
                    visoreMisurato.contenitori,
                    `${dentroIlVisore}: nessun contenitore che scorre in orizzontale (pavimento ` +
                        `${CONTENITORI_VISORE_MINIMI}). Il visore ne ha uno per costruzione — ` +
                        '`visore-scorrimento` è `overflow-y-auto`, e il CSS gli porta l’asse X ad ' +
                        '`auto`. Zero significa che la misura 2b non ha confrontato NIENTE, cioè ' +
                        'che il suo verde non prova nulla.',
                ).toBeGreaterThanOrEqual(CONTENITORI_VISORE_MINIMI);
                expect(
                    visoreMisurato.comandi,
                    `${dentroIlVisore}: nessun comando confrontato col proprio ritaglio (pavimento ` +
                        `${COMANDI_VISORE_MINIMI}). I comandi del visore stanno dentro ` +
                        '`visore-scorrimento`, che ritaglia: se non ne è stato confrontato nemmeno ' +
                        'uno, la misura 2c è vacua e le tre pillole potrebbero tornare domani.',
                ).toBeGreaterThanOrEqual(COMANDI_VISORE_MINIMI);

                pretendiImpaginazioneSana(dentroIlVisore, visoreMisurato);

                await chiudiVisore(page);
            }

            // ── LE PREMESSE, di nuovo: la parte che il seed deve rendere vera ──
            expect(
                immaginiFirmate,
                `${caso.rotta}: fra le ${daAprire} card aperte nessuna ha mostrato un'immagine con ` +
                    'un URL FIRMATO sul bucket `gallery`. È il caso che rende tutto questo spec ' +
                    'vacuo, ed è lo stato in cui il seed si trovava fino al 2026-09-11: le righe di ' +
                    '`galleria_media_v2` puntavano a file che non esistono e il bucket `gallery` non ' +
                    'veniva creato affatto, quindi `firmaMediaGalleria` restituiva `file_url: null` ' +
                    "e `MediaGrid` rendeva un segnaposto al posto dell'immagine. Si correggono il " +
                    'bucket e i file in `scripts/seed-e2e.mjs`, non questo file.',
            ).toBeGreaterThanOrEqual(1);

            expect(
                videoVisti,
                `${caso.rotta}: fra le ${daAprire} card aperte nessuna ha mostrato un <video>. La ` +
                    "quarta misura di questo spec — l'unica che parla di video — non è stata " +
                    'eseguita affatto. Il seed deve contenere una riga con `file_type: \'video\'` E ' +
                    'il relativo `.mp4` nel bucket: senza il file la firma non riesce, e senza la ' +
                    'firma `MediaGrid` non rende nessun `<video>`.',
            ).toBeGreaterThanOrEqual(1);
        });
    });
}
