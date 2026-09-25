/**
 * `NativePushAutoRegister`: UN NUOVO TENTATIVO QUANDO L'APP TORNA IN PRIMO PIANO (PC2, 2026-09-25).
 *
 * Prima il tentativo era UNO per vita della pagina: se falliva, il telefono restava fuori da
 * `push_subscriptions` fino al prossimo avvio a freddo — per chi non chiude mai l'app, giorni senza
 * notifiche. Qui si prova la politica intera: si riprova SOLO dopo un fallimento che può guarire, mai
 * a raffica (intervallo, un tentativo alla volta, tetto per sessione), mai dopo un esito definitivo o
 * una scelta dell'utente, e mai dopo il logout.
 *
 * Il codice di prima è ROSSO su ogni caso «si riprova»: non ascoltava il ritorno in primo piano.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

const h = vi.hoisted(() => ({
    identita: { userId: null as string | null, ready: false },
    registerNativePush: vi.fn(),
    statoPermessoPush: vi.fn(),
    logClient: vi.fn(),
    /** Il gestore `resume` agganciato dal componente (ri-agganciato a ogni test: `__azzeraPerTest`). */
    resume: null as null | (() => void),
    appAddListener: vi.fn(),
    /** Il segnale nativo non si aggancia: il caso in cui il plugin non arriva. */
    appFallisce: false,
}));

vi.mock('@/lib/auth/use-session-identity', () => ({
    useSessionIdentity: () => ({ userId: h.identita.userId, role: 'parent', ready: h.identita.ready }),
}));
vi.mock('@/lib/push/native-register', () => ({
    isNativeApp: () => true,
    registerNativePush: h.registerNativePush,
    statoPermessoPush: h.statoPermessoPush,
}));
vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}));
vi.mock('@capacitor/app', () => ({
    App: {
        addListener: (evento: string, gestore: () => void) => {
            h.appAddListener(evento);
            if (h.appFallisce) return Promise.reject(new Error('plugin App non disponibile'));
            if (evento === 'resume') h.resume = gestore;
            return Promise.resolve({ remove: async () => undefined });
        },
    },
}));

import {
    INTERVALLO_RIPRESA_MS,
    NativePushAutoRegister,
    TENTATIVI_RIPRESA_MAX,
    __azzeraPerTest,
    suRitornoInPrimoPiano,
} from '@/components/providers/NativePushAutoRegister';

const U = '00000000-0000-4000-8000-0000000000a1';

let adesso = 1_000_000;
let orologio: ReturnType<typeof vi.spyOn>;

async function scorri() {
    await act(async () => {
        for (let k = 0; k < 10; k++) await Promise.resolve();
    });
}

/** Monta il componente con un utente autenticato e aspetta il PRIMO tentativo. */
async function montaConPrimoEsito(esito: unknown) {
    if (esito instanceof Error) h.registerNativePush.mockRejectedValueOnce(esito);
    else h.registerNativePush.mockResolvedValueOnce(esito);
    h.identita = { userId: U, ready: true };
    const r = render(<NativePushAutoRegister />);
    await scorri();
    expect(h.registerNativePush).toHaveBeenCalledTimes(1);
    return r;
}

/** Il tempo passa di `ms`. */
function avanza(ms: number) {
    adesso += ms;
}

/** Il ritorno in primo piano come lo vede il modulo, e quanto ha chiamato `registerNativePush`. */
async function ritorno() {
    await act(async () => {
        await suRitornoInPrimoPiano();
    });
    return h.registerNativePush.mock.calls.length;
}

function messaggi(): string[] {
    return h.logClient.mock.calls.map((c) => (c[0] as { messaggio: string }).messaggio);
}

beforeEach(() => {
    __azzeraPerTest();
    h.registerNativePush.mockReset();
    h.registerNativePush.mockResolvedValue({ ok: true });
    h.statoPermessoPush.mockReset();
    h.logClient.mockClear();
    h.appAddListener.mockClear();
    h.resume = null;
    h.appFallisce = false;
    adesso = 1_000_000;
    orologio = vi.spyOn(Date, 'now').mockImplementation(() => adesso);
});

/** `visibilityState` come lo vede il gestore: una proprietà PROPRIA del documento, tolta in afterEach. */
function visibilita(v: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
}

afterEach(() => {
    cleanup();
    orologio.mockRestore();
    // Torna il getter del prototipo: la proprietà ridefinita non deve passare agli altri test.
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
});

describe('NativePushAutoRegister — il ritorno in primo piano', () => {
    it('primo tentativo fallito (POST): al ritorno DOPO l’intervallo si riprova, e il recupero si scrive', async () => {
        await montaConPrimoEsito({ ok: false, error: 'subscribe_failed' });

        // Troppo presto: niente raffica.
        avanza(INTERVALLO_RIPRESA_MS - 1);
        expect(await ritorno()).toBe(1);

        avanza(1);
        expect(await ritorno()).toBe(2);
        expect(h.registerNativePush).toHaveBeenLastCalledWith(U);
        expect(messaggi()).toEqual(['push-nativa-ripresa: registrata al ritorno in primo piano']);
        expect(h.logClient.mock.calls[0][0]).toMatchObject({ livello: 'warn', evento: 'push', campi: { tentativi: 1 } });

        // Riuscito: non si riprova più, per quanti ritorni ci siano.
        avanza(INTERVALLO_RIPRESA_MS * 10);
        expect(await ritorno()).toBe(2);
    });

    it.each([
        ['registration_timeout', { ok: false, error: 'registration_timeout' }],
        ['plugin_error', { ok: false, error: 'plugin_error' }],
        ['promise rifiutata', new TypeError('x')],
    ])('dopo «%s» si riprova', async (_n, esito) => {
        await montaConPrimoEsito(esito);
        avanza(INTERVALLO_RIPRESA_MS);
        expect(await ritorno()).toBe(2);
    });

    it.each([
        ['riuscito', { ok: true }],
        ['plugin assente dal binario', { ok: false, error: 'plugin_unavailable' }],
        ['disattivata dall’utente', { ok: false, error: 'unregistered' }],
        ['non nativo', { ok: false, error: 'not_native' }],
        ['errore sconosciuto', { ok: false, error: 'qualcosa' }],
    ])('dopo «%s» NON si riprova', async (_n, esito) => {
        await montaConPrimoEsito(esito);
        avanza(INTERVALLO_RIPRESA_MS * 2);
        expect(await ritorno()).toBe(1);
        expect(h.statoPermessoPush).not.toHaveBeenCalled();
    });

    it('permesso negato: si registra solo quando il permesso è DIVENTATO granted (Impostazioni)', async () => {
        await montaConPrimoEsito({ ok: false, error: 'permission_denied' });

        h.statoPermessoPush.mockResolvedValueOnce('denied');
        avanza(INTERVALLO_RIPRESA_MS);
        expect(await ritorno(), 'con il permesso ancora negato si è chiamata la registrazione (una DELETE a ogni ritorno)').toBe(1);
        expect(h.statoPermessoPush).toHaveBeenCalledTimes(1);

        // Il controllo del permesso conta per l'intervallo: subito dopo non si richiede.
        h.statoPermessoPush.mockResolvedValueOnce('granted');
        expect(await ritorno()).toBe(1);
        expect(h.statoPermessoPush).toHaveBeenCalledTimes(1);

        avanza(INTERVALLO_RIPRESA_MS);
        expect(await ritorno()).toBe(2);
    });

    it('un tentativo alla volta: due segnali insieme (resume + visibilitychange) → UNA registrazione', async () => {
        await montaConPrimoEsito({ ok: false, error: 'subscribe_failed' });
        let chiudi!: (v: unknown) => void;
        h.registerNativePush.mockImplementationOnce(() => new Promise((r) => { chiudi = r; }));
        avanza(INTERVALLO_RIPRESA_MS);

        // Il segnale nativo e quello del documento, entrambi agganciati dal componente.
        expect(h.appAddListener).toHaveBeenCalledWith('resume');
        expect(h.resume).not.toBeNull();
        await act(async () => {
            h.resume!();
            visibilita('visible');
            document.dispatchEvent(new Event('visibilitychange'));
            for (let k = 0; k < 10; k++) await Promise.resolve();
        });
        expect(h.registerNativePush).toHaveBeenCalledTimes(2);

        // In volo: anche passato l'intervallo, niente seconda registrazione parallela.
        avanza(INTERVALLO_RIPRESA_MS);
        expect(await ritorno()).toBe(2);
        await act(async () => {
            chiudi({ ok: true });
            for (let k = 0; k < 10; k++) await Promise.resolve();
        });
    });

    it(`al massimo ${TENTATIVI_RIPRESA_MAX} tentativi per sessione; il tetto senza registrazione si scrive UNA volta, dopo l’esito`, async () => {
        await montaConPrimoEsito({ ok: false, error: 'subscribe_failed' });
        h.registerNativePush.mockResolvedValue({ ok: false, error: 'subscribe_failed' });
        for (let i = 0; i < TENTATIVI_RIPRESA_MAX - 1; i++) {
            avanza(INTERVALLO_RIPRESA_MS);
            await ritorno();
        }
        // Prima dell'ultimo esito il canale tace: non si annuncia un tetto che potrebbe non esserci.
        expect(messaggi()).toEqual([]);
        for (let i = 0; i < 4; i++) {
            avanza(INTERVALLO_RIPRESA_MS);
            await ritorno();
        }
        expect(h.registerNativePush).toHaveBeenCalledTimes(1 + TENTATIVI_RIPRESA_MAX);
        expect(messaggi()).toEqual([
            'push-nativa-ripresa: tetto raggiunto senza registrazione, si riprova al prossimo avvio',
        ]);
        expect(h.logClient.mock.calls[0][0]).toMatchObject({
            livello: 'warn',
            evento: 'push',
            campi: { tentativi: TENTATIVI_RIPRESA_MAX },
        });
    });

    it('se l’ULTIMO tentativo consentito riesce, parte solo «registrata», mai il tetto', async () => {
        await montaConPrimoEsito({ ok: false, error: 'subscribe_failed' });
        for (let i = 0; i < TENTATIVI_RIPRESA_MAX - 1; i++) {
            h.registerNativePush.mockResolvedValueOnce({ ok: false, error: 'registration_timeout' });
        }
        h.registerNativePush.mockResolvedValueOnce({ ok: true });
        for (let i = 0; i < TENTATIVI_RIPRESA_MAX + 2; i++) {
            avanza(INTERVALLO_RIPRESA_MS);
            await ritorno();
        }
        expect(h.registerNativePush).toHaveBeenCalledTimes(1 + TENTATIVI_RIPRESA_MAX);
        expect(messaggi()).toEqual(['push-nativa-ripresa: registrata al ritorno in primo piano']);
        expect(h.logClient.mock.calls[0][0]).toMatchObject({ campi: { tentativi: TENTATIVI_RIPRESA_MAX } });
    });

    it('il ripiego: senza il segnale `resume` il ritentativo parte da `visibilitychange` visibile, e il guasto si scrive', async () => {
        h.appFallisce = true;
        await montaConPrimoEsito({ ok: false, error: 'subscribe_failed' });
        await vi.waitFor(() =>
            expect(messaggi()).toContain('push-nativa-ripresa: segnale resume non agganciato (Error)'),
        );
        expect(h.appAddListener).toHaveBeenCalledWith('resume');
        expect(h.resume, 'il segnale nativo non doveva essere agganciato').toBeNull();
        avanza(INTERVALLO_RIPRESA_MS);

        // In background: nessun ritentativo.
        await act(async () => {
            visibilita('hidden');
            document.dispatchEvent(new Event('visibilitychange'));
            for (let k = 0; k < 10; k++) await Promise.resolve();
        });
        expect(h.registerNativePush).toHaveBeenCalledTimes(1);

        // Di nuovo visibile: il ritentativo parte SOLO da qui.
        await act(async () => {
            visibilita('visible');
            document.dispatchEvent(new Event('visibilitychange'));
            for (let k = 0; k < 10; k++) await Promise.resolve();
        });
        expect(h.registerNativePush).toHaveBeenCalledTimes(2);
        expect(h.registerNativePush).toHaveBeenLastCalledWith(U);
    });

    it('dopo il logout (componente smontato) il ritorno in primo piano non registra niente', async () => {
        const { unmount } = await montaConPrimoEsito({ ok: false, error: 'subscribe_failed' });
        unmount();
        avanza(INTERVALLO_RIPRESA_MS);
        expect(await ritorno()).toBe(1);
    });

    it('senza nessun tentativo iniziale (utente non autenticato) il ritorno non fa niente', async () => {
        h.identita = { userId: null, ready: true };
        render(<NativePushAutoRegister />);
        await scorri();
        avanza(INTERVALLO_RIPRESA_MS);
        expect(await ritorno()).toBe(0);
    });
});
