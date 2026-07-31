import { NextResponse } from 'next/server'
import { logEvento } from '@/lib/logging/logger'

// =============================================================================
// La sede CHIESTA dal client (`?scuola_id=`), ristretta a quelle in scope.
//
// PERCHÉ ESISTE (R70, audit globale multi-sede del 2026-07-31). Le pagine
// Armadietto e Diario hanno un selettore di sede, ma le chiamate dati mandavano
// solo `classe_sezione=<nome>`: la sede scelta non viaggiava mai, e due delle
// route interrogate (`locker/inventory`, `diary/students`) risolvevano i plessi
// con `scuoleDiUtente`, che non legge nemmeno il cookie. Il selettore era
// del tutto inerte. Con tre sedi il nome-classe non è più una chiave («2 ANNI»
// esiste ad Aversa e a Cesa), quindi «quale sede» è un'informazione che il
// client deve poter dichiarare.
//
// FAIL-CLOSED. Una sede chiesta e NON accessibile è un 403, non un elenco
// allargato e non un silenzioso «allora eccoti tutto»: è la stessa regola di
// `resolveScuoleAttive` sul cookie manomesso. E il diniego si logga, perché
// «qualcuno ha chiesto una sede che non è sua» è un segnale di sicurezza.
//
// Nessun dato di minori nel log: solo uuid utente, ruolo e conteggi.
// =============================================================================

export interface EsitoSedeRichiesta {
  /** I plessi su cui filtrare. Presente solo se non c'è `response`. */
  plessi?: string[]
  /** 403 pronta: la sede chiesta non è fra quelle accessibili. */
  response?: NextResponse
}

export function restringiASedeRichiesta(
  plessi: string[],
  richiesta: string | null | undefined,
  contesto: { azione: string; utente: string; ruolo: string },
): EsitoSedeRichiesta {
  if (!richiesta) return { plessi }
  if (!plessi.includes(richiesta)) {
    logEvento('auth', 'warn', {
      tipo: 'sede-richiesta-fuori-scope',
      azione: contesto.azione,
      utente: contesto.utente,
      ruolo: contesto.ruolo,
      accessibili: plessi.length,
    })
    return { response: NextResponse.json({ error: 'Sede non accessibile' }, { status: 403 }) }
  }
  return { plessi: [richiesta] }
}
