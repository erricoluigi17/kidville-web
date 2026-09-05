import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * `/parent/pagamenti` — la lista monta «Come pagare» con le coordinate della sede.
 *
 * Fino al 2026-09-05 la pagina montava SOLO la card della causale: il genitore
 * leggeva che cosa scrivere nel bonifico e non dove mandarlo. Qui si misura il
 * ponte fra il contratto del GET (`sedi: [{ id, nome, iban, intestatario }]`,
 * `scuola_id` sulle voci) e la card.
 *
 * ⚠️ DATI SINTETICI, repo pubblico: l'IBAN è l'esempio PUBBLICO della Banca
 * d'Italia, nomi e intestatario sono inventati.
 */

const IBAN_LEGGIBILE = 'IT60 X054 2811 1010 0000 0123 456';

// Il realtime di Supabase non deve toccare la rete: canale finto, `removeChannel` no-op.
vi.mock('@/lib/supabase/browser-client', () => {
    const channel = {
        on() { return channel; },
        subscribe() { return channel; },
    };
    return { getSupabase: () => ({ channel: () => channel, removeChannel: () => {} }) };
});

import { StoricoPagamenti } from '@/components/features/parent/pagamenti/StoricoPagamenti';

const VOCE = {
    id: 'p1',
    alunno_id: 'a1',
    scuola_id: 'sede-1',
    descrizione: 'Retta Settembre',
    importo: 250,
    importo_pagato: 0,
    sconto: 0,
    scadenza: '2026-09-10',
    stato: 'da_pagare',
    tipo: 'singolo',
    obbligatorio: true,
    causale_suggerita: 'Retta Settembre 2026 - per il minore Mara Bianchi - PLESSO UNO',
    alunni: { nome: 'Mara', cognome: 'Bianchi', codice_fiscale: 'ABCDEF00A00A000A' },
};

/** Voce PARZIALE: pagati 20 su 60, restano 40. Serve a distinguere residuo da importo. */
const VOCE_PARZIALE = {
    ...VOCE,
    id: 'p2',
    descrizione: 'Mensa Settembre',
    importo: 60,
    importo_pagato: 20,
    stato: 'parziale',
    causale_suggerita: 'Mensa Settembre 2026 - per il minore Mara Bianchi - PLESSO UNO',
};

const SEDI = [{ id: 'sede-1', nome: 'Plesso Uno', iban: IBAN_LEGGIBILE, intestatario: 'Cooperativa Esempio soc. coop.' }];

/** Il corpo del GET: `data` + `sedi`. `sedi` assente = risposta del backend vecchio. */
let corpo: Record<string, unknown> = {};

beforeEach(() => {
    vi.clearAllMocks();
    corpo = { success: true, data: [VOCE], sedi: SEDI };
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
            if (String(url).includes('/api/pagamenti')) {
                return { ok: true, status: 200, json: async () => corpo };
            }
            return { ok: false, status: 404, json: async () => null };
        }),
    );
});

describe('StoricoPagamenti — «Come pagare» con le coordinate della sede', () => {
    it('mostra la card, l’intestatario e l’IBAN che arrivano dal GET', async () => {
        render(<StoricoPagamenti userId="u-1" />);

        expect(await screen.findByText('Come pagare')).toBeInTheDocument();
        expect(screen.getByText(IBAN_LEGGIBILE)).toBeInTheDocument();
        expect(screen.getByText('Cooperativa Esempio soc. coop.')).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: 'Bonifico' })).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: 'Contanti' })).toBeInTheDocument();
        // La causale resta dov'era: ora è dentro la card, non accanto.
        expect(screen.getByText(VOCE.causale_suggerita)).toBeInTheDocument();
    });

    it('senza `sedi` nella risposta la card resta e rimanda alla segreteria', async () => {
        corpo = { success: true, data: [VOCE] };
        render(<StoricoPagamenti userId="u-1" />);

        expect(await screen.findByText('Come pagare')).toBeInTheDocument();
        expect(
            screen.getByText('Le coordinate bancarie non sono ancora disponibili: chiedile in segreteria.'),
        ).toBeInTheDocument();
        expect(screen.getByText(VOCE.causale_suggerita)).toBeInTheDocument();
    });

    it('senza voci aperte la card non compare', async () => {
        corpo = { success: true, data: [{ ...VOCE, stato: 'pagato', importo_pagato: 250 }], sedi: [] };
        render(<StoricoPagamenti userId="u-1" />);

        expect(await screen.findByText('Retta Settembre')).toBeInTheDocument();
        expect(screen.queryByText('Come pagare')).toBeNull();
    });

    it('ogni riga della causale porta la propria voce e il RESIDUO, non l’importo pieno', async () => {
        corpo = { success: true, data: [VOCE, VOCE_PARZIALE], sedi: SEDI };
        render(<StoricoPagamenti userId="u-1" />);

        expect(await screen.findByText('Come pagare')).toBeInTheDocument();
        // «Mensa Settembre» compare due volte: nella card e nell'elenco sotto.
        expect(screen.getAllByText('Mensa Settembre').length).toBeGreaterThanOrEqual(2);
        // Nella card l'importo è il RESIDUO (60 − 20 = 40): è quanto va versato oggi.
        // Nell'elenco resta l'importo pieno, «€ 60,00», con «(resta …)» accanto: due
        // numeri diversi che dicono due cose diverse, e quello da bonificare è qui.
        expect(screen.getAllByText('€ 40,00').length).toBeGreaterThanOrEqual(1);
    });
});
