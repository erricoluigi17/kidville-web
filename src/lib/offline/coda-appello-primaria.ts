import { db, type LocalPrimariaAppello } from '@/lib/offline/db';
import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * ─── IL CORPO DELLA POST CHE LA CODA RISPEDISCE ───────────────────────────────────
 *
 * Prima il flush (`syncPendingAppello`) mandava `{ sectionId, data, alunnoId, stato }` e
 * basta: l'ora di un ritardo segnato senza campo si perdeva. Col contratto A3 il danno è
 * più grave, perché una POST che NON nomina `assenzaOrariaGiustificata` la SPEGNE: un
 * ritardo giustificato (es. terapia) salvato offline sarebbe arrivato come un ritardo che
 * conta nelle ore di assenza.
 *
 * Ogni campo facoltativo entra nel corpo SOLO se la riga in coda lo porta. Una riga
 * accodata prima di questa modifica produce il corpo di sempre: `orarioEntrata: null`
 * cancellerebbe l'ora sul server, `noteAppello: null` la nota. `null` sulla nota invece
 * si trasporta com'è: è il comando «togli la nota» dato nella finestra.
 */
export function corpoPostAppelloDaCoda(r: LocalPrimariaAppello): Record<string, unknown> {
    const corpo: Record<string, unknown> = {
        sectionId: r.section_id,
        data: r.data,
        alunnoId: r.alunno_id,
        stato: r.stato,
    };
    if (r.orario_entrata !== undefined) corpo.orarioEntrata = r.orario_entrata;
    if (r.orario_uscita !== undefined) corpo.orarioUscita = r.orario_uscita;
    if (r.note_appello !== undefined) corpo.noteAppello = r.note_appello;
    if (r.assenza_oraria_giustificata !== undefined) corpo.assenzaOrariaGiustificata = r.assenza_oraria_giustificata;
    return corpo;
}

/**
 * ─── RITIRA DALLA CODA OFFLINE IL CAMBIO D'APPELLO IN ATTESA DI UN ALUNNO ─────────
 *
 * Serve all'«Annulla» dell'appello della primaria (spec 2026-09-24, punto 6), e
 * va chiamata PRIMA della `DELETE /api/primaria/appello`.
 *
 * PERCHÉ. La coda `primaria_appello` (vedi `saveLocalAppello`/`syncPendingAppello`
 * in `syncEngine.ts`) conserva, per `alunno|data`, l'ultimo stato segnato quando
 * la rete mancava o la POST era fallita, e lo RISPEDISCE come POST al primo evento
 * `online` o al prossimo salvataggio. Se l'annullamento lasciasse lì quella riga,
 * il bambino tornerebbe «da registrare» sul server e un attimo dopo la coda
 * riscriverebbe l'appello appena annullato — in silenzio, con lo stato vecchio e
 * con `registrato_da` di chi aveva annullato. Annullare vuol dire annullare anche
 * ciò che deve ancora partire.
 *
 * COSA SI TOGLIE. Solo le righe `pending` ed `error`, cioè quelle che il flush
 * ripesca (`.anyOf('pending','error')`). `synced` è già sul server (lo annulla la
 * DELETE) e `scartato` non riparte mai più: resta com'è, come traccia locale.
 *
 * LA RIGA RITIRATA SI RESTITUISCE: se poi la DELETE fallisce (500, rete caduta,
 * «solo oggi» a cavallo della mezzanotte) il chiamante la rimette in coda con
 * `rimettiCambioAppelloInCoda`. Altrimenti lo stato a schermo — quello segnato e
 * non ancora spedito — non sarebbe più né sul server né in coda: una schermata che
 * finge uno stato che non esiste da nessuna parte.
 *
 * Il limite, detto invece che taciuto: una POST della coda GIÀ IN VOLO nel momento
 * in cui si annulla non si può richiamare. È la stessa finestra di qualunque
 * scrittura concorrente, e il docente vede l'esito ricaricando.
 *
 * NON LANCIA MAI verso l'interfaccia: restituisce l'esito, e il chiamante decide.
 * `'illeggibile'` vuol dire che IndexedDB non ha risposto (navigazione privata,
 * dati del sito bloccati): in quel caso lo stesso store è illeggibile anche per il
 * flush, che quindi non ha niente da rispedire — per questo l'annullamento può
 * proseguire lo stesso, e il guasto si registra qui.
 */
export type EsitoRitiroCoda =
    | { esito: 'ritirato'; riga: LocalPrimariaAppello }
    | { esito: 'niente-in-coda' }
    | { esito: 'illeggibile' };

export async function ritiraCambioAppelloInCoda(alunnoId: string, data: string): Promise<EsitoRitiroCoda> {
    // La chiave è la stessa che scrive la pagina dell'appello: `${alunno_id}|${data}`.
    const id = `${alunnoId}|${data}`;
    try {
        const riga = await db.primaria_appello.get(id);
        if (!riga || (riga.sync_status !== 'pending' && riga.sync_status !== 'error')) return { esito: 'niente-in-coda' };
        await db.primaria_appello.delete(id);
        return { esito: 'ritirato', riga };
    } catch (err) {
        // `warn` e non `error`: niente è perso — lo store che non si legge qui è lo
        // stesso che il flush non riesce a leggere. Del guasto esce solo il NOME
        // della classe d'errore; alunno e data non entrano nei log.
        logClient({
            livello: 'warn',
            evento: 'offline',
            messaggio: `appello-primaria-coda-non-letta-prima-di-annullare: ${nomeErrore(err)}`,
        });
        return { esito: 'illeggibile' };
    }
}

/**
 * Rimette in coda il cambio ritirato da `ritiraCambioAppelloInCoda` quando
 * l'annullamento NON è andato a buon fine: il cambio torna a essere spedito dal
 * flush, come se l'annullamento non fosse mai stato tentato.
 *
 * Non sovrascrive un cambio più recente: se nel frattempo per quell'alunno e quel
 * giorno è entrata in coda un'altra riga, vince quella (è l'ultima cosa che il
 * docente ha segnato).
 *
 * Non lancia. Se IndexedDB non accetta la scrittura il cambio è PERSO — lo stato a
 * schermo non è più né sul server né in coda — e questo è un `error`, non un `warn`.
 * Solo il nome dell'errore entra nel log: alunno, data e stato no.
 */
export async function rimettiCambioAppelloInCoda(riga: LocalPrimariaAppello): Promise<boolean> {
    try {
        const attuale = await db.primaria_appello.get(riga.id);
        if (attuale && (attuale.sync_status === 'pending' || attuale.sync_status === 'error')) return true;
        await db.primaria_appello.put(riga);
        return true;
    } catch (err) {
        logClient({
            livello: 'error',
            evento: 'offline',
            messaggio: `appello-primaria-cambio-non-rimesso-in-coda: ${nomeErrore(err)}`,
        });
        return false;
    }
}
