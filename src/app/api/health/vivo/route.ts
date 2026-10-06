import { z } from 'zod'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { eseguiVivo } from '@/lib/health/controlli'
import { rispondiConSalute } from '@/lib/health/porta'

/**
 * GET /api/health/vivo — «IL SITO SERVE I GENITORI?». PUBBLICO.
 *
 * È l'unico endpoint che deve sorvegliare un campanello esterno (Better Stack, UptimeRobot, il
 * workflow `campanello.yml`): database e Auth, 200 oppure 503, niente altro. Ogni controllo in più
 * sarebbe una ragione in più per svegliare qualcuno di notte per qualcosa che non impedisce a
 * nessuno di entrare. Il quadro completo è `/api/health`.
 *
 * Il corpo porta anche `regione` e `versione` (sha del commit del deploy): la verifica dopo il
 * deploy se ne serve per sapere che parla col rilascio nuovo e che la regione non è regredita.
 */
const querySchema = z.object({})

/** Misura lo stato ADESSO: non deve essere prerenderizzato né rivalidato. */
export const dynamic = 'force-dynamic'

export const GET = withRoute('health/vivo:GET', async (request: Request) => {
    const q = parseQuery(request, querySchema)
    if ('response' in q) return q.response
    return rispondiConSalute(request, {
        creaClient: () => createAdminClient(),
        nome: 'health-vivo',
        esegui: (supabase) => eseguiVivo(supabase),
        http: { ok: 200, degraded: 200, down: 503 },
        httpSuEccezione: 503,
        livelloDegradato: 'warn',
    })
})
