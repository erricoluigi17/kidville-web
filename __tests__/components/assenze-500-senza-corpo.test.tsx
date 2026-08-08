import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

// =============================================================================
// R17 del quinto collaudo — IL 500 SENZA CORPO, sulle DUE porte della stessa funzione.
//
// Quando il server risponde con un errore e NESSUN corpo — il 500 vuoto che Next produce
// per un handler che non restituisce una Response (misurato in produzione:
// `Transfer-Encoding: chunked`, zero byte), un 502/504 di proxy, una risposta troncata —
// `await r.json()` LANCIA. L'eccezione saltava al `catch` esterno, che è scritto per la
// RETE CADUTA: a schermo compariva il messaggio di un altro guasto e nel log finiva
// `invio-non-riuscito` con `stato` indefinito. Il numero di stato — l'unica cosa rimasta
// quando il corpo non c'è — veniva buttato via un istante dopo essere stato in mano al
// codice.
//
// Qui la risposta NON è finta: è una `Response` vera con corpo vuoto, così a lanciare è
// il meccanismo reale e non un mock che lo imita.
//
// Le due schermate si misurano INSIEME di proposito: la stessa forma viveva copiata in
// quattro punti, ed è la quarta volta in questo ciclo che un rimedio resta nel file in
// cui il difetto è stato misurato.
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
        parentPrimaria: (await import('../../messages/it/parentPrimaria.json')).default,
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
import { ComunicaAssenzaCard } from '@/components/features/parent/ComunicaAssenzaCard';
import itPrimaria from '../../messages/it/parentPrimaria.json';

const fetchMock = vi.fn();

/** La GET dell'elenco: buona e vuota, così il modulo si monta pulito. */
const elencoVuoto = {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { comunicate: [], comunicateLette: true } }),
};

/** La risposta VERA del guasto: 500 e zero byte. `json()` lancia davvero. */
const cinquecentoVuota = () => new Response('', { status: 500 });

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-11T08:00:00Z'));
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
        (init?.method ?? 'GET') === 'GET' ? Promise.resolve(elencoVuoto) : Promise.resolve(cinquecentoVuota()),
    );
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

/** L'ultima riga di log emessa, come oggetto. */
function ultimaRiga(): Record<string, unknown> {
    return logClient.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe('/parent/attendance — un 500 senza corpo non si traveste da rete caduta', () => {
    it('la riga di log porta lo stato 500 e dice che il server ha RESPINTO', async () => {
        render(<ParentAttendancePage />);
        const giorno = (await screen.findByLabelText(/giorno/i)) as HTMLInputElement;
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        logClient.mockClear();

        fireEvent.change(giorno, { target: { value: '2026-08-20' } });
        fireEvent.submit(giorno.closest('form')!);

        await waitFor(() => expect(logClient).toHaveBeenCalled());
        const riga = ultimaRiga();
        expect(
            riga.stato,
            'lo status è andato perso: il rifiuto del server è indistinguibile da una rete caduta',
        ).toBe(500);
        expect(String(riga.messaggio)).toMatch(/respinta/i);
        // La frase del ramo «rete caduta» parla di una POST che non è mai partita: qui
        // era partita eccome, e il server ha risposto.
        expect(String(riga.messaggio)).not.toMatch(/non inviata/i);
        expect(riga.route).toBe('/parent/attendance');
    });

    it('nessun dato del modulo entra nella riga di log (il motivo è un dato sanitario)', async () => {
        render(<ParentAttendancePage />);
        const giorno = (await screen.findByLabelText(/giorno/i)) as HTMLInputElement;
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());

        const motivo = screen.getByLabelText(/motivo/i);
        fireEvent.change(motivo, { target: { value: 'varicella con febbre alta' } });
        fireEvent.change(giorno, { target: { value: '2026-08-20' } });
        fireEvent.submit(giorno.closest('form')!);

        await waitFor(() => expect(logClient).toHaveBeenCalled());
        expect(JSON.stringify(logClient.mock.calls)).not.toContain('varicella');
    });
});

describe('ComunicaAssenzaCard — la porta gemella si comporta allo stesso modo', () => {
    it('la riga di log porta lo stato 500 e dice che il corpo non c\'era', async () => {
        render(<ComunicaAssenzaCard studentId="s-1" parentId="p-1" />);
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaApri }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        logClient.mockClear();

        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaInvia }));

        await waitFor(() => expect(logClient).toHaveBeenCalled());
        const riga = ultimaRiga();
        expect(riga.stato, 'lo status del rifiuto è stato buttato via').toBe(500);
        expect(String(riga.messaggio)).toMatch(/invio-respinto/);
        // Prima della correzione qui usciva `invio-non-riuscito`, cioè il nome del
        // guasto sbagliato: chi indaga dal log non sapeva nemmeno che il server avesse
        // risposto.
        expect(String(riga.messaggio)).not.toMatch(/invio-non-riuscito/);
    });

    it('a schermo compare comunque un messaggio (il modulo non resta muto)', async () => {
        render(<ComunicaAssenzaCard studentId="s-1" parentId="p-1" />);
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaApri }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());

        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaInvia }));

        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
        expect(screen.getByRole('alert')).toHaveTextContent(itPrimaria.comunicaNonRiuscita);
    });
});
