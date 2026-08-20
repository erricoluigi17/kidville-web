import { esc, h, unisci } from '../html'
import { documento, intestazioneTesto, piedeTesto } from '../layout'
import { h2, nota, p, tabellaDati, tabMascotte, type RigaDati } from '../componenti'
import type { ContestoSede } from '../contesto'
import type { Messaggio } from './tipi'

// =============================================================================
// 12 · Conferma di candidatura — NUOVA.
//
// Stessa logica della ricevuta d'iscrizione, altro registro: «lei»,
// professionale, breve — metà della lunghezza della 11.
//
// ─── LA PARTE CHE CONTA DAVVERO ─────────────────────────────────────────────
// Non la conferma di ricezione: quella la dà già l'oggetto. Conta l'ASPETTATIVA
// ONESTA SUI TEMPI — entro quanto si riceve una risposta, e il fatto che una
// risposta arriva IN OGNI CASO, anche negativa. È la promessa che l'email 08 poi
// mantiene, e senza di essa la 08 arriverebbe come una sorpresa sgradevole
// invece che come una cosa annunciata.
//
// ─── GLI ALLEGATI SONO UN CONTEGGIO ─────────────────────────────────────────
// «curriculum e 1 documento allegato», mai il contenuto e mai i nomi dei file.
// Un nome di file può contenere di tutto — il codice fiscale, la data di
// nascita, il nome di un datore di lavoro precedente — e questa email non ha
// nessun motivo di ripeterlo a chi quel file l'ha caricato.
//
// ─── NESSUN BOTTONE ─────────────────────────────────────────────────────────
// Non c'è niente da fare, ed è esattamente il messaggio.
// =============================================================================

export interface DatiConfermaCandidatura {
    /** Nome della candidata. Può mancare: il saluto degrada. */
    nome?: string | null
    /** Data d'invio già formattata in Europe/Rome. */
    inviataIl: string
    /** Ruolo o posizione per cui ci si è candidate. Assente ⇒ la riga si omette. */
    ruolo?: string | null
    /**
     * I NOMI di tutti i plessi scelti. Vuoto ⇒ si nomina la sede del contesto.
     *
     * ⚠️ Dal 2026-08-20 una candidatura può essere rivolta a più sedi, e questa
     * riga diceva sempre UNA. Chi aveva spuntato due caselle riceveva la
     * conferma con un plesso solo e concludeva che la seconda spunta non avesse
     * preso — lo stesso difetto che il riepilogo del modulo è stato scritto per
     * chiudere, spostato dall'ultima schermata alla prima email.
     */
    sediScelte?: string[]
    /** Quanti allegati, NON quali. Zero ⇒ la riga si omette. */
    numeroAllegati?: number
    /** Entro quanti giorni arriva una risposta. */
    giorniRisposta: number
}

export const OGGETTO_CONFERMA_CANDIDATURA = 'Abbiamo ricevuto la tua candidatura — Kidville'

/** «curriculum e 1 documento allegato» — un conteggio, mai un elenco di nomi. */
function descriviAllegati(n: number): string | null {
    if (n <= 0) return null
    if (n === 1) return 'curriculum'
    return `curriculum e ${n - 1} ${n - 1 === 1 ? 'documento allegato' : 'documenti allegati'}`
}

export function messaggioConfermaCandidatura(d: DatiConfermaCandidatura, sede: ContestoSede): Messaggio {
    /**
     * ⚠️ IL PIEDE NOMINA LE SEDI SCELTE, NON QUELLA DELLA CARTA INTESTATA.
     *
     * Qui c'era `${sede.nome}` fisso, e `sede` è il contesto risolto sul PRIMO
     * plesso richiesto. Chi si era proposta a tre riceveva una email che nel
     * corpo diceva «Sedi: Giugliano, Aversa, Cesa» e venti righe più in basso
     * «hai inviato una candidatura a Giugliano»: lo stesso difetto che la riga
     * «Sedi» era stata appena scritta per chiudere, spostato nello stesso file.
     *
     * La CARTA INTESTATA resta di una sede sola, ed è una scelta, non una
     * dimenticanza: l'email è una, e una carta intestata con tre loghi non è una
     * carta intestata. Il piede invece è testo, e il testo le può dire tutte.
     */
    const sediNominate = (d.sediScelte ?? []).filter((n) => n.trim() !== '')
    const doveSonoAndata = sediNominate.length > 0 ? sediNominate.join(', ') : sede.nome
    const motivo = `Ricevi questo messaggio perché hai inviato una candidatura a ${doveSonoAndata}.`
    const saluto = d.nome ? `Gentile ${d.nome},` : 'Gentile candidata, gentile candidato,'
    const allegati = descriviAllegati(d.numeroAllegati ?? 0)

    const righe: RigaDati[] = [
        { etichetta: 'Inviata il', valore: d.inviataIl, mono: true },
        {
            etichetta: (d.sediScelte?.length ?? 0) > 1 ? 'Sedi' : 'Sede',
            valore: (d.sediScelte?.length ?? 0) > 0 ? d.sediScelte!.join(', ') : sede.nome,
        },
        ...(d.ruolo ? [{ etichetta: 'Ruolo', valore: d.ruolo }] : []),
        ...(allegati ? [{ etichetta: 'Allegati', valore: allegati }] : []),
    ]

    const corpo = unisci([
        p(h`${esc(saluto)}`),
        p(h`la sua candidatura è arrivata: la stiamo esaminando.`),
        tabellaDati(righe),
        h2('Tempi di risposta'),
        p(h`La segreteria esamina le candidature <strong>entro ${esc(d.giorniRisposta)} giorni</strong>. Una risposta arriva in ogni caso, anche quando l'esito è negativo: non serve richiamare per sapere se è stata letta.`, { dimensione: 15 }),
        nota(h`I dati inviati sono conservati per il tempo necessario alla selezione e, con il suo consenso, per le posizioni future. Dettagli nell'<a class="kv-lnk" href="${esc(sede.privacy)}" style="color:#006A5F;text-decoration:underline;">informativa privacy</a>.`),
    ])

    return {
        oggetto: OGGETTO_CONFERMA_CANDIDATURA,
        html: documento(sede, {
            oggetto: OGGETTO_CONFERMA_CANDIDATURA,
            preheader: `Candidatura registrata il ${d.inviataIl}. Risposta entro ${d.giorniRisposta} giorni, in ogni caso.`,
            tab: tabMascotte({ occhiello: 'Candidature', titolo: 'Candidatura ricevuta', compatta: true }),
            corpo,
            motivo,
        }),
        testo: [
            intestazioneTesto('Abbiamo ricevuto la tua candidatura', sede),
            '',
            saluto,
            '',
            'la sua candidatura è arrivata: la stiamo esaminando.',
            '',
            ...righe.map((r) => `  ${(r.etichetta + ':').padEnd(14)}${r.valore}`),
            '',
            'TEMPI DI RISPOSTA',
            `La segreteria esamina le candidature entro ${d.giorniRisposta} giorni. Una risposta arriva in ogni caso, anche quando l'esito è negativo: non serve richiamare per sapere se è stata letta.`,
            '',
            `I dati inviati sono conservati per il tempo necessario alla selezione e, con il suo consenso, per le posizioni future. Dettagli nell'informativa privacy: ${sede.privacy}`,
            '',
            piedeTesto(sede, motivo),
        ].join('\n'),
    }
}
