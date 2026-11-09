import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { erroreAnno, rispostaFrequenzaNonTrovata } from '@/lib/anno/errori'
import { assertAnnoSedeInScope, rispostaErroreImpostazioni } from '@/lib/anno/impostazioni'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { fascicoloVivo } from '@/lib/primaria/cestino-fascicolo'
import { firmatoInAppIl, haUnaFirmaInApp, type FirmaDelFascicolo } from '@/lib/prestampati/firma-per-anno'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData, parseQuery } from '@/lib/validation/http'

type Contesto = { params: Promise<{ frequenzaId: string }> }

/**
 * LA SPUNTA DEI MODULI DI UNA FREQUENZA (PR 4.5, compito 4.5.10). `frequenzaId` = `frequenze.id` della frequenza dell'anno NUOVO
 * (la conferma di chi continua, o la nuova iscrizione di chi arriva): i moduli sono quelli della lista del suo `tipo`.
 *
 *  · GET — i moduli richiesti, quali sono spuntati e quando. `firmato_in_app_il` è INFORMATIVO: se il `codice` coincide con un modulo
 *    del registro dei prestampati e la famiglia l'ha firmato in modo che valga per l'anno della frequenza, il giorno della firma.
 *    Non spunta niente: la spunta è della segreteria (§4.18.7). Il fascicolo del bambino si apre solo se serve, e ogni lettura passa
 *    dal registro degli accessi.
 *  · PUT — `{ modulo_id, spuntato }`: inserisce o toglie la riga di `frequenze_moduli`. I flag (`moduli_completi`, `quota_saldata`) e lo
 *    stato li ricalcola il TRIGGER del database: l'app non li scrive mai, li rilegge e li riporta. `MODULO_NON_RICHIESTO` e
 *    `ANNO_NON_COERENTE` del trigger diventano 422 (`erroreAnno`).
 *
 * Gate e perimetro: staff, e l'anno della frequenza dev'essere di una sede dell'utente (`assertAnnoSedeInScope`).
 * Nei log: uuid, codici, booleani. Mai un nome, mai che cosa dice un documento.
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const
const TIPO_RIFIUTO = 'anno-iscrizioni-rifiutate' as const

type Frequenza = {
  id: string
  alunno_id: string
  anno_sede_id: string
  tipo: string | null
  stato: string
  moduli_completi: boolean
  quota_saldata: boolean
}
type AnnoDellaSede = { id: string; scuola_id: string; inizio: string; fine: string; stato: string }

/** Nessun parametro in query: `userId` è consumato dal gate identità. */
const getQuerySchema = z.object({})

const putSchema = z.object({ modulo_id: zUuid, spuntato: z.boolean() }).strict()

type Letta = { frequenza: Frequenza; anno: AnnoDellaSede }

/** La frequenza nominata dall'URL e il suo anno, già dentro il perimetro dell'utente; altrimenti la risposta da restituire. */
async function leggiFrequenza(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: Parameters<typeof assertAnnoSedeInScope>[1],
  frequenzaId: string,
  operazione: string,
): Promise<{ risposta: NextResponse } | Letta> {
  const ctxLettura = { operazione, annoSedeId: '', utente: user.id, tipoRifiuto: TIPO_RIFIUTO, lettura: true } as const
  const f = await supabase
    .from('frequenze')
    .select('id, alunno_id, anno_sede_id, tipo, stato, moduli_completi, quota_saldata')
    .eq('id', frequenzaId)
    .maybeSingle()
  if (f.error) return { risposta: rispostaErroreImpostazioni(f.error, ctxLettura) }
  const frequenza = f.data as Frequenza | null
  if (!frequenza) return { risposta: rispostaFrequenzaNonTrovata() }

  const fuoriSede = await assertAnnoSedeInScope(supabase, user, frequenza.anno_sede_id, operazione)
  if (fuoriSede) return { risposta: fuoriSede }

  const a = await supabase
    .from('anni_sede')
    .select('id, scuola_id, inizio, fine, stato')
    .eq('id', frequenza.anno_sede_id)
    .maybeSingle()
  if (a.error) return { risposta: rispostaErroreImpostazioni(a.error, { ...ctxLettura, annoSedeId: frequenza.anno_sede_id }) }
  const anno = a.data as AnnoDellaSede | null
  if (!anno) return { risposta: rispostaFrequenzaNonTrovata() }
  return { frequenza, anno }
}

export const GET = withRoute('admin/frequenze/[frequenzaId]/moduli:GET', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/frequenze/[frequenzaId]/moduli:GET'
  const { frequenzaId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const letta = await leggiFrequenza(supabase, auth.user, id.data, operazione)
  if ('risposta' in letta) return letta.risposta
  const { frequenza, anno } = letta
  const ctx = { operazione, annoSedeId: frequenza.anno_sede_id, utente: auth.user.id, tipoRifiuto: TIPO_RIFIUTO, lettura: true } as const

  // Un `tipo` NULL (il recupero) non ha una lista di moduli.
  let moduli: Array<{ id: string; codice: string; titolo: string; ordine: number }> = []
  if (frequenza.tipo) {
    const r = await supabase
      .from('moduli_richiesti')
      .select('id, codice, titolo, ordine')
      .eq('anno_sede_id', frequenza.anno_sede_id)
      .eq('lista', frequenza.tipo)
      .order('ordine', { ascending: true })
      .order('codice', { ascending: true })
    if (r.error) return rispostaErroreImpostazioni(r.error, ctx)
    moduli = (Array.isArray(r.data) ? r.data : []) as typeof moduli
  }

  const s = await supabase.from('frequenze_moduli').select('modulo_id, spuntato_il').eq('frequenza_id', frequenza.id)
  if (s.error) return rispostaErroreImpostazioni(s.error, ctx)
  const spunte = new Map(((Array.isArray(s.data) ? s.data : []) as Array<{ modulo_id: string; spuntato_il: string | null }>).map((x) => [x.modulo_id, x.spuntato_il]))

  // La firma in app: solo se almeno un modulo è del registro. Il fascicolo di un minore non si apre «per vedere».
  let firme: FirmaDelFascicolo[] = []
  let ultimoGiornoAnnoPrima: string | null = null
  if (moduli.some((m) => haUnaFirmaInApp(m.codice))) {
    const prima = await supabase
      .from('anni_sede')
      .select('ultimo_giorno_aperto')
      .eq('scuola_id', anno.scuola_id)
      .lt('fine', anno.inizio)
      .order('fine', { ascending: false })
      .limit(1)
    if (prima.error) return rispostaErroreImpostazioni(prima.error, ctx)
    const righePrima = (Array.isArray(prima.data) ? prima.data : []) as Array<{ ultimo_giorno_aperto: string | null }>
    ultimoGiornoAnnoPrima = righePrima[0]?.ultimo_giorno_aperto ?? null

    // Niente `document_type` dentro la query: sul DB della CI uno slug fuori dall'enumerazione risponde `22P02`. Il filtro sta in `firmatoInAppIl`.
    const d = await fascicoloVivo(supabase.from('student_documents').select('document_type, created_at').eq('student_id', frequenza.alunno_id))
    if (d.error) return rispostaErroreImpostazioni(d.error, ctx)
    firme = (Array.isArray(d.data) ? d.data : []) as FirmaDelFascicolo[]
    // Regola 5 di `docs/prestampati/README.md`: ogni lettura del fascicolo passa dal registro degli accessi.
    await logAccessoFascicolo(supabase, {
      alunnoId: frequenza.alunno_id,
      utenteId: auth.user.id,
      azione: 'list',
      finalita: 'Spunta dei moduli (segreteria)',
      request,
    })
  }

  const risposta = moduli.map((m) => ({
    modulo_id: m.id,
    codice: m.codice,
    titolo: m.titolo,
    ordine: m.ordine,
    spuntato: spunte.has(m.id),
    spuntato_il: spunte.get(m.id) ?? null,
    firmato_in_app_il: firmatoInAppIl(m.codice, firme, { inizio: anno.inizio, fine: anno.fine, ultimoGiornoAnnoPrima }),
  }))

  logEvento('anno-scolastico', 'info', {
    tipo: 'moduli-frequenza-letti',
    operazione,
    anno_sede_id: frequenza.anno_sede_id,
    utente: auth.user.id,
    n: risposta.length,
  })
  return NextResponse.json({ success: true, data: { moduli: risposta } })
})

export const PUT = withRoute('admin/frequenze/[frequenzaId]/moduli:PUT', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/frequenze/[frequenzaId]/moduli:PUT'
  const { frequenzaId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const b = await parseBody(request, putSchema)
  if ('response' in b) return b.response
  const { modulo_id: moduloId, spuntato } = b.data

  const supabase = await createAdminClient()
  const letta = await leggiFrequenza(supabase, auth.user, id.data, operazione)
  if ('risposta' in letta) return letta.risposta
  const { frequenza, anno } = letta
  const ctx = { operazione, annoSedeId: frequenza.anno_sede_id, utente: auth.user.id, tipoRifiuto: TIPO_RIFIUTO } as const

  // Un anno chiuso non si tocca: la guardia del database è ancora spenta (PR 3-B), quindi lo dice la route.
  if (anno.stato === 'chiuso') {
    return erroreAnno({ message: 'ANNO_CHIUSO' }, operazione) ?? rispostaFrequenzaNonTrovata()
  }

  if (spuntato) {
    // Spuntare due volte è come spuntare una: la coppia è unica, il secondo inserimento non fa niente e non cambia la data.
    const w = await supabase
      .from('frequenze_moduli')
      .upsert(
        { frequenza_id: frequenza.id, modulo_id: moduloId, spuntato_da: auth.user.id },
        { onConflict: 'frequenza_id,modulo_id', ignoreDuplicates: true },
      )
    if (w.error) return rispostaErroreImpostazioni(w.error, ctx)
  } else {
    const w = await supabase.from('frequenze_moduli').delete().eq('frequenza_id', frequenza.id).eq('modulo_id', moduloId)
    if (w.error) return rispostaErroreImpostazioni(w.error, ctx)
  }

  // I flag e lo stato li ha ricalcolati il trigger: qui si rileggono, non si scrivono.
  const r = await supabase.from('frequenze').select('stato, moduli_completi, quota_saldata').eq('id', frequenza.id).maybeSingle()
  if (r.error) return rispostaErroreImpostazioni(r.error, { ...ctx, lettura: true })
  const dopo = r.data as { stato: string; moduli_completi: boolean; quota_saldata: boolean } | null
  if (!dopo) return rispostaFrequenzaNonTrovata()

  logEvento('anno-scolastico', 'info', {
    tipo: 'modulo-spuntato',
    operazione,
    anno_sede_id: frequenza.anno_sede_id,
    frequenza_id: frequenza.id,
    modulo_id: moduloId,
    utente: auth.user.id,
    spuntato,
    moduli_completi: dopo.moduli_completi,
    quota_saldata: dopo.quota_saldata,
    stato: dopo.stato,
  })
  return NextResponse.json({
    success: true,
    data: {
      frequenza_id: frequenza.id,
      modulo_id: moduloId,
      spuntato,
      moduli_completi: dopo.moduli_completi,
      quota_saldata: dopo.quota_saldata,
      stato: dopo.stato,
    },
  })
})
