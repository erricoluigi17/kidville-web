import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

/**
 * LOCK · IL GRADO DEL FIGLIO SI RICORDA FRA UNA SESSIONE E L'ALTRA.
 *
 * ─── IL DIFETTO ──────────────────────────────────────────────────────────────
 * Il grado di un bambino non cambia mai — nessuno passa da nido a primaria a
 * metà anno — ma l'app lo ridimenticava a ogni apertura, e finché non si sapeva
 * la riga delle scorciatoie della home teneva riservata la quinta colonna
 * («Compiti» esiste solo per la primaria). All'arrivo della risposta, per il
 * 0-6 — la MAGGIORANZA delle famiglie — la riga tornava a quattro colonne e le
 * card si allargavano: il centro della quarta passa da ~0,70 a ~0,875 della
 * larghezza, quindi un dito puntato sul vecchio centro atterra DENTRO la terza
 * card. `useChildSchoolType` semina adesso il grado da `localStorage`.
 *
 * ─── COSA MISURA QUESTO FILE, E PERCHÉ NON BASTA «È VERDE» ───────────────────
 * Il verde facile qui sarebbe un test che aspetta la risposta della fetch e
 * trova il grado: sarebbe verde ANCHE senza cache, cioè misurerebbe la rete.
 * Perciò ogni caso che riguarda il seme asserisce con la fetch ANCORA IN VOLO
 * (una promise che non si risolve mai) — e non è un `waitFor` su un'assenza:
 * `renderHook` scarica gli effetti dentro `act`, quindi quando la riga
 * dell'asserzione viene eseguita il seme ha GIÀ avuto il suo turno. Ciò che si
 * legge lì dentro non può venire che dal dispositivo.
 *
 * ─── LA CHIAVE È CABLATA A MANO, ED È VOLUTO ─────────────────────────────────
 * `kv_grado_<uuid figlio>`. Scriverla qui invece di importare la costante è ciò
 * che rende il test capace di accorgersi di un cambio di formato: la chiave è
 * un contratto con i dispositivi già in giro, e rinominarla svuota la cache di
 * tutti. Se un giorno cambia davvero, questo file va aggiornato di proposito.
 */

const CHIAVE_FIGLIO = 'kv_student_id'
const chiaveGrado = (studentId: string) => `kv_grado_${studentId}`

/**
 * L'identità del genitore: `studentId`, `figliIds`, `inAttesa` e `ready` sono
 * tutti pilotabili, perché i fotogrammi che contano sono diversi fra loro —
 * l'avvio a freddo (identità in volo, nessun `studentId`), il regime, il figlio
 * che cambia in corsa quando la rivalidazione scarta un id stantio, e i DUE
 * elenchi vuoti che non vogliono la stessa risposta.
 *
 * `inAttesa` non è un campo in più per completezza: è l'unico segno che separa
 * «elenco vuoto e determinato» da «elenco non determinabile», che
 * `figli ?? []` (`use-parent-identity.ts:320`) fa collassare nello stesso `[]`.
 * Cablarlo a `false`, com'era, rendeva l'uno indistinguibile dall'altro anche
 * qui dentro — cioè rendeva non scrivibile il test del figlio archiviato.
 */
const identita = vi.hoisted(() => ({
    parentId: 'p-1' as string | null,
    studentId: 's-1' as string | null,
    figliIds: [] as string[],
    inAttesa: false,
    ready: true,
}))

vi.mock('@/lib/auth/use-parent-identity', () => ({
    useParentIdentity: () => ({
        parentId: identita.parentId,
        studentId: identita.studentId,
        figliIds: identita.figliIds,
        inAttesa: identita.inAttesa,
        motivoAssenza: null,
        ready: identita.ready,
    }),
}))

vi.mock('@/lib/logging/client', () => ({
    logClient: vi.fn(),
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

import { logClient } from '@/lib/logging/client'
import { useChildSchoolType } from '@/lib/auth/use-child-school-type'

const fetchMock = vi.fn()

/** La risposta buona di `/api/parent/primaria`. */
function rispostaGrado(schoolType: unknown) {
    return { ok: true, status: 200, json: async () => ({ data: { schoolType } }) }
}

/** Una fetch che NON risponde: è il fotogramma in cui il seme è l'unica fonte possibile. */
function inVolo() {
    return new Promise<never>(() => {})
}

beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    identita.parentId = 'p-1'
    identita.studentId = 's-1'
    identita.figliIds = ['s-1']
    identita.inAttesa = false
    identita.ready = true
    fetchMock.mockReturnValue(inVolo())
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('useChildSchoolType · il grado si ricorda per figlio', () => {
    it('prima apertura su questo dispositivo: nessun seme, e la risposta scrive la voce', async () => {
        fetchMock.mockResolvedValue(rispostaGrado('infanzia'))
        const { result } = renderHook(() => useChildSchoolType())

        // Comportamento di oggi: il grado arriva dalla rete, non prima.
        await waitFor(() => expect(result.current.ready).toBe(true))
        expect(result.current.schoolType).toBe('infanzia')
        expect(
            window.localStorage.getItem(chiaveGrado('s-1')),
            'la risposta non è stata memorizzata: la prossima apertura ripartirebbe da zero, ' +
                'cioè la cache non esiste',
        ).toBe('infanzia')
    })

    it('apertura successiva: il grado è noto con la fetch ancora in volo', () => {
        window.localStorage.setItem(chiaveGrado('s-1'), 'primaria')

        const { result } = renderHook(() => useChildSchoolType())

        expect(result.current.schoolType).toBe('primaria')
        expect(
            result.current.ready,
            '`ready` resta falso con il grado già noto: chi legge solo quel segno — la home, per ' +
                'la larghezza della riga — riserverebbe la colonna in più lo stesso, e la cache ' +
                'non servirebbe a niente',
        ).toBe(true)
    })

    /**
     * ─── IL FOTOGRAMMA CHE CONTA DAVVERO ─────────────────────────────────────
     * All'avvio a freddo `useParentIdentity` non ha ancora risolto niente:
     * `studentId` è `null` finché `/api/parent/students` non risponde. Se il
     * seme aspettasse quel momento, il grado tornerebbe alla velocità della
     * rete — cioè il difetto, spostato di un endpoint. Qui il figlio lo dà il
     * dispositivo (`kv_student_id`), e la prova che non c'è stata rete è che
     * NESSUNA fetch è partita.
     */
    it('avvio a freddo: il grado arriva da kv_student_id, senza una sola chiamata di rete', () => {
        window.localStorage.setItem(CHIAVE_FIGLIO, 's-1')
        window.localStorage.setItem(chiaveGrado('s-1'), 'primaria')
        identita.studentId = null
        identita.ready = false
        identita.figliIds = []

        const { result } = renderHook(() => useChildSchoolType())

        expect(result.current).toEqual({ schoolType: 'primaria', ready: true })
        expect(fetchMock, 'il grado è stato chiesto alla rete: non viene dal dispositivo').not.toHaveBeenCalled()
    })

    it('la risposta della rete VINCE su un valore in cache diverso, e riscrive la voce', async () => {
        window.localStorage.setItem(chiaveGrado('s-1'), 'infanzia')
        fetchMock.mockResolvedValue(rispostaGrado('primaria'))

        const { result } = renderHook(() => useChildSchoolType())
        expect(result.current.schoolType).toBe('infanzia') // il seme, per un istante

        await waitFor(() => expect(result.current.schoolType).toBe('primaria'))
        expect(
            window.localStorage.getItem(chiaveGrado('s-1')),
            'la voce in cache è rimasta quella smentita: alla prossima apertura il suggerimento ' +
                'sbagliato tornerebbe, e la rete dovrebbe smentirlo di nuovo ogni volta',
        ).toBe('primaria')
    })

    it('il server dice «nessun grado»: la voce si TOGLIE, non sopravvive alla propria smentita', async () => {
        window.localStorage.setItem(chiaveGrado('s-1'), 'primaria')
        fetchMock.mockResolvedValue(rispostaGrado(null))

        const { result } = renderHook(() => useChildSchoolType())
        await waitFor(() => expect(result.current.schoolType).toBeNull())
        expect(window.localStorage.getItem(chiaveGrado('s-1'))).toBeNull()
    })

    it.each([
        ['un grado che non esiste', 'liceo'],
        ['una stringa vuota', ''],
        ['il JSON di un altro formato', '{"grado":"primaria"}'],
    ])('cache malformata (%s): ignorata, e si torna al comportamento di oggi', (_caso, valore) => {
        window.localStorage.setItem(chiaveGrado('s-1'), valore)

        const { result } = renderHook(() => useChildSchoolType())

        expect(result.current).toEqual({ schoolType: null, ready: false })
    })

    it('la voce di un fratello non vale per l’altro', () => {
        window.localStorage.setItem(chiaveGrado('s-altro'), 'primaria')
        identita.studentId = 's-1'
        identita.figliIds = ['s-1', 's-altro']

        const { result } = renderHook(() => useChildSchoolType())

        expect(
            result.current,
            'il figlio corrente ha ereditato il grado del fratello: due bambini di gradi diversi ' +
                'si passerebbero la griglia della home',
        ).toEqual({ schoolType: null, ready: false })
    })

    /**
     * Il figlio che cambia IN CORSA: è quello che fa `decidiFiglioRivalidato`
     * quando `kv_student_id` non è tra i figli del genitore (cache stantia,
     * link altrui, alunno ricreato). Il seme era già a schermo: se restasse, la
     * home mostrerebbe per un giro di rete la griglia del bambino sbagliato.
     */
    it('il figlio cambia dopo la rivalidazione: il seme del precedente viene tolto', async () => {
        window.localStorage.setItem(CHIAVE_FIGLIO, 's-stantio')
        window.localStorage.setItem(chiaveGrado('s-stantio'), 'primaria')
        identita.studentId = null
        identita.ready = false

        const { result, rerender } = renderHook(() => useChildSchoolType())
        expect(result.current).toEqual({ schoolType: 'primaria', ready: true })

        identita.studentId = 's-vero'
        identita.ready = true
        identita.figliIds = ['s-vero']
        rerender()

        expect(result.current).toEqual({ schoolType: null, ready: false })
    })
})

describe('useChildSchoolType · invalidazione (la disciplina di decidiFiglioRivalidato)', () => {
    // Asserzioni SINCRONE e nessun `waitFor`: la pulizia gira nell'effetto di
    // mount, che `renderHook` scarica dentro `act`. Un `waitFor` qui non
    // renderebbe il test più vero, pagherebbe solo i 5 s di timeout ogni volta
    // che diventa rosso — cioè proprio quando lo si sta leggendo.
    it('una voce di un figlio che non è più tra i figli viene RIMOSSA, le altre restano', () => {
        window.localStorage.setItem(chiaveGrado('s-1'), 'infanzia')
        window.localStorage.setItem(chiaveGrado('s-archiviato'), 'primaria')
        window.localStorage.setItem(chiaveGrado('s-di-un-altro-account'), 'nido')
        identita.figliIds = ['s-1']

        renderHook(() => useChildSchoolType())

        expect(
            window.localStorage.getItem(chiaveGrado('s-archiviato')),
            'il grado di un figlio archiviato sopravvive all’iscrizione che lo giustificava',
        ).toBeNull()
        expect(window.localStorage.getItem(chiaveGrado('s-di-un-altro-account'))).toBeNull()
        expect(
            window.localStorage.getItem(chiaveGrado('s-1')),
            'la pulizia ha portato via anche la voce di un figlio VERO: ogni apertura ripartirebbe ' +
                'da zero e la cache sarebbe decorazione',
        ).toBe('infanzia')
        expect(
            window.localStorage.getItem(CHIAVE_FIGLIO),
            'la pulizia ha toccato una chiave che non è sua',
        ).toBeNull()
    })

    it('dopo la pulizia il grado torna ignoto: al mount successivo non c’è più nessun seme', () => {
        window.localStorage.setItem(chiaveGrado('s-archiviato'), 'primaria')
        identita.figliIds = ['s-1']
        renderHook(() => useChildSchoolType())

        identita.studentId = 's-archiviato'
        const { result } = renderHook(() => useChildSchoolType())

        expect(result.current).toEqual({ schoolType: null, ready: false })
    })

    /**
     * `figliIds: []` non è «questo genitore non ha figli»: è anche «elenco non
     * determinabile», cioè rete giù. Cancellare lì dentro vorrebbe dire buttare
     * la cache di tutta la famiglia per un blip — ed è esattamente ciò che
     * `decidiFiglioRivalidato` si dà la pena di non fare con `kv_student_id`.
     */
    it('elenco dei figli non determinabile (rete giù): non si cancella NIENTE', () => {
        window.localStorage.setItem(chiaveGrado('s-1'), 'infanzia')
        window.localStorage.setItem(chiaveGrado('s-2'), 'primaria')
        identita.figliIds = []

        renderHook(() => useChildSchoolType())

        expect(window.localStorage.getItem(chiaveGrado('s-1'))).toBe('infanzia')
        expect(window.localStorage.getItem(chiaveGrado('s-2'))).toBe('primaria')
    })

    /**
     * L'ALTRO elenco vuoto, che non è lo stesso — e il caso in cui la pulizia
     * per DIFFERENZA non può funzionare per costruzione: se il figlio archiviato
     * era l'UNICO, l'elenco arriva vuoto e non c'è nessuna voce «estranea» da
     * togliere, perché non c'è niente con cui confrontarla.
     *
     * Il segno che lo distingue dalla rete giù esiste già: `inAttesa` vale
     * `lettura !== null && lettura.inAttesa` (`use-parent-identity.ts:325`),
     * quindi `true` implica una lettura RIUSCITA con l'elenco dei visibili vuoto
     * — legami di famiglia che esistono e un filtro (archiviato, ritirato, senza
     * sezione) che li ha tolti tutti. In produzione, misura del 2026-09-06: 4
     * account senza figli visibili, di cui UNO con l'unico figlio archiviato.
     *
     * Perché non è cosmetico: nello STESSO evento `decidiFiglioRivalidato(known,
     * [])` cancella `kv_student_id`. Se il grado restasse, sarebbe l'ultima
     * traccia di quel bambino su quel telefono — e nella chiave c'è il suo uuid.
     */
    it('l’unico figlio è stato archiviato: la sua voce sparisce lo stesso', () => {
        window.localStorage.setItem(chiaveGrado('s-archiviato'), 'primaria')
        window.localStorage.setItem(chiaveGrado('s-di-un-altro-account'), 'nido')
        window.localStorage.setItem('kv_altro', 'resta')
        identita.studentId = null
        identita.figliIds = []
        identita.inAttesa = true

        renderHook(() => useChildSchoolType())

        expect(
            window.localStorage.getItem(chiaveGrado('s-archiviato')),
            'il grado dell’unico figlio archiviato è rimasto sul dispositivo: l’identità ha già ' +
                'buttato `kv_student_id`, quindi questa voce è l’ultima traccia di quel bambino',
        ).toBeNull()
        expect(window.localStorage.getItem(chiaveGrado('s-di-un-altro-account'))).toBeNull()
        expect(
            window.localStorage.getItem('kv_altro'),
            'la pulizia ha portato via una chiave che non è sua: non è una scopa',
        ).toBe('resta')
    })

    it('una risposta NON-OK non cancella la voce: un 500 non è un «nessun grado»', async () => {
        window.localStorage.setItem(chiaveGrado('s-1'), 'primaria')
        fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })

        const { result } = renderHook(() => useChildSchoolType())
        await waitFor(() => expect(result.current.ready).toBe(true))

        expect(window.localStorage.getItem(chiaveGrado('s-1'))).toBe('primaria')
    })
})

describe('useChildSchoolType · lo storage può lanciare, la home no', () => {
    it('lettura negata (finestra privata): il grado resta ignoto, l’hook vive, il guasto si vede', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new DOMException('accesso negato', 'SecurityError')
        })

        const { result } = renderHook(() => useChildSchoolType())

        expect(result.current).toEqual({ schoolType: null, ready: false })
        expect(
            vi.mocked(logClient).mock.calls.some(([e]) => e.messaggio.includes('grado-figlio-cache-non-disponibile')),
            'lo storage negato non lascia nessuna traccia: «la cache non funziona su nessun ' +
                'dispositivo» e «la cache funziona» diventano lo stesso silenzio',
        ).toBe(true)
    })

    it('scrittura negata (quota piena): la risposta della rete arriva lo stesso a schermo', async () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('quota superata', 'QuotaExceededError')
        })
        fetchMock.mockResolvedValue(rispostaGrado('primaria'))

        const { result } = renderHook(() => useChildSchoolType())

        await waitFor(() => expect(result.current.schoolType).toBe('primaria'))
        expect(result.current.ready).toBe(true)
        expect(
            vi.mocked(logClient).mock.calls.some(([e]) => e.messaggio.includes('operazione=scrittura')),
            'la scrittura fallita non è stata registrata',
        ).toBe(true)
    })
})
