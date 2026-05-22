'use client';

import { motion } from 'framer-motion';
import { Eye, ThumbsUp, ThumbsDown, Clock, ChevronDown, Users } from 'lucide-react';
import { useState } from 'react';

export interface Avviso {
    id: string;
    author_id: string;
    titolo: string;
    contenuto: string;
    tipo: string; // 'presa_visione' | 'adesione'
    target_scope: string;
    target_classes: string[] | null;
    scadenza: string | null;
    attachment_url: string | null;
    created_at: string;
    author: { first_name: string; last_name: string; role: string };
    stats: { letti: number; adesioni_si: number; adesioni_no: number };
    my_response?: { letto_il: string | null; risposta: string | null; risposto_il: string | null } | null;
}

interface Props {
    avviso: Avviso;
    index: number;
    isTeacher?: boolean;
    onReadReceipt?: (avvisoId: string) => void;
    onAdesione?: (avvisoId: string, risposta: 'si' | 'no') => void;
    onShowDetails?: (avviso: Avviso) => void;
}

function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Adesso';
    if (mins < 60) return `${mins}m fa`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h fa`;
    const days = Math.floor(hrs / 24);
    return `${days}g fa`;
}

export function AvvisoCard({ avviso, index, isTeacher, onReadReceipt, onAdesione, onShowDetails }: Props) {
    const [expanded, setExpanded] = useState(false);
    const isAdesione = avviso.tipo === 'adesione';
    const isRead = !!avviso.my_response?.letto_il;
    const myAnswer = avviso.my_response?.risposta;
    const isExpired = avviso.scadenza && new Date(avviso.scadenza) < new Date();

    const handleExpand = () => {
        setExpanded(v => !v);
        if (!isRead && onReadReceipt) {
            onReadReceipt(avviso.id);
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05, duration: 0.3 }}
            className={`bg-white/80 backdrop-blur-xl rounded-3xl border shadow-sm overflow-hidden transition-all ${
                !isRead && !isTeacher
                    ? 'border-kidville-yellow/60 ring-1 ring-kidville-yellow/30'
                    : 'border-white/40'
            }`}
        >
            {/* Header */}
            <button
                onClick={handleExpand}
                className="w-full flex items-start gap-3 px-5 py-4 text-left"
            >
                {/* Icon */}
                <div className={`w-10 h-10 rounded-2xl flex items-center justify-center flex-shrink-0 text-lg ${
                    isAdesione
                        ? 'bg-purple-50 border border-purple-100'
                        : 'bg-blue-50 border border-blue-100'
                }`}>
                    {isAdesione ? '📋' : '📢'}
                </div>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-barlow font-bold text-sm text-kidville-green uppercase tracking-wide truncate">
                            {avviso.titolo}
                        </h3>
                        {!isRead && !isTeacher && (
                            <span className="px-2 py-0.5 bg-kidville-yellow text-kidville-green font-barlow font-bold text-[10px] rounded-full uppercase flex-shrink-0">
                                Nuovo
                            </span>
                        )}
                    </div>
                    <p className="font-maven text-xs text-gray-400">
                        {avviso.author.first_name} {avviso.author.last_name} • {timeAgo(avviso.created_at)}
                        {avviso.target_scope === 'classe' && avviso.target_classes && (
                            <span> • {avviso.target_classes.join(', ')}</span>
                        )}
                    </p>
                </div>

                <motion.div
                    animate={{ rotate: expanded ? 180 : 0 }}
                    transition={{ duration: 0.2 }}
                    className="mt-1 flex-shrink-0"
                >
                    <ChevronDown size={16} className="text-gray-400" strokeWidth={1.5} />
                </motion.div>
            </button>

            {/* Expanded content */}
            {expanded && (
                <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    transition={{ duration: 0.25 }}
                    className="border-t border-gray-100/60"
                >
                    {/* Contenuto */}
                    <div className="px-5 py-4">
                        <p className="font-maven text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
                            {avviso.contenuto}
                        </p>

                        {/* Scadenza */}
                        {avviso.scadenza && (
                            <div className={`mt-3 flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-maven ${
                                isExpired
                                    ? 'bg-red-50 text-red-600 border border-red-100'
                                    : 'bg-amber-50 text-amber-600 border border-amber-100'
                            }`}>
                                <Clock size={12} strokeWidth={1.5} />
                                {isExpired ? 'Scaduto il' : 'Scadenza:'}{' '}
                                {new Date(avviso.scadenza).toLocaleDateString('it-IT', {
                                    day: 'numeric', month: 'long', year: 'numeric'
                                })}
                            </div>
                        )}

                        {/* Attachment */}
                        {avviso.attachment_url && (
                            <div className="mt-3">
                                <a
                                    href={avviso.attachment_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-xl text-xs font-maven text-kidville-green hover:bg-gray-100 transition-colors"
                                >
                                    📎 Allegato
                                </a>
                            </div>
                        )}
                    </div>

                    {/* Azioni genitore (adesione) */}
                    {!isTeacher && isAdesione && !isExpired && !myAnswer && (
                        <div className="px-5 pb-4 flex gap-2">
                            <button
                                onClick={() => onAdesione?.(avviso.id, 'si')}
                                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-emerald-500 text-white font-maven font-semibold text-sm rounded-2xl hover:bg-emerald-600 active:scale-[0.98] transition-all"
                            >
                                <ThumbsUp size={14} strokeWidth={1.5} /> Sì, aderisco
                            </button>
                            <button
                                onClick={() => onAdesione?.(avviso.id, 'no')}
                                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-gray-200 text-gray-600 font-maven font-semibold text-sm rounded-2xl hover:bg-gray-300 active:scale-[0.98] transition-all"
                            >
                                <ThumbsDown size={14} strokeWidth={1.5} /> No
                            </button>
                        </div>
                    )}

                    {/* Stato risposta genitore */}
                    {!isTeacher && myAnswer && (
                        <div className="px-5 pb-4">
                            <div className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-maven ${
                                myAnswer === 'si'
                                    ? 'bg-emerald-50 text-emerald-600 border border-emerald-100'
                                    : 'bg-gray-100 text-gray-500 border border-gray-200'
                            }`}>
                                {myAnswer === 'si' ? <ThumbsUp size={12} strokeWidth={1.5} /> : <ThumbsDown size={12} strokeWidth={1.5} />}
                                {myAnswer === 'si' ? 'Hai aderito ✓' : 'Hai declinato'}
                            </div>
                        </div>
                    )}

                    {/* Stats per insegnante */}
                    {isTeacher && (
                        <div className="px-5 pb-4 flex items-center gap-4">
                            <div className="flex items-center gap-1.5 text-xs font-maven text-gray-500">
                                <Eye size={12} strokeWidth={1.5} />
                                <span>{avviso.stats.letti} hanno letto</span>
                            </div>
                            {isAdesione && (
                                <>
                                    <div className="flex items-center gap-1.5 text-xs font-maven text-emerald-600">
                                        <ThumbsUp size={12} strokeWidth={1.5} />
                                        <span>{avviso.stats.adesioni_si}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 text-xs font-maven text-gray-400">
                                        <ThumbsDown size={12} strokeWidth={1.5} />
                                        <span>{avviso.stats.adesioni_no}</span>
                                    </div>
                                </>
                            )}
                            <button
                                onClick={() => onShowDetails?.(avviso)}
                                className="ml-auto flex items-center gap-1.5 text-xs font-maven text-kidville-green hover:underline"
                            >
                                <Users size={12} strokeWidth={1.5} /> Dettaglio
                            </button>
                        </div>
                    )}
                </motion.div>
            )}
        </motion.div>
    );
}
