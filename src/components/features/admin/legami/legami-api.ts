/**
 * ════════════════════════════════════════════════════════════════════════════
 * IL CLIENT DI `/api/admin/legami-familiari` — un posto solo per tre gesti.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * La rotta, il modulo di scrittura e i codici d'errore esistevano dal 2026-09-05
 * e **non li chiamava nessuno**: `grep -rn "legami-familiari" src/` non trovava
 * una sola `fetch`. Questo file è il primo chiamante, e sta qui — non dentro un
 * componente — perché i chiamanti sono TRE (la ricerca, la conferma di
 * scollegamento, la tendina del ruolo) su DUE schede: la traduzione di un
 * rifiuto, il livello del log e la forma del corpo devono dire la stessa cosa da
 * tutte e tre le parti.
 *
 * ─── PERCHÉ `messaggioDaCorpo` E NON `messaggioErrore` ──────────────────────
 *
 * Sono la stessa decisione: `messaggioErrore` è il guscio che legge la risposta,
 * `messaggioDaCorpo` è la regola («codice dichiarato → catalogo, altrimenti la
 * prosa del server, altrimenti il ripiego»). Qui serve la seconda perché il corpo
 * va letto UNA volta sola (`res.json()` consuma lo stream) e da quel corpo serve
 * anche il `codice`: senza, il 409 `LEGAME_ULTIMO_GENITORE` — che è una
 * PROTEZIONE e non un guasto — arriverebbe alla UI indistinguibile da un 500, e
 * verrebbe dipinto di rosso con l'aria di qualcosa da riprovare. È lo stesso
 * motivo per cui `esito-fetch.ts` la esporta.
 *
 * ─── NIENTE NOMI NEI LOG ────────────────────────────────────────────────────
 *
 * Da qui passano anagrafiche di minori e di genitori. Nei log vanno il codice
 * d'errore, lo status e il verso dell'operazione: mai il testo cercato (è un
 * cognome o un codice fiscale), mai il nome di chi si sta collegando.
 */

import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { logClient } from '@/lib/logging/client';

/** La rotta, scritta una volta sola: tre chiamanti, un indirizzo. */
const ROTTA = '/api/admin/legami-familiari';

/** La pagina dell'incidente, per il log: è dove sta l'operatore, non dove va la fetch. */
const PAGINA = '/admin/students';

/**
 * Il vocabolario del ruolo. È quello di `RELAZIONI_FAMILIARI`
 * (`@/lib/anagrafiche/legami-scrittura`) e non si allarga da qui: la rotta valida
 * con `z.enum`, quindi un quarto valore sarebbe un 400 e non un ruolo nuovo.
 */
export const RUOLI_LEGAME = ['mother', 'father', 'delegate'] as const;
export type RuoloLegame = (typeof RUOLI_LEGAME)[number];

/** `true` se la stringa è uno dei tre ruoli canonici. */
export function eRuoloCanonico(valore: unknown): valore is RuoloLegame {
    return typeof valore === 'string' && (RUOLI_LEGAME as readonly string[]).includes(valore);
}

/** Che cosa si sta cercando: gli adulti (scheda del bambino) o i bambini (scheda dell'adulto). */
export type VersoLegame = 'genitori' | 'alunni';

/**
 * In che modo il legame è stato scritto: scegliendo un adulto già in ARCHIVIO
 * (`ricerca` → corpo con `parent_id`) oppure creandone uno NUOVO (`nuovo` →
 * corpo con `genitore`).
 *
 * Non è un dettaglio interno del dialogo: è ciò che permette di LEGGERE la
 * risposta. Sul ramo `genitore` la rotta risponde sempre `anagrafica:
 * 'gia-presente'` anche quando l'anagrafica l'ha appena creata — vedi
 * `avvisoDaEsito` in `GestoreLegami`, dove sta la misura.
 */
export type ModoAggiunta = 'ricerca' | 'nuovo';

/** Sotto i due caratteri non si cerca. Lo dice anche la rotta, che risponde vuoto. */
export const MINIMO_RICERCA = 2;

export interface GenitoreTrovato {
    id: string;
    first_name: string | null;
    last_name: string | null;
    fiscal_code: string | null;
    emails: string[] | null;
    /**
     * `false` NON è un errore: 64 anagrafiche su 747 in produzione non hanno
     * ancora un account, e il legame si scrive lo stesso — manca solo la riga
     * runtime, che nasce quando la Segreteria manda le credenziali.
     */
    ha_account: boolean;
    gia_collegato: boolean;
}

export interface AlunnoTrovato {
    id: string;
    nome: string | null;
    cognome: string | null;
    classe_sezione: string | null;
    gia_collegato: boolean;
}

/** Che cosa è successo, per come la rotta lo racconta (`EsitoCollega`/`EsitoScollega`). */
export interface EsitoScrittura {
    /**
     * L'ADULTO su cui la scrittura è finita, ed è l'unico modo che l'interfaccia
     * ha di sapere se il legame c'era già sul ramo «crea un adulto nuovo»: là
     * `anagrafica` esce sempre `gia-presente` (vedi `ModoAggiunta`), mentre questo
     * uuid dice CHI — e chi era già collegato lo sa la schermata, che l'elenco lo
     * ha in mano. La regola sta in `avvisoDaEsito` (`GestoreLegami`).
     *
     * ⚠️ SI CHIAMA `parentId`, IN CAMMELLO, e non è una svista da normalizzare: la
     * rotta serializza con `NextResponse.json(esito)` l'`EsitoCollega` di
     * `collegaFamiliare`, che quel campo lo chiama così. Il blocco «IL CONTRATTO»
     * in testa alla rotta scrive `parent_id`, cioè la prosa e il codice divergono:
     * qui vince il CODICE, e a fissarlo — contro la rotta vera, non contro un
     * doppio — è `__tests__/api/legami-familiari-ui-contratto-creazione.test.ts`.
     * Leggere anche `parent_id` «per sicurezza» avrebbe reso invisibile il giorno
     * in cui uno dei due cambia: qui una rinomina diventa un test rosso.
     */
    parentId?: string | null;
    anagrafica?: string | null;
    runtime?: string | null;
    relation_type?: string | null;
}

/**
 * IL RIFIUTO, in un tipo solo: lo condividono la ricerca e la scrittura.
 *
 * `codice` serve a distinguere la protezione dal guasto; `stato` a distinguere
 * «il server ha risposto di no» da «il server non ha risposto» (`stato: null`).
 */
export type RifiutoLegame = { ok: false; testo: string; codice: string | null; stato: number | null };

/** L'esito di una RICERCA, SENZA MAI LANCIARE. */
export type EsitoLegame<T> = { ok: true; dati: T } | RifiutoLegame;

/**
 * L'esito di una SCRITTURA — e il terzo caso, che non è né sì né no.
 *
 * `letto: false` significa che il server ha risposto **200** ma il corpo non si
 * è potuto leggere (proxy che restituisce HTML, risposta troncata,
 * `Content-Type` sbagliato). Non è un rifiuto — con un 200 la scrittura quasi
 * certamente c'è stata, e trattarlo da guasto lascerebbe a schermo un elenco
 * vecchio — ma non è nemmeno un esito: quello che si perde in silenzio è
 * `runtime: 'non-scritto'`, cioè il caso in cui il genitore vedrebbe il figlio
 * in anagrafica e NON i suoi pagamenti.
 *
 * Fino al terzo giro di questo lavoro qui c'era `(letto ?? {})`: un corpo
 * illeggibile diventava un esito vuoto e la schermata annunciava «Collegamento
 * salvato», senza una riga di log. È la stessa asimmetria già chiusa sulla
 * RICERCA in `righeDi` — là «non ho potuto guardare» non diventa «non c'è
 * nessuno», qui «non ho potuto leggere» non diventa «è andata bene».
 */
export type EsitoScritturaLegame =
    | { ok: true; letto: true; dati: EsitoScrittura }
    | { ok: true; letto: false; dati: null }
    | RifiutoLegame;

/** Il corpo del POST, nelle tre forme che la rotta accetta (schema `strict`). */
export type CorpoLegame =
    | { azione: 'collega'; alunno_id: string; parent_id: string; relation_type: RuoloLegame }
    | { azione: 'collega'; alunno_id: string; relation_type: RuoloLegame; genitore: Record<string, unknown> }
    | { azione: 'scollega'; alunno_id: string; parent_id: string }
    | { azione: 'cambia-ruolo'; alunno_id: string; parent_id: string; relation_type: RuoloLegame };

/**
 * Il rifiuto del server, tradotto e registrato.
 *
 * ⚠️ Il livello segue lo STATUS, e non è pedanteria: un 409 `LEGAME_ULTIMO_GENITORE`
 * è il sistema che funziona — l'operatore ha chiesto qualcosa che non si fa — e
 * finirebbe in `app_log` a livello `error` accanto ai guasti veri, cioè in mezzo
 * alle righe che qualcuno guarda quando qualcosa è rotto.
 */
async function rifiuto(res: Response, operazione: string, ripiego: string): Promise<RifiutoLegame> {
    const corpo = await res.json().catch(() => null);
    const codice = (corpo as { codice?: unknown } | null)?.codice;
    logClient({
        livello: res.status >= 500 ? 'error' : 'warn',
        evento: 'fetch',
        messaggio: `legami-${operazione}-rifiutato: ${typeof codice === 'string' ? codice : 'senza-codice'}`,
        route: PAGINA,
        stato: res.status,
    });
    return {
        ok: false,
        testo: messaggioDaCorpo(corpo, ripiego),
        codice: typeof codice === 'string' ? codice : null,
        stato: res.status,
    };
}

/**
 * La fetch che non è mai arrivata: rete giù, DNS, WebView addormentata.
 *
 * È il caso che nessun log del server vedrà mai, quindi la riga la lascia il
 * client. `stato: null` perché non c'è nessuno status da riportare: `0`
 * somiglierebbe a un codice HTTP vero.
 */
function nonArrivata(operazione: string, ripiego: string): RifiutoLegame {
    logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `legami-${operazione}-non-arrivata`,
        route: PAGINA,
    });
    return { ok: false, testo: ripiego, codice: null, stato: null };
}

/** Il corpo di una risposta riuscita, o `null` se non era JSON leggibile. */
async function corpoDi(res: Response): Promise<Record<string, unknown> | null> {
    const letto = await res.json().catch(() => null);
    return letto && typeof letto === 'object' ? (letto as Record<string, unknown>) : null;
}

/**
 * La riga di un 200 che non si è potuto leggere — una sola, per la ricerca e per
 * la scrittura.
 *
 * Il livello è `warn` e non `error`: il server ha risposto, e il 200 non è un
 * guasto applicativo. Ciò che non va è il corpo, e il numero che lo racconta è
 * lo `stato` accanto. È l'unica traccia che di questo caso esisterà mai: nei log
 * del server la richiesta risulta riuscita.
 */
function segnalaCorpoIlleggibile(res: Response, operazione: string): void {
    logClient({
        livello: 'warn',
        evento: 'fetch',
        messaggio: `legami-${operazione}-corpo-illeggibile`,
        route: PAGINA,
        stato: res.status,
    });
}

/**
 * Le righe di una ricerca RIUSCITA — o il rifiuto, se il corpo non si è potuto
 * leggere.
 *
 * ⚠️ «NON HO POTUTO GUARDARE» NON DIVENTA «NON C'È NESSUNO». Fino al secondo giro
 * di questo lavoro un 200 col corpo illeggibile (proxy che restituisce HTML,
 * risposta troncata, `Content-Type` sbagliato) usciva da qui come `{ok:true,
 * dati:[]}` **senza una riga di log**: a schermo diventava «Nessun risultato per
 * questa ricerca», l'operatore concludeva che quell'adulto in archivio non c'è e
 * apriva «crea un adulto nuovo». Il codice fiscale in quel modulo è facoltativo,
 * quindi senza codice il dedup di `linkOrCreateParent` non scatta: nasce
 * un'anagrafica doppia della stessa persona. La regola era già scritta per il
 * ramo `!res.ok` — «i due casi hanno rimedi opposti» — e mancava solo qui.
 *
 * Anche una chiave che non è un array è la stessa cosa: sulla ricerca la rotta
 * risponde SEMPRE `{ genitori: [...] }` o `{ alunni: [...] }`, degradi compresi
 * (un ambiente senza migrazioni esce con l'elenco VUOTO, non senza la chiave).
 */
async function righeDi<T>(
    res: Response,
    chiave: 'genitori' | 'alunni',
    operazione: string,
    ripiego: string,
): Promise<EsitoLegame<T[]>> {
    const corpo = await corpoDi(res);
    const righe = corpo?.[chiave];
    if (!Array.isArray(righe)) {
        segnalaCorpoIlleggibile(res, operazione);
        return { ok: false, testo: ripiego, codice: null, stato: res.status };
    }
    return { ok: true, dati: righe as T[] };
}

/**
 * Cerca fra gli ADULTI già in archivio (scheda del bambino).
 *
 * `alunnoId` non è facoltativo per comodità: è ciò che permette alla rotta di
 * marcare `gia_collegato`, cioè di non riproporre chi c'è già.
 */
export async function cercaGenitori(
    q: string,
    alunnoId: string,
    ripiego: string,
): Promise<EsitoLegame<GenitoreTrovato[]>> {
    const par = new URLSearchParams({ tipo: 'genitori', q, alunno_id: alunnoId });
    const res = await fetch(`${ROTTA}?${par.toString()}`).catch(() => null);
    if (!res) return nonArrivata('ricerca-genitori', ripiego);
    if (!res.ok) return rifiuto(res, 'ricerca-genitori', ripiego);
    return righeDi<GenitoreTrovato>(res, 'genitori', 'ricerca-genitori', ripiego);
}

/** Cerca fra i BAMBINI (scheda dell'adulto). Stesso legame, verso opposto. */
export async function cercaAlunni(
    q: string,
    parentId: string,
    ripiego: string,
): Promise<EsitoLegame<AlunnoTrovato[]>> {
    const par = new URLSearchParams({ tipo: 'alunni', q, parent_id: parentId });
    const res = await fetch(`${ROTTA}?${par.toString()}`).catch(() => null);
    if (!res) return nonArrivata('ricerca-alunni', ripiego);
    if (!res.ok) return rifiuto(res, 'ricerca-alunni', ripiego);
    return righeDi<AlunnoTrovato>(res, 'alunni', 'ricerca-alunni', ripiego);
}

/** Le tre scritture: collega, scollega, cambia-ruolo. Una funzione sola, un corpo per azione. */
export async function scriviLegame(corpo: CorpoLegame, ripiego: string): Promise<EsitoScritturaLegame> {
    const res = await fetch(ROTTA, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
    }).catch(() => null);
    if (!res) return nonArrivata(corpo.azione, ripiego);
    if (!res.ok) return rifiuto(res, corpo.azione, ripiego);
    const letto = await corpoDi(res);
    // ⚠️ QUI NON SI RIPIEGA SU `{}`. Un esito vuoto passa indenne per ogni ramo di
    // `avvisoDaEsito` e finisce sull'ultimo — «Collegamento salvato» — cioè
    // afferma un risultato che nessuno ha verificato, proprio nel gesto che dà a
    // un adulto la vista su un minore.
    if (!letto) {
        segnalaCorpoIlleggibile(res, corpo.azione);
        return { ok: true, letto: false, dati: null };
    }
    return { ok: true, letto: true, dati: letto as EsitoScrittura };
}
