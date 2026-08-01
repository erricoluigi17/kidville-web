import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import itShared from '../../messages/it/shared.json'
import itTeacher from '../../messages/it/teacherComunicazioni.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

// =============================================================================
// S31 · IL CODICE TRADOTTO CHE NESSUN CLIENT LEGGEVA.
//
// L'ondata 4 ha dato al server due codici d'errore per gli allegati
// (`ALLEGATO_TIPO_NON_AMMESSO` → 415, `ALLEGATO_TROPPO_GRANDE` → 413), li ha
// dichiarati in `CODICI_ERRORE` e li ha tradotti in italiano e in inglese. Poi il
// modulo degli avvisi ha continuato a mostrare `alert('Impossibile caricare il
// file. Riprova.')` per QUALUNQUE rifiuto: la traduzione esisteva e l'utente non
// la vedeva. Chi allega un `.txt` non ha modo di sapere che il problema è il tipo
// del file, e riprova con lo stesso file.
//
// Le asserzioni qui sono sul TESTO CHE COMPARE A SCHERMO — non sullo stato
// interno, non sul fatto che «non è fallito» — e ogni asserzione negativa ha il
// suo controllo positivo: senza il caso «l'upload riesce» un modulo che mostrasse
// SEMPRE un errore passerebbe le prime prove.
//
// I testi attesi si leggono dai cataloghi veri, non si riscrivono qui: una copia
// a mano resterebbe verde il giorno in cui qualcuno cambia la traduzione, che è
// il giorno in cui questo lock dovrebbe accorgersene.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

import { AvvisoForm, type ClasseAvviso } from '@/components/features/avvisi/AvvisoForm'

const CLASSI: ClasseAvviso[] = [
    { id: 'sez-a-2anni', nome: '2 ANNI', scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A },
]

/** La risposta del server: `Response` vera, così `messaggioErrore` legge un corpo vero. */
const risposta = (stato: number, corpo?: unknown): Response =>
    new Response(corpo === undefined ? null : JSON.stringify(corpo), {
        status: stato,
        headers: { 'Content-Type': 'application/json' },
    })

const fetchMock = vi.fn()

function montaModulo() {
    return render(
        <AvvisoForm
            open
            onClose={() => {}}
            onSubmit={async () => ({ ok: true })}
            availableClasses={CLASSI}
        />,
    )
}

/** Sceglie un file nell'input nascosto: è il gesto che avvia `processaFile`. */
function scegliFile(container: HTMLElement, nome = 'note.txt', tipo = 'text/plain') {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], nome, { type: tipo })] } })
}

beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('AvvisoForm · il rifiuto dell’allegato arriva a schermo TRADOTTO', () => {
    it('415 `ALLEGATO_TIPO_NON_AMMESSO` → il testo del catalogo, non il messaggio generico', async () => {
        fetchMock.mockResolvedValue(
            risposta(415, {
                error: 'Questo tipo di file non si può allegare: sono ammessi immagini, PDF e documenti Word.',
                codice: 'ALLEGATO_TIPO_NON_AMMESSO',
            }),
        )
        const { container } = montaModulo()

        scegliFile(container)

        const avviso = await screen.findByRole('alert')
        expect(avviso).toHaveTextContent(itShared.erroreAllegatoTipoNonAmmesso)
        expect(
            avviso.textContent,
            'Il messaggio generico nasconde l’unica informazione utile: che è il TIPO del file a non andare bene.',
        ).not.toContain(itTeacher.formAlertUploadFallito)
    })

    it('413 `ALLEGATO_TROPPO_GRANDE` → il limite si legge a schermo', async () => {
        fetchMock.mockResolvedValue(
            risposta(413, { error: 'Il file è troppo grande.', codice: 'ALLEGATO_TROPPO_GRANDE' }),
        )
        const { container } = montaModulo()

        scegliFile(container, 'grosso.pdf', 'application/pdf')

        expect(await screen.findByRole('alert')).toHaveTextContent(itShared.erroreAllegatoTroppoGrande)
    })

    it('500 senza codice → resta il messaggio generico (mai il vuoto)', async () => {
        // Il ripiego serve: una risposta senza corpo leggibile non deve produrre una
        // riga d'errore VUOTA, che a schermo è indistinguibile dal silenzio di prima.
        fetchMock.mockResolvedValue(risposta(500))
        const { container } = montaModulo()

        scegliFile(container, 'circolare.pdf', 'application/pdf')

        expect(await screen.findByRole('alert')).toHaveTextContent(itTeacher.formAlertUploadFallito)
    })

    it('il nome del file rifiutato non resta appeso nel modulo', async () => {
        fetchMock.mockResolvedValue(risposta(415, { error: 'no', codice: 'ALLEGATO_TIPO_NON_AMMESSO' }))
        const { container } = montaModulo()

        scegliFile(container, 'note.txt')

        await screen.findByRole('alert')
        // Se restasse, l'operatore pubblicherebbe convinto di aver allegato qualcosa.
        expect(screen.queryByText('note.txt')).toBeNull()
    })

    it('CONTROLLO POSITIVO · l’upload che riesce non mostra nessun errore e tiene il file', async () => {
        fetchMock.mockResolvedValue(
            risposta(200, { path: '1785-abc.pdf', fileUrl: '1785-abc.pdf', previewUrl: null }),
        )
        const { container } = montaModulo()

        scegliFile(container, 'circolare.pdf', 'application/pdf')

        await waitFor(() => expect(screen.getByText('circolare.pdf')).toBeInTheDocument())
        expect(screen.queryByRole('alert')).toBeNull()
    })
})
