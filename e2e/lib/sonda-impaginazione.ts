/**
 * Sonda di impaginazione — misura, in pixel veri, dove finiscono i rettangoli di
 * una schermata resa: quello che sporge dal telefono, quello che un contenitore
 * sta NASCONDENDO di lato, e i comandi che il proprio contenitore taglia.
 *
 * ─── PERCHÉ STA IN UN MODULO A PARTE, E NON DENTRO LO SPEC ───────────────────
 * Per la stessa ragione di `e2e/lib/sonda-contrasto.ts`, e la ragione è misurata:
 * il crawler gira SOLO in CI (`.env.local` punta al database di produzione,
 * `npm run e2e` e `npx playwright test` sono in `deny`). Se l'unica verifica di
 * questa logica fosse dentro il crawler, un errore di ritaglio si scoprirebbe con
 * un giro di CI — e un errore che restituisce ZERO renderebbe il crawler verde su
 * tutto senza che nessuno se ne accorga. **È già accaduto a questa sonda**, e il
 * blocco qui sotto lo racconta. Da modulo, `__tests__/architecture/sonda-impaginazione.test.ts`
 * la esegue in locale su geometrie NOTE e pretende che diventi rossa.
 *
 * ─── ⚠️ IL CORPO DI `sondaImpaginazione` GIRA NEL BROWSER, E NON PUÒ CHIUDERE
 *        SU NIENTE ────────────────────────────────────────────────────────────
 * `page.evaluate(fn)` serializza la funzione e la valuta nella pagina: qualunque
 * riferimento a una costante del modulo diventa una variabile che nella pagina non
 * esiste. La prima versione di questa sonda leggeva `TOLLERANZA` dal modulo dello
 * spec, con sopra un commento che diceva di non farlo. Misurato il 2026-09-12 con
 * la sonda ESTRATTA dal file vero ed eseguita su una pagina che riproduce il
 * visore:
 *
 *   chromium → ReferenceError: TOLLERANZA is not defined
 *   webkit   → ReferenceError: Can't find variable: TOLLERANZA
 *
 * Cioè il crawler non misurava niente: moriva alla prima lettura. Per questo la
 * tolleranza **arriva come argomento** (`page.evaluate(sonda, { tolleranza })`,
 * la forma che `sondaDom` usa già in `contrasto-schermate.spec.ts`) e ogni aiuto
 * è definito DENTRO la funzione. Chi aggiunge una costante qui la aggiunga alle
 * opzioni, non al modulo: il test in vitest la esegue nello stesso processo e
 * quindi **non** vedrebbe l'errore, mentre la CI sì.
 */

/** Le soglie, che devono ATTRAVERSARE il confine del browser insieme alla sonda. */
export interface OpzioniSonda {
    /** Pixel di arrotondamento tollerati su ogni confronto (lo spec passa 1). */
    tolleranza: number;
}

/** Un elemento il cui rettangolo esce dalla larghezza del telefono. */
export interface Fuori {
    firma: string;
    sinistra: number;
    destra: number;
}

/**
 * Un contenitore che SCORRE DI LATO senza averlo chiesto: qualcuno gli ha scritto
 * il solo asse verticale (`overflow-y-auto`) e il CSS ha portato anche l'asse X ad
 * `auto`. Ciò che sfonda là dentro non si vede, e a sinistra non si raggiunge
 * nemmeno scorrendo.
 */
export interface Nascosto {
    firma: string;
    scrollWidth: number;
    clientWidth: number;
    overflowX: string;
}

/** Un comando tagliato di lato dal proprio contenitore: mezzo pulsante. */
export interface Tagliato {
    firma: string;
    /** Il rettangolo VERO del comando. */
    sinistraGrezza: number;
    destraGrezza: number;
    /** Quello che ne resta dopo il ritaglio degli antenati: ciò che un dito trova. */
    sinistraVista: number;
    destraVista: number;
    /** Chi taglia (il più vicino antenato che ritaglia in orizzontale). */
    da: string;
}

export interface EsitoImpaginazione {
    /** `documentElement.clientWidth`: la larghezza vera della vista. */
    larghezzaVista: number;
    /** Scorrimento orizzontale della PAGINA. */
    scrollWidth: number;
    clientWidth: number;
    /** Elementi con area visibile che la sonda ha guardato. Zero = sonda cieca. */
    esaminati: number;
    /** Contenitori che scorrono in orizzontale, confrontati. Zero = misura vacua. */
    contenitori: number;
    /** Comandi dentro un contenitore che ritaglia, confrontati. Zero = misura vacua. */
    comandi: number;
    fuori: Fuori[];
    totaleFuori: number;
    nascosti: Nascosto[];
    totaleNascosti: number;
    tagliati: Tagliato[];
    totaleTagliati: number;
}

/**
 * Le tre misure, in una sola passata sul DOM.
 *
 * ─── 1 · CHI SPORGE DAL TELEFONO (`fuori`) ───────────────────────────────────
 * Il rettangolo di ogni elemento, INTERSECATO con quello di tutti gli antenati che
 * ritagliano, contro la larghezza della vista. Il ritaglio serve: in questo repo le
 * tessere hanno `rounded-2xl overflow-hidden` e ci vivono dentro decorazioni in
 * posizione assoluta, per progetto — segnalarle sarebbe un falso rosso.
 *
 * ─── 2 · CHI NASCONDE DI LATO (`nascosti`) — ED È LA MISURA CHE MANCAVA ──────
 * Il ritaglio della misura 1 ha un costo, e il 2026-09-12 quel costo è stato
 * misurato: **rende invisibile alla sonda tutto ciò che sfonda DENTRO il visore**,
 * cioè esattamente dove stavano le tre pillole da cui questo crawler è nato.
 * Il perché è una regola del CSS: un asse `visible` accanto a un asse che non lo è
 * computa ad `auto`. Quindi `absolute inset-0 overflow-y-auto` (il contenitore del
 * visore, `MediaGrid.tsx:746`) ha `overflow-x: auto` senza che nessuno l'abbia
 * scritto, ritaglia, e il suo rettangolo È il viewport — perché sta dentro un
 * `fixed inset-0`. Misura su una pagina che riproduce quella struttura, identica
 * sui due motori:
 *
 *   overflow-x dello scorrimento ........ "auto"   (non "visible")
 *   suo rettangolo ...................... 0 … 390  (= la vista)
 *   prima pillola, rettangolo VERO ...... −48 … 78
 *   prima pillola, dopo il ritaglio ......  0 … 78  ← dentro i bordi, non segnalata
 *   scrollWidth della PAGINA ............ 390 = clientWidth  ← il 2° cancello tace
 *   scrollWidth dello SCORRIMENTO ....... 438 > 390 ← l'UNICO testimone
 *
 * Il testimone era quel 438, e nessuno lo leggeva: mezza pillola fuori schermo e
 * tre misure verdi. Da qui questa seconda misura — `scrollWidth <= clientWidth` su
 * OGNI contenitore che scorre in orizzontale.
 *
 * ─── 3 · CHI TAGLIA UN COMANDO (`tagliati`) ─────────────────────────────────
 * `scrollWidth` non vede lo sfondamento a SINISTRA: in LTR l'area scorribile
 * cresce solo a destra, e i −48 px della prima pillola non compaiono in nessun
 * conteggio. Sono però la metà del comando che manca al dito. Quindi, per i soli
 * COMANDI (pulsanti, link, campi), si confronta il rettangolo VERO con quello che
 * il ritaglio lascia: se il contenitore ne mangia un pezzo, è un rosso che dice
 * quanto. Solo i comandi, e non ogni elemento, perché un elemento decorativo
 * tagliato dal proprio contenitore è un effetto grafico voluto — un pulsante
 * tagliato non lo è mai.
 *
 * ─── COSA RESTA ESENTATO, E PERCHÉ NON È UNA SCAPPATOIA ─────────────────────
 *  · Un contenitore che DICHIARA lo scorrimento orizzontale nel proprio
 *    `className` (`overflow-x-auto`, `overflow-auto`, `snap-x`, `kv-table-scroll`)
 *    sfonda per scelta: è un carosello, e il gesto per raggiungerlo c'è perché
 *    l'ha messo l'autore. In questo repo ce ne sono una trentina (i filtri delle
 *    news, il selettore figlio, le tabelle larghe). Ciò che questa misura cerca è
 *    l'opposto: l'asse X diventato scorrevole DA SOLO, per propagazione.
 *  · `text-overflow: ellipsis` — `truncate` di Tailwind. Un testo troncato coi
 *    puntini ha `scrollWidth > clientWidth` per costruzione, ed è la forma
 *    corretta: il repo la usa in decine di punti proprio per NON sfondare.
 *  · Campi, media e controlli (`input`, `textarea`, `select`, `button`, `img`,
 *    `video`, `canvas`, `iframe`): il loro scorrimento interno è del widget, non
 *    dell'impaginazione. Un `<input>` con dentro più testo di quanto ne mostri ha
 *    `scrollWidth > clientWidth` sempre, e non è un difetto di layout.
 *
 * ─── COSA QUESTA SONDA NON PUÒ VEDERE, dichiarato invece che taciuto ────────
 *  · un `overflow-hidden` (non scorrevole) che nasconde di lato qualcosa che NON è
 *    un comando: la misura 2 guarda solo i contenitori che scorrono, e la 3 solo i
 *    comandi. Un testo lungo tagliato a metà dentro una tessera non compare qui —
 *    lo prende il lock del rapporto d'aspetto se è un media, o nessuno se è testo;
 *  · un elemento ritagliato a zero (fuori vista in verticale, dentro uno scroller):
 *    non è sullo schermo e non è un difetto di larghezza;
 *  · `visibility: collapse`, `content-visibility`, `clip-path`: non li legge.
 *
 * ─── NIENTE DATI PERSONALI, MAI ─────────────────────────────────────────────
 * `firma()` compone SOLO tag, `data-testid` e le prime quattro classi. Mai
 * `textContent`, `alt`, `title`, `aria-label`, `src`: il nome accessibile di una
 * tessera di galleria è «Foto: <didascalia>» e la didascalia, in questo prodotto, è
 * il nome del file — che spesso contiene il nome di un bambino; il `src` è un URL
 * firmato su un bucket privato, cioè una credenziale. `playwright-report/` finisce
 * fra gli artefatti di una CI **pubblica**.
 */
export function sondaImpaginazione({ tolleranza }: OpzioniSonda): EsitoImpaginazione {
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

    /** Un ritaglio orizzontale VOLUTO: un carosello dichiarato, o un troncamento. */
    const ritaglioDichiarato = (el: Element, st: CSSStyleDeclaration): boolean => {
        if (st.textOverflow === 'ellipsis') return true;
        const classi = el.getAttribute('class') ?? '';
        return /(?:^|[\s:[])overflow-(?:x-)?(?:auto|scroll)(?![\w-])|(?:^|\s)snap-x(?![\w-])|kv-table-scroll/.test(
            classi,
        );
    };

    /**
     * Ciò che NON è un contenitore di impaginazione: widget con uno scorrimento
     * proprio e elementi rimpiazzati. Per gli SVG la questione non si pone —
     * `scrollWidth` non esiste su `SVGElement` — e il filtro `instanceof
     * HTMLElement` li lascia fuori da solo.
     */
    const NON_CONTENITORI = new Set([
        'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'PROGRESS', 'METER',
        'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'EMBED', 'OBJECT',
    ]);

    const COMANDI = 'button, a[href], input, select, textarea, summary, [role="button"]';

    const scroller = document.scrollingElement ?? document.documentElement;
    const larghezzaVista = document.documentElement.clientWidth;

    const fuori: Fuori[] = [];
    const nascosti: Nascosto[] = [];
    const tagliati: Tagliato[] = [];
    let esaminati = 0;
    let contenitori = 0;
    let comandi = 0;

    for (const el of Array.from(document.querySelectorAll('body *'))) {
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;

        const r = el.getBoundingClientRect();
        // Sotto i 2 px in una direzione non c'è difetto da vedere, e ci vivono i
        // fantasmi: lo skip-link `sr-only` è un rettangolo di 1×1 px che nessuno
        // vede, e nel crawler di contrasto ha prodotto QUATTRO falsi verdi prima
        // che qualcuno lo notasse. Un separatore `h-px` che sfondasse di lato
        // farebbe comunque scorrere la pagina, cioè cadrebbe nella prima misura.
        if (r.width < 2 || r.height < 2) continue;

        // ── MISURA 2 · un contenitore che scorre di lato senza averlo chiesto ──
        if (
            el instanceof HTMLElement &&
            !NON_CONTENITORI.has(el.tagName) &&
            (st.overflowX === 'auto' || st.overflowX === 'scroll')
        ) {
            contenitori++;
            if (!ritaglioDichiarato(el, st) && el.scrollWidth > el.clientWidth + tolleranza) {
                nascosti.push({
                    firma: firma(el),
                    scrollWidth: el.scrollWidth,
                    clientWidth: el.clientWidth,
                    overflowX: st.overflowX,
                });
            }
        }

        let sinistra = r.left;
        let destra = r.right;
        let alto = r.top;
        let basso = r.bottom;
        /** Il più vicino antenato che ritaglia in orizzontale: chi taglia. */
        let ritagliante = '';
        /** Un antenato che ritaglia in orizzontale DI PROPOSITO (carosello, troncamento). */
        let ritaglioVoluto = false;

        // Un elemento `fixed` NON è tagliato dagli antenati (salvo trasformazioni
        // sull'antenato, caso che qui non esiste): applicargli il ritaglio lo
        // renderebbe invisibile agli occhi del crawler, cioè NASCONDEREBBE un
        // difetto invece di inventarlo. Meglio misurarlo intero.
        if (st.position !== 'fixed') {
            for (let p = el.parentElement; p; p = p.parentElement) {
                const ps = getComputedStyle(p);
                const tagliaX = ps.overflowX !== 'visible';
                const tagliaY = ps.overflowY !== 'visible';
                if (!tagliaX && !tagliaY) continue;
                const pr = p.getBoundingClientRect();
                if (tagliaX) {
                    if (!ritagliante) ritagliante = firma(p);
                    if (ritaglioDichiarato(p, ps)) ritaglioVoluto = true;
                    sinistra = Math.max(sinistra, pr.left);
                    destra = Math.min(destra, pr.right);
                }
                if (tagliaY) {
                    alto = Math.max(alto, pr.top);
                    basso = Math.min(basso, pr.bottom);
                }
            }
        }

        // ── MISURA 3 · un comando tagliato di lato dal proprio contenitore ─────
        // Si valuta PRIMA dello scarto «ritagliato via del tutto»: un pulsante
        // spinto interamente fuori dal bordo sinistro ha area nulla, ed è il caso
        // peggiore dei due — non quello da saltare. Resta però la condizione che
        // sia in scena VERTICALMENTE: un pulsante sotto la piega, dentro uno
        // scroller, non è «tagliato», è da scorrere (misura 3 dello spec).
        if (ritagliante && basso - alto >= 2 && !ritaglioVoluto && el.matches(COMANDI)) {
            comandi++;
            if (r.left < sinistra - tolleranza || r.right > destra + tolleranza) {
                tagliati.push({
                    firma: firma(el),
                    sinistraGrezza: Math.round(r.left),
                    destraGrezza: Math.round(r.right),
                    sinistraVista: Math.round(sinistra),
                    destraVista: Math.round(destra),
                    da: ritagliante,
                });
            }
        }

        // Tagliato via del tutto: non è sullo schermo, non è un difetto di larghezza.
        if (destra - sinistra < 2 || basso - alto < 2) continue;

        esaminati++;
        if (sinistra < -tolleranza || destra > larghezzaVista + tolleranza) {
            fuori.push({ firma: firma(el), sinistra: Math.round(sinistra), destra: Math.round(destra) });
        }
    }

    return {
        larghezzaVista,
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        esaminati,
        contenitori,
        comandi,
        // I tetti sui campioni: un rapporto di CI non è un posto dove versare
        // duemila righe, e le prime venti bastano a triagare. I `totale*` restano
        // interi, quindi nessuna misura si perde per il taglio.
        fuori: fuori.slice(0, 40),
        totaleFuori: fuori.length,
        nascosti: nascosti.slice(0, 20),
        totaleNascosti: nascosti.length,
        tagliati: tagliati.slice(0, 20),
        totaleTagliati: tagliati.length,
    };
}
