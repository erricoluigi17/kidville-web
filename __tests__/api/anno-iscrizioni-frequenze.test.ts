import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { creaFintoSupabase } from '../fixtures/finto-supabase'

/**
 * PR 3 · COMPITO 3.7-2b · `PATCH /api/admin/iscrizioni` (azione `import`) collegato a `scriviFrequenza` (fase A, §4.19).
 *
 * I tre siti della route: la scheda ESISTENTE aggiornata (re-iscrizione / abbinamento), l'alunno NUOVO inserito e la
 * seconda passata `retta_a_carico_di`. Per ognuno: `alunni` scritto con successo e patch con colonne copiate → UNA
 * chiamata coi campi tradotti e l'anno della sede; `alunni` in errore → ZERO; patch senza colonne copiate → ZERO.
 *
 * ⚠️ Difetto noto, NON corretto qui (lo chiude la PR 4.5): la re-iscrizione sposta il bambino nella classe nuova
 * scrivendo `classe_sezione` su `alunni`. La frequenza dell'anno attivo segue `alunni`, come fa lo specchio.
 */

const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as unknown[],
  errori: {} as Record<string, { code: string; message?: string }>,
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  ensureParentIdentity: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  scriviFrequenza: vi.fn(),
  annoAttivoDiSede: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/email/send', () => ({
  sendEmail: async () => true,
  sendEmailDetailed: async () => ({ ok: true, error: null }),
}))
vi.mock('@/lib/email/contesto', () => ({ risolviContestoSede: async () => ({ email: null, nome: 'Sede di prova' }) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => undefined }))
vi.mock('@/lib/auth/parent-identity', () => ({ ensureParentIdentity: h.ensureParentIdentity }))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: async () => ({ creati: 0 }) }))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => [SEDE],
  resolveScuolaScrittura: async () => ({ scuolaId: SEDE }),
  scuoleDiUtente: async () => [SEDE],
  assertAlunnoInScope: h.assertAlunnoInScope,
}))
vi.mock('@/lib/anno/frequenze', async (orig) => ({
  ...(await orig<typeof import('@/lib/anno/frequenze')>()),
  scriviFrequenza: h.scriviFrequenza,
  annoAttivoDiSede: h.annoAttivoDiSede,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(h.db as DBFinto, [], { scritture: h.scritture as Scrittura[], errori: h.errori }),
}))

import { PATCH } from '@/app/api/admin/iscrizioni/route'

const SEDE = 'a1a1a1a1-0000-4000-8000-000000000001'
const DOMANDA = 'f0f0f0f0-0000-4000-8000-000000000010'
const ESISTENTE = 'c3c3c3c3-0000-4000-8000-000000000003'
const ACCOUNT = 'e5e5e5e5-0000-4000-8000-000000000006'
const ANNO = `anno-di-${SEDE}`

const bambino = (nome: string, over: Record<string, unknown> = {}) => ({
  nome, cognome: 'Prova', data_nascita: nome === 'Mario' ? '2019-03-07' : '2020-04-08', ...over,
})
const adulto = {
  first_name: 'Anna', last_name: 'Bianchi', birth_date: '1985-06-10', fiscal_code: 'XQQYKV85H50Z999J',
  email: 'anna@example.test', ruolo: 'mother',
}
const domanda = (children: unknown[]) => ({
  id: DOMANDA, scuola_id: SEDE, status: 'pending', consents_log: null, data: { children, adults: [adulto] },
})

const importa = (extra: Record<string, unknown>) =>
  PATCH(new Request('http://localhost/api/admin/iscrizioni', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: DOMANDA, action: 'import', referenteIndex: 0, ...extra }),
  }) as never)

const chiamate = () => h.scriviFrequenza.mock.calls.map((c) => c[1])

beforeEach(() => {
  vi.clearAllMocks()
  h.scritture = []
  h.errori = {}
  h.db = {
    enrollment_submissions: [domanda([bambino('Mario')])],
    sections: [{ id: 'sez-1', scuola_id: SEDE, name: '3 ANNI' }, { id: 'sez-2', scuola_id: SEDE, name: '4 ANNI' }],
    alunni: [],
    parents: [],
  }
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE } })
  h.assertAlunnoInScope.mockResolvedValue(null)
  h.ensureParentIdentity.mockImplementation(async (_s: unknown, p: { emails: string[] }) => ({
    ok: true, authUserId: ACCOUNT, email: p.emails[0], createdAuth: false, createdUtenti: false, boundNow: false, password: null,
  }))
  h.annoAttivoDiSede.mockImplementation(async (_c: unknown, sede: string | null) => (sede ? `anno-di-${sede}` : null))
  h.scriviFrequenza.mockResolvedValue({ ok: true })
})

describe('import a mano — alunno NUOVO', () => {
  it('una chiamata: retta tradotta, anno attivo della sede, id dell’alunno creato', async () => {
    const json = await (await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })).json()
    expect(json.success).toBe(true)
    const creato = h.db.alunni[0]
    expect(chiamate()).toEqual([{ alunnoId: creato.id, annoSedeId: ANNO, campi: { retta_mensile: 300 } }])
  })

  it('alunni in errore: zero chiamate', async () => {
    h.errori = { 'alunni:insert': { code: '23514', message: 'no' } }
    const json = await (await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })).json()
    expect(json.success).toBe(false)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  it('scriviFrequenza fallita: l’import resta riuscito', async () => {
    h.scriviFrequenza.mockResolvedValue({ ok: false, codice: 'SEZIONE_DI_ALTRO_ANNO' })
    const json = await (await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 } })).json()
    expect(json.success).toBe(true)
  })

  it('l’anno della sede si legge una volta sola per richiesta, anche con due bambini', async () => {
    h.db.enrollment_submissions = [domanda([bambino('Mario'), bambino('Luca')])]
    await importa({ assignments: { '0': '3 ANNI', '1': '4 ANNI' }, rette: { '0': 300, '1': 250 } })
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(2)
    const cache = h.annoAttivoDiSede.mock.calls.map((c) => c[2])
    expect(cache[0]).toBeInstanceOf(Map)
    expect(cache[1]).toBe(cache[0])
  })
})

describe('import a mano — «la paga il fratello»', () => {
  it('il fratello non ha cifra: nessuna chiamata per il suo insert, una per il legame dopo', async () => {
    h.db.enrollment_submissions = [domanda([bambino('Mario'), bambino('Luca')])]
    const json = await (await importa({
      assignments: { '0': '3 ANNI', '1': '4 ANNI' }, rette: { '0': 300 }, retteACarico: { '1': 0 },
    })).json()
    expect(json.success).toBe(true)
    const [primo, secondo] = h.db.alunni
    expect(chiamate()).toEqual([
      { alunnoId: primo.id, annoSedeId: ANNO, campi: { retta_mensile: 300 } },
      { alunnoId: secondo.id, annoSedeId: ANNO, campi: { retta_a_carico_di: primo.id } },
    ])
  })

  it('update del legame in errore: nessuna chiamata per il legame', async () => {
    h.db.enrollment_submissions = [domanda([bambino('Mario'), bambino('Luca')])]
    h.errori = { 'alunni:update': { code: '23503', message: 'no' } }
    await importa({ assignments: { '0': '3 ANNI', '1': '4 ANNI' }, rette: { '0': 300 }, retteACarico: { '1': 0 } })
    expect(chiamate().filter((c) => 'retta_a_carico_di' in (c.campi as object))).toHaveLength(0)
  })
})

describe('import a mano — scheda ESISTENTE (abbinamento)', () => {
  const scheda = {
    id: ESISTENTE, scuola_id: SEDE, nome: 'Mario', cognome: 'Prova', data_nascita: '2019-03-07',
    codice_fiscale: 'XQQYKV19C07Z999T', anonimizzato_il: null,
  }
  // stesso nome e stessa data, codice fiscale con un refuso: è il gemello che la segreteria abbina a mano
  const conGemello = () => { h.db.enrollment_submissions = [domanda([bambino('Mario', { codice_fiscale: 'XQQYKV19C07Z999A' })])] }

  it('una chiamata con la retta nuova; classe_sezione non è una colonna copiata', async () => {
    conGemello()
    h.db.alunni = [{ ...scheda }]
    const json = await (await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 }, abbinamenti: { '0': ESISTENTE } })).json()
    expect(json.success).toBe(true)
    expect(chiamate()).toEqual([{ alunnoId: ESISTENTE, annoSedeId: ANNO, campi: { retta_mensile: 300 } }])
  })

  it('update di alunni in errore: zero chiamate', async () => {
    conGemello()
    h.db.alunni = [{ ...scheda }]
    h.errori = { 'alunni:update': { code: '23514', message: 'no' } }
    await importa({ assignments: { '0': '3 ANNI' }, rette: { '0': 300 }, abbinamenti: { '0': ESISTENTE } })
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })
})
