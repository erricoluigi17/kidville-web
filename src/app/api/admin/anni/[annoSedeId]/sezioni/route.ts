import { NextResponse, type NextRequest } from 'next/server'
import { requireStaff } from '@/lib/auth/require-staff'
import {
  assertAnnoSedeInScope,
  rispostaErroreImpostazioni,
  rispostaNonRiconosciuta,
} from '@/lib/anno/impostazioni'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseData } from '@/lib/validation/http'

const OPERAZIONE = 'admin/anni/[annoSedeId]/sezioni:POST'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST — copia le sezioni dell'anno in corso della sede nell'anno che si sta preparando (`annoSedeId`), con
 * `anno_copia_sezioni` (M45d). Serve a RILANCIARE la copia dopo aver aggiunto una classe all'anno in corso: all'apertura
 * delle iscrizioni la fa già `anno_apri_iscrizioni`. Corpo vuoto: l'anno di partenza è sempre quello attivo della sede.
 * Rifatta non duplica niente: `{ copiate, gia_presenti }`. Non copia mai docenti, orari o materie.
 *
 * Nessun anno in corso da cui partire = niente da copiare, non un errore (`copiate: 0`, con un `info`).
 */
export const POST = withRoute(
  'admin/anni/[annoSedeId]/sezioni:POST',
  async (request: NextRequest, context: { params: Promise<{ annoSedeId: string }> }) => {
    const auth = await requireStaff(request, ['admin', 'coordinator', 'segreteria'])
    if (auth.response) return auth.response
    const { annoSedeId: grezzo } = await context.params

    const id = parseData(zUuid, grezzo)
    if ('response' in id) return id.response
    const annoSedeId = id.data

    const supabase = await createAdminClient()
    const annoLetto: { scuolaId?: string } = {}
    const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, OPERAZIONE, annoLetto)
    if (fuoriSede) return fuoriSede
    const chi = { utente: auth.user.id, annoSedeId }
    const contestoErrore = { ...chi, operazione: OPERAZIONE, tipoRifiuto: 'anno-iscrizioni-rifiutate' as const }

    const attivo = await supabase.rpc('anno_attivo', { p_scuola: annoLetto.scuolaId })
    if (attivo.error) return rispostaErroreImpostazioni(attivo.error, contestoErrore)
    const partenza = typeof attivo.data === 'string' && UUID.test(attivo.data) ? attivo.data : null
    if (!partenza) {
      logEvento('anno-scolastico', 'info', { tipo: 'anno-sezioni-senza-partenza', anno_sede_id: annoSedeId, utente: auth.user.id })
      return NextResponse.json({ success: true, data: { copiate: 0, gia_presenti: 0 } })
    }

    const { data, error } = await supabase.rpc('anno_copia_sezioni', { p_da: partenza, p_a: annoSedeId })
    if (error) return rispostaErroreImpostazioni(error, contestoErrore)
    const r = data as { copiate?: unknown; gia_presenti?: unknown } | null
    if (!r || typeof r.copiate !== 'number' || typeof r.gia_presenti !== 'number') return rispostaNonRiconosciuta(OPERAZIONE)

    // Anche una copia che non ha copiato niente è un fatto da vedere (la segreteria ha premuto il pulsante): `n` è il conteggio.
    logEvento('anno-scolastico', 'info', {
      tipo: 'anno-sezioni-copiate',
      anno_sede_id: annoSedeId,
      utente: auth.user.id,
      n: r.copiate,
    })
    return NextResponse.json({ success: true, data: { copiate: r.copiate, gia_presenti: r.gia_presenti } })
  },
)
