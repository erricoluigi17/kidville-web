/**
 * La causale di UN pagamento: la stessa stringa per chi la MOSTRA e per chi la EMETTE.
 *
 * ─── PERCHÉ ESISTE, detto sul difetto che l'ha resa necessaria ───────────────
 * Il 2026-09-03 la fattura FPR 1948/26 è uscita con «Retta 09/2026» — la nuda
 * `pagamenti.descrizione` — mentre la sede aveva configurato un modello coi
 * segnaposti. Non era un guasto dell'emissione: `emettiFatturaPagamento` leggeva la
 * configurazione e la applicava. Era il modale «Emetti», che precompilava la casella
 * della causale con la descrizione del pagamento e la spediva come **correzione
 * manuale della segreteria** — che per progetto batte qualunque modello. Chi premeva
 * il pulsante annullava la configurazione senza saperlo, e senza poterlo vedere.
 *
 * La correzione è mostrare **prima** cosa uscirà. Ma un'anteprima ricalcolata lato
 * client sarebbe una SECONDA implementazione della stessa regola — la trappola che
 * questo repo ha già pagato quando la risoluzione del modello era scritta in tre
 * posti (v. la testata di `modelloCausale`). Quindi la composizione vive qui, una
 * volta sola, e la chiamano entrambe le strade:
 *
 *   `@/lib/aruba/emissione`                        → il documento che parte
 *   `/api/pagamenti/fattura/anteprima`             → quello che si vede prima
 *
 * Se un giorno divergessero, non sarebbe un dettaglio estetico: la segreteria
 * approverebbe un testo e ne spedirebbe un altro, su un documento che si corregge
 * solo con una nota di variazione.
 *
 * ⚠️ Il codice fiscale del minore attraversa questo modulo. Non finisce nei log:
 * si registrano `origine` e `lunghezza`, mai la causale (AGENTS.md, regola 8).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  causaleFatturaConOrigine,
  CHIAVE_CONFIG_CAUSALI_FATTURA,
  type OrigineCausaleFattura,
} from '@/lib/pagamenti/causale-fattura'
import type { ConfigCausali } from '@/lib/pagamenti/causale'
import { meseAnnoDaPeriodo } from '@/lib/pagamenti/periodo'
import { leggiModuleConfig } from '@/lib/settings/module-config'
import { formatEuro } from '@/lib/format/valuta'
import { isoToIt } from '@/lib/format/data'
import { logEvento } from '@/lib/logging/logger'

/**
 * Le colonne che servono a comporre la causale, in UNA costante.
 *
 * L'anteprima e l'emissione devono leggere la stessa forma dello stesso pagamento:
 * se una delle due dimenticasse `periodo_competenza` o lo slug della categoria,
 * comporrebbe una causale diversa **senza un errore** — il segnaposto vuoto viene
 * omesso con grazia, ed è proprio la grazia che renderebbe la divergenza invisibile.
 *
 * ⚠️ Una stringa sola, per quanto lunga: spezzata con `+` il client Supabase perde il
 * tipo letterale del select. Non è stile, è un vincolo dell'inferenza.
 */
export const SELECT_PAGAMENTO_CAUSALE =
  'id, descrizione, importo, stato, scadenza, periodo_competenza, scuola_id, fattura_causale, categoria_id, alunno_id, payment_categories:categoria_id ( slug ), alunni:alunno_id ( id, nome, cognome, codice_fiscale )'

/** La forma minima del pagamento che serve a comporre: quella che `SELECT_PAGAMENTO_CAUSALE` produce. */
export interface PagamentoPerCausale {
  id?: string
  descrizione?: string | null
  importo?: number | string | null
  scadenza?: string | null
  periodo_competenza?: string | null
  scuola_id?: string | null
  fattura_causale?: string | null
  payment_categories?: { slug?: string | null } | { slug?: string | null }[] | null
  alunni?: AlunnoPerCausale | AlunnoPerCausale[] | null
}

export interface AlunnoPerCausale {
  id?: string
  nome?: string
  cognome?: string
  codice_fiscale?: string | null
}

export type EsitoCausalePagamento =
  | { ok: true; causale: string; origine: OrigineCausaleFattura }
  | { ok: false; motivo: 'errore'; messaggio: string; httpStatus: 503 }

/** L'alunno annidato, che PostgREST restituisce come oggetto o come array di uno. */
export function alunnoDaPagamento(pag: PagamentoPerCausale): AlunnoPerCausale | null {
  const a = pag.alunni
  return (Array.isArray(a) ? a[0] : a) ?? null
}

/** Lo slug della categoria, con lo stesso srotolamento. */
function slugCategoria(pag: PagamentoPerCausale): string | null | undefined {
  const c = pag.payment_categories
  return (Array.isArray(c) ? c[0] : c)?.slug
}

function s(v: unknown): string {
  return v == null ? '' : String(v)
}

/**
 * Il nome della sede, per il segnaposto `{sede}`.
 *
 * Best-effort dichiarato: se non si legge, la causale esce senza quel pezzo — il
 * motore omette il segmento invece di lasciare una parola penzolante. Un documento
 * fiscale non si blocca per il nome del plesso; ma il guasto non passa in silenzio,
 * perché PostgREST NON LANCIA e senza questa riga l'errore sparirebbe nella
 * destrutturazione (AGENTS.md, regola 7).
 */
export async function leggiNomeSede(
  supabase: SupabaseClient,
  scuolaId: string | null | undefined,
): Promise<string> {
  if (!scuolaId) return ''
  const { data, error } = await supabase.from('scuole').select('nome').eq('id', scuolaId).maybeSingle()
  if (error) {
    // Niente `msg` accanto a un errore: verrebbe redatto, e il messaggio di PostgREST
    // è già la notizia (quale colonna o quale permesso manca). Il «cosa si perde» sta
    // in `esito`, che resta leggibile in tabella.
    logEvento('fattura', 'warn', {
      operazione: 'componiCausalePagamento:nomeSede',
      esito: 'sede-non-letta-causale-senza-sede',
      scuola_id: scuolaId,
    }, error)
    return ''
  }
  return s((data as { nome?: string | null } | null)?.nome)
}

/**
 * La causale di questo pagamento: **correzione manuale → modello della categoria →
 * «Predefinito» → modello di fabbrica**, resa coi dati del pagamento e del minore.
 *
 * ─── FAIL-CLOSED, e non è prudenza generica ──────────────────────────────────
 * Se la lettura della configurazione fallisce, `{}` significherebbe «nessun modello
 * configurato» e la causale ricadrebbe sul modello di fabbrica. Ma la causale è la
 * DESCRIZIONE DELLA RIGA, cioè l'unico punto in cui il documento identifica il minore
 * e ciò da cui dipende la detrazione del genitore: un guasto di lettura non può
 * riscriverla in silenzio su un documento irreversibile. Quando questa funzione è
 * chiamata dall'emissione, nessun numero è ancora stato consumato.
 */
export async function componiCausalePagamento(
  supabase: SupabaseClient,
  pag: PagamentoPerCausale,
  alunno?: AlunnoPerCausale | null,
): Promise<EsitoCausalePagamento> {
  const letturaCausali = await leggiModuleConfig(supabase, CHIAVE_CONFIG_CAUSALI_FATTURA, pag.scuola_id)
  if (!letturaCausali.ok) {
    logEvento('fattura', 'error', {
      operazione: 'componiCausalePagamento:causali',
      esito: 'causali-config-non-letta',
      scuola_id: pag.scuola_id,
      pagamento_id: pag.id,
      msg:
        'impossibile leggere i modelli di causale della sede: emissione fermata per non ' +
        'scrivere sul documento una descrizione diversa da quella configurata',
    })
    return {
      ok: false,
      motivo: 'errore',
      messaggio:
        'Impossibile leggere i modelli di causale della sede: la fattura non è stata emessa, ' +
        'perché sarebbe uscita con una descrizione diversa da quella configurata. ' +
        'Nessun numero è stato consumato. Riprova fra poco.',
      httpStatus: 503,
    }
  }

  const bimbo = alunno ?? alunnoDaPagamento(pag)
  const { mese, anno } = meseAnnoDaPeriodo(pag.periodo_competenza ?? null)
  const nomeSede = await leggiNomeSede(supabase, pag.scuola_id)

  const { causale, origine } = causaleFatturaConOrigine({
    config: letturaCausali.config as ConfigCausali,
    slugCategoria: slugCategoria(pag),
    // ⚠️ `pagamenti.fattura_causale` è — e RESTA — solo ciò che una persona ha scritto
    // a mano premendo «Personalizza» nel modale. L'emissione non ci riscrive dentro la
    // causale composta: fino al 2026-08-09 lo faceva, e dalla seconda emissione in poi
    // quel campo non era più una correzione umana ma l'eco della prima composizione —
    // cambiare il modello di categoria non aveva più alcun effetto.
    causaleManuale: pag.fattura_causale,
    dati: {
      descrizione: pag.descrizione ?? null,
      nome: bimbo?.nome,
      cognome: bimbo?.cognome,
      codiceFiscale: bimbo?.codice_fiscale,
      sede: nomeSede,
      mese,
      anno,
      importo: formatEuro(pag.importo),
      scadenza: isoToIt(s(pag.scadenza)),
    },
  })

  // Il ripiego sulla descrizione nuda esiste per il caso limite in cui il modello renda
  // una stringa vuota (tutti i segnaposto assenti): una riga di fattura senza
  // descrizione è uno scarto SDI, la descrizione grezza no.
  return { ok: true, causale: causale || s(pag.descrizione), origine }
}
