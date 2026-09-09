import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

/**
 * `POST /api/gallery/upload-url` — il video non passa più dalla nostra route.
 *
 * ─── IL DIFETTO, MISURATO IN PRODUZIONE, NON IPOTIZZATO ───────────────────────
 * `app_log` del 2026-09-07 contiene `POST /api/gallery/upload → 413` SEI volte in un
 * giorno, tutte da `/teacher/gallery`. L'unico video passato quel giorno pesa 4.484.198
 * byte — dodici kilobyte sotto il tetto di ~4,5 MB che Vercel impone al corpo di una
 * funzione — e il tentativo delle 12:00:02, quaranta secondi dopo, ha preso 413.
 *
 * Il bucket era innocente: `gallery` accetta `video/mp4` e `video/webm` fino a 50 MB. La
 * strozzatura stava fra un client che prometteva 50 MB e una piattaforma che ne accetta
 * 4,5, e nessuno dei due lo sapeva. La route non partiva nemmeno: il 413 lo scrive
 * l'infrastruttura, con un corpo `text/plain`, quindi nei log del server non restava
 * niente e all'insegnante usciva «Errore durante il caricamento del file».
 *
 * Il repo aveva già imparato questo guasto il 31/07 (`src/lib/upload/limite-piattaforma`)
 * e l'aveva applicato a otto percorsi di upload — lasciando fuori proprio l'unico che
 * carica video.
 *
 * ─── COSA SI PERDE, E VA DETTO SENZA ABBELLIRLO ───────────────────────────────
 * Con l'upload diretto il server non vede più tutti i byte, quindi lo sniff del codec —
 * la terza rete contro un HEVC che su Android mostrerebbe un riquadro nero — non può più
 * girare sul file intero. Qui i primi 64 KB viaggiano nel corpo della richiesta di firma
 * e lo sniff gira lo stesso, SUL SERVER, con la stessa funzione: un client vecchio che
 * non convertisse riceve 415 PRIMA di spedire quaranta megabyte su rete mobile.
 * Resta scoperto un client che manda una testa pulita e poi PUTta un altro file: è un
 * indebolimento vero, e il costo di un errore è un riquadro nero, non un dato esposto.
 */

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  rateLimit: vi.fn(),
  createSignedUploadUrl: vi.fn(),
  pathFirmato: '' as string,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: vi.fn(), requireDocente: h.requireDocente }))
vi.mock('@/lib/security/rate-limit', () => ({ rateLimit: h.rateLimit, clientIp: () => '1.2.3.4' }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: {
      from: () => ({
        createSignedUploadUrl: (p: string) => {
          h.pathFirmato = p
          return h.createSignedUploadUrl(p)
        },
      }),
    },
  }),
}))

import { POST } from '@/app/api/gallery/upload-url/route'
import { MIME_GALLERIA, estensioneDaMime } from '@/lib/gallery/limiti'

const richiesta = (corpo: unknown) =>
  ({
    url: 'http://test/api/gallery/upload-url',
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => corpo,
    text: async () => JSON.stringify(corpo),
    cookies: { get: () => undefined },
  }) as never

/** Un `ftyp` MP4 con brand `avc1`: H.264, riproducibile ovunque. */
const testaAvc1 = () => {
  const b = new Uint8Array(64)
  b.set([0, 0, 0, 32], 0)
  b.set([0x66, 0x74, 0x79, 0x70], 4)              // 'ftyp'
  b.set([0x61, 0x76, 0x63, 0x31], 8)              // 'avc1'
  return Buffer.from(b).toString('base64')
}

/** Lo stesso, ma brand `hvc1`: HEVC, che Chrome/Android non decodifica. */
const testaHevc = () => {
  const b = new Uint8Array(64)
  b.set([0, 0, 0, 32], 0)
  b.set([0x66, 0x74, 0x79, 0x70], 4)
  b.set([0x68, 0x76, 0x63, 0x31], 8)              // 'hvc1'
  return Buffer.from(b).toString('base64')
}

/** La firma EBML (0x1A45DFA3) in testa: è così che si riconosce un webm. */
const testaWebm = () => {
  const b = new Uint8Array(64)
  b.set([0x1a, 0x45, 0xdf, 0xa3], 0)
  return Buffer.from(b).toString('base64')
}

/** La testa giusta per un mime della lista: i video ne hanno bisogno, le immagini no. */
const testaPer = (mime: string) =>
  mime === 'video/webm' ? testaWebm() : mime.startsWith('video/') ? testaAvc1() : undefined

const CORPO_OK = { mime: 'video/mp4', size: 12_000_000, testa_b64: testaAvc1() }

beforeEach(() => {
  vi.clearAllMocks()
  h.pathFirmato = ''
  h.requireDocente.mockResolvedValue({ user: { id: 'ed-1', role: 'educator', scuola_id: 'sc-1' } })
  h.rateLimit.mockResolvedValue({ ok: true })
  h.createSignedUploadUrl.mockResolvedValue({ data: { signedUrl: 'https://storage/firmato', token: 'tok' }, error: null })
})

describe('POST /api/gallery/upload-url', () => {
  it('firma un caricamento da 12 MB: la taglia che il vecchio percorso non poteva accettare', async () => {
    const res = await POST(richiesta(CORPO_OK))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toMatchObject({ signedUrl: 'https://storage/firmato', token: 'tok' })
    expect(String(j.path)).toMatch(/\.mp4$/)
  })

  it('il percorso è intestato all\'utente DEL GATE, mai a un campo del client', async () => {
    await POST(richiesta({ ...CORPO_OK, path: 'uploads/qualcun-altro/rubata.mp4', userId: 'altro' }))
    expect(h.pathFirmato.startsWith('uploads/ed-1/')).toBe(true)
    expect(h.pathFirmato).not.toContain('qualcun-altro')
  })

  it('il nome del file NON attraversa questa porta', async () => {
    // Un file di galleria si chiama `IMG_bambina-rossi.mov`: è PII di un minore, e
    // finirebbe nella chiave dell'oggetto — quindi in `app_log` ogni volta che
    // qualcosa logga un percorso. L'estensione si deriva dal mime VALIDATO.
    await POST(richiesta({ ...CORPO_OK, nome: 'IMG_bambina-rossi.mp4' }))
    expect(h.pathFirmato).not.toContain('bambina')
    expect(h.pathFirmato).not.toContain('rossi')
  })

  it('gate negato ⇒ nessuna firma emessa', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await POST(richiesta(CORPO_OK))
    expect(res.status).toBe(403)
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('un mime fuori dalla lista del bucket ⇒ 400, non una firma che lo Storage rifiuterà', async () => {
    const res = await POST(richiesta({ ...CORPO_OK, mime: 'video/quicktime' }))
    expect(res.status).toBe(400)
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('oltre il tetto VERO del bucket (50 MB) ⇒ 400', async () => {
    const res = await POST(richiesta({ ...CORPO_OK, size: 52_428_801 }))
    expect(res.status).toBe(400)
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('troppe richieste ⇒ 429 e nessuna firma', async () => {
    h.rateLimit.mockResolvedValue({ ok: false, retryAfterMs: 60_000 })
    const res = await POST(richiesta(CORPO_OK))
    expect(res.status).toBe(429)
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  describe('lo sniff del codec resta sul SERVER', () => {
    it('una testa HEVC ⇒ 415, e nessuna firma: il rifiuto arriva PRIMA di spedire il file', async () => {
      const res = await POST(richiesta({ ...CORPO_OK, testa_b64: testaHevc() }))
      expect(res.status).toBe(415)
      expect((await res.json()).codice).toBe('VIDEO_NON_CONVERTIBILE')
      expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    })

    it('un video SENZA la testa ⇒ 415: fail-closed, come il client che non riesce a leggerla', async () => {
      const res = await POST(richiesta({ mime: CORPO_OK.mime, size: CORPO_OK.size }))
      expect(res.status).toBe(415)
      expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    })

    it('un\'IMMAGINE non ha bisogno della testa: lo sniff è solo per i video', async () => {
      const res = await POST(richiesta({ mime: 'image/jpeg', size: 800_000 }))
      expect(res.status).toBe(200)
      expect(String((await res.json()).path)).toMatch(/\.jpg$/)
    })
  })

  it('se lo Storage non emette la firma è un 500 col suo codice, e il corpo del fornitore resta nei log', async () => {
    h.createSignedUploadUrl.mockResolvedValue({ data: null, error: { message: 'bucket not found' } })
    const res = await POST(richiesta(CORPO_OK))
    expect(res.status).toBe(500)
    const j = await res.json()
    expect(j.codice).toBe('ALLEGATO_NON_CARICATO')
    // «bucket not found» non è una frase da mostrare a un'insegnante, e porta fuori
    // il nome del bucket e dei suoi vincoli (S31).
    expect(JSON.stringify(j)).not.toContain('bucket not found')
  })

  // ══════════════════════════════════════════════════════════════════════════
  // IL SUFFISSO CODEC — il difetto misurato il 2026-09-08.
  //
  // `MediaRecorder` non produce `video/mp4`: produce `video/mp4;codecs=avc1`, ed è
  // il tipo che finisce dentro il `File` convertito (`processing.ts:330-335`) e da
  // lì nel corpo di QUESTA richiesta. `z.enum` confronta per uguaglianza, quindi
  // rispondeva 400 — e in `app_log` di quel giorno ci sono **33 tentativi** da
  // 8 insegnanti in 3 sedi, fra le 08:26 e le 16:56, mentre nel bucket i video
  // fermi a 3 in tutto, l'ultimo del 07/09 alle 17:52. Le foto passavano dalla
  // stessa porta: `processImageWithWatermark` consegna un `image/jpeg` pulito.
  //
  // ⚠️ È LA SECONDA VOLTA. Il PRD registra la stessa lezione al 2026-07-13
  // (DL-051/052, «MIME video normalizzato — codec suffix vs allow-list bucket»):
  // era stata imparata, ed è andata persa il giorno in cui è nata una porta nuova.
  describe('il mime col suffisso codec, che è ciò che il client produce davvero', () => {
    it('`video/mp4;codecs=avc1` ⇒ 200 e un path .mp4, non 400', async () => {
      const res = await POST(richiesta({ ...CORPO_OK, mime: 'video/mp4;codecs=avc1' }))
      expect(res.status).toBe(200)
      expect(String((await res.json()).path)).toMatch(/\.mp4$/)
    })

    it('`video/webm;codecs=vp9` ⇒ 200 e un path .webm: lo sniff gira sul tipo normalizzato', async () => {
      const res = await POST(richiesta({ mime: 'video/webm;codecs=vp9', size: 9_000_000, testa_b64: testaWebm() }))
      expect(res.status).toBe(200)
      expect(String((await res.json()).path)).toMatch(/\.webm$/)
    })

    // Legato alla costante CONDIVISA, non a una lista copiata qui: se domani
    // `MIME_GALLERIA` cambia, questo test cambia con lei invece di marcire.
    it.each([...MIME_GALLERIA])('«%s» è accettato anche decorato, con la stessa estensione', async (base) => {
      const decorato = base.startsWith('video/') ? `${base};codecs=xyz1` : base.toUpperCase()
      const corpo = { size: 900_000, testa_b64: testaPer(base) }

      const nudo = await POST(richiesta({ ...corpo, mime: base }))
      const conSuffisso = await POST(richiesta({ ...corpo, mime: decorato }))

      expect(conSuffisso.status, `«${decorato}» deve valere «${base}»`).toBe(nudo.status)
      expect(nudo.status).toBe(200)
      expect(String((await conSuffisso.json()).path)).toMatch(
        new RegExp(`\\.${estensioneDaMime(base)}$`),
      )
    })

    // Normalizzare non è accettare: tolto il parametro, quel che resta deve ancora
    // passare dalla lista del bucket. Senza questo, la correzione potrebbe essere
    // «accetto tutto» e i due test qui sopra resterebbero verdi lo stesso.
    it('`video/quicktime;codecs=avc1` ⇒ ancora 400 e NESSUNA firma', async () => {
      const res = await POST(richiesta({ ...CORPO_OK, mime: 'video/quicktime;codecs=avc1' }))
      expect(res.status).toBe(400)
      expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    })
  })
})
