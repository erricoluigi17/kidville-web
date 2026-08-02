import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// S23 — I consensi fotografici GRANULARI arrivano a destinazione (privacy F4).
//
// Il modulo pubblico chiede TRE consensi distinti per canale (provv. Garante
// 725 del 27/11/2025): galleria riservata, sito web, canali social. Fino al
// 2026-07-31 solo il primo aveva una colonna dove atterrare
// (`alunni.consenso_privacy`): gli altri due — risposti da 141 famiglie —
// venivano congelati in `consents_log` e poi **dimenticati**. Nessuna colonna,
// nessun lettore. Una famiglia che aveva NEGATO la pubblicazione sui social
// credeva di averla negata, e nel sistema non c'era differenza fra il suo «no»
// e il «sì» della famiglia accanto.
//
// Qui si verifica che l'import porti TUTTI E TRE i consensi sulla riga
// dell'alunno, ciascuno sul proprio canale, e che il lock impedisca a un quarto
// canale di nascere di nuovo senza destinazione.
// =============================================================================

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  sub: null as Record<string, unknown> | null,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  /** Colonne che questo DB non ha: l'insert risponde PGRST204, come PostgREST. */
  colonneAssenti: [] as string[],
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
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: async () => ['sc-1'],
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  scuoleDiUtente: async () => ['sc-1'],
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'u' }, error: null }) }) },
    from(table: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.limit = () => b
      b.order = async () => ({ data: [], error: null })
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(
          table === 'sections' ? { data: [{ name: 'Girasoli' }], error: null } : { data: [], error: null },
        ).then(res)
      b.maybeSingle = async () => (table === 'enrollment_submissions' ? { data: h.sub, error: null } : { data: null, error: null })
      b.single = async () => (table === 'enrollment_submissions' ? { data: h.sub, error: null } : { data: null, error: null })
      b.insert = (row: Record<string, unknown>) => {
        h.inserts.push({ table, row: { ...row } })
        const mancante = h.colonneAssenti.find((c) => c in row)
        return {
          select: () => ({
            single: async () =>
              mancante
                ? { data: null, error: { code: 'PGRST204', message: `Could not find the '${mancante}' column of '${table}' in the schema cache` } }
                : { data: { id: `${table}-new`, nome: (row?.nome as string) ?? 'X' }, error: null },
          }),
        }
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
import { CONSENSI_FIELDS, CONSENSI_FOTO_CANALI } from '@/lib/forms/enrollment-template'

const ID = '5b5b5b5b-5b5b-45b5-85b5-5b5b5b5b5b5b'
const req = (body: unknown) =>
  new Request('http://localhost/api/admin/iscrizioni', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const importa = () =>
  PATCH(req({ id: ID, action: 'import', assignments: { '0': 'Girasoli' }, referenteIndex: 0 }) as never)

/** Domanda con la PROVA dei consensi (`consents_log`), non il payload grezzo. */
const domanda = (blocchi: { field_id: string; accepted: boolean }[]) => ({
  id: ID,
  scuola_id: 'sc-1',
  consents_log: { blocchi },
  data: {
    children: [{ nome: 'Luca', cognome: 'Rossi', codice_fiscale: 'CFCH1' }],
    adults: [{ first_name: 'Mario', last_name: 'Rossi', fiscal_code: 'CFAD1' }],
  },
})

const rigaAlunno = () => h.inserts.find((i) => i.table === 'alunni')?.row

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []
  h.updates = []
  h.colonneAssenti = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
})

describe('import iscrizione — i tre consensi foto atterrano ciascuno sul proprio canale', () => {
  it('tutti e tre accettati → tutte e tre le colonne a true', async () => {
    h.sub = domanda([
      { field_id: 'consenso_foto_galleria', accepted: true },
      { field_id: 'consenso_foto_sito', accepted: true },
      { field_id: 'consenso_foto_social', accepted: true },
    ])
    const res = await importa()
    expect(res.status).toBe(200)
    const row = rigaAlunno()
    expect(row?.consenso_privacy).toBe(true)
    expect(row?.consenso_foto_sito).toBe(true)
    expect(row?.consenso_foto_social).toBe(true)
  })

  it('SOLO la galleria accettata → sito e social restano false (granularità per canale)', async () => {
    h.sub = domanda([
      { field_id: 'consenso_foto_galleria', accepted: true },
      { field_id: 'consenso_foto_sito', accepted: false },
      { field_id: 'consenso_foto_social', accepted: false },
    ])
    await importa()
    const row = rigaAlunno()
    // controllo positivo: il canale accettato passa davvero…
    expect(row?.consenso_privacy).toBe(true)
    // …e i due negati NON passano.
    expect(row?.consenso_foto_sito).toBe(false)
    expect(row?.consenso_foto_social).toBe(false)
  })

  it('SOLO il sito accettato → la galleria resta false (i canali non si contaminano)', async () => {
    h.sub = domanda([{ field_id: 'consenso_foto_sito', accepted: true }])
    await importa()
    const row = rigaAlunno()
    expect(row?.consenso_foto_sito).toBe(true)
    expect(row?.consenso_privacy).toBe(false)
    expect(row?.consenso_foto_social).toBe(false)
  })

  it('nessuna prova di consenso (domande anteriori al passo consensi) → tutte false', async () => {
    h.sub = { ...domanda([]), consents_log: null }
    await importa()
    const row = rigaAlunno()
    expect(row?.consenso_privacy).toBe(false)
    expect(row?.consenso_foto_sito).toBe(false)
    expect(row?.consenso_foto_social).toBe(false)
  })

  it('DB E2E non migrato: PGRST204 sulle colonne nuove → si ritenta senza, l’import riesce', async () => {
    h.colonneAssenti = ['consenso_foto_sito', 'consenso_foto_social']
    h.sub = domanda([{ field_id: 'consenso_foto_sito', accepted: true }])
    const res = await importa()
    const json = (await res.json()) as { success?: boolean }
    expect(json.success).toBe(true)
    const ultimo = [...h.inserts].reverse().find((i) => i.table === 'alunni')?.row
    expect(ultimo).not.toHaveProperty('consenso_foto_sito')
    // controllo positivo: la riga è stata comunque scritta, con i dati anagrafici
    expect(ultimo?.nome).toBe('Luca')
  })
})

describe('lock — nessun consenso foto senza destinazione', () => {
  it('ogni consenso foto dichiarato nel modulo ha una colonna di destinazione', () => {
    const dichiarati = CONSENSI_FIELDS.filter((f) => f.id.startsWith('consenso_foto_')).map((f) => f.id)
    // controllo positivo: i consensi foto ci sono davvero (se il template si
    // svuotasse, l'asserzione sotto sarebbe vera per vuoto e non direbbe niente)
    expect(dichiarati.length).toBeGreaterThanOrEqual(3)
    for (const id of dichiarati) {
      expect(Object.keys(CONSENSI_FOTO_CANALI)).toContain(id)
    }
  })

  // Lock COMPORTAMENTALE, guidato dalla mappa: un quarto canale aggiunto domani
  // a `CONSENSI_FOTO_CANALI` entra qui da solo. È l'opposto del difetto che
  // stiamo chiudendo — dove l'elenco dei canali letti era scritto a mano nella
  // route e si era fermato al primo.
  for (const [fieldId, colonna] of Object.entries(CONSENSI_FOTO_CANALI)) {
    it(`l'import porta «${fieldId}» sulla colonna «${colonna}», e solo su quella`, async () => {
      h.sub = domanda([{ field_id: fieldId, accepted: true }])
      await importa()
      const row = rigaAlunno()
      expect(row?.[colonna], `${fieldId} non arriva su ${colonna}`).toBe(true)
      for (const altra of Object.values(CONSENSI_FOTO_CANALI)) {
        if (altra !== colonna) expect(row?.[altra], `${fieldId} ha contaminato ${altra}`).toBe(false)
      }
    })
  }
})
