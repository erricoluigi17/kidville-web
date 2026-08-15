import { describe, it, expect } from 'vitest'
import { documento } from '@/lib/email/layout'
import { avviso, bottone, riquadroCodice, riquadroCredenziali, tabellaDati, tabMascotte, tappe, tappeTesto, riepilogoVoci } from '@/lib/email/componenti'
import { esc, grezzo, h } from '@/lib/email/html'
import { contestoSenzaSede, type ContestoSede } from '@/lib/email/contesto'

// =============================================================================
// Il layout master e i componenti: cosa vale davvero misurare di un'email HTML.
//
// Non l'uscita byte per byte — sarebbe uno snapshot, e in questo repo non ce ne
// sono di proposito: uno snapshot da 16 KB trasforma ogni ritocco di testo in un
// diff che nessuno legge, e quando diventa rosso lo si aggiorna senza guardarlo.
//
// Si misurano invece le proprietà che, se saltano, rompono l'email in un client
// vero: le tabelle, i ripieghi per Outlook, il preheader, la modalità scura, i
// due punti di rottura del responsive. Cose che si vedono solo aprendo Outlook,
// e che quindi nessuno vedrebbe mai.
// =============================================================================

const SEDE: ContestoSede = {
    nome: 'Kidville Aversa',
    indirizzo: 'Via Dell\'Archeologia 54, 81031 Aversa (CE)',
    email: 'aversa@kidville.it',
    telefono: null,
    app: 'https://app.kidville.it',
    privacy: 'https://app.kidville.it/privacy',
}

const base = (extra: Partial<Parameters<typeof documento>[1]> = {}): string =>
    documento(SEDE, {
        oggetto: 'Oggetto di prova',
        preheader: 'Una riga d\'anteprima diversa dall\'oggetto.',
        corpo: h`<p>corpo</p>`,
        motivo: 'Motivo dell\'invio.',
        ...extra,
    })

describe('layout master — le proprietà che rompono un client vero', () => {
    it('è un documento completo in italiano, con i meta che governano il tema', () => {
        const html = base()
        expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
        expect(html).toContain('<html lang="it">')
        expect(html).toContain('name="color-scheme" content="light dark"')
        expect(html).toContain('name="supported-color-schemes" content="light dark"')
        expect(html).toContain('x-apple-disable-message-reformatting')
        expect(html.trimEnd().endsWith('</html>')).toBe(true)
    })

    it('il preheader c\'è, è nascosto, e NON è la ripetizione dell\'oggetto', () => {
        const html = base()
        expect(html).toContain('Una riga d&#39;anteprima diversa dall&#39;oggetto.')
        expect(html).toContain('mso-hide:all')
        expect(html).toContain('max-height:0')
        // Il preheader viene prima del corpo: è ciò che si legge nella lista.
        expect(html.indexOf('anteprima diversa')).toBeLessThan(html.indexOf('corpo'))
    })

    it('la modalità scura è emessa DUE VOLTE, e non è una svista da deduplicare', () => {
        // Una per i client che dichiarano il tema, una per l'anteprima locale che
        // lo forza. Chi «ottimizza» unendole spegne l'interruttore dell'anteprima
        // senza accorgersene, perché nessun'altra cosa cambia.
        const html = base()
        expect(html).toContain('@media (prefers-color-scheme:dark)')
        expect(html).toContain('html[data-force-dark] ')
        expect(html.split('#152220').length - 1).toBe(2)
        expect(html.split('#8FE0D1').length - 1).toBe(4) // .kv-h e .kv-lnk, per due
    })

    it('il prefisso della modalità scura copre TUTTI i selettori della lista', () => {
        // Il difetto che questo previene: `body,.kv-bg{…}` prefissato con una
        // replace ingenua diventa `html[data-force-dark] body,.kv-bg{…}`, e la
        // seconda metà resta senza prefisso — cioè il tema scuro si accende a
        // tutti, sempre.
        const html = base()
        expect(html).toContain('html[data-force-dark] body,html[data-force-dark] .kv-bg{')
        expect(html).not.toMatch(/html\[data-force-dark\] body,\.kv-bg\{/)
    })

    it('600px con i due punti di rottura verificati (640 e 480)', () => {
        const html = base()
        expect(html).toContain('max-width:600px')
        expect(html).toContain('@media screen and (max-width:640px)')
        expect(html).toContain('@media screen and (max-width:480px)')
    })

    it('Outlook riceve Arial per i titoli, perché Nunito non gli arriverebbe comunque', () => {
        expect(base()).toContain('<!--[if mso]><style>h1,h2,.kv-title{font-family:Arial,sans-serif !important;}')
    })

    it('nessun webfont remoto: l\'IP di chi legge non esce all\'apertura', () => {
        // La fonte di design emetteva un <link> a fonts.googleapis.com. Un
        // riferimento remoto dentro un'email lo carica il client del
        // destinatario: sarebbe l'indirizzo IP di ogni famiglia che arriva a un
        // terzo all'apertura di un messaggio che parla di un minore.
        const html = base()
        expect(html).not.toContain('fonts.googleapis.com')
        expect(html).not.toContain('<link')
        // Ma lo stack NOMINA ancora Nunito: se è installato, si usa. Senza rete.
        expect(html).toContain("'Nunito'")
    })

    it('il nome della sede è nell\'intestazione, e cambia con la sede', () => {
        expect(base()).toContain('Kidville Aversa')
        expect(documento({ ...SEDE, nome: 'Kidville Cesa' }, {
            oggetto: 'x', preheader: 'y', corpo: h`<p>z</p>`, motivo: 'm',
        })).toContain('Kidville Cesa')
    })

    it('la tab gialla è opzionale: 08 e 09 sono sobrie per scelta', () => {
        expect(base()).not.toContain('background:#FDC400')
        expect(base({ tab: tabMascotte({ titolo: 'Prova' }) })).toContain('background:#FDC400')
    })

    it('il logo si può scollegare, e il testo alternativo resta «Kidville»', () => {
        expect(base()).toContain('<a href="https://app.kidville.it" style="text-decoration:none')
        expect(base({ logoCliccabile: false })).not.toContain('<a href="https://app.kidville.it" style="text-decoration:none')
        expect(base()).toContain('alt="Kidville"')
    })

    it('tutto è a tabelle: niente flex, niente grid, niente position', () => {
        const html = base({ tab: tabMascotte({ titolo: 'Prova', occhiello: 'Occhiello', sottotitolo: 'Sotto' }) })
        expect(html).not.toMatch(/display:\s*(flex|grid)/)
        expect(html).not.toMatch(/position:\s*(absolute|fixed|relative)/)
        // Ogni <table> è dichiarata di presentazione: gli screen reader non la
        // leggono come una tabella di dati.
        const tabelle = html.match(/<table/g) ?? []
        const presentazione = html.match(/<table role="presentation"/g) ?? []
        expect(presentazione.length).toBe(tabelle.length)
    })

    it('l\'oggetto finisce nel <title>, scappato', () => {
        expect(base({ oggetto: 'Ciao & <b>' })).toContain('<title>Ciao &amp; &lt;b&gt;</title>')
    })
})

describe('componenti — i ripieghi che si vedono solo in Outlook', () => {
    it('ogni bottone porta il suo <v:roundrect>, altrimenti in Outlook è un link blu', () => {
        const b = bottone('https://app.kidville.it/auth/login', 'Vai all\'area riservata')
        expect(b).toContain('<v:roundrect')
        expect(b).toContain('<w:anchorlock/>')
        expect(b).toContain('<!--[if !mso]><!-->')
        expect(b).toContain('border-radius:999px')
    })

    it('la mascotte è decorativa: alt vuoto, così a immagini spente non lascia un buco', () => {
        const t = tabMascotte({ titolo: 'Domanda ricevuta' })
        expect(t).toContain('alt=""')
        expect(t).not.toContain('mascot-hero.png') // quella pesa 715 KB
        expect(t).toContain('mascot-email.png')
    })

    it('sul giallo l\'inchiostro è il verde SCURO: 5,52:1 invece di 4,07:1', () => {
        const t = tabMascotte({ titolo: 'Prova', occhiello: 'Occ', sottotitolo: 'Sot' })
        expect(t).toContain('#00544B')
        expect(t).not.toContain('color:#006A5F')
    })

    it('la variante compatta non ha mascotte e ha il titolo più piccolo', () => {
        const c = tabMascotte({ titolo: 'Codice di verifica', compatta: true })
        expect(c).not.toContain('mascot-email.png')
        expect(c).toContain('font-size:20px')
    })

    it('i quattro toni d\'avviso escono coi loro colori, testo scuro su fondo tenue', () => {
        expect(avviso('info', h`x`)).toContain('#1D4FA8')
        expect(avviso('avviso', h`x`)).toContain('#A64F09')
        expect(avviso('errore', h`x`)).toContain('#C62828')
        expect(avviso('ok', h`x`)).toContain('#1B5E20')
    })

    it('il riquadro credenziali: password monospaziata e MAI spezzata su due righe', () => {
        const r = riquadroCredenziali('mamma@example.test', 'Kv7-Rana-2026')
        expect(r).toContain('white-space:nowrap')
        expect(r).toContain('SFMono-Regular')
        expect(r).toContain('Kv7-Rana-2026')
        // L'email invece può andare a capo: a nowrap imporrebbe 364px di
        // larghezza minima a tutta l'email. `anywhere` spezza PRIMA sugli spazi
        // e dentro la parola solo quando non c'è alternativa — `break-all`
        // tagliava anche in mezzo a un gruppo di cifre dell'IBAN.
        expect(r).toContain('overflow-wrap:anywhere')
        // La password non è dentro un link, mai.
        expect(r).not.toMatch(/<a[^>]*>[^<]*Kv7-Rana-2026/)
    })

    it('il codice di verifica è grande, distanziato e su una riga sola', () => {
        const c = riquadroCodice('418 297')
        expect(c).toContain('font-size:40px')
        expect(c).toContain('letter-spacing:10px')
        expect(c).toContain('white-space:nowrap')
    })

    it('la tabella dati usa il monospaziato solo dove il dato si copia', () => {
        const t = tabellaDati([
            { etichetta: 'Sede', valore: 'Kidville Cesa' },
            { etichetta: 'IBAN', valore: 'IT00X0000000000000000000000', mono: true },
        ])
        expect(t).toContain('Kidville Cesa')
        expect(t.split('SFMono-Regular').length - 1).toBe(1)
        expect(t).toContain('overflow-wrap:anywhere')
    })

    it('la linea del tempo marca la tappa attiva E SOLO quella', () => {
        const t = tappe(['Ricevuta', 'In esame', 'Approvata'], 0)
        expect(t.split('&#10003;').length - 1).toBe(1)
        expect(t).toContain('>2<')
        expect(t).toContain('>3<')
        expect(tappeTesto(['Ricevuta', 'In esame', 'Approvata'], 0))
            .toBe('[✓] Ricevuta  →  [ ] In esame  →  [ ] Approvata')
    })

    it('con una voce sola il riepilogo non mostra il totale (sarebbe lo stesso numero due volte)', () => {
        const una = riepilogoVoci([{ descrizione: 'Retta di marzo', scadenza: '05/03/2026', giorniRitardo: 3, importo: 235 }])
        expect(una).not.toContain('Totale da saldare')
        expect(una).toContain('€ 235,00')
    })

    it('da due voci in su compare il totale, ed è la somma', () => {
        const due = riepilogoVoci([
            { descrizione: 'Retta di gennaio', scadenza: '05/01/2026', giorniRitardo: 68, importo: 235 },
            { descrizione: 'Mensa di febbraio', scadenza: '20/02/2026', giorniRitardo: 25, importo: 62.5 },
        ])
        expect(due).toContain('Totale da saldare')
        expect(due).toContain('€ 297,50')
        expect(due).toContain('2 pagamenti arretrati')
    })

    it('gli importi passano da formatEuro: mai un punto decimale in un\'email italiana', () => {
        const r = riepilogoVoci([{ descrizione: 'x', scadenza: '01/01/2026', giorniRitardo: 1, importo: 1234.5 }])
        expect(r).toContain('€ 1.234,50')
        expect(r).not.toContain('1234.5')
    })
})

describe('escaping — i componenti non si fidano di ciò che ricevono', () => {
    const OSTILE = '<script>alert(1)</script>"><img src=x onerror=1>'

    it('nessun componente lascia passare un marcatore', () => {
        const usciti = [
            tabMascotte({ titolo: OSTILE, occhiello: OSTILE, sottotitolo: OSTILE }),
            riquadroCodice(OSTILE),
            riquadroCredenziali(OSTILE, OSTILE),
            tabellaDati([{ etichetta: OSTILE, valore: OSTILE, mono: true }]),
            bottone(OSTILE, OSTILE),
            tappe([OSTILE], 0),
            riepilogoVoci([{ descrizione: OSTILE, scadenza: OSTILE, giorniRitardo: 1, importo: 1 }]),
        ]
        for (const u of usciti) {
            // Ciò che conta è che i due tag del payload non si APRANO. Dopo
            // l'escape la stringa `onerror=1` resta leggibile nell'uscita come
            // testo inerte — ed è giusto così: è quello che l'utente ha scritto,
            // e va mostrato, non censurato. Il difetto sarebbe un `<` vivo.
            expect(u).not.toContain('<script')
            expect(u).not.toContain('<img src=x')
            // Controllo POSITIVO: senza, un parametro semplicemente non stampato
            // renderebbe questo test verde per il motivo sbagliato — ed è così
            // che un lock muore senza che nessuno se ne accorga.
            expect(u).toContain('&lt;script&gt;')
            expect(u).toContain('&lt;img src=x')
        }
    })

    it('esc() copre le cinque entità, e la & per prima', () => {
        expect(esc('a & b < c > d " e \' f')).toBe('a &amp; b &lt; c &gt; d &quot; e &#39; f')
        // Se la & non fosse per prima, `&lt;` diventerebbe `&amp;lt;`.
        expect(esc('<')).toBe('&lt;')
    })

    it('esc() di null o undefined è vuoto, non la parola «null»', () => {
        expect(esc(null)).toBe('')
        expect(esc(undefined)).toBe('')
        expect(esc(0)).toBe('0')
    })

    it('grezzo() esiste ed è l\'unica fuga: il nome è brutto apposta', () => {
        expect(grezzo('<br>')).toBe('<br>')
    })
})

describe('il contesto generico non porta dati di nessun plesso', () => {
    it('documento con contesto senza sede ⇒ nessun indirizzo, nessun recapito', () => {
        const html = documento(contestoSenzaSede(), {
            oggetto: 'x', preheader: 'y', corpo: h`<p>z</p>`, motivo: 'm',
        })
        expect(html).not.toContain('Giugliano')
        expect(html).not.toContain('Aversa')
        expect(html).not.toContain('mailto:')
        expect(html).toContain('Kidville')
    })
})
