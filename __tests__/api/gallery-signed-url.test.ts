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

/**
 * Il TETTO GLOBALE di upload del progetto: 50 MB (Supabase → Settings → Storage →
 * «Global file size limit»). È una scelta, non un valore di fabbrica dimenticato:
 * tiene fuori il singolo video che si mangia lo spazio, ed è lo stesso limite che
 * il client applica in `teacher/gallery/page.tsx`.
 */
const TETTO_GLOBALE_B = 52_428_800

/**
 * Lo Storage simulato si comporta come quello VERO, su due punti che qui contano
 * più di tutti gli altri:
 *
 *  1. un `fileSizeLimit` più alto del tetto globale fa rifiutare l'INTERA chiamata
 *     con 400 `EntityTooLarge` — Supabase valuta quel campo PRIMA di applicare
 *     qualunque altro, quindi non viene scritto niente, `public` compreso;
 *  2. quando invece va a buon fine, la modifica viene APPLICATA a `h.buckets`.
 *
 * Il punto 2 è la ragione per cui questo stub esiste. Fino al 2026-09-01 restituiva
 * sempre `{ error: null }` senza toccare niente, e la prova «il bucket viene
 * mantenuto PRIVATO» si accontentava di vedere la rotta CHIEDERE. In produzione
 * quella richiesta è stata respinta ogni singola volta dal 26/05/2026 — 98 giorni,
 * zero richiusure, prova verde. Un test che guarda l'intenzione invece dell'esito
 * non è un test.
 */
const scriviBucket = (nome: string, opts: Record<string, unknown>) => {
  h.bucketOpzioni.push(opts)
  if (h.erroreBucket) return { data: null, error: h.erroreBucket }
  if (typeof opts.fileSizeLimit === 'number' && opts.fileSizeLimit > TETTO_GLOBALE_B) {
    return { data: null, error: { message: 'The object exceeded the maximum allowed size', status: 400 } }
  }
  h.buckets = h.buckets.map((b) => (b.name === nome ? { ...b, ...opts } : b))
  return { data: null, error: null }
}

const storage = {
  listBuckets: async () => ({ data: h.buckets, error: null }),
  createBucket: async (n: string, opts: Record<string, unknown>) => {
    if (!h.buckets.some((b) => b.name === n)) h.buckets = [...h.buckets, { name: n }]
    return scriviBucket(n, opts)
  },
  updateBucket: async (n: string, opts: Record<string, unknown>) => scriviBucket(n, opts),
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

  it('bucket già privato: la rotta NON riscrive la configurazione', async () => {
    // La configurazione del bucket si dichiara in migrazione e la verifica il lock
    // `bucket-storage-dichiarati`. Riscriverla a ogni foto costava due chiamate
    // HTTP per caricamento e — quando una di esse veniva respinta — due righe
    // `error` nei log per ogni foto riuscita: 62 il 01/09/2026, su 31 upload
    // tutti andati a buon fine.
    await UPLOAD(uploadReq(foto()))
    expect(h.bucketOpzioni).toEqual([])
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

  it('il bucket trovato aperto RISULTA richiuso — non «la rotta l’ha chiesto»', async () => {
    h.buckets = [{ name: 'gallery', public: true }]
    await UPLOAD(uploadReq(foto()))
    // L'ESITO, letto dallo Storage simulato dopo la chiamata. È l'asserzione che
    // per 98 giorni è mancata: quella vecchia guardava `h.bucketOpzioni`, cioè la
    // domanda, e sarebbe stata verde anche con lo Storage che rispondeva 400.
    expect(h.buckets.find((b) => b.name === 'gallery')?.public).toBe(false)
    const ev = eventiStorage().filter((c) => (c[2] as { esito?: string })?.esito === 'bucket-richiuso')
    expect(ev).toHaveLength(1)
  })

  it('la richiusura NON può essere vetata da un altro campo (il difetto del 26/05→01/09)', async () => {
    // IL GUASTO, misurato in produzione il 01/09/2026: la rotta spediva `public:
    // false` insieme a `fileSizeLimit: 209715200` (200 MB), sopra il tetto globale
    // di 50 MB. Supabase valida quel campo per primo e rifiuta TUTTA la chiamata
    // con `EntityTooLarge`: la richiusura non è mai avvenuta, nemmeno una volta in
    // 98 giorni, e ogni foto scriveva due `error`.
    //
    // Questa prova è rossa su quel codice, e resta rossa su qualunque futura
    // riscrittura che rimetta un campo rifiutabile accanto a una correzione di
    // sicurezza: si spedisce SOLO ciò che si sta riparando.
    h.buckets = [{ name: 'gallery', public: true }]
    await UPLOAD(uploadReq(foto()))
    for (const o of h.bucketOpzioni) {
      expect(o.fileSizeLimit, 'la richiusura non deve portare con sé il limite di dimensione').toBeUndefined()
      expect(o.allowedMimeTypes, 'né la lista MIME: la sua divergenza è una decisione aperta').toBeUndefined()
    }
    expect(h.buckets.find((b) => b.name === 'gallery')?.public).toBe(false)
  })

  it('richiusura fallita: si logga COL CORPO (non lancia, ritorna `error`)', async () => {
    h.buckets = [{ name: 'gallery', public: true }]
    h.erroreBucket = { message: 'new row violates row-level security policy' }
    await UPLOAD(uploadReq(foto()))
    const ev = eventiStorage().filter(
      (c) => (c[2] as { esito?: string })?.esito === 'bucket-non-richiuso',
    )
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('error')
    expect(descriviErrore(ev[0][3]).messaggio).toContain('row-level security')
  })

  it('bucket assente: si crea, e con un limite che lo Storage può accettare', async () => {
    // Ambiente nuovo (o DB E2E non migrato). Il limite dichiarato qui deve stare
    // SOTTO il tetto globale, altrimenti il bucket non nasce affatto: `createBucket`
    // viene respinto dallo stesso `EntityTooLarge` dell'update.
    h.buckets = []
    const res = await UPLOAD(uploadReq(foto()))
    expect(res.status).toBe(200)
    expect(h.bucketOpzioni).toHaveLength(1)
    expect(h.bucketOpzioni[0].public).toBe(false)
    expect(h.bucketOpzioni[0].fileSizeLimit).toBeLessThanOrEqual(TETTO_GLOBALE_B)
    expect(h.buckets.find((b) => b.name === 'gallery')?.public).toBe(false)
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
