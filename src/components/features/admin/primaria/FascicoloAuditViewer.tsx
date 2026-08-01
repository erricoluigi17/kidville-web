'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { intlDateTime } from '@/i18n/config';
import { useDateFormat } from '@/lib/i18n/date';
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

// La chiave del record è il valore DB (r.azione); `lKey` è la chiave i18n dell'etichetta.
const AZIONE: Record<string, { lKey: string; cls: string }> = {
  list: { lKey: 'fascicoloAzioneList', cls: 'bg-kidville-line text-kidville-ink' },
  view: { lKey: 'fascicoloAzioneView', cls: 'bg-kidville-info-soft text-kidville-info' },
  download: { lKey: 'fascicoloAzioneDownload', cls: 'bg-kidville-warn-soft text-kidville-warn' },
  upload: { lKey: 'fascicoloAzioneUpload', cls: 'bg-kidville-success-soft text-kidville-success' },
  delete: { lKey: 'fascicoloAzioneDelete', cls: 'bg-kidville-error-soft text-kidville-error' },
};

export function FascicoloAuditViewer({ userId }: { scuolaId: string; userId: string }) {
  const t = useTranslations('adminPrimaria');
  const f = useDateFormat();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/primaria/fascicolo-audit?limit=200&userId=${userId}`, { headers: { 'x-user-id': userId } });
      const d = await r.json();
      if (d.success) setRows(d.data);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-barlow text-base font-bold text-kidville-ink flex items-center gap-2">
          <FolderLock size={16} className="text-kidville-green" /> {t('fascicoloTitolo')}
        </h3>
        <button onClick={load} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green/10 px-3 py-1.5 text-xs text-kidville-green">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> {t('fascicoloAggiorna')}
        </button>
      </div>
      <p className="font-maven text-xs text-kidville-muted mb-3">{t('fascicoloSottotitolo')}</p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left font-maven text-xs text-kidville-muted">
              <th className="py-2 pr-3">{t('fascicoloColData')}</th>
              <th className="py-2 pr-3">{t('fascicoloColAzione')}</th>
              <th className="py-2 pr-3">{t('fascicoloColUtente')}</th>
              <th className="py-2 pr-3">{t('fascicoloColAlunno')}</th>
              <th className="py-2 pr-3">{t('fascicoloColIp')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={5} className="py-3 font-maven text-sm text-kidville-muted">{t('fascicoloNessunAccesso')}</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-kidville-line font-maven">
                <td className="py-2 pr-3 text-kidville-ink whitespace-nowrap">{intlDateTime(f.locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(r.creato_il))}</td>
                <td className="py-2 pr-3">
                  <span className={`rounded-pill px-2 py-0.5 text-[11px] ${AZIONE[r.azione]?.cls ?? 'bg-kidville-line text-kidville-ink'}`}>{AZIONE[r.azione] ? t(AZIONE[r.azione].lKey) : r.azione}</span>
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
