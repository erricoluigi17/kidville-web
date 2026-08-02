import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { FormEvent } from 'react'

import itShared from '../../../messages/it/shared.json'

// =============================================================================
// S31 · gli INCARICHI: lo stesso codice tradotto che nessuno leggeva.
//
// `uploadFiles` (`src/components/features/teacher/tasks/useTasks.ts`) rispondeva
// a QUALUNQUE rifiuto del server con `Errore caricamento per il file: <nome>` —
// una frase che dice cosa è successo e non dice perché. Il server, dalla stessa
// richiesta, manda `{ codice: 'ALLEGATO_TIPO_NON_AMMESSO' }`, tradotto in
// italiano e in inglese: il testo esisteva e non arrivava mai a schermo.
//
// Qui si guarda la COSA CHE L'UTENTE VEDE: il messaggio che finisce nell'avviso a
// fine risoluzione dell'incarico. Non lo stato interno dell'hook, non «non è
// fallito».
//
// CONTROLLI POSITIVI, perché ogni asserzione negativa ne vuole uno:
//  · con l'upload che RIESCE l'incarico si chiude e nessun avviso compare;
//  · il ripiego generico resta quando il server non manda nessun codice.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))
vi.mock('@/lib/auth/use-session-identity', () => ({
    useSessionIdentity: () => ({ userId: 'ut-1', role: 'educator', ready: true }),
}))

import { useTasks } from '@/components/features/teacher/tasks/useTasks'
import type { Task } from '@/components/features/teacher/tasks/TaskCard'

const INCARICO = {
    id: 'inc-1',
    titolo: 'TEST incarico',
    status: 'in_progress',
    created_at: '2026-08-01T08:00:00.000Z',
    author_id: 'ut-2',
    assignees: ['ut-1'],
    compiti: [],
    commenti: [],
} as unknown as Task

const json = (stato: number, corpo: unknown): Response =>
    new Response(JSON.stringify(corpo), { status: stato, headers: { 'Content-Type': 'application/json' } })

/** Le chiamate di contorno dell'hook (ruolo, metadati, elenco) rispondono a vuoto. */
function fetchConUpload(rispostaUpload: Response) {
    return vi.fn(async (url: unknown) => {
        const u = String(url)
        if (u.includes('/api/tasks/upload')) return rispostaUpload
        if (u.includes('/api/educator-sections')) return json(200, { role: 'educator', sectionNames: [] })
        if (u.includes('/api/tasks/meta')) return json(200, { staff: [], students: [], classes: [] })
        if (u.includes('/api/tasks/')) return json(200, { ok: true })
        return json(200, [])
    })
}

const avviso = vi.fn()
const evento = { preventDefault: () => {} } as FormEvent

/** Porta l'hook fino all'invio della risoluzione con un allegato. */
async function risolviConAllegato(rispostaUpload: Response) {
    vi.stubGlobal('fetch', fetchConUpload(rispostaUpload))
    const { result } = renderHook(() => useTasks())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.openCompleteModal(INCARICO))
    act(() => result.current.setResolvingFiles([new File(['x'], 'note.txt', { type: 'text/plain' })]))
    await act(async () => { await result.current.handleConfirmResolution(evento) })
    return result
}

beforeEach(() => {
    avviso.mockReset()
    vi.stubGlobal('alert', avviso)
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('useTasks · il rifiuto dell’allegato arriva all’utente TRADOTTO', () => {
    it('415 con codice → il messaggio del catalogo, non il generico «Errore caricamento»', async () => {
        await risolviConAllegato(
            json(415, { error: 'Questo tipo di file non si può allegare.', codice: 'ALLEGATO_TIPO_NON_AMMESSO' }),
        )

        expect(avviso).toHaveBeenCalledTimes(1)
        const mostrato = String(avviso.mock.calls[0][0])
        expect(mostrato).toContain(itShared.erroreAllegatoTipoNonAmmesso)
        expect(
            mostrato,
            'La frase generica non dice all’insegnante che il problema è il TIPO del file.',
        ).not.toContain('Errore caricamento per il file')
    })

    it('413 con codice → si legge il limite, e il nome del file resta (se ne caricano più d’uno)', async () => {
        await risolviConAllegato(json(413, { error: 'troppo grande', codice: 'ALLEGATO_TROPPO_GRANDE' }))

        const mostrato = String(avviso.mock.calls[0][0])
        expect(mostrato).toContain(itShared.erroreAllegatoTroppoGrande)
        expect(mostrato).toContain('note.txt')
    })

    it('CONTROLLO POSITIVO · nessun codice → resta il ripiego generico, mai il vuoto', async () => {
        await risolviConAllegato(new Response(null, { status: 500 }))

        const mostrato = String(avviso.mock.calls[0][0])
        expect(mostrato).toContain('note.txt')
        expect(mostrato.trim().length).toBeGreaterThan(10)
    })

    it('CONTROLLO POSITIVO · quando l’upload riesce non compare nessun avviso', async () => {
        const result = await risolviConAllegato(
            json(200, { path: 'p.pdf', url: 'p.pdf', fileUrl: 'p.pdf', name: 'note.txt', size: 1, type: 'application/pdf' }),
        )

        expect(avviso).not.toHaveBeenCalled()
        // E la modale di risoluzione si è chiusa: l'incarico è stato davvero inviato.
        expect(result.current.resolvingTask).toBeNull()
    })
})
