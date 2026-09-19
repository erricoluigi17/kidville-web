import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import itAdmin from '../../messages/it/adminComunicazioni.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

expect.extend(toHaveNoViolations)

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * /admin/avvisi — GLI AVVISI SCADUTI RESTANO, E SI VEDONO PER QUELLO CHE SONO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Tre cose, e ciascuna ha già avuto la sua versione sbagliata da qualche parte:
 *
 *  1. **«Attivi» è il predefinito, ma «Scaduti» esiste.** Il cockpit è anche
 *     l'archivio di ciò che è stato pubblicato: «sparito dalla bacheca delle
 *     famiglie» non vuol dire «sparito dal lavoro della segreteria». Il conteggio
 *     accanto («2/3») è l'unica cosa che distingue «non ce ne sono» da «ne stai
 *     guardando una fetta».
 *
 *  2. **Lo stato «scaduto» arriva dal SERVER e non si ricalcola.** Fino al
 *     2026-09-19 il client faceva `new Date(scadenza) < new Date()`: mezzanotte
 *     UTC, cioè le 02:00 italiane d'estate, quindi dalle 02:00 in poi un avviso in
 *     scadenza quel giorno risultava già morto — per ventidue ore su ventiquattro
 *     dell'ULTIMO giorno utile. Qui la prova è che il booleano del server VINCE:
 *     un avviso con una data futura ma `scaduto: true` finisce fra gli scaduti.
 *
 *  3. **Una riga scaduta non si sbiadisce.** L'opacità ridotta abbassa il
 *     contrasto di tutta la riga per dire una cosa sola, ed è il modo classico di
 *     rendere illeggibile una tabella. Lo stato lo dice una parola.
 */

const USER = 'aaaabbbb-1111-4111-8111-cccccccccccc'

const h = vi.hoisted(() => ({ logClient: vi.fn(), push: vi.fn() }))

vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'Error' }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }) }))
vi.mock('@/lib/auth/use-session-identity', () => ({
    useSessionIdentity: () => ({ userId: USER, role: 'admin', ready: true }),
}))

const SEZIONI = {
    success: true,
    data: [{ scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A, sezioni: [{ id: 'sez-1', name: 'TEST 1A', school_type: 'infanzia' }] }],
}

/** Dati inventati: nessun contenuto reale di famiglie o bambini nei test. */
const AVVISI = [
    {
        id: 'avv-attivo-con-tetto', author_id: USER, titolo: 'TEST Gita al museo',
        contenuto: '…', tipo: 'adesione', target_scope: 'classe', target_classes: ['TEST 1A'],
        scadenza: null, scadenza_avviso: '2026-12-01T17:00:00Z', scadenza_adesione: '2026-11-20T12:00:00Z',
        attachment_url: null, created_at: '2026-09-17T08:00:00Z',
        author: { first_name: 'TEST', last_name: 'Segreteria', role: 'segreteria' },
        stats: { letti: 9, adesioni_si: 3, adesioni_no: 1, persone_ammesse: 7, adesioni_in_attesa: 1, persone_in_attesa: 2 },
        posti_totali: 10, sopra_capienza: false, scaduto: false,
    },
    {
        id: 'avv-sopra-capienza', author_id: USER, titolo: 'TEST Laboratorio',
        contenuto: '…', tipo: 'adesione', target_scope: 'classe', target_classes: ['TEST 1A'],
        scadenza: null, scadenza_avviso: '2026-12-02T17:00:00Z', scadenza_adesione: null,
        attachment_url: null, created_at: '2026-09-16T08:00:00Z',
        author: { first_name: 'TEST', last_name: 'Segreteria', role: 'segreteria' },
        stats: { letti: 5, adesioni_si: 4, adesioni_no: 0, persone_ammesse: 7, adesioni_in_attesa: 0, persone_in_attesa: 0 },
        posti_totali: 5, sopra_capienza: true, scaduto: false,
    },
    {
        id: 'avv-scaduto', author_id: USER, titolo: 'TEST Circolare vecchia',
        contenuto: '…', tipo: 'presa_visione', target_scope: 'globale', target_classes: null,
        // ⚠️ Data FUTURA ma `scaduto: true`: se il client ricalcolasse, questa riga
        // finirebbe fra gli attivi. È la prova che il booleano del server vince.
        scadenza: null, scadenza_avviso: '2026-12-31T17:00:00Z', scadenza_adesione: null,
        attachment_url: null, created_at: '2026-08-01T08:00:00Z',
        author: { first_name: 'TEST', last_name: 'Segreteria', role: 'segreteria' },
        stats: { letti: 20, adesioni_si: 0, adesioni_no: 0 },
        scaduto: true,
    },
]

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
        'fetch',
        vi.fn((url: unknown) => {
            const u = String(url)
            if (u.includes('/api/admin/sections/scoped')) {
                return Promise.resolve({ ok: true, status: 200, json: async () => SEZIONI } as unknown as Response)
            }
            return Promise.resolve({ ok: true, status: 200, json: async () => AVVISI } as unknown as Response)
        }),
    )
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

import AdminAvvisiPage from '@/app/(dashboard)/admin/avvisi/page'

async function montaCockpit() {
    const esito = render(<AdminAvvisiPage />)
    // Si aspetta la PRESENZA di una riga: un `waitFor` su un'assenza passerebbe
    // mentre la fetch è ancora in volo.
    await waitFor(() => expect(screen.getByText('TEST Gita al museo')).toBeInTheDocument())
    return esito
}

const rigaDi = (titolo: string) => screen.getByText(titolo).closest('tr') as HTMLElement

describe('/admin/avvisi — il filtro Attivi · Scaduti · Tutti', () => {
    it('al primo sguardo mostra gli ATTIVI e dice quanti sono su quanti', async () => {
        await montaCockpit()

        // Positive: i due attivi ci sono.
        expect(screen.getByText('TEST Gita al museo')).toBeInTheDocument()
        expect(screen.getByText('TEST Laboratorio')).toBeInTheDocument()
        // Negativa: lo scaduto no — e la schermata resta quella di ieri.
        expect(screen.queryByText('TEST Circolare vecchia')).not.toBeInTheDocument()

        // Il conteggio, in `role="status"`: cambia sotto le dita e va annunciato.
        expect(screen.getByRole('status')).toHaveTextContent('2/3')
    })

    it('«Scaduti» mostra SOLO gli scaduti, anche con una data futura in colonna', async () => {
        await montaCockpit()
        fireEvent.click(screen.getByRole('button', { name: itAdmin.avvisiFiltroScaduti }))

        expect(screen.getByText('TEST Circolare vecchia')).toBeInTheDocument()
        expect(screen.queryByText('TEST Gita al museo')).not.toBeInTheDocument()
        expect(screen.getByRole('status')).toHaveTextContent('1/3')
    })

    it('«Tutti» li rimette insieme', async () => {
        await montaCockpit()
        fireEvent.click(screen.getByRole('button', { name: itAdmin.avvisiFiltroTutti }))

        expect(screen.getByText('TEST Gita al museo')).toBeInTheDocument()
        expect(screen.getByText('TEST Circolare vecchia')).toBeInTheDocument()
        expect(screen.getByRole('status')).toHaveTextContent('3/3')
    })

    it('un filtro senza risultati lo dice, senza invitare a «creare il primo avviso»', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn((url: unknown) => {
                const u = String(url)
                if (u.includes('/api/admin/sections/scoped')) {
                    return Promise.resolve({ ok: true, status: 200, json: async () => SEZIONI } as unknown as Response)
                }
                // Solo avvisi attivi: il filtro «Scaduti» non trova niente.
                return Promise.resolve({ ok: true, status: 200, json: async () => [AVVISI[0]] } as unknown as Response)
            }),
        )
        await montaCockpit()
        fireEvent.click(screen.getByRole('button', { name: itAdmin.avvisiFiltroScaduti }))

        expect(screen.getByText('Nessun risultato con questi filtri')).toBeInTheDocument()
        // Davanti a un avviso che esiste, «crea il primo avviso» sarebbe falso.
        expect(screen.queryByText(itAdmin.avvisiVuotoDescrizione)).not.toBeInTheDocument()
    })
})

describe('/admin/avvisi — come si legge una riga scaduta', () => {
    it('porta la pillola «Scaduto» e la cella scadenza dice «Scaduto il …»', async () => {
        await montaCockpit()
        fireEvent.click(screen.getByRole('button', { name: itAdmin.avvisiFiltroScaduti }))

        const riga = rigaDi('TEST Circolare vecchia')
        expect(within(riga).getByText(itAdmin.avvisiBadgeScaduto)).toBeInTheDocument()
        // Data E ORA, nel fuso italiano: `2026-12-31T17:00:00Z` sono le 18:00 a Roma.
        expect(riga.textContent).toContain('Scaduto il 31/12/2026, 18:00')
    })

    it('NON si sbiadisce: nessuna opacità ridotta addosso alla riga', async () => {
        await montaCockpit()
        fireEvent.click(screen.getByRole('button', { name: itAdmin.avvisiFiltroScaduti }))

        const riga = rigaDi('TEST Circolare vecchia')
        // Positiva (la riga c'è ed è resa) + negativa (non è stata smorzata).
        expect(riga.textContent).toContain('TEST Circolare vecchia')
        expect(riga.className).not.toMatch(/opacity-/)
        expect(riga.querySelector('[class*="opacity-"]')).toBeNull()
    })
})

describe('/admin/avvisi — scadenze e posti, senza aggiungere colonne', () => {
    it('la colonna Scadenza porta data e ora, e la seconda scadenza delle adesioni', async () => {
        await montaCockpit()

        const celle = rigaDi('TEST Gita al museo').querySelectorAll('td')
        const scadenza = celle[3] as HTMLElement
        expect(scadenza.textContent).toContain('01/12/2026, 18:00')
        // `2026-11-20T12:00:00Z` → 13:00 a Roma (ora solare).
        expect(scadenza.textContent).toContain('Adesioni entro 20/11/2026, 13:00')
    })

    it('la colonna Adesioni porta i posti in seconda riga, e la pillola sopra capienza', async () => {
        await montaCockpit()

        const adesioni = rigaDi('TEST Gita al museo').querySelectorAll('td')[5] as HTMLElement
        expect(adesioni.textContent).toContain('3 sì · 1 no')
        expect(adesioni.textContent).toContain('Persone: 7/10 · In attesa: 2')
        expect(within(adesioni).queryByText(itAdmin.avvisiSopraCapienza)).not.toBeInTheDocument()

        const sopra = rigaDi('TEST Laboratorio').querySelectorAll('td')[5] as HTMLElement
        expect(sopra.textContent).toContain('Persone: 7/5')
        expect(within(sopra).getByText(itAdmin.avvisiSopraCapienza)).toBeInTheDocument()
    })

    it('le colonne restano SETTE: sul telefono la tabella scorre già in orizzontale', async () => {
        await montaCockpit()
        expect(screen.getAllByRole('columnheader')).toHaveLength(7)
    })

    it('la tabella regge axe, con le intestazioni di colonna associate alle celle', async () => {
        const { container } = await montaCockpit()
        fireEvent.click(screen.getByRole('button', { name: itAdmin.avvisiFiltroTutti }))
        await waitFor(() => expect(screen.getByText('TEST Circolare vecchia')).toBeInTheDocument())

        // Positiva prima della misura: la tabella è resa e piena (senza, axe
        // passerebbe su un guscio vuoto e non dimostrerebbe niente).
        expect(screen.getAllByRole('row').length).toBeGreaterThan(3)
        // `th-has-data-cells` e `td-headers-attr` stanno dentro axe: se
        // un'intestazione smettesse di riferirsi alle proprie celle, cade qui.
        //
        // ⚠️ `empty-table-header` È SPENTO, E VA DETTO PERCHÉ — non per far passare
        // questo test, ma perché il difetto che segnala non è di questa tabella e
        // non si chiude qui. La settima colonna (i comandi di riga) ha un `<th>`
        // vuoto: è il pattern di TUTTE le tabelle del cockpit — misurato lo stesso
        // giorno anche su `admin/merchandise/page.tsx` (due tabelle) e
        // `admin/protocolli/page.tsx`. Chiuderlo per bene vuol dire un'etichetta
        // tradotta («Azioni») in `messages/it` **e** `messages/en`, che questo
        // lavoro non tocca, applicata a tutte e quattro insieme: farlo su una sola
        // lascerebbe tre tabelle identiche e una diversa, senza che nessuno sappia
        // perché. Chi aggiungerà quella chiave tolga questa riga e riaccenda la
        // regola — e tutte le altre restano accese da adesso.
        expect(
            await axe(container, { rules: { 'empty-table-header': { enabled: false } } }),
        ).toHaveNoViolations()
    })

    it('un avviso senza tetto non inventa una riga di posti', async () => {
        await montaCockpit()
        fireEvent.click(screen.getByRole('button', { name: itAdmin.avvisiFiltroTutti }))

        const celle = rigaDi('TEST Circolare vecchia').querySelectorAll('td')
        expect((celle[5] as HTMLElement).textContent).not.toContain('Persone:')
    })
})
