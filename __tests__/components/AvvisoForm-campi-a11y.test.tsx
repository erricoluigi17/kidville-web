import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import itTeacher from '../../messages/it/teacherComunicazioni.json'
import itAltro from '../../messages/it/adminAltro.json'
import enAltro from '../../messages/en/adminAltro.json'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

// =============================================================================
// `AvvisoForm` — i CAMPI della modale, non il suo contenitore.
//
// Il lock gemello (`AvvisoForm-a11y-modale`) dimostra che la finestra esiste per
// chi non la vede: `role="dialog"`, focus-trap, Esc, piano sopra il chrome. Ma
// una finestra esposta piena di campi muti non serve a niente, ed è esattamente
// quello che il collaudo del 2026-07-31 ha misurato DENTRO il dialogo:
//
//  · a11y F2 — nessuno dei campi ha un'etichetta associata: i `<label>` visibili
//    non sono legati agli `<input>`. Chi usa uno screen reader sente il
//    placeholder (che sparisce appena scrive) e sul campo scadenza NIENTE
//    (axe `label`, impact CRITICAL, 2 nodi; `read_page` → `textbox` senza nome).
//  · a11y F4 — quale tipo di avviso e quali destinatari sono scelti si capisce
//    SOLO dal colore: quattro bottoni identici per uno screen reader, pillole
//    delle classi che non dicono se sono incluse. Il rischio concreto misurato:
//    pubblicare a una classe sbagliata senza accorgersene.
//  · a11y F8 — «togli allegato» è 12×12 px e senza nome (WCAG 2.5.8 + 4.1.2).
//  · a11y F3 (la metà che vive qui) — premendo «Pubblica» il bottone si
//    `disabled` e il browser sposta il focus su `<body>`. La primitiva `Modal`
//    ora sa rientrare al Tab successivo, ma il focus resta comunque perso
//    nell'istante in cui l'operatore preme: la causa è in questo file.
//  · design F3 — la pastiglia di chiusura cresce di 6px per lato e la
//    compensazione applicata era 8 (`-mr-2`): 2px di disallineamento misurati.
//
// METODO. Nessuna asserzione «non è fallito»:
//  · l'etichetta si verifica risalendo da `input.labels` al TESTO visibile, non
//    con un `toBeTruthy()` su un attributo;
//  · i toggle si verificano sulla MUTAZIONE — stato prima, click, stato dopo — e
//    per le pillole classe fino al PAYLOAD consegnato a `onSubmit`: un
//    `aria-pressed` che non segue la selezione vera sarebbe una bugia esposta
//    allo screen reader, peggio del silenzio di oggi;
//  · ogni asserzione negativa ha il suo controllo positivo accanto (il `<select>`
//    della sede, che l'etichetta ce l'ha già, è il metro del primo blocco).
// =============================================================================

expect.extend(toHaveNoViolations)

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

import { AvvisoForm, type ClasseAvviso, type DatiAvviso, type EsitoInvioAvviso } from '@/components/features/avvisi/AvvisoForm'
import type { Avviso } from '@/components/features/avvisi/AvvisoCard'

const RADICE = process.cwd()

/** Due sedi con un nome di classe in comune: è il caso vero dal 2026-07-29. */
const CLASSI: ClasseAvviso[] = [
    { id: 'sez-a-2anni', nome: '2 ANNI', scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A },
    { id: 'sez-a-3anni', nome: '3 ANNI A', scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A },
    { id: 'sez-b-2anni', nome: '2 ANNI', scuolaId: SEDE_B, scuolaNome: NOME_SEDE_B },
]

const CLASSI_UNA_SEDE = CLASSI.filter((c) => c.scuolaId === SEDE_A)

/** Un avviso già archiviato CON allegato — dati inventati, nessuna PII. */
const AVVISO_CON_ALLEGATO: Avviso = {
    id: 'avv-1',
    author_id: 'aut-1',
    titolo: 'Uscita anticipata',
    contenuto: 'Domani si esce alle 12.',
    tipo: 'presa_visione',
    target_scope: 'globale',
    target_classes: [],
    scadenza: null,
    attachment_url: 'avvisi/2026/modulo-uscita.pdf',
    created_at: '2026-07-31T08:00:00.000Z',
    author: { first_name: 'Nome', last_name: 'Cognome', role: 'segreteria' },
    stats: { letti: 0, adesioni_si: 0, adesioni_no: 0 },
}

type Invio = (d: DatiAvviso) => Promise<EsitoInvioAvviso>

function montaUnaSede(onSubmit?: Invio) {
    return render(
        <AvvisoForm
            open
            onClose={vi.fn()}
            onSubmit={onSubmit ?? (async () => ({ ok: true }))}
            availableClasses={CLASSI_UNA_SEDE}
        />,
    )
}

const axeOpts = {
    rules: {
        // Regole di documento: non si applicano a un componente isolato in jsdom.
        region: { enabled: false },
        'landmark-one-main': { enabled: false },
        'page-has-heading-one': { enabled: false },
    },
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => cleanup())

// =============================================================================
// F2 — ogni campo ha un'etichetta ASSOCIATA (non un placeholder)
// =============================================================================

describe('AvvisoForm — le etichette sono legate ai campi', () => {
    it('controllo positivo: il `<select>` della sede ha già la sua etichetta', () => {
        render(
            <AvvisoForm open onClose={vi.fn()} onSubmit={async () => ({ ok: true })} availableClasses={CLASSI} />,
        )
        const sede = screen.getByLabelText(itTeacher.formLabelSedePubblicazione)
        expect(sede.tagName).toBe('SELECT')
    })

    it.each([
        ['titolo', itTeacher.formLabelTitolo, 'INPUT'],
        ['contenuto', itTeacher.formLabelContenuto, 'TEXTAREA'],
        ['scadenza', itTeacher.formScadenzaAvviso, 'INPUT'],
        ['link esterno', itTeacher.formLabelLinkEsterno, 'INPUT'],
    ])('il campo «%s» si raggiunge dalla sua etichetta visibile', (_nome, etichetta, tag) => {
        montaUnaSede()
        const campo = screen.getByLabelText(etichetta)
        expect(campo.tagName).toBe(tag)
    })

    it('l’associazione è vera nei DUE versi: dal campo si risale al `<label>` visibile', () => {
        montaUnaSede()
        // `element.labels` è la lettura che fa il browser: se l'`htmlFor` puntasse
        // a un id inesistente, `getByLabelText` fallirebbe ma un `aria-label`
        // messo per far passare il test no. Qui si pretende il `<label>` vero.
        const coppie: ReadonlyArray<readonly [string, string]> = [
            [itTeacher.formLabelTitolo, itTeacher.formPlaceholderTitolo],
            [itTeacher.formLabelContenuto, itTeacher.formPlaceholderContenuto],
            [itTeacher.formLabelLinkEsterno, itTeacher.formPlaceholderLink],
        ]
        for (const [etichetta, placeholder] of coppie) {
            const campo = screen.getByLabelText(etichetta) as HTMLInputElement
            expect(campo.labels?.length, `«${etichetta}» non ha un <label> associato`).toBe(1)
            expect(campo.labels?.[0].textContent).toContain(etichetta)
            // Il placeholder resta un SUGGERIMENTO: c'è, ma non è più il nome.
            expect(campo.placeholder).toBe(placeholder)
        }
    })

    it('il campo data — quello che non aveva NESSUN nome — è un input `date` etichettato', () => {
        montaUnaSede()
        const data = screen.getByLabelText(itTeacher.formScadenzaAvviso) as HTMLInputElement
        expect(data.type).toBe('date')
        expect(data.labels?.length).toBe(1)
    })

    it('l’etichetta della scadenza segue il tipo di avviso, e resta associata', () => {
        montaUnaSede()
        fireEvent.click(screen.getByRole('button', { name: new RegExp(itTeacher.formTipoAdesione, 'i') }))
        const data = screen.getByLabelText(itTeacher.formScadenzaAdesione) as HTMLInputElement
        expect(data.type).toBe('date')
        expect(screen.queryByLabelText(itTeacher.formScadenzaAvviso)).toBeNull()
    })

    it('i campi obbligatori si dichiarano tali (`aria-required`)', () => {
        montaUnaSede()
        expect(screen.getByLabelText(itTeacher.formLabelTitolo)).toHaveAttribute('aria-required', 'true')
        expect(screen.getByLabelText(itTeacher.formLabelContenuto)).toHaveAttribute('aria-required', 'true')
        // …e chi obbligatorio non è, non lo dichiara: senza questa metà,
        // «aria-required ovunque» passerebbe lo stesso.
        expect(screen.getByLabelText(itTeacher.formLabelLinkEsterno)).not.toHaveAttribute('aria-required')
    })

    it('due istanze montate insieme non si rubano gli id', () => {
        // `useId()` è per ISTANZA: se gli id fossero costanti scritte a mano, il
        // secondo modulo ruberebbe l'etichetta al primo e `getByLabelText`
        // troverebbe due elementi.
        render(
            <>
                <AvvisoForm open onClose={vi.fn()} onSubmit={async () => ({ ok: true })} availableClasses={CLASSI_UNA_SEDE} />
                <AvvisoForm open onClose={vi.fn()} onSubmit={async () => ({ ok: true })} availableClasses={CLASSI_UNA_SEDE} />
            </>,
        )
        const titoli = screen.getAllByLabelText(itTeacher.formLabelTitolo)
        expect(titoli).toHaveLength(2)
        expect(titoli[0].id).not.toBe(titoli[1].id)
    })
})

describe('AvvisoForm — axe non trova più violazioni di etichetta', () => {
    it('nessuna violazione axe sulla modale aperta', async () => {
        const { container } = montaUnaSede()
        expect(await axe(container, axeOpts)).toHaveNoViolations()
    })

    it('nessuna violazione axe nella modalità docente (nessun blocco «Destinatari»)', async () => {
        // Ramo diverso dell'albero: qui il blocco «Destinatari» non esiste e le
        // pillole prendono l'etichetta da «Le tue classi». Se l'`aria-labelledby`
        // puntasse all'id che quel ramo non rende, axe lo direbbe
        // (`aria-valid-attr-value`) — ed è un difetto che a occhio non si vede.
        const { container } = render(
            <AvvisoForm
                open
                onClose={vi.fn()}
                onSubmit={async () => ({ ok: true })}
                availableClasses={CLASSI_UNA_SEDE}
                soloClassiProprie
            />,
        )
        expect(screen.getByRole('group', { name: itTeacher.formLabelLeTueClassi })).toBeInTheDocument()
        expect(await axe(container, axeOpts)).toHaveNoViolations()
    })

    it('nessuna violazione axe con l’allegato e le pillole classe a schermo', async () => {
        const { container } = render(
            <AvvisoForm
                open
                onClose={vi.fn()}
                onSubmit={async () => ({ ok: true })}
                availableClasses={CLASSI_UNA_SEDE}
                initialAvviso={AVVISO_CON_ALLEGATO}
            />,
        )
        fireEvent.click(screen.getByRole('button', { name: new RegExp(itTeacher.formDestinatariPerClasse, 'i') }))
        expect(await axe(container, axeOpts)).toHaveNoViolations()
    })
})

// =============================================================================
// F4 — lo stato non si affida al colore
// =============================================================================

/** Il bottone di un toggle, preso per nome accessibile. */
const bottone = (nome: string) => screen.getByRole('button', { name: new RegExp(nome, 'i') })

describe('AvvisoForm — i toggle dicono se sono premuti', () => {
    it('«Tipo»: lo stato è esposto e SI INVERTE al click', () => {
        montaUnaSede()
        const presaVisione = bottone(itTeacher.formTipoPresaVisione)
        const adesione = bottone(itTeacher.formTipoAdesione)

        expect(presaVisione).toHaveAttribute('aria-pressed', 'true')
        expect(adesione).toHaveAttribute('aria-pressed', 'false')

        fireEvent.click(adesione)
        expect(bottone(itTeacher.formTipoAdesione)).toHaveAttribute('aria-pressed', 'true')
        expect(bottone(itTeacher.formTipoPresaVisione)).toHaveAttribute('aria-pressed', 'false')
    })

    it('«Destinatari»: lo stato è esposto e SI INVERTE al click', () => {
        montaUnaSede()
        expect(bottone(itTeacher.formDestinatariTutti)).toHaveAttribute('aria-pressed', 'true')
        expect(bottone(itTeacher.formDestinatariPerClasse)).toHaveAttribute('aria-pressed', 'false')

        fireEvent.click(bottone(itTeacher.formDestinatariPerClasse))
        expect(bottone(itTeacher.formDestinatariPerClasse)).toHaveAttribute('aria-pressed', 'true')
        expect(bottone(itTeacher.formDestinatariTutti)).toHaveAttribute('aria-pressed', 'false')
    })

    it('lo stato premuto porta anche un segno NON cromatico (WCAG 1.4.1)', () => {
        montaUnaSede()
        const segno = (b: HTMLElement) => b.querySelector('svg[aria-hidden="true"]')

        expect(segno(bottone(itTeacher.formTipoPresaVisione))).not.toBeNull()
        expect(segno(bottone(itTeacher.formTipoAdesione))).toBeNull()

        fireEvent.click(bottone(itTeacher.formTipoAdesione))
        // Il segno SI SPOSTA: non è un'icona decorativa messa su entrambi.
        expect(segno(bottone(itTeacher.formTipoAdesione))).not.toBeNull()
        expect(segno(bottone(itTeacher.formTipoPresaVisione))).toBeNull()
    })

    it('le pillole classe dicono se sono incluse, e l’attributo NON mente sul payload', async () => {
        const onSubmit = vi.fn<Invio>(async () => ({ ok: true }))
        montaUnaSede(onSubmit)

        fireEvent.change(screen.getByLabelText(itTeacher.formLabelTitolo), { target: { value: 'Chiusura per ponte' } })
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelContenuto), { target: { value: 'La scuola resta chiusa venerdì.' } })
        fireEvent.click(bottone(itTeacher.formDestinatariPerClasse))

        const pillola = screen.getByRole('button', { name: '3 ANNI A' })
        expect(pillola).toHaveAttribute('aria-pressed', 'false')
        expect(screen.getByRole('button', { name: '2 ANNI' })).toHaveAttribute('aria-pressed', 'false')

        fireEvent.click(pillola)
        expect(screen.getByRole('button', { name: '3 ANNI A' })).toHaveAttribute('aria-pressed', 'true')
        // L'altra classe NON si è accesa: senza questa metà, `aria-pressed={true}`
        // scritto fisso passerebbe.
        expect(screen.getByRole('button', { name: '2 ANNI' })).toHaveAttribute('aria-pressed', 'false')

        fireEvent.click(screen.getByRole('button', { name: new RegExp(itTeacher.formSubmitPubblicaAvviso, 'i') }))
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
        // La prova che l'attributo dice la VERITÀ: è la classe che parte davvero.
        expect(onSubmit.mock.calls[0][0].target_classes).toEqual(['3 ANNI A'])
    })

    it('la pillola inclusa porta anch’essa un segno non cromatico', () => {
        montaUnaSede()
        fireEvent.click(bottone(itTeacher.formDestinatariPerClasse))
        const pillola = () => screen.getByRole('button', { name: '3 ANNI A' })
        expect(pillola().querySelector('svg[aria-hidden="true"]')).toBeNull()
        fireEvent.click(pillola())
        expect(pillola().querySelector('svg[aria-hidden="true"]')).not.toBeNull()
    })

    it('i gruppi di scelta sono raggruppati sotto la loro etichetta', () => {
        montaUnaSede()
        // Un `<label>` senza controllo è un'etichetta orfana: qui l'intestazione
        // del gruppo etichetta il GRUPPO, ed è così che uno screen reader annuncia
        // «Tipo — presa visione, premuto» invece di quattro bottoni sciolti.
        const tipo = screen.getByRole('group', { name: itTeacher.formLabelTipo })
        expect(tipo).toContainElement(bottone(itTeacher.formTipoPresaVisione))
        const destinatari = screen.getByRole('group', { name: itTeacher.formLabelDestinatari })
        expect(destinatari).toContainElement(bottone(itTeacher.formDestinatariTutti))
    })
})

// =============================================================================
// F8 — «togli allegato»: un bersaglio vero, con un nome
// =============================================================================

describe('AvvisoForm — il bottone che toglie l’allegato', () => {
    function montaConAllegato() {
        return render(
            <AvvisoForm
                open
                onClose={vi.fn()}
                onSubmit={async () => ({ ok: true })}
                availableClasses={CLASSI_UNA_SEDE}
                initialAvviso={AVVISO_CON_ALLEGATO}
            />,
        )
    }

    const nomeFile = 'modulo-uscita.pdf'
    /** Il mock di next-intl non interpola: il nome accessibile resta riconoscibile. */
    const etichettaRimuovi = new RegExp(itAltro.protRimuoviAllegato.replace('{nome}', '.*'), 'i')

    it('controllo positivo: senza allegato il bottone non esiste affatto', () => {
        montaUnaSede()
        expect(screen.queryByRole('button', { name: etichettaRimuovi })).toBeNull()
    })

    it('ha un nome accessibile e un’area toccabile di almeno 44×44', () => {
        montaConAllegato()
        expect(screen.getByText(nomeFile)).toBeInTheDocument()
        const rimuovi = screen.getByRole('button', { name: etichettaRimuovi })
        // jsdom non fa layout: il minimo touch si verifica sulle classi dichiarate,
        // come già fa il lock del bottone «Chiudi».
        expect(rimuovi.className).toMatch(/(^|\s)min-w-\[44px\](\s|$)/)
        expect(rimuovi.className).toMatch(/(^|\s)min-h-\[44px\](\s|$)/)
        // L'icona è decorativa: il nome lo porta l'aria-label, non la ✕.
        expect(rimuovi.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    })

    it('e toglie davvero l’allegato (il nome del file sparisce)', () => {
        montaConAllegato()
        fireEvent.click(screen.getByRole('button', { name: etichettaRimuovi }))
        expect(screen.queryByText(nomeFile)).toBeNull()
    })

    it('la chiave del nome accessibile esiste in ENTRAMBE le lingue', () => {
        // Il nome viene da `adminAltro` e non da `teacherComunicazioni` perché la
        // stringa esiste già, tradotta, e descrive lo stesso gesto sullo stesso
        // oggetto (il registro protocolli). next-intl in produzione LANCIA su una
        // chiave assente: se qualcuno la rinomina riordinando i cataloghi, la
        // modale «Nuovo avviso» smette di aprirsi — e sarebbe un errore lontano
        // dalla sua causa. Questo lock lo fa cadere qui.
        expect(itAltro).toHaveProperty('protRimuoviAllegato')
        expect(enAltro).toHaveProperty('protRimuoviAllegato')
        // …e resta una stringa con il segnaposto del nome, altrimenti l'etichetta
        // direbbe «Rimuovi» senza dire che cosa.
        expect(itAltro.protRimuoviAllegato).toContain('{nome}')
        expect(enAltro.protRimuoviAllegato).toContain('{nome}')
    })
})

// =============================================================================
// F3 (la metà che vive in questo file) — premendo «Pubblica» il focus non si perde
// =============================================================================

describe('AvvisoForm — l’invio non butta via il focus', () => {
    /** Un invio che NON si risolve: fotografa il modulo mentre sta inviando. */
    function invioSospeso() {
        let sblocca: (e: EsitoInvioAvviso) => void = () => {}
        const onSubmit = vi.fn<Invio>(
            () => new Promise<EsitoInvioAvviso>((res) => { sblocca = res }),
        )
        return { onSubmit, sblocca: (e: EsitoInvioAvviso = { ok: true }) => sblocca(e) }
    }

    const pubblica = () => screen.getByRole('button', { name: new RegExp(itTeacher.formSubmitPubblicaAvviso, 'i') })

    function compila() {
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelTitolo), { target: { value: 'Uscita anticipata' } })
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelContenuto), { target: { value: 'Domani si esce alle 12.' } })
    }

    it('durante l’invio il bottone NON si disabilita: resta focalizzabile e a fuoco', async () => {
        const { onSubmit, sblocca } = invioSospeso()
        montaUnaSede(onSubmit)
        compila()

        // Il nodo si tiene per riferimento: durante l'invio il bottone cambia
        // TESTO («Pubblicazione…»), quindi cercarlo di nuovo per nome non lo
        // troverebbe — ed è lo stesso elemento, React ne aggiorna i figli.
        const cta = pubblica()
        cta.focus()
        expect(document.activeElement).toBe(cta)

        fireEvent.click(cta)
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))

        // L'asserzione che porta il peso è sull'ATTRIBUTO, perché è la causa
        // misurata nel browser: `disabled` durante la POST → Chrome scarica il
        // focus su `<body>` e il Tab successivo esce dal dialogo.
        //
        // ⚠️ La riga sul focus, DA SOLA, non dimostrerebbe niente: verificato che
        // jsdom NON riproduce quel comportamento (un `<button>` che diventa
        // `disabled` mentre ha il fuoco resta `document.activeElement`). Sta qui
        // come conferma dell'esito atteso, non come guardia — la guardia è la
        // riga sopra, e col difetto rimesso è quella che cade.
        expect(cta).not.toBeDisabled()
        expect(cta).toHaveAttribute('aria-disabled', 'true')
        expect(document.activeElement).toBe(cta)

        sblocca()
    })

    it('e un secondo click durante l’invio NON pubblica due volte', async () => {
        const { onSubmit, sblocca } = invioSospeso()
        montaUnaSede(onSubmit)
        compila()

        const cta = pubblica()
        fireEvent.click(cta)
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
        fireEvent.click(cta)
        fireEvent.click(cta)
        // La guardia sta nell'handler: senza `disabled` il bottone è cliccabile,
        // e senza guardia si spedirebbero tre avvisi a tutte le famiglie.
        expect(onSubmit).toHaveBeenCalledTimes(1)

        sblocca()
    })

    it('l’invio in corso si ANNUNCIA (`role="status"`) e la regione si dichiara occupata', async () => {
        const { onSubmit, sblocca } = invioSospeso()
        const { container } = montaUnaSede(onSubmit)
        compila()

        // La regione viva esiste GIÀ al montaggio, vuota: uno screen reader
        // annuncia i cambiamenti di un live region che era lì prima: se nascesse
        // insieme al testo, l'annuncio si perderebbe. Ecco perché il controllo
        // positivo è «c'è ed è vuota», non «non c'è».
        const stato = screen.getByRole('status')
        expect(stato).toBeEmptyDOMElement()
        expect(container.querySelector('[aria-busy="true"]')).toBeNull()

        fireEvent.click(pubblica())
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))

        expect(stato).toHaveTextContent(itTeacher.formSubmitPubblicazione)
        expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()

        sblocca()
        await waitFor(() => expect(stato).toBeEmptyDOMElement())
        expect(container.querySelector('[aria-busy="true"]')).toBeNull()
    })

    it('a modulo incompleto il bottone resta RAGGIUNGIBILE ma non invia', () => {
        const onSubmit = vi.fn<Invio>(async () => ({ ok: true }))
        montaUnaSede(onSubmit)

        const cta = pubblica()
        expect(cta).toHaveAttribute('aria-disabled', 'true')
        // Un `disabled` nativo esce dal giro del Tab senza spiegare perché: chi
        // naviga da tastiera non trova più il bottone e non sa cosa manca.
        expect(cta).not.toBeDisabled()
        cta.focus()
        expect(document.activeElement).toBe(cta)

        fireEvent.click(cta)
        expect(onSubmit).not.toHaveBeenCalled()
    })
})

// =============================================================================
// L'anteprima firmata che il server manda e nessuno usava
// =============================================================================

describe('AvvisoForm — l’anteprima dell’allegato appena caricato', () => {
    const PREVIEW = 'https://esempio.test/storage/firmato/modulo.pdf?token=finto'

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('il nome del file diventa un link all’anteprima firmata restituita dal server', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => ({ path: 'avvisi/2026/modulo.pdf', fileUrl: 'avvisi/2026/modulo.pdf', previewUrl: PREVIEW }),
            })),
        )
        const { container } = montaUnaSede()
        const input = container.querySelector('input[type="file"]') as HTMLInputElement
        fireEvent.change(input, { target: { files: [new File(['x'], 'modulo.pdf', { type: 'application/pdf' })] } })

        const link = await screen.findByRole('link', { name: /modulo\.pdf/ })
        expect(link).toHaveAttribute('href', PREVIEW)
        expect(link).toHaveAttribute('target', '_blank')
        expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    })

    it('senza anteprima firmata resta il solo nome, non un link rotto', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => ({ path: 'avvisi/2026/modulo.pdf', fileUrl: 'avvisi/2026/modulo.pdf', previewUrl: null }),
            })),
        )
        const { container } = montaUnaSede()
        const input = container.querySelector('input[type="file"]') as HTMLInputElement
        fireEvent.change(input, { target: { files: [new File(['x'], 'modulo.pdf', { type: 'application/pdf' })] } })

        await screen.findByText('modulo.pdf')
        expect(screen.queryByRole('link', { name: /modulo\.pdf/ })).toBeNull()
    })
})

// =============================================================================
// design F3 + il commento che diceva il falso
// =============================================================================

describe('AvvisoForm — la pastiglia di chiusura resta allineata', () => {
    it('la compensazione vale i 6px di crescita per lato, non 8', () => {
        montaUnaSede()
        // 44 (bersaglio) − 32 (pastiglia) = 12 → 6px per lato. `-mr-2` (8px)
        // spostava la pastiglia 2px oltre il bordo del contenuto: misurato.
        const chiudi = screen.getByRole('button', { name: /chiudi/i })
        expect(chiudi.className).toMatch(/(^|\s)-mr-1\.5(\s|$)/)
        expect(chiudi.className).not.toMatch(/(^|\s)-mr-2(\s|$)/)
    })
})

describe('AvvisoForm — la scala z documentata dice la verità', () => {
    /** La riga «<numero> MODALI …» del commento di AvvisoForm. */
    function pianoDocumentato(): number {
        const src = readFileSync(path.join(RADICE, 'src/components/features/avvisi/AvvisoForm.tsx'), 'utf8')
        const m = /^\s*\*\s+(\d+)\s+MODALI/m.exec(src)
        expect(m, 'il commento non documenta più il piano dei modali').not.toBeNull()
        return Number(m?.[1])
    }

    /** Il piano che la primitiva dichiara davvero. */
    function pianoDellaPrimitiva(): number {
        const src = readFileSync(path.join(RADICE, 'src/components/ui/Modal.tsx'), 'utf8')
        const piani = [...src.matchAll(/className="fixed inset-0 z-\[(\d+)\]/g)].map((m) => Number(m[1]))
        expect(piani.length, 'la primitiva non dichiara più un piano sul contenitore fixed').toBeGreaterThan(0)
        return Math.max(...piani)
    }

    it('il numero scritto nel commento è quello che la primitiva usa davvero', () => {
        // Un commento che mente costa più di nessun commento: la scala qui dentro
        // è la sola documentazione della gerarchia dei piani, e per una giornata
        // ha dichiarato i modali SOTTO il chrome dell'admin — che è esattamente il
        // difetto poi misurato (design F2 / frontend F2 / iOS F1).
        expect(pianoDocumentato()).toBe(pianoDellaPrimitiva())
    })

    it('e il chrome dell’admin è documentato SOTTO i modali', () => {
        const src = readFileSync(path.join(RADICE, 'src/components/features/avvisi/AvvisoForm.tsx'), 'utf8')
        const riga = /^\s*\*\s+([\d\s·]+)\s+chrome dell'admin/m.exec(src)
        expect(riga, 'il commento non documenta più il chrome dell’admin').not.toBeNull()
        const piani = (riga?.[1] ?? '').split('·').map((n) => Number(n.trim())).filter(Number.isFinite)
        expect(piani.length).toBeGreaterThan(0)
        expect(Math.max(...piani)).toBeLessThan(pianoDocumentato())
    })
})
