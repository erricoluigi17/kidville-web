import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PaymentsDashboard } from '@/components/features/admin/pagamenti/PaymentsDashboard';
import { AgendaScadenze } from '@/components/features/admin/pagamenti/AgendaScadenze';

/**
 * Gli importi della Contabilità a SCHERMO, in italiano.
 *
 * Il difetto misurato: su `/admin/pagamenti` le 4 card KPI stampavano «€ 2892.00» — punto
 * decimale e migliaia non raggruppate — mentre il tab «Cassa», a un clic di distanza, mostrava
 * «€ 2.301,62» perché passa da `formatEuro`. Due formati di valuta nella stessa schermata.
 *
 * Il test di `formatEuro` (in `__tests__/format/valuta.test.ts`) era verde: collaudava la
 * FUNZIONE, non i punti d'uso. Questi test guardano invece quello che l'operatore legge davvero,
 * ed è l'unico posto dove il difetto era visibile.
 *
 * Gli importi scelti sono a quattro cifre di proposito: l'it-IT ha `minimumGroupingDigits = 2`,
 * quindi 1234 è precisamente il numero che smaschera sia il punto decimale sia il raggruppamento
 * mancante.
 */

const CATEGORIE = { success: true, data: [{ id: 'c1', nome: 'Retta', slug: 'retta' }] };
const ARUBA = { success: true, data: { abilitato: true } };

/** Due pagamenti che portano i KPI a cifre con le migliaia. */
const PAGAMENTI = {
    success: true,
    data: [
        {
            id: 'p1', alunno_id: 'a1', descrizione: 'Retta Settembre', importo: 1234.5,
            importo_pagato: 1234.5, stato: 'pagato', tipo: 'singolo', fattura_stato: 'non_richiesta',
            scadenza: '2026-09-05', categoria_id: 'c1', periodo_competenza: '2026-09-01',
            alunni: { nome: 'Mario', cognome: 'Rossi' },
        },
        {
            id: 'p2', alunno_id: 'a2', descrizione: 'Retta Ottobre', importo: 2000,
            importo_pagato: 0, stato: 'scaduto', tipo: 'singolo', fattura_stato: 'non_richiesta',
            scadenza: '2026-10-05', categoria_id: 'c1', periodo_competenza: '2026-10-01',
            alunni: { nome: 'Ada', cognome: 'Bianchi' },
        },
    ],
};

const STUDENTS = [
    { id: 'a1', nome: 'Mario', cognome: 'Rossi', classe_sezione: 'Girasoli', stato: 'iscritto' },
    { id: 'a2', nome: 'Ada', cognome: 'Bianchi', classe_sezione: 'Girasoli', stato: 'iscritto' },
];

function stubFetch() {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const u = String(url);
        const body =
            u.startsWith('/api/pagamenti?') ? PAGAMENTI
                : u.startsWith('/api/admin/students') ? STUDENTS
                    : u.includes('/settings/categorie') ? CATEGORIE
                        : u.includes('/settings/aruba') ? ARUBA
                            : { success: true, data: [] };
        return { ok: true, json: async () => body };
    }));
}

describe('PaymentsDashboard — i KPI della Contabilità in formato italiano', () => {
    beforeEach(stubFetch);
    afterEach(() => vi.unstubAllGlobals());

    it('le card KPI stampano «€ 1.234,50», non «€ 1234.50»', async () => {
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        // Incassato = 1.234,50 (l'unico importo_pagato) e Da fatturare = 1.234,50
        // (lo stesso pagamento saldato e non ancora fatturato): due card, stesso importo.
        expect(await screen.findAllByText('€ 1.234,50')).toHaveLength(2);
        // Da incassare = 2.000,00 · Scaduto/morosità = 2.000,00 → altre due card
        expect(screen.getAllByText('€ 2.000,00')).toHaveLength(2);
    });

    it('in tutta la schermata non resta un solo importo col punto decimale', async () => {
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await waitFor(() => expect(screen.getAllByText('€ 1.234,50').length).toBeGreaterThan(0));
        // «1.234,50» ha tre cifre dopo il punto (raggruppamento); «1234.50» ne ha due:
        // il lookahead distingue il raggruppamento italiano dai centesimi anglosassoni.
        const anglosassoni = document.body.textContent?.match(/\d\.\d{2}(?!\d)/g) ?? [];
        expect(anglosassoni).toEqual([]);
    });
});

describe('AgendaScadenze — i totali dei bucket in formato italiano', () => {
    it('somma e stampa «€ 1.500,00» col punto separatore delle migliaia', () => {
        render(
            <AgendaScadenze
                pagamenti={[
                    { importo: 1000, importo_pagato: 0, scadenza: '2026-07-12', stato: 'da_pagare', tipo: 'singolo' },
                    { importo: 500, importo_pagato: 0, scadenza: '2026-07-13', stato: 'da_pagare', tipo: 'singolo' },
                ]}
                oggi="2026-07-10"
                attivo={null}
                onSelect={() => {}}
            />
        );
        expect(screen.getByRole('button', { name: /Questa settimana/ })).toHaveTextContent('€ 1.500,00');
        expect(document.body.textContent).not.toMatch(/\d\.\d{2}(?!\d)/);
    });
});
