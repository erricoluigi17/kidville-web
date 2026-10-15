import type { AppUser } from '@/lib/auth/predicati-ruolo'
import { politicaNotificaOperazione, oggiRoma, type ContestoNotificaOperazione } from './retroattivita'

/** Le DATE restano civili; i timestamp si convertono nel calendario della scuola. */
export function giornoServizio(valore?: string | null): string | null {
  if (!valore) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(valore)) return valore
  const istante = new Date(valore)
  return Number.isFinite(istante.getTime()) ? oggiRoma(istante) : null
}

/** Una rettifica resta storica anche spostando in avanti la data originale. */
export function politicaNotificaServizio(attore: AppUser, ...date: (string | null | undefined)[]): ContestoNotificaOperazione {
  const giorni = date.map(giornoServizio).filter((giorno): giorno is string => giorno !== null).sort()
  return politicaNotificaOperazione({ attore, giornoCompetenza: giorni[0] ?? oggiRoma() })
}

/** La data originale individua la coda da ritirare anche quando il nuovo giorno è precedente. */
export function politicaRettificaServizio(attore: AppUser, originale: string | null | undefined, ...date: (string | null | undefined)[]): ContestoNotificaOperazione {
  const giornoOriginale = giornoServizio(originale) ?? oggiRoma()
  return { ...politicaNotificaServizio(attore, giornoOriginale, ...date), giornoOriginale }
}
