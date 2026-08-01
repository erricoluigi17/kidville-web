import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// La foto non è pubblica PRIMA che il consenso sia verificato.
//
// IL DIFETTO (collaudo del 2026-08-01). `POST /api/news/upload` scriveva dritto
// nel bucket `news`, che è PUBBLICO (`public = true`, decisione del titolare del
// 2026-07-31), e restituiva `getPublicUrl`. Da quell'istante il file era
// leggibile da chiunque, senza login — e ci restava anche quando il gate del
// consenso rifiutava la pubblicazione, perché nessuno lo toglieva. Il gate
// arrivava dopo: proteggeva la RIGA, non il FILE.
//
// LE DUE STRADE, e perché questa. Si poteva (1) lasciare l'upload nel bucket
// pubblico e cancellare il file quando la pubblicazione non va a buon fine,
// oppure (2) caricare in un'area NON pubblica e spostarlo solo dopo il gate.
// La (1) lascia in piedi il difetto per cui è nato il rilievo — fra il
// caricamento e il rifiuto la foto È pubblica — e non copre affatto il caso più
// comune: l'operatore carica l'immagine e poi chiude l'editor senza salvare, e
// quel file resta pubblico per sempre senza che nessuna riga lo nomini.
// La (2) rende la pubblicità una CONSEGUENZA del consenso verificato, non una
// premessa. È quella implementata qui.
//
// COME DEGRADA. Se il bucket privato non esiste (la migrazione che lo dichiara
// non è ancora applicata: in produzione si applica a mano, con approvazione), la
// route ricade sul comportamento di prima e lo dice a livello `error` — una
// configurazione mancante è un incidente, non una nota a piè di pagina. Meglio
// una funzione che continua a funzionare male in modo RUMOROSO che una funzione
// che si spegne in silenzio.
// =============================================================================

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  analizzaContenutoVideo: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  sanificaContenuto: vi.fn(),
  notificaNewsPubblicata: vi.fn(),
  // storage
  caricatiPerBucket: [] as { bucket: string; path: string }[],
  erroriUploadPerBucket: {} as Record<string, { message: string } | null>,
  spostamenti: [] as { da: string; a: string; bucket: string; destinazione?: string }[],
  erroreSpostamento: null as { message: string } | null,
  urlPubbliciChiesti: [] as { bucket: string; path: string }[],
  urlFirmatiChiesti: [] as { bucket: string; path: string }[],
  // alunni + news_posts
  alunni: [] as Array<Record<string, unknown>>,
  lastInsert: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: (...a: unknown[]) => h.requireDocente(...a) }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
  resolveScuolaScrittura: (...a: unknown[]) => h.resolveScuolaScrittura(...a),
}))
vi.mock('@/lib/news/sanitizza', () => ({ sanificaContenuto: (...a: unknown[]) => h.sanificaContenuto(...a) }))
vi.mock('@/lib/news/notifiche', () => ({ notificaNewsPubblicata: (...a: unknown[]) => h.notificaNewsPubblicata(...a) }))
vi.mock('@/lib/media/codec-sniff', () => ({
  analizzaContenutoVideo: (...a: unknown[]) => h.analizzaContenutoVideo(...a),
  MESSAGGIO_VIDEO_NON_CONVERTIBILE: 'video-non-convertibile',
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
}))

function storageFrom(bucket: string) {
  return {
    upload: async (path: string) => {
      const err = h.erroriUploadPerBucket[bucket] ?? null
      if (err) return { data: null, error: err }
      h.caricatiPerBucket.push({ bucket, path })
      return { data: { path }, error: null }
    },
    getPublicUrl: (path: string) => {
      h.urlPubbliciChiesti.push({ bucket, path })
      return { data: { publicUrl: `https://cdn.test/storage/v1/object/public/${bucket}/${path}` } }
    },
    createSignedUrl: async (path: string) => {
      h.urlFirmatiChiesti.push({ bucket, path })
      return {
        data: { signedUrl: `https://cdn.test/storage/v1/object/sign/${bucket}/${path}?token=abc` },
        error: null,
      }
    },
    move: async (da: string, a: string, opts?: { destinationBucket?: string }) => {
      if (h.erroreSpostamento) return { data: null, error: h.erroreSpostamento }
      h.spostamenti.push({ da, a, bucket, destinazione: opts?.destinationBucket })
      return { data: { path: a }, error: null }
    },
  }
}

function makeClient() {
  return {
    storage: { from: (b: string) => storageFrom(b) },
    from(table: string) {
      const st = { table, op: 'select', payload: null as Record<string, unknown> | null }
      const b: Record<string, unknown> = {}
      const risolvi = () => {
        if (st.table === 'alunni') return { data: h.alunni, error: null }
        if (st.table === 'news_posts' && st.op === 'insert') {
          return { data: { id: 'new-post', ...(st.payload ?? {}) }, error: null }
        }
        return { data: null, error: null }
      }
      b.select = () => b
      b.order = () => b
      b.eq = () => b
      b.in = () => b
      b.or = () => b
      b.is = () => b
      b.insert = (rec: Record<string, unknown>) => {
        st.op = 'insert'
        st.payload = rec
        h.lastInsert = { ...rec }
        return b
      }
      b.single = async () => risolvi()
      b.maybeSingle = async () => risolvi()
      b.then = (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(risolvi()).then(f, r)
      return b
    },
  }
}

vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => makeClient() }))

import { POST as UPLOAD } from '@/app/api/news/upload/route'
import { POST as NEWS_POST } from '@/app/api/news/route'
import { NEWS_BUCKET } from '@/lib/news/tipi'
import { NEWS_BUCKET_BOZZE } from '@/lib/news/media-bozza'

const A1 = '11111111-1111-4111-8111-111111111111'

const richiestaUpload = (file: File | null) =>
  ({
    url: 'http://test/api/news/upload',
    method: 'POST',
    headers: new Headers(),
    formData: async () => ({ get: (k: string) => (k === 'file' ? file : null) }),
  }) as never

const richiestaPost = (body: unknown) =>
  ({
    url: 'http://test/api/news',
    method: 'POST',
    headers: new Headers(),
    json: async () => body,
    cookies: { get: () => undefined },
  }) as never

const FIRMATO = `https://cdn.test/storage/v1/object/sign/${NEWS_BUCKET_BOZZE}/uploads/edu-1/1754000000-abc.jpg?token=xyz`
const PUBBLICO = `https://cdn.test/storage/v1/object/public/${NEWS_BUCKET}/uploads/edu-1/vecchia.jpg`

beforeEach(() => {
  vi.clearAllMocks()
  h.caricatiPerBucket = []
  h.erroriUploadPerBucket = {}
  h.spostamenti = []
  h.erroreSpostamento = null
  h.urlPubbliciChiesti = []
  h.urlFirmatiChiesti = []
  h.alunni = []
  h.lastInsert = null
  h.requireDocente.mockResolvedValue({ user: { id: 'edu-1', role: 'educator', scuola_id: 'sc-1' } })
  h.analizzaContenutoVideo.mockReturnValue({ daConvertire: false, motivo: 'ok' })
  h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: 'sc-1' })
  h.sanificaContenuto.mockReturnValue({ html: '<p>x</p>', testo: 'x' })
  h.notificaNewsPubblicata.mockResolvedValue(undefined)
})

describe('POST /api/news/upload — il file nasce in un’area NON pubblica', () => {
  it('il caricamento va nel bucket privato, e nessun indirizzo pubblico viene emesso', async () => {
    const res = await UPLOAD(richiestaUpload(new File(['x'], 'foto.png', { type: 'image/png' })))

    // Controllo POSITIVO: l'upload è davvero avvenuto (una route che fallisse
    // subito soddisferebbe da sola l'asserzione negativa qui sotto).
    expect(res.status).toBe(200)
    expect(h.caricatiPerBucket.map((c) => c.bucket)).toEqual([NEWS_BUCKET_BOZZE])

    // L'asserzione che conta: nessuno ha chiesto l'indirizzo pubblico del file.
    expect(h.urlPubbliciChiesti).toEqual([])
    const j = (await res.json()) as { fileUrl: string }
    expect(j.fileUrl).toContain(`/sign/${NEWS_BUCKET_BOZZE}/`)
  })

  it('bucket privato assente (migrazione non applicata) → ricade sul bucket pubblico e lo dice a `error`', async () => {
    h.erroriUploadPerBucket[NEWS_BUCKET_BOZZE] = { message: 'Bucket not found' }

    const res = await UPLOAD(richiestaUpload(new File(['x'], 'foto.png', { type: 'image/png' })))
    expect(res.status).toBe(200)
    expect(h.caricatiPerBucket.map((c) => c.bucket)).toEqual([NEWS_BUCKET])
    const j = (await res.json()) as { fileUrl: string }
    expect(j.fileUrl).toContain(`/public/${NEWS_BUCKET}/`)

    // Una configurazione mancante in produzione è un incidente: livello `error`,
    // e col nome del bucket, altrimenti resta sepolta nel messaggio grezzo.
    const errori = h.logEvento.mock.calls.filter((c) => c[1] === 'error')
    expect(errori.length).toBeGreaterThan(0)
    expect(JSON.stringify(errori)).toContain(NEWS_BUCKET_BOZZE)
  })
})

describe('POST /api/news — il file diventa pubblico SOLO dopo il gate', () => {
  it('consenso verificato → il media viene spostato nel bucket pubblico e la riga porta l’indirizzo definitivo', async () => {
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: true }]

    const res = await NEWS_POST(
      richiestaPost({ tipo: 'articolo', titolo: 'T', copertina_url: FIRMATO, bambini_ritratti: [A1] }),
    )
    expect(res.status).toBe(201)
    expect(h.spostamenti).toHaveLength(1)
    expect(h.spostamenti[0].bucket).toBe(NEWS_BUCKET_BOZZE)
    expect(h.spostamenti[0].destinazione).toBe(NEWS_BUCKET)
    // Nella riga non resta un indirizzo firmato (che scadrebbe): l'indirizzo
    // pubblico definitivo.
    expect(String(h.lastInsert?.copertina_url)).toContain(`/public/${NEWS_BUCKET}/`)
    expect(String(h.lastInsert?.copertina_url)).not.toContain('token=')
  })

  it('anche le immagini DENTRO il rich-text vengono promosse (la strada accanto)', async () => {
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: true }]
    const contenuto = { type: 'doc', content: [{ type: 'image', attrs: { src: FIRMATO } }] }

    const res = await NEWS_POST(
      richiestaPost({ tipo: 'articolo', titolo: 'T', contenuto_json: contenuto, bambini_ritratti: [A1] }),
    )
    expect(res.status).toBe(201)
    expect(h.spostamenti).toHaveLength(1)
    const salvato = JSON.stringify(h.lastInsert?.contenuto_json)
    expect(salvato).toContain(`/public/${NEWS_BUCKET}/`)
    expect(salvato).not.toContain('/sign/')
  })

  it('consenso NEGATO → il file NON viene spostato: resta fuori dal bucket pubblico', async () => {
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: false }]

    const res = await NEWS_POST(
      richiestaPost({ tipo: 'articolo', titolo: 'T', copertina_url: FIRMATO, bambini_ritratti: [A1] }),
    )
    expect(res.status).toBe(422)
    expect(h.spostamenti).toEqual([])
    expect(h.lastInsert).toBeNull()
  })

  it('dichiarazione mancante → nessuno spostamento (il gate viene prima della promozione)', async () => {
    const res = await NEWS_POST(richiestaPost({ tipo: 'articolo', titolo: 'T', copertina_url: FIRMATO }))
    expect(res.status).toBe(422)
    expect(h.spostamenti).toEqual([])
  })

  it('promozione fallita → il post NON si scrive, e l’errore va a log', async () => {
    // Se la riga si scrivesse comunque, il sito mostrerebbe un'immagine rotta (il
    // file è ancora privato) oppure un indirizzo firmato destinato a scadere.
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: true }]
    h.erroreSpostamento = { message: 'storage down' }

    const res = await NEWS_POST(
      richiestaPost({ tipo: 'articolo', titolo: 'T', copertina_url: FIRMATO, bambini_ritratti: [A1] }),
    )
    expect(res.status).toBe(503)
    expect(h.lastInsert).toBeNull()
    expect(h.logErrore).toHaveBeenCalled()
  })

  it('percorso ARBITRARIO nell’area di sosta → nessuno spostamento (il campo arriva dal client)', async () => {
    // `copertina_url` è un campo del corpo della richiesta, e la promozione gira
    // col service-role: senza il vincolo sulla forma del percorso, bastava
    // scrivere l'indirizzo a mano per far pubblicare un file qualunque.
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: true }]
    const inventato = `https://cdn.test/storage/v1/object/sign/${NEWS_BUCKET_BOZZE}/../../privato/segreto.jpg?token=x`

    const res = await NEWS_POST(
      richiestaPost({ tipo: 'articolo', titolo: 'T', copertina_url: inventato, bambini_ritratti: [A1] }),
    )
    expect(res.status).toBe(201)
    expect(h.spostamenti).toEqual([])
    // Controllo POSITIVO: il post si salva comunque, con l'indirizzo invariato —
    // il rifiuto riguarda lo SPOSTAMENTO, non la pubblicazione del testo.
    expect(h.lastInsert?.copertina_url).toBe(inventato)
  })

  it('indirizzo GIÀ pubblico (post storico, o fallback col bucket privato assente) → nessuno spostamento', async () => {
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: true }]

    const res = await NEWS_POST(
      richiestaPost({ tipo: 'articolo', titolo: 'T', copertina_url: PUBBLICO, bambini_ritratti: [A1] }),
    )
    expect(res.status).toBe(201)
    expect(h.spostamenti).toEqual([])
    expect(h.lastInsert?.copertina_url).toBe(PUBBLICO)
  })
})
