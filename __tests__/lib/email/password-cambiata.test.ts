import { describe, it, expect } from 'vitest'
import type { ContestoSede } from '@/lib/email/contesto'
import {
    messaggioPasswordCambiata,
    OGGETTO_PASSWORD_CAMBIATA,
    type DatiPasswordCambiata,
} from '@/lib/email/messaggi/password-cambiata'

// =============================================================================
// 14 · «La password è stata cambiata» — l'unico modo in cui il proprietario di
// un account scopre un cambio che non ha fatto lui.
//
// Le tre proprietà trasversali (niente si apre · il gemello non diverge · la
// sede cambia il contenuto) le misura `generatori-email.test.ts` insieme a tutti
// gli altri. Qui stanno le quattro cose che valgono SOLO per questa email:
//
//  1. IL REGISTRO IMPERSONALE. Arriva sia a un genitore (a cui il prodotto dà
//     del «tu») sia a una maestra (a cui dà del «lei»). Una email sola non può
//     fare tutti e due, e sceglierne uno significa suonare sgarbati con metà dei
//     destinatari. È lo stesso vincolo dell'email 01, e si misura riga per riga.
//  2. NON CONTIENE LA PASSWORD. Mai, in nessuna forma, nemmeno la lunghezza —
//     e non per disciplina di chi scrive: il generatore non la RICEVE.
//  3. LA RIGA DI PRESIDIO. «Se il cambio non è stato richiesto, conviene
//     contattare la segreteria di {sede}»: senza quella riga questa email è una
//     notifica inutile, perché non dice a chi non ha cambiato niente cosa fare.
//  4. QUANDO E DOVE. Un avviso di sicurezza senza l'ora del fatto e senza il
//     plesso non permette a nessuno di dire «non ero io»: con tre sedi, «la
//     password di Kidville» non identifica un account.
// =============================================================================

const GIUGLIANO: ContestoSede = {
    nome: 'Kidville Giugliano',
    indirizzo: 'Via Prima Traversa Antica Giardini 5, 80014 Giugliano in Campania (NA)',
    email: 'giugliano@kidville.it',
    telefono: null,
    app: 'https://app.kidville.it',
    privacy: 'https://app.kidville.it/privacy',
}
const AVERSA: ContestoSede = {
    ...GIUGLIANO,
    nome: 'Kidville Aversa',
    indirizzo: 'Via Dell\'Archeologia 54, 81031 Aversa (CE)',
    email: 'aversa@kidville.it',
}

const QUANDO = '12/03/2026 alle 18:42'
const m = (nome?: string | null, sede: ContestoSede = GIUGLIANO) =>
    messaggioPasswordCambiata({ nome, avvenutoIl: QUANDO }, sede)

/**
 * La SOLA scheda bianca: né intestazione verde, né tab gialla, né piè di pagina.
 *
 * ⚠️ Non si ritaglia su `kv-card`, che è la strada corta e sbagliata: quella
 * classe compare TRE volte — due nel CSS della modalità scura, emesso due volte
 * di proposito (`layout.ts`), e una sola sul `<td>` vero. `split('kv-card')[1]`
 * restituisce quindi un frammento di CSS, dentro cui non c'è mai un `<a>` né il
 * nome di una sede: un controllo fatto così è verde per costruzione, cioè non è
 * un controllo. (Lo è oggi in `02 codice di verifica`, ed è il motivo per cui qui
 * ogni asserzione negativa è accompagnata da una positiva sullo stesso ritaglio.)
 */
function schedaBianca(html: string): string {
    const dopoApertura = html.split('padding:30px 28px 34px 28px;">')[1] ?? ''
    return dopoApertura.split('<tr><td class="kv-pad">')[0]
}

describe('14 password cambiata — la forma impersonale', () => {
    // Gli allocutivi che una scrittura sciatta produrrebbe: metà sono il «tu» del
    // genitore, metà il «lei» del personale. Nessuno dei due va bene qui.
    const ALLOCUTIVI = /\b(accedi|acceda|conserva|conservi|contatta|contatti|avvisa|avvisi|ignora|ignori|cambia|cambi|puoi|può|potrai|potrà|hai|ti|le consigliamo)\b/i
    const POSSESSIVI = /\b(la tua|il tuo|la sua|il suo) (password|area|accesso|account|email)\b/i

    it('nessuna seconda persona, né singolare né di cortesia — col nome e senza', () => {
        for (const corpo of [m('Maria').testo, m(null).testo, m('Maria').html, m(null).html]) {
            expect(corpo).not.toMatch(ALLOCUTIVI)
            expect(corpo).not.toMatch(POSSESSIVI)
        }
    })

    it('senza nome NON compare un ripiego: «Gentile genitore» a una maestra è falso', () => {
        const t = m(null).testo
        expect(t).not.toMatch(/Gentile (genitore|utente|collega|cliente|famiglia)/i)
        // E il messaggio regge lo stesso: la frase esiste in due forme, non con
        // un buco davanti.
        expect(t).toContain('La password dell’area riservata')
    })

    it('col nome, il saluto c\'è e la frase si aggancia', () => {
        expect(m('Maria').testo).toContain('Gentile Maria,\nla password dell’area riservata')
    })
})

describe('14 password cambiata — non contiene la password', () => {
    it('il generatore non può nemmeno RICEVERLA: non si fa uscire un dato che non si ha', () => {
        // Non è un controllo sul testo, è il TIPO: `DatiPasswordCambiata` non ha
        // un campo per la password né per la sua lunghezza. Se un giorno qualcuno
        // ce lo aggiungesse «perché sarebbe comodo», questa riga smette di essere
        // un errore atteso e `tsc --noEmit` diventa rosso.
        const d: DatiPasswordCambiata = {
            nome: 'Maria',
            avvenutoIl: QUANDO,
            // @ts-expect-error — la password non entra in questa email, in nessuna forma
            password: 'Marcatore-finta-2026',
        }
        expect(d.avvenutoIl).toBe(QUANDO)
    })

    it('nessuna forma della password nel corpo: né il valore, né la lunghezza, né un riquadro', () => {
        const { html, testo } = m('Maria')
        for (const vietato of [
            'caratteri',            // «la nuova password è di 12 caratteri» dice quasi tutto
            'Password temporanea',  // l'etichetta del riquadro credenziali (email 01)
            'Email di accesso',     // l'altra etichetta dello stesso riquadro
            'Marcatore-finta-2026',
        ]) {
            expect(html, vietato).not.toContain(vietato)
            expect(testo, vietato).not.toContain(vietato)
        }
    })
})

describe('14 password cambiata — quando, da quale sede, e cosa fare se non è stato lui', () => {
    it('la riga di presidio nomina la segreteria DELLA SEDE, in HTML e in testo', () => {
        for (const sede of [GIUGLIANO, AVERSA]) {
            const presidio = `Se il cambio non è stato richiesto, conviene contattare la segreteria di ${sede.nome}`
            expect(m('Maria', sede).testo).toContain(presidio)
            expect(m('Maria', sede).html).toContain(presidio)
        }
    })

    it('dice QUANDO è avvenuto, in entrambi i corpi', () => {
        expect(m('Maria').html).toContain(QUANDO)
        expect(m('Maria').testo).toContain(QUANDO)
    })

    it('nomina la sede nel CORPO, non solo nella carta intestata', () => {
        // Con tre plessi, «la password di Kidville» non identifica un account: il
        // corpo — cioè la scheda bianca, non l'intestazione verde — deve dire
        // quale. E non una volta sola: la frase d'apertura e la riga di presidio
        // sono i due punti in cui chi legge cerca «di che scuola stiamo parlando».
        const scheda = schedaBianca(m('Maria', AVERSA).html)
        expect(scheda).toContain('Kidville Aversa')
        expect(scheda).not.toContain('Kidville Giugliano')
    })

    it('l\'oggetto dice cosa è successo, senza allarmare e senza chiedere niente', () => {
        expect(OGGETTO_PASSWORD_CAMBIATA.length).toBeGreaterThan(5)
        expect(m('Maria').oggetto).toBe(OGGETTO_PASSWORD_CAMBIATA)
        expect(OGGETTO_PASSWORD_CAMBIATA).not.toMatch(/urgente|attenzione|sospett|verifica subito/i)
    })
})

describe('14 password cambiata — l\'antifurto', () => {
    it('nessun link nel corpo: chi riceve un avviso di sicurezza torna da sé nell\'app', () => {
        // Stessa ragione dell'email 02: un bottone «rivedi l'accesso» dentro un
        // avviso di sicurezza insegna alle famiglie esattamente l'abitudine che un
        // truffatore sfrutta. L'unico `<a>` ammesso è nel piè di pagina.
        const corpo = schedaBianca(m('Maria').html)
        // Il controllo POSITIVO che tiene onesti i due negativi: il ritaglio
        // contiene davvero il corpo dell'email, non una stringa vuota.
        expect(corpo).toContain('è stata cambiata')
        expect(corpo).not.toContain('<a ')
        expect(corpo).not.toContain('v:roundrect')
    })

    it('dice che la password non si chiede: è la riga contro il phishing', () => {
        expect(m('Maria').testo).toContain('Nessuno di Kidville chiede mai la password')
    })
})
