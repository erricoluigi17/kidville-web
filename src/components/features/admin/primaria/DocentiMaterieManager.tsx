'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

interface Assegnazione {
  id: string;
  utente_id: string;
  materia_id: string;
  e_contitolare: boolean;
  utenti?: { nome: string; cognome: string } | null;
  materie?: { nome: string; codice: string } | null;
}
interface Materia { id: string; nome: string }
interface Docente { id: string; nome: string; cognome: string; gradi?: string[] }

interface Props {
  sectionId: string;
  scuolaId: string;
  userId: string;
}

export function DocentiMaterieManager({ sectionId, scuolaId, userId }: Props) {
  const [assegnazioni, setAssegnazioni] = useState<Assegnazione[]>([]);
  const [materie, setMaterie] = useState<Materia[]>([]);
  const [docenti, setDocenti] = useState<Docente[]>([]);
  const [sel, setSel] = useState({ utenteId: '', materiaId: '', eContitolare: false });
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!sectionId) return;
    const [aRes, mRes, dRes] = await Promise.all([
      fetch(`/api/admin/primaria/docenti-materie?sectionId=${sectionId}`).then((r) => r.json()),
      fetch(`/api/admin/primaria/materie?sectionId=${sectionId}`).then((r) => r.json()),
      fetch(`/api/admin/primaria/docente-gradi?scuolaId=${scuolaId}`).then((r) => r.json()),
    ]);
    setAssegnazioni(aRes.success ? aRes.data : []);
    setMaterie(mRes.success ? mRes.data : []);
    // Solo docenti abilitati alla primaria
    const docs: Docente[] = dRes.success ? dRes.data : [];
    setDocenti(docs.filter((d) => (d.gradi ?? []).includes('primaria')));
  }, [sectionId, scuolaId]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    if (!sel.utenteId || !sel.materiaId) return;
    setError('');
    const r = await fetch(`/api/admin/primaria/docenti-materie?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ utenteId: sel.utenteId, sectionId, materiaId: sel.materiaId, eContitolare: sel.eContitolare }),
    });
    const d = await r.json();
    if (!r.ok) setError(d.error || 'Errore');
    else {
      setSel({ utenteId: '', materiaId: '', eContitolare: false });
      load();
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/admin/primaria/docenti-materie?id=${id}&userId=${userId}`, {
      method: 'DELETE',
      headers: { 'x-user-id': userId },
    });
    load();
  };

  if (!sectionId) return <p className="font-maven text-gray-500">Seleziona una sezione primaria.</p>;

  return (
    <div className="space-y-4">
      {error && <div className="rounded-card bg-kidville-error/10 text-kidville-error px-4 py-2 text-sm font-maven">{error}</div>}
      {docenti.length === 0 && (
        <div className="rounded-card bg-amber-50 text-amber-700 px-4 py-2 text-sm font-maven">
          Nessun docente classificato come &quot;primaria&quot;. Impostalo nella tab Classificazione docenti.
        </div>
      )}

      <ul className="divide-y divide-gray-100">
        {assegnazioni.map((a) => (
          <li key={a.id} className="flex items-center justify-between py-2.5">
            <div className="font-maven text-sm text-gray-800">
              {a.utenti ? `${a.utenti.nome} ${a.utenti.cognome}` : a.utente_id}
              <span className="mx-2 text-gray-300">→</span>
              <span className="text-kidville-green">{a.materie?.nome ?? a.materia_id}</span>
              {a.e_contitolare && <span className="ml-2 rounded-pill bg-kidville-green/10 text-kidville-green px-2 py-0.5 text-[11px]">contitolare</span>}
            </div>
            <button onClick={() => remove(a.id)} className="text-gray-400 hover:text-kidville-error">
              <Trash2 size={16} />
            </button>
          </li>
        ))}
        {assegnazioni.length === 0 && <li className="py-3 font-maven text-gray-400 text-sm">Nessuna assegnazione.</li>}
      </ul>

      <div className="flex flex-wrap items-end gap-2 border-t border-gray-100 pt-4">
        <div>
          <label className="block font-maven text-xs text-gray-500">Docente</label>
          <select
            value={sel.utenteId}
            onChange={(e) => setSel((s) => ({ ...s, utenteId: e.target.value }))}
            className="font-maven rounded-pill border border-gray-200 bg-white px-3 py-1.5 text-sm"
          >
            <option value="">Seleziona…</option>
            {docenti.map((d) => (
              <option key={d.id} value={d.id}>{d.nome} {d.cognome}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block font-maven text-xs text-gray-500">Materia</label>
          <select
            value={sel.materiaId}
            onChange={(e) => setSel((s) => ({ ...s, materiaId: e.target.value }))}
            className="font-maven rounded-pill border border-gray-200 bg-white px-3 py-1.5 text-sm"
          >
            <option value="">Seleziona…</option>
            {materie.map((m) => (
              <option key={m.id} value={m.id}>{m.nome}</option>
            ))}
          </select>
        </div>
        <label className="font-maven text-xs text-gray-600 inline-flex items-center gap-1 pb-2">
          <input
            type="checkbox"
            checked={sel.eContitolare}
            onChange={(e) => setSel((s) => ({ ...s, eContitolare: e.target.checked }))}
          />
          contitolare
        </label>
        <button
          onClick={add}
          className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow"
        >
          <Plus size={14} /> Assegna
        </button>
      </div>
    </div>
  );
}
