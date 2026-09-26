'use client';

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, Tag, WifiOff, X } from 'lucide-react';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { Btn } from '@/components/ui/Btn';
import { MediaGrid, MediaItem } from '@/components/features/gallery/MediaGrid';
import { erroreElimina, statoDaRigetto } from '@/components/features/gallery/DialogoEliminaMedia';
import { MediaUploader } from '@/components/features/gallery/MediaUploader';
import { AnteprimaMedia } from '@/components/features/gallery/AnteprimaMedia';
import { StudentTagger } from '@/components/features/gallery/StudentTagger';
import { VideoInLavorazione } from '@/components/features/gallery/VideoInLavorazione';
import { CodaFoto } from '@/components/features/gallery/CodaFoto';
import { useVideoGalleria } from '@/components/features/gallery/use-video-galleria';
import { syncPendingGalleryMedia } from '@/lib/offline/syncEngine';
import { accodaFotoGalleria, assegnaSedeFotoLegacy, listaFotoInCoda, prossimaRipresaCodaFoto, riprovaFotoInCoda, scartaFotoInCoda } from '@/lib/gallery/coda-foto';
import type { LocalGalleryMedia } from '@/lib/offline/db';
import { FotoTroppoGrandeError } from '@/lib/gallery/byte-foto';
import { processImageWithWatermark, ImageProcessingError } from '@/lib/media/processing';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { applicaTagATutte, fotoDaConfigurare, fotoGiaConfigurate } from '@/lib/gallery/applica-tag';
import { durataVideoDalFile, sedeDelCaricamento, sediDalCookie } from '@/lib/gallery/video-galleria-flusso';
import { messaggioErrore } from '@/lib/ui/esito-fetch';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { useOnlineStatus } from '@/lib/hooks/use-online-status';
import { useClientValue } from '@/lib/hooks/use-client-value';

// =============================================================================
// GLI ERRORI DEL SERVER SI LEGGONO NELLA LINGUA DELL'INTERFACCIA (2026-08-03).
//
// Questa pagina mostrava i rifiuti così: `alert(errData.error || t('…'))`, cioè
// la PROSA del server — che nasce dentro una route, dove il locale non esiste, e
// quindi nasce italiana. Con `<html lang="en">` una maestra leggeva «Uno o più
// bambini taggati non appartengono ai tuoi plessi.», mentre il `codice` che
// serve a tradurla (`TAG_FUORI_SEDE`) viaggiava nella stessa risposta e le
// chiavi erano già in `messages/it` e `messages/en`. Nessuno le leggeva.
//
// Da oggi ogni messaggio che nasce da una RISPOSTA passa da `messaggioErrore`
// (o da `messaggioDaCorpo`, quando il corpo serve anche per altro: il 422 del
// Privacy Lock porta `nomi`, e un corpo si legge una volta sola). Gli `alert`
// che NON leggono una risposta — «Tag aggiornati», «Media eliminato», gli errori
// di rete, i limiti dei video — restano `t(…)`: sono già nella lingua giusta, e
// farli passare da qui non avrebbe senso perché non c'è nessuna `Response`.
// =============================================================================

interface Student {
    id: string;
    nome: string;
    cognome: string;
    consenso_privacy: boolean;
    parents?: { id: string; nome: string; cognome: string; email: string }[];
}

type Step = 'gallery' | 'upload' | 'tag';

function TeacherGalleryContent() {
    const t = useTranslations('teacherServizi');
    // «Rimuovi file» vive in `shared`: è la stessa etichetta della X dello step 1,
    // e una seconda copia in `teacherServizi` sarebbe due stringhe da tradurre
    // per un gesto solo.
    const tShared = useTranslations('shared');
    const { userId: teacherId } = useSessionIdentity();

    // =========================================================================
    // V11 · I VIDEO NON PASSANO PIÙ DALLA PORTA DELLE FOTO.
    //
    // Fino al 2026-09-18 un video di galleria veniva convertito DENTRO il
    // browser del telefono (`processVideoWithWatermark`, watermark su `<canvas>`)
    // e poi spedito come una foto qualunque, con un tetto di 50 MiB scritto a
    // mano proprio qui — cinquanta mebibyte come prodotto di tre numeri, che nel
    // sorgente erano tre letterali. Tre limiti veri:
    //
    //  · un iPhone che converte tre minuti di filmato impiega minuti, e a volte
    //    non ci riesce affatto (la frase «questo video non può essere convertito
    //    su questo dispositivo» esiste perché succedeva);
    //  · 50 MiB sono pochi per un telefono moderno;
    //  · e finché la conversione gira nel browser, chiudere l'app butta via tutto.
    //
    // Adesso il file parte com'è verso un bucket privato (upload TUS, ripartibile)
    // e la conversione la fa il server. I due tetti non sono più scritti qui: sono
    // `MAX_VIDEO_INPUT_BYTES`/`MAX_VIDEO_DURATION_SECONDS` della pipeline, e li
    // applica `rifiutoLocaleVideo` PRIMA che parta un byte. Il tetto delle FOTO —
    // `TETTO_GALLERIA_BYTE`, che resta 50 MiB e deve restarci — lo applica
    // `caricaMediaGalleria`, che è la sola porta che il browser usa da sé.
    // =========================================================================
    const [media, setMedia] = useState<MediaItem[]>([]);
    const [students, setStudents] = useState<Student[]>([]);
    const [loading, setLoading] = useState(true);
    const [step, setStep] = useState<Step>('gallery');
    const [uploadedFiles, setUploadedFiles] = useState<{
        file: File;
        preview: string;
        tag_students: string[];
        is_broadcast: boolean;
    }[]>([]);
    const [activeFileIndex, setActiveFileIndex] = useState<number>(0);
    const [uploading, setUploading] = useState(false);
    const [queueRows, setQueueRows] = useState<LocalGalleryMedia[]>([]);
    const [queueNow, setQueueNow] = useState(0);
    const [readError, setReadError] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [userRole, setUserRole] = useState<string>('educator');
    // SSR-safe (niente hydration mismatch né setState-in-effect).
    const isOnline = useOnlineStatus();

    // ── LA SEDE DEL VIDEO ────────────────────────────────────────────────────
    // `POST /api/video-uploads` pretende un uuid di sede: a differenza della
    // pubblicazione di una foto, che il server può dedurre dal cookie o dall'unico
    // plesso dell'utente, qui l'intento nasce PRIMA e deve già sapere dove
    // archivierà. Perciò la sede si risolve qui, con la stessa regola del server
    // (`resolveScuolaScrittura`), e quando non si può sapere si CHIEDE invece di
    // indovinare: un video archiviato nel plesso sbagliato non lo scopre nessuno.
    const [scuolaPrimaria, setScuolaPrimaria] = useState<string | null>(null);
    const [sediAccessibili, setSediAccessibili] = useState<string[] | null>(null);
    // Il cookie si legge SOLO nel browser, e si legge come STRINGA: `useClientValue`
    // gira su `useSyncExternalStore`, che pretende uno snapshot stabile fra due
    // render — un array nuovo ogni volta sarebbe un ciclo infinito. È anche il modo
    // per non scrivere uno stato dentro un effetto (`react-hooks/set-state-in-effect`)
    // né produrre un disallineamento di hydration fra server e browser.
    const cookieSedi = useClientValue(() => (typeof document !== 'undefined' ? document.cookie : ''), '');
    const sediSelezionate = useMemo(() => sediDalCookie(cookieSedi), [cookieSedi]);
    const sedeVideo = sedeDelCaricamento({
        ruolo: userRole,
        scuolaPrimaria,
        sediSelezionate,
        sediAccessibili,
    });
    const ambitoAttivoRef = useRef({ ownerId: teacherId, schoolId: sedeVideo, active: true });
    useEffect(() => {
        ambitoAttivoRef.current = { ownerId: teacherId, schoolId: sedeVideo, active: true };
        return () => { ambitoAttivoRef.current.active = false; };
    }, [teacherId, sedeVideo]);
    const ambitoCorrente = useCallback(() =>
        ambitoAttivoRef.current.active && ambitoAttivoRef.current.ownerId === teacherId
        && ambitoAttivoRef.current.schoolId === sedeVideo, [teacherId, sedeVideo]);

    // Sezione reale da /api/educator-sections: init vuoto, mai hardcoded
    // (i loader sono guardati da `if (!sezione) return`).
    const [sezione, setSezione] = useState<string>('');
    const [availableSections, setAvailableSections] = useState<string[]>([]);

    const loadMedia = useCallback(async (): Promise<boolean> => {
        // La GET galleria è gated: serve l'identità (sessione o header).
        if (!sezione || !teacherId) return false;
        try {
            // Seleziona media per la sezione del docente
            const res = await fetch(`/api/gallery?classe=${sezione}`, {
                headers: { 'x-user-id': teacherId },
            });
            if (!res.ok) throw Object.assign(new Error('gallery_read_rejected'), { stato: res.status });
            const data = await res.json();
            if (!Array.isArray(data?.media)) throw new Error('gallery_read_invalid');
            if (!ambitoCorrente()) return false;
            setMedia(data.media);
            setReadError(false);
            return true;
        } catch (error) {
            if (!ambitoCorrente()) return false;
            const stato = (error as { stato?: unknown })?.stato;
            logClient({ livello: 'error', evento: 'fetch', messaggio: 'gallery-lettura-fallita', route: '/teacher/gallery', ...(typeof stato === 'number' ? { stato } : {}) });
            setReadError(true);
            return false;
        } finally {
            setLoading(false);
        }
    }, [sezione, teacherId, ambitoCorrente]);

    const loadStudents = useCallback(async () => {
        if (!sezione) return;
        try {
            const res = await fetch(`/api/diary/students?sezione=${sezione}`);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) {
                    if (!ambitoCorrente()) return;
                    setStudents(data.map((s: { id: string; nome: string; cognome: string; consenso_privacy?: boolean; parents?: Student['parents'] }) => ({
                        id: s.id,
                        nome: s.nome,
                        cognome: s.cognome,
                        consenso_privacy: s.consenso_privacy !== false,
                        parents: s.parents || [],
                    })));
                }
            } else {
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'gallery-studenti-rifiutati', route: '/teacher/gallery', stato: res.status });
            }
        } catch {
            logClient({ livello: 'error', evento: 'fetch', messaggio: 'gallery-studenti-fallito', route: '/teacher/gallery' });
        }
    }, [sezione, ambitoCorrente]);

    // Carica sezioni educatore (sezione reale, mai hardcoded — pattern locker)
    useEffect(() => {
        const fetchSections = async () => {
            if (!teacherId) return;
            try {
                const res = await fetch(`/api/educator-sections?userId=${teacherId}`);
                const data = res.ok ? await res.json() : null;
                const sections: string[] = data?.sectionNames ?? [];
                setAvailableSections(sections);
                if (sections.length > 0) {
                    setSezione(prev => prev || sections[0]);
                } else {
                    // Nessuna sezione (o errore API): niente da caricare → spegni lo spinner.
                    setLoading(false);
                }
            } catch {
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'gallery-sezioni-fallito', route: '/teacher/gallery' });
                setLoading(false);
            }
        };
        fetchSections();
    }, [teacherId]);

    const aggiornaCoda = useCallback(async () => {
        if (!teacherId || !sedeVideo) { setQueueRows([]); return; }
        try {
            const righe = await listaFotoInCoda({ ownerId: teacherId, schoolId: sedeVideo });
            if (!ambitoCorrente()) return;
            setQueueRows(righe);
            setQueueNow(Date.now());
        }
        catch { logClient({ livello: 'error', evento: 'offline', messaggio: 'gallery-coda-lettura-fallita' }); }
    }, [teacherId, sedeVideo, ambitoCorrente]);

    const sincronizzaCoda = useCallback(async () => {
        if (!teacherId || !sedeVideo) return;
        try {
            await syncPendingGalleryMedia({ ownerId: teacherId, schoolId: sedeVideo, isCurrent: ambitoCorrente });
            if (!ambitoCorrente()) return;
            await aggiornaCoda();
            if (isOnline) await loadMedia();
        } catch {
            logClient({ livello: 'error', evento: 'offline', messaggio: 'gallery-coda-sincronizzazione-fallita' });
            setUploadError(t('galleryErrCaricamentoGenerico'));
            await aggiornaCoda();
        }
    }, [teacherId, sedeVideo, isOnline, aggiornaCoda, loadMedia, t, ambitoCorrente]);

    // Quando è (ri)online, sincronizza solo la sede e l'account correnti.
    useEffect(() => {
        if (!teacherId || !sedeVideo) return;
        void Promise.resolve().then(() => {
            void aggiornaCoda();
            if (isOnline) void sincronizzaCoda();
        });
    }, [teacherId, sedeVideo, isOnline, aggiornaCoda, sincronizzaCoda]);

    // Un 429/503 sospende la coda anche dopo il reload. Alla scadenza del
    // Retry-After la ripresa non richiede che la persona cambi pagina o clicchi.
    useEffect(() => {
        if (!isOnline || !ambitoCorrente()) return;
        const attesaMs = prossimaRipresaCodaFoto(queueRows, queueNow);
        if (attesaMs === null) return;
        const timer = window.setTimeout(() => { void sincronizzaCoda(); }, Math.max(1, attesaMs));
        return () => window.clearTimeout(timer);
    }, [queueRows, queueNow, isOnline, ambitoCorrente, sincronizzaCoda]);

    // Carica ruolo utente corrente (via /api/me gated, niente lettura anon di `utenti`)
    // e, con lui, la SEDE del profilo: da V11 serve a dichiarare dove finirà il video.
    useEffect(() => {
        const fetchUserRole = async () => {
            if (!teacherId) return;
            try {
                const res = await fetch('/api/me', { headers: { 'x-user-id': teacherId } });
                if (!res.ok) return;
                const me = await res.json().catch(() => null);
                const ruolo = me?.ruolo ?? me?.role;
                if (ruolo) setUserRole(ruolo);
                if (typeof me?.scuola_id === 'string') setScuolaPrimaria(me.scuola_id);
            } catch {
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'gallery-ruolo-fallito', route: '/teacher/gallery' });
            }
        };
        fetchUserRole();
    }, [teacherId]);

    /**
     * LE SEDI, PER CHI PUÒ AVERNE PIÙ D'UNA.
     *
     * `scuoleDiUtente` (server) restituisce il solo `utenti.scuola_id` a tutti i
     * ruoli tranne `admin`: per un'educatrice o una coordinatrice «la sede del
     * profilo» e «l'unica sede» sono lo stesso valore, e non c'è niente da
     * chiedere. Per un admin no — e chiedere è l'unico modo di non indovinare.
     *
     * Il cookie `sedi_attive` è la scelta fatta nel cockpit: non è un segreto (il
     * server la ri-valida sempre) e qui serve a non ri-chiedere a chi ha già
     * scelto.
     */
    useEffect(() => {
        if (userRole !== 'admin' || !teacherId) return;
        const fetchSedi = async () => {
            try {
                const res = await fetch('/api/admin/sedi', { headers: { 'x-user-id': teacherId } });
                if (!res.ok) return;
                const corpo = await res.json().catch(() => null);
                const elenco = Array.isArray(corpo?.data)
                    ? (corpo.data as { id?: unknown }[]).map((s) => String(s.id)).filter(Boolean)
                    : null;
                if (elenco) setSediAccessibili(elenco);
            } catch {
                // Elenco non arrivato: `sediAccessibili` resta `null`, che per un
                // admin significa «non lo so» — e `sedeDelCaricamento` in quel caso
                // NON ripiega sulla sede del profilo. Meglio chiedere di scegliere
                // che archiviare il video di un bambino nel plesso sbagliato.
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'gallery-sedi-fallito', route: '/teacher/gallery' });
            }
        };
        fetchSedi();
    }, [teacherId, userRole]);

    useEffect(() => {
        void Promise.resolve().then(() => {
            void loadMedia();
            void loadStudents();
        });
    }, [loadMedia, loadStudents]);

    /**
     * I VIDEO IN LAVORAZIONE — la parte di questa schermata che vive più a lungo
     * della schermata stessa.
     *
     * L'hook si occupa di tre cose che la pagina non può fare: riprendere al
     * rientro i caricamenti rimasti a metà, tornare a interrogare i job che il
     * server sta convertendo, e pubblicare quando sono pronti. Vedi la testata di
     * `use-video-galleria.ts` per il perché.
     */
    const videoGalleria = useVideoGalleria({
        utenteId: teacherId,
        sede: sedeVideo,
        classi: sezione ? [sezione] : [],
        onPubblicato: () => { void loadMedia(); },
    });

    const handleUploadFiles = (files: { file: File; preview: string }[]) => {
        setUploadedFiles(files.map(f => ({
            file: f.file,
            preview: f.preview,
            tag_students: [],
            is_broadcast: false
        })));
        setActiveFileIndex(0);
        setStep('tag');
    };

    /**
     * TOGLIE UN FILE DALLO STEP 2 — perché fino a oggi non si poteva.
     *
     * La striscia delle miniature non aveva NESSUN gesto di rimozione: una volta
     * passati allo step 2, un file scelto per sbaglio ci restava, e l'unica via
     * d'uscita era «Annulla» — che butta anche i tag già messi sulle altre foto.
     * Su un caricamento da 37 foto (è successo il 6 settembre) significa rifare
     * tutto per un file di troppo.
     *
     * NESSUNA CONFERMA, di proposito. Il gesto è reversibile — il file si
     * riscegli — e una conferma su un gesto innocuo è quella che si impara a
     * premere senza leggere: la stessa ragione scritta per esteso in
     * `handleApplyToAll` qui sotto, che invece la chiede perché lì si perde
     * lavoro fatto a mano.
     *
     * Le tre cose che devono succedere insieme, e che qui stanno in un posto solo:
     *  1. l'objectURL si REVOCA (altrimenti il blob resta in memoria fino al
     *     ricaricamento della pagina: un video da 14 MB per volta);
     *  2. `activeFileIndex` RIENTRA, altrimenti punta oltre la fine dell'elenco e
     *     la scheda dei tag smette di comparire senza dire perché;
     *  3. se l'elenco si svuota si torna al passo di scelta, non a uno step 2
     *     vuoto da cui non si esce.
     */
    const rimuoviFileSelezionato = (indice: number) => {
        const rimosso = uploadedFiles[indice];
        if (!rimosso) return;
        URL.revokeObjectURL(rimosso.preview);
        const restanti = uploadedFiles.filter((_, i) => i !== indice);
        setUploadedFiles(restanti);
        // Se ho tolto una foto PRIMA di quella attiva, l'attiva è scalata di uno;
        // se ho tolto proprio l'attiva (o una dopo), basta non sforare la fine.
        setActiveFileIndex(prev => (
            indice < prev ? prev - 1 : Math.min(prev, Math.max(restanti.length - 1, 0))
        ));
        if (restanti.length === 0) setStep('upload');
    };

    const handleToggleTag = (studentId: string) => {
        setUploadedFiles(prev => prev.map((f, idx) => {
            if (idx !== activeFileIndex) return f;
            const exists = f.tag_students.includes(studentId);
            return {
                ...f,
                tag_students: exists
                    ? f.tag_students.filter(id => id !== studentId)
                    : [...f.tag_students, studentId]
            };
        }));
    };

    const handleSelectAllTags = () => {
        setUploadedFiles(prev => prev.map((f, idx) => {
            if (idx !== activeFileIndex) return f;
            return {
                ...f,
                tag_students: students.filter(s => s.consenso_privacy).map(s => s.id)
            };
        }));
    };

    const handleDeselectAllTags = () => {
        setUploadedFiles(prev => prev.map((f, idx) => {
            if (idx !== activeFileIndex) return f;
            return {
                ...f,
                tag_students: []
            };
        }));
    };

    const handleToggleBroadcast = (checked: boolean) => {
        setUploadedFiles(prev => prev.map((f, idx) => {
            if (idx !== activeFileIndex) return f;
            return {
                ...f,
                is_broadcast: checked,
                tag_students: checked ? [] : f.tag_students
            };
        }));
    };

    // Quante foto il gesto riempirebbe, e quante ne perderebbero i propri tag.
    // Servono anche all'ETICHETTA del pulsante: il numero letto prima di premere
    // è la difesa che costa meno di tutte.
    const daRiempire = fotoDaConfigurare(uploadedFiles, activeFileIndex);
    const giaConfigurate = fotoGiaConfigurate(uploadedFiles, activeFileIndex);

    /**
     * «✨ APPLICA» — LA DOMANDA ARRIVA PRIMA, E DI NORMA NON SI PERDE NIENTE.
     *
     * Fino al 2026-09-08 questo gesto copiava i tag della foto attiva su TUTTE le
     * altre e lo diceva DOPO, con un `alert` che non si poteva annullare. Il 6
     * settembre un'insegnante ha caricato 37 foto taggando i bambini presenti in
     * ognuna: in archivio tutte e 37 hanno la stessa impronta di tag, gli stessi
     * 2 bambini (entrambi con la liberatoria, quindi non è il lucchetto privacy).
     * Quelle due famiglie hanno ricevuto 37 foto, tutte le altre nessuna.
     *
     * Due strade, e nessuna delle due sorprende:
     *  · ci sono foto ancora senza tag → si riempiono SOLO quelle. Se altre hanno
     *    già i loro, la domanda lo dice e dichiara che non verranno toccate.
     *  · sono tutte già configurate → l'unico gesto utile è sostituire, e allora
     *    la domanda usa quella parola e dice cosa va perso.
     */
    const handleApplyToAll = () => {
        if (!uploadedFiles[activeFileIndex]) return;

        if (daRiempire === 0) {
            // Niente da riempire: resta solo la sostituzione, che è distruttiva
            // e quindi non può essere il ramo silenzioso.
            if (giaConfigurate === 0) return;
            if (!confirm(t('galleryConfermaSostituisci', { gia: giaConfigurate }))) return;
            setUploadedFiles(prev => applicaTagATutte(prev, activeFileIndex, { sovrascrivi: true }));
            return;
        }

        // Si chiede solo quando c'è qualcosa da sapere. Una conferma che compare
        // anche quando non si può perdere niente è una conferma che si impara a
        // premere senza leggere — ed è così che si torna al difetto di prima.
        if (giaConfigurate > 0
            && !confirm(t('galleryConfermaApplicaParziale', { n: daRiempire, gia: giaConfigurate }))) return;
        setUploadedFiles(prev => applicaTagATutte(prev, activeFileIndex));
    };

    const activeFile = uploadedFiles[activeFileIndex] || null;
    const activeTags = activeFile ? activeFile.tag_students : [];
    const activeIsBroadcast = activeFile ? activeFile.is_broadcast : false;

    const handleConfirmUpload = async () => {
        if (!teacherId || uploading) return;
        if (uploadedFiles.some(f => !f.file.type.startsWith('video/')) && !sedeVideo) {
            setUploadError(t('galleryCodaSedeRichiesta'));
            return;
        }
        setUploading(true);
        setUploadError(null);
        const completati = new Set<number>();
        const accodati = new Set<string>();
        let fotoAccodate = 0;
        let videoAvviati = 0;
        try {
            // Prima si conserva TUTTO il lotto foto nel dispositivo. La rete parte
            // solo dopo: un 429 sulla 31ª non perde le prime 30 né l'ultima.
            for (let i = 0; i < uploadedFiles.length; i++) {
                const f = uploadedFiles[i];
                if (f.file.type.startsWith('video/')) {
                    // La pipeline video ha il suo intento e il proprio TUS riprendibile.
                    if (!isOnline) {
                        alert(t('galleryAlertVideoOffline', { nome: f.file.name }));
                        continue;
                    }
                    const durata = await durataVideoDalFile(f.file);
                    const avvio = await videoGalleria.avviaVideo(f.file, {
                        tag: f.is_broadcast ? [] : f.tag_students,
                        broadcast: f.is_broadcast,
                        durataSecondi: durata,
                    });
                    if (!avvio.ok) {
                        alert(avvio.messaggio);
                        continue;
                    }
                    videoAvviati++;
                    completati.add(i);
                    continue;
                }
                if (!ambitoCorrente()) break;
                if (!sedeVideo) continue;
                let processedFile: File = f.file;
                let phase: 'preparing' | 'upload' = 'upload';
                try {
                    processedFile = await processImageWithWatermark(f.file, '/watermark.png');
                } catch (error) {
                    // Anche l'originale non decodificabile resta nel dispositivo.
                    // «Riprova foto» ripete l'elaborazione; «Scarta» è esplicito.
                    phase = 'preparing';
                    logClient({ livello: 'error', evento: 'offline', messaggio: error instanceof ImageProcessingError
                        ? 'gallery-foto-non-decodificabile' : 'gallery-foto-elaborazione-fallita', route: '/teacher/gallery' });
                }
                if (!ambitoCorrente()) break;
                try {
                    const id = crypto.randomUUID();
                    await accodaFotoGalleria({
                        id, uploaded_by: teacherId, scuola_id: sedeVideo,
                        caption: f.file.name,
                        tag_students: f.is_broadcast ? [] : f.tag_students,
                        is_broadcast: f.is_broadcast,
                        target_classes: f.is_broadcast ? [sezione] : null,
                        file_blob: processedFile,
                        file_name: processedFile.name,
                        creato_il: new Date().toISOString(),
                        phase,
                    });
                    fotoAccodate++;
                    accodati.add(id);
                    completati.add(i);
                } catch (error) {
                    // Quota IndexedDB o altro guasto locale: il file non è in coda,
                    // quindi resta nello step dei tag finché l'utente non riprova.
                    logClient({ livello: 'error', evento: 'offline', messaggio: 'gallery-foto-accodamento-fallito', route: '/teacher/gallery' });
                    setUploadError(t(error instanceof FotoTroppoGrandeError ? 'galleryErrTroppoGrande' : 'galleryCodaSalvataggioFallito'));
                }
            }
            if (fotoAccodate > 0 && isOnline && sedeVideo) {
                try { await syncPendingGalleryMedia({ ownerId: teacherId, schoolId: sedeVideo, isCurrent: ambitoCorrente }); }
                catch { logClient({ livello: 'error', evento: 'offline', messaggio: 'gallery-coda-drain-fallito', route: '/teacher/gallery' }); }
            }
            if (fotoAccodate > 0 && !ambitoCorrente()) return;
            const rows = fotoAccodate > 0 && sedeVideo
                ? await listaFotoInCoda({ ownerId: teacherId, schoolId: sedeVideo }) : [];
            if (fotoAccodate > 0) {
                setQueueRows(rows);
                setQueueNow(Date.now());
            }
            const inCoda = rows.filter(row => accodati.has(row.id)).length;
            const pubblicate = Math.max(0, fotoAccodate - inCoda);
            if (fotoAccodate > 0) alert(t('galleryCodaEsito', { pubblicate, inCoda }));
            if (videoAvviati > 0) alert(t('galleryVideoAvviato'));
            if (isOnline && (fotoAccodate > 0 || videoAvviati > 0)) await loadMedia();
        } catch (error) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: `gallery-pubblicazione-fallita: ${nomeErrore(error)}`, route: '/teacher/gallery' });
            setUploadError(t('galleryErrCaricamentoGenerico'));
        } finally {
            if ((fotoAccodate === 0 || ambitoCorrente()) && completati.size > 0) {
                const rimanenti = uploadedFiles.filter((_, i) => !completati.has(i));
                setUploadedFiles(rimanenti);
                setActiveFileIndex(0);
                setStep(rimanenti.length > 0 ? 'tag' : 'gallery');
            }
            setUploading(false);
        }
    };

    const riprovaFoto = async (id: string) => {
        if (!teacherId || !sedeVideo) return;
        try {
            await riprovaFotoInCoda({ ownerId: teacherId, schoolId: sedeVideo }, id);
            await sincronizzaCoda();
        } catch {
            logClient({ livello: 'error', evento: 'offline', messaggio: 'gallery-coda-riprova-fallita', route: '/teacher/gallery' });
            setUploadError(t('galleryErrCaricamentoGenerico'));
        }
    };

    const assegnaSedeFoto = async (id: string) => {
        if (!teacherId || !sedeVideo) return;
        try {
            await assegnaSedeFotoLegacy({ ownerId: teacherId, schoolId: sedeVideo }, id);
            await sincronizzaCoda();
        } catch {
            logClient({ livello: 'error', evento: 'offline', messaggio: 'gallery-coda-sede-assegnazione-fallita', route: '/teacher/gallery' });
            setUploadError(t('galleryErrCaricamentoGenerico'));
        }
    };

    const scartaFoto = async (id: string) => {
        if (!teacherId || !sedeVideo || !confirm(t('galleryCodaConfermaScarta'))) return;
        try {
            const scartata = await scartaFotoInCoda({ ownerId: teacherId, schoolId: sedeVideo }, id);
            if (!scartata) setUploadError(t('galleryCodaScartoBloccato'));
            await aggiornaCoda();
        } catch {
            logClient({ livello: 'error', evento: 'offline', messaggio: 'gallery-coda-scarto-fallito', route: '/teacher/gallery' });
            setUploadError(t('galleryErrCaricamentoGenerico'));
        }
    };

    /**
     * L'ELIMINAZIONE RIGETTA, e non mostra più niente da sé.
     *
     * ─── COM'ERA, E PERCHÉ ERA SBAGLIATO (misurato il 2026-09-12) ────────────
     * Fino a oggi questo gestore apriva un `confirm(t('galleryConfermaElimina'))`
     * e chiudeva con `alert(...)`. Sul simulatore iPhone 16e, eliminare una foto
     * dall'app nativa produceva **tre dialoghi in fila**: quello curato di
     * `DialogoEliminaMedia`, poi il `confirm` di sistema — che in WKWebView
     * mostra i propri pulsanti in INGLESE («Cancel» / «Ok») su un prodotto che
     * parla solo italiano — e infine l'`alert` di successo, mentre il dialogo
     * curato restava dietro con la rotella su «Eliminazione…».
     *
     * E c'era di peggio del fastidio: risolvendo SEMPRE, questo gestore rendeva
     * irraggiungibile l'unica cosa per cui `DialogoEliminaMedia` è stato
     * scritto. Il dialogo distingue 403 (confine di sede), 404 (l'esito voluto è
     * raggiunto) e 500/rete (riprovare è il rimedio) LEGGENDO il rigetto: un
     * `alert` seguito da un `return` gli arriva come «riuscita», quindi il visore
     * si chiudeva e il messaggio compariva su una schermata che non mostrava più
     * la foto di cui parlava. `tsc` non poteva accorgersene — una funzione
     * `async` che non lancia mai soddisfa `(id) => Promise<void>` alla perfezione
     * — e a vederlo è stato il lock `media-elimina-chiamante-rigetta`, che teneva
     * questo file in allowlist con la correzione già scritta dentro.
     *
     * ⚠️ IL 404 È UNA RIUSCITA, non un errore: la riga non c'è più, cioè l'esito
     * che l'insegnante voleva. Lo dice il contratto della prop `onDelete`.
     * ⚠️ `teacherId` assente LANCIA invece di ritornare: un `return` qui sarebbe
     * l'ennesimo falso successo, con il dialogo che si chiude annunciando
     * un'eliminazione che non è mai partita.
     */
    const handleDeleteMedia = async (id: string) => {
        if (!teacherId) throw erroreElimina(t('galleryErrEliminazione'), null);
        try {
            const res = await fetch(`/api/gallery?id=${id}&userId=${teacherId}`, {
                method: 'DELETE'
            });
            if (res.ok || res.status === 404) {
                await loadMedia();
                return;
            }
            // Il rifiuto ADESSO era muto nei log: restava solo a schermo, e il
            // giorno dopo «la foto c'è ancora» non aveva nessuna riga a cui
            // risalire. `stato` distingue un 403 di sede da un 500.
            logClient({ livello: 'error', evento: 'fetch', messaggio: 'gallery-delete-rifiutato', route: '/teacher/gallery', stato: res.status });
            throw erroreElimina(await messaggioErrore(res, t('galleryErrEliminazione')), res.status);
        } catch (e) {
            // Già tradotto e classificato dal ramo qui sopra: si rilancia com'è,
            // altrimenti un 403 di sede tornerebbe indietro travestito da guasto
            // di rete e il dialogo lascerebbe il comando premibile.
            if (statoDaRigetto(e) !== null) throw e;
            logClient({ livello: 'error', evento: 'fetch', messaggio: 'gallery-delete-fallito', route: '/teacher/gallery' });
            throw erroreElimina(t('galleryErrReteEliminazione'), null);
        }
    };

    const handleUpdateTags = async (mediaId: string, newTags: string[]) => {
        if (!teacherId) return;
        try {
            const res = await fetch('/api/gallery', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'x-user-id': teacherId },
                body: JSON.stringify({
                    id: mediaId,
                    userId: teacherId,
                    tag_students: newTags
                })
            });
            if (res.ok) {
                alert(t('galleryAlertTagAggiornati'));
                await loadMedia();
            } else {
                // Era `alert(errData.error || …)`: il 403 `TAG_FUORI_SEDE` usciva in
                // italiano anche con l'interfaccia in inglese. Il log non c'era affatto.
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'gallery-tag-rifiutato', route: '/teacher/gallery', stato: res.status });
                alert(await messaggioErrore(res, t('galleryErrTag')));
            }
        } catch {
            logClient({ livello: 'error', evento: 'fetch', messaggio: 'gallery-tag-fallito', route: '/teacher/gallery' });
            alert(t('galleryErrReteTag'));
        }
    };

    return (
        <div className="mx-auto max-w-[460px] px-4 pt-5">
            {/* Offline Alert Bar */}
            {!isOnline && (
                <div className="flex items-center gap-2 mb-4 p-3 bg-kidville-warn-soft border border-kidville-warn/30 text-kidville-warn rounded-2xl text-xs font-medium">
                    <WifiOff size={14} className="text-kidville-warn flex-shrink-0" />
                    <span>{t('galleryOffline')}</span>
                </div>
            )}

            {/* Header verde (DR) */}
            <PageHeaderCard
                eyebrow={t('galleryEyebrow')}
                title={t('galleryTitolo')}
                subtitle={t('gallerySottotitolo', { sezione: sezione || '…' })}
            />

            {uploadError && <p role="alert" className="mt-3 rounded-xl border border-kidville-warn/30 bg-kidville-warn-soft p-3 font-maven text-sm text-kidville-ink">{uploadError}</p>}
            {readError && (
                <div role="alert" className="mt-3 rounded-xl border border-kidville-warn/30 bg-kidville-warn-soft p-3 font-maven text-sm text-kidville-ink">
                    <p>{t('galleryLetturaFallita')}</p>
                    <button type="button" onClick={() => { void loadMedia(); }} className="mt-2 font-bold underline underline-offset-2">
                        {t('galleryRiprovaLettura')}
                    </button>
                </div>
            )}
            <CodaFoto rows={queueRows} now={queueNow} onRetryAll={() => { void sincronizzaCoda(); }}
                onRetryRow={(id) => { void riprovaFoto(id); }} onDiscard={(id) => { void scartaFoto(id); }}
                onAssignSchool={(id) => { void assegnaSedeFoto(id); }} />

            {/* Controlli (sezione + step) */}
            <div className="mt-3 flex flex-wrap items-center gap-3">
                {availableSections.length > 1 && (
                    <div className="flex items-center gap-2">
                        <label htmlFor="section-select" className="font-barlow font-bold text-xs text-kidville-muted uppercase tracking-wide">
                            {t('gallerySezioneLabel')}
                        </label>
                        <select
                            id="section-select"
                            value={sezione}
                            onChange={(e) => setSezione(e.target.value)}
                            className="rounded-xl border border-kidville-line bg-white px-3 py-1.5 font-barlow text-sm font-bold uppercase text-kidville-green shadow-sm focus:outline-none focus:ring-1 focus:ring-kidville-green"
                        >
                            {availableSections.map((sec) => (
                                <option key={sec} value={sec}>{sec}</option>
                            ))}
                        </select>
                    </div>
                )}

                <div className="ml-auto flex items-center gap-2">
                    {step === 'gallery' && (
                        <Btn variant="primary" size="sm" onClick={() => setStep('upload')}>
                            <Upload size={16} strokeWidth={1.5} /> {t('galleryCarica')}
                        </Btn>
                    )}
                    {step !== 'gallery' && (
                        <Btn variant="ghost" size="sm" onClick={() => { setStep('gallery'); setUploadedFiles([]); setActiveFileIndex(0); }}>
                            {t('galleryAnnulla')}
                        </Btn>
                    )}
                </div>
            </div>

            <AnimatePresence mode="wait">
                {/* Step: Gallery */}
                {step === 'gallery' && (
                    <motion.div key="gallery" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-5">
                        {/*
                          I VIDEO IN LAVORAZIONE STANNO SOPRA LA GRIGLIA, E NON È UNA
                          QUESTIONE DI ORDINE. Un video che si sta preparando NON è in
                          galleria: metterlo dentro la griglia lo farebbe sembrare
                          pubblicato — cioè già visto dalle famiglie — mentre è ancora
                          niente. Sopra, e con la sua scheda, dice le due cose che
                          servono: a che punto è, e che si può chiudere l'app.

                          Sta nello step «galleria» perché è lì che si torna dopo aver
                          premuto «Pubblica», ed è lì che si rientra riaprendo l'app.
                        */}
                        <VideoInLavorazione
                            righe={videoGalleria.righe}
                            onPubblica={videoGalleria.pubblica}
                            onRiprendi={videoGalleria.riprendi}
                            onRimuovi={videoGalleria.rimuovi}
                            renderTagger={(jobId) => (
                                <StudentTagger
                                    students={students}
                                    selectedIds={videoGalleria.tagDi(jobId)}
                                    onToggle={(studentId) => videoGalleria.cambiaTag(jobId, studentId)}
                                    onSelectAll={() => {
                                        // «Tutti» = tutti quelli CON liberatoria: la stessa
                                        // regola dello step 2, e la stessa di `StudentTagger`,
                                        // che senza consenso apre il ramo della foto privata.
                                        for (const s of students) {
                                            if (s.consenso_privacy && !videoGalleria.tagDi(jobId).includes(s.id)) {
                                                videoGalleria.cambiaTag(jobId, s.id);
                                            }
                                        }
                                    }}
                                    onDeselectAll={() => {
                                        for (const id of videoGalleria.tagDi(jobId)) videoGalleria.cambiaTag(jobId, id);
                                    }}
                                />
                            )}
                        />
                        {loading ? (
                            <div className="flex flex-col items-center justify-center py-20 gap-3">
                                <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                                <p className="font-maven text-sm text-kidville-muted">{t('galleryCaricamento')}</p>
                            </div>
                        ) : (
                            /* `scaricabile`: il solo «Scarica» (card e visore) anche per i
                               docenti — non `showActions`, che porterebbe Condividi e
                               «Segnala», gesti del genitore. */
                            <MediaGrid items={media} scaricabile onDelete={handleDeleteMedia} students={students} onUpdateTags={handleUpdateTags} />
                        )}
                    </motion.div>
                )}

                {/* Step: Upload */}
                {step === 'upload' && (
                    <motion.div key="upload" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                        className="mt-5 rounded-3xl border border-kidville-line bg-white shadow-sm p-5">
                        <h2 className="font-barlow font-bold text-base text-kidville-green uppercase tracking-wide mb-4">
                            {t('galleryStep1')}
                        </h2>
                        <MediaUploader onUpload={handleUploadFiles} />
                    </motion.div>
                )}

                {/* Step: Tag */}
                {step === 'tag' && (
                    <motion.div key="tag" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                        className="mt-5 space-y-4">
                        {/* Preview delle foto selezionate */}
                        <div className="rounded-3xl border border-kidville-line bg-white shadow-sm p-5">
                            <div className="flex items-center gap-2 mb-3">
                                <Tag size={14} className="text-kidville-green" strokeWidth={1.5} />
                                <h2 className="font-barlow font-bold text-base text-kidville-green uppercase tracking-wide">
                                    {t('galleryStep2')}
                                </h2>
                            </div>
                            
                            {/* Griglia miniature per caricamento multiplo */}
                            <div className="flex gap-2.5 mb-4 overflow-x-auto pb-2">
                                {uploadedFiles.map((f, i) => (
                                    <div 
                                        key={i} 
                                        onClick={() => setActiveFileIndex(i)}
                                        className={`relative w-16 h-16 sm:w-20 sm:h-20 rounded-2xl overflow-hidden flex-shrink-0 bg-kidville-cream cursor-pointer transition-all ${
                                            activeFileIndex === i 
                                                ? 'ring-4 ring-kidville-green scale-95 shadow-md' 
                                                : 'opacity-65 hover:opacity-100 border border-kidville-line'
                                        }`}
                                    >
                                        {/* Un video si guarda con `<video>`: era la SECONDA
                                            delle tre copie che rendevano un MP4 dentro un
                                            `<img>`, cioè il glifo del file rotto.
                                            `solo-icona` perché qui la tessella è di 64 px (80
                                            solo da `sm:`, cioè su nessun telefono) e il badge
                                            dello stato dei tag sta in basso a destra: la
                                            pastiglia intera arriverebbe a ~52 px e il badge
                                            comincia fra ~43 e ~50, quindi gli ultimi pixel
                                            della parola finirebbero sotto un fondo opaco.
                                            Con `solo-icona` la pastiglia scende a ~20 px e la
                                            parola resta per chi usa uno screen reader. */}
                                        <AnteprimaMedia file={f.file} src={f.preview} etichetta="solo-icona" />

                                        {/*
                                          QUI C'ERA LO SPINNER «Converto…» PER FILE, e con V11
                                          non ha più niente da segnalare: la conversione non
                                          avviene più sul telefono. L'attesa che resta — quella
                                          vera, di minuti — vive nella scheda «Video in
                                          preparazione» dello step galleria, che si vede anche
                                          dopo aver chiuso e riaperto l'app. Una rotellina su
                                          una miniatura non poteva farlo.
                                        */}

                                        {/* Badge stato tag */}
                                        <div className="absolute bottom-1 right-1 flex gap-0.5 pointer-events-none select-none">
                                            {f.is_broadcast ? (
                                                <span className="bg-kidville-yellow text-kidville-green text-[8px] sm:text-[9px] font-bold px-1 rounded uppercase">G</span>
                                            ) : f.tag_students.length > 0 ? (
                                                <span className="bg-kidville-green text-white text-[8px] sm:text-[9px] font-bold px-1.5 py-0.5 rounded-full">
                                                    {f.tag_students.length}
                                                </span>
                                            ) : (
                                                <span className="bg-kidville-error text-white text-[8px] sm:text-[9px] font-bold px-1 rounded uppercase">!</span>
                                            )}
                                        </div>

                                        {/*
                                          LA X — allo step 2 non c'era NESSUN modo di togliere
                                          un file. 28 px (sopra il minimo di 24×24 di WCAG
                                          2.5.8) e non 32 come nella griglia dello step 1:
                                          qui la tessella è di 64 px e il resto della sua
                                          superficie serve a SELEZIONARLA, quindi il bersaglio
                                          della rimozione non deve mangiarsela.
                                          `stopPropagation` perché la tessella intera è un
                                          comando: senza, togliere un file cambierebbe anche
                                          la foto in configurazione.
                                          Spenta durante il caricamento: il ciclo di
                                          `handleConfirmUpload` sta scorrendo QUESTO elenco, e
                                          togliergli una voce sotto i piedi sposterebbe gli
                                          indici di tutte quelle che lo seguono.
                                          Sta in fondo alla tessella di proposito: i badge
                                          sopra si trovano per `.absolute` in ordine di
                                          documento, e infilarsi prima di loro li renderebbe
                                          irraggiungibili a chi li cerca così.
                                          Il fondo è `kidville-ink/90` e non `/70`: le velature
                                          scure adoperate in `src/` sono censite dal lock
                                          `__tests__/a11y/` §5.3 col loro contrasto misurato, e
                                          `/70` era una variante nuova che lo faceva diventare
                                          rosso. `/90` è già in tabella — e copre di più, che
                                          per una X che «non si vedeva» è la direzione giusta.
                                        */}
                                        <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); rimuoviFileSelezionato(i); }}
                                            disabled={uploading}
                                            aria-label={tShared('galleryRimuoviFile')}
                                            className="absolute top-1 right-1 h-7 w-7 rounded-full bg-kidville-ink/90 text-kidville-white flex items-center justify-center touch-manipulation active:scale-95 transition-transform disabled:opacity-40"
                                        >
                                            <X size={14} strokeWidth={2.25} />
                                        </button>
                                    </div>
                                ))}
                            </div>

                            {/* Informazioni foto in configurazione e tasto applica a tutte */}
                            {activeFile && (
                                <div className="mb-4 p-3 bg-kidville-cream/35 border border-kidville-green/10 rounded-2xl flex items-center justify-between gap-4">
                                    <div className="flex items-center gap-2.5 min-w-0">
                                        <div className="relative w-10 h-10 rounded-xl overflow-hidden bg-kidville-cream flex-shrink-0">
                                            {/* La TERZA copia dello stesso difetto. Qui la
                                                pastiglia si spegne: su 40 px coprirebbe
                                                l'anteprima invece di descriverla, e il tipo di
                                                file è già detto dalla miniatura selezionata. */}
                                            <AnteprimaMedia file={activeFile.file} src={activeFile.preview} etichetta="nessuna" />
                                        </div>
                                        <div className="min-w-0">
                                            <p className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">
                                                {t('galleryFotoNofM', { index: activeFileIndex + 1, totale: uploadedFiles.length })}
                                            </p>
                                            <p className="font-maven text-[10px] text-kidville-muted truncate">
                                                {activeFile.file.name}
                                            </p>
                                        </div>
                                    </div>
                                    
                                    {uploadedFiles.length > 1 && (daRiempire > 0 || giaConfigurate > 0) && (
                                        <button
                                            type="button"
                                            onClick={handleApplyToAll}
                                            className="px-3.5 py-1.5 bg-kidville-yellow/20 hover:bg-kidville-yellow hover:scale-[1.02] text-kidville-green font-barlow font-bold text-[10px] uppercase rounded-full tracking-wide transition-all shadow-sm flex-shrink-0 cursor-pointer"
                                        >
                                            {/* L'etichetta DICE quante foto toccherà: si legge prima di premere. */}
                                            {daRiempire > 0
                                                ? t('galleryApplicaAlleAltre', { n: daRiempire })
                                                : t('galleryApplicaSostituisci')}
                                        </button>
                                    )}
                                </div>
                            )}

                            {/* Opzione Broadcast (solo coordinatori/admin) */}
                            {['admin', 'coordinator'].includes(userRole) && (
                                <div className="flex items-center gap-2.5 mb-4 p-3 bg-kidville-cream/35 rounded-2xl border border-kidville-green/10">
                                    <input 
                                        type="checkbox" 
                                        id="broadcast"
                                        checked={activeIsBroadcast} 
                                        onChange={(e) => handleToggleBroadcast(e.target.checked)}
                                        className="w-4 h-4 text-kidville-green focus:ring-kidville-green rounded border-kidville-line"
                                    />
                                    <label htmlFor="broadcast" className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide cursor-pointer select-none">
                                        {t('galleryBroadcastLabel')}
                                    </label>
                                </div>
                            )}

                            {activeIsBroadcast ? (
                                <div className="p-4 bg-kidville-cream/50 rounded-2xl text-xs text-kidville-green leading-relaxed">
                                    {t.rich('galleryBroadcastInfo', { sezione, strong: (c) => <strong>{c}</strong> })}
                                </div>
                            ) : (
                                <StudentTagger 
                                    students={students} 
                                    selectedIds={activeTags}
                                    onToggle={handleToggleTag} 
                                    onSelectAll={handleSelectAllTags}
                                    onDeselectAll={handleDeselectAllTags} 
                                />
                            )}
                        </div>

                        {/* Confirm button */}
                        <button 
                            onClick={handleConfirmUpload} 
                            disabled={uploading || uploadedFiles.some(f => !f.is_broadcast && f.tag_students.length === 0)}
                            className="w-full py-3.5 rounded-2xl bg-kidville-green text-kidville-yellow font-barlow font-black text-lg uppercase tracking-wide hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-kidville-green/20"
                        >
                            {/* Una sola etichetta: da V11 questo bottone non aspetta più
                                nessuna conversione — apre gli intenti, elabora le foto e
                                lascia. L'attesa lunga sta nella scheda dei video. */}
                            {uploading ? <><div className="w-5 h-5 border-2 border-kidville-yellow/40 border-t-kidville-yellow rounded-full animate-spin" /> {t('galleryCaricamentoUpload')}</>
                                : <><Upload size={16} strokeWidth={1.5} /> {t('galleryPubblica', { count: uploadedFiles.length })}</>}
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

export default function TeacherGalleryPage() {
    return (
        <Suspense fallback={
            <div className="max-w-3xl mx-auto p-4 sm:p-6 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
            </div>
        }>
            <TeacherGalleryContent />
        </Suspense>
    );
}
