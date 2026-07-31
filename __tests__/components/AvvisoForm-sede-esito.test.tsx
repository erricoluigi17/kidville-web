import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import itTeacher from '../../messages/it/teacherComunicazioni.json'
import enTeacher from '../../messages/en/teacherComunicazioni.json'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

// =============================================================================
// W3-F — `AvvisoForm`: la sede si sceglie, e il rifiuto del server si VEDE.
//
// Due difetti, una sola radice: il modulo non sapeva niente né della sede né
// dell'esito.
//
//  · R69 (client) — la pagina appiattiva le sezioni di TUTTE le sedi in un
//    `new Set(nomi)`. Con tre plessi «2 ANNI» esiste ad Aversa e a Cesa: una
//    pillola sola per due classi diverse, e nessun modo di dire al server DOVE
//    si stava pubblicando. Il server (W2-B) ora accetta `scuola_id` e senza di
//    quello risponde 400: se il client non lo manda, l'avviso non parte più.
//
//  · R78 — `handleSubmit` faceva `await onSubmit(...)` e poi SEMPRE reset +
//    `onClose()`. Un 400 o un 403 chiudeva il modale e cancellava il testo che
//    l'operatore aveva appena scritto, senza lasciare traccia a schermo.
//
// Metodo (regola trasversale del piano): niente asserzioni «non è fallito». Si
// asserisce il PAYLOAD esatto consegnato a `onSubmit` (con quale `scuola_id`),
// e lo stato del modulo dopo il rifiuto (aperto, con il testo ancora dentro).
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

import { AvvisoForm, type ClasseAvviso, type DatiAvviso, type EsitoInvioAvviso } from '@/components/features/avvisi/AvvisoForm'

/** Doppio di `onSubmit` con l'esito deciso dal test. */
type Invio = (d: DatiAvviso) => Promise<EsitoInvioAvviso>
const invio = (esito: EsitoInvioAvviso) => vi.fn<Invio>(async () => esito)

/** Il nome che esiste in ENTRAMBE le sedi: è l'omonimia a rendere ambiguo il nome nudo. */
const OMONIMA = '2 ANNI'

const CLASSI: ClasseAvviso[] = [
    { id: 'sez-a-2anni', nome: OMONIMA, scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A },
    { id: 'sez-a-3anni', nome: '3 ANNI A', scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A },
    { id: 'sez-b-2anni', nome: OMONIMA, scuolaId: SEDE_B, scuolaNome: NOME_SEDE_B },
]

function compila(titolo = 'Chiusura per ponte', contenuto = 'La scuola resta chiusa venerdì.') {
    fireEvent.change(screen.getByPlaceholderText(itTeacher.formPlaceholderTitolo), { target: { value: titolo } })
    fireEvent.change(screen.getByPlaceholderText(itTeacher.formPlaceholderContenuto), { target: { value: contenuto } })
}

const pubblica = () => screen.getByRole('button', { name: new RegExp(itTeacher.formSubmitPubblicaAvviso, 'i') })

beforeEach(() => {
    vi.clearAllMocks()
})

describe('AvvisoForm — la sede dichiarata', () => {
    it('con due sedi il modulo chiede la sede, e finché non la si sceglie non si pubblica', async () => {
        const onSubmit = invio({ ok: true })
        render(<AvvisoForm open onClose={vi.fn()} onSubmit={onSubmit} availableClasses={CLASSI} />)

        compila()
        // Il selettore di sede esiste e propone ESATTAMENTE le due sedi (più il
        // segnaposto «scegli»): nessuna preselezione, come per il form alunno.
        const sede = screen.getByLabelText(itTeacher.formLabelSedePubblicazione) as HTMLSelectElement
        expect(sede.value).toBe('')
        expect(
            Array.from(sede.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value),
        ).toEqual(['', SEDE_A, SEDE_B])

        expect(pubblica()).toBeDisabled()
        fireEvent.click(pubblica())
        expect(onSubmit).not.toHaveBeenCalled()
    })

    it('scelta la sede, il payload porta quella sede e SOLO le sue classi', async () => {
        const onSubmit = invio({ ok: true })
        render(<AvvisoForm open onClose={vi.fn()} onSubmit={onSubmit} availableClasses={CLASSI} />)

        compila()
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelSedePubblicazione), { target: { value: SEDE_B } })

        // Destinatari «per classe» → restano le sole classi della sede scelta.
        fireEvent.click(screen.getByRole('button', { name: itTeacher.formDestinatariPerClasse }))
        expect(screen.getAllByRole('button', { name: OMONIMA })).toHaveLength(1)
        expect(screen.queryByRole('button', { name: '3 ANNI A' })).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: OMONIMA }))
        fireEvent.click(pubblica())

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
        const payload = onSubmit.mock.calls[0][0]
        expect(payload.scuola_id).toBe(SEDE_B)
        expect(payload.target_scope).toBe('classe')
        expect(payload.target_classes).toEqual([OMONIMA])
    })

    it('cambiare sede azzera le classi scelte: non si pubblica a una classe di un altro plesso', async () => {
        const onSubmit = invio({ ok: true })
        render(<AvvisoForm open onClose={vi.fn()} onSubmit={onSubmit} availableClasses={CLASSI} />)

        compila()
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelSedePubblicazione), { target: { value: SEDE_A } })
        fireEvent.click(screen.getByRole('button', { name: itTeacher.formDestinatariPerClasse }))
        fireEvent.click(screen.getByRole('button', { name: '3 ANNI A' }))

        fireEvent.change(screen.getByLabelText(itTeacher.formLabelSedePubblicazione), { target: { value: SEDE_B } })
        // Nessuna classe selezionata ⇒ il modulo di classe non è inviabile.
        expect(pubblica()).toBeDisabled()

        fireEvent.click(screen.getByRole('button', { name: OMONIMA }))
        fireEvent.click(pubblica())
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
        const payload = onSubmit.mock.calls[0][0]
        expect(payload.scuola_id).toBe(SEDE_B)
        expect(payload.target_classes).toEqual([OMONIMA])
    })

    it('con UNA sola sede la si dichiara lo stesso, senza chiederla all\'operatore', async () => {
        const onSubmit = invio({ ok: true })
        render(
            <AvvisoForm
                open
                onClose={vi.fn()}
                onSubmit={onSubmit}
                availableClasses={CLASSI.filter((c) => c.scuolaId === SEDE_A)}
            />,
        )
        compila()
        expect(screen.queryByLabelText(itTeacher.formLabelSedePubblicazione)).not.toBeInTheDocument()
        fireEvent.click(pubblica())
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
        expect(onSubmit.mock.calls[0][0].scuola_id).toBe(SEDE_A)
    })
})

describe('AvvisoForm — l\'esito del server', () => {
    it('rifiutato dal server: il modulo resta aperto, il testo resta dentro, l\'errore si vede', async () => {
        const onClose = vi.fn()
        const onSubmit = invio({ ok: false, errore: 'Specificare la sede (scuola_id) per questa operazione' })
        render(
            <AvvisoForm
                open
                onClose={onClose}
                onSubmit={onSubmit}
                availableClasses={CLASSI.filter((c) => c.scuolaId === SEDE_A)}
            />,
        )

        compila('Uscita anticipata', 'Domani si esce alle 12.')
        fireEvent.click(pubblica())

        await waitFor(() =>
            expect(screen.getByText(/Specificare la sede/i)).toBeInTheDocument(),
        )
        expect(onClose).not.toHaveBeenCalled()
        // Il testo dell'operatore NON è stato buttato via.
        expect((screen.getByPlaceholderText(itTeacher.formPlaceholderTitolo) as HTMLInputElement).value)
            .toBe('Uscita anticipata')
        expect((screen.getByPlaceholderText(itTeacher.formPlaceholderContenuto) as HTMLTextAreaElement).value)
            .toBe('Domani si esce alle 12.')
        // E il bottone torna utilizzabile: si può correggere e riprovare.
        expect(pubblica()).toBeEnabled()
    })

    it('rifiutato senza messaggio: mostra comunque un errore, mai il silenzio', async () => {
        const onClose = vi.fn()
        const onSubmit = invio({ ok: false })
        render(
            <AvvisoForm
                open
                onClose={onClose}
                onSubmit={onSubmit}
                availableClasses={CLASSI.filter((c) => c.scuolaId === SEDE_A)}
            />,
        )
        compila()
        fireEvent.click(pubblica())
        await waitFor(() => expect(screen.getByText(itTeacher.formErroreInvio)).toBeInTheDocument())
        expect(onClose).not.toHaveBeenCalled()
    })

    it('riuscito: il modulo si chiude e si svuota', async () => {
        const onClose = vi.fn()
        const onSubmit = invio({ ok: true })
        render(
            <AvvisoForm
                open
                onClose={onClose}
                onSubmit={onSubmit}
                availableClasses={CLASSI.filter((c) => c.scuolaId === SEDE_A)}
            />,
        )
        compila()
        fireEvent.click(pubblica())
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
        expect((screen.getByPlaceholderText(itTeacher.formPlaceholderTitolo) as HTMLInputElement).value).toBe('')
    })
})

describe('AvvisoForm — i18n', () => {
    it('le chiavi nuove esistono in ENTRAMBI i cataloghi', () => {
        for (const k of ['formLabelSedePubblicazione', 'formSedeScegli', 'formErroreInvio']) {
            expect(itTeacher).toHaveProperty(k)
            expect(enTeacher).toHaveProperty(k)
        }
    })

    it('teacherComunicazioni: it ed en espongono lo stesso set di chiavi', () => {
        expect(Object.keys(itTeacher).sort()).toEqual(Object.keys(enTeacher).sort())
    })
})
