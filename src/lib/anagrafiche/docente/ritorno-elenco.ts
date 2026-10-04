import { logClient, nomeErrore } from '@/lib/logging/client'

/**
 * LA QUERY DELL'ELENCO, DA RITROVARE TORNANDO DALLA SCHEDA.
 *
 * Il tasto «indietro» del telefono o del browser i filtri li ritrova da solo
 * (`useFiltri` li tiene nell'indirizzo). Il pulsante «Tutti gli alunni» della scheda
 * invece naviga in avanti: senza un appunto, riaprirebbe l'elenco senza filtri.
 *
 * L'appunto sta in `sessionStorage` (la sola scheda del browser, si perde chiudendola)
 * e non contiene MAI la ricerca per nome: `q` si toglie sia salvando sia leggendo.
 * Uno storage che non risponde (navigazione privata, permessi) non rompe niente: si
 * torna all'elenco senza filtri, con un solo `warn` per sessione.
 */

const CHIAVE = 'kv-teacher-alunni-ritorno'
const LUNGHEZZA_MASSIMA = 600

let storageGiaSegnalato = false

function segnalaStorage(operazione: 'lettura' | 'scrittura', e: unknown): void {
  if (storageGiaSegnalato) return
  storageGiaSegnalato = true
  logClient({
    livello: 'warn',
    evento: 'js',
    messaggio: `anagrafica-ritorno-storage-inutilizzabile: ${operazione} (${nomeErrore(e)})`,
    route: '/teacher/alunni',
  })
}

/** Una query d'elenco ripulita: niente ricerca per nome, niente di malformato. */
export function ripulisciRitorno(search: string): string {
  if (typeof search !== 'string' || search.length > LUNGHEZZA_MASSIMA) return ''
  const parametri = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  parametri.delete('q')
  const pulita = parametri.toString()
  return pulita === '' ? '' : `?${pulita}`
}

export function salvaRitornoElenco(search: string): void {
  try {
    window.sessionStorage.setItem(CHIAVE, ripulisciRitorno(search))
  } catch (e) {
    segnalaStorage('scrittura', e)
  }
}

export function leggiRitornoElenco(): string {
  try {
    return ripulisciRitorno(window.sessionStorage.getItem(CHIAVE) ?? '')
  } catch (e) {
    segnalaStorage('lettura', e)
    return ''
  }
}
