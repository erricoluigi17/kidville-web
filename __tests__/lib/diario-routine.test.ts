import { describe, it, expect } from 'vitest';

import {
    routineBaseAttive,
    tipiAttivi,
    routinePersonalizzate,
    tipoDiRoutine,
    idDiTipo,
    eRoutinePersonalizzata,
    valoreRoutineValido,
    routineCompilata,
    dettagliRoutine,
    type RoutinePersonalizzata,
} from '@/lib/diary/routine';

/**
 * LE ROUTINE DEL DIARIO, DECISE DALLA SEDE (2026-09-28).
 *
 * Fino a oggi `diario_config.routine_attive` si salvava e il codice ne leggeva solo `umore`:
 * spegnere «Pasto» non toglieva il pasto a nessuno. Il titolare ha chiesto che le routine
 * funzionino — pasto, sonno, cambio, attività — e che la segreteria possa aggiungerne di sue.
 *
 * Tre insidie misurate prima di scrivere una riga:
 *  · DUE VOCABOLARI. Le sedi vere salvano i NOMI delle routine (`pasto`, `sonno`…); il seed
 *    E2E salva i CODICI dei tipi (`pranzo`, `nanna_inizio`…). Si accettano entrambi.
 *  · ASSENTE ≠ VUOTA. Una sede nuova ha `diario_config = {}`: lì valgono le routine di sempre
 *    (tutto acceso tranne l'umore). Una lista VUOTA invece è una scelta: tutto spento.
 *  · Il 28/09 le tre sedi vere avevano pasto, sonno, cambio e attività accese: accendere il
 *    filtro non toglie niente a nessuno.
 */

const CREMA: RoutinePersonalizzata = {
    id: 'a1b2c3d4', nome: 'Crema solare', emoji: '🧴', risposta: 'spunta', opzioni: [], multipla: false, attiva: true,
};
const BIBERON: RoutinePersonalizzata = {
    id: 'e5f6a7b8', nome: 'Biberon', emoji: '🍼', risposta: 'scelta', opzioni: ['Poco', 'Metà', 'Tutto'], multipla: false, attiva: true,
};

describe('routineBaseAttive — quali routine base sono accese', () => {
    it('config assente: le routine di sempre, senza l\'umore', () => {
        expect([...routineBaseAttive(undefined)].sort()).toEqual(['attivita', 'cambio', 'pasto', 'sonno']);
        expect([...routineBaseAttive(null)].sort()).toEqual(['attivita', 'cambio', 'pasto', 'sonno']);
        expect([...routineBaseAttive('pasto')].sort(), 'un valore che non è una lista vale «assente»').toEqual(['attivita', 'cambio', 'pasto', 'sonno']);
    });

    it('lista vuota: tutto spento — è una scelta, non un\'assenza', () => {
        expect(routineBaseAttive([]).size).toBe(0);
    });

    it('i nomi delle routine (sedi vere) e i codici dei tipi (seed E2E) valgono uguale', () => {
        expect([...routineBaseAttive(['sonno', 'cambio'])].sort()).toEqual(['cambio', 'sonno']);
        expect([...routineBaseAttive(['merenda', 'nanna_fine', 'bagno', 'umore'])].sort()).toEqual(['cambio', 'pasto', 'sonno', 'umore']);
    });

    it('ciò che non è una routine si ignora', () => {
        expect([...routineBaseAttive(['pasto', 'foo', 42, null])]).toEqual(['pasto']);
    });
});

describe('tipiAttivi — i bottoni della maestra, nell\'ordine di sempre', () => {
    it('config assente: i sei tipi di sempre, senza l\'umore', () => {
        expect(tipiAttivi({})).toEqual(['attivita', 'merenda', 'pranzo', 'nanna_inizio', 'nanna_fine', 'bagno']);
    });

    it('spento il pasto spariscono pranzo e merenda; spento il sonno, nanna e sveglia', () => {
        expect(tipiAttivi({ routine_attive: ['attivita', 'cambio', 'umore'] })).toEqual(['attivita', 'bagno', 'umore']);
    });

    it('le routine della scuola vengono dopo, solo se attive', () => {
        const spenta = { ...BIBERON, attiva: false };
        expect(tipiAttivi({ routine_attive: ['cambio'], routine_personalizzate: [CREMA, spenta] }))
            .toEqual(['bagno', 'routine:a1b2c3d4']);
    });
});

describe('routinePersonalizzate — la lista salvata, letta con sospetto', () => {
    it('tiene le voci valide e scarta le altre, senza far cadere la lista intera', () => {
        const lette = routinePersonalizzate([
            CREMA,
            { ...BIBERON, opzioni: ['Solo una'] },                // scelta con una sola opzione
            { ...CREMA, id: 'NON VALIDO' },                         // id fuori formato
            { ...CREMA, id: 'c0c0c0c0', nome: '   ' },              // nome vuoto
            { ...CREMA, id: 'd0d0d0d0', risposta: 'pallone' },     // risposta inesistente
            { ...CREMA },                                            // id doppio
            'ciao',
        ]);
        expect(lette.map((r) => r.id)).toEqual(['a1b2c3d4']);
    });

    it('non è una lista ⇒ nessuna routine', () => {
        expect(routinePersonalizzate(undefined)).toEqual([]);
        expect(routinePersonalizzate({})).toEqual([]);
    });
});

describe('tipo di voce di una routine della scuola', () => {
    it('va e torna, e non si confonde con i tipi base', () => {
        expect(tipoDiRoutine('a1b2c3d4')).toBe('routine:a1b2c3d4');
        expect(idDiTipo('routine:a1b2c3d4')).toBe('a1b2c3d4');
        expect(idDiTipo('pranzo')).toBeNull();
        expect(idDiTipo('routine:../../x')).toBeNull();
        expect(eRoutinePersonalizzata('routine:a1b2c3d4')).toBe(true);
        expect(eRoutinePersonalizzata('routine:')).toBe(false);
        expect(eRoutinePersonalizzata('bagno')).toBe(false);
    });
});

describe('valoreRoutineValido — ciò che la maestra ha segnato, per ogni tipo di risposta', () => {
    it('spunta: solo `true`', () => {
        expect(valoreRoutineValido(CREMA, true)).toBe(true);
        expect(valoreRoutineValido(CREMA, false)).toBe(false);
        expect(valoreRoutineValido(CREMA, 'sì')).toBe(false);
    });

    it('scelta singola: UNA opzione fra quelle della segreteria', () => {
        expect(valoreRoutineValido(BIBERON, ['Metà'])).toBe(true);
        expect(valoreRoutineValido(BIBERON, ['Metà', 'Tutto']), 'due scelte su una scelta singola').toBe(false);
        expect(valoreRoutineValido(BIBERON, ['Doppio'])).toBe(false);
        expect(valoreRoutineValido(BIBERON, [])).toBe(false);
    });

    it('scelta multipla: una o più, senza doppioni', () => {
        const multi = { ...BIBERON, multipla: true };
        expect(valoreRoutineValido(multi, ['Poco', 'Tutto'])).toBe(true);
        expect(valoreRoutineValido(multi, ['Poco', 'Poco'])).toBe(false);
    });

    it('orario: HH:MM', () => {
        const ora = { ...CREMA, risposta: 'orario' as const };
        expect(valoreRoutineValido(ora, '10:30')).toBe(true);
        expect(valoreRoutineValido(ora, '9:30')).toBe(false);
        expect(valoreRoutineValido(ora, '24:00')).toBe(false);
    });

    it('testo: da 1 a 200 caratteri dopo il trim', () => {
        const testo = { ...CREMA, risposta: 'testo' as const };
        expect(valoreRoutineValido(testo, 'ha dormito in braccio')).toBe(true);
        expect(valoreRoutineValido(testo, '   ')).toBe(false);
        expect(valoreRoutineValido(testo, 'x'.repeat(201))).toBe(false);
    });
});

describe('routineCompilata — la voce salvata dice qualcosa?', () => {
    it('legge la fotografia salvata nella voce, senza bisogno della definizione', () => {
        expect(routineCompilata(dettagliRoutine(CREMA, true))).toBe(true);
        expect(routineCompilata(dettagliRoutine(CREMA, null))).toBe(false);
        expect(routineCompilata(dettagliRoutine(BIBERON, ['Poco']))).toBe(true);
        expect(routineCompilata(dettagliRoutine(BIBERON, []))).toBe(false);
        expect(routineCompilata({ risposta: 'orario', valore: '' })).toBe(false);
        expect(routineCompilata(null)).toBe(false);
    });

    it('la fotografia porta nome, icona e tipo: la voce resta leggibile anche se la routine sparisce', () => {
        expect(dettagliRoutine(BIBERON, ['Tutto'])).toEqual({ nome: 'Biberon', emoji: '🍼', risposta: 'scelta', valore: ['Tutto'] });
    });
});
