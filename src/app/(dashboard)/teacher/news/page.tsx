'use client';

// ─── News del docente (Step 4) ────────────────────────────────────────────────
// Il docente vede i PROPRI contenuti e usa l'editor in modalità «docente»: nessuna
// pubblicazione diretta (Salva bozza / Invia proposta), nessun «Tutte le sedi».
// L'elenco espone Modifica/Elimina solo su bozza|proposta (i post inoltrati o
// pubblicati sono di competenza dello staff).

import { Suspense, useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Newspaper, Plus, Pencil, Trash2, ArrowLeft } from 'lucide-react';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { hdr } from '@/components/features/admin/settings/ui';
import { BTN_PRIMARY_AA, BTN_SECONDARY } from '@/components/features/admin/pagamenti/ui';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { logClient } from '@/lib/logging/client';
import { cx } from '@/lib/ui/cx';
import type { NewsPost, NewsStato } from '@/lib/news/tipi';

const caricamento = () => <p className="py-8 text-center font-maven text-sm text-kidville-sub">Caricamento…</p>;
const NewsEditorPanel = dynamic(() => import('@/components/features/admin/news/NewsEditorPanel').then((m) => m.NewsEditorPanel), { ssr: false, loading: caricamento });

const STATO_META: Record<NewsStato, { label: string; tone: BadgeTone }> = {
  bozza: { label: 'Bozza', tone: 'neutral' },
  proposta: { label: 'In revisione', tone: 'warn' },
  programmata: { label: 'Programmata', tone: 'info' },
  pubblicata: { label: 'Pubblicata', tone: 'success' },
  nascosta: { label: 'Ritirata', tone: 'error' },
};

const testoErrore = (e: unknown) => (e instanceof Error ? e.message : String(e));
const modificabile = (s: NewsStato) => s === 'bozza' || s === 'proposta';

function TeacherNewsContent() {
  const { userId: teacherId } = useSessionIdentity();
  const [scuolaId, setScuolaId] = useState<string | null>(null);
  const [posts, setPosts] = useState<NewsPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [disponibile, setDisponibile] = useState(true);
  const [vista, setVista] = useState<'lista' | 'editor'>('lista');
  const [postInModifica, setPostInModifica] = useState<NewsPost | null>(null);

  // Sede del docente (per l'editor): il server la ri-valida comunque.
  useEffect(() => {
    if (!teacherId) return;
    let attivo = true;
    fetch(`/api/me?userId=${teacherId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (attivo && d && typeof d.scuola_id === 'string') setScuolaId(d.scuola_id);
      })
      .catch(() => {});
    return () => {
      attivo = false;
    };
  }, [teacherId]);

  const carica = useCallback(async () => {
    if (!teacherId) return;
    try {
      const res = await fetch(`/api/news?userId=${teacherId}`, { headers: hdr(teacherId) }).catch(() => null);
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
  }, [teacherId]);

  useEffect(() => {
    void carica();
  }, [carica]);

  const elimina = async (id: string) => {
    if (!teacherId || !confirm('Eliminare questa bozza?')) return;
    try {
      const res = await fetch(`/api/news/${id}?userId=${teacherId}`, { method: 'DELETE', headers: hdr(teacherId) });
      if (res.ok) void carica();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `elimina news docente — ${testoErrore(err)}`, route: '/teacher/news', stato: 0 });
    }
  };

  const apriEditor = (post: NewsPost | null) => {
    setPostInModifica(post);
    setVista('editor');
  };
  const chiudiEditor = () => {
    setPostInModifica(null);
    setVista('lista');
    void carica();
  };

  return (
    <div className="px-4 pt-5 pb-24 md:px-6">
      <PageHeaderCard eyebrow="Comunicazione" title="News" subtitle="Proponi articoli e comunicati: lo staff li rivede e pubblica." className="mb-5" />

      {vista === 'editor' ? (
        <div>
          <button type="button" onClick={chiudiEditor} className="mb-4 inline-flex items-center gap-1.5 font-barlow text-[12.5px] font-extrabold uppercase tracking-wide text-kidville-green active:scale-95">
            <ArrowLeft size={16} strokeWidth={2.4} /> I miei contenuti
          </button>
          {teacherId && scuolaId ? (
            <NewsEditorPanel key={postInModifica?.id ?? 'nuovo'} userId={teacherId} scuolaId={scuolaId} modalita="docente" canAllSedi={false} postIniziale={postInModifica} onSalvato={chiudiEditor} onAnnulla={chiudiEditor} />
          ) : (
            <p className="py-8 text-center font-maven text-sm text-kidville-sub">Caricamento della tua sede…</p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <button type="button" onClick={() => apriEditor(null)} className={BTN_PRIMARY_AA}><Plus size={15} /> Nuovo contenuto</button>

          {loading ? (
            <div className="flex flex-col gap-2">{[0, 1].map((i) => <div key={i} className="h-16 animate-pulse rounded-card bg-kidville-cream-dark" />)}</div>
          ) : !disponibile ? (
            <p className="rounded-card bg-kidville-cream-dark px-4 py-8 text-center font-maven text-sm text-kidville-sub">Le News non sono ancora disponibili su questo ambiente.</p>
          ) : posts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Newspaper size={40} className="mb-3 text-kidville-green/40" strokeWidth={1.6} />
              <p className="font-maven text-sm text-kidville-sub">Non hai ancora creato contenuti.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {posts.map((p) => {
                const meta = STATO_META[p.stato] ?? STATO_META.bozza;
                return (
                  <div key={p.id} className="rounded-card border border-kidville-line bg-kidville-white p-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                        <h3 className="mt-1 truncate font-barlow text-[15px] font-extrabold uppercase leading-tight text-kidville-green">{p.titolo}</h3>
                      </div>
                    </div>
                    {modificabile(p.stato) && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-kidville-line pt-2.5">
                        <button type="button" onClick={() => apriEditor(p)} className={cx(BTN_SECONDARY, 'px-2.5 py-1.5 text-[12px]')}><Pencil size={13} /> Modifica</button>
                        <button type="button" onClick={() => void elimina(p.id)} className={cx(BTN_SECONDARY, 'px-2.5 py-1.5 text-[12px] text-kidville-error-strong')}><Trash2 size={13} /> Elimina</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function TeacherNewsPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-sub">Caricamento…</div>}>
      <TeacherNewsContent />
    </Suspense>
  );
}
