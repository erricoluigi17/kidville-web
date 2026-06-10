'use client';

import { useState, useEffect, useCallback, Suspense, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, MessageSquare, Plus, X, UserPlus } from 'lucide-react';
import { ChatThreadList, ChatThread } from '@/components/features/chat/ChatThreadList';
import { ChatMessageArea, ChatMessage } from '@/components/features/chat/ChatMessageArea';
import { ChatInput } from '@/components/features/chat/ChatInput';
import { useUnreadNotifications } from '@/components/features/chat/useUnreadNotifications';
import { useChatRealtime } from '@/components/features/chat/useChatRealtime';
import { useSearchParams } from 'next/navigation';

interface Contact {
    user_id: string;
    user_name: string;
    user_role: string;
    student_id: string;
    student_name: string;
    sezione: string;
}

function ParentChatContent() {
    const searchParams = useSearchParams();
    const parentId = searchParams.get('userId') || '33333333-3333-3333-3333-333333333333';

    const [threads, setThreads] = useState<ChatThread[]>([]);
    const [selectedThread, setSelectedThread] = useState<ChatThread | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMessages, setLoadingMessages] = useState(false);
    const [showMobile, setShowMobile] = useState<'list' | 'chat'>('list');
    const [showNewChat, setShowNewChat] = useState(false);
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [loadingContacts, setLoadingContacts] = useState(false);
    const [childrenNames, setChildrenNames] = useState<string[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [chatCfg, setChatCfg] = useState<{
        in_orario: boolean;
        orario_docenti_da: string;
        orario_docenti_a: string;
        risposta_fuori_orario_msg: string;
    } | null>(null);
    // ID del primo messaggio non letto: calcolato al caricamento del thread
    // e "bloccato" finché l'utente non invia un messaggio o cambia chat.
    const [firstUnreadId, setFirstUnreadId] = useState<string | null>(null);

    // Ref stabile per selectedThread (evita re-render nei callback realtime)
    const selectedThreadRef = useRef<ChatThread | null>(null);
    useEffect(() => { selectedThreadRef.current = selectedThread; }, [selectedThread]);

    // Notifiche non letti + badge titolo pagina (mantenuto come fallback)
    useUnreadNotifications({
        userId: parentId,
        enabled: true,
        onUnreadChange: setUnreadCount,
        pollInterval: 30000, // ridotto a 30s ora che c'è il realtime
    });

    const loadThreads = useCallback(async () => {
        try {
            const res = await fetch(`/api/chat/threads?userId=${parentId}`);
            if (res.ok) {
                const data: ChatThread[] = await res.json();
                setThreads(data);
                const names = [...new Set(data.map(t => t.student.nome))];
                if (names.length > 0) setChildrenNames(names);
            }
        } catch (err) {
            console.error('Errore caricamento thread:', err);
        } finally {
            setLoading(false);
        }
    }, [parentId]);

    useEffect(() => { loadThreads(); }, [loadThreads]);

    // Config chat (orari docenti, messaggio fuori orario) dalle impostazioni scuola.
    useEffect(() => {
        fetch('/api/chat/config')
            .then(r => r.json())
            .then(d => { if (d.success) setChatCfg(d.data); })
            .catch(() => {});
    }, []);

    const loadContacts = useCallback(async () => {
        setLoadingContacts(true);
        try {
            const res = await fetch(`/api/chat/contacts?userId=${parentId}`);
            if (res.ok) {
                const data = await res.json();
                setContacts(data.contacts ?? []);
                const names: string[] = [...new Set<string>((data.contacts ?? []).map((c: Contact) => c.student_name.split(' ')[0]))];
                if (names.length > 0) setChildrenNames(names);
            }
        } catch (err) {
            console.error('Errore caricamento contatti:', err);
        } finally {
            setLoadingContacts(false);
        }
    }, [parentId]);

    useEffect(() => { loadContacts(); }, [loadContacts]);

    const loadMessages = useCallback(async (threadId: string) => {
        setLoadingMessages(true);
        try {
            const res = await fetch(`/api/chat/messages?threadId=${threadId}`);
            if (res.ok) {
                const data = await res.json();
                const msgs: ChatMessage[] = data.messages ?? [];
                setMessages(msgs);
                // Blocca il separatore al primo messaggio non letto al momento
                // dell'apertura — non cambierà finché l'utente non invia o cambia chat
                const firstUnread = msgs.find(
                    m => m.sender_id !== parentId && m.read_at === null
                );
                setFirstUnreadId(firstUnread?.id ?? null);
            }
        } catch (err) {
            console.error('Errore caricamento messaggi:', err);
        } finally {
            setLoadingMessages(false);
        }
    }, [parentId]);

    // ── Realtime: nuovo messaggio nel thread attivo ──────────────────────
    const handleRealtimeNewMessage = useCallback((msg: ChatMessage) => {
        setMessages(prev => {
            // Evita duplicati (il polling potrebbe già averlo aggiunto)
            if (prev.some(m => m.id === msg.id)) return prev;
            return [...prev, msg];
        });
        // Il messaggio è già nel viewport → marcalo come letto immediatamente
        // (l'IntersectionObserver lo catturerà, ma lo mandiamo anche ora in background)
        fetch('/api/chat/messages/read', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageIds: [msg.id], userId: parentId }),
        }).catch(() => {/* silenzioso */});
    }, [parentId]);

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
        // Aggiorna anche il contatore globale nella intestazione
        setUnreadCount(prev => prev + 1);
    }, []);

    // Attiva il realtime solo quando i thread sono caricati
    useChatRealtime({
        userId: parentId,
        selectedThreadId: selectedThread?.id ?? null,
        threads,
        onNewMessage: handleRealtimeNewMessage,
        onThreadUnread: handleRealtimeThreadUnread,
    });

    // ── Polling thread list per tenere i badge sincronizzati ─────────────
    // Necessario perché loadThreads gira solo al mount; i nuovi messaggi
    // arrivano via realtime (useChatRealtime) ma se non è abilitato o
    // se si carica la pagina con messaggi già presenti, i badge scompaiono.
    useEffect(() => {
        const interval = setInterval(loadThreads, 15000);
        return () => clearInterval(interval);
    }, [loadThreads]);

    // ── Polling di backup sui messaggi (ridotto, solo fallback) ──────────
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
                body: JSON.stringify({ messageIds: ids, userId: parentId }),
            });
            // Aggiornamento ottimistico locale
            const now = new Date().toISOString();
            setMessages(prev => prev.map(m =>
                ids.includes(m.id) ? { ...m, read_at: now } : m
            ));
            // Azzera unread_count sul thread corrente
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
    }, [parentId]);

    const handleSelectThread = (thread: ChatThread) => {
        setSelectedThread(thread);
        setShowMobile('chat');
        setMessages([]);
        setFirstUnreadId(null); // reset prima del caricamento, sarà ri-calcolato
        loadMessages(thread.id);
        // Azzeramento ottimistico immediato del badge
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
                    teacher_id: contact.user_id,
                    parent_id: parentId,
                    student_id: contact.student_id,
                }),
            });
            if (res.ok) {
                setShowNewChat(false);
                const newThread = await res.json();
                await loadThreads();
                const fresh = await fetch(`/api/chat/threads?userId=${parentId}`);
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
                    sender_id: parentId,
                    content,
                    attachment_url: attachmentUrl,
                    attachment_type: attachmentType,
                }),
            });
            if (res.ok) {
                const newMsg = await res.json();
                setMessages(prev => [...prev, newMsg]);
                // L'utente ha inviato → il separatore non serve più
                setFirstUnreadId(null);
                setThreads(prev => prev.map(t =>
                    t.id === selectedThread.id
                        ? { ...t, last_message: { content, sender_id: parentId, created_at: newMsg.created_at }, last_message_at: newMsg.created_at }
                        : t
                ).sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()));
            }
        } catch (err) {
            console.error('Errore invio messaggio:', err);
        }
    };

    // Rimuovere il calcolo reattivo: firstUnreadId è ora uno stato
    // gestito da loadMessages e resettato da handleSendMessage/handleSelectThread

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
            <div className="flex items-start justify-between mb-4">
                <div>
                    <div className="flex items-center gap-3">
                        <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase tracking-wide">
                            💬 Messaggi
                        </h1>
                        <AnimatePresence>
                            {unreadCount > 0 && (
                                <motion.span
                                    initial={{ scale: 0, opacity: 0 }}
                                    animate={{ scale: 1, opacity: 1 }}
                                    exit={{ scale: 0, opacity: 0 }}
                                    transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                                    className="inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded-full bg-emerald-500 text-white font-barlow font-bold text-xs shadow-lg shadow-emerald-500/30"
                                >
                                    {unreadCount > 99 ? '99+' : unreadCount}
                                </motion.span>
                            )}
                        </AnimatePresence>
                    </div>
                    <p className="font-maven text-gray-500 mt-1">
                        Chatta con gli insegnanti{childrenNames.length > 0 ? ` di ${childrenNames.join(' e ')}` : ''}
                    </p>
                </div>
                <button
                    onClick={() => { setShowNewChat(true); loadContacts(); }}
                    className="flex items-center gap-2 px-4 py-2.5 bg-kidville-green text-kidville-yellow font-barlow font-bold text-sm uppercase rounded-2xl hover:opacity-90 active:scale-[0.98] transition-all shadow-lg shadow-kidville-green/20"
                >
                    <Plus size={16} strokeWidth={1.5} /> Nuova Chat
                </button>
            </div>

            {chatCfg && !chatCfg.in_orario && (
                <div className="mb-4 rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 font-maven text-sm text-amber-800">
                    {chatCfg.risposta_fuori_orario_msg || `I docenti rispondono dalle ${chatCfg.orario_docenti_da} alle ${chatCfg.orario_docenti_a} nei giorni scolastici.`}
                </div>
            )}

            {/* Desktop */}
            <div className="hidden md:flex gap-4 h-[calc(100vh-200px)] min-h-[500px]">
                <div className="w-80 flex-shrink-0 bg-white/80 backdrop-blur-xl rounded-3xl border border-white/40 shadow-sm overflow-hidden flex flex-col">
                    <div className="px-4 py-3 border-b border-gray-100/60">
                        <p className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">Insegnanti</p>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                        <ChatThreadList threads={threads} selectedId={selectedThread?.id ?? null}
                            currentUserId={parentId} onSelect={handleSelectThread} />
                    </div>
                </div>

                <div className="flex-1 bg-white/80 backdrop-blur-xl rounded-3xl border border-white/40 shadow-sm overflow-hidden flex flex-col">
                    {selectedThread ? (
                        <>
                            <div className="flex items-center gap-3 px-5 py-3.5 border-b border-gray-100/60">
                                <div className="w-10 h-10 rounded-full bg-kidville-green flex items-center justify-center font-barlow font-bold text-sm text-kidville-yellow">
                                    {selectedThread.other_user.first_name[0]}{selectedThread.other_user.last_name[0]}
                                </div>
                                <div>
                                    <p className="font-maven font-semibold text-sm text-kidville-green">
                                        {selectedThread.other_user.first_name} {selectedThread.other_user.last_name}
                                    </p>
                                    <p className="font-maven text-[11px] text-gray-400">
                                        Insegnante • {selectedThread.student.classe_sezione}
                                    </p>
                                </div>
                            </div>
                            <ChatMessageArea
                                messages={messages}
                                currentUserId={parentId}
                                otherUserName={selectedThread.other_user.first_name}
                                loading={loadingMessages}
                                firstUnreadId={firstUnreadId}
                                onMarkRead={handleMarkRead}
                            />
                            <ChatInput onSend={handleSendMessage} placeholder="Scrivi un messaggio all'insegnante..." />
                        </>
                    ) : (
                        <div className="flex-1 flex items-center justify-center">
                            <div className="text-center">
                                <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mx-auto mb-4">
                                    <MessageSquare size={32} className="text-kidville-green" strokeWidth={1.5} />
                                </div>
                                <p className="font-barlow font-bold text-lg text-kidville-green uppercase mb-1">Seleziona un insegnante</p>
                                <p className="font-maven text-sm text-gray-400">Scegli dalla lista o premi &quot;Nuova Chat&quot;</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Mobile */}
            <div className="md:hidden">
                {showMobile === 'list' ? (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                        className="bg-white/80 backdrop-blur-xl rounded-3xl border border-white/40 shadow-sm overflow-hidden">
                        <ChatThreadList threads={threads} selectedId={null}
                            currentUserId={parentId} onSelect={handleSelectThread} />
                    </motion.div>
                ) : selectedThread && (
                    <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
                        className="bg-white/80 backdrop-blur-xl rounded-3xl border border-white/40 shadow-sm overflow-hidden flex flex-col h-[calc(100vh-180px)]">
                        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100/60">
                            <button onClick={() => setShowMobile('list')}
                                className="w-8 h-8 rounded-xl bg-gray-50 hover:bg-gray-100 flex items-center justify-center text-gray-500 transition-colors">
                                <ArrowLeft size={16} strokeWidth={1.5} />
                            </button>
                            <div className="w-9 h-9 rounded-full bg-kidville-green flex items-center justify-center font-barlow font-bold text-xs text-kidville-yellow">
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
                            currentUserId={parentId}
                            otherUserName={selectedThread.other_user.first_name}
                            loading={loadingMessages}
                            firstUnreadId={firstUnreadId}
                            onMarkRead={handleMarkRead}
                        />
                        <ChatInput onSend={handleSendMessage} placeholder="Scrivi un messaggio..." />
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
                                            Hai già una conversazione con tutte le maestre disponibili! 🎉
                                        </p>
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        <p className="font-maven text-xs text-gray-400 mb-3">
                                            Seleziona un insegnante per iniziare una conversazione
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
                                                    <div className="w-10 h-10 rounded-full bg-kidville-green flex items-center justify-center font-barlow font-bold text-sm text-kidville-yellow">
                                                        {initials}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <p className="font-maven font-semibold text-sm text-kidville-green truncate">
                                                            {contact.user_name}
                                                        </p>
                                                        <p className="font-maven text-xs text-gray-400 truncate">
                                                            Insegnante di {contact.student_name} • {contact.sezione}
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

export default function ParentChatPage() {
    return (
        <Suspense fallback={
            <div className="max-w-5xl mx-auto p-4 sm:p-6 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
            </div>
        }>
            <ParentChatContent />
        </Suspense>
    );
}
