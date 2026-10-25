/**
 * LA CACHE DI UNA LETTURA PUBBLICA — fase 12 della robustezza (2026-10-19).
 *
 * Il modulo d'iscrizione apre `/api/iscrizione/sedi` e `/api/iscrizione/model` a ogni visita: due
 * funzioni e due letture del database per una risposta che cambia quando la segreteria cambia una
 * sede o il modello, cioè quasi mai. Con `s-maxage` la risposta la tiene la CDN di Vercel per pochi
 * minuti, e la visita successiva non sveglia nessuna funzione.
 *
 * Le regole sono quelle di `src/app/api/anagrafiche/comuni/route.ts`, dove sono spiegate per
 * esteso, e qui non si riscrivono:
 *   · `public` SOLO senza un cookie di sessione: col cookie il middleware può attaccare un
 *     `Set-Cookie` alla risposta, e una cache condivisa lo riservirebbe a chiunque. Col cookie la
 *     risposta è `private` (la tiene solo il browser di chi l'ha chiesta);
 *   · `Vary: Cookie` su entrambe le strade;
 *   · si chiama SOLO sulla risposta buona: un 429, un 500 o un ripiego dopo un guasto non hanno
 *     intestazioni di cache, e nessuno li conserva.
 */
import { haCookieSessioneNellIntestazione } from '@/lib/auth/session-cookie'

/**
 * Le intestazioni per una risposta pubblica che può restare in cache `secondi` (e `stantio`
 * secondi in più, servita mentre si rinnova).
 *
 * Sessione 13, prova 1 della diagnosi del MISS: sulla strada pubblica la durata si dichiara anche in
 * `Vercel-CDN-Cache-Control`, che per la CDN di Vercel vince su `Cache-Control` e non arriva al browser.
 * La strada con sessione non la porta: lì nessuna cache condivisa deve conservare niente.
 */
export function intestazioniCachePubblica(
  request: Request,
  secondi: number,
  stantio: number,
): Record<string, string> {
  if (haCookieSessioneNellIntestazione(request.headers.get('cookie'))) {
    return {
      'Cache-Control': `private, max-age=${secondi}, stale-while-revalidate=${stantio}`,
      Vary: 'Cookie',
    }
  }
  return {
    'Cache-Control': `public, max-age=${secondi}, s-maxage=${secondi}, stale-while-revalidate=${stantio}`,
    'Vercel-CDN-Cache-Control': `max-age=${secondi}, stale-while-revalidate=${stantio}`,
    Vary: 'Cookie',
  }
}
