import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

// =============================================================================
// T6 · T12 · T34 del terzo collaudo — le tre cose che restavano nel modulo
//
//  · **T34** su iOS il selettore data nativo NON rispetta `min`: il calendario di
//    WebKit lascia scegliere ieri. Misurato dal tester mobile sulle due
//    piattaforme: su Android il `min` è rispettato (31 giorni, 7 disabilitati),
//    su iOS no. Il commento sopra al campo dichiarava un pavimento che esisteva
//    su una piattaforma sola, e l'unico rifiuto arrivava dal server.
//  · **T6** la validazione nativa del browser parla la lingua del BROWSER: un
//    genitore con il telefono in inglese leggeva «Value must be … or later»
//    dentro un'app italiana, in una bolla che nessuno stile può toccare.
//  · **T12** il `catch` che copre l'INVIO non logga niente. È il gesto centrale
//    della funzione: se la POST fallisce per rete, CORS, service worker o
//    certificato, il genitore legge «problema di rete» e nessuno ne sa niente.
//    È la stessa forma del guasto che questo progetto ha già pagato con le email
//    — un `403` registrato senza il corpo che diceva perché.
// =============================================================================

const stub = vi.hoisted(() => ({
    pathname: '/parent/attendance',
    params: new URLSearchParams(),
    router: { push: () => {}, replace: () => {}, refresh: () => {} },
}));

vi.mock('next-intl', async () => {
    const { createTranslator } = await import('use-intl');
    const messaggi = {
        parentServizi: (await import('../../messages/it/parentServizi.json')).default,
        parentAssenze: (await import('../../messages/it/parentAssenze.json')).default,
        shared: (await import('../../messages/it/shared.json')).default,
        common: (await import('../../messages/it/common.json')).default,
    };
    const traduttore = (ns?: string) =>
        createTranslator({
            locale: 'it',
            messages: messaggi as never,
            namespace: ns as never,
            onError: () => {},
            getMessageFallback: ({ namespace, key }: { namespace?: string; key: string }) =>
                namespace ? `${namespace}.${key}` : key,
        });
    return {
        useTranslations: (ns?: string) => traduttore(ns),
        useLocale: () => 'it',
        useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    };
});

vi.mock('next/navigation', () => ({
    usePathname: () => stub.pathname,
    useSearchParams: () => stub.params,
    useRouter: () => stub.router,
}));

vi.mock('@/lib/auth/use-parent-identity', () => ({
    useParentIdentity: () => ({ parentId: 'p-1', studentId: 's-1', figliIds: ['s-1'], ready: true }),
}));

const logClient = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logging/client', () => ({
    logClient: (...a: unknown[]) => logClient(...a),
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'Errore'),
}));

import ParentAttendancePage from '@/app/(dashboard)/parent/attendance/page';
import shared from '../../messages/it/shared.json';

const fetchMock = vi.fn();

/** La GET dell'elenco: risposta buona e vuota, così la pagina si monta pulita. */
const elencoVuoto = {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { comunicate: [], comunicateLette: true } }),
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    // Un martedì qualunque, alle 10 di Roma: «oggi» non è ambiguo.
    vi.setSystemTime(new Date('2026-08-11T08:00:00Z'));
    fetchMock.mockResolvedValue(elencoVuoto);
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

/** Monta la pagina e aspetta che il modulo sia pronto (l'elenco è già letto). */
async function apriModulo() {
    render(<ParentAttendancePage />);
    const giorno = await screen.findByLabelText(/giorno/i);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fetchMock.mockClear();
    return giorno as HTMLInputElement;
}

describe('il modulo non si fida della validazione nativa (T6 · T34)', () => {
    it('un giorno passato è rifiutato QUI, senza chiamare il server', async () => {
        const giorno = await apriModulo();
        fireEvent.change(giorno, { target: { value: '2026-08-10' } });
        fireEvent.submit(giorno.closest('form')!);

        await screen.findByText(shared.erroreAssenzaDataPassata);
        // La prova che conta: nessuna POST. Su iOS il calendario lascia scegliere
        // ieri, e senza questa guardia il rifiuto costava un viaggio al server —
        // e arrivava con una frase che parlava «di questo momento».
        const post = fetchMock.mock.calls.filter((c) => (c[1] as { method?: string })?.method === 'POST');
        expect(post, 'il giorno passato non deve raggiungere il server').toHaveLength(0);
    });

    it('il modulo dichiara `noValidate`: la frase è dell’app, non del browser', async () => {
        const giorno = await apriModulo();
        const form = giorno.closest('form')!;
        // Senza `noValidate` il browser blocca il submit PRIMA di `handleSubmit` e
        // mostra una bolla nella lingua del browser: la nostra frase non comparirebbe
        // mai, e in inglese l'app parlerebbe inglese in mezzo all'italiano.
        expect(form.hasAttribute('noValidate')).toBe(true);
    });

    it('oggi passa: il confine è «da oggi in avanti», non «da domani»', async () => {
        const giorno = await apriModulo();
        fireEvent.change(giorno, { target: { value: '2026-08-11' } });
        fireEvent.submit(giorno.closest('form')!);

        await waitFor(() => {
            const post = fetchMock.mock.calls.filter((c) => (c[1] as { method?: string })?.method === 'POST');
            expect(post.length, 'oggi deve poter essere comunicato').toBeGreaterThan(0);
        });
        expect(screen.queryByText(shared.erroreAssenzaDataPassata)).toBeNull();
    });
});

describe('il catch dell’invio non è più muto (T12)', () => {
    it('una POST che non parte lascia una riga di log, non solo una frase a schermo', async () => {
        const giorno = await apriModulo();
        fireEvent.change(giorno, { target: { value: '2026-08-20' } });
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        fireEvent.submit(giorno.closest('form')!);

        await waitFor(() => expect(logClient).toHaveBeenCalled());
        const riga = logClient.mock.calls.at(-1)?.[0] as Record<string, unknown>;
        expect(riga.route).toBe('/parent/attendance');
        expect(String(riga.messaggio)).toMatch(/comunicazione assenza non inviata/i);
        // Il TIPO dell'errore serve a distinguere rete caduta da CORS da service
        // worker; il MESSAGGIO no, e questo canale finisce in `app_log` per 30
        // giorni. Il motivo dell'assenza non deve poterci entrare mai.
        expect(String(riga.messaggio)).toContain('TypeError');
        expect(JSON.stringify(riga)).not.toContain('Failed to fetch');
    });
});
