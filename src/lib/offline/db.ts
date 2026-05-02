import Dexie, { type EntityTable } from 'dexie';

export type DiaryEventType =
    | 'entrata'
    | 'attivita'
    | 'merenda'
    | 'pranzo'
    | 'nanna_inizio'
    | 'nanna_fine'
    | 'bagno';

export interface LocalDiaryEntry {
    id: string; // UUID client-side
    alunno_id: string;
    classe_id: string;
    tipo_evento: DiaryEventType;
    timestamp_evento: string; // ISO String
    note: string | null;
    dettagli: Record<string, unknown> | null; // es. { quantita: 'meta' }
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
    catalogo_id: string;
    nome_materiale: string;
    icona: string;
    quantita: number;
    soglia_gialla: number;
    soglia_rossa: number;
    sync_status: 'synced' | 'pending' | 'error';
    aggiornato_il: string;
}

const db = new Dexie('KidvilleOfflineDB') as Dexie & {
    presenze: EntityTable<LocalAttendanceLog, 'id'>;
    delegati: EntityTable<LocalDelegate, 'id'>;
    diario: EntityTable<LocalDiaryEntry, 'id'>;
    armadietto: EntityTable<LocalLockerItem, 'id'>;
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

export { db };
