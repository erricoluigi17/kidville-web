import { z } from 'zod'
import { NextResponse } from 'next/server'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { versioneDeploy } from '@/lib/versione/deploy'

/**
 * GET /api/versione — «QUALE RILASCIO STAI SERVENDO ADESSO?». PUBBLICA.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * A CHE SERVE. Un'app aperta sul telefono resta in memoria per giorni: il bundle che un
 * genitore ha in mano può essere di tre deploy fa, e nessuna navigazione dentro una SPA lo
 * sostituisce — i chunk vecchi vengono serviti o falliscono, e il codice che gira è quello di
 * allora. Questa è la domanda che il client fa quando torna in primo piano dopo molto tempo
 * (`src/components/providers/ControlloVersione.tsx`); il confronto con la versione COTTA nel suo
 * bundle (`VERSIONE_BUNDLE`) decide se ricaricare.
 *
 * ─── PERCHÉ NON HA UN GATE, e perché non ha nemmeno un tetto ────────────────────
 *
 * Dietro questa porta non c'è NIENTE: la risposta è lo sha del commit di un rilascio, cioè un
 * dato che sta già nei metadati pubblici di ogni risposta di una piattaforma di hosting — e
 * questo repository è pubblico, quindi quello sha nomina un commit che chiunque può leggere su
 * GitHub. Un anonimo che passa non ottiene l'esistenza di nessuna persona, nessun conteggio,
 * nessuna configurazione. È MENO di `/api/health/vivo`, che pure è pubblica e lo stesso sha lo
 * pubblica già nel suo corpo.
 *
 * ⚠️ E NON HA `rateLimit()`, che è una scelta e va detta. Il tetto per IP di questo repo si
 * applica consumando un contatore su Postgres (`rpc('tetto_frequenza_consuma')`, client
 * service-role): UNA SCRITTURA SUL DATABASE per ogni richiesta. Questa route nasce dentro un
 * lavoro di robustezza il cui punto di partenza è misurato — lunedì 12/10, in due ore, 11.327
 * richieste su `/rest/v1/pagamenti` e il p95 del database salito da 25 ms a 350-470 ms su
 * `/auth/v1/user` — e il suo compito è TOGLIERE carico, non aggiungerne. Mettere un tetto qui
 * trasformerebbe la domanda più innocua dell'applicazione in una scrittura sul database, cioè
 * nel problema che sta venendo a chiudere.
 *
 * Ciò che resta al posto del tetto: l'handler non apre nessun client, non interroga niente e
 * non legge nemmeno il corpo della richiesta. Il suo costo è una lettura di `process.env` e una
 * regex — e la piattaforma, davanti, ha i propri limiti.
 *
 * ─── IL FILTRO DI FORMA, che è l'unica difesa che serve ─────────────────────────
 *
 * Il valore arriva da una variabile d'ambiente, e una variabile d'ambiente non è un dato nostro:
 * `shaNormalizzato` (in `@/lib/versione/deploy`) fa uscire SOLO ciò che ha la forma di uno sha.
 * Senza, questa risposta pubblica rilancerebbe il contenuto arbitrario di `process.env`.
 *
 * `versione: null` quando non c'è — in sviluppo, nella CI, in qualunque ambiente senza la
 * variabile — e non una stringa vuota: il client tratta `null` come «non lo so» e non fa niente,
 * mentre una stringa vuota sarebbe una versione diversa da tutte, cioè una ricarica garantita.
 * ════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Nessun ingresso: non ci sono query param, e un domani che li aggiungesse passa da qui.
 * Lo schema c'è comunque, come in `health/vivo`: è la forma che il repo impone a ogni porta.
 */
const querySchema = z.object({})

/** Dice che cosa sta girando ADESSO: non deve essere prerenderizzata né rivalidata. */
export const dynamic = 'force-dynamic'

export const GET = withRoute('versione:GET', async (request: Request) => {
    const q = parseQuery(request, querySchema)
    if ('response' in q) return q.response
    return NextResponse.json(
        { versione: versioneDeploy() },
        // `no-store` e non `max-age=0`: la risposta non deve finire né nella cache del
        // browser né in quella di un intermediario. Una versione in cache direbbe «sei
        // aggiornato» a tempo indeterminato — il controllo resterebbe acceso e inutile.
        { headers: { 'Cache-Control': 'no-store' } },
    )
})
