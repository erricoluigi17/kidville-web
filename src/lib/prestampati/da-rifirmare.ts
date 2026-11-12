/**
 * I MODULI DA RIFIRMARE — il calcolo, puro (compito 4.4.9).
 *
 * Risposta 10 della specifica: «scadono con l'anno e si rifirmano dal passaggio», tranne i sanitari. Le
 * parole sono due regole in meno di quante ne servano, e ognuna delle tre scritte qui ha una misura sotto.
 *
 * ─── 1. CHE COSA SI RIFIRMA ─────────────────────────────────────────────────────
 *
 * Non basta `durata = 'anno'`: quella è vera per quattordici voci su diciassette, e chiederle tutte
 * direbbe a una famiglia di rifirmare il certificato che firma la Scuola e il verbale di un infortunio. Si
 * rifirma ciò che LA FAMIGLIA firma, che vale ANCORA l'anno dopo, e che è stato chiesto a lei.
 * `MODULI_CHE_SI_RINNOVANO` è quell'intersezione, e oggi dà la sola delega al ritiro.
 *
 * ─── 2. CHI PUÒ AVERE QUALCOSA DA RIFIRMARE ─────────────────────────────────────
 *
 * Chi ha frequentato un anno prima dell'attivo. Chi è appena arrivato ha firmato per l'unico anno che ha,
 * anche se l'ha fatto in giugno durante l'iscrizione. Oggi tutte le frequenze sono del 2026/27: nessuno.
 *
 * ─── 3. QUANDO UNA FIRMA VALE PER L'ANNO ATTIVO ─────────────────────────────────
 *
 * Il confronto col solo calendario («firmata in un anno diverso dall'attivo») sbaglia in due punti:
 *
 *  · i prestampati sono in app dal 15/08/2026 e il 2026/27 comincia il 01/09: ogni firma di quei giorni
 *    cade nel 2025/26 e avrebbe chiesto di rifirmare già oggi;
 *  · il passaggio si fa fra il giorno dopo `ultimo_giorno_aperto` e l'`inizio` del nuovo anno, quindi chi
 *    rifirma il 25 agosto, come gli è stato chiesto, resterebbe da rifirmare per sempre.
 *
 * Perciò il confine è l'`ultimo_giorno_aperto` dell'anno prima: da lì in poi la scuola vecchia è finita, e
 * una firma non può che riguardare la nuova. Non è una seconda regola su «che anno è» (`annoDelGiorno`
 * resta l'unica): è la data che il calendario già dichiara. Il passaggio può arrivare dopo il confine, e
 * una firma data in quel mezzo vale lo stesso: è il verso in cui si sceglie di sbagliare.
 *
 * Modulo PURO, come `registro.ts`: le letture stanno nella route, ancorate ai figli del genitore.
 *
 * Collaudato in `__tests__/lib/prestampati-da-rifirmare.test.ts`.
 */

import { dataCivile } from '@/i18n/config'
import { annoAttivoDelCalendario, type Calendario } from '@/lib/anno-scolastico'
import {
  bloccoFirma,
  chiaveEtichetta,
  prestampatiPerRuolo,
  type SlugPrestampato,
  type VocePrestampato,
} from '@/lib/prestampati/registro'

/**
 * Gli atti che raccontano un fatto finito, e l'anno dopo non hanno niente da rinnovare.
 *
 * Il permesso vale per un giorno, un periodo o una ricorrenza con la sua data di fine. L'autorizzazione
 * vale per QUELLA gita, e il suo modulo non compare nemmeno senza un'uscita pubblicata: chiederla vorrebbe
 * dire una richiesta che la famiglia non può soddisfare. Sono due righe e non una regola dedotta dai campi
 * per lo stesso motivo di `ALLEGATO_SENZA_PORTA`: è una decisione sul prodotto, non una proprietà del modulo.
 */
const ATTI_PUNTUALI: ReadonlySet<SlugPrestampato> = new Set<SlugPrestampato>([
  'permesso_orario',
  'autorizzazione_uscita',
])

/** I moduli che si rifirmano a ogni anno: della famiglia, firmati da lei, ancora in vigore l'anno dopo. */
export const MODULI_CHE_SI_RINNOVANO: readonly VocePrestampato[] = prestampatiPerRuolo('genitore').filter(
  (v) => v.durata === 'anno' && bloccoFirma(v.firma) === 'genitore' && !ATTI_PUNTUALI.has(v.slug),
)

/** Una riga del fascicolo, con le sole colonne che servono: `student_documents` non ha l'anno. */
export interface FirmaArchiviata {
  document_type: string | null
  created_at: string | null
}

export interface ModuloDaRifirmare {
  slug: SlugPrestampato
  chiaveEtichetta: string
  /** L'ultimo giorno (di Roma) in cui è stato firmato. */
  ultimaFirma: string
}

/**
 * Il giorno entro cui una firma è dell'anno vecchio, o `null` se questo bambino non ha niente da rifirmare.
 *
 * `null` è la risposta di chi non ha frequentato un anno prima dell'attivo, e di chi sta in una sede senza
 * calendario o senza anno attivo. `anniFrequentati` sono gli `anni_scolastici.id` delle sue frequenze in
 * qualunque sede e stato: chi si è ritirato e rientra ha comunque firmato per un anno che è finito. Un anno
 * che il calendario della sede non conosce non conta: da un id solo non si sa se è passato o futuro.
 */
export function confineRifirma(
  calendario: Calendario | null | undefined,
  anniFrequentati: ReadonlySet<string>,
): string | null {
  const attivo = annoAttivoDelCalendario(calendario)
  if (!calendario || !attivo) return null
  const anniPrima = calendario.filter((r) => r.annoInizio < attivo.annoInizio)
  if (!anniPrima.some((r) => anniFrequentati.has(r.annoId))) return null
  return anniPrima.reduce((a, b) => (b.annoInizio > a.annoInizio ? b : a)).ultimoGiornoAperto
}

const SLUG_CHE_SI_RINNOVANO: ReadonlySet<string> = new Set(MODULI_CHE_SI_RINNOVANO.map((v) => v.slug))

/**
 * Il filtro sul TIPO: delle righe del fascicolo restano solo quelle di un modulo che si rinnova.
 *
 * Sta qui e non nella query perché sul DB della CI uno slug fuori dall'enumerazione risponde `22P02`
 * (vedi la route). Si applica subito dopo la lettura, prima di raggruppare per figlio: i sanitari (che
 * valgono fino a revoca), gli atti puntuali e tutto ciò che non è nel catalogo non arrivano al calcolo.
 */
export function soloFirmeRinnovabili<T extends FirmaArchiviata>(firme: readonly T[]): T[] {
  return firme.filter((f) => SLUG_CHE_SI_RINNOVANO.has(f.document_type?.trim() ?? ''))
}

/** Il tetto di moduli consegnati in una risposta: oltre, la schermata dice «e altri N». */
export const TETTO_DA_RIFIRMARE = 20

export interface GruppoDaRifirmare {
  alunno_id: string
  moduli: ModuloDaRifirmare[]
}

/**
 * ORDINE e TETTO. Il più vecchio scaduto va per primo (a pari data: figlio, poi modulo, perché due letture
 * di fila diano la stessa risposta); si consegnano i primi `tetto` moduli e `totale` è il conto vero di
 * prima del taglio. I gruppi seguono il loro primo modulo; un gruppo svuotato dal taglio non esiste.
 */
export function limitaDaRifirmare(
  gruppi: readonly GruppoDaRifirmare[],
  tetto: number = TETTO_DA_RIFIRMARE,
): { gruppi: GruppoDaRifirmare[]; totale: number } {
  const piatti = gruppi.flatMap((g) => g.moduli.map((modulo) => ({ alunno_id: g.alunno_id, modulo })))
  piatti.sort(
    (a, b) =>
      a.modulo.ultimaFirma.localeCompare(b.modulo.ultimaFirma) ||
      a.alunno_id.localeCompare(b.alunno_id) ||
      a.modulo.slug.localeCompare(b.modulo.slug),
  )
  const consegnati = new Map<string, ModuloDaRifirmare[]>()
  for (const { alunno_id, modulo } of piatti.slice(0, Math.max(0, tetto))) {
    consegnati.set(alunno_id, [...(consegnati.get(alunno_id) ?? []), modulo])
  }
  return {
    gruppi: [...consegnati].map(([alunno_id, moduli]) => ({ alunno_id, moduli })),
    totale: piatti.length,
  }
}

/** Il giorno di Roma di una firma, o `null` se la data non si legge. */
function giornoDellaFirma(creataIl: string | null): string | null {
  if (!creataIl) return null
  const istante = new Date(creataIl)
  return Number.isNaN(istante.getTime()) ? null : dataCivile(istante)
}

/**
 * I moduli di un bambino la cui ultima firma non supera il confine.
 *
 * Un modulo mai firmato non è qui: manca, che è la lista dei moduli richiesti (`frequenze_moduli`), non
 * questa. Una data illeggibile non è una firma: non chiede niente e non copre niente.
 */
export function moduliDaRifirmare(firme: readonly FirmaArchiviata[], confine: string): ModuloDaRifirmare[] {
  const esito: ModuloDaRifirmare[] = []
  for (const voce of MODULI_CHE_SI_RINNOVANO) {
    let ultima: string | null = null
    for (const f of firme) {
      if (f.document_type?.trim() !== voce.slug) continue
      const giorno = giornoDellaFirma(f.created_at)
      if (giorno && (!ultima || giorno > ultima)) ultima = giorno
    }
    if (ultima && ultima <= confine) {
      esito.push({ slug: voce.slug, chiaveEtichetta: chiaveEtichetta(voce.slug), ultimaFirma: ultima })
    }
  }
  // Dal più vecchio al più recente: chi è scaduto da più tempo viene chiesto per primo.
  return esito.sort((a, b) => a.ultimaFirma.localeCompare(b.ultimaFirma) || a.slug.localeCompare(b.slug))
}
