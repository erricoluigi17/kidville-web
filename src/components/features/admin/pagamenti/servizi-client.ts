/**
 * Servizi mensili, lato interfaccia: tipi delle risposte e le chiamate alle route
 * `/api/pagamenti/servizi` e `/api/pagamenti/genera-servizi`. Niente React qui.
 *
 * Gli errori si loggano col solo `stato` e il `codice` (costanti maiuscole del server): il corpo
 * può contenere nomi di bambini, quindi non entra mai nel log.
 */
import { LIMITE_ELENCO_ALUNNI } from '@/lib/api/paginazione';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import type { MotivoIntoccabile } from '@/lib/pagamenti/servizi-mensili';

export const PAGINA_SERVIZI = '/admin/pagamenti';
const ROUTE_SERVIZI = '/api/pagamenti/servizi';

export const intestazioni = (userId: string) => ({ 'Content-Type': 'application/json', 'x-user-id': userId });

export interface Servizio {
    id: string;
    nome: string;
    slug: string;
    scuola_id: string;
    importo_mensile_default: number | string | null;
}

export interface IscrizioneServizio {
    id: string;
    alunno_id: string;
    categoria_id: string;
    importo_mensile: number | string;
    dal: string;
    al: string | null;
    alunno: { nome: string | null; cognome: string | null; classe_sezione: string | null; stato: string | null } | null;
}

export type DatiServizi =
    | { non_disponibile: true }
    | { non_disponibile?: false; servizi: Servizio[]; iscrizioni: IscrizioneServizio[] };

export interface VoceDaDecidere {
    id: string;
    periodo: string | null;
    importo: number | string;
    scadenza: string | null;
    stato: string | null;
    sollecitata: boolean;
    motivo?: MotivoIntoccabile;
}
export interface VociDaDecidere { eliminabili: VoceDaDecidere[]; intoccabili: VoceDaDecidere[] }

export interface EsitoOk { tipo: 'ok'; dati: Record<string, unknown> }
export interface EsitoErrore {
    tipo: 'errore';
    testo: string;
    /** Voci già cancellate prima del guasto: se > 0 va detto all'utente. */
    vociEliminate: number;
}
export interface EsitoDaDecidere { tipo: 'da_decidere'; voci: VociDaDecidere }
export type EsitoScrittura = EsitoOk | EsitoErrore | EsitoDaDecidere;

export const importoNumero = (v: number | string | null | undefined): number => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

/** Il codice del server solo se ha la forma di una costante: nel log non entra altro. */
const codiceSicuro = (corpo: unknown): string => {
    const c = (corpo as { codice?: unknown } | null)?.codice;
    return typeof c === 'string' && /^[A-Z_]{3,60}$/.test(c) ? `:${c}` : '';
};

async function leggiCorpo(res: Response, evento: string): Promise<unknown> {
    try {
        return await res.json();
    } catch (err) {
        logClient({ livello: 'warn', evento: 'fetch', messaggio: `${evento}-corpo-illeggibile: ${nomeErrore(err)}`, route: PAGINA_SERVIZI, stato: res.status });
        return null;
    }
}

/**
 * Carica servizi e iscrizioni. Ritorna `{dati}` oppure `{errore}`: il testo del catalogo o del
 * server, oppure `''` quando non c'è niente di meglio e chi chiama scrive il proprio ripiego.
 */
export async function caricaServizi(
    userId: string, scuolaId: string,
): Promise<{ dati: DatiServizi } | { errore: string }> {
    const evento = 'servizi-lettura-respinta';
    try {
        const res = await fetch(`${ROUTE_SERVIZI}?scuola_id=${encodeURIComponent(scuolaId)}`, { headers: intestazioni(userId) });
        const corpo = await leggiCorpo(res, 'servizi-lettura');
        if (!res.ok) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: `${evento}${codiceSicuro(corpo)}`, route: PAGINA_SERVIZI, stato: res.status });
            return { errore: messaggioDaCorpo(corpo, '') };
        }
        const dati = (corpo as { data?: DatiServizi } | null)?.data;
        if (!dati) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: 'servizi-lettura-senza-dati', route: PAGINA_SERVIZI, stato: res.status });
            return { errore: '' };
        }
        return { dati };
    } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `servizi-lettura-non-riuscita: ${nomeErrore(err)}`, route: PAGINA_SERVIZI });
        return { errore: '' };
    }
}

export interface AlunnoElenco { id: string; nome?: string | null; cognome?: string | null; classe_sezione?: string | null }

/** I bambini iscritti alla scuola (sede indicata): `[]` + `errore` se la lettura non riesce. */
export async function caricaAlunni(userId: string, scuolaId: string): Promise<{ alunni: AlunnoElenco[]; errore: boolean }> {
    try {
        const res = await fetch(
            `/api/admin/students?stato=iscritto&scuola_id=${encodeURIComponent(scuolaId)}&limit=${LIMITE_ELENCO_ALUNNI}`,
            { headers: intestazioni(userId) },
        );
        if (!res.ok) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: 'servizi-alunni-lettura-respinta', route: PAGINA_SERVIZI, stato: res.status });
            return { alunni: [], errore: true };
        }
        const corpo = await res.json() as unknown;
        const lista = Array.isArray(corpo) ? corpo : ((corpo as { data?: unknown } | null)?.data ?? []);
        return { alunni: Array.isArray(lista) ? (lista as AlunnoElenco[]) : [], errore: false };
    } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `servizi-alunni-non-caricati: ${nomeErrore(err)}`, route: PAGINA_SERVIZI });
        return { alunni: [], errore: true };
    }
}

/**
 * Una scrittura (POST/PATCH/DELETE) con l'esito già classificato. Il 409 `VOCI_FUTURE_DA_DECIDERE`
 * non è un errore: è il primo dei due tempi, e porta le voci fra cui scegliere.
 */
export async function scriviServizi(
    userId: string, metodo: 'POST' | 'PATCH' | 'DELETE', evento: string, fallback: string,
    opzioni: { body?: Record<string, unknown>; query?: URLSearchParams },
): Promise<EsitoScrittura> {
    const url = opzioni.query ? `${ROUTE_SERVIZI}?${opzioni.query.toString()}` : ROUTE_SERVIZI;
    try {
        const res = await fetch(url, {
            method: metodo,
            headers: intestazioni(userId),
            ...(opzioni.body ? { body: JSON.stringify(opzioni.body) } : {}),
        });
        const corpo = await leggiCorpo(res, evento);
        if (res.ok) return { tipo: 'ok', dati: ((corpo as { data?: Record<string, unknown> } | null)?.data) ?? {} };
        const c = corpo as { codice?: unknown; data?: Partial<VociDaDecidere>; voci_eliminate?: unknown } | null;
        if (res.status === 409 && c?.codice === 'VOCI_FUTURE_DA_DECIDERE') {
            return { tipo: 'da_decidere', voci: { eliminabili: c.data?.eliminabili ?? [], intoccabili: c.data?.intoccabili ?? [] } };
        }
        logClient({ livello: 'error', evento: 'fetch', messaggio: `${evento}${codiceSicuro(corpo)}`, route: PAGINA_SERVIZI, stato: res.status });
        const eliminate = importoNumero(c?.voci_eliminate as number | string | undefined);
        return { tipo: 'errore', testo: messaggioDaCorpo(corpo, fallback), vociEliminate: eliminate > 0 ? Math.floor(eliminate) : 0 };
    } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `${evento}-non-riuscita: ${nomeErrore(err)}`, route: PAGINA_SERVIZI });
        return { tipo: 'errore', testo: fallback, vociEliminate: 0 };
    }
}

/**
 * L'importo scritto a mano («85,50»): virgola o punto, niente segno, al massimo due decimali,
 * maggiore di zero e al massimo 99999,99. `null` se non valido.
 */
export function leggiImporto(grezzo: string): number | null {
    const s = grezzo.trim();
    if (!/^\d+([.,]\d{1,2})?$/.test(s)) return null;
    const n = Number(s.replace(',', '.'));
    return n > 0 && n <= 99999.99 ? n : null;
}

/** Da 'YYYY-MM-01' al valore di un `<input type="month">`. */
export const aMeseInput = (periodo: string | null): string => (periodo ? periodo.slice(0, 7) : '');

/** Il mese corrente come 'YYYY-MM' (fuso di Roma, non quello dell'ambiente). */
export function meseCorrente(adesso: Date = new Date()): string {
    const parti = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit' }).formatToParts(adesso);
    const anno = parti.find((p) => p.type === 'year')?.value ?? String(adesso.getFullYear());
    const mese = parti.find((p) => p.type === 'month')?.value ?? '01';
    return `${anno}-${mese}`;
}
