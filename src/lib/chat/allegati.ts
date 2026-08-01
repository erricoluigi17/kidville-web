// Allegati della CHAT — il bucket `chat-allegati`, privato.
//
// PERCHÉ. Fino al 2026-08-01 `POST /api/chat/upload` firmava il file con un TTL
// di **365 giorni** e il client rispediva quell'indirizzo firmato dentro
// `chat_messages.attachment_url`: un link permanente travestito da link a
// scadenza. Chiunque avesse — o inoltrasse, o ritrovasse in un backup — quel
// singolo indirizzo apriva per un anno il certificato medico, la foto o il
// documento scambiato fra una famiglia e la scuola: senza login, senza gate di
// ruolo, senza isolamento per sede. Il bucket era privato, ma il token in
// tabella annullava da solo tutta la difesa.
//
// È la stessa forma da cui `avvisi_allegati` e `task_allegati` sono usciti il
// 2026-07-31 (`src/lib/allegati/storage.ts`) e la galleria prima di loro
// (`src/lib/gallery/storage.ts`): la chat era l'ultimo bucket rimasto indietro.
//
// COME. In tabella si conserva il PERCORSO nel bucket
// (`<uuid mittente>/<uuid>-<nome file>`) e la LETTURA genera un link firmato a
// tempo, dietro allo stesso gate della route che lo serve. Il TTL è quello del
// progetto (10 minuti), importato — non riscritto qui.
//
// I link si generano IN BLOCCO (`createSignedUrls`, plurale): una chiamata per
// pagina di messaggi, non una per allegato. La funzione che lo fa è la stessa
// di avvisi e incarichi: log identico, gestione del fallimento identica.

import {
  percorsoNelBucket,
  firmaPercorsi,
  TTL_FIRMA_ALLEGATI_S,
  type ClientStorage,
} from '@/lib/allegati/storage'

/** Gli allegati scambiati in chat fra famiglie e scuola. Privato. */
export const BUCKET_CHAT_ALLEGATI = 'chat-allegati'

/**
 * Durata del link firmato: la STESSA di avvisi, incarichi e galleria (10 minuti).
 *
 * Non è un numero scelto qui: se un giorno si decide che dieci minuti sono
 * troppi o troppo pochi, il posto dove cambiarlo resta uno solo. Dieci minuti
 * bastano ad aprire un PDF o a scaricare una foto su rete mobile; la pagina
 * della chat ricarica i messaggi ogni 15 secondi, quindi i link in vista sono
 * sempre freschi.
 */
export const TTL_FIRMA_CHAT_S = TTL_FIRMA_ALLEGATI_S

// Uno schema URI (`javascript:`, `data:`) o un indirizzo protocol-relative
// (`//host/…`) NON è un percorso nel bucket: è un indirizzo altrui che
// finirebbe dentro un `<img src>` a casa del destinatario.
const SCHEMA_URI = /^[a-z][a-z0-9+.-]*:/i

/**
 * Riporta al PERCORSO il valore che il client manda in scrittura.
 *
 * Accetta le forme che arrivano davvero:
 *  - il PERCORSO restituito da `POST /api/chat/upload` (quello che si salva da
 *    oggi in poi): restituito com'è, senza slash iniziale;
 *  - un URL FIRMATO del bucket `chat-allegati` — è quello che rimandano i client
 *    già installati, e le righe storiche: se ne estrae il percorso e il token si
 *    butta, che è tutto il punto di questo step;
 *  - un URL PUBBLICO del bucket (righe più vecchie): idem.
 *
 * Restituisce `null` per tutto il resto, e il resto va rifiutato in scrittura:
 * un indirizzo di un altro dominio o di un altro bucket non è un allegato di
 * chat, è un pixel di tracciamento (o peggio) che un utente autenticato piazza
 * nella conversazione di una famiglia. Prima non c'era nessun controllo:
 * `attachment_url` era una `z.string()` qualunque, e il presidio stava tutto in
 * un `test` di schema dentro al componente che disegna la bolla.
 */
export function normalizzaAllegatoChat(valore: string | null | undefined): string | null {
  const v = (valore ?? '').trim()
  if (!v) return null

  // `percorsoNelBucket` risponde `null` per gli URL che non sono di QUESTO
  // bucket (un altro bucket, un CDN esterno): qui quel `null` è la risposta
  // giusta, non un ripiego.
  if (/^https?:\/\//i.test(v)) return percorsoNelBucket(BUCKET_CHAT_ALLEGATI, v)

  if (SCHEMA_URI.test(v) || v.startsWith('//')) return null

  const p = v.replace(/^\/+/, '')
  // Risalita di percorso: lo Storage non uscirebbe comunque dal bucket, ma un
  // percorso che contiene `..` non è nulla che questo sistema abbia mai scritto.
  if (!p || p.split('/').includes('..')) return null
  return p
}

type RigaMessaggio = { attachment_url?: string | null }

/**
 * Sostituisce l'allegato di ogni messaggio con un link FIRMATO a tempo, per
 * tutti i messaggi di una pagina, con UNA sola chiamata allo Storage.
 *
 * Chi non si è potuto firmare esce con `attachment_url: null`: l'allegato non
 * compare e il guasto è nel log — non diventa un percorso grezzo dentro un
 * `<img src>`, che non aprirebbe niente e farebbe sembrare rotta la chat invece
 * che lo Storage. Stessa scelta di `firmaAllegatiAvvisi`.
 *
 * Vale anche per i valori che non appartengono al bucket: escono `null` in
 * lettura, così una riga storica (o inserita da un client vecchio) non serve
 * comunque mai un indirizzo altrui al browser di una famiglia.
 */
export async function firmaAllegatiChat<T extends RigaMessaggio>(
  supabase: ClientStorage,
  righe: T[],
  operazione: string,
): Promise<T[]> {
  const conAllegato = righe.map((r) => (r.attachment_url ?? '').trim() !== '')
  const percorsoPerRiga = righe.map((r) => normalizzaAllegatoChat(r.attachment_url))
  const percorsi = [...new Set(percorsoPerRiga.filter((p): p is string => p !== null))]

  // Niente da firmare (nessun allegato, o solo valori non nostri): lo Storage
  // non si tocca affatto.
  const urlPerPercorso =
    percorsi.length === 0
      ? new Map<string, string>()
      : await firmaPercorsi(supabase, BUCKET_CHAT_ALLEGATI, percorsi, operazione)

  return righe.map((r, i) => {
    if (!conAllegato[i]) return r // nessun allegato: la riga non si tocca
    const p = percorsoPerRiga[i]
    return { ...r, attachment_url: p === null ? null : (urlPerPercorso.get(p) ?? null) }
  })
}
