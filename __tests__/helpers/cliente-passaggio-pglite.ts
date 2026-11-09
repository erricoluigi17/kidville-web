// Il client di prova delle scritture del passaggio con le ROUTE VERE su PGlite (giro 3): `clienteSuPglite` più ciò che PostgREST fa e il
// finto no (`count: 'exact'` sulle righe del passaggio, `details` negli errori RPC, array come PostgREST), le letture in parallelo
// serializzate (i SAVEPOINT del finto non si intrecciano) e `.or()` nella sola forma di `filtraPerAnnoDiSede`. Solo uuid inventati.
import type { PGlite } from '@electric-sql/pglite'
import { clienteSuPglite } from './supabase-su-pglite'

const COME_TESTO = { parsers: { 1082: (v: string) => v, 1114: (v: string) => v, 1184: (v: string) => v } }

class RigheContate implements PromiseLike<unknown> {
  private filtri: Array<[string, unknown]> = []
  private dentro: Array<[string, unknown[]]> = []
  private nonNulli: string[] = []
  private cols = '*'
  private da = 0
  private a = 99
  constructor(private db: PGlite, private tabella = 'passaggi_anno_righe', private soloConteggio = false) {}
  select(c: string) { this.cols = c; return this }
  eq(c: string, v: unknown) { this.filtri.push([c, v]); return this }
  in(c: string, v: unknown[]) { this.dentro.push([c, v]); return this }
  not(c: string, op: string, v: unknown) {
    if (op !== 'is' || v !== null) throw new Error(`.not('${c}', '${op}') non è nel finto`)
    this.nonNulli.push(c)
    return this
  }
  order() { return this }
  range(da: number, a: number) { this.da = da; this.a = a; return this }
  private async esegui() {
    const w = [
      ...this.filtri.map(([c], i) => `${c} = $${i + 1}`),
      ...this.dentro.map(([c], i) => `${c} = ANY($${this.filtri.length + i + 1}::${c === 'id' || c.endsWith('_id') ? 'uuid' : 'text'}[])`),
      ...this.nonNulli.map((c) => `${c} IS NOT NULL`),
    ].join(' AND ')
    const p = [...this.filtri.map(([, v]) => v), ...this.dentro.map(([, v]) => `{${(v as unknown[]).join(',')}}`)]
    const n = await this.db.query<{ n: number }>(`SELECT count(*)::int n FROM public.${this.tabella} WHERE ${w}`, p)
    if (this.soloConteggio) return { data: null, error: null, count: n.rows[0].n }
    const r = await this.db.query(`SELECT ${this.cols} FROM public.${this.tabella} WHERE ${w} ORDER BY ${this.tabella === 'passaggi_anno_righe' ? 'alunno_id' : 'id'} LIMIT ${this.a - this.da + 1} OFFSET ${this.da}`, p, COME_TESTO)
    return { data: r.rows, error: null, count: n.rows[0].n }
  }
  then<R1, R2>(ok?: ((v: unknown) => R1 | PromiseLike<R1>) | null, ko?: ((e: unknown) => R2 | PromiseLike<R2>) | null) { return this.esegui().then(ok, ko) }
}

/** Le letture in parallelo (`Promise.all`) del codice vero intrecciano i SAVEPOINT del finto: qui uno alla volta, da SAVEPOINT a RELEASE. */
function serializzato(db: PGlite): PGlite {
  let coda: Promise<void> = Promise.resolve()
  let libera: (() => void) | null = null
  return new Proxy(db, {
    get(t, k) {
      if (k === 'exec') {
        return async (sql: string, ...r: unknown[]) => {
          if (/^SAVEPOINT /.test(sql)) {
            const prima = coda
            let fine!: () => void
            coda = new Promise<void>((res) => { fine = res })
            await prima
            libera = fine
          }
          try { return await (t.exec as (...a: unknown[]) => Promise<unknown>)(sql, ...r) } finally {
            if (/^RELEASE SAVEPOINT /.test(sql)) { const f = libera; libera = null; f?.() }
          }
        }
      }
      const v = Reflect.get(t, k)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
}

export function clienteProva(dbVero: PGlite) {
  const db = serializzato(dbVero)
  const c = clienteSuPglite(db) as unknown as { from: (t: string) => unknown; rpc: (n: string, a?: Record<string, unknown>) => Promise<unknown> }
  const da = c.from.bind(c)
  c.from = (t: string) => {
    if (t === 'passaggi_anno_righe') return new RigheContate(db)
    if (t === 'pagamenti') {
      // Il conteggio `select('id', { count: 'exact', head: true })` il finto non lo sa fare: lo fa qui; il resto passa com'è.
      const vero = da(t) as { select: (c: string, o?: { head?: boolean }) => unknown }
      const selezione = vero.select.bind(vero)
      vero.select = (cols, opts) => (opts?.head ? new RigheContate(db, 'pagamenti', true).select(cols) : selezione(cols, opts))
      return vero
    }
    return da(t)
  }
  c.rpc = async (nome: string, args: Record<string, unknown> = {}) => {
    const conv = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, Array.isArray(v) ? `{${v.join(',')}}` : v !== null && typeof v === 'object' ? JSON.stringify(v) : v]))
    const chiavi = Object.keys(conv)
    const testo = `SELECT * FROM public.${nome}(${chiavi.map((k, i) => `${k} => $${i + 1}`).join(', ')})`
    await db.exec('SAVEPOINT finto_rpc')
    try {
      const r = await db.query<Record<string, unknown>>(testo, chiavi.map((k) => conv[k]), COME_TESTO)
      await db.exec('RELEASE SAVEPOINT finto_rpc')
      const prima = r.rows[0]
      if (prima && Object.keys(prima).length === 1 && Object.keys(prima)[0] === nome) return { data: prima[nome], error: null }
      return { data: r.rows, error: null }
    } catch (e) {
      await db.exec('ROLLBACK TO SAVEPOINT finto_rpc')
      await db.exec('RELEASE SAVEPOINT finto_rpc')
      const err = e as { code?: string; message?: string; detail?: string }
      return { data: null, error: { code: err.code, message: err.message ?? 'errore', details: err.detail ?? null } }
    }
  }
  return c
}

type Q = { eq: (c: string, v: unknown) => Q; or?: (s: string) => Q }

function conOr(q: Q): Q {
  if (q && typeof q === 'object' && typeof q.eq === 'function' && !q.or) {
    q.or = function (this: Q, s: string) {
      const m = /^and\(([a-z_]+)\.eq\.([^,()]+),([a-z_]+)\.eq\.([^,()]+)\)$/.exec(s) ?? null
      if (m) return this.eq(m[1], m[2]).eq(m[3], m[4])
      const u = /^([a-z_]+)\.eq\.([^,()]+)$/.exec(s)
      if (u) return this.eq(u[1], u[2])
      throw new Error(`.or('${s.slice(0, 60)}') non è nel finto della ri-revisione 2`)
    }
  }
  return q
}

export function clienteProvaRoute(db: PGlite) {
  const c = clienteProva(db) as unknown as { from: (t: string) => unknown }
  const da = c.from.bind(c)
  c.from = (t: string) => {
    const b = da(t) as Record<string, unknown>
    // `select` restituisce il builder: l'`or` va messo sul builder che esce da ogni passo.
    return new Proxy(b, {
      get(t2, k) {
        const v = Reflect.get(t2, k)
        if (typeof v !== 'function') return v
        return (...a: unknown[]) => {
          const r = (v as (...x: unknown[]) => unknown).apply(t2, a)
          return r && typeof r === 'object' && typeof (r as Q).eq === 'function' ? conOr(r as Q) : r
        }
      },
    })
  }
  return c
}
