import { esc, h, unisci, type Html } from '../html'
import { documento, intestazioneTesto, piedeTesto } from '../layout'
import { avviso, h2, nota, p, spazio, tabellaDati, tabMascotte, testo } from '../componenti'
import type { ContestoSede } from '../contesto'
import type { Messaggio } from './tipi'

// =============================================================================
// 06 · 07 — Documento d'identità del personale in scadenza o scaduto.
//
// Lo stesso fatto, due destinatari, due registri:
//   06 → alla DIPENDENTE interessata, «lei», cortese, e soprattutto dice cosa fare;
//   07 → alla SEGRETERIA, asciutta: chi, che documento, che data. Nient'altro.
//
// ─── COSA NON ESCE MAI DA QUESTE DUE EMAIL ──────────────────────────────────
// Il numero del documento e il codice fiscale. Non è una raccomandazione: è già
// la regola del cron che le manda, ed è presidiata da un test che le rilegge
// entrambe. L'email della segreteria in particolare parla di una PERSONA a
// terzi — il minimo indispensabile per capire di cosa si tratta, e non una riga
// in più.
//
// ⚠️ La parola «SCADUT» in maiuscolo, nei gemelli testuali, non è enfasi: è la
// stringa su cui il test del cron misura che la variante grave si distingua da
// quella ordinaria. Se un giorno la si scrive in minuscolo, quel test diventa
// rosso — ed è giusto che lo diventi, perché vuol dire che la distinzione è
// sparita anche per chi legge.
// =============================================================================

export interface DatiDocumentoPersonale {
    /** Nome e cognome della persona. Nell'email 06 è il destinatario, nella 07 il soggetto. */
    nome: string
    /** Etichetta del tipo di documento, es. «Carta d'identità». Mai il numero. */
    tipoDocumento: string
    /** La scadenza già formattata come gg/mm/aaaa. */
    scadenza: string
    scaduto: boolean
}

/* ─────────────────────────────────────────────── 06 · alla dipendente */

export function oggettoDocumentoDipendente(d: DatiDocumentoPersonale): string {
    return d.scaduto
        ? 'Il suo documento d\'identità risulta scaduto'
        : `Il suo documento d'identità scade il ${d.scadenza}`
}

export function messaggioDocumentoDipendente(d: DatiDocumentoPersonale, sede: ContestoSede): Messaggio {
    const titolo = d.scaduto ? 'Documento d\'identità scaduto' : 'Documento d\'identità in scadenza'
    const motivo = `Ricevi questo messaggio perché in Segreteria di ${sede.nome} è depositato un tuo documento in scadenza.`
    const oggetto = oggettoDocumentoDipendente(d)

    const apertura: Html = d.scaduto
        ? h`la ${esc(d.tipoDocumento.toLowerCase())} depositata in Segreteria risulta <strong>scaduta il ${esc(d.scadenza)}</strong>. Per tenere in regola il fascicolo del personale è necessaria una copia del documento rinnovato.`
        : h`la ${esc(d.tipoDocumento.toLowerCase())} depositata in Segreteria <strong>scade il ${esc(d.scadenza)}</strong>. Per tenere in regola il fascicolo del personale serve una copia del documento rinnovato.`

    // Se la sede non ha una casella, la frase cambia: non si scrive «via email a»
    // seguito dal nulla.
    const comeConsegnarla = sede.email
        ? h`In segreteria di persona, oppure via email a <a class="kv-lnk" href="mailto:${esc(sede.email)}" style="color:#006A5F;text-decoration:underline;">${esc(sede.email)}</a>. Va bene una fotografia leggibile del fronte e del retro.`
        : h`In segreteria di persona. Va bene anche una fotografia leggibile del fronte e del retro.`

    const corpo = unisci([
        p(h`Gentile ${esc(d.nome)},`),
        p(apertura),
        d.scaduto
            ? unisci([
                avviso('avviso', h`Finché il documento non viene aggiornato, la Segreteria non può completare le pratiche che lo richiedono.`),
                spazio(18),
            ])
            : ('' as Html),
        tabellaDati([
            { etichetta: 'Documento', valore: d.tipoDocumento },
            { etichetta: 'Scadenza', valore: d.scadenza },
            { etichetta: 'Stato', valore: d.scaduto ? 'Scaduto' : 'In scadenza' },
        ]),
        h2('Come consegnarla'),
        p(comeConsegnarla, { dimensione: 15 }),
        nota(h`La copia sostituisce quella agli atti e viene conservata nel fascicolo personale.`),
    ])

    return {
        oggetto,
        html: documento(sede, {
            oggetto,
            preheader: d.scaduto
                ? 'Il documento agli atti è scaduto: serve una copia di quello rinnovato.'
                : 'Il documento agli atti scade fra pochi giorni: come consegnare quello nuovo.',
            tab: tabMascotte({ occhiello: 'Personale', titolo }),
            corpo,
            motivo,
        }),
        testo: [
            intestazioneTesto(titolo, sede),
            '',
            `Gentile ${d.nome},`,
            d.scaduto
                ? `la ${d.tipoDocumento.toLowerCase()} depositata in Segreteria risulta SCADUTA il ${d.scadenza}. Per tenere in regola il fascicolo del personale è necessaria una copia del documento rinnovato.\n\nFinché il documento non viene aggiornato, la Segreteria non può completare le pratiche che lo richiedono.`
                : `la ${d.tipoDocumento.toLowerCase()} depositata in Segreteria scade il ${d.scadenza}. Per tenere in regola il fascicolo del personale serve una copia del documento rinnovato.`,
            '',
            `  Documento:  ${d.tipoDocumento}`,
            `  Scadenza:   ${d.scadenza}`,
            `  Stato:      ${d.scaduto ? 'SCADUTO' : 'In scadenza'}`,
            '',
            'COME CONSEGNARLA',
            sede.email
                ? `In segreteria di persona, oppure via email a ${sede.email}. Va bene una fotografia leggibile del fronte e del retro.`
                : 'In segreteria di persona. Va bene anche una fotografia leggibile del fronte e del retro.',
            '',
            'La copia sostituisce quella agli atti e viene conservata nel fascicolo personale.',
            '',
            piedeTesto(sede, motivo),
        ].join('\n'),
    }
}

/* ─────────────────────────────────────────────── 07 · alla segreteria */

export function oggettoDocumentoSegreteria(d: DatiDocumentoPersonale): string {
    return d.scaduto
        ? 'Personale: documento d\'identità scaduto'
        : 'Personale: documento d\'identità in scadenza'
}

export interface DatiDocumentoSegreteria extends DatiDocumentoPersonale {
    /** Il link all'anagrafica del personale. Assente ⇒ nessun bottone morto. */
    urlAnagrafica?: string | null
}

export function messaggioDocumentoSegreteria(d: DatiDocumentoSegreteria, sede: ContestoSede): Messaggio {
    const motivo = `Notifica automatica di sorveglianza documenti — ${sede.nome}.`
    const oggetto = oggettoDocumentoSegreteria(d)
    const titolo = d.scaduto ? 'Documento scaduto' : 'Documento in scadenza'

    const corpo = unisci([
        testo(d.scaduto ? 'Documento del personale scaduto.' : 'Documento del personale in scadenza.', { dimensione: 15 }),
        tabellaDati([
            { etichetta: 'Persona', valore: d.nome },
            { etichetta: 'Documento', valore: d.tipoDocumento },
            { etichetta: 'Scadenza', valore: d.scadenza },
            { etichetta: 'Stato', valore: d.scaduto ? 'Scaduto' : 'In scadenza' },
        ]),
        spazio(16),
        d.urlAnagrafica
            ? nota(h`Anagrafica del personale: <a class="kv-lnk" href="${esc(d.urlAnagrafica)}" style="color:#006A5F;text-decoration:underline;">${esc(d.urlAnagrafica)}</a>`)
            : ('' as Html),
        nota(h`Notifica generata dalla sorveglianza documenti. L'interessata ha ricevuto la comunicazione corrispondente.`),
    ])

    return {
        oggetto,
        html: documento(sede, {
            oggetto,
            preheader: `${d.nome} — ${d.tipoDocumento.toLowerCase()} ${d.scaduto ? 'scaduta' : 'in scadenza'} il ${d.scadenza}.`,
            tab: tabMascotte({ occhiello: 'Segreteria', titolo, compatta: true }),
            corpo,
            motivo,
        }),
        testo: [
            intestazioneTesto(d.scaduto ? 'Personale: documento SCADUTO' : 'Personale: documento in scadenza', sede),
            '',
            `  Persona:    ${d.nome}`,
            `  Documento:  ${d.tipoDocumento}`,
            `  Scadenza:   ${d.scadenza}`,
            `  Stato:      ${d.scaduto ? 'SCADUTO' : 'In scadenza'}`,
            '',
            ...(d.urlAnagrafica ? [`Anagrafica del personale: ${d.urlAnagrafica}`, ''] : []),
            'Notifica generata dalla sorveglianza documenti. L\'interessata ha ricevuto la comunicazione corrispondente.',
            '',
            piedeTesto(sede, motivo),
        ].join('\n'),
    }
}
