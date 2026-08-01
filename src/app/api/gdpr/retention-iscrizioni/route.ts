import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'

/**
 * LA CONSERVAZIONE DELLE DOMANDE D'ISCRIZIONE, FATTA DA DOVE SI PUÒ FARE.
 *
 * ─── PERCHÉ QUESTA ROUTE ESISTE ─────────────────────────────────────────────
 *
 * Il 2026-08-01 la regola dei 24 mesi è stata scritta come funzione SQL
 * (`iscrizioni_retention_tick`) e agganciata a pg_cron. La migrazione è passata,
 * il job risultava creato e attivo, e **la funzione non è mai stata invocata
 * nemmeno una volta**. Il collaudo finale l'ha eseguita e ha trovato questo:
 *
 *     ERROR 42501: Direct deletion from storage tables is not allowed.
 *                  Use the Storage API instead.
 *
 * Su Supabase `storage.objects` ha un trigger `protect_objects_delete` che è
 * **FOR EACH STATEMENT**: scatta a ogni `DELETE`, anche quando le righe da
 * cancellare sono ZERO. Il job sarebbe fallito dalla prima notte e per sempre.
 *
 * ─── IL DANNO PEGGIORE NON ERA LA CANCELLAZIONE MANCATA ─────────────────────
 *
 * Era il silenzio. La migrazione prometteva, per iscritto: «Ogni notte i tre
 * lavori lasciano una riga nel registro degli eventi con i SOLI CONTEGGI […] Se
 * un giorno non cancellano niente, si vede». Non si vedeva: l'`INSERT` in
 * `app_log` stava DOPO la `DELETE`, quindi l'eccezione lo saltava. La difesa che
 * doveva accorgersi del guasto era a valle del guasto — e l'unica traccia sarebbe
 * stata una riga in `cron.job_run_details` che nessuno legge, a partire dal
 * 1° settembre.
 *
 * **La regola che ne esce**: un log che dimostra il funzionamento non può stare
 * dentro la transazione che deve sorvegliare. Qui il conteggio si scrive SEMPRE,
 * anche quando tutto fallisce, ed è la prima cosa che questo file garantisce.
 *
 * ─── PERCHÉ UNA ROUTE E NON UNA FUNZIONE SQL ────────────────────────────────
 *
 * Perché i file si tolgono solo dalla Storage API, e da Postgres non ci si
 * arriva. È lo stesso motivo per cui `src/lib/gdpr/esegui.ts` (l'oblio su
 * richiesta) usa `supabase.storage.from(bucket).remove()` da mesi: quella strada
 * era già giusta, il job SQL era l'eccezione.
 *
 * Una nota che vale la pena scrivere: cancellare la riga di `storage.objects`
 * **non toglie comunque il binario** dall'object store — toglie l'indice. Anche
 * senza il trigger, la versione SQL avrebbe lasciato i documenti d'identità sul
 * disco dichiarando di averli cancellati. Il difetto era doppio.
 *
 * ─── L'ORDINE, CHE NON È UN DETTAGLIO ───────────────────────────────────────
 *
 * PRIMA i file, POI le righe. Al contrario, un errore a metà lascerebbe i
 * documenti nel deposito senza più nessuna riga che li nomini: invisibili, non
 * cancellati — che è il modo peggiore di conservare un dato personale.
 * Se la rimozione dei file fallisce, **le righe non si toccano**: si riproverà la
 * notte dopo, con la domanda ancora lì a dire quali file cercare.
 */

const JOB = 'iscrizioni-retention'

/** 24 MESI: decisione del titolare del 2026-08-01, non un default tecnico. */
const MESI_CONSERVAZIONE = 24

const BUCKET_ALLEGATI = 'form_attachments'

type Domanda = { id: string; data: unknown }

/** I percorsi dei documenti allegati dentro il JSON di una domanda. */
function percorsiAllegati(righe: Domanda[]): string[] {
    const out = new Set<string>()
    for (const r of righe) {
        const d = r.data as { children?: unknown[]; adults?: unknown[] } | null
        for (const gruppo of [d?.children, d?.adults]) {
            if (!Array.isArray(gruppo)) continue
            for (const p of gruppo) {
                const path = (p as { documento_path?: unknown } | null)?.documento_path
                if (typeof path === 'string' && path.trim() !== '') out.add(path)
            }
        }
    }
    return [...out]
}

// POST /api/gdpr/retention-iscrizioni
// Auth: header `x-cron-secret` (cron) OPPURE staff (lancio manuale).
export const POST = withRoute('gdpr/retention-iscrizioni:POST', async (request: Request) => {
    const t0 = Date.now()
    let canale = 'cron'
    try {
        const secret = request.headers.get('x-cron-secret')
        const isCron = !!secret && secret === process.env.CRON_SECRET
        if (!isCron) {
            // Si grida solo se l'header c'è ma non torna: quello è un cron che bussa
            // con la chiave sbagliata, ed è il guasto invisibile. Se manca del tutto,
            // è lo staff che lancia il giro a mano e il gate qui sotto è il suo.
            if (secret) {
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: 'secret-errato',
                    msg: process.env.CRON_SECRET
                        ? `${JOB}: x-cron-secret non corrispondente`
                        : `${JOB}: CRON_SECRET non configurato in questo ambiente`,
                })
            }
            const auth = await requireStaff(request)
            if (auth.response) return auth.response
            canale = 'manuale'
        }

        const supabase = await createAdminClient()
        const soglia = new Date()
        soglia.setMonth(soglia.getMonth() - MESI_CONSERVAZIONE)

        // Le domande MAI EVASE o respinte oltre la soglia. Si taglia su `created_at`
        // (quando la famiglia ha compilato) e non su `updated_at`, che si muove a ogni
        // tocco amministrativo e allungherebbe la conservazione di nascosto — cioè
        // l'opposto di una regola di cancellazione.
        const { data: scadute, error: erroreLettura } = await supabase
            .from('enrollment_submissions')
            .select('id, data')
            .in('status', ['pending', 'rejected'])
            .lt('created_at', soglia.toISOString())

        if (erroreLettura) {
            // PostgREST non lancia: senza questo controllo un guasto di lettura
            // diventerebbe «nessuna domanda scaduta», cioè un giro a vuoto che si
            // dichiara riuscito. È esattamente l'ambiguità che questa route esiste
            // per non ripetere.
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: 'lettura-fallita',
                canale,
                ms: Date.now() - t0,
                msg: `${JOB}: lettura delle domande scadute non riuscita`,
            })
            // `{ ok, motivo }` e non `{ error }`: questa route la chiama pg_net, non un
            // browser. Una prosa italiana qui non la legge nessun utente — sarebbe solo
            // una stringa in più da tradurre, e il lock sui codici d'errore avrebbe
            // ragione a pretenderne uno per un messaggio che a schermo non arriva mai.
            return NextResponse.json({ ok: false, motivo: 'lettura-fallita' }, { status: 500 })
        }

        const righe = (scadute ?? []) as Domanda[]
        const percorsi = percorsiAllegati(righe)
        let fileTolti = 0
        let fileFalliti = 0

        // ── PRIMA I FILE ──
        if (percorsi.length > 0) {
            const { data: rimossi, error: erroreStorage } = await supabase
                .storage
                .from(BUCKET_ALLEGATI)
                .remove(percorsi)
            if (erroreStorage) {
                fileFalliti = percorsi.length
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: 'file-non-rimossi',
                    canale,
                    n_file: percorsi.length,
                    ms: Date.now() - t0,
                    msg: `${JOB}: rimozione degli allegati non riuscita, righe NON cancellate`,
                })
                // Non si prosegue: cancellare le righe adesso renderebbe i documenti
                // irraggiungibili invece che cancellati. Si riprova la notte dopo.
                return NextResponse.json(
                    { ok: false, motivo: 'allegati-non-rimossi', domande: righe.length, file: percorsi.length },
                    { status: 500 },
                )
            }
            fileTolti = (rimossi ?? []).length

            // ── `remove()` NON FALLISCE SUI PERCORSI CHE NON ESISTONO ──
            //
            // Restituisce `data: []` e `error: null`: dal suo punto di vista non c'è
            // niente da fare, e ha ragione. Ma per questa route «zero file rimossi su
            // tre attesi» non è un successo — è il caso in cui il documento d'identità
            // di un minore resta nell'archivio mentre la riga che lo nomina sparisce.
            // Cioè esattamente l'invariante che questa route esiste per garantire, e
            // che il commento qui sopra promette («PRIMA i file, POI le righe»).
            //
            // Il conteggio va confrontato, non guardato: un errore assente non è una
            // rimozione avvenuta. Se non combaciano ci si ferma, la riga resta, e la
            // notte dopo si riprova con la domanda ancora lì a dire quali file cercare.
            if (fileTolti !== percorsi.length) {
                fileFalliti = percorsi.length - fileTolti
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: 'file-non-rimossi',
                    canale,
                    n_file: percorsi.length,
                    n_file_falliti: fileFalliti,
                    ms: Date.now() - t0,
                    msg: `${JOB}: attesi ${percorsi.length} allegati rimossi, rimossi ${fileTolti} — righe NON cancellate`,
                })
                return NextResponse.json(
                    {
                        ok: false,
                        motivo: 'allegati-non-rimossi',
                        domande: righe.length,
                        file_attesi: percorsi.length,
                        file_rimossi: fileTolti,
                    },
                    { status: 500 },
                )
            }
        }

        // ── POI LE RIGHE ──
        let domandeCancellate = 0
        if (righe.length > 0) {
            const { error: erroreDelete } = await supabase
                .from('enrollment_submissions')
                .delete()
                .in('id', righe.map((r) => r.id))
            if (erroreDelete) {
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: 'cancellazione-fallita',
                    canale,
                    n_domande: righe.length,
                    n_file: fileTolti,
                    ms: Date.now() - t0,
                    msg: `${JOB}: allegati rimossi ma righe NON cancellate`,
                })
                return NextResponse.json(
                    { ok: false, motivo: 'righe-non-cancellate', file: fileTolti },
                    { status: 500 },
                )
            }
            domandeCancellate = righe.length
        }

        // Il conteggio si scrive SEMPRE, anche (soprattutto) quando è zero: «nessuna
        // riga» non può voler dire insieme «tutto a posto» e «non è mai partito». È la
        // riga che nella versione SQL non veniva mai scritta.
        logEvento('cron', 'info', {
            operazione: JOB,
            esito: 'retention-iscrizioni',
            canale,
            n_domande: domandeCancellate,
            n_file: fileTolti,
            n_file_falliti: fileFalliti,
            mesi: MESI_CONSERVAZIONE,
            ms: Date.now() - t0,
            msg: `${JOB}: ${domandeCancellate} domande e ${fileTolti} allegati oltre i ${MESI_CONSERVAZIONE} mesi`,
        })

        return NextResponse.json({
            ok: true,
            domande: domandeCancellate,
            file: fileTolti,
            mesi: MESI_CONSERVAZIONE,
        })
    } catch (error) {
        logEvento('cron', 'error', {
            operazione: JOB,
            esito: 'eccezione',
            canale,
            ms: Date.now() - t0,
            msg: `${JOB}: eccezione non prevista`,
        })
        throw error
    }
})
