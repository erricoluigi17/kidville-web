import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * DISATTIVARE LE PUSH NON SPEGNE IL TOCCO SULLE NOTIFICHE (parte C della correzione chat, 2026-09-15).
 *
 * `unregisterNativePush` finiva con `PushNotifications.removeAllListeners()`. Quella chiamata svuota
 * TUTTI gli ascoltatori del plugin, sul lato nativo (CAPPlugin.m, Plugin.java): anche quello del tocco
 * su una notifica, che `setupNativeShell` aggancia UNA volta sola all'avvio (`initialized` di modulo in
 * NativeInit). Dopo «disattiva» in PushOptIn il tocco non apriva più niente, fino al riavvio dell'app.
 *
 * La correzione toglie solo ciò che `registerNativePush` ha messo — gli ascoltatori di `registration` e
 * `registrationError` — e SOLO nella disattivazione. Non all'esito della registrazione: su Android
 * `onNewToken` emette `registration` anche ad app aperta, e il token ruotato deve arrivare ancora a
 * `/api/push/subscribe`, altrimenti le notifiche smettono di arrivare senza che nessuno lo sappia.
 *
 * Il plugin qui è finto ma si comporta come quello vero: ogni ascoltatore ha la sua `remove()`, e
 * `removeAllListeners()` li svuota tutti. Così si prova il COMPORTAMENTO (il tocco risponde, il token
 * arriva, dopo la disattivazione non arriva più), non solo quali metodi sono stati chiamati.
 */

type Ascoltatore = (payload: unknown) => void

const h = vi.hoisted(() => {
  const ascoltatori = new Map<string, Set<(payload: unknown) => void>>()
  const handle: Array<{ evento: string; remove: ReturnType<typeof vi.fn> }> = []
  const addListener = vi.fn(async (evento: string, fn: (payload: unknown) => void) => {
    if (!ascoltatori.has(evento)) ascoltatori.set(evento, new Set())
    ascoltatori.get(evento)!.add(fn)
    const remove = vi.fn(async () => {
      ascoltatori.get(evento)?.delete(fn)
    })
    handle.push({ evento, remove })
    return { remove }
  })
  const removeAllListeners = vi.fn(async () => {
    ascoltatori.clear()
  })
  return {
    ascoltatori,
    handle,
    addListener,
    removeAllListeners,
    requestPermissions: vi.fn(async () => ({ receive: 'granted' })),
    checkPermissions: vi.fn(async () => ({ receive: 'granted' })),
    createChannel: vi.fn(async () => undefined),
    register: vi.fn(async () => undefined),
    logClient: vi.fn(),
  }
})

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    addListener: h.addListener,
    removeAllListeners: h.removeAllListeners,
    requestPermissions: h.requestPermissions,
    checkPermissions: h.checkPermissions,
    createChannel: h.createChannel,
    register: h.register,
  },
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', isPluginAvailable: () => true },
}))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

const fetchFinto = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
  async () => ({ ok: true, status: 200 }) as Response,
)

/** Il modulo si ricarica a ogni test: `lastToken` e gli ascoltatori registrati sono stato di modulo. */
async function carica() {
  return import('@/lib/push/native-register')
}

/** Il sistema operativo parla: chiama tutti gli ascoltatori ancora agganciati a quell'evento. */
function emetti(evento: string, payload: unknown) {
  for (const fn of [...(h.ascoltatori.get(evento) ?? [])]) (fn as Ascoltatore)(payload)
}

/** Aspetta che `registerNativePush` abbia agganciato i suoi ascoltatori (import e permesso sono asincroni). */
async function ascoltatoriRegistrazione(quanti: number) {
  await vi.waitFor(() => {
    expect(h.ascoltatori.get('registration')?.size ?? 0).toBe(quanti)
  })
}

/** Le POST di registrazione del token (la DELETE della disattivazione non conta). */
const postDelToken = () =>
  fetchFinto.mock.calls.filter(([url, init]) => url === '/api/push/subscribe' && init?.method === 'POST')

const toccoSu = (url: string) => ({ actionId: 'tap', notification: { data: { url } } })

beforeEach(() => {
  vi.resetModules()
  h.ascoltatori.clear()
  h.handle.length = 0
  vi.clearAllMocks()
  window.localStorage.clear()
  vi.stubGlobal('fetch', fetchFinto)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('registrazione push nativa: gli ascoltatori della registrazione, e solo quelli', () => {
  it('disattivare le push non spegne il tocco sulle notifiche', async () => {
    // L'ascoltatore del tocco lo aggancia la shell nativa, una volta sola, all'avvio.
    const tocco = vi.fn()
    await h.addListener('pushNotificationActionPerformed', tocco)
    const { registerNativePush, unregisterNativePush } = await carica()

    const esito = registerNativePush('utente-finto')
    await ascoltatoriRegistrazione(1)
    emetti('registration', { value: 'token-finto-1' })
    expect(await esito).toEqual({ ok: true })

    await unregisterNativePush()
    emetti('pushNotificationActionPerformed', toccoSu('/parent/chat'))

    expect(tocco).toHaveBeenCalledTimes(1)
    expect(h.removeAllListeners).not.toHaveBeenCalled()
  })

  it('dopo la disattivazione un token nuovo non riscrive il dispositivo, anche con due registrazioni alle spalle', async () => {
    const { registerNativePush, unregisterNativePush } = await carica()

    // Due registrazioni nella stessa sessione: l'automatica all'accesso e «attiva» in PushOptIn.
    // Gli ascoltatori si agganciano UNA volta sola (guardia di modulo, 2026-09-24): la seconda
    // chiamata aspetta l'esito sulla stessa coppia, e un token parte verso il server una volta.
    const prima = registerNativePush('utente-finto')
    await ascoltatoriRegistrazione(1)
    emetti('registration', { value: 'token-finto-1' })
    await prima
    const seconda = registerNativePush()
    await vi.waitFor(() => expect(h.register).toHaveBeenCalledTimes(2))
    expect(h.ascoltatori.get('registration')?.size).toBe(1)
    fetchFinto.mockClear()
    emetti('registration', { value: 'token-finto-1' })
    expect(await seconda).toEqual({ ok: true })
    expect(postDelToken()).toHaveLength(1)

    await unregisterNativePush()
    fetchFinto.mockClear()
    h.logClient.mockClear()

    emetti('registration', { value: 'token-finto-2' })
    emetti('registrationError', { error: 'guasto-finto' })
    await new Promise((r) => setTimeout(r, 0))

    expect(postDelToken()).toHaveLength(0)
    expect(h.logClient).not.toHaveBeenCalled()
    // Ogni ascoltatore della registrazione è stato tolto con la SUA remove, una volta.
    const dellaRegistrazione = h.handle.filter((x) => x.evento === 'registration' || x.evento === 'registrationError')
    expect(dellaRegistrazione).toHaveLength(2)
    for (const { remove } of dellaRegistrazione) expect(remove).toHaveBeenCalledTimes(1)
    expect(h.removeAllListeners).not.toHaveBeenCalled()
  })

  it('dopo l’esito della registrazione, un token ruotato arriva ancora al server (Android, onNewToken)', async () => {
    const { registerNativePush, unregisterNativePush } = await carica()

    const esito = registerNativePush('utente-finto')
    await ascoltatoriRegistrazione(1)
    emetti('registration', { value: 'token-finto-1' })
    expect(await esito).toEqual({ ok: true })

    fetchFinto.mockClear()
    emetti('registration', { value: 'token-finto-2' })

    expect(postDelToken()).toHaveLength(1)
    expect(JSON.parse(String(postDelToken()[0][1]?.body))).toEqual({ token: 'token-finto-2', platform: 'android' })

    // E la disattivazione cancella il token ruotato, non quello di prima.
    fetchFinto.mockClear()
    await unregisterNativePush()
    expect(fetchFinto).toHaveBeenCalledWith(
      `/api/push/subscribe?endpoint=${encodeURIComponent('token-finto-2')}`,
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('disattiva e riattiva: il tocco risponde ancora, e il token parte verso il server una volta sola', async () => {
    const tocco = vi.fn()
    await h.addListener('pushNotificationActionPerformed', tocco)
    const { registerNativePush, unregisterNativePush } = await carica()

    const prima = registerNativePush('utente-finto')
    await ascoltatoriRegistrazione(1)
    emetti('registration', { value: 'token-finto-1' })
    await prima
    await unregisterNativePush()

    fetchFinto.mockClear()
    const riattivata = registerNativePush()
    await ascoltatoriRegistrazione(1)
    emetti('registration', { value: 'token-finto-1' })
    expect(await riattivata).toEqual({ ok: true })
    expect(postDelToken()).toHaveLength(1)

    emetti('pushNotificationActionPerformed', toccoSu('/parent/chat'))
    expect(tocco).toHaveBeenCalledTimes(1)
  })
})
