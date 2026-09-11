import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react'

/**
 * ════════════════════════════════════════════════════════════════════════════
 * IL COMANDO NON COMPARE FINCHÉ NON SI SA CHE IL PDF ESISTE.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ─── IL DIFETTO, CHE ERA UN FAST-PATH ──────────────────────────────────────
 *
 * Qui c'era:
 *
 *     if (!fatture || fatture.length <= 1) return <a href={…}>Fattura</a>
 *
 * `fatture` è `null` anche MENTRE STA CARICANDO. Quel ramo, quindi, rendeva il
 * link PRIMA di sapere se dietro ci fosse un documento — e continuava a renderlo
 * quando la risposta diceva che il PDF non c'è, perché guardava solo il NUMERO
 * delle righe. Chi premeva riceveva un 404 (oggi) o, peggio, un foglio disegnato
 * al volo che sembra una fattura (fino a ieri).
 *
 * ─── LE TRE FASI, CHE SONO LA CORREZIONE ───────────────────────────────────
 *
 *  1. IN CARICAMENTO → niente. Nemmeno uno scheletro: in una tabella di rette uno
 *     scheletro per riga è una pagina che lampeggia.
 *  2. NESSUN PDF VERIFICATO → niente. Meglio nessun comando che un comando che dà
 *     404: il primo si spiega da sé, il secondo fa telefonare in segreteria.
 *  3. ALMENO UNO → le due affordance, «Apri» (inline) e «Scarica» (`download=1`).
 *
 * ⚠️ LA FASE 1 E LA FASE 2 RENDONO LA STESSA COSA — NIENTE — e un test che
 * guardasse solo «non c'è nessun link» sarebbe verde su entrambe anche col
 * difetto rimesso a posto male. Per questo la prima prova non si ferma
 * all'assenza: tiene la risposta SOSPESA, verifica il vuoto, poi la lascia
 * arrivare e pretende che i comandi compaiano. È la differenza fra «non c'è
 * ancora» e «non ci sarà mai».
 */

/** Il testo che il mock globale di next-intl produrrà: vedi `test/setup.ts`. */
const CATALOGO = JSON.parse(
    readFileSync(join(process.cwd(), 'messages/it/adminContabilita.json'), 'utf8'),
) as Record<string, string>
const testo = (chiave: string): string => CATALOGO[chiave] ?? `adminContabilita.${chiave}`

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
const F1 = 'cccccccc-0000-4000-8000-000000000011'
const F2 = 'cccccccc-0000-4000-8000-000000000012'

/** Gli indirizzi attesi, SCRITTI A MANO: costruirli con `urlFattura` sarebbe tautologico. */
const APRI_F1 = `/api/pagamenti/fattura?pagamento_id=${PAG}&userId=${UTENTE}&fattura_id=${F1}`
const SCARICA_F1 = `${APRI_F1}&download=1`
const APRI_F2 = `/api/pagamenti/fattura?pagamento_id=${PAG}&userId=${UTENTE}&fattura_id=${F2}`
const SCARICA_F2 = `${APRI_F2}&download=1`

const riga = (id: string, numero: number, disponibile: boolean, etichetta: string | null = null) => ({
    id, numero, anno: 2026, quota_label: etichetta, intestatario: 'Intestatario',
    pdf_disponibile: disponibile, sdi_stato_label: 'Consegnata',
})

/** `fetch` sotto controllo: la risposta dell'elenco si consegna QUANDO decido io. */
let consegna: ((righe: unknown[]) => void) | null = null
let chiamate: string[] = []

function montaFetch() {
    chiamate = []
    consegna = null
    global.fetch = vi.fn((url: string | URL | Request) => {
        const u = String(url)
        chiamate.push(u)
        if (!u.includes('/api/pagamenti/fattura/list')) {
            return Promise.resolve({ ok: true, json: async () => ({ success: true, data: {} }) } as unknown as Response)
        }
        return new Promise<Response>((risolvi) => {
            consegna = (righe: unknown[]) =>
                risolvi({ ok: true, json: async () => ({ success: true, data: righe }) } as unknown as Response)
        })
    }) as unknown as typeof fetch
}

const emessa = () => render(<FatturaButton pagamentoId={PAG} userId={UTENTE} fatturaStato="emessa" />)
const chiamateElenco = () => chiamate.filter((u) => u.includes('/api/pagamenti/fattura/list'))

/**
 * Consegna la risposta dell'elenco E ASPETTA CHE SIA STATA ASSORBITA.
 *
 * ⚠️ QUESTA FUNZIONE È LA DIFFERENZA FRA MISURARE LA FASE 2 E CREDERE DI FARLO.
 * Fra `risolvi(...)` e lo schermo ci sono almeno DUE microtask — `await res.json()`
 * e poi il `setStato` che React deve applicare — quindi un `await Promise.resolve()`,
 * che ne consuma UNO, lascia il componente ancora in FASE 1. E la fase 1 rende
 * `null` esattamente come la fase 2: l'asserzione «non c'è nessun link» sarebbe
 * verde per il motivo sbagliato, e resterebbe verde anche con il fast-path storico
 * rimesso al suo posto dopo il caricamento.
 *
 * `act(async …)` invece svuota la coda dei microtask e applica gli aggiornamenti
 * di React prima di restituire il controllo: dopo questa `await`, ciò che si legge
 * a schermo è la RISPOSTA, non l'attesa.
 */
async function consegnaEAssorbi(righe: unknown[]): Promise<void> {
    await act(async () => { consegna?.(righe) })
}

beforeEach(montaFetch)
afterEach(cleanup)

// ═════════════════════════════════════════════════════════════════════════════
describe('fase 1 · in caricamento non si rende NIENTE', () => {
    it('con la risposta ancora in volo non c’è nessun link — e appena arriva, compaiono', async () => {
        const { container } = emessa()

        // L'elenco è stato chiesto: il vuoto qui sotto è «non lo so ancora», non
        // «non è partito niente».
        await waitFor(() => expect(chiamateElenco()).toHaveLength(1))
        expect(screen.queryAllByRole('link')).toHaveLength(0)
        // Nemmeno uno scheletro: il nodo è vuoto, non «vuoto ma alto».
        expect(container.innerHTML).toBe('')

        // …e ora la risposta arriva. Senza questa metà, la prova sarebbe verde
        // anche su un componente che non rende MAI niente.
        await consegnaEAssorbi([riga(F1, 1948, true)])
        expect(screen.queryAllByRole('link')).toHaveLength(2)
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('fase 2 · senza PDF verificato non si rende NIENTE', () => {
    it('`pdf_disponibile: false` → nessun link, benché la fattura esista', async () => {
        emessa()
        await waitFor(() => expect(chiamateElenco()).toHaveLength(1))
        await consegnaEAssorbi([riga(F1, 1948, false)])

        expect(screen.queryAllByRole('link')).toHaveLength(0)
        expect(document.body.innerHTML).not.toContain('/api/pagamenti/fattura?')
    })

    it('`pdf_disponibile` ASSENTE (risposta di un server più vecchio) → nessun link', async () => {
        emessa()
        await waitFor(() => expect(chiamateElenco()).toHaveLength(1))
        // Il filtro è `=== true` e non «un valore vero qualunque»: un campo che non
        // c'è vale «non lo so», e «non lo so» non accende un comando. Un filtro
        // scritto `!== false` accetterebbe questa riga, e il comando comparirebbe
        // su una fattura di cui nessuno ha verificato il PDF.
        await consegnaEAssorbi([{ id: F1, numero: 1948, anno: 2026, quota_label: null, intestatario: 'X' }])
        expect(screen.queryAllByRole('link')).toHaveLength(0)
    })

    it('elenco vuoto → nessun link', async () => {
        // ⚠️ QUESTO È IL CASO DEL DIFETTO STORICO, non un contorno: il fast-path
        // diceva `fatture.length <= 1`, e zero è minore di uno. Un elenco vuoto
        // ARRIVATO (non «non ancora arrivato») è precisamente ciò che lo faceva
        // scattare a risposta ricevuta.
        emessa()
        await waitFor(() => expect(chiamateElenco()).toHaveLength(1))
        await consegnaEAssorbi([])
        expect(screen.queryAllByRole('link')).toHaveLength(0)
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('fase 3 · una quota sola: due affordance, e `download=1` SOLO sulla seconda', () => {
    it('«Apri» va all’inline, «Scarica» chiede l’allegato', async () => {
        emessa()
        await waitFor(() => expect(chiamateElenco()).toHaveLength(1))
        await consegnaEAssorbi([riga(F1, 1948, true)])

        const link = screen.getAllByRole('link')
        expect(link).toHaveLength(2)

        // L'ORDINE conta: prima si legge, poi si salva.
        expect(link[0]).toHaveAttribute('href', APRI_F1)
        expect(link[1]).toHaveAttribute('href', SCARICA_F1)
        // `download=1` sta su UNA sola delle due, e non è un dettaglio: se stesse su
        // entrambe, «Apri» salverebbe un file invece di mostrarlo, e se non stesse su
        // nessuna «Scarica» aprirebbe il PDF senza salvare niente.
        expect(link[0].getAttribute('href')).not.toContain('download=')
        expect(link[1].getAttribute('href')).toContain('download=1')

        // Due parole diverse: due chiavi diverse del catalogo, non la stessa due volte.
        expect(link[0].textContent).toContain(testo('fatBtn_apri'))
        expect(link[1].textContent).toContain(testo('fatBtn_scarica'))
        expect(testo('fatBtn_apri')).not.toBe(testo('fatBtn_scarica'))

        // MAI `target="_blank"`: nella WebView `window.open` non apre e non lo dice.
        for (const a of link) expect(a.getAttribute('target')).toBeNull()
    })

    it('la regione d’avviso è montata SEMPRE, e da vuota non occupa spazio', async () => {
        // Un `role="alert"` inserito nel DOM col testo già dentro spesso resta muto:
        // dev'esserci prima, e riempirsi dopo. Da vuota sta in `sr-only`.
        emessa()
        await waitFor(() => expect(chiamateElenco()).toHaveLength(1))
        await consegnaEAssorbi([riga(F1, 1948, true)])
        const avviso = screen.getByRole('alert')
        expect(avviso.className).toContain('sr-only')
        expect(avviso.textContent).toBe('')
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('fase 3 · due quote (genitori separati): un menù, e due comandi per ciascuna', () => {
    it('solo le quote col PDF verificato entrano nel conteggio e nel menù', async () => {
        emessa()
        await waitFor(() => expect(chiamateElenco()).toHaveLength(1))
        await consegnaEAssorbi([
            riga(F1, 1948, true, 'Mamma'),
            riga(F2, 1949, true, 'Papà'),
            // La terza esiste a registro ma il suo PDF non è nel bucket: non deve
            // comparire né nel conteggio né nel menù.
            riga('dddddddd-0000-4000-8000-000000000013', 1950, false, 'Nonna'),
        ])

        const apri = screen.getByRole('button')
        expect(apri.textContent).toContain('(2)')      // due, non tre
        fireEvent.click(apri)

        const link = screen.getAllByRole('link')
        expect(link).toHaveLength(4)
        expect(link.map((a) => a.getAttribute('href'))).toEqual([APRI_F1, SCARICA_F1, APRI_F2, SCARICA_F2])
        expect(screen.queryByText(/Nonna/)).toBeNull()
    })
})
