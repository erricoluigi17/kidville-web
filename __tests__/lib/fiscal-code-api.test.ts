import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * `src/lib/utils/fiscalCodeApi.ts` — il calcolo del codice fiscale, e il servizio TERZO
 * che riceve nome, cognome, sesso, data e comune di nascita di un bambino.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL DIFETTO. Sul ramo `!res.ok` il codice non leggeva NÉ LO STATUS NÉ IL CORPO: lanciava
 * un `new Error('API non disponibile o errore di validazione')` e il log finale diceva
 * `cf-api-esterna-non-raggiungibile-uso-fallback: Error`. Un 403 del provider (chiave
 * revocata, quota esaurita, dominio non autorizzato) era quindi INDISTINGUIBILE da un DNS
 * morto — che è la forma esatta del guasto storico di questo progetto: per mesi nessuna
 * email è arrivata perché si loggava `403` senza il corpo che diceva perché. Qui la
 * fortuna è che esiste un fallback locale che funziona: il guasto non si vede proprio
 * perché non fa danno, e quindi può durare per sempre.
 *
 * LA TENSIONE, e come si scioglie. La regola 3 di AGENTS.md dice che il corpo dell'errore
 * di un provider non si butta MAI via; la regola 8 dice che nei log non finiscono dati
 * personali — e qui i parametri della richiesta SONO i dati di un minore, che il provider
 * può rimandare indietro dentro il suo messaggio d'errore. Si tengono entrambe: il corpo
 * si logga, ma i valori che abbiamo appena spedito noi non possono tornare indietro.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

const righe: Array<Record<string, unknown>> = []

vi.mock('@/lib/logging/client', async (importOriginal) => {
    const vero = await importOriginal<typeof import('@/lib/logging/client')>()
    return {
        ...vero,
        logClient: (e: Record<string, unknown>) => { righe.push(e) },
    }
})

// La libreria locale del fallback: mockata perché qui si collauda l'OSSERVABILITÀ della
// chiamata esterna, non la tabella dei comuni italiani.
vi.mock('codice-fiscale-js', () => ({
    default: class {
        code = 'RSSMRA19E43H501K'
        constructor(_: unknown) { void _ }
    },
}))

import { fetchFiscalCode, type FiscalCodeParams } from '@/lib/utils/fiscalCodeApi'

/** Dati inventati, ma della forma esatta di quelli veri: è il punto del test sulla privacy. */
const PARAMS: FiscalCodeParams = {
    nome: 'Aurora',
    cognome: 'Bellandi',
    sesso: 'F',
    data_nascita: '2019-05-03',
    comune_nascita: 'Giugliano in Campania',
    provincia_nascita: 'NA',
}

let rete: ReturnType<typeof vi.fn>

/** Il messaggio dell'unica riga di log emessa dalla chiamata esterna. */
function messaggio(): string {
    const riga = righe.find((r) => String(r.messaggio).startsWith('cf-api-esterna'))
    if (riga === undefined) throw new Error(`nessuna riga cf-api-esterna: ${JSON.stringify(righe)}`)
    return String(riga.messaggio)
}

/** Fa scadere il ritardo di 600 ms del fallback senza aspettarlo davvero. */
async function completa(p: Promise<string>): Promise<string> {
    await vi.advanceTimersByTimeAsync(1_000)
    return await p
}

beforeEach(() => {
    righe.length = 0
    rete = vi.fn()
    vi.stubGlobal('fetch', rete)
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe('fetchFiscalCode — il provider esterno non fallisce più in silenzio', () => {
    it('un 403 si riconosce dal log: c’è lo STATUS e c’è il CORPO', async () => {
        rete.mockResolvedValue(new Response('{"error":"api key revoked or quota exceeded"}', {
            status: 403,
            headers: { 'content-type': 'application/json' },
        }))

        await completa(fetchFiscalCode(PARAMS))

        const m = messaggio()
        expect(m).toContain('403')
        expect(m).toContain('quota exceeded')
    })

    it('una rete morta resta DISTINGUIBILE da un 403: nessuno status, la classe dell’errore', async () => {
        // È la distinzione che il codice di prima non permetteva: entrambi i casi finivano
        // nella stessa riga, «...-uso-fallback: Error».
        rete.mockRejectedValue(new TypeError('Failed to fetch'))

        await completa(fetchFiscalCode(PARAMS))

        const m = messaggio()
        expect(m).toContain('non-raggiungibile')
        expect(m).toContain('TypeError')
        expect(m).not.toContain('403')
    })

    it('i dati del minore NON tornano indietro nel log, nemmeno se il provider li rimanda nel corpo', async () => {
        // Il caso che rende la regola 3 pericolosa qui: il corpo d'errore di un servizio di
        // validazione ECHEGGIA quasi sempre l'input che ha rifiutato.
        rete.mockResolvedValue(new Response(
            '{"error":"comune non valido: Giugliano in Campania (NA) per Aurora Bellandi, nata il 2019-05-03"}',
            { status: 422, headers: { 'content-type': 'application/json' } },
        ))

        await completa(fetchFiscalCode(PARAMS))

        const m = messaggio()
        // Lo status e la forma dell'errore restano: è ciò che serve a diagnosticare.
        expect(m).toContain('422')
        expect(m).toContain('comune non valido')
        // Il dato no.
        expect(m).not.toContain('Aurora')
        expect(m).not.toContain('Bellandi')
        expect(m).not.toContain('Giugliano')
        expect(m).not.toContain('2019-05-03')
    })

    it('la chiamata al servizio terzo resta: il fallback locale calcola comunque il codice', async () => {
        rete.mockResolvedValue(new Response('nope', { status: 500 }))

        const cf = await completa(fetchFiscalCode(PARAMS))

        expect(cf).toBe('RSSMRA19E43H501K')
        expect(rete).toHaveBeenCalledTimes(1)
        expect(String(rete.mock.calls[0][0])).toContain('api.codicefiscale.it')
    })

    it('il percorso felice non logga niente e non aspetta il fallback', async () => {
        rete.mockResolvedValue(new Response('{"codice_fiscale":"BLLRAU19E43E054X"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }))

        expect(await fetchFiscalCode(PARAMS)).toBe('BLLRAU19E43E054X')
        expect(righe).toHaveLength(0)
    })

    it('un 200 senza codice fiscale non è un successo, e il log lo dice — senza il corpo', async () => {
        // Il corpo di una risposta RIUSCITA contiene il codice fiscale del bambino: quello
        // non si logga mai, nemmeno quando la risposta è malformata.
        rete.mockResolvedValue(new Response('{"codice_fiscale":"BLLRAU19E43E054X","nome":"Aurora"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }))
        // ...ma se il campo atteso manca, il fallback deve partire e la cosa va detta.
        rete.mockResolvedValue(new Response('{"status":"ok"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }))

        await completa(fetchFiscalCode(PARAMS))

        const m = messaggio()
        expect(m).toContain('senza-codice')
        expect(m).not.toContain('ok')
    })
})
