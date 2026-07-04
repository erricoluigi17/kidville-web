'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Sparkles } from 'lucide-react';

interface Materia {
  id: string;
  nome: string;
  codice: string;
  e_civica: boolean;
  turno_mensa: boolean;
  ordine: number;
  attiva: boolean;
}

interface Obiettivo { id: string; codice: string | null; descrizione: string; materia_codice: string }

interface Props {
  sectionId: string;
  sezione?: { name: string } | undefined;
  userId: string;
  scuolaId: string;
}

export function MaterieManager({ sectionId, sezione, userId, scuolaId }: Props) {
  const [materie, setMaterie] = useState<Materia[]>([]);
  const [loading, setLoading] = useState(true);
  const [livello, setLivello] = useState(1);
  const [nuova, setNuova] = useState({ nome: '', codice: '' });
  const [error, setError] = useState('');
  const [obiettivi, setObiettivi] = useState<Obiettivo[]>([]);
  const [assoc, setAssoc] = useState<Record<string, string>>({}); // materia_id → obiettivo_id

  const load = useCallback(async () => {
    if (!sectionId) return;
    try {
      const r = await fetch(`/api/admin/primaria/materie?sectionId=${sectionId}`, { headers: { 'x-user-id': userId } });
      const d = await r.json();
      setMaterie(d.success ? d.data : []);
    } finally {
      setLoading(false);
    }
  }, [sectionId, userId]);

  useEffect(() => {
    load();
  }, [load]);

  // Prova a dedurre il livello dal nome sezione (es. "3A" → 3).
  useEffect(() => {
    const syncLivello = () => {
      let next: number | null = null;
      try {
        const m = sezione?.name?.match(/[1-5]/);
        if (m) next = Number(m[0]);
      } finally {
        if (next !== null) setLivello(next);
      }
    };
    syncLivello();
  }, [sezione]);

  // Obiettivi della scuola per il livello dedotto + associazioni materia→obiettivo.
  useEffect(() => {
    if (!scuolaId) return;
    fetch(`/api/admin/primaria/obiettivi?scuolaId=${scuolaId}&livello=${livello}`, { headers: { 'x-user-id': userId } })
      .then((r) => r.json())
      .then((d) => { if (d.success) setObiettivi(d.data); });
  }, [scuolaId, livello, userId]);

  useEffect(() => {
    if (!sectionId) return;
    fetch(`/api/admin/primaria/materia-obiettivo?sectionId=${sectionId}`, { headers: { 'x-user-id': userId } })
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          const map: Record<string, string> = {};
          for (const row of d.data as { materia_id: string; obiettivo_id: string }[]) map[row.materia_id] = row.obiettivo_id;
          setAssoc(map);
        }
      });
  }, [sectionId, userId]);

  const setObiettivo = async (materiaId: string, obiettivoId: string) => {
    setAssoc((prev) => ({ ...prev, [materiaId]: obiettivoId }));
    await fetch(`/api/admin/primaria/materia-obiettivo?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ sectionId, materiaId, obiettivoId: obiettivoId || null }),
    });
  };

  const applyPreset = async () => {
    setError('');
    const r = await fetch(`/api/admin/primaria/materie?action=apply-preset&userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ sectionId, livello }),
    });
    const d = await r.json();
    if (!r.ok) setError(d.error || 'Errore');
    else load();
  };

  const addMateria = async () => {
    if (!nuova.nome || !nuova.codice) return;
    setError('');
    const r = await fetch(`/api/admin/primaria/materie?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ sectionId, nome: nuova.nome, codice: nuova.codice, ordine: materie.length + 1 }),
    });
    const d = await r.json();
    if (!r.ok) setError(d.error || 'Errore');
    else {
      setNuova({ nome: '', codice: '' });
      load();
    }
  };

  const toggleAttiva = async (m: Materia) => {
    await fetch(`/api/admin/primaria/materie?userId=${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ id: m.id, attiva: !m.attiva }),
    });
    load();
  };

  const removeMateria = async (id: string) => {
    await fetch(`/api/admin/primaria/materie?id=${id}&userId=${userId}`, {
      method: 'DELETE',
      headers: { 'x-user-id': userId },
    });
    load();
  };

  if (!sectionId) return <p className="font-maven text-kidville-muted">Seleziona una sezione primaria.</p>;

  return (
    <div className="space-y-4">
      {error && <div className="rounded-card bg-kidville-error/10 text-kidville-error px-4 py-2 text-sm font-maven">{error}</div>}

      <div className="flex flex-wrap items-center gap-2 rounded-card bg-kidville-cream/50 p-3">
        <span className="font-maven text-sm text-kidville-ink">Applica preset materie per livello</span>
        <select
          value={livello}
          onChange={(e) => setLivello(Number(e.target.value))}
          className="font-maven rounded-pill border border-kidville-line bg-white px-3 py-1.5 text-sm"
        >
          {[1, 2, 3, 4, 5].map((l) => (
            <option key={l} value={l}>{l}ª</option>
          ))}
        </select>
        <button
          onClick={applyPreset}
          className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow"
        >
          <Sparkles size={14} /> Applica preset
        </button>
      </div>

      {loading ? (
        <p className="font-maven text-kidville-muted text-sm">Caricamento…</p>
      ) : (
        <ul className="divide-y divide-kidville-line">
          {materie.map((m) => {
            const obMateria = obiettivi.filter((o) => o.materia_codice === m.codice);
            return (
            <li key={m.id} className="py-2.5">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-maven text-kidville-ink">{m.nome}</span>
                  {m.e_civica && <span className="ml-2 rounded-pill bg-kidville-info-soft text-kidville-info px-2 py-0.5 text-[11px]">Ed. Civica</span>}
                  {m.turno_mensa && <span className="ml-2 rounded-pill bg-kidville-warn-soft text-kidville-warn px-2 py-0.5 text-[11px]">Mensa</span>}
                  <span className="ml-2 text-xs text-kidville-muted">{m.codice}</span>
                </div>
                <div className="flex items-center gap-3">
                  <label className="font-maven text-xs text-kidville-muted inline-flex items-center gap-1">
                    <input type="checkbox" checked={m.attiva} onChange={() => toggleAttiva(m)} /> attiva
                  </label>
                  <button onClick={() => removeMateria(m.id)} className="text-kidville-muted hover:text-kidville-error">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <label className="font-maven text-[11px] text-kidville-muted shrink-0">Obiettivo della classe</label>
                <select
                  value={assoc[m.id] ?? ''}
                  onChange={(e) => setObiettivo(m.id, e.target.value)}
                  className="font-maven flex-1 rounded border border-kidville-line px-2 py-1 text-xs"
                >
                  <option value="">— nessuno —</option>
                  {obMateria.map((o) => (
                    <option key={o.id} value={o.id}>{o.codice ? `${o.codice} · ` : ''}{o.descrizione}</option>
                  ))}
                </select>
              </div>
              {obMateria.length === 0 && (
                <p className="font-maven text-[11px] text-kidville-muted mt-1">Nessun obiettivo definito per {m.codice} al livello {livello}ª (sezione Obiettivi).</p>
              )}
            </li>
          );})}
          {materie.length === 0 && <li className="py-3 font-maven text-kidville-muted text-sm">Nessuna materia. Applica un preset o aggiungine una.</li>}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2 border-t border-kidville-line pt-4">
        <div>
          <label className="block font-maven text-xs text-kidville-muted">Nome materia</label>
          <input
            value={nuova.nome}
            onChange={(e) => setNuova((s) => ({ ...s, nome: e.target.value }))}
            className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm"
            placeholder="Es. Coding"
          />
        </div>
        <div>
          <label className="block font-maven text-xs text-kidville-muted">Codice</label>
          <input
            value={nuova.codice}
            onChange={(e) => setNuova((s) => ({ ...s, codice: e.target.value.toLowerCase().replace(/\s+/g, '_') }))}
            className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm"
            placeholder="coding"
          />
        </div>
        <button
          onClick={addMateria}
          className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow"
        >
          <Plus size={14} /> Aggiungi
        </button>
      </div>
    </div>
  );
}
