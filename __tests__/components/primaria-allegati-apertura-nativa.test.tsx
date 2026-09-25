import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react'

import itPrimaria from '../../messages/it/teacherPrimaria.json'
import itShared from '../../messages/it/shared.json'

/**
 * R5 (spec 2026-09-24) — gli ALLEGATI della primaria, nel registro e nella linguetta
 * «Compiti», aperti anche dall'app.
 *
 * Erano `<a href={indirizzo firmato} target="_blank">`: nella WebView Capacitor
 * un'ancora così non apre niente e non lancia. Ora:
 *
 *  · WEB → l'ancora di prima: stesso `href`, nessun `preventDefault`, helper MAI chiamato;
 *  · APP → gesto di default annullato e `apriDocumento` con l'indirizzo firmato, un
 *    nome NEUTRO con estensione (niente testo libero del docente sul dispositivo),
 *    l'etichetta dei log del punto; un esito non riuscito si DICE («riprova» oppure
 *    «aggiorna l'app» sul binario 1.0), un doppio tocco non apre due anteprime, e un
 *    percorso non firmato non finisce nella `fetch` dell'helper.
 *
 * `fireEvent.click` ritorna `false` quando il gestore ha chiamato `preventDefault`:
 * è così che si distingue «l'app ha preso il gesto» da «il browser lo fa da sé».
 *
 * Rompendo il codice diventano rossi: ancora nuda al posto di `LinkAllegatoRegistro`
 * nel registro o nei compiti → i due casi d'integrazione; `preventDefault` anche sul
 * web → il caso web; nome del file caricato al posto di quello neutro → il caso dei
 * nomi; guardia del doppio tocco tolta → il caso del volo; guardia del percorso tolta
 * → il caso del percorso relativo.
 */

vi.mock('@/lib/logging/client', () => ({
    logClient: vi.fn(),
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: vi.fn(() => false) }))
vi.mock('@/lib/native/scarica', async (importOriginal) => {
    const vero = await importOriginal<typeof import('@/lib/native/scarica')>()
    return { ...vero, apriDocumento: vi.fn(async () => ({ esito: 'nativo-anteprima' })) }
})

const stub = vi.hoisted(() => ({
    params: { sectionId: 'sez-1' } as Record<string, string>,
    search: new URLSearchParams('userId=doc-1'),
}))
vi.mock('next/navigation', () => ({
    useParams: () => stub.params,
    useSearchParams: () => stub.search,
    usePathname: () => '/teacher/primaria/sez-1/compiti',
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: () => {} }),
}))
vi.mock('@/lib/auth/current-teacher', () => ({ getCurrentTeacherId: () => 'doc-1' }))

import { logClient } from '@/lib/logging/client'
import { isNativeApp } from '@/lib/push/native-register'
import { apriDocumento, type RisultatoScaricoNativo } from '@/lib/native/scarica'
import {
    LinkAllegatoRegistro,
    fileAllegatoRegistro,
    indirizzoFirmato,
} from '@/components/features/primaria/LinkAllegatoRegistro'
import { AllegatiLezione } from '@/components/features/primaria/AllegatiRegistro'
import CompitiPage from '@/app/(dashboard)/teacher/primaria/[sectionId]/compiti/page'

const nativo = vi.mocked(isNativeApp)
const apri = vi.mocked(apriDocumento)
const log = vi.mocked(logClient)

// Identificativi inventati: il repository è pubblico.
const ID = 'a1b2c3d4-0000-4000-8000-000000000001'
const FIRMATO_PNG = 'https://storage.invalid/storage/v1/object/sign/allegati/registro/r1/1700-abc.png?token=t'
const FIRMATO_PDF = 'https://storage.invalid/storage/v1/object/sign/allegati/registro/r1/1700-def.pdf?token=t'

function inVolo() {
    let risolvi!: (r: RisultatoScaricoNativo) => void
    const promessa = new Promise<RisultatoScaricoNativo>((r) => {
        risolvi = r
    })
    return { promessa, risolvi }
}

beforeEach(() => {
    vi.clearAllMocks()
    nativo.mockReturnValue(false)
    apri.mockResolvedValue({ esito: 'nativo-anteprima' })
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

function monta(href: string, allegato = { id: ID, tipo: 'pdf', file_name: 'verifica di Pinco.pdf' }) {
    render(
        <LinkAllegatoRegistro allegato={allegato} href={href} etichetta="registro-allegato" titolo="allegato" className="c">
            scheda
        </LinkAllegatoRegistro>,
    )
    return screen.getByRole('link', { name: 'scheda' })
}

describe('fileAllegatoRegistro — il nome sul dispositivo', () => {
    it('è NEUTRO (mai il nome caricato) e prende l’estensione dall’indirizzo firmato', () => {
        const f = fileAllegatoRegistro({ id: ID, tipo: 'immagine', file_name: 'verifica di Pinco.pdf' }, FIRMATO_PNG)
        expect(f).toEqual({ nomeFile: 'registro-allegato-a1b2c3d4.png', mime: 'image/png' })
        expect(f.nomeFile).not.toMatch(/Pinco|verifica/)
    })

    it('senza estensione nell’indirizzo: dal nome, poi dal tipo PDF; un’immagine ignota resta senza', () => {
        const senza = 'https://storage.invalid/sign/x?token=t'
        expect(fileAllegatoRegistro({ id: ID, tipo: 'immagine', file_name: 'lavagna.JPEG' }, senza))
            .toEqual({ nomeFile: 'registro-allegato-a1b2c3d4.jpeg', mime: 'image/jpeg' })
        expect(fileAllegatoRegistro({ id: ID, tipo: 'pdf', file_name: 'Scheda rinominata' }, senza))
            .toEqual({ nomeFile: 'registro-allegato-a1b2c3d4.pdf', mime: 'application/pdf' })
        expect(fileAllegatoRegistro({ id: ID, tipo: 'immagine', file_name: 'foto' }, senza))
            .toEqual({ nomeFile: 'registro-allegato-a1b2c3d4' })
    })

    it('un id fuori forma non entra nel nome', () => {
        expect(fileAllegatoRegistro({ id: '../../x', tipo: 'pdf', file_name: null }, FIRMATO_PDF).nomeFile)
            .toBe('registro-allegato-file.pdf')
    })

    it('indirizzoFirmato: solo http(s) assoluto', () => {
        expect(indirizzoFirmato(FIRMATO_PDF)).toBe(true)
        expect(indirizzoFirmato('registro/r1/a.pdf')).toBe(false)
        expect(indirizzoFirmato('/registro/r1/a.pdf')).toBe(false)
        expect(indirizzoFirmato(null)).toBe(false)
    })
})

describe('LinkAllegatoRegistro', () => {
    it('WEB: l’ancora di prima — stesso href, scheda nuova, nessun preventDefault, helper mai chiamato', () => {
        const link = monta(FIRMATO_PDF)
        expect(link.getAttribute('href')).toBe(FIRMATO_PDF)
        expect(link.getAttribute('target')).toBe('_blank')
        expect(link.getAttribute('rel')).toBe('noopener noreferrer')
        expect(fireEvent.click(link)).toBe(true)
        expect(apri).not.toHaveBeenCalled()
    })

    it('APP: gesto annullato e anteprima con l’indirizzo firmato, nome neutro, mime ed etichetta', async () => {
        nativo.mockReturnValue(true)
        const link = monta(FIRMATO_PDF)
        expect(fireEvent.click(link)).toBe(false)
        await waitFor(() => expect(apri).toHaveBeenCalledTimes(1))
        expect(apri).toHaveBeenCalledWith({
            sorgente: FIRMATO_PDF,
            nomeFile: 'registro-allegato-a1b2c3d4.pdf',
            mime: 'application/pdf',
            titolo: 'allegato',
            etichetta: 'registro-allegato',
        })
        // Riuscito: nessun avviso. Si aspetta prima che il volo sia finito (presenza).
        await waitFor(() => expect(link.getAttribute('aria-busy')).toBeNull())
        expect(screen.queryByRole('alert')).toBeNull()
    })

    it('APP: «non riuscito» → «riprova»; binario 1.0 → «aggiorna l’app»; foglio col link → niente', async () => {
        nativo.mockReturnValue(true)
        apri.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'http-403' })
        const link = monta(FIRMATO_PDF)
        fireEvent.click(link)
        expect((await screen.findByRole('alert')).textContent).toBe(itShared.documentoNonAperto)

        apri.mockResolvedValueOnce({ esito: 'ripiego-condivisione', motivo: 'plugin-assenti:filetransfer', binarioDaAggiornare: true })
        fireEvent.click(link)
        await waitFor(() => expect(apri).toHaveBeenCalledTimes(2))
        await waitFor(() => expect(link.getAttribute('aria-busy')).toBeNull())
        expect(screen.queryByRole('alert'), 'Il foglio col link si vede da sé: nessun avviso.').toBeNull()

        apri.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'plugin-assenti:filesystem|link-non-condivisibile', binarioDaAggiornare: true })
        fireEvent.click(link)
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(itShared.documentoAppDaAggiornare))
    })

    it('APP: un secondo tocco mentre il primo è in volo non apre una seconda anteprima', async () => {
        nativo.mockReturnValue(true)
        const volo = inVolo()
        apri.mockReturnValueOnce(volo.promessa)
        const link = monta(FIRMATO_PDF)
        fireEvent.click(link)
        expect(fireEvent.click(link), 'Anche il secondo tocco non deve navigare.').toBe(false)
        expect(apri).toHaveBeenCalledTimes(1)
        expect(link.getAttribute('aria-busy')).toBe('true')
        await act(async () => volo.risolvi({ esito: 'nativo-anteprima' }))
        await waitFor(() => expect(link.getAttribute('aria-busy')).toBeNull())
        fireEvent.click(link)
        await waitFor(() => expect(apri).toHaveBeenCalledTimes(2))
    })

    it('APP: un percorso NON firmato non va all’helper — avviso «riprova» e una riga di log', async () => {
        nativo.mockReturnValue(true)
        const link = monta('registro/r1/1700-def.pdf')
        expect(fireEvent.click(link)).toBe(false)
        expect((await screen.findByRole('alert')).textContent).toBe(itShared.documentoNonAperto)
        expect(apri).not.toHaveBeenCalled()
        expect(log).toHaveBeenCalledWith(expect.objectContaining({
            livello: 'warn',
            messaggio: 'registro-allegato-apertura-indirizzo-non-firmato',
        }))
        // Il log non porta il percorso né il nome.
        expect(JSON.stringify(log.mock.calls)).not.toMatch(/1700-def|Pinco/)
    })
})

describe('integrazione — registro e linguetta «Compiti»', () => {
    it('REGISTRO (AllegatiLezione): nell’app apre l’indirizzo FIRMATO della GET con l’etichetta del registro', async () => {
        nativo.mockReturnValue(true)
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input)
            if (url.includes('/api/primaria/allegati?')) {
                return {
                    ok: true, status: 200,
                    json: async () => ({ success: true, data: [{
                        id: ID, file_url: FIRMATO_PDF, file_name: 'scheda.pdf',
                        modificabile: false, bloccata: false, giorniLimite: 2, caricato_da: 'doc-2',
                    }] }),
                } as unknown as Response
            }
            return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) } as unknown as Response
        })
        vi.stubGlobal('fetch', fetchMock)
        render(
            <AllegatiLezione
                registroId="reg-1"
                allegati={[{ id: ID, ambito: 'argomento', tipo: 'pdf', file_url: 'registro/reg-1/1700-def.pdf', file_name: 'scheda.pdf' }]}
                userId="doc-1"
                ruolo="educator"
                versione={0}
                onCambiato={() => {}}
                onEsito={() => {}}
            />,
        )
        const riga = screen.getByTestId(`registro-allegato-${ID}`)
        await waitFor(() => expect(within(riga).getByRole('link').getAttribute('href')).toBe(FIRMATO_PDF))
        expect(fireEvent.click(within(riga).getByRole('link'))).toBe(false)
        await waitFor(() => expect(apri).toHaveBeenCalledTimes(1))
        expect(apri).toHaveBeenCalledWith(expect.objectContaining({
            sorgente: FIRMATO_PDF,
            nomeFile: 'registro-allegato-a1b2c3d4.pdf',
            etichetta: 'registro-allegato',
            titolo: itPrimaria.registroAllegato,
        }))
    })

    it('COMPITI: nell’app apre l’allegato con l’etichetta dei compiti; sul web resta l’ancora', async () => {
        const voce = {
            id: 'v1', data: '2026-09-18', ora_lezione: 1, materia: 'Italiano', compiti: 'Pagina 12',
            data_consegna_compiti: null, individualizzati: [],
            allegati: [{ id: ID, tipo: 'immagine', ambito: 'compiti', file_name: 'lavagna di Pinco.png', file_url: FIRMATO_PNG }],
        }
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true, status: 200,
            json: async () => ({ success: true, data: { compiti: [voce], prossimoCursore: null } }),
        }) as unknown as Response))
        render(<CompitiPage />)
        const link = await screen.findByRole('link', { name: /lavagna di Pinco\.png/ })
        expect(link.getAttribute('href')).toBe(FIRMATO_PNG)

        // Web: nessun preventDefault, nessun helper.
        expect(fireEvent.click(link)).toBe(true)
        expect(apri).not.toHaveBeenCalled()

        nativo.mockReturnValue(true)
        expect(fireEvent.click(link)).toBe(false)
        await waitFor(() => expect(apri).toHaveBeenCalledTimes(1))
        expect(apri).toHaveBeenCalledWith({
            sorgente: FIRMATO_PNG,
            nomeFile: 'registro-allegato-a1b2c3d4.png',
            mime: 'image/png',
            titolo: itShared.classeCompitiAllegato,
            etichetta: 'compiti-allegato',
        })
    })
})
