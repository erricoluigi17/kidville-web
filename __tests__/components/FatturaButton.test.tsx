/**
 * Il modale «Metti in coda la fattura» (fino al 2026-09-24 «Emetti fattura»): mostra ciò che
 * uscirà, e la correzione a mano è un atto deliberato.
 *
 * ─── IL DIFETTO CHE QUESTI TEST INCHIODANO ───────────────────────────────────
 * Fino al 2026-09-04 il modale nasceva con la casella della causale **già piena con la
 * descrizione del pagamento** (`useState(descrizione ?? '')`), e la spediva come
 * *correzione manuale della segreteria* — che per progetto batte qualunque modello
 * configurato. Chi premeva «Emetti» senza svuotare il campo, cioè chiunque, annullava
 * la configurazione di Contabilità → Causali senza saperlo. La fattura FPR 1948/26 è
 * uscita così, verso lo SDI, con «Retta 09/2026». Il segnaposto della casella
 * prometteva testualmente «Lascia vuoto per usare il template delle impostazioni»:
 * l'interfaccia descriveva il comportamento che si impediva da sola.
 *
 * Nessun test copriva questo percorso — non ne esisteva nessuno su `FatturaButton` —
 * ed è esattamente il buco da cui il difetto è passato.
 *
 * ⚠️ Questi test si verificano **rompendo il codice**: rimettere
 * `useState(descrizione ?? '')` e il primo caso deve diventare rosso. Un test mai
 * visto fallire non è un test.
 *
 * ─── DAL 2026-09-23 «EMETTI» METTE IN CODA ───────────────────────────────────
 * (nucleo della coda fatture, §4.) La POST non va più a `/api/pagamenti/fattura` ma a
 * `/api/pagamenti/fattura/coda`, con UNA voce e `urgente: true`: la causale viaggia
 * DENTRO la voce, con la stessa regola di prima (`null` = togli la correzione salvata).
 * I casi sulla causale restano identici nella sostanza e guardano la voce; quelli
 * nuovi misurano l'accodamento — urgente, una voce sola, la frase «Messa in coda», il
 * 503 della coda non ancora migrata.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import sharedIt from '../../messages/it/shared.json'

const logSpy = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', async (importOriginal) => {
    const vero = await importOriginal<typeof import('@/lib/logging/client')>()
    return { ...vero, logClient: logSpy }
})

vi.mock('next-intl', async () => {
    // Il catalogo è NIDIFICATO da quando porta la sezione `codaFatture` (nucleo
    // coda-fatture, §4): le chiavi piatte si leggono come prima, quelle puntate
    // (`codaFatture.singola.messaInCoda`) scendendo il percorso. Con il solo accesso
    // piatto la frase nuova tornerebbe il proprio nome, e l'asserzione su di lei
    // sarebbe verde su una stringa che nessuno legge.
    const catalogo = (await import('../../messages/it/adminContabilita.json')).default as unknown as Record<string, unknown>
    const foglia = (key: string): string | undefined => {
        if (typeof catalogo[key] === 'string') return catalogo[key] as string
        let corrente: unknown = catalogo
        for (const pezzo of key.split('.')) {
            if (!corrente || typeof corrente !== 'object') return undefined
            corrente = (corrente as Record<string, unknown>)[pezzo]
        }
        return typeof corrente === 'string' ? corrente : undefined
    }
    const useTranslations = () => {
        const t = (key: string) => foglia(key) ?? key
        return Object.assign(t, { rich: t, markup: t, raw: t, has: () => true })
    }
    return { useTranslations, useLocale: () => 'it', NextIntlClientProvider: ({ children }: { children: unknown }) => children }
})
/**
 * framer-motion finto che RENDE UN NODO VERO, non solo i figli.
 *
 * ⚠️ La prima stesura restituiva `props.children` e basta: così `onClick` del
 * `motion.div` — cioè lo `stopPropagation` che impedisce al modale di chiudersi
 * quando si clicca dentro — spariva, e ogni click sui pulsanti interni chiudeva il
 * modale. Il test falliva su un difetto del proprio mock, non del prodotto: il tipo
 * di rosso che si «aggiusta» rilassando l'asserzione, e da lì in poi non misura più
 * niente.
 */
vi.mock('framer-motion', async () => {
    const React = await import('react')
    const motion = new Proxy({}, {
        get: (_t, tag: string) => function Mock(props: Record<string, unknown>) {
            const { children, initial, animate, exit, transition, whileHover, whileTap, layout, variants, ...resto } = props as Record<string, unknown>
            void initial; void animate; void exit; void transition; void whileHover; void whileTap; void layout; void variants
            return React.createElement(tag, resto, children as React.ReactNode)
        },
    })
    return { motion, AnimatePresence: ({ children }: { children?: unknown }) => children }
})

import { FatturaButton } from '@/components/features/admin/pagamenti/FatturaButton'

const PAG = '85320395-0000-4000-8000-000000000001'
const UTENTE = 'bbbbbbbb-0000-4000-8000-000000000004'
const DAL_MODELLO =
    'Pagamento retta del mese di settembre 2026. Per il figlio minore Mario Rossi C. F. RSSMRA20A01Z999X'

/** Le chiamate spedite, per guardare il CORPO della POST — che è il punto. */
let chiamate: { url: string; init?: RequestInit }[] = []
let anteprima: { ok: boolean; body: unknown } = { ok: true, body: null }
/** La risposta della coda: di default una voce accodata adesso. `null` = la rete cade. */
let coda: { ok: boolean; status: number; body: unknown } | null = null

const CODA_OK = { ok: true, status: 200, body: { gruppo_id: 'gruppo-1', accodate: 1, gia_in_coda: [] } }

function montaFetch() {
    chiamate = []
    coda = CODA_OK
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url)
        chiamate.push({ url: u, init })
        if (u.includes('/anteprima')) {
            return {
                ok: anteprima.ok,
                json: async () => anteprima.body,
            } as unknown as Response
        }
        if (u.includes('/api/pagamenti/fattura/coda')) {
            if (coda === null) throw new TypeError('Failed to fetch')
            const r = coda
            return { ok: r.ok, status: r.status, json: async () => r.body } as unknown as Response
        }
        return { ok: true, json: async () => ({ success: true, data: { fattura_stato: 'in_attesa' } }) } as unknown as Response
    }) as unknown as typeof fetch
}

const posts = () => chiamate.filter((c) => c.init?.method === 'POST')

/** Il corpo INTERO della POST alla coda: `{ voci, urgente }`. */
function corpoCoda(): { voci: Record<string, unknown>[]; urgente?: unknown } {
    const post = posts().find((c) => c.url.includes('/api/pagamenti/fattura/coda'))
    return JSON.parse(String(post?.init?.body ?? '{"voci":[]}'))
}

/** La voce (una sola) che il pulsante accoda: è lì dentro che viaggia la causale. */
function corpoPost(): Record<string, unknown> {
    return corpoCoda().voci[0] ?? {}
}

async function apri() {
    fireEvent.click(screen.getByRole('button', { name: /invia fattura/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^metti in coda$/i })).toBeTruthy())
}

beforeEach(() => {
    montaFetch()
    logSpy.mockClear()
    document.documentElement.setAttribute('lang', 'it')
    anteprima = {
        ok: true,
        body: { success: true, data: { causale: DAL_MODELLO, origine: 'categoria', lunghezza: 99, limite: 200, eccede: false } },
    }
})
afterEach(cleanup)

describe('FatturaButton — la causale che si vede è quella che parte', () => {
    it('mostra la causale COMPOSTA DAL MODELLO, non la descrizione del pagamento', async () => {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()
        await waitFor(() => expect(screen.getByDisplayValue(DAL_MODELLO)).toBeTruthy())
        expect(screen.queryByDisplayValue('Retta 09/2026')).toBeNull()
    })

    it('la casella nasce in SOLA LETTURA: non si corregge per distrazione', async () => {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()
        const casella = await screen.findByDisplayValue(DAL_MODELLO)
        expect((casella as HTMLTextAreaElement).readOnly).toBe(true)
    })

    it('senza «Personalizza», la POST manda `causale: null` — che TOGLIE la correzione vecchia', async () => {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()
        await screen.findByDisplayValue(DAL_MODELLO)
        fireEvent.click(screen.getByRole('button', { name: /^metti in coda$/i }))
        await waitFor(() => expect(chiamate.some((c) => c.init?.method === 'POST')).toBe(true))

        const corpo = corpoPost()
        expect(corpo.pagamento_id).toBe(PAG)
        expect(corpo.causale).toBeNull()
    })

    it('con «Personalizza» e testo cambiato, la correzione parte davvero', async () => {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()
        await screen.findByDisplayValue(DAL_MODELLO)
        fireEvent.click(screen.getByRole('button', { name: /personalizza/i }))
        const casella = screen.getByDisplayValue(DAL_MODELLO) as HTMLTextAreaElement
        expect(casella.readOnly).toBe(false)
        fireEvent.change(casella, { target: { value: 'Saldo iscrizione — accordo del 12/09' } })
        fireEvent.click(screen.getByRole('button', { name: /^metti in coda$/i }))
        await waitFor(() => expect(chiamate.some((c) => c.init?.method === 'POST')).toBe(true))

        expect(corpoPost().causale).toBe('Saldo iscrizione — accordo del 12/09')
    })

    it('«Personalizza» premuto ma testo IDENTICO all’anteprima: nessuna correzione da scrivere', async () => {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()
        await screen.findByDisplayValue(DAL_MODELLO)
        fireEvent.click(screen.getByRole('button', { name: /personalizza/i }))
        fireEvent.click(screen.getByRole('button', { name: /^metti in coda$/i }))
        await waitFor(() => expect(chiamate.some((c) => c.init?.method === 'POST')).toBe(true))

        // Congelare la causale su un pagamento significa rendere invisibile ogni
        // modifica futura al modello: non si fa per un testo che non corregge niente.
        expect(corpoPost().causale).toBeNull()
    })

    it('se l’anteprima FALLISCE, «Metti in coda» resta bloccato e l’errore si vede', async () => {
        anteprima = { ok: false, body: { error: 'Impossibile leggere i modelli di causale della sede' } }
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        fireEvent.click(screen.getByRole('button', { name: /invia fattura/i }))

        const emetti = await screen.findByRole('button', { name: /^metti in coda$/i })
        await waitFor(() => expect((emetti as HTMLButtonElement).disabled).toBe(true))
        expect(screen.getByRole('alert').textContent).toBeTruthy()

        fireEvent.click(emetti)
        expect(chiamate.some((c) => c.init?.method === 'POST')).toBe(false)
    })

    it('dice DA DOVE viene la causale e quanto è lunga sul tracciato', async () => {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()
        await screen.findByDisplayValue(DAL_MODELLO)
        expect(screen.getByText(/99\s*\/\s*200/)).toBeTruthy()
    })

    it('avvisa quando la causale eccede i 200 caratteri del campo 2.1.1.11', async () => {
        anteprima = {
            ok: true,
            body: { success: true, data: { causale: 'X'.repeat(250), origine: 'categoria', lunghezza: 250, limite: 200, eccede: true } },
        }
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()
        // ⚠️ Per id e non con `getByRole('status')`: a modale aperto le live region sono
        // DUE — questa, e quella (vuota) che porterà «Messa in coda» accanto al trigger.
        const avviso = document.getElementById(`causale-avviso-${PAG}`)
        expect(avviso?.getAttribute('role')).toBe('status')
        await waitFor(() => expect(avviso?.textContent?.trim()).toBeTruthy())
    })
})

describe('FatturaButton — «Metti in coda» mette in CODA, in testa', () => {
    async function emettiEAspetta() {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()
        await screen.findByDisplayValue(DAL_MODELLO)
        fireEvent.click(screen.getByRole('button', { name: /^metti in coda$/i }))
        await waitFor(() => expect(posts().length).toBe(1))
    }

    it('UNA POST alla coda, con `urgente: true` e UNA voce sola — e nessuna alla route diretta', async () => {
        await emettiEAspetta()

        expect(posts()).toHaveLength(1)
        expect(posts()[0].url).toBe('/api/pagamenti/fattura/coda')
        expect(chiamate.some((c) => c.init?.method === 'POST' && c.url === '/api/pagamenti/fattura')).toBe(false)
        const corpo = corpoCoda()
        // ⚠️ `toBe(true)`, non «truthy»: è ciò che mette la voce DAVANTI al lotto. Senza,
        // chi preme per una fattura sola aspetterebbe in fila dietro cinquecento.
        expect(corpo.urgente).toBe(true)
        expect(corpo.voci).toHaveLength(1)
        expect(corpo.voci[0].pagamento_id).toBe(PAG)
        // Il pulsante non conferma nessuna proposta: non scrive sulla scheda del bambino.
        expect(corpo.voci[0].conferma_proposta).toBeUndefined()
    })

    it('a voce accodata il modale si chiude, e al posto del pulsante c’è «Messa in coda: parte entro pochi minuti.»', async () => {
        const onEmessa = vi.fn()
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} onEmessa={onEmessa} />)
        await apri()
        await screen.findByDisplayValue(DAL_MODELLO)
        // La live region nasce VUOTA ad apertura del modale…
        const live = screen.getByTestId('fattura-accodata')
        expect(live.getAttribute('role')).toBe('status')
        expect(live.textContent).toBe('')

        fireEvent.click(screen.getByRole('button', { name: /^metti in coda$/i }))
        await waitFor(() => expect(screen.getByTestId('fattura-accodata').textContent).toBe('Messa in coda: parte entro pochi minuti.'))
        // …ed è LO STESSO nodo quando la frase arriva: inserita col testo dentro,
        // NVDA e JAWS la tacerebbero.
        expect(screen.getByTestId('fattura-accodata')).toBe(live)
        expect(screen.queryByRole('button', { name: /^metti in coda$/i })).toBeNull()
        // Un secondo «Invia fattura» non accoderebbe niente: il comando non c'è più.
        expect(screen.queryByRole('button', { name: /invia fattura/i })).toBeNull()
        expect(onEmessa).toHaveBeenCalledTimes(1)
        // D12: il genitore riceve l'ESITO, e con `nuova` aggiorna la sola riga senza
        // rileggere tutto (lo stato è noto per costruzione: la RPC ha appena scritto `in_coda`).
        expect(onEmessa).toHaveBeenCalledWith({ accodata: 'nuova' })
    })

    it('se la coda l’aveva già, lo dice — non «messa in coda» — e lo dice anche al genitore', async () => {
        coda = { ok: true, status: 200, body: { gruppo_id: 'gruppo-1', accodate: 0, gia_in_coda: [PAG] } }
        const onEmessa = vi.fn()
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} onEmessa={onEmessa} />)
        await apri()
        await screen.findByDisplayValue(DAL_MODELLO)
        fireEvent.click(screen.getByRole('button', { name: /^metti in coda$/i }))
        await waitFor(() => expect(screen.getByTestId('fattura-accodata').textContent).toBe(
            'Era già in coda: lo stato si vede nella pagina Coda fatture.',
        ))
        // Con `gia` lo stato vero può essere `in_invio` o `errore`: il genitore rilegge.
        expect(onEmessa).toHaveBeenCalledTimes(1)
        expect(onEmessa).toHaveBeenCalledWith({ accodata: 'gia' })
    })

    it('503 della coda non ancora migrata: la frase tradotta nell’alert, il modale resta, niente «scartata»', async () => {
        coda = {
            ok: false,
            status: 503,
            body: { error: 'La coda delle fatture non è ancora disponibile.', codice: 'CODA_FATTURE_NON_DISPONIBILE' },
        }
        const onEmessa = vi.fn()
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} onEmessa={onEmessa} />)
        await apri()
        await screen.findByDisplayValue(DAL_MODELLO)
        fireEvent.click(screen.getByRole('button', { name: /^metti in coda$/i }))

        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(sharedIt.erroreCodaFattureNonDisponibile))
        // Si può ripremere: niente è entrato in coda.
        expect((screen.getByRole('button', { name: /^metti in coda$/i }) as HTMLButtonElement).disabled).toBe(false)
        expect(screen.getByTestId('fattura-accodata').textContent).toBe('')
        expect(onEmessa).not.toHaveBeenCalled()

        // ⚠️ Un accodamento rifiutato NON è un documento scartato dallo SDI: chiuso il
        // modale, il trigger resta «Invia fattura», non diventa «Riprova fattura».
        fireEvent.click(screen.getByRole('button', { name: /^annulla$/i }))
        expect(screen.getByRole('button', { name: /invia fattura/i })).toBeTruthy()
        expect(screen.queryByRole('button', { name: /riprova fattura/i })).toBeNull()
    })

    it('la rete cade: il rifiuto generico a schermo, il modale resta, e il guasto si LOGGA', async () => {
        coda = null
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()
        await screen.findByDisplayValue(DAL_MODELLO)
        fireEvent.click(screen.getByRole('button', { name: /^metti in coda$/i }))

        await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/La fattura non è entrata in coda/))
        expect(screen.getByTestId('fattura-accodata').textContent).toBe('')
        // Un `catch` che non logga è un bug (AGENTS.md, regola 6) — e solo il nome
        // dell'errore, mai un dato del pagamento.
        const righe = logSpy.mock.calls.map(([e]) => (e as { messaggio?: string }).messaggio ?? '')
        expect(righe.some((m) => m.startsWith('fattura-singola-accodamento-fallito'))).toBe(true)
        expect(righe.join(' ')).not.toContain('RSSMRA')
    })
})

/**
 * ─── D5: CON UNA VOCE ATTIVA IN CODA, «INVIA FATTURA» NON C'È ─────────────────
 * (consegna 2b, `consegna-2b-rifiniture.md` §4.10.) Un secondo «Invia fattura» su un
 * pagamento che la coda ha già non accoderebbe niente (tornerebbe «già in coda»): il
 * pulsante sparisce, e su «Errore in coda» al suo posto c'è il collegamento alla pagina
 * «Coda fatture», dove la voce si toglie o si rimette. La regola è del motore
 * (`azioneConCoda`, `@/lib/pagamenti/fatturazione-riga`); qui si guarda la resa.
 *
 * La resa è sincrona: al montaggio non parte nessuna fetch (l'anteprima si chiede
 * all'apertura del modale), quindi le assenze qui sotto non sono «dati non ancora
 * arrivati». Ogni assenza è verificata DOPO una presenza sullo stesso albero.
 */
describe('FatturaButton — con una voce ATTIVA in coda', () => {
    const invia = () => screen.queryByRole('button', { name: /invia fattura/i })
    const vaiAllaCoda = () => screen.queryByRole('link', { name: 'Vai alla coda fatture' })

    it('senza voce il pulsante c’è; con `in_coda` e con `in_invio` non ci sono né il pulsante né il collegamento', () => {
        const { rerender } = render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        expect(invia()).toBeTruthy()

        rerender(<FatturaButton pagamentoId={PAG} userId={UTENTE} codaStato="in_coda" />)
        expect(invia()).toBeNull()
        expect(screen.queryByRole('link')).toBeNull()

        rerender(<FatturaButton pagamentoId={PAG} userId={UTENTE} codaStato={null} />)
        expect(invia()).toBeTruthy()

        rerender(<FatturaButton pagamentoId={PAG} userId={UTENTE} codaStato="in_invio" />)
        expect(invia()).toBeNull()
        expect(screen.queryByRole('link')).toBeNull()
        expect(chiamate).toHaveLength(0)
    })

    it('`errore`: al posto del pulsante il collegamento alla pagina «Coda fatture»', () => {
        const { rerender } = render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        expect(invia()).toBeTruthy()
        expect(vaiAllaCoda()).toBeNull()

        rerender(<FatturaButton pagamentoId={PAG} userId={UTENTE} codaStato="errore" />)
        const link = vaiAllaCoda()
        expect(link?.tagName).toBe('A')
        expect(link?.getAttribute('href')).toBe('/admin/coda-fatture')
        expect(invia()).toBeNull()
    })

    it('`scartata` con la voce in `errore`: niente «Riprova fattura», c’è il collegamento', () => {
        const { rerender } = render(<FatturaButton pagamentoId={PAG} userId={UTENTE} fatturaStato="scartata" />)
        expect(screen.getByRole('button', { name: /riprova fattura/i })).toBeTruthy()

        rerender(<FatturaButton pagamentoId={PAG} userId={UTENTE} fatturaStato="scartata" codaStato="errore" />)
        expect(screen.queryByRole('button', { name: /riprova fattura/i })).toBeNull()
        expect(vaiAllaCoda()?.getAttribute('href')).toBe('/admin/coda-fatture')
    })

    it('uno stato fuori dai tre attivi (`tolta`) non nasconde niente', () => {
        // Il tipo della prop non lo ammette: arriva così solo da un dato che il server
        // non dovrebbe mandare, ed è proprio il caso in cui il pulsante deve restare.
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} codaStato={'tolta' as never} />)
        expect(invia()).toBeTruthy()
        expect(vaiAllaCoda()).toBeNull()
    })

    it('accodata qui, poi il genitore ricarica la riga con `in_coda`: la frase è LO STESSO nodo, e resta', async () => {
        const onEmessa = vi.fn()
        const { rerender } = render(<FatturaButton pagamentoId={PAG} userId={UTENTE} onEmessa={onEmessa} />)
        await apri()
        await screen.findByDisplayValue(DAL_MODELLO)
        const live = screen.getByTestId('fattura-accodata')
        fireEvent.click(screen.getByRole('button', { name: /^metti in coda$/i }))
        await waitFor(() => expect(live.textContent).toBe('Messa in coda: parte entro pochi minuti.'))

        // D12: il genitore aggiorna la riga. Se il pulsante sparisse nel GENITORE (e non
        // qui dentro), la live region verrebbe smontata proprio mentre annuncia (T8).
        rerender(<FatturaButton pagamentoId={PAG} userId={UTENTE} onEmessa={onEmessa} codaStato="in_coda" />)
        expect(screen.getByTestId('fattura-accodata')).toBe(live)
        expect(live.textContent).toBe('Messa in coda: parte entro pochi minuti.')
        expect(invia()).toBeNull()
    })
})
