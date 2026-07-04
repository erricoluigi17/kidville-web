'use client';

import { useEffect, useState } from 'react';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';

interface Figlio { id: string; nome: string; cognome: string; classe_sezione?: string | null }

function initials(nome: string, cognome: string) {
  return `${nome?.[0] ?? ''}${cognome?.[0] ?? ''}`.toUpperCase();
}

/**
 * Selettore del figlio per i genitori con più figli — chip ad avatar orizzontali
 * (design DR KvUI.ChildSwitcher). Persiste la scelta in localStorage
 * (kv_student_id) e ricarica, così tutte le pagine genitore mostrano il figlio
 * selezionato. Si nasconde se c'è meno di 2 figli.
 */
export function ChildSwitcher() {
  const { parentId, studentId, ready } = useParentIdentity();
  const [figli, setFigli] = useState<Figlio[]>([]);

  useEffect(() => {
    if (!parentId) return;
    fetch(`/api/parent/students?userId=${parentId}`, { headers: { 'x-user-id': parentId } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setFigli(d?.data ?? []))
      .catch(() => {});
  }, [parentId]);

  // Niente da scegliere: non mostrare nulla.
  if (!ready || figli.length < 2) return null;

  const onSelect = (id: string) => {
    if (!id || id === studentId) return;
    try { localStorage.setItem('kv_student_id', id); } catch { /* ignore */ }
    // Ricarico così ogni hook/identità rilegge il nuovo figlio.
    window.location.reload();
  };

  return (
    <div
      className="flex gap-2.5 overflow-x-auto px-5 pt-3 pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      role="tablist"
      aria-label="Seleziona figlio"
    >
      {figli.map((f) => {
        const on = f.id === studentId;
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => onSelect(f.id)}
            role="tab"
            aria-selected={on}
            className="flex flex-shrink-0 items-center gap-2.5 rounded-pill transition-all"
            style={{
              padding: on ? '6px 16px 6px 6px' : '6px',
              background: on ? '#006A5F' : '#FFFFFF',
              boxShadow: on ? '0 6px 16px -8px rgba(0,90,80,.5)' : '0 2px 8px -5px rgba(0,0,0,.18)',
            }}
          >
            <span
              className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-full font-barlow text-[14px] font-black"
              style={{ background: '#006A5F', color: '#FDC400' }}
            >
              {initials(f.nome, f.cognome)}
            </span>
            {on && (
              <span className="text-left">
                <span className="block font-barlow text-sm font-extrabold uppercase leading-none tracking-wide text-white">
                  {f.nome}
                </span>
                {f.classe_sezione && (
                  <span className="block font-maven text-[10.5px] font-semibold text-kidville-yellow">
                    {f.classe_sezione}
                  </span>
                )}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
