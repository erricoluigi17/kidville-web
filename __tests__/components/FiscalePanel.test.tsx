import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

const SEDE_A = '11000000-0000-4000-8000-00000000000a';
const SEDE_B = '11000000-0000-4000-8000-00000000000b';
const SEDE_C = '11000000-0000-4000-8000-00000000000c';
/** Una sede che il cockpit non conosce (né fra le accessibili né fra le effettive). */
const SEDE_IGNOTA = '11000000-0000-4000-8000-0000000000ff';

/**
 * Le sedi del cockpit. `sedi` sono le ACCESSIBILI, `effettive` quelle selezionate: il pannello
 * deve offrire alla revisione fatture solo le effettive (qui Aversa e Cesa, non Giugliano).
 */
const sediCtx = vi.hoisted(() => ({
    valore: {
        sedi: [] as { id: string; nome: string }[],
        effettive: [] as string[],
    },
}));
vi.mock('@/lib/context/sede-context', async (orig) => ({
    ...(await orig<typeof import('@/lib/context/sede-context')>()),
    useSediAttive: () => sediCtx.valore,
}));

/** Il sotto-pannello registra le props che riceve: il contratto qui è COSA gli si passa. */
const revisione = vi.hoisted(() => ({ props: [] as unknown[] }));
vi.mock('@/components/features/admin/pagamenti/RevisioneFatturePanel', () => ({
    RevisioneFatturePanel: (p: unknown) => {
        revisione.props.push(p);
        return null;
    },
}));

import { FiscalePanel } from '@/components/features/admin/pagamenti/FiscalePanel';

type Riga = Record<string, unknown>;

function stub(opts: { alunni?: Riga[]; ricevute?: Riga[] } = {}) {
    const url: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL) => {
        const s = String(u);
        url.push(s);
        if (s.startsWith('/api/pagamenti/ricevute')) {
            return { ok: true, json: async () => ({ success: true, data: opts.ricevute ?? [] }) };
        }
        if (s.startsWith('/api/admin/students')) {
            return { ok: true, json: async () => ({ success: true, data: opts.alunni ?? [] }) };
        }
        return { ok: true, json: async () => ({ success: true, data: [] }) };
    }));
    return url;
}

function ricevuta(extra: Riga): Riga {
    return {
        id: 'r1', pagamento_id: null, scuola_id: SEDE_A, scuola_nome: 'Kidville Aversa',
        numero: 7, anno: new Date().getFullYear(), importo: 100, periodo_competenza: null,
        metodi: ['bonifico'], tracciabile: true, bollo: false, annullata_il: null,
        annullo_motivo: null, creato_il: '2026-09-01T10:00:00Z',
        alunni: { nome: 'Ada', cognome: 'Uno' },
        ...extra,
    };
}

beforeEach(() => {
    revisione.props = [];
    sediCtx.valore = {
        sedi: [
            { id: SEDE_A, nome: 'Kidville Aversa' },
            { id: SEDE_B, nome: 'Kidville Cesa' },
            { id: SEDE_C, nome: 'Kidville Giugliano' },
        ],
        effettive: [SEDE_A, SEDE_B],
    };
});
afterEach(() => vi.unstubAllGlobals());

// Contabilità = solo frequentanti: gli iscritti SENZA sezione non devono
// comparire nemmeno nella lista attestazioni.
describe('FiscalePanel — filtro frequentanti', () => {
    it('lista solo gli alunni assegnati a una sezione', async () => {
        stub({ alunni: [
            { id: 'a1', nome: 'Mario', cognome: 'Rossi', classe_sezione: '1A', section_id: null, scuola_id: SEDE_A },
            { id: 'a2', nome: 'Ugo', cognome: 'Verdi', classe_sezione: null, section_id: null, scuola_id: SEDE_A },
        ] });
        render(<FiscalePanel userId="u1" scuolaId={SEDE_A} />);
        await waitFor(() => expect(screen.getByText(/Mario Rossi/)).toBeInTheDocument());
        expect(screen.queryByText(/Ugo Verdi/)).toBeNull();
    });
});

describe('FiscalePanel — più sedi (scuolaId null)', () => {
    it('elenco alunni SENZA scuola_id nell\'URL, e ogni alunno dice la sua sede', async () => {
        const url = stub({ alunni: [
            { id: 'a1', nome: 'Mario', cognome: 'Rossi', classe_sezione: '1A', scuola_id: SEDE_A },
            { id: 'a2', nome: 'Mario', cognome: 'Rossi', classe_sezione: '1A', scuola_id: SEDE_B },
            // Sede assente dall'elenco del cockpit: il ripiego, mai l'uuid.
            { id: 'a3', nome: 'Ugo', cognome: 'Verdi', classe_sezione: '1A', scuola_id: SEDE_IGNOTA },
        ] });
        render(<FiscalePanel userId="u1" scuolaId={null} />);
        // Due omonimi nella stessa classe di sedi diverse: senza la sede sarebbero indistinguibili.
        expect(await screen.findByRole('option', { name: 'Mario Rossi · 1A · Kidville Aversa' })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'Mario Rossi · 1A · Kidville Cesa' })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'Ugo Verdi · 1A · Sede non indicata' })).toBeInTheDocument();

        const studenti = url.filter((u) => u.startsWith('/api/admin/students'));
        expect(studenti).toHaveLength(1);
        const qs = new URL(studenti[0], 'http://x').searchParams;
        expect(qs.has('scuola_id')).toBe(false);
        expect(qs.get('stato')).toBe('iscritto');
        expect(studenti[0]).not.toMatch(/null|undefined/);
    });

    it('registro ricevute con la colonna Sede: due «n. 7» di sedi diverse si distinguono', async () => {
        stub({ ricevute: [
            ricevuta({ id: 'r1', scuola_id: SEDE_A, scuola_nome: 'Kidville Aversa' }),
            ricevuta({ id: 'r2', scuola_id: SEDE_B, scuola_nome: 'Kidville Cesa' }),
            // Nome sede assente (ripiego della route senza FK): si usa il nome del cockpit.
            ricevuta({ id: 'r3', scuola_id: SEDE_B, scuola_nome: null, numero: 8 }),
            // Né nome dalla route né sede nel cockpit: il ripiego finale, mai l'uuid né il vuoto.
            ricevuta({ id: 'r4', scuola_id: SEDE_IGNOTA, scuola_nome: null, numero: 9 }),
        ] });
        render(<FiscalePanel userId="u1" scuolaId={null} />);
        const tabella = await screen.findByRole('table');
        const intestazioni = within(tabella).getAllByRole('columnheader').map((h) => h.textContent);
        expect(intestazioni).toEqual(['N.', 'Sede', 'Data', 'Alunno', 'Importo', 'Stato']);
        const righe = within(tabella).getAllByRole('row').slice(1);
        expect(righe.map((r) => within(r).getAllByRole('cell')[1].textContent)).toEqual([
            'Kidville Aversa', 'Kidville Cesa', 'Kidville Cesa', 'Sede non indicata',
        ]);
        // Le schede mobili (jsdom le rende: `lg:hidden` è solo CSS) dicono la sede anche loro,
        // una riga per scheda, nello stesso ordine del registro. Sede non risolta: il solo
        // ripiego, senza il prefisso «Sede:» (mai «Sede: Sede non indicata»).
        const righeSede = screen.getAllByText(/^(Sede: .+|Sede non indicata)$/)
            .filter((el) => el.tagName === 'P');
        expect(righeSede.map((p) => p.textContent)).toEqual([
            'Sede: Kidville Aversa', 'Sede: Kidville Cesa', 'Sede: Kidville Cesa', 'Sede non indicata',
        ]);
    });

    it('catalogo en/it in parità: il ripiego della sede dice la stessa cosa e non ripete il prefisso', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const catalogo = (lingua: string) => JSON.parse(readFileSync(
            join(process.cwd(), `messages/${lingua}/adminContabilita.json`), 'utf8',
        )) as Record<string, string>;
        const it_ = catalogo('it');
        const en = catalogo('en');
        expect(it_.fisc_sede_ignota).toBe('Sede non indicata');
        // Stessa formula del catalogo inglese per lo stesso concetto (`filtroClassiSedeIgnota`, `ticketSedeIgnota`).
        expect(en.fisc_sede_ignota).toBe('Location not specified');
        expect(en.fisc_sede_ignota).toBe(en.ticketSedeIgnota);
    });

    it('export AdE: link SENZA scuola_id (file unico con colonna Sede) e avviso del file unico', async () => {
        stub();
        render(<FiscalePanel userId="u1" scuolaId={null} />);
        const ade = await screen.findByRole('link', { name: /Esporta comunicazione/ });
        const href = ade.getAttribute('href') ?? '';
        expect(href).toBe(`/api/pagamenti/export?tipo=ade&anno=${new Date().getFullYear() - 1}&userId=u1`);
        expect(href).not.toMatch(/scuola_id|null|undefined/);
        expect(screen.getByText(/Un file unico per tutte le sedi selezionate/)).toBeInTheDocument();
    });

    it('la revisione fatture riceve le sedi EFFETTIVE con il nome, e nessuna sede iniziale', async () => {
        stub();
        render(<FiscalePanel userId="u1" scuolaId={null} />);
        await screen.findByRole('link', { name: /Esporta comunicazione/ });
        expect(revisione.props.at(-1)).toEqual({
            userId: 'u1',
            sedi: [
                { id: SEDE_A, nome: 'Kidville Aversa' },
                { id: SEDE_B, nome: 'Kidville Cesa' },
            ],
            sedeIniziale: null,
        });
    });
});

describe('FiscalePanel — una sola sede (invariato)', () => {
    it('elenco alunni CON scuola_id, niente sede nelle opzioni, niente colonna Sede, AdE con scuola_id', async () => {
        sediCtx.valore = { sedi: [{ id: SEDE_A, nome: 'Kidville Aversa' }], effettive: [SEDE_A] };
        const url = stub({
            alunni: [{ id: 'a1', nome: 'Mario', cognome: 'Rossi', classe_sezione: '1A', scuola_id: SEDE_A }],
            ricevute: [ricevuta({})],
        });
        render(<FiscalePanel userId="u1" scuolaId={SEDE_A} />);
        expect(await screen.findByRole('option', { name: 'Mario Rossi · 1A' })).toBeInTheDocument();
        const tabella = await screen.findByRole('table');
        expect(within(tabella).getAllByRole('columnheader').map((h) => h.textContent))
            .toEqual(['N.', 'Data', 'Alunno', 'Importo', 'Stato']);
        // Presenza prima dell'assenza: la scheda mobile c'è, ma senza la riga della sede.
        expect(screen.getByText(/^n\. 7\/\d{4} · Ada Uno$/)).toBeInTheDocument();
        expect(screen.queryAllByText(/^Sede: /)).toHaveLength(0);

        const studenti = url.filter((u) => u.startsWith('/api/admin/students'));
        expect(new URL(studenti[0], 'http://x').searchParams.get('scuola_id')).toBe(SEDE_A);
        expect(screen.getByRole('link', { name: /Esporta comunicazione/ }).getAttribute('href'))
            .toBe(`/api/pagamenti/export?tipo=ade&anno=${new Date().getFullYear() - 1}&userId=u1&scuola_id=${SEDE_A}`);
        expect(screen.queryByText(/Un file unico per tutte le sedi selezionate/)).toBeNull();
        expect(revisione.props.at(-1)).toEqual({
            userId: 'u1',
            sedi: [{ id: SEDE_A, nome: 'Kidville Aversa' }],
            sedeIniziale: SEDE_A,
        });
    });

    it('sede della pagina non ancora nell\'elenco del cockpit: la revisione la riceve comunque', async () => {
        sediCtx.valore = { sedi: [], effettive: [] };
        stub();
        render(<FiscalePanel userId="u1" scuolaId={SEDE_A} />);
        await screen.findByRole('link', { name: /Esporta comunicazione/ });
        expect(revisione.props.at(-1)).toEqual({
            userId: 'u1',
            sedi: [{ id: SEDE_A, nome: '' }],
            sedeIniziale: SEDE_A,
        });
    });
});
