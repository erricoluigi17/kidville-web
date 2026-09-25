import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * IL PLUGIN PUSH È UN PROXY, E UNA PROMISE NON DEVE MAI RISOLVERSI CON LUI (regressione della #166,
 * 2026-09-25).
 *
 * In produzione, dopo il rilascio della #166, `app_log` ha raccolto su iOS e Android (route /parent e
 * /teacher) decine di righe `"PushNotifications.then()" is not implemented on ios|android`. La causa:
 * `caricaPluginPush()` restituiva `import(…).then((m) => m.PushNotifications)`, una promise che si
 * risolve CON il plugin. La risoluzione di una promise legge `.then` sul valore per sapere se è un
 * «thenable» — e il plugin di Capacitor è un `Proxy` che a ogni proprietà sconosciuta risponde con un
 * metodo del bridge. `then` compreso: lo chiama con `(risolvi, rifiuta)`, il bridge rifiuta con
 * «not implemented», e la promise di partenza resta appesa per sempre.
 *
 * I test esistenti non potevano vederlo: il loro plugin finto è un oggetto piatto, senza `then`, e una
 * promise lo attraversa intatto. Qui il finto imita FEDELMENTE `registerPlugin` di
 * `node_modules/@capacitor/core/dist/index.js`:
 *  - `new Proxy({}, { get(_, prop) { … } })`;
 *  - `$$typeof` → `undefined`, `toJSON` → `() => ({})`, `addListener`/`removeListener` → i loro;
 *  - ogni altra proprietà → `createPluginMethodWrapper(prop)`: una funzione che restituisce una
 *    promise. Per un metodo che il plugin nativo dichiara, è la chiamata al bridge; per un metodo che
 *    non dichiara (e `then` non lo dichiara nessuno) è un RIFIUTO con codice `UNIMPLEMENTED` e il
 *    messaggio `"<Plugin>.<metodo>()" is not implemented on <piattaforma>`. Il wrapper NON chiama mai
 *    `risolvi`/`rifiuta` che la promise gli passa: per questo quella promise non si chiude più.
 *
 * Con il codice vecchio questi test scadono sulla corsa contro `ATTESA_MAX_MS` (e vitest segnala il
 * rifiuto non gestito del finto); con quello nuovo `then` non viene mai letto sul plugin.
 */

const h = vi.hoisted(() => {
  const piattaforma = { valore: 'android' as 'android' | 'ios' }
  const ascoltatori = new Map<string, Set<(payload: unknown) => void>>()
  /** Le proprietà lette sul proxy, in ordine: il test guarda che `then` non ci sia. */
  const letture: string[] = []
  /** I rifiuti del bridge, in ordine; e l'interruttore che li marca «gestiti» (solo per il banco). */
  const rifiutiBridge: string[] = []
  const banco = { silenziaRifiuti: false }
  /** I metodi che il plugin nativo dichiara (l'equivalente del `PluginHeader` del bridge). */
  const metodiDichiarati: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    checkPermissions: async () => ({ receive: 'granted' }),
    requestPermissions: async () => ({ receive: 'granted' }),
    createChannel: async () => undefined,
    register: async () => undefined,
    removeAllListeners: async () => undefined,
  }
  const addListener = async (evento: unknown, fn: unknown) => {
    const nome = String(evento)
    if (!ascoltatori.has(nome)) ascoltatori.set(nome, new Set())
    ascoltatori.get(nome)!.add(fn as (payload: unknown) => void)
    return { remove: async () => void ascoltatori.get(nome)?.delete(fn as (payload: unknown) => void) }
  }

  /** L'errore che `CapacitorException` porta con `ExceptionCode.Unimplemented`. */
  class CapacitorExceptionFinta extends Error {
    code = 'UNIMPLEMENTED'
  }

  function registerPluginFinto(nomePlugin: string): unknown {
    const createPluginMethodWrapper = (prop: string | symbol) => {
      const wrapper = (...args: unknown[]) => {
        const dichiarato = typeof prop === 'string' ? metodiDichiarati[prop] : undefined
        if (dichiarato) return dichiarato(...args)
        const errore = new CapacitorExceptionFinta(
          `"${nomePlugin}.${String(prop)}()" is not implemented on ${piattaforma.valore}`,
        )
        rifiutiBridge.push(errore.message)
        const rifiuto = Promise.reject(errore)
        // Il rifiuto resta tale per chi lo riceve; marcarlo gestito evita solo che vitest lo conti
        // come errore del controllo del banco, dove il rifiuto è proprio ciò che si vuole vedere.
        if (banco.silenziaRifiuti) rifiuto.catch(() => undefined)
        return rifiuto
      }
      wrapper.toString = () => `${String(prop)}() { [capacitor code] }`
      return wrapper
    }
    return new Proxy(
      {},
      {
        get(_, prop) {
          letture.push(String(prop))
          switch (prop) {
            case '$$typeof':
              return undefined
            case 'toJSON':
              return () => ({})
            case 'addListener':
              return addListener
            case 'removeListener':
              return createPluginMethodWrapper('removeListener')
            default:
              return createPluginMethodWrapper(prop)
          }
        },
      },
    )
  }

  return {
    piattaforma,
    ascoltatori,
    letture,
    rifiutiBridge,
    banco,
    plugin: registerPluginFinto('PushNotifications'),
    logClient: vi.fn(),
  }
})

vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: h.plugin }))
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => h.piattaforma.valore,
    isPluginAvailable: (nome: string) => nome === 'PushNotifications',
  },
}))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : 'errore'),
}))

/** Molto oltre il tempo reale di queste chiamate (microtask), molto sotto il timeout di vitest. */
const ATTESA_MAX_MS = 1_000
const SCADUTA = Symbol('scaduta')

function entro<T>(p: Promise<T>): Promise<T | typeof SCADUTA> {
  return Promise.race([p, new Promise<typeof SCADUTA>((r) => setTimeout(() => r(SCADUTA), ATTESA_MAX_MS))])
}

async function carica() {
  await import('@capacitor/push-notifications')
  return import('@/lib/push/native-register')
}

const messaggiLog = () => h.logClient.mock.calls.map(([e]) => (e as { messaggio: string }).messaggio)

beforeEach(() => {
  vi.resetModules()
  h.ascoltatori.clear()
  h.letture.length = 0
  h.rifiutiBridge.length = 0
  h.banco.silenziaRifiuti = false
  h.piattaforma.valore = 'android'
  h.logClient.mockReset()
  window.localStorage.clear()
  document.documentElement.lang = 'it'
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200 }) as Response),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('il finto è fedele a Capacitor (controllo del banco)', () => {
  it('una promise che si risolve CON il proxy non si chiude mai, e il bridge rifiuta `then`', async () => {
    // Se questo controllo cadesse, i test qui sotto sarebbero verdi anche col codice vecchio.
    h.banco.silenziaRifiuti = true
    const esito = await entro(Promise.resolve().then(() => h.plugin))
    expect(esito).toBe(SCADUTA)
    expect(h.letture).toContain('then')
    expect(h.rifiutiBridge).toEqual(['"PushNotifications.then()" is not implemented on android'])
  })

  it('il namespace del modulo invece attraversa `await` intatto', async () => {
    const modulo = await entro(import('@capacitor/push-notifications'))
    expect(modulo).not.toBe(SCADUTA)
    expect(h.letture).not.toContain('then')
  })
})

describe('registrazione push nativa con il plugin-proxy', () => {
  it.each(['android', 'ios'] as const)(
    'statoPermessoPush risponde su %s, e `then` non si legge mai sul plugin',
    async (piattaforma) => {
      h.piattaforma.valore = piattaforma
      const { statoPermessoPush } = await carica()
      expect(await entro(statoPermessoPush())).toBe('granted')
      expect(h.letture).toContain('checkPermissions')
      expect(h.letture).not.toContain('then')
      expect(messaggiLog().some((m) => m.includes('not implemented'))).toBe(false)
    },
  )

  it.each(['android', 'ios'] as const)(
    'registerNativePush arriva fino al token su %s (canale Android compreso)',
    async (piattaforma) => {
      h.piattaforma.valore = piattaforma
      const { registerNativePush } = await carica()
      const esito = registerNativePush('utente-finto')
      await vi.waitFor(() => expect(h.ascoltatori.get('registration')?.size ?? 0).toBe(1), {
        timeout: ATTESA_MAX_MS,
      })
      for (const fn of h.ascoltatori.get('registration') ?? []) fn({ value: 'token-finto' })
      expect(await entro(esito)).toEqual({ ok: true })
      if (piattaforma === 'android') expect(h.letture).toContain('createChannel')
      else expect(h.letture).not.toContain('createChannel')
      expect(h.letture).toContain('register')
      expect(h.letture).not.toContain('then')
      expect(messaggiLog().some((m) => m.includes('not implemented'))).toBe(false)
    },
  )

  // Il ramo di azzeramento di `caricaModuloPush` (giro 2 del critico): un import fallito NON resta in
  // cache. Senza l'azzeramento la seconda chiamata riceverebbe lo stesso rifiuto memorizzato e
  // l'avviso «notifiche disattivate» resterebbe spento per tutta la sessione.
  it('un import del modulo che fallisce si riprova alla chiamata dopo', async () => {
    let tentativi = 0
    vi.doMock('@capacitor/push-notifications', () => {
      tentativi += 1
      if (tentativi === 1) throw new Error('chunk-push-non-caricato')
      return { PushNotifications: h.plugin }
    })
    try {
      const { statoPermessoPush } = await import('@/lib/push/native-register')
      expect(await entro(statoPermessoPush())).toBe('non-disponibile')
      expect(messaggiLog().some((m) => m.startsWith('push-nativa-stato-permesso-illeggibile:'))).toBe(true)

      expect(await entro(statoPermessoPush())).toBe('granted')
      expect(tentativi).toBe(2)
      expect(h.letture).not.toContain('then')
    } finally {
      // Si rimette il finto di testa, non si smocka: `doUnmock` toglierebbe anche il `vi.mock` issato
      // e i test dopo questo importerebbero il plugin vero.
      vi.doMock('@capacitor/push-notifications', () => ({ PushNotifications: h.plugin }))
    }
  })

  it('due chiamate insieme rispondono entrambe, senza leggere `then` sul plugin', async () => {
    const { statoPermessoPush } = await carica()
    const [a, b] = await Promise.all([entro(statoPermessoPush()), entro(statoPermessoPush())])
    expect(a).toBe('granted')
    expect(b).toBe('granted')
    expect(h.letture).not.toContain('then')
  })
})
