import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import itAdminStudents from '../../messages/it/adminStudents.json'
import itShared from '../../messages/it/shared.json'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * I PULSANTI DEL LEGAME FAMILIARE — aggiungi · cambia ruolo · scollega.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─── PERCHÉ QUESTO FILE ESISTE ──────────────────────────────────────────────
 *
 * La rotta `/api/admin/legami-familiari`, il modulo che scrive su ENTRAMBE le
 * tabelle ponte e i tre codici d'errore esistevano dal 2026-09-05, con i loro
 * test. **Non li chiamava nessuno**: `grep -rn "legami-familiari" src/` non
 * trovava una sola `fetch`, la scheda del bambino mostrava i genitori in sola
 * lettura e quella dell'adulto i figli in sola lettura. È la stessa forma di
 * difetto già pagata con «Libera spazio»: il motore c'è, il prodotto no.
 *
 * ─── CHE COSA MISURA, e perché proprio questo ──────────────────────────────
 *
 * Tre cose che decidono se questi comandi si possono mettere davanti a una
 * segreteria, e nessuna delle tre è visibile dai test della rotta:
 *
 *  1. la RICERCA NON PARTE sotto i due caratteri. Non è un risparmio di rete:
 *     la ricerca degli adulti, sul server, legge fino a 3000 righe di perimetro
 *     per non far uscire dal proprio plesso l'anagrafica di nessuno. Una lettura
 *     così a ogni tasto è la differenza fra una schermata e un incidente.
 *  2. lo SCOLLEGAMENTO CHIEDE CONFERMA, e la conferma dice CHI perde COSA di
 *     CHI. È il gesto che toglie a un adulto la vista su un minore: «Confermi?»
 *     non è una conferma, è una domanda senza contenuto.
 *  3. il 409 `LEGAME_ULTIMO_GENITORE` si legge come una PROTEZIONE. Il testo di
 *     catalogo porta già il rimedio (prima si collega l'altro genitore, poi si
 *     scollega questo): mostrarlo come un guasto rosso da riprovare farebbe
 *     ripremere il comando a chi ha appena letto perché non si può.
 *
 * ─── PERCHÉ next-intl È FINTO CON IL FORMATTATORE VERO ──────────────────────
 *
 * Il mock globale (`test/setup.ts`) restituisce la CHIAVE, non il testo: la frase
 * che conta — «{adulto}: non vedrà più … di {bambino}» — resterebbe un segnaposto,
 * e le prove sarebbero verdi su un testo che non nomina nessuno. Qui si rende con
 * l'ICU vero (`use-intl`, la libreria che sta sotto next-intl), che è l'unico modo
 * di misurare che i due nomi finiscano al posto giusto e non invertiti.
 *
 * ⚠️ REPOSITORY PUBBLICO: nomi palesemente inventati e uuid finti. Da qui passano
 * anagrafiche di minori.
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

expect.extend(toHaveNoViolations)

/**
 * Le regole a livello di DOCUMENTO non valgono per un componente isolato in jsdom,
 * e `color-contrast` non è calcolabile senza layout (ha il suo lock dedicato).
 * Stesso insieme di `schede-alunno-a11y.test.tsx`, così due file non divergono
 * sulla stessa decisione.
 */
const axeOpts = {
    rules: {
        region: { enabled: false },
        'landmark-one-main': { enabled: false },
        'page-has-heading-one': { enabled: false },
    },
}

const logClient = vi.fn()
vi.mock('@/lib/logging/client', async (originale) => ({
    ...(await originale<typeof import('@/lib/logging/client')>()),
    logClient: (...args: unknown[]) => logClient(...args),
}))

import { GestoreLegami, type VoceLegame } from '@/components/features/admin/legami/GestoreLegami'

/* ── Gli attori. Uuid finti, nomi inventati: il repository è PUBBLICO. ─────── */
const ALUNNO = 'aaaa1111-0000-4000-8000-000000000001'
const ALUNNO_2 = 'aaaa1111-0000-4000-8000-000000000002'
const ADULTO = 'bbbb2222-0000-4000-8000-000000000001'
const ADULTO_2 = 'bbbb2222-0000-4000-8000-000000000002'

const NOME_BAMBINO = 'Bianchi Anna'
const NOME_ADULTO = 'Rossi Mario'

const MADRE: VoceLegame = { id: ADULTO, nome: NOME_ADULTO, dettaglio: null, ruolo: 'mother' }

const fetchMock = vi.fn()
const onRicarica = vi.fn()

/** Risposta a corpo pieno, con lo status che si vuole. */
const risposta = (corpo: unknown, ok = true, status = 200) => ({
    ok,
    status,
    headers: new Headers(),
    json: async () => corpo,
})

/** L'url della n-esima chiamata. */
const urlDi = (n: number) => (fetchMock.mock.calls[n] as [string])[0]

/** Il corpo JSON della n-esima POST. */
const corpoDi = (n: number) =>
    JSON.parse((fetchMock.mock.calls[n] as [string, { body: string }])[1].body) as Record<string, unknown>

/** La scheda del BAMBINO: si cercano e si comandano gli adulti. */
const schedaBambino = (collegati: VoceLegame[] = [MADRE]) =>
    render(
        <GestoreLegami
            verso="genitori"
            alunnoId={ALUNNO}
            nomeFisso={NOME_BAMBINO}
            collegati={collegati}
            onRicarica={onRicarica}
        />,
    )

/** La scheda dell'ADULTO: stesso legame, verso opposto. */
const schedaAdulto = (collegati: VoceLegame[] = []) =>
    render(
        <GestoreLegami
            verso="alunni"
            parentId={ADULTO}
            nomeFisso={NOME_ADULTO}
            collegati={collegati}
            onRicarica={onRicarica}
        />,
    )

/** Lascia scadere il debounce della ricerca (300 ms) con i timer VERI. */
const attendiDebounce = async () => {
    await act(async () => {
        await new Promise((r) => setTimeout(r, 400))
    })
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
})

describe('Aggiungi familiare — la ricerca si CERCA, non si sfoglia', () => {
    it('⚠️ sotto i due caratteri NON parte nessuna richiesta', async () => {
        fetchMock.mockResolvedValue(risposta({ genitori: [] }))
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiAggiungiFamiliare }))

        const campo = await screen.findByLabelText(itAdminStudents.legamiCercaEtichetta)
        fireEvent.change(campo, { target: { value: 'r' } })
        await attendiDebounce()

        expect(fetchMock).not.toHaveBeenCalled()
        expect(screen.getByText(itAdminStudents.legamiCercaMinimo)).toBeInTheDocument()
    })

    it('…e al SECONDO carattere parte, col perimetro giusto (senza questa, la prova qui sopra è vuota)', async () => {
        // Il controllo positivo: un test che verifica un'assenza è verde anche su
        // un componente che non cerca mai. Qui si misura che cerchi davvero.
        fetchMock.mockResolvedValue(risposta({ genitori: [] }))
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiAggiungiFamiliare }))

        fireEvent.change(await screen.findByLabelText(itAdminStudents.legamiCercaEtichetta), {
            target: { value: 'ro' },
        })
        await waitFor(() => expect(fetchMock).toHaveBeenCalled())

        const url = urlDi(0)
        expect(url).toContain('/api/admin/legami-familiari?')
        expect(url).toContain('tipo=genitori')
        expect(url).toContain('q=ro')
        // `alunno_id` non è un di più: è ciò che permette al server di marcare
        // `gia_collegato`, cioè di non riproporre chi c'è già.
        expect(url).toContain(`alunno_id=${ALUNNO}`)
    })

    it('chi è GIÀ collegato si vede come tale e non si può scegliere', async () => {
        fetchMock.mockResolvedValue(
            risposta({
                genitori: [
                    { id: ADULTO, first_name: 'Mario', last_name: 'Rossi', fiscal_code: null, emails: [], ha_account: true, gia_collegato: true },
                    { id: ADULTO_2, first_name: 'Carla', last_name: 'Verdi', fiscal_code: null, emails: [], ha_account: false, gia_collegato: false },
                ],
            }),
        )
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiAggiungiFamiliare }))
        fireEvent.change(await screen.findByLabelText(itAdminStudents.legamiCercaEtichetta), {
            target: { value: 'ro' },
        })

        const dialogo = within(await screen.findByRole('dialog'))
        expect(await dialogo.findByText(itAdminStudents.legamiGiaCollegato)).toBeInTheDocument()
        // Chi c'è già NON è un comando: sceglierlo sarebbe una POST che risponde
        // «era già così», cioè un gesto senza effetto che sembra averne uno.
        expect(dialogo.queryByRole('button', { name: /Rossi Mario/ })).toBeNull()
        // …mentre chi non c'è è scegliibile, e porta il suo «senza account».
        expect(dialogo.getByRole('button', { name: /Verdi Carla/ })).toBeInTheDocument()
        expect(dialogo.getByText(itAdminStudents.legamiSenzaAccountBadge)).toBeInTheDocument()
    })

    it('⚠️ un 200 col CORPO ILLEGGIBILE non diventa «nessun risultato»', async () => {
        // I due casi hanno rimedi opposti, ed è il secondo a costare: «non l'ho
        // trovato» manda a creare un adulto nuovo, e il codice fiscale in quel
        // modulo è facoltativo — senza, il dedup di `linkOrCreateParent` non
        // scatta e nasce l'anagrafica DOPPIA di una persona che c'era già.
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => {
                throw new Error('non JSON')
            },
        })
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiAggiungiFamiliare }))
        fireEvent.change(await screen.findByLabelText(itAdminStudents.legamiCercaEtichetta), {
            target: { value: 'ro' },
        })

        expect(await screen.findByText(itAdminStudents.legamiErroreRicerca)).toBeInTheDocument()
        expect(screen.queryByText(itAdminStudents.legamiCercaNessuno)).toBeNull()
        // E lascia una riga: un corpo che non si legge è l'unica cosa che nessun
        // log del server racconterà mai. `warn` perché il server ha risposto 200.
        expect(logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'warn', stato: 200, messaggio: expect.stringContaining('corpo-illeggibile') }),
        )
    })

    it('collega l’adulto scelto, dice che è senza account e RILEGGE l’elenco', async () => {
        fetchMock
            .mockResolvedValueOnce(
                risposta({
                    genitori: [
                        { id: ADULTO_2, first_name: 'Carla', last_name: 'Verdi', fiscal_code: null, emails: [], ha_account: false, gia_collegato: false },
                    ],
                }),
            )
            .mockResolvedValueOnce(risposta({ ok: true, parentId: ADULTO_2, anagrafica: 'creata', runtime: 'senza-account' }))

        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiAggiungiFamiliare }))
        fireEvent.change(await screen.findByLabelText(itAdminStudents.legamiCercaEtichetta), {
            target: { value: 've' },
        })
        const dialogo = within(await screen.findByRole('dialog'))
        fireEvent.click(await dialogo.findByRole('button', { name: /Verdi Carla/ }))
        fireEvent.change(dialogo.getByLabelText(itAdminStudents.legamiRuoloEtichetta), {
            target: { value: 'mother' },
        })
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiCollega }))

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
        expect(corpoDi(1)).toEqual({
            azione: 'collega',
            alunno_id: ALUNNO,
            parent_id: ADULTO_2,
            relation_type: 'mother',
        })
        // `senza-account` NON è un errore: 64 anagrafiche su 747 non hanno ancora
        // un accesso. La UI lo deve DIRE, perché il rimedio (mandare le
        // credenziali) è diverso da quello di un guasto (riprovare).
        expect(await screen.findByText(itAdminStudents.legamiSenzaAccount)).toBeInTheDocument()
        // L'elenco si rilegge: un elenco vecchio manda il gesto dopo su un 404.
        expect(onRicarica).toHaveBeenCalledTimes(1)
    })
})

describe('Quello che il server dice di aver fatto — e quello che non ha fatto', () => {
    /** Sceglie il primo risultato e preme «Collega». La POST è la seconda fetch. */
    const collegaIlPrimo = async () => {
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiAggiungiFamiliare }))
        fireEvent.change(await screen.findByLabelText(itAdminStudents.legamiCercaEtichetta), {
            target: { value: 've' },
        })
        const dialogo = within(await screen.findByRole('dialog'))
        fireEvent.click(await dialogo.findByRole('button', { name: /Verdi Carla/ }))
        fireEvent.change(dialogo.getByLabelText(itAdminStudents.legamiRuoloEtichetta), { target: { value: 'mother' } })
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiCollega }))
    }

    const ELENCO = {
        genitori: [
            { id: ADULTO_2, first_name: 'Carla', last_name: 'Verdi', fiscal_code: null, emails: [], ha_account: true, gia_collegato: false },
        ],
    }

    it('⚠️ `gia-presente` NON è «Collegamento salvato»: annuncerebbe un effetto che non c’è stato', async () => {
        // Fra la ricerca e la POST qualcun altro ha scritto lo stesso legame (due
        // segreterie sulla stessa famiglia, o due schede aperte). Il server non
        // riscrive niente e lo dichiara: la UI deve dire la stessa cosa.
        fetchMock
            .mockResolvedValueOnce(risposta(ELENCO))
            .mockResolvedValueOnce(risposta({ ok: true, parentId: ADULTO_2, anagrafica: 'gia-presente', runtime: 'gia-presente' }))
        await collegaIlPrimo()

        expect(await screen.findByText(itAdminStudents.legamiGiaPresente)).toBeInTheDocument()
        expect(screen.queryByText(itAdminStudents.legamiCollegato)).toBeNull()
        // L'elenco si rilegge lo stesso: è ciò che allinea la schermata a quello
        // che l'altra segreteria ha appena scritto.
        expect(onRicarica).toHaveBeenCalledTimes(1)
    })

    it('…ma se la riga RUNTIME è nata adesso, qualcosa è successo davvero', async () => {
        // Il controllo positivo del ramo qui sopra: senza, «gia-presente»
        // silenzierebbe anche il caso in cui l'accesso è stato appena creato.
        fetchMock
            .mockResolvedValueOnce(risposta(ELENCO))
            .mockResolvedValueOnce(risposta({ ok: true, parentId: ADULTO_2, anagrafica: 'gia-presente', runtime: 'creato' }))
        await collegaIlPrimo()

        expect(await screen.findByText(itAdminStudents.legamiCollegato)).toBeInTheDocument()
    })

    it('⚠️ `non-scritto` vince su tutto: il genitore vedrebbe il figlio e non i suoi pagamenti', async () => {
        fetchMock
            .mockResolvedValueOnce(risposta(ELENCO))
            .mockResolvedValueOnce(risposta({ ok: true, parentId: ADULTO_2, anagrafica: 'gia-presente', runtime: 'non-scritto' }))
        await collegaIlPrimo()

        expect(await screen.findByText(itAdminStudents.legamiRuntimeNonScritto)).toBeInTheDocument()
    })
})

describe('Il capo fisso che manca — si sparisce, non si tace', () => {
    it('⚠️ senza `alunnoId` il blocco NON si rende, e lascia una riga di log', () => {
        // Nei due punti di montaggio di oggi non succede. Ma un pulsante reso e
        // inerte — `aria-disabled` e basta — al clic non apriva niente e non
        // diceva niente: silenzio totale, la forma di guasto che AGENTS.md vieta.
        render(
            <GestoreLegami verso="genitori" alunnoId={null} nomeFisso={NOME_BAMBINO} collegati={[MADRE]} onRicarica={onRicarica} />,
        )

        expect(screen.queryByTestId('gestore-legami')).toBeNull()
        expect(screen.queryByRole('button', { name: itAdminStudents.legamiAggiungiFamiliare })).toBeNull()
        expect(logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', messaggio: expect.stringContaining('legami-capo-mancante') }),
        )
    })

    it('…col capo al suo posto il blocco c’è (senza questa, la prova qui sopra è vuota)', () => {
        schedaBambino()
        expect(screen.getByTestId('gestore-legami')).toBeInTheDocument()
        expect(logClient).not.toHaveBeenCalledWith(
            expect.objectContaining({ messaggio: expect.stringContaining('legami-capo-mancante') }),
        )
    })
})

describe('Scollega — la conferma dice CHE COSA SI PERDE', () => {
    it('il primo clic NON scollega: apre la conferma, e la conferma nomina i due', async () => {
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiScollega }))

        // Nessuna scrittura al primo clic: è una conferma, non un secondo pulsante.
        expect(fetchMock).not.toHaveBeenCalled()
        const dialogo = within(await screen.findByRole('dialog'))
        expect(
            dialogo.getByText(`${NOME_ADULTO}: non vedrà più il diario, la galleria, i pagamenti e i messaggi di ${NOME_BAMBINO}.`),
        ).toBeInTheDocument()
        // Il contrappeso: senza, la frase qui sopra si legge come «cancella l'adulto».
        expect(dialogo.getByText(itAdminStudents.legamiScollegaResta)).toBeInTheDocument()
    })

    it('confermando parte lo scollegamento, e poi l’elenco si rilegge', async () => {
        fetchMock.mockResolvedValue(risposta({ ok: true, anagrafica: 'rimossa', runtime: 'rimosso' }))
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiScollega }))
        const dialogo = within(await screen.findByRole('dialog'))
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiScollegaConferma }))

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        expect(corpoDi(0)).toEqual({ azione: 'scollega', alunno_id: ALUNNO, parent_id: ADULTO })
        await waitFor(() => expect(onRicarica).toHaveBeenCalledTimes(1))
        expect(await screen.findByText(itAdminStudents.legamiScollegato)).toBeInTheDocument()
    })

    it('⚠️ il 409 dell’ULTIMO GENITORE è una PROTEZIONE: dice il rimedio e ritira il comando', async () => {
        fetchMock.mockResolvedValue(
            risposta(
                { error: 'prosa del server', codice: 'LEGAME_ULTIMO_GENITORE' },
                false,
                409,
            ),
        )
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiScollega }))
        const dialogo = within(await screen.findByRole('dialog'))
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiScollegaConferma }))

        // Il testo è quello di CATALOGO, che porta il rimedio: «collega prima
        // l'altro genitore, poi scollega questo». La prosa del server non vince.
        const riquadro = await screen.findByTestId('legami-protezione')
        expect(riquadro).toHaveTextContent(itShared.erroreLegameUltimoGenitore)
        expect(riquadro).toHaveTextContent(itAdminStudents.legamiProtezioneTitolo)
        expect(riquadro).not.toHaveTextContent('prosa del server')

        // Il comando SPARISCE: ripremerlo darebbe lo stesso identico rifiuto, ed è
        // il modo di far leggere una protezione come un guasto.
        expect(within(screen.getByRole('dialog')).queryByRole('button', { name: itAdminStudents.legamiScollegaConferma })).toBeNull()
        // E il dialogo resta aperto: il rimedio è scritto lì dentro.
        expect(screen.getByRole('dialog')).toBeInTheDocument()
        // Un rifiuto previsto non è un guasto: in `app_log` va a `warn`, non fra le
        // righe che qualcuno guarda quando qualcosa è rotto.
        expect(logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'warn', stato: 409 }),
        )
    })

    it('⚠️ il 500 MEZZO TOLTO dice che l’accesso è GIÀ andato, e non «riprova, non è successo niente»', async () => {
        // `LEGAME_MEZZO_TOLTO` è l'unico rifiuto dopo il quale qualcosa È
        // cambiato: la riga di `legame_genitori_alunni` — quella che le policy RLS
        // di pagamenti, incassi e note interrogano — è già sparita, quella di
        // `student_parents` no. Cioè quell'adulto ha GIÀ perso la vista sui dati di
        // quel minore mentre l'elenco continua a mostrarlo collegato. Dipingerlo
        // come gli altri 500 («niente è stato modificato, riprova») direbbe il
        // contrario del vero proprio nell'istante che conta.
        fetchMock.mockResolvedValue(
            risposta({ error: 'prosa del server', codice: 'LEGAME_MEZZO_TOLTO' }, false, 500),
        )
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiScollega }))
        const dialogo = within(await screen.findByRole('dialog'))
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiScollegaConferma }))

        const riquadro = await screen.findByTestId('legami-mezzo-tolto')
        expect(riquadro).toHaveTextContent(itAdminStudents.legamiMezzoToltoTitolo)
        // Il testo è quello di CATALOGO, che porta il rimedio: riprovare fra
        // qualche istante. La prosa del server non vince.
        expect(riquadro).toHaveTextContent(itShared.erroreLegameMezzoTolto)
        expect(riquadro).not.toHaveTextContent('prosa del server')
        // Il comando RESTA — al contrario della protezione dell'ultimo genitore:
        // qui ripetere lo scollegamento è esattamente il rimedio.
        expect(
            within(screen.getByRole('dialog')).getByRole('button', { name: itAdminStudents.legamiScollegaConferma }),
        ).toBeInTheDocument()
        // Lo stato sul server è cambiato, quindi l'elenco si rilegge: ripartire da
        // quello vecchio manda il gesto successivo su un 404.
        await waitFor(() => expect(onRicarica).toHaveBeenCalledTimes(1))
    })

    it('⚠️ …e chiuso il dialogo il fatto RESTA a schermo (senza, di un accesso tolto non c’è più traccia)', async () => {
        // È la metà che conta: il riquadro qui sopra vive dentro un modale che si
        // chiude con «Annulla», e l'elenco — che legge `student_parents` — dopo la
        // rilettura mostra quell'adulto esattamente come prima. Senza la riga di
        // stato fuori dal dialogo, l'unico posto in cui è scritto che un adulto ha
        // perso l'accesso ai dati di un minore è `app_log`.
        fetchMock.mockResolvedValue(
            risposta({ error: 'prosa del server', codice: 'LEGAME_MEZZO_TOLTO' }, false, 500),
        )
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiScollega }))
        const dialogo = within(await screen.findByRole('dialog'))
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiScollegaConferma }))
        await screen.findByTestId('legami-mezzo-tolto')

        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: itAdminStudents.legamiAnnulla }))

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
        expect(screen.getByText(itShared.erroreLegameMezzoTolto)).toBeInTheDocument()
    })

    it('…mentre un 500 qualunque il dialogo lo dice e basta (senza questa, le due prove qui sopra sono vuote)', async () => {
        // Il controllo positivo: `LEGAME_NON_SALVATO` significa davvero «niente è
        // cambiato». Niente riquadro dedicato, nessuna rilettura dell'elenco, e
        // chiudendo non resta nessun avviso — perché non c'è nessun fatto nuovo da
        // ricordare.
        fetchMock.mockResolvedValue(
            risposta({ error: 'prosa del server', codice: 'LEGAME_NON_SALVATO' }, false, 500),
        )
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiScollega }))
        const dialogo = within(await screen.findByRole('dialog'))
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiScollegaConferma }))

        expect(await screen.findByText(itShared.erroreLegameNonSalvato)).toBeInTheDocument()
        expect(screen.queryByTestId('legami-mezzo-tolto')).toBeNull()
        expect(onRicarica).not.toHaveBeenCalled()

        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: itAdminStudents.legamiAnnulla }))
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
        expect(screen.queryByText(itShared.erroreLegameNonSalvato)).toBeNull()
    })
})

describe('Il ruolo — quello che in archivio non c’è non si inventa', () => {
    it('un `relation_type` nullo si mostra «non indicato», non «Madre»', () => {
        // In produzione `student_parents.relation_type` è `null` su 579 righe: una
        // tendina con tre sole voci affermerebbe un ruolo che nessuno ha scritto.
        schedaBambino([{ id: ADULTO, nome: NOME_ADULTO, ruolo: null }])
        const tendina = screen.getByLabelText(`Ruolo di ${NOME_ADULTO}`) as HTMLSelectElement
        expect(tendina.value).toBe('')
        expect(within(tendina).getByText(itAdminStudents.legamiRuoloNonIndicato)).toBeInTheDocument()
    })

    it('cambiare la tendina scrive il ruolo e rilegge l’elenco', async () => {
        fetchMock.mockResolvedValue(risposta({ ok: true, relation_type: 'father', is_primary: true }))
        schedaBambino()
        fireEvent.change(screen.getByLabelText(`Ruolo di ${NOME_ADULTO}`), { target: { value: 'father' } })

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        expect(corpoDi(0)).toEqual({
            azione: 'cambia-ruolo',
            alunno_id: ALUNNO,
            parent_id: ADULTO,
            relation_type: 'father',
        })
        await waitFor(() => expect(onRicarica).toHaveBeenCalledTimes(1))
        expect(await screen.findByText(itAdminStudents.legamiRuoloSalvato)).toBeInTheDocument()
    })
})

describe('La scheda dell’ADULTO — stesso legame, verso opposto', () => {
    it('cerca fra i BAMBINI e non fra gli adulti', async () => {
        fetchMock.mockResolvedValue(risposta({ alunni: [] }))
        schedaAdulto()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiAggiungiFiglio }))
        fireEvent.change(await screen.findByLabelText(itAdminStudents.legamiCercaEtichetta), {
            target: { value: 'bi' },
        })

        await waitFor(() => expect(fetchMock).toHaveBeenCalled())
        expect(urlDi(0)).toContain('tipo=alunni')
        expect(urlDi(0)).toContain(`parent_id=${ADULTO}`)
        // Un BAMBINO non si crea da qui: la sua anagrafica ha una sede, una classe
        // e dei consensi, e nasce dalla sua scheda.
        expect(screen.queryByText(itAdminStudents.legamiNuovoApri)).toBeNull()
    })

    it('⚠️ anche SCOLLEGANDO da qui i due uuid stanno al loro posto, e la conferma non scambia i nomi', async () => {
        // La prova che mancava al primo giro, ed è stata la prova negativa a
        // dirlo: invertendo i due capi nel verso `alunni`, tredici test restavano
        // verdi — perché lo scollegamento e il cambio ruolo erano misurati solo
        // sulla scheda del BAMBINO, dove l'inversione non si vede.
        fetchMock.mockResolvedValue(risposta({ ok: true, anagrafica: 'rimossa', runtime: 'rimosso' }))
        schedaAdulto([{ id: ALUNNO_2, nome: NOME_BAMBINO, dettaglio: 'Primavera A', ruolo: 'mother' }])
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiScollega }))

        const dialogo = within(await screen.findByRole('dialog'))
        // Chi perde è l'ADULTO della scheda, e a perdere di vista è il BAMBINO
        // della riga: la frase deve restare nello stesso verso anche di qua.
        expect(
            dialogo.getByText(`${NOME_ADULTO}: non vedrà più il diario, la galleria, i pagamenti e i messaggi di ${NOME_BAMBINO}.`),
        ).toBeInTheDocument()

        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiScollegaConferma }))
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        expect(corpoDi(0)).toEqual({ azione: 'scollega', alunno_id: ALUNNO_2, parent_id: ADULTO })
    })

    it('⚠️ i due uuid non si invertono: `alunno_id` è il bambino scelto, `parent_id` l’adulto della scheda', async () => {
        fetchMock
            .mockResolvedValueOnce(
                risposta({ alunni: [{ id: ALUNNO_2, nome: 'Anna', cognome: 'Bianchi', classe_sezione: 'Primavera A', gia_collegato: false }] }),
            )
            .mockResolvedValueOnce(risposta({ ok: true, parentId: ADULTO, anagrafica: 'creata', runtime: 'creato' }))

        schedaAdulto()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiAggiungiFiglio }))
        fireEvent.change(await screen.findByLabelText(itAdminStudents.legamiCercaEtichetta), {
            target: { value: 'bi' },
        })
        const dialogo = within(await screen.findByRole('dialog'))
        fireEvent.click(await dialogo.findByRole('button', { name: /Bianchi Anna/ }))
        fireEvent.change(dialogo.getByLabelText(itAdminStudents.legamiRuoloEtichetta), {
            target: { value: 'delegate' },
        })
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiCollega }))

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
        expect(corpoDi(1)).toEqual({
            azione: 'collega',
            alunno_id: ALUNNO_2,
            parent_id: ADULTO,
            relation_type: 'delegate',
        })
    })
})

describe('L’adulto che in archivio non c’è', () => {
    /**
     * ⚠️ LE RISPOSTE DI QUESTO BLOCCO SONO QUELLE MISURATE SULLA ROTTA VERA, e non
     * è un dettaglio del doppio: fino al terzo giro di questo lavoro qui si fingeva
     * `anagrafica: 'creata', runtime: 'creato'` — una coppia che il ramo `genitore:`
     * NON produce mai. Sul ramo dell'adulto nuovo `linkOrCreateParent` fa l'upsert
     * su `student_parents` PRIMA che `collegaFamiliare` legga la stessa riga,
     * quindi `anagrafica` esce sempre `gia-presente`; il `runtime` è `gia-presente`
     * con un'email (l'identità nasce lì) e `senza-account` senza.
     *
     * Le due coppie sono fissate alla sorgente, contro la rotta e con
     * `linkOrCreateParent` vero, in
     * `__tests__/api/legami-familiari-ui-contratto-creazione.test.ts`. Un doppio che
     * inventa il contratto del fornitore resta verde con e senza il difetto — è la
     * trappola già pagata con Aruba — e infatti questo test lo era.
     */
    const CREATA_CON_EMAIL = { ok: true, parentId: ADULTO_2, anagrafica: 'gia-presente', runtime: 'gia-presente' }
    const CREATA_SENZA_EMAIL = { ok: true, parentId: ADULTO_2, anagrafica: 'gia-presente', runtime: 'senza-account' }

    it('crea l’anagrafica e la collega nella stessa chiamata, dicendo che parte un’email', async () => {
        fetchMock.mockResolvedValue(risposta(CREATA_CON_EMAIL))
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiAggiungiFamiliare }))
        const dialogo = within(await screen.findByRole('dialog'))
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiNuovoApri }))

        // Con un'email il server crea anche l'identità di accesso e MANDA le
        // credenziali: è una email vera verso una famiglia vera, e si dice prima.
        expect(dialogo.getByText(itAdminStudents.legamiNuovoCredenziali)).toBeInTheDocument()

        fireEvent.change(dialogo.getByLabelText(itAdminStudents.legamiNuovoNome), { target: { value: 'Carla' } })
        fireEvent.change(dialogo.getByLabelText(itAdminStudents.legamiNuovoCognome), { target: { value: 'Verdi' } })
        fireEvent.change(dialogo.getByLabelText(itAdminStudents.legamiRuoloEtichetta), { target: { value: 'mother' } })
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiCollega }))

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        // Le chiavi sono quelle di `buildParentRecord` (`phones`, `emails`), non i
        // nomi delle colonne: ribattere la mappa qui creerebbe una seconda lista
        // bianca libera di divergere.
        expect(corpoDi(0)).toEqual({
            azione: 'collega',
            alunno_id: ALUNNO,
            relation_type: 'mother',
            genitore: { first_name: 'Carla', last_name: 'Verdi', fiscal_code: '', emails: [], phones: [] },
        })
        // ⚠️ E SI GUARDA CHE COSA LEGGE L'OPERATORE, non solo che cosa è partito.
        // Il `gia-presente` della risposta qui è un artefatto dell'ordine delle
        // scritture, non un'informazione: annunciarlo direbbe «non è stato aggiunto
        // niente di nuovo» subito dopo aver creato un'anagrafica e spedito
        // credenziali vere a una famiglia vera.
        expect(await screen.findByText(itAdminStudents.legamiCollegato)).toBeInTheDocument()
        expect(screen.queryByText(itAdminStudents.legamiGiaPresente)).toBeNull()
        expect(onRicarica).toHaveBeenCalledTimes(1)
    })

    it('⚠️ un adulto nuovo SENZA email: si dice «senza account», che è l’unica cosa da fare', async () => {
        // Il caso che il ramo `gia-presente` copriva per intero: senza email non
        // nasce nessuna identità, quindi la riga runtime non c'è e il genitore non
        // vedrà niente finché la Segreteria non gli manda le credenziali. È
        // l'unica informazione azionabile di questo percorso, e va detta.
        fetchMock.mockResolvedValue(risposta(CREATA_SENZA_EMAIL))
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiAggiungiFamiliare }))
        const dialogo = within(await screen.findByRole('dialog'))
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiNuovoApri }))
        fireEvent.change(dialogo.getByLabelText(itAdminStudents.legamiNuovoNome), { target: { value: 'Carla' } })
        fireEvent.change(dialogo.getByLabelText(itAdminStudents.legamiNuovoCognome), { target: { value: 'Verdi' } })
        fireEvent.change(dialogo.getByLabelText(itAdminStudents.legamiRuoloEtichetta), { target: { value: 'mother' } })
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiCollega }))

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        expect(await screen.findByText(itAdminStudents.legamiSenzaAccount)).toBeInTheDocument()
        expect(screen.queryByText(itAdminStudents.legamiGiaPresente)).toBeNull()
    })

    /**
     * Apre «Aggiungi familiare» → «crea un adulto nuovo», compila il minimo che
     * accende il comando e preme «Collega». La POST è l'UNICA fetch di questo
     * percorso: su questo ramo non c'è nessuna ricerca prima.
     */
    const creaAdultoNuovo = async ({ cf = '', email = '' }: { cf?: string; email?: string } = {}) => {
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiAggiungiFamiliare }))
        const dialogo = within(await screen.findByRole('dialog'))
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiNuovoApri }))
        fireEvent.change(dialogo.getByLabelText(itAdminStudents.legamiNuovoNome), { target: { value: 'Carla' } })
        fireEvent.change(dialogo.getByLabelText(itAdminStudents.legamiNuovoCognome), { target: { value: 'Verdi' } })
        if (cf) fireEvent.change(dialogo.getByLabelText(itAdminStudents.legamiNuovoCf), { target: { value: cf } })
        if (email) fireEvent.change(dialogo.getByLabelText(itAdminStudents.legamiNuovoEmail), { target: { value: email } })
        fireEvent.change(dialogo.getByLabelText(itAdminStudents.legamiRuoloEtichetta), { target: { value: 'mother' } })
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiCollega }))
        return dialogo
    }

    it('⚠️ col CF di un adulto GIÀ NELL’ELENCO non si annuncia «Collegamento salvato»', async () => {
        // IL CASO CHE `anagrafica` NON SA RACCONTARE. L'operatore non trova
        // l'adulto in ricerca (l'ha cercato per cognome, o l'ha scritto storto),
        // apre «crea un adulto nuovo» e digita il codice fiscale di chi a questo
        // bambino è GIÀ collegato: `linkOrCreateParent` deduplica, l'upsert non
        // aggiunge niente, e la rotta risponde `gia-presente` — la stessa parola
        // che risponde quando l'anagrafica l'ha appena creata lei.
        //
        // A distinguerli resta l'uuid: `parentId` è MADRE, che l'elenco qui sotto
        // ha già. Il caso è fissato sulla rotta VERA (nessun doppio) in
        // `__tests__/api/legami-familiari-ui-contratto-creazione.test.ts`.
        fetchMock.mockResolvedValue(
            risposta({ ok: true, parentId: ADULTO, anagrafica: 'gia-presente', runtime: 'gia-presente' }),
        )
        await creaAdultoNuovo({ cf: 'AAAAAA00A00A000A' })

        expect(await screen.findByText(itAdminStudents.legamiGiaPresente)).toBeInTheDocument()
        expect(screen.queryByText(itAdminStudents.legamiCollegato)).toBeNull()
        // L'elenco si rilegge lo stesso: allinea la schermata a ciò che c'è davvero.
        expect(onRicarica).toHaveBeenCalledTimes(1)
    })

    // Il CONTROLLO POSITIVO di questo ramo è il primo test del blocco («crea
    // l'anagrafica e la collega…»): là `parentId` è un uuid che nell'elenco NON
    // c'è, e la frase è «Collegamento salvato». Senza quella prova, la regola qui
    // sopra sarebbe verde anche su una schermata che dice «c'era già» sempre.

    it('⚠️ era già collegato ma l’ACCESSO è nato adesso: non si dice «niente di nuovo»', async () => {
        // L'adulto era collegato e non aveva un account (64 anagrafiche su 747
        // stanno così). Col codice fiscale e un'email, `linkOrCreateParent` crea
        // l'identità e SPEDISCE le credenziali: dire «non è stato aggiunto niente
        // di nuovo» negherebbe una email partita davvero verso una famiglia vera.
        fetchMock.mockResolvedValue(
            risposta({ ok: true, parentId: ADULTO, anagrafica: 'gia-presente', runtime: 'creato' }),
        )
        await creaAdultoNuovo({ cf: 'AAAAAA00A00A000A', email: 'adulta.diprova@example.invalid' })

        expect(await screen.findByText(itAdminStudents.legamiNuovoAccessoCreato)).toBeInTheDocument()
        expect(screen.queryByText(itAdminStudents.legamiGiaPresente)).toBeNull()
    })

    it('⚠️ `LEGAME_ADULTO_FORSE_CREATO` NON ripete «niente è stato modificato»', async () => {
        // Il rifiuto arriva DOPO `linkOrCreateParent`: l'anagrafica dell'adulto
        // può essere già nata e, con un'email, le credenziali possono essere già
        // partite. Chi legge «niente è stato modificato» riprova — seconda
        // anagrafica, seconda email verso la stessa famiglia. Il dialogo resta
        // aperto e dice l'unica cosa utile: non ripetere, riapri e controlla.
        //
        // ⚠️ IL CODICE È QUELLO CHE LA ROTTA MANDA DAVVERO SU QUESTO RAMO (dal
        // 2026-09-06): non `LEGAME_NON_SALVATO`, che è il codice del caso opposto
        // — scrittura respinta e niente cambiato. Lo fissa contro la rotta VERA
        // `__tests__/api/legami-familiari-ui-contratto-creazione.test.ts`, perché
        // un doppio che scegliesse il codice da sé renderebbe questa prova verde
        // anche il giorno in cui la rotta smettesse di distinguere i due rami.
        fetchMock.mockResolvedValue(
            risposta(
                {
                    error: 'L’anagrafica dell’adulto è stata salvata, ma il collegamento al bambino non è confermato: ricarica la scheda prima di riprovare.',
                    codice: 'LEGAME_ADULTO_FORSE_CREATO',
                },
                false,
                500,
            ),
        )
        const dialogo = await creaAdultoNuovo({ email: 'adulta.diprova@example.invalid' })

        expect(await dialogo.findByText(itAdminStudents.legamiNuovoEsitoIncerto)).toBeInTheDocument()
        expect(screen.queryByText(itShared.erroreLegameAdultoForseCreato)).toBeNull()
        // Il dialogo NON si chiude e l'elenco NON si rilegge: non è successo un
        // collegamento, è successo un dubbio.
        expect(onRicarica).not.toHaveBeenCalled()
        // La riga che nei log del server non c'è: là il guasto risulta, ma non
        // risulta che a schermo qualcuno stesse per creare un doppione.
        expect(logClient).toHaveBeenCalledWith(
            expect.objectContaining({
                livello: 'error',
                evento: 'fetch',
                messaggio: expect.stringContaining('legami-collega-nuovo-esito-incerto'),
                stato: 500,
            }),
        )
        // …e nei log non finisce nessuna anagrafica: né il nome né l'indirizzo.
        const scritto = JSON.stringify(logClient.mock.calls)
        expect(scritto).not.toContain('Carla')
        expect(scritto).not.toContain('example.invalid')
    })

    it('⚠️ …ma un ALTRO 500 sullo STESSO ramo non si traveste da «forse creato»', async () => {
        // IL CONTROLLO CHE LA VECCHIA RISERVA RENDEVA IMPOSSIBILE. Fino al
        // 2026-09-06 la schermata deduceva da sé («`modo === 'nuovo'` e status
        // ≥ 500»), quindi QUALUNQUE 500 di questo percorso diventava «l'anagrafica
        // potrebbe essere già stata creata, non ripetere».
        //
        // Non tutti lo sono: la rotta risponde 500 `LETTURA_FALLITA` anche PRIMA
        // di toccare qualsiasi cosa — la sede del bambino non letta, `route.ts`
        // → `sede-bambino-non-letta`, che sta sopra al ramo `collega` e quindi
        // sopra a `linkOrCreateParent`. Là non è nata nessuna anagrafica e non è
        // partita nessuna email: dire «non ripetere la creazione» toglie
        // all'operatore l'unica cosa da fare (riprovare) e gli lascia in mano un
        // modulo compilato che non spedirà mai.
        fetchMock.mockResolvedValue(
            risposta({ error: 'Non è stato possibile leggere i dati.', codice: 'LETTURA_FALLITA' }, false, 500),
        )
        const dialogo = await creaAdultoNuovo({ email: 'adulta.diprova@example.invalid' })

        expect(await dialogo.findByText(itShared.erroreLetturaFallita)).toBeInTheDocument()
        expect(screen.queryByText(itAdminStudents.legamiNuovoEsitoIncerto)).toBeNull()
        // E nemmeno la riga di log del doppione: quel messaggio serve a cercare
        // i casi in cui un'anagrafica può essere nata, e qui non è nata.
        expect(logClient).not.toHaveBeenCalledWith(
            expect.objectContaining({ messaggio: expect.stringContaining('legami-collega-nuovo-esito-incerto') }),
        )
    })

    it('…ma sul ramo della RICERCA il 500 resta quello del server (senza questa, la prova qui sopra è vuota)', async () => {
        // La deroga è NARROW e va tenuta tale: qui nessuna anagrafica è stata
        // creata — si è scelto un adulto che in archivio c'era già — e «niente è
        // stato modificato» è vero. Sostituire la prosa del server anche qui
        // vorrebbe dire spegnere l'unica frase che sa che cosa è successo.
        fetchMock
            .mockResolvedValueOnce(
                risposta({
                    genitori: [
                        { id: ADULTO_2, first_name: 'Carla', last_name: 'Verdi', fiscal_code: null, emails: [], ha_account: true, gia_collegato: false },
                    ],
                }),
            )
            .mockResolvedValueOnce(
                risposta(
                    { error: 'Il collegamento non è stato salvato: niente è stato modificato.', codice: 'LEGAME_NON_SALVATO' },
                    false,
                    500,
                ),
            )
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiAggiungiFamiliare }))
        fireEvent.change(await screen.findByLabelText(itAdminStudents.legamiCercaEtichetta), { target: { value: 've' } })
        const dialogo = within(await screen.findByRole('dialog'))
        fireEvent.click(await dialogo.findByRole('button', { name: /Verdi Carla/ }))
        fireEvent.change(dialogo.getByLabelText(itAdminStudents.legamiRuoloEtichetta), { target: { value: 'mother' } })
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiCollega }))

        expect(await dialogo.findByText(itShared.erroreLegameNonSalvato)).toBeInTheDocument()
        expect(screen.queryByText(itAdminStudents.legamiNuovoEsitoIncerto)).toBeNull()
    })

    it('senza nome e cognome non parte niente: il comando resta spento', async () => {
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiAggiungiFamiliare }))
        const dialogo = within(await screen.findByRole('dialog'))
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiNuovoApri }))
        fireEvent.change(dialogo.getByLabelText(itAdminStudents.legamiRuoloEtichetta), { target: { value: 'mother' } })

        const collega = dialogo.getByRole('button', { name: itAdminStudents.legamiCollega })
        expect(collega).toHaveAttribute('aria-disabled', 'true')
        fireEvent.click(collega)
        expect(fetchMock).not.toHaveBeenCalled()
    })
})

describe('La SCRITTURA con il corpo illeggibile — «non ho potuto leggere» non è «è andata bene»', () => {
    /**
     * Il gemello, sulla POST, della prova già fatta sulla ricerca. Un 200 il cui
     * corpo non si legge (proxy che restituisce HTML, risposta troncata,
     * `Content-Type` sbagliato) finiva in `(letto ?? {})`: un esito vuoto passa
     * indenne per ogni ramo e cade sull'ultimo — «Collegamento salvato» — senza
     * una riga di log. Quello che si perde in silenzio è `runtime: 'non-scritto'`,
     * cioè il caso in cui il genitore vedrebbe il figlio in anagrafica e NON i
     * suoi pagamenti.
     */
    const duecentoIlleggibile = () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
            throw new Error('non JSON')
        },
    })

    it('⚠️ sul cambio ruolo non si annuncia un esito che nessuno ha letto', async () => {
        fetchMock.mockResolvedValue(duecentoIlleggibile())
        schedaBambino()
        fireEvent.change(screen.getByLabelText(`Ruolo di ${NOME_ADULTO}`), { target: { value: 'father' } })

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        expect(await screen.findByText(itAdminStudents.legamiEsitoNonLetto)).toBeInTheDocument()
        expect(screen.queryByText(itAdminStudents.legamiRuoloSalvato)).toBeNull()
        // La riga che nessun log del server scriverà mai: là la richiesta risulta
        // riuscita. `warn` perché il server ha risposto, e ha risposto 200.
        expect(logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'warn', stato: 200, messaggio: expect.stringContaining('corpo-illeggibile') }),
        )
        // L'elenco si rilegge lo stesso: con un 200 la scrittura quasi certamente
        // c'è stata, e un elenco vecchio manda il gesto dopo su un 404.
        await waitFor(() => expect(onRicarica).toHaveBeenCalledTimes(1))
    })

    it('⚠️ e sul collegamento nemmeno: niente «Collegamento salvato» su una risposta muta', async () => {
        fetchMock
            .mockResolvedValueOnce(
                risposta({
                    genitori: [
                        { id: ADULTO_2, first_name: 'Carla', last_name: 'Verdi', fiscal_code: null, emails: [], ha_account: true, gia_collegato: false },
                    ],
                }),
            )
            .mockResolvedValueOnce(duecentoIlleggibile())

        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiAggiungiFamiliare }))
        fireEvent.change(await screen.findByLabelText(itAdminStudents.legamiCercaEtichetta), { target: { value: 've' } })
        const dialogo = within(await screen.findByRole('dialog'))
        fireEvent.click(await dialogo.findByRole('button', { name: /Verdi Carla/ }))
        fireEvent.change(dialogo.getByLabelText(itAdminStudents.legamiRuoloEtichetta), { target: { value: 'mother' } })
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiCollega }))

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
        expect(await screen.findByText(itAdminStudents.legamiEsitoNonLetto)).toBeInTheDocument()
        expect(screen.queryByText(itAdminStudents.legamiCollegato)).toBeNull()
        expect(onRicarica).toHaveBeenCalledTimes(1)
    })

    it('⚠️ e sullo SCOLLEGAMENTO: il dialogo si chiude, ma non si dice «Collegamento tolto»', async () => {
        // Qui il ramo è un altro (`confermaScollegamento`), e la differenza conta:
        // il dialogo si chiude comunque — con un 200 il legame quasi certamente non
        // c'è più, e tenerlo aperto inviterebbe a ripetere il gesto — ma la riga di
        // stato dice che l'esito non si è potuto leggere.
        fetchMock.mockResolvedValue(duecentoIlleggibile())
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiScollega }))
        const dialogo = within(await screen.findByRole('dialog'))
        fireEvent.click(dialogo.getByRole('button', { name: itAdminStudents.legamiScollegaConferma }))

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        expect(await screen.findByText(itAdminStudents.legamiEsitoNonLetto)).toBeInTheDocument()
        expect(screen.queryByText(itAdminStudents.legamiScollegato)).toBeNull()
        await waitFor(() => expect(onRicarica).toHaveBeenCalledTimes(1))
    })
})

describe('Accessibilità — i comandi nuovi non arrivano muti', () => {
    /**
     * ⚠️ Le fixture di `schede-alunno-a11y.test.tsx` non hanno `student_parents`:
     * axe, là, queste righe non le vede mai. La tendina del ruolo è nominata da un
     * `aria-label` e non da un `<label for>` (una riga per legame vorrebbe dire un
     * `id` per legame, dentro schede che ne montano già decine): un `aria-label`
     * dimenticato la lascerebbe annunciata «menu a discesa» e basta, che su tre
     * righe identiche è esattamente WCAG 4.1.2.
     */
    it('l’elenco con le sue righe non ha violazioni', async () => {
        const { container } = schedaBambino([
            { id: ADULTO, nome: NOME_ADULTO, dettaglio: 'Codice fiscale', ruolo: 'mother' },
            { id: ADULTO_2, nome: 'Verdi Carla', dettaglio: null, ruolo: null },
        ])
        expect(await axe(container, axeOpts)).toHaveNoViolations()
    })

    it('il dialogo di scollegamento non ha violazioni', async () => {
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiScollega }))
        const dialogo = await screen.findByRole('dialog')
        expect(await axe(dialogo, axeOpts)).toHaveNoViolations()
    })

    it('il dialogo «aggiungi», coi campi dell’adulto nuovo aperti, non ha violazioni', async () => {
        schedaBambino()
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.legamiAggiungiFamiliare }))
        const dialogo = await screen.findByRole('dialog')
        // Il ramo dei campi si APRE prima di misurare: quello che non è nel DOM axe
        // non lo guarda, ed è il modo in cui un lock promette e resta verde.
        fireEvent.click(within(dialogo).getByRole('button', { name: itAdminStudents.legamiNuovoApri }))
        expect(await axe(dialogo, axeOpts)).toHaveNoViolations()
    })
})
