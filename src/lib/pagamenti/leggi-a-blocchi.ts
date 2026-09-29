/**
 * ─── LEGGERE TUTTO, A BLOCCHI (revisione 2026-09-28) ────────────────────────────────
 *
 * PostgREST taglia OGNI risposta a `max_rows` righe e non lo dice: nessun errore, nessuna
 * intestazione che il client guardi. L'export dello Scadenzario leggeva senza `range`, e il
 * 28/09 in produzione i pagamenti esportabili nelle tre sedi erano 1.150: l'export «tutte le
 * sedi» ne consegnava 1000, e le 150 mancanti non lasciavano traccia né nel file né nei log.
 *
 * Il modello è `leggiTutte` in `src/app/api/pagamenti/route.ts` (K1): blocchi di `BLOCCO`
 * righe fino al primo blocco CORTO, tetto di blocchi, riga di prova al tetto. E, come lì, AL
 * TETTO LA LETTURA È UN GUASTO (`ok: false`, `motivo: 'tetto'`), senza righe. Fino alla
 * seconda revisione del 28/09 (K5) qui si consegnava ciò che era stato letto con
 * `troncata: true`, e nessun chiamante lo guardava: l'export usciva 200 e incompleto, e nel
 * ramo AdE era una comunicazione all'Agenzia delle Entrate con delle spese in meno, senza un
 * segnale nel file. Un file incompleto che sembra intero è peggio di un errore.
 *
 * L'ORDINE STABILE. Postgres non garantisce l'ordine fra righe con la stessa chiave di
 * ordinamento (e le rette hanno TUTTE la stessa scadenza nel mese), né che resti lo stesso
 * fra due richieste: senza un criterio univoco due blocchi `range` consecutivi si
 * sovrappongono e perdono righe. Per questo `id` lo aggiunge QUI, in coda all'ordine del
 * chiamante: chi usa questo modulo non può dimenticarlo.
 *
 * Tutto-o-niente: un blocco che fallisce (`motivo: 'errore'`) o il tetto toccato
 * (`motivo: 'tetto'`) fanno fallire la lettura. Una tabella a cui manca un pezzo, presentata
 * come intera, è il difetto che questo modulo toglie.
 *
 * CHI LOGGA COSA — QUESTO MODULO NON LOGGA MAI, e non alza la marca anti-doppione di
 * `withRoute`. Lo fa chi chiama, UNA riga per guasto, perché solo lui sa che cosa risponderà:
 *  · se risponde 500 (l'export, `letturaFallita` nella route) scrive la riga con `logErrore` e
 *    `stato: 500` — `evento: 'lettura-troncata'` al tetto, `'db'` sull'errore del blocco — e
 *    `logErrore` alza la marca, così `withRoute` non aggiunge una seconda riga più povera.
 *    È ciò che fa `leggiTutte` di `GET /api/pagamenti` (K1);
 *  · se risponde 200 senza un pezzo accessorio (le righe dei bambini a carico,
 *    `export-rette-a-carico.ts`) scrive un `logEvento('pagamento', 'error', { esito:
 *    'lettura-troncata', tipo, n, blocchi, oltre, msg })`, senza `stato`, e la marca resta giù:
 *    non c'è nessun 5xx da dichiarare.
 * Fino alla terza revisione (R2, 2026-09-29) il tetto lo loggava QUI, con `logEvento` e senza
 * `stato`, e alzava la marca: sul 500 dell'export `withRoute` taceva, e nei log non c'era
 * nessuna riga con `stato: 500` per quella richiesta — fuori dal filtro «dammi i 5xx». Per
 * questo il tetto consegna i conteggi (`n` righe lette, soglia `oltre`): servono al log di chi
 * chiama, e sono solo numeri (AGENTS.md, regola 8).
 *
 * UNA FORMA SOLA PER IL TETTO (Q2, quarta revisione 2026-09-29). Le due righe qui sopra non
 * possono essere identiche: `logErrore` (il 500) accetta solo `operazione`, `stato`, `evento` e
 * `ms`, quindi tipo e conteggi non li può portare come campi — li porta nel messaggio; `logEvento`
 * (il 200) sì, e li porta come campi. Ciò che le rende UNA forma interrogabile è il MESSAGGIO, cioè
 * la colonna `app_log.messaggio`: in entrambe comincia con ciò che `descriviTetto` scrive,
 * «lettura-troncata: <tipo> oltre <soglia> righe (<n> lette in <b> blocchi)». Una ricerca sola
 * (`messaggio like 'lettura-troncata:%'`, che prende anche `leggiTutte`) le trova tutte;
 * `stato_http` = 500 distingue l'export rifiutato da quello uscito senza le righe a carico.
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
  | { ok: true; righe: T[]; blocchi: number }
  /** Un blocco (o la riga di prova) ha risposto `{ error }`: lo logga chi chiama. */
  | { ok: false; motivo: 'errore'; error: unknown; blocchi: number }
  /**
   * Oltre `oltre` (= `maxBlocchi × blocco`) righe: nessuna riga consegnata, e NON loggato qui.
   * `n` = le righe lette prima del tetto: un conteggio per il log di chi chiama.
   */
  | { ok: false; motivo: 'tetto'; blocchi: number; n: number; oltre: number }

/**
 * L'inizio del messaggio di OGNI riga di log del tetto (vedi «UNA FORMA SOLA PER IL TETTO»):
 * `tipo` dice quale lettura (`export-scadenzario`, `export-rette-paganti`, …), poi soltanto
 * numeri. Chi chiama aggiunge la conseguenza dopo: «, rifiutata per intero» (500) o «: l'export
 * esce senza …» (200).
 */
export function descriviTetto(tipo: string, t: { oltre: number; n: number; blocchi: number }): string {
  return `lettura-troncata: ${tipo} oltre ${t.oltre} righe (${t.n} lette in ${t.blocchi} blocchi)`
}

interface OpzioniABlocchi {
  /** Solo per i test: il blocco e il tetto veri sono le costanti qui sopra. */
  blocco?: number
  maxBlocchi?: number
}

/**
 * Legge tutte le righe della query che `costruisci` produce — una query NUOVA per ogni blocco,
 * perché il builder di PostgREST si modifica a ogni `.order()`/`.range()`.
 */
export async function leggiABlocchi<T>(costruisci: () => QueryABlocchi, o: OpzioniABlocchi = {}): Promise<EsitoABlocchi<T>> {
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
      if (prova.error) return { ok: false, motivo: 'errore', error: prova.error, blocchi }
      if (((prova.data ?? []) as unknown[]).length === 0) return { ok: true, righe, blocchi }
      // Nessun log qui (vedi «CHI LOGGA COSA»): i conteggi vanno a chi chiama.
      return { ok: false, motivo: 'tetto', blocchi, n: righe.length, oltre }
    }
    const da = blocchi * blocco
    const { data, error } = await pagina(da, da + blocco - 1)
    blocchi++
    if (error) return { ok: false, motivo: 'errore', error, blocchi }
    const arrivate = (data ?? []) as T[]
    righe.push(...arrivate)
    if (arrivate.length < blocco) return { ok: true, righe, blocchi }
  }
}
