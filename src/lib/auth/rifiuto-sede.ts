import { NextResponse } from 'next/server'
import it from '../../../messages/it/shared.json'
import { CODICI_ERRORE, type CodiceErrore } from '@/lib/ui/esito-fetch'

/**
 * I DUE DINIEGHI DI SEDE, detti in un modo solo.
 *
 * Fino al 2026-08-01 la stessa risposta era scritta a mano in venti punti, e
 * diceva venti volte cose diverse: «Sede non accessibile» (14 volte), «Sede non
 * consentita» (2), «Specificare la sede (scuola_id) per questa operazione»,
 * «Specificare la sede (scuola_id)», «Specificare la sede (scuola_id o
 * sectionId): il nome della classe non la identifica», «Specificare la sede: più
 * classi con questo nome (usare section_id)». Un solo rifiuto, sei frasi — tre
 * delle quali mostravano a una segretaria il nome di una colonna del database.
 *
 * E tutte e sei erano italiane cablate nel server, che è il difetto trovato dal
 * collaudo del 2026-07-31 (localizzazione F1 e F2): il testo nasce dove il
 * locale non esiste, quindi arriva così com'è anche a `<html lang="en">`.
 *
 * Perciò qui si costruisce la risposta, e porta DUE cose:
 *  · `codice` — stabile, non tradotto, non mostrato: lo traduce il client
 *    (`messaggioErrore`, `src/lib/ui/esito-fetch.ts`) nella lingua che sta
 *    guardando l'utente;
 *  · `error` — la prosa, presa dal catalogo ITALIANO. Non è una duplicazione:
 *    è la STESSA stringa che vede un utente italiano, quindi le due strade non
 *    possono divergere. Resta perché i client che non traducono il codice — e
 *    perché per ora sono quasi tutti — devono comunque leggere un motivo.
 *
 * Lo STATO è legato al codice, non al chiamante, ed è l'altra metà della
 * regolarità: **400** è «non mi hai detto dove» (l'operatore deve scegliere),
 * **403** è «mi hai detto una sede che non è tua» — un segnale di sicurezza. Due
 * cose diverse che, mescolate, rendono illeggibile il contatore dell'una e
 * dell'altra.
 *
 * NON logga: il log lo fa chi decide, ed è l'unico a sapere `tipo`, sede
 * richiesta e conteggi (vedi `resolveScuolaScrittura`). Una funzione che
 * costruisce risposte e logga produrrebbe righe senza contesto, cioè rumore.
 */

const STATO: Record<CodiceErrore, number> = {
  SEDE_NON_ACCESSIBILE: 403,
  SEDE_DA_SPECIFICARE: 400,
}

const CATALOGO_IT = it as Record<string, string>

export function rifiutoSede(codice: CodiceErrore): NextResponse {
  return NextResponse.json(
    { error: CATALOGO_IT[CODICI_ERRORE[codice]], codice },
    { status: STATO[codice] },
  )
}
