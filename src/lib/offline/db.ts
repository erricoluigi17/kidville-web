import Dexie, { type EntityTable } from 'dexie';

export type DiaryEventType =
    | 'attivita'
    | 'merenda'
    | 'pranzo'
    | 'nanna_inizio'
    | 'nanna_fine'
    | 'bagno'
    | 'umore';

/** Include 'entrata' per compatibilità con dati storici */
export type DiaryEventTypeLegacy = DiaryEventType | 'entrata';

export interface LocalDiaryEntry {
    id: string; // UUID client-side
    alunno_id: string;
    classe_id: string;
    tipo_evento: DiaryEventTypeLegacy;
    timestamp_evento: string; // ISO String
    note: string | null;
    dettagli: Record<string, unknown> | null; // es. { quantita: 'meta' }
    activity_description: string | null; // Testo libero attività
    sync_status: 'synced' | 'pending' | 'error';
    creato_il: string;
}

export interface LocalAttendanceLog {
    id: string; // UUID from client
    alunno_id: string;
    data: string; // YYYY-MM-DD
    orario_entrata: string | null; // ISO String
    orario_uscita: string | null; // ISO String
    stato: 'presente' | 'assente' | 'ritardo' | 'uscita_anticipata';
    panic_alert: boolean;
    sync_status: 'synced' | 'pending' | 'error';
    aggiornato_il: string;
}

export interface LocalDelegate {
    id: string;
    alunno_id: string;
    nome: string;
    relazione: string;
    foto_url: string | null;
}

export interface LocalLockerItem {
    id: string; // inventory row UUID
    alunno_id: string;
    materiale: string;   // nome materiale (es. 'Pannolini', 'Crema')
    quantita: number;
    date: string;        // YYYY-MM-DD — giorno di riferimento
    portato: boolean;    // true = portato, false = non portato
    sync_status: 'synced' | 'pending' | 'error';
    aggiornato_il: string;
}

export interface LocalParent {
    id: string;
    nome: string;
    cognome: string;
    email: string | null;
    sync_status: 'synced' | 'pending' | 'error';
    aggiornato_il: string;
}

export interface LocalStudentDocument {
    id: string;
    alunno_id: string;
    tipo_documento: string;
    file_url: string;
    data_scadenza: string | null;
    sync_status: 'synced' | 'pending' | 'error';
}

export interface LocalGalleryMedia {
    id: string;
    uploaded_by: string;
    caption: string | null;
    tag_students: string[];
    is_broadcast: boolean;
    target_classes: string[] | null;
    file_type: 'foto' | 'video';
    file_blob: Blob;
    file_name: string;
    sync_status: 'synced' | 'pending' | 'error';
    creato_il: string;
}

/**
 * GLI STATI DI UNA RIGA IN CODA VERSO LE API DELLA PRIMARIA — e perché sono QUATTRO.
 *
 * `pending` ed `error` sono entrambi RIPESCABILI: `syncPending*` li rilegge insieme con
 * `.anyOf('pending', 'error')`. Finché il vocabolario si fermava a quei tre, una riga che il
 * server rifiuta *per sempre* — un 400 di validazione, il 409 «esiste già una firma
 * principale», un 422 a cui manca un campo che la coda non sa produrre — tornava `error` e
 * veniva rispedita a OGNI riconnessione, a ogni salvataggio successivo, a ogni ingresso in
 * pagina. Per sempre, e senza che il docente vedesse mai niente: la firma non c'era, l'app non
 * lo diceva.
 *
 * `scartato` è il quarto stato, ed è quello che NON si ripesca: la consegna è finita, male.
 * Fa due cose in una — ferma la tempesta di ritentativi, e LASCIA LA RIGA sul dispositivo,
 * perché l'interfaccia possa dire «questa firma non è stata salvata». Cancellarla sarebbe
 * stato più semplice, e sarebbe stata la stessa perdita silenziosa di prima con un passaggio
 * in meno.
 *
 * 🔴 QUANTO COSTA SBAGLIARE DALLA PARTE DELLO SCARTO, ed è la metà che è stata sbagliata per
 * prima. `scartato` è IRREVERSIBILE e oggi è INVISIBILE: nessun componente in `src/` apre
 * questi due store, quindi nessuna interfaccia può dire «questa firma non è stata salvata»
 * — la promessa del paragrafo qui sopra è una promessa, non ancora un fatto (vedi la
 * dipendenza aperta verso il lotto UI). Finché lo è, ogni riga che finisce qui è una perdita
 * muta, e il ritentativo — che era rumoroso — era il male minore.
 *
 * Per questo `syncEngine.ts` ci porta SOLO i rifiuti in cui è il CORPO a essere sbagliato
 * (`DEFINITIVI`), più quelli che hanno esaurito `MAX_TENTATIVI_CONSEGNA`. Un 423 (registro
 * chiuso: lo sblocca il dirigente), un 401 (sessione scaduta: rientra il docente) e un 403
 * (grado non abilitato: lo abilita un amministratore) NON ci arrivano mai: sono «no» che una
 * persona toglie di mezzo, e la coda deve essere ancora lì quando lo fa.
 *
 * NON è un indice nuovo e NON richiede una versione Dexie nuova: `sync_status` è già
 * indicizzato (v10) e un indice IndexedDB non dichiara i valori ammessi, li osserva.
 */
export type StatoCodaPrimaria = 'synced' | 'pending' | 'error' | 'scartato';

// Primaria — appello giornaliero offline (coda di scrittura verso /api/primaria/appello)
export interface LocalPrimariaAppello {
    id: string; // `${alunno_id}|${data}`
    section_id: string;
    alunno_id: string;
    data: string; // YYYY-MM-DD
    stato: 'presente' | 'assente' | 'ritardo' | 'uscita_anticipata';
    sync_status: StatoCodaPrimaria;
    /** Vedi `LocalPrimariaRegistro.tentativi`: stessa contabilità, stessa politica. */
    tentativi: number;
    aggiornato_il: string;
}

// Primaria — firma/lezione del registro offline (coda verso /api/primaria/registro)
export interface LocalPrimariaRegistro {
    id: string; // UUID client-side
    section_id: string;
    data: string; // YYYY-MM-DD
    ora_lezione: number;
    materia_id: string | null;
    argomento: string | null;
    compiti: string | null;
    /**
     * La scadenza dei compiti — il «chip» che il genitore vede in `/parent/compiti`.
     *
     * NON C'ERA, e la sua assenza non produceva nessun errore: la modale del registro la fa
     * digitare, il ramo online la spedisce (`dataConsegnaCompiti`), il ramo OFFLINE la
     * lasciava fuori dall'oggetto messo in coda. `saveLocalRegistro` accetta
     * `Omit<LocalPrimariaRegistro, …>`: un campo che il tipo non dichiara non è un campo
     * dimenticato, è un campo che non esiste — e TypeScript non ha niente da ridire. Il
     * docente vedeva «salvato», e la data spariva fra il telefono e il server.
     *
     * Misurato in produzione il 2026-09-09: su 14 righe di `registro_orario`, **13** hanno
     * `data_consegna_compiti` valorizzata. Non è un campo di riserva: è quello che i docenti
     * compilano quasi sempre.
     *
     * È OBBLIGATORIO di proposito. Facoltativo (`?`) avrebbe lasciato il difetto identico a
     * com'era — dimenticabile in silenzio dal prossimo chiamante — e questo è esattamente il
     * modo in cui è nato.
     */
    data_consegna_compiti: string | null;
    tipo_compresenza: string;
    sync_status: StatoCodaPrimaria;
    /**
     * Quante volte il SERVER ha risposto «no» a questa riga.
     *
     * NON conta i tentativi in cui la rete è caduta prima che una risposta arrivasse: quelli
     * non dicono niente sulla riga, e bruciarli in una galleria della metropolitana
     * vorrebbe dire buttare via la firma di un docente che aveva solo perso campo. Conta solo
     * i «no» detti dal server, ed è ciò che rende finito anche il ritentativo di un guasto
     * che sembra temporaneo ma temporaneo non è (il 500 di un CHECK violato risponde 500 oggi,
     * domani e fra un mese). Il tetto è `MAX_TENTATIVI_CONSEGNA` in `syncEngine.ts`.
     *
     * E non conta nemmeno i «no» che sappiamo LEGGERE: 401, 403 e 423 lasciano il contatore
     * fermo (`RIMEDIABILI` in `syncEngine.ts`). Aspettare che il dirigente sblocchi non è
     * scommettere che il server guarisca da solo, e sei riconnessioni in un minuto non devono
     * bruciare un'attesa che si misura in ore.
     *
     * Lo scrive la CODA, non il chiamante: `saveLocalRegistro` lo esclude dal proprio
     * argomento e lo mette a 0. Le righe accodate da build precedenti non ce l'hanno affatto,
     * e al punto di lettura si leggono come 0 — vedi il commento su quel `??`.
     */
    tentativi: number;
    creato_il: string;
}

// Cache di LETTURA generica (v11) — snapshot dell'ultima risposta di rete per una
// certa chiave, così il genitore può rivedere avvisi/diario/menu anche offline.
// NON è una coda di scrittura (quella resta negli store per-dominio + syncEngine):
// qui si conserva solo l'ultimo payload JSON per servirlo in fallback. `payload`
// è opaco (unknown): chi legge sa quale forma attendersi dalla propria chiave.
export interface CachedRead {
    chiave: string;       // es. `avvisi:{userId}` — stabile per-alunno/finestra
    payload: unknown;     // ultimo body JSON ricevuto (opaco)
    aggiornato_il: string; // ISO — quando è stato messo in cache
}

const db = new Dexie('KidvilleOfflineDB') as Dexie & {
    presenze: EntityTable<LocalAttendanceLog, 'id'>;
    delegati: EntityTable<LocalDelegate, 'id'>;
    diario: EntityTable<LocalDiaryEntry, 'id'>;
    armadietto: EntityTable<LocalLockerItem, 'id'>;
    genitori: EntityTable<LocalParent, 'id'>;
    documenti_alunni: EntityTable<LocalStudentDocument, 'id'>;
    adulti: EntityTable<{ id: string } & Record<string, unknown>, 'id'>; // Anagrafica adulti estesa (Fase 6)
    galleria: EntityTable<LocalGalleryMedia, 'id'>; // Galleria multimediale (Fase 3)
    primaria_appello: EntityTable<LocalPrimariaAppello, 'id'>; // Appello primaria (Fase 1)
    primaria_registro: EntityTable<LocalPrimariaRegistro, 'id'>; // Registro primaria (Fase 1)
    cache_read: EntityTable<CachedRead, 'chiave'>; // Cache di lettura offline (v11)
};

// v2: schema presenze + delegati (Fase 1)
db.version(2).stores({
    presenze: 'id, alunno_id, data, sync_status',
    delegati: 'id, alunno_id'
});

// v3: aggiunta store diario (Fase 2.1)
db.version(3).stores({
    presenze: 'id, alunno_id, data, sync_status',
    delegati: 'id, alunno_id',
    diario: 'id, alunno_id, classe_id, tipo_evento, timestamp_evento, sync_status'
});

// v4: aggiunta store armadietto (Fase 2.2)
db.version(4).stores({
    presenze: 'id, alunno_id, data, sync_status',
    delegati: 'id, alunno_id',
    diario: 'id, alunno_id, classe_id, tipo_evento, timestamp_evento, sync_status',
    armadietto: 'id, alunno_id, catalogo_id, sync_status'
});

// v5: aggiunta anagrafica estesa
db.version(5).stores({
    presenze: 'id, alunno_id, data, sync_status',
    delegati: 'id, alunno_id',
    diario: 'id, alunno_id, classe_id, tipo_evento, timestamp_evento, sync_status',
    armadietto: 'id, alunno_id, catalogo_id, sync_status',
    genitori: 'id, sync_status',
    documenti_alunni: 'id, alunno_id, tipo_documento, sync_status'
});

// v6: aggiunta adulti per refactoring Anagrafica
db.version(6).stores({
    presenze: 'id, alunno_id, data, sync_status',
    delegati: 'id, alunno_id',
    diario: 'id, alunno_id, classe_id, tipo_evento, timestamp_evento, sync_status',
    armadietto: 'id, alunno_id, catalogo_id, sync_status',
    genitori: 'id, sync_status',
    documenti_alunni: 'id, alunno_id, tipo_documento, sync_status',
    adulti: 'id, role'
});

// v7: aggiunta campo activity_description al diario (non indicizzato, solo schema interface)
db.version(7).stores({
    presenze: 'id, alunno_id, data, sync_status',
    delegati: 'id, alunno_id',
    diario: 'id, alunno_id, classe_id, tipo_evento, timestamp_evento, sync_status',
    armadietto: 'id, alunno_id, catalogo_id, sync_status',
    genitori: 'id, sync_status',
    documenti_alunni: 'id, alunno_id, tipo_documento, sync_status',
    adulti: 'id, role'
});

// v8: armadietto refactor — aggiunta colonne materiale e date per tracking mensile
db.version(8).stores({
    presenze: 'id, alunno_id, data, sync_status',
    delegati: 'id, alunno_id',
    diario: 'id, alunno_id, classe_id, tipo_evento, timestamp_evento, sync_status',
    armadietto: 'id, alunno_id, materiale, date, sync_status',
    genitori: 'id, sync_status',
    documenti_alunni: 'id, alunno_id, tipo_documento, sync_status',
    adulti: 'id, role'
});

// v9: aggiunta galleria per caricamento foto/video offline
db.version(9).stores({
    presenze: 'id, alunno_id, data, sync_status',
    delegati: 'id, alunno_id',
    diario: 'id, alunno_id, classe_id, tipo_evento, timestamp_evento, sync_status',
    armadietto: 'id, alunno_id, materiale, date, sync_status',
    genitori: 'id, sync_status',
    documenti_alunni: 'id, alunno_id, tipo_documento, sync_status',
    adulti: 'id, role',
    galleria: 'id, uploaded_by, sync_status'
});

// v10: store primaria (appello + registro) per offline-first del registro primaria
db.version(10).stores({
    presenze: 'id, alunno_id, data, sync_status',
    delegati: 'id, alunno_id',
    diario: 'id, alunno_id, classe_id, tipo_evento, timestamp_evento, sync_status',
    armadietto: 'id, alunno_id, materiale, date, sync_status',
    genitori: 'id, sync_status',
    documenti_alunni: 'id, alunno_id, tipo_documento, sync_status',
    adulti: 'id, role',
    galleria: 'id, uploaded_by, sync_status',
    primaria_appello: 'id, section_id, alunno_id, data, sync_status',
    primaria_registro: 'id, section_id, data, sync_status'
});

// v11: cache di lettura generica (offline-first per avvisi/diario/menu genitore).
// Replica tutti gli store della v10 (Dexie migra in modo incrementale) e aggiunge
// cache_read, indicizzato per `chiave` (PK) e `aggiornato_il` (pulizia per età).
db.version(11).stores({
    presenze: 'id, alunno_id, data, sync_status',
    delegati: 'id, alunno_id',
    diario: 'id, alunno_id, classe_id, tipo_evento, timestamp_evento, sync_status',
    armadietto: 'id, alunno_id, materiale, date, sync_status',
    genitori: 'id, sync_status',
    documenti_alunni: 'id, alunno_id, tipo_documento, sync_status',
    adulti: 'id, role',
    galleria: 'id, uploaded_by, sync_status',
    primaria_appello: 'id, section_id, alunno_id, data, sync_status',
    primaria_registro: 'id, section_id, data, sync_status',
    cache_read: 'chiave, aggiornato_il'
});

/**
 * PERCHÉ `data_consegna_compiti`, `tentativi` E LO STATO `scartato` NON PORTANO UNA v12.
 *
 * Verificato leggendo Dexie 4.4.4, non dedotto. `Version.stores()` passa la stringa a
 * `parseIndexSyntax` (`dexie.mjs:3853`), che la spezza sulle virgole e ne ricava SOLO la
 * chiave primaria e gli indici; `createTable` (`dexie.mjs:3765`) chiama
 * `createObjectStore(nome, { keyPath })` e poi un `store.createIndex` per ciascun indice
 * dichiarato. Le altre proprietà non compaiono da nessuna parte: un object store IndexedDB
 * conserva l'oggetto INTERO per clonazione strutturata, e la dichiarazione descrive che cosa è
 * interrogabile, non che cosa è memorizzabile.
 *
 * Quindi: un campo NUOVO e NON indicizzato entra e si rilegge senza toccare la versione (una
 * v12 identica farebbe solo alzare il numero e riaprire il database a ogni utente). Un valore
 * nuovo su un campo GIÀ indicizzato — `sync_status: 'scartato'` — nemmeno: un indice
 * IndexedDB non ha un dominio dichiarato, indicizza il valore che trova.
 *
 * ⚠️ La v12 servirà il giorno in cui uno di questi campi dovrà essere INTERROGATO
 * (`where('tentativi')`): allora sì, e solo allora.
 */

export { db };

