'use client';

import { motion } from 'framer-motion';
import { Download, Share2, Play } from 'lucide-react';
import { useState } from 'react';

export interface MediaItem {
    id: string;
    file_url: string;
    file_type: string;
    caption: string | null;
    tag_students: string[];
    is_broadcast: boolean;
    created_at: string;
    uploader_name: string;
}

interface Props {
    items: MediaItem[];
    showActions?: boolean; // Download/Share per genitore
    onDelete?: (id: string) => void; // Solo admin
}

function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const hrs = Math.floor(diff / 3600000);
    if (hrs < 1) return 'Ora';
    if (hrs < 24) return `${hrs}h fa`;
    const days = Math.floor(hrs / 24);
    return `${days}g fa`;
}

export function MediaGrid({ items, showActions, onDelete }: Props) {
    const [lightbox, setLightbox] = useState<MediaItem | null>(null);

    if (items.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mb-4 text-4xl">📷</div>
                <p className="font-barlow font-bold text-lg text-kidville-green uppercase mb-1">Nessuna foto</p>
                <p className="font-maven text-sm text-gray-400">Le foto appariranno qui quando verranno caricate</p>
            </div>
        );
    }

    return (
        <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {items.map((item, idx) => (
                    <motion.div
                        key={item.id}
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: idx * 0.04, duration: 0.25 }}
                        className="relative group aspect-square rounded-2xl overflow-hidden bg-gray-100 cursor-pointer shadow-sm border border-white/40"
                        onClick={() => setLightbox(item)}
                    >
                        {item.file_type === 'video' ? (
                            <div className="w-full h-full bg-gray-800 flex items-center justify-center">
                                <Play size={32} className="text-white/80" strokeWidth={1.5} />
                            </div>
                        ) : (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img src={item.file_url} alt={item.caption ?? 'Foto'} className="w-full h-full object-cover" />
                        )}

                        {/* Overlay on hover */}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                            <div className="absolute bottom-0 left-0 right-0 p-3">
                                <p className="font-maven text-xs text-white/90 truncate">{item.caption ?? ''}</p>
                                <p className="font-maven text-[10px] text-white/60">{item.uploader_name} • {timeAgo(item.created_at)}</p>
                            </div>
                        </div>

                        {/* Broadcast badge */}
                        {item.is_broadcast && (
                            <div className="absolute top-2 left-2 px-2 py-0.5 bg-kidville-yellow text-kidville-green font-barlow font-bold text-[9px] rounded-full uppercase">
                                Generale
                            </div>
                        )}
                    </motion.div>
                ))}
            </div>

            {/* Lightbox */}
            {lightbox && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="fixed inset-0 bg-black/90 z-50 flex flex-col items-center justify-center p-4"
                    onClick={() => setLightbox(null)}
                >
                    <div className="relative max-w-2xl w-full max-h-[80vh]" onClick={e => e.stopPropagation()}>
                        {lightbox.file_type === 'video' ? (
                            <video src={lightbox.file_url} controls className="w-full max-h-[70vh] rounded-2xl" />
                        ) : (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img src={lightbox.file_url} alt={lightbox.caption ?? 'Foto'}
                                className="w-full max-h-[70vh] object-contain rounded-2xl" />
                        )}

                        {/* Caption */}
                        {lightbox.caption && (
                            <p className="font-maven text-sm text-white/80 text-center mt-3">{lightbox.caption}</p>
                        )}

                        {/* Actions */}
                        {showActions && (
                            <div className="flex items-center justify-center gap-3 mt-4">
                                <a href={lightbox.file_url} download
                                    className="flex items-center gap-2 px-4 py-2 bg-white/20 backdrop-blur-sm text-white rounded-xl font-maven text-sm hover:bg-white/30 transition-colors">
                                    <Download size={14} strokeWidth={1.5} /> Scarica
                                </a>
                                <button
                                    onClick={() => {
                                        if (navigator.share) {
                                            navigator.share({ url: lightbox.file_url, title: lightbox.caption ?? 'Foto da Kidville' });
                                        }
                                    }}
                                    className="flex items-center gap-2 px-4 py-2 bg-white/20 backdrop-blur-sm text-white rounded-xl font-maven text-sm hover:bg-white/30 transition-colors">
                                    <Share2 size={14} strokeWidth={1.5} /> Condividi
                                </button>
                            </div>
                        )}

                        {/* Delete (admin) */}
                        {onDelete && (
                            <button onClick={() => { onDelete(lightbox.id); setLightbox(null); }}
                                className="mt-3 mx-auto block px-4 py-2 bg-red-500/80 text-white rounded-xl font-maven text-sm hover:bg-red-600 transition-colors">
                                🗑️ Elimina
                            </button>
                        )}
                    </div>

                    {/* Close button */}
                    <button onClick={() => setLightbox(null)}
                        className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/20 backdrop-blur-sm text-white flex items-center justify-center hover:bg-white/30 transition-colors">
                        ✕
                    </button>
                </motion.div>
            )}
        </>
    );
}
