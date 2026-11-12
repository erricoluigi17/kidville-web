import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { resolveScuolaScrittura, resolveScuoleAttive, restringiSedi } from '@/lib/auth/scope'
import { requireCrm } from '@/lib/crm/accesso'
import { rifiutoAi } from '@/lib/crm/ai/accesso'
import { crmAiAttivo, sedeAmmessaAi } from '@/lib/crm/ai/interruttore'
import { generaToken } from '@/lib/crm/ai/token'
import { rispostaErroreDbSchema } from '@/lib/crm/errori'
import type { IntegrazioneRow } from '@/lib/crm/tipi'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseQuery } from '@/lib/validation/http'

const querySchema = z.object({ scuolaId: zUuid }).strict()
const creaSchema = z.object({ scuolaId: zUuid, nome: z.string().trim().min(1).max(80) }).strict()

type IntegrazioneElenco = Pick<IntegrazioneRow, 'id' | 'nome' | 'token_coda' | 'creata_il' | 'revocata_il' | 'ultimo_uso_il'>

const SOLO_ADMIN = () =>
  NextResponse.json({ error: 'Questa operazione è riservata alla Direzione.', codice: 'SOLO_ADMIN' }, { status: 403 })

export const GET = withRoute('admin/crm/integrazioni:GET', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const operazione = 'admin/crm/integrazioni:GET'
  if (auth.user.role !== 'admin') {
    logEvento('multi_sede', 'warn', {
      operazione, esito: 'integrazioni-non-admin', utente: auth.user.id, ruolo: auth.user.role,
    })
    return SOLO_ADMIN()
  }

  const q = parseQuery(request, querySchema)
  if ('response' in q) return q.response
  const supabase = await createAdminClient()
  const attive = await resolveScuoleAttive(request, supabase, auth.user)
  const scuole = restringiSedi(attive, q.data.scuolaId)
  if (!scuole?.length) {
    logEvento('multi_sede', 'warn', {
      operazione, esito: 'sede-filtro-fuori-scope', utente: auth.user.id, ruolo: auth.user.role, sede_id: q.data.scuolaId,
    })
    return rifiutoSede('SEDE_NON_ACCESSIBILE')
  }

  const { data, error } = await supabase
    .from('crm_integrazioni')
    .select('id, nome, token_coda, creata_il, revocata_il, ultimo_uso_il')
    .in('scuola_id', scuole)
    .order('creata_il', { ascending: false })
  if (error) return rispostaErroreDbSchema(erroreDbSoloCodice(error), operazione)

  const elenco = ((data ?? []) as IntegrazioneElenco[]).map((riga) => ({
    id: riga.id,
    nome: riga.nome,
    coda: riga.token_coda,
    creataIl: riga.creata_il,
    revocataIl: riga.revocata_il,
    ultimoUsoIl: riga.ultimo_uso_il,
  }))
  const scuolaId = scuole[0]
  logEvento('crm', 'info', { operazione, esito: 'integrazioni-elencate', scuola_id: scuolaId, n: elenco.length })
  return NextResponse.json({ data: elenco, aiAttivo: crmAiAttivo(), sedeAmmessa: sedeAmmessaAi(scuolaId) })
})

export const POST = withRoute('admin/crm/integrazioni:POST', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const operazione = 'admin/crm/integrazioni:POST'
  if (auth.user.role !== 'admin') {
    logEvento('multi_sede', 'warn', {
      operazione, esito: 'integrazioni-non-admin', utente: auth.user.id, ruolo: auth.user.role,
    })
    return SOLO_ADMIN()
  }

  const b = await parseBody(request, creaSchema)
  if ('response' in b) return b.response
  const supabase = await createAdminClient()
  const { scuolaId } = await resolveScuolaScrittura(request, supabase, auth.user, b.data.scuolaId)
  if (!scuolaId) return rifiutoSede('SEDE_NON_ACCESSIBILE')
  if (!sedeAmmessaAi(scuolaId)) {
    logEvento('crm', 'warn', { operazione, esito: 'integrazione-rifiutata', scuola_id: scuolaId, error_code: 'SEDE_NON_AMMESSA', stato: 403 })
    return rifiutoAi('SEDE_NON_AMMESSA', 403)
  }

  const { token, impronta, coda } = generaToken()
  const { data, error } = await supabase
    .from('crm_integrazioni')
    .insert({ scuola_id: scuolaId, nome: b.data.nome, token_impronta: impronta, token_coda: coda, creata_da: auth.user.id })
    .select('id')
    .single()
  if (error?.code === '23505') {
    logEvento('crm', 'warn', { operazione, esito: 'integrazione-rifiutata', scuola_id: scuolaId, error_code: 'INTEGRAZIONE_ESISTENTE', stato: 409 })
    return rifiutoAi('INTEGRAZIONE_ESISTENTE', 409)
  }
  if (error || !data) return rispostaErroreDbSchema(erroreDbSoloCodice(error), operazione)

  logEvento('crm', 'info', { operazione, esito: 'integrazione-creata', scuola_id: scuolaId, entita_id: data.id })
  return NextResponse.json({ id: data.id, token }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
})
