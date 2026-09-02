import { esc, h, unisci } from '../html'
import { documento, intestazioneTesto, piedeTesto } from '../layout'
import { h2, nota, p, tabellaDati, tabMascotte, type RigaDati } from '../componenti'
import type { ContestoSede } from '../contesto'
import type { Messaggio } from './tipi'
import { INSEGNANTE_FIELDS, CONSENSI_INSEGNANTI_FIELDS } from '@/lib/forms/insegnanti-template'
import type { FormField } from '@/types/database.types'

// =============================================================================
// 13 · La COPIA COMPLETA della candidatura, verso la casella del plesso.
//
// Le altre dodici email vanno a una famiglia o a chi si candida. Questa va alla
// SEGRETERIA, ed è l'unica il cui scopo è trasportare un modulo per intero
// invece di riassumerlo: chi la riceve deve poter valutare senza aprire
// l'applicazione, perché è così che una segreteria lavora davvero — dalla posta.
//
// ─── PERCHÉ ITERA IL TEMPLATE INVECE DI ELENCARE I CAMPI ─────────────────────
// Perché un elenco scritto a mano diverge al primo campo aggiunto al modulo, e
// diverge IN SILENZIO: la sede riceverebbe una copia «completa» a cui manca
// esattamente il campo nuovo, nessun test sarebbe rosso, e il difetto lo
// scoprirebbe una segreteria fra sei mesi chiedendosi perché di quella candidata
// non sappia il titolo di studio.
//
// `INSEGNANTE_FIELDS` dichiara già tutto ciò che serve: l'etichetta con cui il
// campo è stato CHIESTO — che è quella con cui va riletto — e le `options` con le
// etichette leggibili. Chi riceve deve trovare «Laurea magistrale», non
// `laurea_magistrale`: il secondo è un valore di database, e in una casella di
// posta è rumore.
//
// Il lock è `__tests__/lib/email/candidatura-alla-sede.test.ts`, che itera lo
// stesso template e pretende ogni campo compilato.
//
// ─── LA REGOLA DELL'OMISSIONE ────────────────────────────────────────────────
// La stessa di `lib/email/contesto.ts` e di `lib/scuole/anagrafica.ts`: ciò che
// manca si OMETTE, non si stampa vuoto. Un'etichetta seguita dal nulla non è un
// dato mancante — è una riga rotta in mezzo a un documento che qualcuno deve
// leggere per decidere se chiamare una persona.
//
// ─── IL CURRICULUM NON COMPARE COME PERCORSO ─────────────────────────────────
// `cv_path` è un identificativo tecnico ed è la CHIAVE DI UN GATE
// (`candidature_insegnanti_cv_unico` + `assertCurriculumInScope`): chi lo conosce
// può tentare di rivendicarlo su un'altra sede. Non ha nessun motivo di comparire
// in una casella di posta, e qui non compare. Si dice SE il curriculum c'è, e il
// file viaggia in allegato con un nome ricostruito da chi spedisce.
//
// ─── E I CONSENSI CI SONO TUTTI, ANCHE QUELLI NEGATI ─────────────────────────
// «Non gliel'ho chiesto» e «ha detto no» non sono la stessa cosa. La differenza
// conta il giorno in cui si decide se ricontattare qualcuno per una posizione
// futura: senza la riga, l'assenza si leggerebbe come un difetto del modulo
// invece che come una scelta della persona.
// =============================================================================

export interface DatiCandidaturaAllaSede {
    /** I valori del modulo, con le chiavi degli `id` di `INSEGNANTE_FIELDS`. */
    dati: Record<string, unknown>
    /** L'esito di ogni consenso. Chiave assente ⇒ non spuntato. */
    consensi: Record<string, boolean>
    /** I NOMI dei plessi scelti — non gli uuid: questa email la legge una persona. */
    sediScelte: string[]
    /** L'istante d'invio, già formattato in Europe/Rome da chi chiama. */
    inviataIl: string
    conCurriculum: boolean
    /**
     * `true` quando il curriculum manca perché il modulo NON LO CHIEDEVA ANCORA.
     *
     * ⚠️ Non è una sfumatura di cortesia. «Non ne ha caricato uno» descrive una
     * scelta di chi si è candidato; per le candidature arrivate prima del
     * 2026-08-15 quella frase accusa una persona di una negligenza che non ha
     * commesso — il campo non esisteva. La sede legge una riga sola e non ha
     * modo di sapere quale delle due cose sia vera.
     */
    curriculumNonPrevisto?: boolean
    /**
     * `true` quando il curriculum C'È ma non si è riusciti ad allegarlo.
     *
     * ⚠️ Lo stesso `allegati === undefined` di `copia-alla-sede.ts` copre DUE
     * fatti opposti: il curriculum che non c'è e il curriculum che c'è ma non si
     * è scaricato dallo Storage (errore, oppure `{ data: null, error: null }`,
     * che è un caso reale). L'email parte comunque — è la scelta giusta, perché
     * il contrario perderebbe anche i dati che si potevano consegnare — ma senza
     * questa distinzione stampava «chi si è candidato non ne ha caricato uno»
     * sopra un guasto tecnico: una falsa accusa, letta da chi decide se
     * richiamare quella persona.
     *
     * Dal 2026-08-24 il curriculum è OBBLIGATORIO: su ogni candidatura nuova
     * quella frase sarebbe falsa per costruzione, perché senza allegato la
     * candidatura non esisterebbe.
     */
    curriculumNonAllegabile?: boolean
}

/** L'etichetta leggibile di un valore, quando il campo dichiara delle opzioni. */
function etichettaDi(campo: FormField, valore: unknown): string {
    const opzioni = campo.options
    if (!Array.isArray(opzioni)) return String(valore)
    const trovata = opzioni.find((o) => o.value === valore)
    // Il ripiego è il valore GREZZO, non una stringa vuota: un valore che non sta
    // più fra le opzioni — perché l'elenco è cambiato dopo l'invio — è un dato che
    // la sede deve comunque vedere. Tacerlo sarebbe peggio che mostrarlo brutto.
    return trovata?.label ?? String(valore)
}

/** Il valore di un campo, già leggibile. `null` quando il campo è da omettere. */
function valoreLeggibile(campo: FormField, grezzo: unknown): string | null {
    if (grezzo === null || grezzo === undefined || grezzo === '') return null
    if (Array.isArray(grezzo)) {
        if (grezzo.length === 0) return null
        return grezzo.map((v) => etichettaDi(campo, v)).join(', ')
    }
    if (typeof grezzo === 'boolean') return grezzo ? 'Sì' : 'No'
    return etichettaDi(campo, grezzo)
}

/** Le righe «Etichetta: valore» dei campi compilati, nell'ordine del modulo. */
export function righeDellaCopia(d: DatiCandidaturaAllaSede): RigaDati[] {
    const righe: RigaDati[] = []
    for (const campo of INSEGNANTE_FIELDS) {
        // Il curriculum si annuncia a parte: vedi la testata.
        if (campo.id === 'cv_path') continue
        const valore = valoreLeggibile(campo, d.dati[campo.id])
        if (valore !== null) righe.push({ etichetta: campo.label, valore })
    }
    return righe
}

/** I consensi con il loro esito. Ci sono TUTTI, anche quelli non dati. */
export function righeDeiConsensi(d: DatiCandidaturaAllaSede): RigaDati[] {
    return CONSENSI_INSEGNANTI_FIELDS.map((c) => ({
        etichetta: c.label,
        valore: d.consensi[c.id] === true ? 'Sì' : 'No',
    }))
}

/** Il nome di chi si candida, per l'oggetto. Degrada senza inventare. */
function nomeCandidato(dati: Record<string, unknown>): string {
    const pezzi = [dati.cognome, dati.nome].filter((v): v is string => typeof v === 'string' && v !== '')
    return pezzi.length > 0 ? pezzi.join(' ') : 'candidatura spontanea'
}

export function messaggioCandidaturaAllaSede(
    d: DatiCandidaturaAllaSede,
    sede: ContestoSede,
): Messaggio {
    const chi = nomeCandidato(d.dati)
    const oggetto = `Candidatura di ${chi} — ${sede.nome}`
    const motivo =
        `Ricevi questo messaggio perché è arrivata una candidatura dal modulo pubblico ` +
        `«Lavora con noi» per ${sede.nome}.`

    const dati = righeDellaCopia(d)
    const consensi = righeDeiConsensi(d)
    // ⚠️ I QUATTRO RAMI SONO QUATTRO FATTI DIVERSI, e nessuno si può togliere
    // «perché ormai il curriculum c'è sempre»:
    //  1. l'allegato c'è;
    //  2. il file C'È in tabella ma non si è riusciti ad allegarlo ⇒ è un GUASTO
    //     nostro, e va detto come tale (ramo nuovo del 2026-08-24);
    //  3. la candidatura è anteriore al 2026-08-15, quando il modulo non
    //     permetteva ancora di caricare niente;
    //  4. il campo c'era ed era FACOLTATIVO (le candidature fra il 15 e il 24
    //     agosto): qui, e solo qui, «non ne ha caricato uno» è corretto.
    // L'ordine conta: il ramo 2 sta PRIMA del 4, perché entrambi arrivano con
    // `conCurriculum: false` e il 4 è il ripiego finale.
    const allegato = d.conCurriculum
        ? 'Curriculum in allegato a questo messaggio.'
        : d.curriculumNonAllegabile === true
          // ⚠️ ATTIVA, E CON UN SOGGETTO. La stesura precedente metteva tre
          // passive in fila — «è stato caricato», «non è stato possibile»,
          // «si apre» — in una riga sola, ed è la riga da cui la Direzione
          // decide se il curriculum esiste da qualche parte: il senso arrivava
          // dopo la terza subordinata, e del guasto non si prendeva la
          // responsabilità nessuno. Il ramo resta quello giusto (distinguere un
          // guasto NOSTRO da un'accusa a chi si è candidato); cambia chi lo dice.
          ? 'Il curriculum c’è, ma non siamo riusciti ad allegarlo a questo messaggio: si apre dalla scheda della candidatura in Segreteria.'
          : d.curriculumNonPrevisto === true
            ? 'Nessun curriculum allegato: questa candidatura è arrivata prima che il modulo permettesse di caricarne uno.'
            : 'Nessun curriculum allegato: chi si è candidato non ne ha caricato uno.'

    // ⚠️ Le sedi si dichiarano SEMPRE, anche quando è una sola. Una frase che
    // compare solo nel caso multiplo insegna a chi legge che la sua assenza non
    // vuol dire niente — e il giorno in cui manca per un difetto, nessuno se ne
    // accorge. Cambia il testo, non la presenza.
    const rigaSedi =
        d.sediScelte.length > 1
            ? `Questa persona si è proposta a più plessi: ${d.sediScelte.join(', ')}. Ogni sede valuta per conto suo.`
            : `Sede a cui si è proposta: ${d.sediScelte.join(', ') || sede.nome}.`

    const corpo = unisci([
        p(h`È arrivata una candidatura dal modulo pubblico <strong>«Lavora con noi»</strong>, inviata il ${esc(d.inviataIl)}.`),
        p(h`${esc(rigaSedi)}`),
        h2('I dati del modulo'),
        tabellaDati(dati),
        h2('I consensi'),
        tabellaDati(consensi),
        h2('Allegato'),
        p(h`${esc(allegato)}`, { dimensione: 15 }),
        nota(h`Si può rispondere direttamente a questo messaggio: la risposta arriva a chi si è candidato. La scheda completa resta nel pannello Candidature dell'applicazione.`),
    ])

    return {
        oggetto,
        html: documento(sede, {
            oggetto,
            preheader: `${chi} — candidatura ricevuta il ${d.inviataIl}.`,
            tab: tabMascotte({ occhiello: 'Candidature', titolo: 'Nuova candidatura', compatta: true }),
            corpo,
            motivo,
        }),
        testo: [
            intestazioneTesto('Nuova candidatura', sede),
            '',
            `È arrivata una candidatura dal modulo pubblico «Lavora con noi», inviata il ${d.inviataIl}.`,
            rigaSedi,
            '',
            'I DATI DEL MODULO',
            ...dati.map((r) => `  ${(r.etichetta + ':').padEnd(34)}${r.valore}`),
            '',
            'I CONSENSI',
            ...consensi.map((r) => `  ${(r.etichetta + ':').padEnd(60)}${r.valore}`),
            '',
            'ALLEGATO',
            allegato,
            '',
            'Si può rispondere direttamente a questo messaggio: la risposta arriva a chi si è candidato. La scheda completa resta nel pannello Candidature dell\'applicazione.',
            '',
            piedeTesto(sede, motivo),
        ].join('\n'),
    }
}
