import { type AppUser, RUOLI_DIREZIONE, haRuolo, haUnRuolo } from './predicati-ruolo'
import { RUOLI_BERSAGLIO_NOTI } from './credenziali-staff'

/* ════════════════════════════════════════════════════════════════════════════
 * CHI PUÒ CAMBIARE COSA NELL'INCARICO DI UN COLLEGA — `PATCH /api/admin/staff`.
 *
 * Quella rotta fa QUATTRO cose sotto un solo pulsante: cambia il **ruolo**, i
 * **gradi**, le **classi assegnate** e la **sede**. Fino al 2026-09-04 erano
 * tutte e quattro riservate alla Direzione, e il titolare ha deciso di aprire
 * alla Segreteria la sola SEDE. «Aprire la PATCH alla Segreteria» sarebbe stato
 * un altro lavoro, e più grande: apriva anche le altre tre.
 *
 * ─── PERCHÉ IL RUOLO RESTA ALLA DIREZIONE ───────────────────────────────────
 *
 * Se la Segreteria potesse cambiare il ruolo di una collega, la promuoverebbe ad
 * `admin` e otterrebbe per via indiretta ciò che `puoRigenerareCredenzialiStaff`
 * le nega: rigenerare le credenziali di un account di Direzione, ricevendone il
 * PDF con la password IN CHIARO. Le due riserve si tengono in piedi a vicenda —
 * togliendo questa, l'altra diventa decorativa.
 *
 * ─── E PERCHÉ ANCHE I GRADI E LE CLASSI ─────────────────────────────────────
 *
 * Non sono anagrafica, sono AUTORIZZAZIONE, e ciascuno apre una porta:
 *
 *  · `utenti.gradi` è metà del gate delle funzioni di grado: `requireFunzione`
 *    (src/lib/auth/require-grado.ts) concede una funzione solo se il grado è fra
 *    i propri E la matrice della sede lo abilita. Aggiungere `primaria` a
 *    qualcuno gli apre registro, valutazioni e scrutini della primaria.
 *  · `utenti_sezioni` decide quali BAMBINI vede un `educator`: `sezioniVisibili`
 *    restituisce le sole sezioni assegnate, e il registro si filtra con quelle.
 *    È il campo che, sbagliato, mostra il diario di un minore a chi non è la sua
 *    maestra.
 *
 * La SEDE è di natura diversa: dice DOVE lavora una persona, non che cosa può
 * fare. E il perimetro di chi la sposta resta comunque doppio — il bersaglio
 * dev'essere già dentro lo scope di chi lo muove (`assertUtenteInScope`) e la
 * destinazione dev'essere fra quelle consentite (`destinazioniConsentite`, che
 * alla Segreteria dà solo le proprie sedi).
 *
 * ─── «CAMBIA DAVVERO» NON È «È NEL CORPO» ───────────────────────────────────
 *
 * La scheda del personale salva il FORM INTERO: manda sempre `ruolo` e
 * `section_ids`, anche quando l'operatore ha toccato solo la tendina della sede.
 * Un predicato che guardasse la PRESENZA della chiave direbbe «stai cambiando il
 * ruolo» a ogni salvataggio, e la Segreteria non riuscirebbe mai a spostare
 * nessuno. Perciò qui arrivano dei BOOLEANI, e a confrontarli col valore attuale
 * pensa il chiamante: qui si decide, non si legge il database.
 *
 * ⚠️ L'unica eccezione è `gradi`, e il chiamante la documenta: quel campo la
 * scheda non lo manda mai, quindi lì la presenza È un atto deliberato.
 *
 * ─── PURO, E IN UN MODULO SUO ───────────────────────────────────────────────
 *
 * Stessa ragione di `credenziali-staff.ts`, che gli sta accanto: 296 file di
 * test sostituiscono `@/lib/auth/require-staff` per intero (`vi.mock(...)`), e un
 * predicato scritto lì dentro verrebbe mockato via insieme all'I/O — cioè
 * verificato finto. Qui dentro: zero I/O, zero `next/*`, zero Supabase.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Che cosa cambierebbe DAVVERO rispetto a ciò che è scritto adesso nel database.
 * Tutti e quattro falsi = un salvataggio che non muove niente, ed è il caso
 * normale quando una scheda rimanda il form intero.
 */
export interface CambiIncarico {
  /** `utenti.scuola_id` diverso da quello attuale: è un TRASFERIMENTO. */
  sede: boolean
  /** `utenti.ruolo` diverso da quello attuale. */
  ruolo: boolean
  /** `utenti.gradi` che il corpo chiede di riscrivere. */
  gradi: boolean
  /** L'insieme delle `utenti_sezioni` chieste è diverso da quello attuale. */
  sezioni: boolean
}

/** Perché è stato negato. Finisce nei log: sono contatori diversi, non sinonimi. */
export type MotivoIncarico =
  /** Il ruolo del bersaglio è nullo, vuoto o non riconosciuto: si nega. */
  | 'bersaglio-sconosciuto'
  /** La Segreteria non tocca l'incarico di un account di Direzione. */
  | 'bersaglio-direzione'
  /** Ruolo, gradi o classi: si cambiano solo dalla Direzione. */
  | 'riservato-direzione'
  /** Chi chiede non è né Direzione né Segreteria. */
  | 'ruolo-non-abilitato'

export type EsitoIncarico =
  | { consentito: true }
  | { consentito: false; motivo: MotivoIncarico }

const nega = (motivo: MotivoIncarico): EsitoIncarico => ({ consentito: false, motivo })

/** Gli account il cui ruolo vale l'intero plesso: solo la Direzione li tocca. */
const BERSAGLIO_DIREZIONE = new Set<string>(RUOLI_DIREZIONE)

/**
 * Può `attore` applicare questi cambi a un membro dello staff con quel ruolo?
 *
 * ⚠️ `attore` è l'`AppUser` INTERO e non la sua stringa di ruolo, e non è un
 * dettaglio di firma: `user.role` è la VESTE indossata adesso, mentre
 * `requireStaff` fa passare sui ruoli REALI (`haUnRuolo`). Una direttrice che
 * sta guardando l'app come genitore ha `role === 'genitore'` — decidere su
 * quella stringa le negherebbe qui ciò che il gate le ha appena concesso.
 * AUTORIZZAZIONE = ruoli reali; PRESENTAZIONE = veste. Vedi `predicati-ruolo.ts`.
 *
 * @param ruoloBersaglio `utenti.ruolo` letto dal DATABASE (`string`, non `AppRole`).
 */
export function puoModificareIncaricoStaff(
  attore: AppUser,
  ruoloBersaglio: string | null | undefined,
  cambi: CambiIncarico,
): EsitoIncarico {
  // Si nega ciò che non si è riusciti a leggere. Una lettura che torna `null` —
  // per assenza o per guasto — non deve mai diventare un permesso. Vale anche
  // per la Direzione: stessa scelta di `puoRigenerareCredenzialiStaff`.
  if (!ruoloBersaglio || !RUOLI_BERSAGLIO_NOTI.has(ruoloBersaglio)) {
    return nega('bersaglio-sconosciuto')
  }

  if (haUnRuolo(attore, RUOLI_DIREZIONE)) return { consentito: true }

  if (haRuolo(attore, 'segreteria')) {
    // L'ordine conta: prima CHI si tocca, poi COSA gli si cambia. `motivo`
    // finisce nei log ed è il modo di contare i tentativi verso un account di
    // Direzione; con l'ordine invertito, un tentativo di promuovere un admin
    // uscirebbe come «campo riservato» e quel contatore perderebbe proprio i
    // casi per cui esiste.
    if (BERSAGLIO_DIREZIONE.has(ruoloBersaglio)) return nega('bersaglio-direzione')
    if (cambi.ruolo || cambi.gradi || cambi.sezioni) return nega('riservato-direzione')
    return { consentito: true }
  }

  // Educator, cuoca, genitore, un ruolo mai visto: non modificano nessun
  // incarico. Il gate di rotta li ferma già prima; questo è il secondo giro.
  return nega('ruolo-non-abilitato')
}
