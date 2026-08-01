import { describe, it, expect, vi, beforeEach } from 'vitest'

// S32 — LA CHAT ESCE DAL MODELLO DEL LINK ETERNO (percorso applicativo completo).
//
// Fino al 2026-08-01 `chat/upload` firmava con un TTL di **365 giorni** e il
// client rispediva quell'indirizzo firmato dentro `chat_messages.attachment_url`:
// il token restava in tabella e valeva un anno. Chi lo copiava, lo inoltrava o lo
// ritrovava in un backup apriva il certificato medico di un bambino senza login.
//
// Qui si collauda il contratto nuovo sulle route:
//  - `chat/upload:POST`      → risponde col PERCORSO; se firma, firma a TTL breve
//  - `chat/messages:POST`    → ARCHIVIA il percorso (mai un link firmato) e
//                              rifiuta gli indirizzi che non sono del nostro bucket
//  - `chat/messages:GET`     → serve link FIRMATI a tempo, mai il percorso grezzo
//  - `admin/chat/messages:GET` → idem, dietro al gate della segreteria
//
// Le asserzioni che contano sono sulla MUTAZIONE (che cosa finisce in tabella),
// non sullo status.

const TEACHER = 'aaaaaaaa-0000-4000-8000-000000000001'
const PARENT = 'bbbbbbbb-0000-4000-8000-000000000002'
const THREAD = 'dddddddd-0000-4000-8000-000000000004'
const STUDENT = 'eeeeeeee-0000-4000-8000-000000000005'
const PROGETTO = 'https://abcdefgh.supabase.co'
const UN_ANNO_S = 60 * 60 * 24 * 365

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireStaff: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  marcaConsegnati: vi.fn(),
  controparteThread: vi.fn(),
  nomeUtente: vi.fn(),
  notificaEvento: vi.fn(),
  assertGenitoreNonSospeso: vi.fn(),
  assertConversazioneNonSospesa: vi.fn(),
  assertTerminiAccettatiSeGenitore: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  // "DB" simulato
  thread: null as Record<string, unknown> | null,
  messages: [] as Array<Record<string, unknown>>,
  lastInsert: null as Record<string, unknown> | null,
  // Storage simulato
  uploadPath: null as string | null,
  firmaSingola: [] as Array<{ bucket: string; percorso: string; ttl: number }>,
  rispostaSingola: null as unknown,
  firmaBlocco: [] as Array<{ bucket: string; percorsi: string[]; ttl: number }>,
  rispostaBlocco: null as unknown,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: (...a: unknown[]) => h.requireUser(...a),
  requireStaff: (...a: unknown[]) => h.requireStaff(...a),
}))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: (...a: unknown[]) => h.assertAlunnoInScope(...a) }))
vi.mock('@/lib/chat/delivered', () => ({ marcaConsegnati: (...a: unknown[]) => h.marcaConsegnati(...a) }))
vi.mock('@/lib/notifiche/destinatari', () => ({ controparteThread: (...a: unknown[]) => h.controparteThread(...a) }))
vi.mock('@/lib/notifiche/triggers', () => ({
  notificaEvento: (...a: unknown[]) => h.notificaEvento(...a),
  nomeUtente: (...a: unknown[]) => h.nomeUtente(...a),
}))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: (...a: unknown[]) => h.assertGenitoreNonSospeso(...a) }))
vi.mock('@/lib/chat/sospensione-conversazione', () => ({ assertConversazioneNonSospesa: (...a: unknown[]) => h.assertConversazioneNonSospesa(...a) }))
vi.mock('@/lib/onboarding/consensi', () => ({ assertTerminiAccettatiSeGenitore: (...a: unknown[]) => h.assertTerminiAccettatiSeGenitore(...a) }))
// Il rate limit ha stato di modulo: qui si collaudano gli allegati, non l'anti-abuso.
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: () => ({ ok: true, retryAfterMs: 0 }),
  clientIp: () => '127.0.0.1',
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
}))

const storage = {
  from: (bucket: string) => ({
    upload: async (path: string) => {
      h.uploadPath = path
      return { error: null }
    },
    createSignedUrl: async (percorso: string, ttl: number) => {
      h.firmaSingola.push({ bucket, percorso, ttl })
      return h.rispostaSingola
    },
    createSignedUrls: async (percorsi: string[], ttl: number) => {
      h.firmaBlocco.push({ bucket, percorsi, ttl })
      return h.rispostaBlocco
    },
  }),
}

const adminClient = {
  storage,
  from(table: string) {
    const st: { filters: Record<string, unknown> } = { filters: {} }
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.order = () => b
    b.eq = (c: string, v: unknown) => { st.filters[c] = v; return b }
    b.neq = () => b
    b.in = () => b
    b.is = () => b
    b.limit = () => b
    b.range = async () => ({ data: h.messages, count: h.messages.length, error: null })
    b.maybeSingle = async () => {
      if (table === 'chat_threads') return { data: h.thread, error: null }
      if (table === 'utenti') return { data: { scuola_id: 'sc-1' }, error: null }
      return { data: null, error: null }
    }
    b.insert = (row: Record<string, unknown>) => {
      h.lastInsert = row
      return { select: () => ({ single: async () => ({ data: { id: 'msg-new', ...row }, error: null }) }) }
    }
    b.update = () => {
      const ub: Record<string, unknown> = {}
      ub.eq = () => ub
      ub.neq = () => ub
      ub.is = () => ub
      ub.then = (res: (v: unknown) => void) => res({ error: null })
      return ub
    }
    b.then = (res: (v: unknown) => void) => {
      if (table === 'chat_messages') return res({ data: h.messages, error: null })
      return res({ data: [], error: null })
    }
    return b
  },
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => adminClient,
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}))

import { GET as MESSAGES_GET, POST as MESSAGES_POST } from '@/app/api/chat/messages/route'
import { POST as CHAT_UPLOAD } from '@/app/api/chat/upload/route'
import { GET as ADMIN_MESSAGES_GET } from '@/app/api/admin/chat/messages/route'
import { BUCKET_CHAT_ALLEGATI, TTL_FIRMA_CHAT_S } from '@/lib/chat/allegati'

const getReq = (base: string, qs = '') =>
  ({
    url: `http://test${base}${qs ? `?${qs}` : ''}`,
    method: 'GET',
    headers: new Headers(),
    nextUrl: { searchParams: new URLSearchParams(qs) },
    cookies: { get: () => undefined },
  }) as never

const postReq = (base: string, body: unknown) =>
  ({
    url: `http://test${base}`,
    method: 'POST',
    headers: new Headers(),
    json: async () => body,
  }) as never

/** Request multipart minimale: la route legge solo `formData().get('file')`. */
const uploadReq = (file: File): Request =>
  ({
    headers: new Headers(),
    url: 'http://test/api/chat/upload',
    formData: async () => ({ get: (k: string) => (k === 'file' ? file : null) }),
  }) as unknown as Request

const pdf = (nome = 'referto.pdf') =>
  new File([new Uint8Array([1, 2, 3]) as unknown as BlobPart], nome, { type: 'application/pdf' })

const urlFirmato = (percorso: string, token = 'TOK') =>
  `${PROGETTO}/storage/v1/object/sign/chat-allegati/${percorso}?token=${token}`

beforeEach(() => {
  vi.clearAllMocks()
  h.thread = { teacher_id: TEACHER, parent_id: PARENT, student_id: STUDENT }
  h.messages = []
  h.lastInsert = null
  h.uploadPath = null
  h.firmaSingola = []
  h.firmaBlocco = []
  h.rispostaSingola = { data: { signedUrl: urlFirmato('x/y.pdf') }, error: null }
  h.rispostaBlocco = { data: [], error: null }
  h.requireUser.mockResolvedValue({ user: { id: PARENT, role: 'genitore' }, response: null })
  h.requireStaff.mockResolvedValue({ user: { id: TEACHER, role: 'segreteria' }, response: null })
  h.assertAlunnoInScope.mockResolvedValue(null)
  h.assertGenitoreNonSospeso.mockResolvedValue(null)
  h.assertConversazioneNonSospesa.mockResolvedValue(null)
  h.assertTerminiAccettatiSeGenitore.mockResolvedValue(null)
  h.controparteThread.mockResolvedValue(null)
  h.marcaConsegnati.mockResolvedValue(undefined)
})

describe('chat/upload:POST — niente più link da un anno', () => {
  it('risponde col PERCORSO nel bucket, non con un indirizzo firmato', async () => {
    const res = await CHAT_UPLOAD(uploadReq(pdf()))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.path).toBe(h.uploadPath)
    expect(body.path).toContain(`${PARENT}/`)
    // Controllo POSITIVO accanto al negativo: il percorso c'è ED è un percorso.
    expect(body.path).not.toContain('/storage/v1/object/')
    expect(body.path).not.toContain('token=')
  })

  it('il link di compatibilità è firmato a TTL BREVE — mai 365 giorni', async () => {
    await CHAT_UPLOAD(uploadReq(pdf()))
    // Controllo positivo: la firma C'È (se sparisse, il `for` sotto passerebbe a vuoto).
    expect(h.firmaSingola).toHaveLength(1)
    expect(h.firmaSingola[0].bucket).toBe(BUCKET_CHAT_ALLEGATI)
    expect(h.firmaSingola[0].ttl).toBe(TTL_FIRMA_CHAT_S)
    expect(h.firmaSingola[0].ttl).not.toBe(UN_ANNO_S)
    expect(h.uploadPath).toBeTruthy()
  })

  it('l’errore dello Storage finisce nel log COL CORPO del provider', async () => {
    const rotto = {
      ...adminClient,
      storage: { from: () => ({ upload: async () => ({ error: { message: 'mime type text/plain is not supported' } }) }) },
    }
    const mod = await import('@/lib/supabase/server-client')
    const spia = vi.spyOn(mod, 'createAdminClient').mockResolvedValue(rotto as never)

    const res = await CHAT_UPLOAD(uploadReq(pdf()))
    expect(res.status).toBe(500)
    expect(h.logErrore).toHaveBeenCalledTimes(1)
    expect(h.logErrore.mock.calls[0][0]).toMatchObject({ operazione: 'chat/upload:POST', evento: 'storage', stato: 500 })
    expect(JSON.stringify(h.logErrore.mock.calls[0][1])).toContain('mime type text/plain is not supported')

    spia.mockRestore()
  })

  it('il caricamento riuscito lascia una riga di SUCCESSO, senza il nome del file', async () => {
    await CHAT_UPLOAD(uploadReq(pdf('certificato-medico-rossi.pdf')))
    const ok = h.logEvento.mock.calls.filter((c) => c[0] === 'storage' && c[1] === 'info')
    expect(ok).toHaveLength(1)
    expect(ok[0][2]).toMatchObject({ esito: 'allegato-caricato', bucket: BUCKET_CHAT_ALLEGATI })
    expect(JSON.stringify(ok[0])).not.toContain('certificato-medico-rossi')
  })
})

describe('chat/messages:POST — in tabella finisce il percorso', () => {
  it('un URL FIRMATO mandato dal client viene archiviato come PERCORSO', async () => {
    const percorso = `${PARENT}/abc-referto.pdf`
    const res = await MESSAGES_POST(
      postReq('/api/chat/messages', {
        thread_id: THREAD,
        content: 'ecco il certificato',
        attachment_url: urlFirmato(percorso, 'UN_ANNO'),
        attachment_type: 'document',
      }),
    )

    expect(res.status).toBe(201)
    // LA MUTAZIONE: è questo il difetto che si sta chiudendo.
    expect(h.lastInsert?.attachment_url).toBe(percorso)
    expect(String(h.lastInsert?.attachment_url)).not.toContain('token=')
  })

  it('un percorso resta un percorso', async () => {
    const percorso = `${PARENT}/abc-referto.pdf`
    await MESSAGES_POST(
      postReq('/api/chat/messages', { thread_id: THREAD, content: 'x', attachment_url: percorso, attachment_type: 'document' }),
    )
    expect(h.lastInsert?.attachment_url).toBe(percorso)
  })

  it('la RISPOSTA al mittente porta un link firmato, così l’anteprima si apre subito', async () => {
    const percorso = `${PARENT}/abc-referto.pdf`
    h.rispostaBlocco = { data: [{ path: percorso, signedUrl: urlFirmato(percorso, 'FRESCO') }], error: null }

    const res = await MESSAGES_POST(
      postReq('/api/chat/messages', { thread_id: THREAD, content: 'x', attachment_url: percorso, attachment_type: 'document' }),
    )
    const body = await res.json()

    expect(body.attachment_url).toContain('/object/sign/chat-allegati/')
    expect(body.attachment_url).toContain('token=FRESCO')
    expect(h.firmaBlocco[0].ttl).toBe(TTL_FIRMA_CHAT_S)
    // …ma in TABELLA è rimasto il percorso.
    expect(h.lastInsert?.attachment_url).toBe(percorso)
  })

  it('un indirizzo che NON è del nostro bucket viene rifiutato e NON scrive niente', async () => {
    const res = await MESSAGES_POST(
      postReq('/api/chat/messages', {
        thread_id: THREAD,
        content: 'guarda qui',
        attachment_url: 'https://tracker.example/pixel.png',
        attachment_type: 'image',
      }),
    )

    expect(res.status).toBe(400)
    // LA MUTAZIONE: nessun insert. Senza questa asserzione un 400 potrebbe
    // convivere con una riga scritta lo stesso.
    expect(h.lastInsert).toBeNull()
  })

  it('un messaggio senza allegato passa come prima', async () => {
    const res = await MESSAGES_POST(postReq('/api/chat/messages', { thread_id: THREAD, content: 'buongiorno' }))
    expect(res.status).toBe(201)
    expect(h.lastInsert?.attachment_url).toBeNull()
    expect(h.firmaBlocco).toHaveLength(0)
  })
})

describe('chat/messages:GET — la lettura firma al momento', () => {
  it('il percorso in tabella esce come link firmato, mai grezzo', async () => {
    const percorso = `${PARENT}/abc-referto.pdf`
    h.messages = [
      { id: 'm1', thread_id: THREAD, sender_id: TEACHER, content: 'ciao', attachment_url: null, attachment_type: null },
      { id: 'm2', thread_id: THREAD, sender_id: TEACHER, content: 'ecco', attachment_url: percorso, attachment_type: 'document' },
    ]
    h.rispostaBlocco = { data: [{ path: percorso, signedUrl: urlFirmato(percorso, 'LETTURA') }], error: null }

    const res = await MESSAGES_GET(getReq('/api/chat/messages', `threadId=${THREAD}`))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.messages[1].attachment_url).toContain('/object/sign/chat-allegati/')
    expect(body.messages[1].attachment_url).toContain('token=LETTURA')
    expect(body.messages[1].attachment_url).not.toBe(percorso)
    // Controllo positivo: il messaggio senza allegato resta intatto.
    expect(body.messages[0].attachment_url).toBeNull()
    expect(h.firmaBlocco).toHaveLength(1)
    expect(h.firmaBlocco[0].ttl).toBe(TTL_FIRMA_CHAT_S)
  })

  it('quando la firma fallisce l’allegato esce NULL, non il percorso', async () => {
    const percorso = `${PARENT}/abc-referto.pdf`
    h.messages = [{ id: 'm2', thread_id: THREAD, sender_id: TEACHER, content: 'ecco', attachment_url: percorso, attachment_type: 'document' }]
    h.rispostaBlocco = { data: null, error: { message: 'Object not found' } }

    const res = await MESSAGES_GET(getReq('/api/chat/messages', `threadId=${THREAD}`))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.messages[0].attachment_url).toBeNull()
    expect(body.messages[0].attachment_url).not.toBe(percorso)
  })
})

describe('admin/chat/messages:GET — anche la supervisione vede link firmati', () => {
  it('il percorso esce firmato dietro al gate della segreteria', async () => {
    const percorso = `${PARENT}/abc-referto.pdf`
    h.messages = [{ id: 'm2', sender_id: TEACHER, content: 'ecco', attachment_url: percorso, attachment_type: 'document', created_at: '2026-08-01T10:00:00Z' }]
    h.rispostaBlocco = { data: [{ path: percorso, signedUrl: urlFirmato(percorso, 'ADMIN') }], error: null }

    const res = await ADMIN_MESSAGES_GET(getReq('/api/admin/chat/messages', `thread_id=${THREAD}`))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data[0].attachment_url).toContain('token=ADMIN')
    expect(body.data[0].attachment_url).not.toBe(percorso)
  })
})
