import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';

/**
 * LA CAMPANELLA PORTA IL NUMERO DELLA CHAT, E SCENDE QUANDO SI LEGGE (2026-09-29).
 *
 * Due cose distinte, in un file solo perché vivono nella stessa `load()`:
 *
 *  1. `chat_non_letti` della risposta di `/api/notifiche` finisce nello store del contatore. Il
 *     campo è `number | null`, ed è ASSENTE nelle risposte d'errore: `null` e assenza NON devono
 *     toccare il valore noto. Un `?? 0` qui rimetterebbe in piedi la bugia «hai letto tutto» —
 *     ed è il mutante che questo file esiste per uccidere.
 *  2. quando una conversazione viene letta (evento `kv:chat-letta`), la campanella ricarica: dal
 *     `segnaLetteNotificheChat` la lettura spegne anche le NOTIFICHE di quel thread, e senza
 *     questa ricarica il
 *     numero sulla campanella resta quello del giro precedente per un minuto intero.
 *     UNA ricarica per raffica, con un rimando di ~600 ms: l'IntersectionObserver della chat manda
 *     più PATCH ravvicinate, e una ricarica per ciascuna sarebbe volume inutile.
 *
 * Il modulo dello store si ricarica per ogni test (`vi.resetModules`): lo stato è di MODULO.
 */

type Store = typeof import('@/components/features/chat/contatore-non-letti');

const h = vi.hoisted(() => ({ push: vi.fn(), logClient: vi.fn(), badgeNativo: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }) }));

vi.mock('next/link', async () => {
    const React = await import('react');
    return {
        default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
            React.createElement('a', { href, ...rest }, children),
    };
});

vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}));

/**
 * Il badge nativo dell'icona app non c'entra con questo passo: no-op. Ma il finto serve anche come
 * SEGNALE POSITIVO: `load()` lo chiama nello stesso blocco, subito PRIMA del ramo `chat_non_letti`.
 * Aspettare la sua n-esima chiamata è la prova che la n-esima risposta è stata applicata — e senza
 * quella prova un'asserzione di ASSENZA («il contatore non è cambiato») passerebbe anche mentre la
 * risposta è ancora in volo, cioè sarebbe verde qualunque cosa faccia il codice.
 */
vi.mock('@/lib/native/badge', () => ({ impostaBadgeNonLette: h.badgeNativo }));
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => false }));

const U = 'aaaaaaaa-0000-4000-8000-000000000011';

type Corpo = Record<string, unknown>;

let fetchMock: ReturnType<typeof vi.fn>;
/** Le chiamate GET a /api/notifiche, in ordine. */
let getNotifiche: string[] = [];

/** Il server della campanella: `corpi` è la coda delle risposte della GET (l'ultima si ripete). */
function conRisposte(...corpi: Corpo[]) {
    let i = 0;
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') return { ok: true, json: async () => ({ success: true }) };
        getNotifiche.push(String(url));
        const corpo = corpi[Math.min(i, corpi.length - 1)];
        i++;
        return { ok: true, json: async () => corpo };
    });
    vi.stubGlobal('fetch', fetchMock);
}

const elenco = (extra: Corpo = {}): Corpo => ({ success: true, data: [], non_lette: 0, ...extra });

async function store(): Promise<Store> {
    return await import('@/components/features/chat/contatore-non-letti');
}

/** Monta la campanella di genitori/docenti e attende il primo giro. */
async function montaPannello() {
    const { NotificationsPanel } = await import('@/components/features/shell/NotificationsPanel');
    const vista = render(<NotificationsPanel area="teacher" userId={U} />);
    await waitFor(() => expect(getNotifiche.length).toBeGreaterThan(0));
    return vista;
}

async function montaPannelloAdmin() {
    const { AdminNotificationsPanel } = await import('@/components/features/admin/AdminNotificationsPanel');
    const vista = render(<AdminNotificationsPanel userId={U} />);
    await waitFor(() => expect(getNotifiche.length).toBeGreaterThan(0));
    return vista;
}

/**
 * Le DUE campanelle della segreteria come stanno in produzione: la topbar desktop e quella mobile,
 * entrambe montate, ciascuna con la sua media query. `larga` decide quale delle due è quella visibile.
 */
async function montaLeDueTopbarAdmin(larga: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query.includes('min-width') ? larga : !larga,
        addEventListener: () => {},
        removeEventListener: () => {},
    }));
    const { AdminNotificationsPanel } = await import('@/components/features/admin/AdminNotificationsPanel');
    const vista = render(
        <>
            <AdminNotificationsPanel userId={U} attivoSu="(min-width: 1024px)" />
            <AdminNotificationsPanel userId={U} attivoSu="(max-width: 1023px)" />
        </>,
    );
    await waitFor(() => expect(getNotifiche.length).toBeGreaterThan(0));
    return vista;
}

beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.push.mockReset();
    h.logClient.mockReset();
    h.badgeNativo.mockReset();
    getNotifiche = [];
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('NotificationsPanel — `chat_non_letti` finisce nello store', () => {
    it('un NUMERO arriva al contatore', async () => {
        conRisposte(elenco({ chat_non_letti: 4 }));
        await montaPannello();
        const s = await store();
        await waitFor(() => expect(s.chatNonLetti()).toBe(4));
    });

    /**
     * ⚠️ LO ZERO DEVE PASSARE. È il caso di ogni giorno: la maestra legge gli ultimi messaggi da un
     * altro dispositivo, o la segreteria apre quella conversazione, e al giro dopo il server dice 0.
     * Con un `if (j.chat_non_letti)` o un `> 0` — lo sbaglio più naturale in JavaScript, perché lo 0
     * è falsy — il badge resterebbe bloccato sull'ultimo numero positivo, per sempre.
     */
    it('lo ZERO dal server spegne il badge', async () => {
        conRisposte(elenco({ chat_non_letti: 5 }), elenco({ chat_non_letti: 0 }));
        await montaPannello();
        const s = await store();
        await waitFor(() => expect(s.chatNonLetti()).toBe(5));

        // Il secondo giro lo fa partire l'evento di lettura, che è la strada vera: si legge altrove,
        // la campanella ricarica, e il server risponde 0.
        act(() => s.segnalaChatLetta());
        await act(async () => { vi.advanceTimersByTime(700); await Promise.resolve(); });

        await waitFor(() =>
            expect(
                s.chatNonLetti(),
                'Lo 0 del server non è entrato: il badge resta bloccato sull\'ultimo numero positivo, ' +
                    'e chi ha letto altrove continua a vedere messaggi che non ci sono.',
            ).toBe(0),
        );
    });

    it('`null` NON tocca il valore noto: «non lo so» non è «hai letto tutto»', async () => {
        conRisposte(elenco({ chat_non_letti: 4 }), elenco({ chat_non_letti: null }));
        await montaPannello();
        const s = await store();
        await waitFor(() => expect(s.chatNonLetti()).toBe(4));
        expect(h.badgeNativo).toHaveBeenCalledTimes(1);

        // Secondo giro: il server non ha potuto contare.
        act(() => s.segnalaChatLetta());
        await act(async () => { vi.advanceTimersByTime(700); await Promise.resolve(); });
        // IL SEGNALE POSITIVO, prima di poter dire «non è cambiato niente»: la seconda risposta è
        // stata applicata, perché il badge nativo è stato riscritto — riga che sta subito PRIMA del
        // ramo `chat_non_letti` in `load()`.
        await waitFor(() => expect(h.badgeNativo).toHaveBeenCalledTimes(2));

        expect(
            s.chatNonLetti(),
            'Un `chat_non_letti: null` ha azzerato il contatore: `null` è «non lo so», e uno 0 ' +
                'di ripiego dice «hai letto tutto» — la bugia che questo lavoro toglie di mezzo.',
        ).toBe(4);
    });

    it('il campo ASSENTE non tocca il valore noto (gli E2E fanno lo stub senza quel campo)', async () => {
        conRisposte(elenco({ chat_non_letti: 4 }), elenco());
        await montaPannello();
        const s = await store();
        await waitFor(() => expect(s.chatNonLetti()).toBe(4));
        expect(h.badgeNativo).toHaveBeenCalledTimes(1);

        act(() => s.segnalaChatLetta());
        await act(async () => { vi.advanceTimersByTime(700); await Promise.resolve(); });
        await waitFor(() => expect(h.badgeNativo).toHaveBeenCalledTimes(2));

        expect(s.chatNonLetti()).toBe(4);
    });

    /**
     * ⚠️ CAMBIA LA PERSONA, IL NUMERO NON RESTA.
     *
     * Il contatore è stato di MODULO: sopravvive a ogni navigazione che non ricarica la pagina. Il
     * logout a mano fa una ricarica dura e lo porta via; una sessione SCADUTA no — porta al login
     * con una navigazione morbida, e chi entra dopo si troverebbe sulla barra il numero del genitore
     * di prima, indefinitamente se il server risponde `null`. È il numero delle conversazioni in
     * sospeso di un'altra famiglia.
     */
    it('cambiando PERSONA il contatore torna a «non lo so», e il numero vecchio non rientra', async () => {
        const ALTRO = 'bbbbbbbb-0000-4000-8000-000000000022';
        conRisposte(elenco({ chat_non_letti: 4 }), elenco({ chat_non_letti: null }));
        const { NotificationsPanel } = await import('@/components/features/shell/NotificationsPanel');
        const { rerender } = render(<NotificationsPanel area="teacher" userId={U} />);
        const s = await store();
        await waitFor(() => expect(s.chatNonLetti()).toBe(4));

        // La sessione è scaduta e si rientra come un'altra persona, senza ricaricare la pagina.
        act(() => rerender(<NotificationsPanel area="teacher" userId={ALTRO} />));
        expect(
            s.chatNonLetti(),
            'Il numero della persona di prima è ancora sulla barra della persona nuova.',
        ).toBeNull();

        // E la GET della nuova identità, che risponde «non lo so», non lo riporta indietro.
        await waitFor(() => expect(h.badgeNativo).toHaveBeenCalledTimes(2));
        expect(s.chatNonLetti()).toBeNull();
        expect(getNotifiche[1]).toContain(ALTRO);
    });

    /**
     * IL FLUSSO VERO della sessione scaduta: `/auth/login` sta fuori da `(dashboard)`, quindi la
     * campanella si SMONTA; dopo il login ne nasce una nuova SENZA identità (`useSessionIdentity`
     * parte da `null`), che poi risolve la persona nuova. `null → B` non è un cambio riconoscibile:
     * il numero di A deve essere andato via con la campanella che lo portava.
     */
    it('sessione scaduta: campanella smontata e rimontata con identità null → B, il numero di A non resta', async () => {
        const ALTRO = 'bbbbbbbb-0000-4000-8000-000000000033';
        conRisposte(elenco({ chat_non_letti: 4 }), elenco({ chat_non_letti: null }));
        const { NotificationsPanel } = await import('@/components/features/shell/NotificationsPanel');
        const primo = render(<NotificationsPanel area="parent" userId={U} />);
        const s = await store();
        await waitFor(() => expect(s.chatNonLetti()).toBe(4));

        primo.unmount();
        expect(s.chatNonLetti(), 'smontata la campanella, il numero di A è rimasto nello store').toBeNull();

        const secondo = render(<NotificationsPanel area="parent" userId={null} />);
        act(() => secondo.rerender(<NotificationsPanel area="parent" userId={ALTRO} />));
        // La risposta per la persona nuova dice «non lo so»: il numero di A non deve ricomparire.
        await waitFor(() => expect(getNotifiche.some((u) => u.includes(ALTRO))).toBe(true));
        await waitFor(() => expect(h.badgeNativo.mock.calls.length).toBeGreaterThanOrEqual(2));
        expect(s.chatNonLetti()).toBeNull();
    });

    it('l\'azzeramento non aggiorna un ALTRO componente durante il render (nessun warning di React)', async () => {
        const ALTRO = 'bbbbbbbb-0000-4000-8000-000000000044';
        const errore = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            conRisposte(elenco({ chat_non_letti: 4 }), elenco({ chat_non_letti: null }));
            const { NotificationsPanel } = await import('@/components/features/shell/NotificationsPanel');
            const s = await store();
            // Una barra minima che ascolta lo store, come fanno le due bottom-nav.
            function Barra() {
                const n = s.useChatNonLetti();
                return <span data-testid="barra">{n === null ? 'nessuno' : String(n)}</span>;
            }
            const vista = render(<><NotificationsPanel area="teacher" userId={U} /><Barra /></>);
            await waitFor(() => expect(s.chatNonLetti()).toBe(4));

            act(() => vista.rerender(<><NotificationsPanel area="teacher" userId={ALTRO} /><Barra /></>));
            expect(s.chatNonLetti()).toBeNull();
            expect(vista.getByTestId('barra').textContent).toBe('nessuno');

            const messaggi = errore.mock.calls.map((c) => c.map(String).join(' '));
            expect(
                messaggi.filter((m) => m.includes('Cannot update a component')),
                'l\'azzeramento è tornato dentro il render: aggiorna la barra mentre si rende la campanella',
            ).toEqual([]);
        } finally {
            errore.mockRestore();
        }
    });

    it('lo STESSO utente non azzera niente (risolvere l\'identità non è cambiarla)', async () => {
        conRisposte(elenco({ chat_non_letti: 4 }));
        const { NotificationsPanel } = await import('@/components/features/shell/NotificationsPanel');
        const { rerender } = render(<NotificationsPanel area="teacher" userId={U} />);
        const s = await store();
        await waitFor(() => expect(s.chatNonLetti()).toBe(4));

        act(() => rerender(<NotificationsPanel area="teacher" userId={U} />));

        expect(s.chatNonLetti(), 'un render in più ha buttato via il numero').toBe(4);
    });

    it('un totale in volo NON cancella una lettura appena fatta (guardia a sequenza)', async () => {
        // La GET resta appesa: la si chiude a comando, dopo la lettura.
        let chiudi!: (c: Corpo) => void;
        fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
            if (init?.method === 'PATCH') return { ok: true, json: async () => ({ success: true }) };
            getNotifiche.push(String(url));
            return await new Promise<{ ok: boolean; json: () => Promise<Corpo> }>((res) => {
                chiudi = (c) => res({ ok: true, json: async () => c });
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        const s = await store();
        s.impostaChatNonLettiDalServer(5, s.sequenzaChatNonLetti());
        await montaPannello();

        // Mentre la richiesta è in volo, si legge una conversazione di due messaggi.
        act(() => s.variaChatNonLetti(-2));
        expect(s.chatNonLetti()).toBe(3);

        await act(async () => {
            chiudi(elenco({ chat_non_letti: 5 }));
            await Promise.resolve();
        });

        expect(s.chatNonLetti()).toBe(3);
    });
});

describe('NotificationsPanel — la ricarica sulla lettura di una conversazione', () => {
    it('UNA ricarica ~600 ms dopo l\'evento, anche con più eventi ravvicinati', async () => {
        conRisposte(elenco({ chat_non_letti: 2 }));
        await montaPannello();
        const s = await store();
        const dopoIlPrimoGiro = getNotifiche.length;

        act(() => {
            s.segnalaChatLetta();
            s.segnalaChatLetta();
            s.segnalaChatLetta();
        });
        // Prima del rimando non è partito niente: la raffica si aspetta.
        act(() => { vi.advanceTimersByTime(s.RICARICA_DOPO_CHAT_LETTA_MS - 200); });
        expect(getNotifiche.length).toBe(dopoIlPrimoGiro);

        await act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); });
        expect(getNotifiche.length).toBe(dopoIlPrimoGiro + 1);

        // E nessun secondo giro che arriva da solo.
        await act(async () => { vi.advanceTimersByTime(2_000); await Promise.resolve(); });
        expect(getNotifiche.length).toBe(dopoIlPrimoGiro + 1);
    });

    it('dopo lo smontaggio nessun timer resta acceso', async () => {
        conRisposte(elenco({ chat_non_letti: 2 }));
        const { unmount } = await montaPannello();
        const s = await store();
        const dopoIlPrimoGiro = getNotifiche.length;

        act(() => s.segnalaChatLetta());
        unmount();
        await act(async () => { vi.advanceTimersByTime(5_000); await Promise.resolve(); });

        expect(
            getNotifiche.length,
            'Un timer è sopravvissuto allo smontaggio: la ricarica parte su un componente che non c\'è più.',
        ).toBe(dopoIlPrimoGiro);
    });
});

describe('AdminNotificationsPanel — la campanella della segreteria scende anche lei', () => {
    it('ricarica ~600 ms dopo la lettura di una conversazione', async () => {
        conRisposte(elenco());
        await montaPannelloAdmin();
        const s = await store();
        const dopoIlPrimoGiro = getNotifiche.length;

        act(() => s.segnalaChatLetta());
        act(() => { vi.advanceTimersByTime(s.RICARICA_DOPO_CHAT_LETTA_MS - 200); });
        expect(getNotifiche.length).toBe(dopoIlPrimoGiro);

        await act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); });
        expect(getNotifiche.length).toBe(dopoIlPrimoGiro + 1);
    });

    it('lo staff non prende il badge: la campanella della segreteria non scrive il contatore', async () => {
        conRisposte(elenco({ chat_non_letti: 9 }));
        await montaPannelloAdmin();
        const s = await store();
        await act(async () => { await Promise.resolve(); });
        expect(s.chatNonLetti()).toBeNull();
    });

    it('nessun timer dopo lo smontaggio', async () => {
        conRisposte(elenco());
        const { unmount } = await montaPannelloAdmin();
        const s = await store();
        const dopoIlPrimoGiro = getNotifiche.length;

        act(() => s.segnalaChatLetta());
        unmount();
        await act(async () => { vi.advanceTimersByTime(5_000); await Promise.resolve(); });
        expect(getNotifiche.length).toBe(dopoIlPrimoGiro);
    });

    /**
     * ⚠️ DUE PANNELLI MONTATI, UNA RICARICA. La campanella della segreteria sta in DUE topbar —
     * desktop e mobile, entrambe sempre nel DOM — e il gate `attivoSu` esiste perché soltanto quella
     * visibile chieda qualcosa. Senza il gate anche sull'ascolto della lettura, una conversazione
     * aperta costerebbe DUE richieste a `/api/notifiche` invece di una: lo stesso difetto che il gate
     * già evita sul polling, riaperto da una strada nuova.
     */
    it.each([
        ['schermo largo', true],
        ['schermo stretto', false],
    ])('con le due topbar montate (%s) una lettura costa UNA ricarica, non due', async (_nome, larga) => {
        conRisposte(elenco());
        await montaLeDueTopbarAdmin(larga);
        const s = await store();
        const dopoIlPrimoGiro = getNotifiche.length;
        // Il gate vale già per il primo giro: una sola delle due topbar ha chiesto qualcosa.
        expect(dopoIlPrimoGiro).toBe(1);

        act(() => s.segnalaChatLetta());
        await act(async () => { vi.advanceTimersByTime(s.RICARICA_DOPO_CHAT_LETTA_MS + 100); await Promise.resolve(); });

        expect(
            getNotifiche.length - dopoIlPrimoGiro,
            'La topbar NON visibile ha ricaricato anche lei: una lettura costa due richieste.',
        ).toBe(1);
    });
});
