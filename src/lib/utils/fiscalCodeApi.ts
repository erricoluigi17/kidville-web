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
    } catch (error) {
        console.warn("API esterna fallita o irraggiungibile. Utilizzo algoritmo di fallback offline...");
        
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
        } catch (localErr) {
            console.warn("Impossibile calcolare il CF automaticamente coi dati forniti.");
            return "";
        }
    }
}
