import { logClient } from '@/lib/logging/client';

/**
 * IL DIARIO DEL GENITORE NON SI È LETTO — e che cosa ha visto il genitore al suo posto.
 *
 * Fino al 2026-09-28 una lettura fallita diventava, sulla pagina e sulla card della home, «La
 * maestra non ha ancora compilato il diario»: la frase che le famiglie riferivano alla scuola. La
 * fetch strumentata registra già il guasto di rete (`stato: 0`, livello `warn`), ma non dice che
 * cosa è finito sullo schermo: questa riga sì. Una per lettura andata a vuoto, senza dati personali
 * — né l'id del bambino né la data: `app_log` le conta per impronta e giorno, e il conteggio è la
 * misura che serve.
 *
 *  · `vista`: la pagina del diario o la card «Oggi a scuola» della home;
 *  · `fase`: `apertura` (la prima lettura: il genitore vede l'avviso d'errore) oppure `ricarica`
 *    (ritorno nell'app, tocco su una notifica, «Riprova»: resta ciò che era già a schermo).
 */
export function segnalaDiarioNonLetto(vista: 'pagina' | 'card', fase: 'apertura' | 'ricarica'): void {
    logClient({
        livello: 'warn',
        evento: 'fetch',
        messaggio: `diario-genitore: lettura non riuscita (${vista}, ${fase})`,
    });
}
