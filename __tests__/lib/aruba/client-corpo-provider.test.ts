import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Aruba/SDI — IL CORPO DELL'ERRORE DEL PROVIDER NON SI BUTTA VIA.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * È LA STESSA SCENA DEL DELITTO delle email di credenziali, su un percorso con obblighi
 * fiscali. Per mesi nessuna email arrivava a un genitore perché Resend rispondeva `403` e il
 * codice registrava soltanto il numero, mentre il corpo diceva «the kidville.it domain is not
 * verified». Nessun test era rosso.
 *
 * Il client Aruba è nato a giugno, PRIMA che esistesse `src/lib/logging/external.ts` (luglio),
 * e non era mai stato ricondotto al modulo: sei `fetch` a mano e cinque
 * `throw new Error(\`… (HTTP ${res.status})\`)` che gettavano il corpo. In `app_log` restava
 * «Aruba signin fallita (HTTP 401)» — un numero che non distingue una password ruotata da un
 * 5xx del provider. AGENTS.md, regola 3, nomina «Aruba/SDI» PER NOME fra i provider che devono
 * passare da `externalFetch`.
 *
 * Questi test sono rossi se qualcuno rimette il numero al posto del motivo.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * COME SI OSSERVA. Il logger è SILENZIOSO sotto vitest (guardia valutata al caricamento del
 * modulo) e `.env.local` punta al DB di PRODUZIONE: una suite che scrive log in produzione è un
 * incidente, non un test. Perciò `carica()` ricarica il grafo con `VITEST=''` e `app-log`
 * MOCKATO — si vede la riga vera (console + riga persistita) senza toccare nessun database. È
 * lo stesso schema di `logging-external.test.ts`.
 */

type Riga = Record<string, unknown>

let appLog: ReturnType<typeof vi.fn>
let log: ReturnType<typeof vi.spyOn>
let err: ReturnType<typeof vi.spyOn>

/** Ricarica il client con la guardia SILENZIOSO spenta e il sink `app_log` finto. */
async function carica() {
  appLog = vi.fn(async () => {})
  vi.resetModules()
  vi.doMock('@/lib/logging/app-log', () => ({ appLog }))
  return await import('@/lib/aruba/client')
}

/** La riga PERSISTITA (quella che finirà in `app_log`, l'unica che si legge in SQL). */
async function rigaPersistita(n = 0): Promise<Riga> {
  await vi.waitFor(() => expect(appLog.mock.calls.length).toBeGreaterThan(n))
  return appLog.mock.calls[n][0] as Riga
}

/** Tutto ciò che è finito su console (la riga che si legge su Vercel). */
function scritto(): string {
  return [...log.mock.calls, ...err.mock.calls]
    .flat()
    .map((a) => (typeof a === 'string' ? a : String((a as Error)?.message ?? a)))
    .join('\n')
}

function rispondi(corpo: string, stato: number): typeof fetch {
  return vi.fn(async () => new Response(corpo, { status: stato })) as unknown as typeof fetch
}

beforeEach(() => {
  vi.stubEnv('VITEST', '')
  vi.stubEnv('KV_LOG_LEVEL', '')
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  err = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.doUnmock('@/lib/logging/app-log')
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

/* ════════════════════════════════════════════════════════════════════════════
 * 1. Le cinque chiamate che LANCIAVANO con il solo status.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('client Aruba — su !ok il motivo del provider arriva nell\'errore', () => {
  it('signin 401: l\'eccezione porta il corpo, non solo il numero', async () => {
    const { arubaSignin } = await carica()
    globalThis.fetch = rispondi('{"errorCode":"0004","errorDescription":"Invalid username or password"}', 401)

    // `.rejects.toThrow` non basta: verificherebbe che lancia, non COSA dice — ed è
    // esattamente la distinzione costata mesi di email non consegnate.
    const errore = await arubaSignin('demo', { username: 'u', password: 'p' }).catch((e: unknown) => e)

    expect(errore).toBeInstanceOf(Error)
    expect((errore as Error).message).toContain('Invalid username or password')
    expect((errore as Error).message).toContain('401')
    // Interrogabile: `where codice = '401'` sulla riga di chi lo rilogga.
    expect((errore as { code?: string }).code).toBe('401')
  })

  it('refresh 400: idem — un token scaduto e un 5xx di Aruba non sono più lo stesso log', async () => {
    const { arubaRefresh } = await carica()
    globalThis.fetch = rispondi('{"error":"invalid_grant","error_description":"Refresh token expired"}', 400)

    const errore = await arubaRefresh('demo', 'RT').catch((e: unknown) => e)

    expect((errore as Error).message).toContain('Refresh token expired')
    expect((errore as { code?: string }).code).toBe('400')
  })

  it('getByFilename 502: anche un corpo NON JSON (l\'HTML di un proxy) arriva nel messaggio', async () => {
    const { arubaGetByFilename } = await carica()
    globalThis.fetch = rispondi('<html><body>502 Bad Gateway — upstream Aruba</body></html>', 502)

    const errore = await arubaGetByFilename('production', 'AT', 'IT123_a1.xml.p7m').catch((e: unknown) => e)

    expect((errore as Error).message).toContain('502 Bad Gateway')
    expect((errore as { code?: string }).code).toBe('502')
  })

  it('findByUsername 403: il progressivo che non si è potuto leggere dice PERCHÉ', async () => {
    // Il chiamante (`emissione.ts`) dal 2026-08-09 NON degrada più al contatore interno: si
    // ferma e logga a `error`. Il corpo resta la cosa che conta — senza, quella riga direbbe
    // «403» e nessuno saprebbe se è un permesso mancante sul servizio o l'ambiente sbagliato.
    const { arubaUltimoNumeroFattura } = await carica()
    globalThis.fetch = rispondi('{"errorDescription":"User not enabled for outgoing invoices"}', 403)

    const errore = await arubaUltimoNumeroFattura('demo', 'AT', {
      username: 'u',
      anno: 2026,
      sezionale: 'Asilo',
    }).catch((e: unknown) => e)

    expect((errore as Error).message).toContain('User not enabled for outgoing invoices')
    expect((errore as { code?: string }).code).toBe('403')
  })

  it('notifiche 404: stesso contratto', async () => {
    const { arubaGetNotifications } = await carica()
    globalThis.fetch = rispondi('{"errorDescription":"Invoice filename not found"}', 404)

    const errore = await arubaGetNotifications('demo', 'AT', 'IT123_a1.xml.p7m').catch((e: unknown) => e)

    expect((errore as Error).message).toContain('Invoice filename not found')
    expect((errore as { code?: string }).code).toBe('404')
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 2. La riga che resta: `app_log` e Vercel.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('client Aruba — la riga del provider finisce dove si interroga', () => {
  it('IL PUNTO DI TUTTO: il corpo sta nella colonna `messaggio`, in chiaro, sotto evento `fattura`', async () => {
    const { arubaSignin } = await carica()
    globalThis.fetch = rispondi('{"errorCode":"0004","errorDescription":"Invalid username or password"}', 401)

    await arubaSignin('demo', { username: 'u', password: 'p' }).catch(() => {})

    const r = await rigaPersistita()
    expect(r.evento).toBe('fattura')
    expect(r.livello).toBe('error')
    expect(String(r.messaggio)).toContain('Invalid username or password')
    // Un campo `corpo` dentro `campi` uscirebbe `[redatto:str/N]`: `redact` è a lista bianca
    // PER CHIAVE. Passato come errore, `descriviErrore` lo mette nella colonna giusta.
    expect(String(r.messaggio)).not.toContain('[redatto')
    expect(r.codice).toBe('401')
    expect(r.statoHttp).toBe(401)
  })

  it('sulla riga di Vercel si legge `provider=aruba` e il motivo', async () => {
    const { arubaSignin } = await carica()
    globalThis.fetch = rispondi('{"errorDescription":"Invalid username or password"}', 401)

    await arubaSignin('demo', { username: 'u', password: 'p' }).catch(() => {})

    const righe = scritto()
    expect(righe).toContain('provider=aruba')
    expect(righe).toContain('code=401')
    expect(righe).toContain('Invalid username or password')
  })

  it('LA PASSWORD ARUBA NON ESCE MAI: il corpo della RICHIESTA non si logga', async () => {
    // `arubaSignin` spedisce la password nel body form-urlencoded. Il modulo osserva la
    // RISPOSTA, mai la richiesta — e questo test è ciò che impedisce a un domani "comodo"
    // di aggiungere il body alla riga.
    const { arubaSignin } = await carica()
    globalThis.fetch = rispondi('{"errorDescription":"nope"}', 401)

    await arubaSignin('demo', { username: 'segreteria@scuola.it', password: 'ParolaSegreta1' }).catch(() => {})

    const r = await rigaPersistita()
    expect(JSON.stringify(r)).not.toContain('ParolaSegreta1')
    expect(scritto()).not.toContain('ParolaSegreta1')
  })

  it('il SUCCESSO ha il suo battito: evento `fattura` a `info`, persistito', async () => {
    // Con i soli errori, «nessun log» non distingue «tutto ok» da «non è mai partito niente»
    // (AGENTS.md, regola 5). `fattura` è in EVENTI_PERSISTITI proprio per questo.
    const { arubaSignin } = await carica()
    globalThis.fetch = rispondi('{"access_token":"AT","refresh_token":"RT","expires_in":1799}', 200)

    const tokens = await arubaSignin('demo', { username: 'u', password: 'p' })
    expect(tokens.accessToken).toBe('AT')

    const r = await rigaPersistita()
    expect(r.evento).toBe('fattura')
    expect(r.livello).toBe('info')
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 3. `arubaUpload`: l'unica che NON lancia, e che scriveva «Errore upload» a registro.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('arubaUpload — lo scarto porta con sé il motivo di Aruba', () => {
  it('HTTP 401 con envelope JSON → errorCode e descrizione del provider', async () => {
    const { arubaUpload } = await carica()
    globalThis.fetch = rispondi('{"errorCode":"0004","errorDescription":"Token expired"}', 401)

    const res = await arubaUpload('demo', 'AT', { dataFileBase64: 'x', senderPIVA: '12345678903' })

    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('0004')
    expect(res.errorDescription).toContain('Token expired')
  })

  it('HTTP 500 con corpo NON JSON → la descrizione porta comunque il corpo, non solo «500»', async () => {
    // È il ramo che prima produceva `errorCode: '500'` e `errorDescription: undefined`, e
    // scriveva in `fatture_emesse.sdi_scarto_motivo` la stringa «500».
    const { arubaUpload } = await carica()
    globalThis.fetch = rispondi('Service Unavailable: manutenzione programmata SDI', 500)

    const res = await arubaUpload('demo', 'AT', { dataFileBase64: 'x', senderPIVA: '12345678903' })

    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('500')
    expect(res.errorDescription).toContain('manutenzione programmata SDI')
  })

  it('rete giù → LANCIA, non finge uno scarto', async () => {
    // Distinzione con conseguenza fiscale: `externalFetch` non lancia MAI (è il suo
    // contratto), ma una fattura che non è nemmeno partita non deve finire a registro come
    // «scartata da Aruba» — il chiamante inserirebbe una riga `fatture_emesse` per un invio
    // mai avvenuto. Prima lanciava il `fetch` stesso: quel comportamento va conservato.
    const { arubaUpload } = await carica()
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    }) as unknown as typeof fetch

    const errore = await arubaUpload('demo', 'AT', { dataFileBase64: 'x', senderPIVA: 'p' }).catch((e: unknown) => e)

    expect(errore).toBeInstanceOf(Error)
    expect((errore as Error).message).toContain('ECONNREFUSED')
  })

  it('200 con envelope 0000 → ok, e il filename torna al chiamante', async () => {
    const { arubaUpload } = await carica()
    globalThis.fetch = rispondi('{"uploadFileName":"IT12345678903_a1b2.xml.p7m","errorCode":"0000"}', 200)

    const res = await arubaUpload('demo', 'AT', { dataFileBase64: 'x', senderPIVA: '12345678903' })

    expect(res.ok).toBe(true)
    expect(res.uploadFileName).toBe('IT12345678903_a1b2.xml.p7m')
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 4. Il `catch {}` di `readJson`: «corpo vuoto» e «corpo illeggibile» non sono la stessa cosa.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('lettura della risposta — un 200 muto non passa più in silenzio', () => {
  it('200 con corpo VUOTO → non lancia, ma lascia una riga che lo dice', async () => {
    // Senza, `arubaGetByFilename` restituirebbe `stato: 0` — che il chiamante mappa come
    // stato SDI sconosciuto — e nessuno saprebbe che Aruba ha risposto senza dire niente.
    const { arubaGetByFilename } = await carica()
    globalThis.fetch = rispondi('', 200)

    const st = await arubaGetByFilename('demo', 'AT', 'IT123_a1.xml.p7m')
    expect(st.stato).toBe(0)

    // [0] è il battito di successo di `externalFetch`; [1] è la diagnosi della lettura.
    const r = await rigaPersistita(1)
    expect(r.livello).toBe('warn')
    expect(String(r.messaggio) + JSON.stringify(r)).toContain('vuot')
  })

  it('200 con corpo NON JSON → riga distinta da «vuoto», col corpo nel messaggio', async () => {
    const { arubaGetByFilename } = await carica()
    globalThis.fetch = rispondi('<html>manutenzione</html>', 200)

    await arubaGetByFilename('demo', 'AT', 'IT123_a1.xml.p7m')

    const r = await rigaPersistita(1)
    expect(r.livello).toBe('warn')
    expect(JSON.stringify(r)).not.toContain('vuot')
  })
})
