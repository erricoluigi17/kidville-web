'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

interface Obiettivo {
  id: string;
  materia_codice: string;
  livello: number;
  codice: string | null;
  descrizione: string;
  attivo: boolean;
}

const MATERIE_STD = [
  ['italiano', 'Italiano'], ['matematica', 'Matematica'], ['storia', 'Storia'],
  ['geografia', 'Geografia'], ['scienze', 'Scienze'], ['inglese', 'Inglese'],
  ['arte', 'Arte e Immagine'], ['musica', 'Musica'], ['ed_fisica', 'Educazione Fisica'],
  ['tecnologia', 'Tecnologia'], ['religione', 'Religione/Alternativa'], ['ed_civica', 'Educazione Civica'],
] as const;

export function ObiettiviManager({ scuolaId, userId }: { scuolaId: string; userId: string }) {
  const [materiaCodice, setMateriaCodice] = useState('italiano');
  const [livello, setLivello] = useState(1);
  const [obiettivi, setObiettivi] = useState<Obiettivo[]>([]);
  const [nuovo, setNuovo] = useState({ codice: '', descrizione: '' });
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const r = await fetch(
      `/api/admin/primaria/obiettivi?scuolaId=${scuolaId}&materiaCodice=${materiaCodice}&livello=${livello}`
    );
    const d = await r.json();
    setObiettivi(d.success ? d.data : []);
  }, [scuolaId, materiaCodice, livello]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    if (!nuovo.descrizione) return;
    setError('');
    const r = await fetch(`/api/admin/primaria/obiettivi?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ scuolaId, materiaCodice, livello, codice: nuovo.codice || null, descrizione: nuovo.descrizione }),
    });
    const d = await r.json();
    if (!r.ok) setError(d.error || 'Errore');
    else {
      setNuovo({ codice: '', descrizione: '' });
      load();
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/admin/primaria/obiettivi?id=${id}&userId=${userId}`, {
      method: 'DELETE',
      headers: { 'x-user-id': userId },
    });
    load();
  };

  return (
    <div className="space-y-4">
      {error && <div className="rounded-card bg-kidville-error/10 text-kidville-error px-4 py-2 text-sm font-maven">{error}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={materiaCodice}
          onChange={(e) => setMateriaCodice(e.target.value)}
          className="font-maven rounded-pill border border-gray-200 bg-white px-3 py-1.5 text-sm"
        >
          {MATERIE_STD.map(([c, l]) => (
            <option key={c} value={c}>{l}</option>
          ))}
        </select>
        <select
          value={livello}
          onChange={(e) => setLivello(Number(e.target.value))}
          className="font-maven rounded-pill border border-gray-200 bg-white px-3 py-1.5 text-sm"
        >
          {[1, 2, 3, 4, 5].map((l) => (
            <option key={l} value={l}>{l}ª</option>
          ))}
        </select>
      </div>

      <ul className="divide-y divide-gray-100">
        {obiettivi.map((o) => (
          <li key={o.id} className="flex items-start justify-between gap-3 py-2.5">
            <div className="font-maven text-sm text-gray-800">
              {o.codice && <span className="mr-2 text-xs font-semibold text-kidville-green">{o.codice}</span>}
              {o.descrizione}
            </div>
            <button onClick={() => remove(o.id)} className="text-gray-400 hover:text-kidville-error shrink-0">
              <Trash2 size={16} />
            </button>
          </li>
        ))}
        {obiettivi.length === 0 && <li className="py-3 font-maven text-gray-400 text-sm">Nessun obiettivo per questa materia/livello.</li>}
      </ul>

      <div className="flex flex-wrap items-end gap-2 border-t border-gray-100 pt-4">
        <div>
          <label className="block font-maven text-xs text-gray-500">Codice (opz.)</label>
          <input
            value={nuovo.codice}
            onChange={(e) => setNuovo((s) => ({ ...s, codice: e.target.value }))}
            className="font-maven w-24 rounded-pill border border-gray-200 px-3 py-1.5 text-sm"
            placeholder="ITA-1"
          />
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="block font-maven text-xs text-gray-500">Descrizione obiettivo</label>
          <input
            value={nuovo.descrizione}
            onChange={(e) => setNuovo((s) => ({ ...s, descrizione: e.target.value }))}
            className="font-maven w-full rounded-pill border border-gray-200 px-3 py-1.5 text-sm"
            placeholder="Es. Legge e comprende testi di vario tipo"
          />
        </div>
        <button
          onClick={add}
          className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow"
        >
          <Plus size={14} /> Aggiungi
        </button>
      </div>
    </div>
  );
}
