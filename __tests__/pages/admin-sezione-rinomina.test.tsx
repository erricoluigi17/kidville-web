import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import itAdmin from '../../messages/it/adminStudents.json'
import enAdmin from '../../messages/en/adminStudents.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

/**
 * T7 — «I nomi della sezione devono essere modificabili dalla segreteria e
 * direzione». Il backend c'era già per intero (`PATCH /api/admin/sections`:
 * allowlist `{id, name?, school_type?}`, gate di sede a mano, 409 sull'omonimia
 * dentro la sede, audit): mancava il pulsante.
 *
 * ─── PERCHÉ QUI E NON IN `SectionsView` ─────────────────────────────────────
 * Nella griglia dell'elenco ogni card È un `<Link>`: un pulsante dentro
 * un'ancora è un controllo dentro un controllo (e il click porterebbe via la
 * pagina). Qui invece il riquadro «Impostazioni Sezione» tiene già il grado e la
 * sede, cioè le altre due proprietà della stessa riga, e la PATCH ha già il suo
 * pattern (`changeSchoolType`).
 *
 * ─── COSA ASSERISCE QUESTO FILE, E PERCHÉ CIASCUNA COSA ─────────────────────
 *  1. l'avviso su COSA COMPORTA è a schermo PRIMA della conferma, e a quel punto
 *     nessuna PATCH è partita. Rinominare non è cambiare un'etichetta: il nome
 *     della classe è scritto come testo in sette archivi, e oggi il trigger di
 *     produzione ne aggiorna UNO (verificato su `pg_proc` il 2026-09-03: il
 *     corpo installato non nomina né `registro_orario`, né `target_classes`, né
 *     `mensa_class_menu_assignment`). Un avviso che promettesse la propagazione
 *     direbbe il falso a chi lo legge oggi;
 *  2. la PATCH porta il nome NUOVO e SOLO `{id, name}` — mai `scuola_id`, che
 *     nello schema della route è escluso di proposito (era la primitiva che
 *     disarmava tutti gli altri gate di sede);
 *  3. il 409 «nome già usato in questa sede» esce come frase del CATALOGO, non
 *     come prosa del server: la prosa nasce sul server, dove il locale non
 *     esiste, e in un'interfaccia inglese sarebbe italiano (difetto F2 del
 *     collaudo 2026-07-31). Stessa storia per il 403 di un'altra sede;
 *  4. un nome vuoto o di soli spazi non parte, e il posto del messaggio è
 *     RISERVATO: su WebKit un elemento che compare fa risalire il pulsante sotto
 *     il dito (misurato 25px, e 48px su «Lavora con noi», corretto in 5c181ffe).
 *     Si asserisce l'IDENTITÀ DEL NODO prima e dopo: se il messaggio venisse
 *     inserito e tolto, il nodo non sarebbe lo stesso;
 *  5. lo stato di attesa esiste e un secondo click non manda una seconda PATCH;
 *  6. dopo il salvataggio si torna in lettura, col nome nuovo.
 */

const SEZ = 'sez-a-2anni'
const DOCENTE = 'dddddddd-0000-4000-8000-00000000000d'
const NOME_VECCHIO = '2 ANNI'
const NOME_NUOVO = '3 ANNI'
/** La prosa del server sul 409: NON deve arrivare a schermo così com'è. */
const PROSA_409 = 'Esiste già una classe con questo nome in questa sede'

const h = vi.hoisted(() => ({ logClient: vi.fn() }))

vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'TypeError' }))
vi.mock('next/navigation', () => ({ useParams: () => ({ id: SEZ }) }))

const SCOPED = {
    success: true,
    data: [
        {
            scuolaId: SEDE_A,
            scuolaNome: NOME_SEDE_A,
            sezioni: [{ id: SEZ, name: NOME_VECCHIO, school_type: 'infanzia' }],
        },
    ],
}

const DOCENTI = {
    success: true,
    assigned: [{ id: DOCENTE, nome: 'Anna', cognome: 'Bianchi' }],
    available: [{ id: DOCENTE, nome: 'Anna', cognome: 'Bianchi' }],
}

type Risposta = { ok: boolean; status: number; body: unknown }

const fetchMock = vi.fn()

/** L'esito della PATCH, deciso da ogni test. */
let esitoPatch: Risposta
/** Se valorizzata, la PATCH resta appesa finché non la si scioglie a mano. */
let patchInVolo: { risolvi: () => void } | null

beforeEach(() => {
    vi.clearAllMocks()
    esitoPatch = { ok: true, status: 200, body: { id: SEZ, name: NOME_NUOVO } }
    patchInVolo = null
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
        const u = String(url)
        const metodo = init?.method ?? 'GET'
        if (metodo === 'PATCH') {
            const risposta = { ok: esitoPatch.ok, status: esitoPatch.status, json: async () => esitoPatch.body }
            if (patchInVolo) {
                return new Promise((resolve) => {
                    patchInVolo = { risolvi: () => resolve(risposta) }
                })
            }
            return Promise.resolve(risposta)
        }
        if (u.includes('/teachers')) return Promise.resolve({ ok: true, status: 200, json: async () => DOCENTI })
        if (u.includes('/api/admin/sections/scoped')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => SCOPED })
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => [] })
    })
    vi.stubGlobal('fetch', fetchMock)
})

import SezioneDetailPage from '@/app/(dashboard)/admin/students/sezioni/[id]/page'

/**
 * Il riquadro delle impostazioni, come REGIONE con nome accessibile.
 * ⚠️ Si àncora qui e non su `getByText`: «2 ANNI» compare anche nell'intestazione
 * della pagina, e `getByText` pesca i sosia (difetto mascherato due settimane).
 */
const riquadro = () => screen.getByRole('region', { name: itAdmin.sezImpostazioni })

const bottone = (nome: string) => within(riquadro()).getByRole('button', { name: new RegExp(nome, 'i') })
const campoNome = () => within(riquadro()).getByLabelText(itAdmin.secNomeSezione) as HTMLInputElement
/** Il posto RISERVATO al messaggio di vincolo: esiste anche quando è vuoto. */
const postoVincolo = () => document.getElementById('sezione-nome-vincolo')

/** La tendina del grado: è l'unica che offre «nido». */
const tendinaTipo = () =>
    Array.from(document.querySelectorAll('select')).find((s) =>
        Array.from(s.options).some((o) => o.value === 'nido'),
    ) as HTMLSelectElement

async function apri() {
    render(<SezioneDetailPage />)
    await waitFor(() => expect(tendinaTipo()).toBeTruthy())
    expect(screen.getAllByText(NOME_SEDE_A).length).toBeGreaterThan(0)
}

/** Apre il campo di rinomina e ci scrive dentro `nome`. */
async function apriRinomina(nome?: string) {
    await apri()
    fireEvent.click(bottone(itAdmin.sezRinomina))
    await waitFor(() => expect(campoNome()).toBeTruthy())
    if (nome !== undefined) fireEvent.change(campoNome(), { target: { value: nome } })
}

/** Il corpo dell'unica PATCH partita. */
function corpoPatch(): Record<string, unknown> {
    const call = fetchMock.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'PATCH')
    expect(call, 'nessuna PATCH è partita').toBeTruthy()
    return JSON.parse(String((call![1] as { body?: string }).body))
}

const quantePatch = () =>
    fetchMock.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'PATCH').length

describe('Rinomina sezione — la tastiera arriva dove arriva il mouse', () => {
    // ─────────────────────────────────────────────────────────────────────────
    // IL RIQUADRO SCAMBIA DUE ALBERI, E IL FUOCO CADEVA IN TERRA.
    //
    // Lettura e modifica sono due sottoalberi diversi: premendo «Rinomina» il
    // pulsante che si è appena premuto viene SMONTATO, e il fuoco che era su di
    // lui ricade su `<body>`. Misurato dal critico il 2026-09-04: dopo
    // «Rinomina», dopo «Annulla» e dopo il salvataggio, `document.activeElement`
    // era `BODY` tutte e tre le volte.
    //
    // Col mouse non si vede niente. Da tastiera vuol dire ripartire dall'inizio
    // del documento e ridiscendere ogni volta fino a qui; con uno screen reader
    // vuol dire perdere il punto in cui si era, senza che nulla lo annunci.
    //
    // È lo stesso difetto che il commento sul pulsante di conferma dichiara di
    // evitare con `aria-disabled` invece di `disabled`: si evitava nel piccolo e
    // si ripresentava nel grande.
    // ─────────────────────────────────────────────────────────────────────────

    it('aprendo la rinomina il fuoco entra NEL CAMPO, non cade su `body`', async () => {
        await apriRinomina()
        expect(document.activeElement).toBe(campoNome())
    })

    it('annullando il fuoco TORNA sul pulsante che l\'aveva aperta', async () => {
        await apriRinomina()
        fireEvent.click(bottone(itAdmin.annulla))
        await waitFor(() => expect(bottone(itAdmin.sezRinomina)).toBeTruthy())
        expect(document.activeElement).toBe(bottone(itAdmin.sezRinomina))
    })

    it('dopo il salvataggio riuscito il fuoco torna sul pulsante, non su `body`', async () => {
        await apriRinomina(NOME_NUOVO)
        fireEvent.click(bottone(itAdmin.sezRinominaConferma))
        await waitFor(() => expect(bottone(itAdmin.sezRinomina)).toBeTruthy())
        expect(document.activeElement).toBe(bottone(itAdmin.sezRinomina))
    })

    it('INVIO nel campo conferma la rinomina: il silenzio somiglia a un guasto', async () => {
        // Chi scrive un nome in un campo e preme Invio si aspetta che valga.
        // Prima non partiva niente — nessuna PATCH, nessun messaggio, nessun
        // segnale — e un gesto che non produce nulla si legge come un guasto.
        await apriRinomina(NOME_NUOVO)
        fireEvent.submit(campoNome().closest('form')!)

        await waitFor(() => expect(quantePatch()).toBe(1))
        expect(corpoPatch()).toEqual({ id: SEZ, name: NOME_NUOVO })
    })

    it('INVIO su un nome invariato non manda niente: le guardie valgono per entrambe le strade', async () => {
        // Il controllo negativo: il `<form>` non deve aggirare le tre guardie
        // (vuoto · invariato · richiesta in volo) che stanno dentro
        // `rinominaSezione`, altrimenti la tastiera diventa una scorciatoia per
        // fare ciò che col mouse è impedito.
        await apriRinomina()
        fireEvent.submit(campoNome().closest('form')!)
        await new Promise((r) => setTimeout(r, 0))
        expect(quantePatch()).toBe(0)
    })
})

describe('Rinomina sezione — l\'avviso viene PRIMA della conferma', () => {
    it('aprendo la rinomina il campo porta il nome corrente e l\'avviso è già a schermo, senza che sia partito niente', async () => {
        await apriRinomina()

        expect(campoNome().value).toBe(NOME_VECCHIO)
        // L'avviso su cosa comporta: le due metà sono chiavi distinte perché una
        // è durevole (dove è scritto il nome) e l'altra dipende dallo stato del
        // database (oggi la propagazione non c'è).
        const r = riquadro()
        expect(within(r).getByText(itAdmin.sezRinominaAvviso)).toBeInTheDocument()
        expect(within(r).getByText(itAdmin.sezRinominaOggi)).toBeInTheDocument()
        // ⚠️ IL PUNTO: l'avviso si legge PRIMA, non dopo.
        expect(quantePatch()).toBe(0)
    })

    it('l\'avviso di stato dice il vero su ciò che la migrazione fa DAVVERO', async () => {
        // ─────────────────────────────────────────────────────────────────────
        // QUESTO TEST È CAMBIATO IL 2026-09-04, E IL MOTIVO VALE PIÙ DEL TESTO.
        //
        // Fino a stamattina asseriva il contrario: che l'avviso NON promettesse
        // la propagazione, perché la migrazione era scritta ma non applicata e
        // il trigger in produzione toccava solo `alunni`. Applicata la
        // migrazione, quella frase è diventata falsa — e questo test è
        // diventato rosso, che è esattamente ciò per cui era stato scritto.
        //
        // Riscriverlo togliendo l'asserzione sarebbe stato il gesto sbagliato:
        // avrebbe lasciato una chiave deperibile senza nessuno che la sorvegli,
        // e in questo repo un testo che invecchia in silenzio ha già mentito per
        // due settimane. Adesso l'avviso è legato alla MIGRAZIONE, non a una
        // data: finché nel repo c'è il file che propaga, l'avviso deve
        // prometterlo; se qualcuno lo togliesse, la promessa diventerebbe falsa
        // e questa riga lo direbbe.
        // ─────────────────────────────────────────────────────────────────────
        const migrazioni = readdirSync(join(process.cwd(), 'supabase', 'migrations'))
        const propaga = migrazioni.some((f) => /propaga.*rinomina|rinomina.*propaga/i.test(f))

        for (const catalogo of [itAdmin.sezRinominaOggi, enAdmin.sezRinominaOggi]) {
            expect(catalogo.length, 'l\'avviso di stato non può essere vuoto').toBeGreaterThan(20)
        }

        if (propaga) {
            // La propagazione esiste: l'avviso deve dirlo, e deve dire anche il
            // limite vero — resta dentro la SEDE, perché l'omonimia fra plessi
            // è lecita e voluta.
            expect(itAdmin.sezRinominaOggi).toMatch(/propagat/i)
            expect(itAdmin.sezRinominaOggi).toMatch(/sede/i)
            expect(enAdmin.sezRinominaOggi).toMatch(/propagat/i)
            expect(enAdmin.sezRinominaOggi).toMatch(/location/i)
        } else {
            // Nessuna propagazione nel repo: l'avviso non deve prometterla.
            expect(itAdmin.sezRinominaOggi).not.toMatch(/propagat/i)
        }
    })
})

describe('Rinomina sezione — la PATCH', () => {
    it('manda il nome NUOVO, ripulito dagli spazi, e SOLO `{id, name}`', async () => {
        await apriRinomina(`  ${NOME_NUOVO}  `)
        fireEvent.click(bottone(itAdmin.sezRinominaConferma))

        await waitFor(() => expect(quantePatch()).toBe(1))
        const corpo = corpoPatch()
        expect(corpo).toMatchObject({ id: SEZ, name: NOME_NUOVO })
        // ⚠️ `scuola_id` è escluso dallo schema della route di proposito: era la
        // primitiva che spostava una classe di plesso e disarmava gli altri gate.
        // Il client non deve nemmeno provarci.
        expect(Object.keys(corpo).sort()).toEqual(['id', 'name'])
    })

    it('riuscita: si torna in lettura, col nome nuovo, e nessun allarme', async () => {
        await apriRinomina(NOME_NUOVO)
        fireEvent.click(bottone(itAdmin.sezRinominaConferma))

        // Il campo sparisce: si è tornati in lettura.
        await waitFor(() => expect(within(riquadro()).queryByLabelText(itAdmin.secNomeSezione)).toBeNull())
        expect(within(riquadro()).getByText(NOME_NUOVO)).toBeInTheDocument()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(h.logClient).not.toHaveBeenCalled()
    })

    it('durante il salvataggio lo dice, e un secondo click non manda una seconda PATCH', async () => {
        patchInVolo = { risolvi: () => {} }
        await apriRinomina(NOME_NUOVO)
        fireEvent.click(bottone(itAdmin.sezRinominaConferma))

        await waitFor(() => expect(quantePatch()).toBe(1))
        // Mentre la richiesta è in volo il pulsante è un MESSAGGIO, non un
        // controllo spento: `disabled` sposterebbe il fuoco su `<body>` e
        // sbiadirebbe l'unico segnale che il gesto sia partito (nota su `Btn`).
        const conferma = bottone(itAdmin.sezRinominaInCorso)
        expect(conferma).toHaveAttribute('aria-disabled', 'true')
        // Il secondo click non deve raddoppiare la scrittura (né l'audit).
        fireEvent.click(conferma)
        expect(quantePatch()).toBe(1)

        patchInVolo!.risolvi()
        await waitFor(() => expect(within(riquadro()).queryByLabelText(itAdmin.secNomeSezione)).toBeNull())
    })
})

describe('Rinomina sezione — i rifiuti del server, detti in modo comprensibile', () => {
    it('409: la frase è quella del CATALOGO, non la prosa del server, e si resta in modifica', async () => {
        esitoPatch = { ok: false, status: 409, body: { error: PROSA_409 } }
        await apriRinomina(NOME_NUOVO)
        fireEvent.click(bottone(itAdmin.sezRinominaConferma))

        const avviso = await screen.findByRole('alert')
        expect(avviso).toHaveTextContent(itAdmin.sezRinominaDuplicato)
        // ⚠️ La prosa del server NON arriva a schermo: nasce dove il locale non
        // esiste, e in un'interfaccia inglese sarebbe italiano.
        expect(avviso).not.toHaveTextContent(PROSA_409)
        // Il nome digitato resta: su un rifiuto non si perde ciò che si è scritto.
        expect(campoNome().value).toBe(NOME_NUOVO)
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 409 }),
        )
    })

    it('403: dice che la classe è di un altro plesso, e come rimediare', async () => {
        esitoPatch = { ok: false, status: 403, body: { error: 'Questa classe appartiene a un\'altra sede' } }
        await apriRinomina(NOME_NUOVO)
        fireEvent.click(bottone(itAdmin.sezRinominaConferma))

        const avviso = await screen.findByRole('alert')
        expect(avviso).toHaveTextContent(itAdmin.sezRinominaAltraSede)
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 403 }),
        )
    })

    it('500: resta la prosa del server, che qui è l\'unica cosa che dice il motivo', async () => {
        esitoPatch = { ok: false, status: 500, body: { error: 'Lettura della classe non riuscita' } }
        await apriRinomina(NOME_NUOVO)
        fireEvent.click(bottone(itAdmin.sezRinominaConferma))

        const avviso = await screen.findByRole('alert')
        expect(avviso).toHaveTextContent('Lettura della classe non riuscita')
    })

    it('nessun nome di classe nei log: il messaggio è una costante', async () => {
        esitoPatch = { ok: false, status: 409, body: { error: PROSA_409 } }
        await apriRinomina(NOME_NUOVO)
        fireEvent.click(bottone(itAdmin.sezRinominaConferma))

        await screen.findByRole('alert')
        for (const [riga] of h.logClient.mock.calls as [{ messaggio?: string }][]) {
            expect(riga.messaggio ?? '').not.toContain(NOME_NUOVO)
            expect(riga.messaggio ?? '').not.toContain(NOME_VECCHIO)
        }
    })
})

describe('Rinomina sezione — un nome vuoto non parte, e il messaggio ha già il suo posto', () => {
    it('soli spazi: nessuna PATCH, e il vincolo è detto', async () => {
        await apriRinomina('   ')
        fireEvent.click(bottone(itAdmin.sezRinominaConferma))

        expect(quantePatch()).toBe(0)
        expect(postoVincolo()).toHaveTextContent(itAdmin.sezRinominaVuoto)
    })

    it('campo svuotato: nessuna PATCH', async () => {
        await apriRinomina('')
        fireEvent.click(bottone(itAdmin.sezRinominaConferma))

        expect(quantePatch()).toBe(0)
    })

    it('nome invariato: non si scrive niente (nessun audit, nessun trigger per nulla)', async () => {
        await apriRinomina(`  ${NOME_VECCHIO}  `)
        fireEvent.click(bottone(itAdmin.sezRinominaConferma))

        expect(quantePatch()).toBe(0)
    })

    it('⚠️ WebKit: il posto del messaggio è RISERVATO — è lo STESSO NODO, prima e dopo', async () => {
        await apriRinomina()

        const prima = postoVincolo()
        expect(prima, 'il posto del vincolo deve esistere anche quando è vuoto').toBeTruthy()
        expect(prima).toHaveTextContent('')
        // Riserva lo spazio davvero: senza altezza minima il nodo vuoto non
        // occupa niente, e il pulsante sale lo stesso quando il testo compare.
        expect(prima!.className).toMatch(/min-h-/)

        fireEvent.change(campoNome(), { target: { value: ' ' } })

        const dopo = postoVincolo()
        expect(dopo).toHaveTextContent(itAdmin.sezRinominaVuoto)
        // ⚠️ L'IDENTITÀ: se il messaggio fosse inserito e tolto dal DOM, questo
        // sarebbe un nodo diverso — e il pulsante sotto si muoverebbe.
        expect(dopo).toBe(prima)
    })

    it('il campo dichiara il proprio vincolo agli screen reader', async () => {
        await apriRinomina('')
        expect(campoNome().getAttribute('aria-describedby') ?? '').toContain('sezione-nome-vincolo')
        expect(campoNome()).toHaveAttribute('aria-invalid', 'true')
    })
})

describe('Rinomina sezione — annullare', () => {
    it('«Annulla» chiude senza scrivere e senza conservare il nome digitato', async () => {
        await apriRinomina(NOME_NUOVO)
        fireEvent.click(bottone(itAdmin.annulla))

        await waitFor(() => expect(within(riquadro()).queryByLabelText(itAdmin.secNomeSezione)).toBeNull())
        expect(quantePatch()).toBe(0)
        expect(within(riquadro()).getByText(NOME_VECCHIO)).toBeInTheDocument()

        // Riaprendo, il campo riparte dal nome VERO, non dalla bozza scartata.
        fireEvent.click(bottone(itAdmin.sezRinomina))
        await waitFor(() => expect(campoNome().value).toBe(NOME_VECCHIO))
    })
})

describe('Rinomina sezione — i18n', () => {
    it('le chiavi nuove esistono in ENTRAMBI i cataloghi', () => {
        for (const k of [
            'sezRinomina',
            'sezRinominaConferma',
            'sezRinominaInCorso',
            'sezRinominaVuoto',
            'sezRinominaAvviso',
            'sezRinominaOggi',
            'sezRinominaDuplicato',
            'sezRinominaAltraSede',
            'sezRinominaErrore',
        ]) {
            expect(itAdmin, `manca in it/adminStudents.json: ${k}`).toHaveProperty(k)
            expect(enAdmin, `manca in en/adminStudents.json: ${k}`).toHaveProperty(k)
        }
    })

    it('adminStudents: it ed en espongono lo stesso set di chiavi', () => {
        expect(Object.keys(itAdmin).sort()).toEqual(Object.keys(enAdmin).sort())
    })
})
