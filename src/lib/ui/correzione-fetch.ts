import { eCorrezionePossibile, etichettaDelRifiuto, type Correzione } from '@/lib/anno/correzione'
import { logClient, nomeErrore } from '@/lib/logging/client'

/**
 * Il lato del BROWSER della correzione di un anno chiuso (PR 4.9, compito 4.9.3).
 *
 * `InviaConCorrezione` è ciò che `useCorrezioneAnno` espone: prende una funzione che sa mandare la richiesta (con o senza
 * `correzione`) e la manda una volta; se la risposta è un 409 `ANNO_CHIUSO` con `correzione_possibile`, chiede il motivo e
 * la rimanda con `correzione: { motivo }` (il dialogo riceve l'`etichetta` dell'anno scritta dal server). Se la persona annulla, restituisce la PRIMA risposta (il 409): chi chiama la mostra
 * come ogni altro rifiuto. Mai una seconda richiesta senza conferma.
 */
export type InviaConCorrezione = (
  invia: (correzione?: Correzione) => Promise<Response>,
) => Promise<Response>

/**
 * La stessa richiesta con `correzione` dentro il corpo JSON. Un corpo che non è un testo JSON (un `FormData`, niente) resta com'è:
 * quella richiesta non sa portare la correzione, e il server non avrà offerto il dialogo.
 */
export function conCorrezioneNelCorpo(init: RequestInit, correzione: Correzione): RequestInit {
  if (typeof init.body !== 'string') return init
  try {
    const corpo: unknown = JSON.parse(init.body)
    if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) return init
    return { ...init, body: JSON.stringify({ ...(corpo as Record<string, unknown>), correzione }) }
  } catch (err) {
    // Non è JSON: la richiesta parte com'era, senza la correzione (quindi il server, se rifiuta, rifiuta come prima). Il client
    // spedisce solo `warn` ed `error` (non c'è `info`): è l'avviso più basso. Nel log solo il NOME dell'errore: né il corpo né il motivo.
    logClient({ livello: 'warn', evento: 'fetch', messaggio: `correzione-non-aggiunta: corpo non JSON (${nomeErrore(err)})` })
    return init
  }
}

/**
 * Manda `invia` e, se serve, la rimanda con la correzione. Il motivo lo dà `chiediMotivo` (il dialogo); `null` = annullato.
 * Separata dall'hook perché si prova senza React.
 */
export async function inviaChiedendoLaCorrezione(
  invia: (correzione?: Correzione) => Promise<Response>,
  chiediMotivo: (etichetta?: string) => Promise<string | null>,
): Promise<Response> {
  const prima = await invia()
  if (prima.status !== 409) return prima
  let corpo: unknown
  try {
    corpo = await prima.clone().json()
  } catch (err) {
    // Un 409 che non è JSON (una pagina d'errore di un proxy, un corpo troncato) non può offrire la correzione: si mostra com'è.
    // Livello `warn`, il più basso del client; solo il nome dell'errore, mai il corpo.
    logClient({ livello: 'warn', evento: 'fetch', messaggio: `correzione-non-offerta: 409 con corpo illeggibile (${nomeErrore(err)})`, stato: prima.status })
    return prima
  }
  if (!eCorrezionePossibile(prima.status, corpo)) return prima
  // L'anno che si sta correggendo lo dice il server (`etichetta`, es. «2025/26»): la pagina può non saperlo (votazioni, competenze).
  const motivo = await chiediMotivo(etichettaDelRifiuto(corpo))
  if (motivo === null) return prima
  return invia({ motivo })
}
