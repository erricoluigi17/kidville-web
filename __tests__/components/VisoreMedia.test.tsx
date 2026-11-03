import { describe, it, expect, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { VisoreMedia, type MediaVisore } from '@/components/features/media/VisoreMedia';
import { chiudiOverlayInCima } from '@/lib/mobile/overlay-indietro';
import itShared from '../../messages/it/shared.json';

/**
 * IL VISORE UNICO DEI MEDIA, provato da solo.
 *
 * Fino al 2026-11-03 il visore viveva dentro `MediaGrid` e lo provavano soltanto i test
 * di `MediaGrid`. Adesso è un componente a sé, usato anche dalla chat: qui si blocca ciò
 * che gli compete, a prescindere da chi lo monta — il portale, il livello, il tasto
 * Indietro di Android, le frecce, il fuoco. Ciò che resta di `MediaGrid` (guardia sulla
 * chiusura, tag, Elimina) lo provano ancora i suoi file.
 *
 * Nomi e URL sono di fantasia: in questo repo non entrano dati veri di bambini.
 */

const A: MediaVisore = { id: 'a', url: 'https://firmato.test/uploads/a.jpg', tipo: 'foto', alt: 'Prima foto' };
const B: MediaVisore = { id: 'b', url: 'https://firmato.test/uploads/b.jpg', tipo: 'foto', alt: 'Seconda foto' };
const C: MediaVisore = { id: 'c', url: 'https://firmato.test/uploads/c.mp4', tipo: 'video', alt: 'Terzo video' };
const TRE = [A, B, C];

const etichetta = (m: MediaVisore) => `Media: ${m.alt}`;

interface ArneseProps {
    iniziale?: string | null;
    elementi?: MediaVisore[];
    tastiBloccati?: boolean;
    onCambia?: (id: string) => void;
    onChiudi?: () => void;
    children?: React.ReactNode;
    sovrapposti?: React.ReactNode;
}

/**
 * Chi usa il visore ne tiene lo stato (`apertoId`): senza uno stato vero le frecce non
 * cambierebbero niente e i test sul fuoco misurerebbero un finto.
 */
function Arnese({
    iniziale = 'a',
    elementi = TRE,
    tastiBloccati,
    onCambia = () => {},
    onChiudi = () => {},
    children,
    sovrapposti,
}: ArneseProps) {
    const [id, setId] = useState<string | null>(iniziale);
    return (
        <VisoreMedia
            elementi={elementi}
            apertoId={id}
            onCambia={(nuovo) => {
                onCambia(nuovo);
                setId(nuovo);
            }}
            onChiudi={() => {
                onChiudi();
                setId(null);
            }}
            etichetta={etichetta}
            tastiBloccati={tastiBloccati}
            sovrapposti={sovrapposti}
        >
            {children}
        </VisoreMedia>
    );
}

afterEach(() => cleanup());

/**
 * Il tasto Indietro di Android, come lo vive il visore: il gestore nativo lo chiama fuori
 * da React, e la chiusura che ne segue aggiorna uno stato. In un test lo si avvolge in
 * `act`, altrimenti lo smontaggio non è ancora avvenuto quando si rilegge il registro.
 */
function premiIndietro(): boolean {
    let consumato = false;
    act(() => {
        consumato = chiudiOverlayInCima();
    });
    return consumato;
}

describe('VisoreMedia — aperto e chiuso', () => {
    it('con apertoId nullo non rende niente', () => {
        render(<VisoreMedia elementi={TRE} apertoId={null} onCambia={() => {}} onChiudi={() => {}} etichetta={etichetta} />);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.querySelector('[data-testid="visore-colonna"]')).toBeNull();
    });

    it('con un id che non è fra gli elementi non rende niente e non si iscrive al tasto Indietro', () => {
        // Chi lo usa deve chiuderlo: se l'id non c'è non esiste nemmeno cosa mostrare, e un
        // overlay registrato senza interfaccia inghiottirebbe un Indietro che dovrebbe navigare.
        render(<VisoreMedia elementi={TRE} apertoId="sparito" onCambia={() => {}} onChiudi={() => {}} etichetta={etichetta} />);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(premiIndietro(), 'un visore invisibile ha preso il tasto Indietro').toBe(false);
    });

    it('è un dialogo modale e porta il nome che gli dà chi lo usa', () => {
        render(<Arnese />);
        const dialogo = screen.getByRole('dialog');
        expect(dialogo.getAttribute('aria-modal')).toBe('true');
        expect(dialogo.getAttribute('aria-label')).toBe('Media: Prima foto');
        expect(dialogo.getAttribute('tabindex')).toBe('-1');
    });

    it('la foto è un <img> con l’alt e il video un <video> con i comandi', () => {
        render(<Arnese />);
        const img = screen.getByAltText('Prima foto') as HTMLImageElement;
        expect(img.getAttribute('src')).toBe(A.url);
        expect(img.className).toContain('object-contain');
        expect(img.className).toContain('max-h-[70svh]');
        cleanup();

        render(<Arnese iniziale="c" />);
        const video = document.querySelector('video') as HTMLVideoElement;
        expect(video, 'nessun <video> per un media di tipo video').toBeTruthy();
        expect(video.getAttribute('src')).toBe(C.url);
        expect(video.hasAttribute('controls')).toBe(true);
        expect(video.getAttribute('preload')).toBe('metadata');
        expect(video.className).toContain('max-h-[70svh]');
        expect(video.className).toContain('object-contain');
    });

    it('senza indirizzo firmato dice «anteprima non disponibile» e non produce un <img> vuoto', () => {
        const senzaUrl: MediaVisore = { ...A, url: null };
        render(<Arnese elementi={[senzaUrl, B]} />);
        expect(screen.getByText(itShared.galleryAnteprimaNonDisponibile)).toBeTruthy();
        for (const img of document.querySelectorAll('img')) expect(img.getAttribute('src')).toBeTruthy();
        expect(document.querySelector('video')).toBeNull();
    });

    it('i figli stanno nella colonna, sotto il media', () => {
        render(<Arnese><p data-testid="didascalia">Didascalia di prova</p></Arnese>);
        const colonna = screen.getByTestId('visore-colonna');
        const figlio = screen.getByTestId('didascalia');
        expect(colonna.contains(figlio)).toBe(true);
        const img = screen.getByAltText('Prima foto');
        // Il figlio viene DOPO il media nell'ordine del documento.
        expect(img.compareDocumentPosition(figlio) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});

describe('VisoreMedia — portale e livello', () => {
    /*
     * La conversazione mobile della chat è un `fixed inset-0 z-[60]`, cioè un contesto
     * d'impilamento: un visore reso lì dentro resterebbe chiuso a 60, qualunque `z-` abbia
     * la sua radice, e il chrome fisso che la sovrasta lo coprirebbe. Il portale su
     * `document.body` lo porta fuori da ogni contesto, e il `z-[115]` torna a contare.
     */
    it('il dialog vive in document.body ed è a z-[115]', () => {
        render(<Arnese />);
        const dialogo = screen.getByRole('dialog');
        expect(dialogo.parentElement, 'il dialogo non è figlio diretto di document.body').toBe(document.body);
        expect(dialogo.className.split(/\s+/)).toContain('z-[115]');
    });

    it('anche montato dentro un contenitore fixed z-[60], il dialog sta fuori da quel contenitore', () => {
        render(
            <div data-testid="conversazione" className="fixed inset-0 z-[60]">
                <Arnese />
            </div>,
        );
        const conversazione = screen.getByTestId('conversazione');
        expect(
            conversazione.contains(screen.getByRole('dialog')),
            'il dialogo è rimasto dentro il contesto d’impilamento della conversazione',
        ).toBe(false);
    });

    it('alla chiusura il portale sparisce dal body', () => {
        render(<Arnese />);
        fireEvent.click(screen.getByText('✕'));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.body.querySelector('[data-testid="visore-colonna"]')).toBeNull();
    });
});

describe('VisoreMedia — il tasto Indietro di Android', () => {
    it('Indietro di Android chiude il visore', () => {
        const onChiudi = vi.fn();
        render(<Arnese onChiudi={onChiudi} />);
        expect(onChiudi).not.toHaveBeenCalled();

        // È ciò che fa il gestore di `backButton` della shell nativa.
        expect(premiIndietro(), 'il visore non si è iscritto al registro degli overlay').toBe(true);
        expect(onChiudi).toHaveBeenCalledTimes(1);
    });

    it('chiuso il visore, il tasto Indietro torna a navigare (l’overlay esce dal registro)', () => {
        render(<Arnese />);
        fireEvent.click(screen.getByText('✕'));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(premiIndietro(), 'un visore chiuso tiene ancora il tasto Indietro').toBe(false);
    });

    it('cambiare foto non lo iscrive una seconda volta (un Indietro chiude, non due)', () => {
        const onChiudi = vi.fn();
        render(<Arnese onChiudi={onChiudi} />);
        fireEvent.click(screen.getByTitle(itShared.mediaSuccessiva));
        expect(premiIndietro()).toBe(true);
        expect(onChiudi).toHaveBeenCalledTimes(1);
        expect(premiIndietro(), 'dopo la chiusura il registro dev’essere vuoto').toBe(false);
        expect(onChiudi, 'il secondo Indietro ha richiuso un visore già chiuso').toHaveBeenCalledTimes(1);
    });
});

describe('VisoreMedia — frecce e tasti', () => {
    it('niente ‹ sul primo, niente › sull’ultimo', () => {
        render(<Arnese iniziale="a" />);
        expect(screen.queryByTitle(itShared.mediaPrecedente)).toBeNull();
        expect(screen.getByTitle(itShared.mediaSuccessiva)).toBeTruthy();
        cleanup();

        render(<Arnese iniziale="b" />);
        expect(screen.getByTitle(itShared.mediaPrecedente)).toBeTruthy();
        expect(screen.getByTitle(itShared.mediaSuccessiva)).toBeTruthy();
        cleanup();

        render(<Arnese iniziale="c" />);
        expect(screen.getByTitle(itShared.mediaPrecedente)).toBeTruthy();
        expect(screen.queryByTitle(itShared.mediaSuccessiva)).toBeNull();
    });

    it('con un solo elemento non compare nessuna freccia', () => {
        render(<Arnese elementi={[A]} />);
        expect(screen.queryByTitle(itShared.mediaPrecedente)).toBeNull();
        expect(screen.queryByTitle(itShared.mediaSuccessiva)).toBeNull();
    });

    it('ArrowRight passa al successivo, ArrowLeft al precedente', () => {
        const onCambia = vi.fn();
        render(<Arnese iniziale="a" onCambia={onCambia} />);

        fireEvent.keyDown(window, { key: 'ArrowRight' });
        expect(onCambia).toHaveBeenLastCalledWith('b');
        expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Media: Seconda foto');

        fireEvent.keyDown(window, { key: 'ArrowLeft' });
        expect(onCambia).toHaveBeenLastCalledWith('a');
        expect(onCambia).toHaveBeenCalledTimes(2);
    });

    it('oltre i bordi le frecce da tastiera non fanno niente', () => {
        const onCambia = vi.fn();
        render(<Arnese iniziale="a" onCambia={onCambia} />);
        fireEvent.keyDown(window, { key: 'ArrowLeft' });
        expect(onCambia).not.toHaveBeenCalled();
        cleanup();

        render(<Arnese iniziale="c" onCambia={onCambia} />);
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        expect(onCambia).not.toHaveBeenCalled();
    });

    it('i pulsanti ‹ › chiamano onCambia con l’id del vicino', () => {
        const onCambia = vi.fn();
        render(<Arnese iniziale="b" onCambia={onCambia} />);
        fireEvent.click(screen.getByTitle(itShared.mediaSuccessiva));
        expect(onCambia).toHaveBeenLastCalledWith('c');
        fireEvent.click(screen.getByTitle(itShared.mediaPrecedente));
        expect(onCambia).toHaveBeenLastCalledWith('b');
    });

    it('un clic sulla freccia non chiude il visore', () => {
        const onChiudi = vi.fn();
        render(<Arnese iniziale="b" onChiudi={onChiudi} />);
        fireEvent.click(screen.getByTitle(itShared.mediaSuccessiva));
        expect(onChiudi).not.toHaveBeenCalled();
    });

    it('Escape chiude', () => {
        const onChiudi = vi.fn();
        render(<Arnese onChiudi={onChiudi} />);
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onChiudi).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('con tastiBloccati né le frecce né Escape fanno niente', () => {
        const onCambia = vi.fn();
        const onChiudi = vi.fn();
        render(<Arnese iniziale="b" tastiBloccati onCambia={onCambia} onChiudi={onChiudi} />);

        fireEvent.keyDown(window, { key: 'ArrowRight' });
        fireEvent.keyDown(window, { key: 'ArrowLeft' });
        fireEvent.keyDown(window, { key: 'Escape' });

        expect(onCambia, 'le frecce hanno cambiato il media dietro al dialogo figlio').not.toHaveBeenCalled();
        expect(onChiudi, 'Escape ha chiuso il visore invece del dialogo figlio').not.toHaveBeenCalled();
        expect(screen.getByRole('dialog')).toBeTruthy();
    });

    it('sbloccati di nuovo, i tasti tornano a funzionare (il blocco non è per sempre)', () => {
        const onCambia = vi.fn();
        const { rerender } = render(
            <VisoreMedia
                elementi={TRE}
                apertoId="b"
                onCambia={onCambia}
                onChiudi={() => {}}
                etichetta={etichetta}
                tastiBloccati
            />,
        );
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        expect(onCambia).not.toHaveBeenCalled();

        rerender(
            <VisoreMedia
                elementi={TRE}
                apertoId="b"
                onCambia={onCambia}
                onChiudi={() => {}}
                etichetta={etichetta}
                tastiBloccati={false}
            />,
        );
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        expect(onCambia).toHaveBeenCalledWith('c');
    });

    it('chiuso, il visore non ascolta più la tastiera', () => {
        const onCambia = vi.fn();
        const onChiudi = vi.fn();
        render(<Arnese iniziale={null} onCambia={onCambia} onChiudi={onChiudi} />);
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onCambia).not.toHaveBeenCalled();
        expect(onChiudi).not.toHaveBeenCalled();
    });
});

describe('VisoreMedia — chiusura col tocco', () => {
    it('tocco sullo scroller chiude, tocco nella colonna no', () => {
        const onChiudi = vi.fn();
        render(<Arnese onChiudi={onChiudi} />);

        fireEvent.click(screen.getByTestId('visore-colonna'));
        expect(onChiudi, 'un tocco nella colonna ha chiuso il visore').not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId('visore-scorrimento'));
        expect(onChiudi).toHaveBeenCalledTimes(1);
    });

    it('un tocco su un figlio nella colonna (per esempio un comando) non risale allo scroller', () => {
        const onChiudi = vi.fn();
        render(<Arnese onChiudi={onChiudi}><button type="button">Comando</button></Arnese>);
        fireEvent.click(screen.getByText('Comando'));
        expect(onChiudi).not.toHaveBeenCalled();
    });

    it('la ✕ chiude', () => {
        const onChiudi = vi.fn();
        render(<Arnese onChiudi={onChiudi} />);
        fireEvent.click(screen.getByText('✕'));
        expect(onChiudi).toHaveBeenCalledTimes(1);
    });

    it('il velo è un fratello aria-hidden del contenuto, non un suo antenato', () => {
        // Sulla WebView Chromium di Android un antenato con `backdrop-filter` cancella il
        // sottoalbero dall'albero di accessibilità (vedi `ui/Modal`).
        render(<Arnese />);
        const velo = screen.getByTestId('visore-velo');
        expect(velo.getAttribute('aria-hidden')).toBe('true');
        expect(velo.contains(screen.getByTestId('visore-colonna'))).toBe(false);
        expect(velo.parentElement).toBe(screen.getByRole('dialog'));
    });

    it('i sovrapposti sono fratelli dello scroller: un tocco lì dentro non chiude il visore', () => {
        // È il posto del dialogo di conferma: reso DENTRO lo scroller, ogni clic sul suo velo
        // risalirebbe fin lì e chiuderebbe il visore portandosi via la conferma.
        const onChiudi = vi.fn();
        render(<Arnese onChiudi={onChiudi} sovrapposti={<div data-testid="conferma">Conferma</div>} />);
        const conferma = screen.getByTestId('conferma');
        expect(screen.getByRole('dialog').contains(conferma)).toBe(true);
        expect(screen.getByTestId('visore-scorrimento').contains(conferma)).toBe(false);
        fireEvent.click(conferma);
        expect(onChiudi).not.toHaveBeenCalled();
    });
});

describe('VisoreMedia — il fuoco e l’inerzia dello sfondo', () => {
    it('il fuoco va al dialog all’apertura e torna a chi l’aveva alla chiusura', () => {
        function Pagina() {
            const [aperto, setAperto] = useState<string | null>(null);
            return (
                <>
                    <button type="button" data-testid="apri" onClick={() => setAperto('a')}>Apri</button>
                    <VisoreMedia
                        elementi={TRE}
                        apertoId={aperto}
                        onCambia={setAperto}
                        onChiudi={() => setAperto(null)}
                        etichetta={etichetta}
                    />
                </>
            );
        }
        render(<Pagina />);
        const apri = screen.getByTestId('apri');
        apri.focus();
        expect(document.activeElement, 'il pulsante non ha preso il fuoco: il test non misura niente').toBe(apri);

        fireEvent.click(apri);
        const dialogo = screen.getByRole('dialog');
        expect(document.activeElement, 'il fuoco non è entrato nel dialogo').toBe(dialogo);

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement, 'chiuso il visore il fuoco non è tornato a chi l’aveva').toBe(apri);
    });

    it('cambiare foto non sposta il fuoco dalla freccia premuta', () => {
        render(<Arnese iniziale="a" />);
        const dialogo = screen.getByRole('dialog');
        const avanti = screen.getByTitle(itShared.mediaSuccessiva);
        avanti.focus();
        expect(document.activeElement, 'la freccia non ha preso il fuoco: il test non misura niente').toBe(avanti);

        // Un clic vero sposta il fuoco sul pulsante e poi cambia il media.
        fireEvent.click(avanti);
        expect(screen.getByRole('dialog').getAttribute('aria-label'), 'il media non è cambiato').toBe('Media: Seconda foto');
        expect(
            document.activeElement,
            'l’effetto di fuoco dipende dal media aperto invece che da «è aperto»: ogni freccia strappa il fuoco al pulsante',
        ).toBe(screen.getByTitle(itShared.mediaSuccessiva));
        expect(document.activeElement).not.toBe(dialogo);

        // Ancora una volta, per scrupolo: tre foto sono due cambi.
        fireEvent.click(screen.getByTitle(itShared.mediaSuccessiva));
        expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Media: Terzo video');
        expect(document.activeElement).not.toBe(screen.getByRole('dialog'));
    });

    it('lo sfondo diventa inerte, il visore no, e alla chiusura tutto torna come prima', () => {
        render(
            <div data-testid="pagina">
                <button type="button">Sotto il velo</button>
                <Arnese />
            </div>,
        );
        const pagina = screen.getByTestId('pagina');
        const dialogo = screen.getByRole('dialog');

        // Con il portale su body, a diventare inerte è l’antenato della pagina (la radice di
        // React), non il singolo bottone: `inert` si eredita lungo il sottoalbero.
        expect(pagina.closest('[inert]'), 'la pagina dietro al velo non è inerte').not.toBeNull();
        expect(dialogo.closest('[inert]'), 'il visore stesso è inerte: non si potrebbe usare').toBeNull();

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(pagina.closest('[inert]'), 'l’inerzia non è stata tolta alla chiusura').toBeNull();
    });
});
