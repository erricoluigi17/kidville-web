import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'

import itPrimaria from '../../messages/it/teacherPrimaria.json'
import itShared from '../../messages/it/shared.json'

/**
 * LOCK · registro di classe della primaria: ELIMINARE (la propria firma, la
 * lezione) e SBLOCCARE (voce, ora mai firmata, giornata) dall'interfaccia.
 *
 * Spec 2026-09-24, compito R3:
 *  · sulla propria firma «Elimina la mia firma», con conferma che avvisa quando è
 *    l'UNICA (sparisce la lezione, gli allegati vanno nel cestino);
 *  · per Segreteria e Direzione «Elimina lezione», con conferma;
 *  · voce bloccata (423): messaggio e, alla sola Direzione, `BottoneSblocca` in
 *    modo voce o slot — anche per le ore mai firmate;
 *  · nella testata, alla Direzione, lo sblocco della GIORNATA della classe.
 *
 * Ogni caso verifica la RICHIESTA che parte (metodo, URL, corpo), non solo che un
 * bottone compaia: un bottone che manda la chiave sbagliata risponderebbe 400 o,
 * peggio, eliminerebbe la lezione intera al posto della firma.
 */

const SEZIONE = 'sez-1'
const DOCENTE = 'doc-1'
const COLLEGA = 'doc-2'

const stub = vi.hoisted(() => ({
    params: { sectionId: 'sez-1' } as Record<string, string>,
    search: new URLSearchParams(),
}))

vi.mock('next/navigation', () => ({
    useParams: () => stub.params,
    useSearchParams: () => stub.search,
    usePathname: () => '/teacher/primaria/sez-1/registro',
    useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}))

vi.mock('@/lib/auth/current-teacher', () => ({ getCurrentTeacherId: () => DOCENTE }))

vi.mock('@/lib/offline/syncEngine', () => ({
    saveLocalRegistro: vi.fn(async () => {}),
    syncPendingRegistro: vi.fn(async () => {}),
}))

const logClientMock = vi.fn()
vi.mock('@/lib/logging/client', () => ({
    logClient: (...args: unknown[]) => logClientMock(...args),
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

// Nomi inventati: il repository è pubblico.
const CAMPANELLE = [
    { id: 'camp-1', ordine: 1, ora_inizio: '08:30:00', ora_fine: '09:30:00', tipo: 'lezione' },
    { id: 'camp-2', ordine: 2, ora_inizio: '09:30:00', ora_fine: '10:30:00', tipo: 'lezione' },
]
const ORARIO_CELLE = [
    { campanella_id: 'camp-1', materia_id: 'mat-ita', materie: { nome: 'Italiano' } },
    { campanella_id: 'camp-2', materia_id: 'mat-ita', materie: { nome: 'Italiano' } },
]

type FirmaFinta = { id: string; maestra_id: string; tipo_compresenza: string; argomento_proprio: null; compiti_propri: null; utenti: { nome: string; cognome: string } }
const firma = (id: string, maestra: string, nome: string): FirmaFinta => ({
    id, maestra_id: maestra, tipo_compresenza: 'principale', argomento_proprio: null, compiti_propri: null,
    utenti: { nome, cognome: 'Prova' },
})

/** 1ª ora: firmata SOLO dal docente corrente, con due allegati. */
function rigaUnica() {
    return {
        id: 'reg-1', ora_lezione: 1, materia: null, materia_id: 'mat-ita',
        argomento: 'Le vocali', compiti: 'Pagina 3', data_consegna_compiti: null,
        materie: { nome: 'Italiano' },
        firme_docenti: [firma('firma-1', DOCENTE, 'Ada')],
        registro_destinatari: [],
        allegati_registro: [
            { id: 'all-1', ambito: 'lezione', tipo: 'pdf', file_url: 'https://esempio.invalid/a.pdf', file_name: 'scheda.pdf' },
            { id: 'all-2', ambito: 'lezione', tipo: 'img', file_url: 'https://esempio.invalid/b.jpg', file_name: 'foto.jpg' },
        ],
    }
}

/** 1ª ora in COFIRMA: il docente corrente e un collega. */
function rigaCofirmata() {
    return {
        ...rigaUnica(),
        firme_docenti: [firma('firma-1', DOCENTE, 'Ada'), firma('firma-9', COLLEGA, 'Bruno')],
        allegati_registro: [],
    }
}

interface RispostaFinta { ok?: boolean; status?: number; body?: unknown; lancia?: boolean }
let risposte: Array<[string, RispostaFinta | ((init?: RequestInit) => RispostaFinta)]> = []
const chiamate: Array<{ url: string; init?: RequestInit }> = []

function rispostaPer(url: string, init?: RequestInit): RispostaFinta {
    const metodo = init?.method ?? 'GET'
    for (const [chiave, r] of risposte) {
        // `METODO frammento` oppure solo `frammento` (qualunque metodo).
        const [m, frammento] = chiave.includes(' ') ? chiave.split(' ') : [null, chiave]
        if ((m === null || m === metodo) && url.includes(frammento)) return typeof r === 'function' ? r(init) : r
    }
    return { ok: true, status: 200, body: { success: true, data: [] } }
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    chiamate.push({ url, init })
    const r = rispostaPer(url, init)
    if (r.lancia) throw new TypeError('Failed to fetch')
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body } as unknown as Response
})

/** Il termine della giornata come lo dichiara la GET (`statoTermineGiornata` nella route). */
interface TermineFinto { letto: boolean; oltreTermine: boolean; giorniLimite: number | null; giornoSbloccato: boolean; oreSbloccate: number[] }
const OLTRE: TermineFinto = { letto: true, oltreTermine: true, giorniLimite: 2, giornoSbloccato: false, oreSbloccate: [] }
const ENTRO: TermineFinto = { letto: true, oltreTermine: false, giorniLimite: 2, giornoSbloccato: false, oreSbloccate: [] }

function prepara(
    ruolo: string,
    righe: unknown[],
    extra: Array<[string, RispostaFinta | ((init?: RequestInit) => RispostaFinta)]> = [],
    termine?: TermineFinto,
) {
    risposte = [
        ...extra,
        ['/api/primaria/sezioni', { body: { success: true, data: [{ id: SEZIONE, name: '1ª A' }] } }],
        ['GET /api/primaria/registro', {
            body: {
                success: true,
                data: { giorno: 1, campanelle: CAMPANELLE, orarioCelle: ORARIO_CELLE, righe, ...(termine ? { termine } : {}) },
            },
        }],
        ['/api/primaria/classe/', { body: { success: true, data: { alunni: [], materie: [{ id: 'mat-ita', nome: 'Italiano' }] } } }],
        ['/api/primaria/me', { body: { success: true, data: { userId: DOCENTE, gradi: ['primaria'], ruolo } } }],
        ['/teachers', {
            body: { success: true, assigned: [{ id: COLLEGA, nome: 'Bruno', cognome: 'Prova', ruolo: 'educator' }], available: [] },
        }],
    ]
}

const letture = () => chiamate.filter((c) => (c.init?.method ?? 'GET') === 'GET' && c.url.includes('/api/primaria/registro?')).length
const delete_ = () => chiamate.filter((c) => c.init?.method === 'DELETE')
const postSblocca = () => chiamate.filter((c) => c.init?.method === 'POST' && c.url.includes('/api/primaria/sblocca'))

beforeEach(() => {
    vi.clearAllMocks()
    chiamate.length = 0
    stub.search = new URLSearchParams()
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

import RegistroPage from '@/app/(dashboard)/teacher/primaria/[sectionId]/registro/page'

/** Aspetta che il ruolo sia arrivato (i comandi dipendono da lui) e la griglia sia a schermo. */
async function pronta() {
    await screen.findAllByText(itPrimaria.registroOra.replace('{ora}', '1'))
    await waitFor(() => expect(chiamate.some((c) => c.url.includes('/api/primaria/me'))).toBe(true))
}

describe('«Elimina la mia firma»', () => {
    it('compare SOLO sulla propria firma, mai su quella del collega; «Elimina lezione» non c’è per la maestra', async () => {
        prepara('educator', [rigaCofirmata()])
        render(<RegistroPage />)
        await pronta()
        const bottoni = await screen.findAllByRole('button', { name: 'Elimina la mia firma della 1ª ora' })
        expect(bottoni, 'Due firme a schermo, una sola è mia: il bottone deve essere uno.').toHaveLength(1)
        expect(screen.queryByRole('button', { name: 'Elimina lezione della 1ª ora' })).toBeNull()
        expect(screen.queryByTestId('registro-sblocca-giorno')).toBeNull()
    })

    it('unica firma con allegati: la conferma AVVISA, e la DELETE porta `firmaId` e non `registroId`', async () => {
        prepara('educator', [rigaUnica()], [
            ['DELETE /api/primaria/registro', {
                body: { success: true, data: { eliminata: 'lezione', firmaId: 'firma-1', registroId: 'reg-1', allegatiNelCestino: 2 } },
            }],
        ])
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina la mia firma della 1ª ora' }))

        const dialogo = await screen.findByTestId('registro-conferma-eliminazione')
        expect(within(dialogo).getByTestId('registro-avviso-lezione-sparisce').textContent).toContain(itPrimaria.registroEliminaFirmaUnica)
        expect(
            within(dialogo).getByTestId('registro-avviso-allegati-cestino').textContent,
            'Il numero dei giorni di cestino viene da GIORNI_CESTINO_REGISTRO, non scritto a mano.',
        ).toContain('I 2 allegati vanno nel cestino per 7 giorni')
        expect(delete_(), 'Nessuna DELETE prima della conferma.').toHaveLength(0)

        const primaLetture = letture()
        fireEvent.click(within(dialogo).getByRole('button', { name: itPrimaria.registroEliminaFirmaConferma }))

        await waitFor(() => expect(delete_()).toHaveLength(1))
        const url = new URL(delete_()[0].url, 'http://x')
        expect(url.pathname).toBe('/api/primaria/registro')
        expect(url.searchParams.get('firmaId')).toBe('firma-1')
        expect(url.searchParams.has('registroId'), 'La firma non deve MAI viaggiare come lezione intera.').toBe(false)
        expect(url.searchParams.get('userId')).toBe(DOCENTE)
        expect((delete_()[0].init?.headers as Record<string, string>)['x-user-id']).toBe(DOCENTE)

        const esito = await screen.findByTestId('registro-esito')
        expect(esito.textContent, 'Il server dice che è sparita la LEZIONE: l’esito lo deve dire.').toContain(
            'Firma eliminata: era l’unica, e la lezione della 1ª ora non c’è più.',
        )
        expect(esito.textContent).toContain('2 allegati sono nel cestino.')
        await waitFor(() => expect(letture(), 'Dopo l’eliminazione il registro si rilegge.').toBeGreaterThan(primaLetture))
        expect(screen.queryByTestId('registro-conferma-eliminazione')).toBeNull()
    })

    it('in cofirma NON avvisa che sparisce la lezione (non è l’unica firma)', async () => {
        prepara('educator', [rigaCofirmata()])
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina la mia firma della 1ª ora' }))
        const dialogo = await screen.findByTestId('registro-conferma-eliminazione')
        expect(within(dialogo).getByText('Vuoi eliminare la tua firma dalla 1ª ora?')).toBeInTheDocument()
        expect(within(dialogo).queryByTestId('registro-avviso-lezione-sparisce')).toBeNull()
    })

    it('in cofirma, eliminata la sola firma, l’esito parla della FIRMA', async () => {
        prepara('educator', [rigaCofirmata()], [
            ['DELETE /api/primaria/registro', {
                body: { success: true, data: { eliminata: 'firma', firmaId: 'firma-1', registroId: 'reg-1', allegatiNelCestino: 0 } },
            }],
        ])
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina la mia firma della 1ª ora' }))
        fireEvent.click(within(await screen.findByTestId('registro-conferma-eliminazione')).getByRole('button', { name: itPrimaria.registroEliminaFirmaConferma }))
        expect((await screen.findByTestId('registro-esito')).textContent).toBe('Firma della 1ª ora eliminata.')
    })

    it('Annulla chiude senza mandare niente', async () => {
        prepara('educator', [rigaUnica()])
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina la mia firma della 1ª ora' }))
        const dialogo = await screen.findByTestId('registro-conferma-eliminazione')
        fireEvent.click(within(dialogo).getByRole('button', { name: itPrimaria.registroEliminaAnnulla }))
        await waitFor(() => expect(screen.queryByTestId('registro-conferma-eliminazione')).toBeNull())
        expect(delete_()).toHaveLength(0)
    })

    it('la rete che cade lascia la conferma aperta con l’errore, e lo logga', async () => {
        prepara('educator', [rigaUnica()], [['DELETE /api/primaria/registro', { lancia: true }]])
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina la mia firma della 1ª ora' }))
        const dialogo = await screen.findByTestId('registro-conferma-eliminazione')
        fireEvent.click(within(dialogo).getByRole('button', { name: itPrimaria.registroEliminaFirmaConferma }))
        expect((await within(dialogo).findByRole('alert')).textContent).toBe(itPrimaria.comuneErroreRete)
        expect(logClientMock.mock.calls.some(([e]) => String((e as { messaggio: string }).messaggio).startsWith('registro-firma-eliminazione-non-inviata'))).toBe(true)
    })

    it('un 404 chiude la conferma, mette il messaggio del CATALOGO sopra la griglia e rilegge', async () => {
        prepara('educator', [rigaUnica()], [
            ['DELETE /api/primaria/registro', { ok: false, status: 404, body: { error: 'Firma non trovata', codice: 'FIRMA_NON_TROVATA' } }],
        ])
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina la mia firma della 1ª ora' }))
        const primaLetture = letture()
        fireEvent.click(within(await screen.findByTestId('registro-conferma-eliminazione')).getByRole('button', { name: itPrimaria.registroEliminaFirmaConferma }))
        const esito = await screen.findByTestId('registro-esito')
        expect(esito.getAttribute('role')).toBe('alert')
        expect(esito.textContent).toBe('Questa firma non esiste più. Ricarica la pagina.')
        expect(screen.queryByTestId('registro-conferma-eliminazione')).toBeNull()
        await waitFor(() => expect(letture()).toBeGreaterThan(primaLetture))
    })
})

describe('«Elimina lezione» (Segreteria e Direzione)', () => {
    it('la Segreteria la vede; la DELETE porta `registroId` e non `firmaId`', async () => {
        prepara('segreteria', [rigaCofirmata()], [
            ['DELETE /api/primaria/registro', {
                body: { success: true, data: { eliminata: 'lezione', firmaId: null, registroId: 'reg-1', allegatiNelCestino: 0 } },
            }],
        ])
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina lezione della 1ª ora' }))
        const dialogo = await screen.findByTestId('registro-conferma-eliminazione')
        expect(within(dialogo).getByTestId('registro-avviso-lezione-sparisce').textContent).toContain('le sue 2 firme')
        fireEvent.click(within(dialogo).getByRole('button', { name: itPrimaria.registroEliminaLezioneConferma }))

        await waitFor(() => expect(delete_()).toHaveLength(1))
        const url = new URL(delete_()[0].url, 'http://x')
        expect(url.searchParams.get('registroId')).toBe('reg-1')
        expect(url.searchParams.has('firmaId')).toBe(false)
        expect((await screen.findByTestId('registro-esito')).textContent).toBe('Lezione della 1ª ora eliminata.')
    })

    it('niente «Elimina lezione» su un’ora mai firmata (non c’è la riga)', async () => {
        prepara('admin', [rigaUnica()])
        render(<RegistroPage />)
        await pronta()
        expect(await screen.findAllByRole('button', { name: /^Elimina lezione della/ })).toHaveLength(1)
        expect(screen.queryByRole('button', { name: 'Elimina lezione della 2ª ora' })).toBeNull()
    })
})

describe('voce bloccata (423) e «Sblocca»', () => {
    const bloccata = (): [string, RispostaFinta] => ['DELETE /api/primaria/registro', {
        ok: false, status: 423,
        body: { error: 'Voce bloccata: superato il termine di 2 giorni.', codice: 'VOCE_BLOCCATA', giorniLimite: 2, locked: true },
    }]

    it('la maestra vede il messaggio col termine, e NESSUN «Sblocca»', async () => {
        prepara('educator', [rigaUnica()], [bloccata()])
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina la mia firma della 1ª ora' }))
        fireEvent.click(within(await screen.findByTestId('registro-conferma-eliminazione')).getByRole('button', { name: itPrimaria.registroEliminaFirmaConferma }))

        const avviso = await screen.findByTestId('registro-voce-bloccata')
        expect(avviso.textContent).toContain('Bloccata: superato il termine di 2 giorni.')
        expect(avviso.textContent).toContain(itPrimaria.registroChiediSblocco)
        expect(within(avviso).queryByRole('button')).toBeNull()
        expect(screen.queryByTestId('registro-conferma-eliminazione'), 'Il 423 chiude la conferma.').toBeNull()
        // Il blocco scoperto al gesto (423) vale quanto quello dichiarato dalla GET:
        // il gesto destinato a fallire di nuovo non si offre più.
        expect(
            screen.queryByRole('button', { name: 'Elimina la mia firma della 1ª ora' }),
            'Dopo il 423 «Elimina la mia firma» non si offre: fallirebbe di nuovo.',
        ).toBeNull()
    })

    it('la Direzione sblocca la FIRMA come voce: il corpo porta `firma` + id, e dopo si rilegge', async () => {
        // Dopo lo sblocco la GET risponde come il server VERO su una data oltre il
        // termine: la riga d'audit della firma sblocca la firma e NON la lezione
        // (`permesso-voce` accetta per slot solo le righe `registro`). Quindi la
        // lezione resta bloccata, la firma no. Con una GET che ripetesse la riga di
        // prima il test sarebbe verde anche nascondendo il gesto per `riga.bloccata`.
        const dopoSblocco = () => {
            risposte = risposte.map(([chiave, r]) => chiave === 'GET /api/primaria/registro'
                ? [chiave, {
                    body: {
                        success: true,
                        data: {
                            giorno: 1, campanelle: CAMPANELLE, orarioCelle: ORARIO_CELLE, termine: OLTRE,
                            righe: [{ ...rigaUnica(), bloccata: true, firme_docenti: [{ ...firma('firma-1', DOCENTE, 'Ada'), bloccata: false }] }],
                        },
                    },
                }]
                : [chiave, r])
            return { body: { success: true } }
        }
        prepara('admin', [rigaUnica()], [bloccata(), ['POST /api/primaria/sblocca', dopoSblocco]])
        // L'admin firma a nome del titolare: la riga porta la firma del docente
        // collegato solo per far comparire «Elimina la mia firma».
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina la mia firma della 1ª ora' }))
        fireEvent.click(within(await screen.findByTestId('registro-conferma-eliminazione')).getByRole('button', { name: itPrimaria.registroEliminaFirmaConferma }))

        const avviso = await screen.findByTestId('registro-voce-bloccata')
        expect(avviso.textContent).not.toContain(itPrimaria.registroChiediSblocco)
        expect(
            screen.queryByRole('button', { name: 'Elimina la mia firma della 1ª ora' }),
            'Dopo il 423, prima dello sblocco, il gesto non si offre.',
        ).toBeNull()
        fireEvent.click(within(avviso).getByRole('button', { name: /Sblocca la firma della 1ª ora/ }))
        fireEvent.change(await screen.findByLabelText(itPrimaria.sbloccaMotivo), { target: { value: 'Errore di battitura segnalato' } })
        const primaLetture = letture()
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.sbloccaAutorizza }))

        await waitFor(() => expect(postSblocca()).toHaveLength(1))
        expect(JSON.parse(String(postSblocca()[0].init!.body))).toEqual({
            entitaTipo: 'firma', entitaId: 'firma-1', motivazione: 'Errore di battitura segnalato',
        })
        expect(
            (await screen.findByTestId('registro-esito')).textContent,
            'Sbloccata la sola FIRMA, l’esito non dice «ora sbloccata»: la lezione resta bloccata.',
        ).toBe('Firma della 1ª ora sbloccata: ora puoi eliminarla.')
        await waitFor(() => expect(letture()).toBeGreaterThan(primaLetture))
        // Riletta: la lezione resta bloccata (la riga ora offre «Sblocca la lezione»)…
        const avvisoDopo = await screen.findByRole('button', { name: /Sblocca la lezione della 1ª ora/ })
        expect(avvisoDopo).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Sblocca la firma della 1ª ora/ }), 'La firma non è più bloccata.').toBeNull()
        // …ma la firma è libera: il gesto sulla firma torna, quello sulla lezione no.
        expect(
            await screen.findByRole('button', { name: 'Elimina la mia firma della 1ª ora' }),
            'Sbloccata la firma, il gesto sulla firma torna anche se la lezione resta bloccata.',
        ).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Elimina lezione della 1ª ora' })).toBeNull()
    })

    it('GET in apertura: lezione bloccata e firma libera → la firma si elimina, «Elimina lezione» no', async () => {
        const riga = { ...rigaUnica(), bloccata: true, firme_docenti: [{ ...firma('firma-1', DOCENTE, 'Ada'), bloccata: false }] }
        prepara('admin', [riga], [['DELETE /api/primaria/registro', { body: { success: true } }]], OLTRE)
        stub.search = new URLSearchParams('data=2026-09-01')
        render(<RegistroPage />)
        await pronta()

        // Si aspetta una PRESENZA (l'avviso della lezione) prima di misurare le assenze.
        expect(await screen.findByRole('button', { name: /Sblocca la lezione della 1ª ora del 01\/09\/2026/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Elimina lezione della 1ª ora' }), 'La lezione è bloccata.').toBeNull()

        fireEvent.click(await screen.findByRole('button', { name: 'Elimina la mia firma della 1ª ora' }))
        fireEvent.click(within(await screen.findByTestId('registro-conferma-eliminazione')).getByRole('button', { name: itPrimaria.registroEliminaFirmaConferma }))
        await waitFor(() => expect(delete_()).toHaveLength(1))
        const url = new URL(delete_()[0].url, 'http://x')
        expect(url.searchParams.get('firmaId')).toBe('firma-1')
        expect(url.searchParams.has('registroId'), 'È la firma, non la lezione intera.').toBe(false)
    })

    it('la Direzione che elimina la lezione bloccata la sblocca come `registro` + id della riga', async () => {
        prepara('coordinator', [rigaCofirmata()], [bloccata(), ['POST /api/primaria/sblocca', { body: { success: true } }]])
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina lezione della 1ª ora' }))
        fireEvent.click(within(await screen.findByTestId('registro-conferma-eliminazione')).getByRole('button', { name: itPrimaria.registroEliminaLezioneConferma }))
        const avviso = await screen.findByTestId('registro-voce-bloccata')
        expect(
            screen.queryByRole('button', { name: 'Elimina lezione della 1ª ora' }),
            'Dopo il 423 «Elimina lezione» non si offre: fallirebbe di nuovo.',
        ).toBeNull()
        fireEvent.click(within(avviso).getByRole('button', { name: /Sblocca la lezione della 1ª ora/ }))
        fireEvent.change(await screen.findByLabelText(itPrimaria.sbloccaMotivo), { target: { value: 'Lezione doppia' } })
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.sbloccaAutorizza }))
        await waitFor(() => expect(postSblocca()).toHaveLength(1))
        expect(JSON.parse(String(postSblocca()[0].init!.body))).toMatchObject({ entitaTipo: 'registro', entitaId: 'reg-1' })
        expect(
            (await screen.findByTestId('registro-esito')).textContent,
            'Sbloccata la LEZIONE (voce `registro`), l’esito parla dell’ora, non della firma.',
        ).toBe('1ª ora sbloccata: ora puoi riprovare.')
    })

    it('ora MAI firmata respinta con 423: la riga offre alla Direzione lo sblocco per SLOT', async () => {
        prepara('admin', [rigaUnica()], [
            ['POST /api/primaria/registro', {
                ok: false, status: 423,
                body: {
                    error: 'Registrazione bloccata: superato il termine di 2 giorni. Richiedi lo sblocco al dirigente.',
                    codice: 'VOCE_BLOCCATA', giorniLimite: 2, locked: true,
                },
            }],
            ['POST /api/primaria/sblocca', { body: { success: true } }],
        ])
        stub.search = new URLSearchParams('data=2026-09-01')
        render(<RegistroPage />)
        await pronta()
        // La 2ª ora non ha riga: il bottone è «Firma».
        fireEvent.click(await screen.findByRole('button', { name: itPrimaria.registroFirma }))
        const dialogo = await screen.findByRole('dialog')
        fireEvent.change(await within(dialogo).findByLabelText(itPrimaria.firmaModalDocenteTitolare), { target: { value: COLLEGA } })
        fireEvent.change(within(dialogo).getByLabelText(itPrimaria.firmaModalArgomentoClasse), { target: { value: 'Ripasso' } })
        fireEvent.change(within(dialogo).getByLabelText(itPrimaria.firmaModalCompitiClasse), { target: { value: 'Nessuno' } })
        fireEvent.click(within(dialogo).getByRole('button', { name: itPrimaria.registroFirma }))

        expect((await within(dialogo).findByTestId('firma-bloccata-hint')).textContent).toBe(itPrimaria.firmaModalBloccataDirezione)
        expect(
            within(dialogo).getByRole('alert').textContent,
            'Il 423 porta `VOCE_BLOCCATA`: il testo viene dal catalogo, non dalla prosa italiana del server.',
        ).toBe(itShared.erroreVoceBloccata)
        fireEvent.click(within(dialogo).getByRole('button', { name: itPrimaria.firmaModalAnnulla }))

        const avviso = await screen.findByTestId('registro-voce-bloccata')
        expect(avviso.textContent, 'Il POST dichiara giorniLimite: il numero sulla riga.').toContain('Bloccata: superato il termine di 2 giorni.')
        fireEvent.click(within(avviso).getByRole('button', { name: /Sblocca l’ora: 2ª ora del 01\/09\/2026/ }))
        fireEvent.change(await screen.findByLabelText(itPrimaria.sbloccaMotivo), { target: { value: 'Maestra assente due giorni' } })
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.sbloccaAutorizza }))
        await waitFor(() => expect(postSblocca()).toHaveLength(1))
        expect(JSON.parse(String(postSblocca()[0].init!.body))).toEqual({
            entitaTipo: 'registro', sectionId: SEZIONE, data: '2026-09-01', oraLezione: 2, motivazione: 'Maestra assente due giorni',
        })
        expect(
            (await screen.findByTestId('registro-esito')).textContent,
            'Lo sblocco per SLOT è dell’ora intera: l’esito resta quello generico.',
        ).toBe('2ª ora sbloccata: ora puoi riprovare.')
    })

    it('la maestra respinta col 423 sulla firma legge «chiedi lo sblocco», e la riga non offre il comando', async () => {
        prepara('educator', [rigaUnica()], [
            ['POST /api/primaria/registro', { ok: false, status: 423, body: { error: 'Registrazione bloccata.', locked: true } }],
        ])
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(await screen.findByRole('button', { name: itPrimaria.registroFirma }))
        const dialogo = await screen.findByRole('dialog')
        fireEvent.change(within(dialogo).getByLabelText(itPrimaria.firmaModalArgomentoClasse), { target: { value: 'Ripasso' } })
        fireEvent.change(within(dialogo).getByLabelText(itPrimaria.firmaModalCompitiClasse), { target: { value: 'Nessuno' } })
        fireEvent.click(within(dialogo).getByRole('button', { name: itPrimaria.registroFirma }))
        expect((await within(dialogo).findByTestId('firma-bloccata-hint')).textContent).toBe(itPrimaria.firmaModalBloccataDocente)
        fireEvent.click(within(dialogo).getByRole('button', { name: itPrimaria.firmaModalAnnulla }))
        const avviso = await screen.findByTestId('registro-voce-bloccata')
        expect(within(avviso).queryByRole('button')).toBeNull()
    })
})

describe('«Sblocca il giorno» nella testata', () => {
    it('alla Direzione, su un giorno OLTRE il termine: il corpo è `giorno` + sezione + data', async () => {
        prepara('admin', [rigaUnica()], [['POST /api/primaria/sblocca', { body: { success: true } }]], OLTRE)
        stub.search = new URLSearchParams('data=2026-09-01')
        render(<RegistroPage />)
        await pronta()
        const testata = await screen.findByTestId('registro-sblocca-giorno')
        expect(testata.textContent).toContain(itPrimaria.registroSbloccaGiornoHint)
        fireEvent.click(within(testata).getByRole('button', { name: /Sblocca il giorno: tutto il registro di questa classe per il 01\/09\/2026/ }))
        fireEvent.change(await screen.findByLabelText(itPrimaria.sbloccaMotivo), { target: { value: 'Correzione di fine mese' } })
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.sbloccaAutorizza }))
        await waitFor(() => expect(postSblocca()).toHaveLength(1))
        expect(JSON.parse(String(postSblocca()[0].init!.body))).toEqual({
            entitaTipo: 'giorno', sectionId: SEZIONE, data: '2026-09-01', motivazione: 'Correzione di fine mese',
        })
        const esito = await screen.findByTestId('registro-esito')
        expect(esito.textContent).toContain('01/09/2026')
        expect(esito.textContent, 'Il server ora legge lo sblocco del giorno anche sulla firma.').toContain('firmare')
    })

    it('non c’è per la Segreteria né per la maestra', async () => {
        for (const ruolo of ['segreteria', 'educator']) {
            prepara(ruolo, [rigaUnica()], [], OLTRE)
            stub.search = new URLSearchParams('data=2026-09-01')
            render(<RegistroPage />)
            await pronta()
            // Il messaggio della riga bloccata dice che il termine è stato letto.
            await screen.findAllByTestId('registro-voce-bloccata')
            expect(screen.queryByTestId('registro-sblocca-giorno'), ruolo).toBeNull()
            cleanup()
            chiamate.length = 0
        }
    })

    it('non c’è su un giorno PASSATO ma ENTRO il termine (ieri, con 2 giorni): sarebbe un audit che non autorizza niente', async () => {
        prepara('admin', [rigaUnica()], [], ENTRO)
        stub.search = new URLSearchParams('data=2026-09-01')
        render(<RegistroPage />)
        await pronta()
        await screen.findAllByRole('button', { name: /^Elimina lezione della/ })
        expect(screen.queryByTestId('registro-sblocca-giorno')).toBeNull()
        expect(screen.queryByTestId('registro-voce-bloccata')).toBeNull()
    })

    it('non c’è se la GET non ha dichiarato il termine (guasto): niente bottone a caso', async () => {
        prepara('admin', [rigaUnica()])
        stub.search = new URLSearchParams('data=2026-09-01')
        render(<RegistroPage />)
        await pronta()
        await screen.findAllByRole('button', { name: /^Elimina lezione della/ })
        expect(screen.queryByTestId('registro-sblocca-giorno')).toBeNull()
    })

    it('cambiando giorno, mentre la GET del giorno nuovo è in volo, il termine VECCHIO non vale per la data NUOVA', async () => {
        // Dal 01/09 (oltre il termine) si passa al 02/09. Finché la GET del 02 non
        // risponde, `data` è già il 02 ma righe e termine erano quelli del 01: senza
        // azzerare il termine, «Sblocca il giorno» offriva il 02 deciso dal 01, e
        // gli «Sblocca» delle righe mandavano l'id del 01 con l'etichetta del 02.
        prepara('admin', [rigaUnica()], [], OLTRE)
        stub.search = new URLSearchParams('data=2026-09-01')
        const volo: { rispondi: (() => void) | null } = { rispondi: null }
        vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)
            if (url.includes('/api/primaria/registro?') && url.includes('data=2026-09-02')) {
                chiamate.push({ url, init })
                return new Promise<Response>((risolvi) => {
                    volo.rispondi = () => risolvi({
                        ok: true, status: 200,
                        json: async () => ({
                            success: true,
                            data: { giorno: 2, campanelle: CAMPANELLE, orarioCelle: ORARIO_CELLE, righe: [], termine: ENTRO },
                        }),
                    } as unknown as Response)
                })
            }
            return fetchMock(input, init)
        }))
        render(<RegistroPage />)
        await pronta()
        await screen.findByTestId('registro-sblocca-giorno')
        expect((await screen.findAllByTestId('registro-voce-bloccata')).length).toBeGreaterThan(0)

        fireEvent.click(screen.getByRole('button', { name: itShared.navigatoreDataGiornoSuccessivo }))
        // Prima una PRESENZA: la GET del giorno nuovo è partita (e non ha risposto).
        await waitFor(() => expect(chiamate.some((c) => c.url.includes('data=2026-09-02'))).toBe(true))
        expect(volo.rispondi, 'La GET del 02/09 deve essere ancora in volo.').not.toBeNull()
        expect(screen.queryByTestId('registro-sblocca-giorno'), 'Termine del 01 applicato al 02.').toBeNull()
        expect(screen.queryByTestId('registro-voce-bloccata'), 'Righe del 01 bloccate col termine del 01, a nome del 02.').toBeNull()
        expect(screen.queryByRole('button', { name: /Sblocca il giorno: .*02\/09\/2026/ })).toBeNull()

        volo.rispondi!()
        // Il 02 è entro il termine: dopo la risposta il bottone resta assente, e la
        // griglia è quella del 02 (nessuna riga scritta → nessun «Elimina lezione»).
        await waitFor(() => expect(screen.queryByRole('button', { name: /^Elimina lezione della/ })).toBeNull())
        expect(screen.queryByTestId('registro-sblocca-giorno')).toBeNull()
        expect(postSblocca()).toHaveLength(0)
    })

    it('giornata GIÀ sbloccata: niente bottone, una nota; le ore mai firmate non sono bloccate', async () => {
        prepara('admin', [rigaUnica()], [], { ...OLTRE, giornoSbloccato: true })
        stub.search = new URLSearchParams('data=2026-09-01')
        render(<RegistroPage />)
        await pronta()
        expect((await screen.findByTestId('registro-giorno-gia-sbloccato')).textContent).toBe(itPrimaria.registroGiornoGiaSbloccato)
        expect(screen.queryByTestId('registro-sblocca-giorno')).toBeNull()
        expect(screen.queryByTestId('registro-voce-bloccata')).toBeNull()
    })
})

describe('il termine dichiarato dalla GET: «Sblocca» sulla riga SENZA alcun gesto', () => {
    /** La 1ª ora scritta e bloccata (lezione e firma), la 2ª mai firmata. */
    const rigaBloccata = () => ({
        ...rigaUnica(),
        bloccata: true,
        firme_docenti: [{ ...firma('firma-1', DOCENTE, 'Ada'), bloccata: true }],
    })

    it('la Direzione apre un giorno oltre il termine e trova «Sblocca» su entrambe le ore: voce `registro` e SLOT', async () => {
        prepara('admin', [rigaBloccata()], [['POST /api/primaria/sblocca', { body: { success: true } }]], OLTRE)
        stub.search = new URLSearchParams('data=2026-09-01')
        render(<RegistroPage />)
        await pronta()

        const avvisi = await screen.findAllByTestId('registro-voce-bloccata')
        expect(avvisi, 'Un avviso per l’ora scritta e uno per quella mai firmata.').toHaveLength(2)
        expect(delete_(), 'Nessun gesto: il blocco arriva con la lettura.').toHaveLength(0)
        expect(chiamate.filter((c) => c.init?.method === 'POST')).toHaveLength(0)
        expect(avvisi[0].textContent).toContain('Bloccata: superato il termine di 2 giorni.')
        expect(avvisi[0].textContent).not.toContain(itPrimaria.registroChiediSblocco)

        // La riga bloccata non offre i gesti che risponderebbero 423.
        expect(screen.queryByRole('button', { name: 'Elimina lezione della 1ª ora' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Elimina la mia firma della 1ª ora' })).toBeNull()

        // 1ª ora (scritta) → la lezione come voce.
        fireEvent.click(within(avvisi[0]).getByRole('button', { name: /Sblocca la lezione della 1ª ora del 01\/09\/2026/ }))
        fireEvent.change(await screen.findByLabelText(itPrimaria.sbloccaMotivo), { target: { value: 'Correzione tardiva' } })
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.sbloccaAutorizza }))
        await waitFor(() => expect(postSblocca()).toHaveLength(1))
        expect(JSON.parse(String(postSblocca()[0].init!.body))).toEqual({
            entitaTipo: 'registro', entitaId: 'reg-1', motivazione: 'Correzione tardiva',
        })
    })

    it('l’ora MAI firmata si sblocca per SLOT, sempre senza provocare un 423', async () => {
        prepara('coordinator', [rigaBloccata()], [['POST /api/primaria/sblocca', { body: { success: true } }]], OLTRE)
        stub.search = new URLSearchParams('data=2026-09-01')
        render(<RegistroPage />)
        await pronta()
        const avvisi = await screen.findAllByTestId('registro-voce-bloccata')
        fireEvent.click(within(avvisi[1]).getByRole('button', { name: /Sblocca l’ora: 2ª ora del 01\/09\/2026/ }))
        fireEvent.change(await screen.findByLabelText(itPrimaria.sbloccaMotivo), { target: { value: 'Maestra assente' } })
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.sbloccaAutorizza }))
        await waitFor(() => expect(postSblocca()).toHaveLength(1))
        expect(JSON.parse(String(postSblocca()[0].init!.body))).toEqual({
            entitaTipo: 'registro', sectionId: SEZIONE, data: '2026-09-01', oraLezione: 2, motivazione: 'Maestra assente',
        })
    })

    it('la maestra vede il messaggio con «chiedi lo sblocco», e nessun bottone', async () => {
        prepara('educator', [rigaBloccata()], [], OLTRE)
        stub.search = new URLSearchParams('data=2026-09-01')
        render(<RegistroPage />)
        await pronta()
        const avvisi = await screen.findAllByTestId('registro-voce-bloccata')
        expect(avvisi).toHaveLength(2)
        for (const a of avvisi) {
            expect(a.textContent).toContain(itPrimaria.registroChiediSblocco)
            expect(within(a).queryByRole('button')).toBeNull()
        }
        expect(screen.queryByRole('button', { name: 'Elimina la mia firma della 1ª ora' })).toBeNull()
    })

    it('uno slot già sbloccato non è bloccato; la riga non bloccata offre di nuovo i gesti', async () => {
        prepara('admin', [rigaUnica()], [], { ...OLTRE, oreSbloccate: [2] })
        stub.search = new URLSearchParams('data=2026-09-01')
        render(<RegistroPage />)
        await pronta()
        expect(await screen.findByRole('button', { name: 'Elimina lezione della 1ª ora' })).toBeInTheDocument()
        expect(screen.queryByTestId('registro-voce-bloccata')).toBeNull()
    })
})
