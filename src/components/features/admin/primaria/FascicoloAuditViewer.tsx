'use client';

import { useCallback, useEffect, useState } from 'react';
import { FolderLock, RefreshCw } from 'lucide-react';

interface AuditRow {
  id: string;
  azione: string;
  finalita: string | null;
  ip: string | null;
  creato_il: string;
  utenti: { nome: string | null; cognome: string | null; ruolo?: string | null; role?: string | null } | null;
  alunni: { nome: string | null; cognome: string | null } | null;
}

const AZIONE: Record<string, { l: string; cls: string }> = {
  list: { l: 'Elenco', cls: 'bg-kidville-line text-kidville-ink' },
  view: { l: 'Visualizzazione', cls: 'bg-kidville-info-soft text-kidville-info' },
  download: { l: 'Download', cls: 'bg-kidville-warn-soft text-kidville-warn' },
  upload: { l: 'Caricamento', cls: 'bg-kidville-success-soft text-kidville-success' },
  delete: { l: 'Eliminazione', cls: 'bg-kidville-error-soft text-kidville-error' },
};

export function FascicoloAuditViewer({ userId }: { scuolaId: string; userId: string }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetch(`/api/admin/primaria/fascicolo-audit?limit=200&userId=${userId}`, { headers: { 'x-user-id': userId } });
    const d = await r.json();
    if (d.success) setRows(d.data);
    setLoading(false);
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-barlow text-base font-bold text-kidville-ink flex items-center gap-2">
          <FolderLock size={16} className="text-kidville-green" /> Registro accessi al fascicolo
        </h3>
        <button onClick={load} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green/10 px-3 py-1.5 text-xs text-kidville-green">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Aggiorna
        </button>
      </div>
      <p className="font-maven text-xs text-kidville-muted mb-3">Log immodificabile degli accessi ai documenti riservati (PEI/PDP/sanitari).</p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left font-maven text-xs text-kidville-muted">
              <th className="py-2 pr-3">Data/ora</th>
              <th className="py-2 pr-3">Azione</th>
              <th className="py-2 pr-3">Utente</th>
              <th className="py-2 pr-3">Alunno</th>
              <th className="py-2 pr-3">IP</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={5} className="py-3 font-maven text-sm text-kidville-muted">Nessun accesso registrato.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-kidville-line font-maven">
                <td className="py-2 pr-3 text-kidville-ink whitespace-nowrap">{new Date(r.creato_il).toLocaleString('it-IT')}</td>
                <td className="py-2 pr-3">
                  <span className={`rounded-pill px-2 py-0.5 text-[11px] ${AZIONE[r.azione]?.cls ?? 'bg-kidville-line text-kidville-ink'}`}>{AZIONE[r.azione]?.l ?? r.azione}</span>
                </td>
                <td className="py-2 pr-3 text-kidville-ink">{r.utenti ? `${r.utenti.cognome ?? ''} ${r.utenti.nome ?? ''}`.trim() || '—' : '—'}</td>
                <td className="py-2 pr-3 text-kidville-ink">{r.alunni ? `${r.alunni.cognome ?? ''} ${r.alunni.nome ?? ''}`.trim() || '—' : '—'}</td>
                <td className="py-2 pr-3 text-kidville-muted text-xs">{r.ip ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
