import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'
import catalogoIt from '../../messages/it/auth.json'

/**
 * GLI SPAZI CHE SI PORTANO DIETRO — il difetto misurato il 2026-08-22.
 *
 * Quel giorno il cron ha spedito 67 credenziali a famiglie vere. 37 sono entrate,
 * 30 no, e alcune hanno telefonato dicendo «non funziona». Nessuna password era
 * stata ruotata: quelle che avevano in mano erano esattamente quelle su GoTrue.
 *
 * Una password temporanea si legge su un telefono e si incolla in un altro campo,
 * e su un telefono si seleziona **col dito**: la selezione prende quasi sempre uno
 * spazio, o un a-capo, insieme al testo. `signInWithPassword` riceveva quella
 * stringa tale e quale, GoTrue rispondeva `400 invalid_credentials`, e la schermata
 * diceva «credenziali non valide» — che è vero per il server e falso per la persona,
 * che quella password ce l'aveva giusta.
 *
 * ─── PERCHÉ NON UN `trim()` SECCO SULLA PASSWORD ────────────────────────────────
 * Perché toglierebbe l'accesso a chi ha scelto in onboarding una password con spazi
 * ai bordi — e glielo toglierebbe senza che possa capirlo, visto che il messaggio è
 * indistinto. Qui la stringa GREZZA si prova SEMPRE per prima: chi è dentro resta
 * dentro per costruzione, e il secondo tentativo lo vede solo chi stava già
 * fallendo. Sull'EMAIL invece il `trim()` è secco: uno spazio ai bordi di un
 * indirizzo non ha nessuna semantica legittima, e GoTrue normalizza già di suo.
 */

// Riferimento STABILE, come il vero useRouter.
const mockRouter = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }
let mockSearch = new URLSearchParams()

vi.mock('next/navigation', () => ({
    useRouter: () => mockRouter,
    useSearchParams: () => mockSearch,
}))

const h = vi.hoisted(() => ({
    signIn: vi.fn(async () => ({ error: null }) as { error: unknown }),
    /** La spia sul logger del client: è il modo in cui si guarda la regola 5 di AGENTS.md. */
    logClient: vi.fn(),
    /** Il corpo che `/api/me` restituisce quando risponde 200. */
    me: null as Record<string, unknown> | null,
    /** `/api/me` che non risponde MAI: la risposta HTTP non arriva. */
    meMuta: false,
    /** `/api/me` che risponde ma il cui CORPO non arriva mai (`res.json()` appeso). */
    corpoMuto: false,
    /** `/api/me` che risponde NON-OK, con questo status (500 = server giù, 401 = sessione cieca). */
    meStato: null as number | null,
    /** `/api/me` la cui `fetch` RIFIUTA: la rete cade fra l'autenticazione e il profilo. */
    meRifiuta: false,
    /** `/api/me` che risponde 200 ma con un corpo che NON è il nostro JSON (pagina di un proxy). */
    corpoRotto: false,
    /** `/api/auth/active-role` che non risponde mai. */
    ruoloMuto: false,
    /** `/api/auth/active-role` che risponde NON-OK, con questo status (403 = ruolo non tuo). */
    ruoloStato: null as number | null,
}))

vi.mock('@/lib/supabase/browser-client', () => ({
    getSupabase: () => ({ auth: { signInWithPassword: h.signIn } }),
}))

/**
 * `logClient` spiata, `nomeErrore` VERA. La classificazione del nome dell'errore è parte di
 * ciò che si asserisce (è l'unico pezzo dell'errore che può lasciare il dispositivo): mockarla
 * significherebbe misurare il mock.
 */
vi.mock('@/lib/logging/client', async (importOriginal) => {
    const reale = await importOriginal<typeof import('@/lib/logging/client')>()
    return { ...reale, logClient: h.logClient }
})

import LoginPage from '@/app/auth/login/page'

const DOCENTE = { id: 'u-1', role: 'educator', profili: [{ ruolo: 'educator', area: 'teacher' }] }

/** La promise che non si risolverà mai: è lo scenario del rilievo, non una metafora. */
const MAI = () => new Promise<never>(() => {})

/**
 * Il corpo che arriva ma non è il nostro. È il proxy (o il portale captive, o la pagina di
 * cortesia della CDN) che risponde 200 con dell'HTML: `res.json()` non resta appeso — RIFIUTA.
 * È lo stesso scenario 3 già collaudato su `signInWithPassword` un passo più indietro, e fino al
 * 2026-08-03 qui non esisteva: il `.catch(() => null)` lo faceva sembrare «nessun profilo».
 */
const CORPO_NON_JSON = async () => {
    throw new SyntaxError("Unexpected token '<', \"<html>\"... is not valid JSON")
}

const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/api/auth/active-role')) {
        if (h.ruoloMuto) return MAI()
        if (h.ruoloStato !== null) {
            return { ok: false, status: h.ruoloStato, json: async () => ({ error: 'no' }) }
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    if (String(url).includes('/api/me')) {
        if (h.meMuta) return MAI()
        if (h.meRifiuta) throw new TypeError('Failed to fetch')
        if (h.meStato !== null) {
            return { ok: false, status: h.meStato, json: async () => ({ error: 'no' }) }
        }
        return {
            ok: true,
            status: 200,
            json: h.corpoMuto ? MAI : h.corpoRotto ? CORPO_NON_JSON : async () => h.me,
        }
    }
    return { ok: false, status: 404, json: async () => null }
})

/**
 * La forma ESATTA degli errori di `@supabase/auth-js` (2.110), da
 * `node_modules/@supabase/auth-js/dist/main/lib/errors.js`. Sono tutti `Error` con
 * `__isAuthError`, e i due campi che li distinguono sono `name` e `status`:
 *
 *  · password sbagliata      → `AuthApiError`             status 400, code `invalid_credentials`
 *  · rate limit              → `AuthApiError`             status 429, code `over_request_rate_limit`
 *  · 5xx (database giù)      → `AuthRetryableFetchError`  status 500 (`NETWORK_ERROR_CODES`)
 *  · corpo non-JSON su 4xx   → `AuthUnknownError`         status assente
 *  · rete caduta / non-JSON  → `AuthRetryableFetchError`  status 0
 *    su una risposta ok
 *
 * Si costruiscono a mano invece di importare `@supabase/auth-js` (dipendenza transitiva,
 * non dichiarata nel nostro `package.json`): il contratto che ci serve sono quei due
 * campi, e scriverli qui li rende leggibili a chi apre il test.
 */
function erroreAuth(nome: string, status: number | undefined, code?: string) {
    const e = new Error(`finto ${nome}`) as Error & {
        __isAuthError: true
        status?: number
        code?: string
    }
    e.name = nome
    e.__isAuthError = true
    e.status = status
    e.code = code
    return e
}

const ERRORI = {
    /** 1 — database giù: GoTrue risponde 500, auth-js lo avvolge come retryable. */
    cinquecento: erroreAuth('AuthRetryableFetchError', 500),
    /** 2 — rate limit. */
    quattroVentinove: erroreAuth('AuthApiError', 429, 'over_request_rate_limit'),
    /** 3 — risposta non-JSON su uno stato d'errore (una pagina HTML di un proxy). */
    nonJson: erroreAuth('AuthUnknownError', undefined),
    /** 4 — risposta non-JSON su uno stato ok: auth-js non ha nemmeno uno status da dare. */
    nonJsonSuOk: erroreAuth('AuthRetryableFetchError', 0),
    /** 5 — rete caduta: `fetch` rifiuta, auth-js traduce in retryable con status 0. */
    reteCaduta: erroreAuth('AuthRetryableFetchError', 0),
    /** 6 — il 418: nessuno lo produce davvero, ed è il punto (vedi il test). */
    quattroDiciotto: erroreAuth('AuthApiError', 418, 'i_am_a_teapot'),
    /** 7 — password sbagliata. */
    credenziali: erroreAuth('AuthApiError', 400, 'invalid_credentials'),
    /** 8 — email inesistente: dall'esterno deve essere INDISTINGUIBILE dal 7. */
    utenteInesistente: erroreAuth('AuthApiError', 400, 'user_not_found'),
}



function renderLogin() {
    return render(
        <AccessibilityProvider initialHighContrast={false}>
            <LoginPage />
        </AccessibilityProvider>,
    )
}

function bottoneAccedi(): HTMLButtonElement {
    return screen.getByRole('button', { name: /Accedi|Accesso/ }) as HTMLButtonElement
}

/**
 * Le credenziali digitate. Sono costanti, e RICONOSCIBILI, perché servono a un'asserzione
 * che non riguarda l'accesso: nessuna delle due deve comparire in un log (regola 8 di
 * AGENTS.md). Una password scritta `pw` sarebbe indistinguibile da una sillaba qualunque
 * dentro una frase, cioè un controllo che non può fallire.
 */
const EMAIL = 'doc@kidville.it'
const PASSWORD = 'PasswordSegretissima42'

function submitCredenziali() {
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: EMAIL } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } })
    fireEvent.click(bottoneAccedi())
}

/** Il testo mostrato all'utente, atteso finché non compare. */
async function messaggioMostrato(): Promise<string> {
    const avviso = await screen.findByRole('alert')
    return avviso.textContent ?? ''
}



/** Tutti gli eventi passati a `logClient`, in ordine. */
function eventiLoggati(): Array<Record<string, unknown>> {
    return h.logClient.mock.calls.map((c) => c[0] as Record<string, unknown>)
}

beforeEach(() => {
    vi.clearAllMocks()
    h.me = null
    h.meMuta = false
    h.meStato = null
    h.meRifiuta = false
    h.corpoMuto = false
    h.corpoRotto = false
    h.ruoloMuto = false
    h.ruoloStato = null
    h.signIn.mockReset()
    mockSearch = new URLSearchParams()
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})


describe('gli spazi incollati non chiudono fuori nessuno', () => {
    it('password giusta con uno spazio in coda: si entra, al secondo tentativo', async () => {
        // Lo scenario del 22/08, riprodotto: la password è quella vera, il dito ha
        // preso uno spazio di troppo.
        h.signIn
            .mockResolvedValueOnce({ error: ERRORI.credenziali })
            .mockResolvedValueOnce({ error: null })
        h.me = DOCENTE

        renderLogin()
        fireEvent.change(screen.getByLabelText('Email'), { target: { value: EMAIL } })
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: `${PASSWORD} ` } })
        fireEvent.click(bottoneAccedi())

        await waitFor(() => expect(mockRouter.replace).toHaveBeenCalled())
        expect(h.signIn).toHaveBeenCalledTimes(2)
        // Il primo tentativo con la stringa GREZZA, il secondo con quella ripulita.
        expect((h.signIn.mock.calls[0] as unknown[])[0]).toMatchObject({ password: `${PASSWORD} ` })
        expect((h.signIn.mock.calls[1] as unknown[])[0]).toMatchObject({ password: PASSWORD })
    })

    it('password con spazi ai bordi CHE È QUELLA GIUSTA: si entra al PRIMO colpo', async () => {
        // Il lock che protegge chi ha scelto una password con spazi ai bordi. Se un
        // giorno qualcuno sostituisse il ritentativo con un `trim()` secco, questo
        // test diventerebbe rosso — ed è l'unico modo di accorgersene prima che se ne
        // accorga la persona chiusa fuori.
        const CON_SPAZI = `  ${PASSWORD}  `
        h.signIn.mockResolvedValueOnce({ error: null })
        h.me = DOCENTE

        renderLogin()
        fireEvent.change(screen.getByLabelText('Email'), { target: { value: EMAIL } })
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: CON_SPAZI } })
        fireEvent.click(bottoneAccedi())

        await waitFor(() => expect(mockRouter.replace).toHaveBeenCalled())
        expect(h.signIn).toHaveBeenCalledTimes(1)
        expect((h.signIn.mock.calls[0] as unknown[])[0]).toMatchObject({ password: CON_SPAZI })
    })

    it('password sbagliata SENZA spazi: un solo tentativo, nessuna richiesta in regalo', async () => {
        h.signIn.mockResolvedValue({ error: ERRORI.credenziali })

        renderLogin()
        submitCredenziali()
        await screen.findByRole('alert')

        expect(h.signIn).toHaveBeenCalledTimes(1)
    })

    it('password sbagliata E con spazi: due tentativi, poi lo stesso identico messaggio', async () => {
        h.signIn.mockResolvedValue({ error: ERRORI.credenziali })

        renderLogin()
        fireEvent.change(screen.getByLabelText('Email'), { target: { value: EMAIL } })
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: `${PASSWORD} ` } })
        fireEvent.click(bottoneAccedi())

        expect(await messaggioMostrato()).toBe(catalogoIt.credenzialiNonValide)
        expect(h.signIn).toHaveBeenCalledTimes(2)
    })

    it('un 429 con spazi NON si ritenta: rilanciare su un rate limit lo peggiora', async () => {
        h.signIn.mockResolvedValue({ error: ERRORI.quattroVentinove })

        renderLogin()
        fireEvent.change(screen.getByLabelText('Email'), { target: { value: EMAIL } })
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: `${PASSWORD} ` } })
        fireEvent.click(bottoneAccedi())

        expect(await messaggioMostrato()).toBe(catalogoIt.troppiTentativi)
        expect(h.signIn).toHaveBeenCalledTimes(1)
    })

    it('un guasto del servizio con spazi NON si ritenta', async () => {
        // Su un 500 il secondo tentativo mentirebbe due volte: non è la password.
        h.signIn.mockResolvedValue({ error: ERRORI.cinquecento })

        renderLogin()
        fireEvent.change(screen.getByLabelText('Email'), { target: { value: EMAIL } })
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: `${PASSWORD} ` } })
        fireEvent.click(bottoneAccedi())

        expect(await messaggioMostrato()).toBe(catalogoIt.servizioNonDisponibile)
        expect(h.signIn).toHaveBeenCalledTimes(1)
    })

    it('l\'email arriva a GoTrue senza spazi, e senza costare un tentativo in più', async () => {
        h.signIn.mockResolvedValueOnce({ error: null })
        h.me = DOCENTE

        renderLogin()
        fireEvent.change(screen.getByLabelText('Email'), { target: { value: `  ${EMAIL}  ` } })
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } })
        fireEvent.click(bottoneAccedi())

        await waitFor(() => expect(mockRouter.replace).toHaveBeenCalled())
        expect(h.signIn).toHaveBeenCalledTimes(1)
        expect((h.signIn.mock.calls[0] as unknown[])[0]).toMatchObject({ email: EMAIL })
    })

    it('il ritentativo si vede nel log: spazi=password e riprova=riuscita', async () => {
        // È la prova che il rimedio funziona, e la regola 5 di AGENTS.md applicata a
        // un ricupero: senza questa riga non sapremmo MAI quante persone sono state
        // salvate dal secondo tentativo, cioè quanto pesava davvero il difetto.
        h.signIn
            .mockResolvedValueOnce({ error: ERRORI.credenziali })
            .mockResolvedValueOnce({ error: null })
        h.me = DOCENTE

        renderLogin()
        fireEvent.change(screen.getByLabelText('Email'), { target: { value: EMAIL } })
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: `${PASSWORD} ` } })
        fireEvent.click(bottoneAccedi())

        await waitFor(() => expect(mockRouter.replace).toHaveBeenCalled())
        const messaggio = eventiLoggati().map((e) => String(e.messaggio)).join(' | ')
        expect(messaggio).toContain('spazi=password')
        expect(messaggio).toContain('riprova=riuscita')
    })
})
