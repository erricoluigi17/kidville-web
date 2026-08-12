import type { SupabaseClient } from '@supabase/supabase-js'
import { schemaAssente } from '@/lib/news/schema-assente'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { sorteDellaFoto, uuidDichiarati, type RigaMedia } from './foto-partizione'
import { CAMPI_CONTEGGIO, OBLIO_DISTRUGGE, OBLIO_RESTA } from './cosa-distrugge-voci'
import type { CampoConteggioOblio, VoceOblio } from './cosa-distrugge-voci'

// Le voci dell'avviso vivono in `cosa-distrugge-voci.ts` (il pannello è un componente
// client e non può tirarsi dietro il logger: vedi la testata di quel file). Si
// ri-esportano da qui perché route e lock continuino a importarle da un posto solo.
export { CAMPI_CONTEGGIO, OBLIO_DISTRUGGE, OBLIO_RESTA }
export type { CampoConteggioOblio, VoceOblio }

// ─────────────────────────────────────────────────────────────────────────────
// I CONTEGGI — sole `SELECT`, nessuna scrittura.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quanti sono, per ciascuna voce misurabile.
 *
 * `null` non è zero: vuol dire «non l'ho potuto leggere». La differenza è il punto
 * di tutto il modulo — un dry-run che risponde `0` a una lettura fallita è un
 * avviso che RASSICURA, e la conferma verrebbe data su un numero che nessuno ha
 * misurato. È lo stesso principio per cui la route risponde 500 quando non riesce
 * a sapere se un genitore ha altri figli.
 */
export interface ConteggiOblio {
  pagelle: number | null
  certificati_medici: number | null
  /**
   * Foto e video in cui il bambino è l'UNICO taggato **e che l'oblio riesce a
   * togliere davvero**: file e riga se ne vanno. Non è la stessa cosa di «foto in
   * cui è l'unico ritratto» — vedi `foto_non_rimovibili` — e la differenza è
   * l'unica che conti per chi sta confermando: qui si annuncia una distruzione.
   */
  foto_solo_sue: number | null
  /** Foto di gruppo: il file RESTA (c'è l'immagine di altri), esce solo il tag. */
  foto_di_gruppo: number | null
  /**
   * Foto in cui è l'unico ritratto ma il cui indirizzo NON è riconoscibile in
   * questo archivio: l'oblio non cancella né il file né la riga (`esegui.ts`,
   * `oblio-percorso-non-riconosciuto`). Stanno in un numero loro perché
   * sommarle alle altre prometterebbe una distruzione che non avviene, e tacerle
   * nasconderebbe che una foto di quel bambino resta nell'archivio.
   */
  foto_non_rimovibili: number | null
  /** ARTICOLI del blog pubblico che lo dichiarano fra i ritratti — non immagini. */
  articoli_pubblici: number | null
  allegati_chat: number | null
}

const NON_MISURATI: ConteggiOblio = {
  pagelle: null,
  certificati_medici: null,
  foto_solo_sue: null,
  foto_di_gruppo: null,
  foto_non_rimovibili: null,
  articoli_pubblici: null,
  allegati_chat: null,
}

/**
 * Legge una tabella e dice se la risposta è ATTENDIBILE.
 *
 * PostgREST non lancia: ritorna `{ error }`. Senza il controllo del valore di
 * ritorno una lettura fallita diventerebbe una lista vuota, cioè «zero pagelle» —
 * e il `try/catch` attorno all'`await` non scatterebbe mai.
 *
 * Lo schema assente (DB E2E della CI non migrato) è l'unico caso in cui il vuoto è
 * la risposta GIUSTA e non un guasto: se la tabella non esiste, di pagelle non ce
 * n'è nessuna. Si tace, e si conta zero.
 */
async function leggi<T>(
  query: PromiseLike<{ data: unknown; error: unknown }>,
  evento: string,
  op: string,
): Promise<{ righe: T[]; letto: boolean }> {
  const { data, error } = await query
  if (error) {
    if (schemaAssente(error)) return { righe: [], letto: true }
    logErrore({ operazione: op, evento }, error)
    return { righe: [], letto: false }
  }
  return { righe: (data ?? []) as T[], letto: true }
}

/**
 * Conta, per un alunno, che cosa l'oblio distruggerà davvero.
 *
 * SOLE `SELECT`: questa funzione gira nel ramo `dryrun`, cioè PRIMA della conferma
 * e su un'operazione che non ha un annulla. Nessuna `update`, nessuna `delete`,
 * nessuna `remove()` sullo Storage.
 *
 * La partizione della galleria NON è ricalcata da `obliaFotoAlunno`: è la STESSA
 * funzione (`sorteDellaFoto`, in `./foto-partizione.ts`). Finché erano due copie
 * divergevano — misurato il 2026-08-12 su due casi, un tag con spazi e un
 * indirizzo non mappabile — e il riquadro prometteva distruzioni che non
 * avvenivano. Che i numeri coincidano con ciò che l'esecuzione produce non è
 * affidato al commento: lo verifica
 * `__tests__/architecture/oblio-avviso-dichiarato.test.ts`, che fa girare il
 * conteggio e l'oblio sullo stesso client finto e confronta, su più materiali.
 */
export async function contaCosaDistrugge(
  supabase: SupabaseClient,
  alunnoId: string,
  op: string,
): Promise<ConteggiOblio> {
  const id = (alunnoId ?? '').trim()
  if (!id) return { ...NON_MISURATI }

  const pag = await leggi<{ id: string }>(
    supabase.from('pagelle').select('id').eq('alunno_id', id),
    'dryrun_pagelle',
    op,
  )
  const cert = await leggi<{ id: string }>(
    supabase.from('certificati_medici').select('id').eq('alunno_id', id),
    'dryrun_certificati_medici',
    op,
  )

  // Galleria: la stessa FUNZIONE che usa `obliaFotoAlunno`, non la stessa domanda
  // riscritta. Serve anche `file_url`, perché la sorte di una foto dipende pure
  // dall'indirizzo: se non è riconoscibile in questo archivio l'oblio non la
  // toglie, e annunciarla fra le distruzioni sarebbe una promessa vuota.
  const media = await leggi<RigaMedia>(
    supabase
      .from('galleria_media_v2')
      .select('id, file_url, tag_students')
      .contains('tag_students', [id]),
    'dryrun_galleria',
    op,
  )
  let soloSue = 0
  let diGruppo = 0
  let nonRimovibili = 0
  for (const r of media.righe) {
    const sorte = sorteDellaFoto(r, id)
    if (sorte.sorte === 'sganciata') diGruppo++
    else if (sorte.sorte === 'trattenuta') nonRimovibili++
    else soloSue++
  }

  // Blog pubblico: `contains` è il filtro del database, ma la verità la dice la
  // dichiarazione letta riga per riga — è ciò che fa anche `obliaFotoNewsAlunno`.
  const news = await leggi<{ id: string; bambini_ritratti?: unknown }>(
    supabase.from('news_posts').select('id, bambini_ritratti').contains('bambini_ritratti', [id]),
    'dryrun_news',
    op,
  )
  const articoli = news.righe.filter((p) => uuidDichiarati(p.bambini_ritratti).includes(id)).length

  // Allegati di chat: i thread del bambino si trovano per `student_id`, e solo i
  // messaggi che portano davvero un allegato contano.
  const thread = await leggi<{ id: string }>(
    supabase.from('chat_threads').select('id').eq('student_id', id),
    'dryrun_chat_thread',
    op,
  )
  const threadIds = thread.righe.map((t) => t.id).filter((v) => typeof v === 'string' && v.length > 0)
  let allegati: number | null = thread.letto ? 0 : null
  if (thread.letto && threadIds.length > 0) {
    // Nessun thread ⇒ nessuna query: un `in` con lista vuota su PostgREST è un
    // filtro che non filtra, e qui conterebbe gli allegati dell'intera scuola.
    const msg = await leggi<{ id: string }>(
      supabase
        .from('chat_messages')
        .select('id')
        .in('thread_id', threadIds)
        .not('attachment_url', 'is', null),
      'dryrun_chat_allegati',
      op,
    )
    allegati = msg.letto ? msg.righe.length : null
  }

  const conteggi: ConteggiOblio = {
    pagelle: pag.letto ? pag.righe.length : null,
    certificati_medici: cert.letto ? cert.righe.length : null,
    foto_solo_sue: media.letto ? soloSue : null,
    foto_di_gruppo: media.letto ? diGruppo : null,
    foto_non_rimovibili: media.letto ? nonRimovibili : null,
    articoli_pubblici: news.letto ? articoli : null,
    allegati_chat: allegati,
  }

  // Evento critico → si logga anche il SUCCESSO, e qui c'è una ragione in più:
  // questi numeri sono ciò che la Direzione ha VISTO prima di confermare. Fra sei
  // mesi, alla domanda «vi era stato detto che se ne andavano le pagelle?», questa
  // riga è l'unica risposta che non dipende dalla memoria di qualcuno. Solo
  // conteggi e uuid: `gdpr` è un evento PERSISTITO.
  logEvento('gdpr', 'info', {
    operazione: op,
    esito: 'oblio-dryrun-cosa-distrugge',
    entita_tipo: 'alunni',
    entita_id: id,
    n_pagelle: conteggi.pagelle,
    n_certificati: conteggi.certificati_medici,
    n_foto: conteggi.foto_solo_sue,
    n_foto_gruppo: conteggi.foto_di_gruppo,
    n_foto_trattenute: conteggi.foto_non_rimovibili,
    n_articoli: conteggi.articoli_pubblici,
    n_allegati: conteggi.allegati_chat,
  })

  return conteggi
}

/**
 * La somma dei conteggi di PIÙ bambini, per l'oblio in BLOCCO.
 *
 * Serve al canale delle richieste di cancellazione (art. 17 presentata dalla
 * famiglia): lì la Direzione conferma UNA volta e l'operazione tocca tutti i
 * figli non più iscritti insieme. Il riquadro deve dire che cosa se ne va in
 * tutto, altrimenti si torna alla conferma alla cieca — solo moltiplicata.
 *
 * ⚠️ `null` VINCE SULLA SOMMA, ed è tutta la regola di questa funzione. Se anche
 * un solo bambino non è stato misurato, il totale non esiste: sommare gli altri
 * darebbe un numero più basso del vero e dall'aria misurata — «pagelle: 2»
 * quando le pagelle sono cinque e di tre non si sa niente. Un totale parziale
 * presentato come totale è esattamente il difetto per cui esiste questo modulo.
 */
export function sommaConteggiOblio(parziali: ConteggiOblio[]): ConteggiOblio {
  const somma = { ...NON_MISURATI }
  for (const chiave of Object.keys(somma) as (keyof ConteggiOblio)[]) {
    let totale: number | null = 0
    for (const p of parziali) {
      const v = p[chiave]
      if (typeof v !== 'number') {
        totale = null
        break
      }
      totale += v
    }
    somma[chiave] = totale
  }
  return somma
}
