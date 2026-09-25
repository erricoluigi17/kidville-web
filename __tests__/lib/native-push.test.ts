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
    expect(res).toEqual({ ok: false, error: 'fcm_non_configurato', ritentabile: false, tentativi: 0 })
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

/* ════════════════════════════════════════════════════════════════════════════
 * RITENTATIVI, BADGE iOS, CANALE ANDROID (spec 2026-09-24, compito PS1).
 *
 * Misurato su 7 giorni: lo 0,14% degli invii FCM falliva con `500` o per timeout e nessuno
 * veniva ritentato — la notifica era persa. Qui si verifica il COMPORTAMENTO, non lo status:
 * quante chiamate partono, dopo QUANTO tempo (1 s, poi 3 s; il `Retry-After` sul 429), cosa
 * dice l'esito (ritentabile o definitivo) e cosa c'è DENTRO il messaggio (badge, canale).
 *
 * Solo `setTimeout` è finto: `setImmediate` resta vero e serve a lasciar correre le promesse
 * (la lettura del corpo d'errore passa da uno stream) fra un passo dell'orologio e l'altro.
 * ════════════════════════════════════════════════════════════════════════════ */

type Invio = {
  message: Record<string, unknown> & {
    apns?: { payload: { aps: Record<string, unknown> } }
    android?: { notification: Record<string, unknown> }
  }
}

/** FCM finto: l'OAuth risponde sempre, `messages:send` risponde in ordine con `risposte`. */
function fcmFinto(risposte: Array<() => Response | Promise<Response>>): Invio[] {
  const invii: Invio[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'tok-finto', expires_in: 3600 }), { status: 200 })
      }
      invii.push(JSON.parse(String(init?.body)) as Invio)
      const r = risposte[invii.length - 1] ?? risposte[risposte.length - 1]
      return r()
    }),
  )
  return invii
}

const ok200 = () => new Response(JSON.stringify({ name: 'projects/p/messages/1' }), { status: 200 })
const err = (status: number, corpo: string, headers?: Record<string, string>) => () =>
  new Response(corpo, { status, headers })
const scaduto = () =>
  Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))

async function finché(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return
    await new Promise((r) => setImmediate(r))
  }
  throw new Error('condizione mai verificata')
}

describe('native-push — ritentativi, badge iOS, canale Android', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubEnv('FCM_PROJECT_ID', 'kidville')
    vi.stubEnv('FCM_CLIENT_EMAIL', 'svc@kidville.iam.gserviceaccount.com')
    vi.stubEnv('FCM_PRIVATE_KEY', privateKey)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('iOS: il badge va in apns.payload.aps.badge, accanto al suono; niente blocco android', async () => {
    const invii = fcmFinto([ok200])
    const { sendNativePush } = await freshModule()
    const res = await sendNativePush('tok', 'ios', { title: 't', badge: 7 })
    expect(res).toEqual({ ok: true, tentativi: 1 })
    expect(invii).toHaveLength(1)
    expect(invii[0].message.apns).toEqual({ payload: { aps: { sound: 'default', badge: 7 } } })
    expect(invii[0].message.android).toBeUndefined()
  })

  it('iOS: badge 0 è un valore vero (azzera); assente, negativo o frazionario → nessun badge', async () => {
    const invii = fcmFinto([ok200])
    const { sendNativePush } = await freshModule()
    await sendNativePush('tok', 'ios', { title: 't', badge: 0 })
    await sendNativePush('tok', 'ios', { title: 't' })
    await sendNativePush('tok', 'ios', { title: 't', badge: -1 })
    await sendNativePush('tok', 'ios', { title: 't', badge: 2.5 })
    expect(invii.map((i) => i.message.apns?.payload.aps)).toEqual([
      { sound: 'default', badge: 0 },
      { sound: 'default' },
      { sound: 'default' },
      { sound: 'default' },
    ])
  })

  it('Android: channel_id = kidville_notifiche (lo stesso nome della costante condivisa col client)', async () => {
    const invii = fcmFinto([ok200])
    const { sendNativePush } = await freshModule()
    const { CANALE_ANDROID_NOTIFICHE } = await import('@/lib/push/canale-android')
    await sendNativePush('tok', 'android', { title: 't', badge: 4 })
    expect(CANALE_ANDROID_NOTIFICHE).toBe('kidville_notifiche')
    expect(invii[0].message.android).toEqual({
      notification: { default_sound: true, channel_id: 'kidville_notifiche' },
    })
    // Il badge è di iOS: su Android non si inventa un blocco apns.
    expect(invii[0].message.apns).toBeUndefined()
  })

  it('500 poi 200: un ritentativo dopo 1 s ESATTO, esito ok con tentativi 2', async () => {
    const invii = fcmFinto([err(500, '{"error":{"status":"INTERNAL"}}'), ok200])
    const { sendNativePush } = await freshModule()
    const p = sendNativePush('tok', 'android', { title: 't' })

    await finché(() => invii.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(999)
    expect(invii).toHaveLength(1) // non prima di 1 s
    await vi.advanceTimersByTimeAsync(1)
    await finché(() => invii.length === 2)

    expect(await p).toEqual({ ok: true, tentativi: 2 })
  })

  it('503 tre volte: 1 s, poi 3 s, poi basta — ritentabile, col corpo di FCM', async () => {
    const invii = fcmFinto([err(503, 'The service is currently unavailable.')])
    const { sendNativePush } = await freshModule()
    const p = sendNativePush('tok', 'ios', { title: 't' })

    await finché(() => invii.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    await finché(() => invii.length === 2 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(invii).toHaveLength(2) // la seconda attesa è di 3 s, non di 1
    await vi.advanceTimersByTimeAsync(1)
    const res = await p

    expect(invii).toHaveLength(3) // due ritentativi, non uno di più
    expect(res.ok).toBe(false)
    expect(res.gone).toBeUndefined()
    expect(res.ritentabile).toBe(true)
    expect(res.tentativi).toBe(3)
    expect(res.error).toBe('fcm_503: The service is currently unavailable.')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('timeout (nessuna risposta) poi 200: si ritenta anche il timeout', async () => {
    const invii = fcmFinto([scaduto, ok200])
    const { sendNativePush } = await freshModule()
    const p = sendNativePush('tok', 'android', { title: 't' })
    await finché(() => invii.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await p).toEqual({ ok: true, tentativi: 2 })
    expect(invii).toHaveLength(2)
  })

  it('429 con Retry-After: 5 → si aspettano 5 s, non 1', async () => {
    const invii = fcmFinto([err(429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}', { 'Retry-After': '5' }), ok200])
    const { sendNativePush } = await freshModule()
    const p = sendNativePush('tok', 'ios', { title: 't' })
    await finché(() => invii.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(invii).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toEqual({ ok: true, tentativi: 2 })
  })

  it('429 con Retry-After oltre il tetto: nessuna attesa, ritentabile con ritentaDopoMs', async () => {
    const invii = fcmFinto([err(429, 'quota', { 'Retry-After': '120' }), ok200])
    const { sendNativePush } = await freshModule()
    const res = await sendNativePush('tok', 'ios', { title: 't' })
    expect(invii).toHaveLength(1)
    expect(res).toEqual({
      ok: false,
      error: 'fcm_429: quota',
      ritentabile: true,
      tentativi: 1,
      ritentaDopoMs: 120_000,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('429 con Retry-After in forma di DATA HTTP (RFC 9110): la si rispetta come i secondi', async () => {
    // Solo `setTimeout` è finto: `Date.now` è vero, quindi la data è davvero fra 120 s.
    const fra2Minuti = new Date(Date.now() + 120_000).toUTCString()
    const invii = fcmFinto([err(429, 'quota', { 'Retry-After': fra2Minuti }), ok200])
    const { sendNativePush } = await freshModule()
    const res = await sendNativePush('tok', 'ios', { title: 't' })
    expect(invii).toHaveLength(1) // oltre il tetto: nessuna seconda chiamata
    expect(res.ok).toBe(false)
    expect(res.ritentabile).toBe(true)
    // `toUTCString` tronca ai secondi e un po' di tempo passa: fra 118 e 120 s.
    expect(res.ritentaDopoMs).toBeGreaterThanOrEqual(118_000)
    expect(res.ritentaDopoMs).toBeLessThanOrEqual(120_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('429 con Retry-After a una data GIÀ PASSATA: si ripiega sulla scaletta (1 s esatto)', async () => {
    const unMinutoFa = new Date(Date.now() - 60_000).toUTCString()
    const invii = fcmFinto([err(429, 'quota', { 'Retry-After': unMinutoFa }), ok200])
    const { sendNativePush } = await freshModule()
    const p = sendNativePush('tok', 'android', { title: 't' })
    await finché(() => invii.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(999)
    expect(invii).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toEqual({ ok: true, tentativi: 2 })
    expect(invii).toHaveLength(2)
  })

  it('400 SenderId mismatch: definitivo, NON ritentato e NON gone (la subscription è sana)', async () => {
    const invii = fcmFinto([err(400, '{"error":{"message":"SenderId mismatch"}}'), ok200])
    const { sendNativePush } = await freshModule()
    const res = await sendNativePush('tok', 'android', { title: 't' })
    expect(invii).toHaveLength(1)
    expect(res.ok).toBe(false)
    expect(res.gone).toBeUndefined()
    expect(res.ritentabile).toBe(false)
    expect(res.error).toContain('SenderId mismatch')
  })

  it('404 / UNREGISTERED: gone come prima, senza ritentativi', async () => {
    const invii = fcmFinto([err(404, '{"error":{"status":"NOT_FOUND"}}'), ok200])
    const { sendNativePush } = await freshModule()
    expect(await sendNativePush('tok', 'ios', { title: 't' })).toEqual({ ok: false, gone: true, tentativi: 1 })
    expect(invii).toHaveLength(1)
  })

  it('maxRitentativi: 0 → una chiamata sola anche su 500, e resta ritentabile', async () => {
    const invii = fcmFinto([err(500, 'boom'), ok200])
    const { sendNativePush } = await freshModule()
    const res = await sendNativePush('tok', 'ios', { title: 't' }, { maxRitentativi: 0 })
    expect(invii).toHaveLength(1)
    expect(res.ritentabile).toBe(true)
    expect(res.tentativi).toBe(1)
  })

  describe('OAuth fallito: ritentabile SOLO se il guasto è transitorio', () => {
    /** L'endpoint OAuth risponde con `oauth`; `messages:send` non deve mai partire. */
    function oauthFinto(oauth: () => Response | Promise<Response>): { send: number } {
      const conta = { send: 0 }
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL) => {
          if (String(url).includes('oauth2.googleapis.com')) return oauth()
          conta.send++
          return ok200()
        }),
      )
      return conta
    }

    it('OAuth 400 invalid_grant (chiave revocata): definitivo, come il PEM malformato', async () => {
      const conta = oauthFinto(
        err(400, '{"error":"invalid_grant","error_description":"Invalid JWT Signature."}'),
      )
      const { sendNativePush } = await freshModule()
      expect(await sendNativePush('tok', 'ios', { title: 't' })).toEqual({
        ok: false,
        error: 'fcm_auth_fallita',
        ritentabile: false,
        tentativi: 0,
      })
      expect(conta.send).toBe(0)
    })

    it('OAuth 401 e 403: definitivi anche loro', async () => {
      for (const status of [401, 403]) {
        vi.resetModules()
        oauthFinto(err(status, '{"error":"unauthorized_client"}'))
        const { sendNativePush } = await freshModule()
        const res = await sendNativePush('tok', 'android', { title: 't' })
        expect(res).toEqual({ ok: false, error: 'fcm_auth_fallita', ritentabile: false, tentativi: 0 })
      }
    })

    it('OAuth 503: ritentabile (il guasto è di Google, e passa)', async () => {
      const conta = oauthFinto(err(503, 'Service Unavailable'))
      const { sendNativePush } = await freshModule()
      expect(await sendNativePush('tok', 'ios', { title: 't' })).toEqual({
        ok: false,
        error: 'fcm_auth_fallita',
        ritentabile: true,
        tentativi: 0,
      })
      expect(conta.send).toBe(0)
    })

    it('OAuth senza risposta (timeout): ritentabile', async () => {
      oauthFinto(scaduto as () => Promise<Response>)
      const { sendNativePush } = await freshModule()
      const res = await sendNativePush('tok', 'ios', { title: 't' })
      expect(res).toEqual({ ok: false, error: 'fcm_auth_fallita', ritentabile: true, tentativi: 0 })
    })

    it('OAuth 200 senza access_token: definitivo (la stessa richiesta avrà la stessa risposta)', async () => {
      oauthFinto(() => new Response(JSON.stringify({ token_type: 'Bearer' }), { status: 200 }))
      const { sendNativePush } = await freshModule()
      const res = await sendNativePush('tok', 'ios', { title: 't' })
      expect(res).toEqual({ ok: false, error: 'fcm_auth_fallita', ritentabile: false, tentativi: 0 })
    })

    it('OAuth 200 con un corpo non JSON (proxy, gateway): ritentabile', async () => {
      oauthFinto(() => new Response('<html>Bad gateway</html>', { status: 200 }))
      const { sendNativePush } = await freshModule()
      const res = await sendNativePush('tok', 'ios', { title: 't' })
      expect(res).toEqual({ ok: false, error: 'fcm_auth_fallita', ritentabile: true, tentativi: 0 })
    })
  })

  it('senza credenziali: definitivo per questo invio, zero tentativi', async () => {
    vi.stubEnv('FCM_PRIVATE_KEY', '')
    const { sendNativePush } = await freshModule()
    expect(await sendNativePush('tok', 'ios', { title: 't' })).toEqual({
      ok: false,
      error: 'fcm_non_configurato',
      ritentabile: false,
      tentativi: 0,
    })
  })
})

describe('native-push — i log dei ritentativi', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubEnv('VITEST', '')
    vi.stubEnv('KV_LOG_LEVEL', '')
    vi.stubEnv('FCM_PROJECT_ID', 'kidville')
    vi.stubEnv('FCM_CLIENT_EMAIL', 'svc@kidville.iam.gserviceaccount.com')
    vi.stubEnv('FCM_PRIVATE_KEY', privateKey)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.doUnmock('@/lib/logging/app-log')
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  const righe = () => appLog.mock.calls.map((c) => c[0] as Riga)

  it('ritentativi esauriti: i rifiuti transitori sono warn, poi UNA riga error col corpo', async () => {
    const invii = fcmFinto([err(500, 'Internal error encountered.')])
    const { sendNativePush } = await caricaOsservabile()
    const p = sendNativePush('tok', 'android', { title: 't' }, { maxRitentativi: 1 })
    await finché(() => invii.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    await p

    await finché(() => righe().some((r) => r.livello === 'error'))
    // Una riga per chiamata a FCM (2) più la riga finale, tutte col loro status (`stato_http`).
    const conStato = righe().filter((r) => r.evento === 'push' && r.statoHttp === 500)
    expect(conStato).toHaveLength(3)
    // Le righe dei singoli tentativi NON sono error: il guasto lo dichiara la riga finale.
    expect(conStato.filter((r) => r.livello === 'warn')).toHaveLength(2)
    const errori = righe().filter((r) => r.livello === 'error' && r.evento === 'push')
    expect(errori).toHaveLength(1)
    expect(String(errori[0].messaggio)).toContain('Internal error encountered.')
    expect(errori[0].codice).toBe('500')
    expect(JSON.stringify(errori[0])).toContain('ritentativi-esauriti')
  })

  it('timeout esauriti: la riga error finale ha codice «timeout», non «0», e niente statoHttp', async () => {
    // Le righe warn dei singoli tentativi avevano già `codice = 'timeout'` (le scrive
    // externalFetch); la riga error finale scriveva `String(0)`. Chi in SQL conta i timeout di
    // FCM con `where codice = 'timeout'` perdeva proprio l'unica riga a livello error.
    const invii = fcmFinto([scaduto])
    const { sendNativePush } = await caricaOsservabile()
    const p = sendNativePush('tok', 'android', { title: 't' }, { maxRitentativi: 1 })
    await finché(() => invii.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    const res = await p
    expect(invii).toHaveLength(2)
    expect(res.ritentabile).toBe(true)

    await finché(() => righe().some((r) => r.livello === 'error'))
    const errori = righe().filter((r) => r.livello === 'error' && r.evento === 'push')
    expect(errori).toHaveLength(1)
    const finale = errori[0]
    expect(finale.codice).toBe('timeout')
    expect(finale.statoHttp).toBeUndefined()
    expect(String(finale.messaggio)).toContain('nessuna risposta')
    expect(JSON.stringify(finale)).toContain('ritentativi-esauriti')
    // Lo stesso codice delle righe dei tentativi: una query sola le trova tutte e tre.
    const tentativi = righe().filter((r) => r.evento === 'push' && r.livello === 'warn')
    expect(tentativi).toHaveLength(2)
    expect(tentativi.every((r) => r.codice === 'timeout')).toBe(true)
  })

  it('rete giù senza code stringa: la riga error finale dice «nessuna-risposta», mai «0»', async () => {
    const invii = fcmFinto([() => Promise.reject(new TypeError('fetch failed'))])
    const { sendNativePush } = await caricaOsservabile()
    const p = sendNativePush('tok', 'ios', { title: 't' }, { maxRitentativi: 0 })
    await p
    expect(invii).toHaveLength(1)
    await finché(() => righe().some((r) => r.livello === 'error'))
    const errori = righe().filter((r) => r.livello === 'error' && r.evento === 'push')
    expect(errori).toHaveLength(1)
    expect(errori[0].codice).toBe('nessuna-risposta')
    expect(errori[0].statoHttp).toBeUndefined()
  })

  it('rete giù nella forma VERA di undici (code sulla causa): la riga finale dice ENOTFOUND come i tentativi', async () => {
    // Node/undici non lancia mai un errore di rete col `code` in cima: lancia
    // `TypeError('fetch failed')` e mette `ENOTFOUND` (o ECONNRESET, ECONNREFUSED…) sulla CAUSA.
    // Il logger scrive la riga del tentativo con `codice = d.codice ?? d.causa?.codice`, quindi
    // `ENOTFOUND`; la riga finale deve dire lo stesso, non `nessuna-risposta`.
    const reteGiù = () =>
      Promise.reject(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND fcm.googleapis.com'), { code: 'ENOTFOUND' }),
        }),
      )
    const invii = fcmFinto([reteGiù])
    const { sendNativePush } = await caricaOsservabile()
    const p = sendNativePush('tok', 'android', { title: 't' }, { maxRitentativi: 1 })
    await finché(() => invii.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    const res = await p
    expect(invii).toHaveLength(2)
    expect(res.ritentabile).toBe(true)

    await finché(() => righe().some((r) => r.livello === 'error'))
    const errori = righe().filter((r) => r.livello === 'error' && r.evento === 'push')
    expect(errori).toHaveLength(1)
    expect(errori[0].codice).toBe('ENOTFOUND')
    expect(errori[0].statoHttp).toBeUndefined()
    expect(JSON.stringify(errori[0])).toContain('ritentativi-esauriti')
    const tentativi = righe().filter((r) => r.evento === 'push' && r.livello === 'warn')
    expect(tentativi).toHaveLength(2)
    expect(tentativi.map((r) => r.codice)).toEqual(['ENOTFOUND', 'ENOTFOUND'])
  })

  it('successo dopo un ritentativo: riga info «riuscita-dopo-ritentativo»', async () => {
    const invii = fcmFinto([err(503, 'unavailable'), ok200])
    const { sendNativePush } = await caricaOsservabile()
    const p = sendNativePush('tok', 'ios', { title: 't' })
    await finché(() => invii.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await p).ok).toBe(true)
    await finché(() => JSON.stringify(righe()).includes('riuscita-dopo-ritentativo'))
    const riga = righe().find((r) => JSON.stringify(r).includes('riuscita-dopo-ritentativo'))!
    expect(riga.livello).toBe('info')
    expect(riga.evento).toBe('push')
    expect(righe().filter((r) => r.livello === 'error')).toHaveLength(0)
  })
})
