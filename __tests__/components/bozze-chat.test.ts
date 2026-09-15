// @vitest-environment node
/**
 * `bozze-chat.ts` — la memoria delle bozze, da sola (parte C, 2026-09-15).
 *
 * Il comportamento che si vede sta in `chat-input-bozze.test.tsx`. Qui il contratto del modulo, e in
 * particolare la metà che il campo di scrittura non mostra: una bozza vuota non resta in memoria. Il
 * testo di un messaggio già mandato non ha motivo di sopravvivere, nemmeno come stringa vuota accanto
 * all'id di una conversazione.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    ascoltaBozza,
    concludiInvio,
    iniziaInvio,
    invioInVolo,
    leggiBozza,
    scriviBozza,
} from '@/components/features/chat/bozze-chat';

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

    /**
     * L'ascolto esiste per i campi che mostrano la bozza (2026-09-15): l'esito di un invio si scrive qui
     * anche quando il campo che l'ha mandato non c'è più, e ogni campo montato della stessa conversazione
     * deve vederlo. Senza avviso, un campo rimontato durante l'invio terrebbe il messaggio già consegnato.
     */
    it('chi ascolta una conversazione sa quando la sua bozza cambia, e dopo aver smesso non sa più niente', () => {
        const avviso = vi.fn();
        const smetti = ascoltaBozza('u1:ascolto', avviso);

        scriviBozza('u1:ascolto', { testo: 'a', allegato: null });
        expect(avviso).toHaveBeenCalledTimes(1);
        scriviBozza('u1:altra', { testo: 'b', allegato: null });
        expect(avviso, 'la bozza di un’altra conversazione ha avvisato chi ascolta questa').toHaveBeenCalledTimes(1);
        scriviBozza('u1:ascolto', null);
        expect(avviso).toHaveBeenCalledTimes(2);
        scriviBozza('u1:ascolto', null);
        expect(avviso, 'cancellare una bozza che non c’è non cambia niente').toHaveBeenCalledTimes(2);

        smetti();
        scriviBozza('u1:ascolto', { testo: 'c', allegato: null });
        expect(avviso).toHaveBeenCalledTimes(2);
    });

    it('senza chiave non si ascolta niente', () => {
        const avviso = vi.fn();
        const smetti = ascoltaBozza(undefined, avviso);
        scriviBozza(undefined, { testo: 'senza chiave', allegato: null });
        expect(avviso).not.toHaveBeenCalled();
        expect(() => smetti()).not.toThrow();
    });

    /**
     * L'invio in volo è della conversazione, come la bozza: un campo rimontato mentre la POST attende non
     * deve poter mandare lo stesso messaggio una seconda volta.
     */
    it('un invio in volo è della conversazione: avvisa chi ascolta, e finisce quando finiscono tutti', () => {
        const avviso = vi.fn();
        const smetti = ascoltaBozza('u1:volo', avviso);
        expect(invioInVolo('u1:volo')).toBe(false);

        iniziaInvio('u1:volo');
        expect(invioInVolo('u1:volo')).toBe(true);
        expect(avviso, 'chi mostra la conversazione non sa che un invio è partito').toHaveBeenCalled();
        expect(invioInVolo('u1:altra'), 'un invio in volo ha fermato un’altra conversazione').toBe(false);

        iniziaInvio('u1:volo');
        concludiInvio('u1:volo');
        expect(invioInVolo('u1:volo'), 'finito uno dei due invii, l’altro è ancora in volo').toBe(true);

        const primaDellaFine = avviso.mock.calls.length;
        concludiInvio('u1:volo');
        expect(invioInVolo('u1:volo')).toBe(false);
        expect(avviso.mock.calls.length, 'chi mostra la conversazione non sa che l’invio è finito').toBeGreaterThan(primaDellaFine);
        smetti();
    });

    it('un concludi senza inizio non porta il conto sotto zero, e senza chiave non c’è niente in volo', () => {
        concludiInvio('u1:mai-partito');
        iniziaInvio('u1:mai-partito');
        expect(invioInVolo('u1:mai-partito')).toBe(true);
        concludiInvio('u1:mai-partito');
        expect(invioInVolo('u1:mai-partito')).toBe(false);

        iniziaInvio(undefined);
        expect(invioInVolo(undefined)).toBe(false);
        expect(() => concludiInvio(undefined)).not.toThrow();
    });
});
