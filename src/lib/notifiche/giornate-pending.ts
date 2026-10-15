import { intervalloGiornoRoma } from '@/lib/storici/retroattivita'

/**
 * Prima la competenza persistita, poi la politica originale. Solo le righe
 * precedenti a entrambi i metadati ricadono nel giorno di creazione romano.
 * `notifiche.creato_il` è timestamptz DEFAULT now() (baseline 20260704120000):
 * il momento programmato può cadere nel giorno successivo e non identifica il fatto.
 */
export function filtroGiornatePending(giorni: readonly string[], disponibili: { giornoCompetenza?: boolean; politicaOperazione?: boolean } = {}): string {
  const unici = [...new Set(giorni)]
  if (!unici.length) throw new RangeError('Giornata della notifica mancante')
  const intervalli = unici.map(giorno => {
    const { startOfDay, endOfDay } = intervalloGiornoRoma(giorno)
    const fineEsclusiva = new Date(Date.parse(endOfDay) + 1).toISOString()
    return `and(creato_il.gte.${startOfDay},creato_il.lt.${fineEsclusiva})`
  })
  const elenco = unici.join(',')
  const rami: string[] = []
  const condizioniLegacy: string[] = []
  if (disponibili.giornoCompetenza !== false) {
    rami.push(`giorno_competenza.in.(${elenco})`)
    condizioniLegacy.push('giorno_competenza.is.null')
  }
  if (disponibili.politicaOperazione !== false) {
    const giornoPolitica = `politica_operazione->>giornoCompetenza.in.(${elenco})`
    rami.push(condizioniLegacy.length ? `and(${[...condizioniLegacy, giornoPolitica].join(',')})` : giornoPolitica)
    condizioniLegacy.push('politica_operazione.is.null')
  }
  rami.push(condizioniLegacy.length ? `and(${[...condizioniLegacy, `or(${intervalli.join(',')})`].join(',')})` : `or(${intervalli.join(',')})`)
  return rami.join(',')
}

export function filtraNotifichePerGiorni<T extends { or: (filtro: string) => T }>(query: T, giorni: readonly string[]): T {
  return query.or(filtroGiornatePending(giorni))
}

/** La presa scrive push_inviata_il prima dell'invio; solo la lease NULL indica un invio concluso. */
export function filtroStatoRitiroStorico(leaseDisponibile = true): string {
  return leaseDisponibile ? 'push_inviata_il.is.null,push_presa_scade_il.not.is.null' : 'push_inviata_il.is.null'
}

/** Un solo OR esterno mantiene in AND il giorno del fatto e lo stato ritirabile. */
export function filtroRitiroStoricoPending(
  giorni: readonly string[],
  disponibili: Parameters<typeof filtroGiornatePending>[1] = {},
  leaseDisponibile = true,
): string {
  return `and(or(${filtroGiornatePending(giorni, disponibili)}),or(${filtroStatoRitiroStorico(leaseDisponibile)}))`
}
