import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { estraiConsensi, consensiObbligatoriMancanti } from '@/lib/forms/consensi'
import { accessoConsentito } from '@/lib/forms/publish'
import { colonnaSedeAssente } from '@/lib/forms/degrado-sede'
import { risolviSedeCompilazione } from '@/lib/forms/sede-compilazione'
import { tokenPubblico, rispostaModuloNonTrovato } from '@/lib/forms/token-pubblico'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import type { FormSchemaConfig, FormSubmissionData } from '@/types/database.types'

// Submission ANONIMA di un modello pubblicato (DL-030). Token-scoped, service-role.
// Solo `completed` (la firma OTP pubblica è materia della slice firma congiunta).

// IL TOKEN È UN UUID, e per due anni un commento qui sopra ha detto il contrario
// («una stringa opaca … non un uuid»), con sotto uno `z.string().min(1)` che lasciava
// passare qualunque cosa. `form_models.public_token` è dichiarata `uuid` nella baseline e
// la valorizza `randomUUID()`: un token storto arrivava fino alla query e Postgres
// rispondeva `22P02`, che questa route leggeva come un guasto proprio → 500 a un anonimo
// (collaudo del 2026-08-02, F2). La regola sta ora in `@/lib/forms/token-pubblico`, con la
// route gemella `upload`, e risponde 404 — indistinguibile da «token inesistente».

// `data` è il payload libero della submission: oggi è accettato qualsiasi valore
// truthy (il codice controllava solo `!data`), quindi resta volutamente permissivo.
const postBodySchema = z.object({
  data: z.unknown().refine((v) => Boolean(v), { message: 'data obbligatorio' }),
})

/** Il modello dietro al token. `scuola_id` è OPZIONALE: sul DB E2E della CI, non
 *  migrato, la colonna non esiste e la chiave arriva ASSENTE — condizione
 *  diversa da «presente e vuota», che significa invece modello globale. */
interface ModelloPubblico {
  id: string
  published_at: string | null
  access_mode: string | null
  schema?: unknown
  scuola_id?: string | null
}

export const POST = withRoute('public/forms/[token]/submit:POST', async (
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) => {
  const rl = rateLimit(`public-submit:${clientIp(request)}`, { limit: 20, windowMs: 10 * 60 * 1000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Troppe richieste. Riprova tra qualche minuto.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
    )
  }

  try {
    const rawParams = await params
    // PRIMA di qualunque query: la colonna è di tipo `uuid`, e ciò che non ne ha la forma
    // non fa «zero righe», fa esplodere il parser di Postgres.
    const tk = tokenPubblico(rawParams.token)
    if ('response' in tk) return tk.response
    const token = tk.token

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const data = b.data.data as FormSubmissionData

    const supabase = await createAdminClient()
    // Sul DB E2E della CI, non migrato, `scuola_id` non esiste ancora: senza il
    // secondo tentativo la SELECT fallirebbe intera e OGNI modulo pubblico
    // risponderebbe «non trovato».
    // Due `select()` distinti e non un ternario dentro `select()`: il client
    // Supabase tipizza quella stringa come LETTERALE e su un'unione risponde con
    // un `ParserError` al posto del tipo della riga.
    const carica = async (conSede: boolean) => {
      const res = conSede
        ? await supabase.from('form_models')
            .select('id, published_at, access_mode, schema, scuola_id').eq('public_token', token).maybeSingle()
        : await supabase.from('form_models')
            .select('id, published_at, access_mode, schema').eq('public_token', token).maybeSingle()
      return { data: res.data as ModelloPubblico | null, error: res.error }
    }
    let modelRes = await carica(true)
    if (colonnaSedeAssente(modelRes.error)) modelRes = await carica(false)
    if (modelRes.error) {
      // PostgREST non lancia: senza questo controllo un guasto di lettura
      // diventerebbe un 404 muto, indistinguibile da «token inesistente».
      logEvento('modulistica', 'error', {
        operazione: 'public/forms/[token]/submit:POST', esito: 'modello-non-letto',
      }, modelRes.error)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }
    const model = modelRes.data

    // Stessa risposta del token malformato, alla virgola: se i tre casi — forma sbagliata,
    // modello inesistente, modello non pubblicato — divergessero anche solo nel testo, la
    // differenza tornerebbe misurabile da fuori.
    if (!model || !model.published_at) return rispostaModuloNonTrovato()
    // L'accesso pubblico anonimo è consentito solo in modalità `public`.
    if (!accessoConsentito(model, false)) {
      return NextResponse.json({ error: 'Accesso riservato agli utenti registrati' }, { status: 403 })
    }

    const pages = ((model.schema as FormSchemaConfig | undefined)?.pages) ?? []
    const mancanti = consensiObbligatoriMancanti(pages, data as Record<string, unknown>)
    if (mancanti.length > 0) {
      return NextResponse.json(
        { error: 'Consensi obbligatori non accettati', missing: mancanti },
        { status: 400 }
      )
    }

    const consents_log = estraiConsensi(pages, data as Record<string, unknown>, new Date().toISOString())
    // Invio anonimo da link pubblico: l'unica sede conoscibile è quella dichiarata
    // sul MODELLO — chi apre il link non ha nessun altro dato da cui dedurla.
    //
    // Il commento che stava qui diceva che senza sede «la riga è visibile alla
    // sola Direzione, che è la risposta onesta». Era falso, ed è il genere di
    // commento che ferma un'indagine: i lettori filtrano con
    // `.in('scuola_id', plessi)` e `NULL IN (…)` in SQL vale NULL, quindi quella
    // compilazione non compariva a nessuno. Se il modello non dichiara la sede e
    // le sedi reali sono più d'una, l'invio si rifiuta: va dichiarata sul
    // modello prima di pubblicarlo.
    const sede = await risolviSedeCompilazione(
      supabase,
      [(model as { scuola_id?: string | null }).scuola_id],
      'public/forms/[token]/submit:POST',
    )
    if (sede.ambigua) {
      return NextResponse.json(
        { error: 'Modulo non disponibile: la sede non è indicata sul modello' },
        { status: 400 }
      )
    }
    const rigaInvio: Record<string, unknown> = {
      model_id: model.id,
      user_id: null,
      data,
      status: 'completed',
      consents_log: consents_log.length > 0 ? consents_log : null,
      scuola_id: sede.scuolaId,
    }
    let insRes = await supabase.from('form_submissions').insert(rigaInvio).select('id').single()
    if (insRes.error && ['PGRST204', '42703'].includes((insRes.error as { code?: string }).code ?? '')) {
      // DB E2E della CI non migrato: una sede sola, nessun isolamento da riaprire.
      logEvento('modulistica', 'info', {
        operazione: 'public/forms/[token]/submit:POST', esito: 'colonna-sede-assente-degrado',
      })
      delete rigaInvio.scuola_id
      insRes = await supabase.from('form_submissions').insert(rigaInvio).select('id').single()
    }
    const { data: submission, error } = insRes

    if (error || !submission) {
      // PostgREST ritorna un oggetto, non un `Error`: il ramo qui sotto scartava
      // il messaggio E non lo scriveva da nessuna parte. Un invio perso senza
      // traccia è esattamente il guasto che l'osservabilità deve impedire.
      logEvento('modulistica', 'error', {
        operazione: 'public/forms/[token]/submit:POST', esito: 'compilazione-non-registrata',
      }, error)
      return NextResponse.json({ error: 'Invio fallito' }, { status: 500 })
    }
    // Successo loggato: il modulo pubblico è l'unico canale in cui nessuno,
    // dall'altra parte, si accorge che una compilazione non è mai arrivata.
    logEvento('modulistica', 'info', {
      operazione: 'public/forms/[token]/submit:POST', esito: 'compilazione-registrata',
      entita_id: submission.id, sede: sede.scuolaId,
    })
    return NextResponse.json({ id: submission.id }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'public/forms/[token]/submit:POST', stato: 500 }, err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
})
