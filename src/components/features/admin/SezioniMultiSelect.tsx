'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

// Selettore multiplo di sezioni reale, alimentato da /api/admin/sections/scoped
// (scope-safe per ruolo). Il valore sono i NOMI delle sezioni, coerente con lo
// storage per-classe di mensa/armadietto (alunni.classe_sezione = nome sezione).

interface Sezione { id: string; name: string; school_type: string }
interface Gruppo { scuolaId: string; scuolaNome: string; sezioni: Sezione[] }

export function SezioniMultiSelect({
  value,
  onChange,
  grado,
  emptyHint,
}: {
  value: string[];
  onChange: (names: string[]) => void;
  grado?: string; // csv es. 'nido,infanzia'; assente = tutti i gradi
  emptyHint?: string;
}) {
  const [gruppi, setGruppi] = useState<Gruppo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const qs = grado ? `?grado=${encodeURIComponent(grado)}` : '';
    fetch(`/api/admin/sections/scoped${qs}`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setGruppi(d.data ?? []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [grado]);

  const toggle = (name: string) =>
    onChange(value.includes(name) ? value.filter((n) => n !== name) : [...value, name]);

  if (loading) {
    return (
      <span className="inline-flex items-center gap-2 font-maven text-sm text-kidville-muted">
        <Loader2 size={14} className="animate-spin" /> Caricamento sezioni…
      </span>
    );
  }

  const gruppiPieni = gruppi.filter((g) => g.sezioni.length > 0);
  if (gruppiPieni.length === 0) {
    return <p className="font-maven text-sm text-kidville-muted">{emptyHint ?? 'Nessuna sezione disponibile.'}</p>;
  }
  const multiSede = gruppiPieni.length > 1;

  return (
    <div className="space-y-3">
      {gruppiPieni.map((g) => (
        <div key={g.scuolaId}>
          {multiSede && (
            <p className="font-maven text-[11px] uppercase tracking-wider text-kidville-muted mb-1">{g.scuolaNome}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {g.sezioni.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => toggle(s.name)}
                className={`font-maven rounded-full px-3 py-1.5 text-sm transition ${
                  value.includes(s.name)
                    ? 'bg-kidville-green text-kidville-yellow'
                    : 'bg-kidville-line text-kidville-muted hover:bg-kidville-green/10'
                }`}
              >
                {s.name} <span className="opacity-60 text-xs">({s.school_type})</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
