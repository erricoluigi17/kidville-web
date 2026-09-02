import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'

import { CASI_PASSWORD } from '../helpers/casi-password'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import { LUNGHEZZA_MINIMA_PASSWORD, forzaPassword } from '@/lib/auth/regole-password'
import { classificaFormaPassword } from '@/lib/auth/forma-password'
import itShared from '../../messages/it/shared.json'
import itPassword from '../../messages/it/password.json'
import enPassword from '../../messages/en/password.json'

/**
 * IL FORM DEL CAMBIO PASSWORD — quello che decide se funziona davvero su un telefono.
 *
 * ─── PERCHÉ QUESTE E NON ALTRE ASSERZIONI ───────────────────────────────────
 *
 * La route `POST /api/account/password` è verde da prima di questa schermata: qui
 * non si ricollauda il server. Si misura ciò che vive SOLO nel browser, e che nel
 * repo è già costato una volta a testa:
 *
 *  1. **Incollare conserva la stringa.** Chi arriva dall'email incolla
 *     `Xxxx-xxxx-xxxx-xxxx` nel campo «attuale». Un `trim()` d'ufficio — o un campo
 *     spezzato in gruppi — chiuderebbe fuori chi una password con lo spazio ce l'ha
 *     davvero dentro l'hash: è la ragione per cui `auth/login/page.tsx` porta un
 *     intero SECONDO tentativo d'accesso (difetto del 2026-08-22).
 *  2. **Il bottone in invio non è `disabled`.** `ui/Btn.tsx` lo scrive per esteso:
 *     `disabled` fa sfogare il fuoco a Chrome (torna su `<body>`) e sbiadisce
 *     l'unico segnale che il gesto sia partito. Si usa `aria-disabled` più una
 *     guardia nel gestore.
 *  3. **Il successo dice che le sessioni sono terminate.** Misurato sul sorgente di
 *     GoTrue: `updateUserById` con `sessionID == nil` esegue `DELETE FROM sessions
 *     WHERE user_id = ?`, cioè revoca ANCHE la sessione di chi sta cambiando. Una
 *     schermata che dicesse «fatto» e restasse dov'è mostrerebbe una raffica di 401
 *     proprio a chi ha appena fatto la cosa giusta. E si LEGGE `sessioniTerminate`
 *     dalla risposta: darlo per scontato sarebbe una promessa del client su un
 *     comportamento del server.
 *  4. **Il testo dell'errore viene dal CATALOGO**, mai dalla prosa del server
 *     (rilievo T10-F1: prosa italiana dentro un'interfaccia inglese).
 */

const spie = vi.hoisted(() => ({ logout: vi.fn(async () => {}), logClient: vi.fn() }))

vi.mock('next/navigation', () => ({
    usePathname: () => '/parent/profilo',
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/lib/auth/logout', () => ({ doLogout: () => spie.logout() }))

vi.mock('@/lib/logging/client', async (originale) => {
    const vero = await originale<typeof import('@/lib/logging/client')>()
    return { ...vero, logClient: (e: unknown) => spie.logClient(e) }
})

import { CambiaPasswordCard } from '@/components/features/account/CambiaPasswordCard'

const P = itPassword as Record<string, string>
const EN_P = enPassword as Record<string, string>
const SHARED = itShared as Record<string, string>

/** Le quattro parole della barra, indicizzate come `forzaPassword` (0 non si mostra). */
const PAROLA = ['', P.forzaDebole, P.forzaDiscreta, P.forzaBuona, P.forzaOttima]

/** Una password temporanea nel formato in vigore (`Xxxx-xxxx-xxxx-xxxx`). */
const TEMPORANEA = 'Adcf-hjk2-3n4p-5rt6'
/** Una password nuova che passa tutte e quattro le regole. */
const SCELTA = 'nonnarosa42'

const rispostaOk = (sessioniTerminate: boolean) => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, sessioniTerminate }),
})
const rispostaErrore = (status: number, corpo: unknown) => ({
    ok: false,
    status,
    json: async () => corpo,
})

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
    vi.clearAllMocks()
    fetchMock = vi.fn(async () => rispostaOk(true))
    vi.stubGlobal('fetch', fetchMock)
    document.documentElement.setAttribute('lang', 'it')
})

afterEach(() => {
    cleanup()
    document.documentElement.removeAttribute('lang')
})

/** I campi si cercano per la loro ETICHETTA: è il modo in cui li trova uno screen reader. */
const campoAttuale = () => screen.getByLabelText(P.labelAttuale) as HTMLInputElement
const campoNuova = () => screen.getByLabelText(P.labelNuova) as HTMLInputElement
const campoConferma = () => screen.getByLabelText(P.labelConferma) as HTMLInputElement
/** Il comando: si cerca per TIPO, perché il suo nome cambia mentre invia («Salvataggio…»). */
const bottoneSalva = () => document.querySelector('button[type="submit"]') as HTMLButtonElement

function compila(attuale: string, nuova: string, conferma = nuova) {
    fireEvent.change(campoAttuale(), { target: { value: attuale } })
    fireEvent.change(campoNuova(), { target: { value: nuova } })
    fireEvent.change(campoConferma(), { target: { value: conferma } })
    fireEvent.blur(campoConferma())
    fireEvent.click(bottoneSalva())
}

const corpoInviato = () => JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))

describe('CambiaPasswordCard — i tre campi, come li usa chi ha un telefono in mano', () => {
    it('tre campi in ordine, ognuno con la propria etichetta VISIBILE e il proprio autocomplete', () => {
        render(<CambiaPasswordCard origine="self-service" />)

        for (const { campo, etichetta, autocomplete } of [
            { campo: campoAttuale(), etichetta: P.labelAttuale, autocomplete: 'current-password' },
            { campo: campoNuova(), etichetta: P.labelNuova, autocomplete: 'new-password' },
            { campo: campoConferma(), etichetta: P.labelConferma, autocomplete: 'new-password' },
        ]) {
            expect(campo).toHaveAttribute('autocomplete', autocomplete)
            // Il segnaposto non è un'etichetta: sparisce al primo carattere digitato.
            const label = document.querySelector(`label[for="${campo.id}"]`)
            expect(label, `${etichetta}: manca la <label> collegata`).toBeTruthy()
            expect(label?.textContent).toContain(etichetta)
            expect(label?.className ?? '', `${etichetta}: etichetta nascosta`).not.toContain('sr-only')
            // Senza questi, iOS maiuscola la prima lettera e corregge ciò che si digita.
            expect(campo).toHaveAttribute('autocapitalize', 'none')
            expect(campo).toHaveAttribute('autocorrect', 'off')
            expect(campo).toHaveAttribute('spellcheck', 'false')
            expect(campo).toHaveAttribute('inputmode', 'text')
        }

        // L'ORDINE conta: prima quella che si ha, poi quella che si sceglie.
        const ordine = Array.from(document.querySelectorAll('input')).map((i) => i.id)
        expect(ordine.indexOf(campoAttuale().id)).toBeLessThan(ordine.indexOf(campoNuova().id))
        expect(ordine.indexOf(campoNuova().id)).toBeLessThan(ordine.indexOf(campoConferma().id))
    })

    it('incollare la password temporanea la conserva CARATTERE PER CARATTERE', async () => {
        render(<CambiaPasswordCard origine="primo-accesso" />)
        const incolla = new Event('paste', { bubbles: true, cancelable: true })
        fireEvent.change(campoAttuale(), { target: { value: TEMPORANEA } })
        act(() => { campoAttuale().dispatchEvent(incolla) })
        expect(incolla.defaultPrevented, 'il campo blocca l’incollaggio').toBe(false)
        expect(campoAttuale().value).toBe(TEMPORANEA)
        expect(classificaFormaPassword(campoAttuale().value)).toBe('temporanea')

        fireEvent.change(campoNuova(), { target: { value: SCELTA } })
        fireEvent.change(campoConferma(), { target: { value: SCELTA } })
        fireEvent.click(bottoneSalva())
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        expect(corpoInviato().attuale).toBe(TEMPORANEA)
    })

    it('la password ATTUALE non si ripulisce: uno spazio ai bordi può essere vero', async () => {
        render(<CambiaPasswordCard origine="self-service" />)
        compila(' vecchia1 ', SCELTA)
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        // Se qui arrivasse «vecchia1» il server rifiuterebbe una password giusta, e il
        // messaggio manderebbe a correggere proprio il campo che era esatto.
        expect(corpoInviato().attuale).toBe(' vecchia1 ')
    })

    it('la password NUOVA con spazi ai bordi si rifiuta QUI: prevenire batte curare', async () => {
        render(<CambiaPasswordCard origine="self-service" />)
        compila('vecchia1', ' nonnarosa42')
        const atteso = SHARED[CODICI_ERRORE.PASSWORD_CON_SPAZI_AI_BORDI]
        await waitFor(() => expect(screen.getByText(atteso)).toBeInTheDocument())
        expect(fetchMock, 'la richiesta è partita su una password che il server rifiuterà').not.toHaveBeenCalled()
    })

    it('la porta da cui si passa viaggia nel corpo: senza, «primo-accesso» resta a zero e non si sa', async () => {
        render(<CambiaPasswordCard origine="primo-accesso" />)
        compila(TEMPORANEA, SCELTA)
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        expect(corpoInviato().origine).toBe('primo-accesso')
        expect(fetchMock.mock.calls[0][0]).toBe('/api/account/password')
    })
})

describe('CambiaPasswordCard — il giudizio del client è quello del server', () => {
    for (const caso of CASI_PASSWORD) {
        if (caso.scritta === '') continue
        it(`«${caso.scritta}» → ${caso.atteso} (${caso.perche})`, async () => {
            render(<CambiaPasswordCard origine="self-service" />)
            compila('vecchia1', caso.scritta)
            if (caso.atteso === 'OK') {
                await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
                expect(corpoInviato().nuova).toBe(caso.scritta)
                return
            }
            const atteso = SHARED[CODICI_ERRORE[caso.atteso]]
            expect(atteso, `manca la voce di catalogo per ${caso.atteso}`).toBeTruthy()
            await waitFor(() => expect(screen.getByText(atteso)).toBeInTheDocument())
            expect(fetchMock).not.toHaveBeenCalled()
        })
    }

    it('la nuova uguale all’attuale si ferma qui, con la frase del suo codice', async () => {
        render(<CambiaPasswordCard origine="self-service" />)
        compila('nonnarosa42', 'nonnarosa42')
        const atteso = SHARED[CODICI_ERRORE.PASSWORD_UGUALE_ALLA_PRECEDENTE]
        await waitFor(() => expect(screen.getByText(atteso)).toBeInTheDocument())
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('la ripetizione si giudica in `onBlur`, non a ogni carattere', async () => {
        render(<CambiaPasswordCard origine="self-service" />)
        fireEvent.change(campoNuova(), { target: { value: SCELTA } })
        fireEvent.change(campoConferma(), { target: { value: 'non' } })
        expect(screen.queryByText(P.erroreConfermaDiversa)).not.toBeInTheDocument()
        fireEvent.blur(campoConferma())
        await waitFor(() => expect(screen.getByText(P.erroreConfermaDiversa)).toBeInTheDocument())
    })

    it('il fuoco va al PRIMO campo in errore: chi usa la tastiera non deve cercarlo', async () => {
        render(<CambiaPasswordCard origine="self-service" />)
        compila('vecchia1', 'corta1')
        await waitFor(() => expect(document.activeElement).toBe(campoNuova()))
        expect(campoNuova()).toHaveAttribute('aria-invalid', 'true')
        expect(campoAttuale()).toHaveAttribute('aria-invalid', 'false')
        // Il messaggio è raggiungibile DAL CAMPO: senza, a uno screen reader non arriva.
        const descritto = (campoNuova().getAttribute('aria-describedby') ?? '').split(/\s+/)
        const raggiungibile = descritto.some((id) =>
            document.getElementById(id)?.textContent?.includes(SHARED[CODICI_ERRORE.PASSWORD_TROPPO_CORTA]),
        )
        expect(raggiungibile, 'il messaggio non è collegato al campo').toBe(true)
    })
})

describe('CambiaPasswordCard — forza e criteri: informazione, non colore', () => {
    it('quattro tacche LARGHE QUANTO IL CAMPO, e un’etichetta TESTUALE accanto', () => {
        const { container } = render(<CambiaPasswordCard origine="self-service" />)
        fireEvent.change(campoNuova(), { target: { value: SCELTA } })

        const tacche = Array.from(container.querySelectorAll('[data-tacca]'))
        expect(tacche.length, 'la barra di forza non è fatta di quattro tacche').toBe(4)
        for (const t of tacche) {
            // Una barra continua «mente sui pixel»: la larghezza non si CALCOLA…
            expect(t.getAttribute('style'), 'una tacca ha una larghezza calcolata').toBeNull()
            expect(t).toHaveAttribute('aria-hidden', 'true')
            // …ma nemmeno si FISSA. ⚠️ Con `w-9` le quattro tacche misuravano
            // 4×36 + 3×6 di spazio = 162px dentro un campo da 400: finivano 238px
            // prima del bordo destro, e i due critici l'hanno letta come «rendering
            // rotto», non come una misura. Le tacche si dividono la riga.
            expect(t.className, 'una tacca ha ancora una larghezza fissa').not.toMatch(/\bw-\d/)
            expect(t.className, 'una tacca non si divide la riga').toMatch(/\bflex-1\b/)
        }
        const riga = container.querySelector('[data-tacche]') as HTMLElement
        expect(riga.className, 'la riga delle tacche non è larga quanto il campo').toMatch(/\bw-full\b/)

        // WCAG 1.4.1: il colore da solo non è informazione.
        const etichetta = container.querySelector('[data-forza-etichetta]')
        expect(etichetta?.textContent).toContain(PAROLA[forzaPassword(SCELTA)])
        expect(container.querySelector('[data-tacche][aria-live]')).toBeNull()
        expect(container.querySelector('[data-tacche] [aria-live]')).toBeNull()
    })

    it('la PAROLA «Robustezza» c’è anche a campo vuoto: quattro pillole nude sembrano uno scheletro di caricamento', () => {
        // ⚠️ IL DIFETTO CHE QUESTA ASSERZIONE CHIUDE. L'etichetta c'era, ma era
        // vuota finché il campo era vuoto — cioè assente proprio nell'istante in cui
        // la barra si vede per la prima volta. Quattro pillole uguali e senza una
        // parola accanto non insegnano che il linguaggio è «si riempiono»: la
        // lettura più probabile è decorazione, o peggio «sta ancora caricando».
        const { container } = render(<CambiaPasswordCard origine="self-service" />)
        expect(P.forzaTitolo, 'manca la parola che intitola la barra').toBeTruthy()
        expect(P.forzaNonValutata, 'manca il valore da mostrare a campo vuoto').toBeTruthy()
        expect(screen.getByText(P.forzaTitolo)).toBeVisible()

        const valore = container.querySelector('[data-forza-etichetta]') as HTMLElement
        expect(valore.textContent).toContain(P.forzaNonValutata)
        // VISIBILE, non solo annunciato: `sr-only` lo toglierebbe a chi guarda.
        expect(valore.className, 'il valore della robustezza è nascosto alla vista').not.toContain('sr-only')
        expect(valore.closest('.sr-only'), 'il valore vive dentro un blocco nascosto').toBeNull()
    })

    it('l’etichetta segue `forzaPassword`, e come lei non torna MAI indietro', () => {
        const { container } = render(<CambiaPasswordCard origine="self-service" />)
        const etichetta = () => container.querySelector('[data-forza-etichetta]')
        const testo = () => etichetta()?.textContent ?? ''

        // Campo vuoto: NESSUN GIUDIZIO. «Debole» su un campo che non è stato ancora
        // toccato sarebbe un giudizio su niente — ma il posto del giudizio si vede,
        // altrimenti la barra torna a somigliare a uno scheletro di caricamento.
        expect(testo()).toBe(P.forzaNonValutata)
        for (const parola of [P.forzaDebole, P.forzaDiscreta, P.forzaBuona, P.forzaOttima]) {
            expect(testo(), 'a campo vuoto la barra dà già un giudizio').not.toContain(parola)
        }

        // ⚠️ LA MONOTONIA È LA PROPRIETÀ, e si misura QUI perché è qui che si vede:
        // aggiungendo caratteri il livello non scende mai. Senza, la barra tornerebbe
        // indietro mentre qualcuno continua a digitare — un consiglio falso, dato nel
        // momento peggiore. (Il livello 0 porta comunque la parola più bassa: il campo
        // è stato scritto, e un giudizio c'è.)
        let precedente = -1
        for (const scritta of ['a', 'ab', 'abcdefgh', 'abcdefgh1234', 'Abcdefgh1234', 'Abcdefgh1234!!!!']) {
            fireEvent.change(campoNuova(), { target: { value: scritta } })
            const livello = forzaPassword(scritta)
            expect(livello, `«${scritta}»: la forza è tornata indietro`).toBeGreaterThanOrEqual(precedente)
            precedente = livello
            const attesa = PAROLA[Math.max(livello, 1)]
            expect(testo(), `«${scritta}» vale ${livello}`).toContain(attesa)
            expect(etichetta()).toHaveAttribute('data-forza-etichetta', String(livello))
        }
        // Le quattro parole sono dichiarate e diverse fra loro: se due coincidessero,
        // due gradini della barra racconterebbero la stessa cosa.
        expect(new Set([P.forzaDebole, P.forzaDiscreta, P.forzaBuona, P.forzaOttima]).size).toBe(4)
    })

    it('il campo «nuova» nomina TUTTI E TRE i requisiti, non solo il primo', () => {
        // Si leggono PRIMA di sbagliare, ed è tutto il punto della lista: con l'id
        // su una riga sola gli altri due esisterebbero solo per chi guarda.
        render(<CambiaPasswordCard origine="self-service" />)
        const descritto = (campoNuova().getAttribute('aria-describedby') ?? '').split(/\s+/)
        const testi = descritto.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
        for (const chiave of ['criterioLunghezza', 'criterioLetteraCifra', 'criterioDiversa'] as const) {
            // Il testo del criterio della lunghezza è un plurale ICU: si confronta la
            // sua coda, che è la parte che il catalogo rende invariata.
            const atteso = chiave === 'criterioLunghezza' ? String(LUNGHEZZA_MINIMA_PASSWORD) : P[chiave]
            expect(testi, `il campo non nomina ${chiave}`).toContain(atteso)
        }
    })

    it('i criteri sono una lista VIVA, con un solo annuncio riassuntivo', () => {
        const { container } = render(<CambiaPasswordCard origine="self-service" />)
        const criteri = () => Array.from(container.querySelectorAll('[data-criterio]'))
        expect(criteri().length, 'i criteri non sono tre').toBe(3)
        // A campo vuoto sono tutti spenti — e nessuno è rosso: non è un errore.
        expect(criteri().every((c) => c.getAttribute('data-criterio') === 'no')).toBe(true)
        expect(container.querySelector('[role="alert"]')).toBeNull()

        fireEvent.change(campoAttuale(), { target: { value: 'vecchia1' } })
        fireEvent.change(campoNuova(), { target: { value: SCELTA } })
        expect(criteri().every((c) => c.getAttribute('data-criterio') === 'sì')).toBe(true)

        // UN SOLO `aria-live` in tutto il blocco della regola, altrimenti lo screen
        // reader urla a ogni tasto — e con robustezza e requisiti fusi in un blocco
        // solo, due regioni vive annuncerebbero DUE volte lo stesso gesto.
        const vivi = container.querySelectorAll('[data-regole] [aria-live], [data-regole][aria-live]')
        expect(vivi.length, 'le regioni vive dentro il blocco della regola non sono una sola').toBe(1)
        // …e quell'unico annuncio dice ENTRAMBE le cose.
        expect(vivi[0].textContent).toContain(P.forzaTitolo)
        expect(vivi[0].textContent).toContain('3')
    })

    it('un requisito soddisfatto porta la SPUNTA, e uno non soddisfatto non somiglia a un radio', () => {
        // Due difetti in uno. (a) I cerchi vuoti da 14px hanno la forma esatta di un
        // radio non selezionato, su righe di SOLA LETTURA: chi li vede prova a
        // premerli. (b) Il passaggio a «soddisfatto» era un solo cambio di colore,
        // e il colore da solo non è informazione (WCAG 1.4.1).
        const { container } = render(<CambiaPasswordCard origine="self-service" />)
        const marcatore = (riga: Element) => riga.querySelector('svg') as SVGElement

        for (const riga of Array.from(container.querySelectorAll('[data-criterio="no"]'))) {
            const svg = marcatore(riga)
            expect(svg, 'un requisito non soddisfatto non ha marcatore').toBeTruthy()
            expect(
                svg.querySelectorAll('circle').length,
                'il marcatore «da fare» è ancora un cerchio vuoto: la forma di un radio',
            ).toBe(0)
        }

        fireEvent.change(campoAttuale(), { target: { value: 'vecchia1' } })
        fireEvent.change(campoNuova(), { target: { value: SCELTA } })
        for (const riga of Array.from(container.querySelectorAll('[data-criterio="sì"]'))) {
            const svg = marcatore(riga)
            // Spunta DENTRO il cerchio: il cerchio dice «casella», il segno dice «fatta».
            expect(svg.querySelectorAll('circle').length, 'la spunta non è dentro un cerchio').toBe(1)
            expect(svg.querySelectorAll('path').length, 'il cerchio è vuoto: manca la spunta').toBeGreaterThanOrEqual(1)
        }
    })

    it('il criterio della lunghezza porta il numero VERO, in entrambe le lingue', () => {
        for (const [dove, testo] of [['it', P.criterioLunghezza], ['en', EN_P.criterioLunghezza]] as const) {
            // La forma ICU tiene il numero fuori dal testo: si rende con `minimo`.
            expect(testo, `${dove}: il criterio non è un plurale ICU`).toMatch(/plural/)
            expect(testo, `${dove}: il criterio non nomina il minimo`).toMatch(/\{\s*minimo\s*,/)
        }
        const { container } = render(<CambiaPasswordCard origine="self-service" />)
        expect(container.textContent).toContain(String(LUNGHEZZA_MINIMA_PASSWORD))
    })
})

describe('CambiaPasswordCard — l’invio, e ciò che si legge dopo', () => {
    it('durante l’invio il comando NON è `disabled`: è `aria-disabled` più la guardia', async () => {
        let sblocca: (v: unknown) => void = () => {}
        fetchMock.mockImplementation(() => new Promise((r) => { sblocca = r }))
        render(<CambiaPasswordCard origine="self-service" />)
        compila('vecchia1', SCELTA)

        await waitFor(() => expect(bottoneSalva()).toHaveAttribute('aria-disabled', 'true'))
        // `disabled` farebbe sfogare il fuoco su <body>: vedi `ui/Btn.tsx`.
        expect(bottoneSalva().disabled).toBe(false)
        expect(bottoneSalva().textContent).toContain(P.salvataggio)

        // La guardia: un secondo clic non manda una seconda richiesta.
        fireEvent.click(bottoneSalva())
        expect(fetchMock).toHaveBeenCalledTimes(1)

        await act(async () => { sblocca(rispostaOk(true)) })
    })

    it('il successo dice che le sessioni sono terminate e porta all’accesso — perché lo dice la RISPOSTA', async () => {
        render(<CambiaPasswordCard origine="self-service" />)
        compila('vecchia1', SCELTA)
        const esito = await screen.findByRole('status')
        expect(esito.textContent).toContain(P.successoTitolo)
        expect(esito.textContent).toContain(P.successoSessioni)
        // Il comando per rientrare c'è, e passa dall'uscita vera (stato locale ripulito).
        fireEvent.click(screen.getByRole('button', { name: new RegExp(P.vaiAllAccesso, 'i') }))
        await waitFor(() => expect(spie.logout).toHaveBeenCalledTimes(1))
    })

    it('se la risposta NON dichiara le sessioni terminate, non lo si inventa', async () => {
        fetchMock.mockImplementation(async () => rispostaOk(false))
        render(<CambiaPasswordCard origine="self-service" />)
        compila('vecchia1', SCELTA)
        const esito = await screen.findByRole('status')
        expect(esito.textContent).toContain(P.successoTitolo)
        expect(esito.textContent).not.toContain(P.successoSessioni)
        expect(esito.textContent).toContain(P.successoSenzaSessioni)
    })

    it('l’errore del server si legge dal CATALOGO, mai dalla prosa del server', async () => {
        fetchMock.mockImplementation(async () =>
            rispostaErrore(400, { error: 'La password attuale non è corretta.', codice: 'PASSWORD_ATTUALE_ERRATA' }),
        )
        render(<CambiaPasswordCard origine="self-service" />)
        compila('sbagliata1', SCELTA)
        const avviso = await screen.findByRole('alert')
        expect(avviso.textContent).toContain(SHARED[CODICI_ERRORE.PASSWORD_ATTUALE_ERRATA])
        await waitFor(() => expect(document.activeElement).toBe(campoAttuale()))
    })

    it('un rifiuto SENZA codice non fa uscire la prosa italiana del server (T10-F1)', async () => {
        fetchMock.mockImplementation(async () => rispostaErrore(500, { error: 'relation "x" does not exist' }))
        render(<CambiaPasswordCard origine="self-service" />)
        compila('vecchia1', SCELTA)
        const avviso = await screen.findByRole('alert')
        expect(avviso.textContent).toContain(P.erroreGenerico)
        expect(avviso.textContent).not.toContain('relation')
    })

    it('il 429 ha la sua frase, e il comando RESTA premibile', async () => {
        fetchMock.mockImplementation(async () =>
            rispostaErrore(429, { error: 'Troppi tentativi.', codice: 'TROPPE_RICHIESTE' }),
        )
        render(<CambiaPasswordCard origine="self-service" />)
        compila('vecchia1', SCELTA)
        const avviso = await screen.findByRole('alert')
        expect(avviso.textContent).toContain(SHARED[CODICI_ERRORE.TROPPE_RICHIESTE])
        // Non si spegne un comando per un tetto temporaneo.
        expect(bottoneSalva().disabled).toBe(false)
        expect(bottoneSalva()).toHaveAttribute('aria-disabled', 'false')
        // ⚠️ E NESSUN CAMPO È «NON VALIDO». Un tetto di frequenza non dice niente su
        // ciò che l'utente ha digitato: `aria-invalid` qui direbbe a chi usa uno
        // screen reader «hai sbagliato la password» mentre il problema è nostro — ed
        // è l'unica versione del messaggio che quell'utente riceve. Stesso difetto
        // documentato su `credenzialiErrate` in `auth/login/page.tsx`.
        for (const campo of [campoAttuale(), campoNuova(), campoConferma()]) {
            expect(campo).toHaveAttribute('aria-invalid', 'false')
        }
    })

    it('un 401 dice di RIENTRARE, non di riprovare: riprovare non può riuscire', async () => {
        // Due casi concreti: la schermata `/auth/nuova-password` è pubblica e la apre
        // anche chi non ha una sessione; e chi torna INDIETRO dopo un cambio riuscito
        // ha una sessione che GoTrue ha appena cancellato. Il ripiego generico gli
        // direbbe «riprova fra poco: quella attuale resta valida» — cioè lo manderebbe
        // a ripremere un comando che non può riuscire.
        fetchMock.mockImplementation(async () => rispostaErrore(401, { error: 'Non autenticato' }))
        render(<CambiaPasswordCard origine="self-service" />)
        compila('vecchia1', SCELTA)
        const avviso = await screen.findByRole('alert')
        expect(avviso.textContent).toContain(P.erroreSessioneScaduta)
        expect(avviso.textContent).not.toContain(P.erroreGenerico)
        expect(avviso.textContent).not.toContain('Non autenticato')
        for (const campo of [campoAttuale(), campoNuova(), campoConferma()]) {
            expect(campo).toHaveAttribute('aria-invalid', 'false')
        }
    })

    it('nemmeno un 500 accusa un campo: il guasto è nostro, e lo dice', async () => {
        fetchMock.mockImplementation(async () =>
            rispostaErrore(500, { error: 'boom', codice: 'PASSWORD_NON_SCRITTA' }),
        )
        render(<CambiaPasswordCard origine="self-service" />)
        compila('vecchia1', SCELTA)
        const avviso = await screen.findByRole('alert')
        expect(avviso.textContent).toContain(SHARED[CODICI_ERRORE.PASSWORD_NON_SCRITTA])
        for (const campo of [campoAttuale(), campoNuova(), campoConferma()]) {
            expect(campo).toHaveAttribute('aria-invalid', 'false')
        }
    })

    it('un rifiuto del PROVIDER accusa la nuova: lì c’è davvero qualcosa da cambiare', async () => {
        fetchMock.mockImplementation(async () =>
            rispostaErrore(400, { error: 'x', codice: 'PASSWORD_RIFIUTATA' }),
        )
        render(<CambiaPasswordCard origine="self-service" />)
        compila('vecchia1', SCELTA)
        await screen.findByRole('alert')
        await waitFor(() => expect(document.activeElement).toBe(campoNuova()))
        expect(campoNuova()).toHaveAttribute('aria-invalid', 'true')
    })

    it('la rete caduta lascia una traccia: è l’unico guasto che il server non vede', async () => {
        fetchMock.mockImplementation(async () => { throw new TypeError('Failed to fetch') })
        render(<CambiaPasswordCard origine="self-service" />)
        compila('vecchia1', SCELTA)
        const avviso = await screen.findByRole('alert')
        expect(avviso.textContent).toContain(P.erroreRete)
        await waitFor(() => expect(spie.logClient).toHaveBeenCalled())
        const evento = spie.logClient.mock.calls.at(-1)?.[0] as { messaggio: string; livello: string; stato?: number }
        expect(evento.livello).toBe('warn')
        // ⚠️ `stato` DEVE restare indefinito: `livelloEvento` scarta in silenzio gli
        // eventi con uno stato 4xx fuori da ANOMALIE_4XX (vedi `logging/client.ts`).
        expect(evento.stato).toBeUndefined()
        // E nel messaggio non c'è nessuna password, né la sua lunghezza.
        expect(evento.messaggio).not.toContain(SCELTA)
        expect(evento.messaggio).not.toMatch(/\b11\b/)
    })
})

describe('CambiaPasswordCard — l’occhio, e il bersaglio che si tocca col pollice', () => {
    it('un comando mostra/nascondi per campo, con nome proprio e `aria-pressed`', () => {
        render(<CambiaPasswordCard origine="self-service" />)
        for (const [nome, campo] of [
            [P.mostraAttuale, campoAttuale],
            [P.mostraNuova, campoNuova],
            [P.mostraConferma, campoConferma],
        ] as const) {
            const occhio = screen.getByRole('button', { name: nome })
            expect(occhio).toHaveAttribute('type', 'button')
            expect(occhio).toHaveAttribute('aria-pressed', 'false')
            expect(campo()).toHaveAttribute('type', 'password')
            fireEvent.click(occhio)
            expect(occhio).toHaveAttribute('aria-pressed', 'true')
            expect(campo()).toHaveAttribute('type', 'text')
        }
    })

    it('il bersaglio dell’occhio è 44×44 anche se l’icona è di 20', () => {
        render(<CambiaPasswordCard origine="self-service" />)
        const occhio = screen.getByRole('button', { name: P.mostraNuova })
        // Le classi dicono il bersaglio: jsdom non calcola il layout, e una misura
        // finta sarebbe peggio di nessuna misura.
        expect(occhio.className).toMatch(/\bh-11\b/)
        expect(occhio.className).toMatch(/\bw-11\b/)
    })

    it('i bersagli di QUESTO form arrivano a 44px, campi compresi', () => {
        // ⚠️ IL CONTO, per esteso, perché «44» senza aritmetica è una parola.
        // Il campo NON dichiarava un'altezza: la ricavava da `py-2.5` (10+10),
        // dall'interlinea di `text-sm` (20) e da `border-2` (2+2) = **44 esatti**,
        // cioè il minimo di WCAG 2.5.8 con margine ZERO. Bastava che un carattere
        // non si caricasse per scendere sotto. Ora l'altezza è DICHIARATA.
        render(<CambiaPasswordCard origine="self-service" />)
        for (const campo of [campoAttuale(), campoNuova(), campoConferma()]) {
            expect(campo.className, 'il campo non dichiara la propria altezza').toMatch(/\bh-12\b/)
        }
        // `h-12` = 3rem = 48px, quattro px sopra la soglia.
        const salva = bottoneSalva()
        expect(salva.className, 'il comando non è il bottone alto (54px)').toMatch(/(?:^|\s)h-\[54px\](?:\s|$)/)
    })
})

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * I RILIEVI DEL CONFRONTO CIECO (2026-09-02) — due critici di design, separati,
 * misurando i pixel ognuno per conto proprio, sono arrivati agli stessi punti.
 * ═════════════════════════════════════════════════════════════════════════════
 */
describe('CambiaPasswordCard — la regola si legge PRIMA di sbagliare', () => {
    /** I passi di spaziatura di Tailwind, in px: `mt-1` = 4, `space-y-4` = 16. */
    const px = (classi: string, prefisso: string): number | null => {
        const m = new RegExp(`(?:^|\\s)${prefisso}-(\\d+(?:\\.\\d+)?)(?:\\s|$)`).exec(classi)
        return m ? Number(m[1]) * 4 : null
    }

    it('il blocco di robustezza e requisiti sta SOTTO «Nuova password» e SOPRA «Ripeti»', () => {
        // ⚠️ IL PERCORSO REALE CHE QUESTO ORDINE CHIUDE: si digita la nuova, la si
        // ripete, POI si legge «Almeno 10 caratteri» — e chi ne aveva scritta una di
        // otto torna su, la cambia, e adesso la ripetizione non combacia più. Due
        // campi da rifare che credeva finiti. I requisiti funzionavano come autopsia
        // dell'errore, non come guida.
        const { container } = render(<CambiaPasswordCard origine="self-service" />)
        const blocco = container.querySelector('[data-regole]') as HTMLElement
        expect(blocco, 'il blocco della regola non esiste: robustezza e requisiti sono ancora separati').toBeTruthy()

        const seguono = (a: Element, b: Element) =>
            Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

        expect(seguono(campoNuova(), blocco), 'il blocco non segue il campo «Nuova password»').toBe(true)
        expect(seguono(blocco, campoConferma()), 'il blocco sta ancora DOPO il campo «Ripeti»').toBe(true)
    })

    it('è UN blocco solo: la barra e i requisiti non vivono più in due posti', () => {
        // Una regola che vale per un campo sta in un posto solo, attaccata a quel
        // campo. Due riquadri separati sono due posti in cui la stessa cosa può
        // divergere — e uno dei due finiva in fondo alla schermata.
        const { container } = render(<CambiaPasswordCard origine="self-service" />)
        const blocco = container.querySelector('[data-regole]') as HTMLElement
        expect(blocco.querySelector('[data-tacche]'), 'la barra non è dentro il blocco').toBeTruthy()
        expect(blocco.querySelectorAll('[data-criterio]').length, 'i requisiti non sono dentro il blocco').toBe(3)
        expect(container.querySelectorAll('[data-regole]').length, 'i blocchi sono più di uno').toBe(1)
    })

    it('il blocco appartiene al campo che lo precede: il gap sopra è al più METÀ di quello sotto', () => {
        // ⚠️ MISURATO DAI CRITICI: la barra stava 15px sotto il campo «Nuova» e 18px
        // sopra l'etichetta «Ripeti la nuova password» — cioè esattamente sul
        // confine. E in lettura occidentale un elemento si lega a CIÒ CHE SEGUE:
        // apparteneva visivamente al campo sbagliato.
        const { container } = render(<CambiaPasswordCard origine="self-service" />)
        const blocco = container.querySelector('[data-regole]') as HTMLElement
        const form = container.querySelector('form') as HTMLElement

        const sopra = px(blocco.className, 'mt')
        const sotto = px(form.className, 'space-y')
        expect(sopra, 'il blocco non dichiara il proprio distacco dal campo').not.toBeNull()
        expect(sotto, 'il form non dichiara il passo fra i suoi blocchi').not.toBeNull()
        expect(
            (sopra as number) * 2,
            `il gap verso l’alto (${sopra}px) non è al più la metà di quello verso il blocco ` +
            `successivo (${sotto}px): il blocco si legge come appartenente al campo che segue`,
        ).toBeLessThanOrEqual(sotto as number)

        // …e il campo insieme alla sua etichetta sta a 4px: è la scala di prossimità
        // che il blocco deve rispettare per leggersi come parte dello stesso gruppo.
        const etichetta = document.querySelector(`label[for="${campoNuova().id}"]`) as HTMLElement
        expect(px(etichetta.className, 'mb')).toBe(sopra)
    })
})

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * IL VINCOLO VIAGGIA COL CAMPO — e perché NON si è spostato il pannello sopra.
 *
 * IL RILIEVO (2026-09-02, due critici indipendenti, stessa parola). Il pannello è
 * passato da «dopo tutti e tre i campi» a «subito sotto Nuova password»: un
 * miglioramento vero, che ha dimezzato i campi da rifare. Ma su un telefono, con la
 * tastiera aperta e il campo a fuoco, la metà inferiore dello schermo sparisce: il
 * genitore vede il campo e NON vede «Almeno 10 caratteri».
 *
 * LE DUE STRADE PROPOSTE, e la ragione della scelta:
 *
 *  (a) PORTARE IL PANNELLO SOPRA IL CAMPO. Scartata, e non per gusto:
 *      il pannello è VIVO. La riga «Robustezza: non ancora valutata» diventa
 *      «Robustezza: Ottima» mentre si digita, e quella riga è `flex-wrap`: cambia
 *      larghezza, e su un campo stretto cambia il NUMERO DI RIGHE. Sopra il campo,
 *      ogni variazione sposta in basso il campo che si sta compilando — cioè muove
 *      il cursore sotto il dito, con la tastiera aperta, mentre si digita una
 *      password che non si vede. È un difetto peggiore di quello che chiude.
 *      In più rimetterebbe il pannello nella posizione di prossimità ambigua appena
 *      chiusa: in lettura occidentale un blocco si lega a ciò che SEGUE, quindi
 *      sopra «Nuova password» apparterrebbe visivamente al campo precedente.
 *
 *  (b) IL VINCOLO ACCANTO AL CAMPO. Scelta. Una riga statica fra l'etichetta e il
 *      campo: non si muove MAI, costa una riga sola, e il vincolo resta visibile
 *      qualunque sia il taglio del viewport, perché sta sopra il campo a fuoco e non
 *      sotto. Il pannello resta dov'è e continua a fare l'unica cosa che sa fare:
 *      dire a che punto sei.
 *
 * LA DIVISIONE DEI COMPITI, che è il punto dell'intero blocco:
 *      la REGOLA sta PRIMA del campo (statica, sempre visibile)
 *      il RISCONTRO sta DOPO   (vivo, cambia a ogni tasto)
 *
 * ⚠️ E IL VINCOLO È `aria-hidden`. Non è una svista: il campo nomina già l'elenco
 * completo dei requisiti in `aria-describedby`, e quell'elenco dice «Almeno 10
 * caratteri» per esteso. Senza `aria-hidden`, chi usa uno screen reader sentirebbe
 * la stessa regola DUE volte a ogni fuoco. La riga è la versione VISIVA di
 * un'informazione che per chi ascolta è già arrivata — la stessa decisione, e lo
 * stesso motivo, delle quattro tacche della barra.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
describe('CambiaPasswordCard — la regola sta PRIMA del campo, il riscontro DOPO', () => {
    const vincolo = (c: HTMLElement) => c.querySelector('[data-vincolo]') as HTMLElement | null

    it('«Nuova password» porta il proprio vincolo fra l’etichetta e il campo', () => {
        const { container } = render(<CambiaPasswordCard origine="self-service" />)
        const v = vincolo(container)
        expect(v, 'il campo «Nuova password» non porta più il proprio vincolo').toBeTruthy()

        const seguono = (a: Element, b: Element) =>
            Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

        const etichetta = document.querySelector(`label[for="${campoNuova().id}"]`) as HTMLElement
        expect(seguono(etichetta, v as HTMLElement), 'il vincolo non segue l’etichetta').toBe(true)
        expect(seguono(v as HTMLElement, campoNuova()), 'il vincolo sta DOPO il campo, cioè dove il viewport lo taglia').toBe(true)
    })

    it('…e il riscontro vivo resta DOPO: la regola non si muove, il giudizio sì', () => {
        const { container } = render(<CambiaPasswordCard origine="self-service" />)
        const blocco = container.querySelector('[data-regole]') as HTMLElement
        const seguono = (a: Element, b: Element) =>
            Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
        // Se un giorno qualcuno spostasse il pannello sopra il campo, questa riga cade:
        // è la decisione (a) documentata in testata, e va ridiscussa, non subita.
        expect(seguono(campoNuova(), blocco), 'il pannello VIVO è finito sopra il campo che si sta compilando').toBe(true)
    })

    it('il vincolo porta il minimo VERO, e lo prende dalla regola invece di ricopiarlo', () => {
        const { container } = render(<CambiaPasswordCard origine="self-service" />)
        expect(vincolo(container)?.textContent).toContain(String(LUNGHEZZA_MINIMA_PASSWORD))
    })

    it('lo dice a chi guarda, non due volte a chi ascolta', () => {
        const { container } = render(<CambiaPasswordCard origine="self-service" />)
        const v = vincolo(container) as HTMLElement
        expect(v.getAttribute('aria-hidden'), 'il vincolo si fa annunciare, e l’elenco lo ripete').toBe('true')
        const descritto = (campoNuova().getAttribute('aria-describedby') ?? '').split(/\s+/)
        expect(descritto.filter(Boolean).length, 'il campo non descrive più niente').toBeGreaterThan(0)
        if (v.id) expect(descritto, 'il vincolo è ANCHE nella descrizione: doppione a ogni fuoco').not.toContain(v.id)
        // …e la prova che per chi ascolta l'informazione non è persa: sta nell'elenco.
        const testi = descritto.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
        expect(testi, 'l’elenco non nomina più la lunghezza minima').toContain(String(LUNGHEZZA_MINIMA_PASSWORD))
    })

    it('non cambia il NOME accessibile del campo, e non si attacca agli altri due', () => {
        const { container } = render(<CambiaPasswordCard origine="self-service" />)
        // Il vincolo sta FUORI dall'etichetta: dentro, diventerebbe parte del nome del
        // campo, e ogni elenco di controlli lo leggerebbe per esteso.
        const etichetta = document.querySelector(`label[for="${campoNuova().id}"]`) as HTMLElement
        expect(etichetta.textContent?.trim()).toBe(P.labelNuova)
        expect(screen.getByLabelText(P.labelNuova)).toBe(campoNuova())
        // Una regola che vale per un campo sta su QUEL campo: uno solo, non tre.
        expect(container.querySelectorAll('[data-vincolo]').length).toBe(1)
    })

    it('il vincolo esiste in entrambe le lingue, e l’inglese non è un copia-incolla', () => {
        for (const catalogo of [P, EN_P]) expect(catalogo.vincoloNuova?.trim()).toBeTruthy()
        expect(P.vincoloNuova, 'il vincolo non è un plurale ICU: a un minimo di 1 direbbe «1 caratteri»').toMatch(/plural/)
        expect(EN_P.vincoloNuova).toMatch(/plural/)
        expect(EN_P.vincoloNuova, 'l’inglese è l’italiano').not.toBe(P.vincoloNuova)
    })
})

describe('CambiaPasswordCard — il riposo non è più il trattamento più forte', () => {
    const classiCampo = () => campoNuova().className

    it('a riposo il bordo è di 1px: il doppio spessore resta al fuoco e all’errore', () => {
        // ⚠️ IL DIFETTO, misurato risolvendo la cascata di `globals.css` e non
        // guardando la sola utility: `border-kidville-line` su un `input` viene
        // RISCRITTO da una regola non-layered, e sotto un antenato `.bg-kidville-cream`
        // (le tre shell dell'app e questa pagina lo sono tutte) diventa `sub` #55615C,
        // cioè 6,46:1 sulla carta del campo. A `border-2` erano DUE pixel di quasi
        // nero su tutti e tre i campi insieme: sembravano tutti attivi, e per il fuoco
        // e per l'errore non restava niente sopra — l'anello verde (6,51:1) e il bordo
        // rosso (4,23:1) erano *meno* evidenti dello stato di riposo.
        render(<CambiaPasswordCard origine="self-service" />)
        expect(classiCampo(), 'il bordo a riposo è ancora di 2px').not.toMatch(/\bborder-2\b/)
        expect(classiCampo(), 'il campo non ha più un bordo').toMatch(/\bborder\b/)
        expect(classiCampo(), 'il bordo a riposo non passa più dalla cascata delle superfici').toMatch(/border-kidville-line/)
    })

    it('il FUOCO aggiunge inchiostro, non solo tinta', () => {
        render(<CambiaPasswordCard origine="self-service" />)
        expect(classiCampo(), 'il fuoco non cambia il colore del bordo').toMatch(/focus:border-kidville-green/)
        expect(classiCampo(), 'il fuoco non aggiunge l’anello: è solo un cambio di tinta').toMatch(/focus:ring-2/)
    })

    it('l’ERRORE è più spesso del riposo, e non è affidato al solo colore', async () => {
        render(<CambiaPasswordCard origine="self-service" />)
        compila('vecchia1', 'corta1')
        await waitFor(() => expect(campoNuova()).toHaveAttribute('aria-invalid', 'true'))

        expect(classiCampo(), 'il campo in errore non è più spesso del riposo').toMatch(/\bborder-2\b/)
        expect(classiCampo()).toMatch(/border-kidville-error/)
        // ⚠️ E il rosso NON deve passare dalla cascata che riscrive `line`: quella
        // regola dichiara di non toccare i bordi di STATO, e ci riesce solo se la
        // classe `border-kidville-line` in quel momento non c'è.
        expect(classiCampo(), 'in errore resta anche la classe che la cascata riscrive').not.toMatch(/border-kidville-line/)

        // WCAG 1.4.1: il colore da solo non è informazione. Il messaggio porta
        // un'icona oltre al testo.
        const avviso = screen.getByRole('alert')
        expect(avviso.querySelector('svg'), 'il messaggio d’errore non ha icona').toBeTruthy()
    })
})
