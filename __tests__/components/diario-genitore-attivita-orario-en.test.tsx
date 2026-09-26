import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import enDiario from '../../messages/en/diario.json';
import itDiario from '../../messages/it/diario.json';

/**
 * D3 (2026-09-26) — L'ORARIO DELLE ATTIVITÀ, CON L'INTERFACCIA IN INGLESE.
 *
 * Il mock globale di `next-intl` (`test/setup.ts`) risolve solo i cataloghi
 * ITALIANI: lì una frase scritta in italiano a mano nel codice sarebbe
 * indistinguibile da una letta dal catalogo. Qui si rimocka `next-intl` con i
 * cataloghi di `messages/en` e `useLocale() === 'en'`, si monta la pagina VERA e
 * si guarda che il genitore legga «from 10:00 to 11:00», non «dalle».
 */

vi.mock('next-intl', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { IntlMessageFormat } = await import('intl-messageformat');
    const { join } = await import('node:path');
    const cartella = join(process.cwd(), 'messages/en');
    const en: Record<string, Record<string, unknown>> = {};
    for (const file of readdirSync(cartella)) {
        if (!file.endsWith('.json')) continue;
        en[file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(cartella, file), 'utf8'));
    }
    if (Object.keys(en).length === 0) throw new Error(`Nessun catalogo inglese in ${cartella}`);
    const foglia = (gruppo: Record<string, unknown> | undefined, chiave: string): string | undefined => {
        let corrente: unknown = gruppo;
        for (const pezzo of chiave.split('.')) {
            if (typeof corrente !== 'object' || corrente === null) return undefined;
            corrente = (corrente as Record<string, unknown>)[pezzo];
        }
        return typeof corrente === 'string' ? corrente : undefined;
    };
    const risolvi = (ns: string | undefined, chiave: string): string =>
        foglia(ns ? en[ns] : undefined, chiave) ?? (ns ? `${ns}.${chiave}` : chiave);
    const formatta = (messaggio: string, valori: Record<string, unknown>): string => {
        try {
            return String(new IntlMessageFormat(messaggio, 'en').format(valori));
        } catch {
            return messaggio;
        }
    };
    const useTranslations = (ns?: string) => {
        const t = (chiave: string, valori?: Record<string, unknown>) =>
            valori === undefined ? risolvi(ns, chiave) : formatta(risolvi(ns, chiave), valori);
        return Object.assign(t, {
            rich: (chiave: string) => risolvi(ns, chiave),
            markup: (chiave: string) => risolvi(ns, chiave),
            raw: (chiave: string) => risolvi(ns, chiave),
            has: () => true,
        });
    };
    return {
        useTranslations,
        useLocale: () => 'en',
        useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    };
});

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
    useSearchParams: () => new URLSearchParams(''),
    useParams: () => ({}),
    usePathname: () => '/parent/diary',
}));
vi.mock('@/lib/auth/use-parent-identity', () => ({
    useParentIdentity: () => ({ parentId: 'p1', studentId: 'a1', studentName: 'Ada', ready: true, children: [] }),
}));
vi.mock('@/lib/auth/use-child-school-type', () => ({
    useChildSchoolType: () => ({ isPrimaria: false, ready: true, gradoScolastico: 'infanzia' }),
}));
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Errore' }));

let voci: unknown[] = [];

// Il primo argomento di `fetchConCache` è la chiave di cache (`diario:…`).
vi.mock('@/lib/offline/read-cache', () => ({
    fetchConCache: vi.fn(async (chiave: string) => (
        String(chiave).startsWith('diario:') ? { data: voci, offline: false } : { data: [], offline: false }
    )),
}));

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (String(url).startsWith('/api/diary/checkin')) {
            return { ok: true, status: 200, json: async () => ({ orario_entrata: null, stato: null }) };
        }
        return { ok: true, status: 200, json: async () => ({ media: [], total: 0 }) };
    }));
});

import ParentDiaryPage from '@/app/(dashboard)/parent/diary/page';

const attivita = (activities: unknown[]) => ({
    id: 'e1', tipo_evento: 'attivita', timestamp_evento: '2026-09-26T13:47:00.000Z',
    dettagli: { activities }, note: null, notaBambino: null,
});

describe('Diario del genitore in inglese — orario delle attività (D3, punto 1)', () => {
    it('inizio e fine → «from 10:00 to 11:00», solo inizio → «from …», solo fine → «until …», mai «dalle»', async () => {
        voci = [attivita([
            { tipo: 'pittura', descrizione: 'autumn theme', ora_inizio: '10:00', ora_fine: '11:00' },
            { tipo: 'musica', descrizione: 'circle songs', ora_inizio: '13:05' },
            { tipo: 'lettura', descrizione: 'a fairy tale', ora_fine: '12:30' },
        ])];
        render(<ParentDiaryPage />);

        // Ancora POSITIVA: la riga c'è ed è in inglese (etichetta dal catalogo en).
        const pittura = (await screen.findByText(/autumn theme/)).textContent ?? '';
        expect(pittura).toContain(enDiario.attivita_pittura);
        expect(pittura).toContain('from 10:00 to 11:00');
        expect(pittura).not.toContain('dalle');
        expect(pittura).not.toContain(itDiario.attivita_pittura);

        const musica = screen.getByText(/circle songs/).textContent ?? '';
        expect(musica).toContain('from 13:05');
        expect(musica).not.toContain('dalle');

        const lettura = screen.getByText(/a fairy tale/).textContent ?? '';
        expect(lettura).toContain('until 12:30');
        expect(lettura).not.toContain('fino alle');

        // In tutta la pagina nessuna parola italiana dell'orario.
        expect(document.body.textContent ?? '').not.toMatch(/dalle|fino alle/);
    });
});
