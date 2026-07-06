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
  withLivelloFilter,
}: {
  value: string[];
  onChange: (names: string[]) => void;
  grado?: string; // csv es. 'nido,infanzia'; assente = tutti i gradi
  emptyHint?: string;
  // Tendina "Livello (classe)" sopra i chip: filtra le sezioni per school_type
  // (Nido/Infanzia/Primaria) lato client. Usata da mensa e armadietto.
  withLivelloFilter?: boolean;
}) {
  const [gruppi, setGruppi] = useState<Gruppo[]>([]);
  const [loading, setLoading] = useState(true);
  const [livello, setLivello] = useState('');

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

  const LIVELLI = [
    { v: '', l: 'Tutti i livelli' },
    { v: 'nido', l: 'Nido' },
    { v: 'infanzia', l: 'Infanzia' },
    { v: 'primaria', l: 'Primaria' },
  ];
  const gruppiPieni = gruppi
    .map((g) => ({ ...g, sezioni: livello ? g.sezioni.filter((s) => s.school_type === livello) : g.sezioni }))
    .filter((g) => g.sezioni.length > 0);
  const multiSede = gruppiPieni.length > 1;

  return (
    <div className="space-y-3">
      {withLivelloFilter && (
        <div className="flex items-center gap-2">
          <label className="font-maven text-[11px] uppercase tracking-wider text-kidville-muted">Livello (classe)</label>
          <select
            value={livello}
            onChange={(e) => setLivello(e.target.value)}
            className="font-maven rounded-pill border border-kidville-line bg-white px-3 py-1.5 text-sm"
          >
            {LIVELLI.map((l) => (
              <option key={l.v} value={l.v}>{l.l}</option>
            ))}
          </select>
        </div>
      )}
      {gruppiPieni.length === 0 ? (
        <p className="font-maven text-sm text-kidville-muted">{emptyHint ?? 'Nessuna sezione disponibile.'}</p>
      ) : (
        gruppiPieni.map((g) => (
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
        ))
      )}
    </div>
  );
}
