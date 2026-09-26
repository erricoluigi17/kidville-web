import { describe, it, expect } from 'vitest';
import {
    orarioAttivita,
    oraDiLatoAttivita,
    attivitaCompilata,
    oraAttivitaValida,
} from '@/lib/diary/attivita';
import { voceDaMostrare } from '@/lib/diary/registrazione';

/**
 * ORARIO DI CIASCUNA ATTIVITÀ (D1, 26/09/2026).
 *
 * Ogni voce di `dettagli.activities[]` può portare `ora_inizio` e `ora_fine`
 * ("HH:MM", 24 ore), entrambi facoltativi. Il genitore vede a lato della voce
 * l'ora di inizio della PRIMA attività dell'elenco; se manca, l'ora del
 * salvataggio — e quella la formatta il chiamante: qui si restituisce `null`.
 */

describe('oraAttivitaValida — solo HH:MM a 24 ore', () => {
    it.each(['00:00', '09:30', '12:05', '23:59'])('%s è valida', (v) => {
        expect(oraAttivitaValida(v)).toBe(true);
    });
    it.each(['24:00', '9:30', '09:60', '09:3', '0930', '09:30:00', 'ab:cd', '', ' ', null, undefined, 930])(
        '%s NON è valida',
        (v) => {
            expect(oraAttivitaValida(v)).toBe(false);
        },
    );
});

describe('orarioAttivita(voce)', () => {
    it('restituisce inizio e fine quando entrambi sono validi', () => {
        expect(orarioAttivita({ tipo: 'pittura', ora_inizio: '10:00', ora_fine: '11:00' }))
            .toEqual({ inizio: '10:00', fine: '11:00' });
    });

    it('stringa vuota → null (è ciò che manda un <input type="time"> lasciato vuoto)', () => {
        expect(orarioAttivita({ ora_inizio: '', ora_fine: '' })).toEqual({ inizio: null, fine: null });
    });

    it('solo inizio, solo fine: ciascuno è facoltativo da solo', () => {
        expect(orarioAttivita({ ora_inizio: '09:15' })).toEqual({ inizio: '09:15', fine: null });
        expect(orarioAttivita({ ora_fine: '12:00' })).toEqual({ inizio: null, fine: '12:00' });
    });

    it('un valore fuori formato NON passa per buono: diventa null', () => {
        expect(orarioAttivita({ ora_inizio: '25:00', ora_fine: '9:30' })).toEqual({ inizio: null, fine: null });
        expect(orarioAttivita({ ora_inizio: 930 as unknown as string })).toEqual({ inizio: null, fine: null });
    });

    it('gli spazi intorno si tolgono', () => {
        expect(orarioAttivita({ ora_inizio: ' 08:45 ' })).toEqual({ inizio: '08:45', fine: null });
    });

    it('voce assente o non-oggetto → entrambi null, senza lanciare', () => {
        expect(orarioAttivita(null)).toEqual({ inizio: null, fine: null });
        expect(orarioAttivita(undefined)).toEqual({ inizio: null, fine: null });
        expect(orarioAttivita('pittura')).toEqual({ inizio: null, fine: null });
    });
});

describe('oraDiLatoAttivita(dettagli, timestampSalvataggio)', () => {
    const TS = '2026-09-26T08:12:00.000Z';

    it('è l\'ora di inizio della PRIMA attività dell\'elenco', () => {
        expect(oraDiLatoAttivita({
            activities: [
                { tipo: 'pittura', descrizione: 'autunno', ora_inizio: '10:00', ora_fine: '11:00' },
                { tipo: 'musica', descrizione: 'canti', ora_inizio: '08:30' },
            ],
        }, TS)).toBe('10:00');
    });

    it('la prima senza inizio → null, ANCHE se una successiva lo ha (non si pesca la prima valorizzata)', () => {
        expect(oraDiLatoAttivita({
            activities: [
                { tipo: 'pittura', descrizione: 'autunno', ora_fine: '11:00' },
                { tipo: 'musica', descrizione: 'canti', ora_inizio: '08:30' },
            ],
        }, TS)).toBeNull();
    });

    it('niente attività, dettagli assenti o inizio non valido → null (il chiamante usa il salvataggio)', () => {
        expect(oraDiLatoAttivita({ activities: [] }, TS)).toBeNull();
        expect(oraDiLatoAttivita({}, TS)).toBeNull();
        expect(oraDiLatoAttivita(null, TS)).toBeNull();
        expect(oraDiLatoAttivita({ activities: [{ ora_inizio: '' }] }, TS)).toBeNull();
        expect(oraDiLatoAttivita({ activities: [{ ora_inizio: '99:99' }] }, TS)).toBeNull();
        expect(oraDiLatoAttivita({ activities: 'x' }, TS)).toBeNull();
    });

    it('accetta anche la VOCE di diario intera ({ dettagli }) e il secondo argomento è facoltativo', () => {
        expect(oraDiLatoAttivita({ tipo_evento: 'attivita', dettagli: { activities: [{ ora_inizio: '09:00' }] } }))
            .toBe('09:00');
    });

    it('non restituisce MAI l\'ora del salvataggio: quella la formatta il chiamante nel suo fuso', () => {
        expect(oraDiLatoAttivita({ activities: [{ descrizione: 'x' }] }, TS)).toBeNull();
    });
});

describe('attivitaCompilata: un orario da solo NON è contenuto', () => {
    it('una voce con solo inizio e fine non rende compilata la registrazione', () => {
        expect(attivitaCompilata({ activities: [{ tipo: 'pittura', descrizione: '', ora_inizio: '10:00', ora_fine: '11:00' }] }))
            .toBe(false);
        // …e quindi il server la salta come voce muta (stessa regola dei lettori).
        expect(voceDaMostrare('attivita', { activities: [{ tipo: 'pittura', ora_inizio: '10:00' }] })).toBe(false);
    });

    it('con una descrizione, l\'orario accanto non cambia niente: resta compilata', () => {
        expect(attivitaCompilata({ activities: [{ tipo: 'pittura', descrizione: 'autunno', ora_inizio: '10:00' }] }))
            .toBe(true);
    });
});
