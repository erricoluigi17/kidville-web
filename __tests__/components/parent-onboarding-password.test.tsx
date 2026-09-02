import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

import { CASI_PASSWORD } from '../helpers/casi-password'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import { LUNGHEZZA_MINIMA_PASSWORD, valutaPasswordNuova } from '@/lib/auth/regole-password'
import itShared from '../../messages/it/shared.json'
import enShared from '../../messages/en/shared.json'
import itForms from '../../messages/it/parentForms.json'
import enForms from '../../messages/en/parentForms.json'

/**
 * LA SCHERMATA DELL'ONBOARDING E IL SERVER DANNO LO STESSO VERDETTO, E LO DICONO.
 *
 * ─── IL DIFETTO ─────────────────────────────────────────────────────────────
 *
 * Il 2026-09-01 la regola della password è stata portata in un posto solo
 * (`@/lib/auth/regole-password`: dieci caratteri, una lettera e una cifra, niente
 * spazi ai bordi) e la route è stata allineata. La SCHERMATA no: si fermava a
 * `password.length < 8`. Da lì in avanti un genitore che scriveva nove caratteri
 * — o dieci senza cifre — passava il controllo del client, vedeva partire la
 * richiesta e riceveva un rifiuto.
 *
 * E il rifiuto non diceva niente. Quella pagina passa da `soloCatalogoDaCorpo`,
 * che mostra la prosa del server MAI e il catalogo solo quando la risposta porta
 * un `codice`: senza codice, il genitore leggeva «Operazione non riuscita.
 * Riprova.» davanti a una password che poteva correggere in tre secondi, se solo
 * qualcuno gliel'avesse detto.
 *
 * ─── COSA MISURA QUESTO FILE ────────────────────────────────────────────────
 *
 *  1. Il verdetto: per gli stessi input, il client rifiuta ciò che il server
 *     rifiuta e accetta ciò che il server accetta (`CASI_PASSWORD`, la stessa
 *     tabella che attraversa `__tests__/api/parent-onboarding.test.ts`).
 *  2. Il MESSAGGIO: quello che si legge è la frase del codice, non il generico.
 *     Un test che si accontentasse di «non chiama fetch» sarebbe verde anche sul
 *     difetto peggiore dei due — il rifiuto muto.
 *  3. Che la password resti FACOLTATIVA: chi accetta solo i consensi passa.
 */

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => '/parent/onboarding',
}))

vi.mock('@/lib/auth/use-session-identity', () => ({
    useSessionIdentity: () => ({ userId: 'p1', role: 'genitore', ready: true }),
}))

import ParentOnboardingPage from '@/app/(dashboard)/parent/onboarding/page'

const IT = itShared as Record<string, string>
const EN = enShared as Record<string, string>
const IT_FORMS = itForms as Record<string, string>
const EN_FORMS = enForms as Record<string, string>

const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, onboarded: true }) }))

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    document.documentElement.setAttribute('lang', 'it')
})

afterEach(() => {
    cleanup()
    document.documentElement.removeAttribute('lang')
})

/**
 * Il campo password, cercato per la sua ETICHETTA — che è il modo in cui lo trova
 * chi usa uno screen reader, e quindi l'unico che prova che l'etichetta è collegata.
 *
 * L'etichetta si legge dal catalogo (mai ricopiata qui) e si cita ALLA LETTERA: senza
 * l'escape, le parentesi di «Nuova password (opzionale)» sono un gruppo di cattura e
 * la ricerca fallisce su un campo che c'è.
 */
const campoPassword = (): HTMLElement =>
    screen.getByLabelText(new RegExp(IT_FORMS.passwordLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))

/** Compila il modulo: i due consensi obbligatori e (se c'è) la password. */
function compila(scritta: string | null): void {
    render(<ParentOnboardingPage />)
    const [privacy, termini] = screen.getAllByRole('checkbox')
    fireEvent.click(privacy)
    fireEvent.click(termini)
    if (scritta !== null) fireEvent.change(campoPassword(), { target: { value: scritta } })
    fireEvent.click(screen.getByRole('button'))
}

describe('onboarding genitore — il client giudica la password con la REGOLA CONDIVISA', () => {
    for (const caso of CASI_PASSWORD) {
        it(`«${caso.scritta}» → ${caso.atteso} (${caso.perche})`, async () => {
            // La tabella è ancorata alla regola vera: se `valutaPasswordNuova` cambia
            // idea, il caso qui sotto diventa rosso invece di misurare un'attesa
            // scritta a mano che nessuno ha più riletto.
            const regola = valutaPasswordNuova(caso.scritta)
            expect(regola.ok ? 'OK' : regola.codice).toBe(caso.atteso)

            // La stringa vuota, nel modulo, è «nessuna password»: la si esercita nel
            // test dedicato qui sotto, perché il campo facoltativo non la giudica.
            if (caso.scritta === '') return

            compila(caso.scritta)

            if (caso.atteso === 'OK') {
                await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
                const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
                expect(JSON.parse(String(init.body)).password).toBe(caso.scritta)
                return
            }

            // Il rifiuto DICE cosa correggere: la frase del codice, non «operazione
            // non riuscita». È la metà del difetto che «non chiama fetch» non vede.
            const atteso = IT[CODICI_ERRORE[caso.atteso]]
            expect(atteso, `manca la voce di catalogo per ${caso.atteso}`).toBeTruthy()
            await waitFor(() => expect(screen.getByText(atteso)).toBeInTheDocument())
            expect(screen.queryByText(IT_FORMS.erroreOperazione)).not.toBeInTheDocument()
            expect(fetchMock, 'la richiesta è partita su una password che il server rifiuterà').not.toHaveBeenCalled()
        })
    }

    it('senza password si passa lo stesso: il campo è FACOLTATIVO', async () => {
        compila(null)
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
        const body = JSON.parse(String(init.body))
        expect(body.consensi).toMatchObject({ privacy: true, termini: true })
        expect(body.password).toBeUndefined()
    })

    it('il campo lasciato vuoto vale «nessuna password», non «password troppo corta»', async () => {
        compila('')
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).password).toBeUndefined()
    })

    it('il messaggio segue la lingua dell’interfaccia (è il motivo per cui passa da un CODICE)', async () => {
        // Il difetto T10-F1: la prosa del server nasce dove il locale non esiste. Qui
        // il testo non viene dal server affatto — ma deve seguire la stessa strada,
        // altrimenti una famiglia con l'app in inglese torna a leggere l'italiano.
        document.documentElement.setAttribute('lang', 'en')
        compila('abcdefg12')
        await waitFor(() => expect(screen.getByText(EN.errorePasswordTroppoCorta)).toBeInTheDocument())
        expect(screen.queryByText(IT.errorePasswordTroppoCorta)).not.toBeInTheDocument()
    })
})

describe('onboarding genitore — i requisiti si leggono PRIMA di sbagliare', () => {
    it('la schermata dichiara i tre requisiti accanto al campo', () => {
        render(<ParentOnboardingPage />)
        const requisiti = screen.getByText(IT_FORMS.passwordRequisiti)
        expect(requisiti).toBeInTheDocument()
        // E il campo li nomina, altrimenti chi usa uno screen reader non li incontra.
        expect(campoPassword()).toHaveAttribute('aria-describedby', requisiti.id)
    })

    it('i tre requisiti sono TUTTI dichiarati, in entrambe le lingue', () => {
        for (const [dove, testo] of [
            ['it', IT_FORMS.passwordRequisiti],
            ['en', EN_FORMS.passwordRequisiti],
        ] as const) {
            expect(testo, `manca passwordRequisiti in ${dove}`).toBeTruthy()
            expect(testo, `${dove}: manca il minimo`).toContain(String(LUNGHEZZA_MINIMA_PASSWORD))
            expect(testo, `${dove}: manca il requisito della cifra`).toMatch(/cifra|digit/i)
            expect(testo, `${dove}: manca il requisito degli spazi`).toMatch(/spazio|space/i)
        }
        expect(EN_FORMS.passwordRequisiti).not.toBe(IT_FORMS.passwordRequisiti)
    })

    it('il minimo scritto nei cataloghi è quello VERO, in entrambe le lingue', () => {
        // Il numero è per forza copiato — un catalogo è JSON e non importa una
        // costante. Copiato e non sorvegliato è però il difetto di partenza con un
        // file in più: qui le copie si confrontano con l'originale.
        const n = String(LUNGHEZZA_MINIMA_PASSWORD)
        for (const [dove, testo] of [
            ['it/shared', IT[CODICI_ERRORE.PASSWORD_TROPPO_CORTA]],
            ['en/shared', EN[CODICI_ERRORE.PASSWORD_TROPPO_CORTA]],
            ['it/parentForms → passwordPlaceholder', IT_FORMS.passwordPlaceholder],
            ['en/parentForms → passwordPlaceholder', EN_FORMS.passwordPlaceholder],
        ] as const) {
            expect(testo, `${dove} non nomina il minimo (${n})`).toContain(n)
        }
        // Controllo positivo: il vecchio 8 non è rimasto da nessuna parte.
        for (const testo of [
            IT[CODICI_ERRORE.PASSWORD_TROPPO_CORTA],
            EN[CODICI_ERRORE.PASSWORD_TROPPO_CORTA],
            IT_FORMS.passwordPlaceholder,
            EN_FORMS.passwordPlaceholder,
            IT_FORMS.passwordRequisiti,
            EN_FORMS.passwordRequisiti,
        ]) {
            expect(testo).not.toMatch(/\b8\b/)
        }
    })
})

describe('i codici della password sono dichiarati e traducibili', () => {
    it('ogni codice della regola condivisa è un codice d’errore dichiarato e tradotto', () => {
        // È il ponte che tiene in piedi la pagina: `soloCatalogoDaCorpo` traduce un
        // codice solo se è in `CODICI_ERRORE`. Un codice della regola che non fosse
        // dichiarato ricadrebbe sul messaggio generico — cioè sul difetto di partenza,
        // con l'aria di essere chiuso.
        for (const caso of CASI_PASSWORD) {
            if (caso.atteso === 'OK') continue
            const chiave = (CODICI_ERRORE as Record<string, string>)[caso.atteso]
            expect(chiave, `${caso.atteso} non è dichiarato in CODICI_ERRORE`).toBeTruthy()
            expect(IT[chiave]?.trim(), `${caso.atteso} senza voce italiana`).toBeTruthy()
            expect(EN[chiave]?.trim(), `${caso.atteso} senza voce inglese`).toBeTruthy()
            expect(EN[chiave], `${caso.atteso}: l’inglese è un copia-incolla dell’italiano`).not.toBe(IT[chiave])
        }
    })

    it('anche il quarto motivo — «uguale alla precedente» — ha la sua frase', () => {
        // Da questa route non può uscire (l'onboarding non conosce nessuna password
        // precedente), ma il vocabolario è chiuso e la schermata di cambio password
        // che verrà lo userà: dichiararlo adesso è ciò che le evita di scoprire a
        // rilascio fatto che quel rifiuto non ha una frase.
        for (const cat of [IT, EN]) {
            expect(cat[CODICI_ERRORE.PASSWORD_UGUALE_ALLA_PRECEDENTE]?.trim()).toBeTruthy()
        }
    })
})
