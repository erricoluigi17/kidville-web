import { describe, it, expect } from 'vitest'
import { sanificaContenuto, sanificaHtml } from '@/lib/news/sanitizza'

// =============================================================================
// Chokepoint di sanificazione rich-text (XSS). Il contenuto arriva come JSON
// TipTap dal client, viene reso in HTML e sanificato con una allowlist rigida.
// I test coprono sia la conversione JSON→HTML (sanificaContenuto) sia il
// sanitizer nudo (sanificaHtml), che è la cintura di sicurezza se dell'HTML
// grezzo raggiungesse comunque il chokepoint.
// =============================================================================

describe('sanificaHtml — sanitizer a lista bianca', () => {
  it('rimuove <script> e il suo contenuto', () => {
    const { html } = sanificaHtml('<p>ciao</p><script>alert(1)</script>')
    expect(html).toContain('ciao')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  it('rimuove <iframe>', () => {
    const { html } = sanificaHtml('<p>x</p><iframe src="https://evil.com"></iframe>')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('evil.com')
  })

  it('strippa href="javascript:…" lasciando il testo del link', () => {
    const { html } = sanificaHtml('<a href="javascript:alert(1)">click</a>')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('click')
  })

  it('rimuove l\'attributo onerror', () => {
    const { html } = sanificaHtml('<p onerror="alert(1)">testo</p>')
    expect(html).not.toContain('onerror')
    expect(html).toContain('testo')
  })

  it('rimuove l\'attributo style', () => {
    const { html } = sanificaHtml('<p style="position:fixed">testo</p>')
    expect(html).not.toContain('style')
  })

  it('rimuove <img> con src data:', () => {
    const { html } = sanificaHtml('<img src="data:image/svg+xml;base64,PHN2Zz4=" alt="x">')
    expect(html).not.toContain('data:')
    expect(html).not.toContain('<img')
  })

  it('rimuove <img> con origin fuori dallo storage Supabase', () => {
    const { html } = sanificaHtml('<img src="https://evil.com/x.png" alt="x">')
    expect(html).not.toContain('evil.com')
    expect(html).not.toContain('<img')
  })

  it('conserva <img> https su host Supabase', () => {
    const src = 'https://abcdefgh.supabase.co/storage/v1/object/public/news/a.png'
    const { html } = sanificaHtml(`<img src="${src}" alt="foto">`)
    expect(html).toContain('supabase.co')
    expect(html).toContain('<img')
  })

  it('conserva i tag della allowlist e aggiunge rel/target ai link http/https', () => {
    const input = '<h2>Titolo</h2><p><strong>b</strong> <em>i</em> <a href="https://kidville.it">l</a></p><ul><li>uno</li></ul>'
    const { html } = sanificaHtml(input)
    expect(html).toContain('<h2>')
    expect(html).toContain('<strong>b</strong>')
    expect(html).toContain('<em>i</em>')
    expect(html).toContain('href="https://kidville.it"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('<li>uno</li>')
  })

  it('conserva i link mailto', () => {
    const { html } = sanificaHtml('<a href="mailto:info@kidville.it">scrivi</a>')
    expect(html).toContain('mailto:info@kidville.it')
  })

  it('ritorna anche il testo semplice, senza tag', () => {
    const { testo } = sanificaHtml('<h2>Titolo</h2><p>Corpo del <strong>testo</strong></p>')
    expect(testo).toContain('Titolo')
    expect(testo).toContain('Corpo del')
    expect(testo).toContain('testo')
    expect(testo).not.toContain('<')
  })
})

describe('sanificaContenuto — JSON TipTap → HTML sanificato', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Titolo H2' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Ciao ' },
          { type: 'text', text: 'grassetto', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' e ' },
          { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://kidville.it' } }] },
        ],
      },
      { type: 'image', attrs: { src: 'https://evil.com/x.png', alt: 'x' } },
    ],
  }

  it('rende i tag ammessi e strippa l\'immagine cross-origin', () => {
    const { html, testo } = sanificaContenuto(doc)
    expect(html).toContain('<h2>')
    expect(html).toContain('<strong>grassetto</strong>')
    expect(html).toContain('href="https://kidville.it"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).not.toContain('evil.com')
    expect(testo).toContain('Titolo H2')
    expect(testo).toContain('grassetto')
    expect(testo).toContain('link')
  })

  it('conserva un\'immagine dello storage Supabase', () => {
    const conFoto = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'https://abcdefgh.supabase.co/storage/v1/object/public/news/a.png', alt: 'foto' } },
      ],
    }
    const { html } = sanificaContenuto(conFoto)
    expect(html).toContain('supabase.co')
    expect(html).toContain('<img')
  })

  it('non lancia su JSON vuoto o malformato', () => {
    expect(() => sanificaContenuto({ type: 'doc', content: [] })).not.toThrow()
    expect(() => sanificaContenuto(null)).not.toThrow()
    const { html, testo } = sanificaContenuto(null)
    expect(html).toBe('')
    expect(testo).toBe('')
  })
})
