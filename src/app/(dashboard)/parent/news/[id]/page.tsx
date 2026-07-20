'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { useParentIdentity } from '@/lib/auth/use-parent-identity'
import { withIdentity } from '@/lib/auth/current-user'
import { NewsDetailContent } from '@/components/features/news/NewsDetailContent'
import type { NewsMedia, NewsPost } from '@/lib/news/tipi'

function ParentNewsDetail() {
  const { parentId, studentId, ready } = useParentIdentity()
  const params = useParams<{ id: string }>()
  const id = params?.id

  const [post, setPost] = useState<NewsPost | null>(null)
  const [media, setMedia] = useState<NewsMedia[]>([])
  const [loading, setLoading] = useState(true)
  const [problema, setProblema] = useState<'errore' | 'vuoto' | null>(null)

  // try/finally (mai try/catch) e nessun setState prima del primo await: è il
  // pattern che la regola react-hooks set-state-in-effect accetta (vedi NewsFeedList).
  const carica = useCallback(async () => {
    if (!id) return
    try {
      const res = await fetch(`/api/news/feed/${id}`, parentId ? { headers: { 'x-user-id': parentId } } : undefined).catch(() => null)
      if (!res) { setProblema('errore'); return }
      if (res.status === 404) { setProblema('vuoto'); return }
      if (!res.ok) { setProblema('errore'); return }
      const j = (await res.json().catch(() => null)) as { disponibile?: boolean; post?: NewsPost; media?: NewsMedia[] } | null
      if (!j || j.disponibile === false || !j.post) { setProblema('vuoto'); return }
      setPost(j.post)
      setMedia(j.media ?? [])
      setProblema(null)
    } finally {
      setLoading(false)
    }
  }, [id, parentId])

  useEffect(() => {
    if (ready) void carica()
  }, [ready, carica])

  return (
    <div className="px-4 pt-5 pb-28">
      <Link
        href={withIdentity('/parent/news', parentId, studentId)}
        className="mb-4 inline-flex items-center gap-1.5 font-barlow text-[12.5px] font-extrabold uppercase tracking-wide text-kidville-green active:scale-95"
      >
        <ArrowLeft size={16} strokeWidth={2.4} />
        Tutte le news
      </Link>

      {loading || !ready ? (
        <div className="flex flex-col gap-3">
          <div className="h-48 animate-pulse rounded-card bg-kidville-white" />
          <div className="h-6 w-2/3 animate-pulse rounded-pill bg-kidville-white" />
          <div className="h-24 animate-pulse rounded-card bg-kidville-white" />
        </div>
      ) : post && !problema ? (
        <NewsDetailContent post={post} media={media} />
      ) : problema === 'errore' ? (
        <div className="flex flex-col items-center justify-center rounded-card bg-kidville-white py-12 text-center">
          <p className="font-maven text-sm text-kidville-sub">Non è stato possibile caricare la news.</p>
          <button
            type="button"
            onClick={() => {
              setLoading(true)
              setProblema(null)
              void carica()
            }}
            className="mt-3 inline-flex items-center gap-2 rounded-pill bg-kidville-green px-4 py-2 font-barlow text-sm font-extrabold uppercase tracking-wide text-white active:scale-95"
          >
            <RotateCcw size={15} strokeWidth={2.4} />
            Riprova
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-kidville-cream text-4xl">📰</div>
          <h2 className="mb-1 font-barlow text-xl font-bold uppercase text-kidville-green">News non disponibile</h2>
          <p className="max-w-xs font-maven text-sm text-kidville-sub">Potrebbe essere stata rimossa o non essere destinata al tuo profilo.</p>
        </div>
      )}
    </div>
  )
}

export default function ParentNewsDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-kidville-green/30 border-t-kidville-green" />
        </div>
      }
    >
      <ParentNewsDetail />
    </Suspense>
  )
}
