import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, type AppUser } from '@/lib/auth/require-staff'
import { parseData, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { isScuolaE2E } from '@/lib/scuole/reali'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// `anno` e `periodo` NON sono vincolati nel formato: storicamente un valore
// malformato ricade sull'anteprima/generazione mensile del mese corrente
// (vedi firstOfMonth e il test /^\d{4}$/ a runtime), non è un errore.
const getQuerySchema = z.object({
  anno: z.string().optional(),
  periodo: z.string().optional(),
  // stringa vuota = assente (come il vecchio `searchParams.get(...) || fallback`)
  scuola_id: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
})

const postBodySchema = z.object({
  // dalla UI `anno` arriva come numero; ammessa anche la stringa (storico)
  anno: z.union([z.number(), z.string()]).nullish(),
  periodo: z.string().nullish(),
  // La sede su cui si emettono le rette. La manda il client (il pannello sta
  // dentro <SedeRequired>, quindi ce l'ha sempre); se manca e l'operatore ha più
  // plessi, `resolveScuolaScrittura` risponde 400 invece di sceglierne una.
  scuola_id: zUuid.nullish(),
})

function firstOfMonth(periodo?: string | null): string {
  if (periodo && /^\d{4}-\d{2}/.test(periodo)) {
    const [y, m] = periodo.split('-')
    return `${y}-${m}-01`
  }
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
}

// I 10 periodi (primo del mese) di un anno scolastico: set(anno) -> giu(anno+1)
function periodiAnno(annoInizio: number): string[] {
  const out: string[] = []
  for (let m = 9; m <= 12; m++) out.push(`${annoInizio}-${String(m).padStart(2, '0')}-01`)
  for (let m = 1; m <= 6; m++) out.push(`${annoInizio + 1}-${String(m).padStart(2, '0')}-01`)
  return out
}

// importo retta effettivo = importo personalizzato dell'alunno, altrimenti default globale (150)
function importoRetta(a: { importo_retta_mensile?: number | null }, rettaDefault: number): number {
  const personalizzato = Number(a.importo_retta_mensile || 0)
  return personalizzato > 0 ? personalizzato : rettaDefault
}

// La retta si genera solo dal mese di iscrizione in poi (iscrizione prima del
// 1° settembre → tutto l'anno). NULL = alunno storico, iscritto da sempre.
// Stessa regola della RPC SQL genera_rette_mensili (migr. 20260710160000).
function iscrittoEntro(a: { data_iscrizione?: string | null }, periodo: string): boolean {
  if (!a.data_iscrizione) return true
  return `${String(a.data_iscrizione).slice(0, 7)}-01` <= periodo
}

/**
 * LA SEDE DELLE RETTE — una sola, e la STESSA per l'anteprima e per la conferma.
 *
 * Fino al 2026-07-31 i due verbi guardavano insiemi diversi: il GET filtrava
 * `.eq('scuola_id', …)` sui candidati, il POST chiamava `genera_rette_mensili(p_periodo)`,
 * una RPC senza parametro di sede, e generava per TUTTI i plessi. Non è un rischio
 * teorico: in produzione `registro_modifiche` conserva UNA sola esecuzione
 * (`generati: 25`) e le rette risultanti stanno su DUE sedi — 21 su Giugliano e 4
 * sulla sede finta di collaudo. Un clic, due plessi.
 *
 * Perciò la sede la risolve un punto solo, con la regola delle SCRITTURE
 * (`resolveScuolaScrittura`): dichiarata dal client se accessibile, altrimenti
 * l'unica sede attiva/accessibile, altrimenti **400** — mai «ne scelgo una io».
 *
 * In più: la sede di COLLAUDO non entra nella contabilità di produzione. Le 4
 * rette emesse sulla sede E2E sono dati finti dentro il database vero, che
 * entrano nei totali e nelle liste di morosità. Il presidio è doppio — qui un 400
 * leggibile, e nella RPC (`schools.operativa`) il rifiuto strutturale, per chi la
 * chiamasse senza passare da questa route.
 */
async function sedeDelleRette(
  request: Request,
  supabase: SupabaseClient,
  user: AppUser,
  operazione: string,
  preferita?: string | null,
): Promise<{ scuolaId?: string; response?: NextResponse }> {
  const sede = await resolveScuolaScrittura(request as NextRequest, supabase, user, preferita)
  if (sede.response || !sede.scuolaId) return sede
  const scuolaId = sede.scuolaId

  // Il nome è il secondo indizio di `isScuolaE2E` (il primo è il prefisso
  // dell'uuid). PostgREST non lancia: se la lettura fallisce si prosegue col
  // solo indizio dell'id — ma lo si dice, perché un predicato dimezzato in
  // silenzio è il modo in cui questi filtri smettono di funzionare.
  const { data: scuola, error } = await supabase
    .from('schools')
    .select('id, nome')
    .eq('id', scuolaId)
    .maybeSingle()
  if (error) {
    logEvento('pagamento', 'error', { operazione, esito: 'sede-non-riletta', scuola_id: scuolaId }, error)
  }
  const nome = (scuola as { nome?: string | null } | null)?.nome ?? ''
  if (isScuolaE2E({ id: scuolaId, nome })) {
    logEvento('pagamento', 'warn', {
      operazione, tipo: 'sede-collaudo', esito: 'generazione-rifiutata',
      utente: user.id, ruolo: user.role, scuola_id: scuolaId,
    })
    return {
      response: NextResponse.json(
        { error: 'Sede di collaudo: la generazione delle rette non è consentita' },
        { status: 400 },
      ),
    }
  }
  return { scuolaId }
}

/**
 * La categoria «retta» della sede, con precedenza `sede > globale`.
 *
 * Le categorie di sistema sono globali (`scuola_id IS NULL`) ma il vincolo
 * `(scuola_id, nome)` consente a un plesso di crearsi la PROPRIA «Retta». Finché
 * il consumo guardava le sole globali, quella categoria non sarebbe mai stata
 * usata: rette nella globale e filtro di sede sempre vuoto.
 *
 * L'errore NON diventa un 500 (il comportamento storico era proseguire senza
 * categoria), ma non resta muto: senza categoria salta la deduplica e
 * l'anteprima conterebbe come candidati anche i già fatti.
 */
async function categoriaRetta(
  supabase: SupabaseClient,
  scuolaId: string,
  operazione: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('payment_categories')
    .select('id, scuola_id')
    .eq('slug', 'retta')
    .or(`scuola_id.eq.${scuolaId},scuola_id.is.null`)
  if (error) {
    logEvento('pagamento', 'error', { operazione, esito: 'categoria-retta-non-risolta', scuola_id: scuolaId }, error)
    return null
  }
  const righe = (data ?? []) as { id: string; scuola_id?: string | null }[]
  const diSede = righe.find((c) => c.scuola_id === scuolaId)
  const globale = righe.find((c) => !c.scuola_id)
  return (diSede ?? globale)?.id ?? null
}

// GET /api/pagamenti/genera-rette?userId=&periodo=YYYY-MM | &anno=YYYY [&scuola_id=]  (staff)
// Preview: alunni candidati alla generazione retta per il mese (periodo) o per l'intero
// anno scolastico (anno = anno di inizio, set->giu).
export const GET = withRoute('pagamenti/genera-rette:GET', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const annoParam = q.data.anno

    const supabase = await createAdminClient()
    // Stesso scope della conferma: l'anteprima conta ciò che il POST scriverà.
    const sede = await sedeDelleRette(request, supabase, auth.user, 'pagamenti/genera-rette:GET', q.data.scuola_id)
    if (sede.response) return sede.response
    const scuolaId = sede.scuolaId as string

    const catId = await categoriaRetta(supabase, scuolaId, 'pagamenti/genera-rette:GET')

    // retta default della sede
    const { data: sett } = await supabase
      .from('admin_settings')
      .select('retta_default_importo, scuola_id')
      .eq('scuola_id', scuolaId)
      .limit(1)
      .maybeSingle()
    const rettaDefault = Number(sett?.retta_default_importo ?? 150)

    // alunni attivi = iscritti CON sezione valorizzata (classe_sezione o section_id)
    const COLONNE_ALUNNI = 'id, nome, cognome, classe_sezione, section_id, importo_retta_mensile, genitori_separati, scuola_id'
    // eslint-disable-next-line prefer-const -- alunniRaw è riassegnato nel retry
    let { data: alunniRaw, error: errAlunni } = await supabase
      .from('alunni')
      .select(`${COLONNE_ALUNNI}, data_iscrizione, retta_a_carico_di`)
      .eq('stato', 'iscritto')
      .eq('scuola_id', scuolaId)
    // retry senza data_iscrizione né retta_a_carico_di sui DB non migrati (e2e CI):
    // colonne ignorate, e il filtro qui sotto degrada da sé (undefined == null).
    if (errAlunni && (errAlunni as { code?: string }).code === '42703') {
      const retry = await supabase
        .from('alunni')
        .select(COLONNE_ALUNNI)
        .eq('stato', 'iscritto')
        .eq('scuola_id', scuolaId)
      alunniRaw = (retry.data ?? null) as unknown as typeof alunniRaw
    }
    /**
     * CHI PAGA PER CHI, ricavato dalla lettura che c'è già.
     *
     * ⚠️ Va calcolato PRIMA del filtro qui sotto: chi è a carico di un altro viene
     * scartato dai candidati, e con lui sparirebbe l'informazione «X paga per
     * qualcuno» — che è esattamente ciò che serve a riconoscere un anello.
     */
    const pagaPer = new Map<string, number>()
    for (const a of alunniRaw || []) {
      const carico = (a as { retta_a_carico_di?: string | null }).retta_a_carico_di
      if (carico) pagaPer.set(carico, (pagaPer.get(carico) ?? 0) + 1)
    }

    const alunni = (alunniRaw || [])
      .filter((a) => a.classe_sezione != null || a.section_id != null)
      // RETTA A CARICO DI UN FRATELLO — lo stesso filtro che ha la RPC dal
      // 2026-08-16 (`AND al.retta_a_carico_di IS NULL`). Deve stare in ENTRAMBE
      // le strade: se lo avesse solo la RPC, questa anteprima prometterebbe rette
      // che la conferma non genera, e il totale mostrato alla segreteria sarebbe
      // più alto di quello vero — il tipo di divergenza fra GET e POST che questa
      // route ha già pagato una volta (v. commento «LA SEDE DELLE RETTE»).
      .filter((a) => (a as { retta_a_carico_di?: string | null }).retta_a_carico_di == null)

    // NB: la lista dei «già fatti» NON si filtra per sede. La deduplica della RPC
    // è per (alunno, periodo) a prescindere dal plesso: filtrando qui, un bambino
    // trasferito da un plesso all'altro comparirebbe fra i candidati e poi non
    // verrebbe generato — anteprima e conferma tornerebbero a divergere.

    // --- Anteprima ANNUALE (set->giu) ---
    if (annoParam && /^\d{4}$/.test(annoParam)) {
      const annoInizio = parseInt(annoParam, 10)
      const periodi = periodiAnno(annoInizio)

      const { data: esistenti } = await supabase
        .from('pagamenti')
        .select('alunno_id, periodo_competenza')
        .in('periodo_competenza', periodi)
        .eq('categoria_id', catId)
      const fattiPerPeriodo = new Map<string, Set<string>>()
      for (const e of esistenti || []) {
        const key = String(e.periodo_competenza)
        if (!fattiPerPeriodo.has(key)) fattiPerPeriodo.set(key, new Set())
        fattiPerPeriodo.get(key)!.add(e.alunno_id)
      }

      let totaleCandidati = 0
      let totalePrevisto = 0
      const mesi = periodi.map((p) => {
        const giaFatti = fattiPerPeriodo.get(p) ?? new Set()
        const candidati = alunni.filter((a) => !giaFatti.has(a.id) && iscrittoEntro(a, p))
        const importo = candidati.reduce((s, a) => s + importoRetta(a, rettaDefault), 0)
        totaleCandidati += candidati.length
        totalePrevisto += importo
        return { periodo: p, candidati: candidati.length, gia_generati: giaFatti.size, importo }
      })

      return NextResponse.json({
        success: true,
        data: {
          anno_inizio: annoInizio,
          mesi,
          alunni_attivi: alunni.length,
          retta_default: rettaDefault,
          totale_candidati: totaleCandidati,
          totale_previsto: totalePrevisto,
        },
      })
    }

    // --- Anteprima MENSILE ---
    const periodo = firstOfMonth(q.data.periodo)
    const { data: esistenti } = await supabase
      .from('pagamenti')
      .select('alunno_id')
      .eq('periodo_competenza', periodo)
      .eq('categoria_id', catId)
    const giaFatti = new Set((esistenti || []).map((e) => e.alunno_id))

    const candidati = alunni
      .filter((a) => !giaFatti.has(a.id) && iscrittoEntro(a, periodo))
      .map((a) => {
        const importoPrevisto = importoRetta(a, rettaDefault)
        const quantiPagaPer = pagaPer.get(a.id) ?? 0
        return {
          ...a,
          importo_previsto: importoPrevisto,
          /**
           * Quanti fratelli hanno la retta a carico di questo bambino: la sua riga
           * è, da sola, il conto dell'intera famiglia.
           */
          paga_per: quantiPagaPer,
          /**
           * 🔴 IL CONTRASSEGNO CHE MANCAVA, e quanto è costato non averlo.
           *
           * Un importo fra 0 e 1 € oggi compare qui come «€ 0,01» e non lo nota
           * nessuno. A Giugliano, misurato il 2026-09-04, un bambino con 0,01 €
           * aveva a suo carico un fratello da 250 €: la famiglia è stata addebitata
           * di UN CENTESIMO per settembre 2026, e nove mesi così sono 2.250 € che
           * nessuno avrebbe mai chiesto. Nessun errore, nessun log — solo una riga
           * che sembrava una riga qualunque.
           *
           * Lo zero non è compreso: sulla colonna significa «usa il default di
           * sede», e infatti `importoRetta` lo ha già sostituito col default.
           */
          importo_simbolico: importoPrevisto > 0 && importoPrevisto < 1,
        }
      })
    const totale = candidati.reduce((s, a) => s + a.importo_previsto, 0)

    // Una famiglia il cui unico pagante porta un importo simbolico: il conto di tutti
    // i fratelli sta sotto l'euro. Va in `warn` con i soli CONTEGGI — mai nomi, mai
    // codici fiscali (AGENTS.md, regola 8) — perché è l'unica riga da cui si può
    // sapere, il mese dopo, che qualcosa è andato storto in silenzio.
    const famiglieSospette = candidati.filter((c) => c.importo_simbolico && c.paga_per > 0).length
    if (famiglieSospette > 0) {
      logEvento('pagamento', 'warn', {
        operazione: 'pagamenti/genera-rette:GET',
        esito: 'famiglie-totale-sospetto',
        scuola_id: scuolaId,
        n: famiglieSospette,
        msg:
          'famiglie il cui unico pagante ha un importo sotto l’euro: la retta di tutti i ' +
          'fratelli verrebbe addebitata per quella cifra',
      })
    }

    return NextResponse.json({
      success: true,
      data: { periodo, candidati, gia_generati: giaFatti.size, retta_default: rettaDefault, totale_previsto: totale },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/genera-rette:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

/** Traccia in `registro_modifiche` chi ha generato, quando e SU QUALE SEDE.
 *  Best-effort — non fa fallire la generazione — ma mai muta: `.then(() => {}, () => {})`
 *  scartava sia l'esito sia il rifiuto, e PostgREST NON lancia (l'errore torna
 *  dentro il risultato). Senza questa riga, «l'audit non è stato scritto» era
 *  indistinguibile da «è stato scritto». */
async function tracciaAudit(
  supabase: SupabaseClient,
  operazione: string,
  azione: string,
  nuovoValore: Record<string, unknown>,
  utenteId: string,
): Promise<void> {
  const { error } = await supabase.from('registro_modifiche').insert({
    azione,
    tabella_interessata: 'pagamenti',
    record_id: null,
    nuovo_valore: nuovoValore,
    utente_id: utenteId,
  })
  if (error) {
    logEvento('pagamento', 'error', { operazione, azione, esito: 'audit-non-scritto' }, error)
  }
}

// POST /api/pagamenti/genera-rette  (staff) — conferma generazione
// Body: { userId, scuola_id, periodo?: 'YYYY-MM' }  -> singolo mese
//   oppure { userId, scuola_id, anno: 2026 }        -> intero anno scolastico (set->giu)
export const POST = withRoute('pagamenti/genera-rette:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    // Il body è opzionale: senza body (o JSON malformato) si genera il mese
    // corrente (comportamento storico), quindi niente parseBody che darebbe 400.
    const raw: unknown = await request.json().catch(() => ({}))
    const b = parseData(postBodySchema, raw)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()
    const sede = await sedeDelleRette(request, supabase, auth.user, 'pagamenti/genera-rette:POST', body.scuola_id)
    if (sede.response) return sede.response
    const scuolaId = sede.scuolaId as string

    // --- Generazione ANNUALE ---
    if (body.anno != null && /^\d{4}$/.test(String(body.anno))) {
      const annoInizio = parseInt(String(body.anno), 10)
      const { data, error } = await supabase.rpc('genera_rette_anno', {
        p_anno_inizio: annoInizio,
        p_scuola_id: scuolaId,
      })
      if (error) {
        logErrore({ operazione: 'pagamenti/genera-rette:POST', stato: 500, evento: 'db' }, error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      await tracciaAudit(
        supabase, 'pagamenti/genera-rette:POST', 'genera_rette_anno',
        { anno_inizio: annoInizio, generati: data, scuola_id: scuolaId }, auth.user.id,
      )
      // Un evento contabile va visto anche quando funziona: con i soli errori,
      // «nessun log» non distingue «tutto ok» da «non è mai partito niente».
      logEvento('pagamento', 'info', {
        operazione: 'pagamenti/genera-rette:POST', esito: 'rette-generate',
        anno: annoInizio, generati: Number(data ?? 0), scuola_id: scuolaId,
      })

      return NextResponse.json({ success: true, data: { anno_inizio: annoInizio, generati: data } })
    }

    // --- Generazione MENSILE ---
    const periodo = firstOfMonth(body.periodo)
    const { data, error } = await supabase.rpc('genera_rette_mensili', {
      p_periodo: periodo,
      p_scuola_id: scuolaId,
    })
    if (error) {
      logErrore({ operazione: 'pagamenti/genera-rette:POST', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    await tracciaAudit(
      supabase, 'pagamenti/genera-rette:POST', 'genera_rette',
      { periodo, generati: data, scuola_id: scuolaId }, auth.user.id,
    )
    logEvento('pagamento', 'info', {
      operazione: 'pagamenti/genera-rette:POST', esito: 'rette-generate',
      periodo, generati: Number(data ?? 0), scuola_id: scuolaId,
    })

    // Notifica ai genitori le rette appena generate e GIÀ visibili (rispetta
    // visibile_dal: niente notifiche per dovuti non ancora mostrati). Una sola
    // notifica per genitore, e SOLO sulla sede generata: senza il filtro, le
    // rette dello stesso mese emesse prima su un altro plesso rientrerebbero
    // nell'elenco e i loro genitori verrebbero avvisati una seconda volta.
    if (typeof data === 'number' && data > 0) {
      try {
        const oggi = new Date().toISOString().slice(0, 10)
        const { data: nuove, error: errNuove } = await supabase
          .from('pagamenti')
          .select('alunno_id, visibile_dal')
          .eq('periodo_competenza', periodo)
          .eq('scuola_id', scuolaId)
          .eq('gruppo', `retta-${periodo.slice(0, 7)}`)
        if (errNuove) {
          logEvento('pagamento', 'error', {
            operazione: 'pagamenti/genera-rette:POST', esito: 'destinatari-non-letti',
            periodo, scuola_id: scuolaId,
          }, errNuove)
        }
        const alunniIds = ((nuove ?? []) as Array<{ alunno_id: string; visibile_dal: string | null }>)
          .filter((p) => !(p.visibile_dal && p.visibile_dal > oggi))
          .map((p) => p.alunno_id)
        const mese = `${periodo.slice(5, 7)}/${periodo.slice(0, 4)}`
        if (alunniIds.length === 0) {
          // Rette emesse e nessuno da avvisare: può essere legittimo (tutte non
          // ancora visibili), ma se non lo è nessuno se ne accorgerebbe mai.
          logEvento('pagamento', 'warn', {
            operazione: 'pagamenti/genera-rette:POST', esito: 'nessun-destinatario',
            periodo, generati: Number(data), scuola_id: scuolaId,
          })
        } else {
          await notificaEvento(supabase, {
            tipo: 'pagamento_emesso',
            scuolaId,
            alunnoIds: alunniIds,
            titolo: `Retta ${mese} disponibile`,
            corpo: 'La nuova retta è disponibile nella sezione Pagamenti.',
            link: '/parent/pagamenti',
            entitaTipo: 'pagamento',
          })
        }
      } catch (e) {
        // Le rette SONO state generate, ma nessun genitore lo saprà: notifica persa.
        logEvento('notifica', 'error', {
          operazione: 'pagamenti/genera-rette:POST',
          tipo: 'pagamento_emesso',
          esito: 'notifica_non_inviata',
          periodo,
          generati: Number(data),
        }, e)
      }
    }

    return NextResponse.json({ success: true, data: { periodo, generati: data } })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/genera-rette:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
