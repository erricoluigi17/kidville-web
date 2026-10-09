// =============================================================================
// LE CHIAVI CONDIVISE CON UN DOPPIONE RENDONO L'OBLIO PARZIALE (2026-10-09).
//
// `anonimizzaAlunno` e `anonimizzaParent` NON usano il codice fiscale o il
// documento per ripulire domande d'iscrizione, bonifici e cassa quando quella
// chiave è anche di un'altra persona viva — un doppione, un genitore che porta il
// codice del figlio, la voce di un altro bambino nella domanda: cercarla
// distruggerebbe i dati dell'altra persona. Lo dicono in `chiaviCondiviseEscluse`. Ma i dati
// agganciati a quella chiave RESTANO IN CHIARO, e un oblio che li lascia non si
// può chiamare «eseguito».
//
// Le due route dell'oblio (`admin/gdpr/erase`, `admin/gdpr/richieste`) sommano
// qui le chiavi escluse del bambino e dei genitori, e con un totale maggiore di
// zero scrivono `oblio-parziale` con il motivo. La regola vive in un posto solo:
// due copie divergerebbero in silenzio, come è già successo all'oblio.
//
// ⚠️ I NOMI. Nell'esito salvato e nell'audit il conteggio si chiama
// `chiavi_condivise_escluse`: un nome che contiene `codice_fiscale` o `documento`
// verrebbe azzerato dalla riduzione dell'audit (`@/lib/audit/riassunto`).
// =============================================================================

/** Il motivo scritto nell'esito e nell'audit. Costante: nessun dato personale. */
export const MOTIVO_CHIAVI_CONDIVISE = 'chiave condivisa con un’altra scheda: risolvere prima il doppione'

/**
 * La forma di `chiaviCondiviseEscluse`, letta come FACOLTATIVA. Oggi la restituiscono
 * sia `anonimizzaAlunno` sia `anonimizzaParent` (dal 2026-10-09); resta facoltativa
 * perché un esito senza il campo — un finto di test, un esito salvato prima — vale zero,
 * non un errore.
 */
export interface ConChiaviCondivise {
  chiaviCondiviseEscluse?: { codiceFiscale?: unknown; documento?: unknown } | null
}

function numero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** Quante chiavi di ricerca sono rimaste inutilizzate, sommate su tutti gli esiti dati. */
export function contaChiaviCondivise(esiti: readonly (ConChiaviCondivise | null | undefined)[]): number {
  let n = 0
  for (const e of esiti) {
    const c = e?.chiaviCondiviseEscluse
    if (!c || typeof c !== 'object') continue
    n += numero(c.codiceFiscale) + numero(c.documento)
  }
  return n
}
