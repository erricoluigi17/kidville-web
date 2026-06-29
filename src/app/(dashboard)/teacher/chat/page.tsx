'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, MessageSquare, Plus, X, UserPlus } from 'lucide-react';
import { ChatThreadList, ChatThread } from '@/components/features/chat/ChatThreadList';
import { ChatMessageArea, ChatMessage } from '@/components/features/chat/ChatMessageArea';
import { ChatInput } from '@/components/features/chat/ChatInput';
import { useUnreadNotifications } from '@/components/features/chat/useUnreadNotifications';
import { useChatRealtime } from '@/components/features/chat/useChatRealtime';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

interface Contact {
    user_id: string;
    user_name: string;
    user_role: string;
    student_id: string;
    student_name: string;
    sezione: string;
}

function TeacherChatContent() {
    const searchParams = useSearchParams();
    const teacherId = searchParams.get('userId') || '22222222-2222-2222-2222-222222222222';

    const [threads, setThreads] = useState<ChatThread[]>([]);
    const [selectedThread, setSelectedThread] = useState<ChatThread | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMessages, setLoadingMessages] = useState(false);
    const [showMobile, setShowMobile] = useState<'list' | 'chat'>('list');
    const [showNewChat, setShowNewChat] = useState(false);
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [loadingContacts, setLoadingContacts] = useState(false);
    const [unreadCount, setUnreadCount] = useState(0);
    // ID del primo messaggio non letto: bloccato all'apertura del thread
    const [firstUnreadId, setFirstUnreadId] = useState<string | null>(null);

    // Ref stabile per selectedThread (evita re-render nei callback realtime)
    const selectedThreadRef = useRef<ChatThread | null>(null);
    useEffect(() => { selectedThreadRef.current = selectedThread; }, [selectedThread]);

    // Notifiche non letti + badge titolo pagina (mantenuto come fallback)
    useUnreadNotifications({
        userId: teacherId,
        enabled: true,
        onUnreadChange: setUnreadCount,
        pollInterval: 30000, // ridotto a 30s ora che c'è il realtime
    });

    // Carica thread
    const loadThreads = useCallback(async () => {
        try {
            const res = await fetch(`/api/chat/threads?userId=${teacherId}`);
            if (res.ok) setThreads(await res.json());
        } catch (err) {
            console.error('Errore caricamento thread:', err);
        } finally {
            setLoading(false);
        }
    }, [teacherId]);

    useEffect(() => { loadThreads(); }, [loadThreads]);

    // Carica contatti disponibili
    const loadContacts = useCallback(async () => {
        setLoadingContacts(true);
        try {
            const res = await fetch(`/api/chat/contacts?userId=${teacherId}`);
            if (res.ok) {
                const data = await res.json();
                setContacts(data.contacts ?? []);
            }
        } catch (err) {
            console.error('Errore caricamento contatti:', err);
        } finally {
            setLoadingContacts(false);
        }
    }, [teacherId]);

    const loadMessages = useCallback(async (threadId: string) => {
        setLoadingMessages(true);
        try {
            const res = await fetch(`/api/chat/messages?threadId=${threadId}`);
            if (res.ok) {
                const data = await res.json();
                const msgs: ChatMessage[] = data.messages ?? [];
                setMessages(msgs);
                const firstUnread = msgs.find(
                    m => m.sender_id !== teacherId && m.read_at === null
                );
                setFirstUnreadId(firstUnread?.id ?? null);
            }
        } catch (err) {
            console.error('Errore caricamento messaggi:', err);
        } finally {
            setLoadingMessages(false);
        }
    }, [teacherId]);

    // ── Realtime: nuovo messaggio nel thread attivo ──────────────────────
    const handleRealtimeNewMessage = useCallback((msg: ChatMessage) => {
        setMessages(prev => {
            if (prev.some(m => m.id === msg.id)) return prev;
            return [...prev, msg];
        });
        // Segna subito come letto (il thread è aperto)
        fetch('/api/chat/messages/read', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageIds: [msg.id], userId: teacherId }),
        }).catch(() => {/* silenzioso */});
    }, [teacherId]);

    // ── Realtime: nuovo messaggio in thread non attivo → aggiorna badge ──
    const handleRealtimeThreadUnread = useCallback((threadId: string, msg: ChatMessage) => {
        setThreads(prev => prev.map(t => {
            if (t.id !== threadId) return t;
            return {
                ...t,
                unread_count: t.unread_count + 1,
                last_message: {
                    content: msg.content,
                    sender_id: msg.sender_id,
                    created_at: msg.created_at,
                },
                last_message_at: msg.created_at,
            };
        }).sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()));
        setUnreadCount(prev => prev + 1);
    }, []);

    // Attiva il realtime
    useChatRealtime({
        userId: teacherId,
        selectedThreadId: selectedThread?.id ?? null,
        threads,
        onNewMessage: handleRealtimeNewMessage,
        onThreadUnread: handleRealtimeThreadUnread,
    });

    // ── Polling thread list per tenere i badge sincronizzati ─────────────
    useEffect(() => {
        const interval = setInterval(loadThreads, 15000);
        return () => clearInterval(interval);
    }, [loadThreads]);

    // Polling di backup ridotto (15s)
    useEffect(() => {
        if (!selectedThread) return;
        const interval = setInterval(() => loadMessages(selectedThread.id), 15000);
        return () => clearInterval(interval);
    }, [selectedThread, loadMessages]);

    // ── Mark as Read via IntersectionObserver ────────────────────────────
    const handleMarkRead = useCallback(async (ids: string[]) => {
        if (ids.length === 0) return;
        try {
            await fetch('/api/chat/messages/read', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messageIds: ids, userId: teacherId }),
            });
            // Aggiornamento ottimistico locale
            const now = new Date().toISOString();
            setMessages(prev => prev.map(m =>
                ids.includes(m.id) ? { ...m, read_at: now } : m
            ));
            if (selectedThreadRef.current) {
                setThreads(prev => prev.map(t =>
                    t.id === selectedThreadRef.current!.id
                        ? { ...t, unread_count: 0 }
                        : t
                ));
                setUnreadCount(prev => Math.max(0, prev - ids.length));
            }
        } catch (err) {
            console.error('Errore mark-as-read:', err);
        }
    }, [teacherId]);

    const handleSelectThread = (thread: ChatThread) => {
        setSelectedThread(thread);
        setShowMobile('chat');
        setMessages([]);
        setFirstUnreadId(null);
        loadMessages(thread.id);
        setThreads(prev => prev.map(t => t.id === thread.id ? { ...t, unread_count: 0 } : t));
        setUnreadCount(prev => {
            const threadUnread = threads.find(t => t.id === thread.id)?.unread_count ?? 0;
            return Math.max(0, prev - threadUnread);
        });
    };

    const handleNewChat = async (contact: Contact) => {
        try {
            const res = await fetch('/api/chat/threads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    teacher_id: teacherId,
                    parent_id: contact.user_id,
                    student_id: contact.student_id,
                }),
            });
            if (res.ok) {
                setShowNewChat(false);
                await loadThreads();
                const newThread = await res.json();
                const fresh = await fetch(`/api/chat/threads?userId=${teacherId}`);
                if (fresh.ok) {
                    const allThreads: ChatThread[] = await fresh.json();
                    setThreads(allThreads);
                    const found = allThreads.find(t => t.id === newThread.id);
                    if (found) handleSelectThread(found);
                }
            }
        } catch (err) {
            console.error('Errore creazione thread:', err);
        }
    };

    const handleSendMessage = async (content: string, attachmentUrl?: string, attachmentType?: string) => {
        if (!selectedThread) return;
        try {
            const res = await fetch('/api/chat/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    thread_id: selectedThread.id,
                    sender_id: teacherId,
                    content,
                    attachment_url: attachmentUrl,
                    attachment_type: attachmentType,
                }),
            });
            if (res.ok) {
                const newMsg = await res.json();
                setMessages(prev => [...prev, newMsg]);
                setFirstUnreadId(null); // inviato → separatore rimosso
                setThreads(prev => prev.map(t =>
                    t.id === selectedThread.id
                        ? { ...t, last_message: { content, sender_id: teacherId, created_at: newMsg.created_at }, last_message_at: newMsg.created_at }
                        : t
                ).sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()));
            }
        } catch (err) {
            console.error('Errore invio messaggio:', err);
        }
    };


    if (loading) {
        return (
            <div className="max-w-5xl mx-auto p-4 sm:p-6 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
                <p className="font-maven text-gray-500">Caricamento chat...</p>
            </div>
        );
    }

    return (
        <div className="max-w-5xl mx-auto p-4 sm:p-6">
            {/* Header */}
            <div className="flex items-start justify-between mb-4">
                <div>
                    <div className="flex items-center gap-3">
                        <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase tracking-wide">
                            💬 Chat
                        </h1>
                        <AnimatePresence>
                            {unreadCount > 0 && (
                                <motion.span
                                    initial={{ scale: 0, opacity: 0 }}
                                    animate={{ scale: 1, opacity: 1 }}
                                    exit={{ scale: 0, opacity: 0 }}
                                    transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                                    className="inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded-full bg-kidville-success text-white font-barlow font-bold text-xs shadow-lg shadow-sm"
                                >
                                    {unreadCount > 99 ? '99+' : unreadCount}
                                </motion.span>
                            )}
                        </AnimatePresence>
                    </div>
                    <p className="font-maven text-gray-500 mt-1">Messaggi con le famiglie</p>
                </div>
                <button
                    onClick={() => { setShowNewChat(true); loadContacts(); }}
                    className="flex items-center gap-2 px-4 py-2.5 bg-kidville-green text-kidville-yellow font-barlow font-bold text-sm uppercase rounded-2xl hover:opacity-90 active:scale-[0.98] transition-all shadow-lg shadow-kidville-green/20"
                >
                    <Plus size={16} strokeWidth={1.5} /> Nuova Chat
                </button>
            </div>

            {/* Desktop Layout: sidebar + chat area */}
            <div className="hidden md:flex gap-4 h-[calc(100vh-200px)] min-h-[500px]">
                {/* Thread list */}
                <div className="w-80 flex-shrink-0 bg-white/80 backdrop-blur-xl rounded-3xl border border-white/40 shadow-sm overflow-hidden flex flex-col">
                    <div className="px-4 py-3 border-b border-gray-100/60">
                        <p className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">Conversazioni</p>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                        <ChatThreadList threads={threads} selectedId={selectedThread?.id ?? null}
                            currentUserId={teacherId} onSelect={handleSelectThread} />
                    </div>
                </div>

                {/* Chat area */}
                <div className="flex-1 bg-white/80 backdrop-blur-xl rounded-3xl border border-white/40 shadow-sm overflow-hidden flex flex-col">
                    {selectedThread ? (
                        <>
                            <div className="flex items-center gap-3 px-5 py-3.5 border-b border-gray-100/60">
                                <div className="w-10 h-10 rounded-full bg-kidville-warn-soft flex items-center justify-center font-barlow font-bold text-sm text-kidville-warn">
                                    {selectedThread.other_user.first_name[0]}{selectedThread.other_user.last_name[0]}
                                </div>
                                <div>
                                    <p className="font-maven font-semibold text-sm text-kidville-green">
                                        {selectedThread.other_user.first_name} {selectedThread.other_user.last_name}
                                    </p>
                                    <p className="font-maven text-[11px] text-gray-400">
                                        Genitore di {selectedThread.student.nome} {selectedThread.student.cognome}
                                    </p>
                                </div>
                            </div>
                            <ChatMessageArea
                                messages={messages}
                                currentUserId={teacherId}
                                otherUserName={selectedThread.other_user.first_name}
                                loading={loadingMessages}
                                firstUnreadId={firstUnreadId}
                                onMarkRead={handleMarkRead}
                            />
                            <ChatInput onSend={handleSendMessage} />
                        </>
                    ) : (
                        <div className="flex-1 flex items-center justify-center">
                            <div className="text-center">
                                <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mx-auto mb-4">
                                    <MessageSquare size={32} className="text-kidville-green" strokeWidth={1.5} />
                                </div>
                                <p className="font-barlow font-bold text-lg text-kidville-green uppercase mb-1">
                                    Seleziona una conversazione
                                </p>
                                <p className="font-maven text-sm text-gray-400">
                                    Scegli un genitore dalla lista o premi &quot;Nuova Chat&quot;
                                </p>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Mobile Layout */}
            <div className="md:hidden">
                {showMobile === 'list' ? (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                        className="bg-white/80 backdrop-blur-xl rounded-3xl border border-white/40 shadow-sm overflow-hidden">
                        <ChatThreadList threads={threads} selectedId={null}
                            currentUserId={teacherId} onSelect={handleSelectThread} />
                    </motion.div>
                ) : selectedThread && (
                    <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
                        className="bg-white/80 backdrop-blur-xl rounded-3xl border border-white/40 shadow-sm overflow-hidden flex flex-col h-[calc(100vh-180px)]">
                        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100/60">
                            <button onClick={() => setShowMobile('list')}
                                className="w-8 h-8 rounded-xl bg-gray-50 hover:bg-gray-100 flex items-center justify-center text-gray-500 transition-colors">
                                <ArrowLeft size={16} strokeWidth={1.5} />
                            </button>
                            <div className="w-9 h-9 rounded-full bg-kidville-warn-soft flex items-center justify-center font-barlow font-bold text-xs text-kidville-warn">
                                {selectedThread.other_user.first_name[0]}{selectedThread.other_user.last_name[0]}
                            </div>
                            <div>
                                <p className="font-maven font-semibold text-sm text-kidville-green">
                                    {selectedThread.other_user.first_name} {selectedThread.other_user.last_name}
                                </p>
                                <p className="font-maven text-[10px] text-gray-400">{selectedThread.student.nome}</p>
                            </div>
                        </div>
                        <ChatMessageArea
                            messages={messages}
                            currentUserId={teacherId}
                            otherUserName={selectedThread.other_user.first_name}
                            loading={loadingMessages}
                            firstUnreadId={firstUnreadId}
                            onMarkRead={handleMarkRead}
                        />
                        <ChatInput onSend={handleSendMessage} />
                    </motion.div>
                )}
            </div>

            {/* Modal Nuova Chat */}
            <AnimatePresence>
                {showNewChat && (
                    <>
                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                            className="fixed inset-0 bg-kidville-green/30 backdrop-blur-sm z-50" onClick={() => setShowNewChat(false)} />
                        <motion.div
                            initial={{ opacity: 0, y: 30, scale: 0.97 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 20, scale: 0.97 }}
                            className="fixed inset-4 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-full sm:max-w-md bg-white rounded-3xl shadow-2xl z-50 flex flex-col max-h-[80vh] overflow-hidden"
                        >
                            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                                <div className="flex items-center gap-2">
                                    <UserPlus size={18} className="text-kidville-green" strokeWidth={1.5} />
                                    <h2 className="font-barlow font-black text-lg text-kidville-green uppercase tracking-wide">Nuova Chat</h2>
                                </div>
                                <button onClick={() => setShowNewChat(false)}
                                    className="w-8 h-8 rounded-xl bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-400">
                                    <X size={14} strokeWidth={1.5} />
                                </button>
                            </div>
                            <div className="flex-1 overflow-y-auto p-4">
                                {loadingContacts ? (
                                    <div className="flex flex-col items-center py-8 gap-3">
                                        <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                                        <p className="font-maven text-sm text-gray-400">Caricamento contatti...</p>
                                    </div>
                                ) : contacts.length === 0 ? (
                                    <div className="flex flex-col items-center py-8 text-center">
                                        <p className="font-maven text-sm text-gray-400">
                                            Hai già una conversazione con tutti i genitori disponibili! 🎉
                                        </p>
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        <p className="font-maven text-xs text-gray-400 mb-3">
                                            Seleziona un genitore per iniziare una conversazione
                                        </p>
                                        {contacts.map((contact, idx) => {
                                            const initials = contact.user_name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
                                            return (
                                                <motion.button
                                                    key={`${contact.user_id}-${contact.student_id}`}
                                                    initial={{ opacity: 0, y: 6 }}
                                                    animate={{ opacity: 1, y: 0 }}
                                                    transition={{ delay: idx * 0.04 }}
                                                    onClick={() => handleNewChat(contact)}
                                                    className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl bg-kidville-cream/30 hover:bg-kidville-cream/60 transition-all text-left"
                                                >
                                                    <div className="w-10 h-10 rounded-full bg-kidville-warn-soft flex items-center justify-center font-barlow font-bold text-sm text-kidville-warn">
                                                        {initials}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <p className="font-maven font-semibold text-sm text-kidville-green truncate">
                                                            {contact.user_name}
                                                        </p>
                                                        <p className="font-maven text-xs text-gray-400 truncate">
                                                            Genitore di {contact.student_name} • {contact.sezione}
                                                        </p>
                                                    </div>
                                                    <Plus size={16} className="text-kidville-green flex-shrink-0" strokeWidth={1.5} />
                                                </motion.button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </motion.div>
                    </>
                )}
            </AnimatePresence>
        </div>
    );
}

export default function TeacherChatPage() {
    return (
        <Suspense fallback={
            <div className="max-w-5xl mx-auto p-4 sm:p-6 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
            </div>
        }>
            <TeacherChatContent />
        </Suspense>
    );
}
