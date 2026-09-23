import { after } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { zUuid } from '@/lib/validation/common'
import { zAdultScelto } from '@/lib/fatturazione/intestatario-scelto'
import { logEvento } from '@/lib/logging/logger'
import { SOGLIA_ORARIA_APP } from '@/lib/pagamenti/tetto-orario-aruba'

/**
 * ─── IL CONTRATTO HTTP DELLA CODA FATTURE (nucleo, §3) ───────────────────────────────
 *
 * Qui stanno gli schemi `zod` dei corpi, i tipi delle risposte e i codici che l'interfaccia
 * legge. Le route (`/api/pagamenti/fattura/coda`, `/coda/azioni`, `/coda/sospensione`) li
 * importano; il pannello «Coda fatture», il lotto e il pulsante singolo li usano come tipi.
 *
 * ⚠️ I CODICI D'ERRORE HTTP sono ripetuti come `const` LETTERALI dentro ogni route, e non è
 * una svista: il lock `errori-con-codice` legge `codice: X` solo se `X` è una stringa o un
 * `const X = '…'` dello STESSO file. Le costanti qui sotto sono per chi LEGGE la risposta;
 * che coincidano con quelle delle route lo verificano i test delle route, sulla risposta.
 */

// ─── Tetti ─────────────────────────────────────────────────────────────────────────

/** Quante voci si accodano (o si toccano) in un gesto solo. */
export const TETTO_VOCI_CODA = 500
/** Quante voci restituisce al massimo la GET (attive prima, poi le concluse recenti). */
export const TETTO_VOCI_GET = 1000
/** Da quanti giorni la GET mostra le voci concluse (emesse e tolte). */
export const GIORNI_STORICO_CODA = 7
/** Il ritmo su cui si stima l'orario di fine: lo stesso tetto orario del lavoratore. */
export const RITMO_ORARIO_STIMA = SOGLIA_ORARIA_APP

// ─── Stati e codici d'esito ────────────────────────────────────────────────────────

export const STATI_CODA = ['in_coda', 'in_invio', 'emessa', 'errore', 'tolta'] as const
export type StatoVoceCoda = (typeof STATI_CODA)[number]
/** Gli stati che occupano il posto del pagamento (indice unico parziale della migrazione). */
export const STATI_ATTIVI: readonly StatoVoceCoda[] = ['in_coda', 'in_invio', 'errore']
/** Gli stati attivi come TIPO: ciò che una riga di Pagamenti o Riconciliazione può dire (consegna 2a, rilievo e). */
export type StatoCodaAttivo = Extract<StatoVoceCoda, 'in_coda' | 'in_invio' | 'errore'>

/**
 * I codici d'esito che il lavoratore scrive in `fatture_coda.esito_codice` (§2.7).
 *
 * Non sono tutti: un rifiuto locale 400/404/409/422 porta il `codice` della risposta di
 * `emettiFatturaPagamento` così com'è (es. `FATTURA_PARTITA_NON_REGISTRATA`). L'interfaccia
 * li traduce con `esiti.<codice>` e ricade su un testo generico per quelli che non conosce.
 */
export const ESITI_CODA = {
  EMESSA: 'emessa',
  GIA_EMESSA: 'gia_emessa',
  SCARTO_ARUBA: 'scarto_aruba',
  ESITO_INCERTO: 'esito_incerto',
} as const
export type EsitoCodaNoto = (typeof ESITI_CODA)[keyof typeof ESITI_CODA]

/** I codici d'errore HTTP delle route della coda (vedi l'avvertenza in testa). */
export const CODICI_ERRORE_CODA = {
  /** 503 sulle POST quando la tabella (o la RPC) non c'è: DB non migrato. */
  NON_DISPONIBILE: 'CODA_FATTURE_NON_DISPONIBILE',
  /** 400: una voce riguarda un pagamento non saldato. */
  PAGAMENTO_NON_SALDATO: 'PAGAMENTO_NON_SALDATO',
  /** 500: la RPC di scrittura ha risposto con un errore. */
  SCRITTURA_FALLITA: 'CODA_FATTURE_SCRITTURA_FALLITA',
  /** 500: una lettura necessaria non è riuscita. */
  LETTURA_FALLITA: 'LETTURA_FALLITA',
} as const

// ─── Corpi delle richieste ─────────────────────────────────────────────────────────

/**
 * Una voce da accodare.
 *
 * `intestatario`: SOLO il ramo `adult`, come nel lotto e per la stessa ragione — la coda non
 * deve custodire nome, codice fiscale e residenza digitati nel browser. Viaggia l'id; il resto
 * si rilegge da `parents` all'emissione.
 *
 * `causale`: la correzione scritta a mano (1..1000 caratteri dopo il trim). Stringa vuota o
 * `null` ⇒ nessuna causale manuale.
 */
export const zVoceAccodamento = z.object({
  pagamento_id: zUuid,
  intestatario: zAdultScelto.optional(),
  conferma_proposta: z.boolean().optional(),
  causale: z.string().trim().max(1000, 'Causale troppo lunga (massimo 1000 caratteri)').nullable().optional(),
})
export type VoceAccodamento = z.infer<typeof zVoceAccodamento>

export const zCorpoAccoda = z.object({
  voci: z
    .array(zVoceAccodamento)
    .min(1, 'Nessuna fattura da mettere in coda')
    .max(TETTO_VOCI_CODA, `Al massimo ${TETTO_VOCI_CODA} fatture per volta`),
  urgente: z.boolean().optional(),
})
export type CorpoAccoda = z.infer<typeof zCorpoAccoda>

export const zCorpoAzioni = z.object({
  azione: z.enum(['togli', 'rimetti']),
  ids: z
    .array(zUuid)
    .min(1, 'Nessuna voce selezionata')
    .max(TETTO_VOCI_CODA, `Al massimo ${TETTO_VOCI_CODA} voci per volta`),
})
export type CorpoAzioni = z.infer<typeof zCorpoAzioni>

/**
 * La query della GET. `solo=conteggi` è la lettura del contatore del menu (nucleo §4): stato
 * della disponibilità e `conteggi`, senza voci, autori né sedi — il menu si monta su ogni
 * pagina del cockpit e non deve trascinarsi fino a 1000 voci per disegnare un numero.
 */
export const zQueryGetCoda = z.object({
  solo: z.enum(['conteggi']).optional(),
})
export type QueryGetCoda = z.infer<typeof zQueryGetCoda>

export const zCorpoSospensione = z.object({
  sospesa: z.boolean(),
})
export type CorpoSospensione = z.infer<typeof zCorpoSospensione>

// ─── Risposte ──────────────────────────────────────────────────────────────────────

export interface StatoCoda {
  sospesa: boolean
  sospesa_il: string | null
  pausa_fino_a: string | null
  pausa_motivo: string | null
  ultimo_giro_il: string | null
}

export interface ConteggiCoda {
  in_coda: number
  in_invio: number
  errore: number
  emesse_7g: number
  tolte_7g: number
}

export interface VoceCodaVista {
  id: string
  stato: StatoVoceCoda
  urgente: boolean
  accodata_il: string | null
  esito_codice: string | null
  /** `null` quando la voce è di una sede che l'utente non ha: degli altri si vede il codice. */
  esito_messaggio: string | null
  scuola_id: string
  scuola_nome: string | null
  pagamento_id: string
  /** «Nome Cognome» dell'alunno del pagamento, `null` se il pagamento non ne ha. */
  alunno: string | null
  descrizione: string | null
  importo: number | null
  creato_da_nome: string | null
  /** Posizione 1-based nell'ordine della coda; solo per `in_coda`, altrimenti `null`. */
  posizione: number | null
  /**
   * La voce è di una sede dell'utente. La GET mostra tutte le sedi (decisione 6), ma
   * `/coda/azioni` scrive SOLO sulle proprie e rifiuta l'intero gesto con 403 se una voce
   * sola è di un altro plesso: il pannello rende selezionabili solo le voci `propria`.
   */
  propria: boolean
}

export type RispostaGetCoda =
  | { disponibile: false }
  | {
      disponibile: true
      stato: StatoCoda
      conteggi: ConteggiCoda
      /** ISO, oppure `null` (niente in attesa, o coda sospesa). */
      stima_fine: string | null
      voci: VoceCodaVista[]
    }

/** La risposta di `GET /coda?solo=conteggi`: il contatore del menu. */
export type RispostaConteggiCoda = { disponibile: false } | { disponibile: true; conteggi: ConteggiCoda }

export const zRispostaAccoda = z.object({
  gruppo_id: z.string(),
  accodate: z.number().int().nonnegative(),
  gia_in_coda: z.array(z.string()),
})
export type RispostaAccoda = z.infer<typeof zRispostaAccoda>

export interface RispostaAzioni {
  aggiornate: number
}

export interface RispostaSospensione {
  sospesa: boolean
}

// ─── Funzioni pure ─────────────────────────────────────────────────────────────────

/**
 * «Questa parte del DB non esiste ancora»: tabella (`42P01`, `PGRST205`) o funzione
 * (`42883`, `PGRST202`). È il DB E2E della CI e la produzione fra il deploy del codice e
 * l'applicazione della migrazione. Tutto il resto è un guasto vero, e non si degrada.
 */
const CODICI_ASSENZA = new Set(['42P01', 'PGRST205', '42883', 'PGRST202'])

export function codaAssente(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const codice = (error as { code?: unknown }).code
  return typeof codice === 'string' && CODICI_ASSENZA.has(codice)
}

/**
 * L'orario stimato di fine, a `RITMO_ORARIO_STIMA` fatture l'ora sulle voci in attesa.
 *
 * - niente in attesa ⇒ `null`;
 * - coda sospesa ⇒ `null`: finché qualcuno non la riprende, non finisce;
 * - pausa in corso ⇒ si parte dalla fine della pausa, non da adesso.
 *
 * È una stima dichiarata: non conosce le fatture già emesse nell'ultima ora né quelle fatte a
 * mano dal pannello Aruba, che consumano lo stesso secchio.
 */
export function stimaFineCoda(
  inAttesa: number,
  opzioni: { adesso: Date; sospesa: boolean; pausaFinoA: string | null },
): string | null {
  if (!Number.isFinite(inAttesa) || inAttesa <= 0) return null
  if (opzioni.sospesa) return null
  let inizio = opzioni.adesso.getTime()
  if (opzioni.pausaFinoA) {
    const pausa = Date.parse(opzioni.pausaFinoA)
    if (Number.isFinite(pausa) && pausa > inizio) inizio = pausa
  }
  const durataMs = (inAttesa / RITMO_ORARIO_STIMA) * 60 * 60 * 1000
  return new Date(inizio + Math.ceil(durataMs)).toISOString()
}

/** Toglie i doppioni mantenendo il primo, nell'ordine dato. */
export function senzaDoppioni<T>(elementi: readonly T[], chiave: (e: T) => string): T[] {
  const visti = new Set<string>()
  const out: T[] = []
  for (const e of elementi) {
    const k = chiave(e).toLowerCase()
    if (visti.has(k)) continue
    visti.add(k)
    out.push(e)
  }
  return out
}

/**
 * La voce nella forma che `fatture_coda_accoda` si aspetta in `p_voci`.
 * `ordine_selezione` è l'indice nel gesto dell'operatore.
 */
export function voceRpc(v: VoceAccodamento, ordine: number): Record<string, unknown> {
  const causale = typeof v.causale === 'string' && v.causale.length > 0 ? v.causale : null
  return {
    pagamento_id: v.pagamento_id,
    intestatario_scelto: v.intestatario ?? null,
    conferma_proposta: v.conferma_proposta ?? false,
    causale_manuale: causale,
    ordine_selezione: ordine,
  }
}

// ─── La sveglia ────────────────────────────────────────────────────────────────────

/**
 * Chiede un giro al lavoratore SENZA aspettarlo: `fatture_coda_tick_http` accoda una
 * `net.http_post` verso `/coda/giro` e torna subito. Senza sveglia la voce aspetterebbe il
 * prossimo tick del cron (fino a 10 minuti con le finestre della sync).
 *
 * ⚠️ `supabase.rpc()` è PIGRA: il costruttore non parte finché nessuno chiama `.then`. Un
 * «fire and forget» scritto come `supabase.rpc(...)` senza `await` non manderebbe niente.
 * Qui la chiamata si avvia davvero, dentro `after()` quando c'è un contesto di richiesta
 * (così la piattaforma non la tronca dopo la risposta), altrimenti subito.
 *
 * Il fallimento della sveglia non è un errore dell'utente: la voce è in coda e il cron la
 * prenderà comunque. Si logga a `warn`, e si logga anche il successo.
 */
export function svegliaCoda(sb: SupabaseClient, operazione: string): void {
  const lancia = async (): Promise<void> => {
    try {
      const { error } = await sb.rpc('fatture_coda_tick_http')
      if (error) {
        logEvento('fattura', 'warn', { operazione, esito: 'sveglia-fallita' }, error)
        return
      }
      logEvento('fattura', 'info', { operazione, esito: 'sveglia-inviata' })
    } catch (err) {
      logEvento('fattura', 'warn', { operazione, esito: 'sveglia-eccezione' }, err)
    }
  }
  try {
    after(lancia)
  } catch (err) {
    // Fuori da un contesto di richiesta (test, script) `after` lancia: si parte subito.
    logEvento('fattura', 'info', { operazione, esito: 'sveglia-senza-after' }, err)
    void lancia()
  }
}
