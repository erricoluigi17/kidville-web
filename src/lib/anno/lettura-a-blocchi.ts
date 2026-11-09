/**
 * LEGGERE UN INSIEME GRANDE, A BLOCCHI (PR 4.5, compito 4.5.10).
 *
 * PostgREST taglia una risposta al tetto delle righe per richiesta, in silenzio: chi deve classificare TUTTE le frequenze vive di
 * un anno non può leggerle con una `select` sola. Qui si leggono `BLOCCO` righe per volta finché un blocco arriva corto.
 *
 * Non lancia mai: PostgREST ritorna `{ error }` e lo ritorna anche questa funzione, che si ferma al primo errore. Le righe già
 * lette non si restituiscono a metà: un elenco monco sarebbe un totale falso.
 */

export type ErroreLettura = { code?: string; message?: string }
export type EsitoBlocco = { data: unknown; error: ErroreLettura | null }

/** Quante righe per volta: sotto il tetto delle righe per richiesta di PostgREST. */
export const BLOCCO = 500

export async function leggiABlocchi<T>(
  pezzo: (da: number, a: number) => PromiseLike<EsitoBlocco>,
): Promise<{ righe: T[] } | { error: ErroreLettura }> {
  const righe: T[] = []
  for (let da = 0; ; da += BLOCCO) {
    const r = await pezzo(da, da + BLOCCO - 1)
    if (r.error) return { error: r.error }
    const blocco = (Array.isArray(r.data) ? r.data : []) as T[]
    righe.push(...blocco)
    if (blocco.length < BLOCCO) return { righe }
  }
}
