'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { AlertTriangle, Check } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';

interface Alunno { id: string; nome: string; cognome: string }
interface Nota {
  id: string; alunno_id: string; categoria: string; testo: string; richiede_firma: boolean;
  firmata_il: string | null; creato_il: string; alunni?: { nome: string; cognome: string } | null;
}

const CATEGORIE: { key: string; label: string; cls: string }[] = [
  { key: 'disciplinare', label: 'Disciplinare', cls: 'bg-kidville-error/10 text-kidville-error' },
  { key: 'didattica', label: 'Didattica', cls: 'bg-kidville-info-soft text-kidville-info' },
  { key: 'compiti_non_svolti', label: 'Compiti non svolti', cls: 'bg-kidville-warn-soft text-kidville-warn' },
];

export default function NotePage() {
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);

  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [note, setNote] = useState<Nota[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [categoria, setCategoria] = useState('disciplinare');
  const [testo, setTesto] = useState('');
  const [richiedeFirma, setRichiedeFirma] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/primaria/classe/${sectionId}?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) { setAlunni(d.data.alunni ?? []); setApiError(null); }
        else setApiError(d.error ?? 'Impossibile caricare gli alunni');
      });
  }, [sectionId, userId]);

  const loadNote = useCallback(async () => {
    const r = await fetch(`/api/primaria/note?sectionId=${sectionId}&userId=${userId}`);
    const d = await r.json();
    if (d.success) setNote(d.data);
  }, [sectionId, userId]);

  useEffect(() => { loadNote(); }, [loadNote]);

  const toggle = (id: string) => setSel((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleAll = () => setSel(sel.length === alunni.length ? [] : alunni.map((a) => a.id));

  const salva = async () => {
    setMsg('');
    if (sel.length === 0 || !testo) { setMsg('Seleziona alunni e scrivi il testo'); return; }
    setSaving(true);
    const r = await fetch(`/api/primaria/note?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ sectionId, alunnoIds: sel, categoria, testo, richiedeFirma }),
    });
    const d = await r.json();
    setSaving(false);
    if (!r.ok) setMsg(d.error || 'Errore');
    else { setMsg('Nota inviata ✓'); setTesto(''); setSel([]); loadNote(); }
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="rounded-card bg-white p-5 shadow-sm">
        <h2 className="font-barlow text-lg font-bold text-kidville-ink mb-3 flex items-center gap-2">
          <AlertTriangle size={18} className="text-kidville-warn" /> Nuova nota
        </h2>

        {apiError && (
          <div className="mb-3 flex items-center gap-2 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error">
            <AlertTriangle size={14} /> {apiError}
          </div>
        )}

        <div className="mb-2 flex items-center justify-between">
          <label className="font-maven text-xs text-kidville-muted">Alunni</label>
          <button onClick={toggleAll} className="font-maven text-xs text-kidville-green">{sel.length === alunni.length ? 'Deseleziona tutti' : 'Tutta la classe'}</button>
        </div>
        <div className="mb-3 max-h-36 overflow-y-auto rounded-card border border-kidville-line p-2">
          {alunni.map((a) => (
            <label key={a.id} className="flex items-center gap-2 py-0.5 font-maven text-sm">
              <input type="checkbox" checked={sel.includes(a.id)} onChange={() => toggle(a.id)} />
              {a.cognome} {a.nome}
            </label>
          ))}
        </div>

        <div className="mb-3 flex flex-wrap gap-1.5">
          {CATEGORIE.map((c) => (
            <button key={c.key} onClick={() => setCategoria(c.key)} className={`font-maven rounded-pill px-3 py-1 text-xs ${categoria === c.key ? c.cls + ' ring-1 ring-current' : 'bg-kidville-cream text-kidville-muted'}`}>{c.label}</button>
          ))}
        </div>

        <textarea value={testo} onChange={(e) => setTesto(e.target.value)} rows={3} placeholder="Testo della nota…" className="font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm mb-2" />
        <label className="mb-3 flex items-center gap-2 font-maven text-sm text-kidville-ink">
          <input type="checkbox" checked={richiedeFirma} onChange={(e) => setRichiedeFirma(e.target.checked)} />
          Richiedi firma di presa visione al genitore
        </label>

        {msg && <p className={`font-maven text-sm mb-2 ${msg.includes('✓') ? 'text-kidville-success' : 'text-kidville-error'}`}>{msg}</p>}
        <button onClick={salva} disabled={saving} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow disabled:opacity-50">
          <Check size={15} /> {saving ? 'Invio…' : 'Invia nota'}
        </button>
      </div>

      <div className="rounded-card bg-white p-5 shadow-sm">
        <h3 className="font-barlow text-base font-bold text-kidville-ink mb-3">Note recenti</h3>
        <ul className="divide-y divide-kidville-line">
          {note.map((n) => {
            const cat = CATEGORIE.find((c) => c.key === n.categoria);
            return (
              <li key={n.id} className="py-2.5">
                <div className="flex items-center gap-2">
                  <span className={`rounded-pill px-2 py-0.5 text-[11px] font-maven ${cat?.cls}`}>{cat?.label}</span>
                  <span className="font-maven text-sm text-kidville-ink">{n.alunni?.cognome} {n.alunni?.nome}</span>
                  {n.richiede_firma && (
                    <span className={`text-[11px] font-maven ${n.firmata_il ? 'text-kidville-success' : 'text-kidville-warn'}`}>
                      {n.firmata_il ? '✓ firmata' : 'attesa firma'}
                    </span>
                  )}
                </div>
                <p className="font-maven text-xs text-kidville-muted mt-0.5">{n.testo}</p>
              </li>
            );
          })}
          {note.length === 0 && <li className="py-2 font-maven text-sm text-kidville-muted">Nessuna nota.</li>}
        </ul>
      </div>
    </div>
  );
}
