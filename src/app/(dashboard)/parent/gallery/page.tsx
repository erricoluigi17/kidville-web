'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Camera, Download, ChevronDown, ImageOff } from 'lucide-react';
import { MediaGrid, MediaItem } from '@/components/features/gallery/MediaGrid';
import { useSearchParams } from 'next/navigation';

function ParentGalleryContent() {
    const searchParams = useSearchParams();
    const studentId = searchParams.get('id') || 'dc617529-e80d-4084-9041-fb28e864089f';
    const parentId = searchParams.get('parentId') || null;

    const [media, setMedia] = useState<MediaItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [offset, setOffset] = useState(0);
    const [hasMore, setHasMore] = useState(true);
    const [studentName, setStudentName] = useState<string | null>(null);
    const [totalCount, setTotalCount] = useState(0);

    const LIMIT = 12;

    const loadMedia = useCallback(async (currentOffset: number, append: boolean) => {
        if (currentOffset === 0) {
            setLoading(true);
        } else {
            setLoadingMore(true);
        }

        try {
            let url = `/api/gallery?studentId=${studentId}&limit=${LIMIT}&offset=${currentOffset}`;
            if (parentId) url += `&parentId=${parentId}`;
            
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                const fetchedMedia = data.media ?? [];
                const total = data.total ?? 0;
                
                setTotalCount(total);

                if (append) {
                    setMedia(prev => {
                        const updated = [...prev, ...fetchedMedia];
                        setHasMore(updated.length < total);
                        return updated;
                    });
                } else {
                    setMedia(fetchedMedia);
                    setHasMore(fetchedMedia.length < total);
                }
            }
        } catch (err) {
            console.error('Errore caricamento media:', err);
        } finally {
            setLoading(false);
            setLoadingMore(false);
        }
    }, [studentId, parentId]);

    useEffect(() => {
        setOffset(0);
        loadMedia(0, false);
    }, [studentId, loadMedia]);

    const handleLoadMore = () => {
        const nextOffset = offset + LIMIT;
        setOffset(nextOffset);
        loadMedia(nextOffset, true);
    };

    useEffect(() => {
        fetch(`/api/diary/students?id=${studentId}`)
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (d?.nome) setStudentName(`${d.nome} ${d.cognome ?? ''}`.trim()); })
            .catch(() => {});
    }, [studentId]);

    return (
        <div className="max-w-lg mx-auto p-4 sm:p-6 pb-16">
            {/* Header con glassmorphism */}
            <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
                className="flex items-start justify-between mb-6"
            >
                <div>
                    <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase tracking-wide">
                        📸 Le mie foto
                    </h1>
                    <p className="font-maven text-gray-400 mt-1 text-sm">
                        {studentName ? `Le foto di ${studentName} a scuola` : 'Foto dalla scuola'} 🌈
                    </p>
                    {totalCount > 0 && (
                        <motion.p
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="font-maven text-xs text-kidville-green/60 mt-1"
                        >
                            {totalCount} {totalCount === 1 ? 'foto' : 'foto'} disponibil{totalCount === 1 ? 'e' : 'i'}
                        </motion.p>
                    )}
                </div>
                {studentName && (
                    <motion.div
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ delay: 0.2, type: 'spring', stiffness: 200 }}
                        className="flex items-center gap-2 bg-white rounded-full border border-kidville-green/10 shadow-sm px-3 py-2"
                    >
                        <div className="w-8 h-8 rounded-full bg-kidville-green flex items-center justify-center font-barlow font-black text-xs text-kidville-yellow">
                            {studentName.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()}
                        </div>
                        <p className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">{studentName}</p>
                    </motion.div>
                )}
            </motion.div>

            {/* Loading */}
            <AnimatePresence mode="wait">
                {loading && (
                    <motion.div
                        key="loading"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="flex flex-col items-center justify-center py-20 gap-3"
                    >
                        <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                        <p className="font-maven text-sm text-gray-400">Caricamento foto...</p>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Gallery con animazioni */}
            {!loading && (
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.1, ease: 'easeOut' }}
                    className="space-y-6"
                >
                    {media.length === 0 ? (
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            className="flex flex-col items-center justify-center py-16 gap-4 bg-white rounded-2xl border border-kidville-green/10 shadow-sm"
                        >
                            <div className="w-16 h-16 rounded-full bg-kidville-green/10 flex items-center justify-center">
                                <ImageOff className="w-8 h-8 text-kidville-green/40" />
                            </div>
                            <div className="text-center">
                                <p className="font-barlow font-bold text-kidville-green/60 text-sm uppercase tracking-wide">
                                    Nessuna foto disponibile
                                </p>
                                <p className="font-maven text-xs text-gray-400 mt-1">
                                    Le foto appariranno qui quando gli insegnanti le condivideranno
                                </p>
                            </div>
                        </motion.div>
                    ) : (
                        <div className="bg-white rounded-2xl border border-kidville-green/10 p-3 sm:p-4 shadow-sm">
                            <MediaGrid items={media} showActions />
                        </div>
                    )}

                    {hasMore && media.length > 0 && (
                        <motion.button
                            whileHover={{ scale: 1.01 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={handleLoadMore}
                            disabled={loadingMore}
                            className="w-full py-3.5 rounded-full bg-white border border-kidville-green font-barlow font-bold text-sm text-kidville-green uppercase tracking-wide hover:bg-kidville-cream/30 active:scale-[0.99] transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-sm cursor-pointer"
                        >
                            {loadingMore ? (
                                <><div className="w-4 h-4 border-2 border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" /> Caricamento...</>
                            ) : (
                                <><ChevronDown className="w-4 h-4" /> Carica Altre Foto</>
                            )}
                        </motion.button>
                    )}
                </motion.div>
            )}

            {/* Footer con glassmorphism */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.6 }}
                className="mt-8 p-4 bg-white rounded-2xl border border-kidville-green/10 text-center shadow-sm"
            >
                <p className="font-maven text-xs text-gray-450">
                    📷 Qui trovi solo le foto in cui {studentName ?? 'il tuo bambino'} è stato taggato.<br />
                    Puoi scaricarle e condividerle liberamente.
                </p>
            </motion.div>
        </div>
    );
}

export default function ParentGalleryPage() {
    return (
        <Suspense fallback={
            <div className="max-w-lg mx-auto p-4 sm:p-6 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
            </div>
        }>
            <ParentGalleryContent />
        </Suspense>
    );
}
