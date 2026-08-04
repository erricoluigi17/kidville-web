/**
 * Cache di PROMESSE indicizzata per chiave — la deduplica delle GET identiche
 * che partono in parallelo da componenti diversi dello stesso caricamento.
 *
 * Il difetto che chiude (T11-F3): una pagina client monta insieme la sua
 * navigazione, il suo header e il suo corpo; se tutti e tre chiedono lo stesso
 * endpoint, escono tre richieste identiche a distanza di millisecondi. In
 * sviluppo (`next dev`, StrictMode) gli effect sono invocati DUE volte, quindi
 * sono sei. Sul diario docente erano quattordici secondi di attesa prima ancora
 * di toccare un pulsante — abbastanza da far scadere l'E2E in CI.
 *
 * Perché una promessa e non il valore: chi arriva mentre la richiesta è ancora
 * in volo deve attaccarsi a QUELLA, non aprirne una seconda. È lo schema che
 * `useTeacherGradi` già usava per `/api/primaria/me`; qui vive in un posto solo,
 * perché una regola valida per tre strade in tre copie diventa vera in due.
 *
 * ⚠️ La chiave è parte del contratto, non un dettaglio: su questi endpoint la
 * chiave è l'IDENTITÀ (parentId, userId). Una chiave fissa mostrerebbe a un
 * genitore i figli di un altro. Vedi `__tests__/ui/parent-figli-una-chiamata`.
 */

export interface CachePromesse<T> {
  /** Valore per la chiave: riusa la richiesta in volo o quella già risolta. */
  leggi: (chiave: string) => Promise<T>;
  /** Butta la voce indicata; senza argomento svuota tutto. */
  invalida: (chiave?: string) => void;
}

/**
 * @param carica  come si ottiene il valore per una chiave (una fetch, di norma).
 * @param scartaSe esiti da NON conservare. Di default `null`/`undefined`: un
 *   blip di rete non deve congelare un "non lo so" per tutta la vita della
 *   pagina — la voce si rimuove e il mount successivo ritenta. Anche un rigetto
 *   rimuove la voce (e viene ripropagato al chiamante).
 */
export function creaCachePromesse<T>(
  carica: (chiave: string) => Promise<T>,
  scartaSe: (valore: T) => boolean = (v) => v === null || v === undefined,
): CachePromesse<T> {
  const mappa = new Map<string, Promise<T>>();

  return {
    leggi(chiave: string): Promise<T> {
      const inCorso = mappa.get(chiave);
      if (inCorso) return inCorso;

      const promessa = carica(chiave).then(
        (valore) => {
          if (scartaSe(valore)) mappa.delete(chiave);
          return valore;
        },
        (errore) => {
          mappa.delete(chiave);
          throw errore;
        },
      );
      mappa.set(chiave, promessa);
      return promessa;
    },

    invalida(chiave?: string) {
      if (chiave === undefined) mappa.clear();
      else mappa.delete(chiave);
    },
  };
}
