import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react'
import { useCorrezioneAnno } from '@/components/features/anno/useCorrezioneAnno'
import type { Correzione } from '@/lib/anno/correzione'

/**
 * COMPITO 4.9.3 · il dialogo «Registra come correzione» e il gancio che lo apre.
 * Nessuna richiesta riparte senza conferma; «Registra» resta spento sotto gli 8 caratteri; Annulla restituisce il 409.
 */

const r409 = () =>
    Response.json({ error: 'Anno chiuso', codice: 'ANNO_CHIUSO', correzione_possibile: true }, { status: 409 })

let esito: Response | null = null

function Prova({ invia, etichetta = '2025/26' }: { invia: (c?: Correzione) => Promise<Response>; etichetta?: string }) {
    const { inviaConCorrezione, dialogo } = useCorrezioneAnno(etichetta || undefined)
    return (
        <div>
            <button
                type="button"
                onClick={async () => {
                    esito = await inviaConCorrezione(invia)
                }}
            >
                vai
            </button>
            {dialogo}
        </div>
    )
}

afterEach(() => {
    cleanup()
    esito = null
})

describe('useCorrezioneAnno + CorrezioneAnnoDialog', () => {
    it('un 409 apre il dialogo con l’anno; senza conferma non parte nessuna seconda richiesta', async () => {
        const invia = vi.fn().mockImplementation(async () => r409())
        render(<Prova invia={invia} />)
        fireEvent.click(screen.getByText('vai'))
        await screen.findByRole('textbox')
        expect(screen.getByText(/2025\/26/)).toBeTruthy()
        expect(invia).toHaveBeenCalledTimes(1)
    })

    it('la pagina non sa l’anno (votazioni, competenze): il dialogo usa quello che il 409 scrive in `etichetta`', async () => {
        const invia = vi.fn().mockImplementation(async () =>
            Response.json({ error: 'x', codice: 'ANNO_CHIUSO', correzione_possibile: true, etichetta: '2024/25' }, { status: 409 }),
        )
        render(<Prova invia={invia} etichetta="" />)
        fireEvent.click(screen.getByText('vai'))
        await screen.findByRole('textbox')
        expect(screen.getByText(/2024\/25/)).toBeTruthy()
    })

    it('né la pagina né il server sanno l’anno: «un anno già chiuso», senza anno inventato', async () => {
        const invia = vi.fn().mockImplementation(async () => r409())
        render(<Prova invia={invia} etichetta="" />)
        fireEvent.click(screen.getByText('vai'))
        await screen.findByRole('textbox')
        expect(screen.getByText(/Stai correggendo un anno già chiuso/)).toBeTruthy()
    })

    it('l’etichetta della pagina vince su quella del server', async () => {
        const invia = vi.fn().mockImplementation(async () =>
            Response.json({ error: 'x', codice: 'ANNO_CHIUSO', correzione_possibile: true, etichetta: '2024/25' }, { status: 409 }),
        )
        render(<Prova invia={invia} />)
        fireEvent.click(screen.getByText('vai'))
        await screen.findByRole('textbox')
        expect(screen.getByText(/2025\/26/)).toBeTruthy()
        expect(screen.queryByText(/2024\/25/)).toBeNull()
    })

    it('Registra è spento sotto gli 8 caratteri e non invia; a 8 invia UNA volta il motivo ripulito', async () => {
        const invia = vi
            .fn()
            .mockResolvedValueOnce(r409())
            .mockResolvedValueOnce(new Response('{}', { status: 201 }))
        render(<Prova invia={invia} />)
        fireEvent.click(screen.getByText('vai'))
        const area = await screen.findByRole('textbox')

        fireEvent.change(area, { target: { value: '1234567' } })
        const registra = screen.getByText('Registra la correzione')
        expect(registra.getAttribute('aria-disabled')).toBe('true')
        fireEvent.click(registra)
        expect(invia).toHaveBeenCalledTimes(1)

        fireEvent.change(area, { target: { value: '  12345678  ' } })
        expect(screen.getByText('Registra la correzione').getAttribute('aria-disabled')).toBe('false')
        fireEvent.click(screen.getByText('Registra la correzione'))
        await waitFor(() => expect(invia).toHaveBeenCalledTimes(2))
        expect(invia).toHaveBeenNthCalledWith(2, { motivo: '12345678' })
        await waitFor(() => expect(esito?.status).toBe(201))
        expect(screen.queryByRole('textbox')).toBeNull()
    })

    it('Annulla chiude il dialogo, non rimanda niente e restituisce il 409', async () => {
        const invia = vi.fn().mockImplementation(async () => r409())
        render(<Prova invia={invia} />)
        fireEvent.click(screen.getByText('vai'))
        await screen.findByRole('textbox')
        await act(async () => {
            fireEvent.click(screen.getByText('Annulla'))
        })
        await waitFor(() => expect(esito?.status).toBe(409))
        expect(invia).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole('textbox')).toBeNull()
    })

    it('uno smontaggio con il dialogo aperto non lascia la richiesta appesa e non rimanda niente', async () => {
        const invia = vi.fn().mockImplementation(async () => r409())
        const { unmount } = render(<Prova invia={invia} />)
        fireEvent.click(screen.getByText('vai'))
        await screen.findByRole('textbox')
        unmount()
        await waitFor(() => expect(esito?.status).toBe(409))
        expect(invia).toHaveBeenCalledTimes(1)
    })
})
