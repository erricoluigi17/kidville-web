import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser, type AppUser } from '@/lib/auth/require-staff'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { staffScuola, scuolaUnicaReale } from '@/lib/notifiche/destinatari'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { schemaAssente } from '@/lib/news/schema-assente'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// Segnalazioni UGC (C5 §2): un utente segnala un contenuto (messaggio chat, media
// galleria, voce diario) o un altro utente. Log di audit interno alla Direzione.
//
// REGOLA DI SICUREZZA: il `segnalante_id` è SEMPRE quello del gate, mai del body.
// Prima di inserire si verifica che il segnalante abbia davvero un rapporto reale
// con l'oggetto segnalato (partecipante del thread / genitore del bambino / media
// visibile / contatto legittimo) — un intruso non può creare rumore su contenuti
// che non potrebbe nemmeno vedere. Il `motivo` (testo libero) non finisce MAI nei
// log né nel corpo della notifica: sono dati di minori.
// =============================================================================

const DIREZIONE = ['admin', 'coordinator'] as const

const postBodySchema = z.object({
  tipo_oggetto: z.enum(['messaggio_chat', 'media_galleria', 'voce_diario', 'utente']),
  oggetto_id: zUuid.optional(),
  segnalato_id: zUuid.optional(),
  thread_id: zUuid.optional(),
  categoria: z.enum(['contenuto_inappropriato', 'molestie_bullismo', 'informazione_falsa', 'spam', 'altro']),
  // Testo libero opzionale — MAI in chiaro nei log né nella notifica.
  motivo: z.string().max(1000).optional(),
})

type TipoOggetto = z.infer<typeof postBodySchema>['tipo_oggetto']

interface EsitoAccesso {
  ok: boolean
  /** Thread derivato server-side (solo messaggio_chat) per aprire la conversazione da Direzione. */
  threadId?: string | null
  /** Sede denormalizzata per l'indice della coda triage. */
  scuolaId?: string | null
}

/** Alunni di cui il genitore è tutore (id distinti). */
async function figliDi(supabase: SupabaseClient, genitoreId: string): Promise<string[]> {
  const { data } = await supabase
    .from('legame_genitori_alunni')
    .select('alunno_id')
    .eq('genitore_id', genitoreId)
  return [...new Set((data ?? []).map((l) => l.alunno_id as string).filter(Boolean))]
}

/**
 * Contatto legittimo (stesso criterio di `chat/contacts`): esiste un thread condiviso
 * tra i due, OPPURE il segnalato è il docente di una sezione di un figlio del genitore
 * (o viceversa). Nessun genitore↔genitore, nessun docente↔docente: il grafo passa
 * sempre per la relazione genitore↔docente↔sezione.
 */
async function contattoLegittimo(
  supabase: SupabaseClient,
  segnalante: AppUser,
  segnalatoId: string,
): Promise<boolean> {
  const uid = segnalante.id

  // 1. Thread di chat già esistente in una delle due direzioni.
  const { data: threads } = await supabase
    .from('chat_threads')
    .select('id')
    .or(
      `and(teacher_id.eq.${uid},parent_id.eq.${segnalatoId}),and(teacher_id.eq.${segnalatoId},parent_id.eq.${uid})`,
    )
  if ((threads ?? []).length > 0) return true

  // 2. Relazione per sezione: chi è il genitore e chi il docente dipende dal ruolo.
  const parentId = segnalante.role === 'genitore' ? uid : segnalatoId
  const teacherId = segnalante.role === 'genitore' ? segnalatoId : uid

  const figli = await figliDi(supabase, parentId)
  if (figli.length === 0) return false

  const { data: alunni } = await supabase.from('alunni').select('section_id').in('id', figli)
  const sezioniFigli = new Set((alunni ?? []).map((a) => a.section_id as string).filter(Boolean))
  if (sezioniFigli.size === 0) return false

  const { data: sezioniDocente } = await supabase
    .from('utenti_sezioni')
    .select('section_id')
    .eq('utente_id', teacherId)
  return (sezioniDocente ?? []).some((r) => sezioniFigli.has(r.section_id as string))
}

/**
 * Verifica il rapporto legittimo tra segnalante e oggetto segnalato PRIMA di inserire.
 * `ok:false` → 403. Per lo staff/docente la visibilità dei contenuti è di supervisione
 * (accesso ampio, come nelle route di lettura corrispondenti); per il genitore vale il
 * medesimo criterio di visibilità già applicato in galleria/diario/chat.
 */
async function verificaAccesso(
  supabase: SupabaseClient,
  segnalante: AppUser,
  tipo: TipoOggetto,
  oggettoId: string | undefined,
  segnalatoId: string | undefined,
): Promise<EsitoAccesso> {
  const uid = segnalante.id
  const isGenitore = segnalante.role === 'genitore'

  if (tipo === 'messaggio_chat') {
    const { data: msg } = await supabase
      .from('chat_messages')
      .select('thread_id')
      .eq('id', oggettoId!)
      .maybeSingle()
    if (!msg?.thread_id) return { ok: false }
    const { data: thread } = await supabase
      .from('chat_threads')
      .select('teacher_id, parent_id')
      .eq('id', msg.thread_id as string)
      .maybeSingle()
    if (!thread) return { ok: false }
    if (thread.teacher_id !== uid && thread.parent_id !== uid) return { ok: false }
    return { ok: true, threadId: msg.thread_id as string }
  }

  if (tipo === 'media_galleria') {
    const { data: media } = await supabase
      .from('galleria_media_v2')
      .select('is_broadcast, tag_students, scuola_id')
      .eq('id', oggettoId!)
      .maybeSingle()
    if (!media) return { ok: false }
    if (isGenitore && media.is_broadcast !== true) {
      const figli = await figliDi(supabase, uid)
      const tagged = (media.tag_students ?? []) as string[]
      if (!figli.some((f) => tagged.includes(f))) return { ok: false }
    }
    return { ok: true, scuolaId: (media.scuola_id as string | null) ?? null }
  }

  if (tipo === 'voce_diario') {
    const { data: voce } = await supabase
      .from('eventi_diario')
      .select('alunno_id')
      .eq('id', oggettoId!)
      .maybeSingle()
    if (!voce?.alunno_id) return { ok: false }
    if (isGenitore) {
      const { data: link } = await supabase
        .from('legame_genitori_alunni')
        .select('genitore_id')
        .eq('genitore_id', uid)
        .eq('alunno_id', voce.alunno_id as string)
        .maybeSingle()
      if (!link) return { ok: false }
    }
    return { ok: true }
  }

  // tipo === 'utente'
  const ok = await contattoLegittimo(supabase, segnalante, segnalatoId!)
  return { ok }
}

// POST /api/segnalazioni
export const POST = withRoute('segnalazioni:POST', async (request: Request) => {
  const auth = await requireUser(request)
  if (auth.response) return auth.response
  const segnalante = auth.user

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const { tipo_oggetto, oggetto_id, segnalato_id, categoria, motivo } = b.data

  // Validazione applicativa (non esprimibile in modo pulito nello schema zod):
  //  · tipo_oggetto = 'utente'   → segnalato_id obbligatorio
  //  · tipo_oggetto ≠ 'utente'   → oggetto_id obbligatorio
  if (tipo_oggetto === 'utente') {
    if (!segnalato_id) {
      return NextResponse.json({ error: 'segnalato_id obbligatorio per una segnalazione utente' }, { status: 400 })
    }
  } else if (!oggetto_id) {
    return NextResponse.json({ error: 'oggetto_id obbligatorio per questo tipo di segnalazione' }, { status: 400 })
  }

  try {
    const supabase = await createAdminClient()

    // Il segnalante deve avere un rapporto reale con l'oggetto/persona segnalata.
    const acc = await verificaAccesso(supabase, segnalante, tipo_oggetto, oggetto_id, segnalato_id)
    if (!acc.ok) {
      logEvento('segnalazione', 'info', {
        operazione: 'segnalazioni:POST',
        esito: 'accesso-non-legittimo',
        tipo: tipo_oggetto,
      })
      return NextResponse.json({ error: 'Non sei autorizzato a segnalare questo contenuto' }, { status: 403 })
    }

    const scuolaId = acc.scuolaId ?? segnalante.scuola_id ?? (await scuolaUnicaReale(supabase))

    const record = {
      scuola_id: scuolaId,
      // MAI dal body: sempre l'identità del gate (anti-spoof).
      segnalante_id: segnalante.id,
      segnalato_id: tipo_oggetto === 'utente' ? segnalato_id : null,
      tipo_oggetto,
      oggetto_id: tipo_oggetto === 'utente' ? null : oggetto_id,
      thread_id: acc.threadId ?? null,
      categoria,
      motivo: motivo ?? null,
      stato: 'aperta',
    }

    const { data: ins, error } = await supabase.from('segnalazioni').insert(record).select('id').maybeSingle()
    if (error) {
      // DB E2E CI non migrato (tabella assente): degrada pulito, niente 500.
      if (schemaAssente(error)) {
        return NextResponse.json({ error: 'Servizio temporaneamente non disponibile' }, { status: 503 })
      }
      logErrore({ operazione: 'segnalazioni:POST', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }

    const segnalazioneId = (ins?.id as string) ?? null

    // Notifica alla Direzione (best-effort). Corpo GENERICO: mai il `motivo` testuale.
    try {
      const destinatari = await staffScuola(supabase, scuolaId, [...DIREZIONE])
      await notificaEvento(supabase, {
        tipo: 'segnalazione_contenuto',
        scuolaId,
        utenteIds: destinatari,
        titolo: 'Nuova segnalazione da moderare',
        corpo: 'È arrivata una segnalazione da parte di un utente. Gestiscila dal pannello Moderazione.',
        link: '/admin/moderazione',
        entitaTipo: 'segnalazione',
        entitaId: segnalazioneId,
        bufferMin: 0,
      })
    } catch (e) {
      logEvento('notifica', 'error', {
        operazione: 'segnalazioni:POST',
        tipo: 'segnalazione_contenuto',
        esito: 'notifica-non-accodata',
      }, e)
    }

    // Evento critico → si logga anche il SUCCESSO (solo tipo/uuid, mai il motivo).
    logEvento('segnalazione', 'info', {
      operazione: 'segnalazioni:POST',
      esito: 'segnalazione-creata',
      tipo: tipo_oggetto,
    })

    return NextResponse.json({ ok: true, id: segnalazioneId }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'segnalazioni:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})
