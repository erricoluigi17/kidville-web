import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppUser } from '@/lib/auth/require-staff';
import { logScrittura } from '@/lib/audit/scrittura';
import { logErrore, logEvento } from '@/lib/logging/logger';

/**
 * ─── ANNULLA L'APPELLO DI UN BAMBINO: torna a «da registrare» ────────────────
 *
 * Decisione del titolare (spec 2026-09-24, punto 6): l'appello si annulla per
 * singolo bambino, su tutti i gradi (nido, infanzia, primaria), solo il giorno
 * stesso. Qui sta la parte che non dipende dal grado — la usano
 * `DELETE /api/attendance/daily` (0-6) e la rotta gemella della primaria. Il
 * controllo «solo oggi», il gate di ruolo e lo scope restano nelle rotte.
 *
 * ── PERCHÉ NON SI CANCELLA SEMPRE LA RIGA ───────────────────────────────────
 *
 * Genitore e maestra scrivono sulla STESSA riga di `presenze` (unica per
 * alunno+giorno). Il genitore che comunica un'assenza scrive `stato='assente'`,
 * `giustificata_da` e il motivo; la maestra, facendo l'appello, scrive lo stato,
 * gli orari e `registrato_da`. Cancellare la riga intera vorrebbe dire buttare
 * via la comunicazione del genitore — il motivo, la sua firma, la presa visione —
 * per un gesto che voleva annullare solo il lavoro della maestra. Quindi:
 *
 *  · nessuna riga                         → `non-trovata`;
 *  · `registrato_da` NULL                 → `niente-da-annullare` (c'è solo la
 *    comunicazione del genitore, l'appello non è mai stato fatto);
 *  · `giustificata_da` valorizzato        → si TORNA alla comunicazione:
 *    `stato='assente'`, `registrato_da`, orari e nota interna a null; i campi
 *    `giustificata_*`, `giustificazione_*` e `giust_vista_*` NON vengono nominati
 *    dall'update, quindi restano quelli che erano → `ripristinata-comunicazione`;
 *  · altrimenti                           → DELETE della riga → `cancellata`.
 *
 * `registrato_da IS NULL` è il criterio che la rotta del genitore usa per
 * permettergli di annullare la sua comunicazione: dopo il ripristino la famiglia
 * torna ad avere quella possibilità, come se la maestra non fosse mai passata.
 *
 * ── LA CORSA CON IL GENITORE ────────────────────────────────────────────────
 *
 * Fra la lettura e la scrittura il genitore può comunicare un'assenza sulla
 * stessa riga. Per questo la scrittura RIPETE la condizione che l'ha scelta:
 * la DELETE vale solo se `giustificata_da` è ancora null (mai cancellare una
 * comunicazione arrivata un attimo dopo), l'UPDATE solo se `registrato_da` è
 * ancora valorizzato. Se la condizione non regge più, nessuna riga viene toccata
 * e l'esito è `cambiata-nel-frattempo`: si rilegge e si decide di nuovo, non si
 * indovina.
 *
 * ── L'AVVISO DI ASSENZA ─────────────────────────────────────────────────────
 *
 * Annullando si ritira dalla coda l'avviso «assenza registrata all'appello»
 * ancora NON spedito — la stessa revoca della POST di `attendance/daily` e della
 * primaria (tipo `assenza_non_comunicata`, `entita_id` = alunno,
 * `push_inviata_il` null: il tipo è lo stesso per tutti i gradi). Se è già
 * partito non si manda nessuna rettifica: decisione del titolare.
 */

/** Le sei colonne dell'appello che tornano al client: mai motivo, firma o nota interna. */
export const COLONNE_PRESENZA_ESITO = 'id, alunno_id, data, stato, orario_entrata, orario_uscita';

/**
 * Cosa serve a decidere, e niente di più. `giustificazione_testo` (dato
 * sanitario), `giustificazione_firma` (email e IP del genitore) e `note_appello`
 * non si leggono: non servono alla decisione, e ciò che non si legge non può
 * finire nel diff dell'audit.
 */
const COLONNE_DECISIONE =
    'id, alunno_id, data, stato, orario_entrata, orario_uscita, registrato_da, giustificata_da, scuola_id, section_id';

export interface PresenzaEsito {
    id: string;
    alunno_id: string;
    data: string;
    stato: string;
    orario_entrata: string | null;
    orario_uscita: string | null;
}

export type EsitoAnnullaAppello =
    | { esito: 'non-trovata' }
    | { esito: 'niente-da-annullare' }
    | { esito: 'cambiata-nel-frattempo' }
    | { esito: 'errore'; fase: 'lettura' | 'scrittura' }
    | {
        esito: 'cancellata';
        presenza: null;
        presenzaId: string;
        /** La sede della riga annullata (letta, non chiesta al chiamante). */
        scuolaId: string;
        /** false se la revoca dell'avviso in coda è fallita (già loggato a `error`). */
        avvisoRitirato: boolean;
    }
    | {
        esito: 'ripristinata-comunicazione';
        presenza: PresenzaEsito;
        presenzaId: string;
        scuolaId: string;
        avvisoRitirato: boolean;
    };

export interface AnnullaAppelloInput {
    alunnoId: string;
    /** YYYY-MM-DD. Il «solo oggi» lo controlla la rotta. */
    data: string;
    /**
     * Facoltativo: la sezione su cui la rotta ha verificato lo scope. Quando c'è,
     * la riga si cerca ANCHE per `section_id` — è il caso della primaria, dove lo
     * scope è la classe (`assertSezioneInScope`) e non l'alunno: una presenza
     * registrata in un'altra classe (alunno spostato in giornata) non è di chi ha
     * superato il gate di QUESTA, e risulta `non-trovata`.
     */
    sectionId?: string;
    /** Chi annulla: l'utente restituito dal gate (`requireDocente`). */
    attore: AppUser;
    /** Il nome della rotta chiamante, per i log. */
    operazione?: string;
}

interface RigaDecisione {
    id: string;
    alunno_id: string;
    data: string;
    stato: string;
    orario_entrata: string | null;
    orario_uscita: string | null;
    registrato_da: string | null;
    giustificata_da: string | null;
    scuola_id: string;
    section_id: string | null;
}

/** Ciò che l'audit conserva della riga: metadati dell'appello, mai testo libero. */
function fotografia(r: RigaDecisione) {
    return {
        stato: r.stato,
        orario_entrata: r.orario_entrata,
        orario_uscita: r.orario_uscita,
        registrato_da: r.registrato_da,
        comunicazione_genitore: r.giustificata_da !== null,
    };
}

export async function annullaAppelloAlunno(
    supabase: SupabaseClient,
    input: AnnullaAppelloInput,
): Promise<EsitoAnnullaAppello> {
    const operazione = input.operazione ?? 'presenze/annulla-appello';
    const { alunnoId, data, attore } = input;

    let lettura = supabase
        .from('presenze')
        .select(COLONNE_DECISIONE)
        .eq('alunno_id', alunnoId)
        .eq('data', data);
    if (input.sectionId) lettura = lettura.eq('section_id', input.sectionId);
    const { data: letta, error: erroreLettura } = await lettura.maybeSingle();

    // «Non c'è» e «non l'ho potuta leggere» non sono la stessa cosa: PostgREST
    // non lancia, e senza questo ramo un guasto uscirebbe come `non-trovata`.
    if (erroreLettura) {
        logErrore({ operazione, stato: 500, evento: 'db' }, erroreLettura);
        return { esito: 'errore', fase: 'lettura' };
    }
    if (!letta) return { esito: 'non-trovata' };

    const riga = letta as unknown as RigaDecisione;
    if (riga.registrato_da === null || riga.registrato_da === undefined) {
        return { esito: 'niente-da-annullare' };
    }

    const conComunicazione = riga.giustificata_da !== null && riga.giustificata_da !== undefined;

    let presenza: PresenzaEsito | null = null;
    if (conComunicazione) {
        // L'update NON nomina i campi della comunicazione del genitore: una
        // `.update()` non può azzerare la colonna che non nomina.
        const ripristino = {
            stato: 'assente',
            registrato_da: null,
            orario_entrata: null,
            orario_uscita: null,
            note_appello: null,
            aggiornato_il: new Date().toISOString(),
        };
        const { data: scritte, error } = await supabase
            .from('presenze')
            .update(ripristino)
            .eq('id', riga.id)
            // La sede viene dalla riga appena LETTA, non dalla richiesta.
            .eq('scuola_id', riga.scuola_id)
            // La condizione che ha scelto questo ramo, ripetuta nella scrittura.
            .not('registrato_da', 'is', null)
            .select(COLONNE_PRESENZA_ESITO);
        if (error) {
            logErrore({ operazione, stato: 500, evento: 'db' }, error);
            return { esito: 'errore', fase: 'scrittura' };
        }
        const prima = ((scritte ?? []) as unknown as PresenzaEsito[])[0];
        if (!prima) return cambiataNelFrattempo(operazione, riga);
        presenza = prima;
    } else {
        const { data: cancellate, error } = await supabase
            .from('presenze')
            .delete()
            .eq('id', riga.id)
            .eq('scuola_id', riga.scuola_id)
            // Mai cancellare una comunicazione del genitore arrivata dopo la lettura.
            .is('giustificata_da', null)
            .not('registrato_da', 'is', null)
            .select('id');
        if (error) {
            logErrore({ operazione, stato: 500, evento: 'db' }, error);
            return { esito: 'errore', fase: 'scrittura' };
        }
        if (((cancellate ?? []) as unknown[]).length === 0) return cambiataNelFrattempo(operazione, riga);
    }

    // La revoca viene DOPO la scrittura riuscita: ritirare l'avviso e poi non
    // riuscire ad annullare lascerebbe un'assenza registrata senza avviso.
    const { error: revocaErr } = await supabase
        .from('notifiche')
        .delete()
        .eq('tipo', 'assenza_non_comunicata')
        .eq('entita_id', alunnoId)
        .is('push_inviata_il', null);
    if (revocaErr) {
        // `error` benché l'annullamento sia riuscito: l'avviso resta in coda e
        // partirà per un appello che non esiste più.
        logEvento('notifica', 'error', {
            operazione,
            esito: 'revoca-assenza-fallita',
            tipo: 'assenza_non_comunicata',
            alunno_id: alunnoId,
        }, revocaErr);
    }

    await logScrittura(supabase, {
        attore,
        entitaTipo: 'presenze',
        entitaId: riga.id,
        azione: conComunicazione ? 'update' : 'delete',
        scuolaId: riga.scuola_id,
        sectionId: riga.section_id,
        valorePrima: fotografia(riga),
        valoreDopo: conComunicazione
            ? {
                stato: 'assente',
                orario_entrata: null,
                orario_uscita: null,
                registrato_da: null,
                comunicazione_genitore: true,
            }
            : null,
    });

    const esito = conComunicazione ? 'ripristinata-comunicazione' : 'cancellata';

    // Il SUCCESSO si logga: annullare un appello è una rettifica del registro.
    // Solo uuid ed enumerati; `distingui` perché `app_log` deduplica per impronta.
    logEvento('registro', 'info', {
        operazione,
        esito: 'appello-annullato',
        tipo: esito,
        alunno_id: alunnoId,
        presenza_id: riga.id,
        attore_id: attore.id,
        avviso_ritirato: !revocaErr,
    }, undefined, { distingui: ['alunno_id'] });

    return conComunicazione
        ? {
            esito: 'ripristinata-comunicazione',
            presenza: presenza as PresenzaEsito,
            presenzaId: riga.id,
            scuolaId: riga.scuola_id,
            avvisoRitirato: !revocaErr,
        }
        : { esito: 'cancellata', presenza: null, presenzaId: riga.id, scuolaId: riga.scuola_id, avvisoRitirato: !revocaErr };
}

function cambiataNelFrattempo(operazione: string, riga: RigaDecisione): EsitoAnnullaAppello {
    // Nessuna riga toccata: la condizione letta non reggeva più al momento della
    // scrittura (il genitore ha comunicato, o un altro annullamento è passato).
    logEvento('registro', 'warn', {
        operazione,
        esito: 'annullamento-appello-conteso',
        alunno_id: riga.alunno_id,
        presenza_id: riga.id,
    });
    return { esito: 'cambiata-nel-frattempo' };
}
