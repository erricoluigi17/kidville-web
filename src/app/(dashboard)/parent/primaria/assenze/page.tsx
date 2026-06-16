'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { CheckSquare, AlertCircle } from 'lucide-react';

interface Presenza {
  id: string; data: string; stato: string;
  orario_entrata: string | null; orario_uscita: string | null;
  giustificata: boolean; giustificazione_testo: string | null;
  giustificata_il: string | null; note_appello: string | null;
}

const STATO_LABEL: Record<string, { label: string; cls: string }> = {
  assente: { label: 'Assente', cls: 'bg-red-100 text-red-700' },
  ritardo: { label: 'Ritardo', cls: 'bg-amber-100 text-amber-700' },
  uscita_anticipata: { label: 'Uscita anticipata', cls: 'bg-purple-100 text-purple-700' },
};

function oraDaTs(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function AssenzeGenitore() {
  const { parentId, studentId, ready } = useParentIdentity();
  const [presenze, setPresenze] = useState<Presenza[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ready || !studentId) return;
    setLoading(true);
    fetch(`/api/parent/primaria/assenze?studentId=${studentId}&userId=${parentId}`, {
      headers: { 'x-user-id': parentId },
    })
      .then((r) => r.json())
      .then((d) => { if (d.success) setPresenze(d.data); })
      .finally(() => setLoading(false));
  }, [ready, studentId, parentId]);

  const nonGiustificate = presenze.filter((p) => !p.giustificata);

  return (
    <div className="px-4 pt-6 pb-24">
      <h1 className="font-barlow text-xl font-black text-kidville-green uppercase tracking-wide mb-4 flex items-center gap-2">
        <CheckSquare size={20} /> Presenze
      </h1>

      {loading ? (
        <p className="font-maven text-sm text-gray-400">Caricamento…</p>
      ) : presenze.length === 0 ? (
        <p className="font-maven text-sm text-gray-400">Nessuna assenza registrata.</p>
      ) : (
        <div className="space-y-3">
          {nonGiustificate.length > 0 && (
            <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 flex items-center gap-2">
              <AlertCircle size={16} className="text-amber-600 shrink-0" />
              <p className="font-maven text-sm text-amber-700">
                {nonGiustificate.length} assenza{nonGiustificate.length > 1 ? '/e non ancora giustificate' : ' non ancora giustificata'}
              </p>
            </div>
          )}

          {presenze.map((p) => {
            const s = STATO_LABEL[p.stato] ?? { label: p.stato, cls: 'bg-gray-100 text-gray-500' };
            return (
              <div key={p.id} className="rounded-2xl bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-maven font-semibold ${s.cls}`}>{s.label}</span>
                    <span className="font-maven text-sm font-semibold text-gray-700">
                      {new Date(p.data).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' })}
                    </span>
                  </div>
                  <span className={`font-maven text-xs ${p.giustificata ? 'text-kidville-success' : 'text-amber-600'}`}>
                    {p.giustificata ? '✓ Giustificata' : 'Da giustificare'}
                  </span>
                </div>

                {(p.stato === 'ritardo' && p.orario_entrata) && (
                  <p className="font-maven text-xs text-gray-500">Entrata: {oraDaTs(p.orario_entrata)}</p>
                )}
                {(p.stato === 'uscita_anticipata' && p.orario_uscita) && (
                  <p className="font-maven text-xs text-gray-500">Uscita: {oraDaTs(p.orario_uscita)}</p>
                )}
                {p.giustificazione_testo && (
                  <p className="font-maven text-xs text-gray-500 mt-1 italic">&ldquo;{p.giustificazione_testo}&rdquo;</p>
                )}
                {p.note_appello && (
                  <p className="font-maven text-xs text-gray-400 mt-0.5">Nota docente: {p.note_appello}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function AssenzeGenitorePage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-gray-400">Caricamento…</div>}>
      <AssenzeGenitore />
    </Suspense>
  );
}
