'use client';

import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { getCurrentStudentId } from '@/lib/auth/current-user';

/**
 * Conteggio comunicazioni "da gestire" per il badge della campanella (AppBar).
 * Solo lato genitore: usa gli endpoint ESISTENTI (`/api/diary/students` +
 * `/api/avvisi`, stessa logica di AvvisiPreview) — nessuna colonna/endpoint
 * nuovi (vincolo drift DB E2E CI). Lato docente non esiste read-state → null.
 * Qualunque errore o identità non risolta → null → campanella senza badge.
 */
export function useAvvisiUnread(area: 'teacher' | 'parent', userId: string | null): number | null {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [count, setCount] = useState<number | null>(null);

  // Sul percorso avvisi il badge si azzera subito (l'utente sta leggendo);
  // al ritorno l'effect sotto rifà il conteggio aggiornato.
  const onAvvisi = pathname.startsWith('/parent/avvisi');

  useEffect(() => {
    if (area !== 'parent' || !userId || onAvvisi) return;
    let active = true;

    (async () => {
      try {
        // studentId: URL → localStorage → primo figlio (stessa cascata di
        // useParentIdentity; il fetch extra scatta solo al primissimo accesso).
        let studentId = getCurrentStudentId(searchParams);
        if (!studentId) {
          const res = await fetch(`/api/parent/students?userId=${userId}`, {
            headers: { 'x-user-id': userId },
          }).catch(() => null);
          const d = res?.ok ? await res.json().catch(() => null) : null;
          studentId = d?.data?.[0]?.id ?? null;
        }
        if (!studentId) return;

        const sres = await fetch(`/api/diary/students?id=${studentId}`);
        const student = sres.ok ? await sres.json().catch(() => null) : null;
        const classe = student?.classe_sezione;
        if (!classe) return;

        const res = await fetch(
          `/api/avvisi?classe=${encodeURIComponent(classe)}&parentId=${userId}&studentId=${studentId}`,
        );
        const data = res.ok ? await res.json().catch(() => null) : null;
        if (!active || !Array.isArray(data)) return;

        const unread = data.filter((a) =>
          a?.tipo === 'adesione' ? !a?.my_response?.risposta : !a?.my_response?.letto_il,
        ).length;
        setCount(unread > 0 ? unread : null);
      } catch {
        /* best-effort: nessun badge */
      }
    })();

    return () => {
      active = false;
    };
  }, [area, userId, onAvvisi, searchParams]);

  return area === 'parent' && !onAvvisi ? count : null;
}
