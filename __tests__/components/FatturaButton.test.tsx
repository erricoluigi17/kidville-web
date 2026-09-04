/**
 * Il modale «Emetti fattura»: mostra ciò che uscirà, e la correzione a mano è un atto
 * deliberato.
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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

vi.mock('next-intl', async () => {
    const catalogo = (await import('../../messages/it/adminContabilita.json')).default as Record<string, string>
    const useTranslations = () => {
        const t = (key: string) => catalogo[key] ?? key
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

function montaFetch() {
    chiamate = []
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url)
        chiamate.push({ url: u, init })
        if (u.includes('/anteprima')) {
            return {
                ok: anteprima.ok,
                json: async () => anteprima.body,
            } as unknown as Response
        }
        return { ok: true, json: async () => ({ success: true, data: { fattura_stato: 'in_attesa' } }) } as unknown as Response
    }) as unknown as typeof fetch
}

function corpoPost(): Record<string, unknown> {
    const post = chiamate.find((c) => c.init?.method === 'POST')
    return JSON.parse(String(post?.init?.body ?? '{}'))
}

async function apri() {
    fireEvent.click(screen.getByRole('button', { name: /invia fattura/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^emetti$/i })).toBeTruthy())
}

beforeEach(() => {
    montaFetch()
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
        fireEvent.click(screen.getByRole('button', { name: /^emetti$/i }))
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
        fireEvent.click(screen.getByRole('button', { name: /^emetti$/i }))
        await waitFor(() => expect(chiamate.some((c) => c.init?.method === 'POST')).toBe(true))

        expect(corpoPost().causale).toBe('Saldo iscrizione — accordo del 12/09')
    })

    it('«Personalizza» premuto ma testo IDENTICO all’anteprima: nessuna correzione da scrivere', async () => {
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        await apri()
        await screen.findByDisplayValue(DAL_MODELLO)
        fireEvent.click(screen.getByRole('button', { name: /personalizza/i }))
        fireEvent.click(screen.getByRole('button', { name: /^emetti$/i }))
        await waitFor(() => expect(chiamate.some((c) => c.init?.method === 'POST')).toBe(true))

        // Congelare la causale su un pagamento significa rendere invisibile ogni
        // modifica futura al modello: non si fa per un testo che non corregge niente.
        expect(corpoPost().causale).toBeNull()
    })

    it('se l’anteprima FALLISCE, «Emetti» resta bloccato e l’errore si vede', async () => {
        anteprima = { ok: false, body: { error: 'Impossibile leggere i modelli di causale della sede' } }
        render(<FatturaButton pagamentoId={PAG} userId={UTENTE} />)
        fireEvent.click(screen.getByRole('button', { name: /invia fattura/i }))

        const emetti = await screen.findByRole('button', { name: /^emetti$/i })
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
        await waitFor(() => expect(screen.getByRole('status').textContent?.trim()).toBeTruthy())
    })
})
