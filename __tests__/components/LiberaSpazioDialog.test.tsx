import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

import itAdminStudents from '../../messages/it/adminStudents.json'
import itShared from '../../messages/it/shared.json'

/**
 * «LIBERA SPAZIO» — la conferma in due passi, l'unica operazione del modello che
 * non ha un annulla.
 *
 * ─── PERCHÉ QUESTO FILE È NATO IL 2026-08-13 E NON IL 12 ─────────────────────
 *
 * La rotta, il motore, il dry-run e 49 test esistevano già. **Non li chiamava
 * nessuno**: `grep -rn "libera-spazio" src/` non trovava una sola `fetch`, il
 * bottone dell'elenco «non più iscritti» faceva `router.push` verso una scheda
 * dove non c'era niente, e la riga in cima alla linguetta prometteva
 * all'operatore che foto, video e messaggi se ne andavano. Il collaudo l'ha
 * chiamata col suo nome: «il secondo tempo del modello non esiste come prodotto».
 *
 * Questi test provano il pezzo che mancava, e lo provano sulla CHIAMATA e sul
 * TESTO A SCHERMO — cioè sulle due sole cose che dicono se il comando fa davvero
 * qualcosa: quale POST parte, con quale `mode`, e che cosa legge chi decide.
 *
 * ─── PERCHÉ next-intl È FINTO CON IL FORMATTATORE VERO ───────────────────────
 * Il mock globale (`test/setup.ts`) restituisce la stringa GREZZA: i conteggi
 * («{n, plural, one {# foto solo sua} …}») resterebbero segnaposti, e i casi che
 * verificano che l'operatore LEGGA quanti file stanno per sparire sarebbero verdi
 * su un testo che non nomina nessun numero. Qui si usa l'ICU vero (`use-intl`).
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

import { LiberaSpazioDialog } from '@/components/features/admin/LiberaSpazioDialog'

/* ── Il bambino di prova. Nome finto: il repository è PUBBLICO. ─────────────── */
const ANNA = { id: 'aaaa1111-0000-4000-8000-000000000001', nome: 'Anna', cognome: 'Bianchi' }

/** La risposta del dry-run, nella forma che la rotta serializza. */
const DRY_RUN = {
    dryrun: true,
    foto_sole_sue: 2,
    video_soli_suoi: 1,
    media_di_gruppo: 3,
    messaggi: 5,
    allegati: 1,
    thread: 1,
    articoli_pubblici: 0,
    spazio_liberato_il: null,
    nominativo_conferma: 'BIANCHI ANNA',
    non_tocca: { tabelle: ['pagamenti', 'presenze'], bucket: ['fatture'] },
}

/** L'esito di un'esecuzione riuscita per intero. */
const ESITO_PIENO = {
    ok: true,
    foto_rimosse: 3,
    foto_sganciate: 3,
    file_rimossi: 1,
    n_file_non_rimossi: 0,
    messaggi_cancellati: 5,
    messaggi_trattenuti: 0,
    articoli_ritirati: 0,
    parziale: false,
    spazio_liberato_il: '2026-08-13T09:00:00.000Z',
}

const fetchMock = vi.fn()
const onChiudi = vi.fn()
const onLiberato = vi.fn()

/** Risposta a corpo pieno, con lo status che si vuole. */
const risposta = (corpo: unknown, ok = true, status = 200) => ({
    ok,
    status,
    headers: new Headers(),
    json: async () => corpo,
})

/** Apre il dialogo e aspetta che il conteggio sia arrivato. */
async function apri() {
    render(<LiberaSpazioDialog alunno={ANNA} onChiudi={onChiudi} onLiberato={onLiberato} />)
    await screen.findByRole('dialog')
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
}

/** Il corpo JSON della n-esima POST. */
const corpoDi = (n: number) =>
    JSON.parse((fetchMock.mock.calls[n] as [string, { body: string }])[1].body) as Record<string, unknown>

beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockResolvedValue(risposta(DRY_RUN))
    vi.stubGlobal('fetch', fetchMock)
})

describe('LiberaSpazioDialog — si conta PRIMA di offrire', () => {
    it('all’apertura parte il dry-run, e nient’altro', async () => {
        await apri()
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, opzioni] = fetchMock.mock.calls[0] as [string, { method: string }]
        expect(url).toBe('/api/admin/students/libera-spazio')
        expect(opzioni.method).toBe('POST')
        expect(corpoDi(0)).toEqual({ alunno_id: ANNA.id, mode: 'dryrun' })
    })

    it('mostra QUANTO sparisce, con i numeri veri e le forme al plurale giuste', async () => {
        await apri()
        // Il singolare e il plurale nella stessa schermata: `1 video solo suo` e
        // `2 foto solo sue`. Col mock globale di next-intl resterebbero segnaposti.
        expect(await screen.findByText('2 foto solo sue')).toBeInTheDocument()
        expect(screen.getByText('1 video solo suo')).toBeInTheDocument()
        expect(screen.getByText('5 messaggi di chat, testo compreso')).toBeInTheDocument()
        expect(screen.getByText('1 allegato di chat')).toBeInTheDocument()
    })

    it('le voci a ZERO non si stampano: un elenco di «0 articoli» è rumore su una decisione', async () => {
        await apri()
        await screen.findByText('2 foto solo sue')
        expect(screen.queryByText(/articol/i)).toBeNull()
    })

    it('il contrappeso c’è sempre: che cosa RESTA, accanto a che cosa se ne va', async () => {
        // Un elenco di distruzioni senza il suo contrappeso è metà informazione, e
        // su quella metà l'operatore decide.
        await apri()
        expect(await screen.findByText(itAdminStudents.spzRestaTitolo)).toBeInTheDocument()
        expect(screen.getByText(itAdminStudents.spzRestaTesto)).toBeInTheDocument()
        expect(screen.getByText(itAdminStudents.spzAvvisoIrreversibile)).toBeInTheDocument()
    })

    it('⚠️ un conteggio NON arrivato non diventa «niente da togliere»: il comando non si offre', async () => {
        // È il caso che decide l'onestà di tutto il riquadro. «0 foto» al posto di
        // «non ho potuto guardare» farebbe approvare un numero che nessuno ha
        // misurato — e a valle c'è una cancellazione senza annulla.
        fetchMock.mockResolvedValue(risposta({ error: 'x', codice: 'SPAZIO_NON_LIBERATO' }, false, 500))
        await apri()

        expect(await screen.findByRole('alert')).toHaveTextContent(itShared.erroreSpazioNonLiberato)
        expect(screen.queryByRole('button', { name: itAdminStudents.spzEsegui })).toBeNull()
        expect(screen.queryByText(itAdminStudents.spzNienteDaTogliere)).toBeNull()
        expect(logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', stato: 500 }))
    })

    it('sul DB non migrato arriva il 503 col SUO testo: «applica la migrazione», non «riprova»', async () => {
        // I due gemelli (`archivia`, `riattiva`) rispondono `ARCHIVIO_NON_DISPONIBILE`
        // e il 2026-08-13 anche questa rotta lo fa. Se il riquadro lo appiattisse
        // sul messaggio generico, all'operatore resterebbe «riprova fra qualche
        // minuto» su un ambiente in cui riprovare non serve a niente.
        fetchMock.mockResolvedValue(risposta({ error: 'x', codice: 'ARCHIVIO_NON_DISPONIBILE' }, false, 503))
        await apri()
        expect(await screen.findByRole('alert')).toHaveTextContent(itShared.erroreArchivioNonDisponibile)
    })

    it('la rete giù non diventa un elenco vuoto, e lascia una riga di log', async () => {
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
        await apri()
        expect(await screen.findByRole('alert')).toHaveTextContent(itAdminStudents.spzErroreConteggio)
        expect(screen.queryByRole('button', { name: itAdminStudents.spzEsegui })).toBeNull()
        expect(logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', route: '/admin/students' }),
        )
    })

    it('un 200 senza `nominativo_conferma` è un GUASTO: senza, la conferma sarebbe da ricopiare alla cieca', async () => {
        fetchMock.mockResolvedValue(risposta({ ...DRY_RUN, nominativo_conferma: undefined }))
        await apri()
        expect(await screen.findByRole('alert')).toHaveTextContent(itAdminStudents.spzErroreConteggio)
        expect(screen.queryByRole('button', { name: itAdminStudents.spzEsegui })).toBeNull()
    })

    it('quando lo spazio era GIÀ stato liberato lo dice, invece di far ripetere il gesto alla cieca', async () => {
        fetchMock.mockResolvedValue(risposta({ ...DRY_RUN, spazio_liberato_il: '2026-08-05T09:00:00.000Z' }))
        await apri()
        expect(await screen.findByText(/05\/08\/2026/)).toBeInTheDocument()
    })
})

describe('LiberaSpazioDialog — la conferma si DIGITA', () => {
    const scrivi = (testo: string) =>
        fireEvent.change(screen.getByRole('textbox'), { target: { value: testo } })

    it('il nominativo da ricopiare è quello che dice il SERVER, non quello ricomposto qui', async () => {
        await apri()
        // `nomeConferma` è del server (`@/lib/gdpr/anonimizza`): il riquadro mostra
        // la sua stringa, così ciò che si legge e ciò che verrà confrontato sono la
        // stessa cosa anche il giorno in cui quella regola cambia.
        await screen.findByText('2 foto solo sue')
        expect(
            screen.getByText(itAdminStudents.spzConfermaEtichetta.replace('{nominativo}', 'BIANCHI ANNA')),
        ).toBeInTheDocument()
        // …e il nome sta anche in testata, perché è là che si guarda per sapere su
        // chi si sta decidendo mentre il conteggio è ancora in volo.
        expect(screen.getAllByText(/BIANCHI ANNA/)).toHaveLength(2)
    })

    it('esegue con `mode: execute` e il nominativo DIGITATO, non con quello mostrato', async () => {
        await apri()
        await screen.findByText('2 foto solo sue')
        fetchMock.mockResolvedValue(risposta(ESITO_PIENO))

        scrivi('bianchi anna')
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: itAdminStudents.spzEsegui }))
        })

        expect(corpoDi(1)).toEqual({ alunno_id: ANNA.id, mode: 'execute', confirm: 'bianchi anna' })
        expect(onLiberato).toHaveBeenCalledTimes(1)
    })

    it('⚠️ il verdetto sul nominativo è del SERVER: il rifiuto si vede e il riquadro non si chiude', async () => {
        // Il confronto NON si rifà nel client: sarebbe una seconda copia della
        // regola, libera di divergere — un bottone che si accende su un nome che il
        // server poi rifiuta, o che resta spento su uno che avrebbe accettato.
        await apri()
        await screen.findByText('2 foto solo sue')
        fetchMock.mockResolvedValue(risposta({ error: 'x', codice: 'SPAZIO_CONFERMA_NON_VALIDA' }, false, 400))

        scrivi('bianchi annna')
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: itAdminStudents.spzEsegui }))
        })

        expect(await screen.findByRole('alert')).toHaveTextContent(itShared.erroreSpazioConfermaNonValida)
        // Si resta sul passo della conferma, con quello che era già stato scritto.
        expect(screen.getByRole('textbox')).toHaveValue('bianchi annna')
        expect(screen.getByRole('button', { name: itAdminStudents.spzEsegui })).toBeInTheDocument()
        expect(onLiberato).not.toHaveBeenCalled()
    })

    it('a campo VUOTO il comando è marcato non azionabile, ma resta un tab stop', async () => {
        await apri()
        await screen.findByText('2 foto solo sue')
        const comando = screen.getByRole('button', { name: itAdminStudents.spzEsegui })
        // `aria-disabled` e non `disabled`: marcarlo spegnerebbe il fuoco, che in
        // Chrome torna su `<body>` — cioè fuori dal dialogo.
        expect(comando).toHaveAttribute('aria-disabled', 'true')
        expect(comando).not.toBeDisabled()

        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'BIANCHI ANNA' } })
        expect(screen.getByRole('button', { name: itAdminStudents.spzEsegui })).toHaveAttribute('aria-disabled', 'false')
    })

    it('due click nello stesso istante = UNA sola POST: da qui non si torna indietro', async () => {
        await apri()
        await screen.findByText('2 foto solo sue')
        fetchMock.mockResolvedValue(risposta(ESITO_PIENO))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'BIANCHI ANNA' } })

        const comando = screen.getByRole('button', { name: itAdminStudents.spzEsegui })
        await act(async () => {
            fireEvent.click(comando)
            fireEvent.click(comando)
        })

        // La prima è il dry-run: le POST di esecuzione devono essere una sola.
        const esecuzioni = fetchMock.mock.calls.filter(
            (c) => JSON.parse((c as [string, { body: string }])[1].body).mode === 'execute',
        )
        expect(esecuzioni).toHaveLength(1)
    })
})

describe('LiberaSpazioDialog — l’esito', () => {
    const eseguiCon = async (corpo: unknown) => {
        await apri()
        await screen.findByText('2 foto solo sue')
        fetchMock.mockResolvedValue(risposta(corpo))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'BIANCHI ANNA' } })
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: itAdminStudents.spzEsegui }))
        })
    }

    it('a lavoro fatto dice CHE COSA è stato tolto, coi conteggi del server', async () => {
        await eseguiCon(ESITO_PIENO)
        const esito = await screen.findByRole('status')
        expect(esito).toHaveTextContent(itAdminStudents.spzFattoTitolo)
        expect(esito).toHaveTextContent('3 file di galleria rimossi')
        expect(esito).toHaveTextContent('5 messaggi cancellati')
        // Il fuoco è lì sopra: il campo e il comando sono spariti da sotto le dita.
        expect(document.activeElement).toBe(esito)
    })

    it('⚠️ l’esito PARZIALE è un allarme, non un successo — e dice che si ripete', async () => {
        // `parziale: true` vuol dire che un file non è uscito dall'archivio: il
        // timestamp NON è stato scritto e la riga resta azionabile. Presentarlo
        // come «fatto» toglierebbe dagli occhi di tutti un bambino le cui foto
        // sono ancora là dentro.
        await eseguiCon({
            ...ESITO_PIENO,
            n_file_non_rimossi: 2,
            messaggi_cancellati: 4,
            messaggi_trattenuti: 1,
            parziale: true,
            spazio_liberato_il: null,
        })

        const esito = await screen.findByRole('alert')
        expect(esito).toHaveTextContent(itAdminStudents.spzParzialeTitolo)
        expect(esito).toHaveTextContent('2 file non sono usciti dall’archivio')
        expect(esito).toHaveTextContent('1 messaggio non è stato cancellato')
        expect(esito).toHaveTextContent(itAdminStudents.spzParzialeTesto)
        // ⟵ E il successo NON compare: due esiti diversi, due letture diverse.
        expect(screen.queryByText(itAdminStudents.spzFattoTitolo)).toBeNull()
        // L'elenco si rilegge lo stesso: la riga cambia, e chi guarda deve vederlo.
        expect(onLiberato).toHaveBeenCalledTimes(1)
    })

    it('un 200 con corpo illeggibile resta un successo: il lavoro sul server è già stato fatto', async () => {
        // Il verso giusto in cui sbagliare. Far ripremere il comando ripeterebbe una
        // distruzione già avvenuta; qui si dichiara fatto e si rilegge l'elenco.
        await apri()
        await screen.findByText('2 foto solo sue')
        fetchMock.mockResolvedValue({
            ok: true, status: 200, headers: new Headers(),
            json: async () => { throw new SyntaxError('Unexpected token') },
        })
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'BIANCHI ANNA' } })
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: itAdminStudents.spzEsegui }))
        })

        expect(await screen.findByRole('status')).toHaveTextContent(itAdminStudents.spzFattoTitolo)
        expect(onLiberato).toHaveBeenCalledTimes(1)
    })
})

describe('LiberaSpazioDialog — chiuso è chiuso', () => {
    it('senza alunno non rende niente e non chiama nessuno', () => {
        render(<LiberaSpazioDialog alunno={null} onChiudi={onChiudi} onLiberato={onLiberato} />)
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('«Annulla» chiude senza aver toccato niente', async () => {
        await apri()
        await screen.findByText('2 foto solo sue')
        fireEvent.click(screen.getByRole('button', { name: itAdminStudents.spzAnnulla }))
        expect(onChiudi).toHaveBeenCalledTimes(1)
        // Solo il dry-run: nessuna esecuzione è partita.
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(onLiberato).not.toHaveBeenCalled()
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// IL NUMERO SBAGLIATO ACCANTO AL NOME GIUSTO — il dialogo è montato UNA volta per
// la vista, quindi aprirlo su un altro bambino NON lo rimonta.
//
// Senza un azzeramento, il conteggio del bambino precedente resta a schermo
// mentre il nuovo è ancora in volo: due foto e cinque messaggi annunciati sopra
// la conferma di un'operazione che non ha un annulla, e riferiti a un altro
// bambino. Il nominativo da digitare verrebbe dalla stessa risposta vecchia.
//
// ⚠️ La proprietà è del COMPONENTE, non del punto di montaggio. Una `key` sul
// consumatore funzionava, ed è stata tolta: misurato il 2026-08-13, togliendola
// tutti i test restavano verdi — cioè la regola viveva fuori e nessuno la
// sorvegliava.
// ─────────────────────────────────────────────────────────────────────────────
describe('LiberaSpazioDialog — cambiando bambino non resta niente del precedente', () => {
    const LUCA = { id: 'bbbb2222-0000-4000-8000-000000000002', nome: 'Luca', cognome: 'Adami' }

    it('azzera conteggi e nominativo PRIMA che il nuovo conteggio arrivi', async () => {
        const { rerender } = render(
            <LiberaSpazioDialog alunno={ANNA} onChiudi={onChiudi} onLiberato={onLiberato} />,
        )
        await screen.findByRole('dialog')
        await waitFor(() => expect(screen.getByText(/2 foto solo sue/)).toBeInTheDocument())
        expect(screen.getByText('BIANCHI ANNA')).toBeInTheDocument()

        // Il conteggio del nuovo bambino non risponde: è la finestra in cui il
        // difetto si vedrebbe. `act` senza attese: si guarda ciò che è dipinto.
        fetchMock.mockReturnValue(new Promise(() => {}))
        await act(async () => {
            rerender(<LiberaSpazioDialog alunno={LUCA} onChiudi={onChiudi} onLiberato={onLiberato} />)
        })

        // Nessun numero di Anna, e il nome è quello di Luca — preso dalla riga,
        // non da `nominativo_conferma` della risposta vecchia.
        expect(screen.queryByText(/2 foto solo sue/)).toBeNull()
        expect(screen.queryByText(/5 messaggi di chat/)).toBeNull()
        expect(screen.queryByText('BIANCHI ANNA')).toBeNull()
        expect(screen.getByText('ADAMI LUCA')).toBeInTheDocument()
        // E si sta ricontando: il riquadro non offre niente finché non sa.
        expect(screen.getByText(itAdminStudents.spzConteggioInCorso)).toBeInTheDocument()
    })

    it('e butta via anche il nominativo già digitato', async () => {
        const { rerender } = render(
            <LiberaSpazioDialog alunno={ANNA} onChiudi={onChiudi} onLiberato={onLiberato} />,
        )
        await screen.findByRole('dialog')
        await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument())
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'BIANCHI ANNA' } })

        fetchMock.mockResolvedValue(risposta({ ...DRY_RUN, nominativo_conferma: 'ADAMI LUCA' }))
        await act(async () => {
            rerender(<LiberaSpazioDialog alunno={LUCA} onChiudi={onChiudi} onLiberato={onLiberato} />)
        })

        // Un nominativo che resta è il caso peggiore: il bottone sarebbe già
        // acceso sul bambino sbagliato, e basterebbe un click.
        expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// I DUE NUMERI CHE DICONO «RIPROVARE NON SERVE» — e che senza una riga a schermo
// manderebbero l'operatore a ripetere all'infinito un'operazione che non può
// riuscire.
// ─────────────────────────────────────────────────────────────────────────────
describe('LiberaSpazioDialog — quando riprovare non è il rimedio', () => {
    it('i media dall’indirizzo non riconoscibile si DICONO, prima della conferma', async () => {
        // `sorteDellaFoto` li chiama `trattenuta`: il bambino è l'unico taggato ma
        // il file non è mappabile in questo archivio, quindi non se ne va né il
        // file né la riga. Restando, tengono l'esito PARZIALE per sempre.
        fetchMock.mockResolvedValue(risposta({ ...DRY_RUN, media_non_rimovibili: 2 }))
        await apri()
        const avviso = await screen.findByText(/non sono riconoscibili in questo archivio/)
        expect(avviso).toBeInTheDocument()
        expect(avviso.textContent).toContain('Ripetere l’operazione non li toglierà')
    })

    it('e senza di quelli l’avviso NON compare (controllo positivo)', async () => {
        fetchMock.mockResolvedValue(risposta({ ...DRY_RUN, media_non_rimovibili: 0 }))
        await apri()
        await screen.findByRole('textbox')
        expect(screen.queryByText(/non è riconoscibile in questo archivio/)).toBeNull()
        expect(screen.queryByText(/non sono riconoscibili in questo archivio/)).toBeNull()
    })

    it('un archivio NON LETTO è distinto da un file rimasto dentro', async () => {
        // Sono due guasti con due rimedi: «il file non è uscito» si riprova, «non
        // ho potuto leggere l'archivio» vuol dire che qualcuno deve guardare i
        // permessi. Con la sola frase generica si leggerebbero uguali.
        await apri()
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'BIANCHI ANNA' } })
        fetchMock.mockResolvedValue(
            risposta({
                ...ESITO_PIENO,
                foto_rimosse: 0,
                messaggi_cancellati: 0,
                letture_fallite: 1,
                parziale: true,
                spazio_liberato_il: null,
            }),
        )
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: new RegExp(itAdminStudents.spzEsegui) }))
        })

        const esito = await screen.findByRole('alert')
        expect(esito.textContent).toContain(itAdminStudents.spzParzialeTitolo)
        expect(esito.textContent).toContain('archivio non si è potuto leggere')
    })
})
