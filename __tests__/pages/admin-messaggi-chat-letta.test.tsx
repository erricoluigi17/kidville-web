import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi';

/**
 * ANCHE LA SEGRETERIA LEGGE LE CONVERSAZIONI, E ANCHE LA SUA CAMPANELLA DEVE SCENDERE
 * (2026-09-29).
 *
 * La scheda «Con i genitori» di `/admin/messaggi` apre la conversazione con la GET
 * `chat/messages:GET?markRead=…`, che spegne anche le NOTIFICHE di quel thread
 * (`segnaLetteNotificheChat`). La
 * risposta di quella GET NON porta nessun conteggio — la sua forma è bloccata da
 * `__tests__/api/chat-messages-read-notifiche.test.ts` — quindi qui non si può sapere *quante*
 * notifiche si sono spente: si sa solo che la lettura è stata registrata. L'evento parte su quel
 * fatto, e la campanella rilegge il numero vero da sé.
 *
 * ⚠️ NON PARTE SE LA GET FALLISCE: una lettura non registrata non ha spento niente.
 *
 * ⚠️ E NON PARTE DOPO UN INVIO. `loadChatMessages` è richiamata anche dopo ogni messaggio scritto
 * dalla segreteria: da lì l'evento costerebbe una GET a `/api/notifiche` per ogni messaggio, e chi
 * scrive non sta leggendo niente di nuovo — la conversazione l'ha aperta prima, e quell'apertura ha
 * già annunciato la sua lettura.
 */

const h = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(''),
    usePathname: () => '/admin/messaggi',
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/auth/use-session-identity', () => ({
    useSessionIdentity: () => ({ userId: 'seg-1', role: 'segreteria', ready: true }),
}));

vi.mock('@/lib/context/sede-context', () => ({
    useSediAttive: () => ({
        sedi: [{ id: SEDE_A, nome: NOME_SEDE_A }],
        selezionate: [],
        effettive: [SEDE_A],
        sedeCorrente: SEDE_A,
        reFetchKey: SEDE_A,
        loading: false,
        toggle: vi.fn(),
        soloSede: vi.fn(),
        tutte: vi.fn(),
    }),
}));

/** Il testo che la conversazione mostra: è il segnale positivo dei test di assenza. */
const TESTO_MESSAGGIO = 'Buongiorno maestra';

const CONTATTI = [
    { parentUserId: 'u-a', parentName: 'Rossi Anna', studentId: 's-a', studentName: 'Alfa Rossi', classe: '2 ANNI', scuolaId: SEDE_A },
];

/** `messaggiOk: false` = la GET con `markRead` non è andata (la lettura non è registrata). */
function conRete({ messaggiOk = true }: { messaggiOk?: boolean } = {}) {
    h.fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/api/admin/chat/contacts')) {
            return Promise.resolve({ ok: true, json: async () => ({ success: true, data: CONTATTI }) });
        }
        if (u === '/api/chat/threads' && init?.method === 'POST') {
            return Promise.resolve({ ok: true, json: async () => ({ id: 'th-1' }) });
        }
        if (u.startsWith('/api/chat/messages?')) {
            // Un messaggio VERO nel corpo, e non una lista vuota: `loadChatMessages` scrive
            // `setChatMsgs` a prescindere da `res.ok`, quindi la comparsa di questo testo a schermo è
            // il SEGNALE POSITIVO che la catena `.then` è arrivata in fondo. Senza un segnale così,
            // «non è partito nessun evento» sarebbe vero anche mentre la richiesta è ancora in volo:
            // un'asserzione di assenza che passa da sola, verde qualunque cosa faccia il codice.
            return Promise.resolve({
                ok: messaggiOk,
                json: async () => ({ messages: [{ id: 'm-1', sender_id: 'u-a', content: TESTO_MESSAGGIO, created_at: '2026-09-30T08:00:00.000Z' }], total: 1 }),
            });
        }
        return Promise.resolve({ ok: true, json: async () => ({ success: true, data: [] }) });
    });
    vi.stubGlobal('fetch', h.fetchMock);
}

import MessaggiPage from '@/app/(dashboard)/admin/messaggi/page';
import { ascoltaChatLetta } from '@/components/features/chat/contatore-non-letti';

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

/** Quante GET della conversazione (quelle con `markRead`) sono partite finora. */
function quanteGetConversazione(): number {
    return h.fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/chat/messages?')).length;
}

/** Apre la prima famiglia della rubrica e attende la GET della conversazione. */
async function apriLaPrimaFamiglia() {
    render(<MessaggiPage />);
    const riga = await screen.findByText('Rossi Anna');
    fireEvent.click(riga);
    await waitFor(() =>
        expect(
            h.fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/chat/messages?')),
        ).toBe(true),
    );
}

describe('/admin/messaggi — leggere una conversazione avvisa la campanella', () => {
    it('aprire una famiglia segnala la lettura', async () => {
        conRete();
        const letture = vi.fn();
        const smetti = ascoltaChatLetta(letture);

        await apriLaPrimaFamiglia();
        await waitFor(() => expect(letture).toHaveBeenCalledTimes(1));
        smetti();
    });

    it('se la GET con markRead FALLISCE non si segnala nessuna lettura', async () => {
        conRete({ messaggiOk: false });
        const letture = vi.fn();
        const smetti = ascoltaChatLetta(letture);

        await apriLaPrimaFamiglia();
        // Il segnale POSITIVO: la catena `.then` della GET è arrivata in fondo e ha scritto i
        // messaggi a schermo. Solo dopo si può dire che l'evento non è partito.
        expect(await screen.findByText(TESTO_MESSAGGIO)).toBeInTheDocument();
        smetti();

        expect(letture).not.toHaveBeenCalled();
    });

    it('DOPO UN INVIO non si segnala nessuna lettura, benché la conversazione si ricarichi', async () => {
        conRete();
        const letture = vi.fn();
        const smetti = ascoltaChatLetta(letture);

        await apriLaPrimaFamiglia();
        await waitFor(() => expect(letture).toHaveBeenCalledTimes(1));
        const getDopoApertura = quanteGetConversazione();

        // Si scrive e si manda: `loadChatMessages` riparte, e con essa la GET `markRead`.
        fireEvent.change(screen.getByPlaceholderText('Scrivi un messaggio…'), { target: { value: 'Buongiorno' } });
        fireEvent.click(screen.getByRole('button', { name: 'Invia messaggio' }));
        await waitFor(() => expect(quanteGetConversazione()).toBe(getDopoApertura + 1));
        smetti();

        expect(
            letture,
            'Ogni messaggio inviato dalla segreteria annuncia una lettura: è una GET a ' +
                '/api/notifiche per messaggio scritto, e chi scrive non ha letto niente di nuovo.',
        ).toHaveBeenCalledTimes(1);
    });
});
