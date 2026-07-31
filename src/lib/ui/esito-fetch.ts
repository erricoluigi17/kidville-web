/**
 * Il messaggio d'errore di una risposta del server, per l'interfaccia.
 *
 * PERCHÉ ESISTE. Il repo ha la regola giusta sui log del SERVER («un catch che
 * non logga è un bug») ma non ne aveva l'equivalente a schermo: decine di
 * mutazioni del cockpit erano scritte `if (res.ok) { … }` senza `else`. Quando
 * il server rifiutava — un 403 di scope, il 400 «Specificare la sede» nato con
 * il multi-sede — la pagina si comportava esattamente come dopo un successo:
 * modale chiuso, elenco ricaricato, nessun segnale. È ciò che ha reso invisibili
 * gli errori di sede per mesi: l'unico modo di accorgersene sarebbe stato
 * l'errore, e l'errore non arrivava mai.
 *
 * COSA FA. Legge il corpo (`{ error: '…' }`, la forma di tutte le route: il
 * wrapper `withRoute` restituisce la Response invariata) e ne estrae il testo.
 * Se il corpo non è JSON, è vuoto o non ha `error`, torna il `fallback` — mai la
 * stringa vuota, che a schermo è indistinguibile dal silenzio di prima.
 *
 * NON LANCIA e non logga: il log lo fa il chiamante, che è l'unico a sapere
 * quale operazione è stata rifiutata (`stato` compreso: è un numero, passa la
 * lista bianca di `redact`, ed è l'unica cosa che distingue un 400 da un 403).
 * Il corpo NON si logga: può contenere il nome di una classe o di un bambino.
 */
export async function messaggioErrore(res: Response, fallback: string): Promise<string> {
    try {
        const j: unknown = await res.json();
        const msg = (j as { error?: unknown } | null)?.error;
        return typeof msg === 'string' && msg.trim() !== '' ? msg : fallback;
    } catch {
        return fallback;
    }
}
