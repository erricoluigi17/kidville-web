import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { scegliCategorie } from '../helpers/scelta-contabilita';

/**
 * ─── «SOLO CONTANTI» / «SOLO BONIFICO» NELLO SCADENZARIO (2026-10-05) ─────────────────────
 *
 * Le due tabelle che mostrano la descrizione della voce — la vista per CATEGORIA e l'AGENDA
 * delle scadenze — portano il badge accanto alla descrizione quando il metodo ammesso è uno
 * solo. Con tutti e due, o senza la colonna (DB della CI), la cella resta com'era.
 *
 * ⚠️ `t` STABILE, come in `PaymentsDashboard-coda.test.tsx`: `load` dipende da `t`, e con una
 * `t` nuova a ogni resa le GET ripartono senza fine.
 * ⚠️ Il badge si cerca DENTRO la `row` della tabella: in jsdom la card mobile è montata
 * accanto (`lg:hidden` è solo una classe).
 */
vi.mock('next-intl', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { IntlMessageFormat } = await import('intl-messageformat');
    const cartella = join(process.cwd(), 'messages/it');
    const cataloghi: Record<string, Record<string, unknown>> = {};
    for (const file of readdirSync(cartella)) {
        if (!file.endsWith('.json')) continue;
        cataloghi[file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(cartella, file), 'utf8'));
    }
    const resolve = (ns: string | undefined, key: string): string => {
        const v = ns ? cataloghi[ns]?.[key] : undefined;
        return typeof v === 'string' ? v : ns ? `${ns}.${key}` : key;
    };
    const formatta = (messaggio: string, valori: Record<string, unknown>): string => {
        try {
            return String(new IntlMessageFormat(messaggio, 'it').format(valori));
        } catch {
            return messaggio;
        }
    };
    const perNamespace = new Map<string, unknown>();
    const useTranslations = (ns?: string) => {
        const chiave = ns ?? '';
        const gia = perNamespace.get(chiave);
        if (gia) return gia;
        const t = (key: string, valori?: Record<string, unknown>) =>
            valori === undefined ? resolve(ns, key) : formatta(resolve(ns, key), valori);
        const stabile = Object.assign(t, {
            rich: (key: string) => resolve(ns, key),
            markup: (key: string) => resolve(ns, key),
            raw: (key: string) => resolve(ns, key),
            has: () => true,
        });
        perNamespace.set(chiave, stabile);
        return stabile;
    };
    return {
        useTranslations,
        useLocale: () => 'it',
        useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    };
});

vi.mock('@/lib/context/admin-identity', async (orig) => ({
    ...(await orig<typeof import('@/lib/context/admin-identity')>()),
    useRuoloCockpit: () => 'admin',
}));

/** Una sede sola: nessuna colonna Sede, il rendering di tutti i giorni. */
vi.mock('@/lib/context/sede-context', async (orig) => ({
    ...(await orig<typeof import('@/lib/context/sede-context')>()),
    useSediAttive: () => ({ sedi: [{ id: 's1', nome: 'Sede Uno' }], effettive: ['s1'], selezionate: [], sedeCorrente: 's1', reFetchKey: 's1' }),
}));

vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
    FatturaButton: () => <span data-testid="fattura-button" />,
}));

import { PaymentsDashboard } from '@/components/features/admin/pagamenti/PaymentsDashboard';

const GIORNO_FISSO = '2026-10-10T10:00:00';

const CATEGORIE = {
    success: true,
    data: [
        { id: 'c-retta', nome: 'Retta', slug: 'retta', scuola_id: null },
        { id: 'c-gita', nome: 'Gita', slug: 'gita', scuola_id: null },
    ],
};

const MARA = { id: 'a1', nome: 'Mara', cognome: 'Bianchi', classe_sezione: 'Girasoli' };
const LEO = { id: 'a2', nome: 'Leo', cognome: 'Verdi', classe_sezione: 'Girasoli' };

function voce(id: string, alunno: typeof MARA, extra: Record<string, unknown>) {
    return {
        id, alunno_id: alunno.id, descrizione: 'Retta Ottobre', importo: 100, importo_pagato: 0, stato: 'da_pagare',
        tipo: 'singolo', fattura_stato: 'non_richiesta', scadenza: '2026-10-20', categoria_id: 'c-retta',
        periodo_competenza: '2026-10-01', coda_stato: null, alunni: { nome: alunno.nome, cognome: alunno.cognome },
        ...extra,
    };
}

const PAGAMENTI = {
    success: true,
    data: [
        // Scaduta: finisce nell'agenda «Scaduti fino a 30gg», e si paga solo con bonifico.
        voce('p-retta-mara', MARA, { stato: 'scaduto', scadenza: '2026-10-05', metodi_ammessi: ['bonifico'] }),
        voce('p-retta-leo', LEO, {}),
        voce('p-gita-mara', MARA, { categoria_id: 'c-gita', descrizione: 'Gita al museo', periodo_competenza: null, metodi_ammessi: ['contanti'] }),
        voce('p-gita-leo', LEO, { categoria_id: 'c-gita', descrizione: 'Gita allo zoo', periodo_competenza: null, metodi_ammessi: ['contanti', 'bonifico'] }),
    ],
};

const STUDENTS = [
    { ...MARA, stato: 'iscritto' },
    { ...LEO, stato: 'iscritto' },
];

function rigaTabella(testo: string): HTMLElement {
    const riga = screen.getAllByRole('row').find((r) => r.textContent?.includes(testo));
    if (!riga) throw new Error(`nessuna riga di tabella contiene «${testo}»`);
    return riga;
}

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(GIORNO_FISSO));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const u = String(url);
        const body =
            u.startsWith('/api/pagamenti?') ? PAGAMENTI
                : u.startsWith('/api/pagamenti/rette-a-carico') ? { success: true, data: [], a_carico_non_visibili: [] }
                    : u.startsWith('/api/admin/students') ? STUDENTS
                        : u.includes('/settings/categorie') ? CATEGORIE
                            : u.includes('/settings/aruba') ? { success: true, data: { abilitato: true } }
                                : { success: true, data: [] };
        return { ok: true, status: 200, json: async () => body };
    }));
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('PaymentsDashboard — badge dei metodi ammessi', () => {
    it('vista per categoria: «Solo contanti» accanto alla descrizione, e niente sulla voce con tutti e due', async () => {
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        await scegliCategorie(['Gita']);
        await waitFor(() => expect(rigaTabella('Gita al museo')).toBeInTheDocument());

        const cella = within(rigaTabella('Gita al museo')).getByText('Gita al museo');
        expect(within(cella).getByTestId('badge-metodo-pagamento')).toHaveTextContent('Solo contanti');
        // La riga con tutti e due i metodi c'è (presenza), e il badge no.
        expect(rigaTabella('Gita allo zoo')).toBeInTheDocument();
        expect(within(rigaTabella('Gita allo zoo')).queryByTestId('badge-metodo-pagamento')).toBeNull();
    });

    it('agenda: la voce scaduta «solo bonifico» porta il suo badge', async () => {
        render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
        // Fuori dalla vista rette: nell'agenda la riga si riconosce dalla descrizione.
        await scegliCategorie(['Gita']);
        await waitFor(() => expect(rigaTabella('Gita al museo')).toBeInTheDocument());

        fireEvent.click(screen.getByRole('button', { name: /Scaduti fino a 30gg/ }));
        await waitFor(() => expect(rigaTabella('Retta Ottobre')).toBeInTheDocument());
        const riga = rigaTabella('Retta Ottobre');
        expect(riga).toHaveTextContent('Mara Bianchi');
        expect(within(riga).getByTestId('badge-metodo-pagamento')).toHaveTextContent('Solo bonifico');
    });
});
