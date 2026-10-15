import { applicaRettificaStorica, eRettificaStorica, storicoIndisponibile } from '@/lib/primaria/rettifica-storica'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente, restringiSedi } from '@/lib/auth/scope'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { conservaRevisione } from '@/lib/storici/revisioni'
import { logScrittura } from '@/lib/audit/scrittura'
import { notificaTitolariScrittura } from '@/lib/primaria/notifiche'

const schema = z.object({ versioneAttesa: z.number().int().nonnegative().optional(), presenzaId: zUuid, firmaIl: z.iso.datetime({ offset: true }).nullable() })

/** Revoca amministrativa della giustifica: il dato firmato originale resta nell'archivio revisioni. */
export const DELETE = withRoute('attendance/justification:DELETE', async (request: NextRequest) => {
  const operazione = 'attendance/justification:DELETE'
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const body = await parseBody(request, schema)
  if ('response' in body) return body.response
  const db = await createAdminClient()
  const { data: indice, error: letturaIndice } = await db.from('presenze').select('id, alunno_id, scuola_id').eq('id', body.data.presenzaId).maybeSingle()
  if (letturaIndice) {
    logEvento('registro', 'error', { operazione, esito: 'giustifica-non-letta' }, letturaIndice)
    return NextResponse.json({ error: 'Lettura non riuscita', codice: 'LETTURA_FALLITA' }, { status: 500 })
  }
  if (!indice) return NextResponse.json({ error: 'Presenza non trovata', codice: 'PRESENZA_NON_TROVATA' }, { status: 404 })
  const sedi = await scuoleDiUtente(db, auth.user)
  if (!indice.scuola_id || !restringiSedi(sedi, String(indice.scuola_id))) {
    logEvento('registro', 'warn', { operazione, esito: 'giustifica-fuori-sede', presenza: body.data.presenzaId })
    return NextResponse.json({ error: 'Sede non accessibile', codice: 'SEDE_NON_ACCESSIBILE' }, { status: 403 })
  }
  const { data: originale, error: lettura } = await db.from('presenze').select('*').eq('id', body.data.presenzaId).eq('alunno_id', indice.alunno_id).eq('scuola_id', indice.scuola_id).maybeSingle()
  if (lettura) {
    logEvento('registro', 'error', { operazione, esito: 'originale-firmato-non-letto' }, lettura)
    return NextResponse.json({ error: 'Lettura non riuscita', codice: 'LETTURA_FALLITA' }, { status: 500 })
  }
  if (!originale) return NextResponse.json({ error: 'Presenza non trovata', codice: 'PRESENZA_NON_TROVATA' }, { status: 404 })
  const firma = (originale.giustificata_il as string | null) ?? null
  const attesa = body.data.firmaIl
  if (!originale.giustificata || firma !== attesa) {
    return NextResponse.json({ error: 'Giustifica cambiata: rileggi la presenza.', codice: 'GIUSTIFICA_CAMBIATA' }, { status: 409 })
  }
  const valori = { giustificata: false, giustificata_da: null, giustificata_il: null, giustificazione_testo: null, giustificazione_firma: null, giust_vista_il: null, giust_vista_da: null, aggiornato_il: new Date().toISOString() }
  if (eRettificaStorica(auth.user, String(originale.data))) {
    if (originale.storico_versione === undefined) return storicoIndisponibile()
    const rettifica = await applicaRettificaStorica(db, { attore: auth.user, scuolaId: String(originale.scuola_id), alunnoId: String(originale.alunno_id), sectionId: originale.section_id, modulo: 'giustifiche-presenza', giorno: String(originale.data), attese: [{ tabella: 'presenze', filtro: { id: originale.id, scuola_id: originale.scuola_id, alunno_id: originale.alunno_id }, versione: body.data.versioneAttesa }], azioni: [{ tabella: 'presenze', operazione: 'update', filtro: { id: originale.id, scuola_id: originale.scuola_id, alunno_id: originale.alunno_id }, valori }] })
    if ('response' in rettifica) return rettifica.response
  } else {
  try {
    if (!originale.scuola_id) throw new Error('Sede non disponibile')
    await conservaRevisione(db, { attore: auth.user, scuolaId: String(originale.scuola_id), alunnoId: String(originale.alunno_id), sectionId: originale.section_id, modulo: 'giustifiche-presenza', entitaId: String(originale.id), giornoCompetenza: String(originale.data), contenuto: originale })
  } catch (err) {
    logEvento('registro', 'error', { operazione, esito: 'originale-firmato-non-conservato' }, err)
    return NextResponse.json({ error: 'Impossibile conservare la giustifica originale. Nessuna modifica applicata.', codice: 'STORICO_NON_DISPONIBILE' }, { status: 503 })
  }
  let scrittura = db.from('presenze').update({ giustificata: false, giustificata_da: null, giustificata_il: null, giustificazione_testo: null, giustificazione_firma: null, giust_vista_il: null, giust_vista_da: null, aggiornato_il: new Date().toISOString() }).eq('id', originale.id).eq('scuola_id', originale.scuola_id).eq('alunno_id', originale.alunno_id).eq('giustificata', true)
  scrittura = firma ? scrittura.eq('giustificata_il', firma) : scrittura.is('giustificata_il', null)
  const { data: righe, error } = await scrittura.select('id')
  if (error) {
    logEvento('registro', 'error', { operazione, esito: 'giustifica-non-annullata' }, error)
    return NextResponse.json({ error: 'Giustifica non annullata', codice: 'GIUSTIFICA_NON_ANNULLATA' }, { status: 500 })
  }
  if (!righe?.length) return NextResponse.json({ error: 'Giustifica cambiata: rileggi la presenza.', codice: 'GIUSTIFICA_CAMBIATA' }, { status: 409 })
  }
  await logScrittura(db, { attore: auth.user, entitaTipo: 'presenze', entitaId: String(originale.id), scuolaId: String(originale.scuola_id), sectionId: originale.section_id, azione: 'update', valorePrima: { giustificata: true }, valoreDopo: { giustificata: false } })
  if (originale.section_id) await notificaTitolariScrittura(db, { attore: auth.user, sectionId: String(originale.section_id), scuolaId: String(originale.scuola_id), area: 'presenze' })
  logEvento('registro', 'info', { operazione, esito: 'giustifica-annullata-originale-conservato', presenza: originale.id })
  return NextResponse.json({ success: true })
})
