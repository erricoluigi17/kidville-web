import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { risolviGenitorePerEmail } from '@/lib/gdpr/cancellazione-pubblica'

// =============================================================================
// REGRESSIONE — spazio-id `parents.id` vs `auth.user.id` (canale PUBBLICO C5).
//
// `parents.id` è un uuid indipendente (`gen_random_uuid()`): NON è mai uguale
// all'id della riga `utenti` con ruolo genitore. Il ponte è `parents.auth_user_id`
// (stesso bridge di /api/me e lib/pagamenti/intestatari.ts).
//
// PERCHÉ QUESTO FILE ESISTE ACCANTO A `cancellazione-pubblica.test.ts`:
// il fake di quel file (come quello di `gdpr-esegui.test.ts`) IGNORA la colonna
// passata a `.eq()` e restituisce sempre la riga configurata — e usa lo stesso
// uuid per `utenti.id` e `parents.id`. Con quel fake una query giusta
// (`auth_user_id`) e una sbagliata (`id`) sono indistinguibili: è esattamente il
// motivo per cui il bug è vissuto in produzione senza un solo test rosso.
//
// Il fake qui sotto modella i filtri PER DAVVERO (eq per colonna + semantica
// ILIKE con escape), e i fixture tengono `utenti.id` DIVERSO da `parents.id`.
// Se qualcuno rimette `.eq('id', utente.id)`, questi test diventano rossi.
// =============================================================================

type Row = Record<string, unknown>
type ErroreFinto = { code?: string; message?: string }

interface Cfg {
  /** Righe per tabella, filtrate davvero dai filtri accumulati sulla catena. */
  tables?: Record<string, Row[]>
  /** Errore PostgREST iniettato per tabella (PostgREST non lancia: ritorna `{ error }`). */
  errors?: Record<string, ErroreFinto>
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Traduce un pattern ILIKE nella sua regex equivalente, onorando l'escape con
 * backslash: `\_` è un underscore letterale, `_` è un jolly di un carattere,
 * `%` è un jolly di lunghezza qualsiasi. Serve a distinguere un match esatto
 * case-insensitive da un wildcard che pesca la riga sbagliata.
 */
function ilikeToRegExp(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      const n = pattern[++i]
      if (n !== undefined) out += escapeRe(n)
      continue
    }
    if (c === '%') { out += '.*'; continue }
    if (c === '_') { out += '.'; continue }
    out += escapeRe(c)
  }
  return new RegExp(`${out}$`, 'i')
}

interface Filtro { op: 'eq' | 'ilike'; col: string; val: unknown }
interface QueryTracciata { table: string; filtri: Filtro[] }

function makeClient(cfg: Cfg) {
  const queries: QueryTracciata[] = []
  const client = {
    from(table: string) {
      const filtri: Filtro[] = []
      queries.push({ table, filtri })
      const esegui = () => {
        const err = cfg.errors?.[table]
        if (err) return { data: null as Row[] | null, error: err as unknown }
        const righe = (cfg.tables?.[table] ?? []).filter((r) =>
          filtri.every((f) => {
            if (f.op === 'eq') return r[f.col] === f.val
            const v = r[f.col]
            return typeof v === 'string' && ilikeToRegExp(String(f.val)).test(v)
          }),
        )
        return { data: righe, error: null as unknown }
      }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.limit = () => b
      b.order = () => b
      b.eq = (col: string, val: unknown) => { filtri.push({ op: 'eq', col, val }); return b }
      b.ilike = (col: string, val: unknown) => { filtri.push({ op: 'ilike', col, val }); return b }
      b.maybeSingle = async () => {
        const r = esegui()
        return r.error ? { data: null, error: r.error } : { data: (r.data ?? [])[0] ?? null, error: null }
      }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(esegui()).then(res)
      return b
    },
  }
  return { client: client as unknown as SupabaseClient, queries }
}

// Due spazi-id DIVERSI, come in produzione: 0 coincidenze fra parents.id e utenti.id.
const UTENTE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-utente000001'
const PARENT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-parent000001'
const SCUOLA_ID = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529'
const EMAIL = 'genitore@example.com'

const utenteGenitore = (email = EMAIL) => ({ id: UTENTE_ID, email, scuola_id: SCUOLA_ID })
const parentCollegato = (patch: Row = {}) => ({
  id: PARENT_ID,
  auth_user_id: UTENTE_ID,
  anonimizzato_il: null,
  ...patch,
})

describe('risolviGenitorePerEmail — ponte parents.auth_user_id', () => {
  it('risolve il genitore e ritorna parents.id, NON utenti.id', async () => {
    const { client } = makeClient({
      tables: { utenti: [utenteGenitore()], parents: [parentCollegato()] },
    })
    const r = await risolviGenitorePerEmail(client, EMAIL)
    expect(r.error).toBeNull()
    expect(r.genitore).toEqual({ parentId: PARENT_ID, scuolaId: SCUOLA_ID })
    // Esplicito: il valore restituito non deve essere l'id dell'utente.
    expect(r.genitore?.parentId).not.toBe(UTENTE_ID)
  })

  it('interroga `parents` per auth_user_id, non per id', async () => {
    const { client, queries } = makeClient({
      tables: { utenti: [utenteGenitore()], parents: [parentCollegato()] },
    })
    await risolviGenitorePerEmail(client, EMAIL)
    const qParents = queries.find((q) => q.table === 'parents')
    expect(qParents).toBeTruthy()
    expect(qParents!.filtri).toContainEqual({ op: 'eq', col: 'auth_user_id', val: UTENTE_ID })
    expect(qParents!.filtri.some((f) => f.col === 'id')).toBe(false)
  })

  it('non scambia le famiglie: un parents.id che collide con utenti.id NON viene scelto', async () => {
    // Caso peggiore reale dello spazio-id sbagliato: la riga `parents` di un'ALTRA
    // famiglia ha per PK proprio l'uuid che qui è un `utenti.id`. Filtrare per `id`
    // restituirebbe quella riga — e la Direzione anonimizzerebbe la famiglia sbagliata.
    const altraFamiglia = { id: UTENTE_ID, auth_user_id: 'zzzzzzzz-zzzz-zzzz-zzzz-utente000009', anonimizzato_il: null }
    const { client } = makeClient({
      tables: { utenti: [utenteGenitore()], parents: [altraFamiglia, parentCollegato()] },
    })
    const r = await risolviGenitorePerEmail(client, EMAIL)
    expect(r.genitore?.parentId).toBe(PARENT_ID)
  })

  it('è case-insensitive sull’email (input in maiuscolo trova la riga in minuscolo)', async () => {
    const { client } = makeClient({
      tables: { utenti: [utenteGenitore()], parents: [parentCollegato()] },
    })
    const r = await risolviGenitorePerEmail(client, 'Genitore@Example.COM')
    expect(r.genitore).toEqual({ parentId: PARENT_ID, scuolaId: SCUOLA_ID })
  })

  it('genitore già anonimizzato → genitore null (nessuna seconda cancellazione)', async () => {
    const { client } = makeClient({
      tables: {
        utenti: [utenteGenitore()],
        parents: [parentCollegato({ anonimizzato_il: '2026-01-01T00:00:00Z' })],
      },
    })
    const r = await risolviGenitorePerEmail(client, EMAIL)
    expect(r).toEqual({ genitore: null, error: null })
  })

  it('nessun utente con quella email → genitore null (anti-enumerazione a monte)', async () => {
    const { client } = makeClient({ tables: { utenti: [], parents: [parentCollegato()] } })
    const r = await risolviGenitorePerEmail(client, 'ignoto@example.com')
    expect(r).toEqual({ genitore: null, error: null })
  })

  it('utente senza riga parents collegata (staff) → genitore null', async () => {
    const { client } = makeClient({
      tables: { utenti: [{ id: 'staff-1', email: 'staff@example.com', scuola_id: SCUOLA_ID }], parents: [] },
    })
    const r = await risolviGenitorePerEmail(client, 'staff@example.com')
    expect(r).toEqual({ genitore: null, error: null })
  })

  it('schema assente su `utenti` (DB E2E CI non migrato) → degrada a genitore null, error null', async () => {
    const { client } = makeClient({ errors: { utenti: { code: 'PGRST205' } } })
    const r = await risolviGenitorePerEmail(client, EMAIL)
    expect(r).toEqual({ genitore: null, error: null })
  })

  it('schema assente su `parents` (colonna ponte mancante, 42703) → degrada a genitore null, error null', async () => {
    const { client } = makeClient({
      tables: { utenti: [utenteGenitore()] },
      errors: { parents: { code: '42703' } },
    })
    const r = await risolviGenitorePerEmail(client, EMAIL)
    expect(r).toEqual({ genitore: null, error: null })
  })

  it('errore DB inatteso su `parents` → propagato al chiamante (che logga e risponde 500)', async () => {
    const err = { code: '08006', message: 'connection failure' }
    const { client } = makeClient({ tables: { utenti: [utenteGenitore()] }, errors: { parents: err } })
    const r = await risolviGenitorePerEmail(client, EMAIL)
    expect(r.genitore).toBeNull()
    expect(r.error).toBe(err)
  })
})
