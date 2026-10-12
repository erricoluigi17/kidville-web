import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * La zona «Elimina voce» della finestra Modifica (2026-10-12). Il verdetto lo dà il server
 * (`GET …/eliminabile`); la zona non esiste per chi non è admin o segreteria, e non chiama
 * nemmeno il server. Conferma in due passi. Ogni fallimento si dice a schermo E si logga.
 * Dati sintetici.
 */

const h = vi.hoisted(() => ({ ruolo: 'segreteria', logClient: vi.fn() }));
vi.mock('@/lib/context/admin-identity', async (orig) => ({
    ...(await orig<object>()),
    useRuoloCockpit: () => h.ruolo,
}));
vi.mock('@/lib/logging/client', async (orig) => ({
    ...(await orig<object>()),
    logClient: (...a: unknown[]) => h.logClient(...a),
}));

import { EliminaVoceZona } from '@/components/features/admin/pagamenti/EliminaVoceZona';

const pagamento = { id: 'p-0001', descrizione: 'Gita allo zoo', importo: 30 };
let verdetto: { status: number; body: unknown } | 'rete';
let cancella: { status: number; body: unknown } | 'rete';
let fetchFinta: ReturnType<typeof vi.fn>;

const chiamate = (metodo: string) =>
    fetchFinta.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === metodo);
const rendi = (onEliminata = vi.fn()) => {
    render(<EliminaVoceZona pagamento={pagamento} userId="u1" onEliminata={onEliminata} />);
    return onEliminata;
};

beforeEach(() => {
    vi.clearAllMocks();
    h.ruolo = 'segreteria';
    verdetto = { status: 200, body: { success: true, eliminabile: true, rate: 0, ticket: 0 } };
    cancella = { status: 200, body: { success: true } };
    fetchFinta = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const r = init?.method === 'DELETE' ? cancella : verdetto;
        if (r === 'rete') throw new TypeError('Failed to fetch');
        return { ok: r.status < 400, status: r.status, json: async () => r.body };
    });
    vi.stubGlobal('fetch', fetchFinta);
});
afterEach(() => vi.unstubAllGlobals());

describe('EliminaVoceZona', () => {
    it('coordinatrice: niente zona e nessuna chiamata', () => {
        h.ruolo = 'coordinator';
        const { container } = render(<EliminaVoceZona pagamento={pagamento} userId="u1" onEliminata={vi.fn()} />);
        expect(container).toBeEmptyDOMElement();
        expect(fetchFinta).not.toHaveBeenCalled();
    });

    it('il verdetto si chiede alla rotta giusta', async () => {
        rendi();
        await screen.findByRole('button', { name: 'Elimina voce' });
        expect(String(chiamate('GET')[0][0])).toContain('/api/pagamenti/p-0001/eliminabile');
    });

    for (const ruolo of ['admin', 'segreteria']) {
        it(`${ruolo}, eliminabile: due passi, poi DELETE e onEliminata`, async () => {
            h.ruolo = ruolo;
            const onEliminata = rendi();
            fireEvent.click(await screen.findByRole('button', { name: 'Elimina voce' }));
            expect(screen.getByText(/Eliminare «Gita allo zoo»/)).toBeInTheDocument();
            expect(chiamate('DELETE')).toHaveLength(0);
            fireEvent.click(screen.getByRole('button', { name: 'Sì, elimina' }));
            await waitFor(() => expect(onEliminata).toHaveBeenCalledTimes(1));
            expect(String(chiamate('DELETE')[0][0])).toContain('/api/pagamenti/p-0001?');
        });
    }

    it('Annulla al secondo passo: torna indietro, nessuna DELETE', async () => {
        rendi();
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina voce' }));
        fireEvent.click(screen.getByRole('button', { name: 'Annulla' }));
        expect(await screen.findByRole('button', { name: 'Elimina voce' })).toBeInTheDocument();
        expect(chiamate('DELETE')).toHaveLength(0);
    });

    it('rate e ticket: la domanda li dice', async () => {
        verdetto = { status: 200, body: { success: true, eliminabile: true, rate: 3, ticket: 10 } };
        rendi();
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina voce' }));
        expect(screen.getByText('Si eliminano anche le sue 3 rate.')).toBeInTheDocument();
        expect(screen.getByText('Si tolgono anche i 10 ticket mensa di questa ricarica.')).toBeInTheDocument();
    });

    it('voce semplice: la domanda NON parla di rate né di ticket', async () => {
        rendi();
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina voce' }));
        expect(screen.getByText(/Eliminare «Gita allo zoo»/)).toBeInTheDocument();
        expect(screen.queryByText(/rate\./)).toBeNull();
        expect(screen.queryByText(/ticket mensa/)).toBeNull();
    });

    it('non eliminabile: il motivo dal catalogo, nessun pulsante', async () => {
        verdetto = { status: 200, body: { success: true, eliminabile: false, codice: 'VOCE_CON_INCASSI', error: 'x' } };
        rendi();
        expect(await screen.findByText(/storna gli incassi e correggi la voce/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Elimina voce' })).toBeNull();
    });

    for (const caso of ['500', 'rete'] as const) {
        it(`verdetto non letto (${caso}): «non riesco a controllare», nessun pulsante, e si logga`, async () => {
            verdetto = caso === 'rete' ? 'rete' : { status: 500, body: { error: 'guasto', codice: 'LETTURA_FALLITA' } };
            rendi();
            expect(await screen.findByText('Non riesco a controllare la voce: riapri la finestra.')).toBeInTheDocument();
            expect(screen.queryByRole('button', { name: 'Elimina voce' })).toBeNull();
            expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error' }));
        });
    }

    it('🔴 DELETE 409: messaggio in role=alert, si torna al primo passo, onEliminata NON chiamata', async () => {
        cancella = { status: 409, body: { error: 'x', codice: 'VOCE_CON_CONTABILITA' } };
        const onEliminata = rendi();
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina voce' }));
        fireEvent.click(screen.getByRole('button', { name: 'Sì, elimina' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(/incassata o fatturata nel frattempo/);
        expect(screen.getByRole('button', { name: 'Elimina voce' })).toBeInTheDocument();
        expect(onEliminata).not.toHaveBeenCalled();
    });

    it('DELETE senza rete: «connessione non riuscita», e si logga', async () => {
        cancella = 'rete';
        const onEliminata = rendi();
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina voce' }));
        fireEvent.click(screen.getByRole('button', { name: 'Sì, elimina' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Connessione non riuscita: la voce non è stata eliminata.');
        expect(onEliminata).not.toHaveBeenCalled();
        expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error' }));
    });
});
