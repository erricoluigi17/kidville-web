import { logClient, nomeErrore } from '@/lib/logging/client'

import type { TrasportoVideo } from './interfaccia'
import { trasportoTus } from './tus'

/**
 * QUALE TRASPORTO USARE — e perché oggi la risposta è sempre la stessa.
 *
 * `put-nativo` esce solo se un trasporto di quel nome è stato REGISTRATO e dice di essere
 * disponibile su questo dispositivo. La registrazione è il gesto con cui la PR 3 (app 1.2) aggancia
 * il proprio trasporto; in questa PR nessuno la fa, e la risposta è `trasportoTus`. Non c'è un
 * ramo nativo mezzo fatto: c'è un registro vuoto, che si prova da solo.
 */

const registrati = new Set<TrasportoVideo>()

/**
 * Registra un trasporto alternativo. Restituisce la funzione che lo toglie (serve ai test, e a chi
 * deve ritirare il trasporto nativo se il plugin non risponde più).
 */
export function registraTrasporto(trasporto: TrasportoVideo): () => void {
  registrati.add(trasporto)
  return () => {
    registrati.delete(trasporto)
  }
}

/**
 * Il trasporto da dichiarare all'apertura di un video. `put-nativo` solo se un trasporto registrato
 * lo è davvero e `disponibile()` risponde sì; altrimenti il TUS.
 *
 * Un `disponibile()` che lancia vale «no», e lascia una riga: un trasporto nativo che non si sa
 * se c'è non può far partire un caricamento che poi nessuno riprende.
 */
export function scegliTrasporto(): TrasportoVideo {
  for (const candidato of registrati) {
    if (candidato.nome !== 'put-nativo') continue
    try {
      if (candidato.disponibile()) return candidato
    } catch (err) {
      logClient({
        livello: 'warn',
        evento: 'js',
        messaggio: 'video-trasporto-non-verificabile',
        campi: { trasporto: candidato.nome, error_code: nomeErrore(err) },
      })
    }
  }
  return trasportoTus
}
