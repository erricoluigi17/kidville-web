'use client'

import { Suspense } from 'react'
import Link from 'next/link'
import { Mail, ChevronRight } from 'lucide-react'
import { PageHeaderCard } from '@/components/ui/PageHeaderCard'
import { useParentIdentity } from '@/lib/auth/use-parent-identity'
import { withIdentity } from '@/lib/auth/current-user'
import { NewsFeedList } from '@/components/features/news/NewsFeedList'

function ParentNewsContent() {
  const { parentId, studentId, ready } = useParentIdentity()

  return (
    <div className="px-4 pt-5 pb-28">
      <PageHeaderCard
        eyebrow="Comunicazioni"
        title="News"
        subtitle="Novità, eventi e comunicati della scuola"
        className="mb-5"
      />

      {/* Accesso al digest mensile archiviato. */}
      <Link
        href={withIdentity('/parent/news/digest', parentId, studentId)}
        className="mb-4 flex items-center gap-3 rounded-card bg-kidville-white px-4 py-3 active:scale-[.99]"
        style={{ boxShadow: '0 1px 2px rgba(0,84,75,.04), 0 8px 24px -18px rgba(0,84,75,.28)' }}
      >
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-kidville-yellow-soft text-kidville-yellow-dark">
          <Mail size={19} strokeWidth={1.9} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-green">Digest mensile</span>
          <span className="block font-maven text-xs text-kidville-muted">Il riepilogo «Kidville News» via email</span>
        </span>
        <ChevronRight size={16} strokeWidth={2} className="flex-shrink-0 text-kidville-muted/60" />
      </Link>

      {ready ? (
        <NewsFeedList parentId={parentId} studentId={studentId} />
      ) : (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[120px] animate-pulse rounded-card bg-kidville-white" />
          ))}
        </div>
      )}
    </div>
  )
}

export default function ParentNewsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 pb-24 pt-5">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-kidville-green/30 border-t-kidville-green" />
        </div>
      }
    >
      <ParentNewsContent />
    </Suspense>
  )
}
