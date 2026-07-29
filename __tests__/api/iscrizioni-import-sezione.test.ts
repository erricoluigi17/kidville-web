import { describe, it, expect, vi, beforeEach } from 'vitest'

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
vi.mock('@/lib/auth/scope', () => ({
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

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'u' }, error: null }) }) },
    from(table: string) {
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
  PATCH(req({ id: ID, action: 'import', assignments, referenteIndex: 0 }) as never)

const alunniCreati = () => h.inserts.filter((i) => i.table === 'alunni')

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []
  h.updates = []
  h.eventi = []
  h.sezioniFiltro = []
  h.sezioniErrore = null
  h.sezioni = [{ name: '3 ANNI' }, { name: '2 ANNI A' }]
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

describe('import iscrizioni — pre-flight della sezione nella sede', () => {
  it('sezione inesistente nella sede → success:false, invio pending, ZERO alunni creati', async () => {
    const res = await importa({ '0': 'Sezione Fantasma' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.errors.some((e: { messaggio: string }) => /Sezione Fantasma/.test(e.messaggio))).toBe(true)
    expect(alunniCreati()).toHaveLength(0)
    expect(h.inserts).toHaveLength(0)
    expect(h.updates.some((u) => u.row?.status === 'approved')).toBe(false)
  })

  it('logga l\'esito con l\'INDICE del bambino, mai il nome', async () => {
    await importa({ '0': 'Sezione Fantasma' })
    const ev = h.eventi.find((e) => e.campi?.esito === 'sezione-inesistente-in-sede')
    expect(ev).toBeDefined()
    expect(ev?.livello).toBe('error')
    expect(ev?.campi.indice).toBe(1)
    expect(JSON.stringify(ev?.campi)).not.toContain('Bimbo')
    expect(JSON.stringify(ev?.campi)).not.toContain('Fantasma')
  })

  it('maiuscole e spazi diversi ("  3 anni " vs "3 ANNI") → accettato come il trigger', async () => {
    const res = await importa({ '0': '  3 anni ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
    expect(alunniCreati()).toHaveLength(1)
  })

  it('la lettura di sections è filtrata sulla sede di SCRITTURA', async () => {
    await importa({ '0': '3 ANNI' })
    expect(h.sezioniFiltro).toContainEqual({ col: 'scuola_id', val: 'sc-1' })
  })

  it('DB E2E non migrato (42703) → salta il controllo e l\'import prosegue', async () => {
    h.sezioniErrore = { code: '42703', message: 'column sections.name does not exist' }
    const res = await importa({ '0': 'Qualsiasi Cosa' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
    const ev = h.eventi.find((e) => e.campi?.esito === 'sezioni-non-leggibili')
    expect(ev?.livello).toBe('info')
  })

  it('tabella assente (42P01) → salta il controllo e l\'import prosegue', async () => {
    h.sezioniErrore = { code: '42P01', message: 'relation "sections" does not exist' }
    const res = await importa({ '0': 'Qualsiasi Cosa' })
    expect(await res.json()).toMatchObject({ success: true })
  })
})
