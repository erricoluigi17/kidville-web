import { describe, it, expect, vi, beforeEach } from 'vitest'

// B3 — La dedup dell'alunno per codice fiscale era GLOBALE, senza vincolo di sede.
//
// Il modulo pubblico accetta qualunque codice fiscale senza verificarlo, e il CF italiano
// si DEDUCE da nome, cognome, data e luogo di nascita e sesso: i dati che il genitore di un
// compagno di classe conosce. Se quel CF combaciava con un bambino GIÀ iscritto, la dedup
// riusava quel record e l'adulto della nuova domanda gli veniva agganciato — su
// `student_parents` E su `legame_genitori_alunni`, che è la tabella su cui fanno join le
// policy RLS di pagamenti/incassi/note e l'unione `getFigliDiGenitore`. Non era più un
// difetto anagrafico: era accesso reale ai dati di un minore altrui.
//
// Secondo danno, silenzioso: l'`update` sovrascriveva `classe_sezione` con una classe di
// un'ALTRA sede. Il trigger `sync_alunno_section_id()` risolve il nome DENTRO la stessa
// `scuola_id`: non trovandolo lascia `section_id` NULL senza dire niente, e il bambino
// sparisce dal registro della propria sede. Con «2 ANNI» e «5 ANNI» presenti sia ad Aversa
// sia a Cesa, l'omonimia fra sezioni non è più un'ipotesi di scuola.
//
// Il gate `assertInvioInScope` non copre niente di tutto questo: controlla la sede della
// DOMANDA, non quella del BAMBINO riusato.

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  ensureParentIdentity: vi.fn(),
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
  sub: null as Record<string, unknown> | null,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  upserts: [] as { table: string; payload: Record<string, unknown> }[],
  // Anagrafica `alunni` finta, multi-sede.
  alunni: [] as { id: string; codice_fiscale?: string | null; scuola_id: string; nome?: string; cognome?: string; data_nascita?: string }[],
  // Errore restituito dalle letture su `alunni` (degrado DB E2E non migrato).
  alunniErrore: null as { code?: string; message: string } | null,
  // Filtri di OGNI lettura su `alunni`: serve a dimostrare che la dedup è vincolata alla sede.
  filtriAlunni: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/email/send', () => ({
  sendEmail: async () => true,
  sendEmailDetailed: async () => ({ ok: true, error: null }),
  credentialsEmailBody: () => 'x',
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => undefined }))
vi.mock('@/lib/auth/parent-identity', () => ({ ensureParentIdentity: h.ensureParentIdentity }))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: async () => ({ creati: 0 }) }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: async () => ['sc-giugliano'],
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-giugliano' }),
  scuoleDiUtente: async () => ['sc-giugliano'],
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
      // I filtri sono per CHIAMATA: `from()` crea un builder nuovo ogni volta.
      const filtri: Record<string, unknown> = {}
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, val: unknown) => {
        filtri[col] = val
        return b
      }
      b.in = () => b
      b.limit = () => b
      b.order = async () => ({ data: [], error: null })
      // Letture "a lista", attese direttamente sul builder.
      b.then = (res: (v: unknown) => unknown) => {
        if (table === 'sections') return Promise.resolve({ data: [{ name: '3 ANNI' }], error: null }).then(res)
        if (table === 'alunni') {
          h.filtriAlunni.push({ ...filtri })
          if (h.alunniErrore) return Promise.resolve({ data: null, error: h.alunniErrore }).then(res)
          const righe = h.alunni
            .filter((a) => a.codice_fiscale === filtri.codice_fiscale)
            .map((a) => ({ scuola_id: a.scuola_id }))
          return Promise.resolve({ data: righe, error: null }).then(res)
        }
        return Promise.resolve({ data: [], error: null }).then(res)
      }
      b.maybeSingle = async () => {
        if (table === 'enrollment_submissions') return { data: h.sub, error: null }
        if (table === 'alunni') {
          h.filtriAlunni.push({ ...filtri })
          if (h.alunniErrore) return { data: null, error: h.alunniErrore }
          const r = h.alunni.find(
            (a) =>
              (filtri.codice_fiscale === undefined || a.codice_fiscale === filtri.codice_fiscale) &&
              (filtri.scuola_id === undefined || a.scuola_id === filtri.scuola_id) &&
              (filtri.nome === undefined || a.nome === filtri.nome) &&
              (filtri.cognome === undefined || a.cognome === filtri.cognome) &&
              (filtri.data_nascita === undefined || a.data_nascita === filtri.data_nascita),
          )
          return { data: r ? { id: r.id } : null, error: null }
        }
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
      b.upsert = async (payload: Record<string, unknown>) => {
        h.upserts.push({ table, payload })
        return { data: null, error: null }
      }
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/admin/iscrizioni/route'

const ID = '5b5b5b5b-5b5b-45b5-85b5-5b5b5b5b5b5b'
const CF_BIMBO = 'RSSMRA20A01F839X'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/iscrizioni', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const importa = (body: Record<string, unknown> = {}) =>
  PATCH(req({ id: ID, action: 'import', assignments: { '0': '3 ANNI' }, referenteIndex: 0, ...body }) as never)

const insertsSu = (t: string) => h.inserts.filter((i) => i.table === t)
const updatesSu = (t: string) => h.updates.filter((u) => u.table === t)
const upsertsSu = (t: string) => h.upserts.filter((u) => u.table === t)

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []
  h.updates = []
  h.upserts = []
  h.eventi = []
  h.alunni = []
  h.alunniErrore = null
  h.filtriAlunni = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-giugliano' } })
  h.ensureParentIdentity.mockResolvedValue({
    ok: true, authUserId: 'acc-ref', email: 'ref@example.test',
    createdAuth: false, createdUtenti: false, boundNow: false, password: null,
  })
  h.sub = {
    id: ID,
    scuola_id: 'sc-giugliano',
    data: {
      children: [{ nome: 'Bimbo', cognome: 'Rossi', data_nascita: '2020-01-01', codice_fiscale: CF_BIMBO }],
      adults: [{ first_name: 'Anna', fiscal_code: 'CF-ADULTO', email: 'ref@example.test', ruolo: 'mother' }],
    },
  }
})

describe('import iscrizioni — dedup dell\'alunno vincolata alla sede', () => {
  it('CF già iscritto NELLA STESSA sede → riuso, come oggi (nessun alunno nuovo)', async () => {
    h.alunni = [{ id: 'al-esistente', codice_fiscale: CF_BIMBO, scuola_id: 'sc-giugliano' }]
    const res = await importa()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
    expect(insertsSu('alunni')).toHaveLength(0)
    expect(updatesSu('alunni')[0]?.row).toMatchObject({ classe_sezione: '3 ANNI' })
    // Il riuso in sede resta agganciato all'adulto: comportamento invariato.
    expect(upsertsSu('student_parents')).toHaveLength(1)
  })

  it('CF iscritto in UN\'ALTRA sede → errore bloccante, invio pending, ZERO scritture', async () => {
    h.alunni = [{ id: 'al-aversa', codice_fiscale: CF_BIMBO, scuola_id: 'sc-aversa' }]
    const res = await importa()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.errors.some((e: { messaggio: string }) => /altra sede/i.test(e.messaggio))).toBe(true)
    expect(json.errors.some((e: { messaggio: string }) => /trasferimento/i.test(e.messaggio))).toBe(true)
    expect(json.errors[0].dove).toBe('Bambino 1')

    // Nessun aggancio al bambino di un'altra sede, in nessuno dei due spazi-id.
    expect(insertsSu('alunni')).toHaveLength(0)
    expect(updatesSu('alunni')).toHaveLength(0)
    expect(upsertsSu('student_parents')).toHaveLength(0)
    expect(upsertsSu('legame_genitori_alunni')).toHaveLength(0)
    // Blocco PRIMA di ogni scrittura: nemmeno l'adulto entra in anagrafica, e
    // nessun account/credenziale parte per chi sta tentando l'aggancio.
    expect(insertsSu('parents')).toHaveLength(0)
    expect(h.ensureParentIdentity).not.toHaveBeenCalled()
    // L'invio resta 'pending'.
    expect(h.updates.some((u) => u.row?.status === 'approved')).toBe(false)
  })

  it('il log del blocco non contiene né il codice fiscale né il nome', async () => {
    h.alunni = [{ id: 'al-aversa', codice_fiscale: CF_BIMBO, scuola_id: 'sc-aversa' }]
    await importa()
    const ev = h.eventi.find((e) => e.campi?.esito === 'cf-gia-iscritto-altra-sede')
    expect(ev).toBeDefined()
    expect(ev?.livello).toBe('error')
    expect(ev?.campi.indice).toBe(1)
    const serializzato = JSON.stringify(ev?.campi)
    expect(serializzato).not.toContain(CF_BIMBO)
    expect(serializzato).not.toContain('Bimbo')
    expect(serializzato).not.toContain('Rossi')
    expect(serializzato).not.toContain('ref@example.test')
  })

  it('la dedup per CF è filtrata sulla sede di scrittura', async () => {
    h.alunni = [{ id: 'al-esistente', codice_fiscale: CF_BIMBO, scuola_id: 'sc-giugliano' }]
    await importa()
    expect(h.filtriAlunni).toContainEqual({ codice_fiscale: CF_BIMBO, scuola_id: 'sc-giugliano' })
  })

  it('CF presente in sede E altrove → vince il record della sede, nessun blocco', async () => {
    h.alunni = [
      { id: 'al-aversa', codice_fiscale: CF_BIMBO, scuola_id: 'sc-aversa' },
      { id: 'al-giugliano', codice_fiscale: CF_BIMBO, scuola_id: 'sc-giugliano' },
    ]
    const res = await importa()
    expect(await res.json()).toMatchObject({ success: true })
    expect(insertsSu('alunni')).toHaveLength(0)
    expect(updatesSu('alunni')).toHaveLength(1)
  })

  it('CF mai visto → alunno creato nella sede di scrittura (comportamento invariato)', async () => {
    const res = await importa()
    expect(await res.json()).toMatchObject({ success: true })
    expect(insertsSu('alunni')[0]?.row).toMatchObject({ scuola_id: 'sc-giugliano', codice_fiscale: CF_BIMBO })
  })

  it('DB E2E non migrato (42703 sulla lettura) → non blocca, degrada a info', async () => {
    h.alunniErrore = { code: '42703', message: 'column alunni.scuola_id does not exist' }
    const res = await importa()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
    const ev = h.eventi.find((e) => e.campi?.esito === 'dedup-cf-non-disponibile')
    expect(ev?.livello).toBe('info')
    expect(insertsSu('alunni')).toHaveLength(1)
  })

  it('guasto vero sulla lettura (non schema assente) → non blocca, ma logga error', async () => {
    h.alunniErrore = { code: '08006', message: 'connection failure' }
    const res = await importa()
    expect(await res.json()).toMatchObject({ success: true })
    const ev = h.eventi.find((e) => e.campi?.esito === 'dedup-cf-non-disponibile')
    expect(ev?.livello).toBe('error')
  })

  it('dedup SOFT (senza CF): un omonimo di un\'ALTRA sede non viene riusato', async () => {
    h.alunni = [{ id: 'al-omonimo-aversa', scuola_id: 'sc-aversa', nome: 'Bimbo', cognome: 'Rossi', data_nascita: '2020-01-01' }]
    h.sub = {
      ...(h.sub as Record<string, unknown>),
      data: {
        children: [{ nome: 'Bimbo', cognome: 'Rossi', data_nascita: '2020-01-01' }], // niente CF
        adults: [{ first_name: 'Anna', fiscal_code: 'CF-ADULTO', email: 'ref@example.test', ruolo: 'mother' }],
      },
    }
    const res = await importa()
    expect(await res.json()).toMatchObject({ success: true })
    expect(insertsSu('alunni')).toHaveLength(1)
    expect(updatesSu('alunni')).toHaveLength(0)
  })

  it('dedup SOFT (senza CF): l\'omonimo della PROPRIA sede viene riusato', async () => {
    h.alunni = [{ id: 'al-omonimo', scuola_id: 'sc-giugliano', nome: 'Bimbo', cognome: 'Rossi', data_nascita: '2020-01-01' }]
    h.sub = {
      ...(h.sub as Record<string, unknown>),
      data: {
        children: [{ nome: 'Bimbo', cognome: 'Rossi', data_nascita: '2020-01-01' }],
        adults: [{ first_name: 'Anna', fiscal_code: 'CF-ADULTO', email: 'ref@example.test', ruolo: 'mother' }],
      },
    }
    const res = await importa()
    expect(await res.json()).toMatchObject({ success: true })
    expect(insertsSu('alunni')).toHaveLength(0)
    expect(updatesSu('alunni')).toHaveLength(1)
  })
})
