import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

// ─────────────────────────────────────────────────────────────────────────────
// A CHE COSA È ASSOCIATO QUESTO BONIFICO? (2026-10-05)
//
// Il popup di Riconciliazione sapeva dire lo stato della fattura della voce
// àncora e basta: non la voce, non il bambino, non chi aveva confermato. Questa
// lettura risponde alla domanda intera, in UNA richiesta (lock: «aprire il
// popup costa una lettura sola»), e porta con sé anche ciò che prima arrivava da
// `/api/pagamenti/[id]` — stato e fattura della voce àncora.
// Le voci di un composito si leggono dagli INCASSI della transazione (vivi:
// senza storno), che è dove il denaro è stato davvero scritto.
//
// ⚠️ IL GATE DI SEDE NON STA QUI: sta nell'handler, prima di questa chiamata,
// dove la richiesta arriva e dove il lock sull'isolamento fra i plessi lo cerca.
// Qui si arriva solo con un movimento che chi chiede ha il diritto di vedere.
//
// 🔴 NEI LOG SOLO ENUMERATI E CODICI. Questa lettura maneggia nomi di bambini e
// di operatori: vanno nella RISPOSTA (lo staff deve sapere di chi è la voce e
// chi l'ha confermata), MAI in un `logEvento` — `redact` è a lista bianca, e
// sono dati di minori.
// ─────────────────────────────────────────────────────────────────────────────

export interface VoceAssociata {
  pagamento_id: string
  /** `null` solo su una voce `fuori_sede`: vedi `oscuraVociFuoriSede`. */
  descrizione: string | null
  /** `null` solo su una voce `fuori_sede`: vedi `oscuraVociFuoriSede`. */
  alunno: string | null
  /**
   * La voce è di un plesso fuori dalle sedi attive di chi guarda — il fratello
   * iscritto altrove di un bonifico composito. Presente solo quando è vero.
   */
  fuori_sede?: boolean
  scuola_id: string | null
  importo_voce: number
  /** Quanto QUESTO bonifico ha messo sulla voce: la somma dei suoi incassi vivi. */
  incassato_qui: number
  stato_voce: string
  fattura_stato: string | null
  fattura_in_coda: 'in_coda' | 'in_invio' | 'errore' | null
}

export interface Associazione {
  tipo: 'singola' | 'composita'
  /** `true` se l'ha abbinato la macchina (`abbinato_auto_il` valorizzato). */
  automatico: boolean
  confermato_il: string | null
  /** Nome e cognome dell'operatore: è staff, non un dato di una famiglia. */
  confermato_da: string | null
  voci: VoceAssociata[]
}

export interface MovimentoLetto {
  stato: string
  pagamento_id: string | null
  incasso_id?: string | null
  transazione_id?: string | null
  confermato_da?: string | null
  confermato_il?: string | null
  abbinato_auto_il?: string | null
}

export type EsitoAssociazione =
  | { associazione: Associazione | null; ancora: { stato: string; fattura_stato: string | null } | null }
  | { guasto: unknown }

type RigaIncasso = {
  pagamento_id: string | null
  importo: number | string
  stornato_il?: string | null
  storno_di?: string | null
}

/**
 * Un incasso porta ancora denaro sulla voce? No se è stato stornato
 * (`stornato_il`) e no se è esso stesso un contro-incasso (`storno_di`): in
 * entrambi i casi il denaro di quel bonifico NON è più lì, e contarlo farebbe
 * dire al popup che la voce è pagata da un bonifico che non la paga più.
 */
function incassoVivo(r: RigaIncasso): r is RigaIncasso & { pagamento_id: string } {
  return !!r.pagamento_id && !r.stornato_il && !r.storno_di
}

/** Colonna assente: `42703` da Postgres, `PGRST204` dalla cache di PostgREST. */
const COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])

type LetturaIncassi = { data: unknown; error: { code?: string; message?: string } | null }

/**
 * ─── IL DB E2E DELLA CI NON HA LE COLONNE DELLO STORNO (revisione, 2026-10-05) ──
 *
 * `stornato_il` e `storno_di` sono nate dopo (S3), e il DB E2E della CI non è
 * migrato: chiederle lì fa `42703`, e il popup di OGNI confermato diceva «non è
 * stato possibile leggere». Su quel codice — e solo su quello — si ritenta senza:
 * gli incassi contano come vivi, perché senza quelle colonne uno storno di quella
 * forma non può esserci. Un `warn` lo dice; un guasto vero resta un guasto.
 */
async function leggiIncassiConRipiego(
  leggi: (colonne: string) => PromiseLike<LetturaIncassi>,
  operazione: string,
): Promise<LetturaIncassi> {
  const prima = await leggi('pagamento_id, importo, stornato_il, storno_di')
  if (!prima.error || !COLONNA_ASSENTE.has(prima.error.code ?? '')) return prima
  logEvento('pagamento', 'warn', { operazione, esito: 'associazione-colonne-storno-assenti' }, prima.error)
  return leggi('pagamento_id, importo')
}

/**
 * ─── LA VOCE DI UN FRATELLO ISCRITTO IN UN'ALTRA SEDE (2026-10-05) ──────────
 *
 * Il gate di sede dell'handler giudica il MOVIMENTO. Un bonifico composito però
 * può pagare le voci di due fratelli in due plessi diversi, e la voce del
 * fratello è di una sede che chi guarda non vede: senza questo passo, il popup
 * di Giugliano avrebbe mostrato il nome di un bambino di Cesa e la descrizione
 * della sua voce.
 *
 * Si tolgono il NOME e la DESCRIZIONE; restano le CIFRE, lo stato e la fattura.
 * Il denaro del bonifico va spiegato per intero — altrimenti la somma delle voci
 * a schermo non fa l'importo, e la conferma di uno scollegamento direbbe meno di
 * ciò che farà davvero (lo storno tocca anche quella voce). Le cifre non dicono
 * di chi è la voce.
 *
 * Una voce SENZA sede (`scuola_id` nullo) è trattata come fuori sede: nel dubbio
 * non si mostra, come fa `assertPagamentoInScope`.
 *
 * Il confronto ignora le maiuscole per la stessa ragione di `formaConfronto` in
 * `@/lib/auth/scope` (in Postgres `uuid` è un tipo: `'AAAA…'` e `'aaaa…'` sono lo
 * stesso valore). Non la si importa perché questo è il modulo di dominio della
 * lettura, e la forma — `trim().toLowerCase()` — è una riga.
 */
export function oscuraVociFuoriSede(associazione: Associazione, sediAttive: readonly string[]): Associazione {
  const forma = (id: string) => id.trim().toLowerCase()
  const dentro = new Set(sediAttive.map(forma))
  return {
    ...associazione,
    voci: associazione.voci.map((v) =>
      v.scuola_id && dentro.has(forma(v.scuola_id))
        ? v
        : { ...v, descrizione: null, alunno: null, fuori_sede: true },
    ),
  }
}

export async function leggiAssociazione(
  supabase: SupabaseClient,
  mov: MovimentoLetto,
  operazione: string,
): Promise<EsitoAssociazione> {
  if (mov.stato !== 'confermato') return { associazione: null, ancora: null }

  // 1. Quanto il bonifico ha messo su ciascuna voce
  const incassatoPerVoce = new Map<string, number>()
  if (mov.transazione_id) {
    const transazioneId = mov.transazione_id
    const { data, error } = await leggiIncassiConRipiego(
      (colonne) => supabase.from('incassi').select(colonne).eq('transazione_id', transazioneId),
      operazione,
    )
    if (error) return { guasto: error }
    for (const r of (data ?? []) as RigaIncasso[]) {
      if (!incassoVivo(r)) continue
      incassatoPerVoce.set(r.pagamento_id, (incassatoPerVoce.get(r.pagamento_id) ?? 0) + Number(r.importo))
    }
  } else if (mov.incasso_id) {
    // Stesse colonne del ramo composito, e per la stessa ragione: un incasso
    // stornato a mano dal registro (senza riaprire il movimento) non porta più
    // denaro sulla voce, e il popup non deve dire il contrario.
    const incassoId = mov.incasso_id
    const { data, error } = await leggiIncassiConRipiego(
      (colonne) => supabase.from('incassi').select(colonne).eq('id', incassoId).maybeSingle(),
      operazione,
    )
    if (error) return { guasto: error }
    const r = data as RigaIncasso | null
    if (r && incassoVivo(r)) incassatoPerVoce.set(r.pagamento_id, Number(r.importo))
  }
  // La voce àncora c'è SEMPRE, anche quando nessun incasso vivo la nomina: è la
  // voce a cui la riga dice di essere abbinata, e il popup deve poterla mostrare.
  if (mov.pagamento_id && !incassatoPerVoce.has(mov.pagamento_id)) incassatoPerVoce.set(mov.pagamento_id, 0)
  const ids = [...incassatoPerVoce.keys()]

  // 2. Le voci, col bambino
  let voci: VoceAssociata[] = []
  if (ids.length > 0) {
    const { data, error } = await supabase
      .from('pagamenti')
      .select('id, descrizione, importo, stato, scuola_id, fattura_stato, alunni:alunno_id ( nome, cognome )')
      .in('id', ids)
    if (error) return { guasto: error }

    // 3. La coda fatture. Degrada a «nessuna» dove la tabella non c'è (`42P01`
    // sul DB E2E della CI) o non si legge: è un'informazione in più sul popup,
    // non la ragione per cui lo si apre — ma un ramo di degradazione che nessuno
    // vede è la prima metà di ogni guasto lungo, quindi `warn`.
    const coda = new Map<string, VoceAssociata['fattura_in_coda']>()
    const { data: righeCoda, error: errCoda } = await supabase
      .from('fatture_coda')
      .select('pagamento_id, stato')
      .in('pagamento_id', ids)
      .in('stato', ['in_coda', 'in_invio', 'errore'])
    if (errCoda) {
      logEvento('pagamento', 'warn', { operazione, esito: 'associazione-coda-non-letta' }, errCoda)
    }
    for (const r of (righeCoda ?? []) as { pagamento_id: string; stato: VoceAssociata['fattura_in_coda'] }[]) {
      coda.set(r.pagamento_id, r.stato)
    }

    voci = ((data ?? []) as {
      id: string
      descrizione: string | null
      importo: number | string
      stato: string
      scuola_id: string | null
      fattura_stato: string | null
      alunni: { nome?: string | null; cognome?: string | null } | null
    }[]).map((p) => ({
      pagamento_id: p.id,
      descrizione: p.descrizione ?? '—',
      alunno: [p.alunni?.nome, p.alunni?.cognome].filter(Boolean).join(' ') || '—',
      scuola_id: p.scuola_id,
      importo_voce: Number(p.importo),
      incassato_qui: incassatoPerVoce.get(p.id) ?? 0,
      stato_voce: p.stato,
      fattura_stato: p.fattura_stato ?? null,
      fattura_in_coda: coda.get(p.id) ?? null,
    }))
    // la voce àncora per prima, poi nell'ordine degli incassi
    voci.sort((a, b) =>
      a.pagamento_id === mov.pagamento_id
        ? -1
        : b.pagamento_id === mov.pagamento_id
          ? 1
          : ids.indexOf(a.pagamento_id) - ids.indexOf(b.pagamento_id),
    )
  }

  // 4. Chi ha confermato (nome dell'operatore: è staff, non un dato di una famiglia).
  // PostgREST non lancia: l'errore si legge. Un operatore non letto non vale un
  // 500 — la voce e il denaro sono ciò che il popup deve dire — ma si logga, o
  // «confermato da: —» diventa indistinguibile da «nessuno l'ha confermato».
  let confermatoDa: string | null = null
  if (mov.confermato_da) {
    const { data, error } = await supabase
      .from('utenti')
      .select('nome, cognome')
      .eq('id', mov.confermato_da)
      .maybeSingle()
    if (error) {
      logEvento('pagamento', 'warn', { operazione, esito: 'associazione-operatore-non-letto' }, error)
    } else {
      const u = data as { nome?: string | null; cognome?: string | null } | null
      confermatoDa = [u?.nome, u?.cognome].filter(Boolean).join(' ') || null
    }
  }

  const ancoraVoce = voci.find((v) => v.pagamento_id === mov.pagamento_id) ?? null
  return {
    associazione: {
      tipo: mov.transazione_id ? 'composita' : 'singola',
      automatico: !!mov.abbinato_auto_il,
      confermato_il: mov.confermato_il ?? null,
      confermato_da: confermatoDa,
      voci,
    },
    ancora: ancoraVoce ? { stato: ancoraVoce.stato_voce, fattura_stato: ancoraVoce.fattura_stato } : null,
  }
}
