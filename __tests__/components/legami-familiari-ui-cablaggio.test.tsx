import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'

import itAdminStudents from '../../messages/it/adminStudents.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * IL CABLAGGIO — i comandi del legame MONTATI SULLE DUE SCHEDE VERE.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─── PERCHÉ ESISTE UN SECONDO FILE, E NON BASTAVA IL PRIMO ──────────────────
 *
 * `legami-familiari-ui.test.tsx` rende `GestoreLegami` **isolato**: gli passa
 * lui stesso `alunnoId`, `collegati` e `onRicarica`, quindi misura il
 * componente e non il prodotto. Misurato il 2026-09-06 svuotando
 * `collegati={legamiGestibili}` nella scheda del bambino e togliendo del tutto
 * la sezione dei comandi da quella dell'adulto: **116 test su 116 sono rimasti
 * verdi**, i quattro lock i18n compresi. Cioè si poteva cancellare col gate
 * verde l'unica cosa che mette questi comandi davanti a una segreteria — la
 * stessa forma di difetto che questo lavoro era nato per chiudere («il motore
 * c'è, il prodotto no»).
 *
 * Qui si rendono le DUE SCHEDE VERE, e si misura ciò che solo da lì si vede:
 *
 *  1. la scheda del BAMBINO porta ai comandi i legami di `student_parents` —
 *     tutti — e **non** i `delegates`: quelli stanno in un'altra tabella, questa
 *     rotta non li tocca, e un «Scollega» su una riga che il server non conosce
 *     risponderebbe 404 `LEGAME_NON_TROVATO`. Un elenco troppo lungo qui è un
 *     comando che promette e fallisce, non una svista estetica;
 *  2. la scheda dell'ADULTO mostra la sezione **anche con ZERO figli
 *     collegati** — che è precisamente il caso per cui «Aggiungi figlio»
 *     esiste. Il commento nel file promette di averla messa fuori dal ramo
 *     `children.length > 0`: qui quella promessa diventa una misura;
 *  3. i due uuid che partono davvero sono quelli DELLE SCHEDE (`student.id`,
 *     `parent.id`), non quelli di una fixture di comodo: si preme «Scollega»
 *     sulla scheda vera e si guarda il corpo della POST;
 *  4. dopo una scrittura riuscita l'elenco si rilegge **dalla stessa fonte da
 *     cui era arrivato**. Un elenco vecchio a schermo è un elenco di uuid che
 *     sul server non descrivono più niente, e manda il gesto successivo su un
 *     404 che parla di un guasto quando il guasto era la schermata.
 *
 * ─── PERCHÉ next-intl È FINTO CON IL FORMATTATORE VERO ──────────────────────
 *
 * Il mock globale (`test/setup.ts`) restituisce la CHIAVE. Con quello, la
 * tendina del ruolo si chiamerebbe «legamiRuoloDi» su OGNI riga — cioè due
 * etichette identiche — e la frase che nomina chi perde la vista su chi
 * resterebbe un segnaposto. Qui si rende con l'ICU vero (`use-intl`, la
 * libreria sotto next-intl): è l'unico modo di distinguere una riga dall'altra
 * e di misurare che i due nomi finiscano al posto giusto.
 *
 * ⚠️ REPOSITORY PUBBLICO: uuid finti e nomi palesemente inventati. Da queste due
 * schede passano le anagrafiche di oltre seicento minori.
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
            // Una chiave mancante non deve far cadere la scheda intera: qui si
            // misura il cablaggio, e le chiavi hanno già i loro quattro lock.
            onError: () => {},
            getMessageFallback: ({ key }: { key: string }) => key,
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

const logClientSpia = vi.fn()
vi.mock('@/lib/logging/client', () => ({
    logClient: (...a: unknown[]) => logClientSpia(...a),
    nomeErrore: () => 'Error',
}))
vi.mock('@/lib/auth/current-teacher', () => ({ getCurrentTeacherId: () => null }))
// Ha il proprio collaudo, e monta le proprie fetch: qui è rumore.
vi.mock('@/components/features/admin/StudentEconomicSection', () => ({
    StudentEconomicSection: () => null,
}))

/* ── Gli attori. Uuid finti, nomi inventati: il repository è PUBBLICO. ─────── */
const ID_ALUNNO = 'aaaa1111-0000-4000-8000-0000000000a1'
const ID_MADRE = 'bbbb2222-0000-4000-8000-0000000000b1'
const ID_PADRE = 'bbbb2222-0000-4000-8000-0000000000b2'
/** Un DELEGATO: sta in `delegates`, non in `student_parents`. Non si comanda da qui. */
const ID_DELEGATO = 'cccc3333-0000-4000-8000-0000000000c1'
const ID_GENITORE = 'bbbb2222-0000-4000-8000-0000000000b9'
const ID_FIGLIO = 'aaaa1111-0000-4000-8000-0000000000a9'

const NOME_MADRE = 'Verdi Carla'
const NOME_PADRE = 'Verdi Ugo'
const NOME_ALUNNO = 'Verdi Ada'
const NOME_GENITORE = 'Bianchi Nadia'
const NOME_FIGLIO = 'Bianchi Enea'

/** La scheda del bambino, come arriva dal contenitore: due genitori e un delegato. */
const ALUNNO = {
    id: ID_ALUNNO,
    nome: 'Ada',
    cognome: 'Verdi',
    scuola_id: SEDE_A,
    classe_sezione: 'LEONI',
    student_parents: [
        { relation_type: 'mother', is_primary: true, parents: { id: ID_MADRE, first_name: 'Carla', last_name: 'Verdi', gender: 'F' } },
        { relation_type: 'father', is_primary: false, parents: { id: ID_PADRE, first_name: 'Ugo', last_name: 'Verdi', gender: 'M' } },
    ],
    delegates: [{ id: ID_DELEGATO, first_name: 'Nonna', last_name: 'Delegata' }],
}

/** Il fascicolo dell'adulto, come risponde `GET /api/admin/parents/[id]`. */
const genitoreConFigli = (figli: unknown[]) => ({
    id: ID_GENITORE,
    first_name: 'Nadia',
    last_name: 'Bianchi',
    gender: 'F',
    birth_date: null,
    birth_city: null,
    fiscal_code: null,
    emails: [],
    phone_numbers: [],
    residence_address: null,
    residence_city: null,
    zip_code: null,
    student_parents: figli,
})

const FIGLIO_COLLEGATO = {
    relation_type: 'mother',
    is_primary: true,
    alunni: { id: ID_FIGLIO, nome: 'Enea', cognome: 'Bianchi', classe_sezione: 'GIRASOLI', scuola_id: SEDE_A, student_parents: [] },
}

const fetchMock = vi.fn()

/** Quello che rispondono le due riletture di scheda in questo giro di test. */
let schedaAlunno: Record<string, unknown> = {}
let schedaGenitore: Record<string, unknown> = {}
/** Quello che risponde `/api/admin/legami-familiari` (GET ricerca e POST scrittura). */
let esitoLegami: { stato: number; corpo: unknown } = { stato: 200, corpo: { ok: true, anagrafica: 'rimossa', runtime: 'rimosso' } }

beforeEach(() => {
    vi.clearAllMocks()
    schedaAlunno = { ...ALUNNO, siblings: [] }
    schedaGenitore = genitoreConFigli([])
    esitoLegami = { stato: 200, corpo: { ok: true, anagrafica: 'rimossa', runtime: 'rimosso' } }
    fetchMock.mockImplementation((url: string) => {
        const u = new URL(String(url), 'http://t.test')
        const rispondi = (corpo: unknown, stato = 200) =>
            Promise.resolve({ ok: stato < 400, status: stato, headers: new Headers(), json: async () => corpo })
        if (u.pathname === '/api/admin/legami-familiari') return rispondi(esitoLegami.corpo, esitoLegami.stato)
        if (u.pathname.startsWith('/api/admin/students/')) return rispondi(schedaAlunno)
        if (u.pathname.startsWith('/api/admin/parents/')) return rispondi(schedaGenitore)
        if (u.pathname === '/api/admin/sedi/destinazioni')
            return rispondi({ success: true, data: [{ id: SEDE_A, nome: NOME_SEDE_A }], motivo: 'ok' })
        if (u.pathname === '/api/admin/sections') return rispondi([])
        if (u.pathname.startsWith('/api/anagrafiche/comuni')) return rispondi({ comuni: [] })
        return rispondi({})
    })
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => cleanup())

import { StudentDetailPanel } from '@/components/features/admin/StudentDetailPanel'
import { ParentDetailPanel } from '@/components/features/admin/ParentDetailPanel'

const apriScheda = (student: Record<string, unknown> = ALUNNO) =>
    render(
        <StudentDetailPanel
            student={student as never}
            onClose={() => {}}
            onSave={vi.fn()}
            onArchive={async () => ({ ok: true })}
            onRiattiva={async () => ({ ok: true })}
        />,
    )

const apriGenitore = () =>
    render(<ParentDetailPanel parentBasicInfo={{ id: ID_GENITORE }} onClose={() => {}} onSave={vi.fn()} />)

/** Quante volte la scheda dell'alunno è stata letta dal server (mount + riletture). */
const lettureScheda = () =>
    fetchMock.mock.calls.filter((c) => String(c[0]).includes(`/api/admin/students/${ID_ALUNNO}`)).length

/** Le chiamate alla rotta dei legami, nell'ordine. */
const chiamateLegami = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/admin/legami-familiari'))

/** Il corpo JSON della n-esima chiamata alla rotta dei legami. */
const corpoLegami = (n: number) =>
    JSON.parse((chiamateLegami()[n] as [string, { body: string }])[1].body) as Record<string, unknown>

describe('La scheda del BAMBINO monta i comandi, e li monta sui legami giusti', () => {
    it('i comandi ci sono, e portano i DUE genitori di `student_parents`', async () => {
        apriScheda()

        const gestore = await screen.findByTestId('gestore-legami')
        expect(within(gestore).getByRole('button', { name: itAdminStudents.legamiAggiungiFamiliare })).toBeInTheDocument()

        // Le righe comandabili sono quelle del legame, una per genitore.
        expect(screen.getByTestId(`legame-${ID_MADRE}`)).toBeInTheDocument()
        expect(screen.getByTestId(`legame-${ID_PADRE}`)).toBeInTheDocument()
        expect(within(gestore).getAllByRole('listitem')).toHaveLength(2)

        // E il ruolo che ognuna porta è quello scritto in archivio, non un default.
        expect((within(gestore).getByLabelText(`Ruolo di ${NOME_MADRE}`) as HTMLSelectElement).value).toBe('mother')
        expect((within(gestore).getByLabelText(`Ruolo di ${NOME_PADRE}`) as HTMLSelectElement).value).toBe('father')
    })

    it('⚠️ i DELEGATI restano fuori: un «Scollega» su di loro sarebbe un 404', async () => {
        apriScheda()

        const gestore = await screen.findByTestId('gestore-legami')
        // `delegates` è un'altra tabella e questa rotta non la tocca: mostrarli qui
        // vorrebbe dire offrire un comando che il server non può eseguire.
        expect(screen.queryByTestId(`legame-${ID_DELEGATO}`)).toBeNull()
        expect(gestore.textContent).not.toContain('Delegata')
        // …e il delegato NON è sparito dalla scheda: le linguette in sola lettura
        // qui sopra continuano a mostrarlo. Senza questa metà, la prova sarebbe
        // verde anche su una scheda che ha perso i delegati per intero.
        expect(screen.getByRole('button', { name: /Delegato/i })).toBeInTheDocument()
    })

    it('lo scollegamento parte con l’uuid DELLA SCHEDA, e la conferma nomina i due', async () => {
        apriScheda()
        const gestore = await screen.findByTestId('gestore-legami')
        const riga = within(screen.getByTestId(`legame-${ID_MADRE}`))
        fireEvent.click(riga.getByRole('button', { name: itAdminStudents.legamiScollega }))

        const dialogo = within(await screen.findByRole('dialog'))
        // I due nomi arrivano dalle prop del PANNELLO: `nomeFisso` è il bambino
        // della scheda, la riga è l'adulto. Se il verso si invertisse, questa
        // frase direbbe che è il bambino a perdere di vista il genitore.
        expect(
            dialogo.getByText(
                `${NOME_MADRE}: non vedrà più il diario, la galleria, i pagamenti e i messaggi di ${NOME_ALUNNO}.`,
            ),
        ).toBeInTheDocument()

        const lettePrima = lettureScheda()
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiScollegaConferma }))

        await waitFor(() => expect(chiamateLegami()).toHaveLength(1))
        expect(corpoLegami(0)).toEqual({ azione: 'scollega', alunno_id: ID_ALUNNO, parent_id: ID_MADRE })
        // L'elenco si rilegge dalla STESSA fonte da cui era arrivato: un elenco
        // vecchio manda il gesto successivo su un 404 `LEGAME_NON_TROVATO`.
        await waitFor(() => expect(lettureScheda()).toBe(lettePrima + 1))
        expect(gestore).toBeInTheDocument()
    })

    it('un bambino SENZA nessun genitore ha lo stesso il comando per aggiungerne uno', async () => {
        // È il caso che conta: se i comandi vivessero dentro il ramo «ci sono
        // genitori», l'unica scheda da cui serve aggiungerne uno sarebbe l'unica
        // a non offrirlo.
        apriScheda({ ...ALUNNO, student_parents: [], delegates: [] })

        const gestore = await screen.findByTestId('gestore-legami')
        expect(within(gestore).getByRole('button', { name: itAdminStudents.legamiAggiungiFamiliare })).toBeInTheDocument()
        expect(within(gestore).queryAllByRole('listitem')).toHaveLength(0)
    })
})

describe('La scheda dell’ADULTO monta i comandi, e li monta anche a ZERO figli', () => {
    it('⚠️ con ZERO figli collegati la sezione c’è lo stesso: è il caso per cui esiste', async () => {
        apriGenitore()

        const sezione = await screen.findByTestId('parent-legami')
        expect(within(sezione).getByRole('button', { name: itAdminStudents.legamiAggiungiFiglio })).toBeInTheDocument()
        expect(within(sezione).getByText(itAdminStudents.legamiNessunBambino)).toBeInTheDocument()
    })

    it('col figlio collegato, la riga porta il suo uuid e il ruolo del LEGAME', async () => {
        schedaGenitore = genitoreConFigli([FIGLIO_COLLEGATO])
        apriGenitore()

        await screen.findByTestId('parent-legami')
        const riga = await screen.findByTestId(`legame-${ID_FIGLIO}`)
        expect(riga.textContent).toContain(NOME_FIGLIO)
        // `relation_type` sta sulla riga di legame, non sul bambino: preso da
        // `figli` sarebbe sempre vuoto.
        expect((within(riga).getByLabelText(`Ruolo di ${NOME_FIGLIO}`) as HTMLSelectElement).value).toBe('mother')
    })

    it('«Aggiungi figlio» cerca fra i BAMBINI, col `parent_id` della scheda', async () => {
        esitoLegami = { stato: 200, corpo: { alunni: [] } }
        apriGenitore()

        const sezione = await screen.findByTestId('parent-legami')
        fireEvent.click(within(sezione).getByRole('button', { name: itAdminStudents.legamiAggiungiFiglio }))
        fireEvent.change(await screen.findByLabelText(itAdminStudents.legamiCercaEtichetta), {
            target: { value: 'bi' },
        })

        await waitFor(() => expect(chiamateLegami()).toHaveLength(1))
        const url = String(chiamateLegami()[0][0])
        expect(url).toContain('tipo=alunni')
        // L'uuid è quello del genitore CARICATO dal server, non quello della prop:
        // è la differenza fra «la scheda è cablata» e «la prop è arrivata».
        expect(url).toContain(`parent_id=${ID_GENITORE}`)
    })

    it('lo scollegamento di un figlio parte col verso giusto: `alunno_id` è il bambino', async () => {
        schedaGenitore = genitoreConFigli([FIGLIO_COLLEGATO])
        apriGenitore()

        const riga = within(await screen.findByTestId(`legame-${ID_FIGLIO}`))
        fireEvent.click(riga.getByRole('button', { name: itAdminStudents.legamiScollega }))

        const dialogo = within(await screen.findByRole('dialog'))
        // Chi perde la vista è l'ADULTO della scheda, e a perderla è sul BAMBINO
        // della riga: il verso non si ribalta cambiando scheda.
        expect(
            dialogo.getByText(
                `${NOME_GENITORE}: non vedrà più il diario, la galleria, i pagamenti e i messaggi di ${NOME_FIGLIO}.`,
            ),
        ).toBeInTheDocument()

        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiScollegaConferma }))
        await waitFor(() => expect(chiamateLegami()).toHaveLength(1))
        expect(corpoLegami(0)).toEqual({ azione: 'scollega', alunno_id: ID_FIGLIO, parent_id: ID_GENITORE })
    })
})
