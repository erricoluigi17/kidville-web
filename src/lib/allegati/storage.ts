// Allegati di AVVISI e INCARICHI — i bucket `avvisi_allegati` e `task_allegati`,
// che dal 2026-07-31 sono PRIVATI.
//
// PERCHÉ. Fino a quella data erano `public: true` e nel database finiva
// l'indirizzo restituito da `getPublicUrl`: chiunque avesse — o indovinasse —
// quell'URL scaricava l'allegato di una comunicazione scolastica SENZA LOGIN e
// PER SEMPRE. Il gate di ruolo (`requireDocente`/`requireUser`) e l'isolamento
// per sede giravano tutti sul database, mai sul file: bastava uscire
// dall'applicazione per aggirarli in un colpo solo. Un avviso può portarsi
// dietro il modulo di una gita con i nomi dei bambini, un certificato, un
// verbale: non è materia pubblica.
//
// COME. Nel dato si conserva il PERCORSO nel bucket (`<timestamp>-<rnd>.pdf`) e
// la lettura genera un link FIRMATO a tempo, dietro allo stesso gate della route
// che lo serve. È esattamente il modello della galleria
// (`src/lib/gallery/storage.ts`), riusato: stessa scadenza, stessa gestione
// dell'errore, stesso logging. Una seconda forma inventata qui sarebbe una
// seconda cosa da tenere allineata.
//
// I link si generano IN BLOCCO (`createSignedUrls`, plurale): una chiamata per
// pagina di avvisi o di incarichi, non una per allegato.

import { logEvento } from '@/lib/logging/logger'
import { TTL_FIRMA_GALLERIA_S } from '@/lib/gallery/storage'

/** Allegati degli avvisi (bacheca famiglie e cockpit). Privato. */
export const BUCKET_AVVISI_ALLEGATI = 'avvisi_allegati'

/** Allegati degli incarichi interni allo staff. Privato. */
export const BUCKET_TASK_ALLEGATI = 'task_allegati'

/**
 * Durata del link firmato: la STESSA della galleria (10 minuti).
 *
 * Non è un numero scelto qui: è importato dal modello, così se un giorno si
 * decide che dieci minuti sono troppi o troppo pochi, il posto dove cambiarlo
 * resta uno solo.
 */
export const TTL_FIRMA_ALLEGATI_S = TTL_FIRMA_GALLERIA_S

// `decodeURIComponent` LANCIA su sequenze percentuali malformate (`50%.pdf`), e
// un catch muto è vietato dal progetto: si decodifica solo quando la stringa è
// interamente ben formata (stessa scelta della galleria).
const PERCENTUALI_BEN_FORMATE = /^(?:[^%]|%[0-9a-fA-F]{2})*$/

function decodificaSicura(s: string): string {
  return PERCENTUALI_BEN_FORMATE.test(s) ? decodeURIComponent(s) : s
}

/**
 * Ricava il percorso nel bucket indicato da un valore salvato.
 *
 * Accetta le tre forme che convivono nel dato:
 *  - il PERCORSO (quello che si salva da oggi in poi): restituito com'è;
 *  - un URL PUBBLICO completo (le righe storiche, di quando il bucket era
 *    pubblico): se ne estrae il percorso;
 *  - un URL già FIRMATO (token ormai scaduto, per esempio rimandato indietro
 *    dal modulo di modifica): idem, il token si butta.
 *
 * Restituisce `null` per i valori vuoti e per gli indirizzi che NON appartengono
 * a questo bucket (un altro bucket, il sito del Comune): non sono firmabili qui,
 * e inventarsi un percorso sarebbe peggio che ammettere di non saperlo.
 */
export function percorsoNelBucket(bucket: string, valore: string | null | undefined): string | null {
  const v = (valore ?? '').trim()
  if (!v) return null

  if (/^https?:\/\//i.test(v)) {
    const re = new RegExp(`/storage/v1/object/(?:public|sign|authenticated)/${bucket}/([^?#]+)`)
    const m = re.exec(v)
    return m ? decodificaSicura(m[1]) : null
  }

  // Già un percorso: si normalizza solo lo slash iniziale, che lo Storage non
  // vuole (`/a.pdf` e `a.pdf` sono lo stesso oggetto solo per noi).
  return v.replace(/^\/+/, '') || null
}

// Il minimo indispensabile del client Supabase: il vero `SupabaseClient` lo
// soddisfa, e un test può passarne uno finto senza montare mezzo SDK.
export type ClientStorage = {
  storage: {
    from: (bucket: string) => {
      createSignedUrls: (
        percorsi: string[],
        ttl: number,
      ) => Promise<{
        data: Array<{ path: string | null; signedUrl: string | null; error?: string | null }> | null
        error: unknown
      }>
    }
  }
}

/**
 * Firma un blocco di percorsi e restituisce la mappa percorso → link firmato.
 *
 * Chi non si è potuto firmare NON compare nella mappa: chi chiama deve tradurlo
 * in `null`, mai nel percorso grezzo (che come indirizzo non funziona e
 * mascherebbe il guasto da «allegato rotto»). Ogni fallimento finisce nel log a
 * livello `error` **col corpo dell'errore del provider** (AGENTS §3): senza, si
 * saprebbe solo che qualcosa non ha firmato, non perché.
 *
 * ESPORTATA il 2026-08-01 perché la CHAT (`src/lib/chat/allegati.ts`) è uscita
 * dallo stesso difetto e usa lo stesso meccanismo. Non è una scorciatoia: il
 * commento in testa a questo file dice che «una seconda forma inventata altrove
 * sarebbe una seconda cosa da tenere allineata», e un terzo bucket che si firma
 * per conto suo — con un altro TTL, un altro log, un'altra gestione del
 * fallimento — è esattamente il modo in cui il difetto è sopravvissuto nella
 * chat mentre lo si chiudeva su avvisi e incarichi.
 */
export async function firmaPercorsi(
  supabase: ClientStorage,
  bucket: string,
  percorsi: string[],
  operazione: string,
): Promise<Map<string, string>> {
  const urlPerPercorso = new Map<string, string>()
  if (percorsi.length === 0) return urlPerPercorso

  let firmati: Array<{ path: string | null; signedUrl: string | null; error?: string | null }> = []
  try {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrls(percorsi, TTL_FIRMA_ALLEGATI_S)
    if (error) {
      // Nel log SOLO conteggi: il nome di un allegato dice di che comunicazione
      // si tratta. Il perché sta nell'errore del provider.
      logEvento('storage', 'error', {
        operazione,
        esito: 'firma-link-non-riuscita',
        bucket,
        n_percorsi: percorsi.length,
      }, error)
      return urlPerPercorso
    }
    firmati = data ?? []
  } catch (e) {
    // Guasto di TRASPORTO (il fetch che esplode prima di arrivare allo Storage):
    // `createSignedUrls` non ritorna, lancia. Senza questo ramo la bacheca
    // risponderebbe 500 e il genitore non vedrebbe più nemmeno il testo
    // dell'avviso.
    logEvento('storage', 'error', {
      operazione,
      esito: 'firma-link-non-riuscita',
      bucket,
      n_percorsi: percorsi.length,
    }, e)
    return urlPerPercorso
  }

  // Si indicizza per PERCORSO, non per posizione: l'API risponde con un elemento
  // per percorso, ma l'ordine non è parte del contratto.
  const motivi: string[] = []
  for (const f of firmati) {
    if (f?.signedUrl && !f.error) urlPerPercorso.set(f.path ?? '', f.signedUrl)
    else if (f?.error) motivi.push(f.error)
  }

  const mancanti = percorsi.filter((p) => !urlPerPercorso.has(p))
  if (mancanti.length > 0) {
    logEvento('storage', 'error', {
      operazione,
      esito: 'firma-link-parziale',
      bucket,
      n_percorsi: percorsi.length,
      n_falliti: mancanti.length,
    }, new Error(motivi.length > 0 ? motivi.join(' · ') : 'firma non restituita per uno o più file'))
  }

  return urlPerPercorso
}

// ─── AVVISI ──────────────────────────────────────────────────────────────────
//
// `avvisi.attachment_url` è una stringa che nel tempo ha preso due forme:
//  - un JSON `{"file": <allegato>, "link": <indirizzo esterno>}` (quella di
//    oggi, prodotta dal modulo di pubblicazione);
//  - una stringa nuda con il solo allegato (le righe più vecchie).
// Il `link` è un indirizzo altrui (il sito del Comune, un modulo online): non è
// nel nostro Storage e non si tocca. Solo `file` si firma.

type RigaAvviso = { attachment_url?: string | null }

function decodificaAllegatoAvviso(valore: string | null | undefined): { file: string | null; link: string | null; jsonOriginale: boolean } {
  const v = (valore ?? '').trim()
  if (!v) return { file: null, link: null, jsonOriginale: false }
  if (v.startsWith('{')) {
    try {
      const p = JSON.parse(v) as { file?: unknown; link?: unknown }
      return {
        file: typeof p.file === 'string' && p.file.trim() !== '' ? p.file : null,
        link: typeof p.link === 'string' && p.link.trim() !== '' ? p.link : null,
        jsonOriginale: true,
      }
    } catch (err) {
      // JSON malformato: si tratta come stringa nuda, che è il comportamento del
      // client (`AvvisoCard`) da sempre. Non è un guasto da svegliare qualcuno, è
      // un dato storico: se ci fosse un allegato, la firma qui sotto lo troverà
      // lo stesso — perciò `info` e non `error`.
      //
      // Ma la riga ci vuole, e il commento da solo non basta (AGENTS.md regola 6:
      // «se un errore è davvero ignorabile, lo si logga a livello info spiegando
      // perché»). Il valore NON si logga: `attachment_url` è un percorso, e in
      // questo repo un percorso è una credenziale. Esce solo la LUNGHEZZA (che
      // il valore cominciasse per `{` lo dice già il ramo in cui siamo): quel
      // tanto che basta ad accorgersi se un giorno il formato si rompe davvero.
      logEvento('storage', 'info', {
        operazione: 'decodificaAllegatoAvviso',
        esito: 'json-malformato-letto-come-stringa',
        lunghezza: v.length,
      }, err)
      return { file: v, link: null, jsonOriginale: false }
    }
  }
  return { file: v, link: null, jsonOriginale: false }
}

function ricomponiAllegatoAvviso(
  file: string | null,
  link: string | null,
  jsonOriginale: boolean,
): string | null {
  // Si conserva la FORMA di partenza: chi ha salvato un JSON rilegge un JSON
  // (`AvvisoCard` distingue le due forme dal primo carattere), chi aveva la
  // stringa nuda continua ad averla.
  if (jsonOriginale || link !== null) return JSON.stringify({ file, link })
  return file
}

/**
 * Sostituisce l'allegato di ogni avviso con un link FIRMATO a tempo, per tutte
 * le righe di una pagina, con UNA sola chiamata allo Storage.
 *
 * Chi non si è potuto firmare esce con `file: null`: l'allegato non compare, ma
 * il guasto è nel log — non diventa un link che risponde 400 in faccia a un
 * genitore.
 */
export async function firmaAllegatiAvvisi<T extends RigaAvviso>(
  supabase: ClientStorage,
  righe: T[],
  operazione: string,
): Promise<T[]> {
  const decodificate = righe.map((r) => decodificaAllegatoAvviso(r.attachment_url))
  const percorsoPerRiga = decodificate.map((d) => percorsoNelBucket(BUCKET_AVVISI_ALLEGATI, d.file))
  const percorsi = [...new Set(percorsoPerRiga.filter((p): p is string => p !== null))]
  // Niente da firmare (nessun allegato, o solo link esterni): lo Storage non si
  // tocca affatto.
  if (percorsi.length === 0) return righe

  const urlPerPercorso = await firmaPercorsi(supabase, BUCKET_AVVISI_ALLEGATI, percorsi, operazione)

  return righe.map((r, i) => {
    const p = percorsoPerRiga[i]
    if (p === null) return r
    const d = decodificate[i]
    return { ...r, attachment_url: ricomponiAllegatoAvviso(urlPerPercorso.get(p) ?? null, d.link, d.jsonOriginale) }
  })
}

/**
 * Riporta al PERCORSO l'allegato che il client rimanda in scrittura.
 *
 * Il modulo di modifica rilegge l'avviso (dove `file` è ormai un link firmato) e
 * lo rispedisce tale e quale: senza questa normalizzazione in tabella finirebbe
 * un indirizzo con un token già scaduto — lungo, illeggibile e inutile. La
 * lettura saprebbe comunque ricavarne il percorso, ma il dato archiviato deve
 * essere il dato giusto.
 */
export function normalizzaAllegatoAvviso(valore: string | null | undefined): string | null {
  const d = decodificaAllegatoAvviso(valore)
  if (d.file === null && d.link === null) return null
  // `percorsoNelBucket` risponde `null` per gli indirizzi che non sono di questo
  // bucket (il sito del Comune): quelli restano come sono.
  const percorso = percorsoNelBucket(BUCKET_AVVISI_ALLEGATI, d.file) ?? d.file
  return ricomponiAllegatoAvviso(percorso, d.link, d.jsonOriginale)
}

// ─── INCARICHI (task) ────────────────────────────────────────────────────────
//
// Gli allegati di un incarico vivono dentro il payload JSON, a tre livelli:
// `attachments` dell'incarico, dei sotto-compiti (`compiti[]`) e dei commenti
// (`commenti[]`, anche dentro un sotto-compito). L'attraversamento è quindi
// ricorsivo e cerca gli array `attachments` ovunque si trovino: legarlo alla
// forma esatta dell'oggetto significherebbe dimenticarsi un livello alla
// prossima aggiunta — e un livello dimenticato è un file che resta pubblico.

// Profondità massima dell'attraversamento: il payload di un incarico ne usa 4
// (task → compiti → commenti → attachments). Il limite esiste solo per non
// dipendere dalla buona fede di un JSON arrivato dal client.
const PROFONDITA_MAX = 8

// Le chiavi di un allegato che portano l'INDIRIZZO del file.
//
// Il tipo dichiara `url`, ma nel dato reale c'è `fileUrl`: il client salva
// l'oggetto che l'upload gli ha restituito, e `TaskCard`/`StudentDetailPanel`
// leggono infatti `att.fileUrl || att.url`. Trattarne una sola vorrebbe dire
// firmare gli allegati che nessuno ha e lasciare rotti quelli che esistono.
const CHIAVI_INDIRIZZO = ['url', 'fileUrl', 'previewUrl'] as const

function perOgniAllegato(nodo: unknown, visita: (att: Record<string, unknown>) => void, livello = 0): void {
  if (livello > PROFONDITA_MAX || nodo === null || typeof nodo !== 'object') return
  if (Array.isArray(nodo)) {
    for (const el of nodo) perOgniAllegato(el, visita, livello + 1)
    return
  }
  for (const [chiave, valore] of Object.entries(nodo as Record<string, unknown>)) {
    if (chiave === 'attachments' && Array.isArray(valore)) {
      for (const att of valore) {
        if (att !== null && typeof att === 'object' && !Array.isArray(att)) visita(att as Record<string, unknown>)
      }
      continue
    }
    perOgniAllegato(valore, visita, livello + 1)
  }
}

// La riscrittura lavora su una COPIA profonda: le route rispondono con oggetti
// che hanno appena decodificato dal database, e mutarli in casa d'altri è il
// genere di sorpresa che si paga sei mesi dopo. Il payload di un incarico è
// JSON puro (viene da `JSON.parse`), quindi la copia è esatta.
function copiaProfonda<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/**
 * Sostituisce l'URL di ogni allegato di incarico con un link FIRMATO a tempo,
 * per tutti gli incarichi di una pagina, con UNA sola chiamata allo Storage.
 *
 * Chi non si è potuto firmare esce con `url: null` — mai il percorso grezzo.
 */
export async function firmaAllegatiTask<T>(
  supabase: ClientStorage,
  righe: T,
  operazione: string,
): Promise<T> {
  const percorsi: string[] = []
  perOgniAllegato(righe, (att) => {
    for (const k of CHIAVI_INDIRIZZO) {
      const p = percorsoNelBucket(BUCKET_TASK_ALLEGATI, typeof att[k] === 'string' ? (att[k] as string) : null)
      if (p !== null && !percorsi.includes(p)) percorsi.push(p)
    }
  })
  if (percorsi.length === 0) return righe

  const urlPerPercorso = await firmaPercorsi(supabase, BUCKET_TASK_ALLEGATI, percorsi, operazione)

  const copia = copiaProfonda(righe)
  perOgniAllegato(copia, (att) => {
    for (const k of CHIAVI_INDIRIZZO) {
      if (typeof att[k] !== 'string') continue
      const p = percorsoNelBucket(BUCKET_TASK_ALLEGATI, att[k] as string)
      if (p === null) continue // link esterno: non è roba nostra, non si tocca
      att[k] = urlPerPercorso.get(p) ?? null
    }
  })
  return copia
}

/**
 * Riporta al PERCORSO gli allegati che il client rimanda in scrittura (stessa
 * ragione di `normalizzaAllegatoAvviso`: in tabella si archivia il percorso, non
 * un indirizzo firmato che fra dieci minuti non apre più niente).
 */
export function normalizzaAllegatiTask<T>(payload: T): T {
  const copia = copiaProfonda(payload)
  perOgniAllegato(copia, (att) => {
    for (const k of CHIAVI_INDIRIZZO) {
      if (typeof att[k] !== 'string') continue
      const p = percorsoNelBucket(BUCKET_TASK_ALLEGATI, att[k] as string)
      if (p !== null) att[k] = p
    }
  })
  return copia
}
