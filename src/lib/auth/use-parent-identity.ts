'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSessionIdentity } from './use-session-identity';
import { getCurrentStudentId } from './current-user';

export interface ParentIdentity {
  parentId: string | null;
  studentId: string | null;
  ready: boolean; // false finché l'auto-resolve non è completato
}

/**
 * Risolve parentId e studentId per le pagine genitore.
 * parentId viene dall'identità di sessione (URL → localStorage → /api/me →
 * null+redirect login, vedi useSessionIdentity). studentId: URL →
 * localStorage → primo figlio dal DB (legame_genitori_alunni) → null.
 * Nessun fallback demo (M4).
 */
export function useParentIdentity(): ParentIdentity {
  const session = useSessionIdentity();
  const searchParams = useSearchParams();
  // Inizializza solo dall'URL per evitare hydration mismatch (localStorage non
  // è disponibile durante SSR). Il useEffect risolve il resto dopo il mount.
  const fromUrl = searchParams.get('id');
  const [studentId, setStudentId] = useState<string | null>(fromUrl);
  const [studentReady, setStudentReady] = useState<boolean>(!!fromUrl);

  useEffect(() => {
    if (!session.ready) return;
    const parentId = session.userId;
    let cancelled = false;

    const resolve = async () => {
      let resolved: string | null = null;
      try {
        // URL esplicita o localStorage (getCurrentStudentId persiste l'URL).
        const known = getCurrentStudentId(searchParams);
        if (known) { resolved = known; return; }

        // Auto-resolve: chiedi al backend i figli del genitore.
        if (!parentId) return;
        const res = await fetch(`/api/parent/students?userId=${parentId}`, {
          headers: { 'x-user-id': parentId },
        }).catch(() => null);
        const d = res?.ok ? await res.json().catch(() => null) : null;
        const first = d?.data?.[0];
        if (first?.id) {
          try { localStorage.setItem('kv_student_id', first.id); } catch { /* ignore */ }
          resolved = first.id;
        }
      } finally {
        if (!cancelled) {
          setStudentId(resolved);
          setStudentReady(true);
        }
      }
    };
    void resolve();
    return () => { cancelled = true; };
  }, [session.ready, session.userId, searchParams]);

  return { parentId: session.userId, studentId, ready: session.ready && studentReady };
}
