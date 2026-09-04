/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Un 422 «weak_password» non è un 400 qualunque, e confonderli costa 30 rifiuti
 * al giorno.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MISURATO IN PRODUZIONE (2026-09-04, `app_log`): GoTrue risponde
 * `422 weak_password — "Password is known to be weak and easy to guess"` a
 * **20 utenti distinti in un giorno** (30 occorrenze), 29 il giorno prima, 20
 * quello prima ancora. È la protezione «leaked password» del provider: una
 * password di dieci caratteri, con maiuscola e cifra, viene respinta perché
 * compare in un elenco di credenziali rubate ad altri siti.
 *
 * Fino a oggi `POST /api/account/password` collassava OGNI 4xx del provider in
 * un unico `PASSWORD_RIFIUTATA`, la cui frase consiglia di scegliere una password
 * «più lunga e con almeno una lettera e una cifra» — cioè manda a rifare
 * esattamente ciò che era già giusto, mentre i tre criteri a schermo restano
 * tutti verdi. Un rifiuto che indica il rimedio sbagliato è peggio di un rifiuto
 * muto: manda a sbattere due volte.
 *
 * ⚠️ SI LEGGE IL `code`, NON IL `message`. Il corpo dell'errore del provider è
 * prosa inglese e non esce mai dall'interfaccia; `error_code` invece è a
 * vocabolario chiuso ed è già dichiarato in chiaro in `redact.ts`. Questa
 * distinzione è l'intera ragione per cui il modulo esiste.
 */
import { describe, it, expect } from 'vitest'
import { classificaRifiutoPassword, codiceProviderPerLog } from '@/lib/auth/rifiuto-provider-password'

describe('classificaRifiutoPassword', () => {
    it('riconosce weak_password dal campo `code` (la forma che GoTrue usa davvero)', () => {
        expect(classificaRifiutoPassword({ status: 422, code: 'weak_password' })).toBe('password-nota')
    })

    it('riconosce weak_password anche quando il campo si chiama `error_code`', () => {
        // Le due forme convivono a seconda della versione del client: leggerne una
        // sola vuol dire perdere il caso l'altra metà delle volte, in silenzio.
        expect(classificaRifiutoPassword({ status: 422, error_code: 'weak_password' })).toBe('password-nota')
    })

    it('NON si fida del messaggio in inglese', () => {
        // Se un giorno il provider cambiasse la prosa, un match sul testo
        // smetterebbe di funzionare senza che nessun test diventi rosso.
        // Il codice resta, la prosa no: si guarda il codice.
        expect(
            classificaRifiutoPassword({ status: 422, message: 'Password is known to be weak and easy to guess.' }),
        ).toBe('password-non-accettata')
    })

    it('ogni altro 4xx resta «non accettata»: il rimedio è lo stesso, il motivo no', () => {
        expect(classificaRifiutoPassword({ status: 400, code: 'validation_failed' })).toBe('password-non-accettata')
        expect(classificaRifiutoPassword({ status: 403, code: 'user_banned' })).toBe('password-non-accettata')
    })

    it('un 5xx è un guasto nostro, non una password da cambiare', () => {
        expect(classificaRifiutoPassword({ status: 500 })).toBe('guasto')
        expect(classificaRifiutoPassword({ status: 503, code: 'weak_password' })).toBe('guasto')
    })

    it('un errore SENZA status è un guasto, non un rifiuto', () => {
        // Già visto in produzione: un errore di rete che arriva qui senza `status`.
        // Trattarlo come «scegline un'altra» manderebbe l'utente a cambiare una
        // password che non aveva niente che non andasse.
        expect(classificaRifiutoPassword({ message: 'fetch failed' })).toBe('guasto')
        expect(classificaRifiutoPassword(new Error('boom'))).toBe('guasto')
    })

    it('non esplode su null, undefined e forme impreviste', () => {
        // `message` `undefined` è successo davvero (riga di auth.users non
        // serializzabile, 2026-07-31): il logger non deve poter rompere l'app.
        expect(classificaRifiutoPassword(null)).toBe('guasto')
        expect(classificaRifiutoPassword(undefined)).toBe('guasto')
        expect(classificaRifiutoPassword('weak_password')).toBe('guasto')
        expect(classificaRifiutoPassword({ status: '422', code: 'weak_password' })).toBe('guasto')
    })
})

describe('codiceProviderPerLog', () => {
    it('restituisce il codice del provider quando è una stringa breve a vocabolario chiuso', () => {
        expect(codiceProviderPerLog({ status: 422, code: 'weak_password' })).toBe('weak_password')
    })

    it('NON restituisce prosa: una stringa lunga o con spazi non è un codice', () => {
        // Difesa contro il caso in cui il provider infili il messaggio nel campo
        // sbagliato: `error_code` esce IN CHIARO nei log, e ci deve finire un
        // enumerato, mai una frase che potrebbe contenere qualsiasi cosa.
        expect(codiceProviderPerLog({ status: 422, code: 'Password is known to be weak' })).toBeUndefined()
        expect(codiceProviderPerLog({ status: 400 })).toBeUndefined()
    })
})
