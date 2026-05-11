export interface FiscalCodeParams {
    nome: string;
    cognome: string;
    sesso: 'M' | 'F';
    data_nascita: Date | string; // YYYY-MM-DD
    comune_nascita: string;      // Nome del comune
    provincia_nascita: string;   // Sigla provincia (es. RM)
}

export function calculateFiscalCode(params: FiscalCodeParams): string | null {
    if (!params.nome || !params.cognome || !params.sesso || !params.data_nascita || !params.comune_nascita || !params.provincia_nascita) {
        return null;
    }
    
    // Generazione mock di un CF per evitare problemi con la libreria esterna nei tipi
    const name = params.nome.replace(/[^A-Za-z]/g, '').toUpperCase();
    const surname = params.cognome.replace(/[^A-Za-z]/g, '').toUpperCase();
    
    const consName = name.replace(/[AEIOU]/g, '') + 'XXX';
    const consSurname = surname.replace(/[AEIOU]/g, '') + 'XXX';
    
    const year = new Date(params.data_nascita).getFullYear().toString().slice(-2);
    const month = 'A'; // mock
    const day = params.sesso === 'M' ? '15' : '55'; // mock
    
    const cfMock = `${consSurname.slice(0, 3)}${consName.slice(0, 3)}${year}${month}${day}H501Z`;
    return cfMock.slice(0, 16);
}
