import { describe, it, expect } from 'vitest';
import * as moduloPuro from '@/lib/chat/stato-conversazione';
import * as area from '@/components/features/chat/ChatMessageArea';

/**
 * LO STATO DI UNA CONVERSAZIONE, FUORI DA REACT.
 *
 * Il 2026-09-14 il titolare ha segnalato che chi invia un messaggio lo vede DUE volte, e che a
 * volte i messaggi nuovi non ci sono. Le due pagine gemelle (`parent/chat`, `teacher/chat`)
 * tenevano la stessa logica di unione scritta due volte, ognuna con i suoi difetti: la risposta
 * della POST accodata senza guardare l'id, l'UPDATE del realtime che sovrascriveva il link
 * firmato dell'allegato, la risposta lenta di una conversazione applicata a quella aperta dopo.
 *
 * Questo modulo è la regola scritta UNA volta, senza React, fetch o window: si prova con dati e
 * basta, e ogni caso qui sotto è stato visto rosso rimettendo il difetto che descrive.
 */
describe('il tipo e la regola dell’allegato vivono nel modulo puro', () => {
    it('ChatMessageArea riesporta la STESSA allegatoMostrabile (nessuna copia che diverga)', () => {
        expect(typeof moduloPuro.allegatoMostrabile).toBe('function');
        expect(area.allegatoMostrabile).toBe(moduloPuro.allegatoMostrabile);
    });
});
