// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * LA PORTA ACCANTO — `iscrizione/upload:POST` (collaudo del 2026-08-02, sicurezza F1).
 *
 * MISURATO SUL SERVER DI PRODUZIONE, da anonimo e senza cookie:
 *   for i in {1..10}; do curl -X POST http://localhost:3100/api/iscrizione/upload; done
 *   → 500 500 500 500 500 500 500 500 500 500   ← MAI un 429
 *   stessa prova su /api/iscrizione → 400 400 400 400 429 429 429 429 429 429
 *
 * Tre difetti in una porta sola, tutti sul bucket che custodisce i documenti d'iscrizione
 * dei minori (`form_attachments`, 961 file veri al 2026-08-02):
 *  1. nessun tetto per IP — le tre rotte sorelle dello stesso wizard pubblico ce l'hanno
 *     tutte, questa era rimasta fuori dall'elenco;
 *  2. nessuna allowlist di tipo/estensione — il bucket ha `allowed_mime_types = NULL`,
 *     quindi non c'era nessun freno, né qui né là sotto;
 *  3. un errore del CLIENT (Content-Type sbagliato) classificato 500, col messaggio interno
 *     del runtime restituito al chiamante ANONIMO.
 *
 * La rotta deve restare PUBBLICA: da lì arrivano ~9 domande l'ora da famiglie vere, e chi
 * compila non ha (ancora) un account. Si chiude col tetto, con la lista dei tipi e con un
 * limite di dimensione — non con un gate di sessione.
 *
 * IL TETTO È 20 OGNI 10 MINUTI, e il numero non è a occhio: in produzione ci sono 961
 * allegati per 227 domande, cioè 4,2 file per domanda, e gli INVII sono già limitati a
 * 5/10 min per IP. Venti caricamenti coprono cinque domande complete dallo stesso indirizzo;
 * sotto quella soglia si sarebbe respinta una famiglia vera.
 */

const h = vi.hoisted(() => ({
  uploads: [] as { path: string; contentType?: string }[],
  erroreUpload: null as unknown,
  logErrore: vi.fn(),
  logEvento: vi.fn(),
}))

vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: {
      from: () => ({
        upload: async (path: string, _corpo: unknown, opzioni?: { contentType?: string }) => {
          h.uploads.push({ path, contentType: opzioni?.contentType })
          return { error: h.erroreUpload }
        },
      }),
    },
  }),
}))

import { POST } from '@/app/api/iscrizione/upload/route'
import { resetRateLimit } from '@/lib/security/rate-limit'
import { TETTO_UPLOAD_PUBBLICO } from '@/lib/upload/allegati-pubblici'

/** Un file di byte VERI: la richiesta viaggia in multipart e una taglia finta si perderebbe. */
const fileDa = (nome: string, tipo: string, byte = 32): File =>
  new File([Buffer.alloc(byte, 0x78)], nome, { type: tipo })

function richiesta(file: File | null, ip = '10.0.0.1'): Request {
  const fd = new FormData()
  if (file) fd.append('file', file)
  fd.append('folder', 'modulo-iscrizione')
  return new Request('http://localhost/api/iscrizione/upload', {
    method: 'POST',
    body: fd,
    headers: { 'x-forwarded-for': ip },
  })
}

/** La richiesta sbagliata del collaudo: Content-Type JSON su una rotta multipart. */
const richiestaNonMultipart = (ip = '10.0.0.9'): Request =>
  new Request('http://localhost/api/iscrizione/upload', {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.uploads = []
  h.erroreUpload = null
  resetRateLimit()
})

describe('POST /api/iscrizione/upload · il tetto per IP', () => {
  it('oltre il tetto risponde 429 con Retry-After, e il file non parte', async () => {
    for (let i = 0; i < TETTO_UPLOAD_PUBBLICO; i++) {
      const ok = await POST(richiesta(fileDa('documento.pdf', 'application/pdf')) as never)
      expect(ok.status, `il caricamento ${i + 1} doveva passare`).toBe(200)
    }
    const caricatiPrima = h.uploads.length

    const res = await POST(richiesta(fileDa('documento.pdf', 'application/pdf')) as never)

    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    expect(
      h.uploads.length,
      'Il caricamento oltre il tetto non deve arrivare allo Storage: un 429 dato DOPO ' +
        'l’upload non è un tetto, è un commento.',
    ).toBe(caricatiPrima)
  })

  it('il tetto è PER IP: un altro indirizzo riparte da zero (controllo positivo)', async () => {
    for (let i = 0; i < TETTO_UPLOAD_PUBBLICO; i++) {
      await POST(richiesta(fileDa('documento.pdf', 'application/pdf'), '10.0.0.1') as never)
    }
    expect((await POST(richiesta(fileDa('d.pdf', 'application/pdf'), '10.0.0.1') as never)).status).toBe(429)
    // Una famiglia diversa, dietro un altro indirizzo, non paga il tetto della prima.
    expect((await POST(richiesta(fileDa('d.pdf', 'application/pdf'), '10.0.0.2') as never)).status).toBe(200)
  })

  it('il 429 non arriva PRIMA del tetto (il modulo pubblico deve funzionare)', async () => {
    // 227 domande vere con 4,2 allegati ciascuna: un tetto troppo stretto non è prudenza,
    // è un modulo d'iscrizione rotto per una famiglia con quattro documenti da caricare.
    expect(TETTO_UPLOAD_PUBBLICO).toBeGreaterThanOrEqual(20)
  })
})

describe('POST /api/iscrizione/upload · i tipi ammessi', () => {
  it('un eseguibile non arriva MAI nel bucket dei documenti dei minori', async () => {
    const res = await POST(richiesta(fileDa('virus.exe', 'application/octet-stream')) as never)

    expect(res.status).toBe(415)
    expect(h.uploads, 'Il file rifiutato non deve toccare lo Storage.').toHaveLength(0)
  })

  it('un finto `.html` viene rifiutato (porta script, e il bucket non ha filtri)', async () => {
    const res = await POST(richiesta(fileDa('pagina.html', 'text/html')) as never)
    expect(res.status).toBe(415)
    expect(h.uploads).toHaveLength(0)
  })

  it('l’estensione conta quanto il tipo: un `.exe` dichiarato `application/pdf` è rifiutato', async () => {
    const res = await POST(richiesta(fileDa('finto.exe', 'application/pdf')) as never)
    expect(res.status).toBe(415)
    expect(h.uploads).toHaveLength(0)
  })

  it('il rifiuto porta un CODICE traducibile e MAI il nome del file nei log', async () => {
    const res = await POST(richiesta(fileDa('certificato-medico-bruna.exe', 'text/html')) as never)
    const corpo = (await res.json()) as { error?: string; codice?: string }

    // Codice suo, e non quello degli allegati interni: lì i `.docx` si allegano, qui no.
    // Dire a una famiglia «sono ammessi anche i Word» la manderebbe contro un muro.
    expect(corpo.codice).toBe('ALLEGATO_PDF_O_IMMAGINE')
    const scritto = JSON.stringify(h.logEvento.mock.calls)
    expect(scritto).not.toContain('certificato')
    expect(scritto).not.toContain('bruna')
    // La riga c'è: un rifiuto silenzioso non si distingue da «non è mai arrivato niente».
    expect(h.logEvento.mock.calls.filter((c) => c[1] === 'warn')).toHaveLength(1)
  })

  it.each([
    ['documento.pdf', 'application/pdf'],
    ['foto.jpg', 'image/jpeg'],
    ['foto.jpeg', 'image/jpeg'],
    ['scansione.png', 'image/png'],
    ['tessera.heic', 'image/heic'],
  ])('CONTROLLO POSITIVO · `%s` (%s) si carica: è ciò che le famiglie mandano davvero', async (nome, tipo) => {
    // I quattro tipi misurati in produzione il 2026-08-02 su 961 allegati veri:
    // image/jpeg (680), application/pdf (220), image/png (60), image/heic (1).
    const res = await POST(richiesta(fileDa(nome, tipo)) as never)
    expect(res.status).toBe(200)
    expect(h.uploads).toHaveLength(1)
  })

  it('un `.heic` senza tipo dichiarato (Chrome) passa, e allo Storage arriva il tipo giusto', async () => {
    const res = await POST(richiesta(fileDa('tessera.heic', '')) as never)
    expect(res.status).toBe(200)
    expect(
      h.uploads[0]?.contentType,
      'Con `application/octet-stream` il bucket, appena dichiarerà i suoi tipi, rifiuterebbe ' +
        'un file valido dopo averlo accettato.',
    ).toBe('image/heic')
  })
})

describe('POST /api/iscrizione/upload · gli errori non raccontano l’interno', () => {
  it('un Content-Type sbagliato è 400, non 500', async () => {
    const res = await POST(richiestaNonMultipart() as never)

    expect(
      res.status,
      'Un errore del CLIENT non è un guasto del server: il 500 dice «ho un guasto io» e ' +
        'sporca ogni misura di salute del servizio.',
    ).toBe(400)
  })

  it('il messaggio interno del runtime non esce al chiamante anonimo', async () => {
    const res = await POST(richiestaNonMultipart() as never)
    const testo = JSON.stringify(await res.json())

    expect(testo).not.toMatch(/multipart\/form-data|x-www-form-urlencoded/i)
  })

  it('l’errore dello Storage resta nel log e non torna al client', async () => {
    h.erroreUpload = { message: 'mime type text/plain is not supported', statusCode: '400' }

    const res = await POST(richiesta(fileDa('documento.pdf', 'application/pdf')) as never)
    const testo = JSON.stringify(await res.json())

    expect(res.status).toBe(500)
    expect(
      testo,
      'Il corpo dell’errore del fornitore è per il LOG (AGENTS §3), non per il chiamante: ' +
        'porta fuori il nome del bucket, i vincoli e le policy.',
    ).not.toMatch(/mime type|not supported/i)
    // …e nel log c'è, per intero: senza, «500» non direbbe niente.
    expect(h.logErrore).toHaveBeenCalled()
    expect(JSON.stringify(h.logErrore.mock.calls)).toContain('mime type text/plain is not supported')
  })
})
