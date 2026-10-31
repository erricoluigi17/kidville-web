import type { OpzioneFiltro, Traduttore } from '@/lib/ui/filtri/tipi'

/**
 * CRM della segreteria · le parole dei vocabolari, risolte nella lingua della pagina.
 *
 * Le etichette di esiti, origini, motivi, anni e tipi di evento stanno TUTTE in `crmShell`
 * (`messages/{it,en}/crmShell.json`, un gruppo per vocabolario): una parola, un posto. Le tre schermate
 * delle schede le leggono da qui invece di riscriverle — «Perso» nel filtro e «Perso» nel badge sono
 * la stessa chiave, e non possono divergere.
 *
 * Il test `crm-shell.test.tsx` misura che ogni valore di ogni vocabolario abbia la sua etichetta in
 * italiano e in inglese: una chiave costruita da un valore (`esiti.perso`) trova sempre qualcosa.
 *
 * ⚠️ Sono STRINGHE già tradotte, come tutto il resto dei descrittori dei filtri: nessun componente
 * qui dentro conosce `useTranslations`.
 */

export type GruppoVocabolario = 'esiti' | 'origini' | 'motiviPerdita' | 'anniIngresso' | 'statiAppuntamento' | 'tipiEvento'

/** L'etichetta di UN valore. `tc` è `useTranslations('crmShell')`. */
export function etichetta(tc: Traduttore, gruppo: GruppoVocabolario, valore: string): string {
  return tc(`${gruppo}.${valore}`)
}

/** Le etichette di tutti i valori di un vocabolario, per chiave. */
export function etichette<V extends string>(tc: Traduttore, gruppo: GruppoVocabolario, valori: readonly V[]): Record<V, string> {
  const mappa = {} as Record<V, string>
  for (const v of valori) mappa[v] = etichetta(tc, gruppo, v)
  return mappa
}

/** Le voci di una tendina o di una fila di pastiglie, col tono dove ce n'è uno. */
export function voci<V extends string>(
  tc: Traduttore,
  gruppo: GruppoVocabolario,
  valori: readonly V[],
  toni?: Partial<Record<V, OpzioneFiltro['tono']>>,
): OpzioneFiltro[] {
  return valori.map((v) => ({ valore: v, etichetta: etichetta(tc, gruppo, v), tono: toni?.[v] }))
}
