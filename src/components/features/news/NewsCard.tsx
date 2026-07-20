'use client'

import Link from 'next/link'
import { Pin, Newspaper, Megaphone, Camera } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { cx } from '@/lib/ui/cx'
import type { NewsPost, NewsTipo } from '@/lib/news/tipi'

/** Estratto di testo semplice: normalizza gli spazi e tronca con ellissi. */
export function estrattoTesto(testo: string | null | undefined, max = 140): string {
  const t = (testo ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1).trimEnd() + '…'
}

const fmtData = (iso: string | null): string => {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })
  } catch {
    return ''
  }
}

const TIPO_META: Record<NewsTipo, { label: string; Icon: typeof Newspaper }> = {
  articolo: { label: 'Articolo', Icon: Newspaper },
  breve: { label: 'Comunicato', Icon: Megaphone },
  instagram: { label: 'Instagram', Icon: Camera },
}

interface Props {
  post: NewsPost
  categoriaNome?: string | null
  href: string
}

export function NewsCard({ post, categoriaNome, href }: Props) {
  const meta = TIPO_META[post.tipo] ?? TIPO_META.articolo
  const Icon = meta.Icon
  const estratto = estrattoTesto(post.contenuto_testo)

  return (
    <Link href={href} className="block active:scale-[.99]">
      <Card className="overflow-hidden">
        {post.copertina_url && (
          <div className="aspect-[16/9] w-full bg-kidville-cream-dark">
            {/* Storage remoto Supabase: next/image richiederebbe remotePatterns (assenti). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={post.copertina_url} alt="" loading="lazy" className="h-full w-full object-cover" />
          </div>
        )}
        <div className="p-[14px]">
          <div className="flex flex-wrap items-center gap-1.5">
            {post.pinned && (
              <Badge tone="unread" className="gap-1">
                <Pin size={11} strokeWidth={2.4} />
                In evidenza
              </Badge>
            )}
            <span className="inline-flex items-center gap-1 rounded-pill bg-kidville-green-soft px-[9px] py-1 font-barlow text-[11px] font-extrabold uppercase tracking-[0.06em] text-kidville-green">
              <Icon size={12} strokeWidth={2.2} />
              {meta.label}
            </span>
            {categoriaNome && (
              <span className="inline-flex items-center rounded-pill bg-kidville-yellow-soft px-[9px] py-1 font-barlow text-[11px] font-extrabold uppercase tracking-[0.06em] text-kidville-yellow-dark">
                {categoriaNome}
              </span>
            )}
            <span className="ml-auto font-maven text-[11px] text-kidville-muted">
              {fmtData(post.pubblicata_il)}
            </span>
          </div>
          <h3 className="mt-2 line-clamp-2 font-barlow text-base font-extrabold uppercase leading-tight text-kidville-green">
            {post.titolo}
          </h3>
          {estratto && (
            <p className={cx('mt-1 font-maven text-[12.5px] leading-snug text-kidville-sub', post.copertina_url ? 'line-clamp-2' : 'line-clamp-3')}>
              {estratto}
            </p>
          )}
        </div>
      </Card>
    </Link>
  )
}
