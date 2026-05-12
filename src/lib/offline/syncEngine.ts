import { db, LocalAttendanceLog, LocalDiaryEntry } from './db';
import { createBrowserClient } from '@supabase/ssr';

function getSupabaseClient() {
    return createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
}

export async function syncPendingLogs() {
    if (typeof window !== 'undefined' && !navigator.onLine) {
        console.log('Sync abortito: Dispositivo Offline');
        return;
    }

    try {
        const supabase = getSupabaseClient();
        
        const pendingLogs = await db.presenze
            .where('sync_status')
            .anyOf('pending', 'error')
            .toArray();

        if (pendingLogs.length === 0) return;

        console.log(`Trovati ${pendingLogs.length} record da sincronizzare...`);

        const payload = pendingLogs.map(log => ({
            id: log.id,
            alunno_id: log.alunno_id,
            data: log.data,
            orario_entrata: log.orario_entrata,
            orario_uscita: log.orario_uscita,
            stato: log.stato,
            panic_alert: log.panic_alert,
            sync_status: 'synced',
            aggiornato_il: log.aggiornato_il
        }));

        const { error } = await supabase
            .from('presenze')
            .upsert(payload, { onConflict: 'id' });

        if (error) throw new Error(`Errore upsert: ${error.message}`);

        const updatedIds = pendingLogs.map(log => log.id);
        await db.presenze.bulkUpdate(
            updatedIds.map(id => ({ key: id, changes: { sync_status: 'synced' } }))
        );

        console.log('Sincronizzazione completata con successo!');
    } catch (error) {
        console.error('Errore nel motore di sincronizzazione:', error);
    }
}

export async function saveLocalAttendanceLog(logData: Omit<LocalAttendanceLog, 'sync_status'>) {
    try {
        const fullLog: LocalAttendanceLog = { ...logData, sync_status: 'pending' };
        await db.presenze.put(fullLog);
        
        if (typeof window !== 'undefined' && navigator.onLine) {
            syncPendingLogs();
        }
    } catch (error) {
        console.error('Errore nel salvataggio locale:', error);
        throw error;
    }
}

// ============================================================
// Diario 0-6 — Fase 2.1
// ============================================================

export async function saveLocalDiaryEntry(entryData: Omit<LocalDiaryEntry, 'sync_status'>) {
    try {
        const fullEntry: LocalDiaryEntry = { ...entryData, sync_status: 'pending' };
        await db.diario.put(fullEntry);

        if (typeof window !== 'undefined' && navigator.onLine) {
            syncPendingDiaryEntries();
        }
    } catch (error) {
        console.error('Errore nel salvataggio locale del diario:', error);
        throw error;
    }
}

export async function syncPendingDiaryEntries() {
    if (typeof window !== 'undefined' && !navigator.onLine) {
        console.log('Sync diario abortito: Dispositivo Offline');
        return;
    }

    try {
        const supabase = getSupabaseClient();

        const pending = await db.diario
            .where('sync_status')
            .anyOf('pending', 'error')
            .toArray();

        if (pending.length === 0) return;

        console.log(`Diario: ${pending.length} record da sincronizzare...`);

        const payload = pending.map(entry => ({
            id: entry.id,
            alunno_id: entry.alunno_id,
            classe_id: entry.classe_id,
            tipo_evento: entry.tipo_evento,
            timestamp_evento: entry.timestamp_evento,
            note: entry.note,
            dettagli: entry.dettagli,
            activity_description: entry.activity_description,
            creato_il: entry.creato_il,
        }));

        const { error } = await supabase
            .from('daily_routines')
            .upsert(payload, { onConflict: 'id' });

        if (error) throw new Error(`Errore upsert diario: ${error.message}`);

        const ids = pending.map(e => e.id);
        await db.diario.bulkUpdate(
            ids.map(id => ({ key: id, changes: { sync_status: 'synced' } }))
        );

        console.log('Sincronizzazione diario completata!');
    } catch (error) {
        console.error('Errore sync diario:', error);
    }
}

// ============================================================
// Armadietto — Fase 2.2
// ============================================================

export async function syncLockerInventory(classeSezione: string) {
    if (typeof window !== 'undefined' && !navigator.onLine) {
        console.log('Sync armadietto abortito: Dispositivo Offline');
        return;
    }

    try {
        const res = await fetch(`/api/locker/inventory?classe_sezione=${classeSezione}`);
        const data = await res.json();

        if (!Array.isArray(data)) return;

        // Salva in cache locale con schema v8
        for (const alunno of data) {
            if (!alunno.inventario) continue;
            for (const item of alunno.inventario) {
                await db.armadietto.put({
                    id: item.id ?? `${alunno.id}-${item.materiale}-${item.date ?? ''}`,
                    alunno_id: item.alunno_id ?? alunno.id,
                    materiale: item.materiale ?? 'Generico',
                    quantita: item.quantita ?? 0,
                    date: item.date ?? new Date().toISOString().slice(0, 10),
                    portato: item.portato ?? true,
                    sync_status: 'synced',
                    aggiornato_il: item.aggiornato_il ?? new Date().toISOString(),
                });
            }
        }

        console.log('Cache armadietto aggiornata!');
    } catch (error) {
        console.error('Errore sync armadietto:', error);
    }
}

// ============================================================
// Anagrafica Offline Fetching
// ============================================================

export async function getLocalStudentDetails(studentId: string) {
    try {
        const delegates = await db.delegati.where('alunno_id').equals(studentId).toArray();
        
        // Nuova architettura: cerchiamo in "adulti" (in app offline non abbiamo la join pivot in db.ts completa, 
        // ma possiamo espanderla. Per ora usiamo un fallback per non rompere app vecchie)
        const adults = await db.adulti.toArray();
        const parents = await db.genitori.toArray(); 
        
        return {
            delegates: delegates.map(d => ({
                id: d.id,
                first_name: d.nome,
                last_name: '',
                gender: '',
            })),
            student_parents: [],
            adults: adults // nuova proprietà
        };
    } catch (error) {
        console.error('Errore fetch locale anagrafica:', error);
        return { delegates: [], student_parents: [], adults: [] };
    }
}

// ============================================================
// Sync Adulti (Fase 6)
// ============================================================

export async function syncAdults() {
    if (typeof window !== 'undefined' && !navigator.onLine) return;

    try {
        const supabase = getSupabaseClient();
        // Grazie alle RLS, l'educatore riceverà solo gli adulti pertinenti alle proprie sezioni
        const { data, error } = await supabase.from('adults').select('*');
        if (error) throw error;

        if (data && data.length > 0) {
            await db.adulti.clear(); // Sostituzione completa cache locale
            await db.adulti.bulkAdd(data);
            console.log(`Cache adulti aggiornata: ${data.length} record offline.`);
        }
    } catch (error) {
        console.error('Errore sync adulti:', error);
    }
}

