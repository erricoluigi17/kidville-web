import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SollecitiPanel } from '@/components/features/admin/pagamenti/SollecitiPanel';

/**
 * Dopo l'invio, il pannello dice ANCHE che cosa non è partito, e perché (revisione del lotto 4).
 *
 * Fino a qui mostrava soltanto «N solleciti inviati.» con la spunta verde: con zero partiti la
 * segreteria leggeva «0 solleciti inviati.» con la spunta, e i motivi — nessuna email partita,
 * esito incerto presso il provider, nessun indirizzo — restavano nella risposta della route senza
 * arrivare a nessuno. La route li porta già (`motivo` per ogni voce non partita): qui si prova
 * che arrivano a schermo, sotto il conteggio, con la voce a cui si riferiscono.
 *
 * Nomi convenzionali, nessun dato reale.
 */

const SEDE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INCERTO = 'esito incerto presso il provider: nessun nuovo invio prima della prossima cadenza';
const NESSUN_INDIRIZZO = 'nessun destinatario con un indirizzo email';

const righe = [
    { id: 'p1', alunno_id: 'a1', scuola_id: SEDE, descrizione: 'Retta ottobre', importo: 150, importo_pagato: 0, stato: 'scaduto', tipo: 'singolo', scadenza: '2026-01-10', ultimo_sollecito_il: null, alunni: { nome: 'Mario', cognome: 'Rossi' } },
    { id: 'p2', alunno_id: 'a2', scuola_id: SEDE, descrizione: 'Mensa ottobre', importo: 60, importo_pagato: 0, stato: 'scaduto', tipo: 'singolo', scadenza: '2026-01-12', ultimo_sollecito_il: null, alunni: { nome: 'Anna', cognome: 'Bianchi' } },
];

/** Anteprima: tutte e due pronte. Invio: `esitiInvio`. */
function stubFetch(esitiInvio: Record<string, unknown>[]) {
    return vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith('/api/pagamenti/solleciti')) {
            const anteprima = JSON.parse(String(init?.body)).anteprima === true;
            const data = anteprima
                ? righe.map((r) => ({ pagamento_id: r.id, ok: true, livello: 1, oggetto: `Promemoria ${r.descrizione}`, corpo: 'Testo' }))
                : esitiInvio;
            return { ok: true, status: 200, json: async () => ({ success: true, data }) };
        }
        if (u.startsWith('/api/pagamenti?')) {
            return { ok: true, status: 200, json: async () => ({ success: true, data: righe }) };
        }
        return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
}

async function inviaTutti() {
    render(<SollecitiPanel userId="u1" scuolaId={SEDE} />);
    await screen.findByText(/Retta ottobre/);
    fireEvent.click(screen.getByRole('checkbox', { name: /Seleziona tutti/ }));
    fireEvent.click(screen.getByRole('button', { name: /Anteprima \(2\)/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Conferma e invia \(2\)/ }));
}

describe('SollecitiPanel — gli esiti dell’invio', () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

    it('uno partito e uno no: il conteggio, poi la voce non partita con il suo motivo', async () => {
        vi.stubGlobal('fetch', stubFetch([
            { pagamento_id: 'p1', ok: true, livello: 1 },
            { pagamento_id: 'p2', ok: false, livello: 1, inviate: 0, tentate: 1, motivo: INCERTO },
        ]));
        await inviaTutti();
        expect(await screen.findByText(/1 sollecito inviato\./)).toBeTruthy();
        expect(screen.getByText('1 sollecito non inviato:')).toBeTruthy();
        const voce = screen.getByText(new RegExp(INCERTO));
        expect(voce.textContent).toContain('Anna Bianchi · Mensa ottobre');
        expect(voce.textContent).not.toContain('Mario Rossi');
        // C'è un sollecito partito davvero: la spunta resta.
        expect(screen.getByRole('img', { name: 'Salvato' })).toBeTruthy();
    });

    it('nessuno partito: niente spunta verde su «0 solleciti inviati», e tutti e due i motivi', async () => {
        vi.stubGlobal('fetch', stubFetch([
            { pagamento_id: 'p1', ok: false, motivo: NESSUN_INDIRIZZO },
            { pagamento_id: 'p2', ok: false, livello: 1, inviate: 0, tentate: 1, motivo: INCERTO },
        ]));
        await inviaTutti();
        expect(await screen.findByText('2 solleciti non inviati:')).toBeTruthy();
        expect(screen.getByText(/0 solleciti inviati\./)).toBeTruthy();
        expect(screen.queryByRole('img', { name: 'Salvato' })).toBeNull();
        expect(screen.getByText(new RegExp(NESSUN_INDIRIZZO)).textContent).toContain('Mario Rossi · Retta ottobre');
        expect(screen.getByText(new RegExp(INCERTO)).textContent).toContain('Anna Bianchi · Mensa ottobre');
    });

    it('tutti partiti: nessun elenco di non inviati', async () => {
        vi.stubGlobal('fetch', stubFetch([
            { pagamento_id: 'p1', ok: true, livello: 1 },
            { pagamento_id: 'p2', ok: true, livello: 1 },
        ]));
        await inviaTutti();
        expect(await screen.findByText(/2 solleciti inviati\./)).toBeTruthy();
        expect(screen.queryByText(/non inviat/)).toBeNull();
    });
});
