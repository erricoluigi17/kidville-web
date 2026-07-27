import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// C5 §2 — Backend delle segnalazioni (UGC: contenuto + utente).
//  · POST /api/segnalazioni        — requireUser; segnalante_id SEMPRE dal gate (mai dal
//    body); validazione applicativa oggetto_id/segnalato_id; verifica del rapporto
//    legittimo con l'oggetto PRIMA di inserire (403 altrimenti); notifica Direzione con
//    corpo generico (mai il `motivo` testuale).
//  · GET  /api/admin/segnalazioni  — requireStaff(['admin','coordinator']); coda triage.
//  · PATCH /api/admin/segnalazioni — requireStaff; gestita_il/gestita_da server-side.

// UUID validi (8-4-4-4-12, versione 4, variante 8). In un blocco `vi.hoisted` così
// sono disponibili anche dentro la factory di `h` (anch'essa hoisted).
const { TEACHER, PARENT, OUTSIDER, ADMIN, THREAD, MSG, STUDENT, MEDIA, VOCE, SEC, SEG } = vi.hoisted(() => ({
  TEACHER: 'aaaaaaaa-0000-4000-8000-000000000001',
  PARENT: 'bbbbbbbb-0000-4000-8000-000000000002',
  OUTSIDER: 'cccccccc-0000-4000-8000-000000000003',
  ADMIN: 'dddddddd-0000-4000-8000-000000000004',
  THREAD: 'eeeeeeee-0000-4000-8000-000000000005',
  MSG: 'ffffffff-0000-4000-8000-000000000006',
  STUDENT: '11111111-0000-4000-8000-000000000007',
  MEDIA: '22222222-0000-4000-8000-000000000008',
  VOCE: '33333333-0000-4000-8000-000000000009',
  SEC: '44444444-0000-4000-8000-00000000000a',
  SEG: '55555555-0000-4000-8000-00000000000b',
}))

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireStaff: vi.fn(),
  notificaEvento: vi.fn(),
  staffScuola: vi.fn(),
  scuolaUnicaReale: vi.fn(),
  logEvento: vi.fn(),
  // "DB" simulato
  inserted: {} as Record<string, Record<string, unknown>>,
  updated: {} as Record<string, Record<string, unknown>>,
  newId: SEG,
  insertErr: null as unknown,
  updateErr: null as unknown,
  updateResult: { id: SEG } as Record<string, unknown> | null,
  listErr: null as unknown,
  lista: [] as Array<Record<string, unknown>>,
  chatMessage: null as Record<string, unknown> | null,
  thread: null as Record<string, unknown> | null,
  media: null as Record<string, unknown> | null,
  voce: null as Record<string, unknown> | null,
  legameSingle: null as Record<string, unknown> | null,
  threadsList: [] as Array<Record<string, unknown>>,
  legamiList: [] as Array<Record<string, unknown>>,
  alunniList: [] as Array<Record<string, unknown>>,
  utentiSezioni: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireStaff: h.requireStaff,
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  staffScuola: h.staffScuola,
  scuolaUnicaReale: h.scuolaUnicaReale,
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))

function resolveSingle(s: { table: string; mode: string }) {
  const t = s.table
  if (s.mode === 'insert') {
    if (t === 'segnalazioni') return { data: h.insertErr ? null : { id: h.newId }, error: h.insertErr }
    return { data: null, error: null }
  }
  if (s.mode === 'update') {
    if (t === 'segnalazioni') return { data: h.updateErr ? null : h.updateResult, error: h.updateErr }
    return { data: null, error: null }
  }
  if (t === 'chat_messages') return { data: h.chatMessage, error: null }
  if (t === 'chat_threads') return { data: h.thread, error: null }
  if (t === 'galleria_media_v2') return { data: h.media, error: null }
  if (t === 'eventi_diario') return { data: h.voce, error: null }
  if (t === 'legame_genitori_alunni') return { data: h.legameSingle, error: null }
  return { data: null, error: null }
}

function resolveList(s: { table: string }) {
  const t = s.table
  if (t === 'segnalazioni') return { data: h.lista, count: h.lista.length, error: h.listErr }
  if (t === 'chat_threads') return { data: h.threadsList, error: null }
  if (t === 'legame_genitori_alunni') return { data: h.legamiList, error: null }
  if (t === 'alunni') return { data: h.alunniList, error: null }
  if (t === 'utenti_sezioni') return { data: h.utentiSezioni, error: null }
  return { data: [], error: null }
}

const adminClient = {
  from(table: string) {
    const state: { table: string; mode: string; filters: Record<string, unknown>; orCond: string | null } = {
      table,
      mode: 'select',
      filters: {},
      orCond: null,
    }
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.order = () => b
    b.eq = (c: string, v: unknown) => { state.filters[c] = v; return b }
    b.in = (c: string, v: unknown) => { state.filters[c] = v; return b }
    b.or = (cond: string) => { state.orCond = cond; return b }
    b.insert = (row: Record<string, unknown>) => { state.mode = 'insert'; h.inserted[table] = row; return b }
    b.update = (row: Record<string, unknown>) => { state.mode = 'update'; h.updated[table] = row; return b }
    b.range = async () => resolveList(state)
    b.maybeSingle = async () => resolveSingle(state)
    b.single = async () => resolveSingle(state)
    b.then = (res: (v: unknown) => void) => res(resolveList(state))
    return b
  },
}

vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => adminClient,
}))

import { POST } from '@/app/api/segnalazioni/route'
import { GET as ADMIN_GET, PATCH as ADMIN_PATCH } from '@/app/api/admin/segnalazioni/route'

const postReq = (body: unknown) =>
  new Request('http://localhost/api/segnalazioni', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const adminGetReq = (qs = '') => new Request(`http://localhost/api/admin/segnalazioni?${qs}`)
const adminPatchReq = (body: unknown) =>
  new Request('http://localhost/api/admin/segnalazioni', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const nega401 = () => ({ response: NextResponse.json({ error: 'Non autenticato: userId mancante' }, { status: 401 }) })
const nega403 = () => ({ response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: PARENT, role: 'genitore', scuola_id: null } })
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: 'sc-1' } })
  h.notificaEvento.mockResolvedValue(undefined)
  h.staffScuola.mockResolvedValue([ADMIN])
  h.scuolaUnicaReale.mockResolvedValue('sc-1')
  h.inserted = {}
  h.updated = {}
  h.newId = SEG
  h.insertErr = null
  h.updateErr = null
  h.updateResult = { id: SEG }
  h.listErr = null
  h.lista = [{ id: SEG, tipo_oggetto: 'messaggio_chat', categoria: 'spam', stato: 'aperta' }]
  h.chatMessage = { thread_id: THREAD }
  h.thread = { teacher_id: TEACHER, parent_id: PARENT, student_id: STUDENT }
  h.media = { is_broadcast: false, tag_students: [STUDENT], scuola_id: 'sc-1' }
  h.voce = { alunno_id: STUDENT }
  h.legameSingle = { genitore_id: PARENT }
  h.threadsList = [{ id: THREAD }]
  h.legamiList = [{ alunno_id: STUDENT }]
  h.alunniList = [{ section_id: SEC }]
  h.utentiSezioni = [{ section_id: SEC }]
})

describe('POST /api/segnalazioni — validazione applicativa', () => {
  it('401 se il gate nega (anonimo): nessun insert', async () => {
    h.requireUser.mockResolvedValue(nega401())
    const res = await POST(postReq({ tipo_oggetto: 'utente', segnalato_id: TEACHER, categoria: 'spam' }))
    expect(res.status).toBe(401)
    expect(h.inserted.segnalazioni).toBeUndefined()
  })

  it("400 tipo_oggetto='utente' senza segnalato_id", async () => {
    const res = await POST(postReq({ tipo_oggetto: 'utente', categoria: 'spam' }))
    expect(res.status).toBe(400)
    expect(h.inserted.segnalazioni).toBeUndefined()
  })

  it("400 tipo_oggetto='messaggio_chat' senza oggetto_id", async () => {
    const res = await POST(postReq({ tipo_oggetto: 'messaggio_chat', categoria: 'spam' }))
    expect(res.status).toBe(400)
    expect(h.inserted.segnalazioni).toBeUndefined()
  })

  it('400 categoria fuori enum', async () => {
    const res = await POST(postReq({ tipo_oggetto: 'utente', segnalato_id: TEACHER, categoria: 'boh' }))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/segnalazioni — verifica del rapporto legittimo', () => {
  it('403 messaggio_chat: segnalante NON partecipante del thread → nessun insert', async () => {
    h.requireUser.mockResolvedValue({ user: { id: OUTSIDER, role: 'genitore', scuola_id: null } })
    const res = await POST(postReq({ tipo_oggetto: 'messaggio_chat', oggetto_id: MSG, categoria: 'molestie_bullismo' }))
    expect(res.status).toBe(403)
    expect(h.inserted.segnalazioni).toBeUndefined()
  })

  it('403 messaggio_chat: messaggio inesistente → nessun insert', async () => {
    h.chatMessage = null
    const res = await POST(postReq({ tipo_oggetto: 'messaggio_chat', oggetto_id: MSG, categoria: 'spam' }))
    expect(res.status).toBe(403)
    expect(h.inserted.segnalazioni).toBeUndefined()
  })

  it('403 media_galleria: media non broadcast e figlio non taggato → nessun insert', async () => {
    h.media = { is_broadcast: false, tag_students: [OUTSIDER], scuola_id: 'sc-1' }
    h.legamiList = [{ alunno_id: STUDENT }]
    const res = await POST(postReq({ tipo_oggetto: 'media_galleria', oggetto_id: MEDIA, categoria: 'contenuto_inappropriato' }))
    expect(res.status).toBe(403)
    expect(h.inserted.segnalazioni).toBeUndefined()
  })

  it('403 voce_diario: la voce non è di un figlio del genitore → nessun insert', async () => {
    h.legameSingle = null
    const res = await POST(postReq({ tipo_oggetto: 'voce_diario', oggetto_id: VOCE, categoria: 'informazione_falsa' }))
    expect(res.status).toBe(403)
    expect(h.inserted.segnalazioni).toBeUndefined()
  })

  it('403 utente: nessun thread condiviso e nessuna sezione in comune → nessun insert', async () => {
    h.threadsList = []
    h.legamiList = []
    const res = await POST(postReq({ tipo_oggetto: 'utente', segnalato_id: OUTSIDER, categoria: 'molestie_bullismo' }))
    expect(res.status).toBe(403)
    expect(h.inserted.segnalazioni).toBeUndefined()
  })
})

describe('POST /api/segnalazioni — inserimento e notifica', () => {
  it('201 messaggio_chat valido: segnalante_id dal GATE (mai dal body), thread derivato', async () => {
    const res = await POST(
      postReq({
        tipo_oggetto: 'messaggio_chat',
        oggetto_id: MSG,
        // spoof: il body prova a impostare un altro segnalante — deve essere ignorato
        segnalante_id: OUTSIDER,
        categoria: 'contenuto_inappropriato',
        motivo: 'MOTIVO-SEGRETO-12345',
      }),
    )
    expect(res.status).toBe(201)
    const row = h.inserted.segnalazioni
    expect(row).toBeDefined()
    expect(row.segnalante_id).toBe(PARENT)
    expect(row.segnalante_id).not.toBe(OUTSIDER)
    expect(row.tipo_oggetto).toBe('messaggio_chat')
    expect(row.oggetto_id).toBe(MSG)
    expect(row.thread_id).toBe(THREAD)
    // segnalato_id resta null se non è una segnalazione utente
    expect(row.segnalato_id ?? null).toBeNull()
  })

  it('la notifica alla Direzione usa il tipo dedicato e NON contiene il motivo testuale', async () => {
    await POST(
      postReq({
        tipo_oggetto: 'messaggio_chat',
        oggetto_id: MSG,
        categoria: 'molestie_bullismo',
        motivo: 'MOTIVO-SEGRETO-12345',
      }),
    )
    expect(h.notificaEvento).toHaveBeenCalledTimes(1)
    const params = h.notificaEvento.mock.calls[0][1] as { tipo: string; corpo?: string | null; titolo: string }
    expect(params.tipo).toBe('segnalazione_contenuto')
    const blob = JSON.stringify(params)
    expect(blob).not.toContain('MOTIVO-SEGRETO-12345')
  })

  it("201 utente valido (thread condiviso): segnalato_id impostato, oggetto_id null", async () => {
    const res = await POST(postReq({ tipo_oggetto: 'utente', segnalato_id: TEACHER, categoria: 'molestie_bullismo' }))
    expect(res.status).toBe(201)
    const row = h.inserted.segnalazioni
    expect(row.segnalato_id).toBe(TEACHER)
    expect(row.oggetto_id ?? null).toBeNull()
    expect(row.segnalante_id).toBe(PARENT)
  })

  it('201 utente valido per sezione in comune anche senza thread pregresso', async () => {
    h.threadsList = []
    h.legamiList = [{ alunno_id: STUDENT }]
    h.alunniList = [{ section_id: SEC }]
    h.utentiSezioni = [{ section_id: SEC }]
    const res = await POST(postReq({ tipo_oggetto: 'utente', segnalato_id: TEACHER, categoria: 'spam' }))
    expect(res.status).toBe(201)
    expect(h.inserted.segnalazioni.segnalato_id).toBe(TEACHER)
  })

  it('201 media_galleria broadcast: sempre segnalabile dal genitore', async () => {
    h.media = { is_broadcast: true, tag_students: [], scuola_id: 'sc-1' }
    const res = await POST(postReq({ tipo_oggetto: 'media_galleria', oggetto_id: MEDIA, categoria: 'contenuto_inappropriato' }))
    expect(res.status).toBe(201)
    expect(h.inserted.segnalazioni.oggetto_id).toBe(MEDIA)
  })
})

describe('GET /api/admin/segnalazioni — coda triage', () => {
  it('403 se il gate staff nega (non autorizzato)', async () => {
    h.requireStaff.mockResolvedValue(nega403())
    const res = await ADMIN_GET(adminGetReq('stato=aperta'))
    expect(res.status).toBe(403)
  })

  it('200 staff: lista paginata', async () => {
    const res = await ADMIN_GET(adminGetReq('stato=aperta'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect((j.segnalazioni as unknown[]).length).toBe(1)
    expect(j.total).toBe(1)
  })

  it('richiede requireStaff con SOLO admin/coordinator', async () => {
    await ADMIN_GET(adminGetReq(''))
    expect(h.requireStaff).toHaveBeenCalledWith(expect.anything(), ['admin', 'coordinator'])
  })
})

describe('PATCH /api/admin/segnalazioni — gestione', () => {
  it('403 se il gate staff nega', async () => {
    h.requireStaff.mockResolvedValue(nega403())
    const res = await ADMIN_PATCH(adminPatchReq({ id: SEG, stato: 'chiusa' }))
    expect(res.status).toBe(403)
    expect(h.updated.segnalazioni).toBeUndefined()
  })

  it('200 staff: gestita_da dal GATE (mai dal body), gestita_il server-side', async () => {
    const res = await ADMIN_PATCH(
      adminPatchReq({ id: SEG, stato: 'chiusa', note_gestione: 'gestita', gestita_da: OUTSIDER }),
    )
    expect(res.status).toBe(200)
    const row = h.updated.segnalazioni
    expect(row.stato).toBe('chiusa')
    expect(row.gestita_da).toBe(ADMIN)
    expect(row.gestita_da).not.toBe(OUTSIDER)
    expect(typeof row.gestita_il).toBe('string')
    expect(row.note_gestione).toBe('gestita')
  })

  it('400 stato fuori enum (aperta non è un target valido)', async () => {
    const res = await ADMIN_PATCH(adminPatchReq({ id: SEG, stato: 'aperta' }))
    expect(res.status).toBe(400)
    expect(h.updated.segnalazioni).toBeUndefined()
  })

  it('404 se la segnalazione non esiste', async () => {
    h.updateResult = null
    const res = await ADMIN_PATCH(adminPatchReq({ id: SEG, stato: 'in_lavorazione' }))
    expect(res.status).toBe(404)
  })
})
