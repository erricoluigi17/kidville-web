// =============================================================================
// L'AREA DI SOSTA DEI MEDIA — un file diventa pubblico DOPO il consenso, non prima.
//
// IL DIFETTO (collaudo del 2026-08-01). `POST /api/news/upload` scriveva dritto
// nel bucket `news`, che è pubblico per decisione del titolare, e restituiva
// `getPublicUrl`. Da quell'istante la foto era leggibile da chiunque conoscesse
// l'indirizzo — niente login, niente ruolo, niente sede — e ci restava anche
// quando il gate del consenso rifiutava la pubblicazione: il gate proteggeva la
// RIGA, non il FILE, e arrivava comunque dopo.
//
// LE DUE STRADE, e perché questa.
//  (1) Lasciare l'upload nel bucket pubblico e cancellare il file se la
//      pubblicazione non va a buon fine. Non chiude il difetto: fra il
//      caricamento e il rifiuto la foto è pubblica lo stesso, e non copre
//      affatto il caso più comune — l'operatore carica l'immagine, ci ripensa e
//      chiude l'editor. Nessuna riga la nomina, nessuna cancellazione parte, e
//      quel file resta pubblico per sempre.
//  (2) Caricare in un'area NON pubblica e spostare il file solo dopo che il gate
//      del consenso è passato. La pubblicità diventa la CONSEGUENZA del consenso
//      verificato invece che la sua premessa.
// È implementata la (2). Costa un bucket in più e uno spostamento; in cambio non
// esiste più nessun istante in cui la foto di un bambino sta su un indirizzo
// pubblico senza che qualcuno abbia verificato il consenso.
//
// DEGRADAZIONE DICHIARATA. Il bucket privato è dichiarato in
// `supabase/migrations/20260801143000_bucket_news_bozze.sql`, che come tutte le
// migrazioni di questo ciclo NON è applicata da chi l'ha scritta (in produzione
// ci sono dati reali di minori: si applica con l'approvazione del titolare).
// Finché non lo è, l'upload ricade sul bucket pubblico e lo dice a livello
// `error`: una funzione che continua a funzionare male in modo rumoroso è
// preferibile a una che si spegne in silenzio il giorno del rilascio.
// =============================================================================

import { logErrore, logEvento } from '@/lib/logging/logger'
import { NEWS_BUCKET } from './tipi'

/** Bucket PRIVATO dove sostano i media finché il consenso non è verificato. */
export const NEWS_BUCKET_BOZZE = 'news_bozze'

/**
 * Durata dell'indirizzo firmato che l'editor usa per l'anteprima: 7 giorni.
 *
 * Non finisce mai dentro una riga di `news_posts` — la promozione riscrive gli
 * indirizzi con quelli definitivi prima dell'insert — quindi la scadenza limita
 * solo quanto a lungo un'anteprima resta visibile in un editor lasciato aperto.
 */
export const SCADENZA_ANTEPRIMA_SECONDI = 60 * 60 * 24 * 7

/** Profondità massima di ricorsione nel rich-text: il JSON arriva dal client. */
const PROFONDITA_MAX = 30

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Storage = { storage: { from: (b: string) => any } }

/**
 * Il percorso dentro il bucket privato, se l'indirizzo punta a un media ancora
 * in sosta. `null` per qualunque altro indirizzo — compresi quelli già pubblici,
 * che non vanno toccati.
 *
 * Si riconosce il SEGMENTO `/news_bozze/`, non il prefisso dell'indirizzo: la
 * stessa funzione deve valere per `/object/sign/news_bozze/…` (l'anteprima
 * firmata) e per `/object/news_bozze/…`, e non deve dipendere dal dominio del
 * progetto Supabase, che cambia fra produzione e collaudo.
 */
export function pathBozza(url: unknown): string | null {
  if (typeof url !== 'string') return null
  const marcatore = `/${NEWS_BUCKET_BOZZE}/`
  const i = url.indexOf(marcatore)
  if (i < 0) return null
  const dopo = url.slice(i + marcatore.length)
  const senzaQuery = dopo.split('?')[0].split('#')[0]
  if (!senzaQuery) return null
  // Il percorso arriva da un campo del CLIENT, e finisce dritto in una `move()`
  // eseguita col service-role. Si accetta soltanto la forma che questa route
  // produce (`uploads/<utente>/<file>`) e mai un `..`: senza questo vincolo,
  // bastava scrivere l'indirizzo a mano nel corpo della richiesta per far
  // spostare nel bucket PUBBLICO un file qualunque dell'area di sosta.
  if (!/^uploads\/[^/]+\/[^/]+$/.test(senzaQuery) || senzaQuery.includes('..')) return null
  try {
    return decodeURIComponent(senzaQuery)
  } catch {
    // Un `%` isolato fa lanciare `decodeURIComponent`. Il percorso grezzo è
    // comunque quello con cui lo Storage lo ha salvato: si prosegue con quello
    // invece di perdere il file — e si lascia detto che è successo.
    logEvento('news', 'warn', { operazione: 'pathBozza', esito: 'percorso-non-decodificabile' })
    return senzaQuery
  }
}

/** Applica `f` a ogni stringa dell'albero, ricostruendo la struttura. */
function mappaStringhe(nodo: unknown, f: (s: string) => string, prof: number): unknown {
  if (prof > PROFONDITA_MAX || nodo == null) return nodo
  if (typeof nodo === 'string') return f(nodo)
  if (Array.isArray(nodo)) return nodo.map((n) => mappaStringhe(n, f, prof + 1))
  if (typeof nodo !== 'object') return nodo
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(nodo as Record<string, unknown>)) {
    out[k] = mappaStringhe(v, f, prof + 1)
  }
  return out
}

/**
 * Visita ogni stringa dell'albero, con lo STESSO limite di ricorsione di
 * `mappaStringhe` — che è il punto: il JSON arriva dal client, e il tetto alla
 * profondità è una difesa, non un dettaglio. Sta qui, esportata, perché la stessa
 * passeggiata serve anche a `./permanenza-consenso.ts` (che cerca i file già
 * promossi nel bucket pubblico) e due copie divergerebbero alla prima modifica.
 */
export function perOgniStringa(nodo: unknown, f: (s: string) => void): void {
  mappaStringhe(
    nodo,
    (s) => {
      f(s)
      return s
    },
    0,
  )
}

/**
 * La gemella che RISCRIVE invece di limitarsi a guardare, con lo stesso tetto di
 * ricorsione e la stessa passeggiata.
 *
 * La usa `permanenza-consenso.ts` dopo un ritiro, per togliere dal rich-text gli
 * indirizzi dei file che non esistono più: una riga che continua a nominare un
 * file cancellato risponde «io lo uso» alla prossima domanda «c'è ancora qualcuno
 * che lo nomina?», e trattiene nel bucket pubblico la foto di un altro bambino.
 * Sta qui e non là per il motivo scritto sopra: due copie della stessa passeggiata
 * divergerebbero alla prima modifica.
 */
export function mappaOgniStringa(nodo: unknown, f: (s: string) => string): unknown {
  return mappaStringhe(nodo, f, 0)
}

/** Tutti i percorsi in sosta citati da copertina e rich-text, senza duplicati. */
function raccogliBozze(copertinaUrl: unknown, contenutoJson: unknown): string[] {
  const trovati = new Set<string>()
  const dallaCopertina = pathBozza(copertinaUrl)
  if (dallaCopertina) trovati.add(dallaCopertina)
  perOgniStringa(contenutoJson, (s) => {
    const p = pathBozza(s)
    if (p) trovati.add(p)
  })
  return [...trovati]
}

export interface EsitoPromozione {
  copertinaUrl: unknown
  contenutoJson: unknown
  /** Quanti file sono stati spostati nel bucket pubblico. */
  promossi: number
  /**
   * I percorsi che QUESTA chiamata ha spostato nel bucket pubblico.
   *
   * Serve al chiamante per annullare (`riportaMediaInBozza`) quando la riga poi
   * non si scrive: senza l'elenco, l'unico modo di indovinare quali file siano
   * appena diventati pubblici sarebbe la differenza fra prima e dopo — che
   * comprende anche gli indirizzi pubblici già esistenti citati nel corpo della
   * richiesta, cioè i file di UN ALTRO post. Annullare a occhio significherebbe
   * cancellare l'immagine di qualcun altro.
   *
   * Contiene solo gli spostamenti RIUSCITI: un file «già promosso» da un
   * tentativo precedente non appartiene a questa chiamata e non si tocca.
   */
  promossiPercorsi: string[]
  /** `true` se almeno uno spostamento è fallito: il chiamante NON deve scrivere. */
  errore: boolean
}

/**
 * Sposta nel bucket pubblico i media ancora in sosta e riscrive gli indirizzi.
 *
 * Va chiamata SOLO dopo che il gate del consenso è passato. In caso di errore
 * ritorna `errore: true` e il chiamante deve rifiutare la scrittura: una riga
 * salvata con un indirizzo firmato mostrerebbe un'immagine che scade, una salvata
 * con l'indirizzo pubblico di un file rimasto privato mostrerebbe un'immagine
 * rotta. Entrambe sarebbero guasti silenziosi scoperti dalle famiglie.
 */
export async function promuoviMediaBozza(
  supabase: Storage,
  input: { copertinaUrl: unknown; contenutoJson: unknown },
  operazione: string,
): Promise<EsitoPromozione> {
  const percorsi = raccogliBozze(input.copertinaUrl, input.contenutoJson)
  if (percorsi.length === 0) {
    return {
      copertinaUrl: input.copertinaUrl,
      contenutoJson: input.contenutoJson,
      promossi: 0,
      promossiPercorsi: [],
      errore: false,
    }
  }

  const pubblici = new Map<string, string>()
  const promossiPercorsi: string[] = []
  let promossi = 0
  for (const percorso of percorsi) {
    // ─── IL GUASTO DI TRASPORTO NON PUÒ PORTARSI VIA L'ELENCO ────────────────
    // `move()` può LANCIARE invece di ritornare `{ error }` (rete caduta, fetch
    // rigettato): lo sa già `riportaMediaInBozza`, che ha un `catch` apposta.
    // Qui l'eccezione sarebbe peggio, perché uscendo dalla funzione si porterebbe
    // via `promossiPercorsi` — l'UNICO elenco da cui il chiamante sa che cosa ha
    // appena reso pubblico. I file già spostati resterebbero nel bucket `news`
    // con nessuna riga che li nomini, cioè esattamente il difetto (W1-bis) che
    // questa coppia di funzioni esiste per chiudere, riaperto dalla via d'uscita
    // che nessuno guarda. Si degrada perciò a `errore: true` con l'elenco intatto:
    // il chiamante rifiuta la scrittura e rimette in sosta ciò che è uscito.
    let esitoMove: { error?: unknown }
    try {
      esitoMove = await supabase.storage
        .from(NEWS_BUCKET_BOZZE)
        .move(percorso, percorso, { destinationBucket: NEWS_BUCKET })
    } catch (e) {
      // Il corpo dell'errore non si butta via nemmeno quando arriva come eccezione.
      logErrore({ operazione, evento: 'storage', stato: 503 }, e)
      return {
        copertinaUrl: input.copertinaUrl,
        contenutoJson: input.contenutoJson,
        promossi,
        promossiPercorsi,
        errore: true,
      }
    }
    const error = esitoMove.error
    if (error) {
      const messaggio = (error as { message?: string }).message ?? ''
      // Già promosso da una chiamata precedente (una modifica ripetuta sullo
      // stesso post): non è un errore, ma non è nemmeno silenzio — la riga di
      // log distingue «spostato adesso» da «era già di là».
      if (/not found|does not exist/i.test(messaggio)) {
        logEvento('news', 'warn', { operazione, esito: 'media-gia-promosso' })
      } else {
        // Il corpo dell'errore dello Storage non si butta via: senza, resterebbe
        // un 503 che non dice a nessuno perché.
        logErrore({ operazione, evento: 'storage', stato: 503 }, error)
        return {
          copertinaUrl: input.copertinaUrl,
          contenutoJson: input.contenutoJson,
          promossi,
          promossiPercorsi,
          errore: true,
        }
      }
    } else {
      promossi++
      promossiPercorsi.push(percorso)
    }
    // IL BUCKET È QUELLO DI DESTINAZIONE, non quello di sosta: la `move()` qui sopra
    // ha già portato il file in `NEWS_BUCKET`. Chiedendo l'indirizzo a
    // `NEWS_BUCKET_BOZZE` si otteneva un URL che non corrisponde a nessun file — ma
    // il guaio vero non è l'immagine rotta. `percorsoPubblicoNews`
    // (`./permanenza-consenso`) riconosce SOLO il marcatore di `NEWS_BUCKET`: una riga
    // che nomina il bucket di sosta viene scartata, `percorsiPubbliciDelPost` torna
    // vuoto, e revoca del consenso, oblio del minore e `DELETE` non arrivano più al
    // file — che intanto è PUBBLICO. È la stessa classe di V4/W1/X1, rientrata dalla
    // porta della promozione. Il legame fra le due funzioni è ora fissato da un test
    // (`__tests__/lib/news/media-bozza-promozione-oblio.test.ts`), perché un controllo
    // sulla sola stringa dell'indirizzo vede il sintomo e non la conseguenza.
    const { data } = supabase.storage.from(NEWS_BUCKET).getPublicUrl(percorso)
    pubblici.set(percorso, data.publicUrl)
  }

  const riscrivi = (s: string): string => {
    const p = pathBozza(s)
    const pubblico = p ? pubblici.get(p) : undefined
    return pubblico ?? s
  }

  // Evento critico → si logga anche il SUCCESSO: senza, «nessun log» non
  // distinguerebbe «promosso» da «non è mai partita nessuna promozione».
  // `n_promossi` e non `n_media`: la redazione dei log tratta la radice `media`
  // come un dato sensibile (è la MEDIA dei voti di un alunno — `redact.ts:61`), e
  // il conteggio arrivava in `app_log` come `[redatto]`. Cioè proprio il numero che
  // dice se la promozione ha funzionato spariva dal log che serve a verificarlo.
  // La lista è a lista bianca e non si allarga «perché sarebbe comodo»: si cambia
  // il nome del campo, che è la parte nostra.
  logEvento('news', 'info', { operazione, esito: 'media-promossi', n_promossi: promossi })

  return {
    copertinaUrl: typeof input.copertinaUrl === 'string' ? riscrivi(input.copertinaUrl) : input.copertinaUrl,
    contenutoJson: mappaStringhe(input.contenutoJson, riscrivi, 0),
    promossi,
    promossiPercorsi,
    errore: false,
  }
}

/**
 * Rimette in sosta i media che una scrittura mancata ha lasciato pubblici.
 *
 * ─── IL DIFETTO CHE CHIUDE (W1-bis, 2026-08-03) ─────────────────────────────
 *
 * La promozione avviene PRIMA della scrittura della riga, e deve essere così: il
 * contenuto salvato deve citare gli indirizzi definitivi. Ma se poi la riga non
 * si scrive — vincolo violato, database irraggiungibile, promozione fallita a
 * metà — quei file sono già nel bucket PUBBLICO e non esiste nessuna riga che li
 * nomini. È lo stesso guasto di W1 preso dall'altro capo: revoca del consenso e
 * diritto all'oblio partono entrambi dalla riga, e su un file che nessuna riga
 * cita non arrivano più. Pubblico per sempre.
 *
 * ─── PERCHÉ SI RIPORTA INDIETRO E NON SI CANCELLA ───────────────────────────
 *
 * Perché `news_bozze` è esattamente il posto in cui quei file devono stare
 * finché una riga non li nomina: annullare lo spostamento rimette il mondo com'era
 * un istante prima, e l'operatore che ritenta il salvataggio ritrova il suo
 * lavoro. Cancellarli sembrerebbe più sicuro e sarebbe peggio: al secondo
 * tentativo il client rimanda lo stesso indirizzo di sosta, `promuoviMediaBozza`
 * troverebbe «not found», lo prenderebbe per «già promosso» e salverebbe nella
 * riga l'indirizzo pubblico di un oggetto che non esiste più — un'immagine rotta
 * scritta in silenzio, cioè un altro guasto invisibile al posto di quello tolto.
 *
 * Se nemmeno il ritorno riesce, il file resta pubblico e senza padrone: non c'è
 * niente di meglio da fare, ma si GRIDA — con il corpo dell'errore dello Storage
 * e col conteggio — perché è l'unico modo in cui qualcuno potrà ripulirlo.
 */
export async function riportaMediaInBozza(
  supabase: Storage,
  percorsi: string[],
  operazione: string,
): Promise<{ riportati: number; falliti: number }> {
  const unici = [...new Set(percorsi.filter((p) => typeof p === 'string' && p.trim() !== ''))]
  if (unici.length === 0) return { riportati: 0, falliti: 0 }

  let riportati = 0
  let falliti = 0
  for (const percorso of unici) {
    try {
      const { error } = await supabase.storage
        .from(NEWS_BUCKET)
        .move(percorso, percorso, { destinationBucket: NEWS_BUCKET_BOZZE })
      if (error) {
        falliti++
        // Il corpo dell'errore del provider non si butta via: uno status da solo
        // non dice a nessuno perché un file di un minore è rimasto pubblico.
        logErrore({ operazione, evento: 'storage', stato: 503 }, error)
      } else {
        riportati++
      }
    } catch (e) {
      // Guasto di TRASPORTO: `move()` non ritorna, lancia. Stesso trattamento e
      // stessa visibilità dell'errore restituito — un catch muto qui sarebbe il
      // guasto invisibile che questa funzione esiste per impedire.
      falliti++
      logErrore({ operazione, evento: 'storage', stato: 503 }, e)
    }
  }

  if (falliti > 0) {
    logEvento('news', 'error', {
      operazione,
      esito: 'media-rimasti-pubblici',
      n_file: falliti,
      msg: `${operazione}: ${falliti} file sono rimasti nel bucket pubblico e nessuna riga li nomina`,
    })
  } else {
    // Evento critico → si logga anche il SUCCESSO: «nessun log» non deve poter
    // significare insieme «annullato» e «l'annullamento non è mai partito».
    logEvento('news', 'info', { operazione, esito: 'media-riportati-in-sosta', n_file: riportati })
  }
  return { riportati, falliti }
}
