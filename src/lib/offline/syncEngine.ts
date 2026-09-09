import { db, LocalAttendanceLog, LocalDiaryEntry, LocalGalleryMedia, LocalPrimariaAppello, LocalPrimariaRegistro, StatoCodaPrimaria } from './db';
import { createBrowserClient } from '@supabase/ssr';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { caricaMediaGalleria } from '@/lib/gallery/carica-media';
import { mimeBase } from '@/lib/gallery/limiti';

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
                // 1. Carica il blob — firma + `PUT` diretto allo Storage.
                //
                // ⚠️ QUI IL MULTIPART ERA UN GUASTO, non una scelta. Un video accodato
                // può arrivare a 50 MB (il client lo comprime fino a quel tetto prima di
                // metterlo in coda), e `POST /api/gallery/upload` prendeva 413 da Vercel
                // al ritorno della rete: la riga finiva `sync_status: 'error'` e quel
                // video NON RIPARTIVA PIÙ. Riparare la galleria online lasciando rotto il
                // percorso pensato per la scuola senza campo sarebbe stato metà lavoro.
                // IL TIPO SI DERIVA DAL BLOB, non si asserisce. Fino al 2026-09-09 questa
                // riga cablava `video/mp4` per ogni video: ma `processVideoWithWatermark`
                // sceglie il formato in base a ciò che il dispositivo sa registrare, e
                // altrove esce **webm**. Un webm partiva dichiarando mp4, e siccome il
                // server deriva l'estensione dal mime VALIDATO finiva in archivio come
                // `.mp4` — un file etichettato per quello che non è, nel bucket da cui il
                // genitore lo scarica. Il cablaggio resta come RIPIEGO, per i blob che un
                // tipo non ce l'hanno.
                const mime = mimeBase(item.file_blob.type)
                    || (item.file_type === 'video' ? 'video/mp4' : 'image/jpeg');
                const fileObj = new File([item.file_blob], item.file_name, { type: mime });

                const esito = await caricaMediaGalleria(fileObj, mime);
                if (!esito.ok) {
                    // Il motivo distingue i rami in SQL: «troppo grande» e «lo Storage ha
                    // rifiutato» hanno rimedi opposti. Il nome del file resta fuori: è la
                    // foto di un minore.
                    logSync(`sync-galleria-upload-fallito: ${esito.motivo}`);
                    await db.galleria.update(item.id, { sync_status: 'error' });
                    continue;
                }
                const path = esito.path;

                // 2. Salva il record nel database tramite l'API POST
                const response = await fetch('/api/gallery', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-user-id': item.uploaded_by },
                    body: JSON.stringify({
                        uploaded_by: item.uploaded_by,
                        file_url: path,
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

/**
 * CHE COSA SI BUTTA VIA, E CHE COSA NO — la domanda centrale di queste due code, perché
 * l'errore è possibile in ENTRAMBE le direzioni e le due direzioni non si equivalgono.
 *
 * Da un lato il ritentativo infinito: una riga che il server rifiuta *per sempre* torna
 * `error`, `error` viene ripescato insieme a `pending` a ogni riconnessione, e la stessa POST
 * riparte a ogni ingresso in pagina finché l'app è installata. Rumoroso, inutile, e comunque
 * senza che il docente veda niente.
 *
 * Dall'altro lo scarto: `scartato` NON si ripesca (`.anyOf('pending','error')`) e oggi NON LO
 * LEGGE NESSUNO — nessun componente in `src/` apre questi due store. Una riga scartata è una
 * firma di registro, o la presenza di un bambino, sparita in silenzio e senza appello.
 *
 * Le due direzioni non si equivalgono perché il ritentativo è REVERSIBILE e lo scarto no. Da
 * qui la politica, in tre insiemi e con il DUBBIO che pende dalla parte del ritentativo:
 *
 *  · DEFINITIVI — è il CORPO a essere sbagliato, e nessuno lo raddrizzerà mai: rispedirlo fra
 *    un mese darà lo stesso identico numero. Solo questi diventano `scartato` al primo «no».
 *
 *  · RIMEDIABILI — il corpo è a posto, è il MONDO INTORNO che dice no, e c'è una persona
 *    precisa che lo toglie di mezzo. Restano ritentabili, e non consumano il tetto: aspettare
 *    non è scommettere. Qui il ritentativo non è un difetto, è il meccanismo con cui il
 *    prodotto è progettato per farcela al secondo giro.
 *
 *  · tutto il resto — 5xx, 429, 408, e qualunque stato che non sappiamo leggere. Si ritenta,
 *    ma col tetto `MAX_TENTATIVI_CONSEGNA`, perché fra questi si nasconde anche il guasto
 *    permanente travestito da temporaneo (il 500 di un CHECK violato risponde 500 per sempre).
 *
 * ⚠️ NON è più la copia di `ritentabile()` di `src/lib/logging/client.ts`, e la differenza è
 * deliberata: quella governa una coda di LOG, che si può buttare via senza che nessuno perda
 * niente. Questa trasporta le firme del registro e le presenze dei bambini. Due code, due
 * rischi opposti, due politiche — scritte separate apposta, con il motivo accanto.
 */

/**
 * Il corpo è sbagliato e resterà sbagliato.
 *  · 400 — zod ha rifiutato il corpo (`primaria/registro:POST`, `primaria/appello:POST`);
 *  · 404 — la sezione non esiste;
 *  · 409 — esiste già una firma principale per quell'ora;
 *  · 413 — il corpo è troppo grande per la piattaforma;
 *  · 422 — manca un campo che la coda non sa produrre (es. `docenteId` per Segreteria: la
 *    modale del registro lo dice PRIMA di accodare, ma una riga già in coda da una build
 *    precedente non lo sa).
 */
const DEFINITIVI: ReadonlySet<number> = new Set([400, 404, 409, 413, 422]);

/**
 * I «no» che una persona toglie di mezzo, e la persona si sa chi è. NON diventano mai
 * `scartato`, e non consumano il tetto.
 *
 *  · 423 — REGISTRO CHIUSO. Scade dopo due giorni (`src/lib/primaria/timelock.ts`,
 *    `DEFAULT_CLASSE_ORALE = 2`) e una riga può attraversare la scadenza MENTRE STA IN CODA:
 *    è proprio quando il dispositivo è offline che la coda si riempie e i giorni passano.
 *    `/api/primaria/sblocca` esiste letteralmente perché quel 423 diventi un 200 — la sua
 *    stessa testata racconta che finché pretendeva `entitaId` «chi non aveva firmato in tempo
 *    non poteva più farlo e il dirigente non poteva autorizzarlo». Scartare al primo 423
 *    significa togliere al dirigente la cosa da sbloccare.
 *  · 401 — SESSIONE SCADUTA. `kv_teacher_id` in `localStorage` sopravvive alla sessione, e
 *    con `ALLOW_HEADER_IDENTITY=false` (vedi `docs/env.md`) l'header `x-user-id` che questa
 *    coda spedisce viene ignorato: al ritorno della rete ogni riga prende 401. Il docente
 *    rientra e riprende a lavorare; la coda deve essere ancora lì.
 *  · 403 — DOCENTE NON ABILITATO al grado (`assertGradoDocente`) o non ancora risolto
 *    (`utente-sconosciuto` in `require-staff.ts`). È un dato lato server che un
 *    amministratore sistema in minuti.
 */
const RIMEDIABILI: ReadonlySet<number> = new Set([401, 403, 423]);

/**
 * IL TETTO DEI «NO» CHE NON SAPPIAMO SPIEGARE.
 *
 * Un 500 è ritentabile per definizione — è la risposta che significa «non so dirti perché».
 * Ma il 500 di un vincolo CHECK violato risponderà 500 per sempre, e la coda non ha modo di
 * distinguerlo dal 500 di un deploy in corso. Senza un tetto, quel caso resta esattamente il
 * ritentativo infinito che questa modifica esiste per togliere, solo dietro un codice diverso.
 *
 * Cinque perché sono abbastanza da attraversare un deploy o un riavvio del database, e pochi
 * abbastanza da non trasformare una riga malata in traffico perpetuo. Conta solo le risposte
 * VERE del server, e solo quelle che non sappiamo leggere: i `RIMEDIABILI` non lo toccano.
 */
const MAX_TENTATIVI_CONSEGNA = 5;

/**
 * Che ne è di una riga a cui il server ha appena detto «no».
 *
 * Restituisce l'aggiornamento da scrivere in coda. `tentativiPrima` è `undefined` per le righe
 * accodate prima che questo campo esistesse: si leggono come 0, che è la verità (nessun «no»
 * contato).
 */
function esitoConsegna(
    stato: number,
    tentativiPrima: number | undefined,
): { sync_status: StatoCodaPrimaria; tentativi: number } {
    const tentativi = tentativiPrima ?? 0;
    // Un rifiuto rimediabile lascia il contatore FERMO: sei riconnessioni in un minuto non
    // devono bruciare l'attesa di un dirigente che risponde in giornata.
    if (RIMEDIABILI.has(stato)) return { sync_status: 'error', tentativi };
    const contati = tentativi + 1;
    const finita = DEFINITIVI.has(stato) || contati >= MAX_TENTATIVI_CONSEGNA;
    return { sync_status: finita ? 'scartato' : 'error', tentativi: contati };
}

/**
 * Il bilancio di UN flush. Esiste perché il log dica «quante», non «è successo».
 */
interface ContiFlush {
    consegnate: number;
    scartate: number;
    /** Rifiutate da qualcosa che una persona può togliere di mezzo: restano in coda. */
    inAttesa: number;
    /** Il server non poteva adesso: restano in coda, col tetto che scorre. */
    ritentabili: number;
    /** La richiesta non è mai arrivata: nessun tentativo consumato. */
    reteCaduta: number;
    /** Righe che il flush non ha nemmeno provato perché si è fermato prima (401). */
    nonTentate: number;
    stati: Map<number, number>;
    errori: Set<string>;
}

function contiVuoti(): ContiFlush {
    return {
        consegnate: 0, scartate: 0, inAttesa: 0, ritentabili: 0, reteCaduta: 0, nonTentate: 0,
        stati: new Map(), errori: new Set(),
    };
}

/**
 * UNA RIGA PER FLUSH, CON I NUMERI — e non una riga per firma.
 *
 * Il throttle di `logClient` deduplica su `evento|messaggio|stato` per 60 secondi (`DEDUP_MS`).
 * Trenta firme rifiutate con lo stesso stato allo stesso tentativo producevano un messaggio
 * IDENTICO trenta volte, cioè UNA riga in `app_log` per l'intero flush: «trenta firme perse» e
 * «una firma persa» erano la stessa identica traccia. Contare risolve il problema e riduce il
 * traffico verso `/api/logs` invece di aumentarlo.
 *
 * ⚠️ IL LIVELLO. `error` solo quando si è perso qualcosa; `warn` per tutto il resto, incluso il
 * flush andato bene. `logClient` non ha un livello `info` — `warn` è il pavimento, ed è
 * persistito e contabile. La riga del successo non è decorazione: AGENTS.md §5 chiede che gli
 * eventi critici loggino ANCHE il successo, perché con i soli errori «nessun log» non
 * distingue «tutto ok» da «non è mai partito niente». Un flush a vuoto (coda vuota) non scrive
 * niente: parte a ogni evento `online` e sarebbe rumore puro.
 *
 * ⚠️ LO STATO STA NEL TESTO, NON NEL CAMPO `stato`, e non è una svista: `livelloEvento` (in
 * `client.ts`) SOPPRIME gli eventi che portano uno `stato` 4xx ordinario — giustamente, perché
 * quei rifiuti il server li ha già registrati per conto suo. Ma qui l'evento non è «il server
 * ha risposto 400»: è «N firme sono state BUTTATE VIA dalla coda», e quello il server non può
 * saperlo né registrarlo. Passare `stato: 400` renderebbe invisibile l'unica riga che racconta
 * una perdita di dati.
 *
 * Conteggi e stati numerici sono STRUTTURA, non contenuto: niente id, niente nomi, niente testo
 * dei compiti, niente nome del bambino. `nomeErrore` restituisce solo il NOME della classe
 * d'errore, mai il messaggio (che può contenere un URL con un token). Regola 8 di AGENTS.md.
 */
function logFlush(coda: 'appello' | 'registro', c: ContiFlush): void {
    const pezzi = [
        `consegnate=${c.consegnate}`,
        `scartate=${c.scartate}`,
        `in-attesa=${c.inAttesa}`,
        `ritentabili=${c.ritentabili}`,
        `rete-caduta=${c.reteCaduta}`,
    ];
    if (c.nonTentate > 0) pezzi.push(`non-tentate=${c.nonTentate}`);
    if (c.stati.size > 0) {
        pezzi.push(`stati=${[...c.stati].map(([stato, n]) => `${stato}x${n}`).join(',')}`);
    }
    if (c.errori.size > 0) pezzi.push(`errori=${[...c.errori].join(',')}`);
    logClient({
        livello: c.scartate > 0 ? 'error' : 'warn',
        evento: 'offline',
        messaggio: `sync-${coda}-primaria-flush: ${pezzi.join(' ')}`,
    });
}

/** Registra un rifiuto del server nei conti del flush, secondo l'esito che ha prodotto. */
function contaRifiuto(c: ContiFlush, stato: number, scartata: boolean): void {
    c.stati.set(stato, (c.stati.get(stato) ?? 0) + 1);
    if (scartata) c.scartate++;
    else if (RIMEDIABILI.has(stato)) c.inAttesa++;
    else c.ritentabili++;
}

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

// `tentativi` lo tiene la CODA, non il chiamante: è contabilità della consegna, non un dato
// dell'appello. Per questo è escluso dall'argomento e nasce a 0.
export async function saveLocalAppello(data: Omit<LocalPrimariaAppello, 'sync_status' | 'tentativi'>) {
    const row: LocalPrimariaAppello = { ...data, sync_status: 'pending', tentativi: 0 };
    await db.primaria_appello.put(row);
    if (typeof window !== 'undefined' && navigator.onLine) syncPendingAppello();
}

export async function syncPendingAppello() {
    if (typeof window !== 'undefined' && !navigator.onLine) return;
    try {
        // `scartato` NON compare qui, ed è tutto il punto: è lo stato di chi non si ripesca.
        const pending = await db.primaria_appello.where('sync_status').anyOf('pending', 'error').toArray();
        if (pending.length === 0) return;
        const uid = teacherId();
        if (!uid) return; // identità non risolta: la coda resta pending
        const conti = contiVuoti();
        for (let i = 0; i < pending.length; i++) {
            const r = pending[i];
            // Il `try` sta DENTRO il ciclo: prima stava fuori, e una fetch che lanciava sulla
            // prima riga lasciava le altre non tentate fino al prossimo evento `online`.
            try {
                const res = await fetch(`/api/primaria/appello?userId=${uid}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-user-id': uid },
                    body: JSON.stringify({ sectionId: r.section_id, data: r.data, alunnoId: r.alunno_id, stato: r.stato }),
                });
                if (res.ok) {
                    await db.primaria_appello.update(r.id, { sync_status: 'synced' });
                    conti.consegnate++;
                    continue;
                }
                // 401 = la sessione è scaduta, e l'identità è la STESSA per tutte le righe:
                // continuare vorrebbe dire spedire l'intera coda per prendere lo stesso 401 a
                // ogni riga. Ci si ferma e si lascia tutto dov'è.
                if (res.status === 401) {
                    contaRifiuto(conti, 401, false);
                    conti.nonTentate = pending.length - (i + 1);
                    break;
                }
                const esito = esitoConsegna(res.status, r.tentativi);
                await db.primaria_appello.update(r.id, esito);
                contaRifiuto(conti, res.status, esito.sync_status === 'scartato');
            } catch (err) {
                // La rete è caduta con la richiesta in volo. NON consuma un tentativo: il
                // server non ha detto niente, e questa riga va riprovata quando torna il campo.
                conti.reteCaduta++;
                conti.errori.add(nomeErrore(err));
            }
        }
        logFlush('appello', conti);
    } catch (err) {
        // Resta per ciò che il ciclo non copre: la lettura di Dexie, `teacherId()`, il
        // database chiuso dal browser. Dice quale, invece di dire «fallito».
        logSync(`sync-appello-primaria-coda-illeggibile: ${nomeErrore(err)}`);
    }
}

// Come sopra: `tentativi` è della coda. `data_consegna_compiti`, invece, è del CHIAMANTE ed è
// obbligatorio — chi accoda una firma deve dire anche quando i compiti vanno consegnati,
// esattamente come lo dice il ramo online.
export async function saveLocalRegistro(data: Omit<LocalPrimariaRegistro, 'sync_status' | 'tentativi'>) {
    const row: LocalPrimariaRegistro = { ...data, sync_status: 'pending', tentativi: 0 };
    await db.primaria_registro.put(row);
    if (typeof window !== 'undefined' && navigator.onLine) syncPendingRegistro();
}

export async function syncPendingRegistro() {
    if (typeof window !== 'undefined' && !navigator.onLine) return;
    try {
        // `scartato` NON compare qui, ed è tutto il punto: è lo stato di chi non si ripesca.
        const pending = await db.primaria_registro.where('sync_status').anyOf('pending', 'error').toArray();
        if (pending.length === 0) return;
        const uid = teacherId();
        if (!uid) return; // identità non risolta: la coda resta pending
        const conti = contiVuoti();
        for (let i = 0; i < pending.length; i++) {
            const r = pending[i];
            try {
                const res = await fetch(`/api/primaria/registro?userId=${uid}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-user-id': uid },
                    body: JSON.stringify({
                        // `section_id` si trasporta com'è ARRIVATO, senza reinterpretarlo: in
                        // supplenza la classe firmata non è quella della pagina, e una coda che
                        // "aggiusta" la sezione aggancia argomento e compiti alla classe
                        // sbagliata restituendo un 200 tranquillo.
                        sectionId: r.section_id, data: r.data, oraLezione: r.ora_lezione,
                        materiaId: r.materia_id, argomento: r.argomento, compiti: r.compiti,
                        // Le righe accodate prima del 2026-09-09 non hanno il campo: il tipo
                        // descrive ciò che si SCRIVE, IndexedDB conserva anche ciò che si
                        // scriveva prima. `null` è ciò che il ramo online manda per «vuoto».
                        dataConsegnaCompiti: r.data_consegna_compiti ?? null,
                        tipoCompresenza: r.tipo_compresenza,
                    }),
                });
                if (res.ok) {
                    await db.primaria_registro.update(r.id, { sync_status: 'synced' });
                    conti.consegnate++;
                    continue;
                }
                // Vedi `syncPendingAppello`: il 401 riguarda l'identità, non la riga.
                if (res.status === 401) {
                    contaRifiuto(conti, 401, false);
                    conti.nonTentate = pending.length - (i + 1);
                    break;
                }
                const esito = esitoConsegna(res.status, r.tentativi);
                await db.primaria_registro.update(r.id, esito);
                contaRifiuto(conti, res.status, esito.sync_status === 'scartato');
            } catch (err) {
                conti.reteCaduta++;
                conti.errori.add(nomeErrore(err));
            }
        }
        logFlush('registro', conti);
    } catch (err) {
        logSync(`sync-registro-primaria-coda-illeggibile: ${nomeErrore(err)}`);
    }
}
