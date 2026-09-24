import { after } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { zUuid } from '@/lib/validation/common'
import { zIntestatarioScelto } from '@/lib/fatturazione/intestatario-scelto'
import { logEvento } from '@/lib/logging/logger'
import { FINESTRA_MS, posizioniDisponibili } from '@/lib/pagamenti/tetto-orario-aruba'
import { PAUSA_FRA_UPLOAD_MS, TETTO_BLOCCO } from '@/lib/pagamenti/lotto-fatture'

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
/**
 * I minuti in cui pg_cron sveglia il giro (`fatture-coda-tick`, nucleo `:804-807`). Il cron gira in
 * GMT ed Europe/Rome ha scarti di ore intere: il minuto è lo stesso. Un test li lega alla migrazione.
 */
export const MINUTI_TICK_CODA = [7, 12, 17, 22, 27, 37, 42, 47, 52, 57] as const
/** Quanto pesa una fattura in un blocco: la pausa fra gli upload più ~3 s d'invio (`lotto-fatture.ts:65-67`, `:83`). */
export const PASSO_FATTURA_STIMA_MS = PAUSA_FRA_UPLOAD_MS + 3_000
/** Oltre ~41 giorni di tick non si stima. */
const TICK_MAX_STIMA = 10_000
const ORA_MS = 60 * 60 * 1000

// ─── Stati e codici d'esito ────────────────────────────────────────────────────────

export const STATI_CODA = ['in_coda', 'in_invio', 'emessa', 'errore', 'tolta'] as const
export type StatoVoceCoda = (typeof STATI_CODA)[number]
/**
 * Gli stati che occupano il posto del pagamento (indice unico parziale della migrazione).
 * L'elenco è UNO, nel motore della fatturazione (consegna 2b, D5): qui si riesporta col nome
 * storico. Il motore importa da qui solo il TIPO `StatoCodaAttivo` (`import type`): nessun ciclo
 * a runtime.
 */
export { STATI_CODA_OCCUPATA as STATI_ATTIVI } from '@/lib/pagamenti/fatturazione-riga'
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
 * `intestatario`: il ramo `adult` per id (nome, codice fiscale e residenza si rileggono da
 * `parents` all'emissione) oppure, dalla consegna 2b (D1), la persona scritta a mano («Altro»)
 * — ma SOLO in un gesto di UNA voce (il `superRefine` di `zCorpoAccoda`): il pulsante ha il
 * modulo da compilare, il lotto no. La persona vive in `fatture_coda.intestatario_scelto` fino
 * alla chiusura (emessa e «Togli» la azzerano); non esce dalla GET, e nei log il corpo passa da
 * `redactInput`. La validano `validaCessionario` all'accodamento (400
 * `INTESTATARIO_DIGITATO_INCOMPLETO`, prima di ogni lettura) e l'emissione.
 *
 * `conferma_proposta`: autorizza il lavoratore a SCRIVERE l'intestatario sulla scheda del
 * bambino dopo un'emissione nuova riuscita. Con `adult` è la proposta del bonifico confermata
 * (lotto); con `persona` la casella «ricorda sulla scheda» del pulsante. Il nome è storico (T3).
 *
 * `causale`: la correzione scritta a mano (1..1000 caratteri dopo il trim). Stringa vuota o
 * `null` ⇒ nessuna causale manuale.
 */
export const zVoceAccodamento = z.object({
  pagamento_id: zUuid,
  intestatario: zIntestatarioScelto.optional(),
  conferma_proposta: z.boolean().optional(),
  causale: z.string().trim().max(1000, 'Causale troppo lunga (massimo 1000 caratteri)').nullable().optional(),
})
export type VoceAccodamento = z.infer<typeof zVoceAccodamento>

export const zCorpoAccoda = z
  .object({
    voci: z
      .array(zVoceAccodamento)
      .min(1, 'Nessuna fattura da mettere in coda')
      .max(TETTO_VOCI_CODA, `Al massimo ${TETTO_VOCI_CODA} fatture per volta`),
    urgente: z.boolean().optional(),
  })
  .superRefine((corpo, ctx) => {
    // T1 (consegna 2b, D1): l'intestatario scritto a mano entra solo da un gesto di UNA voce, il
    // pulsante, che ha il modulo da compilare. Il lotto non ce l'ha: da lì un'anagrafica digitata
    // finirebbe su un documento fiscale che nessuno ha riletto.
    if (corpo.voci.length > 1 && corpo.voci.some((v) => v.intestatario?.tipo === 'persona')) {
      ctx.addIssue({ code: 'custom', path: ['voci'], message: 'Un intestatario scritto a mano si mette in coda una fattura alla volta' })
    }
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
      /**
       * ISO, oppure `null`: niente in attesa, coda sospesa, fatture dell'ultima ora non lette
       * (il giro non invierebbe: fail-closed), oltre l'orizzonte della stima.
       */
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

export interface IngressiStima {
  adesso: Date
  inCoda: number
  inInvio: number
  sospesa: boolean
  pausaFinoA: string | null
  /** Istanti ISO delle righe di `fatture_emesse` dell'ultima ora, TUTTE le sedi. `null` = non misurato. */
  emesseUltimaOra: readonly string[] | null
}

/** Il primo tick del cron a un istante >= `ms`, secondi a zero. */
function prossimoTick(ms: number): number {
  const ora = Math.floor(ms / ORA_MS) * ORA_MS
  for (const m of MINUTI_TICK_CODA) {
    const t = ora + m * 60_000
    if (t >= ms) return t
  }
  return ora + ORA_MS + MINUTI_TICK_CODA[0] * 60_000
}

/**
 * L'orario stimato di fine: i giri del cron simulati con le regole del giro vero. A ogni tick si
 * contano le fatture con `creato_il >= t - 1h` (come `contaEmesseUltimaOra`), si prendono
 * `min(TETTO_BLOCCO, posti, restanti)` (come `giro.ts:301-303`), e ognuna pesa
 * `PASSO_FATTURA_STIMA_MS`. `null`: niente in attesa, coda sospesa, emesse non misurate (il giro
 * non invia: fail-closed), oltre l'orizzonte.
 *
 * Limiti dichiarati: ignora la «sveglia» dopo un accodamento (il primo blocco può partire prima:
 * pessimista di al più 10 minuti) e le fatture fatte a mano dal pannello Aruba (il margine di 10
 * di `SOGLIA_ORARIA_APP`).
 */
export function stimaFineCoda(i: IngressiStima): string | null {
  const inCoda = Math.max(0, Math.floor(Number(i.inCoda) || 0))
  const inInvio = Math.max(0, Math.floor(Number(i.inInvio) || 0))
  if (inCoda + inInvio === 0 || i.sospesa || i.emesseUltimaOra === null) return null
  const adesso = i.adesso.getTime()
  if (!Number.isFinite(adesso)) return null
  const secchio = i.emesseUltimaOra.map((s) => Date.parse(s)).filter(Number.isFinite)
  for (let k = 0; k < inInvio; k++) secchio.push(adesso) // le voci in volo occupano il secchio adesso
  secchio.sort((a, b) => a - b)
  if (inCoda === 0) return new Date(adesso + inInvio * PASSO_FATTURA_STIMA_MS).toISOString()
  const pausa = i.pausaFinoA ? Date.parse(i.pausaFinoA) : Number.NaN
  let t = prossimoTick(Number.isFinite(pausa) && pausa > adesso ? pausa : adesso)
  let restanti = inCoda
  let testa = 0
  for (let g = 0; g < TICK_MAX_STIMA; g++) {
    while (testa < secchio.length && secchio[testa] < t - FINESTRA_MS) testa++
    const prese = Math.min(TETTO_BLOCCO, posizioniDisponibili(secchio.length - testa), restanti)
    // Il secchio resta ordinato senza riordinarlo: ogni istante aggiunto viene dopo il primo tick, che è >= adesso.
    for (let k = 1; k <= prese; k++) secchio.push(t + k * PASSO_FATTURA_STIMA_MS)
    restanti -= prese
    if (restanti === 0) return new Date(t + prese * PASSO_FATTURA_STIMA_MS).toISOString()
    t = prossimoTick(t + 60_000)
  }
  return null
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
