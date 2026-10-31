/**
 * CRM DELLA SEGRETERIA · I CONTATTI NORMALIZZATI.
 *
 * Una famiglia che richiama dopo un mese lascia lo stesso numero scritto in un altro modo:
 * `+39 333 000 0001`, `0039 333-0000001`, `333 0000001`. Per riconoscerla (e non aprirle una seconda
 * scheda) si confrontano le forme NORMALIZZATE, salvate in `crm_schede.telefoni_norm` / `email_norm`
 * con un indice GIN. Funzioni pure: niente rete, niente database, niente dati nei log.
 */

/**
 * Solo cifre → via un `00` iniziale → via un `39` iniziale se restano più di 10 cifre → se le cifre
 * sono almeno 9, le ultime 10; altrimenti `null`. Il fisso (`081…`) resta com'è.
 *
 * ⚠️ «Le ultime 10» vale anche per un numero estero: due numeri di paesi diversi con le stesse ultime
 * dieci cifre diventano la stessa stringa. È un compromesso voluto (meglio un falso «sembra la stessa
 * famiglia», che la segreteria vede e smentisce, che una famiglia doppia che nessuno vede).
 */
export function normalizzaTelefono(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  let cifre = raw.replace(/\D/g, '')
  if (cifre.startsWith('00')) cifre = cifre.slice(2)
  if (cifre.length > 10 && cifre.startsWith('39')) cifre = cifre.slice(2)
  if (cifre.length < 9) return null
  return cifre.slice(-10)
}

/** Minuscolo e senza spazi ai lati; senza chiocciola (o con spazi dentro) è `null`. */
export function normalizzaEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const pulita = raw.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+$/.test(pulita) ? pulita : null
}

/** Le due liste normalizzate di una scheda: senza doppioni, senza `null`, nell'ordine di arrivo. */
export function contattiNormalizzati(i: {
  telefoni: (string | null | undefined)[]
  email: (string | null | undefined)[]
}): { telefoni_norm: string[]; email_norm: string[] } {
  const unici = (valori: (string | null)[]): string[] => [...new Set(valori.filter((v): v is string => v !== null))]
  return {
    telefoni_norm: unici(i.telefoni.map(normalizzaTelefono)),
    email_norm: unici(i.email.map(normalizzaEmail)),
  }
}
