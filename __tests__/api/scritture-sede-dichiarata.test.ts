import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

// =============================================================================
// X1 — I quattro punti di scrittura che non dichiaravano la sede.
//
// Da quando `resolveScuolaScrittura` NON ripiega più sulla sede primaria
// (W2-A, 2026-07-31), chiamarla senza `preferita` ha due esiti possibili, e
// nessuno dei due è quello voluto:
//
//  · `gallery:POST` ne IGNORAVA la risposta (`sw.scuolaId ?? auth.user.scuola_id`):
//    l'admin multi-plesso continuava a pubblicare — sempre e comunque nella sua
//    sede primaria. La foto di un bambino di Aversa finiva archiviata a
//    Giugliano, e con lei i destinatari della notifica: i genitori sbagliati.
//  · `mensa/alternative:POST` e `:DELETE` la rispettavano, quindi per lo stesso
//    admin l'alternativa al pasto non era più registrabile né cancellabile: 400.
//  · `news/digest/genera:POST` validava la sede DICHIARATA contro le sedi
//    ATTIVE (il cookie del SedeSelector) invece che contro quelle ACCESSIBILI:
//    chiedere il digest di un plesso proprio, ma non selezionato, dava 403.
//
// Regola dello step: la sede si DICHIARA (`scuola_id`), si valida con zod, si
// passa come `preferita`, e la sede risolta comanda TUTTO ciò che ne deriva —
// riga scritta, destinatari, log. Qui non si asserisce «non è 403»: si asserisce
// lo stato esatto E che cosa è finito nel database (accumulatore `scritture`).
// =============================================================================

const ADMIN_AB = '11111111-1111-4111-8111-111111111111'
const ED_A = '22222222-2222-4222-8222-222222222222'
const SEG_A = '33333333-3333-4333-8333-333333333333'
const GEN_A = '44444444-4444-4444-8444-444444444444'
const GEN_B = '55555555-5555-4555-8555-555555555555'

const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'

const CLASSE = '2 ANNI'
const GIORNO = '2026-07-14'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireStaff: vi.fn(),
  notificaEvento: vi.fn(),
  generaEInviaDigest: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
}))

vi.mock('@/lib/auth/require-staff', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/require-staff')>()),
  requireDocente: h.requireDocente,
  requireStaff: h.requireStaff,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = () => creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture })
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})
// `notificaEvento` e la generazione del digest sono effetti collaterali: qui
// interessa CON QUALE SEDE vengono invocati, non che cosa spediscono.
vi.mock('@/lib/notifiche/triggers', async (orig) => ({
  ...(await orig<typeof import('@/lib/notifiche/triggers')>()),
  notificaEvento: h.notificaEvento,
}))
vi.mock('@/lib/news/digest', async (orig) => ({
  ...(await orig<typeof import('@/lib/news/digest')>()),
  generaEInviaDigest: h.generaEInviaDigest,
}))

import { POST as GALLERY_POST } from '@/app/api/gallery/route'
import { POST as ALT_POST, DELETE as ALT_DELETE } from '@/app/api/mensa/alternative/route'
import { POST as DIGEST_POST } from '@/app/api/news/digest/genera/route'

// -----------------------------------------------------------------------------

const req = (url: string, init?: { method?: string; body?: unknown; cookie?: string }) =>
  new NextRequest(`http://localhost${url}`, {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined
      ? { body: JSON.stringify(init.body) }
      : {}),
    headers: {
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init?.cookie ? { cookie: init.cookie } : {}),
    },
  })

const inserite = (tabella: string) =>
  h.scritture.filter((s) => s.tabella === tabella && s.operazione !== 'delete')

const dbBase = (): DBFinto => ({
  schools: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ],
  // ADMIN_AB ha la sede primaria A e il ponte su A + B: è l'utente per cui la
  // sede non è più deducibile, e che fino al 2026-07-31 scriveva sempre su A.
  utenti_scuole: [
    { utente_id: ADMIN_AB, scuola_id: SEDE_A },
    { utente_id: ADMIN_AB, scuola_id: SEDE_B },
  ],
  utenti_sezioni: [],
  sections: [
    { id: 'sec-a', scuola_id: SEDE_A, name: CLASSE },
    { id: 'sec-b', scuola_id: SEDE_B, name: CLASSE },
  ],
  utenti: [
    { id: ADMIN_AB, ruolo: 'admin', scuola_id: SEDE_A, nome: 'Ada', cognome: 'Admin' },
    { id: ED_A, ruolo: 'educator', scuola_id: SEDE_A, nome: 'Eva', cognome: 'Edu' },
    { id: SEG_A, ruolo: 'segreteria', scuola_id: SEDE_A, nome: 'Sara', cognome: 'Segre' },
    { id: GEN_A, ruolo: 'genitore', scuola_id: SEDE_A, nome: 'Gino', cognome: 'Alfa' },
    { id: GEN_B, ruolo: 'genitore', scuola_id: SEDE_B, nome: 'Gina', cognome: 'Beta' },
  ],
  alunni: [
    { id: ALU_A, nome: 'Ali', cognome: 'Alfa', classe_sezione: CLASSE, section_id: 'sec-a', scuola_id: SEDE_A, consenso_privacy: true },
    { id: ALU_B, nome: 'Bea', cognome: 'Beta', classe_sezione: CLASSE, section_id: 'sec-b', scuola_id: SEDE_B, consenso_privacy: true },
  ],
  legame_genitori_alunni: [
    { genitore_id: GEN_A, alunno_id: ALU_A },
    { genitore_id: GEN_B, alunno_id: ALU_B },
  ],
  student_parents: [],
  parents: [],
  galleria_media_v2: [],
  mensa_alternative: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.requireDocente.mockResolvedValue({ user: { id: ADMIN_AB, role: 'admin', scuola_id: SEDE_A } })
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN_AB, role: 'admin', scuola_id: SEDE_A } })
  h.notificaEvento.mockResolvedValue(undefined)
  h.generaEInviaDigest.mockResolvedValue({ edizioni: [{ id: 'ed-1' }] })
})

// -----------------------------------------------------------------------------
// gallery:POST
// -----------------------------------------------------------------------------

describe('POST /api/gallery — la foto nasce nella sede DICHIARATA', () => {
  const corpo = (extra: Record<string, unknown> = {}) => ({
    file_url: 'https://esempio.invalid/foto.jpg',
    file_type: 'foto',
    caption: 'gita',
    ...extra,
  })

  it('admin multi-sede SENZA `scuola_id`: 400 che NOMINA il parametro, e nessuna riga scritta', async () => {
    const res = await GALLERY_POST(req('/api/gallery', { method: 'POST', body: corpo() }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('scuola_id')
    // Il 400 da solo non basterebbe: la prova è che il media NON esiste.
    expect(h.db.galleria_media_v2).toEqual([])
    expect(inserite('galleria_media_v2')).toEqual([])
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('admin multi-sede CON `scuola_id`: la riga porta QUELLA sede, e i destinatari pure', async () => {
    const res = await GALLERY_POST(
      req('/api/gallery', { method: 'POST', body: corpo({ scuola_id: SEDE_B }) }),
    )
    expect(res.status).toBe(201)
    // La riga scritta nel database, non la risposta HTTP.
    expect(h.db.galleria_media_v2).toHaveLength(1)
    expect(h.db.galleria_media_v2[0]).toMatchObject({ scuola_id: SEDE_B, uploaded_by: ADMIN_AB })
    expect(inserite('galleria_media_v2')[0].valori[0]).toMatchObject({ scuola_id: SEDE_B })
    // Il seguito della sede risolta: genitori della sede B, mai quelli della A.
    expect(h.notificaEvento).toHaveBeenCalledTimes(1)
    expect(h.notificaEvento.mock.calls[0][1]).toMatchObject({
      scuolaId: SEDE_B,
      utenteIds: [GEN_B],
    })
  })

  it('`scuola_id` non accessibile: ignorata, e con due sedi resta 400 (mai una scrittura altrove)', async () => {
    const res = await GALLERY_POST(
      req('/api/gallery', { method: 'POST', body: corpo({ scuola_id: SEDE_C }) }),
    )
    expect(res.status).toBe(400)
    expect(h.db.galleria_media_v2).toEqual([])
  })

  it('educator mono-sede SENZA `scuola_id`: pubblica nella sua sede (nessuna regressione)', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: ED_A, role: 'educator', scuola_id: SEDE_A } })
    const res = await GALLERY_POST(
      req('/api/gallery', { method: 'POST', body: corpo({ target_classes: [CLASSE] }) }),
    )
    expect(res.status).toBe(201)
    expect(h.db.galleria_media_v2[0]).toMatchObject({ scuola_id: SEDE_A, uploaded_by: ED_A })
    expect(h.notificaEvento.mock.calls[0][1]).toMatchObject({
      scuolaId: SEDE_A,
      utenteIds: [GEN_A],
    })
  })

  it('admin multi-sede col SedeSelector su UNA sede: quella vince anche senza `scuola_id`', async () => {
    const res = await GALLERY_POST(
      req('/api/gallery', { method: 'POST', body: corpo(), cookie: `sedi_attive=${SEDE_B}` }),
    )
    expect(res.status).toBe(201)
    expect(h.db.galleria_media_v2[0]).toMatchObject({ scuola_id: SEDE_B })
  })
})

// -----------------------------------------------------------------------------
// mensa/alternative:POST
// -----------------------------------------------------------------------------

describe('POST /api/mensa/alternative — l\'alternativa si registra nella sede dell\'alunno', () => {
  const corpo = (extra: Record<string, unknown> = {}) => ({
    alunno_id: ALU_B,
    data: GIORNO,
    richiesta: 'pasto in bianco',
    ...extra,
  })

  it('admin multi-sede CON `scuola_id`: 200 e la riga porta quella sede', async () => {
    const res = await ALT_POST(
      req('/api/mensa/alternative', { method: 'POST', body: corpo({ scuola_id: SEDE_B }) }),
    )
    expect(res.status).toBe(200)
    expect(h.db.mensa_alternative).toHaveLength(1)
    expect(h.db.mensa_alternative[0]).toMatchObject({
      scuola_id: SEDE_B,
      alunno_id: ALU_B,
      data: GIORNO,
    })
  })

  it('admin multi-sede SENZA `scuola_id`: 400 che nomina il parametro, e nessuna riga', async () => {
    const res = await ALT_POST(req('/api/mensa/alternative', { method: 'POST', body: corpo() }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('scuola_id')
    expect(h.db.mensa_alternative).toEqual([])
    expect(inserite('mensa_alternative')).toEqual([])
  })

  it('`scuola_id` di una sede diversa da quella dell\'alunno: 400 esplicito, nessuna riga orfana', async () => {
    const res = await ALT_POST(
      req('/api/mensa/alternative', { method: 'POST', body: corpo({ scuola_id: SEDE_A }) }),
    )
    expect(res.status).toBe(400)
    // Il messaggio distingue questo caso dal 400 «manca la sede»: senza,
    // il test sarebbe verde anche col difetto (400 per l'altro motivo).
    expect((await res.json()).error).toBe('La sede indicata non è quella dell\'alunno')
    expect(h.db.mensa_alternative).toEqual([])
  })

  it('segreteria mono-sede SENZA `scuola_id`: 200 sulla sua sede (nessuna regressione)', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: SEG_A, role: 'segreteria', scuola_id: SEDE_A } })
    const res = await ALT_POST(
      req('/api/mensa/alternative', { method: 'POST', body: corpo({ alunno_id: ALU_A }) }),
    )
    expect(res.status).toBe(200)
    expect(h.db.mensa_alternative[0]).toMatchObject({ scuola_id: SEDE_A, alunno_id: ALU_A })
  })
})

// -----------------------------------------------------------------------------
// mensa/alternative:DELETE
// -----------------------------------------------------------------------------

describe('DELETE /api/mensa/alternative — si cancella nella sede dichiarata', () => {
  beforeEach(() => {
    h.db.mensa_alternative = [
      { id: 'alt-a', scuola_id: SEDE_A, alunno_id: ALU_A, data: GIORNO, richiesta: 'in bianco' },
      { id: 'alt-b', scuola_id: SEDE_B, alunno_id: ALU_B, data: GIORNO, richiesta: 'senza glutine' },
    ]
  })

  it('admin multi-sede CON `scuola_id`: 200 e sparisce SOLO la riga di quella sede', async () => {
    const res = await ALT_DELETE(
      req(`/api/mensa/alternative?alunno_id=${ALU_B}&data=${GIORNO}&scuola_id=${SEDE_B}`, { method: 'DELETE' }),
    )
    expect(res.status).toBe(200)
    expect(h.db.mensa_alternative.map((r) => r.id)).toEqual(['alt-a'])
  })

  it('admin multi-sede SENZA `scuola_id`: 400, e le due righe restano intatte', async () => {
    const res = await ALT_DELETE(
      req(`/api/mensa/alternative?alunno_id=${ALU_B}&data=${GIORNO}`, { method: 'DELETE' }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('scuola_id')
    expect(h.db.mensa_alternative.map((r) => r.id)).toEqual(['alt-a', 'alt-b'])
  })

  it('`scuola_id` diversa dalla sede dell\'alunno: 400 esplicito, nulla cancellato', async () => {
    const res = await ALT_DELETE(
      req(`/api/mensa/alternative?alunno_id=${ALU_B}&data=${GIORNO}&scuola_id=${SEDE_A}`, { method: 'DELETE' }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('La sede indicata non è quella dell\'alunno')
    expect(h.db.mensa_alternative.map((r) => r.id)).toEqual(['alt-a', 'alt-b'])
  })

  it('segreteria mono-sede SENZA `scuola_id`: 200 (nessuna regressione)', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: SEG_A, role: 'segreteria', scuola_id: SEDE_A } })
    const res = await ALT_DELETE(
      req(`/api/mensa/alternative?alunno_id=${ALU_A}&data=${GIORNO}`, { method: 'DELETE' }),
    )
    expect(res.status).toBe(200)
    expect(h.db.mensa_alternative.map((r) => r.id)).toEqual(['alt-b'])
  })
})

// -----------------------------------------------------------------------------
// news/digest/genera:POST
// -----------------------------------------------------------------------------

describe('POST /api/news/digest/genera — la sede dichiarata batte il SedeSelector', () => {
  const corpo = (extra: Record<string, unknown> = {}) => ({ anno: 2026, mese: 7, ...extra })

  it('sede propria ma NON selezionata nel cookie: si genera lo stesso, su quella sede', async () => {
    const res = await DIGEST_POST(
      req('/api/news/digest/genera', {
        method: 'POST',
        body: corpo({ scuola_id: SEDE_B }),
        cookie: `sedi_attive=${SEDE_A}`,
      }),
    )
    expect(res.status).toBe(200)
    expect(h.generaEInviaDigest).toHaveBeenCalledTimes(1)
    expect(h.generaEInviaDigest.mock.calls[0][1]).toEqual({ anno: 2026, mese: 7, scuolaId: SEDE_B })
  })

  it('sede NON accessibile: 403 esplicito e NESSUNA generazione (mai un ripiego muto)', async () => {
    const res = await DIGEST_POST(
      req('/api/news/digest/genera', { method: 'POST', body: corpo({ scuola_id: SEDE_C }) }),
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Sede non accessibile' })
    expect(h.generaEInviaDigest).not.toHaveBeenCalled()
  })

  it('admin multi-sede SENZA sede: 400 che nomina il parametro, nessuna generazione', async () => {
    const res = await DIGEST_POST(req('/api/news/digest/genera', { method: 'POST', body: corpo() }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('scuola_id')
    expect(h.generaEInviaDigest).not.toHaveBeenCalled()
  })

  it('segreteria mono-sede SENZA sede: 200 sulla sua sede (nessuna regressione)', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: SEG_A, role: 'segreteria', scuola_id: SEDE_A } })
    const res = await DIGEST_POST(req('/api/news/digest/genera', { method: 'POST', body: corpo() }))
    expect(res.status).toBe(200)
    expect(h.generaEInviaDigest.mock.calls[0][1]).toEqual({ anno: 2026, mese: 7, scuolaId: SEDE_A })
  })
})
