import { haRuolo, haUnRuolo, RUOLI_DIREZIONE } from '@/lib/auth/predicati-ruolo'
import type { AppUser } from '@/lib/auth/predicati-ruolo'

/**
 * CHI PUÒ eliminare un membro del personale, riportarlo a genitore, o dargli
 * anche il profilo genitore.
 *
 * ⚠️ FUNZIONI PURE, nessun I/O: la sede NON si verifica qui. Il perimetro lo
 * decide il chiamante con `assertUtenteInScope`, ed è la stessa divisione del
 * lavoro di `puoModificareIncaricoStaff`. Qui si risponde a una sola domanda:
 * questo attore può toccare un bersaglio con QUESTO ruolo?
 *
 * ─── LA DECISIONE, E CHI L'HA PRESA ───────────────────────────────────────────
 *
 * Direzione ovunque, Segreteria sulla propria sede. È la scelta del titolare del
 * 2026-09-20, presa contro la raccomandazione dei due progettisti — che
 * volevano `['admin','coordinator']` soltanto, come per l'operazione inversa già
 * in produzione (`admin/staff/collega-profilo-esistente`, che è `admin`/
 * `coordinator` e motiva l'asimmetria nella propria testata).
 *
 * Il contrappeso non sta in un commento, sta nel codice: la Segreteria non tocca
 * un bersaglio di Direzione, non tocca sé stessa, e fuori dalla propria sede non
 * arriva perché `assertUtenteInScope` la ferma prima. Più l'anteprima
 * obbligatoria e la conferma col cognome digitato, che vivono nel pannello.
 */

/** Perché è stato negato. Finisce nei log: sono contatori diversi, non sinonimi. */
export type MotivoPermesso =
  /** Il ruolo del bersaglio è nullo, vuoto o non riconosciuto: si nega. */
  | 'bersaglio-sconosciuto'
  /** Un account di Direzione non si elimina e non si declassa da qui. */
  | 'bersaglio-direzione'
  /** Chi chiede non è né Direzione né Segreteria. */
  | 'ruolo-non-abilitato'
  /** Si sta agendo sul proprio stesso account. */
  | 'se-stessi'

export type EsitoPermesso = { consentito: true } | { consentito: false; motivo: MotivoPermesso }

const nega = (motivo: MotivoPermesso): EsitoPermesso => ({ consentito: false, motivo })

/**
 * I ruoli che un bersaglio può avere perché la decisione sia presa su qualcosa.
 * `genitore` c'è: «riporta a genitore» su chi è già genitore deve poter
 * rispondere «è già così» invece di «non ti è permesso».
 */
const RUOLI_BERSAGLIO_NOTI = new Set<string>([
  'admin',
  'coordinator',
  'segreteria',
  'educator',
  'cuoca',
  'genitore',
])

const BERSAGLIO_DIREZIONE = new Set<string>(RUOLI_DIREZIONE)

/**
 * Può `attore` eliminare, archiviare o declassare questo bersaglio?
 *
 * ⚠️ `attore` è l'`AppUser` INTERO e non la sua stringa di ruolo, per la stessa
 * ragione scritta in `incarico-staff.ts`: `user.role` è la VESTE indossata
 * adesso. Una direttrice che sta guardando l'app come genitore ha
 * `role === 'genitore'`, e decidere su quella stringa le negherebbe qui ciò che
 * `requireStaff` le ha appena concesso. AUTORIZZAZIONE = ruoli reali.
 *
 * ⚠️ L'ORDINE DEI RAMI È PARTE DEL CONTRATTO. «Sé stessi» viene per primo: è
 * l'unico errore senza rimedio in-app — chi si archivia da solo non può più
 * entrare per disfarlo — e va contato a parte anche quando l'attore sarebbe
 * comunque autorizzato.
 */
export function puoEliminareStaff(
  attore: AppUser,
  bersaglioId: string,
  ruoloBersaglio: string | null | undefined,
): EsitoPermesso {
  if (attore.id === bersaglioId) return nega('se-stessi')

  // Si nega ciò che non si è riusciti a leggere: una lettura che torna `null` —
  // per assenza o per guasto — non diventa mai un permesso. Vale anche per la
  // Direzione, come in `puoModificareIncaricoStaff`.
  if (!ruoloBersaglio || !RUOLI_BERSAGLIO_NOTI.has(ruoloBersaglio)) {
    return nega('bersaglio-sconosciuto')
  }

  // ⚠️ Il bersaglio di Direzione è vietato a TUTTI, Direzione compresa, e non è
  // una svista: togliere l'accesso all'unico amministratore è l'unico guasto di
  // questo pannello che non si ripara dal pannello stesso. Al 2026-09-20 gli
  // account di Direzione in produzione sono cinque — quattro `admin` e un
  // `coordinator`. Per loro si passa dal database, dove serve una decisione
  // deliberata e non un clic.
  if (BERSAGLIO_DIREZIONE.has(ruoloBersaglio)) return nega('bersaglio-direzione')

  if (haUnRuolo(attore, RUOLI_DIREZIONE)) return { consentito: true }
  if (haRuolo(attore, 'segreteria')) return { consentito: true }

  // Educator, cuoca, genitore, un ruolo mai visto. Il gate di rotta li ferma già
  // prima: questo è il secondo giro.
  return nega('ruolo-non-abilitato')
}
