import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'
import catalogoIt from '../../messages/it/auth.json'
import catalogoEn from '../../messages/en/auth.json'

/**
 * T16-F3 / T16-F4 — «credenziali non valide» era la risposta a QUALUNQUE guasto.
 *
 * IL DIFETTO MISURATO (collaudo del 2026-08-02, sei scenari con `/auth/v1/token`
 * intercettata): 500 col database giù, 429 di rate limit, risposta non-JSON, risposta
 * lenta 12 s, rete caduta e un 418 messo apposta come prova di validità. **Sei scenari,
 * un messaggio solo**: «Credenziali non valide. L'accesso è solo su invito della
 * Segreteria.»
 *
 * Le due conseguenze, entrambe reali:
 *  · col database giù la persona cambia una password che era giusta, poi telefona alla
 *    Segreteria, e nessuno capisce che è in corso un guasto;
 *  · per chi legge i log, un'ondata di «credenziali non valide» sembra un ATTACCO invece
 *    che un'indisponibilità.
 *
 * LA CAUSA RADICE è la regola 7 di AGENTS.md nella sua versione auth:
 * `supabase.auth.signInWithPassword()` **non lancia**, ritorna `{ error }` — per la
 * password sbagliata, per l'`AuthApiError` 5xx e per l'`AuthRetryableFetchError` di rete
 * allo stesso modo. Il codice guardava `if (error)` e nient'altro: né `error.status` né
 * `error.name`. La conseguenza verificabile era che il ramo `catch { erroreConnessione }`
 * **non era raggiungibile**, e quella traduzione non si vedeva mai.
 *
 * T16-F4 è lo stesso `onSubmit` visto dall'altro lato: senza tetto di tempo, una risposta
 * che non arriva mai lascia il bottone su «Accesso…» per sempre.
 *
 * ─── LA DISTINZIONE CHE SI INTRODUCE, E QUELLA CHE NON SI INTRODUCE ──────────────
 * Si distingue **l'errore dell'utente dal guasto del servizio**. NON si distingue fra i
 * tipi di errore dell'utente: «credenziali non valide» resta indistinto fra email
 * inesistente e password sbagliata, perché dire a un anonimo quale delle due è gli
 * direbbe se quell'indirizzo è iscritto a una scuola dell'infanzia. I test 7 e 8 qui
 * sotto sono il lock di quella indistinguibilità.
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
const DOPPIO = {
    id: 'u-1',
    role: 'educator',
    profili: [
        { ruolo: 'educator', area: 'teacher' },
        { ruolo: 'genitore', area: 'parent' },
    ],
}

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

/**
 * Abbondantemente oltre qualunque tetto ragionevole. Volutamente NON è la costante di
 * produzione: il test misura la conseguenza («il bottone si sblocca e compare un
 * messaggio»), non ricopia il numero che il codice ha scelto.
 */
const OLTRE_IL_TETTO_MS = 60_000

/** Il ritardo dello scenario 4 del collaudo: lento, ma il tetto non deve tagliarlo. */
const LENTA_MA_VERA_MS = 12_000

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

/** Il testo dell'avviso ADESSO, senza attese: usato con i timer finti già avanzati. */
function messaggioOra(): string {
    return screen.getByRole('alert').textContent ?? ''
}

/** Tutti gli eventi passati a `logClient`, in ordine. */
function eventiLoggati(): Array<Record<string, unknown>> {
    return h.logClient.mock.calls.map((c) => c[0] as Record<string, unknown>)
}

beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    mockSearch = new URLSearchParams()
    h.me = { ...DOCENTE }
    h.meMuta = false
    h.corpoMuto = false
    h.meStato = null
    h.meRifiuta = false
    h.corpoRotto = false
    h.ruoloMuto = false
    h.ruoloStato = null
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
    vi.useRealTimers()
})

describe('T16-F3 — un guasto del servizio non si racconta come una password sbagliata', () => {
    const SCENARI = [
        {
            nome: '1. 500 · database giù',
            errore: ERRORI.cinquecento,
            atteso: () => catalogoIt.servizioNonDisponibile,
        },
        {
            nome: '2. 429 · rate limit',
            errore: ERRORI.quattroVentinove,
            atteso: () => catalogoIt.troppiTentativi,
        },
        {
            nome: '3. risposta non-JSON',
            errore: ERRORI.nonJson,
            atteso: () => catalogoIt.erroreImprevisto,
        },
        {
            nome: '4. risposta non-JSON su stato ok',
            errore: ERRORI.nonJsonSuOk,
            atteso: () => catalogoIt.erroreConnessione,
        },
        {
            nome: '5. rete caduta',
            errore: ERRORI.reteCaduta,
            atteso: () => catalogoIt.erroreConnessione,
        },
        {
            nome: '6. 418 · lo stato che nessuno produce (prova di validità dello scenario)',
            errore: ERRORI.quattroDiciotto,
            atteso: () => catalogoIt.erroreImprevisto,
        },
    ] as const

    it.each(SCENARI)('$nome: NON dice «credenziali non valide»', async ({ errore }) => {
        h.signIn.mockResolvedValueOnce({ error: errore })
        renderLogin()
        submitCredenziali()

        const testo = await messaggioMostrato()
        // L'asserzione che vale tutte le altre: qualunque cosa dica, non può dare la
        // colpa alle credenziali di chi sta guardando.
        expect(testo).not.toBe(catalogoIt.credenzialiNonValide)
    })

    it.each(SCENARI)('$nome: mostra il messaggio giusto', async ({ errore, atteso }) => {
        h.signIn.mockResolvedValueOnce({ error: errore })
        renderLogin()
        submitCredenziali()

        expect(await messaggioMostrato()).toBe(atteso())
    })

    it('il guasto del servizio non marca i campi come non validi (a11y)', async () => {
        // `aria-invalid` su email e password dice allo screen reader «hai sbagliato tu».
        // Col database giù è falso quanto il messaggio, e va detto agli stessi utenti.
        h.signIn.mockResolvedValueOnce({ error: ERRORI.cinquecento })
        renderLogin()
        submitCredenziali()
        // Anche qui si asserisce il TESTO: senza, il test resterebbe verde col difetto
        // rimesso (`setError` da solo non marca i campi) — cioè sarebbe un test finto.
        expect(await messaggioMostrato()).toBe(catalogoIt.servizioNonDisponibile)

        expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'false')
        expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'false')
        // Il messaggio però resta collegato ai campi: chi naviga a tastiera deve sentirlo.
        expect(screen.getByLabelText('Email')).toHaveAttribute('aria-describedby', 'login-error')
    })

    it('un errore LANCIATO passa dalla stessa classificazione del ramo `{ error }`', async () => {
        // Il ramo `catch` esisteva già ed era irraggiungibile. Adesso che qualcosa può
        // davvero lanciare (il tetto di tempo rilancia il rifiuto neutralizzato), deve
        // raccontare la stessa cosa: un guasto è un guasto da qualunque parte arrivi.
        h.signIn.mockRejectedValueOnce(ERRORI.cinquecento)
        renderLogin()
        submitCredenziali()

        expect(await messaggioMostrato()).toBe(catalogoIt.servizioNonDisponibile)
    })

    it('«erroreConnessione» — la traduzione che non si vedeva mai — adesso si vede', async () => {
        // La conseguenza verificabile della causa radice: con `if (error)` unico, il ramo
        // `catch` era irraggiungibile (signInWithPassword non lancia) e questa stringa era
        // codice morto in entrambi i cataloghi.
        h.signIn.mockResolvedValueOnce({ error: ERRORI.reteCaduta })
        renderLogin()
        submitCredenziali()

        expect(await messaggioMostrato()).toBe(catalogoIt.erroreConnessione)
    })
})

describe('T16-F3 — quello che NON deve cambiare: l’errore dell’utente resta indistinto', () => {
    it('password sbagliata: «credenziali non valide», e i campi sono marcati non validi', async () => {
        h.signIn.mockResolvedValueOnce({ error: ERRORI.credenziali })
        renderLogin()
        submitCredenziali()

        expect(await messaggioMostrato()).toBe(catalogoIt.credenzialiNonValide)
        expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true')
    })

    it('email inesistente: messaggio IDENTICO alla password sbagliata (nessuna enumerazione)', async () => {
        h.signIn.mockResolvedValueOnce({ error: ERRORI.utenteInesistente })
        renderLogin()
        submitCredenziali()

        // Se un giorno qualcuno «migliorasse» questo messaggio in «utente non trovato»,
        // il modulo di login diventerebbe un oracolo su chi è iscritto alla scuola.
        expect(await messaggioMostrato()).toBe(catalogoIt.credenzialiNonValide)
    })
})

describe('T16-F4 — il bottone non resta «Accesso…» per sempre', () => {
    it('risposta che non arriva MAI: dopo il tetto compare un messaggio e il bottone torna attivo', async () => {
        vi.useFakeTimers()
        // La promise che nessuno risolverà: è lo scenario esatto del rilievo.
        h.signIn.mockReturnValueOnce(new Promise(() => {}) as never)

        renderLogin()
        submitCredenziali()

        // Prima del tetto: si sta ancora aspettando, e si vede.
        expect(bottoneAccedi()).toBeDisabled()
        expect(bottoneAccedi()).toHaveTextContent(catalogoIt.accesso)
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()

        await act(async () => {
            await vi.advanceTimersByTimeAsync(OLTRE_IL_TETTO_MS)
        })

        expect(screen.getByRole('alert')).toHaveTextContent(catalogoIt.timeoutAccesso)
        expect(bottoneAccedi()).toBeEnabled()
        expect(bottoneAccedi()).toHaveTextContent(catalogoIt.accedi)
    })

    it('risposta lenta 12 s ma VERA: il tetto non la taglia, si entra', async () => {
        vi.useFakeTimers()
        h.signIn.mockReturnValueOnce(
            new Promise((resolve) => {
                setTimeout(() => resolve({ error: null }), LENTA_MA_VERA_MS)
            }) as never,
        )

        renderLogin()
        submitCredenziali()

        await act(async () => {
            await vi.advanceTimersByTimeAsync(LENTA_MA_VERA_MS + 100)
        })

        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(mockRouter.replace).toHaveBeenCalledWith('/teacher')
    })

    it('login riuscito: il tetto viene SPENTO (nessun timer resta in volo)', async () => {
        vi.useFakeTimers()
        h.signIn.mockResolvedValueOnce({ error: null })

        renderLogin()
        submitCredenziali()

        // Il flusso arriva in fondo SENZA che sia scattato nessun tetto: qui il tempo non è
        // ancora passato.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0)
        })
        expect(mockRouter.replace).toHaveBeenCalledWith('/teacher')

        /*
         * ⚠️ L'ASSERZIONE VA QUI, E LA POSIZIONE È TUTTO.
         *
         * Il vecchio test guardava lo schermo DOPO aver fatto passare 60 secondi, e restava
         * verde con `clearTimeout` disattivato (misurato il 2026-08-03): a `Promise.race` già
         * decisa un timer che scatta non produce nessun messaggio. Ma non basta nemmeno
         * spostare il conteggio dei timer alla fine — `advanceTimersByTime` li FA SCATTARE, e
         * un timer scattato non è più in volo: il conto tornerebbe 0 comunque, cioè un
         * secondo test finto al posto del primo.
         *
         * L'unico istante in cui la differenza esiste è questo: flusso finito, tempo non
         * ancora passato. Sono tre corse (credenziali, `/api/me`, ruolo attivo); se anche una
         * sola resta accesa, il conto è ≥ 1.
         */
        expect(vi.getTimerCount(), 'un tetto è rimasto acceso a login già riuscito').toBe(0)

        // …e il tempo che passa non fa comparire «il server non risponde» a login fatto.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(OLTRE_IL_TETTO_MS)
        })
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('un rifiuto che arriva DOPO il tetto non cambia il messaggio già mostrato', async () => {
        /*
         * Cosa misura QUESTO test: che la corsa, una volta decisa, resti decisa — se
         * `conTettoDiTempo` aspettasse comunque il lavoro abbandonato, qui il messaggio
         * diventerebbe «servizio non disponibile» dopo che l'utente ha già letto il timeout.
         *
         * Cosa NON misura, e prima diceva di misurare: che quel rifiuto non diventi un
         * `unhandledrejection`. La garanzia c'è, ma non è di questo test — e non era nemmeno
         * della «neutralizzazione» che il commento di `conTettoDiTempo` dichiarava portante:
         * togliendola tutto restava verde, perché a tenere gestito il perdente è
         * `Promise.race` stessa. Quella proprietà si misura dove la si può vedere,
         * `__tests__/lib/auth-tetto-accesso.test.ts`, con `process.on('unhandledRejection')`.
         */
        vi.useFakeTimers()
        h.signIn.mockReturnValueOnce(
            new Promise((_resolve, reject) => {
                setTimeout(() => reject(ERRORI.cinquecento), OLTRE_IL_TETTO_MS * 2)
            }) as never,
        )

        renderLogin()
        submitCredenziali()

        await act(async () => {
            await vi.advanceTimersByTimeAsync(OLTRE_IL_TETTO_MS)
        })
        expect(screen.getByRole('alert')).toHaveTextContent(catalogoIt.timeoutAccesso)

        // …e adesso arriva il rifiuto, a corsa finita.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(OLTRE_IL_TETTO_MS * 2)
        })
        expect(screen.getByRole('alert')).toHaveTextContent(catalogoIt.timeoutAccesso)
        expect(mockRouter.replace).not.toHaveBeenCalled()
    })

    it('dopo un guasto si può riprovare: il bottone torna «Accedi»', async () => {
        h.signIn.mockResolvedValueOnce({ error: ERRORI.cinquecento })
        renderLogin()
        submitCredenziali()
        await messaggioMostrato()

        await waitFor(() => expect(bottoneAccedi()).toBeEnabled())
        expect(bottoneAccedi()).toHaveTextContent(catalogoIt.accedi)
    })
})

/**
 * W8 — IL TETTO ERA APPESO UNA RIGA PIÙ SOPRA DI DOVE SERVIVA.
 *
 * Misurato il 2026-08-03. `signInWithPassword` aveva il suo tetto, ma la stessa `onSubmit`
 * subito dopo aspettava SENZA TETTO `/api/me` e `/api/auth/active-role`. Con `/api/me` che non
 * risponde mai, dopo 300 secondi simulati il bottone era ancora `disabled` su «Accesso…»,
 * nessun `role="alert"`, nessun modo di riprovare: il sintomo ESATTO di T16-F4, rimesso in
 * piedi una riga più sotto — e per giunta **a utente ormai autenticato**, cookie di sessione
 * già scritto. Gli stessi due passi scoperti stavano nel picker dei ruoli e nell'effetto
 * `?scegli=1`, dove l'attesa non finiva mai e la pagina non mostrava mai né il form né i ruoli.
 */
describe('W8 — il tetto vale per l’INTERA sequenza di accesso', () => {
    /** Il tempo scorre e la pagina reagisce: un solo posto da cambiare se il tetto cambia. */
    async function passaIlTempo(ms = OLTRE_IL_TETTO_MS) {
        await act(async () => {
            await vi.advanceTimersByTimeAsync(ms)
        })
    }

    it('/api/me non risponde MAI: compare il messaggio e il bottone torna attivo', async () => {
        vi.useFakeTimers()
        h.meMuta = true

        renderLogin()
        submitCredenziali()

        expect(bottoneAccedi()).toBeDisabled()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()

        await passaIlTempo()

        expect(messaggioOra()).toBe(catalogoIt.timeoutDopoAccesso)
        expect(bottoneAccedi()).toBeEnabled()
        expect(bottoneAccedi()).toHaveTextContent(catalogoIt.accedi)
        expect(mockRouter.replace).not.toHaveBeenCalled()
    })

    it('/api/me risponde ma il CORPO non arriva mai: stesso esito (è la stessa attesa)', async () => {
        // `res.json()` che non finisce pianta la pagina esattamente come una `fetch` appesa:
        // un tetto messo sulla sola `fetch` coprirebbe metà del blocco.
        vi.useFakeTimers()
        h.corpoMuto = true

        renderLogin()
        submitCredenziali()
        await passaIlTempo()

        expect(messaggioOra()).toBe(catalogoIt.timeoutDopoAccesso)
        expect(bottoneAccedi()).toBeEnabled()
    })

    it('/api/auth/active-role non risponde MAI: la pagina non resta appesa a un passo dalla fine', async () => {
        vi.useFakeTimers()
        h.ruoloMuto = true

        renderLogin()
        submitCredenziali()
        await passaIlTempo()

        expect(messaggioOra()).toBe(catalogoIt.timeoutDopoAccesso)
        expect(bottoneAccedi()).toBeEnabled()
        expect(mockRouter.replace).not.toHaveBeenCalled()
    })

    it('a utente AUTENTICATO il messaggio non accusa le credenziali: dice che sono corrette', async () => {
        // È la parte del rilievo che non si vede da un timer: `erroreImprevisto` («non dipende
        // dalle tue credenziali») è troppo timido quando le credenziali sono appena state
        // ACCETTATE, e `credenzialiNonValide` sarebbe una bugia. Manda a cambiare una password
        // che funziona: lo stesso danno di T16-F3, alla schermata dopo.
        vi.useFakeTimers()
        h.meMuta = true

        renderLogin()
        submitCredenziali()
        await passaIlTempo()

        const testo = messaggioOra()
        expect(testo).not.toBe(catalogoIt.credenzialiNonValide)
        expect(testo).not.toBe(catalogoIt.erroreImprevisto)
        expect(testo).toContain('corrette')
        // …e nemmeno agli screen reader si dice che i campi sono sbagliati.
        expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'false')
        expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'false')
    })

    it('il tetto è dell’intera sequenza: 10 s di accesso + /api/me muta scadono a 15 s, non a 25', async () => {
        // ⟵ È LA PROVA CHE IL BUDGET È CONDIVISO. Con un tetto per chiamata, a 15,1 secondi
        // dal click non sarebbe ancora successo niente: il bottone resterebbe «Accesso…» per
        // 25 secondi, cioè per la SOMMA delle attese.
        vi.useFakeTimers()
        h.meMuta = true
        h.signIn.mockReturnValueOnce(
            new Promise((resolve) => {
                setTimeout(() => resolve({ error: null }), 10_000)
            }) as never,
        )

        renderLogin()
        submitCredenziali()

        await passaIlTempo(10_000)
        expect(screen.queryByRole('alert')).not.toBeInTheDocument() // l'accesso è appena andato

        await passaIlTempo(5_100)
        expect(messaggioOra()).toBe(catalogoIt.timeoutDopoAccesso)
        expect(bottoneAccedi()).toBeEnabled()
    })

    it('picker dei ruoli: se il ruolo attivo non risponde, i bottoni non restano bloccati', async () => {
        vi.useFakeTimers()
        h.me = { ...DOPPIO }

        renderLogin()
        submitCredenziali()
        await passaIlTempo(0) // il picker compare senza aspettare nessun tetto

        const genitore = screen.getByRole('button', { name: 'Genitore' })
        h.ruoloMuto = true
        fireEvent.click(genitore)
        expect(genitore).toBeDisabled()

        await passaIlTempo()

        expect(messaggioOra()).toBe(catalogoIt.timeoutDopoAccesso)
        expect(screen.getByRole('button', { name: 'Genitore' })).toBeEnabled()
        expect(mockRouter.replace).not.toHaveBeenCalled()
    })

    it('un guasto QUALUNQUE dopo l’autenticazione non si racconta come «errore imprevisto»', async () => {
        // La navigazione che lancia è l'unico modo in cui il ramo `catch` si raggiunge a
        // sessione già scritta — e lì la classificazione normale direbbe «non dipende dalle
        // tue credenziali» a una persona di cui abbiamo appena accettato le credenziali.
        mockRouter.replace.mockImplementationOnce(() => {
            throw new Error('navigazione rifiutata')
        })

        renderLogin()
        submitCredenziali()

        expect(await messaggioMostrato()).toBe(catalogoIt.erroreDopoAccesso)
        expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'false')
        await waitFor(() => expect(bottoneAccedi()).toBeEnabled())
        // …e il guasto lascia la sua traccia, con la fase giusta.
        expect(String(eventiLoggati()[0]?.messaggio)).toContain('fase=dopo-accesso')
    })

    it('?scegli=1: se /api/me non risponde, l’attesa finisce e resta qualcosa da fare', async () => {
        // Il caso peggiore dei tre: chi arriva qui è GIÀ autenticato (lo manda la guardia
        // d'area) e la schermata non ha nemmeno un bottone. Senza tetto resta «Caricamento
        // dei profili…» per sempre.
        vi.useFakeTimers()
        mockSearch = new URLSearchParams('scegli=1')
        h.meMuta = true

        renderLogin()
        expect(screen.getByText(catalogoIt.caricamentoProfili)).toBeInTheDocument()

        await passaIlTempo()

        expect(messaggioOra()).toBe(catalogoIt.timeoutDopoAccesso)
        expect(screen.queryByText(catalogoIt.caricamentoProfili)).not.toBeInTheDocument()
        // Si ricade sul form credenziali: è l'unica superficie da cui si può ritentare.
        expect(screen.getByLabelText('Email')).toBeInTheDocument()
        expect(bottoneAccedi()).toBeEnabled()
    })

    it('?scegli=1 con un profilo solo: anche il ruolo attivo sta sotto il tetto', async () => {
        vi.useFakeTimers()
        mockSearch = new URLSearchParams('scegli=1')
        h.ruoloMuto = true

        renderLogin()
        await passaIlTempo()

        expect(messaggioOra()).toBe(catalogoIt.timeoutDopoAccesso)
        expect(screen.queryByText(catalogoIt.caricamentoProfili)).not.toBeInTheDocument()
        expect(mockRouter.replace).not.toHaveBeenCalled()
    })
})

/**
 * W8-bis — «UN GUASTO DOPO L'ACCESSO» ERA UNA CATEGORIA NUOVA, E LA STRADA ACCANTO NON LA USAVA.
 *
 * Misurato il 2026-08-03, subito dopo la correzione W8. Il tetto di tempo copriva ormai tutta la
 * sequenza, ma `leggiProfilo()` collassava TRE guasti diversi sullo stesso `null` con cui
 * diceva «questo utente non ha profili»: `fetch` che rifiuta, `!res.ok`, e `res.json()` che
 * rifiuta. Sonda eseguita su `/api/me → 500` dopo un'autenticazione riuscita:
 *
 *     replace: [['/']] | alert: NESSUNO | log: []
 *
 * Cioè: l'utente veniva spedito su `/` senza una parola; la guardia d'area, non trovando il
 * cookie di ruolo, lo rimandava a `?scegli=1`; lì la stessa fetch falliva di nuovo, `elenco`
 * tornava vuoto e si ricadeva sul form credenziali — muto. Due schermate e un giro senza uscita,
 * per un guasto che in `app_log` non lasciava NIENTE (il 401, in particolare, il patch di
 * `fetch` non lo spedisce nemmeno: vedi `livelloFetch`).
 *
 * I due `.catch(() => null)` erano anche la violazione diretta della regola 6 di AGENTS.md.
 */
describe('W8-bis — un `/api/me` che risponde MALE è un guasto, non un degrado silenzioso', () => {
    /** I quattro modi di rispondere male, e il modo di provocarli. */
    const ROTTURE = [
        {
            nome: '500 · il server è giù',
            prepara: () => { h.meStato = 500 },
            stato: 500,
            classe: 'RispostaNonOk',
        },
        {
            nome: '401 · la sessione appena scritta non si vede da server',
            prepara: () => { h.meStato = 401 },
            stato: 401,
            classe: 'RispostaNonOk',
        },
        {
            nome: '200 ma il corpo non è JSON (pagina HTML di un proxy)',
            prepara: () => { h.corpoRotto = true },
            // La risposta È arrivata, e con un 200: lo stato resta quello vero. Buttarlo via
            // renderebbe questo caso indistinguibile dalla rete caduta, che è il caso dopo.
            stato: 200,
            classe: 'SyntaxError',
        },
        {
            nome: 'la fetch rifiuta · la rete cade fra le credenziali e il profilo',
            prepara: () => { h.meRifiuta = true },
            // Nessuna risposta è mai arrivata: uno stato inventato qui sarebbe peggio di nessuno.
            stato: undefined,
            classe: 'TypeError',
        },
    ] as const

    it.each(ROTTURE)('$nome: messaggio, nessuna navigazione, bottone riattivo', async ({ prepara }) => {
        prepara()
        renderLogin()
        submitCredenziali()

        // Il messaggio è quello di DOPO l'accesso: le credenziali sono state accettate, e
        // mandare questa persona a cambiare la password sarebbe il danno di T16-F3 alla
        // schermata dopo.
        expect(await messaggioMostrato()).toBe(catalogoIt.erroreDopoAccesso)
        // ⟵ L'ASSERZIONE DEL RILIEVO: prima qui c'era `replace('/')`, e nient'altro.
        expect(mockRouter.replace).not.toHaveBeenCalled()
        await waitFor(() => expect(bottoneAccedi()).toBeEnabled())
        expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'false')
    })

    it.each(ROTTURE)('$nome: lascia UNA traccia, con fase, stato e classe dell’errore', async ({ prepara, stato, classe }) => {
        prepara()
        renderLogin()
        submitCredenziali()
        await messaggioMostrato()

        const eventi = eventiLoggati()
        expect(eventi).toHaveLength(1)
        expect(eventi[0]).toMatchObject({
            livello: 'warn',
            evento: 'fetch',
            route: '/auth/login',
            stato,
        })
        expect(String(eventi[0].messaggio)).toContain('fase=dopo-accesso')
        expect(String(eventi[0].messaggio)).toContain('esito=erroreDopoAccesso')
        // La CLASSE distingue i quattro guasti in tabella: senza, `500` e `pagina HTML`
        // sarebbero la stessa riga con due numeri diversi.
        expect(String(eventi[0].messaggio)).toContain(`errore=${classe}`)
    })

    it('con ?next= : non si naviga affatto, nemmeno verso una destinazione lecita', async () => {
        // Il ramo di degrado onorava `next` quando era interno a un'area. Con `/api/me` rotta
        // non si sa NIENTE del ruolo di questa persona: mandarla su `/teacher/registro` è una
        // scommessa che la guardia d'area perde per lei, in silenzio.
        h.meStato = 500
        mockSearch = new URLSearchParams('next=/teacher/registro')
        renderLogin()
        submitCredenziali()

        expect(await messaggioMostrato()).toBe(catalogoIt.erroreDopoAccesso)
        expect(mockRouter.replace).not.toHaveBeenCalled()
    })

    it('?scegli=1 con /api/me rotta: non si torna al form MUTO', async () => {
        // È il secondo giro del difetto, e il peggiore: qui la persona ci è arrivata PERCHÉ la
        // guardia d'area l'ha rimandata indietro. Trovare il form credenziali senza una parola
        // significa rimettersi a digitare una password che era giusta.
        mockSearch = new URLSearchParams('scegli=1')
        h.meStato = 503
        renderLogin()

        expect(await messaggioMostrato()).toBe(catalogoIt.erroreDopoAccesso)
        expect(screen.queryByText(catalogoIt.caricamentoProfili)).not.toBeInTheDocument()
        expect(screen.getByLabelText('Email')).toBeInTheDocument()
        expect(mockRouter.replace).not.toHaveBeenCalled()

        const eventi = eventiLoggati()
        expect(eventi).toHaveLength(1)
        expect(eventi[0]).toMatchObject({ livello: 'warn', stato: 503 })
        expect(String(eventi[0].messaggio)).toContain('fase=dopo-accesso')
    })

    it('?scegli=1: /api/me si chiama UNA volta sola (l’effetto non si rilancia a ogni render)', async () => {
        /*
         * IL PREZZO NASCOSTO DELLA REGOLA CONDIVISA. Portare il trattamento del guasto in una
         * funzione del componente la mette fra le dipendenze dell'effetto `?scegli=1`, e una
         * funzione ricreata a ogni render lì dentro significa: fetch → setState → render →
         * nuova identità → effetto → fetch. Un ciclo che non si ferma, su una pagina che una
         * persona già autenticata sta guardando. È lo stesso motivo per cui `t` non entra in
         * quelle dipendenze (vedi `chiaveErrore`), ed è misurabile solo contando le chiamate.
         */
        mockSearch = new URLSearchParams('scegli=1')
        h.meStato = 500
        renderLogin()
        await messaggioMostrato()

        const aMe = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/me'))
        expect(aMe).toHaveLength(1)
    })

    it('degrado VERO: risposta arrivata e valida ma senza ruolo → si naviga, e in silenzio', async () => {
        // ⟵ IL CONTROLLO CHE IMPEDISCE AL FIX DI ESSERE «NON NAVIGARE MAI PIÙ». Una risposta
        // 200 col nostro JSON dentro, da cui semplicemente non si ricava un ruolo, resta il
        // degrado graceful di sempre: si va alla radice e le guardie server-side decidono.
        // Se questo test fosse verde anche col ramo rimosso, i due sopra non starebbero
        // misurando la DISTINZIONE ma solo «non si naviga».
        h.me = { id: 'u-1', role: null, profili: [] }
        renderLogin()
        submitCredenziali()

        await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'))
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(eventiLoggati()).toEqual([])
    })
})

/**
 * W8-bis — LO STESSO `false` DEL SERVER, TRE STRADE, UN TRATTAMENTO SOLO.
 *
 * `POST /api/auth/active-role` ha tre chiamanti, e il 2026-08-03 ognuno faceva una cosa diversa
 * col medesimo esito negativo:
 *  · `onSubmit` (profilo unico) lo IGNORAVA e navigava — «tanto la guardia ha il fallback ruolo
 *    unico», che però vale solo se il server riesce a leggere la sessione, cioè esattamente ciò
 *    che un 401 da quella route dice che NON riesce a fare;
 *  · il picker mostrava `erroreRuolo` ma non lasciava NESSUNA traccia (regola 6);
 *  · l'effetto `?scegli=1` non leggeva nemmeno il valore di ritorno.
 *
 * Il lock è che le tre righe qui sotto asseriscono le STESSE tre cose. Una regola valida per tre
 * strade scritta in tre posti è una regola che, alla prossima modifica, ne resta valida per una.
 *
 * ─── DUE COSE CHE QUESTO DESCRIBE PROMETTEVA E NON MISURAVA (verificatore, 2026-08-03) ───
 *
 *  · `segnalaGuastoDopoAccesso` dichiara QUATTRO cose e qui se ne asserivano tre: la
 *    navigazione, la traccia e la superficie da cui ritentare. Mai `aria-invalid`. Manomissione
 *    M-A — `setCredenzialiErrate(chiave === 'erroreRuolo')`, cioè dire a uno screen reader «hai
 *    sbagliato le credenziali» mentre il guasto è del server, su tutte e tre le strade — e la
 *    suite restava **81 verdi su 81**. L'asserzione c'è adesso, ed è divisa: sulle due strade che
 *    montano il form si guardano i campi, sul picker si guardano i bottoni. Un `if (campo)` che
 *    salta il controllo dove il campo non esiste sarebbe un'asserzione che non sa fallire.
 *
 *  · **LA FIXTURE CONFONDEVA DUE GRANDEZZE**: tutte e tre le strade usavano `403` e nessuna
 *    `401`, mentre il ragionamento scritto nel codice (`impostaRuoloAttivo`) e nel PRD
 *    argomentava sul solo **401**. Sono due guasti con due prognosi diverse — 401 = la sessione
 *    non si vede (transitorio), 403 = «Ruolo non disponibile per questo utente» (permanente in
 *    astratto; in pratica quasi sempre la lettura degradata di `getProfiliForAuthUid`) — e il
 *    test lucchettava come corretto proprio il caso che l'argomento non copriva. Adesso ogni
 *    strada è misurata su tutti e due gli stati, e la riga di log deve portare **lo stato vero**:
 *    un test che scrivesse `403` a mano resterebbe verde anche col 401 classificato come 403.
 */
describe('W8-bis — il `false` di /api/auth/active-role: tre strade, un trattamento', () => {
    /**
     * I due stati che la route sa produrre, tenuti DISTINTI nella fixture.
     * `active-role/route.ts`: 401 da `resolveIdentity` senza userId, 403 da `ammesso === false`.
     */
    const STATI = [
        { stato: 401, etichetta: '401 · la sessione non si vede da server' },
        { stato: 403, etichetta: '403 · il ruolo non risulta fra i propri' },
    ] as const

    /** Le due strade che, dopo il guasto, mostrano il FORM: lì `aria-invalid` esiste davvero. */
    const STRADE_CON_FORM = [
        {
            nome: 'form credenziali · profilo unico',
            arriva: async () => {
                renderLogin()
                submitCredenziali()
            },
        },
        {
            nome: 'effetto ?scegli=1 · auto-riparazione del profilo unico',
            arriva: async () => {
                mockSearch = new URLSearchParams('scegli=1')
                renderLogin()
            },
        },
    ] as const

    /** La terza strada resta sul PICKER: i campi non sono montati, i bottoni sì. */
    const STRADA_PICKER = {
        nome: 'picker dei ruoli · doppio profilo',
        arriva: async () => {
            h.me = { ...DOPPIO }
            renderLogin()
            submitCredenziali()
            fireEvent.click(await screen.findByRole('button', { name: 'Genitore' }))
        },
    }

    /** Ogni strada per ogni stato: 3 × 2. Il prodotto è il punto — vedi la nota qui sopra. */
    const CASI = [...STRADE_CON_FORM, STRADA_PICKER].flatMap((strada) =>
        STATI.map((s) => ({ nome: `${strada.nome} · ${s.etichetta}`, arriva: strada.arriva, stato: s.stato })),
    )
    const CASI_CON_FORM = STRADE_CON_FORM.flatMap((strada) =>
        STATI.map((s) => ({ nome: `${strada.nome} · ${s.etichetta}`, arriva: strada.arriva, stato: s.stato })),
    )

    it.each(CASI)('$nome: non naviga', async ({ arriva, stato }) => {
        h.ruoloStato = stato
        await arriva()

        expect(await messaggioMostrato()).toBe(catalogoIt.erroreRuolo)
        expect(mockRouter.replace).not.toHaveBeenCalled()
    })

    it.each(CASI)('$nome: lascia la traccia, con `fase=dopo-accesso` e lo stato VERO', async ({ arriva, stato }) => {
        h.ruoloStato = stato
        await arriva()
        await messaggioMostrato()

        const eventi = eventiLoggati()
        expect(eventi).toHaveLength(1)
        expect(eventi[0]).toMatchObject({
            livello: 'warn',
            evento: 'fetch',
            route: '/auth/login',
            // ⟵ `stato` viene dal caso, non è scritto a mano: è ciò che rende il 401 e il 403
            // due misure diverse invece che due nomi della stessa.
            stato,
        })
        expect(String(eventi[0].messaggio)).toContain('fase=dopo-accesso')
        expect(String(eventi[0].messaggio)).toContain('esito=erroreRuolo')
        expect(String(eventi[0].messaggio)).toContain('errore=RispostaNonOk')
    })

    it.each(CASI)('$nome: `kv_user_role` NON resta scritto con un ruolo che il server ha rifiutato', async ({ arriva, stato }) => {
        // Il client non deve credere di avere un ruolo per cui il cookie server non è mai stato
        // messo: `useSessionIdentity` legge questa chiave, e da quando un guasto del ruolo attivo
        // non naviga più, lo stato incoerente RESTA sulla pagina invece di essere risolto dalla
        // guardia d'area. La sonda del verificatore leggeva `educator` su tutte e tre le strade.
        h.ruoloStato = stato
        await arriva()
        await messaggioMostrato()

        expect(window.localStorage.getItem('kv_user_role')).toBeNull()
        // Controllo positivo: l'identità È stata scritta. Senza, questo test sarebbe verde anche
        // con un `localStorage` che nessuno ha mai toccato — cioè non misurerebbe niente.
        expect(window.localStorage.getItem('kv_user_id')).toBe('u-1')
    })

    it.each(CASI_CON_FORM)('$nome: resta il form, e i campi NON sono marcati non validi', async ({ arriva, stato }) => {
        // Vale soprattutto per `?scegli=1`, dove l'alternativa è «Caricamento dei profili…»
        // per sempre su una schermata che non ha nemmeno un bottone.
        h.ruoloStato = stato
        await arriva()
        await messaggioMostrato()

        expect(screen.queryByText(catalogoIt.caricamentoProfili)).not.toBeInTheDocument()
        // ⟵ IL PUNTO 2 DI `segnalaGuastoDopoAccesso` (manomissione M-A): un ruolo attivo che il
        // server rifiuta non rende non valido ciò che l'utente ha digitato, e a chi usa uno
        // screen reader `aria-invalid` è l'unica versione del messaggio che arriva.
        expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'false')
        expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'false')
        await waitFor(() => expect(bottoneAccedi()).toBeEnabled())
    })

    it.each(STATI)('picker dei ruoli · $etichetta: i bottoni dei ruoli tornano premibili', async ({ stato }) => {
        // La strada senza form: qui la «superficie da cui ritentare» sono i due bottoni. Chiedere
        // `aria-invalid` su campi che non sono montati sarebbe un ramo condizionale, cioè
        // un'asserzione che non sa fallire; si misura ciò che questa strada ha davvero.
        h.ruoloStato = stato
        await STRADA_PICKER.arriva()
        await messaggioMostrato()

        expect(screen.queryByText(catalogoIt.caricamentoProfili)).not.toBeInTheDocument()
        expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
        await waitFor(() => expect(screen.getByRole('button', { name: 'Genitore' })).toBeEnabled())
        expect(screen.getByRole('button', { name: 'Docente' })).toBeEnabled()
    })
})

/**
 * W8-ter — LA NAVIGAZIONE CHE LANCIA, cioè l'unico modo in cui i rami `catch` si raggiungono
 * davvero a sessione già scritta. Delle tre strade, il 2026-08-03:
 *
 *  · `onSubmit` aveva il suo `catch` **ed era coperto** (test «un guasto QUALUNQUE dopo
 *    l'autenticazione…»);
 *  · `scegliRuolo` aveva il suo `catch` e **nessun test lo raggiungeva**: la manomissione M-D
 *    (fase riportata a `credenziali`, `stato` buttato via) lasciava 81 verdi su 81;
 *  · l'effetto `?scegli=1` **non aveva nessun `catch`**: `void load()` e basta. Con profilo unico
 *    e una `router.replace` rifiutata si otteneva un `unhandledrejection` e la pagina restava su
 *    «Caricamento dei profili…» PER SEMPRE, a utente già autenticato — nessun messaggio, nessun
 *    log, nessun form, nemmeno un bottone. È il sintomo W8 esatto sulla terza strada, ed è la
 *    regola 6 di AGENTS.md nella sua forma più grave: il `catch` non c'era proprio.
 */
describe('W8-ter — `router.replace` che lancia: nessuna strada resta appesa', () => {
    /**
     * Il rifiuto della navigazione. Porta uno `status` **di proposito**, e non è una pretesa che
     * Next produca errori con `status`: serve a misurare che il `catch` legga
     * `statoErroreAccesso(err)` invece di scrivere `undefined` a mano — cioè a rendere rossa la
     * metà di M-D che buttava via lo stato. Con un `Error` nudo quel pezzo di manomissione
     * sarebbe indistinguibile dal codice corretto.
     */
    function navigazioneRifiutata() {
        return Object.assign(new Error('navigazione rifiutata'), { status: 503 })
    }

    it('?scegli=1 · profilo unico: senza `.catch` la pagina restava su «Caricamento…» per sempre', async () => {
        mockSearch = new URLSearchParams('scegli=1')
        // Profilo unico → auto-riparazione → `router.replace`, che qui viene rifiutata.
        mockRouter.replace.mockImplementationOnce(() => {
            throw navigazioneRifiutata()
        })

        renderLogin()

        expect(await messaggioMostrato()).toBe(catalogoIt.erroreDopoAccesso)
        // Le due cose che il difetto rendeva impossibili: l'attesa finisce…
        expect(screen.queryByText(catalogoIt.caricamentoProfili)).not.toBeInTheDocument()
        // …e si ritrova una superficie da cui ritentare, coi campi non accusati.
        expect(screen.getByLabelText('Email')).toBeInTheDocument()
        expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'false')
        expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'false')
        expect(bottoneAccedi()).toBeEnabled()

        const eventi = eventiLoggati()
        expect(eventi).toHaveLength(1)
        expect(eventi[0]).toMatchObject({ livello: 'warn', evento: 'fetch', route: '/auth/login', stato: 503 })
        expect(String(eventi[0].messaggio)).toContain('fase=dopo-accesso')
        expect(String(eventi[0].messaggio)).toContain('esito=erroreDopoAccesso')
        expect(String(eventi[0].messaggio)).toContain('errore=Error')
    })

    it('picker dei ruoli: il `catch` di `scegliRuolo` spiega, logga e riabilita i bottoni', async () => {
        h.me = { ...DOPPIO }
        // ⚠️ Il ruolo attivo va a BUON FINE: il guasto è la navigazione, ed è l'unico modo di
        // entrare in quel `catch`. Con `ruoloStato` valorizzato si finirebbe nel ramo `!messo.ok`,
        // che è già coperto sopra — cioè si misurerebbe di nuovo il percorso non-eccezionale.
        h.ruoloStato = null
        renderLogin()
        submitCredenziali()
        const genitore = await screen.findByRole('button', { name: 'Genitore' })

        mockRouter.replace.mockImplementationOnce(() => {
            throw navigazioneRifiutata()
        })
        fireEvent.click(genitore)

        expect(await messaggioMostrato()).toBe(catalogoIt.erroreDopoAccesso)

        const eventi = eventiLoggati()
        expect(eventi).toHaveLength(1)
        expect(eventi[0]).toMatchObject({ livello: 'warn', evento: 'fetch', route: '/auth/login', stato: 503 })
        expect(String(eventi[0].messaggio)).toContain('fase=dopo-accesso')
        expect(String(eventi[0].messaggio)).toContain('esito=erroreDopoAccesso')

        // Il bottone non resta bloccato «senza spiegare perché».
        await waitFor(() => expect(screen.getByRole('button', { name: 'Genitore' })).toBeEnabled())
        expect(screen.getByRole('button', { name: 'Docente' })).toBeEnabled()
    })

    it('?scegli=1 · smontata mentre l’effetto è in volo: nessuna riga di log per nessuno', async () => {
        /*
         * LA GUARDIA `cancelled` MISURATA, non promessa. Fino al 2026-08-03 nessun test smontava
         * la pagina con l'effetto in volo: la manomissione M-E, che scavalcava il `return`,
         * lasciava 81 verdi su 81. Se salta, un componente che non c'è più scrive nel proprio
         * stato e — cosa che si vede in produzione — lascia una riga in `app_log` per un guasto
         * che nessuno sta più guardando.
         */
        vi.useFakeTimers()
        mockSearch = new URLSearchParams('scegli=1')
        h.meMuta = true

        const { unmount } = renderLogin()
        // Controllo positivo: l'effetto è PARTITO davvero, quindi c'è qualcosa da annullare.
        // Senza, il test sarebbe verde anche se `?scegli=1` non facesse mai nessuna fetch.
        expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/me'))).toHaveLength(1)

        unmount()
        // Il tetto di tempo scatta a componente già smontato: la promise è ancora viva (le
        // promise non sanno niente di React), quindi il codice ci arriva davvero.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(OLTRE_IL_TETTO_MS)
        })

        expect(eventiLoggati()).toEqual([])
    })
})

/**
 * IL LOG — regola 5 di AGENTS.md: «gli eventi critici loggano anche il SUCCESSO», e un
 * intervento senza i propri log non è finito.
 *
 * Perché serve un test suo. Fino al 2026-08-03 `registraGuastoAccesso` non era coperta da
 * nessuna asserzione: azzerandone il corpo, tutti e 29 i test del file restavano verdi. Per il
 * TIMEOUT quella riga è **l'unica traccia che esista** — non produce nessuna risposta HTTP,
 * quindi né il patch di `fetch` né i log del server la vedranno mai. Un guasto invisibile in
 * un file che si chiama «errori del servizio» è il difetto che questo file esisteva per
 * impedire.
 */
describe('W8 — il guasto lascia una traccia, e la traccia non contiene dati personali', () => {
    it('timeout dell’accesso: una riga `warn`, con l’esito e senza stato HTTP', async () => {
        vi.useFakeTimers()
        h.signIn.mockReturnValueOnce(MAI() as never)

        renderLogin()
        submitCredenziali()
        await act(async () => {
            await vi.advanceTimersByTimeAsync(OLTRE_IL_TETTO_MS)
        })

        const eventi = eventiLoggati()
        expect(eventi).toHaveLength(1)
        expect(eventi[0]).toMatchObject({
            livello: 'warn',
            evento: 'fetch',
            route: '/auth/login',
            // Nessuna risposta HTTP è mai arrivata: uno stato inventato qui sarebbe peggio
            // che nessuno stato.
            stato: undefined,
        })
        expect(String(eventi[0].messaggio)).toContain('esito=timeoutAccesso')
        expect(String(eventi[0].messaggio)).toContain('fase=credenziali')
    })

    it('guasto del servizio: la riga porta lo stato HTTP e la classe dell’errore', async () => {
        h.signIn.mockResolvedValueOnce({ error: ERRORI.cinquecento })
        renderLogin()
        submitCredenziali()
        await messaggioMostrato()

        const eventi = eventiLoggati()
        expect(eventi).toHaveLength(1)
        expect(eventi[0]).toMatchObject({ livello: 'warn', evento: 'fetch', stato: 500 })
        expect(String(eventi[0].messaggio)).toContain('esito=servizioNonDisponibile')
        // `nomeErrore` (vera, non mockata): della classe passa il NOME, mai il messaggio.
        expect(String(eventi[0].messaggio)).toContain('errore=AuthRetryableFetchError')
    })

    it('il guasto DOPO l’autenticazione si distingue nel log da quello sulle credenziali', async () => {
        vi.useFakeTimers()
        h.meMuta = true

        renderLogin()
        submitCredenziali()
        await act(async () => {
            await vi.advanceTimersByTimeAsync(OLTRE_IL_TETTO_MS)
        })

        const eventi = eventiLoggati()
        expect(eventi).toHaveLength(1)
        // Senza questo campo, in tabella un guasto a sessione GIÀ SCRITTA e uno alle
        // credenziali avrebbero lo stesso aspetto — e sono due incidenti diversi.
        expect(String(eventi[0].messaggio)).toContain('fase=dopo-accesso')
        expect(String(eventi[0].messaggio)).toContain('esito=timeoutDopoAccesso')
    })

    /*
     * IL `fase=` DELL'EFFETTO `?scegli=1` NON ERA ASSERTITO DA NESSUNO — e la sua riga di log è
     * l'unica che esista per quel guasto.
     *
     * Cambiando `'dopo-accesso'` in `'credenziali'` dentro l'effetto, il 2026-08-03, i rossi
     * arrivavano SOLO dal messaggio mostrato: nessun test guardava il campo. In `app_log` un
     * timeout della GUARDIA D'AREA — cioè di una persona già autenticata, che sta solo
     * aspettando i propri profili — sarebbe finito nel conteggio dei guasti sulle CREDENZIALI,
     * che è la confusione esatta che il campo `fase` è stato introdotto per eliminare.
     *
     * Sono due percorsi distinti (il profilo e poi il ruolo attivo) e vanno guardati tutti e
     * due: `arrenditi()` stava in un posto solo proprio perché è facile che uno dei due, un
     * giorno, prenda una strada sua.
     */
    it.each([
        ['il profilo non arriva', () => { h.meMuta = true }],
        ['il ruolo attivo non arriva', () => { h.ruoloMuto = true }],
    ])('?scegli=1 · %s: la traccia dice `fase=dopo-accesso` (il LOG, non il messaggio)', async (_nome, prepara) => {
        vi.useFakeTimers()
        mockSearch = new URLSearchParams('scegli=1')
        prepara()

        renderLogin()
        await act(async () => {
            await vi.advanceTimersByTimeAsync(OLTRE_IL_TETTO_MS)
        })

        const eventi = eventiLoggati()
        expect(eventi).toHaveLength(1)
        expect(eventi[0]).toMatchObject({
            livello: 'warn',
            evento: 'fetch',
            route: '/auth/login',
            // Nessuna risposta HTTP è mai arrivata.
            stato: undefined,
        })
        expect(String(eventi[0].messaggio)).toContain('fase=dopo-accesso')
        expect(String(eventi[0].messaggio)).toContain('esito=timeoutDopoAccesso')
    })

    /**
     * ⚠️ QUESTO TEST DICEVA IL CONTRARIO, E IL PERCHÉ DEL RIBALTAMENTO È UNA MISURA.
     *
     * Fino al 2026-08-22 asseriva `expect(eventiLoggati()).toEqual([])`, con la
     * motivazione «sarebbe una riga per ogni refuso di ogni genitore». Il timore era
     * il rumore. Il rumore non è mai arrivato: in trenta giorni di `app_log` le righe
     * di accesso fallito sono **zero**, perché non ne veniva scritta nessuna.
     *
     * Quello che è arrivato è il caso opposto. Il 22/08 il cron ha spedito 67
     * credenziali; 37 famiglie sono entrate e 30 no. Alla domanda «quante hanno
     * provato e non ci sono riuscite, e con che tipo di password», il sistema non
     * sapeva rispondere: il fallimento più frequente che abbiamo era l'unico muto.
     * L'assenza di rumore è costata la diagnosi.
     *
     * Ciò che NON cambia è il messaggio a schermo: resta `credenzialiNonValide`,
     * indistinto fra email inesistente e password sbagliata. Il vincolo di
     * `errore-accesso.ts` riguarda ciò che si MOSTRA a un anonimo; questa riga è
     * roba nostra, non esce dal dispositivo con niente che identifichi una persona,
     * e i test 7 e 8 continuano a sorvegliare l'indistinguibilità.
     */
    it('una password sbagliata lascia UNA riga warn con la causa, e niente dell\'utente', async () => {
        h.signIn.mockResolvedValueOnce({ error: ERRORI.credenziali })
        renderLogin()
        submitCredenziali()
        expect(await messaggioMostrato()).toBe(catalogoIt.credenzialiNonValide)

        const eventi = eventiLoggati()
        expect(eventi).toHaveLength(1)
        expect(eventi[0]).toMatchObject({
            livello: 'warn',
            evento: 'accesso',
            route: '/auth/login',
            /**
             * `stato: undefined` NON è una dimenticanza: è la condizione perché la
             * riga esista. `livelloEvento` in `logging/client.ts` applica
             * `livelloFetch` a qualunque evento che porti uno `stato` fra 400 e 599,
             * e 400 non è fra le `ANOMALIE_4XX`: passare lo status di GoTrue farebbe
             * scartare l'evento in silenzio, questo test resterebbe verde perché
             * spia `logClient` a monte, e in produzione non arriverebbe niente.
             * Lo status vive dentro il messaggio, dove nessuno lo filtra.
             */
            stato: undefined,
        })
        const messaggio = String(eventi[0].messaggio)
        expect(messaggio).toContain('esito=credenzialiNonValide')
        expect(messaggio).toContain('http=400')
        // Le tre discriminanti stanno nel MESSAGGIO e non nel contesto, perché
        // l'impronta di deduplicazione di `app_log` comprende il messaggio e non il
        // contesto: una combinazione diversa deve essere una riga diversa, con il
        // proprio conteggio, invece di essere assorbita da quella del mattino.
        expect(messaggio).toMatch(/pwd=(temporanea|temporanea-legacy|altra)/)
        expect(messaggio).toMatch(/spazi=(nessuno|email|password|entrambi)/)
    })

    it.each([
        ['timeout', () => { h.signIn.mockReturnValueOnce(MAI() as never) }],
        ['500', () => { h.signIn.mockResolvedValueOnce({ error: ERRORI.cinquecento }) }],
        ['dopo l’accesso', () => { h.meMuta = true }],
        // Il caso nuovo, ed è quello che conta di più: è l'unico in cui la persona
        // ha appena DIGITATO la sua password: se una riga di log dovesse portarsela
        // via, sarebbe da qui.
        ['password sbagliata', () => { h.signIn.mockResolvedValue({ error: ERRORI.credenziali }) }],
    ])('né l’email né la password finiscono nel log (%s)', async (_nome, prepara) => {
        vi.useFakeTimers()
        prepara()

        renderLogin()
        submitCredenziali()
        await act(async () => {
            await vi.advanceTimersByTimeAsync(OLTRE_IL_TETTO_MS)
        })

        const spedito = JSON.stringify(eventiLoggati())
        expect(eventiLoggati().length).toBeGreaterThan(0) // se non si logga nulla non si sta misurando niente
        expect(spedito).not.toContain(EMAIL)
        expect(spedito).not.toContain(PASSWORD)
        // E nemmeno la parte locale dell'indirizzo, che da sola identifica la persona.
        expect(spedito).not.toContain(EMAIL.split('@')[0])
    })
})

describe('T16-F3/F4 — i testi passano dai cataloghi, in tutte e due le lingue', () => {
    // L'app è bilingue (next-intl, cookie KV_LOCALE): un messaggio scritto a mano nel
    // componente sarebbe italiano anche per chi ha l'interfaccia in inglese — ed è il
    // difetto T10-F2, che non si ripete qui.
    const CHIAVI = [
        'credenzialiNonValide',
        'erroreConnessione',
        'servizioNonDisponibile',
        'troppiTentativi',
        'timeoutAccesso',
        'erroreImprevisto',
    ] as const

    it.each(CHIAVI)('«%s» esiste e non è vuota in italiano e in inglese', (chiave) => {
        for (const [lingua, catalogo] of [
            ['it', catalogoIt],
            ['en', catalogoEn],
        ] as const) {
            const testo = (catalogo as Record<string, string | undefined>)[chiave]
            expect(typeof testo, `messages/${lingua}/auth.json manca "${chiave}"`).toBe('string')
            expect((testo ?? '').trim().length, `messages/${lingua}/auth.json → "${chiave}" è vuota`).toBeGreaterThan(0)
        }
    })

    it('i sei messaggi sono DIVERSI fra loro: un testo unico sarebbe il difetto travestito', () => {
        for (const catalogo of [catalogoIt, catalogoEn]) {
            const testi = CHIAVI.map((k) => (catalogo as Record<string, string>)[k])
            expect(new Set(testi).size).toBe(CHIAVI.length)
        }
    })
})
