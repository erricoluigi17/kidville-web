import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'

// Il modulo legge le credenziali da process.env → import fresco in ogni test.
async function freshModule() {
  vi.resetModules()
  return import('@/lib/push/native-push')
}

describe('native-push (FCM) — gating e degrado', () => {
  beforeEach(() => {
    delete process.env.FCM_PROJECT_ID
    delete process.env.FCM_CLIENT_EMAIL
    delete process.env.FCM_PRIVATE_KEY
    vi.restoreAllMocks()
  })

  it('fcmConfigured() è false senza credenziali', async () => {
    const { fcmConfigured } = await freshModule()
    expect(fcmConfigured()).toBe(false)
  })

  it('fcmConfigured() è true con tutte le credenziali', async () => {
    process.env.FCM_PROJECT_ID = 'proj'
    process.env.FCM_CLIENT_EMAIL = 'svc@proj.iam'
    process.env.FCM_PRIVATE_KEY = 'key'
    const { fcmConfigured } = await freshModule()
    expect(fcmConfigured()).toBe(true)
  })

  it('sendNativePush senza credenziali → { ok:false, error:fcm_non_configurato } e nessuna fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { sendNativePush } = await freshModule()
    const res = await sendNativePush('token-abc', 'android', { title: 'Ciao', url: '/x' })
    expect(res).toEqual({ ok: false, error: 'fcm_non_configurato' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sendNativePush non lancia mai, anche con credenziali non valide', async () => {
    process.env.FCM_PROJECT_ID = 'proj'
    process.env.FCM_CLIENT_EMAIL = 'svc@proj.iam'
    process.env.FCM_PRIVATE_KEY = 'chiave-non-valida' // la firma RS256 fallirà → catch → esito pulito
    const { sendNativePush } = await freshModule()
    const res = await sendNativePush('token-abc', 'ios', { title: 'x' })
    expect(res.ok).toBe(false)
    expect(typeof res.error).toBe('string')
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * IL GUASTO MUTO — «non lancia mai» non vuol dire «non tace mai».
 *
 * I test qui sopra dimostrano che con una chiave malformata `sendNativePush` degrada pulito.
 * È esattamente ciò che rendeva il difetto invisibile: il catch finale inghiottiva l'eccezione,
 * restituiva un esito che in `push/dispatch` non è né `ok` né `gone` — quindi NESSUNA riga — e
 * il battito del cron continuava a dire `esito:'ok'` con `native_inviate: 0`.
 *
 * Zero push consegnate, zero righe, nessun test rosso: il guasto delle email di credenziali,
 * riprodotto tale e quale. Questi test sono la sveglia (AGENTS, regola 6).
 *
 * COME SI OSSERVA. Il logger è SILENZIOSO sotto vitest (guardia valutata al CARICAMENTO del
 * modulo) e `.env.local` punta al DB di PRODUZIONE: si ricarica il grafo con `VITEST=''` e
 * `app-log` MOCKATO, così si vede la riga vera — console + riga persistita — senza toccare
 * nessun database. È lo schema di `logging-external.test.ts`.
 * ════════════════════════════════════════════════════════════════════════════ */

type Riga = Record<string, unknown>

let appLog: ReturnType<typeof vi.fn>
let consoleErr: ReturnType<typeof vi.spyOn>

async function caricaOsservabile() {
  appLog = vi.fn(async () => {})
  vi.resetModules()
  vi.doMock('@/lib/logging/app-log', () => ({ appLog }))
  return import('@/lib/push/native-push')
}

/** L'ultima riga PERSISTITA: quella che finirebbe in `app_log`, cioè l'unica interrogabile in SQL. */
async function ultimaRiga(): Promise<Riga> {
  await vi.waitFor(() => expect(appLog.mock.calls.length).toBeGreaterThan(0))
  return appLog.mock.calls[appLog.mock.calls.length - 1][0] as Riga
}

// Una chiave RSA vera serve solo dove la firma deve RIUSCIRE (il caso del corpo non-JSON):
// generarla una volta sola, non per test — `generateKeyPairSync` a 2048 bit non è gratis.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

describe('native-push — un catch che non logga è un bug (AGENTS, regola 6)', () => {
  beforeEach(() => {
    vi.stubEnv('VITEST', '')
    vi.stubEnv('KV_LOG_LEVEL', '')
    vi.stubEnv('FCM_PROJECT_ID', 'kidville')
    vi.stubEnv('FCM_CLIENT_EMAIL', 'svc@kidville.iam.gserviceaccount.com')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.doUnmock('@/lib/logging/app-log')
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('PEM malformato: l\'eccezione non si inghiotte più, finisce in tabella con lo stack', async () => {
    // Lo scenario dimostrato: la variabile C'È (fcmConfigured() è true), ma il PEM è rotto —
    // un incolla troncato, i `\n` non normalizzati. `crypto.createSign(…).sign()` LANCIA dentro
    // `getAccessToken()`, e prima l'eccezione moriva qui senza lasciare traccia.
    vi.stubEnv('FCM_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nnon-una-chiave\n-----END PRIVATE KEY-----')
    const { sendNativePush } = await caricaOsservabile()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await sendNativePush('token-abc', 'ios', { title: 'x' })

    // Il contratto verso il chiamante NON cambia: degrada, non lancia, e non è `gone`
    // (la subscription è sana: è la NOSTRA chiave a essere rotta — cancellarla sarebbe il danno
    // sopra il guasto).
    expect(res.ok).toBe(false)
    expect(res.gone).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled() // non si è mai arrivati alla rete

    // Ma ora la riga c'è, ed è un ERRORE: interrogabile in SQL, con l'evento giusto.
    const riga = await ultimaRiga()
    expect(riga.livello).toBe('error')
    expect(riga.evento).toBe('push') // `push` è in EVENTI_PERSISTITI
    // L'errore VERO, non un'etichetta nostra: è ciò che dice CHE COSA è rotto.
    expect(String(riga.messaggio)).not.toBe('')
    expect(String(riga.messaggio)).not.toContain('[campo-illeggibile]')
    // E lo stack, che dice DOVE ha lanciato (la firma RS256, non la rete).
    expect(typeof riga.stack).toBe('string')

    // Su console esce anche l'Error nativo: è ciò su cui `get_runtime_errors` raggruppa.
    expect(consoleErr).toHaveBeenCalled()
    const testo = consoleErr.mock.calls.flat().map(String).join('\n')
    expect(testo).toContain('KV_ERR')
    expect(testo).toContain('provider=fcm')
  })

  it('e l\'esito non è più un numero muto: porta il messaggio dell\'errore vero', async () => {
    vi.stubEnv('FCM_PRIVATE_KEY', 'chiave-non-valida')
    const { sendNativePush } = await caricaOsservabile()

    const res = await sendNativePush('token-abc', 'android', { title: 'x' })

    // Prima: `(err as Error)?.message ?? 'fcm_error'`. Ora il prefisso dice CHE COSA è successo
    // (un'eccezione, non un 4xx del provider) e il messaggio dice PERCHÉ.
    expect(res.error).toContain('fcm_eccezione')
    expect(res.error!.length).toBeGreaterThan('fcm_eccezione: '.length)
  })

  it('OAuth 200 con un corpo che JSON non è: il corpo si logga, non si butta', async () => {
    // Un captive portal, un proxy aziendale, la pagina d'errore HTML di un gateway: rispondono
    // 200 con dell'HTML. `res.json()` LANCIA, e l'eccezione risaliva muta fino al catch finale.
    // Adesso il corpo VERO finisce nella colonna `messaggio`, in chiaro (come per `externalFetch`:
    // dentro `campi` uscirebbe come `[redatto:str/N]`, cioè cancellato).
    vi.stubEnv('FCM_PRIVATE_KEY', privateKey)
    const { sendNativePush } = await caricaOsservabile()
    globalThis.fetch = vi.fn(async () =>
      new Response('<html><body>Blocked by proxy</body></html>', { status: 200 }),
    ) as unknown as typeof fetch

    const res = await sendNativePush('token-abc', 'ios', { title: 'x' })

    expect(res.ok).toBe(false)
    expect(res.gone).toBeUndefined()
    expect(res.error).toBe('fcm_auth_fallita')

    const riga = await ultimaRiga()
    expect(riga.livello).toBe('error')
    expect(riga.evento).toBe('push')
    expect(String(riga.messaggio)).toContain('Blocked by proxy') // ← il corpo, non «200»
  })
})
