import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sondaImpaginazione } from '../../e2e/lib/sonda-impaginazione';

/**
 * LA SONDA DEL CRAWLER DI IMPAGINAZIONE, provata QUI — cioè in locale.
 *
 * ─── PERCHÉ ESISTE QUESTO FILE ──────────────────────────────────────────────
 * Il crawler (`e2e/impaginazione-media.spec.ts`) gira SOLO in CI: `.env.local`
 * punta al database di produzione, e `npm run e2e`/`npx playwright test` sono in
 * `deny`. Un difetto nella sua logica di misura si scoprirebbe quindi con un giro
 * di CI — e un difetto che restituisce ZERO non si scoprirebbe affatto, perché il
 * crawler resterebbe verde su qualunque schermata.
 *
 * Non è un'ipotesi: **è successo a questa sonda, due volte nello stesso giorno.**
 *  1. la prima versione leggeva `TOLLERANZA` dal modulo dello spec; `page.evaluate`
 *     serializza la funzione, e nella pagina quella variabile non esiste →
 *     `ReferenceError` su Chromium e su WebKit. Il crawler moriva alla prima misura;
 *  2. corretto quello, era **verde su una pagina con mezza pillola fuori schermo**:
 *     ritagliava il rettangolo di ogni elemento con quello degli antenati che
 *     ritagliano, e siccome il contenitore del visore (`absolute inset-0
 *     overflow-y-auto`) coincide col viewport, qualunque sfondamento tornava
 *     «dentro i bordi».
 *
 * ─── LA REGOLA DI CASA, E COME QUESTO FILE LA RISPETTA ──────────────────────
 * `__tests__/a11y/sonda-contrasto.test.ts` la scrive così: «ciò che è aritmetica va
 * in vitest, ciò che tocca il layout resta in Playwright. Non si *testa il crawler*
 * in jsdom: si otterrebbe un verde che non dice niente».
 * Qui dentro NON si misura nessun layout: jsdom non ne ha. La geometria arriva come
 * DATO — rettangoli, `scrollWidth`, valori di `overflow` — e sono i numeri
 * MISURATI il 2026-09-12 in Chromium e in WebKit su una pagina che riproduce la
 * struttura del visore di `MediaGrid.tsx` (righe 714-967). Ciò che si prova qui è
 * la DECISIONE che la sonda prende davanti a quei numeri, che è aritmetica di
 * rettangoli. Che il browser produca quei numeri l'ha detto il browser.
 *
 * ⚠️ Quindi questo file NON può accorgersi del difetto n. 1 (la chiusura sul
 * modulo): in vitest la sonda gira nello stesso processo del test e le variabili
 * del modulo ci sono tutte. È scritto anche in testa alla sonda: chi aggiunge una
 * costante la aggiunga alle OPZIONI, non al modulo.
 */

const TOLLERANZA = 1;

/* ────────────────────────────────────────────────────────────────────────────────
 * IL BANCO DI PROVA — una geometria dichiarata, non calcolata.
 * ──────────────────────────────────────────────────────────────────────────────── */

interface Descr {
    tag?: string;
    classe?: string;
    testid?: string;
    /** Solo le proprietà che la sonda legge. Il resto ha un default sano. */
    stile?: Partial<Record<'display' | 'visibility' | 'position' | 'overflowX' | 'overflowY' | 'textOverflow', string>>;
    /** `[sinistra, alto, destra, basso]` in pixel dal bordo della finestra. */
    rect: [number, number, number, number];
    /** `[scrollWidth, clientWidth]` — serve solo ai contenitori. */
    scorrimento?: [number, number];
    attributi?: Record<string, string>;
    figli?: Descr[];
}

const STILE_BASE = {
    display: 'block',
    visibility: 'visible',
    position: 'static',
    overflowX: 'visible',
    overflowY: 'visible',
    textOverflow: 'clip',
};

let rettangoli: Map<Element, DOMRect>;
let stili: Map<Element, Record<string, string>>;
let getComputedStyleVero: typeof window.getComputedStyle;
let getRectVero: typeof Element.prototype.getBoundingClientRect;

function rect([l, t, r, b]: [number, number, number, number]): DOMRect {
    return { x: l, y: t, left: l, top: t, right: r, bottom: b, width: r - l, height: b - t, toJSON: () => ({}) } as DOMRect;
}

function monta(d: Descr, genitore: Element): Element {
    const el = document.createElement(d.tag ?? 'div');
    if (d.classe) el.setAttribute('class', d.classe);
    if (d.testid) el.setAttribute('data-testid', d.testid);
    for (const [k, v] of Object.entries(d.attributi ?? {})) el.setAttribute(k, v);
    genitore.appendChild(el);
    rettangoli.set(el, rect(d.rect));
    stili.set(el, { ...STILE_BASE, ...(d.stile ?? {}) });
    const [sw, cw] = d.scorrimento ?? [d.rect[2] - d.rect[0], d.rect[2] - d.rect[0]];
    Object.defineProperty(el, 'scrollWidth', { value: sw, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: cw, configurable: true });
    for (const f of d.figli ?? []) monta(f, el);
    return el;
}

/** Pianta l'albero e installa le protesi di geometria. La vista è 390×844. */
function banco(radici: Descr[], larghezzaVista = 390): void {
    document.body.innerHTML = '';
    for (const r of radici) monta(r, document.body);
    Object.defineProperty(document.documentElement, 'clientWidth', { value: larghezzaVista, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollWidth', { value: larghezzaVista, configurable: true });
}

beforeEach(() => {
    rettangoli = new Map();
    stili = new Map();
    getComputedStyleVero = window.getComputedStyle;
    getRectVero = Element.prototype.getBoundingClientRect;
    // jsdom non ha layout: `getComputedStyle` non conosce `overflow-x` e
    // `getBoundingClientRect` restituisce zeri. Le due protesi rispondono col dato
    // dichiarato — ed è l'unico modo onesto di provare una decisione geometrica
    // senza un motore di rendering.
    window.getComputedStyle = ((el: Element) =>
        (stili.get(el) ?? STILE_BASE) as unknown as CSSStyleDeclaration) as typeof window.getComputedStyle;
    Element.prototype.getBoundingClientRect = function (this: Element) {
        return rettangoli.get(this) ?? rect([0, 0, 0, 0]);
    };
});

afterEach(() => {
    window.getComputedStyle = getComputedStyleVero;
    Element.prototype.getBoundingClientRect = getRectVero;
    document.body.innerHTML = '';
});

/* ────────────────────────────────────────────────────────────────────────────────
 * IL VISORE DELLA GALLERIA, coi numeri veri.
 *
 * Struttura: `fixed inset-0` → `absolute inset-0 overflow-y-auto` → involucro flex
 * centrante `px-4` → `visore-colonna` (358 px) → la riga dei comandi.
 * Misure prese in Chromium e in WebKit (identiche nei due motori):
 *   · `overflow-x` dello scorrimento ....... "auto"  ← nessuno l'ha scritto
 *   · rettangolo dello scorrimento ......... 0 … 390 (= la vista, sta in un `fixed`)
 *   · `scrollWidth`/`clientWidth` .......... 438 / 390
 *   · prima pillola ........................ −48 … 78
 *   · terza pillola ........................ 238 … 438
 *   · `scrollWidth` della PAGINA ........... 390 = `clientWidth`
 * ──────────────────────────────────────────────────────────────────────────────── */
function visore(pillole: [number, number][], scorrimentoLargo: number): Descr {
    return {
        classe: 'fixed inset-0 z-50',
        attributi: { role: 'dialog' },
        stile: { position: 'fixed' },
        rect: [0, 0, 390, 844],
        figli: [
            {
                testid: 'visore-scorrimento',
                classe: 'absolute inset-0 overflow-y-auto overscroll-contain z-10',
                stile: { position: 'absolute', overflowY: 'auto', overflowX: 'auto' },
                rect: [0, 0, 390, 844],
                scorrimento: [scorrimentoLargo, 390],
                figli: [
                    {
                        classe: 'flex min-h-full items-center justify-center px-4',
                        rect: [0, 0, 390, 844],
                        figli: [
                            {
                                testid: 'visore-colonna',
                                classe: 'relative max-w-2xl w-full',
                                stile: { position: 'relative' },
                                rect: [16, 322, 374, 522],
                                figli: [
                                    {
                                        classe: 'relative bg-white rounded-2xl overflow-hidden p-3',
                                        stile: { position: 'relative', overflowX: 'hidden', overflowY: 'hidden' },
                                        rect: [16, 322, 374, 462],
                                    },
                                    {
                                        testid: 'visore-comandi',
                                        classe: 'flex items-center justify-center gap-2 mt-4',
                                        rect: [16, 478, 374, 518],
                                        figli: pillole.map(([l, r], i) => ({
                                            tag: 'button',
                                            classe: `pillola p${i + 1}`,
                                            rect: [l, 478, r, 518] as [number, number, number, number],
                                        })),
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

/** Le tre pillole come stavano in produzione: 486 px in 358, con `justify-center`. */
const PILLOLE_CHE_SFONDANO: [number, number][] = [[-48, 78], [86, 230], [238, 438]];
/** Le stesse, dopo `flex-wrap`: due righe, tutte dentro la colonna 16…374. */
const PILLOLE_A_CAPO: [number, number][] = [[52, 178], [186, 330], [103, 303]];

describe('sonda di impaginazione — i comandi tagliati DENTRO un contenitore', () => {
    it('ROSSA sulla riga di pillole che sfonda: la misura che mancava spara', () => {
        banco([visore(PILLOLE_CHE_SFONDANO, 438)]);
        const e = sondaImpaginazione({ tolleranza: TOLLERANZA });

        // ── CONTROLLO NEGATIVO: le due misure che ESISTEVANO non vedono niente ──
        // Non è un dettaglio di contorno: è la dimostrazione che senza le due
        // misure nuove questo crawler sarebbe stato verde esattamente sul difetto
        // che la sua testata cita come prima ragione d'esistere.
        expect(
            e.totaleFuori,
            'Il ritaglio degli antenati riporta la pillola dentro i bordi (−48…78 → 0…78): la ' +
                'misura «chi sporge dal telefono» NON può vedere ciò che sfonda dentro il visore.',
        ).toBe(0);
        expect(
            e.scrollWidth,
            'E nemmeno la pagina scorre: il visore è un `fixed`, quindi `document.scrollingElement` ' +
                'non se ne accorge. Erano i due soli cancelli del crawler.',
        ).toBe(e.clientWidth);

        // ── LE DUE MISURE NUOVE ─────────────────────────────────────────────────
        expect(e.totaleNascosti, 'il contenitore che scorre di lato senza averlo chiesto').toBe(1);
        expect(e.nascosti[0].firma).toContain('visore-scorrimento');
        expect([e.nascosti[0].scrollWidth, e.nascosti[0].clientWidth]).toEqual([438, 390]);

        // La prima pillola tagliata a SINISTRA (−48: `scrollWidth` non la vede mai,
        // perché l'area scorribile in LTR cresce solo a destra) e la terza a destra.
        expect(e.totaleTagliati, 'i comandi tagliati dal proprio contenitore').toBe(2);
        expect(e.tagliati.map((t) => [t.sinistraGrezza, t.destraGrezza, t.sinistraVista, t.destraVista])).toEqual([
            [-48, 78, 0, 78],
            [238, 438, 238, 390],
        ]);
        expect(e.tagliati[0].da).toContain('visore-scorrimento');
    });

    it('PULITA con `flex-wrap`, e il verde è misurato (i pavimenti restano > 0)', () => {
        banco([visore(PILLOLE_A_CAPO, 390)]);
        const e = sondaImpaginazione({ tolleranza: TOLLERANZA });

        expect([e.totaleFuori, e.totaleNascosti, e.totaleTagliati]).toEqual([0, 0, 0]);
        // Un verde senza questi due numeri sarebbe indistinguibile da «non ho
        // guardato»: è la lezione di `sonda_misurava_il_guscio`.
        expect(e.contenitori, 'contenitori che scorrono, confrontati').toBeGreaterThanOrEqual(1);
        expect(e.comandi, 'comandi dentro un contenitore che ritaglia, confrontati').toBe(3);
        expect(e.esaminati).toBeGreaterThan(5);
    });

    it('un comando spinto INTERAMENTE fuori dal bordo resta un rosso', () => {
        // Il caso peggiore, e quello che si perderebbe più facilmente: area
        // ritagliata nulla. La sonda valuta il ritaglio PRIMA di scartare gli
        // elementi ridotti a zero, e questo test è l'unico posto che lo prova.
        banco([visore([[-300, -174], [86, 230], [238, 300]], 438)]);
        const e = sondaImpaginazione({ tolleranza: TOLLERANZA });
        expect(e.totaleTagliati).toBe(1);
        expect(e.tagliati[0].sinistraGrezza).toBe(-300);
    });
});

describe('sonda di impaginazione — ciò che sfonda DI PROPOSITO non è un difetto', () => {
    /**
     * I quattro casi sani che il repo contiene a decine, coi numeri misurati nel
     * browser. Se uno di questi diventasse rosso, il crawler segnalerebbe come
     * difetto un carosello o un testo troncato — e la risposta imparata sarebbe
     * allargare la tolleranza, cioè spegnere anche il caso vero.
     */
    it('carosello dichiarato, troncamento, campo di testo e tabella larga: tutti puliti', () => {
        banco([
            {
                // `ChildSwitcher`: `flex gap-2.5 overflow-x-auto px-5`. 630 px in 390.
                classe: 'flex gap-2.5 overflow-x-auto px-5',
                stile: { overflowX: 'auto', overflowY: 'visible' },
                rect: [0, 0, 390, 44],
                scorrimento: [630, 390],
                figli: [
                    { tag: 'button', classe: 'chip', rect: [20, 0, 160, 44] },
                    { tag: 'button', classe: 'chip', rect: [170, 0, 310, 44] },
                    // Questi due il carosello li taglia, ed è il suo mestiere.
                    { tag: 'button', classe: 'chip', rect: [320, 0, 460, 44] },
                    { tag: 'button', classe: 'chip', rect: [470, 0, 610, 44] },
                ],
            },
            {
                // `truncate` = `overflow-hidden text-ellipsis whitespace-nowrap`.
                classe: 'truncate w-30',
                stile: { overflowX: 'hidden', overflowY: 'hidden', textOverflow: 'ellipsis' },
                rect: [0, 60, 120, 84],
                scorrimento: [300, 120],
            },
            {
                // Un campo con dentro più testo di quanto ne mostri: è il widget.
                tag: 'input',
                classe: 'w-30',
                rect: [0, 90, 120, 122],
                scorrimento: [300, 120],
            },
            {
                classe: 'kv-table-scroll overflow-x-auto',
                stile: { overflowX: 'auto', overflowY: 'visible' },
                rect: [0, 130, 320, 160],
                scorrimento: [900, 320],
                figli: [{ classe: 'larga', rect: [0, 130, 900, 160] }],
            },
        ]);
        const e = sondaImpaginazione({ tolleranza: TOLLERANZA });

        expect([e.totaleFuori, e.totaleNascosti, e.totaleTagliati]).toEqual([0, 0, 0]);
        // …e non perché non abbia guardato: due contenitori scorrevoli confrontati.
        expect(e.contenitori).toBeGreaterThanOrEqual(2);
    });

    /**
     * Il confine fra «carosello» e «difetto» è una riga di regex, e questa tabella
     * è quella riga vista da fuori. Ogni caso è un contenitore che scorre di lato
     * (630 px in 390): l'unica differenza è che cosa c'è scritto nel `className`.
     * Le stringhe sono copiate dai file veri del repo.
     */
    const CLASSI: [string, boolean][] = [
        ['overflow-x-auto', true],
        ['flex gap-2.5 overflow-x-auto px-5', true],                       // ChildSwitcher
        ['md:hidden mb-4 min-w-0 overflow-x-auto', true],                  // NewsNav
        ['overflow-auto rounded', true],
        ['overflow-x-scroll', true],
        ['kv-table-scroll overflow-x-auto', true],                         // cockpit
        ['min-w-0 flex-1 snap-x snap-mandatory overflow-x-auto', true],    // BarraFiltri
        ['absolute inset-0 overflow-y-auto overscroll-contain z-10', false], // il VISORE
        ['grid grid-cols-1 gap-2 max-h-40 overflow-y-auto pr-1', false],   // taggati-elenco
        ['overflow-hidden rounded-2xl', false],
        ['overflow-y-scroll', false],
        ['no-overflow-x-auto-here', false],
        ['', false],
    ];

    it.each(CLASSI)('«%s» → ritaglio dichiarato: %s', (classe, dichiarato) => {
        banco([
            {
                classe,
                stile: { overflowX: 'auto', overflowY: 'auto' },
                rect: [0, 0, 390, 80],
                scorrimento: [630, 390],
            },
        ]);
        const e = sondaImpaginazione({ tolleranza: TOLLERANZA });
        expect(e.contenitori, 'il contenitore va comunque CONTATO, esentato o no').toBe(1);
        expect(e.totaleNascosti).toBe(dichiarato ? 0 : 1);
    });

    it('`overflow-y-auto` NON è un ritaglio dichiarato — è l’asse sbagliato', () => {
        // La differenza fra il carosello del test precedente e il visore è UNA
        // classe, e tutta questa sonda vive su quella differenza: chi scrive
        // `overflow-x-auto` ha chiesto di scorrere di lato; chi scrive
        // `overflow-y-auto` ha chiesto di scorrere in GIÙ, e l'asse X gliel'ha
        // aperto il CSS senza dirglielo.
        banco([
            {
                classe: 'overflow-y-auto h-20 w-full',
                stile: { overflowX: 'auto', overflowY: 'auto' },
                rect: [0, 0, 390, 80],
                scorrimento: [616, 390],
                figli: [{ tag: 'button', classe: 'pill', rect: [208, 0, 408, 40] }],
            },
        ]);
        const e = sondaImpaginazione({ tolleranza: TOLLERANZA });
        expect(e.totaleNascosti).toBe(1);
        expect(e.totaleTagliati).toBe(1);
    });
});

describe('sonda di impaginazione — i filtri che tengono lontani i fantasmi', () => {
    it('un rettangolo 1×1 (`sr-only`) non entra in nessuna misura', () => {
        // Nel crawler di contrasto lo skip-link ha prodotto QUATTRO falsi verdi.
        banco([{ classe: 'sr-only', rect: [-9999, 0, -9998, 1] }]);
        const e = sondaImpaginazione({ tolleranza: TOLLERANZA });
        expect([e.esaminati, e.totaleFuori]).toEqual([0, 0]);
    });

    it('`display:none` e `visibility:hidden` non si misurano', () => {
        banco([
            { classe: 'a', stile: { display: 'none' }, rect: [-500, 0, 900, 40] },
            { classe: 'b', stile: { visibility: 'hidden' }, rect: [-500, 50, 900, 90] },
        ]);
        expect(sondaImpaginazione({ tolleranza: TOLLERANZA }).esaminati).toBe(0);
    });

    it('chi sporge davvero dal telefono viene ancora segnalato (la misura 1 spara)', () => {
        // Il controllo positivo della PRIMA misura: senza questo, i tre test qui
        // sopra sarebbero compatibili con una sonda che non segnala mai niente.
        banco([{ classe: 'w-screen', rect: [0, 0, 520, 60] }, { classe: 'dentro', rect: [8, 70, 382, 100] }]);
        const e = sondaImpaginazione({ tolleranza: TOLLERANZA });
        expect(e.totaleFuori).toBe(1);
        expect(e.fuori[0]).toMatchObject({ sinistra: 0, destra: 520 });
        expect(e.esaminati).toBe(2);
    });

    it('la tolleranza assorbe l’arrotondamento e non un difetto', () => {
        banco([{ classe: 'quasi', rect: [0, 0, 390.6, 40] }]);
        expect(sondaImpaginazione({ tolleranza: TOLLERANZA }).totaleFuori).toBe(0);
        banco([{ classe: 'no', rect: [0, 0, 393, 40] }]);
        expect(sondaImpaginazione({ tolleranza: TOLLERANZA }).totaleFuori).toBe(1);
    });
});
