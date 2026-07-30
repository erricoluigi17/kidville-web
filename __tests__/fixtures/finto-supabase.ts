import type { SupabaseClient } from '@supabase/supabase-js'

// =============================================================================
// Finto client Supabase che APPLICA DAVVERO i filtri `.eq()` / `.in()`.
//
// Perché non basta un mock "piatto" (quelli che rispondono sempre la stessa
// lista): con un mock piatto un test di isolamento per sede è verde anche se il
// filtro `.in('scuola_id', ...)` non c'è. Qui le righe vengono filtrate come le
// filtrerebbe PostgREST, quindi «il docente della sede A non vede gli alunni
// della sede B» è una proprietà VERIFICATA, non asserita.
//
// Supporta anche i filtri su risorsa EMBEDDED (`.eq('alunni.classe_sezione', x)`,
// `.in('alunni.scuola_id', [...])`): la riga porta l'oggetto (o l'array) annidato
// e il confronto si fa sul campo interno, come col join `!inner`.
// =============================================================================

export type Riga = Record<string, unknown>
export type DBFinto = Record<string, Riga[]>

interface Filtro {
  colonna: string
  valori: unknown[]
}

/** Valori confrontabili di una colonna, anche annidata (`alunni.scuola_id`). */
function valoriDi(riga: Riga, colonna: string): unknown[] {
  if (!colonna.includes('.')) return [riga[colonna]]
  const [radice, campo] = colonna.split('.')
  const nodo = riga[radice]
  if (nodo == null) return []
  const nodi = Array.isArray(nodo) ? (nodo as Riga[]) : [nodo as Riga]
  return nodi.map((n) => n[campo])
}

/**
 * @param db          tabella → righe (mutabile dal test fra un caso e l'altro)
 * @param tabelleLette accumulatore dei `from(<tabella>)` eseguiti: serve a
 *                     provare che dopo un 403 la route NON ha letto gli alunni.
 */
export function creaFintoSupabase(db: DBFinto, tabelleLette: string[] = []): SupabaseClient {
  const client = {
    from(tabella: string) {
      tabelleLette.push(tabella)
      const filtri: Filtro[] = []
      let massimo: number | null = null

      const righe = (): Riga[] => {
        const out = (db[tabella] ?? []).filter((r) =>
          filtri.every((f) => valoriDi(r, f.colonna).some((v) => f.valori.includes(v))),
        )
        return massimo == null ? out : out.slice(0, massimo)
      }

      const b: Record<string, unknown> = {}
      b.select = () => b
      b.order = () => b
      // Operatori che il finto client NON emula (non servono all'isolamento per
      // sede): passano avanti la catena senza filtrare nulla.
      b.gte = () => b
      b.lte = () => b
      b.not = () => b
      b.or = () => b
      b.neq = () => b
      b.is = () => b
      b.eq = (colonna: string, valore: unknown) => {
        filtri.push({ colonna, valori: [valore] })
        return b
      }
      b.in = (colonna: string, valori: unknown[]) => {
        filtri.push({ colonna, valori: valori ?? [] })
        return b
      }
      b.limit = (n: number) => {
        massimo = n
        return b
      }
      b.maybeSingle = async () => ({ data: righe()[0] ?? null, error: null })
      b.single = async () => {
        const r = righe()[0] ?? null
        return { data: r, error: r ? null : { code: 'PGRST116', message: 'nessuna riga' } }
      }
      // Thenable: `await query` senza terminatore (liste).
      b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve({ data: righe(), error: null }).then(ok, ko)
      return b
    },
  }
  return client as unknown as SupabaseClient
}
