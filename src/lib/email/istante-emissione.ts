/**
 * L'istante in cui una password è stata generata, scritto per un essere umano.
 *
 * ─── PERCHÉ ESISTE UN MODULO PER UNA RIGA ────────────────────────────────────
 *
 * I generatori dei messaggi sono funzioni PURE: non conoscono fusi orari né
 * locale, e ricevono le date già scritte (`avvenutoIl` nella 12, `inviataIl`
 * nella 11). La formattazione tocca quindi ai chiamanti — che per le credenziali
 * sono **sei**: rigenerazione manuale, rinvio in blocco, approvazione iscrizione,
 * import iscrizioni, inserimento anagrafica, approvazione anagrafica personale.
 *
 * Sei copie della stessa `formattaIstante(new Date(), 'it', { … })` divergono: è
 * già successo in questo repo, e si vede come due famiglie che ricevono la stessa
 * email con due formati di data diversi. Una regola valida per sei strade vive in
 * un posto solo.
 *
 * ⚠️ `formattaIstante` è ancorata a `Europe/Rome`: senza, un server in UTC
 * scriverebbe alle famiglie un'ora che non è quella dell'orologio della sede — e
 * l'ora è precisamente ciò che serve a distinguere la password buona dalle
 * tredici che non lo sono più.
 */
import { formattaIstante } from '@/i18n/config'

export function istanteEmissioneCredenziali(quando: Date = new Date()): string {
    return formattaIstante(quando, 'it', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}
