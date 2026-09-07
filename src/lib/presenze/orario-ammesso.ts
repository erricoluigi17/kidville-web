/**
 * QUALI ORARI HA SENSO REGISTRARE, DATO LO STATO DELL'APPELLO.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ ESISTE. La stessa domanda se la fanno QUATTRO punti:
 *  · il 422 `ORARIO_INCOERENTE` di `attendance/daily:PATCH` (server, entrambi i gradi);
 *  · la riga d'appello 0-6, che decide quali chip d'orario mostrare;
 *  · la riga d'appello della primaria, che fa lo stesso;
 *  · la regola di stato dell'upsert di `primaria/appello:POST`, che azzera gli orari
 *    di un assente.
 *
 * Scritta quattro volte, divergerebbe — e la divergenza qui non è teorica: significa
 * un campo offerto a schermo e rifiutato dal server con un 422 che l'insegnante non
 * può capire né aggirare. È il modo di guasto che questo repo ha già pagato più volte,
 * e la ragione per cui `motivoVisibileA` e `risoluzione.ts` sono nati.
 *
 * LA REGOLA È CAMBIATA IL 2026-09-07, per decisione del titolare. Prima:
 *   entrata → presente | ritardo | uscita_anticipata
 *   uscita  → SOLO uscita_anticipata
 * Cioè un bambino uscito all'orario normale non aveva nessuna uscita registrabile né
 * correggibile. Adesso l'uscita vale per ogni stato in cui il bambino è arrivato.
 *
 * ⚠️ REGISTRARE UN'USCITA SU UN «PRESENTE» NON CAMBIA LO STATO, ed è la cosa che il
 * prossimo lettore si chiederà. Chi esce alle 15:30 all'orario normale resta
 * `presente`: `uscita_anticipata` significa «è uscito PRIMA», che è un giudizio di chi
 * fa l'appello, non una conseguenza dell'orologio. Legare le due cose farebbe
 * comparire «uscita anticipata» su mezza classe ogni pomeriggio.
 *
 * FAIL-CLOSED. Uno stato sconosciuto non ammette niente: offrire un campo che il
 * server rifiuterà è peggio che non offrirlo.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

export interface OrariAmmessi {
    /** L'ora di INGRESSO ha senso per questo stato? */
    entrata: boolean;
    /** L'ora di USCITA ha senso per questo stato? */
    uscita: boolean;
}

const NESSUNO: OrariAmmessi = { entrata: false, uscita: false };
const ENTRAMBI: OrariAmmessi = { entrata: true, uscita: true };

/** Gli stati in cui il bambino È ARRIVATO: per loro entrambi gli orari hanno senso. */
const STATI_PRESENTI: readonly string[] = ['presente', 'ritardo', 'uscita_anticipata'];

export function orariAmmessi(stato: string | null | undefined): OrariAmmessi {
    if (!stato) return NESSUNO;
    // `assente` cade qui: non è mai arrivato, quindi non ha né un'entrata né un'uscita.
    return STATI_PRESENTI.includes(stato) ? ENTRAMBI : NESSUNO;
}
