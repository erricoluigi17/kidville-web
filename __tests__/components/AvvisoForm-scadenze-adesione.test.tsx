import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'

import itTeacher from '../../messages/it/teacherComunicazioni.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

// =============================================================================
// `AvvisoForm` — LE DUE SCADENZE E IL BLOCCO «ADESIONE E POSTI» (2026-09-19).
//
// IL PUNTO DI PARTENZA. Il modulo aveva UNA casella data (`<input type="date">`)
// la cui etichetta cambiava a runtime fra «Scadenza avviso» e «Scadenza adesione»
// a seconda del tipo: due significati nello stesso campo, mai visibili insieme, e
// nessuna ora su una scadenza che decide chi entra in gita. Con le colonne del
// cantiere A2 (`scadenza_avviso`, `scadenza_adesione`, `chiedi_numero`,
// `etichetta_numero`, `numero_min`, `numero_max`, `posti_totali`) i campi
// diventano due e nasce un blocco di configurazione.
//
// LE QUATTRO COSE CHE QUESTO FILE ESISTE PER TENERE FERME, e perché:
//
//  1. IL PAYLOAD PORTA CIFRE LOCALI, non un ISO. Un ISO composto dal client porta
//     con sé l'orologio e il fuso del TABLET: è il difetto per cui esistono
//     `istanteDaLocale` e `zDataOraLocale`. Si asserisce sulla STRINGA esatta,
//     perché «è una data valida» sarebbe vero anche della forma sbagliata.
//  2. A BANDIERINA SPENTA I CAMPI NON VIAGGIANO. Un campo nascosto che continua a
//     finire nel payload è il modo in cui un tetto riappare da solo su un avviso
//     che non lo chiedeva più — e a occhio non si vede, perché a schermo il campo
//     non c'è. Si guarda il payload, non il DOM.
//  3. …MA I VALORI DIGITATI RESTANO. Si spegne spesso per controllare come verrà,
//     e perdere la domanda appena scritta a ogni tocco è punitivo. Le due metà
//     (non viaggia / non si cancella) vanno provate INSIEME: ciascuna da sola
//     sarebbe soddisfatta anche dall'implementazione sbagliata dell'altra.
//  4. IL MESSAGGIO DI COERENZA NON ARRIVA A METÀ DIGITAZIONE. «Le scadenze non
//     sono coerenti» detto mentre si sta scrivendo la data è un rimprovero a chi
//     sta facendo la cosa giusta. Il controllo positivo sta ACCANTO a quello
//     negativo: senza, «il messaggio non c'è» sarebbe verde anche su un messaggio
//     che non compare mai.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

import {
    AvvisoForm,
    motivoMancante,
    type ClasseAvviso,
    type DatiAvviso,
    type EsitoInvioAvviso,
} from '@/components/features/avvisi/AvvisoForm'
import type { Avviso } from '@/components/features/avvisi/AvvisoCard'

type Invio = (d: DatiAvviso) => Promise<EsitoInvioAvviso>

const CLASSI: ClasseAvviso[] = [{ id: 'sez-a-2anni', nome: '2 ANNI', scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A }]

function monta(onSubmit?: Invio, initialAvviso: Avviso | null = null) {
    return render(
        <AvvisoForm
            open
            onClose={vi.fn()}
            onSubmit={onSubmit ?? (async () => ({ ok: true }))}
            availableClasses={CLASSI}
            initialAvviso={initialAvviso}
        />,
    )
}

const gruppoAvviso = () => screen.getByRole('group', { name: itTeacher.formScadenzaAvviso })
const gruppoAdesione = () => screen.getByRole('group', { name: itTeacher.formScadenzaAdesione })

/** Scrive la sola DATA: l'ora si scrive da sola alla prima data valida (23:59). */
function scriviData(gruppo: HTMLElement, etichetta: string, valore: string) {
    fireEvent.change(within(gruppo).getByLabelText(etichetta), { target: { value: valore } })
}

const scadenzaAvviso = (valore: string) => scriviData(gruppoAvviso(), itTeacher.formScadenzaAvvisoData, valore)
const scadenzaAdesione = (valore: string) => scriviData(gruppoAdesione(), itTeacher.formScadenzaAdesioneData, valore)

const tipoAdesione = () => fireEvent.click(screen.getByRole('button', { name: new RegExp(itTeacher.formTipoAdesione, 'i') }))
const tipoPresaVisione = () =>
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itTeacher.formTipoPresaVisione, 'i') }))
const bandierina = () => screen.getByLabelText(itTeacher.formChiediPartecipanti)
const pubblica = () => screen.getByRole('button', { name: new RegExp(itTeacher.formSubmitPubblicaAvviso, 'i') })

function compilaTesto() {
    fireEvent.change(screen.getByLabelText(itTeacher.formLabelTitolo), { target: { value: 'Gita al parco' } })
    fireEvent.change(screen.getByLabelText(itTeacher.formLabelContenuto), { target: { value: 'Partenza alle 9.' } })
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => cleanup())

// =============================================================================
// 0 · La scelta del motivo: una funzione pura, e un ORDINE
// =============================================================================

describe('motivoMancante — la prima cosa che manca, e solo la prima', () => {
    const pieno = {
        titolo: 'Gita',
        contenuto: 'Partenza alle 9.',
        chiedeSede: false,
        scuolaId: '',
        scope: 'globale',
        classiScelte: 0,
        scadenze: null,
    } as const

    it('segue l’ordine in cui i campi stanno a schermo', () => {
        // L'ordine non è un dettaglio: mandare l'operatore in fondo al modulo per un
        // campo che sta in cima gli fa scorrere la finestra due volte.
        expect(motivoMancante({ ...pieno, titolo: '   ', contenuto: '' })).toBe('TITOLO')
        expect(motivoMancante({ ...pieno, contenuto: '  ' })).toBe('CONTENUTO')
        expect(motivoMancante({ ...pieno, chiedeSede: true })).toBe('SEDE')
        expect(motivoMancante({ ...pieno, scope: 'classe' })).toBe('DESTINATARI')
        // Le due voci sulle scadenze arrivano già decise da `useScadenze`, che sa
        // quale delle due è obbligatoria per questo tipo di avviso.
        expect(motivoMancante({ ...pieno, scadenze: 'SCADENZA_ADESIONE' })).toBe('SCADENZA_ADESIONE')
    })

    it('a modulo completo non inventa niente da dire', () => {
        // Senza questa metà, «torna sempre un motivo» passerebbe il test di sopra.
        expect(motivoMancante(pieno)).toBeNull()
    })
})

// =============================================================================
// 1 · Il payload: cifre LOCALI, mai un ISO
// =============================================================================

describe('AvvisoForm — le due scadenze nel payload', () => {
    it('viaggiano come `YYYY-MM-DDTHH:MM` locali, non come istanti ISO', async () => {
        const onSubmit = vi.fn<Invio>(async () => ({ ok: true }))
        monta(onSubmit)
        compilaTesto()
        scadenzaAvviso('31/12/2026')

        fireEvent.click(pubblica())
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
        const payload = onSubmit.mock.calls[0][0]

        // La stringa ESATTA. `31/12/2026` + l'ora che si scrive da sola = le 23:59
        // del 31 dicembre lette sull'orologio di Giugliano.
        expect(payload.scadenza_avviso).toBe('2026-12-31T23:59')
        // …e le due forme che NON deve avere: la `Z` finale di un ISO (che porterebbe
        // il fuso del tablet) e i secondi, che questo campo non ha.
        expect(payload.scadenza_avviso).not.toMatch(/Z$/)
        expect(payload.scadenza_avviso).not.toMatch(/:\d{2}:\d{2}/)
        // Su una presa visione la scadenza d'adesione non esiste proprio.
        expect(payload.scadenza_adesione).toBeNull()
    })

    it('l’ora si può cambiare, e il payload la segue', async () => {
        const onSubmit = vi.fn<Invio>(async () => ({ ok: true }))
        monta(onSubmit)
        compilaTesto()
        scadenzaAvviso('31/12/2026')
        fireEvent.change(within(gruppoAvviso()).getByLabelText(itTeacher.formScadenzaAvvisoOra), {
            target: { value: '18:30' },
        })

        fireEvent.click(pubblica())
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
        // Senza questa metà, «23:59» potrebbe essere una costante scritta nel payload
        // invece dell'ora che si legge nel campo.
        expect(onSubmit.mock.calls[0][0].scadenza_avviso).toBe('2026-12-31T18:30')
    })

    it('in MODIFICA una vecchia `scadenza` a grana giorno vale fino a SERA, non alle 02:00', () => {
        // `new Date('2026-09-19')` è mezzanotte UTC, cioè le 02:00 italiane: riaprire
        // un avviso storico mostrando «02:00» e risalvarlo senza toccare il campo
        // accorcerebbe la scadenza di ventidue ore, in silenzio.
        const storico: Avviso = {
            id: 'avv-1',
            author_id: 'aut-1',
            titolo: 'Uscita anticipata',
            contenuto: 'Domani si esce alle 12.',
            tipo: 'presa_visione',
            target_scope: 'globale',
            target_classes: [],
            scadenza: '2026-09-19',
            attachment_url: null,
            created_at: '2026-09-01T08:00:00.000Z',
            author: { first_name: 'Nome', last_name: 'Cognome', role: 'segreteria' },
            stats: { letti: 0, adesioni_si: 0, adesioni_no: 0 },
        }
        monta(undefined, storico)
        const gruppo = gruppoAvviso()
        expect((within(gruppo).getByLabelText(itTeacher.formScadenzaAvvisoData) as HTMLInputElement).value).toBe('19/09/2026')
        expect((within(gruppo).getByLabelText(itTeacher.formScadenzaAvvisoOra) as HTMLInputElement).value).toBe('23:59')
    })
})

// =============================================================================
// 1-bis · SI GIUDICA CIÒ CHE PARTE — anche sull'asse della CONVERSIONE
//
// La riga «cosa manca» e il payload leggono le STESSE due espressioni convertite
// (`avvisoLocale`, `adesioneDaInviare`), non lo stato grezzo. Su ogni valore
// leggibile le due forme sono indistinguibili: divergono su un valore solo, quello
// che `istanteDaColonna` inoltra VERBATIM perché non è né vuoto né una
// `YYYY-MM-DD`. Lì lo stato è pieno e la conversione torna `''`: giudicando lo
// stato, la riga restava vuota, il bottone ACCESO, e partiva un corpo con
// `scadenza_avviso: null` che il server rifiuta con 400 `SCADENZA_AVVISO_MANCANTE`.
//
// In produzione non può capitare oggi — la colonna è `timestamptz NOT NULL` e
// PostgREST restituisce sempre un ISO leggibile — ed è esattamente perché non si
// può collaudare a mano che lo tiene fermo un test: il giorno in cui quella
// sorgente cambia, la differenza fra «lo dico» e «lo spedisco a vuoto» è qui.
// =============================================================================

/** Un avviso già archiviato, su cui aprire il modulo in MODIFICA. */
function archiviato(extra: Record<string, unknown>): Avviso {
    return {
        id: 'avv-illeggibile',
        author_id: 'aut-1',
        titolo: 'Gita al parco',
        contenuto: 'Partenza alle 9.',
        tipo: 'presa_visione',
        target_scope: 'globale',
        target_classes: [],
        scadenza: null,
        attachment_url: null,
        created_at: '2026-09-01T08:00:00.000Z',
        author: { first_name: 'Nome', last_name: 'Cognome', role: 'segreteria' },
        stats: { letti: 0, adesioni_si: 0, adesioni_no: 0 },
        ...extra,
    } as Avviso
}

/** In MODIFICA il bottone d'invio non è «Pubblica avviso» ma «Salva modifiche». */
const salva = () => screen.getByRole('button', { name: new RegExp(itTeacher.formSubmitSalvaModifiche, 'i') })

/** La riga «cosa manca», presa dall'`aria-describedby` del bottone d'invio. */
function rigaMotivo(bottone: HTMLElement): HTMLElement {
    return document.getElementById(bottone.getAttribute('aria-describedby') as string) as HTMLElement
}

describe('AvvisoForm — una scadenza ILLEGGIBILE in colonna', () => {
    it('🔴 `scadenza_avviso` illeggibile: blocca e NOMINA il campo, invece di spedire `null`', () => {
        const onSubmit = vi.fn<Invio>(async () => ({ ok: true }))
        monta(onSubmit, archiviato({ scadenza_avviso: 'ieri mattina' }))

        // `DateTimeField` non sa scomporre quel valore e lascia i due campi vuoti: a
        // schermo la scadenza NON c'è, qualunque cosa tenga lo stato del modulo.
        const gruppo = gruppoAvviso()
        expect((within(gruppo).getByLabelText(itTeacher.formScadenzaAvvisoData) as HTMLInputElement).value).toBe('')
        expect((within(gruppo).getByLabelText(itTeacher.formScadenzaAvvisoOra) as HTMLInputElement).value).toBe('')

        const bottone = salva()
        expect(rigaMotivo(bottone)).toHaveTextContent(itTeacher.formMancaScadenzaAvviso)
        expect(bottone).toHaveAttribute('aria-disabled', 'true')

        // La metà che conta: non parte un corpo che il server rifiuterebbe comunque.
        fireEvent.click(bottone)
        expect(onSubmit).not.toHaveBeenCalled()
    })

    it('🔴 …e identico dal lato adesione, con la scadenza dell’avviso a posto', () => {
        const onSubmit = vi.fn<Invio>(async () => ({ ok: true }))
        monta(
            onSubmit,
            archiviato({
                tipo: 'adesione',
                // Leggibile: è la prova che il blocco viene dall'ALTRO campo, non da
                // un modulo che rifiuta tutto quello che apre.
                scadenza_avviso: '2026-10-10T21:59:00.000Z',
                scadenza_adesione: 'quando vuoi',
            }),
        )

        const dataAvviso = within(gruppoAvviso()).getByLabelText(itTeacher.formScadenzaAvvisoData) as HTMLInputElement
        expect(dataAvviso.value).toBe('10/10/2026')
        expect(
            (within(gruppoAdesione()).getByLabelText(itTeacher.formScadenzaAdesioneData) as HTMLInputElement).value,
        ).toBe('')

        const bottone = salva()
        expect(rigaMotivo(bottone)).toHaveTextContent(itTeacher.formMancaScadenzaAdesione)
        expect(bottone).toHaveAttribute('aria-disabled', 'true')
        fireEvent.click(bottone)
        expect(onSubmit).not.toHaveBeenCalled()
    })
})

// =============================================================================
// 2 · La coerenza fra le due scadenze
// =============================================================================

describe('AvvisoForm — l’adesione non può chiudersi dopo l’avviso', () => {
    /** Il `<p>` del messaggio incrociato, preso dall'`aria-describedby` dei campi. */
    function nodoErrore(): HTMLElement {
        const data = within(gruppoAvviso()).getByLabelText(itTeacher.formScadenzaAvvisoData)
        const ids = (data.getAttribute('aria-describedby') ?? '').split(/\s+/)
        const nodi = ids.map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[]
        const errore = nodi.find((n) => n.textContent?.includes(itTeacher.formErroreAdesioneOltreAvviso))
        return errore ?? nodi[nodi.length - 1]
    }

    it('il messaggio compare, è annunciato, ed è associato a ENTRAMBI i campi', () => {
        monta()
        tipoAdesione()
        scadenzaAvviso('10/10/2026')
        scadenzaAdesione('11/10/2026')

        const messaggio = screen.getByText(itTeacher.formErroreAdesioneOltreAvviso)
        // Dentro una regione viva POLITE, e non un `role="alert"`: l'alert di questa
        // modale è già uno (il rifiuto del server in testa), e due regioni assertive
        // si accavallano nell'annuncio.
        const regione = messaggio.closest('[aria-live]')
        expect(regione).not.toBeNull()
        expect(regione).toHaveAttribute('aria-live', 'polite')
        expect(messaggio.closest('[role="alert"]')).toBeNull()
        // Icona + testo: il colore da solo non basta (WCAG 1.4.1).
        const riga = messaggio.closest('p') as HTMLElement
        expect(riga.querySelector('svg[aria-hidden="true"]')).not.toBeNull()

        // L'associazione vale per TUTTI E QUATTRO i controlli delle due scadenze:
        // l'errore riguarda la coppia, e chi ha il fuoco su uno dei due deve sentirlo.
        const idErrore = riga.id
        expect(idErrore).toBeTruthy()
        for (const [gruppo, etichetta] of [
            [gruppoAvviso(), itTeacher.formScadenzaAvvisoData],
            [gruppoAvviso(), itTeacher.formScadenzaAvvisoOra],
            [gruppoAdesione(), itTeacher.formScadenzaAdesioneData],
            [gruppoAdesione(), itTeacher.formScadenzaAdesioneOra],
        ] as const) {
            const campo = within(gruppo as HTMLElement).getByLabelText(etichetta as string)
            expect(campo.getAttribute('aria-describedby')?.split(/\s+/)).toContain(idErrore)
        }

        // E il modulo non parte: il server risponderebbe comunque 400.
        compilaTesto()
        expect(pubblica()).toHaveAttribute('aria-disabled', 'true')
    })

    it('UGUALE è ammesso: «le adesioni si chiudono quando l’avviso sparisce»', () => {
        // È la configurazione che la segreteria ottiene copiando la stessa data nei
        // due campi, e sarà frequente. Un `>=` la rifiuterebbe con un messaggio
        // incomprensibile su due date identiche.
        monta()
        compilaTesto()
        tipoAdesione()
        scadenzaAvviso('10/10/2026')
        scadenzaAdesione('10/10/2026')

        expect(screen.queryByText(itTeacher.formErroreAdesioneOltreAvviso)).toBeNull()
        expect(pubblica()).toHaveAttribute('aria-disabled', 'false')
    })

    it('a METÀ DIGITAZIONE il messaggio non compare (e il controllo positivo è qui sotto)', () => {
        monta()
        tipoAdesione()
        scadenzaAvviso('10/10/2026')

        // `11/10/20` non è una data: l'istante d'adesione non esiste ancora, e
        // confrontarlo con quello dell'avviso vorrebbe dire rimproverare qualcuno per
        // una cifra che non ha ancora finito di scrivere.
        scadenzaAdesione('11/10/20')
        expect(nodoErrore()).toBeEmptyDOMElement()
        expect(screen.queryByText(itTeacher.formErroreAdesioneOltreAvviso)).toBeNull()

        // CONTROLLO POSITIVO, nello stesso test: finita di scrivere la data, il
        // messaggio arriva. Senza questa metà, l'asserzione di sopra sarebbe verde
        // anche su un messaggio che non compare MAI.
        scadenzaAdesione('11/10/2026')
        expect(screen.getByText(itTeacher.formErroreAdesioneOltreAvviso)).toBeInTheDocument()
    })

    it('tornando a «presa visione» un’incoerenza rimasta NON blocca più: il campo non è a schermo', async () => {
        // 🔴 IL BLOCCO FANTASMA. Le due metà che lo producevano erano ciascuna
        // giusta: la scadenza d'adesione RESTA nello stato tornando indietro (non si
        // cancella ciò che qualcuno ha scritto) e NON viaggia (`scadenza_adesione`
        // parte `null` fuori dagli avvisi di adesione). Insieme davano un bottone
        // spento per un campo SMONTATO, con la riga «cosa manca» vuota — perché
        // nessuno dei sei motivi parla di coerenza — e il messaggio incrociato a
        // schermo che nominava un campo non più nella pagina. L'unica via d'uscita
        // era indovinare: tornare ad «Adesione», correggere, tornare indietro. È
        // l'incidente dei 442 click su un bottone morto, nella sua forma nuova.
        //
        // E il corpo impedito sarebbe stato LEGITTIMO: `scadenza_adesione: null` su
        // una presa visione, che POST e PUT accettano (passano `tipo` alla stessa
        // `risolviScadenze`, che lì torna `ok`).
        //
        // ⚠️ I due test che fanno questo giro poco più sotto usano date UGUALI
        // (`10/10` e `10/10`), che non innescano l'incoerenza: per vedere il difetto
        // le due date devono contraddirsi.
        const onSubmit = vi.fn<Invio>(async () => ({ ok: true }))
        monta(onSubmit)
        compilaTesto()
        tipoAdesione()
        scadenzaAvviso('10/10/2026')
        scadenzaAdesione('11/10/2026')

        // Finché è un'adesione il blocco è giusto: il campo è a schermo, il
        // messaggio lo accompagna, e c'è come correggerlo.
        expect(screen.getByText(itTeacher.formErroreAdesioneOltreAvviso)).toBeInTheDocument()
        expect(pubblica()).toHaveAttribute('aria-disabled', 'true')

        // …e qui no: il gruppo «Scadenza adesione» si è smontato, quindi non c'è più
        // niente da giudicare né da correggere.
        tipoPresaVisione()
        expect(screen.queryByRole('group', { name: itTeacher.formScadenzaAdesione })).toBeNull()
        expect(screen.queryByText(itTeacher.formErroreAdesioneOltreAvviso)).toBeNull()
        expect(pubblica()).toHaveAttribute('aria-disabled', 'false')

        // L'ALTRA METÀ, nello stesso test: sbloccare non deve voler dire cancellare.
        //
        // 🔑 PERCHÉ SE LA MERITA. Un surrogato di questo test esiste e funziona:
        // pubblicare e guardare solo `scadenza_adesione === null`, zero asserzioni a
        // schermo — verde sul corretto, rosso sul rotto. Ma contro un'implementazione
        // che CANCELLA il valore al cambio tipo quel surrogato resta verde, e questa
        // riga va rossa: è lei che lega le due metà — «non blocca più» e «non si è
        // cancellato» — che il surrogato lascia divergere.
        //
        // ⚠️ E sta PRIMA dell'invio perché una pubblicazione riuscita chiama
        // `azzera()`: spostata dopo diventa rossa (`expected '' to be '11/10/2026'`),
        // e «aggiustarla» asserendo `''` — la tentazione — documenterebbe il reset al
        // posto della conservazione. Quello sì sarebbe il verde falso.
        tipoAdesione()
        expect((within(gruppoAdesione()).getByLabelText(itTeacher.formScadenzaAdesioneData) as HTMLInputElement).value).toBe(
            '11/10/2026',
        )
        expect(pubblica()).toHaveAttribute('aria-disabled', 'true')

        // E il corpo parte davvero, con la seconda scadenza a `null`.
        tipoPresaVisione()
        fireEvent.click(pubblica())
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
        expect(onSubmit.mock.calls[0][0].scadenza_adesione).toBeNull()
        expect(onSubmit.mock.calls[0][0].scadenza_avviso).toBe('2026-10-10T23:59')
    })

    it('«manca l’ora» appartiene al campo e compare al BLUR, non alla battuta', () => {
        monta()
        const gruppo = gruppoAvviso()
        const ora = within(gruppo).getByLabelText(itTeacher.formScadenzaAvvisoOra)
        // Svuotata a mano e ancora a fuoco: nessun rimprovero.
        fireEvent.change(ora, { target: { value: '' } })
        expect(screen.queryByText(itTeacher.formScadenzaOraMancante)).toBeNull()
        // Lasciato il campo, il modulo lo dice.
        fireEvent.blur(ora)
        expect(screen.getByText(itTeacher.formScadenzaOraMancante)).toBeInTheDocument()
        // E torna a tacere appena si riprende a scrivere.
        fireEvent.change(ora, { target: { value: '18:00' } })
        expect(screen.queryByText(itTeacher.formScadenzaOraMancante)).toBeNull()
    })
})

// =============================================================================
// 3 · La bandierina «chiedi il numero di partecipanti»
// =============================================================================

describe('AvvisoForm — il contatore di partecipanti', () => {
    it('è una checkbox NATIVA, e i campi dipendenti si montano e si smontano', () => {
        monta()
        tipoAdesione()
        const flag = bandierina() as HTMLInputElement
        expect(flag.type).toBe('checkbox')
        expect(flag.checked).toBe(false)
        // Spenta: il gruppo NON è nell'albero. Nascosto con `hidden` resterebbe
        // raggiungibile col Tab, letto dagli assistivi e — un giorno — spedito.
        expect(screen.queryByLabelText(itTeacher.formLabelDomandaPartecipanti)).toBeNull()
        expect(flag.getAttribute('aria-controls')).toBeNull()

        fireEvent.click(flag)
        const domanda = screen.getByLabelText(itTeacher.formLabelDomandaPartecipanti)
        expect(domanda).toBeInTheDocument()
        // …e la relazione è dichiarata: `aria-controls` punta al gruppo che esiste.
        const controllato = document.getElementById(flag.getAttribute('aria-controls') as string)
        expect(controllato).not.toBeNull()
        expect(controllato).toContainElement(domanda)
    })

    it('🔴 a bandierina SPENTA i campi non viaggiano nel payload, ma non si cancellano', async () => {
        const onSubmit = vi.fn<Invio>(async () => ({ ok: true }))
        monta(onSubmit)
        compilaTesto()
        tipoAdesione()
        scadenzaAvviso('10/10/2026')
        scadenzaAdesione('09/10/2026')

        fireEvent.click(bandierina())
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelDomandaPartecipanti), {
            target: { value: 'Quanti adulti vengono?' },
        })
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelPartecipantiMin), { target: { value: '2' } })
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelPartecipantiMax), { target: { value: '6' } })

        // Si spegne — il gesto che si fa per vedere «come verrebbe senza» — e si
        // riaccende. Questa è la metà «non si cancella»: senza, la metà sul payload
        // sarebbe soddisfatta anche da un'implementazione che azzera tutto.
        fireEvent.click(bandierina())
        fireEvent.click(bandierina())
        expect((screen.getByLabelText(itTeacher.formLabelDomandaPartecipanti) as HTMLInputElement).value).toBe(
            'Quanti adulti vengono?',
        )
        expect((screen.getByLabelText(itTeacher.formLabelPartecipantiMin) as HTMLInputElement).value).toBe('2')

        // Spenta sul serio, e si pubblica: nel payload non c'è niente di tutto questo.
        fireEvent.click(bandierina())
        fireEvent.click(pubblica())
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
        const payload = onSubmit.mock.calls[0][0]
        expect(payload.chiedi_numero).toBe(false)
        expect(payload.etichetta_numero).toBeNull()
        expect(payload.numero_min).toBeNull()
        expect(payload.numero_max).toBeNull()
    })

    it('anche tornando a «presa visione» i valori restano, e il payload li esclude', async () => {
        const onSubmit = vi.fn<Invio>(async () => ({ ok: true }))
        monta(onSubmit)
        compilaTesto()
        tipoAdesione()
        scadenzaAvviso('10/10/2026')
        scadenzaAdesione('10/10/2026')
        fireEvent.click(bandierina())
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelDomandaPartecipanti), {
            target: { value: 'Quante persone?' },
        })
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelPostiTotali), { target: { value: '40' } })

        // Andata e ritorno: la sezione intera si smonta e si rimonta, e quello che si
        // era scritto è ancora lì — compresa la scadenza d'adesione.
        tipoPresaVisione()
        tipoAdesione()
        expect((screen.getByLabelText(itTeacher.formLabelDomandaPartecipanti) as HTMLInputElement).value).toBe(
            'Quante persone?',
        )
        expect((within(gruppoAdesione()).getByLabelText(itTeacher.formScadenzaAdesioneData) as HTMLInputElement).value).toBe(
            '10/10/2026',
        )

        tipoPresaVisione()
        fireEvent.click(pubblica())
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
        const payload = onSubmit.mock.calls[0][0]
        expect(payload.chiedi_numero).toBe(false)
        expect(payload.etichetta_numero).toBeNull()
        expect(payload.posti_totali).toBeNull()
        // La scadenza d'adesione resta scritta ma non parte: un avviso di presa
        // visione non raccoglie adesioni, e archiviarne il termine sarebbe un dato
        // che poi qualcuno leggerà come se contasse.
        expect(payload.scadenza_adesione).toBeNull()
    })

    it('accesa e con la domanda scritta, i tre numeri arrivano al server', async () => {
        const onSubmit = vi.fn<Invio>(async () => ({ ok: true }))
        monta(onSubmit)
        compilaTesto()
        tipoAdesione()
        scadenzaAvviso('10/10/2026')
        scadenzaAdesione('08/10/2026')
        fireEvent.click(bandierina())
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelDomandaPartecipanti), {
            target: { value: 'Quanti adulti accompagneranno il bambino?' },
        })
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelPartecipantiMin), { target: { value: '1' } })
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelPartecipantiMax), { target: { value: '4' } })
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelPostiTotali), { target: { value: '50' } })

        fireEvent.click(pubblica())
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
        expect(onSubmit.mock.calls[0][0]).toMatchObject({
            scadenza_avviso: '2026-10-10T23:59',
            scadenza_adesione: '2026-10-08T23:59',
            chiedi_numero: true,
            etichetta_numero: 'Quanti adulti accompagneranno il bambino?',
            numero_min: 1,
            numero_max: 4,
            posti_totali: 50,
        })
    })

    it('minimo e massimo non indicati partono `null`: l’1 e il 20 li scrive il SERVER', async () => {
        const onSubmit = vi.fn<Invio>(async () => ({ ok: true }))
        monta(onSubmit)
        compilaTesto()
        tipoAdesione()
        scadenzaAvviso('10/10/2026')
        scadenzaAdesione('10/10/2026')
        fireEvent.click(bandierina())
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelDomandaPartecipanti), { target: { value: 'Quanti?' } })

        // I campi mostrano i predefiniti come SEGNAPOSTO, non come valore: `null` in
        // colonna non è «zero», è «decidi tu» — e chi decide è il `DEFAULT` del DDL.
        expect((screen.getByLabelText(itTeacher.formLabelPartecipantiMin) as HTMLInputElement).placeholder).toBe('1')
        expect((screen.getByLabelText(itTeacher.formLabelPartecipantiMax) as HTMLInputElement).placeholder).toBe('20')

        fireEvent.click(pubblica())
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
        const payload = onSubmit.mock.calls[0][0]
        expect(payload.numero_min).toBeNull()
        expect(payload.numero_max).toBeNull()
        expect(payload.chiedi_numero).toBe(true)
    })

    it('minimo maggiore del massimo: lo dice accanto ai campi e non si pubblica', () => {
        monta()
        compilaTesto()
        tipoAdesione()
        scadenzaAvviso('10/10/2026')
        scadenzaAdesione('10/10/2026')
        fireEvent.click(bandierina())
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelDomandaPartecipanti), { target: { value: 'Quanti?' } })
        expect(pubblica()).toHaveAttribute('aria-disabled', 'false')

        fireEvent.change(screen.getByLabelText(itTeacher.formLabelPartecipantiMin), { target: { value: '8' } })
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelPartecipantiMax), { target: { value: '3' } })
        expect(screen.getByText(itTeacher.formErroreMinMaggioreMax)).toBeInTheDocument()
        expect(pubblica()).toHaveAttribute('aria-disabled', 'true')
    })

    it('la domanda vuota blocca, e lo dice solo DOPO che si è lasciato il campo', () => {
        const onSubmit = vi.fn<Invio>(async () => ({ ok: true }))
        monta(onSubmit)
        compilaTesto()
        tipoAdesione()
        scadenzaAvviso('10/10/2026')
        scadenzaAdesione('10/10/2026')
        fireEvent.click(bandierina())

        // Appena accesa: il campo è vuoto perché nessuno l'ha ancora scritto, non
        // perché sia sbagliato. Nessun rimprovero.
        expect(screen.queryByText(itTeacher.formErroreDomandaMancante)).toBeNull()
        expect(pubblica()).toHaveAttribute('aria-disabled', 'true')

        // Premere il bottone spento è il gesto di chi non capisce perché: da lì in
        // poi il modulo parla. È il rimedio all'incidente dei 442 click.
        fireEvent.click(pubblica())
        expect(onSubmit).not.toHaveBeenCalled()
        expect(screen.getByText(itTeacher.formErroreDomandaMancante)).toBeInTheDocument()

        fireEvent.change(screen.getByLabelText(itTeacher.formLabelDomandaPartecipanti), { target: { value: 'Quanti?' } })
        expect(screen.queryByText(itTeacher.formErroreDomandaMancante)).toBeNull()
        expect(pubblica()).toHaveAttribute('aria-disabled', 'false')
    })

    it('il tetto di posti vale anche SENZA contatore: conta persone, e una famiglia ne vale una', async () => {
        // ⚠️ Decisione dichiarata: `posti_totali` sta FUORI dal gruppo governato dalla
        // bandierina. Chiuderlo dentro vorrebbe dire che per limitare i posti di una
        // gita bisogna per forza chiedere quante persone vengono — vincolo che né il
        // DDL né le rotte impongono (`COALESCE(numero_partecipanti, 1)`).
        const onSubmit = vi.fn<Invio>(async () => ({ ok: true }))
        monta(onSubmit)
        compilaTesto()
        tipoAdesione()
        scadenzaAvviso('10/10/2026')
        scadenzaAdesione('10/10/2026')
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelPostiTotali), { target: { value: '25' } })

        expect((bandierina() as HTMLInputElement).checked).toBe(false)
        fireEvent.click(pubblica())
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
        expect(onSubmit.mock.calls[0][0].posti_totali).toBe(25)
        expect(onSubmit.mock.calls[0][0].chiedi_numero).toBe(false)
    })
})

// =============================================================================
// 4 · CHE COSA STA SUCCEDENDO ADESSO: l'allegato in caricamento
//
// `fileUploading` è la settima condizione che spegne il bottone d'invio, e la riga
// «cosa manca» resta giustamente VUOTA: non manca niente, il file c'è e sta
// arrivando. Infilarcelo direbbe il falso — «manca ancora: file allegato» su un
// file già scelto — e le quattro chiavi candidate dicono tutte quello. Ma il
// difetto non chiede che qualcosa MANCHI: chiede che qualcosa lo ANNUNCI. Lo stato
// va quindi nella regione viva che porta già «sto pubblicando», con la chiave che
// il bottone di caricamento mostra già a schermo (`formFileCaricamento`, in it e in
// en, autoportante fuori da qualunque cornice). Nessuna chiave nuova.
//
// ⚠️ Questo blocco non parla di scadenze: sta qui perché è il file di test di
// `AvvisoForm` che il cantiere delle due scadenze poteva toccare. Se un giorno il
// file si spezza, questo va con la regione `role="status"`.
// =============================================================================

describe('AvvisoForm — l’allegato in caricamento si ANNUNCIA', () => {
    afterEach(() => vi.unstubAllGlobals())

    /** Un upload che resta in volo finché non lo si rilascia. */
    function uploadSospeso() {
        let rilascia!: () => void
        const inVolo = new Promise<void>((r) => {
            rilascia = r
        })
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                await inVolo
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ path: 'avvisi/2026/modulo.pdf', fileUrl: 'avvisi/2026/modulo.pdf', previewUrl: null }),
                }
            }),
        )
        return { rilascia }
    }

    it('🔴 spegne il bottone d’invio, e adesso la ragione si SENTE', async () => {
        const { rilascia } = uploadSospeso()
        const { container } = monta()
        compilaTesto()
        scadenzaAvviso('31/12/2026')

        // La regione esiste GIÀ ed è vuota: una `aria-live` nata insieme al proprio
        // testo non viene annunciata, quindi il controllo positivo è «c'è, ed è
        // vuota» — non «non c'è». È una `<span>`: le regioni `role="status"` di
        // questo modulo sono due, e la query va resa specifica o pesca il sosia.
        const regione = container.querySelector('span[role="status"]') as HTMLElement
        expect(regione).not.toBeNull()
        expect(regione).toBeEmptyDOMElement()
        expect(pubblica()).toHaveAttribute('aria-disabled', 'false')

        const input = container.querySelector('input[type="file"]') as HTMLInputElement
        fireEvent.change(input, { target: { files: [new File(['x'], 'modulo.pdf', { type: 'application/pdf' })] } })

        await waitFor(() => expect(regione).toHaveTextContent(itTeacher.formFileCaricamento))

        // Le due metà insieme: il bottone è spento, e la riga «cosa manca» resta
        // vuota. Senza la seconda, questo test sarebbe verde anche su una riga che
        // dice il falso («manca ancora: file allegato» su un file che c'è).
        const cta = pubblica()
        expect(cta).toHaveAttribute('aria-disabled', 'true')
        expect(rigaMotivo(cta)).toBeEmptyDOMElement()

        // E finito il caricamento la regione torna vuota: un annuncio che resta è
        // indistinguibile da un annuncio che non si aggiorna più.
        rilascia()
        await waitFor(() => expect(regione).toBeEmptyDOMElement())
        expect(pubblica()).toHaveAttribute('aria-disabled', 'false')
    })
})
