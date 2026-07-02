'use client';

import { useEffect, useState } from 'react';
import { useParentIdentity } from './use-parent-identity';

export type SchoolType = 'primaria' | 'infanzia' | 'nido';

/**
 * Recupera il grado scolastico (schoolType) del figlio corrente, per filtrare il
 * menu genitore: un bimbo di primaria non vede le sezioni infanzia e viceversa.
 * `ready` è false finché il dato non è disponibile (evita flicker/nascondere a torto).
 */
export function useChildSchoolType(): { schoolType: SchoolType | null; ready: boolean } {
  const { parentId, studentId, ready: idReady } = useParentIdentity();
  const [schoolType, setSchoolType] = useState<SchoolType | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!idReady || !parentId || !studentId) return;
    let cancelled = false;
    fetch(`/api/parent/primaria?studentId=${studentId}&userId=${parentId}`, { headers: { 'x-user-id': parentId } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        setSchoolType((d?.data?.schoolType as SchoolType) ?? null);
        setReady(true);
      })
      .catch(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [idReady, studentId, parentId]);

  return { schoolType, ready };
}
