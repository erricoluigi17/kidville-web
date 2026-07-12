'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { MessageSquare } from 'lucide-react';

export interface ChatThread {
    id: string;
    teacher_id: string;
    parent_id: string;
    student_id: string;
    last_message_at: string;
    other_user: { first_name: string; last_name: string; role: string };
    student: { nome: string; cognome: string; classe_sezione: string };
    last_message: { content: string; sender_id: string; created_at: string } | null;
    unread_count: number;
}

interface Props {
    threads: ChatThread[];
    selectedId: string | null;
    currentUserId: string;
    onSelect: (thread: ChatThread) => void;
}

function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'ora';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}g`;
}

export function ChatThreadList({ threads, selectedId, currentUserId, onSelect }: Props) {
    if (threads.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
                <div className="w-16 h-16 bg-kidville-cream rounded-full flex items-center justify-center mb-4">
                    <MessageSquare size={24} className="text-kidville-green" strokeWidth={1.5} />
                </div>
                <p className="font-barlow font-bold text-base text-kidville-green uppercase mb-1">Nessuna chat</p>
                <p className="font-maven text-sm text-kidville-muted">Le conversazioni appariranno qui</p>
            </div>
        );
    }

    return (
        <div className="divide-y divide-kidville-line/70">
            {threads.map((thread, idx) => {
                const isSelected = thread.id === selectedId;
                const hasUnread = thread.unread_count > 0;
                const initials = `${thread.other_user.first_name[0]}${thread.other_user.last_name[0]}`.toUpperCase();
                const preview = thread.last_message
                    ? thread.last_message.sender_id === currentUserId
                        ? `Tu: ${thread.last_message.content}`
                        : thread.last_message.content
                    : 'Nessun messaggio';

                return (
                    <motion.button
                        key={thread.id}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.03, duration: 0.2 }}
                        onClick={() => onSelect(thread)}
                        className={`
                            w-full flex items-center gap-3 px-3.5 py-3.5 text-left
                            transition-all duration-200
                            hover:bg-kidville-cream/40
                            ${isSelected ? 'bg-kidville-cream/60' : ''}
                            ${hasUnread && !isSelected ? 'bg-kidville-yellow-soft/50 border-l-2 border-kidville-yellow' : 'border-l-2 border-transparent'}
                        `}
                    >
                        {/* Avatar (design chat: disco 48 con iniziali Barlow 800) */}
                        <div className={`w-12 h-12 rounded-full flex items-center justify-center font-barlow font-extrabold text-[17px] flex-shrink-0 ${
                            thread.other_user.role === 'parent'
                                ? 'bg-kidville-warn text-white'
                                : 'bg-kidville-green text-kidville-yellow'
                        }`}>
                            {initials}
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                            <div className="flex items-baseline justify-between gap-2">
                                <p className="truncate font-barlow text-[15px] font-extrabold uppercase leading-tight text-kidville-green">
                                    {thread.other_user.first_name} {thread.other_user.last_name}
                                </p>
                                {thread.last_message && (
                                    <span className="flex-shrink-0 font-maven text-[11px] text-kidville-muted">
                                        {timeAgo(thread.last_message.created_at)}
                                    </span>
                                )}
                            </div>
                            <p className="mt-0.5 truncate font-maven text-[10.5px] text-kidville-muted">
                                {thread.student.nome} · {thread.student.classe_sezione}
                            </p>
                            <div className="mt-0.5 flex items-center justify-between gap-2">
                                <p className={`flex-1 truncate font-maven text-[12.5px] ${
                                    hasUnread ? 'font-bold text-kidville-ink' : 'text-kidville-sub'
                                }`}>
                                    {preview.slice(0, 48)}
                                    {preview.length > 48 ? '…' : ''}
                                </p>

                                {/* Badge non letti (design: giallo/verde, mai rosso) */}
                                <AnimatePresence>
                                    {hasUnread && (
                                        <motion.span
                                            initial={{ scale: 0, opacity: 0 }}
                                            animate={{ scale: 1, opacity: 1 }}
                                            exit={{ scale: 0, opacity: 0 }}
                                            transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                                            className="flex h-5 min-w-[20px] flex-shrink-0 items-center justify-center rounded-pill bg-kidville-yellow px-1.5 font-barlow text-[11px] font-extrabold text-kidville-green"
                                        >
                                            {thread.unread_count > 9 ? '9+' : thread.unread_count}
                                        </motion.span>
                                    )}
                                </AnimatePresence>
                            </div>
                        </div>
                    </motion.button>
                );
            })}
        </div>
    );
}
