/**
 * LA RIDUZIONE DEL PATH A PATTERN. Un modulo a sé, e l'unica ragione per cui esiste come file
 * separato è ciò che NON contiene: nessun import.
 *
 * PERCHÉ. In questo repo il path È UNA CREDENZIALE. Il token del modulo pubblico non sta nella
 * query string, sta in un SEGMENTO DI PATH (`/m/<token>`, `/api/public/forms/<token>/submit`):
 * è una capability riusabile che apre il modulo di preiscrizione di un minore a chiunque ce
 * l'abbia. Un path grezzo nei log — che vivono 30 giorni e si interrogano in SQL — è una
 * credenziale nei log. Perciò del path si tiene il PATTERN (`/m/[tok]`), che è anche l'unica
 * forma utile per correlare: si aggrega per rotta, non per istanza.
 *
 * PERCHÉ NON STA IN `redact.ts`. Perché la stessa euristica serve in TRE runtime che `redact.ts`
 * non possono caricare: `redact.ts` importa `node:crypto` (per `hashCorrelabile`) alla prima
 * riga, e un import statico di modulo Node non lo elimina nessun tree-shaking.
 *
 *   · il MIDDLEWARE (Edge Runtime: `node:crypto` non esiste);
 *   · `instrumentation.ts`, che Next compila ANCHE nel bundle dell'Edge insieme al middleware;
 *   · `client.ts`, che gira nel BROWSER e nella WebView nativa.
 *
 * Finché l'euristica stava copiata in tre punti, la domanda non era SE sarebbero divergiti ma
 * QUANDO — e una copia che maschera meno delle altre non fallisce nessun test: perde un token,
 * in silenzio, per trent'anni. Qui è scritta una volta, e i tre runtime la importano.
 *
 * VINCOLO PERMANENTE: questo file non deve importare NULLA. Né `node:*`, né `next/*`, né un
 * altro modulo del logging. Il giorno in cui lo facesse, la build dell'Edge cadrebbe — e
 * cadrebbe sul middleware, cioè su ogni richiesta.
 *
 * REGEX SENZA LOOKBEHIND, anche dove sarebbe comoda: questo modulo finisce nel bundle del
 * BROWSER, e un lookbehind in un literal è un SyntaxError al PARSE su Safari < 16.4 e sulle
 * WebView vecchie — cioè non un log perso, ma il bundle intero che non carica.
 *
 * Regola d'oro del logging: niente qui dentro può lanciare per input plausibili, e le due
 * funzioni "sicure" non lanciano per NESSUN input.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOLE_CIFRE = /^\d+$/;
const CONTIENE_CIFRA = /\d/;

/**
 * Il segmento "opaco" è lungo E CON ALMENO UNA CIFRA, non solo lungo. Non è una raffinatezza:
 * il repo ha 19 segmenti di rotta legittimi da ≥16 caratteri (`medical-certificates`,
 * `giustifiche-didattiche`, …) e collassarli tutti in `[tok]` toglierebbe al log la sua unica
 * funzione — dire QUALE rotta è stata colpita. I token veri (uuid, `tok_live_9f8e…`) hanno
 * cifre; i nomi di rotta italiani no.
 */
const SEGMENTO_OPACO_MIN = 16;

/**
 * L'ESTENSIONE di un file: corta e alfanumerica. La regex si applica al solo pezzo dopo
 * l'ultimo punto, quindi non ha niente su cui fare backtracking (`{1,8}` più `$` fallisce in
 * otto tentativi anche su un segmento lunghissimo).
 */
const ESTENSIONE = /^[A-Za-z0-9]{1,8}$/;

/**
 * IL NOME DI FILE È UN DATO, NON UNA ROTTA — e le tre regole qui sopra non lo vedevano.
 *
 * Misurato in produzione: nella riga persistita di un guasto indotto convivevano
 * `"url":"NON-ESISTE-collaudo-log.pdf"` IN CHIARO e `"fileUrl":"[redatto:str/27]"` — lo stesso
 * valore, due trattamenti, solo perché una delle due chiavi passa di qui. Un nome di file senza
 * cifre non è un uuid, non è tutto-cifre e (se è corto) non è nemmeno un segmento opaco: usciva
 * intatto. E un allegato di avviso può chiamarsi «certificato-<cognome>.pdf»; gli URL storici
 * dei bucket, quando erano pubblici, portano il nome ORIGINALE del file scelto dalla famiglia.
 *
 * SI TIENE L'ESTENSIONE, SI BUTTA IL NOME. È la stessa politica di `[redatto:str/N]` in
 * `redact.ts`: della cosa tolta si conserva ciò che serve a diagnosticare (era un PDF, era un
 * JPEG) e non ciò che identifica qualcuno. `pagella.pdf` e `sw.js` diventano `[file].pdf` e
 * `[file].js`: si perde quale file, si tiene di che tipo era. È il verso in cui vogliamo
 * sbagliare — la regola 8 di AGENTS.md dice che la lista bianca si RESTRINGE.
 */
function nomeDiFile(seg: string): string | null {
    const punto = seg.lastIndexOf('.');
    // `punto <= 0`: nessuna estensione, oppure un nome che comincia col punto (`.gitignore`),
    // che estensione non è. `punto === seg.length - 1`: il punto è l'ultimo carattere.
    if (punto <= 0 || punto === seg.length - 1) return null;
    const estensione = seg.slice(punto + 1);
    return ESTENSIONE.test(estensione) ? `[file].${estensione}` : null;
}

/**
 * Riduce un path al suo pattern: via query string e frammento, poi ogni segmento che possa
 * essere un identificativo o una credenziale diventa un segnaposto, e il NOME DEL FILE finale
 * diventa `[file].<estensione>`.
 *
 * Regge anche un URL intero (`https://app.kidville.it/m/<token>` → `https://app.kidville.it/m/[tok]`):
 * `https:` e l'host non incrociano nessuna delle tre regole, quindi restano.
 *
 * L'AUTORITÀ È ESCLUSA dalla regola del nome di file, ed è l'unico caso particolare del modulo:
 * `api.resend.com` e `app.kidville.it` finiscono per `.com` e `.it`, cioè hanno esattamente la
 * forma di un nome di file. Mascherarli cancellerebbe QUALE provider ha risposto — il dato per
 * cui `external.ts` logga l'URL — in cambio di zero privacy: un host non è il nome di nessuno.
 */
export function redigiPath(v: string): string {
    const senzaQuery = v.split('?')[0].split('#')[0];
    const parti = senzaQuery.split('/');
    // Con uno schema (`https://host/…`) le prime tre caselle sono `https:`, `''` e l'AUTORITÀ.
    // Anche la forma PROTOCOLLO-RELATIVA (`//host/…`) ha l'autorità in terza casella, e non è
    // un caso di scuola: è la forma in cui l'host arriva qui davvero, perché
    // `redigiPathNelTesto` ritaglia da un messaggio del browser la sequenza che comincia DOPO
    // i due punti («Failed to fetch https://app.kidville.it» → `//app.kidville.it`).
    // Senza schema e senza `//` non c'è nessuna autorità: `-1` non è l'indice di niente.
    const autorita = parti.length >= 3 && parti[1] === ''
        && (parti[0] === '' || parti[0].endsWith(':')) ? 2 : -1;
    const ultimo = parti.length - 1;
    return parti
        .map((seg, i) => {
            if (seg === '') return seg;
            if (UUID.test(seg)) return '[id]';
            if (seg.length >= SEGMENTO_OPACO_MIN && CONTIENE_CIFRA.test(seg)) return '[tok]';
            if (SOLE_CIFRE.test(seg)) return '[n]';
            if (i === ultimo && i !== autorita) return nomeDiFile(seg) ?? seg;
            return seg;
        })
        .join('/');
}

/**
 * `redigiPath` per chi non può garantire che l'input sia una stringa (il middleware, il
 * gestore d'errore di Next, un chiamante JS non tipizzato). Non lancia per nessun input.
 *
 * Un log che tace su ciò che ha perso è un log che mente: se il path non si legge lo si DICE,
 * invece di lasciare il campo vuoto come se non ci fosse mai stato.
 */
export function redigiPathSicuro(v: unknown): string {
    try {
        return redigiPath(typeof v === 'string' ? v : String(v ?? ''));
    } catch {
        return '[path-illeggibile]';
    }
}

/**
 * Un path dentro il TESTO LIBERO, non da solo.
 *
 * Serve perché i messaggi del client non sono path: sono frasi che ne CONTENGONO uno
 * («Failed to fetch https://app.kidville.it/m/<token>», «GET /m/<token> → 500»). Passare
 * l'intera frase da `redigiPath` la distruggerebbe — spezzerebbe su ogni `/` e ciò che sta
 * dopo l'ultimo (il ` → 500`, cioè il dato) finirebbe dentro un `[tok]`.
 *
 * Si isolano quindi le sole SEQUENZE che assomigliano a un path, e si riduce ognuna.
 *
 * IL CARATTERE PRECEDENTE FA PARTE DEL MATCH, e non è un dettaglio di implementazione: è ciò
 * che impedisce di prendere una DATA. In `12/03/2026` la prima `/` è preceduta da una cifra,
 * quindi non apre nessun path; senza questo vincolo la data uscirebbe come `12/[n]/[n]` — un
 * messaggio mutilato in cambio di zero privacy. (Si cattura il carattere invece di guardarlo
 * con un lookbehind: vedi la nota sui browser in testa al modulo.)
 *
 * Nessun quantificatore ambiguo: ogni ripetizione del gruppo deve consumare una `/`, che la
 * classe interna non contiene. Niente backtracking catastrofico su un messaggio ostile.
 */
const PATH_NEL_TESTO = /(^|[^A-Za-z0-9])(\/[A-Za-z0-9._~%@:+-]*(?:\/[A-Za-z0-9._~%@:+-]*)*)/g;

export function redigiPathNelTesto(v: string): string {
    try {
        return v.replace(PATH_NEL_TESTO, (_intero, prima: string, path: string) =>
            prima + redigiPath(path));
    } catch {
        // FAIL-CLOSED, al contrario di quasi tutto il resto del logging: se la riduzione non è
        // riuscita non si può affermare che il testo sia privo di credenziali, e il testo qui
        // arriva dal BROWSER. Meglio un messaggio perso che un token in tabella per 30 giorni.
        return '[testo-illeggibile]';
    }
}
