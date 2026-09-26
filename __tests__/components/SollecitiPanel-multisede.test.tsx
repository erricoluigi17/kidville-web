import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SollecitiPanel } from '@/components/features/admin/pagamenti/SollecitiPanel';

/**
 * Solleciti con più sedi selezionate (P5a, design 2026-09-26 §3d).
 *
 * Due cose che nessun altro test guarda:
 *  1. con `scuolaId = null` la GET NON porta `scuola_id`: la route valida il parametro
 *     come uuid e risponde 400 a `"null"`/`"undefined"`, e il pannello resterebbe vuoto
 *     («tutto in regola») proprio quando le sedi sono tre;
 *  2. con più sedi la sede si legge su ogni riga E nell'anteprima, perché un sollecito
 *     partito al plesso sbagliato è una email a una famiglia che non deve niente lì.
 *
 * Le due righe sono in sedi DIVERSE a bella posta: una fixture con una sola sede non
 * distinguerebbe «la sede della riga» da «una sede qualunque».
 */

const SEDE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SEDE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const righe = [
    { id: 'p1', alunno_id: 'a1', scuola_id: SEDE_A, scuola_nome: 'Plesso Alfa', descrizione: 'Retta ottobre', importo: 150, importo_pagato: 0, stato: 'scaduto', tipo: 'singolo', scadenza: '2026-01-10', ultimo_sollecito_il: null, alunni: { nome: 'Uno', cognome: 'Prova' } },
    { id: 'p2', alunno_id: 'a2', scuola_id: SEDE_B, scuola_nome: 'Plesso Beta', descrizione: 'Mensa ottobre', importo: 60, importo_pagato: 0, stato: 'scaduto', tipo: 'singolo', scadenza: '2026-01-12', ultimo_sollecito_il: null, alunni: { nome: 'Due', cognome: 'Prova' } },
];

function stubFetch(dati: typeof righe = righe) {
    return vi.fn(async (url: string) => {
        const u = String(url);
        if (u.startsWith('/api/pagamenti/solleciti')) {
            return {
                ok: true, status: 200,
                json: async () => ({ success: true, data: [{ pagamento_id: 'p2', ok: true, livello: 1, oggetto: 'Promemoria', corpo: 'Testo del sollecito' }] }),
            };
        }
        if (u.startsWith('/api/pagamenti?')) {
            return { ok: true, status: 200, json: async () => ({ success: true, data: dati }) };
        }
        return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
}

const urlGet = (f: ReturnType<typeof stubFetch>) =>
    f.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith('/api/pagamenti?')) ?? '';

describe('SollecitiPanel — più sedi', () => {
    let fetchMock: ReturnType<typeof stubFetch>;
    beforeEach(() => { fetchMock = stubFetch(); vi.stubGlobal('fetch', fetchMock); });
    afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

    it('con scuolaId null la GET omette scuola_id (mai "null"/"undefined" nell\'URL)', async () => {
        render(<SollecitiPanel userId="u1" scuolaId={null} />);
        await screen.findByText(/Retta ottobre/);
        const url = urlGet(fetchMock);
        expect(url).toContain('solo_aperti=true');
        expect(url).not.toContain('scuola_id');
        expect(url).not.toMatch(/=(null|undefined)(&|$)/);
    });

    it('con una sede sola la GET porta scuola_id di quella sede', async () => {
        render(<SollecitiPanel userId="u1" scuolaId={SEDE_A} />);
        await screen.findByText(/Retta ottobre/);
        expect(urlGet(fetchMock)).toContain(`scuola_id=${SEDE_A}`);
    });

    it('con più sedi ogni riga mostra la PROPRIA sede', async () => {
        render(<SollecitiPanel userId="u1" scuolaId={null} />);
        const rigaA = (await screen.findByText(/Retta ottobre/)).closest('label') as HTMLElement;
        const rigaB = screen.getByText(/Mensa ottobre/).closest('label') as HTMLElement;
        expect(within(rigaA).getByText(/Plesso Alfa/)).toBeTruthy();
        expect(within(rigaA).queryByText(/Plesso Beta/)).toBeNull();
        expect(within(rigaB).getByText(/Plesso Beta/)).toBeTruthy();
        expect(within(rigaB).queryByText(/Plesso Alfa/)).toBeNull();
    });

    it('con più sedi l\'anteprima dice la sede del pagamento che sollecita', async () => {
        render(<SollecitiPanel userId="u1" scuolaId={null} />);
        const rigaB = (await screen.findByText(/Mensa ottobre/)).closest('label') as HTMLElement;
        fireEvent.click(within(rigaB).getByRole('checkbox'));
        fireEvent.click(screen.getByRole('button', { name: /Anteprima \(1\)/ }));
        const banner = await screen.findByText('Anteprima — nessuna email è ancora partita');
        const riquadro = banner.parentElement as HTMLElement;
        const voce = within(riquadro).getByText(/Promemoria/).closest('div') as HTMLElement;
        expect(within(voce).getByText(/Plesso Beta/)).toBeTruthy();
        expect(within(voce).queryByText(/Plesso Alfa/)).toBeNull();
    });

    // La GET /api/pagamenti manda `scuola_nome: null` quando la ricerca dei nomi in
    // `scuole` fallisce («la causale resta senza sede»): la riga deve dire che la sede
    // NON è nota, non mostrare «Sede: » vuoto né prendere in prestito l'altra sede.
    it('con più sedi e scuola_nome null la riga e l\'anteprima dicono «Sede: non indicata»', async () => {
        const senzaNome = [righe[0], { ...righe[1], scuola_nome: null as unknown as string }];
        fetchMock = stubFetch(senzaNome);
        vi.stubGlobal('fetch', fetchMock);
        render(<SollecitiPanel userId="u1" scuolaId={null} />);

        const rigaA = (await screen.findByText(/Retta ottobre/)).closest('label') as HTMLElement;
        const rigaB = screen.getByText(/Mensa ottobre/).closest('label') as HTMLElement;
        expect(within(rigaB).getByText('Sede: non indicata')).toBeTruthy();
        expect(within(rigaB).queryByText(/Plesso Alfa/)).toBeNull();
        // L'altra riga, che il nome ce l'ha, resta intatta.
        expect(within(rigaA).getByText('Sede: Plesso Alfa')).toBeTruthy();

        fireEvent.click(within(rigaB).getByRole('checkbox'));
        fireEvent.click(screen.getByRole('button', { name: /Anteprima \(1\)/ }));
        const banner = await screen.findByText('Anteprima — nessuna email è ancora partita');
        const riquadro = banner.parentElement as HTMLElement;
        const voce = within(riquadro).getByText(/Promemoria/).closest('div') as HTMLElement;
        expect(within(voce).getByText('Sede: non indicata')).toBeTruthy();
        expect(within(voce).queryByText(/Plesso Alfa/)).toBeNull();
    });

    it('con una sede sola la sede NON si ripete su ogni riga', async () => {
        render(<SollecitiPanel userId="u1" scuolaId={SEDE_A} />);
        await screen.findByText(/Retta ottobre/);
        expect(screen.queryByText(/Plesso Alfa/)).toBeNull();
        expect(screen.queryByText(/Plesso Beta/)).toBeNull();
    });
});
