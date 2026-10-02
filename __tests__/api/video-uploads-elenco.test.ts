import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

import { schemaRispostaElencoVideo } from '@/lib/media/video/contratto'

/**
 * `GET /api/video-uploads?canale=gallery[&scuolaId=…]` — l'ELENCO dei MIEI video.
 *
 * Dal 2026-10-02 il video esce da solo, anche a pagina chiusa: chi lo ha caricato deve poter vedere dove
 * sta, da qualunque dispositivo. L'elenco è la fonte di quella schermata, e sbaglia in silenzio: una fase
 * detta male è un video «in coda» che non uscirà mai, un «Riprova» offerto quando non può funzionare, o —
 * peggio — il video di una collega, o un elenco di bambini, che finisce nella risposta sbagliata.
 *
 * ─── COSA SI PROVA ───────────────────────────────────────────────────────────
 * 1. **L'isolamento**, contro dati veri: un finto PostgREST che APPLICA i filtri (`eq`, `in`, `or`, ordine,
 *    `limit`) alle righe di più proprietari e più sedi. Un finto che restituisse sempre tutto sarebbe verde
 *    anche senza il filtro di proprietà: il difetto è proprio quello.
 * 2. **Che cosa esce**: la voce è costruita a mano. Le righe del finto portano `tag_alunni`, l'hash del
 *    token, lo `sha256` e il percorso dell'originale — e il finto PROIETTA sulle colonne chieste, come fa
 *    PostgREST, quindi se la route le chiedesse ne vedrebbe i valori; il test cerca poi quei valori nel
 *    corpo.
 * 3. **Le fasi**, tutte e dieci, e le condizioni del «Riprova» una per una.
 */

type Riga = Record<string, unknown>
type Query = {
  colonne: string
  eq: [string, unknown][]
  in: [string, unknown[]][]
  or: string[]
  ordine: { colonna: string; crescente: boolean } | null
  limite: number | null
}

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  scuoleDiUtente: vi.fn(),
  rateLimit: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  righe: { video_intents: [] as Riga[], video_jobs: [] as Riga[] },
  errori: {} as Record<string, { code?: string; message?: string } | null>,
  /** L'ULTIMA query fatta a ogni tabella: serve a leggere ciò che la route ha chiesto. */
  query: {} as Record<string, Query>,
  tabelleLette: [] as string[],
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

/** Divide una condizione di `.or()` sulle virgole di PRIMO livello (dentro `in.(a,b)` le virgole sono dei valori). */
function condizioniOr(espressione: string): string[] {
  const out: string[] = []
  let livello = 0
  let corrente = ''
  for (const c of espressione) {
    if (c === '(') livello++
    if (c === ')') livello--
    if (c === ',' && livello === 0) {
      out.push(corrente)
      corrente = ''
    } else corrente += c
  }
  out.push(corrente)
  return out
}

/** Valuta le due forme di `.or()` che la route usa: `colonna.in.(a,b,c)` e `colonna.gte.<iso>`. */
function soddisfaOr(riga: Riga, espressione: string): boolean {
  return condizioniOr(espressione).some((condizione) => {
    const m = /^([a-z_]+)\.(in|gte)\.(.+)$/.exec(condizione)
    if (!m) throw new Error(`forma di .or() non prevista dal finto: ${condizione}`)
    const [, colonna, operatore, valore] = m
    if (operatore === 'in') {
      const elenco = valore.replace(/^\(|\)$/g, '').split(',')
      return elenco.includes(String(riga[colonna]))
    }
    return Date.parse(String(riga[colonna])) >= Date.parse(valore)
  })
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(nome: string) {
      h.tabelleLette.push(nome)
      const q: Query = { colonne: '', eq: [], in: [], or: [], ordine: null, limite: null }
      h.query[nome] = q
      const risolvi = () => {
        const errore = h.errori[nome] ?? null
        if (errore) return { data: null, error: errore }
        let righe = ((h.righe as Record<string, Riga[]>)[nome] ?? []).filter(
          (r) =>
            q.eq.every(([c, v]) => r[c] === v) &&
            q.in.every(([c, vs]) => vs.includes(r[c])) &&
            q.or.every((e) => soddisfaOr(r, e)),
        )
        if (q.ordine) {
          const { colonna, crescente } = q.ordine
          righe = [...righe].sort((a, b) => (Date.parse(String(a[colonna])) - Date.parse(String(b[colonna]))) * (crescente ? 1 : -1))
        }
        if (q.limite !== null) righe = righe.slice(0, q.limite)
        // Come PostgREST: SOLO le colonne chieste.
        const scelte = q.colonne.split(',').map((c) => c.trim())
        return {
          data: righe.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => scelte.includes(k)))),
          error: null,
        }
      }
      const catena: Record<string, unknown> = {
        select: (colonne: string) => {
          q.colonne = colonne
          return catena
        },
        eq: (c: string, v: unknown) => {
          q.eq.push([c, v])
          return catena
        },
        in: (c: string, vs: unknown[]) => {
          q.in.push([c, vs])
          return catena
        },
        or: (e: string) => {
          q.or.push(e)
          return catena
        },
        order: (colonna: string, opzioni?: { ascending?: boolean }) => {
          q.ordine = { colonna, crescente: opzioni?.ascending !== false }
          return catena
        },
        limit: (n: number) => {
          q.limite = n
          return catena
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(risolvi()).then(res, rej),
      }
      return catena
    },
  }),
}))

import { GET } from '@/app/api/video-uploads/route'

const SEDE = '10000000-0000-4000-8000-000000000001'
const SEDE_B = '10000000-0000-4000-8000-0000000000bb'
const DOCENTE = '20000000-0000-4000-8000-000000000002'
const COLLEGA = '20000000-0000-4000-8000-0000000000cc'
const MEDIA = '50000000-0000-4000-8000-000000000005'

/** Un valore RISERVATO che le righe del finto portano e che NON deve uscire in nessuna forma. */
const SEGRETI = {
  tag: 'dddddddd-1111-4111-8111-1111111111dd',
  hash: '\\xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  sha: '\\xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface',
  percorso: `${DOCENTE}/0123456789abcdef0123456789abcdef.mov`,
}

/** Un istante di `giorni` giorni (e `ore` ore) FA: le date sono relative, mai cablate. */
const fa = (giorni: number, ore = 0) => new Date(Date.now() - (giorni * 24 + ore) * 3_600_000).toISOString()

let contatore = 0
const uuid = (prefisso: string) => `${prefisso}${String(++contatore).padStart(7, '0')}-0000-4000-8000-000000000000`.slice(0, 36)

/** Un intento di Galleria con la sua riga di job, come li lascia il database: con tutti i campi RISERVATI. */
function video(opzioni: {
  intento?: Riga
  job?: Riga
  owner?: string
  sede?: string
}): { intento: Riga; job: Riga } {
  const id = uuid('a')
  const jobId = uuid('b')
  const owner = opzioni.owner ?? DOCENTE
  const sede = opzioni.sede ?? SEDE
  const aggiornato = (opzioni.intento?.updated_at as string | undefined) ?? fa(0, 1)
  const intento: Riga = {
    id,
    owner_id: owner,
    scuola_id: sede,
    channel: 'gallery',
    revision: 1,
    status: 'confirmed',
    created_at: fa(0, 2),
    updated_at: aggiornato,
    target_id: null,
    pubblicazione_automatica: true,
    broadcast: false,
    n_tag: 2,
    trasporto: 'tus',
    pubblicazione_errore: null,
    minimizzato_il: null,
    requested_action: 'publish',
    // ⚠️ Riservati: la route non deve mai chiederli.
    tag_alunni: [SEGRETI.tag],
    esito_notificato: null,
    ...opzioni.intento,
  }
  const job: Riga = {
    id: jobId,
    intent_id: id,
    owner_id: owner,
    scuola_id: sede,
    channel: 'gallery',
    status: 'queued',
    error_code: null,
    attempt: 0,
    created_at: fa(0, 2),
    updated_at: aggiornato,
    byte_dichiarati: 812_345_678,
    durata_dichiarata_s: 96.5,
    verified_at: null,
    output_path: null,
    output_deleted_at: null,
    output_delete_after: null,
    original_path: SEGRETI.percorso,
    rinnovo_token_hash: SEGRETI.hash,
    sha256_dichiarato: SEGRETI.sha,
    ...opzioni.job,
  }
  return { intento, job }
}

/** Mette un video nel finto database e restituisce l'id del suo intento. */
function aggiungi(opzioni: Parameters<typeof video>[0]): { intento: string; job: string } {
  const v = video(opzioni)
  h.righe.video_intents.push(v.intento)
  h.righe.video_jobs.push(v.job)
  return { intento: v.intento.id as string, job: v.job.id as string }
}

const richiesta = (query = 'canale=gallery') =>
  ({
    url: `http://test/api/video-uploads?${query}`,
    method: 'GET',
    headers: new Headers(),
    cookies: { get: () => undefined },
  }) as never

const leggi = async (query = 'canale=gallery') => {
  const res = await GET(richiesta(query))
  return { res, corpo: await res.json() }
}

const eventi = () => h.logEvento.mock.calls.filter((c) => c[0] === 'galleria')

beforeEach(() => {
  vi.clearAllMocks()
  contatore = 0
  h.righe = { video_intents: [], video_jobs: [] }
  h.errori = {}
  h.query = {}
  h.tabelleLette = []
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE } })
  h.scuoleDiUtente.mockResolvedValue([SEDE])
  h.rateLimit.mockResolvedValue({ ok: true, remaining: 100, retryAfterMs: 0 })
})

describe('GET /api/video-uploads — i cancelli', () => {
  it('il gate viene PRIMA di tutto: negato ⇒ nessuna lettura, nessun tetto consumato', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    const res = await GET(richiesta())
    expect(res.status).toBe(401)
    expect(h.tabelleLette).toEqual([])
    expect(h.rateLimit).not.toHaveBeenCalled()
  })

  it('il tetto è 120 ogni 10 minuti PER UTENTE, e il 429 dice quanto aspettare', async () => {
    await leggi()
    expect(h.rateLimit).toHaveBeenCalledWith(`video-uploads-elenco:${DOCENTE}`, { limit: 120, windowMs: 600_000 })
    h.rateLimit.mockResolvedValue({ ok: false, remaining: 0, retryAfterMs: 42_000 })
    const res = await GET(richiesta())
    expect(res.status).toBe(429)
    expect((await res.json()).codice).toBe('TROPPE_RICHIESTE')
    expect(res.headers.get('Retry-After')).toBe('42')
  })

  it('il canale è obbligatorio e l’elenco esiste solo per la Galleria: 400 prima di leggere niente', async () => {
    for (const query of ['', 'canale=news', 'canale=altro', 'canale=gallery&scuolaId=non-un-uuid']) {
      h.tabelleLette = []
      const res = await GET(richiesta(query))
      expect(res.status, query).toBe(400)
      expect(h.tabelleLette, query).toEqual([])
    }
  })

  it('senza nessuna sede propria l’elenco è VUOTO e non legge niente (mai «tutto»)', async () => {
    h.scuoleDiUtente.mockResolvedValue([])
    aggiungi({})
    const { res, corpo } = await leggi()
    expect(res.status).toBe(200)
    expect(corpo).toEqual({ voci: [] })
    expect(h.tabelleLette).toEqual([])
  })
})

describe('GET /api/video-uploads — l’isolamento: PROPRIETARIO e SEDE, dentro ogni query', () => {
  it('di tutti i video del finto database escono SOLO i miei, nelle mie sedi', async () => {
    const mio = aggiungi({})
    aggiungi({ owner: COLLEGA }) // di una collega, nella MIA sede
    aggiungi({ sede: SEDE_B }) // mio, ma in una sede che non è fra le mie
    aggiungi({ owner: COLLEGA, sede: SEDE_B })
    const { res, corpo } = await leggi()
    expect(res.status).toBe(200)
    expect(corpo.voci.map((v: { intentId: string }) => v.intentId)).toEqual([mio.intento])
  })

  it('il filtro sta nella QUERY, su tutte e due le tabelle: proprietà e sede, non un confronto dopo', async () => {
    aggiungi({})
    await leggi()
    for (const tabella of ['video_intents', 'video_jobs']) {
      const q = h.query[tabella]
      expect(q.eq, tabella).toContainEqual(['owner_id', DOCENTE])
      expect(q.in, tabella).toContainEqual(['scuola_id', [SEDE]])
    }
    expect(h.query.video_intents.eq).toContainEqual(['channel', 'gallery'])
  })

  it('un admin con più sedi le vede tutte, e solo i SUOI video', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'admin', scuola_id: SEDE } })
    h.scuoleDiUtente.mockResolvedValue([SEDE, SEDE_B])
    const a = aggiungi({})
    const b = aggiungi({ sede: SEDE_B })
    aggiungi({ owner: COLLEGA, sede: SEDE_B })
    const { corpo } = await leggi()
    expect(corpo.voci.map((v: { intentId: string }) => v.intentId).sort()).toEqual([a.intento, b.intento].sort())
    expect(h.query.video_intents.in).toContainEqual(['scuola_id', [SEDE, SEDE_B]])
  })

  it('`scuolaId` fra le proprie restringe a quella sede (anche con le maiuscole)', async () => {
    h.scuoleDiUtente.mockResolvedValue([SEDE, SEDE_B])
    aggiungi({})
    const b = aggiungi({ sede: SEDE_B })
    const { res, corpo } = await leggi(`canale=gallery&scuolaId=${SEDE_B.toUpperCase()}`)
    expect(res.status).toBe(200)
    expect(corpo.voci.map((v: { intentId: string }) => v.intentId)).toEqual([b.intento])
    expect(h.query.video_intents.in).toContainEqual(['scuola_id', [SEDE_B]])
  })

  it('`scuolaId` che NON è fra le proprie ⇒ 403 `VIDEO_NON_AUTORIZZATO`, nessuna lettura, e un `warn` con solo uuid', async () => {
    aggiungi({ sede: SEDE_B })
    const { res, corpo } = await leggi(`canale=gallery&scuolaId=${SEDE_B}`)
    expect(res.status).toBe(403)
    expect(corpo.codice).toBe('VIDEO_NON_AUTORIZZATO')
    expect(h.tabelleLette).toEqual([])
    const ev = eventi().filter((c) => c[2]?.esito === 'elenco-fuori-sede')
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('warn')
    expect(ev[0][2]).toMatchObject({ utente: DOCENTE, sede_richiesta: SEDE_B, accessibili: 1 })
  })
})

describe('GET /api/video-uploads — la finestra, il tetto e l’ordine', () => {
  it('i non terminali restano SEMPRE, qualunque età; i terminali solo per sette giorni', async () => {
    const vecchioAttivo = aggiungi({ intento: { status: 'confirmed', updated_at: fa(30) }, job: { status: 'processing', attempt: 1 } })
    const vecchioAzione = aggiungi({ intento: { status: 'action_required', updated_at: fa(20), pubblicazione_errore: 'PUBBLICAZIONE_NON_RIUSCITA' } })
    const recenteTerminale = aggiungi({ intento: { status: 'published', updated_at: fa(6), target_id: MEDIA } })
    aggiungi({ intento: { status: 'published', updated_at: fa(8), target_id: MEDIA } }) // 8 giorni: fuori
    aggiungi({ intento: { status: 'cancelled', updated_at: fa(9) }, job: { status: 'cancelled' } }) // fuori
    const { corpo } = await leggi()
    const ids = corpo.voci.map((v: { intentId: string }) => v.intentId)
    expect(ids).toHaveLength(3)
    expect(ids).toEqual(expect.arrayContaining([vecchioAttivo.intento, vecchioAzione.intento, recenteTerminale.intento]))
  })

  it('la query chiede gli intenti per `updated_at` decrescente, con il suo tetto di 50', async () => {
    aggiungi({})
    await leggi()
    expect(h.query.video_intents.ordine).toEqual({ colonna: 'updated_at', crescente: false })
    expect(h.query.video_intents.limite).toBe(50)
    // E la `.or()` nomina i tre stati non terminali e la soglia dei sette giorni, senza millisecondi.
    expect(h.query.video_intents.or).toHaveLength(1)
    expect(h.query.video_intents.or[0]).toMatch(/^status\.in\.\(pending,confirmed,action_required\),updated_at\.gte\.\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('al massimo 50 voci, le più recenti, e la risposta rispetta il contratto', async () => {
    for (let i = 0; i < 60; i++) aggiungi({ intento: { updated_at: fa(0, i + 1) } })
    const { res, corpo } = await leggi()
    expect(res.status).toBe(200)
    expect(corpo.voci).toHaveLength(50)
    const letta = schemaRispostaElencoVideo.safeParse(corpo)
    expect(letta.success, JSON.stringify(letta.error?.issues ?? [])).toBe(true)
    // Le più recenti: la prima è quella di un'ora fa, l'ultima quella di cinquanta.
    const orari = corpo.voci.map((v: { aggiornatoIl: string }) => Date.parse(v.aggiornatoIl))
    expect(orari).toEqual([...orari].sort((a, b) => b - a))
    expect(Date.now() - orari[0]).toBeLessThan(2 * 3_600_000)
  })

  it('l’ordine è per l’ultimo cambiamento fra l’intento E il suo job: un job che avanza non tocca l’intento', async () => {
    const vecchio = aggiungi({ intento: { updated_at: fa(0, 5) } })
    const avanzato = aggiungi({ intento: { updated_at: fa(0, 6) }, job: { status: 'processing', attempt: 1, updated_at: fa(0, 0) } })
    const { corpo } = await leggi()
    expect(corpo.voci.map((v: { intentId: string }) => v.intentId)).toEqual([avanzato.intento, vecchio.intento])
  })
})

describe('GET /api/video-uploads — le fasi di una voce', () => {
  /** Mette UN video e ne restituisce la voce. */
  const voce = async (opzioni: Parameters<typeof video>[0]) => {
    h.righe = { video_intents: [], video_jobs: [] }
    aggiungi(opzioni)
    const { res, corpo } = await leggi()
    expect(res.status).toBe(200)
    expect(corpo.voci).toHaveLength(1)
    return corpo.voci[0] as Record<string, unknown>
  }

  it.each([
    ['da-caricare', { intento: { status: 'confirmed' }, job: { status: 'awaiting_upload', attempt: 0 } }, null],
    ['in-coda', { intento: { status: 'confirmed' }, job: { status: 'queued', attempt: 0 } }, null],
    ['in-conversione', { intento: { status: 'confirmed' }, job: { status: 'processing', attempt: 1 } }, null],
    // «Lo stiamo riprovando»: rimesso in coda dopo un guasto nostro, o un ritentativo già ripartito.
    ['in-riprova', { intento: { status: 'confirmed' }, job: { status: 'queued', attempt: 1 } }, null],
    ['in-riprova', { intento: { status: 'confirmed' }, job: { status: 'processing', attempt: 2 } }, null],
    ['pronto', { intento: { status: 'confirmed' }, job: { status: 'ready', attempt: 1, verified_at: fa(0, 1), output_path: 'x/y.mp4' } }, null],
    ['annullato', { intento: { status: 'cancelled' }, job: { status: 'cancelled' } }, null],
    ['annullato', { intento: { status: 'superseded' }, job: { status: 'cancelled' } }, null],
    ['annullato', { intento: { status: 'confirmed' }, job: { status: 'cancelled' } }, null],
    // Lo stato dell'INTENTO vince su quello del job: un ritiro o una sostituzione non lasciano una scheda «in coda» o
    // «pronta» solo perché il job non è ancora stato spento (due righe lette in momenti diversi, o uno stato incoerente).
    ['annullato', { intento: { status: 'cancelled' }, job: { status: 'queued', attempt: 0 } }, null],
    ['annullato', { intento: { status: 'superseded' }, job: { status: 'ready', verified_at: fa(0, 1), output_path: 'x/y.mp4' } }, null],
  ] as const)('%s', async (fase, opzioni, codice) => {
    const v = await voce(opzioni as Parameters<typeof video>[0])
    expect(v.fase).toBe(fase)
    expect(v.codice).toBe(codice)
    expect(v.mediaId).toBeNull()
    expect(v.riprovaPossibile).toBe(false)
  })

  it('pubblicato: il suo elemento di galleria (`target_id`), e solo lì', async () => {
    const v = await voce({ intento: { status: 'published', target_id: MEDIA }, job: { status: 'ready' } })
    expect(v).toMatchObject({ fase: 'pubblicato', codice: null, mediaId: MEDIA, riprovaPossibile: false })
    // Un pubblicato il cui elemento è stato tolto resta pubblicato, senza il collegamento.
    const senza = await voce({ intento: { status: 'published', target_id: null }, job: { status: 'ready' } })
    expect(senza).toMatchObject({ fase: 'pubblicato', mediaId: null })
    // E «solo lì»: un `target_id` su un intento che NON è pubblicato (uno stato incoerente) non trasforma una
    // scheda in corso in un video già in galleria.
    const incoerente = await voce({ intento: { status: 'confirmed', target_id: MEDIA }, job: { status: 'queued' } })
    expect(incoerente).toMatchObject({ fase: 'in-coda', mediaId: null })
  })

  it.each([
    ['conversione non riuscita (file)', { status: 'failed', attempt: 1, error_code: 'ENCODE_FAILED' }, 'VIDEO_CONVERSIONE_NON_RIUSCITA'],
    ['rifiutato (file)', { status: 'rejected', attempt: 1, error_code: 'UNSUPPORTED_CONTAINER' }, 'VIDEO_FORMATO_NON_SUPPORTATO'],
    ['rifiutato ritentato (file)', { status: 'rejected', attempt: 3, error_code: 'UNSUPPORTED_CONTAINER' }, 'VIDEO_FORMATO_NON_SUPPORTATO'],
    ['originale diverso', { status: 'rejected', attempt: 1, error_code: 'ORIGINALE_DIVERSO' }, 'VIDEO_ORIGINALE_NON_COINCIDE'],
    // La regola #37: un job ritentato ed esaurito legge «problema nostro» qualunque fosse l'ultimo codice.
    ['ritentato ed esaurito, ultimo codice del file', { status: 'failed', attempt: 4, error_code: 'ENCODE_FAILED' }, 'VIDEO_GUASTO_NOSTRO'],
    ['ritentato ed esaurito, ultimo codice di sonda', { status: 'failed', attempt: 3, error_code: 'PROBE_COMMAND_FAILED' }, 'VIDEO_GUASTO_NOSTRO'],
    ['guasto nostro al primo giro', { status: 'failed', attempt: 1, error_code: 'OUTPUT_UPLOAD_FAILED' }, 'VIDEO_GUASTO_NOSTRO'],
    ['senza codice', { status: 'failed', attempt: 1, error_code: null }, 'VIDEO_OPERAZIONE_NON_RIUSCITA'],
  ])('fallito — %s ⇒ %s, mai il codice tecnico', async (_nome, job, atteso) => {
    const v = await voce({ intento: { status: 'confirmed' }, job })
    expect(v).toMatchObject({ fase: 'fallito', codice: atteso, riprovaPossibile: false })
    if (typeof job.error_code === 'string') expect(JSON.stringify(v)).not.toContain(job.error_code)
  })

  it.each([
    ['PUBBLICAZIONE_NON_RIUSCITA', 'VIDEO_PUBBLICAZIONE_NON_RIUSCITA'],
    ['NESSUN_DESTINATARIO', 'VIDEO_NESSUN_DESTINATARIO'],
    [null, 'VIDEO_OPERAZIONE_NON_RIUSCITA'],
  ])('non-pubblicato — causa %s ⇒ %s', async (errore, codice) => {
    const v = await voce({
      intento: { status: 'action_required', pubblicazione_errore: errore },
      job: { status: 'ready', verified_at: fa(1), output_path: 'x/y.mp4' },
    })
    expect(v).toMatchObject({ fase: 'non-pubblicato', codice, mediaId: null })
  })

  describe('il «Riprova», una condizione per volta', () => {
    /** Un video non pubblicato per cui il «Riprova» È possibile; ogni caso ne rompe UNA condizione. */
    const base = () => ({
      intento: { status: 'action_required', pubblicazione_errore: 'PUBBLICAZIONE_NON_RIUSCITA' } as Riga,
      job: { status: 'ready', attempt: 1, verified_at: fa(1), output_path: 'x/y.mp4', output_deleted_at: null, output_delete_after: null } as Riga,
    })

    it('possibile quando tutto c’è', async () => {
      expect((await voce(base())).riprovaPossibile).toBe(true)
      // Anche con una scadenza dell'uscita ancora nel futuro.
      const b = base()
      b.job.output_delete_after = new Date(Date.now() + 3_600_000).toISOString()
      expect((await voce(b)).riprovaPossibile).toBe(true)
    })

    it.each([
      ['l’intento è del flusso vecchio', (b: ReturnType<typeof base>) => (b.intento.pubblicazione_automatica = false)],
      ['i bambini sono stati minimizzati (non si saprebbe a chi pubblicare)', (b: ReturnType<typeof base>) => (b.intento.minimizzato_il = fa(1))],
      ['nessun bambino è più nella sede: riprovare darebbe lo stesso rifiuto', (b: ReturnType<typeof base>) => (b.intento.pubblicazione_errore = 'NESSUN_DESTINATARIO')],
      ['il job non è pronto', (b: ReturnType<typeof base>) => (b.job.status = 'failed')],
      ['il job non è mai stato verificato', (b: ReturnType<typeof base>) => (b.job.verified_at = null)],
      ['l’uscita non c’è', (b: ReturnType<typeof base>) => (b.job.output_path = null)],
      ['l’uscita è già stata tolta', (b: ReturnType<typeof base>) => (b.job.output_deleted_at = fa(0, 1))],
      ['sono passati più di sette giorni dalla verifica', (b: ReturnType<typeof base>) => (b.job.verified_at = fa(8))],
      ['la scadenza dell’uscita è passata', (b: ReturnType<typeof base>) => (b.job.output_delete_after = fa(0, 1))],
    ])('non possibile se %s', async (_perche, rompi) => {
      const b = base()
      rompi(b)
      const v = await voce(b)
      expect(v.riprovaPossibile).toBe(false)
    })

    it('si offre SOLO su un non-pubblicato: un pronto non ha un «Riprova»', async () => {
      const v = await voce({
        intento: { status: 'confirmed' },
        job: { status: 'ready', verified_at: fa(1), output_path: 'x/y.mp4' },
      })
      expect(v).toMatchObject({ fase: 'pronto', riprovaPossibile: false })
    })
  })

  describe('il flusso vecchio: «questo video va ricaricato»', () => {
    it.each([
      ['revocato (cancelled)', { status: 'cancelled' }, { status: 'cancelled' }],
      ['ancora in volo (confirmed, in coda)', { status: 'confirmed' }, { status: 'queued', attempt: 0 }],
      ['convertito e mai pubblicato (confirmed, ready)', { status: 'confirmed' }, { status: 'ready', verified_at: fa(3), output_path: 'x/y.mp4' }],
      ['con una pubblicazione da confermare (action_required)', { status: 'action_required' }, { status: 'ready', verified_at: fa(3), output_path: 'x/y.mp4' }],
      ['mai confermato (pending)', { status: 'pending' }, { status: 'awaiting_upload', attempt: 0 }],
    ])('%s ⇒ da-ricaricare, e non è una pubblicazione automatica', async (_nome, intento, job) => {
      const v = await voce({ intento: { ...intento, pubblicazione_automatica: false, n_tag: 0 }, job })
      expect(v).toMatchObject({ fase: 'da-ricaricare', codice: null, mediaId: null, pubblicazioneAutomatica: false, riprovaPossibile: false })
    })

    it('un video del flusso vecchio GIÀ PUBBLICATO resta pubblicato; uno sostituito è annullato', async () => {
      expect(await voce({ intento: { status: 'published', pubblicazione_automatica: false, target_id: MEDIA }, job: { status: 'ready' } })).toMatchObject({
        fase: 'pubblicato',
        mediaId: MEDIA,
      })
      expect(await voce({ intento: { status: 'superseded', pubblicazione_automatica: false }, job: { status: 'cancelled' } })).toMatchObject({
        fase: 'annullato',
      })
    })
  })

  it('i campi di una voce: byte e durata dichiarati, trasporto, conteggio dei bambini, broadcast', async () => {
    const v = await voce({
      intento: { status: 'confirmed', n_tag: 3, trasporto: 'put-nativo', created_at: fa(2), updated_at: fa(0, 3) },
      job: { status: 'queued', byte_dichiarati: 1_500_000_000, durata_dichiarata_s: 250, updated_at: fa(0, 4) },
    })
    expect(v).toMatchObject({
      trasporto: 'put-nativo',
      byte: 1_500_000_000,
      durataS: 250,
      nBambini: 3,
      broadcast: false,
      pubblicazioneAutomatica: true,
    })
    // Un video del flusso vecchio non ha dichiarato né i byte né la durata.
    const vecchio = await voce({ intento: { status: 'cancelled', pubblicazione_automatica: false, n_tag: 0 }, job: { status: 'cancelled', byte_dichiarati: null, durata_dichiarata_s: null } })
    expect(vecchio).toMatchObject({ byte: null, durataS: null })
  })

  it('un broadcast non ha bambini (`n_tag` 0), e la durata fuori contratto diventa `null` invece di far cadere la voce', async () => {
    const b = await voce({ intento: { status: 'confirmed', broadcast: true, n_tag: 0 } })
    expect(b).toMatchObject({ broadcast: true, nBambini: 0 })
    // La durata dichiarata non è una promessa del database (può mancare, o essere fuori scala): si ripiega su `null`.
    expect((await voce({ job: { status: 'queued', durata_dichiarata_s: 9999 } })).durataS).toBeNull()
    expect((await voce({ job: { status: 'queued', durata_dichiarata_s: '96.5' } })).durataS).toBe(96.5)
  })

  it('#83 — dopo la MINIMIZZAZIONE i bambini sono il numero scelto (`n_tag`), non la lista (vuota), e `updated_at` non è «l’ultima modifica dei dati»', async () => {
    const aggiornato = fa(0, 3)
    const v = await voce({
      intento: { status: 'published', target_id: MEDIA, n_tag: 4, tag_alunni: [], minimizzato_il: fa(0, 1), updated_at: aggiornato },
      job: { status: 'ready', updated_at: aggiornato },
    })
    expect(v.nBambini).toBe(4)
    // `aggiornatoIl` resta quello dello STATO: la minimizzazione non lo ha mosso, e l'elenco non finge il contrario.
    expect(Date.parse(String(v.aggiornatoIl))).toBe(Date.parse(aggiornato))
  })
})

describe('GET /api/video-uploads — ciò che NON deve uscire', () => {
  const tutte = () => {
    aggiungi({ job: { status: 'awaiting_upload', attempt: 0 } })
    aggiungi({ job: { status: 'queued', attempt: 1 } })
    aggiungi({ intento: { status: 'published', target_id: MEDIA }, job: { status: 'ready' } })
    aggiungi({ intento: { status: 'action_required', pubblicazione_errore: 'PUBBLICAZIONE_NON_RIUSCITA' }, job: { status: 'ready', verified_at: fa(1), output_path: 'x/y.mp4' } })
    aggiungi({ job: { status: 'failed', attempt: 4, error_code: 'ENCODE_FAILED', last_error_code: 'ENCODE_FAILED' } })
  }

  it('né i bambini, né l’hash del token, né l’impronta, né il percorso dell’originale — in nessuna voce', async () => {
    tutte()
    const { res, corpo } = await leggi()
    expect(res.status).toBe(200)
    const testo = JSON.stringify(corpo)
    for (const [nome, valore] of Object.entries(SEGRETI)) {
      expect(testo, nome).not.toContain(valore)
    }
    for (const chiave of ['tag_alunni', 'rinnovo_token_hash', 'sha256_dichiarato', 'original_path', 'esito_notificato', 'last_error_code', 'ENCODE_FAILED']) {
      expect(testo, chiave).not.toContain(chiave)
    }
    expect(testo).not.toContain(DOCENTE)
  })

  it('le colonne CHIESTE non includono i riservati: la voce si costruisce dalle sole che servono', async () => {
    tutte()
    await leggi()
    const intento = h.query.video_intents.colonne.split(',').map((c) => c.trim())
    const job = h.query.video_jobs.colonne.split(',').map((c) => c.trim())
    for (const riservata of ['tag_alunni', 'rinnovo_token_hash', 'sha256_dichiarato', 'original_path', 'rinnovo_token_scade_il', 'esito_notificato']) {
      expect(intento, `video_intents.${riservata}`).not.toContain(riservata)
      expect(job, `video_jobs.${riservata}`).not.toContain(riservata)
    }
    // Servono invece `n_tag` (sopravvive alla minimizzazione) e `attempt` (dice se si sta riprovando).
    expect(intento).toContain('n_tag')
    expect(job).toContain('attempt')
  })

  it('il corpo rispetta il contratto: nessuna voce fuori dalle regole di coerenza', async () => {
    tutte()
    const { corpo } = await leggi()
    const letta = schemaRispostaElencoVideo.safeParse(corpo)
    expect(letta.success, JSON.stringify(letta.error?.issues ?? [])).toBe(true)
    expect(corpo.voci).toHaveLength(5)
  })

  it('il log del successo dice i CONTEGGI e mai un identificativo di un bambino o un nome', async () => {
    tutte()
    await leggi()
    const ev = eventi().filter((c) => c[2]?.esito === 'elenco-letto')
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('info')
    expect(ev[0][2]).toMatchObject({ operazione: 'video-uploads:GET', utente: DOCENTE, sede: SEDE, sedi: 1, voci: 5, attive: 2, scartate: 0 })
    const testo = JSON.stringify([h.logEvento.mock.calls, h.logErrore.mock.calls])
    for (const valore of Object.values(SEGRETI)) expect(testo).not.toContain(valore)
  })
})

describe('GET /api/video-uploads — i guasti', () => {
  it('un intento senza il suo job non fa cadere l’elenco: si scarta, e un `error` lo dice (solo uuid)', async () => {
    const buono = aggiungi({})
    const orfano = video({})
    h.righe.video_intents.push(orfano.intento) // l'intento c'è, il job no
    const { res, corpo } = await leggi()
    expect(res.status).toBe(200)
    expect(corpo.voci.map((v: { intentId: string }) => v.intentId)).toEqual([buono.intento])
    const ev = eventi().filter((c) => c[2]?.esito === 'elenco-intento-senza-job')
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('error')
    expect(ev[0][2]).toMatchObject({ intento: orfano.intento.id })
    expect(eventi().find((c) => c[2]?.esito === 'elenco-letto')?.[2]).toMatchObject({ voci: 1, scartate: 1 })
  })

  it('un intento di Galleria con DUE job (non dovrebbe esistere: `SINGLE_JOB_CHANNEL`) fa UNA voce sola, quella del job più vecchio', async () => {
    const { intento, job } = aggiungi({ job: { status: 'queued', attempt: 0, created_at: fa(0, 3) } })
    h.righe.video_jobs.push({
      ...h.righe.video_jobs[0],
      id: uuid('c'),
      status: 'processing',
      attempt: 1,
      created_at: fa(0, 1),
    })
    const { res, corpo } = await leggi()
    expect(res.status).toBe(200)
    expect(corpo.voci).toHaveLength(1)
    expect(corpo.voci[0]).toMatchObject({ intentId: intento, jobId: job, fase: 'in-coda' })
  })

  it('uno stato che il contratto non conosce scarta QUELLA voce e dice quale campo, non il valore', async () => {
    const buono = aggiungi({})
    aggiungi({ job: { status: 'stato-mai-visto' } })
    aggiungi({ intento: { trasporto: 'piccione-viaggiatore' } })
    const { res, corpo } = await leggi()
    expect(res.status).toBe(200)
    expect(corpo.voci.map((v: { intentId: string }) => v.intentId)).toEqual([buono.intento])
    const scartate = eventi().filter((c) => c[2]?.esito === 'elenco-voce-scartata')
    expect(scartate).toHaveLength(2)
    expect(scartate.map((c) => c[2].tipo).sort()).toEqual(['fase-sconosciuta', 'fuori-contratto'])
    // Del secondo si dice il PERCORSO del campo, mai il suo valore.
    const fuori = scartate.find((c) => c[2].tipo === 'fuori-contratto')
    expect(fuori?.[2].campi).toBe('trasporto')
    expect(JSON.stringify(scartate)).not.toContain('piccione-viaggiatore')
    expect(JSON.stringify(scartate)).not.toContain('stato-mai-visto')
  })

  it('la pipeline non installata (tabella assente) ⇒ 503 pulito, non un 500 con lo stack', async () => {
    h.errori.video_intents = { code: '42P01', message: 'relation "video_intents" does not exist' }
    const { res, corpo } = await leggi()
    expect(res.status).toBe(503)
    expect(corpo.codice).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
  })

  it.each(['video_intents', 'video_jobs'])('un errore di lettura su %s ⇒ 500 col suo codice, e il motivo vero nel LOG, non nella risposta', async (tabella) => {
    aggiungi({})
    h.errori[tabella] = { code: '57014', message: 'canceling statement due to statement timeout' }
    const { res, corpo } = await leggi()
    expect(res.status).toBe(500)
    expect(corpo.codice).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
    expect(JSON.stringify(corpo)).not.toContain('statement timeout')
    expect(JSON.stringify(h.logErrore.mock.calls)).toContain('statement timeout')
  })
})
