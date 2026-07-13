import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAlunnoInScope } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// Comportamento storico preservato: `sospeso` conta solo se strettamente === true,
// `motivo` è usato solo se stringa — qualunque altro valore è tollerato (→ false/null).
// NB zod v4: z.unknown() come chiave è required a runtime, serve .optional().
const postBodySchema = z.object({
  alunno_id: zUuid,
  sospeso: z.unknown().optional(),
  motivo: z.unknown().optional(),
})

// POST /api/admin/pagamenti/sospensione  (Direzione) — sospende/riattiva un alunno
// per morosità (DL-021). Body: { userId, alunno_id, sospeso: boolean, motivo? }.
// Azione manuale e consapevole, riservata alla Direzione (admin/coordinator).
export const POST = withRoute('admin/pagamenti/sospensione:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const alunnoId = b.data.alunno_id
    const sospeso = b.data.sospeso === true

    const supabase = await createAdminClient()

    const scopeErr = await assertAlunnoInScope(supabase, auth.user, alunnoId)
    if (scopeErr) return scopeErr

    const patch = sospeso
      ? {
          sospeso: true,
          sospeso_motivo: typeof b.data.motivo === 'string' ? b.data.motivo : null,
          sospeso_il: new Date().toISOString(),
          sospeso_da: auth.user.id,
        }
      : { sospeso: false, sospeso_motivo: null, sospeso_il: null, sospeso_da: auth.user.id }

    const { error } = await supabase.from('alunni').update(patch).eq('id', alunnoId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'sospensione',
      entitaId: alunnoId,
      azione: sospeso ? 'insert' : 'delete',
      scuolaId: auth.user.scuola_id,
      valoreDopo: { sospeso, motivo: patch.sospeso_motivo },
    })

    // Notifica formale al genitore (best-effort). Testo NEUTRO in push
    // (privacy: il dettaglio si legge in-app); anche la riattivazione avvisa.
    try {
      const { data: alunno } = await supabase.from('alunni').select('scuola_id').eq('id', alunnoId).maybeSingle()
      await notificaEvento(supabase, {
        tipo: 'sospensione_morosita',
        scuolaId: (alunno?.scuola_id as string | undefined) ?? auth.user.scuola_id ?? null,
        alunnoIds: [alunnoId],
        titolo: 'Avviso amministrativo',
        corpo: sospeso
          ? 'C’è una comunicazione amministrativa importante: apri la sezione Pagamenti.'
          : 'Il servizio è stato riattivato. Dettagli nella sezione Pagamenti.',
        link: '/parent/pagamenti',
        entitaTipo: 'sospensione',
        entitaId: alunnoId,
        bufferMin: 0,
      })
    } catch (e) {
      console.error('Notifica sospensione fallita (non bloccante):', e)
    }

    return NextResponse.json({ success: true, data: { alunno_id: alunnoId, sospeso } })
  } catch (err) {
    logErrore({ operazione: 'admin/pagamenti/sospensione:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
