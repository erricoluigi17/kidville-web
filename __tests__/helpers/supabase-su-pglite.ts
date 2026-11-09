import type { PGlite } from '@electric-sql/pglite'

/**
 * UN CLIENT `supabase-js` MINIMO SOPRA PGLITE (4.5.15).
 *
 * Serve a far girare il codice VERO di `src/lib/anno/` (la porta dell'iscrizione, `scriviFrequenza`, le guardie dell'eliminazione di
 * una voce) contro il SQL vero delle migrazioni, invece che contro un finto che risponde quello che il test gli dice. Fino ad ora le
 * prove sul database e quelle sul codice stavano in due mondi: nessuna vedeva una frequenza ritirata dal TypeScript e riaperta dal SQL.
 *
 * Copre SOLO ciò che quel codice usa: `from(t).select/insert/update/delete` con `eq`, `neq`, `in`, `is`, `not(c,'is',v)`, `lt`, `gt`,
 * `order`, `limit`, `maybeSingle`, `single`; e `rpc(nome, args)` in notazione per nome. Un metodo che non c'è LANCIA: un finto che
 * ignora in silenzio un filtro sarebbe verde anche quando il codice sbaglia.
 *
 * Gli errori di SQL tornano come `{ data: null, error: { code, message } }` (PostgREST non lancia). Ogni istruzione gira dentro un
 * SAVEPOINT, così un errore (una tabella che nel banco non c'è: `42P01`) non rovina la transazione del test. Va usato DENTRO una
 * transazione aperta dal test.
 */

/** PostgREST risponde con le date e gli istanti come TESTO (`2027-09-01`): il codice li confronta come stringhe. PGlite li darebbe come `Date`. */
const COME_TESTO = { parsers: { 1082: (v: string) => v, 1114: (v: string) => v, 1184: (v: string) => v } }

type Filtro = { colonna: string; op: 'eq' | 'neq' | 'in' | 'is' | 'notis' | 'lt' | 'gt'; valore: unknown }
type Risultato = { data: unknown; error: { code?: string; message: string } | null }

const ident = (nome: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(nome)) throw new Error(`identificatore non ammesso: ${nome}`)
  return nome
}
const colonne = (c: string) => (c.trim() === '*' ? '*' : c.split(',').map((x) => ident(x.trim())).join(', '))
const param = (v: unknown) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)

class Query implements PromiseLike<Risultato> {
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select'
  private cols = '*'
  private ritorna: string | null = null
  private filtri: Filtro[] = []
  private ordine: string | null = null
  private limite: number | null = null
  private scarto = 0
  private singola: 'no' | 'maybe' | 'one' = 'no'
  private payload: Record<string, unknown> | null = null

  constructor(private db: PGlite, private tabella: string) {}

  select(cols = '*') {
    if (this.op === 'select') this.cols = cols
    else this.ritorna = cols
    return this
  }
  insert(p: Record<string, unknown>) { this.op = 'insert'; this.payload = p; return this }
  update(p: Record<string, unknown>) { this.op = 'update'; this.payload = p; return this }
  delete() { this.op = 'delete'; return this }
  eq(colonna: string, valore: unknown) { this.filtri.push({ colonna, op: 'eq', valore }); return this }
  neq(colonna: string, valore: unknown) { this.filtri.push({ colonna, op: 'neq', valore }); return this }
  in(colonna: string, valore: unknown[]) { this.filtri.push({ colonna, op: 'in', valore }); return this }
  is(colonna: string, valore: unknown) { this.filtri.push({ colonna, op: 'is', valore }); return this }
  lt(colonna: string, valore: unknown) { this.filtri.push({ colonna, op: 'lt', valore }); return this }
  gt(colonna: string, valore: unknown) { this.filtri.push({ colonna, op: 'gt', valore }); return this }
  not(colonna: string, op: string, valore: unknown) {
    if (op !== 'is') throw new Error(`not(…, '${op}') non è nel finto`)
    this.filtri.push({ colonna, op: 'notis', valore })
    return this
  }
  order(colonna: string, o?: { ascending?: boolean }) { this.ordine = `${ident(colonna)} ${o?.ascending === false ? 'DESC' : 'ASC'}`; return this }
  limit(n: number) { this.limite = n; return this }
  range(da: number, a: number) { this.scarto = da; this.limite = a - da + 1; return this }
  maybeSingle() { this.singola = 'maybe'; return this }
  single() { this.singola = 'one'; return this }

  private where(params: unknown[]): string {
    if (this.filtri.length === 0) return ''
    const parti = this.filtri.map((f) => {
      const c = ident(f.colonna)
      switch (f.op) {
        case 'eq': params.push(f.valore); return `${c} = $${params.length}`
        case 'neq': params.push(f.valore); return `${c} IS DISTINCT FROM $${params.length}`
        case 'lt': params.push(f.valore); return `${c} < $${params.length}`
        case 'gt': params.push(f.valore); return `${c} > $${params.length}`
        case 'in': params.push(f.valore); return `${c} = ANY ($${params.length})`
        case 'is': return f.valore === null ? `${c} IS NULL` : `${c} IS ${f.valore ? 'TRUE' : 'FALSE'}`
        case 'notis': return f.valore === null ? `${c} IS NOT NULL` : `${c} IS NOT ${f.valore ? 'TRUE' : 'FALSE'}`
      }
    })
    return ` WHERE ${parti.join(' AND ')}`
  }

  private sql(): { testo: string; params: unknown[] } {
    const t = `public.${ident(this.tabella)}`
    const params: unknown[] = []
    if (this.op === 'select') {
      const w = this.where(params)
      return { testo: `SELECT ${colonne(this.cols)} FROM ${t}${w}${this.ordine ? ` ORDER BY ${this.ordine}` : ''}${this.limite !== null ? ` LIMIT ${this.limite}` : ''}${this.scarto > 0 ? ` OFFSET ${this.scarto}` : ''}`, params }
    }
    const ritorno = this.ritorna ? ` RETURNING ${colonne(this.ritorna)}` : ''
    if (this.op === 'insert') {
      const chiavi = Object.keys(this.payload ?? {})
      chiavi.forEach((k) => params.push(param((this.payload as Record<string, unknown>)[k])))
      return { testo: `INSERT INTO ${t} (${chiavi.map(ident).join(', ')}) VALUES (${chiavi.map((_, i) => `$${i + 1}`).join(', ')})${ritorno}`, params }
    }
    if (this.op === 'update') {
      const chiavi = Object.keys(this.payload ?? {})
      const set = chiavi.map((k) => { params.push(param((this.payload as Record<string, unknown>)[k])); return `${ident(k)} = $${params.length}` })
      const w = this.where(params)
      return { testo: `UPDATE ${t} SET ${set.join(', ')}${w}${ritorno}`, params }
    }
    const w = this.where(params)
    return { testo: `DELETE FROM ${t}${w}${ritorno}`, params }
  }

  async esegui(): Promise<Risultato> {
    {
      const { testo, params } = this.sql()
      await this.db.exec('SAVEPOINT finto')
      try {
        const r = await this.db.query<Record<string, unknown>>(testo, params, COME_TESTO)
        await this.db.exec('RELEASE SAVEPOINT finto')
        if (this.singola !== 'no') {
          if (r.rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'più righe' } }
          if (r.rows.length === 0) return this.singola === 'one' ? { data: null, error: { code: 'PGRST116', message: 'nessuna riga' } } : { data: null, error: null }
          return { data: r.rows[0], error: null }
        }
        return { data: this.op === 'select' || this.ritorna ? r.rows : null, error: null }
      } catch (e) {
        await this.db.exec('ROLLBACK TO SAVEPOINT finto')
        await this.db.exec('RELEASE SAVEPOINT finto')
        const err = e as { code?: string; message?: string }
        return { data: null, error: { code: err.code, message: err.message ?? 'errore' } }
      }
    }
  }

  then<R1 = Risultato, R2 = never>(ok?: ((v: Risultato) => R1 | PromiseLike<R1>) | null, ko?: ((e: unknown) => R2 | PromiseLike<R2>) | null): PromiseLike<R1 | R2> {
    return this.esegui().then(ok, ko)
  }
}

export function clienteSuPglite(db: PGlite) {
  return {
    from: (tabella: string) => new Query(db, tabella),
    async rpc(nome: string, args: Record<string, unknown> = {}): Promise<Risultato> {
      const chiavi = Object.keys(args)
      const params = chiavi.map((k) => param(args[k]))
      const testo = `SELECT * FROM public.${ident(nome)}(${chiavi.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')})`
      await db.exec('SAVEPOINT finto_rpc')
      try {
        const r = await db.query<Record<string, unknown>>(testo, params, COME_TESTO)
        await db.exec('RELEASE SAVEPOINT finto_rpc')
        // una funzione che torna un solo valore ha una colonna col suo nome (jsonb, uuid…); altrimenti è un insieme di righe
        const prima = r.rows[0]
        if (prima && Object.keys(prima).length === 1 && Object.keys(prima)[0] === nome) return { data: prima[nome], error: null }
        return { data: r.rows, error: null }
      } catch (e) {
        await db.exec('ROLLBACK TO SAVEPOINT finto_rpc')
        await db.exec('RELEASE SAVEPOINT finto_rpc')
        const err = e as { code?: string; message?: string }
        return { data: null, error: { code: err.code, message: err.message ?? 'errore' } }
      }
    },
  }
}
