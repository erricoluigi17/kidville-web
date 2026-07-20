'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Newspaper, Megaphone, Camera, Pin } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cx } from '@/lib/ui/cx'
import { withIdentity } from '@/lib/auth/current-user'
import type { NewsPost, NewsTipo } from '@/lib/news/tipi'
import { estraiFeed } from '@/components/features/news/NewsFeedList'
import { estrattoTesto } from '@/components/features/news/NewsCard'

interface Props {
  parentId: string
  studentId: string | null
}

const TIPO_ICON: Record<NewsTipo, typeof Newspaper> = {
  articolo: Newspaper,
  breve: Megaphone,
  instagram: Camera,
}

const fmtData = (iso: string | null): string => {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })
  } catch {
    return ''
  }
}

/**
 * Anteprima News per la home genitore, modello di AvvisiPreview: fetch best-effort
 * dei primi 3 post pubblicati, sola lettura, si NASCONDE se vuoto (o se il modulo
 * degrada su DB non migrato). Le azioni vivono su /parent/news.
 */
export function NewsPreview({ parentId, studentId }: Props) {
  const [items, setItems] = useState<NewsPost[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!parentId) return
    let attivo = true
    const carica = async () => {
      try {
        const res = await fetch('/api/news/feed?limit=3', { headers: { 'x-user-id': parentId } })
        if (res.ok && attivo) setItems(estraiFeed(await res.json()).slice(0, 3))
      } finally {
        if (attivo) setLoaded(true)
      }
    }
    carica()
    return () => {
      attivo = false
    }
  }, [parentId])

  if (!loaded || items.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      {items.map((p) => {
        const Icon = TIPO_ICON[p.tipo] ?? Newspaper
        return (
          <Link key={p.id} href={withIdentity(`/parent/news/${p.id}`, parentId, studentId)} className="block active:scale-[.99]">
            <Card className="p-[14px]">
              <div className="flex items-start gap-3">
                <div className={cx(
                  'flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center rounded-xl text-kidville-green',
                  p.pinned ? 'bg-kidville-yellow' : 'bg-kidville-green-soft',
                )}>
                  {p.pinned ? <Pin size={18} strokeWidth={2} /> : <Icon size={19} strokeWidth={1.8} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-barlow text-[11px] font-bold uppercase tracking-[0.06em] text-kidville-yellow-dark">
                      {p.pinned ? 'In evidenza' : 'News'}
                    </span>
                    <span className="font-maven text-[11px] text-kidville-muted">{fmtData(p.pubblicata_il)}</span>
                  </div>
                  <h3 className="mt-1 line-clamp-1 font-barlow text-base font-extrabold uppercase leading-tight text-kidville-green">
                    {p.titolo}
                  </h3>
                  <p className="mt-1 line-clamp-2 font-maven text-[12.5px] leading-snug text-kidville-sub">
                    {estrattoTesto(p.contenuto_testo, 110)}
                  </p>
                </div>
              </div>
            </Card>
          </Link>
        )
      })}
    </div>
  )
}
