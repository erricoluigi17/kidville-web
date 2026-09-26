// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

/**
 * L'IMPORT DELL'ESTRATTO CONTO CON TRE SEDI (K5, 2026-09-26).
 *
 * ─── IL DIFETTO ─────────────────────────────────────────────────────────────
 * La POST di import chiedeva la sede a `resolveScuolaScrittura`, che con più di una sede
 * accessibile e nessuna dichiarata risponde **400**. Ma l'estratto conto della banca è UNO
 * per tutti e tre i plessi, e i movimenti nascono SENZA sede (la sede si assegna alla
 * conferma): la segreteria multi-sede non poteva importare niente, per una sede che
 * all'import non serve.
 *
 * Ora l'import chiede soltanto che l'operatore abbia almeno una sede attiva
 * (`resolveScuoleAttive`), e la sede dichiarata nel corpo è FACOLTATIVA: se c'è deve essere
 * una delle sue (mai ignorata), e serve solo al ripiego del DB E2E della CI.
 *
 * ⚠️ Il finto di `resolveScuolaScrittura` qui sotto si comporta come quello vero — 400
 * con più sedi e nessuna dichiarata — proprio perché un ritorno alla chiamata vecchia
 * faccia diventare ROSSI i test a tre sedi, invece di passare su un finto compiacente.
 *
 * Gli uuid sono INVENTATI (lock `migrazioni-senza-sede-cablata`): nessuno è di una sede vera.
 */

const SEDE_A = '11111111-2222-4333-8444-555555555551'
const SEDE_B = '11111111-2222-4333-8444-555555555552'
const SEDE_C = '11111111-2222-4333-8444-555555555553'
const SEDE_ALTRUI = '99999999-2222-4333-8444-555555555559'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  sediAttive: [] as string[],
  inserts: [] as { table: string; row: Record<string, unknown> | Record<string, unknown>[] }[],
  /** Tabelle su cui un INSERT con `scuola_id` null risponde 23502 (il DB E2E non migrato). */
  fail23502: new Set<string>(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
// ⚠️ `@/lib/audit/scrittura` NON si sostituisce: è il `logScrittura` VERO a decidere la
// `scuola_id` della riga d'audit (ripiega su `attore.scuola_id` quando riceve null). Un finto
// che guardasse solo l'argomento sarebbe verde anche con la riga scritta sulla sede primaria
// dell'operatore. Qui si guarda la RIGA che arriva su `audit_scritture_docente`.
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
}))
vi.mock('@/lib/auth/scope', async (orig) => {
  const vero = await orig<typeof import('@/lib/auth/scope')>()
  return {
    // `restringiSedi` è quella VERA: è lei a dire se la sede dichiarata è dentro il perimetro.
    restringiSedi: vero.restringiSedi,
    resolveScuoleAttive: async () => h.sediAttive,
    resolveScuolaScrittura: (...a: unknown[]) => h.resolveScuolaScrittura(...a),
  }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit', 'range', 'is', 'not', 'or']) {
        b[m] = () => b
      }
      b.maybeSingle = async () => ({ data: null, error: null })
      b.insert = (row: Record<string, unknown> | Record<string, unknown>[]) => {
        h.inserts.push({ table, row })
        const rows = Array.isArray(row) ? row : [row]
        const err = h.fail23502.has(table) && rows.some((r) => r.scuola_id === null)
          ? { code: '23502', message: 'null value in column "scuola_id" violates not-null constraint' }
          : null
        const scritte = rows.map((r, i) => ({ id: `${table}-${i}`, hash_movimento: r.hash_movimento }))
        return {
          select: () => ({
            single: async () => ({ data: err ? null : { id: `${table}-new` }, error: err }),
            then: (r: (v: unknown) => unknown) => r({ data: err ? null : scritte, error: err }),
          }),
          then: (r: (v: unknown) => unknown) => r({ data: null, error: err }),
        }
      }
      // Registro vuoto e nessun pagamento aperto: qui si misura la SEDE, non il matcher.
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null })
      return b
    },
  }),
}))

import { POST } from '@/app/api/pagamenti/riconciliazione/route'

const CSV = [
  'Data;Entrate;Descrizione',
  '05/09/2026;150,00;BONIFICO RETTA SETTEMBRE PERLINI CARLO',
  '06/09/2026;25,00;GITA ZOO PERLINI CARLO',
].join('\n')

const postJson = (body: unknown) =>
  new Request('http://localhost/api/pagamenti/riconciliazione', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

function upload(campi: Record<string, string> = {}): Request {
  const fd = new FormData()
  fd.append('file', new File([CSV], 'Conti.csv', { type: 'text/csv' }))
  for (const [k, v] of Object.entries(campi)) fd.append(k, v)
  return new Request('http://localhost/api/pagamenti/riconciliazione', { method: 'POST', body: fd })
}

const movimentiInseriti = () =>
  h.inserts.filter((i) => i.table === 'riconciliazione_movimenti').flatMap((i) => i.row as Record<string, unknown>[])
const importInseriti = () =>
  h.inserts.filter((i) => i.table === 'riconciliazione_import').map((i) => i.row as Record<string, unknown>)
const auditScritti = () =>
  h.inserts.filter((i) => i.table === 'audit_scritture_docente').map((i) => i.row as Record<string, unknown>)

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []
  h.fail23502 = new Set()
  h.sediAttive = [SEDE_A, SEDE_B, SEDE_C]
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria', scuola_id: SEDE_A } })
  // Il comportamento VERO con più sedi e nessuna dichiarata: 400.
  h.resolveScuolaScrittura.mockImplementation(async (_r: unknown, _s: unknown, _u: unknown, preferita?: string) =>
    preferita ? { scuolaId: preferita } : { response: NextResponse.json({ codice: 'SEDE_DA_SPECIFICARE' }, { status: 400 }) },
  )
})

describe('tre sedi attive, nessuna dichiarata: l’import PASSA', () => {
  it('multipart senza `scuola_id` → 200, movimenti e import nascono SENZA sede', async () => {
    const res = await POST(upload())
    expect(res.status).toBe(200)
    expect((await res.json()).data.nuovi).toBe(2)
    expect(movimentiInseriti()).toHaveLength(2)
    expect(movimentiInseriti().every((r) => r.scuola_id === null)).toBe(true)
    expect(importInseriti()[0].scuola_id).toBeNull()
    // La sede di SCRITTURA non si chiede più: con tre plessi risponderebbe 400.
    expect(h.resolveScuolaScrittura).not.toHaveBeenCalled()
  })

  it('JSON senza `scuola_id` → 200 (il ramo degli script)', async () => {
    const res = await POST(postJson({ filename: 'estratto.csv', contenuto: CSV }))
    expect(res.status).toBe(200)
    expect(movimentiInseriti()).toHaveLength(2)
  })

  it('multipart con `scuola_id` VUOTO (il pannello con più sedi) → 200, come se mancasse', async () => {
    const res = await POST(upload({ scuola_id: '' }))
    expect(res.status).toBe(200)
    expect(movimentiInseriti()).toHaveLength(2)
  })

  // L'operatore ha `scuola_id: SEDE_A` (beforeEach): se la riga d'audit la eredita, questi
  // due test sono ROSSI. È esattamente il difetto del giro 1.
  it('la RIGA d’audit nasce con sede NULL, non con la sede primaria dell’operatore', async () => {
    const res = await POST(upload())
    expect(res.status).toBe(200)
    const audit = auditScritti()
    expect(audit).toHaveLength(1)
    expect(audit[0].entita_tipo).toBe('riconciliazione_import')
    expect(audit[0].azione).toBe('insert')
    expect(audit[0].attore_id).toBe('staff-1')
    expect(audit[0].attore_ruolo).toBe('segreteria')
    expect(audit[0]).toHaveProperty('scuola_id', null)
  })

  it('anche con una sede DICHIARATA la riga d’audit resta senza sede (la sede non tocca i dati importati)', async () => {
    const res = await POST(upload({ scuola_id: SEDE_B }))
    expect(res.status).toBe(200)
    const audit = auditScritti()
    expect(audit).toHaveLength(1)
    expect(audit[0]).toHaveProperty('scuola_id', null)
  })
})

describe('il perimetro NEGA, non allarga', () => {
  it('nessuna sede attiva → 403 SEDE_NON_ACCESSIBILE, niente scritto, e un `warn`', async () => {
    h.sediAttive = []
    const res = await POST(upload())
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(h.inserts).toHaveLength(0)
    expect(h.logEvento.mock.calls.some(([, liv, c]) =>
      liv === 'warn' && (c as { esito?: string }).esito === 'import-senza-sedi-attive')).toBe(true)
  })

  it('sede dichiarata FUORI dalle sedi attive → 403, mai ignorata', async () => {
    const res = await POST(upload({ scuola_id: SEDE_ALTRUI }))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(h.inserts).toHaveLength(0)
    expect(h.logEvento.mock.calls.some(([, liv, c]) =>
      liv === 'warn' && (c as { esito?: string }).esito === 'import-sede-non-accessibile')).toBe(true)
  })

  it('stessa regola sul ramo JSON', async () => {
    const res = await POST(postJson({ contenuto: CSV, scuola_id: SEDE_ALTRUI }))
    expect(res.status).toBe(403)
    expect(h.inserts).toHaveLength(0)
  })
})

describe('«undefined» e «null» come TESTO: 422 che si legge, mai silenzio', () => {
  it.each(['undefined', 'null', 'NULL', ' undefined '])('multipart `scuola_id=%j` → 422 CORPO_NON_VALIDO', async (v) => {
    const res = await POST(upload({ scuola_id: v }))
    expect(res.status).toBe(422)
    const j = await res.json()
    expect(j.codice).toBe('CORPO_NON_VALIDO')
    expect(j.error).toMatch(/sede/i)
    expect(h.inserts).toHaveLength(0)
    expect(h.logEvento.mock.calls.some(([, liv, c]) =>
      liv === 'warn' && (c as { esito?: string }).esito === 'import-sede-testo-non-valido')).toBe(true)
  })

  it('JSON `scuola_id: "undefined"` → 422, e il corpo non viene scritto', async () => {
    const res = await POST(postJson({ contenuto: CSV, scuola_id: 'undefined' }))
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('CORPO_NON_VALIDO')
    expect(h.inserts).toHaveLength(0)
  })

  it('JSON `scuola_id: null` (il valore, non il testo) resta ammesso', async () => {
    const res = await POST(postJson({ contenuto: CSV, scuola_id: null }))
    expect(res.status).toBe(200)
  })

  it('una sede che non è un uuid resta un 400 di validazione', async () => {
    const res = await POST(upload({ scuola_id: 'sc-1' }))
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })
})

describe('il ripiego del DB E2E della CI (scuola_id NOT NULL, 23502)', () => {
  it('senza sede dichiarata: si ritenta con la PRIMA delle sedi attive', async () => {
    h.fail23502 = new Set(['riconciliazione_import', 'riconciliazione_movimenti'])
    h.sediAttive = [SEDE_B, SEDE_C]
    const res = await POST(upload())
    expect(res.status).toBe(200)
    const imp = importInseriti()
    expect(imp).toHaveLength(2)
    expect(imp[0].scuola_id).toBeNull()
    expect(imp[1].scuola_id).toBe(SEDE_B)
    const blocchi = h.inserts.filter((i) => i.table === 'riconciliazione_movimenti')
    expect(blocchi).toHaveLength(2)
    expect((blocchi[1].row as Record<string, unknown>[]).every((r) => r.scuola_id === SEDE_B)).toBe(true)
  })

  it('con sede dichiarata (in maiuscolo): si ritenta con QUELLA, nella forma canonica', async () => {
    h.fail23502 = new Set(['riconciliazione_import', 'riconciliazione_movimenti'])
    const res = await POST(upload({ scuola_id: SEDE_C.toUpperCase() }))
    expect(res.status).toBe(200)
    expect(importInseriti()[1].scuola_id).toBe(SEDE_C)
    const blocchi = h.inserts.filter((i) => i.table === 'riconciliazione_movimenti')
    expect((blocchi[1].row as Record<string, unknown>[]).every((r) => r.scuola_id === SEDE_C)).toBe(true)
  })
})
