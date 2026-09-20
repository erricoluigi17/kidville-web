import { codiceVoce, estraiCodiciVoce } from './codice-voce'
import { estraiCodiciFiscali } from './riconciliazione'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PERCHÉ LA MACCHINA HA CHIUSO QUESTA RIGA — ricostruito al momento in cui lo si
 * legge, e dichiarato come tale.
 *
 * ─── 🔴 IL FATTO SCOMODO, IN CIMA: IL MOTIVO NON È SALVATO DA NESSUNA PARTE ──
 *
 * `valutaCertezza` (`./riconciliazione-auto`) CALCOLA i motivi d'aggancio —
 * `codice_voce`, `codice_fiscale`, `residuo_esatto`, `somma_esatta` — e li mette
 * in `EsitoCertezza.motivi`. Ma quel valore muore dentro la fase automatica:
 * `abbinaImportAutomaticamente` lo usa solo per l'aggregato delle RINUNCE (le
 * righe che NON ha chiuso), e su una riga chiusa non lo scrive né in colonna né
 * nell'audit (`valoreDopo` porta stato, pagamento, incasso, importo — non i
 * motivi). Verificato per grep, non dedotto: in tutto `src/` la parola `motivi`
 * appare sui SUGGERIMENTI del matcher, mai sull'abbinamento automatico.
 *
 * Quindi qui il «perché» non si LEGGE: si RICOSTRUISCE dai fatti che restano —
 * la causale della riga bancaria e la voce su cui è stata chiusa. La
 * ricostruzione non è un'approssimazione gentile:
 *
 *  · `codice_voce` è **esatto e verificabile per sempre**: il codice è una
 *    funzione pura dell'uuid del pagamento (`codiceVoce`), quindi «la causale
 *    contiene il codice di QUESTA voce» oggi vale esattamente quanto valeva
 *    all'import. Un codice non si corregge e non invecchia;
 *  · `codice_fiscale` è esatto **finché il codice fiscale dell'alunno non viene
 *    corretto**. Se qualcuno lo rettifica dopo l'import, il confronto smette di
 *    riconoscerlo e questo modulo risponde `non_ricostruito` invece di
 *    inventarsi un motivo. È il verso giusto: meglio «non lo so» di un perché
 *    falso su una schermata che serve a decidere se disfare denaro;
 *  · la QUADRATURA (`residuo_esatto` / `somma_esatta`) non si ricalcola affatto,
 *    e non è pigrizia: il residuo di oggi non è quello di allora (l'import l'ha
 *    consumato). È un'INVARIANTE della fase automatica — `valutaCertezza` scrive
 *    solo quando una sola combinazione quadra ESATTAMENTE al centesimo — quindi
 *    su una riga marcata «automatica» quel motivo è vero per costruzione. Quale
 *    delle due si dice dal numero di voci, cioè da `transazione_id`.
 *
 * ⚠️ **LA CORREZIONE VERA NON È QUESTA**, ed è scritta qui perché chi passa di
 * qua la trovi: i motivi vanno PERSISTITI dalla fase automatica, nel momento in
 * cui li calcola — una colonna `abbinato_auto_motivi text[]` accanto a
 * `abbinato_auto_il`, oppure le stesse chiavi dentro il `valoreDopo` dell'audit
 * che quella fase già scrive. Finché non c'è, questo modulo è l'unica risposta
 * che si possa dare senza mentire, e il suo `non_ricostruito` è la misura di
 * quanto spesso non basta.
 *
 * ─── PURO, E NON PER ELEGANZA ───────────────────────────────────────────────
 * Nessun I/O, nessun orologio, nessun Supabase: stessi ingressi → stesso esito.
 * È la condizione perché la ricostruzione sia collaudabile in `vitest` invece
 * che osservata su bonifici di famiglie vere. I due import sono le stesse
 * funzioni pure che usa `valutaCertezza` — si chiedono a loro, non si riscrivono:
 * una seconda estrazione di codici in questo repository diverge il giorno dopo
 * essere nata, e qui la divergenza direbbe all'operatrice un perché diverso da
 * quello per cui la macchina ha davvero incassato.
 *
 * ─── IL CODICE FISCALE ENTRA E NON ESCE ─────────────────────────────────────
 * `cfAlunno` è un dato di un minore: serve al CONFRONTO e non compare mai nel
 * valore di ritorno. Quello che esce è un enumerato — che `redact` lascia in
 * chiaro nei log e che la schermata traduce — più il codice voce, che è derivato
 * da un uuid e non identifica nessuno.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * I motivi come li legge una schermata. Enumerati e non prosa, per la stessa
 * ragione di `MotivoCertezza` in `./riconciliazione-auto`: li leggono un log
 * (dove la redazione è a lista bianca e una frase italiana sarebbe redatta) e
 * un'interfaccia (dove vanno tradotti).
 *
 * ⚠️ I primi quattro sono gli stessi nomi di `MotivoAggancio`, e la coincidenza
 * è voluta: il giorno in cui i motivi veri verranno persistiti, questo tipo
 * smetterà di essere una ricostruzione e diventerà una lettura senza che la
 * schermata cambi una parola. `non_ricostruito` è il solo che non esiste di là —
 * ed è il solo che questa ricostruzione può produrre e quella no.
 */
export type MotivoAbbinamentoUi =
    | 'codice_voce'
    | 'codice_fiscale'
    | 'residuo_esatto'
    | 'somma_esatta'
    | 'non_ricostruito'

export interface PercheAbbinato {
    /**
     * In ordine: prima l'identificativo che ha agganciato (o `non_ricostruito`),
     * poi la quadratura. L'ordine è FISSO e non dipende dai dati: due righe
     * lette una sotto l'altra devono leggersi con la stessa grammatica.
     */
    motivi: MotivoAbbinamentoUi[]
    /**
     * Il codice voce riconosciuto in causale, forma canonica `#K7MXN3P`, o
     * `null`. È l'unica cosa che dica QUALE voce la famiglia aveva nominato, e
     * non identifica nessuno: nasce da un uuid.
     */
    codice: string | null
}

/**
 * Ricostruisce il perché di UN abbinamento automatico.
 *
 * @param causale      la causale della riga bancaria, com'è in registro
 * @param controparte  l'ordinante: il codice può stare lì invece che in causale
 * @param pagamentoId  la voce su cui la riga è stata chiusa (l'àncora, se composita)
 * @param cfAlunno     il CF dell'alunno di quella voce — usato e mai restituito
 * @param composita    `true` se la riga ha saldato una transazione a più voci
 */
export function percheAbbinato(args: {
    causale?: string | null
    controparte?: string | null
    pagamentoId?: string | null
    cfAlunno?: string | null
    composita: boolean
}): PercheAbbinato {
    const testo = `${typeof args.causale === 'string' ? args.causale : ''} ${
        typeof args.controparte === 'string' ? args.controparte : ''
    }`
    // La quadratura è un'invariante della fase automatica, non una misura di
    // oggi: vedi la testata. Una voce ⇒ residuo esatto, più voci ⇒ somma esatta.
    const quadratura: MotivoAbbinamentoUi = args.composita ? 'somma_esatta' : 'residuo_esatto'

    const identificativi: MotivoAbbinamentoUi[] = []

    // ⚠️ Il codice atteso si CALCOLA dall'uuid e si cerca fra quelli estratti,
    // invece di cercare «un codice qualunque» in causale. La differenza non è
    // teorica: una causale può nominare il codice della voce di un FRATELLO
    // (bonifico che paga due figli, chiuso su una voce sola quando l'altra era
    // già saldata), e dire «codice voce» su un codice che non è di questa voce
    // sarebbe un perché falso proprio nel caso in cui serve di più.
    const atteso = codiceVoce(typeof args.pagamentoId === 'string' ? args.pagamentoId : '')
    let codice: string | null = null
    if (atteso !== '' && estraiCodiciVoce(testo).includes(atteso)) {
        identificativi.push('codice_voce')
        codice = atteso
    }

    // Il CF si confronta in MAIUSCOLO da entrambi i lati: `estraiCodiciFiscali`
    // restituisce già la forma normalizzata, il dato del database no.
    const cf = (typeof args.cfAlunno === 'string' ? args.cfAlunno : '').trim().toUpperCase()
    if (cf !== '' && estraiCodiciFiscali(testo).includes(cf)) {
        identificativi.push('codice_fiscale')
    }

    // Nessuno dei due riconosciuto OGGI. All'import almeno uno c'era —
    // `valutaCertezza` esce `nessun_identificativo` senza — quindi qui è
    // cambiato il mondo: il CF è stato corretto, la voce cancellata e ricreata
    // (codice nuovo), oppure la riga è stata chiusa su un'àncora il cui codice
    // non era in causale. Si dice «non ricostruito», mai «senza motivo».
    if (identificativi.length === 0) return { motivi: ['non_ricostruito', quadratura], codice: null }

    return { motivi: [...identificativi, quadratura], codice }
}
