'use client'

import { Pin, Newspaper, Megaphone, Camera } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import type { NewsMedia, NewsPost, NewsTipo } from '@/lib/news/tipi'
import { InstagramEmbed } from './InstagramEmbed'
import { VideoEmbed } from './VideoEmbed'

const TIPO_META: Record<NewsTipo, { label: string; Icon: typeof Newspaper }> = {
  articolo: { label: 'Articolo', Icon: Newspaper },
  breve: { label: 'Comunicato', Icon: Megaphone },
  instagram: { label: 'Instagram', Icon: Camera },
}

const fmtDataLunga = (iso: string | null): string => {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Rome' })
  } catch {
    return ''
  }
}

interface Props {
  post: NewsPost
  media: NewsMedia[]
  categoriaNome?: string | null
}

export function NewsDetailContent({ post, media, categoriaNome }: Props) {
  const meta = TIPO_META[post.tipo] ?? TIPO_META.articolo
  const Icon = meta.Icon
  const immagini = media.filter((m) => m.tipo === 'immagine')
  const video = media.filter((m) => m.tipo === 'video' || m.tipo === 'youtube' || m.tipo === 'vimeo')

  return (
    <article className="flex flex-col gap-4">
      {post.copertina_url && (
        <div className="overflow-hidden rounded-card bg-kidville-cream-dark">
          {/* Storage remoto Supabase: next/image richiederebbe remotePatterns (assenti). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={post.copertina_url} alt="" className="w-full object-cover" />
        </div>
      )}

      <header>
        <div className="flex flex-wrap items-center gap-1.5">
          {post.pinned && (
            <Badge tone="evidenza" className="gap-1">
              <Pin size={11} strokeWidth={2.4} />
              In evidenza
            </Badge>
          )}
          <span className="inline-flex items-center gap-1 rounded-pill bg-kidville-green-soft px-[9px] py-1 font-barlow text-[11px] font-extrabold uppercase tracking-[0.06em] text-kidville-green">
            <Icon size={12} strokeWidth={2.2} />
            {meta.label}
          </span>
          {categoriaNome && (
            <span className="inline-flex items-center rounded-pill bg-kidville-yellow-soft px-[9px] py-1 font-barlow text-[11px] font-extrabold uppercase tracking-[0.06em] text-kidville-ink">
              {categoriaNome}
            </span>
          )}
        </div>
        <h1 className="mt-2 font-barlow text-2xl font-black uppercase leading-tight text-kidville-green">{post.titolo}</h1>
        {post.pubblicata_il && (
          <p className="mt-1 font-maven text-[12.5px] text-kidville-sub">{fmtDataLunga(post.pubblicata_il)}</p>
        )}
      </header>

      {/* Corpo rich-text. `contenuto_html` è GIÀ sanificato server-side dal chokepoint
          unico src/lib/news/sanitizza.ts (allowlist tag + rel/target sui link, niente
          script/iframe/on*): è l'UNICO punto dell'app con dangerouslySetInnerHTML sulle
          news, ed è sicuro solo perché la sanificazione è del server, mai del client. */}
      {post.contenuto_html && (
        <div
          className="[&_a]:font-semibold [&_a]:text-kidville-green [&_a]:underline [&_blockquote]:border-l-4 [&_blockquote]:border-kidville-yellow [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-kidville-sub [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:font-barlow [&_h2]:text-lg [&_h2]:font-extrabold [&_h2]:uppercase [&_h2]:text-kidville-green [&_h3]:mb-1.5 [&_h3]:mt-4 [&_h3]:font-barlow [&_h3]:font-bold [&_h3]:uppercase [&_h3]:text-kidville-green [&_img]:my-3 [&_img]:w-full [&_img]:rounded-card [&_li]:mb-1 [&_li]:font-maven [&_li]:text-[15px] [&_li]:text-kidville-ink [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-3 [&_p]:font-maven [&_p]:text-[15px] [&_p]:leading-relaxed [&_p]:text-kidville-ink [&_strong]:font-bold [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5"
          dangerouslySetInnerHTML={{ __html: post.contenuto_html }}
        />
      )}

      {/* Post Instagram embeddato: link «Apri su Instagram» sempre presente. */}
      {post.tipo === 'instagram' && post.instagram_shortcode && (
        <InstagramEmbed shortcode={post.instagram_shortcode} url={post.instagram_url} />
      )}

      {/* Video associati (upload / YouTube-nocookie / Vimeo). */}
      {video.length > 0 && (
        <div className="flex flex-col gap-3">
          {video.map((m) => (
            <VideoEmbed key={m.id} media={m} />
          ))}
        </div>
      )}

      {/* Galleria immagini. */}
      {immagini.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {immagini.map((m) => (
            <div key={m.id} className="overflow-hidden rounded-card bg-kidville-cream-dark">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={m.url} alt="" loading="lazy" className="aspect-square w-full object-cover" />
            </div>
          ))}
        </div>
      )}
    </article>
  )
}
