import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { formaConfronto } from '@/lib/auth/scope'
import { caricaLegamiRetta } from './rette-a-carico-server'
import { testoPaganteIt } from './rette-a-carico'
import { descriviTetto, leggiABlocchi } from './leggi-a-blocchi'
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi'

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
  /**
   * Dove si possono leggere pagante e rette: `sediDeiPaganti(sediBambini, accessibili)`, cioè le
   * sedi dei bambini ∪ quelle accessibili all'utente — non le sole accessibili (K4: se la loro
   * lettura fallisce sono `[]`, e le sedi dei bambini restano).
   */
  sediPaganti: string[]
  sectionIds?: string[]
  stato?: string
  /** Il filtro categoria dell'export: «solo Mensa» non deve ricevere righe di retta. */
  categoriaId?: string
  nomiSedi: Map<string, string>
  /** Sempre una stringa, anche per lo stato NULL (K1): vuota = la frase senza « · stato». */
  etichettaStato: (stato: string | null) => string
}

interface RigaRetta {
  alunno_id: string
  descrizione: string
  scadenza: string | null
  periodo_competenza: string | null
  /** Nullable in produzione (K1). */
  stato: string | null
  tipo: string | null
  payment_categories: { nome?: string | null; slug?: string | null } | null
}

const OPERAZIONE = 'pagamenti/export:GET'

/**
 * D14 — per ogni retta del fratello che paga, una riga per il bambino a carico: importi a
 * ZERO (i totali dell'Excel non raddoppiano) e, in «Stato», chi paga e come sta la sua
 * retta — la stessa frase del cruscotto per i quattro stati noti; per uno stato NULL o
 * sconosciuto ciascun mezzo segue la propria riga del pagante (vedi `rette-a-carico.ts`).
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
    // «Chi chiama logga» (Q1, quarta revisione 2026-09-29): il loader restituisce il guasto e non
    // lo scrive. UNA riga, qui, con la causa vera: `logEvento` error e NON `logErrore`, e senza
    // `stato` — l'export risponde 200 (senza le righe dei bambini a carico), non c'è un 5xx da
    // dichiarare, e la marca anti-doppione di `withRoute` resta giù. L'`esito` è quello della
    // lettura fallita, lo stesso che la GET del cruscotto scrive in `evento` sul suo 500.
    // Fino alla terza revisione la causa la scriveva il loader e qui si aggiungeva una riga `info`
    // (`export-senza-righe-a-carico`) per la conseguenza: ora la dice `operazione`.
    logEvento('pagamento', 'error', { operazione: OPERAZIONE, esito: esito.esito, n: esito.n }, esito.errore)
    return []
  }
  // Il filtro classi senza maiuscole (R9, terza revisione): `section_ids` arriva dalla query
  // così come l'ha scritto il client, e PostgREST — che confronta `uuid`, un TIPO — trova la
  // riga anche in maiuscolo. Con `includes` le righe principali c'erano e queste sparivano.
  const sezioni = o.sectionIds ? new Set(o.sectionIds.map(formaConfronto)) : null
  const legami = sezioni
    ? esito.legami.filter((l) => l.alunno.section_id != null && sezioni.has(formaConfronto(l.alunno.section_id)))
    : esito.legami
  if (legami.length === 0) return []

  const ids = [...new Set(legami.flatMap((l) => [l.pagante.id, l.alunno_id]))]
  const righeLette: RigaRetta[] = []
  // DUE BLOCCHI, uno dentro l'altro (R8, terza revisione 2026-09-29):
  //  · gli id a pezzi di `ID_PER_QUERY` (`@/lib/db/blocchi`): `.in()` finisce nell'URL, e la
  //    lista intera cresce di due id per famiglia a carico. Cento uuid (~3.800 caratteri) stanno
  //    comodi sotto il limite di riga dei proxy, mille (~38 kB) prenderebbero un 414: il tetto
  //    impedisce che la lettura si rompa da sola il giorno in cui l'elenco cresce;
  //  · ogni pezzo letto a blocchi di `range` (`leggiABlocchi`), perché lo storico delle rette di
  //    cento alunni passa comunque le 1000 righe di PostgREST.
  // Unire i pezzi è corretto così come vengono: il calcolo qui sotto è PER ALUNNO, e ogni alunno
  // sta in un solo pezzo — l'ordine per `scadenza` delle sue rette resta quello della sua lettura.
  // Tutto-o-niente anche fra i pezzi: uno che fallisce toglie TUTTE le righe in più.
  for (const pezzo of aBlocchi(ids, ID_PER_QUERY)) {
    // `scadenza` e poi `id` (lo aggiunge `leggiABlocchi`): «la prima retta del mese» qui sotto
    // presuppone l'ordine per scadenza, e fra pari scadenza i blocchi non devono sovrapporsi.
    const costruisci = () => {
      let query = supabase
        .from('pagamenti')
        .select('alunno_id, descrizione, scadenza, periodo_competenza, stato, tipo, payment_categories!inner ( nome, slug )')
        .in('alunno_id', pezzo)
        .in('scuola_id', o.sediPaganti)
        .eq('payment_categories.slug', 'retta')
        .order('scadenza', { ascending: true })
      // Lo stesso filtro delle righe principali: se la categoria scelta non è una retta, nessuna riga.
      if (o.categoriaId) query = query.eq('categoria_id', o.categoriaId)
      return query
    }
    const lette = await leggiABlocchi<RigaRetta>(costruisci)
    if (!lette.ok) {
      // Al tetto (K5) come per ogni altro guasto di questa informazione accessoria: NESSUNA riga
      // in più, mai una parte. `leggiABlocchi` non logga (R2, terza revisione): la riga è UNA e
      // la scrive qui, con `logEvento` e non `logErrore` — l'export risponde 200, non c'è un 5xx
      // da dichiarare, e la marca anti-doppione di `withRoute` resta giù. Solo conteggi.
      // Q2 (quarta revisione 2026-09-29): tipo e conteggi come CAMPI (`tipo` passa la lista bianca
      // di `redact`, i numeri pure) E, nel messaggio, la stessa forma dei tetti dello Scadenzario
      // e dell'AdE, che sono `logErrore` e i campi non li possono portare (`descriviTetto`).
      if (lette.motivo === 'tetto') {
        const tipo = 'export-rette-paganti'
        logEvento('pagamento', 'error', {
          operazione: OPERAZIONE, esito: 'lettura-troncata', tipo, n: lette.n, blocchi: lette.blocchi, oltre: lette.oltre,
          msg: `${descriviTetto(tipo, lette)}: l’export esce senza le righe dei bambini a carico (nessuna, mai una parte)`,
        })
      } else {
        logEvento('pagamento', 'error', { operazione: OPERAZIONE, esito: 'export-rette-paganti-non-lette', n: ids.length }, lette.error)
      }
      return []
    }
    righeLette.push(...lette.righe)
  }

  // Per alunno: i mesi con una retta PROPRIA (D9), e la prima retta di ogni mese per scadenza.
  const mesiPropri = new Map<string, Set<string>>()
  const primaDelMese = new Map<string, Map<string, RigaRetta>>()
  for (const r of righeLette) {
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
