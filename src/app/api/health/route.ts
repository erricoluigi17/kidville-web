import { z } from 'zod'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { eseguiSalute } from '@/lib/health/controlli'
import { rispondiConSalute } from '@/lib/health/porta'

/**
 * GET /api/health — LA SALUTE. PUBBLICO.
 *
 * Il vivo (DB + Auth) più tutto ciò che si rompe senza che un genitore lo veda subito: schema,
 * battito dei cron, errori del server, configurazione, coda delle fatture, regione. `degraded`
 * risponde 200 (qualcosa è rotto ma il sito serve), `down` risponde 503.
 *
 * NON include la qualità dei dati (`/api/health/qualita`): dal 2026-10-06 un dato storto non tiene
 * più questo endpoint in `degraded`. Per il campanello che sorveglia «il sito è su?» c'è
 * `/api/health/vivo`. Tutto il ragionamento — tetto per IP, cosa esce nel corpo, perché `degraded`
 * non è 503 — sta in `@/lib/health/porta`; la misura in `@/lib/health/controlli`.
 */

// Nessun parametro in ingresso. Lo schema c'è comunque, e non è cerimonia: senza,
// `/api/health?scuola_id=…` accetterebbe in silenzio qualunque cosa, e la prima volta che qualcuno
// aggiunge un filtro a questo endpoint lo aggiungerebbe su una porta senza validazione.
// `z.object({})` non è strict: un monitor può appendere il suo `?t=` per bucare le cache senza
// prendersi un 400.
const querySchema = z.object({})

/** L'endpoint misura lo stato ADESSO: non deve essere prerenderizzato né rivalidato. */
export const dynamic = 'force-dynamic'

export const GET = withRoute('health:GET', async (request: Request) => {
    const q = parseQuery(request, querySchema)
    if ('response' in q) return q.response
    return rispondiConSalute(request, {
        creaClient: () => createAdminClient(),
        nome: 'health',
        esegui: (supabase, ambiente) => eseguiSalute(supabase, { ambiente }),
        http: { ok: 200, degraded: 200, down: 503 },
        httpSuEccezione: 503,
        livelloDegradato: 'warn',
    })
})
