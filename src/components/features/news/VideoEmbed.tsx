'use client'

import type { NewsMedia, NewsMediaTipo } from '@/lib/news/tipi'

// =============================================================================
// Embed video WebView-safe. SOLO host allowlist:
//   - YouTube → youtube-nocookie.com/embed/{id}  (privacy-enhanced, no cookie)
//   - Vimeo   → player.vimeo.com/video/{id}
//   - upload diretto → <video controls playsInline> dallo Storage
// L'id si estrae in modo difensivo: il media può arrivare come URL completa o
// come id già normalizzato dall'editor admin. Nessun host arbitrario passa.
// =============================================================================

/** Estrae l'id YouTube da watch/youtu.be/embed/shorts o da un id nudo (11 char). */
export function estraiYoutubeId(urlOrId: string): string | null {
  if (typeof urlOrId !== 'string') return null
  const s = urlOrId.trim()
  if (s === '') return null
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s
  const m =
    /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(s)
  return m ? m[1] : null
}

/** Estrae l'id numerico Vimeo da vimeo.com/{id}, player.vimeo.com/video/{id} o id nudo. */
export function estraiVimeoId(urlOrId: string): string | null {
  if (typeof urlOrId !== 'string') return null
  const s = urlOrId.trim()
  if (s === '') return null
  if (/^\d{5,}$/.test(s)) return s
  const m = /vimeo\.com\/(?:video\/)?(\d{5,})/.exec(s)
  return m ? m[1] : null
}

export interface VideoRisolto {
  kind: 'youtube' | 'vimeo' | 'file' | 'none'
  src: string | null
  poster: string | null
}

/** Risolve un media video nella sua sorgente sicura (pura, testabile). */
export function risolviVideo(media: {
  tipo: NewsMediaTipo | null
  url: string
  poster_url?: string | null
}): VideoRisolto {
  const poster = media.poster_url ?? null
  const url = media.url ?? ''
  if (media.tipo === 'youtube') {
    const id = estraiYoutubeId(url)
    return id ? { kind: 'youtube', src: `https://www.youtube-nocookie.com/embed/${id}`, poster } : { kind: 'none', src: null, poster }
  }
  if (media.tipo === 'vimeo') {
    const id = estraiVimeoId(url)
    return id ? { kind: 'vimeo', src: `https://player.vimeo.com/video/${id}`, poster } : { kind: 'none', src: null, poster }
  }
  if (media.tipo === 'video') {
    return url ? { kind: 'file', src: url, poster } : { kind: 'none', src: null, poster }
  }
  return { kind: 'none', src: null, poster }
}

export function VideoEmbed({ media }: { media: NewsMedia }) {
  const v = risolviVideo(media)
  if (v.kind === 'none' || !v.src) return null

  if (v.kind === 'file') {
    return (
      <video
        controls
        playsInline
        preload="metadata"
        poster={v.poster ?? undefined}
        src={v.src}
        className="w-full rounded-card bg-black"
      >
        <track kind="captions" />
      </video>
    )
  }

  return (
    <div className="relative w-full overflow-hidden rounded-card bg-black" style={{ aspectRatio: '16 / 9' }}>
      <iframe
        src={v.src}
        title={v.kind === 'youtube' ? 'Video YouTube' : 'Video Vimeo'}
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        className="absolute inset-0 h-full w-full border-0"
      />
    </div>
  )
}
