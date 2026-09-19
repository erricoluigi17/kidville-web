import type { SupabaseClient } from '@supabase/supabase-js';
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi';

/**
 * ─── I NOMI DI UN ELENCO DI ADESIONI, IN UN POSTO SOLO ───────────────────────
 *
 * Le rotte che leggono le risposte di un avviso sono DUE, e leggono la stessa
 * cosa: `GET /api/avvisi/[id]/risposte` (la schermata su cui la segreteria decide
 * chi va in gita) e `GET /api/avvisi/[id]/risposte/esporta` (il file che stampa e
 * si porta dietro). Fino al 2026-09-19 la risoluzione dei nomi era scritta due
 * volte, e le due copie **divergevano già**:
 *
 *   · l'export filtrava gli alunni per la sede dell'avviso, la GET no → una riga
 *     che punta a un minore di un altro plesso SPARIVA dal file (con Classe e
 *     Alunno vuote, e nessun log) e COMPARIVA a schermo, col nome, contata nel
 *     riepilogo;
 *   · l'export componeva il nome del genitore con `trim()` e ripiego a stringa
 *     vuota, la GET no → un genitore senza cognome usciva `«Anna null»` da una
 *     parte e `«Anna»` dall'altra.
 *
 * Nessuna delle due diceva perché. Questo modulo esiste perché **una regola
 * valida per più strade vive in un posto solo, o le copie divergono** — è la
 * stessa frase scritta in testa a `classi-sede.ts`, dove il conto era 10 alunni,
 * 10 genitori e 0 raggiunti.
 *
 * ─── PERCHÉ QUESTO MODULO NON LOGGA ─────────────────────────────────────────
 *
 * Restituisce i guasti (`nonLetti`) e i buchi (`nonRisolti`) invece di scriverli:
 * le due rotte hanno due `operazione` diverse e due reazioni diverse allo stesso
 * errore — la GET risponde 200 con i nomi che ha, l'export rifiuta con un 503,
 * perché un file di adesioni a metà si stampa e si porta in gita senza che
 * nessuno sappia che è a metà. Un log scritto qui dentro direbbe una sola delle
 * due verità. Ciò che NON è facoltativo è che ciascuna rotta li logghi: un
 * risultato d'errore ignorato qui è un `catch` muto scritto in un altro modo.
 */

/** Un alunno, come lo mostrano le due letture: nessun campo in più. */
export interface AlunnoDiRisposta {
    /** «Nome Cognome», già composto e ripulito. */
    nome: string;
    /** `classe_sezione`, o stringa vuota quando la riga non la porta. */
    classe: string;
}

/** Un blocco che PostgREST ha rifiutato: l'errore e quanti id sono rimasti fuori. */
export interface BloccoNonLetto {
    error: { code?: string; message?: string };
    /** Quanti id c'erano nel blocco fallito: «è rotto» e «è rotto su 40 famiglie». */
    n: number;
}

export interface EsitoNomi<T> {
    /** Id → valore risolto. Un id assente dalla mappa non ha un nome da mostrare. */
    valori: Map<string, T>;
    /**
     * Quanti id CHIESTI non compaiono nella mappa, per qualunque ragione: la riga
     * non c'è più, oppure il filtro di sede l'ha tenuta fuori, oppure il blocco
     * che la conteneva è fallito. È il conteggio che rompe il silenzio: senza,
     * «manca un nome» e «quel bambino è di un altro plesso» sono la stessa cella
     * vuota.
     */
    nonRisolti: number;
    /** I blocchi falliti. Vuoto = nessun guasto di lettura. */
    nonLetti: BloccoNonLetto[];
}

/** Il codice di un errore PostgREST, quando c'è. */
function comeErrore(err: unknown): { code?: string; message?: string } {
    const e = (err ?? {}) as { code?: unknown; message?: unknown };
    return {
        code: typeof e.code === 'string' ? e.code : undefined,
        message: typeof e.message === 'string' ? e.message : undefined,
    };
}

/** Gli id unici e non vuoti di una colonna di riferimento. */
function idUnici(ids: readonly (string | null | undefined)[]): string[] {
    return [...new Set(ids.filter((v): v is string => typeof v === 'string' && v !== ''))];
}

/**
 * I NOMI DEI GENITORI — e perché NON si filtrano per sede.
 *
 * È una decisione, non una dimenticanza: **due fratelli possono stare in due
 * plessi**, e `utenti.scuola_id` di un genitore non dice a quale avviso
 * appartiene la sua risposta. Filtrarli qui farebbe sparire il nome di chi ha
 * risposto per il figlio «giusto» solo perché l'altro figlio è iscritto altrove.
 * Il perimetro è chiuso a monte: questi id vengono dalle righe di un avviso già
 * verificato, mai dal client.
 *
 * Il nome si compone dalle DUE coppie di colonne che convivono in `utenti`
 * (`first_name/last_name` dell'anagrafica nuova, `nome/cognome` di quella
 * storica) e si ripiega su stringa vuota, mai su `null`: `«Anna null»` è il modo
 * in cui una mezza anagrafica finiva dentro un CSV che si stampa.
 */
export async function nomiGenitoriDelleRisposte(
    supabase: SupabaseClient,
    parentIds: readonly (string | null | undefined)[],
): Promise<EsitoNomi<string>> {
    const unici = idUnici(parentIds);
    const valori = new Map<string, string>();
    const nonLetti: BloccoNonLetto[] = [];

    for (const blocco of aBlocchi(unici, ID_PER_QUERY)) {
        const { data, error } = await supabase
            .from('utenti')
            .select('id, nome, cognome, first_name, last_name')
            .in('id', blocco);
        // 🔴 PostgREST non lancia: qui l'errore va RESTITUITO, non destrutturato
        // via. Prima, in una delle due copie, finiva nel nulla e la riga usciva
        // con un `'?'` indistinguibile da «quel genitore non c'è».
        if (error) {
            nonLetti.push({ error: comeErrore(error), n: blocco.length });
            continue;
        }
        for (const u of data ?? []) {
            const nome = ((u.first_name as string | null) || (u.nome as string | null) || '').trim();
            const cognome = ((u.last_name as string | null) || (u.cognome as string | null) || '').trim();
            valori.set(u.id as string, `${nome} ${cognome}`.trim());
        }
    }

    return { valori, nonRisolti: unici.length - valori.size, nonLetti };
}

/**
 * GLI ALUNNI DI UN ELENCO DI ADESIONI — filtrati per la sede DELL'AVVISO.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 🔴 LA DECISIONE SUL TRASFERITO, E PERCHÉ IL FILTRO RESTA (2026-09-19)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Questo `.eq('scuola_id', …)` tiene fuori DUE popolazioni che non si
 * distinguono guardando la sede, e va detto quali sono, perché finché non è
 * scritto il filtro «protegge» nascondendo anche ciò che è vero:
 *
 *  1. **la riga anomala** — un genitore con due figli in due plessi che risponde
 *     a un avviso di una sede mandando lo `student_id` del figlio dell'altra.
 *     Fino a oggi la scrittura non lo impediva; da oggi sì
 *     (`POST /api/avvisi/[id]/risposte` rifiuta con 403 prima della RPC), quindi
 *     questa popolazione non può più CRESCERE — restano le righe scritte prima;
 *  2. **il trasferito** — un alunno che aderisce e poi cambia plesso. La sua riga
 *     è LEGITTIMA, il posto lo occupa davvero, e col filtro sparisce da un elenco
 *     di cui è parte.
 *
 * SI È SCELTO DI TENERE IL FILTRO, e il ragionamento è questo:
 *
 *  · i due errori non costano uguale. Mostrare il nome e la classe di un minore
 *    che oggi è iscritto in un altro plesso, dentro un CSV che esce
 *    dall'edificio, non si annulla; non mostrarlo costa alla segreteria una
 *    telefonata — la riga c'è lo stesso, col nome del genitore accanto (che non
 *    si filtra, vedi sopra), lo stato dell'adesione e il numero di persone;
 *  · la scelta di nascondere era già stata presa e scritta nell'export
 *    («impedisce che il suo nome finisca in un file scaricato da un'altra
 *    sede»). Ribaltarla di soppiatto dentro una correzione di isolamento
 *    sarebbe stato il tipo di decisione che questo repo paga due volte;
 *  · **il difetto non era il filtro: era il silenzio**, e il silenzio si chiude
 *    altrove. Le due letture applicano ora lo STESSO filtro (prima una sola lo
 *    faceva, e i due elenchi non erano d'accordo) e ciascuna logga
 *    `alunni-non-risolti` col conteggio. «Manca un nome» e «quel bambino è di un
 *    altro plesso» restano la stessa cella vuota a schermo, ma non nei log.
 *
 * COSA SERVIREBBE PER CAMBIARE IDEA, il giorno in cui la telefonata pesasse più
 * della riga nascosta: un modo di distinguere le due popolazioni — cioè sapere
 * che quell'alunno ERA in questa sede quando ha aderito. Oggi lo schema non lo
 * sa: `alunni.scuola_id` porta la sede di ADESSO e non c'è traccia del
 * trasferimento. Chi vorrà tenere e marcare parta da lì, non da questa riga.
 *
 * ⚠️ `sedeAvviso` vuota = NESSUN nome. Entrambe le rotte hanno già rifiutato un
 * avviso senza plesso (403/404) prima di arrivare qui, quindi è un caso che non
 * accade; se accadesse, leggere senza filtro vorrebbe dire leggere l'anagrafica
 * di tre sedi per un avviso che non ne dichiara nessuna. Si fallisce chiusi, e
 * il `nonRisolti` che ne esce fa scattare il `warn` della rotta.
 */
export async function alunniDelleRisposte(
    supabase: SupabaseClient,
    studentIds: readonly (string | null | undefined)[],
    sedeAvviso: string | null | undefined,
): Promise<EsitoNomi<AlunnoDiRisposta>> {
    const unici = idUnici(studentIds);
    const valori = new Map<string, AlunnoDiRisposta>();
    const nonLetti: BloccoNonLetto[] = [];

    const sede = typeof sedeAvviso === 'string' ? sedeAvviso.trim() : '';
    if (sede === '') return { valori, nonRisolti: unici.length, nonLetti };

    for (const blocco of aBlocchi(unici, ID_PER_QUERY)) {
        const { data, error } = await supabase
            .from('alunni')
            .select('id, nome, cognome, classe_sezione')
            .in('id', blocco)
            .eq('scuola_id', sede);
        if (error) {
            nonLetti.push({ error: comeErrore(error), n: blocco.length });
            continue;
        }
        for (const a of data ?? []) {
            valori.set(a.id as string, {
                nome: `${((a.nome as string | null) ?? '').trim()} ${((a.cognome as string | null) ?? '').trim()}`.trim(),
                classe: (a.classe_sezione as string | null) ?? '',
            });
        }
    }

    return { valori, nonRisolti: unici.length - valori.size, nonLetti };
}
