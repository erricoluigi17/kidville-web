import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

import {
  BUCKET_ORIGINALI_VIDEO,
  DIMENSIONE_BLOCCO_TUS_BYTE,
  schemaRispostaFirmaVideo,
} from '@/lib/media/video/contratto'
import { SUPABASE_URL } from '@/lib/supabase/public-config'

/**
 * `POST /api/video-uploads/[id]/firma` — una firma TUS NUOVA per un job che aspetta ancora il suo file.
 *
 * Fino alla PR 2 la ripresa di un caricamento interrotto «riapriva» l'intento per ottenere una firma
 * fresca: 190 aperture per 44 job, ciascuna con i suoi cancelli, la sua RPC, il suo `info` sullo Storage.
 * Questa route fa soltanto ciò che serve: verifica che il job sia ancora in attesa e firma di nuovo il SUO
 * percorso — quello che sta nel DATABASE, mai uno scelto dal client.
 *
 * Si prova: che il cancello sia quello di GET e PATCH (proprietà e sede, un posto solo); che la firma sia
 * solo per un job di QUESTO intento e solo se aspetta ancora i byte (409 altrimenti); che il percorso e il
 * tipo vengano dalla riga; che il tetto sia per utente; e che nel log passino solo uuid — mai il percorso
 * (porta l'uuid di chi carica) né la firma.
 */

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  scuoleDiUtente: vi.fn(),
  rateLimit: vi.fn(),
  createSignedUploadUrl: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  intent: null as Record<string, unknown> | null,
  intentError: null as { code?: string; message?: string } | null,
  job: [] as Record<string, unknown>[],
  tabelleLette: [] as string[],
  corpoLetto: 0,
  percorsiFirmati: [] as string[],
  bucketFirmato: '',
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(),
  requireStaff: vi.fn(),
  requireDocente: h.requireDocente,
}))

vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: vi.fn(),
  scuoleDiUtente: h.scuoleDiUtente,
  resolveScuoleAttive: vi.fn(),
}))

vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: h.rateLimit,
  clientIp: () => '1.2.3.4',
}))

vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
  logErrore: h.logErrore,
}))

/** Il finto builder di `leggiIntento`: `.select().eq().eq().maybeSingle()` per l'intento, `.select().eq().order()` per i job. */
function tabella(nome: string) {
  h.tabelleLette.push(nome)
  // I filtri `.eq()` si APPLICANO alle righe, come fa PostgREST: un finto che li ignorasse restituirebbe l'intento di
  // un'altra persona anche se `leggiIntento` dimenticasse `owner_id`, ed è esattamente il difetto da provare.
  const filtri: [string, unknown][] = []
  const passa = (riga: Record<string, unknown> | null) => riga !== null && filtri.every(([c, v]) => riga[c] === v)
  const catena: Record<string, unknown> = {
    select: () => catena,
    eq: (colonna: string, valore: unknown) => {
      filtri.push([colonna, valore])
      return catena
    },
    in: () => catena,
    limit: () => catena,
    order: async () => ({ data: h.job.filter(passa), error: null }),
    maybeSingle: async () => ({
      data: nome === 'video_intents' && !h.intentError && passa(h.intent) ? h.intent : null,
      error: h.intentError,
    }),
    then: undefined,
  }
  return catena
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (nome: string) => tabella(nome),
    storage: {
      from: (bucket: string) => {
        h.bucketFirmato = bucket
        return {
          createSignedUploadUrl: (percorso: string) => {
            h.percorsiFirmati.push(percorso)
            return h.createSignedUploadUrl(percorso)
          },
        }
      },
    },
  }),
}))

import { POST } from '@/app/api/video-uploads/[id]/firma/route'
import { estensioneVideoDaMime, mimeDaEstensione } from '@/app/api/video-uploads/firme'

const SEDE = '10000000-0000-4000-8000-000000000001'
const ALTRA_SEDE = 'aaaaaaaa-0000-4000-8000-00000000000a'
const DOCENTE = '20000000-0000-4000-8000-000000000002'
const INTENT = '30000000-0000-4000-8000-000000000003'
const JOB_1 = '40000000-0000-4000-8000-000000000004'
const JOB_ESTRANEO = '40000000-0000-4000-8000-00000000000f'
const PERCORSO = `${DOCENTE}/0123456789abcdef0123456789abcdef.mov`

const params = { params: Promise.resolve({ id: INTENT }) }

const richiesta = (corpo: unknown) =>
  ({
    url: `http://test/api/video-uploads/${INTENT}/firma`,
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => {
      h.corpoLetto += 1
      return corpo
    },
    text: async () => JSON.stringify(corpo),
    cookies: { get: () => undefined },
  }) as never

const rigaIntent = (extra: Record<string, unknown> = {}) => ({
  id: INTENT,
  owner_id: DOCENTE,
  scuola_id: SEDE,
  channel: 'gallery',
  revision: 1,
  status: 'confirmed',
  updated_at: '2026-10-02T10:00:00.000Z',
  ...extra,
})

const rigaJob = (extra: Record<string, unknown> = {}) => ({
  id: JOB_1,
  intent_id: INTENT,
  channel: 'gallery',
  status: 'awaiting_upload',
  error_code: null,
  attempt: 0,
  updated_at: '2026-10-02T10:01:00.000Z',
  created_at: '2026-10-02T10:00:00.000Z',
  original_path: PERCORSO,
  mime_dichiarato: 'video/quicktime',
  arrivato_il: null,
  ...extra,
})

const eventi = (area: 'galleria' | 'news' = 'galleria') => h.logEvento.mock.calls.filter((c) => c[0] === area)
const tuttoIlLog = () => JSON.stringify([h.logEvento.mock.calls, h.logErrore.mock.calls])

beforeEach(() => {
  vi.clearAllMocks()
  h.intent = rigaIntent()
  h.intentError = null
  h.job = [rigaJob()]
  h.tabelleLette = []
  h.corpoLetto = 0
  h.percorsiFirmati = []
  h.bucketFirmato = ''
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE } })
  h.scuoleDiUtente.mockResolvedValue([SEDE])
  h.rateLimit.mockResolvedValue({ ok: true, remaining: 50, retryAfterMs: 0 })
  h.createSignedUploadUrl.mockResolvedValue({
    data: { signedUrl: 'https://storage.invalid/firmato?token=segreto-di-firma', token: 'firma-tus-nuova', path: 'x' },
    error: null,
  })
})

describe('POST /api/video-uploads/[id]/firma — la firma nuova', () => {
  it('restituisce le coordinate TUS del job, la firma nuova e la sua scadenza, e rispetta il contratto', async () => {
    const res = await POST(richiesta({ jobId: JOB_1 }), params)
    expect(res.status).toBe(200)
    const corpo = await res.json()

    const letto = schemaRispostaFirmaVideo.safeParse({
      ...corpo,
      // L'endpoint è http nel banco di prova (vedi `video-uploads.test.ts`) e https in produzione: si normalizza qui.
      caricamento: { ...corpo.caricamento, endpoint: corpo.caricamento.endpoint.replace(/^http:/, 'https:') },
    })
    expect(letto.success, JSON.stringify(letto.error?.issues ?? [])).toBe(true)

    expect(corpo).toMatchObject({
      jobId: JOB_1,
      firma: 'firma-tus-nuova',
      caricamento: {
        protocollo: 'tus',
        endpoint: `${SUPABASE_URL}/storage/v1/upload/resumable/sign`,
        bucket: BUCKET_ORIGINALI_VIDEO,
        percorso: PERCORSO,
        contentType: 'video/quicktime',
        dimensioneBloccoByte: DIMENSIONE_BLOCCO_TUS_BYTE,
      },
    })
    // La stessa validità di ogni firma di caricamento: due ore.
    const ore = (Date.parse(corpo.scadeIl) - Date.now()) / 3_600_000
    expect(ore).toBeGreaterThan(1.9)
    expect(ore).toBeLessThanOrEqual(2)
  })

  it('firma il percorso che sta nel DATABASE, nel bucket degli originali: mai uno scelto da chi chiama', async () => {
    await POST(richiesta({ jobId: JOB_1 }), params)
    expect(h.bucketFirmato).toBe(BUCKET_ORIGINALI_VIDEO)
    expect(h.percorsiFirmati).toEqual([PERCORSO])
  })

  it('il tipo è quello dichiarato all’apertura; se manca (una News) si ricava dall’estensione del percorso', async () => {
    h.job = [rigaJob({ mime_dichiarato: null, original_path: `${DOCENTE}/abc.mp4` })]
    const corpo = await (await POST(richiesta({ jobId: JOB_1 }), params)).json()
    expect(corpo.caricamento.contentType).toBe('video/mp4')
    // `bin` (un tipo che non si riconosceva) torna un tipo generico: l'autorità sul contenuto è ffprobe.
    h.job = [rigaJob({ mime_dichiarato: null, original_path: `${DOCENTE}/abc.bin` })]
    expect((await (await POST(richiesta({ jobId: JOB_1 }), params)).json()).caricamento.contentType).toBe('application/octet-stream')
  })

  it('vale anche per una News (stesso cancello): il log va nell’area `news`', async () => {
    h.intent = rigaIntent({ channel: 'news' })
    h.job = [rigaJob({ channel: 'news', mime_dichiarato: null })]
    const res = await POST(richiesta({ jobId: JOB_1 }), params)
    expect(res.status).toBe(200)
    expect(eventi('news').some((c) => c[2]?.esito === 'firma-rinnovata')).toBe(true)
    expect(eventi('galleria').some((c) => c[2]?.esito === 'firma-rinnovata')).toBe(false)
  })

  it('il successo si logga con i soli uuid: mai il percorso (porta l’uuid di chi carica) né la firma', async () => {
    await POST(richiesta({ jobId: JOB_1 }), params)
    const ev = eventi().filter((c) => c[2]?.esito === 'firma-rinnovata')
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('info')
    expect(ev[0][2]).toMatchObject({
      operazione: 'video-uploads/[id]/firma:POST',
      canale: 'gallery',
      utente: DOCENTE,
      intento: INTENT,
      job: JOB_1,
    })
    const testo = tuttoIlLog()
    expect(testo).not.toContain('0123456789abcdef')
    expect(testo).not.toContain('firma-tus-nuova')
    expect(testo).not.toContain('segreto-di-firma')
  })
})

describe('POST /api/video-uploads/[id]/firma — i cancelli', () => {
  it('il gate viene PRIMA di tutto: negato ⇒ nessun corpo letto, nessun tetto, nessuna lettura, nessuna firma', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    const res = await POST(richiesta({ jobId: JOB_1 }), params)
    expect(res.status).toBe(401)
    expect(h.corpoLetto).toBe(0)
    expect(h.rateLimit).not.toHaveBeenCalled()
    expect(h.tabelleLette).toEqual([])
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('il tetto è 60 ogni 10 minuti PER UTENTE; superato ⇒ 429, e nessuna firma', async () => {
    await POST(richiesta({ jobId: JOB_1 }), params)
    expect(h.rateLimit).toHaveBeenCalledWith(`video-uploads-firma:${DOCENTE}`, { limit: 60, windowMs: 600_000 })
    h.rateLimit.mockResolvedValue({ ok: false, remaining: 0, retryAfterMs: 7_000 })
    h.createSignedUploadUrl.mockClear()
    const res = await POST(richiesta({ jobId: JOB_1 }), params)
    expect(res.status).toBe(429)
    expect((await res.json()).codice).toBe('TROPPE_RICHIESTE')
    expect(res.headers.get('Retry-After')).toBe('7')
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it.each([
    ['un jobId che non è un uuid', { jobId: 'non-un-uuid' }],
    ['un corpo vuoto', {}],
    ['un jobId assente', { job: JOB_1 }],
  ])('%s ⇒ 400, prima di qualunque lettura', async (_nome, corpo) => {
    const res = await POST(richiesta(corpo), params)
    expect(res.status).toBe(400)
    expect(h.tabelleLette).toEqual([])
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('un id d’intento che non è un uuid ⇒ 400', async () => {
    const res = await POST(richiesta({ jobId: JOB_1 }), { params: Promise.resolve({ id: 'non-un-uuid' }) })
    expect(res.status).toBe(400)
    expect(h.tabelleLette).toEqual([])
  })

  it('l’intento di un’altra persona non esiste: 404 (non un oracolo), nessuna firma', async () => {
    h.intent = null
    const res = await POST(richiesta({ jobId: JOB_1 }), params)
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('VIDEO_NON_TROVATO')
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('il filtro di PROPRIETÀ sta dentro la query: l’intento di una collega risponde 404 (non 403) e nessuna firma esce', async () => {
    // Il finto APPLICA i `.eq()`: se `leggiIntento` dimenticasse `owner_id` la riga della collega tornerebbe, la sede
    // risulterebbe propria e la route firmerebbe il percorso di un'altra persona. Un confronto DOPO la lettura
    // darebbe un 403, e un 403 direbbe a chi prova che quell'id esiste.
    h.intent = rigaIntent({ owner_id: '99999999-0000-4000-8000-000000000009' })
    const res = await POST(richiesta({ jobId: JOB_1 }), params)
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('VIDEO_NON_TROVATO')
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('i job si leggono PER INTENTO: un job di un altro intento non si firma, anche se il suo id è giusto', async () => {
    h.job = [rigaJob({ id: JOB_ESTRANEO, intent_id: '30000000-0000-4000-8000-0000000000ff' })]
    const res = await POST(richiesta({ jobId: JOB_ESTRANEO }), params)
    expect(res.status).toBe(404)
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('la sede dell’intento non è più fra le proprie ⇒ 403: lo stesso cancello di GET e PATCH', async () => {
    h.scuoleDiUtente.mockResolvedValue([ALTRA_SEDE])
    const res = await POST(richiesta({ jobId: JOB_1 }), params)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('VIDEO_NON_AUTORIZZATO')
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('un job che non è di QUESTO intento ⇒ 404, e un `warn` col motivo', async () => {
    const res = await POST(richiesta({ jobId: JOB_ESTRANEO }), params)
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('VIDEO_NON_TROVATO')
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    const ev = eventi().filter((c) => c[2]?.esito === 'firma-negata')
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('warn')
    expect(ev[0][2]).toMatchObject({ tipo: 'job-fuori-intento', utente: DOCENTE, intento: INTENT, job: JOB_ESTRANEO })
  })
})

describe('POST /api/video-uploads/[id]/firma — solo finché il job aspetta il suo file', () => {
  it.each(['queued', 'processing', 'ready', 'failed', 'rejected', 'cancelled'])(
    'job %s ⇒ 409 `VIDEO_GIA_CONCLUSO`: non c’è più niente da firmare',
    async (status) => {
      h.job = [rigaJob({ status, error_code: status === 'failed' || status === 'rejected' ? 'ENCODE_FAILED' : null })]
      const res = await POST(richiesta({ jobId: JOB_1 }), params)
      expect(res.status).toBe(409)
      expect((await res.json()).codice).toBe('VIDEO_GIA_CONCLUSO')
      expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
      const ev = eventi().filter((c) => c[2]?.esito === 'firma-negata')
      expect(ev[0][2]).toMatchObject({ tipo: 'job-non-in-attesa', job: JOB_1 })
    },
  )

  it.each(['published', 'cancelled', 'superseded'])(
    'intento %s, anche col job rimasto in attesa ⇒ 409, e nessun permesso di scrivere',
    async (status) => {
      h.intent = rigaIntent({ status })
      const res = await POST(richiesta({ jobId: JOB_1 }), params)
      expect(res.status).toBe(409)
      expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
      expect(eventi().find((c) => c[2]?.esito === 'firma-negata')?.[2]).toMatchObject({ tipo: 'intento-concluso' })
    },
  )

  it('la firma non riuscita ⇒ 500 col suo codice: il motivo del fornitore resta nel LOG e non esce', async () => {
    h.createSignedUploadUrl.mockResolvedValue({ data: null, error: { message: 'Bucket not found: video_originals' } })
    const res = await POST(richiesta({ jobId: JOB_1 }), params)
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
    expect(JSON.stringify(corpo)).not.toContain('Bucket not found')
    expect(JSON.stringify(h.logErrore.mock.calls)).toContain('Bucket not found')
    // E non è un successo: nessuna riga `firma-rinnovata`.
    expect(eventi().some((c) => c[2]?.esito === 'firma-rinnovata')).toBe(false)
  })

  it('la pipeline non installata (tabella assente) ⇒ 503 pulito, e nessuna firma', async () => {
    h.intentError = { code: '42P01', message: 'relation "video_intents" does not exist' }
    const res = await POST(richiesta({ jobId: JOB_1 }), params)
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })
})

describe('le firme condivise — estensione e tipo, e ritorno', () => {
  it.each([
    ['video/mp4', 'mp4'],
    ['video/quicktime', 'mov'],
    ['video/x-m4v', 'm4v'],
    ['video/webm', 'webm'],
    ['video/x-matroska', 'mkv'],
    ['video/3gpp', '3gp'],
    ['video/mpeg', 'mpg'],
    // Il suffisso dei codec (quello che scrive MediaRecorder) non cambia l'estensione.
    ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'mp4'],
    ['VIDEO/MP4', 'mp4'],
  ])('`%s` ⇒ estensione `%s`, e dall’estensione si torna a un tipo che la riproduce', (mime, estensione) => {
    expect(estensioneVideoDaMime(mime)).toBe(estensione)
    expect(estensioneVideoDaMime(mimeDaEstensione(`x/y.${estensione}`))).toBe(estensione)
  })

  it('un tipo che non si riconosce è `bin`, e `bin` torna `application/octet-stream`', () => {
    expect(estensioneVideoDaMime('video/x-qualcosa')).toBe('bin')
    expect(estensioneVideoDaMime('')).toBe('bin')
    expect(mimeDaEstensione('x/y.bin')).toBe('application/octet-stream')
    expect(mimeDaEstensione('senza-estensione')).toBe('application/octet-stream')
    expect(mimeDaEstensione('x/y.MOV')).toBe('video/quicktime')
  })
})
