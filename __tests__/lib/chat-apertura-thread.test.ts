/**
 * IL TOCCO SU UNA NOTIFICA DI CHAT, NEL BROWSER (parte C, 2026-09-15).
 *
 * `src/lib/chat/apertura-thread.ts` è il pezzo che tiene insieme la regola pura
 * (`instradaLinkNotifica`) e la pagina chat montata:
 *  · se si è già su una pagina chat e QUELLA PAGINA ASCOLTA, la conversazione si apre con un evento
 *    `window` — niente navigazione: in Next 16 una push allo stesso URL non cambia `searchParams` e
 *    non rimonta la pagina, quindi il ritocco della stessa notifica non aprirebbe niente;
 *  · se nessuna pagina ascolta (l'URL dice chat ma la pagina non ha ancora montato l'ascoltatore), si
 *    naviga al link con `?thread=`, che la pagina legge al montaggio. È il posto di una «casella di
 *    posta» con scadenza: niente richieste che restano in giro e aprono una chat a sorpresa dopo;
 *  · un link che non è di questa app non apre niente, e lo si registra — senza l'URL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ logClient: vi.fn() }));
vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}));

import {
    EVENTO_APRI_THREAD,
    apriLinkNotifica,
    ascoltaAperturaThread,
    richiediAperturaThread,
} from '@/lib/chat/apertura-thread';

const T = 'dddddddd-0000-4000-8000-000000000014';
const U = 'aaaaaaaa-0000-4000-8000-000000000011';

/** Gli ascoltatori aperti nel test: si chiudono tutti dopo, altrimenti il contatore di modulo resta sporco. */
const aperti: Array<() => void> = [];
function ascolta(gestore = vi.fn()) {
    aperti.push(ascoltaAperturaThread(gestore));
    return gestore;
}

const suPagina = (percorso: string) => window.history.replaceState(null, '', percorso);

beforeEach(() => {
    h.logClient.mockClear();
});

afterEach(() => {
    while (aperti.length) aperti.pop()!();
    suPagina('/');
});

describe('richiediAperturaThread — c’è una pagina chat che ascolta?', () => {
    it('nessuna pagina ascolta: risponde false e non emette niente', () => {
        const spia = vi.fn();
        window.addEventListener(EVENTO_APRI_THREAD, spia);
        try {
            expect(richiediAperturaThread(T)).toBe(false);
            expect(spia).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener(EVENTO_APRI_THREAD, spia);
        }
    });

    it('una pagina ascolta: risponde true e la conversazione le arriva, in forma canonica', () => {
        const gestore = ascolta();
        expect(richiediAperturaThread(T)).toBe(true);
        expect(richiediAperturaThread(T.toUpperCase())).toBe(true);
        expect(gestore.mock.calls).toEqual([[T], [T]]);
    });

    it('smontata la pagina, non ascolta più nessuno', () => {
        const gestore = vi.fn();
        const smetti = ascoltaAperturaThread(gestore);
        smetti();
        expect(richiediAperturaThread(T)).toBe(false);
        expect(gestore).not.toHaveBeenCalled();
        // Due chiusure della stessa sottoscrizione non portano il conto sotto zero.
        smetti();
        ascolta(gestore);
        expect(richiediAperturaThread(T)).toBe(true);
    });

    it('monta, smonta e rimonta (React in sviluppo lo fa apposta): si ascolta ancora', () => {
        const gestore = vi.fn();
        ascoltaAperturaThread(gestore)();
        ascolta(gestore);
        expect(richiediAperturaThread(T)).toBe(true);
        expect(gestore).toHaveBeenCalledTimes(1);
    });

    it('un id che non è un id non parte, e un evento con un dettaglio sbagliato non apre niente', () => {
        const gestore = ascolta();
        expect(richiediAperturaThread('abc')).toBe(false);
        window.dispatchEvent(new CustomEvent(EVENTO_APRI_THREAD, { detail: { threadId: 'abc' } }));
        window.dispatchEvent(new CustomEvent(EVENTO_APRI_THREAD, { detail: null }));
        window.dispatchEvent(new Event(EVENTO_APRI_THREAD));
        expect(gestore).not.toHaveBeenCalled();
    });
});

describe('apriLinkNotifica — il tocco', () => {
    it('sulla pagina chat che ascolta: la conversazione si apre senza navigare', () => {
        suPagina('/parent/chat');
        const gestore = ascolta();
        const naviga = vi.fn();

        apriLinkNotifica(`/parent/chat?thread=${T}`, naviga);

        expect(gestore).toHaveBeenCalledWith(T);
        expect(naviga).not.toHaveBeenCalled();
        expect(h.logClient).not.toHaveBeenCalled();
    });

    it('sulla pagina chat che NON ascolta ancora: si naviga al link con ?thread=, nell’area in cui si è', () => {
        suPagina('/parent/chat');
        const naviga = vi.fn();
        apriLinkNotifica(`/parent/chat?thread=${T}`, naviga);
        expect(naviga).toHaveBeenCalledWith(`/parent/chat?thread=${T}`);

        suPagina('/teacher/chat');
        naviga.mockClear();
        apriLinkNotifica(`/parent/chat?thread=${T}&userId=${U}`, naviga);
        expect(naviga).toHaveBeenCalledWith(`/teacher/chat?thread=${T}&userId=${U}`);
    });

    it('fuori dalla chat si naviga, anche se un ascoltatore fosse rimasto appeso', () => {
        suPagina('/teacher/registro');
        const gestore = ascolta();
        const naviga = vi.fn();

        apriLinkNotifica(`/parent/chat?thread=${T}`, naviga);

        expect(naviga).toHaveBeenCalledWith(`/teacher/chat?thread=${T}`);
        expect(gestore).not.toHaveBeenCalled();
    });

    it('un link che non è di questa app non apre niente, e lo dice nel log senza l’URL', () => {
        suPagina('/parent/chat');
        const gestore = ascolta();
        const naviga = vi.fn();

        apriLinkNotifica('//evil.example/parent/chat?thread=' + T, naviga);
        apriLinkNotifica('/\t/evil.example', naviga);

        expect(naviga).not.toHaveBeenCalled();
        expect(gestore).not.toHaveBeenCalled();
        expect(h.logClient).toHaveBeenCalledTimes(2);
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'warn', evento: 'push', messaggio: 'notifica-link-rifiutato: non interno' }),
        );
        const scritto = JSON.stringify(h.logClient.mock.calls);
        expect(scritto).not.toContain('evil');
        expect(scritto).not.toContain(T);
    });

    it('un link qualunque di questa app: si naviga, com’è', () => {
        suPagina('/parent');
        const naviga = vi.fn();
        apriLinkNotifica('/parent/avvisi', naviga);
        expect(naviga).toHaveBeenCalledWith('/parent/avvisi');
        expect(h.logClient).not.toHaveBeenCalled();
    });
});
