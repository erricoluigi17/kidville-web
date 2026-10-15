import { filtroGiornatePending, filtroRitiroStoricoPending } from '@/lib/notifiche/giornate-pending'
import { logEvento } from '@/lib/logging/logger'

interface RisultatoRitiro {
  error: { code?: string; message?: string } | null
}
interface QueryRitiro<T extends RisultatoRitiro> extends PromiseLike<T> {
  or(filtro: string): QueryRitiro<T>
  is(colonna: 'push_inviata_il', valore: null): QueryRitiro<T>
}

/** Ricostruisce la query a ogni retry: nessuna perdita dei filtri di entità o destinatario. */
export async function eseguiRitiroGiornate<T extends RisultatoRitiro>(costruisci: () => QueryRitiro<T>, opts: {
  giorni: readonly string[]
  storica: boolean
  operazione: string
}): Promise<T> {
  const disponibili = { giornoCompetenza: true, politicaOperazione: true }
  let leaseDisponibile = true
  const esegui = () => {
    const query = costruisci()
    return opts.storica
      ? query.or(filtroRitiroStoricoPending(opts.giorni, disponibili, leaseDisponibile))
      : query.is('push_inviata_il', null).or(filtroGiornatePending(opts.giorni, disponibili))
  }
  let risultato = await esegui()
  for (let n = 0; risultato.error && n < 3; n += 1) {
    if (!['42703', 'PGRST204'].includes(risultato.error.code ?? '')) break
    const colonna = /\b(giorno_competenza|politica_operazione|push_presa_scade_il)\b/.exec(risultato.error.message ?? '')?.[1]
    if (colonna === 'push_presa_scade_il' && opts.storica && leaseDisponibile) leaseDisponibile = false
    else if (colonna === 'giorno_competenza' && disponibili.giornoCompetenza) disponibili.giornoCompetenza = false
    else if (colonna === 'politica_operazione' && disponibili.politicaOperazione) disponibili.politicaOperazione = false
    else break
    logEvento('notifica', 'warn', { operazione: opts.operazione, esito: 'ritiro-schema-precedente' }, risultato.error)
    risultato = await esegui()
  }
  return risultato
}
