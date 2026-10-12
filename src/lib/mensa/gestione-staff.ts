import type { AppRole } from '@/lib/auth/predicati-ruolo'

/**
 * Chi gestisce le prenotazioni mensa di QUALUNQUE bambino della propria sede, a
 * qualunque ora e anche nei giorni passati (la telefonata del genitore dopo
 * l'orario limite). È la lista che `mensa/prenotazioni/route.ts` esenta dal cutoff
 * e dal blocco del saldo: vive qui perché un `route.ts` di Next non può esportare
 * altro che i metodi HTTP, e l'interfaccia deve mostrare i pulsanti agli STESSI
 * ruoli a cui il server poi dice sì.
 */
export const RUOLI_GESTIONE_MENSA: readonly AppRole[] = ['admin', 'coordinator', 'segreteria']

export function gestisceMensa(ruolo: string | null | undefined): boolean {
  return !!ruolo && (RUOLI_GESTIONE_MENSA as readonly string[]).includes(ruolo)
}

export interface IscrittoMensa { id: string; nome: string; cognome: string; classe_sezione?: string | null }
export interface NonPrenotato { id: string; nome: string }

/**
 * Gli iscritti NON prenotati, per classe e in ordine di nome. La classe si chiama
 * come nel Report cucina (`classe_sezione ?? '—'`), così le due liste si affiancano.
 */
export function nonPrenotatiPerClasse(
  iscritti: readonly IscrittoMensa[],
  prenotatiIds: ReadonlySet<string>,
): Map<string, NonPrenotato[]> {
  const perClasse = new Map<string, NonPrenotato[]>()
  for (const a of iscritti) {
    if (prenotatiIds.has(a.id)) continue
    const classe = a.classe_sezione ?? '—'
    const elenco = perClasse.get(classe) ?? []
    elenco.push({ id: a.id, nome: `${a.nome} ${a.cognome}`.trim() })
    perClasse.set(classe, elenco)
  }
  for (const elenco of perClasse.values()) elenco.sort((x, y) => x.nome.localeCompare(y.nome))
  return perClasse
}
