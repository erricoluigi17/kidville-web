import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * POST /api/account/password — il cambio password, e le sei ragioni per cui è SERVER.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PERCHÉ NON `supabase.auth.updateUser({ password })` DAL BROWSER
 *
 * `secure_password_change = false` (`supabase/config.toml:223`): GoTrue **non chiede
 * la password attuale**. Un controllo lato client è teatro — chi chiama l'API
 * direttamente lo salta. E le chiamate Supabase del browser non hanno tetto di tempo
 * e i loro 4xx non arrivano in `app_log` (lo dichiara
 * `__tests__/architecture/supabase-client-strumentato.test.ts`, blocco «cosa questo
 * lock NON copre»), quindi un cambio fallito non lascerebbe traccia da nessuna parte.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IL TEST CHE CONTA PIÙ DI TUTTI è il primo: `x-user-id` con l'uid di un'ALTRA
 * persona, senza cookie di sessione, deve prendere 401 — e `updateUserById` non deve
 * essere chiamato affatto.
 *
 * `resolveIdentity` (il gate di tutto il resto del repo) onora ancora
 * `x-user-id`/`?userId=` quando `ALLOW_HEADER_IDENTITY !== 'false'`. In produzione
 * quella variabile vale `'false'`, ma una route che riscrive la password di chiunque
 * non può avere come unica difesa una variabile d'ambiente: un ambiente nuovo, un
 * `.env` incompleto, e un header basterebbe a cambiare la password di 560 account.
 * Per questo la route NON usa `requireUser` ma `requireSessioneAuth`, che l'identità
 * la prende dalla sola sessione — e per questo il test qui sotto CANCELLA
 * `ALLOW_HEADER_IDENTITY` dall'ambiente prima di provare: deve reggere anche lì.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const UID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const UID_ALTRUI = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

const h = vi.hoisted(() => {
  const sessione = {
    current: {
      data: { user: { id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', email: 'x@y.z' } },
      error: null,
    } as { data: { user: { id: string; email?: string } | null }; error: unknown },
  }
  const lettura = {
    current: { data: null as { cambi?: number } | null, error: null as unknown },
  }
  const scrittura = { current: { error: null as unknown } }
  const upsertSpy = vi.fn()
  const fromSpy = vi.fn(() => {
    const qb: Record<string, unknown> = {}
    qb.select = () => qb
    qb.eq = () => qb
    qb.maybeSingle = () => Promise.resolve(lettura.current)
    qb.upsert = (righe: unknown, opts: unknown) => {
      upsertSpy(righe, opts)
      return Promise.resolve(scrittura.current)
    }
    return qb
  })
  return {
    sessione,
    lettura,
    scrittura,
    fromSpy,
    upsertSpy,
    getUser: vi.fn(() => Promise.resolve(sessione.current)),
    getSession: vi.fn(() => Promise.resolve({ data: { session: { access_token: 'tok' } } })),
    signIn: vi.fn(),
    updateUserById: vi.fn(),
    signOutAdmin: vi.fn(),
    rateLimit: vi.fn(),
  }
})

// I percorsi sono quelli VERI su disco: un `vi.mock` su un modulo che non esiste non
// aggancia niente e lascia il test verde sul vuoto.
vi.mock('@/lib/supabase/server-client', () => ({
  // `createClient` è quello che legge la SESSIONE (lo usa `requireSessioneAuth`).
  createClient: async () => ({ auth: { getUser: h.getUser, getSession: h.getSession } }),
  createAdminClient: async () => ({
    from: h.fromSpy,
    auth: { admin: { updateUserById: h.updateUserById, signOut: h.signOutAdmin } },
  }),
  createVerificaClient: async () => ({ auth: { signInWithPassword: h.signIn } }),
}))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: h.rateLimit,
  clientIp: () => '203.0.113.7',
}))

// ⚠️ `require-staff` NON è mockato, ed è il punto: il gate che si vuole provare è
// quello VERO. Mockarlo vorrebbe dire provare il mock.
import { POST } from '@/app/api/account/password/route'

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/account/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const BUONA = { attuale: 'VecchiaPass1', nuova: 'NuovaPassword9' }

const ambientePrecedente = process.env.ALLOW_HEADER_IDENTITY

beforeEach(() => {
  vi.clearAllMocks()
  h.sessione.current = { data: { user: { id: UID, email: 'x@y.z' } }, error: null }
  h.lettura.current = { data: null, error: null }
  h.scrittura.current = { error: null }
  h.signIn.mockResolvedValue({ data: { user: { id: UID } }, error: null })
  h.updateUserById.mockResolvedValue({ data: { user: { id: UID } }, error: null })
  h.signOutAdmin.mockResolvedValue({ error: null })
  h.rateLimit.mockResolvedValue({ ok: true, remaining: 4, retryAfterMs: 0 })
})

afterEach(() => {
  if (ambientePrecedente === undefined) delete process.env.ALLOW_HEADER_IDENTITY
  else process.env.ALLOW_HEADER_IDENTITY = ambientePrecedente
})

describe('POST /api/account/password — il gate è la SESSIONE, non un header', () => {
  it("401 con `x-user-id` altrui e nessuna sessione, ANCHE con ALLOW_HEADER_IDENTITY cancellata", async () => {
    // La variabile si cancella davvero: se la difesa dipendesse da lei, qui cadrebbe.
    delete process.env.ALLOW_HEADER_IDENTITY
    h.sessione.current = { data: { user: null }, error: null }

    const res = await POST(req(BUONA, { 'x-user-id': UID_ALTRUI }) as never)

    expect(res.status).toBe(401)
    expect(h.updateUserById, 'la password di un altro NON si tocca').not.toHaveBeenCalled()
    expect(h.signIn, 'non si prova nemmeno a verificare la password altrui').not.toHaveBeenCalled()
    expect(h.fromSpy).not.toHaveBeenCalled()
    // Nessuna PII nella risposta: né l'uid chiesto, né un'email.
    const corpo = JSON.stringify(await res.json())
    expect(corpo).not.toContain(UID_ALTRUI)
    expect(corpo).not.toContain('@')
  })

  it("401 anche con `?userId=` in query (l'altra metà del percorso legacy)", async () => {
    delete process.env.ALLOW_HEADER_IDENTITY
    h.sessione.current = { data: { user: null }, error: null }
    const r = new Request(`http://localhost/api/account/password?userId=${UID_ALTRUI}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BUONA),
    })
    const res = await POST(r as never)
    expect(res.status).toBe(401)
    expect(h.updateUserById).not.toHaveBeenCalled()
  })

  it('la sessione ILLEGGIBILE (getUser lancia) è un 401, non un 500', async () => {
    h.getUser.mockRejectedValueOnce(new Error('cookies() fuori da una richiesta'))
    const res = await POST(req(BUONA) as never)
    expect(res.status).toBe(401)
    expect(h.updateUserById).not.toHaveBeenCalled()
  })
})

describe('POST /api/account/password — il tetto scatta PRIMA di GoTrue', () => {
  it('429 per UTENTE, e la chiave è l’uid: GoTrue non viene toccato', async () => {
    h.rateLimit.mockResolvedValueOnce({ ok: false, remaining: 0, retryAfterMs: 60_000 })

    const res = await POST(req(BUONA) as never)

    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ codice: 'TROPPE_RICHIESTE' })
    // La PRIMA chiave provata è quella per utente, non quella per IP: dietro il NAT
    // di una sede le famiglie condividono l'indirizzo (rate-limit.ts:415-426), e
    // contare per IP prima vorrebbe dire far scattare il tetto di una madre a causa
    // dei tentativi di un'altra.
    expect(h.rateLimit.mock.calls[0][0]).toBe(`pwd-cambio:${UID}`)
    expect(h.signIn).not.toHaveBeenCalled()
    expect(h.updateUserById).not.toHaveBeenCalled()
  })

  it('429 per IP, con la chiave e i due tetti dichiarati', async () => {
    h.rateLimit
      .mockResolvedValueOnce({ ok: true, remaining: 4, retryAfterMs: 0 })
      .mockResolvedValueOnce({ ok: false, remaining: 0, retryAfterMs: 60_000 })

    const res = await POST(req(BUONA) as never)

    expect(res.status).toBe(429)
    expect(h.rateLimit.mock.calls[0][1]).toEqual({ limit: 5, windowMs: 15 * 60 * 1000 })
    expect(h.rateLimit.mock.calls[1][0]).toBe('pwd-cambio-ip:203.0.113.7')
    expect(h.rateLimit.mock.calls[1][1]).toEqual({ limit: 20, windowMs: 15 * 60 * 1000 })
    expect(h.signIn).not.toHaveBeenCalled()
  })

  it('il nostro tetto per IP sta SOTTO quello di GoTrue (30/5 min)', async () => {
    // Se il nostro fosse più largo, l'utente riceverebbe il 429 opaco del provider
    // al posto del nostro messaggio tradotto. 20 in 15 minuti = 6,67 in 5 minuti.
    h.rateLimit.mockResolvedValue({ ok: true, remaining: 1, retryAfterMs: 0 })
    await POST(req(BUONA) as never)
    const perIp = h.rateLimit.mock.calls[1][1] as { limit: number; windowMs: number }
    const in5min = (perIp.limit * (5 * 60 * 1000)) / perIp.windowMs
    expect(in5min).toBeLessThan(30)
  })
})

describe('POST /api/account/password — le regole, e la password ATTUALE', () => {
  it('400 con il CODICE della regola violata, senza toccare GoTrue', async () => {
    const res = await POST(req({ attuale: 'VecchiaPass1', nuova: 'corta1' }) as never)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ codice: 'PASSWORD_TROPPO_CORTA' })
    expect(h.signIn).not.toHaveBeenCalled()
    expect(h.updateUserById).not.toHaveBeenCalled()
  })

  it('400 PASSWORD_UGUALE_ALLA_PRECEDENTE quando nuova === attuale', async () => {
    const res = await POST(req({ attuale: 'StessaPass12', nuova: 'StessaPass12' }) as never)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ codice: 'PASSWORD_UGUALE_ALLA_PRECEDENTE' })
    expect(h.updateUserById).not.toHaveBeenCalled()
  })

  it('400 PASSWORD_ATTUALE_ERRATA: è il controllo che `secure_password_change=false` non fa', async () => {
    h.signIn.mockResolvedValue({ data: { user: null }, error: { status: 400, message: 'Invalid login credentials' } })

    const res = await POST(req(BUONA) as never)

    expect(res.status).toBe(400)
    const corpo = await res.json()
    expect(corpo).toMatchObject({ codice: 'PASSWORD_ATTUALE_ERRATA' })
    // Il messaggio del provider resta nel LOG, mai nella risposta: è prosa inglese,
    // ed è esattamente ciò che i codici hanno tolto dall'interfaccia.
    expect(JSON.stringify(corpo)).not.toContain('Invalid login credentials')
    expect(h.updateUserById, 'la password non si riscrive senza aver verificato la vecchia').not.toHaveBeenCalled()
  })

  it("la verifica usa l'email della SESSIONE e la password ATTUALE (mai la nuova)", async () => {
    await POST(req(BUONA) as never)
    expect(h.signIn).toHaveBeenCalledWith({ email: 'x@y.z', password: 'VecchiaPass1' })
  })

  it('500 se la sessione non porta un’email: il guasto è NOSTRO, non un’identità mancante', async () => {
    // Senza indirizzo la verifica dell'attuale è impossibile, e in questo sistema gli
    // account nascono tutti con un'email (`createUser({ email, password })`): è
    // un'anomalia dei nostri dati, non una richiesta sbagliata. Un 401 direbbe «non so
    // chi sei» a una persona autenticata, e la manderebbe a rifare il login per niente.
    h.sessione.current = { data: { user: { id: UID } }, error: null }
    const res = await POST(req(BUONA) as never)
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'PASSWORD_NON_SCRITTA' })
    expect(h.signIn).not.toHaveBeenCalled()
    expect(h.updateUserById).not.toHaveBeenCalled()
  })

  it('400 sul corpo malformato, prima di qualunque scrittura', async () => {
    const r = new Request('http://localhost/api/account/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ questo non è json',
    })
    const res = await POST(r as never)
    expect(res.status).toBe(400)
    expect(h.updateUserById).not.toHaveBeenCalled()
  })
})

describe('POST /api/account/password — la scrittura, e il suo valore di ritorno', () => {
  it("200: `updateUserById` riceve l'uid di AUTH, non un id applicativo", async () => {
    const res = await POST(req(BUONA) as never)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
    // ⚠️ `parents.id ≠ auth_user_id`: il ponte è `parents.auth_user_id`. Confondere i
    // due è già costato «0 genitori su 46 risultavano onboardati»
    // (`src/app/api/parent/onboarding/route.ts:132-138`).
    expect(h.updateUserById).toHaveBeenCalledWith(UID, { password: 'NuovaPassword9' })
  })

  it('400 PASSWORD_RIFIUTATA su 4xx di GoTrue, e il corpo del provider resta nel log', async () => {
    h.updateUserById.mockResolvedValue({
      data: { user: null },
      error: { status: 422, message: 'Password is known to be weak and easy to guess' },
    })

    const res = await POST(req(BUONA) as never)

    expect(res.status).toBe(400)
    const corpo = await res.json()
    expect(corpo).toMatchObject({ codice: 'PASSWORD_RIFIUTATA' })
    expect(JSON.stringify(corpo)).not.toContain('known to be weak')
  })

  it('500 PASSWORD_NON_SCRITTA su 5xx di GoTrue: il guasto è nostro, la password di prima vale ancora', async () => {
    h.updateUserById.mockResolvedValue({ data: { user: null }, error: { status: 500, message: 'Database error' } })

    const res = await POST(req(BUONA) as never)

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'PASSWORD_NON_SCRITTA' })
  })

  it("500 PASSWORD_NON_SCRITTA anche quando l'errore di GoTrue non porta uno status", async () => {
    // `message` di GoTrue può essere `undefined` e `status` mancare del tutto (visto
    // in produzione il 31/07): senza status non si può dire «colpa della password».
    h.updateUserById.mockResolvedValue({ data: { user: null }, error: { message: undefined } })
    const res = await POST(req(BUONA) as never)
    expect(res.status).toBe(500)
  })
})

describe('POST /api/account/password — `password_cambi`: si registra, e degrada pulito', () => {
  it('upsert con `cambi` incrementato e origine di default `self-service`', async () => {
    h.lettura.current = { data: { cambi: 2 }, error: null }

    const res = await POST(req(BUONA) as never)

    expect(res.status).toBe(200)
    expect(h.fromSpy).toHaveBeenCalledWith('password_cambi')
    const [righe, opts] = h.upsertSpy.mock.calls[0]
    expect(righe).toMatchObject({ auth_user_id: UID, cambi: 3, origine: 'self-service' })
    expect(opts).toMatchObject({ onConflict: 'auth_user_id' })
  })

  it('prima riga: `cambi` parte da 1', async () => {
    await POST(req(BUONA) as never)
    expect(h.upsertSpy.mock.calls[0][0]).toMatchObject({ cambi: 1 })
  })

  it("l'origine `primo-accesso` arriva in tabella (è ciò che misura l'instradamento)", async () => {
    await POST(req({ ...BUONA, origine: 'primo-accesso' }) as never)
    expect(h.upsertSpy.mock.calls[0][0]).toMatchObject({ origine: 'primo-accesso' })
  })

  it("un'origine sconosciuta non fa 400: ricade su `self-service`", async () => {
    // Il CHECK della tabella ammette tre valori: qui non ne esce mai un quarto. E un
    // campo di misura non deve poter far fallire un cambio password riuscito.
    const res = await POST(req({ ...BUONA, origine: 'inventata' }) as never)
    expect(res.status).toBe(200)
    expect(h.upsertSpy.mock.calls[0][0]).toMatchObject({ origine: 'self-service' })
  })

  it('TABELLA ASSENTE (PGRST205): la password È cambiata, la risposta resta 200', async () => {
    // Il DB E2E della CI è un progetto separato e NON migrato: il codice nuovo deve
    // degradare in modo pulito invece di dichiarare un guasto che non c'è.
    h.lettura.current = { data: null, error: { code: 'PGRST205', message: 'Could not find the table' } }
    h.scrittura.current = { error: { code: 'PGRST205', message: 'Could not find the table' } }

    const res = await POST(req(BUONA) as never)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
    expect(h.updateUserById).toHaveBeenCalled()
  })

  it('TABELLA ASSENTE (42703/42P01): idem, e la password resta cambiata', async () => {
    h.lettura.current = { data: null, error: { code: '42P01', message: 'relation does not exist' } }
    h.scrittura.current = { error: { code: '42P01', message: 'relation does not exist' } }
    const res = await POST(req(BUONA) as never)
    expect(res.status).toBe(200)
  })

  it('la registrazione fallita NON annulla il cambio: 200, e il gesto è avvenuto', async () => {
    h.scrittura.current = { error: { code: '23503', message: 'foreign key violation' } }
    const res = await POST(req(BUONA) as never)
    expect(res.status).toBe(200)
    expect(h.updateUserById).toHaveBeenCalled()
  })

  it('se la password NON è stata scritta, `password_cambi` non viene toccata', async () => {
    h.updateUserById.mockResolvedValue({ data: { user: null }, error: { status: 500, message: 'x' } })
    const res = await POST(req(BUONA) as never)
    expect(res.status).toBe(500)
    expect(h.fromSpy, 'una riga di «ha cambiato password» su un cambio fallito è una bugia in tabella')
      .not.toHaveBeenCalled()
  })
})

describe('POST /api/account/password — le sessioni altrove', () => {
  it("non si chiama `signOut('others')`: GoTrue le ha GIÀ revocate tutte", async () => {
    // MISURATO sul sorgente di GoTrue (2026-09-01), non supposto:
    // `internal/api/admin.go` → `adminUserUpdate` chiama `user.UpdatePassword(tx, nil)`;
    // `internal/models/user.go` → con `sessionID == nil` esegue `Logout(tx, u.ID)`;
    // `internal/models/sessions.go` → `Logout` è
    // `DELETE FROM sessions WHERE user_id = ?`. Cioè TUTTE le sessioni di quell'utente,
    // compresa quella di chi ha appena chiesto il cambio.
    //
    // Una `signOut(accessToken, 'others')` dopo di quella parlerebbe di una sessione che
    // non esiste più: GoTrue risponderebbe 4xx e la route scriverebbe un `warn`
    // «sessioni-altrove-non-revocate» a OGNI cambio riuscito — un allarme falso
    // permanente in `app_log`, cioè il rumore che rende invisibili i guasti veri.
    await POST(req(BUONA) as never)
    expect(h.signOutAdmin).not.toHaveBeenCalled()
  })

  it('la risposta DICE che le sessioni sono cadute (il client deve rifare l’accesso)', async () => {
    const res = await POST(req(BUONA) as never)
    expect(await res.json()).toEqual({ ok: true, sessioniTerminate: true })
  })
})
