import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock generico: builder thenable (risolve per-tabella FIFO) + registro chiamate.
const h = vi.hoisted(() => {
  const state = {
    queues: {} as Record<string, Array<{ data: unknown; error: unknown }>>,
    used: {} as Record<string, number>,
    calls: [] as Array<{ table: string; m: string; args: unknown[] }>,
  }
  function take(table: string) {
    const q = state.queues[table] || []
    const i = state.used[table] ?? 0
    state.used[table] = i + 1
    return q[i] ?? { data: [], error: null }
  }
  function makeClient() {
    return {
      from(table: string) {
        const qb: Record<string, unknown> = {}
        const rec = (m: string) => (...args: unknown[]) => { state.calls.push({ table, m, args }); return qb }
        for (const m of ['select', 'is', 'or', 'order', 'limit', 'in', 'update', 'delete', 'eq']) qb[m] = rec(m)
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(take(table)).then(res, rej)
        return qb
      },
    }
  }
  return { state, makeClient }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue(h.makeClient()),
}))
const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)
const push = vi.hoisted(() => ({ sendPush: vi.fn(), vapidConfigured: vi.fn() }))
vi.mock('@/lib/push/web-push', () => push)
const native = vi.hoisted(() => ({ sendNativePush: vi.fn(), fcmConfigured: vi.fn() }))
vi.mock('@/lib/push/native-push', () => native)

import { POST } from '@/app/api/push/dispatch/route'

function req(secret?: string): Request {
  return new Request('http://localhost/api/push/dispatch', {
    method: 'POST',
    headers: secret ? { 'x-cron-secret': secret } : {},
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  h.state.calls = []
  process.env.CRON_SECRET = 'test-secret'
  push.sendPush.mockResolvedValue({ ok: true })
  push.vapidConfigured.mockReturnValue(true)
  native.sendNativePush.mockResolvedValue({ ok: true })
  native.fcmConfigured.mockReturnValue(false) // default: FCM non configurato
})

describe('POST /api/push/dispatch', () => {
  it('401 senza secret o con secret errato', async () => {
    expect((await POST(req())).status).toBe(401)
    expect((await POST(req('wrong'))).status).toBe(401)
  })

  it('senza chiavi VAPID → 200 non_configurato, niente invii né marcature', async () => {
    push.vapidConfigured.mockReturnValue(false)
    const res = await POST(req('test-secret'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toEqual({ inviate: 0, non_configurato: true })
    expect(push.sendPush).not.toHaveBeenCalled()
    expect(h.state.calls).toHaveLength(0)
  })

  it('200 inviate:0 quando non ci sono notifiche pendenti', async () => {
    h.state.queues = { notifiche: [{ data: [], error: null }] }
    const res = await POST(req('test-secret'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.inviate).toBe(0)
    expect(push.sendPush).not.toHaveBeenCalled()
  })

  it('filtra solo non-inviate e buffer scaduto, invia e marca push_inviata_il', async () => {
    h.state.queues = {
      notifiche: [
        { data: [
          { id: 'n1', utente_id: 'u1', titolo: 't1', corpo: 'c1', link: '/' },
          { id: 'n2', utente_id: 'u2', titolo: 't2', corpo: null, link: null },
        ], error: null },
        { data: null, error: null }, // update
      ],
      push_subscriptions: [
        { data: [
          { id: 's1', utente_id: 'u1', endpoint: 'e1', p256dh: 'p', auth: 'a' },
          { id: 's2', utente_id: 'u2', endpoint: 'e2', p256dh: 'p', auth: 'a' },
        ], error: null },
      ],
    }
    const res = await POST(req('test-secret'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(push.sendPush).toHaveBeenCalledTimes(2)
    expect(body.data.inviate).toBe(2)
    expect(body.data.notifiche).toBe(2)
    // filtro buffer applicato a livello query
    expect(h.state.calls.some((c) => c.m === 'is' && c.args[0] === 'push_inviata_il' && c.args[1] === null)).toBe(true)
    expect(h.state.calls.some((c) => c.m === 'or' && String(c.args[0]).includes('invio_programmato_il'))).toBe(true)
    // marcatura inviate
    expect(h.state.calls.some((c) => c.table === 'notifiche' && c.m === 'update')).toBe(true)
  })

  it('rimuove le subscription "gone" (410/404)', async () => {
    push.sendPush.mockResolvedValueOnce({ ok: false, gone: true }).mockResolvedValue({ ok: true })
    h.state.queues = {
      notifiche: [
        { data: [{ id: 'n1', utente_id: 'u1', titolo: 't', corpo: null, link: null }], error: null },
        { data: null, error: null },
      ],
      push_subscriptions: [
        { data: [
          { id: 's1', utente_id: 'u1', endpoint: 'e1', p256dh: 'p', auth: 'a' },
          { id: 's2', utente_id: 'u1', endpoint: 'e2', p256dh: 'p', auth: 'a' },
        ], error: null },
        { data: null, error: null }, // delete
      ],
    }
    const res = await POST(req('test-secret'))
    const body = await res.json()
    expect(body.data.subs_rimosse).toBe(1)
    expect(h.state.calls.some((c) => c.table === 'push_subscriptions' && c.m === 'delete')).toBe(true)
  })

  it('instrada i token nativi a sendNativePush e i web a sendPush', async () => {
    native.fcmConfigured.mockReturnValue(true)
    h.state.queues = {
      notifiche: [
        { data: [{ id: 'n1', utente_id: 'u1', titolo: 't', corpo: null, link: '/x' }], error: null },
        { data: null, error: null }, // update
      ],
      push_subscriptions: [
        { data: [
          { id: 's1', utente_id: 'u1', endpoint: 'webep', p256dh: 'p', auth: 'a', platform: 'web' },
          { id: 's2', utente_id: 'u1', endpoint: 'fcmtok', p256dh: null, auth: null, platform: 'android' },
        ], error: null },
      ],
    }
    const res = await POST(req('test-secret'))
    const body = await res.json()
    expect(push.sendPush).toHaveBeenCalledTimes(1)
    expect(native.sendNativePush).toHaveBeenCalledTimes(1)
    expect(native.sendNativePush).toHaveBeenCalledWith(
      'fcmtok',
      'android',
      expect.objectContaining({ title: 't', url: '/x' })
    )
    expect(body.data.inviate).toBe(1)
    expect(body.data.native_inviate).toBe(1)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // T17-F3 — «DEGRADO PULITO» NON LO ERA: LA NOTIFICA VENIVA PERSA.
  //
  // Fino al 2026-08-03 questo caso pretendeva che la notifica fosse marcata
  // `push_inviata_il` anche con FCM spento. Cioè fissava il DIFETTO: nessuna push
  // partiva, la riga usciva dalla coda e non sarebbe più ripartita, e il battito
  // diceva `esito:'ok'`. Con `FCM_*` assenti da un deploy — tre variabili
  // d'ambiente — ogni push nativa della scuola veniva archiviata come spedita.
  //
  // La regola nuova (`route.ts:281`) è più fine di «non marcare mai»: si marca se
  // c'è stato ALMENO UN tentativo, o se non c'era nessun destinatario. Torna in
  // coda SOLO la notifica che aveva destinatari e nessuno raggiungibile. I due
  // casi qui sotto tengono ferme entrambe le metà — senza il secondo, «non marcare
  // mai» passerebbe, e un genitore con web + telefono riceverebbe ogni notifica
  // due volte finché FCM resta spento.
  // ═══════════════════════════════════════════════════════════════════════════

  it('FCM non configurato e SOLO destinatari nativi → notifica NON marcata, resta in coda', async () => {
    native.fcmConfigured.mockReturnValue(false) // web ok (beforeEach) → nessun early-return
    h.state.queues = {
      notifiche: [
        { data: [{ id: 'n1', utente_id: 'u1', titolo: 't', corpo: null, link: null }], error: null },
        { data: null, error: null }, // update
      ],
      push_subscriptions: [
        { data: [{ id: 's2', utente_id: 'u1', endpoint: 'fcmtok', p256dh: null, auth: null, platform: 'ios' }], error: null },
      ],
    }
    const res = await POST(req('test-secret'))
    const body = await res.json()
    expect(native.sendNativePush).not.toHaveBeenCalled()
    expect(body.data.native_inviate).toBe(0)
    // Nessun tentativo su un destinatario che c'era: la riga non si marca.
    expect(body.data.notifiche).toBe(0)
    expect(h.state.calls.some((c) => c.table === 'notifiche' && c.m === 'update')).toBe(false)
  })

  it('FCM non configurato ma il web sì → un tentativo c’è stato, quindi la notifica SI marca', async () => {
    // L'altra metà della regola: senza questo caso, «non marcare mai niente di
    // parziale» passerebbe il test qui sopra e farebbe arrivare la push due volte
    // a chi il canale web ce l'ha.
    native.fcmConfigured.mockReturnValue(false)
    h.state.queues = {
      notifiche: [
        { data: [{ id: 'n1', utente_id: 'u1', titolo: 't', corpo: null, link: null }], error: null },
        { data: null, error: null }, // update
      ],
      push_subscriptions: [
        { data: [
          { id: 's1', utente_id: 'u1', endpoint: 'webep', p256dh: 'p', auth: 'a', platform: 'web' },
          { id: 's2', utente_id: 'u1', endpoint: 'fcmtok', p256dh: null, auth: null, platform: 'ios' },
        ], error: null },
      ],
    }
    const res = await POST(req('test-secret'))
    const body = await res.json()
    expect(native.sendNativePush).not.toHaveBeenCalled()
    expect(push.sendPush).toHaveBeenCalledTimes(1)
    expect(body.data.notifiche).toBe(1)
    expect(h.state.calls.some((c) => c.table === 'notifiche' && c.m === 'update')).toBe(true)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // UN RIFIUTO NON È NÉ UN SUCCESSO NÉ UNA SUBSCRIPTION MORTA.
  //
  // Il ciclo usava solo `ok` e `gone`. Un `{ ok:false, error }` — cioè QUALUNQUE
  // altro rifiuto del provider: 403 chiave VAPID non autorizzata, 413 payload
  // troppo grande, 401, rete giù, credenziali FCM sbagliate — non incrementava
  // nessun contatore e non alzava niente. La notifica veniva marcata
  // `push_inviata_il` lo stesso (a ragione: evita ritentativi infiniti), quindi
  // NON verrà mai rispedita, e il battito del cron continuava a dire `esito:'ok'`
  // con `inviate: 0`. Zero push consegnate, zero tracce: il guasto delle email di
  // credenziali riprodotto tale e quale.
  //
  // La marcatura NON cambia — è deliberata e documentata nella route. Cambia che
  // adesso si CONTA e si DICE.
  // ═══════════════════════════════════════════════════════════════════════════
  const righe = (livello: string) =>
    log.logEvento.mock.calls
      .filter((c) => c[1] === livello)
      .map((c) => ({ evento: c[0] as string, campi: c[2] as Record<string, unknown> }))

  it('rifiuto web (né ok né gone) → contatore `fallite` e riga `warn`, non un silenzio', async () => {
    push.sendPush.mockResolvedValue({ ok: false, error: 'web_push_403: the VAPID key is not authorized' })
    h.state.queues = {
      notifiche: [
        { data: [{ id: 'n1', utente_id: 'u1', titolo: 't', corpo: null, link: null }], error: null },
        { data: null, error: null }, // update
      ],
      push_subscriptions: [
        { data: [{ id: 's1', utente_id: 'u1', endpoint: 'e1', p256dh: 'p', auth: 'a', platform: 'web' }], error: null },
      ],
    }

    const res = await POST(req('test-secret'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.inviate).toBe(0)
    expect(body.data.fallite).toBe(1)
    // Nessuna rimozione: la subscription è viva, è l'invio ad essere stato rifiutato.
    expect(body.data.subs_rimosse).toBe(0)

    const avvisi = righe('warn').filter((r) => r.campi.esito === 'invii-rifiutati')
    expect(avvisi).toHaveLength(1)
    expect(avvisi[0].evento).toBe('cron')
    expect(avvisi[0].campi).toMatchObject({ operazione: 'push-dispatch', esito: 'invii-rifiutati', fallite: 1 })

    // Il battito di chiusura porta lo stesso numero: chi guarda i cron non deve
    // dover sapere che i rifiuti si cercano da un'altra parte.
    const battito = righe('info').filter((r) => r.campi.esito === 'ok')
    expect(battito).toHaveLength(1)
    expect(battito[0].campi).toMatchObject({ inviate: 0, fallite: 1, notifiche: 1 })
  })

  it('rifiuto NATIVO → stesso contatore (il canale non cambia il fatto)', async () => {
    native.fcmConfigured.mockReturnValue(true)
    native.sendNativePush.mockResolvedValue({ ok: false, error: 'fcm_401: Request had invalid authentication' })
    h.state.queues = {
      notifiche: [
        { data: [{ id: 'n1', utente_id: 'u1', titolo: 't', corpo: null, link: null }], error: null },
        { data: null, error: null },
      ],
      push_subscriptions: [
        { data: [{ id: 's2', utente_id: 'u1', endpoint: 'tok', p256dh: null, auth: null, platform: 'android' }], error: null },
      ],
    }

    const body = await (await POST(req('test-secret'))).json()

    expect(body.data.native_inviate).toBe(0)
    expect(body.data.fallite).toBe(1)
    expect(righe('warn').filter((r) => r.campi.esito === 'invii-rifiutati')).toHaveLength(1)
  })

  it('nessun rifiuto → nessuna riga di allarme, e `fallite: 0` nel battito', async () => {
    // Il controllo positivo: la riga deve esistere SOLO quando c'è il fatto.
    h.state.queues = {
      notifiche: [
        { data: [{ id: 'n1', utente_id: 'u1', titolo: 't', corpo: null, link: null }], error: null },
        { data: null, error: null },
      ],
      push_subscriptions: [
        { data: [{ id: 's1', utente_id: 'u1', endpoint: 'e1', p256dh: 'p', auth: 'a', platform: 'web' }], error: null },
      ],
    }

    const body = await (await POST(req('test-secret'))).json()

    expect(body.data.inviate).toBe(1)
    expect(body.data.fallite).toBe(0)
    expect(righe('warn')).toHaveLength(0)
    expect(righe('info').filter((r) => r.campi.esito === 'ok')[0].campi).toMatchObject({ fallite: 0 })
  })

  it('una subscription «gone» NON è un rifiuto: si rimuove e non si conta fra le fallite', async () => {
    push.sendPush.mockResolvedValue({ ok: false, gone: true })
    h.state.queues = {
      notifiche: [
        { data: [{ id: 'n1', utente_id: 'u1', titolo: 't', corpo: null, link: null }], error: null },
        { data: null, error: null },
      ],
      push_subscriptions: [
        { data: [{ id: 's1', utente_id: 'u1', endpoint: 'e1', p256dh: 'p', auth: 'a', platform: 'web' }], error: null },
        { data: null, error: null }, // delete
      ],
    }

    const body = await (await POST(req('test-secret'))).json()

    expect(body.data.subs_rimosse).toBe(1)
    expect(body.data.fallite).toBe(0)
    expect(righe('warn')).toHaveLength(0)
  })

  it('rimuove il token nativo "gone"', async () => {
    native.fcmConfigured.mockReturnValue(true)
    native.sendNativePush.mockResolvedValue({ ok: false, gone: true })
    h.state.queues = {
      notifiche: [
        { data: [{ id: 'n1', utente_id: 'u1', titolo: 't', corpo: null, link: null }], error: null },
        { data: null, error: null }, // update
      ],
      push_subscriptions: [
        { data: [{ id: 's2', utente_id: 'u1', endpoint: 'fcmtok', p256dh: null, auth: null, platform: 'android' }], error: null },
        { data: null, error: null }, // delete
      ],
    }
    const res = await POST(req('test-secret'))
    const body = await res.json()
    expect(body.data.subs_rimosse).toBe(1)
    expect(h.state.calls.some((c) => c.table === 'push_subscriptions' && c.m === 'delete')).toBe(true)
  })
})
