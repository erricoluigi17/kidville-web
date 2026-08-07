import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · «comunicare un'assenza» si dice in UN modo solo, e le due schermate che
 * lo fanno dicono le STESSE parole.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 * Il collaudo del 2026-08-07 ha misurato che la stessa azione aveva QUATTRO nomi
 * — «Segnala assenza» (titolo della pagina), «Comunica un'assenza alla scuola»
 * (sottotitolo, due righe più sotto), «Comunica assenza» (il pulsante), «Nuova
 * assenza» (la card della primaria) — e che le stringhe gemelle delle due
 * schermate divergevano in 5 casi su 7, tutte introdotte nello stesso commit.
 *
 * Le due schermate sono `/parent/attendance` (nido e infanzia, catalogo
 * `parentServizi`, chiavi `attendance*`) e la card di `/parent/primaria/assenze`
 * (catalogo `parentPrimaria`, chiavi `comunica*`). Un genitore con due figli di
 * grado diverso le apre tutte e due lo stesso giorno e vede due prodotti.
 *
 * Perché nessuno strumento poteva vederlo: `messaggi-parita-cataloghi` verifica
 * che it ed en abbiano le stesse CHIAVI, non che due chiavi DIVERSE che dicono la
 * stessa cosa dicano la stessa cosa. Questo lock dichiara le coppie una per una e
 * confronta il testo — che è l'unica cosa che il genitore legge.
 *
 * ─── COSA CONTROLLA ──────────────────────────────────────────────────────────
 *  1. le coppie gemelle dichiarate portano lo stesso testo, in italiano e in
 *     inglese (il NOME del segnaposto non conta: `{data}` e `{giorno}` sono
 *     codice, non parole);
 *  2. il verbo del glossario è UNO: «comunicare». Nessuna delle stringhe di
 *     questa funzione — la pagina, la card, e l'azione rapida della home che ci
 *     porta — usa più «segnalare»;
 *  3. nessuna frase di questa funzione comincia con una parola che nell'app è
 *     una VOCE DI NAVIGAZIONE (era «Avvisi gli insegnanti…», che sotto la barra
 *     con la voce AVVISI si legge come «Avvisi → gli insegnanti»);
 *  4. la conferma d'invio non afferma che qualcuno è stato avvisato: la pagina
 *     NON conosce il numero dei destinatari, che per una sezione senza docenti
 *     collegati è zero.
 *
 * ─── COSA NON CONTROLLA (di proposito) ───────────────────────────────────────
 *  · i due segnaposto del campo «Motivo», che divergono ancora: toccarli è il
 *    rilievo di privacy sul dato sanitario (il segnaposto lo SOLLECITA), e va
 *    fatto insieme all'informazione sul trattamento, non qui;
 *  · l'aiuto sul formato della data (`comunicaDataAiuto`), che esiste solo dove
 *    c'è il campo mascherato: finché la pagina usa l'`<input type="date">`
 *    nativo, una gemella non ce l'ha.
 */

const RADICE = process.cwd()
const leggi = (lingua: string, ns: string): Record<string, string> =>
    JSON.parse(readFileSync(join(RADICE, 'messages', lingua, `${ns}.json`), 'utf8'))

const CAT = {
    it: {
        servizi: leggi('it', 'parentServizi'),
        primaria: leggi('it', 'parentPrimaria'),
        // Namespace nato il 2026-08-08 per le frasi che le DUE schermate condividono
        // davvero (l'informazione sul trattamento del motivo, l'avviso di
        // sovrascrittura): una chiave sola, letta da entrambe. È la strada su cui le
        // 16 coppie qui sotto potranno migrare il giorno in cui si toccheranno i due
        // componenti — finché vivono in due namespace, l'unico modo di tenerle uguali
        // è confrontarle.
        condivise: leggi('it', 'parentAssenze'),
        home: leggi('it', 'home'),
        nav: leggi('it', 'nav'),
    },
    en: {
        servizi: leggi('en', 'parentServizi'),
        primaria: leggi('en', 'parentPrimaria'),
        condivise: leggi('en', 'parentAssenze'),
        home: leggi('en', 'home'),
        nav: leggi('en', 'nav'),
    },
} as const

type Lingua = keyof typeof CAT

/**
 * Le coppie gemelle: stesso ruolo nelle due schermate, quindi stesso testo.
 * `ruolo` è quello che si legge nel rosso: chi lo apre deve capire QUALE momento
 * della funzione sta divergendo senza aprire i due JSON.
 */
const GEMELLE: Array<{ ruolo: string; servizi: string; primaria: string }> = [
    { ruolo: 'il nome dell’azione', servizi: 'attendanceTitolo', primaria: 'comunicaTitolo' },
    { ruolo: 'la frase d’aiuto', servizi: 'attendanceSottotitolo', primaria: 'comunicaHint' },
    { ruolo: 'l’etichetta del campo giorno', servizi: 'attendanceGiorno', primaria: 'comunicaDataLabel' },
    { ruolo: 'l’etichetta del campo motivo', servizi: 'attendanceMotivo', primaria: 'comunicaMotivoLabel' },
    { ruolo: 'il pulsante che invia', servizi: 'attendanceComunicaAssenza', primaria: 'comunicaInvia' },
    { ruolo: 'l’invio in corso', servizi: 'attendanceInvio', primaria: 'comunicaInvio' },
    { ruolo: 'la conferma d’invio', servizi: 'attendanceInviataTitolo', primaria: 'comunicaFatta' },
    { ruolo: 'l’errore d’invio', servizi: 'attendanceErrGenerico', primaria: 'comunicaNonRiuscita' },
    { ruolo: 'il titolo dell’elenco', servizi: 'attendanceElencoTitolo', primaria: 'comunicaElencoTitolo' },
    { ruolo: 'l’elenco vuoto', servizi: 'attendanceElencoVuoto', primaria: 'comunicaElencoVuoto' },
    { ruolo: 'l’elenco non letto', servizi: 'attendanceElencoErrore', primaria: 'comunicaElencoNonLetto' },
    { ruolo: 'il comando che annulla', servizi: 'attendanceAnnulla', primaria: 'comunicaAnnulla' },
    { ruolo: 'l’annullamento in corso', servizi: 'attendanceAnnullamento', primaria: 'comunicaAnnullamento' },
    { ruolo: 'il nome accessibile dell’annulla', servizi: 'attendanceAnnullaAria', primaria: 'comunicaAnnullaAria' },
    { ruolo: 'l’esito dell’annullamento', servizi: 'attendanceAnnullata', primaria: 'comunicaAnnullata' },
    { ruolo: 'l’errore dell’annullamento', servizi: 'attendanceErrAnnulla', primaria: 'comunicaAnnullaNonRiuscito' },
]

/**
 * Il testo come lo legge il genitore: il NOME del segnaposto è codice, non
 * parola. `{data}` e `{giorno}` arrivano dalle due pagine con lo stesso valore
 * già formattato (`f.dataBreve`, «19/08/2026») e pretendere che si chiamino
 * uguali costringerebbe a toccare `src/` per una differenza che nessuno vede.
 */
const senzaNomiDiSegnaposto = (testo: string): string => testo.replace(/\{\s*\w+\s*\}/g, '{}')

/** Le chiavi di questa funzione, lingua per lingua: è il perimetro del glossario. */
function stringheDellaFunzione(lingua: Lingua): Array<{ dove: string; testo: string }> {
    const righe: Array<{ dove: string; testo: string }> = []
    for (const [chiave, valore] of Object.entries(CAT[lingua].servizi)) {
        if (chiave.startsWith('attendance') && typeof valore === 'string') {
            righe.push({ dove: `messages/${lingua}/parentServizi.json → ${chiave}`, testo: valore })
        }
    }
    for (const [chiave, valore] of Object.entries(CAT[lingua].primaria)) {
        if (chiave.startsWith('comunica') && typeof valore === 'string') {
            righe.push({ dove: `messages/${lingua}/parentPrimaria.json → ${chiave}`, testo: valore })
        }
    }
    for (const [chiave, valore] of Object.entries(CAT[lingua].condivise)) {
        if (typeof valore === 'string') {
            righe.push({ dove: `messages/${lingua}/parentAssenze.json → ${chiave}`, testo: valore })
        }
    }
    righe.push({
        dove: `messages/${lingua}/home.json → azioneAssenza`,
        testo: CAT[lingua].home.azioneAssenza,
    })
    return righe
}

/** Le etichette che l'utente vede nella navigazione: parole già occupate. */
function paroleDellaNavigazione(lingua: Lingua): Set<string> {
    const nav = CAT[lingua].nav
    const etichette = Object.entries(nav)
        .filter(([chiave]) => chiave.startsWith('tab') || (chiave.startsWith('voce') && chiave.endsWith('Label')))
        .map(([, valore]) => String(valore).toLowerCase())
    return new Set(etichette)
}

describe('lock localizzazione · una sola azione, un solo nome, le stesse parole', () => {
    it('le due schermate dicono lo stesso testo su ogni momento della funzione (it ed en)', () => {
        const divergenze: string[] = []
        for (const lingua of ['it', 'en'] as const) {
            for (const coppia of GEMELLE) {
                const a = CAT[lingua].servizi[coppia.servizi]
                const b = CAT[lingua].primaria[coppia.primaria]
                expect(typeof a, `manca messages/${lingua}/parentServizi.json → ${coppia.servizi}`).toBe('string')
                expect(typeof b, `manca messages/${lingua}/parentPrimaria.json → ${coppia.primaria}`).toBe('string')
                if (senzaNomiDiSegnaposto(a) !== senzaNomiDiSegnaposto(b)) {
                    divergenze.push(
                        `[${lingua}] ${coppia.ruolo}: parentServizi.${coppia.servizi} = «${a}» ⟶ ` +
                        `parentPrimaria.${coppia.primaria} = «${b}»`,
                    )
                }
            }
        }
        expect(
            divergenze,
            `Le stringhe gemelle delle due schermate dell'assenza comunicata divergono:\n  ` +
            `${divergenze.join('\n  ')}\n` +
            `Sono lo stesso momento della stessa funzione: un genitore con due figli di grado ` +
            `diverso le legge tutte e due. Va scelta UNA formulazione e scritta in entrambi i ` +
            `cataloghi (le due schermate leggono namespace diversi e non possono condividere la ` +
            `chiave senza toccare i componenti).`,
        ).toEqual([])
    })

    it('il verbo del glossario è «comunicare»: «segnalare» non compare più', () => {
        const superstiti: string[] = []
        for (const lingua of ['it', 'en'] as const) {
            for (const { dove, testo } of stringheDellaFunzione(lingua)) {
                if (/segnal/i.test(testo)) superstiti.push(`${dove} = «${testo.replace(/\n/g, '\\n')}»`)
            }
        }
        expect(
            superstiti,
            `Queste voci chiamano l'azione «segnalare» mentre il resto del prodotto — il PRD, la ` +
            `card della primaria, il pulsante — la chiama «comunicare»:\n  ${superstiti.join('\n  ')}\n` +
            `Due verbi per un'azione sola sono due funzioni, per chi legge.`,
        ).toEqual([])
    })

    it('…e «comunicare» c’è per davvero (senza questo, il divieto sopra è verde su un catalogo vuoto)', () => {
        const conIlVerbo = stringheDellaFunzione('it').filter((r) => /comunic/i.test(r.testo))
        expect(conIlVerbo.length).toBeGreaterThanOrEqual(8)
        // E il titolo della pagina è lo stesso della card: è il caso preciso del collaudo.
        expect(CAT.it.servizi.attendanceTitolo).toBe(CAT.it.primaria.comunicaTitolo)
        // L'azione rapida della home porta lo stesso nome: era «Segnala\nassenza», cioè
        // il testo del titolo della pagina. Se divergessero, il genitore toccherebbe una
        // cosa e ne aprirebbe un'altra.
        expect(CAT.it.home.azioneAssenza.replace(/\s+/g, ' ')).toBe(CAT.it.servizi.attendanceTitolo)
    })

    it('nessuna frase comincia con una parola che nell’app è una voce di navigazione', () => {
        // «Avvisi gli insegnanti in anticipo…» sotto una barra che ha la voce AVVISI si
        // legge come «Avvisi → gli insegnanti»: la prima parola è già occupata dal
        // glossario del prodotto, e chi legge in fretta la prende per un'etichetta.
        const ambigue: string[] = []
        for (const lingua of ['it', 'en'] as const) {
            const occupate = paroleDellaNavigazione(lingua)
            for (const { dove, testo } of stringheDellaFunzione(lingua)) {
                const primaParola = testo.trim().split(/[\s,:.;!?]+/)[0] ?? ''
                if (primaParola.length > 1 && occupate.has(primaParola.toLowerCase())) {
                    ambigue.push(`${dove} = «${testo.replace(/\n/g, '\\n')}» → comincia con «${primaParola}»`)
                }
            }
        }
        expect(
            ambigue,
            `Queste frasi cominciano con una parola che è anche una voce di navigazione:\n  ` +
            `${ambigue.join('\n  ')}\n` +
            `Nella stessa schermata quella parola è un comando: la frase si presta a essere ` +
            `letta come un percorso invece che come un'indicazione.`,
        ).toEqual([])
    })

    it('il riconoscitore vede davvero una frase che comincia con una voce di navigazione', () => {
        // Controllo negativo: senza, la prova qui sopra resterebbe verde anche se
        // `paroleDellaNavigazione` tornasse un insieme vuoto.
        const occupate = paroleDellaNavigazione('it')
        expect(occupate.has('avvisi')).toBe(true)
        expect(occupate.has('diario')).toBe(true)
        expect(occupate.has('avvisa')).toBe(false)
    })

    it('la conferma d’invio non afferma che qualcuno è stato avvisato', () => {
        // La pagina NON conosce il numero dei destinatari. La route lo calcola
        // (`nDocenti`) e non lo restituisce: per una sezione senza docenti collegati
        // la notifica parte a ZERO destinatari — è la decisione del titolare, «si
        // registra e non si avvisa nessuno» — e il genitore leggeva comunque «La
        // scuola è stata notificata dell'assenza». Una conferma che mente su un fatto
        // che chi legge non può verificare è peggio di nessuna conferma.
        // (Il calco «notificare qualcuno DI qualcosa» viene da *to notify someone of
        // something*: in italiano si notifica un atto A qualcuno.)
        const it = CAT.it.servizi.attendanceInviataTesto
        const en = CAT.en.servizi.attendanceInviataTesto
        expect(it, `messages/it/parentServizi.json → attendanceInviataTesto = «${it}»`).not.toMatch(
            /notificat|avvisat|informat/i,
        )
        expect(en, `messages/en/parentServizi.json → attendanceInviataTesto = «${en}»`).not.toMatch(/notified|informed/i)
        // Controllo positivo: la frase deve dire il fatto che è VERO in entrambi i casi,
        // cioè che l'assenza è stata registrata.
        expect(it).toMatch(/registrat/i)
        expect(en).toMatch(/record/i)
    })
})
