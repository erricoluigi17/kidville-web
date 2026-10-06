import { z } from 'zod'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { eseguiQualita } from '@/lib/health/controlli'
import { rispondiConSalute } from '@/lib/health/porta'

/**
 * GET /api/health/qualita — LA QUALITÀ DEI DATI. PUBBLICO, e non accende nessun allarme.
 *
 * Dice se i dati sono storti (oggi: alunni col testo della classe diverso dal nome della sezione),
 * non se il servizio è rotto. Risponde SEMPRE 200, anche con `degraded`: chi la legge è chi
 * sistema i dati, non un monitor. Fino al 2026-10-05 questo controllo viveva dentro `/api/health` e
 * lo teneva in `degraded` per due giorni — un allarme sempre acceso vale come uno spento.
 *
 * Il corpo porta solo un numero («2 alunni col testo classe divergente»): mai nomi di classi,
 * mai nomi di bambini. La rotta è pubblica.
 */
const querySchema = z.object({})

/** Misura lo stato ADESSO: non deve essere prerenderizzato né rivalidato. */
export const dynamic = 'force-dynamic'

export const GET = withRoute('health/qualita:GET', async (request: Request) => {
    const q = parseQuery(request, querySchema)
    if ('response' in q) return q.response
    return rispondiConSalute(request, {
        creaClient: () => createAdminClient(),
        nome: 'health-qualita',
        esegui: (supabase) => eseguiQualita(supabase),
        // 200 anche per `down`: la qualità dei dati non è un'interruzione di servizio.
        http: { ok: 200, degraded: 200, down: 200 },
        httpSuEccezione: 200,
        livelloDegradato: 'info',
    })
})
