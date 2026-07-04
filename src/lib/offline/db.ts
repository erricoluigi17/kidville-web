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

// Primaria — appello giornaliero offline (coda di scrittura verso /api/primaria/appello)
export interface LocalPrimariaAppello {
    id: string; // `${alunno_id}|${data}`
    section_id: string;
    alunno_id: string;
    data: string; // YYYY-MM-DD
    stato: 'presente' | 'assente' | 'ritardo' | 'uscita_anticipata';
    sync_status: 'synced' | 'pending' | 'error';
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
    tipo_compresenza: string;
    sync_status: 'synced' | 'pending' | 'error';
    creato_il: string;
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

export { db };

