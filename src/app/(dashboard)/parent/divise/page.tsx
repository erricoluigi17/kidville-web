'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { RefreshCw, Minus, Plus, ShoppingBag, Shirt } from 'lucide-react';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { SaveCelebration } from '@/components/ui/SaveConfirmation';

interface Articolo {
  id: string;
  nome: string;
  descrizione: string | null;
  taglie: string[];
  prezzo: number;
}
interface RigaOrdine {
  id: string;
  articolo_nome: string;
  taglia: string;
  quantita: number;
  prezzo_unitario: number;
}
interface Ordine {
  id: string;
  stato: string;
  totale: number;
  pagamento_id: string | null;
  creato_il: string;
  righe: RigaOrdine[];
}
interface Sel {
  taglia: string;
  quantita: number;
}

function euro(n: number) {
  return `€ ${Number(n).toFixed(2)}`;
}

function DiviseInner() {
  const { parentId, studentId, ready } = useParentIdentity();
  const [articoli, setArticoli] = useState<Articolo[]>([]);
  const [ordini, setOrdini] = useState<Ordine[]>([]);
  const [sel, setSel] = useState<Record<string, Sel>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [celebra, setCelebra] = useState<string | null>(null);
  const [inviato, setInviato] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ready || !parentId || !studentId) return;
    try {
      const r = await fetch(`/api/parent/divise?alunno_id=${studentId}&userId=${parentId}`, {
        headers: { 'x-user-id': parentId },
      }).catch(() => null);
      const d = r && r.ok ? await r.json().catch(() => null) : null;
      if (d?.success) {
        const arts: Articolo[] = d.data.articoli ?? [];
        setArticoli(arts);
        setOrdini(d.data.ordini ?? []);
        setSel((cur) => {
          const next: Record<string, Sel> = {};
          for (const a of arts) next[a.id] = cur[a.id] ?? { taglia: a.taglie[0] ?? '', quantita: 0 };
          return next;
        });
      }
    } finally {
      setLoading(false);
    }
  }, [ready, parentId, studentId]);

  useEffect(() => { load(); }, [load]);

  const setTaglia = (id: string, taglia: string) =>
    setSel((s) => ({ ...s, [id]: { ...(s[id] ?? { quantita: 0 }), taglia } }));
  const bump = (id: string, delta: number) =>
    setSel((s) => {
      const cur = s[id] ?? { taglia: '', quantita: 0 };
      const q = Math.max(0, Math.min(20, cur.quantita + delta));
      return { ...s, [id]: { ...cur, quantita: q } };
    });

  const carrello = articoli
    .map((a) => ({ a, s: sel[a.id] }))
    .filter((x) => x.s && x.s.quantita > 0);
  const totale = carrello.reduce((t, x) => t + x.a.prezzo * x.s.quantita, 0);

  const submit = async () => {
    if (!parentId || !studentId || carrello.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const righe = carrello.map((x) => ({ articolo_id: x.a.id, taglia: x.s.taglia, quantita: x.s.quantita }));
      const res = await fetch(`/api/parent/divise?userId=${parentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
        body: JSON.stringify({ alunno_id: studentId, righe }),
      }).catch(() => null);
      if (!res || !res.ok) {
        const e = res ? await res.json().catch(() => ({})) : {};
        setError((e as { error?: string }).error || 'Ordine non riuscito. Riprova.');
        return;
      }
      // reset del carrello NELL'HANDLER (mai in un effect)
      setSel(() => {
        const next: Record<string, Sel> = {};
        for (const a of articoli) next[a.id] = { taglia: a.taglie[0] ?? '', quantita: 0 };
        return next;
      });
      setCelebra('Ordine inviato!');
      setInviato(true);
      await load();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="px-4 pt-6 pb-40">
      <SaveCelebration show={!!celebra} message={celebra ?? ''} onDone={() => setCelebra(null)} />

      <header className="mb-5">
        <p className="font-barlow font-bold text-[11px] uppercase tracking-[0.14em] text-kidville-yellow-dark">Servizi</p>
        <h1 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide leading-none">Divise</h1>
        <p className="font-maven text-xs text-kidville-muted mt-1">Ordina la divisa: scegli taglia e quantità, poi conferma.</p>
      </header>

      {!ready || loading ? (
        <div className="py-12 flex justify-center">
          <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {inviato && (
            <div className="mb-4 rounded-card border border-kidville-green/30 bg-kidville-green-soft px-4 py-3">
              <p className="font-maven text-sm text-kidville-green">
                Ordine registrato! Trovi l&apos;addebito in <strong>Pagamenti</strong>, da saldare in segreteria.
              </p>
            </div>
          )}

          {articoli.length === 0 ? (
            <div className="rounded-card bg-white p-8 text-center shadow-sm">
              <Shirt className="mx-auto mb-2 text-kidville-muted" size={28} />
              <p className="font-maven text-sm text-kidville-muted">Nessuna divisa disponibile al momento.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {articoli.map((a) => {
                const s = sel[a.id] ?? { taglia: a.taglie[0] ?? '', quantita: 0 };
                return (
                  <div key={a.id} className="rounded-card bg-white p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-barlow font-bold text-kidville-ink">{a.nome}</p>
                        {a.descrizione && <p className="font-maven text-xs text-kidville-muted mt-0.5">{a.descrizione}</p>}
                        <p className="font-maven text-sm font-bold text-kidville-green mt-1">{euro(a.prezzo)}</p>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      {a.taglie.length > 0 && (
                        <label className="flex items-center gap-2">
                          <span className="font-maven text-xs text-kidville-muted">Taglia</span>
                          <select
                            value={s.taglia}
                            onChange={(e) => setTaglia(a.id, e.target.value)}
                            className="rounded-input border border-kidville-line px-3 py-1.5 font-maven text-sm text-kidville-ink outline-none focus:border-kidville-green"
                          >
                            {a.taglie.map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </label>
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => bump(a.id, -1)}
                          disabled={s.quantita === 0}
                          aria-label="Diminuisci"
                          className="flex h-8 w-8 items-center justify-center rounded-full border border-kidville-line text-kidville-ink disabled:opacity-40"
                        >
                          <Minus size={15} />
                        </button>
                        <span className="w-6 text-center font-maven text-sm font-bold text-kidville-ink">{s.quantita}</span>
                        <button
                          onClick={() => bump(a.id, 1)}
                          aria-label="Aumenta"
                          className="flex h-8 w-8 items-center justify-center rounded-full border border-kidville-line text-kidville-ink"
                        >
                          <Plus size={15} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Ordini precedenti */}
          {ordini.length > 0 && (
            <section className="mt-6">
              <p className="font-barlow font-bold text-xs uppercase tracking-wide text-kidville-muted mb-2">Ordini precedenti</p>
              <div className="space-y-2">
                {ordini.map((o) => (
                  <div key={o.id} className="rounded-card bg-white p-3 shadow-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-maven text-xs text-kidville-muted">{new Date(o.creato_il).toLocaleDateString('it-IT')}</span>
                      <span className="rounded-pill bg-kidville-cream px-2.5 py-0.5 font-maven text-xs font-semibold text-kidville-ink">{o.stato}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {o.righe.map((r) => (
                        <span key={r.id} className="font-maven text-xs text-kidville-ink">{r.quantita}× {r.articolo_nome} ({r.taglia})</span>
                      ))}
                    </div>
                    <p className="mt-1 font-maven text-sm font-bold text-kidville-green">{euro(o.totale)}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Carrello sticky */}
      {carrello.length > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-40 px-4">
          <div className="mx-auto max-w-md rounded-card bg-kidville-green px-4 py-3 shadow-lg">
            {error && <p className="mb-2 font-maven text-xs text-kidville-yellow">{error}</p>}
            <div className="flex items-center justify-between">
              <div>
                <p className="font-maven text-xs text-kidville-yellow/90">
                  {carrello.reduce((n, x) => n + x.s.quantita, 0)} capi · totale
                </p>
                <p className="font-barlow font-black text-lg text-kidville-yellow leading-none">{euro(totale)}</p>
              </div>
              <button
                onClick={submit}
                disabled={submitting}
                className="flex items-center gap-2 rounded-pill bg-kidville-yellow px-5 py-2.5 font-barlow text-sm font-bold uppercase text-kidville-green transition-all active:scale-[0.98] disabled:opacity-60"
              >
                {submitting ? <RefreshCw size={16} className="animate-spin" /> : <ShoppingBag size={16} />} Ordina
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ParentDivisePage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <DiviseInner />
    </Suspense>
  );
}
