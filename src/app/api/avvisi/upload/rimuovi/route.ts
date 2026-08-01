import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { BUCKET_AVVISI_ALLEGATI } from '@/lib/allegati/storage'
import { verificaRimozioneAllegato } from '@/lib/allegati/sigillo'
import { rimuoviAllegatoNonPubblicato } from '@/lib/allegati/rimozione'
import { rispostaAllegatoNonRimosso } from '@/lib/allegati/risposte'

/**
 * L'ALLEGATO CARICATO E MAI PUBBLICATO (S35 · collaudo del 2026-07-31).
 *
 * `POST /api/avvisi/upload` mette subito il file nel bucket, perché l'anteprima deve
 * comparire mentre si scrive l'avviso. Se poi si toglie l'allegato o si chiude il modulo,
 * quel file restava lì per sempre e nessuna riga lo nominava: in produzione ce n'era già uno
 * del 24/05/2026. Un modulo di gita coi nomi dei bambini, un certificato, un verbale
 * conservati senza più uno scopo — e invisibili, perché non compaiono in nessuna schermata.
 *
 * Questa route è l'altra metà dell'upload. È scritta per NON diventare il modo di cancellare
 * l'allegato di qualcun altro: il percorso non è un segreto (si legge dal link firmato che
 * la bacheca restituisce), quindi non basta chiedere.
 *
 *   1. `requireDocente` — lo stesso gate dell'upload, e viene per primo: un anonimo non
 *      arriva nemmeno a far partire una query.
 *   2. IL SIGILLO — HMAC su bucket + percorso + utente + scadenza, emesso dall'upload
 *      (`src/lib/allegati/sigillo.ts`). Dimostra «questo file l'hai caricato TU, poco fa».
 *      L'utente non lo dichiara: si prende da `auth.user.id`, cioè dal gate.
 *   3. NESSUN AVVISO LO REFERENZIA (`rimuoviAllegatoNonPubblicato`) — fra il caricamento e
 *      la chiusura la bozza può essere stata pubblicata in un'altra scheda, e allora quel
 *      file è l'allegato di una comunicazione viva. La ricerca è volutamente senza filtro di
 *      sede: il bucket è UNO per tutte e tre, e un avviso di Aversa che punta a questo
 *      oggetto va rispettato anche se a chiedere è Giugliano.
 *
 * COSA NON FA, DI PROPOSITO: non risponde 500 quando la rimozione non riesce. Chi ha chiuso
 * il modulo ha già ottenuto quello che voleva; un errore in faccia (o peggio, una chiusura
 * che non avviene) trasformerebbe la pulizia di un residuo in un guasto del prodotto. Il
 * fatto resta nel log, che è l'unico posto in cui può esistere.
 */

const bodySchema = z.object({
    /** Il percorso nel bucket, così come l'upload l'ha restituito. */
    percorso: z.string().trim().min(1).max(300),
    /** Il sigillo emesso dall'upload per QUEL percorso e QUESTO utente. */
    sigillo: z.string().trim().min(1).max(300),
})

export const POST = withRoute('avvisi/upload/rimuovi:POST', async (request: Request) => {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const body = await parseBody(request, bodySchema)
    if ('response' in body) return body.response
    const { percorso, sigillo } = body.data

    const valido = verificaRimozioneAllegato({
        bucket: BUCKET_AVVISI_ALLEGATI,
        percorso,
        utenteId: auth.user.id,
        sigillo,
    })
    if (!valido) {
        // `warn` e non `error`: dal punto di vista del sistema è un tentativo respinto, non
        // un guasto. Ma la riga ci vuole — è l'unico segnale se qualcuno prova a cancellare
        // un allegato che non ha caricato lui. Il PERCORSO non si logga: in questo repo un
        // percorso di allegato è una credenziale (apre il file, una volta firmato), e il
        // nome dice pure di che comunicazione si tratta.
        logEvento('storage', 'warn', {
            operazione: 'avvisi/upload/rimuovi:POST',
            esito: 'sigillo-non-valido',
            bucket: BUCKET_AVVISI_ALLEGATI,
        })
        return rispostaAllegatoNonRimosso(403)
    }

    const supabase = await createAdminClient()
    const rimossi = await rimuoviAllegatoNonPubblicato(supabase, percorso, 'avvisi/upload/rimuovi:POST')

    // Il successo si logga (AGENTS §5), ma il conteggio lo scrive già
    // `rimuoviDalBucket`: qui basta l'esito per il chiamante. `rimosso: false` non è un
    // errore — è il caso normale in cui il file è nel frattempo diventato l'allegato di un
    // avviso pubblicato, e allora deve restare.
    return NextResponse.json({ rimosso: rimossi > 0 })
})
