import { flush, installaLoggerClient, logClient } from '@/lib/logging/client';

/**
 * Punto d'ingresso ufficiale di Next per il codice che deve girare NEL BROWSER prima di tutto
 * il resto: viene eseguito una volta sola, dopo il caricamento del documento e PRIMA
 * dell'hydration.
 *
 * PERCHÉ NON UN PROVIDER REACT. Sembrerebbe equivalente, e non lo è: gli `useEffect` del
 * componente PADRE girano DOPO quelli dei figli. Un `<LoggerProvider>` in cima all'albero
 * installerebbe quindi il patch di `fetch` DOPO che le pagine hanno già lanciato le loro
 * chiamate di primo caricamento — cioè si perderebbero proprio i guasti di avvio, che sono i
 * peggiori (l'utente vede una pagina vuota e non ha nemmeno un'azione da riprovare).
 *
 * Next avvisa se questo file impiega più di 16 ms: qui dentro non deve finire NIENTE di
 * pesante. `installaLoggerClient` registra dei listener e rilegge una coda corta: è tutto.
 */
installaLoggerClient();

/**
 * Si cambia pagina: la coda parte ADESSO.
 *
 * È il momento giusto per due ragioni. La prima è banale: gli errori accumulati sulla pagina
 * che si sta lasciando vanno spediti finché la loro `route` è ancora quella giusta. La seconda
 * conta di più — su una SPA la navigazione NON scatena `pagehide`, quindi senza questo gancio
 * la coda di un utente che passa da una pagina all'altra per un'ora resterebbe in memoria
 * (e verrebbe potata a 20 elementi dai suoi stessi errori) fino alla chiusura dell'app.
 *
 * `url` non si logga: è il path GREZZO, e in questa app il path è una credenziale
 * (`/m/<token>`) e la query trasporta `?userId=`. La rotta la porta già ogni evento, ridotta
 * a pattern dal server.
 */
export function onRouterTransitionStart(_url: string): void {
    void _url;
    flush();
}

/** Riesportato perché le boundary React (`error.tsx`) possano loggare da sé. */
export { logClient };
