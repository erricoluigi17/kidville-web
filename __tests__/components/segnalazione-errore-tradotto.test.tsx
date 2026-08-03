import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

import sharedIt from '../../messages/it/shared.json'
import sharedEn from '../../messages/en/shared.json'

// =============================================================================
// LA FRASE DICHIARATA DEVE ARRIVARE A SCHERMO, ALTRIMENTI NON ESISTE.
//
// ─── IL DIFETTO (verificatore adversariale, secondo giro — 2026-08-03) ───────
// `POST /api/segnalazioni` ha imparato a rispondere 503 con
// `codice: 'SEGNALAZIONE_SENZA_PLESSO'` quando la segnalazione non si può
// attribuire a un plesso, il codice è stato dichiarato in `CODICI_ERRORE` e la
// frase tradotta in italiano e in inglese (`erroreSegnalazioneSenzaPlesso`).
// Il lock `errori-con-codice` era verde, e giustamente: il codice c'era, le due
// traduzioni pure.
//
// Solo che i due unici chiamanti — `SegnalaContenuto` (galleria e diario) e
// `ChatConversationMenu` (chat 1:1) — il corpo della risposta non lo leggevano:
// `if (!res.ok) setErrore(true)`, e a schermo usciva sempre la frase generica
// «Non è stato possibile inviare la segnalazione. Riprova.». La stringa era
// IRRAGGIUNGIBILE, in tutte e due le lingue, mentre il commento nel codice ne
// prometteva a schermo il contenuto. Nessun lock lo poteva vedere: la catena
// che si era rotta stava fra il catalogo e il componente, e nessuno la misurava.
//
// ─── PERCHÉ QUESTO FILE SA DIVENTARE ROSSO ──────────────────────────────────
// Qui non si asserisce quale funzione viene chiamata — un test così resterebbe
// verde anche invocandola e buttandone via il risultato, che in questo repo è
// già successo (`void gate`). Si legge il `role="alert"` e si confronta con la
// stringa del catalogo, nelle DUE lingue: tornando a `setErrore(true)` il testo
// diventa la frase generica e tutti i casi cadono.
//
// ─── E IL CONTROLLO CHE NON SI DEVE PERDERE ─────────────────────────────────
// La prosa del server NON deve arrivare a schermo. Su questa route comprende
// «oggetto_id obbligatorio per questo tipo di segnalazione»: testo da log, con
// il nome di un campo dentro, e italiano per costruzione. Perciò c'è un caso che
// prova il contrario di tutti gli altri — con un corpo SENZA codice si mostra la
// frase del componente, mai quella del server.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

import { SegnalaContenuto } from '@/components/features/segnalazioni/SegnalaContenuto'
import { ChatConversationMenu } from '@/components/features/chat/ChatConversationMenu'

const MEDIA = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ME = 'bbbbbbbb-0000-4000-8000-00000000000b'
const ALTRO = 'cccccccc-0000-4000-8000-00000000000c'
const THREAD = 'dddddddd-0000-4000-8000-00000000000d'
const MESSAGGIO = 'eeeeeeee-0000-4000-8000-00000000000e'

/** La prosa che il server manda accanto al codice: nasce sul server, italiana. */
const PROSA_SERVER = 'Segnalazione non registrata: non è stato possibile attribuirla a un plesso'

/** Il `lang` della radice: è ciò che `RootLayout` scrive da `getLocale()`. */
const conLingua = (lang: string) => document.documentElement.setAttribute('lang', lang)

/** La risposta che il prossimo POST /api/segnalazioni riceverà. */
let risposta: { stato: number; corpo: unknown } = { stato: 201, corpo: { ok: true } }

beforeEach(() => {
    risposta = { stato: 201, corpo: { ok: true, id: 's1' } }
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(risposta.corpo), { status: risposta.stato })),
    )
})

afterEach(() => {
    cleanup()
    conLingua('it')
})

/** Il 503 vero della route: prosa italiana + codice dichiarato. */
const senzaPlesso = () => {
    risposta = { stato: 503, corpo: { error: PROSA_SERVER, codice: 'SEGNALAZIONE_SENZA_PLESSO' } }
}

/** Apre la modale della galleria e prova a inviare; torna il `role="alert"`. */
async function segnalaDallaGalleria() {
    render(<SegnalaContenuto tipoOggetto="media_galleria" oggettoId={MEDIA} label="Segnala foto/video" />)
    fireEvent.click(screen.getByRole('button', { name: 'Segnala foto/video' }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(sharedIt.segnalaInvia) }))
    return waitFor(() => screen.getByRole('alert'))
}

/** Come sopra, ma dal menu ⋮ della chat (segnala messaggio). */
async function segnalaDallaChat() {
    const etichette: Record<string, string> = {
        ugcMenuLabel: 'Opzioni conversazione',
        ugcReportMessage: 'Segnala messaggio',
        ugcReportUser: 'Segnala utente',
        ugcReportMessageTitle: 'Segnala messaggio',
        ugcReportUserTitle: 'Segnala utente',
        ugcSuspend: 'Sospendi conversazione',
    }
    render(
        <ChatConversationMenu
            t={(k: string) => etichette[k] ?? k}
            currentUserId={ME}
            threadId={THREAD}
            controparteId={ALTRO}
            lastIncomingMessageId={MESSAGGIO}
            isSuspended={false}
            onSuspended={vi.fn()}
        />,
    )
    fireEvent.click(screen.getByLabelText('Opzioni conversazione'))
    fireEvent.click(screen.getByText('Segnala messaggio'))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(sharedIt.segnalaInvia) }))
    return waitFor(() => screen.getByRole('alert'))
}

describe('segnalazione rifiutata — la frase del codice arriva davvero a schermo', () => {
    it('galleria/diario, interfaccia ITALIANA: si legge la frase del codice, non quella generica', async () => {
        conLingua('it')
        senzaPlesso()

        const avviso = await segnalaDallaGalleria()

        expect(avviso.textContent).toBe(sharedIt.erroreSegnalazioneSenzaPlesso)
        // L'asserzione che misura il difetto: non è più il messaggio generico.
        expect(avviso.textContent).not.toBe(sharedIt.segnalaErrore)
    })

    it('galleria/diario, interfaccia INGLESE: la stessa risposta dà il testo del catalogo EN', async () => {
        conLingua('en')
        senzaPlesso()

        const avviso = await segnalaDallaGalleria()

        expect(avviso.textContent).toBe(sharedEn.erroreSegnalazioneSenzaPlesso)
        // …e soprattutto NON la prosa italiana che il server manda accanto.
        expect(avviso.textContent).not.toBe(PROSA_SERVER)
        expect(avviso.textContent).not.toMatch(/plesso/i)
    })

    it('chat 1:1, interfaccia INGLESE: stesso codice, stessa frase (i due ingressi non divergono)', async () => {
        // I due componenti chiamano la stessa route: se uno dei due tornasse a
        // ignorare il corpo, l'utente vedrebbe due messaggi diversi per lo
        // stesso rifiuto — che è il modo in cui una regola scritta in due posti
        // comincia a non essere più una regola.
        conLingua('en')
        senzaPlesso()

        const avviso = await segnalaDallaChat()

        expect(avviso.textContent).toBe(sharedEn.erroreSegnalazioneSenzaPlesso)
    })

    it('chat 1:1, interfaccia ITALIANA: la frase del catalogo IT', async () => {
        conLingua('it')
        senzaPlesso()

        const avviso = await segnalaDallaChat()

        expect(avviso.textContent).toBe(sharedIt.erroreSegnalazioneSenzaPlesso)
    })

    it('CONTROLLO NEGATIVO — un rifiuto SENZA codice non porta a schermo la prosa del server', async () => {
        // Il 400 «oggetto_id obbligatorio per questo tipo di segnalazione» è
        // testo da log: davanti a un genitore non deve arrivare mai, e in
        // un'interfaccia inglese sarebbe anche italiano. Qui si mostra la frase
        // del componente, che passa da `useTranslations` ed è tradotta.
        conLingua('en')
        risposta = { stato: 400, corpo: { error: 'oggetto_id obbligatorio per questo tipo di segnalazione' } }

        const avviso = await segnalaDallaGalleria()

        expect(avviso.textContent).not.toMatch(/oggetto_id/)
        // Il mock di next-intl risolve sempre sull'italiano: qui si misura che
        // la frase è QUELLA DEL COMPONENTE (`t('segnalaErrore')`) e non il corpo
        // del server. La lingua di questa frase la garantisce next-intl, non noi.
        expect(avviso.textContent).toBe(sharedIt.segnalaErrore)
    })

    it('CONTROLLO NEGATIVO — corpo non-JSON: resta la frase del componente, mai la stringa vuota', async () => {
        conLingua('it')
        vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })))

        const avviso = await segnalaDallaGalleria()

        expect(avviso.textContent).toBe(sharedIt.segnalaErrore)
    })
})
