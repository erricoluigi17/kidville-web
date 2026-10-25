'use client';

import { useEffect } from 'react';
import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * IL PERMESSO DELLE NOTIFICHE DEL BROWSER, E NIENT'ALTRO (robustezza 2, sessione 12 — S7).
 *
 * Fino al 2026-10-20 questo hook aveva un SUO orologio: ogni 30 s (5 minuti a pagina nascosta) una
 * `GET /api/chat/threads` per sommare i non letti, accanto a quella identica della lista in
 * `useConversazioneChat`. Due GET della stessa lista per lo stesso utente, ciascuna da ~150 richieste
 * al database con 37 conversazioni.
 *
 * Adesso la lista la scarica un orologio solo, quello di `useConversazioneChat`, e il totale, il
 * titolo della pagina e la notifica del browser li fa `annunciaNonLetti` (`@/lib/chat/annuncio-non-letti`)
 * sulla lista che c'è già. Qui resta la richiesta del permesso, una volta.
 *
 * Il nome del file resta: cinque test di pagina lo sostituiscono con una factory che espone solo
 * `useUnreadNotifications`.
 */
export function useUnreadNotifications({ enabled }: { enabled: boolean }): void {
    useEffect(() => {
        if (!enabled) return;
        if (typeof window === 'undefined' || !('Notification' in window)) return;
        if (Notification.permission !== 'default') return;
        // `Promise.resolve`: su Safari vecchi `requestPermission` non restituisce una promessa.
        void Promise.resolve(Notification.requestPermission()).then(
            () => undefined,
            (err: unknown) => {
                logClient({
                    livello: 'warn',
                    evento: 'push',
                    messaggio: `chat-permesso-notifiche-non-chiesto: ${nomeErrore(err)}`,
                });
            },
        );
    }, [enabled]);
}
