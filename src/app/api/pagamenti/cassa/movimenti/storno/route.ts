import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { verificaSogliaCassa } from '@/lib/cassa/notifiche'
import { CASSA_SCHEMA_ASSENTE } from '@/lib/cassa/saldo'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// MODULO CASSA · storno tracciato di un movimento (contratto §3.5).
//
// I movimenti sono IMMUTABILI: si corregge solo con un contro-movimento (stesso
// tipo, stesso metodo, importo negato, `storno_di` = originale) + marca
// sull'originale (stornato_il/storno_motivo). Il MOTIVO vive in colonna e in
// registro_modifiche, MAI nei log (dati liberi).
//
// 409 se: già stornato · è esso stesso uno storno · è un movimento di chiusura
// (rettifica/prelievo: si corregge con la chiusura successiva) · è un'entrata
// auto (gli incassi si stornano dallo Scadenzario, non da qui).
// =============================================================================

const postBodySchema = z.object({
  movimento_id: zUuid,
  motivo: z.string().min(3, 'Il motivo dello storno è obbligatorio (min 3 caratteri)'),
})

interface MovRow {
  id: string
  scuola_id: string
  tipo: string
  importo: number | string
  metodo: string
  categoria_id: string | null
  stornato_il: string | null
  storno_di: string | null
  chiusura_id: string | null
  incasso_id: string | null
}

export const POST = withRoute('pagamenti/cassa/movimenti/storno:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { movimento_id, motivo } = b.data

    const supabase = await createAdminClient()

    const sel = await supabase
      .from('cassa_movimenti')
      .select('id, scuola_id, tipo, importo, metodo, categoria_id, stornato_il, storno_di, chiusura_id, incasso_id')
      .eq('id', movimento_id)
      .maybeSingle()
    if (sel.error) {
      const code = (sel.error as { code?: string }).code ?? ''
      if (CASSA_SCHEMA_ASSENTE.has(code)) {
        logEvento('cassa', 'info', { operazione: 'pagamenti/cassa/movimenti/storno:POST', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false }, { status: 503 })
      }
      logErrore({ operazione: 'pagamenti/cassa/movimenti/storno:POST', stato: 500, evento: 'db' }, sel.error)
      return NextResponse.json({ error: 'Errore nel recupero del movimento' }, { status: 500 })
    }
    const orig = sel.data as MovRow | null
    if (!orig) return NextResponse.json({ error: 'Movimento non trovato' }, { status: 404 })

    if (orig.stornato_il) return NextResponse.json({ error: 'Movimento già stornato' }, { status: 409 })
    if (orig.storno_di) return NextResponse.json({ error: 'Non si può stornare uno storno' }, { status: 409 })
    if (orig.chiusura_id) {
      return NextResponse.json(
        { error: 'Un movimento generato da una chiusura non si storna: si corregge con la chiusura successiva' },
        { status: 409 },
      )
    }
    if (orig.incasso_id) {
      return NextResponse.json(
        { error: 'Un\'entrata da incasso si storna dallo Scadenzario, non dalla cassa' },
        { status: 409 },
      )
    }

    // Contro-movimento: stesso tipo/metodo/categoria, importo negato, storno_di.
    const contro = await supabase
      .from('cassa_movimenti')
      .insert({
        scuola_id: orig.scuola_id,
        tipo: orig.tipo,
        importo: -Number(orig.importo),
        metodo: orig.metodo,
        categoria_id: orig.categoria_id ?? null,
        storno_di: orig.id,
        registrato_da: user.id,
      })
      .select('id')
      .single()
    if (contro.error) {
      logErrore({ operazione: 'pagamenti/cassa/movimenti/storno:POST', stato: 500, evento: 'db' }, contro.error)
      return NextResponse.json({ error: 'Errore nello storno del movimento' }, { status: 500 })
    }
    const controId = (contro.data as { id: string }).id

    // Marca l'originale (best-effort: colonne assenti su DB non migrato → si salta).
    await supabase
      .from('cassa_movimenti')
      .update({ stornato_il: new Date().toISOString(), storno_motivo: motivo })
      .eq('id', orig.id)
      .then(
        () => {},
        () => {},
      )

    // Audit col MOTIVO (vive qui, non nei log).
    await supabase
      .from('registro_modifiche')
      .insert({
        azione: 'storno_cassa_movimento',
        tabella_interessata: 'cassa_movimenti',
        record_id: orig.id,
        vecchio_valore: orig,
        nuovo_valore: { storno_motivo: motivo, contro_movimento_id: controId },
        utente_id: user.id,
      })
      .then(
        () => {},
        () => {},
      )

    // Lo storno può far scendere il saldo sotto soglia: rivaluta (best-effort).
    await verificaSogliaCassa(supabase, orig.scuola_id)

    // Evento critico: logga il SUCCESSO (id, MAI il motivo/PII).
    logEvento('cassa', 'info', {
      operazione: 'pagamenti/cassa/movimenti/storno:POST',
      esito: 'stornato',
      movimento_id: orig.id,
      contro_movimento_id: controId,
      scuola_id: orig.scuola_id,
    })

    return NextResponse.json({ contro_movimento_id: controId }, { status: 200 })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/cassa/movimenti/storno:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
