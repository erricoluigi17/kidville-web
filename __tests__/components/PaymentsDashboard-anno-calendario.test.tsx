import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

/**
 * PR 4.1 · compito 4.1.S4a · Contabilità: l'anno proposto segue il calendario della sede quando ARRIVA,
 * e un anno scelto a mano dalla segreteria prima dell'arrivo non viene mai sovrascritto.
 * (Si monta il vero PaymentsDashboard: lo scaffolding è quello di `PaymentsDashboard-selezione-voci.test.tsx`.)
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

vi.mock('@/lib/context/sede-context', async (orig) => ({
    ...(await orig<typeof import('@/lib/context/sede-context')>()),
    useSediAttive: () => SEDI_FINTE,
}));
const SEDI_FINTE = vi.hoisted(() => ({
    sedi: [{ id: 's1', nome: 'Kidville Uno' }], effettive: ['s1'], selezionate: [] as string[], sedeCorrente: 's1', reFetchKey: 's1',
}));

vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
    FatturaButton: () => <span data-testid="fattura-button" />,
}));

import { PaymentsDashboard } from '@/components/features/admin/pagamenti/PaymentsDashboard';
import { CalendarioProvider } from '@/lib/context/calendario-context';

const riga = (annoInizio: number, inizio: string, fine: string) => ({
    annoId: `a${annoInizio}`, annoSedeId: `r${annoInizio}`, annoInizio, inizio, fine,
    ultimoGiornoAperto: fine, preparaSuccessivoDal: inizio, stato: 'corrente', domandeAperte: false,
});
const CAL_SEDE = [riga(2025, '2025-09-01', '2026-09-14'), riga(2026, '2026-09-15', '2027-08-31')];

let sbloccaCalendario: () => void = () => {};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-10T10:00:00Z')); // a Roma: 10 settembre 2026
    const calendario = new Promise<void>((ok) => { sbloccaCalendario = ok; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const u = String(url);
        if (u.startsWith('/api/anno/calendario')) {
            await calendario; // il calendario arriva SOLO quando il test lo decide
            return new Response(JSON.stringify({ success: true, data: [{ scuola_id: 's1', righe: CAL_SEDE }] }), { status: 200 });
        }
        const body = u.includes('/settings/aruba') ? { success: true, data: { abilitato: true } } : { success: true, data: [] };
        return { ok: true, status: 200, json: async () => body };
    }));
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
});

const montaDashboard = () => render(
    <CalendarioProvider>
        <PaymentsDashboard userId="u1" scuolaId="s1" />
    </CalendarioProvider>,
);

describe('PaymentsDashboard — l\'anno proposto e il calendario che arriva', () => {
    it('prima il predefinito (2026), poi il calendario della sede (2025): l\'anno segue', async () => {
        montaDashboard();
        const tendina = await screen.findByLabelText('Anno scolastico');
        expect(tendina).toHaveValue('2026');
        sbloccaCalendario();
        await waitFor(() => expect(screen.getByLabelText('Anno scolastico')).toHaveValue('2025'));
    });

    it('un anno scelto a mano prima dell\'arrivo del calendario NON viene sovrascritto', async () => {
        montaDashboard();
        const tendina = await screen.findByLabelText('Anno scolastico');
        fireEvent.change(tendina, { target: { value: '2025' } });
        fireEvent.change(tendina, { target: { value: '2026' } }); // scelta esplicita, diversa da quella che arriverà
        expect(tendina).toHaveValue('2026');
        sbloccaCalendario();
        // La PRESENZA che prova l'arrivo: le opzioni ora partono dall'anno proposto (2025), quindi c'è il 2024/2025.
        await waitFor(() => expect(screen.getByRole('option', { name: /2024\/2025/ })).toBeInTheDocument());
        expect(screen.getByLabelText('Anno scolastico')).toHaveValue('2026');
    });
});
