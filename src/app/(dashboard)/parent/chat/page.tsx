'use client';

import { useState, useEffect, useCallback, Suspense, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, MessageSquare, Plus, X, UserPlus } from 'lucide-react';
import { ChatThreadList, ChatThread } from '@/components/features/chat/ChatThreadList';
import { ChatMessageArea, ChatMessage } from '@/components/features/chat/ChatMessageArea';
import { ChatInput } from '@/components/features/chat/ChatInput';
import { ChatListSkeleton } from '@/components/features/chat/ChatListSkeleton';
import { useUnreadNotifications } from '@/components/features/chat/useUnreadNotifications';
import { useChatRealtime } from '@/components/features/chat/useChatRealtime';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { Btn } from '@/components/ui/Btn';

interface Contact {
    user_id: string;
    user_name: string;
    user_role: string;
    student_id: string;
    student_name: string;
    sezione: string;
}

// Identità dalla sessione (URL → localStorage → /api/me), senza fallback demo (M4).
function ParentChatContent() {
    const { userId: parentId, ready } = useSessionIdentity();

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
        userId: parentId ?? '', // il hook ignora gli id falsy

        enabled: true,
        onUnreadChange: setUnreadCount,
        pollInterval: 30000, // ridotto a 30s ora che c'è il realtime
    });

    const loadThreads = useCallback(async () => {
        if (!ready || !parentId) return; // in risoluzione o non autenticato (redirect dell'hook)
        try {
            const res = await fetch(`/api/chat/threads?userId=${parentId}`).catch(() => null);
            if (res?.ok) {
                const data: ChatThread[] = await res.json();
                setThreads(data);
                const names = [...new Set(data.map(t => t.student.nome))];
                if (names.length > 0) setChildrenNames(names);
            }
        } finally {
            setLoading(false);
        }
    }, [ready, parentId]);

    useEffect(() => { loadThreads(); }, [loadThreads]);

    // Config chat (orari docenti, messaggio fuori orario) dalle impostazioni scuola.
    useEffect(() => {
        fetch('/api/chat/config')
            .then(r => r.json())
            .then(d => { if (d.success) setChatCfg(d.data); })
            .catch(() => {});
    }, []);

    // NB: lo spinner contatti (loadingContacts) viene attivato dall'handler di
    // apertura modale, non qui: nessun setState sincrono nei loader da effect.
    const loadContacts = useCallback(async () => {
        if (!parentId) return;
        try {
            const res = await fetch(`/api/chat/contacts?userId=${parentId}`).catch(() => null);
            if (res?.ok) {
                const data = await res.json();
                setContacts(data.contacts ?? []);
                const names: string[] = [...new Set<string>((data.contacts ?? []).map((c: Contact) => c.student_name.split(' ')[0]))];
                if (names.length > 0) setChildrenNames(names);
            }
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
        userId: parentId ?? '', // il hook ignora gli id falsy

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
        if (!parentId) return;
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
        if (!selectedThread || !parentId) return;
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

    // Skeleton finché l'identità non è risolta e i thread non sono caricati.
    // `loading` viene azzerato da loadThreads appena l'identità è valida, quindi
    // niente skeleton infinito; con identità risolta-a-null l'hook reindirizza.
    if (!ready || loading || !parentId) {
        return <ChatListSkeleton />;
    }

    return (
        <div className="px-4 pt-5 pb-24">
            <PageHeaderCard
                eyebrow="Comunicazioni"
                title="Messaggi"
                className="mb-4"
                badge={
                    <AnimatePresence>
                        {unreadCount > 0 && (
                            <motion.span
                                initial={{ scale: 0, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0, opacity: 0 }}
                                transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                                className="inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded-full bg-kidville-yellow text-kidville-green font-barlow font-bold text-xs shadow-sm"
                            >
                                {unreadCount > 99 ? '99+' : unreadCount}
                            </motion.span>
                        )}
                    </AnimatePresence>
                }
                subtitle={<>Chatta con gli insegnanti{childrenNames.length > 0 ? ` di ${childrenNames.join(' e ')}` : ''}</>}
                action={
                    <Btn
                        variant="secondary"
                        size="sm"
                        onClick={() => { setShowNewChat(true); setLoadingContacts(true); loadContacts(); }}
                    >
                        <Plus size={16} strokeWidth={1.5} /> Nuova Chat
                    </Btn>
                }
            />

            {chatCfg && !chatCfg.in_orario && (
                <div className="mb-4 rounded-2xl bg-kidville-yellow-soft border border-kidville-yellow/40 px-4 py-3 font-maven text-sm text-kidville-yellow-dark">
                    {chatCfg.risposta_fuori_orario_msg || `I docenti rispondono dalle ${chatCfg.orario_docenti_da} alle ${chatCfg.orario_docenti_a} nei giorni scolastici.`}
                </div>
            )}

            {/* Desktop. mb-24 = clearance sotto il pannello: l'altezza fissa
                calc(100vh-200px) non tiene conto del banner fuori-orario, che
                spingeva il composer SOTTO la bottom nav fissa (irraggiungibile
                anche scrollando). Col margine lo scroll libera il composer;
                senza banner la resa iniziale è identica (spazio sotto la fold). */}
            <div className="hidden md:flex gap-4 h-[calc(100vh-200px-var(--kv-appbar-h,0px))] min-h-[500px] mb-24">
                <div className="w-80 flex-shrink-0 bg-white rounded-3xl border border-kidville-line shadow-sm overflow-hidden flex flex-col">
                    <div className="px-4 py-3 border-b border-kidville-line">
                        <p className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">Insegnanti</p>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                        <ChatThreadList threads={threads} selectedId={selectedThread?.id ?? null}
                            currentUserId={parentId} onSelect={handleSelectThread} />
                    </div>
                </div>

                <div className="flex-1 bg-white rounded-3xl border border-kidville-line shadow-sm overflow-hidden flex flex-col">
                    {selectedThread ? (
                        <>
                            <div className="flex items-center gap-3 px-5 py-3.5 border-b border-kidville-line">
                                <div className="w-10 h-10 rounded-full bg-kidville-green flex items-center justify-center font-barlow font-bold text-sm text-kidville-yellow">
                                    {selectedThread.other_user.first_name[0]}{selectedThread.other_user.last_name[0]}
                                </div>
                                <div>
                                    <p className="font-maven font-semibold text-sm text-kidville-green">
                                        {selectedThread.other_user.first_name} {selectedThread.other_user.last_name}
                                    </p>
                                    <p className="font-maven text-[11px] text-kidville-muted">
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
                                <p className="font-maven text-sm text-kidville-muted">Scegli dalla lista o premi &quot;Nuova Chat&quot;</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Mobile */}
            <div className="md:hidden">
                {showMobile === 'list' ? (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                        className="bg-white rounded-3xl border border-kidville-line shadow-sm overflow-hidden">
                        <ChatThreadList threads={threads} selectedId={null}
                            currentUserId={parentId} onSelect={handleSelectThread} />
                    </motion.div>
                ) : selectedThread && (
                    // Conversazione a schermo intero su mobile: si adatta a qualsiasi
                    // dispositivo (100dvh reale), il campo resta sempre visibile in fondo
                    // sopra la safe-area; si esce con il tasto indietro in alto.
                    <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
                        className="fixed inset-0 z-[60] bg-white flex flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]">
                        <div className="flex items-center gap-3 px-4 py-3 border-b border-kidville-line">
                            <button onClick={() => setShowMobile('list')}
                                className="w-8 h-8 rounded-xl bg-kidville-neutral-soft hover:bg-kidville-cream-dark flex items-center justify-center text-kidville-muted transition-colors">
                                <ArrowLeft size={16} strokeWidth={1.5} />
                            </button>
                            <div className="w-9 h-9 rounded-full bg-kidville-green flex items-center justify-center font-barlow font-bold text-xs text-kidville-yellow">
                                {selectedThread.other_user.first_name[0]}{selectedThread.other_user.last_name[0]}
                            </div>
                            <div>
                                <p className="font-maven font-semibold text-sm text-kidville-green">
                                    {selectedThread.other_user.first_name} {selectedThread.other_user.last_name}
                                </p>
                                <p className="font-maven text-[10px] text-kidville-muted">{selectedThread.student.nome}</p>
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
                            <div className="flex items-center justify-between px-6 py-4 border-b border-kidville-line">
                                <div className="flex items-center gap-2">
                                    <UserPlus size={18} className="text-kidville-green" strokeWidth={1.5} />
                                    <h2 className="font-barlow font-black text-lg text-kidville-green uppercase tracking-wide">Nuova Chat</h2>
                                </div>
                                <button onClick={() => setShowNewChat(false)}
                                    className="w-8 h-8 rounded-xl bg-kidville-neutral-soft hover:bg-kidville-cream-dark flex items-center justify-center text-kidville-muted">
                                    <X size={14} strokeWidth={1.5} />
                                </button>
                            </div>
                            <div className="flex-1 overflow-y-auto p-4">
                                {loadingContacts ? (
                                    <div className="flex flex-col items-center py-8 gap-3">
                                        <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                                        <p className="font-maven text-sm text-kidville-muted">Caricamento contatti...</p>
                                    </div>
                                ) : contacts.length === 0 ? (
                                    <div className="flex flex-col items-center py-8 text-center">
                                        <p className="font-maven text-sm text-kidville-muted">
                                            Hai già una conversazione con tutte le maestre disponibili! 🎉
                                        </p>
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        <p className="font-maven text-xs text-kidville-muted mb-3">
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
                                                        <p className="font-maven text-xs text-kidville-muted truncate">
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
            <div className="px-4 pt-5 pb-24 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
            </div>
        }>
            <ParentChatContent />
        </Suspense>
    );
}
