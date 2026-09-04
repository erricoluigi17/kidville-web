import { esc, h, unisci, type Html } from '../html'
import { documento, intestazioneTesto, piedeTesto } from '../layout'
import {
    avviso, bottone, linkDiScorta, nota, p, riga, riquadroApp, riquadroAppTesto,
    riquadroCredenziali, tabMascotte, testo, h2,
} from '../componenti'
import type { ContestoSede } from '../contesto'
import type { Messaggio } from './tipi'

// =============================================================================
// 01 · Credenziali di accesso — UNA SOLA EMAIL, IDENTICA PER TUTTI
//
// ─── PERCHÉ UNA SOLA, E PERCHÉ IMPERSONALE ──────────────────────────────────
// Questa email parte in quattro momenti diversi e verso due pubblici diversi:
// a un GENITORE quando la domanda d'iscrizione viene approvata, a un GENITORE
// quando la segreteria lo inserisce a mano in anagrafica, a un GENITORE che
// chiede la password nuova, e a una MAESTRA quando la candidatura viene accolta.
//
// Ai genitori questo prodotto dà del «tu», al personale del «lei». Una email
// sola non può fare tutti e due, e sceglierne uno significa suonare sgarbati con
// metà dei destinatari. Quindi: **forma impersonale, nessuna seconda persona
// singolare**. Non «accedi da qui» né «acceda da qui», ma «l'accesso avviene da
// questo indirizzo». È il requisito di scrittura più duro dell'intero sistema, e
// c'è un test che lo misura riga per riga.
//
// ─── COSA QUESTA EMAIL NON PUÒ DIRE ─────────────────────────────────────────
// Non può dire PERCHÉ è arrivata. «Benvenuto», «la sua candidatura è stata
// accolta», «la password è stata reimpostata» sarebbero false in tre casi su
// quattro. L'apertura deve essere vera in tutti e quattro, e l'occasione — che
// il chiamante conosce — sta nel sottotitolo della tab, dove è un'etichetta e
// non un'affermazione dentro una frase.
//
// Proprio perché non spiega l'occasione, compensa con l'ORIENTAMENTO: cos'è
// l'area riservata, cosa ci si trova. E chiude con la riga che è l'unico
// presidio contro un invio a un indirizzo sbagliato.
//
// ─── PRIMA C'ERANO DUE CORPI ────────────────────────────────────────────────
// `credentialsEmailBody` (genitore, «tu») e `corpoCredenzialiStaff` (personale,
// «lei»). Erano stati separati per una ragione giusta — riusare quello del
// genitore avrebbe scritto «Gentile genitore … la tua iscrizione» a chi si
// candida per lavorare — e il test `candidature-insegnanti-approva` lo presidia
// ancora. La forma impersonale risolve lo stesso problema senza due copie che
// divergono.
// =============================================================================

/**
 * L'occasione in cui l'email parte. È l'UNICA leva che i quattro chiamanti
 * hanno, ed è un'unione chiusa e non testo libero: con una stringa aperta il
 * registro impersonale scapperebbe dalla porta di servizio, un chiamante alla
 * volta.
 */
export type OccasioneCredenziali =
    | 'iscrizione-approvata'
    | 'inserimento-anagrafica'
    | 'password-rigenerata'
    | 'anagrafica-personale-approvata'

/**
 * L'etichetta dell'occasione. Sta nel sottotitolo della tab gialla, dove è una
 * didascalia — non una frase del corpo, che dovrebbe reggere quattro verità
 * diverse.
 *
 * ⚠️ `candidatura-accolta` NON C'È PIÙ, dal 2026-08-15, e non è un rinomino.
 * Approvare una candidatura non fa più nascere nessun account e non spedisce
 * nessuna password: la selezione si chiude e basta. L'accesso nasce in un posto
 * solo — l'approvazione dell'ANAGRAFICA del personale, dove la Direzione ha in
 * mano i documenti della persona — e l'occasione qui sotto è quella. Un'unione
 * chiusa serve proprio a questo: il chiamante che sparisce si porta via la sua
 * voce, invece di lasciarla in giro pronta a essere riusata per sbaglio.
 */
const ETICHETTA: Record<OccasioneCredenziali, string> = {
    'iscrizione-approvata': 'L\'iscrizione è stata approvata: l\'area genitori è ora attiva.',
    'inserimento-anagrafica': 'L\'anagrafica è stata completata: l\'area genitori è ora attiva.',
    'password-rigenerata': 'La password è stata rigenerata come richiesto.',
    'anagrafica-personale-approvata': 'L\'anagrafica è stata approvata: l\'area del personale è ora attiva.',
}

export interface DatiCredenziali {
    /** Può mancare: il saluto degrada senza lasciare un buco. */
    nome?: string | null
    email: string
    password: string
    occasione: OccasioneCredenziali
    /**
     * Quando questa password è stata generata, GIÀ FORMATTATO per un essere umano
     * («4 settembre 2026 alle 14:32»). Come `avvenutoIl` nella 12: questi
     * generatori sono funzioni pure e non conoscono né fusi orari né locale.
     *
     * ⚠️ NON È UN ORPELLO. Misurato in produzione il 2026-09-04: 9 persone hanno
     * ricevuto fra 2 e 13 emissioni di credenziali, e per 6 di loro il login
     * riesce solo dopo l'ULTIMA. Con tredici messaggi identici in casella, e lo
     * stesso oggetto su tutti, l'istante è l'unica cosa che permette di
     * riconoscere quello che vale.
     */
    emessaIl: string
}

export const OGGETTO_CREDENZIALI = 'Credenziali di accesso — Kidville'

export function messaggioCredenziali(d: DatiCredenziali, sede: ContestoSede): Messaggio {
    const login = `${sede.app}/auth/login`
    const motivo = `Questo messaggio è stato inviato perché è stato aperto o aggiornato un accesso all'area riservata di ${sede.nome}.`

    // Con il nome: «Gentile Maria, ecco le credenziali…». Senza: «Ecco le
    // credenziali…». Nessun ripiego tipo «Gentile genitore»: sarebbe falso per
    // una maestra, e «Gentile utente» è peggio del silenzio.
    const saluto = d.nome ? p(h`Gentile ${esc(d.nome)},`) : ('' as Html)
    const apertura = d.nome ? 'ecco' : 'Ecco'

    const corpo = unisci([
        saluto,
        p(h`${esc(apertura)} le credenziali per accedere all'area riservata di <strong>${esc(sede.nome)}</strong>. Vanno conservate in un posto sicuro.`),
        riquadroCredenziali(d.email, d.password),
        // ⚠️ QUANDO, e CHE COSA ANNULLA — le due righe che spiegano tredici corse
        // a vuoto. Quando la Segreteria rigenera mentre la famiglia sta digitando,
        // la password che ha in mano muore in quell'istante e nessuno glielo dice.
        // L'`occasione` distingue i due casi: alla prima emissione non c'è nessuna
        // password precedente, e dire che se ne annullano farebbe dubitare di
        // qualcosa che non è mai esistito.
        p(
            d.occasione === 'password-rigenerata'
                ? h`Password generata il <strong>${esc(d.emessaIl)}</strong>. <strong>Annulla quelle inviate prima:</strong> se in casella ce ne sono altre, vale solo questa.`
                : h`Password generata il <strong>${esc(d.emessaIl)}</strong>.`,
        ),
        avviso('info', h`Si entra con la password qui sopra, e subito dopo il sistema ne fa scegliere una nuova. Quella temporanea serve solo per la prima volta.`),
        bottone(login, 'Vai all\'area riservata'),
        linkDiScorta(login, 'Se il bottone non funziona, l\'accesso avviene da'),
        riga(),
        h2('Cosa si trova nell\'area riservata'),
        testo('Le comunicazioni della sede, i moduli da firmare, i documenti e la situazione dei pagamenti. È lo stesso indirizzo da telefono e da computer: l\'accesso resta valido su entrambi.'),
        riquadroApp(sede, {
            introduzione: h`L'area riservata è anche un'app gratuita: si cerca <strong>Kidville</strong> su App Store o Google Play, e si entra con le credenziali qui sopra.`,
        }),
        nota(h`Se non è stato richiesto questo accesso, conviene <strong>contattare la segreteria di ${esc(sede.nome)}</strong> e non usare le credenziali: verranno annullate.`),
    ])

    return {
        oggetto: OGGETTO_CREDENZIALI,
        html: documento(sede, {
            oggetto: OGGETTO_CREDENZIALI,
            preheader: `Email e password temporanea per l'area riservata di ${sede.nome}, più i passaggi per il primo accesso.`,
            tab: tabMascotte({ occhiello: 'Area riservata', titolo: 'Credenziali di accesso', sottotitolo: ETICHETTA[d.occasione] }),
            corpo,
            motivo,
        }),
        testo: [
            intestazioneTesto('Credenziali di accesso', sede),
            '',
            ETICHETTA[d.occasione],
            '',
            `${d.nome ? `Gentile ${d.nome},\necco` : 'Ecco'} le credenziali per accedere all'area riservata di ${sede.nome}. Vanno conservate in un posto sicuro.`,
            '',
            // Le due etichette con i due punti sono le stesse dell'HTML e sono
            // ciò che chi legge in testo semplice cerca con gli occhi.
            //
            // ⚠️ IL VALORE STA DA SOLO SULLA SUA RIGA, e non è impaginazione. Fino al
            // 2026-08-22 la riga era `  Password temporanea:   <pwd>`: su un telefono
            // la selezione si fa col dito, e il dito prende LA RIGA. Chi copiava si
            // portava via l'etichetta, o l'indentazione, o uno spazio in coda — e il
            // login rispondeva «credenziali non valide» a una password giusta. Quel
            // giorno 30 famiglie su 67 non sono entrate. Niente davanti, niente dopo:
            // la riga È il valore.
            'Email di accesso:',
            d.email,
            'Password temporanea:',
            d.password,
            '',
            // Fuori dal blocco etichetta/valore qui sopra: quel valore sta da solo
            // sulla sua riga per una ragione misurata (30 famiglie su 67, 22/08), e
            // niente deve avvicinarglisi.
            d.occasione === 'password-rigenerata'
                ? `Password generata il ${d.emessaIl}. Annulla quelle inviate prima: se in casella ce ne sono altre, vale solo questa.`
                : `Password generata il ${d.emessaIl}.`,
            '',
            'Si entra con la password qui sopra, e subito dopo il sistema ne fa scegliere una nuova. Quella temporanea serve solo per la prima volta.',
            '',
            'Accesso all\'area riservata:',
            login,
            '',
            'COSA SI TROVA NELL\'AREA RISERVATA',
            'Le comunicazioni della sede, i moduli da firmare, i documenti e la situazione dei pagamenti. È lo stesso indirizzo da telefono e da computer: l\'accesso resta valido su entrambi.',
            '',
            riquadroAppTesto(sede, 'L\'area riservata è anche un\'app gratuita: si cerca "Kidville" su App Store o Google Play, e si entra con le credenziali qui sopra.'),
            '',
            `Se non è stato richiesto questo accesso, conviene contattare la segreteria di ${sede.nome} e non usare le credenziali: verranno annullate.`,
            '',
            piedeTesto(sede, motivo),
        ].join('\n'),
    }
}
