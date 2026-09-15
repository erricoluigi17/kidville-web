/**
 * IL CENTRO NOTIFICHE APRE LA CONVERSAZIONE (parte C della correzione chat, 2026-09-15).
 *
 * La campanella del genitore e del docente (`NotificationsPanel`) e quella della segreteria
 * (`AdminNotificationsPanel`) facevano `router.push(withUser(n.link))`. Tre conseguenze:
 *  · le notifiche di chat già in tabella portano `/parent/chat` o `/teacher/chat`, cioè la LISTA:
 *    la conversazione la nominano solo in `entita_tipo = 'chat_thread'` ed `entita_id`, e il tocco
 *    non la apriva;
 *  · sulla pagina chat già aperta, una push allo stesso percorso non rimonta la pagina in Next 16:
 *    il tocco non apriva niente;
 *  · un link che non è di questa app (`//host`) finiva in `router.push`.
 *
 * Adesso il link passa da `linkEffettivoNotifica` (ricostruisce `?thread=`) e da `apriLinkNotifica`
 * (evento alla pagina chat montata, riscrittura d'area per chi ha due profili, rifiuto dei link
 * esterni). La pagina chat qui è un ascoltatore vero di `ascoltaAperturaThread`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ push: vi.fn(), logClient: vi.fn() }));

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

import { NotificationsPanel } from '@/components/features/shell/NotificationsPanel';
import { AdminNotificationsPanel } from '@/components/features/admin/AdminNotificationsPanel';
import { ascoltaAperturaThread } from '@/lib/chat/apertura-thread';

const T = 'dddddddd-0000-4000-8000-000000000014';
const U = 'aaaaaaaa-0000-4000-8000-000000000011';
const TITOLO = 'Nuovo messaggio';

interface Riga {
    id: string;
    tipo: string | null;
    titolo: string | null;
    corpo: string | null;
    link: string | null;
    entita_tipo: string | null;
    entita_id: string | null;
    letta_il: string | null;
    creato_il: string;
}

/** Una notifica di chat nata prima del 2026-09-15: il link è la lista, la conversazione sta in entita_*. */
function riga(p: Partial<Riga> = {}): Riga {
    return {
        id: 'eeeeeeee-0000-4000-8000-000000000001',
        tipo: 'chat_genitore',
        titolo: TITOLO,
        corpo: null,
        link: '/parent/chat',
        entita_tipo: 'chat_thread',
        entita_id: T,
        letta_il: '2026-09-14T08:00:00Z',
        creato_il: '2026-09-14T08:00:00Z',
        ...p,
    };
}

let fetchMock: ReturnType<typeof vi.fn>;
const pagineMontate: Array<() => void> = [];

function conNotifiche(...righe: Riga[]) {
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
        ok: true,
        json: async () =>
            init?.method === 'PATCH'
                ? { success: true }
                : { success: true, data: righe, non_lette: righe.filter((r) => !r.letta_il).length },
    }));
    vi.stubGlobal('fetch', fetchMock);
}

const suPagina = (percorso: string) => window.history.replaceState(null, '', percorso);

/** La pagina chat montata: ascolta le richieste di apertura. */
function paginaChatMontata() {
    const gestore = vi.fn();
    pagineMontate.push(ascoltaAperturaThread(gestore));
    return gestore;
}

/** Apre la campanella e tocca la notifica. */
async function tocca(titolo = TITOLO) {
    fireEvent.click(await screen.findByRole('button', { name: /^Notifiche/ }));
    fireEvent.click(await screen.findByText(titolo));
}

beforeEach(() => {
    h.push.mockReset();
    h.logClient.mockReset();
});

afterEach(() => {
    while (pagineMontate.length) pagineMontate.pop()!();
    suPagina('/');
    vi.unstubAllGlobals();
});

describe('NotificationsPanel (genitore e docente) — il tocco su una notifica di chat', () => {
    it('notifica di chat già in tabella, fuori dalla chat: si naviga alla conversazione, non alla lista', async () => {
        suPagina('/parent/home');
        conNotifiche(riga());
        render(<NotificationsPanel area="parent" userId={U} />);

        await tocca();

        expect(h.push).toHaveBeenCalledTimes(1);
        expect(h.push).toHaveBeenCalledWith(`/parent/chat?thread=${T}`);
    });

    it('lato docente il link porta anche ?userId=, e una notifica non letta si segna letta prima di navigare', async () => {
        suPagina('/teacher/registro');
        conNotifiche(riga({ tipo: 'chat_docente', link: '/teacher/chat', letta_il: null }));
        render(<NotificationsPanel area="teacher" userId={U} />);

        await tocca();

        await waitFor(() => expect(h.push).toHaveBeenCalledWith(`/teacher/chat?thread=${T}&userId=${U}`));
        expect(h.push).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toBe(true);
    });

    it('chi ha due profili, dalla veste di docente: il messaggio da genitore apre la chat dell’area in cui si trova', async () => {
        // Senza la riscrittura, `/parent/chat` con la veste di docente → la guardia d'area rimanda alla home.
        suPagina('/teacher/registro');
        conNotifiche(riga({ link: `/parent/chat?thread=${T}` }));
        render(<NotificationsPanel area="teacher" userId={U} />);

        await tocca();

        expect(h.push).toHaveBeenCalledWith(`/teacher/chat?thread=${T}&userId=${U}`);
    });

    it('sulla pagina chat già aperta: la conversazione si apre lì, senza navigare', async () => {
        suPagina('/parent/chat');
        const gestore = paginaChatMontata();
        conNotifiche(riga());
        render(<NotificationsPanel area="parent" userId={U} />);

        await tocca();

        expect(gestore).toHaveBeenCalledWith(T);
        expect(h.push).not.toHaveBeenCalled();
        expect(h.logClient).not.toHaveBeenCalled();
    });

    it('un link che non è di questa app non si apre, e lo si scrive senza l’URL', async () => {
        suPagina('/parent/home');
        conNotifiche(riga({ tipo: 'avviso', link: '//evil.example/parent/avvisi', entita_tipo: null, entita_id: null }));
        render(<NotificationsPanel area="parent" userId={U} />);

        await tocca();

        expect(h.push).not.toHaveBeenCalled();
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'warn', evento: 'push', messaggio: 'notifica-link-rifiutato: non interno' }),
        );
        expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('evil');
    });

    it('presidio — una notifica che non è di chat naviga com’è, e una senza link non fa niente', async () => {
        suPagina('/parent/home');
        conNotifiche(
            riga({ id: 'eeeeeeee-0000-4000-8000-000000000002', tipo: 'avviso', titolo: 'Avviso', link: '/parent/avvisi', entita_tipo: 'avviso', entita_id: null }),
            riga({ id: 'eeeeeeee-0000-4000-8000-000000000003', tipo: 'avviso', titolo: 'Senza link', link: null, entita_tipo: null, entita_id: null }),
        );
        render(<NotificationsPanel area="parent" userId={U} />);

        await tocca('Avviso');
        await tocca('Senza link');

        expect(h.push.mock.calls).toEqual([['/parent/avvisi']]);
        expect(h.logClient).not.toHaveBeenCalled();
    });
});

describe('AdminNotificationsPanel (segreteria) — il tocco su una notifica di chat', () => {
    it('lo staff che è docente di un thread: da /admin si naviga alla conversazione, col suo ?userId=', async () => {
        suPagina('/admin/pagamenti');
        conNotifiche(riga({ tipo: 'chat_docente', link: '/teacher/chat' }));
        render(<AdminNotificationsPanel userId={U} />);

        await tocca();

        expect(h.push).toHaveBeenCalledTimes(1);
        expect(h.push).toHaveBeenCalledWith(`/teacher/chat?thread=${T}&userId=${U}`);
    });

    it('un link che non è di questa app non si apre, e lo si scrive senza l’URL', async () => {
        suPagina('/admin/pagamenti');
        conNotifiche(riga({ tipo: 'avviso', link: 'https://evil.example/admin', entita_tipo: null, entita_id: null }));
        render(<AdminNotificationsPanel userId={U} />);

        await tocca();

        expect(h.push).not.toHaveBeenCalled();
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'warn', evento: 'push', messaggio: 'notifica-link-rifiutato: non interno' }),
        );
        expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('evil');
    });

    it('presidio — una notifica che non è di chat naviga com’è, col ?userId=', async () => {
        suPagina('/admin/pagamenti');
        conNotifiche(riga({ tipo: 'cassa', titolo: 'Cassa', link: '/admin/pagamenti?vista=cassa', entita_tipo: null, entita_id: null }));
        render(<AdminNotificationsPanel userId={U} />);

        await tocca('Cassa');

        expect(h.push.mock.calls).toEqual([[`/admin/pagamenti?vista=cassa&userId=${U}`]]);
    });
});
