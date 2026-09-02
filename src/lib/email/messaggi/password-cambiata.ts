import { esc, h, unisci, type Html } from '../html'
import { documento, intestazioneTesto, piedeTesto } from '../layout'
import { avviso, nota, p, tabMascotte, tabellaDati, type RigaDati } from '../componenti'
import type { ContestoSede } from '../contesto'
import type { Messaggio } from './tipi'

// =============================================================================
// 14 · La password è stata cambiata.
//
// ─── A COSA SERVE DAVVERO ───────────────────────────────────────────────────
// Non a informare chi ha cambiato la password: quello lo sa già, l’ha appena
// fatto. Serve a chi NON l’ha cambiata. È l’unico modo in cui il proprietario di
// un account scopre che qualcun altro ci è entrato — e per questo la riga che
// conta non è l’annuncio, è il presidio: «Se il cambio non è stato richiesto,
// conviene contattare la segreteria di {sede}». Un avviso che dice solo «fatto»
// e non dice cosa fare quando non è stato lui è una notifica, non un presidio.
//
// ─── PERCHÉ È IMPERSONALE, COME LA 01 ───────────────────────────────────────
// Parte dallo stesso posto della 01 e arriva alle stesse due platee: a un
// GENITORE, a cui questo prodotto dà del «tu», e a una MAESTRA, a cui dà del
// «lei». Una email sola non può fare tutti e due, e sceglierne uno significa
// suonare sgarbati con metà dei destinatari. Quindi nessuna seconda persona:
// non «hai cambiato la password» né «ha cambiato la password», ma «la password
// è stata cambiata». C’è un test che lo misura riga per riga.
//
// ─── COSA NON C’È DENTRO, E NON PER DISCIPLINA ──────────────────────────────
// La password nuova non compare, in nessuna forma: né il valore, né un pezzo,
// né la lunghezza («è di 12 caratteri» dice già troppo a chi legge la posta di
// qualcun altro). E non è una regola che qualcuno deve ricordarsi di rispettare
// mentre scrive: `DatiPasswordCambiata` non ha un campo per riceverla. Non si fa
// uscire un dato che il generatore non ha — è la stessa difesa della ricevuta
// d’iscrizione, che non può nominare un’allergia perché non le viene passata.
//
// ─── NESSUN LINK NEL CORPO ──────────────────────────────────────────────────
// Nemmeno «vai all’area riservata». È il punto 3 della 02, e qui vale di più:
// un’email di sicurezza con dentro un bottone insegna alle famiglie esattamente
// l’abitudine su cui campa il phishing — cliccare il link che arriva per posta
// quando qualcuno dice che c’è un problema con l’account. Chi deve reagire torna
// da sé nell’app, o chiama la segreteria: il recapito è nel piè di pagina.
//
// ─── LA SEDE STA NEL CORPO, NON SOLO NELLA CARTA INTESTATA ──────────────────
// Dal 2026-07-29 i plessi sono tre. «La password di Kidville è stata cambiata»
// non identifica un account: chi ha un figlio a Giugliano e insegna ad Aversa ha
// due accessi, e deve sapere quale dei due è stato toccato.
// =============================================================================

export interface DatiPasswordCambiata {
    /** Nome di chi possiede l’account. Può mancare: il saluto degrada. */
    nome?: string | null
    /**
     * Quando è avvenuto il cambio, GIÀ FORMATTATO per un essere umano
     * («12/03/2026 alle 18:42»). Come `inviataIl` nella 11 e nella 12: questi
     * generatori sono funzioni pure e non conoscono né fusi orari né locale —
     * la formattazione la fa chi chiama, con `formattaIstante(…, 'it', …)`, che
     * è il punto unico del progetto per scrivere una data italiana.
     */
    avvenutoIl: string
}

/**
 * ⚠️ Niente «Attenzione», niente «Urgente», niente punto esclamativo.
 *
 * L’oggetto lo legge, per lo più, la persona che ha appena cambiato la password
 * da sé: allarmarla sarebbe falso nove volte su dieci. Dice il fatto, e il fatto
 * basta a far aprire il messaggio a chi invece non ha cambiato niente.
 */
export const OGGETTO_PASSWORD_CAMBIATA = 'La password è stata cambiata — Kidville'

export function messaggioPasswordCambiata(d: DatiPasswordCambiata, sede: ContestoSede): Messaggio {
    const motivo = `Questo messaggio è stato inviato perché la password dell’area riservata di ${sede.nome} è stata cambiata.`

    // La riga di presidio, in un posto solo: HTML e gemello testuale la
    // prendono da qui. Due copie della stessa frase divergono, e quando
    // divergono vince quella sbagliata.
    const presidio = `Se il cambio non è stato richiesto, conviene contattare la segreteria di ${sede.nome}`

    // Con il nome: «Gentile Maria, / la password…». Senza: «La password…».
    // Nessun ripiego tipo «Gentile genitore»: sarebbe falso per una maestra, e
    // «Gentile utente» è peggio del silenzio. È la scelta già presa nella 01.
    const saluto = d.nome ? p(h`Gentile ${esc(d.nome)},`) : ('' as Html)
    const apertura = d.nome ? 'la' : 'La'
    const annuncio = `${apertura} password dell’area riservata di`
    const seguito = 'è stata cambiata. Da questo momento l’accesso funziona soltanto con la password nuova.'

    // Le due sole cose che questa email sa, e sono anche le due che servono a
    // dire «non ero io»: quando, e su quale plesso.
    const righe: RigaDati[] = [
        { etichetta: 'Quando', valore: d.avvenutoIl, mono: true },
        { etichetta: 'Sede', valore: sede.nome },
    ]

    const corpo = unisci([
        saluto,
        p(h`${esc(annuncio)} <strong>${esc(sede.nome)}</strong> ${esc(seguito)}`),
        tabellaDati(righe),
        // Tono `avviso` e non `errore`: nella stragrande maggioranza dei casi il
        // cambio è legittimo, e un riquadro rosso su un’operazione normale
        // insegna a ignorare i riquadri rossi. Il grassetto sta sull’azione,
        // perché è l’unica cosa da fare in tutta l’email.
        avviso('avviso', h`<strong>${esc(presidio)}</strong>: l’accesso va rimesso in sicurezza subito.`),
        nota(h`Questo messaggio non riporta la password: nessuna email di Kidville la contiene. Nessuno di Kidville chiede mai la password, né per telefono, né per email, né in chat.`),
    ])

    return {
        oggetto: OGGETTO_PASSWORD_CAMBIATA,
        html: documento(sede, {
            oggetto: OGGETTO_PASSWORD_CAMBIATA,
            // I due punti e non «il»: `avvenutoIl` è testo di chi chiama, e
            // «cambiata il oggi alle 18:42» è il genere di frase che nasce
            // quando si incolla un valore dentro una frase fissa.
            preheader: `La password dell’area riservata di ${sede.nome} è stata cambiata: ${d.avvenutoIl}.`,
            tab: tabMascotte({ occhiello: 'Sicurezza', titolo: 'Password cambiata', compatta: true }),
            corpo,
            motivo,
            // Nessun invito a cliccare in un’email che parla di un accesso:
            // nemmeno sul logo. Stessa ragione della 02.
            logoCliccabile: false,
        }),
        testo: [
            intestazioneTesto('Password cambiata', sede),
            '',
            // Saluto e frase sulla STESSA voce dell’elenco: vanno a capo una
            // sotto l’altra, senza la riga vuota che le separerebbe in due
            // blocchi. È la forma già usata dalla 01.
            `${d.nome ? `Gentile ${d.nome},\nla` : 'La'} password dell’area riservata di ${sede.nome} ${seguito}`,
            '',
            ...righe.map((r) => `  ${(r.etichetta + ':').padEnd(10)}${r.valore}`),
            '',
            `${presidio}: l’accesso va rimesso in sicurezza subito.`,
            '',
            'Questo messaggio non riporta la password: nessuna email di Kidville la contiene. Nessuno di Kidville chiede mai la password, né per telefono, né per email, né in chat.',
            '',
            piedeTesto(sede, motivo),
        ].join('\n'),
    }
}
