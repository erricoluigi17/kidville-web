'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, GraduationCap } from 'lucide-react';
import { DateField } from '@/components/ui/DateField';

interface Periodo {
  id: string; nome: string; anno_scolastico: string; ordine: number;
  data_inizio: string | null; data_fine: string | null; attivo: boolean;
}

const annoCorrente = () => {
  // Anno scolastico: settembre→agosto. (Date dinamica accettabile lato client.)
  const d = new Date();
  const y = d.getFullYear();
  const start = d.getMonth() >= 8 ? y : y - 1;
  return `${start}/${start + 1}`;
};

export function ScrutinioPeriodiManager({ userId }: { scuolaId: string; userId: string }) {
  const [periodi, setPeriodi] = useState<Periodo[]>([]);
  const [anno, setAnno] = useState(annoCorrente);
  const [nome, setNome] = useState('');
  const [dataInizio, setDataInizio] = useState('');
  const [dataFine, setDataFine] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    let next: Periodo[] | null = null;
    try {
      const r = await fetch(`/api/admin/primaria/scrutinio-periodi?annoScolastico=${anno}&userId=${userId}`, { headers: { 'x-user-id': userId } });
      const d = await r.json();
      if (d.success) next = d.data;
    } finally {
      if (next) setPeriodi(next);
    }
  }, [anno, userId]);

  useEffect(() => { load(); }, [load]);

  const aggiungi = async () => {
    setMsg('');
    if (!nome.trim()) { setMsg('Inserisci il nome del periodo'); return; }
    const r = await fetch(`/api/admin/primaria/scrutinio-periodi?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ annoScolastico: anno, nome: nome.trim(), ordine: periodi.length + 1, dataInizio: dataInizio || null, dataFine: dataFine || null }),
    });
    const d = await r.json();
    if (!r.ok) { setMsg(d.error || 'Errore'); return; }
    setNome(''); setDataInizio(''); setDataFine('');
    load();
  };

  const rimuovi = async (id: string) => {
    if (!confirm('Eliminare il periodo? Verranno rimossi anche gli scrutini collegati.')) return;
    await fetch(`/api/admin/primaria/scrutinio-periodi?id=${id}&userId=${userId}`, { method: 'DELETE', headers: { 'x-user-id': userId } });
    load();
  };

  const toggleAttivo = async (p: Periodo) => {
    await fetch(`/api/admin/primaria/scrutinio-periodi?userId=${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ id: p.id, attivo: !p.attivo }),
    });
    load();
  };

  return (
    <div>
      <h3 className="font-barlow text-base font-bold text-kidville-ink mb-1 flex items-center gap-2">
        <GraduationCap size={16} className="text-kidville-green" /> Periodi di scrutinio
      </h3>
      <p className="font-maven text-xs text-kidville-muted mb-4">Definisci i periodi (es. 1° Quadrimestre, Scrutinio finale). I docenti li selezioneranno nella sezione Scrutinio.</p>

      <div className="mb-4 flex items-center gap-2">
        <label className="font-maven text-sm text-kidville-ink">Anno scolastico:</label>
        <input value={anno} onChange={(e) => setAnno(e.target.value)} className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm w-28" />
      </div>

      <ul className="divide-y divide-kidville-line mb-4">
        {periodi.length === 0 && <li className="py-2 font-maven text-sm text-kidville-muted">Nessun periodo per quest&apos;anno.</li>}
        {periodi.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2 py-2.5">
            <div>
              <span className="font-maven text-sm font-semibold text-kidville-ink">{p.ordine}. {p.nome}</span>
              {(p.data_inizio || p.data_fine) && (
                <span className="font-maven text-xs text-kidville-muted ml-2">
                  {p.data_inizio ? new Date(p.data_inizio).toLocaleDateString('it-IT') : '…'} – {p.data_fine ? new Date(p.data_fine).toLocaleDateString('it-IT') : '…'}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => toggleAttivo(p)} className={`font-maven rounded-pill px-2.5 py-0.5 text-[11px] ${p.attivo ? 'bg-kidville-success-soft text-kidville-success' : 'bg-kidville-line text-kidville-muted'}`}>
                {p.attivo ? 'attivo' : 'disattivo'}
              </button>
              <button onClick={() => rimuovi(p.id)} className="text-kidville-muted hover:text-kidville-error"><Trash2 size={15} /></button>
            </div>
          </li>
        ))}
      </ul>

      <div className="rounded-card bg-kidville-cream/40 p-3">
        <p className="font-maven text-xs text-kidville-muted mb-2">Nuovo periodo</p>
        <div className="grid gap-2 md:grid-cols-3">
          <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome (es. Scrutinio finale)" className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm" />
          <DateField value={dataInizio} onChange={setDataInizio} aria-label="Data inizio periodo" className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm" />
          <DateField value={dataFine} onChange={setDataFine} aria-label="Data fine periodo" className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm" />
        </div>
        {msg && <p className="font-maven text-xs text-kidville-error mt-2">{msg}</p>}
        <button onClick={aggiungi} className="font-maven mt-2 inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow">
          <Plus size={14} /> Aggiungi periodo
        </button>
      </div>
    </div>
  );
}
