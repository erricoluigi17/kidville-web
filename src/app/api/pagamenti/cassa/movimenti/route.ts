import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { eDirezione } from '@/lib/auth/predicati-ruolo'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { sediLetturaCassa, nomiSediCassa, meseCorrenteRoma } from '@/lib/cassa/lettura-multisede'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid, zDataYMD } from '@/lib/validation/common'
import { notificaUscitaNonAdmin, verificaSogliaCassa } from '@/lib/cassa/notifiche'
import { CASSA_SCHEMA_ASSENTE, calcolaAggregatiMovimenti } from '@/lib/cassa/saldo'
import type { RigaMovimentoCassa } from '@/lib/cassa/tipi'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { descriviTetto, leggiABlocchi, type EsitoABlocchi } from '@/lib/pagamenti/leggi-a-blocchi'

// =============================================================================
// MODULO CASSA · registro movimenti (contratto §3.5).
//
// GET (staff): elenco movimenti reali + entrate AUTO virtuali dagli incassi
//   contanti (origine:'incasso', non stornabili da qui). Dal 2026-09-26 (K3)
//   `scuola_id` è facoltativo: senza, legge TUTTE le sedi attive e ogni riga
//   porta `scuola_id` + `scuola_nome`; la Direzione riceve anche `uscite_mese`
//   (mese corrente Europe/Rome, per sede e totale, indipendente dai filtri).
//   Contratto: docs/superpowers/specs/2026-09-26-orario-appello-contabilita-cf/contratti/K3.md.
//   I `totali` compaiono
//   SOLO per la DIREZIONE (admin + coordinator): per gli altri la chiave non
//   esiste nel JSON (segreteria operativa ma senza KPI — decisione #10,
//   trappola #5). Fino al 2026-09-02 erano riservati al solo `admin`, e l'unico
//   account «Direzione» non vedeva i totali della propria cassa.
// POST (staff): registra un'entrata manuale o un'uscita (prelievo/rettifica NO:
//   li genera solo la chiusura). Best-effort a valle: notifica gli admin se un
//   non-admin registra un'uscita, e verifica la soglia contante.
// =============================================================================

const getQuerySchema = z.object({
  // Facoltativa dal 2026-09-26 (K3): senza, si leggono TUTTE le sedi attive.
  scuola_id: z.preprocess((v) => v || undefined, zUuid.optional()),
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
    // Il client invia `valore || null` per i campi vuoti: lo schema deve tollerare
    // il `null`, non solo l'`undefined` (`.optional()` accetterebbe solo undefined).
    // L'INSERT sotto normalizza con `?? null` / `?? undefined` (RC1).
    data: zDataYMD.nullish(),
    categoria_id: zUuid.nullish(),
    // null = cassa generale; undefined = scelta non ancora fatta (vietata per uscite).
    cassa_categoria_id: zUuid.nullable().optional(),
    descrizione: z.string().max(500).nullish(),
    note: z.string().max(1000).nullish(),
    allegato_path: z.string().max(500).nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.tipo === 'uscita' && !v.categoria_id) {
      ctx.addIssue({ code: 'custom', path: ['categoria_id'], message: 'La categoria è obbligatoria per un\'uscita' })
    }
    if (v.tipo === 'uscita' && v.cassa_categoria_id === undefined) {
      ctx.addIssue({ code: 'custom', path: ['cassa_categoria_id'], message: 'Scegli da quale cassa prelevare il denaro' })
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
  cassa_categoria_id?: string | null
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
  scuola_id: string
  cassa_categoria_id: string | null
  importo: number | string
  metodo: string
  data_incasso: string
  creato_il: string | null
}

/** Riga della lista con il nome della sede (K3): la colonna «Sede» della tabella. */
type RigaMovimentoConSede = RigaMovimentoCassa & { scuola_nome: string | null }

function categoriaNome(r: MovimentoRow): string | null {
  const c = r.cassa_categorie
  const obj = Array.isArray(c) ? c[0] : c
  return obj?.nome ?? null
}

/** Sede e cassa dell'incasso dal suo pagamento (to-one; difensivo su array). */
function campoPagamentoIncasso(r: Record<string, unknown>, campo: 'scuola_id' | 'categoria_id'): string | null {
  const p = r.pagamenti
  const obj = Array.isArray(p) ? (p[0] as Record<string, unknown> | undefined) : (p as Record<string, unknown> | undefined)
  return typeof obj?.[campo] === 'string' ? obj[campo] : null
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
    // LETTURA UNITA (K3): senza scuola_id tutte le sedi attive; con scuola_id solo
    // quella, e 403 se non è fra le proprie. Le scritture (POST sotto) restano per sede.
    const scope = await sediLetturaCassa(request as NextRequest, supabase, user, scuola_id, 'pagamenti/cassa/movimenti:GET')
    if (scope.response) return scope.response
    const sedi = scope.sedi

    // I KPI di cassa sono della DIREZIONE, non del solo `admin`.
    //
    // Fino al 2026-09-02 questa riga diceva `user.role === 'admin'`, e sbagliava due
    // volte. La prima: escludeva `coordinator`, che nell'app si chiama letteralmente
    // «Direzione» — in archivio è UN account, e non vedeva i totali della propria
    // cassa. La seconda, più insidiosa: `user.role` è il ruolo ATTIVO, quello del
    // cookie della veste indossata adesso, e un'autorizzazione non si decide su un
    // cookie. `eDirezione` guarda i ruoli REALI.
    const isDirezione = eDirezione(user)

    // Nessun plesso: elenco vuoto (non un errore), e KPI a zero per la Direzione.
    if (sedi.length === 0) {
      if (!isDirezione) return NextResponse.json({ disponibile: true, movimenti: [] })
      const mese = meseCorrenteRoma()
      return NextResponse.json({
        disponibile: true,
        movimenti: [],
        totali: { entrate: 0, uscite_contanti: 0, uscite_altre: 0, prelievi: 0, rettifiche: 0 },
        uscite_mese: { da: mese.da, a: mese.a, totale: 0, per_sede: [] },
      })
    }

    // 1) Movimenti reali delle sedi (con nome categoria). Degrada sul DB CI non migrato.
    const movLetti = await leggiABlocchi<MovimentoRow>(() => {
      let query = supabase.from('cassa_movimenti').select('*, cassa_categorie(nome)').in('scuola_id', sedi)
      if (da) query = query.gte('data', da)
      if (a) query = query.lte('data', a)
      if (tipo) query = query.eq('tipo', tipo)
      if (categoria_id) query = query.eq('categoria_id', categoria_id)
      return query.order('data', { ascending: false })
    })
    if (!movLetti.ok) {
      const code = movLetti.motivo === 'errore' ? (movLetti.error as { code?: string })?.code ?? '' : ''
      if (CASSA_SCHEMA_ASSENTE.has(code)) {
        logEvento('cassa', 'info', { operazione: 'pagamenti/cassa/movimenti:GET', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false, movimenti: [] })
      }
      return letturaRegistroFallita('cassa-movimenti', movLetti)
    }
    const movimentiReali = movLetti.righe

    // 2) Entrate AUTO virtuali: incassi contanti delle sedi, non stornati. La sede
    //    di ogni riga è quella del SUO pagamento (embed), non il parametro: con
    //    più sedi il parametro non c'è.
    //    (Filtro entrate: la lista virtuale mostra solo i movimenti-cassa quando
    //    l'utente ha filtrato per un tipo ≠ entrata.)
    const incassiVirtuali: IncassoVirtualeRow[] = []
    let incassiSenzaSede = 0
    if (!tipo || tipo === 'entrata') {
      const incLetti = await leggiABlocchi<Record<string, unknown>>(() => {
        let query = supabase.from('incassi')
          .select('id, importo, metodo, data_incasso, creato_il, pagamenti!inner(scuola_id,categoria_id)')
          .eq('metodo', 'contanti').in('pagamenti.scuola_id', sedi).is('stornato_il', null)
        if (da) query = query.gte('data_incasso', da)
        if (a) query = query.lte('data_incasso', a)
        return query.order('data_incasso', { ascending: false })
      })
      // Un incasso perso rende incompleti lista e totali: il registro è tutto-o-niente.
      if (!incLetti.ok) return letturaRegistroFallita('cassa-incassi-auto', incLetti)

      for (const r of incLetti.righe) {
        // `pagamenti!inner` + `.in('pagamenti.scuola_id', sedi)`: la sede c'è sempre.
        // Un embed senza sede non si attribuisce a caso a un cassetto: si scarta QUI,
        // prima di tutto, e si conta. Scartarlo solo dalla lista (com'era nel primo
        // giro del K3) lo lasciava dentro `totali.entrate`: un importo che non
        // compariva in nessuna riga e in nessun cassetto.
        const sedeInc = campoPagamentoIncasso(r, 'scuola_id')
        if (!sedeInc) {
          incassiSenzaSede++
          continue
        }
        incassiVirtuali.push({
          id: String(r.id),
          scuola_id: sedeInc,
          cassa_categoria_id: campoPagamentoIncasso(r, 'categoria_id'),
          importo: r.importo as number | string,
          metodo: String(r.metodo),
          data_incasso: String(r.data_incasso),
          creato_il: (r.creato_il as string | null) ?? null,
        })
      }
    }

    const nomi = await nomiSediCassa(supabase, sedi, 'pagamenti/cassa/movimenti:GET')
    const nomeDi = (id: string | null) => (id ? nomi.get(id) ?? null : null)

    // I nomi delle casse sono distinti dalle categorie di spesa. Le entrate
    // virtuali ereditano la cassa del pagamento, come il conteggio per categoria.
    // Solo quando nessuna riga ha un'attribuzione si evita il catalogo aggiuntivo.
    const casseIds = [...new Set([
      ...movimentiReali.map(m => m.cassa_categoria_id),
      ...incassiVirtuali.map(i => i.cassa_categoria_id),
    ].filter((id): id is string => !!id))]
    const nomiCasse = new Map<string, string | null>()
    if (casseIds.length > 0) {
      const casseLette = await leggiABlocchi<{ id: string; nome: string | null }>(() => supabase
        .from('payment_categories').select('id, nome').in('id', casseIds))
      if (!casseLette.ok) return letturaRegistroFallita('cassa-provenienze', casseLette)
      for (const cassa of casseLette.righe) nomiCasse.set(cassa.id, cassa.nome)
    }

    // 3) Componi la lista.
    const righe: RigaMovimentoConSede[] = []
    for (const m of movimentiReali) {
      righe.push({
        id: m.id,
        origine: 'cassa',
        scuola_id: m.scuola_id,
        scuola_nome: nomeDi(m.scuola_id),
        tipo: m.tipo,
        importo: round2(Number(m.importo)),
        metodo: m.metodo,
        data: m.data,
        categoria_id: m.categoria_id,
        cassa_categoria_id: m.cassa_categoria_id ?? null,
        cassa_categoria_nome: m.cassa_categoria_id ? nomiCasse.get(m.cassa_categoria_id) ?? null : null,
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
      const sedeInc = inc.scuola_id
      righe.push({
        id: `incasso:${inc.id}`,
        origine: 'incasso',
        scuola_id: sedeInc,
        scuola_nome: nomeDi(sedeInc),
        tipo: 'entrata',
        importo: round2(Number(inc.importo)),
        metodo: 'contanti',
        data: inc.data_incasso,
        categoria_id: null,
        cassa_categoria_id: inc.cassa_categoria_id,
        cassa_categoria_nome: inc.cassa_categoria_id ? nomiCasse.get(inc.cassa_categoria_id) ?? null : null,
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
    if (incassiSenzaSede > 0) {
      logEvento('cassa', 'warn', { operazione: 'pagamenti/cassa/movimenti:GET', esito: 'incassi-auto-senza-sede', quantita: incassiSenzaSede })
    }
    righe.sort((x, y) => (x.data < y.data ? 1 : x.data > y.data ? -1 : x.creato_il < y.creato_il ? 1 : -1))

    if (!isDirezione) {
      // Segreteria: SOLO l'elenco, nessun KPI. Le chiavi `totali` e `uscite_mese` NON esistono.
      return NextResponse.json({ disponibile: true, movimenti: righe })
    }

    // Direzione: totali sul set filtrato (le entrate auto già escludono gli storni,
    // e gli incassi senza sede, scartati sopra: totali e righe sono lo stesso insieme).
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

    // «Uscite del mese»: fino al 2026-09-26 il riquadro sommava `totali`, cioè le
    // uscite del set FILTRATO — e la UI non passa da/a, quindi erano le uscite di
    // SEMPRE. Ora le calcola il server sul mese corrente di Europe/Rome, con una
    // query propria che ignora i filtri della lista. Tutti i metodi, storni inclusi
    // (sono contro-movimenti a importo negato: la somma si corregge da sola).
    const uscite_mese = await caricaUsciteMese(supabase, sedi, nomeDi)

    return NextResponse.json({ disponibile: true, movimenti: righe, totali, uscite_mese })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/cassa/movimenti:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

/** Nessuna pagina parziale della lista deve sembrare un registro completo. */
function letturaRegistroFallita(tipo: string, esito: Extract<EsitoABlocchi<unknown>, { ok: false }>): Response {
  const errore = esito.motivo === 'errore' ? esito.error : new Error(`${descriviTetto(tipo, esito)}, registro rifiutato per intero`)
  logErrore({ operazione: 'pagamenti/cassa/movimenti:GET', stato: 500, evento: esito.motivo === 'tetto' ? 'lettura-troncata' : 'db' }, errore)
  return NextResponse.json({ error: 'Impossibile leggere tutti i movimenti di cassa' }, { status: 500 })
}

/**
 * Uscite (tipo='uscita', tutti i metodi) del mese corrente Europe/Rome, per sede e
 * in totale. Su errore della lettura → `null` + log `error` con esito proprio: il
 * riquadro mostra «—» invece di un numero sbagliato, e la lista resta servita (200).
 * Niente `logErrore({ stato: 500 })`: dichiarerebbe uno stato che il client non
 * riceve, e non si distinguerebbe dal 500 vero della lettura della lista.
 */
async function caricaUsciteMese(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  sedi: string[],
  nomeDi: (id: string | null) => string | null,
): Promise<{ da: string; a: string; totale: number; per_sede: { scuola_id: string; scuola_nome: string | null; totale: number }[] } | null> {
  const mese = meseCorrenteRoma()
  const esito = await leggiABlocchi<{ scuola_id: string; importo: number | string }>(() => supabase
    .from('cassa_movimenti')
    .select('scuola_id, importo')
    .in('scuola_id', sedi)
    .eq('tipo', 'uscita')
    .gte('data', mese.da)
    .lte('data', mese.a))
  if (!esito.ok) {
    const errore = esito.motivo === 'errore' ? esito.error : new Error(descriviTetto('cassa-uscite-mese', esito))
    logEvento('cassa', 'error', { operazione: 'pagamenti/cassa/movimenti:GET', esito: 'uscite-mese-non-lette', sedi: sedi.length }, errore)
    return null
  }
  const perSede = new Map<string, number>(sedi.map((s) => [s, 0]))
  for (const r of esito.righe) {
    if (!perSede.has(r.scuola_id)) continue
    perSede.set(r.scuola_id, (perSede.get(r.scuola_id) ?? 0) + Number(r.importo))
  }
  const per_sede = sedi.map((s) => ({ scuola_id: s, scuola_nome: nomeDi(s), totale: round2(perSede.get(s) ?? 0) }))
  return { da: mese.da, a: mese.a, totale: round2(per_sede.reduce((t, p) => t + p.totale, 0)), per_sede }
}

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

    if (body.cassa_categoria_id) {
      const categoria = await supabase.from('payment_categories')
        .select('id, scuola_id, attivo').eq('id', body.cassa_categoria_id).maybeSingle()
      if (categoria.error) {
        logErrore({ operazione: 'pagamenti/cassa/movimenti:POST', stato: 500, evento: 'db' }, categoria.error)
        return NextResponse.json({ error: 'Impossibile verificare la cassa scelta', codice: 'LETTURA_FALLITA' }, { status: 500 })
      }
      if (!categoria.data || categoria.data.attivo !== true || (categoria.data.scuola_id !== null && categoria.data.scuola_id !== scuolaId)) {
        logEvento('cassa', 'warn', { operazione: 'pagamenti/cassa/movimenti:POST', esito: 'cassa-provenienza-non-valida', scuola_id: scuolaId, categoria_id: body.cassa_categoria_id })
        return NextResponse.json({ error: 'La cassa scelta non è disponibile per questa sede', codice: 'CASSA_CATEGORIA_NON_VALIDA', details: [{ path: 'cassa_categoria_id' }] }, { status: 400 })
      }
    }

    const ins = await supabase
      .from('cassa_movimenti')
      .insert({
        scuola_id: scuolaId,
        tipo: body.tipo,
        importo: round2(body.importo),
        metodo: body.metodo,
        data: body.data ?? undefined,
        categoria_id: body.categoria_id ?? null,
        ...(body.cassa_categoria_id !== undefined ? { cassa_categoria_id: body.cassa_categoria_id } : {}),
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
      if (code === '23514' || code === '23503') {
        logEvento('cassa', 'warn', { operazione: 'pagamenti/cassa/movimenti:POST', esito: 'categoria-non-valida', scuola_id: scuolaId }, ins.error)
        return NextResponse.json({ error: 'La categoria scelta non è più disponibile: aggiorna la selezione', codice: 'CASSA_CATEGORIA_NON_VALIDA' }, { status: 400 })
      }
      logErrore({ operazione: 'pagamenti/cassa/movimenti:POST', stato: 500, evento: 'db' }, ins.error)
      return NextResponse.json({ error: 'Errore nella registrazione del movimento' }, { status: 500 })
    }
    const movimento = ins.data as { id: string }

    // Audit (best-effort ma NON muto — RC3). Il testo libero resta in
    // registro_modifiche, MAI nei log. PostgREST non lancia: si controlla { error }
    // e un audit non scritto (≠ schema-assente) va a `warn` con solo uuid ed esito.
    const audit = await supabase
      .from('registro_modifiche')
      .insert({
        azione: 'cassa_movimento',
        tabella_interessata: 'cassa_movimenti',
        record_id: movimento.id,
        nuovo_valore: ins.data,
        utente_id: user.id,
      })
    if (audit.error) {
      const code = (audit.error as { code?: string }).code ?? ''
      if (CASSA_SCHEMA_ASSENTE.has(code)) {
        logEvento('cassa', 'info', { operazione: 'pagamenti/cassa/movimenti:POST', esito: 'audit-schema-assente', movimento_id: movimento.id })
      } else {
        logEvento('cassa', 'warn', { operazione: 'pagamenti/cassa/movimenti:POST', esito: 'audit-non-scritto', movimento_id: movimento.id }, audit.error)
      }
    }

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
      categoria_id: body.cassa_categoria_id ?? null,
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
