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
import { useTranslations } from 'next-intl';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { logClient } from '@/lib/logging/client';
import { cx } from '@/lib/ui/cx';
import type { NewsPost, NewsStato } from '@/lib/news/tipi';

// Fallback di caricamento del chunk editor: è un componente (non una funzione
// nuda) così può usare l'hook useTranslations sotto il provider next-intl.
function Caricamento() {
  const t = useTranslations('teacherComunicazioni');
  return <p className="py-8 text-center font-maven text-sm text-kidville-sub">{t('newsCaricamento')}</p>;
}
const NewsEditorPanel = dynamic(() => import('@/components/features/admin/news/NewsEditorPanel').then((m) => m.NewsEditorPanel), { ssr: false, loading: Caricamento });

// Tono del badge per stato (statico) e chiave i18n dell'etichetta (risolta a
// render con useTranslations, dove l'hook è disponibile).
const STATO_TONE: Record<NewsStato, BadgeTone> = {
  bozza: 'neutral',
  proposta: 'warn',
  programmata: 'info',
  pubblicata: 'success',
  nascosta: 'error',
};
const STATO_LABEL_KEY: Record<NewsStato, string> = {
  bozza: 'newsStatoBozza',
  proposta: 'newsStatoProposta',
  programmata: 'newsStatoProgrammata',
  pubblicata: 'newsStatoPubblicata',
  nascosta: 'newsStatoNascosta',
};

const testoErrore = (e: unknown) => (e instanceof Error ? e.message : String(e));
const modificabile = (s: NewsStato) => s === 'bozza' || s === 'proposta';

function TeacherNewsContent() {
  const t = useTranslations('teacherComunicazioni');
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
    if (!teacherId || !confirm(t('newsConfermaEliminaBozza'))) return;
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
      <PageHeaderCard eyebrow={t('newsEyebrow')} title={t('newsTitolo')} subtitle={t('newsSottotitolo')} className="mb-5" />

      {vista === 'editor' ? (
        <div>
          <button type="button" onClick={chiudiEditor} className="kv-news-onbody mb-4 inline-flex items-center gap-1.5 font-barlow text-[12.5px] font-extrabold uppercase tracking-wide text-kidville-green active:scale-95">
            <ArrowLeft size={16} strokeWidth={2.4} /> {t('newsIMieiContenuti')}
          </button>
          {teacherId && scuolaId ? (
            <NewsEditorPanel key={postInModifica?.id ?? 'nuovo'} userId={teacherId} scuolaId={scuolaId} modalita="docente" canAllSedi={false} postIniziale={postInModifica} onSalvato={chiudiEditor} onAnnulla={chiudiEditor} />
          ) : (
            <p role="status" className="kv-news-onbody py-8 text-center font-maven text-sm text-kidville-sub">{t('newsCaricamentoSede')}</p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <button type="button" onClick={() => apriEditor(null)} className={BTN_PRIMARY_AA}><Plus size={15} /> {t('newsNuovoContenuto')}</button>

          {loading ? (
            <div className="flex flex-col gap-2" role="status" aria-label={t('newsAriaCaricamentoContenuti')}>{[0, 1].map((i) => <div key={i} className="h-16 animate-pulse rounded-card bg-kidville-cream-dark" />)}</div>
          ) : !disponibile ? (
            <p className="rounded-card bg-kidville-cream-dark px-4 py-8 text-center font-maven text-sm text-kidville-sub">{t('newsNonDisponibili')}</p>
          ) : posts.length === 0 ? (
            <div role="status" className="kv-news-onbody flex flex-col items-center justify-center py-12 text-center">
              <Newspaper size={40} className="mb-3 text-kidville-green/40" strokeWidth={1.6} />
              <p className="font-maven text-sm text-kidville-sub">{t('newsNessunContenuto')}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {posts.map((p) => {
                const tone = STATO_TONE[p.stato] ?? STATO_TONE.bozza;
                const labelKey = STATO_LABEL_KEY[p.stato] ?? STATO_LABEL_KEY.bozza;
                return (
                  <div key={p.id} className="rounded-card border border-kidville-line bg-kidville-white p-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <Badge tone={tone}>{t(labelKey)}</Badge>
                        <h3 className="mt-1 truncate font-barlow text-[15px] font-extrabold uppercase leading-tight text-kidville-green">{p.titolo}</h3>
                      </div>
                    </div>
                    {modificabile(p.stato) && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-kidville-line pt-2.5">
                        <button type="button" onClick={() => apriEditor(p)} className={cx(BTN_SECONDARY, 'px-2.5 py-1.5 text-[12px]')}><Pencil size={13} /> {t('newsModifica')}</button>
                        <button type="button" onClick={() => void elimina(p.id)} className={cx(BTN_SECONDARY, 'px-2.5 py-1.5 text-[12px] text-kidville-error-strong')}><Trash2 size={13} /> {t('newsElimina')}</button>
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
  const t = useTranslations('teacherComunicazioni');
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-sub">{t('newsCaricamento')}</div>}>
      <TeacherNewsContent />
    </Suspense>
  );
}
