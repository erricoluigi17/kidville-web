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

/** Tutti i percorsi in sosta citati da copertina e rich-text, senza duplicati. */
function raccogliBozze(copertinaUrl: unknown, contenutoJson: unknown): string[] {
  const trovati = new Set<string>()
  const dallaCopertina = pathBozza(copertinaUrl)
  if (dallaCopertina) trovati.add(dallaCopertina)
  mappaStringhe(
    contenutoJson,
    (s) => {
      const p = pathBozza(s)
      if (p) trovati.add(p)
      return s
    },
    0,
  )
  return [...trovati]
}

export interface EsitoPromozione {
  copertinaUrl: unknown
  contenutoJson: unknown
  /** Quanti file sono stati spostati nel bucket pubblico. */
  promossi: number
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
    return { copertinaUrl: input.copertinaUrl, contenutoJson: input.contenutoJson, promossi: 0, errore: false }
  }

  const pubblici = new Map<string, string>()
  let promossi = 0
  for (const percorso of percorsi) {
    const { error } = await supabase.storage
      .from(NEWS_BUCKET_BOZZE)
      .move(percorso, percorso, { destinationBucket: NEWS_BUCKET })
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
          errore: true,
        }
      }
    } else {
      promossi++
    }
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
    errore: false,
  }
}
