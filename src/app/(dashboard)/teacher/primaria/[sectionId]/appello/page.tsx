'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { Check, X, Clock, LogOut, Users } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { saveLocalAppello, syncPendingAppello } from '@/lib/offline/syncEngine';

type Stato = 'presente' | 'assente' | 'ritardo' | 'uscita_anticipata';
interface Riga { id: string; nome: string; cognome: string; stato: Stato | null }

const STATI: { key: Stato; label: string; icon: React.ReactNode; cls: string }[] = [
  { key: 'presente', label: 'Presente', icon: <Check size={14} />, cls: 'bg-kidville-success text-white' },
  { key: 'assente', label: 'Assente', icon: <X size={14} />, cls: 'bg-kidville-error text-white' },
  { key: 'ritardo', label: 'Ritardo', icon: <Clock size={14} />, cls: 'bg-amber-500 text-white' },
  { key: 'uscita_anticipata', label: 'Uscita', icon: <LogOut size={14} />, cls: 'bg-purple-500 text-white' },
];

function oggiIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function AppelloPage() {
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);
  const [data, setData] = useState(oggiIso());
  const [righe, setRighe] = useState<Riga[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/primaria/appello?sectionId=${sectionId}&data=${data}&userId=${userId}`);
      const d = await r.json();
      if (d.success) setRighe(d.data);
    } finally {
      setLoading(false);
    }
  }, [sectionId, data, userId]);

  useEffect(() => {
    load();
  }, [load]);

  // Flush della coda offline al ritorno della connessione.
  useEffect(() => {
    const flush = () => syncPendingAppello().then(load);
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
  }, [load]);

  const setStato = async (alunnoId: string, stato: Stato) => {
    setRighe((prev) => prev.map((r) => (r.id === alunnoId ? { ...r, stato } : r)));
    // Offline-first: se non c'è rete, accoda localmente e sincronizza dopo.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await saveLocalAppello({ id: `${alunnoId}|${data}`, section_id: sectionId, alunno_id: alunnoId, data, stato, aggiornato_il: new Date().toISOString() });
      return;
    }
    try {
      const res = await fetch(`/api/primaria/appello?userId=${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ sectionId, data, alunnoId, stato }),
      });
      if (!res.ok) throw new Error('save failed');
    } catch {
      await saveLocalAppello({ id: `${alunnoId}|${data}`, section_id: sectionId, alunno_id: alunnoId, data, stato, aggiornato_il: new Date().toISOString() });
    }
  };

  const tuttiPresenti = async () => {
    setSaving(true);
    setRighe((prev) => prev.map((r) => ({ ...r, stato: 'presente' })));
    await fetch(`/api/primaria/appello?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({
        sectionId,
        data,
        records: righe.map((r) => ({ alunnoId: r.id, stato: 'presente' })),
      }),
    });
    setSaving(false);
  };

  return (
    <div className="rounded-card bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-barlow text-lg font-bold text-gray-800">Appello</h2>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={data}
            onChange={(e) => setData(e.target.value)}
            className="font-maven rounded-pill border border-gray-200 px-3 py-1.5 text-sm"
          />
          <button
            onClick={tuttiPresenti}
            disabled={saving || righe.length === 0}
            className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow disabled:opacity-50"
          >
            <Users size={14} /> Tutti presenti
          </button>
        </div>
      </div>

      {loading ? (
        <p className="font-maven text-gray-400 text-sm">Caricamento…</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {righe.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span className="font-maven text-gray-800">{r.cognome} {r.nome}</span>
              <div className="flex gap-1.5">
                {STATI.map((s) => (
                  <button
                    key={s.key}
                    onClick={() => setStato(r.id, s.key)}
                    title={s.label}
                    className={`font-maven inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-xs transition ${
                      r.stato === s.key ? s.cls : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                    }`}
                  >
                    {s.icon}
                    <span className="hidden sm:inline">{s.label}</span>
                  </button>
                ))}
              </div>
            </li>
          ))}
          {righe.length === 0 && <li className="py-3 font-maven text-gray-400 text-sm">Nessun alunno nella classe.</li>}
        </ul>
      )}
    </div>
  );
}
