// Galleria — accesso ai file del bucket `gallery`, che dal 2026-07-31 è PRIVATO.
//
// PERCHÉ. Fino a quella data il bucket era pubblico e `file_url` conteneva
// l'indirizzo restituito da `getPublicUrl`: chiunque avesse — o indovinasse —
// quell'indirizzo vedeva la foto di un bambino SENZA LOGIN e PER SEMPRE. Il
// gate di ruolo, l'isolamento per sede e la regola «foto privata»
// (`./privacy.ts`) giravano tutti sul database, mai sul file: bastava uscire
// dall'applicazione per aggirarli tutti in un colpo solo.
//
// COME. Nel database si conserva il PERCORSO nel bucket (`uploads/<utente>/<file>`)
// e la lettura genera un link FIRMATO a tempo, dietro allo stesso gate della
// route che lo serve. Stesso modello già in esercizio su `registro-allegati`
// (`api/primaria/allegati`), `cassa-allegati` e `protocolli`.
//
// I link si generano IN BLOCCO (`createSignedUrls`, plurale): una chiamata per
// pagina di galleria, non una per foto.

import { logEvento } from '@/lib/logging/logger'

/** Il bucket dei media di galleria (foto e video dei bambini). Privato. */
export const BUCKET_GALLERIA = 'gallery'

/**
 * Durata del link firmato: 10 minuti.
 *
 * Abbastanza per sfogliare la galleria, aprire il visore e scaricare un video
 * su rete mobile; abbastanza poco perché un indirizzo copiato o inoltrato per
 * sbaglio smetta presto di mostrare la foto di un minore. È il TTL già scelto
 * per gli allegati del registro e i certificati (`primaria/allegati`,
 * `parent/competenze`); la cassa usa 300s perché lì il file si apre e basta.
 */
export const TTL_FIRMA_GALLERIA_S = 600

// Un URL dello Storage Supabase, in una qualunque delle tre forme che
// l'API produce (`public`, `sign`, `authenticated`), per QUESTO bucket.
const RE_URL_STORAGE = new RegExp(
  `/storage/v1/object/(?:public|sign|authenticated)/${BUCKET_GALLERIA}/([^?#]+)`,
)

// `decodeURIComponent` LANCIA su sequenze percentuali malformate (`50%.jpg`), e
// un catch muto è vietato dal progetto: si decodifica solo quando la stringa è
// interamente ben formata. Un nome bizzarro resta grezzo — al più la firma non
// lo trova, e allora si vede nel log invece di esplodere qui.
const PERCENTUALI_BEN_FORMATE = /^(?:[^%]|%[0-9a-fA-F]{2})*$/

function decodificaSicura(s: string): string {
  return PERCENTUALI_BEN_FORMATE.test(s) ? decodeURIComponent(s) : s
}

/**
 * Ricava il percorso nel bucket `gallery` da un valore di `file_url`.
 *
 * Accetta le tre forme che convivono nel dato:
 *  - il PERCORSO (quello che si salva da oggi in poi): restituito com'è;
 *  - un URL PUBBLICO completo (le righe storiche, di quando il bucket era
 *    pubblico): se ne estrae il percorso;
 *  - un URL già FIRMATO (token ormai scaduto): idem, il token si butta.
 *
 * Restituisce `null` per i valori vuoti e per gli indirizzi che NON appartengono
 * a questo bucket (un altro bucket, un CDN esterno): non sono firmabili qui, e
 * inventarsi un percorso sarebbe peggio che ammettere di non saperlo.
 */
export function percorsoNelBucket(fileUrl: string | null | undefined): string | null {
  const valore = (fileUrl ?? '').trim()
  if (!valore) return null

  if (/^https?:\/\//i.test(valore)) {
    const m = RE_URL_STORAGE.exec(valore)
    return m ? decodificaSicura(m[1]) : null
  }

  // Già un percorso: si normalizza solo lo slash iniziale, che lo Storage non
  // vuole (`/uploads/x` e `uploads/x` sono lo stesso oggetto solo per noi).
  return valore.replace(/^\/+/, '') || null
}

// Il minimo indispensabile del client Supabase: il vero `SupabaseClient` lo
// soddisfa, e un test può passarne uno finto senza montare mezzo SDK.
type ClientStorage = {
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

type RigaMedia = { file_url?: string | null }

/**
 * Sostituisce `file_url` con un link FIRMATO a tempo, per tutte le righe di una
 * pagina, con UNA sola chiamata allo Storage.
 *
 * Chi non si è potuto firmare esce con `file_url: null` — mai il percorso
 * grezzo, che come indirizzo non funziona e mascherebbe il guasto da «immagine
 * rotta». Il guasto finisce nel log a livello `error`, **col corpo dell'errore
 * del provider** (AGENTS §3): senza, si saprebbe solo che qualcosa non ha
 * firmato, non perché.
 */
export async function firmaMediaGalleria<T extends RigaMedia>(
  supabase: ClientStorage,
  righe: T[],
  operazione: string,
): Promise<T[]> {
  const percorsoPerRiga = righe.map((r) => percorsoNelBucket(r.file_url))
  const percorsi = [...new Set(percorsoPerRiga.filter((p): p is string => p !== null))]
  // Niente da firmare (pagina vuota, o solo indirizzi esterni): lo Storage non
  // si tocca affatto.
  if (percorsi.length === 0) return righe

  let firmati: Array<{ path: string | null; signedUrl: string | null; error?: string | null }> = []
  try {
    const { data, error } = await supabase.storage
      .from(BUCKET_GALLERIA)
      .createSignedUrls(percorsi, TTL_FIRMA_GALLERIA_S)
    if (error) {
      // Nel log SOLO conteggi: un percorso porta con sé l'uuid di chi ha
      // caricato e il nome del file. Il perché sta nell'errore del provider.
      logEvento('storage', 'error', {
        operazione,
        esito: 'firma-link-non-riuscita',
        bucket: BUCKET_GALLERIA,
        n_percorsi: percorsi.length,
      }, error)
      return righe.map((r) => ({ ...r, file_url: null }))
    }
    firmati = data ?? []
  } catch (e) {
    // Guasto di TRASPORTO (il fetch che esplode prima di arrivare allo Storage):
    // `createSignedUrls` non ritorna, lancia. Senza questo ramo la pagina
    // risponderebbe 500 e il genitore non vedrebbe più nemmeno le didascalie.
    logEvento('storage', 'error', {
      operazione,
      esito: 'firma-link-non-riuscita',
      bucket: BUCKET_GALLERIA,
      n_percorsi: percorsi.length,
    }, e)
    return righe.map((r) => ({ ...r, file_url: null }))
  }

  // Si indicizza per PERCORSO, non per posizione: l'API risponde con un elemento
  // per percorso, ma l'ordine non è parte del contratto.
  const urlPerPercorso = new Map<string, string>()
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
      bucket: BUCKET_GALLERIA,
      n_percorsi: percorsi.length,
      n_falliti: mancanti.length,
    }, new Error(motivi.length > 0 ? motivi.join(' · ') : 'firma non restituita per uno o più file'))
  }

  return righe.map((r, i) => {
    const p = percorsoPerRiga[i]
    if (p === null) return r
    return { ...r, file_url: urlPerPercorso.get(p) ?? null }
  })
}
