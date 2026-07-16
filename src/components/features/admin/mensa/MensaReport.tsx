'use client';

import { useState, useEffect, useCallback } from 'react';
import { ClipboardList, AlertTriangle, Users, UtensilsCrossed, Trash2, Plus } from 'lucide-react';
import { DateField } from '@/components/ui/DateField';
import { allergeneLabel, allergeneEmoji } from '@/lib/mensa/allergeni';

interface Props {
  userId: string;
  scuolaId?: string;
  // se valorizzato, vincola il report a una sezione (modalità insegnante)
  sezione?: string;
  // etichetta sezioni selezionabili (modalità admin/cuoca). Se assente: tutte.
  sezioni?: string[];
  // cuoca/docente: nasconde le azioni di scrittura (registra/elimina alternativa)
  soloLettura?: boolean;
}
const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

interface Conflitto { allergene: string; portate: string[] }
interface AlunnoReport { id: string; nome: string; classe: string; allergeni: string[]; conflitti: Conflitto[] }
interface AlternativaAutomatica { alunno_id: string; nome: string; classe: string; allergeni: string[]; allergeni_label: string[] }
interface Report {
  data: string;
  totale: number;
  perClasse: { classe: string; conteggio: number; alunni: AlunnoReport[] }[];
  allergie: { nome: string; classe: string; allergie: string; conflitto: boolean }[];
  alternative_automatiche?: AlternativaAutomatica[];
}
interface AlternativaManuale { id: string; alunno_id: string; nome: string; classe: string; richiesta: string; origine: string; created_at: string }

export function MensaReport({ userId, scuolaId, sezione, sezioni, soloLettura = false }: Props) {
  const [data, setData] = useState(() => new Date().toISOString().slice(0, 10));
  const [filtroSezione, setFiltroSezione] = useState<string>(sezione ?? '');
  const [report, setReport] = useState<Report | null>(null);
  // loading parte true (niente setLoading(true) sincrono nel loader, react-hooks
  // set-state-in-effect); i refetch (cambio data/sezione) avvengono senza spinner.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Alternative manuali del giorno (registrate dalla segreteria) + form.
  const [alternative, setAlternative] = useState<AlternativaManuale[]>([]);
  const [formAlunno, setFormAlunno] = useState('');
  const [formNota, setFormNota] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [altError, setAltError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const sez = sezione ?? filtroSezione;
      const qs = new URLSearchParams({ userId, data });
      if (scuolaId) qs.set('scuola_id', scuolaId);
      if (sez) qs.set('sezione', sez);
      const res = await fetch(`/api/mensa/report?${qs}`, { headers: hdr(userId) });
      const j = await res.json();
      if (j.success) { setReport(j.data); setError(null); } else setError(j.error ?? 'Errore');
    } finally {
      setLoading(false);
    }
  }, [userId, scuolaId, data, sezione, filtroSezione]);

  const loadAlternative = useCallback(async () => {
    const sez = sezione ?? filtroSezione;
    const qs = new URLSearchParams({ userId, data });
    if (scuolaId) qs.set('scuola_id', scuolaId);
    if (sez) qs.set('sezione', sez);
    // try/finally (non try/catch): react-hooks 7 vieta setState nel catch da effect.
    let list: AlternativaManuale[] | null = null;
    try {
      const res = await fetch(`/api/mensa/alternative?${qs}`, { headers: hdr(userId) });
      const j = await res.json();
      if (j.success) list = j.data.alternative ?? [];
    } finally {
      if (list) setAlternative(list);
    }
  }, [userId, scuolaId, data, sezione, filtroSezione]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadAlternative(); }, [loadAlternative]);

  const totaleConflitti = report?.perClasse.reduce((n, c) => n + c.alunni.filter(a => a.conflitti.length > 0).length, 0) ?? 0;
  const automatiche = report?.alternative_automatiche ?? [];
  const tuttiAlunni = report?.perClasse.flatMap(c => c.alunni.map(a => ({ id: a.id, nome: a.nome, classe: c.classe }))) ?? [];

  const registra = async () => {
    if (!formAlunno || !formNota.trim()) return;
    setSalvando(true); setAltError(null);
    try {
      const res = await fetch('/api/mensa/alternative', {
        method: 'POST',
        headers: hdr(userId),
        body: JSON.stringify({ alunno_id: formAlunno, data, richiesta: formNota.trim() }),
      });
      const j = await res.json();
      if (j.success) { setFormNota(''); setFormAlunno(''); await loadAlternative(); }
      else setAltError(j.error ?? 'Errore nel salvataggio');
    } catch {
      setAltError('Errore di rete nel salvataggio');
    } finally {
      setSalvando(false);
    }
  };

  const elimina = async (alunnoId: string) => {
    setAltError(null);
    try {
      const qs = new URLSearchParams({ userId, alunno_id: alunnoId, data });
      const res = await fetch(`/api/mensa/alternative?${qs}`, { method: 'DELETE', headers: hdr(userId) });
      const j = await res.json();
      if (j.success) await loadAlternative();
      else setAltError(j.error ?? 'Errore nell\'eliminazione');
    } catch {
      setAltError('Errore di rete nell\'eliminazione');
    }
  };

  return (
    <div className="kv-mensa-alt">
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div>
          <label className="font-maven text-xs text-kidville-muted block mb-1">Data</label>
          <DateField value={data} onChange={setData}
            className="min-h-[44px] border-2 border-kidville-line rounded-lg px-3 py-1.5 font-maven text-sm text-kidville-green" />
        </div>
        {!sezione && sezioni && sezioni.length > 0 && (
          <div>
            <label className="font-maven text-xs text-kidville-muted block mb-1">Sezione</label>
            <select value={filtroSezione} onChange={e => setFiltroSezione(e.target.value)}
              className="min-h-[44px] border-2 border-kidville-line rounded-lg px-3 py-1.5 font-maven text-sm text-kidville-green bg-white">
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
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-kidville-error-strong text-white animate-pulse">
            <AlertTriangle size={16} />
            <span className="font-barlow font-black text-lg leading-none">{totaleConflitti}</span>
            <span className="font-maven text-[11px] opacity-90">allergie nel menu di oggi</span>
          </div>
        )}
      </div>

      {error && <p role="alert" className="font-maven text-sm text-kidville-error-strong mb-3">{error}</p>}
      {loading && <p className="font-maven text-sm text-kidville-muted">Caricamento…</p>}

      {report && !loading && (
        <div className="space-y-4">
          {/* ── Alternative del giorno ─────────────────────────────────────── */}
          <div className="rounded-2xl border border-kidville-line bg-white overflow-hidden">
            <div className="flex items-center gap-1.5 px-3 py-2 bg-kidville-cream/60">
              <UtensilsCrossed size={13} className="text-kidville-green" />
              <span className="font-barlow font-bold text-kidville-green uppercase text-xs">Alternative del giorno</span>
            </div>
            <div className="p-3 space-y-3">
              {/* Automatiche per allergia (derivate dal menu, nessuna scrittura) */}
              {automatiche.length === 0 ? (
                <p className="font-maven text-xs text-kidville-muted">Nessuna alternativa automatica per allergia oggi.</p>
              ) : (
                <ul className="space-y-1.5">
                  {automatiche.map(a => (
                    <li key={`auto-${a.alunno_id}`} className="flex items-start gap-2 rounded-xl bg-kidville-error-soft px-3 py-2">
                      <AlertTriangle size={14} className="text-kidville-error shrink-0 mt-0.5" />
                      <span className="font-maven text-sm text-kidville-error-strong">
                        <strong>Alternativa per allergia</strong> per {a.nome} ({a.classe}) — allergeni: {(a.allergeni_label.length ? a.allergeni_label : a.allergeni.map(allergeneLabel)).join(', ')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {/* Manuali (richieste registrate dalla segreteria) */}
              {alternative.length > 0 && (
                <ul className="space-y-1.5" aria-live="polite">
                  {alternative.map(a => (
                    <li key={a.id} className="flex items-start gap-2 rounded-xl bg-kidville-cream/50 px-3 py-2">
                      <UtensilsCrossed size={14} className="text-kidville-green shrink-0 mt-0.5" />
                      <span className="font-maven text-sm text-kidville-ink flex-1">
                        <strong>Alternativa richiesta</strong> per {a.nome} ({a.classe}): {a.richiesta}
                        {a.origine === 'genitore' && <span className="ml-1 text-[11px] text-kidville-muted">(richiesta dal genitore)</span>}
                      </span>
                      {!soloLettura && (
                        <button onClick={() => elimina(a.alunno_id)} title="Elimina alternativa"
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-kidville-error hover:opacity-70">
                          <Trash2 size={16} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {altError && <p role="alert" className="font-maven text-xs text-kidville-error-strong">{altError}</p>}

              {/* Form segreteria/direzione: registra un'alternativa (sovrascrive quella del giorno) */}
              {!soloLettura && tuttiAlunni.length > 0 && (
                <div className="rounded-xl border border-dashed border-kidville-line p-3 space-y-2">
                  <p className="font-maven text-[11px] text-kidville-muted">
                    Registra un&apos;alternativa per il {new Date(`${data}T00:00:00`).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })}.
                    Sovrascrive un&apos;eventuale nota già presente per lo stesso bambino e giorno.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <label htmlFor="mensa-alt-alunno" className="sr-only">Bambino</label>
                    <select id="mensa-alt-alunno" value={formAlunno} onChange={e => setFormAlunno(e.target.value)}
                      style={{ fontSize: '16px' }}
                      className="min-h-[44px] border-2 border-kidville-line rounded-lg px-3 py-1.5 font-maven text-kidville-green bg-white min-w-[180px]">
                      <option value="">Scegli il bambino…</option>
                      {tuttiAlunni.map(a => <option key={a.id} value={a.id}>{a.nome} ({a.classe})</option>)}
                    </select>
                    <label htmlFor="mensa-alt-nota" className="sr-only">Nota alternativa</label>
                    <input id="mensa-alt-nota" type="text" value={formNota} onChange={e => setFormNota(e.target.value)}
                      placeholder="Es. pasto in bianco, senza latticini…"
                      style={{ fontSize: '16px' }}
                      className="min-h-[44px] flex-1 min-w-[180px] border-2 border-kidville-line rounded-lg px-3 py-1.5 font-maven text-kidville-ink" />
                    <button onClick={registra} disabled={salvando || !formAlunno || !formNota.trim()}
                      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-kidville-green text-white font-maven text-sm px-4 py-1.5 disabled:opacity-40">
                      <Plus size={15} /> {salvando ? 'Salvo…' : 'Registra alternativa'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

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
                              <span className={`font-maven text-sm ${conflitto ? 'text-kidville-error-strong font-bold' : 'text-kidville-green'}`}>
                                {conflitto && <AlertTriangle size={12} className="inline mr-1 -mt-0.5 text-kidville-error" />}
                                {a.nome}
                              </span>
                              {a.allergeni.length > 0 && (
                                <span className="flex flex-wrap gap-1 justify-end">
                                  {a.allergeni.map(k => {
                                    const inConflitto = a.conflitti.some(cf => cf.allergene === k);
                                    return (
                                      <span key={k} title={allergeneLabel(k)}
                                        className={`px-1.5 py-0.5 rounded-full font-maven text-[10px] font-bold ${inConflitto ? 'bg-kidville-error-strong text-white' : 'bg-kidville-line text-kidville-sub'}`}>
                                        {allergeneEmoji(k)} {allergeneLabel(k)}
                                      </span>
                                    );
                                  })}
                                </span>
                              )}
                            </div>
                            {conflitto && (
                              <p className="font-maven text-[11px] text-kidville-error-strong mt-0.5">
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
