import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// =============================================================================
// IL PUSH WEB (VAPID) ERA L'ULTIMO PROVIDER FUORI DA `externalFetch`.
//
// IL DIFETTO, nella sua forma esatta — che è la forma del guasto storico di questo
// repo (per mesi zero email di credenziali consegnate, perché il codice registrava
// `403` e buttava via il corpo che diceva «the domain is not verified»):
//
//     catch (err: unknown) {
//       const statusCode = (err as { statusCode?: number })?.statusCode
//       if (statusCode === 410 || statusCode === 404) return { ok:false, gone:true }
//       return { ok:false, error: (err as Error)?.message }
//     }
//
// Il catch NON LOGGAVA. Teneva solo `err.message`, scartava `err.statusCode` (tranne
// 410/404) e scartava del tutto `err.body` — cioè il testo con cui il push service
// dice PERCHÉ ha rifiutato («the VAPID key is not authorized», «payload too large»,
// «Unauthorized Registration»). E il ramo «chiavi assenti» usciva muto.
//
// A valle, `push/dispatch` usa solo `ok`/`gone`: un rifiuto qualunque non
// incrementava nessun contatore e la notifica veniva marcata `push_inviata_il`
// comunque. Zero push consegnate, zero righe, nessun ritentativo.
//
// COME SI PROVA CHE IL CORPO NON SI BUTTA PIÙ VIA. `externalFetch` NON è mockato:
// si mocka `globalThis.fetch`, così la catena vera (leggi il corpo → mettilo nel
// messaggio dell'errore → logga → propaga) viene esercitata per davvero. Se
// qualcuno reintroducesse un `fetch` nudo o un catch che tiene il solo status, il
// corpo sparirebbe dall'errore passato al logger e questi test diventerebbero rossi.
// =============================================================================

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

const h = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  generateRequestDetails: vi.fn(),
}))
vi.mock('web-push', () => ({
  default: { setVapidDetails: h.setVapidDetails, generateRequestDetails: h.generateRequestDetails },
}))

const SUB = { endpoint: 'https://push.example/ep/abc', p256dh: 'p', auth: 'a' }
const PAYLOAD = { title: 'Ciao' }

/** I dettagli che `web-push` produce davvero: endpoint + header VAPID + corpo cifrato. */
const DETTAGLI = () => ({
  method: 'POST' as const,
  endpoint: SUB.endpoint,
  headers: {
    TTL: '2419200',
    'Content-Length': '119',
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    Authorization: 'vapid t=jwt, k=chiave',
  },
  body: Buffer.from('corpo-cifrato'),
})

/** Il modulo memoizza la configurazione VAPID → import fresco in ogni test. */
async function freshModule() {
  vi.resetModules()
  return import('@/lib/push/web-push')
}

/** Le righe emesse sul canale, per livello. */
function righe(livello: string): Array<{ evento: string; campi: Record<string, unknown>; err: unknown }> {
  return log.logEvento.mock.calls
    .filter((c) => c[1] === livello)
    .map((c) => ({ evento: c[0] as string, campi: c[2] as Record<string, unknown>, err: c[3] }))
}

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  h.generateRequestDetails.mockImplementation(() => DETTAGLI())
  fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  delete process.env.VAPID_PRIVATE_KEY
})

// ═════════════════════════════════════════════════════════════════════════════
describe('chiavi VAPID assenti — configurazione mancante NON è una nota a piè di pagina', () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY
  })

  it('vapidConfigured() è false', async () => {
    const { vapidConfigured } = await freshModule()
    expect(vapidConfigured()).toBe(false)
  })

  it('sendPush degrada SENZA lanciare, ma lascia una riga `error` che nomina le variabili', async () => {
    const { sendPush } = await freshModule()

    expect(await sendPush(SUB, PAYLOAD)).toEqual({ ok: false, error: 'vapid_non_configurato' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(h.setVapidDetails).not.toHaveBeenCalled()

    // AGENTS, regola 4: configurazione mancante = livello `error`, MAI `info`. Una
    // notifica a una famiglia che non parte perché mancano le chiavi è un incidente.
    const errori = righe('error')
    expect(errori).toHaveLength(1)
    expect(errori[0].evento).toBe('config')
    expect(errori[0].campi).toMatchObject({ operazione: 'sendPush', provider: 'web-push', esito: 'mancante' })
    // I NOMI delle variabili devono arrivare in `app_log.messaggio`: `redact()` è a
    // lista bianca per chiave, quindi come campo uscirebbero `[redatto:str/N]`.
    // Passati come errore, `descriviErrore` li porta in chiaro nella colonna vera.
    const msg = String((errori[0].err as { message?: unknown })?.message ?? '')
    expect(msg).toContain('VAPID_PRIVATE_KEY')
    expect(msg).toContain('NEXT_PUBLIC_VAPID_PUBLIC_KEY')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('chiavi VAPID presenti — il provider passa da externalFetch', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'pub-key'
    process.env.VAPID_PRIVATE_KEY = 'priv-key'
  })

  it('vapidConfigured() è true', async () => {
    const { vapidConfigured } = await freshModule()
    expect(vapidConfigured()).toBe(true)
  })

  it('invio riuscito → { ok:true } e IL SUCCESSO SI LOGGA (evento `push`, quindi in tabella)', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 201 }))
    const { sendPush } = await freshModule()

    expect(await sendPush(SUB, PAYLOAD)).toEqual({ ok: true })

    // Il battito di successo (AGENTS, regola 5): senza, «nessun log» non distingue
    // «tutte consegnate» da «non è mai partito niente».
    const info = righe('info')
    expect(info).toHaveLength(1)
    expect(info[0].evento).toBe('push')
    expect(info[0].campi).toMatchObject({ provider: 'web-push', piattaforma: 'web', stato: 201 })
  })

  it('la richiesta porta gli header VAPID, e NON il Content-Length calcolato a mano', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 201 }))
    const { sendPush } = await freshModule()
    await sendPush(SUB, PAYLOAD)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(SUB.endpoint)
    expect(init.method).toBe('POST')
    const intestazioni = init.headers as Record<string, string>
    expect(intestazioni.Authorization).toBe('vapid t=jwt, k=chiave')
    expect(intestazioni['Content-Encoding']).toBe('aes128gcm')
    // `Content-Length` lo calcola `fetch` dal corpo: passarlo a mano è un doppione
    // che può divergere dal corpo vero.
    expect(Object.keys(intestazioni).map((k) => k.toLowerCase())).not.toContain('content-length')
    // Il corpo cifrato arriva davvero (non `undefined`, non la stringa JSON in chiaro).
    expect(init.body).toBeInstanceOf(ArrayBuffer)
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('corpo-cifrato')
  })

  it('410 → { ok:false, gone:true }, e resta a livello `info` (una app disinstallata non è un guasto)', async () => {
    fetchSpy.mockResolvedValue(new Response('push subscription has unsubscribed or expired', { status: 410 }))
    const { sendPush } = await freshModule()

    expect(await sendPush(SUB, PAYLOAD)).toEqual({ ok: false, gone: true })
    // Non deve emettere un Error nativo su console per ogni genitore che disinstalla:
    // inquinerebbe il raggruppamento di `get_runtime_errors`. Si conta, non allarma.
    expect(righe('error')).toHaveLength(0)
    expect(righe('info')).toHaveLength(1)
    expect(righe('info')[0].campi).toMatchObject({ provider: 'web-push', stato: 410 })
  })

  it('404 → { ok:false, gone:true } (subscription sconosciuta)', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 404 }))
    const { sendPush } = await freshModule()
    expect(await sendPush(SUB, PAYLOAD)).toEqual({ ok: false, gone: true })
  })

  it('403 → IL CORPO DEL PROVIDER FINISCE NEL LOG E NELL\'ESITO, non solo lo status', async () => {
    // È il test che giustifica tutto il resto. `403` non dice nulla;
    // `403 "the VAPID key is not authorized for this endpoint"` chiude il caso.
    const corpo = 'the VAPID key is not authorized for this endpoint'
    fetchSpy.mockResolvedValue(new Response(corpo, { status: 403 }))
    const { sendPush } = await freshModule()

    const res = await sendPush(SUB, PAYLOAD)
    expect(res.ok).toBe(false)
    expect(res.gone).toBeUndefined()
    // L'esito che il chiamante può mettere nel proprio audit: status E corpo.
    expect(res.error).toContain('403')
    expect(res.error).toContain('the VAPID key is not authorized')

    const errori = righe('error')
    expect(errori).toHaveLength(1)
    expect(errori[0].evento).toBe('push')
    expect(errori[0].campi).toMatchObject({ provider: 'web-push', stato: 403 })
    // Il corpo è il MESSAGGIO dell'errore passato al logger (non un campo `corpo`,
    // che `redact` renderebbe `[redatto:str/N]` proprio nel canale che dura 30 giorni).
    expect(String((errori[0].err as { message?: unknown })?.message ?? '')).toContain(corpo)
    expect((errori[0].err as { code?: unknown })?.code).toBe('403')
  })

  it('413 payload troppo grande → esito parlante e riga `error` col corpo', async () => {
    fetchSpy.mockResolvedValue(new Response('payload too large', { status: 413 }))
    const { sendPush } = await freshModule()

    const res = await sendPush(SUB, PAYLOAD)
    expect(res).toMatchObject({ ok: false })
    expect(res.error).toContain('payload too large')
    expect(righe('error')).toHaveLength(1)
  })

  it('rete giù → nessuna eccezione fuori, e la riga esiste col messaggio vero', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNRESET'))
    const { sendPush } = await freshModule()

    const res = await sendPush(SUB, PAYLOAD)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('ECONNRESET')
    const errori = righe('error')
    expect(errori).toHaveLength(1)
    expect(errori[0].evento).toBe('push')
  })

  it('cifratura fallita (chiave p256dh malformata) → riga `error`, mai un\'eccezione muta', async () => {
    // `generateRequestDetails` LANCIA su una subscription malformata. Prima quel throw
    // finiva nel catch che non loggava: zero push, zero tracce.
    h.generateRequestDetails.mockImplementation(() => {
      throw new Error('Value should be a base64url encoded string')
    })
    const { sendPush } = await freshModule()

    const res = await sendPush(SUB, PAYLOAD)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('base64url')
    expect(fetchSpy).not.toHaveBeenCalled()
    const errori = righe('error')
    expect(errori).toHaveLength(1)
    expect(errori[0].campi).toMatchObject({ provider: 'web-push', esito: 'cifratura-fallita' })
  })

  it('configura VAPID una volta sola (memoizzazione preservata)', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 201 }))
    const { sendPush } = await freshModule()
    await sendPush(SUB, PAYLOAD)
    await sendPush(SUB, PAYLOAD)
    expect(h.setVapidDetails).toHaveBeenCalledTimes(1)
  })
})
