import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * `useUnreadNotifications` DOPO LA SESSIONE 12: chiede il permesso delle notifiche, e basta.
 * Nessuna GET, nessun orologio: la lista la scarica `useConversazioneChat`, e l'annuncio lo fa
 * `annunciaNonLetti`. Una richiesta del permesso che fallisce non resta un rifiuto non gestito.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }));
vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}));

import { useUnreadNotifications } from '@/components/features/chat/useUnreadNotifications';

class NotificaFinta {
    static permission: NotificationPermission = 'default';
    static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
}

const fetchFinta = vi.fn();

beforeEach(() => {
    NotificaFinta.permission = 'default';
    NotificaFinta.requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    vi.stubGlobal('Notification', NotificaFinta);
    vi.stubGlobal('fetch', fetchFinta);
    fetchFinta.mockClear();
    h.logClient.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

describe('useUnreadNotifications — solo il permesso', () => {
    it('lo chiede UNA volta, e non scarica niente', async () => {
        const r = renderHook(() => useUnreadNotifications({ enabled: true }));
        r.rerender();
        await waitFor(() => expect(NotificaFinta.requestPermission).toHaveBeenCalledTimes(1));
        expect(fetchFinta).not.toHaveBeenCalled();
        r.unmount();
    });

    it('permesso già deciso: nessuna richiesta', () => {
        NotificaFinta.permission = 'granted';
        renderHook(() => useUnreadNotifications({ enabled: true }));
        expect(NotificaFinta.requestPermission).not.toHaveBeenCalled();
    });

    it('`enabled` falso: niente', () => {
        renderHook(() => useUnreadNotifications({ enabled: false }));
        expect(NotificaFinta.requestPermission).not.toHaveBeenCalled();
    });

    it('la richiesta fallisce: warn «push» col solo nome dell’errore', async () => {
        NotificaFinta.requestPermission = vi.fn(async () => {
            throw new TypeError('riservato');
        });
        renderHook(() => useUnreadNotifications({ enabled: true }));
        await waitFor(() => expect(h.logClient).toHaveBeenCalledTimes(1));
        expect(h.logClient).toHaveBeenCalledWith({
            livello: 'warn',
            evento: 'push',
            messaggio: 'chat-permesso-notifiche-non-chiesto: TypeError',
        });
    });
});
