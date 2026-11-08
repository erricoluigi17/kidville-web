import { dataCivile } from '@/i18n/config'
import { annoDelGiorno, giornoValido, type Calendario } from '@/lib/anno-scolastico'

/**
 * A QUALE QUADRIMESTRE (PERIODO DI SCRUTINIO) APPARTIENE UNA DATA — la parte PURA.
 *
 * Importabile anche dal browser (la UI della data dell'interrogazione mostra il
 * quadrimestre prima di salvare): per questo qui dentro non c'è il logger né il
 * client Supabase, e gli import sono `@/i18n/config` e il modulo puro dell'anno (`@/lib/anno-scolastico`). Le letture dal database e il
 * log stanno in `quadrimestre.ts`.
 *
 * ⚠️ LA REGOLA DI COPERTURA HA DUE FORMULAZIONI, E DEVONO RESTARE UGUALI. Questa e la
 * funzione SQL `primaria_ricalcola_periodi` (migrazione 20261104173158_voti_periodo_id):
 *
 *  · il giorno di una riga è `data_evento`; se manca, il giorno di ROMA di `creato_il`
 *    (alle 23:30 UTC del 31 gennaio a Roma è già il 1° febbraio: secondo quadrimestre);
 *  · copre quel giorno un periodo della sede con ENTRAMBE le date, estremi inclusi.
 *    Un periodo con una sola data non copre niente;
 *  · `attivo` NON entra nella copertura: un periodo archiviato ha `attivo = false` ma le
 *    sue date valgono ancora per i voti di quegli anni;
 *  · se più periodi coprono lo stesso giorno vince `ordine` più basso, poi `data_inizio`,
 *    poi `id`: il risultato non dipende dall'ordine in cui le righe sono state lette.
 *
 * Se cambi una delle due, cambia anche l'altra: un voto scritto dal server con un periodo
 * e ricalcolato dal database con un altro sarebbe un voto che si congela allo scrutinio
 * sbagliato.
 */

export interface PeriodoScrutinio {
  id: string
  scuola_id: string
  anno_scolastico: string
  nome: string
  ordine: number
  data_inizio: string | null
  data_fine: string | null
  attivo: boolean
}

/** Le colonne di `scrutinio_periodi` che servono a decidere la copertura. */
export const COLONNE_PERIODO = 'id, scuola_id, anno_scolastico, nome, ordine, data_inizio, data_fine, attivo'

/** Il giorno civile di Roma (`YYYY-MM-DD`) di un istante ISO. `''` se assente o non valido. */
export function giornoDiRoma(istante: string | null | undefined): string {
  if (!istante) return ''
  const d = new Date(istante)
  if (Number.isNaN(d.getTime())) return ''
  return dataCivile(d)
}

/** Il giorno a cui appartiene una riga: `data_evento`, altrimenti il giorno di Roma di `creato_il`. */
export function dataDiCompetenza(riga: { data_evento?: string | null; creato_il?: string | null }): string {
  return riga.data_evento || giornoDiRoma(riga.creato_il)
}

function istanteMs(creatoIl: string | null | undefined): number {
  const ms = creatoIl ? Date.parse(creatoIl) : Number.NaN
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms
}

/**
 * Dal più recente al più vecchio: prima il giorno di competenza, poi l'istante di
 * creazione. Non muta l'array ricevuto. A parità di entrambi l'ordine di arrivo resta.
 */
export function ordinaPerCompetenza<T extends { data_evento?: string | null; creato_il?: string | null }>(
  righe: readonly T[],
): T[] {
  return [...righe].sort((a, b) => {
    const da = dataDiCompetenza(a)
    const db = dataDiCompetenza(b)
    if (da !== db) return da < db ? 1 : -1
    const ca = istanteMs(a.creato_il)
    const cb = istanteMs(b.creato_il)
    return ca === cb ? 0 : ca < cb ? 1 : -1
  })
}

/**
 * Configurazione mancante per l'anno: fra i periodi ATTIVI di quell'anno non ce n'è
 * nessuno, oppure ce n'è uno a cui manca una data.
 */
export function dateMancantiPerAnno(periodi: readonly PeriodoScrutinio[], anno: string): boolean {
  const attivi = periodi.filter((p) => p.attivo && p.anno_scolastico === anno)
  return attivi.length === 0 || attivi.some((p) => !p.data_inizio || !p.data_fine)
}

export interface EsitoPeriodo {
  /** Il periodo che vince lo spareggio; `null` se nessuno copre il giorno. */
  periodoId: string | null
  /** TUTTI i periodi che coprono il giorno, nell'ordine dello spareggio. */
  coprenti: string[]
  /** `true` solo se nessuno copre il giorno E la configurazione dell'anno è incompleta. */
  dateMancanti: boolean
}

function perSpareggio(a: PeriodoScrutinio, b: PeriodoScrutinio): number {
  if (a.ordine !== b.ordine) return a.ordine - b.ordine
  const ia = a.data_inizio ?? ''
  const ib = b.data_inizio ?? ''
  if (ia !== ib) return ia < ib ? -1 : 1
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1
}

/**
 * Quale periodo copre `data` (`YYYY-MM-DD`). Una stringa che non è un giorno (nemmeno `2026-13-01`, che
 * ha la forma giusta) non appartiene a nessun periodo e non è nemmeno un guasto di configurazione.
 *
 * L'anno in cui cercare la configurazione lo decide il modulo dell'anno: il calendario della sede se c'è
 * (`calendario`), altrimenti il predefinito (soglia al 1° settembre). La sua etichetta (`2026/2027`) ha la
 * stessa forma di `scrutinio_periodi.anno_scolastico`.
 */
export function periodoPerData(
  periodi: readonly PeriodoScrutinio[],
  data: string,
  calendario?: Calendario | null,
): EsitoPeriodo {
  if (!giornoValido(data)) return { periodoId: null, coprenti: [], dateMancanti: false }
  const coprenti = periodi
    .filter((p) => p.data_inizio && p.data_fine && p.data_inizio <= data && data <= p.data_fine)
    .sort(perSpareggio)
    .map((p) => p.id)
  return {
    periodoId: coprenti[0] ?? null,
    coprenti,
    dateMancanti: coprenti.length === 0 && dateMancantiPerAnno(periodi, annoDelGiorno(data, calendario ?? null).etichetta),
  }
}

/**
 * L'id del periodo fra `altri` che condivide almeno un giorno con `candidato` (estremi
 * inclusi), oppure `null`. Salta sé stesso (stesso `id`) e i periodi senza entrambe le
 * date, che non coprono niente. Come la copertura, non guarda `attivo`. Se ce n'è più
 * d'uno risponde il primo nell'ordine dello spareggio, così la risposta è stabile.
 *
 * Chi chiama passa i periodi della stessa sede, di OGNI anno scolastico, non solo quelli
 * dell'anno del candidato (la route admin lo fa apposta): la copertura di un giorno
 * (`periodoPerData` e il ricalcolo SQL) sceglie il periodo per sede e date, senza guardare
 * l'anno, quindi un periodo salvato con l'anno sbagliato ruberebbe i voti a un altro. Due
 * anni scolastici veri non condividono giorni, e il candidato non porta con sé l'anno.
 */
export function sovrapposto(
  candidato: { id?: string; data_inizio: string; data_fine: string },
  altri: readonly PeriodoScrutinio[],
): string | null {
  const trovati = altri
    .filter(
      (p) =>
        p.id !== candidato.id &&
        p.data_inizio &&
        p.data_fine &&
        p.data_inizio <= candidato.data_fine &&
        candidato.data_inizio <= p.data_fine,
    )
    .sort(perSpareggio)
  return trovati[0]?.id ?? null
}
