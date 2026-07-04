'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';

interface Campanella { id: string; giorno_settimana: number; ordine: number; ora_inizio: string | null; ora_fine: string | null; tipo: string | null }
interface OrarioVoce {
  id: string; giorno_settimana: number; campanella_id: string; materia_id: string | null; note: string | null;
  materie?: { nome: string | null; codice: string | null } | null;
}

const GIORNI = ['', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];

function OrarioGenitore() {
  const { parentId, studentId, ready } = useParentIdentity();
  const [campanelle, setCampanelle] = useState<Campanella[]>([]);
  const [orario, setOrario] = useState<OrarioVoce[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ready || !parentId || !studentId) return;
    fetch(`/api/parent/primaria/orario?studentId=${studentId}&userId=${parentId}`, { headers: { 'x-user-id': parentId } })
      .then((r) => r.json())
      .then((d) => {
        if (d.success) { setCampanelle(d.data.campanelle ?? []); setOrario(d.data.orario ?? []); }
      })
      .finally(() => setLoading(false));
  }, [ready, studentId, parentId]);

  const giorniAttivi = [...new Set(campanelle.map((c) => c.giorno_settimana))].sort((a, b) => a - b);
  const voce = (giorno: number, campanellaId: string) =>
    orario.find((o) => o.giorno_settimana === giorno && o.campanella_id === campanellaId);

  return (
    <div className="px-4 pt-6 pb-24">
      <div className="mb-4">
        <p className="font-barlow font-bold text-[11px] uppercase tracking-[0.14em] text-kidville-yellow-dark">
          Didattica · Primaria
        </p>
        <h1 className="font-barlow text-2xl font-black text-kidville-green uppercase tracking-wide leading-none">
          Orario settimanale
        </h1>
      </div>

      {loading ? (
        <p className="font-maven text-sm text-kidville-muted">Caricamento…</p>
      ) : campanelle.length === 0 ? (
        <p className="font-maven text-sm text-kidville-muted">Orario non ancora pubblicato.</p>
      ) : (
        <div className="space-y-4">
          {giorniAttivi.map((g) => {
            const slot = campanelle.filter((c) => c.giorno_settimana === g).sort((a, b) => a.ordine - b.ordine);
            return (
              <div key={g} className="rounded-card border border-kidville-line bg-white p-4 shadow-sm">
                <p className="font-barlow text-base font-extrabold uppercase tracking-wide text-kidville-green mb-2">{GIORNI[g] ?? `Giorno ${g}`}</p>
                <ul className="divide-y divide-kidville-line">
                  {slot.map((c) => {
                    const v = voce(g, c.id);
                    return (
                      <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                        <span className="font-maven text-xs text-kidville-muted w-24 shrink-0">
                          {c.ora_inizio?.slice(0, 5) ?? '—'}{c.ora_fine ? `–${c.ora_fine.slice(0, 5)}` : ''}
                        </span>
                        <span className="font-maven text-sm text-kidville-ink flex-1">
                          {v?.materie?.nome ?? (c.tipo && c.tipo !== 'lezione' ? c.tipo : '—')}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function OrarioGenitorePage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <OrarioGenitore />
    </Suspense>
  );
}
