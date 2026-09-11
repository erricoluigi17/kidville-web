import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { assertFatturaInScope } from '@/lib/pagamenti/scope-fattura'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// GET /api/pagamenti/fattura/list?pagamento_id=  — elenco delle fatture (quote)
// emesse per un pagamento. Usato dalla UI quando un pagamento ha PIÙ fatture
// (genitori separati) per offrire un download per intestatario.
//
// Accesso: la FAMIGLIA del bambino (per legame, non per sede: due fratelli
// possono stare in due plessi) oppure la contabilità del plesso. Lo decide
// `assertFatturaInScope`, che ha assorbito sia il vecchio `assertPagamentoInScope`
// applicato a tutti — quello che dava 403 al genitore multi-sede — sia il blocco
// `isStaff`/`genitoreHasFiglio` scritto a mano qui dentro.

const getQuerySchema = z.object({ pagamento_id: zUuid })

/**
 * Codici PostgREST che significano «questo schema qui non c'è», non «è andata
 * storta una lettura»: il DB E2E della CI non è migrato, e lì `fatture_emesse`
 * può non esistere affatto.
 *  42P01 tabella assente · 42703 colonna assente (SELECT) · PGRST204 colonna
 *  assente (INSERT/UPDATE) · PGRST205 tabella non in cache.
 */
const SCHEMA_ASSENTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205'])

/**
 * 500 — una lettura di PostgREST non è riuscita. `LETTURA_FALLITA` è già
 * dichiarato e tradotto: la sua frase («Non siamo riusciti a leggere i dati.
 * Riprova fra poco.») dice esattamente questo, in entrambe le lingue.
 */
const CODICE_LETTURA_FALLITA = 'LETTURA_FALLITA'

/**
 * 404 — la riga di `pagamenti` non c'è.
 *
 * ⚠️ La frase resta «Pagamento non trovato», che è anche la frase scritta a mano
 * in altri punti di `src/app/api/pagamenti/**` rimasti senza codice: il lock
 * `errori-con-codice` confronta le frasi del CATALOGO con i corpi SENZA codice,
 * quindi la voce i18n di `PAGAMENTO_NON_TROVATO` dev'essere una frase sua e non
 * questa — altrimenti renderebbe rossi quei punti, che questo lavoro non tocca.
 * Stessa ragione già scritta accanto a `PAGAMENTO_INESISTENTE`.
 */
const CODICE_PAGAMENTO_NON_TROVATO = 'PAGAMENTO_NON_TROVATO'

interface RigaFattura {
  id: string
  numero: number
  anno: number
  quota_label: string | null
  quota_adult_id: string | null
  intestatario: { nome?: string; cognome?: string } | null
  pdf_path: string | null
  sdi_stato: number | null
  sdi_stato_label: string | null
}

/**
 * I nomi degli oggetti che il bucket `fatture` ha DAVVERO per questo pagamento,
 * oppure `null` se l'elenco non è interrogabile.
 *
 * ─── PERCHÉ NON BASTA LA COLONNA ───────────────────────────────────────────
 *
 * `pdf_disponibile` valeva `!!r.pdf_path`, cioè si fidava di una colonna scritta
 * da un'altra rotta (`fattura/sync`) in un altro momento. Se l'upload nel bucket
 * fallisce dopo che la riga è stata scritta — o se qualcuno ripulisce lo Storage
 * — la colonna continua a dire «sì» e il pulsante «Scarica» porta a un 404. Il
 * dato che conta è nel bucket, e si guarda nel bucket.
 *
 * ─── UNA SOLA CHIAMATA, E PERCHÉ UN PREFISSO BASTA ─────────────────────────
 *
 * Le chiavi hanno la forma `<pagamento_id>-<numero>.pdf` e stanno in RADICE
 * (`fattura/sync` le scrive così): un `search` sul solo `pagamento_id` le copre
 * tutte, quante che siano le quote. Una `list` per riga sarebbe N chiamate allo
 * Storage per disegnare un elenco che ne ha bisogno di una.
 *
 * ─── FAIL-CLOSED ───────────────────────────────────────────────────────────
 *
 * Se l'elenco non si può leggere si risponde `null`, e il chiamante mette tutti
 * i `pdf_disponibile` a `false`. Meglio nessun pulsante che un pulsante che dà
 * 404: il primo si spiega da sé («il documento non è ancora pronto»), il secondo
 * fa telefonare in segreteria.
 */
async function nomiNelBucket(
  supabase: SupabaseClient,
  pagamentoId: string,
): Promise<Set<string> | null> {
  try {
    const { data, error } = await supabase.storage
      .from('fatture')
      .list('', { limit: 100, search: pagamentoId })
    // `supabase-storage-js` NON lancia: ritorna `{ data, error }`. Livello
    // `error` perché la conseguenza si vede a schermo — spariscono dei pulsanti
    // di download che dovrebbero esserci.
    if (error || !data) {
      logEvento('storage', 'error', {
        operazione: 'pagamenti/fattura/list:GET',
        bucket: 'fatture',
        esito: 'elenco-non-interrogabile',
        pagamento_id: pagamentoId,
      }, error ?? undefined)
      return null
    }
    return new Set(data.map((o) => String((o as { name?: unknown }).name ?? '')))
  } catch (e) {
    logEvento('storage', 'error', {
      operazione: 'pagamenti/fattura/list:GET',
      bucket: 'fatture',
      esito: 'elenco-non-interrogabile',
      pagamento_id: pagamentoId,
    }, e)
    return null
  }
}

export const GET = withRoute('pagamenti/fattura/list:GET', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { pagamento_id } = q.data

    const supabase = await createAdminClient()

    // La riga si legge PRIMA del gate: al gate serve `alunno_id`, perché per la
    // famiglia il perimetro è il LEGAME col bambino e non il plesso.
    const { data: pag, error: errPag } = await supabase
      .from('pagamenti')
      .select('id, alunno_id')
      .eq('id', pagamento_id)
      .maybeSingle()
    // PostgREST non lancia: senza questo controllo un guasto di lettura sarebbe
    // uscito come «Pagamento non trovato», cioè un'affermazione su un dato che
    // non si è letto.
    if (errPag) {
      logErrore({ operazione: 'pagamenti/fattura/list:GET', stato: 500, evento: 'db' }, errPag)
      return NextResponse.json(
        { error: 'Lettura del pagamento non riuscita', codice: CODICE_LETTURA_FALLITA },
        { status: 500 },
      )
    }
    if (!pag) {
      return NextResponse.json(
        { error: 'Pagamento non trovato', codice: CODICE_PAGAMENTO_NON_TROVATO },
        { status: 404 },
      )
    }

    const fuoriScope = await assertFatturaInScope(supabase, auth.user, pagamento_id, pag.alunno_id as string | null)
    if (fuoriScope) return fuoriScope

    const { data, error } = await supabase
      .from('fatture_emesse')
      .select('id, numero, anno, quota_label, quota_adult_id, intestatario, pdf_path, sdi_stato, sdi_stato_label')
      .eq('pagamento_id', pagamento_id)
      .order('numero', { ascending: true })
    if (error) {
      // ─── LA PROSA DI POSTGREST NON ARRIVA A UNA SCHERMATA DI FAMIGLIA ─────
      //
      // Qui c'era `{ error: error.message }`: davanti a un genitore finiva il
      // messaggio inglese del database, col nome di una colonna dentro. È lo
      // stesso difetto che il 2026-09-05 ha messo davanti alla segreteria di Cesa
      // «there is no unique or exclusion constraint matching the ON CONFLICT
      // specification», nove volte di fila.
      const codice = (error as { code?: string }).code ?? ''
      if (SCHEMA_ASSENTE.has(codice)) {
        // Non è un guasto: è il DB E2E della CI, che non è migrato. Elenco vuoto
        // e una riga `info` per dirlo — il canale `db` è in deroga dichiarata
        // (`DEROGHE_INFO_NON_PERSISTITI`) proprio per questi degradi di schema.
        logEvento('db', 'info', {
          operazione: 'pagamenti/fattura/list:GET',
          esito: 'registro-fatture-assente',
          entita_tipo: 'fatture_emesse',
          error_code: codice,
        }, error)
        return NextResponse.json({ success: true, data: [] })
      }
      logEvento('db', 'error', {
        operazione: 'pagamenti/fattura/list:GET',
        esito: 'registro-fatture-non-letto',
        entita_tipo: 'fatture_emesse',
        error_code: codice || null,
      }, error)
      return NextResponse.json(
        { error: 'Elenco delle fatture non disponibile', codice: CODICE_LETTURA_FALLITA },
        { status: 500 },
      )
    }

    // Una riga per quota: tengo la più recente (numero massimo), così una quota
    // scartata e poi ri-emessa non compare due volte.
    const perQuota = new Map<string, RigaFattura>()
    for (const r of (data ?? []) as RigaFattura[]) {
      const key = r.quota_adult_id ?? '__single__'
      const cur = perQuota.get(key)
      if (!cur || r.numero >= cur.numero) perQuota.set(key, r)
    }

    const scelte = [...perQuota.values()].sort((a, b) => a.numero - b.numero)

    // Lo Storage si interroga UNA volta sola, e solo se c'è almeno una chiave da
    // verificare: quando nessuna riga ha `pdf_path` la risposta è già nota (tutti
    // `false`) e una chiamata al bucket sarebbe pagata per niente.
    const daVerificare = scelte.some((r) => Boolean(r.pdf_path))
    const presenti = daVerificare ? await nomiNelBucket(supabase, pagamento_id) : new Set<string>()

    const fatture = scelte.map((r) => {
      const intest = r.intestatario ?? {}
      const nome = `${intest.nome ?? ''} ${intest.cognome ?? ''}`.trim()
      return {
        id: r.id,
        numero: r.numero,
        anno: r.anno,
        quota_label: r.quota_label,
        intestatario: nome || r.quota_label || 'Intestatario',
        // La colonna dice DOVE cercare, il bucket dice se c'è: servono entrambi.
        pdf_disponibile: Boolean(r.pdf_path) && presenti !== null && presenti.has(r.pdf_path as string),
        sdi_stato_label: r.sdi_stato_label,
      }
    })

    return NextResponse.json({ success: true, data: fatture })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/fattura/list:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
