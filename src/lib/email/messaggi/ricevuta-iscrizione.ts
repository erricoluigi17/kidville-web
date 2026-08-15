import { esc, h, unisci, type Html } from '../html'
import { documento, intestazioneTesto, piedeTesto } from '../layout'
import {
    h2, nota, p, riquadroApp, riquadroAppTesto, spazio, tabellaDati, tabMascotte,
    tappe, tappeTesto, type RigaDati,
} from '../componenti'
import type { ContestoSede } from '../contesto'
import type { Messaggio } from './tipi'

// =============================================================================
// 11 · Ricevuta d'iscrizione — NUOVA.
//
// ─── IL BUCO CHE COLMA ──────────────────────────────────────────────────────
// Fino a oggi una famiglia compilava il modulo pubblico, firmava con un codice e
// NON RICEVEVA NIENTE. Nessuna conferma, nessun riepilogo, nessuna idea di cosa
// sarebbe successo. Misurato il 2026-08-15: 387 domande registrate, 381 con un
// indirizzo email valorizzato. Trecentottantuno ricevute che si potevano
// mandare e non sono partite — e la prima impressione della scuola, per tutte
// quelle famiglie, è stata un silenzio.
//
// ─── LE QUATTRO COSE CHE DEVE FARE, IN QUEST'ORDINE ─────────────────────────
//  1. RASSICURARE. «L'abbiamo ricevuta» è la prima cosa visibile, senza scorrere
//     e senza caricare immagini.
//  2. DARE UNA PROVA. Riferimento della domanda e data d'invio, in un riquadro
//     compatto pensato per essere FOTOGRAFATO e mostrato allo sportello.
//  3. RIEPILOGARE. E qui si veda il blocco sotto: è la parte pericolosa.
//  4. DIRE COSA SUCCEDE ADESSO, con tempi realistici e un recapito.
//
// ─── ⚠️ COSA NON ENTRA MAI IN QUESTA EMAIL ──────────────────────────────────
// Solo nome del bambino, sede scelta, sezione e genitore richiedente. NIENT'ALTRO.
// Niente codice fiscale, niente data di nascita, niente allergie, niente note
// mediche, niente indirizzo di casa, niente recapiti.
//
// Non è prudenza generica: sono dati di un minore, e questa email finisce in una
// casella di posta che non controlliamo, spesso condivisa fra due o tre persone
// in famiglia. Il modulo d'iscrizione raccoglie molto di più — e il fatto che il
// dato sia disponibile nello scope non è una ragione per stamparlo.
//
// Il tipo `DatiRicevutaIscrizione` non ha proprio i campi vietati: non si può
// far uscire un dato che il generatore non riceve.
//
// ─── IL RIFERIMENTO NON È UN NUMERO DI PROTOCOLLO ───────────────────────────
// `enrollment_submissions.id` è un uuid, illeggibile e infotografabile. Se ne
// mostra un estratto breve, ed è etichettato «Riferimento della domanda» e non
// «Numero di pratica»: perché è un riferimento, non un protocollo. Un protocollo
// vero in questo prodotto esiste già ed è un'altra cosa — chiamare così questo
// campo confonderebbe due registri.
// =============================================================================

export interface DatiRicevutaIscrizione {
    /** Riferimento breve e leggibile, derivato dall'id della domanda. */
    riferimento: string
    /** Data e ora d'invio già formattate in Europe/Rome, es. «12/03/2026 alle 18:42». */
    inviataIl: string
    nomeBambino: string
    /** Fascia o sezione scelta. Assente ⇒ la riga si omette. */
    sezione?: string | null
    /** Nome del genitore richiedente. Assente ⇒ la riga si omette. */
    genitore?: string | null
}

export function oggettoRicevutaIscrizione(d: Pick<DatiRicevutaIscrizione, 'nomeBambino'>): string {
    return `Abbiamo ricevuto l'iscrizione di ${d.nomeBambino}`
}

export function messaggioRicevutaIscrizione(d: DatiRicevutaIscrizione, sede: ContestoSede): Messaggio {
    const oggetto = oggettoRicevutaIscrizione(d)
    const motivo = `Ricevi questo messaggio perché è stata inviata una domanda d'iscrizione a ${sede.nome}.`

    const dichiarato: RigaDati[] = [
        { etichetta: 'Bambino', valore: d.nomeBambino },
        { etichetta: 'Sede scelta', valore: sede.nome },
        ...(d.sezione ? [{ etichetta: 'Sezione', valore: d.sezione }] : []),
        ...(d.genitore ? [{ etichetta: 'Genitore richiedente', valore: d.genitore }] : []),
    ]

    // Il recapito per segnalare un errore: la frase cambia in base a cosa c'è,
    // invece di incollare valori vuoti dentro una frase fissa.
    const recapiti = [sede.telefono, sede.email].filter((v): v is string => !!v)
    const perSegnalare: Html = recapiti.length > 0
        ? h`Per segnalare un errore o chiedere come procede: ${esc(recapiti.join(' — '))}.`
        : h`Per segnalare un errore o chiedere come procede, basta contattare la segreteria di ${esc(sede.nome)}.`

    const corpo = unisci([
        p(h`L'abbiamo ricevuta. La domanda è arrivata in segreteria e non serve fare altro per ora.`),
        tabellaDati([
            { etichetta: 'Riferimento della domanda', valore: d.riferimento, mono: true },
            { etichetta: 'Inviata il', valore: d.inviataIl, mono: true },
        ]),
        spazio(18),
        tappe(['Ricevuta', 'In esame', 'Approvata'], 0),
        h2('Cosa hai dichiarato'),
        tabellaDati(dichiarato),
        spazio(12),
        nota(h`Se uno di questi dati è sbagliato, basta chiamare la segreteria: si corregge in un minuto, senza rifare la domanda.`),
        h2('Cosa succede adesso'),
        p(h`<strong>Entro cinque giorni lavorativi</strong> la segreteria esamina la domanda e controlla i posti disponibili nella sezione scelta.<br><strong>Poi ti chiamiamo o ti scriviamo</strong>, anche se manca qualcosa o se serve un colloquio.<br><strong>All'approvazione</strong> arrivano per email le credenziali dell'area genitori, dove poi trovi comunicazioni, moduli e pagamenti.`, { dimensione: 15 }),
        p(perSegnalare, { dimensione: 15 }),
        riquadroApp(sede, {
            titolo: 'Intanto: scarica l\'app',
            introduzione: h`All'approvazione l'area genitori si apre qui dentro. Conviene averla già pronta: è gratuita su App Store e Google Play.`,
        }),
    ])

    return {
        oggetto,
        html: documento(sede, {
            oggetto,
            preheader: `Domanda ${d.riferimento} registrata il ${d.inviataIl}. Ecco cosa succede adesso.`,
            tab: tabMascotte({
                occhiello: 'Iscrizioni',
                titolo: 'Domanda ricevuta',
                sottotitolo: `${d.riferimento} · ${d.inviataIl}`,
            }),
            corpo,
            motivo,
        }),
        testo: [
            intestazioneTesto('Abbiamo ricevuto l\'iscrizione', sede),
            '',
            'L\'abbiamo ricevuta. La domanda è arrivata in segreteria e non serve fare altro per ora.',
            '',
            `  Riferimento della domanda:  ${d.riferimento}`,
            `  Inviata il:                 ${d.inviataIl}`,
            '',
            `  ${tappeTesto(['Ricevuta', 'In esame', 'Approvata'], 0)}`,
            '',
            'COSA HAI DICHIARATO',
            ...dichiarato.map((r) => `  ${(r.etichetta + ':').padEnd(24)}${r.valore}`),
            '',
            'Se uno di questi dati è sbagliato, basta chiamare la segreteria: si corregge in un minuto, senza rifare la domanda.',
            '',
            'COSA SUCCEDE ADESSO',
            'Entro cinque giorni lavorativi la segreteria esamina la domanda e controlla i posti disponibili nella sezione scelta.',
            'Poi ti chiamiamo o ti scriviamo, anche se manca qualcosa o se serve un colloquio.',
            'All\'approvazione arrivano per email le credenziali dell\'area genitori, dove poi trovi comunicazioni, moduli e pagamenti.',
            '',
            recapiti.length > 0
                ? `Per segnalare un errore o chiedere come procede: ${recapiti.join(' — ')}.`
                : `Per segnalare un errore o chiedere come procede, basta contattare la segreteria di ${sede.nome}.`,
            '',
            riquadroAppTesto(sede, 'All\'approvazione l\'area genitori si apre qui dentro. Conviene averla già pronta: è gratuita su App Store e Google Play.'),
            '',
            piedeTesto(sede, motivo),
        ].join('\n'),
    }
}
