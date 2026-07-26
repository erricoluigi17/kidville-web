import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * Calcolo del codice fiscale. Gira SOLO nel browser: lo importano i tre form dell'anagrafica
 * (alunno, adulto, registro), e i suoi `params` sono nome, cognome e luogo di nascita di una
 * persona reale — spesso di un bambino. Per questo qui non si logga MAI un parametro, e degli
 * errori esce soltanto la classe: il resto è, letteralmente, il dato.
 */
export interface FiscalCodeParams {
    nome: string;
    cognome: string;
    sesso: 'M' | 'F';
    data_nascita: string; // YYYY-MM-DD
    comune_nascita: string;
    provincia_nascita: string;
}

export async function fetchFiscalCode(params: FiscalCodeParams): Promise<string> {
    try {
        // Chiamata all'API esterna pubblica (esempio). 
        // Nota: alcuni di questi endpoint potrebbero richiedere token o avere limitazioni CORS se chiamati da browser.
        const res = await fetch('https://api.codicefiscale.it/api/v1/calcola', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // 'Authorization': `Bearer ${process.env.NEXT_PUBLIC_CF_API_KEY}`
            },
            body: JSON.stringify({
                nome: params.nome,
                cognome: params.cognome,
                sesso: params.sesso,
                data_nascita: params.data_nascita,
                comune: params.comune_nascita,
                provincia: params.provincia_nascita
            })
        });

        if (res.ok) {
            const data = await res.json();
            if (data && data.codice_fiscale) {
                return data.codice_fiscale;
            }
        }
        
        throw new Error('API non disponibile o errore di validazione');
    } catch (e) {
        // `warn` e non `error`: questo ramo è PREVISTO — c'è un fallback offline subito sotto e
        // l'utente non vede nulla di rotto. Ma loggato sì: un catch muto è un bug (AGENTS.md,
        // regola 6), e senza questa riga non sapremmo mai che l'API esterna è morta e che
        // stiamo calcolando tutti i codici fiscali col fallback.
        logClient({ livello: 'warn', evento: 'fetch', messaggio: `cf-api-esterna-non-raggiungibile-uso-fallback: ${nomeErrore(e)}` });

        // Simulo un leggero delay di rete per mantenere la UX di caricamento
        await new Promise(resolve => setTimeout(resolve, 600));
        
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
            logClient({ livello: 'warn', evento: 'js', messaggio: `cf-fallback-locale-non-calcolabile: ${nomeErrore(errLocale)}` });
            return "";
        }
    }
}
