'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, Tag, WifiOff, X } from 'lucide-react';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { Btn } from '@/components/ui/Btn';
import { MediaGrid, MediaItem } from '@/components/features/gallery/MediaGrid';
import { erroreElimina, statoDaRigetto } from '@/components/features/gallery/DialogoEliminaMedia';
import { MediaUploader } from '@/components/features/gallery/MediaUploader';
import { AnteprimaMedia } from '@/components/features/gallery/AnteprimaMedia';
import { StudentTagger } from '@/components/features/gallery/StudentTagger';
import { saveLocalGalleryMedia, syncPendingGalleryMedia } from '@/lib/offline/syncEngine';
import { processImageWithWatermark, validateVideoFile, processVideoWithWatermark, ImageProcessingError, type MotivoVideoNonValido } from '@/lib/media/processing';
import { analizzaContenutoVideo } from '@/lib/media/codec-sniff';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { applicaTagATutte, fotoDaConfigurare, fotoGiaConfigurate } from '@/lib/gallery/applica-tag';
import { caricaMediaGalleria, messaggioCaricamento } from '@/lib/gallery/carica-media';
import { messaggioErrore, messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { formattaMegabyte } from '@/lib/i18n/numero';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { useOnlineStatus } from '@/lib/hooks/use-online-status';

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
    // La lingua dell'INTERFACCIA (cookie `KV_LOCALE`), non quella del runtime:
    // serve a formattare i numeri che finiscono dentro le frasi qui sotto.
    const locale = useLocale();
    const { userId: teacherId } = useSessionIdentity();

    /**
     * Il motivo per cui un video è stato rifiutato, nella lingua dell'interfaccia.
     *
     * La DECISIONE resta in `validateVideoFile` (una sola, condivisa con chiunque
     * altro la usi); qui si sceglie solo come DIRLA. Prima si mostrava `val.error`,
     * che quella libreria costruisce in italiano perché gira anche sul server: con
     * l'interfaccia in inglese era prosa italiana a schermo, come il 403 dei tag.
     * `val.error` resta il ripiego per un motivo che il catalogo ancora non
     * conosce: meglio una frase nella lingua sbagliata che nessuna frase.
     */
    const motivoVideoNonValido = (
        codice: MotivoVideoNonValido | undefined,
        file: File,
        ripiego: string | undefined,
    ): string => {
        if (codice === 'formato-non-supportato') {
            return t('galleryAlertVideoFormatoNonSupportato', { tipo: file.type || '—' });
        }
        if (codice === 'file-troppo-grande') {
            // La dimensione arriva GIÀ FORMATTATA, unità compresa: `MB` è un
            // simbolo invariante e — come gli importi in euro — non entra nella
            // frase come parola separata (cfr. il lock `messaggi-plurali-e-glossario`,
            // che su «{n} parola» chiede la forma ICU plurale, qui fuori luogo).
            //
            // ⚠️ E il SEPARATORE decimale segue la lingua dell'INTERFACCIA, non
            // quella del runtime. Qui c'era `toLocaleString(undefined, …)`, che
            // `undefined` lo risolve sul sistema operativo di chi guarda (o sul
            // processo, lato server): con interfaccia inglese su un browser
            // italiano usciva «50,3 MB» dentro una frase inglese. Stesso difetto
            // delle date, stessa medicina: il locale è un parametro.
            return t('galleryAlertVideoOltreIlLimite', { dimensione: formattaMegabyte(file.size, locale) });
        }
        return ripiego ?? t('galleryErrCaricamentoGenerico');
    };

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
    // Indice del file in conversione video (per lo spinner PER FILE): la conversione dura
    // ~quanto il video, quindi va segnalata sulla miniatura giusta, non con un solo spinner.
    const [convertingIndex, setConvertingIndex] = useState<number | null>(null);
    const [userRole, setUserRole] = useState<string>('educator');
    // SSR-safe (niente hydration mismatch né setState-in-effect).
    const isOnline = useOnlineStatus();

    // Sezione reale da /api/educator-sections: init vuoto, mai hardcoded
    // (i loader sono guardati da `if (!sezione) return`).
    const [sezione, setSezione] = useState<string>('');
    const [availableSections, setAvailableSections] = useState<string[]>([]);

    const loadMedia = useCallback(async () => {
        // La GET galleria è gated: serve l'identità (sessione o header).
        if (!sezione || !teacherId) return;
        try {
            // Seleziona media per la sezione del docente
            const res = await fetch(`/api/gallery?classe=${sezione}`, {
                headers: { 'x-user-id': teacherId },
            }).catch(() => null);
            if (res?.ok) {
                const data = await res.json().catch(() => null);
                setMedia(data?.media ?? []);
            }
        } finally {
            setLoading(false);
        }
    }, [sezione, teacherId]);

    const loadStudents = useCallback(async () => {
        if (!sezione) return;
        try {
            const res = await fetch(`/api/diary/students?sezione=${sezione}`).catch(() => null);
            if (res?.ok) {
                const data = await res.json().catch(() => null);
                if (Array.isArray(data)) {
                    setStudents(data.map((s: { id: string; nome: string; cognome: string; consenso_privacy?: boolean; parents?: Student['parents'] }) => ({
                        id: s.id,
                        nome: s.nome,
                        cognome: s.cognome,
                        consenso_privacy: s.consenso_privacy !== false,
                        parents: s.parents || [],
                    })));
                }
            }
        } finally {
            // Nessuno stato di loading dedicato: l'errore di rete lascia lo stato invariato.
        }
    }, [sezione]);

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

    // Quando è (ri)online, sincronizza i media salvati offline.
    useEffect(() => {
        if (isOnline) {
            syncPendingGalleryMedia().then(() => loadMedia()).catch(() => {});
        }
    }, [isOnline, loadMedia]);

    // Carica ruolo utente corrente (via /api/me gated, niente lettura anon di `utenti`)
    useEffect(() => {
        const fetchUserRole = async () => {
            if (!teacherId) return;
            try {
                const res = await fetch('/api/me', { headers: { 'x-user-id': teacherId } });
                if (!res.ok) return;
                const me = await res.json().catch(() => null);
                const ruolo = me?.ruolo ?? me?.role;
                if (ruolo) setUserRole(ruolo);
            } catch {
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'gallery-ruolo-fallito', route: '/teacher/gallery' });
            }
        };
        fetchUserRole();
    }, [teacherId]);

    useEffect(() => {
        loadMedia();
        loadStudents();
    }, [loadMedia, loadStudents]);

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
        if (!teacherId) return;
        setUploading(true);
        try {
            const offlineMode = !isOnline;

            for (let i = 0; i < uploadedFiles.length; i++) {
                const f = uploadedFiles[i];
                let processedFile = f.file;
                const isVideo = f.file.type.startsWith('video/');
                if (isVideo) {
                    const MAX_SIZE = 50 * 1024 * 1024; // 50MB

                    // Sniff del codec/container sui primi 64KB: da iPhone parte HEVC/.mov, che
                    // Chrome/Android non decodificano. Se serve, la conversione è OBBLIGATORIA.
                    const testa = await f.file.slice(0, 65536).arrayBuffer().catch(() => null);
                    const analisi = testa
                        ? analizzaContenutoVideo(testa, f.file.type)
                        : { daConvertire: true, motivo: 'header-illeggibile' };

                    if (analisi.daConvertire) {
                        // Un video da convertire NON si accoda mai alla coda offline: la conversione
                        // richiede il dispositivo attivo e il server ne verifica il codec al caricamento.
                        if (offlineMode) {
                            alert(t('galleryAlertVideoOffline', { nome: f.file.name }));
                            continue;
                        }

                        setConvertingIndex(i);
                        let videoFile: File;
                        try {
                            videoFile = await processVideoWithWatermark(f.file, '/watermark.png', MAX_SIZE, { obbligatoria: true });
                        } catch {
                            // Conversione impossibile su questo dispositivo: messaggio azionabile e
                            // SKIP del file (gli altri file del batch proseguono). Nessun log con PII.
                            logClient({ livello: 'warn', evento: 'js', messaggio: 'gallery-video-conversione-fallita', route: '/teacher/gallery', stato: 415 });
                            // Il testo di `MESSAGGIO_VIDEO_NON_CONVERTIBILE` vive in una
                            // libreria condivisa client+server e nasce italiano: qui il
                            // locale c'è, quindi si mostra la frase del catalogo.
                            alert(t('galleryAlertVideoNonConvertibile'));
                            continue;
                        } finally {
                            setConvertingIndex(null);
                        }

                        const val = validateVideoFile(videoFile);
                        if (!val.valid) {
                            alert(motivoVideoNonValido(val.codice, videoFile, val.error));
                            continue;
                        }
                        processedFile = videoFile;
                    } else {
                        // Già riproducibile (H.264/webm): watermark + compressione, con fallback
                        // all'originale ammesso (il codec è già compatibile).
                        if (f.file.size > MAX_SIZE) {
                            // Il gemello del messaggio qui sopra, e con lo stesso
                            // difetto al contrario: qui il locale era CABLATO a
                            // `it-IT`, quindi l'interfaccia inglese leggeva «50,3».
                            // `unita: false` perché questa frase il «MB» ce l'ha
                            // già scritto dentro, in tutti e due i cataloghi.
                            alert(t('galleryAlertVideoTroppoGrande', {
                                nome: f.file.name,
                                dimensione: formattaMegabyte(f.file.size, locale, { unita: false }),
                            }));
                        }
                        setConvertingIndex(i);
                        let videoFile: File;
                        try {
                            videoFile = await processVideoWithWatermark(f.file, '/watermark.png', MAX_SIZE);
                        } finally {
                            setConvertingIndex(null);
                        }

                        const val = validateVideoFile(videoFile);
                        if (!val.valid) {
                            alert(motivoVideoNonValido(val.codice, videoFile, val.error));
                            continue;
                        }
                        processedFile = videoFile;
                    }
                } else {
                    // Ridimensionamento e Watermarking client-side
                    try {
                        processedFile = await processImageWithWatermark(f.file, '/watermark.png');
                    } catch (e) {
                        // ⚠️ `continue`, NON un'eccezione che esce dal ciclo — ed è la stessa
                        // cosa che il ramo video fa venti righe più sopra. Da quando
                        // `processImageWithWatermark` RIFIUTA una tela degenere invece di
                        // pubblicare un file da 775 byte, questo `await` può lanciare; e il
                        // `try` che lo avvolgeva è quello aperto PRIMA del `for`, col `catch`
                        // dopo la sua chiusura. Su cinque foto con la seconda degenere,
                        // l'insegnante vedeva l'avviso di UNA foto e le foto 3, 4 e 5 non
                        // venivano mai elaborate né caricate, senza che niente lo dicesse —
                        // e `setUploadedFiles([])` non veniva raggiunto, quindi un secondo
                        // tentativo ripubblicava in doppio quelle già passate.
                        //
                        // Si intercetta il SOLO rigetto deliberato: `ImageProcessingError`
                        // porta una frase italiana già pronta e senza il nome del file
                        // (`MESSAGGIO_UMANO`, `lib/media/immagini.ts`). Qualunque altro
                        // errore è un guasto inatteso e continua a salire al catch-all, che
                        // lo logga: trattarlo come «salta questa foto» nasconderebbe un bug.
                        if (e instanceof ImageProcessingError) {
                            alert(e.message);
                            continue;
                        }
                        throw e;
                    }
                }

                if (offlineMode) {
                    // Salva in locale nel DB offline
                    const localId = typeof window !== 'undefined' && window.crypto?.randomUUID 
                        ? window.crypto.randomUUID() 
                        : `local-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

                    await saveLocalGalleryMedia({
                        id: localId,
                        uploaded_by: teacherId,
                        caption: f.file.name,
                        tag_students: f.is_broadcast ? [] : f.tag_students,
                        is_broadcast: f.is_broadcast,
                        target_classes: f.is_broadcast ? [sezione] : null,
                        file_type: isVideo ? 'video' : 'foto',
                        file_blob: processedFile,
                        file_name: processedFile.name,
                        creato_il: new Date().toISOString()
                    });
                } else {
                    // CARICAMENTO DIRETTO ALLO STORAGE (firma + `PUT`), non più multipart
                    // attraverso una nostra route.
                    //
                    // ⚠️ IL MULTIPART ERA IL DIFETTO. Vercel rifiuta un corpo oltre ~4,5 MB
                    // con un 413 scritto dall'infrastruttura PRIMA che la funzione parta:
                    // nei log del server non restava niente, e qui usciva «Errore durante
                    // il caricamento del file». Misurato in `app_log` il 2026-09-07: sei
                    // volte in un giorno, e l'unico video passato pesava 4.484.198 byte,
                    // dodici kilobyte sotto il taglio. Il bucket ne accetta 50 di milioni.
                    const esito = await caricaMediaGalleria(processedFile, processedFile.type || (isVideo ? 'video/mp4' : 'image/jpeg'));
                    if (!esito.ok) {
                        throw new Error(`«${f.file.name}»: ${messaggioCaricamento(esito, t)}`);
                    }
                    const path = esito.path;

                    // Crea il record nel DB
                    const res = await fetch('/api/gallery', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-user-id': teacherId },
                        body: JSON.stringify({
                            uploaded_by: teacherId,
                            file_url: path,
                            file_type: isVideo ? 'video' : 'foto',
                            caption: f.file.name,
                            tag_students: f.is_broadcast ? [] : f.tag_students,
                            is_broadcast: f.is_broadcast,
                            target_classes: f.is_broadcast ? [sezione] : null,
                        }),
                    });

                    if (!res.ok) {
                        const errData = await res.json().catch(() => ({} as Record<string, unknown>));
                        // Il corpo si legge UNA volta sola, e qui serve due volte: per il
                        // messaggio e per `nomi`. Perciò `messaggioDaCorpo` e non
                        // `messaggioErrore` — stessa decisione, corpo già in mano.
                        const motivo = messaggioDaCorpo(errData, t('galleryErrSalvataggio'));
                        // Il 422 del Privacy Lock porta `nomi` (bambini senza liberatoria):
                        // mostriamoli così l'insegnante sa chi togliere dai tag. Restano in
                        // chiaro a schermo e SOLO lì: nei log non entrano mai (sono minori).
                        const dettagli = Array.isArray(errData.nomi) && errData.nomi.length > 0 ? ` (${(errData.nomi as string[]).join(', ')})` : '';
                        // LO STATO VIAGGIA CON L'ERRORE, il nome del file no.
                        // In `app_log` questo ramo produceva 7 righe in un giorno
                        // tutte uguali — `gallery-pubblicazione-fallita: Error`,
                        // `contesto` vuoto — perché `nomeErrore` restituisce il
                        // TIPO dell'errore e un `new Error` generico si chiama
                        // «Error» per tutti. Un 413 (file troppo grande), un 422
                        // (Privacy Lock) e un 500 collassavano nella stessa riga:
                        // sapevamo che sette foto non erano arrivate e nient'altro.
                        // Lo status è un numero, quindi passa la redazione; il
                        // messaggio contiene il nome del file — la foto di un
                        // minore — e infatti non entra nel log, oggi come prima.
                        throw Object.assign(new Error(`«${f.file.name}»: ${motivo}${dettagli}`), { stato: res.status });
                    }
                }
            }

            if (offlineMode) {
                alert(t('galleryAlertOffline'));
            } else {
                alert(t('galleryAlertPubblicati'));
            }

            await loadMedia();
            setStep('gallery');
            setUploadedFiles([]);
            setActiveFileIndex(0);
        } catch (err) {
            // Nel messaggio SOLO il TIPO dell'errore: `nomeErrore` restituisce `e.name`
            // e niente altro, mentre `e.message` porta il nome del file — cioè la foto
            // di un minore, che resterebbe trenta giorni in `app_log`. All'utente si
            // mostra il testo intero, che vive a schermo e non entra in nessuna tabella.
            //
            // Questo è il ramo CATCH-ALL, e si distingue da quelli di
            // `@/lib/gallery/carica-media` (firma, trasferimento, taglia, formato), che
            // hanno un messaggio e uno stato propri. Fino al 2026-09-07 il messaggio era
            // uno solo per tutti: la deduplicazione di `logClient` ha per chiave
            // `evento|messaggio|stato`, quindi guasti diversi collassavano in una riga
            // sola — e infatti in tabella ogni riga aveva `contesto` vuoto e nessuno
            // stato, cioè non diceva niente di ciò che era andato storto.
            const stato = (err as { stato?: unknown })?.stato;
            logClient({
                livello: 'error', evento: 'fetch', route: '/teacher/gallery',
                messaggio: `gallery-pubblicazione-fallita: ${nomeErrore(err)}`,
                // `stato` è parte della chiave di deduplicazione di `logClient`
                // (`evento|messaggio|stato`): è ciò che separa il 413 dal 422.
                ...(typeof stato === 'number' ? { stato } : {}),
            });
            alert(err instanceof Error && err.message ? err.message : t('galleryErrCaricamentoGenerico'));
        } finally {
            setUploading(false);
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
                        {loading ? (
                            <div className="flex flex-col items-center justify-center py-20 gap-3">
                                <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                                <p className="font-maven text-sm text-kidville-muted">{t('galleryCaricamento')}</p>
                            </div>
                        ) : (
                            <MediaGrid items={media} onDelete={handleDeleteMedia} students={students} onUpdateTags={handleUpdateTags} />
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

                                        {/* Spinner PER FILE durante la conversione video */}
                                        {convertingIndex === i && (
                                            <div className="absolute inset-0 bg-kidville-green/70 flex flex-col items-center justify-center gap-1" role="status" aria-live="polite">
                                                <div className="w-5 h-5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                                                <span className="text-white text-[8px] font-bold uppercase tracking-wide">{t('galleryConverto')}</span>
                                            </div>
                                        )}

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
                                          `convertingIndex` è un indice su di esso.
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
                            {uploading ? <><div className="w-5 h-5 border-2 border-kidville-yellow/40 border-t-kidville-yellow rounded-full animate-spin" /> {convertingIndex !== null ? t('galleryConversioneVideo') : t('galleryCaricamentoUpload')}</>
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
