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

/**
 * I millisecondi CHIESTI a `AbortSignal.timeout` durante `lavoro`.
 *
 * Serve perché il tetto non si può misurare a orologio, qui: `fetch` è un mock che risponde
 * subito e i timer sono finti. Guardare solo che `init.signal` sia un `AbortSignal` — che è
 * ciò che questo file faceva — non dice NIENTE su quanto valga: con `TETTO_MS` portato da
 * 5.000 a 600.000 ogni test restava verde, e il fallback locale, che ha la risposta pronta e
 * senza rete, non sarebbe partito per dieci minuti.
 */
async function tettiChiesti(lavoro: () => Promise<unknown>): Promise<number[]> {
    const originale = AbortSignal.timeout
    const chiesti: number[] = []
    AbortSignal.timeout = ((ms: number) => {
        chiesti.push(ms)
        return originale.call(AbortSignal, ms)
    }) as typeof AbortSignal.timeout
    try {
        await lavoro()
    } finally {
        AbortSignal.timeout = originale
    }
    return chiesti
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

    /**
     * IL TETTO DI TEMPO, ed è la terza strada dello stesso difetto.
     *
     * `fetch` non ha nessun timeout di suo: un bersaglio che ACCETTA la connessione e tace la
     * tiene appesa senza eccezione — misurato altrove in questo repo, 150 secondi. Qui il costo
     * è peculiare e peggiore che altrove: il fallback locale (`codice-fiscale-js`, in bundle)
     * calcola lo STESSO codice senza far uscire niente dal dispositivo e senza rete, ma sta
     * DOPO la chiamata esterna. Senza tetto non parte mai: il genitore guarda un campo che non
     * si compila mentre la risposta giusta era già dentro l'applicazione.
     *
     * È lo stesso meccanismo di `src/lib/logging/tetto.ts` — quello che copre i provider
     * server-side e le chiamate a Supabase. Tre strade, una primitiva sola: è la lezione che
     * questo ciclo ha pagato due volte.
     */
    it('IL TETTO: la chiamata parte con una scadenza, e il NUMERO è quello di chi sta aspettando', async () => {
        rete.mockResolvedValue(new Response('{"codice_fiscale":"BLLRRA19E43E054O"}', {
            status: 200, headers: { 'content-type': 'application/json' },
        }))

        const chiesti = await tettiChiesti(() => completa(fetchFiscalCode(PARAMS)))

        const init = rete.mock.calls[0][1] as RequestInit
        expect(init.signal).toBeInstanceOf(AbortSignal)
        expect(init.signal!.aborted).toBe(false)
        expect(init.method).toBe('POST') // e l'init vero non si perde per strada

        // ⚠️ E QUANTO VALE, che è la metà che mancava. Le due sponde sono ANCORAGGI ASSOLUTI,
        // non ricopiature della costante: se un giorno `TETTO_MS` diventasse dieci minuti, il
        // test lo direbbe invece di seguirlo.
        //  · sotto i 10 s perché lato browser il tetto deve essere PIÙ STRETTO di quello dei
        //    provider server-side: lì c'è un'operazione da salvare, qui c'è una persona che
        //    guarda un campo vuoto e un fallback locale che risponde all'istante;
        //  · sopra il secondo perché una risposta lenta ma VERA — rete mobile, primo colpo a
        //    freddo — deve poter arrivare: un tetto troppo stretto è l'altro modo di sbagliare.
        expect(chiesti).toHaveLength(1)
        expect(chiesti[0], 'il tetto è più largo di quello dei provider server-side').toBeLessThan(10_000)
        expect(chiesti[0], 'il tetto taglia anche le risposte lente ma vere').toBeGreaterThanOrEqual(1_000)
    })

    it('una SCADENZA resta distinguibile da una rete morta, e il fallback locale risponde lo stesso', async () => {
        rete.mockRejectedValue(
            new DOMException('The operation was aborted due to timeout', 'TimeoutError'))

        // Il codice arriva comunque: è il fallback locale, che di rete non ha bisogno.
        const chiesti = await tettiChiesti(async () => {
            expect(await completa(fetchFiscalCode(PARAMS))).toBe('RSSMRA19E43H501K')
        })

        const m = messaggio()
        // «non risponde» si ripara chiamando il fornitore, «non si raggiunge» sul DNS: con una
        // riga sola sarebbero di nuovo indistinguibili, che è il difetto di partenza del file.
        expect(m).toContain('scaduta')
        expect(m).not.toContain('non-raggiungibile')
        // IL NUMERO NELLA RIGA È QUELLO DELLA VALVOLA, non una cifra scritta a mano lì accanto:
        // «scaduta» senza il tetto non distingue «il provider è morto» da «il tetto è troppo
        // stretto», e un numero SBAGLIATO manda a cercare la seconda quando è vera la prima.
        //
        // ⚠️ I DELIMITATORI SERVONO DA TUTTE E DUE LE PARTI. `toContain(`${chiesti[0]}ms`)`
        // legava sì il numero al valore SPIATO, ma senza confini: con
        // `oltre-${TETTO_MS * 3}ms` nel messaggio, «15000ms» CONTIENE «5000ms» e il test
        // restava verde su una riga che dichiara un tetto tre volte più largo di quello
        // scattato. Il pezzo di stringa qui sotto è chiuso a sinistra da `-oltre-` e a destra
        // da `-uso-fallback`: un numero diverso non ci sta dentro in nessun modo.
        expect(chiesti).toHaveLength(1)
        expect(m).toContain(`-oltre-${chiesti[0]}ms-uso-fallback`)
        // E nessun dato del minore, come su ogni altro ramo.
        expect(m).not.toContain('Aurora')
        expect(m).not.toContain('Bellandi')
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

    /**
     * SI MASCHERA PRIMA, SI TRONCA DOPO.
     *
     * `mascheraDati` tagliava a 300 caratteri PRIMA di sostituire i valori: un
     * cognome spezzato a metà dal taglio non veniva più riconosciuto e restava in
     * chiaro nella coda del messaggio. È esattamente il caso limite che
     * `sanificaMessaggio` in `serialize.ts` risolve nell'ordine giusto, con quel
     * commento («al contrario, un taglio a metà di un'email ne lascerebbe in
     * chiaro il primo pezzo, che è quello con nome e cognome») — la stessa regola
     * scritta due volte e applicata bene una volta sola.
     *
     * Non è teorico: un corpo d'errore di un validatore che elenca i campi
     * rifiutati supera i 300 caratteri con facilità, e il cognome di un minore è
     * proprio ciò che ci finisce dentro.
     */
    it('un cognome che cade a cavallo del taglio dei 300 caratteri non resta in chiaro', async () => {
        // Il corpo è `{"error":"` (10 caratteri) + riempimento: con 286 di
        // riempimento il cognome inizia al carattere 296 e finisce oltre il taglio
        // dei 300 — cioè cade ESATTAMENTE a cavallo. Il numero non è decorativo:
        // con un riempimento qualunque il taglio butterebbe via il cognome intero
        // e il test passerebbe senza aver misurato niente.
        const riempimento = 'x'.repeat(286)
        rete.mockResolvedValue(new Response(
            `{"error":"${riempimento}Bellandi non valido, nome Aurora"}`,
            { status: 422, headers: { 'content-type': 'application/json' } },
        ))

        await completa(fetchFiscalCode(PARAMS))

        const m = messaggio()
        expect(m).toContain('422')
        // CONTROLLO POSITIVO: il taglio è davvero caduto lì dentro, altrimenti
        // questa asserzione misurerebbe un caso che non si è verificato.
        expect(m).toContain('xxxx')
        expect(m).not.toContain('Bellandi')
        expect(m).not.toContain('Bell')
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
