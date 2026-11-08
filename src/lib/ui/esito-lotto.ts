import { logClient, nomeErrore } from '@/lib/logging/client'

/**
 * L'esito di una scrittura in lotto di `PATCH /api/admin/students` (assegnazione di classe o di gruppo mensa).
 *
 * La route risponde 200 anche quando qualche riga è rimasta indietro: `updated` conta le righe davvero scritte e
 * `errori` elenca `{ id, codice }` di quelle che no (frequenza non scritta, o scritta ma scheda no). Guardare solo
 * `res.ok` e scrivere «30 assegnati» quando ne sono passati 28 è dire il falso.
 *
 * `rimasti` = gli id da lasciare selezionati: quelli in `errori` e, se la risposta porta `data`, quelli che non vi
 * compaiono. Un corpo illeggibile non decide niente (si ricade sul numero dei selezionati, come prima).
 */
export interface EsitoLotto {
  riusciti: number
  totale: number
  parziale: boolean
  rimasti: Set<string>
}

export function esitoLotto(corpo: unknown, selezionati: ReadonlySet<string>): EsitoLotto {
  const totale = selezionati.size
  const c = (corpo && typeof corpo === 'object' ? corpo : {}) as { updated?: unknown; errori?: unknown; data?: unknown }
  const rimasti = new Set<string>()
  if (Array.isArray(c.errori)) {
    for (const e of c.errori) {
      const id = (e as { id?: unknown } | null)?.id
      if (typeof id === 'string' && selezionati.has(id)) rimasti.add(id)
    }
  }
  if (Array.isArray(c.data)) {
    const scritti = new Set(c.data.map((r) => String((r as { id?: unknown } | null)?.id)))
    for (const id of selezionati) if (!scritti.has(id)) rimasti.add(id)
  }
  const dichiarati = typeof c.updated === 'number' && Number.isFinite(c.updated) ? c.updated : null
  const riusciti = dichiarati ?? (rimasti.size > 0 ? totale - rimasti.size : totale)
  return { riusciti, totale, parziale: riusciti < totale || rimasti.size > 0, rimasti }
}

/**
 * Legge il corpo di una risposta `ok` e ne ricava l'esito. Un corpo non leggibile non è un errore da mostrare (la
 * scrittura è andata, la risposta era 200): si ricade sul numero dei selezionati, lasciando una riga `warn` (mai il
 * contenuto) per capire quando succede.
 */
export async function leggiEsitoLotto(res: Response, selezionati: ReadonlySet<string>): Promise<EsitoLotto> {
  try {
    return esitoLotto(await res.json(), selezionati)
  } catch (err) {
    logClient({ livello: 'warn', evento: 'fetch', messaggio: `esito-lotto-corpo-illeggibile: ${nomeErrore(err)}`, route: '/admin/students' })
    return esitoLotto(null, selezionati)
  }
}
