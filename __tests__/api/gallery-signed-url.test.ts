import { describe, it, expect, vi, beforeEach } from 'vitest'
import { descriviErrore } from '@/lib/logging/serialize'

// Bucket `gallery` PRIVATO (2026-07-31): le foto e i video dei bambini non sono
// più raggiungibili da chi ha soltanto l'indirizzo. Di conseguenza:
//
//  - `gallery/upload:POST` non può più rispondere con `getPublicUrl` (un
//    indirizzo che ora NON funziona): restituisce il PERCORSO nel bucket, da
//    salvare, più un link firmato per l'anteprima immediata;
//  - `gallery:GET` firma ogni media al momento, in blocco, con scadenza breve;
//  - `gallery:POST` archivia il PERCORSO anche se il client (o una riga
//    storica) gli passa un URL pubblico completo — altrimenti in tabella
//    resterebbe un indirizzo morto.

const SEDE = 'aaaaaaaa-0000-4000-8000-000000000001'
const PROGETTO = 'https://abcdefgh.supabase.co'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireParentOfStudent: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  notificaEvento: vi.fn(),
  logEvento: vi.fn(),
  // Stato del "DB" simulato.
  media: [] as Array<Record<string, unknown>>,
  inserted: [] as Array<Record<string, unknown>>,
  // Storage simulato.
  firmaBlocco: [] as Array<{ percorsi: string[]; ttl: number }>,
  rispostaBlocco: null as unknown,
  firmaSingola: [] as Array<{ percorso: string; ttl: number }>,
  rispostaSingola: null as unknown,
  uploadPath: null as string | null,
  bucketOpzioni: [] as Array<Record<string, unknown>>,
  buckets: [{ name: 'gallery', public: false }] as Array<{ name: string; public?: boolean }>,
  erroreBucket: null as { message: string } | null,
  publicUrlChiamato: 0,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: h.resolveScuoleAttive,
  resolveScuolaScrittura: h.resolveScuolaScrittura,
}))
vi.mock('@/lib/notifiche/triggers', async (orig) => ({
  ...(await orig<typeof import('@/lib/notifiche/triggers')>()),
  notificaEvento: h.notificaEvento,
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))

const storage = {
  listBuckets: async () => ({ data: h.buckets, error: null }),
  createBucket: async (_n: string, opts: Record<string, unknown>) => {
    h.bucketOpzioni.push(opts)
    return { data: null, error: h.erroreBucket }
  },
  updateBucket: async (_n: string, opts: Record<string, unknown>) => {
    h.bucketOpzioni.push(opts)
    return { data: null, error: h.erroreBucket }
  },
  from: () => ({
    upload: async (path: string) => {
      h.uploadPath = path
      return { error: null }
    },
    // Il bucket è privato: un indirizzo "pubblico" non funziona più. Se il
    // codice lo chiedesse ancora, il test deve accorgersene.
    getPublicUrl: () => {
      h.publicUrlChiamato++
      return { data: { publicUrl: `${PROGETTO}/storage/v1/object/public/gallery/morto.jpg` } }
    },
    createSignedUrl: async (percorso: string, ttl: number) => {
      h.firmaSingola.push({ percorso, ttl })
      return h.rispostaSingola
    },
    createSignedUrls: async (percorsi: string[], ttl: number) => {
      h.firmaBlocco.push({ percorsi, ttl })
      return h.rispostaBlocco
    },
  }),
}

const adminClient = {
  storage,
  from(table: string) {
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = () => b
    b.order = () => b
    b.gte = () => b
    b.lte = () => b
    b.or = () => b
    b.not = () => b
    b.in = () => b
    b.range = async () => ({ data: h.media, count: h.media.length, error: null })
    b.maybeSingle = async () => ({ data: table === 'alunni' ? { scuola_id: SEDE } : null, error: null })
    b.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
    b.insert = (row: Record<string, unknown>) => {
      h.inserted.push(row)
      return { select: () => ({ single: async () => ({ data: { id: 'm1', ...row }, error: null }) }) }
    }
    return b
  },
}

vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => adminClient,
}))

import { GET, POST } from '@/app/api/gallery/route'
import { POST as UPLOAD } from '@/app/api/gallery/upload/route'
import { TTL_FIRMA_GALLERIA_S } from '@/lib/gallery/storage'

const getReq = (qs: string) => new Request(`http://localhost/api/gallery?${qs}`)
const postReq = (body: unknown) =>
  new Request('http://localhost/api/gallery', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Request multipart minimale: la route legge solo `formData().get('file')`. */
const uploadReq = (file: File): Request =>
  ({
    headers: new Headers(),
    url: 'http://localhost/api/gallery/upload',
    formData: async () => ({ get: (k: string) => (k === 'file' ? file : null) }),
  }) as unknown as Request

const eventiStorage = () => h.logEvento.mock.calls.filter((c) => c[0] === 'storage')

beforeEach(() => {
  vi.clearAllMocks()
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE } })
  h.requireParentOfStudent.mockResolvedValue({ user: { id: 'gen1', role: 'genitore', scuola_id: null } })
  h.resolveScuoleAttive.mockResolvedValue([SEDE])
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: SEDE })
  h.notificaEvento.mockResolvedValue(undefined)
  h.media = []
  h.inserted = []
  h.firmaBlocco = []
  h.firmaSingola = []
  h.rispostaBlocco = { data: [], error: null }
  h.rispostaSingola = { data: { signedUrl: 'https://firmato/anteprima' }, error: null }
  h.uploadPath = null
  h.bucketOpzioni = []
  h.buckets = [{ name: 'gallery', public: false }]
  h.erroreBucket = null
  h.publicUrlChiamato = 0
})

describe('POST /api/gallery/upload — niente più indirizzi pubblici', () => {
  const foto = () => new File([new Uint8Array([1, 2, 3]) as unknown as BlobPart], 'gita.jpg', { type: 'image/jpeg' })

  it('restituisce il PERCORSO nel bucket, non un URL pubblico', async () => {
    const res = await UPLOAD(uploadReq(foto()))
    expect(res.status).toBe(200)
    const j = await res.json()

    // Il percorso è quello effettivamente caricato, ed è namespaced sull'utente del gate.
    expect(j.path).toBe(h.uploadPath)
    expect(j.path).toMatch(/^uploads\/ed1\//)
    // `getPublicUrl` non deve nemmeno essere invocato: su bucket privato
    // restituisce un indirizzo che risponde 400.
    expect(h.publicUrlChiamato).toBe(0)
    expect(JSON.stringify(j)).not.toContain('/object/public/')
  })

  it('accompagna il percorso con un link FIRMATO per l\'anteprima immediata', async () => {
    const res = await UPLOAD(uploadReq(foto()))
    const j = await res.json()
    expect(j.previewUrl).toBe('https://firmato/anteprima')
    expect(h.firmaSingola).toHaveLength(1)
    expect(h.firmaSingola[0].percorso).toBe(h.uploadPath)
    expect(h.firmaSingola[0].ttl).toBe(TTL_FIRMA_GALLERIA_S)
  })

  it('`fileUrl` resta nella risposta per i client vecchi, ma vale il PERCORSO', async () => {
    // I client storici (e i telefoni con il bundle in cache) rimandano
    // `fileUrl` come `file_url` alla POST: deve arrivare il percorso, non un
    // indirizzo firmato che scade fra dieci minuti.
    const res = await UPLOAD(uploadReq(foto()))
    const j = await res.json()
    expect(j.fileUrl).toBe(h.uploadPath)
    expect(j.fileUrl).not.toContain('token=')
  })

  it('il bucket viene mantenuto PRIVATO (public: false)', async () => {
    await UPLOAD(uploadReq(foto()))
    expect(h.bucketOpzioni.length).toBeGreaterThan(0)
    for (const o of h.bucketOpzioni) expect(o.public).toBe(false)
  })

  it('trovare il bucket ANCORA pubblico è un incidente: livello `error`', async () => {
    // Se una mano lo riaprisse dalla console, l'upload lo richiude — ma deve
    // anche dirlo: nel frattempo le foto erano leggibili da chiunque.
    h.buckets = [{ name: 'gallery', public: true }]
    await UPLOAD(uploadReq(foto()))
    const ev = eventiStorage().filter((c) => (c[2] as { esito?: string })?.esito === 'bucket-pubblico')
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('error')
    expect(ev[0][2]).toMatchObject({ operazione: 'gallery/upload:POST', bucket: 'gallery' })
  })

  it('riconfigurazione del bucket fallita: si logga COL CORPO (non lancia, ritorna `error`)', async () => {
    h.erroreBucket = { message: 'new row violates row-level security policy' }
    await UPLOAD(uploadReq(foto()))
    const ev = eventiStorage().filter(
      (c) => (c[2] as { esito?: string })?.esito === 'bucket-non-riconfigurato',
    )
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('error')
    expect(descriviErrore(ev[0][3]).messaggio).toContain('row-level security')
  })

  it('firma fallita: il file è salvo (200 + path), anteprima nulla, log `error` col corpo', async () => {
    h.rispostaSingola = { data: null, error: { message: 'Object not found', status: 404 } }
    const res = await UPLOAD(uploadReq(foto()))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.path).toBe(h.uploadPath)
    expect(j.previewUrl).toBeNull()

    const ev = eventiStorage()
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('error')
    expect(ev[0][2]).toMatchObject({ operazione: 'gallery/upload:POST', bucket: 'gallery' })
    expect(descriviErrore(ev[0][3]).messaggio).toContain('Object not found')
  })
})

describe('GET /api/gallery — ogni media esce con un link firmato', () => {
  it('firma i media della pagina con UNA sola chiamata in blocco', async () => {
    h.media = [
      { id: 'm1', file_url: 'uploads/ed1/a.jpg', uploaded_by: 'ed1', scuola_id: SEDE },
      { id: 'm2', file_url: 'uploads/ed1/b.jpg', uploaded_by: 'ed1', scuola_id: SEDE },
    ]
    h.rispostaBlocco = {
      data: [
        { path: 'uploads/ed1/a.jpg', signedUrl: 'https://firmato/a', error: null },
        { path: 'uploads/ed1/b.jpg', signedUrl: 'https://firmato/b', error: null },
      ],
      error: null,
    }

    const res = await GET(getReq('classe=Girasoli'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect((j.media as Array<{ file_url: string }>).map((m) => m.file_url)).toEqual([
      'https://firmato/a',
      'https://firmato/b',
    ])
    // Una chiamata per pagina, non una per foto.
    expect(h.firmaBlocco).toHaveLength(1)
    expect(h.firmaBlocco[0].percorsi).toEqual(['uploads/ed1/a.jpg', 'uploads/ed1/b.jpg'])
    expect(h.firmaBlocco[0].ttl).toBe(TTL_FIRMA_GALLERIA_S)
  })

  it('riconosce le righe STORICHE salvate come URL pubblico completo', async () => {
    h.media = [
      {
        id: 'm1',
        file_url: `${PROGETTO}/storage/v1/object/public/gallery/uploads/ed1/storica.jpg`,
        uploaded_by: 'ed1',
        scuola_id: SEDE,
      },
    ]
    h.rispostaBlocco = {
      data: [{ path: 'uploads/ed1/storica.jpg', signedUrl: 'https://firmato/storica', error: null }],
      error: null,
    }
    const res = await GET(getReq('classe=Girasoli'))
    const j = await res.json()
    expect(h.firmaBlocco[0].percorsi).toEqual(['uploads/ed1/storica.jpg'])
    expect(j.media[0].file_url).toBe('https://firmato/storica')
  })

  it('firma non riuscita: file_url a null e log `error` (la foto non sparisce in silenzio)', async () => {
    h.media = [{ id: 'm1', file_url: 'uploads/ed1/a.jpg', uploaded_by: 'ed1', scuola_id: SEDE }]
    h.rispostaBlocco = { data: null, error: { message: 'signature failed', status: 500 } }

    const res = await GET(getReq('classe=Girasoli'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.media[0].file_url).toBeNull()
    const ev = eventiStorage()
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('error')
    expect(descriviErrore(ev[0][3]).messaggio).toContain('signature failed')
  })

  it('l\'arricchimento uploader resta (la firma non mangia gli altri campi)', async () => {
    h.media = [{ id: 'm1', file_url: 'uploads/ed1/a.jpg', uploaded_by: 'ed1', caption: 'Gita', scuola_id: SEDE }]
    h.rispostaBlocco = {
      data: [{ path: 'uploads/ed1/a.jpg', signedUrl: 'https://firmato/a', error: null }],
      error: null,
    }
    const res = await GET(getReq('classe=Girasoli'))
    const j = await res.json()
    expect(j.media[0]).toMatchObject({ id: 'm1', caption: 'Gita', uploader_name: 'Sconosciuto' })
  })
})

describe('POST /api/gallery — in tabella finisce il percorso, non un indirizzo', () => {
  it('normalizza un URL pubblico completo nel percorso del bucket', async () => {
    const res = await POST(
      postReq({ file_url: `${PROGETTO}/storage/v1/object/public/gallery/uploads/ed1/nuova.jpg` }),
    )
    expect(res.status).toBe(201)
    expect(h.inserted[0].file_url).toBe('uploads/ed1/nuova.jpg')
  })

  it('un percorso passa intatto', async () => {
    const res = await POST(postReq({ file_url: 'uploads/ed1/nuova.jpg' }))
    expect(res.status).toBe(201)
    expect(h.inserted[0].file_url).toBe('uploads/ed1/nuova.jpg')
  })

  it('un indirizzo che non appartiene al bucket non viene reinterpretato', async () => {
    const res = await POST(postReq({ file_url: 'https://cdn.example/foto.jpg' }))
    expect(res.status).toBe(201)
    expect(h.inserted[0].file_url).toBe('https://cdn.example/foto.jpg')
  })
})
