'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { useParentIdentity } from '@/lib/auth/use-parent-identity'
import { withIdentity } from '@/lib/auth/current-user'
import { MESI_IT, type NewsDigestEdizione } from '@/lib/news/tipi'

function ParentDigestDetail() {
  const { parentId, studentId, ready } = useParentIdentity()
  const params = useParams<{ id: string }>()
  const id = params?.id

  const [edizione, setEdizione] = useState<NewsDigestEdizione | null>(null)
  const [loading, setLoading] = useState(true)
  const [errore, setErrore] = useState(false)

  const carica = useCallback(async () => {
    if (!id) return
    try {
      const res = await fetch(`/api/news/digest/${id}`, parentId ? { headers: { 'x-user-id': parentId } } : undefined).catch(() => null)
      if (!res || !res.ok) { setErrore(true); return }
      const j = (await res.json().catch(() => null)) as { disponibile?: boolean; edizione?: NewsDigestEdizione } | null
      if (!j || j.disponibile === false || !j.edizione) { setErrore(true); return }
      setEdizione(j.edizione)
      setErrore(false)
    } finally {
      setLoading(false)
    }
  }, [id, parentId])

  useEffect(() => {
    if (ready) void carica()
  }, [ready, carica])

  const titolo = edizione
    ? edizione.titolo || `Kidville News — ${MESI_IT[(edizione.mese ?? 1) - 1] ?? ''} ${edizione.anno ?? ''}`.trim()
    : 'Digest'

  return (
    <div className="px-4 pt-5 pb-28">
      <Link
        href={withIdentity('/parent/news/digest', parentId, studentId)}
        className="mb-4 inline-flex items-center gap-1.5 font-barlow text-[12.5px] font-extrabold uppercase tracking-wide text-kidville-green active:scale-95"
      >
        <ArrowLeft size={16} strokeWidth={2.4} />
        Tutti i digest
      </Link>

      {loading || !ready ? (
        <div className="h-[70vh] animate-pulse rounded-card bg-kidville-white" />
      ) : edizione && edizione.html && !errore ? (
        <div className="overflow-hidden rounded-card border border-kidville-line bg-kidville-white">
          {/* L'HTML è il template email generato dal server (src/lib/news/digest-email.ts):
              lo si isola in un iframe con srcDoc, WebView-safe. */}
          <iframe srcDoc={edizione.html} title={titolo} className="h-[75vh] w-full border-0" />
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-card bg-kidville-white py-12 text-center">
          <p className="font-maven text-sm text-kidville-muted">Digest non disponibile.</p>
          <button
            type="button"
            onClick={() => {
              setLoading(true)
              setErrore(false)
              void carica()
            }}
            className="mt-3 inline-flex items-center gap-2 rounded-pill bg-kidville-green px-4 py-2 font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-yellow active:scale-95"
          >
            <RotateCcw size={15} strokeWidth={2.4} />
            Riprova
          </button>
        </div>
      )}
    </div>
  )
}

export default function ParentDigestDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-kidville-green/30 border-t-kidville-green" />
        </div>
      }
    >
      <ParentDigestDetail />
    </Suspense>
  )
}
