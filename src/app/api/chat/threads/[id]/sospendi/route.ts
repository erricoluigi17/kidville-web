import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { notificaEvento } from '@/lib/notifiche/triggers'
// `scuolaUnicaReale` NON si importa più: era l'ultimo anello della vecchia
// catena, è deprecata (con tre sedi risponde sempre `null`) e un import che
// nessuno usa fa uscire `eslint --max-warnings 0` con 1.
import { staffScuola } from '@/lib/notifiche/destinatari'
import { sedeDiAlunno, sedeDiAccount } from '@/lib/anagrafiche/sedi'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { schemaAssente } from '@/lib/news/schema-assente'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// POST /api/chat/threads/[id]/sospendi (C5 §2 — decisione titolare B)
//
// Sospende una conversazione 1:1 (chat scuola↔famiglia). Il "blocco" richiesto
// dalla UGC policy di Google è DICHIARATO, non silenzioso: l'altra parte vedrà
// "conversazione sospesa" e la Direzione viene notificata e può mediare.
//
// Storico APPEND-ONLY (conversazioni_sospensioni): la riapertura è un UPDATE dei
// soli campi riaperta_* (vedi /riapri), mai un DELETE. Una sola sospensione
// ATTIVA per thread (indice parziale WHERE riaperta_il IS NULL) → il doppione
// diventa 409.
//
// PRIVACY (criterio 6): il `motivo` (testo libero) NON entra MAI nei log né nel
// corpo della notifica. Nei log solo uuid (threadId).
// =============================================================================

interface RouteParams {
  params: Promise<{ id: string }>
}

const DIREZIONE = ['admin', 'coordinator'] as const
const postBodySchema = z.object({ motivo: z.string().max(1000).optional() })

const OP = 'chat/threads/[id]/sospendi:POST'

export const POST = withRoute('chat/threads/[id]/sospendi:POST', async (request: Request, { params }: RouteParams) => {
  const auth = await requireUser(request)
  if (auth.response) return auth.response
  const uid = auth.user.id

  const p = parseData(zUuid, (await params).id)
  if ('response' in p) return p.response
  const threadId = p.data

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const { motivo } = b.data

  try {
    const supabase = await createAdminClient()

    // 1) Thread + verifica che il chiamante ne sia partecipante.
    const { data: thread, error: threadErr } = await supabase
      .from('chat_threads')
      .select('teacher_id, parent_id, student_id')
      .eq('id', threadId)
      .maybeSingle()
    if (threadErr) {
      logErrore({ operazione: OP, stato: 500, evento: 'db' }, threadErr)
      return NextResponse.json({ error: threadErr.message }, { status: 500 })
    }
    if (!thread) return NextResponse.json({ error: 'Conversazione non trovata' }, { status: 404 })
    if (thread.teacher_id !== uid && thread.parent_id !== uid) {
      logEvento('chat', 'info', { operazione: OP, esito: 'non-partecipante', threadId })
      return NextResponse.json({ error: 'Non sei un partecipante di questa conversazione' }, { status: 403 })
    }
    const altro = (thread.teacher_id === uid ? thread.parent_id : thread.teacher_id) as string

    // 2) Sospensione già ATTIVA su questo thread → 409 (indice parziale unico).
    const { data: attiva, error: attivaErr } = await supabase
      .from('conversazioni_sospensioni')
      .select('id')
      .eq('thread_id', threadId)
      .is('riaperta_il', null)
      .maybeSingle()
    if (attivaErr && !schemaAssente(attivaErr)) {
      logErrore({ operazione: OP, stato: 500, evento: 'db' }, attivaErr)
      return NextResponse.json({ error: attivaErr.message }, { status: 500 })
    }
    if (attiva) return NextResponse.json({ error: 'Conversazione già sospesa' }, { status: 409 })

    // ── 3) LA SEDE È QUELLA DEL BAMBINO DEL THREAD, NON QUELLA DI CHI PREME ──
    //
    // Fino al 2026-09-03 l'ordine era rovesciato:
    //   `auth.user.scuola_id ?? sede del bambino ?? scuolaUnicaReale(…)`
    // cioè la sede dell'ACCOUNT per prima e il bambino solo come ripiego. Ma un
    // genitore può avere due figli in due plessi — `parents` non ha `scuola_id`,
    // ed è una scelta esplicita (vedi `admin/parents/route.ts`) — quindi
    // `utenti.scuola_id` di un genitore è al più UNA delle sue sedi: quella con
    // cui l'account è nato. Sospendendo la conversazione col docente dell'ALTRO
    // figlio, la riga nasceva nel plesso sbagliato e la notifica «Conversazione
    // sospesa» andava a una Direzione che su quel thread non ha titolo, mentre
    // quella competente non sapeva niente. Lo stesso vale per un docente che
    // lavora su più plessi.
    //
    // Il bambino del thread NON è ambiguo: una conversazione parla sempre di UN
    // bambino, e quel bambino ha UN plesso. È il dato che ce l'ha davvero.
    //
    // Ripiego dichiarato: la sede dell'account del DOCENTE del thread — lo staff
    // una sede propria ce l'ha sempre, i genitori no. `scuolaUnicaReale` è
    // DEPRECATA (con tre sedi risponde sempre `null`): non ripiega più, e
    // interrogarla costava una query e una riga di `warn` per un anello morto.
    //
    // Le due letture stanno in `@/lib/anagrafiche/sedi`: erano scritte identiche
    // in quattro punti (qui, `chat/messages`, `parent/onboarding`,
    // `parent/submissions`), e in questo repo una regola valida per più strade
    // vive in un posto solo. Lì dentro c'è anche il controllo di `{ error }` —
    // PostgREST non lancia — e la riga di log che distingue «non ha un plesso»
    // da «non ho potuto leggerlo».
    const ctxSede = { gruppo: 'chat', operazione: OP, extra: { threadId } }
    let scuolaId: string | null = null
    if (thread.student_id) {
      scuolaId = await sedeDiAlunno(supabase, thread.student_id, ctxSede)
    }
    if (!scuolaId && thread.teacher_id) {
      scuolaId = await sedeDiAccount(supabase, thread.teacher_id, ctxSede)
    }
    if (!scuolaId) {
      // La sospensione si scrive LO STESSO — bloccarla perché manca un plesso
      // significherebbe lasciare due persone dentro una conversazione che una
      // delle due ha chiesto di fermare, ed è una tutela, non un adempimento.
      // Ma `staffScuola(null)` non avviserà nessuna Direzione: senza questa riga
      // «nessuno ha moderato» e «nessuno è stato avvisato» sarebbero
      // indistinguibili. `error` perché è l'anagrafica nostra a essere monca.
      logEvento('chat', 'error', {
        operazione: OP,
        esito: 'sede-non-attribuibile',
        threadId,
      })
    }

    // 4) INSERT della sospensione (append-only). PostgREST NON lancia: si legge
    //    il valore di ritorno.
    const { data: ins, error: insErr } = await supabase
      .from('conversazioni_sospensioni')
      .insert({
        thread_id: threadId,
        sospesa_da: uid,
        sospesa_verso: altro,
        motivo: motivo ?? null,
        scuola_id: scuolaId,
      })
      .select('id')
      .maybeSingle()
    if (insErr) {
      // Race: un secondo INSERT su un thread già sospeso viola l'indice unico.
      if (insErr.code === '23505') return NextResponse.json({ error: 'Conversazione già sospesa' }, { status: 409 })
      // DB E2E CI non migrato (tabella assente): degrada pulito, niente 500.
      if (schemaAssente(insErr)) return NextResponse.json({ error: 'Servizio temporaneamente non disponibile' }, { status: 503 })
      logErrore({ operazione: OP, stato: 500, evento: 'db' }, insErr)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }
    const sospensioneId = (ins?.id as string) ?? null

    // 5) Notifica la Direzione (best-effort). Corpo GENERICO: mai il motivo.
    try {
      const destinatari = await staffScuola(supabase, scuolaId, [...DIREZIONE])
      await notificaEvento(supabase, {
        tipo: 'conversazione_sospesa',
        scuolaId,
        utenteIds: destinatari,
        titolo: 'Conversazione sospesa',
        corpo: 'Una conversazione in chat è stata sospesa. Gestiscila dal pannello Moderazione.',
        link: '/admin/moderazione',
        entitaTipo: 'conversazione_sospensione',
        entitaId: sospensioneId,
        bufferMin: 0,
      })
    } catch (e) {
      logEvento('notifica', 'error', {
        operazione: OP,
        tipo: 'conversazione_sospesa',
        esito: 'notifica-non-accodata',
      }, e)
    }

    // Evento critico → si logga anche il SUCCESSO (solo uuid, MAI il motivo).
    logEvento('chat', 'info', { operazione: OP, esito: 'conversazione-sospesa', threadId })

    return NextResponse.json({ ok: true, id: sospensioneId }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})
