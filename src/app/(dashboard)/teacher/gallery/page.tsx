'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, Tag, WifiOff } from 'lucide-react';
import { MediaGrid, MediaItem } from '@/components/features/gallery/MediaGrid';
import { MediaUploader } from '@/components/features/gallery/MediaUploader';
import { StudentTagger } from '@/components/features/gallery/StudentTagger';
import { saveLocalGalleryMedia, syncPendingGalleryMedia } from '@/lib/offline/syncEngine';
import { processImageWithWatermark, validateVideoFile, processVideoWithWatermark } from '@/lib/media/processing';
import { useSearchParams } from 'next/navigation';

interface Student {
    id: string;
    nome: string;
    cognome: string;
    consenso_privacy: boolean;
    parents?: { id: string; nome: string; cognome: string; email: string }[];
}

type Step = 'gallery' | 'upload' | 'tag';

function TeacherGalleryContent() {
    const searchParams = useSearchParams();
    const teacherId = searchParams.get('userId') || '22222222-2222-2222-2222-222222222222';

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
    const [userRole, setUserRole] = useState<string>('educator');
    const [isOnline, setIsOnline] = useState(true);

    const [sezione, setSezione] = useState<string>('Girasoli');
    const [availableSections, setAvailableSections] = useState<string[]>([]);

    const loadMedia = useCallback(async () => {
        if (!sezione) return;
        setLoading(true);
        try {
            // Seleziona media per la sezione del docente
            const res = await fetch(`/api/gallery?classe=${sezione}`);
            if (res.ok) {
                const data = await res.json();
                setMedia(data.media ?? []);
            }
        } catch (err) {
            console.error('Errore caricamento media:', err);
        } finally {
            setLoading(false);
        }
    }, [sezione]);

    const loadStudents = useCallback(async () => {
        if (!sezione) return;
        try {
            const res = await fetch(`/api/diary/students?sezione=${sezione}`);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) {
                    setStudents(data.map((s: { id: string; nome: string; cognome: string; consenso_privacy?: boolean; parents?: any[] }) => ({
                        id: s.id,
                        nome: s.nome, 
                        cognome: s.cognome,
                        consenso_privacy: s.consenso_privacy !== false,
                        parents: s.parents || [],
                    })));
                }
            }
        } catch (err) {
            console.error('Errore caricamento studenti:', err);
        }
    }, [sezione]);

    // Carica sezioni educatore
    useEffect(() => {
        const fetchSections = async () => {
            try {
                const res = await fetch(`/api/educator-sections?userId=${teacherId}`);
                if (res.ok) {
                    const data = await res.json();
                    const sections = data.sectionNames ?? [];
                    setAvailableSections(sections);
                    if (sections.length > 0) {
                        setSezione(sections[0]);
                    }
                }
            } catch (err) {
                console.error('Errore caricamento sezioni educatore:', err);
            }
        };
        fetchSections();
    }, [teacherId]);

    // Gestione connettività
    useEffect(() => {
        if (typeof window !== 'undefined') {
            setIsOnline(navigator.onLine);
            const handleOnline = () => {
                setIsOnline(true);
                // Prova a sincronizzare i file in sospeso
                syncPendingGalleryMedia().then(() => loadMedia());
            };
            const handleOffline = () => setIsOnline(false);

            window.addEventListener('online', handleOnline);
            window.addEventListener('offline', handleOffline);
            return () => {
                window.removeEventListener('online', handleOnline);
                window.removeEventListener('offline', handleOffline);
            };
        }
    }, [loadMedia]);

    // Carica ruolo utente corrente (via /api/me gated, niente lettura anon di `utenti`)
    useEffect(() => {
        const fetchUserRole = async () => {
            try {
                const res = await fetch('/api/me', { headers: { 'x-user-id': teacherId } });
                if (!res.ok) return;
                const me = await res.json().catch(() => null);
                const ruolo = me?.ruolo ?? me?.role;
                if (ruolo) setUserRole(ruolo);
            } catch (err) {
                console.error('Errore fetch ruolo:', err);
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

    const handleApplyToAll = () => {
        const active = uploadedFiles[activeFileIndex];
        if (!active) return;
        setUploadedFiles(prev => prev.map(f => ({
            ...f,
            tag_students: [...active.tag_students],
            is_broadcast: active.is_broadcast
        })));
        alert('Configurazione applicata a tutte le foto del caricamento!');
    };

    const activeFile = uploadedFiles[activeFileIndex] || null;
    const activeTags = activeFile ? activeFile.tag_students : [];
    const activeIsBroadcast = activeFile ? activeFile.is_broadcast : false;

    const handleConfirmUpload = async () => {
        setUploading(true);
        try {
            const offlineMode = !isOnline;

            for (const f of uploadedFiles) {
                let processedFile = f.file;
                const isVideo = f.file.type.startsWith('video/');
                if (isVideo) {
                    let videoFile = f.file;
                    const MAX_SIZE = 50 * 1024 * 1024; // 50MB
                    if (videoFile.size > MAX_SIZE) {
                        alert(`Il video "${f.file.name}" supera i 50MB (attuale: ${(videoFile.size / (1024 * 1024)).toFixed(1)}MB). Verrà elaborato e compresso automaticamente per ridurne il peso prima del caricamento.`);
                    }

                    // Applica il watermark e la compressione (se necessaria)
                    videoFile = await processVideoWithWatermark(videoFile, '/watermark.png', MAX_SIZE);

                    // Validazione video finale
                    const val = validateVideoFile(videoFile);
                    if (!val.valid) {
                        alert(val.error);
                        continue;
                    }
                    processedFile = videoFile;
                } else {
                    // Ridimensionamento e Watermarking client-side
                    processedFile = await processImageWithWatermark(f.file, '/watermark.png');
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
                    // Caricamento online reale tramite API server-side
                    const formData = new FormData();
                    formData.append('file', processedFile);
                    formData.append('userId', teacherId);

                    const uploadRes = await fetch('/api/gallery/upload', {
                        method: 'POST',
                        body: formData
                    });

                    if (!uploadRes.ok) {
                        const uploadErrData = await uploadRes.json();
                        throw new Error(uploadErrData.error || 'Errore caricamento file su storage');
                    }

                    const { fileUrl } = await uploadRes.json();

                    // Crea il record nel DB
                    const res = await fetch('/api/gallery', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            uploaded_by: teacherId,
                            file_url: fileUrl,
                            file_type: isVideo ? 'video' : 'foto',
                            caption: f.file.name,
                            tag_students: f.is_broadcast ? [] : f.tag_students,
                            is_broadcast: f.is_broadcast,
                            target_classes: f.is_broadcast ? [sezione] : null,
                        }),
                    });

                    if (!res.ok) {
                        const errData = await res.json();
                        throw new Error(errData.error || 'Errore salvataggio metadati');
                    }
                }
            }

            if (offlineMode) {
                alert('Dispositivo offline: i media sono stati salvati in locale e verranno caricati automaticamente non appena tornerai online.');
            } else {
                alert('File caricati e pubblicati con successo!');
            }

            await loadMedia();
            setStep('gallery');
            setUploadedFiles([]);
            setActiveFileIndex(0);
        } catch (err) {
            console.error('Errore durante l\'upload:', err);
            alert('Si è verificato un errore durante il caricamento.');
        } finally {
            setUploading(false);
        }
    };

    const handleDeleteMedia = async (id: string) => {
        if (!confirm('Sei sicuro di voler eliminare questo media?')) return;
        try {
            const res = await fetch(`/api/gallery?id=${id}&userId=${teacherId}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                alert('Media eliminato con successo!');
                await loadMedia();
            } else {
                const errData = await res.json();
                alert(errData.error || 'Errore durante l\'eliminazione.');
            }
        } catch (err) {
            console.error('Errore DELETE:', err);
            alert('Errore di rete durante l\'eliminazione.');
        }
    };

    const handleUpdateTags = async (mediaId: string, newTags: string[]) => {
        try {
            const res = await fetch('/api/gallery', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: mediaId,
                    userId: teacherId,
                    tag_students: newTags
                })
            });
            if (res.ok) {
                alert('Tag aggiornati con successo!');
                await loadMedia();
            } else {
                const errData = await res.json();
                alert(errData.error || 'Errore durante l\'aggiornamento dei tag.');
            }
        } catch (err) {
            console.error('Errore update tags:', err);
            alert('Errore di rete durante l\'aggiornamento dei tag.');
        }
    };

    return (
        <div className="mx-auto max-w-[460px] px-4 pt-5">
            {/* Offline Alert Bar */}
            {!isOnline && (
                <div className="flex items-center gap-2 mb-4 p-3 bg-kidville-warn-soft border border-kidville-warn/30 text-kidville-warn rounded-2xl text-xs font-medium">
                    <WifiOff size={14} className="text-kidville-warn flex-shrink-0" />
                    <span>Sei offline. Puoi comunque caricare foto: verranno salvate in locale e caricate appena tornerai online.</span>
                </div>
            )}

            {/* Header verde (DR) */}
            <div className="rounded-3xl bg-kidville-green px-5 py-5" style={{ boxShadow: '0 16px 34px -18px rgba(0,60,52,.6)' }}>
                <p className="font-barlow text-[11px] font-bold uppercase tracking-[0.14em] text-kidville-yellow">Momenti</p>
                <h1 className="font-barlow text-3xl font-black uppercase tracking-wide text-white">Galleria</h1>
                <p className="mt-1.5 font-maven text-xs text-white/80">Foto e video della sezione {sezione}</p>
            </div>

            {/* Controlli (sezione + step) */}
            <div className="mt-3 flex flex-wrap items-center gap-3">
                {availableSections.length > 1 && (
                    <div className="flex items-center gap-2">
                        <label htmlFor="section-select" className="font-barlow font-bold text-xs text-kidville-muted uppercase tracking-wide">
                            Sezione:
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
                        <button onClick={() => setStep('upload')}
                            className="flex items-center gap-2 rounded-pill bg-kidville-green px-4 py-2.5 font-barlow text-sm font-bold uppercase text-kidville-yellow transition-all active:scale-[0.98]">
                            <Upload size={16} strokeWidth={1.5} /> Carica
                        </button>
                    )}
                    {step !== 'gallery' && (
                        <button onClick={() => { setStep('gallery'); setUploadedFiles([]); setActiveFileIndex(0); }}
                            className="rounded-pill bg-kidville-green-soft px-4 py-2.5 font-maven text-sm font-semibold text-kidville-green transition-all hover:bg-kidville-cream-dark">
                            Annulla
                        </button>
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
                                <p className="font-maven text-sm text-kidville-muted">Caricamento galleria...</p>
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
                            1. Seleziona foto e video
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
                                    2. Configura Tag e Privacy
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
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={f.preview} alt="" className="w-full h-full object-cover" />
                                        
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
                                    </div>
                                ))}
                            </div>

                            {/* Informazioni foto in configurazione e tasto applica a tutte */}
                            {activeFile && (
                                <div className="mb-4 p-3 bg-kidville-cream/35 border border-kidville-green/10 rounded-2xl flex items-center justify-between gap-4">
                                    <div className="flex items-center gap-2.5 min-w-0">
                                        <div className="w-10 h-10 rounded-xl overflow-hidden bg-kidville-cream flex-shrink-0">
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img src={activeFile.preview} alt="" className="w-full h-full object-cover" />
                                        </div>
                                        <div className="min-w-0">
                                            <p className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">
                                                Foto {activeFileIndex + 1} di {uploadedFiles.length}
                                            </p>
                                            <p className="font-maven text-[10px] text-kidville-muted truncate">
                                                {activeFile.file.name}
                                            </p>
                                        </div>
                                    </div>
                                    
                                    {uploadedFiles.length > 1 && (
                                        <button
                                            type="button"
                                            onClick={handleApplyToAll}
                                            className="px-3.5 py-1.5 bg-kidville-yellow/20 hover:bg-kidville-yellow hover:scale-[1.02] text-kidville-green font-barlow font-bold text-[10px] uppercase rounded-full tracking-wide transition-all shadow-sm flex-shrink-0 cursor-pointer"
                                        >
                                            ✨ Applica a tutte
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
                                        Caricamento in Broadcast (invia a tutta la classe)
                                    </label>
                                </div>
                            )}

                            {activeIsBroadcast ? (
                                <div className="p-4 bg-kidville-cream/50 rounded-2xl text-xs text-kidville-green leading-relaxed">
                                    📢 <strong>Caricamento Generale:</strong> I media saranno mostrati in bacheca a tutti i genitori degli alunni iscritti nella sezione <strong>{sezione}</strong>, senza tag individuali.
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
                            {uploading ? <><div className="w-5 h-5 border-2 border-kidville-yellow/40 border-t-kidville-yellow rounded-full animate-spin" /> Caricamento...</>
                                : <><Upload size={16} strokeWidth={1.5} /> Pubblica {uploadedFiles.length} {uploadedFiles.length === 1 ? 'file' : 'file'}</>}
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
