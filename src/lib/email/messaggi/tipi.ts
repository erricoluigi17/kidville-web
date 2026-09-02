/**
 * Il contratto dei generatori di email.
 *
 * ⚠️ Qui c'era scritto «i dodici generatori», e non erano più dodici da un pezzo:
 * la copia della candidatura alla sede li ha fatti tredici il 2026-08-20, «la
 * password è stata cambiata» quattordici il 2026-09-01, e questa riga ha
 * continuato a dire il numero vecchio. Il conteggio è uscito da qui per la stessa
 * ragione per cui è uscito dal nome del file di test: un numero in un commento non
 * si aggiorna da solo, e un documento che descrive qualcosa che non c'è più è
 * peggio di nessun documento.
 *
 * Ognuno è una funzione PURA: riceve dati già formattati e un `ContestoSede`
 * già risolto, e ritorna le tre cose che servono a spedire. Nessun file di
 * questa cartella importa Supabase — il contesto arriva risolto da chi chiama.
 * Conseguenza pratica: i test dei generatori non hanno bisogno di un finto
 * database, e l'anteprima locale può importarli senza connessione.
 */
export interface Messaggio {
    /**
     * L'oggetto dell'email.
     *
     * Sta QUI dentro, e non nel chiamante, per una ragione misurata: i quattro
     * punti che mandano le credenziali scrivevano tre oggetti letterali diversi
     * a mano, e uno era già divergente. Un oggetto che vive accanto al corpo che
     * descrive non può ridivergere domani.
     */
    oggetto: string
    /** Il corpo HTML completo, dal `<!DOCTYPE>` al `</html>`. */
    html: string
    /**
     * Il gemello in testo semplice: stessa informazione, stesso ordine, stessi
     * dati copiabili. Non è un riassunto — è ciò che vedono i client che
     * rifiutano l'HTML, e per il codice di verifica è ciò che vede la maggioranza.
     */
    testo: string
}
