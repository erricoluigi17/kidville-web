import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import pagamentiIt from '../../messages/it/pagamenti.json'

/**
 * `PushOptIn` — L'ESITO DELLA REGISTRAZIONE, GUARDATO (compito C1, 2026-09-30).
 *
 * ─── IL DIFETTO ─────────────────────────────────────────────────────────────────
 *
 * `enable()` faceva `await fetch('/api/push/subscribe', …)` e poi `setSubscribed(true)` SENZA
 * guardare `res.ok`. Il POST risponde 503 quando le chiavi VAPID non sono configurate (è il
 * suo ramo dichiarato) e 500 su un errore di scrittura: in tutti questi casi il pulsante
 * diventava verde con scritto «Promemoria attivi» e nessuna riga entrava in
 * `push_subscriptions` — «attive» a schermo, zero notifiche sul telefono.
 *
 * E non bastava mostrarlo: l'iscrizione DEL BROWSER restava. Al montaggio successivo
 * `getSubscription()` la ritrovava e il pulsante tornava a dire «attivi» da solo — il
 * messaggio d'errore valeva un render, la bugia da lì in avanti. Vale per il 503 **e** per il
 * POST caduto per RETE, che non passa nemmeno dal ramo `!res.ok`.
 *
 * ─── CHI LO USA ─────────────────────────────────────────────────────────────────
 *
 * I genitori (`StoricoPagamenti`) e la pagina «Coda fatture» dello staff. L'avviso in home
 * della docente NON lo usa: sul web rimanda all'app, perché su un PC condiviso l'iscrizione
 * sopravvive al logout e le notifiche — `mensa_allergia` compresa — arriverebbero a chi si
 * siede dopo. Le prop nate per quell'uso sono state rimosse, non lasciate «per sicurezza».
 *
 * ─── COSA SORVEGLIA QUESTO FILE ─────────────────────────────────────────────────
 *
 *  1. un POST non ok non dice «attive», e l'iscrizione nata nel tentativo si annulla;
 *  2. lo stesso quando il POST CADE PER RETE (il `catch`, non il ramo `!res.ok`);
 *  3. il messaggio distingue ciò che ha senso riprovare (5xx, rete) da ciò che no (503 di
 *     configurazione, 4xx): «riprova fra qualche istante» su una configurazione mancante è un
 *     invito a ripetere un gesto che non può riuscire;
 *  4. la chiave VAPID non disponibile si dice, e il POST non parte;
 *  5. il prompt chiuso o negato non inventa errori, e non manda niente al server.
 *
 * ⚠️ I GLOBALI SI RIPRISTINANO. `vi.unstubAllGlobals()` non annulla un
 * `Object.defineProperty(navigator, 'serviceWorker', …)`: senza il ripristino esplicito un
 * service worker finto resterebbe montato per i file che girano dopo nello stesso worker.
 */

const h = vi.hoisted(() => ({
  nativa: false,
  registerNativePush: vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string }),
  unregisterNativePush: vi.fn(async () => undefined),
  logClient: vi.fn(),
}))

vi.mock('@/lib/push/native-register', () => ({
  isNativeApp: () => h.nativa,
  registerNativePush: h.registerNativePush,
  unregisterNativePush: h.unregisterNativePush,
}))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  // La classe VERA: con un `() => 'TypeError'` fisso il test della classificazione degli
  // errori misurerebbe la costante del mock invece del codice.
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

import { PushOptIn } from '@/components/features/parent/pagamenti/PushOptIn'

const T = pagamentiIt as Record<string, string>
const UTENTE = 'aaaaaaaa-1111-4000-8000-000000000001'

const ORIGINALI = {
  serviceWorker: Object.getOwnPropertyDescriptor(navigator, 'serviceWorker'),
  PushManager: Object.getOwnPropertyDescriptor(window, 'PushManager'),
  Notification: Object.getOwnPropertyDescriptor(window, 'Notification'),
}

function ripristinaBrowser() {
  if (ORIGINALI.serviceWorker) Object.defineProperty(navigator, 'serviceWorker', ORIGINALI.serviceWorker)
  else delete (navigator as unknown as Record<string, unknown>).serviceWorker
  if (ORIGINALI.PushManager) Object.defineProperty(window, 'PushManager', ORIGINALI.PushManager)
  else delete (window as unknown as Record<string, unknown>).PushManager
  if (ORIGINALI.Notification) Object.defineProperty(window, 'Notification', ORIGINALI.Notification)
  else delete (window as unknown as Record<string, unknown>).Notification
}

/**
 * Un browser che si RICORDA: dopo un `subscribe()` riuscito `getSubscription()` restituisce
 * quell'iscrizione, e `unsubscribe()` la fa sparire. È la differenza fra un mock piatto e un
 * mock che può smentire il codice: con `getSubscription` fermo a `undefined` il caso del
 * rimontaggio non sarebbe nemmeno esprimibile.
 */
function browserConMemoria(iniziale: 'iscritto' | 'vuoto' = 'vuoto') {
  const sub = {
    endpoint: 'https://fcm.example/ep',
    toJSON: () => ({ endpoint: 'https://fcm.example/ep', keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => {
      corrente = undefined
      return true
    }),
  }
  let corrente: typeof sub | undefined = iniziale === 'iscritto' ? sub : undefined
  const pushManager = {
    getSubscription: vi.fn(async () => corrente),
    subscribe: vi.fn(async () => {
      corrente = sub
      return sub
    }),
  }
  const reg = { pushManager }
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: vi.fn(async () => reg),
      register: vi.fn(async () => reg),
      ready: Promise.resolve(reg),
    },
  })
  /** Un'altra scheda si è iscritta nel frattempo: `subscribe()` restituirà quella. */
  const iscrizioneDaAltraScheda = () => {
    corrente = sub
  }
  Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} })
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: { permission: 'default', requestPermission: vi.fn(async () => 'granted') },
  })
  return { sub, pushManager, iscrizioneDaAltraScheda }
}

/** Il browser che risponde al prompt con l'esito dato. */
function browserConRisposta(risposta: 'denied' | 'default') {
  const b = browserConMemoria()
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: { permission: 'default', requestPermission: vi.fn(async () => risposta) },
  })
  return b
}

/**
 * Il server. `post: 'rete'` non risponde: LANCIA, come fa `fetch` quando la richiesta non
 * parte (rete mobile caduta, app in background). È un cammino diverso dal 503 e arriva in un
 * altro ramo del codice.
 */
function server({ post = 201, vapid = 200 }: { post?: number | 'rete'; vapid?: number } = {}) {
  const finto = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    const metodo = init?.method ?? 'GET'
    if (u.includes('vapid-public-key')) {
      return new Response(vapid === 200 ? JSON.stringify({ data: { publicKey: 'BBBB' } }) : 'no', { status: vapid })
    }
    if (u.includes('/api/push/subscribe') && metodo === 'DELETE') {
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }
    if (u.includes('/api/push/subscribe')) {
      if (post === 'rete') throw new TypeError('Failed to fetch')
      return new Response(post === 201 ? JSON.stringify({ success: true }) : 'no', { status: post })
    }
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', finto)
  return finto
}

function iscrizioni(finto: ReturnType<typeof server>) {
  return finto.mock.calls.filter(
    ([u, init]) => String(u).includes('/api/push/subscribe') && ((init as RequestInit | undefined)?.method ?? 'GET') === 'POST',
  )
}

beforeEach(() => {
  h.nativa = false
  h.registerNativePush.mockReset()
  h.registerNativePush.mockResolvedValue({ ok: true })
  h.unregisterNativePush.mockReset()
  h.unregisterNativePush.mockResolvedValue(undefined)
  h.logClient.mockReset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  ripristinaBrowser()
})

describe('PushOptIn — l esito della registrazione', () => {
  it('web: il POST risponde 503 → NON dice «attivi» e lo dichiara (senza invitare a riprovare)', async () => {
    browserConMemoria()
    server({ post: 503 })
    render(<PushOptIn userId={UTENTE} />)

    fireEvent.click(await screen.findByRole('button', { name: T.attivaPromemoria }))
    // 503 = «VAPID non configurato»: è una configurazione mancante, non un intoppo.
    expect(await screen.findByText(T.pushAttivazioneNonPossibile)).toBeTruthy()
    expect(screen.queryByText(T.pushAttivazioneNonRiuscita)).toBeNull()
    expect(screen.queryByRole('button', { name: T.promemoriaAttivi })).toBeNull()
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ evento: 'fetch', stato: 503, messaggio: 'push-optin-registrazione-rifiutata' }),
    )
  })

  it('web: un 500 invita a riprovare (è ritentabile), un 401 no', async () => {
    browserConMemoria()
    server({ post: 500 })
    const primo = render(<PushOptIn userId={UTENTE} />)
    fireEvent.click(await screen.findByRole('button', { name: T.attivaPromemoria }))
    expect(await screen.findByText(T.pushAttivazioneNonRiuscita)).toBeTruthy()
    primo.unmount()

    server({ post: 401 })
    render(<PushOptIn userId={UTENTE} />)
    fireEvent.click(await screen.findByRole('button', { name: T.attivaPromemoria }))
    expect(await screen.findByText(T.pushAttivazioneNonPossibile)).toBeTruthy()
  })

  it('🔴 dopo un 503 l iscrizione del browser è ANNULLATA: al rimontaggio non dice «attivi»', async () => {
    const { sub } = browserConMemoria()
    server({ post: 503 })
    const primo = render(<PushOptIn userId={UTENTE} />)
    fireEvent.click(await screen.findByRole('button', { name: T.attivaPromemoria }))
    await screen.findByText(T.pushAttivazioneNonPossibile)
    await waitFor(() => expect(sub.unsubscribe).toHaveBeenCalledTimes(1))
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ messaggio: 'push-optin-iscrizione-annullata-dopo-rifiuto', campi: { esito: 'annullata' } }),
    )
    primo.unmount()

    render(<PushOptIn userId={UTENTE} />)
    expect(await screen.findByRole('button', { name: T.attivaPromemoria })).toBeTruthy()
    expect(screen.queryByRole('button', { name: T.promemoriaAttivi })).toBeNull()
  })

  it('🔴 il POST che CADE PER RETE: lo dice, annulla l iscrizione nata ora, e al rimontaggio non mente', async () => {
    // L'altra forma dello stesso fallimento: `fetch` lancia, quindi il ramo `!res.ok` non
    // viene mai raggiunto. Prima non c'era né messaggio né annullamento.
    const { sub } = browserConMemoria()
    server({ post: 'rete' })
    const primo = render(<PushOptIn userId={UTENTE} />)

    fireEvent.click(await screen.findByRole('button', { name: T.attivaPromemoria }))
    // Una rete caduta è ritentabile per definizione.
    expect(await screen.findByText(T.pushAttivazioneNonRiuscita)).toBeTruthy()
    await waitFor(() => expect(sub.unsubscribe).toHaveBeenCalledTimes(1))
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ messaggio: 'push-optin-fallito: TypeError' }),
    )
    primo.unmount()

    render(<PushOptIn userId={UTENTE} />)
    expect(await screen.findByRole('button', { name: T.attivaPromemoria })).toBeTruthy()
  })

  it('🔴 429 e 408 sono ritentabili (come nel canale dei log), il 503 di configurazione no', async () => {
    // Il commento prometteva «la stessa regola di `ritentabile` in `@/lib/logging/client`» e
    // il codice non trattava 429/408: ora la regola è una funzione sola
    // (`statoHttpRitentabile`), con l'eccezione del 503 scritta accanto.
    for (const stato of [429, 408]) {
      browserConMemoria()
      server({ post: stato })
      const giro = render(<PushOptIn userId={UTENTE} />)
      fireEvent.click(await screen.findByRole('button', { name: T.attivaPromemoria }))
      expect(await screen.findByText(T.pushAttivazioneNonRiuscita)).toBeTruthy()
      giro.unmount()
    }
  })

  it('🔴 `subscribe()` rifiutato dal browser NON è «riprova»: è definitivo', async () => {
    // `NotAllowedError` (permesso negato) e `InvalidStateError` (chiavi che non combaciano)
    // arrivano nel `catch` come una rete caduta, ma riprovare non cambierebbe niente.
    browserConMemoria()
    server()
    const reg = await navigator.serviceWorker.getRegistration()
    const rifiuto = Object.assign(new Error('registration failed'), { name: 'NotAllowedError' })
    vi.spyOn(reg!.pushManager, 'subscribe').mockRejectedValue(rifiuto)
    render(<PushOptIn userId={UTENTE} />)

    fireEvent.click(await screen.findByRole('button', { name: T.attivaPromemoria }))
    expect(await screen.findByText(T.pushAttivazioneNonPossibile)).toBeTruthy()
    expect(screen.queryByText(T.pushAttivazioneNonRiuscita)).toBeNull()
  })

  it('🔴 un iscrizione GIÀ PRESENTE non si annulla quando il POST fallisce', async () => {
    // `subscribe()` restituisce quella che c'è se le chiavi coincidono: può essere di un'altra
    // SCHEDA dello stesso browser (o di un'altra persona su un PC condiviso) e funzionare.
    // Annullarla per un guasto avvenuto qui spegnerebbe le notifiche a chi non ha fatto
    // niente. «Nata ora» si decide quindi con un `getSubscription()` PRIMA di `subscribe()`.
    const { sub, iscrizioneDaAltraScheda } = browserConMemoria()
    server({ post: 500 })
    render(<PushOptIn userId={UTENTE} />)
    const bottone = await screen.findByRole('button', { name: T.attivaPromemoria })

    // Fra il montaggio e il tocco, l'altra scheda si è iscritta.
    iscrizioneDaAltraScheda()
    fireEvent.click(bottone)

    expect(await screen.findByText(T.pushAttivazioneNonRiuscita)).toBeTruthy()
    expect(sub.unsubscribe).not.toHaveBeenCalled()
  })

  it('web: il POST risponde 201 → «attivi», senza messaggi d errore', async () => {
    browserConMemoria()
    server()
    render(<PushOptIn userId={UTENTE} />)

    fireEvent.click(await screen.findByRole('button', { name: T.attivaPromemoria }))
    expect(await screen.findByRole('button', { name: T.promemoriaAttivi })).toBeTruthy()
    expect(screen.queryByText(T.pushAttivazioneNonRiuscita)).toBeNull()
    expect(screen.queryByText(T.pushAttivazioneNonPossibile)).toBeNull()
  })

  it('web: la chiave VAPID non disponibile (503) si DICE, e il POST non parte nemmeno', async () => {
    browserConMemoria()
    const finto = server({ vapid: 503 })
    render(<PushOptIn userId={UTENTE} />)

    fireEvent.click(await screen.findByRole('button', { name: T.attivaPromemoria }))
    expect(await screen.findByText(T.pushAttivazioneNonPossibile)).toBeTruthy()
    expect(iscrizioni(finto)).toHaveLength(0)
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ stato: 503, messaggio: 'push-optin-chiave-vapid-non-disponibile' }),
    )
  })

  it('web: il «no» al prompt non manda niente al server e non inventa un errore', async () => {
    const { pushManager } = browserConRisposta('denied')
    const finto = server()
    render(<PushOptIn userId={UTENTE} />)

    fireEvent.click(await screen.findByRole('button', { name: T.attivaPromemoria }))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: T.attivaPromemoria }) as HTMLButtonElement).disabled).toBe(false),
    )
    expect(iscrizioni(finto)).toHaveLength(0)
    expect(pushManager.subscribe).not.toHaveBeenCalled()
    expect(screen.queryByText(T.pushAttivazioneNonRiuscita)).toBeNull()
    expect(screen.queryByText(T.pushAttivazioneNonPossibile)).toBeNull()
  })

  it('web: il prompt CHIUSO senza scegliere (`default`) lascia il pulsante com era', async () => {
    browserConRisposta('default')
    server()
    render(<PushOptIn userId={UTENTE} />)
    fireEvent.click(await screen.findByRole('button', { name: T.attivaPromemoria }))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: T.attivaPromemoria }) as HTMLButtonElement).disabled).toBe(false),
    )
    expect(screen.queryByRole('button', { name: T.promemoriaAttivi })).toBeNull()
  })

  it('nativa: un timeout della registrazione invita a riprovare; un permesso negato no', async () => {
    h.nativa = true
    h.registerNativePush.mockResolvedValue({ ok: false, error: 'registration_timeout' })
    const primo = render(<PushOptIn userId={UTENTE} />)
    fireEvent.click(screen.getByRole('button', { name: T.attivaPromemoria }))
    expect(await screen.findByText(T.pushAttivazioneNonRiuscita)).toBeTruthy()
    primo.unmount()

    h.registerNativePush.mockResolvedValue({ ok: false, error: 'permission_denied' })
    render(<PushOptIn userId={UTENTE} />)
    fireEvent.click(screen.getByRole('button', { name: T.attivaPromemoria }))
    expect(await screen.findByText(T.pushAttivazioneNonPossibile)).toBeTruthy()
  })

  it('nativa: `{ ok: true }` → «attivi»', async () => {
    h.nativa = true
    render(<PushOptIn userId={UTENTE} />)
    fireEvent.click(screen.getByRole('button', { name: T.attivaPromemoria }))
    expect(await screen.findByRole('button', { name: T.promemoriaAttivi })).toBeTruthy()
  })

  it('la disattivazione web cancella dal server e disiscrive il browser', async () => {
    const { sub } = browserConMemoria('iscritto')
    const finto = server()
    render(<PushOptIn userId={UTENTE} />)

    fireEvent.click(await screen.findByRole('button', { name: T.promemoriaAttivi }))
    await waitFor(() => expect(sub.unsubscribe).toHaveBeenCalledTimes(1))
    const cancellazioni = finto.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')
    expect(cancellazioni).toHaveLength(1)
    expect(await screen.findByRole('button', { name: T.attivaPromemoria })).toBeTruthy()
  })

  it('con `etichette` (la «Coda fatture» dello staff) i testi sono quelli passati', async () => {
    h.nativa = true
    render(<PushOptIn userId={UTENTE} etichette={{ attiva: 'A', attive: 'B' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    expect(await screen.findByRole('button', { name: 'B' })).toBeTruthy()
  })
})
