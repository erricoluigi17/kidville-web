'use client';

// ─── Proposte dei docenti in attesa di approvazione (Step 4) ──────────────────
// Elenca i post in stato «proposta», con anteprima e azioni Approva (subito o
// programmata) / Rifiuta con motivo. Delega a POST /api/news/[id]/approva.

import { useCallback, useEffect, useState } from 'react';
import { Inbox, Check, X, CalendarClock } from 'lucide-react';
import { hdr } from '@/components/features/admin/settings/ui';
import { INPUT, BTN_PRIMARY_AA, BTN_SECONDARY } from '@/components/features/admin/pagamenti/ui';
import { logClient } from '@/lib/logging/client';
import { cx } from '@/lib/ui/cx';
import type { NewsPost } from '@/lib/news/tipi';

const testoErrore = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Props {
  userId: string;
  scuolaId: string;
}

export function NewsPropostePanel({ userId }: Props) {
  const [proposte, setProposte] = useState<NewsPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [disponibile, setDisponibile] = useState(true);
  const [rifiutaId, setRifiutaId] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');
  const [programmaId, setProgrammaId] = useState<string | null>(null);
  const [quando, setQuando] = useState('');

  const carica = useCallback(async () => {
    try {
      const res = await fetch(`/api/news?userId=${userId}&stato=proposta`, { headers: hdr(userId) }).catch(() => null);
      if (!res || !res.ok) {
        setDisponibile(res?.status !== 404);
        setProposte([]);
      } else {
        const j = (await res.json().catch(() => null)) as { disponibile?: boolean; posts?: NewsPost[] } | null;
        setDisponibile(j?.disponibile !== false);
        setProposte(j?.posts ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void carica();
  }, [carica]);

  const invia = async (id: string, body: Record<string, unknown>) => {
    try {
      const res = await fetch(`/api/news/${id}/approva?userId=${userId}`, { method: 'POST', headers: hdr(userId), body: JSON.stringify(body) });
      if (res.ok) {
        setRifiutaId(null);
        setMotivo('');
        setProgrammaId(null);
        setQuando('');
        void carica();
      }
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `approva news — ${testoErrore(err)}`, route: '/admin/news', stato: 0 });
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1].map((i) => <div key={i} className="h-24 animate-pulse rounded-card bg-kidville-cream-dark" />)}
      </div>
    );
  }
  if (!disponibile) {
    return <p className="rounded-card bg-kidville-cream-dark px-4 py-8 text-center font-maven text-sm text-kidville-sub">Le News non sono ancora disponibili su questo ambiente.</p>;
  }
  if (proposte.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Inbox size={40} className="mb-3 text-kidville-green/40" strokeWidth={1.6} />
        <p className="font-maven text-sm text-kidville-sub">Nessuna proposta in attesa.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {proposte.map((p) => (
        <div key={p.id} className="rounded-card border border-kidville-line bg-kidville-white p-4">
          <h3 className="font-barlow text-[15px] font-extrabold uppercase leading-tight text-kidville-green">{p.titolo}</h3>
          {p.contenuto_testo && <p className="mt-1 line-clamp-3 font-maven text-[13px] text-kidville-sub">{p.contenuto_testo}</p>}

          {rifiutaId === p.id ? (
            <div className="mt-3 space-y-2">
              <label htmlFor={`motivo-${p.id}`} className="block font-maven text-xs font-bold uppercase tracking-wide text-kidville-sub">Motivo del rifiuto</label>
              <textarea id={`motivo-${p.id}`} value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2} className={cx(INPUT, 'resize-y')} placeholder="Es. Rivedere il testo…" />
              <div className="flex gap-2">
                <button type="button" onClick={() => void invia(p.id, { esito: 'rifiuta', motivo: motivo.trim() || undefined })} className={cx(BTN_SECONDARY, 'text-kidville-error-strong')}><X size={14} /> Conferma rifiuto</button>
                <button type="button" onClick={() => { setRifiutaId(null); setMotivo(''); }} className={BTN_SECONDARY}>Annulla</button>
              </div>
            </div>
          ) : programmaId === p.id ? (
            <div className="mt-3 space-y-2">
              <label htmlFor={`quando-${p.id}`} className="block font-maven text-xs font-bold uppercase tracking-wide text-kidville-sub">Programma per</label>
              <input id={`quando-${p.id}`} type="datetime-local" value={quando} onChange={(e) => setQuando(e.target.value)} className={cx(INPUT, 'max-w-xs')} />
              <div className="flex gap-2">
                <button type="button" disabled={!quando} onClick={() => void invia(p.id, { esito: 'approva', programmata_il: new Date(quando).toISOString() })} className={BTN_PRIMARY_AA}><CalendarClock size={14} /> Approva e programma</button>
                <button type="button" onClick={() => { setProgrammaId(null); setQuando(''); }} className={BTN_SECONDARY}>Annulla</button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2 border-t border-kidville-line pt-3">
              <button type="button" onClick={() => void invia(p.id, { esito: 'approva', pubblica_subito: true })} className={BTN_PRIMARY_AA}><Check size={14} /> Approva e pubblica</button>
              <button type="button" onClick={() => setProgrammaId(p.id)} className={BTN_SECONDARY}><CalendarClock size={14} /> Approva e programma</button>
              <button type="button" onClick={() => setRifiutaId(p.id)} className={cx(BTN_SECONDARY, 'text-kidville-error-strong')}><X size={14} /> Rifiuta</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
