import type { SupabaseClient } from '@supabase/supabase-js'
import { sendEmailDetailed } from '@/lib/email/send'
import { risolviContestoSede } from '@/lib/email/contesto'
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
}

export interface DatiCopiaAllaSede {
    /** La sede a cui questa copia è destinata. */
    scuolaId: string
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
    try {
        const sede = await risolviContestoSede(supabase, d.scuolaId, OPERAZIONE)
        const ripiego = process.env[ENV_RIPIEGO]
        const destinatario = sede.email ?? ripiego ?? null

        if (sede.email === null) {
            logEvento('config', 'error', {
                operazione: OPERAZIONE,
                esito: destinatario ? 'casella-sede-assente-ripiego' : 'casella-sede-assente',
                scuola_id: d.scuolaId,
                // `msg` non è in lista bianca nel jsonb, ma `testoEvento()` lo promuove
                // alla colonna `app_log.messaggio`, che è in chiaro: è lì che si legge.
                msg: destinatario
                    ? `nessuna email in Impostazioni → Anagrafica sede per questo plesso: la copia della candidatura parte sul ripiego ${ENV_RIPIEGO}`
                    : `nessuna email in Impostazioni → Anagrafica sede per questo plesso e ${ENV_RIPIEGO} non è impostata: la copia della candidatura NON parte`,
            })
        }
        if (destinatario === null) return { ok: false, rinviabile: false }

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
                    scuola_id: d.scuolaId,
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
                    scuola_id: d.scuolaId,
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

        logEvento('candidatura', invio.ok ? 'info' : 'warn', {
            operazione: OPERAZIONE,
            esito: invio.ok ? 'copia-sede-inviata' : 'copia-sede-non-inviata',
            canale: 'email',
            entita_id: d.entitaId,
            scuola_id: d.scuolaId,
            con_allegato: allegati !== undefined,
        }, invio.ok ? undefined : new Error(invio.error ?? 'motivo sconosciuto'))

        return { ok: invio.ok, rinviabile: invio.rinviabile === true }
    } catch (e) {
        logEvento('candidatura', 'warn', {
            operazione: OPERAZIONE,
            esito: 'copia-sede-non-inviata',
            entita_id: d.entitaId,
            scuola_id: d.scuolaId,
        }, e)
        return { ok: false, rinviabile: false }
    }
}
