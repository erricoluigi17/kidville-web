import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import itShared from '../../messages/it/shared.json'

/**
 * IL PERCORSO VECCHIO DEI VIDEO È CHIUSO: OGNI `video/*` RICEVE UN 409, SU TUTTE E TRE LE PORTE.
 *
 * ─── COSA SUCCEDE QUANDO UN CLIENT VECCHIO PROVA A CARICARE UN VIDEO ─────────
 * Le app native già installate sui telefoni, e le pagine rimaste aperte con il JS di ieri,
 * continuano a fare ciò che hanno sempre fatto: comprimere il video nel browser e spedirlo come
 * un file qualsiasi a una delle tre porte storiche —
 *   · `POST /api/gallery/upload`      (multipart: le shell native col bundle in cache)
 *   · `POST /api/gallery/upload-url`  (firma + `PUT` diretto: web e coda offline Dexie)
 *   · `POST /api/news/upload`         (multipart: l'editor delle comunicazioni)
 * Quel file nessuno lo convertirebbe mai: la pipeline nuova non sa che esiste. Perciò la porta
 * risponde **409 `VIDEO_APP_DA_AGGIORNARE`** (codice di bordo `CLIENT_UPDATE_REQUIRED` del
 * contratto di `src/lib/media/video/contratto.ts`), con una frase che dice cosa fare.
 *
 * Fino al 2026-10-02 il rifiuto stava dietro un interruttore spento e questo file lo misurava
 * nei due stati. Ora l'interruttore non c'è più (la sua assenza la misura il lock
 * `__tests__/architecture/blocco-legacy-video.test.ts`) e il comportamento è uno solo, che qui
 * si prova in tutte le sue facce:
 *  1. OGNI video, qualunque codec, qualunque nome del tipo: 409, e nessun byte tocca lo Storage;
 *  2. SENZA SNIFF: un H.264 «buono», un HEVC e un file che non è nemmeno un video ricevono la
 *     STESSA risposta — è ciò che distingue il blocco da un controllo sul contenuto;
 *  3. le IMMAGINI passano, e lo Storage viene toccato (controllo positivo del resto);
 *  4. il rifiuto si legge nei log, con soli numeri e codici;
 *  5. il gate di ruolo resta prima, e il contatore delle firme non si consuma per un rifiuto.
 */

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  rateLimit: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  /** Ogni contatto con lo Storage: per un video deve restare vuoto. */
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
        info: async (path: string) => {
          h.storage.push(`info:${bucket}`)
          return { data: null, error: { status: 404, path } }
        },
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

import { eVideoLegacy } from '@/lib/media/blocco-legacy-video'
import { POST as GALLERIA_MULTIPART } from '@/app/api/gallery/upload/route'
import { POST as GALLERIA_FIRMA } from '@/app/api/gallery/upload-url/route'
import { POST as NEWS_MULTIPART } from '@/app/api/news/upload/route'

/** La frase che una famiglia (o una maestra) legge davvero: catalogo, non codice. */
const FRASE_AGGIORNA = (itShared as Record<string, string>).erroreVideoAppDaAggiornare

/** Un `ftyp` MP4 con brand `avc1`: H.264, il video «buono» che un tempo passava. */
const BYTE_MP4_AVC1 = '\x00\x00\x00\x20ftypavc1\x00\x00mdat'
/** Brand `hvc1`: HEVC, che un tempo si rifiutava con un 415 sul contenuto. */
const BYTE_MP4_HEVC = '\x00\x00\x00\x20ftyphvc1\x00\x00mdat'
/** Niente che somigli a un video: il blocco non guarda i byte, quindi non deve farci caso. */
const BYTE_RUMORE = 'non-e-un-video'

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

/** Richiesta JSON per la porta che firma (nessun byte nel corpo, solo ciò che dichiara il client). */
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

/** La taglia che la porta che firma riceve dichiarata: 12 MB, oltre il vecchio tetto di piattaforma. */
const TAGLIA_FIRMATA = 12_000_000

type Porta = {
  nome: string
  operazione: string
  gruppo: 'galleria' | 'news'
  /**
   * Manda un caricamento con quel tipo e quei byte, come lo manderebbe un client vecchio. La porta
   * che firma non riceve i byte: riceve la «testa» in base64 (`testa_b64`), che il client vecchio
   * mandava per lo sniff e che oggi nessuno legge più.
   */
  invia: (mime: string, contenuto: string) => Promise<{ risposta: Response; size: number }>
  /** I tipi video che questa porta lascia arrivare fino al blocco. */
  videoAccettati: string[]
}

const PORTE: Porta[] = [
  {
    nome: 'POST /api/gallery/upload (multipart, shell native col bundle in cache)',
    operazione: 'gallery/upload:POST',
    gruppo: 'galleria',
    invia: async (mime, contenuto) => {
      const file = fileFinto(contenuto, mime)
      return { risposta: await GALLERIA_MULTIPART(richiestaMultipart(file, 'http://test/api/gallery/upload')), size: file.size }
    },
    videoAccettati: ['video/mp4', 'video/webm', 'video/quicktime'],
  },
  {
    nome: 'POST /api/gallery/upload-url (firma + PUT: web e coda offline)',
    operazione: 'gallery/upload-url:POST',
    gruppo: 'galleria',
    invia: async (mime, contenuto) => ({
      risposta: await GALLERIA_FIRMA(
        richiestaJson({ mime, size: TAGLIA_FIRMATA, testa_b64: testaB64(contenuto), nome: NOME_FILE }),
      ),
      size: TAGLIA_FIRMATA,
    }),
    // `video/quicktime` NON è nello `z.enum` di questa porta (è la lista del bucket) e prende il
    // 400 di sempre: lo prova `gallery-upload-url.test.ts`, qui conta solo ciò che arriva al blocco.
    videoAccettati: ['video/mp4', 'video/webm'],
  },
  {
    nome: 'POST /api/news/upload (multipart, editor comunicazioni)',
    operazione: 'news/upload:POST',
    gruppo: 'news',
    invia: async (mime, contenuto) => {
      const file = fileFinto(contenuto, mime)
      return { risposta: await NEWS_MULTIPART(richiestaMultipart(file, 'http://test/api/news/upload')), size: file.size }
    },
    videoAccettati: ['video/mp4', 'video/webm', 'video/quicktime'],
  },
]

/** Le forme in cui un video arriva davvero a una porta: pulite, col suffisso codec, in maiuscolo. */
const FORME_DEL_TIPO = ['video/mp4', 'video/webm', 'video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'Video/MP4']

const eventiDiBlocco = () =>
  h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === 'legacy-video-bloccato')

beforeEach(() => {
  vi.clearAllMocks()
  h.storage = []
  h.requireDocente.mockResolvedValue({ user: { id: 'ed-1', role: 'educator', scuola_id: 'sc-1' } })
  h.rateLimit.mockResolvedValue({ ok: true })
})

describe('OGNI video riceve il 409, e nessun byte tocca lo Storage', () => {
  it('su tutte e tre le porte, in tutte le forme del tipo, con codice VIDEO_APP_DA_AGGIORNARE', async () => {
    for (const porta of PORTE) {
      for (const mime of FORME_DEL_TIPO) {
        h.storage = []
        const { risposta } = await porta.invia(mime, BYTE_MP4_AVC1)
        expect(risposta.status, `${porta.nome} · ${mime}`).toBe(409)
        const j = (await risposta.json()) as { error?: string; codice?: string }
        expect(j.codice, `${porta.nome} · ${mime}`).toBe('VIDEO_APP_DA_AGGIORNARE')
        expect(h.storage, `${porta.nome} · ${mime}: rifiutato PRIMA dello Storage`).toEqual([])
      }
    }
  })

  it('SENZA SNIFF: un H.264, un HEVC e un file che non è un video ricevono la STESSA risposta', async () => {
    // È ciò che distingue il blocco da un controllo sul contenuto. Con lo sniff di un tempo l'HEVC
    // prendeva un 415 con un'altra frase e il file senza testa riconoscibile un altro rifiuto
    // ancora: tre risposte per tre contenuti. Ora il contenuto non conta, conta il tipo.
    for (const porta of PORTE) {
      const corpi: unknown[] = []
      for (const contenuto of [BYTE_MP4_AVC1, BYTE_MP4_HEVC, BYTE_RUMORE, '']) {
        const { risposta } = await porta.invia('video/mp4', contenuto)
        expect(risposta.status, `${porta.nome} · «${contenuto.slice(0, 12)}»`).toBe(409)
        corpi.push(await risposta.json())
      }
      expect(new Set(corpi.map((c) => JSON.stringify(c))).size, `${porta.nome}: la risposta dipende dal contenuto`).toBe(1)
    }
  })

  it('i video che la porta fa arrivare al blocco sono quelli elencati, e tutti ricevono il 409', async () => {
    // `video/quicktime` sulle due porte multipart: deve sentirsi dire «aggiorna l'app», non
    // «formato non ammesso» — col client nuovo quel formato la pipeline lo accetta, e un messaggio
    // che manda la persona contro un muro è peggio di nessun messaggio.
    for (const porta of PORTE) {
      for (const mime of porta.videoAccettati) {
        const { risposta } = await porta.invia(mime, BYTE_MP4_HEVC)
        expect(risposta.status, `${porta.nome} · ${mime}`).toBe(409)
        expect(((await risposta.json()) as { codice?: string }).codice, `${porta.nome} · ${mime}`).toBe(
          'VIDEO_APP_DA_AGGIORNARE',
        )
      }
    }
  })

  it('la porta che firma NON legge più la testa del file: con, senza o sporca, sempre 409', async () => {
    // Con lo sniff un video senza `testa_b64` prendeva un 415 «fail-closed»: ora il campo non c'è
    // più nello schema, e un client vecchio che lo manda spedisce un campo in più, scartato.
    const senzaTesta = await GALLERIA_FIRMA(richiestaJson({ mime: 'video/mp4', size: TAGLIA_FIRMATA }))
    expect(senzaTesta.status).toBe(409)
    const testaSporca = await GALLERIA_FIRMA(
      richiestaJson({ mime: 'video/mp4', size: TAGLIA_FIRMATA, testa_b64: '%%%non-base64%%%' }),
    )
    expect(testaSporca.status).toBe(409)
    const testaGrande = await GALLERIA_FIRMA(
      richiestaJson({ mime: 'video/mp4', size: TAGLIA_FIRMATA, testa_b64: 'A'.repeat(200_000) }),
    )
    expect(testaGrande.status).toBe(409)
    expect(h.storage).toEqual([])
  })

  it('la porta che firma rifiuta PRIMA del contatore: un video respinto non consuma una delle 30 firme', async () => {
    await GALLERIA_FIRMA(richiestaJson({ mime: 'video/mp4', size: TAGLIA_FIRMATA }))
    expect(h.rateLimit).not.toHaveBeenCalled()
    // E il controllo positivo: una foto lo consuma, quindi l'assenza qui sopra è del blocco.
    h.storage = []
    await GALLERIA_FIRMA(richiestaJson({ mime: 'image/jpeg', size: 400_000 }))
    expect(h.rateLimit).toHaveBeenCalledTimes(1)
  })

  it('la porta che firma rifiuta anche un video con un `resume_path` di troppo: 409, non un 400 sul percorso', async () => {
    // La ripresa è solo per le foto. A un client vecchio che la chiedesse per un video va detto lo
    // stesso «aggiorna l'app»: un 400 sul percorso non gli direbbe cosa fare.
    const res = await GALLERIA_FIRMA(
      richiestaJson({ mime: 'video/mp4', size: TAGLIA_FIRMATA, resume_path: 'uploads/ed-1/1-abc.mp4' }),
    )
    expect(res.status).toBe(409)
    expect(h.storage).toEqual([])
  })

  it('chi legge il messaggio capisce cosa fare: è una frase, non un codice', async () => {
    for (const porta of PORTE) {
      const { risposta } = await porta.invia('video/mp4', BYTE_MP4_AVC1)
      const j = (await risposta.json()) as { error?: string }
      expect(j.error, porta.nome).toBe(FRASE_AGGIORNA)
      expect(String(j.error).toLowerCase(), porta.nome).toContain('app')
      // Un codice a schermo non è un messaggio: non dice a nessuno cosa fare.
      expect(j.error, porta.nome).not.toContain('CLIENT_UPDATE_REQUIRED')
      expect(j.error, porta.nome).not.toContain('VIDEO_APP_DA_AGGIORNARE')
    }
  })
})

describe('le IMMAGINI passano come sempre, e il blocco non le tocca', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp'])('«%s» ⇒ 200 su tutte e tre le porte, e lo Storage viene toccato', async (mime) => {
    for (const porta of PORTE) {
      h.storage = []
      h.logEvento.mockClear()
      const { risposta } = await porta.invia(mime, 'contenuto-di-una-foto')
      expect(risposta.status, `${porta.nome} · ${mime}`).toBe(200)
      // Controllo positivo: senza, un blocco che rifiutasse TUTTO farebbe passare i test sui video
      // e fallire solo questo — ma per un motivo che a prima vista non c'entra con il blocco.
      expect(h.storage.length, `${porta.nome}: lo Storage deve essere toccato`).toBeGreaterThan(0)
      expect(eventiDiBlocco(), `${porta.nome}: una foto non lascia l'evento di blocco`).toEqual([])
    }
  })
})

describe('il rifiuto si legge nei log, con soli numeri e codici', () => {
  it('una riga `warn` per rifiuto, con operazione, tipo base, taglia e codice — MAI il nome del file', async () => {
    for (const porta of PORTE) {
      h.logEvento.mockClear()
      // Il tipo col suffisso codec: nel log deve entrare il tipo BASE, che è ciò che serve a contare.
      const { risposta, size } = await porta.invia('video/mp4;codecs=avc1', BYTE_MP4_AVC1)
      expect(risposta.status, porta.nome).toBe(409)
      const righe = eventiDiBlocco()
      expect(righe, `${porta.nome}: il rifiuto deve lasciare una riga`).toHaveLength(1)
      expect(righe[0][0], porta.nome).toBe(porta.gruppo)
      expect(righe[0][1], porta.nome).toBe('warn')
      expect(righe[0][2], porta.nome).toMatchObject({
        operazione: porta.operazione,
        esito: 'legacy-video-bloccato',
        mime: 'video/mp4',
        size,
        // LE DUE METÀ: nel log il codice INTERNO, che è quello con cui si diagnostica e si conta;
        // al client quello MOSTRABILE, che è quello che il catalogo sa tradurre. `error_code` è in
        // lista bianca in `@/lib/logging/redact`, quindi esce in chiaro e si interroga in SQL.
        error_code: 'CLIENT_UPDATE_REQUIRED',
      })
      const payload = JSON.stringify(righe[0][2])
      expect(payload, porta.nome).not.toContain('mario')
      expect(payload, porta.nome).not.toContain('rossi')
      expect(payload, porta.nome).not.toContain(NOME_FILE)
      // Il rifiuto è un protocollo che funziona, non un guasto: nessuna riga `error`.
      expect(h.logErrore, porta.nome).not.toHaveBeenCalled()
    }
  })

  it('gli eventi dello sniff non esistono più: né «video-non-riproducibile» né «video-senza-testa»', async () => {
    for (const porta of PORTE) {
      h.logEvento.mockClear()
      await porta.invia('video/mp4', BYTE_MP4_HEVC)
      const esiti = h.logEvento.mock.calls.map((c) => (c[2] as { esito?: string } | undefined)?.esito)
      expect(esiti, porta.nome).not.toContain('video-non-riproducibile')
      expect(esiti, porta.nome).not.toContain('video-senza-testa')
    }
  })
})

describe('il gate di ruolo resta PRIMA del blocco', () => {
  it('un non-docente vede 403, non 409: un anonimo non scopre cosa risponde la porta ai video', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) })
    for (const porta of PORTE) {
      const { risposta } = await porta.invia('video/mp4', BYTE_MP4_AVC1)
      expect(risposta.status, porta.nome).toBe(403)
      expect(eventiDiBlocco(), `${porta.nome}: nessun rifiuto registrato senza un docente`).toEqual([])
    }
  })
})

describe('`eVideoLegacy` — la decisione, da sola', () => {
  it.each([
    ['video/mp4', true],
    ['video/webm', true],
    ['video/quicktime', true],
    ['video/mp4;codecs=avc1', true],
    ['video/webm; codecs=vp9', true],
    ['Video/MP4', true],
    ['  video/mp4  ', true],
    ['image/jpeg', false],
    ['image/png', false],
    ['image/webp', false],
    ['application/octet-stream', false],
    ['application/video/mp4', false],
    ['videomp4', false],
    ['', false],
  ])('«%s» ⇒ %s', (mime, atteso) => {
    expect(eVideoLegacy(mime)).toBe(atteso)
  })

  it('non ha uno stato: la stessa risposta a ogni chiamata, qualunque cosa sia successa prima', () => {
    // Nessun interruttore da cui dipendere: due chiamate uguali non possono dare risposte diverse.
    expect(eVideoLegacy('video/mp4')).toBe(true)
    expect(eVideoLegacy('image/jpeg')).toBe(false)
    expect(eVideoLegacy('video/mp4')).toBe(true)
  })
})
