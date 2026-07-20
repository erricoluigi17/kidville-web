import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// =============================================================================
// STEP 3 — motore cron /api/news/cron/run (pattern solleciti/run).
//
// Invarianti sotto lock:
//  - 401 senza x-cron-secret o con secret sbagliato (e NIENTE grido sul POST anonimo).
//  - job 'tick': promuove le programmate scadute e le notifica.
//  - health-check Instagram: 2 fallimenti CONSECUTIVI → post nascosto; 429 → 'indeterminato'
//    (NESSUN incremento del contatore, il post NON viene nascosto).
//  - job 'digest': genera/invia il digest del MESE PRECEDENTE.
//  - query fallita → riga cron 'error' + 500, MAI il battito 'ok'.
// `parseInstagramUrl`/`buildEmbedUrl`/`esitoHealthCheck` sono REALI (puri).
// =============================================================================

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ ...log, EVENTI_PERSISTITI: new Set(['news', 'cron']) }))

const news = vi.hoisted(() => ({
  notificaNewsPubblicata: vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined),
  generaEInviaDigest: vi.fn<(...a: unknown[]) => Promise<{ edizioni: unknown[] }>>(async () => ({ edizioni: [] })),
}))
vi.mock('@/lib/news/notifiche', () => ({ notificaNewsPubblicata: (...a: unknown[]) => news.notificaNewsPubblicata(...a) }))
vi.mock('@/lib/news/digest', () => ({ generaEInviaDigest: (...a: unknown[]) => news.generaEInviaDigest(...a) }))

const ext = vi.hoisted(() => ({ externalFetch: vi.fn() }))
vi.mock('@/lib/logging/external', () => ({ externalFetch: (...a: unknown[]) => ext.externalFetch(...a) }))

// ── Finto Supabase: risposte in base ai FILTRI del builder (non FIFO cieca). ──
const db = vi.hoisted(() => {
  const state = {
    programmate: [] as Array<Record<string, unknown>>,
    programmateError: null as unknown,
    instagram: [] as Array<Record<string, unknown>>,
    instagramError: null as unknown,
    updates: [] as Array<{ rec: Record<string, unknown>; eqs: Record<string, unknown> }>,
    updateError: null as unknown,
  }
  function client() {
    return {
      from() {
        const st = { eqs: {} as Record<string, unknown>, isUpdate: false, updateRec: null as Record<string, unknown> | null }
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = (c: string, v: unknown) => { st.eqs[c] = v; return b }
        b.lte = () => b
        b.lt = () => b
        b.gte = () => b
        b.is = () => b
        b.or = () => b
        b.order = () => b
        b.in = () => b
        b.not = () => b
        b.limit = () => b
        b.update = (rec: Record<string, unknown>) => { st.isUpdate = true; st.updateRec = rec; return b }
        const resolve = (): { data: unknown; error: unknown } => {
          if (st.isUpdate) {
            state.updates.push({ rec: st.updateRec ?? {}, eqs: { ...st.eqs } })
            return { data: null, error: state.updateError }
          }
          if (st.eqs.stato === 'programmata') return { data: state.programmate, error: state.programmateError }
          if (st.eqs.tipo === 'instagram') return { data: state.instagram, error: state.instagramError }
          return { data: [], error: null }
        }
        b.maybeSingle = async () => resolve()
        b.single = async () => resolve()
        b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(resolve()).then(onF, onR)
        return b
      },
    }
  }
  return { state, client }
})
const supa = vi.hoisted(() => ({ createAdminClient: vi.fn(), createClient: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => supa)

import { POST as cronPOST } from '@/app/api/news/cron/run/route'

const SEGRETO = 'test-secret'
function req(body: unknown, secret?: string): Request {
  return new Request('http://localhost/api/news/cron/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-cron-secret': secret } : {}) },
    body: JSON.stringify(body),
  })
}
function righe(livello?: string) {
  return log.logEvento.mock.calls
    .filter((c) => livello === undefined || c[1] === livello)
    .map((c) => ({ evento: c[0] as string, campi: (c[2] ?? {}) as Record<string, unknown> }))
}
const battitoOk = () => righe().some((r) => r.evento === 'cron' && r.campi.esito === 'ok')

beforeEach(() => {
  vi.clearAllMocks()
  db.state.programmate = []
  db.state.programmateError = null
  db.state.instagram = []
  db.state.instagramError = null
  db.state.updates = []
  db.state.updateError = null
  supa.createAdminClient.mockReset().mockImplementation(async () => db.client())
  supa.createClient.mockReset().mockImplementation(async () => db.client())
  ext.externalFetch.mockResolvedValue({ ok: true, stato: 200, corpo: '', res: { text: async () => '<meta property="og:image" content="x">' } })
  news.generaEInviaDigest.mockResolvedValue({ edizioni: [] })
  vi.stubEnv('CRON_SECRET', SEGRETO)
})
afterEach(() => { vi.useRealTimers() })

describe('news/cron/run — gate x-cron-secret', () => {
  it('401 senza header, e NESSUN grido sul POST anonimo', async () => {
    const res = await cronPOST(req({ job: 'tick' }))
    expect(res.status).toBe(401)
    expect(righe('error').length).toBe(0)
  })

  it('401 con secret sbagliato, e SI logga (cron con la chiave sbagliata)', async () => {
    const res = await cronPOST(req({ job: 'tick' }, 'sbagliato'))
    expect(res.status).toBe(401)
    expect(righe('error').some((r) => r.campi.esito === 'secret-errato')).toBe(true)
  })

  it('400 su job non valido', async () => {
    const res = await cronPOST(req({ job: 'boh' }, SEGRETO))
    expect(res.status).toBe(400)
  })
})

describe('news/cron/run — job tick: promozione programmate', () => {
  it('promuove una programmata scaduta e la notifica', async () => {
    db.state.programmate = [{
      id: 'p1', titolo: 'Festa', scuola_id: 'sc-1', target_scope: 'globale',
      target_gradi: null, target_classes: null, contenuto_testo: 'testo',
      invia_notifica: true, notifica_inviata_il: null,
    }]
    const res = await cronPOST(req({ job: 'tick' }, SEGRETO))
    expect(res.status).toBe(200)
    const pubblicazione = db.state.updates.find((u) => u.rec.stato === 'pubblicata')
    expect(pubblicazione).toBeTruthy()
    expect(pubblicazione!.eqs.id).toBe('p1')
    expect(news.notificaNewsPubblicata).toHaveBeenCalledTimes(1)
    expect(battitoOk()).toBe(true)
  })
})

describe('news/cron/run — job tick: health-check Instagram', () => {
  it('2 fallimenti consecutivi → post NASCOSTO', async () => {
    db.state.instagram = [{ id: 'ig1', instagram_url: null, instagram_shortcode: 'ABC123', ig_check_falliti: 1 }]
    ext.externalFetch.mockResolvedValue({ ok: false, stato: 404, corpo: 'page unavailable' })
    const res = await cronPOST(req({ job: 'tick' }, SEGRETO))
    expect(res.status).toBe(200)
    const nascondi = db.state.updates.find((u) => u.rec.stato === 'nascosta')
    expect(nascondi).toBeTruthy()
    expect(nascondi!.rec.nascosta_motivo).toBe('instagram-non-raggiungibile')
    expect(nascondi!.rec.ig_check_falliti).toBe(2)
  })

  it('primo fallimento (0→1) NON nasconde il post', async () => {
    db.state.instagram = [{ id: 'ig1', instagram_url: null, instagram_shortcode: 'ABC123', ig_check_falliti: 0 }]
    ext.externalFetch.mockResolvedValue({ ok: false, stato: 404, corpo: 'content unavailable' })
    await cronPOST(req({ job: 'tick' }, SEGRETO))
    const upd = db.state.updates.find((u) => u.eqs.id === 'ig1')
    expect(upd!.rec.ig_check_falliti).toBe(1)
    expect(upd!.rec.stato).toBeUndefined()
  })

  it('429 (rate limit) → indeterminato: NESSUN incremento, post NON toccato nello stato', async () => {
    db.state.instagram = [{ id: 'ig1', instagram_url: null, instagram_shortcode: 'ABC123', ig_check_falliti: 1 }]
    ext.externalFetch.mockResolvedValue({ ok: false, stato: 429, corpo: '' })
    await cronPOST(req({ job: 'tick' }, SEGRETO))
    const upd = db.state.updates.find((u) => u.eqs.id === 'ig1')
    expect(upd).toBeTruthy()
    expect(upd!.rec.ig_check_falliti).toBeUndefined() // il contatore NON si tocca
    expect(upd!.rec.stato).toBeUndefined()
    expect(upd!.rec.ig_check_il).toBeTruthy() // solo il timestamp di controllo
  })

  it('embed vivo → azzera il contatore dei fallimenti', async () => {
    db.state.instagram = [{ id: 'ig1', instagram_url: null, instagram_shortcode: 'ABC123', ig_check_falliti: 1 }]
    ext.externalFetch.mockResolvedValue({ ok: true, stato: 200, corpo: '', res: { text: async () => 'og:image cdninstagram' } })
    await cronPOST(req({ job: 'tick' }, SEGRETO))
    const upd = db.state.updates.find((u) => u.eqs.id === 'ig1')
    expect(upd!.rec.ig_check_falliti).toBe(0)
  })
})

describe('news/cron/run — job digest', () => {
  it('genera il digest del MESE PRECEDENTE', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-05T08:00:00Z'))
    news.generaEInviaDigest.mockResolvedValue({ edizioni: [{ scuola_id: 'sc-1', generata: true, inviata: true, destinatari_count: 3, errori_count: 0 }] })
    const res = await cronPOST(req({ job: 'digest' }, SEGRETO))
    expect(res.status).toBe(200)
    expect(news.generaEInviaDigest).toHaveBeenCalledWith(expect.anything(), { anno: 2026, mese: 2 })
    expect(battitoOk()).toBe(true)
  })

  it('a gennaio il mese precedente è dicembre dell\'anno prima', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-10T08:00:00Z'))
    await cronPOST(req({ job: 'digest' }, SEGRETO))
    expect(news.generaEInviaDigest).toHaveBeenCalledWith(expect.anything(), { anno: 2025, mese: 12 })
  })
})

describe('news/cron/run — query fallita', () => {
  it('lettura programmate rotta → 500 e battito OK MAI emesso', async () => {
    db.state.programmateError = { code: '57014', message: 'statement timeout' }
    const res = await cronPOST(req({ job: 'tick' }, SEGRETO))
    expect(res.status).toBe(500)
    expect(battitoOk()).toBe(false)
    expect(righe('error').some((r) => r.evento === 'cron')).toBe(true)
  })

  it('schema assente (DB CI non migrato) → 200 degradato, nessun 500', async () => {
    db.state.programmateError = { code: '42P01', message: 'relation "news_posts" does not exist' }
    const res = await cronPOST(req({ job: 'tick' }, SEGRETO))
    expect(res.status).toBe(200)
  })
})
