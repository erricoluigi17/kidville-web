import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * Calcolo del codice fiscale. Gira SOLO nel browser: lo importano i tre form dell'anagrafica
 * (alunno, adulto, registro), e i suoi `params` sono nome, cognome e luogo di nascita di una
 * persona reale — spesso di un bambino. Per questo qui non si logga MAI un parametro, e degli
 * errori esce soltanto la classe: il resto è, letteralmente, il dato.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * ⚠️ QUESTA FUNZIONE MANDA I DATI DI UN MINORE A UN SERVIZIO TERZO.
 *
 * `POST https://api.codicefiscale.it/api/v1/calcola` riceve, dal browser del genitore o
 * della segreteria: NOME, COGNOME, SESSO, DATA DI NASCITA, COMUNE e PROVINCIA di nascita.
 * Non è un dato tecnico: con quei sei campi si identifica una persona, e la persona è quasi
 * sempre un bambino. Non c'è nessun consenso a monte che copra questo trasferimento, e il
 * fornitore non compare in nessuna informativa: chi decide se un servizio terzo può
 * ricevere quei dati — e a che titolo — è il titolare del trattamento, non questo file.
 * La chiamata resta dov'era APPOSTA: toglierla è una decisione di titolarità, non di
 * codice, e va presa da chi risponde del trattamento. Qui si è corretta solo la cecità.
 *
 * Da notare, perché rende la domanda più che legittima: il fallback locale
 * (`codice-fiscale-js`, in-bundle) calcola lo stesso codice SENZA far uscire niente dal
 * dispositivo, e nei log si vede che funziona.
 * ─────────────────────────────────────────────────────────────────────────────────
 */
export interface FiscalCodeParams {
    nome: string;
    cognome: string;
    sesso: 'M' | 'F';
    data_nascita: string; // YYYY-MM-DD
    comune_nascita: string;
    provincia_nascita: string;
}

const ENDPOINT = 'https://api.codicefiscale.it/api/v1/calcola';

/** Quanto corpo d'errore si tiene. Come `externalFetch` lato server: abbastanza per capire. */
const CORPO_MAX = 300;

/**
 * I valori più corti di così non si mascherano: sono `sesso` (1 carattere) e la provincia
 * (2), e cercarli dentro un testo distruggerebbe le parole che li contengono — «FORMAT»
 * contiene «RM». Da soli non identificano nessuno; il costo del mascheramento sarebbe un
 * messaggio d'errore illeggibile, cioè di nuovo la cecità che si sta correggendo.
 */
const MASCHERA_MIN = 3;

export async function fetchFiscalCode(params: FiscalCodeParams): Promise<string> {
    const dallApi = await calcolaConApiEsterna(params);
    if (dallApi !== null) return dallApi;

    // Simulo un leggero delay di rete per mantenere la UX di caricamento
    await new Promise(resolve => setTimeout(resolve, 600));

    return await calcolaInLocale(params);
}

/**
 * La chiamata al servizio terzo. Ritorna il codice, oppure `null` — e in quel caso ha GIÀ
 * loggato perché, che è tutto il punto di questa funzione.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL CORPO DELL'ERRORE NON SI BUTTA VIA (AGENTS.md, regola 3), MA I DATI NON TORNANO
 * INDIETRO (regola 8). Le due regole qui si scontrano davvero: i parametri della richiesta
 * sono i dati di un minore, e il corpo d'errore di un servizio di validazione echeggia
 * quasi sempre l'input che ha rifiutato («comune non valido: Giugliano in Campania per
 * Aurora Bellandi»). Loggare il corpo grezzo significherebbe versare in `app_log` — via
 * `/api/logs`, dove nessuna lista bianca lo guarda, perché il messaggio è testo libero —
 * esattamente i campi che tutto il resto del sistema si dà la pena di hashare.
 *
 * La conciliazione è che si conosce ESATTAMENTE cosa non deve tornare: sono i sei valori
 * che abbiamo appena spedito noi. `mascheraDati` li toglie dal corpo prima di loggarlo.
 * Resta lo status, resta la forma dell'errore («comune non valido», «api key revoked»,
 * «quota exceeded»): resta cioè tutto ciò che serve per sapere se il guasto è nostro, del
 * provider o del dato — che è la domanda che il codice di prima non permetteva di porre.
 * ─────────────────────────────────────────────────────────────────────────────────
 */
async function calcolaConApiEsterna(params: FiscalCodeParams): Promise<string | null> {
    let res: Response;
    try {
        res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nome: params.nome,
                cognome: params.cognome,
                sesso: params.sesso,
                data_nascita: params.data_nascita,
                comune: params.comune_nascita,
                provincia: params.provincia_nascita,
            }),
        });
    } catch (e) {
        // Non ha risposto NESSUNO: DNS, rete giù, CORS, richiesta annullata. È il ramo che
        // prima inghiottiva anche i 403 — ora ci arriva solo ciò che davvero non ha risposto,
        // e la distinzione fra «il provider ci ha detto di no» e «il provider non c'è» è
        // ricostruibile dai log invece che da un'ipotesi.
        avvisa('fetch', `cf-api-esterna-non-raggiungibile-uso-fallback: ${nomeErrore(e)}`);
        return null;
    }

    if (!res.ok) {
        // `403` non dice niente. `403 "the domain is not verified"` dice tutto: è la lezione
        // pagata con le email di credenziali, e vale identica per questo provider.
        avvisa('fetch', `cf-api-esterna-http-${res.status}-uso-fallback: ${await corpoSicuro(res, params)}`);
        return null;
    }

    let data: unknown = null;
    try {
        data = await res.json();
    } catch (e) {
        avvisa('fetch', `cf-api-esterna-risposta-illeggibile-uso-fallback: ${nomeErrore(e)}`);
        return null;
    }

    const cf = (data as { codice_fiscale?: unknown } | null)?.codice_fiscale;
    if (typeof cf === 'string' && cf !== '') return cf;

    // 200 ma senza il campo atteso: un guasto vero (contratto cambiato, risposta di un
    // captive portal) che senza questa riga sarebbe indistinguibile da una rete morta.
    // NIENTE CORPO, qui: il corpo di una risposta RIUSCITA contiene il codice fiscale del
    // bambino, ed è il dato che questo file esiste per calcolare — non per raccontare.
    avvisa('fetch', 'cf-api-esterna-risposta-senza-codice-fiscale-uso-fallback');
    return null;
}

async function calcolaInLocale(params: FiscalCodeParams): Promise<string> {
    try {
        // Importiamo dinamicamente per non appesantire il bundle iniziale se l'API esterna funziona
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const CF = (await import('codice-fiscale-js')) as any;
        const CodiceFiscale = CF.default ?? CF.CodiceFiscale ?? CF;
        const cf = new CodiceFiscale({
            name: params.nome,
            surname: params.cognome,
            gender: params.sesso,
            day: parseInt(params.data_nascita.split('-')[2]),
            month: parseInt(params.data_nascita.split('-')[1]),
            year: parseInt(params.data_nascita.split('-')[0]),
            birthplace: params.comune_nascita,
            prov: params.provincia_nascita,
        });
        return cf.code;
    } catch (errLocale) {
        // Anche qui `warn`: il campo CF resta compilabile a mano, quindi per l'utente non
        // è un guasto. `evento: 'js'` perché a fallire è la libreria locale, non la rete —
        // ed è la distinzione che dice se il problema è nostro o del comune di nascita
        // che non sta in tabella. I dati inseriti NON si loggano: sono di un minore.
        avvisa('js', `cf-fallback-locale-non-calcolabile: ${nomeErrore(errLocale)}`);
        return '';
    }
}

/**
 * `warn` e non `error`: questi rami sono PREVISTI — c'è un fallback locale che funziona e
 * l'utente non vede nulla di rotto. Ma loggati sì: un catch muto è un bug (AGENTS.md,
 * regola 6), e senza queste righe non sapremmo mai che l'API esterna è morta e che stiamo
 * calcolando tutti i codici fiscali col fallback.
 */
function avvisa(evento: 'fetch' | 'js', messaggio: string): void {
    logClient({ livello: 'warn', evento, messaggio });
}

/** Il corpo dell'errore, senza i dati che gli abbiamo appena spedito noi. Non lancia mai. */
async function corpoSicuro(res: Response, params: FiscalCodeParams): Promise<string> {
    try {
        const testo = await res.text();
        return mascheraDati(testo, params) || '[corpo vuoto]';
    } catch {
        // Il corpo è già stato consumato, o lo stream si è rotto: lo si dichiara, non si tace.
        return '[corpo illeggibile]';
    }
}

/**
 * Toglie dal testo i valori della richiesta. Non è un'euristica sui valori — quelle danno
 * falsi negativi e fanno dormire tranquilli (§5 del design): qui i valori da togliere sono
 * NOTI ESATTAMENTE, perché li abbiamo appena spediti noi.
 */
function mascheraDati(testo: string, params: FiscalCodeParams): string {
    let out = testo.replace(/\s+/g, ' ').trim().slice(0, CORPO_MAX);
    for (const v of Object.values(params)) {
        if (typeof v !== 'string' || v.length < MASCHERA_MIN) continue;
        out = out.split(v).join('[dato]');
        // Anche senza rispettare le maiuscole: un provider può normalizzare l'input.
        const rx = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        out = out.replace(rx, '[dato]');
    }
    return out;
}
