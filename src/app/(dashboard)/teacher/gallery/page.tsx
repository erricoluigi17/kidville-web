'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, Tag } from 'lucide-react';
import { MediaGrid, MediaItem } from '@/components/features/gallery/MediaGrid';
import { MediaUploader } from '@/components/features/gallery/MediaUploader';
import { StudentTagger } from '@/components/features/gallery/StudentTagger';

const TEACHER_ID = '22222222-2222-2222-2222-222222222222';
const SEZIONE = 'Girasoli';

interface Student {
    id: string;
    nome: string;
    cognome: string;
    consenso_privacy: boolean;
}

type Step = 'gallery' | 'upload' | 'tag';

export default function TeacherGalleryPage() {
    const [media, setMedia] = useState<MediaItem[]>([]);
    const [students, setStudents] = useState<Student[]>([]);
    const [loading, setLoading] = useState(true);
    const [step, setStep] = useState<Step>('gallery');
    const [uploadedFiles, setUploadedFiles] = useState<{ file: File; preview: string }[]>([]);
    const [taggedIds, setTaggedIds] = useState<string[]>([]);
    const [uploading, setUploading] = useState(false);

    const loadMedia = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/gallery');
            if (res.ok) {
                const data = await res.json();
                setMedia(data.media ?? []);
            }
        } catch (err) {
            console.error('Errore caricamento media:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    const loadStudents = useCallback(async () => {
        try {
            const res = await fetch(`/api/diary/students?sezione=${SEZIONE}`);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) {
                    setStudents(data.map((s: { id: string; nome: string; cognome: string; consenso_privacy?: boolean }) => ({
                        id: s.id, nome: s.nome, cognome: s.cognome,
                        consenso_privacy: s.consenso_privacy !== false, // default true per dev
                    })));
                }
            }
        } catch (err) {
            console.error('Errore caricamento studenti:', err);
        }
    }, []);

    useEffect(() => { loadMedia(); loadStudents(); }, [loadMedia, loadStudents]);

    const handleUploadFiles = (files: { file: File; preview: string }[]) => {
        setUploadedFiles(files);
        setStep('tag');
    };

    const handleToggleTag = (studentId: string) => {
        setTaggedIds(prev => prev.includes(studentId) ? prev.filter(id => id !== studentId) : [...prev, studentId]);
    };

    const handleSelectAllTags = () => {
        setTaggedIds(students.filter(s => s.consenso_privacy).map(s => s.id));
    };

    const handleConfirmUpload = async () => {
        setUploading(true);
        try {
            // Per ogni file, crea un record nella galleria
            // In produzione: prima upload su Supabase Storage, poi salva URL
            for (const f of uploadedFiles) {
                // Placeholder URL per dev (in prod useremo Supabase Storage)
                const placeholderUrl = f.preview || `https://picsum.photos/800/600?random=${Date.now()}`;

                await fetch('/api/gallery', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        uploaded_by: TEACHER_ID,
                        file_url: placeholderUrl,
                        file_type: f.file.type.startsWith('video/') ? 'video' : 'foto',
                        caption: f.file.name,
                        tag_students: taggedIds,
                    }),
                });
            }

            await loadMedia();
            setStep('gallery');
            setUploadedFiles([]);
            setTaggedIds([]);
        } catch (err) {
            console.error('Errore upload:', err);
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="max-w-3xl mx-auto p-4 sm:p-6 pb-32">
            {/* Header */}
            <div className="flex items-start justify-between mb-6">
                <div>
                    <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase tracking-wide">
                        📸 Galleria
                    </h1>
                    <p className="font-maven text-gray-500 mt-1">Foto e video della classe</p>
                </div>
                {step === 'gallery' && (
                    <button onClick={() => setStep('upload')}
                        className="flex items-center gap-2 px-4 py-2.5 bg-kidville-green text-kidville-yellow font-barlow font-bold text-sm uppercase rounded-2xl hover:opacity-90 active:scale-[0.98] transition-all shadow-lg shadow-kidville-green/20">
                        <Upload size={16} strokeWidth={1.5} /> Carica
                    </button>
                )}
                {step !== 'gallery' && (
                    <button onClick={() => { setStep('gallery'); setUploadedFiles([]); setTaggedIds([]); }}
                        className="px-4 py-2.5 bg-gray-100 text-gray-600 font-maven font-semibold text-sm rounded-2xl hover:bg-gray-200 transition-all">
                        Annulla
                    </button>
                )}
            </div>

            <AnimatePresence mode="wait">
                {/* Step: Gallery */}
                {step === 'gallery' && (
                    <motion.div key="gallery" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                        {loading ? (
                            <div className="flex flex-col items-center justify-center py-20 gap-3">
                                <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                                <p className="font-maven text-sm text-gray-400">Caricamento galleria...</p>
                            </div>
                        ) : (
                            <MediaGrid items={media} />
                        )}
                    </motion.div>
                )}

                {/* Step: Upload */}
                {step === 'upload' && (
                    <motion.div key="upload" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                        className="bg-white/80 backdrop-blur-xl rounded-3xl border border-white/40 shadow-sm p-5">
                        <h2 className="font-barlow font-bold text-base text-kidville-green uppercase tracking-wide mb-4">
                            1. Seleziona foto e video
                        </h2>
                        <MediaUploader onUpload={handleUploadFiles} />
                    </motion.div>
                )}

                {/* Step: Tag */}
                {step === 'tag' && (
                    <motion.div key="tag" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                        className="space-y-4">
                        {/* Preview delle foto selezionate */}
                        <div className="bg-white/80 backdrop-blur-xl rounded-3xl border border-white/40 shadow-sm p-5">
                            <div className="flex items-center gap-2 mb-3">
                                <Tag size={14} className="text-kidville-green" strokeWidth={1.5} />
                                <h2 className="font-barlow font-bold text-base text-kidville-green uppercase tracking-wide">
                                    2. Tagga i bambini
                                </h2>
                            </div>
                            <div className="flex gap-2 mb-4 overflow-x-auto pb-2">
                                {uploadedFiles.map((f, i) => (
                                    <div key={i} className="w-16 h-16 rounded-xl overflow-hidden flex-shrink-0 bg-gray-100">
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={f.preview} alt="" className="w-full h-full object-cover" />
                                    </div>
                                ))}
                            </div>
                            <StudentTagger students={students} selectedIds={taggedIds}
                                onToggle={handleToggleTag} onSelectAll={handleSelectAllTags}
                                onDeselectAll={() => setTaggedIds([])} />
                        </div>

                        {/* Confirm button */}
                        <button onClick={handleConfirmUpload} disabled={uploading || taggedIds.length === 0}
                            className="w-full py-3.5 rounded-2xl bg-kidville-green text-kidville-yellow font-barlow font-black text-lg uppercase tracking-wide hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-kidville-green/20">
                            {uploading ? <><div className="w-5 h-5 border-2 border-kidville-yellow/40 border-t-kidville-yellow rounded-full animate-spin" /> Caricamento...</>
                                : <><Upload size={16} strokeWidth={1.5} /> Pubblica {uploadedFiles.length} foto</>}
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
