'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { AlertTriangle, Check } from 'lucide-react';

interface Nota {
  id: string; categoria: string; testo: string;
  richiede_firma: boolean; firmata_il: string | null; creato_il: string;
}

const CATEGORIE: Record<string, { label: string; cls: string }> = {
  disciplinare: { label: 'Disciplinare', cls: 'bg-red-100 text-red-700' },
  didattica: { label: 'Didattica', cls: 'bg-blue-100 text-blue-700' },
  compiti_non_svolti: { label: 'Compiti non svolti', cls: 'bg-amber-100 text-amber-700' },
};

function NoteGenitore() {
  const { parentId, studentId, ready } = useParentIdentity();
  const [note, setNote] = useState<Nota[]>([]);
  const [loading, setLoading] = useState(true);
  const [firmando, setFirmando] = useState<string | null>(null);

  const carica = async () => {
    if (!ready || !studentId) return;
    setLoading(true);
    const r = await fetch(`/api/parent/primaria/note?studentId=${studentId}&userId=${parentId}`, {
      headers: { 'x-user-id': parentId },
    });
    const d = await r.json();
    if (d.success) setNote(d.data);
    setLoading(false);
  };

  useEffect(() => { carica(); }, [ready, studentId]);

  const firma = async (notaId: string) => {
    setFirmando(notaId);
    await fetch(`/api/parent/primaria/note?userId=${parentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
      body: JSON.stringify({ notaId }),
    });
    setFirmando(null);
    carica();
  };

  const inAttesa = note.filter((n) => n.richiede_firma && !n.firmata_il);

  return (
    <div className="px-4 pt-6 pb-24">
      <h1 className="font-barlow text-xl font-black text-kidville-green uppercase tracking-wide mb-4 flex items-center gap-2">
        <AlertTriangle size={20} /> Note
      </h1>

      {loading ? (
        <p className="font-maven text-sm text-gray-400">Caricamento…</p>
      ) : note.length === 0 ? (
        <p className="font-maven text-sm text-gray-400">Nessuna nota registrata.</p>
      ) : (
        <div className="space-y-3">
          {inAttesa.length > 0 && (
            <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3">
              <p className="font-maven text-sm font-semibold text-amber-700">
                {inAttesa.length} nota{inAttesa.length > 1 ? ' in attesa' : ' in attesa'} di firma
              </p>
            </div>
          )}
          {note.map((n) => {
            const cat = CATEGORIE[n.categoria] ?? { label: n.categoria, cls: 'bg-gray-100 text-gray-500' };
            return (
              <div key={n.id} className="rounded-2xl bg-white p-4 shadow-sm">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-maven font-semibold ${cat.cls}`}>{cat.label}</span>
                  <span className="font-maven text-xs text-gray-400">
                    {new Date(n.creato_il).toLocaleDateString('it-IT')}
                  </span>
                  {n.richiede_firma && (
                    n.firmata_il
                      ? <span className="font-maven text-xs text-kidville-success flex items-center gap-1"><Check size={11} /> Firmata</span>
                      : <span className="font-maven text-xs text-amber-600">In attesa di firma</span>
                  )}
                </div>
                <p className="font-maven text-sm text-gray-700">{n.testo}</p>
                {n.richiede_firma && !n.firmata_il && (
                  <button
                    onClick={() => firma(n.id)}
                    disabled={firmando === n.id}
                    className="mt-3 font-maven inline-flex items-center gap-1.5 rounded-full bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow disabled:opacity-50"
                  >
                    <Check size={14} /> {firmando === n.id ? 'Firma…' : 'Firma presa visione'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function NoteGenitorePage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-gray-400">Caricamento…</div>}>
      <NoteGenitore />
    </Suspense>
  );
}
