// =============================================================================
// IL CONSENSO NON È UN BIGLIETTO D'INGRESSO: È UNA CONDIZIONE DI PERMANENZA.
//
// PERCHÉ ESISTE QUESTO FILE. Il 2026-08-02 il collaudo privacy ha misurato due
// difetti sullo stesso magazzino — `news`, l'unico bucket PUBBLICO dei tredici,
// servito a chiunque conosca l'indirizzo, senza login:
//
//  #1 UNA FOTO ENTRATA LÌ NON USCIVA PIÙ. Il registro dell'oblio dichiarava
//     `news` ESCLUSO con la motivazione «ci vanno solo media editoriali, le foto
//     dei bambini stanno in `gallery`». Ma `gate-consenso.ts` — scritto lo stesso
//     giorno, nel file accanto — esiste APPOSTA per autorizzare le foto di minori
//     che hanno il consenso al canale «sito». Le due frasi descrivono due
//     prodotti diversi, e quella scritta nel registro non era quella vera:
//     esercitato il diritto alla cancellazione, l'immagine del bambino restava
//     pubblica per sempre.
//
//  #2 LA REVOCA NON ARRIVAVA AGLI ARTICOLI GIÀ PUBBLICATI. Il consenso si
//     verificava in tre punti — creazione, modifica, pubblicazione — e poi non lo
//     rileggeva più nessuno. Una famiglia che revocava (art. 7 §3 GDPR: revocare
//     dev'essere facile quanto acconsentire) vedeva la foto del figlio restare
//     online a tempo indeterminato.
//
// LA CAUSA È UNA SOLA. È la stessa forma di difetto che questo ciclo ha già
// corretto tre volte — la regola chiusa su una strada e lasciata aperta su quella
// accanto — applicata però all'asse del TEMPO invece che a quello delle rotte: si
// controllava l'INGRESSO del dato e mai la sua PERMANENZA. Il gate risponde alla
// domanda «questa foto può entrare?»; qui si risponde all'altra metà, che nessuno
// stava facendo: «questa foto può ancora stare qui?».
//
// LA DECISIONE DEL TITOLARE RESTA IN PIEDI, E DIVENTA VERA. Il 2026-07-31 il
// titolare ha deciso che `news` è pubblico — «è un blog rivolto all'esterno e un
// link firmato scadrebbe» — e che «ci vanno SOLO i media editoriali; le foto dei
// bambini restano in `gallery`, privato». La regola c'era: non la faceva
// rispettare niente. Da qui in avanti la fa rispettare questo modulo, dai due
// capi: nel bucket pubblico un media ci ENTRA solo dopo il gate del consenso
// (`promuoviMediaBozza`) e ci RESTA solo finché quel consenso regge. Nel momento
// in cui cade — revoca, oblio, riga dell'alunno sparita — il post si ritira e il
// file esce dal bucket.
//
// PERCHÉ IL FILE SI TOGLIE, E NON BASTA NASCONDERE IL POST. Il bucket è pubblico:
// l'indirizzo diretto continua a servire l'immagine anche quando la riga è
// `nascosta`. Un ritiro che lascia il file al suo posto è un ritiro dichiarato,
// non un ritiro — ed è esattamente la specie di «fatto» che questo repository ha
// già pagato una volta con le email che non arrivavano. E l'ordine conta: PRIMA
// il file (verificato), POI la riga — il perché sta sopra `ritiraPost`.
//
// L'ASIMMETRIA COL GATE, che è voluta. Il gate è fail-CLOSED sull'incertezza: se
// non riesce a leggere il consenso, rifiuta di pubblicare — un gesto neutro, che
// si annulla riprovando. Qui il gesto è DISTRUTTIVO (i file escono dal bucket e
// non tornano), quindi davanti a un guasto di lettura non si ritira niente: si
// grida a livello `error` e si lascia il mondo com'è. «Non lo so» non vale «sì»,
// ma non vale nemmeno «demolisci».
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { percorsoNelBucket } from '@/lib/allegati/storage'
import { rimuoviEVerifica, bloccanti } from '@/lib/storage/rimozione-verificata'
import { NEWS_BUCKET } from './tipi'
import { schemaAssente } from './schema-assente'
import { perOgniStringa } from './media-bozza'

/** Colonna di `alunni` che registra il consenso per il canale pubblico. */
const COLONNA_CONSENSO_SITO = 'consenso_foto_sito'

/**
 * Gli stati in cui un post è visibile al pubblico, o lo sarà senza che nessuno
 * ci rimetta le mani.
 *
 * `programmata` è qui per una ragione precisa: il tick promuove le programmate
 * scadute a `pubblicata` SENZA passare da nessun gate. Il consenso era controllato
 * su tre rotte (`news:POST`, `news/[id]:PATCH`, `news/[id]/pubblica:POST`) e su
 * una quarta strada — quella automatica — no. Verificando anche le programmate,
 * un post il cui consenso è caduto viene ritirato PRIMA che il tick lo pubblichi.
 */
export const STATI_ESPOSTI = ['pubblicata', 'programmata'] as const

/** La famiglia ha ritirato il consenso alla pubblicazione sul sito. */
export const MOTIVO_CONSENSO_REVOCATO = 'consenso-revocato'
/** Il minore è stato cancellato/anonimizzato, o la sua riga non esiste più. */
export const MOTIVO_OBLIO = 'oblio-minore'

/** Quanti post si esaminano per passata: il tick gira ogni 10 minuti. */
const LIMITE_POST = 200

/**
 * La forma dei percorsi che questa applicazione scrive nel bucket
 * (`uploads/<utente>/<file>`). Vale come vincolo, non come descrizione: un
 * valore che non ha questa forma non viene mai passato a una `remove()`.
 */
const FORMA_PERCORSO = /^uploads\/[^/]+\/[^/]+$/

interface PostPermanenza {
  id: string
  stato?: string | null
  bambini_ritratti?: unknown
  copertina_url?: unknown
  contenuto_json?: unknown
}

export interface EsitoPermanenza {
  /** `false` se lo schema della dichiarazione non esiste (DB E2E non migrato). */
  disponibile: boolean
  /**
   * `false` se il consenso NON è stato riletto per un guasto: chi chiama non può
   * concludere «tutto in regola». Il tick, per esempio, in quel caso non pubblica
   * le programmate — non pubblicare è recuperabile, pubblicare senza consenso no.
   */
  verificato: boolean
  esaminati: number
  ritirati: number
  fileRimossi: number
  fileNonRimossi: number
}

const vuoto = (): EsitoPermanenza => ({
  disponibile: true,
  verificato: true,
  esaminati: 0,
  ritirati: 0,
  fileRimossi: 0,
  fileNonRimossi: 0,
})

/** Gli uuid dichiarati come ritratti, senza duplicati e senza valori vuoti. */
function ritrattiDi(post: PostPermanenza): string[] {
  const v = post.bambini_ritratti
  if (!Array.isArray(v)) return []
  return [...new Set(v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => x.length > 0))]
}

/**
 * Il percorso nel bucket pubblico, se il valore ne indica davvero un oggetto.
 *
 * Severo di proposito, e il primo test scritto su questa funzione l'ha
 * dimostrato: qui dentro passa OGNI stringa del rich-text — testo scritto a mano
 * da chi redige l'articolo — e a valle c'è una `remove()` sul bucket pubblico
 * eseguita col service-role. `percorsoNelBucket` da solo NON basta: su una
 * stringa che non è un URL restituisce la stringa stessa come percorso, quindi
 * bastava scrivere `uploads/qualcuno/qualcosa` dentro un articolo per far
 * cancellare l'immagine di un altro.
 *
 * Perciò si pretende il marcatore dello Storage di QUESTO bucket — la stessa
 * scelta di `pathBozza` per l'area di sosta — e in più la forma che questa
 * applicazione produce (`uploads/<utente>/<file>`, mai un `..`).
 */
export function percorsoPubblicoNews(valore: unknown): string | null {
  if (typeof valore !== 'string') return null
  const v = valore.trim()
  if (!v || !/^https?:\/\//i.test(v)) return null
  const p = percorsoNelBucket(NEWS_BUCKET, v)
  return p && FORMA_PERCORSO.test(p) && !p.includes('..') ? p : null
}

/**
 * Tutti gli oggetti del bucket pubblico citati dal post: la copertina e le
 * immagini del rich-text. Senza duplicati — la stessa foto può stare in
 * entrambi, e chiedere due volte la stessa `remove()` farebbe contare due volte
 * un file solo.
 */
export function percorsiPubbliciDelPost(post: {
  copertina_url?: unknown
  contenuto_json?: unknown
}): string[] {
  const trovati = new Set<string>()
  const dallaCopertina = percorsoPubblicoNews(post.copertina_url)
  if (dallaCopertina) trovati.add(dallaCopertina)
  perOgniStringa(post.contenuto_json, (s) => {
    const p = percorsoPubblicoNews(s)
    if (p) trovati.add(p)
  })
  return [...trovati]
}

/**
 * Ritira un post dalla vista pubblica e toglie i suoi file dal bucket.
 *
 * ─── PRIMA IL FILE (VERIFICATO), POI LA RIGA ────────────────────────────────
 *
 * È l'ordine che il repo ha adottato il 2026-08-02 (testata di
 * `rimuoviFileOblio` in `@/lib/gdpr/esegui`), e qui la ragione è ancora più
 * stretta che nell'oblio. Nascondere prima la riga significherebbe:
 *  · se poi la `remove()` fallisce, la foto resta a un indirizzo PUBBLICO —
 *    guasto invisibile, esattamente quello che questo modulo esiste per chiudere;
 *  · e il post, passato a `nascosta`, esce dagli stati esposti: nessuna passata
 *    futura lo riprenderebbe. Il guasto invisibile diventerebbe PERMANENTE.
 * Al contrario, togliere il file e fallire l'aggiornamento lascia un articolo con
 * l'immagine rotta: visibile, correggibile, e la foto del bambino è già sparita.
 *
 * Perciò, se dopo la rimozione restano file «ancora presenti» o «incerti», la
 * riga NON si tocca: il tick successivo ritenta tutto da capo. È la stessa regola
 * che `rimuoviEVerifica` impone all'oblio — «chi ha chiamato non deve cancellare
 * la riga» — applicata al ritiro.
 */
async function ritiraPost(
  supabase: SupabaseClient,
  post: PostPermanenza,
  motivo: string,
  op: string,
  ritrattiRimanenti?: string[],
): Promise<{ ritirato: boolean; rimossi: number; nonRimossi: number }> {
  const percorsi = percorsiPubbliciDelPost(post)

  // La regola su cosa significa un `remove()` incompleto vive in un posto solo:
  // si verifica lo STATO dei file, non il conteggio. Un file già assente è esito
  // raggiunto; un file ancora presente è un guasto e blocca.
  const esito = await rimuoviEVerifica(supabase, NEWS_BUCKET, percorsi, op)
  const fermi = esito.erroreRimozione ? percorsi : bloccanti(esito)
  if (fermi.length > 0) {
    // `rimuoviEVerifica` ha già scritto la riga nel canale degli errori, col
    // corpo dell'errore del provider. Qui si aggiunge il solo fatto che manca:
    // QUALE post resta pubblico per questo motivo.
    logEvento('news', 'error', {
      operazione: op,
      esito: 'ritiro-sospeso-file-non-usciti',
      post_id: post.id,
      n_file: fermi.length,
      msg: `${op}: il post resta pubblicato perché ${fermi.length} file non sono usciti dal bucket`,
    })
    return { ritirato: false, rimossi: esito.rimossi.length, nonRimossi: fermi.length }
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (STATI_ESPOSTI.includes((post.stato ?? '') as (typeof STATI_ESPOSTI)[number])) {
    patch.stato = 'nascosta'
    patch.nascosta_motivo = motivo
  }
  if (ritrattiRimanenti) patch.bambini_ritratti = ritrattiRimanenti

  // PostgREST non lancia: ritorna `{ error }`. Un try/catch qui non scatterebbe mai.
  const { error } = await supabase.from('news_posts').update(patch).eq('id', post.id)
  if (error) {
    logEvento('news', 'error', {
      operazione: op,
      esito: 'ritiro-non-riuscito',
      post_id: post.id,
      n_file: esito.rimossi.length,
      msg: `${op}: file rimossi ma il post è rimasto pubblicato con l'immagine rotta`,
    }, error)
    return { ritirato: false, rimossi: esito.rimossi.length, nonRimossi: 0 }
  }

  // Nel log solo il post e i conteggi: gli uuid dei bambini restano fuori.
  logEvento('news', 'warn', {
    operazione: op,
    esito: `ritirato-${motivo}`,
    post_id: post.id,
    n_file: esito.rimossi.length,
  })
  return { ritirato: true, rimossi: esito.rimossi.length, nonRimossi: 0 }
}

/**
 * Rilegge il consenso di TUTTI i post esposti che dichiarano bambini ritratti e
 * ritira quelli il cui consenso non regge più.
 *
 * Tre condizioni, tutte trattate come «il consenso non c'è più»:
 *  · `consenso_foto_sito` non è più `true` → la famiglia ha REVOCATO;
 *  · `anonimizzato_il` valorizzato → l'oblio è stato eseguito. `patchAlunno` NON
 *    tocca la colonna del consenso: guardare solo la spunta lascerebbe online la
 *    foto di un bambino cancellato, che è precisamente il difetto #1;
 *  · la riga non torna indietro → il minore non esiste più. Fail-closed: un id
 *    che non si sa spiegare non autorizza niente.
 */
export async function verificaPermanenzaConsenso(supabase: SupabaseClient, op: string): Promise<EsitoPermanenza> {
  const esito = vuoto()

  const { data, error } = await supabase
    .from('news_posts')
    .select('id, stato, bambini_ritratti, copertina_url, contenuto_json')
    .in('stato', [...STATI_ESPOSTI])
    .not('bambini_ritratti', 'is', null)
    .limit(LIMITE_POST)
  if (error) {
    if (schemaAssente(error)) {
      // DB E2E della CI non migrato: la dichiarazione non esiste, quindi non c'è
      // nessun consenso da rileggere. Si degrada in silenzio, come ovunque.
      logEvento('news', 'info', { operazione: op, esito: 'schema-assente' })
      return { ...esito, disponibile: false }
    }
    logEvento('news', 'error', { operazione: op, esito: 'post-non-riletti' }, error)
    return { ...esito, verificato: false }
  }

  const posts = ((data ?? []) as PostPermanenza[]).filter((p) => ritrattiDi(p).length > 0)
  esito.esaminati = posts.length
  if (posts.length === 0) {
    // Evento critico → si logga anche il SUCCESSO: senza questa riga «nessun log»
    // direbbe insieme «tutto in regola» e «la sorveglianza non è mai partita».
    logEvento('news', 'info', { operazione: op, esito: 'permanenza-verificata', n_post: 0, n_ritirati: 0 })
    return esito
  }

  const ids = [...new Set(posts.flatMap(ritrattiDi))]
  const { data: rows, error: errAlunni } = await supabase
    .from('alunni')
    .select(`id, ${COLONNA_CONSENSO_SITO}, anonimizzato_il`)
    .in('id', ids)
  if (errAlunni) {
    if (schemaAssente(errAlunni)) {
      logEvento('news', 'info', { operazione: op, esito: 'schema-assente', n_post: posts.length })
      return { ...esito, disponibile: false }
    }
    // Il consenso NON è stato riletto: non si ritira niente (il gesto è
    // irreversibile) e non si tace (chi legge i log deve poter distinguere
    // «verificato, tutto a posto» da «non ho potuto guardare»).
    logEvento('news', 'error', { operazione: op, esito: 'consensi-non-riletti', n_post: posts.length }, errAlunni)
    return { ...esito, verificato: false }
  }

  const perId = new Map(
    ((rows ?? []) as Record<string, unknown>[]).map((r) => [String(r.id), r]),
  )

  for (const post of posts) {
    let motivo: string | null = null
    for (const id of ritrattiDi(post)) {
      const r = perId.get(id)
      if (!r || r.anonimizzato_il != null) {
        motivo = MOTIVO_OBLIO
        break
      }
      if (r[COLONNA_CONSENSO_SITO] !== true) motivo = MOTIVO_CONSENSO_REVOCATO
    }
    if (!motivo) continue
    const r = await ritiraPost(supabase, post, motivo, op)
    if (r.ritirato) esito.ritirati++
    esito.fileRimossi += r.rimossi
    esito.fileNonRimossi += r.nonRimossi
  }

  logEvento('news', 'info', {
    operazione: op,
    esito: 'permanenza-verificata',
    n_post: esito.esaminati,
    n_ritirati: esito.ritirati,
    n_file: esito.fileRimossi,
  })
  return esito
}

/**
 * L'oblio del minore applicato al blog pubblico: i post che lo ritraggono escono
 * dalla vista, i loro file escono dal bucket e il suo uuid sparisce dalla
 * dichiarazione.
 *
 * DIFFERENZA VOLUTA DALLA GALLERIA. Lì una foto di gruppo resta e si toglie solo
 * il tag, perché quel bucket è privato e la foto la vedono solo le famiglie dei
 * bambini ritratti: l'oblio di uno non autorizza a cancellare il dato altrui. Qui
 * l'indirizzo è PUBBLICO, e lasciare il file vorrebbe dire lasciare online
 * l'immagine di chi ha chiesto la cancellazione. Esce il file, resta il post
 * (nascosto) con gli altri uuid al loro posto: la scuola può ripubblicarlo con
 * una copertina nuova.
 *
 * NON è ancora chiamata da `anonimizzaAlunno` — vedi la voce `news` di
 * `REGISTRO_BUCKET_OBLIO`: la copertura di oggi passa dal tick, che rilegge il
 * consenso ogni 10 minuti e vede l'`anonimizzato_il` appena scritto. Questa
 * funzione è il gancio per rendere la cosa SINCRONA quando la si aggancerà lì.
 */
export async function obliaFotoNewsAlunno(
  supabase: SupabaseClient,
  alunnoId: string,
  op: string,
): Promise<{ ritirati: number; fileRimossi: number; fileNonRimossi: number }> {
  const conteggio = { ritirati: 0, fileRimossi: 0, fileNonRimossi: 0 }
  const id = (alunnoId ?? '').trim()
  if (!id) return conteggio

  const { data, error } = await supabase
    .from('news_posts')
    .select('id, stato, bambini_ritratti, copertina_url, contenuto_json')
    .contains('bambini_ritratti', [id])
  if (error) {
    if (!schemaAssente(error)) {
      logEvento('news', 'error', { operazione: op, esito: 'oblio-news-post-non-letti' }, error)
    }
    return conteggio
  }

  const posts = ((data ?? []) as PostPermanenza[]).filter((p) => ritrattiDi(p).includes(id))
  for (const post of posts) {
    const altri = ritrattiDi(post).filter((x) => x !== id)
    const r = await ritiraPost(supabase, post, MOTIVO_OBLIO, op, altri)
    if (r.ritirato) conteggio.ritirati++
    conteggio.fileRimossi += r.rimossi
    conteggio.fileNonRimossi += r.nonRimossi
  }
  return conteggio
}
