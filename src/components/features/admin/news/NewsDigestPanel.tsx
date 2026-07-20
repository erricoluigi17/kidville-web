'use client';

// ─── Digest mensile: archivio + generazione manuale (Step 4) ──────────────────
// Elenca le edizioni della sede (anche non ancora inviate) e permette di
// generare/inviare il digest di un mese scelto. Idempotente lato server
// (ON CONFLICT + guardia inviata_il): un mese già inviato non si re-invia.

import { useCallback, useEffect, useState } from 'react';
import { Mail, Send, CheckCircle2 } from 'lucide-react';
import { hdr } from '@/components/features/admin/settings/ui';
import { SELECT, BTN_PRIMARY_AA } from '@/components/features/admin/pagamenti/ui';
import { Badge } from '@/components/ui/Badge';
import { logClient } from '@/lib/logging/client';
import { cx } from '@/lib/ui/cx';
import { MESI_IT, type NewsDigestEdizione } from '@/lib/news/tipi';

const testoErrore = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface EsitoEdizione {
  scuola_id: string;
  generata: boolean;
  inviata: boolean;
  destinatari_count: number;
  errori_count: number;
}

interface Props {
  userId: string;
  scuolaId: string;
}

export function NewsDigestPanel({ userId, scuolaId }: Props) {
  const now = new Date();
  const [edizioni, setEdizioni] = useState<NewsDigestEdizione[]>([]);
  const [loading, setLoading] = useState(true);
  const [disponibile, setDisponibile] = useState(true);
  const [anno, setAnno] = useState(now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear());
  const [mese, setMese] = useState(now.getUTCMonth() === 0 ? 12 : now.getUTCMonth());
  const [generando, setGenerando] = useState(false);
  const [esito, setEsito] = useState<string | null>(null);

  const carica = useCallback(async () => {
    try {
      const res = await fetch(`/api/news/digest?userId=${userId}`, { headers: hdr(userId) }).catch(() => null);
      if (!res || !res.ok) {
        setDisponibile(res?.status !== 404);
        setEdizioni([]);
      } else {
        const j = (await res.json().catch(() => null)) as { disponibile?: boolean; edizioni?: NewsDigestEdizione[] } | null;
        setDisponibile(j?.disponibile !== false);
        setEdizioni(j?.edizioni ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void carica();
  }, [carica]);

  const genera = async () => {
    setEsito(null);
    setGenerando(true);
    try {
      const res = await fetch(`/api/news/digest/genera?userId=${userId}`, { method: 'POST', headers: hdr(userId), body: JSON.stringify({ anno, mese, scuola_id: scuolaId }) });
      const j = (await res.json().catch(() => null)) as { error?: string; edizioni?: EsitoEdizione[] } | null;
      if (!res.ok) {
        setEsito(j?.error ?? 'Generazione non riuscita.');
        return;
      }
      const e = j?.edizioni?.[0];
      if (!e || !e.generata) setEsito('Nessun post pubblicato in quel mese: nessun digest generato.');
      else if (e.inviata) setEsito(`Digest inviato a ${e.destinatari_count} famiglie${e.errori_count ? ` (${e.errori_count} errori)` : ''}.`);
      else setEsito('Digest già presente per quel mese.');
      void carica();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `genera digest — ${testoErrore(err)}`, route: '/admin/news', stato: 0 });
      setEsito('Errore di rete.');
    } finally {
      setGenerando(false);
    }
  };

  const anni = [now.getUTCFullYear(), now.getUTCFullYear() - 1];

  return (
    <div className="space-y-5">
      {/* Generazione manuale */}
      <div className="rounded-card border border-kidville-line bg-kidville-cream-dark p-4">
        <p className="mb-2 font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-green">Genera / invia un digest</p>
        <p className="mb-3 font-maven text-xs text-kidville-sub">Il digest è una comunicazione istituzionale: viene inviato via email a tutte le famiglie della sede, indipendentemente dalle loro preferenze di notifica.</p>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="digest-mese" className="mb-1 block font-maven text-[11px] font-bold uppercase tracking-wide text-kidville-sub">Mese</label>
            <select id="digest-mese" value={mese} onChange={(e) => setMese(Number(e.target.value))} className={cx(SELECT, 'w-auto')}>
              {MESI_IT.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="digest-anno" className="mb-1 block font-maven text-[11px] font-bold uppercase tracking-wide text-kidville-sub">Anno</label>
            <select id="digest-anno" value={anno} onChange={(e) => setAnno(Number(e.target.value))} className={cx(SELECT, 'w-auto')}>
              {anni.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <button type="button" onClick={() => void genera()} disabled={generando} className={BTN_PRIMARY_AA}><Send size={15} /> {generando ? 'Invio…' : 'Genera e invia'}</button>
        </div>
        {esito && <p role="status" className="mt-3 inline-flex items-center gap-1.5 font-maven text-sm font-bold text-kidville-success-strong"><CheckCircle2 size={16} /> {esito}</p>}
      </div>

      {/* Archivio edizioni */}
      <div>
        <p className="mb-2 font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-green">Edizioni</p>
        {loading ? (
          <div className="flex flex-col gap-2">{[0, 1].map((i) => <div key={i} className="h-14 animate-pulse rounded-card bg-kidville-cream-dark" />)}</div>
        ) : !disponibile ? (
          <p className="rounded-card bg-kidville-cream-dark px-4 py-8 text-center font-maven text-sm text-kidville-muted">Le News non sono ancora disponibili su questo ambiente.</p>
        ) : edizioni.length === 0 ? (
          <p className="rounded-card bg-kidville-cream-dark px-4 py-8 text-center font-maven text-sm text-kidville-muted">Nessuna edizione ancora generata.</p>
        ) : (
          <ul className="divide-y divide-kidville-line rounded-card border border-kidville-line bg-kidville-white">
            {edizioni.map((ed) => (
              <li key={ed.id} className="flex items-center gap-3 px-3.5 py-3">
                <Mail size={17} className="flex-shrink-0 text-kidville-green" strokeWidth={2} />
                <span className="min-w-0 flex-1">
                  <span className="block font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-green">{MESI_IT[(ed.mese ?? 1) - 1] ?? ''} {ed.anno}</span>
                  <span className="block font-maven text-[11.5px] text-kidville-muted">{ed.inviata_il ? `Inviato a ${ed.destinatari_count} famiglie` : 'Generato, non ancora inviato'}</span>
                </span>
                <Badge tone={ed.inviata_il ? 'success' : 'neutral'}>{ed.inviata_il ? 'Inviato' : 'Bozza'}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
