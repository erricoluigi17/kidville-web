/**
 * `useAperturaThreadRichiesta` DA SOLO: la coda delle richieste di apertura (parte C, 2026-09-15).
 *
 * Il test di pagina (`__tests__/pages/chat-apertura-da-notifica.test.tsx`) prova ciò che si vede con la
 * rete finta. Qui la conversazione è finta e `apriPerId` risponde a comando, per mettere in fila i casi
 * che su un telefono capitano di rado ma che, se sbagliati, bloccano per sempre l'apertura dalle notifiche
 * di quella pagina: un guasto inatteso, due tocchi ravvicinati, la pagina che si smonta a metà.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const h = vi.hoisted(() => ({ logClient: vi.fn() }));
vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}));
vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { useAperturaThreadRichiesta } from '@/components/features/chat/useAperturaThreadRichiesta';
import { richiediAperturaThread } from '@/lib/chat/apertura-thread';
import type { EsitoApertura, StatoThreads } from '@/components/features/chat/useConversazioneChat';

const B = '00000000-0000-4000-8000-0000000000b2';
const C = '00000000-0000-4000-8000-0000000000c3';

type Attesa = { id: string; risolvi: (e: EsitoApertura) => void; rompi: (e: unknown) => void };

function conversazioneFinta() {
    const stato = {
        selezione: 0,
        attese: [] as Attesa[],
    };
    const apriPerId = vi.fn(
        (id: string) =>
            new Promise<EsitoApertura>((risolvi, rompi) => {
                stato.attese.push({ id, risolvi, rompi });
            }),
    );
    const chat = (statoThreads: StatoThreads = 'pronto', threads: readonly unknown[] = []) => ({
        apriPerId,
        leggiSelezione: () => stato.selezione,
        statoThreads,
        threads,
    });
    return { stato, apriPerId, chat };
}

async function scorri() {
    await act(async () => {
        for (let k = 0; k < 10; k++) await Promise.resolve();
    });
}

/**
 * Chiude la prima apertura in volo per `id`.
 *
 * ⚠️ Un'apertura riuscita FA CRESCERE LA GENERAZIONE DELLA SELEZIONE, come il vero `apriPerId`: apre con
 * `apri`, e `apri` incrementa `selezioneRef` (useConversazioneChat). Fino al 2026-09-15 il finto non lo
 * faceva, e il caso «C mentre B si apre» era verde con e senza il difetto: nella pagina vera l'apertura di
 * B annullava C, come se l'utente avesse scelto a mano.
 */
async function concludi(stato: { selezione: number; attese: Attesa[] }, id: string, esito: EsitoApertura | Error) {
    const i = stato.attese.findIndex((a) => a.id === id);
    if (i < 0) throw new Error(`nessuna apertura in volo per ${id}`);
    const [a] = stato.attese.splice(i, 1);
    await act(async () => {
        if (esito instanceof Error) a.rompi(esito);
        else {
            if (esito === 'aperto') stato.selezione++;
            a.risolvi(esito);
        }
        for (let k = 0; k < 10; k++) await Promise.resolve();
    });
}

function monta(f: ReturnType<typeof conversazioneFinta>, iniziale = f.chat()) {
    const onAperta = vi.fn();
    const r = renderHook((p: { chat: ReturnType<typeof f.chat> }) => useAperturaThreadRichiesta(p.chat, { rotta: '/parent/chat', onAperta }), {
        initialProps: { chat: iniziale },
    });
    return { ...r, onAperta };
}

beforeEach(() => {
    h.logClient.mockClear();
});

afterEach(() => {
    window.history.replaceState(null, '', '/');
});

describe('useAperturaThreadRichiesta — la coda', () => {
    it('un guasto inatteso dentro l’apertura: UN log col nome della classe, parametro tolto, e la coda non resta bloccata', async () => {
        window.history.replaceState(null, '', `/parent/chat?thread=${B}`);
        const f = conversazioneFinta();
        const { onAperta, unmount } = monta(f);
        await scorri();
        expect(f.apriPerId).toHaveBeenCalledWith(B);

        await concludi(f.stato, B, new TypeError('Cannot read properties of null'));

        expect(h.logClient).toHaveBeenCalledTimes(1);
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({
                livello: 'error',
                evento: 'push',
                messaggio: 'chat-apertura-da-notifica: guasto (url)',
                route: '/parent/chat',
                campi: { error_code: 'TypeError' },
            }),
        );
        expect(JSON.stringify(h.logClient.mock.calls), 'il messaggio dell’errore è finito nel log').not.toContain('Cannot read');
        expect(window.location.search).toBe('');
        expect(onAperta).not.toHaveBeenCalled();

        // Il tocco dopo si apre ancora.
        act(() => {
            richiediAperturaThread(C);
        });
        await scorri();
        expect(f.apriPerId).toHaveBeenLastCalledWith(C);
        await concludi(f.stato, C, 'aperto');
        expect(onAperta).toHaveBeenCalledTimes(1);
        unmount();
    });

    it('la stessa conversazione chiesta dall’URL e dall’evento mentre si sta aprendo: UNA apertura', async () => {
        window.history.replaceState(null, '', `/parent/chat?thread=${B}`);
        const f = conversazioneFinta();
        const { unmount } = monta(f);
        await scorri();
        act(() => {
            richiediAperturaThread(B);
        });
        await scorri();
        expect(f.apriPerId).toHaveBeenCalledTimes(1);
        await concludi(f.stato, B, 'aperto');
        expect(f.apriPerId).toHaveBeenCalledTimes(1);
        unmount();
    });

    it('un tocco su C mentre B si sta aprendo: finita B si apre C, l’ultima richiesta vince', async () => {
        window.history.replaceState(null, '', `/parent/chat?thread=${B}`);
        const f = conversazioneFinta();
        const { onAperta, unmount } = monta(f);
        await scorri();
        act(() => {
            richiediAperturaThread(C);
        });
        await scorri();
        expect(f.apriPerId.mock.calls.map((c) => c[0])).toEqual([B]);

        await concludi(f.stato, B, 'aperto');
        expect(
            f.apriPerId.mock.calls.map((c) => c[0]),
            'l’apertura di B, fatta dalla coda, ha annullato la richiesta arrivata dopo come una scelta a mano',
        ).toEqual([B, C]);
        await concludi(f.stato, C, 'aperto');
        expect(onAperta).toHaveBeenCalledTimes(2);
        expect(h.logClient.mock.calls.map((c) => (c[0] as { messaggio: string }).messaggio)).toEqual([
            'chat-apertura-da-notifica: aperta (url)',
            'chat-apertura-da-notifica: aperta (evento)',
        ]);
        unmount();
    });

    it('un tocco su C mentre B si sta aprendo, poi una scelta a mano prima che C parta: vince la scelta', async () => {
        window.history.replaceState(null, '', `/parent/chat?thread=${B}`);
        const f = conversazioneFinta();
        const { onAperta, unmount } = monta(f);
        await scorri();
        act(() => {
            richiediAperturaThread(C);
        });
        await scorri();

        // Mentre B è in volo l'utente sceglie da sé: B finisce «annullato», e C (arrivata prima della scelta) non parte.
        f.stato.selezione++;
        await concludi(f.stato, B, 'annullato');
        expect(f.apriPerId.mock.calls.map((c) => c[0]), 'la notifica arrivata prima ha scavalcato la scelta fatta a mano').toEqual([B]);
        expect(onAperta).not.toHaveBeenCalled();
        unmount();
    });

    it('B finisce in «errore» mentre C aspetta: si apre C, e con la lista nuova B non riparte', async () => {
        window.history.replaceState(null, '', `/parent/chat?thread=${B}`);
        const f = conversazioneFinta();
        const { rerender, unmount } = monta(f);
        await scorri();
        act(() => {
            richiediAperturaThread(C);
        });
        await concludi(f.stato, B, 'errore');
        expect(f.apriPerId.mock.calls.map((c) => c[0])).toEqual([B, C]);
        await concludi(f.stato, C, 'aperto');

        rerender({ chat: f.chat('pronto', [{ id: 'lista-nuova' }]) });
        await scorri();
        expect(f.apriPerId.mock.calls.map((c) => c[0]), 'la richiesta superata è ripartita').toEqual([B, C]);
        unmount();
    });

    /**
     * Il ritocco della conversazione IN VOLO è l'ultima richiesta anche se non ne fa partire un'altra
     * (2026-09-15). Prima usciva e basta: C, chiesta prima, restava in coda e partiva finita B.
     */
    it.each([
        { esito: 'aperto', log: 'chat-apertura-da-notifica: aperta (url)', aperture: 1 },
        { esito: 'non-trovato', log: 'chat-apertura-da-notifica: non-trovata (url)', aperture: 0 },
    ] as const)('B, poi C, poi di nuovo B mentre B si sta aprendo: B finisce $esito e C non parte, l’ultima richiesta era B', async ({ esito, log, aperture }) => {
        window.history.replaceState(null, '', `/parent/chat?thread=${B}`);
        const f = conversazioneFinta();
        const { onAperta, unmount } = monta(f);
        await scorri();
        act(() => {
            richiediAperturaThread(C);
        });
        await scorri();
        act(() => {
            richiediAperturaThread(B);
        });
        await scorri();
        expect(f.apriPerId.mock.calls.map((c) => c[0]), 'il ritocco di B ne ha fatta partire una seconda').toEqual([B]);

        await concludi(f.stato, B, esito);
        expect(f.apriPerId.mock.calls.map((c) => c[0]), 'finita B è partita C, chiesta PRIMA dell’ultimo tocco').toEqual([B]);
        expect(onAperta).toHaveBeenCalledTimes(aperture);
        expect(h.logClient.mock.calls.map((c) => (c[0] as { messaggio: string }).messaggio)).toEqual([log]);
        expect(window.location.search).toBe('');
        unmount();
    });

    it('B, poi C, poi di nuovo B, e B finisce in «errore»: C non parte, e con la lista nuova si ritenta B', async () => {
        window.history.replaceState(null, '', `/parent/chat?thread=${B}`);
        const f = conversazioneFinta();
        const { rerender, onAperta, unmount } = monta(f);
        await scorri();
        act(() => {
            richiediAperturaThread(C);
        });
        await scorri();
        act(() => {
            richiediAperturaThread(B);
        });
        await scorri();

        await concludi(f.stato, B, 'errore');
        expect(f.apriPerId.mock.calls.map((c) => c[0]), 'dopo l’errore di B è partita C, chiesta prima dell’ultimo tocco').toEqual([B]);
        expect(window.location.search, 'B aspetta la lista: il parametro resta').toBe(`?thread=${B}`);

        rerender({ chat: f.chat('pronto', [{ id: 'lista-nuova' }]) });
        await scorri();
        expect(f.apriPerId.mock.calls.map((c) => c[0]), 'con la lista nuova non si è ritentata B').toEqual([B, B]);
        await concludi(f.stato, B, 'aperto');
        expect(f.apriPerId.mock.calls.map((c) => c[0]), 'aperta B, è partita C').toEqual([B, B]);
        expect(onAperta).toHaveBeenCalledTimes(1);
        unmount();
    });

    it('«errore» da sola: niente di nuovo finché non arriva una lista nuova, poi UN ritentativo', async () => {
        window.history.replaceState(null, '', `/parent/chat?thread=${B}`);
        const f = conversazioneFinta();
        const lista = [{ id: 'a' }];
        const { rerender, unmount } = monta(f, f.chat('pronto', lista));
        await scorri();
        await concludi(f.stato, B, 'errore');
        // Un rendering qualunque, con la STESSA lista: non è il momento.
        rerender({ chat: f.chat('pronto', lista) });
        await scorri();
        expect(f.apriPerId).toHaveBeenCalledTimes(1);
        expect(window.location.search).toBe(`?thread=${B}`);

        rerender({ chat: f.chat('pronto', [{ id: 'a' }, { id: 'b' }]) });
        await scorri();
        expect(f.apriPerId).toHaveBeenCalledTimes(2);
        unmount();
    });

    it('la pagina si smonta mentre l’apertura è in volo: né vista, né URL, né log', async () => {
        window.history.replaceState(null, '', `/parent/chat?thread=${B}`);
        const f = conversazioneFinta();
        const { onAperta, unmount } = monta(f);
        await scorri();
        unmount();
        await concludi(f.stato, B, 'aperto');
        expect(onAperta).not.toHaveBeenCalled();
        expect(h.logClient).not.toHaveBeenCalled();
        expect(window.location.search).toBe(`?thread=${B}`);
    });

    it('la lista si carica DOPO una scelta a mano: la richiesta arrivata prima non la scavalca', async () => {
        window.history.replaceState(null, '', `/parent/chat?thread=${B}`);
        const f = conversazioneFinta();
        const { rerender, onAperta, unmount } = monta(f, f.chat('errore'));
        await scorri();
        expect(f.apriPerId, 'senza lista a schermo non si chiede').not.toHaveBeenCalled();

        f.stato.selezione = 1; // «Nuova chat»: l'utente apre una conversazione da sé
        rerender({ chat: f.chat('pronto', [{ id: 'a' }]) });
        await scorri();

        expect(f.apriPerId).not.toHaveBeenCalled();
        expect(onAperta).not.toHaveBeenCalled();
        expect(window.location.search).toBe('');
        expect(h.logClient).not.toHaveBeenCalled();
        unmount();
    });
});
