import { describe, it, expect } from 'vitest'
import { piede, piedeTesto } from '@/lib/email/componenti'
import { contestoSenzaSede, type ContestoSede } from '@/lib/email/contesto'

// =============================================================================
// Il piè di pagina è in fondo a tutte e dodici le email, quindi un suo difetto
// non si vede una volta: si vede sempre.
//
// ─── IL DIFETTO CHE QUESTO TEST IMPEDISCE ───────────────────────────────────
// La fonte di design componeva il piè di pagina come una stringa unica con i
// buchi dentro:
//
//     'Tel. <a href="tel:' + SEDE.telefono + '">' + SEDE.telefono + '</a>'
//     + ' &middot; <a href="mailto:' + SEDE.email + '">' + SEDE.email + '</a>'
//
// con `SEDE.telefono = '{sede_telefono}'`. Misurato il 2026-08-15: un recapito
// telefonico per plesso NON ESISTE, né in `schools`, né in `scuole`, né in
// `scuole.config.anagrafica`, né in nessun documento dell'archivio della
// cooperativa. Quel codice, portato così com'è, avrebbe spedito a centinaia di
// famiglie un `href="tel:{sede_telefono}"` letterale.
//
// La correzione non è «riempire il buco»: è costruire il piè di pagina per
// RIGHE, così che un recapito assente non lasci una riga vuota, un separatore
// spaiato o un link morto. La riga semplicemente non esiste.
//
// È la stessa regola che il progetto ha già scritto in
// `src/lib/scuole/anagrafica.ts`: «i documenti omettono ciò che manca, mai
// valori inventati». Qui è eseguibile.
// =============================================================================

const GIUGLIANO: ContestoSede = {
    nome: 'Kidville Giugliano',
    indirizzo: 'Via Prima Traversa Antica Giardini 5, 80014 Giugliano in Campania (NA)',
    email: 'giugliano@kidville.it',
    telefono: null,
    app: 'https://app.kidville.it',
    privacy: 'https://app.kidville.it/privacy',
}

const MOTIVO = 'Questo messaggio è stato inviato perché è stato aperto un accesso.'

describe('piè di pagina — ciò che manca si omette, non si stampa vuoto', () => {
    it('senza telefono ⇒ nessun «Tel. » orfano e nessun href="tel:" vuoto', () => {
        const html = piede(GIUGLIANO, MOTIVO)
        expect(html).not.toContain('Tel. ')
        expect(html).not.toContain('href="tel:"')
        expect(html).not.toContain('tel:{')
        // L'email c'è, quindi la riga dei recapiti esiste — ma senza separatore
        // spaiato davanti.
        expect(html).toContain('mailto:giugliano@kidville.it')
        expect(html).not.toContain('&middot; <a class="kv-lnk" href="mailto:')
    })

    it('senza NESSUN recapito ⇒ la riga dei contatti non esiste affatto', () => {
        const html = piede({ ...GIUGLIANO, email: null, telefono: null }, MOTIVO)
        expect(html).not.toContain('mailto:')
        expect(html).not.toContain('tel:')
        expect(html).not.toContain('&middot;')
        // Ma nome, indirizzo e ragione sociale restano: il piè di pagina degrada,
        // non sparisce.
        expect(html).toContain('Kidville Giugliano')
        expect(html).toContain('Via Prima Traversa Antica Giardini 5')
        expect(html).toContain('La Favola soc. coop.')
    })

    it('senza indirizzo ⇒ la riga non c\'è, e non compare una virgola sospesa', () => {
        const html = piede({ ...GIUGLIANO, indirizzo: null }, MOTIVO)
        expect(html).not.toContain('Via Prima')
        expect(html).toContain('Kidville Giugliano')
        expect(html).not.toMatch(/<br>\s*<br>/)
    })

    it('nessun segnaposto del pacchetto di design sopravvive nell\'uscita', () => {
        // `{sede_telefono}`, `{sede_email}`, `{url_privacy}`: se uno di questi
        // compare, vuol dire che qualcuno ha ricopiato la fonte invece di
        // portarla.
        for (const sede of [GIUGLIANO, contestoSenzaSede(), { ...GIUGLIANO, email: null }]) {
            expect(piede(sede, MOTIVO)).not.toMatch(/\{[a-z_]+\}/)
            expect(piedeTesto(sede, MOTIVO)).not.toMatch(/\{[a-z_]+\}/)
        }
    })

    it('il gemello testuale applica la stessa omissione dell\'HTML', () => {
        const t = piedeTesto({ ...GIUGLIANO, email: null, telefono: null }, MOTIVO)
        expect(t).not.toContain('Tel.')
        expect(t).not.toContain('·')
        expect(t).toContain('Kidville Giugliano')
        expect(t).toContain(MOTIVO)
    })

    it('col telefono ⇒ il tel: porta solo le cifre, il testo resta leggibile', () => {
        const html = piede({ ...GIUGLIANO, telefono: '081 123 4567' }, MOTIVO)
        expect(html).toContain('href="tel:0811234567"')
        expect(html).toContain('>081 123 4567<')
    })

    it('la disiscrizione compare SOLO se richiesta (è il digest, e solo quello)', () => {
        expect(piede(GIUGLIANO, MOTIVO)).not.toContain('Non ricevere più')
        const conLink = piede(GIUGLIANO, MOTIVO, { disiscrizione: 'https://app.kidville.it/x' })
        expect(conLink).toContain('Non ricevere più il riepilogo mensile')
    })

    it('il nome della sede è scappato: una sede col nome ostile non apre un tag', () => {
        const html = piede({ ...GIUGLIANO, nome: 'Kidville <script>alert(1)</script>' }, MOTIVO)
        expect(html).not.toContain('<script>')
        expect(html).toContain('&lt;script&gt;')
    })
})

describe('contesto senza sede — il ripiego è generico, mai un plesso a caso', () => {
    it('nome «Kidville», nessun recapito, privacy sempre presente', () => {
        const c = contestoSenzaSede()
        expect(c.nome).toBe('Kidville')
        expect(c.indirizzo).toBeNull()
        expect(c.email).toBeNull()
        expect(c.telefono).toBeNull()
        expect(c.privacy).toMatch(/\/privacy$/)
    })
})
