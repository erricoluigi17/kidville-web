// =============================================================================
// «Questo post contiene una fotografia?» — modulo PURO e client-safe.
//
// Vive separato da `./consenso-foto.ts` (che importa il logger, cioè codice di
// server) perché la stessa domanda se la devono fare in due: l'editor, per
// pretendere la dichiarazione PRIMA che l'operatore possa caricare l'immagine, e
// `POST /api/news`, che è l'unico posto dove la risposta conta davvero. Una
// regola di privacy applicata dal solo client è un suggerimento, non una regola:
// qui il client la usa per essere gentile, il server per decidere.
// =============================================================================

/**
 * Vero se il post porta un'IMMAGINE: la copertina, oppure un nodo `image` del
 * rich-text di TipTap. È il fatto che fa scattare la dichiarazione dei bambini
 * ritratti — un post di solo testo non ritrae nessuno e non chiede niente.
 */
export function contieneFoto(copertinaUrl: unknown, contenutoJson: unknown): boolean {
  if (typeof copertinaUrl === 'string' && copertinaUrl.trim() !== '') return true
  return contieneNodoImmagine(contenutoJson, 0)
}

function contieneNodoImmagine(nodo: unknown, profondita: number): boolean {
  // Il JSON arriva dal client: si limita la ricorsione invece di fidarsi.
  if (profondita > 30 || nodo == null) return false
  if (Array.isArray(nodo)) return nodo.some((n) => contieneNodoImmagine(n, profondita + 1))
  if (typeof nodo !== 'object') return false
  const o = nodo as Record<string, unknown>
  if (o.type === 'image') return true
  return contieneNodoImmagine(o.content, profondita + 1)
}
