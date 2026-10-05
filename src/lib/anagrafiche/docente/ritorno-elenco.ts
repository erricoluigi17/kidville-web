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
 * torna all'elenco senza filtri, con un solo `warn` per caricamento della pagina (il flag vive nel modulo).
 */

const CHIAVE = 'kv-teacher-alunni-ritorno'
const LUNGHEZZA_MASSIMA = 2000

/**
 * Il parametro della ricerca per nome: è il campo `maiNellUrl` dell'elenco
 * (`filtri-alunni.ts`), e qui si toglie dall'appunto. Un nome solo, in un posto solo.
 */
export const PARAMETRO_RICERCA_ALUNNI = 'q'

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
  if (typeof search !== 'string') return ''
  const parametri = new URLSearchParams(search)
  parametri.delete(PARAMETRO_RICERCA_ALUNNI)
  const pulita = parametri.toString()
  // la lunghezza si misura DOPO aver tolto la ricerca: un nome lungo non fa perdere i filtri
  if (pulita === '' || pulita.length > LUNGHEZZA_MASSIMA) return ''
  return `?${pulita}`
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
