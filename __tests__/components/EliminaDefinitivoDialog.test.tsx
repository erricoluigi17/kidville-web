import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

import itShared from '../../messages/it/shared.json'

/**
 * «ELIMINA DEFINITIVAMENTE» — la finestra della linguetta «Non iscritti».
 *
 * Si prova sulla CHIAMATA e sul TESTO A SCHERMO, come «Libera spazio»: quale POST
 * parte, con quale `scelta`, e che cosa legge chi decide prima di un'operazione
 * senza annulla. Il server ricontrolla tutto; qui si verifica che la finestra
 * offra SOLO le scelte che il server ha detto disponibili, e che un comando non
 * disponibile resti a schermo spento, con il motivo, e senza effetto al click.
 *
 * ─── PERCHÉ next-intl È FINTO CON IL FORMATTATORE VERO ───────────────────────
 * Stesso stampo di `LiberaSpazioDialog.test.tsx`: con la stringa grezza i plurali
 * («{n, plural, one {# presenza} …}») resterebbero segnaposti, e «1 presenza»
 * non comparirebbe mai. E questo finto restituisce una `t` NUOVA a ogni render:
 * se la finestra mettesse `t` fra le dipendenze della misura, girerebbe
 * all'infinito sparando un dry-run per giro — qui lo si vedrebbe subito.
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

const logClient = vi.fn()
vi.mock('@/lib/logging/client', async (originale) => ({
    ...(await originale<typeof import('@/lib/logging/client')>()),
    logClient: (...args: unknown[]) => logClient(...args),
}))

import { EliminaDefinitivoDialog } from '@/components/features/admin/EliminaDefinitivoDialog'

/* ── Il bambino di prova. Nome finto: il repository è PUBBLICO. ─────────────── */
const AL = { id: 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa', nome: 'Bambino', cognome: 'DiProva' }

/** La risposta del dry-run, nella forma che la rotta serializza. */
const anteprima = (scelte: Record<string, boolean>, motivo: string | null, conteggi: Record<string, unknown> = {}) => ({
    ok: true,
    status: 200,
    json: async () => ({
        dryrun: true,
        conteggi: {
            presenze: 1, diario: 0, legami_genitori: 1, pagamenti: 0, pagamenti_bloccati: 0, registro_primaria: false,
            pagelle: 0, certificati_medici: 0, fascicolo_sanitario: 0, foto_solo_sue: 0, foto_di_gruppo: 0,
            foto_non_rimovibili: 0, articoli_pubblici: 0, allegati_chat: 0, ...conteggi,
        },
        scelte,
        motivo,
    }),
})

/** Il corpo JSON della n-esima POST. */
const corpoDi = (n: number) =>
    JSON.parse((fetchMock.mock.calls[n] as [string, { body: string }])[1].body) as Record<string, unknown>

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
    vi.clearAllMocks()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
})

describe('EliminaDefinitivoDialog', () => {
    it('senza pagamenti: mostra i numeri e un solo bottone rosso; il click esegue «elimina»', async () => {
        fetchMock
            .mockResolvedValueOnce(anteprima({ elimina: true, elimina_con_pagamenti: false, anonimizza: false }, null))
            .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, scelta: 'elimina' }) })
        const onEliminato = vi.fn()
        const onChiudi = vi.fn()
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={onChiudi} onEliminato={onEliminato} />)

        // Si conta PRIMA di offrire: il dry-run è la prima e unica chiamata all'apertura.
        expect(await screen.findByText(/1 presenza/)).toBeInTheDocument()
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/students/elimina')
        expect(corpoDi(0)).toEqual({ alunno_id: AL.id, mode: 'dryrun' })

        expect(screen.getByText('1 legame con un genitore')).toBeInTheDocument()
        expect(screen.getByText(/I genitori non vengono toccati/)).toBeInTheDocument()
        // Le voci a zero non si stampano.
        expect(screen.queryByText(/diario/)).toBeNull()
        expect(screen.queryByRole('button', { name: /Anonimizza/ })).toBeNull()
        expect(screen.queryByRole('button', { name: /Cancella anche i pagamenti/ })).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Elimina definitivamente' }))
        await waitFor(() => expect(onEliminato).toHaveBeenCalledWith(expect.stringContaining('eliminata definitivamente')))
        expect(onEliminato).toHaveBeenCalledWith('DiProva Bambino: scheda eliminata definitivamente.')
        expect(onChiudi).toHaveBeenCalled()
        expect(corpoDi(1)).toEqual({ alunno_id: AL.id, mode: 'execute', scelta: 'elimina' })
    })

    it('con pagamenti bloccati: «Cancella anche i pagamenti» è spento col motivo, «Anonimizza» è attivo', async () => {
        fetchMock
            .mockResolvedValueOnce(
                anteprima(
                    { elimina: false, elimina_con_pagamenti: false, anonimizza: true },
                    'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI',
                    { pagamenti: 2, pagamenti_bloccati: 1 },
                ),
            )
            .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, scelta: 'anonimizza' }) })
        const onEliminato = vi.fn()
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={onEliminato} />)

        const cancella = await screen.findByRole('button', { name: /Cancella anche i pagamenti/ })
        expect(cancella).toHaveAttribute('aria-disabled', 'true')
        expect(screen.getByText(/non si possono cancellare/)).toBeInTheDocument()
        expect(screen.getByText('2 pagamenti')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Elimina definitivamente' })).toBeNull()
        const anonimizza = screen.getByRole('button', { name: /Anonimizza e tieni la contabilità/ })
        expect(anonimizza).not.toHaveAttribute('aria-disabled', 'true')

        // `aria-disabled` NON ferma il click da solo: deve fermarlo la finestra.
        fireEvent.click(cancella)
        expect(fetchMock).toHaveBeenCalledTimes(1)

        fireEvent.click(anonimizza)
        await waitFor(() => expect(onEliminato).toHaveBeenCalledWith(expect.stringContaining('anonimizzati')))
        expect(corpoDi(1)).toEqual({ alunno_id: AL.id, mode: 'execute', scelta: 'anonimizza' })
    })

    it('con il registro della primaria: nessun comando distruttivo, solo «Chiudi»', async () => {
        fetchMock.mockResolvedValueOnce(
            anteprima(
                { elimina: false, elimina_con_pagamenti: false, anonimizza: false },
                'REGISTRO_PRIMARIA_DA_CONSERVARE',
                { registro_primaria: true },
            ),
        )
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={vi.fn()} />)
        expect(await screen.findByText(/il registro va conservato per legge/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Elimina definitivamente|Cancella|Anonimizza/ })).toBeNull()
        expect(screen.getByRole('button', { name: 'Chiudi' })).toBeInTheDocument()
    })

    it('anteprima fallita: messaggio, «Riprova», nessun comando distruttivo', async () => {
        fetchMock
            .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ codice: 'ALUNNO_ELIMINAZIONE_NON_MISURATA' }) })
            .mockResolvedValueOnce(anteprima({ elimina: true, elimina_con_pagamenti: false, anonimizza: false }, null))
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={vi.fn()} />)

        const riprova = await screen.findByRole('button', { name: 'Riprova' })
        expect(screen.getByRole('alert')).toHaveTextContent(itShared.erroreAlunnoEliminazioneNonMisurata)
        expect(screen.queryByRole('button', { name: 'Elimina definitivamente' })).toBeNull()
        expect(logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', stato: 500 }))

        // «Riprova» rifà il dry-run, e solo a misura arrivata compare il comando.
        fireEvent.click(riprova)
        expect(await screen.findByRole('button', { name: 'Elimina definitivamente' })).toBeInTheDocument()
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(corpoDi(1)).toEqual({ alunno_id: AL.id, mode: 'dryrun' })
    })

    it('esecuzione rifiutata: la finestra resta aperta con il messaggio del server', async () => {
        fetchMock
            .mockResolvedValueOnce(anteprima({ elimina: true, elimina_con_pagamenti: false, anonimizza: false }, null))
            .mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ codice: 'ALUNNO_ELIMINAZIONE_FILE_RESTANTI' }) })
        const onEliminato = vi.fn()
        const onChiudi = vi.fn()
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={onChiudi} onEliminato={onEliminato} />)
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina definitivamente' }))
        expect(await screen.findByRole('alert')).toHaveTextContent(/non sono usciti/)
        expect(onEliminato).not.toHaveBeenCalled()
        expect(onChiudi).not.toHaveBeenCalled()
        // Il comando torna disponibile: si può riprovare.
        expect(screen.getByRole('button', { name: 'Elimina definitivamente' })).not.toHaveAttribute('aria-disabled', 'true')
        expect(logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', stato: 502 }))
    })
})
