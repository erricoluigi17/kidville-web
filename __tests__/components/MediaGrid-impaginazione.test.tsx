import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MediaGrid, type MediaItem, type Student } from '@/components/features/gallery/MediaGrid';
import { GalleriaSedeGiornate, type FotoSede } from '@/components/features/gallery/GalleriaSedeGiornate';
import itShared from '../../messages/it/shared.json';

/**
 * L'IMPAGINAZIONE DELLA GALLERIA — E PERCHÉ QUESTO FILE NON MISURA PIXEL.
 *
 * ─── IL DIFETTO, riferito dal titolare dall'app iOS ─────────────────────────
 * Nel visore della galleria (genitore e insegnante) il pulsante «Elimina Media»
 * «non esiste». Esiste: cade fuori dallo schermo. Il conto su iPhone 14
 * (390×844, meno le aree di sicurezza = 763 px utili) dice che la colonna del
 * visore misura ~840 px — immagine 464 + didascalia 52 + pannello dei taggati
 * 200 + bottone Elimina 52 + margini 72 — dentro un contenitore `fixed` con
 * `overflow-hidden`. Mancano ~80 px, e l'ultimo figlio della colonna è proprio
 * il bottone: sparisce sotto il bordo, senza barra di scorrimento perché il
 * contenitore non scorre.
 *
 * ─── PERCHÉ NON SI ASSERISCONO PIXEL ────────────────────────────────────────
 * jsdom NON fa layout: `offsetWidth`/`offsetHeight`/`getBoundingClientRect()`
 * valgono zero per ogni nodo, e nessuna regola di Tailwind viene applicata (il
 * CSS non è nemmeno caricato). Un test che scrivesse
 * `expect(colonna.offsetHeight).toBeLessThan(763)` sarebbe VERDE con e senza la
 * correzione — cioè una bugia, esattamente la categoria di test che questo repo
 * ha già pagato («un mock piatto è verde CON e SENZA la correzione»).
 *
 * Quello che jsdom sa dire con certezza è la STRUTTURA e le CLASSI che un dato
 * insieme di props produce. È più forte di una grep sul sorgente per due motivi:
 * dipende dai props (`colonne={4}` deve produrre `grid-cols-4`, e una grep non
 * sa quale ramo viene preso), e vede la GERARCHIA — «nessun antenato della
 * colonna clippa» è una proprietà dell'albero, non del testo del file.
 *
 * La verifica sui pixel veri resta il giro sul simulatore/telefono: qui si
 * blocca la forma che li produce.
 */

/** Le classi di un nodo, come lista. */
function classi(el: Element): string[] {
    return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

/** Tutti gli antenati di un nodo, dal padre alla radice. */
function antenati(el: Element): Element[] {
    const out: Element[] = [];
    let p: Element | null = el.parentElement;
    while (p) {
        out.push(p);
        p = p.parentElement;
    }
    return out;
}

/** Il tetto d'altezza dichiarato su un media (`max-h-[…]`), se c'è. */
function tettoAltezza(el: Element): string | undefined {
    return classi(el).find((c) => /^max-h-\[/.test(c));
}

/*
 * I NOMI ACCESSIBILI DELLE DUE CARD, PER INTERO E NON PER PREFISSO.
 *
 * Il critico del 2026-09-11 ha cancellato `aria-label={etichettaCard(item, t)}`
 * da MediaGrid e i 21 test di questo file sono rimasti VERDI. Il motivo: le
 * asserzioni cercavano `name: /Laboratorio dei colori/` e `name: /^Video/`.
 * Senza `aria-label` il nome accessibile si calcola dal CONTENUTO, diventa
 * «Laboratorio dei colori Insegnante • 3g fa» — cioè esattamente il difetto «il
 * comando inghiotte tutto ciò che contiene» che l'attributo esiste per evitare —
 * e quelle due regex corrispondono comunque. Un prefisso non è un nome.
 *
 * La parola del tipo si legge dal CATALOGO e non si riscrive qui: così questo
 * test cade anche nel caso opposto, cioè se la chiave sparisse dal catalogo e a
 * schermo finisse `shared.galleryVideo`.
 */
const NOME_CARD_FOTO = `${itShared.galleryAltFoto}: Laboratorio dei colori`;
const NOME_CARD_VIDEO = `${itShared.galleryVideo}: Recita di fine anno`;

const FOTO: MediaItem = {
    id: 'f1',
    file_url: 'https://firmato.test/uploads/a.jpg',
    file_type: 'foto',
    // Didascalie e nomi di fantasia: in questo repo non entrano dati veri di bambini.
    caption: 'Laboratorio dei colori',
    tag_students: [],
    is_broadcast: false,
    created_at: new Date().toISOString(),
    uploader_name: 'Insegnante',
};

const VIDEO: MediaItem = {
    ...FOTO,
    id: 'v1',
    file_type: 'video',
    file_url: 'https://firmato.test/uploads/b.mp4',
    caption: 'Recita di fine anno',
};

/** Il nome lungo della vista di sede: «Nome Cognome — SEZIONE», che sfonda i chip. */
const ALUNNI: Student[] = [
    { id: 's1', nome: 'Nomefinto', cognome: 'Cognomefinto — PRIMAVERA A' },
];

/** Apre il visore dalla card della foto (il click sull'immagine risale al comando). */
function apriVisoreFoto(): void {
    fireEvent.click(screen.getByAltText('Laboratorio dei colori'));
}

afterEach(() => cleanup());

describe('MediaGrid — il visore scorre e non taglia via i comandi', () => {
    it('esiste uno scroller con overflow-y-auto, e NESSUN antenato della colonna clippa', () => {
        render(<MediaGrid items={[FOTO]} showActions onDelete={async () => {}} />);
        apriVisoreFoto();

        const colonna = screen.getByTestId('visore-colonna');
        const scroller = screen.getByTestId('visore-scorrimento');

        expect(classi(scroller), 'lo scroller non scorre in verticale').toContain('overflow-y-auto');
        // Su iOS un overlay che scorre senza `overscroll-contain` trascina con sé
        // la pagina sotto quando si arriva a fine corsa.
        expect(classi(scroller)).toContain('overscroll-contain');
        expect(scroller.contains(colonna), 'la colonna non sta dentro lo scroller').toBe(true);

        const clippanti = antenati(colonna)
            .filter((a) => classi(a).includes('overflow-hidden'))
            .map((a) => a.getAttribute('class'));
        expect(
            clippanti,
            'un antenato della colonna ha `overflow-hidden`: ciò che sborda non si può ' +
                'raggiungere con nessun gesto, ed è così che «Elimina Media» è sparito',
        ).toEqual([]);
    });

    it('il bottone che cadeva fuori sta DENTRO la colonna che scorre', () => {
        render(<MediaGrid items={[FOTO]} showActions onDelete={async () => {}} />);
        apriVisoreFoto();

        const colonna = screen.getByTestId('visore-colonna');
        const elimina = screen.getByRole('button', { name: /Elimina Media/ });
        expect(
            colonna.contains(elimina),
            'il comando di eliminazione è fuori dalla colonna: se lo scroller scorre la colonna, ' +
                'lui resta dove era',
        ).toBe(true);
    });

    it('il riempimento della colonna rispetta le aree di sicurezza del telefono', () => {
        render(<MediaGrid items={[FOTO]} showActions onDelete={async () => {}} />);
        apriVisoreFoto();

        const involucro = screen.getByTestId('visore-colonna').parentElement!;
        const cls = involucro.getAttribute('class') ?? '';
        // `min-h-full` + `items-center`: centrato quando ci sta, ancorato in alto e
        // scorrevole quando non ci sta. Senza `min-h-full` il centraggio verticale
        // dentro uno scroller taglia il bordo superiore.
        expect(classi(involucro)).toContain('min-h-full');
        expect(cls, 'niente area di sicurezza in cima: sotto la Dynamic Island').toMatch(
            /env\(safe-area-inset-top\)/,
        );
        expect(cls, 'niente area di sicurezza in basso: sotto la barra di casa').toMatch(
            /env\(safe-area-inset-bottom\)/,
        );
    });

    it('il velo sfocato è un FRATELLO, non un antenato della colonna', () => {
        // Lezione già pagata in questo repo (`src/components/ui/Modal.tsx`): sulla
        // WebView Chromium di Android un antenato con `backdrop-filter` CANCELLA
        // l'intero sottoalbero dall'albero di accessibilità — la modale c'era e per
        // TalkBack non esisteva.
        render(<MediaGrid items={[FOTO]} showActions onDelete={async () => {}} />);
        apriVisoreFoto();

        const colonna = screen.getByTestId('visore-colonna');
        const velo = screen.getByTestId('visore-velo');

        expect(velo.getAttribute('aria-hidden')).toBe('true');
        expect(velo.contains(colonna), 'il velo contiene la colonna').toBe(false);
        const sfocati = antenati(colonna)
            .filter((a) => classi(a).some((c) => c.startsWith('backdrop-blur')))
            .map((a) => a.getAttribute('class'));
        expect(
            sfocati,
            'un antenato della colonna sfoca lo sfondo: su Android il visore sparisce da TalkBack',
        ).toEqual([]);
    });

    /**
     * ⚠️ QUESTE DUE NON SONO NATE ROSSE, e va detto: il gesto «clic fuori = chiudi»
     * funzionava già prima, perché il gestore stava sul nodo unico che faceva anche
     * da velo. Spostandolo sullo SCROLLER quel gesto poteva rompersi in silenzio —
     * il velo è diventato un fratello e nessun tocco lo raggiunge più. Sono guardie
     * di regressione, verificate per mutazione (togliendo l'`onClick` dallo scroller
     * cadono entrambe).
     */
    it('un clic sullo sfondo chiude il visore', () => {
        render(<MediaGrid items={[FOTO]} showActions />);
        apriVisoreFoto();
        fireEvent.click(screen.getByTestId('visore-scorrimento'));
        expect(screen.queryByTestId('visore-colonna')).toBeNull();
    });

    it('un clic DENTRO la colonna non chiude niente', () => {
        render(<MediaGrid items={[FOTO]} showActions />);
        apriVisoreFoto();
        fireEvent.click(screen.getByTestId('visore-colonna'));
        expect(screen.getByTestId('visore-colonna')).toBeInTheDocument();
    });

    it('frecce e chiusura NON scorrono con il contenuto: stanno fuori dallo scroller', () => {
        render(<MediaGrid items={[FOTO, VIDEO]} showActions />);
        apriVisoreFoto();

        const scroller = screen.getByTestId('visore-scorrimento');
        const avanti = screen.getByTitle('Successiva (Freccia Destra)');
        expect(scroller.contains(avanti), 'la freccia scorre con il contenuto').toBe(false);
    });
});

describe('MediaGrid — la riga dei tre comandi non sborda', () => {
    it('va a capo invece di farsi tagliare ai due lati', () => {
        // «Scarica» + «Condividi» + «Segnala foto/video» misurano ~494 px in 358
        // disponibili sul telefono: con `justify-center` e senza `flex-wrap`
        // l'eccesso si divide fra i due lati e ~68 px per lato finiscono fuori.
        render(<MediaGrid items={[FOTO]} showActions />);
        apriVisoreFoto();

        const comandi = screen.getByTestId('visore-comandi');
        expect(classi(comandi), 'la riga dei comandi non va a capo').toContain('flex-wrap');
        expect(classi(comandi), 'il gap resta quello largo: tre pillole non ci stanno comunque').not.toContain('gap-3');
    });
});

describe('MediaGrid — il media nel visore', () => {
    it('il <video> ha object-contain, un tetto d’altezza, e NON `w-full` senza rapporto', () => {
        render(<MediaGrid items={[VIDEO]} showActions />);
        fireEvent.click(screen.getByText('Recita di fine anno'));

        const video = document.querySelector('video')!;
        expect(video, 'nessun <video> nel visore').toBeTruthy();
        const cls = classi(video);
        expect(cls, 'senza object-contain un video verticale viene deformato o letterboxato').toContain('object-contain');
        expect(tettoAltezza(video), 'il video non ha tetto d’altezza').toBeTruthy();
        expect(
            cls,
            '`w-full` su un video verticale lo allarga alla colonna e ci mette due fasce nere: ' +
                'la larghezza la decide il rapporto d’aspetto (`w-auto max-w-full`)',
        ).not.toContain('w-full');
        expect(cls).toContain('w-auto');
        expect(cls).toContain('max-w-full');
        // Su iOS il video parte a schermo pieno senza `playsinline`; e senza
        // `preload="metadata"` la WebView può scaricare l'intero file.
        expect(video.hasAttribute('playsinline'), 'niente playsInline: su iOS va a schermo pieno').toBe(true);
        expect(video.getAttribute('preload')).toBe('metadata');
    });

    it('INVARIANTE: <video> e <img> del visore hanno lo STESSO tetto, ed è in `svh`', () => {
        render(<MediaGrid items={[VIDEO]} showActions />);
        fireEvent.click(screen.getByText('Recita di fine anno'));
        const tettoVideo = tettoAltezza(document.querySelector('video')!);
        cleanup();

        render(<MediaGrid items={[FOTO]} showActions />);
        apriVisoreFoto();
        const immagini = [...document.querySelectorAll('img')];
        const nelVisore = immagini.find((i) => tettoAltezza(i) !== undefined);
        const tettoImg = nelVisore ? tettoAltezza(nelVisore) : undefined;

        expect(
            tettoImg,
            'nessuna <img> del visore dichiara un tetto d’altezza',
        ).toBeTruthy();
        expect(
            tettoVideo,
            'due media aperti nello STESSO visore si comportano in due modi diversi',
        ).toBe(tettoImg);
        // `vh` su Safari iOS è il viewport SENZA la barra degli indirizzi: un
        // `max-h-[70vh]` lì vale più del 70% di ciò che si vede, ed è di nuovo
        // contenuto che finisce fuori. `svh` è il viewport piccolo, quello vero.
        expect(tettoVideo, 'il tetto è in `vh`: su Safari iOS è più alto di quanto si veda').toMatch(/svh\]$/);
    });
});

describe('MediaGrid — le colonne della griglia le decide il CHIAMANTE', () => {
    it('il default è due colonne e non c’è nessun `sm:grid-cols-*`', () => {
        // I breakpoint di Tailwind guardano il VIEWPORT, ma questo componente vive
        // in tre contenitori larghi in modo molto diverso: `max-w-[460px]` lato
        // insegnante, ~358 px lato genitore, ~1088 px lato sede. `sm:` diceva «tre
        // colonne» a tutti e tre appena il telefono superava 640 px di viewport.
        render(<MediaGrid items={[FOTO]} />);
        const griglia = screen.getByTestId('griglia-media');
        expect(classi(griglia)).toContain('grid-cols-2');
        expect(
            griglia.getAttribute('class') ?? '',
            'la griglia cambia colonne col viewport, non con lo spazio che ha davvero',
        ).not.toMatch(/\bsm:grid-cols-/);
    });

    it('`colonne={4}` produce grid-cols-4', () => {
        // ⚠️ QUESTO TEST NON DIMOSTRA CHE LA CLASSE SIA LETTERALE, e prima il suo
        // titolo lo prometteva. Il critico ha sostituito `2: 'grid-cols-2'` con
        // ``2: `grid-cols-${2}` `` e i 21 test sono rimasti verdi: nel `class`
        // renderizzato le due forme sono lo stesso byte. La differenza la vede solo
        // il SORGENTE — ed è il test «nessuna classe composta a runtime» qui sotto.
        render(<MediaGrid items={[FOTO]} colonne={4} />);
        expect(classi(screen.getByTestId('griglia-media'))).toContain('grid-cols-4');
    });

    it('`colonne={3}` produce grid-cols-3', () => {
        render(<MediaGrid items={[FOTO]} colonne={3} />);
        expect(classi(screen.getByTestId('griglia-media'))).toContain('grid-cols-3');
    });
});

describe('MediaGrid — la card della griglia', () => {
    it('la riga «chi ha caricato • quando» si tronca invece di sfondare', () => {
        render(<MediaGrid items={[FOTO]} />);
        const riga = screen.getByText(/Insegnante/);
        expect(
            classi(riga),
            'la didascalia sopra ha `truncate` e questa no: un nome lungo esce dalla card',
        ).toContain('truncate');
    });

    it('l’overlay dei comandi dichiara la propria visibilità nel className, senza style inline', () => {
        // `opacity-0 group-hover:opacity-100` più uno `style={{opacity: 1}}` inline:
        // lo stile inline VINCE, quindi le due classi erano codice morto e
        // l'intenzione («sempre visibili, perché su touch non esiste l'hover») non
        // si leggeva da nessuna parte.
        render(<MediaGrid items={[FOTO]} showActions />);
        const scarica = screen.getByTitle('Scarica');
        const contenitore = scarica.parentElement!;

        expect(contenitore.getAttribute('style') ?? '', 'opacità dichiarata inline').not.toMatch(/opacity/);
        const cls = contenitore.getAttribute('class') ?? '';
        expect(cls, 'classe morta: lo style inline la sovrascriveva').not.toMatch(/group-hover:opacity-100/);
        expect(cls, 'classe morta: lo style inline la sovrascriveva').not.toMatch(/\bopacity-0\b/);
        // 28×28 px è sotto il minimo tattile: WCAG 2.5.8 chiede 24, le linee guida
        // di Apple 44. 36 è il compromesso che ci sta in una miniatura.
        expect(classi(scarica)).toContain('h-9');
        expect(classi(scarica)).toContain('w-9');
    });

    it('la card si apre da TASTIERA: è un comando con nome, Invio e Spazio', () => {
        render(<MediaGrid items={[FOTO]} />);
        const comando = screen.getByRole('button', { name: NOME_CARD_FOTO });
        expect(comando).toHaveAttribute('tabindex', '0');

        fireEvent.keyDown(comando, { key: 'Enter' });
        expect(screen.getByTestId('visore-colonna')).toBeInTheDocument();
    });

    it('anche la barra spaziatrice apre la card', () => {
        render(<MediaGrid items={[FOTO]} />);
        fireEvent.keyDown(screen.getByRole('button', { name: NOME_CARD_FOTO }), { key: ' ' });
        expect(screen.getByTestId('visore-colonna')).toBeInTheDocument();
    });

    it('la miniatura di un video si legge come un video, e non carica il video', () => {
        render(<MediaGrid items={[VIDEO]} />);
        // Etichetta TESTUALE, non la sola icona: un quadrato scuro con un
        // triangolino non dice a nessuno che cos'è.
        expect(screen.getByText(itShared.galleryVideo)).toBeInTheDocument();
        // NOME INTERO: con `/^Video/` il test restava verde anche senza
        // `aria-label`, perché il nome calcolato dal contenuto comincia con
        // «Video» comunque — e perdeva per strada la didascalia.
        expect(screen.getByRole('button', { name: NOME_CARD_VIDEO })).toBeInTheDocument();
        // 40 miniature = 40 richieste di metadati su rete mobile. Non si pagano.
        expect(document.querySelector('video'), 'un <video> nella griglia scarica i metadati').toBeNull();
    });
});

describe('MediaGrid — i chip dei bambini taggati', () => {
    it('in sola lettura il chip si tronca invece di sfondare la colonna', () => {
        render(<MediaGrid items={[{ ...FOTO, tag_students: ['s1'] }]} students={ALUNNI} />);
        apriVisoreFoto();

        const chip = screen.getByText(/Cognomefinto — PRIMAVERA A/);
        expect(classi(chip)).toContain('truncate');
        expect(classi(chip), 'senza `max-w-full` il chip è larghissimo e la riga sborda').toContain('max-w-full');
    });

    it('in modifica il nome si tronca e la sua label ha min-w-0', () => {
        render(
            <MediaGrid
                items={[{ ...FOTO, tag_students: ['s1'] }]}
                students={ALUNNI}
                onUpdateTags={async () => {}}
            />,
        );
        apriVisoreFoto();
        fireEvent.click(screen.getByRole('button', { name: /Modifica Tag/ }));

        const nome = screen.getByText(/Cognomefinto — PRIMAVERA A/);
        expect(classi(nome)).toContain('truncate');
        const etichetta = nome.closest('label')!;
        expect(etichetta, 'il nome non è più dentro una <label>').toBeTruthy();
        // Senza `min-w-0` un figlio flex non scende sotto la larghezza del proprio
        // contenuto: `truncate` sul testo non ha effetto e il chip sfonda comunque.
        expect(classi(etichetta), 'la label non può restringersi: `truncate` dentro non serve a niente').toContain('min-w-0');
        expect(nome.getAttribute('title'), 'troncato senza `title`: il nome intero non si legge più').toBe(
            'Nomefinto Cognomefinto — PRIMAVERA A',
        );
    });

    it('l’elenco in modifica è a una colonna sul telefono e più alto di prima', () => {
        render(
            <MediaGrid
                items={[{ ...FOTO, tag_students: ['s1'] }]}
                students={ALUNNI}
                onUpdateTags={async () => {}}
            />,
        );
        apriVisoreFoto();
        fireEvent.click(screen.getByRole('button', { name: /Modifica Tag/ }));

        const elenco = screen.getByTestId('taggati-elenco');
        expect(classi(elenco), 'due colonne di «Nome Cognome — SEZIONE» in 358 px non ci stanno').toContain('grid-cols-1');
        expect(classi(elenco)).toContain('sm:grid-cols-2');
        expect(classi(elenco), 'max-h-32 mostra due righe e mezzo').toContain('max-h-40');
    });
});

describe('MediaGrid — il visore è una finestra modale, e il fuoco ci entra', () => {
    /*
     * ⚠️ IL PUNTO 10 AVEVA RESO LA CARD RAGGIUNGIBILE DA TASTIERA E POI LA LASCIAVA LÌ.
     *
     * Misurato dal critico il 2026-09-11: premendo Invio sulla card il visore si
     * apriva, il fuoco restava sulla card — che da quell'istante sta DIETRO un velo
     * opaco a tutto schermo — e il visore non era dichiarato `dialog`. Conseguenze
     * misurate: nessun annuncio per uno screen reader, e per arrivare a «Elimina
     * Media» (il comando da cui nasce tutto questo lavoro) bisognava tabulare
     * attraverso l'intera griglia, perché il visore è reso DOPO di lei nel DOM —
     * 30 tappe con 10 foto, 120 con 40. È WCAG 2.4.3 e 2.4.11 al posto di 2.1.1.
     *
     * L'inerzia dello sfondo e il ripristino del fuoco NON sono riscritti qui: sono
     * `rendiInerteFuoriDaConFocus` di `@/lib/accessibility/inerti`, lo stesso pezzo
     * che usano `Modal` e `PageLoader`. `aria-modal` su un `div` da solo non esclude
     * niente (Chromium lo onora solo per il top layer): è scritto per esteso in
     * testa a quel modulo, e per questo l'attributo senza l'inerzia sarebbe
     * decorazione.
     */
    it('è dichiarato `dialog` modale e porta il nome del media aperto', () => {
        render(<MediaGrid items={[FOTO]} showActions onDelete={async () => {}} />);
        apriVisoreFoto();

        const dialogo = screen.getByRole('dialog');
        expect(dialogo.getAttribute('aria-modal'), 'un dialogo non dichiarato modale non annuncia niente').toBe('true');
        expect(
            dialogo.getAttribute('aria-label'),
            'il dialogo non dice quale media si è aperto',
        ).toBe(NOME_CARD_FOTO);
        // Il dialogo è il contenitore NUDO: se fosse il velo, il sottoalbero
        // spariva da TalkBack (vedi il test sul velo fratello).
        expect(dialogo.contains(screen.getByTestId('visore-colonna'))).toBe(true);
    });

    it('il fuoco ENTRA nel visore all’apertura da tastiera, e non resta sulla card coperta', () => {
        render(<MediaGrid items={[FOTO]} showActions onDelete={async () => {}} />);
        const card = screen.getByRole('button', { name: NOME_CARD_FOTO });
        card.focus();
        expect(document.activeElement, 'la card non ha preso il fuoco: il test non misura niente').toBe(card);

        fireEvent.keyDown(card, { key: 'Enter' });

        const dialogo = screen.getByRole('dialog');
        expect(
            document.activeElement,
            'il fuoco è rimasto sulla card, che ora sta dietro un velo opaco a tutto schermo',
        ).not.toBe(card);
        expect(
            dialogo.contains(document.activeElement),
            'il fuoco è fuori dal dialogo: per arrivare a «Elimina Media» si tabula attraverso tutta la griglia',
        ).toBe(true);
    });

    it('il fuoco TORNA alla card quando il visore si chiude', () => {
        render(<MediaGrid items={[FOTO]} showActions onDelete={async () => {}} />);
        const card = screen.getByRole('button', { name: NOME_CARD_FOTO });
        card.focus();
        fireEvent.keyDown(card, { key: 'Enter' });
        expect(screen.getByTestId('visore-colonna')).toBeInTheDocument();
        /*
         * ⚠️ QUESTA RIGA NON È DECORATIVA — senza di lei il test è VERDE PER IL
         * MOTIVO SBAGLIATO, e l'ho misurato: in jsdom nessuno sposta il fuoco da
         * solo, quindi sul codice PRIMA della correzione il fuoco non se ne andava
         * mai dalla card e «è tornato alla card» risultava vero senza che nessun
         * ritorno fosse mai avvenuto. Un ritorno si può misurare solo se prima c'è
         * stata una partenza.
         */
        expect(
            document.activeElement,
            'il fuoco non è mai entrato nel visore: non c’è nessun ritorno da misurare',
        ).not.toBe(card);

        fireEvent.keyDown(window, { key: 'Escape' });

        expect(screen.queryByTestId('visore-colonna'), 'Escape non ha chiuso il visore').toBeNull();
        expect(
            document.activeElement,
            'chiuso il visore il fuoco è finito sul <body>: chi naviga da tastiera riparte dalla cima della pagina',
        ).toBe(card);
    });

    it('la griglia dietro il velo diventa inerte: il Tab non gira sui comandi coperti', () => {
        render(<MediaGrid items={[FOTO]} showActions onDelete={async () => {}} />);
        const griglia = screen.getByTestId('griglia-media');
        expect(griglia.hasAttribute('inert'), 'la griglia è inerte prima di aprire il visore').toBe(false);

        apriVisoreFoto();
        expect(
            griglia.hasAttribute('inert'),
            'la griglia resta nel giro del Tab sotto il velo: i suoi bottoni sono invisibili e attivabili con Invio',
        ).toBe(true);

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(
            griglia.hasAttribute('inert'),
            'l’inerzia non è stata togliata alla chiusura: la griglia resta irraggiungibile per sempre',
        ).toBe(false);
    });
});

describe('MediaGrid — la miniatura della griglia è decorativa', () => {
    /*
     * Dentro un comando che porta già il proprio nome, la miniatura è decorativa:
     * con l'`alt` descrittivo uno screen reader annunciava «Foto: Laboratorio dei
     * colori» e poi, dentro, «Laboratorio dei colori, immagine» — la stessa cosa due
     * volte (rilievo 5 del critico).
     *
     * ⚠️ PERCHÉ `aria-hidden` E NON `alt=""`, che sarebbe la forma canonica: quattro
     * file di test che NON sono di questo lavoro individuano la miniatura con
     * `getByAltText` (`MediaGrid-segnala`, `MediaGrid-link-scaduto`,
     * `scarica-media-grid`, `galleria-sede-pagina`). `alt=""` li farebbe diventare
     * rossi tutti e quattro; `aria-hidden="true"` ottiene lo stesso risultato
     * sull'albero di accessibilità lasciando l'attributo al suo posto. Chi passerà a
     * `alt=""` cambi anche quelle quattro righe.
     */
    it('la miniatura è fuori dall’albero di accessibilità, il media del visore NO', () => {
        render(<MediaGrid items={[FOTO]} />);
        const miniatura = screen.getByAltText('Laboratorio dei colori');
        expect(
            miniatura.getAttribute('aria-hidden'),
            'la miniatura ripete il nome del comando che la contiene',
        ).toBe('true');

        fireEvent.click(miniatura);
        const nelVisore = [...document.querySelectorAll('img')].find((i) => tettoAltezza(i) !== undefined)!;
        expect(nelVisore, 'nessuna <img> nel visore').toBeTruthy();
        expect(
            nelVisore.getAttribute('aria-hidden'),
            'il media APERTO non è decorativo: lì l’alt è l’unica descrizione che esiste',
        ).toBeNull();
        expect(nelVisore.getAttribute('alt')).toBe('Laboratorio dei colori');
    });
});

describe('MediaGrid — nessuna classe Tailwind composta a runtime', () => {
    /*
     * QUESTO CONTROLLO GUARDA IL SORGENTE, E DEVE.
     *
     * Il critico ha sostituito `2: 'grid-cols-2'` con ``2: `grid-cols-${2}` `` e i 21
     * test del file sono rimasti VERDI: nel `class` renderizzato le due forme sono lo
     * stesso byte, quindi NESSUNA asserzione sul DOM può distinguerle. Ma Tailwind 4
     * genera le utility leggendo il SORGENTE: una classe composta a runtime non
     * compare in nessun file, finisce nel `class` dell'elemento senza esistere nel
     * CSS, e la griglia collassa a una colonna **in silenzio e col gate verde**. È
     * lo stesso difetto già misurato in questo repo con `bg-kidville-success-soft0`.
     *
     * Il lock `utility-kidville-esistenti` non copre questo caso: la sua regex guarda
     * i soli token `-kidville-*`.
     */
    const SORGENTE = join(process.cwd(), 'src/components/features/gallery/MediaGrid.tsx');

    /**
     * Il sorgente SENZA commenti. Serve perché il file spiega il difetto citandolo
     * per esteso (`grid-cols-${colonne}` nel commento di `CLASSI_COLONNE`): un
     * controllo che leggesse anche i commenti sarebbe rosso proprio sul paragrafo
     * che documenta la regola.
     */
    function sorgenteSenzaCommenti(): string {
        return readFileSync(SORGENTE, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/\/\/[^\n]*/g, ' ');
    }

    /**
     * Le radici di utility Tailwind che questo componente usa. NON è `[a-z]+-\$\{`:
     * nel file ci sono due interpolazioni legittime che finirebbero nella rete —
     * `gallery-scarico-${risultato.esito}` e `${nome} ${cognome}` — e sono messaggi
     * di log e titoli, non classi.
     */
    const RADICI = [
        'grid-cols', 'col-span', 'row-span', 'gap', 'max-h', 'max-w', 'min-h', 'min-w',
        'aspect', 'bg', 'text', 'border', 'rounded', 'shadow', 'opacity', 'z',
        'top', 'bottom', 'left', 'right', 'inset', 'translate', 'scale',
    ];

    it('nessuna utility interpolata: sarebbe una classe che non esiste nel CSS', () => {
        const codice = sorgenteSenzaCommenti();
        const composte = RADICI.filter((radice) => new RegExp(`\\b${radice}-\\$\\{`).test(codice));
        expect(
            composte,
            'una classe Tailwind composta a runtime non viene generata: l’elemento la porta nel ' +
                '`class` e il CSS non ce l’ha. La mappa `CLASSI_COLONNE` esiste per questo.',
        ).toEqual([]);
    });

    it('le tre classi delle colonne sono scritte per esteso nel sorgente', () => {
        const codice = sorgenteSenzaCommenti();
        for (const classe of ['grid-cols-2', 'grid-cols-3', 'grid-cols-4']) {
            expect(codice, `${classe} non è un letterale nel sorgente: Tailwind non la genera`).toContain(
                `'${classe}'`,
            );
        }
    });
});

describe('MediaGrid — le colonne le dichiara il chiamante, compreso quello largo', () => {
    /*
     * ⚠️ IL DEFAULT 2 AVEVA FATTO REGREDIRE UNA VISTA DI PRODUZIONE.
     *
     * Prima del 2026-09-11 la griglia era `grid-cols-2 sm:grid-cols-3`: ogni viewport
     * da 640 px in su vedeva TRE colonne. Togliendo il `sm:` e lasciando il default a
     * 2, la vista di sede (`/admin/gallery` → `GalleriaSedeGiornate`, contenitore
     * ~1088 px e nessun `max-w` restrittivo) è passata da 3 colonne a 2, cioè a
     * miniature da ~530 px. Il default giusto resta 2 — è il caso stretto, quello del
     * genitore — ma chi ha spazio deve DICHIARARLO, e un test deve misurarlo dal lato
     * del chiamante: altrimenti il prossimo default silenzioso ripete la regressione.
     */
    const TESTI = {
        senzaData: 'Senza data',
        conteggio: (n: number) => `${n} foto`,
        taggatoSenzaNome: 'Bambino senza nome',
    };

    it('la vista di sede chiede QUATTRO colonne: il suo contenitore è largo ~1088 px', () => {
        render(<GalleriaSedeGiornate foto={[FOTO as FotoSede]} testi={TESTI} />);
        expect(
            classi(screen.getByTestId('griglia-media')),
            'la vista di sede è tornata a due colonne: miniature da ~530 px su un contenitore da 1088',
        ).toContain('grid-cols-4');
    });
});
