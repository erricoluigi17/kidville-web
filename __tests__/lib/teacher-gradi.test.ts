import { describe, expect, it } from 'vitest';
import {
    deriveGradiFlags,
    diarioVisibile,
    visibileDocente,
    type TeacherGradiCtx,
} from '@/lib/auth/teacher-gradi';

const ctx = (over: Partial<TeacherGradiCtx> = {}): TeacherGradiCtx => ({
    ready: true,
    hasInfanzia: false,
    hasPrimaria: false,
    ...over,
});

describe('deriveGradiFlags', () => {
    it('riconosce il docente solo-primaria', () => {
        expect(deriveGradiFlags(['primaria'])).toEqual({
            hasInfanzia: false,
            hasPrimaria: true,
            isPrimariaOnly: true,
            isInfanziaOnly: false,
        });
    });

    it('il nido conta come infanzia', () => {
        expect(deriveGradiFlags(['nido'])).toEqual({
            hasInfanzia: true,
            hasPrimaria: false,
            isPrimariaOnly: false,
            isInfanziaOnly: true,
        });
    });

    it('docente misto: nessuna esclusiva', () => {
        expect(deriveGradiFlags(['infanzia', 'primaria'])).toEqual({
            hasInfanzia: true,
            hasPrimaria: true,
            isPrimariaOnly: false,
            isInfanziaOnly: false,
        });
    });

    it('gradi vuoti (staff/admin): nessun flag', () => {
        expect(deriveGradiFlags([])).toEqual({
            hasInfanzia: false,
            hasPrimaria: false,
            isPrimariaOnly: false,
            isInfanziaOnly: false,
        });
    });
});

describe('visibileDocente', () => {
    it('con dato non pronto non filtra nulla (comportamento storico)', () => {
        const c = ctx({ ready: false });
        expect(visibileDocente('comune', c)).toBe(true);
        expect(visibileDocente('primaria', c)).toBe(true);
        expect(visibileDocente('infanzia', c)).toBe(true);
    });

    it('con gradi vuoti (staff/admin in area docente) non filtra nulla', () => {
        const c = ctx();
        expect(visibileDocente('comune', c)).toBe(true);
        expect(visibileDocente('primaria', c)).toBe(true);
        expect(visibileDocente('infanzia', c)).toBe(true);
    });

    it('solo-primaria: niente voci infanzia, sì primaria e comune', () => {
        const c = ctx({ hasPrimaria: true });
        expect(visibileDocente('comune', c)).toBe(true);
        expect(visibileDocente('primaria', c)).toBe(true);
        expect(visibileDocente('infanzia', c)).toBe(false);
    });

    it('solo-infanzia: niente voci primaria, sì infanzia e comune', () => {
        const c = ctx({ hasInfanzia: true });
        expect(visibileDocente('comune', c)).toBe(true);
        expect(visibileDocente('primaria', c)).toBe(false);
        expect(visibileDocente('infanzia', c)).toBe(true);
    });

    it('docente misto vede tutto', () => {
        const c = ctx({ hasInfanzia: true, hasPrimaria: true });
        expect(visibileDocente('comune', c)).toBe(true);
        expect(visibileDocente('primaria', c)).toBe(true);
        expect(visibileDocente('infanzia', c)).toBe(true);
    });
});

describe('diarioVisibile (eccezione E24)', () => {
    it('solo-primaria senza attivazione admin: Diario nascosto', () => {
        expect(diarioVisibile(ctx({ hasPrimaria: true }))).toBe(false);
    });

    it('solo-primaria con diario attivato per la primaria: Diario visibile', () => {
        expect(diarioVisibile(ctx({ hasPrimaria: true, diarioPrimariaVisibile: true }))).toBe(true);
    });

    it("l'eccezione E24 non riapre le ALTRE voci infanzia", () => {
        const c = ctx({ hasPrimaria: true, diarioPrimariaVisibile: true });
        expect(visibileDocente('infanzia', c)).toBe(false);
    });

    it('solo-infanzia: Diario sempre visibile', () => {
        expect(diarioVisibile(ctx({ hasInfanzia: true }))).toBe(true);
    });

    it('non pronto: Diario visibile (nessun filtro)', () => {
        expect(diarioVisibile(ctx({ ready: false }))).toBe(true);
    });
});
