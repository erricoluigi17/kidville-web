import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import {
  assertAnnoSedeInScope,
  impostazioniNonDisponibili,
  rispostaErroreImpostazioni,
} from '@/lib/anno/impostazioni'
import { confermaIscrizione } from '@/lib/anno/iscrizione-anno'
import { leggiABlocchi } from '@/lib/anno/lettura-a-blocchi'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zLimite, zUuid } from '@/lib/validation/common'
import { parseBody, parseData, parseQuery } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * LE CONFERME PER L'ANNO PROSSIMO (PR 4.5, compiti 4.5.6 e 4.5.10). `annoSedeId` = `anni_sede.id` dell'anno NUOVO, quello con le
 * iscrizioni aperte; l'anno di partenza è l'anno attivo della sede.
 *
 *  · GET  — due viste (`?vista=`). `conferme` (predefinita): per ogni frequenza viva dell'anno attivo, se la famiglia ha confermato,
 *    ha detto «no» o non ha risposto, a che punto sono moduli e quota, se cambia grado. `nuove`: le frequenze vive dell'anno nuovo
 *    di chi arriva da fuori (`tipo = 'nuova'`) o di chi non frequenta (torna dopo essere uscito): senza questa vista la segreteria non avrebbe un posto dove spuntare i loro moduli.
 *    Il filtro (`?conferma=`, anche `mancano_moduli`) lo applica la route sul TOTALE. I NOMI li porta la route, e solo della pagina:
 *    nome e cognome da `alunni`, due colonne.
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
  /** Il flag mantenuto dal database (trigger): tutti i moduli richiesti dalla lista della riga sono spuntati. Serve ai due filtri di 4.7.4. */
  moduli_completi?: boolean | null
  /** La lista dei moduli di una riga è quella del suo `tipo` (4.5.17, B); `null` (il recupero) non ne ha. */
  tipo: 'conferma' | 'nuova' | null
}
type Sezione = { id: string; name: string | null; school_type: string | null; fascia: string | null }

const VIVE = ['in_attesa', 'iscritto']

/** Le due viste della pagina: i bambini dell'anno attivo che confermano, e le NUOVE iscrizioni dell'anno che si apre. */
const VISTE = ['conferme', 'nuove'] as const
const FILTRI = ['tutti', 'confermato', 'no', 'non_risposto', 'mancano_moduli', 'moduli_senza_quota', 'quota_senza_moduli'] as const
/** I filtri che guardano solo la frequenza dell'anno nuovo (non la risposta della famiglia): valgono anche nelle «nuove iscrizioni». */
const FILTRI_SULLA_NUOVA = ['tutti', 'mancano_moduli', 'moduli_senza_quota', 'quota_senza_moduli'] as const

const getQuerySchema = z
  .object({
    pagina: z.coerce.number().int().min(1).max(10_000).default(1),
    limite: zLimite({ predefinito: 100, max: 200 }),
    /** Elenco chiuso. `conferme` è la vista di sempre; `nuove` le frequenze `nuova` dell'anno nuovo. */
    vista: z.enum(VISTE).default('conferme'),
    /** Elenco chiuso: il filtro lo applica la route, sul totale. Nelle nuove iscrizioni hanno senso solo quelli di `FILTRI_SULLA_NUOVA`. */
    conferma: z.enum(FILTRI).default('tutti'),
  })
  .refine((q) => q.vista === 'conferme' || (FILTRI_SULLA_NUOVA as readonly string[]).includes(q.conferma), {
    path: ['conferma'],
    message: 'Filtro non valido per le nuove iscrizioni',
  })

type Db = Awaited<ReturnType<typeof createAdminClient>>
type ErroreDb = { code?: string; message?: string }

/** Una lettura che è andata male: lo schema dell'anno non c'è ancora (503), oppure un guasto vero (500, loggato). */
function lettura(error: ErroreDb, ctx: { operazione: string; annoSedeId: string; utente: string }) {
  return rispostaErroreImpostazioni(error, { ...ctx, tipoRifiuto: TIPO_RIFIUTO, lettura: true })
}

/** Quali moduli ha spuntato ciascuna frequenza fra i moduli indicati: TUTTE quelle dell'anno, a blocchi (serve al filtro «mancano moduli»). */
async function spunteDellAnno(supabase: Db, idModuli: string[]): Promise<{ fatti: Map<string, Set<string>> } | { error: ErroreDb }> {
  const fatti = new Map<string, Set<string>>()
  if (idModuli.length === 0) return { fatti }
  const r = await leggiABlocchi<{ frequenza_id: string; modulo_id: string }>((da, a) =>
    supabase.from('frequenze_moduli').select('frequenza_id, modulo_id').in('modulo_id', idModuli).order('id', { ascending: true }).range(da, a),
  )
  if ('error' in r) return { error: r.error }
  for (const x of r.righe) {
    const set = fatti.get(x.frequenza_id) ?? new Set<string>()
    set.add(x.modulo_id)
    fatti.set(x.frequenza_id, set)
  }
  return { fatti }
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
  const { pagina, limite, conferma, vista } = q.data

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

  const dal = (pagina - 1) * limite
  // I moduli di una riga sono quelli della lista del suo `tipo` (`conferma` o `nuova`), in tutte e due le viste: è la lista che la route
  // che spunta (`frequenze/[frequenzaId]/moduli`) usa davvero. Un `tipo` NULL (il recupero) non ne ha (4.5.17, B).
  const richiesti = await supabase.from('moduli_richiesti').select('id, lista').eq('anno_sede_id', annoSedeId).in('lista', ['conferma', 'nuova'])
  if (richiesti.error) return lettura(richiesti.error, ctx)
  const perLista = { conferma: new Set<string>(), nuova: new Set<string>() }
  for (const m of (Array.isArray(richiesti.data) ? richiesti.data : []) as Array<{ id: string; lista: 'conferma' | 'nuova' }>) perLista[m.lista]?.add(m.id)
  const NESSUNO = new Set<string>()
  const richiestiDi = (tipo: Nuova['tipo']): Set<string> => (tipo ? perLista[tipo] : NESSUNO)
  const idTutti = [...perLista.conferma, ...perLista.nuova]
  /** I due casi dell'incrocio moduli/quota (4.7.4), letti dai flag che il database mantiene sulla frequenza. */
  const incrocioModuliQuota = (n: { quota_saldata: boolean; moduli_completi?: boolean | null }, filtro: 'moduli_senza_quota' | 'quota_senza_moduli'): boolean =>
    filtro === 'moduli_senza_quota' ? n.moduli_completi === true && !n.quota_saldata : n.quota_saldata === true && n.moduli_completi !== true
  const mancano = (n: { id: string; tipo: Nuova['tipo'] }, fatti: Map<string, Set<string>>): boolean => {
    const r = richiestiDi(n.tipo)
    if (r.size === 0) return false
    const f = fatti.get(n.id)
    return [...r].some((m) => !f?.has(m))
  }

  // `partenze` = i bambini dell'anno attivo da mostrare (vista conferme); `nuove` = le frequenze dell'anno nuovo che li riguardano
  // (vista conferme) oppure da mostrare (vista nuove).
  let partenze: Partenza[] = []
  let nuove: Nuova[] = []
  let totale = 0

  if (vista === 'nuove') {
    // Le frequenze vive dell'anno nuovo di chi arriva da fuori (`tipo = 'nuova'`) E di chi non frequenta: un bambino tornato dopo essere
    // uscito, la cui riga si è riaperta come `conferma`, non sta in «Conferme» (non ha una frequenza viva nell'anno attivo) e senza questa
    // regola non starebbe da nessuna parte (4.5.17, A). Chi frequenta e ha confermato sta nell'altra vista. Si legge a blocchi: il totale
    // e la pagina restano veri.
    const colonneNuova = 'id, alunno_id, section_id, stato, quota_saldata, quota_pagamento_id, tipo, moduli_completi'
    const tutte = await leggiABlocchi<Nuova>((da, a) =>
      supabase.from('frequenze').select(colonneNuova).eq('anno_sede_id', annoSedeId).in('stato', VIVE).order('id', { ascending: true }).range(da, a),
    )
    if ('error' in tutte) return lettura(tutte.error, ctx)
    let candidate = tutte.righe
    if (candidate.some((n) => n.tipo !== 'nuova')) {
      // Chi frequenta: ha una frequenza viva nell'anno attivo della sede. Se `anno_attivo` non dà un anno, nessuno frequenta.
      const attivo = await supabase.rpc('anno_attivo', { p_scuola: letta.scuolaId })
      if (attivo.error) return lettura(attivo.error, ctx)
      const attivoId = typeof attivo.data === 'string' && attivo.data !== annoSedeId ? attivo.data : null
      const frequentano = new Set<string>()
      if (attivoId) {
        // Anche l'anno di partenza dev'essere dentro il perimetro, come nell'altra vista.
        const fuoriSedeAttivo = await assertAnnoSedeInScope(supabase, auth.user, attivoId, operazione)
        if (fuoriSedeAttivo) return fuoriSedeAttivo
        const f = await leggiABlocchi<{ alunno_id: string }>((da, a) =>
          supabase.from('frequenze').select('alunno_id').eq('anno_sede_id', attivoId).in('stato', VIVE).order('id', { ascending: true }).range(da, a),
        )
        if ('error' in f) return lettura(f.error, ctx)
        for (const x of f.righe) frequentano.add(x.alunno_id)
      }
      candidate = candidate.filter((n) => n.tipo === 'nuova' || !frequentano.has(n.alunno_id))
    }
    let giuste = candidate
    if (conferma === 'mancano_moduli') {
      const spunte = await spunteDellAnno(supabase, idTutti)
      if ('error' in spunte) return lettura(spunte.error, ctx)
      giuste = candidate.filter((n) => mancano(n, spunte.fatti))
    } else if (conferma === 'moduli_senza_quota' || conferma === 'quota_senza_moduli') {
      giuste = candidate.filter((n) => incrocioModuliQuota(n, conferma))
    }
    totale = giuste.length
    nuove = giuste.slice(dal, dal + limite)
  } else {
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
    const colonne = 'id, alunno_id, section_id, non_rinnova_il, non_rinnova_motivo'
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
      const tutteLePartenze = await leggiABlocchi<Pick<Partenza, 'id' | 'alunno_id' | 'non_rinnova_il'>>((da, a) =>
        supabase.from('frequenze').select('id, alunno_id, non_rinnova_il').eq('anno_sede_id', partenzaId).in('stato', VIVE).order('id', { ascending: true }).range(da, a),
      )
      if ('error' in tutteLePartenze) return lettura(tutteLePartenze.error, ctx)
      const tutteLeNuove = await leggiABlocchi<Pick<Nuova, 'id' | 'alunno_id' | 'tipo' | 'quota_saldata' | 'moduli_completi'>>((da, a) =>
        supabase.from('frequenze').select('id, alunno_id, tipo, quota_saldata, moduli_completi').eq('anno_sede_id', annoSedeId).in('stato', VIVE).order('id', { ascending: true }).range(da, a),
      )
      if ('error' in tutteLeNuove) return lettura(tutteLeNuove.error, ctx)
      const confermati = new Set(tutteLeNuove.righe.map((n) => n.alunno_id))
      const statoDi = (p: { alunno_id: string; non_rinnova_il: string | null }): Stato =>
        confermati.has(p.alunno_id) ? 'confermato' : p.non_rinnova_il ? 'no' : 'non_risposto'
      let giuste: Array<{ id: string }>
      if (conferma === 'mancano_moduli') {
        // Mancano moduli a chi ha confermato (ha una frequenza nuova) e ne ha spuntati meno di quelli richiesti.
        const spunte = await spunteDellAnno(supabase, idTutti)
        if ('error' in spunte) return lettura(spunte.error, ctx)
        const nuovaDi = new Map(tutteLeNuove.righe.map((n) => [n.alunno_id, n]))
        giuste = tutteLePartenze.righe.filter((p) => {
          const n = nuovaDi.get(p.alunno_id)
          return !!n && mancano(n, spunte.fatti)
        })
      } else if (conferma === 'moduli_senza_quota' || conferma === 'quota_senza_moduli') {
        // L'incrocio vale per chi ha confermato: i due flag li mantiene il database sulla frequenza dell'anno nuovo.
        const nuovaDi = new Map(tutteLeNuove.righe.map((n) => [n.alunno_id, n]))
        giuste = tutteLePartenze.righe.filter((p) => {
          const n = nuovaDi.get(p.alunno_id)
          return !!n && incrocioModuliQuota(n, conferma)
        })
      } else {
        giuste = tutteLePartenze.righe.filter((p) => statoDi(p) === conferma)
      }
      totale = giuste.length
      const idPagina = giuste.slice(dal, dal + limite).map((p) => p.id)
      if (idPagina.length > 0) {
        const r = await supabase.from('frequenze').select(colonne).eq('anno_sede_id', partenzaId).in('id', idPagina)
        if (r.error) return lettura(r.error, ctx)
        const perId = new Map(((Array.isArray(r.data) ? r.data : []) as Partenza[]).map((p) => [p.id, p]))
        partenze = idPagina.map((i) => perId.get(i)).filter((p): p is Partenza => !!p)
      }
    }

    // Cosa c'è già nell'anno nuovo per quei bambini.
    const alunniPagina = partenze.map((p) => p.alunno_id)
    if (alunniPagina.length > 0) {
      const r = await supabase
        .from('frequenze')
        .select('id, alunno_id, section_id, stato, quota_saldata, quota_pagamento_id, tipo')
        .eq('anno_sede_id', annoSedeId)
        .in('alunno_id', alunniPagina)
      if (r.error) return lettura(r.error, ctx)
      nuove = (Array.isArray(r.data) ? r.data : []) as Nuova[]
    }
  }
  const nuovaDi = new Map(nuove.map((n) => [n.alunno_id, n]))

  // Quanti moduli ha spuntato ciascuna frequenza nuova della pagina.
  const tipoDi = new Map(nuove.map((n) => [n.id, n.tipo]))
  const fatti = new Map<string, number>()
  if (nuove.length > 0 && idTutti.length > 0) {
    const r = await supabase.from('frequenze_moduli').select('frequenza_id, modulo_id').in('frequenza_id', nuove.map((n) => n.id))
    if (r.error) return lettura(r.error, ctx)
    for (const x of (Array.isArray(r.data) ? r.data : []) as Array<{ frequenza_id: string; modulo_id: string }>) {
      if (richiestiDi(tipoDi.get(x.frequenza_id) ?? null).has(x.modulo_id)) fatti.set(x.frequenza_id, (fatti.get(x.frequenza_id) ?? 0) + 1)
    }
  }

  // Le sezioni: per sapere se chi ha confermato cambia grado, e il nome della classe da mostrare (il nome di una sezione non è un dato personale).
  const idSezioni = [...new Set([...partenze.map((p) => p.section_id), ...nuove.map((n) => n.section_id)].filter((s): s is string => !!s))]
  const sezioni = new Map<string, Sezione>()
  if (idSezioni.length > 0) {
    let lettiSezioni = supabase.from('sections').select('id, name, school_type, fascia').in('id', idSezioni)
    if (letta.scuolaId) lettiSezioni = lettiSezioni.eq('scuola_id', letta.scuolaId)
    const r = await lettiSezioni
    if (r.error) return lettura(r.error, ctx)
    for (const s of (Array.isArray(r.data) ? r.data : []) as Sezione[]) sezioni.set(s.id, s)
  }
  const cambiaGrado = (da: string | null, a: string | null): boolean => {
    const x = da ? sezioni.get(da) : undefined
    const y = a ? sezioni.get(a) : undefined
    if (!x || !y) return false
    return x.school_type !== y.school_type || (!!x.fascia && !!y.fascia && x.fascia !== y.fascia)
  }
  const classeDi = (s: string | null): string | null => (s ? (sezioni.get(s)?.name ?? null) : null)

  // I NOMI li porta la route, e solo della pagina: nome e cognome, due colonne e nessun'altra (la pagina non scarica più le schede
  // intere). Un bambino `in_arrivo` non è fra i frequentanti: senza questa lettura le «nuove iscrizioni» sarebbero tutte senza nome.
  // Mai nei log.
  const idBambini = [...new Set([...partenze.map((p) => p.alunno_id), ...nuove.map((n) => n.alunno_id)])]
  const nomi = new Map<string, { nome: string | null; cognome: string | null }>()
  if (idBambini.length > 0) {
    let lettiAlunni = supabase.from('alunni').select('id, nome, cognome').in('id', idBambini)
    if (letta.scuolaId) lettiAlunni = lettiAlunni.eq('scuola_id', letta.scuolaId)
    const r = await lettiAlunni
    if (r.error) return lettura(r.error, ctx)
    for (const a of (Array.isArray(r.data) ? r.data : []) as Array<{ id: string; nome: string | null; cognome: string | null }>) {
      nomi.set(a.id, { nome: a.nome ?? null, cognome: a.cognome ?? null })
    }
  }
  const quotaDi = (n: Nuova): StatoQuota => (n.quota_saldata ? 'saldata' : n.quota_pagamento_id ? 'da_pagare' : 'assente')

  // «Più voci» (4.7.4): la quota non nasce da sola quando il bambino ha più voci dell'anno da guardare. Prima lo ricordava solo la pagina,
  // finché non si ricaricava: ora lo dice il database (stessa regola della porta di conferma), con UNA chiamata per la pagina.
  const piuVoci = new Set<string>()
  const senzaQuota = nuove.filter((n) => VIVE.includes(n.stato) && !n.quota_pagamento_id).map((n) => n.id)
  if (senzaQuota.length > 0) {
    const pv = await supabase.rpc('anno_quota_piu_voci', { p_anno_sede: annoSedeId, p_frequenze: senzaQuota })
    if (pv.error) {
      // Schema indietro (la CI): il dato manca e basta, la pagina funziona lo stesso. Ogni altro errore è un guasto vero.
      if (!schemaAnnoIndietro(pv.error)) return lettura(pv.error, ctx)
      logEvento('anno-scolastico', 'info', { tipo: 'conferme-piu-voci-schema-indietro', operazione, error_code: pv.error.code ?? undefined })
    } else {
      for (const x of (Array.isArray(pv.data) ? pv.data : []) as Array<{ frequenza_id: string }>) piuVoci.add(x.frequenza_id)
    }
  }

  const righe =
    vista === 'nuove'
      ? nuove.map((n) => ({
          // Nella vista delle nuove la riga È la frequenza dell'anno nuovo: `frequenza_id` e `nuova_frequenza_id` coincidono, ed è lì che
          // si spuntano i moduli. `conferma` non ha senso per chi arriva da fuori o torna dopo essere uscito (la pagina non mostra la colonna).
          frequenza_id: n.id,
          alunno_id: n.alunno_id,
          section_id: n.section_id,
          nuova_frequenza_id: n.id,
          nuova_section_id: n.section_id,
          conferma: 'confermato' as Stato,
          non_rinnova_motivo: null,
          moduli: { fatti: fatti.get(n.id) ?? 0, richiesti: richiestiDi(n.tipo).size },
          quota: quotaDi(n),
          quota_piu_voci: piuVoci.has(n.id),
          cambia_grado: false,
          stato_frequenza: n.stato,
          nome: nomi.get(n.alunno_id)?.nome ?? null,
          cognome: nomi.get(n.alunno_id)?.cognome ?? null,
          classe: classeDi(n.section_id),
        }))
      : partenze.map((p) => {
          const n = nuovaDi.get(p.alunno_id)
          const confermata = !!n && VIVE.includes(n.stato)
          const conferma: Stato = confermata ? 'confermato' : p.non_rinnova_il ? 'no' : 'non_risposto'
          return {
            frequenza_id: p.id,
            // il bambino e le due sezioni: la pagina li usa per il passaggio alla primaria
            alunno_id: p.alunno_id,
            section_id: p.section_id,
            nuova_frequenza_id: confermata ? n.id : null,
            nuova_section_id: confermata ? n.section_id : null,
            conferma,
            non_rinnova_motivo: conferma === 'no' ? p.non_rinnova_motivo : null,
            moduli: { fatti: confermata ? (fatti.get(n.id) ?? 0) : 0, richiesti: confermata ? richiestiDi(n.tipo).size : perLista.conferma.size },
            // Una frequenza ritirata con la voce ancora attaccata (pagata) la famiglia la vede: la vista non deve dire «assente» (4.7.4).
            quota: n ? quotaDi(n) : ('assente' as StatoQuota),
            quota_piu_voci: confermata ? piuVoci.has(n.id) : false,
            cambia_grado: confermata ? cambiaGrado(p.section_id, n.section_id) : false,
            stato_frequenza: confermata ? n.stato : null,
            nome: nomi.get(p.alunno_id)?.nome ?? null,
            cognome: nomi.get(p.alunno_id)?.cognome ?? null,
            classe: classeDi(p.section_id),
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
      // La sezione chiesta non è stata applicata (la riga c'era viva con un'altra) / la conferma ha riaperto una frequenza ritirata.
      ...(esito.sezione_ignorata === true ? { sezione_ignorata: true } : {}),
      ...(esito.riaperta === true ? { riaperta: true } : {}),
    },
  })
})
