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
  descrizione: string
  alunno: string
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

export async function leggiAssociazione(
  supabase: SupabaseClient,
  mov: MovimentoLetto,
  operazione: string,
): Promise<EsitoAssociazione> {
  if (mov.stato !== 'confermato') return { associazione: null, ancora: null }

  // 1. Quanto il bonifico ha messo su ciascuna voce
  const incassatoPerVoce = new Map<string, number>()
  if (mov.transazione_id) {
    const { data, error } = await supabase
      .from('incassi')
      .select('pagamento_id, importo, stornato_il, storno_di')
      .eq('transazione_id', mov.transazione_id)
    if (error) return { guasto: error }
    for (const r of (data ?? []) as RigaIncasso[]) {
      if (!incassoVivo(r)) continue
      incassatoPerVoce.set(r.pagamento_id, (incassatoPerVoce.get(r.pagamento_id) ?? 0) + Number(r.importo))
    }
  } else if (mov.incasso_id) {
    // Stesse colonne del ramo composito, e per la stessa ragione: un incasso
    // stornato a mano dal registro (senza riaprire il movimento) non porta più
    // denaro sulla voce, e il popup non deve dire il contrario.
    const { data, error } = await supabase
      .from('incassi')
      .select('pagamento_id, importo, stornato_il, storno_di')
      .eq('id', mov.incasso_id)
      .maybeSingle()
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
