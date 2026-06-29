'use client';

import { useState, useEffect, useCallback } from 'react';
import { ShieldAlert, Loader2, Trash2, AlertTriangle, X } from 'lucide-react';

interface Candidato {
  id: string;
  nome: string;
  cognome: string;
  classe_sezione?: string | null;
  stato?: string | null;
  genitori: { id: string; nome: string }[];
}

interface DryRun {
  alunno: number;
  parents: number;
  parents_non_anonimizzati: number;
  file_da_rimuovere: number;
  nominativo_conferma: string;
}

// Pannello Diritto all'oblio (DL-034) — riservato alla Direzione (gate server).
export function OblioPanel({ userId }: { userId: string }) {
  const [list, setList] = useState<Candidato[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<Candidato | null>(null);
  const [dry, setDry] = useState<DryRun | null>(null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const hdr = { 'Content-Type': 'application/json', 'x-user-id': userId };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/gdpr/candidates', { headers: { 'x-user-id': userId } });
      const j = await res.json();
      if (Array.isArray(j)) setList(j);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const apri = async (c: Candidato) => {
    setTarget(c);
    setConfirm('');
    setDry(null);
    setBusy(true);
    try {
      const res = await fetch('/api/admin/gdpr/erase', { method: 'POST', headers: hdr, body: JSON.stringify({ alunno_id: c.id, mode: 'dryrun' }) });
      const j = await res.json();
      if (res.ok) setDry(j);
    } finally {
      setBusy(false);
    }
  };

  const esegui = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/gdpr/erase', { method: 'POST', headers: hdr, body: JSON.stringify({ alunno_id: target.id, mode: 'execute', confirm }) });
      const j = await res.json();
      if (!res.ok) { alert(j.error || 'Errore'); return; }
      setTarget(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="flex items-center gap-2 text-gray-400 p-6"><Loader2 className="animate-spin" size={16} /> Caricamento…</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-kidville-green">
        <ShieldAlert size={18} />
        <h3 className="font-barlow font-black uppercase tracking-wide">Diritto all&apos;Oblio (GDPR)</h3>
      </div>
      <p className="font-maven text-xs text-gray-500">
        Alunni <strong>non iscritti</strong> e relativi genitori. La cancellazione definitiva
        <strong> anonimizza</strong> i dati personali (irreversibile); audit e registri fiscali restano per obbligo di legge.
      </p>

      {list.length === 0 ? (
        <div className="bg-white rounded-card border border-gray-100 p-8 text-center font-maven text-sm text-gray-400">
          Nessun alunno non iscritto da cancellare.
        </div>
      ) : (
        <div className="space-y-2">
          {list.map((c) => (
            <div key={c.id} className="bg-white rounded-card border border-gray-100 p-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-barlow font-bold text-kidville-green truncate">
                  {c.cognome} {c.nome}
                  <span className="ml-2 text-[10px] uppercase bg-gray-100 text-gray-400 px-2 py-0.5 rounded-full">{c.stato ?? 'non iscritto'}</span>
                </p>
                <p className="font-maven text-xs text-gray-400 truncate">
                  {c.classe_sezione ? `Classe ${c.classe_sezione} · ` : ''}
                  Genitori: {c.genitori.map((g) => g.nome).join(', ') || '—'}
                </p>
              </div>
              <button
                onClick={() => apri(c)}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-pill border border-red-200 text-red-500 hover:bg-red-50 font-barlow font-bold text-xs uppercase tracking-wider flex-shrink-0"
              >
                <Trash2 size={14} /> Cancella
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Modale doppia conferma */}
      {target && (
        <div className="fixed inset-0 bg-kidville-green/30 z-50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-card p-6 shadow-2xl border-t-4 border-red-400">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-barlow font-black text-xl text-red-500 uppercase tracking-wide flex items-center gap-2">
                <AlertTriangle size={20} /> Cancellazione definitiva
              </h3>
              <button onClick={() => setTarget(null)} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
            </div>

            <p className="font-maven text-sm text-gray-600 mb-3">
              Stai per <strong>anonimizzare irreversibilmente</strong> i dati di <strong>{target.cognome} {target.nome}</strong>.
            </p>

            {busy && !dry ? (
              <div className="flex items-center gap-2 text-gray-400 text-sm py-3"><Loader2 className="animate-spin" size={14} /> Analisi…</div>
            ) : dry ? (
              <div className="bg-gray-50 rounded-xl p-3 text-xs font-maven text-gray-600 space-y-1 mb-4">
                <div>Anagrafica alunno anonimizzata: <strong>{dry.alunno}</strong></div>
                <div>Genitori anonimizzati (orfani): <strong>{dry.parents}</strong></div>
                {dry.parents_non_anonimizzati > 0 && <div className="text-kidville-warn">Genitori con altri figli iscritti (mantenuti): {dry.parents_non_anonimizzati}</div>}
                <div>File personali rimossi: <strong>{dry.file_da_rimuovere}</strong></div>
              </div>
            ) : null}

            <label className="block font-maven text-xs font-semibold text-gray-500 mb-1.5">
              Per confermare, digita <span className="font-mono text-red-500">{dry?.nominativo_conferma ?? `${target.cognome} ${target.nome}`.toUpperCase()}</span>
            </label>
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Cognome Nome"
              className="w-full border-2 border-gray-100 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-red-400 mb-4"
            />

            <div className="flex gap-3 justify-end">
              <button onClick={() => setTarget(null)} className="px-4 py-2 text-sm rounded-pill border border-gray-200 text-gray-500 hover:bg-gray-50">Annulla</button>
              <button
                disabled={busy || !confirm.trim()}
                onClick={esegui}
                className="px-5 py-2 text-sm font-barlow font-black uppercase tracking-wider rounded-pill bg-red-500 text-white hover:bg-red-600 disabled:opacity-50"
              >
                {busy ? 'Cancellazione…' : 'Cancella definitivamente'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
