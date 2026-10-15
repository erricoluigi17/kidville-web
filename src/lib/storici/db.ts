import { logEvento } from '@/lib/logging/logger'

export class ErroreStorico extends Error {
  constructor(public readonly stato: number, public readonly codice: string, messaggio: string) { super(messaggio) }
}
export function erroreQueryStorico(operazione: string, error: unknown): never {
  const codice = (error as { code?: string })?.code
  logEvento('registro', 'error', { operazione: `storici/${operazione}`, esito: 'lettura-fallita' }, error)
  if (['40001', '23P01'].includes(codice ?? '')) throw new ErroreStorico(409, 'STORICO_VERSIONE_CAMBIATA', 'I dati sono cambiati o il periodo si sovrappone a un’altra appartenenza. Ricarica prima di correggerli.')
  const assente = ['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205'].includes(codice ?? '')
  throw new ErroreStorico(assente ? 503 : 500, assente ? 'STORICI_NON_DISPONIBILI' : 'LETTURA_FALLITA', assente ? 'La struttura degli storici non è ancora disponibile su questo ambiente.' : 'Lettura dello storico non riuscita.')
}

/** Il costruttore si richiama a ogni pagina: non si riutilizza una query mutabile. */
export async function leggiTutte<T>(query: (dal: number, al: number) => PromiseLike<{ data: unknown; error: unknown }>, operazione: string): Promise<T[]> {
  const result: T[] = []
  const passo = 500
  for (let offset = 0; ; offset += passo) {
    const { data, error } = await query(offset, offset + passo - 1)
    if (error) erroreQueryStorico(operazione, error)
    if (!Array.isArray(data)) throw new ErroreStorico(500, 'LETTURA_INCOMPLETA', 'La sorgente non ha restituito un elenco valido.')
    result.push(...data as T[])
    if (data.length < passo) return result
  }
}
