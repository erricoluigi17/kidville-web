import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

/**
 * `POST /api/gallery/upload-url` — il file va dal telefono allo Storage, senza passare di qui;
 * e dal 2026-10-02 di qui passano solo le foto.
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
 * ─── COSA È CAMBIATO IL 2026-10-02 ────────────────────────────────────────────
 * I video non passano più da questa porta: ogni `video/*` riceve il 409 del blocco
 * (`@/lib/media/blocco-legacy-video`) e va caricato dalla pipeline nuova. Per questo non
 * c'è più lo sniff del codec sui primi 64 KB (`testa_b64`): fermava un HEVC prima che
 * partisse la `PUT`, e ora non c'è nessuna `PUT` di video da proteggere. I tipi video
 * restano nello `z.enum` apposta — un client vecchio deve ricevere il 409, non un 400 —
 * e il blocco sta PRIMA del contatore delle firme: un rifiuto non ne consuma nessuna.
 * Il test sui tre canali insieme è `__tests__/api/video-legacy-blocco.test.ts`; qui
 * restano le foto (e il confine fra ciò che il blocco ferma e ciò che lo schema rifiuta).
 */

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  rateLimit: vi.fn(),
  createSignedUploadUrl: vi.fn(),
  info: vi.fn(),
  pathFirmato: '' as string,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: vi.fn(), requireDocente: h.requireDocente }))
vi.mock('@/lib/security/rate-limit', () => ({ rateLimit: h.rateLimit, clientIp: () => '1.2.3.4' }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: {
      from: () => ({
        info: h.info,
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

/** Un `ftyp` MP4 con brand `avc1`: la testa che un client vecchio mandava per un video «buono». */
const testaAvc1 = () => {
  const b = new Uint8Array(64)
  b.set([0, 0, 0, 32], 0)
  b.set([0x66, 0x74, 0x79, 0x70], 4)              // 'ftyp'
  b.set([0x61, 0x76, 0x63, 0x31], 8)              // 'avc1'
  return Buffer.from(b).toString('base64')
}

/** Lo stesso, ma brand `hvc1`: HEVC. Un tempo prendeva 415; ora la testa non la legge nessuno. */
const testaHevc = () => {
  const b = new Uint8Array(64)
  b.set([0, 0, 0, 32], 0)
  b.set([0x66, 0x74, 0x79, 0x70], 4)
  b.set([0x68, 0x76, 0x63, 0x31], 8)              // 'hvc1'
  return Buffer.from(b).toString('base64')
}

/** Una foto da 12 MB: la taglia che il vecchio percorso (corpo della funzione, ~4,5 MB) non poteva accettare. */
const CORPO_FOTO = { mime: 'image/jpeg', size: 12_000_000 }

/** Il corpo di un client VECCHIO che carica un video, con la testa che mandava per lo sniff. */
const CORPO_VIDEO_VECCHIO = { mime: 'video/mp4', size: 12_000_000, testa_b64: testaAvc1() }

beforeEach(() => {
  vi.clearAllMocks()
  h.pathFirmato = ''
  h.info.mockResolvedValue({ data: null, error: { status: 404 } })
  h.requireDocente.mockResolvedValue({ user: { id: 'ed-1', role: 'educator', scuola_id: 'sc-1' } })
  h.rateLimit.mockResolvedValue({ ok: true })
  h.createSignedUploadUrl.mockResolvedValue({ data: { signedUrl: 'https://storage/firmato', token: 'tok' }, error: null })
})

describe('POST /api/gallery/upload-url', () => {
  it('firma un caricamento da 12 MB: la taglia che il vecchio percorso non poteva accettare', async () => {
    const res = await POST(richiesta(CORPO_FOTO))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toMatchObject({ signedUrl: 'https://storage/firmato', token: 'tok' })
    expect(String(j.path)).toMatch(/\.jpg$/)
  })

  it('il percorso è intestato all\'utente DEL GATE, mai a un campo del client', async () => {
    await POST(richiesta({ ...CORPO_FOTO, path: 'uploads/qualcun-altro/rubata.jpg', userId: 'altro' }))
    expect(h.pathFirmato.startsWith('uploads/ed-1/')).toBe(true)
    expect(h.pathFirmato).not.toContain('qualcun-altro')
  })

  it('il nome del file NON attraversa questa porta', async () => {
    // Un file di galleria si chiama `IMG_bambina-rossi.mov`: è PII di un minore, e
    // finirebbe nella chiave dell'oggetto — quindi in `app_log` ogni volta che
    // qualcosa logga un percorso. L'estensione si deriva dal mime VALIDATO.
    await POST(richiesta({ ...CORPO_FOTO, nome: 'IMG_bambina-rossi.jpg' }))
    expect(h.pathFirmato).not.toContain('bambina')
    expect(h.pathFirmato).not.toContain('rossi')
  })

  it('gate negato ⇒ nessuna firma emessa', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await POST(richiesta(CORPO_FOTO))
    expect(res.status).toBe(403)
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('un mime fuori dalla lista del bucket ⇒ 400, non una firma che lo Storage rifiuterà', async () => {
    // Il CONFINE del blocco: `video/quicktime` non è nello `z.enum` (è la lista del bucket) e
    // prende il 400 di sempre; sono i tipi video che stanno nella lista — mp4 e webm — ad
    // arrivare al 409.
    const res = await POST(richiesta({ ...CORPO_VIDEO_VECCHIO, mime: 'video/quicktime' }))
    expect(res.status).toBe(400)
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    // E un'immagine fuori lista (qui un HEIC) ha lo stesso trattamento.
    expect((await POST(richiesta({ ...CORPO_FOTO, mime: 'image/heic' }))).status).toBe(400)
  })

  it('oltre il tetto VERO del bucket (50 MB) ⇒ 400', async () => {
    const res = await POST(richiesta({ ...CORPO_FOTO, size: 52_428_801 }))
    expect(res.status).toBe(400)
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('troppe richieste ⇒ 429 e nessuna firma', async () => {
    h.rateLimit.mockResolvedValue({ ok: false, retryAfterMs: 60_000 })
    const res = await POST(richiesta(CORPO_FOTO))
    expect(res.status).toBe(429)
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  describe('i video non passano più da qui: 409, qualunque sia il codec e comunque sia mandata la testa', () => {
    it('un video con la testa H.264 ⇒ 409 `VIDEO_APP_DA_AGGIORNARE`, e nessuna firma', async () => {
      const res = await POST(richiesta(CORPO_VIDEO_VECCHIO))
      expect(res.status).toBe(409)
      expect((await res.json()).codice).toBe('VIDEO_APP_DA_AGGIORNARE')
      expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
      // Né il contatore delle firme né lo Storage: il rifiuto arriva prima di tutto il lavoro.
      expect(h.rateLimit).not.toHaveBeenCalled()
      expect(h.info).not.toHaveBeenCalled()
    })

    it('una testa HEVC ⇒ lo STESSO 409, non più il 415 dello sniff: la testa non la legge nessuno', async () => {
      const hevc = await POST(richiesta({ ...CORPO_VIDEO_VECCHIO, testa_b64: testaHevc() }))
      const avc = await POST(richiesta(CORPO_VIDEO_VECCHIO))
      expect(hevc.status).toBe(409)
      expect(await hevc.json()).toEqual(await avc.json())
      expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    })

    it('un video SENZA la testa ⇒ 409, non più il 415 «fail-closed» dello sniff', async () => {
      const res = await POST(richiesta({ mime: CORPO_VIDEO_VECCHIO.mime, size: CORPO_VIDEO_VECCHIO.size }))
      expect(res.status).toBe(409)
      expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    })

    it('un\'IMMAGINE non ha bisogno di niente: il blocco è solo per i video', async () => {
      const res = await POST(richiesta({ mime: 'image/jpeg', size: 800_000 }))
      expect(res.status).toBe(200)
      expect(String((await res.json()).path)).toMatch(/\.jpg$/)
    })
  })

  it('se lo Storage non emette la firma è un 500 col suo codice, e il corpo del fornitore resta nei log', async () => {
    h.createSignedUploadUrl.mockResolvedValue({ data: null, error: { message: 'bucket not found' } })
    const res = await POST(richiesta(CORPO_FOTO))
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
  // `MediaRecorder` non produceva `video/mp4`: produceva `video/mp4;codecs=avc1`, ed era
  // il tipo che finiva dentro il `File` convertito e da lì nel corpo di QUESTA richiesta.
  // `z.enum` confronta per uguaglianza, quindi rispondeva 400 — e in `app_log` di quel
  // giorno ci sono **33 tentativi** da 8 insegnanti in 3 sedi, fra le 08:26 e le 16:56,
  // mentre nel bucket i video fermi a 3 in tutto, l'ultimo del 07/09 alle 17:52. Le foto
  // passavano dalla stessa porta: `processImageWithWatermark` consegna un `image/jpeg` pulito.
  //
  // ⚠️ È LA SECONDA VOLTA. Il PRD registra la stessa lezione al 2026-07-13
  // (DL-051/052, «MIME video normalizzato — codec suffix vs allow-list bucket»):
  // era stata imparata, ed è andata persa il giorno in cui è nata una porta nuova.
  //
  // Dal 2026-10-02 quel tipo non porta più a una firma ma al 409, e proprio per questo la
  // normalizzazione conta ancora: se `video/mp4;codecs=avc1` prendesse di nuovo il 400, un
  // client vecchio leggerebbe «formato non supportato» invece di «aggiorna l'app», e
  // riproverebbe — il guasto del 2026-09-08, rifatto con un altro messaggio.
  describe('il mime col suffisso codec, che è ciò che un client vecchio produce davvero', () => {
    it('`video/mp4;codecs=avc1` ⇒ 409, non 400: arriva al blocco, non si ferma allo schema', async () => {
      const res = await POST(richiesta({ ...CORPO_VIDEO_VECCHIO, mime: 'video/mp4;codecs=avc1' }))
      expect(res.status).toBe(409)
      expect((await res.json()).codice).toBe('VIDEO_APP_DA_AGGIORNARE')
    })

    it('`video/webm;codecs=vp9` ⇒ 409, non 400', async () => {
      const res = await POST(richiesta({ mime: 'video/webm;codecs=vp9', size: 9_000_000 }))
      expect(res.status).toBe(409)
      expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    })

    // Legato alla costante CONDIVISA, non a una lista copiata qui: se domani
    // `MIME_GALLERIA` cambia, questo test cambia con lei invece di marcire.
    it.each([...MIME_GALLERIA])('«%s» vale quanto il tipo base anche decorato: stessa risposta, stessa estensione', async (base) => {
      const eVideo = base.startsWith('video/')
      const decorato = eVideo ? `${base};codecs=xyz1` : base.toUpperCase()
      const corpo = { size: 900_000 }

      const nudo = await POST(richiesta({ ...corpo, mime: base }))
      const conSuffisso = await POST(richiesta({ ...corpo, mime: decorato }))

      expect(conSuffisso.status, `«${decorato}» deve valere «${base}»`).toBe(nudo.status)
      // I video si fermano al blocco, le foto si firmano: due risposte diverse per due tipi
      // diversi, e per ciascun tipo la stessa col suffisso e senza.
      expect(nudo.status).toBe(eVideo ? 409 : 200)
      if (!eVideo) {
        expect(String((await conSuffisso.json()).path)).toMatch(
          new RegExp(`\\.${estensioneDaMime(base)}$`),
        )
      }
    })

    // Normalizzare non è accettare: tolto il parametro, quel che resta deve ancora
    // passare dalla lista del bucket. Senza questo, la correzione potrebbe essere
    // «accetto tutto» e i test qui sopra resterebbero verdi lo stesso.
    it('`video/quicktime;codecs=avc1` ⇒ ancora 400 e NESSUNA firma', async () => {
      const res = await POST(richiesta({ ...CORPO_VIDEO_VECCHIO, mime: 'video/quicktime;codecs=avc1' }))
      expect(res.status).toBe(400)
      expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    })
  })
})


describe('firma foto · limite per utente autenticato', () => {
  it('due docenti sullo stesso IP hanno contatori distinti', async () => {
    await POST(richiesta({ mime: 'image/jpeg', size: 100 }))
    h.requireDocente.mockResolvedValue({ user: { id: 'ed-2', role: 'educator' } })
    await POST(richiesta({ mime: 'image/jpeg', size: 100 }))
    expect(h.rateLimit.mock.calls.map(([key]) => key)).toEqual(['galleria-upload:ed-1', 'galleria-upload:ed-2'])
    expect(h.rateLimit).toHaveBeenCalledWith('galleria-upload:ed-1', { limit: 30, windowMs: 600_000 })
  })
  it('la validazione precede il contatore delle firme', async () => {
    expect((await POST(richiesta({ mime: 'image/jpeg', size: 0 }))).status).toBe(400)
    expect(h.rateLimit).not.toHaveBeenCalled()
  })
  it('429 espone Retry-After senza consumare una firma', async () => {
    h.rateLimit.mockResolvedValue({ ok: false, retryAfterMs: 60_100 })
    const res = await POST(richiesta({ mime: 'image/jpeg', size: 100 }))
    expect(res.headers.get('Retry-After')).toBe('61')
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })
})


describe('ripresa foto · PUT riuscita con risposta persa', () => {
  const FOTO = { mime: 'image/jpeg', size: 100, resume_path: 'uploads/ed-1/123-foto.jpg' }
  it('oggetto già presente e compatibile: conferma senza firma né sovrascrittura', async () => {
    h.info.mockResolvedValue({ data: { size: 100, contentType: 'image/jpeg' }, error: null })
    const res = await POST(richiesta(FOTO))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ path: FOTO.resume_path, uploaded: true })
    expect(h.info).toHaveBeenCalledWith(FOTO.resume_path)
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    expect(h.rateLimit).not.toHaveBeenCalled()
  })
  it('oggetto assente: firma di nuovo lo stesso percorso senza upsert', async () => {
    const res = await POST(richiesta(FOTO))
    expect(res.status).toBe(200)
    expect((await res.json()).path).toBe(FOTO.resume_path)
    expect(h.createSignedUploadUrl).toHaveBeenCalledWith(FOTO.resume_path)
  })
  it('metadata diversi: 409, nessuna firma', async () => {
    h.info.mockResolvedValue({ data: { size: 101, contentType: 'image/jpeg' }, error: null })
    const res = await POST(richiesta(FOTO))
    expect(res.status).toBe(409)
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })
  it.each(['uploads/ed-2/x.jpg', 'uploads/ed-1/../ed-2/x.jpg', 'uploads/ed-1/%2e%2e/x.jpg', '/uploads/ed-1/x.jpg'])('rifiuta il percorso non canonico o altrui %s', async resume_path => {
    expect((await POST(richiesta({ ...FOTO, resume_path }))).status).toBe(400)
    expect(h.info).not.toHaveBeenCalled()
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    expect(h.rateLimit).not.toHaveBeenCalled()
  })
  it('errore provider non diventa oggetto assente né permette una firma', async () => {
    h.info.mockResolvedValue({ data: null, error: { status: 503, message: 'Provider unavailable' } })
    expect((await POST(richiesta(FOTO))).status).toBe(500)
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })
})
