import { describe, it, expect, vi, beforeEach } from 'vitest'
import { proiettaConSelect } from '../fixtures/proiezione'

// =============================================================================
// F2 — La PASSWORD IN CHIARO dell'account genitore veniva ARCHIVIATA e RILETTA.
//
// L'import di una domanda d'iscrizione crea l'account del referente e ne
// restituisce le credenziali all'operatore, che gliele comunica. Fin qui è il
// flusso previsto. Il difetto è che le stesse credenziali venivano anche
// SCRITTE nella colonna JSONB `enrollment_submissions.credentials`:
//
//     .update({ status:'approved', assigned_classes, credentials, … })
//
// e da lì rilette da `GET /api/admin/iscrizioni` (che faceva `select('*')`) a
// ogni apertura della pagina «Moduli ricevuti», per chiunque abbia un ruolo di
// staff nella sede. Nessuna scadenza, nessuna cancellazione dopo l'invio
// dell'email: un archivio permanente di password in chiaro di account genitore
// dentro una tabella che nessuno tratta come un segreto.
//
// La correzione NON toglie niente all'operatore: la password continua a
// tornare nella risposta HTTP della PATCH che la genera — l'unico momento in
// cui serve. Per riaverla dopo, esiste già `admin/regenerate-credentials`, che
// la rigenera e ne lascia traccia.
//
// ⚠️ METODO. Il finto client qui sotto PROIETTA le colonne come PostgREST
// (`proiettaConSelect`): senza, un `select('*')` e una proiezione stretta
// darebbero lo stesso corpo, e il test sarebbe verde in entrambi i casi.
// =============================================================================

const SUB_ID = '5b5b5b5b-5b5b-45b5-85b5-5b5b5b5b5b5b'
const SEDE = 'sc-1'
const PASSWORD_IN_CHIARO = 'PASSWORD-SENTINELLA-28-CARATTERI'
const EMAIL_REFERENTE = 'referente@example.invalid'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  ensureParentIdentity: vi.fn(),
  sub: null as Record<string, unknown> | null,
  /** Le righe che la GET deve elencare. */
  invii: [] as Record<string, unknown>[],
  /** Ogni `update()` osservato, con la tabella e il payload esatto. */
  updates: [] as { tabella: string; payload: Record<string, unknown> }[],
  /** Ogni `select()` osservato: la proiezione è ciò che in prod decide cosa esce. */
  proiezioni: [] as { tabella: string; colonne: string }[],
  /** Colonne che su questo DB NON esistono (progetto E2E della CI non migrato):
   *  chiederle produce `42703`, esattamente come farebbe PostgREST. */
  colonneAssenti: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/auth/parent-identity', () => ({ ensureParentIdentity: h.ensureParentIdentity }))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: async () => ({ creati: 0 }) }))
vi.mock('@/lib/email/send', () => ({
  sendEmail: async () => true,
  sendEmailDetailed: async () => ({ ok: true, error: null }),
  credentialsEmailBody: () => 'corpo',
}))
vi.mock('@/lib/scuole/reali', () => ({ nomeSede: async () => 'Kidville Alfa' }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => undefined }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: async () => [SEDE],
  resolveScuolaScrittura: async () => ({ scuolaId: SEDE }),
  scuoleDiUtente: async () => [SEDE],
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'u' }, error: null }) }) },
    from(tabella: string) {
      let colonne: string | undefined
      const b: Record<string, unknown> = {}
      b.select = (c?: string) => {
        colonne = c
        h.proiezioni.push({ tabella, colonne: String(c ?? '*') })
        return b
      }
      b.eq = () => b
      b.in = () => b
      b.limit = () => b
      const lista = () => {
        if (tabella === 'enrollment_submissions') {
          // PostgREST segnala UNA colonna alla volta, e solo se è stata chiesta.
          const chieste = String(colonne ?? '*').split(',').map((c) => c.trim())
          const mancante = h.colonneAssenti.find((c) => chieste.includes(c))
          if (mancante) {
            return {
              data: null,
              error: { code: '42703', message: `column enrollment_submissions.${mancante} does not exist` },
            }
          }
          return { data: h.invii.map((r) => proiettaConSelect(r, colonne)), error: null }
        }
        if (tabella === 'sections') return { data: [{ name: 'Girasoli' }], error: null }
        return { data: [], error: null }
      }
      // Dal 2026-08-04 l'elenco è paginato (`.range()`, T11-F4): la catena non
      // finisce più su `order()`.
      b.order = () => b
      b.range = () => b
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(lista()).then(res)
      b.maybeSingle = async () => {
        if (tabella === 'enrollment_submissions') return { data: h.sub, error: null }
        return { data: null, error: null }
      }
      b.single = async () => ({ data: null, error: null })
      b.insert = (row: Record<string, unknown>) => ({
        select: () => ({ single: async () => ({ data: { id: `${tabella}-new`, nome: row?.nome ?? 'X' }, error: null }) }),
      })
      b.update = (payload: Record<string, unknown>) => {
        h.updates.push({ tabella, payload })
        return { eq: async () => ({ data: null, error: null }) }
      }
      b.upsert = async () => ({ data: null, error: null })
      return b
    },
  }),
}))

import { GET, PATCH } from '@/app/api/admin/iscrizioni/route'

const patchReq = (body: unknown) =>
  new Request('http://localhost/api/admin/iscrizioni', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const importa = () =>
  PATCH(patchReq({ id: SUB_ID, action: 'import', assignments: { '0': 'Girasoli' }, referenteIndex: 0 }) as never)

const updateInvii = () => h.updates.filter((u) => u.tabella === 'enrollment_submissions')
const proiezioniInvii = () => h.proiezioni.filter((p) => p.tabella === 'enrollment_submissions').map((p) => p.colonne)

beforeEach(() => {
  vi.clearAllMocks()
  h.updates = []
  h.proiezioni = []
  h.colonneAssenti = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE } })
  h.ensureParentIdentity.mockResolvedValue({
    ok: true,
    authUserId: 'acc-ref',
    email: EMAIL_REFERENTE,
    createdAuth: true,
    createdUtenti: true,
    boundNow: true,
    password: PASSWORD_IN_CHIARO,
  })
  h.sub = {
    id: SUB_ID,
    scuola_id: SEDE,
    status: 'pending',
    created_at: '2026-07-30T09:00:00.000Z',
    data: {
      children: [{ nome: 'Bimbo', cognome: 'Sentinella', codice_fiscale: 'CFC1' }],
      adults: [{ first_name: 'Anna', fiscal_code: 'CF1', email: EMAIL_REFERENTE, ruolo: 'mother' }],
    },
  }
  // Una riga già importata in passato, con le credenziali archiviate: è
  // esattamente la forma delle 2 righe presenti in produzione.
  h.invii = [
    {
      id: SUB_ID,
      scuola_id: SEDE,
      status: 'approved',
      created_at: '2026-07-30T09:00:00.000Z',
      updated_at: '2026-07-30T10:00:00.000Z',
      imported_at: '2026-07-30T10:00:00.000Z',
      assigned_classes: { '0': 'Girasoli' },
      consents_log: null,
      credentials: { email: EMAIL_REFERENTE, password: PASSWORD_IN_CHIARO },
      data: { children: [], adults: [] },
    },
  ]
})

describe('PATCH /api/admin/iscrizioni (import) — la password non si archivia', () => {
  it('l\'update dell\'invio NON contiene la chiave `credentials`', async () => {
    const res = await importa()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })

    expect(updateInvii()).toHaveLength(1)
    const payload = updateInvii()[0].payload
    // `data` è entrato nell'elenco il 2026-08-01 (S22): l'approvazione riscrive
    // la domanda per togliere la copia ridondante dei dati sanitari del minore
    // (`__tests__/api/iscrizioni-sanitari-dopo-import.test.ts`). L'elenco resta
    // ESATTO — è quello che rende il lock un lock — e `credentials` continua a
    // non poterci rientrare né direttamente né dentro `data` (asserzioni sotto).
    expect(Object.keys(payload).sort()).toEqual(['assigned_classes', 'data', 'imported_at', 'status', 'updated_at'])
    expect(payload).not.toHaveProperty('credentials')
    // Nemmeno di sbieco: la password non deve comparire da nessuna parte nel payload.
    expect(JSON.stringify(payload)).not.toContain(PASSWORD_IN_CHIARO)
  })

  it('lo stato dell\'invio passa comunque ad `approved` con le classi assegnate', async () => {
    await importa()
    expect(updateInvii()[0].payload).toMatchObject({
      status: 'approved',
      assigned_classes: { '0': 'Girasoli' },
    })
  })

  it('le credenziali restano nella RISPOSTA HTTP: l\'operatore non perde niente', async () => {
    const res = await importa()
    const j = (await res.json()) as { credentials: { email: string; password: string } | null }
    expect(j.credentials).toEqual({ email: EMAIL_REFERENTE, password: PASSWORD_IN_CHIARO })
  })
})

describe('GET /api/admin/iscrizioni — l\'elenco non rilegge le password archiviate', () => {
  it('nessuna voce porta `credentials`, e la password non compare nel corpo', async () => {
    const res = await GET(new Request('http://localhost/api/admin/iscrizioni') as never)
    expect(res.status).toBe(200)
    const corpo = await res.text()
    expect(corpo).not.toContain(PASSWORD_IN_CHIARO)
    expect(corpo).not.toContain('credentials')
    const righe = (JSON.parse(corpo) as { data: Record<string, unknown>[] }).data
    expect(righe).toHaveLength(1)
    expect(righe[0]).not.toHaveProperty('credentials')
  })

  it('`credentials` non viene nemmeno CHIESTA al database (niente `select(*)`)', async () => {
    await GET(new Request('http://localhost/api/admin/iscrizioni') as never)
    const chieste = proiezioniInvii()
    expect(chieste.length).toBeGreaterThan(0)
    for (const colonne of chieste) {
      const elenco = colonne.split(',').map((c) => c.trim())
      expect(elenco).not.toContain('*')
      expect(elenco).not.toContain('credentials')
    }
  })

  it('la pagina «Moduli ricevuti» riceve tutto ciò che le serve', async () => {
    const res = await GET(new Request('http://localhost/api/admin/iscrizioni') as never)
    const righe = ((await res.json()) as { data: Record<string, unknown>[] }).data
    // I campi che la LISTA di `ModuliRicevuti` legge davvero: id, sede, stato,
    // classi assegnate, data d'arrivo, più il riassunto (nome del primo bambino
    // e conteggi). Dal 2026-08-04 il `data` INTERO non è più fra questi: il
    // payload — allergie e note mediche comprese — esce solo dal dettaglio
    // `?id=`, cioè quando qualcuno apre quella domanda (T11-F4).
    for (const chiave of ['id', 'scuola_id', 'status', 'assigned_classes', 'created_at', 'riassunto']) {
      expect(righe[0]).toHaveProperty(chiave)
    }
    expect(righe[0]).not.toHaveProperty('data')
  })

  it('su DB non migrato la colonna assente (42703) viene tolta e la lista arriva lo stesso', async () => {
    // `select('*')` non falliva mai; una proiezione esplicita sì, e il progetto
    // E2E della CI non è migrato. Qui `scuola_id` non esiste: la route deve
    // toglierla e riprovare, non restituire un 500 all'operatore.
    h.colonneAssenti = ['scuola_id']
    const res = await GET(new Request('http://localhost/api/admin/iscrizioni') as never)
    expect(res.status).toBe(200)
    const righe = ((await res.json()) as { data: Record<string, unknown>[] }).data
    expect(righe).toHaveLength(1)
    expect(righe[0]).toHaveProperty('id')
    expect(righe[0]).not.toHaveProperty('scuola_id')
    expect(righe[0]).not.toHaveProperty('credentials')
  })
})
