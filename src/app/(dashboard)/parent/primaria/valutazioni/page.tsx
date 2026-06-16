'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { BarChart3 } from 'lucide-react';

interface ValBreve {
  id: string; tipo: string; modalita: string;
  giudizio_sintetico: string | null; giudizio_testo: string | null;
  creato_il: string; argomento: string | null;
}
interface MateriaVoce {
  materiaId: string; nome: string; valutazioni: ValBreve[];
}

function ValutazioniGenitore() {
  const { parentId, studentId, ready } = useParentIdentity();
  const [materie, setMaterie] = useState<MateriaVoce[]>([]);
  const [loading, setLoading] = useState(true);
  const [aperta, setAperta] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !studentId) return;
    setLoading(true);
    fetch(`/api/parent/primaria/valutazioni?studentId=${studentId}&userId=${parentId}`, {
      headers: { 'x-user-id': parentId },
    })
      .then((r) => r.json())
      .then((d) => { if (d.success) setMaterie(d.data); })
      .finally(() => setLoading(false));
  }, [ready, studentId, parentId]);

  return (
    <div className="px-4 pt-6 pb-24">
      <h1 className="font-barlow text-xl font-black text-kidville-green uppercase tracking-wide mb-4 flex items-center gap-2">
        <BarChart3 size={20} /> Valutazioni
      </h1>

      {loading ? (
        <p className="font-maven text-sm text-gray-400">Caricamento…</p>
      ) : materie.length === 0 ? (
        <p className="font-maven text-sm text-gray-400">Nessuna valutazione disponibile.</p>
      ) : (
        <div className="space-y-3">
          {materie.map((m) => (
            <div key={m.materiaId} className="rounded-2xl bg-white shadow-sm overflow-hidden">
              <button
                onClick={() => setAperta(aperta === m.materiaId ? null : m.materiaId)}
                className="flex w-full items-center justify-between px-4 py-3.5"
              >
                <div className="flex items-center gap-3">
                  <div className="text-left">
                    <p className="font-barlow text-base font-bold text-gray-800">{m.nome}</p>
                    <p className="font-maven text-xs text-gray-400">{m.valutazioni.length} valutazion{m.valutazioni.length === 1 ? 'e' : 'i'}</p>
                  </div>
                </div>
              </button>

              {aperta === m.materiaId && (
                <div className="border-t border-gray-100 divide-y divide-gray-50">
                  {m.valutazioni.map((v) => (
                    <div key={v.id} className="px-4 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        {v.giudizio_sintetico && (
                          <span className="rounded-full bg-kidville-green/10 px-2.5 py-0.5 font-maven text-xs font-semibold text-kidville-green">
                            {v.giudizio_sintetico}
                          </span>
                        )}
                        <span className="font-maven text-xs capitalize text-gray-500">{v.tipo}</span>
                        <span className="font-maven text-xs text-gray-300 ml-auto">
                          {new Date(v.creato_il).toLocaleDateString('it-IT')}
                        </span>
                      </div>
                      {v.argomento && <p className="font-maven text-xs text-gray-500">{v.argomento}</p>}
                      {v.giudizio_testo && <p className="font-maven text-xs text-gray-600 mt-1 italic">{v.giudizio_testo}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ValutazioniGenitorePage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-gray-400">Caricamento…</div>}>
      <ValutazioniGenitore />
    </Suspense>
  );
}
