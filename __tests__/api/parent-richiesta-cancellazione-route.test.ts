import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { NextResponse } from 'next/server'

// =============================================================================
// REGRESSIONE — spazio-id `parents.id` vs `auth.user.id` (canale IN-APP, C5).
//
// `auth.user.id` è l'id della riga `utenti` (ruolo genitore); `parents.id` è un
// uuid indipendente. Il ponte è `parents.auth_user_id`. Scrivere/filtrare
// `richieste_cancellazione.parent_id` con `auth.user.id` produce una riga che
// /admin/gdpr non sa evadere (lì `parent_id` è letto come `parents.id`): oblio
// self-service silenziosamente morto.
//
// Il fake qui sotto onora DAVVERO la colonna passata a `.eq()` e tiene
// `utente.id` ≠ `parents.id`: è l'unico modo perché una query sbagliata sia
// rossa. (Il fake di `gdpr-esegui.test.ts` ignora la colonna — ed è il motivo
// per cui il bug non è mai stato visto.)
// =============================================================================

const UTENTE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-utente000001'
const PARENT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-parent000001'
const SCUOLA_ID = SEDE_A

type Row = Record<string, unknown>
interface Filtro { col: string; val: unknown }

const h = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, Record<string, unknown>[]>,
    errors: {} as Record<string, { code?: string; message?: string } | undefined>,
    inserts: [] as Array<{ table: string; value: unknown }>,
    updates: [] as Array<{ table: string; patch: Record<string, unknown>; filtri: Array<{ col: string; val: unknown }> }>,
    selects: [] as Array<{ table: string; filtri: Array<{ col: string; val: unknown }> }>,
  }
  const requireUser = vi.fn()
  function makeClient() {
    return {
      from(table: string) {
        const filtri: Array<{ col: string; val: unknown }> = []
        state.selects.push({ table, filtri })
        let patch: Record<string, unknown> | null = null
        const righe = () =>
          (state.tables[table] ?? []).filter((r) => filtri.every((f) => r[f.col] === f.val))
        const esegui = () => {
          const err = state.errors[table]
          if (err) return { data: null, error: err as unknown }
          const out = righe()
          if (patch) state.updates.push({ table, patch, filtri: [...filtri] })
          return { data: out, error: null as unknown }
        }
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.limit = () => b
        b.order = () => b
        b.eq = (col: string, val: unknown) => { filtri.push({ col, val }); return b }
        b.insert = (v: unknown) => { state.inserts.push({ table, value: v }); return b }
        b.update = (v: Record<string, unknown>) => { patch = v; return b }
        b.maybeSingle = async () => {
          const err = state.errors[table]
          if (err) return { data: null, error: err as unknown }
          // Dopo un insert il terminale restituisce la riga creata, non un match sui filtri.
          if (state.inserts.some((i) => i.table === table)) return { data: { id: 'req-nuova' }, error: null }
          return { data: righe()[0] ?? null, error: null }
        }
        b.then = (res: (v: unknown) => unknown) => Promise.resolve(esegui()).then(res)
        return b
      },
    }
  }
  return { state, requireUser, makeClient }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => h.makeClient() }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn().mockResolvedValue(undefined) }))
// `scuolaUnicaReale` risponde `null` — ed è la VERITÀ di produzione dal
// 2026-07-29, non una comodità di test: con tre sedi reali la funzione è
// deprecata e ritorna sempre null. Il mock che la faceva rispondere con una sede
// mascherava esattamente il difetto W1 (`scuola_id` NULL sulla richiesta).
vi.mock('@/lib/notifiche/destinatari', () => ({
  staffScuola: vi.fn().mockResolvedValue(['staff-1']),
  scuolaUnicaReale: vi.fn().mockResolvedValue(null),
}))

import { GET, POST, DELETE } from '@/app/api/parent/account/richiesta-cancellazione/route'

const URL_ROUTE = 'http://localhost/api/parent/account/richiesta-cancellazione'
const reqGet = () => new Request(URL_ROUTE)
const reqDelete = () => new Request(URL_ROUTE, { method: 'DELETE' })
const reqPost = (body: unknown) =>
  new Request(URL_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const parentCollegato = (patch: Row = {}) => ({
  id: PARENT_ID,
  auth_user_id: UTENTE_ID,
  anonimizzato_il: null,
  ...patch,
})

/** Filtri applicati all'ultima query su una tabella (per asserire la colonna giusta). */
const filtriSu = (table: string): Filtro[] =>
  [...h.state.selects].reverse().find((s) => s.table === table)?.filtri ?? []

/** Legame figlio→sede, nella forma dell'embed PostgREST `alunni!inner(scuola_id)`. */
const figlioIn = (sede: string, id = `al-${sede}`) => ({
  parent_id: PARENT_ID,
  student_id: id,
  alunni: { scuola_id: sede },
})

beforeEach(() => {
  vi.clearAllMocks()
  h.state.tables = { parents: [parentCollegato()], richieste_cancellazione: [], student_parents: [] }
  h.state.errors = {}
  h.state.inserts = []
  h.state.updates = []
  h.state.selects = []
  h.requireUser.mockResolvedValue({ user: { id: UTENTE_ID, role: 'genitore', scuola_id: SCUOLA_ID } })
})

describe('POST /api/parent/account/richiesta-cancellazione', () => {
  it('inserisce parent_id = parents.id (MAI auth.user.id)', async () => {
    const res = await POST(reqPost({ conferma: 'ELIMINA' }))
    expect(res.status).toBe(200)
    const ins = h.state.inserts.find((i) => i.table === 'richieste_cancellazione')
    expect(ins).toBeTruthy()
    expect(ins!.value).toMatchObject({ parent_id: PARENT_ID, stato: 'pending', scuola_id: SCUOLA_ID })
    expect((ins!.value as Row).parent_id).not.toBe(UTENTE_ID)
  })

  it('risolve `parents` dal ponte auth_user_id', async () => {
    await POST(reqPost({ conferma: 'ELIMINA' }))
    expect(filtriSu('parents')).toContainEqual({ col: 'auth_user_id', val: UTENTE_ID })
  })

  it('401 senza identità', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await POST(reqPost({ conferma: 'ELIMINA' }))).status).toBe(401)
    expect(h.state.inserts).toHaveLength(0)
  })

  it('400 se la conferma testuale è sbagliata (nessuna scrittura)', async () => {
    const res = await POST(reqPost({ conferma: 'elimina tutto' }))
    expect(res.status).toBe(400)
    expect(h.state.inserts).toHaveLength(0)
  })

  it('403 se l’utente non è un genitore bridgeato (nessuna riga parents)', async () => {
    h.state.tables.parents = []
    const res = await POST(reqPost({ conferma: 'ELIMINA' }))
    expect(res.status).toBe(403)
    expect(h.state.inserts).toHaveLength(0)
  })

  it('409 se il genitore è già anonimizzato', async () => {
    h.state.tables.parents = [parentCollegato({ anonimizzato_il: '2026-01-01T00:00:00Z' })]
    const res = await POST(reqPost({ conferma: 'ELIMINA' }))
    expect(res.status).toBe(409)
    expect(h.state.inserts).toHaveLength(0)
  })

  it('409 se esiste già una richiesta pending (indice unico → 23505)', async () => {
    h.state.errors.richieste_cancellazione = { code: '23505' }
    const res = await POST(reqPost({ conferma: 'ELIMINA' }))
    expect(res.status).toBe(409)
  })
})

// =============================================================================
// W1 — la SEDE della richiesta. `scuolaUnicaReale` è deprecata e con tre sedi
// reali risponde sempre `null`: una richiesta con `scuola_id NULL` è invisibile
// al GET della Direzione (`.in('scuola_id', plessi)` scarta i NULL), la POST di
// evasione la nega per sempre, e l'indice unico parziale su `pending` impedisce
// di ripresentarla. Il diritto all'oblio si blocca in silenzio.
// =============================================================================
describe('POST /api/parent/account/richiesta-cancellazione — sede della richiesta (W1)', () => {
  it('identità senza sede → la sede viene dal FIGLIO, non da scuolaUnicaReale', async () => {
    h.requireUser.mockResolvedValue({ user: { id: UTENTE_ID, role: 'genitore', scuola_id: null } })
    h.state.tables.student_parents = [figlioIn(SEDE_B)]
    const res = await POST(reqPost({ conferma: 'ELIMINA' }))
    expect(res.status).toBe(200)
    const ins = h.state.inserts.find((i) => i.table === 'richieste_cancellazione')
    expect((ins!.value as Row).scuola_id).toBe(SEDE_B)
  })

  it('la sede dei figli VINCE su una sede dell’identità che non c’entra', async () => {
    h.requireUser.mockResolvedValue({ user: { id: UTENTE_ID, role: 'genitore', scuola_id: SEDE_A } })
    h.state.tables.student_parents = [figlioIn(SEDE_B)]
    await POST(reqPost({ conferma: 'ELIMINA' }))
    const ins = h.state.inserts.find((i) => i.table === 'richieste_cancellazione')
    expect((ins!.value as Row).scuola_id).toBe(SEDE_B)
  })

  it('MAI una richiesta con scuola_id null: senza sede deducibile si RIFIUTA (422)', async () => {
    h.requireUser.mockResolvedValue({ user: { id: UTENTE_ID, role: 'genitore', scuola_id: null } })
    h.state.tables.student_parents = []
    const res = await POST(reqPost({ conferma: 'ELIMINA' }))
    expect(res.status).toBe(422)
    expect(h.state.inserts).toHaveLength(0)
    const j = await res.json()
    expect(typeof j.error).toBe('string')
    expect(j.error.length).toBeGreaterThan(0)
  })

  it('nessun insert porta mai scuola_id null o assente', async () => {
    h.requireUser.mockResolvedValue({ user: { id: UTENTE_ID, role: 'genitore', scuola_id: null } })
    h.state.tables.student_parents = [figlioIn(SEDE_B)]
    await POST(reqPost({ conferma: 'ELIMINA' }))
    for (const ins of h.state.inserts.filter((i) => i.table === 'richieste_cancellazione')) {
      expect((ins.value as Row).scuola_id).toBeTruthy()
    }
  })

  it('la notifica alla Direzione parte sulla sede DEDOTTA, non su quella dell’identità', async () => {
    const { staffScuola } = await import('@/lib/notifiche/destinatari')
    h.requireUser.mockResolvedValue({ user: { id: UTENTE_ID, role: 'genitore', scuola_id: SEDE_A } })
    h.state.tables.student_parents = [figlioIn(SEDE_B)]
    await POST(reqPost({ conferma: 'ELIMINA' }))
    expect(vi.mocked(staffScuola).mock.calls[0][1]).toBe(SEDE_B)
  })
})

describe('GET /api/parent/account/richiesta-cancellazione', () => {
  it('trova la richiesta filtrando per parents.id', async () => {
    h.state.tables.richieste_cancellazione = [
      { id: 'req-1', parent_id: PARENT_ID, stato: 'pending', creata_il: '2026-07-27T10:00:00Z', evasa_il: null },
    ]
    const res = await GET(reqGet())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.richiesta).toMatchObject({ id: 'req-1', stato: 'pending' })
    expect(filtriSu('richieste_cancellazione')).toContainEqual({ col: 'parent_id', val: PARENT_ID })
  })

  it('non restituisce una richiesta scritta con l’id utente (spazio-id sbagliato)', async () => {
    // Riga "avvelenata" dal vecchio bug: parent_id = auth.user.id. Non è una
    // richiesta valida per /admin/gdpr e non deve essere spacciata per tale.
    h.state.tables.richieste_cancellazione = [
      { id: 'req-vecchia', parent_id: UTENTE_ID, stato: 'pending', creata_il: '2026-07-01T10:00:00Z', evasa_il: null },
    ]
    const j = await (await GET(reqGet())).json()
    expect(j.richiesta).toBeNull()
  })

  it('nessuna richiesta → { richiesta: null }', async () => {
    const res = await GET(reqGet())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ richiesta: null })
  })

  it('utente senza riga parents → { richiesta: null }, non un errore (è solo una probe di stato)', async () => {
    h.state.tables.parents = []
    const res = await GET(reqGet())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ richiesta: null })
  })

  it('schema assente (DB E2E CI non migrato) → { richiesta: null }', async () => {
    h.state.errors.parents = { code: '42703' }
    const res = await GET(reqGet())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ richiesta: null })
  })

  it('401 senza identità', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await GET(reqGet())).status).toBe(401)
  })
})

describe('DELETE /api/parent/account/richiesta-cancellazione', () => {
  it('revoca filtrando per parents.id (MAI auth.user.id)', async () => {
    h.state.tables.richieste_cancellazione = [
      { id: 'req-1', parent_id: PARENT_ID, stato: 'pending', creata_il: '2026-07-27T10:00:00Z', evasa_il: null },
    ]
    const res = await DELETE(reqDelete())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, revocate: 1 })
    const upd = h.state.updates.find((u) => u.table === 'richieste_cancellazione')
    expect(upd).toBeTruthy()
    expect(upd!.patch).toMatchObject({ stato: 'revocata' })
    expect(upd!.filtri).toContainEqual({ col: 'parent_id', val: PARENT_ID })
    expect(upd!.filtri).toContainEqual({ col: 'stato', val: 'pending' })
    expect(upd!.filtri.some((f) => f.col === 'parent_id' && f.val === UTENTE_ID)).toBe(false)
  })

  it('non revoca la richiesta di un altro spazio-id', async () => {
    h.state.tables.richieste_cancellazione = [
      { id: 'req-altrui', parent_id: UTENTE_ID, stato: 'pending', creata_il: '2026-07-01T10:00:00Z', evasa_il: null },
    ]
    const res = await DELETE(reqDelete())
    expect(await res.json()).toEqual({ ok: true, revocate: 0 })
  })

  it('utente senza riga parents → { ok: true, revocate: 0 }, nessuna UPDATE', async () => {
    h.state.tables.parents = []
    const res = await DELETE(reqDelete())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, revocate: 0 })
    expect(h.state.updates).toHaveLength(0)
  })

  it('schema assente → { ok: true, revocate: 0 }', async () => {
    h.state.errors.parents = { code: '42703' }
    const res = await DELETE(reqDelete())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, revocate: 0 })
  })

  it('401 senza identità', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await DELETE(reqDelete())).status).toBe(401)
  })
})
