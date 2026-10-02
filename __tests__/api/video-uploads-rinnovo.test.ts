import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'

import { BUCKET_ORIGINALI_VIDEO, INTESTAZIONE_TOKEN_RINNOVO, schemaRispostaRinnovoVideo } from '@/lib/media/video/contratto'
import {
  FINESTRA_TETTO_RINNOVO_MS,
  TETTO_RINNOVO_PER_IP,
  TETTO_RINNOVO_PER_TOKEN,
  generaTokenRinnovo,
} from '@/lib/media/video/token-rinnovo'

/**
 * `POST /api/video-uploads/rinnovo` — un URL di caricamento NUOVO, per chi ha solo il token.
 *
 * È l'unica porta di questa cartella SENZA sessione, ed è per questo che si prova tanto: la chiama l'app
 * 1.2, dal sistema operativo e anche ad app chiusa, quando l'URL firmato scade o la PUT prende 400/403. Il
 * suo gate è un token — `kvr_` più 256 bit — nell'intestazione `x-kidville-rinnovo`, e tutto ciò che
 * regge la porta è provato qui:
 *
 *  · **404 UNIFORME**: token assente, malformato, sconosciuto o revocato-con-file-da-caricare rispondono lo
 *    stesso stato e lo stesso corpo, al carattere. Distinguerli direbbe a chi prova che quel token è esistito.
 *  · **UN token revocato non dà MAI un URL** (#31): dopo l'arrivo del file, o dopo il ritiro del video, la
 *    risposta è lo stato (`arrivato`/`annullato`) — che serve all'app per sapere che il file c'è — e basta.
 *  · **I due tetti** — per IP e per impronta del token — si applicano a ogni richiesta ben formata.
 *  · **L'URL è firmato SENZA upsert**: la proprietà che impedisce di sovrascrivere un originale già arrivato.
 *  · **Il corpo non si legge mai**, e il token si legge solo dall'intestazione.
 *  · **IL TOKEN NON ENTRA MAI IN UN LOG**: l'ultima sezione esegue la route col logger VERO, in ogni ramo, e
 *    cerca il token, il suo hash (in esadecimale, `\x…`, base64 e base64url) e l'URL firmato in tutto ciò che
 *    il logger scrive — su console e in tabella.
 */

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  rateLimit: vi.fn(),
  rpc: vi.fn(),
  createSignedUploadUrl: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  percorsiFirmati: [] as string[],
  opzioniFirma: [] as unknown[],
  bucketFirmato: '',
  corpoLetto: 0,
  eccezione: null as Error | null,
}))

// La porta NON ha una sessione: se la route chiamasse `requireDocente` il test lo vedrebbe.
vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(),
  requireStaff: vi.fn(),
  requireDocente: h.requireDocente,
}))

vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: h.rateLimit,
  clientIp: () => '203.0.113.9',
}))

vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
  logErrore: h.logErrore,
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: (nome: string, args: Record<string, unknown>) => {
      if (h.eccezione) throw h.eccezione
      return h.rpc(nome, args)
    },
    storage: {
      from: (bucket: string) => {
        h.bucketFirmato = bucket
        return {
          createSignedUploadUrl: (percorso: string, opzioni?: unknown) => {
            h.percorsiFirmati.push(percorso)
            h.opzioniFirma.push(opzioni)
            return h.createSignedUploadUrl(percorso)
          },
        }
      },
    },
  }),
}))

import { POST } from '@/app/api/video-uploads/rinnovo/route'

const JOB = '40000000-0000-4000-8000-000000000004'
const INTENT = '30000000-0000-4000-8000-000000000003'
const DOCENTE = '20000000-0000-4000-8000-000000000002'
const PERCORSO = `${DOCENTE}/0123456789abcdef0123456789abcdef.mov`
const URL_FIRMATO = 'https://storage.invalid/storage/v1/object/upload/sign/video_originals/x.mov?token=segreto-di-firma'

/** Una richiesta: SENZA sessione, con (o senza) il token nell'intestazione, e un corpo che NON deve essere letto. */
const richiesta = (intestazioni: Record<string, string> = {}, url = 'http://test/api/video-uploads/rinnovo') =>
  ({
    url,
    method: 'POST',
    headers: new Headers(intestazioni),
    json: async () => {
      h.corpoLetto += 1
      return { qualunque: 'cosa' }
    },
    text: async () => {
      h.corpoLetto += 1
      return '{"qualunque":"cosa"}'
    },
    formData: async () => {
      h.corpoLetto += 1
      return new FormData()
    },
    cookies: { get: () => undefined },
  }) as never

const conToken = (token: string) => richiesta({ [INTESTAZIONE_TOKEN_RINNOVO]: token })

/** L'esito di `video_rinnovo_usa` per un job che aspetta ancora il suo file. */
const daCaricare = (extra: Record<string, unknown> = {}) => ({
  ok: true,
  stato: 'da-caricare',
  job_id: JOB,
  intent_id: INTENT,
  bucket: BUCKET_ORIGINALI_VIDEO,
  percorso: PERCORSO,
  mime: 'video/quicktime',
  byte: 812_345_678,
  // PostgREST restituisce un timestamptz con l'offset, non con la `Z`.
  scade_il: '2026-10-04T12:00:00.123456+00:00',
  ...extra,
})

const eventi = () => h.logEvento.mock.calls.filter((c) => c[0] === 'galleria')

let token = ''
let hashEsadecimale = ''

beforeEach(() => {
  vi.clearAllMocks()
  h.percorsiFirmati = []
  h.opzioniFirma = []
  h.bucketFirmato = ''
  h.corpoLetto = 0
  h.eccezione = null
  token = generaTokenRinnovo()
  hashEsadecimale = createHash('sha256').update(token).digest('hex')
  h.rateLimit.mockResolvedValue({ ok: true, remaining: 10, retryAfterMs: 0 })
  h.rpc.mockResolvedValue({ data: daCaricare(), error: null })
  h.createSignedUploadUrl.mockResolvedValue({ data: { signedUrl: URL_FIRMATO, token: 'x', path: 'x' }, error: null })
})

describe('POST /api/video-uploads/rinnovo — da-caricare: un URL nuovo, firmato SENZA upsert', () => {
  it('restituisce lo stato, l’URL di PUT con il tipo dichiarato e la scadenza del TOKEN, e rispetta il contratto', async () => {
    const res = await POST(conToken(token))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    const letto = schemaRispostaRinnovoVideo.safeParse(corpo)
    expect(letto.success, JSON.stringify(letto.error?.issues ?? [])).toBe(true)
    expect(corpo).toEqual({
      stato: 'da-caricare',
      caricamento: {
        protocollo: 'put',
        url: URL_FIRMATO,
        metodo: 'PUT',
        intestazioni: { 'content-type': 'video/quicktime' },
      },
      // La scadenza del TOKEN (immutata dal rinnovo), in UTC con la `Z`: il contratto non ammette l'offset.
      scadeIl: '2026-10-04T12:00:00.123Z',
    })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('l’URL si firma per il percorso che la RPC ha restituito, nel bucket degli originali, SENZA upsert', async () => {
    await POST(conToken(token))
    expect(h.bucketFirmato).toBe(BUCKET_ORIGINALI_VIDEO)
    expect(h.percorsiFirmati).toEqual([PERCORSO])
    // ⚠️ È la proprietà che regge il token: una seconda PUT sullo stesso percorso prende 409 invece di sovrascrivere.
    expect(h.opzioniFirma).toEqual([{ upsert: false }])
  })

  it('alla RPC va l’HASH del token nella forma di un `bytea` — mai il token — e nient’altro', async () => {
    await POST(conToken(token))
    expect(h.rpc).toHaveBeenCalledTimes(1)
    expect(h.rpc).toHaveBeenCalledWith('video_rinnovo_usa', { p_hash: `\\x${hashEsadecimale}` })
    expect(JSON.stringify(h.rpc.mock.calls)).not.toContain(token)
  })

  it('senza un tipo dichiarato (`mime` nullo) si ricava dall’estensione del percorso', async () => {
    h.rpc.mockResolvedValue({ data: daCaricare({ mime: null, percorso: `${DOCENTE}/abc.mp4` }), error: null })
    const corpo = await (await POST(conToken(token))).json()
    expect(corpo.caricamento.intestazioni['content-type']).toBe('video/mp4')
  })

  it('il successo si logga con i soli uuid del job e dell’intento — non il percorso, non l’URL', async () => {
    await POST(conToken(token))
    const ev = eventi().filter((c) => c[2]?.esito === 'rinnovo-emesso')
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('info')
    expect(ev[0][2]).toMatchObject({ operazione: 'video-uploads/rinnovo:POST', job: JOB, intento: INTENT })
    const testo = JSON.stringify([h.logEvento.mock.calls, h.logErrore.mock.calls])
    expect(testo).not.toContain('0123456789abcdef')
    expect(testo).not.toContain('segreto-di-firma')
  })
})

describe('POST /api/video-uploads/rinnovo — UN token revocato non dà MAI un URL (#31)', () => {
  it('il file è arrivato: risponde `arrivato`, e nessuna firma viene coniata', async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, stato: 'arrivato' }, error: null })
    const res = await POST(conToken(token))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo).toEqual({ stato: 'arrivato' })
    expect(schemaRispostaRinnovoVideo.safeParse(corpo).success).toBe(true)
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    expect(JSON.stringify(corpo)).not.toContain('http')
    expect(eventi().some((c) => c[2]?.esito === 'rinnovo-arrivato')).toBe(true)
  })

  it('il video è stato ritirato: risponde `annullato`, e nessuna firma', async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, stato: 'annullato' }, error: null })
    const res = await POST(conToken(token))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ stato: 'annullato' })
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    expect(eventi().some((c) => c[2]?.esito === 'rinnovo-annullato')).toBe(true)
  })

  it('revocato mentre il file è ANCORA da caricare: la RPC dice `TOKEN_NON_VALIDO`, e per fuori è un 404', async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, code: 'TOKEN_NON_VALIDO' }, error: null })
    const res = await POST(conToken(token))
    expect(res.status).toBe(404)
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('`arrivato` e `annullato` non portano una scadenza, un percorso o un tipo: solo lo stato', async () => {
    for (const stato of ['arrivato', 'annullato']) {
      h.rpc.mockResolvedValue({ data: { ok: true, stato, percorso: PERCORSO, mime: 'video/mp4', scade_il: '2026-10-04T12:00:00Z' }, error: null })
      const corpo = await (await POST(conToken(token))).json()
      expect(Object.keys(corpo)).toEqual(['stato'])
    }
  })
})

describe('POST /api/video-uploads/rinnovo — il 404 UNIFORME', () => {
  /** Ogni modo di non avere un token valido, e la risposta che produce: devono essere IDENTICHE. */
  const casi: [string, () => unknown, Record<string, string>?][] = [
    ['nessuna intestazione', () => richiesta()],
    ['intestazione vuota', () => richiesta({ [INTESTAZIONE_TOKEN_RINNOVO]: '' })],
    ['un valore qualunque', () => richiesta({ [INTESTAZIONE_TOKEN_RINNOVO]: 'qualcosa' })],
    ['senza il prefisso', () => richiesta({ [INTESTAZIONE_TOKEN_RINNOVO]: token.slice(4) })],
    ['un carattere in meno', () => richiesta({ [INTESTAZIONE_TOKEN_RINNOVO]: token.slice(0, -1) })],
    ['un carattere in più', () => richiesta({ [INTESTAZIONE_TOKEN_RINNOVO]: `${token}x` })],
    ['il token nell’URL e non nell’intestazione', () => richiesta({}, `http://test/api/video-uploads/rinnovo?token=${token}`)],
  ]

  it('il corpo e lo stato di ogni caso sono quelli di un token SCONOSCIUTO ben formato, al carattere', async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, code: 'TOKEN_NON_VALIDO' }, error: null })
    const sconosciuto = await POST(conToken(token))
    const riferimento = { status: sconosciuto.status, corpo: await sconosciuto.json() }
    expect(riferimento.status).toBe(404)
    expect(riferimento.corpo).toEqual({ error: expect.any(String), codice: 'VIDEO_NON_TROVATO' })

    for (const [nome, costruisci] of casi) {
      h.rpc.mockClear()
      const res = await POST(costruisci() as never)
      expect({ nome, status: res.status, corpo: await res.json() }, nome).toEqual({ nome, ...riferimento })
    }
  })

  it('un token assente o malformato NON arriva al database e non consuma il tetto per token', async () => {
    for (const [, costruisci] of casi) await POST(costruisci() as never)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    // Il solo tetto toccato è quello per indirizzo, una volta per richiesta: l'impronta di un valore sbagliato non è una chiave.
    const chiavi = h.rateLimit.mock.calls.map(([k]) => String(k))
    expect(chiavi.every((k) => k.startsWith('video-rinnovo-ip:'))).toBe(true)
    expect(chiavi).toHaveLength(casi.length)
  })

  it('un 404 lascia un `warn` col MOTIVO come enumerato (assente, malformato, non valido) — mai il valore', async () => {
    await POST(richiesta())
    await POST(richiesta({ [INTESTAZIONE_TOKEN_RINNOVO]: 'qualcosa' }))
    h.rpc.mockResolvedValue({ data: { ok: false, code: 'TOKEN_NON_VALIDO' }, error: null })
    await POST(conToken(token))
    const negati = eventi().filter((c) => c[2]?.esito === 'rinnovo-negato')
    expect(negati.map((c) => c[2].tipo)).toEqual(['token-assente', 'token-malformato', 'token-non-valido'])
    for (const n of negati) expect(n[1]).toBe('warn')
    expect(JSON.stringify(negati)).not.toContain('qualcosa')
    expect(JSON.stringify(negati)).not.toContain(token)
  })
})

describe('POST /api/video-uploads/rinnovo — i due tetti', () => {
  it('prima quello per INDIRIZZO (30/10 min), poi quello per IMPRONTA del token (20/10 min): le chiavi, i numeri, l’ordine', async () => {
    await POST(conToken(token))
    expect(h.rateLimit.mock.calls).toEqual([
      ['video-rinnovo-ip:203.0.113.9', { limit: TETTO_RINNOVO_PER_IP, windowMs: FINESTRA_TETTO_RINNOVO_MS }],
      [`video-rinnovo-token:${hashEsadecimale}`, { limit: TETTO_RINNOVO_PER_TOKEN, windowMs: FINESTRA_TETTO_RINNOVO_MS }],
    ])
    expect(TETTO_RINNOVO_PER_IP).toBe(30)
    expect(TETTO_RINNOVO_PER_TOKEN).toBe(20)
    expect(FINESTRA_TETTO_RINNOVO_MS).toBe(600_000)
    // La chiave del tetto porta l'impronta, mai il token.
    expect(JSON.stringify(h.rateLimit.mock.calls)).not.toContain(token)
  })

  it('tetto per INDIRIZZO superato ⇒ 429 con `Retry-After`, e il token non viene nemmeno guardato', async () => {
    h.rateLimit.mockResolvedValueOnce({ ok: false, remaining: 0, retryAfterMs: 90_000 })
    const res = await POST(conToken(token))
    expect(res.status).toBe(429)
    expect((await res.json()).codice).toBe('TROPPE_RICHIESTE')
    expect(res.headers.get('Retry-After')).toBe('90')
    expect(h.rateLimit).toHaveBeenCalledTimes(1)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(eventi().find((c) => c[2]?.esito === 'rinnovo-negato')?.[2]).toMatchObject({ tipo: 'tetto-per-ip' })
  })

  it('il `Retry-After` è almeno un secondo; se il tetto non sa dire quanto aspettare (valore non finito) si ripiega su un minuto, mai su NaN', async () => {
    // Il 429 delle porte video è uno solo (`rispostaTroppeRichieste`): un telefono che legge `NaN` o `0` non aspetta
    // niente e ritenta subito, cioè martella proprio la porta che si sta difendendo.
    const casi: [number, string][] = [
      [0, '1'],
      [400, '1'],
      [90_000, '90'],
      [Number.NaN, '60'],
      [Number.POSITIVE_INFINITY, '60'],
    ]
    for (const [retryAfterMs, atteso] of casi) {
      h.rateLimit.mockResolvedValueOnce({ ok: false, remaining: 0, retryAfterMs })
      const res = await POST(conToken(token))
      expect(res.status).toBe(429)
      expect(res.headers.get('Retry-After'), `retryAfterMs ${retryAfterMs}`).toBe(atteso)
    }
  })

  it('tetto per TOKEN superato ⇒ 429, e la RPC non si chiama: si applica a ogni token ben formato, esista o no', async () => {
    h.rateLimit.mockResolvedValueOnce({ ok: true, remaining: 5, retryAfterMs: 0 }).mockResolvedValueOnce({ ok: false, remaining: 0, retryAfterMs: 30_000 })
    const res = await POST(conToken(token))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('30')
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    expect(eventi().find((c) => c[2]?.esito === 'rinnovo-negato')?.[2]).toMatchObject({ tipo: 'tetto-per-token' })
  })
})

describe('POST /api/video-uploads/rinnovo — niente sessione, niente corpo', () => {
  it('NON chiede una sessione: la porta è dell’app che il sistema operativo risveglia', async () => {
    await POST(conToken(token))
    expect(h.requireDocente).not.toHaveBeenCalled()
  })

  it('il corpo non si legge MAI — né json, né testo, né form — nemmeno quando c’è e il token non è valido', async () => {
    await POST(conToken(token))
    await POST(richiesta())
    await POST(richiesta({ [INTESTAZIONE_TOKEN_RINNOVO]: 'sbagliato' }))
    h.rpc.mockResolvedValue({ data: { ok: true, stato: 'arrivato' }, error: null })
    await POST(conToken(token))
    expect(h.corpoLetto).toBe(0)
  })

  it('l’intestazione è quella del contratto, e non conta se scritta con altre maiuscole', async () => {
    const res = await POST(richiesta({ 'X-Kidville-Rinnovo': token }))
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/video-uploads/rinnovo — i guasti: un difetto nostro non diventa mai un URL', () => {
  it('la pipeline non installata ⇒ 503 pulito', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })
    const res = await POST(conToken(token))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('un errore del database ⇒ 500 con il suo codice; il motivo resta nel log e non esce', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })
    const res = await POST(conToken(token))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
    expect(JSON.stringify(corpo)).not.toContain('statement timeout')
    expect(JSON.stringify(h.logErrore.mock.calls)).toContain('statement timeout')
  })

  it('un rifiuto della RPC che NON è `TOKEN_NON_VALIDO` non è un 404: non l’ha causato chi chiama', async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, code: 'BAD_INPUT' }, error: null })
    const res = await POST(conToken(token))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it.each([
    ['un bucket che non è quello degli originali', daCaricare({ bucket: 'video_processing' })],
    ['un percorso vuoto', daCaricare({ percorso: '' })],
    ['un percorso assente', (() => { const d = daCaricare(); delete (d as Record<string, unknown>).percorso; return d })()],
    ['una scadenza che non è una data', daCaricare({ scade_il: 'domani' })],
    ['un job che non è un identificativo', daCaricare({ job_id: 'non-un-uuid' })],
    ['uno stato che la RPC non promette', { ok: true, stato: 'boh' }],
    ['un esito vuoto', {}],
  ])('%s ⇒ 500, nessuna firma coniata, e il log dice QUALI campi non tornano (mai i valori)', async (_nome, esito) => {
    h.rpc.mockResolvedValue({ data: esito, error: null })
    const res = await POST(conToken(token))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    const errore = h.logErrore.mock.calls[0]?.[1]
    expect(errore).toBeInstanceOf(Error)
    expect((errore as Error).message).toMatch(/video_rinnovo_usa: esito fuori forma/)
    expect((errore as Error).message).not.toContain('video_processing')
    expect((errore as Error).message).not.toContain('domani')
  })

  it('la firma non riuscita ⇒ 500 con codice; il token NON si consuma né si revoca (il client può riprovare)', async () => {
    h.createSignedUploadUrl.mockResolvedValue({ data: null, error: { message: 'storage non raggiungibile' } })
    const res = await POST(conToken(token))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('storage non raggiungibile')
    expect(JSON.stringify(h.logErrore.mock.calls)).toContain('storage non raggiungibile')
    // La route non ha un'altra RPC con cui toccare il token: la sola è `video_rinnovo_usa`.
    expect(h.rpc.mock.calls.map(([n]) => n)).toEqual(['video_rinnovo_usa'])
    expect(eventi().some((c) => c[2]?.esito === 'rinnovo-emesso')).toBe(false)
  })

  it('un’eccezione dentro la route ⇒ 500 col suo codice, e il log non porta il token', async () => {
    h.eccezione = new Error('connessione interrotta')
    const res = await POST(conToken(token))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
    expect(JSON.stringify([h.logEvento.mock.calls, h.logErrore.mock.calls.map(([d, e]) => [d, String(e)])])).not.toContain(token)
  })
})

/**
 * IL TOKEN NON ENTRA MAI IN UN LOG — con il logger VERO.
 *
 * Sotto `VITEST` il logger è muto: i test qui sopra vedono CHI viene chiamato e con quali campi, ma non ciò
 * che il logger scriverebbe davvero, dopo la redazione, su console e in `app_log`. E la redazione NON basta
 * a garantire questa proprietà: `redact` lascia passare in chiaro ogni valore che abbia la forma di un
 * enumerato sotto una chiave in lista bianca, e un token — 47 caratteri senza spazi, alfabeto base64url —
 * HA quella forma. La sola difesa è non passarlo mai: qui si prova che nessun ramo lo faccia.
 *
 * Il modulo si ricarica con `VITEST` non definita (l'unico modo di osservare ciò che il logger scrive
 * davvero) e `app-log` mockato: senza il mock, la persistenza scriverebbe sul database di PRODUZIONE
 * (`.env.local` punta lì).
 */
describe('POST /api/video-uploads/rinnovo — il token e il suo hash non compaiono in NESSUN log (logger vero)', () => {
  let log: ReturnType<typeof vi.spyOn>
  let err: ReturnType<typeof vi.spyOn>
  const righeAppLog: unknown[] = []

  beforeEach(() => {
    righeAppLog.length = 0
    vi.stubEnv('VITEST', '')
    vi.stubEnv('KV_LOG_LEVEL', '')
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    err = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.doUnmock('@/lib/logging/app-log')
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  /** La route, ricaricata dallo STESSO registro del logger vero e di un `app-log` che registra invece di scrivere. */
  async function caricaRottaConLoggerVero() {
    vi.resetModules()
    vi.doUnmock('@/lib/logging/logger')
    vi.doMock('@/lib/logging/app-log', () => ({ appLog: async (riga: unknown) => void righeAppLog.push(riga) }))
    return (await import('@/app/api/video-uploads/rinnovo/route')).POST
  }

  /** Tutto ciò che il logger ha scritto, in ogni canale, come un testo solo: righe, errori nativi con stack, righe di tabella. */
  const tuttoCioCheESceDalLogger = () => {
    const console_ = [...log.mock.calls, ...err.mock.calls].flat().map((a: unknown) => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack}` : String(a)))
    return JSON.stringify([console_, righeAppLog])
  }

  /** Le forme in cui il token o il suo hash potrebbero comparire. */
  const vietati = () => {
    const hashBuffer = createHash('sha256').update(token).digest()
    return {
      'il token intero': token,
      'il corpo del token': token.slice(4),
      'un frammento del token': token.slice(10, 22),
      'l’hash in esadecimale': hashEsadecimale,
      'l’hash come bytea': `\\x${hashEsadecimale}`,
      'l’hash come bytea (escape JSON)': `\\\\x${hashEsadecimale}`,
      'l’hash in base64': hashBuffer.toString('base64'),
      'l’hash in base64url': hashBuffer.toString('base64url'),
      'un frammento dell’hash': hashEsadecimale.slice(8, 24),
      'l’URL firmato': 'segreto-di-firma',
      'il percorso dell’originale': '0123456789abcdef',
    }
  }

  const scenari: [string, () => void, number][] = [
    ['da-caricare (URL emesso)', () => h.rpc.mockResolvedValue({ data: daCaricare(), error: null }), 200],
    ['arrivato', () => h.rpc.mockResolvedValue({ data: { ok: true, stato: 'arrivato' }, error: null }), 200],
    ['annullato', () => h.rpc.mockResolvedValue({ data: { ok: true, stato: 'annullato' }, error: null }), 200],
    ['token sconosciuto o scaduto (404)', () => h.rpc.mockResolvedValue({ data: { ok: false, code: 'TOKEN_NON_VALIDO' }, error: null }), 404],
    ['tetto per indirizzo (429)', () => h.rateLimit.mockResolvedValueOnce({ ok: false, remaining: 0, retryAfterMs: 1000 }), 429],
    [
      'tetto per token (429)',
      () => h.rateLimit.mockResolvedValueOnce({ ok: true, remaining: 1, retryAfterMs: 0 }).mockResolvedValueOnce({ ok: false, remaining: 0, retryAfterMs: 1000 }),
      429,
    ],
    ['errore del database (500)', () => h.rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'statement timeout' } }), 500],
    ['pipeline non installata (503)', () => h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'x' } }), 503],
    ['rifiuto inatteso della RPC (500)', () => h.rpc.mockResolvedValue({ data: { ok: false, code: 'BAD_INPUT' }, error: null }), 500],
    ['esito fuori forma (500)', () => h.rpc.mockResolvedValue({ data: daCaricare({ bucket: 'altro' }), error: null }), 500],
    ['firma non riuscita (500)', () => h.createSignedUploadUrl.mockResolvedValue({ data: null, error: { message: 'storage giù' } }), 500],
    ['eccezione (500)', () => (h.eccezione = new Error('boom')), 500],
  ]

  it.each(scenari)('%s: né il token né l’hash escono dal logger', async (_nome, prepara, stato) => {
    const POST_VERO = await caricaRottaConLoggerVero()
    prepara()
    const res = await POST_VERO(conToken(token))
    expect(res.status).toBe(stato)
    // Il logger vero HA scritto qualcosa (se fosse ancora muto il test passerebbe sul vuoto): `withRoute` logga ogni esito.
    const uscita = tuttoCioCheESceDalLogger()
    expect(uscita.length, 'il logger non ha scritto niente: la prova sarebbe verde sul vuoto').toBeGreaterThan(40)
    for (const [cosa, valore] of Object.entries(vietati())) {
      expect(uscita, `${cosa} compare nel log`).not.toContain(valore)
    }
  })

  it('il controllo positivo: lo STESSO scenario con il token messo a mano in un campo di log VIENE visto', async () => {
    // Senza questa riga, tutta la sezione sarebbe verde anche se il rilevatore non vedesse mai niente: qui si
    // dimostra che, se un ramo passasse il token a un log sotto una chiave in lista bianca, `tuttoCioCheESceDalLogger`
    // lo troverebbe — ed è esattamente il caso che la forma di un token rende possibile.
    const { logEvento } = await (async () => {
      vi.resetModules()
      vi.doUnmock('@/lib/logging/logger')
      vi.doMock('@/lib/logging/app-log', () => ({ appLog: async (riga: unknown) => void righeAppLog.push(riga) }))
      return import('@/lib/logging/logger')
    })()
    logEvento('galleria', 'warn', { operazione: 'prova', esito: 'prova', tipo: token })
    expect(tuttoCioCheESceDalLogger()).toContain(token)
  })
})
