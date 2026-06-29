'use client';

import { useState, useEffect, useCallback } from 'react';
import { Building2, Loader2, Pencil, Check, X, Plus, Power, ShieldCheck } from 'lucide-react';

interface Scuola {
  id: string;
  nome: string;
  citta?: string | null;
  indirizzo?: string | null;
  attiva: boolean;
}

// Pannello Multi-Sede (DL-033) — riservato alla Direzione (gate server).
export function SchoolsPanel({ userId }: { userId: string }) {
  const [scuole, setScuole] = useState<Scuola[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [draftNome, setDraftNome] = useState('');
  const [nuova, setNuova] = useState({ nome: '', citta: '', indirizzo: '' });
  const [showNuova, setShowNuova] = useState(false);

  const hdr = { 'Content-Type': 'application/json', 'x-user-id': userId };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/schools', { headers: { 'x-user-id': userId } });
      const j = await res.json();
      if (Array.isArray(j)) setScuole(j);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const crea = async () => {
    if (!nuova.nome.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/admin/schools', { method: 'POST', headers: hdr, body: JSON.stringify(nuova) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); alert(j.error || 'Errore'); return; }
      setNuova({ nome: '', citta: '', indirizzo: '' });
      setShowNuova(false);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/schools', { method: 'PATCH', headers: hdr, body: JSON.stringify({ id, ...body }) });
      if (res.status === 403) { alert('Azione riservata alla Direzione.'); return; }
      if (!res.ok) { const j = await res.json().catch(() => ({})); alert(j.error || 'Errore'); return; }
      setEditId(null);
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex items-center gap-2 text-gray-400 p-6"><Loader2 className="animate-spin" size={16} /> Caricamento sedi…</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-kidville-green">
        <Building2 size={18} />
        <h3 className="font-barlow font-black uppercase tracking-wide">Gestione Multi-Sede</h3>
        <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-gray-400"><ShieldCheck size={12} /> solo Direzione</span>
      </div>

      <div className="space-y-2">
        {scuole.map((s) => (
          <div key={s.id} className="bg-white rounded-card border border-gray-100 p-4 flex items-center justify-between gap-3">
            {editId === s.id ? (
              <input
                value={draftNome}
                onChange={(e) => setDraftNome(e.target.value)}
                className="flex-1 border-2 border-kidville-green/20 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-kidville-green"
                autoFocus
              />
            ) : (
              <div className="min-w-0">
                <p className="font-barlow font-bold text-kidville-green truncate">
                  {s.nome}
                  {!s.attiva && <span className="ml-2 text-[10px] uppercase bg-gray-100 text-gray-400 px-2 py-0.5 rounded-full">Disattivata</span>}
                  {s.attiva && <span className="ml-2 text-[10px] uppercase bg-kidville-success-soft text-kidville-success px-2 py-0.5 rounded-full">Attiva</span>}
                </p>
                <p className="font-maven text-xs text-gray-400 truncate">{[s.citta, s.indirizzo].filter(Boolean).join(' · ') || '—'}</p>
              </div>
            )}

            <div className="flex items-center gap-1.5 flex-shrink-0">
              {editId === s.id ? (
                <>
                  <button disabled={saving} onClick={() => patch(s.id, { nome: draftNome })} className="p-2 rounded-lg text-kidville-success hover:bg-kidville-success-soft" title="Salva">
                    <Check size={16} />
                  </button>
                  <button onClick={() => setEditId(null)} className="p-2 rounded-lg text-gray-400 hover:bg-gray-50" title="Annulla">
                    <X size={16} />
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => { setEditId(s.id); setDraftNome(s.nome); }} className="p-2 rounded-lg text-gray-400 hover:text-kidville-green hover:bg-gray-50" title="Rinomina">
                    <Pencil size={16} />
                  </button>
                  <button
                    disabled={saving}
                    onClick={() => patch(s.id, { attiva: !s.attiva })}
                    className={`p-2 rounded-lg hover:bg-gray-50 ${s.attiva ? 'text-kidville-success' : 'text-gray-300'}`}
                    title={s.attiva ? 'Disattiva' : 'Riattiva'}
                  >
                    <Power size={16} />
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {showNuova ? (
        <div className="bg-kidville-cream/40 rounded-card border border-kidville-green/10 p-4 space-y-2">
          <input value={nuova.nome} onChange={(e) => setNuova({ ...nuova, nome: e.target.value })} placeholder="Nome sede *" className="w-full border-2 border-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-kidville-green" />
          <div className="grid grid-cols-2 gap-2">
            <input value={nuova.citta} onChange={(e) => setNuova({ ...nuova, citta: e.target.value })} placeholder="Città" className="border-2 border-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-kidville-green" />
            <input value={nuova.indirizzo} onChange={(e) => setNuova({ ...nuova, indirizzo: e.target.value })} placeholder="Indirizzo" className="border-2 border-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-kidville-green" />
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowNuova(false)} className="px-3 py-1.5 text-sm rounded-pill border border-gray-200 text-gray-500">Annulla</button>
            <button disabled={saving || !nuova.nome.trim()} onClick={crea} className="px-4 py-1.5 text-sm font-bold uppercase rounded-pill bg-kidville-green text-kidville-yellow disabled:opacity-50">
              {saving ? 'Creazione…' : 'Crea sede'}
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowNuova(true)} className="flex items-center gap-1.5 px-4 py-2 rounded-pill bg-kidville-green text-kidville-yellow font-barlow font-black uppercase text-xs tracking-wider">
          <Plus size={16} /> Aggiungi Sede
        </button>
      )}
    </div>
  );
}
