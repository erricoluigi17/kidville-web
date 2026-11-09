import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAnnoSedeInScope, rispostaErroreImpostazioni } from '@/lib/anno/impostazioni'
import { senzaFirmaInApp, type ModuloDelRegistro } from '@/lib/anno/senza-firma-app'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { haUnaFirmaInApp } from '@/lib/prestampati/firma-per-anno'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zLimite, zUuid } from '@/lib/validation/common'
import { parseData, parseQuery } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * CHI NON HA FIRMATO IN APP (PR 4.7, compito 4.7.2; la promessa era del blocco 4.4 e la 4.5 l'ha rimandata qui). `annoSedeId` =
 * `anni_sede.id` dell'anno.
 *
 * Per UN modulo del registro dei prestampati richiesto dall'anno (`?modulo_id=`): l'elenco, a pagine da 50 al massimo, delle frequenze
 * vive della lista del modulo che NON hanno una firma in app valida per quell'anno. Sono NOMI DI MINORI:
 *  · gate di ruolo (admin, coordinator, segreteria) e perimetro di sede (`assertAnnoSedeInScope`);
 *  · il fascicolo si legge per metadati (`student_id, document_type, created_at`, mai il contenuto) e ogni bambino MOSTRATO nella
 *    pagina passa dal registro degli accessi (`logAccessoFascicolo`, azione `list`). Una riga per bambino della pagina (≤ 50), non
 *    per ogni bambino scansionato: 500 righe a ogni apertura renderebbero il registro inutile, e i metadati non aprono un fascicolo
 *    (scelta 4 del piano; se è sbagliata si passa a una riga aggregata per richiesta);
 *  · i nomi (nome e cognome, due colonne) e la classe sono SOLO quelli della pagina; nei log mai un nome.
 * Un modulo che non è dell'anno, o che non è del registro (un foglio cartaceo non ha una firma in app), risponde 422
 * `MODULO_NON_RICHIESTO`. Se una lettura cade la risposta è l'errore: mai un elenco incompleto spacciato per completo.
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const
const TIPO_RIFIUTO = 'anno-iscrizioni-rifiutate' as const
const FINALITA = 'Elenco di chi non ha firmato in app (segreteria)'

const getQuerySchema = z.object({
  modulo_id: zUuid,
  pagina: z.coerce.number().int().min(1).max(10_000).default(1),
  limite: zLimite({ predefinito: 50, max: 50 }),
})

export const GET = withRoute('admin/anni/[annoSedeId]/senza-firma-app:GET', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/senza-firma-app:GET'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data
  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  const { modulo_id: moduloId, pagina, limite } = q.data

  const supabase = await createAdminClient()
  const letta: { scuolaId?: string } = {}
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione, letta)
  if (fuoriSede) return fuoriSede
  const ctx = { operazione, annoSedeId, utente: auth.user.id, tipoRifiuto: TIPO_RIFIUTO, lettura: true } as const

  // Il modulo dev'essere di QUESTO anno e del registro: altrimenti non c'è una firma in app da cercare.
  const m = await supabase
    .from('moduli_richiesti')
    .select('id, codice, lista')
    .eq('id', moduloId)
    .eq('anno_sede_id', annoSedeId)
    .maybeSingle()
  if (m.error) return rispostaErroreImpostazioni(m.error, ctx)
  const modulo = m.data as ModuloDelRegistro | null
  if (!modulo || !haUnaFirmaInApp(modulo.codice)) {
    return rispostaErroreImpostazioni({ message: 'MODULO_NON_RICHIESTO' }, ctx)
  }

  const calcolo = await senzaFirmaInApp(supabase, { annoSedeId, modulo })
  if (!calcolo.ok) return rispostaErroreImpostazioni(calcolo.error, ctx)

  const totale = calcolo.righe.length
  const dal = (pagina - 1) * limite
  const paginaRighe = calcolo.righe.slice(dal, dal + limite)

  // Nomi e classe: solo della pagina. Due colonne di `alunni`, il nome della sezione da `sections`.
  const nomi = new Map<string, { nome: string | null; cognome: string | null }>()
  const classi = new Map<string, string | null>()
  if (paginaRighe.length > 0) {
    let lettiAlunni = supabase.from('alunni').select('id, nome, cognome').in('id', paginaRighe.map((r) => r.alunno_id))
    if (letta.scuolaId) lettiAlunni = lettiAlunni.eq('scuola_id', letta.scuolaId)
    const r = await lettiAlunni
    if (r.error) return rispostaErroreImpostazioni(r.error, ctx)
    for (const a of (Array.isArray(r.data) ? r.data : []) as Array<{ id: string; nome: string | null; cognome: string | null }>) {
      nomi.set(a.id, { nome: a.nome ?? null, cognome: a.cognome ?? null })
    }
    const idSezioni = [...new Set(paginaRighe.map((x) => x.section_id).filter((s): s is string => !!s))]
    if (idSezioni.length > 0) {
      let lettiSezioni = supabase.from('sections').select('id, name').in('id', idSezioni)
      if (letta.scuolaId) lettiSezioni = lettiSezioni.eq('scuola_id', letta.scuolaId)
      const s = await lettiSezioni
      if (s.error) return rispostaErroreImpostazioni(s.error, ctx)
      for (const x of (Array.isArray(s.data) ? s.data : []) as Array<{ id: string; name: string | null }>) classi.set(x.id, x.name ?? null)
    }
  }

  // Regola 5 di `docs/prestampati/README.md`: ogni bambino mostrato passa dal registro degli accessi al fascicolo.
  await Promise.all(
    paginaRighe.map((r) =>
      logAccessoFascicolo(supabase, { alunnoId: r.alunno_id, utenteId: auth.user.id, azione: 'list', finalita: FINALITA, request }),
    ),
  )

  const righe = paginaRighe.map((r) => ({
    frequenza_id: r.frequenza_id,
    alunno_id: r.alunno_id,
    nome: nomi.get(r.alunno_id)?.nome ?? null,
    cognome: nomi.get(r.alunno_id)?.cognome ?? null,
    classe: r.section_id ? (classi.get(r.section_id) ?? null) : null,
  }))

  logEvento('anno-scolastico', 'info', {
    tipo: 'senza-firma-app-letto',
    operazione,
    entita_id: moduloId,
    anno_sede_id: annoSedeId,
    utente: auth.user.id,
    n: righe.length,
  })
  return NextResponse.json({ success: true, data: { totale, pagina, limite, righe } })
})
