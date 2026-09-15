import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * IL TOCCO SU UNA PUSH NATIVA, E IL DEEP LINK kidville:// (parte C, 2026-09-15).
 *
 * Fino a oggi la shell nativa faceva una cosa sola con il link di una notifica:
 * `if (url.startsWith('/')) navigate(url)`. Tre difetti in una riga:
 *  · sulla pagina chat già aperta navigava allo stesso pathname, e in Next 16 una push allo stesso
 *    URL non rimonta la pagina né cambia `searchParams`: il ritocco della stessa notifica non apriva
 *    niente. La conversazione si apre con l'evento `kv:chat-apri-thread`, che la pagina ascolta;
 *  · a una insegnante che è anche mamma, in veste di docente, il link `/parent/chat?thread=…` faceva
 *    cambiare area, e la guardia d'area la rimandava alla home: la conversazione andava persa;
 *  · `'//evil.example'.startsWith('/')` è vero, e per il browser `//evil.example` è un altro sito.
 *
 * Qui si prova che il tocco e il deep link passano dalla regola UNICA di `link-conversazione.ts`
 * (tramite `apriLinkNotifica`), montando la shell vera con i plugin finti. Il modulo dell'apertura è
 * quello vero: la pagina chat «montata» è un ascoltatore vero di `ascoltaAperturaThread`.
 */

const appAddListener = vi.hoisted(() => vi.fn())
vi.mock('@capacitor/app', () => ({ App: { addListener: appAddListener, exitApp: vi.fn(async () => undefined) } }))

const pushAddListener = vi.hoisted(() => vi.fn())
vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: { addListener: pushAddListener } }))

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'ios', isNativePlatform: () => true },
}))
vi.mock('@capacitor/status-bar', () => ({
  StatusBar: {
    setStyle: vi.fn(async () => undefined),
    setOverlaysWebView: vi.fn(async () => undefined),
    setBackgroundColor: vi.fn(async () => undefined),
  },
  Style: { Dark: 'DARK' },
}))
// Lo splash e la barra di stato hanno i loro test: qui farebbero solo rumore asincrono nei log.
vi.mock('@/lib/mobile/splash', () => ({ nascondiSplashNativo: vi.fn(async () => undefined) }))
vi.mock('@/lib/mobile/status-bar', () => ({ applicaStiloStatusBar: vi.fn(async () => undefined) }))

const logClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', () => ({ logClient, nomeErrore: (e: unknown) => (e as Error).name }))

import { setupNativeShell } from '@/lib/mobile/native-shell'
import { ascoltaAperturaThread } from '@/lib/chat/apertura-thread'

const T = 'dddddddd-0000-4000-8000-000000000031'
const RIFIUTO = 'notifica-link-rifiutato: non interno'

type GestoreTocco = (azione: { actionId: string; notification: { data?: unknown } }) => void
type GestoreDeepLink = (evento: { url: string }) => void

const navigate = vi.fn()

/** Monta la shell e restituisce i due gestori che ha registrato. */
async function montaShell(): Promise<{ tocco: GestoreTocco; deepLink: GestoreDeepLink }> {
  await setupNativeShell(navigate)
  const tocco = pushAddListener.mock.calls.find(([evento]) => evento === 'pushNotificationActionPerformed')?.[1]
  const deepLink = appAddListener.mock.calls.find(([evento]) => evento === 'appUrlOpen')?.[1]
  if (!tocco || !deepLink) throw new Error('setupNativeShell non ha registrato il tocco sulla push o il deep link')
  return { tocco: tocco as GestoreTocco, deepLink: deepLink as GestoreDeepLink }
}

const toccaCon = (url: unknown) => ({ actionId: 'tap', notification: { data: { url } } })

/** Le pagine chat «montate» nel test: si smontano tutte dopo, il contatore dell'apertura è di modulo. */
const pagineMontate: Array<() => void> = []
function paginaChatMontata() {
  const gestore = vi.fn()
  pagineMontate.push(ascoltaAperturaThread(gestore))
  return gestore
}

const suPagina = (percorso: string) => window.history.replaceState(null, '', percorso)

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  while (pagineMontate.length) pagineMontate.pop()!()
  suPagina('/')
})

describe('tocco su una push nativa: passa dalla regola dei link di notifica', () => {
  it('sulla pagina chat aperta la conversazione si apre con l’evento, senza navigare', async () => {
    const { tocco } = await montaShell()
    suPagina('/parent/chat')
    const pagina = paginaChatMontata()

    tocco(toccaCon(`/parent/chat?thread=${T}`))

    expect(pagina).toHaveBeenCalledWith(T)
    expect(navigate).not.toHaveBeenCalled()
    expect(logClient).not.toHaveBeenCalled()
  })

  it('da un’altra area (chi ha due profili) si naviga alla chat dell’area in cui si è', async () => {
    const { tocco } = await montaShell()

    suPagina('/teacher')
    tocco(toccaCon(`/parent/chat?thread=${T}`))
    expect(navigate).toHaveBeenLastCalledWith(`/teacher/chat?thread=${T}`)

    // Controllo positivo: un link che non è di chat arriva com'è.
    suPagina('/parent')
    tocco(toccaCon('/parent/avvisi'))
    expect(navigate).toHaveBeenLastCalledWith('/parent/avvisi')
    expect(navigate).toHaveBeenCalledTimes(2)
    expect(logClient).not.toHaveBeenCalled()
  })

  it('un link che non è di questa app non apre niente, e lo registra senza l’URL', async () => {
    const { tocco } = await montaShell()
    suPagina('/parent/chat')
    const pagina = paginaChatMontata()

    // Tutti e quattro, letti dal browser, portano su evil.example.
    tocco(toccaCon(`//evil.example/parent/chat?thread=${T}`))
    tocco(toccaCon('/\\evil.example/x'))
    tocco(toccaCon('/\t/evil.example'))
    tocco(toccaCon('https://evil.example/x'))

    expect(navigate).not.toHaveBeenCalled()
    expect(pagina).not.toHaveBeenCalled()
    expect(logClient).toHaveBeenCalledTimes(4)
    for (const [voce] of logClient.mock.calls) {
      expect(voce).toMatchObject({ livello: 'warn', evento: 'push', messaggio: RIFIUTO })
    }
    const scritto = JSON.stringify(logClient.mock.calls)
    expect(scritto).not.toContain('evil')
    expect(scritto).not.toContain(T)
  })

  it('una push senza link apre l’app e basta: niente navigazione, niente log (presidio)', async () => {
    const { tocco } = await montaShell()
    suPagina('/parent')

    tocco({ actionId: 'tap', notification: {} })
    tocco({ actionId: 'tap', notification: { data: { url: 42 } } })

    expect(navigate).not.toHaveBeenCalled()
    expect(logClient).not.toHaveBeenCalled()
  })
})

describe('deep link kidville://: la stessa regola', () => {
  it('kidville://parent/chat?thread=… sulla pagina chat apre la conversazione senza navigare', async () => {
    const { deepLink } = await montaShell()
    suPagina('/parent/chat')
    const pagina = paginaChatMontata()

    deepLink({ url: `kidville://parent/chat?thread=${T}` })

    expect(pagina).toHaveBeenCalledWith(T)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('kidville://parent/agenda naviga a /parent/agenda, come prima (controllo positivo)', async () => {
    const { deepLink } = await montaShell()
    suPagina('/parent')

    deepLink({ url: 'kidville://parent/agenda' })
    deepLink({ url: 'kidville:///parent/agenda' })

    expect(navigate.mock.calls).toEqual([['/parent/agenda'], ['/parent/agenda']])
    expect(logClient).not.toHaveBeenCalled()
  })

  it('un deep link che il browser leggerebbe come un altro sito si rifiuta, e si registra', async () => {
    const { deepLink } = await montaShell()
    suPagina('/parent')

    // '/' + '\evil.example' e '/' + '\t/evil.example': per il browser, //evil.example.
    deepLink({ url: 'kidville://\\evil.example' })
    deepLink({ url: 'kidville:///\\evil.example' })
    deepLink({ url: 'kidville://\t/evil.example' })

    expect(navigate).not.toHaveBeenCalled()
    expect(logClient).toHaveBeenCalledTimes(3)
    expect(logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'warn', evento: 'push', messaggio: RIFIUTO }))
    expect(JSON.stringify(logClient.mock.calls)).not.toContain('evil')
  })
})
