// Gating per grado dell'area docente — mirror del pattern genitore
// (parent/BottomNav + use-child-school-type): ogni voce di navigazione ha un
// `grado` e viene mostrata solo ai profili abilitati. Logica pura, testabile
// (__tests__/lib/teacher-gradi.test.ts).

/** Grado di una voce di navigazione/scorciatoia docente. */
export type GradoVoce = 'comune' | 'primaria' | 'infanzia';

export interface TeacherGradiFlags {
    hasInfanzia: boolean;
    hasPrimaria: boolean;
    isPrimariaOnly: boolean;
    isInfanziaOnly: boolean;
}

export interface TeacherGradiCtx {
    /** false finché /api/primaria/me non ha risposto. */
    ready: boolean;
    hasInfanzia: boolean;
    hasPrimaria: boolean;
    /** E24: diario 0-6 attivato per la primaria dall'admin (fail-closed). */
    diarioPrimariaVisibile?: boolean;
}

export function deriveGradiFlags(gradi: readonly string[]): TeacherGradiFlags {
    const hasInfanzia = gradi.includes('infanzia') || gradi.includes('nido');
    const hasPrimaria = gradi.includes('primaria');
    return {
        hasInfanzia,
        hasPrimaria,
        isPrimariaOnly: hasPrimaria && !hasInfanzia,
        isInfanziaOnly: hasInfanzia && !hasPrimaria,
    };
}

/**
 * Una voce di grado `grado` è visibile al docente? Con dato non pronto o
 * profilo senza gradi (staff/admin che entra nell'area docente) NON si filtra
 * nulla: comportamento storico, niente voci nascoste a torto.
 */
export function visibileDocente(grado: GradoVoce, ctx: TeacherGradiCtx): boolean {
    if (!ctx.ready || (!ctx.hasInfanzia && !ctx.hasPrimaria)) return true;
    if (grado === 'comune') return true;
    return grado === 'primaria' ? ctx.hasPrimaria : ctx.hasInfanzia;
}

/**
 * La voce Diario ha una regola in più (E24): il diario 0-6 può essere attivato
 * per la primaria dall'admin (`diario_config.diario_primaria_visibile`) — in
 * quel caso deve comparire anche ai docenti solo-primaria. L'eccezione NON si
 * estende alle altre voci 0-6 (es. armadietto).
 */
export function diarioVisibile(ctx: TeacherGradiCtx): boolean {
    return (
        visibileDocente('infanzia', ctx) ||
        (ctx.ready && ctx.hasPrimaria && ctx.diarioPrimariaVisibile === true)
    );
}
