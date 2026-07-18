import { describe, it, expect, vi, beforeEach } from 'vitest'

// Notifiche mockate: catturiamo l'enqueue senza far girare la catena reale.
const h = vi.hoisted(() => ({
  notifiche: [] as Record<string, unknown>[],
  logEvento: vi.fn(),
}))
vi.mock('@/lib/notifiche/triggers', () => ({
  notificaEvento: vi.fn(async (_sb: unknown, p: Record<string, unknown>) => { h.notifiche.push(p) }),
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))

import {
  assertGenitoreNonSospeso,
  assertGenitoreNonSospesoSalvoEssenziale,
  infoSospensioneFamiglia,
  verificaRevocaSospensioneMorosita,
} from '@/lib/pagamenti/sospensione'

// ── Fake supabase generico: righe per tabella + filtri eq/in applicati davvero.
interface Rows {
  legame_genitori_alunni?: Record<string, unknown>[]
  parents?: Record<string, unknown>[]
  student_parents?: Record<string, unknown>[]
  alunni?: Record<string, unknown>[]
  pagamenti?: Record<string, unknown>[]
}
interface Capture {
  updates: { table: string; row: Record<string, unknown>; id: unknown }[]
  inserts: { table: string; row: Record<string, unknown> }[]
}
// selectErrors: se la stringa di select contiene la substring → ritorna l'errore.
function fake(rows: Rows, cap: Capture, selectErrors: Record<string, { code: string }> = {}) {
  return {
    from(table: string) {
      const eqs: [string, unknown][] = []
      const ins: [string, unknown[]][] = []
      let selectStr = ''
      const applica = () => {
        let data = ((rows as Record<string, Record<string, unknown>[]>)[table] ?? []).slice()
        for (const [c, v] of eqs) data = data.filter((r) => r[c] === v)
        for (const [c, vs] of ins) data = data.filter((r) => vs.includes(r[c]))
        return data
      }
      const errOf = () => {
        for (const [sub, err] of Object.entries(selectErrors)) if (selectStr.includes(sub)) return err
        return null
      }
      const b: Record<string, unknown> = {}
      b.select = (s: string) => { selectStr = s ?? ''; return b }
      b.eq = (c: string, v: unknown) => { eqs.push([c, v]); return b }
      b.in = (c: string, vs: unknown[]) => { ins.push([c, vs]); return b }
      b.maybeSingle = async () => ({ data: applica()[0] ?? null, error: errOf() })
      b.update = (row: Record<string, unknown>) => ({
        eq: async (_c: string, v: unknown) => { cap.updates.push({ table, row, id: v }); return { error: null } },
      })
      b.insert = async (row: Record<string, unknown>) => { cap.inserts.push({ table, row }); return { error: null } }
      b.then = (resolve: (r: unknown) => void) => resolve({ data: applica(), error: errOf() })
      return b
    },
  } as never
}
const cap = (): Capture => ({ updates: [], inserts: [] })

beforeEach(() => {
  vi.clearAllMocks()
  h.notifiche = []
})

const PAST = '2020-01-01'

describe('assertGenitoreNonSospeso — unione canonica dei legami (fix finding #4)', () => {
  it('CRITERIO CHIAVE: legame presente SOLO in student_parents (via parents.auth_user_id) con figlio sospeso → BLOCCA', async () => {
    const sb = fake({
      legame_genitori_alunni: [], // nessun legame runtime
      parents: [{ id: 'p1', auth_user_id: 'g1' }],
      student_parents: [{ parent_id: 'p1', student_id: 'a1' }],
      alunni: [{ id: 'a1', sospeso: true }],
    }, cap())
    const res = await assertGenitoreNonSospeso(sb, 'g1')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    expect((await res!.json()).motivo).toBe('account_sospeso')
  })

  it('legame runtime, nessun figlio sospeso → null', async () => {
    const sb = fake({
      legame_genitori_alunni: [{ genitore_id: 'g1', alunno_id: 'a2' }],
      alunni: [{ id: 'a2', sospeso: false }],
    }, cap())
    expect(await assertGenitoreNonSospeso(sb, 'g1')).toBeNull()
  })

  it('nessun figlio collegato → null (nessuna falsa sospensione)', async () => {
    const sb = fake({ legame_genitori_alunni: [], parents: [], student_parents: [], alunni: [] }, cap())
    expect(await assertGenitoreNonSospeso(sb, 'g1')).toBeNull()
  })
})

describe('assertGenitoreNonSospesoSalvoEssenziale — eccezione moduli essenziali', () => {
  const rowsSospeso: Rows = {
    legame_genitori_alunni: [{ genitore_id: 'g1', alunno_id: 'a1' }],
    alunni: [{ id: 'a1', sospeso: true }],
  }
  it('modulo sempre_firmabile=true → NON bloccato anche se il figlio è sospeso', async () => {
    const res = await assertGenitoreNonSospesoSalvoEssenziale(fake(rowsSospeso, cap()), 'g1', { sempreFirmabile: true })
    expect(res).toBeNull()
  })
  it('sempre_firmabile assente/false → bloccato come oggi', async () => {
    const r1 = await assertGenitoreNonSospesoSalvoEssenziale(fake(rowsSospeso, cap()), 'g1', { sempreFirmabile: false })
    expect(r1!.status).toBe(403)
    const r2 = await assertGenitoreNonSospesoSalvoEssenziale(fake(rowsSospeso, cap()), 'g1', {})
    expect(r2!.status).toBe(403)
  })
})

describe('infoSospensioneFamiglia', () => {
  it('ritorna sospeso + Σ residui scaduti della famiglia (unione legami)', async () => {
    const sb = fake({
      legame_genitori_alunni: [{ genitore_id: 'g1', alunno_id: 'a1' }],
      alunni: [{ id: 'a1', sospeso: true }],
      pagamenti: [
        { alunno_id: 'a1', importo: 70, importo_pagato: 0, sconto: 0, scadenza: PAST, stato: 'da_pagare', tipo: 'singolo' },
        { alunno_id: 'a1', importo: 50, importo_pagato: 50, sconto: 0, scadenza: PAST, stato: 'pagato', tipo: 'singolo' },
      ],
    }, cap())
    const info = await infoSospensioneFamiglia(sb, 'g1')
    expect(info.sospeso).toBe(true)
    expect(info.totaleScaduto).toBe(70)
  })
})

describe('verificaRevocaSospensioneMorosita', () => {
  const baseRows = (): Rows => ({
    legame_genitori_alunni: [
      { genitore_id: 'g1', alunno_id: 'a1' },
      { genitore_id: 'g1', alunno_id: 'a2' },
    ],
    alunni: [
      { id: 'a1', scuola_id: 's1', sospeso: true, sospeso_causa: 'morosita' },
      { id: 'a2', scuola_id: 's1', sospeso: true, sospeso_causa: 'altro' },
    ],
  })

  it('scaduto famiglia = 0 → azzera sospeso SOLO su causa morosita + audit + notifica', async () => {
    const rows = baseRows()
    rows.pagamenti = [
      { alunno_id: 'a1', importo: 100, importo_pagato: 100, sconto: 0, scadenza: PAST, stato: 'pagato', tipo: 'singolo' },
      { alunno_id: 'a2', importo: 60, importo_pagato: 60, sconto: 0, scadenza: PAST, stato: 'pagato', tipo: 'singolo' },
    ]
    const c = cap()
    const out = await verificaRevocaSospensioneMorosita(fake(rows, c), ['a1'])
    expect(out.revocati).toEqual(['a1'])
    // update SOLO su a1 (morosita), sospeso→false
    expect(c.updates).toHaveLength(1)
    expect(c.updates[0]).toMatchObject({ table: 'alunni', id: 'a1' })
    expect(c.updates[0].row.sospeso).toBe(false)
    // audit in registro_modifiche
    expect(c.inserts.some((i) => i.table === 'registro_modifiche')).toBe(true)
    // notifica al genitore
    expect(h.notifiche).toHaveLength(1)
    expect((h.notifiche[0].alunnoIds as string[])).toEqual(['a1'])
    expect(h.notifiche[0].tipo).toBe('sospensione_morosita')
  })

  it('scaduto famiglia > 0 → nessuna revoca', async () => {
    const rows = baseRows()
    rows.pagamenti = [
      { alunno_id: 'a1', importo: 100, importo_pagato: 30, sconto: 0, scadenza: PAST, stato: 'parziale', tipo: 'singolo' },
    ]
    const c = cap()
    const out = await verificaRevocaSospensioneMorosita(fake(rows, c), ['a1'])
    expect(out.revocati).toEqual([])
    expect(c.updates).toHaveLength(0)
    expect(h.notifiche).toHaveLength(0)
  })

  it('FAIL-CLOSED: errore di lettura pagamenti (non column-missing) → nessuna revoca + error', async () => {
    // Scenario: un glitch DB durante il ricalcolo dello scaduto. Se totaleScaduto
    // NON è determinabile con certezza, la revoca (a senso unico) NON deve partire:
    // un errore transiente non può togliere una sospensione legittima.
    const rows = baseRows()
    rows.pagamenti = [
      { alunno_id: 'a1', importo: 100, importo_pagato: 100, sconto: 0, scadenza: PAST, stato: 'pagato', tipo: 'singolo' },
      { alunno_id: 'a2', importo: 60, importo_pagato: 60, sconto: 0, scadenza: PAST, stato: 'pagato', tipo: 'singolo' },
    ]
    const c = cap()
    // 'importo_pagato' è nel SELECT sia con `sconto` sia senza → l'errore colpisce
    // entrambi i tentativi e NON è un 42703 (colonna mancante) → non determinabile.
    const out = await verificaRevocaSospensioneMorosita(fake(rows, c, { importo_pagato: { code: '08006' } }), ['a1'])
    expect(out.revocati).toEqual([])
    expect(c.updates).toHaveLength(0)
    expect(h.notifiche).toHaveLength(0)
    const errCalls = h.logEvento.mock.calls.filter((cl) => cl[1] === 'error')
    expect(errCalls.length).toBeGreaterThan(0)
  })

  it('colonna sospeso_causa assente (42703) → NON revoca nulla e logga warn', async () => {
    const rows = baseRows()
    rows.pagamenti = [
      { alunno_id: 'a1', importo: 100, importo_pagato: 100, sconto: 0, scadenza: PAST, stato: 'pagato', tipo: 'singolo' },
      { alunno_id: 'a2', importo: 60, importo_pagato: 60, sconto: 0, scadenza: PAST, stato: 'pagato', tipo: 'singolo' },
    ]
    const c = cap()
    // La select dei sospesi per causa contiene 'sospeso_causa' → 42703.
    const out = await verificaRevocaSospensioneMorosita(fake(rows, c, { sospeso_causa: { code: '42703' } }), ['a1'])
    expect(out.revocati).toEqual([])
    expect(c.updates).toHaveLength(0)
    const warn = h.logEvento.mock.calls.filter((cl) => cl[1] === 'warn')
    expect(warn.length).toBeGreaterThan(0)
  })
})
