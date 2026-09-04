import { describe, it, expect } from 'vitest'
import { messaggioCredenziali, type OccasioneCredenziali } from '@/lib/email/messaggi/credenziali'
import type { ContestoSede } from '@/lib/email/contesto'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * «Ne ho ricevute tredici e non funziona nessuna»: ogni password ne uccideva
 * un'altra, e l'email non lo diceva.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MISURATO IN PRODUZIONE (2026-09-04, `app_log`): **9 persone** hanno ricevuto
 * fra 2 e 13 emissioni di credenziali. Per 6 di loro il login riesce entro
 * pochi minuti dall'ULTIMA — cioè tutte le precedenti erano corse a vuoto.
 *
 * Il meccanismo è una corsa fra due persone che non si vedono. La famiglia
 * telefona, la Segreteria preme «Rigenera», la famiglia intanto sta digitando la
 * password dell'email che ha già aperto — e quella, in quel momento esatto, ha
 * appena smesso di funzionare. Nella casella ci sono ora tredici messaggi con lo
 * stesso oggetto e nessun modo di sapere quale valga.
 *
 * Due righe lo tolgono: **quando** questa password è stata generata, e che
 * **annulla** le precedenti.
 *
 * ⚠️ LA SECONDA RIGA NON È SEMPRE VERA, e per questo non compare sempre.
 * All'iscrizione approvata, o al primo inserimento in anagrafica, non c'è nessuna
 * password precedente da annullare: scriverlo sarebbe far dubitare di qualcosa
 * che non è mai esistito. L'`occasione` — unione chiusa, già in questo modulo —
 * è ciò che distingue i due casi, e non serve nessun flag nuovo.
 */

const SEDE: ContestoSede = {
    nome: 'Kidville Giugliano',
    indirizzo: 'Via Prima Traversa Antica Giardini 5, 80014 Giugliano in Campania (NA)',
    email: 'giugliano@kidville.it',
    telefono: null,
    app: 'https://app.kidville.it',
    privacy: 'https://app.kidville.it/privacy',
}

// GIÀ FORMATTATO, come `avvenutoIl` nella 12: questi generatori sono funzioni
// pure e non conoscono né fusi né locale. La data italiana la scrive
// `formattaIstante` in un punto solo del progetto, e chi chiama la passa.
const EMESSA = '4 settembre 2026 alle 14:32'

function messaggio(occasione: OccasioneCredenziali) {
    return messaggioCredenziali(
        { nome: 'Maria', email: 'maria@x.it', password: 'Abcd-efgh-ijkl-mnop', occasione, emessaIl: EMESSA },
        SEDE,
    )
}

describe('email delle credenziali — quando è stata generata, e che cosa annulla', () => {
    it.each([
        'iscrizione-approvata',
        'inserimento-anagrafica',
        'password-rigenerata',
        'anagrafica-personale-approvata',
    ] as const)('«%s» porta sempre data e ora della generazione', (occasione) => {
        const m = messaggio(occasione)
        // Con tredici messaggi identici in casella, l'unica cosa che permette di
        // riconoscere l'ultimo è l'istante in cui è nato.
        for (const corpo of [m.html, m.testo]) {
            expect(corpo).toMatch(/4 settembre 2026/)
            expect(corpo).toMatch(/14[:.]32/)
        }
    })

    it('solo la RIGENERAZIONE dice che annulla le precedenti', () => {
        const m = messaggio('password-rigenerata')
        expect(m.testo).toMatch(/annulla|sostituisce/i)
        expect(m.html).toMatch(/annulla|sostituisce/i)
    })

    it.each(['iscrizione-approvata', 'inserimento-anagrafica', 'anagrafica-personale-approvata'] as const)(
        '«%s» NON lo dice: non c’è nessuna password precedente da annullare',
        (occasione) => {
            const m = messaggio(occasione)
            expect(m.testo).not.toMatch(/annulla le password|sostituisce quelle/i)
        },
    )

    it('la riga della password resta SOLA sulla sua riga, byte per byte', () => {
        // Il difetto del 2026-08-22 (30 famiglie su 67 fuori) non deve tornare da
        // questa porta: aggiungere righe attorno al valore è esattamente il modo
        // in cui potrebbe. Il dito che seleziona prende LA RIGA.
        const righe = messaggio('password-rigenerata').testo.split('\n')
        expect(righe).toContain('Abcd-efgh-ijkl-mnop')
    })

    it('la forma resta impersonale: nessuna seconda persona singolare', () => {
        // Lo stesso messaggio va a un genitore e a una maestra: il registro è
        // impersonale per scelta dichiarata in testa al modulo.
        const m = messaggio('password-rigenerata')
        expect(m.testo).not.toMatch(/\b(tua|tuo|tuoi|tue|puoi|devi|sei)\b/i)
    })
})
