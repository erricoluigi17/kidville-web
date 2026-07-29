import { describe, it, expect, vi, beforeEach } from 'vitest'

// A2 — L'import delle iscrizioni scriveva SOLO `student_parents` (spazio-id
// anagrafica). Le route di galleria/agenda/chat/diario/pagamenti leggevano
// SOLO `legame_genitori_alunni` (spazio-id account): ogni genitore importato
// dal form pubblico non vedeva il proprio figlio. Qui si blocca l'emorragia:
// l'import scrive ENTRAMBE le righe, ma solo per gli adulti che hanno davvero
// un account (`parents.auth_user_id`), perché `genitore_id` è un `utenti.id`.

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  ensureParentIdentity: vi.fn(),
  sincronizzaLegamiRuntime: vi.fn(),
  sub: null as Record<string, unknown> | null,
  upserts: [] as { table: string; payload: Record<string, unknown>; options: unknown }[],
  parentsByCf: {} as Record<string, { id: string; auth_user_id: string | null }>,
  upsertErrore: null as { code?: string; message: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/auth/parent-identity', () => ({ ensureParentIdentity: h.ensureParentIdentity }))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: h.sincronizzaLegamiRuntime }))
vi.mock('@/lib/email/send', () => ({
  sendEmail: async () => true,
  sendEmailDetailed: async () => ({ ok: true, error: null }),
  credentialsEmailBody: () => 'x',
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => undefined }))
// `vi.mock` sostituisce il modulo INTERO: ogni funzione che la route importa da
// qui deve comparire, o è `undefined` a runtime (500). `scuoleDiUtente` serve al
// gate di scope sulla sede dell'invio (A5).
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: async () => ['sc-1'],
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  scuoleDiUtente: async () => ['sc-1'],
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const filtri: Record<string, unknown> = {}
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, val: unknown) => { filtri[col] = val; return b }
      b.is = () => b
      b.in = () => b
      b.limit = () => b
      b.order = async () => ({ data: [], error: null })
      // Letture "a lista" attese direttamente sul builder: il pre-flight sezione
      // (A5) legge le `sections` della sede prima di scrivere.
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(
          table === 'sections' ? { data: [{ name: 'Girasoli' }], error: null } : { data: [], error: null },
        ).then(res)
      b.maybeSingle = async () => {
        if (table === 'enrollment_submissions') return { data: h.sub, error: null }
        if (table === 'parents' && typeof filtri.fiscal_code === 'string') {
          return { data: h.parentsByCf[filtri.fiscal_code] ?? null, error: null }
        }
        return { data: null, error: null }
      }
      b.single = async () => ({ data: null, error: null })
      b.insert = (row: Record<string, unknown>) => ({
        select: () => ({
          single: async () => ({ data: { id: `${table}-new`, nome: row?.nome ?? 'X' }, error: null }),
        }),
      })
      b.update = () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'x' }, error: null }) }) }) })
      b.upsert = async (payload: Record<string, unknown>, options: unknown) => {
        h.upserts.push({ table, payload, options })
        if (table === 'legame_genitori_alunni' && h.upsertErrore) {
          return { data: null, error: h.upsertErrore }
        }
        return { data: null, error: null }
      }
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/admin/iscrizioni/route'

const SUB_ID = '5b5b5b5b-5b5b-45b5-85b5-5b5b5b5b5b5b'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/iscrizioni', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

const importa = () =>
  PATCH(req({ id: SUB_ID, action: 'import', assignments: { '0': 'Girasoli' }, referenteIndex: 0 }) as never)

const legami = () => h.upserts.filter((u) => u.table === 'legame_genitori_alunni')
const anagrafici = () => h.upserts.filter((u) => u.table === 'student_parents')

beforeEach(() => {
  vi.clearAllMocks()
  h.upserts = []
  h.parentsByCf = {}
  h.upsertErrore = null
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.sincronizzaLegamiRuntime.mockResolvedValue({ creati: 0 })
  h.ensureParentIdentity.mockResolvedValue({
    ok: true, authUserId: 'acc-ref', email: 'ref@example.test',
    createdAuth: false, createdUtenti: false, boundNow: false, password: null,
  })
  h.sub = {
    id: SUB_ID,
    scuola_id: 'sc-1',
    data: {
      children: [{ nome: 'Bimbo', codice_fiscale: 'CFC1' }],
      adults: [{ first_name: 'Anna', fiscal_code: 'CF1', email: 'ref@example.test', ruolo: 'mother' }],
    },
  }
})

describe('import iscrizioni — legame runtime oltre a student_parents', () => {
  it('scrive ENTRAMBE le righe per il referente (che ha un account)', async () => {
    const res = await importa()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })

    expect(anagrafici()).toHaveLength(1)
    expect(anagrafici()[0].payload).toMatchObject({ student_id: 'alunni-new', parent_id: 'parents-new' })

    expect(legami()).toHaveLength(1)
    expect(legami()[0].payload).toMatchObject({ genitore_id: 'acc-ref', alunno_id: 'alunni-new' })
  })

  it('l\'adulto SENZA email non produce legame e non fa fallire l\'import', async () => {
    h.sub = {
      id: SUB_ID,
      scuola_id: 'sc-1',
      data: {
        children: [{ nome: 'Bimbo', codice_fiscale: 'CFC1' }],
        adults: [
          { first_name: 'Anna', fiscal_code: 'CF1', email: 'ref@example.test', ruolo: 'mother' },
          { first_name: 'Bruno', fiscal_code: 'CF2', ruolo: 'father' }, // niente email → niente account
        ],
      },
    }
    const res = await importa()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, linked_parents: 2 })

    // Entrambi in anagrafica, uno solo (il referente) nello spazio-id account.
    expect(anagrafici()).toHaveLength(2)
    expect(legami()).toHaveLength(1)
    expect(legami()[0].payload).toMatchObject({ genitore_id: 'acc-ref' })
  })

  it('adulto NON referente già dotato di account: legame sì, credenziali no', async () => {
    h.parentsByCf.CF2 = { id: 'p-esistente', auth_user_id: 'acc-altro' }
    h.sub = {
      id: SUB_ID,
      scuola_id: 'sc-1',
      data: {
        children: [{ nome: 'Bimbo', codice_fiscale: 'CFC1' }],
        adults: [
          { first_name: 'Anna', fiscal_code: 'CF1', email: 'ref@example.test', ruolo: 'mother' },
          { first_name: 'Bruno', fiscal_code: 'CF2', email: 'altro@example.test', ruolo: 'father' },
        ],
      },
    }
    const res = await importa()
    expect(res.status).toBe(200)

    // ensureParentIdentity resta riservata al REFERENTE: le credenziali non
    // devono partire per il secondo adulto.
    expect(h.ensureParentIdentity).toHaveBeenCalledTimes(1)

    const scritti = legami().map((u) => u.payload.genitore_id).sort()
    expect(scritti).toEqual(['acc-altro', 'acc-ref'])
    // Un solo intestatario al 100%: le quote di fatturazione non cambiano.
    const referente = legami().find((u) => u.payload.genitore_id === 'acc-ref')
    const altro = legami().find((u) => u.payload.genitore_id === 'acc-altro')
    expect(referente?.payload).toMatchObject({ intestatario_fattura: true, percentuale_pagamento: 100 })
    expect(altro?.payload).toMatchObject({ intestatario_fattura: false, percentuale_pagamento: 0 })
  })

  it('upsert idempotente: non sovrascrive un legame già configurato', async () => {
    await importa()
    expect(legami()[0].options).toMatchObject({ onConflict: 'genitore_id,alunno_id', ignoreDuplicates: true })
  })

  // A5 — terzo call-site della riparazione: quando il referente ottiene ORA il suo
  // account, i legami anagrafici che aveva GIÀ (un fratello iscritto l'anno prima,
  // dedup per CF) possono finalmente diventare righe `legame_genitori_alunni` — la
  // tabella che le policy RLS di pagamenti/incassi/note interrogano davvero. Senza
  // questa chiamata resterebbero fuori: il genitore entra, ma non vede il primo figlio.
  it('appena il referente ha un account, sincronizza i suoi legami anagrafici', async () => {
    await importa()
    expect(h.sincronizzaLegamiRuntime).toHaveBeenCalledTimes(1)
    expect(h.sincronizzaLegamiRuntime.mock.calls[0][1]).toBe('parents-new')
  })

  it('adulto senza account (ensureParentIdentity non riuscita): nessuna sincronizzazione', async () => {
    h.ensureParentIdentity.mockResolvedValue({ ok: false, reason: 'no_email', message: 'x' })
    await importa()
    expect(h.sincronizzaLegamiRuntime).not.toHaveBeenCalled()
  })

  it('DB E2E non migrato (PGRST204): degrada senza bloccare l\'import', async () => {
    h.upsertErrore = { code: 'PGRST204', message: "Could not find the 'intestatario_fattura' column of 'legame_genitori_alunni' in the schema cache" }
    const res = await importa()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
    // Ha riprovato togliendo la colonna assente.
    expect(legami().length).toBeGreaterThan(1)
    expect(legami()[legami().length - 1].payload).not.toHaveProperty('intestatario_fattura')
  })
})
