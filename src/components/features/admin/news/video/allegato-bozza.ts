import { SUPABASE_URL } from '@/lib/supabase/public-config'

// =============================================================================
// DOVE STA IL VIDEO CONVERTITO, E COME ENTRA NELL'ARTICOLO.
//
// ─── UN GEMELLO, NON UNA COPIA DI COMODO ────────────────────────────────────
//
// La forma del percorso la decide il server (`percorsoAllegatoVideoNews` in
// `@/lib/news/video-allegato`), ed è lì che va letta la ragione per cui il primo
// segmento è il PROPRIETARIO e il nome è l'id del job. Qui è riscritta perché
// quel modulo importa `@/lib/logging/logger`, che a sua volta tira dentro
// `app-log` → `node:crypto` e il client Supabase con la CHIAVE DI SERVIZIO: in un
// componente `'use client'` non sarebbe peso morto, sarebbe un segreto nel
// bundle del browser.
//
// Le due copie sono legate da `__tests__/components/news-video-allegato-bozza.test.ts`,
// che confronta i due risultati invece di fidarsi di questo commento. Se
// divergessero, `promuoviMediaBozza` non riconoscerebbe più l'indirizzo: il video
// resterebbe nel bucket privato con la riga dell'articolo già scritta, cioè un
// filmato rotto per le famiglie e nessun errore da nessuna parte.
//
// ─── PERCHÉ L'ALLEGATO È UN LINK E NON UN NODO DEL RICH-TEXT ────────────────
//
// Misurato il 2026-09-18 sul chokepoint vero: `sanificaContenuto` rende il JSON
// di TipTap con `[StarterKit, Link, Image]`. Un nodo che quelle estensioni non
// conoscono fa lanciare `generateHTML`; il `catch` di `sanificaContenuto`
// restituisce `{ html: '', testo: '' }` e **l'intero corpo dell'articolo
// sparisce** — anche i paragrafi che con il video non c'entrano — senza che
// nessuno veda un errore. Un `<a href>` https invece attraversa il sanificatore
// intatto (`target="_blank" rel="noopener noreferrer"` glieli mette lui) ed è una
// stringa dell'albero: cioè esattamente ciò che `promuoviMediaBozza` cerca per
// spostare il file nel bucket pubblico, e ciò che `permanenza-consenso` ritrova
// il giorno della revoca o dell'oblio.
// =============================================================================

/**
 * Il bucket privato in cui il video convertito sosta come allegato di bozza.
 *
 * Il valore vero è `NEWS_BUCKET_BOZZE` di `@/lib/news/media-bozza`, che non è
 * importabile di qui per la ragione scritta in testata: il test lo confronta.
 */
export const BUCKET_BOZZE_NEWS = 'news_bozze'

/** L'estensione dell'uscita della pipeline: MP4, sempre (`MIME_ALLEGATO_VIDEO_NEWS`). */
const ESTENSIONE = 'mp4'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `uploads/<proprietario>/<job>.mp4`, o `null` se uno dei due non è un uuid.
 *
 * Il rifiuto non è pignoleria: questo percorso finisce dentro l'indirizzo che
 * l'articolo cita, e da lì in una `move()` eseguita col service-role. La forma è
 * l'unica difesa contro un `..` o una barra di troppo.
 */
export function percorsoAllegatoBozzaVideo(ownerId: unknown, jobId: unknown): string | null {
  if (typeof ownerId !== 'string' || !UUID.test(ownerId)) return null
  if (typeof jobId !== 'string' || !UUID.test(jobId)) return null
  return `uploads/${ownerId}/${jobId}.${ESTENSIONE}`
}

/**
 * L'indirizzo dell'allegato dentro l'area di sosta.
 *
 * Non è firmato, e non deve esserlo: non serve a MOSTRARE il filmato (il bucket
 * è privato: un `<video src>` qui prenderebbe 400), serve a NOMINARLO dentro il
 * contenuto dell'articolo. `pathBozza` lo riconosce dal segmento `/news_bozze/`,
 * la promozione lo sostituisce con l'indirizzo pubblico definitivo prima che la
 * riga venga scritta, e da quel momento in poi nessuno lo rivede più.
 */
export function urlAllegatoBozzaVideo(ownerId: unknown, jobId: unknown): string | null {
  const percorso = percorsoAllegatoBozzaVideo(ownerId, jobId)
  if (!percorso) return null
  return `${SUPABASE_URL}/storage/v1/object/${BUCKET_BOZZE_NEWS}/${percorso}`
}

/** Il nodo TipTap che l'editor aggiunge in fondo all'articolo: un paragrafo, un link. */
export function paragrafoAllegatoVideo(url: string, etichetta: string) {
  return {
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: etichetta,
        marks: [{ type: 'link', attrs: { href: url } }],
      },
    ],
  }
}
