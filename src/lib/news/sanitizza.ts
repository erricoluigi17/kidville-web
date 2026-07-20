import sanitizeHtml from 'sanitize-html'
import { generateHTML } from '@tiptap/html'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'

// =============================================================================
// CHOKEPOINT UNICO di sanificazione del rich-text delle News.
//
// Il client invia SOLO il JSON di TipTap (mai HTML): il server lo rende in HTML
// (generateHTML, stesso set di estensioni dell'editor) e lo passa dal sanitizer
// a lista bianca. Il risultato è l'unico HTML che finisce in `contenuto_html`
// e che il frontend rende con `dangerouslySetInnerHTML`. Nessun altro punto del
// codice deve produrre HTML di news: qui, e solo qui, si decide cosa è sicuro.
//
// La allowlist è volutamente minima (decisione 5): niente <script>/<iframe>,
// niente attributo style, niente handler inline, immagini SOLO https dallo
// storage Supabase, link http/https/mailto forzati a rel="noopener noreferrer".
// =============================================================================

const TAG_AMMESSI = ['p', 'h2', 'h3', 'strong', 'em', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'br', 'img']

/**
 * Un <img> è ammesso solo se è un URL https su un host dello storage Supabase
 * (host di NEXT_PUBLIC_SUPABASE_URL oppure un progetto *.supabase.co). Blocca
 * data:, http:, e qualunque origine esterna (esfiltrazione via referrer / SSRF
 * lato client / tracciamento).
 */
function imgConsentita(src: string | undefined): boolean {
  if (!src) return false
  try {
    const u = new URL(src)
    if (u.protocol !== 'https:') return false
    const host = u.hostname
    const envUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    if (envUrl) {
      try {
        if (new URL(envUrl).hostname === host) return true
      } catch {
        // env malformata: si ricade sul controllo del suffisso.
      }
    }
    return host.endsWith('.supabase.co')
  } catch {
    return false
  }
}

const OPZIONI: sanitizeHtml.IOptions = {
  allowedTags: TAG_AMMESSI,
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['https'] },
  // Rimuove per intero (tag + contenuto) gli elementi pericolosi che potrebbero
  // arrivare come HTML grezzo.
  nonTextTags: ['script', 'style', 'iframe', 'textarea', 'noscript'],
  // Forza rel/target sui link superstiti (lo scheme è già filtrato da allowedSchemes).
  transformTags: {
    a: (tagName, attribs) => ({
      tagName: 'a',
      attribs: {
        ...(attribs.href ? { href: attribs.href } : {}),
        target: '_blank',
        rel: 'noopener noreferrer',
      },
    }),
  },
  // Scarta le immagini la cui origine non è lo storage Supabase.
  exclusiveFilter: (frame) => frame.tag === 'img' && !imgConsentita(frame.attribs?.src),
}

/** HTML → testo semplice leggibile (per `contenuto_testo` e tsvector/estratti). */
function estraiTesto(html: string): string {
  // I confini di blocco diventano spazi PRIMA di rimuovere i tag, così le parole
  // non si incollano ("Titolo</h2><p>Corpo" → "Titolo Corpo", non "TitoloCorpo").
  const conSpazi = html
    .replace(/<\/(p|h2|h3|li|blockquote|div)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
  const soloTesto = sanitizeHtml(conSpazi, { allowedTags: [], allowedAttributes: {} })
  return soloTesto.replace(/\s+/g, ' ').trim()
}

/** Sanitizer nudo: HTML grezzo → { html sicuro, testo }. Cintura di sicurezza. */
export function sanificaHtml(html: string): { html: string; testo: string } {
  const safe = sanitizeHtml(html ?? '', OPZIONI)
  return { html: safe, testo: estraiTesto(safe) }
}

const ESTENSIONI = [StarterKit, Link, Image]

/** Chokepoint: JSON TipTap → HTML sanificato + testo. Import solo server-side. */
export function sanificaContenuto(json: unknown): { html: string; testo: string } {
  if (json == null || typeof json !== 'object') return { html: '', testo: '' }
  let grezzo = ''
  try {
    grezzo = generateHTML(json as Record<string, unknown>, ESTENSIONI)
  } catch {
    // JSON non valido per lo schema TipTap: nessun HTML producibile.
    return { html: '', testo: '' }
  }
  return sanificaHtml(grezzo)
}
