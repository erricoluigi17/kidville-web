import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'

import itPrimaria from '../../messages/it/teacherPrimaria.json'
import itShared from '../../messages/it/shared.json'

/**
 * LOCK · nel registro della primaria si torna indietro con le date — e il giorno
 * su cui si apre è quello ITALIANO, scritto nell'URL.
 *
 * ─── I QUATTRO DIFETTI MISURATI (segnalazione del titolare, 2026-09-19) ──────
 *
 * «Non si riesce a tornare indietro con le date.» Nel codice non c'era nessun
 * divieto: mancava il comando. Appello, prospetto mensile, diario del genitore e
 * mensa hanno tutti le frecce `‹ ›`; il registro aveva un `DateField` nudo, cioè
 * un campo di TESTO mascherato. Da lì, quattro difetti distinti:
 *
 *  (1) nessuna freccia e nessun «Oggi»: per vedere ieri bisognava ridigitare
 *      tutte e otto le cifre della data;
 *  (2) banner rosso MENTRE si digita. `DateField` emette l'ISO vuoto a ogni
 *      battuta intermedia (`DateField.tsx:54-61`); quella stringa vuota finiva
 *      nella query (`?data=`), `zDataYMD` la respingeva con un 400 e il 400
 *      diventava `setErroreCaricamento` — un errore a video su una schermata
 *      dove chi scrive non ha ancora sbagliato niente;
 *  (3) `new Date().toISOString().slice(0, 10)` è UTC: fra mezzanotte e l'una
 *      (le due d'estate) italiane il registro apriva GIÀ SU IERI. È la stessa
 *      regressione misurata alle 01:2x dell'8 agosto sulla pagina gemella
 *      dell'appello e blindata da
 *      `__tests__/pages/teacher-appello-primaria-oggi.test.tsx`;
 *  (4) la data viveva solo in `useState`: un F5, o un giro su un'altra linguetta
 *      di `ClasseShell` e ritorno, riportava a oggi. Visto da fuori è proprio
 *      «la data non resta indietro», anche dopo averla cambiata.
 *
 * ⚠️ DEL DIFETTO (4) QUESTO FILE CONSEGNA UNA METÀ SOLA, e l'altra è CONSEGNATA
 * ALTROVE: qui si bloccano F5, pulsante «indietro/avanti» del browser e re-mount
 * (la data vive in `?data=`); il giro sulle altre linguette è lavoro di
 * `ClasseShell`, che dal 2026-09-19 rilegge `?data=` e lo riapplica agli href di
 * tutte le voci di `NAV` (`giornoDaUrl` e `conGiorno` in `ClasseShell.tsx`,
 * citati per NOME: i numeri di riga sono già invecchiati una volta). Non è più un buco
 * aperto — qui stava scritto che lo era — ma nessun caso qui sotto lo copre: il
 * lock di quella metà è `__tests__/ui/classe-shell-data.test.tsx`, e chi cambia
 * l'una senza l'altra rompe solo metà della catena.
 *
 * ─── DUE DIFETTI TROVATI DAL CRITICO SULLA CORREZIONE STESSA (2026-09-19) ────
 *  (5) LA CORSA fra due cambi di giorno ravvicinati. `load` non aveva token di
 *      annullamento: con la risposta del penultimo giorno in ritardo su quella
 *      dell'ultimo, il campo mostrava il 16 e la griglia gli argomenti del 17 —
 *      e la modale «Firma» salva sul giorno del CAMPO. La corsa c'era anche
 *      prima, ma costava otto cifre da ridigitare: le frecce l'hanno resa
 *      raggiungibile con due click.
 *  (6) `dataDaUrl` accettava la sola FORMA mentre la guardia sulla fetch
 *      pretendeva forma E calendario: `?data=2026-02-30` apriva un vicolo cieco
 *      con entrambe le frecce spente e la frase «Nessun'ora prevista» su un
 *      giorno che non esiste. Il caso GUARDIA che stava qui lo certificava come
 *      voluto.
 *
 * ⚠️ Questo file è stato verificato rompendo il codice di proposito, una famiglia
 * alla volta (fuso, guardia sulla fetch, lettura dall'URL, navigatore rimosso,
 * token della corsa, fedeltà della rete finta): ogni rottura lascia rosso almeno
 * un caso qui sotto.
 */

const SEZIONE = 'sez-1'
const DOCENTE = 'd-1'
const PERCORSO = '/teacher/primaria/sez-1/registro'

/** Mezzogiorno a Roma del 18/09/2026: «oggi» vale 2026-09-18 in ogni fuso di macchina. */
const MEZZOGIORNO_18 = '2026-09-18T10:00:00Z'
/** 00:30 a Roma del 19/09/2026 (22:30Z del 18): per UTC è ancora il 18. */
const NOTTE_19 = '2026-09-18T22:30:00Z'

const stub = vi.hoisted(() => ({
    params: { sectionId: 'sez-1' } as Record<string, string>,
    search: new URLSearchParams(`userId=${'d-1'}`),
    replace: vi.fn(),
    push: vi.fn(),
}))

vi.mock('next/navigation', () => ({
    useParams: () => stub.params,
    useSearchParams: () => stub.search,
    usePathname: () => PERCORSO,
    useRouter: () => ({ push: stub.push, replace: stub.replace, refresh: () => {} }),
}))

// Il motore offline tocca Dexie/IndexedDB: qui basta che non parta.
vi.mock('@/lib/offline/syncEngine', () => ({
    saveLocalRegistro: vi.fn(async () => {}),
    syncPendingRegistro: vi.fn(async () => {}),
}))

vi.mock('@/lib/logging/client', () => ({
    logClient: vi.fn(),
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

const chiamate: string[] = []

/**
 * Lo STESSO giro di `dataCalendarioValida` (`src/lib/validation/common.ts:20-23`),
 * copiato a mano perché la rete finta deve rispondere 400 dove risponde 400 il
 * server vero.
 *
 * ⚠️ Qui c'era `Number.isNaN(Date.parse(\`${data}T12:00:00Z\`))`, e **non è la
 * stessa domanda**: in V8 `Date.parse('2026-02-30T12:00:00Z')` non è `NaN`, vale
 * `2026-03-02T12:00:00Z` (misurato il 2026-09-19; idem `2026-02-29`, che nel 2026
 * non esiste). Il finto rispondeva **200** proprio sui casi per cui era stato
 * scritto, sotto un commento che dichiarava il contrario — e l'asserzione «nessun
 * banner rosso» degli altri casi era vacua. Il round-trip su `Date.UTC` smaschera
 * la normalizzazione silenziosa; `Date.parse` no. Lock del finto: il caso
 * «LA RETE FINTA È FEDELE A `zDataYMD`» qui sotto.
 */
const dataEsistente = (s: string): boolean => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
    const [y, m, g] = s.split('-').map(Number)
    const dt = new Date(Date.UTC(y, m - 1, g))
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === g
}

/**
 * Ritardi in ms da applicare alle risposte del registro, uno per chiamata e in
 * ordine di PARTENZA. Serve al caso della corsa: è l'unico modo di far arrivare
 * una risposta vecchia dopo una nuova. Vuoto = nessun ritardo.
 */
const ritardiRegistro: number[] = []

/**
 * Le date su cui `/api/primaria/registro` risponde **500**.
 *
 * È un guasto, e va tenuto DISTINTO dal 400 di `dataEsistente`: quello dice «la
 * data non è una data» e nasce da chi scrive, questo dice «il server non ce l'ha
 * fatta» su un giorno perfettamente valido — rete di scuola, WebView in
 * background, un 403 sul plesso sbagliato. È il secondo, non il primo, a lasciare
 * a video la griglia del giorno precedente sotto un campo già cambiato.
 */
const guastiRegistro = new Set<string>()

/** Il `registroId` di ogni POST a `/api/primaria/allegati`, in ordine. */
const allegatiInviati: string[] = []

/**
 * Quando è acceso, la giornata finta porta UN'ora di lezione il cui argomento
 * CONTIENE la data chiesta (`ARG 2026-09-17`). È l'unico modo di leggere a video
 * quale risposta ha vinto la corsa: con la giornata vuota le due risposte sono
 * indistinguibili, e un finto piatto è verde con e senza la correzione.
 */
let giornataConArgomento = false

const giornataFinta = (data: string) =>
    giornataConArgomento
        ? {
              campanelle: [{ id: 'c1', ordine: 1, ora_inizio: '08:30:00', ora_fine: '09:30:00', tipo: 'lezione' }],
              orarioCelle: [],
              righe: [
                  {
                      id: `r-${data}`,
                      ora_lezione: 1,
                      materia: null,
                      materia_id: null,
                      argomento: `ARG ${data}`,
                      compiti: null,
                      data_consegna_compiti: null,
                  },
              ],
          }
        : { campanelle: [], orarioCelle: [], righe: [] }

/**
 * La rete finta NON è piatta, ed è il punto: `/api/primaria/registro` risponde
 * **400** esattamente quando risponderebbe il server vero — `zDataYMD` è
 * obbligatorio e pretende una data esistente nel calendario. Con un finto che
 * dice sempre `success: true` il difetto (2) sarebbe invisibile: il banner rosso
 * nasce proprio da quel 400. Che la frase qui sopra sia VERA lo verifica un caso
 * apposta, non questo commento: vedi `dataEsistente`.
 */
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    chiamate.push(url)

    if (url.includes('/api/primaria/allegati')) {
        const corpo = init?.body as FormData | undefined
        allegatiInviati.push(String(corpo?.get('registroId') ?? ''))
        return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) } as unknown as Response
    }

    if (url.includes('/api/primaria/registro')) {
        const data = new URL(url, 'http://localhost').searchParams.get('data') ?? ''
        if (!dataEsistente(data)) {
            return {
                ok: false,
                status: 400,
                json: async () => ({ success: false, error: 'Data non valida (atteso YYYY-MM-DD)' }),
            } as unknown as Response
        }
        const ritardo = ritardiRegistro.shift() ?? 0
        if (ritardo > 0) await new Promise((ok) => setTimeout(ok, ritardo))
        // Dopo il ritardo, così un guasto resta componibile con la corsa e non
        // sfasa la coda dei ritardi, che è in ordine di PARTENZA.
        if (guastiRegistro.has(data)) {
            return {
                ok: false,
                status: 500,
                json: async () => ({ success: false, error: 'Errore interno' }),
            } as unknown as Response
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, data: giornataFinta(data) }),
        } as unknown as Response
    }

    if (url.includes('/api/primaria/classe/')) {
        return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, data: { section: { id: SEZIONE }, materie: [], alunni: [] } }),
        } as unknown as Response
    }

    if (url.includes('/api/primaria/me')) {
        return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, data: { ruolo: 'educator' } }),
        } as unknown as Response
    }

    return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) } as unknown as Response
})

beforeEach(() => {
    vi.clearAllMocks()
    chiamate.length = 0
    ritardiRegistro.length = 0
    guastiRegistro.clear()
    allegatiInviati.length = 0
    giornataConArgomento = false
    stub.search = new URLSearchParams(`userId=${DOCENTE}`)
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(MEZZOGIORNO_18))
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

import RegistroPage from '@/app/(dashboard)/teacher/primaria/[sectionId]/registro/page'

/**
 * Il campo data è un `DateField` (`type="text"` mascherato gg/mm/aaaa) dentro il
 * navigatore. Si legge per RUOLO — `textbox` + nome accessibile — e non con
 * `getByLabelText`.
 *
 * ⚠️ Qui c'era scritto che il gruppo porta lo stesso `aria-label` e che
 * `getByLabelText` ne troverebbe due: è FALSO, e misurato il 2026-09-19 sulla
 * pagina montata — `queryAllByLabelText('Data del registro')` restituisce **1**
 * elemento, ed è l'`INPUT`; il `role="group"` ha `aria-label` **`null`**, perché
 * `NavigatoreData` non lo ripete di proposito (`NavigatoreData.tsx:90-95`: lo
 * stesso nome letto due volte è rumore, non aiuto).
 *
 * La query per ruolo resta comunque quella giusta, ma per l'altro motivo: lega
 * il nome accessibile al CONTROLLO. `getByLabelText` è indifferente a dove
 * l'etichetta si posa — se un domani migrasse sul contenitore resterebbe verde
 * mentre il campo tornerebbe a essere annunciato «modifica testo, vuoto» da uno
 * screen reader. `getByRole('textbox', { name })` in quel caso diventa rosso.
 */
const campoData = () => screen.getByRole('textbox', { name: itPrimaria.registroDataAria }) as HTMLInputElement
const frecciaIndietro = () => screen.getByRole('button', { name: itShared.navigatoreDataGiornoPrecedente })
const bottoneOggi = () => screen.getByRole('button', { name: itShared.navigatoreDataOggi })

/** Le sole chiamate alla giornata di registro, in ordine. */
const chiamateRegistro = () => chiamate.filter((u) => u.includes('/api/primaria/registro'))
/** Il valore di `data=` dell'ultima richiesta al registro ('' se non ce n'è nessuna). */
const ultimaDataChiesta = () => {
    const ultima = chiamateRegistro().at(-1)
    return ultima ? new URL(ultima, 'http://localhost').searchParams.get('data') ?? '' : ''
}

describe('registro primaria · il giorno si sceglie, si ricorda e non slitta di fuso', () => {

    it('CONTROLLO POSITIVO: a metà giornata si apre su oggi e lo chiede all’API', async () => {
        render(<RegistroPage />)

        expect(campoData().value).toBe('18/09/2026')
        await waitFor(() => expect(chiamateRegistro().length).toBe(1))
        expect(ultimaDataChiesta()).toBe('2026-09-18')
    })

    it('all’00:30 italiane (22:30Z del giorno prima) apre sul 19, non sul 18', async () => {
        vi.setSystemTime(new Date(NOTTE_19))
        render(<RegistroPage />)

        expect(
            campoData().value,
            '`toISOString().slice(0,10)` è UTC: fra mezzanotte e le due italiane il registro ' +
                'apre su IERI. L’ora firmata pochi minuti prima risulta non firmata, e le ore ' +
                'di oggi non ci sono. È la stessa regressione già corretta e blindata ' +
                'sull’appello della primaria.',
        ).toBe('19/09/2026')
        await waitFor(() => expect(ultimaDataChiesta()).toBe('2026-09-19'))
    })

    it('la freccia ‹ porta al giorno precedente, e la giornata si ricarica su QUELLA data', async () => {
        render(<RegistroPage />)
        await waitFor(() => expect(chiamateRegistro().length).toBe(1))

        fireEvent.click(frecciaIndietro())

        await waitFor(() => expect(chiamateRegistro().length).toBe(2))
        expect(
            ultimaDataChiesta(),
            'Senza frecce, per vedere ieri bisogna ridigitare tutte e otto le cifre: è il ' +
                'difetto segnalato («non si riesce a tornare indietro con le date»).',
        ).toBe('2026-09-17')
        expect(campoData().value).toBe('17/09/2026')
    })

    it('«Oggi» compare solo quando serve e riporta al giorno corrente', async () => {
        render(<RegistroPage />)
        await waitFor(() => expect(chiamateRegistro().length).toBe(1))

        expect(
            screen.queryByRole('button', { name: itShared.navigatoreDataOggi }),
            'Su oggi il bottone «Oggi» non ha niente da fare e non si mostra.',
        ).toBeNull()

        fireEvent.click(frecciaIndietro())
        await waitFor(() => expect(campoData().value).toBe('17/09/2026'))

        fireEvent.click(bottoneOggi())
        await waitFor(() => expect(ultimaDataChiesta()).toBe('2026-09-18'))
        expect(campoData().value).toBe('18/09/2026')
    })

    it('digitando una data INCOMPLETA non parte nessuna richiesta e non compare nessun errore', async () => {
        render(<RegistroPage />)
        await waitFor(() => expect(chiamateRegistro().length).toBe(1))

        // Una sola cifra: `itToIso` non riconosce ancora niente, e il campo
        // mascherato emetterebbe l'ISO vuoto.
        fireEvent.change(campoData(), { target: { value: '1' } })

        // Si aspetta la PRESENZA di quello che la maestra ha battuto: «non c'è il
        // banner» sarebbe vero anche mentre una fetch è ancora in volo.
        await waitFor(() => expect(campoData().value).toBe('1'))

        expect(
            chiamateRegistro().length,
            'La stringa vuota finiva nella query (`?data=`) e il 400 di `zDataYMD` diventava ' +
                'un banner rosso mentre l’utente stava ancora scrivendo.',
        ).toBe(1)
        expect(screen.queryByRole('alert')).toBeNull()
    })

    it('con `?data=` nell’URL la pagina apre su QUEL giorno, non su oggi', async () => {
        stub.search = new URLSearchParams(`userId=${DOCENTE}&data=2026-09-10`)
        render(<RegistroPage />)

        expect(
            campoData().value,
            'La data viveva solo in `useState`: un F5 o un giro su un’altra linguetta di ' +
                'ClasseShell riportava a oggi, e sembrava che il registro non restasse indietro.',
        ).toBe('10/09/2026')
        await waitFor(() => expect(ultimaDataChiesta()).toBe('2026-09-10'))
    })

    it('cambiando giorno l’URL si aggiorna, `?userId=` resta, e la cronologia non si riempie', async () => {
        render(<RegistroPage />)
        await waitFor(() => expect(chiamateRegistro().length).toBe(1))

        const primaDelCambio = chiamate.length
        fireEvent.click(frecciaIndietro())
        await waitFor(() => expect(stub.replace).toHaveBeenCalled())

        expect(
            chiamate.length - primaDelCambio,
            'QUANTO COSTA UN CAMBIO DI GIORNO. Due fetch: la giornata di registro e il ' +
                'bundle di classe. Gli effetti di `sezioni` e `me` dipendono dal solo `userId` ' +
                'e non ripartono. A queste due si aggiunge UNA soft navigation ' +
                '(`router.replace`), che in produzione può valere un giro RSC sul segmento: ' +
                'qui il router è finto e quel giro NON è misurabile — è dichiarato accanto a ' +
                '`cambiaData`, non contato. Questa app ha già pagato un incidente da volume ' +
                'di richieste: se questo numero sale, si sappia perché.',
        ).toBe(2)

        const [url, opzioni] = stub.replace.mock.calls.at(-1) as [string, { scroll?: boolean }]
        const scritta = new URL(url, 'http://localhost')
        expect(scritta.pathname).toBe(PERCORSO)
        expect(scritta.searchParams.get('data')).toBe('2026-09-17')
        expect(
            scritta.searchParams.get('userId'),
            'Perdere `?userId=` qui significa perdere l’identità che ClasseShell mette negli ' +
                'href di tutte le linguette: la segreteria che opera per conto del docente ' +
                'titolare tornerebbe a essere sé stessa.',
        ).toBe(DOCENTE)
        expect(opzioni?.scroll, 'cambiare giorno non deve far risalire la pagina in cima').toBe(false)
        expect(
            stub.push,
            'Con `push` venti giorni sfogliati diventano venti passi del pulsante «indietro».',
        ).not.toHaveBeenCalled()
    })

    it('una data IMPOSSIBILE nell’URL non apre un vicolo cieco: si riparte da oggi', async () => {
        stub.search = new URLSearchParams(`userId=${DOCENTE}&data=2026-02-30`)
        render(<RegistroPage />)

        expect(
            campoData().value,
            'Il 30 febbraio ha la FORMA giusta e non esiste. `dataDaUrl` guardava solo la ' +
                'forma e lo accettava, mentre la guardia sulla fetch pretendeva anche il ' +
                'calendario: due domande diverse sulla stessa data. Risultato misurato — campo ' +
                '`30/02/2026`, ENTRAMBE le frecce spente (`giornoNavigabile` rifiuta un giorno ' +
                'che non c’è), zero chiamate, nessun banner e a video «Nessun’ora prevista ' +
                'dall’orario in questo giorno»: una frase falsa su un giorno inesistente, senza ' +
                'via d’uscita se non «Oggi». Il caso che stava qui prima certificava quel ' +
                'vicolo cieco come voluto.',
        ).toBe('18/09/2026')

        expect(frecciaIndietro()).toBeEnabled()
        expect(screen.getByRole('button', { name: itShared.navigatoreDataGiornoSuccessivo })).toBeEnabled()

        await waitFor(() => expect(chiamateRegistro().length).toBe(1))
        expect(ultimaDataChiesta()).toBe('2026-09-18')
        expect(screen.queryByRole('alert')).toBeNull()
    })

    it.each([
        ['una parola al posto di una data', 'pippo'],
        ['un `?data=` vuoto', ''],
    ])('con %s nell’URL si riparte da oggi, senza banner', async (_caso, valore) => {
        stub.search = new URLSearchParams(`userId=${DOCENTE}&data=${valore}`)
        render(<RegistroPage />)

        expect(campoData().value).toBe('18/09/2026')
        await waitFor(() => expect(chiamateRegistro().length).toBe(1))
        expect(
            ultimaDataChiesta(),
            'Una `?data=` illeggibile non deve arrivare in query: il 400 di `zDataYMD` ' +
                'diventerebbe un banner rosso su una schermata appena aperta.',
        ).toBe('2026-09-18')
        expect(screen.queryByRole('alert')).toBeNull()
    })

    it('LA RETE FINTA È FEDELE A `zDataYMD` · il 30 febbraio è un 400, non un 200', async () => {
        // Questo caso misura IL FINTO, non la pagina. Se il finto è più permissivo
        // del server vero, l'asserzione «nessun banner rosso» degli altri casi non
        // prova niente — ed era esattamente così: il finto usava
        // `Number.isNaN(Date.parse(\`${data}T12:00:00Z\`))`, che in V8 sul 30
        // febbraio NON è NaN. La fedeltà si blocca qui, non in un commento.
        const stato = async (data: string) =>
            (await fetchMock(`/api/primaria/registro?sectionId=${SEZIONE}&data=${data}&userId=${DOCENTE}`)).status

        expect(await stato('2026-02-30'), 'il 30 febbraio non esiste: `zDataYMD` risponde 400').toBe(400)
        expect(await stato('2026-02-29'), 'il 2026 non è bisestile').toBe(400)
        expect(await stato('2026-13-01'), 'mese 13').toBe(400)
        expect(await stato(''), '`?data=` vuoto').toBe(400)
        expect(
            await stato('2026-09-18'),
            'e un giorno vero deve passare, altrimenti il finto direbbe sempre di no e i casi ' +
                'positivi sarebbero verdi per il motivo sbagliato.',
        ).toBe(200)
    })

    it('CORSA · due cambi di giorno ravvicinati: vince l’ULTIMO CHIESTO, non l’ultimo arrivato', async () => {
        giornataConArgomento = true
        // 1ª risposta (il 18) immediata; la 2ª (il 17) tarda 120 ms, la 3ª (il 16)
        // 10 ms: l'ordine d'ARRIVO è 16 e poi 17, cioè al contrario di quello di
        // partenza. È l'unico modo di provare che esiste un token di annullamento.
        ritardiRegistro.push(0, 120, 10)

        render(<RegistroPage />)
        await waitFor(() => expect(chiamateRegistro().length).toBe(1))

        // I due click di fila, senza attese in mezzo: è il gesto vero — con le
        // frecce tornare a ieri l'altro costa due tocchi, non otto cifre.
        fireEvent.click(frecciaIndietro())
        fireEvent.click(frecciaIndietro())
        await waitFor(() => expect(chiamateRegistro().length).toBe(3))

        // Si lascia scadere ANCHE la risposta lenta: «non c'è ancora» sarebbe vero
        // pure mentre è in volo, e questo caso resterebbe verde senza correzione.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(500)
        })

        expect(campoData().value).toBe('16/09/2026')
        expect(
            screen.getByText('ARG 2026-09-16'),
            'La griglia deve restare quella dell’ultimo giorno CHIESTO.',
        ).toBeInTheDocument()
        expect(
            screen.queryByText('ARG 2026-09-17'),
            'Senza token in `load`, la risposta sorpassata arriva dopo e riscrive campanelle, ' +
                'orario e righe: il campo mostra il 16 e la griglia gli argomenti del 17. La ' +
                'modale «Firma» opera su `data` — il 16 — mentre la maestra sta leggendo il 17.',
        ).toBeNull()
    })

    /**
     * ─── IL GUASTO, CHE È LA CORSA SENZA LA CORSA ───────────────────────────────
     * I due casi qui sotto raggiungono lo STESSO disallineamento campo↔griglia del
     * caso CORSA, ma senza nessuna corsa: basta che la giornata del giorno nuovo non
     * arrivi. `load` scriveva solo dentro `if (reg.dati)` e non svuotava niente in
     * caso di fallimento, quindi un 500 lasciava a video campanelle, orario e righe
     * del giorno VECCHIO sotto un campo data già cambiato. Un click di freccia, e
     * una fetch che fallisce da sola su una rete di scuola.
     */
    it('500 sul giorno nuovo: la griglia NON resta quella del giorno vecchio', async () => {
        giornataConArgomento = true
        guastiRegistro.add('2026-09-17')

        render(<RegistroPage />)
        // La PRESENZA della griglia del 18, non l'assenza di qualcosa: il caso deve
        // partire da uno stato che si vede davvero a schermo.
        await waitFor(() => expect(screen.getByText('ARG 2026-09-18')).toBeInTheDocument())

        fireEvent.click(frecciaIndietro())
        // Idem qui: si aspetta che il banner rosso CI SIA. «La griglia del 18 non
        // c'è più» sarebbe vero anche mentre la richiesta del 17 è ancora in volo.
        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

        expect(campoData().value).toBe('17/09/2026')
        expect(
            screen.queryByText('ARG 2026-09-18'),
            'Con il solo ramo `if (reg.dati)` il fallimento non svuotava niente: campo sul 17 e ' +
                'griglia del 18. Meglio una griglia VUOTA sotto il banner rosso — il vuoto si ' +
                'vede, il giorno sbagliato no.',
        ).toBeNull()
    })

    it('dopo il 500 un allegato non finisce sulla riga di un altro giorno', async () => {
        giornataConArgomento = true
        guastiRegistro.add('2026-09-17')

        const { container } = render(<RegistroPage />)
        await waitFor(() => expect(screen.getByText('ARG 2026-09-18')).toBeInTheDocument())

        fireEvent.click(frecciaIndietro())
        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
        expect(campoData().value).toBe('17/09/2026')

        // Se la griglia si è svuotata NON c'è nessuna riga a cui appendere un file, e
        // quello è il comportamento voluto: l'`input[type=file]` semplicemente non
        // esiste. Se invece è rimasta quella del 18, il campo c'è ancora — ed è la
        // riga di un altro giorno.
        const campoFile = container.querySelector('input[type="file"]')
        if (campoFile) {
            fireEvent.change(campoFile, {
                target: { files: [new File(['x'], 'compito.pdf', { type: 'application/pdf' })] },
            })
            await waitFor(() => expect(allegatiInviati.length).toBe(1))
        }

        expect(
            // «Nessun allegato partito» vale quanto «partito sul giorno giusto»: sono
            // i due esiti accettabili, e l'unico inaccettabile è un `registroId` di un
            // altro giorno. Il fallback dice questo, e non nasconde niente — con la
            // griglia del 18 ancora a video l'allegato parte eccome.
            allegatiInviati.at(-1) ?? 'r-2026-09-17',
            'Il campo mostra il 17 e la modale/i bottoni operano sulle righe a video: con la ' +
                'griglia del 18 rimasta, «Allega» spedisce `registroId=r-2026-09-18`. L’allegato ' +
                'finisce sulla riga di un altro giorno e sparisce dalla vista al ricaricamento.',
        ).toBe('r-2026-09-17')
    })
})
