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
 * IL DIFETTO, in una riga: `MediaRecorder` non produce `video/mp4`, produce
 * `video/mp4;codecs=avc1` (`processing.ts:293-300`), quel tipo finisce nel `File`
 * convertito e da lì, GREZZO, in due posti che non tollerano parametri — il nostro
 * `z.enum` (400) e `allowed_mime_types` del bucket. Il repo sapeva normalizzare e lo
 * fa in tre punti (`gallery/upload/route.ts:32`, `news/upload/route.ts:55`,
 * `processing.ts:131`): la porta nuova era l'unica che non lo faceva.
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

  it('415 ⇒ «formato»: il video non convertibile resta un caso suo', async () => {
    fetchFinta({ firma: { status: 415 } })
    const esito = await caricaMediaGalleria(fileDa(9_000_000, 'video/mp4'), 'video/mp4')
    expect(esito).toEqual({ ok: false, motivo: 'formato', stato: 415 })
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

describe('caricaMediaGalleria · ciò che non deve MAI finire nei log', () => {
  it('nessuna riga porta il nome del file', async () => {
    fetchFinta({ firma: { status: 400 } })
    await caricaMediaGalleria(fileDa(9_000_000, 'video/mp4', 'IMG_bambina-rossi.mp4'), 'video/mp4')
    const righe = JSON.stringify(h.logClient.mock.calls)
    expect(righe).not.toContain('bambina')
    expect(righe).not.toContain('rossi')
  })
})

describe('messaggioCaricamento', () => {
  it('il formato non ammesso ha una frase sua, non quella del video da convertire', () => {
    expect(messaggioCaricamento({ ok: false, motivo: 'formato-non-ammesso', stato: 400 }, (k) => k))
      .toBe('galleryErrFormatoNonAmmesso')
    expect(messaggioCaricamento({ ok: false, motivo: 'formato', stato: 415 }, (k) => k))
      .toBe('galleryAlertVideoNonConvertibile')
  })
})
