import { describe, it, expect, afterEach } from 'vitest'
import { erroreDaRisposta } from '@/lib/ui/esito-fetch'
import itShared from '../../../messages/it/shared.json'
import enShared from '../../../messages/en/shared.json'

// =============================================================================
// QUANDO IL SERVER RISPONDE SENZA CORPO, LO STATUS È L'UNICA COSA CHE RESTA — e si
// buttava via (R17 del quinto collaudo).
//
// La forma diffusa nelle schermate delle famiglie era:
//
//     if (!r.ok) { const corpo = await r.json(); … segnala('invio-respinto', r.status) }
//
// e presuppone che ogni risposta d'errore porti un corpo JSON. È vero per i rifiuti
// che la rotta scrive di suo pugno, NON per gli errori che nascono fuori dall'handler:
// il 500 di Next per un handler che non restituisce una Response (misurato: 73
// richieste, `Transfer-Encoding: chunked` e ZERO byte), un 502/504 di un proxy, una
// risposta troncata. Lì `await r.json()` lancia dentro il `try`, l'eccezione salta al
// `catch` esterno — scritto per la RETE CADUTA — e il numero di stato, che il codice
// aveva in mano un istante prima, sparisce prima di arrivare al log.
//
// Il risultato misurato: a schermo il messaggio del ramo sbagliato («non sappiamo se
// l'assenza è stata registrata») e in `app_log` `invio-non-riuscito` con `stato`
// indefinito invece di `invio-respinto` con il 500. Chi indaga dal log non sa nemmeno
// che il server ha risposto.
//
// È il rovescio esatto della regola che questo repo si è già dato per i provider
// esterni («loggare uno status senza il corpo è il bug»): qui si perde lo status
// perché il corpo non si è potuto leggere.
// =============================================================================

/** Una `Response` finta come quella che arriva da `fetch`. `corpo` assente = 0 byte. */
function risposta(stato: number, corpo?: unknown): Response {
    return {
        ok: stato >= 200 && stato < 300,
        status: stato,
        json: async () => {
            if (corpo === undefined) throw new SyntaxError('Unexpected end of JSON input')
            return corpo
        },
    } as unknown as Response
}

function conLingua(lang: string) {
    document.documentElement.setAttribute('lang', lang)
}

afterEach(() => {
    document.documentElement.setAttribute('lang', 'it')
})

describe('erroreDaRisposta — lo status non si perde mai', () => {
    it('500 con CORPO VUOTO: lo stato resta, il testo è quello del componente', async () => {
        // La risposta vera misurata in produzione: 500, corpo di 0 byte.
        const e = await erroreDaRisposta(risposta(500), 'Non è stato possibile comunicare l\'assenza.')

        expect(
            e.stato,
            'lo status è stato buttato via: nel log il rifiuto diventa indistinguibile da una rete caduta',
        ).toBe(500)
        expect(e.testo).toBe('Non è stato possibile comunicare l\'assenza.')
        expect(e.codice).toBeNull()
        // «Il corpo non si è potuto leggere» è un fatto diverso da «il server ha
        // rifiutato dicendo perché», e chi logga deve poterli distinguere.
        expect(e.corpoLetto).toBe(false)
    })

    it('NON lancia: è la ragione per cui esiste (`await r.json()` su un corpo vuoto lancia)', async () => {
        // La prova del meccanismo, senza mock: è il comportamento vero di Response.
        await expect(new Response('', { status: 500 }).json()).rejects.toThrow()
        await expect(erroreDaRisposta(new Response('', { status: 500 }), 'ripiego')).resolves.toMatchObject({
            stato: 500,
            testo: 'ripiego',
        })
    })

    it('corpo NON JSON (l\'HTML d\'errore di un proxy): stato conservato, nessuna eccezione', async () => {
        const html = new Response('<html><body>504 Gateway Time-out</body></html>', { status: 504 })
        const e = await erroreDaRisposta(html, 'ripiego')

        expect(e.stato).toBe(504)
        expect(e.testo).toBe('ripiego')
        expect(e.corpoLetto).toBe(false)
    })

    it('rifiuto con codice dichiarato: il testo viene dal catalogo e il codice resta leggibile', async () => {
        const e = await erroreDaRisposta(
            risposta(409, { error: 'Assenza già registrata', codice: 'ASSENZA_GIA_REGISTRATA' }),
            'ripiego',
        )

        expect(e.stato).toBe(409)
        expect(e.codice).toBe('ASSENZA_GIA_REGISTRATA')
        expect(e.testo).toBe(itShared.erroreAssenzaGiaRegistrata)
        expect(e.corpoLetto).toBe(true)
    })

    it('interfaccia INGLESE: vale la stessa regola di `soloCatalogoDaCorpo`', async () => {
        conLingua('en')
        const e = await erroreDaRisposta(
            risposta(403, { error: 'Account sospeso per morosità', codice: 'ACCOUNT_SOSPESO' }),
            'fallback',
        )

        expect(e.testo).toBe(enShared.erroreAccountSospeso)
        // La prosa del server non arriva a schermo: nasce dove il locale non esiste.
        expect(e.testo).not.toMatch(/morosità/i)
    })

    it('la PROSA del server non sostituisce il ripiego quando il codice non è dichiarato', async () => {
        // Regola delle schermate famiglia: «oggetto_id obbligatorio per questo tipo di
        // segnalazione» è testo per i log, non per un genitore.
        const e = await erroreDaRisposta(
            risposta(400, { error: 'studentId obbligatorio' }),
            'Non è stato possibile comunicare l\'assenza.',
        )

        expect(e.testo).toBe('Non è stato possibile comunicare l\'assenza.')
        expect(e.codice).toBeNull()
        expect(e.corpoLetto).toBe(true)
    })

    it('un `codice` che non è una stringa non diventa un codice', async () => {
        const e = await erroreDaRisposta(risposta(400, { error: 'x', codice: { a: 1 } }), 'ripiego')
        expect(e.codice).toBeNull()
    })

    it('una risposta senza `status` numerico non inventa uno stato', async () => {
        // I test del repo passano oggetti costruiti a mano: `stato` deve dire «non lo so»
        // invece di mentire con uno zero che in SQL sembra un codice HTTP.
        const e = await erroreDaRisposta({ json: async () => ({}) } as unknown as Response, 'ripiego')
        expect(e.stato).toBeUndefined()
        expect(e.testo).toBe('ripiego')
    })
})
