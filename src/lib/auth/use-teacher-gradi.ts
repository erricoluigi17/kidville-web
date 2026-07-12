'use client';

import { useEffect, useState } from 'react';
import { deriveGradiFlags, type TeacherGradiFlags } from './teacher-gradi';

export interface TeacherGradi extends TeacherGradiFlags {
    gradi: string[];
    /** E24: diario 0-6 esposto alla primaria (caricato solo per i solo-primaria). */
    diarioPrimariaVisibile: boolean;
    /** false finché il dato non è disponibile (evita di nascondere a torto). */
    ready: boolean;
}

// Promise-cache di modulo: home docente, GradeWorldSwitch e TeacherBottomNav
// montano insieme e chiederebbero la stessa GET più volte per hard-load; così
// è una sola (la navigazione SPA riusa la cache). Su errore la entry si
// rimuove: il prossimo mount ritenta.
const gradiCache = new Map<string, Promise<string[]>>();
const diarioCache = new Map<string, Promise<boolean>>();

function fetchGradi(userId: string | null): Promise<string[]> {
    const key = userId ?? '';
    const hit = gradiCache.get(key);
    if (hit) return hit;
    const p = fetch(`/api/primaria/me${userId ? `?userId=${userId}` : ''}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => (d?.success ? ((d.data?.gradi as string[]) ?? []) : []))
        .catch(() => {
            gradiCache.delete(key);
            return [];
        });
    gradiCache.set(key, p);
    return p;
}

function fetchDiarioPrimariaVisibile(userId: string | null): Promise<boolean> {
    const key = userId ?? '';
    const hit = diarioCache.get(key);
    if (hit) return hit;
    const p = fetch(`/api/diary/config${userId ? `?userId=${userId}` : ''}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((conf) => conf?.diario_primaria_visibile === true)
        .catch(() => {
            diarioCache.delete(key);
            return false;
        });
    diarioCache.set(key, p);
    return p;
}

/**
 * Gradi del docente corrente (`utenti.gradi` via /api/primaria/me) per il
 * gating delle voci di navigazione — mirror di useChildSchoolType lato
 * genitore. Il fetch parte anche con userId null: l'identità si risolve dal
 * cookie di sessione (come già fa GradeWorldSwitch).
 */
export function useTeacherGradi(userId: string | null): TeacherGradi {
    const [gradi, setGradi] = useState<string[]>([]);
    const [diarioPrimariaVisibile, setDiarioPrimariaVisibile] = useState(false);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        let active = true;
        fetchGradi(userId).then(async (g) => {
            if (!active) return;
            const { hasPrimaria, hasInfanzia } = deriveGradiFlags(g);
            // E24: serve solo ai profili senza infanzia (per gli altri il
            // Diario è comunque visibile) → niente fetch extra nel caso comune.
            const diario = hasPrimaria && !hasInfanzia ? await fetchDiarioPrimariaVisibile(userId) : false;
            if (!active) return;
            setGradi(g);
            setDiarioPrimariaVisibile(diario);
            setReady(true);
        });
        return () => { active = false; };
    }, [userId]);

    return { gradi, ...deriveGradiFlags(gradi), diarioPrimariaVisibile, ready };
}
