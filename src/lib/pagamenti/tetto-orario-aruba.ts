import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

/**
 * ─── QUANTE FATTURE ARUBA CI LASCIA EMETTERE IN UN'ORA, E COME LO SI SA PRIMA ────────
 *
 * SLA §3 di Aruba, per IP: **30 upload al minuto ma 60 all'ora di volume**, con un
 * leaky bucket dal TTL di un'ora che **ogni tentativo, anche rifiutato, riazzera**.
 * Sessanta è il tetto vero del lavoro di una giornata, e non c'è disegno che lo alzi.
 *
 * Fino al lotto sul server questo limite non legava: il collo di bottiglia era il
 * `signin`, uno al minuto, che di suo impediva di superare le sessanta l'ora. Con un
 * accesso solo per blocco quel freno sparisce, e **il tetto orario diventa l'unica cosa
 * fra un lotto e una tempesta di `429`**. Da qui questo modulo.
 *
 * ─── PERCHÉ NON SI FILTRA PER SEDE, ED È IMPORTANTE ─────────────────────────────────
 * Il limite è **per IP**, e le tre sedi escono dallo stesso IP di Vercel con **una sola
 * utenza Aruba** (`aruba_config->>'username'` distinto = 1 su 3 sedi, misurato). Contare
 * solo le fatture della propria sede sottostimerebbe **sempre**, e la guardia sarebbe
 * verde mentre il secchio è già vuoto.
 *
 * ⚠️ Questo è anche il motivo per cui il conteggio vive qui e non dentro una route:
 * `isolamento-sede-coverage` sorveglia `src/app/api/**\/route.ts` e segnalerebbe un
 * elenco su `fatture_emesse` senza filtro di sede — giustamente, perché quella tabella
 * ha `scuola_id`. Mettere il filtro per far tacere il lock renderebbe la guardia FALSA.
 * Il precedente è dichiarato nel commento del lock stesso (`src/lib/allegati/rimozione.ts`):
 * quando la regola di sede non si applica, il codice sta in `src/lib/` e la ragione si
 * scrive. Questa è la ragione.
 *
 * ─── PERCHÉ LA SOGLIA È SOTTO IL TETTO ─────────────────────────────────────────────
 * Il conteggio delle righe di `fatture_emesse` è un **limite inferiore** dei tentativi
 * verso Aruba, e lo è per una ragione che non si può togliere: **le fatture scritte a
 * mano dal pannello Aruba consumano lo stesso tier e non lasciano nessuna riga da
 * contare**. Il 2026-09-07 ne sono state misurate tre in una sola serie (FPR 1953-1955,
 * assenti dal nostro registro). Un margine di dieci è il prezzo di quella cecità.
 *
 * (Ci sono altre due fonti di sottostima, più piccole: un upload riuscito il cui INSERT
 * fallisce non lascia riga, e un'invocazione troncata fra upload e INSERT nemmeno. Per il
 * Tiering di Aruba contano gli upload **riusciti**, quindi il doppio tentativo dopo un
 * `429` non è fra queste.)
 */

/** Il volume orario dichiarato da Aruba, SLA §3. Non è un nostro parametro. */
export const TETTO_ORARIO_ARUBA = 60

/**
 * Quante ne lasciamo emettere all'app in un'ora. Sotto il tetto di proposito: il margine
 * è per le fatture fatte a mano dal pannello, che consumano lo stesso secchio e che
 * nessuna query può vedere.
 */
export const SOGLIA_ORARIA_APP = 50

/** L'ampiezza della finestra su cui si conta. Un'ora, come il TTL del secchio. */
export const FINESTRA_MS = 60 * 60 * 1000

/**
 * Quante fatture stanno ancora nel secchio, dato quante ne risultano emesse nell'ultima ora.
 *
 * Pura: `null` in ingresso significa «non misurato», e la risposta è la soglia intera —
 * una guardia che non sa non deve impedire di lavorare, perché non è l'unica protezione.
 */
export function posizioniDisponibili(emesseUltimaOra: number | null): number {
  if (emesseUltimaOra === null) return SOGLIA_ORARIA_APP
  return Math.max(0, SOGLIA_ORARIA_APP - emesseUltimaOra)
}

/**
 * Quante righe del blocco richiesto si possono davvero tentare adesso.
 *
 * Si TRONCA invece di rifiutare tutto: se restano otto posizioni e il blocco ne chiede
 * quindici, otto fatture emesse sono otto fatture emesse. Rifiutare in blocco
 * costringerebbe chi lavora a rifare la selezione a mano per indovinare il numero giusto.
 */
export function quanteSePossonoTentare(richieste: number, disponibili: number): number {
  return Math.max(0, Math.min(richieste, disponibili))
}

/**
 * Quante fatture risultano scritte a registro nell'ultima ora, su TUTTE le sedi.
 *
 * `null` = non si è potuto sapere. PostgREST non lancia (AGENTS.md, regola 7): si guarda
 * il valore di ritorno, e sul database E2E della CI la tabella può non esserci affatto
 * (`PGRST205`/`42703`). In quel caso si logga e si prosegue.
 */
export async function contaEmesseUltimaOra(
  supabase: SupabaseClient,
  adesso: Date = new Date(),
): Promise<number | null> {
  const da = new Date(adesso.getTime() - FINESTRA_MS).toISOString()
  const { count, error } = await supabase
    .from('fatture_emesse')
    .select('id', { head: true, count: 'exact' })
    // NIENTE `.eq('scuola_id', …)`: vedi la testata. Il secchio è per IP, non per sede.
    .gte('creato_il', da)
  if (error) {
    logEvento('fattura', 'warn', {
      operazione: 'tettoOrarioAruba:conta',
      esito: 'tetto-non-misurato',
      msg:
        'il numero di fatture emesse nell’ultima ora non si è potuto leggere: il blocco parte ' +
        'senza guardia sul tetto orario di Aruba',
    }, error)
    return null
  }
  return typeof count === 'number' ? count : null
}
