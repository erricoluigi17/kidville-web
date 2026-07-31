import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// `POST /api/news/upload` — il bucket «news» NON nasce dall'upload.
//
// Fino al 2026-07-31 la route creava il bucket al volo, e PUBBLICO, come effetto
// collaterale del primo caricamento: la configurazione di uno spazio di storage
// destinato all'esterno (limite di dimensione, tipi ammessi, accesso pubblico)
// viveva dentro un `try` di una route, dove nessuno la cerca e niente la versiona.
// Ora il bucket è dichiarato in migrazione
// (`supabase/migrations/20260731192048_bucket_news.sql`) e la route si limita a
// caricare.
//
// I DUE COMPORTAMENTI CHE QUESTO FILE INCHIODA:
//  1. l'upload riesce SENZA che la route tocchi la configurazione dei bucket;
//  2. se il bucket manca davvero, la route lo dice a voce alta — `error`, non
//     `warn`: una configurazione assente in produzione è un incidente
//     (AGENTS.md, «Logging obbligatorio», punto 4). Prima l'unico modo di
//     accorgersene sarebbe stato leggere il messaggio grezzo dello Storage.
// =============================================================================

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  analizzaContenutoVideo: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  // Ogni tentativo di TOCCARE la configurazione dei bucket viene registrato qui.
  bucketToccati: [] as string[],
  uploadError: null as { message: string } | null,
  ultimoPath: null as string | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: (...a: unknown[]) => h.requireDocente(...a) }))
vi.mock('@/lib/media/codec-sniff', () => ({
  analizzaContenutoVideo: (...a: unknown[]) => h.analizzaContenutoVideo(...a),
  MESSAGGIO_VIDEO_NON_CONVERTIBILE: 'video-non-convertibile',
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: {
      listBuckets: async () => {
        h.bucketToccati.push('listBuckets')
        return { data: [{ name: 'news' }], error: null }
      },
      createBucket: async () => {
        h.bucketToccati.push('createBucket')
        return { data: null, error: null }
      },
      updateBucket: async () => {
        h.bucketToccati.push('updateBucket')
        return { data: null, error: null }
      },
      from: () => ({
        upload: async (path: string) => {
          h.ultimoPath = path
          return h.uploadError ? { data: null, error: h.uploadError } : { data: { path }, error: null }
        },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/news/${path}` } }),
      }),
    },
  }),
}))

import { POST as UPLOAD } from '@/app/api/news/upload/route'

const richiesta = (file: File | null) =>
  ({
    url: 'http://test/api/news/upload',
    method: 'POST',
    headers: new Headers(),
    formData: async () => ({ get: (k: string) => (k === 'file' ? file : null) }),
  }) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.bucketToccati = []
  h.uploadError = null
  h.ultimoPath = null
  h.requireDocente.mockResolvedValue({ user: { id: 'edu-1', role: 'educator', scuola_id: 'sc-1' } })
  h.analizzaContenutoVideo.mockReturnValue({ daConvertire: false, motivo: 'ok' })
})

describe('POST /api/news/upload · il bucket è dichiarato in migrazione, non creato dall’upload', () => {
  it('carica il file senza creare né riconfigurare nessun bucket', async () => {
    const res = await UPLOAD(richiesta(new File(['x'], 'foto.png', { type: 'image/png' })))

    // Controllo POSITIVO: l'upload è davvero avvenuto. Senza questo, una route
    // che fallisse subito passerebbe l'asserzione negativa qui sotto.
    expect(res.status).toBe(200)
    expect((await res.json()).fileUrl).toContain('/news/')
    expect(h.ultimoPath).toContain('edu-1')

    // Asserzione sulla MUTAZIONE: nessuna configurazione di bucket è stata toccata.
    expect(h.bucketToccati).toEqual([])
  })

  it('tipo di file non ammesso → 415 e NESSUN caricamento', async () => {
    // Finché era la route a riconfigurare il bucket a ogni upload, l'elenco dei
    // tipi ammessi lo faceva rispettare lo Storage. Ora che il bucket è dichiarato
    // in migrazione, il gate deve stare anche QUI: senza, un tipo non previsto
    // arriverebbe fino allo Storage e tornerebbe come un 500 generico.
    const res = await UPLOAD(richiesta(new File(['x'], 'documento.pdf', { type: 'application/pdf' })))

    expect(res.status).toBe(415)
    expect(h.ultimoPath, 'Il file non deve essere caricato affatto.').toBeNull()
  })

  it('bucket assente → 500 e un log di livello `error` che nomina il bucket', async () => {
    h.uploadError = { message: 'Bucket not found' }

    const res = await UPLOAD(richiesta(new File(['x'], 'foto.png', { type: 'image/png' })))
    expect(res.status).toBe(500)
    // Anche qui la route non ha provato a rimediare creandolo.
    expect(h.bucketToccati).toEqual([])

    const errore = h.logEvento.mock.calls.find(
      (c) => c[0] === 'storage' && (c[2] as { esito?: string })?.esito === 'bucket-mancante',
    )
    expect(
      errore,
      'Un bucket che non esiste è configurazione mancante in produzione: va loggato ' +
        'come `error` con il nome del bucket, non lasciato al messaggio grezzo dello Storage.',
    ).toBeTruthy()
    expect(errore?.[1]).toBe('error')
    expect((errore?.[2] as { bucket?: string })?.bucket).toBe('news')
  })
})
