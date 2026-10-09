import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// S22 — quando la domanda è ACCOLTA, la copia dei dati sanitari non serve più.
//
// Allergie e note mediche del minore vivono in DUE posti: `alunni.allergies` /
// `alunni.note_mediche` (dove le legge la cucina, dove le corregge la segreteria
// e da dove l'oblio le cancella) e la domanda originale, dentro
// `enrollment_submissions.data`. Finito l'import, la seconda è una copia
// ridondante di una categoria particolare (art. 9) — e usciva integra da
// `GET /api/admin/iscrizioni` a ogni apertura di «Moduli ricevuti», per ogni
// ruolo di staff della sede, senza scadenza.
//
// Non è una cancellazione della domanda: identità, residenza e consensi restano.
// Se ne tolgono i due soli campi sanitari, e SOLO quando l'import è riuscito.
// =============================================================================

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  sub: null as Record<string, unknown> | null,
  updates: [] as { table: string; row: Record<string, unknown> }[],
  sezioni: [] as { name: string }[],
  // La re-iscrizione (2026-10-09): la scheda che la dedup per codice fiscale trova,
  // i suoi dati sanitari, e i due guasti possibili (lettura e scrittura della scheda).
  esistente: null as { id: string } | null,
  schedaSanitari: null as Record<string, unknown> | null,
  letturaSchedaFallisce: false,
  updateAlunniFallisce: false,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/email/send', () => ({
  sendEmail: async () => true,
  sendEmailDetailed: async () => ({ ok: true, error: null }),
  credentialsEmailBody: () => 'x',
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'u' }, error: null }) }) },
    auth: { admin: { createUser: async () => ({ data: { user: { id: 'auth-new' } }, error: null }) } },
    from(table: string) {
      const b: Record<string, unknown> = {}
      let colonne = ''
      b.select = (c?: string) => { colonne = c ?? ''; return b }
      b.eq = () => b
      b.limit = () => b
      b.contains = () => b
      b.order = async () => ({ data: [], error: null })
      b.maybeSingle = async () => {
        if (table === 'enrollment_submissions') return { data: h.sub, error: null }
        if (table === 'alunni' && colonne.includes('allergies')) {
          return h.letturaSchedaFallisce
            ? { data: null, error: { code: '57014', message: 'timeout' } }
            : { data: h.schedaSanitari, error: null }
        }
        if (table === 'alunni' && colonne === 'id') return { data: h.esistente, error: null }
        return { data: null, error: null }
      }
      b.single = async () => {
        if (table === 'enrollment_submissions') return { data: h.sub, error: null }
        return { data: null, error: null }
      }
      b.then = (res: (v: unknown) => unknown) => {
        const data = table === 'sections' ? h.sezioni : []
        return Promise.resolve({ data, error: null }).then(res)
      }
      b.insert = (row: unknown) => ({
        select: () => ({
          single: async () => ({
            data: { id: `${table}-new`, nome: (row as { nome?: string } | null)?.nome ?? 'X' },
            error: null,
          }),
        }),
      })
      b.update = (row: Record<string, unknown>) => {
        h.updates.push({ table, row })
        const q: Record<string, unknown> = {}
        q.eq = () => q
        q.select = () => q
        q.single = async () => ({ data: { id: 'x' }, error: null })
        const error = table === 'alunni' && h.updateAlunniFallisce ? { code: '23514', message: 'violazione di prova' } : null
        q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error }).then(res)
        return q
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

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.updates = []
  h.sezioni = [{ name: 'Girasoli' }]
  h.esistente = null
  h.schedaSanitari = null
  h.letturaSchedaFallisce = false
  h.updateAlunniFallisce = false
  h.sub = {
    id: ID,
    scuola_id: 'sc-1',
    data: {
      children: [
        {
          nome: 'Bimbo',
          cognome: 'DiProva',
          codice_fiscale: 'AAABBB10A01H501X',
          allergies: 'DATO SANITARIO DI PROVA',
          note_mediche: 'ALTRO DATO SANITARIO DI PROVA',
        },
      ],
      adults: [{ first_name: 'Adulta', fiscal_code: 'EEEFFF80C03H501Z' }], // niente email → nessun account
    },
  }
})

describe('PATCH /api/admin/iscrizioni — la domanda accolta perde la copia sanitaria', () => {
  it('import riuscito: allergie e note mediche escono dalla domanda, il resto resta', async () => {
    const res = await PATCH(req({ id: ID, action: 'import', assignments: { '0': 'Girasoli' }, rette: { '0': 300 }, referenteIndex: 99 }) as never)
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)

    const approvazione = h.updates.find(
      (u) => u.table === 'enrollment_submissions' && u.row.status === 'approved',
    )
    expect(approvazione, 'la domanda non è stata marcata approved').toBeTruthy()
    const dati = approvazione!.row.data as { children: Record<string, unknown>[] } | undefined
    expect(dati, 'l’UPDATE di approvazione non riscrive `data`: la copia sanitaria resta').toBeTruthy()
    expect(dati!.children[0].allergies).toBeNull()
    expect(dati!.children[0].note_mediche).toBeNull()
    // Controlli POSITIVI accanto ai negativi: la domanda resta un atto
    // amministrativo leggibile. Se lo scrub azzerasse tutto, cadrebbero per primi.
    expect(dati!.children[0].nome).toBe('Bimbo')
    expect(dati!.children[0].codice_fiscale).toBe('AAABBB10A01H501X')
  })

  it('import BLOCCATO (sezione inesistente in sede): la domanda non si tocca affatto', async () => {
    // Controllo positivo dell'altro verso: lo scrub non deve MAI anticipare
    // l'esito. Se l'import non passa, la domanda resta 'pending' e integra —
    // altrimenti la segreteria riproverebbe su dati sanitari già cancellati.
    h.sezioni = [{ name: 'Tulipani' }]
    const res = await PATCH(req({ id: ID, action: 'import', assignments: { '0': 'Girasoli' }, rette: { '0': 300 }, referenteIndex: 99 }) as never)
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(false)
    expect(h.updates.some((u) => u.table === 'enrollment_submissions')).toBe(false)
  })
})

// =============================================================================
// LA RE-ISCRIZIONE (2026-10-09). Il bambino ha già una scheda in sede: fino a
// oggi la scheda riceveva solo classe e retta, e la domanda perdeva comunque i
// dati sanitari. Misurato in produzione: 148 schede senza i dati della domanda.
// =============================================================================
describe('PATCH /api/admin/iscrizioni — scheda già esistente: i sanitari arrivano in scheda', () => {
  const importa = () =>
    PATCH(req({ id: ID, action: 'import', assignments: { '0': 'Girasoli' }, rette: { '0': 300 }, referenteIndex: 99 }) as never)
  const updateScheda = () => h.updates.find((u) => u.table === 'alunni' && 'classe_sezione' in u.row)?.row
  const figlioDellaDomanda = () => {
    const approvazione = h.updates.find((u) => u.table === 'enrollment_submissions' && u.row.status === 'approved')
    return (approvazione?.row.data as { children: Record<string, unknown>[] }).children[0]
  }

  beforeEach(() => {
    h.esistente = { id: 'alunno-esistente' }
  })

  it('scheda VUOTA: allergie e note della domanda vanno in scheda, e solo allora escono dalla domanda', async () => {
    h.schedaSanitari = { allergies: null, note_mediche: '' }
    const res = await importa()
    expect((await res.json()).success).toBe(true)

    expect(updateScheda(), 'la scheda esistente non è stata aggiornata').toMatchObject({
      classe_sezione: 'Girasoli',
      allergies: 'DATO SANITARIO DI PROVA',
      note_mediche: 'ALTRO DATO SANITARIO DI PROVA',
    })
    expect(figlioDellaDomanda().allergies).toBeNull()
    expect(figlioDellaDomanda().sanitari_rimossi_il).toBeTruthy()
  })

  it('la scheda dice ALTRO: non si sovrascrive, la dichiarazione nuova va in coda', async () => {
    h.schedaSanitari = { allergies: 'ALLERGIA GIÀ IN SCHEDA', note_mediche: 'ALTRO DATO SANITARIO DI PROVA' }
    await importa()

    const scheda = updateScheda()!
    expect(String(scheda.allergies).startsWith('ALLERGIA GIÀ IN SCHEDA\nDalla domanda di iscrizione del ')).toBe(true)
    expect(String(scheda.allergies).endsWith(': DATO SANITARIO DI PROVA')).toBe(true)
    expect('note_mediche' in scheda, 'le note erano già in scheda: non si riscrivono').toBe(false)
    expect(figlioDellaDomanda().allergies).toBeNull()
  })

  it('la scheda non si legge: i sanitari NON si toccano, e restano nella domanda', async () => {
    h.letturaSchedaFallisce = true
    await importa()

    expect(updateScheda()).toBeTruthy()
    expect('allergies' in updateScheda()!).toBe(false)
    expect(figlioDellaDomanda().allergies, 'il dato è uscito dalla domanda senza essere in scheda').toBe('DATO SANITARIO DI PROVA')
  })

  it('l\'UPDATE della scheda fallisce: si avvisa, e la domanda tiene i sanitari', async () => {
    h.schedaSanitari = { allergies: null, note_mediche: null }
    h.updateAlunniFallisce = true
    const res = await importa()
    const corpo = await res.json()

    expect(JSON.stringify(corpo.warnings ?? [])).toContain('scheda esistente non aggiornata')
    expect(figlioDellaDomanda().allergies).toBe('DATO SANITARIO DI PROVA')
    expect(figlioDellaDomanda().note_mediche).toBe('ALTRO DATO SANITARIO DI PROVA')
  })
})
