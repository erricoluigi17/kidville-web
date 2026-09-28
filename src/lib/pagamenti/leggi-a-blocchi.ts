import { logEvento } from '@/lib/logging/logger'

/**
 * ─── LEGGERE TUTTO, A BLOCCHI (revisione 2026-09-28) ────────────────────────────────
 *
 * PostgREST taglia OGNI risposta a `max_rows` righe e non lo dice: nessun errore, nessuna
 * intestazione che il client guardi. L'export dello Scadenzario leggeva senza `range`, e il
 * 28/09 in produzione i pagamenti esportabili nelle tre sedi erano 1.150: l'export «tutte le
 * sedi» ne consegnava 1000, e le 150 mancanti non lasciavano traccia né nel file né nei log.
 *
 * Il modello è `leggiTutte` in `src/app/api/pagamenti/route.ts` (K1): blocchi di `BLOCCO`
 * righe fino al primo blocco CORTO, tetto di blocchi, riga di prova al tetto. Una differenza
 * voluta: al tetto la GET del cruscotto risponde 500, mentre qui chi chiama riceve ciò che è
 * stato letto con `troncata: true`, e questo modulo lo logga a livello `error` — un export
 * è un file che la segreteria scarica adesso, e il log dice che è incompleto.
 *
 * L'ORDINE STABILE. Postgres non garantisce l'ordine fra righe con la stessa chiave di
 * ordinamento (e le rette hanno TUTTE la stessa scadenza nel mese), né che resti lo stesso
 * fra due richieste: senza un criterio univoco due blocchi `range` consecutivi si
 * sovrappongono e perdono righe. Per questo `id` lo aggiunge QUI, in coda all'ordine del
 * chiamante: chi usa questo modulo non può dimenticarlo.
 *
 * Tutto-o-niente: un blocco che fallisce fa fallire la lettura (`ok: false`). Una tabella a
 * cui manca un pezzo, presentata come intera, è il difetto che questo modulo toglie.
 */

/**
 * ⚠️ NON può superare `max_rows` (1000 in `supabase/config.toml` e nel progetto ospitato): la
 * lettura si ferma al primo blocco corto, e un blocco tagliato dal server sembrerebbe corto.
 * Se un giorno `max_rows` scende, questo numero scende con lui.
 */
export const BLOCCO_LETTURA = 1000
/** 50.000 righe: contro un ciclo senza fine, non un limite che una sede raggiunge. */
export const MAX_BLOCCHI_LETTURA = 50

/** Il minimo di un `PostgrestFilterBuilder` che serve qui. */
export interface QueryABlocchi {
  order(colonna: string, opzioni?: { ascending?: boolean }): QueryABlocchi
  range(da: number, a: number): PromiseLike<{ data: unknown; error: unknown }>
}

export type EsitoABlocchi<T> =
  | { ok: true; righe: T[]; blocchi: number; troncata: boolean }
  | { ok: false; error: unknown; blocchi: number }

interface OpzioniABlocchi {
  /** L'operazione che chiama, per il log del tetto (`pagamenti/export:GET`). */
  operazione: string
  /** Quale lettura (`export-scadenzario`, `export-ade-incassi`…): un enumerato, mai un dato. */
  tipo: string
  /** Solo per i test: il blocco e il tetto veri sono le costanti qui sopra. */
  blocco?: number
  maxBlocchi?: number
}

/**
 * Legge tutte le righe della query che `costruisci` produce — una query NUOVA per ogni blocco,
 * perché il builder di PostgREST si modifica a ogni `.order()`/`.range()`.
 */
export async function leggiABlocchi<T>(costruisci: () => QueryABlocchi, o: OpzioniABlocchi): Promise<EsitoABlocchi<T>> {
  const blocco = o.blocco ?? BLOCCO_LETTURA
  const maxBlocchi = o.maxBlocchi ?? MAX_BLOCCHI_LETTURA
  const pagina = (da: number, a: number) => costruisci().order('id', { ascending: true }).range(da, a)

  const righe: T[] = []
  let blocchi = 0
  for (;;) {
    if (blocchi === maxBlocchi) {
      // Al tetto non si indovina: una riga di prova dice se oltre c'è altro. Con esattamente
      // `maxBlocchi × blocco` righe la prova torna vuota, e nessun allarme è falso.
      const oltre = maxBlocchi * blocco
      const prova = await pagina(oltre, oltre)
      blocchi++
      if (prova.error) return { ok: false, error: prova.error, blocchi }
      const troncata = ((prova.data ?? []) as unknown[]).length > 0
      if (troncata) {
        // Solo conteggi: mai dati (AGENTS.md, regola 8).
        logEvento('pagamento', 'error', {
          operazione: o.operazione, esito: 'lettura-troncata', tipo: o.tipo, n: righe.length, blocchi,
          msg: `oltre ${oltre} righe: il file esce con le prime ${oltre}, ed è incompleto`,
        })
      }
      return { ok: true, righe, blocchi, troncata }
    }
    const da = blocchi * blocco
    const { data, error } = await pagina(da, da + blocco - 1)
    blocchi++
    if (error) return { ok: false, error, blocchi }
    const arrivate = (data ?? []) as T[]
    righe.push(...arrivate)
    if (arrivate.length < blocco) return { ok: true, righe, blocchi, troncata: false }
  }
}
