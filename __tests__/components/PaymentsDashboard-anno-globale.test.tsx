import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

/**
 * Lotto 5 · Contabilità: la tendina «Anno scolastico» della pagina PARTE dall'anno scelto nel selettore globale (accanto alla sede)
 * e resta cambiabile a mano. Stesso significato: l'anno di settembre. Scaffolding di `PaymentsDashboard-anno-calendario.test.tsx`.
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

const GLOBALE = vi.hoisted(() => ({ effettivo: null as null | { annoInizio: number } }));
vi.mock('@/lib/context/anno-context', async (orig) => ({
    ...(await orig<typeof import('@/lib/context/anno-context')>()),
    useAnnoOpzionale: () => (GLOBALE.effettivo ? { effettivo: GLOBALE.effettivo } : null),
}));

import { PaymentsDashboard } from '@/components/features/admin/pagamenti/PaymentsDashboard';
import { CalendarioProvider } from '@/lib/context/calendario-context';

const riga = (annoInizio: number, inizio: string, fine: string) => ({
    annoId: `a${annoInizio}`, annoSedeId: `r${annoInizio}`, annoInizio, inizio, fine,
    ultimoGiornoAperto: fine, preparaSuccessivoDal: inizio, stato: 'corrente', domandeAperte: false,
});
const CAL_SEDE = [riga(2025, '2025-09-01', '2026-09-14'), riga(2026, '2026-09-15', '2027-08-31')];

beforeEach(() => {
    GLOBALE.effettivo = null;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-10T10:00:00Z')); // a Roma: 10 settembre 2026, anno in corso 2026/27
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const u = String(url);
        if (u.startsWith('/api/anno/calendario')) {
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

describe('PaymentsDashboard — la tendina dell\'anno parte dal selettore globale', () => {
    it('con il selettore globale su 2027/28 la tendina parte da 2027, non da 2026', async () => {
        GLOBALE.effettivo = { annoInizio: 2027 };
        montaDashboard();
        const tendina = await screen.findByLabelText('Anno scolastico');
        expect(tendina).toHaveValue('2027');
        expect(screen.getByRole('option', { name: /2027\/2028/ })).toBeInTheDocument();
    });

    it('resta cambiabile a mano, e la scelta batte il selettore globale', async () => {
        GLOBALE.effettivo = { annoInizio: 2027 };
        montaDashboard();
        const tendina = await screen.findByLabelText('Anno scolastico');
        fireEvent.change(tendina, { target: { value: '2026' } });
        expect(screen.getByLabelText('Anno scolastico')).toHaveValue('2026');
    });

    it('senza una scelta globale (o fuori dal provider) vale l\'anno del calendario della sede', async () => {
        montaDashboard();
        const tendina = await screen.findByLabelText('Anno scolastico');
        await waitFor(() => expect(tendina).toHaveValue('2025'));
    });
});
