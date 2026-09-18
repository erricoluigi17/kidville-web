import { describe, it, expect } from 'vitest'

import {
  BUCKET_BOZZE_NEWS,
  paragrafoAllegatoVideo,
  percorsoAllegatoBozzaVideo,
  urlAllegatoBozzaVideo,
} from '@/components/features/admin/news/video/allegato-bozza'
import { NEWS_BUCKET_BOZZE, pathBozza } from '@/lib/news/media-bozza'
import { percorsoAllegatoVideoNews } from '@/lib/news/video-allegato'
import { sanificaContenuto } from '@/lib/news/sanitizza'

/**
 * IL VIDEO ENTRA NELL'ARTICOLO COME UN ALLEGATO DI BOZZA QUALUNQUE.
 *
 * ─── PERCHÉ IL GEMELLO CLIENT ESISTE, invece di importare quello vero ───────
 *
 * `@/lib/news/video-allegato` conosce la forma del percorso ed è la fonte —
 * ma importa `@/lib/logging/logger`, che tira dentro `app-log` → `node:crypto`
 * e il client Supabase con la CHIAVE DI SERVIZIO. In un componente `'use client'`
 * quell'import non è un peso: è un segreto nel bundle del browser.
 *
 * Quindi il percorso è scritto due volte, e la seconda copia è LEGATA alla prima
 * da questo test: se un giorno il nome del bucket o la forma di
 * `uploads/<proprietario>/<job>.mp4` cambiassero da una parte sola, la
 * promozione (`promuoviMediaBozza`) smetterebbe di riconoscere l'indirizzo e
 * l'articolo verrebbe salvato citando un file rimasto privato — un video rotto
 * per le famiglie, scritto in silenzio.
 *
 * ─── PERCHÉ UN LINK E NON UN NODO `video` ──────────────────────────────────
 *
 * Misurato, non supposto (sonda del 2026-09-18): il chokepoint del server
 * (`sanificaContenuto`) rende il JSON di TipTap con `[StarterKit, Link, Image]`.
 * Un nodo che quelle estensioni non conoscono fa lanciare `generateHTML`, il
 * `catch` restituisce `{ html: '', testo: '' }` e **l'intero corpo dell'articolo
 * sparisce** — anche i paragrafi che con il video non c'entrano niente, anche
 * senza un errore a schermo. Il terzo test qui sotto è quella misura, tenuta
 * viva: è la ragione della forma scelta, e va vista fallire se qualcuno prova a
 * inserire un nodo suo.
 */

const OWNER = '11111111-1111-4111-8111-111111111111'
const JOB = '22222222-2222-4222-8222-222222222222'

function doc(...blocchi: unknown[]) {
  return { type: 'doc', content: blocchi }
}

describe('l’allegato video della bozza News', () => {
  it('il percorso del client è lo STESSO che scrive il server', () => {
    expect(percorsoAllegatoBozzaVideo(OWNER, JOB)).toBe(percorsoAllegatoVideoNews(OWNER, JOB))
    expect(percorsoAllegatoBozzaVideo(OWNER, JOB)).toBe(`uploads/${OWNER}/${JOB}.mp4`)
  })

  it('il bucket del client è lo STESSO che usa la promozione', () => {
    expect(BUCKET_BOZZE_NEWS).toBe(NEWS_BUCKET_BOZZE)
  })

  it('rifiuta ciò che non è un uuid, esattamente come il gemello del server', () => {
    for (const storto of ['', '../altro', 'uploads/x', OWNER.slice(0, 20), null, undefined, 42]) {
      expect(percorsoAllegatoBozzaVideo(storto, JOB)).toBeNull()
      expect(percorsoAllegatoBozzaVideo(OWNER, storto)).toBeNull()
      expect(percorsoAllegatoVideoNews(storto, JOB)).toBeNull()
    }
    expect(urlAllegatoBozzaVideo(OWNER, 'non-un-uuid')).toBeNull()
  })

  it('l’indirizzo è quello che `pathBozza` sa riportare al suo percorso', () => {
    const url = urlAllegatoBozzaVideo(OWNER, JOB)
    expect(url).toContain(`/${NEWS_BUCKET_BOZZE}/`)
    expect(pathBozza(url)).toBe(percorsoAllegatoVideoNews(OWNER, JOB))
  })

  it('il paragrafo sopravvive al chokepoint del server, con l’indirizzo intatto', () => {
    const url = urlAllegatoBozzaVideo(OWNER, JOB)
    const reso = sanificaContenuto(
      doc(
        { type: 'paragraph', content: [{ type: 'text', text: 'La recita di fine anno' }] },
        paragrafoAllegatoVideo(url as string, 'Guarda il video'),
      ),
    )
    expect(reso.html).toContain('La recita di fine anno')
    expect(reso.html).toContain(`href="${url}"`)
    expect(reso.html).toContain('Guarda il video')
    // E l'indirizzo resta una stringa dell'albero: è da lì che `promuoviMediaBozza`
    // lo pesca. Senza, il file resterebbe privato con la riga già scritta.
    expect(pathBozza(url)).not.toBeNull()
  })

  it('un nodo che il server non conosce CANCELLA tutto il corpo (la misura che ha deciso la forma)', () => {
    const reso = sanificaContenuto(
      doc(
        { type: 'paragraph', content: [{ type: 'text', text: 'La recita di fine anno' }] },
        { type: 'video', attrs: { src: urlAllegatoBozzaVideo(OWNER, JOB) } },
      ),
    )
    expect(reso.html).toBe('')
    expect(reso.testo).toBe('')
  })
})
