import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { NewsMedia, NewsPost } from '@/lib/news/tipi'
import { estraiFeed, estraiArchivio, NewsFeedList } from '@/components/features/news/NewsFeedList'
import { NewsCard, estrattoTesto } from '@/components/features/news/NewsCard'
import { formattaMeseArchivio } from '@/components/features/news/NewsArchivioDrawer'
import {
  VideoEmbed,
  estraiYoutubeId,
  estraiVimeoId,
  risolviVideo,
} from '@/components/features/news/VideoEmbed'
import { InstagramEmbed } from '@/components/features/news/InstagramEmbed'

// Post minimale usato dai test di rendering.
const basePost: NewsPost = {
  id: 'p1',
  tipo: 'articolo',
  stato: 'pubblicata',
  titolo: 'Festa di primavera',
  contenuto_json: null,
  contenuto_html: '<p>ciao</p>',
  contenuto_testo: 'Vieni alla festa di primavera nel giardino della scuola.',
  categoria_id: 'c1',
  programmata_il: null,
  pubblicata_il: '2026-04-10T09:00:00.000Z',
  pinned: false,
  target_scope: 'globale',
  target_gradi: null,
  target_classes: null,
  copertina_url: null,
  instagram_url: null,
  instagram_shortcode: null,
  ig_check_falliti: 0,
  ig_check_il: null,
  nascosta_motivo: null,
  invia_notifica: true,
  notifica_inviata_il: null,
  approvata_da: null,
  approvata_il: null,
  scuola_id: 's1',
  author_id: 'a1',
}

describe('estraiFeed — normalizzazione risposta feed (contratto tollerante)', () => {
  it('accetta un array diretto di post', () => {
    expect(estraiFeed([basePost])).toHaveLength(1)
  })
  it('estrae da { posts: [...] }', () => {
    expect(estraiFeed({ posts: [basePost] })).toHaveLength(1)
  })
  it('estrae da { data: [...] } e { items: [...] }', () => {
    expect(estraiFeed({ data: [basePost] })).toHaveLength(1)
    expect(estraiFeed({ items: [basePost] })).toHaveLength(1)
  })
  it('degrado schema-assente { disponibile: false } → []', () => {
    expect(estraiFeed({ disponibile: false })).toEqual([])
  })
  it('valori inattesi → []', () => {
    expect(estraiFeed(null)).toEqual([])
    expect(estraiFeed('boom')).toEqual([])
    expect(estraiFeed({ nope: 1 })).toEqual([])
  })
})

describe('estraiArchivio — normalizzazione aggregato mesi', () => {
  it('accetta array [{mese, conteggio}]', () => {
    const out = estraiArchivio([{ mese: '2026-07', conteggio: 3 }])
    expect(out).toEqual([{ mese: '2026-07', conteggio: 3 }])
  })
  it('estrae da { archivio: [...] } e { mesi: [...] }', () => {
    expect(estraiArchivio({ archivio: [{ mese: '2026-06', conteggio: 2 }] })).toHaveLength(1)
    expect(estraiArchivio({ mesi: [{ mese: '2026-06', conteggio: 2 }] })).toHaveLength(1)
  })
  it('scarta mesi con formato non valido', () => {
    expect(estraiArchivio([{ mese: '2026-7', conteggio: 1 }, { mese: 'x', conteggio: 1 }])).toEqual([])
  })
  it('degrado { disponibile:false } → []', () => {
    expect(estraiArchivio({ disponibile: false })).toEqual([])
  })
})

describe('estrattoTesto', () => {
  it('testo corto restituito invariato (spazi normalizzati)', () => {
    expect(estrattoTesto('  ciao   mondo ')).toBe('ciao mondo')
  })
  it('testo lungo troncato con ellissi', () => {
    const t = 'a'.repeat(200)
    const out = estrattoTesto(t, 20)
    expect(out.length).toBe(20)
    expect(out.endsWith('…')).toBe(true)
  })
  it('null/undefined → stringa vuota', () => {
    expect(estrattoTesto(null)).toBe('')
    expect(estrattoTesto(undefined)).toBe('')
  })
})

describe('formattaMeseArchivio', () => {
  it("'2026-07' → 'Luglio 2026'", () => {
    expect(formattaMeseArchivio('2026-07')).toBe('Luglio 2026')
  })
  it("'2026-01' → 'Gennaio 2026'", () => {
    expect(formattaMeseArchivio('2026-01')).toBe('Gennaio 2026')
  })
  it('formato non valido → passthrough', () => {
    expect(formattaMeseArchivio('boom')).toBe('boom')
    expect(formattaMeseArchivio('2026-13')).toBe('2026-13')
  })
})

describe('estraiYoutubeId', () => {
  it('watch?v=', () => {
    expect(estraiYoutubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })
  it('youtu.be short', () => {
    expect(estraiYoutubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })
  it('embed / nocookie', () => {
    expect(estraiYoutubeId('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })
  it('id nudo', () => {
    expect(estraiYoutubeId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })
  it('non valido → null', () => {
    expect(estraiYoutubeId('https://example.com/x')).toBeNull()
    expect(estraiYoutubeId('')).toBeNull()
  })
})

describe('estraiVimeoId', () => {
  it('vimeo.com/123456789', () => {
    expect(estraiVimeoId('https://vimeo.com/123456789')).toBe('123456789')
  })
  it('player.vimeo.com/video/123456789', () => {
    expect(estraiVimeoId('https://player.vimeo.com/video/123456789')).toBe('123456789')
  })
  it('id numerico nudo', () => {
    expect(estraiVimeoId('123456789')).toBe('123456789')
  })
  it('non valido → null', () => {
    expect(estraiVimeoId('https://example.com/1')).toBeNull()
  })
})

describe('risolviVideo', () => {
  it('youtube → host nocookie', () => {
    const r = risolviVideo({ tipo: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ', poster_url: null })
    expect(r.kind).toBe('youtube')
    expect(r.src).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')
  })
  it('vimeo → player.vimeo.com', () => {
    const r = risolviVideo({ tipo: 'vimeo', url: 'https://vimeo.com/123456789', poster_url: null })
    expect(r.kind).toBe('vimeo')
    expect(r.src).toBe('https://player.vimeo.com/video/123456789')
  })
  it('upload → file con url diretta', () => {
    const r = risolviVideo({ tipo: 'video', url: 'https://cdn.kidville/x.mp4', poster_url: 'https://cdn/p.jpg' })
    expect(r.kind).toBe('file')
    expect(r.src).toBe('https://cdn.kidville/x.mp4')
    expect(r.poster).toBe('https://cdn/p.jpg')
  })
  it('url non risolvibile → none', () => {
    expect(risolviVideo({ tipo: 'youtube', url: 'boom', poster_url: null }).kind).toBe('none')
  })
})

describe('VideoEmbed (rendering)', () => {
  const mk = (m: Partial<NewsMedia>): NewsMedia => ({
    id: 'm1', post_id: 'p1', tipo: 'video', url: '', poster_url: null, ordine: 0, ...m,
  })
  it('youtube → iframe nocookie con title', () => {
    render(<VideoEmbed media={mk({ tipo: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ' })} />)
    const frame = screen.getByTitle(/video/i) as HTMLIFrameElement
    expect(frame.src).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ')
  })
  it('upload → <video> con playsInline', () => {
    const { container } = render(<VideoEmbed media={mk({ tipo: 'video', url: 'https://cdn/x.mp4' })} />)
    const video = container.querySelector('video')
    expect(video).not.toBeNull()
    // React rende `playsInline` come attributo DOM `playsinline`.
    expect(video?.hasAttribute('playsinline')).toBe(true)
  })
})

describe('InstagramEmbed (rendering)', () => {
  it('mostra SEMPRE il link «Apri su Instagram» con host ufficiale', () => {
    render(<InstagramEmbed shortcode="ABC123xyz" />)
    const link = screen.getByRole('link', { name: /apri su instagram/i }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toContain('instagram.com/p/ABC123xyz')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(link.getAttribute('target')).toBe('_blank')
  })
  it('iframe di embed con title accessibile', () => {
    render(<InstagramEmbed shortcode="ABC123xyz" />)
    const frame = screen.getByTitle(/instagram/i) as HTMLIFrameElement
    expect(frame.src).toContain('instagram.com/p/ABC123xyz/embed')
  })
})

describe('NewsCard (rendering)', () => {
  it('rende titolo, estratto e link al dettaglio', () => {
    render(<NewsCard post={basePost} categoriaNome="Eventi" href="/parent/news/p1" />)
    expect(screen.getByText('Festa di primavera')).toBeInTheDocument()
    expect(screen.getByText(/vieni alla festa/i)).toBeInTheDocument()
    const link = screen.getByRole('link') as HTMLAnchorElement
    expect(link.getAttribute('href')).toContain('/parent/news/p1')
  })
  it('post pinned → badge «In evidenza»', () => {
    render(<NewsCard post={{ ...basePost, pinned: true }} href="/parent/news/p1" />)
    expect(screen.getByText(/in evidenza/i)).toBeInTheDocument()
  })
})

describe('NewsFeedList (smoke — è esportato e montabile)', () => {
  it('è una funzione componente', () => {
    expect(typeof NewsFeedList).toBe('function')
  })
})
