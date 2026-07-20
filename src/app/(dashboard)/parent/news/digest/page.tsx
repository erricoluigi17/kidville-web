'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Mail, ChevronRight } from 'lucide-react'
import { PageHeaderCard } from '@/components/ui/PageHeaderCard'
import { useParentIdentity } from '@/lib/auth/use-parent-identity'
import { withIdentity } from '@/lib/auth/current-user'
import { MESI_IT, type NewsDigestEdizione } from '@/lib/news/tipi'

function estraiEdizioni(data: unknown): NewsDigestEdizione[] {
  if (Array.isArray(data)) return data as NewsDigestEdizione[]
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    if (o.disponibile === false) return []
    if (Array.isArray(o.edizioni)) return o.edizioni as NewsDigestEdizione[]
    if (Array.isArray(o.data)) return o.data as NewsDigestEdizione[]
  }
  return []
}

function ParentDigestList() {
  const { parentId, studentId, ready } = useParentIdentity()
  const [edizioni, setEdizioni] = useState<NewsDigestEdizione[]>([])
  const [loading, setLoading] = useState(true)

  const carica = useCallback(async () => {
    try {
      const res = await fetch('/api/news/digest', parentId ? { headers: { 'x-user-id': parentId } } : undefined).catch(() => null)
      if (res && res.ok) setEdizioni(estraiEdizioni(await res.json().catch(() => null)))
    } finally {
      setLoading(false)
    }
  }, [parentId])

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
        News
      </Link>

      <PageHeaderCard eyebrow="Comunicazioni" title="Digest mensile" subtitle="Il riepilogo «Kidville News» inviato via email" className="mb-5" />

      {loading || !ready ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[64px] animate-pulse rounded-card bg-kidville-white" />
          ))}
        </div>
      ) : edizioni.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-kidville-cream text-4xl">✉️</div>
          <h2 className="mb-1 font-barlow text-xl font-bold uppercase text-kidville-green">Ancora nessun digest</h2>
          <p className="max-w-xs font-maven text-sm text-kidville-sub">Ogni mese qui trovi il riepilogo delle novità della scuola.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {edizioni.map((ed) => (
            <Link
              key={ed.id}
              href={withIdentity(`/parent/news/digest/${ed.id}`, parentId, studentId)}
              className="flex items-center gap-3 rounded-card bg-kidville-white px-4 py-3 active:scale-[.99]"
              style={{ boxShadow: '0 1px 2px rgba(0,84,75,.04), 0 8px 24px -18px rgba(0,84,75,.28)' }}
            >
              <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-kidville-green-soft text-kidville-green">
                <Mail size={19} strokeWidth={1.9} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-green">
                  {ed.titolo || `Kidville News — ${MESI_IT[(ed.mese ?? 1) - 1] ?? ''} ${ed.anno ?? ''}`.trim()}
                </span>
                <span className="block font-maven text-xs text-kidville-sub">{MESI_IT[(ed.mese ?? 1) - 1] ?? ''} {ed.anno}</span>
              </span>
              <ChevronRight size={16} strokeWidth={2} className="flex-shrink-0 text-kidville-muted/60" />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

export default function ParentDigestListPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-kidville-green/30 border-t-kidville-green" />
        </div>
      }
    >
      <ParentDigestList />
    </Suspense>
  )
}
