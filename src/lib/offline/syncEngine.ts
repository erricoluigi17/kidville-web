import { db, LocalAttendanceLog, LocalDiaryEntry, LocalGalleryMedia, LocalPrimariaAppello, LocalPrimariaRegistro } from './db';
import { createBrowserClient } from '@supabase/ssr';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { logClient } from '@/lib/logging/client';

// Motore di sincronizzazione offline: gira NEL CLIENT, quindi dentro la WebView
// nativa. Per questo qui non c'è (e non deve tornare) nessun `console.*`: nella
// shell Capacitor la console della WebView finisce nei log di sistema del
// telefono, e gli errori PostgREST riecheggiano la riga che si stava scrivendo
// — `alunno_id`, `stato`, `panic_alert`, il nome file di una foto. Erano dati di
// minori a finire nel logcat, e nessun test lo vedeva.
//
// Al loro posto `logSync`, che manda alla pipeline ufficiale (redazione,
// deduplica, tabella `app_log`). Il messaggio è SEMPRE un codice statico: mai
// l'oggetto errore, mai un id, mai un nome file. `logClient` persiste per 30
// giorni ed è interrogabile in SQL, quindi un leak qui sarebbe peggiore di uno
// nel logcat, non migliore.
//
// Le vecchie `console.log` di avanzamento («Trovati N record…») sono state
// tolte e non sostituite: partivano a ogni riconnessione, non dicevano nulla
// che un errore non dica meglio, e sarebbero state un flusso continuo verso
// /api/logs.
function logSync(codice: string): void {
    logClient({ livello: 'error', evento: 'offline', messaggio: codice });
}

function getSupabaseClient() {
    return createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
}

export async function syncPendingLogs() {
    if (typeof window !== 'undefined' && !navigator.onLine) {
        return;
    }

    try {
        const supabase = getSupabaseClient();
        
        const pendingLogs = await db.presenze
            .where('sync_status')
            .anyOf('pending', 'error')
            .toArray();

        if (pendingLogs.length === 0) return;


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

    } catch {
        logSync('sync-presenze-fallito');
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
        logSync('salvataggio-locale-presenza-fallito');
        // Rilancia: il chiamante deve poter mostrare l'errore all'utente.
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
        logSync('salvataggio-locale-diario-fallito');
        // Rilancia: il chiamante deve poter mostrare l'errore all'utente.
        throw error;
    }
}

export async function syncPendingDiaryEntries() {
    if (typeof window !== 'undefined' && !navigator.onLine) {
        return;
    }

    try {
        const supabase = getSupabaseClient();

        const pending = await db.diario
            .where('sync_status')
            .anyOf('pending', 'error')
            .toArray();

        if (pending.length === 0) return;


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

    } catch {
        logSync('sync-diario-fallito');
    }
}

// ============================================================
// Armadietto — Fase 2.2
// ============================================================

export async function syncLockerInventory(classeSezione: string) {
    if (typeof window !== 'undefined' && !navigator.onLine) {
        return;
    }

    try {
        const userId = getCurrentTeacherId(null);
        if (!userId) return; // identità non risolta: niente refresh cache
        const res = await fetch(`/api/locker/inventory?classe_sezione=${classeSezione}&userId=${userId}`);
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

    } catch {
        logSync('sync-armadietto-fallito');
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
    } catch {
        logSync('lettura-locale-anagrafica-fallita');
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
        // Usa utenti come fonte per adulti (adults non è nel public schema)
        const { data, error } = await supabase
            .from('utenti')
            .select('id, first_name, last_name, nome, cognome, ruolo, email')
            .in('ruolo', ['maestra', 'educator', 'admin', 'coordinator', 'coordinatore']);
        if (error) throw error;

        if (data && data.length > 0) {
            await db.adulti.clear();
            await db.adulti.bulkAdd(data.map(u => ({
                ...u,
                first_name: u.first_name || u.nome || '',
                last_name: u.last_name || u.cognome || '',
                role: u.ruolo || 'educator',
            })));
        }
    } catch {
        logSync('sync-adulti-fallito');
    }
}

// ============================================================
// Galleria Foto e Video — Fase 3
// ============================================================

export async function saveLocalGalleryMedia(mediaData: Omit<LocalGalleryMedia, 'sync_status'>) {
    try {
        const fullMedia: LocalGalleryMedia = { ...mediaData, sync_status: 'pending' };
        await db.galleria.put(fullMedia);
        
        if (typeof window !== 'undefined' && navigator.onLine) {
            syncPendingGalleryMedia();
        }
    } catch (error) {
        logSync('salvataggio-locale-galleria-fallito');
        // Rilancia: il chiamante deve poter mostrare l'errore all'utente.
        throw error;
    }
}

export async function syncPendingGalleryMedia() {
    if (typeof window !== 'undefined' && !navigator.onLine) {
        return;
    }

    try {
        const pending = await db.galleria
            .where('sync_status')
            .anyOf('pending', 'error')
            .toArray();

        if (pending.length === 0) return;


        for (const item of pending) {
            try {
                // 1. Carica il blob tramite API server-side
                const formData = new FormData();
                const fileObj = new File([item.file_blob], item.file_name, {
                    type: item.file_type === 'video' ? 'video/mp4' : 'image/jpeg'
                });
                formData.append('file', fileObj);
                formData.append('userId', item.uploaded_by);

                const uploadRes = await fetch('/api/gallery/upload', {
                    method: 'POST',
                    // Identità via header (il campo form userId non è letto dal gate).
                    // FormData: NIENTE Content-Type (lo imposta il browser col boundary).
                    headers: { 'x-user-id': item.uploaded_by },
                    body: formData
                });

                if (!uploadRes.ok) {
                    // Il corpo della risposta NON si legge: conteneva il nome del
                    // file (una foto di minori). Basta lo stato per la diagnosi.
                    logSync('sync-galleria-upload-fallito');
                    await db.galleria.update(item.id, { sync_status: 'error' });
                    continue;
                }

                const { fileUrl } = await uploadRes.json();

                // 2. Salva il record nel database tramite l'API POST
                const response = await fetch('/api/gallery', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-user-id': item.uploaded_by },
                    body: JSON.stringify({
                        uploaded_by: item.uploaded_by,
                        file_url: fileUrl,
                        file_type: item.file_type,
                        caption: item.caption,
                        tag_students: item.tag_students,
                        is_broadcast: item.is_broadcast,
                        target_classes: item.target_classes,
                    }),
                });

                if (!response.ok) {
                    const errRes = await response.json();
                    throw new Error(errRes.error || 'Errore salvataggio DB');
                }

                // 4. Rimuovi dal database offline dopo il successo
                await db.galleria.delete(item.id);
            } catch {
                logSync('sync-galleria-item-fallito');
                await db.galleria.update(item.id, { sync_status: 'error' });
            }
        }
    } catch {
        logSync('sync-galleria-fallito');
    }
}


// ============================================================
// Primaria — Appello & Registro (Fase 1) — coda offline verso le API.
// A differenza di presenze/diario (upsert diretto), qui passiamo dalle API
// /api/primaria/* per applicare la logica server (compresenza, vincoli, notifiche).
// ============================================================

// Identità docente per la coda offline: localStorage → sessione (kv_user_id)
// → null. Nessun fallback demo (M4): senza identità il sync resta in coda
// (pending) e riparte alla prossima chiamata con identità risolta.
function teacherId(): string | null {
    if (typeof window !== 'undefined') {
        const stored = window.localStorage.getItem('kv_teacher_id')
            || window.localStorage.getItem('kv_user_id');
        if (stored) return stored;
    }
    return null;
}

export async function saveLocalAppello(data: Omit<LocalPrimariaAppello, 'sync_status'>) {
    const row: LocalPrimariaAppello = { ...data, sync_status: 'pending' };
    await db.primaria_appello.put(row);
    if (typeof window !== 'undefined' && navigator.onLine) syncPendingAppello();
}

export async function syncPendingAppello() {
    if (typeof window !== 'undefined' && !navigator.onLine) return;
    try {
        const pending = await db.primaria_appello.where('sync_status').anyOf('pending', 'error').toArray();
        if (pending.length === 0) return;
        const uid = teacherId();
        if (!uid) return; // identità non risolta: la coda resta pending
        for (const r of pending) {
            const res = await fetch(`/api/primaria/appello?userId=${uid}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': uid },
                body: JSON.stringify({ sectionId: r.section_id, data: r.data, alunnoId: r.alunno_id, stato: r.stato }),
            });
            await db.primaria_appello.update(r.id, { sync_status: res.ok ? 'synced' : 'error' });
        }
    } catch {
        logSync('sync-appello-primaria-fallito');
    }
}

export async function saveLocalRegistro(data: Omit<LocalPrimariaRegistro, 'sync_status'>) {
    const row: LocalPrimariaRegistro = { ...data, sync_status: 'pending' };
    await db.primaria_registro.put(row);
    if (typeof window !== 'undefined' && navigator.onLine) syncPendingRegistro();
}

export async function syncPendingRegistro() {
    if (typeof window !== 'undefined' && !navigator.onLine) return;
    try {
        const pending = await db.primaria_registro.where('sync_status').anyOf('pending', 'error').toArray();
        if (pending.length === 0) return;
        const uid = teacherId();
        if (!uid) return; // identità non risolta: la coda resta pending
        for (const r of pending) {
            const res = await fetch(`/api/primaria/registro?userId=${uid}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': uid },
                body: JSON.stringify({
                    sectionId: r.section_id, data: r.data, oraLezione: r.ora_lezione,
                    materiaId: r.materia_id, argomento: r.argomento, compiti: r.compiti,
                    tipoCompresenza: r.tipo_compresenza,
                }),
            });
            await db.primaria_registro.update(r.id, { sync_status: res.ok ? 'synced' : 'error' });
        }
    } catch {
        logSync('sync-registro-primaria-fallito');
    }
}
