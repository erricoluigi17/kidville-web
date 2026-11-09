import { politicaNotificaServizio } from '@/lib/storici/notifiche-servizi'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseData, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { dataCivile } from '@/i18n/config'
import { mesiDelAnno } from '@/lib/anno-scolastico'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { rispostaBlocchiFalliti, rispostaGuastoDb } from '@/lib/pagamenti/guasto-db'
import { leggiABlocchi } from '@/lib/pagamenti/leggi-a-blocchi'
import { sedeDellaGenerazione, tracciaAuditGenerazione, generaServizi, rispostaServizi } from '@/lib/pagamenti/generazione-server'
import { erroreAnno } from '@/lib/anno/errori'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import { annoSedeDelPeriodo, leggiRetteDaGenerare, logRiepilogoRette, riepilogoRette, type RigaRetta } from '@/lib/pagamenti/rette-anno'

// `anno` e `periodo` NON sono vincolati nel formato: storicamente un valore
// malformato ricade sull'anteprima/generazione mensile del mese corrente
// (vedi firstOfMonth e il test /^\d{4}$/ a runtime), non è un errore.
const getQuerySchema = z.object({
  anno: z.string().optional(),
  periodo: z.string().optional(),
  // stringa vuota = assente (come il vecchio `searchParams.get(...) || fallback`)
  scuola_id: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
  // L'anno di sede (`anni_sede.id`) su cui si ragiona. Assente = quello che contiene il mese (o l'anno `anno`) nella sede.
  anno_sede_id: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
})

const postBodySchema = z.object({
  // dalla UI `anno` arriva come numero; ammessa anche la stringa (storico)
  anno: z.union([z.number(), z.string()]).nullish(),
  periodo: z.string().nullish(),
  // La sede su cui si emettono le rette. La manda il client (il pannello sta
  // dentro <SedeRequired>, quindi ce l'ha sempre); se manca e l'operatore ha più
  // plessi, `resolveScuolaScrittura` risponde 400 invece di sceglierne una.
  scuola_id: zUuid.nullish(),
  // L'anno di sede su cui si genera (`anni_sede.id`). Assente = quello che contiene il mese (o l'anno `anno`) nella sede.
  anno_sede_id: zUuid.nullish(),
  /**
   * I bambini scelti. Assente = tutti gli iscritti della sede, che è il
   * comportamento di sempre — e in SQL diventa `p_alunno_ids = NULL`, non un
   * array vuoto: `= ANY('{}')` è falso per tutti, e «nessuno scelto» sarebbe
   * «zero generate» in silenzio. La RPC ha una guardia apposta.
   *
   * Il perimetro di sede lo impone comunque la funzione (`al.scuola_id =
   * p_scuola_id` resta in AND col filtro nuovo): un id di un altro plesso non
   * genera niente nemmeno se questa route sbagliasse.
   */
  alunno_ids: z.array(zUuid).min(1).nullish(),
})

function firstOfMonth(periodo?: string | null): string {
  if (periodo && /^\d{4}-\d{2}/.test(periodo)) {
    const [y, m] = periodo.split('-')
    return `${y}-${m}-01`
  }
  // Il mese di ROMA, non quello UTC: alle 00:30 del 1° del mese a Roma l'UTC è ancora il mese prima.
  return `${dataCivile(new Date()).slice(0, 7)}-01`
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

/** Gli anni che la 4.6 distingue: le rette «arrivano» alle famiglie solo dall'anno in corso. */
const ANNO_ATTIVO = 'corrente'

type AnnoScelto = { annoSedeId: string; stato: string }

/** Quanti uuid in una sola query `.in('id', …)`. */
const GRUPPO_ID = 150

/**
 * L'anteprima dal LISTINO e dalle FREQUENZE dell'anno (PR 4.6): chi riceve la retta, di quanto e perché no lo dice
 * `rette_da_generare` (M46a), la stessa funzione che la conferma legge per scrivere. Qui si aggiungono solo i nomi dei bambini
 * e il conto dei fratelli. `null` = il database non ha ancora la funzione: chi chiama torna alla strada storica.
 */
async function anteprimaDalListino(
  supabase: SupabaseClient,
  scuolaId: string,
  anno: AnnoScelto,
  o: { annuale: boolean; periodo: string; annoParam: string | null },
): Promise<NextResponse | null> {
  const operazione = 'pagamenti/genera-rette:GET'
  const letto = await leggiRetteDaGenerare(supabase, { annoSedeId: anno.annoSedeId, periodo: o.annuale ? null : o.periodo })
  if (!letto.ok) {
    if ('schemaIndietro' in letto) return null
    // Il mese fuori dall'anno (`ANNO_NON_COERENTE`) o l'anno sparito sono rifiuti con un codice, non guasti: `rispostaGuastoDb`
    // li riconosce solo in scrittura, e questa è una lettura che li può sollevare.
    return erroreAnno(letto.errore as { code?: string; message?: string }, operazione) ?? rispostaGuastoDb(operazione, 'db:rette_da_generare', letto.errore)
  }
  const righe = letto.righe

  const { data: sett, error: errSett } = await supabase
    .from('admin_settings')
    .select('retta_auto_enabled')
    .eq('scuola_id', scuolaId)
    .limit(1)
    .maybeSingle()
  if (errSett) return rispostaGuastoDb(operazione, 'db:admin_settings', errSett)
  const generazioneAttiva = sett?.retta_auto_enabled !== false

  // La retta «senza fascia» del listino, se c'è: è il valore che la schermata mostra come «retta di riferimento».
  const { data: voce, error: errVoce } = await supabase
    .from('listino_voci')
    .select('importo')
    .eq('anno_sede_id', anno.annoSedeId)
    .eq('voce', 'retta')
    .is('fascia', null)
    .order('importo', { ascending: true })
    .limit(1)
  if (errVoce) return rispostaGuastoDb(operazione, 'db:listino_voci', errVoce)
  const rettaDefault = (voce as Array<{ importo: number | null }> | null)?.[0]?.importo ?? null

  const riepilogo = riepilogoRette(righe)
  const visibile = anno.stato === ANNO_ATTIVO
  const comuni = {
    anno_sede_id: anno.annoSedeId,
    anno_stato: anno.stato,
    generazione_attiva: generazioneAttiva,
    retta_default: rettaDefault,
    senza_importo: riepilogo.senzaImporto,
    esenti: riepilogo.esenti,
    pagante_assente: riepilogo.paganteAssente,
    per_origine: riepilogo.perOrigine,
    visibile_alle_famiglie: visibile,
  }
  const daFare = (r: RigaRetta) => r.esito === 'da_generare' && !r.gia_generato

  // ── ANNUALE: una riga per mese
  if (o.annuale) {
    const periodi = [...new Set(righe.map((r) => r.periodo))].sort()
    let totaleCandidati = 0
    let totalePrevisto = 0
    const mesi = periodi.map((p) => {
      const delMese = righe.filter((r) => r.periodo === p)
      const candidati = delMese.filter(daFare)
      const importo = candidati.reduce((t, r) => t + Number(r.importo ?? 0), 0)
      totaleCandidati += candidati.length
      totalePrevisto += importo
      return {
        periodo: p,
        candidati: candidati.length,
        candidati_ids: candidati.map((r) => r.alunno_id),
        gia_generati: delMese.filter((r) => r.gia_generato).length,
        importo: Math.round(importo * 100) / 100,
      }
    })
    const annoInizio = o.annoParam
      ? parseInt(o.annoParam, 10)
      : periodi[0]
        ? Number(periodi[0].slice(0, 4)) - (Number(periodi[0].slice(5, 7)) < 9 ? 1 : 0)
        : null
    return NextResponse.json({
      success: true,
      data: {
        ...comuni,
        anno_inizio: annoInizio,
        mesi,
        alunni_attivi: new Set(righe.map((r) => r.alunno_id)).size,
        totale_candidati: totaleCandidati,
        totale_previsto: Math.round(totalePrevisto * 100) / 100,
      },
    })
  }

  // ── MENSILE: i candidati con i dati che la tabella mostra
  const candidatiRighe = righe.filter(daFare)
  const perAlunno = new Map(candidatiRighe.map((r) => [r.alunno_id, r]))

  // I nomi si leggono PER IDENTITÀ dei soli candidati (a gruppi, perché un uuid ogni 37 caratteri in una query string ha un
  // limite): chi ha una frequenza viva nell'anno, anche se oggi non è ancora «iscritto», e nessun altro. Il perimetro di sede resta.
  const COLONNE_ALUNNI = 'id, nome, cognome, classe_sezione, section_id, importo_retta_mensile, genitori_separati, scuola_id'
  const alunniLetti: Array<Record<string, unknown> & { id: string }> = []
  const idCandidati = [...perAlunno.keys()]
  for (let i = 0; i < idCandidati.length; i += GRUPPO_ID) {
    const { data, error } = await supabase
      .from('alunni')
      .select(COLONNE_ALUNNI)
      .in('id', idCandidati.slice(i, i + GRUPPO_ID))
      .eq('scuola_id', scuolaId)
    if (error) return rispostaGuastoDb(operazione, 'db:alunni', error)
    alunniLetti.push(...((data ?? []) as Array<Record<string, unknown> & { id: string }>))
  }

  // Chi paga per chi, dalle frequenze dell'anno (è lì che la funzione SQL lo legge).
  const caricoLetto = await leggiABlocchi<{ id: string; retta_a_carico_di: string | null }>(() =>
    supabase.from('frequenze').select('id, retta_a_carico_di').eq('anno_sede_id', anno.annoSedeId).eq('scuola_id', scuolaId).not('retta_a_carico_di', 'is', null),
  )
  if (!caricoLetto.ok) return rispostaBlocchiFalliti(operazione, 'frequenze:rette-a-carico', caricoLetto)
  const pagaPer = new Map<string, number>()
  for (const f of caricoLetto.righe) {
    if (f.retta_a_carico_di) pagaPer.set(f.retta_a_carico_di, (pagaPer.get(f.retta_a_carico_di) ?? 0) + 1)
  }

  const candidati = alunniLetti
    .filter((a) => perAlunno.has(a.id))
    .map((a) => {
      const r = perAlunno.get(a.id) as RigaRetta
      const importoPrevisto = Number(r.importo ?? 0)
      return {
        ...a,
        importo_previsto: importoPrevisto,
        origine_importo: r.origine_importo,
        // Quanti fratelli hanno la retta a carico di questo bambino: la sua riga è, da sola, il conto dell'intera famiglia.
        paga_per: pagaPer.get(a.id) ?? 0,
        // Un importo fra 0 e 1 € è quasi sempre un errore (v. 2026-09-04): lo si contrassegna invece di nasconderlo.
        importo_simbolico: importoPrevisto > 0 && importoPrevisto < 1,
      }
    })

  const famiglieSospette = candidati.filter((c) => c.importo_simbolico && c.paga_per > 0).length
  if (famiglieSospette > 0) {
    logEvento('pagamento', 'warn', {
      operazione,
      esito: 'famiglie-totale-sospetto',
      scuola_id: scuolaId,
      n: famiglieSospette,
      msg: 'famiglie il cui unico pagante ha un importo sotto l’euro: la retta di tutti i fratelli verrebbe addebitata per quella cifra',
    })
  }

  return NextResponse.json({
    success: true,
    data: {
      ...comuni,
      periodo: o.periodo,
      candidati,
      gia_generati: riepilogo.giaGenerati,
      totale_previsto: Math.round(candidati.reduce((t, c) => t + c.importo_previsto, 0) * 100) / 100,
    },
  })
}

// GET /api/pagamenti/genera-rette?userId=&periodo=YYYY-MM | &anno=YYYY [&scuola_id=] [&anno_sede_id=]  (staff)
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
    const sede = await sedeDellaGenerazione(request, supabase, auth.user, 'pagamenti/genera-rette:GET', q.data.scuola_id)
    if (sede.response) return sede.response
    const scuolaId = sede.scuolaId as string

    // L'ANNO SCELTO (PR 4.6). Se il database lo conosce, rette e importi vengono dal listino e dalle frequenze di QUELL'anno;
    // se non ha ancora lo schema (CI, finestra del deploy) si prosegue sulla strada storica qui sotto, che non è cambiata.
    const annuale = !!annoParam && /^\d{4}$/.test(annoParam)
    const periodoMese = firstOfMonth(q.data.periodo)
    const scelta = await annoSedeDelPeriodo(supabase, scuolaId, {
      annoSedeId: q.data.anno_sede_id,
      ...(annuale ? { anno: parseInt(annoParam as string, 10) } : { periodo: periodoMese }),
    })
    if (!scelta.ok && scelta.codice === 'errore') return rispostaGuastoDb('pagamenti/genera-rette:GET', 'db:anni_sede', scelta.errore)
    if (!scelta.ok && scelta.codice === 'ANNO_NON_TROVATO') {
      return erroreAnno({ message: 'ANNO_NON_TROVATO' }, 'pagamenti/genera-rette:GET') ?? NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
    if (scelta.ok) {
      const dalListino = await anteprimaDalListino(
        supabase, scuolaId, { annoSedeId: scelta.annoSedeId, stato: scelta.stato },
        { annuale, periodo: periodoMese, annoParam: annuale ? annoParam ?? null : null },
      )
      if (dalListino) return dalListino
    }

    const catId = await categoriaRetta(supabase, scuolaId, 'pagamenti/genera-rette:GET')

    // retta default della sede. Un guasto qui NON è «nessuna impostazione»: era un'anteprima
    // a 150 € a testa e con la generazione automatica data per accesa (fase 5 robustezza,
    // sesto pezzo).
    const { data: sett, error: errSett } = await supabase
      .from('admin_settings')
      .select('retta_default_importo, retta_auto_enabled, scuola_id')
      .eq('scuola_id', scuolaId)
      .limit(1)
      .maybeSingle()
    if (errSett) return rispostaGuastoDb('pagamenti/genera-rette:GET', 'db:admin_settings', errSett)
    const rettaDefault = Number(sett?.retta_default_importo ?? 150)
    /**
     * ⚠️ LA RPC ONORA `retta_auto_enabled`, L'ANTEPRIMA LO IGNORAVA.
     *
     * Il corpo della funzione ha `AND COALESCE(s.retta_auto_enabled, true) = true`.
     * Togliendo la spunta in Impostazioni, l'anteprima mostrava trecento candidati
     * e qualche decina di migliaia di euro, e la conferma scriveva ZERO — senza
     * dire perché. È la causa vera del sintomo «generati: 0» che sembra un guasto
     * del programma, ed è una casella che si può togliere per sbaglio.
     */
    const generazioneAttiva = sett?.retta_auto_enabled !== false

    // alunni attivi = iscritti CON sezione valorizzata (classe_sezione o section_id)
    const COLONNE_ALUNNI = 'id, nome, cognome, classe_sezione, section_id, importo_retta_mensile, genitori_separati, scuola_id'
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
      errAlunni = retry.error
    }
    // Ogni altro errore (e quello del retry) è un guasto, non «nessun alunno attivo».
    if (errAlunni) return rispostaGuastoDb('pagamenti/genera-rette:GET', 'db:alunni', errAlunni)
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
      const periodi = mesiDelAnno(annoInizio)

      // A BLOCCHI: dieci mesi di rette di una sede sono migliaia di righe, e PostgREST ne
      // consegna 1000 senza dirlo — l'anteprima riproponeva come «da generare» le rette già
      // emesse oltre il taglio, e un guasto le riproponeva tutte.
      const esistentiLetti = await leggiABlocchi<{ alunno_id: string; periodo_competenza: string }>(() =>
        supabase
          .from('pagamenti')
          .select('id, alunno_id, periodo_competenza')
          .in('periodo_competenza', periodi)
          .eq('categoria_id', catId),
      )
      if (!esistentiLetti.ok) return rispostaBlocchiFalliti('pagamenti/genera-rette:GET', 'pagamenti:rette-esistenti', esistentiLetti)
      const fattiPerPeriodo = new Map<string, Set<string>>()
      for (const e of esistentiLetti.righe) {
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
        /**
         * ⚠️ ANCHE GLI ID, non solo il conteggio. La scelta dei bambini vive nel
         * browser — il client ha già l'elenco e filtrarlo lì dà lo stesso numero
         * al centesimo — ma la vista ANNUALE è quella aperta di default e finora
         * restituiva soli aggregati: senza gli id, per l'anno non ci sarebbe
         * niente da spuntare. In risposta non ci sono limiti di lunghezza: 314
         * uuid per dieci mesi sono ~116 kB, contro una query string che si
         * romperebbe.
         */
        return { periodo: p, candidati: candidati.length, candidati_ids: candidati.map((a) => a.id), gia_generati: giaFatti.size, importo }
      })

      return NextResponse.json({
        success: true,
        data: {
          anno_inizio: annoInizio,
          generazione_attiva: generazioneAttiva,
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
    const esistentiLetti = await leggiABlocchi<{ alunno_id: string }>(() =>
      supabase
        .from('pagamenti')
        .select('id, alunno_id')
        .eq('periodo_competenza', periodo)
        .eq('categoria_id', catId),
    )
    if (!esistentiLetti.ok) return rispostaBlocchiFalliti('pagamenti/genera-rette:GET', 'pagamenti:rette-esistenti', esistentiLetti)
    const giaFatti = new Set(esistentiLetti.righe.map((e) => e.alunno_id))

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
      data: { periodo, generazione_attiva: generazioneAttiva, candidati, gia_generati: giaFatti.size, retta_default: rettaDefault, totale_previsto: totale },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/genera-rette:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

/**
 * Chiama la funzione SQL con l'anno di sede (4 argomenti). Se il database ha ancora la versione di prima (PGRST202: la
 * funzione a quattro argomenti non c'è), ripiega sui tre di sempre, con una riga `info`: la finestra fra il deploy del
 * codice e quello della migrazione non deve fermare la segreteria.
 */
async function chiamaGenerazione(
  supabase: SupabaseClient,
  funzione: 'genera_rette_anno' | 'genera_rette_mensili',
  args: Record<string, unknown>,
  annoSedeId: string | null,
  scuolaId: string,
) {
  if (annoSedeId) {
    const r = await supabase.rpc(funzione, { ...args, p_anno_sede: annoSedeId })
    if (!r.error || !schemaAnnoIndietro(r.error)) return r
    logEvento('pagamento', 'info', {
      operazione: 'pagamenti/genera-rette:POST', esito: 'rette-funzione-vecchia',
      tipo: funzione, scuola_id: scuolaId, error_code: typeof r.error.code === 'string' ? r.error.code : 'sconosciuto',
    })
  }
  return supabase.rpc(funzione, args)
}

/**
 * Il riepilogo di CIÒ CHE sta per essere scritto (chi riceve la retta, chi no e perché), letto PRIMA di scrivere: serve al log
 * e alla risposta. Un guasto qui non ferma la generazione (il riepilogo è un'informazione, non un permesso): si logga e si va avanti.
 */
async function riepilogoPrima(
  supabase: SupabaseClient,
  scuolaId: string,
  annoSedeId: string,
  o: { periodo: string | null; alunnoIds: string[] | null },
) {
  const letto = await leggiRetteDaGenerare(supabase, { annoSedeId, periodo: o.periodo, alunnoIds: o.alunnoIds })
  if (!letto.ok) {
    if (!('schemaIndietro' in letto)) {
      logEvento('pagamento', 'error', { operazione: 'pagamenti/genera-rette:POST', esito: 'riepilogo-non-letto', scuola_id: scuolaId }, letto.errore)
    }
    return null
  }
  return riepilogoRette(letto.righe)
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
    const sede = await sedeDellaGenerazione(request, supabase, auth.user, 'pagamenti/genera-rette:POST', body.scuola_id)
    if (sede.response) return sede.response
    const scuolaId = sede.scuolaId as string

    // L'ANNO SCELTO (PR 4.6): quello nominato da `anno_sede_id`, o quello che contiene il mese (o l'anno) nella SEDE.
    // Se il database non ha ancora lo schema dell'anno, `annoSedeId` resta null e si genera come prima.
    const annuale = body.anno != null && /^\d{4}$/.test(String(body.anno))
    const periodoMese = annuale ? null : firstOfMonth(body.periodo)
    const scelta = await annoSedeDelPeriodo(supabase, scuolaId, {
      annoSedeId: body.anno_sede_id ?? undefined,
      ...(annuale ? { anno: parseInt(String(body.anno), 10) } : { periodo: periodoMese as string }),
    })
    if (!scelta.ok && scelta.codice === 'errore') return rispostaGuastoDb('pagamenti/genera-rette:POST', 'db:anni_sede', scelta.errore, 'scrittura')
    if (!scelta.ok && scelta.codice === 'ANNO_NON_TROVATO') {
      return erroreAnno({ message: 'ANNO_NON_TROVATO' }, 'pagamenti/genera-rette:POST') ?? NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
    const annoSedeId = scelta.ok ? scelta.annoSedeId : null
    const statoAnno = scelta.ok ? scelta.stato : null
    const riepilogo = annoSedeId ? await riepilogoPrima(supabase, scuolaId, annoSedeId, { periodo: periodoMese, alunnoIds: body.alunno_ids ?? null }) : null
    if (annoSedeId && riepilogo) logRiepilogoRette('pagamenti/genera-rette:POST', scuolaId, annoSedeId, riepilogo)
    const visibileAlleFamiglie = statoAnno === null ? null : statoAnno === ANNO_ATTIVO

    // --- Generazione ANNUALE ---
    if (annuale) {
      const annoInizio = parseInt(String(body.anno), 10)
      const { data, error } = await chiamaGenerazione(
        supabase, 'genera_rette_anno',
        { p_anno_inizio: annoInizio, p_scuola_id: scuolaId, p_alunno_ids: body.alunno_ids ?? null },
        annoSedeId, scuolaId,
      )
      if (error) return rispostaGuastoDb('pagamenti/genera-rette:POST', 'db:genera_rette_anno', error, 'scrittura')
      await tracciaAuditGenerazione(
        supabase, 'pagamenti/genera-rette:POST', 'genera_rette_anno',
        { anno_inizio: annoInizio, generati: data, scuola_id: scuolaId }, auth.user.id,
      )
      // Un evento contabile va visto anche quando funziona: con i soli errori,
      // «nessun log» non distingue «tutto ok» da «non è mai partito niente».
      logEvento('pagamento', 'info', {
        operazione: 'pagamenti/genera-rette:POST', esito: 'rette-generate',
        anno: annoInizio, generati: Number(data ?? 0), scuola_id: scuolaId,
        ...(annoSedeId ? { entita_id: annoSedeId } : {}),
      })

      // I servizi mensili dei bambini iscritti nell'anno: DOPO le rette riuscite. Un guasto
      // qui non le fa sembrare fallite (sono già scritte): lo dice `data.servizi`.
      const servizi = await generaServizi(supabase, {
        anno: annoInizio, scuolaId, alunnoIds: body.alunno_ids ?? null,
        utenteId: auth.user.id, operazione: 'pagamenti/genera-rette:POST', azione: 'rette',
      })

      return NextResponse.json({
        success: true,
        data: {
          anno_inizio: annoInizio, generati: data, servizi: rispostaServizi(servizi),
          ...(annoSedeId ? { anno_sede_id: annoSedeId, senza_importo: riepilogo?.senzaImporto ?? null, visibile_alle_famiglie: visibileAlleFamiglie } : {}),
        },
      })
    }

    // --- Generazione MENSILE ---
    const periodo = periodoMese as string
    // Chi aveva GIÀ la retta di questo mese, letto PRIMA di generare: è l'unico
    // modo per avvisare solo i nuovi senza affidarsi a un orologio.
    // Un guasto qui, letto come «nessuno l'aveva», mandava «nuova retta» a TUTTE le famiglie
    // della sede. Si legge prima di scrivere: un 500 qui non ha generato niente.
    const giaLetti = await leggiABlocchi<{ alunno_id: string }>(() =>
      supabase
        .from('pagamenti')
        .select('id, alunno_id')
        .eq('periodo_competenza', periodo)
        .eq('scuola_id', scuolaId)
        .eq('gruppo', `retta-${periodo.slice(0, 7)}`),
    )
    if (!giaLetti.ok) return rispostaBlocchiFalliti('pagamenti/genera-rette:POST', 'pagamenti:rette-gia-emesse', giaLetti)
    const prima = new Set(giaLetti.righe.map((p) => p.alunno_id))
    const { data, error } = await chiamaGenerazione(
      supabase, 'genera_rette_mensili',
      { p_periodo: periodo, p_scuola_id: scuolaId, p_alunno_ids: body.alunno_ids ?? null },
      annoSedeId, scuolaId,
    )
    if (error) return rispostaGuastoDb('pagamenti/genera-rette:POST', 'db:genera_rette_mensili', error, 'scrittura')

    await tracciaAuditGenerazione(
      supabase, 'pagamenti/genera-rette:POST', 'genera_rette',
      { periodo, generati: data, scuola_id: scuolaId }, auth.user.id,
    )
    logEvento('pagamento', 'info', {
      operazione: 'pagamenti/genera-rette:POST', esito: 'rette-generate',
      periodo, generati: Number(data ?? 0), scuola_id: scuolaId,
      ...(annoSedeId ? { entita_id: annoSedeId } : {}),
    })

    // Notifica ai genitori le rette appena generate e GIÀ visibili (rispetta
    // visibile_dal: niente notifiche per dovuti non ancora mostrati). Una sola
    // notifica per genitore, e SOLO sulla sede generata: senza il filtro, le
    // rette dello stesso mese emesse prima su un altro plesso rientrerebbero
    // nell'elenco e i loro genitori verrebbero avvisati una seconda volta.
    // Le rette di un anno che NON è quello in corso (in preparazione, iscrizioni aperte) si creano ma non si annunciano:
    // le famiglie le vedranno dal momento in cui l'anno diventa quello attivo, e un avviso adesso sarebbe prematuro.
    if (typeof data === 'number' && data > 0 && statoAnno !== null && statoAnno !== ANNO_ATTIVO) {
      logEvento('pagamento', 'info', {
        operazione: 'pagamenti/genera-rette:POST', esito: 'notifica-saltata-anno-non-attivo',
        periodo, generati: data, scuola_id: scuolaId, entita_id: annoSedeId as string,
      })
    } else if (typeof data === 'number' && data > 0) {
      try {
        const oggi = new Date().toISOString().slice(0, 10)
        const { data: nuove, error: errNuove } = await supabase
          .from('pagamenti')
          .select('alunno_id, visibile_dal')
          .eq('periodo_competenza', periodo)
          .eq('scuola_id', scuolaId)
          .eq('gruppo', `retta-${periodo.slice(0, 7)}`)
        // ⚠️ Questo elenco è TUTTE le rette del mese su questa sede, non solo
        // quelle appena create: generando per un bambino solo, senza il confronto
        // qui sotto si riavviserebbero i genitori di tutti e trecento. Il difetto
        // c'era già sulla rigenerazione parziale; con la scelta per singolo
        // bambino diventa il caso normale.
        if (errNuove) {
          logEvento('pagamento', 'error', {
            operazione: 'pagamenti/genera-rette:POST', esito: 'destinatari-non-letti',
            periodo, scuola_id: scuolaId,
          }, errNuove)
        }
        const alunniIds = ((nuove ?? []) as Array<{ alunno_id: string; visibile_dal: string | null }>)
          .filter((p) => !(p.visibile_dal && p.visibile_dal > oggi))
          .map((p) => p.alunno_id)
          // Solo chi NON aveva già la retta prima di questa chiamata. Niente
          // orologi (`creato_il >= now()`): lo scarto fra il clock di Next e
          // quello di Postgres farebbe sparire i destinatari in silenzio.
          .filter((id) => !prima.has(id))
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
            operazione: politicaNotificaServizio(auth.user, periodo),
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

    // I servizi mensili dei bambini iscritti nel mese. Dopo le notifiche, che restano
    // solo per le rette: un servizio non genera avvisi ai genitori.
    const servizi = await generaServizi(supabase, {
      periodo, scuolaId, alunnoIds: body.alunno_ids ?? null,
      utenteId: auth.user.id, operazione: 'pagamenti/genera-rette:POST', azione: 'rette',
    })

    return NextResponse.json({
      success: true,
      data: {
        periodo, generati: data, servizi: rispostaServizi(servizi),
        ...(annoSedeId ? { anno_sede_id: annoSedeId, senza_importo: riepilogo?.senzaImporto ?? null, visibile_alle_famiglie: visibileAlleFamiglie } : {}),
      },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/genera-rette:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
