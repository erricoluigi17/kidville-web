import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import {
  assertAnnoSedeInScope,
  impostazioniNonDisponibili,
  rispostaErroreImpostazioni,
} from '@/lib/anno/impostazioni'
import { confermaIscrizione } from '@/lib/anno/iscrizione-anno'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zLimite, zUuid } from '@/lib/validation/common'
import { parseBody, parseData, parseQuery } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * LE CONFERME PER L'ANNO PROSSIMO (PR 4.5, compito 4.5.6). `annoSedeId` = `anni_sede.id` dell'anno NUOVO, quello con le iscrizioni
 * aperte; l'anno di partenza è l'anno attivo della sede.
 *
 *  · GET  — per ogni frequenza viva dell'anno attivo: se la famiglia ha confermato, ha detto «no» o non ha risposto, a che punto
 *    sono moduli e quota, se cambia grado. SOLO uuid, stati e numeri: i nomi li compone la pagina dai dati che ha già.
 *  · POST — conferma una frequenza (`anno_conferma`): nasce la frequenza dell'anno prossimo e la voce della quota, senza toccare
 *    un dato dell'anno in corso.
 *
 * Gate e perimetro: staff, e sia l'anno nuovo sia quello di partenza dev'essere di una sede dell'utente (`assertAnnoSedeInScope`).
 * Le regole stanno nel database; qui si giudicano chi chiede e per quale sede, si valida il corpo e si traduce il rifiuto.
 * Nei log: uuid, codici, numeri, booleani. Mai un nome.
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const
const TIPO_RIFIUTO = 'anno-iscrizioni-rifiutate' as const

type Stato = 'confermato' | 'no' | 'non_risposto'
type StatoQuota = 'saldata' | 'da_pagare' | 'assente'

type Partenza = {
  id: string
  alunno_id: string
  section_id: string | null
  non_rinnova_il: string | null
  non_rinnova_motivo: string | null
}
type Nuova = {
  id: string
  alunno_id: string
  section_id: string | null
  stato: string
  quota_saldata: boolean
  quota_pagamento_id: string | null
}
type Sezione = { id: string; school_type: string | null; fascia: string | null }

const VIVE = ['in_attesa', 'iscritto']

const getQuerySchema = z.object({
  pagina: z.coerce.number().int().min(1).max(10_000).default(1),
  limite: zLimite({ predefinito: 100, max: 200 }),
  /** Elenco chiuso: il filtro lo applica la route, sul totale. */
  conferma: z.enum(['tutti', 'confermato', 'no', 'non_risposto']).default('tutti'),
})

/** Quante righe leggere per volta quando si classifica tutto l'anno (sotto il tetto delle righe per richiesta di PostgREST). */
const BLOCCO = 500

/** Una lettura che è andata male: lo schema dell'anno non c'è ancora (503), oppure un guasto vero (500, loggato). */
function lettura(error: { code?: string; message?: string }, ctx: { operazione: string; annoSedeId: string; utente: string }) {
  return rispostaErroreImpostazioni(error, { ...ctx, tipoRifiuto: TIPO_RIFIUTO, lettura: true })
}

export const GET = withRoute('admin/anni/[annoSedeId]/conferme:GET', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/conferme:GET'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  const { pagina, limite, conferma } = q.data

  const supabase = await createAdminClient()
  const letta: { scuolaId?: string } = {}
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione, letta)
  if (fuoriSede) return fuoriSede
  const ctx = { operazione, annoSedeId, utente: auth.user.id }

  // L'anno nuovo dev'essere quello con le iscrizioni aperte.
  const nuovo = await supabase.from('anni_sede').select('id, stato').eq('id', annoSedeId).maybeSingle()
  if (nuovo.error) return lettura(nuovo.error, ctx)
  const statoNuovo = (nuovo.data as { stato?: string } | null)?.stato
  if (statoNuovo !== 'iscrizioni_aperte') {
    return rispostaErroreImpostazioni({ message: 'ANNO_NON_APERTO' }, { ...ctx, tipoRifiuto: TIPO_RIFIUTO, lettura: true })
  }

  // L'anno di partenza: l'attivo della sede, anch'esso dentro il perimetro.
  const attivo = await supabase.rpc('anno_attivo', { p_scuola: letta.scuolaId })
  if (attivo.error) return lettura(attivo.error, ctx)
  const partenzaId = typeof attivo.data === 'string' ? attivo.data : null
  if (!partenzaId || partenzaId === annoSedeId) {
    return NextResponse.json({ success: true, data: { righe: [], pagina, limite, totale: 0, posti: [] } })
  }
  const fuoriSedePartenza = await assertAnnoSedeInScope(supabase, auth.user, partenzaId, operazione)
  if (fuoriSedePartenza) return fuoriSedePartenza

  // Le frequenze vive dell'anno attivo, una pagina per volta.
  const dal = (pagina - 1) * limite
  const colonne = 'id, alunno_id, section_id, non_rinnova_il, non_rinnova_motivo'
  let partenze: Partenza[]
  let totale: number
  if (conferma === 'tutti') {
    const elenco = await supabase
      .from('frequenze')
      .select(colonne, { count: 'exact' })
      .eq('anno_sede_id', partenzaId)
      .in('stato', VIVE)
      .order('id', { ascending: true })
      .range(dal, dal + limite - 1)
    if (elenco.error) return lettura(elenco.error, ctx)
    partenze = (Array.isArray(elenco.data) ? elenco.data : []) as Partenza[]
    totale = typeof elenco.count === 'number' ? elenco.count : partenze.length
  } else {
    // Il filtro vale sul TOTALE, non sulla pagina: chi ha risposto lo dice l'anno nuovo, quindi si leggono (poche colonne, a blocchi)
    // tutte le frequenze vive di partenza e tutti i bambini già confermati, si classifica, e solo la pagina chiesta porta il resto.
    const leggi = async <T,>(
      pezzo: (da: number, a: number) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>,
    ): Promise<{ righe: T[] } | { error: { code?: string; message?: string } }> => {
      const righe: T[] = []
      for (let da = 0; ; da += BLOCCO) {
        const r = await pezzo(da, da + BLOCCO - 1)
        if (r.error) return { error: r.error }
        const blocco = (Array.isArray(r.data) ? r.data : []) as T[]
        righe.push(...blocco)
        if (blocco.length < BLOCCO) return { righe }
      }
    }
    const tutteLePartenze = await leggi<Pick<Partenza, 'id' | 'alunno_id' | 'non_rinnova_il'>>((da, a) =>
      supabase.from('frequenze').select('id, alunno_id, non_rinnova_il').eq('anno_sede_id', partenzaId).in('stato', VIVE).order('id', { ascending: true }).range(da, a),
    )
    if ('error' in tutteLePartenze) return lettura(tutteLePartenze.error, ctx)
    const tutteLeNuove = await leggi<{ alunno_id: string }>((da, a) =>
      supabase.from('frequenze').select('alunno_id').eq('anno_sede_id', annoSedeId).in('stato', VIVE).order('id', { ascending: true }).range(da, a),
    )
    if ('error' in tutteLeNuove) return lettura(tutteLeNuove.error, ctx)
    const confermati = new Set(tutteLeNuove.righe.map((n) => n.alunno_id))
    const statoDi = (p: { alunno_id: string; non_rinnova_il: string | null }): Stato =>
      confermati.has(p.alunno_id) ? 'confermato' : p.non_rinnova_il ? 'no' : 'non_risposto'
    const giuste = tutteLePartenze.righe.filter((p) => statoDi(p) === conferma)
    totale = giuste.length
    const idPagina = giuste.slice(dal, dal + limite).map((p) => p.id)
    partenze = []
    if (idPagina.length > 0) {
      const r = await supabase.from('frequenze').select(colonne).eq('anno_sede_id', partenzaId).in('id', idPagina)
      if (r.error) return lettura(r.error, ctx)
      const perId = new Map(((Array.isArray(r.data) ? r.data : []) as Partenza[]).map((p) => [p.id, p]))
      partenze = idPagina.map((i) => perId.get(i)).filter((p): p is Partenza => !!p)
    }
  }

  // Cosa c'è già nell'anno nuovo per quei bambini.
  const alunni = partenze.map((p) => p.alunno_id)
  let nuove: Nuova[] = []
  if (alunni.length > 0) {
    const r = await supabase
      .from('frequenze')
      .select('id, alunno_id, section_id, stato, quota_saldata, quota_pagamento_id')
      .eq('anno_sede_id', annoSedeId)
      .in('alunno_id', alunni)
    if (r.error) return lettura(r.error, ctx)
    nuove = (Array.isArray(r.data) ? r.data : []) as Nuova[]
  }
  const nuovaDi = new Map(nuove.map((n) => [n.alunno_id, n]))

  // I moduli della lista «conferma» e quanti ne ha spuntati ciascuna frequenza nuova.
  const richiesti = await supabase.from('moduli_richiesti').select('id').eq('anno_sede_id', annoSedeId).eq('lista', 'conferma')
  if (richiesti.error) return lettura(richiesti.error, ctx)
  const idRichiesti = new Set(((Array.isArray(richiesti.data) ? richiesti.data : []) as Array<{ id: string }>).map((m) => m.id))
  const fatti = new Map<string, number>()
  if (nuove.length > 0 && idRichiesti.size > 0) {
    const r = await supabase.from('frequenze_moduli').select('frequenza_id, modulo_id').in('frequenza_id', nuove.map((n) => n.id))
    if (r.error) return lettura(r.error, ctx)
    for (const x of (Array.isArray(r.data) ? r.data : []) as Array<{ frequenza_id: string; modulo_id: string }>) {
      if (idRichiesti.has(x.modulo_id)) fatti.set(x.frequenza_id, (fatti.get(x.frequenza_id) ?? 0) + 1)
    }
  }

  // Le sezioni, per sapere se chi ha confermato cambia grado.
  const idSezioni = [...new Set([...partenze.map((p) => p.section_id), ...nuove.map((n) => n.section_id)].filter((s): s is string => !!s))]
  const sezioni = new Map<string, Sezione>()
  if (idSezioni.length > 0) {
    const r = await supabase.from('sections').select('id, school_type, fascia').in('id', idSezioni)
    if (r.error) return lettura(r.error, ctx)
    for (const s of (Array.isArray(r.data) ? r.data : []) as Sezione[]) sezioni.set(s.id, s)
  }
  const cambiaGrado = (da: string | null, a: string | null): boolean => {
    const x = da ? sezioni.get(da) : undefined
    const y = a ? sezioni.get(a) : undefined
    if (!x || !y) return false
    return x.school_type !== y.school_type || (!!x.fascia && !!y.fascia && x.fascia !== y.fascia)
  }

  const righe = partenze.map((p) => {
    const n = nuovaDi.get(p.alunno_id)
    const confermata = !!n && VIVE.includes(n.stato)
    const conferma: Stato = confermata ? 'confermato' : p.non_rinnova_il ? 'no' : 'non_risposto'
    const quota: StatoQuota = confermata ? (n.quota_saldata ? 'saldata' : n.quota_pagamento_id ? 'da_pagare' : 'assente') : 'assente'
    return {
      frequenza_id: p.id,
      // il bambino e le due sezioni: servono alla pagina per comporre i nomi dai dati che ha già
      alunno_id: p.alunno_id,
      section_id: p.section_id,
      nuova_frequenza_id: confermata ? n.id : null,
      nuova_section_id: confermata ? n.section_id : null,
      conferma,
      non_rinnova_motivo: conferma === 'no' ? p.non_rinnova_motivo : null,
      moduli: { fatti: confermata ? (fatti.get(n.id) ?? 0) : 0, richiesti: idRichiesti.size },
      quota,
      cambia_grado: confermata ? cambiaGrado(p.section_id, n.section_id) : false,
    }
  })

  // I posti: un avviso accanto all'elenco, mai un blocco. Se non si leggono la pagina funziona lo stesso.
  let posti: Array<{ fascia: string; iscritti: number; posti: number | null; oltre: boolean }> = []
  const conteggio = await supabase.rpc('anno_conta_posti', { p_anno_sede: annoSedeId })
  if (conteggio.error) {
    if (schemaAnnoIndietro(conteggio.error)) {
      logEvento('anno-scolastico', 'info', { tipo: 'conferme-posti-schema-indietro', operazione, error_code: conteggio.error.code ?? undefined })
    } else {
      logErrore({ operazione: `${operazione}:posti` }, new Error(`conferme:${conteggio.error.code ?? 'senza-codice'}`))
    }
  } else {
    posti = ((Array.isArray(conteggio.data) ? conteggio.data : []) as Array<{ fascia: string; iscritti: number | string; posti: number | null; oltre: boolean }>)
      .map((c) => ({ fascia: c.fascia, iscritti: Number(c.iscritti), posti: c.posti, oltre: c.oltre === true }))
  }

  logEvento('anno-scolastico', 'info', { tipo: 'conferme-lette', operazione, anno_sede_id: annoSedeId, utente: auth.user.id, n: righe.length })
  return NextResponse.json({ success: true, data: { righe, pagina, limite, totale, posti } })
})

/** Il corpo: una conferma per volta, `strict`. `section_id` assente = la continuazione della sezione di partenza. */
const postSchema = z
  .object({
    frequenza_id: zUuid,
    section_id: zUuid.nullable().optional(),
    cambia_grado: z.boolean().optional(),
  })
  .strict()

/** POST — conferma la frequenza nominata per l'anno nuovo. */
export const POST = withRoute('admin/anni/[annoSedeId]/conferme:POST', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/conferme:POST'
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
  const ctx = { operazione, annoSedeId, utente: auth.user.id, tipoRifiuto: TIPO_RIFIUTO }

  // La frequenza di partenza: la sua sede dev'essere dell'utente quanto quella dell'anno nuovo.
  const partenza = await supabase.from('frequenze').select('id, anno_sede_id').eq('id', corpo.frequenza_id).maybeSingle()
  if (partenza.error) return rispostaErroreImpostazioni(partenza.error, { ...ctx, lettura: true })
  const annoPartenza = (partenza.data as { anno_sede_id?: string } | null)?.anno_sede_id
  if (!annoPartenza) return rispostaErroreImpostazioni({ message: 'PARAMETRO_MANCANTE' }, ctx)
  const fuoriSedePartenza = await assertAnnoSedeInScope(supabase, auth.user, annoPartenza, operazione)
  if (fuoriSedePartenza) return fuoriSedePartenza

  const esito = await confermaIscrizione(supabase, {
    frequenzaId: corpo.frequenza_id,
    annoSedeNuovoId: annoSedeId,
    sectionId: corpo.section_id ?? null,
    cambiaGrado: corpo.cambia_grado === true,
    da: auth.user.id,
  })
  if (!esito.ok) return rispostaErroreImpostazioni({ message: esito.codice }, ctx)
  if ('saltata' in esito) return impostazioniNonDisponibili({ code: 'PGRST202' }, operazione)

  // Il successo l'ha già scritto la porta (`conferma-anno-registrata`): uuid, esito e booleani.
  return NextResponse.json({
    success: true,
    data: {
      frequenza_id: esito.frequenza_id,
      creata: esito.creata,
      cambia_grado: esito.cambia_grado,
      retta_personalizzata_precedente: esito.retta_personalizzata_precedente,
      quota: esito.quota,
      pagamento_id: esito.pagamento_id,
      posti_oltre: esito.posti_oltre,
    },
  })
})
