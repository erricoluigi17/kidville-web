import { opzioniUtili } from '@/lib/ui/opzioni-filtro'
import type { OpzioneFiltro } from '@/lib/ui/filtri/tipi'

/**
 * LE SEDI FRA CUI SCEGLIERE IN UN FILTRO **SERVER**.
 *
 * ⚠️ NON si derivano dai dati, e su un elenco paginato è la differenza fra un
 * filtro e una bugia. `opzioniDerivate` costruisce le voci dalle RIGHE che ci
 * sono — ed è la scelta giusta per una lista che sta tutta in memoria, dove una
 * voce senza righe è una scelta che non porta niente. Qui le righe in memoria
 * sono le prime cinquanta su quattrocento: un plesso su cui non si è candidato
 * nessuno di recente non comparirebbe nel menu proprio mentre lo si cerca, e chi
 * guarda concluderebbe che quella sede non ha candidature.
 *
 * Perciò le voci sono le sedi ATTIVE — quelle su cui chi guarda ha titolo adesso
 * — intersecate con l'anagrafica dei plessi per averne il nome. `opzioniUtili`
 * toglie il controllo quando la scelta è una sola: con un plesso solo il menu
 * esiste, occupa la barra, entra nel conteggio della pastiglia «Filtri» e non
 * può cambiare niente.
 *
 * ⚠️ E NON C'È NESSUN CONTEGGIO accanto al nome, di proposito: «Aversa (12)» su
 * un elenco paginato sarebbe il numero delle righe CARICATE di Aversa, cioè
 * esattamente il genere di numero che questo lavoro esiste per togliere.
 */
export function opzioniSedeAttive(
  sedi: readonly { id: string; nome: string }[],
  attive: readonly string[],
): readonly OpzioneFiltro[] {
  const dentro = new Set(attive)
  return opzioniUtili(
    sedi
      .filter((s) => dentro.has(s.id))
      .map((s): OpzioneFiltro => ({ valore: s.id, etichetta: s.nome }))
      .sort((a, b) => a.etichetta.localeCompare(b.etichetta, 'it')),
  )
}
