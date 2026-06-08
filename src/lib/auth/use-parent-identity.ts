'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { getCurrentParentId, getCurrentStudentId, DEV_PARENT_ID, DEFAULT_STUDENT_ID } from './current-user';

export interface ParentIdentity {
  parentId: string;
  studentId: string;
  ready: boolean; // false finché l'auto-resolve non è completato
}

/**
 * Risolve parentId e studentId per le pagine genitore.
 * Se lo studentId in URL/localStorage è il fallback demo,
 * recupera il figlio reale dal DB tramite legame_genitori_alunni.
 */
export function useParentIdentity(): ParentIdentity {
  const searchParams = useSearchParams();
  const parentId = getCurrentParentId(searchParams);
  const [studentId, setStudentId] = useState<string>(() => getCurrentStudentId(searchParams));
  const [ready, setReady] = useState<boolean>(() => {
    // Già pronto se lo studentId è esplicito nell'URL o non è il fallback demo
    const fromUrl = searchParams.get('id');
    return !!fromUrl || getCurrentStudentId(searchParams) !== DEFAULT_STUDENT_ID;
  });

  useEffect(() => {
    const fromUrl = searchParams.get('id');
    const current = getCurrentStudentId(searchParams);

    // Se l'ID è esplicito nell'URL, è già corretto e va persistito (così la
    // scelta del figlio sopravvive alla navigazione tra le pagine).
    if (fromUrl) {
      try { localStorage.setItem('kv_student_id', fromUrl); } catch { /* ignore */ }
      setStudentId(fromUrl);
      setReady(true);
      return;
    }

    // Se non è il fallback demo, è già persistito in localStorage
    if (current !== DEFAULT_STUDENT_ID) { setStudentId(current); setReady(true); return; }

    // Auto-resolve: chiedi al backend i figli del genitore
    fetch(`/api/parent/students?userId=${parentId}`, {
      headers: { 'x-user-id': parentId },
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const first = d?.data?.[0];
        if (!first?.id) { setReady(true); return; }
        try { localStorage.setItem('kv_student_id', first.id); } catch { /* ignore */ }
        setStudentId(first.id);
        setReady(true);
      })
      .catch(() => setReady(true));
  }, [parentId, searchParams]);

  return { parentId, studentId, ready };
}
