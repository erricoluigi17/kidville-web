'use client';

import { useState, useEffect, useCallback } from 'react';
import { Search, CalendarPlus, Ticket, CheckCircle2, AlertTriangle } from 'lucide-react';

interface Props { userId: string; scuolaId: string }
interface Alunno { id: string; nome: string; cognome: string; classe_sezione?: string }
const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

export function PrenotazioneSegreteria({ userId, scuolaId }: Props) {
  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<Alunno | null>(null);
  const [saldo, setSaldo] = useState<number | null>(null);
  const [data, setData] = useState(() => new Date().toISOString().slice(0, 10));
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/admin/students?scuola_id=${scuolaId}&limit=1000`).then(r => r.json())
      .then(d => { if (Array.isArray(d)) setAlunni(d.map((a: Alunno) => ({ id: a.id, nome: a.nome, cognome: a.cognome, classe_sezione: a.classe_sezione }))); });
  }, [scuolaId]);

  const loadSaldo = useCallback((alunnoId: string) => {
    fetch(`/api/mensa/prenotazioni?userId=${userId}&alunno_id=${alunnoId}&from=${data}&to=${data}`, { headers: hdr(userId) })
      .then(r => r.json()).then(d => { if (d.success) setSaldo(d.data.saldo); });
  }, [userId, data]);

  const select = (a: Alunno) => { setSel(a); setMsg(null); loadSaldo(a.id); };

  const inserisci = async () => {
    if (!sel) return;
    setMsg(null);
    const res = await fetch('/api/mensa/prenotazioni', {
      method: 'POST', headers: hdr(userId),
      body: JSON.stringify({ alunno_id: sel.id, date: [data], origine: 'segreteria' }),
    });
    const j = await res.json();
    if (j.success) {
      setSaldo(j.data.saldo);
      const esito = j.data.esiti?.[0];
      if (esito && !esito.ok) setMsg(esito.motivo ?? 'Operazione non riuscita');
      else setMsg(`Ticket inserito per il ${new Date(`${data}T00:00:00Z`).toLocaleDateString('it-IT')}. Nuovo saldo: ${j.data.saldo}.`);
    } else setMsg(j.error ?? 'Errore');
  };

  const filtered = alunni.filter(a => `${a.nome} ${a.cognome}`.toLowerCase().includes(search.toLowerCase())).slice(0, 8);

  return (
    <div className="grid md:grid-cols-2 gap-5">
      <div>
        <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm mb-3 flex items-center gap-2"><Search size={14} /> Seleziona alunno</h3>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca…"
          className="w-full border-2 border-kidville-line rounded-full px-4 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green mb-2" />
        <div className="space-y-1 max-h-72 overflow-y-auto">
          {filtered.map(a => (
            <button key={a.id} onClick={() => select(a)}
              className={`w-full text-left px-3 py-2 rounded-xl font-maven text-sm ${sel?.id === a.id ? 'bg-kidville-green text-white' : 'hover:bg-kidville-cream text-kidville-green'}`}>
              {a.nome} {a.cognome} <span className="text-xs opacity-70">{a.classe_sezione}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm mb-3 flex items-center gap-2"><CalendarPlus size={14} /> Inserisci ticket giornaliero</h3>
        {!sel ? <p className="font-maven text-sm text-kidville-muted">Seleziona un alunno.</p> : (
          <div className="bg-kidville-cream/60 rounded-xl p-4">
            <div className="flex justify-between mb-3">
              <span className="font-maven text-sm text-kidville-green font-bold">{sel.nome} {sel.cognome}</span>
              <span className="font-maven text-sm text-kidville-muted flex items-center gap-1">
                <Ticket size={13} /> Saldo: <b className={saldo != null && saldo < 0 ? 'text-kidville-error' : 'text-kidville-green'}>{saldo ?? '—'}</b>
              </span>
            </div>
            <label className="font-maven text-xs text-kidville-muted block mb-1">Data del pasto</label>
            <input type="date" value={data} onChange={e => { setData(e.target.value); if (sel) loadSaldo(sel.id); }}
              className="w-full border-2 border-kidville-line rounded-lg px-3 py-1.5 font-maven text-sm text-kidville-green mb-3" />
            <button onClick={inserisci} className="w-full py-2.5 rounded-full bg-kidville-green text-white font-maven font-bold text-sm flex items-center justify-center gap-1">
              <CalendarPlus size={15} /> Inserisci ticket (scala 1)
            </button>
            <p className="mt-2 font-maven text-[11px] text-kidville-muted flex items-start gap-1">
              <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" /> La segreteria può forzare l&apos;inserimento anche con saldo a zero: il saldo andrà in negativo (debito).
            </p>
            {msg && <p className="mt-2 font-maven text-xs text-kidville-green flex items-center gap-1"><CheckCircle2 size={13} /> {msg}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
