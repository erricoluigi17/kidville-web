'use client'

import { buildEmbedUrl } from '@/lib/news/instagram'

// =============================================================================
// Embed Instagram WebView-safe. Regola invariante (decisione di piano): il link
// «Apri su Instagram» è SEMPRE presente e MAI condizionale — se l'iframe non
// carica nella WebView Capacitor, resta comunque un modo per aprire il post.
// L'iframe usa l'URL di embed «captioned» ufficiale (stesso chokepoint del server).
// =============================================================================

interface Props {
  shortcode: string
  /** URL originale del post (se noto): usato per il link «Apri su Instagram». */
  url?: string | null
}

export function InstagramEmbed({ shortcode, url }: Props) {
  const embedUrl = buildEmbedUrl(shortcode)
  const permalink = url && /^https?:\/\/(www\.)?instagram\.com\//i.test(url)
    ? url
    : `https://www.instagram.com/p/${shortcode}/`

  return (
    <div className="flex flex-col gap-3">
      <div
        className="w-full overflow-hidden rounded-card border border-kidville-line bg-kidville-white"
        style={{ minHeight: 320 }}
      >
        <iframe
          src={embedUrl}
          title="Post Instagram"
          loading="lazy"
          scrolling="no"
          referrerPolicy="strict-origin-when-cross-origin"
          className="h-[560px] w-full border-0"
        />
      </div>
      {/* Sempre presente: l'iframe IG è inaffidabile nella WebView nativa. */}
      <a
        href={permalink}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center justify-center gap-2 rounded-pill bg-kidville-green px-4 py-2.5 font-barlow text-sm font-extrabold uppercase tracking-wide text-white active:scale-95"
      >
        Apri su Instagram
      </a>
    </div>
  )
}
