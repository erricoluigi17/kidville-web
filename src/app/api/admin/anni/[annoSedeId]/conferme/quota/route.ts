import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAnnoSedeInScope, rispostaErroreImpostazioni } from '@/lib/anno/impostazioni'
import { generaQuotaProssima } from '@/lib/anno/iscrizione-anno'
import { rispostaFrequenzaNonTrovata } from '@/lib/anno/errori'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * «GENERA LA QUOTA» (PR 4.5, compito 4.5.16, F). `annoSedeId` = l'anno NUOVO; `frequenza_id` = la frequenza di QUELL'anno
 * (`nuova_frequenza_id` della riga), sia che il bambino arrivi da una conferma sia che arrivi da una domanda («Nuove iscrizioni»).
 *
 * Prima il pulsante c'era solo nella vista delle conferme, perché la route di conferma riparte dalla frequenza di OGGI e un
 * bambino «in arrivo» non ne ha una. Questa riparte dalla frequenza dell'anno nuovo: la voce nasce se manca, si riprende se
 * c'è già (`gia_collegata`), e se il listino non c'è o ci sono più voci la risposta lo dice (`senza_listino`, `piu_voci`).
 *
 * La frequenza dev'essere VIVA: `anno_registra_frequenza` su una ritirata la RIAPRE (4.5.16, A), e «Genera la quota» non
 * dev'essere un modo per riaprire un'iscrizione. Il controllo viene PRIMA della registrazione: 409 `FREQUENZA_NON_VIVA`.
 *
 * Stesso gate della conferma (`admin`, `coordinator`, `segreteria`) e stesso perimetro di sede.
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const

const postSchema = z.object({ frequenza_id: zUuid }).strict()

export const POST = withRoute('admin/anni/[annoSedeId]/conferme/quota:POST', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/conferme/quota:POST'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data

  const b = await parseBody(request, postSchema)
  if ('response' in b) return b.response
  const corpo = b.data

  const supabase = await createAdminClient()
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione)
  if (fuoriSede) return fuoriSede
  const ctx = { operazione, annoSedeId, utente: auth.user.id, tipoRifiuto: 'anno-iscrizioni-rifiutate' as const }

  // La frequenza dev'essere di QUESTO anno: l'URL nomina l'anno di cui si è verificata la sede, il corpo non può nominarne un altro.
  const riga = await supabase
    .from('frequenze')
    .select('id, alunno_id, anno_sede_id, stato, tipo, origine')
    .eq('id', corpo.frequenza_id)
    .maybeSingle()
  if (riga.error) return rispostaErroreImpostazioni(riga.error, { ...ctx, lettura: true })
  const f = riga.data as { id: string; alunno_id: string; anno_sede_id: string; stato: string; tipo: 'conferma' | 'nuova' | null; origine: string | null } | null
  if (!f || f.anno_sede_id !== annoSedeId) return rispostaFrequenzaNonTrovata()

  // Viva, PRIMA di registrare: la registrazione di una ritirata la riaprirebbe.
  if (f.stato !== 'in_attesa' && f.stato !== 'iscritto') return rispostaErroreImpostazioni({ message: 'FREQUENZA_NON_VIVA' }, ctx)

  const esito = await generaQuotaProssima(supabase, {
    alunnoId: f.alunno_id,
    frequenza: { id: f.id, anno_sede_id: f.anno_sede_id, stato: f.stato, tipo: f.tipo, origine: f.origine, chiusa: false },
    attoreId: auth.user.id,
  })
  if (!esito) return rispostaErroreImpostazioni({ message: 'SCRITTURA_FALLITA' }, ctx)

  // Il successo: uuid ed esito (`creata`, `gia_collegata`, `senza_listino`, `piu_voci`…). Mai un importo.
  logEvento('anno-scolastico', esito.quota === 'senza_listino' || esito.quota === 'piu_voci' ? 'warn' : 'info', {
    tipo: 'quota-generata',
    esito: esito.quota,
    operazione,
    entita_id: f.id,
    utente: auth.user.id,
  })
  return NextResponse.json({ success: true, data: { frequenza_id: f.id, quota: esito.quota, pagamento_id: esito.pagamento_id } })
})
