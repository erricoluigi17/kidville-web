import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'

import itAdminStudents from '../../messages/it/adminStudents.json'
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
            foto_non_rimovibili: 0, articoli_pubblici: 0, allegati_chat: 0, cf_condiviso_con_frequentante: false, ...conteggi,
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

const SOLO_ELIMINA = { elimina: true, elimina_con_pagamenti: false, anonimizza: false }
const NESSUNA = { elimina: false, elimina_con_pagamenti: false, anonimizza: false }
const CON_PAGAMENTI = { elimina: false, elimina_con_pagamenti: true, anonimizza: true }
const SOLO_ANONIMIZZA = { elimina: false, elimina_con_pagamenti: false, anonimizza: true }

/** Una risposta a corpo pieno. */
const risposta = (corpo: unknown, ok = true, status = 200) => ({ ok, status, json: async () => corpo })
const RIUSCITA = risposta({ ok: true })

describe('EliminaDefinitivoDialog — si conta prima di offrire', () => {
    it('senza pagamenti: mostra i numeri e un solo bottone rosso; il click esegue «elimina»', async () => {
        fetchMock.mockResolvedValueOnce(anteprima(SOLO_ELIMINA, null)).mockResolvedValueOnce(RIUSCITA)
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
        // Nessun doppione: nessun avviso.
        expect(screen.queryByText(/probabilmente è un doppione/)).toBeNull()
        // Le voci a zero non si stampano.
        expect(screen.queryByText(/diario/)).toBeNull()
        expect(screen.queryByRole('button', { name: /Anonimizza/ })).toBeNull()
        expect(screen.queryByRole('button', { name: /Cancella anche i pagamenti/ })).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Elimina definitivamente' }))
        await waitFor(() => expect(onEliminato).toHaveBeenCalledWith('DiProva Bambino: scheda eliminata definitivamente.'))
        expect(onChiudi).toHaveBeenCalledTimes(1)
        expect(corpoDi(1)).toEqual({ alunno_id: AL.id, mode: 'execute', scelta: 'elimina' })
    })

    it('dice PRIMA gli effetti che non si vedono: articoli del blog nascosti e ricevute già emesse', async () => {
        fetchMock.mockResolvedValueOnce(
            anteprima(SOLO_ANONIMIZZA, 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI', {
                presenze: 0, legami_genitori: 0, articoli_pubblici: 2, pagamenti: 0, pagamenti_bloccati: 3,
            }),
        )
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={vi.fn()} />)
        expect(await screen.findByText('2 articoli del blog che lo ritraggono verranno nascosti dal sito')).toBeInTheDocument()
        // Ricevute senza un pagamento a cui appendersi: non sono «niente».
        expect(screen.getByText('3 ricevute già emesse')).toBeInTheDocument()
        expect(screen.queryByText(itAdminStudents.elmNiente)).toBeNull()
    })
})

describe('EliminaDefinitivoDialog — solo le scelte che il server offre', () => {
    it('con pagamenti bloccati: «Cancella anche i pagamenti» è spento (e lo SEMBRA) col motivo, «Anonimizza» è attivo', async () => {
        fetchMock
            .mockResolvedValueOnce(
                anteprima(SOLO_ANONIMIZZA, 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI', { pagamenti: 2, pagamenti_bloccati: 1 }),
            )
            .mockResolvedValueOnce(RIUSCITA)
        const onEliminato = vi.fn()
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={onEliminato} />)

        const cancella = await screen.findByRole('button', { name: /Cancella anche i pagamenti/ })
        expect(cancella).toHaveAttribute('aria-disabled', 'true')
        // Il motivo è legato al comando, non solo vicino: lo screen reader lo legge sul bottone.
        expect(cancella).toHaveAccessibleDescription(/non si possono cancellare/)
        // `btnClass` stila `disabled`, non `aria-disabled`: senza queste classi sembrerebbe acceso.
        expect(cancella.className).toContain('aria-disabled:bg-kidville-neutral-soft')
        expect(cancella.className).toContain('aria-disabled:text-kidville-sub')
        expect(screen.getByText('2 pagamenti')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Elimina definitivamente' })).toBeNull()
        const anonimizza = screen.getByRole('button', { name: /Anonimizza e tieni la contabilità/ })
        expect(anonimizza).not.toHaveAttribute('aria-disabled', 'true')

        // `aria-disabled` NON ferma il click da solo: deve fermarlo la finestra.
        fireEvent.click(cancella)
        expect(fetchMock).toHaveBeenCalledTimes(1)

        fireEvent.click(anonimizza)
        await waitFor(() => expect(onEliminato).toHaveBeenCalledWith('DiProva Bambino: dati personali anonimizzati, contabilità conservata.'))
        expect(corpoDi(1)).toEqual({ alunno_id: AL.id, mode: 'execute', scelta: 'anonimizza' })
    })

    it('con pagamenti CANCELLABILI: «Cancella anche i pagamenti» è attivo e manda la sua scelta', async () => {
        fetchMock
            .mockResolvedValueOnce(anteprima(CON_PAGAMENTI, 'ALUNNO_ELIMINAZIONE_HA_PAGAMENTI', { pagamenti: 2 }))
            .mockResolvedValueOnce(RIUSCITA)
        const onEliminato = vi.fn()
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={onEliminato} />)

        const cancella = await screen.findByRole('button', { name: 'Cancella anche i pagamenti' })
        expect(cancella).not.toHaveAttribute('aria-disabled', 'true')
        expect(cancella).not.toHaveAttribute('aria-describedby')
        expect(cancella.className).not.toContain('aria-disabled:bg-kidville-neutral-soft')
        expect(screen.getByRole('button', { name: /Anonimizza e tieni la contabilità/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Elimina definitivamente' })).toBeNull()

        fireEvent.click(cancella)
        await waitFor(() => expect(onEliminato).toHaveBeenCalledWith(expect.stringContaining('eliminata definitivamente')))
        expect(corpoDi(1)).toEqual({ alunno_id: AL.id, mode: 'execute', scelta: 'elimina_con_pagamenti' })
    })

    it('con foto che non si possono togliere: nessuna eliminazione, si dice perché e si chiude', async () => {
        fetchMock.mockResolvedValueOnce(
            anteprima(NESSUNA, 'ALUNNO_ELIMINAZIONE_FOTO_NON_RIMOVIBILI', { foto_non_rimovibili: 2 }),
        )
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={vi.fn()} />)
        expect(
            await screen.findByText(/2 foto di questo bambino non si riescono a togliere dall’archivio/),
        ).toBeInTheDocument()
        // Nessuno sblocco promesso: toglierle dalla galleria le manda nel cestino, che si conta lo stesso.
        expect(screen.getByText(/ripetere l’operazione non le toglierà: il caso va segnalato all’assistenza/)).toBeInTheDocument()
        expect(screen.queryByText(/galleria/)).toBeNull()
        expect(screen.queryByRole('button', { name: /Elimina definitivamente|Cancella|Anonimizza/ })).toBeNull()
        expect(screen.getByRole('button', { name: 'Chiudi' })).toBeInTheDocument()
        expect(screen.queryByText(itAdminStudents.elmIrreversibile)).toBeNull()
    })

    it('con foto che non si possono togliere e pagamenti cancellabili: resta solo «Anonimizza»', async () => {
        fetchMock.mockResolvedValueOnce(
            anteprima(SOLO_ANONIMIZZA, 'ALUNNO_ELIMINAZIONE_FOTO_NON_RIMOVIBILI', { pagamenti: 1, foto_non_rimovibili: 1 }),
        )
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={vi.fn()} />)
        expect(await screen.findByText(/1 foto di questo bambino non si riesce a togliere/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Anonimizza e tieni la contabilità/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Elimina definitivamente|Cancella/ })).toBeNull()
        // Anonimizzare toglie le foto che SI POSSONO togliere: non promette quella che resta.
        expect(screen.getByText(/e le sue foto che si possono togliere/)).toBeInTheDocument()
    })

    it('con pagamenti bloccati E foto che non si possono togliere: si dicono tutte e due le cose', async () => {
        // Il motivo è uno solo (i pagamenti), ma le foto restano lo stesso e
        // l'anonimizzazione non le toglierà: tacerle sarebbe una promessa a vuoto.
        fetchMock.mockResolvedValueOnce(
            anteprima(SOLO_ANONIMIZZA, 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI', {
                pagamenti: 2, pagamenti_bloccati: 1, foto_non_rimovibili: 3,
            }),
        )
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={vi.fn()} />)
        const cancella = await screen.findByRole('button', { name: /Cancella anche i pagamenti/ })
        expect(screen.getByText(itAdminStudents.elmBloccoPagamenti)).toBeInTheDocument()
        expect(screen.getByText(/3 foto di questo bambino non si riescono a togliere dall’archivio/)).toBeInTheDocument()
        // Il comando spento è descritto da ENTRAMBI i motivi.
        expect(cancella).toHaveAccessibleDescription(/non si possono cancellare.*3 foto di questo bambino/)
        expect(screen.getByRole('button', { name: /Anonimizza e tieni la contabilità/ })).not.toHaveAttribute('aria-disabled', 'true')
    })

    it('con il registro della primaria: nessun comando distruttivo, solo «Chiudi»', async () => {
        fetchMock.mockResolvedValueOnce(anteprima(NESSUNA, 'REGISTRO_PRIMARIA_DA_CONSERVARE', { registro_primaria: true }))
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={vi.fn()} />)
        expect(await screen.findByText(/il registro va conservato per legge/)).toBeInTheDocument()
        expect(screen.getByText(/La scheda resta fra i non iscritti/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Elimina definitivamente|Cancella|Anonimizza/ })).toBeNull()
        expect(screen.getByRole('button', { name: 'Chiudi' })).toBeInTheDocument()
    })
})

describe('EliminaDefinitivoDialog — quando qualcosa va storto', () => {
    it('anteprima fallita: messaggio, «Riprova», nessun comando distruttivo', async () => {
        fetchMock
            .mockResolvedValueOnce(risposta({ codice: 'ALUNNO_ELIMINAZIONE_NON_MISURATA' }, false, 500))
            .mockResolvedValueOnce(anteprima(SOLO_ELIMINA, null))
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

    it('esecuzione rifiutata: la finestra resta aperta col messaggio del server, e i numeri si rileggono', async () => {
        fetchMock
            .mockResolvedValueOnce(anteprima(SOLO_ELIMINA, null))
            .mockResolvedValueOnce(risposta({ codice: 'ALUNNO_ELIMINAZIONE_FILE_RESTANTI' }, false, 502))
            .mockResolvedValueOnce(anteprima(SOLO_ELIMINA, null, { presenze: 4 }))
        const onEliminato = vi.fn()
        const onChiudi = vi.fn()
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={onChiudi} onEliminato={onEliminato} />)
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina definitivamente' }))

        const avviso = await screen.findByRole('alert')
        expect(avviso).toHaveTextContent(/non sono usciti/)
        // I comandi spariscono durante la rimisura: il fuoco va sul messaggio, non su <body>.
        expect(avviso).toHaveFocus()
        // La rimisura: i numeri NUOVI, e il messaggio è ancora lì.
        expect(await screen.findByText('4 presenze')).toBeInTheDocument()
        expect(corpoDi(2)).toEqual({ alunno_id: AL.id, mode: 'dryrun' })
        expect(screen.getByRole('alert')).toHaveTextContent(/non sono usciti/)
        // Il corpo non porta `effetti`: niente riga «erano già stati tolti».
        expect(screen.queryByText(itAdminStudents.elmEffettiGiaAvvenuti)).toBeNull()
        expect(screen.getByRole('button', { name: 'Elimina definitivamente' })).not.toHaveAttribute('aria-disabled', 'true')
        expect(onEliminato).not.toHaveBeenCalled()
        expect(onChiudi).not.toHaveBeenCalled()
        expect(logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', stato: 502 }))
    })

    it('rete giù durante l’esecuzione: messaggio, finestra aperta, il motivo nei log', async () => {
        fetchMock
            .mockResolvedValueOnce(anteprima(SOLO_ELIMINA, null))
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValueOnce(anteprima(SOLO_ELIMINA, null))
        const onEliminato = vi.fn()
        const onChiudi = vi.fn()
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={onChiudi} onEliminato={onEliminato} />)
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina definitivamente' }))

        expect(await screen.findByRole('alert')).toHaveTextContent(itAdminStudents.elmErrore)
        expect(await screen.findByRole('button', { name: 'Elimina definitivamente' })).toBeInTheDocument()
        expect(onEliminato).not.toHaveBeenCalled()
        expect(onChiudi).not.toHaveBeenCalled()
        expect(logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', messaggio: expect.stringContaining('elimina-esecuzione-non-arrivata') }),
        )
        expect(logClient).not.toHaveBeenCalledWith(
            expect.objectContaining({ messaggio: expect.stringContaining('elimina-anteprima-non-arrivata') }),
        )
    })

    it('rete giù durante l’anteprima: non si offre niente, e il log dice che si stava solo contando', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={vi.fn()} />)
        expect(await screen.findByRole('alert')).toHaveTextContent(itAdminStudents.elmMisuraFallita)
        expect(screen.getByRole('button', { name: 'Riprova' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Elimina definitivamente' })).toBeNull()
        expect(logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', messaggio: expect.stringContaining('elimina-anteprima-non-arrivata') }),
        )
        expect(logClient).not.toHaveBeenCalledWith(
            expect.objectContaining({ messaggio: expect.stringContaining('elimina-esecuzione-non-arrivata') }),
        )
    })
})

describe('EliminaDefinitivoDialog — l’esito detto com’è', () => {
    const conAnonimizza = () => anteprima(CON_PAGAMENTI, 'ALUNNO_ELIMINAZIONE_HA_PAGAMENTI', { pagamenti: 1 })

    it('anonimizzazione PARZIALE: non si dice «anonimizzati», si dice parziale', async () => {
        fetchMock
            .mockResolvedValueOnce(conAnonimizza())
            .mockResolvedValueOnce(risposta({ ok: true, scelta: 'anonimizza', parziale: true, chiavi_condivise_escluse: 0 }))
        const onEliminato = vi.fn()
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={onEliminato} />)
        fireEvent.click(await screen.findByRole('button', { name: /Anonimizza e tieni la contabilità/ }))
        await waitFor(() => expect(onEliminato).toHaveBeenCalledTimes(1))
        const frase = onEliminato.mock.calls[0][0] as string
        expect(frase).toBe(
            'DiProva Bambino: anonimizzazione PARZIALE — alcuni file o archivi non sono stati trattati. Riprova, e se resta parziale segnala all’assistenza.',
        )
        expect(frase).not.toContain('anonimizzati')
    })

    it('anonimizzazione parziale per una chiave condivisa con un doppione: lo dice, e dice di risolverlo prima', async () => {
        fetchMock
            .mockResolvedValueOnce(conAnonimizza())
            .mockResolvedValueOnce(risposta({ ok: true, scelta: 'anonimizza', parziale: true, chiavi_condivise_escluse: 1 }))
        const onEliminato = vi.fn()
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={onEliminato} />)
        fireEvent.click(await screen.findByRole('button', { name: /Anonimizza e tieni la contabilità/ }))
        await waitFor(() => expect(onEliminato).toHaveBeenCalledTimes(1))
        const frase = onEliminato.mock.calls[0][0] as string
        expect(frase).toContain('anonimizzazione PARZIALE')
        expect(frase).toContain(itAdminStudents.elmParzialeChiaveCondivisa)
    })

    it('eliminazione con esito INCERTO: «risulta eliminata, ma non confermato»', async () => {
        fetchMock
            .mockResolvedValueOnce(anteprima(SOLO_ELIMINA, null))
            .mockResolvedValueOnce(risposta({ ok: true, scelta: 'elimina', incerto: true }))
        const onEliminato = vi.fn()
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={onEliminato} />)
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina definitivamente' }))
        await waitFor(() =>
            expect(onEliminato).toHaveBeenCalledWith('DiProva Bambino: la scheda risulta eliminata, ma l’esito non è stato confermato.'),
        )
    })

    it('200 con un corpo illeggibile: frase standard (il lavoro è fatto) e una riga nei log', async () => {
        fetchMock
            .mockResolvedValueOnce(anteprima(SOLO_ELIMINA, null))
            .mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input') } })
        const onEliminato = vi.fn()
        const onChiudi = vi.fn()
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={onChiudi} onEliminato={onEliminato} />)
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina definitivamente' }))
        await waitFor(() => expect(onEliminato).toHaveBeenCalledWith('DiProva Bambino: scheda eliminata definitivamente.'))
        expect(onChiudi).toHaveBeenCalledTimes(1)
        expect(logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'warn', messaggio: expect.stringContaining('elimina-esito-illeggibile') }),
        )
    })

    it('rifiuto DOPO gli effetti: sotto il messaggio, che foto, documenti e notifiche erano già usciti', async () => {
        fetchMock
            .mockResolvedValueOnce(anteprima(SOLO_ELIMINA, null))
            .mockResolvedValueOnce(
                risposta(
                    {
                        codice: 'ALUNNO_ELIMINAZIONE_FREQUENTANTE',
                        effetti: { tracce: { notifiche: 2, segnalazioni: 0, sospensioni: 0 }, file: { foto_rimosse: 1, restanti: 0 } },
                    },
                    false,
                    409,
                ),
            )
            .mockResolvedValueOnce(anteprima(SOLO_ELIMINA, null))
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={vi.fn()} />)
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina definitivamente' }))
        const avviso = await screen.findByRole('alert')
        expect(avviso).toHaveTextContent(itShared.erroreAlunnoEliminazioneFrequentante)
        expect(avviso).toHaveTextContent(itAdminStudents.elmEffettiGiaAvvenuti)
        await screen.findByRole('button', { name: 'Elimina definitivamente' })
    })

    it('effetti tutti a zero, o solo file RIMASTI: la riga non compare (non è uscito niente)', async () => {
        fetchMock
            .mockResolvedValueOnce(anteprima(SOLO_ELIMINA, null))
            .mockResolvedValueOnce(
                risposta(
                    {
                        codice: 'ALUNNO_ELIMINAZIONE_FILE_RESTANTI',
                        effetti: { tracce: { notifiche: 0, segnalazioni: 0, sospensioni: 0 }, file: { foto_rimosse: 0, restanti: 3, news_trattenuti: 1 } },
                    },
                    false,
                    502,
                ),
            )
            .mockResolvedValueOnce(anteprima(SOLO_ELIMINA, null))
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={vi.fn()} />)
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina definitivamente' }))
        expect(await screen.findByRole('alert')).toHaveTextContent(/non sono usciti/)
        await screen.findByRole('button', { name: 'Elimina definitivamente' })
        expect(screen.queryByText(itAdminStudents.elmEffettiGiaAvvenuti)).toBeNull()
    })
})

describe('EliminaDefinitivoDialog — l’avviso doppione', () => {
    it('stesso codice fiscale di un bambino che frequenta: avviso in evidenza, e i comandi restano', async () => {
        fetchMock.mockResolvedValueOnce(anteprima(SOLO_ELIMINA, null, { cf_condiviso_con_frequentante: true, presenze: 3 }))
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={vi.fn()} />)
        expect(await screen.findByText(itAdminStudents.elmAvvisoDoppione)).toBeInTheDocument()
        // Non blocca: è un avviso, non un divieto.
        expect(screen.getByRole('button', { name: 'Elimina definitivamente' })).not.toHaveAttribute('aria-disabled', 'true')
        expect(screen.getByText('3 presenze')).toBeInTheDocument()
    })
})

describe('EliminaDefinitivoDialog — l’esecuzione in volo', () => {
    it('doppio click nello stesso istante sul comando distruttivo: UNA sola POST', async () => {
        fetchMock.mockResolvedValueOnce(anteprima(SOLO_ELIMINA, null)).mockResolvedValueOnce(RIUSCITA)
        const onEliminato = vi.fn()
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={onEliminato} />)
        const elimina = await screen.findByRole('button', { name: 'Elimina definitivamente' })

        // Due click nello STESSO tick, senza un render in mezzo: li ferma solo la guardia sincrona.
        act(() => {
            elimina.click()
            elimina.click()
        })
        await waitFor(() => expect(onEliminato).toHaveBeenCalledTimes(1))
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('mentre esegue non si chiude (Annulla, Escape) e «Un momento…» sta sul bottone della scelta in corso', async () => {
        let risolvi: (v: unknown) => void = () => {}
        fetchMock
            .mockResolvedValueOnce(anteprima(CON_PAGAMENTI, 'ALUNNO_ELIMINAZIONE_HA_PAGAMENTI', { pagamenti: 1 }))
            .mockReturnValueOnce(new Promise((r) => { risolvi = r }))
        const onChiudi = vi.fn()
        const onEliminato = vi.fn()
        render(<EliminaDefinitivoDialog alunno={AL} onChiudi={onChiudi} onEliminato={onEliminato} />)

        fireEvent.click(await screen.findByRole('button', { name: /Anonimizza e tieni la contabilità/ }))
        // Il bottone della scelta in volo dice «Un momento…»; l'altro resta com'era, spento.
        expect(screen.getByRole('button', { name: 'Un momento…' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Anonimizza/ })).toBeNull()
        expect(screen.getByRole('button', { name: 'Cancella anche i pagamenti' })).toHaveAttribute('aria-disabled', 'true')

        const annulla = screen.getByRole('button', { name: 'Annulla' })
        expect(annulla).toHaveAttribute('aria-disabled', 'true')
        fireEvent.click(annulla)
        fireEvent.keyDown(document, { key: 'Escape' })
        expect(onChiudi).not.toHaveBeenCalled()

        await act(async () => {
            risolvi(RIUSCITA)
        })
        await waitFor(() => expect(onEliminato).toHaveBeenCalledTimes(1))
        expect(onChiudi).toHaveBeenCalledTimes(1)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })
})
