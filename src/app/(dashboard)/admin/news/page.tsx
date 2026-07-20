'use client';

// ─── Cockpit «News» (Step 4) ──────────────────────────────────────────────────
// Pattern /admin/pagamenti: PageHeader + NewsNav (5 viste) + SedeRequired. I
// pannelli si caricano on-demand; l'editor e i pannelli che montano TipTap sono
// `ssr:false` (il rich-text non è SSR-safe).

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Newspaper, Megaphone } from 'lucide-react';
import { NewsNav, VISTE_NEWS, type VistaNews } from '@/components/features/admin/news/NewsNav';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';
import { Card } from '@/components/ui/Card';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { SedeRequired } from '@/lib/context/sede-context';
import type { NewsPost } from '@/lib/news/tipi';

const caricamento = () => <p className="py-8 text-center font-maven text-sm text-kidville-muted">Caricamento…</p>;
const NewsElencoPanel = dynamic(() => import('@/components/features/admin/news/NewsElencoPanel').then((m) => m.NewsElencoPanel), { loading: caricamento });
const NewsPropostePanel = dynamic(() => import('@/components/features/admin/news/NewsPropostePanel').then((m) => m.NewsPropostePanel), { loading: caricamento });
const NewsCategoriePanel = dynamic(() => import('@/components/features/admin/news/NewsCategoriePanel').then((m) => m.NewsCategoriePanel), { loading: caricamento });
const NewsDigestPanel = dynamic(() => import('@/components/features/admin/news/NewsDigestPanel').then((m) => m.NewsDigestPanel), { loading: caricamento });
// TipTap non è SSR-safe → ssr:false.
const NewsEditorPanel = dynamic(() => import('@/components/features/admin/news/NewsEditorPanel').then((m) => m.NewsEditorPanel), { ssr: false, loading: caricamento });

const isVista = (v: string | null): v is VistaNews => !!v && VISTE_NEWS.some((o) => o.id === v);

const linkCls = 'inline-flex h-[40px] items-center gap-1.5 rounded-pill border border-kidville-line bg-kidville-white px-4 font-barlow text-[13px] font-extrabold uppercase tracking-[0.03em] text-kidville-green transition-colors hover:border-kidville-green';

function NewsInner() {
  const { userId, role } = useSessionIdentity();
  const router = useRouter();
  const params = useSearchParams();
  const fromUrl = params.get('vista');
  const [vista, setVista] = useState<VistaNews>(isVista(fromUrl) ? fromUrl : 'elenco');
  const [postInModifica, setPostInModifica] = useState<NewsPost | null>(null);
  const isAdmin = role === 'admin';

  const withUser = (href: string) => (userId ? `${href}?userId=${userId}` : href);
  const cambiaVista = (id: VistaNews) => {
    setVista(id);
    if (id !== 'editor') setPostInModifica(null);
    router.replace(userId ? `?userId=${userId}&vista=${id}` : `?vista=${id}`, { scroll: false });
  };
  const modifica = (post: NewsPost) => {
    setPostInModifica(post);
    setVista('editor');
    router.replace(userId ? `?userId=${userId}&vista=editor` : `?vista=editor`, { scroll: false });
  };

  return (
    <CockpitPage max={1152}>
      <PageHeader
        icon={Newspaper}
        eyebrow="Comunicazione"
        title="News"
        subtitle="Blog, comunicati, post Instagram e digest mensile alle famiglie."
        actions={<Link href={withUser('/admin/avvisi')} className={linkCls}><Megaphone size={15} /> Avvisi</Link>}
      />

      <NewsNav value={vista} onChange={cambiaVista} />

      <SedeRequired cosa="le news">
        {(scuolaId) => (
          <Card className="p-4 md:p-6">
            {vista === 'elenco' && userId && <NewsElencoPanel userId={userId} scuolaId={scuolaId} onModifica={modifica} />}
            {vista === 'editor' && userId && (
              <NewsEditorPanel
                key={postInModifica?.id ?? 'nuovo'}
                userId={userId}
                scuolaId={scuolaId}
                modalita="admin"
                canAllSedi={isAdmin}
                postIniziale={postInModifica}
                onSalvato={() => cambiaVista('elenco')}
                onAnnulla={() => cambiaVista('elenco')}
              />
            )}
            {vista === 'proposte' && userId && <NewsPropostePanel userId={userId} scuolaId={scuolaId} />}
            {vista === 'categorie' && userId && <NewsCategoriePanel userId={userId} scuolaId={scuolaId} />}
            {vista === 'digest' && userId && <NewsDigestPanel userId={userId} scuolaId={scuolaId} />}
          </Card>
        )}
      </SedeRequired>
    </CockpitPage>
  );
}

export default function AdminNewsPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <NewsInner />
    </Suspense>
  );
}
