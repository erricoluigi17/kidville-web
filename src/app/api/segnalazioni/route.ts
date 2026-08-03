import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser, type AppUser } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { getFigliDiGenitore, genitoreHasFiglio } from '@/lib/anagrafiche/legami'
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
//
// ⚠️ ISOLAMENTO FRA SEDI (2026-08-03, rilievo W4 del verificatore adversariale).
// «Verifica del rapporto legittimo» descriveva ciò che il codice faceva per i
// GENITORI. La condizione reale su `media_galleria` era
// `if (isGenitore && media.is_broadcast !== true)`: per un NON-genitore —
// docente, segreteria, coordinatore, admin — non c'era ALCUN controllo, e per un
// genitore il broadcast saltava tutto. Misurato: una maestra di Aversa apriva una
// segnalazione su una foto di Giugliano conoscendone l'uuid; la riga nasceva con
// la `scuola_id` DEL MEDIA — un plesso non suo — e la notifica «Nuova
// segnalazione da moderare» partiva verso la Direzione di quel plesso. Lo stesso
// valeva per `voce_diario`, dove il ramo `if (isGenitore)` era l'unico presidio.
//
// Da oggi l'oggetto segnalato deve stare in una sede del segnalante:
//   · staff/docente → `scuoleDiUtente` (i plessi dell'utente);
//   · genitore      → le sedi dei propri FIGLI. `parents` non ha `scuola_id` e
//                     non deve averlo (un genitore può avere figli in due sedi):
//                     lo scope si deriva dai figli, come in `assertParentInScope`.
// Scope vuoto ⇒ si NEGA: non è «nessun vincolo», è «nessun permesso».
//
// `messaggio_chat` e `utente` non passano di lì perché sono scoped dall'IDENTITÀ,
// che è un vincolo più stretto della sede: si segnala un messaggio solo se si è
// partecipanti di quel thread, e un utente solo se esiste già un rapporto
// (thread condiviso o sezione in comune). Una conversazione di un altro plesso
// non è raggiungibile perché non se ne è partecipanti — non perché filtrata.
//
// ⚠️ E PROPRIO PER QUEI DUE TIPI LA RIGA NASCEVA SENZA PLESSO (2026-08-03,
// secondo giro del verificatore). Lo scope per identità decideva CHI può
// segnalare e non diceva DOVE archiviare: `acc.scuolaId` restava `undefined`
// per `messaggio_chat` e `utente`, e il ripiego a valle («l'unica sede del
// segnalante») non scatta per un genitore con figli in due plessi. Catena
// misurata: `sedi.length === 1` falso, `utenti.scuola_id` nullo (i genitori non
// hanno un plesso proprio), `scuolaUnicaReale()` nullo perché le sedi reali sono
// tre ⇒ `scuola_id: null`. Da lì il danno è doppio e silenzioso:
// `staffScuola(null)` non avvisa NESSUNA Direzione, e `admin/segnalazioni:PATCH`
// nega esplicitamente le righe senza plesso («Segnalazione fuori dal tuo
// plesso»). La segnalazione c'era; la moderazione non l'ha mai vista.
//
// Da oggi la sede si DEDUCE dall'oggetto anche per quei due tipi — un thread di
// chat parla sempre di un bambino (`chat_threads.student_id`), e un bambino ha
// un plesso; in mancanza, la sede del docente del thread. E se nemmeno così si
// riesce ad attribuirla, la segnalazione NON si scrive: si risponde 503 e si
// logga a `error`. Una riga che nessuno può moderare è peggio di un rifiuto —
// il rifiuto lo vede chi segnala e lo vede il log, la riga muta non la vede
// nessuno. È la stessa regola di `resolveScuolaScrittura`: mai indovinare la
// sede di una scrittura.
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

/**
 * Alunni di cui il genitore è tutore (id distinti), unione runtime + anagrafica.
 * È il predicato con cui si decide se una segnalazione è legittima: con la sola
 * `legame_genitori_alunni` un genitore importato dal form pubblico non poteva
 * segnalare NIENTE — né una foto del proprio figlio, né un messaggio ricevuto.
 */
async function figliDi(supabase: SupabaseClient, genitoreId: string): Promise<string[]> {
  return getFigliDiGenitore(supabase, genitoreId)
}

/**
 * I plessi entro cui il segnalante può segnalare qualcosa.
 *
 * Per lo STAFF sono i suoi (`scuoleDiUtente`). Per il GENITORE sono le sedi dei
 * suoi FIGLI: `parents` non ha `scuola_id` — e non deve averlo, perché un
 * genitore può avere figli in due plessi — quindi la sede si deriva dal legame,
 * esattamente come fa `assertParentInScope` e come fa `gallery:GET`, che al
 * genitore mostra i media della sede del figlio e non altro.
 *
 * Fail-closed in tutti e tre i modi di non sapere: nessun figlio, lettura
 * fallita, o alunni senza plesso ⇒ elenco VUOTO, che tutti i chiamanti trattano
 * come diniego. PostgREST non lancia: senza il controllo su `{ error }` un
 * guasto di lettura diventerebbe «nessuna sede» e poi — nel posto sbagliato —
 * un permesso.
 *
 * ⚠️ NIENTE DEGRADO SU DB NON MIGRATO, E QUI È UNA SCELTA — non una dimenticanza
 * (rilievo del verificatore adversariale, 2026-08-03). `assertTagStudentsInScope`
 * (galleria) di fronte a un `42703` su `alunni.scuola_id` chiede il permesso di
 * proseguire senza il filtro (`colonnaSedeAssente`/`degradoSedeLecito`); qui no.
 * La differenza non è una svista: là il degrado toglie un FILTRO da una lettura,
 * qui la sede serve a decidere DOVE SCRIVERE, e proseguire senza saperlo
 * significherebbe archiviare una segnalazione in un plesso indovinato — cioè
 * riaprire, con un'altra porta, lo stesso guasto che questa route ha appena
 * chiuso. Senza la colonna un genitore ottiene `sedi = []`, cioè 403 su tutto:
 * è restrittivo e visibile, mai una fuga.
 *
 * Misurato lo stesso giorno: sul DB E2E della CI la colonna C'È
 * (`scripts/seed-e2e.mjs` scrive `alunni.scuola_id`), e nessuna spec Playwright
 * tocca le segnalazioni — quindi oggi il caso non si presenta. Resta scritto
 * perché il giorno in cui si presentasse, la risposta giusta è aggiungere la
 * migrazione, non aprire una via alternativa.
 */
async function sediDelSegnalante(supabase: SupabaseClient, user: AppUser): Promise<string[]> {
  if (user.role !== 'genitore') return await scuoleDiUtente(supabase, user)

  const figli = await figliDi(supabase, user.id)
  if (figli.length === 0) return []
  const { data, error } = await supabase.from('alunni').select('scuola_id').in('id', figli)
  if (error) {
    logEvento('segnalazione', 'error', {
      operazione: 'segnalazioni:POST',
      esito: 'sedi-figli-non-risolte',
      // Solo conteggi: gli id sono di minori.
      figli: figli.length,
    }, error)
    return []
  }
  const sedi = new Set<string>()
  for (const r of data ?? []) {
    const s = r.scuola_id as string | null
    if (s) sedi.add(s)
  }
  return [...sedi]
}

/**
 * La sede di un ALUNNO — per ATTRIBUIRE la segnalazione, non per autorizzarla.
 *
 * Nessun filtro di sede qui, e non è una dimenticanza: quando questa funzione
 * viene chiamata il permesso è già stato deciso (per identità, o dal filtro
 * `.in('scuola_id', sedi)` di `verificaAccesso`). Qui resta una sola domanda —
 * *in quale plesso va archiviata la riga* — e restringerla ai plessi di chi
 * segnala darebbe la risposta sbagliata proprio nel caso che ha creato il
 * guasto: la conversazione di un genitore con figli in due sedi.
 */
async function sedeDiAlunno(
  supabase: SupabaseClient,
  alunnoId: string | null | undefined,
): Promise<string | null> {
  if (!alunnoId) return null
  const { data, error } = await supabase
    .from('alunni')
    .select('scuola_id')
    .eq('id', alunnoId)
    .maybeSingle()
  if (error) {
    // PostgREST non lancia: senza questa riga un guasto di lettura diventerebbe
    // «bambino senza plesso», cioè una segnalazione non moderabile senza che
    // nessuno sappia perché.
    logEvento('segnalazione', 'error', {
      operazione: 'segnalazioni:POST',
      esito: 'sede-alunno-non-letta',
    }, error)
    return null
  }
  return (data?.scuola_id as string | null) ?? null
}

/** La sede primaria di un utente dello staff: ripiego quando il bambino non ne ha. */
async function sedeDiUtente(
  supabase: SupabaseClient,
  utenteId: string | null | undefined,
): Promise<string | null> {
  if (!utenteId) return null
  const { data, error } = await supabase
    .from('utenti')
    .select('scuola_id')
    .eq('id', utenteId)
    .maybeSingle()
  if (error) {
    logEvento('segnalazione', 'error', {
      operazione: 'segnalazioni:POST',
      esito: 'sede-utente-non-letta',
    }, error)
    return null
  }
  return (data?.scuola_id as string | null) ?? null
}

/** Esito di `contattoLegittimo`: il permesso, e il plesso in cui archiviare. */
interface EsitoContatto {
  ok: boolean
  scuolaId?: string | null
}

/**
 * Contatto legittimo (stesso criterio di `chat/contacts`): esiste un thread condiviso
 * tra i due, OPPURE il segnalato è il docente di una sezione di un figlio del genitore
 * (o viceversa). Nessun genitore↔genitore, nessun docente↔docente: il grafo passa
 * sempre per la relazione genitore↔docente↔sezione.
 *
 * Restituisce anche la SEDE del rapporto — il bambino del thread condiviso, o il
 * bambino la cui sezione è in comune. È il plesso in cui la Direzione ha titolo
 * di moderare quella segnalazione, e senza di essa la riga nasceva senza plesso
 * ogni volta che il segnalante ne aveva più d'uno.
 */
async function contattoLegittimo(
  supabase: SupabaseClient,
  segnalante: AppUser,
  segnalatoId: string,
  sedi: string[],
): Promise<EsitoContatto> {
  const uid = segnalante.id

  // 1. Thread di chat già esistente in una delle due direzioni.
  const { data: threads, error: errThreads } = await supabase
    .from('chat_threads')
    .select('id, student_id')
    .or(
      `and(teacher_id.eq.${uid},parent_id.eq.${segnalatoId}),and(teacher_id.eq.${segnalatoId},parent_id.eq.${uid})`,
    )
  if (errThreads) {
    logEvento('segnalazione', 'error', {
      operazione: 'segnalazioni:POST',
      esito: 'thread-condivisi-non-letti',
    }, errThreads)
    return { ok: false }
  }
  const thread = (threads ?? [])[0]
  if (thread) {
    return { ok: true, scuolaId: await sedeDiAlunno(supabase, thread.student_id as string | null) }
  }

  // 2. Relazione per sezione: chi è il genitore e chi il docente dipende dal ruolo.
  const parentId = segnalante.role === 'genitore' ? uid : segnalatoId
  const teacherId = segnalante.role === 'genitore' ? segnalatoId : uid

  const figli = await figliDi(supabase, parentId)
  if (figli.length === 0) return { ok: false }

  // `.in('scuola_id', sedi)`: la sezione che entra nel confronto deve essere di
  // un plesso del segnalante. Senza, il nome di una sezione di un altro plesso
  // poteva entrare nell'insieme — e con tre sedi le sezioni omonime esistono.
  // Il presidio è ridondante rispetto a `utenti_sezioni` (le sezioni del docente
  // sono per costruzione nei suoi plessi), e resta perché la ridondanza qui
  // costa una clausola e vale un'intera classe di errori futuri.
  const { data: alunni, error: errAlunni } = await supabase
    .from('alunni')
    .select('section_id, scuola_id')
    .in('id', figli)
    .in('scuola_id', sedi)
  if (errAlunni) {
    // PostgREST non lancia: un guasto di lettura non deve diventare un permesso
    // (né, peggio, un diniego muto che nessuno riesce a spiegare).
    logEvento('segnalazione', 'error', {
      operazione: 'segnalazioni:POST',
      esito: 'sezioni-figli-non-lette',
      figli: figli.length,
    }, errAlunni)
    return { ok: false }
  }
  // sezione → plesso di QUEL bambino: è la sezione in comune a dire quale dei
  // figli fa da ponte, e quindi in quale plesso vive il rapporto.
  const sedePerSezione = new Map<string, string | null>()
  for (const a of alunni ?? []) {
    const sezione = a.section_id as string | null
    if (sezione) sedePerSezione.set(sezione, (a.scuola_id as string | null) ?? null)
  }
  if (sedePerSezione.size === 0) return { ok: false }

  const { data: sezioniDocente, error: errSezioni } = await supabase
    .from('utenti_sezioni')
    .select('section_id')
    .eq('utente_id', teacherId)
  if (errSezioni) {
    logEvento('segnalazione', 'error', {
      operazione: 'segnalazioni:POST',
      esito: 'sezioni-docente-non-lette',
    }, errSezioni)
    return { ok: false }
  }
  const inComune = (sezioniDocente ?? []).find((r) => sedePerSezione.has(r.section_id as string))
  if (!inComune) return { ok: false }
  return { ok: true, scuolaId: sedePerSezione.get(inComune.section_id as string) ?? null }
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
  sedi: string[],
): Promise<EsitoAccesso> {
  const uid = segnalante.id
  const isGenitore = segnalante.role === 'genitore'

  if (tipo === 'messaggio_chat') {
    const { data: msg, error: errMsg } = await supabase
      .from('chat_messages')
      .select('thread_id')
      .eq('id', oggettoId!)
      .maybeSingle()
    if (errMsg) {
      // PostgREST non lancia: senza questa riga un guasto di lettura si
      // travestirebbe da «messaggio inesistente», cioè da tentativo illecito.
      logEvento('segnalazione', 'error', {
        operazione: 'segnalazioni:POST', esito: 'messaggio-non-letto', tipo,
      }, errMsg)
      return { ok: false }
    }
    if (!msg?.thread_id) return { ok: false }
    // `student_id`: un thread di chat parla SEMPRE di un bambino, e il bambino
    // ha un plesso. È da qui che si ricava la sede della segnalazione — prima
    // non si leggeva affatto, e la riga nasceva senza plesso.
    const { data: thread, error: errThread } = await supabase
      .from('chat_threads')
      .select('teacher_id, parent_id, student_id')
      .eq('id', msg.thread_id as string)
      .maybeSingle()
    if (errThread) {
      logEvento('segnalazione', 'error', {
        operazione: 'segnalazioni:POST', esito: 'thread-non-letto', tipo,
      }, errThread)
      return { ok: false }
    }
    if (!thread) return { ok: false }
    if (thread.teacher_id !== uid && thread.parent_id !== uid) return { ok: false }
    // Sede della conversazione: il plesso del BAMBINO di cui si parla; in
    // mancanza (anagrafica incompleta) quello del docente del thread, che una
    // sede propria ce l'ha sempre. Il genitore non entra in questo ripiego:
    // `utenti.scuola_id` è nullo per i genitori — è esattamente il valore che
    // faceva credere «nessuna sede» quando la sede c'era.
    const scuolaId =
      (await sedeDiAlunno(supabase, thread.student_id as string | null)) ??
      (await sedeDiUtente(supabase, thread.teacher_id as string | null))
    return { ok: true, threadId: msg.thread_id as string, scuolaId }
  }

  if (tipo === 'media_galleria') {
    // `.in('scuola_id', sedi)` NELLA STESSA QUERY: il media di un altro plesso
    // non si legge affatto, invece di leggersi e poi valutarsi. È la differenza
    // fra un filtro e un controllo che si può dimenticare in un ramo — e questo
    // handler ne aveva uno per i genitori e nessuno per tutti gli altri.
    // Scope vuoto ⇒ `.in(…, [])` non restituisce niente ⇒ si nega.
    const { data: media, error } = await supabase
      .from('galleria_media_v2')
      .select('is_broadcast, tag_students, scuola_id')
      .eq('id', oggettoId!)
      .in('scuola_id', sedi)
      .maybeSingle()
    // PostgREST non lancia: senza questo controllo un guasto di lettura si
    // travestirebbe da «media non tuo», cioè da un tentativo cross-sede — e
    // riempirebbe di falsi positivi l'unico contatore che quel tentativo lo
    // segnala davvero.
    if (error) {
      logEvento('segnalazione', 'error', {
        operazione: 'segnalazioni:POST', esito: 'media-non-letto', tipo,
      }, error)
      return { ok: false }
    }
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
    // `eventi_diario` non ha `scuola_id`: la sede è dell'ALUNNO. Si risolve qui,
    // con il filtro nella stessa query — e serve a due cose insieme: negare la
    // voce di un bambino di un altro plesso, e dire in QUALE plesso archiviare
    // la segnalazione (prima restava `ok: true` senza sede, e la riga finiva
    // nella sede primaria di chi segnala o, per un genitore, in nessuna).
    const { data: alunno, error: errAlunno } = await supabase
      .from('alunni')
      .select('id, scuola_id')
      .eq('id', voce.alunno_id as string)
      .in('scuola_id', sedi)
      .maybeSingle()
    if (errAlunno) {
      logEvento('segnalazione', 'error', {
        operazione: 'segnalazioni:POST', esito: 'alunno-non-letto', tipo,
      }, errAlunno)
      return { ok: false }
    }
    if (!alunno) return { ok: false }
    if (isGenitore) {
      const collegato = await genitoreHasFiglio(supabase, uid, voce.alunno_id as string)
      if (!collegato) return { ok: false }
    }
    return { ok: true, scuolaId: (alunno.scuola_id as string | null) ?? null }
  }

  // tipo === 'utente'
  return await contattoLegittimo(supabase, segnalante, segnalatoId!, sedi)
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

    // I plessi entro cui questo segnalante può segnalare: i suoi, o — se è un
    // genitore — quelli dei suoi figli. Vuoto ⇒ si nega (lo fa `verificaAccesso`,
    // dove `.in('scuola_id', [])` non restituisce niente).
    const sedi = await sediDelSegnalante(supabase, segnalante)

    // Il segnalante deve avere un rapporto reale con l'oggetto/persona segnalata,
    // e l'oggetto deve stare in una delle sue sedi.
    const acc = await verificaAccesso(supabase, segnalante, tipo_oggetto, oggetto_id, segnalato_id, sedi)
    if (!acc.ok) {
      logEvento('segnalazione', 'info', {
        operazione: 'segnalazioni:POST',
        esito: 'accesso-non-legittimo',
        tipo: tipo_oggetto,
      })
      // Nel corpo NIENTE: non l'uuid dell'oggetto, non la sede, non il bambino.
      // Dire «è di un altro plesso» confermerebbe che quell'oggetto esiste.
      return NextResponse.json({ error: 'Non sei autorizzato a segnalare questo contenuto' }, { status: 403 })
    }

    // La sede della riga, in ordine di attendibilità: quella dell'OGGETTO
    // (il media, il bambino del diario, il bambino del thread di chat, il
    // bambino della sezione in comune), poi l'unica sede del segnalante, poi la
    // sua sede primaria. `scuolaUnicaReale` resta ultimo e ormai restituisce
    // `null` con tre plessi: è la rete che non prende più niente.
    //
    // Il ramo `sedi.length === 1` non è un ripiego di comodo: è l'unico caso in
    // cui NON si sta indovinando — se di plessi ce n'è uno solo, quello è. Con
    // due o più si tace, perché una segnalazione archiviata nel plesso sbagliato
    // la legge una Direzione che su quel contenuto non ha titolo.
    const scuolaId =
      acc.scuolaId ?? (sedi.length === 1 ? sedi[0] : null) ?? segnalante.scuola_id ?? (await scuolaUnicaReale(supabase))

    // NESSUNA RIGA SENZA PLESSO. Era il guasto: `scuola_id: null` passava,
    // `staffScuola(null)` non avvisava nessuna Direzione e
    // `admin/segnalazioni:PATCH` rifiutava la riga («Segnalazione fuori dal tuo
    // plesso»). Risultato: una segnalazione che esiste, che nessuno vede e che
    // nessuno può chiudere — il modo peggiore di fallire, perché a chi segnala
    // era stato risposto «inviata».
    // `error` e non `warn`: qui l'anagrafica dice che un bambino non ha plesso,
    // ed è un guasto nostro, non una richiesta sbagliata dell'utente.
    if (!scuolaId) {
      logEvento('segnalazione', 'error', {
        operazione: 'segnalazioni:POST',
        esito: 'sede-non-attribuibile',
        tipo: tipo_oggetto,
        // Solo conteggi: gli id sono di minori.
        sedi: sedi.length,
      })
      // Col `codice`, così chi guarda lo schermo lo legge nella lingua
      // dell'interfaccia: la prosa qui accanto nasce in una route, dove il
      // locale non esiste, e nasce italiana.
      return NextResponse.json(
        {
          error: 'Segnalazione non registrata: non è stato possibile attribuirla a un plesso',
          codice: 'SEGNALAZIONE_SENZA_PLESSO',
        },
        { status: 503 },
      )
    }

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
