// =============================================================================
// LA SCELTA DEI BAMBINI, IN UN POSTO SOLO
//
// I due generatori — rette e categorie — devono tradurre «chi genero» in
// parametri allo stesso modo. Se lo facessero ognuno per conto suo, anteprima e
// conferma potrebbero guardare insiemi diversi: è il difetto che questa parte del
// prodotto ha già pagato due volte, e il commento in cima a `genera-rette/route.ts`
// lo racconta per esteso.
//
// Modulo PURO: nessun React, nessun `next-intl`, nessuna lettura. Si collauda da
// solo, e la regola che contiene non ha bisogno di un browser per essere vera.
// =============================================================================

/** Il minimo che serve per scegliere un bambino: chi è, e in che classe sta. */
export interface AlunnoSceglibile {
  id: string
  nome?: string | null
  cognome?: string | null
  classe_sezione?: string | null
}

export type ModoSelezione = 'tutti' | 'classe' | 'scelti'

export interface SelezioneAlunni {
  modo: ModoSelezione
  /** Vale solo con `modo: 'classe'`. */
  classe: string
  /** Vale solo con `modo: 'scelti'`. */
  ids: readonly string[]
}

export const SELEZIONE_TUTTI: SelezioneAlunni = { modo: 'tutti', classe: '', ids: [] }

/** Le classi presenti fra i candidati, in ordine, senza vuoti né doppioni. */
export function classiDi(alunni: readonly AlunnoSceglibile[]): string[] {
  const viste = new Set<string>()
  for (const a of alunni) {
    const c = (a.classe_sezione ?? '').trim()
    if (c) viste.add(c)
  }
  return [...viste].sort((x, y) => x.localeCompare(y, 'it'))
}

/**
 * Chi verrà generato, dato l'elenco dei CANDIDATI e la selezione.
 *
 * ⚠️ L'elenco di partenza dev'essere quello dell'ANTEPRIMA, non un elenco alunni
 * generico: l'anteprima ha già tolto chi ha la retta a carico di un fratello, chi
 * è iscritto dopo quel mese e chi la retta ce l'ha già. Partendo da un elenco
 * grezzo si potrebbe spuntare un bambino che la funzione poi scarta — e anteprima
 * e conferma tornerebbero a dire numeri diversi.
 */
export function alunniBersaglio(
  alunni: readonly AlunnoSceglibile[],
  sel: SelezioneAlunni,
): AlunnoSceglibile[] {
  if (sel.modo === 'classe') {
    const c = sel.classe.trim()
    return c ? alunni.filter((a) => (a.classe_sezione ?? '').trim() === c) : []
  }
  if (sel.modo === 'scelti') {
    const scelti = new Set(sel.ids)
    return alunni.filter((a) => scelti.has(a.id))
  }
  return [...alunni]
}

/**
 * I parametri da spedire, e sono gli STESSI per l'anteprima e per la conferma.
 *
 * ⚠️ `alunno_ids` ASSENTE, mai un array vuoto, quando si genera per tutti: in SQL
 * `= ANY('{}')` è falso per ogni riga, quindi un array vuoto significherebbe
 * «nessuno» proprio dove si intende «tutti». La RPC ha una guardia che lo rifiuta
 * rumorosamente, e questa funzione fa in modo che non ci arrivi mai.
 */
export function parametriSelezione(
  alunni: readonly AlunnoSceglibile[],
  sel: SelezioneAlunni,
): { alunno_ids?: string[] } {
  if (sel.modo === 'tutti') return {}
  const ids = alunniBersaglio(alunni, sel).map((a) => a.id)
  return ids.length > 0 ? { alunno_ids: ids } : { alunno_ids: [] }
}

/**
 * La selezione è spedibile? «Nessuno scelto» non è una generazione: è un gesto a
 * metà, e mandarlo produrrebbe un 400 dal server invece di una frase a schermo.
 */
export function selezioneVuota(alunni: readonly AlunnoSceglibile[], sel: SelezioneAlunni): boolean {
  return sel.modo !== 'tutti' && alunniBersaglio(alunni, sel).length === 0
}

/** Nome e cognome come si leggono, senza spazi doppi se uno dei due manca. */
export function nomeCompleto(a: AlunnoSceglibile): string {
  return [a.cognome, a.nome].map((x) => (x ?? '').trim()).filter(Boolean).join(' ')
}
