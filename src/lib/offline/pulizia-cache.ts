import { db } from './db';
import { logClient } from '@/lib/logging/client';

/**
 * Scadenza e pulizia della cache di LETTURA offline (`cache_read`).
 *
 * La cache si popolava e non si svuotava mai: sopravviveva al logout e
 * all'oblio GDPR. Le chiavi generate sono per giorno o per settimana
 * (`diario:<alunno>:<gg>`, `menu:<alunno>:<from>:<to>`), quindi senza scadenza
 * crescono all'infinito — una voce nuova al giorno per ogni figlio, per sempre,
 * con dentro il diario e i pasti di un bambino.
 *
 * L'indice `aggiornato_il` esisteva già dalla `version(11)` di `db.ts` ed era
 * dichiarato «per pulizia per età»: qui viene finalmente usato. I valori sono
 * `new Date().toISOString()`, cioè UTC a larghezza fissa, quindi l'ordine
 * alfabetico coincide con quello cronologico e l'indice si interroga per range
 * invece di filtrare in memoria.
 *
 * LIMITE DA CONOSCERE: l'oblio GDPR (`src/lib/gdpr/esegui.ts`) gira sul SERVER
 * e non ha alcun modo di raggiungere l'IndexedDB di un telefono. La
 * cancellazione lato dispositivo è coperta da tre presidi diversi: il logout
 * (l'intenzione esplicita di lasciare il dispositivo), il TTL (un limite
 * superiore su qualunque dato in cache anche senza logout), e il fatto che dopo
 * l'oblio la sessione non è più valida.
 */

/**
 * 7 giorni: la settimana scolastica. Copre «sono stato senza rete nel fine
 * settimana», corrisponde alla vita utile di un menu (settimanale) e come
 * minimizzazione GDPR è un periodo breve e difendibile.
 */
export const TTL_CACHE_READ_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Tetto di cardinalità: seconda rete per l'app lasciata aperta a lungo o per un
 * dispositivo con l'orologio sballato, dove il solo TTL non basterebbe.
 */
export const MAX_VOCI_CACHE_READ = 200;

/**
 * Cancella le voci scadute e, se restano troppe, le più vecchie oltre il tetto.
 * Ritorna quante ne ha rimosse. Non lancia mai: è manutenzione, non prodotto.
 */
export async function pulisciCacheScaduta(ora?: Date): Promise<number> {
    try {
        const adesso = (ora ?? new Date()).getTime();
        const soglia = new Date(adesso - TTL_CACHE_READ_MS).toISOString();
        // Range sull'INDICE (non un filter in memoria): con qualche migliaio di
        // voci la differenza fra i due è un blocco visibile della UI.
        let rimosse = await db.cache_read.where('aggiornato_il').below(soglia).delete();

        const restanti = await db.cache_read.count();
        if (restanti > MAX_VOCI_CACHE_READ) {
            const daTogliere = restanti - MAX_VOCI_CACHE_READ;
            const chiavi = await db.cache_read
                .orderBy('aggiornato_il')
                .limit(daTogliere)
                .primaryKeys();
            await db.cache_read.bulkDelete(chiavi);
            rimosse += chiavi.length;
        }
        return rimosse;
    } catch {
        // IndexedDB non disponibile (modalità privata, quota, storage disabilitato).
        // Si logga a `warn` e non si ignora in silenzio: se la pulizia non gira,
        // dei dati di minori restano sul dispositivo oltre il TTL dichiarato
        // nell'informativa, e nessuno lo saprebbe. Nessun dato nel messaggio.
        logClient({ livello: 'warn', evento: 'offline', messaggio: 'pulizia-cache-fallita' });
        return 0;
    }
}

/**
 * Svuota INTERAMENTE la cache di lettura. Si chiama al logout.
 *
 * Svuota SOLO `cache_read`. Gli altri store Dexie (`presenze`, `diario`,
 * `armadietto`, `galleria`, `primaria_*`) contengono SCRITTURE non ancora
 * sincronizzate (`sync_status: 'pending'`): cancellarle al logout butterebbe
 * via il lavoro offline di una docente. `cache_read` è invece pura cache di
 * lettura, ricostruibile con una fetch.
 */
export async function svuotaCacheLocale(): Promise<void> {
    try {
        await db.cache_read.clear();
    } catch {
        logClient({ livello: 'warn', evento: 'offline', messaggio: 'svuotamento-cache-fallito' });
    }
}
