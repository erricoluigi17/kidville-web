// @vitest-environment node
/**
 * `bozze-chat.ts` — la memoria delle bozze, da sola (parte C, 2026-09-15).
 *
 * Il comportamento che si vede sta in `chat-input-bozze.test.tsx`. Qui il contratto del modulo, e in
 * particolare la metà che il campo di scrittura non mostra: una bozza vuota non resta in memoria. Il
 * testo di un messaggio già mandato non ha motivo di sopravvivere, nemmeno come stringa vuota accanto
 * all'id di una conversazione.
 */
import { describe, it, expect } from 'vitest';
import { leggiBozza, scriviBozza } from '@/components/features/chat/bozze-chat';

const ALLEGATO = { name: 'foto.png', riferimento: 'u/foto.png', type: 'image' };

describe('bozze-chat', () => {
    it('ricorda testo e allegato per chiave, e una chiave non vede la bozza di un’altra', () => {
        scriviBozza('u1:t1', { testo: 'per t1', allegato: ALLEGATO });
        expect(leggiBozza('u1:t1')).toEqual({ testo: 'per t1', allegato: ALLEGATO });
        expect(leggiBozza('u1:t2')).toBeNull();
        expect(leggiBozza('u2:t1')).toBeNull();
    });

    it('un campo vuoto senza allegato, o null, cancella: non resta niente da leggere', () => {
        scriviBozza('u1:vuota', { testo: 'qualcosa', allegato: null });
        scriviBozza('u1:vuota', { testo: '', allegato: null });
        expect(leggiBozza('u1:vuota')).toBeNull();

        scriviBozza('u1:nulla', { testo: 'qualcosa', allegato: null });
        scriviBozza('u1:nulla', null);
        expect(leggiBozza('u1:nulla')).toBeNull();
    });

    it('un allegato senza testo è una bozza', () => {
        scriviBozza('u1:solo-allegato', { testo: '', allegato: ALLEGATO });
        expect(leggiBozza('u1:solo-allegato')).toEqual({ testo: '', allegato: ALLEGATO });
    });

    it('senza chiave non si scrive e non si legge niente', () => {
        scriviBozza(undefined, { testo: 'senza chiave', allegato: null });
        scriviBozza('', { testo: 'chiave vuota', allegato: null });
        expect(leggiBozza(undefined)).toBeNull();
        expect(leggiBozza('')).toBeNull();
    });
});
