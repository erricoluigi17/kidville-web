import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { caricaLegamiRetta } from './rette-a-carico-server'
import { testoPaganteIt } from './rette-a-carico'
import { leggiABlocchi } from './leggi-a-blocchi'

/** Una riga del foglio «Scadenzario»: le chiavi SONO le intestazioni delle colonne. */
export interface RigaScadenzario {
  Sede: string
  Alunno: string
  Sezione: string
  Categoria: string
  Descrizione: string
  Scadenza: string
  'Importo €': number
  'Pagato €': number
  'Residuo €': number
  Stato: string
  Fattura: string
}

interface OpzioniExport {
  /** Il perimetro dell'export: la sede dichiarata, o le sedi attive. */
  sediBambini: string[]
  /** Le sedi accessibili all'utente (dove si possono leggere pagante e rette). */
  sediPaganti: string[]
  sectionIds?: string[]
  stato?: string
  /** Il filtro categoria dell'export: «solo Mensa» non deve ricevere righe di retta. */
  categoriaId?: string
  nomiSedi: Map<string, string>
  etichettaStato: (stato: string) => string
}

interface RigaRetta {
  alunno_id: string
  descrizione: string
  scadenza: string | null
  periodo_competenza: string | null
  stato: string
  tipo: string | null
  payment_categories: { nome?: string | null; slug?: string | null } | null
}

const OPERAZIONE = 'pagamenti/export:GET'

/**
 * D14 — per ogni retta del fratello che paga, una riga per il bambino a carico: importi a
 * ZERO (i totali dell'Excel non raddoppiano) e, in «Stato», chi paga e come sta la sua
 * retta — la stessa frase del cruscotto.
 *
 * Le rette si leggono con una query A PARTE, ristretta agli uuid dei legami: le righe
 * principali dell'export restano quelle di prima, filtri compresi, e queste non dipendono
 * da quali di quelle sono passate (il filtro classi guarda il BAMBINO, come a schermo).
 *
 * Un guasto qui NON fa fallire l'export: esce senza le righe in più, e lo si logga.
 *
 * Le rette si leggono A BLOCCHI (C2, 2026-09-28): la query prende tutto lo storico dei
 * paganti e dei bambini a carico, e PostgREST l'avrebbe tagliata a 1000 righe in silenzio —
 * i mesi oltre il taglio sarebbero spariti dall'Excel senza un avviso.
 */
export async function righeRetteACarico(supabase: SupabaseClient, o: OpzioniExport): Promise<RigaScadenzario[]> {
  const esito = await caricaLegamiRetta(supabase, { sediBambini: o.sediBambini, sediPaganti: o.sediPaganti, operazione: OPERAZIONE })
  if (!esito.ok) {
    logEvento('pagamento', 'error', {
      operazione: OPERAZIONE, esito: 'export-senza-righe-a-carico',
      msg: 'legami non letti: l’export esce senza le righe dei bambini a carico di un fratello',
    })
    return []
  }
  const legami = o.sectionIds
    ? esito.legami.filter((l) => l.alunno.section_id != null && o.sectionIds!.includes(l.alunno.section_id))
    : esito.legami
  if (legami.length === 0) return []

  const ids = [...new Set(legami.flatMap((l) => [l.pagante.id, l.alunno_id]))]
  // `scadenza` e poi `id` (lo aggiunge `leggiABlocchi`): «la prima retta del mese» qui sotto
  // presuppone l'ordine per scadenza, e fra pari scadenza i blocchi non devono sovrapporsi.
  const costruisci = () => {
    let query = supabase
      .from('pagamenti')
      .select('alunno_id, descrizione, scadenza, periodo_competenza, stato, tipo, payment_categories!inner ( nome, slug )')
      .in('alunno_id', ids)
      .in('scuola_id', o.sediPaganti)
      .eq('payment_categories.slug', 'retta')
      .order('scadenza', { ascending: true })
    // Lo stesso filtro delle righe principali: se la categoria scelta non è una retta, nessuna riga.
    if (o.categoriaId) query = query.eq('categoria_id', o.categoriaId)
    return query
  }
  const lette = await leggiABlocchi<RigaRetta>(costruisci, { operazione: OPERAZIONE, tipo: 'export-rette-paganti' })
  if (!lette.ok) {
    logEvento('pagamento', 'error', { operazione: OPERAZIONE, esito: 'export-rette-paganti-non-lette', n: ids.length }, lette.error)
    return []
  }

  // Per alunno: i mesi con una retta PROPRIA (D9), e la prima retta di ogni mese per scadenza.
  const mesiPropri = new Map<string, Set<string>>()
  const primaDelMese = new Map<string, Map<string, RigaRetta>>()
  for (const r of lette.righe) {
    if (r.tipo === 'padre' || !r.periodo_competenza) continue
    const mesi = mesiPropri.get(r.alunno_id) ?? new Set<string>()
    mesi.add(r.periodo_competenza)
    mesiPropri.set(r.alunno_id, mesi)
    const perMese = primaDelMese.get(r.alunno_id) ?? new Map<string, RigaRetta>()
    if (!perMese.has(r.periodo_competenza)) perMese.set(r.periodo_competenza, r)
    primaDelMese.set(r.alunno_id, perMese)
  }

  const out: RigaScadenzario[] = []
  for (const l of legami) {
    const rette = primaDelMese.get(l.pagante.id)
    if (!rette) continue
    for (const [mese, r] of rette) {
      if (o.stato && r.stato !== o.stato) continue
      if (mesiPropri.get(l.alunno_id)?.has(mese)) continue
      out.push({
        Sede: l.scuola_id ? (o.nomiSedi.get(l.scuola_id) ?? '') : '',
        Alunno: [l.alunno.nome, l.alunno.cognome].filter(Boolean).join(' '),
        Sezione: l.alunno.classe_sezione ?? '',
        Categoria: r.payment_categories?.nome ?? '',
        Descrizione: r.descrizione,
        Scadenza: r.scadenza ?? '',
        'Importo €': 0,
        'Pagato €': 0,
        'Residuo €': 0,
        Stato: testoPaganteIt(l.pagante, o.etichettaStato(r.stato)),
        Fattura: '',
      })
    }
  }
  return out
}
