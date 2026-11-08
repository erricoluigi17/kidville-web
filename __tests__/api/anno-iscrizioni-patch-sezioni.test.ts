import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'

// A5 — Sezione inesistente nella sede → `section_id` NULL, in silenzio.
//
// `assignments` è TESTO e finisce in `alunni.classe_sezione`. Il trigger
// `sync_alunno_section_id()` risolve `section_id` cercando il nome DENTRO la stessa
// `scuola_id`, con confronto insensibile a maiuscole e spazi:
//   lower(replace(s.name,' ','')) = lower(replace(NEW.classe_sezione,' ',''))
// Se non trova, lascia NULL SENZA dire niente. Con tre sedi che hanno sezioni quasi
// omonime ("3 ANNI", "2 ANNI A"…) è la ricetta per alunni senza classe: iscritti,
// invisibili all'appello, fuori da ogni registro.
//
// Il pre-flight qui sotto lo intercetta PRIMA di ogni scrittura, come già fa quello
// delle province: l'invio resta 'pending' e l'operatore corregge.

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
  sub: null as Record<string, unknown> | null,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  // Righe di `sections` della sede di scrittura + eventuale errore di lettura.
  sezioni: [] as { name: string }[],
  sezioniErrore: null as { code?: string; message: string } | null,
  sezioniFiltro: [] as unknown[],
  dbFinto: {} as Record<string, Record<string, unknown>[]>,
  erroriFinto: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/email/send', () => ({
  sendEmail: async () => true,
  sendEmailDetailed: async () => ({ ok: true, error: null }),
  credentialsEmailBody: () => 'x',
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => ({ ok: true }) }))
vi.mock('@/lib/auth/parent-identity', () => ({
  ensureParentIdentity: async () => ({ ok: true, authUserId: 'auth-x', password: null, createdAuth: false, reason: null, message: '' }),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: async () => ({ creati: 0 }) }))
// `restringiSedi` resta VERA: `?scuola_id=` deve intersecare davvero le sedi
// attive, e un finto che dicesse sempre di sì non proverebbe nessun diniego.
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => ['sc-1'],
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  scuoleDiUtente: async () => ['sc-1'],
}))

vi.mock('@/lib/logging/logger', async (orig) => {
  const m = await orig<typeof import('@/lib/logging/logger')>()
  return {
    ...m,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
      h.eventi.push({ evento, livello, campi })
    },
  }
})

const finto = () =>
  creaFintoSupabase(h.dbFinto as DBFinto, [], {
    errori: h.erroriFinto,
    rpc: { anno_attivo: () => ({ data: 'b2222222-2222-4222-8222-aaaaaaaaaaaa', error: null }) },
  })

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'u' }, error: null }) }) },
    rpc: (nome: string, args: Record<string, unknown>) => finto().rpc(nome, args),
    from(table: string) {
      if (table === 'sections' || table === 'anni_sede') return finto().from(table)
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, val: unknown) => {
        if (table === 'sections') h.sezioniFiltro.push({ col, val })
        return b
      }
      b.in = () => b
      b.limit = () => b
      b.order = async () => ({ data: [], error: null })
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(
          table === 'sections'
            ? { data: h.sezioniErrore ? null : h.sezioni, error: h.sezioniErrore }
            : { data: [], error: null },
        ).then(res)
      b.maybeSingle = async () => {
        if (table === 'enrollment_submissions') return { data: h.sub, error: null }
        return { data: null, error: null }
      }
      b.single = async () => ({ data: null, error: null })
      b.insert = (row: Record<string, unknown>) => {
        h.inserts.push({ table, row })
        return { select: () => ({ single: async () => ({ data: { id: `${table}-new`, nome: row?.nome ?? 'X' }, error: null }) }) }
      }
      b.update = (row: Record<string, unknown>) => {
        h.updates.push({ table, row })
        return { eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'x' }, error: null }) }) }) }
      }
      b.upsert = async () => ({ data: null, error: null })
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/admin/iscrizioni/route'

const ID = '5b5b5b5b-5b5b-45b5-85b5-5b5b5b5b5b5b'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/iscrizioni', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const importa = (assignments: Record<string, string>) =>
  PATCH(req({
    id: ID,
    action: 'import',
    assignments,
    // Una retta per ogni bambino a cui questo test assegna una classe: qui gli
    // `assignments` cambiano da caso a caso, e una mappa fissa avrebbe fatto
    // fallire sulla guardia della retta i casi con più figli.
    rette: Object.fromEntries(Object.keys(assignments).map((k) => [k, 300])),
    referenteIndex: 0,
  }) as never)

const alunniCreati = () => h.inserts.filter((i) => i.table === 'alunni')

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []
  h.updates = []
  h.eventi = []
  h.sezioniFiltro = []
  h.sezioniErrore = null
  h.erroriFinto = {}
  h.dbFinto = {
    anni_sede: [
      { id: 'b2222222-2222-4222-8222-aaaaaaaaaaaa', scuola_id: 'sc-1', anno_id: 'a2222222-2222-4222-8222-222222222222', stato: 'corrente', domande_aperte: false },
      { id: 'b3333333-3333-4333-8333-aaaaaaaaaaaa', scuola_id: 'sc-1', anno_id: 'a3333333-3333-4333-8333-333333333333', stato: 'in_preparazione', domande_aperte: false },
    ],
    sections: [
      { id: 'sez-attiva', scuola_id: 'sc-1', name: 'CLASSE ATTIVA', anno_id: 'a2222222-2222-4222-8222-222222222222' },
      { id: 'sez-futura', scuola_id: 'sc-1', name: 'CLASSE FUTURA', anno_id: 'a3333333-3333-4333-8333-333333333333' },
    ],
  }
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.sub = {
    id: ID,
    scuola_id: 'sc-1',
    data: {
      children: [{ nome: 'Bimbo', codice_fiscale: 'CFC1' }],
      adults: [{ first_name: 'Anna', fiscal_code: 'CF1', email: 'ref@example.test' }],
    },
  }
})

describe('import iscrizioni (PATCH) — il pre-flight della sezione guarda l\'anno attivo', () => {
  it('la classe dell\'anno ATTIVO passa e l\'alunno viene creato (controllo positivo)', async () => {
    const res = await importa({ '0': 'CLASSE ATTIVA' })
    expect(await res.json()).toMatchObject({ success: true })
    expect(alunniCreati()).toHaveLength(1)
  })

  it('la classe che esiste SOLO nel 2027/28 è rifiutata: success:false e ZERO alunni creati', async () => {
    const res = await importa({ '0': 'CLASSE FUTURA' })
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.errors.some((e: { messaggio: string }) => /CLASSE FUTURA/.test(e.messaggio))).toBe(true)
    expect(alunniCreati()).toHaveLength(0)
  })

  it('con lo schema dell\'anno indietro: nessun filtro, la stessa classe passa, nessun errore', async () => {
    h.erroriFinto = { anni_sede: { code: 'PGRST205', message: 'Could not find the table' } }
    h.dbFinto.sections = h.dbFinto.sections.map((s) => {
      const c = { ...s }
      delete c.anno_id
      return c
    })
    const res = await importa({ '0': 'CLASSE FUTURA' })
    expect(await res.json()).toMatchObject({ success: true })
    expect(alunniCreati()).toHaveLength(1)
  })
})

// PR 3 · 3.7-2: il finto di questo file non ha `rpc('anno_attivo')`; l'anno attivo non è l'oggetto del test.
vi.mock('@/lib/anno/frequenze', async (orig) => ({
  ...(await orig<typeof import('@/lib/anno/frequenze')>()),
  annoAttivoDiSede: async () => null,
}))
