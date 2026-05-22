'use client';

import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Check, CheckCheck } from 'lucide-react';

export interface ChatMessage {
    id: string;
    thread_id: string;
    sender_id: string;
    content: string;
    attachment_url: string | null;
    attachment_type: string | null;
    read_at: string | null;
    created_at: string;
}

interface Props {
    messages: ChatMessage[];
    currentUserId: string;
    otherUserName: string;
    loading?: boolean;
}

function formatMessageTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

function formatMessageDate(iso: string): string {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);

    if (d.toDateString() === today.toDateString()) return 'Oggi';
    if (d.toDateString() === yesterday.toDateString()) return 'Ieri';
    return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' });
}

function groupByDate(messages: ChatMessage[]): { date: string; messages: ChatMessage[] }[] {
    const groups: { date: string; messages: ChatMessage[] }[] = [];
    let currentDate = '';

    messages.forEach(msg => {
        const date = formatMessageDate(msg.created_at);
        if (date !== currentDate) {
            currentDate = date;
            groups.push({ date, messages: [] });
        }
        groups[groups.length - 1].messages.push(msg);
    });

    return groups;
}

export function ChatMessageArea({ messages, currentUserId, otherUserName, loading }: Props) {
    const bottomRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages.length]);

    if (loading) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                    <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                    <p className="font-maven text-sm text-gray-400">Caricamento messaggi...</p>
                </div>
            </div>
        );
    }

    if (messages.length === 0) {
        return (
            <div className="flex-1 flex items-center justify-center px-4">
                <div className="text-center">
                    <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">
                        💬
                    </div>
                    <p className="font-barlow font-bold text-lg text-kidville-green uppercase mb-1">
                        Inizia la conversazione
                    </p>
                    <p className="font-maven text-sm text-gray-400 max-w-xs">
                        Scrivi un messaggio a {otherUserName}
                    </p>
                </div>
            </div>
        );
    }

    const groups = groupByDate(messages);

    return (
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            {groups.map((group) => (
                <div key={group.date}>
                    {/* Date separator */}
                    <div className="flex items-center gap-3 my-4">
                        <div className="flex-1 h-px bg-gray-200/60" />
                        <span className="font-maven text-[11px] text-gray-400 px-2">{group.date}</span>
                        <div className="flex-1 h-px bg-gray-200/60" />
                    </div>

                    {/* Messages */}
                    <div className="space-y-1.5">
                        {group.messages.map((msg, idx) => {
                            const isMine = msg.sender_id === currentUserId;

                            return (
                                <motion.div
                                    key={msg.id}
                                    initial={{ opacity: 0, y: 8, scale: 0.97 }}
                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                    transition={{ delay: idx * 0.02, duration: 0.2 }}
                                    className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}
                                >
                                    <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 shadow-sm ${
                                        isMine
                                            ? 'bg-kidville-green text-white rounded-br-md'
                                            : 'bg-white/90 backdrop-blur-sm border border-white/40 text-gray-800 rounded-bl-md'
                                    }`}>
                                        {/* Attachment preview */}
                                        {msg.attachment_url && msg.attachment_type === 'image' && (
                                            <div className="mb-2 rounded-xl overflow-hidden">
                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                <img
                                                    src={msg.attachment_url}
                                                    alt="Allegato"
                                                    className="w-full h-auto max-h-48 object-cover"
                                                />
                                            </div>
                                        )}
                                        {msg.attachment_url && msg.attachment_type === 'document' && (
                                            <div className={`mb-2 px-3 py-2 rounded-xl text-xs font-maven flex items-center gap-2 ${
                                                isMine ? 'bg-white/20' : 'bg-gray-100'
                                            }`}>
                                                📎 Documento allegato
                                            </div>
                                        )}

                                        {/* Text */}
                                        <p className={`font-maven text-sm leading-relaxed ${
                                            isMine ? 'text-white' : 'text-gray-800'
                                        }`}>
                                            {msg.content}
                                        </p>

                                        {/* Time + read status */}
                                        <div className={`flex items-center gap-1 mt-1 ${
                                            isMine ? 'justify-end' : 'justify-start'
                                        }`}>
                                            <span className={`font-maven text-[10px] ${
                                                isMine ? 'text-white/60' : 'text-gray-400'
                                            }`}>
                                                {formatMessageTime(msg.created_at)}
                                            </span>
                                            {isMine && (
                                                msg.read_at
                                                    ? <CheckCheck size={12} className="text-blue-300" strokeWidth={1.5} />
                                                    : <Check size={12} className="text-white/40" strokeWidth={1.5} />
                                            )}
                                        </div>
                                    </div>
                                </motion.div>
                            );
                        })}
                    </div>
                </div>
            ))}
            <div ref={bottomRef} />
        </div>
    );
}
