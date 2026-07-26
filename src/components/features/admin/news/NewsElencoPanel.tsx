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
import { logClient, nomeErrore } from '@/lib/logging/client';
import { cx } from '@/lib/ui/cx';
import { useTranslations, useLocale } from 'next-intl';
import { NEWS_STATI, NEWS_TIPI, type NewsPost, type NewsStato, type NewsTipo } from '@/lib/news/tipi';

// Tono del badge per stato (colore) separato dall'etichetta, che è i18n e viene
// risolta nel componente tramite STATO_LABEL_KEY.
const STATO_TONE: Record<NewsStato, BadgeTone> = {
  bozza: 'neutral',
  proposta: 'warn',
  programmata: 'info',
  pubblicata: 'success',
  nascosta: 'error',
};
const STATO_LABEL_KEY: Record<NewsStato, string> = {
  bozza: 'statoBozza',
  proposta: 'statoProposta',
  programmata: 'statoProgrammata',
  pubblicata: 'statoPubblicata',
  nascosta: 'statoNascosta',
};

const TIPO_LABEL_KEY: Record<NewsTipo, string> = { articolo: 'elencoTipoArticolo', breve: 'elencoTipoBreve', instagram: 'elencoTipoInstagram' };

const fmtData = (iso: string | null, locale: string): string => {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Europe/Rome' }).format(new Date(iso));
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
  const t = useTranslations('adminComunicazioni');
  const locale = useLocale();
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
      logClient({ livello: 'error', evento: 'fetch', messaggio: `news-azione-${azione}-fallita: ${nomeErrore(err)}`, route: '/admin/news', stato: 0 });
    }
  };

  const elimina = async (id: string) => {
    if (!confirm(t('elencoConfermaElimina'))) return;
    try {
      const res = await fetch(`/api/news/${id}?userId=${userId}`, { method: 'DELETE', headers: hdr(userId) });
      if (res.ok) void carica();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `news-eliminazione-fallita: ${nomeErrore(err)}`, route: '/admin/news', stato: 0 });
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
      logClient({ livello: 'error', evento: 'fetch', messaggio: `news-statistiche-caricamento-fallito: ${nomeErrore(err)}`, route: '/admin/news', stato: 0 });
    }
  };

  return (
    <div className="space-y-4">
      {/* Filtri */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={filtroStato} onChange={(e) => setFiltroStato(e.target.value as NewsStato | '')} className={cx(SELECT, 'w-auto')} aria-label={t('elencoFiltraStato')}>
          <option value="">{t('elencoTuttiStati')}</option>
          {NEWS_STATI.map((s) => <option key={s} value={s}>{t(STATO_LABEL_KEY[s])}</option>)}
        </select>
        <select value={filtroTipo} onChange={(e) => setFiltroTipo(e.target.value as NewsTipo | '')} className={cx(SELECT, 'w-auto')} aria-label={t('elencoFiltraTipo')}>
          <option value="">{t('elencoTuttiTipi')}</option>
          {NEWS_TIPI.map((tp) => <option key={tp} value={tp}>{t(TIPO_LABEL_KEY[tp])}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => <div key={i} className="h-[72px] animate-pulse rounded-card bg-kidville-cream-dark" />)}
        </div>
      ) : !disponibile ? (
        <p className="rounded-card bg-kidville-cream-dark px-4 py-8 text-center font-maven text-sm text-kidville-sub">
          {t('newsNonDisponibili')}
        </p>
      ) : posts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Newspaper size={40} className="mb-3 text-kidville-green/40" strokeWidth={1.6} />
          <p className="font-maven text-sm text-kidville-sub">{t('elencoVuoto')}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {posts.map((p) => {
            const tone = STATO_TONE[p.stato] ?? 'neutral';
            const st = stats[p.id];
            return (
              <div key={p.id} className="rounded-card border border-kidville-line bg-kidville-white p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={tone}>{t(STATO_LABEL_KEY[p.stato] ?? 'statoBozza')}</Badge>
                      <span className="font-barlow text-[11px] font-bold uppercase tracking-wide text-kidville-sub">{t(TIPO_LABEL_KEY[p.tipo])}</span>
                      {p.pinned && <Pin size={13} className="text-kidville-yellow-dark" strokeWidth={2.4} />}
                    </div>
                    <h3 className="mt-1 truncate font-barlow text-[15px] font-extrabold uppercase leading-tight text-kidville-green">{p.titolo}</h3>
                    <p className="mt-0.5 font-maven text-[11.5px] text-kidville-sub">
                      {p.stato === 'pubblicata' && p.pubblicata_il ? t('elencoPubblicataIl', { data: fmtData(p.pubblicata_il, locale) }) : p.stato === 'programmata' && p.programmata_il ? t('elencoProgrammataPerIl', { data: fmtData(p.programmata_il, locale) }) : t('elencoCreataIl', { data: fmtData(p.created_at ?? null, locale) })}
                    </p>
                    {st && (
                      <p className="mt-1 inline-flex items-center gap-1 font-maven text-[11.5px] font-bold text-kidville-green">
                        <BarChart3 size={12} /> {t('elencoStatConteggio', { letture: st.visualizzazioni, famiglie: st.famiglie_target })}
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-kidville-line pt-2.5">
                  <button type="button" onClick={() => onModifica(p)} className={cx(BTN_SECONDARY, 'px-2.5 py-1.5 text-[12px]')}><Pencil size={13} /> {t('elencoModifica')}</button>
                  <button type="button" onClick={() => void azione(p.id, 'pin')} className={cx(BTN_SECONDARY, 'px-2.5 py-1.5 text-[12px]')}>
                    {p.pinned ? <><PinOff size={13} /> {t('elencoRimuoviEvidenza')}</> : <><Pin size={13} /> {t('elencoMettiEvidenza')}</>}
                  </button>
                  {p.stato === 'nascosta' ? (
                    <button type="button" onClick={() => void azione(p.id, 'ripubblica')} className={cx(BTN_SECONDARY, 'px-2.5 py-1.5 text-[12px]')}><RotateCcw size={13} /> {t('elencoRipubblica')}</button>
                  ) : p.stato === 'pubblicata' ? (
                    <button type="button" onClick={() => void azione(p.id, 'ritira')} className={cx(BTN_SECONDARY, 'px-2.5 py-1.5 text-[12px]')}><EyeOff size={13} /> {t('elencoRitira')}</button>
                  ) : null}
                  {p.stato === 'pubblicata' && <button type="button" onClick={() => void caricaStat(p.id)} className={cx(BTN_SECONDARY, 'px-2.5 py-1.5 text-[12px]')}><BarChart3 size={13} /> {t('elencoStatistiche')}</button>}
                  <button type="button" onClick={() => void elimina(p.id)} className={cx(BTN_SECONDARY, 'px-2.5 py-1.5 text-[12px] text-kidville-error-strong')}><Trash2 size={13} /> {t('elencoElimina')}</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
