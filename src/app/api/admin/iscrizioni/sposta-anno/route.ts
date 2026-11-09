import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { createAdminClient } from '@/lib/supabase/server-client'
import { erroreAnno } from '@/lib/anno/errori'
import { anniDellaSede } from '@/lib/anno/lettura'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import { STATO_DOMANDA_IN_ATTESA } from '@/lib/iscrizioni/stati'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { zUuid } from '@/lib/validation/common'
import { parseBody } from '@/lib/validation/http'

/**
 * SPOSTARE UNA DOMANDA DI ANNO (PR 4.5.8, specifica §4.18.13).
 *
 * Le domande arrivate da settembre restano nell'anno in corso finché la segreteria non le sposta: questa è la mano della
 * segreteria. Cambia una cosa sola — `enrollment_submissions.anno_id` — e solo se:
 *  · la domanda è ancora IN ATTESA (una approvata è già un'anagrafica e una frequenza: non si sposta, 409);
 *  · l'anno è un anno della STESSA sede della domanda con le domande aperte (`domande_aperte`), altrimenti 422;
 *  · chi chiede ha la sede della domanda fra le sue.
 * Il filtro sullo stato sta DENTRO l'UPDATE: fra la lettura e la scrittura un'altra segreteria può averla approvata.
 *
 * ⚠️ Nei log solo uuid (la domanda, i due anni) e codici: la domanda porta dati di minori.
 */
const OPERAZIONE = 'admin/iscrizioni/sposta-anno:POST'
const STAFF = ['admin', 'coordinator', 'segreteria'] as const

const bodySchema = z
  .object({
    domanda_id: zUuid,
    /** `anni_scolastici.id`: lo stesso valore che il modulo pubblico scrive in `enrollment_submissions.anno_id`. */
    anno_id: zUuid,
  })
  .strict()

export const POST = withRoute('admin/iscrizioni/sposta-anno:POST', async (request: NextRequest) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response

  const b = await parseBody(request, bodySchema)
  if ('response' in b) return b.response
  const { domanda_id: domandaId, anno_id: annoId } = b.data

  try {
    const supabase = await createAdminClient()

    const { data: domanda, error: errDomanda } = await supabase
      .from('enrollment_submissions')
      .select('id, scuola_id, status, anno_id')
      .eq('id', domandaId)
      .maybeSingle()
    if (errDomanda) {
      // Schema dell'anno assente (il DB della CI): la colonna non c'è, e non c'è niente da spostare.
      if (schemaAnnoIndietro(errDomanda)) {
        logEvento('anno-scolastico', 'info', { tipo: 'domanda-spostata-schema-indietro', operazione: OPERAZIONE, error_code: errDomanda.code ?? undefined })
        return NextResponse.json({ error: 'Lo spostamento di anno non è disponibile.', codice: 'ANNO_NON_OFFERTO' }, { status: 422 })
      }
      logErrore({ operazione: OPERAZIONE, stato: 500 }, new Error(`sposta-anno:${errDomanda.code ?? 'senza-codice'}`))
      return NextResponse.json({ error: 'Errore interno', codice: 'ERRORE_INTERNO' }, { status: 500 })
    }
    if (!domanda) {
      return NextResponse.json({ error: 'Domanda non trovata', codice: 'DOMANDA_NON_APRIBILE' }, { status: 404 })
    }
    const riga = domanda as { id: string; scuola_id: string | null; status: string; anno_id: string | null }

    // Il gate sull'OGGETTO: la sede della domanda dev'essere fra quelle di chi chiede (come la PATCH dell'import).
    if (riga.scuola_id) {
      const accessibili = await scuoleDiUtente(supabase, auth.user)
      if (!accessibili.includes(riga.scuola_id)) {
        logEvento('multi_sede', 'warn', {
          operazione: OPERAZIONE,
          esito: 'invio-di-altra-sede',
          sede_id: riga.scuola_id,
        })
        return rifiutoSede('SEDE_NON_ACCESSIBILE')
      }
    }

    if (riga.status !== STATO_DOMANDA_IN_ATTESA) {
      return rifiutaGiaEsaminata(domandaId)
    }

    // Un anno senza sede (domanda storica senza `scuola_id`) non ha un posto in cui spostarsi.
    const anni = riga.scuola_id ? await anniDellaSede(supabase, riga.scuola_id) : null
    if (!anni || 'indietro' in anni || 'guasto' in anni) {
      if (anni && 'guasto' in anni) {
        logErrore({ operazione: OPERAZIONE, stato: 500 }, new Error('sposta-anno:anni-sede-non-letti'))
        return NextResponse.json({ error: 'Errore interno', codice: 'ERRORE_INTERNO' }, { status: 500 })
      }
      return erroreAnno({ message: 'ANNO_NON_OFFERTO' }, OPERAZIONE) as NextResponse
    }
    const anno = anni.righe.find((r) => r.anno_id === annoId)
    if (!anno || anno.domande_aperte !== true) {
      logEvento('anno-scolastico', 'warn', {
        tipo: 'domanda-non-spostata',
        operazione: OPERAZIONE,
        error_code: 'ANNO_NON_OFFERTO',
        entita_id: domandaId,
        anno_a_id: annoId,
      })
      return erroreAnno({ message: 'ANNO_NON_OFFERTO' }, OPERAZIONE) as NextResponse
    }

    const { data: spostata, error: errUpdate } = await supabase
      .from('enrollment_submissions')
      .update({ anno_id: annoId, updated_at: new Date().toISOString() })
      .eq('id', domandaId)
      .eq('status', STATO_DOMANDA_IN_ATTESA)
      .select('id')
      .maybeSingle()
    if (errUpdate) {
      logErrore({ operazione: OPERAZIONE, stato: 500 }, new Error(`sposta-anno:${errUpdate.code ?? 'senza-codice'}`))
      return NextResponse.json({ error: 'Errore interno', codice: 'ERRORE_INTERNO' }, { status: 500 })
    }
    if (!spostata) return rifiutaGiaEsaminata(domandaId)

    logEvento('anno-scolastico', 'info', {
      tipo: 'domanda-spostata-di-anno',
      operazione: OPERAZIONE,
      esito: 'spostata',
      utente: auth.user.id,
      entita_id: domandaId,
      anno_da_id: riga.anno_id ?? undefined,
      anno_a_id: annoId,
    })
    return NextResponse.json({ success: true, data: { domanda_id: domandaId, anno_id: annoId } })
  } catch (err) {
    logErrore({ operazione: OPERAZIONE, stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno', codice: 'ERRORE_INTERNO' }, { status: 500 })
  }
})

function rifiutaGiaEsaminata(domandaId: string): NextResponse {
  logEvento('anno-scolastico', 'warn', {
    tipo: 'domanda-non-spostata',
    operazione: OPERAZIONE,
    error_code: 'DOMANDA_GIA_ESAMINATA',
    entita_id: domandaId,
  })
  return NextResponse.json(
    { error: "La domanda è già stata esaminata: aggiorna l'elenco per vedere il suo stato.", codice: 'DOMANDA_GIA_ESAMINATA' },
    { status: 409 },
  )
}
