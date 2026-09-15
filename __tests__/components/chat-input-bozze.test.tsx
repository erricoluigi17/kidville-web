/**
 * LE BOZZE DI `ChatInput`, UNA PER CONVERSAZIONE (parte C, 2026-09-15).
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 *
 * Dal 2026-09-14 le pagine montano il campo con `key={thread.id}`: ciò che si scrive per una famiglia
 * non resta nel campo, pronto a partire, quando si apre la conversazione con un'altra. È la correzione
 * di sicurezza, e ha un costo: cambiando conversazione il testo si perdeva. Con il tocco sulla notifica
 * che apre la conversazione da solo (decisione del titolare), quel costo si vede di più — un docente che
 * sta scrivendo a una famiglia e tocca la notifica di un'altra perdeva quello che aveva scritto.
 *
 * La bozza vive in memoria (`bozze-chat.ts`), una per conversazione: torna quando si torna, non parte
 * mai verso un'altra, e muore con la pagina (il logout fa una navigazione dura). Nessuno storage.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('next-intl', () => {
    const t = (k: string) => k;
    return {
        useTranslations: () => Object.assign(t, { rich: t, markup: t, raw: t, has: () => true }),
        useLocale: () => 'it',
    };
});
vi.mock('@/components/features/native/ScattaFotoButton', () => ({ ScattaFotoButton: () => null }));

import { ChatInput } from '@/components/features/chat/ChatInput';

/** Chiavi uniche per test: la memoria è di modulo, e un test non deve trovare le bozze di un altro. */
let n = 0;
let T1 = '';
let T2 = '';

const campo = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const scrivi = (testo: string) => fireEvent.change(campo(), { target: { value: testo } });
const invia = () => fireEvent.click(screen.getByLabelText('chatInputAriaInvia'));
const allega = async () => {
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [new File(['x'], 'allegato.png', { type: 'image/png' })] },
    });
    await screen.findByText('allegato.png');
};

/** Un `onSend` che risponde a comando: la POST vera ci mette secondi (2,6 s misurati in CI). */
function invioTrattenuto() {
    let sblocca: (esito: boolean) => void = () => {};
    const onSend = vi.fn(() => new Promise<boolean>((r) => {
        sblocca = r;
    }));
    const concludi = async (esito: boolean) => {
        await act(async () => {
            sblocca(esito);
        });
    };
    return { onSend, concludi };
}

beforeEach(() => {
    n++;
    T1 = `utente-${n}:thread-1`;
    T2 = `utente-${n}:thread-2`;
    vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ path: 'u/allegato.png', name: 'allegato.png', attachment_type: 'image' }) }),
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('ChatInput — la bozza di una conversazione', () => {
    it('scritto per T1, aperta T2: il campo è vuoto; tornati su T1, il testo è lì', () => {
        const onSend = vi.fn().mockResolvedValue(true);
        const { unmount } = render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        scrivi('Per la famiglia della conversazione 1');
        unmount();

        const secondo = render(<ChatInput key={T2} chiaveBozza={T2} onSend={onSend} />);
        expect(campo().value, 'il testo scritto per una famiglia è comparso nella conversazione con un’altra').toBe('');
        secondo.unmount();

        render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        expect(campo().value, 'tornati sulla conversazione, la bozza si è persa').toBe('Per la famiglia della conversazione 1');
    });

    it('anche l’allegato già caricato resta nella bozza della sua conversazione', async () => {
        const onSend = vi.fn().mockResolvedValue(true);
        const { unmount } = render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
            target: { files: [new File(['x'], 'allegato.png', { type: 'image/png' })] },
        });
        await screen.findByText('allegato.png');
        unmount();

        const secondo = render(<ChatInput key={T2} chiaveBozza={T2} onSend={onSend} />);
        expect(screen.queryByText('allegato.png')).toBeNull();
        secondo.unmount();

        render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        expect(screen.getByText('allegato.png')).toBeInTheDocument();
        invia();
        await waitFor(() => expect(onSend).toHaveBeenCalledWith('📎 Allegato', 'u/allegato.png', 'image'));
    });

    it('un invio riuscito cancella la bozza: tornando non si ritrova il messaggio già mandato', async () => {
        const onSend = vi.fn().mockResolvedValue(true);
        const { unmount } = render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        scrivi('Già mandato');
        invia();
        await waitFor(() => expect(campo().value).toBe(''));
        unmount();

        render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        expect(campo().value).toBe('');
    });

    it('un invio rifiutato la tiene: il testo non è partito, e non si perde', async () => {
        const onSend = vi.fn().mockResolvedValue(false);
        const { unmount } = render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        scrivi('Rifiutato dal server');
        invia();
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
        unmount();

        render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        expect(campo().value).toBe('Rifiutato dal server');
    });

    it('cancellato a mano, il campo vuoto non lascia bozze', () => {
        const onSend = vi.fn();
        const { unmount } = render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        scrivi('ripensamento');
        scrivi('');
        unmount();

        render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        expect(campo().value).toBe('');
    });

    it('se la chiave cambia SENZA rimontare, il testo di T1 non diventa la bozza di T2', () => {
        const onSend = vi.fn();
        const { rerender, unmount } = render(<ChatInput chiaveBozza={T1} onSend={onSend} />);
        scrivi('Per la conversazione 1');
        rerender(<ChatInput chiaveBozza={T2} onSend={onSend} />);
        scrivi('Per la conversazione 1, ancora');
        unmount();

        render(<ChatInput key={T2} chiaveBozza={T2} onSend={onSend} />);
        expect(campo().value, 'il testo scritto con la chiave di T1 è finito nella bozza di T2').toBe('');
    });

    it('senza chiave non si ricorda niente (il comportamento di prima)', () => {
        const onSend = vi.fn();
        const { unmount } = render(<ChatInput onSend={onSend} />);
        scrivi('senza chiave');
        unmount();

        render(<ChatInput onSend={onSend} />);
        expect(campo().value).toBe('');
    });
});

/**
 * ─── L'ESITO DELL'INVIO È DELLA CONVERSAZIONE, NON DEL CAMPO (2026-09-15) ────
 *
 * Il campo che manda un messaggio può non esserci più quando la POST risponde: si preme Invia e subito
 * dopo «Indietro», o si apre un'altra conversazione, o si tocca una notifica. La POST va a buon fine e il
 * messaggio arriva alla famiglia — ma lo svuotamento avveniva nello stato del campo smontato, cioè da
 * nessuna parte, e nella bozza restava il testo scritto durante la digitazione. Riaperta la conversazione,
 * il messaggio già consegnato era di nuovo nel campo: un Invio distratto, e nel database c'è un doppione
 * vero. È il sintomo che questo branch esiste per togliere.
 *
 * I casi qui sotto sono gli ordini in cui la cosa succede davvero: la POST finisce a campo smontato, o a
 * campo già rimontato, o con due campi della stessa conversazione montati insieme (le pagine ne montano
 * uno per il desktop e uno a schermo intero per il telefono).
 */
describe('ChatInput — la bozza quando il campo si smonta con l’invio in volo', () => {
    it('la POST finisce a campo smontato: tornando sulla conversazione, il messaggio consegnato non è nel campo', async () => {
        const { onSend, concludi } = invioTrattenuto();
        const { unmount } = render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        scrivi('Già consegnato');
        invia();
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
        unmount();
        await concludi(true);

        render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        expect(campo().value, 'il messaggio già consegnato è tornato nel campo: un Invio lo manda due volte').toBe('');
    });

    it('lo stesso per l’allegato: consegnato a campo smontato, il chip non torna', async () => {
        const { onSend, concludi } = invioTrattenuto();
        const { unmount } = render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        await allega();
        invia();
        await waitFor(() => expect(onSend).toHaveBeenCalledWith('📎 Allegato', 'u/allegato.png', 'image'));
        unmount();
        await concludi(true);

        render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        expect(screen.queryByText('allegato.png'), 'l’allegato già consegnato è tornato agganciato al campo').toBeNull();
    });

    it('rifiutato a campo smontato: la bozza resta, perché il messaggio non è partito', async () => {
        const { onSend, concludi } = invioTrattenuto();
        const { unmount } = render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        scrivi('Non partito');
        invia();
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
        unmount();
        await concludi(false);

        render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        expect(campo().value).toBe('Non partito');
    });

    it('scritto altro mentre la POST era in volo, poi smontato: resta solo ciò che non è partito', async () => {
        const { onSend, concludi } = invioTrattenuto();
        const { unmount } = render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        scrivi('Primo');
        invia();
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
        await allega();
        scrivi('Secondo, scritto mentre partiva il primo');
        unmount();
        await concludi(true);

        render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        expect(campo().value).toBe('Secondo, scritto mentre partiva il primo');
        expect(screen.getByText('allegato.png'), 'l’allegato caricato durante l’invio non era partito, e si è perso').toBeInTheDocument();
    });

    it('tornati sulla conversazione PRIMA che la POST finisca: consegnato il messaggio, il campo si svuota', async () => {
        const { onSend, concludi } = invioTrattenuto();
        const primo = render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        scrivi('Già consegnato');
        invia();
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
        primo.unmount();

        render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        expect(campo().value, 'mentre l’invio è in volo il testo resta, come nel campo che l’ha mandato').toBe('Già consegnato');
        await concludi(true);
        expect(campo().value, 'consegnato, il messaggio è rimasto nel campo rimontato: un Invio lo manda due volte').toBe('');
    });

    it('due campi della stessa conversazione montati insieme, come nelle pagine: l’invio riuscito dall’uno svuota anche l’altro', async () => {
        const { onSend, concludi } = invioTrattenuto();
        const prima = render(<ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />);
        scrivi('Già consegnato');
        prima.unmount();

        render(
            <>
                <div>
                    <ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />
                </div>
                <div>
                    <ChatInput key={T1} chiaveBozza={T1} onSend={onSend} />
                </div>
            </>,
        );
        const [desktop, telefono] = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
        expect(desktop.value).toBe('Già consegnato');
        fireEvent.click(screen.getAllByLabelText('chatInputAriaInvia')[1]);
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
        await concludi(true);

        expect(telefono.value).toBe('');
        expect(desktop.value, 'l’altro campo della stessa conversazione tiene il messaggio consegnato').toBe('');
    });
});
