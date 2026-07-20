'use client';

// ─── Elenco gestionale dei post News (Step 4) ─────────────────────────────────
// Filtri per stato/tipo, badge di stato (token Clay Village), azioni
// pin/ritira/ripubblica/modifica/elimina e conteggio visualizzazioni on-demand.
// Tollerante all'ambiente non migrato ({disponibile:false}/404 → stato vuoto).

import { useCallback, useEffect, useState } from 'react';
import { Pin, PinOff, Pencil, Trash2, EyeOff, RotateCcw, BarChart3, Newspaper } from 'lucide-react';
import { hdr } from '@/components/features/admin/settings/ui';
import { SELECT, BTN_SECONDARY } from '@/components/features/admin/pagamenti/ui';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { logClient } from '@/lib/logging/client';
import { cx } from '@/lib/ui/cx';
import { NEWS_STATI, NEWS_TIPI, type NewsPost, type NewsStato, type NewsTipo } from '@/lib/news/tipi';

const STATO_META: Record<NewsStato, { label: string; tone: BadgeTone }> = {
  bozza: { label: 'Bozza', tone: 'neutral' },
  proposta: { label: 'Proposta', tone: 'warn' },
  programmata: { label: 'Programmata', tone: 'info' },
  pubblicata: { label: 'Pubblicata', tone: 'success' },
  nascosta: { label: 'Ritirata', tone: 'error' },
};

const TIPO_LABEL: Record<NewsTipo, string> = { articolo: 'Articolo', breve: 'Comunicato', instagram: 'Instagram' };

const testoErrore = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fmtData = (iso: string | null): string => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
};

interface Props {
  userId: string;
  scuolaId: string;
  onModifica: (post: NewsPost) => void;
}

export function NewsElencoPanel({ userId, onModifica }: Props) {
  const [posts, setPosts] = useState<NewsPost[]>([]);
  const [filtroStato, setFiltroStato] = useState<NewsStato | ''>('');
  const [filtroTipo, setFiltroTipo] = useState<NewsTipo | ''>('');
  const [loading, setLoading] = useState(true);
  const [disponibile, setDisponibile] = useState(true);
  const [stats, setStats] = useState<Record<string, { visualizzazioni: number; famiglie_target: number }>>({});

  const carica = useCallback(async () => {
    try {
      const params = new URLSearchParams({ userId });
      if (filtroStato) params.set('stato', filtroStato);
      if (filtroTipo) params.set('tipo', filtroTipo);
      const res = await fetch(`/api/news?${params.toString()}`, { headers: hdr(userId) }).catch(() => null);
      if (!res || !res.ok) {
        setDisponibile(res?.status !== 404);
        setPosts([]);
      } else {
        const j = (await res.json().catch(() => null)) as { disponibile?: boolean; posts?: NewsPost[] } | null;
        setDisponibile(j?.disponibile !== false);
        setPosts(j?.posts ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [userId, filtroStato, filtroTipo]);

  useEffect(() => {
    void carica();
  }, [carica]);

  const azione = async (id: string, azione: 'pin' | 'ritira' | 'ripubblica') => {
    try {
      const res = await fetch(`/api/news/${id}/pubblica?userId=${userId}`, { method: 'POST', headers: hdr(userId), body: JSON.stringify({ azione }) });
      if (res.ok) void carica();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `azione news ${azione} — ${testoErrore(err)}`, route: '/admin/news', stato: 0 });
    }
  };

  const elimina = async (id: string) => {
    if (!confirm('Eliminare definitivamente questa news?')) return;
    try {
      const res = await fetch(`/api/news/${id}?userId=${userId}`, { method: 'DELETE', headers: hdr(userId) });
      if (res.ok) void carica();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `elimina news — ${testoErrore(err)}`, route: '/admin/news', stato: 0 });
    }
  };

  const caricaStat = async (id: string) => {
    try {
      const res = await fetch(`/api/news/${id}/statistiche?userId=${userId}`, { headers: hdr(userId) });
      if (res.ok) {
        const j = (await res.json().catch(() => null)) as { visualizzazioni?: number; famiglie_target?: number } | null;
        if (j) setStats((s) => ({ ...s, [id]: { visualizzazioni: j.visualizzazioni ?? 0, famiglie_target: j.famiglie_target ?? 0 } }));
      }
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `stat news — ${testoErrore(err)}`, route: '/admin/news', stato: 0 });
    }
  };

  return (
    <div className="space-y-4">
      {/* Filtri */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={filtroStato} onChange={(e) => setFiltroStato(e.target.value as NewsStato | '')} className={cx(SELECT, 'w-auto')} aria-label="Filtra per stato">
          <option value="">Tutti gli stati</option>
          {NEWS_STATI.map((s) => <option key={s} value={s}>{STATO_META[s].label}</option>)}
        </select>
        <select value={filtroTipo} onChange={(e) => setFiltroTipo(e.target.value as NewsTipo | '')} className={cx(SELECT, 'w-auto')} aria-label="Filtra per tipo">
          <option value="">Tutti i tipi</option>
          {NEWS_TIPI.map((t) => <option key={t} value={t}>{TIPO_LABEL[t]}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => <div key={i} className="h-[72px] animate-pulse rounded-card bg-kidville-cream-dark" />)}
        </div>
      ) : !disponibile ? (
        <p className="rounded-card bg-kidville-cream-dark px-4 py-8 text-center font-maven text-sm text-kidville-muted">
          Le News non sono ancora disponibili su questo ambiente.
        </p>
      ) : posts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Newspaper size={40} className="mb-3 text-kidville-green/40" strokeWidth={1.6} />
          <p className="font-maven text-sm text-kidville-muted">Nessuna news con questi filtri.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {posts.map((p) => {
            const meta = STATO_META[p.stato] ?? STATO_META.bozza;
            const st = stats[p.id];
            return (
              <div key={p.id} className="rounded-card border border-kidville-line bg-kidville-white p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      <span className="font-barlow text-[11px] font-bold uppercase tracking-wide text-kidville-sub">{TIPO_LABEL[p.tipo]}</span>
                      {p.pinned && <Pin size={13} className="text-kidville-yellow-dark" strokeWidth={2.4} />}
                    </div>
                    <h3 className="mt-1 truncate font-barlow text-[15px] font-extrabold uppercase leading-tight text-kidville-green">{p.titolo}</h3>
                    <p className="mt-0.5 font-maven text-[11.5px] text-kidville-muted">
                      {p.stato === 'pubblicata' && p.pubblicata_il ? `Pubblicata il ${fmtData(p.pubblicata_il)}` : p.stato === 'programmata' && p.programmata_il ? `Programmata per il ${fmtData(p.programmata_il)}` : `Creata il ${fmtData(p.created_at ?? null)}`}
                    </p>
                    {st && (
                      <p className="mt-1 inline-flex items-center gap-1 font-maven text-[11.5px] font-bold text-kidville-green">
                        <BarChart3 size={12} /> {st.visualizzazioni} letture su {st.famiglie_target} famiglie
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-kidville-line pt-2.5">
                  <button type="button" onClick={() => onModifica(p)} className={cx(BTN_SECONDARY, 'px-2.5 py-1.5 text-[12px]')}><Pencil size={13} /> Modifica</button>
                  <button type="button" onClick={() => void azione(p.id, 'pin')} className={cx(BTN_SECONDARY, 'px-2.5 py-1.5 text-[12px]')}>
                    {p.pinned ? <><PinOff size={13} /> Rimuovi evidenza</> : <><Pin size={13} /> Metti in evidenza</>}
                  </button>
                  {p.stato === 'nascosta' ? (
                    <button type="button" onClick={() => void azione(p.id, 'ripubblica')} className={cx(BTN_SECONDARY, 'px-2.5 py-1.5 text-[12px]')}><RotateCcw size={13} /> Ripubblica</button>
                  ) : p.stato === 'pubblicata' ? (
                    <button type="button" onClick={() => void azione(p.id, 'ritira')} className={cx(BTN_SECONDARY, 'px-2.5 py-1.5 text-[12px]')}><EyeOff size={13} /> Ritira</button>
                  ) : null}
                  {p.stato === 'pubblicata' && <button type="button" onClick={() => void caricaStat(p.id)} className={cx(BTN_SECONDARY, 'px-2.5 py-1.5 text-[12px]')}><BarChart3 size={13} /> Statistiche</button>}
                  <button type="button" onClick={() => void elimina(p.id)} className={cx(BTN_SECONDARY, 'px-2.5 py-1.5 text-[12px] text-kidville-error-strong')}><Trash2 size={13} /> Elimina</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
