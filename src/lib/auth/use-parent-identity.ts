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
  // Inizializza solo dall'URL per evitare hydration mismatch (localStorage non
  // è disponibile durante SSR). Il useEffect aggiorna dal localStorage dopo mount.
  const fromUrl = searchParams.get('id');
  const [studentId, setStudentId] = useState<string>(fromUrl ?? DEFAULT_STUDENT_ID);
  const [ready, setReady] = useState<boolean>(!!fromUrl);

  useEffect(() => {
    const urlId = searchParams.get('id');

    // Se l'ID è esplicito nell'URL, è già corretto e va persistito.
    if (urlId) {
      try { localStorage.setItem('kv_student_id', urlId); } catch { /* ignore */ }
      setStudentId(urlId);
      setReady(true);
      return;
    }

    // Leggi da localStorage (solo lato client, dopo mount)
    const stored = getCurrentStudentId(searchParams);
    if (stored !== DEFAULT_STUDENT_ID) { setStudentId(stored); setReady(true); return; }

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
