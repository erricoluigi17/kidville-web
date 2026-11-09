/**
 * Un client Supabase FINTO a tabelle (PR 4.7): le letture APPLICANO davvero `eq`, `in`, `lt`, `is`, `order`, `limit` e `range` alle
 * righe date, e restituiscono `{ data, error, count }` come PostgREST. Serve a misurare il codice e non il finto: un filtro tolto dal
 * codice cambia le righe che tornano. Registra ogni richiesta (tabella, colonne scelte, filtri) per le prove che guardano COSA si legge.
 *
 * Non scrive niente: la 4.7 legge soltanto. Solo dati finti.
 */

export type Riga = Record<string, unknown>
export type ErroreFinto = { code?: string; message?: string }
export type Richiesta = { tabella: string; colonne?: string; filtri: Record<string, unknown>; range?: [number, number] }

export function clientTabelle(
  tabelle: () => Record<string, Riga[]>,
  errori: () => Record<string, ErroreFinto | undefined>,
  richieste: Richiesta[],
) {
  return {
    from: (tabella: string) => {
      const q: Richiesta = { tabella, filtri: {} }
      richieste.push(q)
      const cond: Array<(r: Riga) => boolean> = []
      let ordine: { col: string; asc: boolean } | null = null
      let tetto: number | null = null
      const b: Record<string, unknown> = {}
      b.select = (colonne?: string) => {
        q.colonne = colonne
        return b
      }
      b.eq = (c: string, v: unknown) => {
        q.filtri[c] = v
        cond.push((r) => r[c] === v)
        return b
      }
      b.in = (c: string, v: unknown[]) => {
        q.filtri[`in:${c}`] = v
        cond.push((r) => v.includes(r[c]))
        return b
      }
      b.lt = (c: string, v: string) => {
        q.filtri[`lt:${c}`] = v
        cond.push((r) => String(r[c]) < v)
        return b
      }
      b.is = (c: string, v: null) => {
        q.filtri[`is:${c}`] = v
        cond.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v))
        return b
      }
      b.order = (col: string, o?: { ascending?: boolean }) => {
        ordine = { col, asc: o?.ascending !== false }
        return b
      }
      b.limit = (n: number) => {
        tetto = n
        return b
      }
      b.range = (da: number, a: number) => {
        q.range = [da, a]
        return b
      }
      const risolvi = () => {
        const errore = errori()[tabella]
        if (errore) return { data: null, error: errore, count: null }
        let r = (tabelle()[tabella] ?? []).filter((x) => cond.every((c) => c(x)))
        if (ordine) {
          const { col, asc } = ordine
          r = [...r].sort((x, y) => (asc ? 1 : -1) * String(x[col]).localeCompare(String(y[col])))
        }
        const totale = r.length
        if (tetto !== null) r = r.slice(0, tetto)
        if (q.range) r = r.slice(q.range[0], q.range[1] + 1)
        return { data: r, error: null, count: totale }
      }
      b.maybeSingle = async () => {
        const x = risolvi()
        return x.error ? x : { data: (x.data as Riga[])[0] ?? null, error: null }
      }
      b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(risolvi()).then(ok, ko)
      return b
    },
  }
}
