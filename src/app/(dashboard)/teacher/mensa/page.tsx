'use client';

// Vista mensa DOCENTE (sola lettura): prenotazioni pranzo della propria sezione
// per una data, con allergeni e conflitti col menu del giorno. Riusa
// GET /api/mensa/report (requireKitchenRead ammette l'educator con `sezione`).
// La gestione delle prenotazioni resta a genitori/segreteria.

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, RefreshCw, CalendarDays } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { allergeneLabel, allergeneEmoji } from '@/lib/mensa/allergeni';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';

interface AlunnoReport { id: string; nome: string; classe: string; allergeni: string[]; conflitti: unknown[] }
interface ClasseReport { classe: string; conteggio: number; alunni: AlunnoReport[] }
interface Report { data: string; totale: number; perClasse: ClasseReport[] }

function MensaDocente() {
  const search = useSearchParams();
  const userId = getCurrentTeacherId(search);

  const [sezioni, setSezioni] = useState<string[]>([]);
  const [sezione, setSezione] = useState<string>('');
  const [sezioniPronte, setSezioniPronte] = useState(false);
  const [data, setData] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  // Sezioni del docente (nomi classe_sezione). setState solo nelle callback async.
  useEffect(() => {
    if (!userId) return;
    fetch(`/api/educator-sections?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        const names: string[] = d.sectionNames ?? [];
        setSezioni(names);
        setSezione((prev) => prev || names[0] || '');
        setSezioniPronte(true);
        if (names.length === 0) setLoading(false);
      })
      .catch(() => { setSezioniPronte(true); setLoading(false); });
  }, [userId]);

  // Report del giorno per la sezione. setState solo nel finally (react-hooks 7).
  useEffect(() => {
    if (!userId || !sezione) return;
    let cancelled = false;
    const run = async () => {
      let rep: Report | null = null;
      let err = '';
      try {
        const r = await fetch(`/api/mensa/report?userId=${userId}&sezione=${encodeURIComponent(sezione)}&data=${data}`);
        const j = await r.json();
        if (j.success) rep = j.data;
        else err = j.error || 'Errore nel caricamento';
      } catch {
        err = 'Errore di rete';
      } finally {
        if (!cancelled) { setReport(rep); setError(err); setLoading(false); }
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [userId, sezione, data, reloadKey]);

  const cambiaSezione = (s: string) => { setSezione(s); setLoading(true); };
  const cambiaData = (v: string) => { setData(v); setLoading(true); };
  const aggiorna = () => { setLoading(true); setReloadKey((k) => k + 1); };

  return (
    <div className="mx-auto max-w-[460px] px-4 pt-6">
      {/* Header verde (DR) */}
      <PageHeaderCard
        eyebrow="Vita scolastica"
        title="Mensa"
        subtitle="Prenotazioni pranzo della classe (sola lettura)."
        className="mb-4"
      />

      {/* Controlli: sezione + data */}
      <div className="mb-4 space-y-3">
        {sezioni.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {sezioni.map((s) => (
              <button
                key={s}
                onClick={() => cambiaSezione(s)}
                className={`font-maven rounded-pill px-3 py-1 text-xs ${sezione === s ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-cream text-kidville-muted'}`}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1.5 font-maven text-xs text-kidville-muted">
            <CalendarDays size={14} /> Giorno
          </label>
          <input
            type="date"
            value={data}
            onChange={(e) => cambiaData(e.target.value)}
            className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm"
          />
          <button
            onClick={aggiorna}
            disabled={loading}
            title="Aggiorna"
            className="w-8 h-8 rounded-full bg-white border-2 border-gray-200 flex items-center justify-center text-kidville-green disabled:opacity-40"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 rounded-xl bg-kidville-warn-soft border border-kidville-warn/30 font-maven text-xs text-kidville-warn">{error}</div>
      )}

      {loading ? (
        <div className="py-12 flex justify-center">
          <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
        </div>
      ) : sezioniPronte && sezioni.length === 0 ? (
        <p className="font-maven text-sm text-kidville-muted text-center py-10">Nessuna classe assegnata.</p>
      ) : !report || report.totale === 0 ? (
        <p className="font-maven text-sm text-kidville-muted text-center py-10">Nessuna prenotazione pranzo per questa data.</p>
      ) : (
        <div className="space-y-4">
          <div className="rounded-2xl bg-kidville-green-soft border border-kidville-green/20 px-4 py-3">
            <p className="font-maven text-sm text-kidville-green">
              <strong>{report.totale}</strong> {report.totale === 1 ? 'pranzo prenotato' : 'pranzi prenotati'} il {new Date(`${report.data}T00:00:00`).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}
            </p>
          </div>

          {report.perClasse.map((c) => (
            <div key={c.classe} className="rounded-2xl border border-kidville-line bg-white overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-kidville-line bg-kidville-cream/40">
                <span className="font-barlow font-bold uppercase text-sm text-kidville-green">{c.classe}</span>
                <span className="font-maven text-xs text-kidville-muted">{c.conteggio} {c.conteggio === 1 ? 'bambino' : 'bambini'}</span>
              </div>
              <ul className="divide-y divide-kidville-line">
                {c.alunni.map((a) => {
                  const inConflitto = a.conflitti.length > 0;
                  return (
                    <li key={a.id} className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="font-maven text-sm text-kidville-ink flex-1">{a.nome}</span>
                        {inConflitto && (
                          <span className="inline-flex items-center gap-1 rounded-pill bg-kidville-error-soft px-2 py-0.5 font-maven text-[10px] font-bold text-kidville-error">
                            <AlertTriangle size={11} /> allergene nel menu
                          </span>
                        )}
                      </div>
                      {a.allergeni.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {a.allergeni.map((k) => (
                            <span key={k} title={allergeneLabel(k)}
                              className="px-1.5 py-0.5 rounded-full bg-kidville-warn-soft border border-kidville-warn/30 text-kidville-warn font-maven text-[10px] font-bold">
                              {allergeneEmoji(k)} {allergeneLabel(k)}
                            </span>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MensaDocentePage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <MensaDocente />
    </Suspense>
  );
}
