import { test, expect, type Locator, type Page } from '@playwright/test';
import { CHAT_LUNGA_E2E, EMAILS, IDS, attendiFineCaricamento, login } from './fixtures';
import itChat from '../messages/it/parentChat.json';

/**
 * «CARICA MESSAGGI PRECEDENTI» SU UNA CONVERSAZIONE VERA — 60 messaggi, due motori.
 *
 * ─── COSA PROVA ─────────────────────────────────────────────────────────────
 * Sulla conversazione lunga del seed (`CHAT_LUNGA_E2E`: 60 messaggi, il 10 e l'11 con lo
 * stesso istante), dal telefono della famiglia:
 *  1. si apre sulla CODA — 11…60, in ordine — e in fondo;
 *  2. «Carica messaggi precedenti» porta 1…10: sessanta messaggi, ognuno UNA volta fra
 *     quelli a schermo, nessun buco, e il pulsante sparisce;
 *  3. il messaggio 11, quello che si stava leggendo, resta dov'era entro 2 px;
 *  4. non parte nessuna PATCH di lettura.
 *
 * ─── PERCHÉ SERVE UN E2E ────────────────────────────────────────────────────
 * Due cose di questo lavoro nessun test di `__tests__/` le può vedere:
 *  · la sintassi del cursore su un PostgREST VERO — `.or()` con l'istante fra virgolette e
 *    lo spareggio sull'id — che il database finto di `chat-messages-coda.test.ts` può solo
 *    imitare;
 *  · lo scorrimento. jsdom non impagina: in `ChatMessageArea-precedenti.test.tsx` la
 *    geometria la dichiara il test. Un browser vero compensa da sé il contenuto che
 *    compare SOPRA ciò che si legge (scroll anchoring), ma solo a conversazione già
 *    scorsa: da `scrollTop` 0, che è dove sta il pulsante, non compensa niente.
 *
 * ⚠️ MISURATO il 2026-09-15, con Chromium e WebKit di Playwright 1.62, su un banco locale
 * col `ChatMessageArea` VERO fuori dall'app (lo spec non si può eseguire in locale):
 *  · un contenitore generico a `scrollTop` 300 a cui si tolgono 60 px sopra: tutti e due
 *    i motori riportano `scrollTop` a 240 e il messaggio resta fermo. Lo stesso contenitore
 *    a `scrollTop` 0 con 500 px aggiunti sopra: il messaggio scende di 500 px, su tutti e due;
 *  · il componente SENZA la riga che corregge `scrollTop`: dopo «Carica messaggi
 *    precedenti» l'11 scende di circa 702 px, su tutti e due i motori;
 *  · il componente vero, cliccando da `scrollTop` 0, 4, 10 e 15: l'11 resta entro mezzo
 *    pixel, su tutti e due. Correzione e anchoring non si sommano.
 * Per questo lo spec clicca da `scrollTop` 0 — lo stato di chi è scorso fino al pulsante,
 * e l'unico in cui a tenere fermo il messaggio è soltanto il componente — e gira anche su
 * WebKit, il motore della WebView iOS (regex `SPEC_CRITICI_WEBKIT` di `playwright.config.ts`).
 *
 * ─── PERCHÉ A 390×844 ───────────────────────────────────────────────────────
 * L'area genitore è una colonna di 430 px anche su uno schermo largo (`max-w-[430px]` in
 * `parent/layout.tsx`): a 1280 px la pagina accenderebbe il layout a due pannelli
 * (`md:flex`) dentro 398 px, con bolle larghe poche decine di pixel — una schermata che
 * nessuna famiglia vede. Sotto `md` la conversazione è a tutto schermo, ed è quella del
 * telefono. Solo il viewport, non `devices['iPhone …']`: la ragione è scritta in
 * `impaginazione-media.spec.ts` (user-agent e touch cambierebbero i rami che girano).
 *
 * ─── PERCHÉ LA POSIZIONE SI MISURA DENTRO IL CONTENITORE ────────────────────
 * Chi legge vede il messaggio dentro la finestra della conversazione, ed è quella distanza
 * che il componente corregge (`scrollTop`). Il riquadro rispetto alla PAGINA cambierebbe
 * anche per ragioni che non sono il prodotto, come lo scorrimento con cui Playwright porta
 * in vista ciò che clicca. Messaggio e contenitore si leggono nello stesso fotogramma.
 *
 * ─── PERCHÉ LA RISPOSTA SI TRATTIENE ────────────────────────────────────────
 * La GET con `primaDi` passa da `page.route` e riparte solo DOPO la misura «prima». Così la
 * misura è presa nello stato esatto da cui parte il componente (pulsante in «Caricamento…»,
 * clic già avvenuto), e la risposta non può arrivare fra il clic e la misura. Non è un
 * finto: la richiesta prosegue verso il server vero (`route.continue()`).
 * `serviceWorkers: 'block'` perché, dice la documentazione di Playwright, `page.route` non
 * intercetta le richieste che passano da un Service Worker.
 *
 * ─── PERCHÉ NON SEGNA LETTO NIENTE ──────────────────────────────────────────
 * I due progetti leggono le STESSE righe, e il seed non si rifà fra l'uno e l'altro: una
 * lettura segnata dal primo cambierebbe la conversazione del secondo. Il seed le semina
 * tutte lette (il perché per esteso è là, al punto 17), e qui si pretende che nessuna PATCH
 * di lettura parta — con una controprova: lo stesso ascoltatore deve aver visto la GET col
 * cursore, altrimenti «nessuna PATCH» non direbbe niente.
 *
 * Login dalla UI: il progetto `setup` conserva le sole sessioni storiche, e `genitore2` non
 * è fra quelle (come in `isolamento-sedi.spec.ts`). Nel rapporto di un rosso finiscono solo
 * uuid, numeri e i testi sintetici del seed.
 */

/**
 * `retries: 0`, dichiarato qui e non nel progetto: la ragione è quella di
 * `impaginazione-media.spec.ts`. Un messaggio doppio, un buco o un salto di settecento pixel
 * non sono casi, si ripetono identici al secondo tentativo; con i `retries: 2` della config
 * un rosso su tre passerebbe per verde, ed è già successo in questo repo (24/08 e 01/09).
 * Il margine per la compilazione a freddo di `next dev` sta nei tempi, non nei ripescaggi.
 */
test.describe.configure({ retries: 0 });

/** iPhone 13/14/15 in verticale. */
const IPHONE = { width: 390, height: 844 } as const;
/** `next dev` compila a freddo pagine e rotte della chat: tempi larghi, asserzioni invariate. */
const RENDER = 60_000;
const AZIONE = 20_000;
/** Quanti messaggi porta la GET senza cursore: `zLimite({ predefinito: 50 })` in `src/app/api/chat/messages/route.ts`. */
const FINESTRA = 50;
/** Il più vecchio della coda: 60 − 50 + 1 = 11. */
const PRIMO_DELLA_CODA = CHAT_LUNGA_E2E.totale - FINESTRA + 1;
/**
 * Due pixel: `getBoundingClientRect` restituisce frazioni e `scrollTop` arrotonda (il residuo
 * misurato col componente vero è sotto il mezzo pixel). Un messaggio che nessuno corregge
 * scende dell'altezza di dieci bolle, circa 700 px a questa larghezza: la soglia non deve
 * assorbire niente di più.
 */
const TOLLERANZA_PX = 2;
/**
 * Quanto si aspetta, con i messaggi 1…10 in vista, prima di dire «nessuna PATCH»:
 * l'IntersectionObserver di `ChatMessageArea` manda le bolle viste dopo 500 ms (`scheduleFlush`).
 */
const ATTESA_LETTI_MS = 1_500;

interface CorpoMessaggi {
    messages: { id: string; read_at: string | null }[];
    total: number;
    precedenti: number;
}

const numeri = (da: number, a: number): number[] => Array.from({ length: a - da + 1 }, (_, i) => da + i);
const idDa = (da: number, a: number): string[] => numeri(da, a).map((n) => CHAT_LUNGA_E2E.idMessaggio(n));
const testiDa = (da: number, a: number): string[] => numeri(da, a).map((n) => CHAT_LUNGA_E2E.testo(n));

/** La GET dei messaggi della conversazione lunga, con quel cursore (`null` = senza). */
function eLetturaDelThread(url: string, metodo: string, primaDi: string | null): boolean {
    const u = new URL(url);
    return (
        metodo === 'GET' &&
        u.pathname === '/api/chat/messages' &&
        u.searchParams.get('threadId') === IDS.THREAD_LUNGO &&
        u.searchParams.get('primaDi') === primaDi
    );
}

/* ─── LE SONDE ────────────────────────────────────────────────────────────────────
 * Funzioni senza `expect`: leggono e restituiscono, le asserzioni stanno nel test. Ciò che
 * gira nella pagina riceve tutto come ARGOMENTO: `evaluate` serializza la funzione, e una
 * costante del modulo lì non esiste (è il punto 1 della testata di `impaginazione-media`).
 * ──────────────────────────────────────────────────────────────────────────────── */

interface Geometria {
    scrollTop: number;
    clientHeight: number;
    /** Distanza del bordo alto del messaggio dal bordo alto del contenitore; `null` se non c'è. */
    dalBordo: number | null;
    altezza: number | null;
}

/** Contenitore e messaggio letti nello stesso fotogramma. */
async function geometria(area: Locator, idMessaggio: string): Promise<Geometria> {
    return area.evaluate((el, id) => {
        const r = el.querySelector(`[data-msg-id="${id}"]`)?.getBoundingClientRect();
        return {
            scrollTop: el.scrollTop,
            clientHeight: el.clientHeight,
            dalBordo: r ? r.top - el.getBoundingClientRect().top : null,
            altezza: r ? r.height : null,
        };
    }, idMessaggio);
}

/** Almeno una parte del messaggio sta nella finestra della conversazione. */
function inVista(g: Geometria): boolean {
    return g.dalBordo !== null && g.altezza !== null && g.dalBordo < g.clientHeight && g.dalBordo + g.altezza > 0;
}

/** Il messaggio sta tutto nella finestra della conversazione. */
function tuttoInVista(g: Geometria): boolean {
    return g.dalBordo !== null && g.altezza !== null && g.dalBordo >= 0 && g.dalBordo + g.altezza <= g.clientHeight;
}

/**
 * Gli id nell'ordine del DOM e i testi della conversazione a schermo, dentro il SOLO
 * contenitore visibile: le pagine montano la conversazione due volte (a tutto schermo e nel
 * layout largo, che a questa larghezza è `display: none`), e contare anche quella nascosta
 * raddoppierebbe ogni messaggio. I testi si cercano per FORMA (`formaTesto`), non per tag:
 * così un doppione si vede anche se un giorno la bolla cambia struttura.
 */
async function leggiConversazione(area: Locator): Promise<{ ids: string[]; testi: string[] }> {
    const ids = await area
        .locator('[data-msg-id]')
        .evaluateAll((righe) => righe.map((r) => r.getAttribute('data-msg-id') ?? ''));
    const testi = await area.getByText(CHAT_LUNGA_E2E.formaTesto).allTextContents();
    return { ids, testi };
}

/**
 * Aspetta che la conversazione SI FERMI nello stato atteso: due letture consecutive con lo
 * stesso `scrollTop` e la stessa posizione del messaggio, e `pronta` vera.
 *
 * All'apertura il componente scorre in fondo con `behavior: 'smooth'`: una misura presa a
 * metà misurerebbe l'animazione, e un `scrollTop = 0` dato mentre scorre verrebbe ripreso
 * dall'animazione stessa. Dopo i precedenti serve per l'altro verso: un salto che arrivasse
 * un fotogramma dopo la correzione non deve sfuggire perché la misura è stata troppo svelta.
 */
async function attendiQuiete(
    page: Page,
    area: Locator,
    idMessaggio: string,
    pronta: (g: Geometria) => boolean,
    dove: string,
): Promise<Geometria> {
    const PASSO_MS = 250;
    const TETTO_MS = 20_000;
    const scadenza = Date.now() + TETTO_MS;
    const traccia = (g: Geometria) =>
        `${Math.round(g.scrollTop)}/${g.dalBordo === null ? '—' : Math.round(g.dalBordo * 10) / 10}`;
    let prima = await geometria(area, idMessaggio);
    const storia = [traccia(prima)];
    while (Date.now() < scadenza) {
        await page.waitForTimeout(PASSO_MS);
        const ora = await geometria(area, idMessaggio);
        storia.push(traccia(ora));
        if (ora.scrollTop === prima.scrollTop && ora.dalBordo === prima.dalBordo && pronta(ora)) return ora;
        prima = ora;
    }
    throw new Error(
        `${dove}: la conversazione non si è fermata nello stato atteso. Letture ogni ${PASSO_MS} ms per ` +
            `${TETTO_MS / 1000} s (scrollTop / distanza del messaggio dal bordo alto): ${storia.join(' → ')}.`,
    );
}

/* ─── IL TEST ─────────────────────────────────────────────────────────────────── */

test.use({ viewport: IPHONE, serviceWorkers: 'block' });

test('60 messaggi: si apre sulla coda, e «Carica messaggi precedenti» porta i primi 10 senza doppioni e senza spostare ciò che si legge', async ({ page }) => {
    test.setTimeout(180_000);
    const id11 = CHAT_LUNGA_E2E.idMessaggio(PRIMO_DELLA_CODA);
    const idUltimo = CHAT_LUNGA_E2E.idMessaggio(CHAT_LUNGA_E2E.totale);

    await login(page, EMAILS.genitore2);
    await page.waitForURL('**/parent', { timeout: RENDER, waitUntil: 'domcontentloaded' });

    // Da qui in poi, ogni richiesta alle rotte della chat: metodo, percorso, cursore. Solo uuid.
    const richieste: { metodo: string; percorso: string; primaDi: string | null }[] = [];
    page.on('request', (r) => {
        const u = new URL(r.url());
        if (u.pathname.startsWith('/api/chat/')) {
            richieste.push({ metodo: r.method(), percorso: u.pathname, primaDi: u.searchParams.get('primaDi') });
        }
    });

    const area = page.getByTestId('chat-messaggi').filter({ visible: true });
    const pulsante = area.getByRole('button', { name: itChat.caricaPrecedenti, exact: true });
    const occupato = area.getByRole('button', { name: itChat.loadingMessages, exact: true });

    await test.step('si apre sulla coda: 11…60, in ordine, in fondo', async () => {
        const risposta = await page.goto('/parent/chat', { waitUntil: 'domcontentloaded' });
        expect(risposta?.ok(), '/parent/chat non ha risposto 2xx').toBe(true);
        await attendiFineCaricamento(page);

        // La premessa: la conversazione seminata è in elenco. Senza, non c'è niente da misurare.
        const thread = page.getByRole('button', { name: 'Diana Docente2-E2E' }).filter({ visible: true });
        await expect(
            thread,
            'la conversazione lunga non è in elenco: guarda il punto 17 di `scripts/seed-e2e.mjs`',
        ).toBeVisible({ timeout: RENDER });

        const [finestra] = await Promise.all([
            page.waitForResponse((r) => eLetturaDelThread(r.url(), r.request().method(), null), { timeout: RENDER }),
            thread.click(),
        ]);
        expect(finestra.status(), 'la GET della conversazione senza cursore').toBe(200);
        const corpo = (await finestra.json()) as CorpoMessaggi;
        expect(
            corpo.messages.map((m) => m.id),
            `la GET senza cursore deve portare gli ULTIMI ${FINESTRA} messaggi, dal più vecchio al più nuovo: ` +
                'l’11 sì e il 10 no, anche se hanno lo stesso istante',
        ).toEqual(idDa(PRIMO_DELLA_CODA, CHAT_LUNGA_E2E.totale));
        expect(
            { total: corpo.total, precedenti: corpo.precedenti },
            '`total` è l’intera conversazione, `precedenti` quanti ne restano prima della finestra',
        ).toEqual({ total: CHAT_LUNGA_E2E.totale, precedenti: PRIMO_DELLA_CODA - 1 });
        expect(
            corpo.messages.filter((m) => !m.read_at).map((m) => m.id),
            'messaggi NON letti nella conversazione seminata: il seed deve seminarli tutti letti (punto 17)',
        ).toEqual([]);

        await expect
            .poll(() => leggiConversazione(area), {
                timeout: AZIONE,
                message: 'a schermo devono esserci i messaggi 11…60, ognuno una volta, in ordine',
            })
            .toEqual({
                ids: idDa(PRIMO_DELLA_CODA, CHAT_LUNGA_E2E.totale),
                testi: testiDa(PRIMO_DELLA_CODA, CHAT_LUNGA_E2E.totale),
            });
        await expect(area, 'una sola conversazione visibile').toHaveCount(1);

        // Si apre IN FONDO: quando lo scorrimento si ferma, l'ultimo messaggio è nella finestra.
        await attendiQuiete(page, area, idUltimo, inVista, 'all’apertura, l’ultimo messaggio');
    });

    const { prima, corpoPagina } = await test.step('in cima, il clic: si misura con la pagina precedente in volo', async () => {
        await area.evaluate((el) => {
            el.scrollTop = 0;
        });
        await attendiQuiete(page, area, id11, (g) => g.scrollTop === 0, 'portata la conversazione in cima');
        await expect(pulsante).toBeVisible();
        await expect(pulsante).toBeEnabled();

        let rilascia: () => void = () => {};
        const barriera = new Promise<void>((fatto) => {
            rilascia = fatto;
        });
        await page.route(
            (u) => u.pathname === '/api/chat/messages' && u.searchParams.has('primaDi'),
            async (route) => {
                await barriera;
                await route.continue();
            },
        );

        let misura: Geometria;
        await pulsante.click();
        // Registrata DOPO il clic, e non può perdere la risposta: finché la barriera è chiusa la
        // richiesta non è nemmeno partita verso il server.
        const paginaInArrivo = page.waitForResponse((r) => eLetturaDelThread(r.url(), r.request().method(), id11), {
            timeout: RENDER,
        });
        try {
            await expect(occupato, 'durante il caricamento il pulsante è occupato').toBeDisabled();
            await expect(occupato).toHaveAttribute('aria-busy', 'true');
            misura = await attendiQuiete(page, area, id11, tuttoInVista, 'con la pagina precedente in volo, il messaggio 11');
        } finally {
            rilascia();
        }

        const pagina = await paginaInArrivo;
        expect(pagina.status(), 'la GET dei messaggi precedenti (cursore sull’11)').toBe(200);
        return { prima: misura, corpoPagina: (await pagina.json()) as CorpoMessaggi };
    });

    await test.step('arrivano 1…10: sessanta messaggi, nessun doppione, e l’11 resta dov’era', async () => {
        expect(
            corpoPagina.messages.map((m) => m.id),
            'la pagina prima dell’11 deve portare 1…10 — compreso il 10, che ha lo stesso istante dell’11',
        ).toEqual(idDa(1, PRIMO_DELLA_CODA - 1));
        expect(corpoPagina.precedenti, 'prima dell’1 non c’è più niente').toBe(0);
        expect(
            corpoPagina.messages.filter((m) => !m.read_at).map((m) => m.id),
            'messaggi NON letti nella conversazione seminata: il seed deve seminarli tutti letti (punto 17)',
        ).toEqual([]);

        await expect
            .poll(() => leggiConversazione(area), {
                timeout: AZIONE,
                message: 'a schermo devono esserci i messaggi 1…60, ognuno una volta, in ordine',
            })
            .toEqual({ ids: idDa(1, CHAT_LUNGA_E2E.totale), testi: testiDa(1, CHAT_LUNGA_E2E.totale) });
        await expect(pulsante, 'prima dell’1 non c’è niente da caricare').toHaveCount(0);
        await expect(occupato).toHaveCount(0);
        await expect(area.getByText(itChat.caricaPrecedentiErrore)).toHaveCount(0);

        const dopo = await attendiQuiete(page, area, id11, () => true, 'dopo i messaggi precedenti, il messaggio 11');
        if (prima.dalBordo === null || dopo.dalBordo === null) {
            throw new Error(`il messaggio 11 non è nel contenitore (prima: ${prima.dalBordo}, dopo: ${dopo.dalBordo})`);
        }
        expect(
            Math.abs(dopo.dalBordo - prima.dalBordo),
            `il messaggio 11 si è spostato: era a ${prima.dalBordo} px dal bordo alto della conversazione, ` +
                `è a ${dopo.dalBordo} px (scrollTop ${prima.scrollTop} → ${dopo.scrollTop}). ` +
                'È ciò che vede chi legge: il messaggio che aveva sotto gli occhi salta via.',
        ).toBeLessThanOrEqual(TOLLERANZA_PX);
        // La controprova della misura qui sopra: dieci messaggi sono entrati SOPRA l'11, quindi
        // l'11 può essere rimasto fermo solo se la conversazione è scorsa. Senza, un «fermo» potrebbe
        // voler dire che i messaggi sono finiti altrove.
        expect(
            dopo.scrollTop,
            'la conversazione non è scorsa: dieci messaggi sono entrati sopra l’11 e niente ha compensato',
        ).toBeGreaterThan(prima.scrollTop);
    });

    await test.step('nessuna lettura segnata', async () => {
        // I messaggi 1…10 in vista: se ce ne fosse uno non letto, l'observer lo segnerebbe adesso.
        await area.evaluate((el) => {
            el.scrollTop = 0;
        });
        await attendiQuiete(page, area, CHAT_LUNGA_E2E.idMessaggio(1), tuttoInVista, 'in cima, il messaggio 1');
        await page.waitForTimeout(ATTESA_LETTI_MS);

        expect(
            richieste
                .filter((r) => r.metodo === 'GET' && r.percorso === '/api/chat/messages' && r.primaDi !== null)
                .map((r) => r.primaDi),
            'controprova dell’ascoltatore: una sola GET col cursore, sull’11. Se qui è vuoto, anche «nessuna PATCH» ' +
                'qui sotto non guarda niente',
        ).toEqual([id11]);
        expect(
            richieste.filter((r) => r.metodo === 'PATCH' && r.percorso === '/api/chat/messages/read'),
            'è partita una PATCH di lettura: i due progetti (chromium e webkit) leggono le stesse righe, e il ' +
                'primo cambierebbe la conversazione del secondo. Guarda i `read_at` al punto 17 di `scripts/seed-e2e.mjs`',
        ).toEqual([]);
    });
});
