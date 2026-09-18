import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import itShared from '../../messages/it/shared.json'

/**
 * IL PERCORSO VECCHIO DEI VIDEO SI FERMA CON UN 409, E OGGI È SPENTO.
 *
 * ─── COSA SUCCEDE IL GIORNO IN CUI LA PIPELINE NUOVA VA IN ARIA ──────────────
 * Le app native già installate sui telefoni continueranno a fare quello che hanno
 * sempre fatto: comprimere il video nel browser (`MediaRecorder`) e spedirlo come
 * un file qualsiasi a una delle tre porte storiche —
 *   · `POST /api/gallery/upload`      (multipart: le shell native col bundle in cache)
 *   · `POST /api/gallery/upload-url`  (firma + `PUT` diretto: web e coda offline Dexie)
 *   · `POST /api/news/upload`         (multipart: l'editor delle comunicazioni)
 * Quel file nessuno lo convertirà mai: la pipeline nuova non sa che esiste. Perciò
 * la porta risponde **409 `CLIENT_UPDATE_REQUIRED`**, che è il codice che
 * `src/lib/media/video/contratto.ts` dichiara già come codice DI BORDO.
 *
 * ─── PERCHÉ ENTRA SPENTO, E PERCHÉ È LA PARTE IMPORTANTE ─────────────────────
 * Accendere il blocco prima che la pipeline nuova funzioni lascerebbe i genitori
 * e le maestre senza NESSUN modo di caricare un video: il percorso vecchio chiuso
 * e quello nuovo non ancora aperto. Quindi il codice entra adesso e si accende il
 * giorno del rilascio, cambiando UN valore in UN file
 * (`src/lib/media/interruttore-legacy-video.ts`).
 *
 * Questo file misura tutte e tre le cose, e la terza è quella che di solito manca:
 *  1. SPENTO — nessuna differenza osservabile: i video passano come oggi;
 *  2. ACCESO — 409 con `codice` e una frase che dice di aggiornare l'app;
 *  3. UN SOLO INTERRUTTORE — un unico `doMock` ribalta TUTTE E TRE le porte
 *     insieme. Se ne servisse un secondo, le porte non coperte resterebbero a 200
 *     e questi test sarebbero rossi. È la differenza fra dimostrarlo e prometterlo
 *     in un commento.
 */

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  rateLimit: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  /** Ogni contatto con lo Storage: a blocco acceso deve restare vuoto. */
  storage: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(),
  requireDocente: (...a: unknown[]) => h.requireDocente(...a),
}))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: (...a: unknown[]) => h.rateLimit(...a),
  clientIp: () => '1.2.3.4',
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => ({
    storage: {
      listBuckets: async () => {
        h.storage.push('listBuckets')
        return { data: [{ name: 'gallery' }, { name: 'news' }, { name: 'news_bozze' }], error: null }
      },
      createBucket: async () => {
        h.storage.push('createBucket')
        return { data: null, error: null }
      },
      updateBucket: async () => {
        h.storage.push('updateBucket')
        return { data: null, error: null }
      },
      from: (bucket: string) => ({
        upload: async (path: string) => {
          h.storage.push(`upload:${bucket}`)
          return { data: { path }, error: null }
        },
        createSignedUploadUrl: async (path: string) => {
          h.storage.push(`firma:${bucket}`)
          return { data: { signedUrl: `https://storage.test/${path}`, token: 'tok' }, error: null }
        },
        createSignedUrl: async (path: string) => {
          h.storage.push(`anteprima:${bucket}`)
          return { data: { signedUrl: `https://storage.test/sign/${path}` }, error: null }
        },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/${path}` } }),
      }),
    },
  }),
}))

/** La frase che una famiglia (o una maestra) legge davvero: catalogo, non codice. */
const FRASE_AGGIORNA = (itShared as Record<string, string>).erroreVideoAppDaAggiornare

/** Un `ftyp` MP4 con brand `avc1`: H.264, riproducibile ovunque, nessun 415 di mezzo. */
const BYTE_MP4_AVC1 = '\x00\x00\x00\x20ftypavc1\x00\x00mdat'

function byte(s: string): Uint8Array {
  const a = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i)
  return a
}

/** Nome con PII fittizia: non deve comparire in nessun log, nemmeno nel rifiuto. */
const NOME_FILE = 'recita-di-mario-rossi.mp4'

function fileFinto(contenuto: string, mime: string, nome = NOME_FILE): File {
  return new File([byte(contenuto) as unknown as BlobPart], nome, { type: mime })
}

/** Richiesta multipart minimale: le due route usano solo `formData().get('file')`. */
function richiestaMultipart(file: File, url: string): Request {
  return {
    headers: new Headers(),
    url,
    formData: async () => ({ get: (k: string) => (k === 'file' ? file : null) }),
  } as unknown as Request
}

/** Richiesta JSON per la porta che firma (nessun byte nel corpo, solo la testa). */
function richiestaJson(corpo: unknown): Request {
  return {
    url: 'http://test/api/gallery/upload-url',
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => corpo,
    text: async () => JSON.stringify(corpo),
    cookies: { get: () => undefined },
  } as unknown as Request
}

const testaB64 = (contenuto: string) => Buffer.from(byte(contenuto)).toString('base64')

type Porta = {
  nome: string
  operazione: string
  /** Manda un VIDEO mp4/H.264 su questa porta. */
  video: () => Promise<Response>
  /** Manda una IMMAGINE jpeg sulla stessa porta: non deve mai essere bloccata. */
  immagine: () => Promise<Response>
}

/**
 * Carica le tre route con l'interruttore nello stato richiesto.
 *
 * `vi.resetModules()` + `import()` dinamico e non `vi.mock` in testa, perché qui
 * serve misurare gli stessi file nei DUE stati: con `vi.mock` statico si vedrebbe
 * un solo mondo per file di test, e «da spento non cambia niente» è metà del
 * lavoro.
 */
async function porte(acceso: boolean): Promise<Porta[]> {
  vi.resetModules()
  if (acceso) {
    vi.doMock('@/lib/media/interruttore-legacy-video', () => ({ BLOCCO_LEGACY_VIDEO_ATTIVO: true }))
  } else {
    // Nessun mock: vale il valore VERO committato nel file.
    vi.doUnmock('@/lib/media/interruttore-legacy-video')
  }
  const galleriaMultipart = await import('@/app/api/gallery/upload/route')
  const galleriaFirma = await import('@/app/api/gallery/upload-url/route')
  const newsMultipart = await import('@/app/api/news/upload/route')

  return [
    {
      nome: 'POST /api/gallery/upload (multipart, shell native col bundle in cache)',
      operazione: 'gallery/upload:POST',
      video: () =>
        galleriaMultipart.POST(
          richiestaMultipart(fileFinto(BYTE_MP4_AVC1, 'video/mp4'), 'http://test/api/gallery/upload'),
        ),
      immagine: () =>
        galleriaMultipart.POST(
          richiestaMultipart(fileFinto('jpeg', 'image/jpeg', 'foto.jpg'), 'http://test/api/gallery/upload'),
        ),
    },
    {
      nome: 'POST /api/gallery/upload-url (firma + PUT: web e coda offline)',
      operazione: 'gallery/upload-url:POST',
      video: () =>
        galleriaFirma.POST(
          richiestaJson({ mime: 'video/mp4', size: 12_000_000, testa_b64: testaB64(BYTE_MP4_AVC1) }),
        ),
      immagine: () => galleriaFirma.POST(richiestaJson({ mime: 'image/jpeg', size: 400_000 })),
    },
    {
      nome: 'POST /api/news/upload (multipart, editor comunicazioni)',
      operazione: 'news/upload:POST',
      video: () =>
        newsMultipart.POST(
          richiestaMultipart(fileFinto(BYTE_MP4_AVC1, 'video/mp4'), 'http://test/api/news/upload'),
        ),
      immagine: () =>
        newsMultipart.POST(
          richiestaMultipart(fileFinto('jpeg', 'image/jpeg', 'foto.jpg'), 'http://test/api/news/upload'),
        ),
    },
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  h.storage = []
  h.requireDocente.mockResolvedValue({ user: { id: 'ed-1', role: 'educator', scuola_id: 'sc-1' } })
  h.rateLimit.mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.doUnmock('@/lib/media/interruttore-legacy-video')
  vi.resetModules()
})

describe('interruttore SPENTO — il percorso vecchio si comporta esattamente come oggi', () => {
  it('un video H.264 passa su tutte e tre le porte, e lo Storage viene toccato', async () => {
    for (const porta of await porte(false)) {
      h.storage = []
      const res = await porta.video()
      expect(res.status, porta.nome).toBe(200)
      expect(h.storage.length, `${porta.nome}: lo Storage deve essere toccato`).toBeGreaterThan(0)
    }
  })

  it('nessuna porta scrive l\'evento di blocco: a spento quel ramo non esiste', async () => {
    for (const porta of await porte(false)) {
      h.logEvento.mockClear()
      await porta.video()
      const esiti = h.logEvento.mock.calls.map((c) => (c[2] as { esito?: string } | undefined)?.esito)
      expect(esiti, porta.nome).not.toContain('legacy-video-bloccato')
    }
  })
})

describe('interruttore ACCESO — un solo valore ribalta TUTTE le porte insieme', () => {
  it('ogni porta risponde 409 con codice VIDEO_APP_DA_AGGIORNARE, e nessun byte tocca lo Storage', async () => {
    for (const porta of await porte(true)) {
      h.storage = []
      const res = await porta.video()
      expect(res.status, porta.nome).toBe(409)
      const j = (await res.json()) as { error?: string; codice?: string }
      expect(j.codice, porta.nome).toBe('VIDEO_APP_DA_AGGIORNARE')
      expect(h.storage, `${porta.nome}: rifiutato PRIMA dello Storage`).toEqual([])
    }
  })

  it('chi legge il messaggio capisce cosa fare: è una frase, non un codice', async () => {
    for (const porta of await porte(true)) {
      const res = await porta.video()
      const j = (await res.json()) as { error?: string }
      expect(j.error, porta.nome).toBe(FRASE_AGGIORNA)
      expect(String(j.error).toLowerCase(), porta.nome).toContain('app')
      // Un codice a schermo non è un messaggio: non dice a nessuno cosa fare.
      expect(j.error, porta.nome).not.toContain('CLIENT_UPDATE_REQUIRED')
      expect(j.error, porta.nome).not.toContain('VIDEO_APP_DA_AGGIORNARE')
    }
  })

  it('le IMMAGINI continuano a passare: il blocco è sui video, non sulla porta', async () => {
    for (const porta of await porte(true)) {
      const res = await porta.immagine()
      expect(res.status, porta.nome).toBe(200)
    }
  })

  it('il rifiuto si legge nei log — warn, con mime e size, MAI il nome del file', async () => {
    for (const porta of await porte(true)) {
      h.logEvento.mockClear()
      await porta.video()
      const righe = h.logEvento.mock.calls.filter(
        (c) => (c[2] as { esito?: string } | undefined)?.esito === 'legacy-video-bloccato',
      )
      expect(righe, `${porta.nome}: il rifiuto deve lasciare una riga`).toHaveLength(1)
      expect(righe[0][1], porta.nome).toBe('warn')
      expect(righe[0][2], porta.nome).toMatchObject({
        operazione: porta.operazione,
        esito: 'legacy-video-bloccato',
        mime: 'video/mp4',
        // LE DUE METÀ: nel log il codice INTERNO, che è quello con cui si
        // diagnostica e si conta; al client quello MOSTRABILE, che è quello che
        // il catalogo sa tradurre. `error_code` è in lista bianca in
        // `@/lib/logging/redact`, quindi esce in chiaro e si interroga in SQL.
        error_code: 'CLIENT_UPDATE_REQUIRED',
      })
      const payload = JSON.stringify(righe[0][2])
      expect(payload, porta.nome).not.toContain('mario')
      expect(payload, porta.nome).not.toContain('rossi')
      expect(payload, porta.nome).not.toContain(NOME_FILE)
    }
  })

  it('il gate di ruolo resta PRIMA del blocco: un non-docente vede 403, non 409', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) })
    for (const porta of await porte(true)) {
      const res = await porta.video()
      expect(res.status, porta.nome).toBe(403)
    }
  })
})
