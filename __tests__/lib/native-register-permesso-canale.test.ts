import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// Le attese e il tetto si leggono dal modulo: un cambio della costante lo seguono anche i test.
// (Import statico solo per i numeri; ogni test ricarica il modulo con `carica()`.)
import {
  ATTESE_RITENTATIVO_SUBSCRIBE_MS as ATTESE,
  TETTO_RICHIESTA_SUBSCRIBE_MS as TETTO,
} from '@/lib/push/native-register'

/**
 * REGISTRAZIONE PUSH NATIVA — permesso, canale Android, ritentativi, livelli (PC1, 2026-09-24).
 *
 * Misurato su 7 giorni prima di questa correzione:
 *  - 26 utenti con il permesso negato ricadevano in `push-nativa-permesso-negato` a OGNI avvio, e il
 *    loro token (se c'era) restava in `push_subscriptions`;
 *  - il canale Android non veniva mai creato: ogni notifica in «Miscellaneous»;
 *  - un solo errore di rete o 5xx su `/api/push/subscribe` lasciava il telefono fuori fino al riavvio.
 *
 * Il plugin qui è finto ma si comporta come quello vero: ogni ascoltatore ha la sua `remove()`, e il
 * sistema «parla» chiamando gli ascoltatori ancora agganciati. Si misurano l'ORDINE delle chiamate,
 * il payload del canale, il numero di POST e il livello dei log — non solo l'esito.
 */

const h = vi.hoisted(() => {
  const ascoltatori = new Map<string, Set<(payload: unknown) => void>>()
  const ordine: string[] = []
  const stato = {
    nativo: true,
    piattaforma: 'android' as 'android' | 'ios',
    pluginDisponibile: true,
    /** `isPluginAvailable` che LANCIA: il bridge rotto, diverso dal plugin assente. */
    bridgeLancia: false,
    permessoAttuale: 'granted' as string,
    permessoDopoRichiesta: 'granted' as string,
  }
  const addListener = vi.fn(async (evento: string, fn: (payload: unknown) => void) => {
    if (!ascoltatori.has(evento)) ascoltatori.set(evento, new Set())
    ascoltatori.get(evento)!.add(fn)
    return { remove: vi.fn(async () => void ascoltatori.get(evento)?.delete(fn)) }
  })
  return {
    ascoltatori,
    ordine,
    stato,
    addListener,
    checkPermissions: vi.fn(async () => {
      ordine.push('checkPermissions')
      return { receive: stato.permessoAttuale }
    }),
    requestPermissions: vi.fn(async () => {
      ordine.push('requestPermissions')
      return { receive: stato.permessoDopoRichiesta }
    }),
    createChannel: vi.fn<(canale: unknown) => Promise<void>>(async () => {
      ordine.push('createChannel')
    }),
    register: vi.fn(async () => {
      ordine.push('register')
    }),
    removeAllListeners: vi.fn(async () => undefined),
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
  Capacitor: {
    isNativePlatform: () => h.stato.nativo,
    getPlatform: () => h.stato.piattaforma,
    isPluginAvailable: (nome: string) => {
      if (h.stato.bridgeLancia) throw new TypeError('bridge')
      return nome === 'PushNotifications' && h.stato.pluginDisponibile
    },
  },
}))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

/**
 * Una risposta del server, una che arriva solo dopo `dopoMs` (con i timer finti: tempo finto), o
 * `'appesa'`: una rete che accetta e tace. Quella non risponde MAI — come la fetch vera, cade solo
 * se chi chiama la interrompe col suo `signal`.
 */
type RispostaFinta = { ok: boolean; status: number } | Error | { dopoMs: number; poi: RispostaFinta } | 'appesa'
let risposte: RispostaFinta[] = []
async function rispondi(r: RispostaFinta, init?: RequestInit): Promise<Response> {
  if (r === 'appesa') {
    return new Promise<Response>((_, rifiuta) => {
      init?.signal?.addEventListener('abort', () => rifiuta(new DOMException('interrotta', 'AbortError')))
    })
  }
  if (r instanceof Error) throw r
  if ('dopoMs' in r) {
    await new Promise((fine) => setTimeout(fine, r.dopoMs))
    return rispondi(r.poi, init)
  }
  return r as Response
}
const fetchFinto = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (_url, init) =>
  rispondi(risposte.length > 0 ? risposte.shift()! : { ok: true, status: 200 }, init),
)

/**
 * Il plugin (finto) si carica PRIMA del modulo: dopo `resetModules`, due `import()` dinamici in
 * volo insieme possono far risolvere a vitest il pacchetto VERO invece del finto — un artefatto del
 * banco, non del codice (nell'app il modulo è uno solo).
 */
async function carica() {
  await import('@capacitor/push-notifications')
  return import('@/lib/push/native-register')
}

/** Con i timer finti `vi.waitFor` non gira: si fanno scorrere le microtask a mano. */
async function finoA(condizione: () => boolean) {
  for (let i = 0; i < 100 && !condizione(); i++) await vi.advanceTimersByTimeAsync(0)
  expect(condizione()).toBe(true)
}

function emetti(evento: string, payload: unknown) {
  for (const fn of [...(h.ascoltatori.get(evento) ?? [])]) fn(payload)
}

async function ascoltatoriAgganciati() {
  await vi.waitFor(() => expect(h.ascoltatori.get('registration')?.size ?? 0).toBe(1))
}

const posts = () => fetchFinto.mock.calls.filter(([u, i]) => u === '/api/push/subscribe' && i?.method === 'POST')
const deletes = () => fetchFinto.mock.calls.filter(([, i]) => i?.method === 'DELETE')
const logCon = (frammento: string) =>
  h.logClient.mock.calls.map(([e]) => e as { livello: string; messaggio: string; campi?: Record<string, unknown> })
    .filter((e) => e.messaggio.includes(frammento))

beforeEach(() => {
  vi.resetModules()
  vi.useRealTimers()
  h.ascoltatori.clear()
  h.ordine.length = 0
  Object.assign(h.stato, {
    nativo: true,
    piattaforma: 'android',
    pluginDisponibile: true,
    bridgeLancia: false,
    permessoAttuale: 'granted',
    permessoDopoRichiesta: 'granted',
  })
  vi.clearAllMocks()
  risposte = []
  window.localStorage.clear()
  document.documentElement.lang = 'it'
  vi.stubGlobal('fetch', fetchFinto)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  // Un test può far passare `logClient` per il logger vero: non deve restarlo per i successivi.
  h.logClient.mockReset()
})

describe('permesso: checkPermissions prima di chiedere', () => {
  it('permesso già concesso: nessun dialogo, si registra', async () => {
    const { registerNativePush } = await carica()
    const esito = registerNativePush('utente-finto')
    await ascoltatoriAgganciati()
    emetti('registration', { value: 'token-finto' })
    expect(await esito).toEqual({ ok: true })
    expect(h.requestPermissions).not.toHaveBeenCalled()
    expect(h.ordine[0]).toBe('checkPermissions')
  })

  it('permesso ancora da chiedere (anche la forma Android «with-rationale»): check, POI request', async () => {
    h.stato.permessoAttuale = 'prompt-with-rationale'
    const { registerNativePush } = await carica()
    const esito = registerNativePush()
    await ascoltatoriAgganciati()
    emetti('registration', { value: 'token-finto' })
    expect(await esito).toEqual({ ok: true })
    expect(h.ordine.slice(0, 2)).toEqual(['checkPermissions', 'requestPermissions'])
  })

  it('permesso negato: non si richiede, non si registra, si cancella il token sul server', async () => {
    h.stato.permessoAttuale = 'denied'
    window.localStorage.setItem('kv_push_token', 'token-vecchio')
    const { registerNativePush } = await carica()

    expect(await registerNativePush('utente-finto')).toEqual({ ok: false, error: 'permission_denied' })
    expect(h.requestPermissions).not.toHaveBeenCalled()
    expect(h.register).not.toHaveBeenCalled()
    expect(h.addListener).not.toHaveBeenCalled()
    expect(deletes()).toHaveLength(1)
    expect(deletes()[0][0]).toBe(`/api/push/subscribe?endpoint=${encodeURIComponent('token-vecchio')}`)
    // Il server ha confermato: la copia locale se ne va.
    expect(window.localStorage.getItem('kv_push_token')).toBeNull()
  })

  it('il rifiuto si scrive UNA volta per installazione, non a ogni avvio', async () => {
    h.stato.permessoAttuale = 'denied'
    const primo = await carica()
    await primo.registerNativePush('utente-finto')
    expect(logCon('push-nativa-permesso-negato')).toEqual([
      expect.objectContaining({ livello: 'warn', campi: { ricordato: true } }),
    ])

    // Secondo avvio: modulo nuovo, stesso storage.
    vi.resetModules()
    h.logClient.mockClear()
    const secondo = await carica()
    expect(await secondo.registerNativePush('utente-finto')).toEqual({ ok: false, error: 'permission_denied' })
    expect(logCon('push-nativa-permesso-negato')).toHaveLength(0)
  })

  it('rifiutato dopo il dialogo: stesso trattamento; un rifiuto dopo un ripensamento si riscrive', async () => {
    h.stato.permessoAttuale = 'prompt'
    h.stato.permessoDopoRichiesta = 'denied'
    const m = await carica()
    await m.registerNativePush()
    expect(logCon('push-nativa-permesso-negato')).toHaveLength(1)

    // L'utente lo riaccende dalle impostazioni: il flag si toglie.
    h.stato.permessoAttuale = 'granted'
    const esito = m.registerNativePush()
    await ascoltatoriAgganciati()
    emetti('registration', { value: 'token-finto' })
    await esito
    expect(window.localStorage.getItem('kv_push_rifiuto_registrato')).toBeNull()

    // E poi lo rispegne: è un fatto nuovo.
    h.stato.permessoAttuale = 'denied'
    h.logClient.mockClear()
    await m.registerNativePush()
    expect(logCon('push-nativa-permesso-negato')).toHaveLength(1)
  })

  it.each([
    ['dal controllo', 'valore-mai-visto', 'granted'],
    ['dopo la richiesta', 'prompt', 'valore-mai-visto'],
  ])('valore del permesso sconosciuto (%s): riga error dedicata, niente flag, niente DELETE', async (_, attuale, dopo) => {
    h.stato.permessoAttuale = attuale
    h.stato.permessoDopoRichiesta = dopo
    window.localStorage.setItem('kv_push_token', 'token-vecchio')
    const { registerNativePush } = await carica()

    expect(await registerNativePush()).toEqual({ ok: false, error: 'plugin_error' })
    expect(logCon('push-nativa-permesso-illeggibile')).toEqual([
      expect.objectContaining({ livello: 'error', messaggio: 'push-nativa-permesso-illeggibile: valore-mai-visto' }),
    ])
    expect(logCon('push-nativa-permesso-negato')).toHaveLength(0)
    expect(window.localStorage.getItem('kv_push_rifiuto_registrato')).toBeNull()
    expect(deletes()).toHaveLength(0)
    expect(window.localStorage.getItem('kv_push_token')).toBe('token-vecchio')
    expect(h.register).not.toHaveBeenCalled()
  })

  it('dialogo chiuso senza scegliere, poi «denied» al riavvio: UNA riga «permesso-negato: denied»', async () => {
    h.stato.permessoAttuale = 'prompt'
    h.stato.permessoDopoRichiesta = 'prompt'
    window.localStorage.setItem('kv_push_token', 'token-vecchio')
    const primo = await carica()
    expect(await primo.registerNativePush()).toEqual({ ok: false, error: 'permission_denied' })
    // Non è un rifiuto: niente flag, il token resta registrato, e una riga che dice cosa è successo.
    expect(window.localStorage.getItem('kv_push_rifiuto_registrato')).toBeNull()
    expect(deletes()).toHaveLength(0)
    expect(logCon('push-nativa-permesso-negato')).toHaveLength(0)
    expect(logCon('push-nativa-permesso-rimandato')).toEqual([expect.objectContaining({ livello: 'warn' })])

    // Riavvio: il sistema ora dice «denied» già dal controllo.
    vi.resetModules()
    h.stato.permessoAttuale = 'denied'
    const secondo = await carica()
    expect(await secondo.registerNativePush()).toEqual({ ok: false, error: 'permission_denied' })
    expect(logCon('push-nativa-permesso-negato')).toEqual([
      expect.objectContaining({ livello: 'warn', messaggio: 'push-nativa-permesso-negato: denied' }),
    ])
    expect(deletes()).toHaveLength(1)
  })

  it('storage negato: il rifiuto si scrive lo stesso, e dice che non potrà ricordarlo', async () => {
    h.stato.permessoAttuale = 'denied'
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    try {
      const { registerNativePush } = await carica()
      await registerNativePush()
      expect(logCon('push-nativa-permesso-negato')).toEqual([
        expect.objectContaining({ livello: 'warn', campi: { ricordato: false } }),
      ])
    } finally {
      set.mockRestore()
    }
  })

  it('permesso negato e DELETE su una rete che tace: l’esito arriva entro il tetto, token tenuto', async () => {
    // `registerNativePush` ATTENDE la DELETE (`gestisciRifiuto`): senza tetto resterebbe appesa per
    // sempre, e in PushOptIn il bottone «attiva» resterebbe occupato.
    h.stato.permessoAttuale = 'denied'
    window.localStorage.setItem('kv_push_token', 'token-vecchio')
    risposte = ['appesa']
    const { registerNativePush } = await carica()
    vi.useFakeTimers()
    let esito: unknown = null
    void registerNativePush().then((r) => {
      esito = r
    })
    await finoA(() => deletes().length === 1)
    expect(deletes()[0][1]?.signal).toBeInstanceOf(AbortSignal)

    await vi.advanceTimersByTimeAsync(TETTO - 1)
    expect(esito).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    await finoA(() => esito !== null)
    expect(esito).toEqual({ ok: false, error: 'permission_denied' })
    expect(logCon('push-token-non-rimosso')).toEqual([
      expect.objectContaining({
        livello: 'error',
        messaggio: `push-token-non-rimosso: nessuna risposta entro ${TETTO} ms`,
      }),
    ])
    // Il server non ha confermato: la copia locale resta, per ritentare la cancellazione.
    expect(window.localStorage.getItem('kv_push_token')).toBe('token-vecchio')
  })

  it('una DELETE che risponde in tempo non lascia il tetto acceso', async () => {
    h.stato.permessoAttuale = 'denied'
    window.localStorage.setItem('kv_push_token', 'token-vecchio')
    risposte = [{ dopoMs: TETTO - 1_000, poi: { ok: true, status: 200 } }]
    const { registerNativePush } = await carica()
    vi.useFakeTimers()
    let esito: unknown = null
    void registerNativePush().then((r) => {
      esito = r
    })
    await finoA(() => deletes().length === 1)
    await vi.advanceTimersByTimeAsync(TETTO - 1_000)
    await finoA(() => esito !== null)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(deletes()[0][1]?.signal?.aborted).toBe(false)
    expect(logCon('push-token-non-rimosso')).toHaveLength(0)
    expect(window.localStorage.getItem('kv_push_token')).toBeNull()
  })

  it('flag del rifiuto che non si toglie: un warn, perché il prossimo rifiuto non verrebbe scritto', async () => {
    const togli = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage')
    })
    try {
      const { registerNativePush } = await carica()
      const esito = registerNativePush()
      await ascoltatoriAgganciati()
      emetti('registration', { value: 'token-finto' })
      // La registrazione va avanti lo stesso.
      expect(await esito).toEqual({ ok: true })
      expect(logCon('push-nativa-flag-rifiuto-non-rimosso')).toEqual([
        expect.objectContaining({ livello: 'warn', messaggio: 'push-nativa-flag-rifiuto-non-rimosso: Error' }),
      ])
    } finally {
      togli.mockRestore()
    }
  })
})

describe('canale Android «Notifiche Kidville»', () => {
  it('si crea PRIMA di register(), con importanza alta, contenuto visibile, vibrazione e suono predefinito', async () => {
    const { registerNativePush } = await carica()
    const esito = registerNativePush()
    await ascoltatoriAgganciati()
    emetti('registration', { value: 'token-finto' })
    await esito

    expect(h.createChannel).toHaveBeenCalledTimes(1)
    expect(h.createChannel).toHaveBeenCalledWith({
      id: 'kidville_notifiche',
      name: 'Notifiche Kidville',
      importance: 4,
      visibility: 1,
      vibration: true,
    })
    expect(h.ordine.indexOf('createChannel')).toBeLessThan(h.ordine.indexOf('register'))
  })

  it('l’id è lo stesso che il server scrive in channel_id', async () => {
    const { CANALE_ANDROID_NOTIFICHE } = await import('@/lib/push/canale-android')
    const { registerNativePush } = await carica()
    void registerNativePush()
    await ascoltatoriAgganciati()
    expect((h.createChannel.mock.calls[0][0] as { id: string }).id).toBe(CANALE_ANDROID_NOTIFICHE)
  })

  it('pagina in inglese: il nome del canale segue la lingua', async () => {
    document.documentElement.lang = 'en'
    const { registerNativePush } = await carica()
    void registerNativePush()
    await ascoltatoriAgganciati()
    expect(h.createChannel).toHaveBeenCalledWith(expect.objectContaining({ name: 'Kidville notifications' }))
  })

  it('su iOS non si crea nessun canale', async () => {
    h.stato.piattaforma = 'ios'
    const { registerNativePush } = await carica()
    void registerNativePush()
    await ascoltatoriAgganciati()
    await vi.waitFor(() => expect(h.register).toHaveBeenCalled())
    expect(h.createChannel).not.toHaveBeenCalled()
  })

  it('canale che fallisce: riga error, ma la registrazione va avanti', async () => {
    h.createChannel.mockRejectedValueOnce(new TypeError('rotto'))
    const { registerNativePush } = await carica()
    const esito = registerNativePush()
    await ascoltatoriAgganciati()
    emetti('registration', { value: 'token-finto' })
    expect(await esito).toEqual({ ok: true })
    expect(logCon('push-nativa-canale-non-creato')).toEqual([
      expect.objectContaining({ livello: 'error', messaggio: 'push-nativa-canale-non-creato: TypeError' }),
    ])
  })

  it.each([
    ['codice UNAVAILABLE', Object.assign(new Error('not available'), { code: 'UNAVAILABLE' })],
    ['solo il messaggio del PluginCall', new Error('not available')],
  ])('Android 7/7.1, niente canali (%s): nessun error, un warn per installazione, si registra', async (_, rifiuto) => {
    h.createChannel.mockRejectedValueOnce(rifiuto)
    const primo = await carica()
    const esito = primo.registerNativePush()
    await ascoltatoriAgganciati()
    emetti('registration', { value: 'token-finto' })
    expect(await esito).toEqual({ ok: true })
    expect(h.register).toHaveBeenCalledTimes(1)
    const eventi = h.logClient.mock.calls.map(([e]) => e as { livello: string; messaggio: string })
    expect(eventi.filter((e) => e.livello === 'error')).toEqual([])
    expect(logCon('push-nativa-canale-non-creato')).toHaveLength(0)
    expect(logCon('push-nativa-canale-non-previsto')).toEqual([expect.objectContaining({ livello: 'warn' })])

    // Riavvio sullo stesso telefono: stesso rifiuto, nessuna riga.
    vi.resetModules()
    h.ascoltatori.clear()
    h.logClient.mockClear()
    h.createChannel.mockRejectedValueOnce(rifiuto)
    const secondo = await carica()
    const esito2 = secondo.registerNativePush()
    await ascoltatoriAgganciati()
    emetti('registration', { value: 'token-finto' })
    expect(await esito2).toEqual({ ok: true })
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('plugin assente dal binario: nessuna chiamata al plugin, riga error', async () => {
    h.stato.pluginDisponibile = false
    const { registerNativePush } = await carica()
    expect(await registerNativePush()).toEqual({ ok: false, error: 'plugin_unavailable' })
    expect(h.checkPermissions).not.toHaveBeenCalled()
    expect(h.createChannel).not.toHaveBeenCalled()
    expect(logCon('push-nativa-plugin-assente')).toEqual([expect.objectContaining({ livello: 'error' })])
    expect(logCon('push-nativa-bridge-illeggibile')).toEqual([])
  })

  it('isPluginAvailable che LANCIA: riga dedicata warn, e non «assente dal binario» (giro 7)', async () => {
    h.stato.bridgeLancia = true
    const { registerNativePush } = await carica()
    expect(await registerNativePush()).toEqual({ ok: false, error: 'plugin_unavailable' })
    expect(h.checkPermissions).not.toHaveBeenCalled()
    expect(h.createChannel).not.toHaveBeenCalled()
    expect(h.register).not.toHaveBeenCalled()
    expect(logCon('push-nativa-bridge-illeggibile')).toEqual([
      expect.objectContaining({ livello: 'warn', evento: 'push', messaggio: 'push-nativa-bridge-illeggibile: TypeError' }),
    ])
    // Il difetto di build NON c'è: la sua riga non deve comparire.
    expect(logCon('push-nativa-plugin-assente')).toEqual([])
    expect(h.logClient).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/push/subscribe con ritentativi (attese crescenti)', () => {
  async function registraConRisposte(r: RispostaFinta[]) {
    risposte = r
    const { registerNativePush } = await carica()
    vi.useFakeTimers()
    const esito = registerNativePush('utente-finto')
    await finoA(() => h.register.mock.calls.length === 1)
    emetti('registration', { value: 'token-finto' })
    // Dentro un oggetto: una promise restituita da una funzione async verrebbe ATTESA, e con i timer
    // finti fermi l'esito non arriverebbe mai.
    return { esito }
  }

  it('rete giù due volte, poi ok: tre POST alle attese giuste, un warn, nessun error', async () => {
    const { esito } = await registraConRisposte([new TypeError('rete'), new TypeError('rete')])
    await vi.advanceTimersByTimeAsync(0)
    expect(posts()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(ATTESE[0] - 1)
    expect(posts()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(posts()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(ATTESE[1] - 1)
    expect(posts()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(posts()).toHaveLength(3)
    expect(await esito).toEqual({ ok: true })

    const livelli = h.logClient.mock.calls.map(([e]) => (e as { livello: string }).livello)
    expect(livelli).toEqual(['warn'])
    expect(logCon('push-nativa-registrazione-ritento')).toHaveLength(1)
    // Ogni tentativo porta lo stesso corpo.
    for (const [, init] of posts()) {
      expect(JSON.parse(String(init?.body))).toEqual({ token: 'token-finto', platform: 'android' })
    }
  })

  it('5xx fino alla fine: tre POST, warn al primo, error solo a ritentativi esauriti', async () => {
    const r503 = { ok: false, status: 503 }
    const { esito } = await registraConRisposte([r503, r503, r503])
    await vi.advanceTimersByTimeAsync(ATTESE[0] + ATTESE[1])
    expect(await esito).toEqual({ ok: false, error: 'subscribe_failed' })
    expect(posts()).toHaveLength(3)
    const eventi = h.logClient.mock.calls.map(([e]) => e as { livello: string; messaggio: string; stato?: number })
    expect(eventi.map((e) => e.livello)).toEqual(['warn', 'error'])
    // Il warn NON porta `stato`: `logClient` lo rialzerebbe a `error` con un 503 (vedi il test col
    // logger vero qui sotto). Lo stato viaggia nei `campi`, che la politica dei livelli non guarda.
    expect(eventi[0]).not.toHaveProperty('stato')
    expect(eventi[0]).toEqual(
      expect.objectContaining({ campi: { tentativi_previsti: 3, stato_http: 503 } }),
    )
    expect(eventi[0].messaggio).toBe('push-nativa-registrazione-ritento: http 503')
    expect(eventi[1]).toEqual(
      expect.objectContaining({ stato: 503, campi: { tentativi: 3 } }),
    )
    expect(eventi[1].messaggio).toContain('ritentativi esauriti')
  })

  it('5xx col logger VERO: il primo fallimento esce warn dalla coda, error solo a ritentativi esauriti', async () => {
    // Il mock di `logClient` registra il livello DICHIARATO; qui passa per quello vero, che applica
    // la politica dei livelli (`livelloEvento`) e mette in coda il livello EFFETTIVO — quello che
    // arriva in `app_log` e che conta per `controlloTassoErrore`.
    const reale = await vi.importActual<typeof import('@/lib/logging/client')>('@/lib/logging/client')
    h.logClient.mockImplementation(reale.logClient)
    const r503 = { ok: false, status: 503 }
    const { esito } = await registraConRisposte([r503, r503, r503])
    await vi.advanceTimersByTimeAsync(ATTESE[0] + ATTESE[1])
    expect(await esito).toEqual({ ok: false, error: 'subscribe_failed' })

    const coda = JSON.parse(window.localStorage.getItem('kv_log_coda') ?? '[]') as Array<{
      livello: string
      messaggio: string
      stato?: number
      campi?: Record<string, unknown>
    }>
    const push = coda.filter((e) => e.messaggio.startsWith('push-nativa-'))
    expect(push.map((e) => [e.livello, e.messaggio])).toEqual([
      ['warn', 'push-nativa-registrazione-ritento: http 503'],
      ['error', 'push-nativa-non-registrata: ritentativi esauriti (http 503)'],
    ])
    expect(push[0].campi).toEqual({ tentativi_previsti: 3, stato_http: 503 })
  })

  it('token arrivato, POST lenti oltre i 20 s: niente «senza esito», e l’esito è quello del server', async () => {
    // t=0 token; il primo POST resta appeso 1 s meno del suo tetto e cade per rete; prima attesa;
    // il secondo POST risponde ok a t=22 s, oltre i 20 s dell'attesa di APNs/FCM (con i numeri di
    // oggi: 14 s + 2 s + 6 s). Con il timer lasciato acceso l'esito sarebbe `registration_timeout`
    // e il log mentirebbe.
    const fine = 22_000
    const ritardoSecondo = fine - (TETTO - 1_000 + ATTESE[0])
    // Lo scenario regge solo se il secondo POST risponde DENTRO il suo tetto.
    expect(ritardoSecondo).toBeGreaterThan(0)
    expect(ritardoSecondo).toBeLessThan(TETTO)
    const { esito } = await registraConRisposte([
      { dopoMs: TETTO - 1_000, poi: new TypeError('rete') },
      { dopoMs: ritardoSecondo, poi: { ok: true, status: 200 } },
    ])
    await vi.advanceTimersByTimeAsync(20_000 - 1)
    expect(posts()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(fine - 20_000 + 1)
    expect(await esito).toEqual({ ok: true })
    expect(logCon('push-nativa-senza-esito')).toHaveLength(0)
    expect(h.logClient.mock.calls.map(([e]) => (e as { messaggio: string }).messaggio)).toEqual([
      'push-nativa-registrazione-ritento: TypeError',
    ])
    // E dopo non scatta più niente: nessun timer rimasto acceso.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(logCon('push-nativa-senza-esito')).toHaveLength(0)
  })

  it('rete che accetta e tace: ogni POST ha il suo tetto, e l’esito arriva comunque', async () => {
    // Senza tetto la prima POST resterebbe appesa per sempre: nessun errore di rete, nessun 5xx,
    // quindi nessun ritentativo — e `registerNativePush` non si risolverebbe più (il timer dei 20 s
    // si è già fermato all'arrivo del token). Tempo al peggio: 15 + 2 + 15 + 8 + 15 = 55 s.
    const { esito } = await registraConRisposte(['appesa', 'appesa', 'appesa'])
    await vi.advanceTimersByTimeAsync(0)
    expect(posts()).toHaveLength(1)
    // Ogni POST porta un segnale: senza, nessuno potrebbe interromperla.
    expect(posts()[0][1]?.signal).toBeInstanceOf(AbortSignal)
    await vi.advanceTimersByTimeAsync(TETTO - 1)
    expect(posts()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1 + ATTESE[0])
    expect(posts()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(TETTO + ATTESE[1])
    expect(posts()).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(TETTO)

    expect(await esito).toEqual({ ok: false, error: 'subscribe_failed' })
    expect(posts()).toHaveLength(3)
    const eventi = h.logClient.mock.calls.map(([e]) => e as { livello: string; messaggio: string })
    expect(eventi.map((e) => e.livello)).toEqual(['warn', 'error'])
    expect(eventi[0].messaggio).toBe(`push-nativa-registrazione-ritento: nessuna risposta entro ${TETTO} ms`)
    expect(eventi[1].messaggio).toBe(
      `push-nativa-non-registrata: ritentativi esauriti (nessuna risposta entro ${TETTO} ms)`,
    )
    // E il timer di APNs/FCM non si riaccende: nessun «senza esito» dopo.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(logCon('push-nativa-senza-esito')).toHaveLength(0)
  })

  it('una POST che risponde in tempo non lascia il tetto acceso', async () => {
    const { esito } = await registraConRisposte([{ dopoMs: TETTO - 1_000, poi: { ok: true, status: 200 } }])
    await vi.advanceTimersByTimeAsync(TETTO - 1_000)
    expect(await esito).toEqual({ ok: true })
    // Se il tetto restasse armato scatterebbe su una chiamata già conclusa: il segnale resta intatto.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(posts()[0][1]?.signal?.aborted).toBe(false)
    expect(posts()).toHaveLength(1)
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('4xx: nessun ritentativo, error subito con lo stato', async () => {
    const { esito } = await registraConRisposte([{ ok: false, status: 400 }])
    await vi.advanceTimersByTimeAsync(ATTESE[0] + ATTESE[1])
    expect(await esito).toEqual({ ok: false, error: 'subscribe_failed' })
    expect(posts()).toHaveLength(1)
    expect(h.logClient.mock.calls.map(([e]) => e)).toEqual([
      expect.objectContaining({ livello: 'error', stato: 400, campi: { tentativi: 1 } }),
    ])
  })

  it('«disattiva» durante l’attesa di un ritentativo: nessun POST dopo, una DELETE sola, token non riscritto', async () => {
    // Primo POST 503; la DELETE di «disattiva» risponde ok.
    const { esito } = await registraConRisposte([{ ok: false, status: 503 }, { ok: true, status: 200 }])
    await vi.advanceTimersByTimeAsync(0)
    expect(posts()).toHaveLength(1)
    expect(window.localStorage.getItem('kv_push_token')).toBe('token-finto')

    const { unregisterNativePush } = await carica()
    await vi.advanceTimersByTimeAsync(ATTESE[0] / 2)
    await unregisterNativePush()
    expect(deletes()).toHaveLength(1)
    expect(await esito).toEqual({ ok: false, error: 'unregistered' })

    // Il ciclo si risveglia e deve fermarsi: senza la generazione qui partirebbero altri due POST.
    await vi.advanceTimersByTimeAsync(ATTESE[0] + ATTESE[1] + 3 * TETTO)
    expect(posts()).toHaveLength(1)
    expect(deletes()).toHaveLength(1)
    expect(window.localStorage.getItem('kv_push_token')).toBeNull()
    // Una scelta dell'utente, non un guasto: nessun error.
    expect(h.logClient.mock.calls.map(([e]) => (e as { livello: string }).livello)).toEqual(['warn'])
  })

  it('POST in volo accettata DOPO «disattiva»: non è un successo, e non chiude la riattivazione partita dopo', async () => {
    // Il primo POST risponde ok solo dopo 1 s; la DELETE risponde subito; il POST della
    // riattivazione risponde ok.
    const { esito } = await registraConRisposte([
      { dopoMs: 1_000, poi: { ok: true, status: 200 } },
      { ok: true, status: 200 },
      { ok: true, status: 200 },
    ])
    await vi.advanceTimersByTimeAsync(0)
    expect(posts()).toHaveLength(1)

    const { registerNativePush, unregisterNativePush } = await carica()
    await unregisterNativePush()
    expect(await esito).toEqual({ ok: false, error: 'unregistered' })

    // Il genitore riattiva subito: nuova registrazione, il sistema non ha ancora consegnato il token.
    const riattivazione = { esito: registerNativePush('utente-finto') }
    await finoA(() => h.register.mock.calls.length === 2)
    let risolta = false
    void riattivazione.esito.then(() => {
      risolta = true
    })

    // Arriva la risposta ok del POST vecchio: senza la generazione chiuderebbe la riattivazione con
    // il successo di un invio che non è il suo.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(risolta).toBe(false)
    expect(logCon('push-nativa-registrata-dopo-disattivazione')).toEqual([
      expect.objectContaining({ livello: 'warn' }),
    ])
    expect(window.localStorage.getItem('kv_push_token')).toBeNull()

    // L'esito della riattivazione è quello del SUO token.
    emetti('registration', { value: 'token-nuovo' })
    expect(await riattivazione.esito).toEqual({ ok: true })
    expect(posts()).toHaveLength(2)
    expect(JSON.parse(String(posts()[1][1]?.body))).toEqual({ token: 'token-nuovo', platform: 'android' })
  })
})

describe('ascoltatori una volta sola, e livelli dove l’esito arriva dopo', () => {
  it('due registrazioni in contemporanea: una coppia di ascoltatori, un POST, due esiti', async () => {
    const { registerNativePush } = await carica()
    const a = registerNativePush('utente-finto')
    const b = registerNativePush()
    await vi.waitFor(() => expect(h.register).toHaveBeenCalledTimes(2))
    expect(h.addListener.mock.calls.filter(([e]) => e === 'registration')).toHaveLength(1)
    expect(h.addListener.mock.calls.filter(([e]) => e === 'registrationError')).toHaveLength(1)
    emetti('registration', { value: 'token-finto' })
    expect(await a).toEqual({ ok: true })
    expect(await b).toEqual({ ok: true })
    expect(posts()).toHaveLength(1)
    // Il fallback legacy dell'identità è quello dato: la seconda chiamata senza userId non lo cancella.
    expect((posts()[0][1]?.headers as Record<string, string>)['x-user-id']).toBe('utente-finto')
  })

  it('aggancio fallito: la guardia si riapre, e il tentativo dopo riaggancia e arriva a register()', async () => {
    // Il primo `addListener('registration')` rifiuta (bridge rotto); `registrationError` si aggancia.
    h.addListener.mockRejectedValueOnce(new TypeError('bridge'))
    const { registerNativePush } = await carica()

    expect(await registerNativePush()).toEqual({ ok: false, error: 'plugin_error' })
    expect(h.register).not.toHaveBeenCalled()
    expect(logCon('push-nativa-ascoltatori-non-agganciati')).toEqual([
      expect.objectContaining({ livello: 'error', messaggio: 'push-nativa-ascoltatori-non-agganciati: TypeError' }),
    ])
    // La maniglia che ce l'aveva fatta si toglie: al tentativo dopo non devono essere due.
    await vi.waitFor(() => expect(h.ascoltatori.get('registrationError')?.size ?? 0).toBe(0))

    const esito = registerNativePush()
    await vi.waitFor(() => expect(h.register).toHaveBeenCalledTimes(1))
    expect(h.addListener.mock.calls.filter(([e]) => e === 'registration')).toHaveLength(2)
    expect(h.ascoltatori.get('registration')?.size).toBe(1)
    expect(h.ascoltatori.get('registrationError')?.size).toBe(1)
    emetti('registration', { value: 'token-finto' })
    expect(await esito).toEqual({ ok: true })
    expect(posts()).toHaveLength(1)
  })

  it('register() che fallisce NON riapre la guardia: gli ascoltatori sani restano quelli', async () => {
    h.register.mockRejectedValueOnce(new TypeError('register'))
    const { registerNativePush } = await carica()
    expect(await registerNativePush()).toEqual({ ok: false, error: 'plugin_error' })
    expect(logCon('push-nativa-register-fallita')).toEqual([expect.objectContaining({ livello: 'error' })])
    expect(logCon('push-nativa-ascoltatori-non-agganciati')).toHaveLength(0)

    const esito = registerNativePush()
    await vi.waitFor(() => expect(h.register).toHaveBeenCalledTimes(2))
    expect(h.addListener.mock.calls.filter(([e]) => e === 'registration')).toHaveLength(1)
    emetti('registration', { value: 'token-finto' })
    expect(await esito).toEqual({ ok: true })
  })

  it('registrationError: warn, non error', async () => {
    const { registerNativePush } = await carica()
    const esito = registerNativePush()
    await ascoltatoriAgganciati()
    emetti('registrationError', { error: 'aps-finto' })
    expect(await esito).toEqual({ ok: false, error: 'aps-finto' })
    expect(logCon('push-nativa-registrazione-fallita')).toEqual([
      expect.objectContaining({ livello: 'warn', messaggio: 'push-nativa-registrazione-fallita: aps-finto' }),
    ])
  })

  it('nessun esito entro 20 s: warn, non error', async () => {
    const { registerNativePush } = await carica()
    vi.useFakeTimers()
    const esito = registerNativePush()
    await finoA(() => h.register.mock.calls.length === 1)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await esito).toEqual({ ok: false, error: 'registration_timeout' })
    expect(logCon('push-nativa-senza-esito')).toEqual([expect.objectContaining({ livello: 'warn' })])
  })
})

describe('la disattivazione vale dal primo istante, anche per gli ascoltatori (giro 6)', () => {
  const metodi = () => fetchFinto.mock.calls.map(([, i]) => i?.method)

  it('token ruotato mentre la DELETE è in volo: nessun POST, la riga non torna', async () => {
    // POST della registrazione ok; la DELETE di «disattiva» risponde solo dopo 1 s.
    risposte = [{ ok: true, status: 200 }, { dopoMs: 1_000, poi: { ok: true, status: 200 } }]
    const { registerNativePush, unregisterNativePush } = await carica()
    vi.useFakeTimers()
    const esito = registerNativePush('utente-finto')
    await finoA(() => h.register.mock.calls.length === 1)
    emetti('registration', { value: 'token-finto' })
    expect(await esito).toEqual({ ok: true })

    const disattivazione = unregisterNativePush()
    await finoA(() => deletes().length === 1)
    expect(String(deletes()[0][0])).toContain('token-finto')
    // FCM ruota il token mentre la DELETE è in volo: gli ascoltatori sono ancora sul bridge.
    emetti('registration', { value: 'token-ruotato' })
    await vi.advanceTimersByTimeAsync(1_000)
    await disattivazione
    await vi.advanceTimersByTimeAsync(ATTESE[0] + ATTESE[1] + 3 * TETTO)

    expect(metodi()).toEqual(['POST', 'DELETE'])
    expect(window.localStorage.getItem('kv_push_token')).toBeNull()
    expect(h.ascoltatori.get('registration')?.size ?? 0).toBe(0)
  })

  it('token consegnato subito dopo «disattiva» (non attesa): 0 POST, nessun token ricordato', async () => {
    const { registerNativePush, unregisterNativePush } = await carica()
    const esito = registerNativePush('utente-finto')
    await ascoltatoriAgganciati()
    const disattivazione = unregisterNativePush()
    // Il sistema consegna il token nello stesso giro: le `remove()` non sono ancora partite.
    emetti('registration', { value: 'token-finto' })
    emetti('registrationError', { error: 'aps-finto' })
    await disattivazione
    expect(await esito).toEqual({ ok: false, error: 'unregistered' })
    // Si aspetta una PRESENZA (la guardia rilasciata), poi si conta: nessun POST.
    await vi.waitFor(() => expect(h.ascoltatori.get('registration')?.size ?? 0).toBe(0))
    await new Promise((fine) => setTimeout(fine, 0))
    expect(posts()).toHaveLength(0)
    expect(window.localStorage.getItem('kv_push_token')).toBeNull()
    // Anche un errore del sistema per la generazione superata non produce righe né esiti.
    expect(logCon('push-nativa')).toHaveLength(0)
  })

  it('riattivazione durante la DELETE: coppia NUOVA, POST dopo la DELETE, esito e token suoi', async () => {
    risposte = [
      { ok: true, status: 200 },
      { dopoMs: 1_000, poi: { ok: true, status: 200 } },
      { ok: true, status: 200 },
    ]
    const { registerNativePush, unregisterNativePush } = await carica()
    vi.useFakeTimers()
    const prima = registerNativePush('utente-finto')
    await finoA(() => h.register.mock.calls.length === 1)
    emetti('registration', { value: 'token-finto' })
    expect(await prima).toEqual({ ok: true })

    const disattivazione = unregisterNativePush()
    await finoA(() => deletes().length === 1)
    // Dentro un oggetto: con i timer finti fermi, `await` su una promise restituita non arriverebbe.
    const riattivazione = { esito: registerNativePush('utente-finto') }
    await finoA(() => h.register.mock.calls.length === 2)
    // La guardia era già riaperta: una coppia nuova, non quella che sta per essere tolta.
    expect(h.addListener.mock.calls.filter(([e]) => e === 'registration')).toHaveLength(2)

    // Il token della riattivazione arriva mentre la DELETE è ancora in volo.
    emetti('registration', { value: 'token-nuovo' })
    await vi.advanceTimersByTimeAsync(0)
    // Il POST aspetta la DELETE: arrivato prima, sarebbe cancellato da lei sul server.
    expect(metodi()).toEqual(['POST', 'DELETE'])
    await vi.advanceTimersByTimeAsync(1_000)
    await disattivazione

    expect(await riattivazione.esito).toEqual({ ok: true })
    expect(metodi()).toEqual(['POST', 'DELETE', 'POST'])
    expect(JSON.parse(String(posts()[1][1]?.body))).toEqual({ token: 'token-nuovo', platform: 'android' })
    // La conferma della DELETE non cancella la copia del token nuovo: servirà al prossimo logout.
    expect(window.localStorage.getItem('kv_push_token')).toBe('token-nuovo')
    // Tolta la coppia vecchia, resta solo quella della riattivazione.
    expect(h.ascoltatori.get('registration')?.size).toBe(1)
  })
})

describe('statoPermessoPush()', () => {
  it('fuori dalla shell nativa: non-nativo, senza toccare il plugin', async () => {
    h.stato.nativo = false
    const { statoPermessoPush } = await carica()
    expect(await statoPermessoPush()).toBe('non-nativo')
    expect(h.checkPermissions).not.toHaveBeenCalled()
  })

  it('plugin assente: non-disponibile', async () => {
    h.stato.pluginDisponibile = false
    const { statoPermessoPush } = await carica()
    expect(await statoPermessoPush()).toBe('non-disponibile')
    expect(h.checkPermissions).not.toHaveBeenCalled()
  })

  it('isPluginAvailable che lancia: non-disponibile, ma con la sua riga warn (giro 7)', async () => {
    h.stato.bridgeLancia = true
    const { statoPermessoPush } = await carica()
    expect(await statoPermessoPush()).toBe('non-disponibile')
    expect(h.checkPermissions).not.toHaveBeenCalled()
    expect(logCon('push-nativa-bridge-illeggibile')).toEqual([
      expect.objectContaining({ livello: 'warn', evento: 'push' }),
    ])
  })

  it.each([
    ['granted', 'granted'],
    ['denied', 'denied'],
    ['prompt', 'prompt'],
    ['prompt-with-rationale', 'prompt'],
  ])('permesso %s → %s, e senza mai chiedere', async (nativo, atteso) => {
    h.stato.permessoAttuale = nativo
    const { statoPermessoPush } = await carica()
    expect(await statoPermessoPush()).toBe(atteso)
    expect(h.requestPermissions).not.toHaveBeenCalled()
  })

  it('bridge che lancia: non-disponibile e un warn', async () => {
    h.checkPermissions.mockRejectedValueOnce(new TypeError('bridge'))
    const { statoPermessoPush } = await carica()
    expect(await statoPermessoPush()).toBe('non-disponibile')
    expect(logCon('push-nativa-stato-permesso-illeggibile')).toEqual([expect.objectContaining({ livello: 'warn' })])
  })
})
