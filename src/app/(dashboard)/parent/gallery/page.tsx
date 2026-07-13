'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ImageOff, Info } from 'lucide-react';
import { MediaGrid, MediaItem } from '@/components/features/gallery/MediaGrid';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { Btn } from '@/components/ui/Btn';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';

// Identità dalla sessione (URL → localStorage → /api/me), senza fallback demo (M4).
function ParentGalleryContent() {
    const { parentId, studentId, ready } = useParentIdentity();

    const [media, setMedia] = useState<MediaItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [studentName, setStudentName] = useState<string | null>(null);
    const [totalCount, setTotalCount] = useState(0);

    const LIMIT = 12;

    const loadMedia = useCallback(async (currentOffset: number, append: boolean) => {
        if (!ready || !studentId) return; // identità non risolta: lo spinner resta
        try {
            let url = `/api/gallery?studentId=${studentId}&limit=${LIMIT}&offset=${currentOffset}`;
            if (parentId) url += `&parentId=${parentId}`;

            // La GET galleria è gated: identità anche via header (oltre alla sessione).
            const res = await fetch(url, parentId ? { headers: { 'x-user-id': parentId } } : undefined).catch(() => null);
            if (res?.ok) {
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
        } finally {
            setLoading(false);
            setLoadingMore(false);
        }
    }, [ready, studentId, parentId]);

    useEffect(() => {
        loadMedia(0, false);
    }, [loadMedia]);

    const handleLoadMore = () => {
        setLoadingMore(true);
        // L'offset successivo è derivato da quanto già caricato (niente stato offset).
        loadMedia(media.length, true);
    };

    useEffect(() => {
        if (!studentId) return;
        fetch(`/api/diary/students?id=${studentId}`)
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (d?.nome) setStudentName(`${d.nome} ${d.cognome ?? ''}`.trim()); })
            .catch(() => {});
    }, [studentId]);

    return (
        <div className="px-4 pt-5 pb-24">
            <PageHeaderCard
                eyebrow="Momenti"
                title="Le mie foto"
                subtitle={
                    <>
                        {studentName ? `Le foto di ${studentName} a scuola` : 'Foto dalla scuola'} 🌈
                        {totalCount > 0 && (
                            <> · {totalCount} {totalCount === 1 ? 'foto' : 'foto'} disponibil{totalCount === 1 ? 'e' : 'i'}</>
                        )}
                    </>
                }
                action={studentName ? (
                    <div className="flex items-center gap-2 rounded-pill bg-white/15 py-1 pl-1 pr-3">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-kidville-yellow font-barlow text-xs font-extrabold text-kidville-green">
                            {studentName.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()}
                        </span>
                        <span className="min-w-0">
                            <span className="block truncate font-barlow text-xs font-extrabold uppercase leading-none text-white">{studentName}</span>
                        </span>
                    </div>
                ) : undefined}
                className="mb-6"
            />

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
                        <p className="font-maven text-sm text-kidville-muted">Caricamento foto...</p>
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
                                <p className="font-maven text-xs text-kidville-muted mt-1">
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
                        <Btn
                            variant="ghost"
                            size="md"
                            className="w-full"
                            onClick={handleLoadMore}
                            disabled={loadingMore}
                        >
                            {loadingMore ? (
                                <><div className="w-4 h-4 border-2 border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" /> Caricamento...</>
                            ) : (
                                <><ChevronDown className="w-4 h-4" /> Carica Altre Foto</>
                            )}
                        </Btn>
                    )}
                </motion.div>
            )}

            {/* Info banner privacy (DR FotoScreen) */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.6 }}
                className="mt-8 flex items-start gap-3 rounded-[18px] bg-kidville-green-soft p-4"
            >
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[12px] bg-kidville-white text-kidville-green">
                    <Info size={18} />
                </span>
                <p className="font-maven text-[12.5px] leading-snug text-kidville-green/80">
                    Trovi solo le foto in cui {studentName ?? 'il tuo bambino'} è taggato/a. Sono visibili ai
                    genitori della sezione e restano disponibili per 14 giorni; puoi scaricarle e condividerle.
                </p>
            </motion.div>
        </div>
    );
}

export default function ParentGalleryPage() {
    return (
        <Suspense fallback={
            <div className="px-4 pt-5 pb-24 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
            </div>
        }>
            <ParentGalleryContent />
        </Suspense>
    );
}
