import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, renderHook, act, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import itAdminStudents from '../../messages/it/adminStudents.json'

expect.extend(toHaveNoViolations)

/**
 * «CODICI FISCALI DA VERIFICARE» — il pannello di /admin/students.
 *
 * ─── LA COSA CHE QUESTI TEST ESISTONO PER TENERE FERMA ───────────────────────
 * I TRE STATI DEVONO RESTARE TRE. Misurato in produzione l'11 agosto: 18 alunni
 * su 33 e 27 genitori su 50 non hanno il codice fiscale. Se «manca» scivolasse
 * dentro «sbagliato», il pannello aprirebbe con 45 righe rosse su 83 — per un
 * dato che nessuno ha mai inserito — e verrebbe ignorato entro la settimana.
 * Il test «un record senza codice non compare fra i rossi» è quello da non
 * cancellare mai.
 *
 * La seconda è la SCRITTURA: si applica un record alla volta, e prima si legge
 * per esteso che cosa si sta per scrivere e su chi. In questo progetto nessuno
 * chiede conferma prima che un `UPDATE` parta (CLAUDE.md, 2026-08-03): il
 * riepilogo è l'unica cosa che resta fra un errore e un minore.
 *
 * ─── PERCHÉ QUI next-intl È FINTO DA CAPO ────────────────────────────────────
 * Il mock globale (`test/setup.ts`) restituisce la stringa GREZZA: `t('cfRiepilogoSostituzione',
 * {…})` produrrebbe «Sto per scrivere {proposto}…», e il test più importante del
 * file — quello che verifica che il riepilogo NOMINI i due codici — sarebbe
 * verde su una frase che non contiene nessun codice. Qui i segnaposto vengono
 * sostituiti davvero, così l'asserzione guarda il testo che legge la segreteria.
 *
 * ⚠️ E si usa il FORMATTATORE ICU VERO (`use-intl`, la libreria che sta sotto
 * next-intl), non una `String.replace` sui `{segnaposto}`: il rimpiazzo a mano
 * non sa niente dei blocchi `plural`, quindi su «{n, plural, one {# incoerente}
 * other {# incoerenti}}» lascerebbe a schermo la sintassi ICU e il test sarebbe
 * verde su un testo che nessun utente leggerà mai. È la stessa ragione per cui
 * `__tests__/architecture/messaggi-plurali-e-glossario.test.ts` rende i messaggi
 * invece di ispezionarli.
 */

/* ── Codici FINTI. Il repository è pubblico: nessuno di questi è un codice
 *    fiscale valido, e non può esserlo — le posizioni 7-8 devono essere cifre e
 *    qui sono lettere, quindi nessuna checksum li rende accettabili. ────────── */
const CF_ATTUALE = 'CODICEFINTO00001'
const CF_ATTUALE_2 = 'CODICEFINTO00002'
const CF_PROPOSTO = 'CODICEPROPOSTO01'
/** La proposta CAMBIATA sotto il drawer aperto: vedi «si scrive la riga di ADESSO». */
const CF_PROPOSTO_2 = 'CODICEPROPOSTO02'

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

vi.mock('@/lib/context/sede-context', () => ({
    useSediAttive: () => ({
        sedi: [
            { id: SEDE_A, nome: NOME_SEDE_A },
            { id: SEDE_B, nome: NOME_SEDE_B },
        ],
        selezionate: [],
        effettive: [SEDE_A, SEDE_B],
        sedeCorrente: null,
        reFetchKey: `${SEDE_A},${SEDE_B}`,
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
    ASPETTO,
    CodiciFiscaliDaVerificare,
    contaAzionabili,
    ordinaPerAzionabilita,
    scrivibile,
    useCodiciFiscaliDaVerificare,
    type EsitoCodiciFiscali,
    type RigaCodiceFiscale,
    type StatoCodiceFiscale,
} from '@/components/features/admin/CodiciFiscaliDaVerificare'

/* ── Le righe di prova, una per stato ───────────────────────────────────────── */

/** ROSSO — c'è un codice e non torna: la data di nascita contraddice il codice. */
const INCOERENTE: RigaCodiceFiscale = {
    tipo: 'alunno',
    id: 'aaaa1111-0000-4000-8000-000000000001',
    nome: 'Anna',
    cognome: 'Bianchi',
    scuole_ids: [SEDE_A],
    stato: 'incoerente',
    codice_attuale: CF_ATTUALE,
    motivi: ['data-nascita'],
    non_verificabili: [],
    codice_proposto: CF_PROPOSTO,
    proposta_bloccata_da: null,
    proposta_combacia: false,
    priorita: 0,
}

/** GIALLO — il codice c'è e regge, ma manca il sesso per confrontarlo tutto. */
const NON_VERIFICABILE: RigaCodiceFiscale = {
    tipo: 'genitore',
    id: 'bbbb2222-0000-4000-8000-000000000002',
    nome: 'Luca',
    cognome: 'Verdi',
    scuole_ids: [SEDE_B],
    stato: 'non-verificabile',
    codice_attuale: CF_ATTUALE_2,
    motivi: [],
    non_verificabili: ['sesso', 'luogo-nascita'],
    codice_proposto: null,
    proposta_bloccata_da: 'luogo',
    proposta_combacia: false,
    priorita: 1,
}

/** NEUTRO — il codice non c'è. Non è un errore, e non deve diventarlo. */
const DA_COMPILARE: RigaCodiceFiscale = {
    tipo: 'alunno',
    id: 'cccc3333-0000-4000-8000-000000000003',
    nome: 'Sara',
    cognome: 'Costa',
    scuole_ids: [SEDE_A],
    stato: 'da-compilare',
    codice_attuale: null,
    motivi: [],
    non_verificabili: ['cognome', 'nome', 'data-nascita', 'sesso', 'luogo-nascita'],
    codice_proposto: null,
    proposta_bloccata_da: 'anagrafica',
    proposta_combacia: false,
    priorita: 2,
}

/**
 * NEUTRO, MA CON LA PROPOSTA PRONTA — e quindi con il comando di scrittura.
 *
 * Non è un caso di laboratorio: misurato in produzione l'11 agosto, in sola
 * lettura e a soli conteggi, **1 alunno su 29 e 1 genitore su 50** hanno nome,
 * cognome, data, sesso e comune di nascita e non hanno il codice fiscale. La
 * rotta li mette a `priorita: 0` («chi apre il pannello deve trovare in cima ciò
 * che può chiudere subito»), il pannello mostra per loro «Applica» e il riepilogo
 * `cfRiepilogoNuovo` — e fino all'11 agosto la pillola della linguetta NON li
 * contava.
 */
const DA_COMPILARE_CON_PROPOSTA: RigaCodiceFiscale = {
    tipo: 'genitore',
    id: 'eeee5555-0000-4000-8000-000000000005',
    nome: 'Nadia',
    cognome: 'Ferri',
    scuole_ids: [SEDE_A],
    stato: 'da-compilare',
    codice_attuale: null,
    motivi: [],
    non_verificabili: ['luogo-nascita'],
    codice_proposto: CF_PROPOSTO,
    proposta_bloccata_da: null,
    proposta_combacia: false,
    priorita: 0,
}

/**
 * GIALLO CON LA PROPOSTA DISCORDE — la scrittura più rischiosa del pannello.
 *
 * È il caso dei 22 genitori misurati in produzione l'11 agosto: il codice c'è, il
 * comune di nascita è scritto a mano e la colonna Belfiore è vuota, quindi il
 * confronto sul luogo NON è verificabile — e quasi sempre la proposta conferma il
 * codice (vedi `COMBACIA`, che resta fuori dal numero). Qui invece la proposta
 * DISCORDA: `scrivibile()` non guarda lo stato, perciò la riga in cui il sistema
 * dichiara di non poter verificare è anche quella su cui offre di sovrascrivere in
 * un gesto il codice fiscale registrato di una persona — e dall'11 agosto entra
 * anche nel numero della pillola.
 *
 * ⚠️ QUESTA FIXTURE ESISTE PERCHÉ QUELLA SCELTA SIA MISURATA E NON IMPLICITA.
 * Fino a qui nessun test la vedeva: ogni `non-verificabile` della suite aveva la
 * proposta assente o combaciante. I due test qui sotto tengono ferma la regola
 * DI OGGI; se il titolare decide di escludere il giallo dal conteggio, la riga
 * sola di `contaAzionabili` li fa diventare rossi — che è esattamente il punto:
 * il badge non può cambiare in silenzio.
 */
const NON_VERIFICABILE_DISCORDE: RigaCodiceFiscale = {
    tipo: 'genitore',
    id: 'ffff6666-0000-4000-8000-000000000006',
    nome: 'Iris',
    cognome: 'Rulli',
    scuole_ids: [SEDE_B],
    stato: 'non-verificabile',
    codice_attuale: CF_ATTUALE_2,
    motivi: [],
    non_verificabili: ['luogo-nascita'],
    codice_proposto: CF_PROPOSTO,
    proposta_bloccata_da: null,
    proposta_combacia: false,
    priorita: 0,
}

/** La forma più comune in produzione: codice giusto, proposta che COMBACIA. */
const COMBACIA: RigaCodiceFiscale = {
    tipo: 'alunno',
    id: 'dddd4444-0000-4000-8000-000000000004',
    nome: 'Elia',
    cognome: 'Adami',
    scuole_ids: [SEDE_A],
    stato: 'non-verificabile',
    codice_attuale: CF_PROPOSTO,
    motivi: [],
    non_verificabili: ['luogo-nascita'],
    codice_proposto: CF_PROPOSTO,
    proposta_bloccata_da: null,
    proposta_combacia: true,
    priorita: 0,
}

const ricarica = vi.fn()

function esitoPronto(righe: RigaCodiceFiscale[], extra: Partial<EsitoCodiciFiscali> = {}): EsitoCodiciFiscali {
    return {
        fase: 'pronto',
        righe,
        totale: righe.length,
        troncato: false,
        ricaricando: false,
        // La regola VERA, non una sua copia scritta a mano qui: se il conteggio
        // cambia, i test che asseriscono un numero devono diventare rossi — e
        // quello che tiene ferma la pillola sta in `__tests__/pages/`.
        azionabili: contaAzionabili(righe),
        riletturaFallita: false,
        errore: null,
        ricarica,
        ...extra,
    }
}

/** Lo stato «non ho ancora niente», nelle sue tre forme, senza ripeterne la forma. */
function esitoSenzaRighe(fase: 'caricamento' | 'errore', extra: Partial<EsitoCodiciFiscali> = {}): EsitoCodiciFiscali {
    return {
        fase,
        righe: [],
        totale: 0,
        troncato: false,
        ricaricando: false,
        azionabili: 0,
        riletturaFallita: false,
        errore: null,
        ricarica,
        ...extra,
    }
}

const fetchMock = vi.fn()

beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) })
    vi.stubGlobal('fetch', fetchMock)
})

/** I nominativi nell'ordine in cui stanno nel DOM. */
function nominativiInPagina(): string[] {
    return screen
        .getAllByRole('row')
        .slice(1) // la prima è l'intestazione
        .map((riga) => within(riga).getAllByRole('cell')[0].textContent?.trim() ?? '')
}

// ═════════════════════════════════════════════════════════════════════════════
describe('CodiciFiscaliDaVerificare · i tre stati restano tre', () => {
    it('elenca i tre stati, ognuno con la sua PAROLA (non solo col colore)', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE, NON_VERIFICABILE, DA_COMPILARE])} />)

        // Le tre etichette convivono nella stessa tabella: è la prova che gli
        // stati non collassano l'uno nell'altro.
        expect(screen.getAllByText('Incoerente').length).toBeGreaterThan(0)
        expect(screen.getAllByText('Non verificabile').length).toBeGreaterThan(0)
        expect(screen.getAllByText('Da compilare').length).toBeGreaterThan(0)

        // …e ognuna è TESTO, non un pallino colorato: la si legge anche senza
        // distinguere il rosso dal giallo.
        for (const parola of ['Incoerente', 'Non verificabile', 'Da compilare']) {
            expect(screen.getAllByText(parola)[0].textContent).toBe(parola)
        }
    })

    it('⚠️ un record SENZA codice non compare fra i rossi', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE, DA_COMPILARE])} />)

        // Controllo positivo: prima del filtro ci sono tutti e due.
        expect(screen.getByText('Bianchi Anna')).toBeInTheDocument()
        expect(screen.getByText('Costa Sara')).toBeInTheDocument()

        fireEvent.change(screen.getByLabelText('Stato'), { target: { value: 'incoerente' } })

        expect(screen.getByText('Bianchi Anna')).toBeInTheDocument()
        // ⟵ IL PUNTO: «da compilare» non è «sbagliato».
        expect(screen.queryByText('Costa Sara')).not.toBeInTheDocument()
    })

    it('e chi è solo «non verificabile» non finisce fra i rossi nemmeno lui', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE, NON_VERIFICABILE])} />)
        fireEvent.change(screen.getByLabelText('Stato'), { target: { value: 'incoerente' } })
        expect(screen.queryByText('Verdi Luca')).not.toBeInTheDocument()
        expect(screen.getByText('Bianchi Anna')).toBeInTheDocument()
    })

    it('il filtro «Da compilare» tiene fuori chi un codice ce l’ha', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE, NON_VERIFICABILE, DA_COMPILARE])} />)
        fireEvent.change(screen.getByLabelText('Stato'), { target: { value: 'da-compilare' } })
        expect(nominativiInPagina()).toEqual(['Costa Sara'])
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('CodiciFiscaliDaVerificare · ordine per azionabilità', () => {
    it('in cima chi si chiude in un gesto, poi il luogo di nascita, poi il resto', () => {
        // Entrano in ordine INVERSO di priorità: se il pannello non riordinasse,
        // uscirebbero così come sono entrati.
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([DA_COMPILARE, NON_VERIFICABILE, INCOERENTE])} />)
        expect(nominativiInPagina()).toEqual(['Bianchi Anna', 'Verdi Luca', 'Costa Sara'])
    })

    it('a parità di priorità l’ordine è quello alfabetico, ed è stabile', () => {
        const secondo: RigaCodiceFiscale = { ...INCOERENTE, id: 'zzzz', cognome: 'Abbate', nome: 'Rita' }
        expect(ordinaPerAzionabilita([INCOERENTE, secondo]).map((r) => r.cognome)).toEqual(['Abbate', 'Bianchi'])
        expect(ordinaPerAzionabilita([secondo, INCOERENTE]).map((r) => r.cognome)).toEqual(['Abbate', 'Bianchi'])
    })

    it('non modifica l’elenco che riceve (nessun `sort` sul posto)', () => {
        const originale = [DA_COMPILARE, INCOERENTE]
        ordinaPerAzionabilita(originale)
        expect(originale.map((r) => r.id)).toEqual([DA_COMPILARE.id, INCOERENTE.id])
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('CodiciFiscaliDaVerificare · filtri e ricerca', () => {
    it('il filtro per TIPO separa alunni e genitori', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE, NON_VERIFICABILE])} />)

        fireEvent.change(screen.getByLabelText('Tipo'), { target: { value: 'genitori' } })
        expect(nominativiInPagina()).toEqual(['Verdi Luca'])

        fireEvent.change(screen.getByLabelText('Tipo'), { target: { value: 'alunni' } })
        expect(nominativiInPagina()).toEqual(['Bianchi Anna'])
    })

    it('la ricerca lavora sul NOME…', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE, NON_VERIFICABILE, DA_COMPILARE])} />)
        fireEvent.change(screen.getByLabelText('Cerca fra i codici fiscali da verificare'), {
            target: { value: 'verdi' },
        })
        expect(nominativiInPagina()).toEqual(['Verdi Luca'])
    })

    it('…e sul CODICE, che è il modo in cui una segretaria arriva da un documento', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE, NON_VERIFICABILE, DA_COMPILARE])} />)
        fireEvent.change(screen.getByLabelText('Cerca fra i codici fiscali da verificare'), {
            target: { value: CF_ATTUALE_2.toLowerCase() },
        })
        expect(nominativiInPagina()).toEqual(['Verdi Luca'])
    })

    it('«nessuno con questi filtri» NON è «nessun codice da verificare»', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE])} />)
        fireEvent.change(screen.getByLabelText('Cerca fra i codici fiscali da verificare'), {
            target: { value: 'nessuno-che-esista' },
        })
        expect(screen.getByText('Nessuno con questi filtri')).toBeInTheDocument()
        // La buona notizia si dà solo quando è vera.
        expect(screen.queryByText('Nessun codice fiscale da verificare')).not.toBeInTheDocument()
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('CodiciFiscaliDaVerificare · la correzione, un record alla volta', () => {
    const apriDettaglio = (nominativo: string) => {
        const riga = screen.getByText(nominativo).closest('tr') as HTMLElement
        fireEvent.click(within(riga).getByRole('button', { name: 'Apri' }))
    }

    it('il riepilogo PRECEDE la scrittura e nomina i due codici, il tipo e la struttura', async () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE])} />)
        apriDettaglio('Bianchi Anna')

        fireEvent.click(screen.getByRole('button', { name: 'Applica il codice proposto' }))

        const riepilogo = await screen.findByText(/Sto per scrivere/)
        expect(riepilogo.textContent).toContain(CF_PROPOSTO)
        expect(riepilogo.textContent).toContain(CF_ATTUALE)
        expect(riepilogo.textContent).toContain('1 record')
        expect(riepilogo.textContent).toContain('Alunno')
        expect(riepilogo.textContent).toContain(NOME_SEDE_A)

        // ⟵ E FINO A QUI NON È PARTITO NIENTE: il riepilogo non è un annuncio
        //    fatto dopo, è una condizione.
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('solo dopo la conferma parte la PATCH, su UN id e col campo dell’alunno', async () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE])} />)
        apriDettaglio('Bianchi Anna')
        fireEvent.click(screen.getByRole('button', { name: 'Applica il codice proposto' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Conferma la scrittura' }))

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        const [url, opzioni] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(url).toBe('/api/admin/students')
        expect(opzioni.method).toBe('PATCH')
        expect(JSON.parse(String(opzioni.body))).toEqual({
            id: INCOERENTE.id,
            codice_fiscale: CF_PROPOSTO,
        })
        // L'elenco si rilegge: la riga appena chiusa non deve restare a schermo.
        await waitFor(() => expect(ricarica).toHaveBeenCalledTimes(1))
    })

    it('per un genitore il campo è `fiscal_code`, e la rotta è quella dei genitori', async () => {
        const genitoreCorreggibile: RigaCodiceFiscale = {
            ...NON_VERIFICABILE,
            stato: 'incoerente',
            motivi: ['cognome'],
            codice_proposto: CF_PROPOSTO,
            proposta_bloccata_da: null,
            priorita: 0,
        }
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([genitoreCorreggibile])} />)
        apriDettaglio('Verdi Luca')
        fireEvent.click(screen.getByRole('button', { name: 'Applica il codice proposto' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Conferma la scrittura' }))

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        const [url, opzioni] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(url).toBe('/api/admin/parents')
        expect(JSON.parse(String(opzioni.body))).toEqual({
            id: genitoreCorreggibile.id,
            fiscal_code: CF_PROPOSTO,
        })
    })

    it('«Annulla» riporta indietro senza scrivere niente', async () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE])} />)
        apriDettaglio('Bianchi Anna')
        fireEvent.click(screen.getByRole('button', { name: 'Applica il codice proposto' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Annulla' }))

        expect(screen.queryByText(/Sto per scrivere/)).not.toBeInTheDocument()
        expect(fetchMock).not.toHaveBeenCalled()
        expect(screen.getByRole('button', { name: 'Applica il codice proposto' })).toBeInTheDocument()
    })

    it('un rifiuto del server si vede in pagina, con `role="alert"`, e si logga', async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 403,
            json: async () => ({ error: 'Sede non accessibile' }),
            text: async () => JSON.stringify({ error: 'Sede non accessibile' }),
        })
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE])} />)
        apriDettaglio('Bianchi Anna')
        fireEvent.click(screen.getByRole('button', { name: 'Applica il codice proposto' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Conferma la scrittura' }))

        const avviso = await screen.findByRole('alert')
        // Il MOTIVO del server, non un «errore» generico: è la differenza fra
        // «riprova» e «non hai i permessi su questa struttura».
        expect(avviso.textContent).toContain('Sede non accessibile')
        expect(ricarica).not.toHaveBeenCalled()
        await waitFor(() =>
            expect(logClient).toHaveBeenCalledWith(
                expect.objectContaining({ livello: 'error', stato: 403 }),
            ),
        )
    })

    it('quando la proposta COMBACIA non c’è niente da riscrivere: nessun comando di scrittura', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([COMBACIA])} />)
        const riga = screen.getByText('Adami Elia').closest('tr') as HTMLElement
        fireEvent.click(within(riga).getByRole('button', { name: 'Apri' }))

        expect(screen.queryByRole('button', { name: 'Applica il codice proposto' })).not.toBeInTheDocument()
        // …ma la strada per chiudere la riga c'è, ed è la scheda.
        expect(screen.getByRole('button', { name: 'Apri la scheda' })).toBeInTheDocument()
    })

    it('«Apri la scheda» porta alla scheda giusta per tipo', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([NON_VERIFICABILE])} userId="utente-1" />)
        const riga = screen.getByText('Verdi Luca').closest('tr') as HTMLElement
        fireEvent.click(within(riga).getByRole('button', { name: 'Apri' }))
        fireEvent.click(screen.getByRole('button', { name: 'Apri la scheda' }))

        expect(push).toHaveBeenCalledWith(`/admin/students/${NON_VERIFICABILE.id}?kind=adult&userId=utente-1`)
    })

    it('⚠️ si scrive la riga di ADESSO: se la proposta cambia sotto il drawer, la PATCH porta quella nuova', async () => {
        // ─── PERCHÉ QUESTO TEST ESISTE ───────────────────────────────────────
        // `applica()` legge `sceltaAttiva` — la riga RILETTA dall'elenco — e non
        // `selezionata`, che è la copia di quando il drawer è stato aperto. La
        // differenza non era coperta da nessuna prova: sostituendo la sola riga
        // della SCRITTURA (`const r = sceltaAttiva` → `const r = selezionata`)
        // l'intera suite restava verde, perché tutti gli altri test guardano il
        // RENDER — e il render legge `sceltaAttiva` da un'altra parte.
        //
        // Il drawer resta aperto per scelta («lo chiude chi lo chiude, non una
        // rilettura»), e sotto di lui l'elenco può cambiare davvero:
        // `esito.ricarica()` e il cambio di `reFetchKey` (sedi attive) rileggono
        // le righe. Nella regressione il riepilogo mostrerebbe il codice NUOVO
        // e la PATCH manderebbe quello VECCHIO: un codice fiscale sbagliato
        // scritto su un minore, con la schermata che dice il contrario, e in un
        // progetto dove nessun essere umano vede la scrittura prima che parta.
        const PRIMA: RigaCodiceFiscale = { ...INCOERENTE, codice_proposto: CF_PROPOSTO }
        const DOPO: RigaCodiceFiscale = { ...INCOERENTE, codice_proposto: CF_PROPOSTO_2 }

        const { rerender } = render(<CodiciFiscaliDaVerificare esito={esitoPronto([PRIMA])} />)
        apriDettaglio('Bianchi Anna')
        fireEvent.click(screen.getByRole('button', { name: 'Applica il codice proposto' }))
        // Il riepilogo di partenza nomina la proposta VECCHIA.
        expect((await screen.findByText(/Sto per scrivere/)).textContent).toContain(CF_PROPOSTO)

        // …e ora l'elenco cambia sotto: stessa persona (stesso `tipo` e stesso
        // `id`), proposta diversa. Il drawer non si chiude e la conferma resta.
        rerender(<CodiciFiscaliDaVerificare esito={esitoPronto([DOPO])} />)

        // Il riepilogo si è riletto: a schermo c'è la proposta NUOVA.
        const riepilogo = screen.getByText(/Sto per scrivere/)
        expect(riepilogo.textContent).toContain(CF_PROPOSTO_2)
        expect(riepilogo.textContent).not.toContain(CF_PROPOSTO)

        fireEvent.click(screen.getByRole('button', { name: 'Conferma la scrittura' }))

        // ⟵ IL PUNTO: la PATCH manda ciò che il riepilogo ha appena promesso.
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        const [, opzioni] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(JSON.parse(String(opzioni.body))).toEqual({
            id: INCOERENTE.id,
            codice_fiscale: CF_PROPOSTO_2,
        })
    })

    /**
     * ⚠️ I TESTI SI LEGGONO DAL CATALOGO, non si ricopiano — come già fanno
     * `StudentDetailPanel-codice-fiscale.test.tsx`,
     * `ScrollableStudentForm-codice-fiscale.test.tsx` e
     * `StudentRegistryForm-codice-fiscale.test.tsx`. Qui la frase era scritta a
     * mano («il comune di nascita») e diceva il dato SBAGLIATO: a rendere una
     * riga non verificabile non è il comune — che può essere scritto benissimo —
     * ma il CODICE CATASTALE, cioè la colonna `codice_belfiore_nascita`.
     * La misura sta nella route, `src/app/api/admin/anagrafiche/codici-fiscali/route.ts:268`:
     * a `verificaCoerenza` si passa `normalizzaCodiceBelfiore(persona.belfioreColonna)`,
     * e `src/lib/fiscale/coerenza.ts:222` mette `luogo-nascita` fra i
     * `nonVerificabili` esattamente quando quel Belfiore è `null` — mai
     * guardando `birth_city`. In produzione (11 agosto) la colonna è NULL su
     * tutte e 83 le righe, quindi è la voce che la segreteria legge più spesso:
     * mandarla a controllare un campo già pieno le fa concludere che sbaglia il
     * pannello. Asserire sulla CHIAVE tiene fermo il significato e lascia libera
     * la formulazione — un apostrofo cambiato non deve fare rosso un prodotto sano.
     */
    it('il dettaglio dice PERCHÉ, in chiaro, e che cosa manca per confrontare', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([NON_VERIFICABILE])} />)
        const riga = screen.getByText('Verdi Luca').closest('tr') as HTMLElement
        fireEvent.click(within(riga).getByRole('button', { name: 'Apri' }))

        const dialogo = screen.getByRole('dialog')
        expect(within(dialogo).getByText(itAdminStudents.cfMancaSesso)).toBeInTheDocument()
        expect(within(dialogo).getByText(itAdminStudents.cfMancaLuogoNascita)).toBeInTheDocument()
        expect(within(dialogo).getByText(itAdminStudents.cfDettaglioBloccoLuogo)).toBeInTheDocument()
    })

    it('la voce che manca nomina il CODICE CATASTALE, non il solo comune', () => {
        // Il difetto per cui la prova esiste: la riga qui sotto ha `birth_city`
        // pieno e la colonna Belfiore vuota (la forma più comune in produzione).
        // Se il testo dicesse solo «il comune di nascita», chi legge andrebbe a
        // controllare un campo che è già compilato. Si asserisce sul SENSO —
        // il codice catastale è nominato — non sulla frase intera.
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([NON_VERIFICABILE])} />)
        const riga = screen.getByText('Verdi Luca').closest('tr') as HTMLElement
        fireEvent.click(within(riga).getByRole('button', { name: 'Apri' }))

        expect(itAdminStudents.cfMancaLuogoNascita).toMatch(/codice catastale/i)
        expect(within(screen.getByRole('dialog')).getByText(/codice catastale/i)).toBeInTheDocument()
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('CodiciFiscaliDaVerificare · NESSUN comando di massa', () => {
    it('non esiste nessun comando che scriva su più di un record', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE, NON_VERIFICABILE, DA_COMPILARE, COMBACIA])} />)

        for (const bottone of screen.getAllByRole('button')) {
            const nome = (bottone.textContent ?? '').toLowerCase()
            expect(nome).not.toMatch(/a tutt|tutte le righe|in blocco|massa|massiv|seleziona/)
        }
        // Nessuna casella di selezione: senza selezione multipla non c'è nemmeno
        // il gesto da cui nascerebbe un «applica ai selezionati».
        expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    })

    it('anche col dettaglio aperto, il comando di scrittura è UNO e nomina UN record', async () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE, COMBACIA])} />)
        const riga = screen.getByText('Bianchi Anna').closest('tr') as HTMLElement
        fireEvent.click(within(riga).getByRole('button', { name: 'Apri' }))
        fireEvent.click(screen.getByRole('button', { name: 'Applica il codice proposto' }))

        expect(screen.getAllByRole('button', { name: 'Conferma la scrittura' })).toHaveLength(1)
        expect((await screen.findByText(/Sto per scrivere/)).textContent).toContain('1 record')
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('CodiciFiscaliDaVerificare · gli stati della schermata', () => {
    it('caricamento: uno stato dichiarato, non una tabella vuota', () => {
        render(
            <CodiciFiscaliDaVerificare
                esito={esitoSenzaRighe('caricamento')}
            />,
        )
        expect(screen.getByRole('status').textContent).toContain('Verifica dei codici fiscali in corso')
        expect(screen.queryByRole('table')).not.toBeInTheDocument()
    })

    it('elenco vuoto: è una BUONA notizia, e si scrive come tale', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([])} />)
        expect(screen.getByText('Nessun codice fiscale da verificare')).toBeInTheDocument()
        expect(screen.getByText(/È una buona notizia/)).toBeInTheDocument()
        // Non è un errore: niente `role="alert"`.
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('errore della fetch: fascia d’allarme e «Riprova» che ritenta davvero', () => {
        render(
            <CodiciFiscaliDaVerificare
                esito={esitoSenzaRighe('errore')}
            />,
        )
        const avviso = screen.getByRole('alert')
        expect(within(avviso).getByText('Verifica non riuscita')).toBeInTheDocument()
        // «Non ho potuto leggere» ≠ «non c'è nessuno».
        expect(screen.queryByText('Nessun codice fiscale da verificare')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /Riprova/ }))
        expect(ricarica).toHaveBeenCalledTimes(1)
    })

    it('quando il server ha risposto un motivo, è QUELLO a comparire', () => {
        render(
            <CodiciFiscaliDaVerificare
                esito={esitoSenzaRighe('errore', { errore: 'Sede non accessibile' })}
            />,
        )
        expect(screen.getByText('Sede non accessibile')).toBeInTheDocument()
    })

    it('scansione TRONCATA: l’elenco incompleto lo dice, invece di sembrare completo', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE], { troncato: true })} />)
        expect(screen.getByText(/la scansione si è fermata al proprio tetto/i)).toBeInTheDocument()
    })

    it('senza troncamento l’avviso non c’è (altrimenti non direbbe niente)', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE])} />)
        expect(screen.queryByText(/la scansione si è fermata/i)).not.toBeInTheDocument()
        expect(screen.queryByText(/solo una parte di ciò che è stato trovato/i)).not.toBeInTheDocument()
    })

    it('pagina PARZIALE: il server ne ha trovate più di quante ne ha mandate, e si dice', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE], { totale: 900 })} />)
        expect(screen.getByText(/solo una parte di ciò che è stato trovato/i)).toBeInTheDocument()
    })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('CodiciFiscaliDaVerificare · accessibilità', () => {
    it('nessuna violazione axe sull’elenco', async () => {
        const { container } = render(
            <CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE, NON_VERIFICABILE, DA_COMPILARE])} />,
        )
        expect(await axe(container)).toHaveNoViolations()
    })

    it('nessuna violazione axe col dettaglio aperto e il riepilogo a schermo', async () => {
        const { container } = render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE])} />)
        const riga = screen.getByText('Bianchi Anna').closest('tr') as HTMLElement
        fireEvent.click(within(riga).getByRole('button', { name: 'Apri' }))
        fireEvent.click(screen.getByRole('button', { name: 'Applica il codice proposto' }))
        await screen.findByText(/Sto per scrivere/)
        expect(await axe(container)).toHaveNoViolations()
    })

    it('nessuna violazione axe sui tre stati «senza righe» (vuoto, filtri, errore)', async () => {
        const vuoto = render(<CodiciFiscaliDaVerificare esito={esitoPronto([])} />)
        expect(await axe(vuoto.container)).toHaveNoViolations()
        vuoto.unmount()

        const errore = render(
            <CodiciFiscaliDaVerificare
                esito={esitoSenzaRighe('errore')}
            />,
        )
        expect(await axe(errore.container)).toHaveNoViolations()
    })

    it('ogni riga porta un COMANDO vero: un `<button>`, quindi un tab stop', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE, NON_VERIFICABILE])} />)

        for (const nominativo of ['Bianchi Anna', 'Verdi Luca']) {
            const riga = screen.getByText(nominativo).closest('tr') as HTMLElement
            const comando = within(riga).getByRole('button', { name: 'Apri' })
            expect(comando.tagName).toBe('BUTTON')
            // Un `<button>` senza `disabled` è raggiungibile con Tab e si attiva
            // con Invio e Spazio: è il browser a garantirlo, e questo test
            // verifica che il comando sia davvero un bottone e non un `<div>`.
            expect(comando).not.toBeDisabled()
            comando.focus()
            expect(document.activeElement).toBe(comando)
        }
    })

    it('la riga NON è un bottone: il comando sta dentro, non addosso a lei', () => {
        // Un `<tr role="button">` prende come nome accessibile tutto il proprio
        // contenuto e inghiotte i controlli che ci vivono dentro (lock
        // `righe-tabella-con-comando`).
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE])} />)
        const riga = screen.getByText('Bianchi Anna').closest('tr') as HTMLElement
        expect(riga.getAttribute('role')).toBeNull()
        expect(riga.getAttribute('tabindex')).toBeNull()
    })

    it('da tastiera si apre lo STESSO dettaglio che apre il mouse', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE])} />)
        const riga = screen.getByText('Bianchi Anna').closest('tr') as HTMLElement
        const comando = within(riga).getByRole('button', { name: 'Apri' })
        comando.focus()
        // L'attivazione di un `<button>` a fuoco (Invio/Spazio) arriva come click.
        fireEvent.click(document.activeElement as HTMLElement)
        expect(screen.getByRole('dialog', { name: /codice fiscale/i })).toBeInTheDocument()
    })

    it('il dialogo ha un NOME, e il nominativo del minore non è quel nome', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE])} />)
        const riga = screen.getByText('Bianchi Anna').closest('tr') as HTMLElement
        fireEvent.click(within(riga).getByRole('button', { name: 'Apri' }))
        const dialogo = screen.getByRole('dialog', { name: 'Codice fiscale' })
        expect(dialogo).toBeInTheDocument()
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// L'APPARENZA DEI TRE STATI — non la sola parola.
//
// Il collaudo del 2026-08-11 ha eseguito la mutazione: mettere in `ASPETTO`
// `bg-kidville-error-soft text-kidville-error-strong` su `da-compilare` — cioè
// dipingere di rosso i 45 record che nessuno ha mai compilato — lasciava la
// suite verde su 35 test su 35. La parola era protetta, il colore no: e il
// colore è ciò che decide se il pannello viene guardato o ignorato.
// ═════════════════════════════════════════════════════════════════════════════
describe('CodiciFiscaliDaVerificare · i tre stati non si somigliano', () => {
    /** La pillola di stato dentro la riga di quel nominativo, con le sue classi. */
    const pillola = (nominativo: string): HTMLElement => {
        const riga = screen.getByText(nominativo).closest('tr') as HTMLElement
        return within(riga).getAllByRole('cell')[2].firstElementChild as HTMLElement
    }

    it('«da compilare» non porta NESSUNA tinta della famiglia error-*', () => {
        // Sul dato: `error` è la tinta dell'azionabile, e «non compilato» non lo è.
        expect(ASPETTO['da-compilare'].classi).not.toMatch(/error/)
        // …e in pagina, che è dove la persona lo vede.
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE, NON_VERIFICABILE, DA_COMPILARE])} />)
        expect(pillola('Costa Sara').className).not.toMatch(/error/)
        // Controllo positivo: la tinta error ESISTE in questa schermata, ed è
        // dell'incoerente. Senza, il test sopra sarebbe verde su una pagina
        // senza colori.
        expect(pillola('Bianchi Anna').className).toMatch(/kidville-error/)
    })

    it('«non verificabile» non è rosso e non è neutro: è la sua tinta', () => {
        expect(ASPETTO['non-verificabile'].classi).not.toMatch(/error/)
        expect(ASPETTO['non-verificabile'].classi).toMatch(/warn/)
    })

    it('le tre coppie di token sono TRE, distinte, e ognuna con la sua icona', () => {
        const stati: StatoCodiceFiscale[] = ['incoerente', 'non-verificabile', 'da-compilare']
        const coppie = stati.map((s) => ASPETTO[s].classi)
        expect(new Set(coppie).size).toBe(3)
        expect(new Set(stati.map((s) => ASPETTO[s].icona)).size).toBe(3)
        expect(new Set(stati.map((s) => ASPETTO[s].chiave)).size).toBe(3)
    })

    it('…e restano tre anche renderizzate, sulla stessa tabella', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE, NON_VERIFICABILE, DA_COMPILARE])} />)
        const classi = ['Bianchi Anna', 'Verdi Luca', 'Costa Sara'].map((n) => pillola(n).className)
        expect(new Set(classi).size).toBe(3)
    })

    it('nessun colore LETTERALE: solo token `kidville-*` (l’Alto Contrasto li rimappa)', () => {
        for (const stato of Object.keys(ASPETTO) as StatoCodiceFiscale[]) {
            for (const classe of ASPETTO[stato].classi.split(/\s+/)) {
                expect(classe, `${stato} → ${classe}`).toMatch(/^(bg|text)-kidville-/)
                expect(classe).not.toMatch(/#|\[/)
            }
        }
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// L'HOOK — cioè la RETE, che i 35 test presentazionali non toccavano mai.
//
// Prova del buco (collaudo del 2026-08-11): invertire il default di `carica()`
// da `errore` a `pronto` — la riga che il commento dichiara load-bearing —
// lasciava 219 test verdi. Qui il default è collaudato ramo per ramo.
// ═════════════════════════════════════════════════════════════════════════════
describe('useCodiciFiscaliDaVerificare · i rami della rete', () => {
    /** Una risposta 200 con il corpo dichiarato. */
    const rispostaOk = (corpo: unknown) => ({ ok: true, status: 200, json: async () => corpo })

    const montaHook = () => renderHook(() => useCodiciFiscaliDaVerificare())

    it('la fetch non arriva mai (rete giù): `errore`, e il motivo si LOGGA', async () => {
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
        const { result } = montaHook()

        await waitFor(() => expect(result.current.fase).toBe('errore'))
        expect(result.current.righe).toEqual([])
        // Nessun log del server vedrà mai questo caso: se non si logga qui, non esiste.
        expect(logClient).toHaveBeenCalledWith(
            expect.objectContaining({
                livello: 'error',
                messaggio: expect.stringContaining('codici-fiscali-non-caricati'),
            }),
        )
    })

    it('4xx: `errore`, e il MOTIVO è quello detto dal server', async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 403,
            json: async () => ({ error: 'Sede non accessibile' }),
        })
        const { result } = montaHook()

        await waitFor(() => expect(result.current.fase).toBe('errore'))
        expect(result.current.errore).toBe('Sede non accessibile')
        expect(logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', stato: 403 }))
    })

    it('200 con un corpo che NON è un elenco: è un guasto, non «non c’è nessuno»', async () => {
        fetchMock.mockResolvedValue(rispostaOk({ success: true }))
        const { result } = montaHook()

        await waitFor(() => expect(result.current.fase).toBe('errore'))
        // ⟵ IL PUNTO: `pronto` con `righe: []` mostrerebbe il cartello VERDE.
        expect(result.current.righe).toEqual([])
        expect(logClient).toHaveBeenCalledWith(
            expect.objectContaining({ messaggio: expect.stringContaining('codici-fiscali-corpo-inatteso') }),
        )
    })

    it('json illeggibile: stessa strada, e il nome dell’errore finisce nel log', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => {
                throw new SyntaxError('Unexpected token')
            },
        })
        const { result } = montaHook()

        await waitFor(() => expect(result.current.fase).toBe('errore'))
        expect(logClient).toHaveBeenCalledWith(
            expect.objectContaining({ messaggio: expect.stringContaining('SyntaxError') }),
        )
    })

    it('⚠️ righe di forma INATTESA: guasto, non «buona notizia»', async () => {
        // L'array c'è, ma nessuna riga è leggibile: basta che la rotta rinomini
        // `stato` o `tipo`. Senza questa guardia si otterrebbe `righe: []` con
        // `totale: 83` e `fase: 'pronto'` — cioè il cartello verde «Nessun codice
        // fiscale da verificare» accanto alla fascia gialla «parziale».
        fetchMock.mockResolvedValue(
            rispostaOk({ righe: [{ id: 'x', kind: 'alunno', status: 'incoerente' }], totale: 83, troncato: false }),
        )
        const { result } = montaHook()

        await waitFor(() => expect(result.current.fase).toBe('errore'))
        expect(result.current.righe).toEqual([])
        expect(result.current.totale).toBe(0)
        expect(logClient).toHaveBeenCalledWith(
            expect.objectContaining({
                livello: 'error',
                messaggio: expect.stringContaining('codici-fiscali-righe-illeggibili: 1 scartate su 1'),
            }),
        )
    })

    it('anche UNA sola riga persa su tre è un guasto: «meno bambini in una lista»', async () => {
        fetchMock.mockResolvedValue(
            rispostaOk({ righe: [INCOERENTE, NON_VERIFICABILE, { id: 'x' }], totale: 3, troncato: false }),
        )
        const { result } = montaHook()

        await waitFor(() => expect(result.current.fase).toBe('errore'))
        expect(logClient).toHaveBeenCalledWith(
            expect.objectContaining({ messaggio: expect.stringContaining('1 scartate su 3') }),
        )
    })

    it('200 con un elenco vero: `pronto`, `totale`, `troncato` e `azionabili`', async () => {
        fetchMock.mockResolvedValue(
            rispostaOk({
                righe: [INCOERENTE, NON_VERIFICABILE, DA_COMPILARE, DA_COMPILARE_CON_PROPOSTA],
                totale: 83,
                troncato: true,
            }),
        )
        const { result } = montaHook()

        await waitFor(() => expect(result.current.fase).toBe('pronto'))
        expect(result.current.righe.map((r) => r.id)).toEqual([
            INCOERENTE.id, NON_VERIFICABILE.id, DA_COMPILARE.id, DA_COMPILARE_CON_PROPOSTA.id,
        ])
        expect(result.current.totale).toBe(83)
        expect(result.current.troncato).toBe(true)
        // Il numero della pillola: l'azionabile, non gli 83 dei tre stati sommati
        // — e nemmeno il solo rosso, che qui sarebbe 1 e lascerebbe fuori la riga
        // su cui il pannello offre «Applica».
        expect(result.current.azionabili).toBe(2)
        expect(result.current.errore).toBeNull()
    })

    it('la rotta interrogata è quella, col tetto che `zPaginazione` accetta', async () => {
        fetchMock.mockResolvedValue(rispostaOk({ righe: [], totale: 0, troncato: false }))
        montaHook()
        await waitFor(() => expect(fetchMock).toHaveBeenCalled())
        expect(String(fetchMock.mock.calls[0][0])).toBe('/api/admin/anagrafiche/codici-fiscali?limit=200')
    })

    it('`ricarica()` rifà davvero la chiamata, e NON riazzera l’elenco a schermo', async () => {
        fetchMock.mockResolvedValue(rispostaOk({ righe: [INCOERENTE], totale: 1, troncato: false }))
        const { result } = montaHook()
        await waitFor(() => expect(result.current.fase).toBe('pronto'))

        act(() => result.current.ricarica())
        // ⟵ IL PUNTO: la fase NON torna a `caricamento`, altrimenti il pannello
        //    si smonterebbe sotto le dita di chi ha appena scritto.
        expect(result.current.fase).toBe('pronto')
        expect(result.current.ricaricando).toBe(true)

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
        await waitFor(() => expect(result.current.ricaricando).toBe(false))
    })

    it('«Riprova» dopo un errore invece lo spinner lo accende: lì non c’è niente da conservare', async () => {
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
        const { result } = montaHook()
        await waitFor(() => expect(result.current.fase).toBe('errore'))

        act(() => result.current.ricarica())
        expect(result.current.fase).toBe('caricamento')
    })

    it('⚠️ la risposta VECCHIA non vince su quella nuova', async () => {
        // Due fetch in volo (cambio sedi, o «Riprova» premuto due volte): la
        // prima può atterrare per ultima. Qui la si fa atterrare per ultima
        // apposta, e non deve sovrascrivere niente — nemmeno il conteggio che
        // vive sulla pillola anche fuori da questa linguetta.
        const risolvi: Array<(v: unknown) => void> = []
        fetchMock.mockImplementation(() => new Promise((res) => { risolvi.push(res) }))
        const { result } = montaHook()
        await waitFor(() => expect(risolvi).toHaveLength(1))

        act(() => result.current.ricarica())
        await waitFor(() => expect(risolvi).toHaveLength(2))

        const corpo = (righe: RigaCodiceFiscale[], totale: number) => ({
            ok: true, status: 200, json: async () => ({ righe, totale, troncato: false }),
        })
        // La NUOVA risponde per prima…
        await act(async () => { risolvi[1](corpo([NON_VERIFICABILE], 1)) })
        // …e la VECCHIA arriva dopo, con un elenco diverso.
        await act(async () => { risolvi[0](corpo([INCOERENTE, DA_COMPILARE], 99)) })

        expect(result.current.righe.map((r) => r.id)).toEqual([NON_VERIFICABILE.id])
        expect(result.current.totale).toBe(1)
        expect(result.current.azionabili).toBe(0)
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// LA SCRITTURA, COLLAUDATA CONTRO L'HOOK VERO.
//
// Nei 35 test precedenti `esito` era un oggetto immobile passato a mano e
// `ricarica` un `vi.fn()` inerte: qualunque cosa succedesse ALLA RILETTURA era
// invisibile. Qui il pannello riceve l'esito dell'hook vero, e la rilettura
// avviene davvero — che è l'unico modo di vedere il difetto misurato l'11
// agosto: il pannello si smontava sotto le dita, portandosi via l'esito della
// scrittura e il fuoco.
// ═════════════════════════════════════════════════════════════════════════════
describe('CodiciFiscaliDaVerificare · dopo la scrittura, con l’hook vero', () => {
    function PannelloVero() {
        const esito = useCodiciFiscaliDaVerificare()
        return <CodiciFiscaliDaVerificare esito={esito} />
    }

    /** GET dell'elenco (prima una riga, poi nessuna) + PATCH della scrittura. */
    function armaLaRete(opzioni: { patch?: () => Promise<unknown> } = {}) {
        let letture = 0
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'PATCH') {
                return opzioni.patch
                    ? opzioni.patch()
                    : Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) })
            }
            letture += 1
            const righe = letture === 1 ? [INCOERENTE] : []
            return Promise.resolve({
                ok: true, status: 200,
                json: async () => ({ righe, totale: righe.length, troncato: false }),
            })
        })
        return { letture: () => letture }
    }

    const scriviIlCodice = async () => {
        const riga = screen.getByText('Bianchi Anna').closest('tr') as HTMLElement
        fireEvent.click(within(riga).getByRole('button', { name: 'Apri' }))
        fireEvent.click(screen.getByRole('button', { name: 'Applica il codice proposto' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Conferma la scrittura' }))
    }

    it('⚠️ l’esito della scrittura resta LEGGIBILE: il pannello non si smonta', async () => {
        armaLaRete()
        render(<PannelloVero />)
        await screen.findByText('Bianchi Anna')
        await scriviIlCodice()

        // L'esito è a schermo…
        const esito = await screen.findByText('Codice fiscale aggiornato.')
        // …e ci resta anche dopo che la rilettura è finita.
        await waitFor(() => expect(fetchMock.mock.calls.filter((c) => !c[1]?.method).length).toBe(2))
        expect(esito).toBeInTheDocument()
        // Lo spinner a tutta pagina — quello che SOSTITUIVA tutto — non c'è.
        expect(screen.queryByText('Verifica dei codici fiscali in corso…')).not.toBeInTheDocument()
    })

    it('⚠️ il fuoco NON cade sul `<body>`: atterra sull’esito', async () => {
        armaLaRete()
        render(<PannelloVero />)
        await screen.findByText('Bianchi Anna')
        await scriviIlCodice()

        const esito = await screen.findByText('Codice fiscale aggiornato.')
        await waitFor(() => expect(document.activeElement).toBe(esito))
        expect(document.activeElement).not.toBe(document.body)
    })

    it('⚠️ il drawer non si chiude e non si RIAPRE da solo su una copia stantia', async () => {
        armaLaRete()
        render(<PannelloVero />)
        await screen.findByText('Bianchi Anna')
        await scriviIlCodice()
        await screen.findByText('Codice fiscale aggiornato.')

        // Il dialogo è rimasto quello di prima, aperto, per tutta la rilettura.
        await waitFor(() => expect(fetchMock.mock.calls.filter((c) => !c[1]?.method).length).toBe(2))
        expect(screen.getByRole('dialog', { name: 'Codice fiscale' })).toBeInTheDocument()
        // E l'elenco sotto si è davvero aggiornato: la riga corretta non c'è più.
        await waitFor(() => expect(screen.queryByRole('table')).not.toBeInTheDocument())

        // Chiudendo, non riappare niente: `selezionata` se ne va con il drawer.
        fireEvent.click(screen.getByRole('button', { name: 'Chiudi' }))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(screen.getByText('Nessun codice fiscale da verificare')).toBeInTheDocument()
    })

    it('⚠️ il dettaglio non resta sulla COPIA di prima: sotto l’esito non si legge più «Incoerente»', async () => {
        armaLaRete()
        render(<PannelloVero />)
        await screen.findByText('Bianchi Anna')

        // Prima: il dettaglio racconta la riga com'è — stato, codice, motivi.
        const riga = screen.getByText('Bianchi Anna').closest('tr') as HTMLElement
        fireEvent.click(within(riga).getByRole('button', { name: 'Apri' }))
        const prima = screen.getByRole('dialog', { name: 'Codice fiscale' })
        expect(within(prima).getByText(/Incoerente/)).toBeInTheDocument()
        expect(within(prima).getByText(CF_ATTUALE)).toBeInTheDocument()
        expect(within(prima).getByText('Perché non torna')).toBeInTheDocument()

        fireEvent.click(within(prima).getByRole('button', { name: 'Applica il codice proposto' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Conferma la scrittura' }))
        await screen.findByText('Codice fiscale aggiornato.')
        await waitFor(() => expect(screen.queryByRole('table')).not.toBeInTheDocument())

        // ⟵ IL PUNTO: la riga è sparita dall'elenco, e il drawer non la racconta
        //    più come se fosse ancora così. Prima di questa correzione, sotto la
        //    riga verde «Codice fiscale aggiornato.» si continuava a leggere
        //    «Stato: Incoerente», il vecchio codice e «Perché non torna».
        const dopo = screen.getByRole('dialog', { name: 'Codice fiscale' })
        expect(within(dopo).queryByText(/Incoerente/)).not.toBeInTheDocument()
        expect(within(dopo).queryByText(CF_ATTUALE)).not.toBeInTheDocument()
        expect(within(dopo).queryByText('Perché non torna')).not.toBeInTheDocument()
        // …e non lascia il vuoto al suo posto: lo dice.
        expect(within(dopo).getByText(/non è più fra i codici fiscali da verificare/)).toBeInTheDocument()
        // L'esito resta, ed è l'unica cosa vera rimasta a schermo su quella persona.
        expect(within(dopo).getByText('Codice fiscale aggiornato.')).toBeInTheDocument()
        // Il nominativo pure: chi legge deve sapere DI CHI parla quell'esito.
        expect(within(dopo).getByText('Bianchi Anna')).toBeInTheDocument()
    })

    it('la riga che RESTA nell’elenco si rilegge aggiornata, non si congela', async () => {
        // La scrittura riesce, ma la riga resta da verificare per un altro motivo
        // (nell'elenco riletto è passata a `non-verificabile`): il dettaglio deve
        // mostrare LO STATO NUOVO, non quello di quando è stata scelta.
        const DOPO: RigaCodiceFiscale = {
            ...INCOERENTE,
            stato: 'non-verificabile',
            codice_attuale: CF_PROPOSTO,
            motivi: [],
            non_verificabili: ['luogo-nascita'],
            codice_proposto: CF_PROPOSTO,
            proposta_combacia: true,
            priorita: 0,
        }
        let letture = 0
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'PATCH') {
                return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) })
            }
            letture += 1
            const righe = letture === 1 ? [INCOERENTE] : [DOPO]
            return Promise.resolve({
                ok: true, status: 200,
                json: async () => ({ righe, totale: righe.length, troncato: false }),
            })
        })
        render(<PannelloVero />)
        await screen.findByText('Bianchi Anna')
        await scriviIlCodice()
        await screen.findByText('Codice fiscale aggiornato.')

        const drawer = await waitFor(() => {
            const d = screen.getByRole('dialog', { name: 'Codice fiscale' })
            expect(within(d).getByText(/Non verificabile/)).toBeInTheDocument()
            return d
        })
        // Il codice attuale a schermo è quello appena scritto, non quello di prima
        // (due `dd` lo portano: «Codice attuale» e «Codice proposto», che ora
        // coincidono — ed è proprio la forma che dice che la scrittura è passata).
        expect(within(drawer).getAllByText(CF_PROPOSTO)).toHaveLength(2)
        expect(within(drawer).queryByText(CF_ATTUALE)).not.toBeInTheDocument()
        expect(within(drawer).queryByText('Perché non torna')).not.toBeInTheDocument()
    })

    it('la rilettura si ANNUNCIA, invece di sostituire la schermata', async () => {
        let sblocca: ((v: unknown) => void) | null = null
        armaLaRete()
        render(<PannelloVero />)
        await screen.findByText('Bianchi Anna')

        // La seconda lettura resta in volo: è il momento in cui prima c'era lo spinner.
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'PATCH') {
                return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) })
            }
            return new Promise((res) => { sblocca = res })
        })
        await scriviIlCodice()

        const avviso = await screen.findByText('Aggiornamento dell’elenco in corso…')
        expect(avviso).toBeInTheDocument()
        // ⚠️ SI ASSERISCE L'ATTRIBUTO, non il solo testo. Misurato: togliendo
        // `aria-live` questo test restava verde — cioè per chi usa uno screen
        // reader la rilettura tornava MUTA senza che niente diventasse rosso, ed
        // è esattamente la persona per cui questa riga esiste (è l'alternativa
        // allo spinner che smontava tutto il pannello).
        expect(avviso.getAttribute('aria-live')).toBe('polite')
        // …e `polite`, non un avviso forte: `role="alert"` (o `status`)
        // interromperebbe l'annuncio dell'esito della scrittura, che è la cosa
        // che chi ha appena premuto sta aspettando di sentire.
        expect(avviso.getAttribute('role')).toBeNull()
        expect(screen.getByRole('table')).toBeInTheDocument()

        await act(async () => {
            sblocca?.({ ok: true, status: 200, json: async () => ({ righe: [], totale: 0, troncato: false }) })
        })
        await waitFor(() =>
            expect(screen.queryByText('Aggiornamento dell’elenco in corso…')).not.toBeInTheDocument(),
        )
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// IL DOPPIO INVIO — due PATCH sul codice fiscale dello stesso bambino.
// ═════════════════════════════════════════════════════════════════════════════
describe('CodiciFiscaliDaVerificare · una scrittura sola per gesto', () => {
    it('⚠️ due click ravvicinati su «Conferma» = UNA sola PATCH', async () => {
        // La PATCH resta in volo: è la finestra in cui il secondo click arriva.
        let sblocca: ((v: unknown) => void) | null = null
        fetchMock.mockImplementation(() => new Promise((res) => { sblocca = res }))

        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE])} />)
        const riga = screen.getByText('Bianchi Anna').closest('tr') as HTMLElement
        fireEvent.click(within(riga).getByRole('button', { name: 'Apri' }))
        fireEvent.click(screen.getByRole('button', { name: 'Applica il codice proposto' }))

        const conferma = await screen.findByRole('button', { name: /Conferma la scrittura|Scrittura in corso/ })
        fireEvent.click(conferma)
        fireEvent.click(conferma)
        fireEvent.click(conferma)

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        // …e non ne parte una seconda nemmeno lasciando girare il resto del tick.
        await act(async () => { await Promise.resolve() })
        expect(fetchMock).toHaveBeenCalledTimes(1)

        await act(async () => {
            sblocca?.({ ok: true, status: 200, json: async () => ({ success: true }) })
        })
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('mentre scrive, il comando resta un MESSAGGIO e non un controllo spento', async () => {
        // Regola di casa (`Btn.tsx`, 2026-08-08): `disabled` non è il modo di dire
        // «sto lavorando» — spegne il fuoco, che in Chrome torna su `<body>`.
        // Il doppio invio lo ferma la guardia dentro `applica()`, non il DOM.
        fetchMock.mockImplementation(() => new Promise(() => {}))
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE])} />)
        const riga = screen.getByText('Bianchi Anna').closest('tr') as HTMLElement
        fireEvent.click(within(riga).getByRole('button', { name: 'Apri' }))
        fireEvent.click(screen.getByRole('button', { name: 'Applica il codice proposto' }))
        const conferma = await screen.findByRole('button', { name: 'Conferma la scrittura' })
        conferma.focus()
        fireEvent.click(conferma)

        const inCorso = await screen.findByRole('button', { name: 'Scrittura in corso…' })
        expect(inCorso).not.toBeDisabled()
        expect(inCorso.getAttribute('aria-disabled')).toBe('true')
        // Il fuoco non è scappato: è ancora sul comando che l'utente ha premuto.
        expect(document.activeElement).toBe(inCorso)
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// LA RIPARTIZIONE — il numero che la pillola della linguetta non può dire.
// ═════════════════════════════════════════════════════════════════════════════
describe('CodiciFiscaliDaVerificare · quanti sono, e di quale specie', () => {
    it('dice quanti sono incoerenti, quanti non verificabili, quanti da compilare', () => {
        render(
            <CodiciFiscaliDaVerificare
                esito={esitoPronto([INCOERENTE, NON_VERIFICABILE, COMBACIA, DA_COMPILARE])}
            />,
        )
        const riga = screen.getByText(/In questo elenco/)
        expect(riga.textContent).toContain('1 incoerente')
        expect(riga.textContent).toContain('2 non verificabili')
        expect(riga.textContent).toContain('1 da compilare')
    })

    it('⚠️ il numero della pillola conta ANCHE le righe su cui si può scrivere', () => {
        // Il difetto, misurato l'11 agosto: `azionabili` contava le sole righe
        // `incoerente`, mentre il pannello mostra «Applica» anche su un
        // `da-compilare` con la proposta pronta — 1 alunno e 1 genitore veri, che
        // la rotta mette per giunta in CIMA (`priorita: 0`). Il badge diceva 1
        // dove il lavoro era 2.
        const elenco = [INCOERENTE, NON_VERIFICABILE, COMBACIA, DA_COMPILARE, DA_COMPILARE_CON_PROPOSTA]
        expect(contaAzionabili(elenco)).toBe(2)
        // …e resta lontano dai due numeri sbagliati: la somma dei tre stati (5)
        // e il solo rosso (1).
        expect(contaAzionabili(elenco)).not.toBe(elenco.length)
        expect(contaAzionabili(elenco)).not.toBe(elenco.filter((r) => r.stato === 'incoerente').length)
    })

    it('⚠️ la SESTA riga di prova: il giallo con la proposta DISCORDE è dentro il numero', () => {
        // La decisione, resa misurabile invece che lasciata implicita. `scrivibile()`
        // non guarda lo stato: un `non-verificabile` la cui proposta non combacia
        // ottiene «Applica», e dall'11 agosto entra anche nella pillola — cioè nel
        // segnale che porta l'operatore dentro la linguetta. È la scrittura più
        // rischiosa del pannello (si sovrascrive il codice registrato di una
        // persona sulla riga in cui il sistema dichiara di NON poter verificare),
        // ed è difesa dalla conferma in due tempi e dal riepilogo per esteso.
        // Se il titolare decide che il giallo non va contato, la riga sola di
        // `contaAzionabili` fa diventare rosso QUESTO test, non nessuno.
        expect(scrivibile(NON_VERIFICABILE_DISCORDE)).toBe(true)
        expect(contaAzionabili([NON_VERIFICABILE_DISCORDE])).toBe(1)
        // …e non si confonde col giallo che CONFERMA il codice, che resta fuori.
        expect(contaAzionabili([COMBACIA])).toBe(0)
    })

    it('restano fuori «mai compilato» e la proposta che CONFERMA il codice', () => {
        expect(contaAzionabili([DA_COMPILARE])).toBe(0)
        expect(contaAzionabili([COMBACIA])).toBe(0)
        expect(contaAzionabili([NON_VERIFICABILE])).toBe(0)
        // Un rosso senza proposta resta dentro: è un errore in archivio, e il
        // gesto — aprire la scheda — c'è lo stesso.
        expect(contaAzionabili([{ ...INCOERENTE, codice_proposto: null, proposta_bloccata_da: 'luogo' }])).toBe(1)
    })

    it('⚠️ INVARIANTE: se il comando di scrittura è a schermo, la riga È nel numero', () => {
        // È la cosa che il difetto ha insegnato: il conteggio e il comando erano
        // due espressioni diverse per la stessa domanda, in due punti del file.
        // Qui si misurano INSIEME, riga per riga, sul DOM vero.
        for (const r of [
            INCOERENTE,
            NON_VERIFICABILE,
            NON_VERIFICABILE_DISCORDE,
            COMBACIA,
            DA_COMPILARE,
            DA_COMPILARE_CON_PROPOSTA,
        ]) {
            const { unmount } = render(<CodiciFiscaliDaVerificare esito={esitoPronto([r])} />)
            const riga = screen.getByText(`${r.cognome} ${r.nome}`).closest('tr') as HTMLElement
            fireEvent.click(within(riga).getByRole('button', { name: 'Apri' }))

            const comandoAschermo =
                screen.queryByRole('button', { name: 'Applica il codice proposto' }) !== null
            expect(comandoAschermo).toBe(scrivibile(r))
            if (comandoAschermo) expect(contaAzionabili([r])).toBe(1)
            unmount()
        }
    })

    it('con l’archivio pulito non si scrive «0 · 0 · 0»', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([])} />)
        expect(screen.queryByText(/In questo elenco/)).not.toBeInTheDocument()
    })

    it('il click sul comando «Apri» non risale alla riga', () => {
        // `stopPropagation`: oggi il doppio `scegli(r)` è idempotente e non si
        // vede, ma il giorno in cui la riga porta un secondo comando quello
        // aprirebbe anche il dettaglio. Lo si misura su un antenato REACT: la
        // risalita che `stopPropagation()` interrompe è quella dell'evento
        // sintetico, non quella del DOM nativo (React ascolta sulla radice).
        const risalito = vi.fn()
        render(
            <div onClick={risalito}>
                <CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE, NON_VERIFICABILE])} />
            </div>,
        )
        const riga = screen.getByText('Verdi Luca').closest('tr') as HTMLElement

        fireEvent.click(within(riga).getByRole('button', { name: 'Apri' }))
        expect(risalito).not.toHaveBeenCalled()
        expect(screen.getByRole('dialog', { name: 'Codice fiscale' })).toBeInTheDocument()

        // Controllo positivo: senza guardia l'evento risale eccome — è il click
        // sulla riga, che resta la comodità del mouse e non ferma niente.
        fireEvent.click(within(riga).getAllByRole('cell')[0])
        expect(risalito).toHaveBeenCalledTimes(1)
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// UNA RILETTURA CHE FALLISCE non cancella l'elenco che c'è.
//
// È l'ultima faccia dello stesso difetto: se `fase` andasse a `errore` sopra un
// elenco già letto, il pannello si smonterebbe lo stesso — e chi ha appena
// scritto vedrebbe l'esito sostituito da un cartello d'errore, senza sapere se
// la scrittura è passata.
// ═════════════════════════════════════════════════════════════════════════════
describe('CodiciFiscaliDaVerificare · il guasto si dice CON i dati, non al posto loro', () => {
    it('l’hook resta `pronto` e alza `riletturaFallita`', async () => {
        fetchMock.mockResolvedValue({
            ok: true, status: 200,
            json: async () => ({ righe: [INCOERENTE], totale: 1, troncato: false }),
        })
        const { result } = renderHook(() => useCodiciFiscaliDaVerificare())
        await waitFor(() => expect(result.current.fase).toBe('pronto'))

        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
        act(() => result.current.ricarica())
        await waitFor(() => expect(result.current.riletturaFallita).toBe(true))

        expect(result.current.fase).toBe('pronto')
        expect(result.current.righe.map((r) => r.id)).toEqual([INCOERENTE.id])
        expect(logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error' }))
    })

    it('al PRIMO caricamento invece la schermata d’errore è quella giusta: sotto non c’è niente', async () => {
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
        const { result } = renderHook(() => useCodiciFiscaliDaVerificare())
        await waitFor(() => expect(result.current.fase).toBe('errore'))
        expect(result.current.riletturaFallita).toBe(false)
    })

    it('in pagina: fascia d’allarme, «Riprova», e la tabella ancora sotto', () => {
        render(
            <CodiciFiscaliDaVerificare
                esito={esitoPronto([INCOERENTE], { riletturaFallita: true, errore: 'Sede non accessibile' })}
            />,
        )
        const allarme = screen.getByRole('alert')
        expect(allarme.textContent).toContain('Sede non accessibile')
        // ⟵ IL PUNTO: i dati non sono spariti.
        expect(screen.getByRole('table')).toBeInTheDocument()
        expect(screen.getByText('Bianchi Anna')).toBeInTheDocument()

        fireEvent.click(within(allarme).getByRole('button', { name: /Riprova/ }))
        expect(ricarica).toHaveBeenCalledTimes(1)
    })

    it('senza motivo del server, la fascia lo dice lo stesso, e in italiano', () => {
        render(<CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE], { riletturaFallita: true })} />)
        expect(screen.getByRole('alert').textContent).toContain('ultima lettura riuscita')
    })

    it('nessuna violazione axe con la fascia della rilettura fallita a schermo', async () => {
        const { container } = render(
            <CodiciFiscaliDaVerificare esito={esitoPronto([INCOERENTE], { riletturaFallita: true })} />,
        )
        expect(await axe(container)).toHaveNoViolations()
    })
})
