import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { caricaMediaGalleria, messaggioCaricamento } from '@/lib/gallery/carica-media'
import { TETTO_GALLERIA_BYTE } from '@/lib/gallery/limiti'

/**
 * IL CARICAMENTO DI UN MEDIA DI GALLERIA — firma, poi `PUT` diretto allo Storage.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ QUESTO FILE NASCE OGGI, e non il giorno in cui è nata la funzione.
 * `caricaMediaGalleria` è arrivata il 2026-09-07 (commit `743a2b00`) SENZA un test:
 * i soli riferimenti al modulo stavano nel lock dei tetti di tempo, che ne sorveglia
 * la deroga sul `fetch` senza timeout, non il comportamento. Il giorno dopo la
 * funzione ha smesso di caricare video per OTTO insegnanti in TRE sedi — 33 tentativi
 * fra le 08:26 e le 16:56 del 2026-09-08 — e nessun test era rosso.
 *
 * IL DIFETTO, in una riga: `MediaRecorder` non produceva `video/mp4`, produceva
 * `video/mp4;codecs=avc1`, quel tipo finiva nel `File` convertito e da lì, GREZZO, in
 * due posti che non tollerano parametri — il nostro `z.enum` (400) e
 * `allowed_mime_types` del bucket. Il repo sapeva normalizzare e lo faceva in tre
 * punti (le due route multipart e la conversione stessa): la porta nuova era l'unica
 * che non lo faceva. (La conversione nel browser non esiste più dal 2026-10-02 e i
 * video di qui non passano — li ferma il 409 — ma la normalizzazione resta, perché è
 * lei a far arrivare un tipo decorato al blocco invece che a un 400.)
 *
 * ⚠️ ERA LA SECONDA VOLTA: il PRD registra la stessa lezione al 2026-07-13 (DL-051/052,
 * «MIME video normalizzato — codec suffix vs allow-list bucket»). Imparata, e riperduta
 * il giorno in cui è nata una porta nuova. È per questo che i test stanno qui e non
 * nella testata di un commit.
 *
 * I DUE FILI CHE ESCONO DA QUESTA FUNZIONE, e che qui si sorvegliano separatamente:
 *  1. il corpo della richiesta di firma → il nostro `z.enum`;
 *  2. l'header `content-type` della `PUT` → `allowed_mime_types` dello Storage.
 * Correggerne uno solo sposta il guasto di trenta righe invece di chiuderlo.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/** `logClient` FINTA, `nomeErrore` VERA: metà di ciò che si misura è l'interazione fra le due. */
const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/client')>()),
  logClient: h.logClient,
}))

/** Un file della dimensione voluta senza allocarla: in jsdom `size` è scrivibile. */
function fileDa(byte: number, tipo: string, nome = 'IMG_bambina-rossi.mp4'): File {
  const f = new File(['x'], nome, { type: tipo })
  Object.defineProperty(f, 'size', { value: byte })
  return f
}

const FIRMA_OK = { path: 'uploads/ed-1/123-abcdefg.mp4', signedUrl: 'https://storage/firmato', token: 'tok' }

/** `fetch` finta a due tappe: prima la firma, poi la `PUT`. */
function fetchFinta(opzioni: { firma?: Partial<Response> & { corpo?: unknown }; put?: Partial<Response> } = {}) {
  const chiamate: Array<{ url: string; init: RequestInit }> = []
  const f = vi.fn(async (url: unknown, init: unknown) => {
    chiamate.push({ url: String(url), init: (init ?? {}) as RequestInit })
    if (String(url).includes('/api/gallery/upload-url')) {
      const s = opzioni.firma?.status ?? 200
      return { ok: s >= 200 && s < 300, status: s, json: async () => opzioni.firma?.corpo ?? FIRMA_OK } as Response
    }
    const s = opzioni.put?.status ?? 200
    return { ok: s >= 200 && s < 300, status: s } as Response
  })
  vi.stubGlobal('fetch', f)
  return chiamate
}

const corpoFirma = (chiamate: Array<{ url: string; init: RequestInit }>) =>
  JSON.parse(String(chiamate.find((c) => c.url.includes('upload-url'))!.init.body))

const putDi = (chiamate: Array<{ url: string; init: RequestInit }>) =>
  chiamate.find((c) => !c.url.includes('upload-url'))

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('caricaMediaGalleria · il mime col suffisso codec', () => {
  it('invia i byte della foto come ArrayBuffer, leggibili anche dopo IndexedDB su WebKit', async () => {
    const chiamate = fetchFinta()
    const file = new File([new Uint8Array([255, 216, 255, 224])], 'foto.jpg', { type: 'image/jpeg' })
    await caricaMediaGalleria(file, file.type)
    const body = putDi(chiamate)?.init.body
    expect(body).toBeInstanceOf(ArrayBuffer)
    expect(Array.from(new Uint8Array(body as ArrayBuffer))).toEqual([255, 216, 255, 224])
  })
  it('il corpo della FIRMA porta il container puro, non ciò che MediaRecorder ha scritto', async () => {
    const chiamate = fetchFinta()
    await caricaMediaGalleria(fileDa(9_000_000, 'video/mp4;codecs=avc1'), 'video/mp4;codecs=avc1')
    expect(corpoFirma(chiamate).mime).toBe('video/mp4')
  })

  it('l\'header della PUT porta lo stesso container puro: è il filo che arriva allo Storage', async () => {
    const chiamate = fetchFinta()
    await caricaMediaGalleria(fileDa(9_000_000, 'video/webm;codecs=vp9'), 'video/webm;codecs=vp9')
    const put = putDi(chiamate)!
    const ct = (put.init.headers as Record<string, string>)['content-type']
    expect(ct).toBe('video/webm')
    // Lo Storage confronta il `content-type` con `allowed_mime_types`: un parametro
    // qui farebbe rifiutare il file DOPO che è stato spedito per intero, su rete mobile.
    expect(ct).not.toContain(';')
  })

  it('i due fili portano lo STESSO valore: una normalizzazione, non due', async () => {
    const chiamate = fetchFinta()
    await caricaMediaGalleria(fileDa(9_000_000, 'video/mp4;codecs=avc1'), 'video/mp4;codecs=avc1')
    const ct = (putDi(chiamate)!.init.headers as Record<string, string>)['content-type']
    expect(ct).toBe(corpoFirma(chiamate).mime)
  })

  it('un mime già pulito attraversa intatto', async () => {
    const chiamate = fetchFinta()
    const esito = await caricaMediaGalleria(fileDa(800_000, 'image/jpeg'), 'image/jpeg')
    expect(esito).toEqual({ ok: true, path: FIRMA_OK.path })
    expect(corpoFirma(chiamate).mime).toBe('image/jpeg')
  })
})

describe('caricaMediaGalleria · i rami di fallimento restano distinguibili', () => {
  it('400 ⇒ «formato non ammesso», NON l\'invito a riprovare che ha prodotto i 429', async () => {
    // Il 2026-09-08 il 400 cadeva nel ramo generico `firma`, cioè «Riprova fra qualche
    // minuto»: le 8 insegnanti hanno riprovato 33 volte e due sono finite nel rate limit.
    // Il messaggio non era solo inutile — ha prodotto il guasto successivo.
    const chiamate = fetchFinta({ firma: { status: 400 } })
    const esito = await caricaMediaGalleria(fileDa(9_000_000, 'video/mp4'), 'video/mp4')
    expect(esito).toEqual({ ok: false, motivo: 'formato-non-ammesso', stato: 400 })
    expect(putDi(chiamate)).toBeUndefined()
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ messaggio: 'gallery-formato-rifiutato', stato: 400 }))
  })

  it('415 ⇒ «firma», registrato a `error`: nessuna nostra porta lo manda più (era lo sniff del codec)', async () => {
    // Il ramo `formato` è sparito con lo sniff: se un 415 arrivasse, verrebbe dalla piattaforma, e
    // non c'è una frase sul «video da convertire» che gli si addica.
    fetchFinta({ firma: { status: 415 } })
    const esito = await caricaMediaGalleria(fileDa(9_000_000, 'video/mp4'), 'video/mp4')
    expect(esito).toEqual({ ok: false, motivo: 'firma', stato: 415 })
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ messaggio: 'gallery-firma-non-emessa', stato: 415, livello: 'error' }),
    )
  })

  it('429 ⇒ «firma», e lì «riprova fra qualche minuto» è la frase GIUSTA', async () => {
    fetchFinta({ firma: { status: 429 } })
    const esito = await caricaMediaGalleria(fileDa(9_000_000, 'video/mp4'), 'video/mp4')
    expect(esito).toEqual({ ok: false, motivo: 'firma', stato: 429 })
  })

  it('oltre il tetto del bucket non si spedisce affatto', async () => {
    const chiamate = fetchFinta()
    const esito = await caricaMediaGalleria(fileDa(TETTO_GALLERIA_BYTE + 1, 'video/mp4'), 'video/mp4')
    expect(esito).toEqual({ ok: false, motivo: 'troppo-grande', stato: null })
    expect(chiamate).toHaveLength(0)
  })

  it('firma senza `path` ⇒ errore, non un successo silenzioso', async () => {
    fetchFinta({ firma: { corpo: { signedUrl: 'https://storage/firmato' } } })
    const esito = await caricaMediaGalleria(fileDa(800_000, 'image/jpeg'), 'image/jpeg')
    expect(esito).toEqual({ ok: false, motivo: 'firma', stato: 200 })
  })
})

describe('caricaMediaGalleria · ripresa foto', () => {
  it('salva il path PRIMA del PUT e lo ripassa come resume_path al rientro', async () => {
    const eventi: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('upload-url')) {
        expect(JSON.parse(String(init.body)).resume_path).toBe('uploads/ed-1/precedente.jpg')
        return { ok: true, status: 200, json: async () => ({ path: 'uploads/ed-1/precedente.jpg', signedUrl: 'https://storage/firmato' }) }
      }
      eventi.push('put')
      return { ok: true, status: 200 }
    }))
    const esito = await caricaMediaGalleria(fileDa(100, 'image/jpeg'), 'image/jpeg', {
      resumePath: 'uploads/ed-1/precedente.jpg',
      onPath: async path => { expect(path).toBe('uploads/ed-1/precedente.jpg'); eventi.push('persist') },
    })
    expect(esito).toEqual({ ok: true, path: 'uploads/ed-1/precedente.jpg' })
    expect(eventi).toEqual(['persist', 'put'])
  })

  it('se la firma conferma l’oggetto già presente non fa una seconda PUT', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ path: 'uploads/ed-1/precedente.jpg', uploaded: true }) })
    vi.stubGlobal('fetch', fetchMock)
    const esito = await caricaMediaGalleria(fileDa(100, 'image/jpeg'), 'image/jpeg', { resumePath: 'uploads/ed-1/precedente.jpg' })
    expect(esito).toEqual({ ok: true, path: 'uploads/ed-1/precedente.jpg' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('se IndexedDB non salva il path non avvia la PUT', async () => {
    const chiamate = fetchFinta()
    const esito = await caricaMediaGalleria(fileDa(100, 'image/jpeg'), 'image/jpeg', {
      onPath: async () => { throw new Error('QuotaExceededError') },
    })
    expect(esito).toEqual({ ok: false, motivo: 'persistenza', stato: null })
    expect(putDi(chiamate)).toBeUndefined()
  })

  it('propaga Retry-After della firma 429 senza fare PUT', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, headers: { get: () => '60' } }))
    const esito = await caricaMediaGalleria(fileDa(100, 'image/jpeg'), 'image/jpeg')
    expect(esito).toEqual({ ok: false, motivo: 'firma', stato: 429, retryAfterMs: 60_000 })
  })

  it('se l’account cambia durante la firma non avvia il PUT', async () => {
    let attivo = true
    const chiamate = fetchFinta({ firma: { corpo: FIRMA_OK } })
    const fetchOriginale = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const response = await fetchOriginale(url, init)
      attivo = false
      return response
    }))
    const esito = await caricaMediaGalleria(fileDa(100, 'image/jpeg'), 'image/jpeg', { canContinue: () => attivo })
    expect(esito).toEqual({ ok: false, motivo: 'ambito-cambiato', stato: null })
    expect(putDi(chiamate)).toBeUndefined()
  })

  it('non chiede una firma se l’ambito è già cambiato', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const esito = await caricaMediaGalleria(fileDa(100, 'image/jpeg'), 'image/jpeg', { canContinue: () => false })
    expect(esito).toEqual({ ok: false, motivo: 'ambito-cambiato', stato: null })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('caricaMediaGalleria · ciò che non deve MAI finire nei log', () => {
  it('nessuna riga porta il nome del file', async () => {
    fetchFinta({ firma: { status: 400 } })
    await caricaMediaGalleria(fileDa(9_000_000, 'video/mp4', 'IMG_bambina-rossi.mp4'), 'video/mp4')
    const righe = JSON.stringify(h.logClient.mock.calls)
    expect(righe).not.toContain('bambina')
    expect(righe).not.toContain('rossi')
  })
})

describe('caricaMediaGalleria · la firma non porta più la testa del file', () => {
  it('il corpo ha solo tipo e taglia: nessun `testa_b64`, né per un video né per una foto', async () => {
    // La testa (i primi 64 KB in base64) serviva allo sniff del codec sul server: lo sniff non c'è
    // più. Un client che continuasse a mandarla spedirebbe ottantasettemila caratteri per niente, e
    // soprattutto rimetterebbe in piedi un secondo giudice del contenuto accanto al blocco.
    for (const [tipo, byte] of [['video/mp4', 9_000_000], ['video/webm;codecs=vp9', 9_000_000], ['image/jpeg', 800_000]] as const) {
      const chiamate = fetchFinta()
      await caricaMediaGalleria(fileDa(byte, tipo), tipo)
      expect(Object.keys(corpoFirma(chiamate)).sort(), tipo).toEqual(['mime', 'size'])
    }
  })

  it('con una ripresa il corpo porta in più SOLO il `resume_path`', async () => {
    const chiamate = fetchFinta()
    await caricaMediaGalleria(fileDa(100, 'image/jpeg'), 'image/jpeg', { resumePath: 'uploads/ed-1/precedente.jpg' })
    expect(Object.keys(corpoFirma(chiamate)).sort()).toEqual(['mime', 'resume_path', 'size'])
  })

  it('non legge nemmeno i byte del file per la firma: nessuna `slice` sul `File`', async () => {
    fetchFinta()
    const file = fileDa(9_000_000, 'video/mp4')
    const slice = vi.spyOn(file, 'slice')
    await caricaMediaGalleria(file, 'video/mp4')
    expect(slice).not.toHaveBeenCalled()
  })
})

describe('messaggioCaricamento', () => {
  it('il formato non ammesso ha una frase sua, non quella dell\'aggiornamento dell\'app', () => {
    expect(messaggioCaricamento({ ok: false, motivo: 'formato-non-ammesso', stato: 400 }, (k) => k))
      .toBe('galleryErrFormatoNonAmmesso')
  })
})
