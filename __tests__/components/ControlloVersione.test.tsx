import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

/**
 * «QUESTA APP È FERMA A TRE DEPLOY FA» — il controllo della versione al ritorno in primo piano.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL FATTO. Un'app aperta sul telefono resta in memoria per giorni: nessuna navigazione dentro
 * una SPA sostituisce il bundle, e il codice che gira resta quello del deploy in cui la pagina
 * è stata caricata. Il genitore che riapre l'app lunedì mattina esegue il venerdì.
 *
 * LE QUATTRO COSE CHE QUESTO TEST TIENE FERME, e ciascuna ha un modo noto di diventare un danno:
 *
 *  1. SI CONTROLLA DI RADO. Solo al ritorno dopo un'assenza LUNGA, e non più di una volta ogni
 *     cinque minuti. Questo lavoro nasce da un picco di carico misurato (12/10: 11.327 richieste
 *     su `/rest/v1/pagamenti` in due ore): un controllo a ogni cambio di scheda sarebbe
 *     esattamente il difetto che sta venendo a chiudere.
 *  2. NON SI RICARICA SOTTO LE DITA DI NESSUNO. Un `location.reload()` mentre una maestra sta
 *     scrivendo una nota perde quello che ha scritto. Con un campo a fuoco la ricarica si RINVIA
 *     alla prossima navigazione, che è il momento in cui l'utente ha già lasciato quel modulo.
 *  3. MAI UN CICLO. Se la ricarica non porta il bundle nuovo (una cache del Service Worker che
 *     non si sposta), ricaricare di nuovo sarebbe un'app che lampeggia per sempre: la versione
 *     per cui si è già ricaricato si ricorda in `sessionStorage`.
 *  4. IN SVILUPPO NON FA NIENTE. Senza una versione cotta nel bundle non c'è niente da
 *     confrontare, e un'app che si ricarica da sola in sviluppo è insopportabile.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

const VERSIONE_IN_MANO = 'aaaaaaaaaaaa';
const VERSIONE_SERVITA = 'bbbbbbbbbbbb';

const finto = vi.hoisted(() => ({ bundle: 'aaaaaaaaaaaa' as string | null, percorso: '/parent/home' }));

vi.mock('@/lib/versione/deploy', () => ({
    get VERSIONE_BUNDLE() { return finto.bundle; },
}));

vi.mock('next/navigation', () => ({ usePathname: () => finto.percorso }));

// Web: nessun bridge Capacitor da importare. I due segnali e la loro coalescenza hanno i
// propri test in `__tests__/lib/visibilita-pagina.test.ts`; qui si usa il meccanismo VERO,
// guidato dagli eventi veri del DOM.
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => false }));

const logClient = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logging/client', () => ({
    logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}));

const QUINDICI_MINUTI = 15 * 60 * 1000;

let ricarica: ReturnType<typeof vi.fn>;
let rete: ReturnType<typeof vi.fn>;
let orologio: number;

/** La risposta normale di `GET /api/versione`. */
function corpoVersione(versione: string | null) {
    return { ok: true, status: 200, json: async () => ({ versione }) };
}

function visibilita(nascosta: boolean) {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => nascosta });
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (nascosta ? 'hidden' : 'visible'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
}

/** Un'assenza di `ms` e il ritorno, come il telefono messo in tasca e ripreso. */
async function assenzaDi(ms: number) {
    await act(async () => { visibilita(true); });
    orologio += ms;
    await act(async () => { visibilita(false); await Promise.resolve(); await Promise.resolve(); });
}

/**
 * Modulo FRESCO a ogni prova: il componente tiene di proposito la sua decisione nello stato di
 * MODULO (come `AvvisoAggiornamentoApp`), perché il doppio montaggio di StrictMode non la
 * raddoppi. Senza `resetModules` ogni prova erediterebbe l'ultimo controllo della precedente.
 */
async function monta({ attivo = true }: { attivo?: boolean } = {}) {
    vi.resetModules();
    const { ControlloVersione } = await import('@/components/providers/ControlloVersione');
    return render(<ControlloVersione attivo={attivo} />);
}

beforeEach(() => {
    finto.bundle = VERSIONE_IN_MANO;
    finto.percorso = '/parent/home';
    orologio = 1_760_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => orologio);
    logClient.mockClear();
    sessionStorage.clear();
    ricarica = vi.fn();
    Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, reload: ricarica, pathname: '/parent/home' },
    });
    rete = vi.fn(async () => corpoVersione(VERSIONE_SERVITA));
    vi.stubGlobal('fetch', rete);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function chiamateAllaRoute(): number {
    return rete.mock.calls.filter(([u]) => String(u).startsWith('/api/versione')).length;
}

describe('ControlloVersione — quando chiede', () => {
    it('al montaggio non chiede niente: non è un controllo all\'avvio', async () => {
        await monta();
        expect(chiamateAllaRoute()).toBe(0);
    });

    it('un\'assenza BREVE non fa chiedere niente', async () => {
        // ROSSO SE: il controllo parte a ogni ritorno. Un passaggio a WhatsApp e ritorno sono
        // decine di riprese al giorno per famiglia, e ognuna sarebbe una richiesta in più.
        await monta();
        await assenzaDi(QUINDICI_MINUTI - 1_000);
        expect(chiamateAllaRoute()).toBe(0);
        expect(ricarica).not.toHaveBeenCalled();
    });

    it('un\'assenza LUNGA fa chiedere al server quale versione serve', async () => {
        await monta();
        await assenzaDi(QUINDICI_MINUTI);
        expect(chiamateAllaRoute()).toBe(1);
    });

    it('DUE osservatori sulla stessa ripresa chiedono UNA volta', async () => {
        // A che serve il tetto di cinque minuti, dato che l'assenza minima è di quindici: non a
        // distanziare nel tempo (quello lo fa già l'assenza), ma a far valere UNA la stessa
        // ripresa vista da più montaggi — il doppio giro degli effetti di StrictMode, un layout
        // che si rimonta, un secondo albero montato da un test. Senza, ogni montaggio
        // aggiungerebbe una richiesta sulla stessa ripresa.
        // ROSSO SE: il tetto sparisce, o lo stato esce dal modulo e finisce nel componente.
        vi.resetModules();
        const { ControlloVersione } = await import('@/components/providers/ControlloVersione');
        render(<><ControlloVersione attivo /><ControlloVersione attivo /></>);

        await assenzaDi(QUINDICI_MINUTI);
        expect(chiamateAllaRoute()).toBe(1);
    });

    it('in sviluppo (nessuna versione cotta nel bundle) non chiede e non ricarica', async () => {
        finto.bundle = null;
        await monta();
        await assenzaDi(QUINDICI_MINUTI);
        expect(chiamateAllaRoute()).toBe(0);
        expect(ricarica).not.toHaveBeenCalled();
    });

    it('spento (`attivo: false`, la schermata di accesso) non chiede niente', async () => {
        await monta({ attivo: false });
        await assenzaDi(QUINDICI_MINUTI);
        expect(chiamateAllaRoute()).toBe(0);
    });
});

describe('ControlloVersione — che cosa fa della risposta', () => {
    it('stessa versione: niente, e nessuna riga di log', async () => {
        // Il silenzio è deliberato: una riga per ogni controllo andato bene sarebbe un evento
        // al giorno per famiglia per dire «tutto come prima» — vedi la sonda di S7-D.
        rete.mockImplementation(async () => corpoVersione(VERSIONE_IN_MANO));
        await monta();
        await assenzaDi(QUINDICI_MINUTI);

        expect(ricarica).not.toHaveBeenCalled();
        expect(logClient).not.toHaveBeenCalled();
    });

    it('`versione: null` (variabile non configurata): niente', async () => {
        rete.mockImplementation(async () => corpoVersione(null));
        await monta();
        await assenzaDi(QUINDICI_MINUTI);
        expect(ricarica).not.toHaveBeenCalled();
    });

    it('versione DIVERSA e nessun campo a fuoco: ricarica, e lo scrive', async () => {
        await monta();
        await assenzaDi(20 * 60 * 1000);

        expect(ricarica).toHaveBeenCalledTimes(1);
        expect(logClient).toHaveBeenCalledTimes(1);
        const riga = logClient.mock.calls[0][0];
        // `warn`: il canale del client persiste `warn` ed `error`, e questo è un evento da
        // CONTARE, non un guasto.
        expect(riga).toMatchObject({ livello: 'warn', evento: 'avvio' });
        expect(riga.campi).toMatchObject({
            esito: 'ricaricata',
            minuti_nascosta: 20,
            // La memoria dell'anti-ciclo è stata scritta: vedi la prova subito dopo per il caso
            // in cui il browser la rifiuta.
            anti_ciclo: true,
        });
        // Niente dati personali: la versione è uno sha di un repository pubblico, i minuti sono
        // un numero. E la versione sta nel MESSAGGIO perché l'impronta di `app_log` guarda lì
        // (lezione della #174): nei soli `campi` sparirebbe nella riga del primo del giorno.
        expect(riga.messaggio).toContain(VERSIONE_SERVITA);
    });

    it('la stessa versione non si ricarica due volte (anti-ciclo)', async () => {
        // ROSSO SE: l'antidoto al ciclo sparisce. Con una cache che non si sposta, l'app
        // ricaricherebbe, ritroverebbe il bundle vecchio e ricaricherebbe di nuovo: per sempre.
        sessionStorage.setItem('kv_versione_ricaricata', VERSIONE_SERVITA);
        await monta();
        await assenzaDi(QUINDICI_MINUTI);

        expect(ricarica).not.toHaveBeenCalled();
    });

    it('storage negato: ricarica comunque, e la riga dice che la memoria non c\'è', async () => {
        /**
         * Safari in navigazione privata, cookie di terze parti bloccati, quota piena: la
         * `setItem` lancia. La ricarica DEVE partire comunque — una ricarica in più è un
         * fastidio, un'app ferma a tre deploy fa è un guasto — ma senza memoria dell'anti-ciclo
         * la prossima riapertura ricaricherà di nuovo. Quel `anti_ciclo: false` è ciò che in
         * `app_log` distingue «browser in privata» da «abbiamo un ciclo».
         *
         * ⚠️ Questa prova esiste perché un lock l'ha chiesta: quel `catch` conteneva soltanto un
         * commento (`catch-muti-allowlist`, AGENTS.md regola 6). Il commento diceva la cosa
         * giusta a chi legge il codice e niente a chi legge i log.
         */
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('QuotaExceededError');
        });

        await monta();
        await assenzaDi(QUINDICI_MINUTI);

        expect(ricarica, 'non ha ricaricato perché lo storage ha detto no').toHaveBeenCalledTimes(1);
        expect(logClient.mock.calls[0][0].campi).toMatchObject({
            esito: 'ricaricata',
            anti_ciclo: false,
        });
    });

    it('la versione ricaricata si annota PRIMA di ricaricare', async () => {
        // Dopo `reload()` lo stato di modulo non esiste più: l'unica memoria possibile è quella
        // scritta prima.
        await monta();
        await assenzaDi(QUINDICI_MINUTI);
        expect(sessionStorage.getItem('kv_versione_ricaricata')).toBe(VERSIONE_SERVITA);
    });
});

describe('ControlloVersione — non ricarica sotto le dita di nessuno', () => {
    /**
     * I campi creati qui, per poterli togliere.
     *
     * ⚠️ NON È PULIZIA DI CORTESIA. `cleanup` di Testing Library smonta il proprio contenitore,
     * non un `<input>` appeso a `document.body` a mano: il campo restava nel DOM **e a fuoco**
     * per tutte le prove successive del file. Costo misurato: la prova sullo smontaggio qui
     * sotto passava sia con la correzione sia senza, perché `campoModificabileAFuoco()`
     * trovava QUESTO campo e il componente rinviava invece di ricaricare. Un verde che
     * dipendeva dall'ordine delle prove, su un difetto diverso da quello misurato.
     */
    const campi: HTMLElement[] = [];

    afterEach(() => {
        campi.splice(0).forEach((campo) => campo.remove());
    });

    /** Un campo di testo a fuoco, come una maestra a metà di una nota. */
    function campoAFuoco() {
        const input = document.createElement('input');
        input.type = 'text';
        document.body.appendChild(input);
        input.focus();
        campi.push(input);
        return input;
    }

    it('con un campo a fuoco RINVIA invece di ricaricare', async () => {
        await monta();
        campoAFuoco();
        await assenzaDi(QUINDICI_MINUTI);

        expect(ricarica, 'ha ricaricato con un campo a fuoco').not.toHaveBeenCalled();
        expect(logClient.mock.calls[0][0].campi).toMatchObject({ esito: 'rinviata' });
    });

    it('la ricarica rinviata parte alla prima NAVIGAZIONE', async () => {
        const { rerender } = await monta();
        const input = campoAFuoco();
        await assenzaDi(QUINDICI_MINUTI);
        expect(ricarica).not.toHaveBeenCalled();

        input.blur();
        const { ControlloVersione } = await import('@/components/providers/ControlloVersione');
        finto.percorso = '/parent/pagamenti';
        await act(async () => { rerender(<ControlloVersione attivo />); });

        expect(ricarica).toHaveBeenCalledTimes(1);
        expect(logClient.mock.calls[1][0].campi).toMatchObject({ esito: 'rinvio-eseguito' });
    });

    it('senza navigazione la ricarica rinviata non parte da sola', async () => {
        // ROSSO SE: il rinvio diventa un timer. Il momento in cui si può ricaricare è quello in
        // cui l'utente ha già lasciato la schermata, non «fra un po'».
        const { rerender } = await monta();
        campoAFuoco();
        await assenzaDi(QUINDICI_MINUTI);

        const { ControlloVersione } = await import('@/components/providers/ControlloVersione');
        orologio += 60 * 60 * 1000;
        await act(async () => { rerender(<ControlloVersione attivo />); });

        expect(ricarica).not.toHaveBeenCalled();
    });
});

describe('ControlloVersione — quando la domanda non ottiene risposta', () => {
    it('la route risponde male: nessuna ricarica, e una riga che lo dice', async () => {
        rete.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
        await monta();
        await assenzaDi(QUINDICI_MINUTI);

        expect(ricarica).not.toHaveBeenCalled();
        const riga = logClient.mock.calls[0][0];
        // Lo `stato` si DICHIARA e il livello lo decide `logClient` (`livelloEvento`): un 500 è
        // un guasto, un 404 è rumore che il server ha già registrato di suo.
        expect(riga.stato).toBe(500);
    });

    it('la rete cade: nessuna ricarica, e `stato: 0` lasciato giudicare alla politica', async () => {
        // `stato: 0` e non un livello cablato: a pagina appena riaperta quella riga è la
        // richiesta troncata dal periodo in background, e `livelloEvento` (S7-C) la sopprime.
        // Dichiarare il fatto invece del livello è ciò che tiene la politica in un posto solo.
        rete.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
        await monta();
        await assenzaDi(QUINDICI_MINUTI);

        expect(ricarica).not.toHaveBeenCalled();
        expect(logClient.mock.calls[0][0]).toMatchObject({ stato: 0 });
    });

    it('la risposta che arriva DOPO lo smontaggio non ricarica niente', async () => {
        /**
         * IL CASO CONCRETO È L'USCITA DALL'ACCOUNT. `attivo` passa a `false` — o il guscio si
         * smonta — mentre la domanda alla route è già partita: la risposta arriva dopo, e una
         * `location.reload()` in quel momento interromperebbe la navigazione di logout per
         * ricaricare una pagina che il browser stava già lasciando.
         *
         * ⚠️ Questa prova è nata da `prefer-const`. La guardia `if (smontato) return` esisteva
         * dal primo giro, ma la pulizia dell'effetto non metteva mai `smontato = true`: era
         * codice morto, e nessuno dei 16 test se ne era accorto perché nessuno smontava con una
         * domanda in volo. L'ha detto eslint, non la suite. ROSSO SE: la pulizia torna a
         * restituire direttamente la funzione di `osservaVisibilita`.
         */
        // Un vettore e non una variabile: assegnata dentro la callback della Promise, una
        // `let` viene ristretta da TypeScript a `never` e `tsc` rifiuta di chiamarla.
        const consegne: Array<() => void> = [];
        rete.mockImplementation(() => new Promise((risolvi) => {
            consegne.push(() => risolvi(corpoVersione(VERSIONE_SERVITA)));
        }));

        const { unmount } = await monta();
        await assenzaDi(QUINDICI_MINUTI);
        // La domanda è PARTITA e la risposta è ancora in volo: senza queste due, il resto
        // misurerebbe il nulla.
        expect(rete, 'la richiesta non è nemmeno partita').toHaveBeenCalledTimes(1);
        expect(consegne, 'la risposta non è rimasta in volo').toHaveLength(1);

        unmount();
        consegne.forEach((consegna) => consegna());
        await act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); });

        expect(ricarica, 'ha ricaricato una pagina che non esisteva più').not.toHaveBeenCalled();
    });
});
