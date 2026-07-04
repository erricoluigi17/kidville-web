'use client';

import { motion } from 'framer-motion';
import { Eye, ThumbsUp, ThumbsDown, Clock, ChevronDown, Users, Pencil, Trash2, Megaphone, ClipboardList } from 'lucide-react';
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
    onEdit?: (avviso: Avviso) => void;
    onDelete?: (avvisoId: string) => void;
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

// Badge di stato in stile DR (AvvisoRow).
function statusBadge(opts: { isAdesione: boolean; isRead: boolean; myAnswer?: string | null; isTeacher?: boolean }) {
    const { isAdesione, isRead, myAnswer, isTeacher } = opts;
    if (isTeacher) {
        return isAdesione
            ? { txt: 'Conferma adesione', cls: 'bg-kidville-yellow text-kidville-green' }
            : { txt: 'Comunicazione', cls: 'bg-kidville-info-soft text-kidville-info' };
    }
    if (isAdesione) {
        if (myAnswer === 'si') return { txt: 'Hai aderito', cls: 'bg-kidville-success-soft text-kidville-success' };
        if (myAnswer === 'no') return { txt: 'Non aderisci', cls: 'bg-kidville-error-soft text-kidville-error' };
        return { txt: 'Richiede adesione', cls: 'bg-kidville-yellow text-kidville-green' };
    }
    return isRead
        ? { txt: 'Letto', cls: 'bg-kidville-neutral-soft text-kidville-muted' }
        : { txt: 'Da leggere', cls: 'bg-kidville-green-soft text-kidville-green' };
}

export function AvvisoCard({ avviso, index, isTeacher, onReadReceipt, onAdesione, onShowDetails, onEdit, onDelete }: Props) {
    const [expanded, setExpanded] = useState(false);
    const isAdesione = avviso.tipo === 'adesione';
    const isRead = !!avviso.my_response?.letto_il;
    const myAnswer = avviso.my_response?.risposta;
    const isExpired = avviso.scadenza && new Date(avviso.scadenza) < new Date();
    const unread = !isRead && !isTeacher;
    const badge = statusBadge({ isAdesione, isRead, myAnswer, isTeacher });

    // Decodifica allegato (JSON o link semplice)
    let fileUrl = null;
    let linkUrl = null;
    if (avviso.attachment_url) {
        if (avviso.attachment_url.startsWith('{')) {
            try {
                const parsed = JSON.parse(avviso.attachment_url);
                fileUrl = parsed.file;
                linkUrl = parsed.link;
            } catch {
                fileUrl = avviso.attachment_url;
            }
        } else {
            fileUrl = avviso.attachment_url;
        }
    }

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
            className={`overflow-hidden rounded-3xl border bg-kidville-white shadow-sm transition-all ${
                unread ? 'border-kidville-yellow/60' : 'border-kidville-line'
            }`}
        >
            {/* Header */}
            <button
                onClick={handleExpand}
                className="flex w-full items-start gap-3 px-5 py-4 text-left"
            >
                {/* Icon */}
                <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl ${
                    isAdesione ? 'bg-kidville-yellow-soft text-kidville-yellow-dark' : 'bg-kidville-green-soft text-kidville-green'
                }`}>
                    {isAdesione ? <ClipboardList size={19} strokeWidth={1.8} /> : <Megaphone size={19} strokeWidth={1.8} />}
                </div>

                <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-barlow text-[10px] font-bold uppercase tracking-wide ${badge.cls}`}>
                            {badge.txt}
                        </span>
                        <span className="flex-shrink-0 font-maven text-[11px] text-kidville-muted">{timeAgo(avviso.created_at)}</span>
                    </div>
                    <h3 className="mt-1.5 truncate font-barlow text-base font-extrabold uppercase leading-tight tracking-wide text-kidville-green">
                        {avviso.titolo}
                    </h3>
                    <p className="mt-0.5 font-maven text-[11px] text-kidville-muted">
                        {avviso.author.first_name} {avviso.author.last_name}
                        {avviso.target_scope === 'classe' && avviso.target_classes && (
                            <span> · {avviso.target_classes.join(', ')}</span>
                        )}
                    </p>
                </div>

                <motion.div
                    animate={{ rotate: expanded ? 180 : 0 }}
                    transition={{ duration: 0.2 }}
                    className="mt-1 flex-shrink-0"
                >
                    <ChevronDown size={16} className="text-kidville-muted" strokeWidth={1.8} />
                </motion.div>
            </button>

            {/* Expanded content */}
            {expanded && (
                <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    transition={{ duration: 0.25 }}
                    className="border-t border-kidville-line"
                >
                    {/* Contenuto */}
                    <div className="px-5 py-4">
                        <p className="whitespace-pre-wrap font-maven text-sm leading-relaxed text-[#55615c]">
                            {avviso.contenuto}
                        </p>

                        {/* Scadenza */}
                        {avviso.scadenza && (
                            <div className={`mt-3 flex items-center gap-2 rounded-xl border px-3 py-2 font-maven text-xs ${
                                isExpired
                                    ? 'border-kidville-error/20 bg-kidville-error-soft text-kidville-error'
                                    : 'border-kidville-warn/20 bg-kidville-warn-soft text-kidville-warn'
                            }`}>
                                <Clock size={12} strokeWidth={1.8} />
                                {isExpired ? 'Scaduto il' : 'Scadenza:'}{' '}
                                {new Date(avviso.scadenza).toLocaleDateString('it-IT', {
                                    day: 'numeric', month: 'long', year: 'numeric'
                                })}
                            </div>
                        )}

                        {/* Allegati e Link */}
                        {(fileUrl || linkUrl) && (
                            <div className="mt-3 flex flex-wrap gap-2">
                                {fileUrl && (
                                    <a
                                        href={fileUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1.5 rounded-xl border border-kidville-line bg-kidville-cream px-3 py-2 font-maven text-xs font-semibold text-kidville-green transition-colors hover:bg-kidville-cream-dark"
                                    >
                                        📎 Allegato File
                                    </a>
                                )}
                                {linkUrl && (
                                    <a
                                        href={linkUrl.startsWith('http') ? linkUrl : `https://${linkUrl}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1.5 rounded-xl border border-kidville-line bg-kidville-cream px-3 py-2 font-maven text-xs font-semibold text-kidville-info transition-colors hover:bg-kidville-cream-dark"
                                    >
                                        🔗 Link Esterno
                                    </a>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Azioni genitore (adesione) */}
                    {!isTeacher && isAdesione && !isExpired && !myAnswer && (
                        <div className="flex gap-2 px-5 pb-4">
                            <button
                                onClick={() => onAdesione?.(avviso.id, 'si')}
                                className="flex flex-1 items-center justify-center gap-2 rounded-pill bg-kidville-green py-2.5 font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-yellow transition-all hover:bg-kidville-green-dark active:scale-[0.98]"
                            >
                                <ThumbsUp size={14} strokeWidth={2} /> Aderisco
                            </button>
                            <button
                                onClick={() => onAdesione?.(avviso.id, 'no')}
                                className="flex flex-1 items-center justify-center gap-2 rounded-pill bg-kidville-green-soft py-2.5 font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-green transition-all hover:bg-kidville-cream-dark active:scale-[0.98]"
                            >
                                <ThumbsDown size={14} strokeWidth={2} /> Non aderisco
                            </button>
                        </div>
                    )}

                    {/* Stato risposta genitore */}
                    {!isTeacher && myAnswer && (
                        <div className="px-5 pb-4">
                            <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 font-maven text-xs ${
                                myAnswer === 'si'
                                    ? 'border-kidville-success/20 bg-kidville-success-soft text-kidville-success'
                                    : 'border-kidville-neutral/20 bg-kidville-neutral-soft text-kidville-muted'
                            }`}>
                                {myAnswer === 'si' ? <ThumbsUp size={12} strokeWidth={1.8} /> : <ThumbsDown size={12} strokeWidth={1.8} />}
                                {myAnswer === 'si' ? 'Hai aderito ✓' : 'Hai declinato'}
                            </div>
                        </div>
                    )}

                    {/* Stats e Azioni per insegnante */}
                    {isTeacher && (
                        <div className="flex flex-wrap items-center gap-4 border-t border-kidville-line px-5 pb-4 pt-3">
                            <div className="flex items-center gap-1.5 font-maven text-xs text-kidville-muted">
                                <Eye size={12} strokeWidth={1.8} />
                                <span>{avviso.stats.letti} hanno letto</span>
                            </div>
                            {isAdesione && (
                                <>
                                    <div className="flex items-center gap-1.5 font-maven text-xs text-kidville-success">
                                        <ThumbsUp size={12} strokeWidth={1.8} />
                                        <span>{avviso.stats.adesioni_si}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 font-maven text-xs text-kidville-muted">
                                        <ThumbsDown size={12} strokeWidth={1.8} />
                                        <span>{avviso.stats.adesioni_no}</span>
                                    </div>
                                </>
                            )}
                            <div className="ml-auto flex items-center gap-3">
                                <button
                                    onClick={() => onShowDetails?.(avviso)}
                                    className="flex items-center gap-1 font-maven text-xs font-bold text-kidville-green hover:underline"
                                >
                                    <Users size={12} strokeWidth={1.8} /> Dettaglio
                                </button>
                                <button
                                    onClick={() => onEdit?.(avviso)}
                                    className="flex items-center gap-1 font-maven text-xs font-bold text-kidville-info hover:underline"
                                >
                                    <Pencil size={12} strokeWidth={1.8} /> Modifica
                                </button>
                                <button
                                    onClick={() => onDelete?.(avviso.id)}
                                    className="flex items-center gap-1 font-maven text-xs font-bold text-kidville-error hover:underline"
                                >
                                    <Trash2 size={12} strokeWidth={1.8} /> Elimina
                                </button>
                            </div>
                        </div>
                    )}
                </motion.div>
            )}
        </motion.div>
    );
}
