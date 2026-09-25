import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Mock generico: builder thenable (risolve per-tabella FIFO) + registro chiamate.
// Una voce della coda può essere una FUNZIONE della catena di quella query: serve alla presa
// atomica (`update … in(ids) is(push_inviata_il, null) select('id')`), che restituisce le righe
// prese davvero — vedi `PRESA`. Il finto più fedele, con la tabella in memoria e i giri
// sovrapposti, sta in `__tests__/lib/push-dispatch-presa.test.ts`.
type Chiamata = { table: string; m: string; args: unknown[] }
type Voce = { data: unknown; error: unknown } | ((catena: Chiamata[]) => { data: unknown; error: unknown })
const h = vi.hoisted(() => {
  const state = {
    queues: {} as Record<string, Voce[]>,
    used: {} as Record<string, number>,
    calls: [] as Chiamata[],
  }
  function take(table: string, catena: Chiamata[]) {
    const q = state.queues[table] || []
    const i = state.used[table] ?? 0
    state.used[table] = i + 1
    const v = q[i] ?? { data: [], error: null }
    return typeof v === 'function' ? v(catena) : v
  }
  function makeClient() {
    return {
      from(table: string) {
        const qb: Record<string, unknown> = {}
        const catena: Chiamata[] = []
        const rec = (m: string) => (...args: unknown[]) => {
          const c = { table, m, args }
          state.calls.push(c)
          catena.push(c)
          return qb
        }
        for (const m of ['select', 'is', 'or', 'order', 'limit', 'in', 'update', 'delete', 'eq']) qb[m] = rec(m)
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(take(table, catena)).then(res, rej)
        return qb
      },
      rpc(nome: string, args: unknown) {
        state.calls.push({ table: `rpc:${nome}`, m: 'rpc', args: [args] })
        return Promise.resolve(take(`rpc:${nome}`, []))
      },
    }
  }
  return { state, makeClient }
})

/**
 * La presa atomica riuscita: l'UPDATE condizionato restituisce tutte le candidate che gli sono
 * state passate in `.in('id', …)`. Controlla anche che la condizione ci sia: senza
 * `.is('push_inviata_il', null)` sull'UPDATE la presa non sarebbe atomica, e il finto fallisce.
 */
const PRESA: Voce = (catena) => {
  const ids = catena.find((c) => c.m === 'in' && c.args[0] === 'id')?.args[1] as string[] | undefined
  const condizionata = catena.some((c) => c.m === 'is' && c.args[0] === 'push_inviata_il' && c.args[1] === null)
  if (!catena.some((c) => c.m === 'update') || !ids || !condizionata) {
    return { data: null, error: { code: 'TEST', message: 'presa non condizionata' } }
  }
  return { data: ids.map((id) => ({ id })), error: null }
}

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
import { TIPI_AVVISO_CODA } from '@/lib/fatture-coda/avvisi-testi'

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
        PRESA, // la presa atomica: prende tutte le candidate
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
        PRESA, // la presa atomica: prende tutte le candidate
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
        PRESA, // la presa atomica: prende tutte le candidate
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
        PRESA, // la presa atomica: prende tutte le candidate
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
        PRESA, // la presa atomica: prende tutte le candidate
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
        PRESA, // la presa atomica: prende tutte le candidate
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
        PRESA, // la presa atomica: prende tutte le candidate
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
        PRESA, // la presa atomica: prende tutte le candidate
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
        PRESA, // la presa atomica: prende tutte le candidate
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
        PRESA, // la presa atomica: prende tutte le candidate
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

// ═══════════════════════════════════════════════════════════════════════════
// CONSEGNA 2c DELLA CODA FATTURE — allo staff la push porta SOLO la coda e lo
// scarto SdI. Il pulsante della «Coda fatture» iscrive la PERSONA: senza filtro
// le porterebbe anche le altre notifiche dello staff, fra cui quelle col nome di
// un genitore o di un bambino nel corpo. Le escluse si marcano come per chi non
// ha dispositivi (niente da spedire, niente da riprovare) e si contano.
// Utenti, sedi e sottoscrizioni palesemente finti.
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /api/push/dispatch — lo staff riceve in push solo la coda fatture (consegna 2c)', () => {
  const SEGRETERIA = { role: 'segreteria', ruolo: 'segreteria' }
  const GENITORE = { role: 'genitore', ruolo: 'genitore' }
  const riga = (id: string, utente_id: string, tipo: string, utenti: unknown) => ({
    id,
    utente_id,
    tipo,
    titolo: `titolo-${id}`,
    corpo: null,
    link: '/x',
    utenti,
  })
  const subWeb = (id: string, utente_id: string) => ({
    id,
    utente_id,
    endpoint: `endpoint-${id}`,
    p256dh: 'p',
    auth: 'a',
    platform: 'web',
  })
  const idsMarcati = () => {
    const c = h.state.calls.find((x) => x.table === 'notifiche' && x.m === 'in')
    return c ? [...(c.args[1] as string[])].sort() : []
  }
  const battitoOk = () => righeInfoOk()[0]
  const righeInfoOk = () =>
    log.logEvento.mock.calls
      .filter((c) => c[1] === 'info' && (c[2] as Record<string, unknown>).esito === 'ok')
      .map((c) => c[2] as Record<string, unknown>)

  it('la lettura chiede tipo e ruolo del destinatario nella STESSA query', async () => {
    // Il caso che tiene in piedi gli altri: il finto restituisce `utenti` qualunque cosa
    // chieda il `select`, e senza questo controllo gli altri resterebbero verdi anche
    // togliendo la relazione dalla lettura.
    h.state.queues = { notifiche: [{ data: [], error: null }] }
    await POST(req('test-secret'))
    const sel = h.state.calls.find((c) => c.table === 'notifiche' && c.m === 'select')
    expect(sel).toBeDefined()
    const arg = String(sel!.args[0])
    expect(arg.split(',').map((s) => s.trim())).toContain('tipo')
    expect(arg).toContain('utenti(role, ruolo)')
  })

  it('segreteria con un dispositivo web: solo coda e scarto in push; il genitore riceve tutto; tutte e quattro marcate', async () => {
    h.state.queues = {
      notifiche: [
        { data: [
          riga('n-onb', 'u-segr', 'onboarding_completato', SEGRETERIA),
          riga('n-fine', 'u-segr', 'fattura_coda_fine', SEGRETERIA),
          riga('n-scarto', 'u-segr', 'fattura_scartata', SEGRETERIA),
          riga('n-gen', 'u-gen', 'avviso_generico', GENITORE),
        ], error: null },
        PRESA, // la presa atomica: prende tutte le candidate
      ],
      push_subscriptions: [
        { data: [subWeb('s-segr', 'u-segr'), subWeb('s-gen', 'u-gen')], error: null },
      ],
    }
    const res = await POST(req('test-secret'))
    const body = await res.json()
    expect(res.status).toBe(200)
    const titoli = push.sendPush.mock.calls.map((c) => (c[1] as { title: string }).title).sort()
    expect(titoli).toEqual(['titolo-n-fine', 'titolo-n-gen', 'titolo-n-scarto'])
    expect(idsMarcati()).toEqual(['n-fine', 'n-gen', 'n-onb', 'n-scarto'])
    expect(body.data).toMatchObject({ inviate: 3, notifiche: 4, escluse_staff: 1 })
    expect(battitoOk()).toMatchObject({ inviate: 3, notifiche: 4, escluse_staff: 1 })
  })

  it('la cuoca con un dispositivo nativo: la sua `mensa_allergia` non parte, ma si marca e si conta', async () => {
    native.fcmConfigured.mockReturnValue(true)
    h.state.queues = {
      notifiche: [
        { data: [riga('n-mensa', 'u-cuoca', 'mensa_allergia', { role: 'cuoca', ruolo: 'cuoca' })], error: null },
        PRESA, // la presa atomica: prende tutte le candidate
      ],
      push_subscriptions: [
        { data: [{ id: 's-cuoca', utente_id: 'u-cuoca', endpoint: 'tok', p256dh: null, auth: null, platform: 'android' }], error: null },
      ],
    }
    const body = await (await POST(req('test-secret'))).json()
    expect(native.sendNativePush).not.toHaveBeenCalled()
    expect(push.sendPush).not.toHaveBeenCalled()
    expect(idsMarcati()).toEqual(['n-mensa'])
    expect(body.data).toMatchObject({ native_inviate: 0, notifiche: 1, escluse_staff: 1 })
    expect(battitoOk()).toMatchObject({ escluse_staff: 1 })
  })

  it('ogni tipo della coda a un admin con un dispositivo parte in push', async () => {
    const ADMIN = { role: 'admin', ruolo: 'admin' }
    h.state.queues = {
      notifiche: [
        { data: TIPI_AVVISO_CODA.map((t) => riga(`n-${t}`, 'u-admin', t, ADMIN)), error: null },
        PRESA, // la presa atomica: prende tutte le candidate
      ],
      push_subscriptions: [{ data: [subWeb('s-admin', 'u-admin')], error: null }],
    }
    const body = await (await POST(req('test-secret'))).json()
    expect(TIPI_AVVISO_CODA.length).toBeGreaterThan(0)
    expect(push.sendPush).toHaveBeenCalledTimes(TIPI_AVVISO_CODA.length)
    expect(body.data).toMatchObject({ inviate: TIPI_AVVISO_CODA.length, escluse_staff: 0 })
  })

  it('una segreteria SENZA dispositivi: la riga si marca come sempre e non si conta fra le escluse', async () => {
    // Si contano le push non portate per scelta, non le righe dello staff.
    h.state.queues = {
      notifiche: [
        { data: [riga('n-onb', 'u-segr', 'onboarding_completato', SEGRETERIA)], error: null },
        PRESA, // la presa atomica: prende tutte le candidate
      ],
      push_subscriptions: [{ data: [], error: null }],
    }
    const body = await (await POST(req('test-secret'))).json()
    expect(push.sendPush).not.toHaveBeenCalled()
    expect(idsMarcati()).toEqual(['n-onb'])
    expect(body.data).toMatchObject({ notifiche: 1, escluse_staff: 0 })
    expect(battitoOk()).toMatchObject({ escluse_staff: 0 })
  })

  // Tutti e quattro i ruoli dello staff, uno per uno: togliere un ruolo dall'elenco (l'admin è
  // l'iscritto più probabile) deve diventare rosso, non passare coperto dagli altri tre.
  it.each(['admin', 'coordinator', 'segreteria', 'cuoca'])(
    '%s con un dispositivo web: un tipo fuori dalla coda non parte, si marca e si conta',
    async (ruolo) => {
      h.state.queues = {
        notifiche: [
          { data: [riga('n-onb', 'u-staff', 'onboarding_completato', { role: ruolo, ruolo })], error: null },
          PRESA, // la presa atomica: prende tutte le candidate
        ],
        push_subscriptions: [{ data: [subWeb('s-staff', 'u-staff')], error: null }],
      }
      const body = await (await POST(req('test-secret'))).json()
      expect(push.sendPush).not.toHaveBeenCalled()
      expect(idsMarcati()).toEqual(['n-onb'])
      expect(body.data).toMatchObject({ inviate: 0, notifiche: 1, escluse_staff: 1 })
      expect(battitoOk()).toMatchObject({ escluse_staff: 1 })
    },
  )

  // Chi non è né staff né genitore: il docente (67 iscritti misurati il 24/09) riceve tutto
  // come prima. Un filtro scritto come «tutti tranne il genitore» gli toglierebbe la push in
  // silenzio: qui diventa rosso.
  it('un docente con un dispositivo web riceve in push anche i tipi fuori dalla coda', async () => {
    h.state.queues = {
      notifiche: [
        { data: [riga('n-chat', 'u-doc', 'chat_docente', { role: 'educator', ruolo: 'educator' })], error: null },
        PRESA, // la presa atomica: prende tutte le candidate
      ],
      push_subscriptions: [{ data: [subWeb('s-doc', 'u-doc')], error: null }],
    }
    const body = await (await POST(req('test-secret'))).json()
    expect(push.sendPush).toHaveBeenCalledTimes(1)
    expect((push.sendPush.mock.calls[0][1] as { title: string }).title).toBe('titolo-n-chat')
    expect(idsMarcati()).toEqual(['n-chat'])
    expect(body.data).toMatchObject({ inviate: 1, notifiche: 1, escluse_staff: 0 })
    expect(battitoOk()).toMatchObject({ escluse_staff: 0 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// IL FILTRO QUI SOPRA VEDE SOLO LE PUSH CHE PASSANO DI QUI. Un modulo che chiama
// `sendPush` o `sendNativePush` da sé, sui dispositivi dello staff, lo scavalca: fino
// al giro 2 della 2c lo faceva l'alert allergie della mensa (nome del bambino e
// allergeni nel corpo, a admin, coordinator, segreteria e cuoca). Questo lock tiene
// il dispatch unico canale: chi importa i due invii è `src/lib/push/dispatch.ts`.
// Fino al 2026-09-24 c'era anche `src/lib/mensa/notify.ts` per il saldo basso ai genitori:
// spediva web-push anche ai token nativi (senza chiavi web ⇒ errore) e un doppione a chi
// usa il web, perché il dispatch rispediva la stessa riga. Tolto (intervento W2).
// ═══════════════════════════════════════════════════════════════════════════
describe('push allo staff: il dispatch è l\'unico canale (consegna 2c, giro 2)', () => {
  const RADICE = join(__dirname, '..', '..')
  const SRC = join(RADICE, 'src')
  function sorgenti(dir: string): string[] {
    const out: string[] = []
    for (const nome of readdirSync(dir)) {
      const p = join(dir, nome)
      if (statSync(p).isDirectory()) out.push(...sorgenti(p))
      else if (/\.(ts|tsx)$/.test(nome)) out.push(p)
    }
    return out
  }
  // Un import (statico o dinamico) di uno dei due invii dai moduli della push. Un commento che
  // nomina `sendPush` fra apici inversi non è un import, e non conta.
  const IMPORTA_INVIO =
    /import\s*\{[^}]*\b(?:sendPush|sendNativePush)\b[^}]*\}\s*from\s*['"](?:@\/lib\/push\/|\.{1,2}\/)[^'"]*push['"]|import\(\s*['"]@\/lib\/push\/(?:web|native)-push['"]\s*\)/

  // Dal 24/09 (PS2) il giro sta in `src/lib/push/dispatch.ts` e la route lo chiama: l'unico
  // modulo di tutto `src/` che importa i due invii è quello. Si esclude solo chi li DEFINISCE
  // (`web-push.ts`, `native-push.ts`), non tutta la cartella: un secondo modulo di `src/lib/push/`
  // che spedisse da sé scavalcherebbe il filtro dello staff quanto uno di fuori.
  it('solo `eseguiDispatch` importa `sendPush`/`sendNativePush`', () => {
    const file = sorgenti(SRC)
    // Un lock che scansiona zero file è verde per niente.
    expect(file.length).toBeGreaterThan(500)
    const chiImporta = file
      .map((f) => relative(RADICE, f).split(sep).join('/'))
      .filter((r) => r !== 'src/lib/push/web-push.ts' && r !== 'src/lib/push/native-push.ts')
      .filter((r) => IMPORTA_INVIO.test(readFileSync(join(RADICE, r), 'utf8')))
      .sort()
    expect(chiImporta).toEqual(['src/lib/push/dispatch.ts'])
  })

  it('la route del cron non spedisce da sé: chiama `eseguiDispatch`', () => {
    const testo = readFileSync(join(SRC, 'app', 'api', 'push', 'dispatch', 'route.ts'), 'utf8')
    expect(testo).toMatch(/import\s*\{[^}]*\beseguiDispatch\b[^}]*\}\s*from\s*'@\/lib\/push\/dispatch'/)
    expect(testo).toMatch(/await eseguiDispatch\(\{ origine: 'cron' \}\)/)
    expect(IMPORTA_INVIO.test(testo)).toBe(false)
  })

  it('in `mensa/notify.ts` nessun invio diretto: né allergie né saldo basso (W2)', () => {
    const testo = readFileSync(join(SRC, 'lib', 'mensa', 'notify.ts'), 'utf8')
    // Il file esiste e contiene davvero le due funzioni: un lock su un file vuoto è verde per niente.
    expect(testo.indexOf('export async function notificaSaldoBasso')).toBeGreaterThan(0)
    expect(testo.indexOf('export async function notificaAllergie')).toBeGreaterThan(0)
    expect(IMPORTA_INVIO.test(testo)).toBe(false)
    expect(testo.match(/\b(?:sendPush|sendNativePush)\(/g) ?? []).toHaveLength(0)
  })
})
