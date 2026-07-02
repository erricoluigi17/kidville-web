'use client';

import { useState, useEffect, useCallback } from 'react';
import { ClipboardList, AlertTriangle, Users } from 'lucide-react';
import { allergeneLabel, allergeneEmoji } from '@/lib/mensa/allergeni';

interface Props {
  userId: string;
  scuolaId?: string;
  // se valorizzato, vincola il report a una sezione (modalità insegnante)
  sezione?: string;
  // etichetta sezioni selezionabili (modalità admin/cuoca). Se assente: tutte.
  sezioni?: string[];
}
const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

interface Conflitto { allergene: string; portate: string[] }
interface AlunnoReport { id: string; nome: string; classe: string; allergeni: string[]; conflitti: Conflitto[] }
interface Report {
  data: string;
  totale: number;
  perClasse: { classe: string; conteggio: number; alunni: AlunnoReport[] }[];
  allergie: { nome: string; classe: string; allergie: string; conflitto: boolean }[];
}

export function MensaReport({ userId, scuolaId, sezione, sezioni }: Props) {
  const [data, setData] = useState(() => new Date().toISOString().slice(0, 10));
  const [filtroSezione, setFiltroSezione] = useState<string>(sezione ?? '');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const sez = sezione ?? filtroSezione;
    const qs = new URLSearchParams({ userId, data });
    if (scuolaId) qs.set('scuola_id', scuolaId);
    if (sez) qs.set('sezione', sez);
    const res = await fetch(`/api/mensa/report?${qs}`, { headers: hdr(userId) });
    const j = await res.json();
    setLoading(false);
    if (j.success) setReport(j.data); else setError(j.error ?? 'Errore');
  }, [userId, scuolaId, data, sezione, filtroSezione]);

  useEffect(() => { load(); }, [load]);

  const totaleConflitti = report?.perClasse.reduce((n, c) => n + c.alunni.filter(a => a.conflitti.length > 0).length, 0) ?? 0;

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div>
          <label className="font-maven text-xs text-kidville-muted block mb-1">Data</label>
          <input type="date" value={data} onChange={e => setData(e.target.value)}
            className="border-2 border-kidville-line rounded-lg px-3 py-1.5 font-maven text-sm text-kidville-green" />
        </div>
        {!sezione && sezioni && sezioni.length > 0 && (
          <div>
            <label className="font-maven text-xs text-kidville-muted block mb-1">Sezione</label>
            <select value={filtroSezione} onChange={e => setFiltroSezione(e.target.value)}
              className="border-2 border-kidville-line rounded-lg px-3 py-1.5 font-maven text-sm text-kidville-green bg-white">
              <option value="">Tutte</option>
              {sezioni.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-kidville-green text-white">
          <Users size={16} />
          <span className="font-barlow font-black text-lg leading-none">{report?.totale ?? '—'}</span>
          <span className="font-maven text-[11px] opacity-80">pasti</span>
        </div>
        {totaleConflitti > 0 && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-kidville-error text-white animate-pulse">
            <AlertTriangle size={16} />
            <span className="font-barlow font-black text-lg leading-none">{totaleConflitti}</span>
            <span className="font-maven text-[11px] opacity-90">allergie nel menu di oggi</span>
          </div>
        )}
      </div>

      {error && <p className="font-maven text-sm text-kidville-error mb-3">{error}</p>}
      {loading && <p className="font-maven text-sm text-kidville-muted">Caricamento…</p>}

      {report && !loading && (
        <div className="space-y-4">
          <div>
            <h4 className="font-barlow font-bold text-kidville-green uppercase text-xs mb-2 flex items-center gap-1.5"><ClipboardList size={13} /> Prenotati per sezione</h4>
            {report.perClasse.length === 0 ? (
              <p className="font-maven text-sm text-kidville-muted">Nessuna prenotazione per questa data.</p>
            ) : (
              <div className="grid md:grid-cols-2 gap-3">
                {report.perClasse.map(c => (
                  <div key={c.classe} className="rounded-2xl border border-kidville-line bg-white overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 bg-kidville-cream/60">
                      <span className="font-barlow font-bold text-kidville-green text-sm">{c.classe}</span>
                      <span className="font-barlow font-black text-kidville-green">{c.conteggio}</span>
                    </div>
                    <ul className="divide-y divide-kidville-cream">
                      {c.alunni.map(a => {
                        const conflitto = a.conflitti.length > 0;
                        return (
                          <li key={a.id} className={`px-3 py-2 ${conflitto ? 'bg-kidville-error-soft' : ''}`}>
                            <div className="flex items-center justify-between gap-2">
                              <span className={`font-maven text-sm ${conflitto ? 'text-kidville-error font-bold' : 'text-kidville-green'}`}>
                                {conflitto && <AlertTriangle size={12} className="inline mr-1 -mt-0.5 text-kidville-error" />}
                                {a.nome}
                              </span>
                              {a.allergeni.length > 0 && (
                                <span className="flex flex-wrap gap-1 justify-end">
                                  {a.allergeni.map(k => {
                                    const inConflitto = a.conflitti.some(cf => cf.allergene === k);
                                    return (
                                      <span key={k} title={allergeneLabel(k)}
                                        className={`px-1.5 py-0.5 rounded-full font-maven text-[10px] font-bold ${inConflitto ? 'bg-kidville-error text-white' : 'bg-kidville-line text-kidville-muted'}`}>
                                        {allergeneEmoji(k)} {allergeneLabel(k)}
                                      </span>
                                    );
                                  })}
                                </span>
                              )}
                            </div>
                            {conflitto && (
                              <p className="font-maven text-[11px] text-kidville-error mt-0.5">
                                Nel menu: {a.conflitti.map(cf => `${allergeneLabel(cf.allergene)} (${cf.portate.join(', ')})`).join('; ')}
                              </p>
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
        </div>
      )}
    </div>
  );
}
