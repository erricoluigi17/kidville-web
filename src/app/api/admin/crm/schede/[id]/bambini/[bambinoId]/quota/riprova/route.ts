import { NextResponse, type NextRequest } from 'next/server'
import { assertBambinoInScope, assertSchedaInScope, requireCrm } from '@/lib/crm/accesso'
import { rispostaCrmNonInstallato, rispostaCrmNonRiuscita } from '@/lib/crm/errori'
import { passaQuotaInContabilita } from '@/lib/crm/quota'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseData } from '@/lib/validation/http'

/**
 * CRM della segreteria · «Riprova»: ritenta il passaggio in contabilità di una quota rimasta in attesa o
 * bloccata (per esempio dopo che la segreteria ha sistemato la voce dell'alunno).
 *
 * `POST /api/admin/crm/schede/[id]/bambini/[bambinoId]/quota/riprova` → `200 { data: EsitoPassaggio }`.
 *
 * Non scrive niente da sé: chiama `passaQuotaInContabilita` (la funzione SQL `crm_quota_passa`, una
 * transazione) e risponde con il suo esito. NON manda notifiche al genitore: è un aggancio fatto DOPO, e un
 * «Pagamento registrato» per un pagamento di giorni prima arriverebbe fuori tempo.
 *
 * ── Esito SQL → risposta ───────────────────────────────────────────────────────────────────────
 *  · `ok`, `bloccata` (+ motivo), `gia_in_contabilita`, `non_pronta`, `sede_diversa`, `categoria_assente`
 *    → 200 `{ data }`: sono risposte, non guasti (la schermata sa cosa dire per ciascuna; la categoria di
 *    sistema assente è comunque un incidente, e `passaQuotaInContabilita` lo logga a livello `error`);
 *  · `voce_eliminata` (la quota era passata, ma la voce è stata eliminata dallo scadenzario) → 200 `{ data }`
 *    anche lei: fino al 01/11/2026 rispondeva 500 `CRM_OPERAZIONE_NON_RIUSCITA` (prova d'uso nella sede Demo);
 *  · `non_trovato` → 404 `SCHEDA_NON_TROVATA`;
 *  · `non_installato` → 503 `CRM_NON_INSTALLATO`;
 *  · `errore` → 500 `CRM_OPERAZIONE_NON_RIUSCITA` (il dettaglio è nel log).
 *
 * La sede è quella della scheda: il bambino deve esserne (`assertBambinoInScope`), perché la funzione SQL
 * lavora con la service-role e non conosce la sede di chi chiede.
 */

const OPERAZIONE = 'admin/crm/schede/[id]/bambini/[bambinoId]/quota/riprova:POST'

export const POST = withRoute(
  'admin/crm/schede/[id]/bambini/[bambinoId]/quota/riprova:POST',
  async (request: NextRequest, context: { params: Promise<{ id: string; bambinoId: string }> }) => {
    const auth = await requireCrm(request)
    if (auth.response) return auth.response

    const parametri = await context.params
    const idP = parseData(zUuid, parametri.id)
    if ('response' in idP) return idP.response
    const bambinoP = parseData(zUuid, parametri.bambinoId)
    if ('response' in bambinoP) return bambinoP.response

    const supabase = await createAdminClient()
    const ambito = await assertSchedaInScope(supabase, auth.user, idP.data)
    if ('response' in ambito) return ambito.response
    const trovato = await assertBambinoInScope(supabase, ambito.scheda, bambinoP.data, OPERAZIONE)
    if ('response' in trovato) return trovato.response

    const esito = await passaQuotaInContabilita(supabase, trovato.bambino.id, auth.user.id)

    if (esito.esito === 'non_trovato') {
      return NextResponse.json({ error: 'Scheda non trovata.', codice: 'SCHEDA_NON_TROVATA' }, { status: 404 })
    }
    // Il guasto e l'assenza dello schema sono già nel log (le ha scritte `passaQuotaInContabilita`).
    if (esito.esito === 'non_installato') return rispostaCrmNonInstallato()
    if (esito.esito === 'errore') return rispostaCrmNonRiuscita()

    return NextResponse.json({ data: esito })
  },
)
