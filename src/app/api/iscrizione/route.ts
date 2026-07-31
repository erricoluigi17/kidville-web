import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { staffScuola } from '@/lib/notifiche/destinatari'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { CONSENSI_FIELDS } from '@/lib/forms/enrollment-template'
import { estraiConsensi, consensiObbligatoriMancanti } from '@/lib/forms/consensi'
import { extractRequestMeta } from '@/lib/fea/signature-log'
import { VERSIONE_PRIVACY } from '@/lib/legal/versioni'
import { validatePage, isProvinceField } from '@/lib/forms/validate-fields'
import {
  extractEnrollmentTemplates,
  STANDARD_ENROLLMENT_MODEL_ID,
} from '@/lib/forms/enrollment-default-schema'
import { normalizzaProvincia } from '@/lib/anagrafiche/province'
import { sediReali } from '@/lib/scuole/reali'
import type {
  EnrollmentSubmissionData,
  FormField,
  FormSchemaConfig,
} from '@/types/database.types'

// Carica i template child/adult del "Modulo d'iscrizione standard" dal DB, così
// la validazione server segue lo schema che la segreteria può aver modificato nel
// builder. FALLBACK ai template in codice (CHILD_FIELDS/ADULT_FIELDS) se il modello
// non è caricabile — è anche ciò che rende pulito il degrado sul DB E2E della CI,
// che il modello standard non ce l'ha (PostgREST ritorna { error }, non lancia).
async function caricaTemplate(
  supabase: SupabaseClient,
): Promise<{ child: FormField[]; adult: FormField[] }> {
  try {
    const { data, error } = await supabase
      .from('form_models')
      .select('schema')
      .eq('id', STANDARD_ENROLLMENT_MODEL_ID)
      .maybeSingle()
    if (error) {
      logEvento('forms', 'info', {
        operazione: 'iscrizione:POST',
        esito: 'fallback_template_codice',
        error_code: error.code,
      }, error)
      return extractEnrollmentTemplates(null)
    }
    return extractEnrollmentTemplates((data?.schema ?? null) as FormSchemaConfig | null)
  } catch (e) {
    logEvento('forms', 'info', {
      operazione: 'iscrizione:POST',
      esito: 'fallback_template_codice',
    }, e)
    return extractEnrollmentTemplates(null)
  }
}

/**
 * Normalizza le province di un record PRIMA della validazione: "Napoli" → "NA",
 * "na" → "NA". Un valore irriconoscibile resta com'è (così `validateField`
 * segnala il pattern) e uno vuoto/facoltativo non viene toccato.
 */
function normalizzaRecord(rec: unknown, fields: FormField[]): Record<string, unknown> {
  const r: Record<string, unknown> =
    rec !== null && typeof rec === 'object' && !Array.isArray(rec)
      ? { ...(rec as Record<string, unknown>) }
      : {}
  for (const f of fields) {
    if (!isProvinceField(f)) continue
    const raw = r[f.id]
    if (raw === null || raw === undefined || String(raw).trim() === '') continue
    const sigla = normalizzaProvincia(raw)
    if (sigla) r[f.id] = sigla
  }
  return r
}

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `data` viene inserito INTERO nella colonna JSONB enrollment_submissions.data:
// .loose() preserva le chiavi extra del wizard. Gli elementi di children/adults
// restano liberi (oggi nessun vincolo sulla loro forma).
// `scuola_id` resta unknown: oggi QUALSIASI valore falsy (assente, '', null, …)
// ricade sul default, gestito nel codice con || come prima.
const postBodySchema = z.object({
  scuola_id: z.unknown().optional(),
  data: z
    .object(
      {
        children: z
          .array(z.unknown(), { error: 'Dati iscrizione non validi' })
          .min(1, 'Inserire almeno un bambino'),
        adults: z
          .array(z.unknown(), { error: 'Dati iscrizione non validi' })
          .min(1, 'Inserire almeno un adulto'),
      },
      { error: 'Dati iscrizione non validi' }
    )
    .loose(),
})

// POST: il genitore invia l'iscrizione dal form pubblico (service-role).
export const POST = withRoute('iscrizione:POST', async (request: NextRequest) => {
  try {
    // Rotta pubblica → rate-limit anti-abuso (5 invii / 10 min per IP).
    const rl = rateLimit(`iscrizione:${clientIp(request)}`, { limit: 5, windowMs: 10 * 60 * 1000 })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Troppe richieste. Riprova tra qualche minuto.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
      )
    }

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { data } = b.data

    const supabase = await createAdminClient()

    // ── Ri-validazione SERVER-SIDE dei campi contro il modello ──────────────
    // Il client valida già, ma il POST è pubblico: qui è l'ultima difesa prima
    // che un dato malformato (es. una provincia per esteso) arrivi al DB e rompa
    // l'import a valle. Normalizza le province, poi valida ogni record.
    const { child: childFields, adult: adultFields } = await caricaTemplate(supabase)
    const campi: {
      children?: Record<string, Record<string, string>>
      adults?: Record<string, Record<string, string>>
    } = {}
    const camposFalliti: string[] = []

    const normalizza = (
      lista: unknown,
      fields: FormField[],
      gruppo: 'children' | 'adults',
    ): Record<string, unknown>[] => {
      const arr = Array.isArray(lista) ? lista : []
      return arr.map((rec, i) => {
        const r = normalizzaRecord(rec, fields)
        const errs = validatePage(fields, r)
        if (Object.keys(errs).length > 0) {
          ;(campi[gruppo] ??= {})[String(i)] = errs
          for (const idCampo of Object.keys(errs)) camposFalliti.push(`${gruppo}.${i}.${idCampo}`)
        }
        return r
      })
    }

    const children = normalizza(data.children, childFields, 'children')
    const adults = normalizza(data.adults, adultFields, 'adults')

    if (camposFalliti.length > 0) {
      // warn: la difesa ha funzionato ma qualcosa è passato dal client malformato
      // (bug del client o invio fuori dal wizard). Solo id campo e indice nel log —
      // MAI i valori: sono dati di minori. Il path finisce in `messaggio` (non PII).
      logEvento('iscrizione', 'warn', {
        operazione: 'iscrizione:POST',
        esito: 'campi-non-validi',
        msg: `Iscrizione respinta: ${camposFalliti.join(', ')}`,
        n: camposFalliti.length,
      })
      return NextResponse.json(
        { error: 'Alcuni campi non sono validi. Controlla i dati e riprova.', campi },
        { status: 400 },
      )
    }

    // ── Consensi ────────────────────────────────────────────────────────────
    // Il modulo raccoglie allergie, note mediche e il documento d'identità del
    // minore: l'informativa al punto di raccolta (art. 13) e la prova che sia
    // stata data non sono un accessorio, sono la condizione per raccoglierli.
    //
    // La verifica è QUI e non solo nel wizard: il wizard è codice del client, e
    // un invio fatto fuori dal wizard non lo esegue. Un consenso obbligatorio
    // non spuntato è un 400, esattamente come un campo non valido.
    //
    // NB: fra i consensi obbligatori NON c'è nessuna spunta sui dati sanitari —
    // per quelli la base giuridica non è il consenso. Vedi CONSENSI_FIELDS.
    const paginaConsensi = [{ id: 'consensi', title: 'Consensi', fields: CONSENSI_FIELDS }]
    const consensiMancanti = consensiObbligatoriMancanti(
      paginaConsensi,
      data as Record<string, unknown>,
    )
    if (consensiMancanti.length > 0) {
      logEvento('iscrizione', 'warn', {
        operazione: 'iscrizione:POST',
        esito: 'consensi-obbligatori-mancanti',
        msg: `Consensi mancanti: ${consensiMancanti.join(', ')}`,
        n: consensiMancanti.length,
      })
      return NextResponse.json(
        {
          error: 'Per proseguire è necessario dichiarare di aver letto l\'informativa sulla privacy.',
          consensi: consensiMancanti,
        },
        { status: 400 },
      )
    }

    // Snapshot probatorio: id, etichetta, TESTO MOSTRATO, esito e istante di
    // ciascun blocco. Il testo si congela dentro la riga perché la prova deve
    // dire *cosa* è stato accettato, non solo *che* qualcosa è stato accettato:
    // se domani il modulo cambia, le accettazioni di ieri restano leggibili.
    // `versione` viene dalla costante server-side, MAI dal client: un client
    // datato o manomesso potrebbe dichiarare una versione arbitraria, e la prova
    // varrebbe zero.
    const accettatoIl = new Date().toISOString()
    const consentsLog = {
      versione_informativa: VERSIONE_PRIVACY,
      accettato_il: accettatoIl,
      ...extractRequestMeta(request),
      blocchi: estraiConsensi(paginaConsensi, data as Record<string, unknown>, accettatoIl),
    }

    // Salva i dati NORMALIZZATI (province già ridotte a sigla).
    const dataNormalizzata = { ...(data as Record<string, unknown>), children, adults }

    // Scuola dell'iscrizione: dalla scelta del genitore nel wizard (o dal link
    // ?scuola=) se indicata e valida; altrimenti la scuola REALE del deployment.
    // La scuola di test E2E (id e2e00000…) è esclusa dalla risoluzione automatica,
    // così in prod (E2E + reale) si sceglie sempre quella reale.
    //
    // Il predicato "scuola reale" sta in `@/lib/scuole/reali`, condiviso con
    // `GET /api/iscrizione/sedi` che alimenta il selettore del wizard: se i due
    // divergessero, il genitore sceglierebbe una sede che questo POST rifiuta.
    //
    // Con più scuole reali e nessuna indicata → 400, e DEVE restare così: è
    // l'ultima difesa per chi invia fuori dal wizard. Un default silenzioso
    // manderebbe l'iscrizione nel plesso sbagliato, che è peggio di un errore.
    const { tutte, reali } = await sediReali(supabase, 'iscrizione:POST')
    const richiesta = (b.data.scuola_id as string | undefined) || undefined
    let scuolaId: string | undefined
    // La validazione della sede richiesta usa `tutte` (E2E incluse): i test E2E
    // inviano proprio con l'id della sede di prova.
    if (richiesta && tutte.some((s) => s.id === richiesta)) {
      scuolaId = richiesta
    } else if (reali.length === 1) {
      scuolaId = reali[0].id
    } else if (tutte.length === 1) {
      scuolaId = tutte[0].id
    }
    if (!scuolaId) {
      return NextResponse.json({ error: 'Specificare la scuola per l\'iscrizione' }, { status: 400 })
    }

    const { data: row, error } = await supabase
      .from('enrollment_submissions')
      .insert({
        scuola_id: scuolaId,
        data: dataNormalizzata as EnrollmentSubmissionData,
        status: 'pending',
        consents_log: consentsLog,
      })
      .select('id')
      .single()

    if (error) {
      // Colonna assente sul DB E2E non migrato: si RIPROVA senza la prova, ma
      // NON in silenzio. Un'iscrizione persa perché manca una colonna sarebbe
      // peggio; una prova non registrata senza che nessuno lo sappia, pure.
      if (['PGRST204', '42703'].includes((error as { code?: string }).code ?? '')) {
        logEvento('iscrizione', 'warn', {
          operazione: 'iscrizione:POST',
          esito: 'consensi-non-registrati-colonna-assente',
        })
        const retry = await supabase
          .from('enrollment_submissions')
          .insert({
            scuola_id: scuolaId,
            data: dataNormalizzata as EnrollmentSubmissionData,
            status: 'pending',
          })
          .select('id')
          .single()
        if (retry.error) {
          return NextResponse.json({ error: retry.error.message }, { status: 500 })
        }
        return NextResponse.json({ id: retry.data.id }, { status: 201 })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Notifica alla segreteria: nuova domanda dal form pubblico (best-effort).
    try {
      const destinatari = await staffScuola(supabase, scuolaId, ['admin', 'coordinator', 'segreteria'])
      await notificaEvento(supabase, {
        tipo: 'iscrizione_ricevuta',
        scuolaId,
        utenteIds: destinatari,
        titolo: 'Nuova domanda di iscrizione',
        corpo: 'È arrivata una nuova pre-iscrizione dal form pubblico.',
        link: '/admin/iscrizioni',
        entitaTipo: 'iscrizione',
        entitaId: row.id,
        bufferMin: 0,
      })
    } catch (e) {
      // `error` benché la domanda sia registrata (201): la segreteria non viene avvisata, e una
      // pre-iscrizione che nessuno sa di aver ricevuto è una famiglia che resta senza risposta.
      // La riga c'è, il suo annuncio è perso: scrittura persa, non dettaglio saltato.
      logEvento('notifica', 'error', {
        operazione: 'iscrizione:POST',
        esito: 'notifica-segreteria-non-accodata',
      }, e)
    }

    return NextResponse.json({ id: row.id }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'iscrizione:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg || 'Errore interno' }, { status: 500 })
  }
})
