'use client';

import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';

interface Figlio { id: string; nome: string; cognome: string; classe_sezione?: string | null }

/**
 * Selettore del figlio per i genitori con più figli. Persiste la scelta in
 * localStorage (kv_student_id) e ricarica, così tutte le pagine genitore
 * (Registro, Lezioni, Diario, …) mostrano il figlio selezionato.
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

  const onChange = (id: string) => {
    if (!id || id === studentId) return;
    try { localStorage.setItem('kv_student_id', id); } catch { /* ignore */ }
    // Ricarico così ogni hook/identità rilegge il nuovo figlio.
    window.location.reload();
  };

  return (
    <div className="flex items-center gap-2 px-5 pt-3">
      <Users size={15} className="text-kidville-green shrink-0" />
      <select
        value={studentId}
        onChange={(e) => onChange(e.target.value)}
        className="font-maven rounded-pill border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700"
        aria-label="Seleziona figlio"
      >
        {figli.map((f) => (
          <option key={f.id} value={f.id}>
            {f.nome} {f.cognome}{f.classe_sezione ? ` · ${f.classe_sezione}` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
