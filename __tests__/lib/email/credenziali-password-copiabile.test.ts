import { describe, it, expect } from 'vitest'
import { messaggioCredenziali } from '@/lib/email/messaggi/credenziali'
import type { ContestoSede } from '@/lib/email/contesto'
import { passwordTemporanea } from '@/lib/auth/password-temporanea'

/**
 * LA PASSWORD DEVE ARRIVARE VIVA DALL'ALTRA PARTE.
 *
 * Il 2026-08-22 il cron ha spedito 67 credenziali. 37 famiglie sono entrate, 30 no,
 * e alcune hanno telefonato. Nessuna password era stata ruotata dopo l'invio: quelle
 * che le 30 famiglie avevano in mano erano esattamente quelle scritte su GoTrue.
 * Il difetto non era nel valore — era nel viaggio dal messaggio al campo di accesso.
 *
 * Questo file sorveglia i due punti di quel viaggio che stanno dentro l'email:
 *
 *  1. la BYTE-IDENTITÀ: ciò che si mostra è, carattere per carattere, ciò che si è
 *     scritto su GoTrue. Un solo carattere trasformato in entità HTML e la password
 *     mostrata non è più quella vera;
 *  2. la COPIABILITÀ: nel testo semplice la password sta **da sola sulla sua riga**.
 *     Su un telefono si seleziona col dito, e il dito prende la RIGA: se sulla riga
 *     c'è anche l'etichetta, o un'indentazione, quello che finisce negli appunti non
 *     è la password.
 */

const SEDE: ContestoSede = {
    nome: 'Kidville Giugliano',
    indirizzo: 'Via Prima Traversa Antica Giardini 5, 80014 Giugliano in Campania (NA)',
    email: 'giugliano@kidville.it',
    telefono: null,
    app: 'https://app.kidville.it',
    privacy: 'https://app.kidville.it/privacy',
}

const OCCASIONI = [
    'iscrizione-approvata',
    'inserimento-anagrafica',
    'password-rigenerata',
    'anagrafica-personale-approvata',
] as const

describe('la password si può copiare senza portarsi via altro', () => {
    it('nel testo semplice sta da SOLA sulla sua riga, senza etichetta e senza indentazione', () => {
        for (const occasione of OCCASIONI) {
            const password = passwordTemporanea()
            const { testo } = messaggioCredenziali(
                { nome: 'Maria', email: 'a@b.test', password, occasione, emessaIl: '4 settembre 2026 alle 14:32' },
                SEDE,
            )
            const righe = testo.split('\n')
            // Non `toContain` sul testo intero: la password deve essere una riga
            // ESATTA, che è la sola cosa che renda innocua la selezione col dito.
            expect(righe, occasione).toContain(password)
        }
    })

    it('l\'etichetta resta, perché ci sono test che la cercano e occhi che la cercano', () => {
        const { testo } = messaggioCredenziali(
            { nome: null, email: 'a@b.test', password: passwordTemporanea(), occasione: 'iscrizione-approvata', emessaIl: '4 settembre 2026 alle 14:32' },
            SEDE,
        )
        expect(testo).toContain('Password temporanea:')
        expect(testo).toContain('Email di accesso:')
    })

    it('HTML e testo mostrano la password IDENTICA a quella scritta su GoTrue', () => {
        // 200 password vere, non una costante: è il lock della byte-identità, e
        // l'alfabeto del formato nuovo deve attraversare `esc()` senza una piega.
        for (let i = 0; i < 200; i++) {
            const password = passwordTemporanea()
            const m = messaggioCredenziali(
                { nome: 'Maria', email: 'a@b.test', password, occasione: 'iscrizione-approvata', emessaIl: '4 settembre 2026 alle 14:32' },
                SEDE,
            )
            expect(m.html).toContain(password)
            expect(m.testo).toContain(password)
        }
    })

    it('nell\'HTML la password non va a capo: `nowrap` non è decorazione', () => {
        // Con i trattini nel formato nuovo, un client di posta che spezzasse la riga
        // su un trattino farebbe copiare mezza password. Da oggi quello stile è un
        // requisito, non una scelta estetica, e questo test lo dichiara tale.
        const { html } = messaggioCredenziali(
            { nome: null, email: 'a@b.test', password: passwordTemporanea(), occasione: 'iscrizione-approvata', emessaIl: '4 settembre 2026 alle 14:32' },
            SEDE,
        )
        expect(html).toContain('white-space:nowrap')
    })

    it('dice di ENTRARE con la password qui sopra, non di inventarne una', () => {
        // La frase vecchia era «Al primo accesso è necessario impostare una nuova
        // password»: a lettura veloce, su un telefono, suggerisce di sceglierne una
        // a piacere — cioè di ignorare l'unica cosa che serve per entrare.
        for (const occasione of OCCASIONI) {
            const { testo, html } = messaggioCredenziali(
                { nome: 'Maria', email: 'a@b.test', password: passwordTemporanea(), occasione, emessaIl: '4 settembre 2026 alle 14:32' },
                SEDE,
            )
            for (const corpo of [testo, html]) {
                expect(corpo, occasione).toMatch(/password qui sopra/i)
            }
        }
    })

    it('resta impersonale: né «tu» né «lei», in tutte e quattro le occasioni', () => {
        // La stessa email va a una famiglia e a una maestra. Il lock è già in
        // `generatori-email.test.ts`; qui si ripete sulle frasi NUOVE, perché è
        // esattamente su una frase aggiunta di fretta che quella regola si perde.
        for (const occasione of OCCASIONI) {
            const { testo } = messaggioCredenziali(
                { nome: 'Maria', email: 'a@b.test', password: passwordTemporanea(), occasione, emessaIl: '4 settembre 2026 alle 14:32' },
                SEDE,
            )
            expect(testo, occasione).not.toMatch(/\b(accedi|acceda|conserva|conservi|puoi|può inserire|hai richiesto)\b/i)
            expect(testo, occasione).not.toMatch(/\b(la tua|il tuo|la sua|il suo) (password|iscrizione|candidatura)\b/i)
        }
    })
})
