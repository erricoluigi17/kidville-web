'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { MediaGrid, MediaItem } from '@/components/features/gallery/MediaGrid';
import { useSearchParams } from 'next/navigation';

function ParentGalleryContent() {
    const searchParams = useSearchParams();
    const studentId = searchParams.get('id') || 'dc617529-e80d-4084-9041-fb28e864089f';

    const [media, setMedia] = useState<MediaItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [studentName, setStudentName] = useState<string | null>(null);

    const loadMedia = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/gallery?studentId=${studentId}`);
            if (res.ok) {
                const data = await res.json();
                setMedia(data.media ?? []);
            }
        } catch (err) {
            console.error('Errore caricamento media:', err);
        } finally {
            setLoading(false);
        }
    }, [studentId]);

    useEffect(() => { loadMedia(); }, [loadMedia]);

    // Carica nome studente
    useEffect(() => {
        fetch(`/api/diary/students?id=${studentId}`)
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (d?.nome) setStudentName(`${d.nome} ${d.cognome ?? ''}`.trim()); })
            .catch(() => {});
    }, [studentId]);

    return (
        <div className="max-w-lg mx-auto p-4 sm:p-6 pb-16">
            {/* Header */}
            <div className="flex items-start justify-between mb-6">
                <div>
                    <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase tracking-wide">
                        📸 Le mie foto
                    </h1>
                    <p className="font-maven text-gray-400 mt-1 text-sm">
                        {studentName ? `Le foto di ${studentName} a scuola` : 'Foto dalla scuola'} 🌈
                    </p>
                </div>
                {studentName && (
                    <div className="flex items-center gap-2 bg-white/80 backdrop-blur-xl rounded-2xl border border-white/40 shadow-sm px-3 py-2">
                        <div className="w-8 h-8 rounded-full bg-kidville-green flex items-center justify-center font-barlow font-black text-xs text-kidville-yellow">
                            {studentName.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()}
                        </div>
                        <p className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">{studentName}</p>
                    </div>
                )}
            </div>

            {/* Loading */}
            {loading && (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                    <p className="font-maven text-sm text-gray-400">Caricamento foto...</p>
                </div>
            )}

            {/* Gallery */}
            {!loading && <MediaGrid items={media} showActions />}

            {/* Footer */}
            <div className="mt-8 p-4 bg-white/50 backdrop-blur-sm rounded-2xl border border-white/30 text-center">
                <p className="font-maven text-xs text-gray-400">
                    📷 Qui trovi solo le foto in cui {studentName ?? 'il tuo bambino'} è stato taggato.<br />
                    Puoi scaricarle e condividerle liberamente.
                </p>
            </div>
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
