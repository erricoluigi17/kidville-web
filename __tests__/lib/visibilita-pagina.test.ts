import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * I DUE SEGNALI DI VISIBILITÀ, IN UN MECCANISMO SOLO.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ ESISTE QUESTO MODULO. Il meccanismo — montare `visibilitychange` E
 * `appStateChange` di Capacitor, farli confluire in un punto, coalescerli — viveva dentro
 * `usePollingVisibile`, dove era nato. Dal 2026-10-12 serve anche al controllo della versione
 * del bundle (`ControlloVersione`), che al ritorno in primo piano chiede al server quale
 * rilascio stia servendo.
 *
 * Scriverne un secondo sarebbe stato il modo di farli divergere: due ascoltatori per lo stesso
 * evento, due idee diverse di quando una ripresa è «la stessa ripresa», e su Android il
 * `isActive:true` spurio del prompt biometrico (documentato in `BiometricGate.tsx`) contato una
 * volta da uno e due volte dall'altro. Il meccanismo è uno e si importa.
 *
 * ─── LA SONDA NON SCRIVE PIÙ (S7-D, 2026-10-12) ────────────────────────────────
 * La sonda «segnale di visibilità ricevuto» ha risposto alla sua domanda: nella WebView i due
 * segnali arrivano. Continuava a scrivere ~1.300 righe al giorno PER TIPO a livello `warn`, cioè
 * righe persistite in `app_log` per confermare ogni giorno un fatto già noto. Resta la riga che
 * dice qualcosa che non si sa: il bridge nativo che NON risponde.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

const nativo = vi.hoisted(() => ({
    è: false,
    /** `null` = `addListener` rifiuta (plugin assente, bridge muto). */
    funziona: true,
    ascoltatori: new Map<string, (dato: { isActive: boolean }) => void>(),
    rimossi: 0,
}));

vi.mock('@capacitor/app', () => ({
    App: {
        addListener: vi.fn(async (evento: string, fn: (dato: { isActive: boolean }) => void) => {
            if (!nativo.funziona) throw new Error('plugin assente');
            nativo.ascoltatori.set(evento, fn);
            return { remove: async () => { nativo.rimossi += 1; nativo.ascoltatori.delete(evento); } };
        }),
    },
}));

vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => nativo.è }));

const logClient = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logging/client', () => ({ logClient, nomeErrore: () => 'Error' }));

import { osservaVisibilita, type CambioVisibilita } from '@/lib/hooks/visibilita-pagina';

/** Impone `document.hidden` e annuncia il cambiamento come fa il browser. */
function visibilita(nascosta: boolean) {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => nascosta });
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (nascosta ? 'hidden' : 'visible'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
}

function statoApp(isActive: boolean) {
    nativo.ascoltatori.get('appStateChange')?.({ isActive });
}

/**
 * L'ascoltatore nativo si registra con un `await import` seguito da un `await addListener`:
 * sono più giri di microtask, e quanti esattamente dipende dal caricatore di moduli. Se ne
 * lasciano passare abbastanza invece di indovinarne il numero — e i test che seguono
 * verificano un EFFETTO (`rimossi`, le righe di log), quindi un giro di troppo non nasconde
 * niente.
 */
async function lasciaRegistrare() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('osservaVisibilita', () => {
    let cambi: CambioVisibilita[];
    let smonta: (() => void) | null;

    beforeEach(() => {
        vi.useFakeTimers();
        nativo.è = false;
        nativo.funziona = true;
        nativo.ascoltatori.clear();
        nativo.rimossi = 0;
        logClient.mockClear();
        cambi = [];
        smonta = null;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    });

    afterEach(() => {
        smonta?.();
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    function osserva() {
        smonta = osservaVisibilita((c) => cambi.push(c));
    }

    it('una ripresa vera arriva UNA volta, anche se parlano entrambi i segnali', async () => {
        // ROSSO SE: la coalescenza sparisce — allora il risveglio costa due giri invece di uno,
        // cioè il difetto che il meccanismo esiste per togliere.
        nativo.è = true;
        osserva();
        await lasciaRegistrare();

        visibilita(true);
        statoApp(false);
        expect(cambi.filter((c) => c.ripresa)).toHaveLength(0);

        visibilita(false);
        statoApp(true);
        expect(cambi.filter((c) => c.ripresa), 'la ripresa è stata contata due volte').toHaveLength(1);
    });

    it('ogni TRANSIZIONE si annuncia, anche quella verso lo sfondo', () => {
        osserva();
        visibilita(true);
        expect(cambi).toEqual([expect.objectContaining({ primoPiano: false, ripresa: false })]);
    });

    it('nessuna transizione ⇒ nessun annuncio', () => {
        osserva();
        visibilita(false); // era già visibile
        expect(cambi).toEqual([]);
    });

    it('`nascostaDaMs` misura quanto la pagina è stata nascosta', () => {
        // È il numero su cui `ControlloVersione` decide: una ricarica si permette solo dopo
        // un'assenza LUNGA, perché è lì che il bundle in mano può essere vecchio di deploy.
        osserva();
        visibilita(true);
        vi.advanceTimersByTime(20 * 60 * 1000);
        visibilita(false);

        const ripresa = cambi.find((c) => c.ripresa);
        expect(ripresa?.nascostaDaMs).toBe(20 * 60 * 1000);
    });

    it('due riprese nella stessa finestra di coalescenza non azzerano il conto dell\'assenza', () => {
        // ROSSO SE: lo sfarfallio visibile→nascosto→visibile dentro un secondo riporta
        // `nascostaDaMs` a ~0 — allora dopo un'ora in tasca basterebbe uno sfarfallio per far
        // sembrare l'app appena riaperta.
        osserva();
        visibilita(true);
        vi.advanceTimersByTime(30 * 60 * 1000);
        visibilita(false);
        const prima = cambi.find((c) => c.ripresa)?.nascostaDaMs;
        expect(prima).toBe(30 * 60 * 1000);
    });

    it('allo smontaggio stacca tutto: niente ascoltatori orfani', async () => {
        nativo.è = true;
        osserva();
        await lasciaRegistrare();
        smonta?.();
        smonta = null;

        expect(nativo.rimossi, "l'ascoltatore nativo è rimasto agganciato").toBe(1);
        visibilita(true);
        expect(cambi, 'il gestore del DOM è rimasto agganciato').toEqual([]);
    });

    it('smontato mentre l\'import è in volo: l\'ascoltatore nativo non resta appeso', async () => {
        nativo.è = true;
        osserva();
        smonta?.();
        smonta = null;
        await lasciaRegistrare();
        expect(nativo.rimossi).toBe(1);
    });

    it('S7-D: un segnale RICEVUTO non lascia nessuna riga in `app_log`', async () => {
        // ROSSO SE: la sonda torna a scrivere. Erano ~1.300 righe al giorno PER TIPO, a livello
        // `warn` (cioè persistite), per riconfermare ogni giorno che i due segnali arrivano.
        nativo.è = true;
        osserva();
        await lasciaRegistrare();

        visibilita(true);
        statoApp(false);
        visibilita(false);
        statoApp(true);

        expect(logClient).not.toHaveBeenCalled();
    });

    it('il bridge che NON risponde invece si logga: è l\'unica cosa che non si sa', async () => {
        // Questo è un `catch` che deve parlare (AGENTS, regola 6): senza `appStateChange` la
        // correttezza si regge sul solo `visibilitychange`, ed è esattamente il fatto su cui
        // nessuno ha una misura.
        nativo.è = true;
        nativo.funziona = false;
        osserva();
        await lasciaRegistrare();

        expect(logClient).toHaveBeenCalledTimes(1);
        expect(logClient.mock.calls[0][0]).toMatchObject({ evento: 'visibilita', livello: 'warn' });
        expect(logClient.mock.calls[0][0].messaggio).toContain('appStateChange');
    });

    it('su web non si aggancia niente di nativo', async () => {
        nativo.è = false;
        osserva();
        await lasciaRegistrare();
        expect(nativo.ascoltatori.size).toBe(0);
        expect(logClient).not.toHaveBeenCalled();
    });
});
