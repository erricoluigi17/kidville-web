import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { verificaRevocaSospensioneMorosita } from '@/lib/pagamenti/sospensione'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

const postBodySchema = z.object({
  sconto: z.coerce.number().min(0, 'Lo sconto non può essere negativo'),
  sconto_motivo: z.string().min(3, 'Il motivo dello sconto è obbligatorio (min 3 caratteri)'),
})

// POST /api/pagamenti/[id]/sconto  (staff) — applica uno sconto/abbuono su una voce.
// Body: { sconto, sconto_motivo }. Residuo effettivo = importo − sconto − già incassato.
// 409 se sconto > importo o se importo − sconto < già incassato (prima storna gli incassi).
// La colonna `sconto` è il cuore della feature: se manca (PGRST204) → 503 pulito.
export const POST = withRoute('pagamenti/[id]/sconto:POST', async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const { id: idGrezzo } = await context.params
    const pid = parseData(zUuid, idGrezzo)
    if ('response' in pid) return pid.response
    const id = pid.data

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { sconto, sconto_motivo } = b.data

    const supabase = await createAdminClient()
    const { data: pag, error: pErr } = await supabase
      .from('pagamenti')
      .select('id, alunno_id, importo, importo_pagato, tipo')
      .eq('id', id)
      .maybeSingle()
    if (pErr) {
      logErrore({ operazione: 'pagamenti/[id]/sconto:POST', stato: 500, evento: 'db' }, pErr)
      return NextResponse.json({ error: 'Errore nel recupero del pagamento' }, { status: 500 })
    }
    if (!pag) return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })

    const importo = Number((pag as { importo: number }).importo)
    const pagato = Number((pag as { importo_pagato: number | null }).importo_pagato ?? 0)

    if (sconto > importo + 0.005) {
      return NextResponse.json({ error: 'Lo sconto non può superare l\'importo della voce' }, { status: 409 })
    }
    if (importo - sconto < pagato - 0.005) {
      return NextResponse.json({ error: 'Sconto troppo alto: la voce risulterebbe sotto quanto già incassato. Storna prima gli incassi.' }, { status: 409 })
    }

    const { error: uErr } = await supabase
      .from('pagamenti')
      .update({ sconto, sconto_motivo, aggiornato_il: new Date().toISOString() })
      .eq('id', id)
      .select('id')
      .single()
    if (uErr) {
      // La colonna `sconto` è la feature stessa: se manca, non c'è degradazione utile.
      if ((uErr as { code?: string }).code === 'PGRST204') {
        return NextResponse.json({ error: 'Funzione sconto non disponibile su questo ambiente' }, { status: 503 })
      }
      logErrore({ operazione: 'pagamenti/[id]/sconto:POST', stato: 500, evento: 'db' }, uErr)
      return NextResponse.json({ error: 'Errore nell\'applicazione dello sconto', details: uErr.message }, { status: 500 })
    }

    // Ricalcolo stato sconto-aware (dovuto = max(importo − sconto, 0)).
    const tipo = (pag as { tipo?: string }).tipo
    if (tipo === 'padre') {
      await supabase.rpc('ricalcola_stato_padre', { p_parent: id }).then(() => {}, () => {})
    } else {
      await supabase.rpc('ricalcola_stato_pagamento', { p_id: id }).then(() => {}, () => {})
    }

    await supabase
      .from('registro_modifiche')
      .insert({
        azione: 'applica_sconto',
        tabella_interessata: 'pagamenti',
        record_id: id,
        nuovo_valore: { sconto, sconto_motivo },
        utente_id: user.id,
      })
      .then(() => {}, () => {})

    // Evento critico: logga il SUCCESSO (importo dello sconto, MAI il motivo).
    logEvento('pagamento', 'info', {
      operazione: 'pagamenti/[id]/sconto:POST',
      esito: 'sconto_applicato',
      pagamento_id: id,
      sconto,
    })

    // Lo sconto abbassa il residuo effettivo → può azzerare lo scaduto famiglia:
    // revoca automatica della sospensione (best-effort, mai bloccante).
    try {
      const alunnoId = (pag as { alunno_id?: string | null }).alunno_id
      if (alunnoId) await verificaRevocaSospensioneMorosita(supabase, [alunnoId])
    } catch (e) {
      logEvento('pagamento', 'error', { operazione: 'pagamenti/[id]/sconto:POST', esito: 'revoca_non_verificata' }, e)
    }

    return NextResponse.json({ success: true, data: { id, sconto } })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/[id]/sconto:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
