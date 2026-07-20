import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive, resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid, zDataYMD } from '@/lib/validation/common'
import { notificaUscitaNonAdmin, verificaSogliaCassa } from '@/lib/cassa/notifiche'
import { CASSA_SCHEMA_ASSENTE, calcolaAggregatiMovimenti } from '@/lib/cassa/saldo'
import type { RigaMovimentoCassa } from '@/lib/cassa/tipi'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// MODULO CASSA · registro movimenti (contratto §3.5).
//
// GET (staff): elenco movimenti reali + entrate AUTO virtuali dagli incassi
//   contanti (origine:'incasso', non stornabili da qui). I `totali` compaiono
//   SOLO per il ruolo admin: per gli altri la chiave non esiste nel JSON
//   (segreteria operativa ma senza KPI — decisione #10, trappola #5).
// POST (staff): registra un'entrata manuale o un'uscita (prelievo/rettifica NO:
//   li genera solo la chiusura). Best-effort a valle: notifica gli admin se un
//   non-admin registra un'uscita, e verifica la soglia contante.
// =============================================================================

const getQuerySchema = z.object({
  scuola_id: zUuid,
  da: zDataYMD.optional(),
  a: zDataYMD.optional(),
  tipo: z.enum(['entrata', 'uscita', 'prelievo', 'rettifica']).optional(),
  categoria_id: zUuid.optional(),
})

const postBodySchema = z
  .object({
    scuola_id: zUuid,
    // Solo entrata/uscita via API: prelievo e rettifica li genera la chiusura.
    tipo: z.enum(['entrata', 'uscita']),
    importo: z.coerce.number().positive('L\'importo deve essere maggiore di zero'),
    metodo: z.enum(['contanti', 'bonifico', 'carta', 'altro']).default('contanti'),
    data: zDataYMD.optional(),
    categoria_id: zUuid.optional(),
    descrizione: z.string().max(500).optional(),
    note: z.string().max(1000).optional(),
    allegato_path: z.string().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.tipo === 'uscita' && !v.categoria_id) {
      ctx.addIssue({ code: 'custom', path: ['categoria_id'], message: 'La categoria è obbligatoria per un\'uscita' })
    }
  })

const round2 = (n: number) => Math.round(n * 100) / 100

interface MovimentoRow {
  id: string
  scuola_id: string
  tipo: RigaMovimentoCassa['tipo']
  importo: number | string
  metodo: RigaMovimentoCassa['metodo']
  data: string
  categoria_id: string | null
  descrizione: string | null
  note: string | null
  allegato_path: string | null
  incasso_id: string | null
  chiusura_id: string | null
  registrato_da: string | null
  creato_il: string
  storno_di: string | null
  stornato_il: string | null
  storno_motivo: string | null
  cassa_categorie?: { nome: string | null } | { nome: string | null }[] | null
}

interface IncassoVirtualeRow {
  id: string
  importo: number | string
  metodo: string
  data_incasso: string
  creato_il: string | null
}

function categoriaNome(r: MovimentoRow): string | null {
  const c = r.cassa_categorie
  const obj = Array.isArray(c) ? c[0] : c
  return obj?.nome ?? null
}

export const GET = withRoute('pagamenti/cassa/movimenti:GET', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { scuola_id, da, a, tipo, categoria_id } = q.data

    const supabase = await createAdminClient()
    const sedi = await resolveScuoleAttive(request as NextRequest, supabase, user)
    if (!sedi.includes(scuola_id)) {
      return NextResponse.json({ error: 'Sede non accessibile' }, { status: 403 })
    }

    const isAdmin = user.role === 'admin'

    // 1) Movimenti reali della sede (con nome categoria). Degrada sul DB CI non migrato.
    let movQuery = supabase
      .from('cassa_movimenti')
      .select('*, cassa_categorie(nome)')
      .eq('scuola_id', scuola_id)
    if (da) movQuery = movQuery.gte('data', da)
    if (a) movQuery = movQuery.lte('data', a)
    if (tipo) movQuery = movQuery.eq('tipo', tipo)
    if (categoria_id) movQuery = movQuery.eq('categoria_id', categoria_id)
    const { data: movRaw, error: eMov } = await movQuery.order('data', { ascending: false })
    if (eMov) {
      const code = (eMov as { code?: string }).code ?? ''
      if (CASSA_SCHEMA_ASSENTE.has(code)) {
        logEvento('cassa', 'info', { operazione: 'pagamenti/cassa/movimenti:GET', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false, movimenti: [] })
      }
      logErrore({ operazione: 'pagamenti/cassa/movimenti:GET', stato: 500, evento: 'db' }, eMov)
      return NextResponse.json({ error: 'Errore nel recupero dei movimenti' }, { status: 500 })
    }
    const movimentiReali = (movRaw ?? []) as MovimentoRow[]

    // 2) Entrate AUTO virtuali: incassi contanti della sede, non stornati.
    //    (Filtro entrate: la lista virtuale mostra solo i movimenti-cassa quando
    //    l'utente ha filtrato per un tipo ≠ entrata.)
    const incassiVirtuali: IncassoVirtualeRow[] = []
    if (!tipo || tipo === 'entrata') {
      let incQuery = supabase
        .from('incassi')
        .select('id, importo, metodo, data_incasso, creato_il, pagamenti!inner(scuola_id)')
        .eq('metodo', 'contanti')
        .eq('pagamenti.scuola_id', scuola_id)
        .is('stornato_il', null)
      if (da) incQuery = incQuery.gte('data_incasso', da)
      if (a) incQuery = incQuery.lte('data_incasso', a)
      const { data: incRaw, error: eInc } = await incQuery
      if (eInc) {
        // Le entrate auto sono un arricchimento: se la lettura fallisce, la lista
        // dei movimenti reali resta valida. Loggato, non fatale.
        logEvento('cassa', 'warn', { operazione: 'pagamenti/cassa/movimenti:GET', esito: 'incassi-auto-non-letti' }, eInc)
      } else {
        for (const r of (incRaw ?? []) as Record<string, unknown>[]) {
          incassiVirtuali.push({
            id: String(r.id),
            importo: r.importo as number | string,
            metodo: String(r.metodo),
            data_incasso: String(r.data_incasso),
            creato_il: (r.creato_il as string | null) ?? null,
          })
        }
      }
    }

    // 3) Componi la lista.
    const righe: RigaMovimentoCassa[] = []
    for (const m of movimentiReali) {
      righe.push({
        id: m.id,
        origine: 'cassa',
        scuola_id: m.scuola_id,
        tipo: m.tipo,
        importo: round2(Number(m.importo)),
        metodo: m.metodo,
        data: m.data,
        categoria_id: m.categoria_id,
        categoria_nome: categoriaNome(m),
        descrizione: m.descrizione,
        note: m.note,
        allegato_path: m.allegato_path,
        incasso_id: m.incasso_id,
        chiusura_id: m.chiusura_id,
        registrato_da: m.registrato_da,
        creato_il: m.creato_il,
        storno_di: m.storno_di,
        stornato_il: m.stornato_il,
        storno_motivo: m.storno_motivo,
      })
    }
    for (const inc of incassiVirtuali) {
      righe.push({
        id: `incasso:${inc.id}`,
        origine: 'incasso',
        scuola_id: scuola_id,
        tipo: 'entrata',
        importo: round2(Number(inc.importo)),
        metodo: 'contanti',
        data: inc.data_incasso,
        categoria_id: null,
        categoria_nome: 'Incasso',
        descrizione: null,
        note: null,
        allegato_path: null,
        incasso_id: inc.id,
        chiusura_id: null,
        registrato_da: null,
        creato_il: inc.creato_il ?? inc.data_incasso,
        storno_di: null,
        stornato_il: null,
        storno_motivo: null,
      })
    }
    righe.sort((x, y) => (x.data < y.data ? 1 : x.data > y.data ? -1 : x.creato_il < y.creato_il ? 1 : -1))

    if (!isAdmin) {
      // Segreteria: SOLO l'elenco, nessun KPI. La chiave `totali` NON esiste.
      return NextResponse.json({ disponibile: true, movimenti: righe })
    }

    // Admin: totali sul set filtrato (le entrate auto già escludono gli storni).
    const aggr = calcolaAggregatiMovimenti(
      movimentiReali.map((m) => ({ tipo: m.tipo, importo: Number(m.importo), metodo: m.metodo })),
    )
    const entrateAuto = incassiVirtuali.reduce((s, i) => s + Number(i.importo), 0)
    const usciteAltre = movimentiReali
      .filter((m) => m.tipo === 'uscita' && m.metodo !== 'contanti')
      .reduce((s, m) => s + Number(m.importo), 0)
    const totali = {
      entrate: round2(entrateAuto + aggr.entrateManualiContanti),
      uscite_contanti: aggr.usciteContanti,
      uscite_altre: round2(usciteAltre),
      prelievi: aggr.prelievi,
      rettifiche: aggr.rettifiche,
    }
    return NextResponse.json({ disponibile: true, movimenti: righe, totali })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/cassa/movimenti:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

export const POST = withRoute('pagamenti/cassa/movimenti:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()
    const sede = await resolveScuolaScrittura(request as NextRequest, supabase, user, body.scuola_id)
    if (sede.response) return sede.response
    const scuolaId = sede.scuolaId as string

    const ins = await supabase
      .from('cassa_movimenti')
      .insert({
        scuola_id: scuolaId,
        tipo: body.tipo,
        importo: round2(body.importo),
        metodo: body.metodo,
        data: body.data ?? undefined,
        categoria_id: body.categoria_id ?? null,
        descrizione: body.descrizione ?? null,
        note: body.note ?? null,
        allegato_path: body.allegato_path ?? null,
        registrato_da: user.id,
      })
      .select('*')
      .single()
    if (ins.error) {
      const code = (ins.error as { code?: string }).code ?? ''
      if (CASSA_SCHEMA_ASSENTE.has(code)) {
        logEvento('cassa', 'info', { operazione: 'pagamenti/cassa/movimenti:POST', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false }, { status: 503 })
      }
      logErrore({ operazione: 'pagamenti/cassa/movimenti:POST', stato: 500, evento: 'db' }, ins.error)
      return NextResponse.json({ error: 'Errore nella registrazione del movimento' }, { status: 500 })
    }
    const movimento = ins.data as { id: string }

    // Audit (best-effort). Il testo libero resta in registro_modifiche, mai nei log.
    await supabase
      .from('registro_modifiche')
      .insert({
        azione: 'cassa_movimento',
        tabella_interessata: 'cassa_movimenti',
        record_id: movimento.id,
        nuovo_valore: ins.data,
        utente_id: user.id,
      })
      .then(
        () => {},
        () => {},
      )

    // Notifica gli admin se un NON-admin registra un'uscita (best-effort).
    if (body.tipo === 'uscita' && user.role !== 'admin') {
      await notificaUscitaNonAdmin(supabase, {
        scuolaId,
        movimentoId: movimento.id,
        importo: round2(body.importo),
        metodo: body.metodo,
      })
    }
    // Verifica soglia contante a valle (best-effort, non lancia).
    await verificaSogliaCassa(supabase, scuolaId)

    // Evento critico: logga il SUCCESSO (id/importo/tipo/metodo/scuola_id — MAI
    // descrizione/motivo/note).
    logEvento('cassa', 'info', {
      operazione: 'pagamenti/cassa/movimenti:POST',
      esito: 'registrato',
      movimento_id: movimento.id,
      tipo: body.tipo,
      metodo: body.metodo,
      importo: round2(body.importo),
      scuola_id: scuolaId,
    })

    return NextResponse.json({ movimento: ins.data }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/cassa/movimenti:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
