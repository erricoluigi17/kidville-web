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
                <p className="font-maven text-sm text-gray-400">Le conversazioni appariranno qui</p>
            </div>
        );
    }

    return (
        <div className="divide-y divide-gray-100/60">
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
                            w-full flex items-center gap-3 px-4 py-3.5 text-left
                            transition-all duration-200
                            hover:bg-kidville-cream/40
                            ${isSelected ? 'bg-kidville-cream/60' : ''}
                            ${hasUnread && !isSelected ? 'bg-emerald-50/60 border-l-2 border-emerald-400/50' : 'border-l-2 border-transparent'}
                        `}
                    >
                        {/* Avatar con indicatore puntino se non letto */}
                        <div className="relative flex-shrink-0">
                            <div className={`w-11 h-11 rounded-full flex items-center justify-center font-barlow font-bold text-sm ${
                                thread.other_user.role === 'parent'
                                    ? 'bg-amber-100 text-amber-700'
                                    : 'bg-kidville-green text-kidville-yellow'
                            }`}>
                                {initials}
                            </div>
                            {/* Puntino verde "online/unread" */}
                            <AnimatePresence>
                                {hasUnread && (
                                    <motion.span
                                        initial={{ scale: 0 }}
                                        animate={{ scale: 1 }}
                                        exit={{ scale: 0 }}
                                        transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                                        className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-emerald-400 border-2 border-white"
                                    />
                                )}
                            </AnimatePresence>
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2 mb-0.5">
                                <p className={`font-maven truncate text-sm transition-all duration-300 ${
                                    hasUnread
                                        ? 'font-bold text-kidville-green'
                                        : 'font-semibold text-kidville-green'
                                }`}>
                                    {thread.other_user.first_name} {thread.other_user.last_name}
                                </p>
                                {thread.last_message && (
                                    <span className={`font-maven text-[10px] flex-shrink-0 transition-all duration-300 ${
                                        hasUnread ? 'text-emerald-500 font-semibold' : 'text-gray-400'
                                    }`}>
                                        {timeAgo(thread.last_message.created_at)}
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center justify-between gap-2">
                                <p className={`font-maven text-xs truncate flex-1 transition-all duration-300 ${
                                    hasUnread ? 'text-gray-700 font-medium' : 'text-gray-400'
                                }`}>
                                    <span className={hasUnread ? 'text-gray-600' : 'text-gray-500'}>
                                        {thread.student.nome}
                                    </span>{' '}
                                    • {preview.slice(0, 40)}
                                    {preview.length > 40 ? '...' : ''}
                                </p>

                                {/* Badge numerico non letti */}
                                <AnimatePresence>
                                    {hasUnread && (
                                        <motion.span
                                            initial={{ scale: 0, opacity: 0 }}
                                            animate={{ scale: 1, opacity: 1 }}
                                            exit={{ scale: 0, opacity: 0 }}
                                            transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                                            className="min-w-[20px] h-5 px-1.5 rounded-full bg-emerald-500 text-white font-barlow font-bold text-[10px] flex items-center justify-center flex-shrink-0 shadow-sm shadow-emerald-500/30"
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
