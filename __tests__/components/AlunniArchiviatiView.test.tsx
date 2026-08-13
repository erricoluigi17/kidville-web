import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, renderHook, screen, waitFor, within, fireEvent, act } from '@testing-library/react'

import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import itAdminStudents from '../../messages/it/adminStudents.json'

/**
 * «NON PIÙ ISCRITTI» — la linguetta di /admin/students.
 *
 * ─── LE TRE COSE CHE QUESTI TEST TENGONO FERME ───────────────────────────────
 *
 *  1. IL CONTEGGIO. Va sulla pillola della linguetta, quindi l'elenco si legge
 *     PRIMA che qualcuno la apra: l'hook sta nel componente e lo invoca la
 *     pagina. Un pannello che si carica solo quando lo guardi non può dire a
 *     nessuno che c'è da guardarlo.
 *
 *  2. LO SCOPE DI SEDE. La lettura passa `x-sedi`, cioè la selezione del
 *     SedeSelector che il server ri-valida: senza quell'intestazione l'elenco
 *     non cambia al cambio di sede, e la segreteria di un plesso vede i bambini
 *     archiviati di un altro. Qui si guarda la CHIAMATA, che è l'unico posto in
 *     cui quella proprietà è verificabile dal client.
 *
 *  3. NIENTE CODICE FISCALE E NIENTE ALLERGIE IN ELENCO. Vale qui come per
 *     `admin/students:GET`, la cui proiezione è stata ridotta il 2026-07-31
 *     proprio perché una lista consegnava il fascicolo dell'intera scuola. Il
 *     test lo pretende sul DOM RESO, non sul tipo TypeScript: un tipo non
 *     impedisce a un `JSON.stringify(riga)` di finire in un attributo.
 *
 * ─── PERCHÉ next-intl È FINTO DA CAPO ────────────────────────────────────────
 * Il mock globale (`test/setup.ts`) restituisce la stringa GREZZA: l'esito della
 * riattivazione — «{nome} è tornato fra gli iscritti, ma la classe «{classe}»
 * non esiste più» — resterebbe pieno di segnaposti, e il test più importante del
 * file sarebbe verde su una frase che non nomina nessuna classe. Qui si usa il
 * formattatore ICU VERO (`use-intl`), che sa anche i `plural`.
 */

vi.mock('next-intl', async () => {
    const { createTranslator } = await import('use-intl')
    const adminStudents = (await import('../../messages/it/adminStudents.json')).default as Record<string, string>
    const shared = (await import('../../messages/it/shared.json')).default as Record<string, string>
    const cataloghi = { adminStudents, shared }
    const useTranslations = (ns?: string) => {
        const tradotto = createTranslator({
            locale: 'it',
            messages: cataloghi as never,
            namespace: (ns ?? 'adminStudents') as never,
        }) as unknown as (chiave: string, valori?: Record<string, unknown>) => string
        const t = (chiave: string, valori?: Record<string, unknown>) => tradotto(chiave, valori)
        return Object.assign(t, { rich: t, markup: t, raw: t, has: () => true })
    }
    return {
        useTranslations,
        useLocale: () => 'it',
        useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    }
})

const push = vi.fn()
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}))

/** Le sedi attive: due, così la colonna «Sede» ha un motivo per esistere. */
const sediAttive = { valore: [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_B, nome: NOME_SEDE_B }] }
vi.mock('@/lib/context/sede-context', () => ({
    useSediAttive: () => ({
        sedi: sediAttive.valore,
        selezionate: [],
        effettive: sediAttive.valore.map((s) => s.id),
        sedeCorrente: null,
        reFetchKey: sediAttive.valore.map((s) => s.id).join(','),
        epocaSede: 0,
        loading: false,
        toggle: vi.fn(),
        soloSede: vi.fn(),
        tutte: vi.fn(),
    }),
}))

const logClient = vi.fn()
vi.mock('@/lib/logging/client', async (originale) => ({
    ...(await originale<typeof import('@/lib/logging/client')>()),
    logClient: (...args: unknown[]) => logClient(...args),
}))

import {
    AlunniArchiviatiView,
    useAlunniArchiviati,
    type AlunnoArchiviato,
    type EsitoAlunniArchiviati,
} from '@/components/features/admin/AlunniArchiviatiView'

/* ── Righe di prova. Codici FINTI: il repository è PUBBLICO. ────────────────── */

const ANNA: AlunnoArchiviato = {
    id: 'aaaa1111-0000-4000-8000-000000000001',
    nome: 'Anna',
    cognome: 'Bianchi',
    data_nascita: '2021-03-14',
    scuola_id: SEDE_A,
    stato: 'ritirato',
    archiviato_il: '2026-08-01T10:00:00.000Z',
    archiviato_classe_sezione: '2 ANNI',
    spazio_liberato_il: null,
}

const LUCA: AlunnoArchiviato = {
    id: 'bbbb2222-0000-4000-8000-000000000002',
    nome: 'Luca',
    cognome: 'Adami',
    data_nascita: '2020-11-02',
    scuola_id: SEDE_B,
    stato: 'ritirato',
    archiviato_il: '2026-07-20T09:30:00.000Z',
    archiviato_classe_sezione: '3 ANNI',
    /** Foto, video e messaggi già cancellati: il badge deve dirlo. */
    spazio_liberato_il: '2026-08-05T09:00:00.000Z',
}

/**
 * La riga come arriva dal DB E2E della CI, che NON è migrato: la GET degrada da
 * sé (ciclo `42703`) e le tre colonne dell'archiviazione non arrivano affatto.
 */
const SENZA_COLONNE: AlunnoArchiviato = {
    id: 'cccc3333-0000-4000-8000-000000000003',
    nome: 'Sara',
    cognome: 'Costa',
    data_nascita: '2019-05-30',
    scuola_id: SEDE_A,
    stato: 'ritirato',
}

/**
 * La risposta del dry-run di `libera-spazio`, come la serializza la rotta.
 * Serve ai casi che aprono il riquadro di conferma: senza `nominativo_conferma`
 * il dialogo si rifiuta di offrire il comando, ed è il suo comportamento giusto.
 */
const DRY_RUN = {
    dryrun: true,
    foto_sole_sue: 2,
    video_soli_suoi: 1,
    media_di_gruppo: 1,
    messaggi: 3,
    allegati: 1,
    thread: 1,
    articoli_pubblici: 0,
    spazio_liberato_il: null,
    nominativo_conferma: 'BIANCHI ANNA',
    non_tocca: { tabelle: ['pagamenti', 'presenze'], bucket: ['fatture'] },
}

const esitoFinto = (over: Partial<EsitoAlunniArchiviati> = {}): EsitoAlunniArchiviati => ({
    fase: 'pronto',
    righe: [ANNA, LUCA],
    totale: 2,
    ricaricando: false,
    riletturaFallita: false,
    errore: null,
    ricarica: vi.fn(),
    ...over,
})

const fetchMock = vi.fn()

beforeEach(() => {
    vi.clearAllMocks()
    sediAttive.valore = [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_B, nome: NOME_SEDE_B }]
    fetchMock.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), json: async () => [] })
    vi.stubGlobal('fetch', fetchMock)
})

// ─────────────────────────────────────────────────────────────────────────────
// L'HOOK — il conteggio e lo scope di sede
// ─────────────────────────────────────────────────────────────────────────────

describe('useAlunniArchiviati — la lettura che alimenta la pillola', () => {
    it('chiede SOLO gli archiviati, e dichiara le sedi attive nell\'intestazione', async () => {
        const { result } = renderHook(() => useAlunniArchiviati())
        await waitFor(() => expect(result.current.fase).toBe('pronto'))

        const [url, opzioni] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }]
        // Il filtro di stato, che è ciò che rende inutile una GET nuova.
        expect(url).toContain('/api/admin/students?stato=ritirato')
        // ⟵ LO SCOPE DI SEDE. Senza `x-sedi` l'elenco non cambia al cambio di
        //    sede: la segreteria di un plesso vedrebbe gli archiviati di un altro.
        expect(opzioni.headers['x-sedi']).toBe(`${SEDE_A},${SEDE_B}`)
    })

    it('il conteggio è quello delle righe ARRIVATE, non il totale dichiarato dal server', async () => {
        // Un badge che promette 40 righe accanto a una tabella che ne mostra 2
        // dice una cosa falsa sul dato che l'utente ha davanti. Il totale non si
        // butta via: accende l'avviso «l'elenco mostrato è più corto».
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Headers({ 'X-Total-Count': '40' }),
            json: async () => [ANNA, LUCA],
        })
        const { result } = renderHook(() => useAlunniArchiviati())
        await waitFor(() => expect(result.current.fase).toBe('pronto'))

        expect(result.current.righe).toHaveLength(2)
        expect(result.current.totale).toBe(40)
    })

    it('un 200 con un corpo che NON è un elenco è un guasto, non «nessun archiviato»', async () => {
        // Trattarlo come lista vuota mostrerebbe il cartello verde «Nessun
        // bambino archiviato»: una buona notizia falsa, su cui nessuno torna.
        fetchMock.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), json: async () => ({ righe: [] }) })
        const { result } = renderHook(() => useAlunniArchiviati())

        await waitFor(() => expect(result.current.fase).toBe('errore'))
        expect(result.current.righe).toHaveLength(0)
        expect(logClient).toHaveBeenCalled()
    })

    it('la rete giù NON diventa un elenco vuoto, e lascia una riga di log', async () => {
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
        const { result } = renderHook(() => useAlunniArchiviati())

        await waitFor(() => expect(result.current.fase).toBe('errore'))
        expect(logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', route: '/admin/students' }),
        )
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// LA TABELLA
// ─────────────────────────────────────────────────────────────────────────────

describe('AlunniArchiviatiView — quello che l\'elenco mostra', () => {
    it('mostra da quale classe è uscito e quando, e il badge «spazio liberato» solo a chi ce l\'ha', () => {
        render(<AlunniArchiviatiView esito={esitoFinto()} ruolo="admin" />)

        const rigaAnna = screen.getByText('Bianchi Anna').closest('tr') as HTMLElement
        expect(within(rigaAnna).getByText('2 ANNI')).toBeInTheDocument()
        expect(within(rigaAnna).getByText('01/08/2026')).toBeInTheDocument()
        expect(within(rigaAnna).queryByText(itAdminStudents.arcBadgeSpazioLiberato)).toBeNull()

        const rigaLuca = screen.getByText('Adami Luca').closest('tr') as HTMLElement
        expect(within(rigaLuca).getByText(itAdminStudents.arcBadgeSpazioLiberato)).toBeInTheDocument()
    })

    it('⚠️ NON mostra il codice fiscale né le allergie: è un elenco, non un fascicolo', () => {
        // La regola di proiezione minima di `admin/students:GET` vale qui come là.
        // Si guarda l'HTML RESO — attributi compresi — perché un tipo TypeScript
        // non impedisce a un `JSON.stringify(riga)` di finire in un `data-*`.
        const conFascicolo = {
            ...ANNA,
            codice_fiscale: 'CODICEFINTO00001',
            note_mediche: 'NOTA-MEDICA-RISERVATA',
            allergies: 'ALLERGIA-RISERVATA',
        } as AlunnoArchiviato
        const { container } = render(
            <AlunniArchiviatiView esito={esitoFinto({ righe: [conFascicolo], totale: 1 })} ruolo="admin" />,
        )
        expect(container.innerHTML).not.toContain('CODICEFINTO00001')
        expect(container.innerHTML).not.toContain('NOTA-MEDICA-RISERVATA')
        expect(container.innerHTML).not.toContain('ALLERGIA-RISERVATA')
    })

    it('la colonna «Sede» compare con due sedi attive e sparisce con una sola', () => {
        const { unmount } = render(<AlunniArchiviatiView esito={esitoFinto()} ruolo="admin" />)
        expect(screen.getByRole('columnheader', { name: itAdminStudents.arcColSede })).toBeInTheDocument()
        expect(screen.getByText(NOME_SEDE_A)).toBeInTheDocument()
        unmount()

        sediAttive.valore = [{ id: SEDE_A, nome: NOME_SEDE_A }]
        render(<AlunniArchiviatiView esito={esitoFinto({ righe: [ANNA], totale: 1 })} ruolo="admin" />)
        expect(screen.queryByRole('columnheader', { name: itAdminStudents.arcColSede })).toBeNull()
    })

    it('senza le colonne dell\'archiviazione (CI non migrata) dichiara l\'assenza invece di lasciare il vuoto', () => {
        render(<AlunniArchiviatiView esito={esitoFinto({ righe: [SENZA_COLONNE], totale: 1 })} ruolo="admin" />)
        const riga = screen.getByText('Costa Sara').closest('tr') as HTMLElement
        expect(within(riga).getByText(itAdminStudents.arcSenzaClasse)).toBeInTheDocument()
        expect(within(riga).getByText(itAdminStudents.arcSenzaData)).toBeInTheDocument()
    })

    it('dice all\'operatore che il motivo delle assenze sparisce entro 24 ore', () => {
        // È una promessa già pubblicata in `/privacy` e un automa che gira da
        // solo alle 04:59 UTC: non è un difetto da correggere, è un fatto da dire.
        render(<AlunniArchiviatiView esito={esitoFinto()} ruolo="admin" />)
        expect(screen.getByText(itAdminStudents.arcAvvisoMotivoAssenza)).toBeInTheDocument()
    })

    it('un elenco più corto del totale lo DICHIARA: mai un troncamento silenzioso', () => {
        render(<AlunniArchiviatiView esito={esitoFinto({ totale: 40 })} ruolo="admin" />)
        expect(screen.getByText(itAdminStudents.arcParziale)).toBeInTheDocument()
    })

    it('«nessun archiviato» e «la ricerca non trova niente» sono due schermate diverse', () => {
        const { unmount } = render(<AlunniArchiviatiView esito={esitoFinto({ righe: [], totale: 0 })} ruolo="admin" />)
        expect(screen.getByText(itAdminStudents.arcVuotoTitolo)).toBeInTheDocument()
        unmount()

        render(<AlunniArchiviatiView esito={esitoFinto()} ruolo="admin" />)
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nessuno-con-questo-nome' } })
        expect(screen.getByText(itAdminStudents.arcFiltriVuotoTitolo)).toBeInTheDocument()
        expect(screen.queryByText(itAdminStudents.arcVuotoTitolo)).toBeNull()
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// I DUE COMANDI
// ─────────────────────────────────────────────────────────────────────────────

describe('AlunniArchiviatiView — i due comandi per riga', () => {
    it('ogni riga porta i comandi come `<button>` veri: raggiungibili da tastiera', () => {
        render(<AlunniArchiviatiView esito={esitoFinto()} ruolo="admin" />)
        const riga = screen.getByText('Bianchi Anna').closest('tr') as HTMLElement
        // Lock `righe-tabella-con-comando`: il click sulla riga è la comodità del
        // mouse, il comando vero è un tab stop.
        expect(within(riga).getByRole('button', { name: itAdminStudents.arcAzioneRiattiva })).toBeInTheDocument()
        expect(within(riga).getByRole('button', { name: itAdminStudents.arcAzioneLiberaSpazio })).toBeInTheDocument()
    })

    it('«Libera spazio» non compare alla segreteria — e il comando di ritorno sì', () => {
        // Il gate VERO è sul server: questo è solo cortesia, per non offrire un
        // comando che riceverebbe 403.
        render(<AlunniArchiviatiView esito={esitoFinto()} ruolo="segreteria" />)
        expect(screen.queryAllByRole('button', { name: itAdminStudents.arcAzioneLiberaSpazio })).toHaveLength(0)
        expect(screen.getAllByRole('button', { name: itAdminStudents.arcAzioneRiattiva })).toHaveLength(2)
    })

    it('finché il ruolo non è risolto il comando distruttivo resta NASCOSTO', () => {
        // `ruolo` arriva da una fetch (`AdminIdentityProvider`) e all'inizio è ''.
        // Si sbaglia verso il nascondere, mai verso l'offrire.
        render(<AlunniArchiviatiView esito={esitoFinto()} ruolo="" />)
        expect(screen.queryAllByRole('button', { name: itAdminStudents.arcAzioneLiberaSpazio })).toHaveLength(0)
    })

    it('⚠️ «Libera spazio» APRE la conferma e conta subito: non porta da nessun’altra parte', async () => {
        // ─── IL DIFETTO CHE QUESTO TEST CHIUDE ────────────────────────────────
        // Fino al 2026-08-13 qui c'era un caso intitolato «senza delega porta alla
        // scheda», che CERTIFICAVA un vicolo cieco: il comando faceva
        // `router.push('/admin/students/<id>')`, su quella scheda non c'era niente,
        // e `grep -rn "libera-spazio" src/` non trovava una sola `fetch`. La rotta,
        // il suo motore e i suoi 49 test esistevano senza nessun chiamante, mentre
        // il testo in cima alla linguetta prometteva all'operatore che foto, video e
        // messaggi se ne andavano. Un test verde su un comando che non fa niente è
        // peggio di nessun test: dice che il vuoto è il comportamento voluto.
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => DRY_RUN,
        })
        render(<AlunniArchiviatiView esito={esitoFinto({ righe: [ANNA], totale: 1 })} ruolo="admin" userId="u-1" />)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: itAdminStudents.arcAzioneLiberaSpazio }))
        })

        // ⟵ NON si naviga via: la conferma è QUI, accanto all'elenco da cui il
        //    modello dice che l'operazione comincia.
        expect(push).not.toHaveBeenCalled()
        expect(await screen.findByRole('dialog')).toBeInTheDocument()

        // …e il conteggio è partito davvero, in `dryrun`: è ciò che l'operatore
        // legge PRIMA di digitare il nominativo.
        const [url, opzioni] = fetchMock.mock.calls[0] as [string, { method: string; body: string }]
        expect(url).toBe('/api/admin/students/libera-spazio')
        expect(opzioni.method).toBe('POST')
        expect(JSON.parse(opzioni.body)).toEqual({ alunno_id: ANNA.id, mode: 'dryrun' })
    })

    it('il riquadro nomina il bambino GIUSTO quando si passa da una riga all’altra', async () => {
        // Il dialogo non si smonta fra un'apertura e l'altra: senza il ripristino
        // dello stato, il conteggio del bambino precedente resterebbe a schermo
        // accanto al nome del nuovo — cioè il numero sbagliato sotto il nome giusto,
        // su un pulsante senza annulla.
        fetchMock.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), json: async () => DRY_RUN })
        render(<AlunniArchiviatiView esito={esitoFinto()} ruolo="admin" />)

        const comandi = screen.getAllByRole('button', { name: itAdminStudents.arcAzioneLiberaSpazio })
        await act(async () => {
            fireEvent.click(comandi[0])
        })
        // L'elenco è ordinato per cognome: Adami Luca prima di Bianchi Anna.
        expect(JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body).alunno_id).toBe(LUCA.id)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: itAdminStudents.spzAnnulla }))
        })
        await act(async () => {
            fireEvent.click(screen.getAllByRole('button', { name: itAdminStudents.arcAzioneLiberaSpazio })[1])
        })
        const ultima = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, { body: string }]
        expect(JSON.parse(ultima[1].body).alunno_id).toBe(ANNA.id)
    })

    it('alla segreteria il riquadro non è nemmeno raggiungibile', () => {
        render(<AlunniArchiviatiView esito={esitoFinto()} ruolo="segreteria" />)
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(screen.queryAllByRole('button', { name: itAdminStudents.arcAzioneLiberaSpazio })).toHaveLength(0)
    })
})

describe('AlunniArchiviatiView — il ritorno fra gli iscritti', () => {
    const rispondi = (corpo: unknown) =>
        fetchMock.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), json: async () => corpo })

    it('POSTa l\'id giusto e ricarica l\'elenco: la riga deve uscire di qui', async () => {
        rispondi({ success: true, esito_classe: 'ripristinata', classe_sezione: '2 ANNI', classe_mancante: null, spazio_gia_liberato: false })
        const ricarica = vi.fn()
        render(<AlunniArchiviatiView esito={esitoFinto({ righe: [ANNA], totale: 1, ricarica })} ruolo="admin" />)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: itAdminStudents.arcAzioneRiattiva }))
        })

        const [url, opzioni] = fetchMock.mock.calls[0] as [string, { method: string; body: string }]
        expect(url).toBe('/api/admin/students/riattiva')
        expect(opzioni.method).toBe('POST')
        expect(JSON.parse(opzioni.body)).toEqual({ alunno_id: ANNA.id })
        expect(ricarica).toHaveBeenCalled()
    })

    it('⚠️ quando la classe non esiste più lo DICE, e la nomina', async () => {
        // È il caso per cui la route non indovina nessuna sezione: chi legge deve
        // sapere che il bambino è dentro ma senza classe, e quale classe cercava.
        rispondi({ success: true, esito_classe: 'sparita', classe_sezione: null, classe_mancante: '2 ANNI', spazio_gia_liberato: false })
        render(<AlunniArchiviatiView esito={esitoFinto({ righe: [ANNA], totale: 1 })} ruolo="admin" />)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: itAdminStudents.arcAzioneRiattiva }))
        })

        const esito = await screen.findByRole('status')
        expect(esito.textContent).toContain('Bianchi Anna')
        expect(esito.textContent).toContain('2 ANNI')
        expect(esito.textContent).toContain('non esiste più')
        // E il fuoco è lì sopra: il bottone premuto sta per sparire con la riga.
        expect(document.activeElement).toBe(esito)
    })

    it('dice anche che foto e messaggi NON tornano indietro, quando erano già stati cancellati', async () => {
        rispondi({ success: true, esito_classe: 'ripristinata', classe_sezione: '3 ANNI', classe_mancante: null, spazio_gia_liberato: true })
        render(<AlunniArchiviatiView esito={esitoFinto({ righe: [LUCA], totale: 1 })} ruolo="admin" />)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: itAdminStudents.arcAzioneRiattiva }))
        })

        expect((await screen.findByRole('status')).textContent).toContain(itAdminStudents.arcEsitoSpazioGiaLiberato)
    })

    it('un rifiuto del server si VEDE, e l\'elenco non viene ricaricato come se fosse andata bene', async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 409,
            headers: new Headers(),
            json: async () => ({ error: 'x', codice: 'ALUNNO_NON_ARCHIVIATO' }),
        })
        const ricarica = vi.fn()
        render(<AlunniArchiviatiView esito={esitoFinto({ righe: [ANNA], totale: 1, ricarica })} ruolo="admin" />)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: itAdminStudents.arcAzioneRiattiva }))
        })

        // Il codice viene tradotto dal catalogo, non lasciato alla prosa del server.
        expect((await screen.findByRole('alert')).textContent).toContain('già fra gli iscritti')
        expect(ricarica).not.toHaveBeenCalled()
        expect(logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', stato: 409 }))
    })

    it('⚠️ RITIRO A MANO: la classe ce l\'ha ancora, e NON gli si dice «assegnane una»', async () => {
        // Il difetto che questo test esiste per non far tornare: la rotta rispondeva
        // `classe_ripristinata: false` ANCHE quando il bambino la classe non l'aveva
        // mai persa (ritiro messo a mano dalla tendina, `archiviato_*` NULL), e qui
        // si cadeva sul ramo «Assegna una classe dalla sua scheda» per un bambino
        // che era in «2 ANNI». Adesso l'esito ha quattro valori e `conservata` è
        // quel caso: si annuncia il rientro CON la sua classe e non si chiede niente.
        rispondi({ success: true, esito_classe: 'conservata', classe_sezione: '2 ANNI', classe_mancante: null, spazio_gia_liberato: false })
        render(<AlunniArchiviatiView esito={esitoFinto({ righe: [ANNA], totale: 1 })} ruolo="admin" />)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: itAdminStudents.arcAzioneRiattiva }))
        })

        const esito = await screen.findByRole('status')
        expect(esito.textContent).toContain('2 ANNI')
        expect(esito.textContent, 'gli si dice di assegnare una classe che ha già').not.toMatch(/Assegna una classe/i)
        expect(esito.textContent).not.toMatch(/non esiste più/i)
    })

    it('quando davvero non ha nessuna classe, allora sì che glielo si dice', async () => {
        // Il controllo negativo del test qui sopra: se il ramo «assegna una classe»
        // fosse morto del tutto, quello sarebbe verde per la ragione sbagliata.
        rispondi({ success: true, esito_classe: 'assente', classe_sezione: null, classe_mancante: null, spazio_gia_liberato: false })
        render(<AlunniArchiviatiView esito={esitoFinto({ righe: [ANNA], totale: 1 })} ruolo="admin" />)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: itAdminStudents.arcAzioneRiattiva }))
        })

        expect((await screen.findByRole('status')).textContent).toMatch(/Assegna una classe/i)
    })

    it('dice che il GRUPPO MENSA non torna da solo: era la perdita che nessuno dichiarava', async () => {
        rispondi({
            success: true, esito_classe: 'ripristinata', classe_sezione: '2 ANNI', classe_mancante: null,
            gruppo_mensa_da_riassegnare: true, spazio_gia_liberato: false,
        })
        render(<AlunniArchiviatiView esito={esitoFinto({ righe: [ANNA], totale: 1 })} ruolo="admin" />)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: itAdminStudents.arcAzioneRiattiva }))
        })

        expect((await screen.findByRole('status')).textContent).toContain(itAdminStudents.arcEsitoMensaDaRiassegnare)
    })

    it('⚠️ DUE CLIC NELLO STESSO TICK fanno UNA sola POST', async () => {
        // La guardia è un `ref` e non lo stato, ed è l'unico modo che funziona: due
        // click nello stesso giro di eventi leggono tutti e due lo stato VECCHIO e
        // partono tutti e due. Il difetto non è teorico — la seconda POST prende
        // 409, e se risolve per ultima `setMessaggio` sostituisce l'esito verde con
        // un `role="alert"` rosso «già fra gli iscritti» DOPO una riattivazione
        // riuscita: l'operatore vede un errore su un'operazione andata a buon fine.
        //
        // ⚠️ I due `fireEvent.click` stanno nello STESSO `act`: separarli lascerebbe
        // a React il tempo di applicare lo stato fra i due, e il test sarebbe verde
        // anche con la guardia scritta sullo stato invece che sul ref — cioè
        // proprio col difetto che deve prendere.
        rispondi({ success: true, esito_classe: 'ripristinata', classe_sezione: '2 ANNI', classe_mancante: null, spazio_gia_liberato: false })
        const ricarica = vi.fn()
        render(<AlunniArchiviatiView esito={esitoFinto({ righe: [ANNA], totale: 1, ricarica })} ruolo="admin" />)

        const bottone = screen.getByRole('button', { name: itAdminStudents.arcAzioneRiattiva })
        await act(async () => {
            fireEvent.click(bottone)
            fireEvent.click(bottone)
        })

        const poste = fetchMock.mock.calls.filter((c) => String(c[0]) === '/api/admin/students/riattiva')
        expect(poste, 'un secondo clic nello stesso tick ha prodotto una seconda POST').toHaveLength(1)
        expect(ricarica).toHaveBeenCalledTimes(1)
        // E a schermo resta l'esito VERDE, non un rifiuto arrivato dopo.
        expect(screen.queryByRole('alert')).toBeNull()
        expect(await screen.findByRole('status')).toBeTruthy()
    })

    it('⚠️ un 200 con un corpo ILLEGGIBILE non manda ad assegnare una classe, e lascia una riga di log', async () => {
        // Era un `.catch(() => null)` muto in un file nuovo — AGENTS.md regola 6 —
        // e l'effetto si vedeva: il corpo mancante faceva cadere le frasi
        // sull'ultimo ramo, cioè «Assegna una classe dalla sua scheda» su un
        // bambino di cui non si sapeva niente, senza una riga di log.
        fetchMock.mockResolvedValue({
            ok: true, status: 200, headers: new Headers(),
            json: async () => { throw new SyntaxError('Unexpected token < in JSON') },
        })
        render(<AlunniArchiviatiView esito={esitoFinto({ righe: [ANNA], totale: 1 })} ruolo="admin" />)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: itAdminStudents.arcAzioneRiattiva }))
        })

        // Il rientro è riuscito (il server ha risposto 200) e lo si dice…
        const esito = await screen.findByRole('status')
        expect(esito.textContent).toContain('Bianchi Anna')
        // …ma non si inventa un gesto da fare sulla classe.
        expect(esito.textContent).not.toMatch(/Assegna una classe/i)
        expect(esito.textContent).not.toMatch(/non esiste più/i)
        // E il motivo NON si perde.
        expect(logClient).toHaveBeenCalledWith(
            expect.objectContaining({
                livello: 'error',
                messaggio: expect.stringContaining('alunno-riattivato-corpo-inatteso'),
            }),
        )
    })
})
