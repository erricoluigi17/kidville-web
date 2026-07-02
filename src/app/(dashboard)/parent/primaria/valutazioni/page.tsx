'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';

interface ValBreve {
  id: string; tipo: string; modalita: string;
  giudizio_sintetico: string | null; giudizio_testo: string | null;
  creato_il: string; argomento: string | null;
}
interface MateriaVoce {
  materiaId: string; nome: string; valutazioni: ValBreve[];
}

// Colore per giudizio sintetico (DR VotiTab GIUDIZIO_STYLE). Copre la scala a 6
// livelli e quella O.M. 3/2025 a 4 livelli. Solo giudizi, mai numeri.
const GIUDIZIO_TINT: Record<string, string> = {
  'Ottimo': 'bg-kidville-success-soft text-kidville-success',
  'Distinto': 'bg-kidville-green-soft text-kidville-green',
  'Buono': 'bg-kidville-info-soft text-kidville-info',
  'Discreto': 'bg-kidville-warn-soft text-kidville-warn',
  'Sufficiente': 'bg-kidville-yellow-soft text-kidville-yellow-dark',
  'Non sufficiente': 'bg-kidville-error-soft text-kidville-error',
  'Avanzato': 'bg-kidville-success-soft text-kidville-success',
  'Intermedio': 'bg-kidville-info-soft text-kidville-info',
  'Base': 'bg-kidville-warn-soft text-kidville-warn',
  'In via di prima acquisizione': 'bg-kidville-error-soft text-kidville-error',
};
const giudizioCls = (g: string | null) =>
  (g && GIUDIZIO_TINT[g]) || 'bg-kidville-green/10 text-kidville-green';

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
      <div className="mb-4">
        <p className="font-barlow font-bold text-[11px] uppercase tracking-[0.14em] text-kidville-yellow-dark">
          Didattica · Primaria
        </p>
        <h1 className="font-barlow text-2xl font-black text-kidville-green uppercase tracking-wide leading-none">
          Valutazioni
        </h1>
      </div>

      {loading ? (
        <p className="font-maven text-sm text-kidville-muted">Caricamento…</p>
      ) : materie.length === 0 ? (
        <p className="font-maven text-sm text-kidville-muted">Nessuna valutazione disponibile.</p>
      ) : (
        <div className="space-y-3">
          {materie.map((m) => (
            <div key={m.materiaId} className="rounded-card border border-kidville-line bg-white shadow-sm overflow-hidden">
              <button
                onClick={() => setAperta(aperta === m.materiaId ? null : m.materiaId)}
                className="flex w-full items-center justify-between px-4 py-3.5"
              >
                <div className="flex items-center gap-3">
                  <div className="text-left">
                    <p className="font-barlow text-base font-extrabold uppercase tracking-wide text-kidville-green">{m.nome}</p>
                    <p className="font-maven text-xs text-kidville-muted">{m.valutazioni.length} valutazion{m.valutazioni.length === 1 ? 'e' : 'i'}</p>
                  </div>
                </div>
              </button>

              {aperta === m.materiaId && (
                <div className="border-t border-kidville-line divide-y divide-kidville-line">
                  {m.valutazioni.map((v) => (
                    <div key={v.id} className="px-4 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        {v.giudizio_sintetico && (
                          <span className={`rounded-full px-2.5 py-0.5 font-maven text-xs font-semibold ${giudizioCls(v.giudizio_sintetico)}`}>
                            {v.giudizio_sintetico}
                          </span>
                        )}
                        <span className="font-maven text-xs capitalize text-kidville-muted">{v.tipo}</span>
                        <span className="font-maven text-xs text-kidville-muted ml-auto">
                          {new Date(v.creato_il).toLocaleDateString('it-IT')}
                        </span>
                      </div>
                      {v.argomento && <p className="font-maven text-xs text-kidville-muted">{v.argomento}</p>}
                      {v.giudizio_testo && <p className="font-maven text-xs text-kidville-muted mt-1 italic">{v.giudizio_testo}</p>}
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
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <ValutazioniGenitore />
    </Suspense>
  );
}
