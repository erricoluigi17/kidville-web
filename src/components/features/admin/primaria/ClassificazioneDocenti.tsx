'use client';

import { useCallback, useEffect, useState } from 'react';

interface Docente {
  id: string;
  nome: string;
  cognome: string;
  email?: string;
  gradi?: string[];
}

const GRADI: { key: string; label: string }[] = [
  { key: 'nido', label: 'Nido' },
  { key: 'infanzia', label: 'Infanzia' },
  { key: 'primaria', label: 'Primaria' },
];

export function ClassificazioneDocenti({ scuolaId, userId }: { scuolaId: string; userId: string }) {
  const [docenti, setDocenti] = useState<Docente[]>([]);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    let next: Docente[] | null = null;
    try {
      const r = await fetch(`/api/admin/primaria/docente-gradi?scuolaId=${scuolaId}`);
      const d = await r.json();
      next = d.success ? d.data : [];
    } finally {
      if (next) setDocenti(next);
    }
  }, [scuolaId]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleGrado = async (doc: Docente, grado: string) => {
    const current = new Set(doc.gradi ?? []);
    if (current.has(grado)) current.delete(grado);
    else current.add(grado);
    const gradi = Array.from(current);
    setSaving(doc.id);
    // ottimistico
    setDocenti((prev) => prev.map((d) => (d.id === doc.id ? { ...d, gradi } : d)));
    await fetch(`/api/admin/primaria/docente-gradi?userId=${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ utenteId: doc.id, gradi }),
    });
    setSaving(null);
  };

  return (
    <div className="space-y-2">
      <p className="font-maven text-sm text-kidville-muted">
        Imposta a quali gradi è abilitato ciascun docente. Le funzioni visibili (registro/valutazioni vs diario)
        dipendono da questa classificazione e dalla matrice funzioni.
      </p>
      <table className="w-full text-sm font-maven">
        <thead>
          <tr className="text-left text-kidville-muted">
            <th className="py-2">Docente</th>
            {GRADI.map((g) => (
              <th key={g.key} className="py-2 text-center">{g.label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-kidville-line">
          {docenti.map((doc) => (
            <tr key={doc.id} className={saving === doc.id ? 'opacity-60' : ''}>
              <td className="py-2.5">
                <span className="text-kidville-ink">{doc.nome} {doc.cognome}</span>
                {doc.email && <span className="ml-2 text-xs text-kidville-muted">{doc.email}</span>}
              </td>
              {GRADI.map((g) => (
                <td key={g.key} className="py-2.5 text-center">
                  <input
                    type="checkbox"
                    checked={(doc.gradi ?? []).includes(g.key)}
                    onChange={() => toggleGrado(doc, g.key)}
                  />
                </td>
              ))}
            </tr>
          ))}
          {docenti.length === 0 && (
            <tr><td colSpan={4} className="py-3 text-kidville-muted">Nessun docente trovato.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
