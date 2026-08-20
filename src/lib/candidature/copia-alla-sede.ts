import type { SupabaseClient } from '@supabase/supabase-js'
import { sendEmailDetailed } from '@/lib/email/send'
import { risolviContestoSede, contestoSenzaSede } from '@/lib/email/contesto'
import { messaggioCandidaturaAllaSede } from '@/lib/email/messaggi/candidatura-alla-sede'
import { logEvento } from '@/lib/logging/logger'
import { BUCKET_CURRICULUM } from './percorso-cv'

// =============================================================================
// LA COPIA DELLA CANDIDATURA CHE ARRIVA NELLA CASELLA DEL PLESSO.
//
// ─── BEST-EFFORT, MA MAI MUTA ────────────────────────────────────────────────
// Quando questa funzione parte la candidatura è GIÀ REGISTRATA: un'email che non
// parte non deve trasformare un 201 in un 500, cioè non deve far credere a chi ha
// appena compilato quattro passi che il suo invio sia fallito. Perciò non lancia
// mai e ritorna un esito.
//
// Ma non tace. Ogni ramo lascia una riga, successo compreso — con i soli errori
// «nessun log» non distingue «tutte partite» da «non è mai partito niente», ed è
// esattamente l'ambiguità che ha tenuto nascosto per mesi il guasto delle email
// delle credenziali.
//
// ─── IL DESTINATARIO, E PERCHÉ IL RIPIEGO È A LIVELLO `error` ────────────────
// L'indirizzo viene da `scuole.config.anagrafica.email`, lo stesso campo che firma
// il piè di pagina di tutte le email della sede. Se manca, la candidatura NON si
// perde — si ripiega su `CANDIDATURE_EMAIL_FALLBACK` — ma la riga è `error` e non
// `info`: una configurazione critica assente in produzione è un incidente, non una
// nota a piè di pagina (AGENTS, logging §4).
//
// Un ripiego SILENZIOSO vorrebbe dire che per mesi le candidature di Aversa
// arrivano a info@ mentre tutti credono che arrivino ad aversa@, e nessuno ha modo
// di accorgersene: la forma esatta del guasto che questo repo ha già pagato.
//
// ─── NIENTE DATI PERSONALI NEI LOG ───────────────────────────────────────────
// Qui passano un nome, un'email e il percorso di un curriculum. Nei log finiscono
// solo uuid, booleani e conteggi. `cv_path` in particolare è la chiave di un gate
// (`candidature_insegnanti_cv_unico`): un percorso a log è un percorso che
// qualcuno può leggere, e con quello si tenta di rivendicare il curriculum altrui.
// =============================================================================

/**
 * Il nome dell'ambiente su cui ripiegare quando l'anagrafica non ha la casella.
 * Solo il NOME: il valore si imposta su Vercel, e questo repo è pubblico.
 * Documentata in `docs/env.md` (lock `env-critiche-documentate`).
 */
const ENV_RIPIEGO = 'CANDIDATURE_EMAIL_FALLBACK'

/** L'operazione, come la scrive `iscrizione/insegnanti:POST`: i log si correlano. */
const OPERAZIONE = 'iscrizione/insegnanti:POST'

export interface EsitoCopiaAllaSede {
    ok: boolean
    /** Vero quando il provider ha detto «non oggi» (429) e non «non si può». */
    rinviabile: boolean
    /**
     * Vero quando `copia_inviata_il` è stata scritta davvero.
     *
     * `ok: true, segnata: false` non è una contraddizione: l'email è partita ma
     * la riga non porta memoria del fatto, quindi al prossimo inoltro
     * dell'arretrato ripartirà come DOPPIONE. È un guasto minore — un doppione
     * si vede e si butta — ma va detto, non dedotto.
     */
    segnata: boolean
}

export interface DatiCopiaAllaSede {
    /**
     * I plessi a cui questa copia è destinata: UNA email per tutti.
     *
     * ⚠️ ERA UNA COPIA PER SEDE, ed è cambiato il 2026-08-20 per un motivo
     * aritmetico, non estetico. Il tetto Resend è ~100 email al giorno ed è già
     * conteso con il cron degli inviti alle iscrizioni (`INVITI_AL_GIORNO = 90`).
     * Misurato sulle candidature vere: media 2,4 al giorno, ma PICCO DI 16 in un
     * giorno solo. Con una copia per sede quel picco vale 16 × (1 conferma + fino
     * a 3 copie) = 64 email, più 90 inviti: 154 su 100.
     *
     * Una copia sola con tutti i plessi in destinatario porta lo stesso picco a
     * 32. Non basta da sola a stare sotto il tetto — quella è una decisione sul
     * piano o sul cron, non su questo file — ma toglie i due terzi che dipendono
     * da qui.
     *
     * Le tre caselle sono della stessa cooperativa: vedersi in `To:` non è una
     * perdita di riservatezza fra loro.
     */
    scuoleIds: string[]
    /** I valori del modulo, con le chiavi degli `id` di `INSEGNANTE_FIELDS`. */
    dati: Record<string, unknown>
    consensi: Record<string, boolean>
    /** I NOMI di tutti i plessi scelti — non gli uuid: la legge una persona. */
    sediScelte: string[]
    inviataIl: string
    /**
     * L'id della candidatura, per correlare i log.
     *
     * `null` è legittimo e non è un caso di scuola: la rotta pubblica lo ricava
     * rileggendo la riga appena inserita, e quella rilettura può non riuscire.
     * Serve SOLO a correlare le righe di `app_log` — una copia si spedisce
     * comunque, perché il destinatario e il contenuto non dipendono da lui.
     * Tiparlo `string` costringerebbe chi chiama a inventarne uno.
     */
    entitaId: string | null
    cvPath: string | null
    /**
     * `true` quando il curriculum manca perché il modulo non lo chiedeva ancora
     * (candidature anteriori al 2026-08-15). Lo sa solo chi inoltra l'arretrato:
     * la rotta pubblica non lo passa mai, perché oggi il campo c'è.
     */
    curriculumNonPrevisto?: boolean
}

/** La tabella su cui vive `copia_inviata_il`. */
const TABELLA = 'candidature_insegnanti'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * «QUESTA COPIA È GIÀ PARTITA» — e la memoria si scrive QUI, non nei chiamanti.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─── PERCHÉ STA DENTRO QUESTO FILE ───────────────────────────────────────────
 * Perché la regola è una sola — «se è partita, segnala» — e le strade che ci
 * passano sono due: il modulo pubblico e l'inoltro dell'arretrato. Fino al
 * 2026-08-20 la regola viveva soltanto nella seconda, e la prima spediva senza
 * lasciare memoria. Misurato quel giorno: quattro candidature arrivate fra le
 * 13:25 e le 13:54 avevano la copia regolarmente in casella e `copia_inviata_il`
 * a NULL. Al primo clic successivo su «inoltra ai plessi» avrebbero preso un
 * doppione — e con loro ogni candidatura futura, perché l'elenco dei «non
 * ancora inviati» si riempiva di righe già inviate.
 *
 * Un chiamante può dimenticare di segnare. Non può dimenticare di spedire: se
 * salta questa funzione non manda niente, e il guasto si vede subito. Perciò la
 * memoria sta appesa all'invio, non alla buona volontà di chi chiama.
 *
 * ─── PERCHÉ NON PUÒ MAI FAR FALLIRE L'EMAIL ──────────────────────────────────
 * L'email è già partita quando questo codice gira. Un `update` andato male è un
 * doppione domani; un'eccezione che risale sarebbe una candidatura dichiarata
 * non consegnata quando invece è in casella — cioè il contrario esatto della
 * verità, e su questa colonna la bugia più costosa è proprio quella.
 *
 * ⚠️ PostgREST NON LANCIA: ritorna `{ error }`. Il `try` qui sotto copre la rete
 * e i client finti, non l'errore di PostgREST — quello si legge nel valore di
 * ritorno, ed è la riga sopra il `catch`.
 */
async function segnaCopiaInviata(
    supabase: SupabaseClient,
    entitaId: string | null,
    scuolaId: string,
): Promise<boolean> {
    // Senza id non si marca: `eq('id', null)` non colpisce la riga giusta, e
    // «quale riga» non è una cosa che si indovina.
    if (entitaId === null) {
        logEvento('candidatura', 'warn', {
            operazione: OPERAZIONE,
            esito: 'copia-inviata-ma-non-segnata',
            scuola_id: scuolaId,
            msg:
                'la copia è partita ma la candidatura non ha un id in mano: copia_inviata_il resta ' +
                'NULL e al prossimo inoltro dell’arretrato partirà di nuovo, come doppione',
        })
        return false
    }
    try {
        const { error } = await supabase
            .from(TABELLA)
            .update({ copia_inviata_il: new Date().toISOString() })
            .eq('id', entitaId)
        if (error !== null && error !== undefined) {
            logEvento('candidatura', 'error', {
                operazione: OPERAZIONE,
                esito: 'copia-inviata-ma-non-segnata',
                entita_id: entitaId,
                scuola_id: scuolaId,
                msg: 'la copia è partita ma copia_inviata_il non è stata scritta: al prossimo inoltro ripartirà, come doppione',
            }, error)
            return false
        }
        return true
    } catch (e) {
        logEvento('candidatura', 'error', {
            operazione: OPERAZIONE,
            esito: 'copia-inviata-ma-non-segnata',
            entita_id: entitaId,
            scuola_id: scuolaId,
        }, e)
        return false
    }
}

/**
 * `curriculum-rossi-maria.pdf` — leggibile, e senza niente del bucket dentro.
 *
 * Gli accenti si tolgono e gli spazi diventano trattini: un allegato che arriva
 * con un nome che il client di posta di qualcuno non sa scrivere è un allegato
 * che quella persona non apre.
 */
function nomeAllegato(dati: Record<string, unknown>, cvPath: string): string {
    const pezzo = (v: unknown): string =>
        String(v ?? '')
            .toLowerCase()
            .normalize('NFD')
            // Toglie i segni diacritici scomposti da NFD (à → a + U+0300).
            .replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
    // L'estensione dal percorso è l'unica cosa che se ne prende, ed è un dato di
    // formato, non un identificativo.
    const estensione = cvPath.split('.').pop()?.toLowerCase() ?? 'pdf'
    const cognome = pezzo(dati.cognome) || 'candidatura'
    const nome = pezzo(dati.nome)
    return `curriculum-${cognome}${nome ? `-${nome}` : ''}.${estensione}`
}

export async function inviaCopiaAllaSede(
    supabase: SupabaseClient,
    d: DatiCopiaAllaSede,
): Promise<EsitoCopiaAllaSede> {
    // La sede di riferimento per l'intestazione e il piè di pagina: la prima
    // quando è una sola. Con più plessi il messaggio non è «di» nessuno di loro —
    // vedi sotto.
    const scuolaPrincipale = d.scuoleIds[0]
    try {
        const contesti = await Promise.all(
            d.scuoleIds.map((sid) => risolviContestoSede(supabase, sid, OPERAZIONE)),
        )
        const ripiego = process.env[ENV_RIPIEGO]
        /**
         * L'intestazione e il piè di pagina.
         *
         * Con UN plesso è quello: nome, indirizzo, recapiti. Con PIÙ plessi
         * nessuno dei tre è il mittente di questa email — la candidatura è
         * rivolta a tutti — e firmarla con l'anagrafica del primo direbbe una
         * cosa falsa in fondo a ogni pagina. Si usa l'identità generica, che è
         * ciò che `contestoSenzaSede` esiste per rappresentare.
         */
        const sede = contesti.length === 1 ? contesti[0] : contestoSenzaSede()

        const senzaCasella = d.scuoleIds.filter((_, i) => contesti[i].email === null)
        const destinatari = contesti.map((c) => c.email).filter((e): e is string => e !== null)
        if (destinatari.length === 0 && ripiego) destinatari.push(ripiego)
        // ⚠️ UN ELENCO, NON UNA STRINGA CON LE VIRGOLE.
        // Qui c'era `destinatari.join(', ')`, ed è costato due candidature vere:
        // il 2026-08-20, commit `2e505bd`, alle 11:02 e alle 11:04 Resend ha
        // risposto `422 «Invalid to field»` alle uniche due candidature rivolte a
        // DUE plessi, mentre quelle a una sede sola passavano. Cioè: la copia
        // funzionava ovunque tranne che nel caso per cui è stata scritta.
        const destinatario = destinatari.length > 0 ? destinatari : null

        if (senzaCasella.length > 0) {
            logEvento('config', 'error', {
                operazione: OPERAZIONE,
                esito: destinatario ? 'casella-sede-assente-ripiego' : 'casella-sede-assente',
                scuola_id: senzaCasella[0],
                n_sedi: senzaCasella.length,
                // `msg` non è in lista bianca nel jsonb, ma `testoEvento()` lo promuove
                // alla colonna `app_log.messaggio`, che è in chiaro: è lì che si legge.
                msg: destinatario
                    ? `nessuna email in Impostazioni → Anagrafica sede per questo plesso: la copia della candidatura parte sul ripiego ${ENV_RIPIEGO}`
                    : `nessuna email in Impostazioni → Anagrafica sede per questo plesso e ${ENV_RIPIEGO} non è impostata: la copia della candidatura NON parte`,
            })
        }
        if (destinatario === null) return { ok: false, rinviabile: false, segnata: false }

        // ── L'ALLEGATO ──────────────────────────────────────────────────────
        // Un curriculum che non si scarica NON ferma l'email: la sede riceve
        // comunque i dati del modulo, e il buco resta scritto. Il contrario —
        // nessuna email perché manca l'allegato — perderebbe anche ciò che si
        // poteva consegnare, e la segreteria non saprebbe nemmeno di una
        // candidatura arrivata.
        let allegati: { filename: string; content: string }[] | undefined
        if (d.cvPath !== null) {
            const { data: file, error } = await supabase.storage
                .from(BUCKET_CURRICULUM)
                .download(d.cvPath)
            if (error !== null && error !== undefined) {
                logEvento('candidatura', 'warn', {
                    operazione: OPERAZIONE,
                    esito: 'curriculum-non-allegato',
                    entita_id: d.entitaId,
                    scuola_id: scuolaPrincipale,
                }, error)
            } else if (file === null || file === undefined) {
                // ⚠️ `{ data: null, error: null }` è un caso reale dello Storage, non
                // un'ipotesi difensiva: senza questo ramo si arriverebbe a
                // `file.arrayBuffer()` su `null`, dentro un `try` che restituirebbe
                // «copia non inviata» — cioè un curriculum mancante travestito da
                // guasto dell'email.
                logEvento('candidatura', 'warn', {
                    operazione: OPERAZIONE,
                    esito: 'curriculum-non-allegato',
                    entita_id: d.entitaId,
                    scuola_id: scuolaPrincipale,
                }, new Error('curriculum non trovato nello storage'))
            } else {
                const buf = Buffer.from(await (file as Blob).arrayBuffer())
                allegati = [{ filename: nomeAllegato(d.dati, d.cvPath), content: buf.toString('base64') }]
            }
        }

        const messaggio = messaggioCandidaturaAllaSede({
            dati: d.dati,
            consensi: d.consensi,
            sediScelte: d.sediScelte,
            inviataIl: d.inviataIl,
            conCurriculum: allegati !== undefined,
            // Solo quando l'allegato manca DAVVERO: se il file c'è, «non era
            // previsto» sarebbe una contraddizione stampata sotto un allegato.
            curriculumNonPrevisto: allegati === undefined && d.curriculumNonPrevisto === true,
        }, sede)

        const invio = await sendEmailDetailed({
            to: destinatario,
            subject: messaggio.oggetto,
            text: messaggio.testo,
            html: messaggio.html,
            ...(allegati ? { attachments: allegati } : {}),
            // Chi riceve risponde a chi si è candidato. Il mittente non può
            // esserlo: deve restare su @mail.kidville.it o Resend rifiuta con 403.
            ...(typeof d.dati.email === 'string' && d.dati.email.includes('@')
                ? { replyTo: d.dati.email }
                : {}),
        })

        /**
         * ⚠️ IL `429` NON È UN WARNING COME GLI ALTRI, e questa distinzione è
         * arrivata dopo — prima una quota esaurita usciva come un `warn` fra
         * mille, cioè come una copia persa in silenzio.
         *
         * `rinviabile` significa «non oggi», non «non si può»: la quota del
         * provider si è esaurita e domani sarebbe passata. Ma QUI non c'è
         * nessuna coda che riprovi — la candidatura è già registrata e questa
         * funzione finisce — quindi «rinviabile» in pratica vuol dire PERSA, e
         * con essa il curriculum che la segreteria doveva ricevere.
         *
         * Livello `error`: chi legge i log deve poter distinguere «una casella
         * non risponde» da «abbiamo finito le email per oggi», perché il secondo
         * si ripete su OGNI candidatura fino a mezzanotte e la cura è un'altra
         * (il piano, o il tetto del cron degli inviti).
         */
        if (invio.rinviabile === true) {
            logEvento('config', 'error', {
                operazione: OPERAZIONE,
                esito: 'copia-sede-persa-per-quota',
                entita_id: d.entitaId,
                scuola_id: scuolaPrincipale,
                n_sedi: d.scuoleIds.length,
                msg:
                    'quota email del provider esaurita: la copia della candidatura NON è arrivata ' +
                    'alla sede e nessuno la ritenterà. La scheda resta nel pannello. ' +
                    'Se si ripete, il tetto giornaliero è troppo basso per il volume attuale.',
            })
        }
        logEvento('candidatura', invio.ok ? 'info' : 'warn', {
            operazione: OPERAZIONE,
            esito: invio.ok ? 'copia-sede-inviata' : 'copia-sede-non-inviata',
            canale: 'email',
            entita_id: d.entitaId,
            scuola_id: scuolaPrincipale,
            n_sedi: d.scuoleIds.length,
            con_allegato: allegati !== undefined,
        }, invio.ok ? undefined : new Error(invio.error ?? 'motivo sconosciuto'))

        // ⚠️ SOLO dopo un esito positivo VERO del provider, e mai su un 429.
        // Una riga segnata per sbaglio è una candidatura che nessuna sede
        // riceverà mai e di cui nessuno si accorgerà: la query «chi manca?» non
        // la trova più. Un doppione si vede e si butta. Fra i due errori non
        // c'è simmetria, e questa `if` è il lato che non perdona.
        const segnata = invio.ok ? await segnaCopiaInviata(supabase, d.entitaId, scuolaPrincipale) : false

        return { ok: invio.ok, rinviabile: invio.rinviabile === true, segnata }
    } catch (e) {
        logEvento('candidatura', 'warn', {
            operazione: OPERAZIONE,
            esito: 'copia-sede-non-inviata',
            entita_id: d.entitaId,
            scuola_id: scuolaPrincipale,
        }, e)
        return { ok: false, rinviabile: false, segnata: false }
    }
}
