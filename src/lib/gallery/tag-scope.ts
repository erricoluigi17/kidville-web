// =============================================================================
// Lo scope di sede dei `tag_students` della galleria — in UN posto solo.
//
// PERCHÉ ESISTE, E PERCHÉ NON STA DENTRO LA ROUTE (2026-08-03).
// Il 31/07 questa regola è stata scritta a mano dentro l'handler `POST` di
// `/api/gallery`: venti righe che leggono `alunni` filtrando per plesso e
// rispondono 403 se un tag è di un altro. Corretta, provata, e — proprio perché
// viveva dentro un handler — invisibile all'handler gemello. Il `PATCH` accetta
// `tag_students` esattamente come la POST, e quel gate non l'ha mai avuto:
//
//   PATCH {"id":"<un mio media>","tag_students":["<uuid di un minore altrui>"]}
//     ⇒ 422 con `nomi: ["Nome Cognome"]` e `ids: [...]`
//
// cioè il NOME di un bambino di un'altra sede, più l'informazione che gli manca
// la liberatoria fotografica, servito a chiunque ne conosca l'uuid. La stessa
// fuga chiusa in POST, aperta un metro più in là.
//
// La lezione è già scritta in altri punti di questo repo, e vale la pena
// ripeterla qui: **una regola valida per due strade deve vivere in un posto
// solo**. Non «due copie tenute allineate»: una funzione, chiamata da entrambe.
// Se domani nascesse un terzo ingresso che accetta tag, dovrà passare di qui —
// e il compilatore glielo ricorda, perché `sedi` è un parametro obbligatorio.
//
// COSA NON FA. Non guarda il consenso: quello è il Privacy Lock
// (`./privacy`), e viene DOPO. L'ordine non è un dettaglio d'ordine — è la
// correzione: il Privacy Lock pronuncia nomi di minori, e non deve pronunciarli
// su bambini che chi chiama non ha titolo di conoscere.
// =============================================================================

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colonnaSedeAssente, degradoSedeLecito } from '@/lib/forms/degrado-sede'
import { logErrore, logEvento } from '@/lib/logging/logger'

/** L'handler che sta chiedendo: finisce nel log, mai nella risposta. */
export type OperazioneGalleria = 'gallery:POST' | 'gallery:PATCH'

/**
 * Verifica che OGNI bambino taggato appartenga a una delle `sedi` indicate.
 *
 * @returns `null` se sono tutti dentro (o se non c'è nessun tag), altrimenti la
 *   risposta da restituire subito: **403** senza nomi né id nel corpo — dire
 *   *quali* uuid non sono in scope confermerebbe l'esistenza di quei bambini a
 *   chi non ha titolo — oppure **500** se l'anagrafica non è leggibile.
 *
 * @param sedi i plessi di chi sta operando. Elenco VUOTO ⇒ si nega: uno scope
 *   vuoto non è «nessun vincolo», è «nessun permesso» (regola del progetto).
 */
export async function assertTagStudentsInScope(
  supabase: SupabaseClient,
  tagStudents: string[] | null | undefined,
  sedi: string[],
  operazione: OperazioneGalleria,
): Promise<NextResponse | null> {
  const ids = [...new Set(tagStudents ?? [])]
  if (ids.length === 0) return null

  if (sedi.length === 0) {
    logEvento('galleria', 'warn', {
      operazione,
      esito: 'tag-fuori-sede',
      tipo: 'tag-fuori-sede',
      motivo: 'scope-vuoto',
      // Solo conteggi: gli id sono di minori.
      taggati: ids.length,
      fuoriSede: ids.length,
    })
    return rifiuto()
  }

  let { data: inScope, error } = await supabase
    .from('alunni')
    .select('id')
    .in('id', ids)
    .in('scuola_id', sedi)

  // ─── LA COLONNA PUÒ NON ESSERCI, E NON È UN GUASTO NOSTRO ──────────────────
  // Il DB E2E della CI è un progetto separato e NON migrato: là `alunni.scuola_id`
  // può non esistere, e PostgREST risponde `42703`. Fino al 2026-08-03 finiva
  // nel ramo qui sotto e diventava un **500**, cioè «guasto del server» su una
  // condizione dichiarata e prevista — e la dipendenza è per giunta NUOVA: il
  // `PATCH` della galleria, prima che questo gate esistesse, `alunni.scuola_id`
  // non lo interrogava mai. `gallery:GET`, nello stesso file di route, quel caso
  // lo tratta già così: se ne accorge (`colonnaSedeAssente`) e chiede il permesso
  // di proseguire (`degradoSedeLecito`).
  //
  // La regola è la stessa, ed è stretta apposta: si prosegue senza il filtro di
  // sede SOLO se non c'è niente da isolare (al più UNA sede reale). Se le sedi
  // sono più d'una e la colonna manca, si NEGA — un fail-open proprio quando
  // l'isolamento non è disponibile sarebbe il peggiore dei momenti per aprirsi.
  //
  // Nella rilettura cade SOLO il vincolo di sede: la query resta la stessa meno
  // quella clausola, e il verdetto continua a costruirsi sugli id che tornano —
  // quindi un uuid che non corrisponde a nessun bambino resta respinto. Il
  // degrado toglie ciò che lo schema non sa esprimere, non il controllo.
  // (Il `.in('id', ids)` della rilettura è lì per non scaricare l'anagrafica
  // intera: a decidere è `ammessi`, poco più sotto.)
  if (colonnaSedeAssente(error as { code?: string } | null)) {
    if (!(await degradoSedeLecito(supabase, operazione))) {
      // Colonna d'isolamento assente su un impianto multi-sede: è un incidente,
      // quindi `error`, mai `info`.
      logEvento('galleria', 'error', {
        operazione,
        esito: 'colonna-sede-assente-degrado-negato',
      })
      return NextResponse.json(
        { error: 'Verifica dei tag non riuscita', codice: 'VERIFICA_TAG_NON_RIUSCITA' },
        { status: 500 },
      )
    }
    logEvento('galleria', 'info', {
      operazione,
      esito: 'degrado-scuola-id-assente',
      taggati: ids.length,
    })
    const rilettura = await supabase.from('alunni').select('id').in('id', ids)
    inScope = rilettura.data
    error = rilettura.error
  }

  // PostgREST non lancia: ritorna `{ error }`. Senza questo controllo un errore
  // di lettura diventerebbe «nessun alunno in scope» e poi, peggio, un permesso.
  if (error) {
    logErrore({ operazione, stato: 500, evento: 'db' }, error)
    return NextResponse.json(
      { error: 'Verifica dei tag non riuscita', codice: 'VERIFICA_TAG_NON_RIUSCITA' },
      { status: 500 },
    )
  }

  const ammessi = new Set(((inScope ?? []) as { id: string }[]).map((a) => a.id))
  const fuoriSede = ids.filter((id) => !ammessi.has(id)).length
  if (fuoriSede > 0) {
    // Solo conteggi nel log, e NIENTE nel corpo: dire quali sono confermerebbe
    // l'esistenza di quei bambini a chi non ha titolo.
    logEvento('galleria', 'warn', {
      operazione,
      esito: 'tag-fuori-sede',
      tipo: 'tag-fuori-sede',
      taggati: ids.length,
      fuoriSede,
    })
    return rifiuto()
  }

  return null
}

/**
 * L'UNICA risposta di diniego, per tutti e due i modi di sbagliare.
 *
 * Non dice QUALI bambini, e non dice nemmeno *perché* (scope vuoto o tag
 * altrui): il dettaglio confermerebbe l'esistenza di quei minori — o
 * racconterebbe a chi tenta come è andata la risoluzione delle sedi. Il `codice`
 * serve a mostrarla nella lingua dell'interfaccia; i conteggi stanno nel log.
 */
function rifiuto(): NextResponse {
  return NextResponse.json(
    {
      error: 'Uno o più bambini taggati non appartengono ai tuoi plessi.',
      codice: 'TAG_FUORI_SEDE',
    },
    { status: 403 },
  )
}
