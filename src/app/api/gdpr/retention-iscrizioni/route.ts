import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { rimuoviEVerifica, bloccanti, type EsitoRimozione } from '@/lib/storage/rimozione-verificata'
import { segretoCronValido } from '@/lib/security/segreto-cron'

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
 * Se un documento è ancora nell'archivio, **la sua riga non si tocca**: si
 * riproverà il mese dopo, con la domanda ancora lì a dire quali file cercare.
 *
 * ─── LO STATO, NON IL CONTEGGIO (correzione del 2026-08-02) ─────────────────
 *
 * La prima stesura di questa regola confrontava i NUMERI: «se i file rimossi non
 * sono quanti quelli attesi, non cancellare». Sembrava prudenza, era un blocco
 * permanente. `remove()` non nomina i percorsi che non esistono più, e un file
 * già assente non torna: il confronto non sarebbe MAI più tornato, e da lì in poi
 * **nessuna domanda sarebbe stata cancellata**, per sempre — l'opposto esatto
 * dell'obbligo che questa route esiste per adempiere, su dati sanitari di minori.
 *
 * «File non rimosso» non è sinonimo di «file ancora lì»: un percorso che non
 * esiste più significa che l'esito voluto è GIÀ raggiunto. La regola — una sola,
 * in un posto solo, condivisa con l'oblio su richiesta — sta in
 * `@/lib/storage/rimozione-verificata`: dopo la rimozione si CHIEDE allo Storage
 * lo stato dei percorsi che non risultano usciti.
 *
 * E la rinuncia è PER DOMANDA, non per lotto: un allegato che non esce riguarda
 * la sua domanda, non le altre novantuno. Trattenerle tutte trasformava un guasto
 * su un file nella violazione dei diritti di tutte le famiglie del lotto.
 */

const JOB = 'iscrizioni-retention'

/**
 * 24 MESI: decisione del titolare del 2026-08-01, non un default tecnico.
 *
 * ─── V3 · DUE DECISIONI A UN GIORNO DI DISTANZA CHE NON CONCORDANO ──────────
 *
 * Il 2026-07-31 la migrazione `20260731165941` chiude così, sulle 93 domande
 * arrivate prima che il modulo registrasse l'accettazione dell'informativa:
 * «nessuna cancellazione, NESSUNA RETENTION su questa tabella» — con la ragione
 * scritta e citata testualmente dal titolare («non voglio assolutamente perdere
 * questi dati»). Il 2026-08-01, il giorno dopo, nasce la regola dei 24 mesi qui
 * sopra. Nessuna delle due nomina l'altra, e per tre giorni questa route ha
 * cancellato senza sapere che l'altra esisteva (rilievo `V3` del collaudo).
 *
 * COSA SI È SCELTO, e perché in questo verso: le domande marcate
 * `raccolta_senza_informativa` sono ESCLUSE dalla cancellazione automatica, e
 * quando superano la soglia la route lo grida con un `warn` e il conteggio.
 *
 *  · la cancellazione è IRREVERSIBILE e il disaccordo è reale: davanti a due
 *    regole che non concordano si sceglie il verso che lascia decidere una
 *    persona, non quello che distrugge e poi si scusa. È lo stesso principio già
 *    applicato in `liberaPercorsiPubblici` — «"non lo so" non vale "demolisci"»;
 *  · e sono proprio le righe raccolte SENZA informativa: cancellarle in automatico
 *    farebbe sparire la prova dell'unico episodio noto di raccolta senza
 *    informativa, cioè il fatto che quella migrazione esiste per conservare.
 *
 * ⚠️ RESTA UNA DECISIONE DA PRENDERE, non una chiusa: serve che il titolare dica
 * quale delle due regole vale per quelle 93 righe. Fino ad allora non si cancella
 * e si vede. Nessuna urgenza di calendario — sono del 2026-07-16, la soglia cade
 * nel 2028 — ma il codice e la migrazione ora dicono la stessa cosa.
 */
const MESI_CONSERVAZIONE = 24

const BUCKET_ALLEGATI = 'form_attachments'

type Domanda = {
    id: string
    data: unknown
    /**
     * `true` = domanda ricevuta prima che il modulo pubblico registrasse
     * l'accettazione dell'informativa (fino al 2026-07-30). Sono 93 righe, e la
     * retention automatica NON le tocca: vedi il blocco `V3` accanto a
     * `MESI_CONSERVAZIONE`. Opzionale perché sul DB E2E della CI, non migrato, la
     * colonna può non esistere — e in quel caso `!== true` vale «non trattenere»,
     * che è corretto: là dentro non ci sono le 93 domande di produzione.
     */
    raccolta_senza_informativa?: boolean | null
}

const NIENTE_DA_TOGLIERE: EsitoRimozione = {
    rimossi: [],
    giaAssenti: [],
    ancoraPresenti: [],
    incerti: [],
    erroreRimozione: false,
}

/** I percorsi dei documenti allegati dentro il JSON di UNA domanda. */
function percorsiAllegati(riga: Domanda): string[] {
    const out = new Set<string>()
    const d = riga.data as { children?: unknown[]; adults?: unknown[] } | null
    for (const gruppo of [d?.children, d?.adults]) {
        if (!Array.isArray(gruppo)) continue
        for (const p of gruppo) {
            const path = (p as { documento_path?: unknown } | null)?.documento_path
            if (typeof path === 'string' && path.trim() !== '') out.add(path.trim())
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
        const isCron = segretoCronValido(secret)
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
            .select('id, data, raccolta_senza_informativa')
            .in('status', ['pending', 'rejected'])
            .lt('created_at', soglia.toISOString())
            // ─── LE 93 RACCOLTE SENZA INFORMATIVA NON SI CANCELLANO DA SOLE ─────
            // Vedi il blocco `V3` in testa a `MESI_CONSERVAZIONE`. Il filtro sta QUI
            // e ANCHE in memoria, poco sotto: se la colonna non esistesse o il
            // filtro non arrivasse, la seconda guardia impedisce comunque la
            // cancellazione. È la stessa doppia esclusione di
            // `percorsiCitatiDaAltriPost`, e per lo stesso motivo: quello che sta
            // dopo è irreversibile.
            .eq('raccolta_senza_informativa', false)

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

        const lette = (scadute ?? []) as Domanda[]
        // LA SECONDA GUARDIA, sulle righe già lette. Se il filtro del database non
        // fosse arrivato — colonna assente, `eq` ignorato da un client, una modifica
        // futura alla query — qui la riga si ferma comunque. Costa niente e toglie di
        // mezzo un'intera classe di guasti su un'operazione che non si annulla.
        const senzaInformativa = lette.filter((r) => r.raccolta_senza_informativa === true)
        const righe = lette.filter((r) => r.raccolta_senza_informativa !== true)
        if (senzaInformativa.length > 0) {
            // Una decisione rimandata che nessuno vede è una decisione presa in
            // silenzio. Solo conteggi: sono domande d'iscrizione di minori.
            logEvento('cron', 'warn', {
                operazione: JOB,
                esito: 'trattenute-senza-informativa',
                canale,
                n_domande: senzaInformativa.length,
                msg:
                    `${JOB}: ${senzaInformativa.length} domande hanno superato i ${MESI_CONSERVAZIONE} mesi ma sono ` +
                    `marcate \`raccolta_senza_informativa\`: NON si cancellano da sole. Le due decisioni del ` +
                    `titolare (2026-07-31 «nessuna retention su questa tabella» e 2026-08-01 «24 mesi») non ` +
                    `concordano, e la cancellazione è irreversibile: serve una decisione umana`,
            })
        }
        // La domanda resta legata ai SUOI allegati fino alla fine: è ciò che permette
        // di trattenere una riga sola invece dell'intero lotto.
        const perDomanda = righe.map((r) => ({ id: r.id, percorsi: percorsiAllegati(r) }))
        const tuttiIPercorsi = [...new Set(perDomanda.flatMap((d) => d.percorsi))]

        // ── PRIMA I FILE ──
        let esito = NIENTE_DA_TOGLIERE
        if (tuttiIPercorsi.length > 0) {
            esito = await rimuoviEVerifica(supabase, BUCKET_ALLEGATI, tuttiIPercorsi, JOB)
            if (esito.erroreRimozione) {
                // La chiamata è fallita: nessun file è uscito e non c'è niente da
                // verificare. Cancellare le righe adesso renderebbe i documenti
                // irraggiungibili invece che cancellati. Si riprova il mese dopo.
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: 'file-non-rimossi',
                    canale,
                    n_file: tuttiIPercorsi.length,
                    ms: Date.now() - t0,
                    msg: `${JOB}: rimozione degli allegati non riuscita, righe NON cancellate`,
                })
                return NextResponse.json(
                    {
                        ok: false,
                        motivo: 'allegati-non-rimossi',
                        domande: 0,
                        domande_trattenute: righe.length,
                        file: tuttiIPercorsi.length,
                    },
                    { status: 500 },
                )
            }
        }

        // Un percorso che è ancora nell'archivio — o che non si è potuto verificare —
        // trattiene la SUA domanda, e soltanto quella.
        const daNonToccare = new Set(bloccanti(esito))
        const chiudibili = perDomanda.filter((d) => !d.percorsi.some((p) => daNonToccare.has(p)))
        const trattenute = perDomanda.length - chiudibili.length

        // ── POI LE RIGHE ──
        let domandeCancellate = 0
        if (chiudibili.length > 0) {
            const { error: erroreDelete } = await supabase
                .from('enrollment_submissions')
                .delete()
                .in('id', chiudibili.map((d) => d.id))
            if (erroreDelete) {
                logEvento('cron', 'error', {
                    operazione: JOB,
                    esito: 'cancellazione-fallita',
                    canale,
                    n_domande: chiudibili.length,
                    n_file: esito.rimossi.length,
                    ms: Date.now() - t0,
                    msg: `${JOB}: allegati rimossi ma righe NON cancellate`,
                })
                return NextResponse.json(
                    { ok: false, motivo: 'righe-non-cancellate', file: esito.rimossi.length },
                    { status: 500 },
                )
            }
            domandeCancellate = chiudibili.length
        }

        // Il conteggio si scrive SEMPRE, anche (soprattutto) quando è zero: «nessuna
        // riga» non può voler dire insieme «tutto a posto» e «non è mai partito». È la
        // riga che nella versione SQL non veniva mai scritta.
        logEvento('cron', 'info', {
            operazione: JOB,
            esito: 'retention-iscrizioni',
            canale,
            n_domande: domandeCancellate,
            n_domande_trattenute: trattenute,
            n_file: esito.rimossi.length,
            n_file_gia_assenti: esito.giaAssenti.length,
            n_file_bloccanti: daNonToccare.size,
            mesi: MESI_CONSERVAZIONE,
            ms: Date.now() - t0,
            msg: `${JOB}: ${domandeCancellate} domande e ${esito.rimossi.length} allegati oltre i ${MESI_CONSERVAZIONE} mesi`,
        })

        if (trattenute > 0) {
            // Il lotto è stato lavorato, ma una parte no: si dichiara guasto. Un 200 qui
            // direbbe «fatto» a chi sorveglia il lavoro notturno, e la conservazione di
            // quelle domande resterebbe scoperta senza che nessuno lo sappia.
            logEvento('cron', 'error', {
                operazione: JOB,
                esito: 'domande-trattenute',
                canale,
                n_domande: domandeCancellate,
                n_domande_trattenute: trattenute,
                n_file_bloccanti: daNonToccare.size,
                n_file_ancora_presenti: esito.ancoraPresenti.length,
                n_file_non_verificati: esito.incerti.length,
                ms: Date.now() - t0,
                msg: `${JOB}: ${trattenute} domande NON cancellate, ${daNonToccare.size} allegati ancora nell'archivio o non verificabili`,
            })
            return NextResponse.json(
                {
                    ok: false,
                    // «Non so» e «c'è ancora» restano due fatti distinti anche nella
                    // risposta: chi legge il registro deve poter distinguere un archivio
                    // che non risponde da un file che non esce.
                    motivo: esito.ancoraPresenti.length > 0 ? 'allegati-non-rimossi' : 'verifica-non-riuscita',
                    domande: domandeCancellate,
                    domande_trattenute: trattenute,
                    file: esito.rimossi.length,
                    file_bloccanti: daNonToccare.size,
                    mesi: MESI_CONSERVAZIONE,
                },
                { status: 500 },
            )
        }

        return NextResponse.json({
            ok: true,
            domande: domandeCancellate,
            file: esito.rimossi.length,
            file_gia_assenti: esito.giaAssenti.length,
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
