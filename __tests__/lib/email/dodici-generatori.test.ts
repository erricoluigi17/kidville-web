import { describe, it, expect } from 'vitest'
import type { ContestoSede } from '@/lib/email/contesto'
import type { Messaggio } from '@/lib/email/messaggi/tipi'
import { messaggioCredenziali } from '@/lib/email/messaggi/credenziali'
import { messaggioCodiceVerifica } from '@/lib/email/messaggi/codice-verifica'
import { messaggioSollecito } from '@/lib/email/messaggi/sollecito'
import { messaggioDocumentoDipendente, messaggioDocumentoSegreteria } from '@/lib/email/messaggi/documento-personale'
import { messaggioEsitoCandidatura } from '@/lib/email/messaggi/esito-candidatura'
import { messaggioCancellazioneAccount } from '@/lib/email/messaggi/cancellazione-account'
import { messaggioDigestNews } from '@/lib/email/messaggi/digest-news'
import { messaggioRicevutaIscrizione } from '@/lib/email/messaggi/ricevuta-iscrizione'
import { messaggioCandidaturaAllaSede } from '@/lib/email/messaggi/candidatura-alla-sede'
import { messaggioConfermaCandidatura } from '@/lib/email/messaggi/conferma-candidatura'

// =============================================================================
// I dodici generatori, misurati insieme.
//
// Tre proprietà che valgono per TUTTI, e che si verificano una volta sola invece
// che dodici:
//
//  1. NIENTE SI APRE. Un valore ostile in qualunque parametro non produce un tag
//     vivo. È la difesa a runtime che sta accanto a quella del tipo `Html`:
//     `tsc` impedisce di dimenticare `esc()`, questo test lo dimostra.
//  2. IL GEMELLO NON DIVERGE. Ogni dato che compare nell'HTML compare anche nel
//     testo. Non è teoria: nel digest news, l'unico posto dove i due corpi già
//     coesistevano, erano GIÀ divergiuti — l'HTML portava categoria, estratto e
//     link, il testo solo i titoli.
//  3. LA SEDE CAMBIA TUTTO. Due sedi diverse producono due email diverse, e
//     nessuna delle due nomina l'altra.
// =============================================================================

const GIUGLIANO: ContestoSede = {
    nome: 'Kidville Giugliano',
    indirizzo: 'Via Prima Traversa Antica Giardini 5, 80014 Giugliano in Campania (NA)',
    email: 'giugliano@kidville.it',
    telefono: null,
    app: 'https://app.kidville.it',
    privacy: 'https://app.kidville.it/privacy',
}
const CESA: ContestoSede = {
    ...GIUGLIANO,
    nome: 'Kidville Cesa',
    indirizzo: 'Via Filippo Turati 2, 81030 Cesa (CE)',
    email: 'cesa@kidville.it',
}

/** I valori-marcatore: se compaiono nell'HTML devono comparire anche nel testo. */
const M = {
    bambino: 'MARCATORE-BAMBINO',
    nome: 'MARCATORE-NOME',
    codice: '418297',
    password: 'Marcatore-finta-2026',
    email: 'marcatore@example.test',
    riferimento: 'ISC-MARCATORE',
    data: '12/03/2026 alle 18:42',
    causale: 'MARCATORE-CAUSALE',
    iban: 'IT60X0542811101000000123456',
    url: 'https://app.kidville.test/marcatore-url',
}

/** Ogni generatore con dei parametri validi, e i dati che DEVONO reggere nel testo. */
function tutti(sede: ContestoSede): { nome: string; m: Messaggio; dati: string[] }[] {
    return [
        {
            nome: '01 credenziali',
            m: messaggioCredenziali({ nome: M.nome, email: M.email, password: M.password, occasione: 'iscrizione-approvata' }, sede),
            dati: [M.nome, M.email, M.password],
        },
        {
            nome: '02 codice di verifica',
            m: messaggioCodiceVerifica({ codice: M.codice, operazione: 'firmare il modulo', minuti: 10 }, sede),
            dati: [M.codice, '10'],
        },
        {
            nome: '03 promemoria',
            m: messaggioSollecito({
                livello: 1, oggetto: 'Promemoria pagamento — Retta di marzo', prosa: 'Gentile famiglia,\n\ntesto della sede.',
                alunno: M.bambino, causale: M.causale, iban: M.iban, intestatario: 'La Favola soc. coop.',
                voci: [{ descrizione: 'Retta di marzo', scadenza: '05/03/2026', giorniRitardo: 3, importo: 235 }],
            }, sede),
            dati: [M.bambino, M.causale, 'IT60 X054 2811 1010 0000 0123 456', '€ 235,00'],
        },
        {
            nome: '05 secondo sollecito, quattro voci',
            m: messaggioSollecito({
                livello: 3, oggetto: 'Secondo sollecito — 4 pagamenti', prosa: 'Gentile famiglia,\n\ntesto della sede.',
                alunno: M.bambino, causale: M.causale, iban: null,
                voci: [
                    { descrizione: 'Retta di gennaio', scadenza: '05/01/2026', giorniRitardo: 68, importo: 235 },
                    { descrizione: 'Retta di febbraio', scadenza: '05/02/2026', giorniRitardo: 40, importo: 235 },
                    { descrizione: 'Mensa febbraio', scadenza: '20/02/2026', giorniRitardo: 25, importo: 62 },
                    { descrizione: 'Uscita didattica', scadenza: '20/02/2026', giorniRitardo: 25, importo: 24.5 },
                ],
            }, sede),
            dati: [M.bambino, M.causale, '€ 556,50'],
        },
        {
            nome: '06 documento dipendente',
            m: messaggioDocumentoDipendente({ nome: M.nome, tipoDocumento: 'Carta d\'identità', scadenza: '12/03/2026', scaduto: false }, sede),
            dati: [M.nome, '12/03/2026'],
        },
        {
            nome: '07 documento segreteria',
            m: messaggioDocumentoSegreteria({ nome: M.nome, tipoDocumento: 'Carta d\'identità', scadenza: '12/03/2026', scaduto: true, urlAnagrafica: M.url }, sede),
            dati: [M.nome, '12/03/2026', M.url],
        },
        {
            nome: '08 esito candidatura',
            m: messaggioEsitoCandidatura({ nome: M.nome }, sede),
            dati: [M.nome],
        },
        {
            nome: '09 cancellazione account',
            m: messaggioCancellazioneAccount({ urlConferma: M.url, oreValidita: 1 }, sede),
            dati: [M.url],
        },
        {
            nome: '10 digest news',
            m: messaggioDigestNews({
                mese: 'marzo', anno: 2026,
                articoli: [
                    { categoria: 'Avvisi', titolo: M.bambino, estratto: 'Un estratto marcatore.', url: M.url },
                    { categoria: 'Eventi', titolo: 'Festa di primavera', estratto: 'Altro estratto.', url: M.url },
                ],
            }, sede),
            dati: [M.bambino, 'Un estratto marcatore.', M.url],
        },
        {
            nome: '11 ricevuta iscrizione',
            m: messaggioRicevutaIscrizione({
                riferimento: M.riferimento, inviataIl: M.data, nomeBambino: M.bambino,
                sezione: 'Sezione primavera (2-3 anni)', genitore: M.nome,
            }, sede),
            dati: [M.riferimento, M.data, M.bambino, M.nome, 'Sezione primavera (2-3 anni)'],
        },
        {
            nome: '12 conferma candidatura',
            m: messaggioConfermaCandidatura({ nome: M.nome, inviataIl: M.data, ruolo: 'Educatrice nido', numeroAllegati: 2, giorniRisposta: 30 }, sede),
            dati: [M.nome, M.data, 'Educatrice nido'],
        },
        {
            // ⚠️ IL TREDICESIMO È L'UNICO CHE NON VA A UNA PERSONA: va alla
            // CASELLA DEL PLESSO. Entra comunque in questa suite, e proprio per
            // il controllo che qui conta di più — «due sedi, due email diverse».
            // È il generatore che NOMINA i plessi (`sediScelte`), quindi è quello
            // in cui una perdita fra sedi si vedrebbe per prima, e `sediScelte`
            // si deriva da `sede` invece di essere cablato: cablarlo farebbe
            // passare il test per costruzione, cioè non lo farebbe passare.
            nome: '13 copia della candidatura alla sede',
            m: messaggioCandidaturaAllaSede({
                dati: { nome: M.nome, cognome: 'Rossi', email: 'candidata@example.test', titolo_studio: 'laurea_magistrale' },
                consensi: { presa_visione_informativa: true },
                sediScelte: [sede.nome],
                inviataIl: M.data,
                conCurriculum: true,
            }, sede),
            dati: [M.nome, M.data, 'Laurea magistrale'],
        },
    ]
}

describe('i dodici generatori — il gemello testuale non diverge dall\'HTML', () => {
    for (const { nome, m, dati } of tutti(GIUGLIANO)) {
        it(`${nome}: ogni dato dell'HTML è anche nel testo`, () => {
            for (const d of dati) {
                expect(m.html, `${nome}: «${d}» manca nell'HTML`).toContain(d)
                expect(m.testo, `${nome}: «${d}» è nell'HTML ma NON nel testo`).toContain(d)
            }
        })
    }

    it('ogni messaggio ha oggetto, HTML completo e testo non vuoto', () => {
        for (const { nome, m } of tutti(GIUGLIANO)) {
            expect(m.oggetto.length, nome).toBeGreaterThan(5)
            expect(m.html.startsWith('<!DOCTYPE html>'), nome).toBe(true)
            expect(m.testo.length, nome).toBeGreaterThan(120)
        }
    })

    it('il nome della sede compare in TUTTI e tredici, HTML e testo', () => {
        for (const { nome, m } of tutti(GIUGLIANO)) {
            expect(m.html, nome).toContain('Kidville Giugliano')
            // Tranne la cancellazione account, che di proposito non nomina un
            // plesso: chi chiede di cancellarsi sta ripudiando il rapporto.
            if (!nome.startsWith('09')) expect(m.testo, nome).toContain('Kidville Giugliano')
        }
    })
})

describe('i dodici generatori — due sedi, due email diverse', () => {
    it('nessuna email di una sede nomina l\'altra', () => {
        const g = tutti(GIUGLIANO)
        const c = tutti(CESA)
        for (let i = 0; i < g.length; i++) {
            expect(g[i].m.html, g[i].nome).not.toBe(c[i].m.html)
            expect(g[i].m.html, g[i].nome).not.toContain('Kidville Cesa')
            expect(c[i].m.html, c[i].nome).not.toContain('Kidville Giugliano')
            expect(c[i].m.html, c[i].nome).toContain('Via Filippo Turati 2')
            expect(g[i].m.html, g[i].nome).not.toContain('Via Filippo Turati')
        }
    })
})

describe('i dodici generatori — niente si apre', () => {
    const OSTILE = '<script>alert(1)</script>"><img src=x onerror=1>'
    const sede: ContestoSede = { ...GIUGLIANO, nome: OSTILE, indirizzo: OSTILE, email: OSTILE }

    /** Gli stessi dodici, ma con il payload in OGNI campo stringa. */
    function tuttiOstili(): { nome: string; m: Messaggio }[] {
        return [
            { nome: '01', m: messaggioCredenziali({ nome: OSTILE, email: OSTILE, password: OSTILE, occasione: 'anagrafica-personale-approvata' }, sede) },
            { nome: '02', m: messaggioCodiceVerifica({ codice: OSTILE, operazione: { libera: OSTILE }, minuti: 10 }, sede) },
            {
                nome: '03', m: messaggioSollecito({
                    livello: 2, oggetto: OSTILE, prosa: OSTILE, alunno: OSTILE, causale: OSTILE, iban: OSTILE, intestatario: OSTILE,
                    voci: [{ descrizione: OSTILE, scadenza: OSTILE, giorniRitardo: 3, importo: 1 }],
                }, sede),
            },
            { nome: '06', m: messaggioDocumentoDipendente({ nome: OSTILE, tipoDocumento: OSTILE, scadenza: OSTILE, scaduto: true }, sede) },
            { nome: '07', m: messaggioDocumentoSegreteria({ nome: OSTILE, tipoDocumento: OSTILE, scadenza: OSTILE, scaduto: false, urlAnagrafica: OSTILE }, sede) },
            { nome: '08', m: messaggioEsitoCandidatura({ nome: OSTILE }, sede) },
            { nome: '09', m: messaggioCancellazioneAccount({ urlConferma: OSTILE, oreValidita: 1 }, sede) },
            { nome: '10', m: messaggioDigestNews({ mese: OSTILE, anno: 2026, articoli: [{ categoria: OSTILE, titolo: OSTILE, estratto: OSTILE, url: OSTILE }] }, sede) },
            { nome: '11', m: messaggioRicevutaIscrizione({ riferimento: OSTILE, inviataIl: OSTILE, nomeBambino: OSTILE, sezione: OSTILE, genitore: OSTILE }, sede) },
            { nome: '12', m: messaggioConfermaCandidatura({ nome: OSTILE, inviataIl: OSTILE, ruolo: OSTILE, numeroAllegati: 2, giorniRisposta: 30 }, sede) },
        ]
    }

    it('nessun tag ostile si apre in nessuno dei dodici', () => {
        for (const { nome, m } of tuttiOstili()) {
            expect(m.html, nome).not.toContain('<script')
            expect(m.html, nome).not.toContain('<img src=x')
            // Controllo POSITIVO: senza, un campo semplicemente non stampato
            // renderebbe verde questo test per il motivo sbagliato.
            expect(m.html, nome).toContain('&lt;script&gt;')
        }
    })

    it('il gemello testuale NON scappa: lì non c\'è niente da cui difendersi', () => {
        // Scappare nel testo semplice stamperebbe «&lt;» a chi legge, che è un
        // difetto visibile e non una difesa.
        for (const { nome, m } of tuttiOstili()) {
            expect(m.testo, nome).not.toContain('&lt;')
        }
    })
})

describe('riservatezza — cosa non entra mai in un\'email', () => {
    it('la ricevuta d\'iscrizione non può nemmeno RICEVERE i dati vietati', () => {
        // Non è un controllo sul testo: è il tipo. `DatiRicevutaIscrizione` non
        // ha codice fiscale, data di nascita, allergie, note mediche, indirizzo
        // di casa. Non si può far uscire un dato che il generatore non riceve.
        const m = messaggioRicevutaIscrizione({
            riferimento: 'ISC-1', inviataIl: '01/01/2026 alle 10:00', nomeBambino: 'Luca',
            sezione: 'Primavera', genitore: 'Maria',
        }, GIUGLIANO)
        for (const vietato of ['codice fiscale', 'RSSMRA', 'allergi', 'note mediche', 'data di nascita']) {
            expect(m.html.toLowerCase(), vietato).not.toContain(vietato.toLowerCase())
            expect(m.testo.toLowerCase(), vietato).not.toContain(vietato.toLowerCase())
        }
    })

    it('le due email sui documenti non nominano MAI il numero del documento', () => {
        const dati = { nome: 'Anna Ricci', tipoDocumento: 'Carta d\'identità', scadenza: '12/03/2026', scaduto: true }
        for (const m of [messaggioDocumentoDipendente(dati, GIUGLIANO), messaggioDocumentoSegreteria(dati, GIUGLIANO)]) {
            expect(m.html.toLowerCase()).not.toContain('numero documento')
            expect(m.html.toLowerCase()).not.toContain('codice fiscale')
            expect(m.testo.toLowerCase()).not.toContain('codice fiscale')
        }
    })

    it('la conferma di candidatura conta gli allegati, non li nomina', () => {
        const m = messaggioConfermaCandidatura({ nome: 'Anna', inviataIl: '01/01/2026', numeroAllegati: 2, giorniRisposta: 30 }, GIUGLIANO)
        expect(m.html).toContain('curriculum e 1 documento allegato')
        expect(m.html).not.toContain('.pdf')
        expect(m.html).not.toContain('.jpg')
    })

    it('zero allegati ⇒ la riga non compare, invece di dire «0 allegati»', () => {
        const m = messaggioConfermaCandidatura({ nome: 'Anna', inviataIl: '01/01/2026', numeroAllegati: 0, giorniRisposta: 30 }, GIUGLIANO)
        expect(m.html).not.toContain('Allegati')
    })
})

describe('01 credenziali — la forma impersonale, che è il requisito più duro', () => {
    const m = (nome?: string | null) =>
        messaggioCredenziali({ nome, email: 'a@b.test', password: 'Segreta-finta-2026', occasione: 'anagrafica-personale-approvata' }, GIUGLIANO)

    it('nessuna seconda persona singolare, in nessuna delle quattro occasioni', () => {
        // Questa email va a un genitore (a cui diamo del «tu») E a una maestra (a
        // cui diamo del «lei»). Non può fare né l'uno né l'altro. Il test guarda
        // il gemello testuale, che è il corpo senza marcatori intorno.
        const occasioni = ['iscrizione-approvata', 'inserimento-anagrafica', 'password-rigenerata', 'anagrafica-personale-approvata'] as const
        for (const occasione of occasioni) {
            const t = messaggioCredenziali({ nome: 'Maria', email: 'a@b.test', password: 'x', occasione }, GIUGLIANO).testo
            // Il corpo, senza il piè di pagina (che porta «Ricevi questo messaggio»
            // solo nelle altre email: qui il motivo è già impersonale).
            expect(t, occasione).not.toMatch(/\b(accedi|acceda|conserva|conservi|puoi|può inserire|hai richiesto)\b/i)
            expect(t, occasione).not.toMatch(/\b(la tua|il tuo|la sua|il suo) (password|iscrizione|candidatura)\b/i)
        }
    })

    it('senza nome NON compare un ripiego: nessun «Gentile genitore», nessun «Gentile utente»', () => {
        // Un ripiego sarebbe falso per metà dei destinatari: «Gentile genitore»
        // a una maestra, «Gentile collega» a una famiglia.
        const t = m(null).testo
        expect(t).not.toMatch(/Gentile (genitore|utente|collega|cliente)/i)
        expect(t).toContain('Ecco le credenziali')
    })

    it('col nome, il saluto c\'è e la frase si aggancia', () => {
        expect(m('Maria').testo).toContain('Gentile Maria,\necco le credenziali')
    })

    it('l\'occasione sta nella tab, non dentro una frase che dovrebbe reggerne quattro', () => {
        // Senza l'apostrofo iniziale: `esc()` lo rende `&#39;`, e cercarlo qui
        // proverebbe la codifica dell'HTML invece dell'etichetta.
        expect(m().html).toContain('anagrafica è stata approvata')
        // E il corpo non afferma niente sull'occasione.
        expect(m().testo).not.toContain('benvenuto')
    })

    it('il letterale «Password temporanea:» resta nel testo: ci sono test che lo cercano', () => {
        expect(m('Maria').testo).toContain('Password temporanea:')
    })

    it('non dice mai «area genitori»: va anche al personale', () => {
        for (const t of [m('Maria').testo, m().html]) {
            expect(t).not.toMatch(/area genitori/i)
        }
    })
})

describe('02 codice di verifica — l\'antifurto', () => {
    const m = messaggioCodiceVerifica({ codice: '418297', operazione: 'confermare la giustifica dell\'assenza', minuti: 10 }, GIUGLIANO)

    it('il codice è nel preheader: si legge dalla notifica senza aprire', () => {
        const preheader = m.html.split('mso-hide:all;">')[1]?.split('&nbsp;')[0] ?? ''
        expect(preheader).toContain('418297')
    })

    it('nessun link che completi l\'operazione: chi riceve il codice torna da sé nell\'app', () => {
        // L'unico `<a>` ammesso è nel piè di pagina (privacy) e nel riquadro app.
        const corpo = m.html.split('kv-card')[1]?.split('Informativa privacy')[0] ?? ''
        expect(corpo).not.toContain('<a ')
        expect(corpo).not.toContain('v:roundrect')
    })

    it('la validità è un numero, mai «pochi minuti»', () => {
        expect(m.testo).toContain('valido per 10 minuti')
        expect(m.testo).not.toContain('pochi minuti')
    })

    it('dice che nessuno chiederà mai il codice: è la riga contro il phishing', () => {
        expect(m.testo).toContain('Nessuno di Kidville ti chiederà mai questo codice')
    })
})

describe('03·04·05 solleciti — la gravità sale nel colore, non nel volume', () => {
    const base = {
        oggetto: 'x', prosa: 'Gentile famiglia,\n\nrisulta un pagamento da saldare.', alunno: 'Luca Esposito',
        causale: 'Retta marzo', iban: 'IT60X0542811101000000123456', intestatario: 'La Favola soc. coop.',
        voci: [{ descrizione: 'Retta di marzo', scadenza: '05/03/2026', giorniRitardo: 3, importo: 235 }],
    }
    const liv = (livello: 1 | 2 | 3) => messaggioSollecito({ ...base, livello }, GIUGLIANO)

    it('i tre livelli usano i tre toni: informativo, avviso, errore', () => {
        expect(liv(1).html).toContain('#1D4FA8')
        expect(liv(2).html).toContain('#A64F09')
        expect(liv(3).html).toContain('#C62828')
    })

    it('il terzo è il più CORTO dei tre: non urla, è solo più netto', () => {
        expect(liv(3).testo.length).toBeLessThan(liv(1).testo.length)
        expect(liv(3).testo.length).toBeLessThan(liv(2).testo.length)
    })

    it('nessuno dei tre ha un bottone di pagamento: non esiste un pagamento online', () => {
        for (const l of [1, 2, 3] as const) {
            expect(liv(l).html).not.toMatch(/paga (ora|adesso)/i)
            expect(liv(l).html).not.toContain('Vai al pagamento')
        }
    })

    it('la prosa della sede entra così com\'è: la configurazione resta sovrana', () => {
        const suo = messaggioSollecito({ ...base, livello: 1, prosa: 'Frase scritta dalla segreteria di Giugliano.' }, GIUGLIANO)
        expect(suo.html).toContain('Frase scritta dalla segreteria di Giugliano.')
        expect(suo.testo).toContain('Frase scritta dalla segreteria di Giugliano.')
    })

    it('senza IBAN il riquadro bonifico resta, senza la riga: come fa il sollecito oggi', () => {
        const senza = messaggioSollecito({ ...base, livello: 1, iban: null }, GIUGLIANO)
        expect(senza.html).toContain('Dati per il bonifico')
        expect(senza.html).toContain('Causale')
        expect(senza.html).not.toContain('IBAN')
        expect(senza.testo).not.toContain('IBAN')
    })

    it('un IBAN sbagliato non si mostra affatto: mostrarlo sarebbe peggio che ometterlo', () => {
        const rotto = messaggioSollecito({ ...base, livello: 1, iban: 'IT99X0542811101000000123456' }, GIUGLIANO)
        expect(rotto.html).not.toContain('IT99')
        expect(rotto.html).not.toContain('IBAN')
    })
})

describe('10 digest news — da 1 a 20 articoli', () => {
    const articolo = (i: number) => ({ categoria: i % 3 === 0 ? 'Avvisi' : i % 3 === 1 ? 'Didattica' : 'Eventi', titolo: `Notizia ${i}`, estratto: `Estratto ${i}.`, url: 'https://app.kidville.it/parent/news' })

    it('con UNO non sembra un errore: lo dice l\'apertura', () => {
        const m = messaggioDigestNews({ mese: 'marzo', anno: 2026, articoli: [articolo(0)] }, GIUGLIANO)
        expect(m.html).toContain('Questo mese una sola notizia')
        expect(m.html).toContain('Una notizia da Kidville Giugliano.')
    })

    it('con VENTI non è un muro: raggruppa per categoria', () => {
        const m = messaggioDigestNews({ mese: 'marzo', anno: 2026, articoli: Array.from({ length: 20 }, (_, i) => articolo(i)) }, GIUGLIANO)
        expect(m.html).toContain('20 notizie da Kidville Giugliano.')
        for (const cat of ['Avvisi', 'Didattica', 'Eventi']) expect(m.html).toContain(cat)
        // Venti titoli, tutti presenti in entrambi i corpi.
        for (let i = 0; i < 20; i++) {
            expect(m.html).toContain(`Notizia ${i}`)
            expect(m.testo).toContain(`Notizia ${i}`)
        }
    })

    it('il link di disiscrizione NON c\'è: la pagina che promette non esiste', () => {
        const m = messaggioDigestNews({ mese: 'marzo', anno: 2026, articoli: [articolo(0)] }, GIUGLIANO)
        expect(m.html).not.toContain('/parent/news/preferenze')
        expect(m.html).not.toContain('Non ricevere più')
    })

    it('il nome della sede non è più giallo su verde: quel contrasto era 4,05:1', () => {
        const m = messaggioDigestNews({ mese: 'marzo', anno: 2026, articoli: [articolo(0)] }, GIUGLIANO)
        // Nell'intestazione verde il nome è bianco. Il giallo resta sulla tab,
        // dove l'inchiostro è il verde scuro.
        expect(m.html).toContain('text-transform:uppercase;color:#FFFFFF;">Kidville Giugliano')
        expect(m.html).not.toContain('color:#FDC400')
    })

    it('un articolo senza link non produce un bottone morto', () => {
        const m = messaggioDigestNews({ mese: 'marzo', anno: 2026, articoli: [{ titolo: 'Senza link' }, { titolo: 'Altro' }] }, GIUGLIANO)
        expect(m.html).not.toContain('Leggi in app')
    })
})

describe('11 ricevuta — la prova che si fotografa allo sportello', () => {
    const m = messaggioRicevutaIscrizione({
        riferimento: 'ISC-4F2C1A88', inviataIl: '12/03/2026 alle 18:42', nomeBambino: 'Luca Esposito',
        sezione: 'Sezione primavera (2-3 anni)', genitore: 'Maria Esposito',
    }, GIUGLIANO)

    it('«l\'abbiamo ricevuta» è la PRIMA cosa della scheda, e non è dentro un\'immagine', () => {
        // Il requisito è «senza scorrere e senza caricare immagini»: con le
        // immagini spente, la prima cosa leggibile nella scheda bianca deve
        // essere la rassicurazione.
        const corpo = (m.html.split('padding:30px 28px 34px 28px;">')[1] ?? '').trimStart()
        expect(corpo.startsWith('<p')).toBe(true)
        const primoParagrafo = corpo.slice(0, corpo.indexOf('</p>'))
        expect(primoParagrafo).toContain('L\'abbiamo ricevuta')
        expect(primoParagrafo).not.toContain('<img')
    })

    it('riferimento e data sono monospaziati: si leggono e si ricopiano', () => {
        expect(m.html).toContain('ISC-4F2C1A88')
        expect(m.html).toContain('SFMono-Regular')
    })

    it('la linea del tempo ha la prima tappa accesa e le altre due spente', () => {
        expect(m.testo).toContain('[✓] Ricevuta  →  [ ] In esame  →  [ ] Approvata')
    })

    it('si chiama «Riferimento della domanda», non «Numero di pratica»', () => {
        // Un protocollo vero in questo prodotto esiste già ed è un'altra cosa.
        expect(m.html).toContain('Riferimento della domanda')
        expect(m.html).not.toContain('Numero di pratica')
    })

    it('senza recapiti di sede la frase cambia, invece di restare monca', () => {
        const senza = messaggioRicevutaIscrizione(
            { riferimento: 'x', inviataIl: 'y', nomeBambino: 'Luca' },
            { ...GIUGLIANO, email: null, telefono: null },
        )
        expect(senza.testo).toContain('basta contattare la segreteria di Kidville Giugliano')
        expect(senza.testo).not.toMatch(/procede:\s*\./)
    })
})

describe('08 esito candidatura — il rispetto si esprime togliendo', () => {
    const m = messaggioEsitoCandidatura({ nome: 'Anna Ricci' }, GIUGLIANO)

    it('niente tab gialla, niente mascotte, niente bottone', () => {
        expect(m.html).not.toContain('background:#FDC400')
        expect(m.html).not.toContain('mascot-email.png')
        expect(m.html).not.toContain('v:roundrect')
    })

    it('nessuna motivazione: quello che si dice in segreteria non si scrive alla persona', () => {
        // Il corpo, non il piè di pagina: lì «perché» c'è per forza, ed è la
        // riga che spiega perché il messaggio è arrivato.
        const corpo = m.testo.split('\n--\n')[0]
        expect(corpo).not.toMatch(/perché|poiché|in quanto|il motivo/i)
    })

    it('è breve: cinque righe, non una lettera', () => {
        expect(m.testo.split('\n').filter((r) => r.trim() !== '').length).toBeLessThan(16)
    })
})

describe('09 cancellazione — bilingue in colonna singola, e senza sede', () => {
    const m = messaggioCancellazioneAccount({ urlConferma: 'https://app.kidville.it/x?t=1', oreValidita: 1 }, { ...GIUGLIANO, nome: 'Kidville', indirizzo: null, email: null })

    it('italiano e inglese uno sotto l\'altro, con l\'etichetta di lingua', () => {
        expect(m.html).toContain('>Italiano<')
        expect(m.html).toContain('>English<')
        expect(m.html.indexOf('>Italiano<')).toBeLessThan(m.html.indexOf('>English<'))
    })

    it('il link c\'è come bottone E in chiaro: alcuni client rompono i bottoni', () => {
        expect(m.html).toContain('Confermo la cancellazione')
        expect(m.html).toContain('Confirm deletion')
        expect((m.html.match(/https:\/\/app\.kidville\.it\/x\?t=1/g) ?? []).length).toBeGreaterThanOrEqual(4)
    })

    it('la validità è dichiarata in entrambe le lingue, al singolare quando è una', () => {
        expect(m.html).toContain('1 ora')
        expect(m.html).toContain('1 hour')
        expect(m.html).not.toContain('1 ore')
        expect(m.html).not.toContain('1 hours')
    })

    it('non nomina nessun plesso: chi si cancella sta ripudiando il rapporto', () => {
        expect(m.html).not.toContain('Giugliano')
        expect(m.html).not.toContain('Aversa')
        expect(m.html).not.toContain('Cesa')
    })
})

describe('06·07 documenti — quattro combinazioni, due registri', () => {
    const d = { nome: 'Anna Ricci', tipoDocumento: 'Carta d\'identità', scadenza: '12/03/2026' }

    it('gli oggetti distinguono a colpo d\'occhio scaduto da in scadenza', () => {
        expect(messaggioDocumentoDipendente({ ...d, scaduto: false }, GIUGLIANO).oggetto).toContain('scade il 12/03/2026')
        expect(messaggioDocumentoDipendente({ ...d, scaduto: true }, GIUGLIANO).oggetto).toContain('risulta scaduto')
        expect(messaggioDocumentoSegreteria({ ...d, scaduto: false }, GIUGLIANO).oggetto).toBe('Personale: documento d\'identità in scadenza')
        expect(messaggioDocumentoSegreteria({ ...d, scaduto: true }, GIUGLIANO).oggetto).toBe('Personale: documento d\'identità scaduto')
    })

    it('la variante scaduta usa il colore d\'avviso, quella in scadenza resta neutra', () => {
        expect(messaggioDocumentoDipendente({ ...d, scaduto: true }, GIUGLIANO).html).toContain('#A64F09')
        expect(messaggioDocumentoDipendente({ ...d, scaduto: false }, GIUGLIANO).html).not.toContain('#A64F09')
    })

    it('«SCADUT» in maiuscolo nel gemello testuale: è la stringa che il cron misura', () => {
        expect(messaggioDocumentoDipendente({ ...d, scaduto: true }, GIUGLIANO).testo).toContain('SCADUT')
        expect(messaggioDocumentoSegreteria({ ...d, scaduto: true }, GIUGLIANO).testo).toContain('SCADUT')
    })

    it('alla dipendente si dà del «lei» — anche nell\'oggetto', () => {
        const m = messaggioDocumentoDipendente({ ...d, scaduto: false }, GIUGLIANO)
        expect(m.oggetto).toContain('Il suo documento')
        expect(m.oggetto).not.toContain('Il tuo documento')
    })

    it('senza casella di sede, la 06 non dice «via email a» seguito dal nulla', () => {
        const m = messaggioDocumentoDipendente({ ...d, scaduto: false }, { ...GIUGLIANO, email: null })
        expect(m.testo).toContain('In segreteria di persona.')
        expect(m.testo).not.toContain('via email a .')
    })

    it('alla segreteria senza link non resta un bottone morto', () => {
        const m = messaggioDocumentoSegreteria({ ...d, scaduto: false, urlAnagrafica: null }, GIUGLIANO)
        expect(m.testo).not.toContain('Anagrafica del personale:')
    })
})
