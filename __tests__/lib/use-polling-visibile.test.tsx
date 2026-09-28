import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * IL POLLING SI FERMA QUANDO NESSUNO GUARDA.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL DIFETTO, misurato il 7 settembre 2026. L'app è andata lenta per tutta la mattina: 427
 * famiglie collegate hanno prodotto **2.231.291 richieste a Supabase in un giorno**, 399.395
 * nella sola ora 11:00-12:00 contro le 21.099 dell'ora di punta del giorno prima. Non era il
 * database e non era Vercel: era il volume. E i fetch falliti per persona erano RADDOPPIATI —
 * 9,34 a testa contro i 3,58-3,65 dei giorni tranquilli, tutti con `stato_http = 0`, cioè
 * richieste che non arrivano nemmeno a destinazione.
 *
 * Dentro quel volume c'erano dieci orologi, tutti scritti a mano dentro il proprio componente, e
 * **nessuno guardava la visibilità della pagina**: un genitore fermo sulla chat faceva ~11
 * richieste al minuto senza toccare niente, e continuava a farle col telefono in tasca e lo
 * schermo spento.
 *
 * ⚠️ I DUE SEGNALI, e perché ce ne vogliono due. `document.hidden` è lo standard del web, ma
 * questa app gira anche dentro una WebView Capacitor, e su iOS non è dato per scontato che
 * `visibilitychange` scatti quando l'app va in secondo piano. Non lo si assume: si montano
 * ENTRAMBI i segnali — `visibilitychange` e `appStateChange` di `@capacitor/app` — così la
 * correttezza non dipende da quale dei due funzioni. Quale sia arrivato davvero lo dice la sonda
 * (evento `client:visibilita`), che risponde con un dato invece che con un'opinione.
 *
 * Il precedente che impone questa cautela è in `client.ts`: per 31 giorni il campo `piattaforma`
 * ha detto `web` per 3.625 eventi su 3.626, perché Capacitor NON si scrive nello user-agent e
 * qualcuno l'aveva dedotto invece di chiederlo al bridge.
 *
 * LA COALESCENZA non è un ornamento: i due segnali possono scattare per la STESSA ripresa, e su
 * Android è documentato (`BiometricGate.tsx:33-45`) che arrivi un `isActive:true` spurio perché
 * l'Activity del prompt biometrico è traslucida. Senza coalescenza sarebbero due fetch al posto
 * di uno — cioè il difetto che questo file esiste per togliere.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/* ── L'orologio nativo, con il registro dei suoi ascoltatori ─────────────────── */
const nativo = vi.hoisted(() => ({
    è: false,
    ascoltatori: new Map<string, (dato: { isActive: boolean }) => void>(),
    rimossi: 0,
}));

vi.mock('@capacitor/app', () => ({
    App: {
        addListener: vi.fn(async (evento: string, fn: (dato: { isActive: boolean }) => void) => {
            nativo.ascoltatori.set(evento, fn);
            return { remove: async () => { nativo.rimossi += 1; nativo.ascoltatori.delete(evento); } };
        }),
    },
}));

vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => nativo.è }));

const logClient = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logging/client', () => ({ logClient, nomeErrore: () => 'Error' }));

import { usePollingVisibile } from '@/lib/hooks/use-polling-visibile';

/* ── Attrezzi ────────────────────────────────────────────────────────────────── */

/** Impone lo stato di `document.hidden` e annuncia il cambiamento come fa il browser. */
function visibilita(nascosta: boolean) {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => nascosta });
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (nascosta ? 'hidden' : 'visible'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
}

/** Fa scattare `appStateChange` come farebbe la shell nativa. */
function statoApp(isActive: boolean) {
    nativo.ascoltatori.get('appStateChange')?.({ isActive });
}

/** Lascia girare le microtask: l'ascoltatore nativo si registra con un `await import`. */
async function lasciaRegistrare() {
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function avanza(ms: number) {
    act(() => { vi.advanceTimersByTime(ms); });
}

describe('usePollingVisibile', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        nativo.è = false;
        nativo.ascoltatori.clear();
        nativo.rimossi = 0;
        logClient.mockClear();
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('1. a pagina visibile il tick scatta al ritmo chiesto', () => {
        const tic = vi.fn();
        renderHook(() => usePollingVisibile(tic, 30_000));

        expect(tic, 'ha fatto un fetch al montaggio: il primo caricamento non è compito suo').not.toHaveBeenCalled();
        avanza(30_000);
        expect(tic).toHaveBeenCalledTimes(1);
        avanza(60_000);
        expect(tic).toHaveBeenCalledTimes(3);
    });

    it('2. a pagina NASCOSTA l\'orologio si ferma', () => {
        // ROSSO SE: si toglie il ramo che guarda `document.hidden`. È il cuore dell'intervento:
        // un telefono in tasca deve smettere di parlare.
        const tic = vi.fn();
        renderHook(() => usePollingVisibile(tic, 30_000));

        act(() => visibilita(true));
        avanza(30_000 * 3);

        expect(tic, 'il polling ha continuato a schermo spento').not.toHaveBeenCalled();
    });

    it('3. al ritorno il fetch è IMMEDIATO: chi torna non aspetta il tick', () => {
        // ROSSO SE: la ripresa si limita a riarmare l'orologio. Chi riapre l'app deve trovare i
        // dati freschi, non 30 secondi di roba vecchia.
        const tic = vi.fn();
        renderHook(() => usePollingVisibile(tic, 30_000));

        act(() => visibilita(true));
        avanza(60_000);
        expect(tic).not.toHaveBeenCalled();

        act(() => visibilita(false));
        expect(tic, 'il ritorno non ha aggiornato niente').toHaveBeenCalledTimes(1);

        // …e il ritmo riparte da lì
        avanza(30_000);
        expect(tic).toHaveBeenCalledTimes(2);
    });

    it('4. i due segnali per la STESSA ripresa fanno UN fetch solo', async () => {
        // ROSSO SE: si toglie la coalescenza. Su Android i due segnali arrivano davvero
        // entrambi, e senza questo il rimedio raddoppierebbe le richieste al risveglio.
        nativo.è = true;
        const tic = vi.fn();
        renderHook(() => usePollingVisibile(tic, 30_000));
        await lasciaRegistrare();

        act(() => { visibilita(true); statoApp(false); });
        avanza(60_000);
        expect(tic).not.toHaveBeenCalled();

        act(() => { visibilita(false); statoApp(true); });
        expect(tic, 'due segnali per una sola ripresa hanno prodotto due fetch').toHaveBeenCalledTimes(1);
    });

    it('4-bis. …anche se il secondo segnale arriva MOLTO dopo il primo', async () => {
        // ROSSO SE: si toglie la coalescenza STRUTTURALE (`primoPiano === inPrimoPiano`) e si
        // resta con la sola finestra di tempo.
        //
        // Il test 4 qui sopra NON basta, e la prova è che con quella manomissione restava verde:
        // là i due segnali arrivano nello stesso istante, quindi a fermare il secondo fetch
        // bastava la finestra dei 1.000 ms. Le due cinture sono ridondanti per costruzione, e un
        // test che non le separa non misura nessuna delle due.
        //
        // Qui il secondo segnale arriva 2 secondi dopo — fuori dalla finestra — ed è il caso
        // vero: su Android l'`isActive:true` spurio dell'Activity traslucida non è sincrono con
        // `visibilitychange`.
        nativo.è = true;
        const tic = vi.fn();
        renderHook(() => usePollingVisibile(tic, 30_000));
        await lasciaRegistrare();

        act(() => { visibilita(true); statoApp(false); });
        act(() => visibilita(false));
        expect(tic).toHaveBeenCalledTimes(1);

        avanza(2_000); // oltre FINESTRA_COALESCENZA_MS
        act(() => statoApp(true));

        expect(tic, 'un secondo segnale in ritardo ha prodotto un fetch di troppo').toHaveBeenCalledTimes(1);
    });

    it('5. `intervalloNascostoMs` RALLENTA invece di fermare', () => {
        // È il caso di `useUnreadNotifications`, che quando la pagina non è a fuoco è l'unico a
        // mandare la notifica del browser: spegnerlo spegnerebbe la funzione che vive lì.
        const tic = vi.fn();
        renderHook(() => usePollingVisibile(tic, 30_000, { intervalloNascostoMs: 300_000 }));

        act(() => visibilita(true));
        avanza(120_000);
        expect(tic, 'ha usato il ritmo veloce da nascosto').not.toHaveBeenCalled();

        avanza(180_000); // in tutto 300 s
        expect(tic, 'il ritmo lento non è scattato').toHaveBeenCalledTimes(1);
    });

    it('6. `attivo: false` non arma niente', () => {
        const tic = vi.fn();
        renderHook(() => usePollingVisibile(tic, 30_000, { attivo: false }));
        avanza(120_000);
        expect(tic).not.toHaveBeenCalled();
    });

    it('7. allo smontaggio non resta né timer né ascoltatore', async () => {
        nativo.è = true;
        const tic = vi.fn();
        const { unmount } = renderHook(() => usePollingVisibile(tic, 30_000));
        await lasciaRegistrare();
        expect(nativo.ascoltatori.size).toBe(1);

        unmount();
        await act(async () => { await Promise.resolve(); });

        avanza(120_000);
        expect(tic, 'un timer è sopravvissuto allo smontaggio').not.toHaveBeenCalled();
        expect(nativo.rimossi, 'l\'ascoltatore nativo non è stato rimosso').toBe(1);
    });

    it('8. su WEB `@capacitor/app` non viene MAI caricato', async () => {
        // ROSSO SE: si toglie il gate `isNativeApp()`. Sul web importare il plugin è lavoro
        // inutile a ogni montaggio di ogni orologio — e il repo ha già la funzione canonica.
        nativo.è = false;
        renderHook(() => usePollingVisibile(vi.fn(), 30_000));
        await lasciaRegistrare();

        expect(nativo.ascoltatori.size, 'il plugin nativo è stato caricato sul web').toBe(0);
    });

    it('9. la callback più fresca vince, e l\'orologio non riparte da capo', () => {
        // Oggi il timer di `locker/page.tsx` dipende da `activeTab` e `month`: a ogni cambio di
        // scheda l'orologio si ricrea e il conto riparte da zero. Con la callback in un ref il
        // ritmo resta quello, e a scattare è sempre l'ultima versione.
        const primo = vi.fn();
        const secondo = vi.fn();
        const { rerender } = renderHook(({ fn }) => usePollingVisibile(fn, 30_000), {
            initialProps: { fn: primo },
        });

        avanza(20_000);
        rerender({ fn: secondo });
        avanza(10_000); // 30 s dal montaggio, non dal rerender

        expect(primo, 'ha chiamato la callback vecchia').not.toHaveBeenCalled();
        expect(secondo, 'l\'orologio è ripartito da capo al cambio di callback').toHaveBeenCalledTimes(1);
    });

    it('10. LA SONDA: su nativo dice quale segnale è arrivato; su web tace', async () => {
        // Serve a rispondere con un dato alla domanda «`document.hidden` funziona nella WebView
        // iOS?». Due silenzi opposti non si distinguono: per questo la sonda parla ANCHE quando
        // tutto va bene, e non solo quando manca qualcosa.
        // Modulo FRESCO: la sonda tiene il conto per sessione di pagina, e le prove precedenti
        // l'hanno già consumata. Senza questo, il test misurerebbe l'ordine di esecuzione.
        vi.resetModules();
        const { usePollingVisibile: hook } = await import('@/lib/hooks/use-polling-visibile');
        nativo.è = true;
        renderHook(() => hook(vi.fn(), 30_000));
        await lasciaRegistrare();

        act(() => visibilita(true));
        expect(logClient).toHaveBeenCalledTimes(1);
        expect(logClient.mock.calls[0][0]).toMatchObject({ evento: 'visibilita' });
        expect(logClient.mock.calls[0][0].messaggio).toContain('visibilitychange');

        act(() => statoApp(false));
        expect(logClient, 'il secondo segnale non è stato registrato').toHaveBeenCalledTimes(2);
        expect(logClient.mock.calls[1][0].messaggio).toContain('appStateChange');

        // e non si ripete: una riga per segnale, per sessione di pagina
        act(() => { visibilita(false); visibilita(true); statoApp(true); statoApp(false); });
        expect(logClient, 'la sonda si ripete a ogni evento').toHaveBeenCalledTimes(2);
    });

    it('11. `intervalloMs: null` = SOLO al ritorno: nessun orologio, ma chi riapre trova i dati freschi', async () => {
        // È il caso del diario del genitore (2026-09-28). La pagina caricava le voci una volta sola,
        // all'apertura: chi la lasciava aperta al mattino e riapriva l'app nel pomeriggio leggeva
        // ancora «La maestra non ha ancora compilato il diario», con le voci già in archivio. Un
        // orologio lì sarebbe volume senza bisogno — il difetto del 7 settembre —, il ritorno invece
        // è proprio il momento in cui il dato vecchio mente.
        // ROSSO SE: `null` arma comunque un timer (con un `setInterval(fn, null)` il browser spara a
        // raffica), oppure se il ritorno non esegue più la callback.
        nativo.è = true;
        const tic = vi.fn();
        renderHook(() => usePollingVisibile(tic, null));
        await lasciaRegistrare();

        avanza(3_600_000);
        expect(tic, 'con `null` è partito un orologio a pagina visibile').not.toHaveBeenCalled();

        act(() => { visibilita(true); statoApp(false); });
        avanza(3_600_000);
        expect(tic, 'con `null` è partito un orologio a pagina nascosta').not.toHaveBeenCalled();

        act(() => { visibilita(false); statoApp(true); });
        expect(tic, 'il ritorno non ha ricaricato, o i due segnali hanno ricaricato due volte').toHaveBeenCalledTimes(1);

        avanza(3_600_000);
        expect(tic, 'dopo il ritorno è partito un orologio').toHaveBeenCalledTimes(1);
    });

    it('12. `ritentaDopoMs`: un ritorno FALLITO si riprova UNA volta, e basta', async () => {
        // Misurato il 2026-09-28 in `app_log`: in 14 giorni la sola lettura del diario è
        // fallita a stato 0 («Failed to fetch» / «Load failed») 967 volte, per ~220 utenti. Un
        // ritorno nell'app con una prova sola lascia quel genitore sulla pagina vecchia fino
        // alla riapertura dopo.
        // ROSSO SE: una callback che risponde `false` non viene riprovata, se viene riprovata
        // prima del tempo, o se il secondo `false` innesca un terzo giro.
        const tic = vi.fn(async () => false);
        renderHook(() => usePollingVisibile(tic, null, { ritentaDopoMs: 4_000 }));

        act(() => visibilita(true));
        act(() => visibilita(false));
        await act(async () => { await Promise.resolve(); });
        expect(tic).toHaveBeenCalledTimes(1);

        avanza(3_999);
        expect(tic, 'il secondo tentativo è partito prima del tempo').toHaveBeenCalledTimes(1);
        avanza(1);
        expect(tic, 'il ritorno fallito non è stato riprovato').toHaveBeenCalledTimes(2);

        await act(async () => { await Promise.resolve(); });
        avanza(60_000);
        expect(tic, 'dopo il secondo fallimento è partito un terzo giro').toHaveBeenCalledTimes(2);
    });

    it('13. `ritentaDopoMs`: niente secondo tentativo se è andata bene, se la pagina è tornata nascosta o se è smontata', async () => {
        // ROSSO SE: si riprova anche dopo un successo (volume senza bisogno), a telefono in tasca,
        // o dopo lo smontaggio (una lettura che scrive su un componente che non c'è più).
        const riuscita = vi.fn(async () => true);
        const { unmount: smontaRiuscita } = renderHook(() => usePollingVisibile(riuscita, null, { ritentaDopoMs: 4_000 }));
        act(() => { visibilita(true); visibilita(false); });
        await act(async () => { await Promise.resolve(); });
        avanza(10_000);
        expect(riuscita, 'è stato riprovato un ritorno andato bene').toHaveBeenCalledTimes(1);
        smontaRiuscita();

        const nascosta = vi.fn(async () => false);
        const { unmount: smontaNascosta } = renderHook(() => usePollingVisibile(nascosta, null, { ritentaDopoMs: 4_000 }));
        act(() => { visibilita(true); visibilita(false); });
        await act(async () => { await Promise.resolve(); });
        act(() => visibilita(true));
        avanza(10_000);
        expect(nascosta, 'il secondo tentativo è partito a pagina nascosta').toHaveBeenCalledTimes(1);
        smontaNascosta();

        act(() => visibilita(false));
        const smontata = vi.fn(async () => false);
        const { unmount } = renderHook(() => usePollingVisibile(smontata, null, { ritentaDopoMs: 4_000 }));
        act(() => { visibilita(true); visibilita(false); });
        await act(async () => { await Promise.resolve(); });
        unmount();
        avanza(10_000);
        expect(smontata, 'il secondo tentativo è partito dopo lo smontaggio').toHaveBeenCalledTimes(1);
    });
});
